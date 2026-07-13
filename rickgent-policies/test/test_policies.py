"""Policy shim tests — fail-closed behavior."""

import json
import pytest
from rickgent_policies import (
    scope_fence,
    completion_evidence,
    cross_vendor_review,
    autonomous_pr_flow,
    convergence_gate,
)


class TestScopeFence:
    def test_allows_write_in_scope(self):
        event = {"tool_name": "Write", "path": "src/auth/login.py"}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "ALLOW"

    def test_denies_write_outside_scope(self):
        event = {"tool_name": "Write", "path": "src/billing/invoice.py"}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_denies_path_traversal(self):
        event = {"tool_name": "Write", "path": "src/auth/../billing/invoice.py"}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_allows_non_write(self):
        event = {"tool_name": "Read", "path": "src/billing/invoice.py"}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "ALLOW"

    def test_denies_missing_ticket_id(self):
        event = {"tool_name": "Write", "path": "src/auth/login.py"}
        config = {}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_denies_unresolvable_target(self):
        event = {"tool_name": "Write", "path": ""}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_fails_closed_on_exception(self):
        event = None  # will cause AttributeError
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"

    # C4: expanded shell-write detection. Shell write commands are now
    # detected and proceed to the path check; without a path field on the
    # event they DENY as unresolvable (previously they ALLOWed by falling
    # through the narrow substring list).
    def test_detects_sed_inplace_write(self):
        event = {"tool_name": "Bash", "arguments": {"command": "sed -i 's/foo/bar/' file.py"}}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_detects_touch_write(self):
        event = {"tool_name": "Bash", "arguments": {"command": "touch new.py"}}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_detects_redirect_write(self):
        event = {"tool_name": "Bash", "arguments": {"command": "echo data > /etc/passwd"}}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_detects_append_redirect_write(self):
        event = {"tool_name": "Bash", "arguments": {"command": "echo data >> /etc/passwd"}}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"

    def test_allows_non_write_shell_command(self):
        event = {"tool_name": "Bash", "arguments": {"command": "ls -la src/auth/"}}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "ALLOW"


class TestCrossVendorReview:
    def test_denies_same_vendor(self):
        event = {"tool_name": "rickgent_phase_advance"}
        config = {"phase": "code_review", "implementer_vendor": "claude", "reviewer_vendor": "claude"}
        result = cross_vendor_review(event, config)
        assert result["result"] == "DENY"

    def test_allows_different_vendor(self):
        event = {"tool_name": "rickgent_phase_advance"}
        config = {"phase": "code_review", "implementer_vendor": "claude", "reviewer_vendor": "codex"}
        result = cross_vendor_review(event, config)
        assert result["result"] == "ALLOW"

    def test_allows_non_review_phase(self):
        event = {"tool_name": "rickgent_phase_advance"}
        config = {"phase": "implement", "implementer_vendor": "claude", "reviewer_vendor": "claude"}
        result = cross_vendor_review(event, config)
        assert result["result"] == "ALLOW"

    def test_denies_missing_vendor_labels(self):
        event = {"tool_name": "rickgent_phase_advance"}
        config = {"phase": "code_review"}
        result = cross_vendor_review(event, config)
        assert result["result"] == "DENY"

    def test_fails_closed_on_exception(self):
        result = cross_vendor_review(None, {})
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"


