# Decision: Convergence Gate

## Component
§2 matrix row: "Convergence gate" — Omnigent has nothing (generic policies only); Pickle Rick has the full gate implementation.

## Omnigent implementation
Nothing. Omnigent's policy system (`omnigent/policies/`) provides generic allow/deny rules but has no concept of a convergence gate: no baseline subtraction, no scope filtering, no freshness assertion, no zero-check detection. The first PRD draft's `convergence_gate` was "DENY if metric < baseline" — a toy that Pickle Rick's actual implementation replaced with full semantics.

## Pickle Rick implementation
**`extension/src/services/convergence-gate.ts`** (1,364 LOC, 6 principal exports):

- `runGate` (line 1323) — the top-level gate entry point. Runs typecheck, lint, and tests against the current tree, builds failures, subtracts the baseline, filters by scope, and returns a `GateResult` with the in-scope, post-subtraction failure set.
- `filterByScope` (line 553) — filters failures to only those touching files in the current scope (the ticket's owned paths + changed files since the session start commit). Out-of-scope failures are dropped so a sibling ticket's breakage does not block this ticket's convergence.
- `assertBaselineFresh` (line 301) — asserts the baseline file exists and is not stale (age checked against `max_age_iterations` and `max_age_seconds`). If the baseline is missing, it is created (write-on-first-run). If stale, throws `BaselineStaleError`. This is the R-SZGB lesson: a convergence gate that converges over a stale baseline (zero checks) is a false convergence.
- `subtractBaseline` (line 246) — removes failures that match the pre-existing baseline by fingerprint. The `selfGuard` (R-ORSR-6) ensures a failure intersecting the phase's own diff is NEVER subtracted as pre-existing, so a self-introduced break cannot be disowned as a coincidental baseline match.
- `detectProjectType` (line 362) — detects the project type (`pnpm`, `npm`, `yarn`, `cargo`, `go`, `bun`) from lockfile/config files in the working directory.
- `getWorkspacePackages` (line 417) — enumerates workspace packages for monorepo-aware gate execution.

Supporting exports include: `GateError`, `GateTimeoutError`, `BaselineMissingError`, `BaselineStaleError`, `BaselineWriteFailedError`, `assignOccurrenceIndices`, `extractTscFailureIdentifiers`, `isSelfIntroducedFailure`, `classifyNoDisown`, `getChangedFilesSince`, `parseChangedExportedSymbolsFromDiff`, `getChangedExportedSymbols`, `stripEnvNoise`, `buildFailures`, `isUnrunnableCheckResult`.

## Contract
The convergence gate is the quality gate that runs after each iteration (microverse) or phase (pipeline). It:
1. **Runs checks** (typecheck, lint, tests) against the current working tree.
2. **Subtracts the baseline**: failures that match the pre-existing baseline fingerprint are removed — BUT only if they are NOT self-introduced (the `selfGuard` prevents disowning a break your own diff caused).
3. **Filters by scope**: only failures touching in-scope files (the ticket's owned paths + changed files since session start) survive. Out-of-scope failures are dropped.
4. **Asserts freshness**: the baseline must not be stale. A stale baseline (zero checks recorded, or too old) means the gate is converging over nothing — a false convergence (R-SZGB).

**Invariants:**
- A self-introduced failure is never subtracted as pre-existing (R-ORSR-6 `selfGuard`).
- A stale baseline is a hard error (`BaselineStaleError`), not a silent pass.
- Scope filtering uses the session start commit as the change baseline, not HEAD, so rebase/cherry-pick does not silently widen scope.
- The gate result carries the post-subtraction, post-scope-filter failure set — the caller never sees raw failures.

**Failure modes:**
- Baseline missing → created on first run (write-on-first-run semantics).
- Baseline stale → `BaselineStaleError` thrown; caller must refresh the baseline before proceeding.
- Gate timeout → `GateTimeoutError`; treated as a gate failure (fail-closed).
- Unrunnable check (e.g. no test script) → `isUnrunnableCheckResult` classifies it; does not crash the gate.

## Evaluation
Pickle Rick is strictly better. Omnigent has no convergence gate at all. The PRD explicitly calls out that the first draft's "DENY if metric < baseline" was a toy, and that Pickle Rick's actual implementation (baseline subtraction, scope filtering, freshness assertion, zero-check detection) is the depth we port. The `selfGuard` (R-ORSR-6) and `assertBaselineFresh` (R-SZGB) are reliability-critical invariants that a toy gate would violate silently.

## §2.2.1 Finding
ADOPT — "All named runtime artifacts exist with the claimed exports: convergence-gate.ts (1,364 LOC, 6/6)." Verified: `runGate` (line 1323), `filterByScope` (line 553), `assertBaselineFresh` (line 301), `subtractBaseline` (line 246), `detectProjectType` (line 362), `getWorkspacePackages` (line 417). All 6 principal exports confirmed present with the claimed semantics.

## Decision: port
Port the Pickle Rick convergence gate into Rickgent's TS verdict core (gate math: baseline subtraction, scope filtering, freshness assertion) + TS gate runner (check execution). The R-SZGB lesson is preserved: a convergence gate that converges over a stale baseline (zero checks) is a false convergence.

## Reasoning
The convergence gate is the quality enforcement mechanism that makes Rickgent's convergence meaningful rather than theatrical. Without baseline subtraction, every pre-existing failure blocks convergence forever. Without scope filtering, a sibling ticket's breakage blocks this ticket. Without freshness assertion, a gate that ran zero checks looks like a pass. All three are present in Pickle Rick's implementation and absent in Omnigent.

The port splits along the §10.9 language boundary:
- **`orchestrator/src/core/convergence.ts`** gets the pure math: `subtractBaseline` (with `selfGuard`), `filterByScope`, `assertBaselineFresh`, `isSelfIntroducedFailure`, `classifyNoDisown`, `buildFingerprint`, `assignOccurrenceIndices`. These are pure functions over failure sets and file lists — no spawns, no git mutations.
- **`orchestrator/src/lifecycle/convergence.ts`** gets the runner: `runGate` (orchestrates check execution, calls the core for math), `detectProjectType`, `getWorkspacePackages`, `buildFailures`, `stripEnvNoise`. The check execution (typecheck, lint, test commands) is the lifecycle layer's responsibility; the verdict (which failures count, which are subtracted, which are in scope) is the core's responsibility.

The R-SZGB lesson is the central design constraint: `assertBaselineFresh` must throw on a stale baseline, not silently pass. The R-ORSR-6 `selfGuard` is the second constraint: a failure intersecting the phase's own diff is never subtracted. Both invariants are preserved verbatim in the port — they are not optimizations or refinements, they are correctness requirements learned from live incidents.

The gate is invoked by the microverse loop (per-iteration gate hook) and by the pipeline runner (per-phase gate). Both callers delegate to the same core functions, ensuring one definition of "converged" across the entire system.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `extension/src/services/convergence-gate.ts:246-255,301-315` confirms guarded subtraction and fail-loud baseline handling; Omnigent search found no equivalent.
- **Notes:** The core/lifecycle split preserves verified semantics.
- **Date:** 2026-07-12
