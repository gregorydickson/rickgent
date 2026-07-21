/**
 * m4-fix-multi-verification-iteration: M4 scrutiny round 5 blocking defect.
 *
 * The verification provider in attempt-runner-providers.ts selected only
 * contract.verifications[0] instead of iterating ALL sealed contract
 * verification IDs.  The StateStore's oracle requires passed gate records
 * for the complete sorted set of sealed verification IDs — a valid contract
 * with multiple verification IDs cannot terminalize successfully because the
 * missing gate records produce `required_gate_missing_or_duplicate` reasons.
 *
 * Tests:
 *   (a) multi-verification success: contract with 2+ verification IDs, all
 *       pass, the provider creates a gate result for every verification ID,
 *       and the oracle projection resolves all required gates.
 *   (b) failed required verification: one verification fails, the provider
 *       returns status "fail" (fail-closed) — the runner would branch to the
 *       ordinary-failure state machine, not terminalize.
 *   (c) Docker integration: the full runBuildViaRunnerForTesting path with
 *       a multi-verification PRD terminalizes successfully (outcome.status
 *       === "succeeded").
 *
 * Red-then-green proof: before the fix, test (a) fails because only one gate
 * result is created; the structural test fails because the source contains
 * `verifications[0]`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver, type ResolvedPhaseContext } from "../../src/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../src/context/attempt-execution-context.js";
import { buildAttemptRunnerProviders } from "../../src/lifecycle/attempt-runner-providers.js";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { FixtureContainmentBackend, DockerCgroupV2ContainmentBackend } from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import { RICKGENT_ORACLE_VERSION } from "../../src/state/oracle.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = RICKGENT_ORACLE_VERSION;
const NOW = "2026-07-21T12:00:00.000Z";
const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const scratchRoots = new Set<string>();
const stores = new Set<StateStore>();

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* best effort */ }
  }
  stores.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-multi-verif-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Multi-Verification Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "multi-verif@example.test"]);
  writeFileSync(join(repo, "README.md"), "multi-verification\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function openRaw(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { enableForeignKeyConstraints: false, timeout: 1_000 });
}

function updateRow(databasePath: string, table: string, idColumn: string, id: string, changes: Readonly<Record<string, SqlValue>>): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(changes);
    const result = database.prepare(
      `UPDATE "${table}" SET ${columns.map((c) => `"${c}" = ?`).join(", ")} WHERE "${idColumn}" = ?`,
    ).run(...columns.map((c) => changes[c] ?? null), id);
    expect(result.changes).toBe(1);
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

/**
 * Build a contract draft with `count` verifications.  The first `count - 1`
 * use `node --version` (exit 0, pass); the last uses `failArgv` so a failing
 * verification can be injected.
 */
function multiVerificationDraft(opts: {
  readonly failLast?: boolean;
  readonly failExecutable?: string;
  readonly count: number;
}): TicketContractDraft {
  const verifications = [];
  for (let i = 0; i < opts.count - 1; i++) {
    verifications.push({
      id: `VER-MV-${i}`,
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root" as const,
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny" as const,
      writable_outputs: [],
      expected_exit_codes: [0],
    });
  }
  const lastIndex = opts.count - 1;
  const failExec = opts.failExecutable ?? "node";
  verifications.push({
    id: `VER-MV-${lastIndex}`,
    executable: failExec,
    args: opts.failLast ? ["-e", "process.exit(1)"] : ["--version"],
    cwd_class: "repository_root" as const,
    env_allowlist: [],
    timeout_ms: 30_000,
    network: "deny" as const,
    writable_outputs: [],
    // t22D-fix-round-6: when failLast, the verification exits 1 and the
    // sealed allowlist is [0] so exit 1 is NOT permitted and fails closed.
    // (Previously this was [1], which under the corrected classifier
    // semantics means exit 1 is a permitted pass — contradicting the test's
    // intent of "one verification fails".)
    expected_exit_codes: opts.failLast ? [0] : [0],
  });
  const verificationIds = verifications.map((v) => v.id);
  return {
    schema_version: "1.0.0",
    id: "t42",
    title: "Multi-verification iteration",
    description: "Prove the verification provider iterates all sealed contract verification IDs.",
    depends_on: [],
    scope: [{ path: "src/feature.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-MV",
      description: "All verifications pass.",
      interface_ids: [],
      verification_ids: verificationIds,
    }],
    verifications,
    budgets: { max_attempts: 2, max_review_cycles: 2, wall_clock_ms: 120_000, remediation_limit: 1 },
  };
}

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly ownership: ReturnType<typeof provisionAttemptWorkspace> extends { readonly workspace?: infer W } ? W : never;
  readonly verifyPhase: ResolvedPhaseContext;
  readonly candidateOid: string;
  readonly baselineOid: string;
}

