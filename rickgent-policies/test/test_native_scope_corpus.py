"""Canonical scope corpus and production FunctionPolicy enforcement proof."""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
from pathlib import Path
from typing import Any, Mapping

import pytest
import rickgent_policies.scope as scope_module
from omnigent.policies import function as function_module
from omnigent.policies.function import resolve_function_policy
from omnigent.policies.types import EvaluationContext
from omnigent.spec.types import FunctionPolicySpec, FunctionRef, Phase, PolicyAction

from rickgent_policies import scope_fence
from rickgent_policies.policy_event import TicketScopeEntry
from rickgent_policies.scope import (
    RAW_SHELL_TOOLS,
    SCOPE_DENIAL_CODE,
    ScopeOperation,
    evaluate_scope,
)

from .test_native_policy_context import AttemptFixture, _canonical, _sha


FIXTURES = Path(__file__).parent / "fixtures" / "native-policy-corpus"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())
EXPECTED = json.loads((FIXTURES / "expected-verdicts.json").read_text())
EVENTS = {
    row["id"]: row
    for row in (
        json.loads(line)
        for line in (FIXTURES / "events.jsonl").read_text().splitlines()
        if line.strip()
    )
}

_ATTEMPT_DIGEST_EXCLUDED = {
    "attempt_digest",
    "owner_token_sha256",
    "nonce",
    "nonce_claim_path",
    "lease_path",
    "receipt_path",
}


def _expand(token: str, roots: Mapping[str, Path], default: Path) -> Path:
    for name, root in roots.items():
        if token == name:
            return root
        prefix = f"{name}/"
        if token.startswith(prefix):
            return root / token[len(prefix) :]
    return default / token


def _materialize_scope_case(
    scope_case: Mapping[str, Any], tmp_path: Path
) -> tuple[dict[str, Any], ScopeOperation]:
    container = tmp_path.resolve(strict=True)
    worktree = container / "worktree"
    outside = container / "outside"
    state = container / "state"
    policy = container / "policy"
    bundle = container / "bundle"
    for path in (worktree, outside, state, policy, bundle):
        path.mkdir()
    worktree_link = container / "worktree-link"
    worktree_link.symlink_to(worktree, target_is_directory=True)
    roots = {
        "$WORKTREE": worktree,
        "$WORKTREE_LINK": worktree_link,
        "$OUTSIDE": outside,
        "$STATE": state,
        "$POLICY": policy,
        "$BUNDLE": bundle,
    }

    setup = scope_case["setup"]
    for directory in setup.get("dirs", []):
        _expand(directory, roots, worktree).mkdir(parents=True, exist_ok=True)
    for filename in setup.get("files", []):
        path = _expand(filename, roots, worktree)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture\n")
    for symbolic_link in setup.get("symlinks", []):
        link = _expand(symbolic_link["link"], roots, worktree)
        link.parent.mkdir(parents=True, exist_ok=True)
        raw_target = symbolic_link["target"]
        target = _expand(raw_target, roots, worktree) if raw_target.startswith("$") else raw_target
        link.symlink_to(target)

    declarations = tuple(
        TicketScopeEntry(
            declaration["path"],
            declaration["change_kind"],
            declaration["directory"],
            declaration.get("from_path"),
        )
        for declaration in scope_case["declared_scope"]
    )
    raw_operation = scope_case["operation"]
    if raw_operation["kind"] in {"rename", "link"}:
        operation = ScopeOperation(
            raw_operation["kind"],
            raw_operation["directory"],
            source_path=raw_operation.get("source_path"),
            destination_path=raw_operation.get("destination_path"),
        )
    else:
        operation = ScopeOperation(
            raw_operation["kind"],
            raw_operation["directory"],
            path=raw_operation.get("path"),
        )
    request = {
        "worktree_root": str(
            _expand(scope_case.get("worktree_root", "$WORKTREE"), roots, worktree)
        ),
        "authorized_root": str(
            _expand(scope_case.get("authorized_root", "$WORKTREE"), roots, worktree)
        ),
        "reserved_roots": tuple(
            str(_expand(path, roots, worktree))
            for path in scope_case.get(
                "reserved_roots", ["$STATE", "$POLICY", "$BUNDLE"]
            )
        ),
        "declared_scope": declarations,
    }
    return request, operation


def _bind_native_scope(attempt: AttemptFixture) -> None:
    (attempt.worktree / "owned").mkdir()
    (attempt.worktree / "other").mkdir()
    (attempt.worktree / "owned" / "input.txt").write_text("input\n")
    (attempt.worktree / "owned" / "existing.txt").write_text("old\n")
    (attempt.worktree / "other" / "input.txt").write_text("other\n")
    attempt.context["declared_scope"] = [
        {
            "path": "owned/input.txt",
            "change_kind": "modify",
            "directory": False,
        },
        {
            "path": "owned/new.txt",
            "change_kind": "create",
            "directory": False,
        },
        {
            "path": "owned/existing.txt",
            "change_kind": "modify",
            "directory": False,
        },
    ]
    digest_base = {
        key: value
        for key, value in attempt.context.items()
        if key not in _ATTEMPT_DIGEST_EXCLUDED
    }
    attempt.context["attempt_digest"] = _sha(_canonical(digest_base))
    attempt.rewrite_context_and_bind()


def _evaluation_context(event: Mapping[str, Any]) -> EvaluationContext:
    return EvaluationContext(
        phase=Phase(event["type"]),
        content=event["data"],
        tool_name=event["target"],
        actor=event["context"].get("actor"),
        request_data=event.get("request_data"),
        session_state=event["session_state"],
        llm_client=event["llm_client"],
    )


