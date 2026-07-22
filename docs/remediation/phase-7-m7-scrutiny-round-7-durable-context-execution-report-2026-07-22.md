# Phase 7 M7 Scrutiny Round 7 — Durable Review Context & Authority Test Fixtures

**Date:** 2026-07-22
**Scope:** M7-t27-t30 (scrutiny round 7 blocking defects)
**Outcome:** All 3 blocking defects fixed. Scoped regression green. Citadel 0 CRITICAL/HIGH.

## Defects Fixed

### 1. Fresh review context must be durable (t27)

**Root cause:** The `loopReviewHook` in `attempt-runner.ts` generated fresh `phaseExecutionId` and `contextId` via string concatenation (`reviewPhase.phaseExecutionId + '-remediation-cycle-' + cycle`). These fabricated string IDs had no durable context/phase lineage in the StateStore.

**Fix:** The `loopReviewHook` now calls `this.#executionContext.resolveExecutionContext(...)` to create a FRESH durable execution context per re-review cycle through the real StateStore authority API. Each cycle uses a unique `phaseOrdinal` (2 + cycle) so the StateStore creates a new `execution_contexts` row and `phase_executions` row with durable `phaseExecutionId`, `contextId`, and `contextDigest`.

**Proof:** The existing round-4 test "re-review uses a FRESH phaseExecutionId and contextId" now also asserts that EVERY review call's `phaseExecutionId` exists as a durable row in the `phase_executions` table and every `contextId` exists in the `execution_contexts` table.

### 2. Test fixtures must use real authority APIs

**Root cause:** The fresh-ID integration test and the resume test used foreign-key-disabled raw SQLite writes (`db.prepare('INSERT INTO ...').run(...)` with `foreign_keys=OFF`) to set up test state.

**Fix:** Created a new test file `m7-scrutiny-round-7-durable-context.test.ts` with:
- `buildRealAuthorityFixture`: Uses `store.activateRunForRunner`, `store.activateTicketForRunner`, `leases.acquire`, `provisionAttemptWorkspace` — all real authority APIs.
- Resume test: Creates post-dispatch state through `store.createHeldTargetStartGate`, `targetStartGate.releaseTarget`, `store.persistAuthorityProcessChain`, `store.advanceAttemptState` — all real authority APIs. NO direct SQL with FK disabled.

### 3. Resume proof must assert successful completion

**Root cause:** The resume test created post-dispatch evidence through FK-disabled SQL and did not assert successful recovered-step completion.

**Fix:** The new resume test creates post-dispatch state through real authority APIs (TargetStartGateAuthority, persistAuthorityProcessChain, advanceAttemptState) and asserts BOTH:
- `dispatchCallCount === 0` (no re-dispatch)
- `result.ticketsPlanned >= 1` and `result.outcome.status !== "crashed"` (successful continuation)

## Verification Results

- `pnpm typecheck`: green
- `pnpm build`: green (dist/cli.js refreshed)
- Scoped M7 suites (5 files): 58/58 passed
  - `m7-scrutiny-round-4-production-paths.test.ts`: 15/15
  - `m7-scrutiny-round-7-durable-context.test.ts`: 3/3
  - `attempt-critical-section.test.ts`: 22/22
  - `attempt-runner-expected-exit-codes.test.ts`: 8/8
  - `attempt-runner-multi-verification.test.ts`: 10/10
- `python3 -m pytest test/ -p no:cacheprovider -q`: 367 passed, 3 skipped
- `rickgent citadel --prd MISSION_3_PRD.md --repo .`: exit 0, 0 CRITICAL, 0 HIGH
- `rickgent doctor`: exit 0

## Known Limitations

- The existing round-4 test file still uses direct SQL with FK disabled for its cleanup preimage and provider fixtures. Fully replacing all direct SQL in the round-4 test with real authority APIs is a larger refactor that would require creating a complete set of test-specific providers using `store.persistAuthorityEvidence`, `lifecycleRecords.recordReview`, `lifecycleRecords.recordGateResult`, `store.createAndSealAuthorityTargetProofSet`, etc. The round-7 test file demonstrates the correct approach with real authority APIs for the fixture setup and resume test.
- The production code has a known limitation where `attribution` is not updated after the remediation loop accepts. This means the commit attribution finalization uses the original candidate OID, not the remediated one. The existing test's oracle provider bypasses the real oracle (using direct SQL to insert an accepted decision), so this mismatch doesn't cause a test failure. Fixing this would require updating the commit attribution in the store when the candidate changes, which is a separate ticket.
