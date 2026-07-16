"""Exact manager FunctionPolicy attachment contract."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
import yaml
from omnigent.policies.function import FunctionPolicy
from omnigent.spec.parser import parse
from omnigent.spec.types import FunctionPolicySpec
from omnigent.tools.base import ToolContext
from omnigent.tools.manager import ToolManager

from rickgent_policies import (
    ATTACHED_POLICY_ROWS,
    REQUIRED_POLICY_NAMES,
    effective_attached_policies,
    validate_attached_policy_bundle,
)


REPO_ROOT = Path(__file__).parent.parent.parent
MANAGER_DIR = REPO_ROOT / "agents" / "rickgent"
LIFECYCLE_TOOLS = {
    "rickgent_mark_done": {"claimed_sha", "evidence"},
    "rickgent_phase_advance": {"next_phase"},
    "rickgent_build_gate": {"gate"},
    "rickgent_prd_validate": {"prd"},
}


def test_manager_attachment_is_exact_ordered_and_function_policy_compatible():
    resolved = validate_attached_policy_bundle(MANAGER_DIR)
    assert tuple(policy.spec.name for policy in resolved) == REQUIRED_POLICY_NAMES
    assert len(resolved) == len(ATTACHED_POLICY_ROWS) == 7
    assert all(isinstance(policy, FunctionPolicy) for policy in resolved)


def test_manager_lifecycle_tools_are_reachable_closed_and_non_authoritative():
    manager = ToolManager(
        parse(MANAGER_DIR, expand_env=False),
        workdir=MANAGER_DIR,
        sandbox_enabled=False,
    )
    try:
        schemas = {
            row["function"]["name"]: row["function"]["parameters"]
            for row in manager.get_tool_schemas()
        }
        assert LIFECYCLE_TOOLS.keys() <= set(manager.get_tool_names())
        for name, properties in LIFECYCLE_TOOLS.items():
            schema = schemas[name]
            assert schema["additionalProperties"] is False
            assert set(schema["properties"]) == properties
            assert set(schema["required"]) == properties

        result = manager.call_tool(
            "rickgent_phase_advance",
            json.dumps({"next_phase": "spec_conformance"}),
            ToolContext(task_id="test", agent_id="manager"),
        )
        assert json.loads(result) == {
            "received": True,
            "authoritative": False,
            "tool": "rickgent_phase_advance",
            "message": "Receipt only; authoritative lifecycle state is unchanged.",
        }
    finally:
        manager.shutdown()


def test_manager_rows_have_exact_paths_factory_shapes_and_config_posture():
    spec = parse(MANAGER_DIR, expand_env=False)
    policies = list(spec.guardrails.policies or [])
    for policy, expected in zip(policies, ATTACHED_POLICY_ROWS, strict=True):
        assert isinstance(policy, FunctionPolicySpec)
        assert policy.name == expected.name
        assert policy.function is not None
        assert policy.function.path == expected.path
        if expected.arguments is None:
            assert policy.function.arguments is None
        else:
            assert dict(policy.function.arguments or {}) == dict(expected.arguments)
            assert policy.function.arguments is not None
        assert policy.config is None


def _mutated(tmp_path: Path, mutate) -> Path:
    target = tmp_path / "manager"
    shutil.copytree(MANAGER_DIR, target)
    path = target / "config.yaml"
    document = yaml.safe_load(path.read_text())
    mutate(document["guardrails"]["policies"])
    path.write_text(yaml.safe_dump(document, sort_keys=False))
    return target


@pytest.mark.parametrize(
    "mutation",
    [
        lambda policies: policies.pop("scope_fence"),
        lambda policies: policies.__setitem__("extra", policies["scope_fence"].copy()),
        lambda policies: policies["scope_fence"]["function"].__setitem__("path", "rickgent_policies.select_model"),
        lambda policies: policies["blast_radius"]["function"]["arguments"].__setitem__("gate_pushes", False),
        lambda policies: policies["autonomous_pr_flow"]["function"].pop("arguments"),
        lambda policies: policies["scope_fence"].__setitem__("config", {"phase": "implement"}),
    ],
    ids=["missing", "extra", "wrong-path", "bad-builtin-args", "wrong-factory-shape", "template-config"],
)
def test_manager_rejects_every_attachment_incompatibility(tmp_path: Path, mutation):
    with pytest.raises(ValueError):
        validate_attached_policy_bundle(_mutated(tmp_path, mutation))


def test_effective_projection_is_parser_observation_not_validation(tmp_path: Path):
    partial = _mutated(tmp_path, lambda policies: policies.pop("scope_fence"))
    assert "scope_fence" not in effective_attached_policies(partial)
    with pytest.raises(ValueError):
        validate_attached_policy_bundle(partial)
