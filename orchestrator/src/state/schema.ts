/**
 * Declarative vocabulary for the frozen state-and-lifecycle contract.
 *
 * This module intentionally has no filesystem, Git, SQLite, migration, store,
 * or writer behavior. Executable persistence begins in t13.
 */

function deepFreeze<const T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const STATE_CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export const STATE_SCHEMA_VERSION = STATE_CONTRACT_SCHEMA_VERSION;
export const STATE_CONTRACT_ID = "rickgent-state-and-lifecycle-v1" as const;
export const STATE_CONTRACT_DECISION_STATUS = "frozen_decision_only" as const;
export const STATE_CONTRACT_IMPLEMENTATION_STATUS = "partial_internal_primitives" as const;
export const STATE_SQLITE_MINIMUM_NODE_VERSION = "24.12.0" as const;

export const SQLITE_CONNECTION_OPTION_MAPPING = deepFreeze({
  foreign_keys: "enableForeignKeyConstraints",
  defensive: "defensive",
  allow_extension_loading: "allowExtension",
  allow_double_quoted_string_literals: "enableDoubleQuotedStringLiterals",
  allow_unknown_named_parameters: "allowUnknownNamedParameters",
} as const);

export const INITIAL_STATE_MIGRATION = deepFreeze({
  version: 1,
  number: "001",
  name: "001_initial_durable_state",
  sql_owner_ticket: "t13",
  released_checksum: "sha256:473f6581359fb59da29236aeb77acaba74aa46504fb0ac8c0089c59afca586a8",
  sqlite_schema_checksum: "sha256:11f061a28bffe7ed02a6d5b974cca09dcff189e18fb18834659a3aad175ecef9",
  status: "implemented",
} as const);

export const ATTEMPT_OWNERSHIP_MIGRATION = deepFreeze({
  version: 2,
  number: "002",
  name: "002_attempt_ownership_primitive",
  sql_owner_ticket: "t18",
  released_checksum: "sha256:8dc1be6f92fbe281149b651c89fd1b2e8d7b4f3464c2f85a2113aa851123473d",
  sqlite_schema_checksum: "sha256:eb83ea80db2cc06eb46ffe135994fe79cf4f53146b5f71ac8a876b46f6224bbc",
  status: "implemented",
} as const);

/** Additive executable migration metadata; the frozen v1 decision catalog is unchanged. */
export const PROCESS_SUPERVISION_MIGRATION = deepFreeze({
  version: 3,
  number: "003",
  name: "003_durable_process_supervision",
  sql_owner_ticket: "t19",
  released_checksum: "sha256:c94e5b62aa8dae64740685c13159f2d19610909729c789e6638deb59855ff8ce",
  sqlite_schema_checksum: "sha256:c208339c0350aae8bd1ee3784da4e4ffc559b41e9c6079530a89da53c08753e3",
  status: "implemented",
} as const);

/** Additive executable migration metadata for the sole Git commit authority. */
export const COMMIT_ATTRIBUTION_MIGRATION = deepFreeze({
  version: 4,
  number: "004",
  name: "004_durable_commit_attribution",
  sql_owner_ticket: "t20",
  released_checksum: "sha256:66f819b89e1781ca7fdc7311e269a4991a86706224eaa269b0198ad434ce6469",
  sqlite_schema_checksum: "sha256:af782456d3402bd47cff0ca9fd4e358c52028c14fee3470efcc295cac926542d",
  status: "implemented",
} as const);

export const STATE_MIGRATIONS = deepFreeze([
  INITIAL_STATE_MIGRATION,
  ATTEMPT_OWNERSHIP_MIGRATION,
  PROCESS_SUPERVISION_MIGRATION,
  COMMIT_ATTRIBUTION_MIGRATION,
] as const);

export const STATE_TABLES = deepFreeze([
  "schema_migrations",
  "repositories",
  "run_manifests",
  "runs",
  "ticket_contracts",
  "run_tickets",
  "run_ticket_dependencies",
  "attempts",
  "execution_contexts",
  "phase_executions",
  "evidence",
  "state_transitions",
  "transition_evidence_refs",
  "leases",
  "attempt_resources",
  "process_receipts",
  "gate_results",
  "review_records",
  "remediation_records",
  "commit_attributions",
  "salvage_records",
  "cleanup_records",
  "oracle_decisions",
  "oracle_input_references",
  "promotion_intents",
  "delivery_intents",
  "remote_observations",
  "pr_observations",
  "delivery_records",
  "legacy_artifacts",
] as const);

