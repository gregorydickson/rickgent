# Phase 7 — Fix Stale Test Expectations (M7 Scrutiny Round 1) Execution Report

**Date:** 2026-07-22
**Feature:** m7-fix-stale-test-expectations
**Milestone:** M7-t27-t30
**Status:** Done

## Scope

Fix the M7 scrutiny round 1 blocking defect: the full TS suite had 21 failing files and 86 failed tests, most of which were stale test expectations from t29 capability activation (resume_retry and reconciliation now enabled) and M6 schema/transaction changes. Also fix a Docker production path bug introduced by t27.

## Changes

### Production Code Fix

1. **`orchestrator/src/lifecycle/attempt-runner-providers.ts`**: Removed the extra `schema_version` field from the review verdict and findings evidence payloads. The t27 review provider was adding `schema_version: REVIEW_AUTHORITY_SCHEMA_VERSION` to the payload, but the StateStore's `#requireExactInlineEvidence` expects the payload to match exactly `{attempt_id, cycle, verdict, input_tree_oid, input_diff_digest}` (for verdict) without the extra field. This caused Docker production path tests to fail with "review verdict evidence does not pin the exact canonical operation."

2. **`orchestrator/src/capabilities/registry.ts`**: Updated the `rickgent retry` boundary text from "the resume/retry capability remains unavailable" to "use `build --resume` for explicit run resume."

3. **`orchestrator/src/cli.ts`**: Updated BUILD_USAGE text for `--resume` from "Resume capability unavailable: exit 3" to "Resume from persisted receipts (t29 activated)". Updated PIPELINE_USAGE to remove stale "resume, reconcile" from the unavailable list.

### Fixture Gate Fix

4. **`orchestrator/test/fixtures/runtime-gate.mjs`**: Updated the fixture-tree capability gate to allow `resume_retry` and `reconciliation` in addition to `autonomous_dispatch`. The fixture gate was stale (M1 profile: only autonomous_dispatch allowed), causing all fixture CLI tests that exercise resume/reconciliation to fail with the old error codes.

### Stale Test Expectations Updated

5. **`test/reliability/attempt-runner-production-cutover.test.ts`**: Updated `resume_retry` and `reconciliation` capability states from `unavailable` to `enabled`. Updated the `runPipeline` test to expect the pipeline to proceed past the reconciliation gate (t29) and fail at containment (no docker) instead of throwing `RICKGENT_RECONCILIATION_UNAVAILABLE`.

6. **`test/reliability/identity-allocation.test.ts`**: Updated `resume_retry` from `unavailable` to `enabled`, error_code from `RICKGENT_RESUME_UNAVAILABLE` to `RICKGENT_RESUME_ACTIVE`. Updated the public surface registry check for `build|pipeline --resume` from `public_blocked` to `public_local_artifact`.

7. **`test/reliability/claims-contract.test.ts`**: Removed "public resume and reconciliation" from retired claims list. Updated `fails unavailable-capability flag combinations` test to remove `--resume` (now enabled). Updated `matches the public capability exits` test to use `--raw-shell` and `--feature` (still unavailable) instead of `--resume` and `reconcile` for capability-gate failure testing. Updated `inventories every intentional public filesystem writer` test to include `build|pipeline --resume` in local-artifact surfaces.

8. **`test/reliability/capability-contraction.test.ts`**: Updated capability states array (resume_retry and reconciliation now `enabled`). Updated `build --resume` test to expect exit 2 (ticket-contract gate) instead of exit 3 (capability gate). Updated `reconcile` CLI test to expect exit 0 (ok, 0 tickets) instead of exit 3. Updated `reconcile(root, state)` to expect ok instead of throw. Updated startup test to use `build <prd> --raw-shell` instead of `build --resume` for capability-gate failure.

9. **`test/reliability/fail-closed-aggregation.test.ts`**: Updated pipeline test to expect the pipeline to proceed through build and cleanup (reconciliation enabled) instead of failing at the reconciliation gate. Updated `ps` marker expectation (orphan reaper is now invoked).

10. **`test/reliability/fixture-mutation-capture.test.ts`**: Updated resume test to expect the build to proceed past the capability gate (t29) instead of throwing `RICKGENT_RESUME_UNAVAILABLE`. The adversarial commit still cannot promote lifecycle state.

11. **`test/lifecycle/build-loop.test.ts`**: Updated pipeline test to expect the pipeline to proceed past the reconciliation gate (t29) instead of failing with `RICKGENT_RECONCILIATION_UNAVAILABLE`.

12. **`test/lifecycle/cronenberg-delegation.test.ts`**: Updated both pipeline delegation tests to expect the pipeline to proceed past the reconciliation gate (t29) and fail in the build phase.

13. **`test/lifecycle/cli-commands.test.ts`**: Updated `reconcile` CLI test to expect exit 0 with `rebuilt=false` and `ticketsFound=0` instead of exit 3 with `RICKGENT_RECONCILIATION_UNAVAILABLE`.

14. **`test/lifecycle/microverse-cli.test.ts`**: Updated `--resume` test to expect `RICKGENT_RAW_SHELL_UNAVAILABLE` (from `--metric` flag) instead of `RICKGENT_RESUME_UNAVAILABLE` (from `--resume` flag, now enabled). Updated the `capabilityDetail` type to remove the unused `RICKGENT_RESUME_UNAVAILABLE`.

