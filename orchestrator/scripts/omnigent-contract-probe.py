#!/usr/bin/env python3
"""Offline behavioral probe for Rickgent's evolving Omnigent contract."""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Any


PROBE_PREFIX = "RICKGENT_OMNIGENT_PROBE_RESULT="


def _deny_network(event: str, _args: tuple[Any, ...]) -> None:
    """Reject socket operations that could leave the offline probe process."""
    if event in {
        "socket.connect",
        "socket.getaddrinfo",
        "socket.gethostbyaddr",
        "socket.gethostbyname",
        "socket.sendto",
    }:
        raise RuntimeError(f"network access denied during compatibility probe: {event}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--contract", required=True)
    return parser.parse_args()


def _assert_under(path: Path, root: Path, label: str) -> str:
    resolved = path.resolve(strict=True)
    package_root = (root / "omnigent").resolve(strict=True)
    try:
        relative = resolved.relative_to(root)
        resolved.relative_to(package_root)
    except ValueError as exc:
        raise AssertionError(f"{label} import escaped mounted root: {resolved}") from exc
    return relative.as_posix()


def _phase_fixture(phase: Any) -> tuple[Any, str | None, Any]:
    from omnigent.spec.types import Phase

    if phase == Phase.TOOL_CALL:
        return {"name": "sys_os_write", "arguments": {"path": "src/a.ts"}}, "sys_os_write", None
    if phase == Phase.TOOL_RESULT:
        request = {"name": "sys_os_write", "arguments": {"path": "src/a.ts"}}
        return {"result": "ok"}, "sys_os_write", request
    if phase == Phase.LLM_REQUEST:
        return {"model": "probe-model", "messages_count": 1}, None, None
    if phase == Phase.LLM_RESPONSE:
        return {
            "model": "probe-model",
            "usage": {"model": "probe-model", "total_tokens": 3},
        }, None, None
    if phase == Phase.REQUEST:
        return "probe request", None, None
    return "probe response", None, None


async def _probe_function_policy(contract: dict[str, Any], checks: list[dict[str, Any]]) -> None:
    from omnigent.policies.function import FunctionPolicy
    from omnigent.policies.types import EvaluationContext
    from omnigent.spec.types import FunctionPolicySpec, Phase

    captured: list[tuple[dict[str, Any], dict[str, Any]]] = []

    def capture(event: dict[str, Any], config: dict[str, Any]) -> dict[str, str]:
        captured.append((event, config))
        return {"result": "ALLOW"}

    sentinel_config = {"sentinel": "config-value"}
    policy = FunctionPolicy(
        FunctionPolicySpec(name="phase-probe", on=None, config=sentinel_config),
        capture,
    )
    required_fields = set(
        contract["function_policy_abi"]["event"]["required_top_level_fields"]
    )
    phases = list(Phase)
    for phase in phases:
        content, tool_name, request_data = _phase_fixture(phase)
        ctx = EvaluationContext(
            phase=phase,
            content=content,
            tool_name=tool_name,
            request_data=request_data,
            model="probe-model",
            harness="claude-sdk",
        )
        result = await policy.evaluate(ctx, {})
        assert result.action.value == "allow"

    assert len(captured) == len(phases)
    for phase, (event, config) in zip(phases, captured, strict=True):
        assert required_fields.issubset(event)
        assert event["type"] == phase.value
        assert config == sentinel_config
        assert event["context"]["model"] == "probe-model"
        assert event["context"]["harness"] == "claude-sdk"
    tool_event = captured[phases.index(Phase.TOOL_CALL)][0]
    assert tool_event["target"] == "sys_os_write"
    assert tool_event["data"] == {
        "name": "sys_os_write",
        "arguments": {"path": "src/a.ts"},
    }
    result_event = captured[phases.index(Phase.TOOL_RESULT)][0]
    assert result_event["target"] == "sys_os_write"
    assert result_event["data"] == {"result": "ok"}
    assert result_event["request_data"] == {
        "name": "sys_os_write",
        "arguments": {"path": "src/a.ts"},
    }
    checks.append(
        {
            "id": "six-phase-event-shape",
            "status": "pass",
            "phase_values": [phase.value for phase in phases],
        }
    )


