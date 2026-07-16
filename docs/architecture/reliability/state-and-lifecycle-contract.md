# State and lifecycle contract

Status: frozen decision only (`rickgent-state-and-lifecycle-v1`, schema
`1.0.0`). The normative, closed machine contract is
[`state-and-lifecycle-contract.json`](./state-and-lifecycle-contract.json).
This document explains that contract; it does not activate persistence,
resume, retry, promotion, reconciliation, attempt resources, or delivery.
Those capabilities remain `reserved_contract_only` until their named adoption
tickets land.

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

t13 will implement the contract with `node:sqlite` `DatabaseSync`. The state
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
`001_initial_durable_state` is reserved here; t13 owns its executable SQL and
released checksum. `schema_migrations` records the immutable version, unique
name, exact-definition SHA-256, and application time. Its rows and
`PRAGMA user_version` must agree. Released migrations never change; later
versions append `002`, `003`, and so on.

Creation and each migration are atomic. Before use, open checks
`quick_check`, `foreign_key_check`, migration contiguity/checksums, and the
supported `user_version`. Corruption, checksum drift, gaps, or version
disagreement is `RICKGENT_STATE_CORRUPT`; a newer schema is
`RICKGENT_STATE_SCHEMA_FUTURE`; a rolled-back migration is
`RICKGENT_STATE_MIGRATION_FAILED`. None of these paths deletes, renames,
truncates, recreates, or treats the database as empty.

## Relational model and mutation rules

All 30 v1 tables are SQLite `STRICT` tables:

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

The JSON catalog freezes every column, primary key, foreign key and explicit
`ON DELETE RESTRICT` action, uniqueness/partial uniqueness rule, check,
immutable column, and mutation trigger. Canonical IDs are nonempty; versions
and sequences are nonnegative; attempt numbers are positive; JSON and SHA-256
digests are validated; Git OIDs match repository object format.

Composite foreign keys carry lineage across the terminal authority boundary.
An oracle decision's nonnull ticket and attempt must belong to its run; each
oracle reference copies that exact scope; and a promotion intent binds its run,
ticket, attempt, accepted oracle decision, attribution, and owner context to
one hierarchy. `persist_oracle_decision` rejects any input whose canonical
lineage differs. Run-, ticket-, and attempt-scoped oracle idempotency use three
partial unique indexes so SQLite `NULL` semantics cannot admit duplicate keys.

Immutable evidence tables are append-only with `BEFORE UPDATE` and
`BEFORE DELETE` abort triggers. The six mutable snapshots/intents—`runs`,
`run_tickets`, `attempts`, `leases`, `attempt_resources`, and
`promotion_intents`—protect identity columns and permit state changes only
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

Leases store token digests, never plain tokens. Heartbeat, cleanup, release,
and resource mutation check token digest, generation, context, state, and
version. Partial uniqueness permits only one `live|cleanup_pending` lease per
attempt. Stale recovery requires expiry, proven old process-group death, and
immutable recovery evidence before cleanup ownership can move.

The mutable `leases` and `attempt_resources` rows are never oracle inputs.
Lease acquisition and every lease CAS atomically append an immutable
`rickgent.lease-snapshot.v1` evidence post-image; resource reservation and every
resource CAS do the same with
`rickgent.attempt-resource-snapshot.v1`. Each snapshot includes the source
identity, attempt, state, and state version in its canonical hashed payload.
The oracle references only those append-only evidence rows. Later release or
heartbeat writes therefore cannot erase the exact version accepted by an
earlier oracle evaluation.

## Allocation, retry, resume, and resources

An ordinary build always allocates a fresh random run and next repository run
sequence in one `allocate_run` transaction after strict contract
normalization. Identical input is still a new run: there is no find-or-create,
latest-run lookup, terminal-dispatch cache, or cross-run ticket reuse.

`allocate_attempt` chooses `max(attempt_number) + 1` inside the explicit run
ticket and commits the attempt, allocation owner, baseline delivery OID, and
initial transitions before lease acquisition, resource side effects, policy
materialization, or spawn. A retry that will spawn must allocate first and can
never reuse an attempt or dispatch identity.

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
generation. PID alone is never ownership proof. These rows reserve a later
contract; they do not claim resource allocation is implemented.

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
promotion, t16 caller cutover/resume/retry, and t17 recovery/reconciliation.
Attempt resources and automatic delivery remain later work. Until adoption,
all are disabled and `reserved_contract_only`.
