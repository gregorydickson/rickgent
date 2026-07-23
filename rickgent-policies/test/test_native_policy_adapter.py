"""Complete native FunctionPolicy proof for the canonical Rickgent adapter."""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
from collections.abc import Iterator, Mapping
from dataclasses import FrozenInstanceError, asdict, replace
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest
from omnigent.policies import function as function_module
from omnigent.policies.function import FunctionPolicy
from omnigent.policies.types import EvaluationContext
from omnigent.runtime.policies.engine import _dispatch_policy
from omnigent.spec.types import FunctionPolicySpec, Phase, PolicyAction

from rickgent_policies.policy_event import (
    CONTEXT_SCHEMA_VERSION,
    IDENTITY_NORMALIZATION_VERSION,
    NATIVE_PHASES,
    POLICY_ABI_VERSION,
    TICKET_CONTRACT_SCHEMA_VERSION,
    AuthenticatedAttemptContext,
    CanonicalPolicyEvent,
    DenialKind,
    PolicyAbstention,
    PolicyDenial,
    RequestedModelIdentity,
    RuntimeProvenance,
    TicketScopeEntry,
    adapt_native_policy_event,
    make_policy_denial,
)

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "native-policy-corpus"
POLICY_ID = "canonical-native-adapter"
CONTEXT_SHA = "a" * 64
OWNER_SHA = "b" * 64
TICKET_SHA = "sha256:" + "c" * 64
ATTEMPT_SHA = "d" * 64
BUNDLE_SHA = "e" * 64
CONFIG_SHA = "f" * 64


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _loads_strict(text: str) -> Any:
    return json.loads(text, object_pairs_hook=_reject_duplicate_keys)


def _load_corpus() -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    manifest = _loads_strict((FIXTURE_ROOT / "manifest.json").read_text())
    cases = [
        _loads_strict(line)
        for line in (FIXTURE_ROOT / "events.jsonl").read_text().splitlines()
        if line.strip()
    ]
    expected = _loads_strict((FIXTURE_ROOT / "expected-verdicts.json").read_text())
    return manifest, cases, expected


MANIFEST, ALL_CASES, EXPECTED_DOCUMENT = _load_corpus()
CASES = [case for case in ALL_CASES if case["id"] in MANIFEST["events"]]


class _EntriesMapping(Mapping[str, str]):
    """Mapping facade whose ordered items retain duplicate fixture entries."""

    def __init__(self, entries: list[list[str]]) -> None:
        self._entries = tuple((key, value) for key, value in entries)
        self._lookup = dict(self._entries)

    def __getitem__(self, key: str) -> str:
        return self._lookup[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._lookup)

    def __len__(self) -> int:
        return len(self._lookup)

    def items(self):  # type: ignore[override]
        return self._entries


def _valid_config() -> dict[str, str]:
    return {
        "rickgent_policy_abi": POLICY_ABI_VERSION,
        "context_path": "/trusted/state/context.json",
        "context_sha256": CONTEXT_SHA,
        "context_owner_token_sha256": OWNER_SHA,
        "lease_path": "/trusted/state/lease.json",
        "receipt_path": "/trusted/state/receipt.json",
        "dispatch_id": "dispatch-001",
    }


def _config_for(case: Mapping[str, Any]) -> object:
    mode = case["config_case"]
    config: Any = _valid_config()
    if mode == "valid":
        return config
    if mode == "not_mapping":
        return ["not", "a", "mapping"]
    if mode == "missing_key":
        del config["dispatch_id"]
    elif mode == "non_string_key":
        config[7] = "not-a-string-key"
    elif mode == "structured_value":
        config["dispatch_id"] = {"value": "dispatch-001"}
    elif mode == "duplicate_entries":
        return _EntriesMapping(case["config_entries"])
    elif mode == "legacy_alias":
        config["ticket_id"] = "legacy-authority"
    elif mode == "unsupported_policy_abi":
        config["rickgent_policy_abi"] = "omnigent-function-policy/future-v2"
    elif mode == "uppercase_digest":
        config["context_sha256"] = CONTEXT_SHA.upper()
    elif mode == "relative_context_path":
        config["context_path"] = "relative/context.json"
    elif mode == "digest_conflict":
        config["context_sha256"] = "1" * 64
    elif mode == "owner_conflict":
        config["context_owner_token_sha256"] = "2" * 64
    elif mode == "dispatch_conflict":
        config["dispatch_id"] = "dispatch-002"
    elif mode == "context_path_conflict":
        config["context_path"] = "/trusted/state/other-context.json"
    elif mode == "lease_path_conflict":
        config["lease_path"] = "/trusted/state/other-lease.json"
    elif mode == "receipt_path_conflict":
        config["receipt_path"] = "/trusted/state/other-receipt.json"
    else:  # pragma: no cover - corpus validation rejects this first
        raise AssertionError(f"unknown config fixture mode {mode!r}")
    return config


