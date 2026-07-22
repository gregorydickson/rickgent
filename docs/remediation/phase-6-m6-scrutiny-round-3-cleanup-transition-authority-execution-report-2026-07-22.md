# Phase 6 — M6 Scrutiny Round 3: Cleanup Transition Authority Routing

**Date:** 2026-07-22
**Scope:** Fix M6 scrutiny round 3 blocking defect — AttemptRunner cleanup transition bypassing TransitionAuthority.
**Tickets affected:** t24 (lifecycle transition table), t25 (contract propagation), t26 (gate runner).
**Status:** Done

## Problem

The AttemptRunner's `#beginCleanupPhase` method directly called `StateStore.advanceAttemptToCleanupPending` for declared failure-to-cleanup edges, bypassing the TransitionAuthority and accepting no authority-owned evidence or context. This contradicted the newly declared PRD/contract preconditions and left the production path fail-open:

- No authority-owned evidence was provided or validated for cleanup transitions.
- The `owner_context_digest` was a placeholder (`sha256:000...0`) instead of the real execution context digest.
- No evidence refs were persisted in `transition_evidence_refs`.
- The guard was not validated (no `cleanup_pending` guard check, no commit attribution validation for the success path).

## Fix

1. **Routed `#beginCleanupPhase` through `LifecycleEngine.transitionAttempt`** (the production authority path), replacing the direct `StateStore.advanceAttemptToCleanupPending` call. The engine validates the edge against the normative `PHASE_TRANSITION_TABLE`, validates the owner context digest, validates the guard, and persists authority-owned evidence refs.

2. **Provided authority-owned inline evidence** for every cleanup transition:
   - **Failure paths:** inline evidence with `purpose: "failure"`, produced by the edge's `evidenceProducer` (e.g., `AttemptLifecycleService`, `ReviewService`, `VerificationService`), carrying the failure reason, phase state, and context digest.
   - **Success path:** existing attribution evidence reference (`purpose: "authority"`) plus inline evidence with `purpose: "cleanup"`, produced by `AttemptLifecycleService`.

3. **Added `commitAttributionId` support** to `LifecycleTransitionInput` and `guardForEdge` in `engine.ts`, so the success path's `cleanup_pending` guard includes the `commitAttributionId` and the store validates the finalized commit attribution.

4. **Added `advanceTicketToCleanupPending`** store method for the secondary ticket state transition (mirroring the authority-routed attempt transition).

5. **Updated all 8 call sites** of `#beginCleanupPhase` to pass the production phase context (contextId, contextDigest) and commit attribution where applicable.

## Proof Counts

- **New test file:** `orchestrator/test/reliability/m6-scrutiny-round-3-cleanup-transition-authority.test.ts` — 6 tests, all green.
- **Red-then-green proof:** The structural proof test (`#beginCleanupPhase` routes through `lifecycle.transitionAttempt`, not `store.advanceAttemptToCleanupPending`) failed against the unfixed code and passes after the fix.
- **Negative proofs (3):**
  - (a) Missing evidence: engine rejects cleanup edge with no evidence when authority is bound.
  - (b) Stale evidence (wrong context digest): engine rejects cleanup edge with a contextDigest that does not resolve to the attempt lineage.
  - (c) Wrong-owner evidence: store rejects inline evidence whose `producerService` does not match the edge's `evidenceProducer`.
- **Positive proof (2):**
  - Authority-routed cleanup transition persists evidence refs and real context digest.
  - Direct store bypass (`advanceAttemptToCleanupPending`) does NOT persist evidence refs (proves the bypass is the fail-open path).
- **Scoped M6 suites:** 189/189 passed across 11 test files (134 M6+attempt-runner + 55 gate-related).
- **Typecheck:** green.
- **Build:** green.
- **Python policies:** 367 passed, 3 skipped.
- **Citadel:** 0 CRITICAL, 0 HIGH (1 MEDIUM, 1 LOW — pre-existing).
- **Doctor:** exit 0, capability matrix unchanged.

## Files Changed

| File | Change |
|---|---|
| `orchestrator/src/lifecycle/attempt-runner.ts` | `#beginCleanupPhase` routes through `LifecycleEngine.transitionAttempt` with authority-owned evidence + context; added `phase` parameter; updated all 8 call sites |
| `orchestrator/src/lifecycle/engine.ts` | Added `commitAttributionId` to `LifecycleTransitionInput`; `guardForEdge` accepts and passes through `commitAttributionId` |
| `orchestrator/src/state/store.ts` | Added `advanceTicketToCleanupPending` method for secondary ticket state transition |
| `orchestrator/test/reliability/m6-scrutiny-round-3-cleanup-transition-authority.test.ts` | New test file: 6 tests (3 negative proofs, 2 positive proofs, 1 structural proof) |

## Known Limitations

None. The fix routes all cleanup transitions through the same authority path as forward transitions, with no bypass.

## Next Dependency Boundary

M6 scrutiny round 3 complete. No downstream blockers introduced.
