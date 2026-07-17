# Phase 4 Process Supervisor Execution Report — 2026-07-17

## Outcome

Ticket `t19`, the internal POSIX ProcessSupervisor primitive, is complete.
Production activation is intentionally blocked until `t22` supplies validated
authoritative containment on macOS and Linux. The new supervisor is suitable
as an internal, evidence-producing primitive; it is not yet production release
authority and does not replace the interim run-worktree dispatch path.

This distinction is structural. The supervisor can prove process-group death
and the death of every exact PID/start identity that it sampled. It cannot
prove that no descendant forked, created a new session, and escaped entirely
between process-table observations. Sampled ancestry therefore records
`proof_basis: sampled_tracked_identities`, leaves all-descendant confirmation
false, and retains cleanup ownership. Only the authoritative containment
backend required by `t22` may produce the stronger proof needed for release.

A completion, data-flow, and reliability review team audited the integrated
`t18`/`t19` boundary. The review exercised real StateStore ownership,
attempt-workspace authorization, process topology, bounded binary output,
pre-exec persistence, terminal evidence, and failure containment. Findings
were repaired in the implementation and corpus without broadening public
capability claims.

## Delivered internal process boundary

### Fixed launch order

The successful launch path now follows one explicit order:

1. Validate the runtime-unforgeable ownership grant, single-use workspace
   spawn authorization, phase/context identity, absolute array argv, numeric
   bounds, output limits, allowlist, and canonical serialized environment.
2. Re-read the current unexpired owner and reject unsupported platforms or an
   unavailable executable before target release.
3. Consume the exact workspace spawn authorization before opening output files
   or spawning. Replays cannot fall through to a conflicting output artifact.
4. Open private, exclusive, no-follow stdout/stderr artifacts under a verified
   `0700` directory with `0600` files.
5. Spawn a detached Node bootstrap as a new process group/session with an empty
   bootstrap environment. The bootstrap waits on a bounded start gate and
   cannot execute the target yet.
6. Observe and pin platform boot identity, PID, PPID, PGID, SID, and process
   start identity; initialize exact descendant tracking.
7. Atomically persist the immutable launch and launch evidence, and advance
   the process-group/stdout/stderr claims from their exact expected versions
   to active. Re-check ownership after the commit.
8. Send the versioned sealed environment envelope through stdin. Only then
   does the bootstrap invoke `execve` for the target.
9. Heartbeat ownership, stream bounded output, sample exact descendants, and
   supervise leader exit, closed stdio, timeout, infrastructure failure, and
   lingering group state independently.
10. On termination, send group `TERM`, signal only tracked identities outside
    that already-signaled PGID, wait the configured grace, then send group and
    escaped-identity `KILL` as needed. Death observation has its own hard bound
    and can complete even when no child exit event arrives.
11. Drain or boundedly close output streams, seal path/digest/byte-count/
    truncation/tail receipts, append ordered observations, and atomically
    persist one terminal receipt over their exact immutable references.
12. Enter cleanup-pending ownership for nonzero, timeout, ownership loss,
    supervision/persistence failure, or any result lacking authoritative
    all-descendant death. A sampled clean exit may describe the leader result,
    but it cannot release ownership.

The request surface has hard limits: positive safe-integer time bounds capped
at 24 hours, stdout/stderr storage capped at 64 MiB per stream, tail bounded by
the output limit, and a canonical environment envelope capped at 64 KiB.
Rejection occurs before authorization consumption, filesystem effects, launch
rows, or terminal rows.

### Bounded output and process receipts

Stdout and stderr are streamed rather than accumulated. Each sink hashes the
complete byte stream while storing only the configured prefix and bounded
tail. Its terminal receipt records:

- the private artifact path and mode;
- full-stream and stored-artifact SHA-256 digests;
- original and stored byte counts;
- the truncation decision; and
- the bounded tail as base64.

Simultaneous binary flood tests verify the byte patterns, both digests, prefix,
tail, counts, truncation, and filesystem modes exactly. Output-stream closure
is not process completion: a target can close fd 1/2, continue mutating its
owned report area, and exit later without causing an early terminal result.

## Sealed environment contract

The supervisor never merges or forwards wholesale `process.env`. The requested
mapping must be allowlisted, syntactically valid, NUL-free, string-valued,
duplicate-free, and within the serialized hard bound. Its canonical digest is
persisted in launch evidence before target release. The bootstrap starts with
an empty mapping and receives the exact requested mapping only through the
post-persistence start gate.

