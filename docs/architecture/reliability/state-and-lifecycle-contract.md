# State and lifecycle contract

Status: frozen v1 contract with additive migrations implemented through
`005_attempt_cleanup_proof_model` (`rickgent-state-and-lifecycle-v1`, schema
`1.0.0`). The normative, closed machine contract is
[`state-and-lifecycle-contract.json`](./state-and-lifecycle-contract.json).
The Phase 18 attempt-ownership, Phase 19 process-supervision, and Phase 20
commit-attribution primitives, together with the attempt-cleanup relational
substrate and oracle v2 reader, are implemented internally but are not a
production dispatch capability. The disposition writers and finalizers remain
unavailable; Phase 22 owns that integration and caller cutover. Resume, retry,
automatic reconciliation, and delivery remain unavailable.

## Repository identity and state root

Every command first selects one target with `--repo`. It `lstat`s that target,
rejects a symlink or non-directory, resolves its real path, and requires the Git
worktree top level. It then runs these commands with array arguments:

```text
git -C <selected-repo-realpath> rev-parse --path-format=absolute --show-toplevel
git -C <repo-realpath> rev-parse --path-format=absolute --git-common-dir
git -C <repo-realpath> rev-parse --show-object-format
```

The selected repository must equal the absolute canonical worktree top level.
The Git common-directory result must be absolute, existing, and canonical, and
the object format must be `sha1` or `sha256`. Existing canonical path
components are checked with `lstat`; symlinks, realpath mismatches, and wrong
file types fail with `RICKGENT_STATE_ROOT_UNSAFE`. The selected repository, Git
common directory, and private state endpoints must be owned by the effective
process owner. Canonical ancestors such as `/` or `/Users` may be root-owned;
they are not state endpoints. Group/other-writable Git administration and
non-private state endpoint modes are unsafe.

Repository identity is the SHA-256 digest of the canonical tuple
`(repo_realpath, git_common_dir_realpath, object_format)`. State lives only at
`<git-common-dir-realpath>/rickgent/state.sqlite3`; the directory is mode
`0700`, and the database plus WAL/SHM sidecars are mode `0600`. Production has
no arbitrary root override.

If the caller is in repository B but passes `--repo A`, only A's canonical Git
common directory can select state. Caller CWD, `RICKGENT_DIR`, a PRD path,
ticket ID, registry, or ledger has no authority. Status, resume, and retry must
repeat the repository selection.

## SQLite and migrations

t13 implemented the contract with `node:sqlite` `DatabaseSync`. The state
subsystem requires Node `24.12.0` or newer within the supported Node 24 line;
older Node 24 releases fail closed with
`RICKGENT_STATE_RUNTIME_UNSUPPORTED`. Node added database-wide named-parameter
options in 24.4 and the defensive option in 24.12, so the wider package engine
range does not weaken this state-store floor. The implementation maps the
contract fields to the real `DatabaseSync` names
`enableForeignKeyConstraints`, `defensive`, `allowExtension`,
`enableDoubleQuotedStringLiterals`, and `allowUnknownNamedParameters`.

Every connection enables defensive behavior, rejects extension loading,
double-quoted string literals, and unknown named parameters, and establishes
and verifies:

```text
PRAGMA foreign_keys=ON
PRAGMA journal_mode=WAL
PRAGMA synchronous=FULL
PRAGMA busy_timeout=5000
PRAGMA wal_autocheckpoint=1000
PRAGMA trusted_schema=OFF
PRAGMA recursive_triggers=ON
```

Thus foreign key enforcement and `FULL` durability are connection invariants.
Ordinary writers use `BEGIN IMMEDIATE`; open and migration use an exclusive
migration critical section. A bounded SQLite busy/locked result is
`RICKGENT_STATE_BUSY`. There is no unbounded retry or optimistic success; a
caller may retry only the complete named transaction.

