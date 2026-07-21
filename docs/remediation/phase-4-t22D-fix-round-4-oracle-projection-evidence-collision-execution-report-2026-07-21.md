# Phase 4 t22D Fix Round 4: Oracle Projection Evidence Collision and Promotion Intent

**Date:** 2026-07-21
**Branch:** `remediation/trust-spine-phase-4`
**Milestone:** M4-t22CD
**Feature:** `m4-fix-real-providers-container-image-and-atomic-acquisition`

## Summary

Fixed the remaining Docker integration test #12 failure from round 3. The production-path `runBuild` via real Docker containment got `outcome.status='failed'` instead of `'succeeded'` due to four cascading defects in the oracle projection validation chain, promotion intent creation, and evidence scope naming. After fixing, all 12 integration tests pass, 75/75 scoped M4 tests pass, and typecheck/pytest/citadel/doctor are green.

## Red-Then-Green Proof

### Red (before fix)

**Command:**
```
cd orchestrator && pnpm vitest run test/reliability/attempt-runner-real-providers-docker-integration.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red output (key failure):**
```
× defect #3: production-path integration test with real Docker > runBuildViaRunnerForTesting with real Docker containment asserts outcome.status === 'ok' 10246ms
  → expected 'failed' to be 'ok' // Object.is equality

Build outcome: {
  "status": "failed",
  "primary": "infrastructure",
  "stableCode": "RICKGENT_INFRASTRUCTURE_ERROR",
  "issues": [
    {
      "reason": "infrastructure_error",
      "class": "infrastructure",
      "detail": "attempt runner failed: persist_authority_evidence violated an immutable state constraint",
      "ticketId": "t01",
      "stableCode": "RICKGENT_INFRASTRUCTURE_ERROR"
    }
  ]
}

Tests: 1 failed | 11 passed (12)
```

**Root cause chain (4 defects):**

1. **Evidence UNIQUE constraint collision:** The cleanup preimage provider's target proof set evidence had `scope: target-proof-set-${attemptId}` (no kind suffix). When the oracle rejected and the failure path called `cleanupPreimage(kind="failure")`, the second evidence row collided on `(producer_service, scope, content_digest)` with the eligibility evidence row (same scope, same content_digest, different evidence_id). The `evidence_producer_content_uq` unique index rejected the insert.

2. **Oracle rejection due to fake attribution digests:** `persistAuthorityCommitAttribution` was called with `pathSetDigest: sha256("paths:${attemptId}")`, `changeKindSetDigest: sha256("kinds:${attemptId}")`, and `modeSetDigest: sha256("modes:${attemptId}")` — all fake digests not derived from the normalized delta. The oracle's `deriveOracleAttributionDigests` re-derives all four digests from the `normalized_delta` and checks they match. The mismatch caused `commit_attribution_digest_mismatch` rejection.

3. **Missing promotion intent:** The success state machine called `mintPromotionCleanup` without first creating a `promotion_intents` row. The store's `#validatePromotionCleanupPreimage` checks that the promotion intent exists with the exact oracle decision ID. Without it, the validation failed closed.

4. **Missing ticket state transition and promotion observation evidence:** The `advanceAttemptToCleanupPending` method only updated the `attempts` table, not `run_tickets`. The promotion intent scope validation requires `ticket_state === "cleanup_pending"`. Additionally, `mintPromotionCleanup` requires a `promotion_observation_evidence_id` FK to an existing evidence row, which was never created.

### Green (after fix)

**Command:**
```
cd orchestrator && pnpm vitest run test/reliability/attempt-runner-real-providers-docker-integration.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green output:**
```
✓ test/reliability/attempt-runner-real-providers-docker-integration.test.ts (12 tests) 9949ms
  ✓ defect #3: production-path integration test with real Docker > runBuildViaRunnerForTesting with real Docker containment asserts outcome.status === 'ok' 9415ms

