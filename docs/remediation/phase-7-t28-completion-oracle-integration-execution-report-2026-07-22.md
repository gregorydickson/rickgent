# Phase 7 t28 — Completion Oracle v2 Lifecycle Integration Execution Report

**Date:** 2026-07-22
**Ticket:** t28 — Integrate the shared versioned completion oracle
**Milestone:** M7 (t27–t30)
**Status:** Done

## Scope

Integrate the Oracle v2 contract (`state/oracle.ts`, `evaluateAttemptOracle`) into the lifecycle as the single completion oracle. The Oracle v2 was already implemented (t22A substrate, t20 store integration); this ticket wires it into the lifecycle layer as the explicit, documented sole route to `ready_for_delivery` and proves the integration with comprehensive tests.

### What was built

1. **`orchestrator/src/lifecycle/completion-service.ts`** — The `CompletionService` class is the sole lifecycle-layer route to the Oracle v2. It wraps `StateStore.evaluateAndPersistAttemptOracle` with:
   - A branded caller allowlist (`attempt-runner.oracle`, `lifecycle-engine.oracle`, `resume.reconcile`) enforced at the API boundary — no bypass.
   - A typed `CompletionServiceResult` exposing the oracle version, decision id, result, reasons, input/output digests, and reference integrity.
   - Version validation: the service rejects if the oracle version is not `RICKGENT_ORACLE_VERSION`.
   - Null/undefined caller rejection (no `!= null` short-circuit bypass).

2. **`orchestrator/test/reliability/completion-oracle-integration.test.ts`** — 26 integration tests proving:
   - Oracle v2 is the single completion oracle (versioned, one store entrypoint, one pure evaluation function).
   - Every required input class is checked: missing gate, null/skipped/unavailable/infrastructure_error/stale/conflicting gate, missing review, missing attribution, missing cleanup eligibility, missing target proof set — each rejects fail-closed.
   - Idempotent replay: live execution and persisted re-evaluation call the same oracle/version.
   - Caller allowlist enforcement: unauthorized/null/undefined callers throw TypeError (no bypass).
   - Caller audit: no production module calls `evaluateAndPersistAttemptOracle` except authorized routes (store, completion-service, attempt-runner-providers).
   - No production module imports `evaluateAttemptOracle` directly except `state/oracle.ts` and `state/store.ts`.

3. **`orchestrator/test/reliability/gate-failure-corpus.test.ts`** — 17 gate-failure-corpus tests proving:
   - Every non-passed gate status (`failed`, `missing`, `null`, `skipped`, `unavailable`, `infrastructure_error`, `stale`, `conflicting`) blocks oracle acceptance.
   - Missing gate result row (absent entirely) blocks with `required_gate_missing_or_duplicate`.
   - Positive control: `passed` accepts.
   - No forbidden downstream: rejected oracle produces no `promotion_intent`, no `delivery_intent`, attempt stays in `cleanup_pending`.

4. **`orchestrator/test/fixtures/gate-corpus/manifest.json` and `faults.json`** — The gate corpus manifest (complete, required gates, all 9 statuses, 8 blocking + 1 green) and 10 fault definitions covering each blocking status, the absent-gate case, and the positive control.

5. **`orchestrator/test/helpers/oracle-fixture.ts`** — Shared fixture builder for the t28 tests, extracting the complete attempt fixture pattern (run, contract, attempt, execution contexts, gates, review, attribution, target proof set, cleanup eligibility, resource/lease snapshots, process receipts) with omission options for each input class.

6. **`test/core/caller-audit.test.ts`** — Unchanged (the existing audit still passes; the `CompletionService` method is named `evaluateAttemptCompletion` to avoid collision with the core `evaluateCompletion` function's audit).

## Outcome

- **Oracle v2 is the single completion oracle for the lifecycle.** The `CompletionService` is the sole lifecycle-layer wrapper; no other production module calls the store's oracle method directly. The store exposes exactly one oracle entrypoint (`evaluateAndPersistAttemptOracle`); the pure oracle module exports exactly one evaluation function (`evaluateAttemptOracle`).
- **Every lifecycle/Git/process/gate/review/evidence/ownership/cleanup-eligibility/scope input is required.** The oracle's `REQUIRED_ORACLE_INPUT_CLASSES` and validation logic check each input class; missing inputs produce explicit rejection reasons (`missing_input_class:*`, `required_gate_missing_or_duplicate`, `cleanup_eligibility_cardinality:0`, `complete_target_proof_set_cardinality:0`).
- **Missing or null inputs block completion fail-closed; no bypass.** The caller allowlist enforces unauthorized access rejection; null/undefined callers throw TypeError. The oracle rejects with explicit reasons for every missing/null/stale/conflicting input.
- **Live execution and persisted re-evaluation call the same oracle/version.** Idempotent replay returns the identical decision; the oracle version is pinned to `RICKGENT_ORACLE_VERSION`.

## Proof counts

- **26/26** completion-oracle-integration tests passed.
- **17/17** gate-failure-corpus tests passed.
- **32/32** caller-audit tests passed.
- **219/219** scoped regression tests passed (8 suites: completion-oracle-integration, gate-failure-corpus, caller-audit, oracle-store-integration, oracle-authority, review-remediation, lifecycle-transitions, gate-runner).
- **367 passed, 3 skipped** Python policy tests.
- **0 CRITICAL, 0 HIGH** citadel findings (6 MEDIUM pre-existing, 1 LOW pre-existing).
- **doctor exit 0** — capability matrix unchanged (resume_retry/reconciliation still unavailable; t28 does not activate capabilities).

## Red-then-green proof

The tests were written first and run against the codebase. The initial run had 3 failures in the caller-audit portion (path prefix mismatch in the authorized-file exclusion set) and 1 failure in the `omitAttribution` test (foreign key constraint when attribution is omitted but commit_intent references it). After fixing the fixture helper to conditionally skip commit_intent and cleanup_eligibility when attribution is omitted, and fixing the audit path prefixes, all 75 tests across the 3 new/updated suites passed green.

## Known limitations

- The `CompletionService` is a thin lifecycle-layer wrapper. The production oracle evaluation is already wired in `attempt-runner-providers.ts` (the `oracle` provider calls `store.evaluateAndPersistAttemptOracle`). The `CompletionService` documents and enforces this as the sole route, but the actual production call site remains in `attempt-runner-providers.ts` (authorized as the `attempt-runner.oracle` caller). A future ticket (t30) may consolidate the call site to go through `CompletionService` directly.
- The gate-failure-corpus tests use the `completeFixture` helper which seeds all inputs via direct SQL inserts (the same pattern as `oracle-store-integration.test.ts`). This is a unit-level isolation pattern; the production path is proven by the `attempt-critical-section.test.ts` suite (t22C/t22D).

## Next dependency boundary

t29 (resume and reconciliation parity) depends on t28. t29 implements explicit-run resume and retry from authoritative SQLite receipts through the same LifecycleEngine and completion oracle. The `CompletionService` is ready for t29 to use as the `resume.reconcile` caller.
