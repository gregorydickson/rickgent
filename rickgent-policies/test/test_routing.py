"""B8 / M4 — Multi-vendor model routing (VAL-ROUTE-001..005).

Black-box, behavior-based tests for the router that selects a harness/model
per role/task from the live roster, fails closed on an empty/unavailable
roster, enforces cross-vendor review (the review role excludes the
implementer's vendor), and denies/asks unpriced/over-budget selections
BEFORE dispatch.
"""

import inspect
import pytest
from rickgent_policies import select_model


# ── Fixture rosters ──────────────────────────────────────────────────────────

MULTI_VENDOR_ROSTER = [
    {
        "harness": "claude",
        "model": "anthropic/claude-haiku-4",
        "vendor": "anthropic",
        "tier": "cheap",
        "pricing": {"cost_per_dispatch": 0.05},
    },
    {
        "harness": "claude",
        "model": "anthropic/claude-sonnet-4-20250514",
        "vendor": "anthropic",
        "tier": "mid",
        "pricing": {"cost_per_dispatch": 0.50},
    },
    {
        "harness": "codex",
        "model": "openai/gpt-5-mini",
        "vendor": "openai",
        "tier": "cheap",
        "pricing": {"cost_per_dispatch": 0.04},
    },
    {
        "harness": "codex",
        "model": "openai/gpt-5",
        "vendor": "openai",
        "tier": "capable",
        "pricing": {"cost_per_dispatch": 2.00},
    },
    {
        "harness": "qwen",
        "model": "qwen/qwen-coder",
        "vendor": "alibaba",
        "tier": "mid",
        "pricing": {"cost_per_dispatch": 0.10},
    },
]

UNPRICED_ROSTER = [
    {
        "harness": "claude",
        "model": "anthropic/claude-sonnet-4-20250514",
        "vendor": "anthropic",
        "tier": "mid",
        "pricing": None,
    },
]

MIXED_PRICED_UNPRICED_ROSTER = [
    {
        "harness": "claude",
        "model": "anthropic/claude-sonnet-4-20250514",
        "vendor": "anthropic",
        "tier": "mid",
        "pricing": None,
    },
    {
        "harness": "codex",
        "model": "openai/gpt-5-mini",
        "vendor": "openai",
        "tier": "cheap",
        "pricing": {"cost_per_dispatch": 0.04},
    },
]


# ── VAL-ROUTE-001: Router selects per role/task from the live roster ────────


class TestRouterSelectsFromRoster:
    """VAL-ROUTE-001: Worker/manager are not hardcoded to one vendor; the
    router selects per role/task from the live roster."""

    def test_returns_allow_with_selection_from_roster(self):
        result = select_model(MULTI_VENDOR_ROSTER, role="implement")
        assert result["result"] == "ALLOW"
        sel = result["selection"]
        assert sel["harness"] in {"claude", "codex", "qwen"}
        assert sel["model"] in {
            "anthropic/claude-haiku-4",
            "anthropic/claude-sonnet-4-20250514",
            "openai/gpt-5-mini",
            "openai/gpt-5",
            "qwen/qwen-coder",
        }

    def test_different_roles_resolve_to_different_selections(self):
        """A multi-vendor roster yields different harness/model selections
        for different roles (not a single hardcoded constant)."""
        sel_implement = select_model(MULTI_VENDOR_ROSTER, role="implement")
        sel_research = select_model(MULTI_VENDOR_ROSTER, role="research")
        assert sel_implement["result"] == "ALLOW"
        assert sel_research["result"] == "ALLOW"
        # The implement role prefers a capable model; the research role prefers
        # a cheap one. With this roster they MUST NOT both resolve to the same
        # model — that would mean the router is a hardcoded constant.
        imp_model = sel_implement["selection"]["model"]
        res_model = sel_research["selection"]["model"]
        assert imp_model != res_model, (
            f"Router returned the same model ({imp_model}) for implement and "
            f"research — it is hardcoded to one selection, not role-aware."
        )

    def test_selection_harness_is_from_roster(self):
        """A harness absent from the roster is never selected."""
        result = select_model(MULTI_VENDOR_ROSTER, role="implement")
        roster_harnesses = {m["harness"] for m in MULTI_VENDOR_ROSTER}
        assert result["result"] == "ALLOW"
        assert result["selection"]["harness"] in roster_harnesses

    def test_not_hardcoded_to_claude(self):
        """The router is not pinned to a single claude/anthropic vendor.

        With a roster where the only capable model is a non-claude vendor,
        the implement role (which prefers capable) must select that vendor.
        """
        roster = [
            {
                "harness": "codex",
                "model": "openai/gpt-5",
                "vendor": "openai",
                "tier": "capable",
                "pricing": {"cost_per_dispatch": 2.00},
            },
            {
                "harness": "claude",
                "model": "anthropic/claude-haiku-4",
                "vendor": "anthropic",
                "tier": "cheap",
                "pricing": {"cost_per_dispatch": 0.05},
            },
        ]
        result = select_model(roster, role="implement")
        assert result["result"] == "ALLOW"
        assert result["selection"]["vendor"] == "openai"


