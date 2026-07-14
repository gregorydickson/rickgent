// B5 — real microverse convergence loop (VAL-MICRO-001..003, 006, 007, 009, 010).
//
// Drives the REAL MicroverseLoop against a real fixture git repo, a real metric
// command, and real worker processes (no mocks). Every assertion observes a REAL
// effect: git tree state, git log, salvage commit contents, process liveness,
// and the circuit-breaker state after the run.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MicroverseLoop } from "../../src/lifecycle/microverse.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(repo: string, seedLines: number): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  writeFileSync(join(repo, "src", "metric.txt"), Array.from({ length: seedLines }, (_, i) => `line${i}`).join("\n") + "\n");
  git(repo, ["add", "--", "README.md", "src/metric.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

// Metric: number of lines in the in-scope tracked file (higher is better).
const LINE_METRIC = "wc -l < src/metric.txt | tr -d ' '";

function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe("B5 real microverse loop", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "microverse-loop-"));
    repo = join(root, "repo");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // VAL-MICRO-009
  it("an improving iteration commits its in-scope work and advances the baseline ref", async () => {
    initRepo(repo, 2);
    const initial = head(repo);
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      // Each iteration appends a line to the in-scope metric file (improves).
      workerArgv: () => ["sh", "-c", "echo newline >> src/metric.txt"],
      maxIterations: 2,
      iterationDeadlineMs: 5000,
      convergence: { epsilon: 1.0, window: 3, target: null },
    });
    const result = await loop.run();

    const improved = result.iterations.filter((i) => i.classification === "improved");
    expect(improved.length).toBe(2);
    for (const it of improved) expect(typeof it.committedSha).toBe("string");
    // Baseline ref advanced away from the initial commit.
    expect(result.baselineSha).not.toBe(initial);
    expect(head(repo)).toBe(result.baselineSha);
    // Both commits touched the in-scope file, derived from git log.
    expect(result.report.improvementCommits).toBe(2);
    // Iteration 2 measured a higher score than iteration 1 (new baseline in effect).
    expect(result.iterations[1]!.score!).toBeGreaterThan(result.iterations[0]!.score!);
  });

  // VAL-MICRO-001 + VAL-MICRO-010
  it("a regressing iteration scoped-rolls-back and preserves baseline + out-of-scope work", async () => {
    initRepo(repo, 3);
    const baselineBefore = head(repo);
    // An out-of-scope, untracked file that MUST survive the scoped rollback.
    writeFileSync(join(repo, "outside.txt"), "precious out-of-scope work\n");

    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      // Worker worsens the metric (truncate to 1 line) AND drops an untracked
      // in-scope file; both are the iteration's in-scope changes to roll back.
      workerArgv: () => ["sh", "-c", "printf 'only\\n' > src/metric.txt; echo junk > src/junk.txt"],
      maxIterations: 1,
      iterationDeadlineMs: 5000,
    });
    const result = await loop.run();

    expect(result.iterations[0]!.classification).toBe("regressed");
    expect(result.iterations[0]!.rolledBack).toBe(true);
    // Baseline commit unchanged.
    expect(head(repo)).toBe(baselineBefore);
    expect(result.baselineSha).toBe(baselineBefore);
    // In-scope tracked file restored to baseline (3 lines), untracked in-scope junk removed.
    expect(git(repo, ["status", "--porcelain", "--", "src"])).toBe("");
    expect(existsSync(join(repo, "src", "junk.txt"))).toBe(false);
    expect(readFileSync(join(repo, "src", "metric.txt"), "utf-8").trim().split("\n").length).toBe(3);
    // Out-of-scope untracked work preserved.
    expect(existsSync(join(repo, "outside.txt"))).toBe(true);
  });

  // VAL-MICRO-010 (static): no global reset/checkout in the loop source.
  it("loop source contains no global reset/checkout (scoped rollback only)", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/lifecycle/microverse.ts"), "utf-8");
    expect(src).not.toMatch(/reset\s+--hard/);
    expect(src).not.toMatch(/checkout\s+--\s+\./);
    expect(src).not.toMatch(/git add -A|["']-A["']/);
  });

  // VAL-MICRO-002
  it("deadline breach kills the worker and salvage-commits only in-scope dirty work", async () => {
    initRepo(repo, 2);
    const before = head(repo);
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      // Worker writes an in-scope dirty file + an out-of-scope file, then hangs.
      workerArgv: () => [
        "sh",
        "-c",
        "printf 'wip\\n' > src/wip.txt; printf 'off\\n' > outside2.txt; sleep 30",
      ],
      maxIterations: 1,
      iterationDeadlineMs: 400,
    });
    const result = await loop.run();

    expect(result.status).toBe("deadline-salvaged");
    // Worker process group is dead after the deadline.
    expect(result.lastWorkerPid).toBeTypeOf("number");
    expect(await waitDead(result.lastWorkerPid!)).toBe(true);
    // A salvage commit landed (HEAD advanced) containing ONLY the in-scope path.
    expect(head(repo)).not.toBe(before);
    const stat = git(repo, ["show", "--stat", "--name-only", "--pretty=format:", "HEAD"]);
    expect(stat).toContain("src/wip.txt");
    expect(stat).not.toContain("outside2.txt");
    // The out-of-scope file was neither committed nor discarded.
    expect(existsSync(join(repo, "outside2.txt"))).toBe(true);
  });

  // VAL-MICRO-003
  it("final report is derived from git log, not a worker success claim", async () => {
    initRepo(repo, 2);
    const before = head(repo);
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      // Worker prints a success token but makes NO git change.
      workerArgv: () => ["sh", "-c", "echo 'DONE: success!!'"],
      maxIterations: 1,
      iterationDeadlineMs: 5000,
    });
    const result = await loop.run();

    expect(result.iterations[0]!.workerStdout).toContain("DONE: success");
    // git-truth: no commit, no improvement, HEAD unchanged.
    expect(head(repo)).toBe(before);
    expect(result.report.improvementCommits).toBe(0);
    expect(result.report.netImproved).toBe(false);
    expect(result.converged).toBe(false);
  });

  // VAL-MICRO-006
  it("attrition/stall routes to salvage, not convergence", async () => {
    initRepo(repo, 2);
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      // Constant metric → every iteration is a no-improvement stall.
      metricCommand: "echo 50",
      workerArgv: () => ["sh", "-c", "printf 'wip\\n' > src/wip.txt"],
      maxIterations: 10,
      iterationDeadlineMs: 5000,
      convergence: { stallLimit: 2 },
    });
    const result = await loop.run();

    expect(result.converged).toBe(false);
    expect(result.status).toBe("attrition");
    expect(result.salvage).toBeTruthy();
    expect(typeof result.salvage!.decision.disposition).toBe("string");
  });

  // VAL-MICRO-007
  it("records each iteration into the breaker; a tripping sequence halts via canExecute", async () => {
    initRepo(repo, 5);
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      // Always regress (truncate) → same error signature, no tree change → trips.
      workerArgv: () => ["sh", "-c", "printf 'only\\n' > src/metric.txt"],
      maxIterations: 10,
      iterationDeadlineMs: 5000,
      breakerThreshold: 3,
    });
    const result = await loop.run();

    expect(result.status).toBe("breaker-tripped");
    expect(result.breaker.open).toBe(true);
    expect(result.breaker.iterationCount).toBeGreaterThanOrEqual(3);
    expect(Object.keys(result.breaker.errorCounts).length).toBeGreaterThan(0);
    // Halted before exhausting maxIterations.
    expect(result.iterations.length).toBeLessThan(10);
  });
});
