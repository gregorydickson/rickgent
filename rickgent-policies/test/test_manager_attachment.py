"""B4 (manager) + C4 — policy ATTACHMENT to the manager bundle.

The manager bundle (`agents/rickgent/config.yaml`) must attach the required
policy set via its top-level `guardrails:` block (NOT `policy_modules`). The
effective attached set is read from the omnigent static parser
(`spec.guardrails.policies`), never from `POLICY_REGISTRY` (registration is not
attachment). `convergence_gate` is advisory on per-phase advance; blocking is
reserved for the build/full-PR gate.

Fulfills: VAL-ATTACH-001..010, 015, 018, 019, 020, 025, 026.
"""

import importlib
import textwrap
from pathlib import Path

import pytest

from omnigent.spec.parser import parse
from omnigent.spec.types import FunctionPolicySpec

import rickgent_policies
from rickgent_policies import (
    REQUIRED_POLICIES,
    convergence_gate,
    effective_attached_policies,
)

REPO_ROOT = Path(__file__).parent.parent.parent
MANAGER_DIR = REPO_ROOT / "agents" / "rickgent"


def _manager_spec():
    return parse(MANAGER_DIR)


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


# ── VAL-ATTACH-001 ───────────────────────────────────────────────────────────


def test_manager_parses_with_nonempty_guardrails():
    """VAL-ATTACH-001: parse succeeds; guardrails present with >= 7 policies."""
    spec = _manager_spec()
    assert spec is not None
    assert spec.guardrails is not None, "manager bundle has no guardrails block"
    assert spec.guardrails.policies is not None
    assert len(spec.guardrails.policies) >= 7


# ── VAL-ATTACH-002 ───────────────────────────────────────────────────────────


def test_manager_effective_set_superset_of_required():
    """VAL-ATTACH-002: effective attached set ⊇ REQUIRED_POLICIES."""
    effective = effective_attached_policies(MANAGER_DIR)
    missing = REQUIRED_POLICIES - effective
    assert not missing, f"manager missing required attached policies: {sorted(missing)}"


# ── VAL-ATTACH-003 ───────────────────────────────────────────────────────────


def test_manager_attaches_blast_radius_gate_pushes_true():
    """VAL-ATTACH-003: blast_radius attached with gate_pushes=True."""
    spec = _manager_spec()
    policy = _policy_by_name(spec, "blast_radius")
    assert policy is not None, "blast_radius not attached"
    assert isinstance(policy, FunctionPolicySpec)
    args = (policy.function.arguments or {}) if policy.function else {}
    config = policy.config or {}
    gate_pushes = args.get("gate_pushes", config.get("gate_pushes"))
    assert gate_pushes is True, f"blast_radius gate_pushes not True: {gate_pushes!r}"


# ── VAL-ATTACH-004 ───────────────────────────────────────────────────────────


def test_manager_attaches_scope_fence_resolvable_handler():
    """VAL-ATTACH-004: scope_fence function-typed, handler resolves."""
    spec = _manager_spec()
    policy = _policy_by_name(spec, "scope_fence")
    assert policy is not None
    assert isinstance(policy, FunctionPolicySpec)
    assert policy.function.path == "rickgent_policies.scope_fence"
    assert _resolvable(policy.function.path)


# ── VAL-ATTACH-005..009 ──────────────────────────────────────────────────────


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
def test_manager_attaches_rickgent_shim(name):
    """VAL-ATTACH-005..009: each rickgent shim attached + resolvable handler."""
    spec = _manager_spec()
    policy = _policy_by_name(spec, name)
    assert policy is not None, f"{name} not attached"
    assert isinstance(policy, FunctionPolicySpec)
    assert policy.function.path == f"rickgent_policies.{name}"
    assert _resolvable(policy.function.path)


# ── VAL-ATTACH-010 ───────────────────────────────────────────────────────────


def test_every_attached_policy_function_typed_and_resolvable():
    """VAL-ATTACH-010: all attached policies function-typed + resolvable."""
    spec = _manager_spec()
    for policy in spec.guardrails.policies or []:
        assert isinstance(policy, FunctionPolicySpec), (
            f"{policy.name} is not function-typed"
        )
        assert policy.function is not None and policy.function.path
        assert _resolvable(policy.function.path), (
            f"{policy.name} handler {policy.function.path} unresolvable"
        )


# ── VAL-ATTACH-025 ───────────────────────────────────────────────────────────


def test_attachment_via_guardrails_not_policy_modules():
    """VAL-ATTACH-025: attachment expressed via guardrails.policies."""
    import yaml

    spec = _manager_spec()
    assert spec.guardrails is not None
    assert spec.guardrails.policies, "guardrails.policies is empty"
    raw = yaml.safe_load((MANAGER_DIR / "config.yaml").read_text())
    assert "guardrails" in raw and raw["guardrails"].get("policies")
    assert "policy_modules" not in raw, "attachment must not rely on policy_modules"


