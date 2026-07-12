# Decision: Szechuan (Deslopping)

## Component
§2 matrix row "Szechuan (deslopping)" (lifecycle components — Pickle Rick likely wins).

## Omnigent implementation
Nothing. A grep for `szechuan` over `/Users/gregorydickson/loanlight/pickle-rick/omnigent` returns no matches. Omnigent has no principle-driven code-review skill, no deslopping loop, and no quality-convergence model. The policy framework can fence tool calls but cannot drive an iterative review-fix-measure loop against a principles checklist. The deslopping intelligence has to be supplied entirely by Rickgent.

## Pickle Rick implementation
Szechuan-sauce is an iterative, principle-driven code-quality convergence loop. It is **prompt-skill-driven** — the intelligence is in the skill file and the deployed principles supplement, not in a runtime module.

**Prompt skill:**
- `.claude/commands/szechuan-sauce.md` — "Iterative code deslopping loop — principle-driven quality convergence until the code is worthy of the sauce" (`szechuan-sauce.md:1-3`). Persona: "Rick Sanchez on a mission to get the Szechuan Sauce. The sauce is perfect code. Every iteration, you find slop, you fix slop, you measure slop. When the slop hits zero — *that's the sauce, Morty.*" (`szechuan-sauce.md:5-10`).

**Mode detection** (`szechuan-sauce.md:12-14`): `$ARGUMENTS` contains `--resume` → Worker Mode; otherwise → Setup Mode.

**Session knowledge transfer** (`szechuan-sauce.md:16-36`): best-effort, never a blocker. Reads `TASK_NOTES.md` (primary path `<working_dir>/.pickle-rick/sessions/<session_hash>/TASK_NOTES.md`, fallback `$SESSION_ROOT/TASK_NOTES.md`) for Dead Ends and Key Discoveries from prior passes. If `FIREWALL_DETECTED=true` (injected when the working directory contains an `AGENTS.md` firewall) the entire section is a soft suggestion and skipped silently. Sections: `## Progress`, `## Dead Ends`, `## Key Discoveries`, `## Next`. Records a Dead End the moment an approach fails, not at iteration end — "a worker that defers notes to 'before you finish' and then times out loses all progress memory" (R-HNCG).

**Setup Mode arguments** (`szechuan-sauce.md:38-66`): `--max-iterations <N>` (default 50), `--stall-limit <N>` (default 5), `--dry-run` (gap analysis only — catalog violations without fixing), `--domain <name>` (loads `szechuan-sauce-<name>-principles.md` as supplemental principles), `--design-safe` (protects deliberate visual decisions as author intent; auto-loaded by pipeline when diff is UI-dominant via B2 `design_safe` field in `microverse.json`), `--focus "<text>"` (natural language review directive — narrows what to hunt for, elevates matching violations by one priority level), `--scope <flag>` (e.g. `branch`, `branch:one-hop`, `diff:<ref>`, `paths:<globs>`), `--scope-base <ref>`, `--backend <claude|codex|hermes>`. Remainder = TARGET (file or directory; default cwd). `--scope` and `--dry-run` are mutually exclusive (`szechuan-sauce.md:60`).

**Target validation** (`szechuan-sauce.md:68-76`): if directory, globs for `**/*.{ts,js,py,go,rs,java,tsx,jsx,vue,svelte,sql}`; if none found, stops. If file, confirms it exists and is readable.

**Dry Run mode** (`szechuan-sauce.md:78-80`): reads `$HOME/.claude/pickle-rick/szechuan-sauce-principles.md` (plus domain and UI supplements if set) and performs gap analysis without creating a session or modifying code.

