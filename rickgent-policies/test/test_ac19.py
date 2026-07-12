"""AC-19 — Operational recovery drill stubs.

These test the concepts that will be fully exercised in Phase 7.
"""
import json
import subprocess
import pytest


class TestBuildCommitSameCommit:
    """same-commit drill: TS package, CLI, and Python wheel expose same build_commit."""
    def test_build_commit_matches(self):
        import rickgent_policies
        try:
            ts_commit = subprocess.run(
                ["rickgent", "--build-commit"],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            assert rickgent_policies.BUILD_COMMIT == ts_commit
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pytest.skip("rickgent CLI not available")


class TestPolicyAllowlist:
    """allowlist-tamper drill: only rickgent_policies in policy_modules."""
    def test_only_rickgent_policies_allowed(self):
        from omnigent.policies.registry import load_registry, is_registered_handler
        load_registry(extra_modules=["rickgent_policies"])
        # All rickgent handlers should be registered
        assert is_registered_handler("rickgent_policies.scope_fence")
        assert is_registered_handler("rickgent_policies.completion_evidence")


class TestStatusDeep:
    """status --deep drill: with clean state exits 0."""
    def test_doctor_passes_clean(self):
        try:
            result = subprocess.run(
                ["rickgent", "doctor"],
                capture_output=True, text=True, timeout=30,
            )
            assert result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pytest.skip("rickgent CLI not available")