# ── VAL-ROUTE-002: Review role excludes the implementer's vendor ────────────


class TestCrossVendorReviewRouting:
    """VAL-ROUTE-002: the router assigns the review role a vendor different
    from the implementer's, and this is enforced by the router (not opt-in)."""

    def test_review_excludes_implementer_vendor(self):
        """For an implementer vendor V, the review-role selection has
        vendor != V."""
        result = select_model(
            MULTI_VENDOR_ROSTER,
            role="code_review",
            implementer_vendor="anthropic",
        )
        assert result["result"] == "ALLOW"
        assert result["selection"]["vendor"] != "anthropic"

    def test_review_excludes_implementer_vendor_openai(self):
        result = select_model(
            MULTI_VENDOR_ROSTER,
            role="code_review",
            implementer_vendor="openai",
        )
        assert result["result"] == "ALLOW"
        assert result["selection"]["vendor"] != "openai"

    def test_review_fails_closed_when_only_implementer_vendor_available(self):
        """If only the implementer's vendor is available for review, the
        router fails closed (DENY) rather than dispatching a same-vendor
        reviewer."""
        single_vendor_roster = [
            {
                "harness": "claude",
                "model": "anthropic/claude-sonnet-4-20250514",
                "vendor": "anthropic",
                "tier": "mid",
                "pricing": {"cost_per_dispatch": 0.50},
            },
        ]
        result = select_model(
            single_vendor_roster,
            role="code_review",
            implementer_vendor="anthropic",
        )
        assert result["result"] == "DENY"
        assert result["code"] == "NO_CANDIDATES"

# ── VAL-ROUTE-003: Unpriced/over-budget model is denied/asked before dispatch


class TestCostGateBeforeDispatch:
    """VAL-ROUTE-003: the cost policy rejects an unpriced model (DENY,
    fail-closed) and an over-budget selection (DENY hard / ASK soft) before
    any worker is dispatched."""

    def test_unpriced_model_is_denied(self):
        """Selecting an unpriced model → DENY and no dispatch occurs."""
        result = select_model(
            UNPRICED_ROSTER,
            role="implement",
            cost_budget_usd=10.0,
        )
        assert result["result"] == "DENY"
        assert result["code"] == "NO_PRICED_MODEL"
        # No selection is returned → no dispatch occurs.
        assert "selection" not in result

    def test_unpriced_model_skipped_when_priced_alternative_exists(self):
        """When a priced alternative exists, the router selects it instead
        of the unpriced model (unpriced is skipped, not selected)."""
        result = select_model(
            MIXED_PRICED_UNPRICED_ROSTER,
            role="implement",
            cost_budget_usd=10.0,
        )
        assert result["result"] == "ALLOW"
        # The priced model (openai) is selected, not the unpriced one (anthropic).
        assert result["selection"]["vendor"] == "openai"

    def test_over_budget_model_is_denied(self):
        """An over-hard-budget model → DENY and no dispatch occurs."""
        roster = [
            {
                "harness": "codex",
                "model": "openai/gpt-5",
                "vendor": "openai",
                "tier": "capable",
                "pricing": {"cost_per_dispatch": 5.00},
            },
        ]
        result = select_model(
            roster,
            role="implement",
            cost_budget_usd=1.0,
        )
        assert result["result"] == "DENY"
        assert result["code"] == "NO_PRICED_MODEL"
        assert "selection" not in result

    def test_over_soft_threshold_model_is_ask(self):
        """A model over the soft threshold but under the hard budget → ASK."""
        roster = [
            {
                "harness": "claude",
                "model": "anthropic/claude-sonnet-4-20250514",
                "vendor": "anthropic",
                "tier": "mid",
                "pricing": {"cost_per_dispatch": 0.80},
            },
        ]
        result = select_model(
            roster,
            role="implement",
            cost_budget_usd=1.0,
            soft_threshold_usd=0.50,
        )
        assert result["result"] == "ASK"
        assert result["code"] == "OVER_SOFT_THRESHOLD"

    def test_no_dispatch_on_deny(self):
        """When the router returns DENY, no selection is provided — the caller
        must not dispatch. The DENY verdict IS the pre-dispatch gate."""
        result = select_model(
            UNPRICED_ROSTER,
            role="implement",
            cost_budget_usd=10.0,
        )
        assert result["result"] == "DENY"
        # No selection field → caller cannot dispatch.
        assert "selection" not in result

    def test_no_dispatch_on_over_budget_deny(self):
        roster = [
            {
                "harness": "codex",
                "model": "openai/gpt-5",
                "vendor": "openai",
                "tier": "capable",
                "pricing": {"cost_per_dispatch": 100.0},
            },
        ]
        result = select_model(roster, role="implement", cost_budget_usd=1.0)
        assert result["result"] == "DENY"
        assert "selection" not in result


# ── VAL-ROUTE-005: Fails closed on empty/unavailable roster ─────────────────


