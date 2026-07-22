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


def _allow(detail: str) -> dict[str, str]:
    return {
        "result": "ALLOW",
        "reason": f"RICKGENT_CROSS_VENDOR_ALLOWED: {detail}",
        "code": "RICKGENT_CROSS_VENDOR_ALLOWED",
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

        # t32-fix: The cross-vendor distinction authority (TS-side) verifies
        # observed implementer/reviewer identity pairs after dispatch.  When
        # the distinction proof is present and genuine (distinct canonical
        # observed vendors with live-profile-strength observations), the
        # policy ALLOWS the code-review event.  When the distinction proof
        # is absent or not genuine, the policy DENIES.
        #
        # The distinction proof is carried in the event's context/arguments
        # as a structured field.  The policy checks for the presence of a
        # genuine cross-vendor distinction result.  If the distinction is
        # genuine, ALLOW; otherwise DENY.
        distinction_genuine = _check_distinction_genuine(event)
        if distinction_genuine:
            return _allow(
                "cross-vendor distinction is genuine: distinct canonical "
                "observed vendors with live-profile-strength observations"
            )
        # Label-only claims (no observed-identity distinction proof) are
        # denied.  The distinction check is performed by the TS authority
        # using observed identity receipts from the chat.db seam.
        return _deny(
            "protected implementer/reviewer identity pair requires "
            "observed-identity distinction proof from the t32 authority; "
            "label-only claims are denied"
        )
    except Exception:
        return fail_closed(CROSS_VENDOR_DENIAL_CODE, "cross-vendor review policy")


def _check_distinction_genuine(event: object) -> bool:
    """Check whether the event carries a genuine cross-vendor distinction proof.

    The distinction proof is a structured field in the event's context or
    arguments indicating that the TS-side evaluateCrossVendorDistinction
    authority has verified distinct canonical observed vendors with
    live-profile-strength observations.  When the proof is present and
    genuine, this returns True; otherwise False.
    """
    if not isinstance(event, dict):
        return False
    # Check for the distinction proof in the event context
    context = event.get("context")
    if isinstance(context, dict):
        distinction = context.get("cross_vendor_distinction")
        if isinstance(distinction, dict):
            outcome = distinction.get("outcome")
            genuine = distinction.get("genuine_distinction")
            if outcome == "permitted" and genuine is True:
                return True
    # Check for the distinction proof in the event arguments
    args = event.get("arguments")
    if isinstance(args, dict):
        distinction = args.get("cross_vendor_distinction")
        if isinstance(distinction, dict):
            outcome = distinction.get("outcome")
            genuine = distinction.get("genuine_distinction")
            if outcome == "permitted" and genuine is True:
                return True
    return False


__all__ = ["CROSS_VENDOR_DENIAL_CODE", "cross_vendor_review"]