function buildFixture(opts: { readonly failLast?: boolean; readonly failExecutable?: string; readonly count: number }): Fixture {
  const repo = makeRepo();
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const draft = multiVerificationDraft(opts);
  const sealedContract = sealTicketContracts([draft], { repositoryRoot: repo })[0]!;
  const resolver = new IdentityContextResolver(store);
  const leases = new LeaseAuthority(store);
  const baselineOid = git(repo, "rev-parse", "HEAD");
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: baselineOid,
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
  // Activate run + ticket rows (required before acquisition).
  updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
  updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt.ticketInstanceId, { state: "active", state_version: 1 });
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: attempt.attemptId,
    idempotencyKey: `acquire:mv`,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) {
    throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  }
  const ownership = provisioned.workspace.ownership;
  // Create the policy bundle directory so the execution context resolves.
  mkdirSync(ownership.plan.policyBundlePath, { recursive: true, mode: 0o700 });
  // Resolve the verification phase context (matching the runner's pattern).
  const verifyPhase = new AttemptExecutionContextAuthority(store).resolveExecutionContext({
    attempt,
    contract: sealedContract,
    phase: "verification",
    phaseOrdinal: 3,
    role: "verifier",
    ownership: acquired,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot: dirname(acquired.plan.policyContextPath),
      bundleDir: acquired.plan.policyBundlePath,
      requestedBundleSha256: createHash("sha256").update(acquired.plan.policyBundlePath, "utf8").digest("hex"),
    },
    modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
    timeoutMs: 30_000,
    callerRepositoryRealpath: repo,
  });
  // Commit a candidate on the attempt ref with a nonempty diff within scope.
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "feature.ts"), "export const feature = true;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/feature.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "candidate"]);
  const candidateOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
  // Walk the attempt through the legal transition chain to "verifying"
  // (the gate result persistence guard requires a.state = 'verifying').
  const preVerifyStates = [
    "implementing", "implementation_captured", "reviewing",
    "verification_queued", "verifying",
  ] as const;
  for (let i = 0; i < preVerifyStates.length; i++) {
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: preVerifyStates[i],
      state_version: i + 1,
    });
  }
  return {
    repo, store, leases, contract: sealedContract, run, attempt,
    ownership, verifyPhase, candidateOid, baselineOid,
  } as Fixture;
}

// ---------------------------------------------------------------------------
// Structural test: the provider iterates all verifications (no [0] selection).
// ---------------------------------------------------------------------------

describe("structural: verification provider iterates all sealed contract verification IDs", () => {
  it("attempt-runner-providers.ts does NOT select only contract.verifications[0]", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    const verifyStart = source.indexOf("verification(input: VerificationInput): VerificationResult");
    expect(verifyStart).toBeGreaterThanOrEqual(0);
    const verifyEnd = source.indexOf("oracle(input: OracleInput)", verifyStart);
    expect(verifyEnd).toBeGreaterThan(verifyStart);
    const verifyBody = source.slice(verifyStart, verifyEnd);
    // The fail-open pattern: selecting only verifications[0] means a contract
    // with 2+ verification IDs cannot terminalize.  The provider must iterate
    // ALL verifications.
    expect(verifyBody).not.toMatch(/contract\.verifications\[0\]/);
  });

  it("attempt-runner-providers.ts iterates all contract.verifications", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    const verifyStart = source.indexOf("verification(input: VerificationInput): VerificationResult");
    const verifyEnd = source.indexOf("oracle(input: OracleInput)", verifyStart);
    const verifyBody = source.slice(verifyStart, verifyEnd);
    // The provider must iterate all verifications — any loop construct that
    // covers the full array (for...of, .forEach, .map, or indexed for loop).
    expect(verifyBody).toMatch(
      /for\s*\(.*of\s+verifications|verifications\.forEach|verifications\.map|for\s*\(let\s+\w+\s*=\s*0;\s*\w+\s*<\s+verifications\.length/
    );
  });
});