def _identity() -> RequestedModelIdentity:
    return RequestedModelIdentity(
        normalization_version=IDENTITY_NORMALIZATION_VERSION,
        raw_harness="codex",
        canonical_harness="codex",
        raw_provider="openai",
        canonical_provider="openai",
        raw_vendor="openai",
        canonical_vendor="openai",
        raw_model_id="gpt-5",
        canonical_model_id="gpt-5",
        bundle_digest=BUNDLE_SHA,
        config_digest=CONFIG_SHA,
        profile="effective-session-v1",
    )


def _trusted_context() -> AuthenticatedAttemptContext:
    return AuthenticatedAttemptContext(
        schema_version=CONTEXT_SCHEMA_VERSION,
        policy_abi_version=POLICY_ABI_VERSION,
        authenticated=True,
        context_path="/trusted/state/context.json",
        context_sha256=CONTEXT_SHA,
        owner_token_sha256=OWNER_SHA,
        lease_path="/trusted/state/lease.json",
        receipt_path="/trusted/state/receipt.json",
        dispatch_id="dispatch-001",
        run_id="run-001",
        ticket_id="t08",
        attempt=1,
        target_repo_realpath="/repo",
        worktree_realpath="/repo/worktree",
        state_root_realpath="/trusted/state",
        policy_root_realpath="/trusted/state/policy-attempts/dispatch-001",
        bundle_root_realpath="/trusted/state/policy-attempts/dispatch-001/bundle/agents/rickgent/agents/worker",
        role="worker",
        lifecycle_phase="implement",
        ticket_contract_schema_version=TICKET_CONTRACT_SCHEMA_VERSION,
        ticket_contract_digest=TICKET_SHA,
        attempt_digest=ATTEMPT_SHA,
        declared_scope=(
            TicketScopeEntry(
                path="rickgent-policies",
                change_kind="modify",
                directory=True,
            ),
        ),
        requested_identity=_identity(),
        runtime_provenance=RuntimeProvenance(
            schema_version="rickgent-runtime-provenance/v2",
            omnigent_python_entrypoint="/runtime/venv/bin/python",
            omnigent_python_realpath="/runtime/python",
            omnigent_python_sha256="c" * 64,
            omnigent_root_realpath="/runtime/omnigent",
            omnigent_origin_realpath="/runtime/omnigent/omnigent/__init__.py",
            rickgent_policies_origin_realpath="/runtime/policies/rickgent_policies/__init__.py",
            rickgent_policies_sha256="d" * 64,
            rickgent_node_realpath="/runtime/node",
            rickgent_node_sha256="e" * 64,
            rickgent_cli_realpath="/runtime/rickgent",
            rickgent_cli_sha256="f" * 64,
            rickgent_build_commit="commit-001",
        ),
        nonce="nonce-001",
        lease_active=True,
        replayed=False,
    )


class _FixtureAuthenticator:
    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.received_config: Mapping[str, str] | None = None

    def authenticate(
        self, config: Mapping[str, str]
    ) -> AuthenticatedAttemptContext | PolicyDenial:
        self.received_config = config
        if self.mode == "raises":
            raise RuntimeError("fixture authentication failure")
        if self.mode == "untrusted_context":
            return make_policy_denial(
                DenialKind.CONTEXT_REFERENCE_UNTRUSTED,
                "context fixture is outside the trusted state root",
            )

        trusted = _trusted_context()
        if self.mode == "valid":
            return trusted
        if self.mode == "unauthenticated":
            return replace(trusted, authenticated=False)
        if self.mode == "unsupported_context_abi":
            return replace(trusted, schema_version="rickgent-attempt-context/v2")
        if self.mode in {"lease_closed", "lease_expired"}:
            return replace(trusted, lease_active=False)
        if self.mode == "replayed":
            return replace(trusted, replayed=True)
        if self.mode == "identity_missing":
            return replace(trusted, requested_identity=None)
        if self.mode == "identity_conflict":
            return replace(trusted, requested_identity=replace(_identity(), conflict=True))
        if self.mode == "profile_unavailable":
            return replace(
                trusted,
                requested_identity=replace(_identity(), profile_available=False),
            )
        raise AssertionError(f"unknown authenticator fixture mode {self.mode!r}")


