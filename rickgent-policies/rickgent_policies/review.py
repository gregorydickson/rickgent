"""Canonical cross-vendor review boundary."""

from __future__ import annotations

from .native import adapt_authenticated, denial_result, fail_closed
from .policy_event import PolicyAbstention, PolicyDenial


CROSS_VENDOR_DENIAL_CODE = "RICKGENT_CROSS_VENDOR_DENIED"


def _deny(detail: str) -> dict[str, str]:
    return {
        "result": "DENY",
        "reason": f"{CROSS_VENDOR_DENIAL_CODE}: {detail}",
        "code": CROSS_VENDOR_DENIAL_CODE,
    }


def cross_vendor_review(event: object, config: object):
    try:
        outcome = adapt_authenticated(event, config)
        if isinstance(outcome, PolicyDenial):
            return denial_result(outcome)
        if isinstance(outcome, PolicyAbstention) or outcome.action != "phase_advance":
            return None
        if outcome.native_phase != "tool_call":
            return None
        if outcome.lifecycle_phase != "code_review":
            return None
        # The effective-session-v1 attempt context authenticates only the
        # requested reviewer.  Vendor labels in arguments, context, or session
        # state cannot prove a distinct protected implementer identity.
        return _deny("protected implementer/reviewer identity pair is unavailable")
    except Exception:
        return fail_closed(CROSS_VENDOR_DENIAL_CODE, "cross-vendor review policy")


__all__ = ["CROSS_VENDOR_DENIAL_CODE", "cross_vendor_review"]