// ---------------------------------------------------------------------------
// (a) Multi-verification success: all pass, all gate results created.
// ---------------------------------------------------------------------------

describe("(a) multi-verification success: 2+ verification IDs all pass", () => {
  it("creates a gate result for EVERY sealed contract verification ID", () => {
    const fixture = buildFixture({ count: 3 });
    const providers = buildAttemptRunnerProviders(fixture.store, fixture.leases);
    const result = providers.verification!({
      ownership: fixture.ownership,
      phase: {
        phaseExecutionId: fixture.verifyPhase.persisted.phaseExecutionId,
        contextId: fixture.verifyPhase.persisted.contextId,
        contextDigest: fixture.verifyPhase.persisted.contextDigest as `sha256:${string}`,
        phase: "verification",
        phaseOrdinal: 3,
        role: "verifier",
      },
      review: {
        reviewRecordId: `review-${fixture.attempt.attemptId}`,
        verdict: "accept",
        reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}`,
      },
      contract: fixture.contract,
    });
    // The status must be "pass" — all verifications pass.
    expect(result.status).toBe("pass");
    // Query the DB for gate_results.  There must be ONE per verification ID.
    const gateResults = queryAll(fixture.store.location.databasePath,
      "SELECT gate_id, status FROM gate_results WHERE attempt_id = ? ORDER BY gate_id",
      fixture.attempt.attemptId);
    const expectedGateIds = fixture.contract.verifications.map((v) => v.id).sort();
    expect(gateResults.length).toBe(expectedGateIds.length);
    expect(gateResults.map((r) => String(r.gate_id))).toEqual(expectedGateIds);
    // Every gate result must have status "passed".
    for (const row of gateResults) {
      expect(String(row.status)).toBe("passed");
    }
  });

  it("the VerificationResult carries all gate result IDs (gateResultIds)", () => {
    const fixture = buildFixture({ count: 2 });
    const providers = buildAttemptRunnerProviders(fixture.store, fixture.leases);
    const result = providers.verification!({
      ownership: fixture.ownership,
      phase: {
        phaseExecutionId: fixture.verifyPhase.persisted.phaseExecutionId,
        contextId: fixture.verifyPhase.persisted.contextId,
        contextDigest: fixture.verifyPhase.persisted.contextDigest as `sha256:${string}`,
        phase: "verification",
        phaseOrdinal: 3,
        role: "verifier",
      },
      review: {
        reviewRecordId: `review-${fixture.attempt.attemptId}`,
        verdict: "accept",
        reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}`,
      },
      contract: fixture.contract,
    });
    // The result must carry a gateResultIds array with one entry per verification.
    const ids = (result as { readonly gateResultIds?: readonly string[] }).gateResultIds;
    expect(ids).toBeDefined();
    expect(ids!.length).toBe(fixture.contract.verifications.length);
  });
});

// ---------------------------------------------------------------------------
// (b) Failed required verification: one fails, status is "fail" (fail-closed).
// ---------------------------------------------------------------------------

