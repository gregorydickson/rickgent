# Phase 4 t22D Fix Round 5: Review Fail-Open, Sticky AgentDir, Omnigent Bypass, Owned-Paths Staging

**Date:** 2026-07-21
**Branch:** `remediation/trust-spine-phase-4`
**Milestone:** M4-t22CD
**Feature:** `m4-fix-review-failopen-sticky-agentdir-omnigent-bypass`

## Summary

Fixed M4 scrutiny round 5 blocking defects: 3 blocking + 1 non-blocking. (1) Review provider fell back to baseline tree when candidate-tree resolution failed, then accepted the nonempty baseline — an unresolvable candidate minted a positive review. Fixed: reject candidate-tree resolution failures; do NOT substitute baseline; fail closed. (2) Containment read sticky process-global `RICKGENT_AGENT_DIR` instead of validated per-request agent directory. Fixed: carry `opts.agentDir` explicitly through `probeContainmentBackend` as a function parameter; do NOT mutate sticky process-global env. (3) Docker image permitted omnigent installation to fail silently; integration test bypassed omnigent with `sh -c` dispatchArgvOverride. Fixed: Dockerfile fails unless `omnigent --version` exits 0; integration test uses real `omnigent run` argv with fixture omnigent mounted via -v. (4) Provider staged worktree changes with `git add -A`. Fixed: owned-paths-only staging (`git add -- <paths>`).

## Red-Then-Green Proof

### Red (before fix)

**Command:**
```
cd orchestrator && pnpm vitest run test/reliability/attempt-runner-round-5-fixes.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red output (key failures):**
```
× defect #1: review provider fails closed on unresolvable candidate tree > the review provider does NOT substitute baselineOid for treeOid in the catch block
× defect #1: review provider fails closed on unresolvable candidate tree > the review provider returns reject when the candidate tree cannot be resolved
× defect #2: containment uses explicit agentDir parameter > probeContainmentBackend does NOT read process.env.RICKGENT_AGENT_DIR for containerAgentDir
× defect #2: containment uses explicit agentDir parameter > executeBuildViaRunner does NOT mutate process.env.RICKGENT_AGENT_DIR
× defect #2: containment uses explicit agentDir parameter > executeBuildViaRunner passes opts.agentDir to probeContainmentBackend
× defect #3a: Dockerfile fails build if omnigent is not installed and executable > the Dockerfile has a RUN step that verifies omnigent --version exits 0
× defect #3a: Dockerfile fails build if omnigent is not installed and executable > the omnigent --version RUN step does NOT permit failure
× defect #3b: integration test uses real omnigent run argv > the Docker integration test does NOT use dispatchArgvOverride
× defect #3b: integration test uses real omnigent run argv > the Docker integration test does NOT use sh -c to bypass the dispatch command
× defect #3b: integration test uses real omnigent run argv > the Docker integration test mounts the fixture omnigent into the container
× defect #4: provider uses owned-paths-only git staging > attempt-runner-providers.ts does NOT use git add -A
× defect #4: provider uses owned-paths-only git staging > attempt-runner-providers.ts uses owned-paths-only staging (git add -- path)

Tests: 12 failed | 2 passed (14)
```

### Green (after fix)

**Command:**
```
cd orchestrator && pnpm vitest run test/reliability/attempt-runner-round-5-fixes.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Green output:**
```
✓ test/reliability/attempt-runner-round-5-fixes.test.ts (14 tests) 6ms

Tests: 14 passed (14)
```

## Defects Fixed

### Defect #1 (BLOCKING): Review provider fail-open on unresolvable candidate tree

**Root cause:** The review provider in `attempt-runner-providers.ts` caught `git rev-parse ${candidateOid}^{tree}` failures and set `treeOid = baselineOid`. Since `baselineOid` is a nonempty string, the subsequent `verdict = treeOid.length > 0 ? "accept" : "reject"` always produced `"accept"`. An unresolvable candidate minted a positive review instead of failing closed.

**Fix:** The catch block now returns `{ verdict: "reject" }` immediately — no baseline substitution. An empty tree resolution also returns reject. The verdict is "accept" only when the candidate tree is a valid, resolved Git tree object. The same fail-open pattern in the verification provider (`candidateTreeOid = baselineOid`) was also fixed to throw `RICKGENT_ATTEMPT_VERIFICATION_ERROR` instead of substituting baseline.

**Files changed:** `orchestrator/src/lifecycle/attempt-runner-providers.ts`

### Defect #2 (BLOCKING): Containment reads sticky process-global RICKGENT_AGENT_DIR

**Root cause:** `probeContainmentBackend` read `process.env.RICKGENT_AGENT_DIR` for the agent directory host mount and `containerAgentDir`. `executeBuildViaRunner` mutated `process.env.RICKGENT_AGENT_DIR = opts.agentDir` before calling the probe. A second build in the same process with a different `agentDir` could inherit the first build's sticky process-global agent directory, mounting the wrong bundle.

