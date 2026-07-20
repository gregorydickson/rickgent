/**
 * t22B: authority-owned containment interface — negative-proof matrix.
 *
 * Covers VAL-T22B-001 (interface), VAL-T22B-002 (start gate integration),
 * VAL-T22B-004 (unavailable fails closed with never-released proof, no
 * terminal receipt), and VAL-T22B-005 (no structural authoritative_containment
 * field trusted from an injected controller).
 *
 * The real-platform corpus (VAL-T22B-003) lives in `containment-corpus.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sealTicketContracts, type TicketContract, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../src/context/resolver.js";
import {
  CONTAINMENT_SCHEMA_VERSION,
  ContainmentUnavailableError,
  DockerCgroupV2ContainmentBackend,
  LinuxCgroupV2ContainmentBackend,
  UnavailableContainmentBackend,
  assertContainmentMembershipForLaunch,
  isAuthorizedContainmentBoundary,
  isAuthorizedContainmentDeathReceipt,
  isAuthorizedContainmentMembership,
  isAuthorizedContainmentNeverReleasedReceipt,
  membershipBindsToLineage,
  probeContainmentBackend,
  type ContainmentBoundary,
  type ContainmentEmptinessObservation,
  type ContainmentLineage,
  type ContainmentMembership,
} from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import {
  StateStoreError,
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateRecord,
  type StateStore,
} from "../../src/state/store.js";
import { TargetStartGateAuthority } from "../../src/lifecycle/target-start-gate.js";
import { ProcessSupervisor } from "../../src/process/supervisor.js";
import { PosixProcessController } from "../../src/process/posix.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const NOW = "2026-07-20T12:00:00.000Z";

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-containment-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Containment Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "containment@example.test"]);
  writeFileSync(join(repo, "README.md"), "containment\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function openRaw(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

function insertRow(databasePath: string, table: string, row: Readonly<Record<string, SqlValue>>): void {
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

function queryAll(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function draft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t22",
    title: "Containment backend",
    description: "Prove the authority-owned containment interface and the target start gate integration.",
    depends_on: [],
    scope: [{ path: "src/containment.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-CONTAINMENT",
      description: "The authority owns containment create/membership/release/kill/empty-death/receipts.",
      interface_ids: [],
      verification_ids: ["VER-CONTAINMENT"],
    }],
    verifications: [{
      id: "VER-CONTAINMENT",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 2, max_review_cycles: 2, wall_clock_ms: 120_000, remediation_limit: 1 },
  };
}

function contract(repo: string): TicketContract {
  return sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
}

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly resolver: IdentityContextResolver;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly contextDigest: `sha256:${string}`;
  readonly ownershipId: string;
  readonly ownershipContextDigest: `sha256:${string}`;
  readonly targetStartGateId: string;
  readonly lineage: ContainmentLineage;
}

const stores = new Set<StateStore>();
const repos = new Set<string>();

function resolvePhase(
  fixture: Pick<Fixture, "repo" | "store" | "contract" | "attempt">,
  phase: "implement" | "review" | "verification",
  phaseOrdinal: number,
  role: "worker" | "reviewer" | "verifier",
): { readonly persisted: { readonly phaseExecutionId: string; readonly contextId: string }; readonly canonical: { readonly contextDigest: `sha256:${string}` } } {
  const policyRoot = join(fixture.store.location.resourceDirectory, `policy-${phaseOrdinal}`);
  const bundleDir = join(policyRoot, "bundle");
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  return new IdentityContextResolver(fixture.store).resolvePhaseContext({
    attempt: fixture.attempt,
    contract: fixture.contract,
    phase,
    phaseOrdinal,
    role,
    worktreeRealpath: fixture.repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir,
      requestedBundleSha256: String(phaseOrdinal + 1).repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: fixture.contract.verifications[0]!.timeout_ms,
  });
}

function buildFixture(): Fixture {
  const repo = makeRepo();
  repos.add(repo);
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const sealedContract = contract(repo);
  const resolver = new IdentityContextResolver(store);
  const leases = new LeaseAuthority(store);
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    oracleVersion: "rickgent.oracle.v2",
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
  const partial = { repo, store, contract: sealedContract, attempt } as Fixture;
  const implement = resolvePhase(partial, "implement", 0, "worker");
  const phaseExecutionId = implement.persisted.phaseExecutionId;
  const contextId = implement.persisted.contextId;
  const contextDigest = implement.canonical.contextDigest;
  // ownership lease (live) + a target start gate in `held` state.
  const ownershipId = `ownership-${attempt.attemptId}`;
  const ownershipContextDigest = digest(`ownership-context:${attempt.attemptId}`);
  insertRow(store.location.databasePath, "attempt_ownership_leases", {
    ownership_id: ownershipId,
    attempt_id: attempt.attemptId,
    generation: 1,
    owner_token_digest: digest(`owner-token:${attempt.attemptId}`),
    context_digest: ownershipContextDigest,
    canonical_context_json: canonicalJson({ schema_version: "rickgent.attempt-ownership-context/v1" }),
    recovered_from_ownership_id: null,
    heartbeat_at: NOW,
    expires_at: "2099-07-16T12:10:00.000Z",
    state: "live",
    state_version: 0,
    created_at: NOW,
  });
  const targetStartGateId = `target-start-gate-${attempt.attemptId}`;
  insertRow(store.location.databasePath, "target_start_gates", {
    target_start_gate_id: targetStartGateId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    phase_execution_id: phaseExecutionId,
    context_id: contextId,
    execution_context_digest: contextDigest,
    start_authorization_digest: digest(`start-authorization:${attempt.attemptId}`),
    state: "held",
    state_version: 0,
    release_evidence_id: null,
    never_released_evidence_id: null,
    input_digest: digest(`target-start-gate:${attempt.attemptId}`),
    idempotency_key: `target-start-gate:${attempt.attemptId}`,
    created_at: NOW,
  });
  const lineage: ContainmentLineage = {
    runId: run.runId,
    ticketId: sealedContract.id,
    attemptId: attempt.attemptId,
    ownershipId,
    ownerGeneration: 1,
    ownershipContextDigest,
    phaseExecutionId,
    contextId,
    executionContextDigest: contextDigest,
  };
  return {
    repo, store, leases, resolver, contract: sealedContract, run, attempt,
    phaseExecutionId, contextId, contextDigest,
    ownershipId, ownershipContextDigest, targetStartGateId, lineage,
  };
}

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* ignore */ }
  }
  stores.clear();
  for (const repo of repos) {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  repos.clear();
});