# ── VAL-ATTACH-015 & VAL-ATTACH-026 ──────────────────────────────────────────


def _write_bundle(tmp_path: Path, with_guardrails: bool) -> Path:
    body = textwrap.dedent(
        """
        spec_version: 1
        name: rickgent
        instructions: inline test instructions
        executor:
          type: omnigent
          config:
            harness: claude
        llm:
          model: anthropic/claude-sonnet-4-20250514
        """
    ).strip()
    if with_guardrails:
        body += textwrap.dedent(
            """

            guardrails:
              policies:
                scope_fence:
                  type: function
                  function:
                    path: rickgent_policies.scope_fence
            """
        )
    bundle = tmp_path / "bundle"
    bundle.mkdir(parents=True)
    (bundle / "config.yaml").write_text(body + "\n")
    return bundle


def test_effective_reads_parser_not_registry(tmp_path):
    """VAL-ATTACH-015: helper output tracks the bundle guardrails, not registry.

    POLICY_REGISTRY is fully populated in both cases; the helper must return the
    attached set for a bundle with guardrails and the empty set for one without.
    """
    assert len(rickgent_policies.POLICY_REGISTRY) == 6

    attached = _write_bundle(tmp_path / "with", with_guardrails=True)
    assert effective_attached_policies(attached) == {"scope_fence"}

    unattached = _write_bundle(tmp_path / "without", with_guardrails=False)
    assert effective_attached_policies(unattached) == set()


def test_registration_is_not_attachment(tmp_path):
    """VAL-ATTACH-026: full registration + empty attachment → empty effective set."""
    from omnigent.policies.registry import load_registry, is_registered_handler

    load_registry(extra_modules=["rickgent_policies"])
    assert is_registered_handler("rickgent_policies.scope_fence")
    assert is_registered_handler("rickgent_policies.autonomous_pr_flow")

    unattached = _write_bundle(tmp_path, with_guardrails=False)
    effective = effective_attached_policies(unattached)
    assert effective == set(), "registration must not count as attachment"
    assert not (REQUIRED_POLICIES <= effective)


# ── VAL-ATTACH-018 / 019 / 020 — convergence_gate advisory vs blocking ────────

_PHASE_ADVANCE = {"tool_name": "rickgent_phase_advance"}
_BUILD_GATE = {"tool_name": "rickgent_build_gate"}


def _failing_verdict(monkeypatch):
    monkeypatch.setattr(
        "rickgent_policies._rickgent_verdict",
        lambda check, data: {"passed": False, "failures": ["metric x < y"]},
    )


@pytest.mark.parametrize("phase", ["implement", "spec_conformance"])
def test_convergence_gate_advisory_on_phase_advance(phase, monkeypatch, caplog):
    """VAL-ATTACH-018/019: a failing gate on per-phase advance never DENYs."""
    _failing_verdict(monkeypatch)
    config = {"phase": phase, "gate_input": {"phase": phase}}
    with caplog.at_level("WARNING", logger="rickgent_policies"):
        result = convergence_gate(_PHASE_ADVANCE, config)
    assert result is None or result.get("result") != "DENY", (
        f"convergence_gate blocked {phase} advance: {result!r}"
    )
    assert any("advisory" in rec.getMessage().lower() for rec in caplog.records), (
        "advisory convergence verdict was not logged"
    )


def test_convergence_gate_advisory_missing_gate_input(monkeypatch):
    """VAL-ATTACH-018: even missing gate_input is advisory on per-phase advance."""
    result = convergence_gate(_PHASE_ADVANCE, {"phase": "implement"})
    assert result is None or result.get("result") != "DENY"


def test_convergence_gate_blocking_on_build_gate(monkeypatch):
    """VAL-ATTACH-020: the build/full-PR gate can still DENY a failing verdict."""
    _failing_verdict(monkeypatch)
    config = {"phase": "build", "gate_input": {"phase": "build"}}
    result = convergence_gate(_BUILD_GATE, config)
    assert result is not None and result.get("result") == "DENY", (
        f"build gate did not block failing verdict: {result!r}"
    )
    assert result.get("code") == "GATE_FAILED"


def test_convergence_gate_build_gate_passes_when_green(monkeypatch):
    """VAL-ATTACH-020: the build gate ALLOWs a passing verdict."""
    monkeypatch.setattr(
        "rickgent_policies._rickgent_verdict",
        lambda check, data: {"passed": True},
    )
    config = {"phase": "build", "gate_input": {"phase": "build"}}
    result = convergence_gate(_BUILD_GATE, config)
    assert result is not None and result.get("result") == "ALLOW"
