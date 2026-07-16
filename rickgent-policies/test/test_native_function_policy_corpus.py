"""Complete attached-policy corpus through real Omnigent FunctionPolicy.

This is the M2 cutover proof.  It expands the versioned fixture into the full
policy/event matrix for both configured bundles, evaluates every individual
FunctionPolicy, and evaluates the ordered bundle through Omnigent's
PolicyEngine. Delivery sequences are intentionally absent while shell is an
unavailable capability at the scope boundary.
"""

from __future__ import annotations

import asyncio
import ast
import copy
import inspect
import json
import os
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import yaml
from omnigent.policies.function import FunctionPolicy, resolve_function_policy
from omnigent.policies.types import EvaluationContext
from omnigent.runtime.policies.engine import PolicyEngine
from omnigent.spec.parser import parse
from omnigent.spec.types import Phase, PolicyAction
from omnigent.tools.manager import ToolManager
from omnigent.tools.base import ToolContext

from rickgent_policies import (
    ATTACHED_POLICY_ROWS,
    REQUIRED_POLICY_NAMES,
    effective_attached_policies,
    validate_attached_policy_bundle,
)
from rickgent_policies.policy_event import (
    FILESYSTEM_TOOL_ACTIONS,
    KNOWN_NATIVE_TOOLS,
    LIFECYCLE_TOOL_ACTIONS,
    SHELL_TOOLS,
    UNRELATED_NATIVE_TOOLS,
)

from .test_native_policy_context import AttemptFixture, _canonical, _sha


REPO_ROOT = Path(__file__).parent.parent.parent
FIXTURES = Path(__file__).parent / "fixtures" / "native-policy-corpus"
MANAGER_DIR = REPO_ROOT / "agents" / "rickgent"
WORKER_DIR = MANAGER_DIR / "agents" / "worker"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())
EXPECTED = json.loads((FIXTURES / "expected-verdicts.json").read_text())
EVENT_ROWS = [
    json.loads(line)
    for line in (FIXTURES / "events.jsonl").read_text().splitlines()
    if line.strip()
]
EVENTS = {row["id"]: row for row in EVENT_ROWS}
CONTRACT = MANIFEST["function_policy_contract"]
VERDICTS = EXPECTED["function_policy_contract"]

_FUNCTION_POLICY_EVENT_IDS = (
    "manager_session_send",
    "manager_read_inbox",
    "manager_session_list",
    "manager_session_get_info",
    "manager_session_close",
    "manager_advise_models",
    "manager_list_models",
    "worker_read",
    "worker_write",
    "worker_edit",
    "false_completion",
    "completion_missing_commit",
    "completion_missing_evidence",
    "convergence_bypass",
    "convergence_green",
    "simplification_bypass",
    "simplification_valid",
    "review_equality",
    "review_vendor_spoof",
    "phase_advance_positive",
    "protected_push",
    "force_push",
    "raw_shell_bypass",
    "pr_before_push",
    "delivery_push_call",
    "delivery_push_result",
    "delivery_failed_push_result",
    "delivery_mismatched_push_result",
    "delivery_pr_call",
)
_SEQUENCE_STEPS: dict[str, tuple[str, ...]] = {}
_INDIVIDUAL_ASSERTIONS = (
    "handler_result",
    "native_result",
    "reason_prefix",
    "tool_executed",
)
_BUNDLE_ASSERTIONS = (
    "native_result",
    "reason_prefix",
    "deciding_policies",
    "ask_state",
    "tool_executed",
)

_ATTEMPT_DIGEST_EXCLUDED = {
    "attempt_digest",
    "owner_token_sha256",
    "nonce",
    "nonce_claim_path",
    "lease_path",
    "receipt_path",
}


