# Phase 4 — t22D-fix: Production-Wiring Corrections

**Date:** 2026-07-20  
**Milestone:** M4-t22CD  
**Branch:** `remediation/trust-spine-phase-4`  
**Feature:** `m4-fix-production-wiring-attempt-runner`  
**Skill:** remediation-worker  

## Scope

Fix 6 M4 scrutiny round 1 blocking production-wiring defects across t22C (AttemptRunner) and t22D (production cutover). All fixes follow red-then-green TDD proof.

## Defects Fixed

### Defect 1: Run/ticket rows not activated before acquire
**Problem:** Production build did not activate run/ticket rows before `LeaseAuthority.acquire`. Fixtures mutated them to active via raw SQL, but real production didn't.  
**Fix:** Added `activateRunForRunner` and `activateTicketForRunner` store-level methods that transition run/ticket from `planned` to `active` via `state_transitions` rows. `AttemptRunner.runAttempt` calls these before `LeaseAuthority.acquire` when no pre-acquired ownership is supplied (production path).  
**Files:** `store.ts`, `attempt-runner.ts`

### Defect 2: No durable target_start_gates row
**Problem:** Production synthesized `targetStartGateId` but never created the durable `target_start_gates` row. `AttemptRunner.releaseTarget` rejected the missing gate.  
**Fix:** Added `createHeldTargetStartGate` store method (idempotent held gate creation with lineage binding) and `TargetStartGateAuthority.createHeldGate` method. `AttemptRunner.runAttempt` mints the held gate after context preparation using the resolved context's persisted `phaseExecutionId`/`contextId`.  
**Files:** `store.ts`, `target-start-gate.ts`, `attempt-runner.ts`

### Defect 3: nowIso() in mint observations
**Problem:** Runner recovery reconstructed mint observations using `nowIso()`, making completed retries divergent on replay.  
**Fix:** All mint observations (eligibility, promotion, failure-cleanup, quarantine) now use `durableObservedAt` derived from `acquired.ownership.heartbeatAt`. `#failureTerminalize` and `#mintFailureCleanup` signatures updated to accept `durableObservedAt`. All 7 call sites updated.  
**Files:** `attempt-runner.ts`

### Defect 4: Placeholder dispatch + unconfigured providers
**Problem:** Activated public path constructed AttemptRunner without real phase providers and supplied a fixed `node --version` command rather than configured bundle/prompt/model data. Default dispatch failed closed as unconfigured.  
**Fix:** Replaced standalone `defaultDispatch` function (which threw `UNCONFIGURED`) with `#defaultDispatch` method on AttemptRunner that uses `this.#containment.releaseTarget()` (real omnigent run path). Added `buildOmnigentDispatchArgv` helper in `build.ts` producing real `omnigent run <agentDir> --no-session -p <prompt>` argv. Added `containmentBackendOverride` and `attemptRunnerProviders` DI points to `InternalBuildDependencies`.  
**Files:** `attempt-runner.ts`, `build.ts`

### Defect 5: Missing ownershipReleased:false in catch
**Problem:** Production catch around runner execution recorded opaque failure without `ownershipReleased:false`. DispatchQueue could continue with later tickets despite unproven closure.  
**Fix:** The catch block in `executeBuildViaRunner` now sets `ownershipReleased: false` for opaque runner failures, preventing DispatchQueue from continuing without proven closure.  
**Files:** `build.ts`

### Defect 6: Acquisition in build, not in runner
**Problem:** Build (not AttemptRunner) owned `prepareAcquisition`/`acquire` before calling runner, violating the single critical-section owner requirement.  
**Fix:** Removed pre-runner `prepareAcquisition`/`acquire` from `executeBuildViaRunner`. `AttemptRunner.runAttempt` now handles internal acquisition (activate run/ticket + acquire) when no pre-acquired ownership is supplied. `AttemptRunnerRequest.ownership` is now optional; `acquisitionIdempotencyKey` and `ticketInstanceId` fields added for the production path.  
**Files:** `attempt-runner.ts`, `build.ts`

## Test Coverage

### New test file
- `orchestrator/test/reliability/attempt-runner-production-wiring.test.ts` (7 tests):
  - 4 structural grep assertions verifying defects #4, #5, #6 wiring in source
  - 3 functional assertions driving `runBuildViaRunnerForTesting` with `FixtureContainmentBackend`:
    - Defect #1+#2+#6: verifies run/ticket activation, held gate creation, and internal ownership acquisition
    - Defect #5: verifies catch block sets `ownershipReleased: false`
    - Defect #3: verifies durable timestamp from `heartbeatAt`

### Updated test file
- `orchestrator/test/reliability/attempt-critical-section.test.ts`: Updated bare-runner test expectation from `RICKGENT_ATTEMPT_DISPATCH_UNCONFIGURED` to generic `RICKGENT_ATTEMPT_` prefix (default dispatch is now real, not a fail-closed stub).

## Verification Results

| Validator | Result |
|-----------|--------|
| typecheck | Green (0 errors) |
| vitest (38 runner tests) | 38/38 passed |
| vitest (112 broader suites) | 112/112 passed |
| vitest (115 state suites) | 115/116 passed (1 pre-existing `process.chdir()` env failure) |
| pytest | 365 passed, 3 skipped, 2 deselected (pre-existing build_commit env failures) |
| citadel | 0 CRITICAL, 0 HIGH, 1 MEDIUM, 1 LOW (passes) |
| doctor | autonomous_dispatch enabled, proof=attempt-runner-critical-section-v1 (passes) |

## Red-then-green proof

The integration test (`attempt-runner-production-wiring.test.ts`) was written first and captured red output showing:
- Runner failed with `RICKGENT_ATTEMPT_DISPATCH_UNCONFIGURED` (defect #4)
- Run/ticket rows remained in `planned` state (defect #1)
- No `target_start_gates` row created (defect #2)
- Catch block missing `ownershipReleased: false` (defect #5)
- Acquisition called before runner execution (defect #6)

After implementing all 6 fixes, all 7 tests pass green.

## Files Changed

| File | Change |
|------|--------|
| `orchestrator/src/lifecycle/attempt-runner.ts` | Internal acquisition, durable observations, held gate creation, real `#defaultDispatch`, conditional worktree provisioning, `#failureTerminalize`/`#mintFailureCleanup` signature updates |
| `orchestrator/src/lifecycle/build.ts` | Removed pre-runner acquisition, `buildOmnigentDispatchArgv`, `ownershipReleased:false` in catch, DI points, `runBuildViaRunnerForTesting` bridge |
| `orchestrator/src/lifecycle/target-start-gate.ts` | `createHeldGate` method |
| `orchestrator/src/state/store.ts` | `createHeldTargetStartGate`, `activateRunForRunner`, `activateTicketForRunner` methods |
| `orchestrator/test/reliability/attempt-runner-production-wiring.test.ts` | NEW (7 tests) |
| `orchestrator/test/reliability/attempt-critical-section.test.ts` | Updated bare-runner test expectation |

## Known limitations

- The integration test uses `FixtureContainmentBackend` (not a real omnigent subprocess) to verify the production wiring. A full end-to-end test with real omnigent dispatch requires a running omnigent installation.
- The 1 `state-store.test.ts` failure is a pre-existing `process.chdir()` environmental issue (documented in t22D library).
- The 2 deselected pytest `build_commit` tests are pre-existing environmental issues from the dist rebuild process.
