# Decision: PRD / Ticket / Decomposition

## Component
§2 matrix row "PRD / ticket / decomposition" (lifecycle components — Pickle Rick likely wins).

## Omnigent implementation
Nothing. Omnigent exposes generic sub-agent dispatch (`sys_session_send`, `omnigent run … -p` one-shots) and a policy registry, but no PRD authoring skill, no PRD-to-ticket decomposition, no acceptance-criterion model, and no PRD parser. A grep for `citadel|szechuan|anatomy-park|cronenberg|prism|pickle-prd|pickle-refine-prd` over `/Users/gregorydickson/loanlight/pickle-rick/omnigent` returns no matches. The decomposition intelligence has to be supplied entirely by Rickgent.

## Pickle Rick implementation
The PRD/decomposition capability in Pickle Rick is **prompt-skill-driven, not runtime-driven**. There is no `prism` runtime module. The intelligence lives in two Claude skills plus a thin TypeScript orchestration layer that fans analysts out and parses the resulting PRD.

**Prompt skills (the decomposition intelligence):**
- `.claude/commands/pickle-prd.md` — "Pickle Rick's PRD Drafter": initializes a PAUSED session, interviews the user (feature / why / who / what / how / verification / contracts), and drafts `prd.md` from a fixed template (`.claude/commands/pickle-prd.md:1-95`). The template enforces machine-checkable verification per requirement: every Functional Requirement row has a Verification column, plus Interface Contracts (API / Type / State Transition tables), a Verification Strategy section, and Test Expectations tables (`.claude/commands/pickle-prd.md:35-95`). The skill pushes hard on "no requirement without a machine-checkable criterion" and "spec replaces review."
- `.claude/commands/pickle-refine-prd.md` — "Refine and decompose PRD into atomic tickets using parallel Morty analysis team" (`.claude/commands/pickle-refine-prd.md:1-100`). It runs a 3-analyst refinement team (roles `requirements`, `codebase`, `risk-scope` — see `extension/src/bin/refinement-watcher.ts:9`) for multiple cycles, then decomposes the refined PRD into atomic tickets bounded by **< 30 min, < 5 files, < 4 ACs**. Step 2 runs a Verification Readiness Check that gates on contract shapes, runnable verification commands, and machine-checkable criteria before any tokens are spent on refinement (`.claude/commands/pickle-refine-prd.md:30-65`). Step 4 deploys the refinement team; a `PICKLE_REFINE_WORKFLOW` kill-switch selects between the legacy subprocess path and a Dynamic Workflow path (`.claude/commands/pickle-refine-prd.md:75-100`).

**Thin TS orchestration:**
- `extension/src/bin/spawn-refinement-team.ts` — spawns the 3 parallel analyst workers per cycle, hardcodes `REFINEMENT_BACKEND = 'claude'` because "refinement is planning, not implementation; codex is never used here" (`extension/src/bin/spawn-refinement-team.ts:18`). `buildRefinementWorkerInvocation` splices `--max-turns` into the claude CLI args (`:53`); `buildRefinementEnv` sets the `PICKLE_REFINEMENT_LOCK` sentinel so grandchildren cannot downgrade to codex (`:80`). Emits an `AC_SHAPE_PROMPT_SECTION` that makes each analyst smell endpoint-enumeration ACs and emit a machine-readable `## ac_shape_smells` JSON block (`:110`).
- `extension/src/bin/refinement-watcher.ts` — tmux monitor pane for the refinement team. `ROLES = ['requirements', 'codebase', 'risk-scope']` (`:9`); `discoverLatestWorkerLog` sorts `worker_<role>_c<N>.log` files by cycle (`:33`); `roleStatus` checks whether `analysis_<role>.md` has crossed a 100-byte content threshold (`:53`).
- `extension/src/services/citadel/prd-parser.ts` — the parsing semantics downstream consumers (citadel, AC coverage) rely on. Defines `Decision`, `AcceptanceCriterion`, `Endpoint`, `AllowlistEntry`, `StatusCodeRow`, `TransitionAuditRow`, `RcodeEntry`, and `ParsedPrd` interfaces (`extension/src/services/citadel/prd-parser.ts:3-57`). `MAX_COMPOSES_DEPTH = 8` (`:59`) with `ComposesError` / `ComposesCycleError` / `ComposesDepthError` / `ComposesPathError` / `ComposesGlobError` (`:61-87`). Regex anchors: `AC_ID_PATTERN` (`AC-[A-Z0-9…]-\d+?`), `DECISION_PATTERN` (`A1..A99`), `ENDPOINT_CELL_PATTERN` (`GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS <path>`) at `:111-120`. Supports `composes:` chains with cycle/depth/glob guards.

## Contract
The PRD/decomposition component turns a feature request into a set of atomic, machine-verifiable tickets.

