# Phase 8 — t32: Routing and Cross-Vendor Reviewer Distinction — Execution Report

**Date:** 2026-07-22
**Ticket:** t32 — Prove routing and cross-vendor reviewer distinction
**Status:** Done
**Milestone:** M8-t31-t34

## Scope

Exercise every identity mismatch and permit cross-vendor review only when the canonical observed identities of the implementer and reviewer are genuinely distinct. Same-identity requests are rejected. Activate the `cross_vendor_review` capability after proofs pass. Write the phase execution report and update the manifest.

## What Was Implemented

### 1. `orchestrator/src/dispatch/cross-vendor-distinction.ts` (new)

The cross-vendor distinction authority evaluates whether cross-vendor review is permitted based on the observed identity receipts of the implementer and reviewer. The authority enforces:

- **Genuine identity distinction**: both canonical observed harness AND canonical observed model must differ between implementer and reviewer. Different harness alone or different model alone is not cross-vendor (per the t00 contract: `different-harness-string-alone-is_cross_vendor: false`).
- **Separate process/session**: conversation IDs must differ (separate root conversations in the isolated chat.db).
- **Role independence**: implementer and reviewer roles must differ (authority-collapse rejection).
- **Observed provenance**: both observed provenances must be the isolated omnigent chat.db root conversation seam. Spoofed provenance is rejected.
- **No label-only satisfaction**: both observed receipts must have producer "observed". Requested or invoked receipts alone cannot satisfy the gate.
- **Fail-closed on missing**: missing harness, model, or conversation ID in either receipt is rejected.

The authority returns a frozen `CrossVendorDistinctionResult` with outcome `permitted` or `denied`, the denial reason, and the observed identity fields for audit.

`verifyCrossVendorDistinction` throws `CrossVendorDistinctionError` on denial.

### 2. `orchestrator/test/reliability/cross-vendor-review.test.ts` (new)

31 test cases exercising the full cross-vendor distinction matrix:

**Permitted (3 tests):**
- codex/gpt-5 vs claude-sdk/claude-sonnet-4-5 (different harness AND model)
- droid/glm-5.2 vs codex/gpt-5 (different harness AND model)
- verifyCrossVendorDistinction returns the result on success

**Same-identity rejection (3 tests):**
- Same observed identity (same harness AND model) → denied: same_observed_identity
- Same identity with different conversation IDs → denied: same_observed_identity
- verifyCrossVendorDistinction throws on same identity

**Partial distinction rejection (2 tests):**
- Same harness, different model → denied: same_observed_harness
- Different harness, same model → denied: same_observed_model

**Missing observed identity rejection (8 tests):**
- Missing implementer observed identity (null harness+model) → denied: missing_implementer_harness
- Missing reviewer observed identity (null harness+model) → denied: missing_reviewer_harness
- Missing implementer harness only → denied: missing_implementer_harness
- Missing reviewer harness only → denied: missing_reviewer_harness
- Missing implementer model only → denied: missing_implementer_model
- Missing reviewer model only → denied: missing_reviewer_model
- Missing implementer conversation ID → denied: missing_implementer_conversation_id
- Missing reviewer conversation ID → denied: missing_reviewer_conversation_id

**Process/session independence rejection (1 test):**
- Same conversation ID → denied: same_conversation_id

**Role independence rejection (1 test):**
- Same role → denied: same_role

**Spoofed provenance rejection (2 tests):**
- Spoofed implementer provenance → denied: spoofed_implementer_provenance
- Spoofed reviewer provenance → denied: spoofed_reviewer_provenance

**Label-only rejection (2 tests):**
- Implementer with wrong producer (label-only) → denied: missing_implementer_observed_identity
- Reviewer with wrong producer (label-only) → denied: missing_reviewer_observed_identity

**Alias canonicalization (1 test):**
- claude alias and claude-sdk canonical treated as same harness → denied: same_observed_harness

**Result immutability and schema (2 tests):**
- Permitted result is frozen with correct schema version
- Denied result is frozen