def _authenticator_for(case: Mapping[str, Any]) -> _FixtureAuthenticator | None:
    mode = case["auth_case"]
    if mode == "missing":
        return None
    return _FixtureAuthenticator(mode)


def _validate_corpus(
    manifest: Mapping[str, Any],
    cases: list[Mapping[str, Any]],
    expected_document: Mapping[str, Any],
) -> None:
    assert manifest["schema_version"] == "rickgent-native-policy-corpus/v3"
    assert manifest["complete"] is True
    assert manifest["expected_verdict_matrix"]["cartesian_complete"] is True

    manifest_events = manifest["events"]
    manifest_policies = manifest["policies"]
    assert len(manifest_events) == len(set(manifest_events))
    assert len(manifest_policies) == len(set(manifest_policies))

    case_ids = [case["id"] for case in cases]
    assert len(case_ids) == len(set(case_ids))
    assert set(manifest_events) <= set(case_ids)
    assert all(
        {"id", "event", "config_case", "auth_case", "execution_mode"}
        <= case.keys()
        for case in cases
    )
    adapter_cases = [case for case in cases if case["id"] in manifest_events]
    assert {case["execution_mode"] for case in adapter_cases} == {"native", "direct"}

    assert set(manifest["native_phases"]) == set(NATIVE_PHASES)
    assert set(manifest["denial_kinds"]) == {kind.value for kind in DenialKind}
    assert set(manifest["structured_tools"]) == {
        "sys_os_read",
        "sys_os_write",
        "sys_os_edit",
    }

    expectations = expected_document["expectations"]
    required_assertions = set(
        manifest["expected_verdict_matrix"]["required_assertions"]
    )
    required_record_keys = {"policy_id", "event_id"} | required_assertions
    assert all(set(record) == required_record_keys for record in expectations)

    pairs = [(record["policy_id"], record["event_id"]) for record in expectations]
    assert len(pairs) == len(set(pairs))
    expected_pairs = {
        (policy_id, event_id)
        for policy_id in manifest_policies
        for event_id in manifest_events
    }
    assert set(pairs) == expected_pairs
    assert {record["event_id"] for record in expectations} == set(manifest_events)
    assert {record["policy_id"] for record in expectations} == set(manifest_policies)

    denied = [record for record in expectations if record["adapter_result"] == "deny"]
    assert {record["denial_kind"] for record in denied} == set(
        manifest["denial_kinds"]
    )
    assert all(record["native_result"] == "DENY" for record in denied)
    assert all(record["reason_code"] for record in denied)
    assert all(record["tool_executed"] is False for record in denied)

    canonical = [
        record for record in expectations if record["adapter_result"] == "canonical"
    ]
    assert all(isinstance(record["canonical_snapshot"], dict) for record in canonical)
    assert {
        record["canonical_snapshot"]["tool"] for record in canonical
    } == set(manifest["structured_tools"]) | {"sys_os_shell"}
    assert all(
        record["canonical_snapshot"] is None
        for record in expectations
        if record["adapter_result"] != "canonical"
    )


def _expectation_by_event() -> dict[str, dict[str, Any]]:
    return {
        record["event_id"]: record
        for record in EXPECTED_DOCUMENT["expectations"]
        if record["policy_id"] == POLICY_ID
    }


EXPECTATIONS = _expectation_by_event()


def _evaluation_context(event: Mapping[str, Any]) -> EvaluationContext:
    context = event["context"]
    return EvaluationContext(
        phase=Phase(event["type"]),
        content=event["data"],
        tool_name=event["target"],
        actor=context.get("actor") if isinstance(context, Mapping) else None,
        request_data=event.get("request_data"),
        session_state=event["session_state"],
        usage=context.get("usage") if isinstance(context, Mapping) else None,
        model=context.get("model") if isinstance(context, Mapping) else None,
        harness=context.get("harness") if isinstance(context, Mapping) else None,
        labels=context.get("labels") if isinstance(context, Mapping) else None,
        llm_client=event["llm_client"],
    )


