# M7 Scrutiny Round 15 — Derive Guard Kind from Edge Execution Report

**Date:** 2026-07-22
**Scope:** M7 scrutiny round 15 blocking defect — `TransitionAuthority.commitAttemptEdge` still accepts caller-selected `TransitionGuard` kinds, allowing a genuine remediator-owned `remediation_record` guard to authorize the reviewer-only `remediation_captured → reviewing` edge.

## Problem

Round 14 fixed only the `expectedRole` for `execution_context` guards: if the caller passes an `execution_context` guard, the edge's declared role overrides the caller's `expectedRole`. But the guard **KIND** was still caller-selected. A caller could pass a `remediation_record` guard (a genuine remediator-owned guard with a real remediation record in the DB) for the `remediation_captured → reviewing` edge, which the edge declares as `execution_context` with role `reviewer`. The `#deriveEdgeGuard` method only overrode `expectedRole` for `execution_context` guards and returned all other guard kinds unchanged. The StateStore then validated the `remediation_record` guard, found the genuine remediation record, and the transition **SUCCEEDED** — bypassing the `execution_context` requirement entirely.

## Fix

`commitAttemptEdge` now derives the **ENTIRE** guard (both kind AND expectedRole) from the normative `PHASE_TRANSITION_TABLE` edge definition, completely ignoring the caller-provided guard:

1. The method looks up the edge in `PHASE_TRANSITION_TABLE` via `legalPhaseEdge(from, to)`.
2. It constructs the guard from the edge's declared `guard` kind (a `PhaseGuardKind`) and `role` (a `PhaseRole`), mapping the edge's guard kind to the corresponding `TransitionGuard` discriminated union member.
3. The caller-provided guard's `kind` and `expectedRole` are **IGNORED entirely**. Only the guard's data fields (`contextId`, `gateResultIds`, `commitAttributionId`) are extracted as a fallback when the dedicated request fields are not provided — this maintains backward compatibility with callers that pass the data inside the guard.
4. New dedicated request fields (`contextId`, `gateResultIds`, `commitAttributionId`) allow callers to provide the guard's data fields directly, without passing a guard at all.
5. If the edge requires `execution_context` but no `contextId` is available (neither from the dedicated field nor from the caller-provided guard), the transition fails closed with a `TypeError`.
6. If the edge declares a guard kind not supported by the generic `commitAttemptEdge` path (e.g., `live_lease`, `process_receipt`, `review_record`, `remediation_record`, `cleanup_record`, `oracle_promotion`, `verified_promotion`), the transition fails closed — those edges use the typed `TransitionAuthority` methods directly.

The `LifecycleEngine.transitionAttempt` method was updated to pass the raw data fields (`contextId`, `gateResultIds`, `commitAttributionId`) alongside the guard to `commitAttemptEdge`.

## Files Changed

- `orchestrator/src/state/transitions.ts` — `commitAttemptEdge` method signature (guard made optional, new `contextId`/`gateResultIds`/`commitAttributionId` fields) and `#deriveEdgeGuard` rewrite (derives ENTIRE guard from edge definition).
- `orchestrator/src/lifecycle/engine.ts` — `transitionAttempt` passes raw data fields to `commitAttemptEdge`.
- `orchestrator/test/reliability/m7-scrutiny-round-15-derive-guard-kind-from-edge.test.ts` — new test file with 3 test cases.

## Tests

### Red-first proof (negative test)

**Test:** `negative proof: genuine remediation_record guard CANNOT authorize the remediation_captured to reviewing edge through commitAttemptEdge`

**Red output (before fix):**
```
AssertionError: expected false to be true // Object.is equality
```
The transition SUCCEEDED with the `remediation_record` guard — the test expected a throw but got none.

**Green output (after fix):**
```
✓ negative proof: genuine remediation_record guard CANNOT authorize ...
```
The transition fails closed because `commitAttemptEdge` derives the `execution_context` guard from the edge definition, and no `contextId` is available (the caller passed a `remediation_record` guard, not a `contextId` field).

### Positive proofs

1. **NO guard + contextId field:** `commitAttemptEdge` derives the `execution_context` guard from the edge definition (kind `execution_context`, role `reviewer`) and uses the provided `contextId`. The reviewer context matches the edge's declared role. Transition SUCCEEDS.

2. **WRONG guard kind (remediation_record) + contextId field:** `commitAttemptEdge` IGNORES the `remediation_record` guard and derives the `execution_context` guard from the edge. The reviewer context matches. Transition SUCCEEDS.

### Test counts

- 3/3 new test cases pass (1 negative + 2 positive)
- 96/96 scoped M7 suite tests pass (9 files)
- 367 passed / 3 skipped Python policy tests
- 37/38 additional affected tests pass (1 pre-existing failure: `RICKGENT_ATTEMPT_REMEDIATION_UNCONFIGURED` in `attempt-critical-section.test.ts`, documented in AGENTS.md)

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean (exit 0) |
| `pnpm build` | dist/cli.js rebuilt (exit 0) |
| Scoped M7 vitest (9 files) | 96/96 passed |
| `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped |
| `citadel --prd MISSION_3_PRD.md --repo .` | 0 CRITICAL, 0 HIGH (4 MEDIUM pre-existing) |
| `doctor` | exit 0 (capability matrix unchanged) |

## Known Limitations

- The `guard` field in the `commitAttemptEdge` request is kept as optional for backward compatibility. Its `kind` and `expectedRole` are ignored entirely; only its data fields (`contextId`, `gateResultIds`, `commitAttributionId`) are extracted as a fallback when the dedicated request fields are not provided.
- The full TS suite is not run (M7 is an intermediate milestone; full-suite runs are gated at M9/M10 per AGENTS.md).

## Next Dependency Boundary

No downstream dependency boundary. This fix closes the final M7 scrutiny round 15 blocking defect. The guard (kind + role) for `commitAttemptEdge` now comes ENTIRELY from the normative edge definition, eliminating ALL caller-controlled guard substitution.