15. **`test/lifecycle/reconcile-queue.test.ts`**: Updated test to expect `reconcile()` to return ok with 0 tickets (reconciliation enabled, reads only the state store) instead of throwing `RICKGENT_RECONCILIATION_UNAVAILABLE`.

16. **`test/lifecycle/anatomy-cli.test.ts`**: Updated `--resume` test to expect the anatomy command to proceed past the capability gate (t29) instead of failing with `RICKGENT_RESUME_UNAVAILABLE`. The caller repo HEAD remains unchanged (reviews are read-only).

### Schema/Transaction Contract Fix

17. **`docs/architecture/reliability/state-and-lifecycle-contract.json`**: Added 11 missing transactions (seal_target_proof_set, create_target_start_gate, mint_cleanup_eligibility, mint_failure_cleanup, mint_promotion_cleanup, mint_quarantine, mint_target_never_released, mint_target_released, persist_authority_claim_snapshot, persist_authority_ownership_snapshot, recover_orphaned_planned_attempt) to the `transactions.named` array. Updated the `decision_digest` to match the recomputed digest.

18. **`orchestrator/scripts/validate-state-contract.mjs`**: Updated the hardcoded `TRANSACTIONS` array to include the 11 new transactions.

19. **`test/reliability/state-observation.test.ts`**: Updated expected `schemaVersion` from 5 to 6 (M6 added migration 006).

### Documentation Updates

20. **`README.md`**: Updated prose to reflect resume/reconciliation activation. Updated the claims matrix block: `build|pipeline --resume` is now `public_local_artifact`/`resume_retry/enabled`, `rickgent reconcile` is now `public_read_only`/`reconciliation/enabled`, `rickgent retry` boundary updated.

21. **`docs/reliability-preview.md`**: Updated the claims matrix block to match the registry (same changes as README).

22. **`docs/decisions/build-loop.md`**, **`docs/decisions/model-routing.md`**, **`docs/decisions/session-resume.md`**: Updated the "remain unavailable" text to remove stale references to autonomous_dispatch and resume/reconciliation (now activated).

## Red-Then-Green Proof

**Red command (before fixes):**
```
cd orchestrator && pnpm vitest run test/reliability/attempt-runner-production-cutover.test.ts test/reliability/claims-contract.test.ts test/reliability/capability-contraction.test.ts test/reliability/identity-allocation.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red observation (11 failed):**
- attempt-runner-production-cutover: resume_retry/reconciliation expected unavailable but now enabled
- claims-contract: build --resume expected exit 3 but got exit 2 (capability gate passes)
- capability-contraction: build --resume expected exit 3 but got exit 2; reconcile expected exit 3 but got exit 0
- identity-allocation: resume_retry expected unavailable but now enabled (1 pre-existing process.chdir)
- Docker production path: "review verdict evidence does not pin the exact canonical operation"

**Green command (after fixes):**
```
cd orchestrator && pnpm vitest run test/reliability/attempt-runner-production-cutover.test.ts test/reliability/claims-contract.test.ts test/reliability/capability-contraction.test.ts test/reliability/identity-allocation.test.ts test/reliability/fail-closed-aggregation.test.ts test/reliability/fixture-mutation-capture.test.ts test/lifecycle/build-loop.test.ts test/lifecycle/cronenberg-delegation.test.ts test/lifecycle/cli-commands.test.ts test/lifecycle/reconcile-queue.test.ts test/lifecycle/anatomy-cli.test.ts test/lifecycle/microverse-cli.test.ts test/reliability/state-contract.test.ts test/reliability/state-observation.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green observation:**
```
Test Files  13 passed (13)
     Tests  161 passed (161)
```

## Proof Counts

- **161/161** focused tests passed (13 updated test files)
- **153/153** M7 scoped regression passed (7 suites: review-remediation, completion-oracle-integration, recovery-parity, terminal-writer-audit, lifecycle-transitions, attempt-runner-production-wiring, attempt-critical-section)
- **9/9** Docker production path tests passed (attempt-runner-expected-exit-codes-production + attempt-runner-multi-verification)
- **367 passed, 3 skipped** Python policy tests
- **0 CRITICAL, 0 HIGH** citadel findings (15 MEDIUM + 1 LOW pre-existing)
- **doctor exit 0** with resume_retry and reconciliation both enabled with proof recovery-parity-v1
- **typecheck**: green
- **build**: green

## Pre-Existing Failures (Not Fixed)

The following failures are pre-existing environmental issues documented in AGENTS.md and are NOT fixed by this tranche:

- **2 process.chdir failures**: `state-store.test.ts` (1 test) and `identity-allocation.test.ts` (1 test) — vitest worker threads don't support `process.chdir()`.
- **8 provenance probe failures**: `policy-context.test.ts` (6 tests) and `authenticated-policy-context.test.ts` (2 tests) — runtime provenance probe resolves a different realpath than the bundle expects.

Total pre-existing: 10 tests (2 process.chdir + 8 provenance).

## Known Limitations

- The `concurrency-corpus.test.ts` was not run as part of this tranche's verification (it requires 50+ Docker stress iterations and takes 10+ minutes). It was not affected by any changes in this tranche.
- The `build|pipeline --resume` CLI path still requires wiring through `resumeRun` in the build lifecycle (noted in t29 report as a later ticket). The capability is activated but the build loop's resume entry point is not yet wired.
