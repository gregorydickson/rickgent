"""Strict adapter for Rickgent's native Omnigent policy boundary.

The adapter is intentionally policy-agnostic.  It validates the native
``FunctionPolicy`` event/config ABI, authenticates the referenced attempt
context through an injected consumer, and returns one immutable discriminated
result.  It never consults legacy top-level event or config aliases.

The filesystem-backed authenticator lives in :mod:`rickgent_policies.context`.
The injected seam remains available for deterministic boundary tests.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Literal, Protocol, TypeAlias, runtime_checkable

POLICY_ABI_VERSION = "omnigent-function-policy/current-v1"
CONTEXT_SCHEMA_VERSION = "rickgent-attempt-context/v1"
IDENTITY_NORMALIZATION_VERSION = "rickgent-identity-normalization/v1"
RUNTIME_PROVENANCE_SCHEMA_VERSION = "rickgent-runtime-provenance/v2"
TICKET_CONTRACT_SCHEMA_VERSION = "1.0.0"

REQUIRED_CONFIG_KEYS = frozenset(
    {
        "rickgent_policy_abi",
        "context_path",
        "context_sha256",
        "context_owner_token_sha256",
        "lease_path",
        "receipt_path",
        "dispatch_id",
    }
)

NATIVE_PHASES = frozenset(
    {
        "request",
        "tool_call",
        "tool_result",
        "response",
        "llm_request",
        "llm_response",
    }
)

_REQUIRED_EVENT_FIELDS = frozenset(
    {"type", "target", "data", "context", "session_state", "llm_client"}
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TICKET_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

_HARNESS_ALIASES: Mapping[str, str] = MappingProxyType(
    {
        "agy": "antigravity",
        "claude": "claude-sdk",
        "github-copilot": "copilot",
        "google-antigravity": "antigravity",
        "kimi-code": "kimi",
        "native-antigravity": "antigravity-native",
        "native-goose": "goose-native",
        "native-hermes": "hermes-native",
        "native-kimi": "kimi-native",
        "native-kiro": "kiro-native",
        "native-opencode": "opencode-native",
        "native-pi": "pi-native",
        "native-qwen": "qwen-native",
        "openai-agents-sdk": "openai-agents",
        "opencode": "opencode-native",
        "qwen-code": "qwen",
        "acp:probe": "acp",
    }
)


class DenialCode(str, Enum):
    """Stable codes transported in native policy reason prefixes."""

    CONFIG_MISSING = "RICKGENT_POLICY_CONFIG_MISSING"
    ABI_UNSUPPORTED = "RICKGENT_POLICY_ABI_UNSUPPORTED"
    CONTEXT_PATH_UNTRUSTED = "RICKGENT_CONTEXT_PATH_UNTRUSTED"
    CONTEXT_INTEGRITY_FAILED = "RICKGENT_CONTEXT_INTEGRITY_FAILED"
    CONTEXT_REPLAYED = "RICKGENT_CONTEXT_REPLAYED"
    EVENT_MALFORMED = "RICKGENT_POLICY_EVENT_MALFORMED"
    IDENTITY_MISSING = "RICKGENT_IDENTITY_MISSING"
    IDENTITY_CONFLICT = "RICKGENT_IDENTITY_CONFLICT"
    IDENTITY_PROFILE_UNAVAILABLE = "RICKGENT_IDENTITY_PROFILE_UNAVAILABLE"


class DenialKind(str, Enum):
    """Closed internal failure vocabulary, finer than the transport code."""

    CONFIG_MALFORMED = "config_malformed"
    CONFIG_KEY_MISSING = "config_key_missing"
    CONFIG_KEY_DUPLICATE = "config_key_duplicate"
    CONFIG_KEY_UNKNOWN = "config_key_unknown"
    POLICY_ABI_UNSUPPORTED = "policy_abi_unsupported"
    CONFIG_DIGEST_MALFORMED = "config_digest_malformed"
    CONTEXT_REFERENCE_UNTRUSTED = "context_reference_untrusted"
    AUTHENTICATOR_MISSING = "authenticator_missing"
    AUTHENTICATION_FAILED = "authentication_failed"
    CONTEXT_ABI_UNSUPPORTED = "context_abi_unsupported"
    CONTEXT_DIGEST_MISMATCH = "context_digest_mismatch"
    OWNER_TOKEN_MISMATCH = "owner_token_mismatch"
    DISPATCH_REPLAY = "dispatch_replay"
    LEASE_CLOSED = "lease_closed"
    NONCE_REPLAY = "nonce_replay"
    EVENT_MALFORMED = "event_malformed"
    EVENT_FIELD_MISSING = "event_field_missing"
    NATIVE_ABI_UNSUPPORTED = "native_abi_unsupported"
    PHASE_DATA_MALFORMED = "phase_data_malformed"
    REQUEST_DATA_MALFORMED = "request_data_malformed"
    TARGET_NAME_MISMATCH = "target_name_mismatch"
    ARGUMENTS_MALFORMED = "arguments_malformed"
    TOOL_UNKNOWN = "tool_unknown"
    IDENTITY_MISSING = "identity_missing"
    IDENTITY_CONFLICT = "identity_conflict"
    IDENTITY_PROFILE_UNAVAILABLE = "identity_profile_unavailable"


_KIND_TO_CODE: Mapping[DenialKind, DenialCode] = MappingProxyType(
    {
        DenialKind.CONFIG_MALFORMED: DenialCode.CONFIG_MISSING,
        DenialKind.CONFIG_KEY_MISSING: DenialCode.CONFIG_MISSING,
        DenialKind.CONFIG_KEY_DUPLICATE: DenialCode.CONFIG_MISSING,
        DenialKind.CONFIG_KEY_UNKNOWN: DenialCode.CONFIG_MISSING,
        DenialKind.POLICY_ABI_UNSUPPORTED: DenialCode.ABI_UNSUPPORTED,
        DenialKind.CONFIG_DIGEST_MALFORMED: DenialCode.CONFIG_MISSING,
        DenialKind.CONTEXT_REFERENCE_UNTRUSTED: DenialCode.CONTEXT_PATH_UNTRUSTED,
        DenialKind.AUTHENTICATOR_MISSING: DenialCode.CONTEXT_PATH_UNTRUSTED,
        DenialKind.AUTHENTICATION_FAILED: DenialCode.CONTEXT_INTEGRITY_FAILED,
        DenialKind.CONTEXT_ABI_UNSUPPORTED: DenialCode.ABI_UNSUPPORTED,
        DenialKind.CONTEXT_DIGEST_MISMATCH: DenialCode.CONTEXT_INTEGRITY_FAILED,
        DenialKind.OWNER_TOKEN_MISMATCH: DenialCode.CONTEXT_INTEGRITY_FAILED,
        DenialKind.DISPATCH_REPLAY: DenialCode.CONTEXT_REPLAYED,
        DenialKind.LEASE_CLOSED: DenialCode.CONTEXT_REPLAYED,
        DenialKind.NONCE_REPLAY: DenialCode.CONTEXT_REPLAYED,
        DenialKind.EVENT_MALFORMED: DenialCode.EVENT_MALFORMED,
        DenialKind.EVENT_FIELD_MISSING: DenialCode.EVENT_MALFORMED,
        DenialKind.NATIVE_ABI_UNSUPPORTED: DenialCode.ABI_UNSUPPORTED,
        DenialKind.PHASE_DATA_MALFORMED: DenialCode.EVENT_MALFORMED,
        DenialKind.REQUEST_DATA_MALFORMED: DenialCode.EVENT_MALFORMED,
        DenialKind.TARGET_NAME_MISMATCH: DenialCode.EVENT_MALFORMED,
        DenialKind.ARGUMENTS_MALFORMED: DenialCode.EVENT_MALFORMED,
        DenialKind.TOOL_UNKNOWN: DenialCode.EVENT_MALFORMED,
        DenialKind.IDENTITY_MISSING: DenialCode.IDENTITY_MISSING,
        DenialKind.IDENTITY_CONFLICT: DenialCode.IDENTITY_CONFLICT,
        DenialKind.IDENTITY_PROFILE_UNAVAILABLE: DenialCode.IDENTITY_PROFILE_UNAVAILABLE,
    }
)


@dataclass(frozen=True)
class PolicyDenial:
    """A named fail-closed result suitable for direct native translation."""

    denial_kind: DenialKind
    code: DenialCode
    detail: str
    disposition: Literal["deny"] = field(default="deny", init=False)

    def __post_init__(self) -> None:
        if self.code is not _KIND_TO_CODE[self.denial_kind]:
            raise ValueError("denial kind/code pair is not canonical")
        if not self.detail.strip():
            raise ValueError("denial detail must be non-empty")

    @property
    def reason(self) -> str:
        """Return the stable-code-prefixed reason Omnigent preserves."""

        return f"{self.code.value}: {self.detail}"


def make_policy_denial(denial_kind: DenialKind, detail: str) -> PolicyDenial:
    """Construct a denial without allowing code/kind drift."""

    return PolicyDenial(denial_kind, _KIND_TO_CODE[denial_kind], detail)


@dataclass(frozen=True)
class RequestedModelIdentity:
    """Raw and explicitly normalized requested model identity."""

    normalization_version: str
    raw_harness: str
    canonical_harness: str
    raw_provider: str
    canonical_provider: str
    raw_vendor: str
    canonical_vendor: str
    raw_model_id: str
    canonical_model_id: str
    bundle_digest: str
    config_digest: str
    profile: str
    profile_available: bool = True
    conflict: bool = False


@dataclass(frozen=True)
class TicketScopeEntry:
    """Lossless immutable projection of one normalized TicketContract scope."""

    path: str
    change_kind: Literal["create", "modify", "delete", "rename"]
    directory: bool
    from_path: str | None = None


@dataclass(frozen=True)
class RuntimeProvenance:
    """Exact runtime artifacts authenticated for this attempt."""

    schema_version: str
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


@dataclass(frozen=True)
class AuthenticatedAttemptContext:
    """Immutable projection returned by a trusted context authenticator."""

    schema_version: str
    policy_abi_version: str
    authenticated: bool
    context_path: str
    context_sha256: str
    owner_token_sha256: str
    lease_path: str
    receipt_path: str
    dispatch_id: str
    run_id: str
    ticket_id: str
    attempt: int
    target_repo_realpath: str
    worktree_realpath: str
    state_root_realpath: str
    policy_root_realpath: str
    bundle_root_realpath: str
    role: str
    lifecycle_phase: str
    ticket_contract_schema_version: str
    ticket_contract_digest: str
    attempt_digest: str
    declared_scope: tuple[TicketScopeEntry, ...]
    requested_identity: RequestedModelIdentity | None
    runtime_provenance: RuntimeProvenance
    nonce: str
    lease_active: bool
    replayed: bool


@runtime_checkable
class ContextAuthenticator(Protocol):
    """Consumer seam implemented by the filesystem trust boundary in t09."""

    def authenticate(
        self, config: Mapping[str, str]
    ) -> AuthenticatedAttemptContext | PolicyDenial:
        """Authenticate one validated reference-only policy config."""


FrozenValue: TypeAlias = (
    None | bool | int | float | str | tuple["FrozenValue", ...] | Mapping[str, "FrozenValue"]
)


@dataclass(frozen=True)
class CanonicalShellResult:
    """Closed observation decoded from one correlated shell result."""

    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    cwd: str


@dataclass(frozen=True)
class CanonicalPolicyEvent:
    """Recognized native tool event plus authenticated attempt authority.

    ``kind`` is the closed applicability discriminator.  Policies consume this
    projection and never inspect the untrusted native event a second time.
    Filesystem endpoints and shell results are populated only for their
    corresponding kinds.
    """

    native_phase: Literal["tool_call", "tool_result"]
    kind: Literal["filesystem", "shell", "lifecycle", "unrelated"]
    tool: str
    action: str
    arguments: Mapping[str, FrozenValue]
    result: FrozenValue
    source_endpoint: str | None
    destination_endpoint: str | None
    shell_result: CanonicalShellResult | None
    dispatch_id: str
    run_id: str
    ticket_id: str
    attempt: int
    context_sha256: str
    ticket_contract_digest: str
    attempt_digest: str
    role: str
    lifecycle_phase: str
    target_repo_realpath: str
    worktree_realpath: str
    state_root_realpath: str
    policy_root_realpath: str
    bundle_root_realpath: str
    declared_scope: tuple[TicketScopeEntry, ...]
    requested_identity: RequestedModelIdentity
    runtime_provenance: RuntimeProvenance
    disposition: Literal["canonical"] = field(default="canonical", init=False)


@dataclass(frozen=True)
class PolicyAbstention:
    """Authenticated, well-formed native event with no Rickgent authority."""

    native_phase: Literal["request", "response", "llm_request", "llm_response"]
    dispatch_id: str
    context_sha256: str
    disposition: Literal["abstain"] = field(default="abstain", init=False)


PolicyEventResult: TypeAlias = CanonicalPolicyEvent | PolicyAbstention | PolicyDenial


FILESYSTEM_TOOL_ACTIONS: Mapping[str, str] = MappingProxyType(
    {
        "sys_os_read": "read",
        "sys_os_write": "write",
        "sys_os_edit": "edit",
    }
)

SHELL_TOOLS = frozenset({"sys_os_shell"})
LIFECYCLE_TOOL_ACTIONS: Mapping[str, str] = MappingProxyType(
    {
        "rickgent_mark_done": "mark_done",
        "rickgent_phase_advance": "phase_advance",
        "rickgent_build_gate": "build_gate",
        "rickgent_prd_validate": "prd_validate",
    }
)
UNRELATED_NATIVE_TOOLS = frozenset(
    {
        "load_skill",
        "sys_session_get_history",
        "sys_session_send",
        "sys_read_inbox",
        "sys_session_list",
        "sys_session_get_info",
        "sys_session_close",
        "sys_advise_models",
        "sys_list_models",
        "sys_agent_get",
        "sys_agent_download",
        "sys_agent_list",
        "sys_call_async",
        "sys_cancel_async",
        "sys_cancel_task",
        "list_comments",
        "update_comment",
        "sys_add_policy",
        "sys_policy_registry",
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_screenshot",
    }
)
KNOWN_NATIVE_TOOLS = frozenset(FILESYSTEM_TOOL_ACTIONS) | SHELL_TOOLS | frozenset(
    LIFECYCLE_TOOL_ACTIONS
) | UNRELATED_NATIVE_TOOLS


def _exact_keys(value: Mapping[object, object], required: set[str]) -> bool:
    return set(value) == required and all(isinstance(key, str) for key in value)


def _strings(value: object) -> bool:
    return isinstance(value, (list, tuple)) and all(
        isinstance(item, str) for item in value
    )


def _closed_gate(value: object) -> bool:
    if not isinstance(value, Mapping) or not _exact_keys(
        value, {"current", "baseline", "scope", "findings"}
    ):
        return False
    if not _strings(value["scope"]):
        return False
    for key in ("current", "baseline"):
        rows = value[key]
        if not isinstance(rows, (list, tuple)):
            return False
        for row in rows:
            if not isinstance(row, Mapping) or not _exact_keys(
                row, {"name", "passed", "output"}
            ):
                return False
            if not (
                isinstance(row["name"], str)
                and isinstance(row["passed"], bool)
                and isinstance(row["output"], str)
            ):
                return False
    findings = value["findings"]
    if not isinstance(findings, (list, tuple)):
        return False
    for row in findings:
        if not isinstance(row, Mapping) or not _exact_keys(
            row, {"file", "line", "message", "check"}
        ):
            return False
        if not (
            isinstance(row["file"], str)
            and type(row["line"]) is int
            and isinstance(row["message"], str)
            and isinstance(row["check"], str)
        ):
            return False
    return True


def _closed_prd(value: object) -> bool:
    if not isinstance(value, Mapping) or not _exact_keys(
        value,
        {"title", "description", "acceptanceCriteria", "simplificationReview"},
    ):
        return False
    if not isinstance(value["title"], str) or not isinstance(value["description"], str):
        return False
    criteria = value["acceptanceCriteria"]
    if not isinstance(criteria, (list, tuple)):
        return False
    for row in criteria:
        if not isinstance(row, Mapping) or not _exact_keys(
            row, {"description", "type", "verifyCommand", "scope"}
        ):
            return False
        if not (
            isinstance(row["description"], str)
            and isinstance(row["type"], str)
            and isinstance(row["verifyCommand"], str)
            and _strings(row["scope"])
        ):
            return False
    review = value["simplificationReview"]
    return review is None or (
        isinstance(review, Mapping)
        and _exact_keys(review, {"reviewed", "notes"})
        and isinstance(review["reviewed"], bool)
        and isinstance(review["notes"], str)
    )


def _arguments_match_tool(tool: str, arguments: Mapping[object, object]) -> bool:
    if tool == "sys_os_read":
        if not set(arguments) <= {"path", "offset", "limit"} or "path" not in arguments:
            return False
        return isinstance(arguments["path"], str) and bool(arguments["path"]) and all(
            type(arguments[key]) is int for key in ("offset", "limit") if key in arguments
        )
    if tool == "sys_os_write":
        return (
            _exact_keys(arguments, {"path", "content"})
            and isinstance(arguments["path"], str)
            and bool(arguments["path"])
            and isinstance(arguments["content"], str)
        )
    if tool == "sys_os_edit":
        if not isinstance(arguments.get("path"), str) or not arguments.get("path"):
            return False
        if _exact_keys(arguments, {"path", "oldText", "newText"}):
            return (
                isinstance(arguments["oldText"], str)
                and isinstance(arguments["newText"], str)
            )
        if (
            not _exact_keys(arguments, {"path", "edits"})
            or not isinstance(arguments["edits"], (list, tuple))
            or not arguments["edits"]
        ):
            return False
        return all(
            isinstance(row, Mapping)
            and _exact_keys(row, {"oldText", "newText"})
            and isinstance(row["oldText"], str)
            and isinstance(row["newText"], str)
            for row in arguments["edits"]
        )
    if tool == "sys_os_shell":
        cmd = arguments.get("command")
        return (
            set(arguments) in ({"command"}, {"command", "timeout"})
            and isinstance(cmd, str)
            and bool(cmd.strip())
            and ("timeout" not in arguments or type(arguments["timeout"]) is int)
        )
    if tool == "rickgent_mark_done":
        return (
            _exact_keys(arguments, {"claimed_sha", "evidence"})
            and isinstance(arguments["claimed_sha"], str)
            and _strings(arguments["evidence"])
        )
    if tool == "rickgent_phase_advance":
        return (
            _exact_keys(arguments, {"next_phase"})
            and isinstance(arguments["next_phase"], str)
            and bool(arguments["next_phase"])
        )
    if tool == "rickgent_build_gate":
        return _exact_keys(arguments, {"gate"}) and _closed_gate(arguments["gate"])
    if tool == "rickgent_prd_validate":
        return _exact_keys(arguments, {"prd"}) and _closed_prd(arguments["prd"])
    return True


def adapt_native_policy_event(
    event: object,
    config: object,
    *,
    authenticator: ContextAuthenticator | None = None,
) -> PolicyEventResult:
    """Validate and canonicalize one exact native FunctionPolicy event.

    Validation deliberately authenticates config before phase classification,
    so malformed or unauthenticated requests can never be downgraded to an
    unrelated-event abstention.
    """

    try:
        validated_config = _validate_config(config)
    except Exception:
        return make_policy_denial(
            DenialKind.CONFIG_MALFORMED,
            "policy config could not be read safely",
        )
    if isinstance(validated_config, PolicyDenial):
        return validated_config

    try:
        trusted = _authenticate(validated_config, authenticator)
    except Exception:
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "attempt-context projection could not be read safely",
        )
    if isinstance(trusted, PolicyDenial):
        return trusted

    try:
        return _adapt_authenticated_event(event, trusted)
    except Exception:
        # Custom Mapping implementations can throw during access.  The native
        # security boundary never propagates such failures as permission.
        return make_policy_denial(
            DenialKind.EVENT_MALFORMED,
            "native policy event could not be read safely",
        )


def _validate_config(config: object) -> Mapping[str, str] | PolicyDenial:
    if not isinstance(config, Mapping):
        return make_policy_denial(
            DenialKind.CONFIG_MALFORMED,
            "policy config must be a string-to-string mapping",
        )

    try:
        entries = list(config.items())
    except Exception:
        return make_policy_denial(
            DenialKind.CONFIG_MALFORMED,
            "policy config entries could not be read safely",
        )

    normalized: dict[str, str] = {}
    for entry in entries:
        try:
            key, value = entry
        except (TypeError, ValueError):
            return make_policy_denial(
                DenialKind.CONFIG_MALFORMED,
                "policy config entries must be key/value pairs",
            )
        if (
            not isinstance(key, str)
            or not key
            or not isinstance(value, str)
            or not value
        ):
            return make_policy_denial(
                DenialKind.CONFIG_MALFORMED,
                "policy config keys and values must be non-empty strings",
            )
        if key in normalized:
            return make_policy_denial(
                DenialKind.CONFIG_KEY_DUPLICATE,
                f"policy config key {key!r} was repeated",
            )
        normalized[key] = value

    missing = REQUIRED_CONFIG_KEYS - normalized.keys()
    if missing:
        return make_policy_denial(
            DenialKind.CONFIG_KEY_MISSING,
            f"policy config is missing required key {sorted(missing)[0]!r}",
        )

    unknown = normalized.keys() - REQUIRED_CONFIG_KEYS
    if unknown:
        return make_policy_denial(
            DenialKind.CONFIG_KEY_UNKNOWN,
            f"policy config contains unsupported key {sorted(unknown)[0]!r}",
        )

    if normalized["rickgent_policy_abi"] != POLICY_ABI_VERSION:
        return make_policy_denial(
            DenialKind.POLICY_ABI_UNSUPPORTED,
            "policy ABI is not supported",
        )

    for key in ("context_sha256", "context_owner_token_sha256"):
        if not _is_sha256(normalized[key]):
            return make_policy_denial(
                DenialKind.CONFIG_DIGEST_MALFORMED,
                f"policy config {key!r} is not canonical SHA-256",
            )

    for key in ("context_path", "lease_path", "receipt_path"):
        if not os.path.isabs(normalized[key]):
            return make_policy_denial(
                DenialKind.CONTEXT_REFERENCE_UNTRUSTED,
                f"policy config {key!r} is not an absolute trusted reference",
            )

    if not normalized["dispatch_id"].strip():
        return make_policy_denial(
            DenialKind.CONFIG_MALFORMED,
            "policy config dispatch_id must not be blank",
        )

    return MappingProxyType(normalized)


def _authenticate(
    config: Mapping[str, str], authenticator: ContextAuthenticator | None
) -> AuthenticatedAttemptContext | PolicyDenial:
    if authenticator is None:
        return make_policy_denial(
            DenialKind.AUTHENTICATOR_MISSING,
            "no trusted attempt-context authenticator is available",
        )

    try:
        trusted = authenticator.authenticate(config)
    except Exception:
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "attempt-context authentication failed",
        )

    if isinstance(trusted, PolicyDenial):
        return trusted
    if (
        not isinstance(trusted, AuthenticatedAttemptContext)
        or not isinstance(trusted.authenticated, bool)
        or not trusted.authenticated
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "authenticator did not return an authenticated attempt context",
        )

    if (
        trusted.schema_version != CONTEXT_SCHEMA_VERSION
        or trusted.policy_abi_version != POLICY_ABI_VERSION
    ):
        return make_policy_denial(
            DenialKind.CONTEXT_ABI_UNSUPPORTED,
            "trusted attempt context uses an unsupported schema or policy ABI",
        )

    if not isinstance(trusted.lease_active, bool) or not isinstance(
        trusted.replayed, bool
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "attempt-context lease and replay flags must be booleans",
        )

    if trusted.dispatch_id != config["dispatch_id"]:
        return make_policy_denial(
            DenialKind.DISPATCH_REPLAY,
            "attempt context belongs to a different dispatch",
        )
    if trusted.replayed:
        return make_policy_denial(
            DenialKind.NONCE_REPLAY,
            "attempt-context nonce was replayed",
        )
    if not trusted.lease_active:
        return make_policy_denial(
            DenialKind.LEASE_CLOSED,
            "attempt lease is closed or expired",
        )

    if trusted.context_sha256 != config["context_sha256"]:
        return make_policy_denial(
            DenialKind.CONTEXT_DIGEST_MISMATCH,
            "attempt context digest did not match policy config",
        )
    if trusted.owner_token_sha256 != config["context_owner_token_sha256"]:
        return make_policy_denial(
            DenialKind.OWNER_TOKEN_MISMATCH,
            "attempt owner-token digest did not match policy config",
        )

    for key, actual in (
        ("context_path", trusted.context_path),
        ("lease_path", trusted.lease_path),
        ("receipt_path", trusted.receipt_path),
    ):
        if actual != config[key]:
            return make_policy_denial(
                DenialKind.AUTHENTICATION_FAILED,
                f"authenticated {key!r} binding did not match policy config",
            )

    invalid_context = _validate_trusted_projection(trusted)
    if invalid_context is not None:
        return invalid_context
    return trusted


def _validate_trusted_projection(
    trusted: AuthenticatedAttemptContext,
) -> PolicyDenial | None:
    required_identifiers = (
        trusted.run_id,
        trusted.ticket_id,
        trusted.dispatch_id,
        trusted.role,
        trusted.lifecycle_phase,
        trusted.nonce,
    )
    if any(
        not isinstance(value, str) or not value.strip()
        for value in required_identifiers
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "trusted attempt context is missing required authority fields",
        )
    if (
        not isinstance(trusted.attempt, int)
        or isinstance(trusted.attempt, bool)
        or trusted.attempt < 1
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "trusted attempt number is invalid",
        )
    roots = (
        trusted.target_repo_realpath,
        trusted.worktree_realpath,
        trusted.state_root_realpath,
        trusted.policy_root_realpath,
        trusted.bundle_root_realpath,
    )
    if any(
        not isinstance(root, str)
        or not os.path.isabs(root)
        or os.path.normpath(root) != root
        for root in roots
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "trusted repository roots are not canonical absolute paths",
        )
    if (
        trusted.ticket_contract_schema_version != TICKET_CONTRACT_SCHEMA_VERSION
        or not _is_ticket_digest(trusted.ticket_contract_digest)
        or not _is_sha256(trusted.attempt_digest)
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "trusted attempt digests are malformed",
        )
    if not isinstance(trusted.declared_scope, tuple) or any(
        not _valid_scope_entry(entry) for entry in trusted.declared_scope
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "trusted declared scope is malformed",
        )

    identity = trusted.requested_identity
    if not isinstance(identity, RequestedModelIdentity):
        return make_policy_denial(
            DenialKind.IDENTITY_MISSING,
            "trusted requested model identity is absent or malformed",
        )
    identity_values = (
        identity.normalization_version,
        identity.raw_harness,
        identity.canonical_harness,
        identity.raw_provider,
        identity.canonical_provider,
        identity.raw_vendor,
        identity.canonical_vendor,
        identity.raw_model_id,
        identity.canonical_model_id,
        identity.profile,
    )
    if (
        any(not isinstance(value, str) or not value.strip() for value in identity_values)
        or not all(
            _is_sha256(value)
            for value in (identity.bundle_digest, identity.config_digest)
        )
    ):
        return make_policy_denial(
            DenialKind.IDENTITY_MISSING,
            "trusted requested model identity is incomplete",
        )
    if (
        not isinstance(identity.conflict, bool)
        or identity.normalization_version != IDENTITY_NORMALIZATION_VERSION
        or identity.conflict
    ):
        return make_policy_denial(
            DenialKind.IDENTITY_CONFLICT,
            "trusted requested model identity conflicts with its normalization contract",
        )
    if not isinstance(identity.profile_available, bool):
        return make_policy_denial(
            DenialKind.IDENTITY_CONFLICT,
            "trusted requested model identity availability flag is malformed",
        )
    if not identity.profile_available:
        return make_policy_denial(
            DenialKind.IDENTITY_PROFILE_UNAVAILABLE,
            "requested identity observation profile is unavailable",
        )
    if (
        identity.canonical_harness != normalize_harness_identity(identity.raw_harness)
        or identity.canonical_provider != identity.raw_provider
        or identity.canonical_vendor != identity.raw_vendor
        or identity.canonical_model_id != identity.raw_model_id
    ):
        return make_policy_denial(
            DenialKind.IDENTITY_CONFLICT,
            "trusted requested model identity conflicts with the explicit t00 alias corpus",
        )
    return None


def _adapt_authenticated_event(
    event: object, trusted: AuthenticatedAttemptContext
) -> PolicyEventResult:
    if not isinstance(event, Mapping):
        return make_policy_denial(
            DenialKind.EVENT_MALFORMED,
            "native policy event must be a mapping",
        )

    missing = _REQUIRED_EVENT_FIELDS - event.keys()
    if missing:
        return make_policy_denial(
            DenialKind.EVENT_FIELD_MISSING,
            f"native policy event is missing required field {sorted(missing)[0]!r}",
        )

    if not isinstance(event["context"], Mapping) or not isinstance(
        event["session_state"], Mapping
    ):
        return make_policy_denial(
            DenialKind.EVENT_MALFORMED,
            "native event context and session_state must be mappings",
        )

    phase = event["type"]
    if not isinstance(phase, str) or phase not in NATIVE_PHASES:
        return make_policy_denial(
            DenialKind.NATIVE_ABI_UNSUPPORTED,
            "native policy event phase is unsupported",
        )

    if phase in {"request", "response"}:
        if not isinstance(event["data"], str):
            return make_policy_denial(
                DenialKind.PHASE_DATA_MALFORMED,
                f"native {phase} data must be a string",
            )
        return PolicyAbstention(phase, trusted.dispatch_id, trusted.context_sha256)  # type: ignore[arg-type]

    if phase in {"llm_request", "llm_response"}:
        if not isinstance(event["data"], Mapping):
            return make_policy_denial(
                DenialKind.PHASE_DATA_MALFORMED,
                f"native {phase} data must be a mapping",
            )
        return PolicyAbstention(phase, trusted.dispatch_id, trusted.context_sha256)  # type: ignore[arg-type]

    target = event["target"]
    if not isinstance(target, str) or not target:
        return make_policy_denial(
            DenialKind.TARGET_NAME_MISMATCH,
            "native tool event target must be a non-empty tool name",
        )
    if target not in KNOWN_NATIVE_TOOLS:
        return make_policy_denial(
            DenialKind.TOOL_UNKNOWN,
            f"native governed tool {target!r} is not supported",
        )

    data = event["data"]
    if not isinstance(data, Mapping):
        return make_policy_denial(
            DenialKind.PHASE_DATA_MALFORMED,
            f"native {phase} data must be a mapping",
        )

    result: FrozenValue = None
    if phase == "tool_call":
        name = data.get("name")
        arguments = data.get("arguments")
        if not isinstance(name, str) or not name or name != target:
            return make_policy_denial(
                DenialKind.TARGET_NAME_MISMATCH,
                "native tool target and data.name must match exactly",
            )
    else:
        if "result" not in data:
            return make_policy_denial(
                DenialKind.PHASE_DATA_MALFORMED,
                "native tool_result data is missing result",
            )
        request_data = event.get("request_data")
        if not isinstance(request_data, Mapping):
            return make_policy_denial(
                DenialKind.REQUEST_DATA_MALFORMED,
                "native tool_result request_data must be a mapping",
            )
        name = request_data.get("name")
        arguments = request_data.get("arguments")
        if not isinstance(name, str) or not name or name != target:
            return make_policy_denial(
                DenialKind.TARGET_NAME_MISMATCH,
                "native tool_result target and request_data.name must match exactly",
            )

    if not isinstance(arguments, Mapping):
        return make_policy_denial(
            DenialKind.ARGUMENTS_MALFORMED,
            "native tool arguments must be an already-parsed mapping",
        )
    if not _arguments_match_tool(target, arguments):
        return make_policy_denial(
            DenialKind.ARGUMENTS_MALFORMED,
            f"{target} arguments do not match its closed native schema",
        )

    try:
        frozen_arguments = _freeze_mapping(arguments)
    except (TypeError, ValueError, RecursionError):
        return make_policy_denial(
            DenialKind.ARGUMENTS_MALFORMED,
            "native tool arguments are not an immutable JSON-shaped mapping",
        )

    if phase == "tool_result":
        try:
            result = _freeze_value(data["result"], set())
        except (TypeError, ValueError, RecursionError):
            return make_policy_denial(
                DenialKind.PHASE_DATA_MALFORMED,
                "native tool result is not an immutable JSON-shaped value",
            )

    if target in FILESYSTEM_TOOL_ACTIONS:
        kind: Literal["filesystem", "shell", "lifecycle", "unrelated"] = "filesystem"
        action = FILESYSTEM_TOOL_ACTIONS[target]
        source_endpoint = frozen_arguments["path"]
        assert isinstance(source_endpoint, str)  # closed tool schema above
        shell_result = None
    elif target in SHELL_TOOLS:
        kind = "shell"
        action = "shell"
        source_endpoint = None
        command = frozen_arguments.get("command")
        if not isinstance(command, str) or not command.strip():
            return make_policy_denial(
                DenialKind.ARGUMENTS_MALFORMED,
                "sys_os_shell arguments.command must be a non-empty string",
            )
        shell_result = None
        if phase == "tool_result":
            shell_result = _decode_shell_result(result)
            if shell_result is None:
                return make_policy_denial(
                    DenialKind.PHASE_DATA_MALFORMED,
                    "sys_os_shell result is not a canonical shell observation",
                )
    elif target in LIFECYCLE_TOOL_ACTIONS:
        kind = "lifecycle"
        action = LIFECYCLE_TOOL_ACTIONS[target]
        source_endpoint = None
        shell_result = None
    else:
        kind = "unrelated"
        action = "unrelated"
        source_endpoint = None
        shell_result = None

    identity = trusted.requested_identity
    assert identity is not None  # validated before native event parsing
    return CanonicalPolicyEvent(
        native_phase=phase,  # type: ignore[arg-type]
        kind=kind,
        tool=target,
        action=action,
        arguments=frozen_arguments,
        result=result,
        source_endpoint=source_endpoint,
        destination_endpoint=None,
        shell_result=shell_result,
        dispatch_id=trusted.dispatch_id,
        run_id=trusted.run_id,
        ticket_id=trusted.ticket_id,
        attempt=trusted.attempt,
        context_sha256=trusted.context_sha256,
        ticket_contract_digest=trusted.ticket_contract_digest,
        attempt_digest=trusted.attempt_digest,
        role=trusted.role,
        lifecycle_phase=trusted.lifecycle_phase,
        target_repo_realpath=trusted.target_repo_realpath,
        worktree_realpath=trusted.worktree_realpath,
        state_root_realpath=trusted.state_root_realpath,
        policy_root_realpath=trusted.policy_root_realpath,
        bundle_root_realpath=trusted.bundle_root_realpath,
        declared_scope=trusted.declared_scope,
        requested_identity=identity,
        runtime_provenance=trusted.runtime_provenance,
    )


def _decode_shell_result(value: FrozenValue) -> CanonicalShellResult | None:
    """Decode the one native shell-result shape without accepting aliases."""

    decoded: object = value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return None
    if not isinstance(decoded, Mapping):
        return None
    stdout = decoded.get("stdout")
    stderr = decoded.get("stderr")
    exit_code = decoded.get("exit_code")
    timed_out = decoded.get("timed_out")
    cwd = decoded.get("cwd")
    if (
        not isinstance(stdout, str)
        or not isinstance(stderr, str)
        or (
            exit_code is not None
            and (not isinstance(exit_code, int) or isinstance(exit_code, bool))
        )
        or not isinstance(timed_out, bool)
        or not isinstance(cwd, str)
        or not cwd
    ):
        return None
    return CanonicalShellResult(stdout, stderr, exit_code, timed_out, cwd)


def _freeze_mapping(value: Mapping[object, object]) -> Mapping[str, FrozenValue]:
    frozen = _freeze_value(value, set())
    if not isinstance(frozen, Mapping):  # pragma: no cover - construction invariant
        raise TypeError("expected frozen mapping")
    return frozen


def _freeze_value(value: object, active: set[int]) -> FrozenValue:
    if value is None or isinstance(value, (bool, int, str)):
        return value

    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("non-finite floats are not JSON values")
        return value

    if isinstance(value, Mapping):
        marker = id(value)
        if marker in active:
            raise ValueError("cyclic mapping")
        active.add(marker)
        try:
            result: dict[str, FrozenValue] = {}
            for key, nested in value.items():
                if not isinstance(key, str) or key in result:
                    raise TypeError("mapping keys must be unique strings")
                result[key] = _freeze_value(nested, active)
            return MappingProxyType(result)
        finally:
            active.remove(marker)

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        marker = id(value)
        if marker in active:
            raise ValueError("cyclic sequence")
        active.add(marker)
        try:
            return tuple(_freeze_value(nested, active) for nested in value)
        finally:
            active.remove(marker)

    raise TypeError(f"unsupported mutable argument value {type(value).__name__}")


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and _SHA256_RE.fullmatch(value) is not None


def _is_ticket_digest(value: object) -> bool:
    return isinstance(value, str) and _TICKET_DIGEST_RE.fullmatch(value) is not None


def normalize_harness_identity(raw_harness: str) -> str:
    """Apply only the versioned explicit aliases frozen by t00."""

    return _HARNESS_ALIASES.get(raw_harness, raw_harness)


def _valid_scope_entry(entry: object) -> bool:
    if not isinstance(entry, TicketScopeEntry):
        return False
    if (
        not isinstance(entry.path, str)
        or not entry.path.strip()
        or entry.change_kind not in {"create", "modify", "delete", "rename"}
        or not isinstance(entry.directory, bool)
    ):
        return False
    if entry.change_kind == "rename":
        return isinstance(entry.from_path, str) and bool(entry.from_path.strip())
    return entry.from_path is None


__all__ = [
    "AuthenticatedAttemptContext",
    "CanonicalShellResult",
    "CanonicalPolicyEvent",
    "ContextAuthenticator",
    "CONTEXT_SCHEMA_VERSION",
    "DenialCode",
    "DenialKind",
    "IDENTITY_NORMALIZATION_VERSION",
    "FILESYSTEM_TOOL_ACTIONS",
    "KNOWN_NATIVE_TOOLS",
    "LIFECYCLE_TOOL_ACTIONS",
    "NATIVE_PHASES",
    "POLICY_ABI_VERSION",
    "PolicyAbstention",
    "PolicyDenial",
    "PolicyEventResult",
    "REQUIRED_CONFIG_KEYS",
    "RUNTIME_PROVENANCE_SCHEMA_VERSION",
    "RequestedModelIdentity",
    "RuntimeProvenance",
    "SHELL_TOOLS",
    "TICKET_CONTRACT_SCHEMA_VERSION",
    "TicketScopeEntry",
    "UNRELATED_NATIVE_TOOLS",
    "adapt_native_policy_event",
    "make_policy_denial",
    "normalize_harness_identity",
]
