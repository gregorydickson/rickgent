# Changelog

## Unreleased — retained reliability proof

- Bound the installed `resume_retry`, exact-pair `cross_vendor_review`, and
  `automatic_delivery` claims to `installed_t38_retained_proof_v1`.
- Kept reconciliation limited to the local t29 persisted-receipt/oracle
  profile; `parallel_dispatch` and `raw_shell` remain unavailable.
- Preserved read-only help, version, and doctor during proof contraction, while
  protected mutation fails before state or side effects.
- Recorded that `ready_for_delivery` is local oracle readiness and `Done` is a
  delivered-only alias. The t38 evidence covers Codex CLI/OpenAI/gpt-5.6-sol
  plus Claude Code/Anthropic/claude-opus-4-8[1m], one allowlisted disposable
  hosted remote, and one reference-platform observation—not general provider,
  hosted-service, Darwin, Linux, or cross-platform readiness.

## v0.3.0 — 2026-07-15

### Added

- **7 CLI toolbelt commands** ported from pickle-rick-claude:
  - `rickgent prd` — interactive PRD interview via `omnigent run` + non-interactive template mode
  - `rickgent refine` — 3-analyst parallel refinement (requirements, codebase, risk-scope) over 3 cycles, producing `prd_refined.md` + atomic tickets with wiring and hardening tickets
  - `rickgent citadel` — 19-analyzer conformance audit (pure deterministic JS, no agents). Versioned JSON report (schema 1.0)
  - `rickgent szechuan` — iterative deslopping with 38 coding principles (P0-P4) + MicroverseLoop convergence (violation count → 0)
  - `rickgent anatomy` — deep subsystem review with 3-phase REVIEW/FIX/VERIFY protocol, auto-discovery, trap doors to `CLAUDE.md`
  - `rickgent microverse` — MicroverseLoop wrapper with 15 flags for metric/goal convergence
  - `rickgent cronenberg` — deterministic routing matrix that delegates to the appropriate command chain based on signals

- **Installer** (`install.sh`) — detects/installs omnigent, rickgent orchestrator + policies, and installs skills globally for Claude Code (`~/.claude/commands/`) and Codex (`~/.codex/skills/`)

- **Claude Code skills**: `/rickgent-prd`, `/rickgent-models`
- **Codex skills**: `rickgent-prd`, `rickgent-models` (with YAML frontmatter)

- **38 szechuan principles** organized by priority (P0:6, P1:6, P2:20, P3:3, P4:3) with domain supplements (api, ui, testing)
- **19 citadel analyzers**: PRD parser, diff walker, project shape detection, endpoint conformance, trap-door coverage, state-transition audit, frontend prop drift, AC shape audit, AC coverage scorecard, diff hygiene, sibling auth, rule-set invariants, schema registry drift, test authenticity, stale references, crossfile behavior drift, banned constructs/casts, pattern conformance, skeptic lens
- **State files**: `.rickgent/szechuan.json`, `.rickgent/gap_analysis.md`, `.rickgent/anatomy-park.json`, `.rickgent/refinement/`, `.rickgent/rick_ticket_*/`

### Changed

- Updated `CLAUDE.md` with all 7 commands, new test files, new lifecycle modules, conventions 15-17, new env vars
- Updated `README.md` to v0.3.0 with toolbelt documentation, command tables, and deep dives
- Extracted `runConformanceGate` from `build.ts` to `lifecycle/citadel.ts` and `runDeslopGate` to `lifecycle/szechuan.ts` (no behavioral change to build pipeline)

### Metrics

- 136 validation assertions, all passed (M0:35, M1:30, M2:28, M3:17, M4:14, M5:12)
- 660 TypeScript tests + 488 Python tests, all green
- 39 features completed across 10 milestones (M0-M5 + 5 misc-fix milestones)

## v0.2.0 — 2026-07-13

### Added

- Autonomous build loop with 8-phase per-ticket lifecycle
- Multi-vendor routing with cross-vendor review
- Full 9-gate pipeline (policy attachment, evidence dispatch, salvage, cross-vendor review, conformance, deslop, merge, circuit breaker, convergence)
- Backpressure queue, salvage/reconcile, orphan reaper
- Metrics with 14-day maturity window
- MicroverseLoop convergence (plateau/diminishing-delta + target-threshold)

## v0.1.0-alpha — 2026-07-12

### Added

- Initial scaffold and six core verdict algorithms (`completion`, `convergence`, `scope`, `prd`, `salvage`, `breaker`)
- TypeScript orchestrator with pure verdict core
- Python policy shims (scope_fence, completion_evidence, convergence_gate, subtract_before_add, cross_vendor_review, autonomous_pr_flow)
- omnigent agent bundles (manager + worker)
- Legacy differential conformance harness
