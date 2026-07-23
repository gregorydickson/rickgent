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

The native policy composition is covered by the FunctionPolicy corpus. These
tests pin command classification without constructing a legacy event shape.
"""

import pytest

from rickgent_policies import classify_delivery_command
from rickgent_policies.delivery import _exact_owned_push


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
        classified = classify_delivery_command(cmd)
        assert classified.kind == "push"
        assert classified.destructive is True


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
        classified = classify_delivery_command(cmd)
        assert classified.kind == "push"
        assert classified.safe_prefix is False


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
        classified = classify_delivery_command(cmd)
        assert classified.kind == "push"
        assert classified.safe_prefix is True
        assert classified.destructive is False


class TestLegacyPushBypassCorpus:
    """Every historical push bypass remains outside the exact owned shape."""

    @pytest.mark.parametrize(
        "cmd",
        [
            "git push origin +rickgent/runs/run-001",
            "git push origin :rickgent/runs/run-001",
            "git push origin --mirror",
            "git push origin --all",
            "git push origin --delete rickgent/runs/run-001",
            "git push origin -d rickgent/runs/run-001",
            "git push --force origin rickgent/runs/run-001",
            "git push -f origin rickgent/runs/run-001",
            "git push --force-with-lease origin rickgent/runs/run-001",
            "git push origin --tags",
            "git push origin --prune rickgent/runs/run-001",
            "git push",
            "git push origin",
            "git push origin HEAD",
            "git push origin rickgent/runs/other-run",
            "git -C elsewhere push origin rickgent/runs/run-001",
            "sudo git push origin rickgent/runs/run-001",
            "FOO=1 git push origin rickgent/runs/run-001",
            "git push origin rickgent/runs/run-001 ; rm -rf /",
            "git push origin rickgent/runs/run-001 && terraform destroy",
            "git push origin rickgent/runs/run-001 | cat",
            "git push origin rickgent/runs/run-001\nrm -rf /",
        ],
    )
    def test_never_matches_exact_owned_push(self, cmd):
        classified = classify_delivery_command(cmd)
        assert not _exact_owned_push(classified, "rickgent/runs/run-001")


class TestExactPrCreateShape:
    def test_bare_pr_create_is_the_only_pr_shape(self):
        assert classify_delivery_command("gh pr create").kind == "pr"

    @pytest.mark.parametrize(
        "cmd",
        [
            "gh pr create --fill",
            "gh pr create --repo other/repo",
            "gh pr create unexpected",
            "gh pr create && gh repo delete owner/repo",
            "sudo gh pr create",
            "FOO=1 gh pr create",
        ],
    )
    def test_prefixed_or_extended_pr_create_is_not_authorizable(self, cmd):
        assert classify_delivery_command(cmd).kind != "pr"
