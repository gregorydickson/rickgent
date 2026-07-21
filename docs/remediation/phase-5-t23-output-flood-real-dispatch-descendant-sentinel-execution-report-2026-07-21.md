# Phase 5 — t23 Output-Flood Real Dispatch + Descendant Sentinel — Execution Report

**Date:** 2026-07-21
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t23 (scrutiny round 6 — output-flood real production dispatch + escaped-descendant sentinel)
**Status:** Complete (2 blocking defects fixed; `parallel_dispatch` remains `unavailable`)

## Scope

M5 scrutiny round 6 identified 2 remaining blocking defects in the t23
concurrency corpus proof:

1. The output-flood corpus injected a test-local spawn-based dispatch
   provider that replaced AttemptRunner's production dispatch authority,
   hand-built receipts, caught runAttempt failures, and still emitted
   success flags. This did NOT prove the real production dispatch path.
2. The escaped-descendant sentinel was created by the PARENT SHELL before
   setsid/double-fork, which did not prove the escaped child itself
   executed.

## Implementation

### Fix 1: Output-flood — real production dispatch via runBuildViaRunnerForTesting

**Defect:** The `scenarioFloodOutputSupervised` worker constructed its own
AttemptRunner with a custom dispatch provider that spawned the flood fixture
directly, captured output manually, caught `runAttempt` failures, and still
emitted success flags.  This was a test-local workaround that bypassed the
production dispatch authority.

**Fix:** The `scenarioFloodOutputSupervised` worker now:
1. Configures a `DockerCgroupV2ContainmentBackend` with the fixture omnigent
   mounted into the Docker container (via `hostMounts` + `containerPath`).
2. Sets `FIXTURE_FLOOD_BYTES` in `extraEnv` so the fixture omnigent produces
   a large volume of output (64KB per stream) through the real `omnigent run`
   dispatch argv.
3. Calls `runBuildViaRunnerForTesting` (the real production entrypoint) with
   real `buildAttemptRunnerProviders` and real Docker containment.  NO
   custom dispatch provider is injected.  NO `attemptRunnerProviders`
   override.  The real `#defaultDispatch` is used, which calls
   `containment.releaseTarget(...)` with the real `omnigent run` argv.
4. Asserts `result.outcome.status === "succeeded"` (successful terminal
   completion).  If `runAttempt` fails, the worker reports that failure —
   does NOT catch runner failures and emit success flags.
5. Proves bounded-output-receipt constraints through the production path:
   the Docker containment backend's `dockerExecSilent` captures output with
   a `maxBuffer` limit (8MB).  The output files exist, are bounded by the
   maxBuffer, have SHA-256 digests, and are not truncated (64KB < 8MB).
6. Proves StateStore integrity: `quick_check` passes and
   `foreign_key_check` reports zero violations.
7. Cleans up Docker containers after the build to prevent resource
   accumulation across iterations.

**Fixture omnigent change:** Added `FIXTURE_FLOOD_BYTES` env var to
`promptMode()` in `fixture.mjs`.  When set, the fixture emits that many
bytes to both stdout and stderr before writing the scope file.  This
allows the fixture to produce flood output while still completing
successfully (writing the scope file + DB session + exit 0).

**Containment fix:** Changed `dockerExecSilent` from `execFileSync` to
`spawnSync` so BOTH stdout and stderr are captured on success.
`execFileSync` only returns stdout on success and discards stderr — the
production dispatch path needs both streams to produce complete
bounded-output receipts.

### Fix 2: Escaped-descendant sentinel — created by the escaped descendant

**Defect:** The escape script had `touch /tmp/escape-sentinel;` as the
first command, executed by the PARENT SHELL before setsid/double-fork.  This
did not prove the escaped descendant itself executed — the parent created
the sentinel regardless of whether the double-fork succeeded.

**Fix:** The escape script now uses a double-fork where the inner
double-forked child creates the sentinel AFTER setsid:
```sh
setsid sh -c '
  setsid sh -c "touch /tmp/escape-sentinel; sleep 30" &
  sleep 30
' &
sleep 30
```
The outer `setsid` creates a new session (first fork).  The inner `setsid`
creates another new session (the double-fork escape).  The inner child
touches the sentinel AFTER the second setsid — proving the escaped
descendant itself executed.  The parent shell does NOT create the sentinel.

The test still verifies the sentinel via `docker exec` BEFORE proceeding to
kill/awaitEmpty/mintDeathReceipt.  If the sentinel is absent (escaped child
didn't execute), the test fails closed — containment cleanup does NOT
proceed without proving execution.

## Red-then-Green Proof

**RED (old worker + new test assertions):**
```
RICKGENT_STRESS_ITERATIONS=1 pnpm vitest run test/reliability/concurrency-corpus.test.ts
→ iteration 0 scenario output-floods: violations=1 infra=0
  detail=build outcome is not "succeeded" (got outcome=exited);
  runAttempt must complete successfully through the production path
```
The old worker reported `outcome: "exited"` (the custom dispatch provider's
outcome) instead of `"succeeded"` (the real production build outcome).  The
new test assertion correctly catches this defect.

**GREEN (new worker + new test assertions):**
```
RICKGENT_STRESS_ITERATIONS=1 pnpm vitest run test/reliability/concurrency-corpus.test.ts
→ iteration 0: all 6 conflict scenarios pass with zero shared-state violations
→ 5 passed (1 failed: summary artifact check expects 50+ iterations, got 1)
```
All 6 scenarios pass with zero violations.  The only failure is the summary
artifact count check (expected 50+ iterations but got 1), which is expected
when running with 1 iteration.

## Verification

| Check | Result |
|-------|--------|
| TypeScript typecheck | PASS (tsc --noEmit clean) |
| TypeScript build | PASS (dist/cli.js rebuilt) |
| Python pytest | PASS (367 passed, 3 skipped) |
| Citadel conformance audit | PASS (0 CRITICAL, 0 HIGH, 1 LOW) |
| Doctor capability audit | PASS (parallel_dispatch unavailable, build_commit_match PASS) |
| Docker integration test | PASS (12 tests) |
| Containment corpus + process supervisor corpus | PASS (26 tests) |
| Production wiring test | PASS (7 tests) |
| Concurrency corpus 50 iterations | PASS (55+ tests, zero violations) |

## Files Changed

- `orchestrator/test/fixtures/omnigent-fixture/fixture.mjs` — added
  `FIXTURE_FLOOD_BYTES` env var support to `promptMode()`.
- `orchestrator/test/fixtures/concurrency-corpus/worker-fixtures.mjs` —
  rewrote `scenarioFloodOutputSupervised` to use
  `runBuildViaRunnerForTesting` with real Docker containment and real
  providers; fixed escape script in `scenarioSpawnStubbornSupervised` so
  the sentinel is created by the double-forked descendant AFTER setsid;
  added Docker container cleanup.
- `orchestrator/test/reliability/concurrency-corpus.test.ts` — updated
  output-flood scenario assertions for the new production path (outcome
  "succeeded", bounded by Docker maxBuffer, no truncation); increased
  default worker timeout to 60s; increased iteration timeout to 300s.
- `orchestrator/src/process/containment.ts` — changed `dockerExecSilent`
  from `execFileSync` to `spawnSync` to capture both stdout and stderr on
  success.

## Known Limitations

- The AttemptRunner's success path does not dispose the containment
  boundary (the Docker container's main process sleeps 3600s).  The worker
  cleans up Docker containers after each iteration to prevent resource
  accumulation.  A proper fix would add a `finally` block to `runAttempt`
  that disposes the boundary — this is a separate production code fix.
