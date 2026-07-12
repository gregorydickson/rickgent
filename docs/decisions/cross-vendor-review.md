# Decision: Cross-Vendor Review

## Component
§2 matrix row — cross-vendor review (independent verification of an implementer's diff by a different-vendor sub-agent).

## Omnigent implementation
The "Polly pattern" lives in `omnigent/examples/polly/skills/cross-review/SKILL.md` — an example agent's skill, not a platform primitive. The skill defines the full procedure:

- Step 1: fetch the task's diff via `sys_os_shell("gh pr diff <pr>")` or `git -C .worktrees/<task_id> diff main...HEAD` (`SKILL.md:8-11`).
- Step 2: run deterministic gates (tests / lint / typecheck) first; re-dispatch the implementer to drive them green before involving the reviewer (`SKILL.md:13-16`).
- Step 3: dispatch a DIFFERENT-vendor sub-agent as reviewer — `claude_code`, `codex`, `opencode`, `cursor`, `hermes`, or `pi` — using a task-based title (`review-<task_slug>`, never the raw vendor name) via `sys_session_send(agent=..., title=..., args={purpose: "review", input: "<diff> + <contract>"})` (`SKILL.md:18-30`). The reviewer gets ONLY the diff + contract — never the implementer's transcript or worktree, so cross-vendor independence is preserved (`SKILL.md:56-57`).
- Step 4: the reviewer SURFACES issues; it does not fix them (`SKILL.md:31`).
- Step 5: for each blocking issue, add a fix-task to the registry and send the concrete fixes back to the SAME implementer conversation (reusing the original `agent` + `title` or `session_id` with `purpose: "implement"`) so the worker keeps its worktree/branch context; then loop to step 1 (`SKILL.md:32-38`).
- Step 6: when gates are green AND zero blocking issues, mark the PR ready in the registry (with its PR URL) and leave it for the human to merge — polly does NOT merge (`SKILL.md:39-41`).
- Step 7: escalate to the user if the contract can't be satisfied after a few loops (`SKILL.md:42-43`).

The skill notes that cross-review requires at least two AVAILABLE workers of different vendors (per polly's roster preflight); if only one vendor can review, it pulls in the human at the plan gate rather than dispatching a reviewer that can't boot (`SKILL.md:47-50`).

This skill is backed by Omnigent's generic orchestration substrate: `sys_session_send` (sub-agent dispatch with `agent`/`title`/`args`/`cost_budget`), `sys_read_inbox` (pull-mode drain of completed sub-agent reports), `sys_session_get_history` (debug only), and the policy engine that can enforce workflow rules on dispatch. None of these are cross-review-specific — they are the reusable substrate.

## Pickle Rick implementation
Pickle Rick ships `/council-of-ricks` — a manual, explicitly-invoked Graphite PR stack review loop. Defined in `pickle-rick-claude/.claude/commands/council-of-ricks.md`:

- Detect mode: `$ARGUMENTS` contains `--resume` → Review Round (Step 10+); otherwise → Setup (Steps 1-9, plus 9.5 Report) (`council-of-ricks.md:7-9`).
- Setup runs prerequisite + gate checks (`gt --version`, `tmux -V`, `CLAUDE.md` exists, lint passes, architectural lint rules exist, Graphite stack has >=1 non-trunk branch) (`council-of-ricks.md:13-23`).
- It is a STACK review, not a single-PR review: it enumerates branches via `gt log short --no-interactive` and sizes round count by stack diff LOC/files (`council-of-ricks.md:139-167`).
- Every round runs four phases: Phase A (historical context, serial main agent), Phase B (category team — B1 stack structure, B2 CLAUDE.md compliance, B3 contract discovery, B4 cross-branch, B5 test coverage, B6 security, B7 migration hygiene, B8 szechuan principles, B9 polish — parallel fan-out via `Agent` tool), Phase C (per-branch correctness + optional Codex adversarial sweep, parallel), Phase D (synthesis — false-positive pre-filter, confidence filter >= 80, dedupe, severity sort, trap-door consolidation, directive write) (`council-of-ricks.md:209-296`).
- Findings use the szechuan P0-P4 severity matrix + a confidence score (0/25/50/75/100); findings with `conf < 80` are dropped (`council-of-ricks.md:211-220`).
- The Council NEVER fixes code — it judges, synthesizes, and documents only; it writes `council-directive.json` + `council-directive.md` for the fixing agent (`council-of-ricks.md:5, 298-321`).
- Approval gate: `THE_CITADEL_APPROVES` fires only when `current_round >= min_iterations` AND the last two rounds were clean AND no unconditional category was skipped AND zero P0/P1 findings across COUNCIL + CODEX (`council-of-ricks.md:359-369`).
- The Codex adversarial subagent is optional (`--no-codex`); when enabled it walks branches sequentially (shared working tree → sequential checkout) and runs `codex-companion adversarial-review` per branch (`council-of-ricks.md:269-296`).
- A `PICKLE_COUNCIL_WORKFLOW` kill-switch routes Phases A-D through a single top-level Dynamic Workflow instead of the manual `Agent` fan-out (`council-of-ricks.md:299-310`).

Key contrast with the Polly pattern: Council of Ricks is (a) stack-scoped, not single-PR; (b) explicitly invoked by a human operator, not policy-enforced; (c) multi-category (9 B-categories + per-branch correctness + Codex), not just "diff + contract"; (d) confidence-scored with an 80 threshold and false-positive pre-filter; (e) writes a directive for a separate fixing agent, not a fix-loop back to the same implementer.

## Contract
What this component does: independently verify an implementer's diff using a different-vendor reviewer, so no implementer signs off on its own work. The reviewer reports blocking / non-blocking / suggestions against an acceptance contract; blocking issues become fix-tasks that loop back to the implementer until gates are green AND zero blocking issues remain.

Invariants:
- The reviewer's vendor MUST differ from the implementer's (cross-vendor independence is the whole point).
- The reviewer receives ONLY the diff + contract — never the implementer's transcript or worktree (independence is corrupted by shared context).
- The reviewer SURFACES issues; it never edits code. Only the implementer opens a PR.
- Review is a sub-agent that returns a structured report, not a transcript anyone reads through.
- At least two AVAILABLE workers of different vendors are required; if only one vendor can review, escalate to the human rather than dispatching a same-vendor reviewer.
- Deterministic gates (tests/lint/typecheck) run first; the reviewer is not involved until gates are green.

Failure modes:
- Only one vendor available → cannot run independent cross-vendor review; pull in the human at the plan gate.
- Reviewer can't boot (dispatch fails) → say so explicitly, don't silently skip.
- Contract can't be satisfied after a few loops → stop and escalate with specifics.
- Reviewer edits code anyway → stray edit never reaches the deliverable because only the implementer opens a PR (Polly) / the Council writes a directive, not code (Pickle Rick).

## Evaluation
For Rickgent's goals, the Omnigent Polly pattern is the better SUBSTRATE and the Pickle Rick Council of Ricks is the better REVIEW SEMANTICS — but neither is sufficient alone.

- Omnigent's substrate (`sys_session_send` with `agent`/`title`/`args`/`cost_budget`, `sys_read_inbox`, the policy engine) is exactly what Rickgent needs to dispatch a cross-vendor reviewer and drain its structured report. It is generic, multi-vendor, and already supports per-dispatch budgets. Rickgent should reuse this substrate rather than re-implement dispatch.
- Omnigent's Polly skill itself is single-PR, has no confidence scoring, no false-positive filter, no severity matrix, and no multi-category sweep. It is an example, not a hardened review loop.
- Pickle Rick's Council of Ricks is the hardened review loop: confidence-scored (>= 80 threshold), false-positive pre-filtered, P0-P4 severity matrix, 9 category sweeps + per-branch correctness + adversarial Codex, trap-door consolidation, and a two-clean-round approval gate. But it is (a) stack-scoped (Rickgent needs per-ticket/per-PR review), (b) explicitly human-invoked, not policy-enforced, and (c) tightly coupled to Graphite (`gt`) and tmux — none of which Rickgent should inherit.
- AC-13 requires cross-review to be POLICY-ENFORCED, not just instructed. Omnigent's policy engine can enforce "review must run before a ticket marks Done"; Pickle Rick's Council relies on the operator remembering to invoke `/council-of-ricks`. Rickgent must adopt the enforcing-policy posture from Omnigent, not the manual-invocation posture from Pickle Rick.

MASH: take Omnigent's dispatch substrate + policy-enforcement engine, and layer Rickgent's own cross-review skill on top — borrowing the review SEMANTICS from Council of Ricks (confidence scoring, severity matrix, false-positive filter, diff+contract-only independence, reviewer-never-edits, blocking→fix-task loop) but NOT the Graphite/tmux/stack-scoped coupling or the manual invocation.

## §2.1.1 Finding
ADOPT — "Cross-vendor review — convention, not core. The 'Polly pattern' lives in an example agent's skills + prompt, backed by generic orchestration policies. Rickgent ships its own cross-review skill + enforcing policy; the reusable part is the substrate, not a feature."

Confirmed by source: `omnigent/examples/polly/skills/cross-review/SKILL.md` is literally under `examples/polly/skills/` — an example agent's skill, not a platform primitive. The primitives it calls (`sys_session_send`, `sys_read_inbox`, `sys_session_get_history`) are generic orchestration substrate. The finding is adopted as written.

## Decision: mash
MASH — Omnigent substrate (sys_session_send + sys_read_inbox + policy engine) + Rickgent's own cross-review skill (borrowing Council of Ricks review semantics: confidence >= 80, P0-P4 severity, false-positive filter, diff+contract-only independence, reviewer-never-edits, blocking→fix-task loop) + enforcing policy (AC-13: policy-enforced, not manual invocation).

## Reasoning
The Polly pattern proves the substrate works: `sys_session_send` with a different-vendor `agent` and `purpose: "review"` dispatches an independent reviewer, `sys_read_inbox` drains its structured report, and the implementer-fix-loop reuses the original `agent` + `title` to preserve worktree context (`SKILL.md:18-38`). Rickgent should not re-implement dispatch — it should reuse Omnigent's substrate.

But the Polly skill itself is too thin for Rickgent's quality bar: no confidence scoring, no false-positive filter, no severity matrix, no multi-category sweep, no approval gate. Council of Ricks (`council-of-ricks.md`) has hardened exactly those semantics — the P0-P4 matrix, the `conf >= 80` threshold, the false-positive pre-filter (`council-of-ricks.md:211-220, 291-296`), the "reviewer never edits" rule (`council-of-ricks.md:5`), and the blocking→fix-task loop (`council-of-ricks.md:32-38`). Rickgent's own cross-review skill should adopt those semantics.

What Rickgent must NOT inherit from Council of Ricks: the Graphite stack coupling (`gt log short`, `gt branch checkout`), the tmux session orchestration, the stack-scoped (multi-PR) review shape, and — most importantly — the manual `/council-of-ricks` invocation. AC-13 demands that cross-review is POLICY-ENFORCED: the policy engine must refuse to mark a ticket Done until a cross-vendor review has run with zero blocking issues. Omnigent's policy engine (`omnigent/policies/builtins/`) is the enforcing mechanism; Pickle Rick has no equivalent (it relies on the operator). So the mash is: Omnigent substrate + Omnigent policy enforcement + Rickgent-authored review skill with Council-of-Ricks-grade semantics, scoped per-ticket (not per-stack), vendor-portable (not Graphite-coupled).