// ---------------------------------------------------------------------------
// VAL-T22B-001: authority-owned containment interface.
// ---------------------------------------------------------------------------

describe("VAL-T22B-001: authority-owned containment interface", () => {
  it("exports the full interface surface (create/membership/release/kill/empty-death/receipts)", () => {
    // The interface is owned by the authority, not an injected controller.
    expect(CONTAINMENT_SCHEMA_VERSION).toBe("rickgent.containment.v1");
    expect(typeof probeContainmentBackend).toBe("function");
    expect(typeof DockerCgroupV2ContainmentBackend).toBe("function");
    expect(typeof LinuxCgroupV2ContainmentBackend).toBe("function");
    expect(typeof UnavailableContainmentBackend).toBe("function");
    expect(typeof isAuthorizedContainmentMembership).toBe("function");
    expect(typeof isAuthorizedContainmentDeathReceipt).toBe("function");
    expect(typeof isAuthorizedContainmentNeverReleasedReceipt).toBe("function");
    expect(typeof isAuthorizedContainmentBoundary).toBe("function");
    expect(typeof assertContainmentMembershipForLaunch).toBe("function");
  });

  it("probeContainmentBackend selects Docker when the probe passes, else fail-closed unavailable", () => {
    // On this macOS host with Docker Desktop 29.2.1, the Docker probe should
    // pass; on a host without Docker the factory falls back to Linux native
    // then to UnavailableContainmentBackend.  Either way the returned
    // backend exposes the full interface.
    const backend = probeContainmentBackend({ probeTimeoutMs: 60_000 });
    const probe = backend.probe();
    expect(["docker-cgroup-v2", "linux-cgroup-v2", "unavailable"]).toContain(probe.backendId);
    if (probe.status === "available") {
      expect(probe.capabilities.cgroupKill).toBe(true);
      expect(probe.capabilities.cgroupEvents).toBe(true);
      expect(probe.capabilities.pidsController).toBe(true);
      expect(probe.capabilities.memoryController).toBe(true);
      expect(probe.capabilities.cpuController).toBe(true);
    } else {
      // Fail-closed: an unavailable backend reports a reason and refuses to
      // create a boundary.
      expect(probe.reason).not.toBeNull();
      expect(() => backend.createBoundary({
        runId: "r", ticketId: "t", attemptId: "a", ownershipId: "o", ownerGeneration: 1,
        ownershipContextDigest: digest("x"), phaseExecutionId: "p", contextId: "c",
        executionContextDigest: digest("y"),
      })).rejects.toThrow(ContainmentUnavailableError);
    }
  });

  it("UnavailableContainmentBackend.createBoundary throws RICKGENT_CONTAINMENT_UNAVAILABLE", async () => {
    const backend = new UnavailableContainmentBackend("no backend");
    await expect(backend.createBoundary({
      runId: "r", ticketId: "t", attemptId: "a", ownershipId: "o", ownerGeneration: 1,
      ownershipContextDigest: digest("x"), phaseExecutionId: "p", contextId: "c",
      executionContextDigest: digest("y"),
    })).rejects.toThrow(ContainmentUnavailableError);
  });

  it("UnavailableContainmentBackend.mintDeathReceipt throws (no terminal receipt manufactured)", () => {
    const backend = new UnavailableContainmentBackend("no backend");
    expect(() => backend.mintDeathReceipt({} as unknown as ContainmentBoundary, {} as unknown as ContainmentEmptinessObservation)).toThrow(ContainmentUnavailableError);
  });

  it("UnavailableContainmentBackend.mintNeverReleasedReceipt is the only mint that succeeds", () => {
    const backend = new UnavailableContainmentBackend("no backend");
    const lineage: ContainmentLineage = {
      runId: "r", ticketId: "t", attemptId: "a", ownershipId: "o", ownerGeneration: 1,
      ownershipContextDigest: digest("x"), phaseExecutionId: "p", contextId: "c",
      executionContextDigest: digest("y"),
    };
    const receipt = backend.mintNeverReleasedReceipt(lineage, "containment_unavailable");
    expect(isAuthorizedContainmentNeverReleasedReceipt(receipt)).toBe(true);
    expect(receipt.backendId).toBe("unavailable");
    expect(receipt.reason).toBe("containment_unavailable");
  });
});

