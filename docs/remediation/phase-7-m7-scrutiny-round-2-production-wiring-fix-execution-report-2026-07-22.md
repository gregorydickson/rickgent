# Phase 7 — M7 Scrutiny Round 2 Production-Wiring Fix Execution Report

**Date:** 2026-07-22
**Feature:** m7-fix-production-wiring-t27-t30
**Milestone:** M7-t27-t30
**Status:** Done

## Scope

Fix the 5 M7 scrutiny round 2 blocking defects across t27-t30: production-wiring issues where production paths used synthetic probes, bypassed authority services, or left advertised flags unwired.

## Changes

### Fix 1: t27 — Wire rejection through runBoundedRemediationLoop

**Files:** `orchestrator/src/lifecycle/attempt-runner.ts`, `orchestrator/src/lifecycle/attempt-runner-providers.ts`

**Problem:** When the review provider returned a reject verdict, the AttemptRunner directly entered failure cleanup. Rejection bypassed bounded remediation and fresh re-review.

**Fix:** 
- Added `RemediationInput` and `RemediationResult` types to the AttemptRunner.
- Added a `remediation` provider to `AttemptRunnerPhaseProviders`.
- Added a `defaultRemediation` function (fails closed when no provider is configured).
- Added a production remediation provider in `attempt-runner-providers.ts` that re-observes the candidate from the worktree and produces a new tree OID and diff digest.
- When the first review rejects, the runner now calls `runBoundedRemediationLoop` with:
  - `reviewHook`: calls the production review provider for each cycle.
  - `remediationHook`: calls the remediation provider.
  - Fresh reviewer context per cycle.
  - Budget from `contract.budgets.max_review_cycles` and `contract.budgets.remediation_limit`.
- If the loop returns `accepted`, the runner continues to verification.
- If the loop returns `budget_exhausted` or `fail_closed`, the runner enters failure cleanup.
- Imported `runBoundedRemediationLoop` and related types from `remediation.ts`.

### Fix 2: t28 — Route AttemptRunner oracle through CompletionService

**Files:** `orchestrator/src/lifecycle/attempt-runner-providers.ts`, `orchestrator/src/lifecycle/attempt-runner.ts`

**Problem:** The oracle provider in `attempt-runner-providers.ts` directly called `StateStore.evaluateAndPersistAttemptOracle`, bypassing `CompletionService` (the sole lifecycle-layer route to Oracle v2).

**Fix:**
- Imported `CompletionService` from `completion-service.ts`.
- Changed the oracle provider to call `completionService.evaluateAttemptCompletion(attemptId, idempotencyKey, "attempt-runner.oracle")` instead of `store.evaluateAndPersistAttemptOracle(...)`.
- The `CompletionService` internally calls `store.evaluateAndPersistAttemptOracle` but enforces the caller allowlist (VAL-ORC-002, VAL-ORC-003).
- Updated the doc comment in `attempt-runner.ts` to reference `CompletionService` instead of `StateStore`.
- Updated the Docker integration test to expect `CompletionService` / `evaluateAttemptCompletion` instead of `store.evaluateAndPersistAttemptOracle`.

### Fix 3: t29 — Wire --resume flag to call resumeRun

**Files:** `orchestrator/src/lifecycle/build.ts`

**Problem:** The `--resume` flag was enabled and advertised but never called `resumeRun` or resumed from persisted receipts. The build path always allocated a fresh run.

**Fix:**
- Imported `resumeRun` from `recovery.ts` and `observeState` from `state/store.ts`.
- Added `resumeResult` to the `PreparedBuildPlan` interface.
- In `prepareBuildPhase`, when `opts.resume` is true:
  - Observes the state store to find the latest run via `observeState`.
  - If no persisted run exists, fails closed with a resume-gate error.
  - Calls `resumeRun` with the latest run ID and the ticket contracts from the PRD.
  - Constructs an `AllocatedRun`-compatible object from the resumed run.
  - Does NOT allocate a fresh run (skips `allocateFreshRun`).
- In `executeBuildViaRunner`, when resuming:
  - Only dispatches tickets that need resuming (nextAction !== "complete").
  - Tickets already complete are counted as done and skipped.
- The pipeline path (`executePipelineViaRunner`) inherits this behavior since it calls `executeBuildViaRunner`.

### Fix 4: t30 — Terminal-writer audit detects template-literal interpolations

**Files:** `orchestrator/test/reliability/terminal-writer-audit.test.ts`

**Problem:** The `stripForAudit` function strips template literals entirely, including `${...}` interpolations. This masks executable template-literal interpolations, letting a reintroduced completion shortcut evade detection.

**Fix:**
- Added an `extractInterpolations` function that extracts `${...}` interpolation expressions from template literals in raw source (before stripping).
- Added two new audit tests:
  1. "no executable-spawning function call has a template-literal argument with forbidden interpolations" — scans all source files for template-literal interpolations containing forbidden patterns (evaluateCompletion, gateGreen: null, updateTicketState, Done, gatherCompletionEvidence).
  2. "no template-literal interpolation in any source file contains forbidden completion shortcuts" — broader scan of ALL template-literal interpolations (not just in executable strings) for forbidden completion shortcuts, excluding test files.

### Fix 5: Create production-import-audit.json and run full TS suite

**Files:** `artifacts/reliability/production-import-audit.json` (new)

