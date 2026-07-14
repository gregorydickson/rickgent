# Decision: Metrics — interventions/run + rolling matured-PR quality (B9 / M5)

## Component
`rickgent metrics` (B9) — goal-4 measurement: the autonomy metric
(interventions/run, target 0) and the rolling matured-PR quality metric
(target 99%, Mission 1 §5.4).

## Implementation

- **`orchestrator/src/lifecycle/metrics.ts`** — durable ledger readers +
  `computeMetrics` + `formatMetricsReport` + `runMetrics`. Every number is a
  REAL ledger read; nothing is hardcoded.
- **`orchestrator/src/cli.ts`** — `rickgent metrics` (and `rickgent metrics
  --json`) prints the report / JSON. Exits 0.
- **`orchestrator/src/lifecycle/build.ts`** — wired to record the run, the
  intervention (with runId), and the shipped PR into the durable ledgers so
  metrics has real data to read.

## Ledgers (all append-only JSONL under `.rickgent/`)

| Ledger | Writer | Record shape |
|---|---|---|
| `runs.jsonl` | `build.ts` at run start | `{runId, startedAt, prdTitle}` |
| `interventions.jsonl` | `build.ts` on a human-gate hit (PRD/plan/merge) | `{gate, reason, at, runId?}` (runId added by the build path; legacy lines without it still count) |
| `prs.jsonl` | `build.ts` when a PR is autonomously shipped | `{prId, runId, branch, title, repo, shippedAt, scopePaths}` |
| `defects.jsonl` | audit/review surfaces (future) + tests | `{defectId, prId, scopePath, detectedAt, adjudicationNote}` |

## Metrics computed

### Interventions / run (autonomy, target 0)
- `runs` = distinct `runId` values in `runs.jsonl`.
- `interventions` = line count of `interventions.jsonl`.
- `interventionsPerRun` = `interventions / runs` when `runs > 0`; else the raw
  intervention count (so a gated run with no `runs.jsonl` still reports a
  non-zero autonomy metric rather than dividing by zero).

### Rolling matured-PR quality (target 99%)
Per Mission 1 §5.4: *PR quality % = 1 − (defective / shipped)*, measured over
**matured** PRs only.

- `shippedPrs` = line count of `prs.jsonl`.
- `maturedPrs` = PRs whose `shippedAt` is at least the maturity window in the
  past. This is the **quality denominator**.
- `immaturePrs` = shipped PRs still within the maturity window — **excluded from
  the denominator** (a not-yet-matured PR does not enter it; the same PR
  crossing the window then enters it).
- `defectiveMaturedPrs` = matured PRs with ≥1 attributed defect in
  `defects.jsonl`.
- `qualityPct` = `(1 − defectiveMaturedPrs / maturedPrs) × 100`, or `null`
  ("N/A") when the denominator is 0.
- `lateDefectsReopened` = defects on matured PRs whose `detectedAt` is AFTER
  `shippedAt + maturityWindow` — a late defect **reopens** the matured PR as
  defective and updates the rolling metric. The detectedAt does NOT filter the
  defective status: any defect on a matured PR makes it defective; the field is
  reported separately so the late-reopening signal is observable.

## Maturity window

**14 days** — Mission 1 §5.4: *"The 14-day window is the maturity window before
a PR enters the main quality denominator, not an expiry date: late defects
reopen the historical record and update the rolling metric."*

This is the production constant (`DEFAULT_MATURITY_WINDOW_DAYS = 14`).
`RICKGENT_MATURITY_WINDOW_DAYS` overrides it ONLY for test determinism (so a
test can exercise the matured/immature boundary without waiting 14 days); the
override is a non-production knob and the default remains the decision-doc
constant. Tests that exercise the boundary write explicit `shippedAt`
timestamps (e.g. 30 days ago = matured, 1 day ago = immature) against the
default 14-day window, so the production semantics are validated directly.

## Invariants preserved

- **Real ledger reads, not constants** — the denominator, the defective count,
  and late-defect reopening are computed from `prs.jsonl` + `defects.jsonl`;
  mutating the ledger contents changes the reported metrics (VAL-METRIC-003).
- **Fail closed on unresolvable evidence** — an unparseable `shippedAt` cannot
  be proven mature, so the PR is counted as immature (excluded from the
  denominator), never silently admitted.
- **Quality is a computed number, never an assertion** (PRD §3.4 B9).
- **A human-gate hit during build increments the intervention ledger**
  (`recordIntervention` in `build.ts`); `metrics` reads that ledger
  (VAL-METRIC-002).

## Test integrity

Tests (`orchestrator/test/lifecycle/metrics.test.ts`) drive the REAL CLI
(`dist/cli.js metrics --json`) and the REAL `runBuild` path against the
deterministic fixture omnigent. They were written RED-first: the suite failed
against the unfixed code (the `metrics` command was a "not yet implemented"
stub and no metrics module existed), then passed after the implementation
landed. No test asserts a mock's return value — every assertion reads the real
ledger files or the real CLI stdout.
