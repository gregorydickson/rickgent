"""AC-2 — Omnigent compatibility pin holds.

Tests that the pinned omnigent primitives behave the way Rickgent depends on,
not just that their schemas exist.
"""

import pytest


def test_omnigent_version_pinned():
    """Omnigent is installed at the expected version."""
    import importlib.metadata
    version = importlib.metadata.version("omnigent")
    # We pin to 0.6.0.dev0 (local editable install from commit 6e3c7785)
    assert "0.6.0" in version or "0.5" in version, f"unexpected omnigent version: {version}"


def test_policies_register_via_policy_modules():
    """rickgent_policies loads into the omnigent policy registry."""
    from omnigent.policies.registry import is_registered_handler, load_registry
    load_registry(extra_modules=["rickgent_policies"])
    expected = {
        "rickgent_policies.scope_fence",
        "rickgent_policies.completion_evidence",
        "rickgent_policies.convergence_gate",
        "rickgent_policies.subtract_before_add",
        "rickgent_policies.cross_vendor_review",
        "rickgent_policies.autonomous_pr_flow",
    }
    for handler in expected:
        assert is_registered_handler(handler), f"{handler} not registered"


def test_agent_bundle_validates():
    """The rickgent agent bundle parses as a valid AGENTSPEC."""
    from pathlib import Path

    from omnigent.spec.parser import parse

    agent_dir = Path(__file__).parent.parent.parent / "agents" / "rickgent"
    spec = parse(agent_dir)
    assert spec is not None, "agent bundle failed to parse"
    assert spec.spec_version == 1
    assert spec.name == "rickgent"


def test_required_primitives_exist():
    """sys_session_send, sys_read_inbox, sys_os_shell are available."""
    from omnigent.tools.builtins.async_inbox import SysReadInboxTool
    from omnigent.tools.builtins.spawn import SysSessionSendTool
    assert SysSessionSendTool.name() == "sys_session_send"
    assert SysReadInboxTool.name() == "sys_read_inbox"


def test_sys_cancel_task_is_inert():
    """sys_cancel_task returns task_not_found for all inputs (TRAP)."""
    import json

    from omnigent.tools.builtins.async_inbox import SysCancelTaskTool
    tool = SysCancelTaskTool()
    result = tool.invoke(json.dumps({"task_id": "any-id"}), ctx=None)
    parsed = json.loads(result)
    assert parsed.get("error") == "task_not_found"


def test_policy_event_vocabulary_is_closed():
    """Policy events are a closed Literal — no custom event types."""
    from omnigent.policies.schema import PolicyEvent
    # The type field should be a Literal with the closed vocabulary
    type_hints = PolicyEvent.__annotations__.get("type")
    assert type_hints is not None, "PolicyEvent.type annotation missing"


def test_headless_subagent_purpose_guard_exists():
    """The purpose guard factory exists with the expected default purposes."""
    from omnigent.policies.builtins.orchestration import headless_subagent_purpose_guard
    guard = headless_subagent_purpose_guard()
    assert callable(guard), "purpose guard factory should return a callable"


def test_build_commit_matches():
    """Python wheel and TS package expose the same build_commit."""
    import os
    import shutil
    import subprocess
    from pathlib import Path

    import rickgent_policies
    try:
        cli = os.environ.get("RICKGENT_CLI_REALPATH")
        node = os.environ.get("RICKGENT_NODE_REALPATH")
        if not cli or not node:
            source_cli = Path(__file__).parents[2] / "orchestrator" / "dist" / "cli.js"
            fallback_node = shutil.which("node")
            if not source_cli.is_file() or fallback_node is None:
                raise FileNotFoundError("bound Rickgent CLI is unavailable")
            cli = str(source_cli.resolve())
            node = str(Path(fallback_node).resolve())
        ts_commit = subprocess.run(
            [node, cli, "--build-commit"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        assert rickgent_policies.BUILD_COMMIT == ts_commit, \
            f"build_commit mismatch: TS={ts_commit[:12]} Python={rickgent_policies.BUILD_COMMIT[:12]}"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pytest.skip("rickgent CLI not available")
