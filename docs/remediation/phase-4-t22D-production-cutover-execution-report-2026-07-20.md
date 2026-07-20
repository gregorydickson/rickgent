# Phase 4 — t22D Production Cutover and Legacy Removal — Execution Report

**Date:** 2026-07-20
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t22 (Integrate the attempt ownership critical section), tranche D
**Status:** Complete (t22D done; t22 parent tranche complete)

## Scope

t22D is the production cutover and legacy removal, the final tranche within
t22.  It removes the shared/legacy run worktree, direct Dispatcher spawn and
supervision, caller-checkout gates, legacy TicketLock/finally-release, and
generic cleanup finalization from the production execution path.  The single
`AttemptRunner` (composed in t22C) becomes the sole owner of execution and
terminalization on the production `runBuild`/`runPipeline` path.
`DispatchQueue` remains only as sequential scheduling/diagnostic plumbing and
cannot convert an unknown runner failure into released ownership.  The
`autonomous_dispatch` capability is activated ONLY after the t22A–t22D proof
corpus is green, with `doctor` reporting the activated state and the correct
proof reference.

## Implementation

### Production cutover (`orchestrator/src/lifecycle/build.ts`)

The production `runBuild`/`runPipeline` entrypoints now route through a new
`executeBuildViaRunner`/`executePipelineViaRunner` path.  The legacy
`executeBuild` (renamed `executeBuildLegacy`) is retained ONLY as the
package-private fixture-bridge body (`runBuildWithDependenciesForTesting`); it
is not a production caller.

`executeBuildViaRunner`:
1. Runs the shared pre-dispatch phase (`prepareBuildPhase`): env/capability
   gates, PRD + strict contract gate, plan gate, policy-attachment gate, model
   roster, and canonical StateStore run/attempt allocation.  No workspace
   provisioning or dispatch happens here.
2. Probes the authority-owned containment backend (`probeContainmentBackend`).
   When containment is unavailable the production path fails closed with an
   infrastructure error (`containment` gate) and a target-never-released
   outcome — **no legacy run-workspace/direct-dispatcher fallback** is
   provisioned.  This is the cutover: the legacy run worktree is removed from
   production execution.
3. When containment is available, constructs the `AttemptRunner` with the real
   authorities (StateStore, LeaseAuthority, ContainmentBackend,
   TargetStartGateAuthority, AttemptTerminalizationService,
   AttemptExecutionContextAuthority) and runs each attempt through the runner.
   The `DispatchQueue` feeds tickets to the runner sequentially
   (scheduling/diagnostic plumbing only); it cannot release ownership.

The legacy `executeBuildLegacy` retains the run-workspace/direct-dispatcher/
caller-checkout/TicketLock/finally-release/generic-cleanup path for the
fixture bridge only.  The `attemptAuthoritySubstrateProvider` interim bridge
(t22A fix round 2) is superseded by the runner; the production path does not
reference it.

### DispatchQueue — scheduling/diagnostic only (`orchestrator/src/dispatch/queue.ts`)

The queue was already fail-closed: a throwing `dispatchFn` produces a
`failed`/`infrastructure_error` entry with `ownershipReleased !== true`.  t22D
adds an explicit negative proof (`attempt-runner-production-cutover.test.ts`)
that an unknown runner failure (opaque throw) cannot be converted into
released ownership.  The queue is sequencing/diagnostic plumbing; only the
AttemptRunner can terminalize and release ownership through authority-minted
disposition receipts.

### Capability activation (`orchestrator/src/capabilities/registry.ts`)

`autonomous_dispatch` is activated:
- `state`: `fixture_only` → `enabled`
- `error_code`: `RICKGENT_AUTONOMOUS_FIXTURE_ONLY` → `RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE`
- `proof_version`: `native-policy-lifecycle-v1` → `attempt-runner-critical-section-v1`
- `reason`: "Activated by t22D: the single AttemptRunner owns execution and terminalization; production requires a validated containment backend and fails closed when unavailable."
- `minimum_profile`: `m2_local_structured_worker` → `m4_attempt_runner_containment`

