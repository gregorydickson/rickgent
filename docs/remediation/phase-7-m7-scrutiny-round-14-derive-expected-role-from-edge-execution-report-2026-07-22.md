# M7 Scrutiny Round 14 — Derive expectedRole from PHASE_TRANSITION_TABLE edge definition

**Date:** 2026-07-22
**Scope:** M7 scrutiny round 14 blocking defect fix.
**Ticket:** t27 (independent review and bounded remediation) — scrutiny round 14.

## Problem

The public `TransitionAuthority.commitAttemptEdge` method accepted a caller-provided `guard` containing a caller-selected `expectedRole` for `execution_context` guards. A caller could call `commitAttemptEdge` directly with `expectedRole: "remediator"` and a genuine remediator execution context for the reviewer-only `remediation_captured -> reviewing` edge. The StateStore validated the caller-provided role against the context's role (both "remediator" — match — pass), accepting the cross-role substitution.

Rounds 12 and 13 fixed the `LifecycleEngine.guardForEdge` and the typed `TransitionAuthority.beginReviewAfterRemediation` method respectively, but the generic `commitAttemptEdge` API — the authoritative boundary for all attempt-edge commits routed through the TransitionAuthority — still trusted the caller-provided `expectedRole`.

## Fix

`commitAttemptEdge` now derives the `expectedRole` from the normative `PHASE_TRANSITION_TABLE` edge definition (via `legalPhaseEdge` from `lifecycle/phase.ts`), NOT from the caller-provided guard. When the guard is `execution_context`, the method:

1. Looks up the edge in `PHASE_TRANSITION_TABLE` using `legalPhaseEdge(from, to)`.
2. Overrides the guard's `expectedRole` with the edge's declared `role` field.
3. Passes the overridden guard to `StateStore.commitAuthorizedTransition`.

The caller-provided `expectedRole` is IGNORED — the edge's declared role is the sole authority. This eliminates the cross-role substitution vector entirely: the role comes from the normative edge definition, not the caller.

For non-`execution_context` guards, the caller-provided guard is returned unchanged.

### Files changed

- `orchestrator/src/state/transitions.ts` — Added import of `legalPhaseEdge` and `PhaseState` from `../lifecycle/phase.js`. Added `#deriveEdgeGuard` private method. Updated `commitAttemptEdge` to call `#deriveEdgeGuard` before delegating to `#commit`.
- `orchestrator/test/reliability/m7-scrutiny-round-14-derive-expected-role-from-edge.test.ts` — New test file with 3 test cases.

## Test evidence

### Red test (before fix)

Command:
```
cd orchestrator && pnpm vitest run test/reliability/m7-scrutiny-round-14-derive-expected-role-from-edge.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

Red output (2 failed, 1 passed):
- Negative proof: `expected false to be true` — the transition SUCCEEDED because the caller-provided `expectedRole: "remediator"` matched the remediator context's role. The test expected a throw but got none.
- Override-ignore proof: `StateStoreError: phase transition context role does not match the edge's declared role 'remediator'` — the caller-provided "remediator" was used by StateStore instead of the edge's "reviewer", causing the reviewer context to be rejected.

### Green test (after fix)

Same command. Green output (3 passed):
- Negative proof: remediator context + caller "remediator" → edge's "reviewer" overrides → remediator context ≠ reviewer → `RICKGENT_STATE_TRANSITION_ILLEGAL` → PASS.
- Positive proof: reviewer context + caller "reviewer" → edge's "reviewer" (same) → reviewer context = reviewer → succeeds → PASS.
- Override-ignore proof: reviewer context + caller "remediator" (wrong) → edge's "reviewer" overrides → reviewer context = reviewer → succeeds → PASS.

## Scoped regression

- `pnpm typecheck` — green (0 errors).
- `pnpm build` — green (dist/cli.js rebuilt).
- Scoped M7 suites (7 files, 108 tests) — all green:
  - `m7-scrutiny-round-11-remediation-transition-authority.test.ts`
  - `m7-scrutiny-round-12-reviewer-context-guard.test.ts`
  - `m7-scrutiny-round-13-transition-authority-expected-role.test.ts`
  - `m7-scrutiny-round-14-derive-expected-role-from-edge.test.ts`
  - `lifecycle-transitions.test.ts`
  - `transition-authority.test.ts`
  - `m6-scrutiny-round-1-fixes.test.ts`
- Broader M6/M7 suites (6 files, 52 tests, 1 pre-existing failure) — all green except the documented pre-existing `attempt-critical-section.test.ts` RICKGENT_ATTEMPT_REMEDIATION_UNCONFIGURED failure.
- M7 scrutiny round suites (8 files, 35 tests) — all green.
- Lifecycle + core suites (40 files, 503 tests) — all green.
- Dispatch + conformance + key reliability suites (14 files, 238 tests, 2 pre-existing failures) — all green except the documented pre-existing `process.chdir()` environmental failures in `identity-allocation.test.ts` and `state-store.test.ts`.
- Additional reliability suites (5 files, 100 tests, 1 pre-existing failure) — all green except the documented pre-existing `state-crash-corpus.test.ts` stale transaction inventory failure.
- `python3 -m pytest test/ -p no:cacheprovider -q` — 367 passed, 3 skipped.
- `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` — exit 0, 0 CRITICAL, 0 HIGH (6 MEDIUM pre-existing, 1 LOW pre-existing).
- `node orchestrator/dist/cli.js doctor` — exit 0, capability matrix unchanged.

## Proof counts

- 3/3 focused gate (round 14 test file).
- 108/108 scoped M7 transition suites.
- 503/503 lifecycle + core suites.
- 238/238 dispatch + conformance + key reliability (excluding 2 pre-existing environmental failures).
- 367/367 Python policy suite (3 skipped, documented).

## Known limitations

None. The fix is complete and eliminates the cross-role substitution vector at the generic `commitAttemptEdge` API level.

## Next dependency boundary

No further dependencies. The cross-role substitution vector is now closed at both the typed method level (round 13) and the generic `commitAttemptEdge` level (round 14).
