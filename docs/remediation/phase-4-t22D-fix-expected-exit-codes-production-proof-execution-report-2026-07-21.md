# Phase 4 — t22D Fix: Expected Exit Codes Production-Entrypoint Proof (M4 Scrutiny Round 7)

**Date:** 2026-07-21
**Ticket:** t22D (M4 scrutiny round 7, blocking defect)
**Scope:** `fixtures/prd-expected-exit-codes.md`, `fixtures/prd-expected-exit-codes-excluded.md`, `orchestrator/test/reliability/attempt-runner-expected-exit-codes-production.test.ts`

## Defect

The expected_exit_codes fix (M4 scrutiny round 6, commit `d14b75a`) added
direct provider tests (`attempt-runner-expected-exit-codes.test.ts`) that
invoke `providers.verification!()` directly.  Those tests prove the
classifier honors `expected_exit_codes` at the helper level but do NOT prove
a valid permitted-nonzero contract terminalizes successfully through the full
production path (`runBuildViaRunnerForTesting` → `executeBuildViaRunner` →
`AttemptRunner.runAttempt` → providers.verification → oracle →
terminalization).  Per invariant 10 (verify at the production entrypoint, not
just helper level), a helper-level test passing while the production
terminalization path stays unverified is a scrutiny failure.

Symmetrically, the excluded-exit fail-closed coverage existed only at the
helper level; no production-entrypoint test proved that an exit code not in
the sealed allowlist fails closed through the full runner path.

## Fix

No production source code change was required — the round 6 fix already wires
`expected_exit_codes` through the production path
(`buildAttemptRunnerProviders` is the default provider builder used by
`executeBuildViaRunner`).  This tranche adds the missing
production-entrypoint proof:

1. **`fixtures/prd-expected-exit-codes.md`** — A minimal PRD with one
   verification whose `expected_exit_codes` is `[1]` and whose command
   (`node -e "process.exit(1)"`) exits 1.  A permitted nonzero exit.

2. **`fixtures/prd-expected-exit-codes-excluded.md`** — A minimal PRD with
   one verification whose `expected_exit_codes` is `[1]` and whose command
   (`node -e "process.exit(2)"`) exits 2 (NOT in the allowlist).  An
   excluded exit that must fail closed.

3. **`orchestrator/test/reliability/attempt-runner-expected-exit-codes-production.test.ts`**
   — Two production-entrypoint integration tests driving
   `runBuildViaRunnerForTesting` with a real `DockerCgroupV2ContainmentBackend`,
   the real fixture omnigent mounted into the container, the real
   `buildAttemptRunnerProviders` providers constructed by the production
   path, and the real `omnigent run <agentDir> --no-session -p <prompt>`
   dispatch argv (no `dispatchArgvOverride`, no `sh -c` bypass):

   - **(a) Permitted-nonzero success:** `expected_exit_codes [1]`, command
     exits 1 → asserts `outcome.status === "succeeded"` and
     `outcome.stableCode === "RICKGENT_OK"` and `ticketsDone > 0`.  The full
     production path terminalizes a valid permitted-nonzero contract.
   - **(b) Excluded-exit fail-closed:** `expected_exit_codes [1]`, command
     exits 2 → asserts `outcome.status !== "succeeded"`.  The production
     path fails closed when the observed exit is not in the sealed allowlist.

   Both tests are gated on Docker + the `rickgent-runner:latest` image being
   available (consistent with
   `attempt-runner-multi-verification.test.ts`); they skip when Docker is
   unavailable.

## Tests

New test file: `orchestrator/test/reliability/attempt-runner-expected-exit-codes-production.test.ts`

- **(a) Permitted-nonzero terminalization succeeds:** Drives the real
  production entrypoint with a sealed `expected_exit_codes [1]` allowlist
  and a verification command that exits 1.  Asserts
  `outcome.status === "succeeded"`, `outcome.stableCode === "RICKGENT_OK"`,
  and `ticketsDone > 0`.
- **(b) Excluded-exit fails closed:** Drives the real production entrypoint
  with a sealed `expected_exit_codes [1]` allowlist and a verification
  command that exits 2 (not in the allowlist).  Asserts
  `outcome.status !== "succeeded"`.

### Red-then-green proof

**Red (classifier reverted to pre-fix `e.status === 0 ? "pass" : "fail"`):**
```
pnpm vitest run test/reliability/attempt-runner-expected-exit-codes-production.test.ts
→ 1 failed | 1 passed (2)
```
- (a) exit 1, `[1]`: expected `"succeeded"`, received `"failed"`.  The
  hardcoded classifier classified exit 1 as `"fail"`, the gate result was
  `"failed"`, the oracle rejected, and the runner branched to the
  ordinary-failure state machine instead of terminalizing.
- (b) exit 2, `[1]`: passed under the bug (exit 2 was classified as `"fail"`
  regardless of the allowlist), confirming the fail-closed direction is
  invariant.

**Green (classifier restored to `expectedExitCodes.includes(e.status)`):**
```
pnpm vitest run test/reliability/attempt-runner-expected-exit-codes-production.test.ts
→ 2 passed (2)
```

## Proof Counts

- 2/2 new production-entrypoint suite
  (`attempt-runner-expected-exit-codes-production.test.ts`)
- 32/32 scoped M4 suite (5 files:
  `attempt-runner-expected-exit-codes-production.test.ts` (2),
  `attempt-runner-expected-exit-codes.test.ts` (7),
  `attempt-runner-multi-verification.test.ts` (7),
  `attempt-runner-providers-and-container-env.test.ts` (9),
  `attempt-runner-production-wiring.test.ts` (7))
- Python policy suite: 367 passed, 3 skipped.
- citadel: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW (pre-existing, report-only).
- doctor: exit 0 (capability matrix unchanged; `autonomous_dispatch` remains
  activated from t22D, no capability activated or deactivated by this fix).

## Known Limitations

None.  The production-entrypoint proof is complete and all scoped suites
pass.  The Docker-gated tests skip when Docker or the runner image is
unavailable; when Docker is available (as in this environment), both tests
run and pass.

## Next Dependency Boundary

M4 scrutiny round 7 resolved.  The next milestone is M5 (t23 concurrency
proof), which depends on t22A–t22D being fully done with all scrutiny
defects resolved.
