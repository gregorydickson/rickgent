import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/contracts/ticket-contract.js";
import {
  provisionAttemptWorkspace,
  type AttemptWorkspaceSpawnAuthorization,
} from "../../src/git/attempt-workspace.js";
import {
  ProcessSupervisor,
  type ProcessSupervisorResult,
  type SupervisedProcessRequest,
} from "../../src/process/supervisor.js";
import {
  PosixProcessController,
  type PosixProcessIdentity,
  type ProcessDeathObservation,
  type ProcessLivenessObservation,
  type ProcessSignalObservation,
  type TrackedSignalResult,
} from "../../src/process/posix.js";
import {
  LeaseAuthority,
  type AttemptOwnershipGrant,
} from "../../src/state/leases.js";
import {
  openStateStore,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

interface CorpusFixture {
  readonly root: string;
  readonly repo: string;
  readonly reports: string;
  readonly store: StateStore;
  readonly authority: LeaseAuthority;
  readonly supervisor: ProcessSupervisor;
  readonly attemptId: string;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly contextDigest: `sha256:${string}`;
  readonly ownership: AttemptOwnershipGrant;
  readonly authorization: AttemptWorkspaceSpawnAuthorization;
}

const roots = new Set<string>();
const survivorPids = new Set<number>();
const stubbornFixture = join(import.meta.dirname, "../fixtures/process-supervisor/stubborn-tree.mjs");
const floodFixture = join(import.meta.dirname, "../fixtures/process-supervisor/output-flood.mjs");
let fixtureOrdinal = 0;

class UnprovableTerminationController extends PosixProcessController {
  rootPid: number | null = null;

  override trackRoot(identity: PosixProcessIdentity): void {
    this.rootPid = identity.pid;
    super.trackRoot(identity);
  }

  override signalGroup(pgid: number, signal: NodeJS.Signals): ProcessSignalObservation {
    return Object.freeze({
      delivered: null,
      target: "group",
      targetId: pgid,
      signal,
      reason: "unprovable",
      errorCode: "EPERM",
      observedAt: new Date().toISOString(),
    });
  }

  override signalTrackedPids(): TrackedSignalResult {
    return Object.freeze({
      complete: false,
      observations: Object.freeze([]),
      reason: "tracked PID signaling was unprovable (EPERM)",
    });
  }

  override observeGroup(): ProcessLivenessObservation {
    return Object.freeze({
      alive: null,
      reason: "unprovable",
      errorCode: "EPERM",
      observedAt: new Date().toISOString(),
      identity: null,
    });
  }

  override async waitForDeath(): Promise<ProcessDeathObservation> {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return Object.freeze({
      groupDead: false,
      proofBasis: "sampled_tracked_identities",
      trackedIdentitiesConfirmedDead: false,
      descendantsConfirmedDead: false,
      trackedDescendants: Object.freeze([]),
      observedAt: new Date().toISOString(),
      reason: "group death was unprovable (EPERM)",
    });
  }
}

class MisleadingSampledDeathController extends PosixProcessController {
  override async waitForDeath(pgid: number, timeoutMs: number): Promise<ProcessDeathObservation> {
    const observation = await super.waitForDeath(pgid, timeoutMs);
    return Object.freeze({
      ...observation,
      proofBasis: "sampled_tracked_identities",
      descendantsConfirmedDead: true,
      reason: "sampled polling incorrectly claimed authoritative descendant death",
    });
  }
}

afterEach(() => {
  for (const pid of survivorPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead is the expected cleanup result.
    }
  }
  survivorPids.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function insert(database: DatabaseSync, table: string, row: SqlRow): void {
  const columns = Object.keys(row);
  database.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  ).run(...columns.map((column) => row[column] ?? null));
}

function all(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function one(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow {
  const row = all(databasePath, sql, ...values)[0];
  if (row === undefined) throw new Error(`expected one row for query: ${sql}`);
  return row;
}

function makeCorpusFixture(label: string, processes?: PosixProcessController): CorpusFixture {
  const ordinal = ++fixtureOrdinal;
  const identity = `${label}-${ordinal}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-process-supervisor-")));
  roots.add(root);
  const repo = join(root, "repo");
  const reports = join(root, "reports");
  mkdirSync(repo, { mode: 0o700 });
  mkdirSync(reports, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.name", "Process Supervisor Corpus");
  git(repo, "config", "user.email", "process-supervisor@example.test");
  writeFileSync(join(repo, "README.md"), "process supervisor corpus\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");

  const store = openStateStore({ repoPath: repo });
  const runId = `run-${identity}`;
  const ticketInstanceId = `ticket-instance-${identity}`;
  const ticketId = `ticket-${identity}`;
  const attemptId = `attempt-${identity}`;
  const contextId = `context-${identity}`;
  const phaseExecutionId = `phase-${identity}`;
  const now = new Date().toISOString();
  const baselineOid = git(repo, "rev-parse", "HEAD");
  const manifestJson = canonicalJson({ schema_version: "rickgent.test-run/v1", identity });
  const manifestDigest = sha256(manifestJson);
  const contractJson = canonicalJson({ schema_version: "rickgent.test-ticket/v1", identity });
  const contractDigest = sha256(contractJson);
  const capabilityDigest = sha256(`capability:${identity}`);
  const contextJson = canonicalJson({
    schema_version: "rickgent.execution-context/v1",
    attempt_id: attemptId,
    phase: "implement",
    phase_ordinal: 0,
    role: "worker",
    corpus_identity: identity,
  });
  const contextDigest = sha256(contextJson);

  store.recordRunManifest({
    manifest_digest: manifestDigest,
    schema_version: "rickgent.test-run/v1",
    canonical_manifest_json: manifestJson,
    capability_snapshot_digest: capabilityDigest,
    context_schema_version: "rickgent.execution-context/v1",
    oracle_version: "rickgent.oracle.v1",
    created_at: now,
  });
  store.recordTicketContract({
    contract_digest: contractDigest,
    schema_version: "rickgent.test-ticket/v1",
    canonical_contract_json: contractJson,
    created_at: now,
  });
  const database = new DatabaseSync(store.location.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    insert(database, "runs", {
      run_id: runId,
      repository_id: store.location.repositoryId,
      run_sequence: ordinal,
      manifest_digest: manifestDigest,
      initial_delivery_oid: baselineOid,
      delivery_ref: `refs/rickgent/runs/${runId}/delivery`,
      state: "active",
      state_version: 1,
      current_delivery_oid: baselineOid,
      promotion_sequence: 0,
      created_at: now,
    });
    insert(database, "run_tickets", {
      ticket_instance_id: ticketInstanceId,
      run_id: runId,
      ticket_id: ticketId,
      plan_index: 0,
      contract_digest: contractDigest,
      state: "active",
      state_version: 1,
      created_at: now,
    });
    insert(database, "attempts", {
      attempt_id: attemptId,
      ticket_instance_id: ticketInstanceId,
      run_id: runId,
      ticket_id: ticketId,
      attempt_number: 1,
      contract_digest: contractDigest,
      allocation_owner_digest: sha256(`allocation:${identity}`),
      delivery_baseline_oid: baselineOid,
      context_schema_version: "rickgent.execution-context/v1",
      oracle_version: "rickgent.oracle.v1",
      capability_snapshot_digest: capabilityDigest,
      resource_identity_version: "rickgent.attempt-resource-identity/v1",
      state: "planned",
      state_version: 0,
      created_at: now,
    });
    insert(database, "execution_contexts", {
      context_id: contextId,
      context_digest: contextDigest,
      attempt_id: attemptId,
      phase: "implement",
      phase_ordinal: 0,
      role: "worker",
      canonical_context_json: contextJson,
      contract_digest: contractDigest,
      capability_snapshot_digest: capabilityDigest,
      policy_bundle_digest: sha256(`policy:${identity}`),
      model_selection_digest: sha256(`model:${identity}`),
      budget_digest: sha256(`budget:${identity}`),
      scope_digest: sha256(`scope:${identity}`),
      context_schema_version: "rickgent.execution-context/v1",
      oracle_version: "rickgent.oracle.v1",
      created_at: now,
    });
    insert(database, "phase_executions", {
      phase_execution_id: phaseExecutionId,
      attempt_id: attemptId,
      context_id: contextId,
      phase: "implement",
      phase_ordinal: 0,
      role: "worker",
      identity_digest: sha256(`phase:${identity}`),
      created_at: now,
    });
  } finally {
    database.close();
  }

  const authority = new LeaseAuthority(store);
  const acquired = authority.acquire(authority.prepareAcquisition({
    attemptId,
    idempotencyKey: `acquire:${identity}`,
    ttlMs: 60_000,
  }));
  const provisioned = provisionAttemptWorkspace(authority, acquired);
  if (!provisioned.ok) {
    store.close();
    throw new Error(`${provisioned.code}: ${provisioned.detail}`);
  }
  return {
    root,
    repo,
    reports,
    store,
    authority,
    supervisor: new ProcessSupervisor(store, authority, processes),
    attemptId,
    phaseExecutionId,
    contextId,
    contextDigest,
    ownership: provisioned.workspace.ownership,
    authorization: provisioned.authorization,
  };
}

async function usingFixture(
  label: string,
  run: (fixture: CorpusFixture) => Promise<void>,
  processes?: PosixProcessController,
): Promise<void> {
  const fixture = makeCorpusFixture(label, processes);
  try {
    await run(fixture);
  } finally {
    fixture.store.close();
  }
}

function request(
  fixture: CorpusFixture,
  argv: readonly [string, ...string[]],
  overrides: Partial<SupervisedProcessRequest> = {},
): SupervisedProcessRequest {
  return {
    ownership: fixture.ownership,
    authorization: fixture.authorization,
    phase: {
      phaseExecutionId: fixture.phaseExecutionId,
      contextId: fixture.contextId,
      contextDigest: fixture.contextDigest,
    },
    argv,
    environment: {},
    allowedEnvironmentKeys: [],
    timeoutMs: 5_000,
    terminationGraceMs: 120,
    deathObservationMs: 500,
    outputLimitBytes: 8_192,
    tailLimitBytes: 1_024,
    ...overrides,
  };
}

function reportDirectory(fixture: CorpusFixture, name: string): string {
  const path = join(fixture.reports, name);
  mkdirSync(path, { mode: 0o700 });
  return realpathSync(path);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readEvents(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertCleanupPending(fixture: CorpusFixture, result: ProcessSupervisorResult): void {
  expect(result.ownership.ownership.state).toBe("cleanup_pending");
  expect(result.ownership.resources.every((resource) => resource.state === "cleanup_pending")).toBe(true);
  expect(all(
    fixture.store.location.databasePath,
    "SELECT state FROM attempt_ownership_leases WHERE attempt_id = ?",
    fixture.attemptId,
  )).toEqual([{ state: "cleanup_pending" }]);
  expect(all(
    fixture.store.location.databasePath,
    "SELECT DISTINCT state FROM attempt_resource_claims WHERE attempt_id = ?",
    fixture.attemptId,
  )).toEqual([{ state: "cleanup_pending" }]);
}

function assertDurableTerminal(
  fixture: CorpusFixture,
  result: ProcessSupervisorResult,
): { readonly launch: SqlRow; readonly terminal: SqlRow; readonly observations: readonly SqlRow[] } {
  expect(result.launchId).not.toBeNull();
  expect(result.processReceiptId).not.toBeNull();
  const launch = one(
    fixture.store.location.databasePath,
    "SELECT * FROM attempt_process_launches WHERE launch_id = ?",
    result.launchId,
  );
  expect(launch).toMatchObject({
    process_receipt_id: result.processReceiptId,
    attempt_id: fixture.attemptId,
    ownership_id: fixture.ownership.ownership.ownershipId,
    owner_generation: fixture.ownership.ownership.generation,
    ownership_context_digest: fixture.ownership.ownership.contextDigest,
    phase_execution_id: fixture.phaseExecutionId,
    context_id: fixture.contextId,
    execution_context_digest: fixture.contextDigest,
    pid: result.pid,
    pgid: result.pgid,
  });
  const launchEvidence = one(
    fixture.store.location.databasePath,
    "SELECT * FROM evidence WHERE evidence_id = ?",
    launch.launch_evidence_id,
  );
  expect(launchEvidence).toMatchObject({
    attempt_id: fixture.attemptId,
    phase_execution_id: fixture.phaseExecutionId,
    context_id: fixture.contextId,
    producer_service: "ProcessSupervisor",
    schema_version: "rickgent.process-launch.v1",
  });
  expect(sha256(String(launchEvidence.inline_payload_json))).toBe(launchEvidence.content_digest);

  const terminal = one(
    fixture.store.location.databasePath,
    "SELECT * FROM attempt_process_terminal_receipts WHERE process_receipt_id = ?",
    result.processReceiptId,
  );
  expect(terminal).toMatchObject({
    launch_id: result.launchId,
    attempt_id: fixture.attemptId,
    outcome: result.outcome,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut ? 1 : 0,
    group_dead: result.groupDead ? 1 : 0,
    descendants_confirmed_dead: result.descendantsConfirmedDead ? 1 : 0,
  });
  const observations = all(fixture.store.location.databasePath, `
    SELECT o.*, e.inline_payload_json, e.content_digest
    FROM attempt_process_observations o
    JOIN evidence e ON e.evidence_id = o.evidence_id
    WHERE o.launch_id = ?
    ORDER BY o.sequence
  `, result.launchId);
  expect(observations).toHaveLength(Number(terminal.observation_count));
  expect(observations.map((row) => row.sequence)).toEqual(
    Array.from({ length: observations.length }, (_, index) => index + 1),
  );
  for (const observation of observations) {
    expect(sha256(String(observation.inline_payload_json))).toBe(observation.payload_digest);
    expect(observation.content_digest).toBe(observation.payload_digest);
  }
  expect(observations.some((row) => row.kind === "group_death")).toBe(
    result.groupDead,
  );
  const groupDeath = observations.find((row) => row.kind === "group_death");
  if (groupDeath !== undefined) {
    const payload = JSON.parse(String(groupDeath.inline_payload_json)) as Record<string, unknown>;
    expect(["sampled_tracked_identities", "authoritative_containment"]).toContain(payload.proof_basis);
    expect(typeof payload.tracked_identities_confirmed_dead).toBe("boolean");
    if (result.descendantsConfirmedDead) {
      expect(payload).toMatchObject({
        proof_basis: "authoritative_containment",
        tracked_identities_confirmed_dead: true,
      });
    }
  }
  const observationRefs = observations.map((row) => ({
    observation_id: row.observation_id,
    sequence: row.sequence,
    kind: row.kind,
    evidence_id: row.evidence_id,
    schema_version: row.schema_version,
    payload_digest: row.payload_digest,
    created_at: row.created_at,
  }));
  expect(sha256(canonicalJson({
    schema_version: "rickgent.process-terminal.v1",
    launch_id: result.launchId,
    process_receipt_id: result.processReceiptId,
    outcome: result.outcome,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    group_dead: result.groupDead,
    descendants_confirmed_dead: result.descendantsConfirmedDead,
    observation_refs: observationRefs,
    created_at: terminal.created_at,
  }))).toBe(terminal.result_digest);
  return { launch, terminal, observations };
}

function expectedBinary(stream: "stdout" | "stderr", bytes: number): Buffer {
  const value = Buffer.allocUnsafe(bytes);
  const seed = stream === "stdout" ? 0x35 : 0xa7;
  for (let offset = 0; offset < bytes; offset += 1) value[offset] = (seed + offset * 73) & 0xff;
  return value;
}

describe("ProcessSupervisor integration corpus", () => {
  it("persists the launch before target exec, passes only explicit environment, and consumes authorization once", async () => {
    await usingFixture("pre-exec", async (fixture) => {
      const report = join(reportDirectory(fixture, "pre-exec"), "target.json");
      const requestedEnvironment = { EXPLICIT_ONLY: "sealed-value" } as const;
      const probe = String.raw`
const { writeFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1], { readOnly: true });
const phase = process.argv[3];
const rows = database.prepare("SELECT launch_id, phase_execution_id, environment_digest FROM attempt_process_launches WHERE phase_execution_id = ?").all(phase);
database.close();
writeFileSync(process.argv[2], JSON.stringify({ rows, environment: process.env, argv: process.argv }), { flag: "wx", mode: 0o600 });
`;
      const targetRequest = request(fixture, [
        process.execPath,
        "-e",
        probe,
        fixture.store.location.databasePath,
        report,
        fixture.phaseExecutionId,
      ], {
        environment: requestedEnvironment,
        allowedEnvironmentKeys: ["EXPLICIT_ONLY"],
      });
      const ambientKey = "RICKGENT_PROCESS_CORPUS_AMBIENT_SECRET";
      const previousAmbient = process.env[ambientKey];
      process.env[ambientKey] = "must-not-cross-exec";
      let result: ProcessSupervisorResult;
      try {
        result = await fixture.supervisor.run(targetRequest);
      } finally {
        if (previousAmbient === undefined) delete process.env[ambientKey];
        else process.env[ambientKey] = previousAmbient;
      }

      expect(result).toMatchObject({
        outcome: "exit_zero",
        exitCode: 0,
        timedOut: false,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      const target = readJson(report);
      expect(target.rows).toEqual([{
        launch_id: result.launchId,
        phase_execution_id: fixture.phaseExecutionId,
        environment_digest: sha256(canonicalJson(requestedEnvironment)),
      }]);
      const targetEnvironment = target.environment as Record<string, string>;
      expect(Object.fromEntries(
        Object.keys(requestedEnvironment).map((key) => [key, targetEnvironment[key]]),
      )).toEqual(requestedEnvironment);
      expect(targetEnvironment[ambientKey]).toBeUndefined();
      // Darwin's Node/CoreFoundation startup synthesizes this key after
      // execve. The sealed start-gate digest above remains the requested map;
      // no other target-visible key is permitted.
      expect(Object.keys(targetEnvironment).filter((key) => !(key in requestedEnvironment))).toEqual(
        process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [],
      );
      expect(target.argv).toEqual([
        process.execPath,
        fixture.store.location.databasePath,
        report,
        fixture.phaseExecutionId,
      ]);
      const durable = assertDurableTerminal(fixture, result);
      const groupDeath = durable.observations.find((row) => row.kind === "group_death");
      expect(JSON.parse(String(groupDeath?.inline_payload_json))).toMatchObject({
        proof_basis: "sampled_tracked_identities",
        tracked_identities_confirmed_dead: true,
        descendants_confirmed_dead: false,
      });
      assertCleanupPending(fixture, result);

      await expect(fixture.supervisor.run(targetRequest)).rejects.toThrow(
        /already been consumed|ownership is not current and unexpired/,
      );
      expect(all(fixture.store.location.databasePath, "SELECT launch_id FROM attempt_process_launches")).toHaveLength(1);
      expect(all(fixture.store.location.databasePath, "SELECT process_receipt_id FROM attempt_process_terminal_receipts")).toHaveLength(1);
    });
  });

  it("does not promote a sampled death claim into authoritative descendant cleanup proof", async () => {
    await usingFixture("sampled-proof-boundary", async (fixture) => {
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        "-e",
        "process.exit(0)",
      ]));

      expect(result).toMatchObject({
        outcome: "exit_zero",
        exitCode: 0,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      const durable = assertDurableTerminal(fixture, result);
      const groupDeath = durable.observations.find((row) => row.kind === "group_death");
      expect(JSON.parse(String(groupDeath?.inline_payload_json))).toMatchObject({
        proof_basis: "sampled_tracked_identities",
        tracked_identities_confirmed_dead: true,
        descendants_confirmed_dead: false,
      });
      expect(durable.observations.some((row) => row.kind === "infrastructure_error")).toBe(true);
      assertCleanupPending(fixture, result);
    }, new MisleadingSampledDeathController());
  });

  it("rejects non-positive and above-maximum request bounds before consuming authorization or opening artifacts", async () => {
    await usingFixture("request-bounds", async (fixture) => {
      const maximumTimeoutMs = 24 * 60 * 60 * 1_000;
      const maximumOutputBytes = 64 * 1024 * 1024;
      const maximumEnvironmentBytes = 64 * 1024;
      const invalidRequests: ReadonlyArray<{
        readonly label: string;
        readonly overrides: Partial<SupervisedProcessRequest>;
        readonly message: RegExp;
      }> = [
        { label: "zero timeout", overrides: { timeoutMs: 0 }, message: /timeout must be a positive safe integer/ },
        { label: "fractional grace", overrides: { terminationGraceMs: 1.5 }, message: /termination grace must be a positive safe integer/ },
        { label: "zero death observation", overrides: { deathObservationMs: 0 }, message: /death observation must be a positive safe integer/ },
        { label: "zero output limit", overrides: { outputLimitBytes: 0 }, message: /output limit must be a positive safe integer/ },
        { label: "zero tail limit", overrides: { tailLimitBytes: 0 }, message: /tail limit must be a positive safe integer/ },
        { label: "timeout maximum", overrides: { timeoutMs: maximumTimeoutMs + 1 }, message: /timeout exceeds the maximum/ },
        { label: "grace maximum", overrides: { terminationGraceMs: maximumTimeoutMs + 1 }, message: /termination grace exceeds the maximum/ },
        { label: "death maximum", overrides: { deathObservationMs: maximumTimeoutMs + 1 }, message: /death observation exceeds the maximum/ },
        { label: "output maximum", overrides: { outputLimitBytes: maximumOutputBytes + 1 }, message: /output limit exceeds the maximum/ },
        { label: "tail maximum", overrides: { tailLimitBytes: maximumOutputBytes + 1 }, message: /tail limit exceeds the maximum/ },
        { label: "tail exceeds output", overrides: { outputLimitBytes: 4_096, tailLimitBytes: 4_097 }, message: /tail limit cannot exceed the output limit/ },
        {
          label: "environment maximum",
          overrides: {
            environment: { OVERSIZED: "x".repeat(maximumEnvironmentBytes) },
            allowedEnvironmentKeys: ["OVERSIZED"],
          },
          message: /process environment exceeds the 65536-byte bound/,
        },
      ];
      for (const invalid of invalidRequests) {
        await expect(
          fixture.supervisor.run(request(fixture, [process.execPath, "-e", "process.exit(0)"], invalid.overrides)),
          invalid.label,
        ).rejects.toThrow(invalid.message);
      }

      expect(existsSync(fixture.ownership.plan.stdoutPath)).toBe(false);
      expect(existsSync(fixture.ownership.plan.stderrPath)).toBe(false);
      expect(all(fixture.store.location.databasePath, "SELECT launch_id FROM attempt_process_launches")).toEqual([]);
      expect(all(fixture.store.location.databasePath, "SELECT process_receipt_id FROM attempt_process_terminal_receipts")).toEqual([]);
      expect(all(
        fixture.store.location.databasePath,
        "SELECT state FROM attempt_ownership_leases WHERE attempt_id = ?",
        fixture.attemptId,
      )).toEqual([{ state: "live" }]);

      const reports = reportDirectory(fixture, "request-bounds-valid");
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "exit",
        "--report-dir",
        reports,
      ]));
      expect(result).toMatchObject({
        outcome: "exit_zero",
        exitCode: 0,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      assertDurableTerminal(fixture, result);
      assertCleanupPending(fixture, result);
    });
  });

  it("captures simultaneous binary stdout and stderr with exact bounded receipts and private modes", async () => {
    await usingFixture("bounded-output", async (fixture) => {
      const reports = reportDirectory(fixture, "flood");
      const bytes = 65_539;
      const limit = 4_096;
      const tail = 257;
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        floodFixture,
        "binary-simultaneous",
        "--report-dir",
        reports,
        "--bytes",
        String(bytes),
        "--chunk-bytes",
        "4093",
      ], {
        outputLimitBytes: limit,
        tailLimitBytes: tail,
      }));
      expect(result).toMatchObject({
        outcome: "exit_zero",
        exitCode: 0,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      const fixtureResult = readJson(join(reports, "result.json"));
      expect(fixtureResult).toMatchObject({ mode: "binary-simultaneous", exit_code: 0 });

      for (const stream of ["stdout", "stderr"] as const) {
        const receipt = result[stream];
        if (receipt === null) throw new Error(`${stream} receipt is absent`);
        const expected = expectedBinary(stream, bytes);
        expect(receipt).toMatchObject({
          streamDigest: sha256(expected),
          artifactDigest: sha256(expected.subarray(0, limit)),
          originalBytes: bytes,
          storedBytes: limit,
          truncated: true,
          tailBase64: expected.subarray(-tail).toString("base64"),
        });
        expect(readFileSync(receipt.path)).toEqual(expected.subarray(0, limit));
        expect(statSync(receipt.path).size).toBe(limit);
        expect(statSync(receipt.path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(receipt.path)).mode & 0o777).toBe(0o700);
      }
      const durable = assertDurableTerminal(fixture, result);
      for (const stream of ["stdout", "stderr"] as const) {
        const observation = durable.observations.find((row) => row.kind === stream);
        if (observation === undefined) throw new Error(`${stream} observation is absent`);
        expect(JSON.parse(String(observation.inline_payload_json))).toMatchObject({
          schema_version: "rickgent.process-output.v1",
          launch_id: result.launchId,
          process_receipt_id: result.processReceiptId,
          stream,
          original_bytes: bytes,
          stored_bytes: limit,
          truncated: true,
          stream_digest: result[stream]?.streamDigest,
          artifact_digest: result[stream]?.artifactDigest,
          tail_base64: result[stream]?.tailBase64,
        });
      }
      assertCleanupPending(fixture, result);
    });
  });

  it("persists a nonzero terminal outcome and contains every owned resource for cleanup", async () => {
    await usingFixture("nonzero", async (fixture) => {
      const reports = reportDirectory(fixture, "nonzero");
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "exit",
        "--report-dir",
        reports,
        "--exit-code",
        "7",
      ]));
      expect(result).toMatchObject({
        outcome: "exit_nonzero",
        exitCode: 7,
        timedOut: false,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      expect(readJson(join(reports, "leader.json"))).toMatchObject({ mode: "exit", role: "leader" });
      assertDurableTerminal(fixture, result);
      assertCleanupPending(fixture, result);
    });
  });

  it("escalates an ignored TERM across a same-group tree and proves the whole tracked tree dead", async () => {
    await usingFixture("term-escalation", async (fixture) => {
      const reports = reportDirectory(fixture, "tree");
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "tree",
        "--report-dir",
        reports,
        "--ignore-term",
        "--lifetime-ms",
        "60000",
      ], {
        timeoutMs: 300,
        terminationGraceMs: 180,
        deathObservationMs: 1_000,
      }));
      expect(result).toMatchObject({
        outcome: "timed_out",
        timedOut: true,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      const ignoredRoles = readEvents(join(reports, "events.jsonl"))
        .filter((event) => event.event === "signal" && event.signal === "SIGTERM" && event.action === "ignored")
        .map((event) => event.role)
        .sort();
      expect(ignoredRoles).toEqual(["leader", "tree-child", "tree-grandchild"]);
      const durable = assertDurableTerminal(fixture, result);
      const termination = durable.observations.find((row) => row.kind === "termination");
      expect(termination).toBeDefined();
      expect(JSON.parse(String(termination?.inline_payload_json))).toMatchObject({
        timed_out: true,
        term: { signal: "SIGTERM" },
        kill: { signal: "SIGKILL" },
      });
      assertCleanupPending(fixture, result);
    });
  });

  it("does not equate leader exit with group completion while a same-group child remains", async () => {
    await usingFixture("leader-exit", async (fixture) => {
      const reports = reportDirectory(fixture, "leader-exit");
      const startedAt = Date.now();
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "leader-exit-child",
        "--report-dir",
        reports,
        "--lifetime-ms",
        "60000",
      ], {
        terminationGraceMs: 160,
        deathObservationMs: 1_000,
      }));
      const elapsedMs = Date.now() - startedAt;
      const leaderChild = readJson(join(reports, "leader-child.json"));
      survivorPids.add(Number(leaderChild.pid));
      expect(leaderChild).toMatchObject({ role: "leader-child" });
      expect(elapsedMs).toBeGreaterThanOrEqual(140);
      expect(result).toMatchObject({
        outcome: "exit_zero",
        exitCode: 0,
        timedOut: false,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      expect(readEvents(join(reports, "events.jsonl"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "leader_exit_with_child_live", role: "leader" }),
        expect.objectContaining({ event: "signal", role: "leader-child", signal: "SIGTERM" }),
      ]));
      assertDurableTerminal(fixture, result);
      assertCleanupPending(fixture, result);
    });
  });

  it("waits for process exit independently of closed stdout and stderr", async () => {
    await usingFixture("closed-stdio", async (fixture) => {
      const reports = reportDirectory(fixture, "closed-stdio");
      const sentinel = join(reports, "sentinel.txt");
      const startedAt = Date.now();
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "close-stdio",
        "--report-dir",
        reports,
        "--lifetime-ms",
        "320",
        "--mutation-delay-ms",
        "120",
        "--sentinel",
        sentinel,
      ]));
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(280);
      expect(readJson(join(reports, "stdio-closed.json"))).toMatchObject({
        event: "stdio_closed",
        closed_fds: [1, 2],
      });
      expect(readFileSync(sentinel, "utf8")).toMatch(/^stubborn-tree:leader:pid=\d+\n$/);
      expect(result).toMatchObject({
        outcome: "exit_zero",
        exitCode: 0,
        groupDead: true,
        descendantsConfirmedDead: false,
      });
      assertDurableTerminal(fixture, result);
      assertCleanupPending(fixture, result);
    });
  });

  it("fails closed when a descendant escapes the supervised process group", async () => {
    await usingFixture("escaped-descendant", async (fixture) => {
      const reports = reportDirectory(fixture, "escaped");
      const sentinel = join(reports, "escaped-sentinel.txt");
      const result = await fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "double-fork-escape",
        "--report-dir",
        reports,
        "--lifetime-ms",
        "2000",
        "--mutation-delay-ms",
        "500",
        "--sentinel",
        sentinel,
      ], {
        deathObservationMs: 400,
      }));
      const survivor = readJson(join(reports, "escape-survivor.json"));
      survivorPids.add(Number(survivor.pid));
      expect(readEvents(join(reports, "events.jsonl"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "escaped_survivor_ready", role: "leader" }),
      ]));
      expect(result.outcome).toBe("supervision_error");
      expect(result.outcome).not.toBe("exit_zero");
      expect(result.groupDead).toBe(true);
      expect(result.descendantsConfirmedDead).toBe(false);
      const durable = assertDurableTerminal(fixture, result);
      const groupDeath = durable.observations.find((row) => row.kind === "group_death");
      expect(groupDeath).toBeDefined();
      expect(JSON.parse(String(groupDeath?.inline_payload_json))).toMatchObject({
        group_dead: true,
        descendants_confirmed_dead: false,
      });
      assertCleanupPending(fixture, result);
    });
  });

  it("returns after bounded death observation when every termination signal is unprovable", async () => {
    const processes = new UnprovableTerminationController();
    await usingFixture("unprovable-termination", async (fixture) => {
      const reports = reportDirectory(fixture, "unprovable-termination");
      const startedAt = Date.now();
      const runPromise = fixture.supervisor.run(request(fixture, [
        process.execPath,
        stubbornFixture,
        "ignore-term",
        "--report-dir",
        reports,
        "--lifetime-ms",
        "60000",
      ], {
        timeoutMs: 80,
        terminationGraceMs: 40,
        deathObservationMs: 80,
      }));
      let guard: ReturnType<typeof setTimeout> | null = null;
      try {
        const completion = await Promise.race([
          runPromise.then((result) => ({ kind: "result" as const, result })),
          new Promise<{ readonly kind: "guard" }>((resolve) => {
            guard = setTimeout(() => resolve({ kind: "guard" }), 2_000);
          }),
        ]);
        if (completion.kind === "guard") {
          throw new Error("process supervision remained blocked on the live child after death observation completed");
        }
        const result = completion.result;
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(result).toMatchObject({
          outcome: "timed_out",
          exitCode: null,
          timedOut: true,
          groupDead: false,
          descendantsConfirmedDead: false,
        });
        expect(result.detail).toMatch(/group death was unprovable \(EPERM\)/);
        assertDurableTerminal(fixture, result);
        assertCleanupPending(fixture, result);
      } finally {
        if (guard !== null) clearTimeout(guard);
        if (processes.rootPid !== null) {
          try {
            process.kill(-processes.rootPid, "SIGKILL");
          } catch {
            // The regression controller deliberately withholds cleanup signals;
            // the test owns this final out-of-band process-group cleanup.
          }
        }
        await runPromise.catch(() => {});
      }
    }, processes);
  });

  it("reports target spawn failure without manufacturing a successful durable launch", async () => {
    await usingFixture("spawn-failure", async (fixture) => {
      const missingExecutable = join(fixture.root, "does-not-exist");
      const result = await fixture.supervisor.run(request(fixture, [missingExecutable]));
      expect(result).toMatchObject({
        outcome: "spawn_error",
        launchId: null,
        processReceiptId: null,
        pid: null,
        pgid: null,
        exitCode: null,
        timedOut: false,
      });
      expect(all(fixture.store.location.databasePath, "SELECT launch_id FROM attempt_process_launches")).toEqual([]);
      expect(all(fixture.store.location.databasePath, "SELECT process_receipt_id FROM attempt_process_terminal_receipts")).toEqual([]);
      assertCleanupPending(fixture, result);
    });
  });
});
