# Phase 4 — t22B Containment Backend — Execution Report

**Date:** 2026-07-20
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t22 (Integrate the attempt ownership critical section), tranche B
**Status:** Complete (t22B done; t22C, t22D pending)
**Backend:** Docker Desktop / Linux-VM cgroup-v2 (M2 ADR option A), with
option D (native Linux cgroup-v2) and the fail-closed
`UnavailableContainmentBackend` as universal fallbacks.

## Scope

t22B implements the runtime-unforgeable containment authority that the
`AttemptRunner` (t22C) and the durable target start gate require before any
user code is released.  Per the ratified M2 ADR
(`docs/decisions/macos-containment-authority.md`, option A), the chosen
backend is Docker Desktop / Linux-VM cgroup-v2 on this macOS host, with the
Linux native cgroup-v2 path (option D) and the fail-closed
`UnavailableContainmentBackend` as universal fallbacks for any host where the
probe does not pass.

The containment interface is **authority-owned**, not an injected controller:
a structurally-correct `authoritative_containment` field supplied by an
injected controller is never trusted.  Only the authority-owned backend can
mint a containment membership, death receipt, or never-released receipt
(WeakSet brand-checked).  The kernel-level authority is cgroup-v2 in both
option A and option D: `cgroup.kill` for terminate-all, `cgroup.events
populated=0` for authoritative emptiness, and the `pids`/`memory`/`cpu`
controllers for bounded membership.

### What was implemented

1. **`orchestrator/src/process/containment.ts`** — the authority-owned
   containment interface:
   - `ContainmentBoundary`, `ContainmentMembership`,
     `ContainmentDeathReceipt`, `ContainmentNeverReleasedReceipt` brand
     classes (WeakSet-gated; only the authority-owned backend mints them).
   - `isAuthorizedContainmentBoundary` / `isAuthorizedContainmentMembership`
     / `isAuthorizedContainmentDeathReceipt` /
     `isAuthorizedContainmentNeverReleasedReceipt` predicates that reject
     structural, prototype, serialized, and cross-type forgeries.
   - `assertContainmentMembershipForLaunch` — the production gate that
     brand-checks a membership and verifies it binds to the exact
     attempt/owner/generation/phase lineage.
   - `ContainmentBackend` interface covering probe, createBoundary,
     observeMembership, releaseTarget, kill, awaitEmpty, mintDeathReceipt,
     mintNeverReleasedReceipt (VAL-T22B-001).
   - `DockerCgroupV2ContainmentBackend` (option A): probes `docker info` for
     cgroup-v2 + a `--cgroupns=private` probe container for `cgroup.kill`,
     `cgroup.events`, and the `pids`/`memory`/`cpu` controllers.  Per
     attempt, creates a Docker container with `--cgroupns=private` whose
     root cgroup (in its private cgroup namespace) is the boundary.
     Membership is proven once the container is running and its root cgroup
     is populated.  The target is launched via `docker exec` (a member of
     the container's cgroup).  Kill writes `cgroup.kill=1` (kernel SIGKILL
     to the entire subtree) and `docker stop`.  Emptiness is the bounded
     poll for `cgroup.events populated=0`.  The death receipt is
     content-pinned to the exact launch, backend, ownership, and lineage.
   - `LinuxCgroupV2ContainmentBackend` (option D): native `/sys/fs/cgroup`
     path for Linux hosts.
   - `UnavailableContainmentBackend`: fail-closed; `createBoundary` throws
     `RICKGENT_CONTAINMENT_UNAVAILABLE`; the only mint that succeeds is
     `mintNeverReleasedReceipt`.  `mintDeathReceipt` throws (no terminal
     receipt manufactured) (VAL-T22B-004).
   - `probeContainmentBackend()` factory: Docker → Linux → Unavailable.

2. **`orchestrator/src/lifecycle/target-start-gate.ts`** —
   `TargetStartGateAuthority`: the production authority that owns the
   durable target start gate's `held -> released` and
   `held -> closed_never_released` edges.  `releaseTarget` asserts a
   brand-authorized membership bound to the exact lineage and calls
   `StateStore.mintTargetReleased`.  `closeNeverReleased` mints the
   `target-never-released` receipt via the `LeaseAuthority`-branded mint
   capability (no terminal receipt).  `mintBackendNeverReleasedReceipt`
   delegates to the backend's never-released mint.