**Fix:** `probeContainmentBackend` now accepts `agentDir` as an explicit parameter in its opts. The probe uses `opts.agentDir` (not `env.RICKGENT_AGENT_DIR`) for both the host mount and `containerAgentDir`. `executeBuildViaRunner` passes `opts.agentDir` to `probeContainmentBackend` and no longer mutates `process.env.RICKGENT_AGENT_DIR`.

**Files changed:** `orchestrator/src/process/containment.ts`, `orchestrator/src/lifecycle/build.ts`

### Defect #3 (BLOCKING): Dockerfile permits omnigent install to fail; integration test bypasses omnigent

**Root cause (a):** The Dockerfile used `pip install ... || echo "warning: ..."` which permitted omnigent installation to fail silently. The `which omnigent || true` step also permitted failure. The image could be built without a working omnigent.

**Fix (a):** The Dockerfile now installs all omnigent dependencies (pyyaml, openai, rich, etc.) first, then installs the three sibling packages (omnigent, omnigent-client, omnigent-ui-sdk) with `--no-deps`. A `RUN omnigent --version` step fails the Docker build if omnigent is not installed and executable. No `|| echo` or `|| true` fallbacks.

**Root cause (b):** The integration test used `dispatchArgvOverride: ["sh", "-c", "mkdir -p src && ..."]` to bypass the real `omnigent run` dispatch argv. This proved nothing about the production dispatch command.

**Fix (b):** The integration test now uses a real `DockerCgroupV2ContainmentBackend` (configured with the fixture omnigent mounted via -v volume mount, the fixture directory on the container PATH, and `FIXTURE_MODE=prompt` set via `extraEnv`). The real `omnigent run <agentDir> --no-session -p <prompt>` argv is used — no `dispatchArgvOverride`, no `sh -c` bypass. The fixture omnigent is a bash script that delegates to `fixture.mjs` (a node script); the Dockerfile installs nodejs so the fixture runs inside the container. The test proves the advertised omnigent command is runnable in the production container without any override.

**Files changed:** `docker/runner.Dockerfile`, `orchestrator/src/process/containment.ts` (added `extraEnv` support), `orchestrator/test/reliability/attempt-runner-real-providers-docker-integration.test.ts`

### Defect #4 (NON-BLOCKING): Provider stages with git add -A

**Root cause:** The `observeCandidateOid` function in `attempt-runner-providers.ts` used `execFileSync("git", ["-C", worktreePath, "add", "-A"])` to stage uncommitted changes — staging all files, not just owned paths.

**Fix:** `observeCandidateOid` now accepts `ownedPaths: readonly string[]` (derived from the contract scope) and uses `execFileSync("git", ["-C", worktreePath, "add", "--", ...ownedPaths])` — owned-paths-only staging. Both callers (`commitAttribution` and `verification`) pass `input.contract.scope.map((s) => s.path)` as the owned paths.

**Files changed:** `orchestrator/src/lifecycle/attempt-runner-providers.ts`

## Files Changed

- `orchestrator/src/lifecycle/attempt-runner-providers.ts` — defect #1 (review/verification fail-closed), defect #4 (owned-paths staging)
- `orchestrator/src/process/containment.ts` — defect #2 (agentDir parameter), defect #3 (extraEnv support)
- `orchestrator/src/lifecycle/build.ts` — defect #2 (pass agentDir to probe, no sticky env mutation)
- `docker/runner.Dockerfile` — defect #3a (strict omnigent install + `omnigent --version` check)
- `orchestrator/test/reliability/attempt-runner-round-5-fixes.test.ts` (NEW) — 14 tests covering all 4 defects
- `orchestrator/test/reliability/attempt-runner-real-providers-docker-integration.test.ts` — defect #3b (real omnigent run argv, fixture mounted, no dispatchArgvOverride), updated defect #2 structural test

## Verification

- **typecheck:** green (0 errors)
- **build:** green (dist/cli.js refreshed, build-commit 460bdf1e291f)
- **vitest scoped M4 (16 files):** 189/189 passed (15 original M4 files + 1 new round-5 file)
- **vitest Docker integration:** 12/12 passed (including defect #3 with real omnigent run argv + fixture omnigent mounted)
- **pytest:** 367 passed, 3 skipped
- **citadel:** 0 CRITICAL, 0 HIGH (1 MEDIUM, 1 LOW — pre-existing)
- **doctor:** exit 0, autonomous_dispatch enabled with proof=attempt-runner-critical-section-v1

## Known Limitations

None. All 4 defects are fixed, all 14 round-5 tests pass, all 12 Docker integration tests pass with the real omnigent run argv, and all validators are green.

## Next Dependency Boundary

M4-t22CD is complete. All scoped M4 suites pass, the Docker integration test passes with the real omnigent run argv (no bypass), and all validators (typecheck, pytest, citadel, doctor) are green. The next milestone is M5 (t23 concurrency proof).
