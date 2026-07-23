"""Deterministic multi-vendor model routing."""

from __future__ import annotations

_ROLE_TIER_PREFERENCE = {
    "research": "cheap",
    "research_review": "cheap",
    "plan": "mid",
    "plan_review": "mid",
    "implement": "capable",
    "spec_conformance": "mid",
    "code_review": "mid",
    "simplify": "cheap",
}
_TIER_FALLBACK = ["cheap", "mid", "capable"]


def _tier_sort_key(model, preferred_tier):
    tier = model.get("tier", "mid")
    try:
        preferred = _TIER_FALLBACK.index(preferred_tier) if preferred_tier in _TIER_FALLBACK else 1
        actual = _TIER_FALLBACK.index(tier) if tier in _TIER_FALLBACK else 1
    except ValueError:
        preferred, actual = 1, 1
    return (abs(preferred - actual), actual, model.get("vendor", ""), model.get("model", ""))


def select_model(
    roster,
    role,
    implementer_vendor=None,
    cost_budget_usd=None,
    soft_threshold_usd=None,
):
    try:
        if not roster or not isinstance(roster, list):
            return {"result": "DENY", "reason": "routing: empty or unavailable roster", "code": "ROSTER_EMPTY"}
        candidates = list(roster)
        if role == "code_review" and implementer_vendor:
            candidates = [model for model in candidates if model.get("vendor") != implementer_vendor]
        if not candidates:
            return {
                "result": "DENY",
                "reason": f"routing: no candidates for role '{role}' after constraints",
                "code": "NO_CANDIDATES",
            }
        preferred_tier = _ROLE_TIER_PREFERENCE.get(role, "mid")
        candidates.sort(key=lambda model: _tier_sort_key(model, preferred_tier))
        ask_candidate = None
        for model in candidates:
            pricing = model.get("pricing")
            if not isinstance(pricing, dict):
                continue
            cost = pricing.get("cost_per_dispatch")
            if not isinstance(cost, (int, float)):
                continue
            if isinstance(cost_budget_usd, (int, float)) and cost > cost_budget_usd:
                continue
            if isinstance(soft_threshold_usd, (int, float)) and cost > soft_threshold_usd:
                ask_candidate = ask_candidate or model
                continue
            return {
                "result": "ALLOW",
                "selection": {key: model[key] for key in ("harness", "model", "vendor")},
            }
        if ask_candidate is not None:
            return {
                "result": "ASK",
                "reason": "routing: only over-soft-threshold candidates available",
                "code": "OVER_SOFT_THRESHOLD",
                "selection": {key: ask_candidate[key] for key in ("harness", "model", "vendor")},
            }
        return {
            "result": "DENY",
            "reason": "routing: no priced/within-budget model available",
            "code": "NO_PRICED_MODEL",
        }
    except Exception as error:
        return {"result": "DENY", "reason": f"routing: {error}", "code": "ROUTING_ERROR"}


__all__ = ["select_model"]
