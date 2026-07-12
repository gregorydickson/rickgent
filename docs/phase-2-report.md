# Phase 2 Report — Verdict Core and Conformance

**Date:** 2026-07-12
**Phase:** Phase 2 (§13) — Verdict core and conformance
**Exit gate:** AC-5 (single predicate, pinned callers), AC-16 (verdict core conformance)

## What the phase claimed to deliver

1. 27 conformance fixtures extracted in §16.4 format covering all verdict types
2. Verdict logic refactored into `src/core/` with fail-closed hardening
3. `rickgent verdict <check> --json` CLI subcommand exercising the core
4. Malformed-input matrix across all three verdict surfaces (core API, CLI, Python subprocess)
5. Oracle single-predicate / pinned-caller audit wiring (AC-5)

## AC results

### AC-5 — Completion oracle is a single predicate with pinned callers
**Result: GREEN**

```
test/core/caller-audit.test.ts (4 tests)
  ✓ exports exactly one completion evaluation function
  ✓ has an explicit caller allowlist
  ✓ allowlist does not contain wildcard entries
  ✓ evaluateCompletion is a pure function (same input, same output)
```

`ALLOWED_COMPLETION_CALLERS` contains 7 explicit entries: `lifecycle.phase-machine`, `lifecycle.microverse`, `lifecycle.salvage`, `lifecycle.reconcile`, `cli.verdict`, `policy.completion-evidence`, `lifecycle.auto-fill-completion`.

### AC-16 — Verdict core conformance: verdicts match fixtures
**Result: GREEN**

27 conformance fixtures covering:
- Completion evidence: COMMITTED, UNVERIFIED, BASELINE_SHA, NO_TREE_CHANGE, gate-red
- Salvage dispositions: ff-reattached, committed-done, archived-todo, no-op, error
- Breaker transitions: trips-on-threshold, resets-on-progress, rejects-claimed-progress
- Gate: fresh-baseline-pass, stale-baseline-zero-checks, silence-not-success, scope-filtering
- Scope: allows-in-scope, denies-outside-scope, denies-traversal, allows-read
- PRD: valid, no-ac, no-simplification
- Malformed: invalid-json, missing-fields, unknown-enum

All three verdict surfaces pass the same suite:

| Surface | Tests | Result |
|---|---|---|
| In-process core API | 27 fixtures | GREEN |
| `rickgent verdict` CLI | 24 fixtures (breaker excluded — no CLI check) | GREEN |
| Python subprocess path | 24 fixtures + 3 agreement tests | GREEN |

### AC-16 — Malformed-input matrix, fail-closed
**Result: GREEN**

```
test/core/malformed-input.test.ts (11 tests)
  ✓ completion: handles null input by failing closed
  ✓ completion: handles undefined fields by failing closed
  ✓ completion: handles wrong types by failing closed
  ✓ salvage: handles null input by returning error disposition
  ✓ salvage: handles undefined fields by returning error or no-op
  ✓ gate: handles null input without throwing
  ✓ gate: handles empty input by detecting stale baseline
  ✓ scope: handles null input by denying
  ✓ scope: handles empty input by denying
  ✓ prd: handles null input by returning invalid
  ✓ prd: handles empty input by returning invalid
```

Core modules hardened with fail-closed guards: null/undefined/wrong-type inputs produce typed verdicts (UNVERIFIED, DENY, error disposition, invalid PRD) rather than throwing.

### AC-4 — Lifecycle layer tests pass (expanded)
**Result: GREEN**

```
TS: 99 tests, 9 files, all passing
  - test/core/scope.test.ts: 6 tests
  - test/core/completion.test.ts: 6 tests
  - test/core/salvage.test.ts: 4 tests
  - test/core/breaker.test.ts: 5 tests
  - test/core/convergence.test.ts: 5 tests
  - test/core/prd.test.ts: 7 tests
  - test/core/caller-audit.test.ts: 4 tests (AC-5)
  - test/core/malformed-input.test.ts: 11 tests (AC-16)
  - test/conformance/conformance-runner.test.ts: 51 tests (27 in-process + 24 CLI)

Python: 47 passed, 3 skipped
  - test_compat.py: 8 tests (AC-2)
  - test_policies.py: 12 tests
  - test_conformance.py: 27 tests + 3 agreement tests
  (3 skipped: breaker fixtures — no CLI surface for breaker check yet)
```

## Core module hardening

The core modules were hardened to handle malformed inputs per AC-16:

- **completion.ts**: Null/type guard returns `UNVERIFIED` for non-object input; strict boolean checks (`shaExists === true`)
- **salvage.ts**: Null guard returns `error` disposition; `gatePassed: false + treeChanged: false` → `error` (not `no-op`) per salvage-005 fixture
- **convergence.ts**: Null guard returns fail-closed verdict; array fields default to `[]` for missing types
- **scope.ts**: Null guard returns `DENY`; missing `isWrite` (not proper boolean) returns `DENY`
- **prd.ts**: Null guard returns `valid: false`; `acceptanceCriteria` defaults to `[]`

## Deviations

1. **Breaker CLI surface**: The `rickgent verdict` CLI doesn't have a `breaker` check yet. Breaker fixtures are tested via the in-process core API only. The CLI breaker check will be added when the lifecycle layer integrates the breaker in Phase 3.

2. **Differential test against legacy TS reference**: The PRD calls for a `scripts/legacy-reference-runner.js` that runs the legacy pickle-rick-claude TS implementation against the same fixtures. This requires running the legacy TS code (which has heavy dependencies on the pickle-rick extension runtime). The fixtures themselves are extracted from the source semantics (file:line citations in each fixture's `source` field). A full differential runner is deferred to when the legacy code can be invoked in isolation, or the fixtures serve as the spec (per AC-16's deviation clause: "the fixture suite is the spec").

## Items for human decision

1. **Legacy differential runner**: Whether to invest in a standalone legacy-reference-runner that imports the pickle-rick-claude TS modules, or accept the fixture suite as the spec (AC-16 deviation clause permits this).

## Summary

Phase 2 is complete. 27 conformance fixtures define the verdict spec. The core modules are hardened with fail-closed guards. All three verdict surfaces (core API, CLI, Python subprocess) pass the same fixture suite. 99 TS tests + 47 Python tests all green. Doctor smoke test still passes. Ready to proceed to Phase 3 (Lifecycle orchestration).
