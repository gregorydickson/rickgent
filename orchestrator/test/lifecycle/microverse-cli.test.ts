// M0 — `rickgent microverse` CLI (VAL-M0-007..022).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync against real temp git
// repos with a controllable stub `omnigent` on PATH. Every assertion observes a
// REAL effect: exit code, stderr, git tree/log, the persisted
// .rickgent/microverse.json state, and the recorded omnigent-run spawn log.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");

interface Ctx {
  root: string;
  repo: string;
  agentDir: string;
  binDir: string;
  rickgentDir: string;
  spawnLog: string;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(repo: string, lines: number): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  writeFileSync(
    join(repo, "src", "metric.txt"),
    Array.from({ length: lines }, (_, i) => `line${i}`).join("\n") + "\n",
  );
  git(repo, ["add", "--", "README.md", "src/metric.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

// A controllable stub `omnigent`. It records every invocation's argv to
// $MV_SPAWN_LOG. A judge invocation (read-only judge prompt) prints
// $MV_JUDGE_SCORE. A worker invocation runs $MV_WORK_CMD (in the repo cwd) and,
// if $MV_WORKER_SLEEP is set, sleeps first (to exercise deadline enforcement).
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const argv = process.argv.slice(2);
if (process.env.MV_SPAWN_LOG) fs.appendFileSync(process.env.MV_SPAWN_LOG, JSON.stringify(argv) + "\\n");
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? String(argv[pIdx + 1] || "") : "";
if (/read-only evaluation judge/.test(prompt)) {
  process.stdout.write((process.env.MV_JUDGE_SCORE || "0") + "\\n");
  process.exit(0);
}
if (process.env.MV_WORKER_SLEEP) {
  try { execFileSync("sh", ["-c", "sleep " + process.env.MV_WORKER_SLEEP]); } catch (_) {}
}
if (process.env.MV_WORK_CMD) {
  try { execFileSync("sh", ["-c", process.env.MV_WORK_CMD], { cwd: process.cwd() }); } catch (_) {}
}
process.stdout.write("worker done\\n");
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "mv-cli-"));
  const repo = join(root, "repo");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const rickgentDir = join(root, "rickgent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, "omnigent");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);
  return { root, repo, agentDir, binDir, rickgentDir, spawnLog: join(root, "spawns.log") };
}

function run(
  ctx: Ctx,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_JS, "microverse", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      MV_SPAWN_LOG: ctx.spawnLog,
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readState(ctx: Ctx): any {
  return JSON.parse(readFileSync(join(ctx.rickgentDir, "microverse.json"), "utf-8"));
}

function spawnEntries(ctx: Ctx): string[][] {
  if (!existsSync(ctx.spawnLog)) return [];
  return readFileSync(ctx.spawnLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("rickgent microverse CLI (M0)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  // VAL-M0-007
  it("--help exits 0 and lists all 15 documented flags", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    for (const flag of [
      "--metric",
      "--goal",
      "--task",
      "--direction",
      "--max-iterations",
      "--stall-limit",
      "--epsilon",
      "--window",
      "--target",
      "--repo",
      "--agent",
      "--owned-paths",
      "--iteration-deadline-ms",
      "--non-interactive",
      "--resume",
    ]) {
      expect(r.stdout).toContain(flag);
    }
  });

  // VAL-M0-008
  it("fails without --task", () => {
    const r = run(ctx, ["--metric", "echo 1", "--agent", ctx.agentDir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--task");
  });

  // VAL-M0-009 (neither)
  it("fails when neither --metric nor --goal is given", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, ["--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/one of --metric.*--goal|--metric.*--goal.*required/i);
  });

  // VAL-M0-009 (both)
  it("fails when both --metric and --goal are given", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "echo 1",
      "--goal",
      "g",
      "--task",
      "t",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/mutually exclusive/i);
  });

  // VAL-M0-010 + VAL-M0-021
  it("--metric parses the last numeric line as the baseline and writes state fields", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      'printf "ignored\\n42\\n"',
      "--task",
      "t",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--max-iterations",
      "1",
    ]);
    expect(r.status).toBe(0);
    const state = readState(ctx);
    expect(state.baseline_score).toBe(42);
    expect(Array.isArray(state.convergence.history)).toBe(true);
    expect(Array.isArray(state.failed_approaches)).toBe(true);
    expect(typeof state.baseline_score).toBe("number");
  });

