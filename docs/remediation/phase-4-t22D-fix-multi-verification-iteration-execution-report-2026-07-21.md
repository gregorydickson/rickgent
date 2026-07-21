# Phase 4 — t22D Fix: Multi-Verification Iteration (M4 Scrutiny Round 5)

**Date:** 2026-07-21
**Ticket:** t22D (M4 scrutiny round 5, blocking defect)
**Commit:** 09d7079
**Scope:** `orchestrator/src/lifecycle/attempt-runner-providers.ts`, `orchestrator/src/lifecycle/attempt-runner.ts`

## Defect

The verification provider in `attempt-runner-providers.ts` selected only
`contract.verifications[0]` instead of iterating ALL sealed contract
verification IDs. The `StateStore`'s oracle requires passed gate records for
the complete sorted set of sealed verification IDs (see
`oracle.ts` → `requiredVerificationIds` loop:
`required_gate_missing_or_duplicate:<gateId>`). A valid contract with multiple
verification IDs could never terminalize successfully because the missing gate
records produced rejection reasons.

## Fix

1. **`attempt-runner-providers.ts` — verification provider:** Replaced the
   `contract.verifications[0]` single-selection with a `for` loop over
   `contract.verifications`. For each verification, the provider runs the
   real argv, observes the real exit code, persists gate evidence + gate
   result through the authority APIs (`persistAuthorityEvidence`,
   `lifecycleRecords.recordGateResult`). The overall status is "pass" only if
   ALL verifications pass; "fail" if ANY fail (non-infra);
   "infrastructure_error" if ANY is an infrastructure error. The candidate
   tree OID + diff digest are observed once (shared across all verifications
   since they all evaluate the same candidate).

2. **`attempt-runner.ts` — `VerificationResult` interface:** Added
   `gateResultIds: readonly string[]` — the complete list of gate result IDs,
   one per sealed contract verification ID. `gateResultId` remains as the
   first (backward-compatible representative).

3. **`attempt-runner.ts` — commit attribution finalization:** Updated
   `verificationReceiptDigestsJson` to include the digests of ALL gate result
   IDs (queried via `store.queryGateResultDigest`), not just the first. This
   ensures the commit intent records the full verification receipt set.

## Tests

New test file: `orchestrator/test/reliability/attempt-runner-multi-verification.test.ts`

- **Structural:** Provider does NOT use `contract.verifications[0]`; iterates
  all verifications.
- **(a) Multi-verification success (3 verifications, all pass):** Asserts a
  gate result is created for EVERY sealed contract verification ID, all with
  status "passed", and the `VerificationResult` carries all gate result IDs
  via `gateResultIds`.
- **(b) Failed required verification (2 verifications, one fails):** Asserts
  status "fail" (fail-closed) — the runner branches to the ordinary-failure
  state machine, not terminalize. The failing gate has status "failed"; the
  passing gate has status "passed". Also covers `infrastructure_error` when a
  verification executable cannot be found.
- **(c) Docker integration (full production path):** Drives
  `runBuildViaRunnerForTesting` with a multi-verification PRD
  (`fixtures/prd-multi-verification.md`, 2 verifications), real Docker
  containment, real providers, and asserts `outcome.status === "succeeded"`.

New fixture: `fixtures/prd-multi-verification.md` — minimal PRD with 2
declared verifications per acceptance criterion.

### Red-then-green proof

**Red (before fix):**
```
pnpm vitest run test/reliability/attempt-runner-multi-verification.test.ts
→ 7 failed (7)
```
- Structural: source contained `contract.verifications[0]` (no iteration).
- (a): `gateResults.length` was 1, expected 3 — only one gate result created.
- (a): `gateResultIds` was undefined — the field did not exist.
- (b): status was "pass" (not "fail") — only verifications[0] was run.
- (c): Docker build `outcome.status` was "failed" — oracle rejected with
  missing gate results.

**Green (after fix):**
```
pnpm vitest run test/reliability/attempt-runner-multi-verification.test.ts
→ 7 passed (7)
```

## Proof Counts

- 7/7 focused gate (new multi-verification suite)
- 341/341 scoped M4 regression (20 files)
- 367 passed, 3 skipped (Python policy suite)
- citadel: 0 CRITICAL, 0 HIGH (4 MEDIUM pre-existing, 1 LOW pre-existing)
- doctor: exit 0 (capability matrix unchanged)

## Known Limitations

None. The fix is complete and all scoped suites pass.

## Next Dependency Boundary

M4 is complete. The next milestone is M5 (t23 concurrency proof), which
depends on t22A–t22D being fully done with all scrutiny defects resolved.
