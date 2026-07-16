"""Exact worker FunctionPolicy attachment and capability contract."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml
from omnigent.policies.function import FunctionPolicy
from omnigent.spec.parser import parse
from omnigent.tools.manager import ToolManager

from rickgent_policies import (
    ATTACHED_POLICY_ROWS,
    REQUIRED_POLICY_NAMES,
    _SHELL_TOOL_NAMES,
    _STRUCTURED_WRITE_TOOLS,
    validate_attached_policy_bundle,
)


REPO_ROOT = Path(__file__).parent.parent.parent
WORKER_DIR = REPO_ROOT / "agents" / "rickgent" / "agents" / "worker"


def test_worker_attachment_is_exact_ordered_and_function_policy_compatible():
    resolved = validate_attached_policy_bundle(WORKER_DIR)
    assert tuple(policy.spec.name for policy in resolved) == REQUIRED_POLICY_NAMES
    assert len(resolved) == len(ATTACHED_POLICY_ROWS) == 7
    assert all(isinstance(policy, FunctionPolicy) for policy in resolved)


def test_worker_effective_inventory_comes_from_real_tool_manager():
    manager = ToolManager(
        parse(WORKER_DIR, expand_env=False),
        workdir=WORKER_DIR,
        sandbox_enabled=False,
    )
    try:
        names = set(manager.get_tool_names())
        assert names & _STRUCTURED_WRITE_TOOLS == {"sys_os_write", "sys_os_edit"}
        # os_env registers one concrete capability family. Presence is not
        # authority: the attached scope policy denies shell before dispatch.
        assert names & _SHELL_TOOL_NAMES == {"sys_os_shell"}
    finally:
        manager.shutdown()


def _mutated(tmp_path: Path, mutate) -> Path:
    target = tmp_path / "worker"
    shutil.copytree(WORKER_DIR, target)
    path = target / "config.yaml"
    document = yaml.safe_load(path.read_text())
    mutate(document["guardrails"]["policies"])
    path.write_text(yaml.safe_dump(document, sort_keys=False))
    return target


@pytest.mark.parametrize("name", REQUIRED_POLICY_NAMES)
def test_worker_rejects_each_missing_required_policy(tmp_path: Path, name: str):
    with pytest.raises(ValueError):
        validate_attached_policy_bundle(_mutated(tmp_path, lambda policies: policies.pop(name)))


def test_worker_rejects_reordered_policies(tmp_path: Path):
    def reorder(policies):
        first = policies.pop("blast_radius")
        policies["blast_radius"] = first

    with pytest.raises(ValueError, match="names/order"):
        validate_attached_policy_bundle(_mutated(tmp_path, reorder))