describe("(b) failed required verification: one verification fails, terminalization fails closed", () => {
  it("returns status 'fail' when one verification fails", () => {
    const fixture = buildFixture({ count: 2, failLast: true });
    const providers = buildAttemptRunnerProviders(fixture.store, fixture.leases);
    const result = providers.verification!({
      ownership: fixture.ownership,
      phase: {
        phaseExecutionId: fixture.verifyPhase.persisted.phaseExecutionId,
        contextId: fixture.verifyPhase.persisted.contextId,
        contextDigest: fixture.verifyPhase.persisted.contextDigest as `sha256:${string}`,
        phase: "verification",
        phaseOrdinal: 3,
        role: "verifier",
      },
      review: {
        reviewRecordId: `review-${fixture.attempt.attemptId}`,
        verdict: "accept",
        reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}`,
      },
      contract: fixture.contract,
    });
    // The status must be "fail" — a failed required verification fails closed.
    // The runner branches to the ordinary-failure state machine (not terminalize).
    expect(result.status).toBe("fail");
    // The failing gate result must have status "failed" in the DB.
    const gateResults = queryAll(fixture.store.location.databasePath,
      "SELECT gate_id, status FROM gate_results WHERE attempt_id = ? ORDER BY gate_id",
      fixture.attempt.attemptId);
    const failing = gateResults.find((r) => String(r.gate_id) === "VER-MV-1");
    expect(failing).toBeDefined();
    expect(String(failing!.status)).toBe("failed");
    // The passing gate result must have status "passed".
    const passing = gateResults.find((r) => String(r.gate_id) === "VER-MV-0");
    expect(passing).toBeDefined();
    expect(String(passing!.status)).toBe("passed");
  });

  it("returns status 'infrastructure_error' when a verification argv cannot be found", () => {
    // Build a fixture where one verification has a non-existent executable.
    // The store validates the gate_id against the attempt's sealed contract,
    // so the bad executable must be in the SAME contract the attempt was
    // allocated with.
    const fixture = buildFixture({ count: 2, failLast: true, failExecutable: "/nonexistent/binary" });
    const providers = buildAttemptRunnerProviders(fixture.store, fixture.leases);
    // The bad executable triggers an infrastructure_error (ENOENT).
    const result = providers.verification!({
      ownership: fixture.ownership,
      phase: {
        phaseExecutionId: fixture.verifyPhase.persisted.phaseExecutionId,
        contextId: fixture.verifyPhase.persisted.contextId,
        contextDigest: fixture.verifyPhase.persisted.contextDigest as `sha256:${string}`,
        phase: "verification",
        phaseOrdinal: 3,
        role: "verifier",
      },
      review: {
        reviewRecordId: `review-${fixture.attempt.attemptId}`,
        verdict: "accept",
        reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}`,
      },
      contract: fixture.contract,
    });
    // An infrastructure error must propagate as "infrastructure_error" (fail-closed).
    expect(result.status).toBe("infrastructure_error");
  });
});

// ---------------------------------------------------------------------------
// (c) Docker integration: full production path with multi-verification PRD.
//     Drives runBuildViaRunnerForTesting with real providers and real Docker
//     containment.  Asserts outcome.status === "succeeded".
// ---------------------------------------------------------------------------

describe("(c) Docker integration: multi-verification terminalization succeeds", () => {
  it("runBuildViaRunnerForTesting with multi-verification PRD asserts outcome.status === 'succeeded'", async () => {
    // Check Docker and the runner image are available.
    let dockerAvailable = false;
    try {
      execFileSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      execFileSync("docker", ["image", "inspect", "rickgent-runner:latest"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      dockerAvailable = true;
    } catch {
      dockerAvailable = false;
    }
    if (!dockerAvailable) {
      console.log("Skipping Docker integration test: Docker or runner image not available");
      return;
    }

    const repo = makeRepo();
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const fixtureOmnigentDir = realpathSync(join(orchestratorRoot, "test", "fixtures", "omnigent-fixture"));
    const realAgentDir = realpathSync(agentDir);
    const dockerBackend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      hostMounts: [fixtureOmnigentDir, realAgentDir],
      containerPath: [fixtureOmnigentDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      containerAgentDir: realAgentDir,
      extraEnv: { FIXTURE_MODE: "prompt" },
    });

    const prdPath = join(repoRoot, "fixtures", "prd-multi-verification.md");
    expect(existsSync(prdPath)).toBe(true);

    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath,
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        env: {
          ...process.env,
          RICKGENT_DIR: rickgentDir,
          RICKGENT_CONTAINMENT_DOCKER_IMAGE: "rickgent-runner:latest",
        },
      },
      {
        containmentBackendOverride: dockerBackend,
      },
    );

    if (result.outcome.status !== "succeeded") {
      console.log("Build report:", JSON.stringify(result.report, null, 2));
      console.log("Build outcome:", JSON.stringify(result.outcome, null, 2));
    }
    expect(result.outcome.status).toBe("succeeded");
    expect(result.outcome.stableCode).toBe("RICKGENT_OK");
    expect(result.ticketsDone).toBeGreaterThan(0);
  }, 180_000);
});
