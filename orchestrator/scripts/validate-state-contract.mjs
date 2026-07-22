#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class StateContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new StateContractError(code, message);
}

function object(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  return value;
}

function array(value, code, label) {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  return value;
}

function equal(actual, expected, code, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(code, `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function exactKeys(value, expected, code, label) {
  const actual = Object.keys(object(value, code, label)).sort();
  equal(actual, [...expected].sort(), code, `${label} keys`);
}

function unique(values, code, label) {
  if (new Set(values).size !== values.length) fail(code, `${label} contains duplicates`);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("STATE_CONTRACT_JSON_INVALID", "contract numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("STATE_CONTRACT_JSON_INVALID", `unsupported JSON value ${typeof value}`);
}

function contractDigest(contract) {
  const unsigned = { ...contract };
  delete unsigned.decision_digest;
  return `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
}

const TABLES = [
  "schema_migrations", "repositories", "run_manifests", "runs", "ticket_contracts",
  "run_tickets", "run_ticket_dependencies", "attempts", "execution_contexts",
  "phase_executions", "evidence", "state_transitions", "transition_evidence_refs",
  "leases", "attempt_resources", "process_receipts", "gate_results", "review_records",
  "remediation_records", "commit_attributions", "salvage_records", "cleanup_records",
  "oracle_decisions", "oracle_input_references", "promotion_intents", "delivery_intents",
  "remote_observations", "pr_observations", "delivery_records", "legacy_artifacts",
];

const CAS_TABLES = new Set([
  "runs", "run_tickets", "attempts", "leases", "attempt_resources", "promotion_intents",
]);

const TRANSACTIONS = [
  "open_and_migrate", "allocate_run", "allocate_attempt", "append_evidence",
  "transition_entity_cas", "acquire_lease", "heartbeat_lease",
  "process_supervisor_launch", "process_supervisor_terminal",
  "commit_attribution_prepare", "commit_attribution_finalize", "begin_lease_cleanup",
  "release_lease", "reserve_resource", "advance_resource", "quarantine_resource",
  "release_resource", "persist_oracle_decision", "create_promotion_intent",
  "observe_promotion", "finalize_promotion", "create_delivery_intent",
  "append_remote_observation", "append_pr_observation", "finalize_delivery",
  "inventory_legacy",
  "seal_target_proof_set", "create_target_start_gate", "mint_cleanup_eligibility",
  "mint_failure_cleanup", "mint_promotion_cleanup", "mint_quarantine",
  "mint_target_never_released", "mint_target_released",
  "persist_authority_claim_snapshot", "persist_authority_ownership_snapshot",
  "recover_orphaned_planned_attempt",
];

const ATTEMPT_STATES = [
  "planned", "implementing", "implementation_captured", "reviewing", "remediating",
  "remediation_captured", "verification_queued", "verifying", "converging",
  "cleanup_pending", "oracle_evaluation", "failed_clean", "quarantined", "verified",
];
const TICKET_STATES = ["planned", "active", "cleanup_pending", "failed", "quarantined", "ready_for_delivery"];
const RUN_STATES = ["planned", "active", "cleanup_pending", "failed", "delivery_failed", "ready_for_delivery", "delivered"];
const LEASE_STATES = ["reserved", "live", "cleanup_pending", "released", "quarantined"];
const RESOURCE_STATES = ["reserved", "allocated", "active", "cleanup_pending", "released", "quarantined"];
const PROMOTION_STATES = ["intent_recorded", "ref_observed_old", "ref_observed_candidate", "conflicted", "finalized"];
const DELIVERY_STATES = ["intent_recorded", "remote_observed", "pr_observed", "delivered", "delivery_failed"];
const GATE_STATUSES = ["passed", "failed", "missing", "null", "skipped", "unavailable", "infrastructure_error", "stale", "conflicting"];
const RESOURCE_KINDS = ["delivery_ref", "attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle", "process_group", "stdout", "stderr", "verification_output", "salvage_archive"];
const ORACLE_REFERENCE_KINDS = ["run_manifest", "ticket_contract", "execution_context", "evidence", "gate_result", "review_record", "commit_attribution", "cleanup_record", "dependency_edge", "attempt_resource_snapshot", "lease_snapshot", "process_receipt"];
const FORBIDDEN_TERMINAL_WRITERS = ["worker", "phase_runner", "dispatcher", "cli", "status", "metrics", "reconcile", "generic_state_repository"];
const ERROR_CODES = [
  "RICKGENT_STATE_RUNTIME_UNSUPPORTED",
  "RICKGENT_STATE_ROOT_UNSAFE", "RICKGENT_STATE_BUSY", "RICKGENT_STATE_CORRUPT",
  "RICKGENT_STATE_SCHEMA_FUTURE", "RICKGENT_STATE_MIGRATION_FAILED",
  "RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "RICKGENT_STATE_CONFLICT",
  "RICKGENT_STATE_TRANSITION_ILLEGAL", "RICKGENT_STATE_OWNER_MISMATCH",
  "RICKGENT_STATE_RESUME_INCOMPATIBLE", "RICKGENT_LEGACY_STATE_QUARANTINED",
  "RICKGENT_PROMOTION_CONFLICT", "RICKGENT_CONTAINMENT_UNAVAILABLE",
];

const SCALAR_FORMATS = {
  canonical_id: "nonempty canonical UTF-8 text",
  nonnegative_integer: "SQLite INTEGER >= 0",
  positive_integer: "SQLite INTEGER > 0",
  utc_timestamp: "RFC3339 UTC text with Z suffix",
  canonical_json_object: "canonical UTF-8 JSON text with json_valid and json_type object",
  canonical_json_array: "canonical UTF-8 JSON text with json_valid and json_type array",
  sha256_digest: "sha256 followed by colon and 64 lowercase hexadecimal characters",
  git_oid: "lowercase hexadecimal text of length 40 for sha1 or 64 for sha256, matched to repository object_format",
  ref_name: "canonical full Git ref accepted by git check-ref-format",
};

const COLUMN_TYPES = new Set([
  ...Object.keys(SCALAR_FORMATS), "attempt_state", "boolean_integer", "gate_status",
  "delivery_state", "lease_state", "oracle_reference_kind", "promotion_state", "resource_kind",
  "resource_state", "run_state", "ticket_state",
]);

function validateMetadata(contract) {
  exactKeys(contract, [
    "schema_version", "contract_id", "decision_status", "decision_digest",
    "parent_authority", "activation_boundary", "state_root", "sqlite", "scalar_formats",
    "migrations", "entity_model", "transactions", "state_machines",
    "allocation_and_recovery", "resource_identity", "oracle", "promotion", "delivery",
    "legacy", "capability_reservations", "stable_errors",
  ], "STATE_CONTRACT_UNKNOWN_FIELD", "contract");
  equal(contract.schema_version, "1.0.0", "STATE_CONTRACT_VERSION_UNSUPPORTED", "schema_version");
  equal(contract.contract_id, "rickgent-state-and-lifecycle-v1", "STATE_CONTRACT_ID_INVALID", "contract_id");
  equal(contract.decision_status, "frozen_decision_only", "STATE_CONTRACT_ACTIVATION_INVALID", "decision_status");
  equal(contract.parent_authority, {
    contract_id: "rickgent-trust-spine-v1",
    path: "docs/architecture/reliability/trust-spine-contract.json",
  }, "STATE_CONTRACT_PARENT_INVALID", "parent_authority");
  equal(contract.decision_digest, contractDigest(contract), "STATE_CONTRACT_DIGEST_MISMATCH", "decision_digest");

  const activation = object(contract.activation_boundary, "STATE_CONTRACT_ACTIVATION_INVALID", "activation_boundary");
  exactKeys(activation, [
    "decision_artifacts_enable_capabilities", "implementation_status",
    "adoption_requires_tickets", "production_ownership_activation_requires_tickets", "forbidden_in_this_ticket",
  ], "STATE_CONTRACT_ACTIVATION_INVALID", "activation_boundary");
  equal(activation.decision_artifacts_enable_capabilities, false, "STATE_CONTRACT_ACTIVATION_INVALID", "decision artifacts capability boundary");
  equal(activation.implementation_status, "partial_internal_primitives", "STATE_CONTRACT_ACTIVATION_INVALID", "implementation status");
  equal(activation.adoption_requires_tickets, ["t13", "t14", "t15", "t16", "t17", "t18", "t19"], "STATE_CONTRACT_ACTIVATION_INVALID", "adoption tickets");
  equal(activation.production_ownership_activation_requires_tickets, ["t20", "t21", "t22", "t23", "t29"], "STATE_CONTRACT_ACTIVATION_INVALID", "production ownership activation tickets");
  if (array(activation.forbidden_in_this_ticket, "STATE_CONTRACT_ACTIVATION_INVALID", "forbidden_in_this_ticket").length !== 6) {
    fail("STATE_CONTRACT_ACTIVATION_INVALID", "ticket boundary is incomplete");
  }
}

function validateStateRoot(contract) {
  const root = object(contract.state_root, "STATE_CONTRACT_ROOT_INVALID", "state_root");
  exactKeys(root, [
    "repository_selector", "selection_rule", "caller_cwd_authoritative",
    "environment_override_allowed", "forbidden_authorities", "resolution_steps",
    "git_top_level_command", "git_common_dir_command", "object_format_command", "allowed_object_formats",
    "repository_identity_tuple", "repository_identity_digest", "state_directory",
    "database_path", "resource_directory", "directory_mode", "database_mode",
    "sidecar_mode", "symlink_allowed", "unsafe_existing_paths_are_repaired",
    "required_owner", "git_admin_group_or_other_writable_allowed",
    "production_dependency_injection", "test_dependency_injection", "unsafe_result",
  ], "STATE_CONTRACT_ROOT_INVALID", "state_root");
  equal(root.repository_selector, "--repo", "STATE_CONTRACT_ROOT_INVALID", "repository selector");
  equal(root.caller_cwd_authoritative, false, "STATE_CONTRACT_ROOT_INVALID", "CWD authority");
  equal(root.environment_override_allowed, false, "STATE_CONTRACT_ROOT_INVALID", "environment override");
  equal(root.forbidden_authorities, ["caller_cwd", "RICKGENT_DIR", "prd_path", "ticket_id", "registry", "ledger"], "STATE_CONTRACT_ROOT_INVALID", "forbidden root authorities");
  equal(root.git_top_level_command, ["git", "-C", "<selected-repo-realpath>", "rev-parse", "--path-format=absolute", "--show-toplevel"], "STATE_CONTRACT_ROOT_INVALID", "Git top-level command");
  equal(root.git_common_dir_command, ["git", "-C", "<repo-realpath>", "rev-parse", "--path-format=absolute", "--git-common-dir"], "STATE_CONTRACT_ROOT_INVALID", "Git common directory command");
  equal(root.object_format_command, ["git", "-C", "<repo-realpath>", "rev-parse", "--show-object-format"], "STATE_CONTRACT_ROOT_INVALID", "Git object format command");
  equal(root.allowed_object_formats, ["sha1", "sha256"], "STATE_CONTRACT_ROOT_INVALID", "object formats");
  equal(root.repository_identity_tuple, ["repo_realpath", "git_common_dir_realpath", "object_format"], "STATE_CONTRACT_ROOT_INVALID", "repository identity tuple");
  equal(root.state_directory, "<git-common-dir-realpath>/rickgent", "STATE_CONTRACT_ROOT_INVALID", "state directory");
  equal(root.database_path, "<git-common-dir-realpath>/rickgent/state.sqlite3", "STATE_CONTRACT_ROOT_INVALID", "database path");
  equal(root.directory_mode, "0700", "STATE_CONTRACT_ROOT_INVALID", "directory mode");
  equal(root.database_mode, "0600", "STATE_CONTRACT_ROOT_INVALID", "database mode");
  equal(root.sidecar_mode, "0600", "STATE_CONTRACT_ROOT_INVALID", "sidecar mode");
  equal(root.required_owner, "effective process owner for the selected repository, Git common directory, state directory, database, and sidecars; canonical ancestor directories may have a different owner", "STATE_CONTRACT_ROOT_INVALID", "owner-check scope");
  for (const [field, expected] of [["symlink_allowed", false], ["unsafe_existing_paths_are_repaired", false], ["git_admin_group_or_other_writable_allowed", false], ["production_dependency_injection", false]]) {
    equal(root[field], expected, "STATE_CONTRACT_ROOT_INVALID", field);
  }
  equal(root.unsafe_result, "RICKGENT_STATE_ROOT_UNSAFE", "STATE_CONTRACT_ROOT_INVALID", "unsafe result");
  const steps = array(root.resolution_steps, "STATE_CONTRACT_ROOT_INVALID", "resolution_steps").join(" ");
  for (const term of ["lstat", "symbolic link", "realpath", "owner mismatch", "derive repository identity"]) {
    if (!steps.includes(term)) fail("STATE_CONTRACT_ROOT_INVALID", `resolution steps omit ${term}`);
  }
}

function validateSqlite(contract) {
  const sqlite = object(contract.sqlite, "STATE_CONTRACT_SQLITE_INVALID", "sqlite");
  exactKeys(sqlite, [
    "implementation_profile", "minimum_node_version", "unsupported_runtime_result",
    "connection_options", "node_database_sync_option_mapping", "pragmas",
    "writer_begin", "migration_begin", "integrity_checks_before_use", "busy_policy",
    "durability", "error_preservation",
  ], "STATE_CONTRACT_SQLITE_INVALID", "sqlite");
  equal(sqlite.minimum_node_version, "24.12.0", "STATE_CONTRACT_SQLITE_INVALID", "minimum Node version");
  equal(sqlite.unsupported_runtime_result, "RICKGENT_STATE_RUNTIME_UNSUPPORTED", "STATE_CONTRACT_SQLITE_INVALID", "unsupported runtime result");
  exactKeys(sqlite.connection_options, [
    "foreign_keys", "defensive", "allow_extension_loading",
    "allow_double_quoted_string_literals", "allow_unknown_named_parameters",
  ], "STATE_CONTRACT_SQLITE_INVALID", "sqlite.connection_options");
  equal(sqlite.connection_options, {
    foreign_keys: true,
    defensive: true,
    allow_extension_loading: false,
    allow_double_quoted_string_literals: false,
    allow_unknown_named_parameters: false,
  }, "STATE_CONTRACT_SQLITE_INVALID", "connection options");
  equal(sqlite.node_database_sync_option_mapping, {
    foreign_keys: "enableForeignKeyConstraints",
    defensive: "defensive",
    allow_extension_loading: "allowExtension",
    allow_double_quoted_string_literals: "enableDoubleQuotedStringLiterals",
    allow_unknown_named_parameters: "allowUnknownNamedParameters",
  }, "STATE_CONTRACT_SQLITE_INVALID", "DatabaseSync option mapping");
  equal(sqlite.pragmas, [
    { name: "foreign_keys", value: "ON" },
    { name: "journal_mode", value: "WAL" },
    { name: "synchronous", value: "FULL" },
    { name: "busy_timeout", value: 5000 },
    { name: "wal_autocheckpoint", value: 1000 },
    { name: "trusted_schema", value: "OFF" },
    { name: "recursive_triggers", value: "ON" },
  ], "STATE_CONTRACT_SQLITE_INVALID", "SQLite pragmas");
  equal(sqlite.writer_begin, "BEGIN IMMEDIATE", "STATE_CONTRACT_SQLITE_INVALID", "writer transaction");
  equal(sqlite.migration_begin, "exclusive migration critical section", "STATE_CONTRACT_SQLITE_INVALID", "migration transaction");
  equal(sqlite.integrity_checks_before_use, ["PRAGMA quick_check", "PRAGMA foreign_key_check", "migration contiguity and checksum", "PRAGMA user_version supported and equal to migration rows"], "STATE_CONTRACT_SQLITE_INVALID", "integrity checks");
  equal(sqlite.busy_policy, {
    bounded: true,
    timeout_ms: 5000,
    sqlite_busy_or_locked_result: "RICKGENT_STATE_BUSY",
    unbounded_retry_allowed: false,
    retry_unit: "complete named transaction",
  }, "STATE_CONTRACT_SQLITE_INVALID", "busy policy");
  exactKeys(sqlite.busy_policy, [
    "bounded", "timeout_ms", "sqlite_busy_or_locked_result",
    "unbounded_retry_allowed", "retry_unit",
  ], "STATE_CONTRACT_SQLITE_INVALID", "sqlite.busy_policy");
  equal(sqlite.durability, {
    journal: "WAL",
    synchronous: "FULL",
    state_change_atomicity: "old-or-new committed state only",
    foreign_key_enforcement: "required and verified on every connection",
  }, "STATE_CONTRACT_SQLITE_INVALID", "durability");
  exactKeys(sqlite.durability, [
    "journal", "synchronous", "state_change_atomicity", "foreign_key_enforcement",
  ], "STATE_CONTRACT_SQLITE_INVALID", "sqlite.durability");
  if (!String(sqlite.error_preservation).includes("never delete")) fail("STATE_CONTRACT_SQLITE_INVALID", "fail-closed preservation is missing");
}

function validateScalarFormats(contract) {
  exactKeys(contract.scalar_formats, Object.keys(SCALAR_FORMATS), "STATE_CONTRACT_SCALAR_INVALID", "scalar_formats");
  equal(contract.scalar_formats, SCALAR_FORMATS, "STATE_CONTRACT_SCALAR_INVALID", "scalar_formats");
}

function validateMigrations(contract) {
  const migrations = object(contract.migrations, "STATE_CONTRACT_MIGRATION_INVALID", "migrations");
  exactKeys(migrations, [
    "numbering", "released_migrations_are_immutable", "user_version_must_equal_latest_row",
    "creation_and_each_migration_atomic", "checksum_policy", "future_policy", "initial",
  ], "STATE_CONTRACT_MIGRATION_INVALID", "migrations");
  equal(migrations.numbering, "positive contiguous integers rendered as three digits", "STATE_CONTRACT_MIGRATION_INVALID", "migration numbering");
  equal(migrations.released_migrations_are_immutable, true, "STATE_CONTRACT_MIGRATION_INVALID", "migration immutability");
  equal(migrations.user_version_must_equal_latest_row, true, "STATE_CONTRACT_MIGRATION_INVALID", "user_version parity");
  equal(migrations.creation_and_each_migration_atomic, true, "STATE_CONTRACT_MIGRATION_INVALID", "migration atomicity");
  equal(migrations.checksum_policy, "sha256 of the exact released executable migration definition", "STATE_CONTRACT_MIGRATION_INVALID", "checksum policy");
  equal(migrations.initial, [{
    version: 1,
    number: "001",
    name: "001_initial_durable_state",
    sql_owner_ticket: "t13",
    released_checksum: "sha256:473f6581359fb59da29236aeb77acaba74aa46504fb0ac8c0089c59afca586a8",
    sqlite_schema_checksum: "sha256:11f061a28bffe7ed02a6d5b974cca09dcff189e18fb18834659a3aad175ecef9",
    status: "implemented",
  }, {
    version: 2,
    number: "002",
    name: "002_attempt_ownership_primitive",
    sql_owner_ticket: "t18",
    released_checksum: "sha256:8dc1be6f92fbe281149b651c89fd1b2e8d7b4f3464c2f85a2113aa851123473d",
    sqlite_schema_checksum: "sha256:eb83ea80db2cc06eb46ffe135994fe79cf4f53146b5f71ac8a876b46f6224bbc",
    status: "implemented",
  }, {
    version: 3,
    number: "003",
    name: "003_durable_process_supervision",
    sql_owner_ticket: "t19",
    released_checksum: "sha256:c94e5b62aa8dae64740685c13159f2d19610909729c789e6638deb59855ff8ce",
    sqlite_schema_checksum: "sha256:c208339c0350aae8bd1ee3784da4e4ffc559b41e9c6079530a89da53c08753e3",
    status: "implemented",
  }, {
    version: 4,
    number: "004",
    name: "004_durable_commit_attribution",
    sql_owner_ticket: "t20",
    released_checksum: "sha256:66f819b89e1781ca7fdc7311e269a4991a86706224eaa269b0198ad434ce6469",
    sqlite_schema_checksum: "sha256:af782456d3402bd47cff0ca9fd4e358c52028c14fee3470efcc295cac926542d",
    status: "implemented",
  }, {
    version: 5,
    number: "005",
    name: "005_attempt_cleanup_proof_model",
    sql_owner_ticket: "t22",
    released_checksum: "sha256:e9c6896dd23d8d07127fa8ddb05483ad00ff9a59b2042dc32ce75428371ac6f1",
    sqlite_schema_checksum: "sha256:c91fd35e83d879890dd13ef8f8bb18fa6f8b116e8b85545e4c3e8c65785681c6",
    status: "implemented",
  }, {
    version: 6,
    number: "006",
    name: "006_attempt_legal_edge_failure_edges",
    sql_owner_ticket: "t24",
    released_checksum: "sha256:b513d8e031d557dec10109c443bb1676ddd31ff421a0c60e36bde0e092e9421e",
    sqlite_schema_checksum: "sha256:ce0b23b40baec3cf11b66ef9d0e9f998adfb048cbbba8f3eb82abfb3d924b7d8",
    status: "implemented",
  }], "STATE_CONTRACT_MIGRATION_INVALID", "initial migrations");
  for (let index = 0; index < migrations.initial.length; index += 1) {
    if (migrations.initial[index].version !== index + 1) fail("STATE_CONTRACT_MIGRATION_INVALID", "migration versions are not contiguous");
  }
}

function validateTables(contract) {
  const model = object(contract.entity_model, "STATE_CONTRACT_TABLE_INVALID", "entity_model");
  exactKeys(model, [
    "all_tables_strict", "foreign_keys_explicit_delete_action", "evidence_delete_action",
    "generic_update_api_allowed", "catalog",
  ], "STATE_CONTRACT_TABLE_INVALID", "entity_model");
  equal(model.all_tables_strict, true, "STATE_CONTRACT_TABLE_INVALID", "STRICT tables");
  equal(model.foreign_keys_explicit_delete_action, true, "STATE_CONTRACT_TABLE_INVALID", "foreign key delete actions");
  equal(model.evidence_delete_action, "RESTRICT", "STATE_CONTRACT_TABLE_INVALID", "evidence delete action");
  equal(model.generic_update_api_allowed, false, "STATE_CONTRACT_TABLE_INVALID", "generic update API");
  const catalog = array(model.catalog, "STATE_CONTRACT_TABLE_INVALID", "entity_model.catalog");
  const names = catalog.map((table) => table.name);
  equal(names, TABLES, "STATE_CONTRACT_TABLE_INVALID", "table inventory");
  unique(names, "STATE_CONTRACT_TABLE_INVALID", "table inventory");

  for (const tableValue of catalog) {
    const table = object(tableValue, "STATE_CONTRACT_TABLE_INVALID", "table");
    exactKeys(table, ["name", "status", "strict", "columns", "primary_key", "foreign_keys", "unique_constraints", "checks", "mutation"], "STATE_CONTRACT_TABLE_INVALID", `table ${table.name}`);
    equal(table.status, "reserved_contract_only", "STATE_CONTRACT_TABLE_INVALID", `${table.name}.status`);
    equal(table.strict, true, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.strict`);
    const columns = Object.keys(object(table.columns, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.columns`));
    if (columns.length === 0) fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has no columns`);
    for (const [column, declaredType] of Object.entries(table.columns)) {
      if (typeof declaredType !== "string" || !COLUMN_TYPES.has(declaredType.replace(/\?$/, ""))) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name}.${column} has unsupported type ${declaredType}`);
      }
    }
    const primaryKey = array(table.primary_key, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.primary_key`);
    if (primaryKey.length === 0 || primaryKey.some((column) => !columns.includes(column))) {
      fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has an invalid primary key`);
    }
    for (const foreignKey of array(table.foreign_keys, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.foreign_keys`)) {
      exactKeys(foreignKey, ["columns", "references", "on_delete"], "STATE_CONTRACT_TABLE_INVALID", `${table.name} foreign key`);
      if (foreignKey.columns.length === 0 || foreignKey.columns.some((column) => !columns.includes(column))) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has an invalid foreign key column`);
      }
      equal(foreignKey.on_delete, "RESTRICT", "STATE_CONTRACT_TABLE_INVALID", `${table.name} foreign key delete action`);
      const target = String(foreignKey.references).split("(")[0];
      if (!TABLES.includes(target)) fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} references unknown table ${target}`);
    }
    for (const constraint of array(table.unique_constraints, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.unique_constraints`)) {
      const allowedKeys = constraint.where === undefined ? ["name", "columns"] : ["name", "columns", "where"];
      exactKeys(constraint, allowedKeys, "STATE_CONTRACT_TABLE_INVALID", `${table.name} unique constraint`);
      if (!constraint.name || constraint.columns.length === 0 || constraint.columns.some((column) => !columns.includes(column))) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has an invalid unique constraint`);
      }
    }
    const checks = array(table.checks, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.checks`);
    if (checks.length === 0 || checks.some((check) => typeof check !== "string" || check.trim().length === 0)) {
      fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has no checks`);
    }
    const mutation = object(table.mutation, "STATE_CONTRACT_TABLE_INVALID", `${table.name}.mutation`);
    exactKeys(mutation, ["mode", "update_trigger", "delete_trigger", "immutable_columns", "cas_columns", "cas_predicate"], "STATE_CONTRACT_TABLE_INVALID", `${table.name}.mutation`);
    equal(mutation.delete_trigger, `${table.name}_no_delete`, "STATE_CONTRACT_TABLE_INVALID", `${table.name} delete trigger`);
    unique(mutation.immutable_columns, "STATE_CONTRACT_TABLE_INVALID", `${table.name} immutable columns`);
    unique(mutation.cas_columns, "STATE_CONTRACT_TABLE_INVALID", `${table.name} CAS columns`);
    const covered = [...mutation.immutable_columns, ...mutation.cas_columns];
    unique(covered, "STATE_CONTRACT_TABLE_INVALID", `${table.name} mutation columns`);
    equal([...covered].sort(), [...columns].sort(), "STATE_CONTRACT_TABLE_INVALID", `${table.name} mutation column coverage`);
    if (CAS_TABLES.has(table.name)) {
      if (!new Set(["cas_snapshot", "cas_intent"]).has(mutation.mode)) fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} is not CAS-managed`);
      if (!mutation.update_trigger?.includes("immutable_identity") || !mutation.cas_columns.includes("state") || !mutation.cas_columns.includes("state_version")) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} lacks immutable identity or state/version CAS columns`);
      }
      if (!String(mutation.cas_predicate).includes("state = ?") || !String(mutation.cas_predicate).includes("state_version = ?")) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} lacks old-state/version compare-and-set predicate`);
      }
    } else {
      equal(mutation.mode, "append_only", "STATE_CONTRACT_TABLE_INVALID", `${table.name} append-only mode`);
      equal(mutation.update_trigger, `${table.name}_no_update`, "STATE_CONTRACT_TABLE_INVALID", `${table.name} update trigger`);
      equal(mutation.cas_columns, [], "STATE_CONTRACT_TABLE_INVALID", `${table.name} CAS columns`);
      equal(mutation.cas_predicate, null, "STATE_CONTRACT_TABLE_INVALID", `${table.name} CAS predicate`);
    }
  }

  const byName = new Map(catalog.map((table) => [table.name, table]));
  for (const table of catalog) {
    for (const foreignKey of table.foreign_keys) {
      const match = /^([a-z_]+)\(([a-z_,]+)\)$/.exec(foreignKey.references);
      if (!match) fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has malformed reference ${foreignKey.references}`);
      const target = byName.get(match[1]);
      const targetColumns = match[2].split(",");
      if (foreignKey.columns.length !== targetColumns.length || targetColumns.some((column) => !(column in target.columns))) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} has invalid target columns in ${foreignKey.references}`);
      }
      for (let index = 0; index < foreignKey.columns.length; index += 1) {
        const sourceType = table.columns[foreignKey.columns[index]].replace(/\?$/, "");
        const targetType = target.columns[targetColumns[index]].replace(/\?$/, "");
        if (sourceType !== targetType) {
          fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} foreign key ${foreignKey.references} has incompatible column types`);
        }
      }
      const candidateKeys = [
        target.primary_key,
        ...target.unique_constraints.filter((constraint) => constraint.where === undefined).map((constraint) => constraint.columns),
      ];
      if (!candidateKeys.some((columns) => JSON.stringify(columns) === JSON.stringify(targetColumns))) {
        fail("STATE_CONTRACT_TABLE_INVALID", `${table.name} foreign key target ${foreignKey.references} is not primary or unique`);
      }
    }
  }

  const requiredLineageUniqueConstraints = [
    ["run_tickets", "run_tickets_full_scope_uq", ["ticket_instance_id", "run_id", "ticket_id", "contract_digest"]],
    ["attempts", "attempts_identity_contract_uq", ["attempt_id", "contract_digest"]],
    ["phase_executions", "phase_executions_identity_attempt_uq", ["phase_execution_id", "attempt_id"]],
    ["phase_executions", "phase_executions_identity_context_uq", ["phase_execution_id", "context_id"]],
    ["leases", "leases_identity_attempt_uq", ["lease_id", "attempt_id"]],
    ["leases", "leases_identity_generation_uq", ["lease_id", "generation"]],
  ];
  for (const [tableName, name, columns] of requiredLineageUniqueConstraints) {
    const table = byName.get(tableName);
    if (!table.unique_constraints.some((entry) => entry.name === name
      && JSON.stringify(entry.columns) === JSON.stringify(columns) && entry.where === undefined)) {
      fail("STATE_CONTRACT_TABLE_INVALID", `${tableName} lacks lineage key ${name}`);
    }
  }

  const requiredLineageForeignKeys = [
    ["attempts", ["ticket_instance_id", "run_id", "ticket_id", "contract_digest"], "run_tickets(ticket_instance_id,run_id,ticket_id,contract_digest)"],
    ["execution_contexts", ["attempt_id", "contract_digest"], "attempts(attempt_id,contract_digest)"],
    ["phase_executions", ["context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["evidence", ["phase_execution_id", "attempt_id"], "phase_executions(phase_execution_id,attempt_id)"],
    ["evidence", ["context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["evidence", ["phase_execution_id", "context_id"], "phase_executions(phase_execution_id,context_id)"],
    ["leases", ["owner_context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["leases", ["acquisition_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["leases", ["release_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["attempt_resources", ["allocation_lease_id", "attempt_id"], "leases(lease_id,attempt_id)"],
    ["attempt_resources", ["allocation_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["attempt_resources", ["owner_context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["attempt_resources", ["release_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["attempt_resources", ["quarantine_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["process_receipts", ["phase_execution_id", "context_id"], "phase_executions(phase_execution_id,context_id)"],
    ["process_receipts", ["lease_id", "lease_generation"], "leases(lease_id,generation)"],
    ["gate_results", ["context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["gate_results", ["attempt_id", "contract_digest"], "attempts(attempt_id,contract_digest)"],
    ["gate_results", ["evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["review_records", ["reviewer_context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["review_records", ["verdict_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["review_records", ["findings_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["remediation_records", ["context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["remediation_records", ["findings_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["remediation_records", ["output_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["commit_attributions", ["attempt_id", "contract_digest"], "attempts(attempt_id,contract_digest)"],
    ["commit_attributions", ["attribution_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["salvage_records", ["evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    ["cleanup_records", ["context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    ["cleanup_records", ["evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
  ];
  for (const [tableName, columns, reference] of requiredLineageForeignKeys) {
    const table = byName.get(tableName);
    if (!table.foreign_keys.some((entry) => JSON.stringify(entry.columns) === JSON.stringify(columns)
      && entry.references === reference && entry.on_delete === "RESTRICT")) {
      fail("STATE_CONTRACT_TABLE_INVALID", `${tableName} lacks lineage foreign key ${reference}`);
    }
  }

  const leases = byName.get("leases");
  if (!leases.unique_constraints.some((entry) => entry.name === "leases_one_live_uq" && entry.where === "state IN ('live','cleanup_pending')")) {
    fail("STATE_CONTRACT_TABLE_INVALID", "leases lack one-live-generation partial uniqueness");
  }
  for (const field of ["owner_token_digest = ?", "generation = ?", "owner_context_id = ?", "state_version = ?"]) {
    if (!leases.mutation.cas_predicate.includes(field)) fail("STATE_CONTRACT_TABLE_INVALID", `lease owner CAS omits ${field}`);
  }
  if (!leases.checks.some((entry) => entry.includes("rickgent.lease-snapshot.v1") && entry.includes("atomically append"))) {
    fail("STATE_CONTRACT_TABLE_INVALID", "lease mutations do not atomically preserve immutable version snapshots");
  }
  const resources = byName.get("attempt_resources");
  if (!resources.unique_constraints.some((entry) => entry.name === "attempt_resources_active_identity_uq" && entry.where)) {
    fail("STATE_CONTRACT_TABLE_INVALID", "resources lack active identity uniqueness");
  }
  if (!resources.checks.some((entry) => entry.includes("rickgent.attempt-resource-snapshot.v1") && entry.includes("atomically append"))) {
    fail("STATE_CONTRACT_TABLE_INVALID", "resource mutations do not atomically preserve immutable version snapshots");
  }
  const promotions = byName.get("promotion_intents");
  if (!promotions.unique_constraints.some((entry) => entry.name === "promotion_intents_one_inflight_uq" && entry.where)) {
    fail("STATE_CONTRACT_TABLE_INVALID", "promotions lack one in-flight intent uniqueness");
  }
  const ticketInflight = promotions.unique_constraints.find((entry) => entry.name === "promotion_intents_ticket_inflight_uq");
  if (!ticketInflight
    || JSON.stringify(ticketInflight.columns) !== JSON.stringify(["ticket_instance_id"])
    || ticketInflight.where !== "state NOT IN ('finalized','conflicted')"
    || promotions.unique_constraints.some((entry) => JSON.stringify(entry.columns) === JSON.stringify(["ticket_instance_id"])
      && entry.where === undefined)) {
    fail("STATE_CONTRACT_TABLE_INVALID", "terminal promotion intents must not block a new attempt for the same ticket");
  }
  const oracleRefs = byName.get("oracle_input_references");
  if (!oracleRefs.checks.some((entry) => entry.includes("exactly one typed nullable reference")) || !oracleRefs.checks.some((entry) => entry.includes("one read transaction"))) {
    fail("STATE_CONTRACT_TABLE_INVALID", "oracle references lack discriminator or atomic resolution checks");
  }
  if (!oracleRefs.foreign_keys.some((entry) => entry.columns.length === 1
    && entry.columns[0] === "dependency_digest"
    && entry.references === "run_ticket_dependencies(dependency_digest)")) {
    fail("STATE_CONTRACT_TABLE_INVALID", "oracle dependency reference is not relationally pinned");
  }
  for (const forbidden of ["resource_id", "lease_id"]) {
    if (forbidden in oracleRefs.columns) fail("STATE_CONTRACT_TABLE_INVALID", `oracle directly references mutable ${forbidden}`);
  }
  for (const [column, reference] of [
    ["resource_snapshot_evidence_id", "evidence(evidence_id,attempt_id)"],
    ["lease_snapshot_evidence_id", "evidence(evidence_id,attempt_id)"],
  ]) {
    const hasIdentityForeignKey = oracleRefs.foreign_keys.some((entry) => entry.columns.length === 1
      && entry.columns[0] === column && entry.references === "evidence(evidence_id)");
    const hasAttemptForeignKey = oracleRefs.foreign_keys.some((entry) => JSON.stringify(entry.columns) === JSON.stringify([column, "attempt_id"])
      && entry.references === reference);
    if (!hasIdentityForeignKey || !hasAttemptForeignKey) {
      fail("STATE_CONTRACT_TABLE_INVALID", `oracle snapshot column ${column} is not pinned to immutable evidence`);
    }
  }
  for (const [columns, reference] of [
    [["oracle_decision_id", "run_id"], "oracle_decisions(oracle_decision_id,run_id)"],
    [["oracle_decision_id", "run_id", "ticket_instance_id"], "oracle_decisions(oracle_decision_id,run_id,ticket_instance_id)"],
    [["oracle_decision_id", "run_id", "ticket_instance_id", "attempt_id"], "oracle_decisions(oracle_decision_id,run_id,ticket_instance_id,attempt_id)"],
  ]) {
    if (!oracleRefs.foreign_keys.some((entry) => JSON.stringify(entry.columns) === JSON.stringify(columns)
      && entry.references === reference)) {
      fail("STATE_CONTRACT_TABLE_INVALID", `oracle references lack scope foreign key ${reference}`);
    }
  }

  const oracleDecisions = byName.get("oracle_decisions");
  for (const [name, columns, where] of [
    ["oracle_decisions_run_idempotency_uq", ["run_id", "idempotency_key"], "scope_kind = 'run'"],
    ["oracle_decisions_ticket_idempotency_uq", ["ticket_instance_id", "idempotency_key"], "scope_kind = 'ticket'"],
    ["oracle_decisions_attempt_idempotency_uq", ["attempt_id", "idempotency_key"], "scope_kind = 'attempt'"],
  ]) {
    if (!oracleDecisions.unique_constraints.some((entry) => entry.name === name
      && JSON.stringify(entry.columns) === JSON.stringify(columns) && entry.where === where)) {
      fail("STATE_CONTRACT_TABLE_INVALID", `oracle idempotency is not uniquely enforced for ${where}`);
    }
  }

  for (const [columns, reference] of [
    [["ticket_instance_id", "run_id"], "run_tickets(ticket_instance_id,run_id)"],
    [["attempt_id", "ticket_instance_id", "run_id"], "attempts(attempt_id,ticket_instance_id,run_id)"],
    [["oracle_decision_id", "run_id", "ticket_instance_id", "attempt_id"], "oracle_decisions(oracle_decision_id,run_id,ticket_instance_id,attempt_id)"],
    [["commit_attribution_id", "attempt_id"], "commit_attributions(commit_attribution_id,attempt_id)"],
    [["owner_context_id", "attempt_id"], "execution_contexts(context_id,attempt_id)"],
    [["observation_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
    [["finalization_evidence_id", "attempt_id"], "evidence(evidence_id,attempt_id)"],
  ]) {
    if (!promotions.foreign_keys.some((entry) => JSON.stringify(entry.columns) === JSON.stringify(columns)
      && entry.references === reference)) {
      fail("STATE_CONTRACT_TABLE_INVALID", `promotion lacks same-hierarchy foreign key ${reference}`);
    }
  }

  const deliveryRecords = byName.get("delivery_records");
  if (deliveryRecords.columns.remote_observation_id !== "canonical_id?"
    || deliveryRecords.columns.pr_observation_id !== "canonical_id?"
    || deliveryRecords.columns.terminal_from_state !== "delivery_state"
    || deliveryRecords.columns.decision_evidence_id !== "canonical_id") {
    fail("STATE_CONTRACT_TABLE_INVALID", "delivery failure observations or decision evidence are not representable");
  }
  if (!deliveryRecords.checks.some((entry) => entry.includes("delivery_failed from intent_recorded")
    && entry.includes("from remote_observed") && entry.includes("from pr_observed"))) {
    fail("STATE_CONTRACT_TABLE_INVALID", "delivery failure observation nullability does not match the state graph");
  }
  for (const [columns, reference] of [
    [["remote_observation_id", "delivery_intent_id"], "remote_observations(remote_observation_id,delivery_intent_id)"],
    [["pr_observation_id", "delivery_intent_id"], "pr_observations(pr_observation_id,delivery_intent_id)"],
  ]) {
    if (!deliveryRecords.foreign_keys.some((entry) => JSON.stringify(entry.columns) === JSON.stringify(columns)
      && entry.references === reference)) {
      fail("STATE_CONTRACT_TABLE_INVALID", `delivery record observation is not bound to its intent: ${reference}`);
    }
  }
  const legacy = byName.get("legacy_artifacts");
  if (legacy.foreign_keys.some((entry) => !entry.references.startsWith("repositories("))) {
    fail("STATE_CONTRACT_TABLE_INVALID", "legacy artifacts have an authority import route");
  }
}

function validateTransactions(contract) {
  const transactions = object(contract.transactions, "STATE_CONTRACT_TRANSACTION_INVALID", "transactions");
  exactKeys(transactions, [
    "default_write_begin", "transition_order", "lease_resource_snapshot_order",
    "idempotency", "cas_zero_rows", "invalid_edge", "wrong_owner",
    "crash_visibility", "named",
  ], "STATE_CONTRACT_TRANSACTION_INVALID", "transactions");
  exactKeys(transactions.idempotency, ["same_key_same_input", "same_key_different_input"], "STATE_CONTRACT_TRANSACTION_INVALID", "transactions.idempotency");
  equal(transactions.default_write_begin, "BEGIN IMMEDIATE", "STATE_CONTRACT_TRANSACTION_INVALID", "default write begin");
  equal(transactions.transition_order, [
    "load exact state and version; validate edge, guard, and owner",
    "resolve immutable context and evidence inputs",
    "check entity-scoped idempotency key and input digest",
    "insert evidence, transition, and ordered references",
    "compare-and-set snapshot state and increment state_version; require exactly one changed row",
  ], "STATE_CONTRACT_TRANSACTION_INVALID", "transition order");
  equal(transactions.lease_resource_snapshot_order, [
    "load or derive the exact owner, state, and state_version",
    "insert or compare-and-set the mutable lease or resource row",
    "append a schema-versioned immutable evidence post-image with matching attempt_id and state_version",
    "commit the mutable row and immutable post-image atomically",
  ], "STATE_CONTRACT_TRANSACTION_INVALID", "lease/resource snapshot order");
  equal(transactions.idempotency, {
    same_key_same_input: "return existing committed result",
    same_key_different_input: "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
  }, "STATE_CONTRACT_TRANSACTION_INVALID", "idempotency");
  equal(transactions.cas_zero_rows, "RICKGENT_STATE_CONFLICT", "STATE_CONTRACT_TRANSACTION_INVALID", "zero-row CAS");
  equal(transactions.invalid_edge, "RICKGENT_STATE_TRANSITION_ILLEGAL", "STATE_CONTRACT_TRANSACTION_INVALID", "illegal edge");
  equal(transactions.wrong_owner, "RICKGENT_STATE_OWNER_MISMATCH", "STATE_CONTRACT_TRANSACTION_INVALID", "wrong owner");
  equal(transactions.crash_visibility, "exactly old or new committed state", "STATE_CONTRACT_TRANSACTION_INVALID", "crash visibility");
  const named = array(transactions.named, "STATE_CONTRACT_TRANSACTION_INVALID", "transactions.named");
  equal(named.map((entry) => entry.name), TRANSACTIONS, "STATE_CONTRACT_TRANSACTION_INVALID", "transaction inventory");
  unique(named.map((entry) => entry.name), "STATE_CONTRACT_TRANSACTION_INVALID", "transaction inventory");
  for (const transaction of named) {
    exactKeys(transaction, ["name", "begin", "owner", "cas", "owner_check"], "STATE_CONTRACT_TRANSACTION_INVALID", transaction.name);
    if (!transaction.owner) fail("STATE_CONTRACT_TRANSACTION_INVALID", `${transaction.name} has no owner`);
    if (transaction.name === "open_and_migrate") {
      equal(transaction.begin, "exclusive migration critical section", "STATE_CONTRACT_TRANSACTION_INVALID", "migration begin");
    } else {
      equal(transaction.begin, "BEGIN IMMEDIATE", "STATE_CONTRACT_TRANSACTION_INVALID", `${transaction.name} begin`);
    }
  }
  for (const name of ["heartbeat_lease", "begin_lease_cleanup", "release_lease", "advance_resource", "quarantine_resource", "release_resource", "finalize_promotion", "finalize_delivery"]) {
    const transaction = named.find((entry) => entry.name === name);
    equal(transaction.cas, true, "STATE_CONTRACT_TRANSACTION_INVALID", `${name} CAS`);
    equal(transaction.owner_check, true, "STATE_CONTRACT_TRANSACTION_INVALID", `${name} owner check`);
  }
}

function assertGraph(graph, expectedStates, terminal, edgeCount, code, label) {
  object(graph, code, label);
  equal(graph.initial, expectedStates[0], code, `${label}.initial`);
  equal(graph.states, expectedStates, code, `${label}.states`);
  equal(graph.terminal, terminal, code, `${label}.terminal`);
  unique(graph.states, code, `${label}.states`);
  const edges = array(graph.edges, code, `${label}.edges`);
  if (edges.length !== edgeCount) fail(code, `${label} must contain ${edgeCount} edges`);
  const keys = edges.map((edge) => Array.isArray(edge) ? edge.join("->") : `${edge.from}->${edge.to}`);
  unique(keys, code, `${label}.edges`);
  for (const edge of edges) {
    if (Array.isArray(edge)) {
      if (edge.length !== 2) fail(code, `${label} edge must contain exactly from and to states`);
    } else {
      exactKeys(edge, ["from", "to", "owner", "guard"], code, `${label} edge`);
    }
    const from = Array.isArray(edge) ? edge[0] : edge.from;
    const to = Array.isArray(edge) ? edge[1] : edge.to;
    if (!graph.states.includes(from) || !graph.states.includes(to)) fail(code, `${label} edge ${from}->${to} uses an unknown state`);
    if (!Array.isArray(edge) && (!edge.owner || !edge.guard)) fail(code, `${label} edge ${from}->${to} lacks owner or guard`);
  }
  for (const state of terminal) {
    if (edges.some((edge) => (Array.isArray(edge) ? edge[0] : edge.from) === state)) fail(code, `${label} terminal state ${state} reopens`);
  }
}

function validateStateMachines(contract) {
  const graphs = object(contract.state_machines, "STATE_CONTRACT_GRAPH_INVALID", "state_machines");
  exactKeys(graphs, [
    "attempt", "ticket", "run", "lease", "resource", "promotion", "delivery",
    "terminal_rows_never_reopen", "stored_done_state_allowed", "done_presentation_alias",
  ], "STATE_CONTRACT_GRAPH_INVALID", "state_machines");
  exactKeys(graphs.attempt, ["initial", "states", "terminal", "edges", "timeout_is_terminal"], "STATE_CONTRACT_GRAPH_INVALID", "attempt");
  for (const name of ["ticket", "run"]) {
    exactKeys(graphs[name], ["initial", "states", "terminal", "edges"], "STATE_CONTRACT_GRAPH_INVALID", name);
  }
  for (const name of ["lease", "resource", "promotion", "delivery"]) {
    exactKeys(graphs[name], ["initial", "states", "terminal", "edges", "owner"], "STATE_CONTRACT_GRAPH_INVALID", name);
  }
  assertGraph(graphs.attempt, ATTEMPT_STATES, ["failed_clean", "quarantined", "verified"], 22, "STATE_CONTRACT_GRAPH_INVALID", "attempt");
  equal(graphs.attempt.timeout_is_terminal, false, "STATE_CONTRACT_GRAPH_INVALID", "timeout terminality");
  assertGraph(graphs.ticket, TICKET_STATES, ["failed", "quarantined", "ready_for_delivery"], 6, "STATE_CONTRACT_GRAPH_INVALID", "ticket");
  assertGraph(graphs.run, RUN_STATES, ["failed", "delivery_failed", "delivered"], 8, "STATE_CONTRACT_GRAPH_INVALID", "run");
  assertGraph(graphs.lease, LEASE_STATES, ["released", "quarantined"], 4, "STATE_CONTRACT_GRAPH_INVALID", "lease");
  assertGraph(graphs.resource, RESOURCE_STATES, ["released", "quarantined"], 6, "STATE_CONTRACT_GRAPH_INVALID", "resource");
  assertGraph(graphs.promotion, PROMOTION_STATES, ["conflicted", "finalized"], 7, "STATE_CONTRACT_GRAPH_INVALID", "promotion");
  assertGraph(graphs.delivery, DELIVERY_STATES, ["delivered", "delivery_failed"], 6, "STATE_CONTRACT_GRAPH_INVALID", "delivery");
  equal(graphs.terminal_rows_never_reopen, true, "STATE_CONTRACT_GRAPH_INVALID", "terminal rows");
  equal(graphs.stored_done_state_allowed, false, "STATE_CONTRACT_GRAPH_INVALID", "stored Done state");
  equal(graphs.done_presentation_alias, "run delivered", "STATE_CONTRACT_GRAPH_INVALID", "Done alias");
  equal(graphs.lease.owner, "LeaseService", "STATE_CONTRACT_GRAPH_INVALID", "lease owner");
  equal(graphs.resource.owner, "ResourceService", "STATE_CONTRACT_GRAPH_INVALID", "resource owner");
  equal(graphs.promotion.owner, "TicketFinalizationService", "STATE_CONTRACT_GRAPH_INVALID", "promotion owner");
  equal(graphs.delivery.owner, "DeliveryService", "STATE_CONTRACT_GRAPH_INVALID", "delivery owner");
  const ticketReady = graphs.ticket.edges.find((edge) => edge.to === "ready_for_delivery");
  equal(ticketReady?.owner, "TicketFinalizationService", "STATE_CONTRACT_GRAPH_INVALID", "ticket ready owner");
  const runReady = graphs.run.edges.find((edge) => edge.to === "ready_for_delivery");
  equal(runReady?.owner, "RunFinalizationService", "STATE_CONTRACT_GRAPH_INVALID", "run ready owner");
  for (const edge of graphs.run.edges.filter((entry) => ["delivered", "delivery_failed"].includes(entry.to))) {
    equal(edge.owner, "DeliveryService", "STATE_CONTRACT_GRAPH_INVALID", `run ${edge.to} owner`);
  }
}

function validateAllocationAndResources(contract) {
  const allocation = object(contract.allocation_and_recovery, "STATE_CONTRACT_ALLOCATION_INVALID", "allocation_and_recovery");
  exactKeys(allocation, ["ordinary_run", "attempt", "retry", "resume"], "STATE_CONTRACT_ALLOCATION_INVALID", "allocation_and_recovery");
  exactKeys(allocation.ordinary_run, [
    "always_new", "identical_input_reused", "transaction", "preconditions",
    "atomic_writes", "forbidden_lookup",
  ], "STATE_CONTRACT_ALLOCATION_INVALID", "allocation_and_recovery.ordinary_run");
  exactKeys(allocation.attempt, [
    "transaction", "next_number", "commit_before",
    "copies_run_delivery_oid_as_immutable_baseline", "reuse_attempt_or_dispatch_identity",
  ], "STATE_CONTRACT_ALLOCATION_INVALID", "allocation_and_recovery.attempt");
  exactKeys(allocation.retry, [
    "public_capability", "future_internal_identity", "requires",
    "quarantined_direct_retry_allowed", "new_spawn_requires_new_attempt_first",
  ], "STATE_CONTRACT_ALLOCATION_INVALID", "allocation_and_recovery.retry");
  exactKeys(allocation.resume, [
    "public_capability", "required_selector", "explicit_run_required", "forbidden_selectors",
    "reject_incompatibility", "allowed_same_attempt_actions",
    "spawn_under_existing_attempt_number_allowed",
  ], "STATE_CONTRACT_ALLOCATION_INVALID", "allocation_and_recovery.resume");
  equal(allocation.ordinary_run.always_new, true, "STATE_CONTRACT_ALLOCATION_INVALID", "ordinary run allocation");
  equal(allocation.ordinary_run.identical_input_reused, false, "STATE_CONTRACT_ALLOCATION_INVALID", "identical run reuse");
  equal(allocation.ordinary_run.transaction, "allocate_run", "STATE_CONTRACT_ALLOCATION_INVALID", "run transaction");
  equal(allocation.attempt.transaction, "allocate_attempt", "STATE_CONTRACT_ALLOCATION_INVALID", "attempt transaction");
  equal(allocation.attempt.next_number, "max(attempt_number) + 1 within the named run ticket", "STATE_CONTRACT_ALLOCATION_INVALID", "attempt numbering");
  equal(allocation.ordinary_run.atomic_writes.at(-1), "planned version-zero allocation snapshots only", "STATE_CONTRACT_ALLOCATION_INVALID", "non-runnable run allocation");
  equal(allocation.attempt.commit_before, ["legal activation transition", "lease acquisition", "resource side effect", "policy materialization", "agent spawn"], "STATE_CONTRACT_ALLOCATION_INVALID", "pre-spawn attempt commit");
  equal(allocation.attempt.copies_run_delivery_oid_as_immutable_baseline, true, "STATE_CONTRACT_ALLOCATION_INVALID", "attempt baseline");
  equal(allocation.attempt.reuse_attempt_or_dispatch_identity, false, "STATE_CONTRACT_ALLOCATION_INVALID", "attempt reuse");
  equal(allocation.retry.public_capability, "unavailable", "STATE_CONTRACT_ALLOCATION_INVALID", "retry capability");
  equal(allocation.retry.new_spawn_requires_new_attempt_first, true, "STATE_CONTRACT_ALLOCATION_INVALID", "retry allocation ordering");
  equal(allocation.resume.public_capability, "unavailable", "STATE_CONTRACT_ALLOCATION_INVALID", "resume capability");
  equal(allocation.resume.required_selector, ["--repo", "--run"], "STATE_CONTRACT_ALLOCATION_INVALID", "resume selector");
  equal(allocation.resume.explicit_run_required, true, "STATE_CONTRACT_ALLOCATION_INVALID", "explicit resume run");
  equal(allocation.resume.reject_incompatibility, ["repository identity", "contract or manifest digest", "context schema version", "oracle version", "capability snapshot", "resource identity version"], "STATE_CONTRACT_ALLOCATION_INVALID", "resume compatibility");
  equal(allocation.resume.spawn_under_existing_attempt_number_allowed, false, "STATE_CONTRACT_ALLOCATION_INVALID", "resume spawn reuse");

  const resources = object(contract.resource_identity, "STATE_CONTRACT_RESOURCE_INVALID", "resource_identity");
  exactKeys(resources, [
    "status", "ownership_tables", "attempt_disposition_writer_status", "production_cutover_ticket", "process_death_evidence_producer_ticket", "all_descendant_death_authority_ticket", "physical_cleanup_primitive_ticket", "attempt_disposition_authority_ticket",
    "kinds", "delivery_ref_template", "attempt_ref_template", "ref_validation",
    "private_attempt_directory", "private_attempt_directory_mode", "fixed_slot_names",
    "reserve_before_side_effect", "process_identity_fields", "pid_alone_is_ownership_proof",
    "process_death_proof_bases", "owner_mutation_checks", "stale_recovery_requires", "ownership_table_contract",
  ], "STATE_CONTRACT_RESOURCE_INVALID", "resource_identity");
  equal(resources.status, "attempt_cleanup_proof_substrate_implemented", "STATE_CONTRACT_RESOURCE_INVALID", "resource status");
  equal(resources.ownership_tables, [
    "attempt_ownership_leases", "attempt_resource_claims", "attempt_ownership_operations",
    "attempt_process_launches", "attempt_process_observations", "attempt_process_terminal_receipts",
    "attempt_commit_intents", "target_start_gates", "attempt_target_proof_sets", "attempt_target_proof_members",
    "cleanup_eligibility_records", "failure_cleanup_records", "promotion_cleanup_records",
    "quarantine_claim_sets", "quarantine_claim_members", "quarantine_records",
  ], "STATE_CONTRACT_RESOURCE_INVALID", "resource ownership tables");
  equal(resources.attempt_disposition_writer_status, "unavailable", "STATE_CONTRACT_RESOURCE_INVALID", "disposition writer status");
  equal(resources.production_cutover_ticket, "t22", "STATE_CONTRACT_RESOURCE_INVALID", "resource production cutover");
  equal(resources.process_death_evidence_producer_ticket, "t19", "STATE_CONTRACT_RESOURCE_INVALID", "resource process-death producer");
  equal(resources.all_descendant_death_authority_ticket, "t22", "STATE_CONTRACT_RESOURCE_INVALID", "all-descendant death authority");
  equal(resources.physical_cleanup_primitive_ticket, "t21", "STATE_CONTRACT_RESOURCE_INVALID", "physical cleanup primitive");
  equal(resources.attempt_disposition_authority_ticket, "t22", "STATE_CONTRACT_RESOURCE_INVALID", "attempt disposition authority");
  equal(resources.kinds, RESOURCE_KINDS, "STATE_CONTRACT_RESOURCE_INVALID", "resource kinds");
  equal(resources.delivery_ref_template, "refs/rickgent/runs/<run-id>/delivery", "STATE_CONTRACT_RESOURCE_INVALID", "delivery ref template");
  equal(resources.attempt_ref_template, "refs/rickgent/runs/<run-id>/attempts/<attempt-id>", "STATE_CONTRACT_RESOURCE_INVALID", "attempt ref template");
  equal(resources.ref_validation, "git check-ref-format before reservation", "STATE_CONTRACT_RESOURCE_INVALID", "ref validation");
  equal(resources.private_attempt_directory_mode, "0700", "STATE_CONTRACT_RESOURCE_INVALID", "resource directory mode");
  equal(resources.fixed_slot_names, true, "STATE_CONTRACT_RESOURCE_INVALID", "fixed resource slots");
  equal(resources.reserve_before_side_effect, true, "STATE_CONTRACT_RESOURCE_INVALID", "resource reservation order");
  equal(resources.pid_alone_is_ownership_proof, false, "STATE_CONTRACT_RESOURCE_INVALID", "PID ownership");
  equal(resources.process_death_proof_bases, {
    sampled_tracked_identities: {
      producer_ticket: "t19",
      proves: ["process-group death", "death of every sampled exact PID/start identity"],
      does_not_prove: "absence or death of descendants that escaped between process-table samples",
      all_descendant_death: false,
      lease_release_authority: false,
    },
    authoritative_containment: {
      producer_ticket: "t22",
      proves: ["authoritative containment membership", "death of every contained process"],
      all_descendant_death: true,
      lease_release_authority: true,
    },
  }, "STATE_CONTRACT_RESOURCE_INVALID", "process death proof bases");
  equal(resources.owner_mutation_checks, ["owner_token_digest", "lease_generation", "owner_context", "resource_state", "resource_version"], "STATE_CONTRACT_RESOURCE_INVALID", "resource owner checks");
  if (!resources.stale_recovery_requires.includes("authoritative_containment proof basis")) fail("STATE_CONTRACT_RESOURCE_INVALID", "stale recovery lacks authoritative containment proof");
  if (!resources.stale_recovery_requires.includes("proven old process-group death")) fail("STATE_CONTRACT_RESOURCE_INVALID", "stale recovery lacks process-group death proof");
  if (!resources.stale_recovery_requires.includes("proven death of every contained descendant")) fail("STATE_CONTRACT_RESOURCE_INVALID", "stale recovery lacks contained-descendant death proof");
  const ownershipContract = object(resources.ownership_table_contract, "STATE_CONTRACT_RESOURCE_INVALID", "ownership_table_contract");
  exactKeys(ownershipContract, [
    "attempt_ownership_leases", "attempt_resource_claims", "attempt_ownership_operations",
    "attempt_process_launches", "attempt_process_observations", "attempt_process_terminal_receipts",
    "attempt_commit_intents", "target_start_gates", "attempt_target_proof_sets", "cleanup_eligibility_records",
    "terminal_disposition_records", "quarantine_claim_sets", "resource_mutation_authority", "process_death_producer_authority",
    "commit_attribution_producer_authority", "legacy_v1_tables",
  ], "STATE_CONTRACT_RESOURCE_INVALID", "ownership_table_contract");
}

function validateOraclePromotionDelivery(contract) {
  const oracle = object(contract.oracle, "STATE_CONTRACT_ORACLE_INVALID", "oracle");
  exactKeys(oracle, [
    "status", "result_states", "gate_statuses", "required_gate_green_statuses",
    "required_gate_blocking_statuses", "reference_kinds", "current_reference_kinds", "legacy_reference_kinds", "required_input_classes",
    "reference_resolution", "snapshot_references", "legacy_snapshot_references", "eligibility_reference", "scope_congruence", "pure_function",
    "reads_live_files", "reads_live_git_refs", "reads_live_processes",
    "reads_environment", "reads_legacy_state", "reads_commit_messages",
    "updates_sqlite", "version_change_behavior",
    "ticket_ready_writer", "run_ready_writer", "delivered_writer",
    "forbidden_terminal_writers",
  ], "STATE_CONTRACT_ORACLE_INVALID", "oracle");
  equal(oracle.status, "reserved_contract_only", "STATE_CONTRACT_ORACLE_INVALID", "oracle status");
  equal(oracle.result_states, ["accepted", "rejected"], "STATE_CONTRACT_ORACLE_INVALID", "oracle results");
  equal(oracle.gate_statuses, GATE_STATUSES, "STATE_CONTRACT_ORACLE_INVALID", "gate statuses");
  equal(oracle.required_gate_green_statuses, ["passed"], "STATE_CONTRACT_ORACLE_INVALID", "required green statuses");
  equal(oracle.required_gate_blocking_statuses, GATE_STATUSES.slice(1), "STATE_CONTRACT_ORACLE_INVALID", "required blocking statuses");
  equal(oracle.reference_kinds, ORACLE_REFERENCE_KINDS, "STATE_CONTRACT_ORACLE_INVALID", "oracle reference kinds");
  equal(oracle.current_reference_kinds, ORACLE_REFERENCE_KINDS.filter((kind) => !["cleanup_record", "process_receipt"].includes(kind)), "STATE_CONTRACT_ORACLE_INVALID", "current oracle reference kinds");
  equal(oracle.legacy_reference_kinds, { kinds: ["cleanup_record", "process_receipt"], mode: "read_replay_only" }, "STATE_CONTRACT_ORACLE_INVALID", "legacy oracle reference kinds");
  if (oracle.required_input_classes.length !== 12) fail("STATE_CONTRACT_ORACLE_INVALID", "oracle input classes are incomplete");
  if (!String(oracle.reference_resolution).includes("one read transaction") || !String(oracle.reference_resolution).includes("content-pinned")) {
    fail("STATE_CONTRACT_ORACLE_INVALID", "oracle reference resolution is not exact and atomic");
  }
  exactKeys(oracle.snapshot_references, ["direct_mutable_row_references_allowed", "write_atomic_with_source_mutation", "lease", "attempt_resource"], "STATE_CONTRACT_ORACLE_INVALID", "oracle.snapshot_references");
  equal(oracle.snapshot_references.direct_mutable_row_references_allowed, false, "STATE_CONTRACT_ORACLE_INVALID", "direct mutable oracle references");
  equal(oracle.snapshot_references.write_atomic_with_source_mutation, true, "STATE_CONTRACT_ORACLE_INVALID", "snapshot write atomicity");
  equal(oracle.snapshot_references.lease, {
    reference_kind: "lease_snapshot",
    column: "ownership_snapshot_evidence_id",
    evidence_schema_version: "rickgent.attempt-ownership-lease-snapshot.v2",
    source_table: "attempt_ownership_leases",
    source_version_column: "state_version",
    required_state: "cleanup_pending",
  }, "STATE_CONTRACT_ORACLE_INVALID", "lease snapshot reference");
  equal(oracle.snapshot_references.attempt_resource, {
    reference_kind: "attempt_resource_snapshot",
    column: "claim_snapshot_evidence_ids_json[]",
    evidence_schema_version: "rickgent.attempt-resource-claim-snapshot.v2",
    source_table: "attempt_resource_claims",
    source_version_column: "state_version",
    required_state: "cleanup_pending",
    exact_slots: 11,
    set_digest_column: "claim_snapshot_set_digest",
  }, "STATE_CONTRACT_ORACLE_INVALID", "resource snapshot reference");
  equal(oracle.legacy_snapshot_references.mode, "read_replay_only", "STATE_CONTRACT_ORACLE_INVALID", "legacy snapshot mode");
  equal(oracle.eligibility_reference, {
    producer: "CleanupEligibilityService",
    schema: "rickgent.cleanup-eligibility.v1",
    source_table: "cleanup_eligibility_records",
    cardinality: 1,
    terminal: false,
    target_proof_set_state: "sealed_complete",
  }, "STATE_CONTRACT_ORACLE_INVALID", "cleanup eligibility reference");
  if (!String(oracle.scope_congruence).includes("rejects any input")
    || !String(oracle.scope_congruence).includes("run, ticket, or attempt lineage differs")) {
    fail("STATE_CONTRACT_ORACLE_INVALID", "oracle does not reject cross-scope input");
  }
  for (const field of ["pure_function", "reads_live_files", "reads_live_git_refs", "reads_live_processes", "reads_environment", "reads_legacy_state", "reads_commit_messages", "updates_sqlite"]) {
    const expected = field === "pure_function";
    equal(oracle[field], expected, "STATE_CONTRACT_ORACLE_INVALID", field);
  }
  equal(oracle.ticket_ready_writer, "TicketFinalizationService", "STATE_CONTRACT_ORACLE_INVALID", "ticket ready writer");
  equal(oracle.run_ready_writer, "RunFinalizationService", "STATE_CONTRACT_ORACLE_INVALID", "run ready writer");
  equal(oracle.delivered_writer, "DeliveryService", "STATE_CONTRACT_ORACLE_INVALID", "delivered writer");
  equal(oracle.forbidden_terminal_writers, FORBIDDEN_TERMINAL_WRITERS, "STATE_CONTRACT_ORACLE_INVALID", "forbidden terminal writers");

  const promotion = object(contract.promotion, "STATE_CONTRACT_PROMOTION_INVALID", "promotion");
  exactKeys(promotion, [
    "status", "mode", "scope_congruence", "candidate_requirements", "protocol", "one_inflight_intent_per_run",
    "git_update_ref_command", "conflicted_retry_requires_new_attempt", "merge_allowed", "rebase_allowed", "force_allowed",
    "fallback_allowed", "observation", "sequence_rule", "finalization_atomic_writes",
    "accepted_commits_form_one_fast_forward_chain", "crash_recovery",
  ], "STATE_CONTRACT_PROMOTION_INVALID", "promotion");
  exactKeys(promotion.observation, ["candidate_oid", "expected_old_oid", "third_oid"], "STATE_CONTRACT_PROMOTION_INVALID", "promotion.observation");
  equal(promotion.status, "reserved_contract_only", "STATE_CONTRACT_PROMOTION_INVALID", "promotion status");
  equal(promotion.mode, "sequential_compare_and_swap_fast_forward", "STATE_CONTRACT_PROMOTION_INVALID", "promotion mode");
  if (!String(promotion.scope_congruence).includes("composite foreign keys")
    || !String(promotion.scope_congruence).includes("one exact hierarchy")) {
    fail("STATE_CONTRACT_PROMOTION_INVALID", "promotion scope congruence is not frozen");
  }
  equal(promotion.one_inflight_intent_per_run, true, "STATE_CONTRACT_PROMOTION_INVALID", "in-flight promotion uniqueness");
  equal(promotion.git_update_ref_command, ["git", "-C", "<repo-realpath>", "update-ref", "<delivery-ref>", "<candidate-oid>", "<expected-old-oid>"], "STATE_CONTRACT_PROMOTION_INVALID", "Git compare-and-swap command");
  equal(promotion.conflicted_retry_requires_new_attempt, true, "STATE_CONTRACT_PROMOTION_INVALID", "conflicted promotion retry identity");
  for (const field of ["merge_allowed", "rebase_allowed", "force_allowed", "fallback_allowed"]) {
    equal(promotion[field], false, "STATE_CONTRACT_PROMOTION_INVALID", field);
  }
  equal(promotion.observation, { candidate_oid: "success", expected_old_oid: "retryable", third_oid: "RICKGENT_PROMOTION_CONFLICT" }, "STATE_CONTRACT_PROMOTION_INVALID", "promotion observation");
  if (!promotion.sequence_rule.includes("sequence n-1 candidate_oid")) fail("STATE_CONTRACT_PROMOTION_INVALID", "promotion chain rule is missing");
  equal(promotion.accepted_commits_form_one_fast_forward_chain, true, "STATE_CONTRACT_PROMOTION_INVALID", "fast-forward chain");
  const protocol = array(promotion.protocol, "STATE_CONTRACT_PROMOTION_INVALID", "promotion.protocol");
  equal(protocol.map((entry) => entry.step), [1, 2, 3, 4], "STATE_CONTRACT_PROMOTION_INVALID", "promotion protocol steps");
  for (const entry of protocol) exactKeys(entry, ["step", "operation", "authority"], "STATE_CONTRACT_PROMOTION_INVALID", `promotion.protocol.${entry.step}`);
  if (!protocol[2].authority.includes("third OID is conflict")) fail("STATE_CONTRACT_PROMOTION_INVALID", "promotion lacks independent third-OID handling");
  for (const write of ["CAS run current_delivery_oid, state_version, and promotion_sequence", "attempt oracle_evaluation then verified transitions", "ticket ready_for_delivery transition by TicketFinalizationService"]) {
    if (!promotion.finalization_atomic_writes.includes(write)) fail("STATE_CONTRACT_PROMOTION_INVALID", `promotion finalization omits ${write}`);
  }

  const delivery = object(contract.delivery, "STATE_CONTRACT_DELIVERY_INVALID", "delivery");
  exactKeys(delivery, [
    "status", "ready_for_delivery", "delivered", "done_alias", "run_ready_is_terminal",
    "ticket_ready_is_terminal", "delivered_requires", "failure_recording",
    "automatic_delivery_enabled",
  ], "STATE_CONTRACT_DELIVERY_INVALID", "delivery");
  equal(delivery.status, "reserved_contract_only", "STATE_CONTRACT_DELIVERY_INVALID", "delivery status");
  if (!delivery.ready_for_delivery.includes("local oracle") || !delivery.delivered.includes("remote delivery")) {
    fail("STATE_CONTRACT_DELIVERY_INVALID", "ready and delivered meanings are conflated");
  }
  equal(delivery.done_alias, "presentation-only alias for run delivered", "STATE_CONTRACT_DELIVERY_INVALID", "Done alias");
  equal(delivery.run_ready_is_terminal, false, "STATE_CONTRACT_DELIVERY_INVALID", "run ready terminality");
  equal(delivery.ticket_ready_is_terminal, true, "STATE_CONTRACT_DELIVERY_INVALID", "ticket ready terminality");
  if (delivery.delivered_requires.length !== 5) fail("STATE_CONTRACT_DELIVERY_INVALID", "delivery evidence is incomplete");
  if (!String(delivery.failure_recording).includes("terminal_from_state")
    || !String(delivery.failure_recording).includes("nullable")) {
    fail("STATE_CONTRACT_DELIVERY_INVALID", "early delivery failures require fabricated observations");
  }
  equal(delivery.automatic_delivery_enabled, false, "STATE_CONTRACT_DELIVERY_INVALID", "automatic delivery capability");
}

function validateLegacyCapabilitiesAndErrors(contract) {
  const legacy = object(contract.legacy, "STATE_CONTRACT_LEGACY_INVALID", "legacy");
  exactKeys(legacy, [
    "policy", "inventory_kinds", "resolver_uses_RICKGENT_DIR", "resolver_scans_caller_cwd",
    "diagnostics_follow_symlinks", "diagnostic_fields", "authoritative_import_allowed",
    "terminal_import_allowed", "nonterminal_cache_import_allowed", "git_subject_authoritative",
    "corrupt_legacy_means_empty_state", "mutation_open_with_lifecycle_legacy",
    "quarantine_guidance", "cutover_ticket", "cutover_scope",
    "post_cutover_authoritative_writer", "environment_fallback_allowed",
    "feature_flag_fallback_allowed", "shadow_write_allowed",
    "long_lived_dual_write_allowed", "historic_metrics_merge_into_terminal_truth",
  ], "STATE_CONTRACT_LEGACY_INVALID", "legacy");
  equal(legacy.policy, "quarantine_or_diagnostic_read_only", "STATE_CONTRACT_LEGACY_INVALID", "legacy policy");
  const requiredKinds = ["registry.json", "dispatch-ledger.jsonl", "runs.jsonl", "interventions.jsonl", "salvage-dispositions.jsonl", "prs.jsonl", "defects.jsonl", "locks/*.lock", "legacy attempt receipts", "salvage archives", "ticket: <id> Git subjects"];
  equal(legacy.inventory_kinds, requiredKinds, "STATE_CONTRACT_LEGACY_INVALID", "legacy inventory");
  for (const field of ["resolver_uses_RICKGENT_DIR", "resolver_scans_caller_cwd", "diagnostics_follow_symlinks", "authoritative_import_allowed", "terminal_import_allowed", "nonterminal_cache_import_allowed", "git_subject_authoritative", "corrupt_legacy_means_empty_state", "environment_fallback_allowed", "feature_flag_fallback_allowed", "shadow_write_allowed", "long_lived_dual_write_allowed", "historic_metrics_merge_into_terminal_truth"]) {
    equal(legacy[field], false, "STATE_CONTRACT_LEGACY_INVALID", field);
  }
  equal(legacy.mutation_open_with_lifecycle_legacy, "RICKGENT_LEGACY_STATE_QUARANTINED", "STATE_CONTRACT_LEGACY_INVALID", "legacy mutation open");
  equal(legacy.cutover_ticket, "t16", "STATE_CONTRACT_LEGACY_INVALID", "legacy cutover");
  equal(legacy.post_cutover_authoritative_writer, "SQLite only", "STATE_CONTRACT_LEGACY_INVALID", "post-cutover writer");

  const capabilities = array(contract.capability_reservations, "STATE_CONTRACT_CAPABILITY_INVALID", "capability_reservations");
  const expectedNames = ["durable_sqlite_state", "run_attempt_allocation", "oracle_and_promotion", "caller_cutover_and_internal_selectors", "public_resume_retry_and_reconciliation", "attempt_resources", "automatic_delivery"];
  equal(capabilities.map((entry) => entry.name), expectedNames, "STATE_CONTRACT_CAPABILITY_INVALID", "capability reservations");
  unique(capabilities.map((entry) => entry.name), "STATE_CONTRACT_CAPABILITY_INVALID", "capability reservations");
  for (const entry of capabilities) {
    exactKeys(entry, ["name", "status", "enabled", "implementation_ticket"], "STATE_CONTRACT_CAPABILITY_INVALID", entry.name);
    const expectedStatus = entry.name === "attempt_resources" ? "internal_primitive_implemented" : "reserved_contract_only";
    equal(entry.status, expectedStatus, "STATE_CONTRACT_CAPABILITY_INVALID", `${entry.name}.status`);
    equal(entry.enabled, false, "STATE_CONTRACT_CAPABILITY_INVALID", `${entry.name}.enabled`);
    if (!entry.implementation_ticket) fail("STATE_CONTRACT_CAPABILITY_INVALID", `${entry.name} lacks an implementation ticket`);
  }

  const errors = array(contract.stable_errors, "STATE_CONTRACT_ERROR_INVALID", "stable_errors");
  equal(errors.map((entry) => entry.code), ERROR_CODES, "STATE_CONTRACT_ERROR_INVALID", "stable error codes");
  unique(errors.map((entry) => entry.code), "STATE_CONTRACT_ERROR_INVALID", "stable error codes");
  for (const entry of errors) {
    exactKeys(entry, ["code", "class", "condition"], "STATE_CONTRACT_ERROR_INVALID", entry.code);
    if (!new Set(["infrastructure", "input_contract"]).has(entry.class) || !entry.condition) {
      fail("STATE_CONTRACT_ERROR_INVALID", `${entry.code} lacks class or condition`);
    }
  }
}

function main() {
  const contractPath = resolve(process.argv[2] ?? "docs/architecture/reliability/state-and-lifecycle-contract.json");
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch (error) {
    fail("STATE_CONTRACT_JSON_INVALID", `${contractPath}: ${error.message}`);
  }
  object(contract, "STATE_CONTRACT_JSON_INVALID", "contract");
  validateMetadata(contract);
  validateStateRoot(contract);
  validateSqlite(contract);
  validateScalarFormats(contract);
  validateMigrations(contract);
  validateTables(contract);
  validateTransactions(contract);
  validateStateMachines(contract);
  validateAllocationAndResources(contract);
  validateOraclePromotionDelivery(contract);
  validateLegacyCapabilitiesAndErrors(contract);

  process.stdout.write(`${JSON.stringify({
    schema_version: contract.schema_version,
    contract_id: contract.contract_id,
    decision_status: contract.decision_status,
    implementation_status: contract.activation_boundary.implementation_status,
    migrations: contract.migrations.initial.length,
    tables: contract.entity_model.catalog.length,
    transactions: contract.transactions.named.length,
  })}\n`);
}

try {
  main();
} catch (error) {
  const code = error instanceof StateContractError ? error.code : "STATE_CONTRACT_VALIDATOR_INTERNAL";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exit(1);
}
