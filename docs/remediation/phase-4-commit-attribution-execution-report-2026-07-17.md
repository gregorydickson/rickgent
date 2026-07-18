# Phase 4 Commit Attribution Execution Report — 2026-07-17

## Outcome

Ticket `t20`, the internal orchestrator-owned CommitService primitive, is
complete. It is an exact Git/state attribution authority, not yet the
production attempt runner. Production activation remains blocked until `t21`
implements physical salvage/cleanup proof and `t22` wires validated
authoritative containment, policy execution, commit attribution, and release
inside one ownership critical section.

The accepted path no longer trusts a worker-created commit, worker staging,
ambient Git configuration, transcript claims, or caller cleanliness. It binds
one deterministic candidate to the exact live owner, active resource versions,
authoritative implement-process terminal receipt, execution context, final
accepted review, every required gate, ticket contract, baseline, private
attempt ref, and delivery ref. Generic lifecycle and evidence writers cannot
mint CommitService attribution.

A completion, data-flow, and reliability team reviewed the boundary while it
was implemented. The review found state/Git projection mismatches, filter and
replace-object exposure, incomplete replay proof, mode and rename ambiguity,
caller-snapshot weakness, ref races, and missing adversarial cases. Those
findings were repaired and added to the executable corpus.

## Delivered commit boundary

The successful path now follows one fail-closed order:

1. Re-read the runtime-unforgeable ownership grant and exact workspace
   receipt; bind repository, common Git directory, worktree administration,
   isolated index, attempt/delivery refs, baseline, contract, phase, launch,
   process terminal, and idempotency identity.
2. Snapshot the caller with HEAD, symbolic-ref, exact index bytes, and a
   bounded filter-free/no-follow raw worktree digest. Pre-existing caller dirt
   is allowed, but every observed byte and mode must remain unchanged.
3. Use a fixed `/usr/bin/git`, a sealed environment, literal pathspecs,
   disabled hooks/fsmonitor/external diff/replacement objects/global config,
   and bounded command output. Ambient `GIT_DIR`, `GIT_WORK_TREE`, index,
   config, filter, and replacement authority are not inherited.
4. Reject worker HEAD/default-index commits, isolated-index drift, moved refs,
   no change, foreign tracked/untracked/ignored paths, pathspec magic,
   symlink traversal, gitlinks, unsupported modes/types, and changes that do
   not realize the sealed scope exactly.
5. Enumerate tracked changes by comparing raw no-follow bytes and modes with
   the immutable isolated-index entries. Construct blobs with filter-free
   plumbing and build the candidate tree only through the owned isolated
   index. The caller index and normal worktree index are never staging input.
6. Parse one canonical raw tree delta. Rename is admitted only for `R100` with
   identical before/after blob OIDs. Ticket-contract v1 permits regular
   `100644` creates, mode-preserving regular modifications and pure renames,
   and non-gitlink deletion. Executable creation, symlink creation/change,
   mode/type changes, impure rename, and gitlinks fail closed.
7. Resolve the authoritative StateStore preparation projection and require the
   exact reviewed tree/diff, required-gate receipts, phase/context, successful
   authoritatively-contained implement process, contract, and baseline.
8. Persist one immutable migration-004 commit intent before creating the
   commit object or moving a ref. The intent seals owner/generation/version,
   four active resource versions, process and verification lineage, trees,
   normalized delta/digests, deterministic metadata, and idempotency input.
9. Create one deterministic acceptance commit with the baseline as its only
   parent and the phase creation timestamp as author/committer time. Re-read
   ancestry and tree without replacement objects.
10. Reconstruct the candidate again, restore the isolated index, re-read the
    live owner and caller, and atomically verify the delivery baseline while
    compare-and-swapping the private attempt ref.
11. Create the attempt-ref reflog in the same Git transaction. Its subject is
    bound to the commit-intent ID and a proof derived from the in-memory owner
    credential. Retry requires the exact candidate, subject, and owner proof;
    a matching object placed by another repository writer is not adopted.
12. After the ref transaction, reconstruct the candidate a third time and
    recheck worktree paths/bytes, isolated-index restoration, worker HEAD,
    default index, caller snapshot, refs, and ownership. Any uncertainty keeps
    the candidate private and enters cleanup containment without attribution.
13. Atomically finalize migration 004 from `intent_recorded@0` to
    `finalized@1`, append `rickgent.commit-attribution.v2` evidence, and retain
    the released-v1 `commit_attributions` summary. Exact response-loss replay
    returns the original durable command receipts and identities without a
    second attribution or evidence row.

Every successful Git command contributes a bounded receipt containing its
purpose, fixed executable, argv/input/stdout/stderr digests and byte counts,
and zero exit status. The v2 evidence also includes the owner, process,
context, verification, resource, ref, tree, commit, mode, change-kind, path,
and deterministic metadata projections.

## Durable state and authority changes

Migration 004 adds `attempt_commit_intents`, a strict owner-bound aggregate
with immutable preimage columns and one legal `intent_recorded@0` to
`finalized@1` transition. Prepare/finalize are separate named
`BEGIN IMMEDIATE` transactions. The current schema is v4.

Only a runtime-unforgeable `CommitServiceCommand` may call the Store prepare
and finalize methods. `CommitService` is a reserved evidence producer, the
generic attribution writer throws, and lifecycle completion/oracle reads now
require the exact finalized intent plus v2 evidence. The read-only replay
projection returns only strict canonical durable receipts and terminal IDs.

The state contract, validator, crash inventory, schema catalog, oracle
normalization, observation projection, and transition-authority corpus were
updated together. The shared delta parser enforces pure rename and the
released mode policy in both CommitService and independent Store observation.