export const CAS_STATE_TABLES = deepFreeze([
  "runs",
  "run_tickets",
  "attempts",
  "leases",
  "attempt_resources",
  "promotion_intents",
] as const);

export const APPEND_ONLY_STATE_TABLES = deepFreeze([
  "schema_migrations",
  "repositories",
  "run_manifests",
  "ticket_contracts",
  "run_ticket_dependencies",
  "execution_contexts",
  "phase_executions",
  "evidence",
  "state_transitions",
  "transition_evidence_refs",
  "process_receipts",
  "gate_results",
  "review_records",
  "remediation_records",
  "commit_attributions",
  "salvage_records",
  "cleanup_records",
  "oracle_decisions",
  "oracle_input_references",
  "delivery_intents",
  "remote_observations",
  "pr_observations",
  "delivery_records",
  "legacy_artifacts",
] as const);

/** Additive v2 tables. The frozen v1 catalog above remains immutable. */
export const ATTEMPT_OWNERSHIP_STATE_TABLES = deepFreeze([
  "attempt_ownership_leases",
  "attempt_resource_claims",
  "attempt_ownership_operations",
] as const);

/** Additive v3 ProcessSupervisor authority tables. */
export const PROCESS_SUPERVISION_STATE_TABLES = deepFreeze([
  "attempt_process_launches",
  "attempt_process_observations",
  "attempt_process_terminal_receipts",
] as const);

export const PROCESS_SUPERVISION_APPEND_ONLY_STATE_TABLES = PROCESS_SUPERVISION_STATE_TABLES;

/** Additive v4 CommitService authority aggregate. */
export const COMMIT_ATTRIBUTION_STATE_TABLES = deepFreeze([
  "attempt_commit_intents",
] as const);

export const ALL_STATE_TABLES = deepFreeze([
  ...STATE_TABLES,
  ...ATTEMPT_OWNERSHIP_STATE_TABLES,
  ...PROCESS_SUPERVISION_STATE_TABLES,
  ...COMMIT_ATTRIBUTION_STATE_TABLES,
] as const);

export const ALL_APPEND_ONLY_STATE_TABLES = deepFreeze([
  ...APPEND_ONLY_STATE_TABLES,
  "attempt_ownership_operations",
  ...PROCESS_SUPERVISION_APPEND_ONLY_STATE_TABLES,
] as const);

export const SQLITE_PRAGMAS = deepFreeze([
  { name: "foreign_keys", value: "ON" },
  { name: "journal_mode", value: "WAL" },
  { name: "synchronous", value: "FULL" },
  { name: "busy_timeout", value: 5000 },
  { name: "wal_autocheckpoint", value: 1000 },
  { name: "trusted_schema", value: "OFF" },
  { name: "recursive_triggers", value: "ON" },
] as const);

export const STATE_TRANSACTION_NAMES = deepFreeze([
  "open_and_migrate",
  "allocate_run",
  "allocate_attempt",
  "append_evidence",
  "transition_entity_cas",
  "acquire_lease",
  "heartbeat_lease",
  "process_supervisor_launch",
  "process_supervisor_terminal",
  "commit_attribution_prepare",
  "commit_attribution_finalize",
  "begin_lease_cleanup",
  "release_lease",
  "reserve_resource",
  "advance_resource",
  "quarantine_resource",
  "release_resource",
  "persist_oracle_decision",
  "create_promotion_intent",
  "observe_promotion",
  "finalize_promotion",
  "create_delivery_intent",
  "append_remote_observation",
  "append_pr_observation",
  "finalize_delivery",
  "inventory_legacy",
] as const);

export const ATTEMPT_STATES = deepFreeze([
  "planned",
  "implementing",
  "implementation_captured",
  "reviewing",
  "remediating",
  "remediation_captured",
  "verification_queued",
  "verifying",
  "converging",
  "cleanup_pending",
  "oracle_evaluation",
  "failed_clean",
  "quarantined",
  "verified",
] as const);

export const ATTEMPT_TERMINAL_STATES = deepFreeze([
  "failed_clean",
  "quarantined",
  "verified",
] as const);

