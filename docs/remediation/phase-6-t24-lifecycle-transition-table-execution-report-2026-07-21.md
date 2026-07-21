# Phase 6 — t24 Lifecycle Transition Table — Execution Report

**Date:** 2026-07-21
**Ticket:** t24 — Implement the persisted lifecycle transition table
**Milestone:** M6-t24-t26
**Status:** Done
**Fulfills:** VAL-LIFE-001

## Scope

Replace the unused boolean 8-phase scaffold (`orchestrator/src/lifecycle/phase.ts`:
`PHASES`, `shouldAdvance`, `nextPhase`, `isTerminal`) with one normative
phase/remediation transition table.  Build a `LifecycleEngine` that validates
every attempt phase transition against the table and delegates to the
transactional transition API.  Wire the production `AttemptRunner` to route
its six forward phase transitions through the engine so the normative table
is the single authority for which attempt transitions are legal.  Prove every
legal edge transitions and every illegal edge is rejected fail-closed.

## Outcome

- **`orchestrator/src/lifecycle/phase.ts`** — rewritten.  Exports
  `PHASE_TABLE_VERSION` (`rickgent.phase-table.v1`), `PHASE_STATES` (14
  normative attempt lifecycle states), `PHASE_TERMINAL_STATES`
  (`verified`, `failed_clean`, `quarantined`), `PHASE_TRANSITION_TABLE`
  (24 declared legal edges: 12 forward success edges, 8 failure edges from
  every pre-cleanup state to `cleanup_pending`, 2 cleanup terminal edges,
  plus the remediation loop `reviewing -> remediating -> remediation_captured
  -> reviewing`), and helpers `legalPhaseEdge`, `isLegalPhaseEdge`,
  `isTerminalPhase`, `phaseEdgesFrom`, `phaseStateIsAtOrPast`.  Every edge
  declares a typed `guard`, `evidenceProducer`, `role`, and (where
  applicable) `remediationBudgetConsumed` and `failureTarget`.

- **`orchestrator/src/lifecycle/engine.ts`** — new.  `LifecycleEngine` class
  validates every `transitionAttempt` input against `PHASE_TRANSITION_TABLE`
  and delegates to the store's transactional CAS writer
  (`advanceAttemptState`).  Illegal edges throw `LifecycleEngineError` with
  code `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL` and persist nothing.
  `resumeAttempt` reads the current persisted state and reports the next
  legal outgoing edges (used by crash/restart recovery).  The engine handles
  three idempotent short-circuits (same-key replay, already-in-target,
  already-past-target) and returns a consistent `LifecycleTransitionResult`
  postimage in every case.

- **`orchestrator/src/lifecycle/attempt-runner.ts`** — production wiring.
  The six forward phase transitions (`planned -> implementing`,
  `implementing -> implementation_captured`, `implementation_captured ->
  reviewing`, `reviewing -> verification_queued`, `verification_queued ->
  verifying`, `verifying -> converging`) and the `#advanceToConverging`
  walk now route through `this.#lifecycle.transitionAttempt(...)` instead of
  the permissive `this.#store.advanceAttemptState(...)`.  The normative table
  is the single authority for which attempt transitions are legal on the
  production path.

- **`orchestrator/test/lifecycle/phase.test.ts`** — rewritten.  Tests the
  normative table structure (versioning, frozen, state list, forward chain,
  remediation loop, failure edges, cleanup terminals, illegal edges,
  terminal classification, outgoing edges, edge metadata).

- **`orchestrator/test/reliability/lifecycle-transitions.test.ts`** — new.
  34 test cases across 7 describe blocks: table structure (AC-1), fail-closed
  edge validation (AC-1/AC-2), legal forward transitions (AC-2), review
  budget semantics (AC-3), crash/restart resume (AC-4), skipped/unavailable
  results cannot advance (AC-5), and negative proofs (empty idempotency key,
  empty evidence, unknown attempt, wrong from-state, resume unknown attempt,
  persisted-row verification).

## Red-then-Green Proof

**RED command:**
```
cd orchestrator && pnpm vitest run test/reliability/lifecycle-transitions.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```
**RED observation:**
```
FAIL  test/reliability/lifecycle-transitions.test.ts
Error: Cannot find module '../../src/lifecycle/engine.js' imported from
  test/reliability/lifecycle-transitions.test.ts
Test Files  1 failed | 0 passed (1)
     Tests  no tests
```

