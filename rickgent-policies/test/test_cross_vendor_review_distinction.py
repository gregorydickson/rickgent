"""M8 scrutiny round 4: Test that the approved distinction result reaches
the Python cross_vendor_review policy event.

The cross_vendor_review policy checks event.context.cross_vendor_distinction
(or event.arguments.cross_vendor_distinction) to determine whether the
distinction is genuine.  When the distinction is genuine (outcome=permitted,
genuine_distinction=True), the policy ALLOWS the code-review event.
When the distinction is absent or not genuine, the policy DENIES.

These tests mock the authentication layer (adapt_authenticated) to return
a valid CanonicalPolicyEvent so the distinction check is exercised directly.
"""

from __future__ import annotations

from unittest.mock import patch
from typing import Any

import pytest
from rickgent_policies.review import cross_vendor_review, CROSS_VENDOR_DENIAL_CODE
from rickgent_policies.policy_event import (
    CanonicalPolicyEvent,
    RequestedModelIdentity,
    RuntimeProvenance,
    TicketScopeEntry,
)


# ── Fixtures ─────────────────────────────────────────────────────────────

BUNDLE_SHA = "e" * 64
CONFIG_SHA = "f" * 64
TICKET_SHA = "sha256:" + "c" * 64
ATTEMPT_SHA = "d" * 64
CONTEXT_SHA = "a" * 64
OWNER_SHA = "b" * 64


def _make_identity() -> RequestedModelIdentity:
    return RequestedModelIdentity(
        normalization_version="rickgent-identity-normalization/v1",
        raw_harness="codex",
        canonical_harness="codex",
        raw_provider="openai",
        canonical_provider="openai",
        raw_vendor="openai",
        canonical_vendor="openai",
        raw_model_id="gpt-5",
        canonical_model_id="gpt-5",
        bundle_digest=f"sha256:{BUNDLE_SHA}",
        config_digest=f"sha256:{CONFIG_SHA}",
        profile="effective-session-v1",
    )


def _make_provenance() -> RuntimeProvenance:
    return RuntimeProvenance(
        schema_version="rickgent-runtime-provenance/v2",
        omnigent_python_entrypoint="/usr/bin/python3",
        omnigent_python_realpath="/usr/bin/python3",
        omnigent_python_sha256="a" * 64,
        omnigent_root_realpath="/opt/omnigent",
        omnigent_origin_realpath="/opt/omnigent",
        rickgent_policies_origin_realpath="/opt/rickgent-policies",
        rickgent_policies_sha256="b" * 64,
        rickgent_node_realpath="/usr/bin/node",
        rickgent_node_sha256="c" * 64,
        rickgent_cli_realpath="/opt/rickgent/cli.js",
        rickgent_cli_sha256="d" * 64,
        rickgent_build_commit="abcdef0123456789",
    )


def _make_canonical_event(event: dict[str, Any]) -> CanonicalPolicyEvent:
    """Build a CanonicalPolicyEvent that passes the policy's phase checks."""
    return CanonicalPolicyEvent(
        native_phase="tool_call",
        kind="lifecycle",
        tool="rickgent_phase_advance",
        action="phase_advance",
        arguments=MappingProxyType({"next_phase": "code_review"}),
        result=None,
        source_endpoint=None,
        destination_endpoint=None,
        shell_result=None,
        dispatch_id="dispatch-1",
        run_id="run-1",
        ticket_id="t1",
        attempt=1,
        context_sha256=CONTEXT_SHA,
        ticket_contract_digest=TICKET_SHA,
        attempt_digest=f"sha256:{ATTEMPT_SHA}",
        role="reviewer",
        lifecycle_phase="code_review",
        target_repo_realpath="/repo",
        worktree_realpath="/worktree",
        state_root_realpath="/state",
        policy_root_realpath="/policy",
        bundle_root_realpath="/bundle",
        declared_scope=(TicketScopeEntry("src/test.ts", "modify", False),),
        requested_identity=_make_identity(),
        runtime_provenance=_make_provenance(),
    )