async def _probe_parser_and_resolution(checks: list[dict[str, Any]]) -> None:
    from omnigent.policies.function import resolve_function_policy
    from omnigent.policies.types import EvaluationContext
    from omnigent.spec import parse
    from omnigent.spec.types import Phase

    module_source = '''
CAPTURED = []
FACTORY_ARGUMENT = None

def direct(event, config):
    CAPTURED.append({"kind": "direct", "event": event, "config": config})
    return {"result": "ALLOW"}

def factory(factory_marker):
    global FACTORY_ARGUMENT
    FACTORY_ARGUMENT = factory_marker
    def evaluate(event, config):
        CAPTURED.append({"kind": "factory", "event": event, "config": config})
        return {"result": "ALLOW"}
    return evaluate
'''
    config_yaml = '''
spec_version: 1
name: omnigent-contract-probe
description: Offline FunctionPolicy compatibility probe.
instructions: Probe only.
executor:
  type: omnigent
  config:
    harness: claude
llm:
  model: anthropic/claude-sonnet-probe
interaction:
  conversational: false
  modalities:
    input: [text]
    output: [text]
tools:
  builtins: []
guardrails:
  policies:
    direct_probe:
      type: function
      on: [tool_call]
      function: rickgent_omnigent_contract_fixture.direct
      config:
        sentinel: config-only
    factory_probe:
      type: function
      function:
        path: rickgent_omnigent_contract_fixture.factory
        arguments:
          factory_marker: factory-only
      config:
        config_marker: evaluation-only
'''
    with tempfile.TemporaryDirectory(prefix="rickgent-omnigent-probe-") as raw_tmp:
        tmp = Path(raw_tmp)
        (tmp / "config.yaml").write_text(config_yaml, encoding="utf-8")
        (tmp / "rickgent_omnigent_contract_fixture.py").write_text(
            module_source,
            encoding="utf-8",
        )
        sys.path.insert(0, str(tmp))
        try:
            spec = parse(tmp, expand_env=False)
            assert spec.guardrails is not None
            policies = spec.guardrails.policies or []
            assert [policy.name for policy in policies] == ["direct_probe", "factory_probe"]
            direct_spec, factory_spec = policies
            assert direct_spec.on is None
            assert direct_spec.config == {"sentinel": "config-only"}
            assert factory_spec.config == {"config_marker": "evaluation-only"}

            ctx = EvaluationContext(
                phase=Phase.TOOL_CALL,
                content={"name": "sys_os_write", "arguments": {"path": "src/a.ts"}},
                tool_name="sys_os_write",
            )
            direct = resolve_function_policy(direct_spec)
            factory = resolve_function_policy(factory_spec)
            assert (await direct.evaluate(ctx, {})).action.value == "allow"
            assert (await factory.evaluate(ctx, {})).action.value == "allow"
            fixture = importlib.import_module("rickgent_omnigent_contract_fixture")
            assert fixture.FACTORY_ARGUMENT == "factory-only"
            assert fixture.CAPTURED[0]["config"] == {"sentinel": "config-only"}
            assert fixture.CAPTURED[1]["config"] == {"config_marker": "evaluation-only"}
        finally:
            sys.path.remove(str(tmp))
            sys.modules.pop("rickgent_omnigent_contract_fixture", None)

    checks.append({"id": "config-parser", "status": "pass", "string_values_preserved": True})
    checks.append(
        {
            "id": "factory-config-separation",
            "status": "pass",
        }
    )
    checks.append(
        {
            "id": "function-self-selection",
            "status": "pass",
            "function_on_is_self_selected": True,
        }
    )


async def _probe_failure_behavior(checks: list[dict[str, Any]]) -> None:
    from omnigent.policies.function import FunctionPolicy
    from omnigent.policies.types import EvaluationContext
    from omnigent.runtime.policies.engine import _dispatch_policy
    from omnigent.spec.types import FunctionPolicySpec, Phase

    ctx = EvaluationContext(phase=Phase.REQUEST, content="probe")

    def explode(_event: dict[str, Any], _config: dict[str, Any]) -> dict[str, str]:
        raise RuntimeError("probe explosion")

    def missing_result(_event: dict[str, Any], _config: dict[str, Any]) -> dict[str, str]:
        return {"reason": "missing result"}

    def abstain(_event: dict[str, Any], _config: dict[str, Any]) -> None:
        return None

    def coded_deny(_event: dict[str, Any], _config: dict[str, Any]) -> dict[str, str]:
        return {
            "result": "DENY",
            "reason": "RICKGENT_PROBE_DENY: expected",
            "code": "RICKGENT_PROBE_DENY",
        }

    def wrapped(name: str, fn: Any) -> FunctionPolicy:
        return FunctionPolicy(FunctionPolicySpec(name=name, on=None, config={}), fn)

    exploded = await _dispatch_policy(wrapped("explode", explode), ctx, {})
    malformed = await _dispatch_policy(wrapped("missing", missing_result), ctx, {})
    allowed = await _dispatch_policy(wrapped("abstain", abstain), ctx, {})
    coded = await wrapped("coded", coded_deny).evaluate(ctx, {})
    assert exploded.action.value == "deny"
    assert "probe explosion" in (exploded.reason or "")
    assert malformed.action.value == "deny"
    assert "missing 'result'" in (malformed.reason or "")
    assert allowed.action.value == "allow"
    assert coded.action.value == "deny"
    assert coded.reason == "RICKGENT_PROBE_DENY: expected"
    assert not hasattr(coded, "code")
    checks.append({"id": "engine-failure-deny", "status": "pass"})
    checks.append(
        {
            "id": "return-shape-code-discard",
            "status": "pass",
            "stable_code_transport": "reason-prefix-and-rickgent-receipt",
        }
    )


