# Decision: Cost Tracking

## Component
§2 matrix row — cost tracking / budget enforcement (per-session, per-user-daily, and per-dispatch LLM spend in USD).

## Omnigent implementation
Omnigent has no cost-advisor *tool*; cost is a substrate-level concern spread across four pieces:

1. **MLflow-fetched pricing** — `omnigent/llms/context_window.py`:
   - `ModelPricing` dataclass (`context_window.py:389`) holds per-token USD prices (input, output, cache-read, cache-create).
   - `fetch_model_pricing(model)` (`context_window.py:418`) looks up per-token pricing from the MLflow model catalog, fetched via `_fetch_mlflow_provider_catalog(provider)` (`context_window.py:184`) which downloads from `github.com/mlflow/mlflow/releases/download/model-catalog%2Flatest/{provider}.json` (`context_window.py:20`) with a 1-hour TTL cache. Returns `None` when pricing is unavailable.
   - `compute_llm_cost(usage, pricing)` (`context_window.py:507`) sums the four priced parts. When the catalog lacks cache rates, they are `None` and derived from the input rate.

2. **Budget policies** — `omnigent/policies/builtins/cost.py` ships three factory-registered policies:
   - `cost_budget(max_cost_usd, ask_thresholds_usd, expensive_models)` (`cost.py:cost_budget`) — gates a session on cumulative LLM spend at BOTH the `request` phase (before the LLM turn, so text-only turns are budgeted) and the `tool_call` phase (native `PreToolUse` block). Hard limit: once spend reaches `max_cost_usd`, DENY while still on an expensive model (a `/model` downgrade gate, not a hard stop); ALLOW once on a cheaper model. Soft limit: `ask_thresholds_usd` ASKs for approval the first time each checkpoint is crossed; approval is remembered in `session_state` so each checkpoint prompts at most once (`cost.py:74-130`).
   - `user_daily_cost_budget(max_cost_usd, ...)` (`cost.py:user_daily_cost_budget`) — identical gating logic but scoped to the session OWNER's cumulative spend across ALL their sessions for the current UTC day. Reads `event["context"]["user_daily_cost"]["cost_usd"]`; approval is recorded per user+day so it won't re-prompt today across sessions (`cost.py:298-381`).
   - `subagent_cost_budget(max_cost_usd, ...)` (`cost.py:subagent_cost_budget`) — scoped to a child conversation's subtree (itself + descendants). Intended to be attached at spawn time via `sys_session_send`'s `cost_budget` argument; the approval key stays local to the child's `session_state` (`cost.py:392-466`).
   - All three FAIL CLOSED on unpriced spend: `_usage_is_unpriced(usage)` returns `True` when token counters are non-zero but `total_cost_usd` is absent — the gate ASKs (not silently allows) so unpriced spend can't bypass the cap at `$0` (`cost.py:90-112, 152-160`).

3. **Persistence** — `omnigent/db/db_models.py`:
   - `SqlUserDailyCost` (`db_models.py:1019`, `__tablename__ = "user_daily_cost"` at `db_models.py:1056`) — per-user per-UTC-day cost rollup table.
   - `SqlConversation.session_state` (`db_models.py:500`) — `CompressedText` column holding per-conversation JSON state persisted across turns (where `SESSION_COST_ASK_APPROVED_STATE_KEY` and `SESSION_COST_UNPRICED_APPROVED_KEY` live).
   - SQLAlchemy + Alembic schema (59 migration files in `omnigent/db/migrations/versions/`).

4. **Per-dispatch budget arg** — `sys_session_send` accepts a `cost_budget` argument at spawn time, which attaches `subagent_cost_budget` to the child session. Per-ticket budgets come free: the parent sets the budget; the child gates against its own subtree spend.

## Pickle Rick implementation
Pickle Rick ships `/pickle-metrics` — a token / commit / LOC reporter. Referenced in `pickle-rick-claude/COMMANDS.md:27` ("Token usage, commits, LOC. `--days N`, `--weekly`, `--json`") and `pickle-rick-claude/README.md:793-796`. Implemented in `pickle-rick-claude/extension/src/bin/metrics.ts`:

- `MetricsReport`, `MetricsRow`, `MetricsTotals` types (`metrics.ts:16-18`).
- `scanGitRepos`, `scanSessionFiles`, `buildReport` imported from `services/metrics-utils.ts` (`metrics.ts:5-10`).
- `aggregateRow` computes per-row totals: turns, input, output, cache_read, cache_create, commits, added, removed (`metrics.ts:261-271`).
- `printDailyTable` renders Commits and token breakdowns (`metrics.ts:217-222`).
- `--days N`, `--weekly` (28-day weekly buckets), `--json` (machine-readable) flags (`metrics.ts:30-37`).
- Also reports a skip-flag budget view (W5c governance dashboard) counting `gate_skipped` / `readiness_skipped` activity events against `SKIP_FLAG_BUDGETS` (`README.md:801`).

`/pickle-metrics` is a REPORTER, not an enforcer. It reads activity JSONL + git history and prints a dashboard; it does not gate dispatch, deny turns, or ASK for approval. There is no per-session or per-dispatch budget gate in Pickle Rick — cost is observed after the fact, not enforced before the turn.

## Contract
What this component does: track cumulative LLM spend (USD) and enforce budgets at three scopes — per-session, per-user-daily, and per-dispatch (subagent subtree) — failing closed when pricing is unavailable so unpriced spend cannot silently bypass the cap.

Invariants:
- Cost is read from `event["context"]["usage"]["total_cost_usd"]` (session), `event["context"]["user_daily_cost"]["cost_usd"]` (daily), or `event["context"]["subtree_usage"]["total_cost_usd"]` (subagent) — all maintained server-side from MLflow catalog pricing.
- The hard gate fires on BOTH the `request` phase (whole turn before the LLM runs) and the `tool_call` phase (native PreToolUse block) — so text-only turns with no tool calls are still budgeted.
- Unpriced spend FAILS CLOSED: when tokens are non-zero but `total_cost_usd` is absent, the gate ASKs (not silently allows) — unpriced is treated as unbounded-risk, not zero.
- Soft checkpoints ASK at most once per approval (remembered in `session_state` / per user+day); a decline blocks the one turn/tool call and re-asks next time.
- Per-dispatch budgets are attached at spawn time via `sys_session_send`'s `cost_budget` arg; the child gates against its own subtree spend.

Failure modes:
- Pricing absent (model not in MLflow catalog) → `fetch_model_pricing` returns `None` → `total_cost_usd` never written → gate fails closed (ASK) rather than scoring at `$0`.
- A single very expensive turn can overshoot before the next check (cost is refreshed at turn boundaries, not mid-turn).
- Model undeterminable → `_model_blocked_over_budget` fails closed (treats as expensive, asks user to `/model`).

## Evaluation
For Rickgent's goals, Omnigent's cost infra is the clear enforcement backbone and Pickle Rick's `/pickle-metrics` is the clear lifecycle-aware reporting layer — but they serve different layers.

- Omnigent provides enforcement: per-session, per-user-daily, and per-dispatch budget GATES that DENY/ASK before the turn runs, with fail-closed unpriced handling and a per-dispatch `cost_budget` arg that makes per-ticket budgets free. This is exactly what Rickgent needs to enforce AC cost budgets — Rickgent should not re-implement gating.
- Omnigent's pricing depends on the MLflow catalog (`context_window.py:184, 418`); when a model is unpriced, `fetch_model_pricing` returns `None` and the gate fails closed. Rickgent inherits this: treat unpriced as unbounded-risk, not zero — exactly the §2.1.1 finding.
- Pickle Rick's `/pickle-metrics` is a lifecycle-aware REPORTER: it correlates token usage with commits and LOC across days/weeks, reading from activity JSONL + git history. It does not enforce anything. But the lifecycle awareness (tokens → commits → LOC, per-day, per-week, skip-flag budgets) is valuable operator observability that Omnigent's policy gates do not provide.
- Neither alone is sufficient: Omnigent enforces but reports poorly (DENY/ASK messages, no dashboard); Pickle Rick reports well but does not enforce.

