# Phase 4 — t22A State Bridge Finish — Execution Report

**Date:** 2026-07-20
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t22 (Integrate the attempt ownership critical section), tranche A
**Status:** Complete (t22A done; t22B, t22C, t22D pending)

## Scope

t22A finishes the state-bridge tranche that connects real observer-owned
writers to the five disposition receipt types. The prior tranche (t22
phase 4 attempt-runner state bridge) introduced the branded receipt
schema and the five receipt authorities, but left no public minting seam:
the receipt constructors were reserved behind private authority symbols
with no Store command or capability path that the runtime could drive.

t22A closes that seam and replaces the generic cleanup finalization path
with purpose-specific failure, promotion, and quarantine transactions.
It also binds attempt-owned execution context to the authority-derived
worktree/index/policy claims (not the caller repository or legacy run
workspace) and adds the full negative-proof matrix.

### What was implemented

1. **LeaseAuthority mint capability.**
   `LeaseAuthorityMintCapability` is a symbol-gated brand class with a
   `WeakSet` membership check. Only `LeaseAuthority.issueDispositionMintCapability()`
   can mint a valid capability. The `isLeaseAuthorityMintCapability()`
   predicate rejects structural, prototype, serialized, and cross-type
   forgeries. The five `mint*Receipt` helper functions in
   `disposition.ts` call the private-authority receipt constructors only
   after verifying the capability.

2. **Five branded Store commands.**
   `StateStore` exposes `mintTargetNeverReleased`,
   `mintCleanupEligibility`, `mintFailureCleanup`,
   `mintPromotionCleanup`, and `mintQuarantine`. Each command:
   - Mints a branded receipt via the capability (rejects forged
     capabilities).
   - Validates the durable preimage via SQL (target start gate held,
     ownership lease active at the exact generation/context digest, etc.).
   - Builds the full receipt row with FK-derived columns (target proof
     set, claim preimage digest, salvage record, oracle decision,
     promotion intent, eligibility record).
   - Persists evidence + receipt row (+ quarantine claim set/members) and
     advances the gate/ownership state transition atomically in one
     `#immediate` transaction.
   - Replay of identical inputs returns the identical immutable
     postimage; a divergent postimage for the same idempotency key
     conflicts.

3. **Purpose-specific finalization.**
   `disposition-finalization.ts` provides `finalizeFailure`,
   `finalizePromotion`, and `finalizeQuarantine`. Each asserts the exact
   branded receipt kind and rejects cross-disposition receipts:
   - `finalizePromotion` requires the exact accepted oracle decision id
     and independently observed candidate/delivery oids that match the
     receipt, plus a promotion-purpose cleanup receipt.
   - A failure-cleanup receipt cannot satisfy promotion.
   - A quarantine receipt cannot satisfy promotion or failure.
   - A promotion-cleanup receipt cannot satisfy failure or quarantine.

4. **Authority-derived execution context binding.**
   `IdentityContextResolver.resolveAuthorityExecutionContext` rejects a
   non-authorized ownership grant and rejects binding the execution
   context to the caller repository when the authority worktree equals
   it (closes the legacy `ReadyRunWorkspace` vector).

5. **Pre-existing citadel MEDIUM banned-cast fix.**
   Replaced the `as never` casts at `disposition-authority.test.ts`
   lines 268-269 with a `ConstructorInput<typeof Receipt>` conditional
   type and typed union access. The `banned-constructs-casts` analyzer
   now reports no findings.

6. **Negative-proof matrix.**
   `disposition-store-bridge.test.ts` (18 tests) covers: atomic
   persistence, replay, divergent-postimage conflict, forged-capability
   rejection, stale-generation rejection, crash-point rollback,
   cross-disposition isolation (failure != promotion, quarantine !=
   promotion/failure, promotion != failure/quarantine), promotion
   requires exact oracle + observed delivery, authority context binding
   rejects caller repo + forged grant, legacy v1/stale ownership
   rejection, generic cleanup record rejection, and the negative-proof
   matrix (crash / partial-write / idempotency / rollback). Each fails
   closed.

7. **Brand/forgery test extension.**
   `disposition-authority.test.ts` extended from 13 to 16 tests with a
   cross-type prototype forgery matrix, forged-capability rejection, and
   factory-issued capability minting exactly one branded receipt per type.

## Outcome

