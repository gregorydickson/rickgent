// t34: Verified and idempotent pull-request creation.
//
// Exercises the full verified-PR protocol through the real production
// delivery authority and state store:
//   - Success: PR created after verified push, head OID equals delivery OID
//   - No-push rejection: PR creation impossible before verified push observation
//   - Wrong repository: PR repository identity mismatch, fail closed
//   - Wrong head: PR head OID differs from delivery OID, fail closed
//   - Existing wrong-head PR: PR exists with wrong head, fail closed
//   - Missing gh: provider unavailable, fail closed
//   - Malformed JSON: provider returns invalid JSON, fail closed
//   - Auth failure: provider returns auth error, fail closed
//   - Timeout: provider exceeds deadline, fail closed
//   - Response-loss (crash after create, before observation): resume resolves same PR
//   - Idempotent retry: repeated call resolves same PR without duplicate
//   - Repository identity equality required: different repo, fail closed
//
// All cases assert no delivered/Done state on failure paths.

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
import {
  executeVerifiedPullRequest,
  type PrProvider,
  type PrProviderResult,
  type VerifiedPrRequest,
} from "../../src/delivery/pull-request.js";

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rickgent-pr-${prefix}-`)));
  scratchRoots.add(root);
  return root;
}

function makeRepo(label: string): string {
  const repo = join(tmpDir(`repo-${label}`), "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "PR Protocol Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "pr-protocol@example.test"]);
  writeFileSync(join(repo, "README.md"), "pr protocol\n", "utf8");
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
    id: "t34",
    title: "Verified PR",
    description: "Exercise verified PR protocol.",
    depends_on: [],
    scope: [{ path: "delivery.txt", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-PR",
      description: "PR creation requires verified push and head OID equality.",
      interface_ids: [],
      verification_ids: ["VER-PR"],
    }],
    verifications: [{
      id: "VER-PR",
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

function updateRunState(
  databasePath: string,
  runId: string,
  state: string,
  currentDeliveryOid: string,
): void {
  const database = openRaw(databasePath);
  try {
    const current = database.prepare("SELECT state, state_version FROM runs WHERE run_id = ?").get(runId) as SqlRow;
    const currentState = String(current!.state);
    if (currentState === state) return;

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

interface PrFixture {
  readonly repo: string;
  readonly bare: string;
  readonly store: StateStore;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly phase: ResolvedPhaseContext;
  readonly deliveryOid: string;
  readonly authority: DeliveryAuthority;
  readonly deliveryIntentId: string;
}

function preparePrFixture(label: string): PrFixture {
  const repo = makeRepo(label);
  const bare = makeBareRepo(label);
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

  const deliveryOid = createDeliveryCommit(repo, "verified delivery\n");
  execFileSync("git", ["-C", repo, "update-ref", run.deliveryRef, deliveryOid]);
  updateRunState(store.location.databasePath, run.runId, "ready_for_delivery", deliveryOid);

  const authority = new DeliveryAuthority(store);
  const deliveryIntentId = `push-intent-${run.runId}`;
  return { repo, bare, store, run, attempt, phase, deliveryOid, authority, deliveryIntentId };
}

function pushRequest(
  fixture: PrFixture,
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
    providerIdentityDigest: digest(`provider:pr-test`),
    idempotencyKey: `push:${fixture.run.runId}:intent`,
    deliveryIntentId: fixture.deliveryIntentId,
    timeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * Fixture PR provider that simulates `gh` JSON responses deterministically.
 *
 * In production, a `GhCliPrProvider` wraps `execFileSync("gh", [...])`. In
 * tests, this fixture provider returns structured JSON without spawning `gh`.
 * The provider tracks calls to prove idempotency (no duplicate PR creation).
 */
class FixturePrProvider implements PrProvider {
  readonly #calls: { operation: string; headBranch: string; baseBranch: string }[] = [];
  #existingPr: PrProviderResult | null = null;
  readonly #repoIdentity: string;
  readonly #headOid: string;
  readonly #prNumber: number;
  readonly #prUrl: string;
  #mode: "normal" | "missing_gh" | "auth_failure" | "malformed_json" | "timeout" | "wrong_repo" | "wrong_head" | "lagging_head" = "normal";
  #createShouldSucceed = true;

  constructor(repoIdentity: string, headOid: string, prNumber = 42) {
    this.#repoIdentity = repoIdentity;
    this.#headOid = headOid;
    this.#prNumber = prNumber;
    this.#prUrl = `https://github.com/${repoIdentity}/pull/${prNumber}`;
  }

  get calls(): readonly { operation: string; headBranch: string; baseBranch: string }[] {
    return this.#calls;
  }

  setMode(mode: typeof this.#mode): void {
    this.#mode = mode;
  }

  /** Simulate an existing PR with a specific head OID. */
  setExistingPr(headOid: string, repoIdentity?: string): void {
    this.#existingPr = {
      prNumber: this.#prNumber,
      prUrl: this.#prUrl,
      repositoryId: repoIdentity ?? this.#repoIdentity,
      baseBranch: "main",
      headBranch: "rickgent-delivery",
      headOid,
    };
  }

  findExistingPr(headBranch: string, baseBranch: string): PrProviderResult | null {
    this.#calls.push({ operation: "find", headBranch, baseBranch });
    if (this.#mode === "missing_gh") throw new Error("gh: command not found");
    if (this.#mode === "auth_failure") throw new Error("gh auth status: not authenticated");
    if (this.#mode === "timeout") throw new Error("timeout: gh command exceeded deadline");
    if (this.#mode === "malformed_json") return null; // simulate malformed by returning null
    return this.#existingPr;
  }

  createPr(headBranch: string, baseBranch: string, _title: string, _body: string): PrProviderResult {
    this.#calls.push({ operation: "create", headBranch, baseBranch });
    if (this.#mode === "missing_gh") throw new Error("gh: command not found");
    if (this.#mode === "auth_failure") throw new Error("gh auth status: not authenticated");
    if (this.#mode === "timeout") throw new Error("timeout: gh command exceeded deadline");
    if (this.#mode === "malformed_json") throw new Error("malformed JSON: unexpected token");
    if (!this.#createShouldSucceed) throw new Error("create failed");

    const repoId = this.#mode === "wrong_repo" ? "wrong-owner/wrong-repo" : this.#repoIdentity;
    const headOid = this.#mode === "wrong_head" ? "0".repeat(40) : this.#headOid;
    const result: PrProviderResult = {
      prNumber: this.#prNumber,
      prUrl: this.#prUrl,
      repositoryId: repoId,
      baseBranch,
      headBranch,
      headOid,
    };
    this.#existingPr = result;
    return result;
  }

  queryPrHead(prNumber: number): PrProviderResult {
    this.#calls.push({ operation: "query", headBranch: "", baseBranch: "" });
    void prNumber;
    if (this.#mode === "missing_gh") throw new Error("gh: command not found");
    if (this.#mode === "auth_failure") throw new Error("gh auth status: not authenticated");
    if (this.#mode === "timeout") throw new Error("timeout: gh command exceeded deadline");

    if (this.#existingPr === null) throw new Error("PR not found");
    const headOid = this.#mode === "lagging_head" ? "1".repeat(40) : this.#existingPr.headOid;
    const repoId = this.#mode === "wrong_repo" ? "wrong-owner/wrong-repo" : this.#existingPr.repositoryId;
    return { ...this.#existingPr, headOid, repositoryId: repoId };
  }
}

function prRequest(
  fixture: PrFixture,
  provider: PrProvider,
  overrides: Partial<VerifiedPrRequest> = {},
): VerifiedPrRequest {
  return {
    store: fixture.store,
    authority: fixture.authority,
    runId: fixture.run.runId,
    deliveryOid: fixture.deliveryOid,
    deliveryIntentId: fixture.deliveryIntentId,
    expectedRepositoryId: "rickgent-test/delivery-test",
    baseBranch: "main",
    headBranch: "rickgent-delivery",
    provider,
    ownerContextId: fixture.phase.persisted.contextId,
    ownerContextDigest: fixture.phase.canonical.contextDigest,
    idempotencyKey: `pr:${fixture.run.runId}:observation`,
    prTitle: "t34: verified delivery",
    prBody: "Automated delivery from rickgent trust-spine.",
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** Prepare a fixture and execute verified push so the PR protocol has a verified push observation. */
function prepareWithPush(label: string): { fixture: PrFixture; pushResult: { status: string; observedRemoteOid: string } } {
  const fixture = preparePrFixture(label);
  const result = executeVerifiedPush(pushRequest(fixture));
  if (result.status !== "verified") {
    throw new Error(`push failed in fixture setup: ${result.status}`);
  }
  return { fixture, pushResult: { status: result.status, observedRemoteOid: result.observedRemoteOid } };
}

const TEST_TIMEOUT = 30_000;

describe("t34 verified idempotent PR protocol", () => {
  describe("success case", () => {
    it("creates a PR after verified push and confirms head OID equals delivery OID", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("success");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("verified");
      if (result.status !== "verified") return;
      expect(result.observedHeadOid).toBe(fixture.deliveryOid);
      expect(result.repositoryId).toBe("rickgent-test/delivery-test");

      // PR observation persisted with correct fields
      const prObs = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM pr_observations WHERE delivery_intent_id = ? ORDER BY sequence",
        fixture.deliveryIntentId,
      );
      expect(prObs).toHaveLength(1);
      expect(String(prObs[0]!.provider_repository_id)).toBe("rickgent-test/delivery-test");
      expect(String(prObs[0]!.head_branch)).toBe("rickgent-delivery");
      expect(String(prObs[0]!.base_branch)).toBe("main");
      expect(String(prObs[0]!.observed_head_oid)).toBe(fixture.deliveryOid);

      // Provider called create (no existing PR found)
      expect(provider.calls.filter((c) => c.operation === "create")).toHaveLength(1);
    });
  });

  describe("no-push rejection", () => {
    it("PR creation is impossible before verified push observation", { timeout: TEST_TIMEOUT }, () => {
      const fixture = preparePrFixture("no-push");
      // Do NOT execute verified push — no remote observation exists.
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toContain("verified push");

      // No PR observation recorded
      const prObs = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM pr_observations WHERE delivery_intent_id = ?",
        fixture.deliveryIntentId,
      );
      expect(prObs).toHaveLength(0);

      // Provider was not called
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("wrong repository", () => {
    it("PR from wrong repository is rejected", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("wrong-repo");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("wrong_repo");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("mismatch");
      if (result.status !== "mismatch") return;
      expect(result.reason).toContain("repository");

      // Run remains non-delivered
      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("wrong head OID", () => {
    it("PR head OID differs from delivery OID is rejected", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("wrong-head");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("wrong_head");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("mismatch");
      if (result.status !== "mismatch") return;
      expect(result.reason).toContain("head");

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("existing wrong-head PR", () => {
    it("existing PR with wrong head is rejected and not accepted", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("existing-wrong");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      // Simulate an existing PR with a different head OID
      provider.setExistingPr("b".repeat(40));
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("mismatch");
      if (result.status !== "mismatch") return;
      expect(result.reason).toContain("head");

      // Provider should have found the existing PR but not created a new one
      expect(provider.calls.filter((c) => c.operation === "find")).toHaveLength(1);
      expect(provider.calls.filter((c) => c.operation === "create")).toHaveLength(0);

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("missing gh", () => {
    it("missing gh command fails closed", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("missing-gh");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("missing_gh");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toContain("gh");

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("auth failure", () => {
    it("provider auth failure fails closed", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("auth-fail");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("auth_failure");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toContain("auth");

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("malformed JSON", () => {
    it("malformed provider JSON fails closed", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("malformed");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("malformed_json");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toMatch(/malformed|json|parse/i);

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("timeout", () => {
    it("provider timeout fails closed", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("pr-timeout");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("timeout");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("infrastructure_error");
      if (result.status !== "infrastructure_error") return;
      expect(result.reason).toMatch(/timeout|deadline/i);

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("head lag (query returns different OID than create)", () => {
    it("independent query shows lagging head, rejected", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("lag");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);
      provider.setMode("lagging_head");
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("mismatch");
      if (result.status !== "mismatch") return;
      expect(result.reason).toContain("head");

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("response-loss (crash after create, before observation persist)", () => {
    it("resume after crash resolves the same PR without duplicate", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("response-loss");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);

      // Simulate the PR being created (provider records it internally) but
      // the observation was NOT persisted (crash before recordPrObservation).
      // We simulate this by manually recording a "created" state in the provider
      // without persisting the observation, then resuming.
      provider.setExistingPr(fixture.deliveryOid);

      // Now resume — the provider's findExistingPr returns the PR,
      // and the protocol resolves it without creating a duplicate.
      const result = executeVerifiedPullRequest(prRequest(fixture, provider));

      expect(result.status).toBe("verified");
      if (result.status !== "verified") return;
      expect(result.observedHeadOid).toBe(fixture.deliveryOid);

      // Provider should have found the existing PR, not created a new one
      expect(provider.calls.filter((c) => c.operation === "find")).toHaveLength(1);
      expect(provider.calls.filter((c) => c.operation === "create")).toHaveLength(0);

      // Only one PR observation should exist
      const prObs = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM pr_observations WHERE delivery_intent_id = ?",
        fixture.deliveryIntentId,
      );
      expect(prObs).toHaveLength(1);
    });
  });

  describe("idempotent retry", () => {
    it("repeated call resolves the same PR without duplicate creation", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("idempotent");
      const provider = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid);

      const result1 = executeVerifiedPullRequest(prRequest(fixture, provider));
      expect(result1.status).toBe("verified");

      // Second call should resolve the same PR without re-creating
      const result2 = executeVerifiedPullRequest(prRequest(fixture, provider));
      expect(result2.status).toBe("verified");
      if (result2.status !== "verified") return;
      expect(result2.observedHeadOid).toBe(fixture.deliveryOid);
      expect(result2.prNumber).toBe(result1.prNumber);

      // Only one create call should have been made across both calls
      expect(provider.calls.filter((c) => c.operation === "create")).toHaveLength(1);

      // Only one PR observation should exist
      const prObs = queryRows(
        fixture.store.location.databasePath,
        "SELECT * FROM pr_observations WHERE delivery_intent_id = ?",
        fixture.deliveryIntentId,
      );
      expect(prObs).toHaveLength(1);
    });
  });

  describe("repository identity equality required", () => {
    it("PR from a different repository identity is rejected even with correct head OID", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("repo-identity");
      // Provider returns correct head but a different repository identity
      const provider = new FixturePrProvider("other-owner/other-repo", fixture.deliveryOid);
      const result = executeVerifiedPullRequest(prRequest(fixture, provider, {
        expectedRepositoryId: "rickgent-test/delivery-test",
      }));

      expect(result.status).toBe("mismatch");
      if (result.status !== "mismatch") return;
      expect(result.reason).toContain("repository");

      const run = queryRow(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      );
      expect(String(run!.state)).toBe("ready_for_delivery");
    });
  });

  describe("no delivered state on any failure", () => {
    it("every negative case asserts run remains ready_for_delivery not delivered", { timeout: TEST_TIMEOUT }, () => {
      const { fixture } = prepareWithPush("no-delivered");
      const cases: { label: string; provider: FixturePrProvider }[] = [
        { label: "missing-gh", provider: (() => { const p = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid); p.setMode("missing_gh"); return p; })() },
        { label: "auth-fail", provider: (() => { const p = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid); p.setMode("auth_failure"); return p; })() },
        { label: "malformed", provider: (() => { const p = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid); p.setMode("malformed_json"); return p; })() },
        { label: "timeout", provider: (() => { const p = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid); p.setMode("timeout"); return p; })() },
        { label: "wrong-repo", provider: (() => { const p = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid); p.setMode("wrong_repo"); return p; })() },
        { label: "wrong-head", provider: (() => { const p = new FixturePrProvider("rickgent-test/delivery-test", fixture.deliveryOid); p.setMode("wrong_head"); return p; })() },
      ];

      for (const { label, provider } of cases) {
        const result = executeVerifiedPullRequest(prRequest(fixture, provider));
        expect(result.status, `${label}: expected non-verified`).not.toBe("verified");

        const run = queryRow(
          fixture.store.location.databasePath,
          "SELECT state FROM runs WHERE run_id = ?",
          fixture.run.runId,
        );
        expect(String(run!.state), `${label}: run should remain ready_for_delivery`).toBe("ready_for_delivery");
      }
    });
  });
});