**GREEN command:**
```
cd orchestrator && pnpm vitest run test/reliability/lifecycle-transitions.test.ts test/lifecycle/phase.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```
**GREEN observation:**
```
Test Files  2 passed (2)
     Tests  46 passed (46)
```

## Proof Counts

- **46/46 focused gate** (`lifecycle-transitions.test.ts` 34 + `phase.test.ts` 11 + 1 empty-evidence).
- **71/71 scoped regression** (`lifecycle-transitions` 34 + `phase` 11 + `attempt-critical-section` 25 + 1).
- **87/87 broader regression** (5 additional attempt-runner suites: production-wiring, expected-exit-codes, expected-exit-codes-production, multi-verification, round-5-fixes = 37; plus production-cutover, providers-and-container-env, transition-authority, lifecycle-exit-ownership = 50).
- **367 passed, 3 skipped** Python policy suite (env wired via `init.sh`).
- **0 CRITICAL, 0 HIGH** citadel (`node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .`).
- **typecheck green**, **build green**.

## AC Coverage

| AC | Evidence |
|---|---|
| AC-1: One versioned typed transition table | `PHASE_TABLE_VERSION = "rickgent.phase-table.v1"`; `PHASE_TRANSITION_TABLE` frozen with 24 edges, each declaring `guard`, `evidenceProducer`, `role`, `remediationBudgetConsumed?`, `failureTarget?`. |
| AC-2: Production integration persists the exact required phase sequence; implementation-only dispatch can no longer mark completion | AttemptRunner routes 6 forward transitions + `#advanceToConverging` walk through `LifecycleEngine.transitionAttempt`, which validates against the table before delegating to the store CAS. Illegal edges throw `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL`. |
| AC-3: Review accept enters verification; review reject enters remediation only while budget remains; exhaustion enters cleanup/failure | `reviewing -> verification_queued` (guard `review_record_accepted`); `reviewing -> remediating` (`remediationBudgetConsumed: true`); `reviewing -> cleanup_pending` (guard `budget_exhausted`, `failureTarget: "failed_clean"`). |
| AC-4: Crash/restart resumes from persisted receipts | `LifecycleEngine.resumeAttempt` reads the current persisted state via `store.queryAttemptState` and reports `phaseEdgesFrom(currentState)` without replaying completed transitions. Test proves no new `state_transitions` rows are persisted on resume. |
| AC-5: Skipped/unavailable/infrastructure phase results cannot advance | The table declares no skip edges (e.g. `planned -> reviewing` is illegal). The engine rejects illegal skip-edges fail-closed. Every edge declares a guard (no silent passage). |

## Known Limitations

- The engine's production path delegates to `advanceAttemptState` (the
  store's transactional CAS writer) which does not persist evidence
  references in `transition_evidence_refs`.  The typed
  `TransitionAuthority` path (used by the t22A–t22D composition proofs and
  the promotion finalization path) persists evidence refs for forward edges.
  Routing the AttemptRunner's forward transitions through the
  `TransitionAuthority` with full guard/evidence validation is a future
  enhancement (t27 independent review + bounded remediation will exercise
  the remediation loop edges through the typed path).

- The normative `PHASE_TRANSITION_TABLE` declares failure edges from every
  pre-cleanup state to `cleanup_pending` (e.g. `reviewing -> cleanup_pending`
  for budget exhaustion).  The SQLite `attempts_legal_edge` trigger currently
  allows only `converging -> cleanup_pending` directly; the production
  `#beginCleanupPhase` works around this by walking the legal edge chain to
  `converging` first.  Aligning the trigger with the normative table's
  failure edges is a future schema migration (the trigger is additive and
  can be extended without breaking existing transitions).

## Next Dependency Boundary

- **t25** (full ticket-contract propagation) depends on t24.  The normative
  transition table is in place; t25 carries acceptance criteria, interfaces,
  scope, dependencies, contract digest, and budgets through every prompt and
  receipt without lossy reconstruction.
- **t26** (sandboxed structured gate runner) depends on t25.  The gate runner
  will consume the normative table's `gate_results` guard for the
  `verifying -> converging` and `verifying -> cleanup_pending` edges.