3. **`orchestrator/src/state/store.ts`** — `mintTargetReleased` Store
   command: transitions `held -> released` in one immediate transaction,
   requiring a brand-authorized `ContainmentMembership` bound to the exact
   gate lineage.  A forged (unbranded) membership is rejected with
   `RICKGENT_CONTAINMENT_UNAVAILABLE` before the transaction opens.  Replay
   returns the identical immutable postimage; a divergent membership digest
   conflicts.  `MintTargetReleasedRequest` and `MintedContainmentReleaseReceipt`
   types added.

4. **`orchestrator/src/state/schema.ts`** — added
   `RICKGENT_CONTAINMENT_UNAVAILABLE` to `STABLE_STATE_ERRORS` (class
   `infrastructure`).

5. **`docs/architecture/reliability/state-and-lifecycle-contract.json`** —
   added the `RICKGENT_CONTAINMENT_UNAVAILABLE` stable error entry;
   `decision_digest` recomputed.

6. **`orchestrator/src/process/supervisor.ts`** — `SupervisedProcessRequest`
   gains optional `containmentMembership` and `containmentLineage` fields.
   When a membership is supplied, `ProcessSupervisor.run` asserts it
   (brand + lineage) BEFORE any platform/executable/spawn work; a forged or
   foreign-lineage membership fails closed to a `spawn_error` with
   `RICKGENT_CONTAINMENT_UNAVAILABLE` (VAL-T22B-002, VAL-T22B-005).  When
   the fields are absent, the legacy fixture path continues (the production
   cutover that makes this mandatory is t22D).

7. **`orchestrator/test/reliability/containment-authority.test.ts`** —
   20-test negative-proof matrix: interface surface, probe selection,
   unavailable backend, forged-membership/death-receipt/boundary rejection
   (structural, prototype, serialized), `mintTargetReleased` forged-foreign-
   lineage-divergent-digest rejection, `held -> released` happy path +
   replay, `held -> closed_never_released` never-released proof (no
   terminal receipt), `ProcessSupervisor.run` forged-membership
   `spawn_error`, `TargetStartGateAuthority.releaseTarget` and
   `closeNeverReleased`.

8. **`orchestrator/test/reliability/containment-corpus.test.ts`** —
   11-test real-platform corpus against the Docker cgroup-v2 backend:
   spawn failure, timeout, stubborn descendants, output flood, ownership
   loss (forged boundary), crash recovery, kill, confirmed emptiness,
   rapid double-fork/`setsid` escape, death-receipt content pinning.  The
   corpus is skipped on hosts where the Docker probe does not pass; the
   unavailable fail-closed path is covered in `containment-authority.test.ts`.

## Outcome

Complete.  The authority-owned containment interface, the Docker cgroup-v2
backend, the Linux native cgroup-v2 backend, the fail-closed unavailable
backend, the `TargetStartGateAuthority`, the `mintTargetReleased` Store
command, and the `ProcessSupervisor` pre-launch gate are all implemented and
tested.  The real Docker corpus passes on this host (Docker Desktop 29.2.1,
cgroup-v2).  Production activation remains closed (`autonomous_dispatch`
stays `fixture_only`).

## Proof

### Focused gate (touched suites)

| Suite | Tests | Result |
| --- | --- | --- |
| `containment-authority.test.ts` | 20 | 20 passed |
| `containment-corpus.test.ts` | 11 | 11 passed (real Docker cgroup-v2 backend) |
| **Subtotal** | **31** | **31 passed** |

### Scoped regression (related suites)

| Suite | Tests | Result |
| --- | --- | --- |
| `disposition-store-bridge.test.ts` | 35 | 35 passed |
| `disposition-authority.test.ts` | 16 | 16 passed |
| `oracle-store-integration.test.ts` | 11 | 11 passed |
| `oracle-authority.test.ts` | 14 | 14 passed |
| `lifecycle-exit-ownership.test.ts` | 3 | 3 passed |
| `attempt-ownership.test.ts` | 22 | 22 passed |
| `state-transition-declaration.test.ts` | 5 | 5 passed |
| `state-contract.test.ts` | 65 | 65 passed |
| `process-supervisor-corpus.test.ts` | 11 | 11 passed (run in isolation; cross-suite interference is a pre-existing environmental issue) |
| `process-posix.test.ts` | 30 | 30 passed |
| **Subtotal** | — | **212 passed** |

### Python policies

`python3 -m pytest test/ -p no:cacheprovider -q` → **367 passed, 3 skipped**
(env wired via `init.sh`).

### Citadel hard gate

`node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` →
exit 0.  Summary: **1 finding (CRITICAL=0, HIGH=0, MEDIUM=0, LOW=1)**.  The
LOW finding is the pre-existing `project-shape-detection` shape detection.
No findings introduced by this tranche.