class _EmptyStore:
    """Minimum read-only ConversationStore surface used by PolicyEngine."""

    def list_items(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(data=[])


class _ObservedTool:
    """Call-counting tool used to observe policy-controlled dispatch."""

    def __init__(self) -> None:
        self.calls: list[Mapping[str, Any]] = []

    def invoke(self, event: Mapping[str, Any]) -> None:
        self.calls.append(event)


def _dispatch_observed(
    tool: _ObservedTool,
    action: str,
    event: Mapping[str, Any],
    approved_ask: bool,
) -> None:
    if event["type"] == "tool_call" and (
        action == "ALLOW" or (action == "ASK" and approved_ask)
    ):
        tool.invoke(event)


def _attempt(root: Path, *, phase: str = "implement") -> AttemptFixture:
    root.mkdir(mode=0o700)
    return AttemptFixture(root, phase=phase)


def _git(worktree: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(worktree), *arguments],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _bind_attempt(attempt: AttemptFixture) -> str:
    """Create the authenticated run branch and exact corpus scope."""

    _git(attempt.worktree, "init", "-q")
    _git(attempt.worktree, "config", "user.email", "corpus@example.invalid")
    _git(attempt.worktree, "config", "user.name", "Native Policy Corpus")
    (attempt.worktree / "test").mkdir()
    (attempt.worktree / "test" / "existing.txt").write_text("old\n")
    _git(attempt.worktree, "add", "test/existing.txt")
    _git(attempt.worktree, "commit", "-qm", "fixture")
    branch = f"rickgent/runs/{attempt.run_id}"
    _git(attempt.worktree, "checkout", "-qb", branch)

    attempt.context["declared_scope"] = [
        {"path": "test", "change_kind": "modify", "directory": True}
    ]
    digest_base = {
        key: value
        for key, value in attempt.context.items()
        if key not in _ATTEMPT_DIGEST_EXCLUDED
    }
    attempt.context["attempt_digest"] = _sha(_canonical(digest_base))
    attempt.rewrite_context_and_bind()
    return _git(attempt.worktree, "rev-parse", "HEAD^{commit}")


def _replace_tokens(value: Any, *, attempt: AttemptFixture, head: str) -> Any:
    if isinstance(value, str):
        return (
            value.replace("$HEAD", head)
            .replace("$RUN_BRANCH", f"rickgent/runs/{attempt.run_id}")
            .replace("$WORKTREE", str(attempt.worktree.resolve()))
        )
    if isinstance(value, list):
        return [_replace_tokens(child, attempt=attempt, head=head) for child in value]
    if isinstance(value, dict):
        return {
            key: _replace_tokens(child, attempt=attempt, head=head)
            for key, child in value.items()
        }
    return value


def _context(event: Mapping[str, Any]) -> EvaluationContext:
    return EvaluationContext(
        phase=Phase(event["type"]),
        content=event["data"],
        tool_name=event["target"],
        actor=event["context"].get("actor"),
        request_data=event.get("request_data"),
        session_state=event["session_state"],
        llm_client=event["llm_client"],
    )


def _materialized_bundle(
    source: Path,
    destination: Path,
    config: Mapping[str, str],
) -> Path:
    shutil.copytree(source, destination)
    config_path = destination / "config.yaml"
    document = yaml.safe_load(config_path.read_text())
    policies = document["guardrails"]["policies"]
    for row in ATTACHED_POLICY_ROWS:
        if row.rickgent:
            policies[row.name]["config"] = dict(config)
    config_path.write_text(yaml.safe_dump(document, sort_keys=False))
    return destination


def _fresh(policies: tuple[FunctionPolicy, ...]) -> tuple[FunctionPolicy, ...]:
    return tuple(resolve_function_policy(policy.spec) for policy in policies)


def _raw_result(raw: object) -> tuple[str, str | None]:
    if raw is None:
        return "ABSTAIN", None
    assert isinstance(raw, Mapping), f"handler returned a non-mapping verdict: {raw!r}"
    result = raw.get("result")
    reason = raw.get("reason")
    assert isinstance(result, str)
    assert reason is None or isinstance(reason, str)
    return result.upper(), reason


def _reason_prefix(reason: str | None, expected: str | None) -> None:
    if expected is None:
        assert reason is None
    else:
        assert reason is not None and reason.startswith(expected), reason


def _individual_expectation(
    evaluator: str,
    event_contract: Mapping[str, Any],
) -> dict[str, Any]:
    defaults = VERDICTS["individual_defaults"][evaluator]
    overrides = event_contract["individual_overrides"].get(evaluator, {})
    assert set(overrides) <= set(CONTRACT["required_individual_assertions"])
    resolved = {**defaults, **overrides}
    resolved.setdefault("tool_executed", event_contract["tool_executed_default"])
    assert set(resolved) == set(CONTRACT["required_individual_assertions"])
    return resolved


def _bundle_expectation(
    evaluator: str,
    event_contract: Mapping[str, Any],
) -> dict[str, Any]:
    overrides = event_contract["bundle_overrides"].get(evaluator, {})
    assert set(overrides) <= set(CONTRACT["required_bundle_assertions"])
    resolved = {**event_contract["bundle_default"], **overrides}
    assert set(resolved) == set(CONTRACT["required_bundle_assertions"])
    return resolved


def _validate_function_policy_corpus(
    manifest: Mapping[str, Any],
    event_rows: list[Mapping[str, Any]],
    expected: Mapping[str, Any],
) -> None:
    assert manifest["schema_version"] == "rickgent-native-policy-corpus/v3"
    assert manifest["complete"] is True
    contract = manifest["function_policy_contract"]
    verdicts = expected["function_policy_contract"]
    assert contract["schema_version"] == "rickgent-native-function-policy-corpus/v1"
    assert verdicts["schema_version"] == "rickgent-native-function-policy-verdicts/v1"

    attachment_rows = [
        {
            "name": row.name,
            "path": row.path,
            "form": "factory" if row.arguments is not None else "direct",
            "arguments": None if row.arguments is None else dict(row.arguments),
            "config": "attempt" if row.rickgent else "none",
        }
        for row in ATTACHED_POLICY_ROWS
    ]
    assert contract["attachments"] == attachment_rows

    bundle_names = tuple(contract["bundles"])
    assert bundle_names == ("manager", "worker")
    expected_individual = tuple(
        f"{bundle}/{name}" for bundle in bundle_names for name in REQUIRED_POLICY_NAMES
    )
    expected_bundles = tuple(f"{bundle}/bundle" for bundle in bundle_names)
    assert tuple(contract["individual_evaluators"]) == expected_individual
    assert set(verdicts["individual_defaults"]) == set(expected_individual)
    assert tuple(contract["bundle_evaluators"]) == expected_bundles
    assert tuple(contract["required_individual_assertions"]) == _INDIVIDUAL_ASSERTIONS
    assert tuple(contract["required_bundle_assertions"]) == _BUNDLE_ASSERTIONS
    for evaluator in expected_individual:
        assert set(verdicts["individual_defaults"][evaluator]) == {
            "handler_result",
            "native_result",
            "reason_prefix",
        }

    assert tuple(contract["event_ids"]) == _FUNCTION_POLICY_EVENT_IDS
    ids = [row["id"] for row in event_rows]
    assert len(ids) == len(set(ids))
    assert set(ids) == set(manifest["events"]) | set(_FUNCTION_POLICY_EVENT_IDS)
    assert not (set(manifest["events"]) & set(_FUNCTION_POLICY_EVENT_IDS))

    verdict_events = verdicts["events"]
    assert tuple(row["event_id"] for row in verdict_events) == _FUNCTION_POLICY_EVENT_IDS
    for event_contract in verdict_events:
        assert set(event_contract) == {
            "event_id",
            "tool_executed_default",
            "individual_overrides",
            "bundle_default",
            "bundle_overrides",
        }
        assert isinstance(event_contract["tool_executed_default"], bool)
        assert set(event_contract["individual_overrides"]) <= set(expected_individual)
        assert set(event_contract["bundle_overrides"]) <= set(expected_bundles)
        for evaluator in expected_individual:
            defaults = verdicts["individual_defaults"][evaluator]
            overrides = event_contract["individual_overrides"].get(evaluator, {})
            assert set(overrides) <= set(_INDIVIDUAL_ASSERTIONS)
            resolved = {**defaults, **overrides}
            resolved.setdefault("tool_executed", event_contract["tool_executed_default"])
            assert set(resolved) == set(_INDIVIDUAL_ASSERTIONS)
        for evaluator in expected_bundles:
            overrides = event_contract["bundle_overrides"].get(evaluator, {})
            assert set(overrides) <= set(_BUNDLE_ASSERTIONS)
            assert set({**event_contract["bundle_default"], **overrides}) == set(
                _BUNDLE_ASSERTIONS
            )

    assert tuple(contract["sequence_ids"]) == tuple(_SEQUENCE_STEPS)
    sequences = verdicts["sequences"]
    assert tuple(row["sequence_id"] for row in sequences) == tuple(_SEQUENCE_STEPS)
    known_events = set(ids)
    for sequence in sequences:
        assert tuple(step["event_id"] for step in sequence["steps"]) == _SEQUENCE_STEPS[
            sequence["sequence_id"]
        ]
        for step in sequence["steps"]:
            assert step["event_id"] in known_events
            assert set(step) == {"event_id", "bundle_default", "bundle_overrides"}
            for evaluator in expected_bundles:
                overrides = step["bundle_overrides"].get(evaluator, {})
                assert set(overrides) <= set(_BUNDLE_ASSERTIONS)
                assert set({**step["bundle_default"], **overrides}) == set(
                    _BUNDLE_ASSERTIONS
                )


def _engine(policies: tuple[FunctionPolicy, ...]) -> PolicyEngine:
    return PolicyEngine(
        policies=list(policies),
        label_defs={},
        ask_timeout=86_400,
        conversation_id="native-policy-corpus",
        initial_labels={},
        conversation_store=_EmptyStore(),  # type: ignore[arg-type]
    )


async def _evaluate_individual(
    policies: tuple[FunctionPolicy, ...],
    event: Mapping[str, Any],
    bundle: str,
    event_contract: Mapping[str, Any],
    approved_ask: bool,
) -> None:
    context = _context(event)
    handlers = _fresh(policies)
    natives = _fresh(policies)
    for handler_policy, native_policy in zip(handlers, natives, strict=True):
        evaluator = f"{bundle}/{handler_policy.spec.name}"
        expected = _individual_expectation(evaluator, event_contract)

        raw = await handler_policy._call(context)  # type: ignore[attr-defined]
        handler_result, handler_reason = _raw_result(raw)
        native = await native_policy.evaluate(context, {})
        assert handler_result == expected["handler_result"], handler_reason
        assert native.action.name == expected["native_result"], native.reason
        _reason_prefix(handler_reason, expected["reason_prefix"])
        _reason_prefix(native.reason, expected["reason_prefix"])
        observed = _ObservedTool()
        _dispatch_observed(observed, native.action.name, event, approved_ask)
        assert len(observed.calls) == int(expected["tool_executed"])


async def _evaluate_bundle(
    policies: tuple[FunctionPolicy, ...],
    event: Mapping[str, Any],
    bundle: str,
    event_contract: Mapping[str, Any],
    approved_ask: bool,
) -> None:
    expected = _bundle_expectation(f"{bundle}/bundle", event_contract)
    result = await _engine(_fresh(policies)).evaluate(_context(event), read_only=True)
    assert result.action.name == expected["native_result"]
    _reason_prefix(result.reason, expected["reason_prefix"])
    assert (result.deciding_policies or []) == expected["deciding_policies"]
    assert (result.action is PolicyAction.ASK) is expected["ask_state"]
    observed = _ObservedTool()
    _dispatch_observed(observed, result.action.name, event, approved_ask)
    assert len(observed.calls) == int(expected["tool_executed"])


def test_function_policy_corpus_inventory_is_exact_and_assertion_complete():
    _validate_function_policy_corpus(MANIFEST, EVENT_ROWS, EXPECTED)


@pytest.mark.parametrize(
    "missing",
    ["policy", "event", "verdict-field", "tool-executed", "bundle-cell"],
)
def test_function_policy_corpus_validator_rejects_every_incomplete_dimension(missing: str):
    manifest = copy.deepcopy(MANIFEST)
    event_rows = copy.deepcopy(EVENT_ROWS)
    expected = copy.deepcopy(EXPECTED)
    contract = manifest["function_policy_contract"]
    verdicts = expected["function_policy_contract"]

    if missing == "policy":
        contract["attachments"].pop()
    elif missing == "event":
        event_id = _FUNCTION_POLICY_EVENT_IDS[-1]
        contract["event_ids"].remove(event_id)
        event_rows[:] = [row for row in event_rows if row["id"] != event_id]
        verdicts["events"] = [
            row for row in verdicts["events"] if row["event_id"] != event_id
        ]
    elif missing == "verdict-field":
        verdicts["individual_defaults"]["manager/blast_radius"].pop("handler_result")
    elif missing == "tool-executed":
        verdicts["events"][0].pop("tool_executed_default")
    elif missing == "bundle-cell":
        contract["bundle_evaluators"].pop()
    else:  # pragma: no cover - closed parametrization
        raise AssertionError(f"unknown mutation {missing}")

    with pytest.raises(AssertionError):
        _validate_function_policy_corpus(manifest, event_rows, expected)


def test_production_policies_do_not_read_legacy_top_level_event_authority():
    forbidden = {
        "tool_name",
        "ticket_id",
        "declared_paths",
        "worktree_root",
        "path",
        "phase",
        "vendor",
        "completion",
    }
    package = REPO_ROOT / "rickgent-policies" / "rickgent_policies"
    violations: list[str] = []
    for source in sorted(package.glob("*.py")):
        tree = ast.parse(source.read_text(), filename=str(source))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "event"
                and node.attr in forbidden
            ):
                violations.append(f"{source.name}:{node.lineno}: event.{node.attr}")
            if (
                isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name)
                and node.value.id == "event"
                and isinstance(node.slice, ast.Constant)
                and node.slice.value in forbidden
            ):
                violations.append(f"{source.name}:{node.lineno}: event[{node.slice.value!r}]")
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "event"
                and node.func.attr == "get"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value in forbidden
            ):
                violations.append(f"{source.name}:{node.lineno}: event.get({node.args[0].value!r})")
    assert violations == []


