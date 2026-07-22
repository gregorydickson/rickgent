// t34: Delivery negative proofs — fail-closed propagation across the
// push-to-PR delivery chain.
//
// Exercises the combined push+PR delivery protocol to prove that every
// failure mode leaves the run non-delivered and PR-unreachable:
//   - No-push-before-PR: PR creation impossible without verified push
//   - Push-mismatch-before-PR: ls-remote OID ≠ delivery OID blocks PR
//   - Wrong-repository PR: provider returns wrong repo identity
//   - Wrong-head PR: PR head OID ≠ delivery OID
//   - Existing wrong-head PR: existing PR with stale head
//   - Missing gh: provider unavailable
//   - Auth failure: provider auth error
//   - Malformed JSON: provider returns invalid JSON
//   - Provider timeout: provider exceeds deadline
//   - Crash-after-create: resume resolves same PR without duplicate
//   - Idempotent retry: no duplicate PR creation
//   - Head lag: independent query shows different OID
//
// Every case asserts no delivered/Done state.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  type StateStore,
} from "../../src/state/store.js";
import { DeliveryAuthority } from "../../src/state/transitions.js";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rickgent-deliv-neg-${prefix}-`)));
  scratchRoots.add(root);
  return root;
}

function makeRepo(label: string): string {
  const repo = join(tmpDir(`repo-${label}`), "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Delivery Negative Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "delivery-neg@example.test"]);
  writeFileSync(join(repo, "README.md"), "delivery negative\n", "utf8");
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
    id: "t99",
    title: "Delivery negative",
    description: "Exercise delivery negative proofs.",
    depends_on: [],
    scope: [{ path: "delivery.txt", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-DEL-NEG",
      description: "Every delivery failure leaves the run non-delivered.",
      interface_ids: [],
      verification_ids: ["VER-DEL-NEG"],
    }],
    verifications: [{
      id: "VER-DEL-NEG",
      executable: "test",
      args: ["-f", "delivery.txt"],
      cwd_class: "repository_root",
      env_allowlist: ["PATH"],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 1, max_review_cycles: 1, wall_clock_ms: 60_000, remediation_limit: 1 },
  };
  return sealTicketContracts([draft])[0]!;
}

function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

function updateRunState(databasePath: string, runId: string, state: string, currentDeliveryOid: string): void {
  const database = openRaw(databasePath);
  try {
    const current = database.prepare("SELECT state FROM runs WHERE run_id = ?").get(runId) as SqlRow;
    const currentState = String(current!.state);
    if (currentState === state) return;
    if (currentState === "planned" && state === "ready_for_delivery") {
      database.prepare("UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?").run(runId);
      database.prepare("UPDATE runs SET state = ?, current_delivery_oid = ?, state_version = state_version + 1 WHERE run_id = ?").run(state, currentDeliveryOid, runId);
    } else {
      database.prepare("UPDATE runs SET state = ?, current_delivery_oid = ?, state_version = state_version + 1 WHERE run_id = ?").run(state, currentDeliveryOid, runId);
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

interface DeliveryFixture {
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

function prepareFixture(label: string): DeliveryFixture {
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
    attempt, contract, phase: "implement", phaseOrdinal: 0, role: "worker",
    worktreeRealpath: repo,
    policyBundle: { kind: "materialized_authenticated_policy_bundle", policyRoot, bundleDir: bundleRoot, requestedBundleSha256: "a".repeat(64) },
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

function pushRequest(f: DeliveryFixture, overrides: Partial<VerifiedPushRequest> = {}): VerifiedPushRequest {
  return {
    store: f.store, authority: f.authority, repoPath: f.repo, runId: f.run.runId,
    deliveryOid: f.deliveryOid, remoteName: "origin", branchName: "rickgent-delivery",
    expectedRemoteOid: null, baseBranch: "main",
    ownerContextId: f.phase.persisted.contextId, ownerContextDigest: f.phase.canonical.contextDigest,
    providerIdentityDigest: digest(`provider:deliv-neg`),
    idempotencyKey: `push:${f.run.runId}:intent`, deliveryIntentId: f.deliveryIntentId, timeoutMs: 30_000,
    ...overrides,
  };
}

function prRequest(f: DeliveryFixture, provider: PrProvider, overrides: Partial<VerifiedPrRequest> = {}): VerifiedPrRequest {
  return {
    store: f.store, authority: f.authority, runId: f.run.runId, deliveryOid: f.deliveryOid,
    deliveryIntentId: f.deliveryIntentId, expectedRepositoryId: "rickgent-test/delivery-test",
    baseBranch: "main", headBranch: "rickgent-delivery", provider,
    ownerContextId: f.phase.persisted.contextId, ownerContextDigest: f.phase.canonical.contextDigest,
    idempotencyKey: `pr:${f.run.runId}:observation`,
    prTitle: "t34: verified delivery", prBody: "Automated delivery.", timeoutMs: 30_000,
    ...overrides,
  };
}

class FixtureProvider implements PrProvider {
  #existingPr: PrProviderResult | null = null;
  readonly #repoId: string;
  readonly #headOid: string;
  readonly #prNumber = 42;
  #mode = "normal";
  #calls: string[] = [];

  constructor(repoId: string, headOid: string) {
    this.#repoId = repoId;
    this.#headOid = headOid;
  }

  get calls(): readonly string[] { return this.#calls; }

  setMode(m: string): void { this.#mode = m; }
  setExistingPr(headOid: string, repoId?: string): void {
    this.#existingPr = {
      prNumber: this.#prNumber, prUrl: `https://github.com/${repoId ?? this.#repoId}/pull/${this.#prNumber}`,
      repositoryId: repoId ?? this.#repoId, baseBranch: "main", headBranch: "rickgent-delivery", headOid,
    };
  }

  private err(): never {
    const m = this.#mode;
    if (m === "missing_gh") throw new Error("gh: command not found");
    if (m === "auth_failure") throw new Error("gh auth status: not authenticated");
    if (m === "timeout") throw new Error("timeout: gh command exceeded deadline");
    if (m === "malformed_json") throw new Error("malformed JSON: unexpected token");
    throw new Error("provider error");
  }

  findExistingPr(): PrProviderResult | null {
    this.#calls.push("find");
    if (["missing_gh", "auth_failure", "timeout", "malformed_json"].includes(this.#mode)) this.err();
    return this.#existingPr;
  }

  createPr(_h: string, _b: string, _t: string, _body: string): PrProviderResult {
    this.#calls.push("create");
    if (["missing_gh", "auth_failure", "timeout", "malformed_json"].includes(this.#mode)) this.err();
    const repoId = this.#mode === "wrong_repo" ? "wrong-owner/wrong-repo" : this.#repoId;
    const headOid = this.#mode === "wrong_head" ? "0".repeat(40) : this.#headOid;
    const result: PrProviderResult = {
      prNumber: this.#prNumber, prUrl: `https://github.com/${repoId}/pull/${this.#prNumber}`,
      repositoryId: repoId, baseBranch: "main", headBranch: "rickgent-delivery", headOid,
    };
    this.#existingPr = result;
    return result;
  }

  queryPrHead(): PrProviderResult {
    this.#calls.push("query");
    if (["missing_gh", "auth_failure", "timeout"].includes(this.#mode)) this.err();
    if (this.#existingPr === null) throw new Error("PR not found");
    const headOid = this.#mode === "lagging_head" ? "1".repeat(40) : this.#existingPr.headOid;
    const repoId = this.#mode === "wrong_repo" ? "wrong-owner/wrong-repo" : this.#existingPr.repositoryId;
    return { ...this.#existingPr, headOid, repositoryId: repoId };
  }
}

function assertNonDelivered(f: DeliveryFixture): void {
  const run = queryRow(f.store.location.databasePath, "SELECT state FROM runs WHERE run_id = ?", f.run.runId);
  expect(String(run!.state)).toBe("ready_for_delivery");
}

const T = 30_000;

describe("t34 delivery negative proofs", () => {
  it("PR creation impossible before any push observation", { timeout: T }, () => {
    const f = prepareFixture("no-push-at-all");
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("infrastructure_error");
    assertNonDelivered(f);
    expect(p.calls).toHaveLength(0);
  });

  it("PR creation impossible when ls-remote OID does not match delivery OID", { timeout: T }, () => {
    const f = prepareFixture("push-mismatch");
    // Record a push observation but with a mismatched ls-remote
    f.authority.createIntent({
      deliveryIntentId: f.deliveryIntentId, runId: f.run.runId, deliveryOid: f.deliveryOid,
      remoteName: "origin", branchName: "rickgent-delivery", expectedRemoteOid: null,
      baseBranch: "main", providerIdentityDigest: digest("provider:test"),
      ownerContextId: f.phase.persisted.contextId, ownerContextDigest: f.phase.canonical.contextDigest,
      idempotencyKey: `push:${f.run.runId}:intent`, createdAt: "2026-07-22T12:00:00.000Z",
    });
    // Execute the actual push
    execFileSync("git", ["-C", f.repo, "push", "origin", `${f.deliveryOid}:refs/heads/rickgent-delivery`]);
    f.authority.recordRemoteObservation({
      deliveryIntentId: f.deliveryIntentId, remoteObservationId: `push-obs-${f.run.runId}`,
      sequence: 1, operation: "push", outcome: "pushed", observedRemoteOid: null,
      ownerContextId: f.phase.persisted.contextId, ownerContextDigest: f.phase.canonical.contextDigest,
      evidenceIdempotencyKey: `push:${f.run.runId}:push-evidence`, createdAt: "2026-07-22T12:01:00.000Z",
    });
    // Record a ls-remote with wrong OID
    f.authority.recordRemoteObservation({
      deliveryIntentId: f.deliveryIntentId, remoteObservationId: `lsremote-obs-${f.run.runId}`,
      sequence: 2, operation: "ls-remote", outcome: "observed", observedRemoteOid: "b".repeat(40),
      ownerContextId: f.phase.persisted.contextId, ownerContextDigest: f.phase.canonical.contextDigest,
      evidenceIdempotencyKey: `push:${f.run.runId}:lsremote-evidence`, createdAt: "2026-07-22T12:02:00.000Z",
    });

    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("infrastructure_error");
    assertNonDelivered(f);
  });

  it("wrong-repository PR fails closed", { timeout: T }, () => {
    const f = prepareFixture("wrong-repo-neg");
    const push = executeVerifiedPush(pushRequest(f));
    expect(push.status).toBe("verified");
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("wrong_repo");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("mismatch");
    assertNonDelivered(f);
  });

  it("wrong-head PR fails closed", { timeout: T }, () => {
    const f = prepareFixture("wrong-head-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("wrong_head");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("mismatch");
    assertNonDelivered(f);
  });

  it("existing wrong-head PR fails closed", { timeout: T }, () => {
    const f = prepareFixture("existing-wrong-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setExistingPr("b".repeat(40));
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("mismatch");
    assertNonDelivered(f);
  });

  it("missing gh fails closed", { timeout: T }, () => {
    const f = prepareFixture("missing-gh-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("missing_gh");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("infrastructure_error");
    assertNonDelivered(f);
  });

  it("auth failure fails closed", { timeout: T }, () => {
    const f = prepareFixture("auth-fail-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("auth_failure");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("infrastructure_error");
    assertNonDelivered(f);
  });

  it("malformed JSON fails closed", { timeout: T }, () => {
    const f = prepareFixture("malformed-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("malformed_json");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("infrastructure_error");
    assertNonDelivered(f);
  });

  it("provider timeout fails closed", { timeout: T }, () => {
    const f = prepareFixture("timeout-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("timeout");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("infrastructure_error");
    assertNonDelivered(f);
  });

  it("head lag from independent query fails closed", { timeout: T }, () => {
    const f = prepareFixture("lag-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    p.setMode("lagging_head");
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("mismatch");
    assertNonDelivered(f);
  });

  it("crash after create, resume resolves same PR without duplicate", { timeout: T }, () => {
    const f = prepareFixture("crash-resume-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    // Simulate PR was created but observation not persisted (crash)
    p.setExistingPr(f.deliveryOid);
    const r = executeVerifiedPullRequest(prRequest(f, p));
    expect(r.status).toBe("verified");
    expect(p.calls.filter((c) => c === "create")).toHaveLength(0);
  });

  it("idempotent retry resolves same PR without duplicate", { timeout: T }, () => {
    const f = prepareFixture("idempotent-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid);
    const r1 = executeVerifiedPullRequest(prRequest(f, p));
    expect(r1.status).toBe("verified");
    const r2 = executeVerifiedPullRequest(prRequest(f, p));
    expect(r2.status).toBe("verified");
    expect(p.calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("repository identity equality required even with correct head", { timeout: T }, () => {
    const f = prepareFixture("repo-id-neg");
    executeVerifiedPush(pushRequest(f));
    const p = new FixtureProvider("other-owner/other-repo", f.deliveryOid);
    const r = executeVerifiedPullRequest(prRequest(f, p, { expectedRepositoryId: "rickgent-test/delivery-test" }));
    expect(r.status).toBe("mismatch");
    assertNonDelivered(f);
  });

  it("no delivered/Done state on any failure path", { timeout: T }, () => {
    const f = prepareFixture("no-delivered-neg");
    executeVerifiedPush(pushRequest(f));
    const cases: { label: string; p: FixtureProvider }[] = [
      { label: "missing-gh", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("missing_gh"); return p; })() },
      { label: "auth", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("auth_failure"); return p; })() },
      { label: "malformed", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("malformed_json"); return p; })() },
      { label: "timeout", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("timeout"); return p; })() },
      { label: "wrong-repo", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("wrong_repo"); return p; })() },
      { label: "wrong-head", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("wrong_head"); return p; })() },
      { label: "lagging", p: (() => { const p = new FixtureProvider("rickgent-test/delivery-test", f.deliveryOid); p.setMode("lagging_head"); return p; })() },
    ];
    for (const { label, p } of cases) {
      const r = executeVerifiedPullRequest(prRequest(f, p));
      expect(r.status, `${label}: expected non-verified`).not.toBe("verified");
      assertNonDelivered(f);
    }
  });

  it("delivery corpus manifest inventory is complete", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const manifestPath = path.join(import.meta.dirname, "../fixtures/delivery-corpus/manifest.json");
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(data.complete).toBe(true);
    expect(data.push_failures.length).toBeGreaterThan(0);
    expect(data.pr_failures.length).toBeGreaterThan(0);
    expect(data.pr_success).toBeDefined();
  });
});