  // VAL-M0-011 + VAL-M0-012 (goal judge + worker via omnigent run array argv)
  it("--goal spawns an omnigent-run judge whose prompt carries the goal and a scoring instruction", () => {
    initRepo(ctx.repo, 3);
    const r = run(
      ctx,
      [
        "--goal",
        "reduce latency",
        "--task",
        "make it faster",
        "--agent",
        ctx.agentDir,
        "--repo",
        ctx.repo,
        "--owned-paths",
        "src",
        "--max-iterations",
        "1",
      ],
      { MV_JUDGE_SCORE: "42" },
    );
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    expect(entries.length).toBeGreaterThan(0);
    // Every spawn is `omnigent run <agentDir> -p <prompt>` with array argv.
    for (const e of entries) {
      expect(e[0]).toBe("run");
      expect(e[1]).toBe(ctx.agentDir);
      expect(e[2]).toBe("-p");
    }
    // At least one judge spawn carries the goal text and a scoring instruction.
    const judge = entries.find((e) => /read-only evaluation judge/.test(e[3] ?? ""));
    expect(judge).toBeTruthy();
    expect(judge![3]).toContain("reduce latency");
    expect(judge![3]).toMatch(/score/i);
  });

  // VAL-M0-012 (static): no exec()/execSync() spawn sites in the CLI module.
  it("microverse-cli.ts contains no shell-string spawn sites", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/microverse-cli.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/[^A-Za-z]exec\(/);
    expect(src).not.toMatch(/execSync\(/);
    expect(src).not.toMatch(/add -A/);
  });

  // VAL-M0-013 (lower accepts a decreasing metric)
  it("--direction lower ACCEPTS an iteration that decreases the metric", () => {
    initRepo(ctx.repo, 10);
    const before = git(ctx.repo, ["rev-parse", "HEAD"]);
    const r = run(
      ctx,
      [
        "--metric",
        "wc -l < src/metric.txt | tr -d ' '",
        "--task",
        "shrink",
        "--agent",
        ctx.agentDir,
        "--repo",
        ctx.repo,
        "--owned-paths",
        "src",
        "--direction",
        "lower",
        "--max-iterations",
        "1",
      ],
      { MV_WORK_CMD: "printf 'a\\nb\\n' > src/metric.txt" },
    );
    expect(r.status).toBe(0);
    const state = readState(ctx);
    expect(state.convergence.history[0].classification).toBe("improved");
    expect(state.convergence.history[0].committedSha).toBeTruthy();
    expect(git(ctx.repo, ["rev-parse", "HEAD"])).not.toBe(before);
  });

  // VAL-M0-013 (higher reverts the same decreasing trajectory)
  it("--direction higher REVERTS an iteration that decreases the metric", () => {
    initRepo(ctx.repo, 10);
    const before = git(ctx.repo, ["rev-parse", "HEAD"]);
    const r = run(
      ctx,
      [
        "--metric",
        "wc -l < src/metric.txt | tr -d ' '",
        "--task",
        "shrink",
        "--agent",
        ctx.agentDir,
        "--repo",
        ctx.repo,
        "--owned-paths",
        "src",
        "--direction",
        "higher",
        "--max-iterations",
        "1",
      ],
      { MV_WORK_CMD: "printf 'a\\nb\\n' > src/metric.txt" },
    );
    expect(r.status).toBe(0);
    const state = readState(ctx);
    expect(state.convergence.history[0].classification).toBe("regressed");
    expect(git(ctx.repo, ["rev-parse", "HEAD"])).toBe(before);
    // File restored to its 10-line baseline.
    expect(readFileSync(join(ctx.repo, "src", "metric.txt"), "utf-8").trim().split("\n").length).toBe(10);
  });

  // VAL-M0-014 (accept commits only owned paths; out-of-scope work preserved)
  it("an accepted iteration commits only owned paths and leaves out-of-scope work untouched", () => {
    initRepo(ctx.repo, 3);
    const r = run(
      ctx,
      [
        "--metric",
        "wc -l < src/metric.txt | tr -d ' '",
        "--task",
        "grow",
        "--agent",
        ctx.agentDir,
        "--repo",
        ctx.repo,
        "--owned-paths",
        "src",
        "--direction",
        "higher",
        "--max-iterations",
        "1",
      ],
      { MV_WORK_CMD: "echo more >> src/metric.txt; echo dirty > outside.txt" },
    );
    expect(r.status).toBe(0);
    const head = git(ctx.repo, ["rev-parse", "HEAD"]);
    const stat = git(ctx.repo, ["show", "--stat", "--name-only", "--pretty=format:", head]);
    expect(stat).toContain("src/metric.txt");
    expect(stat).not.toContain("outside.txt");
    // The out-of-scope file survives as uncommitted working-tree work.
    expect(existsSync(join(ctx.repo, "outside.txt"))).toBe(true);
    expect(git(ctx.repo, ["status", "--porcelain", "--", "outside.txt"])).not.toBe("");
  });

