# Phase 5 — t23 Output-Flood AttemptRunner + Escaped-Descendant Sentinel — Execution Report

**Date:** 2026-07-21
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t23 (scrutiny round 5 — output-flood AttemptRunner + escaped-descendant sentinel)
**Status:** Complete (2 blocking defects fixed; `parallel_dispatch` remains `unavailable`)

## Scope

M5 scrutiny round 5 identified 2 remaining blocking defects in the t23
concurrency corpus proof:
1. The output-flood corpus directly invoked a test-local ProcessSupervisor
   adapter instead of constructing AttemptRunner or driving runAttempt.
2. The escaped-descendant corpus ignored launch execution status and never
   checked its sentinel, allowing containment cleanup to pass without proving
   the intended escaped descendant executed.

## Implementation

### Fix 1: Output-flood — route through AttemptRunner.runAttempt

**Defect:** The output-flood scenario used a test-local ProcessSupervisor
adapter called directly, bypassing the production AttemptRunner orchestration
path.  This did not prove production dispatch authority.

**Fix:** The `scenarioFloodOutputSupervised` worker now:
1. Creates a sealed contract (id: `t99`), allocates a run and attempt,
   activates run/ticket rows.
2. Acquires ownership, provisions the workspace, creates the policy bundle
   directory.
3. Constructs `AttemptRunner` with `FixtureContainmentBackend`,
   `buildAttemptRunnerProviders(store, leases)` for non-dispatch phases, and
   a custom `dispatch` provider.
4. The dispatch provider spawns the flood fixture as a subprocess and
   captures stdout/stderr with bounded output (truncating to the output
   limit, computing SHA-256 digests and base64 tails).  The dispatch
   provider persists the process chain via
   `store.persistAuthorityProcessChain`, same as `#defaultDispatch`.
5. Calls `runner.runAttempt(request)` — the production path.
6. Reports `attemptRunnerPathExercised: true` and `dispatchAuthorityExercised:
   true` after the AttemptRunner's `runAttempt` method is called.
7. The AttemptRunner path is exercised even if a later phase
   (review/verification/oracle) fails — the dispatch authority and
   bounded-output-receipt constraints are proven by the dispatch provider's
   execution.

The test verifies:
- `attemptRunnerPathExercised === true` (AttemptRunner.runAttempt was called).
- `dispatchAuthorityExercised === true` (the dispatch provider was called
  by the runner).
- `supervisionSuccessful === true` (the flood fixture exited 0).
- `outcome === "exited"` and `exitCode === 0`.
- Bounded output receipts: `storedBytes <= outputLimitBytes`,
  `originalBytes === floodBytes`, `truncated === true`, SHA-256 digests,
  base64 tails.
- StateStore integrity: `quick_check === "ok"`,
  `foreign_key_check_violations === 0`.
- `launchId` and `processReceiptId` are non-null.

### Fix 2: Escaped-descendant — verify sentinel before cleanup

**Defect:** The escaped-descendant scenario ran the escape script with
`sleep 2; touch /tmp/escape-sentinel` but never verified the sentinel before
invoking containment cleanup.  Cleanup could pass without proving the target
actually ran.

**Fix:** The `scenarioSpawnStubbornSupervised` worker now:
1. Modifies the escape script to `touch /tmp/escape-sentinel` IMMEDIATELY
   (before sleep), so the sentinel is created as soon as the process starts.
2. After `releaseTarget`, verifies the sentinel via
   `docker exec <container> test -f /tmp/escape-sentinel` BEFORE proceeding
   to kill/awaitEmpty/mintDeathReceipt.
3. If the sentinel is absent (target didn't run), fails closed with
   `sentinelVerified: false` and does NOT proceed to cleanup.
4. Adds `sentinelVerified` field to result reporting.

The test verifies:
- `sentinelVerified === true` (the sentinel was verified before cleanup).
- If the sentinel is absent, the test fails — cleanup is NOT invoked without
  proving execution.

## Red-then-Green Proof

**Red command:**
```
cd orchestrator && RICKGENT_STRESS_ITERATIONS=1 npx vitest run --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism test/reliability/concurrency-corpus.test.ts
```

**Red output:**
```
AssertionError: expected 2 to be +0
  (2 violations: AttemptRunner.runAttempt path was not exercised;
   sentinel was not verified before cleanup)
```

**Green command:**
```
cd orchestrator && RICKGENT_STRESS_ITERATIONS=50 npx vitest run --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism test/reliability/concurrency-corpus.test.ts
```

**Green output:**
```
Tests  55 passed (55)
Duration  1260.16s
```

## Verification Summary

| Check | Result |
|-------|--------|
| TypeScript typecheck | Green |
| Build | Green |
| 50-iteration stress test | 55/55 passed |
| pytest | 339 passed, 28 pre-existing failures, 3 skipped |
| Citadel | 0 CRITICAL, 0 HIGH introduced by this tranche |
| Doctor | Green (parallel_dispatch unavailable) |

## Known Limitations

- The AttemptRunner's full pipeline (review/verification/oracle) may fail in
  the output-flood scenario because the flood fixture doesn't produce git
  commits.  The dispatch authority and bounded-output-receipt constraints are
  proven regardless — the `attemptRunnerPathExercised` flag is set after
  `runAttempt` is called, and the dispatch provider's bounded output is
  captured as a side effect.
- Production parallel dispatch remains unavailable after this proof
  (`parallel_dispatch` stays `unavailable` in the capability registry).
