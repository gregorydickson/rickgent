"""Policy shim tests — fail-closed behavior."""

import json
import pytest
from rickgent_policies import scope_fence, completion_evidence, cross_vendor_review, autonomous_pr_flow


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
        result = autonomous_pr_flow(event, {})
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

    def test_allows_non_pr_commands(self):
        event = {"tool_name": "Bash", "arguments": {"command": "ls -la"}}
        result = autonomous_pr_flow(event, {})
        assert result["result"] == "ALLOW"

    def test_fails_closed_on_exception(self):
        result = autonomous_pr_flow(None, {})
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"