  // VAL-M0-015 (plateau/stall convergence)
  it("converges on plateau when the stall limit is reached before max-iterations", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "echo 50",
      "--task",
      "noop",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--stall-limit",
      "2",
      "--max-iterations",
      "10",
    ]);
    expect(r.status).toBe(0);
    const state = readState(ctx);
    expect(state.convergence.reason).toBe("plateau");
    expect(state.convergence.history.length).toBeLessThan(10);
  });

  // VAL-M0-016 (target convergence)
  it("converges with reason target as soon as the score meets the target", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "echo 5",
      "--task",
      "hit target",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--target",
      "5",
      "--max-iterations",
      "10",
    ]);
    expect(r.status).toBe(0);
    const state = readState(ctx);
    expect(state.convergence.reason).toBe("target");
    expect(state.convergence.history.length).toBeLessThan(10);
  });

  // VAL-M0-017 (--resume continues from state without re-measuring baseline)
  it("--resume continues from prior state (history superset, baseline unchanged)", () => {
    initRepo(ctx.repo, 3);
    const common = [
      "--task",
      "noop",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--stall-limit",
      "2",
      "--max-iterations",
      "2",
    ];
    const first = run(ctx, ["--metric", "echo 50", ...common]);
    expect(first.status).toBe(0);
    const before = readState(ctx);
    expect(before.baseline_score).toBe(50);
    const beforeLen = before.convergence.history.length;

    // Resume with a DIFFERENT metric value; baseline must NOT be re-measured.
    const second = run(ctx, ["--metric", "echo 999", ...common, "--resume"]);
    expect(second.status).toBe(0);
    const after = readState(ctx);
    expect(after.baseline_score).toBe(50);
    expect(after.convergence.history.length).toBeGreaterThanOrEqual(beforeLen);
  });

  // VAL-M0-018 (--non-interactive does not read stdin)
  it("--non-interactive runs to completion with stdin closed", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "echo 5",
      "--task",
      "t",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--target",
      "5",
      "--non-interactive",
    ]);
    expect(r.status).toBe(0);
  });

  // VAL-M0-019 (fail-closed on missing agent dir)
  it("fails closed on a missing agent directory and spawns no worker", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "echo 1",
      "--task",
      "t",
      "--agent",
      join(ctx.root, "does-not-exist"),
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/agent directory/i);
    expect(spawnEntries(ctx).length).toBe(0);
  });

  // VAL-M0-019 (fail-closed on missing repo)
  it("fails closed on a missing repo directory", () => {
    const r = run(ctx, [
      "--metric",
      "echo 1",
      "--task",
      "t",
      "--agent",
      ctx.agentDir,
      "--repo",
      join(ctx.root, "no-such-repo"),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/repo directory/i);
  });

  // VAL-M0-020 (fail-closed on non-zero metric exit)
  it("fails closed when the metric command exits non-zero and writes no state", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "exit 7",
      "--task",
      "t",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/metric command failed/i);
    expect(existsSync(join(ctx.rickgentDir, "microverse.json"))).toBe(false);
  });

  // VAL-M0-020 (fail-closed on non-numeric metric output)
  it("fails closed when the metric command produces no numeric output", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, [
      "--metric",
      "echo not-a-number",
      "--task",
      "t",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no numeric output/i);
    expect(existsSync(join(ctx.rickgentDir, "microverse.json"))).toBe(false);
  });

  // VAL-M0-022 (iteration deadline enforcement)
  it("enforces the iteration deadline and records a deadline_exceeded stall", () => {
    initRepo(ctx.repo, 3);
    const r = run(
      ctx,
      [
        "--metric",
        "wc -l < src/metric.txt | tr -d ' '",
        "--task",
        "hang",
        "--agent",
        ctx.agentDir,
        "--repo",
        ctx.repo,
        "--owned-paths",
        "src",
        "--iteration-deadline-ms",
        "500",
        "--max-iterations",
        "1",
      ],
      { MV_WORKER_SLEEP: "30" },
    );
    expect(r.status).toBe(0);
    const state = readState(ctx);
    const classifications = state.convergence.history.map((h: any) => h.classification);
    expect(classifications).toContain("deadline_exceeded");
  });
});