def _probe_aliases(contract: dict[str, Any], checks: list[dict[str, Any]]) -> None:
    from omnigent.harness_aliases import canonicalize_harness

    normalization = contract["identity_normalization"]
    aliases = normalization["harness_aliases"]
    dynamic = normalization["dynamic_harness_alias_cases"]
    for raw, expected in {**aliases, **dynamic}.items():
        assert canonicalize_harness(raw) == expected, (raw, canonicalize_harness(raw), expected)
    checks.append(
        {
            "id": "harness-alias-corpus",
            "status": "pass",
            "case_count": len(aliases) + len(dynamic),
        }
    )


def _probe_session_schema(contract: dict[str, Any], checks: list[dict[str, Any]]) -> None:
    from omnigent.db.db_models import SqlConversation, SqlConversationItem

    seam = contract["session_seam"]
    conversation_columns = {column.name for column in SqlConversation.__table__.columns}
    item_columns = {column.name for column in SqlConversationItem.__table__.columns}
    required_conversation = set(seam["required_conversation_columns"])
    required_items = set(seam["required_conversation_item_columns"])
    assert required_conversation.issubset(conversation_columns)
    assert required_items.issubset(item_columns)
    checks.append(
        {
            "id": "session-schema",
            "status": "pass",
            "conversation_columns": sorted(required_conversation),
            "conversation_item_columns": sorted(required_items),
            "exactly_one_root_conversation_required": True,
        }
    )


async def _run() -> dict[str, Any]:
    args = _parse_args()
    root = Path(args.root).resolve(strict=True)
    contract_path = Path(args.contract).resolve(strict=True)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))

    sys.addaudithook(_deny_network)
    sys.path.insert(0, str(root))
    try:
        import omnigent
        from omnigent.policies import function as function_module
        from omnigent.spec import parser as parser_module
        from omnigent.version import VERSION

        origins = {
            "package": _assert_under(Path(omnigent.__file__), root, "omnigent"),
            "function_policy": _assert_under(Path(function_module.__file__), root, "FunctionPolicy"),
            "parser": _assert_under(Path(parser_module.__file__), root, "parser"),
        }
        checks: list[dict[str, Any]] = [
            {
                "id": "import-origin",
                "status": "pass",
                "origins": origins,
                "version_source": "omnigent.version.VERSION",
            }
        ]
        await _probe_parser_and_resolution(checks)
        await _probe_function_policy(contract, checks)
        await _probe_failure_behavior(checks)
        _probe_aliases(contract, checks)
        _probe_session_schema(contract, checks)
    finally:
        sys.path.remove(str(root))

    required = contract["supported_compatibility_probe"]["required_checks"]
    observed = {check["id"] for check in checks}
    missing = sorted(set(required) - observed)
    if missing:
        raise AssertionError(f"probe did not execute required checks: {missing}")
    if any(check["status"] != "pass" for check in checks):
        raise AssertionError("one or more compatibility checks did not pass")
    deterministic = {
        "schema_version": "1.0.0",
        "contract_id": contract["contract_id"],
        "probe_id": contract["supported_compatibility_probe"]["id"],
        "status": "compatible",
        "contract_mode": contract["contract_mode"],
        "network": "denied",
        "runtime_version_policy": "informational-not-persisted",
        "checks": checks,
    }
    return {"deterministic_result": deterministic, "runtime_version": VERSION}


def main() -> int:
    result = asyncio.run(_run())
    print(PROBE_PREFIX + json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
