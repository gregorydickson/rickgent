# Phase 7 t30 — Remove Lifecycle and Terminal Shortcuts Execution Report

**Date:** 2026-07-22
**Ticket:** t30 — Remove lifecycle and terminal shortcuts
**Milestone:** M7-t27-t30
**Status:** Done
**Fulfills:** VAL-ORC-005, VAL-ORC-007

## Scope

Delete the implementation-only lifecycle and terminal shortcuts, audit production imports/callers until one terminal predicate and one lifecycle engine remain, and add import/caller audits that fail if a second terminal writer or predicate appears.

### What was removed

1. **`gatherCompletionEvidence` from `dispatch/evidence.ts`** — This was a dead function (not called from any production code) that provided a second terminal predicate via the core `evaluateCompletion` with a nullable gate flag (`gateGreen: null`), bypassing Oracle v2. The function and its `CompletionEvidence` / `CompletionEvidenceContext` types were removed. The useful pure observation functions (`captureGitBaseline`, `measureGitDelta`, `observeDbSession`, `captureConversationIds`, `isolatedDataDir`) remain for diagnostic and evidence-gathering use.

2. **`"dispatch.completion"` caller from `core/completion.ts`** — The `dispatch.completion` caller was removed from the `CompletionCaller` type and `ALLOWED_COMPLETION_CALLERS` set. After t30, `evaluateCompletion` is a diagnostic-only pure function used solely by the `rickgent verdict` CLI (`cli.verdict` caller). The single production completion predicate is Oracle v2 (`evaluateAttemptOracle` in `state/oracle.ts`) via `CompletionService` (`lifecycle/completion-service.ts`).

3. **`Registry.updateTicketState` from `lifecycle/registry.ts`** — This was a terminal writer shortcut that could set ticket status to "Done" directly, bypassing the `LifecycleEngine` (the single lifecycle engine in `lifecycle/engine.ts`). The method was removed. The `Registry` class remains for read-only status tracking (`load`, `save`, `getTicketState`, `getPipelineStatus`) but cannot terminalize. Ticket status transitions must go through the `LifecycleEngine.transitionAttempt` API, which validates against the normative `PHASE_TRANSITION_TABLE` and persists durable `state_transitions` rows.

### What was added

**`orchestrator/test/reliability/terminal-writer-audit.test.ts`** — 11 audit tests that scan the production source tree (`orchestrator/src/`) and fail closed if a second terminal writer or terminal predicate appears:

- `evaluateCompletion` is not imported outside `core/` and `verdict-cli` (and `completion-service.ts` which documents the oracle).
- `evaluateCompletion` is not called from any dispatch or lifecycle path.
- No production code passes a nullable gate flag as a completion input.
- `gatherCompletionEvidence` is not exported from `dispatch/evidence.ts`.
- The `dispatch.completion` caller is not in the `evaluateCompletion` allowlist.
- `LifecycleEngine` is defined exactly once in `lifecycle/engine.ts`.
- `Registry.updateTicketState` terminal writer is removed from production code.
- No production code sets ticket status to "Done" outside the `LifecycleEngine`.
- Oracle v2 `evaluateAttemptOracle` is defined exactly once in `state/oracle.ts`.
- `CompletionService` is defined exactly once in `lifecycle/completion-service.ts`.

The audit uses string-literal and comment stripping (same approach as the AC-5 caller audit in `test/core/caller-audit.test.ts`) so that regex-based scans only match real code, not tokens inside strings or comments.

## Outcome

- **One terminal predicate:** Oracle v2 (`evaluateAttemptOracle`) via `CompletionService` is the single production completion predicate. The core `evaluateCompletion` is now diagnostic-only (`cli.verdict` caller only).
- **One lifecycle engine:** `LifecycleEngine` in `lifecycle/engine.ts` is the single production lifecycle engine. The `Registry.updateTicketState` terminal writer shortcut is removed.
- **Production imports/callers audited:** The terminal-writer-audit test suite scans all production source files and fails if a second terminal writer or predicate appears.
- **Verification grep passes:** `rg -n "gateGreen:\s*null|updateTicketState\([^\n]*Done|terminal.*ledger.*return" orchestrator/src --glob '*.ts'` returns no matches (exit 1).

## Declared Paths

| Path | Description |
| --- | --- |
| `orchestrator/src/dispatch/evidence.ts` | Removed `gatherCompletionEvidence`, `CompletionEvidence`, `CompletionEvidenceContext`; removed `evaluateCompletion` import. Pure observation functions retained. |
| `orchestrator/src/core/completion.ts` | Removed `dispatch.completion` from `CompletionCaller` type and `ALLOWED_COMPLETION_CALLERS`. |
| `orchestrator/src/lifecycle/registry.ts` | Removed `updateTicketState` terminal writer method. Registry remains read-only. |
| `orchestrator/test/reliability/terminal-writer-audit.test.ts` | 11 audit tests enforcing one terminal predicate and one lifecycle engine. |
| `orchestrator/test/lifecycle/registry.test.ts` | Updated: `updateTicketState` tests replaced with a test confirming the method is removed. |
| `orchestrator/test/lifecycle/salvage-reconcile-b6.test.ts` | Unchanged (uses `registry.save` and `registry.getTicketState`, not `updateTicketState`). |