def _native_mapping(outcome: object) -> dict[str, str | None]:
    if isinstance(outcome, PolicyDenial):
        return {"result": "DENY", "reason": outcome.reason}
    return {"result": "ALLOW", "reason": None}


class _SentinelTool:
    def __init__(self) -> None:
        self.calls: list[Mapping[str, Any]] = []

    def invoke(self, arguments: Mapping[str, Any]) -> None:
        self.calls.append(arguments)


def _run_case(case: Mapping[str, Any]) -> tuple[object, str, str | None, int]:
    config = _config_for(case)
    authenticator = _authenticator_for(case)
    sentinel = _SentinelTool()

    if case["execution_mode"] == "native":
        captured: list[object] = []

        def evaluator(event: Mapping[str, Any], native_config: object):
            outcome = adapt_native_policy_event(
                event,
                native_config,
                authenticator=authenticator,
            )
            captured.append(outcome)
            return _native_mapping(outcome)

        policy = FunctionPolicy(
            FunctionPolicySpec(name=POLICY_ID, on=None, config=config),  # type: ignore[arg-type]
            evaluator,
        )
        result = asyncio.run(policy.evaluate(_evaluation_context(case["event"]), {}))
        assert len(captured) == 1
        outcome = captured[0]
        native_result = result.action.name
        reason = result.reason
    else:
        outcome = adapt_native_policy_event(
            case["event"],
            config,
            authenticator=authenticator,
        )
        translated = _native_mapping(outcome)
        native_result = translated["result"]
        reason = translated["reason"]

    if (
        native_result == "ALLOW"
        and isinstance(outcome, CanonicalPolicyEvent)
        and outcome.native_phase == "tool_call"
    ):
        sentinel.invoke(outcome.arguments)
    return outcome, native_result, reason, len(sentinel.calls)


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(nested) for key, nested in value.items()}
    if isinstance(value, tuple):
        return [_thaw(nested) for nested in value]
    return value


def _canonical_snapshot(outcome: CanonicalPolicyEvent) -> dict[str, Any]:
    return {
        "native_phase": outcome.native_phase,
        "tool": outcome.tool,
        "action": outcome.action,
        "arguments": _thaw(outcome.arguments),
        "source_endpoint": outcome.source_endpoint,
        "destination_endpoint": outcome.destination_endpoint,
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
        "declared_scope": [
            {key: value for key, value in asdict(entry).items() if value is not None}
            for entry in outcome.declared_scope
        ],
        "requested_identity": asdict(outcome.requested_identity),
    }


def test_function_policy_import_is_bound_to_mounted_root():
    root_value = os.environ.get("OMNIGENT_ROOT")
    assert root_value, "OMNIGENT_ROOT is a required, non-skipping preflight"
    root = Path(root_value).resolve(strict=True)
    origin = Path(inspect.getfile(function_module)).resolve(strict=True)
    assert origin.is_relative_to(root), f"FunctionPolicy shadow import: {origin}"


def test_native_policy_corpus_inventory_is_cartesian_and_complete():
    _validate_corpus(MANIFEST, CASES, EXPECTED_DOCUMENT)


def test_corpus_loader_rejects_duplicate_json_object_keys():
    with pytest.raises(ValueError, match="duplicate JSON key"):
        _loads_strict('{"id":"first","id":"second"}')


