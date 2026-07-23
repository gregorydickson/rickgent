"""Canonical convergence-gate policy over authenticated lifecycle events."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .native import adapt_authenticated, denial_result, fail_closed
from .policy_event import FrozenValue, PolicyAbstention, PolicyDenial
from .verdict import _verified_verdict

CONVERGENCE_DENIAL_CODE = "RICKGENT_CONVERGENCE_DENIED"


def _thaw(value: FrozenValue) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [_thaw(child) for child in value]
    return value


def _deny(detail: str) -> dict[str, str]:
    return {
        "result": "DENY",
        "reason": f"{CONVERGENCE_DENIAL_CODE}: {detail}",
        "code": CONVERGENCE_DENIAL_CODE,
    }


def convergence_gate(event: object, config: object):
    """Keep phase advances advisory and make the native build gate blocking."""

    try:
        outcome = adapt_authenticated(event, config)
        if isinstance(outcome, PolicyDenial):
            return denial_result(outcome)
        if isinstance(outcome, PolicyAbstention):
            return None
        if outcome.action == "phase_advance":
            return None
        if outcome.action != "build_gate":
            return None
        if outcome.native_phase != "tool_call":
            return None
        if set(outcome.arguments) != {"gate"}:
            return _deny("build gate requires exactly one structured gate payload")
        candidate = outcome.arguments.get("gate")
        if not isinstance(candidate, Mapping):
            return _deny("build gate payload is missing or malformed")
        gate = _thaw(candidate)
        assert isinstance(gate, dict)
        gate["scope"] = [entry.path for entry in outcome.declared_scope]
        verdict = _verified_verdict("gate", gate)
        if verdict.get("error") is True:
            return _deny(f"verdict core failed: {verdict.get('code', 'POLICY_SHIM_ERROR')}")
        if verdict.get("passed") is not True:
            failures = verdict.get("failures")
            return _deny(f"gate did not converge: {failures!r}")
        return {"result": "ALLOW"}
    except Exception:
        return fail_closed(CONVERGENCE_DENIAL_CODE, "convergence policy")


__all__ = ["CONVERGENCE_DENIAL_CODE", "convergence_gate"]
