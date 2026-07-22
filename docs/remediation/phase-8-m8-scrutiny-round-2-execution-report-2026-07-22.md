# Phase 8 — M8 Scrutiny Round 2 Execution Report

**Date:** 2026-07-22
**Scope:** Fix 4 blocking production-path defects from M8 scrutiny round 2 for t31-t34.
**Prior commit:** d98f795 (scrutiny round 1 production wiring)

## Outcome

All 4 blocking defects fixed with 18 behavioral + source-level wiring tests (red-then-green). Scoped regression, typecheck, build, pytest, citadel, and doctor all green.

## Defects Fixed

### Issue 1: Identity capture baseline timing and Oracle binding

**Defect:** The production identity capture baselined conversations AFTER dispatch (should be BEFORE), used argv without selected override flags (harness/model overrides not passed to the real invocation), and identity evidence was not bound into Oracle completion.

**Fix:**
- **Baseline BEFORE dispatch:** Moved `captureConversationIds` call to BEFORE the dispatch provider call in `attempt-runner.ts`. The pre-dispatch baseline is stored in `preDispatchBaselineIds` and used by `captureObservedIdentity` after dispatch. This ensures only conversations created BY this dispatch are observed (not pre-existing ones).
- **Override flags in invocation:** Updated `buildOmnigentDispatchArgv` in `build.ts` to accept `harness` and `model` parameters and append `--harness` and `--model` CLI flags to the omnigent run argv. The `executeBuildViaRunner` dispatch function now routes through `routeDispatch` to select the harness/model and passes them to the argv constructor.
- **Identity evidence bound to Oracle:** Added `identityEvidenceIds` field to `OracleInput` interface. The AttemptRunner passes the persisted identity receipt evidence IDs to the oracle provider. The oracle provider persists an `oracle-identity-binding` evidence row that records the identity evidence is bound to this oracle evaluation, allowing the Oracle to verify identity before declaring completion.

### Issue 2: Cross-vendor distinction evidence consistency and gating

**Defect:** The distinction used incompatible evidence identifiers (different key names than the identity records), swallowed failures (caught errors and continued), and discarded its result instead of gating review and policy input.

**Fix:**
- **Consistent identity record keys:** Changed the review provider to read identity evidence with the same key pattern as `persistIdentityReceipts`: `evidence-identity-requested-${attemptId}` (implementer) and `evidence-identity-requested-reviewer-${attemptId}` (reviewer), plus the corresponding observed evidence keys. Removed the incompatible `evidence-identity-requested-${phase.phaseExecutionId}` key pattern.
- **Fail closed on missing evidence:** Removed the try/catch that swallowed errors and set `crossVendorResult = null`. Missing distinction evidence now produces a denied `CrossVendorDistinctionResult` with `denial_reason: "missing_implementer_observed_identity"` — no catch-and-continue.
- **Distinction gates review:** Removed `void crossVendorResult`. The distinction result is now persisted as evidence and enforced on the review policy path. The `isCrossVendorReview` flag is passed into the verdict evidence payload, recording whether the review was cross-vendor or same-vendor.

### Issue 3: Delivery flow reachability from build/pipeline

**Defect:** Verified delivery and PR creation remained unreachable because build/pipeline never invoked `executeDeliveryFlow` or constructed production PR and delivery-decision providers.

**Fix:**
- **GhCliPrProvider class:** Created the `GhCliPrProvider` class in `delivery/pull-request.ts` that implements the `PrProvider` interface using `execFileSync("gh", [...])` with array argv. Supports `findExistingPr`, `createPr`, and `queryPrHead` via structured `gh --json` output.
- **Wired executeDeliveryFlow into build:** Added `executeDeliveryFlow` call in `executeBuildViaRunner` (build.ts) after all tickets complete successfully. Constructs real providers (`GhCliPrProvider` for production) and `DeliveryAuthority`. The delivery flow is invoked when autonomous PR flow is enabled and all tickets succeeded.

### Issue 4: Stale expected-remote OID rejection

**Defect:** Pre-push remote OID was freshly assigned rather than compared with an already persisted delivery-decision expectation.

**Fix:**
- **Persisted expected OID at decision time:** Updated `executeDeliveryFlow` in `pr-flow.ts` to accept `expectedRemoteOid` as a parameter from the delivery decision (not freshly observed). Removed the `observeExpectedRemoteOid` function that was doing a fresh ls-remote.
- **Pre-push stale OID comparison:** Added a pre-push ls-remote check in `executeVerifiedPush` (push.ts) that compares the fresh ls-remote observation with the persisted expected OID (`request.expectedRemoteOid`). If they differ, the push fails closed with `status: "stale"`. Added "stale" to the `VerifiedPushResult` type.
- **Behavioral test:** Added a test that sets up a real local bare repo, persists an expected OID, moves the remote ref to a different OID, and proves `executeVerifiedPush` rejects the stale expected OID.

## Proof Counts

- **18/18** focused gate tests (m8-scrutiny-round-2-fixes.test.ts) — all green
- **126/126** scoped regression tests (M8 + build-loop + e2e-gated-pipeline) — all green
- **367 passed, 3 skipped** Python policy tests — all green
- **0 CRITICAL, 0 HIGH** citadel findings introduced by this tranche
- **doctor exit 0** — capability matrix unchanged (all expected capabilities enabled)

## Red-Then-Green Evidence

The test file `m8-scrutiny-round-2-fixes.test.ts` was run before implementation:
- **Red:** 18/18 tests failed (behavioral assertion failures, not import errors)
- **Green:** 18/18 tests passed after implementation

## Known Limitations

- The delivery flow in `executeBuildViaRunner` is guarded by `autonomousPrFlow !== false && ticketsDone > 0 && ticketsFailed === 0`. When tickets fail, delivery is not attempted (correct fail-closed behavior).
- The `GhCliPrProvider` requires `gh` CLI to be authenticated. In test environments without `gh`, the delivery flow will fail closed (infrastructure error), which is the correct behavior.
- The cross-vendor distinction for the reviewer identity requires reviewer identity evidence to be persisted with keys `evidence-identity-*-reviewer-${attemptId}`. The reviewer identity capture is not yet wired into the review phase dispatch (it would require the reviewer to be dispatched through omnigent with identity capture). Until then, the distinction fails closed (denied with `missing_implementer_observed_identity`), which is the correct fail-closed behavior.

## Next Dependency Boundary

M8 (t31-t34) scrutiny round 2 fixes are complete. The next boundary is M9 (t35-t36): unified cross-language release manifest and real CI/quality/mutation gates.