Migrations are positive, contiguous, three-digit versions. Migration
`001_initial_durable_state` is implemented by t13 and released with immutable
SQL checksum
`sha256:473f6581359fb59da29236aeb77acaba74aa46504fb0ac8c0089c59afca586a8`
and resulting `sqlite_schema` checksum
`sha256:11f061a28bffe7ed02a6d5b974cca09dcff189e18fb18834659a3aad175ecef9`.
Migration `002_attempt_ownership_primitive` is implemented by t18 with
immutable SQL checksum
`sha256:8dc1be6f92fbe281149b651c89fd1b2e8d7b4f3464c2f85a2113aa851123473d`
and resulting latest `sqlite_schema` checksum
`sha256:eb83ea80db2cc06eb46ffe135994fe79cf4f53146b5f71ac8a876b46f6224bbc`.
It adds the pre-side-effect ownership aggregate without editing or rebuilding
the released v1 lease tables.
Migration `003_durable_process_supervision` is implemented by t19 with
immutable SQL checksum
`sha256:c94e5b62aa8dae64740685c13159f2d19610909729c789e6638deb59855ff8ce`
and resulting latest `sqlite_schema` checksum
`sha256:c208339c0350aae8bd1ee3784da4e4ffc559b41e9c6079530a89da53c08753e3`.
It adds launch-first process identity, ordered observations, and one terminal
seal without mutating the frozen v1 process-receipt table.
Migration `004_durable_commit_attribution` is implemented by t20 with immutable
SQL checksum
`sha256:66f819b89e1781ca7fdc7311e269a4991a86706224eaa269b0198ad434ce6469`
and resulting latest `sqlite_schema` checksum
`sha256:af782456d3402bd47cff0ca9fd4e358c52028c14fee3470efcc295cac926542d`.
It adds the owner/process/resource/ref-bound CommitService intent and finalization
bridge without mutating the frozen v1 attribution table.
Migration `005_attempt_cleanup_proof_model` is implemented by t22 with
immutable SQL checksum
`sha256:e9c6896dd23d8d07127fa8ddb05483ad00ff9a59b2042dc32ce75428371ac6f1`
and resulting latest `sqlite_schema` checksum
`sha256:c91fd35e83d879890dd13ef8f8bb18fa6f8b116e8b85545e4c3e8c65785681c6`.
It adds a durable target-start gate, exact per-target proof-set aggregation,
nonterminal cleanup eligibility, distinct failure/promotion/quarantine records,
and a normalized quarantine inventory without mutating an earlier released
table. These are inactive relational authority boundaries until their reserved
runtime writers and finalizers are connected.
`schema_migrations` records the immutable version, unique name,
exact-definition SHA-256, and application time. Its rows and
`PRAGMA user_version` must agree. Released migrations never change; later
versions append `006`, `007`, and so on. This release activates only the
internal attempt-ownership/resource, process-supervision, commit-attribution,
and attempt-cleanup proof primitives. Reserved allocation, oracle, promotion,
production cutover, public recovery, and delivery remain inactive.

Creation and each migration are atomic. Before use, open checks
`quick_check`, `foreign_key_check`, migration contiguity/checksums, and the
supported `user_version`. Corruption, checksum drift, gaps, or version
disagreement is `RICKGENT_STATE_CORRUPT`; a newer schema is
`RICKGENT_STATE_SCHEMA_FUTURE`; a rolled-back migration is
`RICKGENT_STATE_MIGRATION_FAILED`. None of these paths deletes, renames,
truncates, recreates, or treats the database as empty.

## Relational model and mutation rules

All 30 frozen v1 tables are SQLite `STRICT` tables:

1. `schema_migrations`
2. `repositories`
3. `run_manifests`
4. `runs`
5. `ticket_contracts`
6. `run_tickets`
7. `run_ticket_dependencies`
8. `attempts`
9. `execution_contexts`
10. `phase_executions`
11. `evidence`
12. `state_transitions`
13. `transition_evidence_refs`
14. `leases`
15. `attempt_resources`
16. `process_receipts`
17. `gate_results`
18. `review_records`
19. `remediation_records`
20. `commit_attributions`
21. `salvage_records`
22. `cleanup_records`
23. `oracle_decisions`
24. `oracle_input_references`
25. `promotion_intents`
26. `delivery_intents`
27. `remote_observations`
28. `pr_observations`
29. `delivery_records`
30. `legacy_artifacts`

