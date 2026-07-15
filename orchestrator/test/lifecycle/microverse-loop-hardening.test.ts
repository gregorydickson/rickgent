// Hardening fixes for the real MicroverseLoop (from M4 scrutiny non-blocking).
//
// Fix #1: buildReportFromGitLog uses isPathInScope (single-matcher invariant).
// Fix #2: baselineScore/acceptedScores only advance when commitInScope succeeds.
// Fix #3: salvageInScope produces archived-todo (not committed-done) for attrition/deadline.
// Fix #6: dirtyOwnedPaths correctly handles renamed files in -z format.
//
// Each test drives the REAL MicroverseLoop against a real fixture git repo
// (no mocks) and observes a REAL effect: git tree state, git log, salvage
// disposition, and report contents.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MicroverseLoop as ProductionMicroverseLoop,
  type MicroverseLoopOptions,
} from "../../src/lifecycle/microverse.js";
import { FIXTURE_CAPABILITY_GATE } from "../helpers/capabilities.js";

class MicroverseLoop extends ProductionMicroverseLoop {
  constructor(options: MicroverseLoopOptions) {
    super({ ...options, capabilityGate: FIXTURE_CAPABILITY_GATE });
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(repo: string, seedLines: number): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  writeFileSync(
    join(repo, "src", "metric.txt"),
    Array.from({ length: seedLines }, (_, i) => `line${i}`).join("\n") + "\n",
  );
  git(repo, ["add", "--", "README.md", "src/metric.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

const LINE_METRIC = "wc -l < src/metric.txt | tr -d ' '";

function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("Hardening #1 — buildReportFromGitLog uses isPathInScope (single matcher)", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "microverse-h1-"));
    repo = join(root, "repo");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Static: the loop source must import isPathInScope and must NOT contain the
  // inline startsWith-based scope matcher in buildReportFromGitLog.
  it("microverse.ts imports isPathInScope from core/scope (no parallel matcher)", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/microverse.ts"),
      "utf-8",
    );
    expect(src).toMatch(/isPathInScope/);
    expect(src).toMatch(/from\s+["']\.\.\/core\/scope\.js["']/);
    // The inline matcher pattern (startsWith with endsWith ternary) is gone.
    expect(src).not.toMatch(/endsWith\(["']\/["']\)\s*\?\s*d\s*:\s*d\s*\+\s*["']\/["']/);
  });

  // Behavioral: a sibling directory (src-old) sharing a name prefix with the
  // owned scope (src) is excluded from the report's in-scope commit files.
  it("report excludes a prefix-sibling directory (src-old vs src)", async () => {
    initRepo(repo, 2);
    const initial = head(repo);

    // Create a sibling directory src-old OUTSIDE the owned scope.
    mkdirSync(join(repo, "src-old"), { recursive: true });
    writeFileSync(join(repo, "src-old", "noise.txt"), "noise\n");
    git(repo, ["add", "--", "src-old/noise.txt"]);
    git(repo, ["commit", "-q", "-m", "out-of-scope sibling commit"]);

    // Now run a loop that improves the in-scope file.
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      workerArgv: () => ["sh", "-c", "echo newline >> src/metric.txt"],
      maxIterations: 1,
      iterationDeadlineMs: 5000,
    });
    const result = await loop.run();

    // The report should only contain the in-scope improvement commit, NOT the
    // sibling commit that touched src-old/noise.txt.
    for (const c of result.report.commits) {
      for (const f of c.files) {
        expect(f).not.toMatch(/^src-old\//);
      }
    }
    // The in-scope improvement commit IS present.
    expect(result.report.improvementCommits).toBeGreaterThanOrEqual(1);
  });
});

describe("Hardening #2 — baselineScore only advances when commitInScope succeeds", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "microverse-h2-"));
    repo = join(root, "repo");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // When the metric "improves" but no in-scope git delta exists to commit,
  // commitInScope returns null. The baseline score must NOT advance because
  // there is no git-tree-truth backing the claimed improvement.
  it("metric improves but no in-scope delta → baseline score does NOT advance", async () => {
    initRepo(repo, 2);
    const initial = head(repo);

    // Metric reads from an out-of-scope file; worker writes to that file.
    // The metric "improves" but there is no in-scope (src/) change to commit.
    writeFileSync(join(repo, "outside.txt"), "1\n");
    git(repo, ["add", "--", "outside.txt"]);
    git(repo, ["commit", "-q", "-m", "add outside metric source"]);

    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: "wc -l < outside.txt | tr -d ' '",
      // Worker appends to the OUT-of-scope file → metric improves but src/ is clean.
      workerArgv: () => ["sh", "-c", "echo extra >> outside.txt"],
      maxIterations: 1,
      iterationDeadlineMs: 5000,
    });
    const result = await loop.run();

    // commitInScope returned null (nothing under src/ to stage).
    // The baseline score must NOT have advanced to the new metric value.
    const initialScore = 1; // outside.txt had 1 line at baseline
    expect(result.finalScore).toBe(initialScore);
    // No improvement commit landed.
    expect(result.report.improvementCommits).toBe(0);
    // HEAD unchanged — no in-scope commit.
    expect(head(repo)).toBe(result.baselineSha);
    // The iteration must not be recorded as a successful improvement with a commit.
    const improved = result.iterations.filter((i) => i.classification === "improved" && i.committedSha !== null);
    expect(improved.length).toBe(0);
  });
});