export const ATTEMPT_TRANSITIONS = deepFreeze([
  { from: "planned", to: "implementing", owner: "AttemptLifecycleService", guard: "live owner-checked lease and reserved resources" },
  { from: "implementing", to: "implementation_captured", owner: "AttemptLifecycleService", guard: "immutable implementation receipt" },
  { from: "implementation_captured", to: "reviewing", owner: "ReviewService", guard: "review context and immutable input tree" },
  { from: "reviewing", to: "verification_queued", owner: "ReviewService", guard: "review accepted and required review evidence present" },
  { from: "reviewing", to: "remediating", owner: "ReviewService", guard: "review rejected and immutable remediation budget remains" },
  { from: "remediating", to: "remediation_captured", owner: "RemediationService", guard: "immutable remediation output" },
  { from: "remediation_captured", to: "reviewing", owner: "ReviewService", guard: "new review cycle within immutable budget" },
  { from: "verification_queued", to: "verifying", owner: "VerificationService", guard: "verification context and owner-checked resources" },
  { from: "verifying", to: "converging", owner: "VerificationService", guard: "all required gate results recorded" },
  { from: "converging", to: "cleanup_pending", owner: "AttemptLifecycleService", guard: "candidate attribution or failure evidence recorded" },
  { from: "cleanup_pending", to: "oracle_evaluation", owner: "TicketFinalizationService", guard: "accepted exact oracle decision and promotable candidate" },
  { from: "oracle_evaluation", to: "verified", owner: "TicketFinalizationService", guard: "promotion finalized, cleanup proven, resources absent or quarantined, lease released" },
  { from: "cleanup_pending", to: "failed_clean", owner: "CleanupService", guard: "failure or oracle rejection and complete cleanup proof" },
  { from: "cleanup_pending", to: "quarantined", owner: "CleanupService", guard: "ownership or cleanup cannot be proven" },
] as const);

export const TICKET_STATES = deepFreeze([
  "planned",
  "active",
  "cleanup_pending",
  "failed",
  "quarantined",
  "ready_for_delivery",
] as const);

export const TICKET_TERMINAL_STATES = deepFreeze([
  "failed",
  "quarantined",
  "ready_for_delivery",
] as const);

export const TICKET_TRANSITIONS = deepFreeze([
  { from: "planned", to: "active", owner: "RunAllocationService", guard: "initial attempt allocated" },
  { from: "active", to: "cleanup_pending", owner: "AttemptLifecycleService", guard: "attempt entered cleanup" },
  { from: "cleanup_pending", to: "active", owner: "RetryAllocationService", guard: "next attempt committed before spawn and budget remains" },
  { from: "cleanup_pending", to: "failed", owner: "CleanupService", guard: "clean terminal failure and no retry" },
  { from: "cleanup_pending", to: "quarantined", owner: "CleanupService", guard: "attempt quarantine" },
  { from: "cleanup_pending", to: "ready_for_delivery", owner: "TicketFinalizationService", guard: "accepted exact oracle decision, promotion finalized, and cleanup evidence" },
] as const);

export const RUN_STATES = deepFreeze([
  "planned",
  "active",
  "cleanup_pending",
  "failed",
  "delivery_failed",
  "ready_for_delivery",
  "delivered",
] as const);

export const RUN_TERMINAL_STATES = deepFreeze([
  "failed",
  "delivery_failed",
  "delivered",
] as const);

export const RUN_TRANSITIONS = deepFreeze([
  { from: "planned", to: "active", owner: "RunAllocationService", guard: "run manifest and initial transitions committed" },
  { from: "active", to: "cleanup_pending", owner: "RunLifecycleService", guard: "run-owned cleanup required" },
  { from: "active", to: "failed", owner: "RunFinalizationService", guard: "irrecoverable cleaned run failure" },
  { from: "active", to: "ready_for_delivery", owner: "RunFinalizationService", guard: "every planned ticket ready and delivery ref equals recorded chain OID" },
  { from: "cleanup_pending", to: "active", owner: "RunLifecycleService", guard: "cleanup proven and work remains" },
  { from: "cleanup_pending", to: "failed", owner: "RunFinalizationService", guard: "cleanup proven and run cannot continue" },
  { from: "ready_for_delivery", to: "delivered", owner: "DeliveryService", guard: "remote branch and PR head independently observed at exact delivery OID" },
  { from: "ready_for_delivery", to: "delivery_failed", owner: "DeliveryService", guard: "immutable delivery failure record" },
] as const);

