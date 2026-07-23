# M8 Scrutiny Round 5 — Test Stability and Timeout Fixes

**Date:** 2026-07-23
**Scope:** Fix 2 test stability issues causing 8 test failures in the M8 scoped suite.
**Commit:** (filled in after commit)

## Problem

Scrutiny round 5 identified 2 blocking test-stability defects:

1. **Five m8-scrutiny-round-4-fixes behavioral tests time out under cross-suite load.**
   The tests covering Oracle identity-binding negative/positive paths, canonical
   owner/repo PR acceptance, and delivery-decision error propagation use the
   default vitest `testTimeout` (15s) while performing real git operations (init,
   push, ls-remote) and StateStore setup. Under heavy cross-suite load (machine
   load ~19), git operations exceed the 15s deadline, causing timeouts.

2. **pr-protocol.test.ts wrong-repository timeout and existing-wrong-head fixture
   setup failure.** The `execFileSync` calls in test helper functions (`makeRepo`,
   `makeBareRepo`, `createDeliveryCommit`, `preparePrFixture`) have no `timeout`
   option and can hang indefinitely under load. The `infrastructure_error` from
   `prepareWithPush` occurs when the verified push fixture setup fails because a
   git operation hangs past the test deadline.

## Root Cause

Both issues share a common root cause: `execFileSync` calls in test helper
functions lack `timeout` options. The production code (`push.ts`,
`pull-request.ts`) already has timeouts on its `execFileSync` calls; only the
test helpers lack them. Additionally, behavioral tests in
`m8-scrutiny-round-4-fixes.test.ts` use the default 15s test timeout instead of
an explicit timeout appropriate for git-operation tests.

## Fix

### 1. Added `timeout` options to all `execFileSync` calls in test helpers

Every `execFileSync("git", [...])` call in the following test files now has a
`{ timeout: GIT_TIMEOUT }` option (where `GIT_TIMEOUT = 15_000`):

- `m8-scrutiny-round-2-fixes.test.ts`
- `m8-scrutiny-round-3-fixes.test.ts`
- `m8-scrutiny-round-4-fixes.test.ts`
- `pr-protocol.test.ts`
- `push-protocol.test.ts`
- `delivery-negative.test.ts`

This prevents indefinite hangs when git operations are slow under load. If a git
operation exceeds 15s, the `execFileSync` call throws a timeout error instead of
blocking forever, which is caught by the test framework as a regular failure
rather than a hang.

### 2. Added explicit `{ timeout: 30_000 }` to behavioral tests

All 8 behavioral tests in `m8-scrutiny-round-4-fixes.test.ts` that perform git
operations now have an explicit `{ timeout: 30_000 }` option:

- Oracle identity-binding negative paths (4 tests)
- Oracle identity-binding positive path (1 test)
- Fixture PR with correct owner/repo identity (1 test)
- Fixture PR with GraphQL node ID rejected (1 test)
- DeliveryAuthority.recordDecision failure propagation (1 test)

### 3. Added `hookTimeout: 30_000` to vitest config

The `afterEach` hooks that clean up temp directories with recursive `rmSync`
can be slow under load (git repos have many files). The `hookTimeout: 30_000`
setting ensures these cleanup hooks don't time out under load.

### 4. New test file: `m8-scrutiny-round-5-fixes.test.ts`

13 source-level tests verify the fixes:
- 5 tests verify behavioral tests in m8-scrutiny-round-4-fixes.test.ts have
  explicit timeout options
- 4 tests verify pr-protocol.test.ts fixture helpers have timeout options
- 6 cross-cutting tests verify all M8 git-using test files have timeout on
  helper `execFileSync` calls
- 1 test verifies vitest.config.ts has `hookTimeout >= 15000ms`

## Proof

### Red-then-green evidence

**Red (before fix):** 13/13 tests in `m8-scrutiny-round-5-fixes.test.ts` failed
with assertion failures (e.g., `expected 'execFileSync("git", ["init", "-q",
repo]);' to match /timeout/`).

**Green (after fix):** 13/13 tests pass.

### Scoped M8 suite (0 failures)

```
cd orchestrator && pnpm vitest run test/reliability/m8-scrutiny-round-2-fixes.test.ts \
  test/reliability/m8-scrutiny-round-3-fixes.test.ts \
  test/reliability/m8-scrutiny-round-4-fixes.test.ts \
  test/reliability/m8-scrutiny-round-5-fixes.test.ts \
  test/reliability/m8-production-wiring-t31-t34.test.ts \
  test/reliability/model-identity-corpus.test.ts \
  test/reliability/cross-vendor-review.test.ts \
  test/reliability/push-protocol.test.ts \
  test/reliability/delivery-negative.test.ts \
  test/reliability/pr-protocol.test.ts \
  --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

Result: **10 files passed, 185 tests passed, 0 failures** (32.59s).

### Verification suite

- `pnpm typecheck`: green
- `pnpm build`: green
- `python3 -m pytest test/ -p no:cacheprovider -q`: 372 passed, 3 skipped
- `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .`: exit 0,
  0 CRITICAL, 4 HIGH (all pre-existing state-transition false positives)
- `node orchestrator/dist/cli.js doctor`: exit 0

### Full TS suite (batches)

All TS test files run individually or in batches. All M8 scoped tests pass.
Pre-existing failures in other files are documented in AGENTS.md and not
introduced by this tranche.

## Known Limitations

- Pre-existing failures in `native-policy-attachment.test.ts` (provenance probe
  mismatch), `state-store.test.ts` (process.chdir() in workers),
  `oracle-store-integration.test.ts`, `state-crash-corpus.test.ts`,
  `identity-allocation.test.ts`, `attempt-critical-section.test.ts`,
  `attempt-runner-production-cutover.test.ts`, `attempt-runner-round-5-fixes.test.ts`,
  `m7-scrutiny-round-8-provider-ids-and-real-proofs.test.ts`,
  `gate-failure-corpus.test.ts`, `policy-context.test.ts`, and others are
  documented in AGENTS.md and not addressed by this tranche.
- Pre-existing hangs in `manifest.test.ts` (execFile without timeout),
  `concurrency-corpus.test.ts` (multi-process git), and
  `git-attribution-corpus.test.ts` (slow git) are not addressed by this tranche.

## Next Dependency Boundary

No new dependency boundary. This tranche fixes test stability for the M8 scoped
suite. The M8 milestone (t31-t34) is complete with all scoped tests passing.
