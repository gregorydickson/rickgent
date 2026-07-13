# Decision: State Management

## Component
§2 matrix row — state management (conversation/session state persistence + pipeline-level state).

## Omnigent implementation
Omnigent uses SQLAlchemy + Alembic for all persisted state. The DB layer lives in `omnigent/db/`:

- `omnigent/db/db_models.py` — SQLAlchemy ORM models. `SqlConversation` (`db_models.py:355`, `__tablename__ = "conversations"` at `db_models.py:431`) holds per-conversation `session_state: Mapped[str | None] = mapped_column(CompressedText, nullable=True)` (`db_models.py:500`) — a compressed JSON blob persisted across turns. `SqlConversationItem`, `SqlConversationLabel`, `SqlUserDailyCost` (`db_models.py:1019, 1056`), `SqlAgent`, `SqlFile`, `SqlUser`, `SqlAccountToken`, `SqlSessionPermission`, `SqlPolicy`, `SqlHost`, `SqlComment` round out the schema.
- `omnigent/db/migrations/` — Alembic-managed migrations: `env.py`, `script.py.mako`, and `versions/` containing 59 migration files (confirmed: 59 entries in `omnigent/db/migrations/versions/`). Schema evolution is migration-gated.
- `omnigent/db/compression.py` — `CompressedText` codec for large JSON columns (session_state).
- `omnigent/db/enum_codecs.py`, `omnigent/db/converters.py`, `omnigent/db/utils.py` — enum encoding and DB utilities.

The store layer lives in `omnigent/stores/`:
- `omnigent/stores/host_store.py` (32KB) — host registry.
- `omnigent/stores/conversation_store/` — conversation persistence (including `SqlAlchemyConversationStore`, used by `resume_dispatch._read_wrapper_label_local` to `get_conversation(conv_id)` and read `labels`).
- `omnigent/stores/agent_store/`, `omnigent/stores/artifact_store/`, `omnigent/stores/comment_store/`, `omnigent/stores/file_store/`, `omnigent/stores/permission_store/`, `omnigent/stores/policy_store/`.

Per-conversation `session_state` JSON is persisted across turns in the `conversations` table — this is where cost-budget approval keys, model override, and other per-conversation state live. It is conversation-scoped, NOT pipeline-scoped: there is no table for "tickets", "phases", "baselines", or "pipeline progress".

## Pickle Rick implementation
Pickle Rick uses a single `state.json` file per session, managed by `pickle-rick-claude/extension/src/services/state-manager.ts`:

- `StateManager` class — atomic file-lock-protected operations (`state-manager.ts:StateManager`).
- `read(statePath)` — parse, run schema migration via `migrateSchema`, run recovery protocol (orphan tmp files, stale active flag, phantom demotion) (`state-manager.ts:read`, `state-manager.ts:migrateSchema`).
- `update(statePath, mutator)` — lock, read, mutate, write, unlock (`state-manager.ts:update`).
- `transaction(paths, mutator)` — multi-file transaction with rollback: locks all paths in sorted order (cross-tx deadlock prevention), snapshots originals, writes all with rollback on failure (`state-manager.ts:transaction`, `state-manager.ts:writeAllWithRollback`).
- `forceWrite(statePath, state)` — best-effort, no lock, never throws (for signal/crash handlers) (`state-manager.ts:forceWrite`).
- Schema versioning: `LATEST_SCHEMA_VERSION = 5` (`types/index.ts`); `STATE_MANAGER_DEFAULTS.schemaVersion` must match (deploy-parity self-check `assertSchemaVersionDeployParity`) (`state-manager.ts:assertSchemaVersionDeployParity`). `migrateSchema` forwards old schemas to current with `normalizeV3/V4/V5StateDefaults` + legacy field migrations (`state-manager.ts:migrateSchema`).
- R-WSRC-1 schema-version ceiling: `assertSchemaVersionWithinCeiling` refuses forward-schema writes (`schema_version > LATEST_SCHEMA_VERSION`) from workers, with `_internalSchemaBump` bypass for the legitimate migration path only (`state-manager.ts:assertSchemaVersionWithinCeiling`, `SchemaVersionAheadError`).
- Atomic file locks: `acquireLockFile` (O_CREAT|O_EXCL), `releaseLockFile` (inode-proven ownership), `stealLockFile` (dead-pid stale recovery), `withStealRight` (serialized stale recovery to prevent two-stealer eviction of a live holder) (`state-manager.ts:acquireLockFile, releaseLockFile, stealLockFile, withStealRight`).
- Orphan tmp recovery: `recoverOrphanTmpFiles` promotes a dead-process tmp snapshot if it represents a newer state write (iteration-first, mtime tie-break with candidate winning ties) (`state-manager.ts:recoverOrphanTmpFiles`, `isStateSnapshotNewer`).
- Bounded activity ring: `ACTIVITY_RING_MAX = 2000` with drop-oldest, exempt recovery events (`state-manager.ts:trimActivityRing`).

