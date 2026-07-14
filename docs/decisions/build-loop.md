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

Three gates, per the hands-off NFR ("zero required human interventions between
the three gates; failures route to salvage/breaker; human-gate hits are counted,
target 0"):

1. **PRD gate** — `evaluatePrd`. Invalid PRD → record intervention, exit non-zero.
2. **Plan gate** — decomposition. Zero tickets → record intervention, exit non-zero.
3. **Merge gate** — create the PR feature branch and issue `gh pr create`, gated by
   `autonomous_pr_flow`. When autonomous PR flow is enabled (default) and the
   policy ALLOWs the narrow own-branch shape, the PR is opened autonomously with
   zero interventions. When autonomous PR flow is disabled (`--no-autonomous-pr`
   / `RICKGENT_AUTONOMOUS_PR_FLOW=0`) or the policy will not grant the push, the
   merge gate is a **human gate**: it records exactly one intervention and exits
   non-zero rather than prompting.

Between the plan gate and the merge gate the loop is strictly non-interactive: a
dispatched ticket that does not reach `completed` is **absorbed** — the circuit
breaker records the iteration and the salvage executor records a durable
disposition (`.rickgent/salvage-dispositions.jsonl`) — and the run continues. It
never prompts a human or prints a "run this yourself" instruction. A ticket
failure is NOT an intervention.

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
