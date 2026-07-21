# Phase 5 — t23 BoundedOutputSink Fail-Closed Propagation + Output-Limit Validation (Scrutiny Round 9)

**Date:** 2026-07-21
**Ticket:** t23 (M5 concurrency proof) — scrutiny remediation round 9
**Scope:** Fix M5 scrutiny round 9 blocking defects — two fail-closed issues in the streaming BoundedOutputSink capture path used by the Docker containment backend's `releaseTarget`.

## Problem

### Defect #1 — `dockerExecStreaming` swallows BoundedOutputSink write and close/integrity failures

`dockerExecStreaming` (the `child_process.spawn`-based streaming capture in `orchestrator/src/process/containment.ts`) caught sink write errors in the stream `data` handlers with `try { sink.write(chunk); } catch { /* swallowed */ }` and caught close/integrity errors in `safeCloseSink` (which synthesized an empty fail-closed receipt but did NOT propagate the failure as a dispatch failure). A zero child exit could therefore be treated as a successful dispatch with a partial or synthetic empty output receipt — the fail-open the ticket identifies.

### Defect #2 — `outputLimitBytes` and `tailLimitBytes` accepted without finite positive bounds, maximum cap, or tail<=output validation

`DockerCgroupV2ContainmentBackend.releaseTarget` accepted `outputLimitBytes` and `tailLimitBytes` from the caller without validating them before spawning. Malformed or infinite values (NaN, Infinity, negative, zero, tail > output, values exceeding a reasonable cap) could disable bounded capture:
- `NaN` would make every `Math.min(originalBytes, limit)` comparison `NaN`, disabling truncation logic.
- `Infinity` would disable truncation entirely (unbounded storage).
- A negative value would make the sink store nothing.
- `tailLimit > outputLimit` would invert the tail semantics.
- An unbounded value would allow unbounded memory/disk consumption.

## Fix

### Production code changes (`orchestrator/src/process/containment.ts`)

1. **`RICKGENT_MAX_OUTPUT_LIMIT_BYTES` constant (64 MiB)** — exported; aligns with the ProcessSupervisor's `MAX_OUTPUT_LIMIT_BYTES` so both the containment and supervisor paths enforce the same maximum bound.

2. **`validateDockerOutputLimits(outputLimitBytes, tailLimitBytes)`** — exported fail-closed validation function. Rejects malformed/unbounded values with a `ContainmentUnavailableError`:
   - (a) both must be positive safe integers (`Number.isSafeInteger` returns false for NaN, Infinity, -Infinity, and fractional values; the `value < 1` check rejects zero and negatives),
   - (b) finite (covered by the safe-integer check),
   - (c) both <= 64 MiB (`RICKGENT_MAX_OUTPUT_LIMIT_BYTES`),
   - (d) `tailLimitBytes <= outputLimitBytes`.

3. **`DockerCgroupV2ContainmentBackend.releaseTarget`** — calls `validateDockerOutputLimits(outputLimitBytes, tailLimitBytes)` BEFORE `observeMembership` (and therefore before any `docker exec` spawn), so a malformed configuration fails closed without contacting the Docker daemon for the exec.

4. **`dockerExecStreaming`** — rewritten to propagate sink write/close/integrity failures as a fail-closed infrastructure failure (null exit code) BEFORE success terminalization:
   - Tracks `stdoutWriteFailed`/`stderrWriteFailed` flags set when `sink.write` throws in the stream `data` handlers (the unfixed code swallowed these).
   - Tracks `stdoutCloseFailed`/`stderrCloseFailed` flags set when `sink.close` throws (the unfixed `safeCloseSink` swallowed these and synthesized an empty receipt).
   - Also checks `sink.failure !== null` (the real `BoundedOutputSink.write` records `writeSync` failures internally).
   - After the child closes, if any sink failure is observed (`stdoutCloseFailed || stderrCloseFailed || stdoutWriteFailed || stderrWriteFailed || stdoutSink.failure !== null || stderrSink.failure !== null`), forces the exit code to `null` so the AttemptRunner maps the dispatch to `infrastructure_error` (not success).
   - The `child.on("error")` and spawn-error paths also compute `sinkFailed` and resolve with `exitCode: null`.
   - Returns a `sinkFailed` flag in the result so the caller can observe the failure mode.
   - The inlined `closeSinkOrFail` helper replaces the old module-level `safeCloseSink` (which is removed).

5. **`DockerCgroupV2ContainmentBackend` constructor** — added a `sinkFactory` option (dependency injection, defaults to the real `BoundedOutputSink`). This is a test-only seam unreachable from environment variables; it enables the production-path negative proof to substitute a failing sink and assert the dispatch fails closed without bypassing the real `dockerExecStreaming` code path. The `sinkFactory` is threaded through `releaseTarget` → `dockerExecStreaming`.

### Test changes (`orchestrator/test/reliability/containment-bounded-output-fail-closed.test.ts`)

New test file (23 test cases):

