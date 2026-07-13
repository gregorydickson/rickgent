# Decision: Cronenberg (Meta-Router)

## Component
§2 matrix row "Cronenberg (meta-router)" (lifecycle components — Pickle Rick likely wins).

## Omnigent implementation
Nothing. A grep for `cronenberg` over `/Users/gregorydickson/loanlight/pickle-rick/omnigent` returns no matches. Omnigent has no task-shape classifier, no meta-router that maps a build request onto a pipeline shape, and no deterministic decision matrix for cleanup-chain selection. Omnigent's `sys_advise_models` is a model picker, not a pipeline router — it picks a harness for a single dispatch, not a sequence of skills. The routing intelligence has to be supplied entirely by Rickgent.

## Pickle Rick implementation
Cronenberg is a deterministic meta-router: given a build/implement request, it picks the right pickle metaphor (pipeline/tmux/microverse/council-of-ricks) and the right cleanup chain (citadel/anatomy-park/szechuan-sauce), with an optional refinement pre-pass. It is **prompt-skill-driven** — the decision matrix lives in the skill file, not in a runtime module. "Deterministic — same signals → same plan, no LLM judgment inside the matrix" (`cronenberg.md:5`).

**Prompt skill:**
- `.claude/commands/cronenberg.md` — "Meta-router: explicit `/cronenberg` picks the right pickle metaphor + cleanup chain for a build/implement request." (`cronenberg.md:1-3`).

**When to invoke** (`cronenberg.md:5-8`): user explicitly types `/cronenberg`. Never auto-trigger; persona's existing Routing rules are unchanged.

**When NOT to invoke** (`cronenberg.md:10-14`): user already named a skill (`/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`, `/citadel`, `/anatomy-park`, `/szechuan-sauce`) — use that directly. One-liner / typo / single-file fix → just do it. Pure question → answer directly.

**Step 1: Parse Flags** (`cronenberg.md:16-24`): `--dry-run` (print plan and stop), `--no-followups` (skip cleanup chain), `--no-refine` (force-skip refinement pre-pass), `--refine` (force-include refinement pre-pass). Everything else → `FORWARD` (passed through verbatim to the chosen metaphor and its followups). If `FORWARD` has no task description AND no PRD detected → "Cronenberg needs a task or prd.md. Add a task or run /pickle-prd first." Stop.

**Step 2: Signals** (`cronenberg.md:26-42`) — the deterministic signal set:

| Signal | Definition |
|---|---|
| `PRD_PRESENT` | `prd.md`/`PRD.md` in cwd OR most recent session has one (`get-session.js`) |
| `MEASURABLE_METRIC` | TASK/PRD names a measurable target: coverage %, latency budget, lint count, error rate, bundle size, "improve X to Y" |
| `TICKET_COUNT` | If `prd_refined.md` exists, count tickets; else infer from TASK verbs (1 / 2-3 / 4+) |
| `MULTI_STAGE` | TASK lists 2+ of: refine, build, optimize, cleanup, deslop, szechuan, anatomy-park, review |
| `STACK_REVIEW` | TASK is review-focused AND mentions PR stack, branch chain, `gt log`, graphite stack |
| `SUBSYSTEM_TOUCHES` | distinct top-level dirs implied by TASK + PRD file mentions (≥2 if multiple modules named) |
| `INTERACTIVE_HINT` | TASK contains "interactive", "watch me", "step through", or `FORWARD` has `--interactive` |
| `ALREADY_REFINED` | `prd_refined.md` or `refinement_manifest.json` exists in cwd OR most recent session |
| `AC_SHAPE_SMELL` | PRD body contains an AC heading whose body has ≥3 bullets each naming a distinct endpoint/handler/method, all repeating the same predicate, with no universal quantifier ("all", "every", "for any") in the AC headline (same heuristic citadel T11.7 uses) |
| `MACHINE_UNCHECKABLE_AC` | PRD body has any AC bullet that names no concrete artifact: no API path, no status code, no enum value, no symbol identifier, no numeric threshold, no file path |
| `CITADEL_RISK` | True when (`PRD_PRESENT` AND `TICKET_COUNT ≥ 3`) OR TASK mentions "conformance", "acceptance criteria", "spec compliance", or "audit against PRD" OR (`SUBSYSTEM_TOUCHES ≥ 2` AND `PRD_PRESENT`) |
| `REFINE_NEEDED` | Composite decision — see Step 2.5 |

