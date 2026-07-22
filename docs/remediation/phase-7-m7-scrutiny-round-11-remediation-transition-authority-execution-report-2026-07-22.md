# M7 Scrutiny Round 11 — Remediation Transition Authority Execution Report

**Date:** 2026-07-22
**Scope:** Fix the M7 scrutiny round 11 blocking defect: the `remediation_captured` to `reviewing` transition in `attempt-runner.ts` was directly persisted via `StateStore.advanceAttemptState`, bypassing the LifecycleEngine, its ReviewService ownership, and the execution-context guard. The resulting durable transition carried placeholder authority metadata (`owner_service: "AttemptLifecycleService"`, `owner_context_digest: "sha256:000...0"`), violating M7's one lifecycle engine and fail-closed requirements.

## Outcome

**Status:** Done

The `remediation_captured` to `reviewing` transition now routes through the LifecycleEngine's `transitionAttempt` method, which builds an `execution_context` guard from the remediation phase's context ID and routes through the `TransitionAuthority.commitAttemptEdge` method. The persisted transition carries real authority metadata:
- `owner_service: "ReviewService"` (the edge's declared owner in `PHASE_TRANSITION_TABLE` and `ATTEMPT_TRANSITIONS`)
- `owner_context_digest`: a real context digest from a persisted execution context (not the all-zeros placeholder)
- At least one evidence reference in `transition_evidence_refs` (the direct store bypass persisted zero)

## Changes

### `orchestrator/src/lifecycle/phase.ts`
- Added `isForwardPhaseEdge(from, to)` helper: returns `true` iff `(from, to)` is a forward edge in the normative lifecycle ordering (from strictly precedes to in `FORWARD_PHASE_ORDER`). Cycle edges like `remediation_captured -> reviewing` return `false`.

### `orchestrator/src/lifecycle/engine.ts`
- Added `contextId` optional field to `LifecycleTransitionInput`: the execution-context ID for edges guarded by `execution_context`.
- Updated `guardForEdge` to handle the `execution_context` guard kind: when `contextId` is provided, builds a `{ kind: "execution_context", contextId }` guard so the engine routes through the `TransitionAuthority` with full guard validation, owner-context binding, and persisted evidence references.
- Updated the `guardForEdge` call in `transitionAttempt` to pass `contextId` from the input.
- Fixed both idempotent short-circuit blocks (authority path and store CAS path): the `phaseStateIsAtOrPast` check is now gated by `isForwardPhaseEdge(input.from, input.to)`. For cycle edges (where `isForwardPhaseEdge` returns `false`), only the exact-state-match short-circuit applies, allowing the transition to proceed through the authority instead of being incorrectly suppressed.
- Re-exported `isForwardPhaseEdge` from the engine module.

### `orchestrator/src/lifecycle/attempt-runner.ts`
- Replaced the direct `this.#store.advanceAttemptState(...)` call for the `remediation_captured` to `reviewing` transition with `this.#lifecycle.transitionAttempt(...)`, providing:
  - `contextId`: the remediation phase's context ID (already persisted in `execution_contexts`)
  - `contextDigest`: the remediation phase's context digest
  - `evidence`: inline authority-owned evidence with `producerService: "ReviewService"` (matching the edge's `evidenceProducer`), schema `rickgent.review-after-remediation.v1`, and a payload documenting the transition's cause.

### `orchestrator/test/reliability/m7-scrutiny-round-11-remediation-transition-authority.test.ts`
- New production-path test suite (4 test cases) that drives the real AttemptRunner with real production providers through a remediation cycle, then queries the `state_transitions` table to verify:
  1. `owner_service` is `"ReviewService"` (not `"AttemptLifecycleService"` placeholder)
  2. At least one evidence reference exists in `transition_evidence_refs` (not zero)
  3. `owner_context_digest` resolves to a real execution context for the attempt (not the all-zeros placeholder)

## Proof Counts

- **New test cases:** 4/4 passed (red-then-green captured)
- **Red evidence:** 3 tests failed with assertion failures:
  - `expected 'AttemptLifecycleService' to be 'ReviewService'`
  - `expected 0 to be greater than or equal to 1` (zero evidence refs)
  - `expected undefined to be defined` (placeholder digest does not resolve to an execution context)
- **Green evidence:** All 4 tests pass after the fix.
- **Scoped M7 suites:** m7-scrutiny-round-10 (2/2), m7-scrutiny-round-7 (3/3), m7-production-wiring-fix (19/19), review-remediation (46/46) — all green.
- **Scoped M6 suites:** m6-scrutiny-round-1 (29/29), m6-scrutiny-round-3 (6/6), m6-scrutiny-round-4 (6/6), m6-scrutiny-round-5 (4/4), m6-failure-transition-declaration (5/5), phase.test (11/11) — all green.
- **Typecheck:** green
- **Build:** green
- **Python pytest:** 367 passed, 3 skipped
- **Citadel:** exit 0, 0 CRITICAL, 0 HIGH
- **Doctor:** exit 0, all checks PASS

## Pre-existing Failures (Not Introduced by This Tranche)

- `attempt-critical-section.test.ts`: 1 failure (review reject without remediation provider) — pre-existing, confirmed via `git stash`.
- `attempt-runner-round-5-fixes.test.ts`: 1 failure (catch block structure check) — documented in AGENTS.md Known Pre-Existing Issues.
- `attempt-runner-production-cutover.test.ts`: 2 failures (legacy path removal) — pre-existing, confirmed via `git stash`.
- `m7-scrutiny-round-8-provider-ids-and-real-proofs.test.ts`: 2 failures — pre-existing, confirmed via `git stash`.

## Negative Proofs

The test suite includes behavioral assertions that fail against the unfixed code:
1. **Placeholder owner_service rejection:** The test asserts `owner_service === "ReviewService"`, which fails when the transition is persisted by `advanceAttemptState` (which hardcodes `"AttemptLifecycleService"`).
2. **Zero evidence rejection:** The test asserts `refs.length >= 1`, which fails when the transition is persisted by `advanceAttemptState` (which persists zero evidence references).
3. **Placeholder digest rejection:** The test asserts the `owner_context_digest` resolves to a real execution context, which fails when the digest is the all-zeros placeholder.

## Next Dependency Boundary

No new dependency boundary. The fix is self-contained within the M7 remediation transition path. The `isForwardPhaseEdge` helper and the `execution_context` guard handling in the engine are generalizable to other cycle edges if future scrutiny rounds identify similar bypasses.