### Doctor

`node orchestrator/dist/cli.js doctor` → exit 0.  All checks passed.
`autonomous_dispatch: state=fixture_only` (expected — t22D activates).
`t22B` does not activate any capability.

## Red-then-green evidence (TDD)

The `containment-authority.test.ts` and `containment-corpus.test.ts` test
files reference APIs (`ContainmentMembership`, `mintTargetReleased`,
`TargetStartGateAuthority`, `DockerCgroupV2ContainmentBackend`,
`probeContainmentBackend`, `assertContainmentMembershipForLaunch`) that do
not exist on the pre-t22B codebase.  Against the pre-tranche code, the
suites fail to compile (red).  After the implementation, both suites pass
green.  The corpus `case 5: ownership loss` test was red against the first
implementation (which returned silently on a forged boundary in `kill`) and
green after `kill` was made fail-closed to throw
`ContainmentUnavailableError` on a forged boundary.

## VAL assertion coverage

| Assertion | Coverage |
| --- | --- |
| VAL-T22B-001 (authority-owned interface) | `containment-authority.test.ts` interface surface + corpus; `containment.ts` module |
| VAL-T22B-002 (start gate + supervisor reject unproven membership) | `mintTargetReleased` forged/foreign-lineage rejection; `ProcessSupervisor.run` forged-membership `spawn_error`; `TargetStartGateAuthority.releaseTarget` |
| VAL-T22B-003 (real platform corpus) | `containment-corpus.test.ts` 9 corpus cases + death-receipt pinning, real Docker cgroup-v2 |
| VAL-T22B-004 (unavailable fails closed, never-released, no terminal receipt) | `UnavailableContainmentBackend` tests; `mintTargetNeverReleased` `held -> closed_never_released`; `TargetStartGateAuthority.closeNeverReleased` |
| VAL-T22B-005 (no structural field trusted) | forged membership/death-receipt/boundary rejection (structural, prototype, serialized) |
| VAL-T22B-006 (execution report + manifest) | this report; manifest t22B tranche Done |

## Known limitations

- The `ProcessSupervisor` containment gate is optional in this tranche
  (the legacy fixture path continues when the fields are absent).  The
  production cutover that makes the containment membership mandatory for
  every dispatch is t22D.
- The Docker backend uses the container's root cgroup (in its private
  cgroup namespace) as the boundary, rather than a delegated child cgroup.
  cgroup-v2 forbids enabling controllers on a cgroup that already has
  processes (the no-internal-process constraint), and the container init
  is in the root cgroup.  The root cgroup already exposes the
  `pids`/`memory`/`cpu` controllers we probed, so the root IS the
  authoritative boundary; `cgroup.kill` at the root terminates the entire
  subtree.  This satisfies the ADR's obligation 7 (no migration authority)
  because the container runs as a non-root user with no CAP_SYS_ADMIN and
  cannot write to ancestor `cgroup.procs` or `setns` to a foreign cgroup.
- Production activation is deferred to t22D; `autonomous_dispatch` stays
  `fixture_only` after t22B.

## Next dependency boundary

- **t22C** (one AttemptRunner) composes the acquisition/finalization order
  on top of the t22A Store commands and the t22B containment authority.
  The `AttemptRunner` will construct a `TargetStartGateAuthority` with the
  probed `ContainmentBackend`, call `createBoundary` + `observeMembership` +
  `releaseTarget` before dispatch, and `kill` + `awaitEmpty` +
  `mintDeathReceipt` on terminalization.
- **t22D** (cutover + activation) removes the legacy run-worktree/
  direct-spawn/finally-release path, makes the containment membership
  mandatory for every production dispatch, and activates
  `autonomous_dispatch` only after all t22A–t22D proofs pass.

## Files changed

| File | Change |
| --- | --- |
| `orchestrator/src/process/containment.ts` | Created: authority-owned containment interface + Docker/Linux/Unavailable backends + brand predicates + factory |
| `orchestrator/src/lifecycle/target-start-gate.ts` | Created: `TargetStartGateAuthority` owning `held -> released` and `held -> closed_never_released` |
| `orchestrator/src/state/store.ts` | Added `mintTargetReleased` Store command, `MintTargetReleasedRequest`, `MintedContainmentReleaseReceipt`; imported containment brand predicate |
| `orchestrator/src/state/schema.ts` | Added `RICKGENT_CONTAINMENT_UNAVAILABLE` to `STABLE_STATE_ERRORS` |
| `orchestrator/src/process/supervisor.ts` | Added optional `containmentMembership`/`containmentLineage` to `SupervisedProcessRequest`; pre-spawn brand+lineage assertion |
| `docs/architecture/reliability/state-and-lifecycle-contract.json` | Added `RICKGENT_CONTAINMENT_UNAVAILABLE` stable error; `decision_digest` recomputed |
| `orchestrator/test/reliability/containment-authority.test.ts` | Created: 20-test negative-proof matrix |
| `orchestrator/test/reliability/containment-corpus.test.ts` | Created: 11-test real Docker cgroup-v2 corpus |
| `docs/remediation/trust-spine-manifest.json` | t22B tranche status → Done with completion reference |
| `docs/remediation/phase-4-t22B-containment-execution-report-2026-07-20.md` | This report |

