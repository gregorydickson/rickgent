"""Provenance-bound bridge to Rickgent's TypeScript verdict core."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess

_BUILD_COMMIT_OVERRIDE = os.environ.get("RICKGENT_BUILD_COMMIT")
BUILD_COMMIT = _BUILD_COMMIT_OVERRIDE or ""
_RICKGENT_NODE = os.environ.get("RICKGENT_NODE_REALPATH", "")
_RICKGENT_NODE_SHA256 = os.environ.get("RICKGENT_NODE_SHA256", "")
_RICKGENT_BIN = os.environ.get("RICKGENT_CLI_REALPATH", "")
_RICKGENT_BIN_SHA256 = os.environ.get("RICKGENT_CLI_SHA256", "")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT_DIGEST_CACHE: dict[str, tuple[tuple[int, int, int, int, int], str]] = {}


def _binding() -> tuple[str, str, str, str, str]:
    """Read the pinned process binding, allowing late fixture materialization.

    Production supplies these variables before policy import.  Tests construct
    isolated attempts after module collection, so an initially empty module
    value falls back to the same trusted process environment that the
    filesystem authenticator verifies against the immutable context.
    """

    node = _RICKGENT_NODE or os.environ.get("RICKGENT_NODE_REALPATH", "")
    node_digest = _RICKGENT_NODE_SHA256 or os.environ.get("RICKGENT_NODE_SHA256", "")
    cli = _RICKGENT_BIN or os.environ.get("RICKGENT_CLI_REALPATH", "")
    cli_digest = _RICKGENT_BIN_SHA256 or os.environ.get("RICKGENT_CLI_SHA256", "")
    commit = BUILD_COMMIT or os.environ.get("RICKGENT_BUILD_COMMIT", "")
    return node, node_digest, cli, cli_digest, commit


def _stable_artifact_sha256(path: str, label: str) -> str:
    if not path or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise RuntimeError(f"pinned {label} path is missing or malformed")
    if os.path.realpath(path) != path:
        raise RuntimeError(f"pinned {label} path is not canonical")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        raise RuntimeError(f"pinned {label} could not be opened securely") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError(f"pinned {label} is not a regular file")
        fingerprint = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        cached = _ARTIFACT_DIGEST_CACHE.get(path)
        if cached is not None and cached[0] == fingerprint:
            return cached[1]
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 65_536)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise RuntimeError(f"pinned {label} changed while it was read")
        value = digest.hexdigest()
        _ARTIFACT_DIGEST_CACHE[path] = (fingerprint, value)
        return value
    except OSError as error:
        raise RuntimeError(f"pinned {label} could not be opened securely") from error
    finally:
        os.close(descriptor)


def _assert_runtime_artifacts() -> tuple[str, str]:
    node, expected_node_digest, cli, expected_cli_digest, _commit = _binding()
    if _SHA256_RE.fullmatch(expected_node_digest) is None:
        raise RuntimeError("pinned Rickgent Node digest is missing or malformed")
    if _stable_artifact_sha256(node, "Rickgent Node interpreter") != expected_node_digest:
        raise RuntimeError("pinned Rickgent Node digest mismatch")
    if _SHA256_RE.fullmatch(expected_cli_digest) is None:
        raise RuntimeError("pinned Rickgent CLI digest is missing or malformed")
    if _stable_artifact_sha256(cli, "Rickgent CLI") != expected_cli_digest:
        raise RuntimeError("pinned Rickgent CLI digest mismatch")
    return node, cli


def _assert_cli_artifact() -> str:
    """Compatibility accessor that now authenticates the complete CLI chain."""

    _node, cli = _assert_runtime_artifacts()
    return cli


def _build_commit() -> str:
    _node, _node_digest, _cli, _cli_digest, commit = _binding()
    if (
        not commit
        or commit != commit.strip()
        or any(character.isspace() for character in commit)
    ):
        raise RuntimeError("pinned Rickgent build commit is missing or malformed")
    return commit


def _detect_build_commit() -> str:
    """Compatibility accessor; build identity is injected, never PATH-detected."""

    return _build_commit()


def _assert_build_commit() -> None:
    node, cli = _assert_runtime_artifacts()
    expected_commit = _build_commit()
    try:
        proc = subprocess.run(
            [node, cli, "--build-commit"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("pinned Rickgent CLI build-commit check failed") from error
    if proc.returncode != 0:
        raise RuntimeError(
            f"build_commit check failed: pinned Rickgent CLI exited {proc.returncode}"
        )
    ts_commit = (proc.stdout or "").strip()
    if not ts_commit or ts_commit != expected_commit:
        raise RuntimeError(
            f"build_commit mismatch: TS={ts_commit[:12]} Python={expected_commit[:12]}"
        )


def _rickgent_verdict(check: str, input_data: dict[str, object]) -> dict[str, object]:
    node, cli = _assert_runtime_artifacts()
    try:
        proc = subprocess.run(
            [node, cli, "verdict", check, "--json"],
            input=json.dumps(input_data),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            return {
                "error": True,
                "code": "POLICY_SHIM_ERROR",
                "message": f"rickgent verdict exited {proc.returncode}",
            }
        parsed = json.loads(proc.stdout)
        return parsed if isinstance(parsed, dict) else {
            "error": True,
            "code": "POLICY_SHIM_ERROR",
            "message": "rickgent verdict returned a non-object",
        }
    except subprocess.TimeoutExpired:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": "rickgent verdict timed out"}
    except (json.JSONDecodeError, ValueError) as error:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": f"malformed verdict output: {error}"}
    except (FileNotFoundError, PermissionError):
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": "pinned rickgent CLI unavailable"}
    except Exception as error:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": str(error)}


def _verified_verdict(check: str, input_data: dict[str, object]) -> dict[str, object]:
    # Re-hash and re-query the exact CLI immediately before every verdict.
    _assert_build_commit()
    return _rickgent_verdict(check, input_data)


__all__ = [
    "BUILD_COMMIT",
    "_RICKGENT_NODE",
    "_RICKGENT_NODE_SHA256",
    "_RICKGENT_BIN",
    "_RICKGENT_BIN_SHA256",
    "_assert_build_commit",
    "_detect_build_commit",
    "_rickgent_verdict",
    "_verified_verdict",
]
