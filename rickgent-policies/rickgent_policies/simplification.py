"""Canonical subtract-before-add PRD validation policy."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .native import adapt_authenticated, denial_result, fail_closed
from .policy_event import FrozenValue, PolicyAbstention, PolicyDenial
from .verdict import _verified_verdict


SIMPLIFICATION_DENIAL_CODE = "RICKGENT_SIMPLIFICATION_DENIED"


def _thaw(value: FrozenValue) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [_thaw(child) for child in value]
    return value


def _deny(detail: str) -> dict[str, str]:
    return {
        "result": "DENY",
        "reason": f"{SIMPLIFICATION_DENIAL_CODE}: {detail}",
        "code": SIMPLIFICATION_DENIAL_CODE,
    }


def subtract_before_add(event: object, config: object):
    try:
        outcome = adapt_authenticated(event, config)
        if isinstance(outcome, PolicyDenial):
            return denial_result(outcome)
        if isinstance(outcome, PolicyAbstention) or outcome.action != "prd_validate":
            return None
        if outcome.native_phase != "tool_call":
            return None
        if set(outcome.arguments) != {"prd"}:
            return _deny("PRD validation requires exactly one structured PRD payload")
        candidate = outcome.arguments.get("prd")
        if not isinstance(candidate, Mapping):
            return _deny("PRD payload is missing or malformed")
        verdict = _verified_verdict("prd", _thaw(candidate))
        if verdict.get("error") is True:
            return _deny(f"verdict core failed: {verdict.get('code', 'POLICY_SHIM_ERROR')}")
        if verdict.get("valid") is not True:
            return _deny(f"PRD did not prove simplification review: {verdict.get('errors')!r}")
        return {"result": "ALLOW"}
    except Exception:
        return fail_closed(SIMPLIFICATION_DENIAL_CODE, "simplification policy")


__all__ = ["SIMPLIFICATION_DENIAL_CODE", "subtract_before_add"]
