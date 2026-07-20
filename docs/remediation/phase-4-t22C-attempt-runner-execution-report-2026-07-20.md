# Phase 4 — t22C AttemptRunner Composition — Execution Report

**Date:** 2026-07-20
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t22 (Integrate the attempt ownership critical section), tranche C
**Status:** Complete (t22C done; t22D pending)

## Scope

t22C creates one `AttemptRunner` that owns the full attempt critical section:
acquisition, context/policy preparation, containment, dispatch, supervision,
attribution, review, verification, oracle evaluation, promotion/failure
cleanup, and finalization ordering.  The runner implements seven state
machines (success, ordinary failure, infrastructure failure, quarantine,
timeout, cancellation, recovery) with stable idempotency keys and
deterministic replay/conflict behavior.  Crash recovery uses only durable
receipts and current authority, rejecting commit prose and caller state as
truth.

## Implementation

### AttemptRunner (`orchestrator/src/lifecycle/attempt-runner.ts`)

The `AttemptRunner` class is the sole production owner of the attempt
critical section.  It composes the existing authorities:

- **LeaseAuthority** — attempt ownership acquisition and cleanup
- **StateStore** — durable receipt minting, state transitions, recovery
- **TargetStartGateAuthority** — target start gate release and never-released
- **AttemptExecutionContextAuthority** — policy bundle and execution context
- **ContainmentBackend** — authority-owned containment boundary
- **ProcessSupervisor** — process launch, supervision, and death receipt
- **CommitService** — commit attribution
- **Oracle v2** — oracle evaluation
- **AttemptTerminalizationService** — purpose-specific terminalization

The runner exposes two entry points:
- `runAttempt(request)` — the full positive path (success or failure)
- `quarantineAttempt(request, reasonCode)` — the quarantine path

### Seven State Machines

1. **Success**: acquire -> prepare context -> containment -> dispatch ->
   supervise -> attribute -> review -> verify -> cleanup eligibility ->
   oracle -> promotion cleanup -> promotion finalization -> terminalize

2. **Ordinary failure** (review reject or verification fail): same as success
   up to the failing step, then failure cleanup -> failure finalization ->
   terminalize.  The failure code carries the specific failure reason.

3. **Infrastructure failure** (containment unavailable, verification
   infrastructure error, spawn error): the runner detects the infrastructure
   failure and transitions to failure cleanup without a terminal process
   receipt.  For containment unavailable, the target start gate is closed as
   `never_released`.

4. **Quarantine**: the runner closes the target start gate as
   `never_released`, transitions resource claims to `quarantined` state (for
   the `quarantine_claim_members` FK), mints the quarantine receipt, then
   finalizes the ownership lease to `quarantined`.  Ownership is NOT released.

5. **Timeout**: the process supervisor reports a timeout.  The runner
   transitions to failure cleanup with a timeout failure code.  Timeout is
   never terminal.

6. **Cancellation**: the runner detects cancellation and transitions to
   failure cleanup with a cancellation code.

7. **Recovery**: `recoverAttempt(request)` reconstructs runner progress
   solely from durable receipts in the StateStore and current authority.  It
   rejects commit prose and caller state as truth, using only durable receipt
   rows to determine the next step.

### Stable Idempotency Keys

Every externally visible step has a stable idempotency key derived
deterministically from the attempt ID and step name:

```
attempt-runner:{attemptId}:{step}
```

Steps: `acquire`, `prepare-context`, `containment`, `dispatch`, `supervise`,
`attribute`, `review`, `verify`, `cleanup-eligibility`, `oracle`,
`promotion-cleanup`, `failure-cleanup`, `quarantine`, `finalize`.

Replaying the same step with the same inputs returns the identical immutable
postimage.  A divergent replay conflicts with
`RICKGENT_STATE_IDEMPOTENCY_CONFLICT`.

### Crash Recovery

The `recoverAttempt` method reads durable receipts from the StateStore:
- `attempt_ownership_leases` — current ownership state
- `commit_attributions` — attribution evidence
- `oracle_decisions` — oracle result
- `cleanup_eligibility_records` — cleanup eligibility
- `failure_cleanup_records` / `quarantine_records` — terminal disposition
- `target_start_gates` — gate state

It reconstructs the runner progress and determines the next step.  It rejects:
- Commit prose (a commit message claiming "done" is not evidence)
- Caller state (a caller-supplied ownership grant is not truth)

### Store Methods Added

- `advanceAttemptToCleanupPending(attemptId, idempotencyKey)` — transitions
  the attempt to `cleanup_pending` state with an idempotency key.
- `advanceClaimsToQuarantined(attemptId, ownershipId, ownerGeneration, proof)`
  — transitions resource claims from `cleanup_pending` to `quarantined` state
  (required before `mintQuarantine` for the `quarantine_claim_members` FK).
- `finalizeQuarantineOwnership(attemptId, ownershipId, ownerGeneration)` —
  transitions the ownership lease from `cleanup_pending` to `quarantined`
  (called after `mintQuarantine` so the preimage validation still sees
  `cleanup_pending`).
