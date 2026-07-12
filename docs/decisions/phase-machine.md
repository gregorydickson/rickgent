# Decision: Phase Machine (8-Phase Loop)

## Component
§2 matrix row: "8-phase loop" — Omnigent has a generic session (no phases); Pickle Rick has `mux-runner.ts` with a context-clearing outer loop and a factored recovery state machine.

## Omnigent implementation
Generic session (`sys_session_send` / `omnigent run`). No phase concept — no context clearing between phases, no phase transitions, no no-progress detection, no breaker recovery, no re-spawn-resume, no per-phase gate hooks. A session is a single request/response or a stream of messages with no structured lifecycle.

## Pickle Rick implementation
**`extension/src/bin/mux-runner.ts`** (11,339 LOC) — the outer loop runner:
- Context-clearing outer loop: each iteration clears the agent's context (via tmux pane reset in the current implementation) and re-spawns the worker with a fresh prompt.
- Phase transitions: the runner advances through the 8-phase per-ticket lifecycle, with per-phase gate hooks, no-progress detection, breaker recovery, and re-spawn-resume.
- Dirty-tree salvage at phase boundaries (delegates to the salvage trio).
- **tmux coupling is light**: 23 total `tmux` string references across the entire 11,339-line file. The references are concentrated in: iteration log file naming (`tmux_iteration_${N}.log`), max-turns settings (`default_tmux_max_turns`), session-end activity logging (`mode: 'tmux'`), and the relaunch-crash detection path. The phase logic itself is tmux-independent.

**`extension/src/services/recovery-controller.ts`** (342 LOC) — the factored recovery state machine:
- `runRecoveryLadder` (line 166) — runs the ordered recovery ladder: commit-and-continue → fix-forward-trivial → execute-converged-plan → auto-split → escalate. Each rung is attempted at most once per call and appends a `RecoveryAttempt` to the ledger. A rung whose adapter throws records a `failed` attempt and the ladder advances (INV-RUNG-ERROR-CONTAINED: a throw can never yield `advanced`, so no orphaned half-commit can ride to Done).
- `classifyRecoveryTaxonomy` (line 227) — classifies the recovery evidence into a taxonomy (`treeDirty` / `planConvergedUncommitted` / `noWorkProduced`) to select the appropriate ladder entry point.
- `isConvergedPlanEligible` (line 240) — checks whether an approved plan + artifacts exist (the R-ORSR-3 converged-plan execution seam).
- `parsePlanPhases` (line 264) — parses authored `## Phase N — Title` blocks (each with an optional `**Verify:** \`cmd\`` line) from an approved plan's markdown. Blocks without a parseable header are skipped; a block with no verify command yields `verify: null`.
- `executePhaseLoop` (line 323) — executes the approved plan one Phase at a time: each phase that runs ok is committed immediately (one fix per commit, bounding cost by Phase count). The FIRST phase whose `executePhase` or `commitPhase` returns not-ok stops the loop — phases `0..committed-1` are already committed, the failing phase is not, and `{ ok:false }` propagates so the caller never marks the ticket Done (R-ORSR-3 partial-failure contract). An empty plan is `{ ok:false }`.
- `ReExecutionSeam` (line 293) — DI seam for the clean-tree implement pass (AC-GA-REC-1). The adapter receives the RAW plan_*.md path (never the parsed PlanPhase[], which is verify-only) and returns whether an implement pass produced a diff. Timeout is surfaced as `{ ok: false, timedOut: true }` so the ladder escalates to `recovery_exhausted`.

The controller is dependency-injected: every side-effect (armed gate, commit, remediator spawn, converged-plan execution, ledger append) is a callback. This keeps the invariants testable with a scripted worker and keeps `mux-runner.ts` the sole owner of the concrete adapters.

## Contract
The phase machine is the 8-phase per-ticket lifecycle that drives a ticket from In Progress to Done (or Failed). It:
1. **Clears context** between phases: each phase starts with a fresh agent context (no carry-over of stale state from the previous phase).
2. **Runs per-phase gates**: after each phase, the convergence gate runs; a failing gate triggers the recovery ladder.
3. **Detects no-progress**: the circuit breaker tracks progress across iterations; a no-progress streak trips the escalation ladder.
4. **Recovers via the ladder**: `runRecoveryLadder` attempts commit-and-continue → fix-forward-trivial → execute-converged-plan → auto-split → escalate, in order.
5. **Re-spawns on crash**: the re-spawn-resume mechanism resumes the ticket after a worker crash, with the dirty tree salvaged first.
6. **Salvages at boundaries**: dirty-tree salvage runs before any fail/cancel/relaunch to prevent data loss.

**Invariants:**
- Context is cleared between phases (no stale state carry-over).
- The recovery ladder is ordered: each rung is attempted at most once per call, in order.
- A rung throw is contained as a not-ok step (INV-RUNG-ERROR-CONTAINED) — a throw can never yield `advanced`.
- Partial failure in `executePhaseLoop` propagates `{ ok:false }` — the caller never marks the ticket Done when a phase failed (R-ORSR-3).
- An empty plan is `{ ok:false }` — nothing to execute is an honest failure, not a silent pass.
- The `ReExecutionSeam` receives the RAW plan path, never the parsed `PlanPhase[]` (which is verify-only and carries nothing implementable).

