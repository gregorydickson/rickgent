"""A-SEC-1 — autonomous_pr_flow git-push authorization hardening.

Only an explicit narrow push to the run's own feature branch
(`git push origin <feature>` or `git push origin HEAD:<feature>`) may ALLOW.
Every force/delete/mirror/all/tags refspec, symbolic/bare/remote-only
destination, and separator/prefix bypass must return None or DENY.

Convention (validation-contract.md):
  evaluate(policy, event, feature_branch=...) invokes the shim on a synthetic
  omnigent event and returns its dict verdict or None (abstain).
  shell_event(cmd, cwd=...) builds a tool_call event carrying the command.
"""

import pytest
from rickgent_policies import autonomous_pr_flow, scope_fence

_POLICIES = {
    "autonomous_pr_flow": autonomous_pr_flow,
    "scope_fence": scope_fence,
}


def shell_event(cmd, cwd=None):
    event = {"type": "tool_call", "tool_name": "Bash", "arguments": {"command": cmd}}
    if cwd is not None:
        event["cwd"] = cwd
    return event


def evaluate(policy, event, feature_branch=None):
    config = {}
    if feature_branch is not None:
        config["feature_branch"] = feature_branch
    return _POLICIES[policy](event, config)


def _is_allow(verdict) -> bool:
    return isinstance(verdict, dict) and str(verdict.get("result", "")).upper() == "ALLOW"


FB = "feature/x"


class TestNeverAllows:
    """Verdict must be None or DENY (never ALLOW)."""

    @pytest.mark.parametrize(
        "cmd",
        [
            # VAL-SEC-001: force-refspec +main
            "git push origin +main",
            # VAL-SEC-002: colon delete-refspec :main
            "git push origin :main",
            # VAL-SEC-003: --mirror
            "git push origin --mirror",
            # VAL-SEC-004: --all
            "git push origin --all",
            # VAL-SEC-005: delete flags
            "git push origin --delete feature/x",
            "git push origin -d feature/x",
            # VAL-SEC-006: force flags (even to own branch)
            "git push --force origin feature/x",
            "git push -f origin feature/x",
            "git push --force-with-lease origin feature/x",
            # VAL-SEC-007: --tags
            "git push origin --tags",
            # VAL-SEC-008: bare push
            "git push",
            # VAL-SEC-009: remote only, no ref
            "git push origin",
            # VAL-SEC-010: symbolic HEAD destination
            "git push origin HEAD",
            # VAL-SEC-011: chained && bypass
            "cd sub && git push --force origin main",
            # VAL-SEC-012: semicolon-prefixed bypass
            "true ; git push --force origin main",
            # VAL-SEC-013: sudo-prefixed bypass
            "sudo git push --force origin main",
            # VAL-SEC-014: git -C global-option bypass
            "git -C dir push --force origin main",
            # VAL-SEC-015: env-assignment-prefixed bypass
            "FOO=1 git push --force origin main",
            # VAL-SEC-016: wrong (non-own) branch
            "git push origin feature/y",
            # VAL-SEC-052: pipe-separated force-push bypass
            "true | git push --force origin main",
            # VAL-SEC-053: newline-separated force-push bypass
            "true\ngit push --force origin main",
            # VAL-SEC-054: || and & separators
            "false || git push --force origin main",
            "git push --force origin main &",
            # VAL-SEC-055: narrow-allowed push combined with destructive segment
            "git push origin feature/x ; rm -rf /",
            "git push origin feature/x && terraform destroy",
        ],
    )
    def test_never_allows(self, cmd):
        verdict = evaluate("autonomous_pr_flow", shell_event(cmd), feature_branch=FB)
        assert verdict is None or not _is_allow(verdict), (
            f"command must not ALLOW: {cmd!r} -> {verdict!r}"
        )


class TestNarrowAllow:
    """The two permitted narrow shapes to the run's own feature branch."""

    def test_exact_narrow_feature_push_allows(self):
        # VAL-SEC-017
        verdict = evaluate("autonomous_pr_flow", shell_event("git push origin feature/x"), feature_branch=FB)
        assert _is_allow(verdict), verdict

    def test_narrow_head_refspec_push_allows(self):
        # VAL-SEC-018
        verdict = evaluate("autonomous_pr_flow", shell_event("git push origin HEAD:feature/x"), feature_branch=FB)
        assert _is_allow(verdict), verdict


class TestWhitelistIsBranchScoped:
    """Narrow allow requires the destination to equal the run's OWN branch."""

    def test_own_branch_required_for_allow(self):
        # Same command shape, but the run owns a different branch -> never ALLOW.
        verdict = evaluate("autonomous_pr_flow", shell_event("git push origin feature/x"), feature_branch="feature/z")
        assert verdict is None or not _is_allow(verdict), verdict

    def test_missing_feature_branch_fails_closed(self):
        # No feature branch known -> cannot prove own-branch push -> never ALLOW.
        verdict = evaluate("autonomous_pr_flow", shell_event("git push origin feature/x"))
        assert verdict is None or not _is_allow(verdict), verdict
