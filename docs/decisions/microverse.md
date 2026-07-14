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

## B5 finalization — convergence semantics (retire "N improvements = converged")

Architecture §6.1 delegates the convergence definition to this doc. B5 adopts a
**plateau / diminishing-delta + target-threshold** definition and RETIRES the
Mission-1 heuristic "N consecutive improvements = converged" (which halted a
still-climbing metric and left gains on the table). The FOM discipline
"convergence vs attrition" requires distinguishing *still-climbing* from *done*.

### Finalized parameters

| Parameter | Symbol | Default | Meaning |
|---|---|---|---|
| Diminishing-delta epsilon | `epsilon` | `1.0` | An improvement delta strictly below epsilon counts as "diminishing". |
| Plateau window | `window` (N) | `3` | Number of most-recent accepted-baseline improvement deltas inspected. |
| Target threshold | `target` | `null` | Optional metric target; reaching it converges regardless of delta size. |
| Direction | `direction` | `"higher"` | `"higher"` = larger is better; `"lower"` = smaller is better. |
| Attrition/stall limit | `stallLimit` | `3` | Consecutive non-improving (delta ≤ 0) iterations → attrition/salvage. |

### Decision rule (`classifyConvergence`, evaluated over the accepted-baseline score series)

Improvement deltas are direction-aware: for `higher`, `delta = cur - prev`; for
`lower`, `delta = prev - cur` (positive = improvement). Evaluated in order:

1. **Target reached** → `converged` (via `target`). If `target` is set and the
   latest score meets it (`>= target` for higher, `<= target` for lower), the
   run is converged **even when the deltas are still large** (VAL-MICRO-008).
2. **Attrition/stall** → `stalled`. If the last `stallLimit` deltas are each
   `≤ 0` (no improvement), the run is attrition and routes to **salvage**, never
   convergence (VAL-MICRO-006).
3. **Plateau / diminishing returns** → `converged` (via `plateau`). If the last
   `window` deltas are each `< epsilon` (and, having passed step 2, at least one
   is a positive improvement), the metric has plateaued and is converged
   (VAL-MICRO-004).
4. Otherwise → `improving` (still climbing; NOT converged). A monotonic
   still-improving series such as `[60, 70, 80]` with `target` unmet is
   therefore **NOT converged** (VAL-MICRO-004/005).

### AC-6 expected-value update (permitted by PRD §7.1/§10.5)

The retired Mission-1 expectation `run_simulated([60,70,80]) → converged == true`
is replaced: `[60,70,80]` (three large improvements, no target) is **NOT
converged** (still climbing). `microverse.test.ts` is updated to pin the new
expected values (plateau converges, target converges, `[60,70,80]` does not) and
no test still asserts the retired "three improvements = converged" semantics.

## B5 real convergence loop (retire `runSimulated`-only)

`runSimulated` remains only as a pure driver for the convergence-decision unit
tests. The **live** loop is `MicroverseLoop.run()` (lifecycle layer), which
drives real git + real worker processes + a real metric command, honoring the
§8 invariants (git-tree-truth > claims; owned-paths-only array-argv staging; no
global reset/checkout):

- **Measure** the metric each iteration by executing the real `metricCommand`
  in the target repo and parsing its numeric stdout.
- **Dispatch** a per-iteration worker process under a hard **deadline**. A
  deadline breach **kills the worker process group** (SIGTERM → grace → SIGKILL)
  and **salvage-commits only the in-scope dirty work** (owned-paths-only via the
  salvage executor's `execFileSync("git", ["add","--", path])` staging) — dirty
  work is neither dropped nor committed with `git add -A`/out-of-scope files
  (VAL-MICRO-002).
- **Classify** against the accepted baseline: an **improving** iteration commits
  its in-scope owned work and **advances the baseline ref** so the next
  iteration measures against the new baseline (VAL-MICRO-009); a **regressing**
  iteration performs a **scoped rollback** (`git checkout -- <ownedPath>` +
  `git clean -f -- <ownedPath>` per owned path) that restores only the
  iteration's in-scope owned paths and **preserves the baseline ref** while
  leaving out-of-scope/untracked files intact — never `git reset --hard` or
  `git checkout -- .` (VAL-MICRO-001/010).
- **Attrition/stall** (delta ≤ 0 for `stallLimit` iterations) routes to
  **salvage**, distinctly from convergence (VAL-MICRO-006).
- **Record every iteration** into the circuit breaker via `recordIterationResult`
  so `canExecute` is live and a tripped breaker halts the loop (VAL-MICRO-007).
- The **final report is derived from `git log`** (commits/deltas that actually
  landed on owned paths between the initial baseline and HEAD), so a worker that
  emits a false success token but produces no git delta records no improvement
  and no commit (VAL-MICRO-003).

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `extension/src/bin/microverse-runner.ts:3407-3435,3637-3665` implements metric classification and scoped rescue; Omnigent search found no convergence lifecycle.
- **Notes:** The TS split preserves autonomous convergence.
- **Date:** 2026-07-12

## B5 addendum countersign

- **Decision owner:** B5 worker (rickgent-engineer)
- **Scope:** Finalized epsilon=1.0 / N=3 / target=null defaults, plateau+target
  convergence rule, attrition routing, and the live `MicroverseLoop` semantics
  above. AC-6 expected values updated in `microverse.test.ts`.
- **Date:** 2026-07-14
