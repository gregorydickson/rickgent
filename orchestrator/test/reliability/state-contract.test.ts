import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  APPEND_ONLY_STATE_TABLES,
  ATTEMPT_OWNERSHIP_MIGRATION,
  ATTEMPT_OWNERSHIP_STATE_TABLES,
  ALL_STATE_TABLES,
  ATTEMPT_STATES,
  ATTEMPT_TERMINAL_STATES,
  ATTEMPT_TRANSITIONS,
  CAPABILITY_RESERVATIONS,
  CAS_STATE_TABLES,
  COMMIT_ATTRIBUTION_MIGRATION,
  COMMIT_ATTRIBUTION_STATE_TABLES,
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  DELIVERY_TRANSITIONS,
  FORBIDDEN_TERMINAL_WRITERS,
  GATE_STATUSES,
  INITIAL_STATE_MIGRATION,
  LEASE_STATES,
  LEASE_TERMINAL_STATES,
  LEASE_TRANSITIONS,
  LEGACY_ARTIFACT_KINDS,
  ORACLE_REFERENCE_KINDS,
  PROMOTION_STATES,
  PROMOTION_TERMINAL_STATES,
  PROMOTION_TRANSITIONS,
  PROCESS_SUPERVISION_MIGRATION,
  PROCESS_SUPERVISION_STATE_TABLES,
  REQUIRED_GATE_BLOCKING_STATUSES,
  REQUIRED_GATE_GREEN_STATUSES,
  RESOURCE_KINDS,
  RESOURCE_STATES,
  RESOURCE_TERMINAL_STATES,
  RESOURCE_TRANSITIONS,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  SQLITE_CONNECTION_OPTION_MAPPING,
  SQLITE_PRAGMAS,
  STABLE_STATE_ERRORS,
  STATE_CONTRACT_DECISION_STATUS,
  STATE_CONTRACT_ID,
  STATE_CONTRACT_IMPLEMENTATION_STATUS,
  STATE_CONTRACT_SCHEMA_VERSION,
  STATE_ERROR_CODES,
  STATE_MIGRATIONS,
  STATE_SQLITE_MINIMUM_NODE_VERSION,
  STATE_TABLES,
  STATE_TRANSACTION_NAMES,
  TICKET_STATES,
  TICKET_TERMINAL_STATES,
  TICKET_TRANSITIONS,
} from "../../src/state/schema.js";
import {
  ATTEMPT_OWNERSHIP_MIGRATION_CHECKSUM,
  ATTEMPT_OWNERSHIP_STATE_SQLITE_SCHEMA_CHECKSUM,
  COMMIT_ATTRIBUTION_MIGRATION_CHECKSUM,
  INITIAL_STATE_MIGRATION_CHECKSUM,
  INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM,
  LATEST_STATE_SQLITE_SCHEMA_CHECKSUM,
  PROCESS_SUPERVISION_MIGRATION_CHECKSUM,
  PROCESS_SUPERVISION_STATE_SQLITE_SCHEMA_CHECKSUM,
  STATE_MIGRATIONS as EXECUTABLE_STATE_MIGRATIONS,
} from "../../src/state/migrations.js";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const contractPath = join(repoRoot, "docs/architecture/reliability/state-and-lifecycle-contract.json");
const validatorPath = join(orchestratorRoot, "scripts/validate-state-contract.mjs");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "rickgent-state-contract-"));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported JSON value ${typeof value}`);
}

function refreshDigest(draft: typeof contract): void {
  const unsigned = { ...draft };
  delete unsigned.decision_digest;
  draft.decision_digest = `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
}

