import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/contracts/ticket-contract.js";
import {
  attemptWorkspaceReadyForSpawn,
  deriveAttemptWorkspacePlan,
  isAuthorizedAttemptWorkspaceSpawnAuthorization,
  provisionAttemptWorkspace,
} from "../../src/git/attempt-workspace.js";
import {
  LeaseAuthority,
  isAuthorizedAttemptOwnershipCommand,
} from "../../src/state/leases.js";
import {
  StateStoreError,
  openStateStore,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const roots = new Set<string>();
const children = new Set<ChildProcess>();
const raceChild = join(import.meta.dirname, "../fixtures/attempt-ownership/child.mjs");
let deathEvidenceOrdinal = 0;

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(linkedWorktree = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-attempt-ownership-")));
  roots.add(root);
  const repo = join(root, linkedWorktree ? "main" : "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.name", "Attempt Ownership Test");
  git(repo, "config", "user.email", "attempt-ownership@example.test");
  writeFileSync(join(repo, "README.md"), "ownership\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  if (linkedWorktree) {
    const worktree = join(root, "repo");
    git(repo, "worktree", "add", "--detach", "--quiet", worktree, "HEAD");
    return realpathSync(worktree);
  }
  return realpathSync(repo);
}

function insert(database: DatabaseSync, table: string, row: SqlRow): void {
  const columns = Object.keys(row);
  database.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  ).run(...columns.map((column) => row[column] ?? null));
}

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly attemptId: string;
  readonly runId: string;
  readonly ticketInstanceId: string;
  readonly contractDigest: string;
  readonly capabilityDigest: string;
  readonly baselineOid: string;
}

function seed(label = "r18", linkedWorktree = false): Fixture {
  const repo = makeRepo(linkedWorktree);
  const store = openStateStore({ repoPath: repo });
  const runId = `run-${label}`;
  const ticketInstanceId = `ticket-instance-${label}`;
  const attemptId = `attempt-${label}`;
  const manifestJson = canonicalJson({ schema_version: "rickgent.test-run/v1", label });
  const manifestDigest = digest(manifestJson);
  const contractJson = canonicalJson({ schema_version: "rickgent.test-ticket/v1", label });
  const contractDigest = digest(contractJson);
  const capabilityDigest = digest(`capability:${label}`);
  const baselineOid = git(repo, "rev-parse", "HEAD");
  const now = new Date().toISOString();
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
      run_sequence: 1,
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
      ticket_id: `ticket-${label}`,
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
      ticket_id: `ticket-${label}`,
      attempt_number: 1,
      contract_digest: contractDigest,
      allocation_owner_digest: digest(`allocation:${label}`),
      delivery_baseline_oid: baselineOid,
      context_schema_version: "rickgent.execution-context/v1",
      oracle_version: "rickgent.oracle.v1",
      capability_snapshot_digest: capabilityDigest,
      resource_identity_version: "rickgent.attempt-resource-identity/v1",
      state: "planned",
      state_version: 0,
      created_at: now,
    });
  } finally {
    database.close();
  }
  return { repo, store, attemptId, runId, ticketInstanceId, contractDigest, capabilityDigest, baselineOid };
}