def test_corpus_validator_rejects_missing_inventory_entries():
    mutations = []

    missing_event = copy.deepcopy((MANIFEST, CASES, EXPECTED_DOCUMENT))
    missing_event[0]["events"].pop()
    mutations.append(missing_event)

    missing_verdict = copy.deepcopy((MANIFEST, CASES, EXPECTED_DOCUMENT))
    missing_verdict[2]["expectations"].pop()
    mutations.append(missing_verdict)

    missing_policy = copy.deepcopy((MANIFEST, CASES, EXPECTED_DOCUMENT))
    missing_policy[0]["policies"].pop()
    mutations.append(missing_policy)

    missing_phase = copy.deepcopy((MANIFEST, CASES, EXPECTED_DOCUMENT))
    missing_phase[0]["native_phases"].pop()
    mutations.append(missing_phase)

    missing_execution_assertion = copy.deepcopy((MANIFEST, CASES, EXPECTED_DOCUMENT))
    del missing_execution_assertion[2]["expectations"][0]["tool_executed"]
    mutations.append(missing_execution_assertion)

    for manifest, cases, expected in mutations:
        with pytest.raises(AssertionError):
            _validate_corpus(manifest, cases, expected)


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_complete_native_policy_corpus(case: Mapping[str, Any]):
    expected = EXPECTATIONS[case["id"]]
    outcome, native_result, reason, invocation_count = _run_case(case)

    assert outcome.disposition == expected["adapter_result"]
    assert native_result == expected["native_result"]
    assert invocation_count == int(expected["tool_executed"])

    if isinstance(outcome, PolicyDenial):
        assert outcome.denial_kind.value == expected["denial_kind"]
        assert outcome.code.value == expected["reason_code"]
        assert reason is not None and reason.startswith(f'{expected["reason_code"]}: ')
    else:
        assert reason is None

    if isinstance(outcome, CanonicalPolicyEvent):
        expected_snapshot = {
            **expected["canonical_snapshot"],
            **EXPECTED_DOCUMENT["canonical_authority"],
        }
        assert _canonical_snapshot(outcome) == expected_snapshot
        with pytest.raises(TypeError):
            outcome.arguments["path"] = "mutated"  # type: ignore[index]
        with pytest.raises(FrozenInstanceError):
            outcome.ticket_id = "mutated"  # type: ignore[misc]
        with pytest.raises(FrozenInstanceError):
            outcome.requested_identity.raw_model_id = "mutated"  # type: ignore[misc]
        if case["id"] == "valid_edit_call":
            assert isinstance(outcome.arguments["edits"], tuple)
            assert isinstance(outcome.arguments["edits"][0], MappingProxyType)
    elif isinstance(outcome, PolicyAbstention):
        assert outcome.native_phase in NATIVE_PHASES


def test_native_argument_mapping_is_consumed_once_and_never_json_reparsed():
    class CountingArguments(Mapping[str, object]):
        def __init__(self) -> None:
            self.items_calls = 0
            self._values = {"path": "src/once.py", "content": "{\"path\":\"evil\"}"}

        def __getitem__(self, key: str) -> object:
            return self._values[key]

        def __iter__(self) -> Iterator[str]:
            return iter(self._values)

        def __len__(self) -> int:
            return len(self._values)

        def items(self):  # type: ignore[override]
            self.items_calls += 1
            return self._values.items()

    arguments = CountingArguments()
    event = {
        "type": "tool_call",
        "target": "sys_os_write",
        "data": {"name": "sys_os_write", "arguments": arguments},
        "context": {},
        "session_state": {},
        "llm_client": None,
    }
    outcome = adapt_native_policy_event(
        event,
        _valid_config(),
        authenticator=_FixtureAuthenticator("valid"),
    )
    assert isinstance(outcome, CanonicalPolicyEvent)
    assert arguments.items_calls == 1
    assert outcome.source_endpoint == "src/once.py"
    assert outcome.arguments["content"] == '{"path":"evil"}'


def test_authenticator_receives_read_only_reference_config():
    authenticator = _FixtureAuthenticator("valid")
    case = next(case for case in CASES if case["id"] == "valid_read_call")
    outcome = adapt_native_policy_event(
        case["event"],
        _valid_config(),
        authenticator=authenticator,
    )
    assert isinstance(outcome, CanonicalPolicyEvent)
    assert isinstance(authenticator.received_config, MappingProxyType)
    with pytest.raises(TypeError):
        authenticator.received_config["dispatch_id"] = "mutated"  # type: ignore[index]