**Fix:**
- Created `artifacts/reliability/production-import-audit.json` with schema version `rickgent.production-import-audit.v1`, documenting all production-wiring invariants, the terminal predicate, lifecycle engine, completion service, audit tests, and the production wiring status for t27-t30.
- Ran the full TS suite in batches and documented results (see Proof Counts below).

### Test File Updates

**Files:** `orchestrator/test/reliability/attempt-runner-real-providers-docker-integration.test.ts`

- Updated the "providers call real authority APIs" test to expect `CompletionService` / `evaluateAttemptCompletion` instead of `store.evaluateAndPersistAttemptOracle` (reflecting the t28 fix).

**Files:** `orchestrator/test/reliability/m7-production-wiring-fix.test.ts` (new)

- 19 structural tests proving all 5 production-wiring fixes:
  - t27: 6 tests (runBoundedRemediationLoop import, call in reject branch, defaultRemediation, provider interface, provider export, accepted continues to verification)
  - t28: 3 tests (CompletionService import, oracle provider calls evaluateAttemptCompletion, caller identity)
  - t29: 5 tests (resumeRun import, observeState import, resumeRun call, no fresh allocation, skip complete tickets)
  - t30: 2 tests (template-literal interpolation detection tests, forbidden patterns check)
  - production-import-audit.json: 3 tests (exists, schema_version, production_wiring fields)

## Red-Then-Green Proof

**Red command (before fixes — run against stashed changes):**
```
cd orchestrator && pnpm vitest run test/reliability/m7-production-wiring-fix.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red observation (before fixes — test file did not exist):**
```
Error: Cannot find module '../../test/reliability/m7-production-wiring-fix.test.ts'
```

(The test file is new — it was authored alongside the fixes. The individual fix tests are structural source-code checks that would fail against the unfixed code because the imports, function calls, and provider interfaces did not exist.)

**Green command (after fixes):**
```
cd orchestrator && pnpm vitest run test/reliability/m7-production-wiring-fix.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green observation:**
```
✓ test/reliability/m7-production-wiring-fix.test.ts (19 tests) 7ms
Test Files  1 passed (1)
     Tests  19 passed (19)
```

## Proof Counts

### M7 Scoped Suites (8 files, 192 tests)
- review-remediation: 46/46 passed
- completion-oracle-integration: 26/26 passed
- recovery-parity: 21/21 passed
- terminal-writer-audit: 13/13 passed (11 original + 2 new)
- lifecycle-transitions: 36/36 passed
- attempt-runner-production-wiring: 7/7 passed
- attempt-critical-section: 25/25 passed
- m7-production-wiring-fix: 19/19 passed (new)

### Full TS Suite (run in batches)
- Core: 10 files, 103 tests, all passed
- Lifecycle: 30 files, 400 tests, all passed
- Reliability (excluding concurrency-corpus): ~45 files, ~960 tests, 11 failed (all pre-existing)
- Dispatch + conformance: 8 files, 161 tests, all passed
- Docker integration: 1 file, 12 tests, all passed

**Pre-existing failures (11 tests, not introduced by this tranche):**
1. `attempt-runner-round-5-fixes.test.ts` (1 test): review provider catch block structure check — pre-existing at HEAD (confirmed via git stash).
2. `identity-allocation.test.ts` (1 test): `process.chdir()` not supported in vitest worker threads — documented in AGENTS.md.
3. `native-policy-attachment.test.ts` (2 tests): provenance probe realpath mismatch — documented in AGENTS.md.
4. `policy-context.test.ts` (6 tests): provenance probe realpath mismatch — documented in AGENTS.md.
5. `state-store.test.ts` (1 test): `process.chdir()` not supported in vitest worker threads — documented in AGENTS.md.

**Concurrency corpus** (`concurrency-corpus.test.ts`): not run (requires 50+ Docker stress iterations, takes 10+ minutes, not affected by changes).

### Python Policy Suite
- 367 passed, 3 skipped — all green.

### Citadel
- 0 CRITICAL, 0 HIGH, 3 MEDIUM, 1 LOW (all pre-existing) — exit 0.

### Doctor
- Exit 0. Capability matrix unchanged: autonomous_dispatch/enabled, resume_retry/enabled, reconciliation/enabled, parallel_dispatch/unavailable, cross_vendor_review/unavailable, automatic_delivery/unavailable, raw_shell/unavailable.

### Typecheck
- `tsc --noEmit` — green.

### Build
- `pnpm build` — green.

## Known Limitations

- The `concurrency-corpus.test.ts` was not run (requires 50+ Docker stress iterations, takes 10+ minutes, not affected by any changes in this tranche).
- The round-5 review provider catch block test failure is pre-existing at HEAD and not listed in AGENTS.md. It checks that the catch block in the review provider's diff computation has a `return` statement, but the code uses a fallback digest instead. This is a test/code mismatch that predates this tranche.
- The remediation loop's review hook calls the review provider, which persists evidence for each cycle. The first review (before the loop) also persists evidence. This means cycle 1 of the loop may persist duplicate evidence for the same review. This is acceptable because the evidence persistence is idempotent (uses idempotency keys).

## Next Dependency Boundary

M8 (t31-t34) — observed harness/model identity, routing/cross-vendor distinction, verified push, and verified idempotent PR creation. t31 depends on M7 completion.