The public surface entries for `rickgent build <prd>`, `rickgent pipeline
<prd>`, and `build|pipeline [--max-concurrent 1]` are updated from
`public_blocked` to `public_local_artifact` reflecting the activated
autonomous dispatch via the AttemptRunner (delivery, parallelism, resume, raw
shell, and cross-vendor review remain unavailable).  The claim matrix blocks
in `README.md` and `docs/reliability-preview.md` are regenerated to match.

`doctor` reports `autonomous_dispatch` state=`enabled` with proof
`attempt-runner-critical-section-v1` (verified by
`attempt-runner-production-cutover.test.ts` and the doctor JSON assertion).

### Remaining capabilities unchanged

`parallel_dispatch`, `resume_retry`, `reconciliation`, `cross_vendor_review`,
`automatic_delivery`, and `raw_shell` remain `unavailable`.  Activating any of
them is a separate explicit decision owned by a later tranche/milestone.

## Test Coverage

### `attempt-runner-production-cutover.test.ts` (6 tests, new)

- VAL-T22CD-006: `autonomous_dispatch` activated with proof
  `attempt-runner-critical-section-v1`; remaining capabilities unavailable.
- VAL-T22CD-006: `doctor --json` reports `autonomous_dispatch` enabled with
  the proof reference.
- VAL-T22CD-005: production `runBuild` does NOT provision the legacy run
  worktree/ref/worktree-registration and does NOT mutate caller HEAD; it
  fails closed at the containment gate (no docker on PATH) with an
  infrastructure error.
- VAL-T22CD-005: production `runPipeline` fails closed at the reconciliation
  capability gate (still unavailable — t29 scope) before any legacy
  provisioning; no legacy run ref created.
- VAL-T22CD-005: `DispatchQueue` cannot convert an unknown runner failure
  into released ownership (fail-closed entry, `ownershipReleased !== true`).
- VAL-T22CD-005: the `executeBuildViaRunner` source body does not reference
  `provisionRunWorkspace`/`finalizeRunWorkspace`/`callerRepositoryUnchanged`/
  `new Dispatcher`/`TicketLock`; it routes through
  `AttemptRunner`/`probeContainmentBackend`.

### Updated existing tests

- `capability-contraction.test.ts`: registry state list updated to `enabled`
  for `autonomous_dispatch`; `runBuild` now proceeds past the gate and fails
  closed at the ticket-contract gate (missing PRD); the
  autonomous_dispatch-gated toolbelt assertions are removed from the
  "guards direct dispatch" section (those commands now proceed past the
  gate and are exercised through the dist-fixture tree); the
  `build --resume` startup path is used for the registry-output check.
- `claims-contract.test.ts`: the public-surface local-artifact inventory
  includes build/pipeline/--max-concurrent 1; the "agent-backed legacy
  variants" test is replaced with a still-unavailable flag-combination test
  (--resume/--feature/--raw-shell fail before spawn); the public-capability-
  exits test reflects that `build <prd>` now exits 2 (input contract, missing
  PRD) and `build --resume` exercises the capability-gate registry output.
- `packed-capability-boundary.test.ts`: `runBuild`/`main` no longer reject
  with the fixture-only autonomous error; they proceed past the gate (using
  the REAL gate, not the injected fakeDependencies) and fail closed on the
  missing PRD/file with `injected === false`.
- `fail-closed-aggregation.test.ts`: the "public unavailable capability" test
  is updated to reflect the activated capability; the production build now
  proceeds past the capability gate and fails closed at evidence_unverifiable
  (exit 6) with no RICKGENT_DIR side effects.
- `state-observation.test.ts`: the schemaVersion expectation is updated from
  4 to 5 (the 005 migration advanced the schema to v5 during t22A; this was a
  pre-existing stale expectation).