The `state.json` schema holds pipeline-level state: `working_dir`, `original_prompt`, `iteration`, `max_iterations`, `worker_timeout_seconds`, `current_ticket`, `step`, `phase`, `tickets_version`, `start_commit`, `readiness`, `activity`, `recovery_attempts`, `orphans_detected`, etc. (`state-manager.ts:isRecoverableStateSnapshotCandidate`, `V3_STATE_SHAPE_MARKERS`). This is pipeline-level state that Omnigent's conversation-scoped `session_state` does not model.

## Contract
What this component does: persist (a) conversation/session state across turns and (b) pipeline-level state (tickets, phases, baselines, iteration counts, recovery ledgers) across crashes and relaunches.

Invariants:
- Conversation state is per-conversation JSON, persisted across turns, compressed at rest.
- Pipeline-level state is a single source of truth per pipeline run, atomically written (lock + tmp + rename), with schema versioning and forward-schema-write rejection.
- Crashes leave orphan `.tmp.<pid>` files; recovery promotes the newest valid dead-process snapshot (iteration-first, mtime tie-break).
- Schema migrations are explicit (Alembic for Omnigent DB; `migrateSchema` + `LATEST_SCHEMA_VERSION` for Pickle Rick file state).
- Multi-file state transitions are transactional with rollback.
- The pipeline-level registry is a DERIVED INDEX, rebuildable from git truth (frontmatter status, commits) via reconcile — never the ground truth itself.

Failure modes:
- Forward-schema state written by a worker subprocess → refused (R-WSRC-1 ceiling) to prevent runtime wedge.
- Corrupt base state file → recover from orphan tmp; if none, throw CORRUPT.
- Stale lock held by dead process → stolen after proven-dead check; live process never evicted (serialized steal right).
- Two concurrent writers → file lock + sorted-path transaction ordering prevents cross-tx deadlock.

## Evaluation
For Rickgent's goals, the two layers serve DIFFERENT state scopes and both are needed.

- Omnigent's SQLAlchemy + Alembic layer is the right backbone for conversation/session state: 59 migrations of schema evolution, `CompressedText` for large JSON, `SqlAlchemyConversationStore` with `get_conversation`, and `session_state` persisted across turns. Rickgent should reuse this for conversation-scoped state (per-conversation JSON, cost-budget approval keys, model override) — re-implementing a DB layer would be pure waste.
- Omnigent's `session_state` is conversation-scoped only. It has NO model for pipeline-level state (tickets, phases, baselines, iteration counts, recovery ledgers). Rickgent needs this and Omnigent does not provide it.
- Pickle Rick's `state-manager.ts` is the right backbone for pipeline-level file state: atomic file locks, schema versioning with forward-write rejection (R-WSRC-1), orphan tmp recovery, multi-file transactions with rollback, bounded activity ring. This is a battle-hardened single-file state manager.
- BUT Pickle Rick's `state.json` conflates "one pipeline run" with "one state file" and couples tightly to its own runtime (worker forbidden ops, `LATEST_SCHEMA_VERSION`, deploy-parity drift checks). Rickgent should NOT inherit the Pickle Rick runtime coupling — it should inherit the STATE MANAGEMENT SEMANTICS (atomic locks, schema versioning, orphan recovery, transactions) applied to a Rickgent-shaped registry.

The §2.1.1 finding names the right split: Omnigent DB for session state + `.rickgent/registry.json` for pipeline-level state. The registry is a derived index, rebuildable via reconcile from git truth — NOT the ground truth. Ground truth lives in git (commits, frontmatter) and in the Omnigent DB (conversation state); the registry is a cache.