Migration 002 adds three more `STRICT` tables:

31. `attempt_ownership_leases`
32. `attempt_resource_claims`
33. `attempt_ownership_operations`

Migration 003 adds three append-only `STRICT` tables:

34. `attempt_process_launches`
35. `attempt_process_observations`
36. `attempt_process_terminal_receipts`

Migration 004 adds one CAS `STRICT` table:

37. `attempt_commit_intents`

Migration 005 adds nine cleanup-proof `STRICT` tables:

38. `target_start_gates`
39. `attempt_target_proof_sets`
40. `attempt_target_proof_members`
41. `cleanup_eligibility_records`
42. `failure_cleanup_records`
43. `promotion_cleanup_records`
44. `quarantine_claim_sets`
45. `quarantine_claim_members`
46. `quarantine_records`

Oracle v2 resolves only the current t18 ownership/claim snapshots and one
sealed-complete target-proof set. Legacy v1 leases, resources, process receipts,
and cleanup records remain readable for immutable replay compatibility but are
not current oracle inputs. Resource absence is a post-oracle disposition fact,
not an oracle prerequisite.

These tables separate pre-materialization ownership from runnable execution
contexts. Acquisition inserts one live ownership generation and all eleven fixed
claims in one `BEGIN IMMEDIATE` transaction. The operation log is append-only;
lease and claim identities are immutable, versioned snapshots.

The JSON catalog freezes every column, primary key, foreign key and explicit
`ON DELETE RESTRICT` action, uniqueness/partial uniqueness rule, check,
immutable column, and mutation trigger. Canonical IDs are nonempty; versions
and sequences are nonnegative; attempt numbers are positive; JSON and SHA-256
digests are validated; Git OIDs match repository object format.

Composite foreign keys carry lineage from ticket allocation through attempts,
execution contexts, phase executions, evidence, leases, resources, process
receipts, gates, reviews, remediation, attribution, salvage, and cleanup. They
also protect the terminal authority boundary: an oracle decision's nonnull
ticket and attempt must belong to its run; each oracle reference copies that
exact scope; and a promotion intent binds its run, ticket, attempt, accepted
oracle decision, attribution, and owner context to one hierarchy.
`persist_oracle_decision` rejects any input whose canonical lineage differs.
Run-, ticket-, and attempt-scoped oracle idempotency use three partial unique
indexes so SQLite `NULL` semantics cannot admit duplicate keys.

Immutable evidence tables are append-only with `BEFORE UPDATE` and
`BEFORE DELETE` abort triggers. The six frozen-v1 mutable snapshots/intents—`runs`,
`run_tickets`, `attempts`, `leases`, `attempt_resources`, and
`promotion_intents`—plus the v2 ownership lease and claim tables protect identity columns and permit state changes only
through named compare-and-set operations. No generic update API exists.
Promotion intents are unique per attempt. Per-ticket uniqueness applies only
while an intent is in flight, so a terminal `conflicted` intent cannot prevent
a retry from recording an intent for its newly allocated attempt.

Every transition transaction loads the exact old state/version, validates the
edge/guard/service, resolves immutable inputs, checks scoped idempotency,
inserts evidence plus transition references, then updates with a
`WHERE <id> = ? AND state = ? AND state_version = ?` compare-and-swap. Zero
rows is `RICKGENT_STATE_CONFLICT`; illegal edges, changed idempotent input, or
wrong ownership have distinct stable errors. A crash exposes exactly the old
or new committed state.