function all(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function expectCode(action: () => unknown, code: string): StateStoreError {
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

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child timed out waiting for ${type}`)), 10_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || (message as Record<string, unknown>).type !== type) return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      resolve(message as Record<string, unknown>);
    };
    child.on("message", onMessage);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => {
    children.delete(child);
    resolve();
  }));
}

function waitForOutcome(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child timed out waiting for acquisition outcome")), 10_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const type = (message as Record<string, unknown>).type;
      if (type !== "result" && type !== "error") return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      resolve(message as Record<string, unknown>);
    };
    child.on("message", onMessage);
  });
}

function appendDeathEvidence(
  fixture: Fixture,
  ownership: { readonly ownershipId: string; readonly generation: number; readonly contextDigest: string; readonly heartbeatAt: string },
  suffix = String(ownership.generation),
  observedAt = new Date().toISOString(),
  linkProcessReceipt = true,
  descendantsConfirmedDead = true,
): string {
  const contextId = `context-death-${fixture.attemptId}-${suffix}`;
  const phaseId = `phase-death-${fixture.attemptId}-${suffix}`;
  const launchId = `launch-${fixture.attemptId}-${suffix}`;
  const launchEvidenceId = `evidence-launch-${fixture.attemptId}-${suffix}`;
  const evidenceId = `evidence-death-${fixture.attemptId}-${suffix}`;
  const observationId = `observation-death-${fixture.attemptId}-${suffix}`;
  const processReceiptId = `process-receipt-${fixture.attemptId}-${suffix}`;
  const phaseOrdinal = ++deathEvidenceOrdinal;
  const pid = 4100 + ownership.generation;
  const pgid = 4100 + ownership.generation;
  const contextJson = canonicalJson({
    schema_version: "rickgent.execution-context/v1",
    attempt_id: fixture.attemptId,
    phase: "cleanup",
    phase_ordinal: phaseOrdinal,
    role: "cleanup",
  });
  const executionContextDigest = digest(contextJson);
  const launchPayloadObject = {
    schema_version: "rickgent.process-launch.v1",
    launch_id: launchId,
    process_receipt_id: processReceiptId,
    repository_id: fixture.store.location.repositoryId,
    attempt_id: fixture.attemptId,
    ownership_id: ownership.ownershipId,
    owner_generation: ownership.generation,
    ownership_context_digest: ownership.contextDigest,
    phase_execution_id: phaseId,
    context_id: contextId,
    execution_context_digest: executionContextDigest,
    spawn_authorization_digest: digest(`spawn:${suffix}`),
    pid,
    pgid,
    platform: process.platform,
    boot_identity: "boot-test-identity",
    process_start_identity: `start-${suffix}`,
    argv_digest: digest(`argv:${suffix}`),
    environment_digest: digest(`environment:${suffix}`),
    stdout_path: `/tmp/${fixture.attemptId}-${suffix}.stdout`,
    stderr_path: `/tmp/${fixture.attemptId}-${suffix}.stderr`,
    output_limit_bytes: 1024,
    tail_limit_bytes: 128,
    created_at: observedAt,
  };
  const launchPayload = canonicalJson(launchPayloadObject);
  const deathPayloadObject = {
    schema_version: "rickgent.process-group-death.v1",
    launch_id: launchId,
    process_receipt_id: processReceiptId,
    attempt_id: fixture.attemptId,
    ownership_id: ownership.ownershipId,
    owner_generation: ownership.generation,
    ownership_context_digest: ownership.contextDigest,
    phase_execution_id: phaseId,
    context_id: contextId,
    execution_context_digest: executionContextDigest,
    pid,
    pgid,
    platform: process.platform,
    boot_identity: "boot-test-identity",
    process_start_identity: `start-${suffix}`,
    group_dead: true,
    proof_basis: descendantsConfirmedDead ? "authoritative_containment" : "sampled_tracked_identities",
    tracked_identities_confirmed_dead: descendantsConfirmedDead,
    descendants_confirmed_dead: descendantsConfirmedDead,
    death_observed_at: observedAt,
  };
  const payload = canonicalJson(deathPayloadObject);
  const database = new DatabaseSync(fixture.store.location.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const ownershipRow = database.prepare(`
      SELECT ownership_id FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?
    `).get(ownership.ownershipId, fixture.attemptId) as SqlRow | undefined;
    if (ownershipRow === undefined) throw new Error("ownership fixture row is missing");
    insert(database, "execution_contexts", {
      context_id: contextId,
      context_digest: executionContextDigest,
      attempt_id: fixture.attemptId,
      phase: "cleanup",
      phase_ordinal: phaseOrdinal,
      role: "cleanup",
      canonical_context_json: contextJson,
      contract_digest: fixture.contractDigest,
      capability_snapshot_digest: fixture.capabilityDigest,
      policy_bundle_digest: digest("policy"),
      model_selection_digest: digest("model"),
      budget_digest: digest("budget"),
      scope_digest: digest("scope"),
      context_schema_version: "rickgent.execution-context/v1",
      oracle_version: "rickgent.oracle.v1",
      created_at: new Date().toISOString(),
    });
    insert(database, "phase_executions", {
      phase_execution_id: phaseId,
      attempt_id: fixture.attemptId,
      context_id: contextId,
      phase: "cleanup",
      phase_ordinal: phaseOrdinal,
      role: "cleanup",
      identity_digest: digest(`phase:${fixture.attemptId}:${suffix}`),
      created_at: new Date().toISOString(),
    });
    insert(database, "evidence", {
      evidence_id: launchEvidenceId,
      attempt_id: fixture.attemptId,
      phase_execution_id: phaseId,
      context_id: contextId,
      producer_service: "ProcessSupervisor",
      scope: `attempt:${fixture.attemptId}:process-launch`,
      schema_version: "rickgent.process-launch.v1",
      content_digest: digest(launchPayload),
      inline_payload_json: launchPayload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: `launch:${ownership.ownershipId}:${suffix}`,
      created_at: observedAt,
    });
    if (linkProcessReceipt) {
      insert(database, "attempt_process_launches", {
        launch_id: launchId,
        process_receipt_id: processReceiptId,
        repository_id: fixture.store.location.repositoryId,
        attempt_id: fixture.attemptId,
        ownership_id: ownership.ownershipId,
        owner_generation: ownership.generation,
        ownership_context_digest: ownership.contextDigest,
        phase_execution_id: phaseId,
        context_id: contextId,
        execution_context_digest: executionContextDigest,
        spawn_authorization_digest: launchPayloadObject.spawn_authorization_digest,
        pid,
        pgid,
        platform: process.platform,
        boot_identity: "boot-test-identity",
        process_start_identity: `start-${suffix}`,
        argv_digest: launchPayloadObject.argv_digest,
        environment_digest: launchPayloadObject.environment_digest,
        stdout_path: launchPayloadObject.stdout_path,
        stderr_path: launchPayloadObject.stderr_path,
        output_limit_bytes: 1024,
        tail_limit_bytes: 128,
        process_group_expected_version: 0,
        stdout_expected_version: 0,
        stderr_expected_version: 0,
        launch_evidence_id: launchEvidenceId,
        created_at: observedAt,
      });
    }
    insert(database, "evidence", {
      evidence_id: evidenceId,
      attempt_id: fixture.attemptId,
      phase_execution_id: phaseId,
      context_id: contextId,
      producer_service: "ProcessSupervisor",
      scope: `attempt:${fixture.attemptId}:process-death`,
      schema_version: "rickgent.process-group-death.v1",
      content_digest: digest(payload),
      inline_payload_json: payload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: `death:${ownership.ownershipId}:${suffix}`,
      created_at: observedAt,
    });
    if (linkProcessReceipt) {
      const payloadDigest = digest(payload);
      insert(database, "attempt_process_observations", {
        observation_id: observationId,
        launch_id: launchId,
        attempt_id: fixture.attemptId,
        sequence: 1,
        kind: "group_death",
        evidence_id: evidenceId,
        schema_version: "rickgent.process-group-death.v1",
        payload_digest: payloadDigest,
        created_at: observedAt,
      });
      const terminalPayload = canonicalJson({
        schema_version: "rickgent.process-terminal.v1",
        launch_id: launchId,
        process_receipt_id: processReceiptId,
        outcome: "exited",
        exit_code: 0,
        signal: null,
        timed_out: false,
        group_dead: true,
        descendants_confirmed_dead: descendantsConfirmedDead,
        observation_refs: [{
          observation_id: observationId,
          sequence: 1,
          kind: "group_death",
          evidence_id: evidenceId,
          schema_version: "rickgent.process-group-death.v1",
          payload_digest: payloadDigest,
          created_at: observedAt,
        }],
        created_at: observedAt,
      });
      insert(database, "attempt_process_terminal_receipts", {
        process_receipt_id: processReceiptId,
        launch_id: launchId,
        attempt_id: fixture.attemptId,
        outcome: "exited",
        exit_code: 0,
        signal: null,
        timed_out: 0,
        group_dead: 1,
        descendants_confirmed_dead: descendantsConfirmedDead ? 1 : 0,
        observation_count: 1,
        result_digest: digest(terminalPayload),
        created_at: observedAt,
      });
    }
  } finally {
    database.close();
  }
  return evidenceId;
}

describe("owner-checked attempt ownership", () => {
  it("atomically acquires one credential and the complete fixed resource set with response-loss replay", () => {
    const fixture = seed();
    try {
      const authority = new LeaseAuthority(fixture.store);
      const prepared = authority.prepareAcquisition({ attemptId: fixture.attemptId, idempotencyKey: "acquire:one" });
      expect(isAuthorizedAttemptOwnershipCommand(prepared.command)).toBe(true);
      const grant = authority.acquire(prepared);
      expect(grant.ownership).toMatchObject({ generation: 1, state: "live", stateVersion: 0 });
      expect(grant.resources).toHaveLength(11);
      expect(new Set(grant.resources.map((resource) => resource.slot)).size).toBe(11);
      expect(grant.resources.every((resource) => resource.slot === resource.kind && resource.state === "reserved")).toBe(true);
      expect(JSON.stringify(grant)).not.toContain("base64url");
      expect(all(fixture.store.location.databasePath, "SELECT * FROM attempt_ownership_leases")).toHaveLength(1);
      expect(all(fixture.store.location.databasePath, "SELECT * FROM attempt_resource_claims")).toHaveLength(11);

      const replay = authority.acquire(prepared);
      expect(replay.replayed).toBe(true);
      expect(replay.ownership.ownershipId).toBe(grant.ownership.ownershipId);
      expect(all(fixture.store.location.databasePath, "SELECT * FROM attempt_ownership_operations")).toHaveLength(1);

      const loser = authority.prepareAcquisition({ attemptId: fixture.attemptId, idempotencyKey: "acquire:two" });
      expectCode(() => authority.acquire(loser), "RICKGENT_STATE_CONFLICT");
      expect(() => fixture.store.commitAuthorizedAttemptOwnership({} as never)).toThrow(TypeError);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects stale versions and forged resource truth while replaying the sealed committed result", () => {
    const fixture = seed("cas");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({ attemptId: fixture.attemptId, idempotencyKey: "acquire" }));
      const heartbeat = authority.heartbeat({ ownership: grant, idempotencyKey: "heartbeat:1" });
      expect(heartbeat.ownership.stateVersion).toBe(1);
      expectCode(() => authority.heartbeat({ ownership: grant, idempotencyKey: "heartbeat:stale" }), "RICKGENT_STATE_CONFLICT");
      expectCode(() => authority.beginCleanup({ ownership: grant, idempotencyKey: "cleanup:stale" }), "RICKGENT_STATE_CONFLICT");

      expect(() => authority.advanceWorkspaceResource({
        ownership: heartbeat,
        receipt: {} as never,
        idempotencyKey: "resource:forged",
      })).toThrow(TypeError);

      const cleanup = authority.beginCleanup({ ownership: heartbeat, idempotencyKey: "cleanup" });
      expect(cleanup.resources.every((resource) => resource.state === "cleanup_pending")).toBe(true);
      const replay = authority.heartbeat({ ownership: grant, idempotencyKey: "heartbeat:1" });
      expect(replay).toMatchObject({
        replayed: true,
        ownership: { state: "live", stateVersion: 1 },
        currentOwnership: { state: "cleanup_pending", stateVersion: 2 },
      });
      expectCode(() => authority.assertFresh(cleanup), "RICKGENT_STATE_OWNER_MISMATCH");
      expect("release" in authority).toBe(false);
      expect("quarantine" in authority).toBe(false);
    } finally {
      fixture.store.close();
    }
  });

  it("provisions a detached attempt worktree and isolated index without changing dirty caller state", () => {
    const fixture = seed("workspace");
    try {
      writeFileSync(join(fixture.repo, "caller-dirty.txt"), "preserve me\n", "utf8");
      const callerBefore = git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all");
      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({ attemptId: fixture.attemptId, idempotencyKey: "acquire" }));
      const hostileGitEnvironment = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      process.env.GIT_DIR = join(fixture.repo, "foreign-git-dir");
      process.env.GIT_WORK_TREE = join(fixture.repo, "foreign-work-tree");
      process.env.GIT_INDEX_FILE = join(fixture.repo, "foreign-index");
      let result: ReturnType<typeof provisionAttemptWorkspace>;
      try {
        result = provisionAttemptWorkspace(authority, grant);
      } finally {
        for (const [name, value] of Object.entries(hostileGitEnvironment)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
      expect(result.ok).toBe(true);
      expect(isAuthorizedAttemptWorkspaceSpawnAuthorization(result.authorization)).toBe(true);
      const workspace = result.workspace;
      expect(git(fixture.repo, "rev-parse", `${workspace.deliveryRef}^{commit}`)).toBe(fixture.baselineOid);
      expect(git(fixture.repo, "rev-parse", `${workspace.attemptRef}^{commit}`)).toBe(fixture.baselineOid);
      expect(git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(fixture.baselineOid);
      expect(() => git(workspace.worktreePath, "symbolic-ref", "-q", "HEAD")).toThrow();
      expect(lstatSync(workspace.allocationRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(workspace.isolatedIndexPath).mode & 0o777).toBe(0o600);
      expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(callerBefore);
      expect(readFileSync(join(fixture.repo, "caller-dirty.txt"), "utf8")).toBe("preserve me\n");
      const ready = attemptWorkspaceReadyForSpawn(authority, workspace);
      expect(ready).toMatchObject({ ready: true, ownership: { ownership: { state: "live" } } });
      if (!ready.ready) throw new Error(ready.detail);
      expect(isAuthorizedAttemptWorkspaceSpawnAuthorization(ready.authorization)).toBe(true);
      expect(ready.authorization).toMatchObject({
        deliveryRef: workspace.deliveryRef,
        baselineOid: workspace.baselineOid,
        attemptRef: workspace.attemptRef,
        worktreePath: workspace.worktreePath,
        worktreeGitDirectory: workspace.worktreeGitDirectory,
        isolatedIndexPath: workspace.isolatedIndexPath,
      });
      expect(() => attemptWorkspaceReadyForSpawn(authority, {
        ...workspace,
        worktreePath: fixture.repo,
      } as never)).toThrow(TypeError);
      expect(all(fixture.store.location.databasePath, "SELECT state FROM attempt_ownership_leases")).toEqual([{ state: "live" }]);

      writeFileSync(join(workspace.worktreePath, "foreign.txt"), "foreign\n", "utf8");
      const dirty = attemptWorkspaceReadyForSpawn(authority, workspace);
      expect(dirty).toMatchObject({
        ready: false,
        code: "dirty",
        ownership: { ownership: { state: "cleanup_pending" } },
      });
      expect(all(fixture.store.location.databasePath, "SELECT state FROM attempt_ownership_leases")).toEqual([{ state: "cleanup_pending" }]);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a stale readiness grant before touching the isolated index", () => {
    const fixture = seed("readiness-stale");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
      }));
      const provisioned = provisionAttemptWorkspace(authority, grant);
      if (!provisioned.ok) throw new Error(`${provisioned.code}: ${provisioned.detail}`);
      const indexBefore = readFileSync(provisioned.workspace.isolatedIndexPath);
      const database = new DatabaseSync(fixture.store.location.databasePath);
      try {
        database.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE ownership_id = ?
        `).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", provisioned.workspace.ownership.ownership.ownershipId);
      } finally {
        database.close();
      }
      const deathEvidenceId = appendDeathEvidence(fixture, {
        ...provisioned.workspace.ownership.ownership,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      }, "readiness-handoff");
      const recovery = authority.recoverStale(authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: provisioned.workspace.ownership.ownership.ownershipId,
        deathEvidenceId,
        idempotencyKey: "recovery",
      }));
      expect(recovery.ownership).toMatchObject({ generation: 2, state: "cleanup_pending" });
      expect(attemptWorkspaceReadyForSpawn(authority, provisioned.workspace)).toMatchObject({
        ready: false,
        code: "unavailable",
      });
      expect(readFileSync(provisioned.workspace.isolatedIndexPath)).toEqual(indexBefore);
      expect(all(fixture.store.location.databasePath, "SELECT generation, state FROM attempt_ownership_leases ORDER BY generation")).toEqual([
        { generation: 1, state: "quarantined" },
        { generation: 2, state: "cleanup_pending" },
      ]);
    } finally {
      fixture.store.close();
    }
  });

  it("revalidates the exact worktree administrative directory at the final readiness edge", () => {
    const fixture = seed("worktree-admin-boundary");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
      }));
      const provisioned = provisionAttemptWorkspace(authority, grant);
      if (!provisioned.ok) throw new Error(`${provisioned.code}: ${provisioned.detail}`);
      const decoy = join(dirname(fixture.repo), "decoy-worktree");
      git(fixture.repo, "worktree", "add", "--detach", "--quiet", decoy, fixture.baselineOid);
      const decoyGitDirectory = realpathSync(git(decoy, "rev-parse", "--path-format=absolute", "--git-dir"));
      writeFileSync(join(provisioned.workspace.worktreePath, ".git"), `gitdir: ${decoyGitDirectory}\n`, "utf8");
      expect(attemptWorkspaceReadyForSpawn(authority, provisioned.workspace)).toMatchObject({
        ready: false,
        code: "identity_changed",
        ownership: { ownership: { state: "cleanup_pending" } },
      });
    } finally {
      fixture.store.close();
    }
  });

  it("pins every workspace observation to the StateStore-selected Git common directory", () => {
    const fixture = seed("git-boundary", true);
    const foreign = makeRepo();
    try {
      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
      }));
      const provisioned = provisionAttemptWorkspace(authority, grant);
      if (!provisioned.ok) throw new Error(`${provisioned.code}: ${provisioned.detail}`);
      writeFileSync(join(fixture.repo, ".git"), `gitdir: ${join(foreign, ".git")}\n`, "utf8");
      const readiness = attemptWorkspaceReadyForSpawn(authority, provisioned.workspace);
      expect(readiness).toMatchObject({
        ready: false,
        code: "unavailable",
        ownership: { ownership: { state: "cleanup_pending" } },
      });
      expect(() => git(foreign, "rev-parse", "--verify", grant.plan.attemptRef)).toThrow();
    } finally {
      fixture.store.close();
    }
  });

  it("rejects traversal inputs and preserves symlinked or colliding foreign resources under cleanup containment", () => {
    const fixture = seed("foreign");
    try {
      expect(() => deriveAttemptWorkspacePlan(fixture.store.location, {
        repositoryId: fixture.store.location.repositoryId,
        runId: "../escape",
        ticketInstanceId: fixture.ticketInstanceId,
        ticketId: "ticket-foreign",
        attemptId: fixture.attemptId,
        attemptNumber: 1,
        contractDigest: fixture.contractDigest,
        resourceIdentityVersion: "rickgent.attempt-resource-identity/v1",
        deliveryBaselineOid: fixture.baselineOid,
        deliveryRef: `refs/rickgent/runs/${fixture.runId}/delivery`,
      })).toThrow(TypeError);

      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({ attemptId: fixture.attemptId, idempotencyKey: "acquire" }));
      const foreign = join(realpathSync(join(fixture.repo, "..")), "foreign-target");
      mkdirSync(foreign);
      symlinkSync(foreign, grant.plan.allocationRoot);
      const result = provisionAttemptWorkspace(authority, grant);
      expect(result).toMatchObject({ ok: false, code: "ATTEMPT_WORKSPACE_FOREIGN_RESOURCE" });
      expect(lstatSync(grant.plan.allocationRoot).isSymbolicLink()).toBe(true);
      expect(all(fixture.store.location.databasePath, "SELECT state FROM attempt_ownership_leases")).toEqual([{ state: "cleanup_pending" }]);
      expect(all(fixture.store.location.databasePath, "SELECT DISTINCT state FROM attempt_resource_claims")).toEqual([{ state: "cleanup_pending" }]);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects expired ownership before creating any attempt side effect", async () => {
    const fixture = seed("expired");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const grant = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
        ttlMs: 1_000,
      }));
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const result = provisionAttemptWorkspace(authority, grant);
      expect(result.ok).toBe(false);
      expect(() => lstatSync(grant.plan.allocationRoot)).toThrow();
      expect(() => git(fixture.repo, "rev-parse", "--verify", grant.plan.attemptRef)).toThrow();
      expect(all(fixture.store.location.databasePath, "SELECT state FROM attempt_ownership_leases")).toEqual([{ state: "cleanup_pending" }]);
    } finally {
      fixture.store.close();
    }
  });

  it("binds prepared commands and grants to one canonical StateStore repository", () => {
    const left = seed("cross-store");
    const right = seed("cross-store");
    try {
      const leftAuthority = new LeaseAuthority(left.store);
      const rightAuthority = new LeaseAuthority(right.store);
      const prepared = leftAuthority.prepareAcquisition({ attemptId: left.attemptId, idempotencyKey: "acquire" });
      expectCode(() => rightAuthority.acquire(prepared), "RICKGENT_STATE_OWNER_MISMATCH");
      const grant = leftAuthority.acquire(prepared);
      expect(() => rightAuthority.heartbeat({ ownership: grant, idempotencyKey: "foreign-heartbeat" })).toThrow(TypeError);
    } finally {
      left.store.close();
      right.store.close();
    }
  });

  it("rejects process-death evidence whose process receipt identity is not durable", () => {
    const fixture = seed("recovery-unlinked");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const original = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
        ttlMs: 1_000,
      }));
      const database = new DatabaseSync(fixture.store.location.databasePath);
      try {
        database.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE ownership_id = ?
        `).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", original.ownership.ownershipId);
      } finally {
        database.close();
      }
      const deathEvidenceId = appendDeathEvidence(fixture, {
        ...original.ownership,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      }, "unlinked", new Date().toISOString(), false);
      expectCode(() => authority.recoverStale(authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: original.ownership.ownershipId,
        deathEvidenceId,
        idempotencyKey: "recovery:unlinked",
      })), "RICKGENT_STATE_OWNER_MISMATCH");
    } finally {
      fixture.store.close();
    }
  });

  it("rejects durable process-death evidence observed before the latest heartbeat", () => {
    const fixture = seed("recovery-stale-observation");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const original = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
        ttlMs: 1_000,
      }));
      const database = new DatabaseSync(fixture.store.location.databasePath);
      try {
        database.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE ownership_id = ?
        `).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", original.ownership.ownershipId);
      } finally {
        database.close();
      }
      const deathEvidenceId = appendDeathEvidence(fixture, {
        ...original.ownership,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      }, "stale-observation", "2019-01-01T00:00:00.000Z");
      expectCode(() => authority.recoverStale(authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: original.ownership.ownershipId,
        deathEvidenceId,
        idempotencyKey: "recovery:stale-observation",
      })), "RICKGENT_STATE_OWNER_MISMATCH");
    } finally {
      fixture.store.close();
    }
  });

  it("persists partial group-death truth but refuses stale recovery until descendant death is confirmed", () => {
    const fixture = seed("recovery-partial-death");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const original = authority.acquire(authority.prepareAcquisition({
        attemptId: fixture.attemptId,
        idempotencyKey: "acquire",
        ttlMs: 1_000,
      }));
      const database = new DatabaseSync(fixture.store.location.databasePath);
      try {
        database.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE ownership_id = ?
        `).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", original.ownership.ownershipId);
      } finally {
        database.close();
      }
      const deathEvidenceId = appendDeathEvidence(fixture, {
        ...original.ownership,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      }, "partial-death", new Date().toISOString(), true, false);
      expect(all(
        fixture.store.location.databasePath,
        "SELECT group_dead, descendants_confirmed_dead FROM attempt_process_terminal_receipts",
      )).toEqual([{ group_dead: 1, descendants_confirmed_dead: 0 }]);
      expectCode(() => authority.recoverStale(authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: original.ownership.ownershipId,
        deathEvidenceId,
        idempotencyKey: "recovery:partial-death",
      })), "RICKGENT_STATE_OWNER_MISMATCH");
    } finally {
      fixture.store.close();
    }
  });

  it("allows stale cleanup ownership only after expiry and exact immutable process-death evidence", () => {
    const fixture = seed("recovery");
    try {
      const authority = new LeaseAuthority(fixture.store);
      const preparedOriginal = authority.prepareAcquisition({ attemptId: fixture.attemptId, idempotencyKey: "acquire", ttlMs: 1_000 });
      const original = authority.acquire(preparedOriginal);
      expect(() => fixture.store.appendEvidence({ producer_service: "ProcessSupervisor" } as never)).toThrow(TypeError);
      const missingProof = authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: original.ownership.ownershipId,
        deathEvidenceId: "missing",
        idempotencyKey: "recovery:missing",
      });
      expectCode(() => authority.recoverStale(missingProof), "RICKGENT_STATE_OWNER_MISMATCH");

      const database = new DatabaseSync(fixture.store.location.databasePath);
      try {
        database.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE ownership_id = ?
        `).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", original.ownership.ownershipId);
      } finally {
        database.close();
      }
      const expired = {
        ...original.ownership,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      };
      const deathEvidenceId = appendDeathEvidence(fixture, expired);
      const recovery = authority.recoverStale(authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: original.ownership.ownershipId,
        deathEvidenceId,
        idempotencyKey: "recovery:exact",
      }));
      expect(recovery).toMatchObject({ purpose: "recovery_cleanup", ownership: { generation: 2, state: "cleanup_pending" } });
      expect(recovery.resources.every((resource) => resource.currentOwnershipId === recovery.ownership.ownershipId && resource.state === "cleanup_pending")).toBe(true);
      const acquisitionReplay = authority.acquire(preparedOriginal);
      expect(acquisitionReplay).toMatchObject({
        replayed: true,
        ownership: { generation: 1, state: "live", stateVersion: 0 },
        currentOwnership: { generation: 1, state: "quarantined" },
      });
      expect(acquisitionReplay.resources.every((resource) => resource.currentOwnershipId === original.ownership.ownershipId && resource.state === "reserved")).toBe(true);
      expect(acquisitionReplay.currentResources.every((resource) => resource.currentOwnershipId === recovery.ownership.ownershipId && resource.state === "cleanup_pending")).toBe(true);
      expectCode(() => authority.heartbeat({ ownership: original, idempotencyKey: "old-heartbeat" }), "RICKGENT_STATE_CONFLICT");
      expectCode(() => authority.assertFresh(original), "RICKGENT_STATE_OWNER_MISMATCH");

      const recoveryDatabase = new DatabaseSync(fixture.store.location.databasePath);
      try {
        recoveryDatabase.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE ownership_id = ?
        `).run("2020-01-02T00:00:00.000Z", "2020-01-02T00:01:00.000Z", recovery.ownership.ownershipId);
      } finally {
        recoveryDatabase.close();
      }
      const recoveryExpired = { ...recovery.ownership, heartbeatAt: "2020-01-02T00:00:00.000Z" };
      const secondDeath = appendDeathEvidence(fixture, recoveryExpired, "recovery-2");
      const secondRecovery = authority.recoverStale(authority.prepareStaleRecovery({
        attemptId: fixture.attemptId,
        expiredOwnershipId: recovery.ownership.ownershipId,
        deathEvidenceId: secondDeath,
        idempotencyKey: "recovery:second",
      }));
      expect(secondRecovery).toMatchObject({ purpose: "recovery_cleanup", ownership: { generation: 3, state: "cleanup_pending" } });
    } finally {
      fixture.store.close();
    }
  });

  it("serializes a deterministic two-process acquisition race without partial reservations", async () => {
    const fixture = seed("race");
    fixture.store.close();
    const first = fork(raceChild, [fixture.repo], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const second = fork(raceChild, [fixture.repo], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.add(first);
    children.add(second);
    await Promise.all([waitForMessage(first, "ready"), waitForMessage(second, "ready")]);
    const outcomes = [waitForOutcome(first), waitForOutcome(second)];
    first.send("start");
    second.send("start");
    const [left, right] = await Promise.all(outcomes);
    const exits = [waitForExit(first), waitForExit(second)];
    if (first.connected) first.disconnect();
    if (second.connected) second.disconnect();
    await Promise.all(exits);
    expect([left.type, right.type].sort()).toEqual(["error", "result"]);
    expect([left, right].find((outcome) => outcome.type === "error")).toMatchObject({ code: "RICKGENT_STATE_CONFLICT" });
    const reopened = openStateStore({ repoPath: fixture.repo });
    try {
      expect(all(reopened.location.databasePath, "SELECT * FROM attempt_ownership_leases")).toHaveLength(1);
      expect(all(reopened.location.databasePath, "SELECT * FROM attempt_resource_claims")).toHaveLength(11);
      expect(all(reopened.location.databasePath, "SELECT * FROM attempt_ownership_operations")).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