MASH: Omnigent DB (SQLAlchemy + Alembic, `session_state`, `SqlAlchemyConversationStore`) for conversation/session state + a Rickgent-owned `.rickgent/registry.json` for pipeline-level state, borrowing Pickle Rick's `state-manager.ts` semantics (atomic file locks, schema versioning with ceiling, orphan tmp recovery, multi-file transactions) but NOT the Pickle Rick runtime coupling. The registry is derived — rebuildable via a reconcile pass over git truth.

## §2.1.1 Finding
ADOPT — "CONFIRMED. SQLAlchemy + Alembic (59 migrations), per-conversation session_state JSON persisted across turns. Pipeline-level state (tickets, phases, baselines) still needs `.rickgent/registry.json`."

Confirmed by source:
- SQLAlchemy + Alembic — `omnigent/db/db_models.py` (ORM), `omnigent/db/migrations/` (Alembic), 59 migration files in `versions/`.
- Per-conversation `session_state` JSON persisted across turns — `SqlConversation.session_state: CompressedText` (`db_models.py:500`).
- Pipeline-level state not modeled — no Omnigent table for tickets/phases/baselines; `session_state` is conversation-scoped. Pickle Rick's `state.json` (`state-manager.ts:V3_STATE_SHAPE_MARKERS`, `isRecoverableStateSnapshotCandidate`) models exactly this pipeline-level shape.

The finding is adopted as written.

## Decision: mash
MASH — Omnigent DB (SQLAlchemy + Alembic, `session_state` via `SqlConversation.session_state`, `SqlAlchemyConversationStore`) for conversation/session state + `.rickgent/registry.json` for pipeline-level state (a derived index, rebuildable via reconcile from git truth), borrowing Pickle Rick `state-manager.ts` semantics (atomic file locks, schema versioning with forward-write ceiling, orphan tmp recovery, multi-file transactions with rollback) but NOT the Pickle Rick runtime coupling.

## Reasoning
Rickgent has two state scopes. Conversation/session state (per-conversation JSON across turns, cost-budget approval keys, model override) fits Omnigent's DB layer perfectly — 59 migrations of evolution, `CompressedText` compression, `SqlAlchemyConversationStore.get_conversation` (used by `resume_dispatch._read_wrapper_label_local`). Reusing this avoids re-implementing a DB + migration framework.

Pipeline-level state (tickets, phases, baselines, iteration counts, recovery ledgers) has no Omnigent home — `session_state` is conversation-scoped. Rickgent needs a `.rickgent/registry.json` for this. Pickle Rick's `state-manager.ts` has the right file-state semantics: atomic locks with inode-proven ownership and serialized stale recovery (`acquireLockFile`, `withStealRight`), schema versioning with forward-write rejection (`assertSchemaVersionWithinCeiling`, `LATEST_SCHEMA_VERSION=5`), orphan tmp recovery with iteration-first precedence (`recoverOrphanTmpFiles`, `isStateSnapshotNewer`), and multi-file transactions with rollback (`transaction`, `writeAllWithRollback`). Rickgent should borrow these semantics.

What Rickgent must NOT inherit from Pickle Rick: the runtime coupling (worker forbidden ops R-WSRC, `STATE_MANAGER_DEFAULTS` deploy-parity drift checks, `LATEST_SCHEMA_VERSION` shared between types and state-manager, the `pickle_settings.json` / `circuit_breaker.json` / `pipeline-status.json` config-protection hooks). Rickgent's registry is its own schema, versioned independently.

Critically, the registry is a DERIVED INDEX — rebuildable via a reconcile pass over git truth (frontmatter status, commits, branch state). Pickle Rick's `reconcileTicketTruth` (`mux-runner.ts:reconcileTicketStateDesync`, `reconcileInProgressSet`) and `graduationDecision` (`state-manager.ts:graduationDecision` — keys on real progress `doneCount + commitCount`, never the bare `pendingCount/ticketCount` ratio) prove the reconcile-from-git-truth pattern. Rickgent adopts the same: git is ground truth, registry is a cache. If the registry is lost or corrupt, a reconcile pass rebuilds it; if git and the registry disagree, git wins.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `omnigent/db/db_models.py:490-505` confirms compressed conversation state; `extension/src/services/state-manager.ts:71-99,153-170` confirms forward-schema rejection.
- **Notes:** Durable conversation state plus a rebuildable git-derived index is sound.
- **Date:** 2026-07-12