Ownership leases store token digests, never plain tokens. The raw token remains
inside a runtime-unforgeable `LeaseAuthority` grant; Store commits accept only
symbol-gated commands, so a readable database digest is not a bearer
credential. Acquisition derives generation, context, ref, path, and identity
digests from authoritative lineage and reserves the complete fixed claim set
atomically. Heartbeat, cleanup, current-owner assertions, and claim mutation
check token digest, generation, current ownership, state, version, and expiry.
Allocation/activation additionally require runtime-unforgeable, kind-specific
workspace observation receipts. The selected repository and Git common
directory are carried by the ownership grant and rechecked around Git
observations; runtime `.git` retargeting fails closed. The ready-workspace
handle is runtime-unforgeable and bound to the authority-derived ref, baseline,
worktree, administrative directory, and isolated index. Readiness uses
read-only observations between entry and final live-owner fences, returns the
current cleanup-capable grant on failure, and mints an unforgeable exact-target,
generation/version/expiry-bound spawn observation for the future t22 consumer.
Phase 21 supplies a terminal physical-release command; retained ambiguity may
still transition to lifecycle quarantine, but `CleanupService` cannot mint a
quarantine receipt without a separately implemented and verified quarantine
move. Release accepts only a runtime-unforgeable `CleanupService` receipt. Before the first destructive
effect, the exact cleanup owner must pass a Store-observed readiness gate that
joins authoritative t19 terminal/group-death evidence, a captured-or-positively-empty
t21 salvage record, the full cleanup-pending v2 claim set, and an attempt-ref
postimage equal to either the delivery baseline or the exact finalized t20
candidate. Finalization re-observes delivery and attempt-ref absence, writes
reserved cleanup evidence, terminalizes every v2 claim, and terminalizes the
same owner in one immediate transaction. Partial uniqueness permits
only one `live|cleanup_pending` ownership generation per attempt. Stale cleanup
requires expiry and exact immutable process-group death evidence, quarantines
the old owner, and transfers claims only into cleanup under a new
recovery-only generation. Phase 19 now produces real process-group and sampled
tracked-identity death evidence through a runtime-unforgeable supervisor
command. The immutable launch binds
PID/PGID, platform boot/start identity, ownership generation and ownership
context separately from phase/execution-context identity before target exec.
Ordered observations bind bounded stdout/stderr receipts, exit, escalation,
group death, and infrastructure failure to one launch; one terminal receipt
seals their exact IDs, schemas, content digests, ordering, and result digest.
Group death, death of every sampled exact PID/start identity, and authoritative
all-descendant death remain separate facts. The default POSIX adapter records
`sampled_tracked_identities` and never upgrades a process-table sampling gap
into proof that no descendant escaped. Only t22's validated
`authoritative_containment` backend may set all-descendant death, and only that
fact together with group death can authorize stale cleanup recovery. The
consumer verifies the evidence content
digest and its exact durable launch, terminal, execution-context, and ownership
lineage rather than trusting payload identifiers. A crashed recovery cleanup
generation can itself be recovered under the same exact rule.
The generic evidence appender rejects the reserved `ProcessSupervisor`,
`SalvageService`, and `CleanupService` producer labels. Their symbol-gated
Store paths are the only current producers, and generic v1 lifecycle writers
cannot manufacture current process, salvage, or cleanup truth.

Salvage capture never mutates the caller or attempt index. It makes a bounded,
double-observed inventory of regular files, directories, symlinks, modes,
binary bytes, deletions, the complete isolated-index snapshot and staged blob
bytes, ref OIDs, and committed object graphs relative to the exact baseline.
The exact attempt ref and index are part of the owner-bound receipt. Capture is
accepted only when it postdates the exact authoritative terminal/group-death
chain. A content-addressed 0600 artifact is fsynced and published
outside the removable allocation root before its owner-bound SQLite receipt is
accepted, and its bytes are reopened and digest-verified again at readiness and
finalization. `empty` is a positive comparison result; any bound, identity, I/O,
or archive failure is `capture_failed` and cannot authorize cleanup. Restore
validates the artifact and every entry digest before extracting the failed-work
delta into an empty, owned destination. It is not a baseline-aware Git replay:
the deletion inventory, index snapshot, and bundle remain recovery material for
an authority-owned importer. A recovery owner may consume an
exact salvage receipt from its ownership ancestry, so a crash after receipt
commit does not force recapture from an already-removed worktree.

