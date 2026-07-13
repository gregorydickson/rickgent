# Decision: Microverse (Metric Convergence Loop)

## Component
§2 matrix row: "Microverse (metric convergence)" — Omnigent has nothing; Pickle Rick has the full loop.

## Omnigent implementation
Nothing. Omnigent provides generic sessions (`sys_session_send`, `omnigent run` one-shots) but no metric convergence loop, no iteration measurement, no stall detection, no rollback, no LLM judge, and no auto-rescue. There is no equivalent of a microverse state machine or per-iteration gate baseline.

## Pickle Rick implementation
Two files form the microverse subsystem:

**`extension/src/bin/microverse-runner.ts`** (4,674 LOC, 15 exports) — the loop runner:
- `executeMainLoop` (line 4367) — the outer convergence loop: measure → classify → commit/rollback → update state → check convergence → repeat.
- `measureAndClassifyIteration` (line 3407) — measures the current metric, classifies the iteration outcome (accepted, stall, amnesiac, regression), and updates the runner state.
- `autoRescueDirtyTree` (line 3637) — worker-timeout rescue: partitions the dirty tree into owned vs. foreign paths and routes through `dirty-tree-salvage.ts` to stage only attributable work.
- `buildJudgePrompt` (line 1613) — constructs the LLM judge prompt for subjective metric evaluation.
- Also exports: `runPerIterationGateHook`, `runInterfaceChangeSweep`, `handleWorkerManagedIteration`, `measureMetric`, `measureLlmMetric`, `measureLlmMetricWithBackoff`, `parseLlmJudgeOutput`, `extractScore`, `classifyStall`, `classifyNoCommitExit`, `handleNoCommitStall`, `handleIterationOutcome`, `executeGapAnalysis`, `writeFinalReport`, `buildMicroverseHandoff`, `classifyAnatomyNonConvergence`, `classifyComplexityRegression`.

**`extension/src/services/microverse-state.ts`** (497 LOC, 14 exports) — the pure state machine:
- `isConverged` (line 390) — returns true when `stall_counter >= stall_limit` OR the current score has reached the `convergence_target` (direction-aware: `lower` vs `higher`).
- `recordIteration` (line 258) — appends an iteration entry to the accepted/stall history.
- `resolveStallLimit` (line 488) — resolves the stall limit for a given metric type from settings.
- `recordAmnesiacExit` (line 300) — records an amnesiac exit (worker produced output but no commit) into the state.
- Also exports: `createMicroverseState`, `recordStall`, `clearAmnesiacExits`, `recordFailedApproach`, `findLastAcceptedEntry`, `getLastAcceptedScore`, `classifyFailure`, `compareMetric`, `writeMicroverseState`, `readMicroverseState`, `updateViolationLedger`, `generateViolationId`, `assertMicroverseStateShape`.

## Contract
The microverse is a metric convergence loop that:
1. **Measures** a key metric per iteration (deterministic: test count, LOC, build time; or LLM-judged: subjective quality).
2. **Classifies** the iteration: accepted (score improved or held), stall (no progress), amnesiac (no commit), regression (score dropped below accepted baseline).
3. **Commits or rolls back**: accepted iterations are committed; regressions are rolled back to the last accepted HEAD.
4. **Updates state**: `recordIteration` / `recordStall` / `recordAmnesiacExit` maintain the history that drives convergence detection.
5. **Checks convergence**: `isConverged` returns true when the stall limit is exhausted OR the convergence target is met.
6. **Auto-rescues dirty trees**: `autoRescueDirtyTree` partitions uncommitted work and stages only attributable paths before a worker timeout kills the iteration.

**Invariants:**
- A regression is never accepted — the accepted baseline is monotonically non-worsening.
- Stall counter only resets on genuine progress (tree-changed, not empty-commit-churn — R-DEFCHURN).
- The LLM judge has a timeout and spawn-failure classification path; a judge failure never crashes the loop.
- Per-iteration gate baseline is refreshed before each gate run (delegates to `convergence-gate.ts`).

**Failure modes:**
- Judge backend unavailable → classified error, loop continues with deterministic metric fallback.
- Worker timeout with dirty tree → `autoRescueDirtyTree` stages owned paths, anchors foreign dirt to salvage ref.
- Rate limit hit → `handleRateLimit` parks the iteration.
- No-commit stall → `handleNoCommitStall` escalates through the recovery ladder.

## Evaluation
Pickle Rick is strictly better for Rickgent's goals. Omnigent has no convergence loop at all — it cannot measure, classify, or detect convergence. The microverse is the core differentiator that makes Rickgent an autonomous optimization engine rather than a single-shot agent. The state machine (`microverse-state.ts`) is already pure TypeScript with no tmux coupling — it ports directly into `orchestrator/src/core/`. The runner (`microverse-runner.ts`) is tmux-coupled only in its worker dispatch (tmux iteration logs, tmux max turns), which maps cleanly to Omnigent one-shots.

## §2.2.1 Finding
ADOPT — "All named runtime artifacts exist with the claimed exports: microverse-runner.ts (4,674 LOC, 15/15 exports), microverse-state.ts (497 LOC, 14/14)." Verified: `executeMainLoop` (line 4367), `measureAndClassifyIteration` (line 3407), `autoRescueDirtyTree` (line 3637), `buildJudgePrompt` (line 1613) in the runner; `isConverged` (line 390), `recordIteration` (line 258), `resolveStallLimit` (line 488), `recordAmnesiacExit` (line 300) in the state module. All 15 runner exports and 14 state exports confirmed present.

## Decision: port
Port the Pickle Rick microverse into Rickgent's TS lifecycle runtime; verdict decisions (convergence check, stall classification) call the TS verdict core; replace tmux worker dispatch with Omnigent one-shots.

## Reasoning
The microverse is the heart of Rickgent's autonomous optimization capability. Omnigent provides no equivalent — its sessions are generic request/response with no iteration, measurement, or convergence semantics. Pickle Rick's implementation is mature (4,674 + 497 LOC), battle-tested through the reliability backlog, and already separates pure state logic (`microverse-state.ts`) from I/O-coupled runner logic (`microverse-runner.ts`).

The port strategy splits cleanly along the §10.9 language boundary:
- **`orchestrator/src/core/`** gets the pure state machine: `isConverged`, `recordIteration`, `recordStall`, `recordAmnesiacExit`, `resolveStallLimit`, `compareMetric`, `classifyFailure`, `classifyStall`, `classifyNoCommitExit`. These are pure functions over JSON state — no spawns, no git mutations, no I/O.
- **`orchestrator/src/lifecycle/microverse.ts`** gets the loop runner: `executeMainLoop`, `measureAndClassifyIteration`, `handleIterationOutcome`, `handleNoCommitStall`, `executeGapAnalysis`, the LLM judge integration, and `autoRescueDirtyTree`. The tmux-specific dispatch (iteration log paths, max turns, pane management) is replaced with `omnigent run` one-shots and synchronous process joins (§10.10).

The per-iteration convergence gate delegates to the ported `convergence-gate.ts` verdict core (see `convergence-gate.md`). The circuit breaker integration delegates to the ported `circuit-breaker.ts` verdict core (see `circuit-breaker.md`). The dirty-tree rescue delegates to the ported salvage executor (see `salvage.md`).

The R-DEFCHURN lesson (empty-commit churn burns the budget without tripping the breaker) is preserved: `detectProgress` in the circuit breaker compares tree SHAs, not just commit SHAs, so empty commits do not count as progress. This invariant must survive the port.
