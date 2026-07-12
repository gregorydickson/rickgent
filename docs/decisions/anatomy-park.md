# Decision: Anatomy-Park (Subsystem Review)

## Component
§2 matrix row "Anatomy-park (subsystem review)" (lifecycle components — Pickle Rick likely wins).

## Omnigent implementation
Nothing. A grep for `anatomy-park|anatomy` over `/Users/gregorydickson/loanlight/pickle-rick/omnigent` returns no matches. Omnigent has no subsystem-discovery skill, no three-phase deep-review loop, and no trap door cataloging driven by a subsystem scan. The review intelligence has to be supplied entirely by Rickgent.

## Pickle Rick implementation
Anatomy-park is a three-phase subsystem deep review: trace data flows, fix without regression, catalog trap doors. It is **prompt-skill-driven** — the intelligence is in the skill file, not in a runtime module.

**Prompt skill:**
- `.claude/commands/anatomy-park.md` — "Three-phase subsystem deep review — trace data flows, fix without regression, catalog trap doors. Microverse convergence loop." (`anatomy-park.md:1-3`).

**Git Boundary Rules** (`anatomy-park.md:5-22`): the skill opens with a pinned-to-branch rule block. PROHIBITED worker commands: branch/HEAD mutation (`git checkout <ref>`, `git switch`, `git reset --hard`, `git reset`), remote interaction (`git pull`, `git push`, `git fetch --prune`), working-tree displacement (`git stash`, `git stash push`), history rewriting (`git rebase`, `git commit --amend`), direct `.git/` modification. ALLOWED mutating commands: `git add <paths>` (only paths inside the ticket's scope), `git commit` (with scope's edits), `git restore <paths>` (path-scoped, non-destructive), `git restore --source <ref> --staged --worktree <paths>` (path-scoped rollback from a SHA). To inspect another ref without changing branch state: `git show <ref>:<path>` or `git log <ref>`. If verification finds a regression, use the path-scoped restore form — never `git reset --hard`.

**Persona** (`anatomy-park.md:24-28`): "Rick Sanchez performing surgery inside the codebase — Anatomy Park. Each organ is a subsystem. You go in, find what's rotting, fix it without killing the patient, and label the structural weaknesses so the next surgeon doesn't repeat your mistakes. One organ at a time. No broad sweeps. No combined review-fix slop."

**Mode detection** (`anatomy-park.md:30-32`): `$ARGUMENTS` contains `--resume` → Worker Mode; otherwise → Setup Mode.

**Session knowledge transfer** (`anatomy-park.md:34-42`): soft hint, skip if inaccessible. If `FIREWALL_DETECTED=true`, skip silently. Reads `TASK_NOTES.md` (primary path `<working_dir>/.pickle-rick/sessions/<session_hash>/TASK_NOTES.md`, fallback `$SESSION_ROOT/TASK_NOTES.md`) for Dead Ends and Key Discoveries from prior anatomy-park passes.

**Setup Mode arguments** (`anatomy-park.md:44-62`): `--max-iterations <N>` (default 100), `--stall-limit <N>` (default 3), `--dry-run` (review only — catalog findings and trap doors without fixing), `--scope <flag>` (e.g. `branch`, `branch:one-hop`, `diff:<ref>`, `paths:<globs>`), `--scope-base <ref>`, `--backend <claude|codex|hermes>`. Remainder = TARGET (directory to review; default cwd). `--scope` and `--dry-run` are mutually exclusive (`anatomy-park.md:60`).

**Auto-discover subsystems** (`anatomy-park.md:64-80`): scans the **immediate subdirectories** of TARGET for subsystems. A subsystem is a direct child directory containing 3+ source files (`*.ts`, `*.js`, `*.py`, `*.go`, `*.rs`, `*.java`, `*.tsx`, `*.jsx`) counted recursively within that directory. Does NOT descend further — `src/services/` is a subsystem, `src/services/auth/` is part of it, not a separate subsystem. Excludes: `node_modules`, `dist`, `build`, `.next`, `coverage`, `__pycache__`, `.git`, test-only directories (dirs where >80% of files match `*.test.*` or `*.spec.*`). Sorts subsystems alphabetically and prints the discovered list with file counts.

The skill is 557 lines total. The three phases (trace data flows → fix without regression → catalog trap doors) and the microverse convergence loop are in the Worker Mode section beyond the first 80 lines. The pipeline-runner chains anatomy-park before szechuan-sauce; its findings are written to `anatomy-park.json` and ingested by citadel as `CrossPhaseFinding` entries (see `citadel.md` — `audit-runner.ts:32-46`).

## Contract
Anatomy-park is a three-phase subsystem deep review that converges on per-subsystem health.

**Invariants:**
- One organ (subsystem) at a time. No broad sweeps. No combined review-fix slop — review and fix are distinct phases.
- Three phases per subsystem: (1) trace data flows into and out of the subsystem, (2) fix what's rotting without introducing regressions, (3) catalog structural weaknesses (trap doors) so the next surgeon doesn't repeat mistakes.
- Subsystem discovery is deterministic: immediate subdirectories with 3+ source files, recursive count within the child, no deeper descent, test-only directories excluded.
- Git boundary is enforced: workers are pinned to the current branch; only path-scoped `git add` / `git commit` / `git restore` are allowed; `git reset --hard`, `git stash`, `git rebase`, `git commit --amend`, remote interaction, and direct `.git/` modification are prohibited.
- Regression reversion uses `git restore --source <ref> --staged --worktree <paths>` (path-scoped), never `git reset --hard`.
- `--dry-run` catalogs findings and trap doors without fixing; `--scope` and `--dry-run` are mutually exclusive.
- Session knowledge transfer (`TASK_NOTES.md`) is best-effort and never a blocker.
- Findings are written to `anatomy-park.json` for cross-phase ingest by citadel.