## Team-review findings and repairs

1. Commit attribution initially validated caller-created objects rather than
   owning creation. A separate unforgeable CommitService command path now owns
   intent, Git construction, ref CAS, and finalization.
2. A single final write could not make Git and SQLite jointly crash-atomic.
   Migration 004 records the immutable intent first, then exact retry either
   completes that candidate or contains the attempt; it never rewinds or
   guesses a third ref OID.
3. Ref recovery initially inferred that an exact candidate must have been
   written by CommitService. The ref transaction now creates a reflog subject
   bound to a token-derived owner proof, and retry verifies it exactly.
4. The shared raw-delta parser discarded rename similarity. It now requires
   `R100` and identical blob OIDs, so renamed-and-modified content cannot be
   attributed as a pure rename.
5. Mode policy was inconsistent across service, Store, and oracle. The three
   projections now agree on regular creation/modification/rename and safe
   non-gitlink deletion, while rejecting executable creation, symlink change,
   mode/type drift, and gitlinks.
6. Git observations inherited ambient replacement, config, pathspec, and
   filter behavior. Both service and Store now use sealed environments and
   disable replacement objects; worktree content enumeration and blob hashing
   do not invoke clean filters.
7. Caller invariance used porcelain status, which both invoked required clean
   filters and did not distinguish dirty-byte changes with the same status
   code. It now hashes bounded raw file/symlink bytes and modes with stable
   no-follow reads plus exact index bytes.
8. Candidate construction originally restored the isolated index before
   checking legitimate creates, making them appear foreign. Checks now run
   against the candidate image and restore the baseline at each durable
   boundary.
9. Replay originally returned newly observed command receipts, breaking exact
   response-loss identity. Finalized replay now consumes strict original
   receipts from the durable intent result.
10. Post-ref acceptance had a worktree/index/HEAD gap. The complete candidate,
    path set, isolated index, default index, worker HEAD, caller, refs, and
    owner are re-observed after the CAS before Store finalization.
11. The first corpus manifest described cases without executing all of them.
    Manifest IDs now equal the actual table-driven and individual case
    registry and include real submodule, delivery-race, stale-owner,
    prepare/finalize drift, hostile-filter, and forged-CAS-proof coverage.

## Verification evidence

| Check | Result |
|---|---|
| Build | **PASS** — TypeScript build completed from input commit `35ab3f78b5d1` |
| TypeScript typecheck | **PASS** |
| State/schema contract validator | **PASS** — schema v4, 4 migrations, 30 catalog tables, 26 named transactions |
| Focused state/store/authority suite | **PASS** — 129/129 |
| Attempt ownership regression | **PASS** — 14/14 |
| State observation v4 projection | **PASS** — 3/3 |
| Omnigent compatibility probe | **PASS** — runtime 0.6.0.dev0, 9/9 checks |
| Omnigent environment-dependent tests | **PASS** — 11/11 with the required mounted root and interpreter |
| Commit attribution + dispatch evidence | **PASS** — 47/47 |
| Full repository regression | **PASS** — 72 files, 1,045/1,045 tests with the required `OMNIGENT_ROOT` and `OMNIGENT_PYTHON` environment contract |
| ESLint script | **UNAVAILABLE** — the existing package script names `eslint`, but ESLint is not installed or declared |

The Git corpus covers accepted modify/create/binary/pure-rename/delete,
pre-dirty caller preservation, hostile ambient Git variables and required
clean filters, exact replay, no-change, foreign tracked/untracked/ignored
delta, wrong kind/rename source, executable drift, symlink leaf/component,
gitlink, both indexes, one/two/orphan worker commits, moved attempt/delivery
refs, final-CAS delivery race, stale owner, sampled process death, pathspec
magic, immutable prepare/finalize drift, missing/forged owner CAS proof, and
response loss after prepare and finalization. Caller-boundary coverage also
rejects embedded repositories and other non-file entries whose descendant
bytes cannot be represented exactly by the v1 snapshot contract.

## Residual risks and hard activation gates

### Cross-owner recovery belongs to cleanup/salvage

A prepared or ref-advanced intent is deliberately bound to the same owner
credential and resource versions. Lease expiry or process loss does not grant a
new owner permission to manufacture attribution. `t21` and `t29` must salvage,
quarantine, or deliberately reconcile those retained resources; `t20` only
replays response loss while the exact owner remains live.

### Production integration remains unavailable

The corpus uses an explicit authoritative containment test controller to prove
the standalone primitive. The real t19 sampled controller cannot produce
all-descendant proof. `t22` must provide validated macOS/Linux containment and
place CommitService inside the fixed allocation/process/verification/cleanup
critical section before any production caller may use it.

### Finalization is not a filesystem lock

Post-CAS reconstruction narrows the mutation window to the final observation
and StateStore transaction. The worker is authoritatively dead and has no Git
mutation capability at this boundary, but a separate out-of-contract OS-level
repository writer is not serialized by t20. `t23` owns conflicting-process
stress/isolation proof; uncertainty must remain cleanup-pending.

### Snapshot bounds are intentional fail-closed limits

Caller and candidate snapshots reject excessive path counts, individual file
sizes, total bytes, noncanonical/non-UTF-8 paths, unstable reads, symlink
traversal, and special files where the v1 contract has no safe meaning. These
limits prevent attribution from becoming unbounded resource consumption; a
future contract version must explicitly expand semantics rather than silently
weakening them.

## Next dependency-ordered work

Proceed to `t21`: implement salvage, quarantine, restore, and physical cleanup
proof for uncommitted, committed, binary, empty, ref-advanced, and partially
cleaned attempt resources. Do not activate CommitService in the production run
path before `t22` closes the containment and integrated ownership boundary.
