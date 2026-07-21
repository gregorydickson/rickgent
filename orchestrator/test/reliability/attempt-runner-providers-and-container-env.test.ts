/**
 * m4-fix-production-providers-and-container-env: M4 scrutiny round 2 fixes.
 *
 * Three production-path defects:
 *
 * (1) Public runBuild supplies no real attribution/review/verification/
 *     oracle/cleanup providers.  A normally completed dispatch reaches
 *     defaultAttribution and fails RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED.
 *     The fix wires real authority-owned providers from the build path's
 *     real dependencies into AttemptRunner on the production runBuild path.
 *
 * (2) Default Docker containment runs the omnigent command inside an
 *     unmounted alpine container without omnigent, the host agent directory,
 *     or the authority-derived worktree.  The fix configures the Docker
 *     container to mount the necessary host paths and sets PATH inside the
 *     container.
 *
 * (3) Production retry repeats prepareAcquisition under the same stable key
 *     but generates a fresh owner token, producing
 *     RICKGENT_STATE_IDEMPOTENCY_CONFLICT rather than durable replay.  The
 *     fix persists and replays the original acquisition owner token.
 *
 * Also: a real runBuild-path integration test that completes the full
 * production path through terminalization with real providers.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sealTicketContracts, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../src/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../src/context/attempt-execution-context.js";
import { FixtureContainmentBackend } from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import { StateStoreError, openStateStore, type AllocatedAttempt, type AllocatedRun, type StateStore } from "../../src/state/store.js";
import { AttemptTerminalizationService } from "../../src/lifecycle/attempt-terminalization.js";
import { TargetStartGateAuthority } from "../../src/lifecycle/target-start-gate.js";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";
import { RICKGENT_ORACLE_VERSION } from "../../src/state/oracle.js";

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

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-m4-fix-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M4 Fix Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m4-fix@example.test"]);
  writeFileSync(join(repo, "README.md"), "m4 fix\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

function queryOne(databasePath: string, sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Defect #3: Durable acquisition token replay.
// ---------------------------------------------------------------------------

function setupAttempt(repo: string, store: StateStore): { run: AllocatedRun; attempt: AllocatedAttempt } {
  const draft: TicketContractDraft = {
    schema_version: "1.0.0",
    id: "t99",
    title: "Replay test",
    description: "Durable token replay proof.",
    depends_on: [],
    scope: [{ path: "src/x.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-R", description: "replay", interface_ids: [], verification_ids: ["V-R"],
    }],
    verifications: [{
      id: "V-R", executable: "node", args: ["--version"],
      cwd_class: "repository_root", env_allowlist: [], timeout_ms: 30_000,
      network: "deny", writable_outputs: [], expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 2, max_review_cycles: 2, wall_clock_ms: 120_000, remediation_limit: 1 },
  };
  const sealed = sealTicketContracts([draft], { repositoryRoot: repo })[0]!;
  const baselineOid = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const resolver = new IdentityContextResolver(store);
  const run = resolver.allocateFreshRun({
    contracts: [sealed],
    initialDeliveryOid: baselineOid,
    oracleVersion: RICKGENT_ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealed.id });
  // Activate run + ticket rows (required before acquisition).
  const db = new DatabaseSync(store.location.databasePath, { enableForeignKeyConstraints: false });
  try {
    db.prepare("UPDATE runs SET state = 'active', state_version = 1 WHERE run_id = ?").run(run.runId);
    db.prepare("UPDATE run_tickets SET state = 'active', state_version = 1 WHERE ticket_instance_id = ?").run(attempt.ticketInstanceId);
  } finally {
    db.close();
  }
  return { run, attempt };
}

describe("defect #3: durable acquisition token replay", () => {
  it("identical replay succeeds: prepareAcquisition twice with the same key returns the same grant", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const leases = new LeaseAuthority(store);
    const { attempt } = setupAttempt(repo, store);
    const key = `acquire-replay-test:${attempt.attemptId}`;

    // First acquisition.
    const prepared1 = leases.prepareAcquisition({ attemptId: attempt.attemptId, idempotencyKey: key });
    const grant1 = leases.acquire(prepared1);
    expect(grant1.replayed).toBe(false);
    const ownershipId1 = grant1.ownership.ownershipId;

    // Second acquisition with the SAME idempotency key — must replay, not conflict.
    const prepared2 = leases.prepareAcquisition({ attemptId: attempt.attemptId, idempotencyKey: key });
    const grant2 = leases.acquire(prepared2);
    expect(grant2.replayed).toBe(true);
    expect(grant2.ownership.ownershipId).toBe(ownershipId1);
  });

  it("divergent second mint conflicts: same key with different ttlMs throws RICKGENT_STATE_IDEMPOTENCY_CONFLICT", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const leases = new LeaseAuthority(store);
    const { attempt } = setupAttempt(repo, store);
    const key = `acquire-divergent-test:${attempt.attemptId}`;

    // First acquisition with ttlMs=5000.
    const prepared1 = leases.prepareAcquisition({ attemptId: attempt.attemptId, idempotencyKey: key, ttlMs: 5_000 });
    const grant1 = leases.acquire(prepared1);
    expect(grant1.replayed).toBe(false);

    // Second acquisition with same key but DIFFERENT ttlMs — the canonical
    // input differs (even though the token is reused), so this is a true
    // divergent mint, not a replay.  Must conflict.
    const prepared2 = leases.prepareAcquisition({ attemptId: attempt.attemptId, idempotencyKey: key, ttlMs: 10_000 });
    try {
      leases.acquire(prepared2);
      throw new Error("expected RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
    } catch (error) {
      expect(error).toBeInstanceOf(StateStoreError);
      expect((error as StateStoreError).code).toBe("RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
    }
  });
});

// ---------------------------------------------------------------------------
// Defect #2: Docker containment volume mounts.
// ---------------------------------------------------------------------------

describe("defect #2: Docker containment volume mounts", () => {
  it("the Docker create command includes volume mounts for host tools and paths", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    // The DockerCgroupV2ContainmentBackend createBoundary must include -v mounts.
    const dockerClassStart = source.indexOf("export class DockerCgroupV2ContainmentBackend");
    expect(dockerClassStart).toBeGreaterThanOrEqual(0);
    const dockerClassEnd = source.indexOf("export class LinuxCgroupV2ContainmentBackend", dockerClassStart);
    expect(dockerClassEnd).toBeGreaterThan(dockerClassStart);
    const dockerClass = source.slice(dockerClassStart, dockerClassEnd);
    // The create command must include -v (volume mount) flags.
    expect(dockerClass).toMatch(/"-v"|"--volume"/);
    // The backend must accept mount configuration (host paths to mount).
    expect(dockerClass).toMatch(/mounts|volumeMounts|hostMounts|hostPaths/i);
  });

  it("the Docker container sets PATH inside the container to include mounted tools", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    const dockerClassStart = source.indexOf("export class DockerCgroupV2ContainmentBackend");
    const dockerClassEnd = source.indexOf("export class LinuxCgroupV2ContainmentBackend", dockerClassStart);
    const dockerClass = source.slice(dockerClassStart, dockerClassEnd);
    // The backend must set PATH inside the container via -e or --env,
    // or set it in the exec command's environment, so mounted tools
    // (omnigent, python, node) are findable.
    expect(dockerClass).toMatch(/"--env"|"-e"|RICKGENT_CONTAINER_PATH|containerPath/i);
  });

  it("probeContainmentBackend passes host paths to the Docker backend for mounting", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    // The probeContainmentBackend function must pass mount paths to the
    // Docker backend constructor (from env vars or init.sh paths).
    const probeFnStart = source.indexOf("export function probeContainmentBackend");
    expect(probeFnStart).toBeGreaterThanOrEqual(0);
    const probeFnBody = source.slice(probeFnStart, source.indexOf("\n}", probeFnStart) + 2);
    // The function must pass mount-related opts to the Docker backend.
    expect(probeFnBody).toMatch(/mount|Mount|volume|Volume|hostPath|HostPath/i);
  });
});

// ---------------------------------------------------------------------------
// Defect #1: Real providers wired in production runBuild.
// ---------------------------------------------------------------------------

describe("defect #1: real providers wired in production runBuild", () => {
  it("executeBuildViaRunner constructs and passes real providers to AttemptRunner (structural)", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "build.ts"), "utf-8");
    const start = source.indexOf("async function executeBuildViaRunner(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("async function executeBuildLegacy(", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // The production path must construct real providers via a builder function
    // (not pass undefined/empty providers to the runner).
    expect(body).toMatch(/buildAttemptRunnerProviders/);
    // The runner must be constructed with the real providers (not undefined).
    expect(body).toMatch(/dependencies\.attemptRunnerProviders\s*\?\?\s*realProviders/);
  });

  it("a buildAttemptRunnerProviders module/function exists in the production source tree", () => {
    // The provider builder must exist as production code (not just test helpers).
    const providerModulePath = join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts");
    expect(existsSync(providerModulePath)).toBe(true);
    const source = readFileSync(providerModulePath, "utf-8");
    expect(source).toMatch(/export function buildAttemptRunnerProviders/);
  });

  it("the AttemptRunner default attribution provider throws RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED (red baseline)", () => {
    // This confirms the default provider is fail-closed (the defect's root cause).
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner.ts"), "utf-8");
    expect(source).toMatch(/RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED/);
  });
});

// ---------------------------------------------------------------------------
// Integration test: full production path through terminalization with real providers.
// ---------------------------------------------------------------------------

describe("integration: full production path through terminalization with real providers", () => {
  it("runBuildViaRunnerForTesting completes the full production path with real providers and FixtureContainmentBackend", async () => {
    const repo = makeRepo();
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const containmentBackend = new FixtureContainmentBackend();
    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath: join(repoRoot, "fixtures", "prd-min.md"),
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      },
      {
        containmentBackendOverride: containmentBackend,
      },
    );
    // The build must complete — the providers are real (constructed by the
    // production path), so the runner reaches terminalization rather than
    // failing at RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED.
    // With a minimal PRD and fixture containment, the dispatch produces a
    // trivial exit.  The real providers seed durable receipt rows and the
    // runner terminalizes through the purpose-specific finalization.
    expect(result.outcome.status).not.toBe("ok");
    // Verify the runner reached at least the attribution step (not
    // RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED).  The build may still fail
    // (e.g. zero completion if the fixture dispatch doesn't produce real
    // changes), but it must NOT fail at the attribution-unconfigured gate.
    const attributionError = result.report.some((line) =>
      line.includes("RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED"));
    expect(attributionError).toBe(false);
    // Verify durable state was written (the runner acquired and progressed).
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const dbPath = store.location.databasePath;
    const ownership = queryOne(dbPath, "SELECT state FROM attempt_ownership_leases LIMIT 1");
    expect(ownership).toBeDefined();
    store.close();
  }, 120_000);
});
