# M6 Scrutiny Round 5 — Empty/Missing Gate IDs Fail-Closed on Verifying→Cleanup_Pending

**Date:** 2026-07-22
**Milestone:** M6-t24-t26
**Scope:** Fix two blocking defects from M6 scrutiny round 5: empty/missing gate IDs on the verifying→cleanup_pending path.

## Scope

Two blocking defects were identified in M6 scrutiny round 5:

1. **LifecycleEngine returns null for the verifying→cleanup_pending gate_results guard when gateResultIds is omitted or empty.** AttemptRunner permits a failed VerificationResult with an empty array, then the transition falls back to StateStore.advanceAttemptState without authority-validated gate evidence, owner context, or persisted transition evidence. The store CAS path uses a placeholder `owner_context_digest` (`sha256:000...0`) and the wrong `owner_service` ("AttemptLifecycleService" instead of "VerificationService").

2. **The round-4 missing-evidence, stale-context, and wrong-owner tests invoke LifecycleEngine directly.** They do not cover AttemptRunner's real verification-failure branch or malformed provider output that reaches the direct-store fallback.

## Outcome

### Fix 1: Fail-closed for empty/missing gateResultIds on verifying→cleanup_pending

Added a fail-closed check in `LifecycleEngine.transitionAttempt` (engine.ts) right before the `StateStore.advanceAttemptState` fallback. When the edge has a `gate_results` guard and the target is `cleanup_pending` (the verifying→cleanup_pending failure edge), the engine throws `LifecycleEngineError` with code `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL` if the code reaches the store CAS fallback path. This path is only reached when `guardForEdge` returns null (i.e., gateResultIds is empty/missing). Idempotent replays (attempt already at/past cleanup_pending) short-circuit above the check and are not affected.

This ensures every declared verifying→cleanup_pending edge routes through the TransitionAuthority with non-empty gateResultIds — no fallback to StateStore.advanceAttemptState.

### Fix 2: End-to-end AttemptRunner verification-failure tests

Created a new test file `m6-scrutiny-round-5-empty-gate-ids-fail-closed.test.ts` with 4 end-to-end tests that drive the REAL AttemptRunner production path (not direct LifecycleEngine calls):

- **(a) Empty gate IDs rejected fail-closed:** The verification provider returns `status: "fail"` with an EMPTY `gateResultIds` array (simulating malformed provider output). The AttemptRunner throws, no `state_transitions` row is persisted for verifying→cleanup_pending with `owner_service = "AttemptLifecycleService"` (no direct-store fallback), and the attempt remains in "verifying" state.

- **(b) Stale context rejected fail-closed:** The verification provider creates a gate result with the IMPLEMENT phase context (not the verify phase context). The authority's gate_results guard rejects the context digest mismatch. No direct-store transition occurs.

- **(c) Wrong-owner evidence rejected fail-closed:** The verification provider creates a gate result for a FOREIGN attempt (different attempt_id). The authority's gate_results guard rejects because the gate result does not belong to the current attempt. No direct-store transition occurs.

- **Structural proof:** Verifies the engine source has a fail-closed check for the gate_results guard + cleanup_pending edge.

All tests assert:
- The AttemptRunner throws (does not silently succeed).
- No `StateStore.advanceAttemptState` call occurs for the verifying→cleanup_pending edge (no `state_transitions` row with `owner_service = "AttemptLifecycleService"`).
- The attempt remains in "verifying" state (no transition occurred).

### Red-then-green proof

**Red (before fix):** Test (a) failed because the runner resolved with `{ outcome: 'failed_clean' }` instead of rejecting — the empty gateResultIds fell back to `advanceAttemptState`, persisting a transition with the wrong owner_service and placeholder context digest. Tests (b) and (c) already passed (the authority path already rejected stale context and wrong-owner evidence).

**Green (after fix):** All 4 tests pass. The engine now throws `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL` for the verifying→cleanup_pending edge when gateResultIds is empty/missing, preventing the direct-store fallback.

## Proof Counts

- 4/4 focused gate (new test file: `m6-scrutiny-round-5-empty-gate-ids-fail-closed.test.ts`)
- 164/164 scoped M6 regression (9 M6-area suites including the new test file)
- 40/40 additional M6 AttemptRunner suites (3 files)
- 367/367 Python policy suite (3 skipped — pre-existing)
- typecheck: green
- build: green
- citadel: 0 CRITICAL, 0 HIGH (6 MEDIUM, 1 LOW — all pre-existing)
- doctor: exit 0

## Known Limitations

None. The fix is complete and does not introduce new findings.

## Next Dependency Boundary

M6 scrutiny round 5 is complete. The verifying→cleanup_pending edge now rejects empty/missing gateResultIds fail-closed with no fallback to StateStore.advanceAttemptState. End-to-end AttemptRunner verification-failure tests cover the real production path with malformed provider output (empty gate IDs, stale context, wrong-owner evidence).