Complete. All five Store mint commands are implemented and tested. The
purpose-specific finalization module is in place. The authority-derived
execution context binding is implemented. The pre-existing
banned-cast findings are fixed. The comprehensive negative-proof matrix
passes. Production activation remains closed.

## Proof

### Focused gate (touched suites)

| Suite | Tests | Result |
| --- | --- | --- |
| `disposition-authority.test.ts` | 16 | 16 passed |
| `disposition-store-bridge.test.ts` | 18 | 18 passed |
| `oracle-authority.test.ts` | 14 | 14 passed |
| `oracle-store-integration.test.ts` | 11 | 11 passed |
| `lifecycle-exit-ownership.test.ts` | 3 | 3 passed |
| **Subtotal** | **62** | **62 passed** |

### Scoped regression (related suites)

| Suite | Tests | Result |
| --- | --- | --- |
| `transition-authority.test.ts` | — | passed |
| `attempt-ownership.test.ts` | — | passed |
| `legacy-state-quarantine.test.ts` | 4 | 4 passed |
| `state-store.test.ts` | 86 | 85 passed, 1 pre-existing environmental failure |
| `state-contract.test.ts` | — | passed |
| **Subtotal** | — | **53 passed + 85/86** |

The single `state-store.test.ts` failure (`process.chdir() is not
supported in workers`) is a pre-existing environmental issue: the test
calls `process.chdir()` which Node.js does not support inside thread-pool
workers. It is unrelated to t22A changes (which do not touch state-store
bootstrap or `process.chdir`).

### Python policies

`python3 -m pytest test/` → **367 passed, 3 skipped** (green).

### Citadel hard gate

`rickgent citadel --prd MISSION_3_PRD.md --repo .` → exit 0.
Summary: 1 finding (CRITICAL=0, HIGH=0, MEDIUM=0, LOW=1).
- The LOW finding is the pre-existing `project-shape-detection` (nestjs-api/react-frontend shape detection).
- `banned-constructs-casts` analyzer: **no findings** (the `as never`
  casts at lines 268-269 are resolved).

### Doctor

`rickgent doctor` → exit 0.
- `autonomous_dispatch`: state=`fixture_only`, code=`RICKGENT_AUTONOMOUS_FIXTURE_ONLY`.
- t22A does not activate production; the capability remains fixture-only.

## Files changed

| File | Change |
| --- | --- |
| `orchestrator/src/lifecycle/disposition.ts` | Added `LeaseAuthorityMintCapability` brand + factory + predicate + five `mint*Receipt` helpers |
| `orchestrator/src/state/leases.ts` | Added `LeaseAuthority.issueDispositionMintCapability()` |
| `orchestrator/src/state/store.ts` | Added five `mint*` Store commands, request/result interfaces, `#persistDispositionReceipt`, preimage validators |
| `orchestrator/src/lifecycle/disposition-finalization.ts` | Created: `finalizeFailure`/`finalizePromotion`/`finalizeQuarantine` + cross-disposition isolation |
| `orchestrator/src/context/resolver.ts` | Added `resolveAuthorityExecutionContext` (rejects caller-repo binding) |
| `orchestrator/test/reliability/disposition-authority.test.ts` | Fixed banned-cast; extended brand/forgery/mint-capability tests (16, was 13) |
| `orchestrator/test/reliability/disposition-store-bridge.test.ts` | Created: 18-test negative-proof matrix |
| `docs/remediation/trust-spine-manifest.json` | Updated t22 entry: status In Progress, t22A Done, t22B-t22D Todo |

## Known limitations

- The generic `CleanupService` remains as a compatibility seam; t22D
  removes the legacy run-worktree/direct-spawn/finally-release path.
- Production activation is deferred to t22D; `autonomous_dispatch` stays
  `fixture_only` after t22A.
- The `state-store.test.ts` `process.chdir()` failure is pre-existing
  and environmental (thread-pool worker limitation), not introduced by
  this tranche.

## Next dependency boundary

- **t22B** (containment backend) requires the M2 containment ADR
  ratification and a runtime-unforgeable containment authority
  (cgroup-v2 / PID-namespace on Linux; validated privileged/VM authority
  on macOS).
- **t22C** (one AttemptRunner) composes the acquisition/finalization
  order on top of the t22A Store commands and t22B containment.
- **t22D** (cutover + activation) removes the legacy path and activates
  production only after real platform containment validation.
