import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  INITIAL_STATE_MIGRATION_CHECKSUM,
  INITIAL_STATE_SCHEMA_OBJECTS,
  INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM,
  LATEST_STATE_SCHEMA_VERSION,
  STATE_MIGRATIONS,
} from "../../src/state/migrations.js";
import { STATE_TABLES } from "../../src/state/schema.js";
import {
  StateStoreError,
  openStateStore,
  resolveStateLocation,
  type StateRowInput,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const FIXED_TIME = "2026-07-16T12:00:00.000Z";
const childFixture = join(import.meta.dirname, "../fixtures/state-store/child.mjs");
const scratchRoots = new Set<string>();
const childProcesses = new Set<ChildProcess>();

afterEach(() => {
  for (const child of childProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  childProcesses.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function oid(character: string): string {
  return character.repeat(40);
}

function makeRepo(name = "repo"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-state-store-")));
  scratchRoots.add(root);
  const repo = join(root, name);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "State Store Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "state-store@example.test"]);
  writeFileSync(join(repo, "README.md"), `${name}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function openRaw(path: string, readOnly = false): DatabaseSync {
  return new DatabaseSync(path, {
    readOnly,
    enableForeignKeyConstraints: true,
    timeout: 1_000,
  });
}

function insert(database: DatabaseSync, table: string, row: Readonly<Record<string, SqlValue>>): void {
  const columns = Object.keys(row);
  database.prepare(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column] ?? null));
}

function queryOne(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  const database = openRaw(databasePath, true);
  try {
    return database.prepare(sql).get(...values) as SqlRow | undefined;
  } finally {
    database.close();
  }
}

function count(databasePath: string, table: string, where = "", ...values: SqlValue[]): number {
  const row = queryOne(databasePath, `SELECT count(*) AS count FROM "${table}" ${where}`, ...values);
  return Number(row?.count ?? -1);
}

function expectStateError(action: () => unknown, code: string): StateStoreError {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(StateStoreError);
  expect(captured).toMatchObject({ code });
  return captured as StateStoreError;
}

interface FileSnapshot {
  readonly bytes: Buffer;
  readonly mode: number;
}

function snapshotFile(path: string): FileSnapshot {
  return { bytes: readFileSync(path), mode: mode(path) };
}

function expectFileUnchanged(path: string, snapshot: FileSnapshot): void {
  expect(readFileSync(path)).toEqual(snapshot.bytes);
  expect(mode(path)).toBe(snapshot.mode);
}

function createExistingFile(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function sqliteSchemaChecksum(database: DatabaseSync): string {
  const rows = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  return digest(JSON.stringify(rows));
}

interface Lineage {
  readonly runId: string;
  readonly ticketInstanceId: string;
  readonly attemptId: string;
  readonly contextId: string;
  readonly contextDigest: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}

function seedLineage(store: StateStore, label: string, sequence: number): Lineage {
  const manifestJson = JSON.stringify({ lineage: label, type: "manifest" });
  const manifestDigest = digest(manifestJson);
  const contractJson = JSON.stringify({ lineage: label, type: "contract" });
  const contractDigest = digest(contractJson);
  const capabilityDigest = digest(`capability:${label}`);
  const runId = `run-${label}`;
  const ticketId = `ticket-${label}`;
  const ticketInstanceId = `ticket-instance-${label}`;
  const attemptId = `attempt-${label}`;
  const contextId = `context-${label}`;

  store.recordRunManifest({
    manifest_digest: manifestDigest,
    schema_version: "rickgent.run-manifest.v1",
    canonical_manifest_json: manifestJson,
    capability_snapshot_digest: capabilityDigest,
    context_schema_version: "rickgent.context.v1",
    oracle_version: "rickgent.oracle.v1",
    created_at: FIXED_TIME,
  });
  store.recordTicketContract({
    contract_digest: contractDigest,
    schema_version: "rickgent.ticket-contract.v1",
    canonical_contract_json: contractJson,
    created_at: FIXED_TIME,
  });

  const database = openRaw(store.location.databasePath);
  try {
    insert(database, "runs", {
      run_id: runId,
      repository_id: store.location.repositoryId,
      run_sequence: sequence,
      manifest_digest: manifestDigest,
      initial_delivery_oid: oid(String(sequence)),
      delivery_ref: `refs/rickgent/runs/${runId}/delivery`,
      state: "planned",
      state_version: 0,
      current_delivery_oid: oid(String(sequence)),
      promotion_sequence: 0,
      created_at: FIXED_TIME,
    });
    insert(database, "run_tickets", {
      ticket_instance_id: ticketInstanceId,
      run_id: runId,
      ticket_id: ticketId,
      plan_index: 0,
      contract_digest: contractDigest,
      state: "planned",
      state_version: 0,
      created_at: FIXED_TIME,
    });
    insert(database, "attempts", {
      attempt_id: attemptId,
      ticket_instance_id: ticketInstanceId,
      run_id: runId,
      ticket_id: ticketId,
      attempt_number: 1,
      contract_digest: contractDigest,
      allocation_owner_digest: digest(`allocation:${label}`),
      delivery_baseline_oid: oid(String(sequence)),
      context_schema_version: "rickgent.context.v1",
      oracle_version: "rickgent.oracle.v1",
      capability_snapshot_digest: capabilityDigest,
      resource_identity_version: "rickgent.resource-identity.v1",
      state: "planned",
      state_version: 0,
      created_at: FIXED_TIME,
    });
  } finally {
    database.close();
  }

  const contextJson = JSON.stringify({ lineage: label, type: "context" });
  const contextDigest = digest(contextJson);
  const phaseExecutionId = `phase-${label}`;
  const phaseDatabase = openRaw(store.location.databasePath);
  try {
    insert(phaseDatabase, "execution_contexts", {
      context_id: contextId,
      context_digest: contextDigest,
      attempt_id: attemptId,
      phase: "implement",
      phase_ordinal: 0,
      role: "worker",
      canonical_context_json: contextJson,
      contract_digest: contractDigest,
      capability_snapshot_digest: capabilityDigest,
      policy_bundle_digest: digest(`policy:${label}`),
      model_selection_digest: digest(`model:${label}`),
      budget_digest: digest(`budget:${label}`),
      scope_digest: digest(`scope:${label}`),
      context_schema_version: "rickgent.context.v1",
      oracle_version: "rickgent.oracle.v1",
      created_at: FIXED_TIME,
    });
    insert(phaseDatabase, "phase_executions", {
      phase_execution_id: phaseExecutionId,
      attempt_id: attemptId,
      context_id: contextId,
      phase: "implement",
      phase_ordinal: 0,
      role: "worker",
      identity_digest: digest(`phase:${label}`),
      created_at: FIXED_TIME,
    });
  } finally {
    phaseDatabase.close();
  }

  const evidenceJson = JSON.stringify({ lineage: label, type: "evidence" });
  const evidenceDigest = digest(evidenceJson);
  const evidenceId = `evidence-${label}`;
  store.appendEvidence({
    evidence_id: evidenceId,
    attempt_id: attemptId,
    phase_execution_id: phaseExecutionId,
    context_id: contextId,
    producer_service: "state-store-test",
    scope: `lineage:${label}`,
    schema_version: "rickgent.test-evidence.v1",
    content_digest: evidenceDigest,
    inline_payload_json: evidenceJson,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence:${label}`,
    created_at: FIXED_TIME,
  });

  return { runId, ticketInstanceId, attemptId, contextId, contextDigest, evidenceId, evidenceDigest };
}

function transition(lineage: Lineage, id: string): StateRowInput {
  return {
    transition_id: id,
    run_id: null,
    ticket_instance_id: null,
    attempt_id: lineage.attemptId,
    entity_sequence: 1,
    from_state: "planned",
    to_state: "implementing",
    owner_service: "state-store-test",
    owner_context_digest: lineage.contextDigest,
    input_digest: digest(`transition-input:${id}`),
    idempotency_key: `transition:${id}`,
    created_at: FIXED_TIME,
  };
}

function spawnFixture(command: string, repoPath: string): ChildProcess {
  const child = fork(childFixture, [command, repoPath], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  childProcesses.add(child);
  return child;
}

function releaseLockChild(child: ChildProcess): void {
  if (!child.connected || child.exitCode !== null || child.signalCode !== null) return;
  child.send("release", () => {
    // The fixture may exit immediately after acknowledging release. A closed
    // IPC channel is equivalent to successful cleanup here.
  });
}

function waitForMessage(child: ChildProcess, type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`state-store fixture timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record.type === "error") {
        cleanup();
        reject(new Error(`state-store fixture failed: ${String(record.code ?? record.message)}`));
      } else if (record.type === type) {
        cleanup();
        resolve(record);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`state-store fixture exited before ${type}: ${String(code ?? signal)}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(`state-store fixture exited ${child.exitCode}`));
  }
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      childProcesses.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`state-store fixture exited ${String(code ?? signal)}`));
    });
  });
}

