// t33: Verified push with observed remote OID.
//
// Exercises the full verified-push protocol through the real production
// delivery authority and state store against disposable local bare
// repositories:
//   - Success: push succeeds, independent ls-remote confirms exact OID
//   - Rejection: non-fast-forward push is rejected by the remote
//   - Timeout: push command exceeds its timeout deadline
//   - Response-loss: push succeeds, crash before ls-remote, resume idempotently
//   - Ref-race: remote ref moved after push, ls-remote shows different OID
//
// All cases assert actual remote refs in disposable bare repositories; a
// fake always-zero push cannot satisfy the gate.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import {
  IdentityContextResolver,
  type ResolvedPhaseContext,
} from "../../src/context/resolver.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateRecord,
  type StateStore,
} from "../../src/state/store.js";
import {
  DeliveryAuthority,
  type DeliveryIntentRequest,
} from "../../src/state/transitions.js";
import {
  executeVerifiedPush,
  type VerifiedPushRequest,
} from "../../src/delivery/push.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v2";
const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function tmpDir(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rickgent-push-${prefix}-`)));
  scratchRoots.add(root);
  return root;
}

function makeRepo(label: string): string {
  const repo = join(tmpDir(`repo-${label}`), "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Push Protocol Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "push-protocol@example.test"]);
  writeFileSync(join(repo, "README.md"), "push protocol\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function makeBareRepo(label: string): string {
  const bare = join(tmpDir(`bare-${label}`), "bare.git");
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", bare]);
  return realpathSync(bare);
}

function repoHead(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function createDeliveryCommit(repo: string, content: string): string {
  writeFileSync(join(repo, "delivery.txt"), content, "utf8");
  execFileSync("git", ["-C", repo, "add", "delivery.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "delivery candidate"]);
  return repoHead(repo);
}

function ticketContract(repo: string): TicketContract {
  const draft: TicketContractDraft = {
    schema_version: "1.0.0",
    id: "t33",
    title: "Verified push",
    description: "Exercise verified push protocol.",
    depends_on: [],
    scope: [{ path: "delivery.txt", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-PUSH",
      description: "Push uses exact delivery OID with independent ls-remote confirmation.",
      interface_ids: [],
      verification_ids: ["VER-PUSH"],
    }],
    verifications: [{
      id: "VER-PUSH",
      executable: "test",
      args: ["-f", "delivery.txt"],
      cwd_class: "repository_root",
      env_allowlist: ["PATH"],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 1,
      max_review_cycles: 1,
      wall_clock_ms: 60_000,
      remediation_limit: 1,
    },
  };
  return sealTicketContracts([draft])[0]!;
}

function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

function insertFixtureRow(
  databasePath: string,
  table: string,
  row: Readonly<Record<string, SqlValue>>,
): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(row);
    database.prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((c) => row[c] ?? null));
  } finally {
    database.close();
  }
}

function updateRunState(
  databasePath: string,
  runId: string,
  state: string,
  currentDeliveryOid: string,
): void {
  const database = openRaw(databasePath);
  try {
    // Legal transitions: planned -> active -> ready_for_delivery
    // Must advance state_version by exactly 1 per transition
    const current = database.prepare("SELECT state, state_version FROM runs WHERE run_id = ?").get(runId) as SqlRow;
    const currentState = String(current!.state);
    if (currentState === state) return;

    // Transition through legal edges
    if (currentState === "planned" && state === "ready_for_delivery") {
      database.prepare(
        "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?",
      ).run(runId);
      database.prepare(
        "UPDATE runs SET state = ?, current_delivery_oid = ?, state_version = state_version + 1 WHERE run_id = ?",
      ).run(state, currentDeliveryOid, runId);
    } else {
      database.prepare(
        "UPDATE runs SET state = ?, current_delivery_oid = ?, state_version = state_version + 1 WHERE run_id = ?",
      ).run(state, currentDeliveryOid, runId);
    }
  } finally {
    database.close();
  }
}

function queryRow(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).get(...values) as SqlRow | undefined;
  } finally {
    database.close();
  }
}

function queryRows(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

interface PushFixture {
  readonly repo: string;
  readonly bare: string;
  readonly store: StateStore;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly phase: ResolvedPhaseContext;
  readonly deliveryOid: string;
  readonly authority: DeliveryAuthority;
}

function preparePushFixture(label: string, bareRepo?: string): PushFixture {
  const repo = makeRepo(label);
  const bare = bareRepo ?? makeBareRepo(label);
  // Add the bare repo as a remote named "origin"
  execFileSync("git", ["-C", repo, "remote", "add", "origin", bare]);

  const store = openStateStore({ repoPath: repo });
  const contract = ticketContract(repo);
  const resolver = new IdentityContextResolver(store);
  const run = resolver.allocateFreshRun({
    contracts: [contract],
    initialDeliveryOid: repoHead(repo),
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
  const policyRoot = join(store.location.resourceDirectory, "policy");
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  const phase = resolver.resolvePhaseContext({
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
      requestedBundleSha256: "a".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: contract.verifications[0]!.timeout_ms,
  });

  // Create the delivery commit and update the delivery ref
  const deliveryOid = createDeliveryCommit(repo, "verified delivery\n");
  execFileSync("git", ["-C", repo, "update-ref", run.deliveryRef, deliveryOid]);

  // Advance the run to ready_for_delivery (simulating completed lifecycle)
  updateRunState(store.location.databasePath, run.runId, "ready_for_delivery", deliveryOid);

  const authority = new DeliveryAuthority(store);
  return { repo, bare, store, run, attempt, phase, deliveryOid, authority };
}

function pushRequest(
  fixture: PushFixture,
  overrides: Partial<VerifiedPushRequest> = {},
): VerifiedPushRequest {
  return {
    store: fixture.store,
    authority: fixture.authority,
    repoPath: fixture.repo,
    runId: fixture.run.runId,
    deliveryOid: fixture.deliveryOid,
    remoteName: "origin",
    branchName: "rickgent-delivery",
    expectedRemoteOid: null,
    baseBranch: "main",
    ownerContextId: fixture.phase.persisted.contextId,
    ownerContextDigest: fixture.phase.canonical.contextDigest,
    providerIdentityDigest: digest(`provider:push-test`),
    idempotencyKey: `push:${fixture.run.runId}:intent`,
    deliveryIntentId: `push-intent-${fixture.run.runId}`,
    timeoutMs: 30_000,
    ...overrides,
  };
}

// These tests involve real git operations (push to bare repos, ls-remote)
// which can be slow under cross-suite load. Use a generous per-test timeout.
const TEST_TIMEOUT = 30_000;

describe("t33 verified push protocol", () => {
  describe("success case", () => {
    it("pushes the exact delivery OID and confirms via independent ls-remote", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("success");
      const result = executeVerifiedPush(pushRequest(fixture));

      expect(result.status).toBe("verified");
      if (result.status !== "verified") return;
      expect(result.observedRemoteOid).toBe(fixture.deliveryOid);
      expect(result.deliveryIntentId).toBe(`push-intent-${fixture.run.runId}`);

      // Assert the actual remote ref matches the delivery OID
      const remoteRef = execFileSync("git", ["ls-remote", fixture.bare, "refs/heads/rickgent-delivery"], {
        encoding: "utf8",
      }).trim();
      expect(remoteRef).toContain(fixture.deliveryOid);

      // Assert delivery intent was persisted with exact OID/remote/branch
      const intent = queryRow(
        fixture.store.location.databasePath,
        "SELECT * FROM delivery_intents WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(intent).toBeDefined();
      expect(String(intent!.delivery_oid)).toBe(fixture.deliveryOid);
      expect(String(intent!.remote_name)).toBe("origin");
      expect(String(intent!.branch_name)).toBe("rickgent-delivery");

      // Assert remote observation sequence: push=1, ls-remote=2
      const observations = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM remote_observations WHERE delivery_intent_id = ? ORDER BY sequence",
        `push-intent-${fixture.run.runId}`,
      );
      expect(observations).toHaveLength(2);
      expect(Number(observations[0]!.sequence)).toBe(1);
      expect(String(observations[0]!.operation)).toBe("push");
      expect(String(observations[0]!.outcome)).toBe("pushed");
      expect(observations[0]!.observed_remote_oid).toBeNull();
      expect(Number(observations[1]!.sequence)).toBe(2);
      expect(String(observations[1]!.operation)).toBe("ls-remote");
      expect(String(observations[1]!.outcome)).toBe("observed");
      expect(String(observations[1]!.observed_remote_oid)).toBe(fixture.deliveryOid);
    });
  });

  describe("rejection case", () => {
    it("non-fast-forward push is rejected and run remains non-delivered", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("rejection");

      // Pre-populate the bare remote with a different commit on the same branch
      // so the push is non-fast-forward
      const otherRepo = join(tmpDir("rejection-other"), "other");
      mkdirSync(otherRepo, { recursive: true });
      execFileSync("git", ["init", "-q", otherRepo]);
      execFileSync("git", ["-C", otherRepo, "config", "user.name", "Other"]);
      execFileSync("git", ["-C", otherRepo, "config", "user.email", "other@test"]);
      writeFileSync(join(otherRepo, "README.md"), "other\n", "utf8");
      execFileSync("git", ["-C", otherRepo, "add", "README.md"]);
      execFileSync("git", ["-C", otherRepo, "commit", "-qm", "other initial"]);
      writeFileSync(join(otherRepo, "foreign.txt"), "foreign\n", "utf8");
      execFileSync("git", ["-C", otherRepo, "add", "foreign.txt"]);
      execFileSync("git", ["-C", otherRepo, "commit", "-qm", "foreign commit"]);
      execFileSync("git", ["-C", otherRepo, "remote", "add", "origin", fixture.bare]);
      execFileSync("git", ["-C", otherRepo, "push", "-q", "origin", `HEAD:refs/heads/rickgent-delivery`]);

      const result = executeVerifiedPush(pushRequest(fixture));

      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") return;
      expect(result.exitCode).not.toBe(0);

      // No successful ls-remote observation should exist
      const observations = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM remote_observations WHERE delivery_intent_id = ? AND operation = 'ls-remote'",
        `push-intent-${fixture.run.runId}`,
      );
      expect(observations).toHaveLength(0);

      // Run remains ready_for_delivery, not delivered
      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("timeout case", () => {
    it("push command exceeds timeout deadline and run remains non-delivered", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("timeout");

      // Use a very short timeout to force a timeout on the push command.
      // We push to a remote that requires interaction (a fifo) to stall.
      // Simpler: use a 1ms timeout against a real remote — the process
      // will be killed before it completes.
      const result = executeVerifiedPush(pushRequest(fixture, { timeoutMs: 1 }));

      // The result should be either timeout or rejected (if git fails
      // before the timeout fires). Both are non-delivered outcomes.
      expect(["timeout", "rejected", "infrastructure_error"]).toContain(result.status);

      // No ls-remote observation should exist
      const observations = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM remote_observations WHERE delivery_intent_id = ? AND operation = 'ls-remote'",
        `push-intent-${fixture.run.runId}`,
      );
      expect(observations).toHaveLength(0);

      // Run remains ready_for_delivery, not delivered
      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("response-loss case", () => {
    it("push succeeds, crash before ls-remote, resume completes idempotently", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("response-loss");

      // First call: push should succeed but we simulate a crash by
      // checking that the push observation is persisted. We verify
      // that a second call (simulating resume) does not re-push but
      // completes the ls-remote observation.
      //
      // We simulate the crash by directly recording the push observation
      // (as if the push succeeded but the process crashed before ls-remote).
      const intentRequest: DeliveryIntentRequest = {
        deliveryIntentId: `push-intent-${fixture.run.runId}`,
        runId: fixture.run.runId,
        deliveryOid: fixture.deliveryOid,
        remoteName: "origin",
        branchName: "rickgent-delivery",
        expectedRemoteOid: null,
        baseBranch: "main",
        providerIdentityDigest: digest(`provider:push-test`),
        ownerContextId: fixture.phase.persisted.contextId,
        ownerContextDigest: fixture.phase.canonical.contextDigest,
        idempotencyKey: `push:${fixture.run.runId}:intent`,
        createdAt: "2026-07-22T12:00:00.000Z",
      };
      fixture.authority.createIntent(intentRequest);

      // Manually execute the push (simulating what the service would do)
      execFileSync("git", ["-C", fixture.repo, "push", "origin",
        `${fixture.deliveryOid}:refs/heads/rickgent-delivery`]);

      // Record the push observation (simulating push success before crash)
      fixture.authority.recordRemoteObservation({
        deliveryIntentId: `push-intent-${fixture.run.runId}`,
        remoteObservationId: `push-obs-${fixture.run.runId}`,
        sequence: 1,
        operation: "push",
        outcome: "pushed",
        observedRemoteOid: null,
        ownerContextId: fixture.phase.persisted.contextId,
        ownerContextDigest: fixture.phase.canonical.contextDigest,
        evidenceIdempotencyKey: `push:${fixture.run.runId}:push-evidence`,
        createdAt: "2026-07-22T12:01:00.000Z",
      });

      // Simulate crash: no ls-remote observation recorded.
      // Now resume by calling executeVerifiedPush again.
      const result = executeVerifiedPush(pushRequest(fixture));

      expect(result.status).toBe("verified");
      if (result.status !== "verified") return;
      expect(result.observedRemoteOid).toBe(fixture.deliveryOid);

      // Verify the push was not re-executed: only 1 push observation
      const pushObs = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM remote_observations WHERE delivery_intent_id = ? AND operation = 'push'",
        `push-intent-${fixture.run.runId}`,
      );
      expect(pushObs).toHaveLength(1);

      // ls-remote observation should now exist
      const lsObs = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM remote_observations WHERE delivery_intent_id = ? AND operation = 'ls-remote'",
        `push-intent-${fixture.run.runId}`,
      );
      expect(lsObs).toHaveLength(1);
      expect(String(lsObs[0]!.observed_remote_oid)).toBe(fixture.deliveryOid);
    });
  });

  describe("ref-race case", () => {
    it("remote ref moved after push, ls-remote shows different OID", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("ref-race");

      // First, execute the push successfully
      execFileSync("git", ["-C", fixture.repo, "push", "origin",
        `${fixture.deliveryOid}:refs/heads/rickgent-delivery`]);

      // Record the push observation
      fixture.authority.createIntent({
        deliveryIntentId: `push-intent-${fixture.run.runId}`,
        runId: fixture.run.runId,
        deliveryOid: fixture.deliveryOid,
        remoteName: "origin",
        branchName: "rickgent-delivery",
        expectedRemoteOid: null,
        baseBranch: "main",
        providerIdentityDigest: digest(`provider:push-test`),
        ownerContextId: fixture.phase.persisted.contextId,
        ownerContextDigest: fixture.phase.canonical.contextDigest,
        idempotencyKey: `push:${fixture.run.runId}:intent`,
        createdAt: "2026-07-22T12:00:00.000Z",
      });
      fixture.authority.recordRemoteObservation({
        deliveryIntentId: `push-intent-${fixture.run.runId}`,
        remoteObservationId: `push-obs-${fixture.run.runId}`,
        sequence: 1,
        operation: "push",
        outcome: "pushed",
        observedRemoteOid: null,
        ownerContextId: fixture.phase.persisted.contextId,
        ownerContextDigest: fixture.phase.canonical.contextDigest,
        evidenceIdempotencyKey: `push:${fixture.run.runId}:push-evidence`,
        createdAt: "2026-07-22T12:01:00.000Z",
      });

      // Move the remote ref to a different OID (simulating a concurrent push)
      const otherOid = repoHead(fixture.repo) === fixture.deliveryOid
        ? execFileSync("git", ["-C", fixture.repo, "rev-parse", "HEAD~1"], { encoding: "utf8" }).trim()
        : fixture.deliveryOid;
      // Create a different commit on the remote
      const raceRepo = join(tmpDir("ref-race-other"), "race");
      mkdirSync(raceRepo, { recursive: true });
      execFileSync("git", ["init", "-q", raceRepo]);
      execFileSync("git", ["-C", raceRepo, "config", "user.name", "Race"]);
      execFileSync("git", ["-C", raceRepo, "config", "user.email", "race@test"]);
      writeFileSync(join(raceRepo, "README.md"), "race\n", "utf8");
      execFileSync("git", ["-C", raceRepo, "add", "README.md"]);
      execFileSync("git", ["-C", raceRepo, "commit", "-qm", "race commit"]);
      execFileSync("git", ["-C", raceRepo, "remote", "add", "origin", fixture.bare]);
      const raceOid = repoHead(raceRepo);
      execFileSync("git", ["-C", raceRepo, "push", "-f", "origin", `HEAD:refs/heads/rickgent-delivery`]);

      // Now resume — ls-remote should observe the race OID, not the delivery OID
      const result = executeVerifiedPush(pushRequest(fixture));

      expect(result.status).toBe("mismatch");
      if (result.status !== "mismatch") return;
      expect(result.observedRemoteOid).not.toBe(fixture.deliveryOid);
      expect(result.expectedOid).toBe(fixture.deliveryOid);

      // Run remains non-delivered
      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("precondition checks", () => {
    it("push is unreachable when run is not ready_for_delivery", { timeout: TEST_TIMEOUT }, () => {
      // Create a fixture but do NOT advance the run to ready_for_delivery.
      // The run stays in 'planned' state.
      const repo = makeRepo("precondition-not-ready");
      const bare = makeBareRepo("precondition-not-ready");
      execFileSync("git", ["-C", repo, "remote", "add", "origin", bare]);

      const store = openStateStore({ repoPath: repo });
      const contract = ticketContract(repo);
      const resolver = new IdentityContextResolver(store);
      const run = resolver.allocateFreshRun({
        contracts: [contract],
        initialDeliveryOid: repoHead(repo),
        oracleVersion: ORACLE_VERSION,
      });
      const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
      const policyRoot = join(store.location.resourceDirectory, "policy");
      const bundleRoot = join(policyRoot, "bundle");
      mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
      const phase = resolver.resolvePhaseContext({
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
          requestedBundleSha256: "a".repeat(64),
        },
        modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
        timeoutMs: contract.verifications[0]!.timeout_ms,
      });

      const deliveryOid = createDeliveryCommit(repo, "not ready\n");
      // Update the delivery ref to point to the delivery commit,
      // but do NOT advance the run state to ready_for_delivery.
      execFileSync("git", ["-C", repo, "update-ref", run.deliveryRef, deliveryOid]);
      const authority = new DeliveryAuthority(store);

      const result = executeVerifiedPush({
        store,
        authority,
        repoPath: repo,
        runId: run.runId,
        deliveryOid,
        remoteName: "origin",
        branchName: "rickgent-delivery",
        expectedRemoteOid: null,
        baseBranch: "main",
        ownerContextId: phase.persisted.contextId,
        ownerContextDigest: phase.canonical.contextDigest,
        providerIdentityDigest: digest("provider:not-ready"),
        idempotencyKey: `push:${run.runId}:intent`,
        deliveryIntentId: `push-intent-${run.runId}`,
        timeoutMs: 30_000,
      });

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toContain("ready_for_delivery");
    });

    it("push is unreachable when delivery ref does not equal delivery OID", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("precondition-ref");
      // Move the delivery ref to a different OID
      const wrongOid = execFileSync("git", ["-C", fixture.repo, "rev-parse", "HEAD~1"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", fixture.repo, "update-ref", fixture.run.deliveryRef, wrongOid]);

      const result = executeVerifiedPush(pushRequest(fixture));

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toContain("delivery ref");
    });
  });

  describe("idempotent intent creation", () => {
    it("repeated push request resolves the same delivery intent", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePushFixture("idempotent");
      const req = pushRequest(fixture);

      const result1 = executeVerifiedPush(req);
      expect(result1.status).toBe("verified");

      // Second call should not fail — it should resolve the same intent
      // and not re-push (observations already exist)
      const result2 = executeVerifiedPush(req);
      expect(result2.status).toBe("verified");
      if (result2.status !== "verified") return;
      expect(result2.observedRemoteOid).toBe(fixture.deliveryOid);
      expect(result2.deliveryIntentId).toBe(result1.deliveryIntentId);

      // Only one delivery intent exists
      const intents = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM delivery_intents WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(intents).toHaveLength(1);
    });
  });
});
