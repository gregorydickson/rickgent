/**
 * m4-fix-expected-exit-codes-production-proof: M4 scrutiny round 7 blocking
 * defect.
 *
 * The expected_exit_codes fix (M4 scrutiny round 6, commit d14b75a) has direct
 * provider tests (`attempt-runner-expected-exit-codes.test.ts`) that invoke
 * `providers.verification!()` directly.  Those tests do NOT prove a valid
 * permitted-nonzero contract terminalizes successfully through the full
 * production path (`runBuildViaRunnerForTesting` → `executeBuildViaRunner` →
 * `AttemptRunner.runAttempt` → providers.verification → oracle →
 * terminalization).  A helper-level test passing while the production
 * terminalization path stays vulnerable is a scrutiny failure (invariant 10:
 * verify at the production entrypoint, not just helper level).
 *
 * This file adds the missing production-entrypoint proof:
 *
 *   (a) Permitted-nonzero success: `runBuildViaRunnerForTesting` with a sealed
 *       `expected_exit_codes` allowlist containing the command's nonzero exit
 *       (expected_exit_codes `[1]`, verification command exits 1).  Asserts
 *       `outcome.status === "succeeded"` — the full production path
 *       terminalizes a valid permitted-nonzero contract.
 *
 *   (b) Excluded-exit fail-closed: `runBuildViaRunnerForTesting` with a sealed
 *       `expected_exit_codes` allowlist that does NOT contain the command's
 *       exit (expected_exit_codes `[1]`, verification command exits 2).
 *       Asserts `outcome.status !== "succeeded"` — the production path fails
 *       closed when the observed exit is not in the sealed allowlist.
 *
 * Both tests drive the REAL production entrypoint with a FixtureContainmentBackend
 * replaced by a real `DockerCgroupV2ContainmentBackend` (the same backend the
 * `attempt-runner-multi-verification.test.ts` Docker integration uses), the
 * real fixture omnigent mounted into the container, and the real
 * `buildAttemptRunnerProviders` providers constructed by the production path.
 * The dispatch argv is the real `omnigent run <agentDir> --no-session -p
 * <prompt>` command — no `dispatchArgvOverride`, no `sh -c` bypass.
 *
 * Red-then-green proof: before the expected_exit_codes fix (round 6), test
 * (a) fails because exit 1 is classified as "fail" by the hardcoded
 * `e.status === 0 ? "pass" : "fail"` classifier, so the gate result is
 * "failed", the oracle rejects, and `outcome.status` is "failed" (not
 * "succeeded").  After the fix, the classifier consults the sealed allowlist
 * and exit 1 is a permitted pass, so the oracle accepts and the runner
 * terminalizes successfully.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { DockerCgroupV2ContainmentBackend } from "../../src/process/containment.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-exit-codes-prod-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Exit-Codes Prod Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "exit-codes-prod@example.test"]);
  writeFileSync(join(repo, "README.md"), "expected exit codes production proof\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

/**
 * Check Docker and the runner image are available.  Both tests in this file
 * require real Docker containment (the production-path proof must drive the
 * real containment-backed dispatch, not a fixture-only backend that ignores
 * the workdir option).  When Docker or the runner image is unavailable, the
 * tests skip (consistent with `attempt-runner-multi-verification.test.ts`).
 */
function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.OSType}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("docker", ["image", "inspect", "rickgent-runner:latest"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function makeDockerBackend(): DockerCgroupV2ContainmentBackend {
  const fixtureOmnigentDir = realpathSync(join(orchestratorRoot, "test", "fixtures", "omnigent-fixture"));
  const realAgentDir = realpathSync(join(repoRoot, "agents", "rickgent"));
  return new DockerCgroupV2ContainmentBackend({
    image: "rickgent-runner:latest",
    hostMounts: [fixtureOmnigentDir, realAgentDir],
    containerPath: [fixtureOmnigentDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    containerAgentDir: realAgentDir,
    extraEnv: { FIXTURE_MODE: "prompt" },
  });
}

// ---------------------------------------------------------------------------
// (a) Permitted-nonzero success: expected_exit_codes [1], command exits 1.
//     The full production path must terminalize successfully.
// ---------------------------------------------------------------------------

describe("(a) production-entrypoint permitted-nonzero terminalization succeeds", () => {
  it("runBuildViaRunnerForTesting with expected_exit_codes [1] and exit 1 asserts outcome.status === 'succeeded'", async () => {
    if (!dockerAvailable()) {
      console.log("Skipping Docker integration test: Docker or runner image not available");
      return;
    }

    const repo = makeRepo();
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const dockerBackend = makeDockerBackend();

    const prdPath = join(repoRoot, "fixtures", "prd-expected-exit-codes.md");
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
    // The full production path must terminalize successfully: the verification
    // provider classifies exit 1 as "pass" (1 is in expected_exit_codes [1]),
    // the gate result is "passed", the oracle accepts, and the runner
    // terminalizes through the purpose-specific finalization.
    expect(result.outcome.status).toBe("succeeded");
    expect(result.outcome.stableCode).toBe("RICKGENT_OK");
    expect(result.ticketsDone).toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// (b) Excluded-exit fail-closed: expected_exit_codes [1], command exits 2.
//     The full production path must NOT terminalize successfully.
// ---------------------------------------------------------------------------

describe("(b) production-entrypoint excluded-exit fails closed", () => {
  it("runBuildViaRunnerForTesting with expected_exit_codes [1] and exit 2 asserts outcome.status !== 'succeeded'", async () => {
    if (!dockerAvailable()) {
      console.log("Skipping Docker integration test: Docker or runner image not available");
      return;
    }

    const repo = makeRepo();
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const dockerBackend = makeDockerBackend();

    const prdPath = join(repoRoot, "fixtures", "prd-expected-exit-codes-excluded.md");
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

    // The verification provider classifies exit 2 as "fail" (2 is NOT in
    // expected_exit_codes [1]), the gate result is "failed", the oracle
    // rejects, and the runner branches to the ordinary-failure state machine
    // instead of terminalizing.  The build outcome must NOT be "succeeded".
    if (result.outcome.status === "succeeded") {
      console.log("UNEXPECTED SUCCESS — Build report:", JSON.stringify(result.report, null, 2));
      console.log("UNEXPECTED SUCCESS — Build outcome:", JSON.stringify(result.outcome, null, 2));
    }
    expect(result.outcome.status).not.toBe("succeeded");
  }, 180_000);
});