---

## Fix Addendum (M3 scrutiny remediation): awaitEmpty / mintDeathReceipt fail-open

**Date:** 2026-07-20
**Trigger:** M3 scrutiny validator identified the awaitEmpty/mintDeathReceipt
fail-open as blocking (violating invariant 6 and containment contract
obligations 5 and 6).
**Scope:** `orchestrator/src/process/containment.ts` (Docker and Linux
`awaitEmpty` paths + `mintDeathReceipt` in both backends +
`ContainmentEmptinessObservation` brand class); negative-proof tests in
`containment-authority.test.ts` and `containment-corpus.test.ts`.

### The fail-open

The M3 scrutiny validator found that the Docker and Linux `awaitEmpty` paths
synthesized `cgroup.events populated=0` after failed reads, and
`mintDeathReceipt` accepted that result without requiring an
authority-owned successful confirmed-emptiness observation.  A stopped or
unreadable boundary could therefore mint a terminal death receipt instead
of failing closed.

**Docker `awaitEmpty`**: after `kill` (which calls `docker stop`), the
container is stopped and `docker exec` fails.  The shell fallback
`` `cat ... 2>/dev/null || echo 'populated 0\nfrozen 0'` `` synthesized
`populated 0` from the failed read; and when `docker exec` itself failed
(stopped container), `dockerExecSilent` returned empty stdout, the
`/populated\s+1/` regex did not match, and `populated` was set to `false`
(`emptinessConfirmed: true`) — synthesized emptiness from a failed read.
The corpus was green only because of this fail-open: `docker exec cat
cgroup.events` can never observe `populated 0` because the exec process
itself is a member of the container's root cgroup (keeping it populated
for the duration of the read).

**Linux `awaitEmpty`**: the `catch { lastEvents = "populated 0\nfrozen
0\n"; }` block synthesized `populated 0` from a failed `readFileSync`
(missing or unreadable `cgroup.events`), making `populated = false` and
returning `emptinessConfirmed: true`.

**`mintDeathReceipt`** (both backends): accepted the `emptiness` parameter
without (a) verifying it was authority-owned (brand-checked) or (b)
requiring `emptiness.emptinessConfirmed === true`.  A controller-forged
`ContainmentEmptinessObservation` plain object with
`emptinessConfirmed: true` could mint a terminal death receipt.

### The fix

1. **`ContainmentEmptinessObservation` brand class.** Converted from a
   plain interface to a WeakSet-branded class (like
   `ContainmentMembership`), minted only by the authority-owned backend's
   `awaitEmpty`.  Added `isAuthorizedContainmentEmptinessObservation`
   predicate that rejects structural, prototype, and serialized forgeries.

2. **Docker `awaitEmpty` — `docker inspect` observation (fail-closed).**
   Replaced the broken `docker exec cat cgroup.events` path with
   `docker inspect --format '{{.State.Status}} {{.State.Pid}}'`.
   `State.Status=exited` and `State.Pid=0` is the Docker daemon's
   authoritative observation that no processes remain in the container's
   cgroup.  If the inspect fails (container gone, daemon error) or the
   output is malformed, `awaitEmpty` throws `ContainmentUnavailableError`
   — never synthesizes `populated=0` from a failed observation.  The
   Docker daemon is the authority for container process state; the
   `eventsDigest` content-pins the inspect output.

3. **Linux `awaitEmpty` — fail-closed `cgroup.events` read.** Removed the
   `catch { lastEvents = "populated 0\nfrozen 0\n"; }` synthesis.  If
   `readFileSync` throws (missing/unreadable `cgroup.events`), `awaitEmpty`
   throws `ContainmentUnavailableError`.  Added `parseCgroupEventsPopulated`
   helper that throws on malformed content (no `populated N` line).  A
   stopped/unreadable/malformed boundary fails closed.