function validateMutation(name: string, mutate: (draft: typeof contract) => void) {
  const draft = structuredClone(contract);
  mutate(draft);
  refreshDigest(draft);
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  return spawnSync(process.execPath, [validatorPath, path], { encoding: "utf8" });
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("frozen state contract parity", () => {
  it("matches metadata, migrations, tables, transactions, and SQLite settings", () => {
    expect(contract.schema_version).toBe(STATE_CONTRACT_SCHEMA_VERSION);
    expect(contract.contract_id).toBe(STATE_CONTRACT_ID);
    expect(contract.decision_status).toBe(STATE_CONTRACT_DECISION_STATUS);
    expect(contract.activation_boundary.implementation_status).toBe(STATE_CONTRACT_IMPLEMENTATION_STATUS);
    expect(contract.migrations.initial).toEqual(STATE_MIGRATIONS);
    expect(contract.migrations.initial[0]).toEqual(INITIAL_STATE_MIGRATION);
    expect(INITIAL_STATE_MIGRATION.released_checksum).toBe(INITIAL_STATE_MIGRATION_CHECKSUM);
    expect(INITIAL_STATE_MIGRATION.sqlite_schema_checksum).toBe(INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM);
    expect(ATTEMPT_OWNERSHIP_MIGRATION.released_checksum).toBe(ATTEMPT_OWNERSHIP_MIGRATION_CHECKSUM);
    expect(ATTEMPT_OWNERSHIP_MIGRATION.sqlite_schema_checksum).toBe(ATTEMPT_OWNERSHIP_STATE_SQLITE_SCHEMA_CHECKSUM);
    expect(EXECUTABLE_STATE_MIGRATIONS[0]).toMatchObject({
      version: INITIAL_STATE_MIGRATION.version,
      number: INITIAL_STATE_MIGRATION.number,
      name: INITIAL_STATE_MIGRATION.name,
      checksum: INITIAL_STATE_MIGRATION.released_checksum,
    });
    expect(EXECUTABLE_STATE_MIGRATIONS[1]).toMatchObject({
      version: ATTEMPT_OWNERSHIP_MIGRATION.version,
      number: ATTEMPT_OWNERSHIP_MIGRATION.number,
      name: ATTEMPT_OWNERSHIP_MIGRATION.name,
      checksum: ATTEMPT_OWNERSHIP_MIGRATION.released_checksum,
    });
    expect(EXECUTABLE_STATE_MIGRATIONS[2]).toMatchObject({
      version: PROCESS_SUPERVISION_MIGRATION.version,
      number: PROCESS_SUPERVISION_MIGRATION.number,
      name: PROCESS_SUPERVISION_MIGRATION.name,
      checksum: PROCESS_SUPERVISION_MIGRATION_CHECKSUM,
    });
    expect(PROCESS_SUPERVISION_MIGRATION.released_checksum).toBe(PROCESS_SUPERVISION_MIGRATION_CHECKSUM);
    expect(PROCESS_SUPERVISION_MIGRATION.sqlite_schema_checksum).toBe(PROCESS_SUPERVISION_STATE_SQLITE_SCHEMA_CHECKSUM);
    expect(EXECUTABLE_STATE_MIGRATIONS[3]).toMatchObject({
      version: COMMIT_ATTRIBUTION_MIGRATION.version,
      number: COMMIT_ATTRIBUTION_MIGRATION.number,
      name: COMMIT_ATTRIBUTION_MIGRATION.name,
      checksum: COMMIT_ATTRIBUTION_MIGRATION_CHECKSUM,
    });
    expect(COMMIT_ATTRIBUTION_MIGRATION.released_checksum).toBe(COMMIT_ATTRIBUTION_MIGRATION_CHECKSUM);
    expect(COMMIT_ATTRIBUTION_MIGRATION.sqlite_schema_checksum).toBe(LATEST_STATE_SQLITE_SCHEMA_CHECKSUM);
    expect(new Set(ALL_STATE_TABLES)).toEqual(new Set([
      ...STATE_TABLES,
      ...ATTEMPT_OWNERSHIP_STATE_TABLES,
      ...PROCESS_SUPERVISION_STATE_TABLES,
      ...COMMIT_ATTRIBUTION_STATE_TABLES,
    ]));
    expect(PROCESS_SUPERVISION_STATE_TABLES).toEqual([
      "attempt_process_launches",
      "attempt_process_observations",
      "attempt_process_terminal_receipts",
    ]);
    expect(COMMIT_ATTRIBUTION_STATE_TABLES).toEqual(["attempt_commit_intents"]);
    expect(LATEST_STATE_SQLITE_SCHEMA_CHECKSUM).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contract.entity_model.catalog.map((table: { name: string }) => table.name)).toEqual(STATE_TABLES);
    expect(contract.entity_model.catalog.filter((table: { mutation: { mode: string } }) => table.mutation.mode !== "append_only").map((table: { name: string }) => table.name)).toEqual(CAS_STATE_TABLES);
    expect(contract.entity_model.catalog.filter((table: { mutation: { mode: string } }) => table.mutation.mode === "append_only").map((table: { name: string }) => table.name)).toEqual(APPEND_ONLY_STATE_TABLES);
    expect(contract.sqlite.pragmas).toEqual(SQLITE_PRAGMAS);
    expect(contract.sqlite.minimum_node_version).toBe(STATE_SQLITE_MINIMUM_NODE_VERSION);
    expect(contract.sqlite.node_database_sync_option_mapping).toEqual(SQLITE_CONNECTION_OPTION_MAPPING);
    expect(contract.transactions.named.map((transaction: { name: string }) => transaction.name)).toEqual(STATE_TRANSACTION_NAMES);
    expect(new Set(STATE_TABLES).size).toBe(30);
  });

  it("executes the frozen DatabaseSync controls on the declared runtime floor", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major !== 24 || minor < 12) {
      expect(contract.sqlite.unsupported_runtime_result).toBe("RICKGENT_STATE_RUNTIME_UNSUPPORTED");
      return;
    }

    const database = new DatabaseSync(":memory:", {
      enableForeignKeyConstraints: true,
      defensive: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      allowUnknownNamedParameters: false,
    });
    try {
      expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(() => database.prepare("SELECT :value AS value").get({ ":value": 1, ":unknown": 2 })).toThrow(/Unknown named parameter/);
      expect(() => database.prepare('SELECT "not_a_column"').get()).toThrow(/no such column/);
      database.exec("PRAGMA writable_schema=ON");
      expect(database.prepare("PRAGMA writable_schema").get()).toMatchObject({ writable_schema: 0 });
    } finally {
      database.close();
    }
  });

  it("matches every lifecycle graph and terminal set", () => {
    expect(contract.state_machines.attempt).toMatchObject({ states: ATTEMPT_STATES, terminal: ATTEMPT_TERMINAL_STATES, edges: ATTEMPT_TRANSITIONS });
    expect(contract.state_machines.ticket).toMatchObject({ states: TICKET_STATES, terminal: TICKET_TERMINAL_STATES, edges: TICKET_TRANSITIONS });
    expect(contract.state_machines.run).toMatchObject({ states: RUN_STATES, terminal: RUN_TERMINAL_STATES, edges: RUN_TRANSITIONS });
    expect(contract.state_machines.lease).toMatchObject({ states: LEASE_STATES, terminal: LEASE_TERMINAL_STATES, edges: LEASE_TRANSITIONS });
    expect(contract.state_machines.resource).toMatchObject({ states: RESOURCE_STATES, terminal: RESOURCE_TERMINAL_STATES, edges: RESOURCE_TRANSITIONS });
    expect(contract.state_machines.promotion).toMatchObject({ states: PROMOTION_STATES, terminal: PROMOTION_TERMINAL_STATES, edges: PROMOTION_TRANSITIONS });
    expect(contract.state_machines.delivery).toMatchObject({ states: DELIVERY_STATES, terminal: DELIVERY_TERMINAL_STATES, edges: DELIVERY_TRANSITIONS });
    expect(contract.state_machines.attempt.timeout_is_terminal).toBe(false);
    expect(contract.state_machines.stored_done_state_allowed).toBe(false);
    expect(Object.values(contract.state_machines).flatMap((graph: any) => graph?.states ?? [])).not.toContain("Done");
  });

  it("matches oracle, resource, legacy, capability, and error vocabularies", () => {
    expect(contract.oracle.gate_statuses).toEqual(GATE_STATUSES);
    expect(contract.oracle.required_gate_green_statuses).toEqual(REQUIRED_GATE_GREEN_STATUSES);
    expect(contract.oracle.required_gate_blocking_statuses).toEqual(REQUIRED_GATE_BLOCKING_STATUSES);
    expect(contract.oracle.reference_kinds).toEqual(ORACLE_REFERENCE_KINDS);
    expect(contract.oracle.forbidden_terminal_writers).toEqual(FORBIDDEN_TERMINAL_WRITERS);
    expect(contract.resource_identity.kinds).toEqual(RESOURCE_KINDS);
    expect(contract.legacy.inventory_kinds).toEqual(LEGACY_ARTIFACT_KINDS);
    expect(contract.capability_reservations).toEqual(CAPABILITY_RESERVATIONS);
    expect(contract.stable_errors).toEqual(STABLE_STATE_ERRORS);
    expect(contract.stable_errors.map((entry: { code: string }) => entry.code)).toEqual(STATE_ERROR_CODES);
    expect(REQUIRED_GATE_GREEN_STATUSES).toEqual(["passed"]);
  });

  it("pins oracle inputs to immutable snapshots and one scope hierarchy", () => {
    const tables = new Map(contract.entity_model.catalog.map((table: any) => [table.name, table]));
    const references: any = tables.get("oracle_input_references");
    const promotions: any = tables.get("promotion_intents");

    expect(references.columns).not.toHaveProperty("resource_id");
    expect(references.columns).not.toHaveProperty("lease_id");
    expect(references.columns.resource_snapshot_evidence_id).toBe("canonical_id?");
    expect(references.columns.lease_snapshot_evidence_id).toBe("canonical_id?");
    expect(references.foreign_keys).toContainEqual({
      columns: ["oracle_decision_id", "run_id", "ticket_instance_id", "attempt_id"],
      references: "oracle_decisions(oracle_decision_id,run_id,ticket_instance_id,attempt_id)",
      on_delete: "RESTRICT",
    });
    expect(promotions.foreign_keys).toContainEqual({
      columns: ["oracle_decision_id", "run_id", "ticket_instance_id", "attempt_id"],
      references: "oracle_decisions(oracle_decision_id,run_id,ticket_instance_id,attempt_id)",
      on_delete: "RESTRICT",
    });
    expect(contract.oracle.snapshot_references.direct_mutable_row_references_allowed).toBe(false);
  });

  it("pins attempt-scoped rows to one relational lineage", () => {
    const tables = new Map(contract.entity_model.catalog.map((table: any) => [table.name, table]));
    const attempts: any = tables.get("attempts");
    const evidence: any = tables.get("evidence");
    const resources: any = tables.get("attempt_resources");
    const processes: any = tables.get("process_receipts");

    expect(attempts.foreign_keys).toContainEqual({
      columns: ["ticket_instance_id", "run_id", "ticket_id", "contract_digest"],
      references: "run_tickets(ticket_instance_id,run_id,ticket_id,contract_digest)",
      on_delete: "RESTRICT",
    });
    expect(evidence.foreign_keys).toEqual(expect.arrayContaining([
      { columns: ["phase_execution_id", "attempt_id"], references: "phase_executions(phase_execution_id,attempt_id)", on_delete: "RESTRICT" },
      { columns: ["context_id", "attempt_id"], references: "execution_contexts(context_id,attempt_id)", on_delete: "RESTRICT" },
      { columns: ["phase_execution_id", "context_id"], references: "phase_executions(phase_execution_id,context_id)", on_delete: "RESTRICT" },
    ]));
    expect(resources.foreign_keys).toContainEqual({
      columns: ["allocation_lease_id", "attempt_id"],
      references: "leases(lease_id,attempt_id)",
      on_delete: "RESTRICT",
    });
    expect(processes.foreign_keys).toContainEqual({
      columns: ["lease_id", "lease_generation"],
      references: "leases(lease_id,generation)",
      on_delete: "RESTRICT",
    });
  });

  it("uses null-safe scoped idempotency and records early delivery failure honestly", () => {
    const tables = new Map(contract.entity_model.catalog.map((table: any) => [table.name, table]));
    const decisions: any = tables.get("oracle_decisions");
    const delivery: any = tables.get("delivery_records");

    expect(decisions.unique_constraints.filter((entry: any) => entry.name.endsWith("_idempotency_uq"))).toEqual([
      { name: "oracle_decisions_run_idempotency_uq", columns: ["run_id", "idempotency_key"], where: "scope_kind = 'run'" },
      { name: "oracle_decisions_ticket_idempotency_uq", columns: ["ticket_instance_id", "idempotency_key"], where: "scope_kind = 'ticket'" },
      { name: "oracle_decisions_attempt_idempotency_uq", columns: ["attempt_id", "idempotency_key"], where: "scope_kind = 'attempt'" },
    ]);
    expect(delivery.columns).toMatchObject({
      terminal_from_state: "delivery_state",
      remote_observation_id: "canonical_id?",
      pr_observation_id: "canonical_id?",
      decision_evidence_id: "canonical_id",
    });
  });

  it("targets promotion at the selected repository and permits retry after conflict", () => {
    const promotions: any = contract.entity_model.catalog.find((table: any) => table.name === "promotion_intents");

    expect(contract.promotion.git_update_ref_command).toEqual([
      "git", "-C", "<repo-realpath>", "update-ref",
      "<delivery-ref>", "<candidate-oid>", "<expected-old-oid>",
    ]);
    expect(contract.promotion.conflicted_retry_requires_new_attempt).toBe(true);
    expect(promotions.unique_constraints).toContainEqual({
      name: "promotion_intents_ticket_inflight_uq",
      columns: ["ticket_instance_id"],
      where: "state NOT IN ('finalized','conflicted')",
    });
    expect(promotions.unique_constraints).not.toContainEqual({
      name: expect.any(String),
      columns: ["ticket_instance_id"],
    });
  });

  it("deep-freezes the exported vocabulary", () => {
    expect(Object.isFrozen(STATE_TABLES)).toBe(true);
    expect(Object.isFrozen(SQLITE_PRAGMAS)).toBe(true);
    expect(Object.isFrozen(SQLITE_PRAGMAS[0])).toBe(true);
    expect(Object.isFrozen(ATTEMPT_TRANSITIONS[0])).toBe(true);
    expect(Object.isFrozen(CAPABILITY_RESERVATIONS[0])).toBe(true);
  });
});

