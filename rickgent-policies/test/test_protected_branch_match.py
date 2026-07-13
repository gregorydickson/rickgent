"""A-BUG-6 — protected-branch matching uses exact + slash-prefix rules, not substring.

A bare protected name (`main`, `master`, `dev`, ...) must match ONLY exactly.
A slash-suffixed entry (`release/`) matches by slash-prefix (`release/x`).
Substring/startswith matching wrongly denies `maintenance`, `developer`,
`master-plan`, etc.

Verified by driving the real `autonomous_pr_flow` policy: a push to a
protected destination fails closed with code PROTECTED_BRANCH_DENIED; a push to
a non-protected look-alike destination is NOT rejected as protected (it may
fall through to the generic whitelist DENY, but never PROTECTED_BRANCH_DENIED).
"""

import pytest
from rickgent_policies import autonomous_pr_flow, _is_protected


def shell_event(cmd):
    return {"type": "tool_call", "tool_name": "Bash", "arguments": {"command": cmd}}


def evaluate(cmd, feature_branch="feature/x"):
    return autonomous_pr_flow(shell_event(cmd), {"feature_branch": feature_branch})


def _protected_denied(verdict) -> bool:
    return isinstance(verdict, dict) and verdict.get("code") == "PROTECTED_BRANCH_DENIED"


class TestProtectedBranchMatcher:
    """Unit-level: the exact boolean the matcher must return."""

    @pytest.mark.parametrize("dest", ["main", "master", "trunk", "develop", "dev", "release/x"])
    def test_protected_destinations_match(self, dest):
        assert _is_protected(dest) is True, dest

    @pytest.mark.parametrize("dest", ["maintenance", "developer", "master-plan", "development", "trunkline"])
    def test_lookalike_destinations_not_protected(self, dest):
        # substring/startswith false-block: these must NOT match a bare protected name
        assert _is_protected(dest) is False, dest


class TestProtectedBranchFlow:
    """Behavior through the real policy (drives autonomous_pr_flow)."""

    def test_main_exact_denied(self):
        # VAL-BUG-018
        verdict = evaluate("git push origin main")
        assert _protected_denied(verdict), verdict

    def test_release_slash_prefix_denied(self):
        # VAL-BUG-019
        verdict = evaluate("git push origin release/x")
        assert _protected_denied(verdict), verdict

    @pytest.mark.parametrize("branch", ["maintenance", "developer", "master-plan"])
    def test_lookalike_not_protected_denied(self, branch):
        # VAL-BUG-017 / VAL-BUG-020 / VAL-BUG-021
        verdict = evaluate(f"git push origin {branch}")
        assert not _protected_denied(verdict), (branch, verdict)