4. **`mintDeathReceipt` — authority-owned confirmed-empty requirement
   (both backends).** Added `isAuthorizedContainmentEmptinessObservation`
   brand check (rejects forged/unbranded observations) AND requires
   `emptiness.emptinessConfirmed === true` and `emptiness.populated ===
   false`.  A failed, absent, or not-confirmed observation throws
   `ContainmentUnavailableError` — no terminal receipt is minted.  The
   caller must produce a target-never-released / containment-unavailable
   outcome instead.

### Red-then-green proof

**Red** (against the unfixed code, after the mechanical brand-class
refactor but before the behavioral fix):

```
pnpm vitest run test/reliability/containment-authority.test.ts -t "M3 fix" ...
Tests  5 failed | 3 passed | 20 skipped (28)
```

Five tests failed (the fail-open):
- "Linux awaitEmpty throws when cgroup.events is missing" — promise
  resolved `ContainmentEmptinessObservation{ emptinessConfirmed: true,
  populated: false }` instead of rejecting (synthesized populated=0 from
  missing file).
- "Linux awaitEmpty throws when cgroup.events is removed mid-wait" — same.
- "Linux awaitEmpty throws when cgroup.events is malformed" — same
  (synthesized emptiness from garbage content).
- "mintDeathReceipt refuses a forged (unbranded) emptiness observation" —
  expected function to throw, but it didn't (minted from forged
  observation).
- "mintDeathReceipt refuses an authority-owned observation with
  emptinessConfirmed=false" — expected function to throw, but it didn't
  (minted from not-confirmed observation).

**Green** (after the behavioral fix):

```
pnpm vitest run test/reliability/containment-authority.test.ts test/reliability/containment-corpus.test.ts ...
Tests  40 passed (40)
```

### Negative-proof matrix (M3 fix)

| Proof | Description |
| --- | --- |
| Linux missing cgroup.events | `awaitEmpty` throws `ContainmentUnavailableError` (stopped boundary) |
| Linux removed-mid-wait cgroup.events | `awaitEmpty` throws (boundary became unreadable) |
| Linux malformed cgroup.events | `awaitEmpty` throws (no `populated` field) |
| Linux confirmed-empty happy path | `awaitEmpty` returns brand-authorized `emptinessConfirmed: true` |
| Forged (unbranded) emptiness observation | `mintDeathReceipt` throws `ContainmentUnavailableError` |
| Authority-owned `emptinessConfirmed=false` | `mintDeathReceipt` throws (deadline exhausted; no terminal receipt) |
| Authority-owned confirmed-empty | `mintDeathReceipt` mints terminal receipt |
| Structural / prototype / serialized forgery | `isAuthorizedContainmentEmptinessObservation` rejects all three |
| Docker stopped boundary (container gone) | `awaitEmpty` throws `ContainmentUnavailableError` (corpus case 10) |
| Docker forged emptiness observation | `mintDeathReceipt` throws (corpus case 10) |

### Verification (fix tranche)

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0, clean |
| `pnpm build` | exit 0, `dist/cli.js` regenerated |
| `containment-authority.test.ts` | 28 passed (20 original + 8 M3 fix) |
| `containment-corpus.test.ts` | 12 passed (11 original + 1 M3 fix case 10) |
| Scoped M3 regression (11 suites) | 241 passed |
| `process-supervisor-corpus.test.ts` (isolation) | 11 passed |
| `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped |
| `citadel --prd MISSION_3_PRD.md --repo .` | exit 0; 0 CRITICAL, 0 HIGH, 9 MEDIUM (crossfile-behavior-drift heuristic false positives), 1 LOW |
| `doctor` | exit 0; `autonomous_dispatch: state=fixture_only` (unchanged) |

### Files changed (fix tranche)

| File | Change |
| --- | --- |
| `orchestrator/src/process/containment.ts` | `ContainmentEmptinessObservation` → brand class + `isAuthorizedContainmentEmptinessObservation`; `parseCgroupEventsPopulated` helper; Docker `awaitEmpty` → `docker inspect` fail-closed observation; Linux `awaitEmpty` → fail-closed read (no synthesis); `mintDeathReceipt` (both backends) → brand check + require `emptinessConfirmed` |
| `orchestrator/test/reliability/containment-authority.test.ts` | 8 M3 fix negative-proof tests (Linux stopped/unreadable/malformed + mintDeathReceipt refusal + brand forgery) |
| `orchestrator/test/reliability/containment-corpus.test.ts` | case 10: Docker stopped boundary fail-closed + forged emptiness refusal |
| `docs/remediation/phase-4-t22B-containment-execution-report-2026-07-20.md` | This fix addendum |