async function openInChild(repoPath: string): Promise<Record<string, unknown>> {
  const child = spawnFixture("open", repoPath);
  const [opened] = await Promise.all([
    waitForMessage(child, "opened"),
    waitForSuccessfulExit(child),
  ]);
  return opened;
}

describe("durable state-store bootstrap and preservation", () => {
  it("creates and reopens the exact released schema and canonical repository row", () => {
    const repo = makeRepo();
    const expectedLocation = resolveStateLocation(repo);
    const store = openStateStore({ repoPath: repo });
    expect(store.location).toEqual(expectedLocation);
    expect(store.schemaVersion).toBe(LATEST_STATE_SCHEMA_VERSION);
    expect(mode(store.location.stateDirectory)).toBe(0o700);
    expect(mode(store.location.resourceDirectory)).toBe(0o700);
    expect(mode(store.location.databasePath)).toBe(0o600);
    store.verifyIntegrity();

    const database = openRaw(store.location.databasePath, true);
    let originalRepository: SqlRow;
    try {
      const schemaRows = database.prepare(
        "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      ).all() as Array<{ type: string; name: string }>;
      const names = (type: string) => schemaRows.filter((row) => row.type === type).map((row) => row.name).sort();
      expect(names("table")).toEqual([...INITIAL_STATE_SCHEMA_OBJECTS.tables].sort());
      expect(names("index")).toEqual([...INITIAL_STATE_SCHEMA_OBJECTS.indexes].sort());
      expect(names("trigger")).toEqual([...INITIAL_STATE_SCHEMA_OBJECTS.triggers].sort());
      expect(names("table")).toEqual([...STATE_TABLES].sort());

      const tableRows = database.prepare("PRAGMA table_list").all() as Array<{ name: string; strict: number }>;
      const strict = new Map(tableRows.map((row) => [row.name, row.strict]));
      expect(STATE_TABLES.every((table) => strict.get(table) === 1)).toBe(true);
      expect(sqliteSchemaChecksum(database)).toBe(INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: LATEST_STATE_SCHEMA_VERSION });
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("SELECT version, name, checksum FROM schema_migrations").get()).toEqual({
        version: 1,
        name: STATE_MIGRATIONS[0]?.name,
        checksum: INITIAL_STATE_MIGRATION_CHECKSUM,
      });

      originalRepository = database.prepare("SELECT * FROM repositories").get() as SqlRow;
      expect(originalRepository).toMatchObject({
        repository_id: store.location.repositoryId,
        repo_realpath: store.location.repoRealpath,
        git_common_dir_realpath: store.location.gitCommonDirRealpath,
        object_format: store.location.objectFormat,
        state_directory: store.location.stateDirectory,
        identity_digest: store.location.identityDigest,
      });
      expect(String(originalRepository.created_at)).toMatch(/Z$/);
    } finally {
      database.close();
      store.close();
    }

    const reopened = openStateStore({ repoPath: repo });
    try {
      expect(reopened.location).toEqual(expectedLocation);
      expect(count(reopened.location.databasePath, "schema_migrations")).toBe(1);
      expect(count(reopened.location.databasePath, "repositories")).toBe(1);
      expect(queryOne(reopened.location.databasePath, "SELECT * FROM repositories")).toEqual(originalRepository!);
      reopened.verifyIntegrity();
    } finally {
      reopened.close();
    }
  });

  it.each([
    { name: "zero-byte", expectedCode: "RICKGENT_STATE_CORRUPT" },
    { name: "random-byte", expectedCode: "RICKGENT_STATE_CORRUPT" },
    { name: "future-version", expectedCode: "RICKGENT_STATE_SCHEMA_FUTURE" },
    { name: "schema-drift", expectedCode: "RICKGENT_STATE_CORRUPT" },
  ])("rejects and preserves an existing $name database", ({ name, expectedCode }) => {
    const repo = makeRepo(name);
    const location = resolveStateLocation(repo);
    if (name === "zero-byte" || name === "random-byte") {
      mkdirSync(location.stateDirectory, { mode: 0o700 });
      createExistingFile(location.databasePath, name === "zero-byte" ? Buffer.alloc(0) : randomBytes(4096));
    } else {
      const healthy = openStateStore({ repoPath: repo });
      healthy.close();
      const database = openRaw(location.databasePath);
      try {
        if (name === "future-version") database.exec(`PRAGMA user_version = ${LATEST_STATE_SCHEMA_VERSION + 1}`);
        else database.exec("CREATE TABLE schema_drift (value TEXT) STRICT");
      } finally {
        database.close();
      }
    }

    const databaseSnapshot = snapshotFile(location.databasePath);
    const sidecars = [location.walPath, location.shmPath, location.journalPath]
      .filter((path) => existsSync(path))
      .map((path) => [path, snapshotFile(path)] as const);
    const error = expectStateError(() => openStateStore({ repoPath: repo }), expectedCode);
    expect(error.databasePath).toBe(location.databasePath);
    expectFileUnchanged(location.databasePath, databaseSnapshot);
    for (const [path, snapshot] of sidecars) expectFileUnchanged(path, snapshot);
    expect(existsSync(location.journalPath)).toBe(false);
  });

  it("selects repository A even when cwd and legacy environment point at repository B", () => {
    const repoA = makeRepo("repo-a");
    const repoB = makeRepo("repo-b");
    const previousCwd = process.cwd();
    const previousLegacyRoot = process.env.RICKGENT_DIR;
    const hostileRoot = join(repoB, "hostile-state-root");
    let store: StateStore | undefined;
    try {
      process.chdir(repoB);
      process.env.RICKGENT_DIR = hostileRoot;
      store = openStateStore({ repoPath: repoA });
      expect(store.location.repoRealpath).toBe(repoA);
      expect(store.location.databasePath.startsWith(join(repoA, ".git"))).toBe(true);
      expect(existsSync(resolveStateLocation(repoB).databasePath)).toBe(false);
      expect(existsSync(hostileRoot)).toBe(false);
    } finally {
      store?.close();
      process.chdir(previousCwd);
      if (previousLegacyRoot === undefined) delete process.env.RICKGENT_DIR;
      else process.env.RICKGENT_DIR = previousLegacyRoot;
    }
  });

  it("enforces private modes for the database and SQLite sidecars without repairing unsafe paths", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    try {
      expect(mode(store.location.stateDirectory)).toBe(0o700);
      expect(mode(store.location.resourceDirectory)).toBe(0o700);
      expect(mode(store.location.databasePath)).toBe(0o600);
      expect(existsSync(store.location.walPath)).toBe(true);
      expect(existsSync(store.location.shmPath)).toBe(true);
      expect(mode(store.location.walPath)).toBe(0o600);
      expect(mode(store.location.shmPath)).toBe(0o600);

      chmodSync(store.location.walPath, 0o644);
      expectStateError(() => openStateStore({ repoPath: repo }), "RICKGENT_STATE_ROOT_UNSAFE");
      expect(mode(store.location.walPath)).toBe(0o644);
      chmodSync(store.location.walPath, 0o600);
    } finally {
      store.close();
    }

    chmodSync(store.location.databasePath, 0o644);
    expectStateError(() => openStateStore({ repoPath: repo }), "RICKGENT_STATE_ROOT_UNSAFE");
    expect(mode(store.location.databasePath)).toBe(0o644);
  });

  it("rejects a symlinked canonical database without touching its target", () => {
    const repo = makeRepo();
    const location = resolveStateLocation(repo);
    mkdirSync(location.stateDirectory, { mode: 0o700 });
    const target = join(repo, "outside.sqlite3");
    createExistingFile(target, randomBytes(512));
    const targetSnapshot = snapshotFile(target);
    symlinkSync(target, location.databasePath);

    expectStateError(() => openStateStore({ repoPath: repo }), "RICKGENT_STATE_ROOT_UNSAFE");
    expect(lstatSync(location.databasePath).isSymbolicLink()).toBe(true);
    expectFileUnchanged(target, targetSnapshot);
  });
});