**Defect #2 — `validateDockerOutputLimits` fail-closed validation (17 unit tests, no Docker required):**
- rejects negative outputLimitBytes
- rejects zero outputLimitBytes
- rejects NaN outputLimitBytes
- rejects Infinity outputLimitBytes
- rejects -Infinity outputLimitBytes
- rejects negative tailLimitBytes
- rejects zero tailLimitBytes
- rejects NaN tailLimitBytes
- rejects Infinity tailLimitBytes
- rejects tailLimitBytes > outputLimitBytes
- rejects outputLimitBytes > 64 MiB cap
- rejects tailLimitBytes > 64 MiB cap
- rejects fractional (non-integer) outputLimitBytes
- rejects Number.MAX_SAFE_INTEGER outputLimitBytes (exceeds 64 MiB cap)
- accepts valid bounds: 8 MiB output, 16 KiB tail
- accepts the maximum cap: 64 MiB output, 64 MiB tail (tail === output)
- accepts the minimum bound: 1 byte output, 1 byte tail

**Defect #1 — production-path sink failure fails closed (5 Docker-gated tests):**
- a BoundedOutputSink write failure forces the dispatch to fail closed (outcome !== "succeeded")
- a BoundedOutputSink close/integrity failure forces the dispatch to fail closed (outcome !== "succeeded")
- releaseTarget validates outputLimitBytes before contacting Docker for the exec (negative value)
- releaseTarget validates tailLimit > outputLimit before contacting Docker for the exec
- releaseTarget validates outputLimit > 64 MiB cap before contacting Docker for the exec

**Skip-when-unavailable (1 test):** documents that the Docker-gated proofs require the Docker cgroup-v2 backend and runner image.

The sink failure tests use two `BoundedOutputSink` subclasses injected via the `sinkFactory` constructor option:
- `WriteFailingBoundedOutputSink` — throws from `write` on the second chunk (simulates a real write failure).
- `CloseFailingBoundedOutputSink` — throws from `close` (simulates an integrity check failure).

Both drive the REAL `dockerExecStreaming` and `releaseTarget` code paths via `runBuildViaRunnerForTesting` with a `containmentBackendOverride`. The fixture omnigent produces output AND exits 0, so without the fix the dispatch terminalizes as "succeeded" with a partial/empty receipt. With the fix, the dispatch fails closed.

## Red-then-green proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/containment-bounded-output-fail-closed.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red observation (22 failed, 1 passed):**
- All 17 validation tests failed with `TypeError: (0, __vite_ssr_import_6__).validateDockerOutputLimits is not a function` (the function and `RICKGENT_MAX_OUTPUT_LIMIT_BYTES` did not exist yet — import error).
- The sink write failure test failed with `sink write failure must fail closed (got succeeded): expected 'succeeded' not to be 'succeeded'` — confirming the fail-open: the dispatch succeeded despite the sink write failure being swallowed.
- The sink close failure test failed with `sink close failure must fail closed (got succeeded): expected 'succeeded' not to be 'succeeded'` — confirming the fail-open: the dispatch succeeded despite the close/integrity failure being swallowed.
- The 3 production-path validation tests failed because `releaseTarget` did not validate before spawning (the exec ran and returned a launch result instead of throwing).

**Green command:**
```
cd orchestrator && pnpm vitest run test/reliability/containment-bounded-output-fail-closed.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green observation (23 passed):** All 17 validation tests pass (malformed values throw `ContainmentUnavailableError`; valid values do not throw). Both sink failure tests pass (the dispatch fails closed — `outcome.status !== "succeeded"`). All 3 production-path validation tests pass (`releaseTarget` throws `ContainmentUnavailableError` before contacting Docker for the exec). The skip-when-unavailable test passes.

## Verification

| Check | Result |
|-------|--------|
| `pnpm typecheck` | green (tsc --noEmit clean) |
| `pnpm build` | green (dist/cli.js regenerated, build-commit=dfbd5a81f00b) |
| `pnpm vitest run test/reliability/containment-bounded-output-fail-closed.test.ts` | 23/23 passed |
| `pnpm vitest run test/reliability/containment-bounded-output-fail-closed.test.ts test/reliability/containment-corpus.test.ts test/reliability/process-supervisor-corpus.test.ts` | 49/49 passed (23 + 15 + 11) |
| `RICKGENT_STRESS_ITERATIONS=50 pnpm vitest run test/reliability/concurrency-corpus.test.ts` | 57/57 passed (50 iterations + 5 manifest/summary + 2 over-limit proofs) |
| `python3 -m pytest test/ -p no:cacheprovider -q` (env wired via init.sh) | 367 passed, 3 skipped |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | exit 0, 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW |
| `node orchestrator/dist/cli.js doctor` | exit 0; `parallel_dispatch` still `unavailable` (correct — t23 proves but does not activate) |

## Known limitations

- The `sinkFactory` injection point is a test-only dependency-injection seam (defaults to the real `BoundedOutputSink`, unreachable from environment variables). It exists so the production-path negative proof can substitute a failing sink without bypassing the real `dockerExecStreaming` code path. It is not a production bypass flag.
- The Linux cgroup-v2 backend's `releaseTarget` is not in this ticket's scope (the defect was specifically the Docker path). It does not use `dockerExecStreaming` and is not exercised on macOS.
- The `FixtureContainmentBackend.releaseTarget` produces empty receipts (0 bytes) because it spawns a detached process whose stdout/stderr go to file descriptors. This is unchanged.

## Next dependency boundary

t23 scrutiny round 9 is complete. The streaming BoundedOutputSink capture path now propagates sink write/close/integrity failures as fail-closed infrastructure failures and validates output-limit bounds before spawning. The next milestone is M6 (t24-t26: lifecycle transition table, contract propagation, gate runner).
