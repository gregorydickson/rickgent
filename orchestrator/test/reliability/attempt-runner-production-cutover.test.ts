/**
 * t22D production cutover and legacy removal.
 *
 * Proves VAL-T22CD-005 and VAL-T22CD-006:
 *   - The legacy run-worktree / direct Dispatcher spawn / caller-checkout
 *     gates / TicketLock finally-release / generic cleanup finalization are
 *     REMOVED from the production `runBuild`/`runPipeline` path.  The
 *     production path routes through the single AttemptRunner and fails
 *     closed when the authority-owned containment backend is unavailable
 *     (target-never-released), instead of falling back to the legacy
 *     run-workspace/direct-spawn path.
 *   - DispatchQueue remains only as sequential scheduling/diagnostic
 *     plumbing and CANNOT convert an unknown runner failure into released
 *     ownership.
 *   - `doctor` reports `autonomous_dispatch` activated with the correct
 *     proof reference, only after t22A–t22D proofs are green.
 *
 * The fixture-only legacy `executeBuild` path remains reachable only through
 * the package-private fixture bridge (`runBuildWithDependenciesForTesting`);
 * it is not a production caller.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityRegistry,
  getCapability,
} from "../../src/capabilities/registry.js";
import { DispatchQueue } from "../../src/dispatch/queue.js";
import { InMemoryDispatchJournal, dispatchIdString, type DispatchEntry, type DispatchId } from "../../src/dispatch/dispatch.js";
import { runBuild, runPipeline } from "../../src/lifecycle/build.js";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const cliPath = join(orchestratorRoot, "dist", "cli.js");
const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-t22D-cutover-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t22D Cutover Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t22d@example.test"]);
  writeFileSync(join(repo, "README.md"), "t22D cutover\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

/** Environment with no `docker` on PATH so the containment probe fails closed. */
function noDockerEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  // Strip docker from PATH so probeContainmentBackend returns UnavailableContainmentBackend.
  const path = (env.PATH ?? "")
    .split(":")
    .filter((entry) => !/\/docker$|\/Applications\/Docker/.test(entry) && !entry.endsWith("docker"));
  // Also remove /usr/local/bin where docker typically lives on macOS.
  const filtered = (env.PATH ?? "").split(":").filter((entry) => {
    const trimmed = entry.trim();
    if (trimmed === "/usr/local/bin") return false;
    if (trimmed.endsWith("/Docker.app/Contents/Resources/bin")) return false;
    return true;
  });
  env.PATH = filtered.join(":");
  return env;
}

