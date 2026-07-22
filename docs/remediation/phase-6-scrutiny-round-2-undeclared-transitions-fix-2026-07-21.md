# Phase 6 — M6 Scrutiny Round 2: Undeclared State Transitions Fix — Execution Report

**Date:** 2026-07-21
**Feature:** m6-fix-undeclared-state-transitions
**Milestone:** M6-t24-t26
**Status:** Done

## Scope

Fix the 5 HIGH `state-transition:undeclared` findings reported by Citadel's
state-transition analyzer during M6 scrutiny round 2.  The t24
production-wiring fix introduced 8 direct failure transitions to
`cleanup_pending` (from every pre-cleanup state) in the normative
`PHASE_TRANSITION_TABLE` and the JSON state-and-lifecycle contract, but these
transitions were not declared in the markdown contract
(`state-and-lifecycle-contract.md`) or `MISSION_3_PRD.md` with the `->` arrow
syntax that Citadel's `extractTransitions` parser scans.  Additionally, a
comment in `attempt-runner.ts` used `state -> cleanup_pending` arrow syntax
which produced a false-positive `STATE->CLEANUP_PENDING` finding (the
identifier `state` is a variable reference in prose, not a real lifecycle
state).

## Root Cause

1. **Missing markdown declarations:** The 8 failure edges
   (`planned->cleanup_pending`, `implementing->cleanup_pending`,
   `implementation_captured->cleanup_pending`, `reviewing->cleanup_pending`,
   `remediating->cleanup_pending`, `remediation_captured->cleanup_pending`,
   `verification_queued->cleanup_pending`, `verifying->cleanup_pending`)
   were present in the JSON contract and the TS `PHASE_TRANSITION_TABLE` but
   absent from the markdown contract's lifecycle graph and `MISSION_3_PRD.md`.
   Citadel's `extractTransitions` parser only scans markdown text for `->` /
   `→` arrow-delimited identifier tokens, so the markdown omission caused the
   edges to be missing from the PRD-declared transition set.

2. **Comment false positive:** A comment in `attempt-runner.ts` line 1740
   used `from current state -> cleanup_pending` arrow syntax, which the
   Citadel parser extracted as `STATE->CLEANUP_PENDING`.  Since `STATE` is not
   a real lifecycle state, this was a false positive from prose arrow syntax
   in a code comment (documented in AGENTS.md as a known analyzer behavior).

## Fix

1. **Declared all 8 failure transitions in
   `docs/architecture/reliability/state-and-lifecycle-contract.md`:** Updated
   the lifecycle graph to include the 8 failure edges with `->` arrow syntax.
   Also split `cleanup_pending -> failed_clean | quarantined` into two
   separate lines so both terminal edges are properly parsed.  Added
   documentation of each failure edge's owning service, precondition, and
   evidence requirement.

2. **Declared all 8 failure transitions in `MISSION_3_PRD.md`:** Added the
   full normative attempt lifecycle graph (including failure edges) to the
   t24 section with `->` arrow syntax and documentation of owners and
   preconditions.

3. **Fixed the comment in `attempt-runner.ts` line 1740:** Changed
   `from current state -> cleanup_pending` to
   `from current state to cleanup_pending` to eliminate the
   `STATE->CLEANUP_PENDING` false positive.

4. **Added a TDD test (`m6-failure-transition-declaration.test.ts`):** 5 test
   cases verifying (a) all 8 failure edges are in the JSON contract with owner
   and guard, (b) all 8 are in the markdown contract with arrow syntax Citadel
   can parse, (c) owning authorities are named in the markdown, (d) all 8 are
   in `MISSION_3_PRD.md` with arrow syntax, and (e) all 8 are visible to
   Citadel via `parseCitadelPrd`.

## Red-then-Green Proof

**Red (before fix):**
- `pnpm vitest run test/reliability/m6-failure-transition-declaration.test.ts`
  — 4 failed, 1 passed (5 tests).  The JSON contract test passed because the
  JSON already had the edges; the markdown, PRD, and Citadel-visibility tests
  failed because the transitions were not declared in the markdown.
- `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .`
  — 5 HIGH `state-transition:undeclared` findings:
  `STATE->CLEANUP_PENDING` (attempt-runner.ts:1740),
  `REVIEWING->CLEANUP_PENDING` (test:317, 400, 409),
  `IMPLEMENTING->CLEANUP_PENDING` (test:338).

**Green (after fix):**
- `pnpm vitest run test/reliability/m6-failure-transition-declaration.test.ts`
  — 5 passed (5 tests).
- `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .`
  — 0 HIGH `state-transition:undeclared` findings.  Summary: 15 findings
  (CRITICAL=0, HIGH=0, MEDIUM=9, LOW=6).  All remaining findings are
  pre-existing (schema-registry-drift, banned-construct, skeptic-lens)
  documented in AGENTS.md as known false positives.

## Verification

| Check | Result |
|-------|--------|
| `pnpm typecheck` | green (exit 0) |
| `pnpm build` | green (exit 0, dist/cli.js refreshed) |
| Scoped M6 suites (8 files, 201 tests) | green (201/201 passed) |
| `python3 -m pytest test/ -p no:cacheprovider -q` | green (367 passed, 3 skipped) |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | green (0 CRITICAL, 0 HIGH) |
| `node orchestrator/dist/cli.js doctor` | green (all checks passed) |

## Files Changed

- `docs/architecture/reliability/state-and-lifecycle-contract.md` — added 8
  failure transition declarations with arrow syntax and owner/precondition
  documentation; split `cleanup_pending -> failed_clean | quarantined` into
  two lines.
- `MISSION_3_PRD.md` — added the normative attempt lifecycle graph with
  failure edges to the t24 section.
- `orchestrator/src/lifecycle/attempt-runner.ts` — fixed comment at line 1740
  to avoid `->` arrow syntax (`state -> cleanup_pending` changed to
  `state to cleanup_pending`).
- `orchestrator/test/reliability/m6-failure-transition-declaration.test.ts` —
  new TDD test file (5 test cases).

## Known Limitations

None.  The JSON contract already had all 8 failure edges with owners and
guards; only the markdown declarations were missing.

## Next Dependency Boundary

No new dependency boundary.  This fix resolves the M6 scrutiny round 2
Citadel hard gate failure and allows M6 validation to proceed.
