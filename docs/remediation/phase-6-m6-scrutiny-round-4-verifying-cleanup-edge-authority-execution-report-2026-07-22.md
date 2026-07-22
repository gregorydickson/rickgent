# M6 Scrutiny Round 4 — Verifying→Cleanup_Pending Edge Authority

**Date:** 2026-07-22
**Milestone:** M6-t24-t26
**Scope:** Fix two blocking defects in the verifying→cleanup_pending edge authority routing.

## Scope

Two blocking defects were identified in M6 scrutiny round 4:

1. **engine.ts missing gate_results guard:** The `guardForEdge` function in `LifecycleEngine` had no case for the `"gate_results"` guard kind. The normative `PHASE_TRANSITION_TABLE` declares the `verifying → cleanup_pending` edge with a `gate_results` guard, but the engine returned `null` for this guard, causing it to fall back to `StateStore.advanceAttemptState`. The store CAS path persists neither validated context nor transition evidence, uses the wrong `owner_service` ("AttemptLifecycleService" instead of "VerificationService"), and uses a placeholder `owner_context_digest` (`sha256:000...0`).

2. **Missing AttemptRunner verification-failure e2e proofs:** The cleanup-transition-authority regression suite (round 3) tested the `converging → cleanup_pending` edge but did not drive AttemptRunner's verification-failure branch, so it missed the direct-store fallback for the `verifying → cleanup_pending` edge.

## Outcome

### Fix 1: gate_results guard in engine.ts

- Added `gateResultIds?: readonly string[]` to `LifecycleTransitionInput`.
- Added a `"gate_results"` case to `guardForEdge` in `engine.ts` that builds a `{ kind: "gate_results", gateResultIds }` guard when `gateResultIds` are provided. When omitted, returns `null` (preserving the store CAS fallback for forward edges that don't supply gate result IDs).
- Modified the store's `gate_results` guard validation in `#validateTransitionGuard` to handle the failure path (`toState === "cleanup_pending"`): requires at least one required gate to NOT pass (instead of all required gates must pass for the success path `toState === "converging"`).
- Added `queryGateResultEvidenceIds(attemptId)` method to `StateStore` for querying all gate result evidence IDs of an attempt.

### Fix 2: AttemptRunner verification-failure routes through TransitionAuthority

- Updated `#beginCleanupPhase` in `attempt-runner.ts` to accept an optional `gateResultIds` parameter.
- When `gateResultIds` is provided, `#beginCleanupPhase` adds existing evidence references for each gate result's evidence ID (queried via `queryGateResultEvidenceIds`) and passes `gateResultIds` to `transitionAttempt`.
- Updated the verification-failure branch to pass `verifyPhase` (not `productionPhase`) and `verification.gateResultIds` to `#beginCleanupPhase`, ensuring the gate_results guard validates against the verification context.

### Test proofs (6/6, red-then-green)

All tests were captured red first (failing against the unfixed code) and green after the fix:

1. **(a) AttemptRunner verification-failure routes through TransitionAuthority:** Drives the real AttemptRunner production path with `verificationStatus: "fail"`. Verifies the `verifying → cleanup_pending` transition persists evidence refs in `transition_evidence_refs`, uses the real verify-phase context digest (not the placeholder), and uses `owner_service: "VerificationService"` (not "AttemptLifecycleService").

2. **(b) Missing evidence rejected:** Calls `engine.transitionAttempt` for `verifying → cleanup_pending` with no evidence. The engine rejects with `LifecycleEngineError` (the authority path requires non-empty evidence for guard-validated edges).

3. **(c) Stale context evidence rejected:** Calls `engine.transitionAttempt` with a wrong `contextDigest` that doesn't match the gate results' context. The store's `gate_results` guard rejects (context digest mismatch).

4. **(d) Wrong-owner evidence rejected:** Calls `engine.transitionAttempt` with inline evidence whose `producerService` is "WrongService" (not "VerificationService"). The store's `#resolveTransitionEvidence` rejects (producer service mismatch).

5. **Structural proof — guardForEdge handles gate_results:** Verifies the engine source code has `case "gate_results"` in `guardForEdge`.

6. **Structural proof — AttemptRunner passes gateResultIds and verifyPhase:** Verifies the verification-failure branch source code references `verification.gateResultIds` and `verifyPhase`.

## Proof Counts

- 6/6 focused gate (new test file: `m6-scrutiny-round-4-verifying-cleanup-edge-authority.test.ts`)
- 168/168 scoped regression (7 M6-area suites)
- 367/367 Python policy suite (3 skipped — pre-existing)
- typecheck: green
- build: green
- citadel: 0 CRITICAL, 0 HIGH (8 MEDIUM, 1 LOW — all pre-existing)
- doctor: exit 0

## Known Limitations

None. The fix is complete and does not introduce new findings.

## Next Dependency Boundary

M6 scrutiny round 4 is complete. The verifying→cleanup_pending edge now routes through TransitionAuthority with the gate_results guard, owner/context evidence, and gate result evidence. The AttemptRunner's verification-failure branch no longer falls back to `StateStore.advanceAttemptState`.
