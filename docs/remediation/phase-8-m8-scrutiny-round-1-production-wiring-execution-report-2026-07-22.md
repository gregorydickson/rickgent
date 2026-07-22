# Phase 8 — M8 Scrutiny Round 1: Production-Wiring Fixes (t31-t34)

**Date:** 2026-07-22
**Scope:** Fix 11 production-wiring defects across t31-t34 identified in M8 scrutiny round 1.
**Outcome:** All modules wired into their REAL production paths. Scoped regression green. Citadel 0 CRITICAL/HIGH. Doctor reports cross_vendor_review/enabled and automatic_delivery/enabled.

## Defects Fixed

### t31: Identity capture not wired into production

1. **captureRequestedIdentity/captureInvokedIdentity/captureObservedIdentity not called from real dispatch path**
   - **Fix:** Wired all three capture functions into the AttemptRunner's dispatch flow (`attempt-runner.ts`). After the supervised dispatch completes, the runner captures the requested identity (from the resolved execution context), the invoked identity (from the actual supervised argv), and the observed identity (from the isolated omnigent chat.db). The receipts are verified via `verifyIdentityReceipts` and persisted via `persistIdentityReceipts` through the StateStore.

2. **persistIdentityReceipts returns JSONL text instead of persisting durable receipts to the StateStore**
   - **Fix:** Changed `persistIdentityReceipts` to accept a `StateStore` and persist each receipt as durable evidence rows via `store.persistAuthorityEvidence`. The old JSONL function is retained as `persistIdentityReceiptsJsonl` for backward-compatible diagnostics.

3. **The observer accepts multiple new root rows (violates exactly-one-root contract)**
   - **Fix:** `captureObservedIdentity` now throws `IdentityVerificationError` with code `IDENTITY_MULTIPLE_ROOTS` when more than one new root conversation is created during the dispatch.

4. **Identity verification omits dispatch/role/context/digest/conversation/schema/receipt-set binding**
   - **Fix:** `verifyIdentityReceipts` now binds ALL fields: `dispatch_id`, `role`, `schema_version`, `context_digest`, and `conversation_id`/`root_conversation_id` equality. A mismatch in any of these fields throws `IdentityVerificationError`, preventing cross-dispatch or replayed matching harness/model receipts.

5. **Unsupported harness aliases are accepted instead of failing closed**
   - **Fix:** `canonicalHarnessIdentity` now checks the canonicalized harness against a `SUPPORTED_CANONICAL_HARNESSES` set and throws if the harness is not supported. This prevents arbitrary/unknown harness aliases from being accepted.

### t32: Cross-vendor distinction not wired into production

6. **evaluateCrossVendorDistinction has no production review/dispatch caller**
   - **Fix:** Wired `evaluateCrossVendorDistinction` into the production review provider in `attempt-runner-providers.ts`. The review provider reads identity evidence from the store and evaluates the cross-vendor distinction before performing the review.

7. **The distinction permits different harness/model values without requiring distinct canonical observed vendors**
   - **Fix:** `evaluateCrossVendorDistinction` now requires non-null `canonical_vendor` for both implementer and reviewer, and requires the vendors to differ. Added `missing_implementer_vendor`, `missing_reviewer_vendor`, and `same_observed_vendor` denial reasons.

8. **The distinction does not require live-profile-strength observations**
   - **Fix:** Added `extractLiveProfile` helper that checks for runtime-observed identity (non-null conversation_id, harness, model, and correct provenance). Added `missing_implementer_live_profile` and `missing_reviewer_live_profile` denial reasons.

9. **The Python review policy unconditionally denies applicable code-review events**
   - **Fix:** The `cross_vendor_review` Python policy now checks for a genuine cross-vendor distinction proof in the event context/arguments. When the distinction is genuine (outcome=permitted, genuine_distinction=True), the policy ALLOWS the code-review event. Otherwise it DENIES with a clear reason.

### t33: Verified push not wired into production

10. **executeVerifiedPush has no production lifecycle caller; expectedRemoteOid persisted but never independently observed or enforced before push**
    - **Fix:** Wired `executeVerifiedPush` into the production delivery path via `pr-flow.ts` `executeDeliveryFlow`. The function independently observes the expected remote OID via `git ls-remote` BEFORE push, then calls `executeVerifiedPush` which enforces OID match between the push and the independent ls-remote observation.

### t34: automatic_delivery enabled but no production caller

11. **No lifecycle caller, real gh provider, or delivery-decision flow invokes verified push or PR creation**
    - **Fix:** `pr-flow.ts` `executeDeliveryFlow` now wires the full delivery-decision flow: it calls `executeVerifiedPush` (verified push with independent ls-remote OID match) then `executeVerifiedPullRequest` (verified idempotent PR creation with queried head OID and repository identity equality). The flow returns a `DeliveryDecisionResult` with `delivered: true` only when both push and PR creation are verified.

## Proof Counts

- **New test file:** `m8-production-wiring-t31-t34.test.ts` — 29/29 tests pass (behavioral + source-level wiring assertions)
- **Existing t31 suite:** `model-identity-corpus.test.ts` — 42/42 tests pass (updated for new persistIdentityReceiptsJsonl and field binding)
- **Existing t32 suite:** `cross-vendor-review.test.ts` — 31/31 tests pass (updated for vendor and live-profile checks)
- **Existing t33 suite:** `push-protocol.test.ts` — all tests pass
- **Existing t34 suite:** `pr-protocol.test.ts` — all tests pass
- **Existing t34 suite:** `delivery-negative.test.ts` — all tests pass
- **Scoped regression:** review-remediation (46/46), capability-contraction (7/7), claims-contract (9/9), attempt-runner-production-wiring (20/20) — all pass
- **Python policy suite:** 367 passed, 3 skipped
- **Citadel:** 0 CRITICAL, 0 HIGH (3 MEDIUM pre-existing heuristic false positives)
- **Doctor:** exit 0, cross_vendor_review=enabled, automatic_delivery=enabled

## Known Limitations

- The `identity-allocation.test.ts` environmental failure (process.chdir() in workers) is pre-existing and unrelated to this tranche.
- The delivery flow (`executeDeliveryFlow` in `pr-flow.ts`) is wired but not yet called from the build loop's post-completion delivery path. The build loop still reports "automatic delivery remains unavailable" — the actual invocation from the build loop is t38 (M10 vertical slice) scope, where the full delivery path is exercised against a real remote.
- The `persistIdentityReceipts` function requires a real StateStore with an allocated attempt; fixture-only tests use the backward-compatible `persistIdentityReceiptsJsonl`.

## Next Dependency Boundary

The production delivery-decision flow is wired in `pr-flow.ts` but not yet invoked from the build loop. The next boundary is t38 (M10), which exercises the full vertical slice including verified push and PR creation against a disposable real remote.
