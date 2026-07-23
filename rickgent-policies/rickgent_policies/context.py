"""Filesystem-backed authentication for immutable Rickgent attempt contexts.

The policy event is deliberately absent from this module's inputs.  Identity
comes only from the orchestrator-pinned spawn projection, the seven-string
FunctionPolicy config, and private files beneath the trusted state root.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect
import json
import os
import re
import stat
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from .policy_event import (
    CONTEXT_SCHEMA_VERSION,
    IDENTITY_NORMALIZATION_VERSION,
    POLICY_ABI_VERSION,
    RUNTIME_PROVENANCE_SCHEMA_VERSION,
    TICKET_CONTRACT_SCHEMA_VERSION,
    AuthenticatedAttemptContext,
    DenialKind,
    PolicyDenial,
    RequestedModelIdentity,
    RuntimeProvenance,
    TicketScopeEntry,
    make_policy_denial,
    normalize_harness_identity,
)

MAX_EXECUTION_CONTEXT_BYTES = 1_048_576
ATTEMPT_LEASE_SCHEMA_VERSION = "rickgent-attempt-lease/v1"
NONCE_CLAIM_SCHEMA_VERSION = "rickgent-attempt-nonce-claim/v1"

TRUSTED_SPAWN_ENVIRONMENT_KEYS = frozenset(
    {
        "RICKGENT_STATE_ROOT",
        "RICKGENT_POLICY_ROOT",
        "RICKGENT_CONTEXT_PATH",
        "RICKGENT_CONTEXT_SHA256",
        "RICKGENT_CONTEXT_OWNER_TOKEN",
        "RICKGENT_CONTEXT_OWNER_TOKEN_SHA256",
        "RICKGENT_NONCE_CLAIM_PATH",
        "RICKGENT_LEASE_PATH",
        "RICKGENT_RECEIPT_PATH",
        "RICKGENT_DISPATCH_ID",
        "RICKGENT_RUN_ID",
        "RICKGENT_TICKET_ID",
        "RICKGENT_ATTEMPT",
        "RICKGENT_LIFECYCLE_PHASE",
        "RICKGENT_ROLE",
        "RICKGENT_CALLER_REPO_REALPATH",
        "RICKGENT_WORKTREE_REALPATH",
        "RICKGENT_BUNDLE_ROOT_REALPATH",
        "RICKGENT_REQUESTED_BUNDLE_SHA256",
        "RICKGENT_REQUESTED_CONFIG_SHA256",
        "RICKGENT_INVOKED_BUNDLE_SHA256",
        "RICKGENT_INVOKED_CONFIG_SHA256",
        "RICKGENT_OMNIGENT_PYTHON_ENTRYPOINT",
        "RICKGENT_OMNIGENT_PYTHON_REALPATH",
        "RICKGENT_OMNIGENT_PYTHON_SHA256",
        "RICKGENT_OMNIGENT_ROOT_REALPATH",
        "RICKGENT_OMNIGENT_ORIGIN_REALPATH",
        "RICKGENT_POLICIES_ORIGIN_REALPATH",
        "RICKGENT_POLICIES_SHA256",
        "RICKGENT_NODE_REALPATH",
        "RICKGENT_NODE_SHA256",
        "RICKGENT_CLI_REALPATH",
        "RICKGENT_CLI_SHA256",
        "RICKGENT_BUILD_COMMIT",
    }
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TICKET_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_RUNTIME_DIGEST_CACHE: dict[str, tuple[tuple[int, int, int, int, int], str]] = {}
_CONTEXT_KEYS = frozenset(
    {
        "schema_version",
        "policy_abi_version",
        "ticket_contract_schema_version",
        "identity_normalization_version",
        "dispatch_id",
        "run_id",
        "ticket_id",
        "attempt",
        "lifecycle_phase",
        "role",
        "target_repo_realpath",
        "worktree_realpath",
        "state_root_realpath",
        "policy_root_realpath",
        "bundle_root_realpath",
        "ticket_contract_digest",
        "declared_scope",
        "requested_identity",
        "runtime_provenance",
        "requested_bundle_sha256",
        "requested_config_sha256",
        "attempt_digest",
        "owner_token_sha256",
        "nonce",
        "nonce_claim_path",
        "lease_path",
        "receipt_path",
    }
)
_RUNTIME_PROVENANCE_KEYS = frozenset(
    {
        "schema_version",
        "omnigent_python_entrypoint",
        "omnigent_python_realpath",
        "omnigent_python_sha256",
        "omnigent_root_realpath",
        "omnigent_origin_realpath",
        "rickgent_policies_origin_realpath",
        "rickgent_policies_sha256",
        "rickgent_node_realpath",
        "rickgent_node_sha256",
        "rickgent_cli_realpath",
        "rickgent_cli_sha256",
        "rickgent_build_commit",
    }
)
_ATTEMPT_DIGEST_EXCLUDED_KEYS = frozenset(
    {
        "attempt_digest",
        "owner_token_sha256",
        "nonce",
        "nonce_claim_path",
        "lease_path",
        "receipt_path",
    }
)
_IDENTITY_KEYS = frozenset(
    {
        "normalization_version",
        "raw_harness",
        "canonical_harness",
        "raw_provider",
        "canonical_provider",
        "raw_vendor",
        "canonical_vendor",
        "raw_model_id",
        "canonical_model_id",
        "bundle_digest",
        "config_digest",
        "profile",
        "profile_available",
        "conflict",
    }
)
_SCOPE_REQUIRED_KEYS = frozenset({"path", "change_kind", "directory"})
_SCOPE_ALLOWED_KEYS = _SCOPE_REQUIRED_KEYS | {"from_path"}
_LEASE_KEYS = frozenset(
    {
        "schema_version",
        "dispatch_id",
        "run_id",
        "ticket_id",
        "attempt",
        "lifecycle_phase",
        "role",
        "context_sha256",
        "owner_token_sha256",
        "nonce",
        "nonce_claim_path",
        "expires_at_ms",
        "status",
        "closed_at_ms",
    }
)
_NONCE_KEYS = frozenset(
    {
        "schema_version",
        "dispatch_id",
        "run_id",
        "ticket_id",
        "attempt",
        "lifecycle_phase",
        "role",
        "context_sha256",
        "owner_token_sha256",
        "nonce",
    }
)


class _AuthenticationError(Exception):
    def __init__(self, kind: DenialKind, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _deny(kind: DenialKind, detail: str) -> NoReturn:
    raise _AuthenticationError(kind, detail)


def _sha256(value: bytes | str) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and _SHA256_RE.fullmatch(value) is not None


def _exact_mapping(value: object, keys: frozenset[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} is not a closed object")
    return value


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _load_json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON value {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} is not strict JSON: {error}")
    if not isinstance(value, dict):
        _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} must be a JSON object")
    return value


def _canonical_json(value: object) -> str:
    if value is None or type(value) is bool or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) is int:
        if abs(value) > 9_007_199_254_740_991:
            _deny(DenialKind.AUTHENTICATION_FAILED, "context contains a non-safe integer")
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            _deny(DenialKind.AUTHENTICATION_FAILED, "context contains a non-string key")
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{_canonical_json(value[key])}"
            for key in sorted(value)
        ) + "}"
    _deny(DenialKind.AUTHENTICATION_FAILED, "context contains a non-canonical JSON value")


def _path_inside(parent: str, candidate: str) -> bool:
    try:
        return os.path.commonpath((parent, candidate)) == parent
    except ValueError:
        return False


def _canonical_absolute(path: object, label: str, *, must_exist: bool = True) -> str:
    if not isinstance(path, str) or not path or not os.path.isabs(path):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not absolute")
    if os.path.normpath(path) != path or os.path.realpath(path) != path:
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not canonical")
    if must_exist and not os.path.exists(path):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is unavailable")
    return path


def _normalized_executable_entrypoint(path: object, label: str) -> str:
    """Validate an exact invocation path without erasing virtualenv semantics."""

    if not isinstance(path, str) or not path or not os.path.isabs(path):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not absolute")
    if os.path.normpath(path) != path:
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not normalized")
    if not os.path.exists(path) or not os.access(path, os.X_OK):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is unavailable")
    return path


def _read_private_file(
    path: str,
    *,
    state_root: str,
    label: str,
    maximum_bytes: int,
) -> bytes:
    """Open every component without following links and read one stable file."""

    _canonical_absolute(path, label)
    if not _path_inside(state_root, path):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} escapes the trusted state root")

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | nofollow
    file_flags = os.O_RDONLY | nofollow
    parts = Path(path).parts
    descriptor = os.open(os.path.sep, directory_flags)
    cursor = os.path.sep
    try:
        for component in parts[1:-1]:
            next_descriptor = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
            cursor = os.path.join(cursor, component)
            info = os.fstat(descriptor)
            if not stat.S_ISDIR(info.st_mode):
                _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} has a non-directory ancestor")
            if _path_inside(state_root, cursor):
                if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                    _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} has an unsafe private directory")

        file_descriptor = os.open(parts[-1], file_flags, dir_fd=descriptor)
        try:
            before = os.fstat(file_descriptor)
            if not stat.S_ISREG(before.st_mode):
                _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not a regular file")
            if before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o600:
                _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} owner or mode is unsafe")
            if before.st_size < 0 or before.st_size > maximum_bytes:
                _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} exceeds its size limit")
            chunks: list[bytes] = []
            remaining = maximum_bytes + 1
            while remaining > 0:
                chunk = os.read(file_descriptor, min(65_536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw = b"".join(chunks)
            after = os.fstat(file_descriptor)
            if len(raw) > maximum_bytes or (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            ) != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            ):
                _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} changed while it was read")
            return raw
        finally:
            os.close(file_descriptor)
    except _AuthenticationError:
        raise
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} could not be opened securely")
    finally:
        os.close(descriptor)


def _stable_regular_file_bytes(path: str, label: str) -> bytes:
    """Read one canonical public runtime artifact without following a link."""

    canonical = _canonical_absolute(path, label)
    descriptor = os.open(canonical, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not a regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 65_536)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} changed while it was read")
        return b"".join(chunks)
    except _AuthenticationError:
        raise
    except (FileNotFoundError, PermissionError, OSError):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} could not be opened securely")
    finally:
        os.close(descriptor)


def _stable_regular_file_sha256(path: str, label: str) -> str:
    """Authenticate a runtime artifact, reusing a digest only while its inode is unchanged."""

    canonical = _canonical_absolute(path, label)
    descriptor = os.open(canonical, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} is not a regular file")
        fingerprint = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        cached = _RUNTIME_DIGEST_CACHE.get(canonical)
        if cached is not None and cached[0] == fingerprint:
            return cached[1]
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 65_536)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        observed = (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if observed != fingerprint:
            _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} changed while it was read")
        value = digest.hexdigest()
        _RUNTIME_DIGEST_CACHE[canonical] = (fingerprint, value)
        return value
    except _AuthenticationError:
        raise
    except (FileNotFoundError, PermissionError, OSError):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"{label} could not be opened securely")
    finally:
        os.close(descriptor)


def _policy_package_sha256(origin_value: str) -> str:
    origin = _canonical_absolute(origin_value, "Rickgent policies origin")
    origin_path = Path(origin)
    package_root = origin_path.parent
    if origin_path.name != "__init__.py" or package_root.name != "rickgent_policies":
        _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent policies origin is not the package __init__.py")
    records: list[str] = []
    for directory, names, files in os.walk(package_root, followlinks=False):
        directory_path = Path(directory)
        for name in tuple(names):
            child = directory_path / name
            if child.is_symlink():
                _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent policy package contains a symlink")
        names[:] = sorted(name for name in names if name != "__pycache__")
        for name in sorted(files):
            source = directory_path / name
            if source.is_symlink():
                _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent policy package contains a symlink")
            if source.suffix != ".py":
                continue
            raw = _stable_regular_file_bytes(str(source.resolve(strict=True)), "Rickgent policy source")
            relative = source.relative_to(package_root).as_posix()
            records.append(f"f\0{relative}\0{len(raw)}\0{_sha256(raw)}\n")
    if not records:
        _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent policy package contains no Python source")
    return _sha256("rickgent-policies-source-v1\n" + "".join(sorted(records)))


@dataclass(frozen=True)
class TrustedSpawnBindings:
    state_root: str
    policy_root: str
    context_path: str
    context_sha256: str
    owner_token: str
    owner_token_sha256: str
    nonce_claim_path: str
    lease_path: str
    receipt_path: str
    dispatch_id: str
    run_id: str
    ticket_id: str
    attempt: int
    lifecycle_phase: str
    role: str
    target_repo_realpath: str
    worktree_realpath: str
    bundle_root_realpath: str
    requested_bundle_sha256: str
    requested_config_sha256: str
    invoked_bundle_sha256: str
    invoked_config_sha256: str
    omnigent_python_entrypoint: str
    omnigent_python_realpath: str
    omnigent_python_sha256: str
    omnigent_root_realpath: str
    omnigent_origin_realpath: str
    rickgent_policies_origin_realpath: str
    rickgent_policies_sha256: str
    rickgent_node_realpath: str
    rickgent_node_sha256: str
    rickgent_cli_realpath: str
    rickgent_cli_sha256: str
    rickgent_build_commit: str

    @classmethod
    def from_environment(cls, environment: Mapping[str, str]) -> "TrustedSpawnBindings":
        missing = sorted(
            key for key in TRUSTED_SPAWN_ENVIRONMENT_KEYS
            if not isinstance(environment.get(key), str) or not environment.get(key)
        )
        if missing:
            _deny(
                DenialKind.CONTEXT_REFERENCE_UNTRUSTED,
                f"trusted spawn binding {missing[0]!r} is missing",
            )
        values = {key: environment[key] for key in TRUSTED_SPAWN_ENVIRONMENT_KEYS}
        attempt_text = values["RICKGENT_ATTEMPT"]
        if not attempt_text.isascii() or not attempt_text.isdigit() or attempt_text.startswith("0"):
            _deny(DenialKind.AUTHENTICATION_FAILED, "trusted spawn attempt is malformed")
        attempt = int(attempt_text)
        if attempt < 1 or attempt > 9_007_199_254_740_991:
            _deny(DenialKind.AUTHENTICATION_FAILED, "trusted spawn attempt is out of range")
        return cls(
            state_root=values["RICKGENT_STATE_ROOT"],
            policy_root=values["RICKGENT_POLICY_ROOT"],
            context_path=values["RICKGENT_CONTEXT_PATH"],
            context_sha256=values["RICKGENT_CONTEXT_SHA256"],
            owner_token=values["RICKGENT_CONTEXT_OWNER_TOKEN"],
            owner_token_sha256=values["RICKGENT_CONTEXT_OWNER_TOKEN_SHA256"],
            nonce_claim_path=values["RICKGENT_NONCE_CLAIM_PATH"],
            lease_path=values["RICKGENT_LEASE_PATH"],
            receipt_path=values["RICKGENT_RECEIPT_PATH"],
            dispatch_id=values["RICKGENT_DISPATCH_ID"],
            run_id=values["RICKGENT_RUN_ID"],
            ticket_id=values["RICKGENT_TICKET_ID"],
            attempt=attempt,
            lifecycle_phase=values["RICKGENT_LIFECYCLE_PHASE"],
            role=values["RICKGENT_ROLE"],
            target_repo_realpath=values["RICKGENT_CALLER_REPO_REALPATH"],
            worktree_realpath=values["RICKGENT_WORKTREE_REALPATH"],
            bundle_root_realpath=values["RICKGENT_BUNDLE_ROOT_REALPATH"],
            requested_bundle_sha256=values["RICKGENT_REQUESTED_BUNDLE_SHA256"],
            requested_config_sha256=values["RICKGENT_REQUESTED_CONFIG_SHA256"],
            invoked_bundle_sha256=values["RICKGENT_INVOKED_BUNDLE_SHA256"],
            invoked_config_sha256=values["RICKGENT_INVOKED_CONFIG_SHA256"],
            omnigent_python_entrypoint=values["RICKGENT_OMNIGENT_PYTHON_ENTRYPOINT"],
            omnigent_python_realpath=values["RICKGENT_OMNIGENT_PYTHON_REALPATH"],
            omnigent_python_sha256=values["RICKGENT_OMNIGENT_PYTHON_SHA256"],
            omnigent_root_realpath=values["RICKGENT_OMNIGENT_ROOT_REALPATH"],
            omnigent_origin_realpath=values["RICKGENT_OMNIGENT_ORIGIN_REALPATH"],
            rickgent_policies_origin_realpath=values["RICKGENT_POLICIES_ORIGIN_REALPATH"],
            rickgent_policies_sha256=values["RICKGENT_POLICIES_SHA256"],
            rickgent_node_realpath=values["RICKGENT_NODE_REALPATH"],
            rickgent_node_sha256=values["RICKGENT_NODE_SHA256"],
            rickgent_cli_realpath=values["RICKGENT_CLI_REALPATH"],
            rickgent_cli_sha256=values["RICKGENT_CLI_SHA256"],
            rickgent_build_commit=values["RICKGENT_BUILD_COMMIT"],
        )


def _verify_runtime_bindings(bindings: TrustedSpawnBindings) -> RuntimeProvenance:
    python_entrypoint = _normalized_executable_entrypoint(
        bindings.omnigent_python_entrypoint, "Omnigent Python entrypoint"
    )
    python = _canonical_absolute(bindings.omnigent_python_realpath, "Omnigent Python interpreter")
    root = _canonical_absolute(bindings.omnigent_root_realpath, "Omnigent root")
    omnigent_origin = _canonical_absolute(bindings.omnigent_origin_realpath, "Omnigent origin")
    policy_origin = _canonical_absolute(bindings.rickgent_policies_origin_realpath, "Rickgent policies origin")
    node = _canonical_absolute(bindings.rickgent_node_realpath, "Rickgent Node interpreter")
    cli = _canonical_absolute(bindings.rickgent_cli_realpath, "Rickgent CLI")
    if os.path.realpath(python_entrypoint) != python:
        _deny(DenialKind.AUTHENTICATION_FAILED, "Python entrypoint target conflicts with runtime provenance")
    if os.path.normpath(sys.executable) != python_entrypoint:
        _deny(DenialKind.AUTHENTICATION_FAILED, "active Python entrypoint conflicts with runtime provenance")
    if os.path.realpath(sys.executable) != python:
        _deny(DenialKind.AUTHENTICATION_FAILED, "active Python interpreter conflicts with runtime provenance")
    if not _path_inside(root, omnigent_origin):
        _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, "Omnigent origin escapes its authenticated root")
    if any(
        not _is_sha256(digest)
        for digest in (
            bindings.omnigent_python_sha256,
            bindings.rickgent_policies_sha256,
            bindings.rickgent_node_sha256,
            bindings.rickgent_cli_sha256,
        )
    ):
        _deny(DenialKind.AUTHENTICATION_FAILED, "runtime provenance digest is malformed")
    if (
        not bindings.rickgent_build_commit
        or bindings.rickgent_build_commit != bindings.rickgent_build_commit.strip()
        or any(character.isspace() for character in bindings.rickgent_build_commit)
    ):
        _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent build commit is malformed")

    omnigent = importlib.import_module("omnigent")
    policies = importlib.import_module("rickgent_policies")
    observed_omnigent = os.path.realpath(inspect.getfile(omnigent))
    observed_policies = os.path.realpath(inspect.getfile(policies))
    if observed_omnigent != omnigent_origin:
        _deny(DenialKind.AUTHENTICATION_FAILED, "active Omnigent origin conflicts with runtime provenance")
    if observed_policies != policy_origin:
        _deny(DenialKind.AUTHENTICATION_FAILED, "active Rickgent policy origin conflicts with runtime provenance")
    if _policy_package_sha256(policy_origin) != bindings.rickgent_policies_sha256:
        _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent policy package digest changed")
    if _stable_regular_file_sha256(python, "Omnigent Python interpreter") != bindings.omnigent_python_sha256:
        _deny(DenialKind.AUTHENTICATION_FAILED, "Omnigent Python interpreter digest changed")
    if _stable_regular_file_sha256(node, "Rickgent Node interpreter") != bindings.rickgent_node_sha256:
        _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent Node interpreter digest changed")
    if _stable_regular_file_sha256(cli, "Rickgent CLI") != bindings.rickgent_cli_sha256:
        _deny(DenialKind.AUTHENTICATION_FAILED, "Rickgent CLI digest changed")
    return RuntimeProvenance(
        schema_version=RUNTIME_PROVENANCE_SCHEMA_VERSION,
        omnigent_python_entrypoint=python_entrypoint,
        omnigent_python_realpath=python,
        omnigent_python_sha256=bindings.omnigent_python_sha256,
        omnigent_root_realpath=root,
        omnigent_origin_realpath=omnigent_origin,
        rickgent_policies_origin_realpath=policy_origin,
        rickgent_policies_sha256=bindings.rickgent_policies_sha256,
        rickgent_node_realpath=node,
        rickgent_node_sha256=bindings.rickgent_node_sha256,
        rickgent_cli_realpath=cli,
        rickgent_cli_sha256=bindings.rickgent_cli_sha256,
        rickgent_build_commit=bindings.rickgent_build_commit,
    )


def verify_runtime_provenance_environment(
    environment: Mapping[str, str] | None = None,
) -> RuntimeProvenance:
    """Fail closed unless the active process is the exact bound runtime."""

    bindings = TrustedSpawnBindings.from_environment(
        os.environ if environment is None else environment
    )
    return _verify_runtime_bindings(bindings)


class FilesystemContextAuthenticator:
    """Authenticate the M2 context and active lease on every policy event."""

    def __init__(self, bindings: TrustedSpawnBindings | Mapping[str, str]) -> None:
        self._initialization_denial: PolicyDenial | None = None
        self._bindings: TrustedSpawnBindings | None = None
        try:
            self._bindings = (
                bindings
                if isinstance(bindings, TrustedSpawnBindings)
                else TrustedSpawnBindings.from_environment(bindings)
            )
        except _AuthenticationError as error:
            self._bindings = None
            self._initialization_denial = make_policy_denial(error.kind, error.detail)

    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None
    ) -> "FilesystemContextAuthenticator":
        return cls(os.environ if environment is None else environment)

    def authenticate(
        self, config: Mapping[str, str]
    ) -> AuthenticatedAttemptContext | PolicyDenial:
        if self._initialization_denial is not None:
            return self._initialization_denial
        assert self._bindings is not None
        try:
            return self._authenticate(config, self._bindings)
        except _AuthenticationError as error:
            return make_policy_denial(error.kind, error.detail)
        except Exception:
            return make_policy_denial(
                DenialKind.AUTHENTICATION_FAILED,
                "attempt context authentication failed safely",
            )

    def _authenticate(
        self,
        config: Mapping[str, str],
        bindings: TrustedSpawnBindings,
    ) -> AuthenticatedAttemptContext:
        state_root = _canonical_absolute(bindings.state_root, "trusted state root")
        policy_root = _canonical_absolute(bindings.policy_root, "trusted policy root")
        target_repo = _canonical_absolute(bindings.target_repo_realpath, "target repository")
        worktree = _canonical_absolute(bindings.worktree_realpath, "target worktree")
        bundle_root = _canonical_absolute(bindings.bundle_root_realpath, "worker bundle")
        if not _path_inside(state_root, policy_root) or not _path_inside(policy_root, bundle_root):
            _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, "policy or bundle root escapes trusted state")
        if _path_inside(worktree, state_root) or _path_inside(worktree, bundle_root):
            _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, "trusted policy state overlaps the target worktree")
        runtime = _verify_runtime_bindings(bindings)

        dispatch_id = _dispatch_id(
            bindings.run_id,
            bindings.ticket_id,
            bindings.lifecycle_phase,
            bindings.attempt,
            bindings.role,
        )
        if dispatch_id != bindings.dispatch_id:
            _deny(DenialKind.DISPATCH_REPLAY, "trusted spawn tuple does not reconstruct dispatch id")
        expected_policy_root = os.path.join(
            state_root, "policy-attempts", _sha256(dispatch_id)
        )
        if policy_root != expected_policy_root:
            _deny(DenialKind.DISPATCH_REPLAY, "trusted policy root belongs to another attempt")
        expected_bundle_root = os.path.join(
            policy_root, "bundle", "agents", "rickgent", "agents", "worker"
        )
        if bundle_root != expected_bundle_root:
            _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, "worker bundle has an unexpected location")

        for digest, label in (
            (bindings.context_sha256, "context digest"),
            (bindings.owner_token_sha256, "owner-token digest"),
            (bindings.requested_bundle_sha256, "requested bundle digest"),
            (bindings.requested_config_sha256, "requested config digest"),
            (bindings.invoked_bundle_sha256, "invoked bundle digest"),
            (bindings.invoked_config_sha256, "invoked config digest"),
        ):
            if not _is_sha256(digest):
                _deny(DenialKind.AUTHENTICATION_FAILED, f"trusted {label} is malformed")
        if _sha256(bindings.owner_token) != bindings.owner_token_sha256:
            _deny(DenialKind.OWNER_TOKEN_MISMATCH, "raw attempt owner token has the wrong digest")

        expected_paths = {
            "context_path": os.path.join(policy_root, "context.json"),
            "lease_path": os.path.join(policy_root, "lease.json"),
            "receipt_path": os.path.join(policy_root, "receipt.jsonl"),
        }
        bound_paths = {
            "context_path": bindings.context_path,
            "lease_path": bindings.lease_path,
            "receipt_path": bindings.receipt_path,
        }
        for key, expected in expected_paths.items():
            actual = bound_paths[key]
            if actual != expected or config.get(key) != actual:
                _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, f"trusted {key} binding conflicts")
        if config.get("dispatch_id") != dispatch_id:
            _deny(DenialKind.DISPATCH_REPLAY, "policy config conflicts with trusted dispatch binding")
        if config.get("context_sha256") != bindings.context_sha256:
            _deny(DenialKind.CONTEXT_DIGEST_MISMATCH, "policy config conflicts with trusted context digest")
        if config.get("context_owner_token_sha256") != bindings.owner_token_sha256:
            _deny(DenialKind.OWNER_TOKEN_MISMATCH, "policy config has the wrong owner-token digest")
        if config.get("rickgent_policy_abi") != POLICY_ABI_VERSION:
            _deny(DenialKind.CONTEXT_ABI_UNSUPPORTED, "policy config ABI is unsupported")

        context_raw = _read_private_file(
            bindings.context_path,
            state_root=state_root,
            label="attempt context",
            maximum_bytes=MAX_EXECUTION_CONTEXT_BYTES,
        )
        observed_context_sha = _sha256(context_raw)
        if observed_context_sha != bindings.context_sha256:
            _deny(DenialKind.CONTEXT_DIGEST_MISMATCH, "attempt context digest does not match spawn binding")
        context = _exact_mapping(_load_json(context_raw, "attempt context"), _CONTEXT_KEYS, "attempt context")
        if context_raw != _canonical_json(context).encode("utf-8"):
            _deny(DenialKind.AUTHENTICATION_FAILED, "attempt context is not canonical JSON")

        if (
            context["schema_version"] != CONTEXT_SCHEMA_VERSION
            or context["policy_abi_version"] != POLICY_ABI_VERSION
            or context["ticket_contract_schema_version"] != TICKET_CONTRACT_SCHEMA_VERSION
            or context["identity_normalization_version"] != IDENTITY_NORMALIZATION_VERSION
        ):
            _deny(DenialKind.CONTEXT_ABI_UNSUPPORTED, "attempt context uses an unsupported schema")
        _validate_context_scalars(context)
        context_runtime = _runtime_provenance(context["runtime_provenance"])
        if context_runtime != runtime:
            _deny(DenialKind.AUTHENTICATION_FAILED, "attempt runtime provenance conflicts with trusted spawn binding")
        if context["dispatch_id"] != dispatch_id:
            _deny(DenialKind.DISPATCH_REPLAY, "attempt context belongs to another dispatch")
        expected_context_values = {
            "run_id": bindings.run_id,
            "ticket_id": bindings.ticket_id,
            "attempt": bindings.attempt,
            "lifecycle_phase": bindings.lifecycle_phase,
            "role": bindings.role,
            "target_repo_realpath": target_repo,
            "worktree_realpath": worktree,
            "state_root_realpath": state_root,
            "policy_root_realpath": policy_root,
            "bundle_root_realpath": bundle_root,
            "owner_token_sha256": bindings.owner_token_sha256,
            "nonce_claim_path": bindings.nonce_claim_path,
            "lease_path": bindings.lease_path,
            "receipt_path": bindings.receipt_path,
            "requested_bundle_sha256": bindings.requested_bundle_sha256,
            "requested_config_sha256": bindings.requested_config_sha256,
        }
        for key, expected in expected_context_values.items():  # type: ignore[assignment]
            if context[key] != expected:
                kind = (
                    DenialKind.OWNER_TOKEN_MISMATCH
                    if key == "owner_token_sha256"
                    else DenialKind.AUTHENTICATION_FAILED
                )
                _deny(kind, f"attempt context {key} conflicts with trusted spawn binding")

        for key in (
            "target_repo_realpath",
            "worktree_realpath",
            "state_root_realpath",
            "policy_root_realpath",
            "bundle_root_realpath",
            "nonce_claim_path",
            "lease_path",
            "receipt_path",
        ):
            _canonical_absolute(context[key], f"context {key}")
        if not _TICKET_DIGEST_RE.fullmatch(context["ticket_contract_digest"]):
            _deny(DenialKind.AUTHENTICATION_FAILED, "TicketContract digest is malformed")
        if not _is_sha256(context["attempt_digest"]):
            _deny(DenialKind.AUTHENTICATION_FAILED, "attempt digest is malformed")
        digest_payload = {
            key: value for key, value in context.items()
            if key not in _ATTEMPT_DIGEST_EXCLUDED_KEYS
        }
        if _sha256(_canonical_json(digest_payload)) != context["attempt_digest"]:
            _deny(DenialKind.AUTHENTICATION_FAILED, "attempt digest does not match context authority")

        scope = _scope(context["declared_scope"])
        identity = _requested_identity(context["requested_identity"])
        if (
            identity.bundle_digest != bindings.requested_bundle_sha256
            or identity.config_digest != bindings.requested_config_sha256
        ):
            _deny(DenialKind.AUTHENTICATION_FAILED, "requested identity digests conflict with spawn binding")

        nonce_claim_path = _canonical_absolute(
            bindings.nonce_claim_path, "attempt nonce claim"
        )
        expected_nonce_root = os.path.join(state_root, "policy-nonce-claims")
        if not _path_inside(expected_nonce_root, nonce_claim_path):
            _deny(DenialKind.CONTEXT_REFERENCE_UNTRUSTED, "nonce claim escapes its trusted root")
        if nonce_claim_path != os.path.join(expected_nonce_root, f"{_sha256(context['nonce'])}.json"):
            _deny(DenialKind.NONCE_REPLAY, "nonce claim path does not match the active nonce")
        lease_raw = _read_private_file(
            bindings.lease_path,
            state_root=state_root,
            label="attempt lease",
            maximum_bytes=65_536,
        )
        claim_raw = _read_private_file(
            nonce_claim_path,
            state_root=state_root,
            label="attempt nonce claim",
            maximum_bytes=65_536,
        )
        _read_private_file(
            bindings.receipt_path,
            state_root=state_root,
            label="policy receipt destination",
            maximum_bytes=64 * MAX_EXECUTION_CONTEXT_BYTES,
        )
        lease = _exact_mapping(_load_json(lease_raw, "attempt lease"), _LEASE_KEYS, "attempt lease")
        claim = _exact_mapping(_load_json(claim_raw, "attempt nonce claim"), _NONCE_KEYS, "attempt nonce claim")
        _validate_active_lease(
            lease,
            claim,
            context=context,
            context_sha256=observed_context_sha,
            dispatch_id=dispatch_id,
            bindings=bindings,
        )

        return AuthenticatedAttemptContext(
            schema_version=CONTEXT_SCHEMA_VERSION,
            policy_abi_version=POLICY_ABI_VERSION,
            authenticated=True,
            context_path=bindings.context_path,
            context_sha256=observed_context_sha,
            owner_token_sha256=bindings.owner_token_sha256,
            lease_path=bindings.lease_path,
            receipt_path=bindings.receipt_path,
            dispatch_id=dispatch_id,
            run_id=bindings.run_id,
            ticket_id=bindings.ticket_id,
            attempt=bindings.attempt,
            target_repo_realpath=target_repo,
            worktree_realpath=worktree,
            state_root_realpath=state_root,
            policy_root_realpath=policy_root,
            bundle_root_realpath=bundle_root,
            role=bindings.role,
            lifecycle_phase=bindings.lifecycle_phase,
            ticket_contract_schema_version=TICKET_CONTRACT_SCHEMA_VERSION,
            ticket_contract_digest=context["ticket_contract_digest"],
            attempt_digest=context["attempt_digest"],
            declared_scope=scope,
            requested_identity=identity,
            runtime_provenance=runtime,
            nonce=context["nonce"],
            lease_active=True,
            replayed=False,
        )


def _dispatch_id(run_id: object, ticket_id: object, phase: object, attempt: object, role: object) -> str:
    for value, label in (
        (run_id, "run id"),
        (ticket_id, "ticket id"),
        (phase, "lifecycle phase"),
        (role, "role"),
    ):
        if not isinstance(value, str) or _ID_COMPONENT_RE.fullmatch(value) is None:
            _deny(DenialKind.AUTHENTICATION_FAILED, f"{label} is malformed")
    if type(attempt) is not int or attempt < 1 or attempt > 9_007_199_254_740_991:
        _deny(DenialKind.AUTHENTICATION_FAILED, "attempt number is malformed")
    return f"{run_id}/{ticket_id}/{phase}/{attempt}/{role}"


def _validate_context_scalars(context: Mapping[str, Any]) -> None:
    _dispatch_id(
        context["run_id"],
        context["ticket_id"],
        context["lifecycle_phase"],
        context["attempt"],
        context["role"],
    )
    for key in (
        "dispatch_id",
        "target_repo_realpath",
        "worktree_realpath",
        "state_root_realpath",
        "policy_root_realpath",
        "bundle_root_realpath",
        "ticket_contract_digest",
        "attempt_digest",
        "owner_token_sha256",
        "nonce",
        "nonce_claim_path",
        "lease_path",
        "receipt_path",
        "requested_bundle_sha256",
        "requested_config_sha256",
    ):
        if not isinstance(context[key], str) or not context[key]:
            _deny(DenialKind.AUTHENTICATION_FAILED, f"context {key} is malformed")
    for key in (
        "requested_bundle_sha256",
        "requested_config_sha256",
        "owner_token_sha256",
    ):
        if not _is_sha256(context[key]):
            _deny(DenialKind.AUTHENTICATION_FAILED, f"context {key} is malformed")


def _scope(value: object) -> tuple[TicketScopeEntry, ...]:
    if not isinstance(value, list) or not value:
        _deny(DenialKind.AUTHENTICATION_FAILED, "declared scope is not a non-empty array")
    entries: list[TicketScopeEntry] = []
    for item in value:
        if not isinstance(item, dict) or not _SCOPE_REQUIRED_KEYS <= set(item) <= _SCOPE_ALLOWED_KEYS:
            _deny(DenialKind.AUTHENTICATION_FAILED, "declared scope entry is not closed")
        path = item["path"]
        change_kind = item["change_kind"]
        directory = item["directory"]
        from_path = item.get("from_path")
        if (
            not isinstance(path, str)
            or not path
            or change_kind not in {"create", "modify", "delete", "rename"}
            or type(directory) is not bool
        ):
            _deny(DenialKind.AUTHENTICATION_FAILED, "declared scope entry is malformed")
        if change_kind == "rename":
            if not isinstance(from_path, str) or not from_path:
                _deny(DenialKind.AUTHENTICATION_FAILED, "rename scope is missing from_path")
        elif "from_path" in item:
            _deny(DenialKind.AUTHENTICATION_FAILED, "non-rename scope carries from_path")
        entries.append(TicketScopeEntry(path, change_kind, directory, from_path))
    return tuple(entries)


def _requested_identity(value: object) -> RequestedModelIdentity:
    identity = _exact_mapping(value, _IDENTITY_KEYS, "requested identity")
    string_keys = _IDENTITY_KEYS - {"profile_available", "conflict"}
    if any(not isinstance(identity[key], str) or not identity[key] for key in string_keys):
        _deny(DenialKind.IDENTITY_MISSING, "requested identity is incomplete")
    if type(identity["profile_available"]) is not bool or type(identity["conflict"]) is not bool:
        _deny(DenialKind.IDENTITY_CONFLICT, "requested identity flags are malformed")
    if (
        identity["normalization_version"] != IDENTITY_NORMALIZATION_VERSION
        or identity["conflict"]
        or identity["canonical_harness"] != normalize_harness_identity(identity["raw_harness"])
        or identity["canonical_provider"] != identity["raw_provider"]
        or identity["canonical_vendor"] != identity["raw_vendor"]
        or identity["canonical_model_id"] != identity["raw_model_id"]
    ):
        _deny(DenialKind.IDENTITY_CONFLICT, "requested identity conflicts with normalization contract")
    if identity["profile"] != "effective-session-v1" or not identity["profile_available"]:
        _deny(DenialKind.IDENTITY_PROFILE_UNAVAILABLE, "requested identity profile is unavailable")
    if not _is_sha256(identity["bundle_digest"]) or not _is_sha256(identity["config_digest"]):
        _deny(DenialKind.IDENTITY_MISSING, "requested identity digests are malformed")
    return RequestedModelIdentity(**identity)


def _runtime_provenance(value: object) -> RuntimeProvenance:
    runtime = _exact_mapping(value, _RUNTIME_PROVENANCE_KEYS, "runtime provenance")
    if runtime["schema_version"] != RUNTIME_PROVENANCE_SCHEMA_VERSION:
        _deny(DenialKind.CONTEXT_ABI_UNSUPPORTED, "runtime provenance schema is unsupported")
    for key in _RUNTIME_PROVENANCE_KEYS:
        if not isinstance(runtime[key], str) or not runtime[key]:
            _deny(DenialKind.AUTHENTICATION_FAILED, f"runtime provenance {key} is malformed")
    for key in (
        "omnigent_python_sha256",
        "rickgent_policies_sha256",
        "rickgent_node_sha256",
        "rickgent_cli_sha256",
    ):
        if not _is_sha256(runtime[key]):
            _deny(DenialKind.AUTHENTICATION_FAILED, f"runtime provenance {key} is malformed")
    _normalized_executable_entrypoint(
        runtime["omnigent_python_entrypoint"],
        "runtime provenance omnigent_python_entrypoint",
    )
    for key in (
        "omnigent_python_realpath",
        "omnigent_root_realpath",
        "omnigent_origin_realpath",
        "rickgent_policies_origin_realpath",
        "rickgent_node_realpath",
        "rickgent_cli_realpath",
    ):
        _canonical_absolute(runtime[key], f"runtime provenance {key}")
    if os.path.realpath(runtime["omnigent_python_entrypoint"]) != runtime["omnigent_python_realpath"]:
        _deny(DenialKind.AUTHENTICATION_FAILED, "runtime provenance Python entrypoint target conflicts")
    commit = runtime["rickgent_build_commit"]
    if commit != commit.strip() or any(character.isspace() for character in commit):
        _deny(DenialKind.AUTHENTICATION_FAILED, "runtime provenance build commit is malformed")
    return RuntimeProvenance(**runtime)


def _validate_active_lease(
    lease: Mapping[str, Any],
    claim: Mapping[str, Any],
    *,
    context: Mapping[str, Any],
    context_sha256: str,
    dispatch_id: str,
    bindings: TrustedSpawnBindings,
) -> None:
    if lease["schema_version"] != ATTEMPT_LEASE_SCHEMA_VERSION or claim["schema_version"] != NONCE_CLAIM_SCHEMA_VERSION:
        _deny(DenialKind.CONTEXT_ABI_UNSUPPORTED, "lease or nonce schema is unsupported")
    tuple_values = {
        "dispatch_id": dispatch_id,
        "run_id": bindings.run_id,
        "ticket_id": bindings.ticket_id,
        "attempt": bindings.attempt,
        "lifecycle_phase": bindings.lifecycle_phase,
        "role": bindings.role,
        "context_sha256": context_sha256,
        "owner_token_sha256": bindings.owner_token_sha256,
        "nonce": context["nonce"],
    }
    for key, expected in tuple_values.items():
        if type(claim[key]) is not type(expected) or claim[key] != expected:
            kind = (
                DenialKind.NONCE_REPLAY
                if key in {"dispatch_id", "run_id", "ticket_id", "attempt"}
                else DenialKind.AUTHENTICATION_FAILED
            )
            _deny(kind, f"nonce claim {key} conflicts with active attempt")
        if type(lease[key]) is not type(expected) or lease[key] != expected:
            kind = (
                DenialKind.DISPATCH_REPLAY
                if key in {"dispatch_id", "run_id", "ticket_id", "attempt"}
                else DenialKind.AUTHENTICATION_FAILED
            )
            _deny(kind, f"lease {key} conflicts with active attempt")
    if lease["nonce_claim_path"] != bindings.nonce_claim_path:
        _deny(DenialKind.NONCE_REPLAY, "lease points at another nonce claim")
    if lease["status"] != "active" or lease["closed_at_ms"] is not None:
        _deny(DenialKind.LEASE_CLOSED, "attempt lease is closed")
    expires_at = lease["expires_at_ms"]
    if type(expires_at) is not int or expires_at <= int(time.time() * 1000):
        _deny(DenialKind.LEASE_CLOSED, "attempt lease is expired")


def authenticator_from_environment(
    environment: Mapping[str, str] | None = None,
) -> FilesystemContextAuthenticator:
    """Build the production authenticator from the final pinned child env."""

    return FilesystemContextAuthenticator.from_environment(environment)


__all__ = [
    "ATTEMPT_LEASE_SCHEMA_VERSION",
    "FilesystemContextAuthenticator",
    "MAX_EXECUTION_CONTEXT_BYTES",
    "NONCE_CLAIM_SCHEMA_VERSION",
    "TRUSTED_SPAWN_ENVIRONMENT_KEYS",
    "TrustedSpawnBindings",
    "authenticator_from_environment",
    "verify_runtime_provenance_environment",
]