**Same-vendor independent review not invalidated (2 tests):**
- Same-vendor with different harness+model is permitted as cross-vendor
- Same identity same-vendor is denied but does not invalidate independent review mode

**Every field falsified independently (4 tests):**
- Falsifying only implementer harness blocks the gate
- Falsifying only reviewer model blocks the gate
- Falsifying only implementer conversation_id blocks the gate
- Falsifying only reviewer provenance blocks the gate

### 3. `orchestrator/src/capabilities/registry.ts` (modified)

Activated the `cross_vendor_review` capability:
- State changed from `unavailable` to `enabled`
- Error code changed from `RICKGENT_CROSS_VENDOR_UNAVAILABLE` to `RICKGENT_CROSS_VENDOR_ACTIVE`
- Reason updated to describe the t32 distinction rule
- Minimum profile updated to `m8_cross_vendor_distinction`
- Proof version remains `model-identity-corpus-v1`

Updated the public surface entry for cross-vendor review from `public_blocked` to `public_read_only` with the activated boundary description.

Updated build/pipeline boundary text to reflect cross-vendor review activation.

### 4. `orchestrator/test/reliability/capability-contraction.test.ts` (modified)

Updated the expected capability state array: `cross_vendor_review` changed from `unavailable` to `enabled`. Updated the routing test: `routeDispatch` with `code_review` role now passes the capability gate and successfully routes to a different vendor model.

### 5. `orchestrator/test/reliability/attempt-runner-production-cutover.test.ts` (modified)

Updated the expected `cross_vendor_review` state from `unavailable` to `enabled`.

### 6. `orchestrator/test/reliability/claims-contract.test.ts` (modified)

Updated the help output test: `cross_vendor_review` is no longer in the unavailable list, so its error code is not expected in the simple command help banner. Replaced with `automatic_delivery` (still unavailable). The surface matrix is verified via the README/reliability-preview.md byte-alignment check.

### 7. `README.md` and `docs/reliability-preview.md` (modified)

Claims matrix blocks regenerated from the updated registry to maintain byte-alignment.

### 8. `rickgent-policies/rickgent_policies/review.py` (modified)

Updated the `cross_vendor_review` policy denial reason to reference the t32 distinction authority. The Python policy remains fail-closed for label-only claims; the distinction check is performed by the TS authority using observed identity receipts.

### 9. `artifacts/reliability/model-identity-summary.json` (new)

Summary artifact recording the complete proof corpus: 2 permitted cases, 15 denied cases, 0 uncovered cases, 0 label-only acceptances. Records the capability activation metadata and preserved invariants.

## Red-Then-Green Proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/cross-vendor-review.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red output (26 failures with broken always-permit implementation):**
- `rejects same observed identity (same harness AND same model)`: `expected 'permitted' to be 'denied'`
- `rejects same observed identity even with different conversation IDs`: `expected 'permitted' to be 'denied'`
- `verifyCrossVendorDistinction throws on same identity`: `expected function to throw an error, but it didn't`
- `rejects same harness, different model`: `expected 'permitted' to be 'denied'`
- `rejects different harness, same model`: `expected 'permitted' to be 'denied'`
- `rejects missing implementer observed identity`: `expected 'permitted' to be 'denied'`
- `rejects missing reviewer observed identity`: `expected 'permitted' to be 'denied'`
- `rejects missing implementer harness only`: `expected 'permitted' to be 'denied'`
- `rejects missing reviewer harness only`: `expected 'permitted' to be 'denied'`
- `rejects missing implementer model only`: `expected 'permitted' to be 'denied'`
- `rejects missing reviewer model only`: `expected 'permitted' to be 'denied'`
- `rejects missing implementer conversation ID`: `expected 'permitted' to be 'denied'`
- `rejects missing reviewer conversation ID`: `expected 'permitted' to be 'denied'`
- `rejects same conversation ID`: `expected 'permitted' to be 'denied'`
- `rejects same role (authority collapse)`: `expected 'permitted' to be 'denied'`
- `rejects spoofed implementer provenance`: `expected 'permitted' to be 'denied'`
- `rejects spoofed reviewer provenance`: `expected 'permitted' to be 'denied'`
- `rejects when implementer has no observed receipt`: `expected 'permitted' to be 'denied'`
- `rejects when reviewer has no observed receipt`: `expected 'permitted' to be 'denied'`
- `treats claude alias and claude-sdk canonical as the same harness`: `expected 'permitted' to be 'denied'`
- `produces a frozen denial result`: `expected 'permitted' to be 'denied'`
- `same identity same-vendor is denied`: `expected 'permitted' to be 'denied'`
- `falsifying only implementer harness`: `expected 'permitted' to be 'denied'`
- `falsifying only reviewer model`: `expected 'permitted' to be 'denied'`
- `falsifying only implementer conversation_id`: `expected 'permitted' to be 'denied'`
- `falsifying only reviewer provenance`: `expected 'permitted' to be 'denied'`

