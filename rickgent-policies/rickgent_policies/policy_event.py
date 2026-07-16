"""Strict adapter for Rickgent's native Omnigent policy boundary.

The adapter is intentionally policy-agnostic.  It validates the native
``FunctionPolicy`` event/config ABI, authenticates the referenced attempt
context through an injected consumer, and returns one immutable discriminated
result.  It never consults legacy top-level event or config aliases.

The filesystem-backed authenticator is owned by the next trust-spine ticket.
Until one is supplied, the public adapter fails closed.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Literal, Protocol, TypeAlias, runtime_checkable


POLICY_ABI_VERSION = "omnigent-function-policy/current-v1"
CONTEXT_SCHEMA_VERSION = "rickgent-attempt-context/v1"
IDENTITY_NORMALIZATION_VERSION = "rickgent-identity-normalization/v1"

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
    ENDPOINT_MISSING = "endpoint_missing"
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
        DenialKind.ENDPOINT_MISSING: DenialCode.EVENT_MALFORMED,
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
    role: str
    lifecycle_phase: str
    ticket_contract_digest: str
    attempt_digest: str
    declared_scope: tuple[str, ...]
    requested_identity: RequestedModelIdentity | None
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
class CanonicalPolicyEvent:
    """Recognized native tool event plus authenticated attempt authority."""

    native_phase: Literal["tool_call", "tool_result"]
    tool: Literal["sys_os_read", "sys_os_write", "sys_os_edit"]
    action: Literal["read", "write", "edit", "rename", "link"]
    arguments: Mapping[str, FrozenValue]
    source_endpoint: str
    destination_endpoint: str | None
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
    declared_scope: tuple[str, ...]
    requested_identity: RequestedModelIdentity
    disposition: Literal["canonical"] = field(default="canonical", init=False)


@dataclass(frozen=True)
class PolicyAbstention:
    """Authenticated, well-formed native event with no Rickgent authority."""

    native_phase: Literal["request", "response", "llm_request", "llm_response"]
    dispatch_id: str
    context_sha256: str
    disposition: Literal["abstain"] = field(default="abstain", init=False)


PolicyEventResult: TypeAlias = CanonicalPolicyEvent | PolicyAbstention | PolicyDenial


_TOOL_ACTIONS: Mapping[str, str] = MappingProxyType(
    {
        "sys_os_read": "read",
        "sys_os_write": "write",
        "sys_os_edit": "edit",
    }
)


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
    roots = (trusted.target_repo_realpath, trusted.worktree_realpath)
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
    if not all(
        _is_sha256(value)
        for value in (trusted.ticket_contract_digest, trusted.attempt_digest)
    ):
        return make_policy_denial(
            DenialKind.AUTHENTICATION_FAILED,
            "trusted attempt digests are malformed",
        )
    if not isinstance(trusted.declared_scope, tuple) or any(
        not isinstance(path, str) or not path.strip() for path in trusted.declared_scope
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
        return PolicyAbstention(phase, trusted.dispatch_id, trusted.context_sha256)

    if phase in {"llm_request", "llm_response"}:
        if not isinstance(event["data"], Mapping):
            return make_policy_denial(
                DenialKind.PHASE_DATA_MALFORMED,
                f"native {phase} data must be a mapping",
            )
        return PolicyAbstention(phase, trusted.dispatch_id, trusted.context_sha256)

    target = event["target"]
    if not isinstance(target, str) or not target:
        return make_policy_denial(
            DenialKind.TARGET_NAME_MISMATCH,
            "native tool event target must be a non-empty tool name",
        )
    if target not in _TOOL_ACTIONS:
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

    try:
        frozen_arguments = _freeze_mapping(arguments)
    except (TypeError, ValueError, RecursionError):
        return make_policy_denial(
            DenialKind.ARGUMENTS_MALFORMED,
            "native tool arguments are not an immutable JSON-shaped mapping",
        )

    source_endpoint = frozen_arguments.get("path")
    if not isinstance(source_endpoint, str) or not source_endpoint:
        return make_policy_denial(
            DenialKind.ENDPOINT_MISSING,
            "structured tool arguments.path must be a non-empty string",
        )

    identity = trusted.requested_identity
    assert identity is not None  # validated before native event parsing
    return CanonicalPolicyEvent(
        native_phase=phase,
        tool=target,
        action=_TOOL_ACTIONS[target],
        arguments=frozen_arguments,
        source_endpoint=source_endpoint,
        destination_endpoint=None,
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
        declared_scope=trusted.declared_scope,
        requested_identity=identity,
    )


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


__all__ = [
    "AuthenticatedAttemptContext",
    "CanonicalPolicyEvent",
    "ContextAuthenticator",
    "CONTEXT_SCHEMA_VERSION",
    "DenialCode",
    "DenialKind",
    "IDENTITY_NORMALIZATION_VERSION",
    "NATIVE_PHASES",
    "POLICY_ABI_VERSION",
    "PolicyAbstention",
    "PolicyDenial",
    "PolicyEventResult",
    "REQUIRED_CONFIG_KEYS",
    "RequestedModelIdentity",
    "adapt_native_policy_event",
    "make_policy_denial",
]
