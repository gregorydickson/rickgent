# Phase 5 — t23 Output Receipt Production Semantics (Scrutiny Round 7)

**Date:** 2026-07-21
**Ticket:** t23 (M5 concurrency proof)
**Scope:** Fix M5 scrutiny round 7 blocking defect — the output-flood corpus locally reconstructed BoundedOutputReceipt objects, making truncation always false (originalBytes equal to captured bytes) and hashing the artifact PATH instead of BYTES. The corpus did not prove production BoundedOutputReceipt semantics or complete capture of known 65,536-byte fixture streams.

## Problem

The worker fixture (`worker-fixtures.mjs`) contained a test-local `computeReceipt` helper that:

1. **Hashed the artifact PATH instead of BYTES**: `artifactDigest = SHA-256(streamPath)` — the digest was of the file path string, not the actual byte content.
2. **Set originalBytes = storedBytes**: `computeReceipt(content, filePath, content.length)` passed `content.length` as `originalBytes`, making `truncated = storedBytes < originalBytes` always `false`.
3. **Did not use the production BoundedOutputReceipt**: The receipt was reconstructed from reading files on disk, not sourced from the AttemptRunner's dispatch result.

This meant the corpus could not prove that the production BoundedOutputReceipt had:
- (a) independently derived source/stored byte counts
- (b) byte-content artifact digest (SHA-256 of actual bytes, not path)
- (c) truncation flag (true if source > stored, false if complete capture)

## Fix

### Production code changes

1. **`orchestrator/src/process/containment.ts`**:
   - Defined the canonical `BoundedOutputReceipt` interface (independently derived source/stored byte counts, byte-content artifact digest, truncation flag, base64 tail).
   - Added `stdoutReceipt` and `stderrReceipt` fields to `ContainmentLaunch`.
   - Added `computeBoundedOutputReceipt()` helper that computes the receipt from captured content with independently derived fields.
   - Docker `releaseTarget`: computes production receipts from captured stdout/stderr strings (source = total bytes produced, stored = bytes written to file, truncated = source > stored, artifactDigest = SHA-256 of byte content).
   - Posix `releaseTarget`: computes production receipts from captured stdout/stderr.
   - Fixture `releaseTarget`: produces minimal receipts (0 bytes, empty digests, not truncated).

2. **`orchestrator/src/process/supervisor.ts`**:
   - Moved the `BoundedOutputReceipt` interface definition to `containment.ts` (the lower-level module) to avoid circular dependencies.
   - Re-exports `BoundedOutputReceipt` from `containment.ts` so existing consumers continue to resolve.

3. **`orchestrator/src/lifecycle/attempt-runner.ts`**:
   - Added `stdoutReceipt` and `stderrReceipt` fields to `SupervisedDispatchResult`.
   - Added `stdoutReceipt` and `stderrReceipt` fields to `AttemptRunnerResult`.
   - `#defaultDispatch`: passes receipts from `launch.stdoutReceipt`/`launch.stderrReceipt` to `SupervisedDispatchResult`.
   - `#result()`: accepts and passes through the receipts.
   - All 9 `#result()` call sites updated to pass `supervised.stdoutReceipt`/`supervised.stderrReceipt` (or `null` for pre-dispatch failure paths).

4. **`orchestrator/src/lifecycle/build.ts`**:
   - Added `boundedOutputReceipts` field to `BuildResult`.
   - `executeBuildViaRunner`: collects production receipts from `runnerResults` into `BuildResult.boundedOutputReceipts`.
   - Both `base` initializations (runner path + legacy path) include `boundedOutputReceipts: []`.

### Test changes

5. **`orchestrator/test/fixtures/concurrency-corpus/worker-fixtures.mjs`**:
   - Removed the test-local `computeReceipt` helper entirely.
   - Extracts production receipts from `result.boundedOutputReceipts` (the AttemptRunner's dispatch result).
   - Sends `productionReceipt: true` flag to the parent test when both receipts are present.

6. **`orchestrator/test/reliability/concurrency-corpus.test.ts`**:
   - Independently computes expected stdout/stderr content from the known fixture behavior (initial transcript line + flood pattern).
   - Asserts `productionReceipt === true` (the receipt is from the production path, not test-local).
   - Asserts `artifactDigest === SHA-256(expectedContent)` (byte-content digest, NOT path digest).
   - Asserts `streamDigest === SHA-256(expectedContent)` (stream digest matches content when not truncated).
   - Asserts `originalBytes === expectedContent.length` (independently derived source bytes).
   - Asserts `storedBytes === expectedContent.length` (independently derived stored bytes).
   - Asserts `truncated === false` (no truncation since 64KB < 8MB maxBuffer).
   - Added `repeatPattern()` helper to compute expected fixture output.

## Red-then-green proof

**Red command:**
```
RICKGENT_STRESS_ITERATIONS=1 pnpm vitest run test/reliability/concurrency-corpus.test.ts -t "iteration 0"
```

**Red observation:** Test failed with `expected 2 to be +0` — 2 violations from the output-floods scenario:
1. `productionReceipt !== true` (the production receipt flag was false because `result.boundedOutputReceipts` did not exist yet)
2. `stdoutReceipt === null || stderrReceipt === null` (receipts were null because there was no production receipt)

**Green command:**
```
RICKGENT_STRESS_ITERATIONS=1 pnpm vitest run test/reliability/concurrency-corpus.test.ts -t "iteration 0"
```

**Green observation:** Test passed — 1 passed, 5 skipped. The production BoundedOutputReceipt fields match independently computed expectations.

## Verification

| Check | Result |
|-------|--------|
| `pnpm typecheck` | green (tsc --noEmit clean) |
| `pnpm build` | green (dist/cli.js regenerated) |
| `RICKGENT_STRESS_ITERATIONS=50 pnpm vitest run test/reliability/concurrency-corpus.test.ts` | 55/55 passed (50 iterations + 5 manifest/summary tests) |
| `pnpm vitest run test/reliability/process-supervisor-corpus.test.ts test/reliability/containment-corpus.test.ts` | 26/26 passed |
| `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 CRITICAL, 0 HIGH |
| `node orchestrator/dist/cli.js doctor` | parallel_dispatch unavailable (correct) |

## Known limitations

- The Docker containment backend's `dockerExecSilent` uses `spawnSync` with `maxBuffer=8MB`. When the output exceeds 8MB, `spawnSync` truncates and the process is killed. The production receipt reflects the captured (truncated) bytes; the `truncated` flag would be true if source > stored. For the 65,536-byte fixture, the output is well within the 8MB limit, so truncation is false.

## Next dependency boundary

t23 is complete. The next milestone is M6 (t24-t26: lifecycle transition table, contract propagation, gate runner).