There is one target-visible platform caveat. On Darwin, Node/CoreFoundation
synthesizes `__CF_USER_TEXT_ENCODING` after `execve`, even when the syscall
receives only the sealed mapping. This runtime-generated key is not ambient
authority and is not included in the sealed environment digest. The corpus
requires every requested key/value, rejects the ambient sentinel and every
other unrequested key, and permits only this documented Darwin synthetic key.
Byte-for-byte equality of a language runtime's later `process.env` view is not
a portable `execve` contract.

## Durable StateStore evidence

Migration 003 adds a launch-first, append-only ProcessSupervisor substrate
instead of extending the released-v1 process receipt tied to the legacy lease
aggregate:

- `attempt_process_launches` stores the immutable pre-exec identity, ownership
  generation/context, separate execution context, spawn authorization digest,
  platform identities, argv/environment digests, output paths and bounds, and
  expected resource versions.
- `attempt_process_observations` stores one contiguous ordered chain of output,
  exit, termination, group-death, and infrastructure observations. Each row
  references immutable `ProcessSupervisor` evidence with the same payload
  digest and exact attempt/phase/context lineage.
- `attempt_process_terminal_receipts` seals one outcome per launch, the group
  and all-descendant facts separately, observation count, and the digest of
  every ordered observation reference.

Launch and terminal writes use the named `process_supervisor_launch` and
`process_supervisor_terminal` `BEGIN IMMEDIATE` transaction boundaries. Only
runtime-unforgeable supervisor commands may call these Store methods. The
generic evidence writer rejects the reserved producer label, and the generic
legacy lifecycle process-receipt path remains disabled.

State validation enforces the exact owner, repository, attempt, phase,
execution context, output identities, resource versions, evidence schemas,
payload projections, observation order, and result digest. A group-death
observation also records its proof basis and whether all sampled exact
identities were confirmed dead. `descendants_confirmed_dead=true` is rejected
unless the proof basis is authoritative containment and tracked identity death
is also true.

The terminal outcome and resource disposition deliberately remain distinct.
For example, an internal target may exit zero after its sampled group and
tracked identities are dead, while the ownership aggregate still transitions
to cleanup-pending because authoritative all-descendant proof is absent. That
state cannot be silently released or promoted by `t19`.

## Team-review findings and repairs

The review found and closed the following implementation defects:

1. Launch and terminal evidence initially differed from the Store's exact
   projections. Launch lineage, group-death payloads, observation references,
   and terminal result-digest construction now share one canonical shape.
2. Launch persistence had to happen before target exec, not merely before the
   supervisor returned. The waiting bootstrap and sealed start gate make that
   ordering executable and directly testable from the target's first action.
3. Workspace authorization replay could reach exclusive output creation before
   the single-use token was checked. Consumption now precedes those effects.
4. An unavailable target executable was indistinguishable from an ordinary
   bootstrap exit 126. Executable preflight now returns typed `spawn_error`
   without manufacturing a launch or terminal receipt and retains cleanup.
5. Terminal persistence could fail because supervisor payload fields and Store
   lineage expectations disagreed. Process-only POSIX observations now remain
   process facts; the supervisor binds authoritative launch/owner/context facts
   into the evidence projection.
6. A target that closed stdout/stderr could be mistaken for completion, while
   a leader that exited before a live child could be mistaken for group death.
   Exit, stream closure, group liveness, and sampled identity liveness are now
   independent observations.
7. Timeout supervision originally depended on receiving a child exit event.
   Child completion now races the bounded termination/death path, so unprovable
   signaling and a non-reporting leader cannot hang the supervisor indefinitely.
8. Escaped descendants could produce a false clean result. Exact sampled
   identities are tracked across PGID/SID changes and signaled individually,
   but sampled proof is explicitly prevented from setting the all-descendant
   bit. Escape uncertainty remains cleanup-pending for `t22`.
9. Group signaling followed by signaling every tracked PID delivered duplicate
   signals to same-group processes. Tracked-PID signaling now excludes the
   already-signaled PGID and is reserved for observed escapees.
10. Darwin `ps` reports a redacted zero session column on the supported host.
    Root SID uses bounded `getsid(2)` observation through the selected Python
    runtime, while fast whole-table sampling retains null-SID topology instead
    of dropping every process or performing a permission-fragile whole-host
    `getsid` pass.