describe("durable state-store transaction and lineage guarantees", () => {
  it("is idempotent for identical immutable input and conflicts on divergent input", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    try {
      const json = JSON.stringify({ idempotency: "same" });
      const row = {
        manifest_digest: digest(json),
        schema_version: "rickgent.run-manifest.v1",
        canonical_manifest_json: json,
        capability_snapshot_digest: digest("capability:same"),
        context_schema_version: "rickgent.context.v1",
        oracle_version: "rickgent.oracle.v1",
        created_at: FIXED_TIME,
      } as const;
      expect(store.recordRunManifest(row)).toEqual(row);
      expect(store.recordRunManifest(row)).toEqual(row);
      const error = expectStateError(
        () => store.recordRunManifest({ ...row, capability_snapshot_digest: digest("capability:different") }),
        "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
      );
      expect(error.failureClass).toBe("input_contract");
      expect(count(store.location.databasePath, "run_manifests")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rolls back a transition and all references when a later reference violates uniqueness", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    try {
      const lineage = seedLineage(store, "rollback", 1);
      const transitionId = "transition-rollback";
      const error = expectStateError(
        () => store.appendStateTransition(transition(lineage, transitionId), [
          { transition_id: transitionId, ordinal: 0, purpose: "input", evidence_id: lineage.evidenceId },
          { transition_id: transitionId, ordinal: 1, purpose: "input", evidence_id: lineage.evidenceId },
        ]),
        "RICKGENT_STATE_CONFLICT",
      );
      expect(error.failureClass).toBe("infrastructure");
      expect(count(store.location.databasePath, "state_transitions", "WHERE transition_id = ?", transitionId)).toBe(0);
      expect(count(store.location.databasePath, "transition_evidence_refs", "WHERE transition_id = ?", transitionId)).toBe(0);
      store.verifyIntegrity();
    } finally {
      store.close();
    }
  });

  it("rejects transition and oracle evidence from a different canonical lineage", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    try {
      const lineageA = seedLineage(store, "a", 1);
      const lineageB = seedLineage(store, "b", 2);
      const transitionId = "transition-cross-lineage";
      expectStateError(
        () => store.appendStateTransition(transition(lineageA, transitionId), [
          { transition_id: transitionId, ordinal: 0, purpose: "input", evidence_id: lineageB.evidenceId },
        ]),
        "RICKGENT_STATE_RESUME_INCOMPATIBLE",
      );
      expect(count(store.location.databasePath, "state_transitions", "WHERE transition_id = ?", transitionId)).toBe(0);

      const decisionId = "oracle-cross-lineage";
      expectStateError(
        () => store.persistOracleDecision({
          oracle_decision_id: decisionId,
          oracle_version: "rickgent.oracle.v1",
          scope_kind: "attempt",
          run_id: lineageA.runId,
          ticket_instance_id: lineageA.ticketInstanceId,
          attempt_id: lineageA.attemptId,
          input_set_digest: digest("oracle-input-set"),
          result: "accepted",
          reasons_json: "[]",
          output_digest: digest("oracle-output"),
          idempotency_key: "oracle:cross-lineage",
          created_at: FIXED_TIME,
        }, [{
          oracle_decision_id: decisionId,
          run_id: lineageA.runId,
          ticket_instance_id: lineageA.ticketInstanceId,
          attempt_id: lineageA.attemptId,
          ordinal: 0,
          reference_kind: "evidence",
          run_manifest_digest: null,
          contract_digest: null,
          context_id: null,
          evidence_id: lineageB.evidenceId,
          gate_result_id: null,
          review_record_id: null,
          commit_attribution_id: null,
          cleanup_record_id: null,
          dependency_digest: null,
          resource_snapshot_evidence_id: null,
          lease_snapshot_evidence_id: null,
          process_receipt_id: null,
          content_digest: lineageB.evidenceDigest,
        }]),
        "RICKGENT_STATE_RESUME_INCOMPATIBLE",
      );
      expect(count(store.location.databasePath, "oracle_decisions", "WHERE oracle_decision_id = ?", decisionId)).toBe(0);
      expect(count(store.location.databasePath, "oracle_input_references", "WHERE oracle_decision_id = ?", decisionId)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("returns bounded BUSY from a real competing writer and succeeds after release", async () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    const child = spawnFixture("hold-write-lock", repo);
    try {
      await waitForMessage(child, "locked");
      const json = JSON.stringify({ busy: "retry" });
      const row = {
        manifest_digest: digest(json),
        schema_version: "rickgent.run-manifest.v1",
        canonical_manifest_json: json,
        capability_snapshot_digest: digest("busy-capability"),
        context_schema_version: "rickgent.context.v1",
        oracle_version: "rickgent.oracle.v1",
        created_at: FIXED_TIME,
      } as const;
      const started = Date.now();
      const error = expectStateError(() => store.recordRunManifest(row), "RICKGENT_STATE_BUSY");
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(error.failureClass).toBe("infrastructure");
      expect(count(store.location.databasePath, "run_manifests", "WHERE manifest_digest = ?", row.manifest_digest)).toBe(0);

      const released = waitForMessage(child, "released");
      releaseLockChild(child);
      await released;
      expect(store.recordRunManifest(row)).toEqual(row);
      expect(count(store.location.databasePath, "run_manifests", "WHERE manifest_digest = ?", row.manifest_digest)).toBe(1);
    } finally {
      releaseLockChild(child);
      store.close();
    }
  }, 14_000);

  it("publishes one valid database under concurrent first open", async () => {
    const repo = makeRepo();
    const [first, second] = await Promise.all([openInChild(repo), openInChild(repo)]);
    const location = resolveStateLocation(repo);
    expect(first.databasePath).toBe(location.databasePath);
    expect(second.databasePath).toBe(location.databasePath);
    expect(mode(location.databasePath)).toBe(0o600);

    const store = openStateStore({ repoPath: repo });
    try {
      expect(count(location.databasePath, "schema_migrations")).toBe(1);
      expect(count(location.databasePath, "repositories")).toBe(1);
      store.verifyIntegrity();
    } finally {
      store.close();
    }
  });

  it("detects foreign-key corruption during an explicit integrity verification", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    try {
      const database = new DatabaseSync(store.location.databasePath, {
        enableForeignKeyConstraints: false,
        timeout: 1_000,
      });
      try {
        insert(database, "legacy_artifacts", {
          legacy_artifact_id: "orphaned-legacy-artifact",
          repository_id: "missing-repository",
          kind: "test-corruption",
          bounded_path_identity: "missing/path",
          stat_digest: null,
          content_digest: null,
          discovered_at: FIXED_TIME,
          disposition: "quarantined",
        });
      } finally {
        database.close();
      }
      expectStateError(() => store.verifyIntegrity(), "RICKGENT_STATE_CORRUPT");
    } finally {
      store.close();
    }
  });
});
