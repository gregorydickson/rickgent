import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getCapability, publicSurfaceRegistry } from "../../src/capabilities/registry.js";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import {
  DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
  EXECUTION_CONTEXT_SCHEMA_VERSION,
  RUNTIME_PROVENANCE_SCHEMA_VERSION,
  createDurableExecutionContext,
  createExecutionContext,
  type CanonicalDurableExecutionContext,
} from "../../src/context/execution-context.js";
import {
  IdentityContextResolver,
  RESOURCE_IDENTITY_VERSION,
  RUN_MANIFEST_SCHEMA_VERSION,
  compiledCapabilitySnapshot,
} from "../../src/context/resolver.js";
import { computeMetrics, recordRun } from "../../src/lifecycle/metrics.js";
import {
  StateStoreError,
  openStateStore,
  resolveStateLocation,
  type AllocateFreshRunInput,
  type AllocatedAttempt,
  type AllocatedRun,
  type ResumeCompatibilityInput,
  type RetryCompatibilityInput,
  type StateLocation,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const CONTEXT_SCHEMA_VERSION = DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION;
const ORACLE_VERSION = "rickgent.oracle.v1";
const childFixture = join(import.meta.dirname, "../fixtures/identity-allocation/child.mjs");
const scratchRoots = new Set<string>();
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function makeRepo(name = "repo"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-identity-allocation-")));
  scratchRoots.add(root);
  const repo = join(root, name);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Identity Allocation Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "identity@example.test"]);
  writeFileSync(join(repo, "README.md"), `${name}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function repoHead(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function contractDraft(id: string, maxAttempts = 3): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id,
    title: `Allocation ${id}`,
    description: "Exercise immutable run, attempt, and context allocation.",
    depends_on: [],
    scope: [{ path: `src/${id}.ts`, change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-ALLOCATE",
      description: "Allocate immutable identity before side effects.",
      interface_ids: [],
      verification_ids: ["VER-ALLOCATE"],
    }],
    verifications: [{
      id: "VER-ALLOCATE",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: maxAttempts,
      max_review_cycles: 2,
      wall_clock_ms: 120_000,
      remediation_limit: 1,
    },
  };
}

function normalizeContract(repo: string, id = "t14", maxAttempts = 3): TicketContract {
  return sealTicketContracts([contractDraft(id, maxAttempts)], {
    repositoryRoot: repo,
  })[0]!;
}

function contractJson(contract: TicketContract): string {
  const unsigned = { ...contract } as Record<string, unknown>;
  delete unsigned.digest;
  return canonicalJson(unsigned);
}

function freshRunInput(
  location: StateLocation,
  contract: TicketContract,
): AllocateFreshRunInput {
  return freshRunInputForContracts(location, [contract]);
}

function freshRunInputForContracts(
  location: StateLocation,
  contracts: readonly TicketContract[],
): AllocateFreshRunInput {
  const capabilitySnapshot = compiledCapabilitySnapshot();
  const capability = JSON.parse(capabilitySnapshot.canonicalJson) as Record<string, unknown>;
  const tickets = contracts.map((contract, planIndex) => ({
    contract_digest: contract.digest,
    depends_on_ticket_ids: [...contract.depends_on],
    plan_index: planIndex,
    ticket_id: contract.id,
  }));
  const manifest = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    repository_id: location.repositoryId,
    repo_realpath: location.repoRealpath,
    git_common_dir_realpath: location.gitCommonDirRealpath,
    object_format: location.objectFormat,
    context_schema_version: CONTEXT_SCHEMA_VERSION,
    oracle_version: ORACLE_VERSION,
    resource_identity_version: RESOURCE_IDENTITY_VERSION,
    capability_snapshot: capability,
    capability_snapshot_digest: capabilitySnapshot.digest,
    capability_snapshot_schema_version: capabilitySnapshot.schemaVersion,
    tickets,
  };
  const canonicalManifest = canonicalJson(manifest);
  return {
    manifest: {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      canonicalJson: canonicalManifest,
      digest: digest(canonicalManifest),
      capabilitySnapshot,
      contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
      oracleVersion: ORACLE_VERSION,
      resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
    },
    tickets: contracts.map((contract, planIndex) => {
      const canonicalContract = contractJson(contract);
      expect(digest(canonicalContract)).toBe(contract.digest);
      return {
        ticketId: contract.id,
        planIndex,
        contract: {
          schemaVersion: contract.schema_version,
          canonicalJson: canonicalContract,
          digest: contract.digest as `sha256:${string}`,
        },
        dependsOnTicketIds: [...contract.depends_on],
      };
    }),
    initialDeliveryOid: repoHead(location.repoRealpath),
  };
}

function resumeInput(run: AllocatedRun, contract: TicketContract): ResumeCompatibilityInput {
  return {
    runId: run.runId,
    manifestDigest: run.manifestDigest,
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    oracleVersion: ORACLE_VERSION,
    capabilitySnapshotDigest: capabilitySnapshotDigest(),
    resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
    tickets: [{ ticketId: contract.id, contractDigest: contract.digest }],
  };
}

function capabilitySnapshotDigest(): `sha256:${string}` {
  return compiledCapabilitySnapshot().digest;
}

function retryInput(attempt: AllocatedAttempt): RetryCompatibilityInput {
  return {
    runId: attempt.runId,
    ticketId: attempt.ticketId,
    contractDigest: attempt.contractDigest,
    contextSchemaVersion: attempt.contextSchemaVersion,
    oracleVersion: attempt.oracleVersion,
    capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
    resourceIdentityVersion: attempt.resourceIdentityVersion,
  };
}

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(deepFrozen);
}

function durableContext(
  store: StateStore,
  run: AllocatedRun,
  attempt: AllocatedAttempt,
  contract: TicketContract,
  overrides: Partial<Parameters<typeof createDurableExecutionContext>[0]> = {},
): CanonicalDurableExecutionContext {
  const policyRoot = join(store.location.resourceDirectory, "policy");
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(policyRoot, { recursive: true, mode: 0o700 });
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  return createDurableExecutionContext({
    contextSchemaVersion: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
    repositoryId: store.location.repositoryId,
    repoRealpath: store.location.repoRealpath,
    gitCommonDirRealpath: store.location.gitCommonDirRealpath,
    objectFormat: store.location.objectFormat,
    stateRootRealpath: store.location.stateDirectory,
    resourceRootRealpath: store.location.resourceDirectory,
    worktreeRealpath: store.location.repoRealpath,
    policyRootRealpath: realpathSync(policyRoot),
    bundleRootRealpath: realpathSync(bundleRoot),
    runId: run.runId,
    ticketInstanceId: attempt.ticketInstanceId,
    ticketId: attempt.ticketId,
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    phase: "implement",
    phaseOrdinal: 0,
    role: "worker",
    contractDigest: attempt.contractDigest,
    capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
    policyBundleDigest: digest("policy-bundle"),
    modelSelectionDigest: digest("model-selection"),
    oracleVersion: attempt.oracleVersion,
    resourceIdentityVersion: attempt.resourceIdentityVersion,
    budgets: contract.budgets,
    timeoutMs: contract.verifications[0]!.timeout_ms,
    scope: contract.scope,
    ...overrides,
  });
}

function persistContext(store: StateStore, value: CanonicalDurableExecutionContext) {
  return store.persistDurableExecutionContext({
    attemptId: value.context.attempt_id,
    phase: value.context.phase,
    phaseOrdinal: value.context.phase_ordinal,
    role: value.context.role,
    canonicalContextJson: value.canonicalContextJson,
    policyBundleDigest: value.context.policy_bundle_digest,
    modelSelectionDigest: value.context.model_selection_digest,
    budgetDigest: value.budgetDigest,
    scopeDigest: value.scopeDigest,
    worktreeRealpath: value.context.worktree_realpath,
    policyRootRealpath: value.context.policy_root_realpath,
    bundleRootRealpath: value.context.bundle_root_realpath,
    timeoutMs: value.context.timeout_ms,
  });
}

function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

function all(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function one(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  return all(databasePath, sql, ...values)[0];
}

function expectStateCode(action: () => unknown, code: string): StateStoreError {
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

const ATTEMPT_FAILED_CLEAN_PATH = [
  "implementing",
  "implementation_captured",
  "reviewing",
  "verification_queued",
  "verifying",
  "converging",
  "cleanup_pending",
  "failed_clean",
] as const;

const ATTEMPT_QUARANTINED_PATH = [
  "implementing",
  "implementation_captured",
  "reviewing",
  "verification_queued",
  "verifying",
  "converging",
  "cleanup_pending",
  "quarantined",
] as const;

/** t15-deferred fixture setup: emulate only declared legal lifecycle edges. */
function t15FixtureAdvanceAttempt(databasePath: string, attemptId: string, states: readonly string[]): void {
  const database = openRaw(databasePath);
  try {
    for (const state of states) {
      const result = database.prepare(
        "UPDATE attempts SET state = ?, state_version = state_version + 1 WHERE attempt_id = ?",
      ).run(state, attemptId);
      expect(result.changes).toBe(1);
    }
  } finally {
    database.close();
  }
}

/** t15-deferred fixture setup: emulate only declared legal lifecycle edges. */
function t15FixtureAdvanceTicketToCleanup(databasePath: string, ticketInstanceId: string): void {
  const database = openRaw(databasePath);
  try {
    for (const state of ["active", "cleanup_pending"]) {
      const result = database.prepare(
        "UPDATE run_tickets SET state = ?, state_version = state_version + 1 WHERE ticket_instance_id = ?",
      ).run(state, ticketInstanceId);
      expect(result.changes).toBe(1);
    }
  } finally {
    database.close();
  }
}

/** t15-deferred fixture setup: t14 allocates planned identities but cannot activate a run. */
function t15FixtureAdvanceRun(databasePath: string, runId: string, states: readonly string[]): void {
  const database = openRaw(databasePath);
  try {
    for (const state of states) {
      const result = database.prepare(
        "UPDATE runs SET state = ?, state_version = state_version + 1 WHERE run_id = ?",
      ).run(state, runId);
      expect(result.changes).toBe(1);
    }
  } finally {
    database.close();
  }
}

interface ChildOutcome {
  readonly type: "result" | "error";
  readonly result?: AllocatedRun | AllocatedAttempt;
  readonly code?: string;
  readonly message?: string;
}

function runChild(command: "fresh-run" | "retry-attempt", repo: string, inputPath: string): Promise<ChildOutcome> {
  const child = fork(childFixture, [command, repo, inputPath], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    let outcome: ChildOutcome | undefined;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`identity-allocation ${command} fixture timed out`));
    }, 12_000);
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null) outcome = message as ChildOutcome;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      children.delete(child);
      if (outcome !== undefined) resolve(outcome);
      else reject(new Error(`identity-allocation fixture exited without a result: ${String(code ?? signal)}`));
    });
  });
}

function writeChildInput(repo: string, name: string, input: unknown): string {
  const path = join(repo, `.${name}.json`);
  writeFileSync(path, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  return path;
}

describe("immutable run and contract allocation", () => {
  it("allocates distinct ordinary runs for identical normalized input and persists exact contracts", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const input = freshRunInput(store.location, contract);
      const first = store.allocateFreshRun(input);
      const second = store.allocateFreshRun(input);

      expect(first.runId).not.toBe(second.runId);
      expect([first.runSequence, second.runSequence]).toEqual([1, 2]);
      expect(first.deliveryRef).toBe(`refs/rickgent/runs/${first.runId}/delivery`);
      expect(second.deliveryRef).toBe(`refs/rickgent/runs/${second.runId}/delivery`);
      expect(first.repositoryId).toBe(store.location.repositoryId);
      expect(second.repositoryId).toBe(store.location.repositoryId);
      expect(first.tickets[0]?.ticketInstanceId).not.toBe(second.tickets[0]?.ticketInstanceId);

      expect(all(store.location.databasePath, "SELECT run_id, run_sequence FROM runs ORDER BY run_sequence")).toEqual([
        { run_id: first.runId, run_sequence: 1 },
        { run_id: second.runId, run_sequence: 2 },
      ]);
      expect(all(store.location.databasePath, "SELECT * FROM ticket_contracts")).toHaveLength(1);
      expect(one(store.location.databasePath, "SELECT schema_version, canonical_contract_json, contract_digest FROM ticket_contracts")).toEqual({
        schema_version: contract.schema_version,
        canonical_contract_json: contractJson(contract),
        contract_digest: contract.digest,
      });
      expect(one(store.location.databasePath, "SELECT canonical_manifest_json FROM run_manifests WHERE manifest_digest = ?", first.manifestDigest))
        .toEqual({ canonical_manifest_json: input.manifest.canonicalJson });
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.tickets)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("uses only the explicitly selected repository under hostile cwd and legacy environment", () => {
    const repoA = makeRepo("repo-a");
    const repoB = makeRepo("repo-b");
    const contract = normalizeContract(repoA);
    const locationA = resolveStateLocation(repoA);
    const previousCwd = process.cwd();
    const previousLegacyRoot = process.env.RICKGENT_DIR;
    let store: StateStore | undefined;
    try {
      process.chdir(repoB);
      process.env.RICKGENT_DIR = join(repoB, "hostile-legacy-state");
      store = openStateStore({ repoPath: repoA });
      const allocated = store.allocateFreshRun(freshRunInput(locationA, contract));
      expect(allocated.repositoryId).toBe(locationA.repositoryId);
      expect(store.location.repoRealpath).toBe(repoA);
      expect(existsSync(resolveStateLocation(repoB).databasePath)).toBe(false);
      expect(existsSync(process.env.RICKGENT_DIR)).toBe(false);
    } finally {
      store?.close();
      process.chdir(previousCwd);
      if (previousLegacyRoot === undefined) delete process.env.RICKGENT_DIR;
      else process.env.RICKGENT_DIR = previousLegacyRoot;
    }
  });

  it("serializes concurrent ordinary allocators into unique run IDs and sequences", async () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const input = freshRunInput(resolveStateLocation(repo), contract);
    const inputPath = writeChildInput(repo, "fresh-run-input", input);
    const [left, right] = await Promise.all([
      runChild("fresh-run", repo, inputPath),
      runChild("fresh-run", repo, inputPath),
    ]);
    expect(left.type).toBe("result");
    expect(right.type).toBe("result");
    const results = [left.result as AllocatedRun, right.result as AllocatedRun];
    expect(new Set(results.map((result) => result.runId)).size).toBe(2);
    expect(results.map((result) => result.runSequence).sort()).toEqual([1, 2]);

    const store = openStateStore({ repoPath: repo });
    try {
      expect(all(store.location.databasePath, "SELECT run_sequence FROM runs ORDER BY run_sequence"))
        .toEqual([{ run_sequence: 1 }, { run_sequence: 2 }]);
      expect(all(store.location.databasePath, "SELECT ticket_instance_id FROM run_tickets")).toHaveLength(2);
      store.verifyIntegrity();
    } finally {
      store.close();
    }
  });
});

describe("attempt allocation, retry, and explicit resume", () => {
  it("keeps public resume unavailable while exposing only the explicit internal selector", () => {
    expect(getCapability("resume_retry")).toMatchObject({
      state: "unavailable",
      error_code: "RICKGENT_RESUME_UNAVAILABLE",
    });
    expect(publicSurfaceRegistry()).toContainEqual(expect.objectContaining({
      surface: "build|pipeline --resume",
      mode: "public_blocked",
      mutation_authority: "none",
      capability: "resume_retry",
      exit_code: 3,
    }));
    expect(publicSurfaceRegistry()).toContainEqual(expect.objectContaining({
      surface: "rickgent retry",
      mode: "public_input_rejected",
      mutation_authority: "none",
      exit_code: 2,
    }));
  });

  it("commits monotonic attempts before downstream work and preserves prior rows", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo, "t14", 2);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const first = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      expect(first).toMatchObject({
        runId: run.runId,
        ticketId: contract.id,
        attemptNumber: 1,
        deliveryBaselineOid: run.initialDeliveryOid,
        state: "planned",
        stateVersion: 0,
      });
      expect(one(store.location.databasePath, "SELECT * FROM attempts WHERE attempt_id = ?", first.attemptId)).toBeDefined();
      expectStateCode(
        () => store.allocateRetryAttempt(retryInput(first)),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );

      const immutableBefore = one(store.location.databasePath, "SELECT * FROM attempts WHERE attempt_id = ?", first.attemptId)!;
      t15FixtureAdvanceRun(store.location.databasePath, run.runId, ["active"]);
      t15FixtureAdvanceTicketToCleanup(store.location.databasePath, first.ticketInstanceId);
      t15FixtureAdvanceAttempt(store.location.databasePath, first.attemptId, ATTEMPT_FAILED_CLEAN_PATH);
      const second = store.allocateRetryAttempt(retryInput(first));
      expect(second.attemptNumber).toBe(2);
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(second.allocationOwnerDigest).not.toBe(first.allocationOwnerDigest);
      expect(second.deliveryBaselineOid).toBe(run.currentDeliveryOid);

      const immutableAfter = one(store.location.databasePath, "SELECT * FROM attempts WHERE attempt_id = ?", first.attemptId)!;
      expect(immutableAfter).toMatchObject({
        ...immutableBefore,
        state: "failed_clean",
        state_version: ATTEMPT_FAILED_CLEAN_PATH.length,
      });
      for (const column of [
        "attempt_id", "ticket_instance_id", "run_id", "ticket_id", "attempt_number", "contract_digest",
        "allocation_owner_digest", "delivery_baseline_oid", "context_schema_version", "oracle_version",
        "capability_snapshot_digest", "resource_identity_version", "created_at",
      ]) {
        expect(immutableAfter[column]).toEqual(immutableBefore[column]);
      }

      t15FixtureAdvanceAttempt(store.location.databasePath, second.attemptId, ATTEMPT_FAILED_CLEAN_PATH);
      expectStateCode(
        () => store.allocateRetryAttempt(retryInput(second)),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );
      expect(all(store.location.databasePath, "SELECT attempt_number FROM attempts ORDER BY attempt_number"))
        .toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
    } finally {
      store.close();
    }
  });

  it("forbids retry of a quarantined lineage", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      t15FixtureAdvanceRun(store.location.databasePath, run.runId, ["active"]);
      t15FixtureAdvanceTicketToCleanup(store.location.databasePath, attempt.ticketInstanceId);
      t15FixtureAdvanceAttempt(store.location.databasePath, attempt.attemptId, ATTEMPT_QUARANTINED_PATH);
      expectStateCode(
        () => store.allocateRetryAttempt(retryInput(attempt)),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );
      expect(all(store.location.databasePath, "SELECT attempt_number FROM attempts")).toEqual([{ attempt_number: 1 }]);
    } finally {
      store.close();
    }
  });

  it("allows one winner when concurrent retry allocators race on max+1", async () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo, "t14", 3);
    const store = openStateStore({ repoPath: repo });
    let run: AllocatedRun;
    let retry: RetryCompatibilityInput;
    try {
      run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const initial = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      t15FixtureAdvanceRun(store.location.databasePath, run.runId, ["active"]);
      t15FixtureAdvanceTicketToCleanup(store.location.databasePath, initial.ticketInstanceId);
      t15FixtureAdvanceAttempt(store.location.databasePath, initial.attemptId, ATTEMPT_FAILED_CLEAN_PATH);
      retry = retryInput(initial);
    } finally {
      store.close();
    }

    const inputPath = writeChildInput(repo, "retry-attempt-input", retry!);
    const outcomes = await Promise.all([
      runChild("retry-attempt", repo, inputPath),
      runChild("retry-attempt", repo, inputPath),
    ]);
    expect(outcomes.filter((outcome) => outcome.type === "result")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.code === "RICKGENT_STATE_TRANSITION_ILLEGAL")).toHaveLength(1);

    const reopened = openStateStore({ repoPath: repo });
    try {
      expect(all(reopened.location.databasePath, "SELECT attempt_number FROM attempts ORDER BY attempt_number"))
        .toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
      reopened.verifyIntegrity();
    } finally {
      reopened.close();
    }
  });

  it("selects only an explicit exactly compatible run and rejects every compatibility drift", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const compatible = resumeInput(run, contract);
      const selected = store.selectCompatibleResume(compatible);
      expect(selected).toMatchObject({
        runId: run.runId,
        repositoryId: store.location.repositoryId,
        manifestDigest: run.manifestDigest,
        tickets: [{
          ticketId: contract.id,
          contractDigest: contract.digest,
          latestAttempt: { attemptId: attempt.attemptId, attemptNumber: 1 },
        }],
      });

      const incompatible: Array<[string, ResumeCompatibilityInput]> = [
        ["manifest", { ...compatible, manifestDigest: digest("different manifest") }],
        ["context schema", { ...compatible, contextSchemaVersion: "future-context" }],
        ["oracle", { ...compatible, oracleVersion: "future-oracle" }],
        ["capability", { ...compatible, capabilitySnapshotDigest: digest("different capability") }],
        ["resource identity", { ...compatible, resourceIdentityVersion: "future-resource" }],
        ["contract", { ...compatible, tickets: [{ ticketId: contract.id, contractDigest: digest("different contract") }] }],
        ["ticket set", { ...compatible, tickets: [] }],
      ];
      for (const [, input] of incompatible) {
        expectStateCode(() => store.selectCompatibleResume(input), "RICKGENT_STATE_RESUME_INCOMPATIBLE");
      }

      expectStateCode(
        () => store.selectCompatibleResume({ ...compatible, runId: "" }),
        "RICKGENT_STATE_RESUME_INCOMPATIBLE",
      );
      for (const forbidden of ["latest", contract.id, `${run.runId}/${contract.id}/implement/1/worker`]) {
        expectStateCode(
          () => store.selectCompatibleResume({ ...compatible, runId: forbidden }),
          "RICKGENT_STATE_RESUME_INCOMPATIBLE",
        );
      }
    } finally {
      store.close();
    }

    const otherRepo = makeRepo("other-repo");
    const otherStore = openStateStore({ repoPath: otherRepo });
    try {
      const original = openStateStore({ repoPath: repo });
      let compatible: ResumeCompatibilityInput;
      try {
        const runRow = one(original.location.databasePath, "SELECT run_id, manifest_digest FROM runs")!;
        compatible = {
          runId: String(runRow.run_id),
          manifestDigest: String(runRow.manifest_digest),
          contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
          oracleVersion: ORACLE_VERSION,
          capabilitySnapshotDigest: capabilitySnapshotDigest(),
          resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
          tickets: [{ ticketId: contract.id, contractDigest: contract.digest }],
        };
      } finally {
        original.close();
      }
      expectStateCode(() => otherStore.selectCompatibleResume(compatible!), "RICKGENT_STATE_RESUME_INCOMPATIBLE");
    } finally {
      otherStore.close();
    }
  });

  it("keeps the allocated run identity consistent through the existing metrics seam", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const metricsRoot = join(repo, ".metrics-test");
      recordRun(metricsRoot, run.runId, "Identity allocation test");
      const metrics = computeMetrics(metricsRoot);
      const ledger = JSON.parse(readFileSync(join(metricsRoot, "runs.jsonl"), "utf8").trim()) as { runId: string };
      const attemptRow = one(store.location.databasePath, "SELECT run_id FROM attempts WHERE attempt_id = ?", attempt.attemptId);
      expect(ledger.runId).toBe(run.runId);
      expect(attemptRow?.run_id).toBe(run.runId);
      expect(attempt.runId).toBe(run.runId);
      expect(metrics.runs).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("durable execution-context identity", () => {
  it("resolves and persists complete immutable context without copying process.env", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    const resolver = new IdentityContextResolver(store);
    const previousSecret = process.env.RICKGENT_IDENTITY_TEST_SECRET;
    process.env.RICKGENT_IDENTITY_TEST_SECRET = "must-not-enter-context";
    try {
      const run = resolver.allocateFreshRun({
        contracts: [contract],
        initialDeliveryOid: repoHead(repo),
        oracleVersion: ORACLE_VERSION,
      });
      const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const policyRoot = join(store.location.resourceDirectory, "phase-policy");
      const bundleRoot = join(policyRoot, "phase-bundle");
      mkdirSync(policyRoot, { mode: 0o700 });
      mkdirSync(bundleRoot, { mode: 0o700 });
      const resolved = resolver.resolvePhaseContext({
        attempt,
        contract,
        phase: "implement",
        phaseOrdinal: 0,
        role: "worker",
        worktreeRealpath: repo,
        policyBundle: {
          kind: "materialized_authenticated_policy_bundle",
          policyRoot,
          bundleDir: bundleRoot,
          requestedBundleSha256: digest("authenticated-policy-bundle").slice("sha256:".length),
        },
        modelSelection: { harness: "codex", model: "test-model", vendor: "openai" },
        timeoutMs: contract.verifications[0]!.timeout_ms,
      });

      expect(resolved.canonical.context).toMatchObject({
        schema_version: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
        repository_id: store.location.repositoryId,
        repo_realpath: repo,
        git_common_dir_realpath: store.location.gitCommonDirRealpath,
        object_format: store.location.objectFormat,
        state_root_realpath: store.location.stateDirectory,
        resource_root_realpath: store.location.resourceDirectory,
        worktree_realpath: repo,
        policy_root_realpath: realpathSync(policyRoot),
        bundle_root_realpath: realpathSync(bundleRoot),
        run_id: run.runId,
        ticket_instance_id: attempt.ticketInstanceId,
        ticket_id: contract.id,
        attempt_id: attempt.attemptId,
        attempt_number: 1,
        phase: "implement",
        phase_ordinal: 0,
        role: "worker",
        contract_digest: contract.digest,
        capability_snapshot_digest: attempt.capabilitySnapshotDigest,
        context_schema_version: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
        oracle_version: ORACLE_VERSION,
        resource_identity_version: RESOURCE_IDENTITY_VERSION,
        budgets: contract.budgets,
        timeout_ms: contract.verifications[0]!.timeout_ms,
        scope: contract.scope,
      });
      expect(resolved.canonical.canonicalContextJson).toBe(canonicalJson(resolved.canonical.context));
      expect(resolved.canonical.contextDigest).toBe(digest(resolved.canonical.canonicalContextJson));
      expect(resolved.canonical.budgetDigest).toBe(digest(canonicalJson(contract.budgets)));
      expect(resolved.canonical.scopeDigest).toBe(digest(canonicalJson(contract.scope)));
      expect(resolved.canonical.canonicalContextJson).not.toContain("must-not-enter-context");
      expect(resolved.canonical.canonicalContextJson).not.toContain("RICKGENT_IDENTITY_TEST_SECRET");
      expect(resolved.canonical.canonicalContextJson).not.toContain('"env"');
      expect(deepFrozen(resolved.canonical)).toBe(true);
      expect(Object.isFrozen(resolved.persisted)).toBe(true);

      expect(resolved.persisted.context).toMatchObject({
        context_id: resolved.persisted.contextId,
        context_digest: resolved.canonical.contextDigest,
        attempt_id: attempt.attemptId,
        phase: "implement",
        phase_ordinal: 0,
        role: "worker",
        canonical_context_json: resolved.canonical.canonicalContextJson,
        contract_digest: contract.digest,
        capability_snapshot_digest: attempt.capabilitySnapshotDigest,
        policy_bundle_digest: resolved.canonical.context.policy_bundle_digest,
        model_selection_digest: resolved.canonical.context.model_selection_digest,
        budget_digest: resolved.canonical.budgetDigest,
        scope_digest: resolved.canonical.scopeDigest,
      });
      expect(resolved.persisted.phaseExecution).toMatchObject({
        phase_execution_id: resolved.persisted.phaseExecutionId,
        attempt_id: attempt.attemptId,
        context_id: resolved.persisted.contextId,
        phase: "implement",
        phase_ordinal: 0,
        role: "worker",
      });
      expect(JSON.parse(String(resolved.persisted.context.canonical_context_json))).toEqual(resolved.canonical.context);
    } finally {
      if (previousSecret === undefined) delete process.env.RICKGENT_IDENTITY_TEST_SECRET;
      else process.env.RICKGENT_IDENTITY_TEST_SECRET = previousSecret;
      store.close();
    }
  });

  it("is idempotent per phase tuple, distinguishes ordinals, and rejects changed tuple content", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const first = durableContext(store, run, attempt, contract);
      const firstPersisted = persistContext(store, first);
      const repeated = persistContext(store, first);
      expect(repeated.contextId).toBe(firstPersisted.contextId);
      expect(repeated.phaseExecutionId).toBe(firstPersisted.phaseExecutionId);
      expect(repeated.context).toEqual(firstPersisted.context);

      const nextOrdinal = durableContext(store, run, attempt, contract, { phaseOrdinal: 1 });
      const secondPersisted = persistContext(store, nextOrdinal);
      expect(secondPersisted.contextId).not.toBe(firstPersisted.contextId);
      expect(secondPersisted.phaseExecutionId).not.toBe(firstPersisted.phaseExecutionId);
      expect(all(store.location.databasePath, "SELECT phase_ordinal FROM execution_contexts ORDER BY phase_ordinal"))
        .toEqual([{ phase_ordinal: 0 }, { phase_ordinal: 1 }]);
      expect(all(store.location.databasePath, "SELECT phase_ordinal FROM phase_executions ORDER BY phase_ordinal"))
        .toEqual([{ phase_ordinal: 0 }, { phase_ordinal: 1 }]);

      const changed = durableContext(store, run, attempt, contract, {
        timeoutMs: contract.verifications[0]!.timeout_ms + 1,
      });
      expectStateCode(() => persistContext(store, changed), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(all(store.location.databasePath, "SELECT context_id FROM execution_contexts")).toHaveLength(2);
      expect(all(store.location.databasePath, "SELECT phase_execution_id FROM phase_executions")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("rejects canonical JSON projection tampering before insert", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const value = durableContext(store, run, attempt, contract);
      const mutations: Array<{
        readonly name: string;
        readonly mutate: (draft: Record<string, unknown>) => void;
        readonly expectedCode?: string;
      }> = [
        { name: "extra env", mutate: (draft) => { draft.env = { SECRET: "authority injection" }; } },
        { name: "extra processEnv", mutate: (draft) => { draft.processEnv = { SECRET: "authority injection" }; } },
        { name: "repository", mutate: (draft) => { draft.repository_id = digest("other repository"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "repo root", mutate: (draft) => { draft.repo_realpath = "/other/repository"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "git common root", mutate: (draft) => { draft.git_common_dir_realpath = "/other/git"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "state root", mutate: (draft) => { draft.state_root_realpath = "/other/state"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "resource root", mutate: (draft) => { draft.resource_root_realpath = "/other/resources"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "worktree root", mutate: (draft) => { draft.worktree_realpath = store.location.stateDirectory; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "policy root", mutate: (draft) => { draft.policy_root_realpath = store.location.repoRealpath; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "bundle root", mutate: (draft) => { draft.bundle_root_realpath = store.location.repoRealpath; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "run", mutate: (draft) => { draft.run_id = "run-from-another-lineage"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "ticket instance", mutate: (draft) => { draft.ticket_instance_id = "ticket-from-another-lineage"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "ticket", mutate: (draft) => { draft.ticket_id = "t999"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "attempt", mutate: (draft) => { draft.attempt_id = "attempt-from-another-lineage"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "attempt number", mutate: (draft) => { draft.attempt_number = 99; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "phase", mutate: (draft) => { draft.phase = "review"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "phase ordinal", mutate: (draft) => { draft.phase_ordinal = 9; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "role", mutate: (draft) => { draft.role = "reviewer"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "contract", mutate: (draft) => { draft.contract_digest = digest("other contract"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "capability", mutate: (draft) => { draft.capability_snapshot_digest = digest("other capability"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "policy bundle", mutate: (draft) => { draft.policy_bundle_digest = digest("other bundle"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "model", mutate: (draft) => { draft.model_selection_digest = digest("other model"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "budget digest", mutate: (draft) => { draft.budget_digest = digest("other budget"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "scope digest", mutate: (draft) => { draft.scope_digest = digest("other scope"); }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "context schema", mutate: (draft) => { draft.context_schema_version = "future-context"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "schema", mutate: (draft) => { draft.schema_version = "future-context"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "oracle", mutate: (draft) => { draft.oracle_version = "future-oracle"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "resource identity", mutate: (draft) => { draft.resource_identity_version = "future-resource"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "scope", mutate: (draft) => { draft.scope = []; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        {
          name: "budgets",
          mutate: (draft) => {
            draft.budgets = { ...contract.budgets, max_attempts: contract.budgets.max_attempts + 1 };
          },
          expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE",
        },
        { name: "timeout", mutate: (draft) => { draft.timeout_ms = contract.verifications[0]!.timeout_ms + 1; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "relative worktree root", mutate: (draft) => { draft.worktree_realpath = "relative/worktree"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "relative policy root", mutate: (draft) => { draft.policy_root_realpath = "relative/policy"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
        { name: "relative bundle root", mutate: (draft) => { draft.bundle_root_realpath = "relative/bundle"; }, expectedCode: "RICKGENT_STATE_RESUME_INCOMPATIBLE" },
      ];
      for (const mutation of mutations) {
        const draft = JSON.parse(value.canonicalContextJson) as Record<string, unknown>;
        mutation.mutate(draft);
        const action = () => store.persistDurableExecutionContext({
          attemptId: attempt.attemptId,
          phase: value.context.phase,
          phaseOrdinal: value.context.phase_ordinal,
          role: value.context.role,
          canonicalContextJson: canonicalJson(draft),
          policyBundleDigest: value.context.policy_bundle_digest,
          modelSelectionDigest: value.context.model_selection_digest,
          budgetDigest: value.budgetDigest,
          scopeDigest: value.scopeDigest,
          worktreeRealpath: value.context.worktree_realpath,
          policyRootRealpath: value.context.policy_root_realpath,
          bundleRootRealpath: value.context.bundle_root_realpath,
          timeoutMs: value.context.timeout_ms,
        });
        if (mutation.expectedCode !== undefined) expectStateCode(action, mutation.expectedCode);
        else expect(action, mutation.name).toThrow();
        expect(all(store.location.databasePath, "SELECT context_id FROM execution_contexts"), mutation.name).toEqual([]);
        expect(all(store.location.databasePath, "SELECT phase_execution_id FROM phase_executions"), mutation.name).toEqual([]);
      }
      expect(all(store.location.databasePath, "SELECT context_id FROM execution_contexts")).toEqual([]);
      expect(all(store.location.databasePath, "SELECT phase_execution_id FROM phase_executions")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back the context row if the paired phase insert fails", () => {
    const repo = makeRepo();
    const contract = normalizeContract(repo);
    const store = openStateStore({ repoPath: repo });
    try {
      const run = store.allocateFreshRun(freshRunInput(store.location, contract));
      const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const value = durableContext(store, run, attempt, contract, { phase: "atomic" });
      const tupleJson = canonicalJson({
        attempt_id: attempt.attemptId,
        phase: value.context.phase,
        phase_ordinal: value.context.phase_ordinal,
        role: value.context.role,
      });
      const intendedContextId = `context-${digest(tupleJson).slice("sha256:".length)}`;
      const phaseIdentityDigest = digest(canonicalJson({
        attempt_id: attempt.attemptId,
        context_id: intendedContextId,
        phase: value.context.phase,
        phase_ordinal: value.context.phase_ordinal,
        role: value.context.role,
      }));
      const blockerJson = canonicalJson({ blocker: "phase identity" });
      const blockerContextId = "context-phase-identity-blocker";
      const database = openRaw(store.location.databasePath);
      try {
        database.prepare(`
          INSERT INTO execution_contexts (
            context_id, context_digest, attempt_id, phase, phase_ordinal, role, canonical_context_json,
            contract_digest, capability_snapshot_digest, policy_bundle_digest, model_selection_digest,
            budget_digest, scope_digest, context_schema_version, oracle_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          blockerContextId,
          digest(blockerJson),
          attempt.attemptId,
          "blocker",
          0,
          "worker",
          blockerJson,
          attempt.contractDigest,
          attempt.capabilitySnapshotDigest,
          value.context.policy_bundle_digest,
          value.context.model_selection_digest,
          value.budgetDigest,
          value.scopeDigest,
          attempt.contextSchemaVersion,
          attempt.oracleVersion,
          "2026-07-16T12:00:00.000Z",
        );
        database.prepare(`
          INSERT INTO phase_executions (
            phase_execution_id, attempt_id, context_id, phase, phase_ordinal, role, identity_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "phase-identity-blocker",
          attempt.attemptId,
          blockerContextId,
          "blocker",
          0,
          "worker",
          phaseIdentityDigest,
          "2026-07-16T12:00:00.000Z",
        );
      } finally {
        database.close();
      }

      expectStateCode(() => persistContext(store, value), "RICKGENT_STATE_CONFLICT");
      expect(one(store.location.databasePath, "SELECT context_id FROM execution_contexts WHERE context_id = ?", intendedContextId))
        .toBeUndefined();
      expect(all(store.location.databasePath, "SELECT context_id FROM execution_contexts"))
        .toEqual([{ context_id: blockerContextId }]);
      expect(all(store.location.databasePath, "SELECT phase_execution_id FROM phase_executions"))
        .toEqual([{ phase_execution_id: "phase-identity-blocker" }]);
    } finally {
      store.close();
    }
  });

  it("keeps the existing policy ExecutionContext schema additive and byte-shape compatible", () => {
    const contract = normalizeContract(makeRepo());
    const legacy = createExecutionContext({
      dispatch: { runId: "run-existing", ticketId: contract.id, phase: "implement", attempt: 1, role: "worker" },
      ticketContractDigest: contract.digest,
      ticketContractSchemaVersion: "1.0.0",
      declaredScope: contract.scope,
      targetRepoRealpath: "/repo",
      worktreeRealpath: "/worktree",
      stateRootRealpath: "/state",
      policyRootRealpath: "/policy",
      bundleRootRealpath: "/bundle",
      requestedHarness: "codex",
      requestedModel: "gpt-5",
      requestedVendor: "openai",
      requestedBundleSha256: "a".repeat(64),
      requestedConfigSha256: "b".repeat(64),
      runtimeProvenance: {
        schema_version: RUNTIME_PROVENANCE_SCHEMA_VERSION,
        omnigent_python_entrypoint: "/python",
        omnigent_python_realpath: "/python",
        omnigent_python_sha256: "c".repeat(64),
        omnigent_root_realpath: "/omnigent",
        omnigent_origin_realpath: "/omnigent/origin.py",
        rickgent_policies_origin_realpath: "/policies/origin.py",
        rickgent_policies_sha256: "d".repeat(64),
        rickgent_node_realpath: "/node",
        rickgent_node_sha256: "e".repeat(64),
        rickgent_cli_realpath: "/cli",
        rickgent_cli_sha256: "f".repeat(64),
        rickgent_build_commit: "existing-build",
      },
      ownerTokenSha256: "1".repeat(64),
      nonce: "nonce",
      nonceClaimPath: "/nonce",
      leasePath: "/lease",
      receiptPath: "/receipt",
    });
    expect(legacy).toMatchObject({
      schema_version: EXECUTION_CONTEXT_SCHEMA_VERSION,
      dispatch_id: `run-existing/${contract.id}/implement/1/worker`,
      run_id: "run-existing",
      ticket_id: contract.id,
      attempt: 1,
    });
    expect(legacy).not.toHaveProperty("repository_id");
    expect(legacy).not.toHaveProperty("budgets");
    expect(deepFrozen(legacy)).toBe(true);
  });
});
