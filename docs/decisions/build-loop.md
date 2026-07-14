# Decision: Build Loop (B1 / M3)

## Component
`rickgent build <prd>`, `rickgent build --resume`, `rickgent pipeline <prd>` — the
autonomous PRD → PR lifecycle that decomposes a PRD into tickets and drives each
through the real Dispatcher, absorbing failures without human interaction.

## Implementation

- **`orchestrator/src/lifecycle/prd-parse.ts`** — tolerant markdown decomposition
  into the `PrdInput` the verdict core validates plus ≥1 `TicketPlan` (each ticket
  carries the declared paths that scope its dispatch). It performs NO validation;
  `evaluatePrd` remains the single PRD oracle.
- **`orchestrator/src/lifecycle/build.ts`** — `runBuild` / `runPipeline` /
  `runCleanup`. Every Done is the terminal `completed` state of a real
  `Dispatcher.dispatch`, which is only reachable through the completion oracle
  (`evaluateCompletion`, caller `dispatch.completion`). The build never assigns
  Done by any other path.
- **`orchestrator/src/lifecycle/pr-flow.ts`** — the merge-gate PR flow. The narrow
  `git push origin <feature>` and `gh pr create` are BOTH evaluated through the
  single `autonomous_pr_flow` Python policy (invoked in-process via `python3`),
  not a second TS copy of the whitelist. Any evaluation failure fails CLOSED to
  DENY.

## Gates and interventions

The full gated pipeline enforces these gates in order, per the hands-off NFR
("zero required human interventions between the gates; failures route to
salvage/breaker; human-gate hits are counted, target 0"):

1. **PRD gate** — `evaluatePrd`. Invalid PRD → record intervention, exit non-zero.
2. **Plan gate** — decomposition. Zero tickets → record intervention, exit non-zero.
3. **Policy attachment gate (B4)** — before any dispatch, verify the manager +
   worker bundles attach the full required policy set via the omnigent static
   parser. Missing attachment → record intervention, exit non-zero (fail closed).
4. **Model routing gate (B8)** — the Python `select_model` router selects a
   harness/model/vendor from the live roster before each dispatch. Empty roster
   or cost-gate DENY → no dispatch (fail-closed).
5. **Evidence-based dispatch gate (B2)** — every dispatch reaches `completed`
   only through the completion oracle (`evaluateCompletion`) with all four
   evidence conditions (DB session, transcript, in-scope git delta, oracle pass).
6. **Salvage/breaker gate (B6)** — a dispatch failure is absorbed by the circuit
   breaker + salvage executor. The run continues non-interactively.
7. **Conformance gate (citadel)** — after implementation, runs each acceptance
   criterion's `verifyCommand` against the working repo. A failing AC is absorbed
   (salvage disposition recorded), not a human intervention.
8. **Deslop gate (szechuan)** — after conformance, scans changed files for
   obvious slop patterns (TODO, FIXME, console.log, debugger, eval). Findings
   are absorbed (salvage disposition recorded), not human interventions.
9. **Merge gate** — create the PR feature branch and issue `gh pr create`, gated
   by `autonomous_pr_flow`. When autonomous PR flow is enabled (default) and the
   policy ALLOWs the narrow own-branch shape, the PR is opened autonomously with
   zero interventions. When autonomous PR flow is disabled
   (`--no-autonomous-pr` / `RICKGENT_AUTONOMOUS_PR_FLOW=0`) or the policy will
   not grant the push, the merge gate is a **human gate**: it records exactly one
   intervention and exits non-zero rather than prompting.

Between the plan gate and the merge gate the loop is strictly non-interactive: a
dispatched ticket that does not reach `completed` is **absorbed** — the circuit
breaker records the iteration and the salvage executor records a durable
disposition (`.rickgent/salvage-dispositions.jsonl`) — and the run continues. It
never prompts a human or prints a "run this yourself" instruction. A ticket
failure is NOT an intervention.

The conformance and deslop gates are observable in the build report output
(`build: conformance gate — N/M ACs passed`, `build: deslop gate — checked N
file(s), M finding(s)`) so the E2E test (VAL-E2E-001..004) can verify each named
gate is live. They are skippable via `RICKGENT_SKIP_CONFORMANCE=1` and
`RICKGENT_SKIP_DESLOP=1` (test-only controls for the distinctness assertion
VAL-E2E-004); in production these are never set.

Interventions are appended to `.rickgent/interventions.jsonl`; `countInterventions`
reads the durable count (target 0 for a fully autonomous run).

## Resume and cleanup

- **`--resume`** reconstructs state from the ledger + git via `reconcile`. Tickets
  reconcile recovers as Done are skipped (not re-dispatched); only the unfinished
  tickets are dispatched. This is the killed-run continuation path.
- **`pipeline`** runs the full build then the **cleanup chain**: an orphan-reaper
  sweep (`reapOrphanedWorkerProcs(detectBackend())`) followed by a `reconcile` that
  rebuilds the registry from ledger + git truth.

## Invariants preserved
- Single oracle: Done routes only through `evaluateCompletion`; no parallel verdict.
- Single PR-flow authority: the merge gate uses the same `autonomous_pr_flow`
  policy that gates worker pushes (A-SEC-1), not a duplicated matcher.
- Fail closed: PR-flow evaluation errors and disabled autonomous PR flow become a
  human gate (non-zero exit + recorded intervention), never an ungated push.
- Owned-paths-only staging via the existing salvage executor (array-argv, `--`).

## Fixture harness
The build ACs (VAL-BUILD-001..008) are validated with the deterministic fixture
omnigent extended with a prompt-driven mode (`FIXTURE_MODE=prompt`): each dispatch
carries a per-ticket prompt naming the ticket's declared path, so one env config
drives a multi-ticket build where `FIXTURE_FAIL_PATHS` selects the tickets that
fail (leaving a salvageable uncommitted delta) and the rest complete with a DB
session + transcript + committed in-scope delta. A fixture `gh` records the
`gh pr create` invocation to `FAKE_GH_LOG`.
