# Phase 5 — t23 Streaming BoundedOutputSink (Scrutiny Round 8)

**Date:** 2026-07-21
**Ticket:** t23 (M5 concurrency proof)
**Scope:** Fix M5 scrutiny round 8 blocking defect — the Docker containment backend computed its `BoundedOutputReceipt` from stdout/stderr captured by `dockerExecSilent`'s `spawnSync` with `maxBuffer=8 MiB`. Bytes beyond that limit were silently dropped by Node, so `originalBytes` could never exceed the captured bytes and `truncated` remained `false` for over-limit output. The production receipt did not reflect total produced bytes.

## Problem

`DockerCgroupV2ContainmentBackend.releaseTarget` used `dockerExecSilent` (a `spawnSync` wrapper with `maxBuffer=8 MiB`) to capture the target's stdout/stderr, then computed the `BoundedOutputReceipt` from the captured strings via `computeBoundedOutputReceipt`. When the target produced more than 8 MiB on a stream, `spawnSync` truncated the captured buffer at `maxBuffer` and killed the process; the bytes beyond the limit were absent from the captured string. The receipt therefore reported:

- `originalBytes` = captured bytes (≤ 8 MiB), NOT the total bytes produced.
- `storedBytes` = `min(originalBytes, limit)` = captured bytes (no truncation at the configured limit).
- `truncated` = `originalBytes > storedBytes` = `false` (always false because `originalBytes` was derived from the already-truncated capture).

This meant the production receipt could not prove it counted ALL bytes produced before truncation, and the `truncated` flag was structurally false for any output exceeding the `spawnSync` `maxBuffer` regardless of the configured output limit.

## Fix

### Production code changes

1. **`orchestrator/src/process/containment.ts`** — moved the canonical `BoundedOutputSink` class here (exported) so both the containment and supervisor paths produce the same receipt shape from the same streaming sink. The sink:
   - counts EVERY byte observed on a stream (`originalBytes`) by updating `streamDigest` (SHA-256) over all chunks,
   - writes the leading `limit` bytes to the output file and updates `artifactDigest` (SHA-256) over the STORED bytes only,
   - retains the last `tailLimit` bytes of the OBSERVED stream for the base64 tail,
   - on `close()`, returns a frozen `BoundedOutputReceipt` with `originalBytes` = total bytes observed, `storedBytes` = bytes actually stored (`min(originalBytes, limit)`), `truncated` = (`originalBytes > limit`), `artifactDigest` = SHA-256(stored bytes), `streamDigest` = SHA-256(all bytes).
   - Constructor option `strictDirectorySafety` (default `true`): the supervisor's worktree-private output dirs use strict mode (O_EXCL, directory mode/owner checks); the Docker containment's tmpdir-derived paths use relaxed mode (O_TRUNC, no directory mode check) so multiple `releaseTarget` calls on the same boundary (which reuse the launchId-derived default path) do not fail on a stale artifact. O_NOFOLLOW is retained in both modes.

2. **`orchestrator/src/process/containment.ts`** — added `dockerExecStreaming`, a `child_process.spawn`-based streaming capture helper that replaces the `spawnSync`+`maxBuffer` capture in `DockerCgroupV2ContainmentBackend.releaseTarget`. It streams the child's stdout/stderr through two `BoundedOutputSink` instances, applies a `setTimeout`-driven timeout that SIGKILLs the child, and resolves with `{ exitCode, timedOut, stdoutReceipt, stderrReceipt }`. Fail-closed: a spawn error or sink-open failure produces a `null` exit code (the AttemptRunner maps this to `infrastructure_error`); a sink-close failure synthesizes an empty receipt (zero bytes, empty digest) so the caller cannot mistake it for captured output.

3. **`orchestrator/src/process/containment.ts`** — `DockerCgroupV2ContainmentBackend.releaseTarget` now:
   - accepts `outputLimitBytes` and `tailLimitBytes` in its opts (defaulting to 8 MiB / 16 KiB),
   - calls `dockerExecStreaming` instead of `dockerExecSilent` + `writeFileSync` + `computeBoundedOutputReceipt`,
   - derives `stdoutDigest`/`stderrDigest` from the receipt's `streamDigest` (SHA-256 of all observed bytes).

4. **`orchestrator/src/process/supervisor.ts`** — removed the private `BoundedOutputSink` class and the now-unused `PRIVATE_DIRECTORY_MODE`/`PRIVATE_FILE_MODE` constants and fs imports; imports `BoundedOutputSink` from `./containment.js`. The supervisor constructs the sink with the default strict mode (3-arg constructor), preserving all existing worktree-private-directory safety checks and the established tail semantics (last `tailLimit` bytes of the observed stream).

5. **`orchestrator/src/lifecycle/attempt-runner.ts`** — added `outputLimitBytes` and `tailLimitBytes` (optional, `number | undefined`) to `DispatchInput` and `AttemptRunnerRequest`; `#defaultDispatch` passes them through to `containment.releaseTarget`.