- `readAttemptState(attemptId)` — reads the current attempt state for
  recovery.

### FixtureContainmentBackend (`orchestrator/src/process/containment.ts`)

Added `FixtureContainmentBackend` for test validation: a real subprocess-based
containment backend that mints real branded receipts (WeakSet brand-checked).
It uses `/usr/bin/true` as the spawned process and provides authoritative
membership and death receipts.

## Test Coverage

### `attempt-critical-section.test.ts` (25 tests)

**VAL-T22CD-001: Single AttemptRunner owns the full critical section**
- The AttemptRunner is the sole production owner exported from
  `attempt-runner.ts`

**VAL-T22CD-002: Seven state machines with stable idempotency keys**
- Success state machine: promotion cleanup + promotion finalization
- Ordinary failure (review reject): failure cleanup + failure finalization
- Ordinary failure (verification fail): failure cleanup with verification code
- Infrastructure failure (containment unavailable): target-never-released +
  failure cleanup, no terminal process receipt
- Infrastructure failure (verification infrastructure error)
- Infrastructure failure (spawn error during dispatch)
- Quarantine state machine: quarantine receipt + quarantine finalization;
  ownership not released
- Timeout state machine: failure cleanup with timeout code; timeout is never
  terminal
- Cancellation state machine: failure cleanup with cancellation code
- Oracle-rejected state machine: failure cleanup with oracle_rejected code +
  eligibility persisted
- Replay returns identical immutable postimage
- Stable idempotency keys are deterministic from attempt id + step
- Divergent cleanup-eligibility replay conflicts

**VAL-T22CD-003: Crash recovery from durable receipts only**
- Recovery reconstructs runner progress after a success
- Recovery reconstructs a failure after an infrastructure failure
- Recovery reconstructs a quarantine
- Recovery rejects commit prose as truth
- Recovery rejects caller state as truth
- Recovery of a mid-flight attempt points to the next step

**VAL-T22CD-004: Negative-proof matrix fails closed**
- A caller-supplied (forged) ownership grant is rejected
- A stale-generation ownership is rejected
- The containment death receipt is authority-owned (WeakSet-branded)
- The runner has no second lifecycle engine or terminal predicate (one oracle,
  one terminal)
- Production-path: AttemptRunner is the sole composition owner exported

## Verification

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `pnpm typecheck` | Pass (0 errors) |
| Build | `pnpm build` | Pass |
| Attempt critical section | `pnpm vitest run test/reliability/attempt-critical-section.test.ts` | 25/25 pass |
| Disposition store bridge | `pnpm vitest run test/reliability/disposition-store-bridge.test.ts` | 35/35 pass |
| Disposition authority | `pnpm vitest run test/reliability/disposition-authority.test.ts` | 16/16 pass |
| Containment authority | `pnpm vitest run test/reliability/containment-authority.test.ts` | pass |
| Containment corpus | `pnpm vitest run test/reliability/containment-corpus.test.ts` | pass |

## Files Changed

| File | Change |
| --- | --- |
| `orchestrator/src/lifecycle/attempt-runner.ts` | New: AttemptRunner class (~1390 lines) |
| `orchestrator/src/process/containment.ts` | Added FixtureContainmentBackend |
| `orchestrator/src/state/store.ts` | Added advanceAttemptToCleanupPending, advanceClaimsToQuarantined, finalizeQuarantineOwnership, readAttemptState |
| `orchestrator/test/reliability/attempt-critical-section.test.ts` | New: 25 tests covering VAL-T22CD-001 through -004 |
| `docs/remediation/phase-4-t22C-attempt-runner-execution-report-2026-07-20.md` | This report |

## Key Design Decisions

### Quarantine state machine ordering

The quarantine path requires resource claims in `quarantined` state for the
`quarantine_claim_members` FK, but `mintQuarantine`'s preimage validation
(`#validateCleanupDispositionPreimage`) requires the ownership lease in
`cleanup_pending` state.  The resolution is a three-phase ordering:

1. `advanceClaimsToQuarantined` — transitions resource claims to `quarantined`
   (ownership lease stays `cleanup_pending`)
2. `mintQuarantine` — mints the quarantine receipt (preimage validation sees
   `cleanup_pending` ownership, FK sees `quarantined` claims)
3. `finalizeQuarantineOwnership` — transitions the ownership lease to
   `quarantined` (after the quarantine receipt is durable)

### Idempotency key uniqueness

The `noteKey("promotion-cleanup")` call appears once (in `#beginCleanupPhase`)
rather than twice, ensuring all idempotency keys are unique across the
success path.  The `advanceAttemptToCleanupPending` call uses a separate
`begin-attempt-cleanup` step internally.

### Gate closure before cleanup-preimage

The quarantine path closes the target start gate as `never_released` before
calling the cleanup-preimage provider, so the provider sees
`closed_never_released` gate state and creates a `never_released` proof
member.
