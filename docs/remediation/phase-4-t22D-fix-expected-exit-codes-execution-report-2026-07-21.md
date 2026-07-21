# Phase 4 — t22D Fix: Expected Exit Codes (M4 Scrutiny Round 6)

**Date:** 2026-07-21
**Ticket:** t22D (M4 scrutiny round 6, blocking defect)
**Scope:** `orchestrator/src/lifecycle/attempt-runner-providers.ts`, `orchestrator/test/reliability/attempt-runner-expected-exit-codes.test.ts`, `orchestrator/test/reliability/attempt-runner-multi-verification.test.ts`

## Defect

The verification provider in `attempt-runner-providers.ts` treated every
nonzero verification exit as failed and ignored
`TicketVerification.expected_exit_codes`. The `runVerificationArgv` classifier
hardcoded `e.status === 0 ? "pass" : "fail"`, so a permitted nonzero exit
(e.g., a linter that exits 1 on warnings but is configured with
`expected_exit_codes: [0, 1]`) was classified as `"fail"` and persisted as a
`"failed"` gate result. The oracle then rejected and the runner branched to
the ordinary-failure state machine instead of terminalizing a valid contract.
Symmetrically, an exit 0 result was always classified as `"pass"` even when 0
was not in the sealed allowlist — a fail-open the contract never authorized.

## Fix

1. **`attempt-runner-providers.ts` — `runVerificationArgv`:** Added an
   `expectedExitCodes: readonly number[]` parameter. The classifier now
   compares the observed exit code against the sealed allowlist:
   - In the success branch (execFileSync returned without throwing, exit 0):
     `status = expectedExitCodes.includes(0) ? "pass" : "fail"`.
   - In the caught-numeric-status branch:
     `status = expectedExitCodes.includes(e.status) ? "pass" : "fail"`.
   - The infrastructure-error branch (no numeric status: ENOENT, timeout
     signal, etc.) is unchanged — it remains `"infrastructure_error"`.

2. **`attempt-runner-providers.ts` — verification provider call site:**
   Passes `verification.expected_exit_codes` (the per-verification sealed
   allowlist) to `runVerificationArgv` for each verification in the iteration
   loop.

3. **`attempt-runner-multi-verification.test.ts` — fixture correction:** The
   pre-existing `multiVerificationDraft` set `expected_exit_codes: [1]` for
   the `failLast: true` case while running `process.exit(1)`. Under the
   corrected classifier semantics, exit 1 is a *permitted* pass when the
   allowlist is `[1]` — contradicting the test's intent of "one verification
   fails". Corrected to `expected_exit_codes: [0]` so exit 1 is NOT in the
   allowlist and fails closed. Also wrapped a pre-existing brace-free `if`
   (line 222) flagged by citadel's banned-construct analyzer in the diff
   scope.

## Tests

New test file: `orchestrator/test/reliability/attempt-runner-expected-exit-codes.test.ts`

- **Structural:** Provider source references `expected_exit_codes` in the
  classifier call and does NOT hardcode `e.status === 0 ? "pass" : "fail"`.
- **(a) Accepted nonzero exit (exit 1, `expected_exit_codes: [0, 1]`):**
  Asserts `status === "pass"` and the gate result is persisted as `"passed"`.
- **(a) Accepted nonzero exit (exit 2, `expected_exit_codes: [2]`):** A
  purely nonzero allowlist — the only permitted exit is 2; asserts `"pass"`.
- **(b) Excluded exit fails closed (exit 2, `expected_exit_codes: [0, 1]`):**
  Asserts `status === "fail"` and the gate result is persisted as `"failed"`.
- **(b) Excluded exit fails closed (exit 0, `expected_exit_codes: [1]`):**
  Edge case — 0 is NOT in the allowlist, so a clean exit fails closed. Proves
  the classifier consults the allowlist rather than assuming exit 0 always
  passes.
- **Sanity:** `FixtureContainmentBackend` constructible (guards the import).

### Red-then-green proof

**Red (before fix):**
```
pnpm vitest run test/reliability/attempt-runner-expected-exit-codes.test.ts
→ 5 failed | 2 passed (7)
```
- Structural: source matched `e.status === 0 ? "pass" : "fail"` (`.not.toMatch`
  failed).
- (a) exit 1, `[0,1]`: expected `"pass"`, received `"fail"`.
- (a) exit 2, `[2]`: expected `"pass"`, received `"fail"`.
- (b) exit 0, `[1]`: expected `"fail"`, received `"pass"` (fail-open).
- (b) exit 2, `[0,1]`: this case already passed under the bug (exit 2 was
  classified as `"fail"` regardless of the allowlist).

**Green (after fix):**
```
pnpm vitest run test/reliability/attempt-runner-expected-exit-codes.test.ts test/reliability/attempt-runner-multi-verification.test.ts
→ 14 passed (14)
```

## Proof Counts

- 7/7 focused gate (new expected-exit-codes suite)
- 14/14 combined (new suite + multi-verification suite, including Docker
  integration which passes when Docker + the runner image are available)
- Full reliability suite: 604 passed, 15 failed — all 15 failures pre-existing
  (confirmed via `git stash` baseline run: identical 15 failures without this
  tranche's changes). Pre-existing failures per AGENTS.md "Known Pre-Existing
  Issues": `state-store.test.ts` (1, `process.chdir()` in workers),
  `identity-allocation.test.ts` (1, `process.chdir()` in workers),
  `state-crash-corpus.test.ts` (2, stale transaction inventory),
  `policy-context.test.ts` + `native-policy-attachment.test.ts` (provenance
  probe mismatches).
- Python policy suite: 367 passed, 3 skipped.
- citadel: 0 CRITICAL, 0 HIGH (2 MEDIUM pre-existing schema-registry-drift
  heuristic false positives, 3 LOW pre-existing).
- doctor: exit 0 (capability matrix unchanged; `autonomous_dispatch` remains
  activated from t22D, no capability activated or deactivated by this fix).

## Known Limitations

None. The fix is complete and all scoped suites pass.

## Next Dependency Boundary

M4 scrutiny round 6 resolved. The next milestone is M5 (t23 concurrency
proof), which depends on t22A–t22D being fully done with all scrutiny
defects resolved.