@pytest.mark.parametrize("bundle", ["manager", "worker"])
def test_bundle_inventory_matches_real_omnigent_parse_and_resolution(bundle: str):
    source = MANAGER_DIR if bundle == "manager" else WORKER_DIR
    spec = parse(source, expand_env=False)
    expected_bundle = CONTRACT["bundles"][bundle]
    manager = ToolManager(spec, workdir=source, sandbox_enabled=False)
    try:
        assert tuple(manager.get_tool_names()) == tuple(expected_bundle["effective_tools"])
    finally:
        manager.shutdown()
    resolved = validate_attached_policy_bundle(source)
    assert tuple(policy.spec.name for policy in resolved) == REQUIRED_POLICY_NAMES
    assert all(isinstance(policy, FunctionPolicy) for policy in resolved)


def test_canonical_adapter_inventory_exactly_covers_every_effective_bundle_tool():
    effective = {
        tool
        for bundle in CONTRACT["bundles"].values()
        for tool in bundle["effective_tools"]
    }
    governed = (
        set(FILESYSTEM_TOOL_ACTIONS)
        | set(SHELL_TOOLS)
        | set(LIFECYCLE_TOOL_ACTIONS)
    )
    assert effective == set(KNOWN_NATIVE_TOOLS)
    assert effective - governed == set(UNRELATED_NATIVE_TOOLS)


