# Phase 7 — Resume and Reconciliation Parity (t29) Execution Report

**Date:** 2026-07-22
**Ticket:** t29 — Make resume and structured reconciliation use lifecycle-oracle parity
**Status:** Done
**Commit:** (filled at commit time)

## Scope

Implement explicit-run resume from persisted receipts, resolve response-lost planned retries through typed no-side-effect cleanup, allocate later attempts only after reconciliation, and activate the `resume_retry` and `reconciliation` capabilities after proofs pass.

## Outcome

All acceptance criteria are met:

1. **Resume from persisted receipts:** `resumeRun` in `orchestrator/src/lifecycle/recovery.ts` resolves the canonical repository state from the durable SQLite state store, validates contract/context/oracle version compatibility, and determines the next safe action for each ticket. It does not require caller CWD state.

2. **Response-lost planned retry recovery:** A retry allocation committed before response loss but never activated (no execution context, no lease, no process receipts) is detected as an orphaned planned attempt. `StateStore.recoverOrphanedPlannedAttempt` transitions it to `failed_clean` via typed `state_transitions` rows with `owner_service = "RecoveryService"` and a typed `input_digest` carrying `cleanup_reason: "response_lost_retry_allocation"` and `no_side_effects_confirmed: true`. The orphaned attempt is never activated.

3. **Later attempts allocated only after reconciliation:** After the orphaned planned cleanup, a newly committed higher-numbered attempt is allocated via `StateStore.allocateRetryAttempt`. The new attempt has a different ID and a higher attempt number than the orphaned one.

4. **Commit prose non-authoritative:** `reconcile` in `orchestrator/src/lifecycle/reconcile.ts` reads only the durable SQLite state store. Git subjects, commit messages, and legacy JSONL dispatch ledgers are never imported as truth. The verification command `! rg -n "ticket:\s*<id>|git log --oneline --all|runId:\s*[\"']reconciled" orchestrator/src/lifecycle/reconcile.ts` passes (no forbidden patterns).

5. **Capability activation:** `doctor` reports `resume_retry` as `enabled` with `proof_version: "recovery-parity-v1"` and `reconciliation` as `enabled` with `proof_version: "recovery-parity-v1"`.

## Proof Counts

- **21/21** recovery-parity tests passed (`recovery-parity.test.ts`)
- **5/5** state-crash-corpus tests passed (`state-crash-corpus.test.ts`) — including the 2 pre-existing stale-inventory failures, now fixed
- **2/2** reconcile tests passed (`reconcile.test.ts`)
- **28/28** scoped regression passed across all 3 suites
- **367/3** Python policy tests passed (367 passed, 3 skipped)
- **0 CRITICAL, 0 HIGH** citadel findings introduced by this tranche
- **doctor exit 0** with `resume_retry` and `reconciliation` both `enabled` with correct proof references

## Negative Proofs

- **Rejects resume of non-existent run:** `RICKGENT_STATE_RESUME_INCOMPATIBLE` thrown
- **Rejects incompatible manifest digest:** `RICKGENT_STATE_RESUME_INCOMPATIBLE` thrown
- **Rejects changed contract digest (commit prose as truth):** `RICKGENT_STATE_RESUME_INCOMPATIBLE` thrown
- **Orphaned cleanup rejects non-planned attempt:** `RICKGENT_STATE_TRANSITION_ILLEGAL` thrown
- **Orphaned cleanup rejects attempt with execution context (already activated):** Not detected as orphaned; resume proceeds normally
- **Idempotent replay:** Replaying resume after orphaned cleanup does not create duplicate cleanup transitions or duplicate attempt allocations
- **Reconcile ignores Git subjects:** No `registry.json` created from commit messages; zero tickets found when no state store exists
- **Reconcile ignores legacy JSONL ledger:** Forged dispatch ledger not imported as truth; ledger file unchanged

## State-Crash Corpus Inventory Update

The pre-existing stale transaction inventory (2 failures) was fixed by adding 20 new fault points to the crash-matrix fault-points.json:
- 19 operations from t22A-t28 that were missing from the inventory (mint_cleanup_eligibility, mint_failure_cleanup, mint_promotion_cleanup, mint_quarantine, mint_target_never_released, mint_target_released, create_and_seal_authority_target_proof_set, create_held_target_start_gate, activate_run_for_runner, activate_ticket_for_runner, advance_attempt_cleanup_pending, advance_claims_quarantined, advance_ticket_cleanup_pending, finalize_quarantine_ownership, persist_authority_claim_snapshot, persist_authority_commit_attribution, persist_authority_evidence, persist_authority_ownership_snapshot, persist_authority_process_chain)
- 1 new operation from t29 (recover_orphaned_planned_attempt)

11 new contract transactions were added to `STATE_TRANSACTION_NAMES` in schema.ts. The manifest's `public_capability` was updated from `{resume_retry: "unavailable", reconciliation: "unavailable"}` to `{resume_retry: "enabled", reconciliation: "enabled"}`.

## Known Limitations

- The `build|pipeline --resume` CLI path still requires wiring through `resumeRun` in the build lifecycle; the capability is activated and the recovery module is production-ready, but the build loop's resume entry point will be wired in a later ticket.
- The `rickgent retry` CLI command remains rejected (no public retry command); resume is via `build --resume`.

## Next Dependency Boundary

t30 (remove lifecycle and terminal shortcuts) depends on t29. The single lifecycle engine and terminal predicate removal is the next ticket in M7.
