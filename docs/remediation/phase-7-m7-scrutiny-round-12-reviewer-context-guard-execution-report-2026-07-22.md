# Phase 7 — M7 Scrutiny Round 12: Reviewer Context Guard for remediation_captured to reviewing Transition

**Date:** 2026-07-22
**Scope:** M7-t27-t30 scrutiny round 12 blocking defect — cross-role authority substitution in the `remediation_captured -> reviewing` lifecycle transition.

## Defect

The `remediation_captured -> reviewing` transition in `AttemptRunner.persistRemediationRecord` (attempt-runner.ts) was routing through the `LifecycleEngine`'s `TransitionAuthority` with a **REMEDIATOR** execution context, but the edge is declared in the `PHASE_TRANSITION_TABLE` with `evidenceProducer: "ReviewService"` and `role: "reviewer"`. The execution-context guard in `StateStore.#validateTransitionGuard` only validated `context_id`, `attempt_id`, and `context_digest` — it did **not** check the context's `role` column. As a result, a remediator context (role `"remediator"`) could authorize a ReviewService/reviewer edge, enabling cross-role authority substitution.

## Fix

Three coordinated changes:

1. **`orchestrator/src/lifecycle/attempt-runner.ts`** — The `persistRemediationRecord` function now creates a fresh **REVIEWER** execution context via `resolveExecutionContext` with `role: "reviewer"` before calling `transitionAttempt` for the `remediation_captured -> reviewing` edge. The transition carries the reviewer context's `contextId` and `contextDigest`, not the remediator context's.

2. **`orchestrator/src/lifecycle/engine.ts`** — The `guardForEdge` function now passes `edge.role` as `expectedRole` into the `execution_context` `TransitionGuard`, so the guard carries the edge's declared role.

3. **`orchestrator/src/state/transitions.ts` + `orchestrator/src/state/store.ts`** — The `execution_context` `TransitionGuard` type now carries an optional `expectedRole` field. The `#validateTransitionGuard` method in `store.ts` checks the `role` column of the `execution_contexts` table against `expectedRole` when it is present. A context whose role does not match the edge's declared role is rejected fail-closed with `RICKGENT_STATE_TRANSITION_ILLEGAL`.

## Test Corpus

**New test file:** `orchestrator/test/reliability/m7-scrutiny-round-12-reviewer-context-guard.test.ts` (3 test cases)

1. **Production-path positive proof:** Drives the real `AttemptRunner.runAttempt` through a remediation cycle (real providers, real Git operations, real authority APIs) and queries the `state_transitions` table. Asserts the `remediation_captured -> reviewing` transition's `owner_context_digest` resolves to an execution context with `role = "reviewer"` (not `"remediator"`). Red against unfixed code: `expected 'remediator' to be 'reviewer'`.

2. **Negative proof:** Creates a remediator context and attempts the `remediation_captured -> reviewing` transition through the `LifecycleEngine` with the remediator context. Asserts the guard rejects the cross-role context substitution fail-closed (throws with `RICKGENT_STATE_TRANSITION_ILLEGAL`). Red against unfixed code: `expected function to throw an error, but it didn't`.

3. **Positive unit proof:** Creates a reviewer context and attempts the same transition. Asserts it succeeds. Green before and after fix (the guard validates context_id + context_digest + role; a correct-role context passes).

## Red-Green Evidence

**Red (before fix):**
```
× remediation_captured to reviewing transition owner_context_digest resolves to a REVIEWER execution context (not remediator)
  → expected 'remediator' to be 'reviewer' // Object.is equality
× negative proof: remediator context CANNOT authorize the remediation_captured to reviewing edge (guard fails closed)
  → expected function to throw an error, but it didn't
```

**Green (after fix):**
```
✓ remediation_captured to reviewing transition owner_context_digest resolves to a REVIEWER execution context (not remediator)
✓ negative proof: remediator context CANNOT authorize the remediation_captured to reviewing edge (guard fails closed)
✓ positive proof: reviewer context CAN authorize the remediation_captured to reviewing edge
3 passed | 0 failed
```

## Verification

| Check | Result |
|-------|--------|
| `pnpm typecheck` | Green (tsc --noEmit clean) |
| `pnpm build` | Green (dist/cli.js refreshed) |
| Scoped M7 suites (7 files, 49 tests) | 49/49 passed |
| M6 lifecycle/transition suites (4 files, 58 tests) | 58/58 passed |
| Attempt-runner related suites (4 files, 75 tests) | 74/75 passed (1 pre-existing: `attempt-critical-section.test.ts` review-reject no remediation provider) |
| State-store/reliability suites (5 files, 65 tests) | 64/65 passed (1 pre-existing: `state-store.test.ts` process.chdir() in workers) |
| Round-5/cutover/crash suites (4 files, 39 tests) | 36/39 passed (3 pre-existing: round-5 catch block, cutover legacy path, crash corpus stale inventory) |
| `python3 -m pytest` | 367 passed, 3 skipped |
| `rickgent citadel --prd MISSION_3_PRD.md --repo .` | Exit 0, 0 CRITICAL, 0 HIGH (7 MEDIUM pre-existing, 1 LOW pre-existing) |
| `rickgent doctor` | Exit 0 |

## Known Limitations

- The `implementation_captured -> reviewing` transition (the initial review entry) does not currently pass `contextId`/`contextDigest` to the `LifecycleEngine`, so it falls back to the store CAS path (no `execution_context` guard validation). This is a pre-existing issue not introduced by this fix and is out of scope for round 12.

## Next Dependency Boundary

M7 scrutiny round 12 complete. All M7 scoped suites pass with only pre-existing failures. The `remediation_captured -> reviewing` transition now carries a REVIEWER context, and the execution-context guard rejects cross-role authority substitution fail-closed.