from collections.abc import Mapping  # noqa: E402
from types import MappingProxyType  # noqa: E402


def _patch_authenticated(event: dict[str, Any]):
    """Patch adapt_authenticated to return a valid CanonicalPolicyEvent
    so the distinction check is exercised directly."""
    canonical = _make_canonical_event(event)
    return patch(
        "rickgent_policies.review.adapt_authenticated",
        return_value=canonical,
    )


# ── Tests ────────────────────────────────────────────────────────────────


def test_cross_vendor_review_allows_when_distinction_is_genuine_in_context():
    """The policy ALLOWS when context.cross_vendor_distinction has
    outcome=permitted and genuine_distinction=True."""
    event = {
        "type": "tool_call",
        "target": "rickgent_phase_advance",
        "data": {"name": "rickgent_phase_advance", "arguments": {"next_phase": "code_review"}},
        "context": {
            "cross_vendor_distinction": {
                "outcome": "permitted",
                "genuine_distinction": True,
            }
        },
        "session_state": {},
        "llm_client": {},
    }
    with _patch_authenticated(event):
        result = cross_vendor_review(event, {})
    assert result is not None
    assert result["result"] == "ALLOW"
    assert "RICKGENT_CROSS_VENDOR_ALLOWED" in result["reason"]


def test_cross_vendor_review_allows_when_distinction_is_genuine_in_arguments():
    """The policy ALLOWS when arguments.cross_vendor_distinction has
    outcome=permitted and genuine_distinction=True."""
    event = {
        "type": "tool_call",
        "target": "rickgent_phase_advance",
        "data": {"name": "rickgent_phase_advance", "arguments": {"next_phase": "code_review"}},
        "context": {},
        "session_state": {},
        "llm_client": {},
        "arguments": {
            "cross_vendor_distinction": {
                "outcome": "permitted",
                "genuine_distinction": True,
            }
        },
    }
    with _patch_authenticated(event):
        result = cross_vendor_review(event, {})
    assert result is not None
    assert result["result"] == "ALLOW"


def test_cross_vendor_review_denies_when_distinction_is_absent():
    """The policy DENIES when no cross_vendor_distinction is present."""
    event = {
        "type": "tool_call",
        "target": "rickgent_phase_advance",
        "data": {"name": "rickgent_phase_advance", "arguments": {"next_phase": "code_review"}},
        "context": {},
        "session_state": {},
        "llm_client": {},
    }
    with _patch_authenticated(event):
        result = cross_vendor_review(event, {})
    assert result is not None
    assert result["result"] == "DENY"
    assert result["code"] == CROSS_VENDOR_DENIAL_CODE


def test_cross_vendor_review_denies_when_distinction_is_not_genuine():
    """The policy DENIES when the distinction is present but not genuine
    (outcome=denied or genuine_distinction=False)."""
    event = {
        "type": "tool_call",
        "target": "rickgent_phase_advance",
        "data": {"name": "rickgent_phase_advance", "arguments": {"next_phase": "code_review"}},
        "context": {
            "cross_vendor_distinction": {
                "outcome": "denied",
                "genuine_distinction": False,
            }
        },
        "session_state": {},
        "llm_client": {},
    }
    with _patch_authenticated(event):
        result = cross_vendor_review(event, {})
    assert result is not None
    assert result["result"] == "DENY"
    assert result["code"] == CROSS_VENDOR_DENIAL_CODE


def test_cross_vendor_review_denies_when_outcome_not_permitted():
    """The policy DENIES when outcome is not 'permitted' even if
    genuine_distinction is True."""
    event = {
        "type": "tool_call",
        "target": "rickgent_phase_advance",
        "data": {"name": "rickgent_phase_advance", "arguments": {"next_phase": "code_review"}},
        "context": {
            "cross_vendor_distinction": {
                "outcome": "denied",
                "genuine_distinction": True,
            }
        },
        "session_state": {},
        "llm_client": {},
    }
    with _patch_authenticated(event):
        result = cross_vendor_review(event, {})
    assert result is not None
    assert result["result"] == "DENY"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