class TestRosterFailClosed:
    """VAL-ROUTE-005: the router selects only from the live roster and fails
    closed on an empty/unavailable roster (no dispatch, no silent fallback
    to a hardcoded vendor)."""

    def test_empty_roster_is_denied(self):
        result = select_model([], role="implement")
        assert result["result"] == "DENY"
        assert result["code"] == "ROSTER_EMPTY"
        assert "selection" not in result

    def test_none_roster_is_denied(self):
        result = select_model(None, role="implement")
        assert result["result"] == "DENY"
        assert result["code"] == "ROSTER_EMPTY"

    def test_harness_absent_from_roster_is_never_selected(self):
        """A harness absent from the roster is never selected, even when it
        would be the preferred tier for the role."""
        # Only claude harness in the roster; codex is absent.
        claude_only = [
            {
                "harness": "claude",
                "model": "anthropic/claude-sonnet-4-20250514",
                "vendor": "anthropic",
                "tier": "mid",
                "pricing": {"cost_per_dispatch": 0.50},
            },
        ]
        result = select_model(claude_only, role="implement")
        assert result["result"] == "ALLOW"
        assert result["selection"]["harness"] == "claude"
        assert result["selection"]["harness"] != "codex"

    def test_no_silent_fallback_to_hardcoded_vendor(self):
        """An empty roster does NOT silently fall back to a hardcoded vendor
        (e.g., 'claude'). It fails closed with DENY."""
        result = select_model([], role="implement")
        assert result["result"] == "DENY"
        # No selection with a hardcoded default.
        assert "selection" not in result

    def test_restricted_roster_excludes_absent_vendor(self):
        """When a vendor is excluded from the roster, it is never selected."""
        restricted = [m for m in MULTI_VENDOR_ROSTER if m["vendor"] != "anthropic"]
        result = select_model(restricted, role="implement")
        assert result["result"] == "ALLOW"
        assert result["selection"]["vendor"] != "anthropic"

    def test_router_fails_closed_on_exception(self):
        """Malformed input (non-list roster) fails closed to DENY."""
        result = select_model("not-a-list", role="implement")
        assert result["result"] == "DENY"


# ── Hardening #4: select_model task parameter removed ─────────────────────
# The `task` parameter was accepted but never used in selection. Per the
# hardening requirement, it is removed (not silently ignored).


class TestTaskParameterRemoved:
    """Hardening #4: the `task` parameter is removed from select_model."""

    def test_task_not_in_signature(self):
        """The function signature must not include `task`."""
        sig = inspect.signature(select_model)
        assert "task" not in sig.parameters, (
            f"select_model still accepts an unused `task` parameter: "
            f"{list(sig.parameters)}"
        )

    def test_task_keyword_rejected(self):
        """Passing task=... raises TypeError (unexpected keyword argument)."""
        with pytest.raises(TypeError):
            select_model(MULTI_VENDOR_ROSTER, role="implement", task="codegen")


# ── Hardening #5: Tier-sort ties broken by tier proximity, not vendor ─────
# The sort key used abs(pref_idx - tier_idx), producing ties broken
# alphabetically by vendor. The fix breaks ties by tier proximity (prefer
# the cheaper adjacent tier), not by vendor name.


class TestTierSortTieBreak:
    """Hardening #5: abs() ties in tier distance are broken by tier proximity
    (cheaper tier preferred), not by alphabetical vendor ordering."""

    def test_equidistant_tiers_cheap_preferred_over_capable(self):
        """When preferred=mid, both cheap (idx=0) and capable (idx=2) are
        abs-distance 1. The tie must be broken by tier proximity (cheaper
        first), NOT by vendor name. So a cheap model with vendor 'zzz' is
        preferred over a capable model with vendor 'aaa'."""
        roster = [
            {
                "harness": "h1",
                "model": "m-capable",
                "vendor": "aaa",
                "tier": "capable",
                "pricing": {"cost_per_dispatch": 0.10},
            },
            {
                "harness": "h2",
                "model": "m-cheap",
                "vendor": "zzz",
                "tier": "cheap",
                "pricing": {"cost_per_dispatch": 0.10},
            },
        ]
        result = select_model(roster, role="plan")  # prefers mid
        assert result["result"] == "ALLOW"
        # Both are abs=1 from mid. Current (buggy) code breaks by vendor:
        # "aaa" < "zzz" → picks capable/aaa. Fixed code breaks by tier
        # proximity: cheap (idx=0) preferred over capable (idx=2).
        assert result["selection"]["vendor"] == "zzz"
        assert result["selection"]["model"] == "m-cheap"

    def test_equidistant_tiers_not_alphabetical(self):
        """Explicitly verify the selection is NOT the alphabetically-first
        vendor when tiers are equidistant."""
        roster = [
            {
                "harness": "h1",
                "model": "m-capable",
                "vendor": "aaa",
                "tier": "capable",
                "pricing": {"cost_per_dispatch": 0.10},
            },
            {
                "harness": "h2",
                "model": "m-cheap",
                "vendor": "bbb",
                "tier": "cheap",
                "pricing": {"cost_per_dispatch": 0.10},
            },
        ]
        result = select_model(roster, role="plan")  # prefers mid
        assert result["result"] == "ALLOW"
        # Buggy: "aaa" (capable) selected. Fixed: "bbb" (cheap) selected.
        assert result["selection"]["vendor"] == "bbb"