export const LEASE_STATES = deepFreeze([
  "reserved",
  "live",
  "cleanup_pending",
  "released",
  "quarantined",
] as const);
export const LEASE_TERMINAL_STATES = deepFreeze(["released", "quarantined"] as const);
export const LEASE_TRANSITIONS = deepFreeze([
  ["reserved", "live"],
  ["live", "cleanup_pending"],
  ["cleanup_pending", "released"],
  ["cleanup_pending", "quarantined"],
] as const);

export const RESOURCE_STATES = deepFreeze([
  "reserved",
  "allocated",
  "active",
  "cleanup_pending",
  "released",
  "quarantined",
] as const);
export const RESOURCE_TERMINAL_STATES = deepFreeze(["released", "quarantined"] as const);
export const RESOURCE_TRANSITIONS = deepFreeze([
  ["reserved", "allocated"],
  ["allocated", "active"],
  ["allocated", "cleanup_pending"],
  ["active", "cleanup_pending"],
  ["cleanup_pending", "released"],
  ["cleanup_pending", "quarantined"],
] as const);

export const PROMOTION_STATES = deepFreeze([
  "intent_recorded",
  "ref_observed_old",
  "ref_observed_candidate",
  "conflicted",
  "finalized",
] as const);
export const PROMOTION_TERMINAL_STATES = deepFreeze(["conflicted", "finalized"] as const);
export const PROMOTION_TRANSITIONS = deepFreeze([
  ["intent_recorded", "ref_observed_old"],
  ["intent_recorded", "ref_observed_candidate"],
  ["intent_recorded", "conflicted"],
  ["ref_observed_old", "ref_observed_candidate"],
  ["ref_observed_old", "conflicted"],
  ["ref_observed_candidate", "finalized"],
  ["ref_observed_candidate", "conflicted"],
] as const);

export const DELIVERY_STATES = deepFreeze([
  "intent_recorded",
  "remote_observed",
  "pr_observed",
  "delivered",
  "delivery_failed",
] as const);
export const DELIVERY_TERMINAL_STATES = deepFreeze(["delivered", "delivery_failed"] as const);
export const DELIVERY_TRANSITIONS = deepFreeze([
  ["intent_recorded", "remote_observed"],
  ["remote_observed", "pr_observed"],
  ["pr_observed", "delivered"],
  ["intent_recorded", "delivery_failed"],
  ["remote_observed", "delivery_failed"],
  ["pr_observed", "delivery_failed"],
] as const);

export const GATE_STATUSES = deepFreeze([
  "passed",
  "failed",
  "missing",
  "null",
  "skipped",
  "unavailable",
  "infrastructure_error",
  "stale",
  "conflicting",
] as const);
export const REQUIRED_GATE_GREEN_STATUSES = deepFreeze(["passed"] as const);
export const REQUIRED_GATE_BLOCKING_STATUSES = deepFreeze([
  "failed",
  "missing",
  "null",
  "skipped",
  "unavailable",
  "infrastructure_error",
  "stale",
  "conflicting",
] as const);

export const RESOURCE_KINDS = deepFreeze([
  "delivery_ref",
  "attempt_ref",
  "worktree",
  "isolated_index",
  "policy_context",
  "policy_bundle",
  "process_group",
  "stdout",
  "stderr",
  "verification_output",
  "salvage_archive",
] as const);

export const ORACLE_REFERENCE_KINDS = deepFreeze([
  "run_manifest",
  "ticket_contract",
  "execution_context",
  "evidence",
  "gate_result",
  "review_record",
  "commit_attribution",
  "cleanup_record",
  "dependency_edge",
  "attempt_resource_snapshot",
  "lease_snapshot",
  "process_receipt",
] as const);

export const FORBIDDEN_TERMINAL_WRITERS = deepFreeze([
  "worker",
  "phase_runner",
  "dispatcher",
  "cli",
  "status",
  "metrics",
  "reconcile",
  "generic_state_repository",
] as const);