**Step 2.5: Refine Decision** (`cronenberg.md:44-58`) — first-match-wins matrix:

| If | → |
|---|---|
| `--no-refine` flag passed | `REFINE_NEEDED = false` (user override) |
| `PRD_PRESENT = false` | `REFINE_NEEDED = false` (nothing to refine — TASK-only request) |
| `ALREADY_REFINED = true` AND no `--refine` flag | `REFINE_NEEDED = false` (don't redo) |
| `--refine` flag passed | `REFINE_NEEDED = true` (user override) |
| `AC_SHAPE_SMELL = true` OR `MACHINE_UNCHECKABLE_AC = true` | `REFINE_NEEDED = true` (PRD has known refinement-fixable issues) |
| `TICKET_COUNT ≥ 3` OR `SUBSYSTEM_TOUCHES ≥ 2` OR `MULTI_STAGE = true` | `REFINE_NEEDED = true` (multi-shape work benefits from atomic decomposition) |
| Single-file scope: `TICKET_COUNT = 1` AND `SUBSYSTEM_TOUCHES ≤ 1` AND no smells | `REFINE_NEEDED = false` (refinement overhead exceeds benefit) |
| Default | `REFINE_NEEDED = true` (when in doubt, refine) |

**Suppression rule**: if the chosen metaphor is `/pickle-pipeline`, `REFINE_NEEDED` is forced to `false` — pipeline chains refinement internally as Step 0 of its skill prompt; running it twice would double-spend tokens and overwrite the manifest.

**Step 3: Pick Metaphor** (`cronenberg.md:60-68`) — first-match-wins:

| If | → |
|---|---|
| `STACK_REVIEW` | `/council-of-ricks` |
| `MEASURABLE_METRIC` and TASK reads "optimize/improve/reduce X to Y" | `/pickle-microverse` |
| `MULTI_STAGE` | `/pickle-pipeline` |
| `INTERACTIVE_HINT` | `/pickle-tmux` |
| `TICKET_COUNT ≥ 3` | `/pickle-tmux` |
| Default | `/pickle-tmux` |

**Step 4: Pick Followups** (`cronenberg.md:70-82`) — skipped if `--no-followups` OR chosen metaphor is `/pickle-pipeline` (chains citadel + anatomy-park + szechuan-sauce internally) OR chosen metaphor is `/pickle-microverse` or `/council-of-ricks` (orthogonal to cleanup). Otherwise append in order: `CITADEL_RISK` → `/citadel --prd <prd_path>`; `SUBSYSTEM_TOUCHES ≥ 2` → `/anatomy-park`; expected diff ≥ 500 LOC OR ≥ 10 files OR TASK mentions "cleanup / deslop / refactor sweep" → `/szechuan-sauce`.

**Step 5: Print Plan** (`cronenberg.md:84-92`) — prints signals, refine decision (with trigger reason), and the numbered plan.

**Step 6: Execute or Stop** (`cronenberg.md:94-104`): `--dry-run` → print plan and stop. Default: (1) if `REFINE_NEEDED = true`, invoke `/pickle-refine-prd` in-session and wait for `TASK_COMPLETED`; (2) invoke the chosen metaphor (all metaphors are tmux-launching and return `TASK_COMPLETED` immediately after detaching tmux); (3) do NOT auto-chain followups — they would race the in-progress build — instead print the followup commands ready to copy; (4) output `<promise>TASK_COMPLETED</promise>`.

**Logging** (`cronenberg.md:106`): `node ~/.claude/pickle-rick/extension/bin/log-activity.js research "cronenberg → <refine?>+<metaphor>+<followups> (<refine reason>)"`.

The skill is 107 lines total. The entire decision matrix is deterministic — no LLM judgment inside the matrix. The same signals produce the same plan every time.

## Contract
Cronenberg mutates a build/implement request into the correct pipeline shape (metaphor + cleanup chain + optional refinement pre-pass).

**Invariants:**
- Deterministic: same signals → same plan. No LLM judgment inside the matrix.
- Never auto-triggered; only invoked when the user explicitly types `/cronenberg`.
- If the user already named a skill, use that skill directly — cronenberg does not override explicit skill selection.
- The refine decision is a first-match-wins matrix with a suppression rule: if the chosen metaphor is `/pickle-pipeline`, `REFINE_NEEDED` is forced to `false` (pipeline chains refinement internally).
- Followups are not auto-chained after a tmux-launching metaphor — they would race the in-progress build. The user is handed the followup commands to run after the build finishes.
- `--dry-run` prints the plan and stops without executing.
- The `AC_SHAPE_SMELL` and `MACHINE_UNCHECKABLE_AC` signals use the same heuristic citadel T11.7 uses, so cronenberg and citadel agree on what counts as a smelly AC.

**Failure modes:**
- No task and no PRD: "Cronenberg needs a task or prd.md. Add a task or run /pickle-prd first." Stop.
- Refinement pre-pass failure: stop and report; do not proceed to the chosen metaphor.
- Double-refinement: if the chosen metaphor is `/pickle-pipeline` and `REFINE_NEEDED` was not suppressed, the pipeline would re-refine and overwrite the manifest — the suppression rule prevents this.

## Evaluation
Pickle Rick is unambiguously the better source. Omnigent has no task-shape classifier and no pipeline router. The cronenberg skill is a pure decision matrix — deterministic, no LLM judgment — so it ports cleanly as both a Rickgent agent skill (for explicit `/cronenberg` invocation) and a TS router (for programmatic invocation from the `rickgent` CLI). The decision matrix is expressible as TS logic (the §2 matrix investigation question is answered: yes, the first-match-wins tables map directly to a TS function with ordered `if` checks). The signal definitions map to TS predicates over the PRD file and the task string. The only Pickle Rick-specific coupling is the metaphor names (`/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`) which become Rickgent phase names, and the `node ~/.claude/pickle-rick/extension/bin/log-activity.js` call which becomes a `rickgent` activity-log call.

## §2.2.1 Finding
No specific §2.2.1 finding for cronenberg — investigated fresh. The §2.2.1 validation pass did not enumerate the cronenberg skill. This decision file is the fresh investigation: the skill is 107 lines (`cronenberg.md:1-107`), prompt-driven, with a deterministic signal set (`cronenberg.md:26-42`), a first-match-wins refine decision matrix (`cronenberg.md:44-58`), a first-match-wins metaphor picker (`cronenberg.md:60-68`), and an ordered followup chain (`cronenberg.md:70-82`). The entire decision matrix is expressible as TS logic — no LLM judgment inside the matrix. All citations verified against HEAD `95f5c416`.

## Decision: port
PORT (Pickle Rick) — port as a Rickgent agent skill (for explicit `/cronenberg` invocation) plus a TS router (for programmatic invocation from the `rickgent` CLI).

## Reasoning
Cronenberg is a deterministic decision matrix with no LLM judgment inside. The decision is port, not mash — Omnigent has nothing to contribute.

The port has two surfaces:

1. **TS router** — the decision matrix ports into `orchestrator/src/lifecycle/cronenberg.ts` (or equivalent) as a pure TS function. The signal definitions become TS predicates: `PRD_PRESENT` checks for `prd.md` in cwd or the most recent session; `MEASURABLE_METRIC` regex-matches the task string for coverage %, latency budget, lint count, etc.; `TICKET_COUNT` counts tickets in `prd_refined.md` or infers from task verbs; `MULTI_STAGE` / `STACK_REVIEW` / `INTERACTIVE_HINT` / `AC_SHAPE_SMELL` / `MACHINE_UNCHECKABLE_AC` / `CITADEL_RISK` are string/predicates over the task and PRD. The first-match-wins tables (`cronenberg.md:44-58,60-68`) become ordered `if`/`else if` chains. The suppression rule (pipeline forces `REFINE_NEEDED = false`) is a guard at the end of the refine-decision function. The followup picker (`cronenberg.md:70-82`) becomes a TS function that returns an ordered list of phase names. The output is a `CronenbergPlan` type: `{ refine: boolean, refineReason: string, metaphor: string, followups: string[], forward: string }`.

2. **Agent skill** — the `.claude/commands/cronenberg.md` skill becomes a Rickgent agent skill for explicit `/cronenberg` invocation. The skill calls the TS router (via `rickgent cronenberg "<task>"`) to get the plan, then executes it: (1) if `refine`, invoke the refinement skill in-session and wait for completion; (2) invoke the chosen metaphor as an `omnigent run` one-shot, which **blocks until the build completes**; (3) **auto-chain the followups sequentially** once the one-shot returns. `--no-followups` suppresses the chain; `--dry-run` prints the plan and stops. The `--dry-run` / `--no-followups` / `--no-refine` / `--refine` flags map directly onto `rickgent cronenberg` CLI flags.

Adaptations:
- **Metaphor names** — `/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks` become Rickgent phase names (`tmux-loop`, `pipeline`, `microverse`, `cross-review`). The routing targets change but the routing logic does not.
- **Followup targets** — `/citadel`, `/anatomy-park`, `/szechuan-sauce` become `rickgent citadel`, `rickgent anatomy`, `rickgent szechuan`. The followup conditions (`CITADEL_RISK`, `SUBSYSTEM_TOUCHES ≥ 2`, expected diff ≥ 500 LOC OR ≥ 10 files) are preserved verbatim.
- **Logging** — `node ~/.claude/pickle-rick/extension/bin/log-activity.js research "cronenberg → ..."` becomes a `rickgent log activity` call.
- **tmux launch → blocking one-shot, and the do-not-auto-chain rule is DROPPED.** The "all metaphors are tmux-launching" assumption (`cronenberg.md:98`) is replaced by "all metaphors are Omnigent one-shot dispatching," and that change **inverts** the followup rule rather than preserving it.

  Pickle Rick forbids auto-chaining for a transport-specific reason: a tmux metaphor returns `TASK_COMPLETED` *immediately after detaching tmux* (`cronenberg.md:98`), so the build is still running when the command returns — a followup would race it. Omnigent's one-shot has the opposite shape. `omnigent run <agent> -p "<prompt>"` routes to `_run_one_shot` (`omnigent/chat.py:4017`, triggered at `chat.py:969-970`), which "sends a single prompt to a remote server and prints the final text" — it drives `asyncio.run(_main())` and awaits `_query_sessions_once`, so it **blocks until the turn completes** and signals completion via process exit. When the one-shot returns, the build is finished. There is nothing left to race.

  Retaining "do NOT auto-chain — print the commands for the user to copy" would therefore preserve a workaround for a constraint that no longer exists, and would do so at the cost of Rickgent's hands-off-execution goal: it converts a completed pipeline into a copy-paste prompt for a human. Rickgent auto-chains followups sequentially on one-shot exit, honoring the exit status (a non-zero exit halts the chain rather than compounding a failed build). `--no-followups` remains available for operators who want the plan without the chain.

The `AC_SHAPE_SMELL` heuristic stays shared with citadel (T11.7) — the same regex lives in both the TS router and the citadel audit runner, so cronenberg and citadel agree on what counts as a smelly AC. This invariant is preserved by keeping the regex in a shared `core/prd/ac-shape.ts` module that both the router and the citadel audit import.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** REJECTED
- **Spot-checks performed:** `.claude/commands/cronenberg.md:44-82` confirms the source matrices; `omnigent/server/smart_routing.py:1-72` confirms model, not pipeline, routing.
- **Notes:** Retaining “do not auto-chain” because one-shots are allegedly asynchronous contradicts the contract and `omnigent/chat.py:4017` synchronous process-exit path, breaking hands-off execution.
- **Date:** 2026-07-12

## Remediation

- **Status:** FIXED — countersign finding accepted.
- **Root cause:** The file carried Pickle Rick's do-not-auto-chain rule across to Rickgent by asserting "Omnigent one-shots are also asynchronous relative to the followups." They are not. Pickle Rick's rule exists because a tmux metaphor returns immediately *after detaching* (`cronenberg.md:98`) with the build still running. Omnigent's one-shot blocks to completion, so the premise for the rule evaporates in the new transport.
- **Change:** Do-not-auto-chain **dropped**. Followups now auto-chain sequentially once the one-shot returns, halting the chain on a non-zero exit; `--no-followups` opts out. Updated both the agent-skill step list and the tmux-launch adaptation note.
- **Verified against source:** `omnigent/chat.py:4017` (`_run_one_shot` — "send a single prompt … and print the final text"; drives `asyncio.run(_main())`, awaits `_query_sessions_once`, completes via process exit). Consistent with the §2.1.1 adoption recorded in `worker-dispatch.md`, which distinguishes the async in-session `sys_session_send` tool from the synchronous `omnigent run` CLI one-shot.
- **Decision unchanged:** port.
- **Impact:** Printing followup commands for a human to copy is hands-ON execution. This directly restores Rickgent's hands-off-execution goal.
- **Date:** 2026-07-12
