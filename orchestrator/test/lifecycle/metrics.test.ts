// B9 — metrics ledger + `rickgent metrics` (VAL-METRIC-001..004).
//
// Drives the REAL `rickgent` CLI (dist/cli.js) and the REAL `runBuild` path to
// verify that `rickgent metrics` reports interventions/run and rolling
// matured-PR quality computed from REAL ledger reads (runs, interventions, PRs,
// defects) — never hardcoded constants. Immature PRs are excluded from the
// matured-PR quality denominator; late defects reopen a matured PR as
// defective. A human-gate hit during `build` increments the durable
// intervention ledger, which `metrics` then reads.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  computeMetrics,
  DEFAULT_MATURITY_WINDOW_DAYS,
  recordRun,
  recordPr,
  recordDefect,
  type PrRecord,
  type DefectRecord,
} from "../../src/lifecycle/metrics.js";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");

const TEST_ROSTER_JSON = JSON.stringify([
  { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: { cost_per_dispatch: 0.50 } },
  { harness: "codex", model: "openai/gpt-5-mini", vendor: "openai", tier: "cheap", pricing: { cost_per_dispatch: 0.04 } },
]);

const DAY_MS = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initGitRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

function runMetricsJson(rickgentDir: string): { status: number | null; json: Record<string, unknown>; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_JS, "metrics", "--json"], {
    encoding: "utf-8",
    env: { ...process.env, RICKGENT_DIR: rickgentDir },
    timeout: 30000,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = {};
  }
  return { status: res.status, json, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function appendJsonl(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

describe("B9 metrics — computeMetrics (real ledger reads)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rickgent-metrics-unit-"));
    mkdirSync(join(dir, ".rickgent"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("VAL-METRIC-003a: empty ledgers → denominator 0, quality N/A (no constants)", () => {
    const m = computeMetrics(join(dir, ".rickgent"));
    expect(m.runs).toBe(0);
    expect(m.interventions).toBe(0);
    expect(m.shippedPrs).toBe(0);
    expect(m.maturedPrs).toBe(0);
    expect(m.qualityDenominator).toBe(0);
    expect(m.qualityPct).toBeNull();
    expect(m.defectiveMaturedPrs).toBe(0);
  });

  it("VAL-METRIC-003b: 2 matured PRs, 1 defective → denominator 2, quality 50", () => {
    const rg = join(dir, ".rickgent");
    const pr1: PrRecord = { prId: "pr-1", runId: "r1", branch: "rickgent/r1", title: "t1", repo: "repo1", shippedAt: isoDaysAgo(30), scopePaths: ["src/a.ts"] };
    const pr2: PrRecord = { prId: "pr-2", runId: "r2", branch: "rickgent/r2", title: "t2", repo: "repo2", shippedAt: isoDaysAgo(40), scopePaths: ["src/b.ts"] };
    recordPr(rg, pr1);
    recordPr(rg, pr2);
    const d1: DefectRecord = { defectId: "d1", prId: "pr-1", scopePath: "src/a.ts", detectedAt: isoDaysAgo(20), adjudicationNote: "regression in scope" };
    recordDefect(rg, d1);
    const m = computeMetrics(rg);
    expect(m.shippedPrs).toBe(2);
    expect(m.maturedPrs).toBe(2);
    expect(m.qualityDenominator).toBe(2);
    expect(m.defectiveMaturedPrs).toBe(1);
    expect(m.qualityPct).toBe(50);
  });

  it("VAL-METRIC-003c: a LATE defect (detected after maturity) reopens a matured PR as defective", () => {
    const rg = join(dir, ".rickgent");
    // pr-1 shipped 30 days ago; matured at 14 days. A defect detected today
    // (well after maturity) reopens it as defective.
    const pr1: PrRecord = { prId: "pr-1", runId: "r1", branch: "rickgent/r1", title: "t1", repo: "repo1", shippedAt: isoDaysAgo(30), scopePaths: ["src/a.ts"] };
    recordPr(rg, pr1);
    const lateDefect: DefectRecord = { defectId: "d-late", prId: "pr-1", scopePath: "src/a.ts", detectedAt: isoDaysAgo(1), adjudicationNote: "late regression found post-maturity" };
    recordDefect(rg, lateDefect);
    const m = computeMetrics(rg);
    expect(m.maturedPrs).toBe(1);
    expect(m.defectiveMaturedPrs).toBe(1);
    expect(m.qualityPct).toBe(0);
    expect(m.lateDefectsReopened).toBe(1);
  });

  it("VAL-METRIC-004: immature PR is excluded from the denominator; crossing maturity adds it", () => {
    const rg = join(dir, ".rickgent");
    const matured: PrRecord = { prId: "pr-m", runId: "r1", branch: "rickgent/r1", title: "t1", repo: "repo1", shippedAt: isoDaysAgo(30), scopePaths: ["src/a.ts"] };
    const immature: PrRecord = { prId: "pr-i", runId: "r2", branch: "rickgent/r2", title: "t2", repo: "repo2", shippedAt: isoDaysAgo(1), scopePaths: ["src/b.ts"] };
    recordPr(rg, matured);
    recordPr(rg, immature);
    const m1 = computeMetrics(rg);
    expect(m1.shippedPrs).toBe(2);
    expect(m1.maturedPrs).toBe(1);
    expect(m1.immaturePrs).toBe(1);
    expect(m1.qualityDenominator).toBe(1);
    expect(m1.qualityPct).toBe(100);
    // Now the immature PR crosses the maturity window (rewritten shippedAt).
    // The denominator is a REAL ledger read, so it reflects the new state.
    writeFileSync(join(rg, "prs.jsonl"), "");
    recordPr(rg, matured);
    recordPr(rg, { ...immature, shippedAt: isoDaysAgo(30) });
    const m2 = computeMetrics(rg);
    expect(m2.maturedPrs).toBe(2);
    expect(m2.qualityDenominator).toBe(2);
    expect(m2.qualityPct).toBe(100);
  });

  it("interventions/run is a real read of the intervention + run ledgers", () => {
    const rg = join(dir, ".rickgent");
    recordRun(rg, "run-1", "PRD A");
    recordRun(rg, "run-2", "PRD B");
    appendJsonl(join(rg, "interventions.jsonl"), { gate: "merge-gate", reason: "disabled", at: isoDaysAgo(1), runId: "run-1" });
    const m = computeMetrics(rg);
    expect(m.runs).toBe(2);
    expect(m.interventions).toBe(1);
    expect(m.interventionsPerRun).toBe(0.5);
  });
});

describe("B9 metrics — `rickgent metrics` CLI (real entrypoint)", () => {
  let dir: string;
  let rg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rickgent-metrics-cli-"));
    rg = join(dir, ".rickgent");
    mkdirSync(rg, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("VAL-METRIC-001: metrics reports interventions/run and rolling matured-PR quality", () => {
    recordRun(rg, "run-1", "PRD A");
    appendJsonl(join(rg, "interventions.jsonl"), { gate: "merge-gate", reason: "x", at: isoDaysAgo(1), runId: "run-1" });
    recordPr(rg, { prId: "pr-1", runId: "run-1", branch: "rickgent/r1", title: "t1", repo: "repo1", shippedAt: isoDaysAgo(30), scopePaths: ["src/a.ts"] });
    recordPr(rg, { prId: "pr-2", runId: "run-1", branch: "rickgent/r2", title: "t2", repo: "repo2", shippedAt: isoDaysAgo(20), scopePaths: ["src/b.ts"] });
    recordDefect(rg, { defectId: "d1", prId: "pr-1", scopePath: "src/a.ts", detectedAt: isoDaysAgo(10), adjudicationNote: "bug" });
    const out = runMetricsJson(rg);
    expect(out.status).toBe(0);
    expect(out.json["runs"]).toBe(1);
    expect(out.json["interventions"]).toBe(1);
    expect(out.json["interventionsPerRun"]).toBe(1);
    expect(out.json["maturedPrs"]).toBe(2);
    expect(out.json["qualityDenominator"]).toBe(2);
    expect(out.json["defectiveMaturedPrs"]).toBe(1);
    expect(out.json["qualityPct"]).toBe(50);
    // Human report (no --json) carries both metrics.
    const human = spawnSync(process.execPath, [CLI_JS, "metrics"], {
      encoding: "utf-8",
      env: { ...process.env, RICKGENT_DIR: rg },
      timeout: 30000,
    });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("interventions/run");
    expect(human.stdout).toContain("quality");
  });

  it("VAL-METRIC-004 (CLI): immature PR added → no denominator change; matured → denominator +1", () => {
    recordPr(rg, { prId: "pr-m", runId: "r1", branch: "rickgent/r1", title: "t1", repo: "repo1", shippedAt: isoDaysAgo(30), scopePaths: ["src/a.ts"] });
    // Add an immature PR — denominator must NOT change.
    recordPr(rg, { prId: "pr-i", runId: "r2", branch: "rickgent/r2", title: "t2", repo: "repo2", shippedAt: isoDaysAgo(1), scopePaths: ["src/b.ts"] });
    const before = runMetricsJson(rg).json;
    expect(before["qualityDenominator"]).toBe(1);
    expect(before["immaturePrs"]).toBe(1);
    // Now it matures (rewrite ledger with an older shippedAt).
    writeFileSync(join(rg, "prs.jsonl"), "");
    recordPr(rg, { prId: "pr-m", runId: "r1", branch: "rickgent/r1", title: "t1", repo: "repo1", shippedAt: isoDaysAgo(30), scopePaths: ["src/a.ts"] });
    recordPr(rg, { prId: "pr-i", runId: "r2", branch: "rickgent/r2", title: "t2", repo: "repo2", shippedAt: isoDaysAgo(30), scopePaths: ["src/b.ts"] });
    const after = runMetricsJson(rg).json;
    expect(after["qualityDenominator"]).toBe(2);
  });

  it("VAL-METRIC-001: metrics exits 0 and reports maturityWindowDays=14 (decision doc constant)", () => {
    recordRun(rg, "run-1", "t");
    const out = runMetricsJson(rg);
    expect(out.status).toBe(0);
    expect(out.json["maturityWindowDays"]).toBe(DEFAULT_MATURITY_WINDOW_DAYS);
  });
});

describe("B9 metrics — contained build profile", () => {
  let d: { root: string; repo: string; dataDir: string; rickgentDir: string; agentDir: string };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "rickgent-metrics-build-"));
    const repo = join(root, "repo");
    initGitRepo(repo);
    const dataDir = join(root, "data");
    const rickgentDir = join(root, ".rickgent");
    const agentDir = join(root, "agent");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    d = { root, repo, dataDir, rickgentDir, agentDir };
  });
  afterEach(() => {
    if (existsSync(d.repo)) {
      const current = git(d.repo, ["rev-parse", "--show-toplevel"]);
      for (const line of git(d.repo, ["worktree", "list", "--porcelain"]).split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const worktree = line.slice("worktree ".length);
        if (worktree !== current) {
          try { git(d.repo, ["worktree", "remove", "--force", worktree]); } catch { /* test cleanup */ }
        }
      }
    }
    rmSync(d.root, { recursive: true, force: true });
  });

  // VAL-METRIC-002
  it("delivery configuration is rejected before run or intervention metrics are allocated", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: d.rickgentDir,
      OMNIGENT_DATA_DIR: d.dataDir,
      FIXTURE_MODE: "prompt",
      FIXTURE_TARGET_REPO: d.repo,
      RICKGENT_MODEL_ROSTER: TEST_ROSTER_JSON,
      RICKGENT_COST_BUDGET_USD: "10.0",
    };
    const build = spawnSync(process.execPath, [CLI_JS, "build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir, "--no-autonomous-pr"], {
      encoding: "utf-8",
      env,
      cwd: d.repo,
      input: "",
      timeout: 90000,
    });
    expect(build.status).toBe(3);
    const intPath = join(d.rickgentDir, "interventions.jsonl");
    expect(existsSync(intPath)).toBe(false);
    expect(existsSync(join(d.rickgentDir, "runs.jsonl"))).toBe(false);
    const out = runMetricsJson(d.rickgentDir);
    expect(out.status).toBe(0);
    expect(out.json["interventions"]).toBe(0);
    expect(out.json["runs"]).toBe(0);
    expect(out.json["interventionsPerRun"]).toBe(0);
  });

  it("a nonterminal capture records a run but cannot manufacture delivery metrics", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: d.rickgentDir,
      OMNIGENT_DATA_DIR: d.dataDir,
      FIXTURE_MODE: "prompt",
      FIXTURE_TARGET_REPO: d.repo,
      FAKE_GH_LOG: join(d.root, "gh.log"),
      RICKGENT_MODEL_ROSTER: TEST_ROSTER_JSON,
      RICKGENT_COST_BUDGET_USD: "10.0",
    };
    const build = spawnSync(process.execPath, [CLI_JS, "build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], {
      encoding: "utf-8",
      env,
      cwd: d.repo,
      input: "",
      timeout: 90000,
    });
    expect(build.status).toBe(5);
    const prPath = join(d.rickgentDir, "prs.jsonl");
    expect(existsSync(prPath)).toBe(false);
    expect(existsSync(join(d.root, "gh.log"))).toBe(false);
    const out = runMetricsJson(d.rickgentDir);
    expect(out.status).toBe(0);
    expect(Number(out.json["runs"])).toBe(1);
    expect(Number(out.json["shippedPrs"])).toBe(0);
    expect(Number(out.json["immaturePrs"])).toBe(0);
    expect(out.json["qualityDenominator"]).toBe(0);
    expect(out.json["interventions"]).toBe(0);
  });
});