@pytest.mark.parametrize("bundle", ["manager", "worker"])
def test_every_effective_unrelated_tool_remains_reachable_through_full_bundle(
    bundle: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    attempt = _attempt(tmp_path / "attempt")
    _bind_attempt(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)
    source = MANAGER_DIR if bundle == "manager" else WORKER_DIR
    rendered = _materialized_bundle(source, tmp_path / "bundle", attempt.config)
    policies = validate_attached_policy_bundle(rendered, expected_config=attempt.config)
    engine = _engine(_fresh(policies))

    for tool in sorted(
        set(CONTRACT["bundles"][bundle]["effective_tools"])
        & set(UNRELATED_NATIVE_TOOLS)
    ):
        event = {
            "type": "tool_call",
            "target": tool,
            "data": {"name": tool, "arguments": {}},
            "context": {},
            "session_state": {},
            "llm_client": None,
        }
        result = asyncio.run(engine.evaluate(_context(event), read_only=True))
        assert result.action is PolicyAction.ALLOW, (tool, result.reason)


def test_composed_verdict_controls_actual_toolmanager_dispatch_and_malformed_write_is_safe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    attempt = _attempt(tmp_path / "attempt")
    head = _bind_attempt(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)
    rendered = _materialized_bundle(WORKER_DIR, tmp_path / "worker", attempt.config)
    policies = validate_attached_policy_bundle(rendered, expected_config=attempt.config)
    engine = _engine(_fresh(policies))
    monkeypatch.chdir(attempt.worktree)
    manager = ToolManager(
        parse(rendered, expand_env=False),
        workdir=rendered,
        sandbox_enabled=False,
    )
    ctx = ToolContext("corpus", "worker", workspace=attempt.worktree)

    async def verdict(event: Mapping[str, Any]):
        return await engine.evaluate(_context(event), read_only=True)

    dispatches: list[str] = []

    def dispatch_if_authorized(
        result,
        event: Mapping[str, Any],
        *,
        approved_ask: bool = False,
    ) -> str | None:
        if result.action is not PolicyAction.ALLOW and not (
            result.action is PolicyAction.ASK and approved_ask
        ):
            return None
        dispatches.append(event["target"])
        return manager.call_tool(
            event["target"],
            json.dumps(event["data"]["arguments"]),
            ctx,
        )

    try:
        allowed = _replace_tokens(
            copy.deepcopy(EVENTS["worker_write"]["event"]), attempt=attempt, head=head
        )
        allow_result = asyncio.run(verdict(allowed))
        assert allow_result.action is PolicyAction.ALLOW
        tool_output = dispatch_if_authorized(allow_result, allowed)
        assert tool_output is not None
        assert "error" not in tool_output.lower(), tool_output
        assert (attempt.worktree / "test" / "existing.txt").read_text() == "updated"
        assert dispatches == ["sys_os_write"]

        marker = attempt.worktree / "test" / "existing.txt"
        marker.write_text("must-survive\n")
        malformed = copy.deepcopy(allowed)
        malformed["data"]["arguments"] = {"path": "test/existing.txt"}
        malformed_result = asyncio.run(verdict(malformed))
        assert malformed_result.action is PolicyAction.DENY
        assert dispatch_if_authorized(malformed_result, malformed) is None
        assert marker.read_text() == "must-survive\n"
        assert dispatches == ["sys_os_write"]

        denied = copy.deepcopy(allowed)
        denied["data"]["arguments"] = {"path": "escape.txt", "content": "escape"}
        deny_result = asyncio.run(verdict(denied))
        assert deny_result.action is PolicyAction.DENY
        assert dispatch_if_authorized(deny_result, denied) is None
        assert not (attempt.worktree / "escape.txt").exists()
        assert dispatches == ["sys_os_write"]

        # ASK is a real PolicyEngine result too.  It does not dispatch until a
        # caller records approval; the full bundle further hard-denies shell.
        shell = _replace_tokens(
            copy.deepcopy(EVENTS["delivery_push_call"]["event"]),
            attempt=attempt,
            head=head,
        )
        ask_result = asyncio.run(
            _engine((_fresh(policies)[0],)).evaluate(_context(shell), read_only=True)
        )
        assert ask_result.action is PolicyAction.ASK
        assert dispatch_if_authorized(ask_result, shell) is None

        # Approval cannot bypass the full bundle's unconditional shell denial.
        shell_result = asyncio.run(verdict(shell))
        assert shell_result.action is PolicyAction.DENY
        assert dispatch_if_authorized(
            shell_result,
            shell,
            approved_ask=True,
        ) is None
        assert dispatches == ["sys_os_write"]
    finally:
        manager.shutdown()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda policies: policies.pop("scope_fence"),
        lambda policies: policies["scope_fence"]["function"].__setitem__(
            "path", "rickgent_policies.select_model"
        ),
        lambda policies: policies["scope_fence"].pop("config"),
    ],
    ids=["missing", "incompatible", "attempt-config-missing"],
)
def test_materialized_agent_startup_rejects_more_than_static_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation,
):
    attempt = _attempt(tmp_path / "attempt")
    _bind_attempt(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)
    bundle = _materialized_bundle(WORKER_DIR, tmp_path / "worker", attempt.config)
    config_path = bundle / "config.yaml"
    document = yaml.safe_load(config_path.read_text())
    mutation(document["guardrails"]["policies"])
    config_path.write_text(yaml.safe_dump(document, sort_keys=False))

    if "scope_fence" in document["guardrails"]["policies"]:
        assert "scope_fence" in effective_attached_policies(bundle)
    with pytest.raises(ValueError):
        validate_attached_policy_bundle(
            bundle,
            expected_config=attempt.config,
            smoke=True,
        )


