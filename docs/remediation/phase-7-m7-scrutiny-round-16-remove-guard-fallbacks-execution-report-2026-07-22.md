# M7 Scrutiny Round 16 — Remove request.guard Fallbacks and Derive All Guard Operands from Dedicated Fields

**Date:** 2026-07-22
**Scope:** `TransitionAuthority.commitAttemptEdge` / `#deriveEdgeGuard`
**Ticket:** t27 (independent review and bounded remediation) — scrutiny round 16
**Status:** Done

## Problem

Scrutiny round 15 fixed the guard KIND and expectedRole derivation (both come from the `PHASE_TRANSITION_TABLE` edge definition, not the caller). However, the guard's DATA FIELDS (`contextId`, `gateResultIds`, `commitAttributionId`) were still extracted from `request.guard` as a FALLBACK when the dedicated request fields were not provided. This means a caller could still select the execution context, gate result IDs, or commit attribution by providing them inside `request.guard` without providing the dedicated fields, contrary to the full no-caller-influence guard contract.

## Fix

Removed ALL `request.guard` fallbacks in `#deriveEdgeGuard`:

1. **`execution_context` guard**: `contextId` now comes ONLY from the dedicated `request.contextId` field. The fallback to `request.guard.contextId` is removed. If the dedicated field is missing, the transition fails closed with a `TypeError`.

2. **`gate_results` guard**: `gateResultIds` now comes ONLY from the dedicated `request.gateResultIds` field. The fallback to `request.guard.gateResultIds` is removed. If the dedicated field is missing, the transition fails closed with a `TypeError`.

3. **`cleanup_pending` guard**: `commitAttributionId` now comes ONLY from the dedicated `request.commitAttributionId` field. The fallback to `request.guard.commitAttributionId` is removed. If the dedicated field is missing, the guard has no `commitAttributionId` (the no-attribution cleanup path with "failure" evidence is used).

The `guard?` field remains in the `commitAttemptEdge` request type for backward compatibility but is completely ignored — no part of it (kind, role, or data fields) is read. The `#deriveEdgeGuard` method's parameter type no longer includes `guard?`.

The `LifecycleEngine` production path was already passing the dedicated fields alongside the guard, so no production code changes were needed beyond the comment update.

## Tests

### New test file

`orchestrator/test/reliability/m7-scrutiny-round-16-remove-guard-fallbacks.test.ts` — 3 behavioral negative tests:

- **(a) execution_context guard**: Provide a `request.guard` with a VALID `contextId` and NO dedicated `contextId` field. Assert the transition THROWS (the dedicated field is the sole source). RED against unfixed code (fallback uses guard's contextId, transition succeeds). GREEN after fix (no fallback, missing dedicated field throws).

- **(b) gate_results guard**: Provide a `request.guard` with VALID `gateResultIds` and NO dedicated `gateResultIds` field. Assert the transition THROWS. RED against unfixed code (fallback uses guard's gateResultIds, transition succeeds). GREEN after fix (no fallback, missing dedicated field throws).

- **(c) cleanup_pending guard**: Provide a `request.guard` with a FAKE `commitAttributionId` and NO dedicated `commitAttributionId` field, with "failure" evidence. Assert the transition SUCCEEDS (the guard's fake commitAttributionId is ignored, the no-attribution path is used). RED against unfixed code (fallback uses guard's fake commitAttributionId, store rejects it, transition throws). GREEN after fix (no fallback, commitAttributionId undefined, "failure" evidence path succeeds).

### Updated test file

`orchestrator/test/reliability/m7-scrutiny-round-14-derive-expected-role-from-edge.test.ts` — 3 tests updated to pass the dedicated `contextId` field alongside the guard (previously relied on the guard fallback for contextId).

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | Clean (exit 0) |
| `pnpm build` | `dist/cli.js` rebuilt (exit 0) |
| Scoped M7 suites (rounds 11-16) | 18/18 passed |
| `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 CRITICAL, 0 HIGH (exit 0) |
| `node orchestrator/dist/cli.js doctor` | Exit 0, capability matrix unchanged |

## Red-to-Green Evidence

**RED (before fix):**
```
cd orchestrator && pnpm vitest run test/reliability/m7-scrutiny-round-16-remove-guard-fallbacks.test.ts
Tests  3 failed (3)
  × negative proof (a): expected false to be true // guard fallback used, transition succeeded
  × negative proof (b): expected false to be true // guard fallback used, transition succeeded
  × negative proof (c): StateStoreError: cleanup transition commit attribution differs from the attempt
```

**GREEN (after fix):**
```
cd orchestrator && pnpm vitest run test/reliability/m7-scrutiny-round-16-remove-guard-fallbacks.test.ts
Tests  3 passed (3)
  ✓ negative proof (a): guard with valid contextId but NO dedicated contextId field MUST throw
  ✓ negative proof (b): guard with valid gateResultIds but NO dedicated gateResultIds field MUST throw
  ✓ negative proof (c): guard with FAKE commitAttributionId but NO dedicated field MUST succeed
```

## Files Changed

- `orchestrator/src/state/transitions.ts` — removed all `request.guard` fallbacks in `#deriveEdgeGuard`; updated doc comments for round 16
- `orchestrator/src/lifecycle/engine.ts` — updated comment to reflect round 16 (guard completely ignored)
- `orchestrator/test/reliability/m7-scrutiny-round-16-remove-guard-fallbacks.test.ts` — new test file (3 behavioral negative tests)
- `orchestrator/test/reliability/m7-scrutiny-round-14-derive-expected-role-from-edge.test.ts` — updated 3 tests to pass dedicated `contextId` field
- `docs/remediation/trust-spine-manifest.json` — added round 15 and 16 scrutiny fix references to t27

## Known Limitations

None. The fix is complete and all guard operands now come exclusively from dedicated request fields.