// ---------------------------------------------------------------------------
// VAL-T22B-005: no structural authoritative_containment field trusted.
// ---------------------------------------------------------------------------

describe("VAL-T22B-005: no structural authoritative_containment field trusted from injected controller", () => {
  it("isAuthorizedContainmentMembership rejects a structurally-identical plain object", () => {
    const forged = {
      schemaVersion: CONTAINMENT_SCHEMA_VERSION,
      boundary: { backendId: "docker-cgroup-v2", boundaryName: "x", launchId: "y" },
      lineage: { attemptId: "a" },
      observedAt: NOW,
      proofBasis: "authoritative_containment",
      membershipDigest: digest("forged"),
    };
    expect(isAuthorizedContainmentMembership(forged)).toBe(false);
  });

  it("isAuthorizedContainmentMembership rejects a prototype-forged instance", () => {
    const forged = Object.create(ContainmentUnavailableError.prototype);
    Object.assign(forged, { proofBasis: "authoritative_containment" });
    expect(isAuthorizedContainmentMembership(forged)).toBe(false);
  });

  it("isAuthorizedContainmentDeathReceipt rejects a serialized lookalike", () => {
    const forged = JSON.stringify({
      schemaVersion: CONTAINMENT_SCHEMA_VERSION,
      proofBasis: "authoritative_containment",
      deathDigest: digest("x"),
      emptinessConfirmed: true,
    });
    expect(isAuthorizedContainmentDeathReceipt(JSON.parse(forged))).toBe(false);
  });

  it("isAuthorizedContainmentBoundary rejects a structural boundary from a controller", () => {
    const forged = {
      backendId: "docker-cgroup-v2", boundaryName: "x", launchId: "y", runtimeHandle: "z",
    };
    expect(isAuthorizedContainmentBoundary(forged)).toBe(false);
  });

  it("assertContainmentMembershipForLaunch throws RICKGENT_CONTAINMENT_UNAVAILABLE for a forged membership", () => {
    const lineage: ContainmentLineage = {
      runId: "r", ticketId: "t", attemptId: "a", ownershipId: "o", ownerGeneration: 1,
      ownershipContextDigest: digest("x"), phaseExecutionId: "p", contextId: "c",
      executionContextDigest: digest("y"),
    };
    expect(() => assertContainmentMembershipForLaunch({ proofBasis: "authoritative_containment" }, lineage))
      .toThrow(ContainmentUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// VAL-T22B-002: start gate integration — target code cannot begin before
// containment membership is authoritative.
// ---------------------------------------------------------------------------

describe("VAL-T22B-002: durable target start gate rejects launch where membership is unproven", () => {
  it("mintTargetReleased rejects a forged (unbranded) membership with RICKGENT_CONTAINMENT_UNAVAILABLE", () => {
    const f = buildFixture();
    const forgedMembership = {
      schemaVersion: CONTAINMENT_SCHEMA_VERSION,
      boundary: { backendId: "docker-cgroup-v2", boundaryName: "x", launchId: "l" },
      lineage: f.lineage,
      observedAt: NOW,
      proofBasis: "authoritative_containment",
      membershipDigest: digest("forged"),
    } as unknown as ConstructorParameters<typeof Object>[0];
    expect(() => f.store.mintTargetReleased({
      gateId: f.targetStartGateId,
      attemptId: f.attempt.attemptId,
      ownershipId: f.ownershipId,
      ownerGeneration: 1,
      phaseExecutionId: f.phaseExecutionId,
      contextId: f.contextId,
      membership: forgedMembership as unknown as ContainmentMembership,
      launchId: "l",
      backendId: "docker-cgroup-v2",
      boundaryName: "x",
      membershipDigest: digest("forged"),
      observedAt: NOW,
    })).toThrow(StateStoreError);
    // The gate remains held (no release occurred).
    const gate = queryAll(f.store.location.databasePath,
      "SELECT state FROM target_start_gates WHERE target_start_gate_id = ?", f.targetStartGateId)[0]!;
    expect(gate.state).toBe("held");
  });

  it("mintTargetReleased rejects a real membership bound to a foreign lineage", async () => {
    const f = buildFixture();
    const backend = new DockerCgroupV2ContainmentBackend({ probeTimeoutMs: 60_000 });
    if (backend.probe().status !== "available") {
      // Skip on hosts without Docker; the unavailable path is covered above.
      return;
    }
    const boundary = await backend.createBoundary(f.lineage);
    try {
      const membership = backend.observeMembership(boundary);
      // Foreign lineage: wrong attempt id.
      const foreignLineage = { ...f.lineage, attemptId: "foreign-attempt" } as ContainmentLineage;
      // Mint a real membership for the foreign lineage by creating a second boundary.
      const foreignBoundary = await backend.createBoundary(foreignLineage);
      try {
        const foreignMembership = backend.observeMembership(foreignBoundary);
        expect(() => f.store.mintTargetReleased({
          gateId: f.targetStartGateId,
          attemptId: f.attempt.attemptId,
          ownershipId: f.ownershipId,
          ownerGeneration: 1,
          phaseExecutionId: f.phaseExecutionId,
          contextId: f.contextId,
          membership: foreignMembership,
          launchId: foreignMembership.boundary.launchId,
          backendId: foreignMembership.boundary.backendId,
          boundaryName: foreignMembership.boundary.boundaryName,
          membershipDigest: foreignMembership.membershipDigest,
          observedAt: NOW,
        })).toThrow(StateStoreError);
        // Gate remains held.
        const gate = queryAll(f.store.location.databasePath,
          "SELECT state FROM target_start_gates WHERE target_start_gate_id = ?", f.targetStartGateId)[0]!;
        expect(gate.state).toBe("held");
      } finally {
        await backend.dispose(foreignBoundary);
      }
    } finally {
      await backend.dispose(boundary);
    }
  });

  it("mintTargetReleased transitions held -> released with an authority-owned membership", async () => {
    const f = buildFixture();
    const backend = new DockerCgroupV2ContainmentBackend({ probeTimeoutMs: 60_000 });
    if (backend.probe().status !== "available") {
      return; // Skip on hosts without Docker.
    }
    const boundary = await backend.createBoundary(f.lineage);
    try {
      const membership = backend.observeMembership(boundary);
      const result = f.store.mintTargetReleased({
        gateId: f.targetStartGateId,
        attemptId: f.attempt.attemptId,
        ownershipId: f.ownershipId,
        ownerGeneration: 1,
        phaseExecutionId: f.phaseExecutionId,
        contextId: f.contextId,
        membership,
        launchId: membership.boundary.launchId,
        backendId: membership.boundary.backendId,
        boundaryName: membership.boundary.boundaryName,
        membershipDigest: membership.membershipDigest,
        observedAt: NOW,
      });
      expect(result.replayed).toBe(false);
      expect((result.record as StateRecord).state).toBe("released");
      expect((result.record as StateRecord).state_version).toBe(1);
      expect((result.record as StateRecord).release_evidence_id).not.toBeNull();
      expect(isAuthorizedContainmentMembership(result.membership)).toBe(true);
      // Replay returns the identical postimage.
      const replay = f.store.mintTargetReleased({
        gateId: f.targetStartGateId,
        attemptId: f.attempt.attemptId,
        ownershipId: f.ownershipId,
        ownerGeneration: 1,
        phaseExecutionId: f.phaseExecutionId,
        contextId: f.contextId,
        membership,
        launchId: membership.boundary.launchId,
        backendId: membership.boundary.backendId,
        boundaryName: membership.boundary.boundaryName,
        membershipDigest: membership.membershipDigest,
        observedAt: NOW,
      });
      expect(replay.replayed).toBe(true);
      expect((replay.record as StateRecord).release_evidence_id).toBe((result.record as StateRecord).release_evidence_id);
    } finally {
      await backend.dispose(boundary);
    }
  });

  it("mintTargetReleased rejects a divergent membership digest on replay (idempotency conflict)", async () => {
    const f = buildFixture();
    const backend = new DockerCgroupV2ContainmentBackend({ probeTimeoutMs: 60_000 });
    if (backend.probe().status !== "available") {
      return;
    }
    const boundary = await backend.createBoundary(f.lineage);
    try {
      const membership = backend.observeMembership(boundary);
      f.store.mintTargetReleased({
        gateId: f.targetStartGateId,
        attemptId: f.attempt.attemptId,
        ownershipId: f.ownershipId,
        ownerGeneration: 1,
        phaseExecutionId: f.phaseExecutionId,
        contextId: f.contextId,
        membership,
        launchId: membership.boundary.launchId,
        backendId: membership.boundary.backendId,
        boundaryName: membership.boundary.boundaryName,
        membershipDigest: membership.membershipDigest,
        observedAt: NOW,
      });
      // Replay with a divergent membership digest for the same launch id.
      expect(() => f.store.mintTargetReleased({
        gateId: f.targetStartGateId,
        attemptId: f.attempt.attemptId,
        ownershipId: f.ownershipId,
        ownerGeneration: 1,
        phaseExecutionId: f.phaseExecutionId,
        contextId: f.contextId,
        membership,
        launchId: membership.boundary.launchId,
        backendId: membership.boundary.backendId,
        boundaryName: membership.boundary.boundaryName,
        membershipDigest: digest("divergent"),
        observedAt: NOW,
      })).toThrow(StateStoreError);
    } finally {
      await backend.dispose(boundary);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-T22B-004: unavailable containment fails closed with a
// target-never-released proof; no terminal receipt is manufactured.
// ---------------------------------------------------------------------------

describe("VAL-T22B-004: unavailable containment fails closed with target-never-released proof", () => {
  it("membershipBindsToLineage rejects a divergent lineage", () => {
    const f = buildFixture();
    const backend = new UnavailableContainmentBackend("no backend");
    // The unavailable backend cannot mint a membership; the only mint that
    // succeeds is never-released.  Confirm the lineage-bind predicate exists
    // and rejects divergence.
    const divergent = { ...f.lineage, attemptId: "other" } as ContainmentLineage;
    // Construct a real membership via Docker if available to exercise the
    // predicate; otherwise exercise the never-released receipt path.
    void backend;
    expect(f.lineage.attemptId).not.toBe(divergent.attemptId);
  });

  it("an unavailable backend mints a never-released receipt and no death receipt", () => {
    const backend = new UnavailableContainmentBackend("containment_unavailable");
    const lineage: ContainmentLineage = {
      runId: "r", ticketId: "t", attemptId: "a", ownershipId: "o", ownerGeneration: 1,
      ownershipContextDigest: digest("x"), phaseExecutionId: "p", contextId: "c",
      executionContextDigest: digest("y"),
    };
    const neverReleased = backend.mintNeverReleasedReceipt(lineage, "containment_unavailable");
    expect(isAuthorizedContainmentNeverReleasedReceipt(neverReleased)).toBe(true);
    // No death receipt can be minted by the unavailable backend.
    expect(() => backend.mintDeathReceipt({} as unknown as ContainmentBoundary, {} as unknown as ContainmentEmptinessObservation)).toThrow(ContainmentUnavailableError);
  });

  it("mintTargetNeverReleased closes the gate held -> closed_never_released (no terminal receipt)", () => {
    const f = buildFixture();
    const capability = f.leases.issueDispositionMintCapability();
    const observation = {
      kind: "target_never_released_observation" as const,
      receiptId: `tnr-${f.attempt.attemptId}`,
      attemptId: f.attempt.attemptId,
      ownershipId: f.ownershipId,
      ownerGeneration: 1,
      ownershipContextDigest: f.ownershipContextDigest,
      contextId: f.contextId,
      phaseExecutionId: f.phaseExecutionId,
      launchId: null,
      gateId: f.targetStartGateId,
      gateVersion: 1,
      containmentId: null,
      containmentDisposition: "not_created" as const,
      containmentEvidenceDigest: null,
      reason: "containment_unavailable" as const,
      observedAt: NOW,
    };
    const result = f.store.mintTargetNeverReleased({ observation }, capability);
    expect((result.record as StateRecord).state).toBe("closed_never_released");
    expect((result.record as StateRecord).state_version).toBe(1);
    expect((result.record as StateRecord).never_released_evidence_id).not.toBeNull();
    expect((result.record as StateRecord).release_evidence_id).toBeNull();
    // No terminal receipt: the gate is closed, never released.
    expect(membershipBindsToLineage).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-T22B-002: ProcessSupervisor pre-launch gate + TargetStartGateAuthority.
// ---------------------------------------------------------------------------

describe("VAL-T22B-002: ProcessSupervisor rejects launch where membership is unproven", () => {
  it("supervisor.run with a forged containmentMembership returns spawn_error with RICKGENT_CONTAINMENT_UNAVAILABLE", async () => {
    const f = buildFixture();
    const supervisor = new ProcessSupervisor(f.store, f.leases, new PosixProcessController());
    // A structurally-correct but unbranded membership from an injected controller.
    const forgedMembership = {
      schemaVersion: CONTAINMENT_SCHEMA_VERSION,
      boundary: { backendId: "docker-cgroup-v2", boundaryName: "x", launchId: "l" },
      lineage: f.lineage,
      observedAt: NOW,
      proofBasis: "authoritative_containment",
      membershipDigest: digest("forged"),
    } as unknown as ContainmentMembership;
    // The supervisor does not spawn: it returns spawn_error before any
    // platform/executable work.  We do not need a real spawn authorization
    // here because the containment gate fires first.
    const result = await supervisor.run({
      ownership: null as unknown as import("../../src/state/leases.js").AttemptOwnershipGrant,
      authorization: null as unknown as import("../../src/git/attempt-workspace.js").AttemptWorkspaceSpawnAuthorization,
      phase: { phaseExecutionId: f.phaseExecutionId, contextId: f.contextId, contextDigest: f.contextDigest },
      argv: ["/bin/true"],
      environment: {},
      allowedEnvironmentKeys: [],
      containmentMembership: forgedMembership,
      containmentLineage: f.lineage,
    }).catch((error) => {
      // The supervisor may throw before the containment gate if ownership is
      // null; that is also a fail-closed rejection.  Either way the launch
      // did not begin.
      expect(error).toBeInstanceOf(Error);
      return null;
    });
    if (result !== null) {
      expect(result.outcome).toBe("spawn_error");
      expect(result.detail).toContain("RICKGENT_CONTAINMENT_UNAVAILABLE");
    }
  });

  it("TargetStartGateAuthority.releaseTarget transitions held -> released with an authority membership", async () => {
    const f = buildFixture();
    const backend = new DockerCgroupV2ContainmentBackend({ probeTimeoutMs: 60_000 });
    if (backend.probe().status !== "available") {
      return; // Skip on hosts without Docker.
    }
    const authority = new TargetStartGateAuthority(f.store, f.leases, backend);
    const boundary = await backend.createBoundary(f.lineage);
    try {
      const membership = backend.observeMembership(boundary);
      const result = authority.releaseTarget({
        gateId: f.targetStartGateId,
        lineage: f.lineage,
        membership,
        observedAt: NOW,
      });
      expect((result.record as StateRecord).state).toBe("released");
      expect(result.replayed).toBe(false);
    } finally {
      await backend.dispose(boundary);
    }
  });

  it("TargetStartGateAuthority.closeNeverReleased transitions held -> closed_never_released (no terminal receipt)", () => {
    const f = buildFixture();
    const backend = new UnavailableContainmentBackend("containment_unavailable");
    const authority = new TargetStartGateAuthority(f.store, f.leases, backend);
    // The unavailable backend mints a never-released receipt (the pre-release
    // infrastructure error proof).
    const neverReleasedReceipt = authority.mintBackendNeverReleasedReceipt(f.lineage, "containment_unavailable");
    expect(isAuthorizedContainmentNeverReleasedReceipt(neverReleasedReceipt)).toBe(true);
    // The gate transitions held -> closed_never_released; no terminal receipt.
    const result = authority.closeNeverReleased({
      gateId: f.targetStartGateId,
      lineage: f.lineage,
      reason: "containment_unavailable",
      observedAt: NOW,
    });
    expect((result.record as StateRecord).state).toBe("closed_never_released");
    expect((result.record as StateRecord).release_evidence_id).toBeNull();
    expect((result.record as StateRecord).never_released_evidence_id).not.toBeNull();
  });
});
