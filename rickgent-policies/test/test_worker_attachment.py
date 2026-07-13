"""B4 (worker) + A-SEC-3 (capability side) — policy ATTACHMENT to the worker bundle.

The worker bundle (`agents/rickgent/agents/worker/config.yaml`) must attach the
required policy set via its top-level `guardrails:` block (NOT `policy_modules`),
identically to the manager. The effective attached set is read from the omnigent
static parser (`spec.guardrails.policies`), never from `POLICY_REGISTRY`
(registration is not attachment).

Per the A-SEC-3 decision (architecture §6.2 option a, docs/decisions/scope-fence.md),
the worker drops ad-hoc `sys_os_shell` write capability; all writes route through
structured write tools (`sys_os_write`/`sys_os_edit`/`Write`/`Edit`) whose targets
the attached `scope_fence` can positively resolve and scope-check.

Fulfills: VAL-ATTACH-011, 012, 013, 014, 027, 028, VAL-SEC-036.
"""

import importlib
from pathlib import Path

import pytest

from omnigent.spec.parser import parse
from omnigent.spec.types import FunctionPolicySpec

from rickgent_policies import (
    REQUIRED_POLICIES,
    effective_attached_policies,
)
from rickgent_policies import _SHELL_TOOL_NAMES, _STRUCTURED_WRITE_TOOLS

REPO_ROOT = Path(__file__).parent.parent.parent
WORKER_DIR = REPO_ROOT / "agents" / "rickgent" / "agents" / "worker"


def _worker_spec():
    return parse(WORKER_DIR)


def _policy_by_name(spec, name):
    for policy in spec.guardrails.policies or []:
        if policy.name == name:
            return policy
    return None


def _resolvable(dotted_path: str) -> bool:
    module_path, _, attr = dotted_path.rpartition(".")
    try:
        module = importlib.import_module(module_path)
    except Exception:
        return False
    return callable(getattr(module, attr, None))


def _builtin_names(spec):
    return {b.name for b in (spec.tools.builtins or [])} if spec.tools else set()


# ── VAL-ATTACH-011 ───────────────────────────────────────────────────────────


def test_worker_parses_with_nonempty_guardrails():
    """VAL-ATTACH-011: parse succeeds; guardrails present with >= 7 policies."""
    spec = _worker_spec()
    assert spec is not None
    assert spec.guardrails is not None, "worker bundle has no guardrails block"
    assert spec.guardrails.policies is not None
    assert len(spec.guardrails.policies) >= 7


# ── VAL-ATTACH-012 ───────────────────────────────────────────────────────────


def test_worker_effective_set_superset_of_required():
    """VAL-ATTACH-012: worker effective attached set ⊇ REQUIRED_POLICIES."""
    effective = effective_attached_policies(WORKER_DIR)
    missing = REQUIRED_POLICIES - effective
    assert not missing, f"worker missing required attached policies: {sorted(missing)}"


# ── VAL-ATTACH-013 & VAL-SEC-036 ─────────────────────────────────────────────


def test_worker_drops_adhoc_sys_os_shell_write():
    """VAL-ATTACH-013 / VAL-SEC-036: worker no longer grants ad-hoc shell write."""
    spec = _worker_spec()
    builtins = _builtin_names(spec)
    assert "sys_os_shell" not in builtins, (
        f"worker still exposes ad-hoc sys_os_shell write capability: {sorted(builtins)}"
    )
    # No unresolved-write shell tool of any harness variant remains.
    leaked = builtins & _SHELL_TOOL_NAMES
    assert not leaked, f"worker exposes unresolved shell write tools: {sorted(leaked)}"


# ── VAL-ATTACH-014 ───────────────────────────────────────────────────────────


def test_worker_writes_route_through_structured_tools():
    """VAL-ATTACH-014: worker exposes structured write tool(s) the fence resolves."""
    spec = _worker_spec()
    builtins = _builtin_names(spec)
    structured = builtins & _STRUCTURED_WRITE_TOOLS
    assert structured, (
        "worker exposes no structured write tool the scope_fence can resolve; "
        f"builtins={sorted(builtins)}"
    )


# ── VAL-ATTACH-027 ───────────────────────────────────────────────────────────


def test_worker_attaches_blast_radius_gate_pushes_true():
    """VAL-ATTACH-027: worker blast_radius attached with gate_pushes=True."""
    spec = _worker_spec()
    policy = _policy_by_name(spec, "blast_radius")
    assert policy is not None, "blast_radius not attached to worker"
    assert isinstance(policy, FunctionPolicySpec)
    args = (policy.function.arguments or {}) if policy.function else {}
    config = policy.config or {}
    gate_pushes = args.get("gate_pushes", config.get("gate_pushes"))
    assert gate_pushes is True, f"worker blast_radius gate_pushes not True: {gate_pushes!r}"


# ── VAL-ATTACH-028 ───────────────────────────────────────────────────────────


def test_worker_scope_fence_resolvable_handler():
    """VAL-ATTACH-028: scope_fence resolves to rickgent_policies.scope_fence."""
    spec = _worker_spec()
    policy = _policy_by_name(spec, "scope_fence")
    assert policy is not None, "scope_fence not attached to worker"
    assert isinstance(policy, FunctionPolicySpec)
    assert policy.function.path == "rickgent_policies.scope_fence"
    assert _resolvable(policy.function.path)


def test_every_worker_policy_function_typed_and_resolvable():
    """VAL-ATTACH-028: all worker attached policies function-typed + resolvable."""
    spec = _worker_spec()
    for policy in spec.guardrails.policies or []:
        assert isinstance(policy, FunctionPolicySpec), (
            f"{policy.name} is not function-typed"
        )
        assert policy.function is not None and policy.function.path
        assert _resolvable(policy.function.path), (
            f"{policy.name} handler {policy.function.path} unresolvable"
        )


@pytest.mark.parametrize(
    "name",
    [
        "completion_evidence",
        "convergence_gate",
        "subtract_before_add",
        "cross_vendor_review",
        "autonomous_pr_flow",
    ],
)
def test_worker_attaches_rickgent_shim(name):
    """VAL-ATTACH-012/028: each rickgent shim attached to the worker + resolvable."""
    spec = _worker_spec()
    policy = _policy_by_name(spec, name)
    assert policy is not None, f"{name} not attached to worker"
    assert isinstance(policy, FunctionPolicySpec)
    assert policy.function.path == f"rickgent_policies.{name}"
    assert _resolvable(policy.function.path)