## Verification

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `pnpm typecheck` | Pass (0 errors) |
| Build | `pnpm build` | Pass (dist/cli.js regenerated) |
| t22D cutover | `pnpm vitest run test/reliability/attempt-runner-production-cutover.test.ts` | 6/6 pass |
| Capability contraction | `pnpm vitest run test/reliability/capability-contraction.test.ts` | 7/7 pass |
| Claims contract | `pnpm vitest run test/reliability/claims-contract.test.ts` | 9/9 pass |
| Packed capability boundary | `pnpm vitest run test/reliability/packed-capability-boundary.test.ts` | 1/1 pass |
| Fail-closed aggregation | `pnpm vitest run test/reliability/fail-closed-aggregation.test.ts` | 9/9 pass |
| State observation | `pnpm vitest run test/reliability/state-observation.test.ts` | 3/3 pass |
| Attempt critical section (t22C) | `pnpm vitest run test/reliability/attempt-critical-section.test.ts` | 25/25 pass (unchanged) |
| Full TS regression | `pnpm vitest run --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism` | all pass except 2 pre-existing native-policy-attachment env failures (confirmed pre-t22D via git stash) |
| Python policies | `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped |
| Citadel | `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | exit 0; 0 CRITICAL, 0 unguarded trap doors; 5 HIGH pre-existing in t22C attempt-runner.ts |
| Doctor | `node orchestrator/dist/cli.js doctor` | exit 0; autonomous_dispatch enabled, proof=attempt-runner-critical-section-v1 |

## Negative proofs

- **Crash/fail-closed (containment unavailable):** production `runBuild` with
  no containment backend fails closed at the containment gate with an
  infrastructure error and creates no legacy run worktree/ref.
- **No legacy fallback:** the `executeBuildViaRunner` body is grep-audited to
  contain no `provisionRunWorkspace`/`finalizeRunWorkspace`/
  `callerRepositoryUnchanged`/`new Dispatcher`/`TicketLock` references.
- **DispatchQueue no-release:** an unknown runner failure (opaque throw)
  produces a fail-closed `infrastructure_error` entry with
  `ownershipReleased !== true`; the queue cannot release ownership.
- **Capability activation gating:** `autonomous_dispatch` is `enabled` with
  proof `attempt-runner-critical-section-v1`; the remaining six capabilities
  remain `unavailable`; `doctor` reports the activated state.

## Key Design Decisions

### Production vs fixture-bridge split

The legacy `executeBuild` path is preserved as `executeBuildLegacy`, reachable
ONLY through the package-private fixture bridge
(`runBuildWithDependenciesForTesting`/`runPipelineWithDependenciesForTesting`,
which requires the fixture runtime authority excluded from the npm artifact).
The production `runBuild`/`runPipeline` route through `executeBuildViaRunner`.
This keeps the deterministic fixture mutation-capture tests (build-loop,
e2e-gated-pipeline, backpressure-queue) green via the dist-fixture tree while
removing the legacy path from production.

### Containment-unavailable fail-closed

The production path probes containment and fails closed when unavailable
(target-never-released).  In test environments without Docker on PATH, this is
the exercised branch.  The full positive path (containment available + real
ProcessSupervisor/CommitService provider wiring) is validated by the t22C
composition proof (with FixtureContainmentBackend) and the M10 protected
vertical slice.  The runner's default phase providers fail closed
(`RICKGENT_ATTEMPT_*_UNCONFIGURED`) until the live provider wiring is exercised
by M10; the runner is the sole owner either way (no legacy execution/cleanup/
workspace owner is invoked on the production path).

### Toolbelt commands (prd/szechuan/anatomy/refine/microverse/cronenberg)

These commands require `autonomous_dispatch` and now proceed past the gate.  In
the source-tree test environment they spawn `omnigent run` (non-deterministic),
so the capability-contraction test no longer asserts the fixture-only rejection
for them; they are exercised through the dist-fixture tree where the runtime
gate is replaced.  Their production behavior (autonomous dispatch via the
configured agent bundles) is the activated capability's intended outcome.

## Known limitations

- The full live positive production path (real containment + real model
  roster + real ProcessSupervisor/CommitService phase providers) is M10
  vertical-slice scope.  The t22D cutover removes the legacy path, routes
  production through AttemptRunner, activates the capability, and fails closed
  when containment is unavailable.
- `runPipeline` requires `reconciliation` (still unavailable — t29 scope) for
  its cleanup chain; it fails closed at the capability gate before the build.

## Next dependency boundary

t23 (M5 concurrency proof) — proves conflicting concurrency isolation across
independent attempts without enabling production parallelism
(`parallel_dispatch` remains `unavailable`).