export const LEGACY_ARTIFACT_KINDS = deepFreeze([
  "registry.json",
  "dispatch-ledger.jsonl",
  "runs.jsonl",
  "interventions.jsonl",
  "salvage-dispositions.jsonl",
  "prs.jsonl",
  "defects.jsonl",
  "locks/*.lock",
  "legacy attempt receipts",
  "salvage archives",
  "ticket: <id> Git subjects",
] as const);

export const CAPABILITY_RESERVATIONS = deepFreeze([
  { name: "durable_sqlite_state", status: "reserved_contract_only", enabled: false, implementation_ticket: "t13" },
  { name: "run_attempt_allocation", status: "reserved_contract_only", enabled: false, implementation_ticket: "t14" },
  { name: "oracle_and_promotion", status: "reserved_contract_only", enabled: false, implementation_ticket: "t15" },
  { name: "caller_cutover_and_internal_selectors", status: "reserved_contract_only", enabled: false, implementation_ticket: "t16" },
  { name: "public_resume_retry_and_reconciliation", status: "reserved_contract_only", enabled: false, implementation_ticket: "t29" },
  { name: "attempt_resources", status: "internal_primitive_implemented", enabled: false, implementation_ticket: "t18_internal_t22_cutover" },
  { name: "automatic_delivery", status: "reserved_contract_only", enabled: false, implementation_ticket: "post_milestone_3" },
] as const);

export const STABLE_STATE_ERRORS = deepFreeze([
  { code: "RICKGENT_STATE_RUNTIME_UNSUPPORTED", class: "infrastructure", condition: "Node runtime is older than 24.12.0 and cannot enforce the frozen DatabaseSync defensive and named-parameter options" },
  { code: "RICKGENT_STATE_ROOT_UNSAFE", class: "infrastructure", condition: "unsafe, symlinked, wrong-owner, wrong-mode, or wrong-type state root" },
  { code: "RICKGENT_STATE_BUSY", class: "infrastructure", condition: "bounded SQLite busy or locked result" },
  { code: "RICKGENT_STATE_CORRUPT", class: "infrastructure", condition: "not-a-database, integrity or foreign-key failure, migration gap, checksum drift, or user_version disagreement" },
  { code: "RICKGENT_STATE_SCHEMA_FUTURE", class: "infrastructure", condition: "database schema newer than the binary supports" },
  { code: "RICKGENT_STATE_MIGRATION_FAILED", class: "infrastructure", condition: "atomic migration rolled back and old schema remains intact" },
  { code: "RICKGENT_STATE_IDEMPOTENCY_CONFLICT", class: "input_contract", condition: "same idempotency key with different input digest" },
  { code: "RICKGENT_STATE_CONFLICT", class: "infrastructure", condition: "compare-and-set changed zero rows" },
  { code: "RICKGENT_STATE_TRANSITION_ILLEGAL", class: "input_contract", condition: "requested lifecycle edge is not declared or its guard fails" },
  { code: "RICKGENT_STATE_OWNER_MISMATCH", class: "infrastructure", condition: "service, owner token digest, lease generation, context, or resource version mismatch" },
  { code: "RICKGENT_STATE_RESUME_INCOMPATIBLE", class: "input_contract", condition: "explicit run is incompatible with repository, contract, context, oracle, capability, or resource identity" },
  { code: "RICKGENT_LEGACY_STATE_QUARANTINED", class: "infrastructure", condition: "legacy lifecycle state blocks mutation open pending explicit quarantine" },
  { code: "RICKGENT_PROMOTION_CONFLICT", class: "infrastructure", condition: "delivery ref independently observed at a third OID" },
] as const);

export const STATE_ERROR_CODES = deepFreeze(STABLE_STATE_ERRORS.map((entry) => entry.code));

export type StateTable = (typeof STATE_TABLES)[number];
export type StateTransactionName = (typeof STATE_TRANSACTION_NAMES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type TicketState = (typeof TICKET_STATES)[number];
export type RunState = (typeof RUN_STATES)[number];
export type LeaseState = (typeof LEASE_STATES)[number];
export type ResourceState = (typeof RESOURCE_STATES)[number];
export type PromotionState = (typeof PROMOTION_STATES)[number];
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type GateStatus = (typeof GATE_STATUSES)[number];
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type OracleReferenceKind = (typeof ORACLE_REFERENCE_KINDS)[number];
export type StateErrorCode = (typeof STABLE_STATE_ERRORS)[number]["code"];