describe("Hardening #3 — salvageInScope: archived-todo for attrition/deadline", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "microverse-h3-"));
    repo = join(root, "repo");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Attrition salvage with dirty in-scope work must produce archived-todo
  // (gatePassed:false → archive and reset to Todo), NOT committed-done
  // (gatePassed:true → commit as "done"). The work is incomplete.
  it("attrition salvage produces archived-todo, not committed-done", async () => {
    initRepo(repo, 2);

    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      // Constant metric → every iteration is a no-improvement stall.
      metricCommand: "echo 50",
      // Worker writes dirty in-scope work each iteration.
      workerArgv: () => ["sh", "-c", "printf 'wip\\n' > src/wip.txt"],
      maxIterations: 10,
      iterationDeadlineMs: 5000,
      convergence: { stallLimit: 2 },
    });
    const result = await loop.run();

    expect(result.status).toBe("attrition");
    expect(result.salvage).toBeTruthy();
    // The disposition MUST be archived-todo (work is incomplete), not committed-done.
    expect(result.salvage!.decision.disposition).toBe("archived-todo");
    expect(result.salvage!.decision.disposition).not.toBe("committed-done");
  });

  // Deadline breach salvage with dirty in-scope work also produces archived-todo.
  it("deadline salvage produces archived-todo, not committed-done", async () => {
    initRepo(repo, 2);

    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: LINE_METRIC,
      // Worker writes in-scope work then hangs past the deadline.
      workerArgv: () => ["sh", "-c", "printf 'wip\\n' > src/wip.txt; sleep 30"],
      maxIterations: 1,
      iterationDeadlineMs: 400,
    });
    const result = await loop.run();

    expect(result.status).toBe("deadline-salvaged");
    expect(result.salvage).toBeTruthy();
    expect(result.salvage!.decision.disposition).toBe("archived-todo");
    expect(result.salvage!.decision.disposition).not.toBe("committed-done");
  });
});

describe("Hardening #6 — dirtyOwnedPaths handles renamed files in -z format", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "microverse-h6-"));
    repo = join(root, "repo");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // git status --porcelain -z emits TWO NUL-separated fields for a rename:
  //   "R  newpath\0oldpath\0"
  // The old slice(3) approach mangles the second field (oldpath) into a
  // bogus path. The fix must skip the old-path field for R/C entries.
  it("a staged rename does not produce a mangled old-path entry", async () => {
    // Seed repo with a file that will be renamed.
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@rickgent.test"]);
    git(repo, ["config", "user.name", "Rickgent Test"]);
    writeFileSync(join(repo, "src", "old.txt"), "content\n");
    git(repo, ["add", "--", "src/old.txt"]);
    git(repo, ["commit", "-q", "-m", "initial"]);

    // Stage a rename within the owned scope.
    git(repo, ["mv", "src/old.txt", "src/new.txt"]);

    // Run a loop that immediately hits attrition (constant metric) so
    // salvageInScope calls dirtyOwnedPaths on the renamed state.
    const loop = new MicroverseLoop({
      workingDir: repo,
      ownedPaths: ["src"],
      metricCommand: "echo 50",
      // Worker does nothing — the staged rename is the dirty state.
      workerArgv: () => ["sh", "-c", "true"],
      maxIterations: 10,
      iterationDeadlineMs: 5000,
      convergence: { stallLimit: 2 },
    });
    const result = await loop.run();

    expect(result.salvage).toBeTruthy();
    const staged = result.salvage!.decision.stagedPaths ?? [];
    // The new path must be present.
    expect(staged).toContain("src/new.txt");
    // No mangled old-path entry (the bug produced "/old.txt" from slice(3)
    // on the un-prefixed second -z field).
    for (const p of staged) {
      expect(p).not.toMatch(/^\//); // no root-relative mangled path
      expect(p).not.toBe("/old.txt");
      expect(p).not.toBe("old.txt"); // the raw old path without scope prefix
    }
    // The mangled entry from the buggy code would have been "/old.txt"
    // (from "src/old.txt".slice(3) === "/old.txt").
    expect(staged).not.toContain("/old.txt");
  });
});
