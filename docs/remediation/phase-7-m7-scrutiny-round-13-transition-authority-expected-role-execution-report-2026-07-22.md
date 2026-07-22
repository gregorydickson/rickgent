# Phase 7 — M7 Scrutiny Round 13: Typed TransitionAuthority Guard Binds expectedRole

**Date:** 2026-07-22
**Scope:** M7-t27-t30 scrutiny round 13 blocking defect — the typed `TransitionAuthority` methods that create `execution_context` guards did not bind `expectedRole`, allowing cross-role authority substitution through the typed authority API directly.

## Defect

Round 12 added `expectedRole` to the `execution_context` `TransitionGuard` type and the `LifecycleEngine`'s `guardForEdge` function, which passes the edge's declared role. However, the **typed** `TransitionAuthority` methods (`beginReview`, `beginReviewAfterRemediation`, `beginVerification`) themselves did **not** bind `expectedRole` in the guard they construct. They passed only `{ kind: "execution_context", contextId: request.contextId }` without an expected role.

As a result, a caller that invokes the typed authority API directly (not through the `LifecycleEngine`) could pass a **remediator** execution context to authorize a ReviewService/reviewer edge. The `StateStore` fell back to the legacy context+digest-only check (no role validation) and the cross-role substitution succeeded.

The `expectedRole` field was also **optional** in the `TransitionGuard` type, meaning any future transition could accidentally omit the role check by constructing an `execution_context` guard without `expectedRole`.

## Fix

Three coordinated changes:

1. **`orchestrator/src/state/transitions.ts`** — The `expectedRole` field in the `execution_context` `TransitionGuard` type is now **mandatory** (`readonly expectedRole: string`, not optional). All three typed `TransitionAuthority` methods that use `execution_context` guards now bind the correct role:
   - `beginReview`: `expectedRole: "reviewer"` (implementation_captured to reviewing)
   - `beginReviewAfterRemediation`: `expectedRole: "reviewer"` (remediation_captured to reviewing)
   - `beginVerification`: `expectedRole: "verifier"` (verification_queued to verifying)

2. **`orchestrator/src/state/store.ts`** — The `#validateTransitionGuard` method for `execution_context` guards now **always** checks the context's `role` column against `expectedRole`. The legacy optional/fallback branch (context+digest-only check when `expectedRole` is absent) is removed. Since `expectedRole` is now mandatory in the type, the guard always validates the role at the `StateStore` level, regardless of whether the caller routes through the `LifecycleEngine` or the typed `TransitionAuthority` API directly.

3. **`orchestrator/src/lifecycle/engine.ts`** — The `guardForEdge` function already passed `expectedRole: edge.role` (from round 12); no change needed. The type change from optional to mandatory is satisfied by the existing code.

## Test Corpus

**New test file:** `orchestrator/test/reliability/m7-scrutiny-round-13-transition-authority-expected-role.test.ts` (2 test cases)

1. **Negative proof (direct TransitionAuthority API):** Creates a remediator execution context and calls `TransitionAuthority.beginReviewAfterRemediation` **directly** (not through `AttemptRunner` or `LifecycleEngine`). Asserts the transition fails closed with `RICKGENT_STATE_TRANSITION_ILLEGAL` (cross-role substitution rejected at the StateStore level). Red against unfixed code: the transition succeeds because the typed method does not set `expectedRole`, so the guard uses the legacy context+digest-only check.

2. **Positive proof (direct TransitionAuthority API):** Creates a reviewer execution context and calls `TransitionAuthority.beginReviewAfterRemediation` directly. Asserts the transition succeeds. Green before and after fix (the guard validates context_id + context_digest + role; a correct-role context passes).

**Updated test file:** `orchestrator/test/reliability/transition-authority.test.ts`
- `advanceToVerifying` helper: now uses pre-created reviewer and verifier contexts (from `LineageFixture`) for `beginReview` and `beginVerification` calls, with matching `ownerContextDigest` values.
- Phase-flow test: same fix — uses `fixture.reviewContext` and `fixture.verificationContext` for the `beginReview` and `beginVerification` calls.
- Context-mismatch-review test: uses `fixture.reviewContext` (role "reviewer") so the role matches the guard's `expectedRole`; the test specifically proves that a different context's digest is rejected (digest mismatch, not role mismatch).
- `LineageFixture` interface: extended with `reviewContext` and `verificationContext` fields, pre-created in `lineageFixture()` and `additionalLineage()` before any candidate commit (so scope validation in `resolvePhaseContext` does not fail on an already-existing candidate file).

## Red-Green Evidence

**Red (before fix):**
```
× negative proof: remediator context CANNOT authorize the remediation_captured to reviewing edge through the typed TransitionAuthority API (guard fails closed)
  → expected [Function] to throw an error
```
The transition SUCCEEDED with the remediator context because the typed `beginReviewAfterRemediation` method did not bind `expectedRole`, so the StateStore used the legacy context+digest-only check.

**Green (after fix):**
```
✓ negative proof: remediator context CANNOT authorize the remediation_captured to reviewing edge through the typed TransitionAuthority API (guard fails closed)
✓ positive proof: reviewer context CAN authorize the remediation_captured to reviewing edge through the typed TransitionAuthority API
2 passed | 0 failed
```

## Verification

| Check | Result |
|-------|--------|
| `pnpm typecheck` | Green (tsc --noEmit clean) |
| `pnpm build` | Green (dist/cli.js refreshed) |
| Scoped M7 + transition suites (11 files, 121 tests) | 121/121 passed |
| `python3 -m pytest` | 367 passed, 3 skipped |
| `rickgent citadel --prd MISSION_3_PRD.md --repo .` | Exit 0, 0 CRITICAL, 0 HIGH (7 MEDIUM pre-existing, 1 LOW pre-existing) |
| `rickgent doctor` | Exit 0 |

## Known Limitations

None. The `expectedRole` field is now mandatory for every `execution_context` guard, preventing any transition from accidentally omitting the role check. All five construction sites (three typed `TransitionAuthority` methods + the `LifecycleEngine`'s `guardForEdge` + the type definition) now consistently bind the expected role.

## Next Dependency Boundary

M7 scrutiny round 13 complete. All M7 scoped suites pass. The typed `TransitionAuthority` guard now binds `expectedRole` at the authority level, and the `StateStore` always validates the context's role column against the guard's `expectedRole`. Cross-role authority substitution is rejected fail-closed at the StateStore level, regardless of whether the caller routes through the `LifecycleEngine` or the typed `TransitionAuthority` API directly.