@pytest.mark.parametrize("event_id", CONTRACT["event_ids"])
def test_every_policy_event_and_bundle_verdict(
    event_id: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    row = EVENTS[event_id]
    attempt = _attempt(
        tmp_path / "attempt", phase=row.get("attempt_phase", "implement")
    )
    head = _bind_attempt(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)
    event = _replace_tokens(copy.deepcopy(row["event"]), attempt=attempt, head=head)
    event_contract = next(
        item for item in VERDICTS["events"] if item["event_id"] == event_id
    )
    approved_ask = row.get("approved_ask", False) is True

    for bundle, source in (("manager", MANAGER_DIR), ("worker", WORKER_DIR)):
        rendered = _materialized_bundle(
            source,
            tmp_path / f"{bundle}-bundle",
            attempt.config,
        )
        policies = validate_attached_policy_bundle(
            rendered,
            expected_config=attempt.config,
        )
        asyncio.run(
            _evaluate_individual(
                policies,
                event,
                bundle,
                event_contract,
                approved_ask,
            )
        )
        asyncio.run(
            _evaluate_bundle(
                policies,
                event,
                bundle,
                event_contract,
                approved_ask,
            )
        )


def test_function_policy_import_is_from_required_omnigent_root():
    root_value = os.environ.get("OMNIGENT_ROOT")
    assert root_value, "OMNIGENT_ROOT is a required, non-skipping preflight"
    origin = Path(inspect.getfile(FunctionPolicy)).resolve(strict=True)
    assert origin.is_relative_to(Path(root_value).resolve(strict=True)), origin
