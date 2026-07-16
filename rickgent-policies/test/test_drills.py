"""Routing and cost planted-failure drills.

Native attached-policy drills live in ``test_native_function_policy_corpus``;
this module retains the independent router boundary cases.
"""


class TestUnpricedModelDispatch:
    """Drill 12 / VAL-ROUTE-003: unpriced model → cost gate DENY before dispatch.

    The cost drill exercises the REAL router cost gate (no empty pass).
    An unpriced model is DENIED (fail-closed); an over-budget model is
    DENIED (hard) / ASK (soft) — all before dispatch.
    """
    def test_unpriced_model_blocked(self):
        from rickgent_policies import select_model
        roster = [
            {
                "harness": "claude",
                "model": "anthropic/claude-sonnet-4-20250514",
                "vendor": "anthropic",
                "tier": "mid",
                "pricing": None,
            },
        ]
        result = select_model(roster, role="implement", cost_budget_usd=10.0)
        assert result["result"] == "DENY"
        assert result["code"] == "NO_PRICED_MODEL"
        assert "selection" not in result

    def test_over_budget_model_denied(self):
        from rickgent_policies import select_model
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

    def test_over_soft_threshold_asks(self):
        """Over soft threshold but under hard budget → ASK (soft threshold).

        The cost policy distinguishes hard DENY (over budget) from soft ASK
        (over a warning threshold but still within budget). This exercises the
        real select_model soft-threshold branch — a pass placeholder or a
        concept-only assertion would not reach this code path.
        """
        from rickgent_policies import select_model
        roster = [
            {
                "harness": "claude",
                "model": "anthropic/claude-opus-4",
                "vendor": "anthropic",
                "tier": "capable",
                "pricing": {"cost_per_dispatch": 5.0},
            },
        ]
        result = select_model(
            roster,
            role="implement",
            cost_budget_usd=10.0,
            soft_threshold_usd=2.0,
        )
        assert result["result"] == "ASK"
        assert result["code"] == "OVER_SOFT_THRESHOLD"
        assert "selection" in result
        assert result["selection"]["model"] == "anthropic/claude-opus-4"

    def test_within_budget_model_allowed(self):
        """A priced model within budget → ALLOW (positive cost-gate path).

        Confirms the cost gate does not over-deny: a properly priced,
        within-budget model is ALLOWed. A mutation that makes the policy
        DENY all models (or ALLOW unpriced) would fail this test.
        """
        from rickgent_policies import select_model
        roster = [
            {
                "harness": "claude",
                "model": "anthropic/claude-sonnet-4-20250514",
                "vendor": "anthropic",
                "tier": "mid",
                "pricing": {"cost_per_dispatch": 1.0},
            },
        ]
        result = select_model(roster, role="implement", cost_budget_usd=10.0)
        assert result["result"] == "ALLOW"
        assert "selection" in result
        assert result["selection"]["model"] == "anthropic/claude-sonnet-4-20250514"
