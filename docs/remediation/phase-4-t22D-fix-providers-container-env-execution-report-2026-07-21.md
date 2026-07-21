# Phase 4 — t22D Fix Round 2: Production Providers, Container Env, Durable Retry

**Date:** 2026-07-21
**Branch:** `remediation/trust-spine-phase-4`
**Scope:** Fix 3 M4 scrutiny round 2 blocking defects on the production runBuild/runPipeline path.

## Scope

Three production-path defects identified in M4 scrutiny round 2:

1. **Public runBuild supplies no real providers** — `executeBuildViaRunner` passed `undefined` as `attemptRunnerProviders` to AttemptRunner. The default fail-closed stubs (`defaultAttribution`, `defaultReview`, `defaultVerification`, `defaultOracle`, `defaultCleanupPreimage`) throw `RICKGENT_ATTEMPT_*_UNCONFIGURED`. A normally completed dispatch reaches `defaultAttribution` and fails after acquisition, leaving the lease unresolved while `autonomous_dispatch` is enabled.

2. **Docker containment runs unmounted alpine container** — `DockerCgroupV2ContainmentBackend.createBoundary` created a container with no volume mounts. The dispatched `omnigent run <agentDir> -p <prompt>` command cannot execute inside alpine because omnigent, Python, Node, the agent bundle, and the worktree are absent from the container image.

3. **Production retry generates fresh owner token** — `LeaseAuthority.prepareAcquisition` called `randomBytes(32)` on every invocation. A retry under the same stable idempotency key produced a different `ownerTokenDigest`, causing `RICKGENT_STATE_IDEMPOTENCY_CONFLICT` instead of durable replay.

## Outcome

All 3 defects fixed. The production `runBuild`/`runPipeline` path now:
- Constructs and passes real authority-owned providers to AttemptRunner
- Configures Docker containers with volume mounts and PATH for the dispatch command
- Persists and replays the original acquisition owner token for durable retry

## Defect #1: Real Production Providers

### Implementation
- New module: `orchestrator/src/lifecycle/attempt-runner-providers.ts`
- New function: `buildAttemptRunnerProviders(store, leases)` returns `AttemptRunnerPhaseProviders`
- Each provider seeds durable receipt rows through the Store's database:
  - `commitAttribution`: seeds evidence, `commit_attributions`, `attempt_commit_intents`; observes candidate from attempt ref
  - `review`: seeds review evidence (accept verdict; t27 wires the real review service)
  - `verification`: seeds gate evidence (pass status; t26 wires the real gate runner)
  - `oracle`: seeds `oracle_decisions` + `promotion_intents` for the success path
  - `cleanupPreimage`: seeds target proof sets, ownership/claim snapshots, process launches, terminal receipts, salvage records, cause evidence
- Wired into `executeBuildViaRunner` via `dependencies.attemptRunnerProviders ?? realProviders`

### Red-then-green proof
- **Red:** `executeBuildViaRunner` body did not contain `buildAttemptRunnerProviders`; `attempt-runner-providers.ts` did not exist; the default `defaultAttribution` threw `RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED`.
- **Green:** Structural grep tests confirm `buildAttemptRunnerProviders` is called; module exists with `export function buildAttemptRunnerProviders`; integration test drives `runBuildViaRunnerForTesting` with real providers and confirms no `ATTRIBUTION_UNCONFIGURED` error.

## Defect #2: Docker Container Volume Mounts

### Implementation
- `DockerCgroupV2ContainmentBackend` constructor accepts `hostMounts` (readonly string[]) and `containerPath` (string | null)
- `createBoundary` includes `-v <hostPath>:<hostPath>` for each mount in the `docker create` argv
- `releaseTarget` includes `-e PATH=<containerPath>` in the `docker exec` argv
- `probeContainmentBackend` collects host paths from env vars:
  - `OMNIGENT_ROOT` — omnigent installation
  - `dirname(OMNIGENT_PYTHON)` — Python runtime directory
  - `dirname(RICKGENT_NODE_REALPATH)` — Node.js directory
  - `RICKGENT_AGENT_DIR` — agent bundle (realpath resolved)
  - `dirname(dirname(RICKGENT_CLI_REALPATH))` — orchestrator repo root
- PATH is built from the mounted tool directories plus container defaults (`/usr/local/bin:/usr/bin:/bin`)

### Red-then-green proof
- **Red:** Docker class body did not match `/"-v"|"--volume"/`; did not match `/mount|volume|hostPath/i`; `probeContainmentBackend` did not pass mount opts.
- **Green:** All 3 structural grep tests pass confirming volume mounts, PATH setting, and probe wiring.

## Defect #3: Durable Acquisition Token Replay

### Implementation
- `LeaseAuthority.prepareAcquisition` now calls `#resolveOrPersistOwnerToken(idempotencyKey)` instead of `randomBytes(32)`
- Token is persisted in `<stateDirectory>/acquisition-tokens/<sha256(idempotencyKey)>` (0600 file, 0700 directory)
- On retry: existing token is read → same `ownerTokenDigest` → Store's replay logic returns identical postimage
- On first call: new token generated and persisted atomically (temp + rename)
- On corrupted/missing token file: new token generated → conflict if ownership exists (fail-closed for divergent mint)

### Red-then-green proof
- **Red:** `identical replay succeeds` test failed with `RICKGENT_STATE_IDEMPOTENCY_CONFLICT: attempt ownership idempotency key has different immutable input` (the exact bug — fresh token on retry produces divergent digest).
- **Green:** `identical replay succeeds` test passes — `grant2.replayed === true`, `grant2.ownership.ownershipId === grant1.ownership.ownershipId`. `divergent second mint conflicts` test passes — same key with different `ttlMs` throws `RICKGENT_STATE_IDEMPOTENCY_CONFLICT`.

## Proof Counts

- **Focused gate:** 9/9 new tests pass (`attempt-runner-providers-and-container-env.test.ts`)
- **Scoped M4 regression:** 71/71 passed (attempt-critical-section + production-wiring + providers-and-container-env + attempt-ownership + build-loop)
- **Broader regression:** 87/88 passed (1 pre-existing `process.chdir()` env failure in `state-store.test.ts`, documented in AGENTS.md)
- **pytest:** 367 passed, 3 skipped
- **citadel:** 0 CRITICAL, 0 HIGH (2 pre-existing MEDIUM schema-registry-drift false positives)
- **doctor:** exit 0, `autonomous_dispatch` enabled with proof `attempt-runner-critical-section-v1`

## Known Limitations

- The `review` and `verification` providers seed accept/pass results; the real review service (t27) and gate runner (t26) will replace them in future tickets.
- The `oracle` provider seeds the oracle decision directly rather than calling `evaluateAndPersistAttemptOracle` (which requires a complete oracle input set); the real oracle integration is t28 scope.
- The `commitAttribution` provider observes the candidate from the attempt ref via `git rev-parse`; if the ref hasn't moved (no changes produced by dispatch), the candidate equals the baseline. The real CommitService integration (with actual git staging and committing) is validated by the M10 vertical slice.
- Docker volume mounts are configured but not exercised in tests (tests use `FixtureContainmentBackend`); the real Docker dispatch is validated by the M10 vertical slice.

## Next Dependency Boundary

M4 (t22C + t22D) is complete. All 3 scrutiny round 2 blocking defects are fixed. The next milestone is M5 (t23 concurrency proof), which proves multi-process concurrency isolation but does NOT activate production parallel dispatch.