describe("state contract validator sensitivity", () => {
  const cases: Array<[string, string, (draft: typeof contract) => void]> = [
    ["schema-version", "STATE_CONTRACT_VERSION_UNSUPPORTED", (draft) => { draft.schema_version = "2.0.0"; }],
    ["migration-contiguity", "STATE_CONTRACT_MIGRATION_INVALID", (draft) => { draft.migrations.initial[0].version = 2; }],
    ["migration-release-checksum", "STATE_CONTRACT_MIGRATION_INVALID", (draft) => { draft.migrations.initial[0].released_checksum = `sha256:${"0".repeat(64)}`; }],
    ["migration-schema-checksum", "STATE_CONTRACT_MIGRATION_INVALID", (draft) => { draft.migrations.initial[0].sqlite_schema_checksum = `sha256:${"0".repeat(64)}`; }],
    ["migration-status", "STATE_CONTRACT_MIGRATION_INVALID", (draft) => { draft.migrations.initial[0].status = "reserved_contract_only"; }],
    ["scalar-format", "STATE_CONTRACT_SCALAR_INVALID", (draft) => { draft.scalar_formats.sha256_digest = "arbitrary text"; }],
    ["unknown-nested-field", "STATE_CONTRACT_ROOT_INVALID", (draft) => { draft.state_root.cwd_fallback = true; }],
    ["table-inventory", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.pop(); }],
    ["foreign-key-delete", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.foreign_keys.length).foreign_keys[0].on_delete = "CASCADE"; }],
    ["unique-constraint", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.name === "leases").unique_constraints = []; }],
    ["foreign-key-target-unique", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.name === "run_ticket_dependencies").unique_constraints.pop(); }],
    ["attempt-full-lineage", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "attempts"); table.foreign_keys = table.foreign_keys.filter((entry: any) => entry.columns.length !== 4); }],
    ["evidence-attempt-lineage", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "evidence"); table.foreign_keys = table.foreign_keys.filter((entry: any) => entry.references !== "phase_executions(phase_execution_id,attempt_id)"); }],
    ["oracle-dependency-foreign-key", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "oracle_input_references"); table.foreign_keys = table.foreign_keys.filter((entry: any) => entry.columns[0] !== "dependency_digest"); }],
    ["append-only-trigger", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.name === "evidence").mutation.update_trigger = "mutable"; }],
    ["immutable-column", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.name === "runs").mutation.immutable_columns.pop(); }],
    ["cas-predicate", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.name === "runs").mutation.cas_predicate = "WHERE run_id = ?"; }],
    ["wal", "STATE_CONTRACT_SQLITE_INVALID", (draft) => { draft.sqlite.pragmas[1].value = "DELETE"; }],
    ["node-state-floor", "STATE_CONTRACT_SQLITE_INVALID", (draft) => { draft.sqlite.minimum_node_version = "24.0.0"; }],
    ["node-option-mapping", "STATE_CONTRACT_SQLITE_INVALID", (draft) => { draft.sqlite.node_database_sync_option_mapping.defensive = "unsupported"; }],
    ["foreign-keys", "STATE_CONTRACT_SQLITE_INVALID", (draft) => { draft.sqlite.connection_options.foreign_keys = false; }],
    ["busy-timeout", "STATE_CONTRACT_SQLITE_INVALID", (draft) => { draft.sqlite.busy_policy.timeout_ms = 0; }],
    ["cwd-independence", "STATE_CONTRACT_ROOT_INVALID", (draft) => { draft.state_root.caller_cwd_authoritative = true; }],
    ["canonical-top-level-query", "STATE_CONTRACT_ROOT_INVALID", (draft) => { draft.state_root.git_top_level_command.pop(); }],
    ["root-owner-scope", "STATE_CONTRACT_ROOT_INVALID", (draft) => { draft.state_root.required_owner = "every ancestor"; }],
    ["symlink-root", "STATE_CONTRACT_ROOT_INVALID", (draft) => { draft.state_root.symlink_allowed = true; }],
    ["fresh-run", "STATE_CONTRACT_ALLOCATION_INVALID", (draft) => { draft.allocation_and_recovery.ordinary_run.always_new = false; }],
    ["non-runnable-run-allocation", "STATE_CONTRACT_ALLOCATION_INVALID", (draft) => { draft.allocation_and_recovery.ordinary_run.atomic_writes.pop(); }],
    ["activation-before-spawn", "STATE_CONTRACT_ALLOCATION_INVALID", (draft) => { draft.allocation_and_recovery.attempt.commit_before.shift(); }],
    ["retry-before-spawn", "STATE_CONTRACT_ALLOCATION_INVALID", (draft) => { draft.allocation_and_recovery.retry.new_spawn_requires_new_attempt_first = false; }],
    ["explicit-resume", "STATE_CONTRACT_ALLOCATION_INVALID", (draft) => { draft.allocation_and_recovery.resume.explicit_run_required = false; }],
    ["lease-owner-generation", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((table: any) => table.name === "leases").mutation.cas_predicate = "WHERE lease_id = ? AND state = ? AND state_version = ?"; }],
    ["lease-snapshot-version", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "leases"); table.checks = table.checks.filter((entry: string) => !entry.includes("rickgent.lease-snapshot.v1")); }],
    ["oracle-mutable-snapshot-reference", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "oracle_input_references"); table.foreign_keys = table.foreign_keys.filter((entry: any) => entry.columns[0] !== "lease_snapshot_evidence_id"); }],
    ["oracle-scope-foreign-key", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "oracle_input_references"); table.foreign_keys = table.foreign_keys.filter((entry: any) => entry.columns.length !== 4); }],
    ["oracle-attempt-idempotency", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "oracle_decisions"); table.unique_constraints = table.unique_constraints.filter((entry: any) => entry.name !== "oracle_decisions_attempt_idempotency_uq"); }],
    ["promotion-scope-foreign-key", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "promotion_intents"); table.foreign_keys = table.foreign_keys.filter((entry: any) => entry.references !== "oracle_decisions(oracle_decision_id,run_id,ticket_instance_id,attempt_id)"); }],
    ["promotion-ticket-retry", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const constraint = draft.entity_model.catalog.find((entry: any) => entry.name === "promotion_intents").unique_constraints.find((entry: any) => entry.name === "promotion_intents_ticket_inflight_uq"); delete constraint.where; }],
    ["delivery-failure-observation-nullability", "STATE_CONTRACT_TABLE_INVALID", (draft) => { draft.entity_model.catalog.find((entry: any) => entry.name === "delivery_records").columns.pr_observation_id = "canonical_id"; }],
    ["delivery-failure-state-matrix", "STATE_CONTRACT_TABLE_INVALID", (draft) => { const table = draft.entity_model.catalog.find((entry: any) => entry.name === "delivery_records"); table.checks = table.checks.filter((entry: string) => !entry.includes("delivery_failed from intent_recorded")); }],
    ["attempt-state", "STATE_CONTRACT_GRAPH_INVALID", (draft) => { draft.state_machines.attempt.states.pop(); }],
    ["ticket-ready-owner", "STATE_CONTRACT_GRAPH_INVALID", (draft) => { draft.state_machines.ticket.edges.find((edge: any) => edge.to === "ready_for_delivery").owner = "worker"; }],
    ["forbidden-writer", "STATE_CONTRACT_ORACLE_INVALID", (draft) => { draft.oracle.forbidden_terminal_writers.pop(); }],
    ["required-gate", "STATE_CONTRACT_ORACLE_INVALID", (draft) => { draft.oracle.required_gate_green_statuses = ["passed", "skipped"]; }],
    ["oracle-purity", "STATE_CONTRACT_ORACLE_INVALID", (draft) => { draft.oracle.reads_live_files = true; }],
    ["oracle-reference", "STATE_CONTRACT_ORACLE_INVALID", (draft) => { draft.oracle.reference_kinds.pop(); }],
    ["promotion-intent", "STATE_CONTRACT_PROMOTION_INVALID", (draft) => { draft.promotion.one_inflight_intent_per_run = false; }],
    ["update-ref-repository", "STATE_CONTRACT_PROMOTION_INVALID", (draft) => { draft.promotion.git_update_ref_command.splice(1, 2); }],
    ["promotion-conflict-attempt", "STATE_CONTRACT_PROMOTION_INVALID", (draft) => { draft.promotion.conflicted_retry_requires_new_attempt = false; }],
    ["promotion-chain", "STATE_CONTRACT_PROMOTION_INVALID", (draft) => { draft.promotion.sequence_rule = "unordered"; }],
    ["independent-observation", "STATE_CONTRACT_PROMOTION_INVALID", (draft) => { draft.promotion.observation.third_oid = "success"; }],
    ["ready-vs-delivered", "STATE_CONTRACT_DELIVERY_INVALID", (draft) => { draft.delivery.ready_for_delivery = "remote delivery"; }],
    ["legacy-terminal-import", "STATE_CONTRACT_LEGACY_INVALID", (draft) => { draft.legacy.terminal_import_allowed = true; }],
    ["legacy-dual-write", "STATE_CONTRACT_LEGACY_INVALID", (draft) => { draft.legacy.long_lived_dual_write_allowed = true; }],
    ["reserved-capability", "STATE_CONTRACT_CAPABILITY_INVALID", (draft) => { draft.capability_reservations.at(-1).status = "implemented"; }],
    ["resource-reservation", "STATE_CONTRACT_RESOURCE_INVALID", (draft) => { draft.resource_identity.reserve_before_side_effect = false; }],
  ];

  it.each(cases)("rejects %s drift after digest recomputation", (name, expectedCode, mutate) => {
    const result = validateMutation(name, mutate);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^${expectedCode}:`));
    expect(result.stderr).not.toContain("STATE_CONTRACT_DIGEST_MISMATCH");
  });
});