**Failure modes:**
- Phase gate fails → recovery ladder runs; if exhausted, ticket goes to `recovery_exhausted` (honest terminal, not `closer_handoff_terminal`).
- Worker crashes → dirty-tree salvage + re-spawn-resume.
- No work produced (zero output at timeout) → `fall_through` to the existing `oversized_no_progress` / terminal Failed-flip path.
- Converged plan execution times out → `{ ok: false, timedOut: true }` → ladder escalates to `recovery_exhausted`.

## Evaluation
Pickle Rick is strictly better. Omnigent has no phase concept — its sessions are unstructured. Pickle Rick's `mux-runner.ts` is large (11,339 LOC) but the recovery state machine is already factored into `recovery-controller.ts` (342 LOC) with full DI seams, making the port tractable. The tmux coupling is light (23 references in 11,339 lines) and concentrated in delivery-layer concerns (log naming, max turns, pane management), not in the phase logic itself. The PRD (§3.6) confirms: "8-phase per-ticket lifecycle. Context clearing between phases."

## §2.2.1 Finding
ADOPT — "mux-runner.ts (11,339 LOC) is only lightly tmux-coupled — ~23 tmux references in the whole file; the recovery state machine is already factored into recovery-controller.ts. The phase machine ports cleanly; tmux is a delivery layer." Verified: `mux-runner.ts` is 11,339 LOC with 23 total `tmux` string references. `recovery-controller.ts` is 342 LOC with `parsePlanPhases` (line 264), `executePhaseLoop` (line 323), `ReExecutionSeam` (line 293), `runRecoveryLadder` (line 166), `classifyRecoveryTaxonomy` (line 227), `isConvergedPlanEligible` (line 240). The recovery state machine is fully DI'd with no tmux dependency.

## Decision: port
Port the Pickle Rick phase machine into Rickgent's TS lifecycle. Refactor into TS, replace tmux with Omnigent one-shots. Start from `recovery-controller.ts`, not from a blank file.

## Reasoning
The phase machine is the lifecycle spine of Rickgent — it drives each ticket through its phases, clears context between them, recovers from failures, and decides when a ticket is Done or Failed. Omnigent has no equivalent; its sessions are unstructured request/response with no phase concept, no context clearing, and no recovery ladder.

The port strategy starts from `recovery-controller.ts` (342 LOC), which is already the factored, DI'd, tmux-free recovery state machine. This is the foundation:
- **`orchestrator/src/core/phase.ts`** gets the pure recovery decisions: `runRecoveryLadder` (the ordered ladder logic), `classifyRecoveryTaxonomy`, `isConvergedPlanEligible`, `parsePlanPhases`. These are pure functions over evidence and plan markdown — no spawns, no git mutations.
- **`orchestrator/src/lifecycle/phase.ts`** gets the loop runner: `executePhaseLoop` (with the `ReExecutionSeam` and `ExecutePhaseLoopDeps` adapters), the context-clearing outer loop, the per-phase gate hooks, the no-progress detection integration (circuit breaker), the re-spawn-resume mechanism, and the dirty-tree salvage invocation at boundaries. The concrete adapters (armed gate, commit, remediator spawn, converged-plan execution) are wired here, calling the core for every judgment.

The tmux references (23 total) are replaced as follows:
- Iteration log naming (`tmux_iteration_${N}.log`) → Omnigent session log paths.
- Max turns (`default_tmux_max_turns`) → Omnigent one-shot turn limits.
- Session-end activity logging (`mode: 'tmux'`) → `mode: 'omnigent'`.
- Relaunch-crash detection → Omnigent process exit code + timeout detection.

The `ReExecutionSeam` DI pattern is preserved: the lifecycle layer owns the concrete implement-pass spawn (via `omnigent run` one-shots), and the core owns the decision of whether to execute, which phase to execute, and whether the result is acceptable. The R-ORSR-3 partial-failure contract (a failed phase stops the loop, phases `0..committed-1` are kept, the failing phase is not, and `{ ok:false }` propagates) is preserved verbatim.

The INV-RUNG-ERROR-CONTAINED invariant (a throw in any ladder rung is contained as a not-ok step, never yielding `advanced`) is preserved: `safeStep` wraps every adapter call in a try/catch that returns `false` on throw. This prevents an orphaned half-commit from riding to Done when an adapter crashes mid-operation.

Starting from `recovery-controller.ts` rather than a blank file is the key insight: the recovery state machine is already factored, already DI'd, already tmux-free, and already tested with scripted workers. The port is a transport-layer swap (tmux → Omnigent one-shots) plus a core/lifecycle split, not a rewrite.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/spawn.py:118-130`; `pickle-rick-claude/extension/src/services/recovery-controller.ts:166,227,240,264,293,323`
- **Notes:** The Pickle Rick phase-machine evidence checks out, but the file provides no Omnigent file:line citation for the "generic session, no phases" side of the comparison.
- **Date:** 2026-07-12