11. Group death and all-descendant death were temporarily collapsed into one
    boolean. They are now independent durable facts with an explicit proof
    basis; Store validation prevents sampled evidence from being upgraded.
12. Unbounded request values could turn safety configuration into resource
    exhaustion or effectively infinite supervision. Lower, upper, relational,
    and serialized-environment bounds now fail before any side effect.

## Verification evidence

| Check | Result |
|---|---|
| State/schema contract validator | **PASS** — schema v3, 30 tables, 24 transactions |
| State crash corpus | **PASS** — 5/5 |
| State contract suite | **PASS** — 65/65 |
| Focused POSIX + ProcessSupervisor corpus | **PASS** — 41/41 |
| Complete changed-surface suite | **PASS** — 175/175 |
| State-observation migration projection | **PASS** — 3/3 after updating the v3 assertion |
| External Omnigent policy surfaces | **PASS** — 11/11 with the required mounted root and exact Python entrypoint |
| TypeScript typecheck | **PASS** |
| Full repository regression | **QUALIFIED** — monolithic run passed 996/1008; its 12 failures were one repaired v2→v3 assertion and 11 tests launched without their required Omnigent environment. Those failed surfaces were rerun and passed 3/3 and 11/11 respectively. |

The focused process corpus covers launch-before-exec persistence, single-use
authorization, environment leakage, request hard bounds, exact bounded binary
output, clean and nonzero exit, ignored-TERM tree escalation, leader exit with
a live child, closed stdio with continued execution, double-fork/session
escape, unprovable termination, typed spawn failure, durable observation and
terminal rows, result-digest reconstruction, and cleanup-pending failure
disposition.

## Residual risks and hard activation gates

### Sampled ancestry is not containment

PPID/process-table polling has an unavoidable observation gap. A process can
fork, call `setsid`, and reparent or exit between snapshots without ever
appearing in the tracked set. Increasing the polling frequency makes a fixture
more likely to be observed; it does not convert sampling into proof. This is a
hard production gate. `t22` must add and validate an authoritative containment
membership/death primitive on both supported platforms. If that primitive is
unavailable, production must fail before target release.

### PID/PGID signaling retains TOCTOU exposure

The controller binds observations to boot and process-start identity and fails
uncertain observations closed. POSIX `kill(pid)` and `kill(-pgid)` still address
numeric identities, however, and observation and signal delivery are not one
atomic operation. Exit/reuse between those steps can make delivery unprovable
or, in the worst case, target a reused numeric identity. Sampled numeric
signaling is therefore an internal best-effort termination mechanism, not
production cleanup/release proof. Authoritative containment in `t22` must
provide a stable membership-scoped signal/death boundary.

### Darwin identity has bounded but material weaknesses

Darwin process start identity currently derives from `ps lstart`, whose
resolution is one second. PID reuse within the same boot and second is not a
cryptographically unique identity. Root session observation also depends on
the absolute `/usr/bin/python3` entrypoint to call `os.getsid`; missing,
incompatible, timed-out, malformed, or permission-denied observation fails
closed, but it remains an external runtime dependency. `t22` containment must
not treat this sampled identity as authoritative membership.

### Filesystem and output operations are synchronous

Private output setup, bounded artifact writes, close/stat verification, and
several process observations use synchronous filesystem or subprocess calls.
Byte and command-output limits prevent memory growth, but a slow or wedged
filesystem can still stall the Node event loop, delaying heartbeats,
descendant sampling, or timeout callbacks. Before public activation, the
critical section needs either bounded asynchronous I/O or an independently
enforced outer deadline whose operation does not depend on the blocked event
loop.

These risks are documented limitations, not permission to weaken cleanup.
Until their owning later tickets land, uncertainty remains nonterminal,
non-releasable, and cleanup-pending.

## Next dependency-ordered work

Proceed next to `t20`, orchestrator-owned commit attribution. It is the direct
manifest successor to `t19` and must prove that only the exact allowed delta in
the owned attempt workspace can become an orchestrator-created descendant
commit. Then execute `t21` for salvage, quarantine, restore, and physical
cleanup proof.

Do not bypass `t22` after those tickets. `t22` remains the hard production
activation gate: it must integrate attempt ownership, authoritative
macOS/Linux containment, policy context, this supervisor, evidence, commit,
cleanup, promotion, compare-owner release, and terminal state in the fixed
critical-section order. Sampled process-table ancestry must never become
all-descendant death or lease-release authority.