**Principles** (per the §2 matrix row and the skill's principles supplement): KISS, DRY, dead code, edge cases, encapsulation, self-documenting code, small functions, single source of truth. The principles file is a deployed artifact (`szechuan-sauce-principles.md`, `szechuan-sauce-ui-principles.md` for `--design-safe`), not part of the skill prompt itself — the skill reads it at runtime so principles can evolve without editing the skill.

The skill is 451 lines total. The full loop (find slop → fix slop → measure slop → repeat until zero or stall limit) is in the Worker Mode section beyond the first 80 lines, driving an iterative convergence that the pipeline-runner chains after anatomy-park and before citadel.

## Contract
Szechuan-sauce is an iterative deslopping loop that converges code quality against a principles checklist.

**Invariants:**
- Every iteration: find slop, fix slop, measure slop. When slop hits zero, the loop exits. When stall limit is hit (default 5 iterations with no improvement), the loop exits.
- Principles are externalized to a deployed `szechuan-sauce-principles.md` file (plus optional `szechuan-sauce-<domain>-principles.md` and `szechuan-sauce-ui-principles.md` supplements) so they evolve without editing the skill.
- `--dry-run` catalogs violations without modifying code; `--scope` and `--dry-run` are mutually exclusive.
- `--design-safe` protects deliberate visual decisions as author intent; the UI principles supplement's false-positives list takes precedence for visual decisions.
- `--focus` narrows what to hunt for and elevates matching violations by one priority level.
- Session knowledge transfer (`TASK_NOTES.md`) is best-effort and never a blocker — if a firewall or sandbox blocks the read/write, the section is skipped silently.
- The loop is file-based, not harness-task-based: the authoritative state is on disk, not in the harness task list.

**Failure modes:**
- Missing tmux: Setup Mode Step 1 checks `tmux -V` and stops with "Install tmux: `brew install tmux`." (This is a Pickle Rick delivery-layer dependency; Rickgent replaces it with Omnigent one-shots.)
- No source files in target: stops with "No source files found in TARGET."
- Unknown domain: glob `szechuan-sauce-*-principles.md`, list available domains, stop.
- Missing UI principles file when `--design-safe` is set: stops with "UI principles file missing — run bash install.sh to deploy it."
- Scope/dry-run conflict: prints `SCOPE_DRYRUN_CONFLICT` and stops.

## Evaluation
Pickle Rick is unambiguously the better source. Omnigent has no deslopping skill, no principles checklist, and no quality-convergence loop. The szechuan-sauce skill is prompt-driven and harness-agnostic — it reads files, runs shell commands, and iterates — so it ports cleanly as a Rickgent agent skill. The only Pickle Rick-specific coupling is the tmux delivery layer (Setup Mode Step 1) and the `node "$HOME/.claude/pickle-rick/extension/bin/..."` bootstrap calls, both of which Rickgent replaces with Omnigent one-shots. The principles supplements are plain markdown files that port verbatim. The `--backend` flag's claude/codex/hermes routing is replaced by Omnigent's automatic multi-harness model routing (§2.1.1). There is no TS runtime to port — the loop logic lives in the prompt skill, and the measurement step shells out to project lint/test commands.

## §2.2.1 Finding
No specific §2.2.1 finding for szechuan — investigated fresh. The §2.2.1 validation pass did not enumerate the szechuan-sauce skill. This decision file is the fresh investigation: the skill is 451 lines (`szechuan-sauce.md:1-451`), prompt-driven, with externalized principles supplements and a tmux delivery layer. The `--dry-run` / `--scope` / `--design-safe` / `--focus` / `--domain` flag surface is confirmed at `szechuan-sauce.md:38-66`. All citations verified against HEAD `95f5c416`.

## Decision: port
PORT (Pickle Rick) — port as a Rickgent agent skill.

## Reasoning
Szechuan-sauce is purely prompt-driven. There is no TS runtime to port and no Omnigent analogue to mash with. The decision is port, not mash.

The port carries the 451-line skill into Rickgent's agent bundle with three adaptations:

1. **Delivery layer** — Setup Mode Step 1's `tmux -V` check (`szechuan-sauce.md:38-40`) is removed. The deslop loop dispatches each iteration as an `omnigent run <deslop-worker> -p` one-shot (§10.10) instead of a tmux-attached claude session. Context clearing between iterations is Omnigent's per-dispatch session isolation (§2.1.1), not tmux kill-and-respawn.

2. **Backend routing** — the `--backend <claude|codex|hermes>` flag (`szechuan-sauce.md:62`) is removed. Omnigent's automatic multi-harness model routing (§2.1.1: `sys_advise_models` with SIMPLE/MODERATE/COMPLEX rubric) replaces the manual flag. A deslop iteration is a read-and-edit task, so Omnigent's router picks an appropriate harness automatically.

3. **Bootstrap calls** — `node "$HOME/.claude/pickle-rick/extension/bin/..."` calls become `rickgent` CLI calls.

Everything else ports verbatim:
- The principles supplements (`szechuan-sauce-principles.md`, `szechuan-sauce-<domain>-principles.md`, `szechuan-sauce-ui-principles.md`) are plain markdown and land in the Rickgent agent bundle's deployed-artifacts directory.
- The `--dry-run` / `--scope` / `--scope-base` / `--focus` / `--domain` / `--design-safe` / `--max-iterations` / `--stall-limit` flags map directly onto `rickgent szechuan` CLI flags.
- The `TASK_NOTES.md` session knowledge transfer (`szechuan-sauce.md:16-36`) ports as-is, with the primary path re-pointed at Rickgent's session directory layout and the `FIREWALL_DETECTED` soft-skip behavior preserved.
- The iterative find-slop → fix-slop → measure-slop loop is in the prompt and does not change.

The pipeline-runner chains szechuan-sauce after anatomy-park and before citadel; that ordering is preserved in Rickgent's phase sequence (§13).

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/spawn.py:118-130`; `pickle-rick-claude/.claude/commands/szechuan-sauce.md:1-33,44-80`
- **Notes:** The port direction looks reasonable, but the file gives no Omnigent file:line citation for the "nothing" claim and says the fresh checks were against HEAD `95f5c416` while the local Pickle Rick reference is at `d5a021fa`.
- **Date:** 2026-07-12