The released-v1 mutable `leases` and `attempt_resources` rows are never direct
oracle inputs. When present, their lease acquisition and CAS history is represented by immutable
`rickgent.lease-snapshot.v1` evidence post-image; resource reservation and every
resource history does the same with
`rickgent.attempt-resource-snapshot.v1`. Each snapshot includes the source
identity, attempt, state, and state version in its canonical hashed payload.
The oracle references only those append-only evidence rows. Later release or
heartbeat writes therefore cannot erase the exact version accepted by an
earlier oracle evaluation. Phase 18 exposes no generic writer for these v1
rows; its additive ownership aggregate is the internal successor, while t22
owns the complete oracle/lifecycle production cutover.

## Allocation, retry, resume, and resources

An ordinary build always allocates a fresh random run and next repository run
sequence in one `allocate_run` transaction after strict contract
normalization. Identical input is still a new run: there is no find-or-create,
latest-run lookup, terminal-dispatch cache, or cross-run ticket reuse.
The transaction commits only planned, version-zero identity snapshots. Those
snapshots are explicitly non-runnable: the legal activation transitions owned
by `t15` must commit before any lease, resource, policy materialization, or
spawn activity. Dependency digests hash the canonical
`{run_id,ticket_id,depends_on_ticket_id}` tuple so identical plans in distinct
runs cannot collide.

`allocate_attempt` chooses `max(attempt_number) + 1` inside the explicit run
ticket and commits the attempt, allocation owner, baseline delivery OID, and
compatibility projection before the legal activation transition, lease
acquisition, resource side effects, policy materialization, or spawn. Initial
and retry allocation therefore return a non-runnable planned identity; `t15`
atomically activates it through the frozen transition graph. A retry checks
its exact contract, context, oracle, capability, and resource versions inside
the same allocation transaction. It can never reuse an attempt or dispatch
identity.

Run allocation accepts only the compiled, versioned capability snapshot and
an existing commit in the selected repository as its initial delivery
baseline. Durable execution contexts project the allocated repository, run,
ticket, attempt, phase, budgets, timeout, scope, model, and authenticated
pre-context policy-bundle identities exactly. Context and phase rows commit as
one transaction; terminal attempts may replay an existing tuple but cannot
mint a new one.

Resume names exactly `--repo <repo> --run <run-id>`. Bare/latest/CWD resume is
invalid. It rejects repository, manifest/contract, context-schema, oracle,
capability-snapshot, or resource-identity incompatibility. Resume may finish
an idempotent side effect or cleanup for the same attempt, but spawning is a
retry and requires a newly allocated attempt. Public resume and retry remain
unavailable at this decision-only boundary.

Attempt resource kinds reserve delivery/attempt refs, worktree, isolated
index, policy context/bundle, process group, stdout/stderr, verification
output, and salvage archive identities. Refs are validated before reservation;
every identity is reserved before its side effect. Process ownership includes
PID, PGID, platform boot/process-start identity, phase/context, and lease
generation. PID alone is never ownership proof. Phase 18 implements the
internal reservation and detached ref/worktree/index reconciliation primitive.
It preserves dirty caller state, rejects symlink/traversal and foreign or dirty
attempt state, and durably quarantines ambiguity. It does not replace the
production run-level workspace; that critical-section cutover is Phase 22.

## Lifecycle and terminal meaning

The attempt graph is:

```text
planned -> implementing -> implementation_captured -> reviewing
reviewing -> verification_queued -> verifying -> converging -> cleanup_pending
reviewing -> remediating -> remediation_captured -> reviewing
cleanup_pending -> oracle_evaluation -> verified
cleanup_pending -> failed_clean | quarantined
```