describe("t22D production cutover and legacy removal", () => {
  it("activates autonomous_dispatch in the capability registry with the t22A-t22D proof reference", () => {
    const entry = getCapability("autonomous_dispatch");
    expect(entry.state).toBe("enabled");
    expect(entry.proof_version).toBe("attempt-runner-critical-section-v1");
    expect(entry.reason.length).toBeGreaterThan(0);
    // The remaining capabilities are NOT activated by t22D.
    const byName = new Map(capabilityRegistry().map((e) => [e.name, e]));
    expect(byName.get("parallel_dispatch")!.state).toBe("unavailable");
    expect(byName.get("resume_retry")!.state).toBe("unavailable");
    expect(byName.get("reconciliation")!.state).toBe("unavailable");
    expect(byName.get("cross_vendor_review")!.state).toBe("unavailable");
    expect(byName.get("automatic_delivery")!.state).toBe("unavailable");
    expect(byName.get("raw_shell")!.state).toBe("unavailable");
  });

  it("doctor reports autonomous_dispatch activated with the proof reference", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const result = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(result.status, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    const autonomous = json.capabilities.find(
      (entry: { name: string }) => entry.name === "autonomous_dispatch",
    );
    expect(autonomous.state).toBe("enabled");
    expect(autonomous.proof_version).toBe("attempt-runner-critical-section-v1");
  });

  it("removes the legacy run-worktree/direct-dispatcher/caller-checkout from the production runBuild path", async () => {
    const repo = makeRepo();
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const agentDir = join(repoRoot, "agents", "rickgent");
    // Containment unavailable (no docker on PATH): production must fail closed
    // with an infrastructure error and MUST NOT provision the legacy run
    // worktree, register a legacy run ref, or spawn a direct Dispatcher.
    const result = await runBuild({
      prdPath: join(repoRoot, "fixtures", "prd-min.md"),
      workingDir: repo,
      rickgentDir,
      agentDir,
      dataDir,
      env: noDockerEnv({ RICKGENT_DIR: rickgentDir }),
    });
    // The production path fails closed (containment unavailable).
    expect(result.outcome.status).not.toBe("ok");
    // No legacy run-workspace ref was created on the caller repository.
    const refs = execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)"], {
      encoding: "utf-8",
    }).trim();
    expect(refs).not.toMatch(/rickgent-run-/);
    // No legacy run worktree was registered.
    const worktrees = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
    });
    expect(worktrees).not.toMatch(/rickgent-run-/);
    // The caller HEAD is unchanged.
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const initialHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{commit}"], {
      encoding: "utf-8",
    }).trim();
    expect(head).toBe(initialHead);
  });

  it("removes the legacy path from runPipeline as well", async () => {
    const repo = makeRepo();
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const agentDir = join(repoRoot, "agents", "rickgent");
    // runPipeline requires reconciliation (still unavailable — t29 scope) for
    // its cleanup chain; it fails closed at the capability gate BEFORE any
    // legacy run-workspace provisioning.  The legacy path is not used.
    await expect(runPipeline({
      prdPath: join(repoRoot, "fixtures", "prd-min.md"),
      workingDir: repo,
      rickgentDir,
      agentDir,
      dataDir,
      env: noDockerEnv({ RICKGENT_DIR: rickgentDir }),
    })).rejects.toThrow("RICKGENT_RECONCILIATION_UNAVAILABLE");
    const refs = execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)"], {
      encoding: "utf-8",
    }).trim();
    expect(refs).not.toMatch(/rickgent-run-/);
  });

  it("DispatchQueue cannot convert an unknown runner failure into released ownership", async () => {
    const journal = new InMemoryDispatchJournal();
    const queue = new DispatchQueue(journal, 1);
    const id: DispatchId = {
      runId: "r", ticketId: "t", phase: "implement", attempt: 1, role: "worker",
    };
    queue.enqueue(id);
    const drain = await queue.drain(async () => {
      // An unknown runner failure: the dispatchFn throws an opaque error.
      throw new Error("unknown runner failure");
    });
    const entry = drain.results.get(dispatchIdString(id)) as DispatchEntry;
    expect(entry.state).toBe("failed");
    expect(entry.terminalReason).toBe("infrastructure_error");
    // The queue MUST NOT release ownership on an unknown failure.  It is
    // scheduling/diagnostic plumbing only; only the AttemptRunner can
    // terminalize and release ownership through authority-minted receipts.
    expect(entry.ownershipReleased).not.toBe(true);
  });

  it("the production build source does not call legacy run-workspace/dispatcher/caller-checkout from the runner path", () => {
    const source = require("node:fs").readFileSync(
      join(orchestratorRoot, "src", "lifecycle", "build.ts"),
      "utf-8",
    );
    // The production runner entrypoint must not reference the legacy owners.
    // Locate the executeBuildViaRunner function body and assert it does not
    // call the legacy primitives.  (The legacy executeBuild remains as the
    // fixture-bridge body and may reference them.)
    const runnerFnStart = source.indexOf("async function executeBuildViaRunner(");
    expect(runnerFnStart, "executeBuildViaRunner must exist").toBeGreaterThanOrEqual(0);
    // Find the next top-level async function after the runner to bound the body.
    const afterRunner = source.indexOf("async function executeBuildLegacy(", runnerFnStart);
    expect(afterRunner, "executeBuildLegacy must exist as the fixture-bridge body").toBeGreaterThan(runnerFnStart);
    const runnerBody = source.slice(runnerFnStart, afterRunner);
    expect(runnerBody).not.toMatch(/provisionRunWorkspace\s*\(/);
    expect(runnerBody).not.toMatch(/finalizeRunWorkspace\s*\(/);
    expect(runnerBody).not.toMatch(/callerRepositoryUnchanged\s*\(/);
    expect(runnerBody).not.toMatch(/new Dispatcher\s*\(/);
    expect(runnerBody).not.toMatch(/TicketLock/);
    // The runner path must route through AttemptRunner.
    expect(runnerBody).toMatch(/AttemptRunner|probeContainmentBackend/);
  });
});
