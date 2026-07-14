# Breaker Error Signature Normalization

**Date:** 2026-07-14
**Status:** Accepted
**Context:** C1 legacy differential testing (VAL-CONF-007)

## Decision

The new core's `extractErrorSignature` (in `orchestrator/src/core/breaker.ts`)
applies more aggressive error normalization than the legacy
`normalizeErrorSignature` (in `circuit-breaker.ts@95f5c416`).

Specifically, the new core strips:
- `:\d+` → `:N` (line numbers after colons)
- `\bline \d+` → `line N` ("line 42" patterns)
- `\bat \d+` → `at N` ("at 42" patterns)
- ISO 8601 timestamps
- Hex addresses

The legacy strips:
- Unix paths (`/foo/bar` → `<PATH>`)
- `:N:N` line:column patterns
- ISO 8601 timestamps
- UUIDs

The legacy does **NOT** strip bare `line N` or `at N` patterns.

## Rationale

The legacy's normalization was insufficient to group repeated errors that
differ only by line number (e.g. "ETIMEDOUT at line 42", "ETIMEDOUT at line
99", "ETIMEDOUT at line 55"). This caused the circuit breaker to under-trip:
the `consecutive_same_error` counter reset on each signature change, so
repeated errors with varying line numbers never reached the threshold.

The new core's improved normalization ensures the breaker trips correctly for
repeated errors with varying line numbers, matching the intent of the
same-error threshold.

## Impact on Differential

For `breaker-001` (three errors with different line numbers, same root cause):
- **New core:** all three normalize to "ETIMEDOUT at line N" → errorCount=3 →
  threshold reached → `canExecute: false`, `transition: "opened"`
- **Legacy:** all three remain distinct signatures → consecutive_same_error=1
  each → threshold not reached → `canExecute: true`, `transition: "closed"`

This is a **decision-backed deviation** in the C1 differential. The
`canExecute` field differs (new core: false, legacy: true) because the new
core intentionally improved error normalization. The differential test
records this deviation with a reference to this decision doc.

For `breaker-002` and `breaker-003`, the errors do not contain line-number
variation that triggers this difference, so the `canExecute` field matches
across both surfaces.
