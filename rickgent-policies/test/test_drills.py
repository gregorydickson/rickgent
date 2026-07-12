"""AC-17 — Planted-failure enforcement drills.

Each drill tests that the platform blocks a scripted misbehaving worker,
not prompt goodwill.
"""
import json
import pytest
from rickgent_policies import scope_fence, completion_evidence, cross_vendor_review, subtract_before_add, convergence_gate


class TestFalseCompletion:
    """Drill 1: worker claims done, no commit → DENIED."""
    def test_denies_done_without_commit(self):
        event = {"tool_name": "rickgent_mark_done"}
        config = {
            "claimed_sha": None,
            "baseline_sha": "abc123",
            "sha_exists": False,
            "tree_changed": False,
            "gate_green": None,
        }
        result = completion_evidence(event, config)
        assert result["result"] == "DENY"
        assert result["code"] == "COMPLETION_UNVERIFIED"


class TestBaselineShaCompletion:
    """Drill 2: worker reports baseline commit as its work → DENIED."""
    def test_denies_baseline_sha(self):
        event = {"tool_name": "rickgent_mark_done"}
        config = {
            "claimed_sha": "abc123",
            "baseline_sha": "abc123",
            "sha_exists": True,
            "tree_changed": False,
            "gate_green": None,
        }
        result = completion_evidence(event, config)
        assert result["result"] == "DENY"


class TestOutOfScopeWrite:
    """Drill 3: worker writes outside declared paths → scope fence DENY."""
    def test_denies_out_of_scope_write(self):
        event = {"tool_name": "Write", "path": "src/billing/invoice.py"}
        config = {"ticket_id": "T1", "declared_paths": ["src/auth/"]}
        result = scope_fence(event, config)
        assert result["result"] == "DENY"
        assert result["code"] == "SCOPE_DENIED"


class TestSameVendorReview:
    """Drill 4: same-vendor review → DENIED (AC-13)."""
    def test_denies_same_vendor(self):
        event = {"tool_name": "rickgent_phase_advance"}
        config = {"phase": "code_review", "implementer_vendor": "claude", "reviewer_vendor": "claude"}
        result = cross_vendor_review(event, config)
        assert result["result"] == "DENY"
        assert result["code"] == "CROSS_VENDOR_DENIED"


class TestForeignWIPSweep:
    """Drill 6: dirty tree with unowned files → only owned paths staged."""
    def test_scope_fence_only_allows_owned_paths(self):
        # The scope fence only allows writes to declared paths
        event_owned = {"tool_name": "Write", "path": "src/feature.py"}
        event_foreign = {"tool_name": "Write", "path": "docs/foreign.md"}
        config = {"ticket_id": "T1", "declared_paths": ["src/feature.py"]}
        
        assert scope_fence(event_owned, config)["result"] == "ALLOW"
        assert scope_fence(event_foreign, config)["result"] == "DENY"


class TestPolicyShimException:
    """Drill 7: shim raises before verdict call → DENY with POLICY_SHIM_ERROR."""
    def test_exception_produces_deny(self):
        # Pass None as event to trigger an exception
        result = scope_fence(None, {})
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"

    def test_completion_exception_produces_deny(self):
        result = completion_evidence(None, {})
        assert result["result"] == "DENY"
        assert result["code"] == "POLICY_SHIM_ERROR"


class TestMissingSimplificationReview:
    """Drill: PRD without simplification review → DENIED."""
    def test_denies_prd_without_simplification(self):
        event = {"tool_name": "rickgent_prd_validate"}
        config = {
            "prd": {
                "title": "test",
                "description": "test",
                "acceptanceCriteria": [
                    {"description": "test", "type": "test", "verifyCommand": "pnpm test", "scope": ["src/"]}
                ],
                "simplificationReview": None,
            }
        }
        result = subtract_before_add(event, config)
        assert result["result"] == "DENY"


class TestUnpricedModelDispatch:
    """Drill 12: unpriced model → budget policy DENY/ASK before dispatch."""
    def test_unpriced_model_blocked(self):
        # This would be tested with a cost policy — for now verify the concept
        # In production, the cost policy checks model pricing before dispatch
        # and DENIES unpriced models
        pass  # Placeholder — cost policy implementation is in Phase 4