@pytest.mark.parametrize(
    ("trusted", "denial_kind"),
    [
        (
            replace(_trusted_context(), authenticated=1),
            DenialKind.AUTHENTICATION_FAILED,
        ),
        (replace(_trusted_context(), lease_active=1), DenialKind.AUTHENTICATION_FAILED),
        (replace(_trusted_context(), replayed=0), DenialKind.AUTHENTICATION_FAILED),
        (
            replace(
                _trusted_context(),
                requested_identity=replace(_identity(), conflict=0),
            ),
            DenialKind.IDENTITY_CONFLICT,
        ),
        (
            replace(
                _trusted_context(),
                requested_identity=replace(_identity(), profile_available=1),
            ),
            DenialKind.IDENTITY_CONFLICT,
        ),
    ],
    ids=[
        "authenticated-integer",
        "lease-active-integer",
        "replayed-integer",
        "identity-conflict-integer",
        "profile-available-integer",
    ],
)
def test_trusted_projection_requires_exact_boolean_flags(
    trusted: AuthenticatedAttemptContext,
    denial_kind: DenialKind,
):
    class StaticAuthenticator:
        def authenticate(
            self, _config: Mapping[str, str]
        ) -> AuthenticatedAttemptContext:
            return trusted

    outcome = adapt_native_policy_event(
        next(case for case in CASES if case["id"] == "valid_write_call")["event"],
        _valid_config(),
        authenticator=StaticAuthenticator(),
    )
    assert isinstance(outcome, PolicyDenial)
    assert outcome.denial_kind is denial_kind


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_native_arguments_reject_non_finite_json_numbers(value: float):
    event = {
        "type": "tool_call",
        "target": "sys_os_write",
        "data": {
            "name": "sys_os_write",
            "arguments": {"path": "src/non-finite.py", "value": value},
        },
        "context": {},
        "session_state": {},
        "llm_client": None,
    }
    outcome = adapt_native_policy_event(
        event,
        _valid_config(),
        authenticator=_FixtureAuthenticator("valid"),
    )
    assert isinstance(outcome, PolicyDenial)
    assert outcome.denial_kind is DenialKind.ARGUMENTS_MALFORMED


def test_trusted_projection_rejects_noncanonical_roots_and_blank_dispatch():
    class StaticAuthenticator:
        def authenticate(
            self, _config: Mapping[str, str]
        ) -> AuthenticatedAttemptContext:
            return replace(_trusted_context(), worktree_realpath="/repo/../worktree")

    event = next(case for case in CASES if case["id"] == "valid_read_call")["event"]
    root_outcome = adapt_native_policy_event(
        event,
        _valid_config(),
        authenticator=StaticAuthenticator(),
    )
    assert isinstance(root_outcome, PolicyDenial)
    assert root_outcome.denial_kind is DenialKind.AUTHENTICATION_FAILED

    config = _valid_config()
    config["dispatch_id"] = "   "
    config_outcome = adapt_native_policy_event(
        event,
        config,
        authenticator=_FixtureAuthenticator("valid"),
    )
    assert isinstance(config_outcome, PolicyDenial)
    assert config_outcome.denial_kind is DenialKind.CONFIG_MALFORMED


def test_public_adapter_converts_hostile_config_and_projection_to_named_denials():
    class MalformedItemsMapping(Mapping[str, str]):
        def __getitem__(self, key: str) -> str:
            raise KeyError(key)

        def __iter__(self) -> Iterator[str]:
            return iter(())

        def __len__(self) -> int:
            return 0

        def items(self):  # type: ignore[override]
            return [("not-a-pair",)]

    config_outcome = adapt_native_policy_event(
        {},
        MalformedItemsMapping(),
        authenticator=_FixtureAuthenticator("valid"),
    )
    assert isinstance(config_outcome, PolicyDenial)
    assert config_outcome.denial_kind is DenialKind.CONFIG_MALFORMED

    class MalformedProjectionAuthenticator:
        def authenticate(self, _config: Mapping[str, str]) -> AuthenticatedAttemptContext:
            return replace(_trusted_context(), requested_identity=object())

    event = next(case for case in CASES if case["id"] == "valid_read_call")["event"]
    projection_outcome = adapt_native_policy_event(
        event,
        _valid_config(),
        authenticator=MalformedProjectionAuthenticator(),
    )
    assert isinstance(projection_outcome, PolicyDenial)
    assert projection_outcome.denial_kind is DenialKind.IDENTITY_MISSING


def test_omnigent_engine_converts_adapter_wrapper_failures_to_deny_before_tool():
    sentinel = _SentinelTool()
    ctx = EvaluationContext(
        phase=Phase.TOOL_CALL,
        content={"name": "sys_os_write", "arguments": {"path": "src/x.py"}},
        tool_name="sys_os_write",
    )

    def explode(_event: object, _config: object):
        raise RuntimeError("adapter wrapper exploded")

    def malformed(_event: object, _config: object):
        return {"reason": "missing result"}

    async def verify() -> None:
        for name, evaluator in (("explode", explode), ("malformed", malformed)):
            policy = FunctionPolicy(
                FunctionPolicySpec(name=name, on=None, config=_valid_config()),
                evaluator,
            )
            result = await _dispatch_policy(policy, ctx, {})
            assert result.action is PolicyAction.DENY
            assert result.reason
            assert not sentinel.calls

    asyncio.run(verify())