**Failure modes:**
- Missing tmux: Setup Mode Step 1 checks `tmux -V` and stops (Pickle Rick delivery-layer dependency; Rickgent replaces with Omnigent one-shots).
- Target not a directory: stops with error.
- No subsystems found: prints the discovered list (empty) and stops.
- Regression during fix phase: use path-scoped `git restore --source <ref> --staged --worktree <paths>` — never `git reset --hard`.
- Scope/dry-run conflict: prints `SCOPE_DRYRUN_CONFLICT` and stops.

## Evaluation
Pickle Rick is unambiguously the better source. Omnigent has no subsystem-review skill, no three-phase review loop, and no trap door cataloging. The anatomy-park skill is prompt-driven and harness-agnostic — it reads files, runs git commands (path-scoped only), and iterates — so it ports cleanly as a Rickgent agent skill. The only Pickle Rick-specific coupling is the tmux delivery layer and the `node "$HOME/.claude/pickle-rick/extension/bin/..."` bootstrap calls, both of which Rickgent replaces with Omnigent one-shots. The `--backend` flag's claude/codex/hermes routing is replaced by Omnigent's automatic multi-harness model routing (§2.1.1). There is no TS runtime to port — the three-phase loop and subsystem discovery logic live in the prompt skill. The git boundary rules are preserved by Rickgent's lifecycle policy seam (a `tool_call` policy on git commands, per §2.1.1's closed policy event vocabulary).

## §2.2.1 Finding
No specific §2.2.1 finding for anatomy-park — investigated fresh. The §2.2.1 validation pass did not enumerate the anatomy-park skill. This decision file is the fresh investigation: the skill is 557 lines (`anatomy-park.md:1-557`), prompt-driven, with a three-phase review loop, deterministic subsystem discovery (`anatomy-park.md:64-80`), and strict git boundary rules (`anatomy-park.md:5-22`). The `--dry-run` / `--scope` / `--max-iterations` / `--stall-limit` flag surface is confirmed at `anatomy-park.md:44-62`. All citations verified against HEAD `95f5c416`.

## Decision: port
PORT (Pickle Rick) — port as a Rickgent agent skill.

## Reasoning
Anatomy-park is purely prompt-driven. There is no TS runtime to port and no Omnigent analogue to mash with. The decision is port, not mash.

The port carries the 557-line skill into Rickgent's agent bundle with four adaptations:

1. **Delivery layer** — Setup Mode Step 1's `tmux -V` check is removed. Each review iteration dispatches as an `omnigent run <anatomy-worker> -p` one-shot (§10.10) instead of a tmux-attached claude session. Context clearing between iterations is Omnigent's per-dispatch session isolation (§2.1.1).

2. **Backend routing** — the `--backend <claude|codex|hermes>` flag (`anatomy-park.md:62`) is removed. Omnigent's automatic multi-harness model routing replaces the manual flag. A subsystem review is a read-and-edit task, so the router picks an appropriate harness automatically.

3. **Bootstrap calls** — `node "$HOME/.claude/pickle-rick/extension/bin/..."` calls become `rickgent` CLI calls.

4. **Git boundary enforcement** — the prose git boundary rules (`anatomy-park.md:5-22`) are reinforced by a Rickgent `tool_call` policy at the Omnigent seam that DENYs the prohibited git commands (`git reset --hard`, `git stash`, `git rebase`, `git commit --amend`, `git push`, `git pull`, `git fetch --prune`, direct `.git/` modification) and ALLOWs only the path-scoped `git add` / `git commit` / `git restore` forms. This makes the boundary enforced by the platform, not just by prompt discipline — the same lesson Pickle Rick learned with R-WSRC (prose alone failed; hooks enforce).

Everything else ports verbatim:
- The deterministic subsystem discovery algorithm (`anatomy-park.md:64-80`) is in the prompt and does not change.
- The three-phase loop (trace → fix → catalog) is in the prompt and does not change.
- The `--dry-run` / `--scope` / `--scope-base` / `--max-iterations` / `--stall-limit` flags map directly onto `rickgent anatomy` CLI flags.
- The `TASK_NOTES.md` session knowledge transfer ports as-is, with the `FIREWALL_DETECTED` soft-skip behavior preserved.
- The `anatomy-park.json` findings artifact is preserved so citadel's cross-phase ingest (`audit-runner.ts:32-46`) continues to work.

The pipeline-runner chains anatomy-park before szechuan-sauce; that ordering is preserved in Rickgent's phase sequence (§13).

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/spawn.py:118-130`; `pickle-rick-claude/.claude/commands/anatomy-park.md:5-23,52-80`
- **Notes:** The port decision looks reasonable, but the file gives no Omnigent file:line citation for the "nothing" claim, and it says the cited checks were verified against HEAD `95f5c416` while the local Pickle Rick reference is at `d5a021fa`.
- **Date:** 2026-07-12