Attempt terminal states are `failed_clean`, `quarantined`, and `verified`.
Timeout is an observation, not a terminal state; failure first enters or
remains `cleanup_pending` until cleanup is proven or quarantined.

Ticket state advances from `planned` to `active` and then through
`cleanup_pending`. Only retry allocation may return it to `active`; cleanup may
produce `failed` or `quarantined`; only `TicketFinalizationService` may produce
`ready_for_delivery` from an accepted exact oracle decision plus finalized
promotion and cleanup evidence.

Runs advance from `planned` to `active`, possibly through cleanup/failure, then
to `ready_for_delivery` only when every planned ticket is ready and the
delivery ref equals the recorded chain OID. Run `ready_for_delivery` is not
terminal. Only `DeliveryService` can advance it to terminal `delivered` or
`delivery_failed`. `Done` is never stored; it is a presentation-only alias for
run `delivered`.

The attempt ownership lease and target start gate state machines are:

```text
reserved -> live -> cleanup_pending -> released
cleanup_pending -> quarantined
held -> released
held -> closed_never_released
collecting -> sealed
```

The `live -> cleanup_pending` edge is owned by `LeaseService` and requires a
live owner-checked lease: the caller must present the exact `owner_token_digest`
for the ownership row (a missing or stale owner fails closed to
`RICKGENT_STATE_OWNER_MISMATCH`); the caller must present the expected ownership
preimage (`state='live'` + `state_version`), so a non-live state or stale
version fails to `RICKGENT_STATE_CONFLICT`; a defense-in-depth guard
additionally rejects a non-live state with `RICKGENT_STATE_TRANSITION_ILLEGAL`;
the transition commits via a CAS on `ownership_id` + `owner_token_digest` +
`state='live'` + `state_version` (a concurrent mutation fails to
`RICKGENT_STATE_CONFLICT`). An expired lease is admitted to cleanup containment
via this transition (the workspace readiness path calls `beginCleanup` on expiry
to enter `cleanup_pending`); the expiry gate is enforced downstream on heartbeat
and resource-advance operations, not on the begin-cleanup transition itself. The
attempt-cleanup-entry evidence (candidate attribution or failure evidence, or
stale recovery under exact process-group death) is owned by the t19/t20
process-supervision chain and is not enforced by this Store-level transition;
it is verified by the caller before requesting `beginCleanup`. The `held -> released` edge is owned by
`TargetStartGateAuthority` and requires a validated containment authority
authorizing target release, binding a held target start gate (`state_version`
0) to the exact attempt ownership/generation/context lineage; unavailable
containment fails closed without manufacturing a terminal receipt. The
`held -> closed_never_released` edge is owned by `TargetStartGateAuthority`
and requires a target-never-released disposition receipt minted by the
`LeaseAuthority`-branded mint capability, binding a held target start gate
(`state_version` 0) to the exact attempt ownership/generation/context lineage;
unavailable containment or a pre-release failure fails closed without
manufacturing a terminal receipt, and missing evidence is
`RICKGENT_STATE_TRANSITION_ILLEGAL`. Both target start gate edges are
compare-and-set transitions from held version 0 to a terminal version 1 and
remain unavailable until the t22 disposition writers are connected.

The quarantine claim-set edge `collecting -> sealed` is owned by the
LeaseAuthority-branded `StateStore.mintQuarantine` command. It atomically
inserts all normalized member snapshots while the exact claim-set parent is at
`collecting` version 0, then compare-and-set seals that same parent at version
1 with its content digest and immutable evidence. The database's
collecting-only and complete-seal triggers reject a missing, partial,
non-contiguous, or post-seal member set. Any lost compare-and-set race or
missing authority-minted evidence fails closed to `RICKGENT_STATE_CONFLICT` or
`RICKGENT_STATE_TRANSITION_ILLEGAL`.

## Pure oracle and fast-forward promotion

