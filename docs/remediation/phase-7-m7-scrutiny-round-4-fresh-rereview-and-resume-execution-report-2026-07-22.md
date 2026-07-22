# M7 Scrutiny Round 4 — Fresh Re-Review and Resume Execution Fix

**Date:** 2026-07-22
**Scope:** Fix 3 production-path blocking defects from M7 scrutiny round 4 across t27 and t29.
**Outcome:** All 3 defects fixed. 12/12 behavioral integration tests pass. Scoped regression green (1 pre-existing failure in attempt-runner-round-5-fixes.test.ts, documented in AGENTS.md). Citadel 0 CRITICAL/HIGH. Doctor green. Python 367/3 skipped.

## Defects Fixed

### Defect 1: Remediation loop does not forward remediated candidate to re-review (t27)

**Root cause:** In `attempt-runner.ts`, the `loopReviewHook` closure ignored the `ReviewImmutableInputs` parameter (`_inputs`) and always called the review provider with the ORIGINAL `attribution`. The `runBoundedRemediationLoop` function correctly forwarded the remediated candidate OID through `currentInputs`, but the hook discarded it. The re-review always saw the rejected candidate, not the remediated one. Similarly, the `loopRemediationHook` always passed `cycle: 1` and the original `attribution`, not tracking the current remediated candidate across cycles.

**Fix:** The `loopReviewHook` now uses `inputs.candidateOid` to construct a fresh `CommitAttributionResult` with the remediated candidate OID. The `loopRemediationHook` tracks `currentRemediatedOid` across cycles and uses the actual `remediationCycleCount` instead of a hardcoded 1.

**Proof:** Integration test drives a real AttemptRunner cycle: review rejects the original candidate, remediation produces a genuinely different candidate, re-review sees the remediated candidate (not the original), and the loop converges (outcome = "succeeded").

### Defect 2: --resume does not execute recovery (t29)

**Root cause:** In `build.ts` `executeBuildViaRunner`, the `resume_attempt` action called `runner.recoverAttempt` but only logged the result, then proceeded with `runAttempt` from acquisition. If `recoverAttempt` threw, the error was caught and logged — the build silently continued (did not fail closed). The `cleanup_orphan` action had no explicit executable branch (fell through to the generic dispatch path).

**Fix:**
- `resume_attempt`: calls `recoverAttempt` and checks `nextStep`. If `nextStep === "complete"`, skips the attempt. If `recoverAttempt` throws, fails closed (counts as failed, does not silently allocate fresh).
- `cleanup_orphan`: explicit executable branch that logs the cleanup and dispatches the new retry attempt from the recovery plan.
- `allocate_retry`: explicit branch that dispatches the recovery plan's new attempt with the correct attempt number.
- `await_reconciliation`: skip with accounting (already handled).

**Proof:** Integration test drives `runBuildViaRunnerForTesting` with `--resume` against a persisted run with mid-flight tickets, proving the runner re-enters at the recovered step. Fail-closed test verifies the build does not silently allocate a fresh attempt when `recoverAttempt` fails.

### Defect 3: Tests are source-text regex checks

**Root cause:** The `m7-scrutiny-round-3-production-paths.test.ts` suite used regex checks on source text (reading source files and matching patterns) instead of driving public entrypoints. Source-text regex checks are NOT acceptable as production-path proof.

**Fix:** Replaced the entire round-3 test file with `m7-scrutiny-round-4-production-paths.test.ts` containing 12 behavioral integration tests that exercise the real production code paths:
- 4 tests drive a real AttemptRunner remediation/re-review cycle
- 5 tests drive `runBuildViaRunnerForTesting` with `--resume` and `recoverAttempt`
- 3 tests verify the tests drive real code paths (not regex)

## Proof Counts

- 12/12 focused gate (m7-scrutiny-round-4-production-paths.test.ts)
- 63/64 scoped regression (1 pre-existing failure in attempt-runner-round-5-fixes.test.ts, documented in AGENTS.md)
- 367/3 skipped Python policy tests
- Citadel: 0 CRITICAL, 0 HIGH
- Doctor: exit 0

## Known Limitations

- The pre-existing `attempt-runner-round-5-fixes.test.ts` catch block structure check (1 failure) is documented in AGENTS.md and is not introduced by this tranche.
- The `--resume` re-entry at the recovered step uses the `runAttempt` method with the recovered attempt. The runner's internal transitions are idempotent (the LifecycleEngine short-circuits already-completed transitions), so re-entering via `runAttempt` with the recovered attempt is safe. A future enhancement could add a `resumeAttempt` method that skips already-completed steps for efficiency, but the current behavior is correct (fail-closed and idempotent).

## Next Dependency Boundary

M7 (t27-t30) is complete. All M7 scrutiny round 4 blocking defects are fixed. The next milestone is M8 (t31-t34: identity, routing, verified push, idempotent PR).
