# Legacy Differential (C1 / AC-16)

**Date:** 2026-07-14
**Status:** Accepted
**Context:** C1 conformance differential testing against pickle-rick-claude@95f5c416

## Decision

The C1 legacy differential reconstructs the actual legacy Pickle Rick TS
reference from `pickle-rick-claude@95f5c416` via `git show` (READ-ONLY) into a
standalone TS harness with its own tsconfig/out-dir and zero pickle-rick-claude
runtime dependencies.

### Per-predicate feasibility

| Predicate | Status | Approach |
|---|---|---|
| salvage | legacy-verified | Extract `salvageTicket` with 2 stubbed deps; drive with fixture booleans |
| scope | legacy-verified | Pure `isPathInScope`/`normalizePath` copy (0 stubs); scope-003/004 new-core-only |
| breaker | adapter-mediated | Extract `recordIterationResult` + lossy state→transition adapter |
| completion | unverifiable-by-port | I/O-bound; no pure legacy function to port |
| convergence | unverifiable-by-port | Lock/fs/git-bound; no pure legacy function to port |
| prd | unverifiable-by-port | Legacy is markdown parser, new core is object validator; no provenance |

### Reason-string deviations (salvage)

Reason strings are implementation-specific prose (legacy: `gate_passing_committed`,
new core: `gate passing and tree changed`). The typed `disposition` enum is the
authoritative comparison target. Both surfaces produce the same disposition for
every salvage fixture.

### Path traversal deviation (scope-003)

The legacy `isPathInScope` uses lexical prefix matching and does NOT canonicalize
`..` components. The new core canonicalizes paths before scope checking. This is
a new-core-only behavior (a bug fix in the new core) — annotated, not diffed.

### Breaker normalization deviation (breaker-001)

See `docs/decisions/breaker-normalization.md`. The new core's error normalization
is more aggressive than the legacy's, causing a `canExecute` mismatch for
breaker-001. This is a decision-backed deviation.

## Manifest

The full provenance, stubs, adapter documentation, and per-fixture verification
status is recorded in `conformance/legacy-reference/manifest.json`.