MASH: take Omnigent's enforcement infra (MLflow pricing, three budget policies, `sys_session_send` cost_budget arg, `user_daily_cost` persistence, fail-closed unpriced handling) as the backbone, and layer Pickle Rick's lifecycle-aware metrics reporting (tokens → commits → LOC, per-day/per-week, skip-flag budget view) on top as the observability surface. Per-ticket budgets come free from the `cost_budget` arg.

## §2.1.1 Finding
ADOPT — "CONFIRMED, reshaped. No cost-advisor tool; cost = MLflow-fetched pricing, budget policies, session_usage + user_daily_cost persistence, and a per-dispatch cost_budget arg on sys_session_send, so per-ticket budgets come free. Pricing can be absent — treat unpriced as unbounded-risk."

Confirmed by source:
- No cost-advisor tool — `cost.py` ships policies, not a tool; pricing lives in `context_window.py` (`fetch_model_pricing:418`).
- MLflow-fetched pricing — `_fetch_mlflow_provider_catalog` (`context_window.py:184`) downloads from `github.com/mlflow/mlflow/releases` (`context_window.py:20`).
- Budget policies — `cost_budget`, `user_daily_cost_budget`, `subagent_cost_budget` factories (`cost.py`).
- `user_daily_cost` persistence — `SqlUserDailyCost` (`db_models.py:1019, 1056`).
- Per-dispatch `cost_budget` arg — `subagent_cost_budget` is "Intended to be attached to a child session at spawn time via `sys_session_send`'s `cost_budget` argument" (`cost.py:subagent_cost_budget` docstring).
- Treat unpriced as unbounded-risk — `_usage_is_unpriced` + `_UNPRICED_ASK` fail closed (`cost.py:90-112`).

The finding is adopted as written.

## Decision: mash
MASH — Omnigent enforcement infra (MLflow pricing via `context_window.py`, three budget policies via `cost.py`, `user_daily_cost` persistence, `sys_session_send` cost_budget arg for per-ticket budgets, fail-closed unpriced handling) + Pickle Rick lifecycle-aware metrics reporting (tokens → commits → LOC, per-day/per-week, skip-flag budget view from `metrics.ts`/`metrics-utils.ts`) as the observability surface.

## Reasoning
Rickgent needs cost ENFORCEMENT (gate dispatch, deny over-budget turns, per-ticket budgets) and cost OBSERVABILITY (operator dashboard correlating spend with commits/LOC). Omnigent is the only one of the two that enforces: its three budget policies gate at the `request` and `tool_call` phases, fail closed on unpriced models, and support per-dispatch subtree budgets via the `cost_budget` spawn arg (`cost.py:cost_budget`, `cost.py:subagent_cost_budget`). Per-ticket budgets come free — the parent sets `cost_budget` on `sys_session_send` and the child gates against its own subtree. Rickgent should reuse this entire enforcement spine rather than re-implement gating, pricing fetch, or persistence.

Omnigent's weakness is reporting: it surfaces DENY/ASK messages and `session_state` approval keys, but no dashboard. Pickle Rick's `/pickle-metrics` (`metrics.ts:261-271, 217-222`) is the opposite — rich lifecycle-aware reporting (tokens → commits → LOC, daily/weekly, skip-flag budgets against `SKIP_FLAG_BUDGETS`) but zero enforcement. The mash: Omnigent enforces, Pickle Rick-shaped metrics report. Rickgent adopts Omnigent's fail-closed unpriced posture verbatim (`_usage_is_unpriced` → ASK, not `$0`), because the §2.1.1 finding is correct that unpriced spend is unbounded-risk, not zero — silently allowing it would let a whole pipeline run uncapped on an unpriced model.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `omnigent/llms/context_window.py:184-205,389-430` confirms cached MLflow pricing and nullable lookup; `extension/src/bin/metrics.ts:217-222,261-271` aggregates tokens, commits, and LOC.
- **Notes:** Enforcement plus lifecycle observability is well justified.
- **Date:** 2026-07-12
