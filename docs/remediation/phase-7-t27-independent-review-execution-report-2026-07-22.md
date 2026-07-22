# Phase 7 — t27 Independent Review and Bounded Remediation Execution Report

**Date:** 2026-07-22
**Ticket:** t27 — Implement independent review and bounded remediation
**Milestone:** M7-t27-t30
**Status:** Done
**Fulfills:** VAL-ORC-001

## Scope

Implemented the independent review authority (`review.ts`) and bounded remediation authority (`remediation.ts`) that enforce the t27 acceptance criteria:

1. Fresh read-only review against immutable inputs (reviewer process/role differs from implementation, no write/terminal-state authority, no mutable session state).
2. Validated accept/reject verdict with structured findings (IDs, severity, paths/interfaces, evidence references, context/contract digest).
3. Bounded remediation within the contract budget (max_review_cycles / remediation_limit), same owned attempt scope, fresh reviewer per cycle.
4. Fail-closed modes: reviewer crash, malformed/missing verdict, attempted write, stale diff, role equality, exhausted budget.
5. Independent review, not cross-vendor: schema version is `rickgent.independent-review.v1`.

## Outcome

All 46 test cases pass in `orchestrator/test/reliability/review-remediation.test.ts`. The ReviewAuthority is wired into the production review provider (`attempt-runner-providers.ts`), making it the authority route for the real production review path.

## Declared Paths

| Path | Description |
| --- | --- |
| `orchestrator/src/lifecycle/review.ts` | Independent review authority: `performReview`, types, fail-closed validation |
| `orchestrator/src/lifecycle/remediation.ts` | Bounded remediation authority: `performRemediation`, `runBoundedRemediationLoop` |
| `orchestrator/test/reliability/review-remediation.test.ts` | 46 test cases covering all t27 acceptance criteria |

## Implementation Details

### `review.ts` — ReviewAuthority

The `performReview` function is the single authority for performing an independent read-only review. It:

- **Authority-collapse rejection**: checks that the reviewer's role is `"reviewer"` and the worker's role is NOT `"reviewer"`, and that the reviewer's contextId differs from the worker's contextId. Any collapse fails closed with `authority_collapse`.
- **Immutable inputs**: freezes the inputs before passing them to the review hook. The hook receives only the frozen immutable inputs — no store, no write capability, no mutable session state.
- **Stale-diff detection**: compares the inputs' `diffDigest` against the `expectedDiffDigest`. A mismatch fails closed with `stale_diff`.
- **Verdict validation**: validates the hook's verdict is `"accept"` or `"reject"`. A reject requires at least one structured finding (id, severity, message, optional path/evidenceReference). Invalid findings fail closed with `invalid_finding` or `empty_reject_findings`.
- **Fail-closed modes**: reviewer crash (`reviewer_crash`), missing verdict (`missing_verdict`), malformed verdict (`malformed_verdict`), attempted write (`attempted_write` — detected via frozen-input mutation check), stale diff (`stale_diff`), incomplete inputs (`incomplete_inputs`).
- **Schema version**: `rickgent.independent-review.v1` — never cross-vendor.
- **Authority-owned outcome**: every outcome is frozen (not caller-mutable).

### `remediation.ts` — RemediationAuthority + Bounded Loop

The `performRemediation` function performs a single remediation cycle: validates findings, runs the remediation hook, validates the result. Fail-closed on crash, missing result, or empty OIDs.

The `runBoundedRemediationLoop` function drives the full review-remediation-re-review loop:

- **Budget enforcement**: uses `maxReviewCycles` and `remediationLimit` from the contract budget. When either is exhausted, returns `budget_exhausted`.
- **Fresh reviewer per cycle**: each review cycle gets a fresh reviewer context (via `freshReviewerContextId` and `freshReviewerContextDigest`).
- **Same owned attempt scope**: the worker identity is preserved throughout the loop.
- **Fail-closed propagation**: a review fail-closed or remediation fail-closed propagates as `fail_closed`.
- **Schema version**: `rickgent.remediation.v1` — never cross-vendor.
- **Authority-owned outcome**: every outcome is frozen.

### Production Wiring

The `review` provider in `attempt-runner-providers.ts` (the real production call site for the review phase) now uses `performReview` from `review.ts`:

- The real Git observation (candidate tree resolution) is wrapped in a `ReviewHook`.
- The reviewer identity is constructed from the review phase context.
- The worker identity is constructed from the implementation context (different contextId — no authority collapse).
- The immutable inputs include the real baseline/candidate/diff digests.
- The verdict evidence and findings evidence are persisted through the authority APIs with the `rickgent.independent-review.v1` schema version.
- The review record is persisted through `LifecycleRecordAuthority.recordReview`.

## Proof Counts

- **46/46 focused gate** (`review-remediation.test.ts`): all test cases pass.
- **78/78 scoped regression** (review-remediation + attempt-runner-production-wiring + attempt-critical-section): all pass.
- **367 passed / 3 skipped** Python policy suite.
- **0 CRITICAL / 0 HIGH** citadel findings (introduced by this tranche).
- **typecheck**: green.
- **build**: green.

## Red-Then-Green Proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/review-remediation.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red observation:**
```
Error: Cannot find module '../../src/lifecycle/review.js' imported from
'/Users/gregorydickson/loanlight/pickle-rick/rickgent/orchestrator/test/reliability/review-remediation.test.ts'
Test Files  1 failed (1)
     Tests  no tests
```

**Green command:**
```
cd orchestrator && pnpm vitest run test/reliability/review-remediation.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green observation:**
```
✓ test/reliability/review-remediation.test.ts (46 tests) 5ms
Test Files  1 passed (1)
     Tests  46 passed (46)
```

## Test Coverage

| Area | Test cases |
| --- | --- |
| Fresh read-only review against immutable inputs | 4 |
| Validated accept/reject verdict with findings | 8 |
| Reviewer/worker authority collapse rejected | 3 |
| Fail-closed modes (crash, missing/malformed verdict, attempted write, stale diff, incomplete inputs) | 11 |
| Bounded remediation loop (accept, budget exhausted, fresh reviewer, fail-closed, same scope) | 11 |
| Single remediation cycle | 6 |
| Negative proofs (replay idempotency, stale generation, forged outcome) | 3 |

## Known Limitations

- The remediation loop driver (`runBoundedRemediationLoop`) is a pure function tested in isolation. Full integration with the AttemptRunner's lifecycle transition driving (reviewing → remediating → remediation_captured → reviewing) is t28-t30 scope, where the one-engine/one-terminal collapse occurs. The ReviewAuthority is wired into the production review provider; the remediation loop driver is ready for the AttemptRunner to call when the lifecycle integration lands.
- The review hook in production uses the real Git observation (candidate tree resolution). A full model-based review (dispatching a reviewer agent) is t31-t32 scope (observed identity + cross-vendor distinction). Same-model review is allowed by the authority but is never labeled cross-vendor.

## Next Dependency Boundary

t28 — Integrate the shared versioned completion oracle (Oracle v2 as the single completion oracle). t28 depends on t27's independent review being in place.
