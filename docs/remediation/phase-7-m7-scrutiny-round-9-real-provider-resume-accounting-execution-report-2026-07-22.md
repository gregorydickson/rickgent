# M7 Scrutiny Round 9 — Real Provider + Resume Accounting Fix

**Date:** 2026-07-22
**Scope:** Fix M7 scrutiny round 9 blocking defects: (1) remediation/re-review test must use real production provider, (2) resume accounting bug.

## Outcome

Both blocking defects resolved. All scoped M7 suites pass, typecheck/build/pytest/citadel/doctor all green.

## Defect 1: Remediation/re-review test must use real production provider

**Problem:** The round-8 test used a test-local review provider lookalike (a custom function that mimicked the production provider interface) instead of the real `buildAttemptRunnerProviders` review provider. It also caught/tolerated thrown AttemptRunner results via try/catch.

**Fix:**
- The test now calls `buildAttemptRunnerProviders(store, leases)` to get the REAL production review provider.
- The test overrides ONLY the dispatch provider (fixture that completes quickly) and the remediation provider (fixture that produces a genuinely different candidate).
- The test uses the real `commitAttribution`, `review`, `verification`, `cleanupPreimage`, and `oracle` providers.
- The first candidate contains a banned pattern ("as any") so the REAL production review provider rejects it on cycle 1.
- The remediation provider writes a clean candidate (no banned pattern) so the re-review on cycle 2 accepts.
- The test does NOT wrap `runner.runAttempt` in try/catch — failures propagate.

**Additional production fixes required for the test to pass without try/catch:**
- **cleanupPreimage target proof set guard:** The real `cleanupPreimage` provider used a static `targetProofSetId = target-proof-set-${attemptId}`. When called twice (eligibility step, then failure cleanup after oracle rejection), the second `createAndSealAuthorityTargetProofSet` call conflicted. Fix: check if the target proof set already exists (by checking for the eligibility evidence) before calling `createAndSealAuthorityTargetProofSet`. Skip creation if it exists; the existing sealed proof set is reused.
- **salvage_records row creation:** The real `cleanupPreimage` provider created salvage evidence but not a `salvage_records` row. The `failure_cleanup_records` table has a FOREIGN KEY on `salvage_record_id` referencing `salvage_records`, so `mintFailureCleanup` threw a FK constraint violation. Fix: added `persistAuthoritySalvageRecord` method to StateStore and call it from the cleanupPreimage provider after persisting salvage evidence.

## Defect 2: Resume accounting bug

**Problem:** The second accounting loop in `build.ts executeBuildViaRunner` did not correctly handle `resume_attempt` with `nextStep=complete`. When `recoverAttempt` returned `nextStep=complete` for a `resume_attempt` action, the first loop counted the ticket as done (`ticketsDone++`), but the second accounting loop (which iterates all tickets and checks `drain.results`) did not recognize it and counted it as failed (`ticketsFailed++`). This resulted in `ticketsFailed=1` alongside `ticketsDone=1` for a successfully recovered ticket, causing `outcome.status="failed"` instead of `"succeeded"`.

**Fix:**
- Added a `recoveredCompleteByResume` Set in `executeBuildViaRunner` to track tickets recovered as complete via `recoverAttempt` (resume_attempt with nextStep=complete).
- In the first loop, when `recoveryState.nextStep === "complete"`, the ticket ID is added to the set.
- In the second accounting loop, when a ticket has no dispatchId and the resume plan's action is `resume_attempt`, the set is checked. If the ticket was recovered as complete, it is skipped (not counted as failed).
- The resume test now asserts `outcome.status === 'succeeded'` AND `ticketsFailed === 0` (not just `ticketsDone >= 1`).

## Proof Counts

- **Scoped M7 suites:** 65/65 passed (4 files: m7-scrutiny-round-8, review-remediation, attempt-runner-providers-and-container-env, attempt-runner-production-wiring)
- **M7-related suites batch 1:** 68/69 passed (1 pre-existing failure in attempt-runner-round-5-fixes.test.ts, documented in AGENTS.md)
- **Lifecycle suite:** 400/400 passed
- **Core suite:** 103/103 passed
- **Python policy suite:** 367 passed, 3 skipped
- **Citadel:** 0 CRITICAL, 0 HIGH (1 MEDIUM, 1 LOW — pre-existing)
- **Doctor:** exit 0

## Red-then-green evidence

**Red (before fix):**
- Remediation test: `mint_failure_cleanup violated an immutable state constraint: FOREIGN KEY constraint failed`
- Resume test: `AssertionError: expected 'failed' to be 'succeeded'`

**Green (after fix):**
- All 3 tests in m7-scrutiny-round-8-provider-ids-and-real-proofs.test.ts pass

## Files Changed

- `orchestrator/test/reliability/m7-scrutiny-round-8-provider-ids-and-real-proofs.test.ts` — test fixes (real provider, no try/catch, resume assertions)
- `orchestrator/src/lifecycle/attempt-runner-providers.ts` — cleanupPreimage target proof set guard + salvage record creation
- `orchestrator/src/lifecycle/build.ts` — resume accounting loop fix (recoveredCompleteByResume set)
- `orchestrator/src/state/store.ts` — added persistAuthoritySalvageRecord method

## Known Limitations

- The runner still does not update `attribution` after the remediation loop (the original candidate is used for verification/oracle/finalization). This causes the oracle to reject when the remediated candidate differs from the original. The runner returns `failed_clean` (no throw). The test asserts TWO review records which are persisted before the oracle evaluation. This pre-existing runner issue is out of scope for this fix.