## Red-Then-Green Proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/terminal-writer-audit.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red observation (6 failures):**
```
× evaluateCompletion is not imported outside core/ and verdict-cli
  → expected [ 'dispatch/evidence.ts' ] to deeply equal []
× evaluateCompletion is not called from any dispatch or lifecycle path
  → expected [ 'dispatch/evidence.ts' ] to deeply equal []
× no production code passes gateGreen: null as a completion input
  → expected [ 'dispatch/evidence.ts' ] to deeply equal []
× gatherCompletionEvidence is not exported from dispatch/evidence.ts
  → expected '     …' not to match /\bgatherCompletionEvidence\b/
× the dispatch.completion caller is not in the evaluateCompletion allowlist
  → expected '     …' not to contain '"dispatch.completion"'
× Registry.updateTicketState terminal writer is removed from production code
  → expected [ 'lifecycle/registry.ts' ] to deeply equal []
Test Files  1 failed (1)
     Tests  6 failed (11)
```

**Green command:**
```
cd orchestrator && pnpm vitest run test/reliability/terminal-writer-audit.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green observation:**
```
✓ test/reliability/terminal-writer-audit.test.ts (11 tests) 407ms
Test Files  1 passed (1)
     Tests  11 passed (11)
```

## Proof Counts

- **11/11** terminal-writer-audit tests passed.
- **32/32** caller-audit tests passed (unchanged, `dispatch.completion` phantom entry removed).
- **15/15** registry tests passed (updated for `updateTicketState` removal).
- **106/106** scoped regression passed (6 suites: terminal-writer-audit, lifecycle-transitions, e2e-gated-pipeline, caller-audit, registry, salvage-reconcile-b6).
- **216/216** broad M7 scoped regression passed (10 suites including review-remediation, completion-oracle-integration, gate-failure-corpus, recovery-parity).
- **367 passed, 3 skipped** Python policy tests.
- **0 CRITICAL, 0 HIGH** citadel findings (9 MEDIUM pre-existing, 1 LOW pre-existing).
- **doctor exit 0** — capability matrix unchanged (autonomous_dispatch enabled, resume_retry/reconciliation enabled, parallel_dispatch/cross_vendor_review/automatic_delivery/raw_shell unavailable).

## Negative Proofs

- **Second terminal predicate rejected:** The audit test fails if `evaluateCompletion` is imported or called from any file outside `core/completion.ts`, `core/verdict-cli.ts`, and `lifecycle/completion-service.ts`.
- **Nullable completion shortcut rejected:** The audit test fails if any production code passes `gateGreen: null` as a completion input value.
- **Terminal writer shortcut rejected:** The audit test fails if `updateTicketState` appears in any production source file.
- **Second lifecycle engine rejected:** The audit test fails if `LifecycleEngine` is defined in more than one file or outside `lifecycle/engine.ts`.
- **Direct Done status setting rejected:** The audit test fails if any production code outside the allowed set sets ticket status to "Done" directly.
- **Phantom caller rejected:** The caller-audit test (AC-5) fails if the allowlist contains a caller with no real call site (the removed `dispatch.completion` would be a phantom entry).

## Known Limitations

- The `Registry` class in `lifecycle/registry.ts` remains for read-only status tracking (load/save/getTicketState/getPipelineStatus). It is still imported by test files (`registry.test.ts`, `salvage-reconcile-b6.test.ts`) but not by any production code. A future ticket may remove it entirely if the SQLite state store fully supersedes JSON-based status tracking.
- The core `evaluateCompletion` function remains as one of the six core algorithms (per CLAUDE.md convention 7: "Don't rewrite the six core algorithms beyond enumerated defects"). It is now diagnostic-only, accessible solely via the `rickgent verdict` CLI with the `cli.verdict` caller. The single production completion predicate is Oracle v2.
- The `build|pipeline --resume` CLI path still requires wiring through `resumeRun` in the build lifecycle (noted in the t29 report as a later ticket).

## M7 Cumulative Summary (t27-t30)

| Ticket | Status | Report |
| --- | --- | --- |
| t27 | Done | `phase-7-t27-independent-review-execution-report-2026-07-22.md` |
| t28 | Done | `phase-7-t28-completion-oracle-integration-execution-report-2026-07-22.md` |
| t29 | Done | `phase-7-resume-reconcile-parity-execution-report-2026-07-22.md` |
| t30 | Done | `phase-7-t30-remove-shortcuts-execution-report-2026-07-22.md` (this report) |

All four M7 tickets are complete. The milestone achieves:
- Independent review against immutable inputs with bounded remediation (t27, VAL-ORC-001)
- Oracle v2 as the single completion oracle for the lifecycle (t28, VAL-ORC-002, VAL-ORC-003)
- Resume and reconciliation parity from persisted receipts (t29, VAL-ORC-004, VAL-ORC-006)
- One lifecycle engine and one terminal predicate (t30, VAL-ORC-005, VAL-ORC-007)

## Next Dependency Boundary

M8 (t31-t34) — observed harness/model identity, routing/cross-vendor distinction, verified push, and verified idempotent PR creation. t31 depends on M7 completion (one lifecycle engine, one oracle).
