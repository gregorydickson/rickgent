"""A-SEC-1 (scrutiny) — close two push-authorization prefix bypasses in autonomous_pr_flow.

VAL-SEC-058: `sudo -u root git push --force origin main` — incomplete sudo
  option/argument consumption used to drop `git` off the front of the segment,
  so the downstream `git push --force` evaded push detection and abstained.
  The force push MUST be detected and DENIED.

VAL-SEC-059: `sudo git push origin feature/x` / `FOO=1 git push origin feature/x`
  — a sudo/env-assignment prefix used to be stripped before the narrow-allow
  shape check, so an own-branch push behind a prefix wrongly ALLOWed. The
  narrow ALLOW requires the ENTIRE command to be a single UNPREFIXED segment
  exactly `git push origin <feature>` / `HEAD:<feature>`; any prefix disqualifies.

Convention (validation-contract.md):
  evaluate(policy, event, feature_branch=...) invokes the shim on a synthetic
  omnigent event and returns its dict verdict or None (abstain).
  shell_event(cmd) builds a tool_call event carrying the command.
"""

import pytest
from rickgent_policies import autonomous_pr_flow


def shell_event(cmd):
    return {"type": "tool_call", "tool_name": "Bash", "arguments": {"command": cmd}}


def evaluate(event, feature_branch=None):
    config = {}
    if feature_branch is not None:
        config["feature_branch"] = feature_branch
    return autonomous_pr_flow(event, config)


def _is_allow(verdict) -> bool:
    return isinstance(verdict, dict) and str(verdict.get("result", "")).upper() == "ALLOW"


def _is_deny(verdict) -> bool:
    return isinstance(verdict, dict) and str(verdict.get("result", "")).upper() == "DENY"


FB = "feature/x"


class TestSudoOptionsForcePushDetected:
    """VAL-SEC-058: sudo option/argument consumption must not hide the push."""

    @pytest.mark.parametrize(
        "cmd",
        [
            "sudo -u root git push --force origin main",
            "sudo -u root git push -f origin main",
            "sudo --user root git push --force origin main",
            "sudo -n -u root git push --force origin main",
        ],
    )
    def test_sudo_options_force_push_denies(self, cmd):
        verdict = evaluate(shell_event(cmd), feature_branch=FB)
        assert _is_deny(verdict), (
            f"sudo-with-options force push must DENY: {cmd!r} -> {verdict!r}"
        )


class TestPrefixedOwnBranchPushNotNarrowAllow:
    """VAL-SEC-059: a prefix disqualifies the narrow-allow shape."""

    @pytest.mark.parametrize(
        "cmd",
        [
            "sudo git push origin feature/x",
            "FOO=1 git push origin feature/x",
            "sudo -u root git push origin feature/x",
            "FOO=1 BAR=2 git push origin feature/x",
            "sudo git push origin HEAD:feature/x",
            "FOO=1 git push origin HEAD:feature/x",
        ],
    )
    def test_prefixed_own_branch_push_never_allows(self, cmd):
        verdict = evaluate(shell_event(cmd), feature_branch=FB)
        assert verdict is None or not _is_allow(verdict), (
            f"prefixed own-branch push must not ALLOW: {cmd!r} -> {verdict!r}"
        )


class TestUnprefixedOwnBranchPushStillAllows:
    """No regression: the unprefixed narrow shapes still ALLOW."""

    @pytest.mark.parametrize(
        "cmd",
        [
            "git push origin feature/x",
            "git push origin HEAD:feature/x",
        ],
    )
    def test_unprefixed_own_branch_push_allows(self, cmd):
        verdict = evaluate(shell_event(cmd), feature_branch=FB)
        assert _is_allow(verdict), f"unprefixed own-branch push must ALLOW: {cmd!r} -> {verdict!r}"