6. **`orchestrator/src/lifecycle/build.ts`** — added `outputLimitBytes` and `tailLimitBytes` (optional) to `BuildOptions`; `executeBuildViaRunner` passes them through to the `AttemptRunnerRequest`.

### Test changes

7. **`orchestrator/test/fixtures/concurrency-corpus/worker-fixtures.mjs`** — added `scenarioFloodOutputOverLimit`, a new worker scenario that drives `runBuildViaRunnerForTesting` with a configurable `outputLimitBytes` (via `BuildOptions.outputLimitBytes`) and a fixture omnigent that produces `floodBytes` EXCEEDING the limit. The receipt is sourced from `result.boundedOutputReceipts` (the AttemptRunner's real production dispatch result), NOT a test-local reconstruction.

8. **`orchestrator/test/reliability/concurrency-corpus.test.ts`** — added a new `describe` block "t23 concurrency corpus — over-limit output production proof" with two test cases:
   - **Over-limit case:** fixture produces 512 KiB > 256 KiB limit. Asserts `originalBytes > storedBytes`, `truncated === true`, `storedBytes === limit`, `artifactDigest === SHA-256(stored bytes)`, `streamDigest === SHA-256(all bytes)`, `artifactDigest !== streamDigest`, `tailBase64 === base64(last tailLimitBytes of full stream)`, `outcome === "succeeded"`, StateStore integrity maintained.
   - **Under-limit case:** fixture produces 64 KiB < 256 KiB limit. Asserts `originalBytes === storedBytes`, `truncated === false`, `artifactDigest === streamDigest === SHA-256(full content)`, `outcome === "succeeded"`.

## Red-then-green proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/concurrency-corpus.test.ts -t "over-limit output production proof" --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red observation:** The over-limit test failed with `stdout storedBytes 524319 !== limit 262144: expected 524319 to be 262144`. The unfixed `spawnSync`+`maxBuffer=8 MiB` capture captured all 524319 bytes (under the 8 MiB maxBuffer) and `computeBoundedOutputReceipt` reported `storedBytes = 524319` (the configured 256 KiB limit was not honored), `originalBytes = 524319`, `truncated = false`. The `outputLimitBytes` opt was not plumbed through to the releaseTarget, so the production receipt did not truncate at the configured limit.

**Green command:**
```
cd orchestrator && pnpm vitest run test/reliability/concurrency-corpus.test.ts -t "over-limit output production proof" --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green observation:** Both over-limit and under-limit tests passed. The streaming `BoundedOutputSink` counted all 524319 bytes produced (`originalBytes = 524319`), stored only the first 256 KiB (`storedBytes = 262144`), set `truncated = true`, computed `artifactDigest = SHA-256(first 256 KiB)`, `streamDigest = SHA-256(all 524319 bytes)`, and `tailBase64 = base64(last 1024 bytes of the full stream)`. The under-limit case confirmed `originalBytes === storedBytes === 65567`, `truncated = false`, `artifactDigest === streamDigest`.

## Verification

| Check | Result |
|-------|--------|
| `pnpm typecheck` | green (tsc --noEmit clean) |
| `pnpm build` | green (dist/cli.js regenerated) |
| `RICKGENT_STRESS_ITERATIONS=50 pnpm vitest run test/reliability/concurrency-corpus.test.ts` | 57/57 passed (50 iterations + 5 manifest/summary + 2 over-limit proofs) |
| `pnpm vitest run test/reliability/process-supervisor-corpus.test.ts test/reliability/containment-corpus.test.ts` | 26/26 passed |
| `pnpm vitest run test/reliability/attempt-runner-production-wiring.test.ts test/reliability/attempt-runner-real-providers-docker-integration.test.ts test/reliability/attempt-runner-providers-and-container-env.test.ts` | 28/28 passed |
| `python3 -m pytest test/ -p no:cacheprovider -q` (env wired via init.sh) | 367 passed, 3 skipped |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | exit 0, 0 CRITICAL, 0 HIGH (MEDIUM schema-registry-drift findings are pre-existing heuristic false positives on files in the diff) |
| `node orchestrator/dist/cli.js doctor` | exit 0; `parallel_dispatch` still `unavailable` (correct — t23 proves but does not activate) |

## Known limitations

- The Linux cgroup-v2 backend's `releaseTarget` still uses `execFileSync` with `maxBuffer=8 MiB` and `computeBoundedOutputReceipt` from the captured content. It is not exercised on macOS (the probe fails closed) and is not in this ticket's scope (the defect was specifically the Docker path). A future ticket can migrate it to the streaming `BoundedOutputSink` for consistency.
- The `FixtureContainmentBackend.releaseTarget` produces empty receipts (0 bytes) because it spawns a detached process whose stdout/stderr go to file descriptors (not captured in memory). This is unchanged; the fixture backend is not the production Docker path.

## Next dependency boundary

t23 streaming output capture is complete. The next milestone is M6 (t24-t26: lifecycle transition table, contract propagation, gate runner).
