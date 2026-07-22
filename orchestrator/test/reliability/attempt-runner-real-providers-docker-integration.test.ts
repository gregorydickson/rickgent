/**
 * m4-fix-real-providers-container-image-and-atomic-acquisition: M4 scrutiny
 * round 3 fixes.
 *
 * Four production-path defects:
 *
 * (1) Providers use real authority APIs — no direct SQL, no manufactured
 *     facts.  The providers call persistAuthorityEvidence,
 *     persistAuthorityCommitAttribution, createAndSealAuthorityTargetProofSet,
 *     LifecycleRecordAuthority.recordReview/recordGateResult, and
 *     evaluateAndPersistAttemptOracle.  No FK-disabled inserts.
 *
 * (2) Docker runner image is Linux-compatible (python:3.12-alpine + Node.js +
 *     omnigent).  RICKGENT_AGENT_DIR is propagated into the container.
 *
 * (3) Production-path integration test uses the REAL Docker containment
 *     backend (DockerCgroupV2ContainmentBackend, not FixtureContainmentBackend),
 *     drives the full runBuild entrypoint with real providers, and asserts
 *     successful terminalization (result.outcome.status === "ok").
 *
 * (4) Acquisition token persistence is atomic — persistence failure blocks
 *     acquisition (no swallowed errors).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sealTicketContracts, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../src/context/resolver.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import { RICKGENT_ORACLE_VERSION } from "../../src/state/oracle.js";
import { openStateStore, type AllocatedAttempt, type AllocatedRun, type StateStore } from "../../src/state/store.js";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { DockerCgroupV2ContainmentBackend } from "../../src/process/containment.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-m4fix3-")));
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

// ---------------------------------------------------------------------------
// Defect #1: Providers use real authority APIs (no direct SQL).
// ---------------------------------------------------------------------------

describe("defect #1: providers use real authority APIs", () => {
  it("attempt-runner-providers.ts has no openRaw or insertRow direct-SQL functions", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    // The manufacturing helpers (openRaw, insertRow, queryOne, evidenceRow)
    // must NOT exist in the rewritten providers.
    expect(source).not.toMatch(/function openRaw\b/);
    expect(source).not.toMatch(/function insertRow\b/);
    expect(source).not.toMatch(/function queryOne\b/);
    expect(source).not.toMatch(/function evidenceRow\b/);
    expect(source).not.toMatch(/enableForeignKeyConstraints:\s*false/);
  });

  it("providers call real authority APIs (persistAuthorityEvidence, persistAuthorityCommitAttribution, etc.)", () => {
    const providerSource = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    const runnerSource = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner.ts"), "utf-8");
    // The providers must use the authority-branded Store methods.
    expect(providerSource).toMatch(/store\.persistAuthorityEvidence\b/);
    // persistAuthorityCommitAttribution is called by the runner after verification
    // (it requires verification receipt digests which are only available post-verification).
    expect(runnerSource).toMatch(/persistAuthorityCommitAttribution\b/);
    expect(providerSource).toMatch(/store\.createAndSealAuthorityTargetProofSet\b/);
    expect(providerSource).toMatch(/lifecycleRecords\.recordReview\b/);
    expect(providerSource).toMatch(/lifecycleRecords\.recordGateResult\b/);
    // t28-fix: the oracle provider routes through CompletionService
    // (the sole lifecycle-layer route to Oracle v2), not a direct
    // StateStore.evaluateAndPersistAttemptOracle call.
    expect(providerSource).toMatch(/CompletionService/);
    expect(providerSource).toMatch(/evaluateAttemptCompletion/);
  });

  it("the store has the new authority-branded methods", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "state", "store.ts"), "utf-8");
    expect(source).toMatch(/persistAuthorityEvidence\b/);
    expect(source).toMatch(/persistAuthorityCommitAttribution\b/);
    expect(source).toMatch(/createAndSealAuthorityTargetProofSet\b/);
  });
});

// ---------------------------------------------------------------------------
// Defect #2: Docker runner image is Linux-compatible.
// ---------------------------------------------------------------------------

describe("defect #2: Docker runner image is Linux-compatible", () => {
  it("the Dockerfile exists and is based on python:3.12-alpine with Node.js", () => {
    const dockerfilePath = join(repoRoot, "docker", "runner.Dockerfile");
    expect(existsSync(dockerfilePath)).toBe(true);
    const source = readFileSync(dockerfilePath, "utf-8");
    expect(source).toMatch(/FROM python:3.12-alpine/);
    expect(source).toMatch(/nodejs/);
  });

  it("the build script exists", () => {
    const scriptPath = join(repoRoot, "scripts", "build-runner-image.sh");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("the Docker backend defaults to rickgent-runner:latest (not alpine:latest)", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    // The default image should be rickgent-runner:latest, not alpine:latest.
    const dockerClassStart = source.indexOf("export class DockerCgroupV2ContainmentBackend");
    const dockerClassEnd = source.indexOf("export class LinuxCgroupV2ContainmentBackend", dockerClassStart);
    const dockerClass = source.slice(dockerClassStart, dockerClassEnd);
    expect(dockerClass).toMatch(/rickgent-runner:latest/);
    expect(dockerClass).not.toMatch(/alpine:latest/);
  });

  it("the Docker backend propagates RICKGENT_AGENT_DIR into the container", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    const dockerClassStart = source.indexOf("export class DockerCgroupV2ContainmentBackend");
    const dockerClassEnd = source.indexOf("export class LinuxCgroupV2ContainmentBackend", dockerClassStart);
    const dockerClass = source.slice(dockerClassStart, dockerClassEnd);
    expect(dockerClass).toMatch(/containerAgentDir/);
    expect(dockerClass).toMatch(/RICKGENT_AGENT_DIR/);
  });

  it("probeContainmentBackend passes agentDir to the Docker backend", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    const probeFnStart = source.indexOf("export function probeContainmentBackend");
    const probeFnBody = source.slice(probeFnStart);
    expect(probeFnBody).toMatch(/containerAgentDir/);
  });

  it("executeBuildViaRunner passes opts.agentDir to probeContainmentBackend (not sticky env)", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "build.ts"), "utf-8");
    const start = source.indexOf("async function executeBuildViaRunner(");
    const end = source.indexOf("async function executeBuildLegacy(", start);
    const body = source.slice(start, end);
    // t22D-fix-round-5 (defect #2): The production path must pass opts.agentDir
    // to probeContainmentBackend as an explicit per-request parameter.  It
    // must NOT mutate the sticky process.env.RICKGENT_AGENT_DIR.
    expect(body).toMatch(/opts\.agentDir/);
    expect(body).toMatch(/probeContainmentBackend/);
    expect(body).toMatch(/agentDir.*opts\.agentDir|opts\.agentDir.*agentDir/);
    // The production path must NOT set process.env.RICKGENT_AGENT_DIR.
    expect(body).not.toMatch(/process\.env\.RICKGENT_AGENT_DIR\s*=/);
  });
});

// ---------------------------------------------------------------------------
// Defect #4: Atomic acquisition token persistence.
// ---------------------------------------------------------------------------

describe("defect #4: atomic acquisition token persistence", () => {
  it("prepareAcquisition throws when token persistence fails (no swallowed errors)", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const leases = new LeaseAuthority(store);

    // Make the acquisition-tokens directory unwritable so persistence fails.
    const tokenDir = join(store.location.stateDirectory, "acquisition-tokens");
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
    // Create a file at the token path to block directory creation
    // Actually, make the directory read-only to block file creation.
    chmodSync(tokenDir, 0o400);

    try {
      expect(() => {
        leases.prepareAcquisition({
          attemptId: "test-fail-persist",
          idempotencyKey: "fail-persist-key",
        });
      }).toThrow();
    } finally {
      // Restore permissions for cleanup.
      chmodSync(tokenDir, 0o700);
    }
  });

  it("recovery/replay: prepareAcquisition reads the persisted token on retry", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const leases = new LeaseAuthority(store);
    const { attempt } = setupAttempt(repo, store);

    // First acquisition persists the token.
    const prepared1 = leases.prepareAcquisition({
      attemptId: attempt.attemptId,
      idempotencyKey: "replay-key",
    });
    const grant1 = leases.acquire(prepared1);
    expect(grant1.replayed).toBe(false);

    // Second acquisition with the same key reads the persisted token.
    const prepared2 = leases.prepareAcquisition({
      attemptId: attempt.attemptId,
      idempotencyKey: "replay-key",
    });
    const grant2 = leases.acquire(prepared2);
    expect(grant2.replayed).toBe(true);
    expect(grant2.ownership.ownershipId).toBe(grant1.ownership.ownershipId);
  });
});

// ---------------------------------------------------------------------------
// Defect #3: Production-path integration test with REAL Docker containment.
// ---------------------------------------------------------------------------

describe("defect #3: production-path integration test with real Docker", () => {
  // This test uses the REAL Docker containment backend
  // (DockerCgroupV2ContainmentBackend, not FixtureContainmentBackend),
  // drives the full executeBuildViaRunner path with real providers, and
  // asserts successful terminalization (result.outcome.status === "succeeded").
  //
  // t22D-fix-round-5 (defect #3): The test uses the REAL `omnigent run
  // <agentDir> --no-session -p <prompt>` dispatch argv — no dispatch argv
  // override, no `sh -c` bypass.  The fixture omnigent (from
  // orchestrator/test/fixtures/omnigent-fixture/) is mounted into the
  // container via -v volume mount and placed on the container PATH so the
  // real `omnigent` command resolves to the fixture.  FIXTURE_MODE=prompt is
  // set inside the container so the fixture writes the contract's scope path
  // from the prompt.  The test proves the advertised omnigent command is
  // runnable in the production container without any override.
  //
  // Skipped when Docker is not available or the runner image is not built.
  it("runBuildViaRunnerForTesting with real Docker containment asserts outcome.status === 'succeeded'", async () => {
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

    // t22D-fix-round-5 (defect #3): Mount the fixture omnigent into the
    // container and place it on the container PATH so the real `omnigent run`
    // dispatch argv resolves to the fixture.  The fixture omnigent is a bash
    // script that delegates to fixture.mjs (a node script).  The Dockerfile
    // installs nodejs, so `node` is available inside the container.  The
    // fixture directory is bind-mounted at the same path so the bash script's
    // $DIR resolves correctly.
    //
    // FIXTURE_MODE=prompt is set via extraEnv so the fixture extracts the
    // contract scope path from the prompt and writes it to the worktree CWD.
    // The worktree is mounted separately via the containment lineage.
    const fixtureOmnigentDir = realpathSync(join(orchestratorRoot, "test", "fixtures", "omnigent-fixture"));
    const realAgentDir = realpathSync(agentDir);
    const dockerBackend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      // Mount the fixture omnigent directory and the agent bundle directory.
      hostMounts: [fixtureOmnigentDir, realAgentDir],
      // The fixture directory comes first on PATH so `omnigent` resolves to
      // the fixture script, not the real omnigent installed in the image.
      containerPath: [fixtureOmnigentDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      // RICKGENT_AGENT_DIR inside the container points to the agent bundle.
      containerAgentDir: realAgentDir,
      // FIXTURE_MODE=prompt so the fixture writes the file from the prompt.
      extraEnv: { FIXTURE_MODE: "prompt" },
    });

    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath: join(repoRoot, "fixtures", "prd-min.md"),
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
        // t22D-fix-round-5 (defect #3): Use the REAL Docker containment
        // backend configured with the fixture omnigent mounted.  No
        // dispatch argv override — the real `omnigent run <agentDir>
        // --no-session -p <prompt>` argv is used.  NO
        // attemptRunnerProviders override — the REAL providers are used.
        containmentBackendOverride: dockerBackend,
      },
    );

    // The build MUST complete successfully — the providers are real, the
    // containment is real Docker, and the fixture omnigent produces real
    // changes via the real omnigent run argv.
    if (result.outcome.status !== "succeeded") {
      console.log("Build report:", JSON.stringify(result.report, null, 2));
      console.log("Build outcome:", JSON.stringify(result.outcome, null, 2));
    }
    expect(result.outcome.status).toBe("succeeded");
    expect(result.outcome.stableCode).toBe("RICKGENT_OK");
    expect(result.ticketsDone).toBeGreaterThan(0);
  }, 180_000);
});