class TestAutonomousPrFlow:
    def test_allows_feature_branch_push(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push origin feature/auth-login"}}
        result = autonomous_pr_flow(event, {"feature_branch": "feature/auth-login"})
        assert result["result"] == "ALLOW"

    def test_denies_force_push(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push --force origin feature/auth"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "FORCE_PUSH_DENIED"

    def test_denies_push_to_main(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push origin main"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "PROTECTED_BRANCH_DENIED"

    def test_allows_gh_pr_create(self):
        event = {"tool_name": "Bash", "arguments": {"command": "gh pr create --title 'test' --body 'test'"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "ALLOW"

    def test_abstains_on_non_pr_commands(self):
        # A-SEC-2: a non-push/non-pr-create command abstains (None), never a
        # blanket ALLOW that would override blast_radius under ALLOW-precedence.
        event = {"tool_name": "Bash", "arguments": {"command": "ls -la"}}
        result = autonomous_pr_flow(event, {})
        assert result is None

    # C1: force-push flag at end of command
    def test_denies_force_push_flag_at_end(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push origin feature -f"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "FORCE_PUSH_DENIED"

    # C2: force-push via combined short flags
    def test_denies_combined_short_flag_uf(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push -uf origin feature"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "FORCE_PUSH_DENIED"

    def test_denies_combined_short_flag_fH(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push -fH origin feature"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "FORCE_PUSH_DENIED"

    def test_denies_force_with_lease(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push --force-with-lease origin feature"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "FORCE_PUSH_DENIED"

    # C3: protected-branch bypass via HEAD:branch / refs/heads/branch
    def test_denies_push_to_main_via_head(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push origin HEAD:main"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "PROTECTED_BRANCH_DENIED"

    def test_denies_push_to_main_via_refs_heads(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push origin refs/heads/main"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "PROTECTED_BRANCH_DENIED"

    def test_denies_push_to_release_via_head(self):
        event = {"tool_name": "Bash", "arguments": {"command": "git push origin HEAD:release/1.0"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "DENY"
        assert result["code"] == "PROTECTED_BRANCH_DENIED"

    def test_fails_closed_on_exception(self):
        result = autonomous_pr_flow(None, {})
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"


class TestConvergenceGate:
    """W6 / B4 — convergence_gate is ADVISORY on per-phase advance and
    BLOCKING only at the build/full-PR gate (`rickgent_build_gate`)."""

    def _event(self):
        return {"tool_name": "rickgent_phase_advance"}

    def _build_event(self):
        return {"tool_name": "rickgent_build_gate"}

    def test_gate_passing(self, monkeypatch):
        monkeypatch.setattr(
            "rickgent_policies._rickgent_verdict",
            lambda check, data: {"passed": True},
        )
        config = {"phase": "implement", "gate_input": {"phase": "implement"}}
        assert convergence_gate(self._event(), config)["result"] == "ALLOW"

    def test_gate_failing_is_advisory_on_phase_advance(self, monkeypatch):
        """A failing verdict on per-phase advance is advisory, never DENY."""
        monkeypatch.setattr(
            "rickgent_policies._rickgent_verdict",
            lambda check, data: {"passed": False, "failures": ["metric x < y"]},
        )
        config = {"phase": "implement", "gate_input": {"phase": "implement"}}
        result = convergence_gate(self._event(), config)
        assert result is None

    def test_stale_baseline_advisory_on_phase_advance(self, monkeypatch):
        """Not-passed on per-phase advance (stale baseline) is advisory, not DENY."""
        monkeypatch.setattr(
            "rickgent_policies._rickgent_verdict",
            lambda check, data: {"passed": False, "failures": ["stale baseline"]},
        )
        config = {"phase": "spec_conformance", "gate_input": {"phase": "spec_conformance"}}
        result = convergence_gate(self._event(), config)
        assert result is None

    def test_missing_gate_input_advisory_on_phase_advance(self):
        """Gate phase with no gate_input on per-phase advance → advisory (None)."""
        config = {"phase": "implement"}
        result = convergence_gate(self._event(), config)
        assert result is None

    def test_missing_gate_input_spec_conformance_advisory(self):
        config = {"phase": "spec_conformance"}
        result = convergence_gate(self._event(), config)
        assert result is None

    def test_non_gate_phase_allows_without_gate_input(self):
        """Non-gate phases do not require gate_input."""
        config = {"phase": "code_review"}
        result = convergence_gate(self._event(), config)
        assert result["result"] == "ALLOW"

    def test_build_gate_failing_blocks(self, monkeypatch):
        """The build/full-PR gate fails closed to DENY on a failing verdict."""
        monkeypatch.setattr(
            "rickgent_policies._rickgent_verdict",
            lambda check, data: {"passed": False, "failures": ["metric x < y"]},
        )
        config = {"phase": "build", "gate_input": {"phase": "build"}}
        result = convergence_gate(self._build_event(), config)
        assert result["result"] == "DENY"
        assert result["code"] == "GATE_FAILED"

    def test_build_gate_missing_gate_input_fail_closed(self):
        """Build gate with no gate_input → DENY (fail closed)."""
        result = convergence_gate(self._build_event(), {"phase": "build"})
        assert result["result"] == "DENY"
        assert result["code"] == "GATE_FAILED"

    def test_build_gate_verdict_error_fail_closed(self, monkeypatch):
        """Build gate: verdict error → DENY with POLICY_SHIM_ERROR."""
        monkeypatch.setattr(
            "rickgent_policies._rickgent_verdict",
            lambda check, data: {"error": True, "code": "POLICY_SHIM_ERROR"},
        )
        config = {"phase": "build", "gate_input": {"phase": "build"}}
        result = convergence_gate(self._build_event(), config)
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"

    def test_fail_closed_on_exception(self):
        result = convergence_gate(None, {})
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"