def test_function_policy_import_is_bound_to_mounted_root():
    root_value = os.environ.get("OMNIGENT_ROOT")
    assert root_value, "OMNIGENT_ROOT is a required, non-skipping preflight"
    root = Path(root_value).resolve(strict=True)
    origin = Path(inspect.getfile(function_module)).resolve(strict=True)
    assert origin.is_relative_to(root), f"FunctionPolicy shadow import: {origin}"


def test_scope_corpus_inventory_is_versioned_unique_and_complete():
    contract = MANIFEST["scope_contract"]
    expected = EXPECTED["scope_contract"]
    assert MANIFEST["schema_version"] == "rickgent-native-policy-corpus/v3"
    assert contract["schema_version"] == "rickgent-canonical-scope-corpus/v1"
    assert expected["schema_version"] == contract["schema_version"]
    cases = contract["cases"]
    ids = [scope_case["id"] for scope_case in cases]
    assert len(ids) == len(set(ids)) == expected["manifest_case_count"]
    assert expected["required_observations"] == ["result", "change_kind"]

    native_ids = contract["native_event_ids"]
    native_expectations = expected["native_expectations"]
    assert len(native_ids) == len(set(native_ids))
    assert set(native_ids) <= EVENTS.keys()
    assert {row["event_id"] for row in native_expectations} == set(native_ids)
    assert len(native_expectations) == len(native_ids)


@pytest.mark.parametrize(
    "scope_case",
    MANIFEST["scope_contract"]["cases"],
    ids=lambda scope_case: scope_case["id"],
)
def test_python_scope_semantics_match_shared_inventory(
    scope_case: Mapping[str, Any], tmp_path: Path
):
    request, operation = _materialize_scope_case(scope_case, tmp_path)
    decision = evaluate_scope(**request, operation=operation)
    assert {
        "result": decision.result,
        "change_kind": decision.change_kind,
    } == {
        "result": scope_case["expected_result"],
        "change_kind": scope_case["expected_change_kind"],
    }, decision.reason
    if decision.result == "DENY":
        assert decision.code == SCOPE_DENIAL_CODE


@pytest.mark.parametrize(
    "expectation",
    EXPECTED["scope_contract"]["native_expectations"],
    ids=lambda expectation: expectation["event_id"],
)
def test_native_scope_events_use_real_function_policy_and_private_context(
    expectation: Mapping[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    attempt = AttemptFixture(tmp_path)
    _bind_native_scope(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)

    case = EVENTS[expectation["event_id"]]
    event = case["event"]
    direct = scope_fence(event, attempt.config)
    handler_result = "ABSTAIN" if direct is None else direct["result"]

    policy = resolve_function_policy(
        FunctionPolicySpec(
            name="canonical-scope",
            on=None,
            function=FunctionRef("rickgent_policies.scope_fence"),
            config=attempt.config,
        )
    )
    result = asyncio.run(policy.evaluate(_evaluation_context(event), {}))
    executed = int(result.action is PolicyAction.ALLOW and event["type"] == "tool_call")
    reason_code = result.reason.split(":", 1)[0] if result.reason else None

    assert {
        "handler_result": handler_result,
        "native_result": result.action.name,
        "reason_code": reason_code,
        "tool_executed": bool(executed),
    } == {
        "handler_result": expectation["handler_result"],
        "native_result": expectation["native_result"],
        "reason_code": expectation["reason_code"],
        "tool_executed": expectation["tool_executed"],
    }


@pytest.mark.parametrize("tool", sorted(RAW_SHELL_TOOLS))
def test_every_raw_shell_spelling_denies_without_command_classification(
    tool: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    attempt = AttemptFixture(tmp_path)
    _bind_native_scope(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)
    event = {
        "type": "tool_call",
        "target": tool,
        "data": {"name": tool, "arguments": {"command": "ls -la"}},
        "context": {},
        "session_state": {},
        "llm_client": None,
    }
    policy = resolve_function_policy(
        FunctionPolicySpec(
            name="canonical-scope",
            on=None,
            function=FunctionRef("rickgent_policies.scope_fence"),
            config=attempt.config,
        )
    )
    result = asyncio.run(policy.evaluate(_evaluation_context(event), {}))
    assert result.action is PolicyAction.DENY
    assert result.reason.startswith("RICKGENT_SCOPE_DENIED:")


def test_agent_authority_copies_cannot_widen_scope(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    attempt = AttemptFixture(tmp_path)
    _bind_native_scope(attempt)
    for key, value in attempt.environment.items():
        monkeypatch.setenv(key, value)
    event = copy.deepcopy(EVENTS["scope_absolute_write_call"]["event"])
    injected = {
        "worktree_realpath": "/tmp",
        "authorized_root": "/tmp",
        "declared_scope": [
            {"path": "escape.txt", "change_kind": "create", "directory": False}
        ],
        "action": "read",
        "change_kind": "create",
    }
    event.update(injected)
    event["context"].update(injected)
    event["session_state"].update(injected)

    decision = scope_fence(event, attempt.config)
    assert decision is not None
    assert decision["result"] == "DENY"
    assert decision["code"] == SCOPE_DENIAL_CODE


def test_scope_fence_fails_closed_on_unexpected_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    def fail_adaptation(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("unexpected fixture failure")

    monkeypatch.setattr(scope_module, "adapt_native_policy_event", fail_adaptation)
    assert scope_module.scope_fence({}, {}) == {
        "result": "DENY",
        "reason": f"{SCOPE_DENIAL_CODE}: scope policy failed safely",
        "code": SCOPE_DENIAL_CODE,
    }