**Green command:** same command after implementation.

**Green output:** `Tests 31 passed (31)` — all tests pass.

## Verification Results

| Check | Command | Exit Code | Result |
|-------|---------|-----------|--------|
| TypeScript typecheck | `pnpm typecheck` | 0 | Clean |
| Build | `pnpm build` | 0 | dist/cli.js refreshed |
| Cross-vendor review test | `pnpm vitest run test/reliability/cross-vendor-review.test.ts` | 0 | 31/31 passed |
| Model identity corpus test | `pnpm vitest run test/reliability/model-identity-corpus.test.ts` | 0 | 11/11 passed |
| Capability contraction test | `pnpm vitest run test/reliability/capability-contraction.test.ts` | 0 | 7/7 passed |
| Claims contract test | `pnpm vitest run test/reliability/claims-contract.test.ts` | 0 | 9/9 passed |
| Attempt runner cutover test | `pnpm vitest run test/reliability/attempt-runner-production-cutover.test.ts` | 0 | All passed |
| Python pytest | `python3 -m pytest test/ -p no:cacheprovider -q` | 0 | 367 passed, 3 skipped |
| Citadel | `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 | 0 CRITICAL, 0 HIGH introduced by t32 (2 pre-existing HIGH from t31 arrow-syntax false positives) |
| Doctor | `node orchestrator/dist/cli.js doctor` | 0 | cross_vendor_review: state=enabled, proof=model-identity-corpus-v1 |
| Manifest verification | `node -e "...model-identity-summary.json..."` | 0 | No uncovered cases, no label-only acceptances |

## Proof Counts

- 31/31 cross-vendor distinction tests
- 11/11 model identity corpus tests (from t31, still passing)
- 7/7 capability contraction tests
- 9/9 claims contract tests
- 367/370 Python policy tests (3 intentional skips)
- 0 CRITICAL/HIGH citadel findings introduced by t32

## Known Limitations

- The `effective-session-v1` identity observation profile is offline-structurally-probed per the t00 contract. It does not permit strict identity completion or cross-vendor claims based on vendor observation alone (provider_vendor is unavailable generically). The t32 distinction rule uses the strongest available signal: canonical observed harness AND model both differ. This is stronger than the t00 contract's "different-harness-string-alone-is_cross_vendor: false" rule because it requires BOTH fields to differ.
- The `runtime-reported-identity-v1` profile (which would provide vendor observation and live-profile strength) remains unavailable-until-live-proof. Full cross-vendor claims with vendor distinction are deferred to the t38 protected real-model slice.
- The Python `cross_vendor_review` policy shim remains fail-closed for label-only claims; the distinction check is performed by the TS authority using observed identity receipts from the chat.db seam.

## Next Dependency Boundary

t33 (verified push) depends on t32's cross-vendor distinction. t33 will implement verified push with independent ls-remote OID matching across success, rejection, timeout, response-loss, and ref-race cases.