**Invariants:**
- Every functional requirement has a machine-checkable Verification (command, typecheck, lint, contract shape, or LLM-conformance). Subjective criteria ("good UX") are defects in the PRD, not deferred to review.
- Interface Contracts carry exact field+type shapes; "accepts loan data" prose is NEEDS_WORK.
- A ticket is atomic: < 30 min worker budget, < 5 files touched, < 4 acceptance criteria. Anything bigger is split.
- ACs are named with stable IDs (`AC-[A-Z0-9]+`) so downstream citadel audits can join findings back to criteria.
- `composes:` chains in AC text resolve to a finite depth (8) and reject cycles and globs.
- Refinement is planning, never implementation: the refinement backend is locked to the planning model family regardless of the parent session's worker backend.

**Failure modes:**
- Under-specified PRD: missing contracts / vague verification → refinement Step 2 gates and interviews the user instead of burning tokens.
- Endpoint-enumeration AC smell: one AC listing 3+ endpoints with the same predicate → analyst collapses it to a parametrized ticket or justifies the split.
- Codex leak: parent session opts into codex for implementation, refinement inherits it → `PICKLE_REFINEMENT_LOCK` sentinel forces claude in every grandchild.
- Composes cycle / depth blowup: `ComposesCycleError` / `ComposesDepthError` raise deterministically.

## Evaluation
Pickle Rick is unambiguously the better source for this component. Omnigent has no PRD model, no decomposition skill, and no parser. Pickle Rick's intelligence is prompt-driven (so it adapts cleanly to any harness Omnigent dispatches to) and the only TS code worth porting is the orchestration shim and the parser. The §2.2.1 validation confirmed "All named runtime artifacts exist with the claimed exports" and explicitly noted "there is no prism runtime module — the decomposition intelligence is prompt-driven"; both checks hold against HEAD `95f5c416`. The 3-analyst refinement team maps naturally onto Omnigent sub-agent fan-out (§2.1.1 confirmed async dispatch via `sys_session_send` + `sys_read_inbox`), so Rickgent can replace the tmux-bound `spawn-refinement-team.ts` subprocess machinery with Omnigent one-shots while keeping the prompt skills intact.

## §2.2.1 Finding
ADOPT. The §2.2.1 finding — "All named runtime artifacts exist with the claimed exports. NOTE: there is no prism runtime module — the decomposition intelligence is prompt-driven." — is confirmed by direct read of the source at HEAD `95f5c416`: `pickle-prd.md` and `pickle-refine-prd.md` are prompt skills (`pickle-prd.md:1-95`, `pickle-refine-prd.md:1-100`); the TS files are orchestration (`spawn-refinement-team.ts:18,53,80,110`, `refinement-watcher.ts:9,33,53`) and parsing (`citadel/prd-parser.ts:3-57,59-87,111-120`); no `prism` module exists anywhere under `extension/src/`. The finding is adopted verbatim.

## Decision: port
PORT (Pickle Rick) — adapt the `pickle-prd` and `pickle-refine-prd` prompt skills and write fresh TS PRD/Ticket types modeled per §3.7; this is skill adaptation, not a Python code port.

## Reasoning
The decomposition intelligence is in the prompts, not in a runtime module, so the port is a skill adaptation rather than a code translation. The two skills (`pickle-prd.md`, `pickle-refine-prd.md`) are carried into Rickgent's agent bundle with light editing: the `node "$HOME/.claude/pickle-rick/extension/bin/setup.js"` bootstrap calls become `rickgent` CLI calls, the tmux handoff at the end of `pickle-prd` becomes an Omnigent one-shot dispatch, and the `PICKLE_REFINE_WORKFLOW` workflow path is re-pointed at Omnigent's sub-agent fan-out (`sys_session_send` + `sys_read_inbox` per §2.1.1) instead of the legacy subprocess path.

The TS orchestration shim (`spawn-refinement-team.ts`, `refinement-watcher.ts`) is **not** ported as-is. It is tmux-bound and claude-CLI-specific. Rickgent replaces it with: (a) the §3.7 PRD/Ticket types, modeled fresh from the `pickle-prd.md` template and the `prd-parser.ts` interfaces; (b) a thin refinement dispatcher that uses `omnigent run <analyst-agent> -p` one-shots (or `sys_session_send` for in-agent fan-out) instead of `claude -p` subprocesses; (c) the `PICKLE_REFINEMENT_LOCK` equivalent at the Rickgent policy seam so a codex-opted parent session still gets a claude-family refinement pass.

The parser (`citadel/prd-parser.ts`) is ported as-is into the TS product — it is pure, has no tmux or claude-CLI coupling, and its `ParsedPrd` shape is the contract between refinement output and the citadel conformance audit. The `composes:` cycle/depth/glob guards and the AC/Decision/Endpoint regex anchors are kept verbatim because downstream citadel findings join on those exact IDs.

Omnigent contributes the dispatch substrate (multi-harness, async fan-out, per-dispatch cost budgets per §2.1.1) but nothing to the PRD model itself. The mash is: Pickle Rick prompts + Pickle Rick parser + Omnigent dispatch infrastructure + fresh Rickgent TS types.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `.claude/commands/pickle-prd.md:1-35` contains the interview/template; `omnigent/tools/builtins/spawn.py:115-135` confirms separate-session fan-out, while Omnigent has no native decomposition model.
- **Notes:** Prompt intelligence plus dispatch substrate is the correct mash.
- **Date:** 2026-07-12