The versioned oracle consumes an ordered, content-pinned set of immutable
manifest, contract, context, dependency, evidence, gate, review, attribution,
cleanup, resource-snapshot, lease-snapshot, and process references resolved in
one read transaction. Direct references to mutable lease or resource rows are
forbidden. Every reference repeats the owning decision scope, and the decision
transaction follows each target's canonical lineage and rejects cross-run,
cross-ticket, or cross-attempt input. For required gates, only `passed` is
green; failed, missing, null, skipped, unavailable, infrastructure-error,
stale, and conflicting results all block.

The oracle is a pure function. It does not read live files, Git refs,
processes, environment, legacy data, or commit subjects and does not update
SQLite. It emits accepted/rejected plus deterministic input/output digests and
all reasons. Only finalization services consume an accepted decision to write
`ready_for_delivery`; workers, phase runners, dispatchers, CLI, status,
metrics, reconcile, and generic repositories have no terminal-writer API.

Accepted commits form one sequential compare-and-swap fast-forward chain:

1. Persist one promotion intent for the run, including exact old/candidate
   OIDs, sequence, oracle, attribution, owner/context, and idempotency. Composite
   foreign keys require all scope-bearing rows to belong to the same run,
   ticket, and attempt.
2. Run
   `git -C <repo-realpath> update-ref <delivery-ref> <candidate-oid> <expected-old-oid>`
   with no merge, rebase, force, or fallback. Caller CWD never selects the
   repository whose ref is updated.
3. Independently observe the ref: candidate is success, old is retryable, and
   any third OID is `RICKGENT_PROMOTION_CONFLICT`.
4. After cleanup and lease release, atomically finalize the intent, CAS the run
   delivery OID/version/sequence, mark the attempt verified, and let
   `TicketFinalizationService` make the ticket ready.

Sequence one expects the run's initial OID; sequence n expects sequence n-1's
candidate OID. Each accepted candidate has its attempt baseline as sole parent.
Crashes reconcile only from the persisted old/candidate pair. Delivery tables
are reserved: future `delivered` requires independently observed remote and PR
head OIDs equal to the exact run delivery OID. A `delivery_failed` record stores
its terminal source state and immutable decision evidence. Remote and PR
observation references are nullable and are present only if those stages were
actually reached, so an early failure never requires a fabricated observation.
A `conflicted` promotion intent is terminal; any later spawn must first
allocate a new attempt, whose distinct intent is not blocked by the old row.

## Legacy quarantine and one-way cutover

Legacy JSON, JSONL, lock files, attempt receipts, salvage archives, and
`ticket: <id>` Git subjects are either quarantined or bounded diagnostic
read-only inventory. Diagnostics do not follow symlinks and may record only
path/stat/hash metadata in `legacy_artifacts`.

Legacy data can never import a run, attempt, evidence claim, commit OID,
terminal state, or `Done`; Git subjects are never lifecycle authority. Corrupt
legacy content is not empty state. Mutation open in the presence of lifecycle
legacy state fails with `RICKGENT_LEGACY_STATE_QUARANTINED` and explicit
archive/remove guidance.

t16 performs the one-way caller cutover. Afterward SQLite is the only
authoritative writer. Environment fallback, feature fallback, shadow writes,
and long-lived dual writes are forbidden. Historical metrics may remain a
separate diagnostic view but cannot contribute terminal or delivery truth.

## Capability boundary

This contract reserves later rows and APIs without pretending they exist.
t13 implements durable SQLite and migrations, t14 allocation, t15 oracle and
promotion, t16 caller cutover selectors, and t17 the bounded common-transaction
crash and retry-identity proof. Full recovery/reconciliation remains reserved
for t29 after the operational lifecycle services exist. The t18
attempt-resource, t19 process-supervision, t20 commit-attribution, and t21
salvage/cleanup primitives are implemented but disabled for production. t19's sampled tracker is diagnostic and cleanup-safe,
not release authority; t22 must supply authoritative macOS/Linux containment
before cutover. t22, t23, and t29 own integration, stress, and reconciliation
boundaries. Automatic delivery remains reserved.
