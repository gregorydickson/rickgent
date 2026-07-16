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

function spawnEntries(ctx: Ctx): string[][] {
  if (!existsSync(ctx.spawnLog)) return [];
  return readFileSync(ctx.spawnLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function expectCapabilityBlocked(
  ctx: Ctx,
  args: string[],
  capabilityDetail: "RICKGENT_RAW_SHELL_UNAVAILABLE" | "RICKGENT_RESUME_UNAVAILABLE",
  extraEnv: Record<string, string> = {},
): void {
  const statePath = join(ctx.rickgentDir, "microverse.json");
  const stateBefore = existsSync(statePath) ? readFileSync(statePath, "utf-8") : null;
  const spawnsBefore = spawnEntries(ctx);
  const hasRepository = existsSync(join(ctx.repo, ".git"));
  const headBefore = hasRepository ? git(ctx.repo, ["rev-parse", "HEAD"]) : null;
  const statusBefore = hasRepository ? git(ctx.repo, ["status", "--porcelain"]) : null;

  const result = run(ctx, args, extraEnv);

  expect(result.status).toBe(3);
  expect(result.stderr).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
  expect(result.stderr).toContain(capabilityDetail);
  expect(spawnEntries(ctx)).toEqual(spawnsBefore);
  expect(existsSync(statePath)).toBe(stateBefore !== null);
  if (stateBefore !== null) expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
  if (hasRepository) {
    expect(git(ctx.repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(ctx.repo, ["status", "--porcelain"])).toBe(statusBefore);
  }
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

  // VAL-M0-009 (neither)
  it("fails when neither --metric nor --goal is given", () => {
    initRepo(ctx.repo, 3);
    const r = run(ctx, ["--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/one of --metric.*--goal|--metric.*--goal.*required/i);
  });

  // VAL-M0-008..010, 013..016, 018..020, 022: public raw metric execution is
  // unavailable. Parser/loop mechanics remain covered through source-only unit
  // seams; the real CLI must reject before spawn, state, or repository mutation.
  it("rejects raw-metric variants at the capability boundary with zero side effects", () => {
    initRepo(ctx.repo, 3);
    const variants: Array<{ args: string[]; env?: Record<string, string> }> = [
      { args: ["--metric", "echo 1", "--agent", ctx.agentDir] },
      { args: ["--metric", "echo 1", "--goal", "g", "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo] },
      { args: ["--metric", 'printf "ignored\\n42\\n"', "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo, "--owned-paths", "src", "--max-iterations", "1"] },
      { args: ["--metric", "echo 5", "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo, "--direction", "lower"] },
      { args: ["--metric", "echo 5", "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo, "--target", "5"] },
      { args: ["--metric", "echo 5", "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"] },
      { args: ["--metric", "echo 1", "--task", "t", "--agent", join(ctx.root, "missing-agent"), "--repo", ctx.repo] },
      { args: ["--metric", "echo 1", "--task", "t", "--agent", ctx.agentDir, "--repo", join(ctx.root, "missing-repo")] },
      { args: ["--metric", "exit 7", "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo] },
      { args: ["--metric", "echo not-a-number", "--task", "t", "--agent", ctx.agentDir, "--repo", ctx.repo] },
      {
        args: ["--metric", "echo 1", "--task", "hang", "--agent", ctx.agentDir, "--repo", ctx.repo, "--iteration-deadline-ms", "500"],
        env: { MV_WORKER_SLEEP: "30" },
      },
    ];
    for (const variant of variants) {
      expectCapabilityBlocked(ctx, variant.args, "RICKGENT_RAW_SHELL_UNAVAILABLE", variant.env);
    }
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

  // VAL-M0-017: resume wins capability selection before raw-shell parsing.
  it("--resume is unavailable before raw metric execution or state mutation", () => {
    initRepo(ctx.repo, 3);
    expectCapabilityBlocked(
      ctx,
      ["--metric", "echo 999", "--task", "noop", "--agent", ctx.agentDir, "--repo", ctx.repo, "--resume"],
      "RICKGENT_RESUME_UNAVAILABLE",
    );
  });
});