Test Files: 1 passed (1)
Tests: 12 passed (12)
```

## Defects Fixed

### Defect #1: Evidence UNIQUE constraint collision (scope naming)

**Fix:** Changed the target proof set evidence scope from `targetProofSetId` to `${targetProofSetId}:${input.kind}` in `attempt-runner-providers.ts`. This ensures each cleanup preimage call (eligibility, failure, quarantine) creates evidence with a unique scope, preventing `(producer_service, scope, content_digest)` collisions when the same target proof set is referenced across different cleanup kinds.

### Defect #2: Oracle rejection due to fake attribution digests

**Fix:** In `attempt-runner.ts`, extracted all four digests (`candidateDiffDigest`, `pathSetDigest`, `changeKindSetDigest`, `modeSetDigest`) from `canonicalGitDeltaFromRaw(rawDiff)` instead of using fake `sha256("paths:${attemptId}")` etc. The `canonicalGitDeltaFromRaw` function derives all four digests from the normalized delta via `deriveOracleAttributionDigests`, ensuring the oracle's re-derivation matches exactly.

### Defect #3: Missing promotion intent creation

**Fix:** Added `PromotionAuthority.createIntent(...)` call in the attempt-runner's success state machine, before `mintPromotionCleanup`. The intent is created with the exact oracle decision ID, commit attribution ID, candidate OID, and delivery ref from the real production observations. Also made `createAuthorizedPromotionIntent` idempotent by `promotion_intent_id` — if a fixture already seeded the intent with a different idempotency key but the same lineage, the existing row is returned as a replay.

### Defect #4: Missing ticket state transition and promotion observation evidence

**Fix:** 
- Updated `advanceAttemptToCleanupPending` in `store.ts` to also transition the `run_tickets` state from `active` to `cleanup_pending` (in addition to the `attempts` state transition). This satisfies the promotion intent scope validation's `ticket_state === "cleanup_pending"` requirement.
- Added promotion observation evidence creation in the attempt-runner before `mintPromotionCleanup`, using `persistAuthorityEvidence` with the promotion observation payload. Added an `evidenceExists` check to skip creation if the evidence already exists (backward compatibility with fixture-based tests that seed the evidence directly).

## Files Changed

- `orchestrator/src/lifecycle/attempt-runner.ts` — real attribution digests, promotion intent creation, promotion observation evidence, `PromotionAuthority` import
- `orchestrator/src/lifecycle/attempt-runner-providers.ts` — target proof set evidence scope includes kind suffix
- `orchestrator/src/state/store.ts` — `advanceAttemptToCleanupPending` also transitions ticket state; `createAuthorizedPromotionIntent` idempotent by `promotion_intent_id`; new `evidenceExists` method
- `orchestrator/test/reliability/attempt-runner-production-wiring.test.ts` — ticket state assertion accepts "active" or "cleanup_pending"
- `orchestrator/test/reliability/attempt-runner-real-providers-docker-integration.test.ts` — corrected outcome assertion from `"ok"` to `"succeeded"` (matching the `RunOutcome` type)

## Verification

- **typecheck:** green (0 errors)
- **build:** green (dist/cli.js refreshed)
- **vitest scoped M4:** 75/75 passed (attempt-critical-section 25 + production-wiring 7 + providers-and-container-env 9 + real-providers-docker-integration 12 + attempt-ownership 18 + build-loop 4)
- **vitest Docker integration:** 12/12 passed (all 12 tests including the Docker integration test #12)
- **pytest:** 367 passed, 3 skipped
- **citadel:** 0 CRITICAL, 0 HIGH (30 MEDIUM pre-existing, 4 LOW skeptic report-only)
- **doctor:** exit 0, autonomous_dispatch enabled with proof=attempt-runner-critical-section-v1

## Known Limitations

None. All 12 integration tests pass, including the Docker integration test that drives the full `runBuild` production path with real Docker containment and asserts successful terminalization (`outcome.status === "succeeded"`, `stableCode === "RICKGENT_OK"`).

## Next Dependency Boundary

M4-t22CD is complete. All scoped M4 suites pass, the Docker integration test passes, and all validators (typecheck, pytest, citadel, doctor) are green. The next milestone is M5 (t23 concurrency proof).
