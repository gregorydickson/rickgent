"""Production filesystem-authenticator proof for per-attempt policy context."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

import pytest

from omnigent.policies.function import FunctionPolicy
from omnigent.policies.types import EvaluationContext
from omnigent.spec.types import FunctionPolicySpec, Phase, PolicyAction

from rickgent_policies.context import (
    ATTEMPT_LEASE_SCHEMA_VERSION,
    NONCE_CLAIM_SCHEMA_VERSION,
    FilesystemContextAuthenticator,
)
from rickgent_policies.policy_event import (
    CONTEXT_SCHEMA_VERSION,
    IDENTITY_NORMALIZATION_VERSION,
    POLICY_ABI_VERSION,
    TICKET_CONTRACT_SCHEMA_VERSION,
    CanonicalPolicyEvent,
    DenialKind,
    PolicyDenial,
    adapt_native_policy_event,
)


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def _sha(value: bytes | str) -> str:
    raw = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(raw).hexdigest()


def _private_dir(path: Path) -> None:
    path.mkdir(mode=0o700)
    path.chmod(0o700)


def _private_file(path: Path, value: bytes | dict[str, Any]) -> None:
    raw = _canonical(value) if isinstance(value, dict) else value
    path.write_bytes(raw)
    path.chmod(0o600)


class AttemptFixture:
    def __init__(self, root: Path) -> None:
        self.target_repo = root / "repo"
        self.worktree = root / "worktree"
        self.state = root / "state"
        for path in (self.target_repo, self.worktree, self.state):
            _private_dir(path)

        self.run_id = "run-001"
        self.ticket_id = "t09"
        self.phase = "implement"
        self.attempt = 1
        self.role = "worker"
        self.dispatch_id = f"{self.run_id}/{self.ticket_id}/{self.phase}/{self.attempt}/{self.role}"
        self.owner_token = "owner-token-secret"
        self.owner_sha = _sha(self.owner_token)
        self.nonce = "nonce-001"
        self.requested_bundle_sha = "b" * 64
        self.requested_config_sha = "c" * 64
        self.invoked_bundle_sha = "d" * 64
        self.invoked_config_sha = "e" * 64

        attempts = self.state / "policy-attempts"
        claims = self.state / "policy-nonce-claims"
        _private_dir(attempts)
        _private_dir(claims)
        self.policy = attempts / _sha(self.dispatch_id)
        _private_dir(self.policy)
        bundle = self.policy / "bundle"
        agents = bundle / "agents"
        rickgent = agents / "rickgent"
        nested_agents = rickgent / "agents"
        self.bundle = nested_agents / "worker"
        for path in (bundle, agents, rickgent, nested_agents, self.bundle):
            _private_dir(path)

        self.context_path = self.policy / "context.json"
        self.lease_path = self.policy / "lease.json"
        self.receipt_path = self.policy / "receipt.jsonl"
        self.claim_path = claims / f"{_sha(self.nonce)}.json"

        identity = {
            "normalization_version": IDENTITY_NORMALIZATION_VERSION,
            "raw_harness": "codex",
            "canonical_harness": "codex",
            "raw_provider": "openai",
            "canonical_provider": "openai",
            "raw_vendor": "openai",
            "canonical_vendor": "openai",
            "raw_model_id": "gpt-5",
            "canonical_model_id": "gpt-5",
            "bundle_digest": self.requested_bundle_sha,
            "config_digest": self.requested_config_sha,
            "profile": "effective-session-v1",
            "profile_available": True,
            "conflict": False,
        }
        digest_base = {
            "schema_version": CONTEXT_SCHEMA_VERSION,
            "policy_abi_version": POLICY_ABI_VERSION,
            "ticket_contract_schema_version": TICKET_CONTRACT_SCHEMA_VERSION,
            "identity_normalization_version": IDENTITY_NORMALIZATION_VERSION,
            "dispatch_id": self.dispatch_id,
            "run_id": self.run_id,
            "ticket_id": self.ticket_id,
            "attempt": self.attempt,
            "lifecycle_phase": self.phase,
            "role": self.role,
            "target_repo_realpath": str(self.target_repo.resolve()),
            "worktree_realpath": str(self.worktree.resolve()),
            "state_root_realpath": str(self.state.resolve()),
            "policy_root_realpath": str(self.policy.resolve()),
            "bundle_root_realpath": str(self.bundle.resolve()),
            "ticket_contract_digest": "sha256:" + "a" * 64,
            "declared_scope": [
                {
                    "path": "src/new.ts",
                    "change_kind": "rename",
                    "directory": False,
                    "from_path": "src/old.ts",
                },
                {
                    "path": "test",
                    "change_kind": "modify",
                    "directory": True,
                },
            ],
            "requested_identity": identity,
            "requested_bundle_sha256": self.requested_bundle_sha,
            "requested_config_sha256": self.requested_config_sha,
        }
        self.context = {
            **digest_base,
            "attempt_digest": _sha(_canonical(digest_base)),
            "owner_token_sha256": self.owner_sha,
            "nonce": self.nonce,
            "nonce_claim_path": str(self.claim_path.resolve()),
            "lease_path": str(self.lease_path.resolve()),
            "receipt_path": str(self.receipt_path.resolve()),
        }
        self.write_context()
        self.write_claim_and_lease()
        _private_file(self.receipt_path, b"")

    def write_context(self, raw: bytes | None = None) -> None:
        _private_file(self.context_path, _canonical(self.context) if raw is None else raw)
        self.context_sha = _sha(self.context_path.read_bytes())
        if hasattr(self, "environment"):
            self.environment["RICKGENT_CONTEXT_SHA256"] = self.context_sha
            self.config["context_sha256"] = self.context_sha

    def write_claim_and_lease(self) -> None:
        common = {
            "dispatch_id": self.dispatch_id,
            "run_id": self.run_id,
            "ticket_id": self.ticket_id,
            "attempt": self.attempt,
            "lifecycle_phase": self.phase,
            "role": self.role,
            "context_sha256": self.context_sha,
            "owner_token_sha256": self.owner_sha,
            "nonce": self.nonce,
        }
        self.claim = {
            "schema_version": NONCE_CLAIM_SCHEMA_VERSION,
            **common,
        }
        self.lease = {
            "schema_version": ATTEMPT_LEASE_SCHEMA_VERSION,
            **common,
            "nonce_claim_path": str(self.claim_path.resolve()),
            "expires_at_ms": int(time.time() * 1000) + 60_000,
            "status": "active",
            "closed_at_ms": None,
        }
        _private_file(self.claim_path, self.claim)
        _private_file(self.lease_path, self.lease)

        self.config = {
            "rickgent_policy_abi": POLICY_ABI_VERSION,
            "context_path": str(self.context_path.resolve()),
            "context_sha256": self.context_sha,
            "context_owner_token_sha256": self.owner_sha,
            "lease_path": str(self.lease_path.resolve()),
            "receipt_path": str(self.receipt_path.resolve()),
            "dispatch_id": self.dispatch_id,
        }
        self.environment = {
            "RICKGENT_STATE_ROOT": str(self.state.resolve()),
            "RICKGENT_POLICY_ROOT": str(self.policy.resolve()),
            "RICKGENT_CONTEXT_PATH": str(self.context_path.resolve()),
            "RICKGENT_CONTEXT_SHA256": self.context_sha,
            "RICKGENT_CONTEXT_OWNER_TOKEN": self.owner_token,
            "RICKGENT_CONTEXT_OWNER_TOKEN_SHA256": self.owner_sha,
            "RICKGENT_NONCE_CLAIM_PATH": str(self.claim_path.resolve()),
            "RICKGENT_LEASE_PATH": str(self.lease_path.resolve()),
            "RICKGENT_RECEIPT_PATH": str(self.receipt_path.resolve()),
            "RICKGENT_DISPATCH_ID": self.dispatch_id,
            "RICKGENT_RUN_ID": self.run_id,
            "RICKGENT_TICKET_ID": self.ticket_id,
            "RICKGENT_ATTEMPT": str(self.attempt),
            "RICKGENT_LIFECYCLE_PHASE": self.phase,
            "RICKGENT_ROLE": self.role,
            "RICKGENT_CALLER_REPO_REALPATH": str(self.target_repo.resolve()),
            "RICKGENT_WORKTREE_REALPATH": str(self.worktree.resolve()),
            "RICKGENT_BUNDLE_ROOT_REALPATH": str(self.bundle.resolve()),
            "RICKGENT_REQUESTED_BUNDLE_SHA256": self.requested_bundle_sha,
            "RICKGENT_REQUESTED_CONFIG_SHA256": self.requested_config_sha,
            "RICKGENT_INVOKED_BUNDLE_SHA256": self.invoked_bundle_sha,
            "RICKGENT_INVOKED_CONFIG_SHA256": self.invoked_config_sha,
        }

    def rewrite_context_and_bind(self) -> None:
        self.write_context()
        self.write_claim_and_lease()


@pytest.fixture
def attempt(tmp_path: Path) -> AttemptFixture:
    return AttemptFixture(tmp_path)


def _event() -> dict[str, Any]:
    return {
        "type": "tool_call",
        "target": "sys_os_write",
        "data": {
            "name": "sys_os_write",
            "arguments": {"path": "src/new.ts", "content": "ok"},
        },
        "context": {},
        "session_state": {},
        "llm_client": None,
    }


def _evaluate(
    fixture: AttemptFixture,
    *,
    event: dict[str, Any] | None = None,
) -> tuple[object, PolicyAction, int]:
    authenticator = FilesystemContextAuthenticator(fixture.environment)
    observed: list[object] = []
    tool_calls = 0

    def evaluator(native_event: object, config: object) -> dict[str, str]:
        outcome = adapt_native_policy_event(
            native_event,
            config,
            authenticator=authenticator,
        )
        observed.append(outcome)
        if isinstance(outcome, PolicyDenial):
            return {"result": "DENY", "reason": outcome.reason}
        return {"result": "ALLOW"}

    native_event = _event() if event is None else event
    policy = FunctionPolicy(
        FunctionPolicySpec(name="authenticated-context", on=None, config=fixture.config),
        evaluator,
    )
    context = EvaluationContext(
        phase=Phase.TOOL_CALL,
        content=native_event["data"],
        tool_name=native_event["target"],
        actor=native_event["context"].get("actor"),
        session_state=native_event["session_state"],
        llm_client=native_event["llm_client"],
    )
    result = asyncio.run(policy.evaluate(context, {}))
    if result.action is PolicyAction.ALLOW and isinstance(observed[0], CanonicalPolicyEvent):
        tool_calls += 1
    return observed[0], result.action, tool_calls


def _snapshot(outcome: CanonicalPolicyEvent) -> dict[str, Any]:
    return {
        "dispatch_id": outcome.dispatch_id,
        "run_id": outcome.run_id,
        "ticket_id": outcome.ticket_id,
        "attempt": outcome.attempt,
        "context_sha256": outcome.context_sha256,
        "ticket_contract_digest": outcome.ticket_contract_digest,
        "attempt_digest": outcome.attempt_digest,
        "role": outcome.role,
        "lifecycle_phase": outcome.lifecycle_phase,
        "target_repo_realpath": outcome.target_repo_realpath,
        "worktree_realpath": outcome.worktree_realpath,
        "state_root_realpath": outcome.state_root_realpath,
        "policy_root_realpath": outcome.policy_root_realpath,
        "bundle_root_realpath": outcome.bundle_root_realpath,
        "declared_scope": [asdict(entry) for entry in outcome.declared_scope],
        "requested_identity": asdict(outcome.requested_identity),
    }


def test_valid_context_is_lossless_immutable_and_repeatable(attempt: AttemptFixture):
    first, action, calls = _evaluate(attempt)
    second, second_action, second_calls = _evaluate(attempt)
    assert isinstance(first, CanonicalPolicyEvent)
    assert isinstance(second, CanonicalPolicyEvent)
    assert action is second_action is PolicyAction.ALLOW
    assert calls == second_calls == 1
    assert _snapshot(first) == _snapshot(second)
    assert first.declared_scope[0].from_path == "src/old.ts"
    assert first.declared_scope[1].directory is True
    with pytest.raises((AttributeError, TypeError)):
        first.declared_scope[0].path = "mutated"  # type: ignore[misc]


def test_agent_controlled_identity_copies_never_change_authority(attempt: AttemptFixture):
    baseline, _, _ = _evaluate(attempt)
    assert isinstance(baseline, CanonicalPolicyEvent)
    expected = _snapshot(baseline)
    fields = (
        "dispatch_id",
        "run_id",
        "ticket_id",
        "attempt",
        "role",
        "lifecycle_phase",
        "target_repo_realpath",
        "worktree_realpath",
        "state_root_realpath",
        "policy_root_realpath",
        "bundle_root_realpath",
        "context_sha256",
        "ticket_contract_digest",
        "attempt_digest",
        "owner_token_sha256",
        "nonce",
        "requested_identity",
    )
    for container_name in ("top", "data", "context", "session_state", "request_data"):
        for field in fields:
            event = _event()
            container = event if container_name == "top" else event.setdefault(container_name, {})
            container[field] = {"agent": "evil"}
            outcome = adapt_native_policy_event(
                event,
                attempt.config,
                authenticator=FilesystemContextAuthenticator(attempt.environment),
            )
            assert isinstance(outcome, CanonicalPolicyEvent), (container_name, field, outcome)
            assert _snapshot(outcome) == expected


Mutation = Callable[[AttemptFixture], None]


def _missing_reference(fixture: AttemptFixture) -> None:
    del fixture.environment["RICKGENT_CONTEXT_PATH"]


def _wrong_digest(fixture: AttemptFixture) -> None:
    fixture.config["context_sha256"] = "0" * 64


def _wrong_owner(fixture: AttemptFixture) -> None:
    fixture.environment["RICKGENT_CONTEXT_OWNER_TOKEN"] = "wrong-owner"


def _stale_attempt(fixture: AttemptFixture) -> None:
    fixture.environment["RICKGENT_ATTEMPT"] = "2"


def _unsupported_context(fixture: AttemptFixture) -> None:
    fixture.context["schema_version"] = "rickgent-attempt-context/v2"
    fixture.rewrite_context_and_bind()


def _closed_lease(fixture: AttemptFixture) -> None:
    fixture.lease["status"] = "closed"
    fixture.lease["closed_at_ms"] = int(time.time() * 1000)
    _private_file(fixture.lease_path, fixture.lease)


def _expired_lease(fixture: AttemptFixture) -> None:
    fixture.lease["expires_at_ms"] = 1
    _private_file(fixture.lease_path, fixture.lease)


def _foreign_nonce(fixture: AttemptFixture) -> None:
    fixture.claim["dispatch_id"] = "run-evil/t09/implement/1/worker"
    _private_file(fixture.claim_path, fixture.claim)


def _wrong_mode(fixture: AttemptFixture) -> None:
    fixture.context_path.chmod(0o644)


def _symlink_reference(fixture: AttemptFixture) -> None:
    real_context = fixture.policy / "real-context.json"
    fixture.context_path.rename(real_context)
    fixture.context_path.symlink_to(real_context)


def _duplicate_json(fixture: AttemptFixture) -> None:
    raw = fixture.context_path.read_bytes()
    fixture.write_context(raw[:-1] + b',"role":"worker"}')
    fixture.write_claim_and_lease()


def _unknown_context_field(fixture: AttemptFixture) -> None:
    fixture.context["agent_identity"] = "evil"
    fixture.rewrite_context_and_bind()


@pytest.mark.parametrize(
    ("mutation", "kind"),
    [
        (_missing_reference, DenialKind.CONTEXT_REFERENCE_UNTRUSTED),
        (_wrong_digest, DenialKind.CONTEXT_DIGEST_MISMATCH),
        (_wrong_owner, DenialKind.OWNER_TOKEN_MISMATCH),
        (_stale_attempt, DenialKind.DISPATCH_REPLAY),
        (_unsupported_context, DenialKind.CONTEXT_ABI_UNSUPPORTED),
        (_closed_lease, DenialKind.LEASE_CLOSED),
        (_expired_lease, DenialKind.LEASE_CLOSED),
        (_foreign_nonce, DenialKind.NONCE_REPLAY),
        (_wrong_mode, DenialKind.AUTHENTICATION_FAILED),
        (_symlink_reference, DenialKind.CONTEXT_REFERENCE_UNTRUSTED),
        (_duplicate_json, DenialKind.AUTHENTICATION_FAILED),
        (_unknown_context_field, DenialKind.AUTHENTICATION_FAILED),
    ],
    ids=lambda value: getattr(value, "__name__", str(value)),
)
def test_startup_denials_precede_tool_execution(
    attempt: AttemptFixture,
    mutation: Mutation,
    kind: DenialKind,
):
    mutation(attempt)
    outcome, action, calls = _evaluate(attempt)
    assert isinstance(outcome, PolicyDenial)
    assert outcome.denial_kind is kind
    assert action is PolicyAction.DENY
    assert calls == 0


@pytest.mark.parametrize(
    ("config_mutation", "kind"),
    [
        (lambda config: config.pop("context_path"), DenialKind.CONFIG_KEY_MISSING),
        (lambda config: config.__setitem__("scope", "[]"), DenialKind.CONFIG_KEY_UNKNOWN),
        (
            lambda config: config.__setitem__("rickgent_policy_abi", "future/v2"),
            DenialKind.POLICY_ABI_UNSUPPORTED,
        ),
    ],
)
def test_config_contract_denials_precede_filesystem_and_tool(
    attempt: AttemptFixture,
    config_mutation: Callable[[dict[str, str]], object],
    kind: DenialKind,
):
    config_mutation(attempt.config)
    outcome, action, calls = _evaluate(attempt)
    assert isinstance(outcome, PolicyDenial)
    assert outcome.denial_kind is kind
    assert action is PolicyAction.DENY
    assert calls == 0


def test_native_event_version_conflict_denies_after_authentication(attempt: AttemptFixture):
    event = _event()
    event["type"] = "tool_call/v2"
    outcome = adapt_native_policy_event(
        event,
        attempt.config,
        authenticator=FilesystemContextAuthenticator(attempt.environment),
    )
    assert isinstance(outcome, PolicyDenial)
    assert outcome.denial_kind is DenialKind.NATIVE_ABI_UNSUPPORTED


def test_t00_aliases_are_exact_and_unsupported_codex_rewrite_denies(attempt: AttemptFixture):
    attempt.context["requested_identity"]["canonical_harness"] = "codex-native"
    digest_base = {
        key: value
        for key, value in attempt.context.items()
        if key not in {
            "attempt_digest",
            "owner_token_sha256",
            "nonce",
            "nonce_claim_path",
            "lease_path",
            "receipt_path",
        }
    }
    attempt.context["attempt_digest"] = _sha(_canonical(digest_base))
    attempt.rewrite_context_and_bind()
    outcome, action, calls = _evaluate(attempt)
    assert isinstance(outcome, PolicyDenial)
    assert outcome.denial_kind is DenialKind.IDENTITY_CONFLICT
    assert action is PolicyAction.DENY and calls == 0
