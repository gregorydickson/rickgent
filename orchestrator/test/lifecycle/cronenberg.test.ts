// M0 — `rickgent cronenberg` CLI (VAL-M0-023..035).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync. cronenberg is a pure
// deterministic router: every assertion observes a real effect (exit code,
// stdout plan text, and the recorded omnigent spawn log, which must stay empty
// for a router). A controllable stub `omnigent` sits first on PATH and records
// any invocation to $CR_SPAWN_LOG — cronenberg must never touch it.

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

const CLI_JS = join(import.meta.dirname, "../../dist/cli.js");

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

function initRepo(repo: string): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

const VALID_PRD = `# PRD: Example

## Introduction
Do a thing.

## Acceptance Criteria
- The system returns 200 on GET /health.
  verify: curl -sf http://localhost:3000/health
`;

const STUB = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.CR_SPAWN_LOG) fs.appendFileSync(process.env.CR_SPAWN_LOG, JSON.stringify(argv) + "\\n");
process.stdout.write("worker done\\n");
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "cr-cli-"));
  const repo = join(root, "repo");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const rickgentDir = join(root, "rickgent");
  mkdirSync(repo, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rickgentDir, { recursive: true });
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
  const res = spawnSync(process.execPath, [CLI_JS, "cronenberg", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      CR_SPAWN_LOG: ctx.spawnLog,
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function spawnCount(ctx: Ctx): number {
  if (!existsSync(ctx.spawnLog)) return 0;
  return readFileSync(ctx.spawnLog, "utf-8").split("\n").filter((l) => l.length > 0).length;
}

function metaphorLine(stdout: string): string {
  return (stdout.split("\n").find((l) => l.startsWith("metaphor:")) ?? "").trim();
}

function followupsLine(stdout: string): string {
  return (stdout.split("\n").find((l) => l.startsWith("followups:")) ?? "").trim();
}

function refineLine(stdout: string): string {
  return (stdout.split("\n").find((l) => l.startsWith("refine:")) ?? "").trim();
}

describe("rickgent cronenberg CLI (M0)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  // VAL-M0-023
  it("--help exits 0 and lists all four cronenberg-only flags", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    for (const flag of ["--dry-run", "--no-followups", "--no-refine", "--refine"]) {
      expect(r.stdout).toContain(flag);
    }
  });

  // VAL-M0-024
  it("--dry-run prints the plan and exits 0 without spawning anything", () => {
    const r = run(ctx, ["--dry-run", "--task", "optimize latency", "--metric", "echo 1", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: microverse");
    expect(r.stdout).toContain("followups:");
    expect(spawnCount(ctx)).toBe(0);
  });

  // VAL-M0-025
  it("is deterministic — same inputs produce byte-identical plan output", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const args = ["--dry-run", "--task", "add login, add logout, and build dashboard", "--repo", ctx.repo];
    const r1 = run(ctx, args);
    const r2 = run(ctx, args);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
  });

  // VAL-M0-026
  it("MEASURABLE_METRIC + optimize verb selects microverse", () => {
    const r = run(ctx, ["--dry-run", "--task", "optimize coverage to 90%", "--metric", "echo 5", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: microverse");
  });

  // VAL-M0-027
  it("MULTI_STAGE (no metric) selects pipeline", () => {
    const r = run(ctx, ["--dry-run", "--task", "refine and build the export module", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: pipeline");
  });

  // VAL-M0-028 (ticket>=3 → build)
  it("TICKET_COUNT >= 3 selects build", () => {
    const r = run(ctx, [
      "--dry-run",
      "--task",
      "add login, add logout, and build a dashboard",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
  });

  // VAL-M0-028 (default fallback → build)
  it("default (no metric, no multi-stage, <3 tickets) falls through to build", () => {
    const r = run(ctx, ["--dry-run", "--task", "fix a typo in the header", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
  });

  // VAL-M0-029 (a) CITADEL_RISK → citadel
  it("CITADEL_RISK alone adds citadel to followups", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, ["--dry-run", "--task", "audit against PRD conformance", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
    expect(followupsLine(r.stdout)).toContain("citadel");
    expect(followupsLine(r.stdout)).not.toContain("anatomy");
    expect(followupsLine(r.stdout)).not.toContain("szechuan");
  });

  // VAL-M0-029 (b) SUBSYSTEM_TOUCHES >= 2 → anatomy
  it("SUBSYSTEM_TOUCHES >= 2 alone adds anatomy to followups", () => {
    const r = run(ctx, ["--dry-run", "--task", "review auth/ and billing/ modules", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
    expect(followupsLine(r.stdout)).toContain("anatomy");
    expect(followupsLine(r.stdout)).not.toContain("citadel");
    expect(followupsLine(r.stdout)).not.toContain("szechuan");
  });

  // VAL-M0-029 (c) diff >= 500 LOC → szechuan
  it("a git diff >= 500 LOC alone adds szechuan to followups", () => {
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\n";
    // Modify a TRACKED file so `git diff HEAD` reports the churn (untracked files do not show).
    writeFileSync(join(ctx.repo, "README.md"), big);
    const r = run(ctx, ["--dry-run", "--task", "work on the thing", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
    expect(followupsLine(r.stdout)).toContain("szechuan");
    expect(followupsLine(r.stdout)).not.toContain("anatomy");
  });

  // VAL-M0-030 (pipeline suppresses followups)
  it("pipeline metaphor emits no followups even when followup signals are present", () => {
    const r = run(ctx, [
      "--dry-run",
      "--task",
      "refine and build auth/ and billing/ modules",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: pipeline");
    expect(followupsLine(r.stdout)).toBe("followups: []");
  });

  // VAL-M0-030 (microverse suppresses followups)
  it("microverse metaphor emits no followups even when followup signals are present", () => {
    const r = run(ctx, [
      "--dry-run",
      "--task",
      "optimize latency in auth/ and billing/",
      "--metric",
      "echo 1",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: microverse");
    expect(followupsLine(r.stdout)).toBe("followups: []");
  });

  // VAL-M0-031
  it("--no-followups skips all followups", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, [
      "--dry-run",
      "--no-followups",
      "--task",
      "audit against PRD conformance in auth/ and billing/",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
    expect(followupsLine(r.stdout)).toBe("followups: []");
  });

  // VAL-M0-032 (--no-refine forces false)
  it("--no-refine forces refine=false regardless of signals", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, [
      "--dry-run",
      "--no-refine",
      "--task",
      "add login, add logout, and build a dashboard",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(refineLine(r.stdout)).toBe("refine: false");
  });

  // VAL-M0-032 (--refine forces true)
  it("--refine forces refine=true regardless of signals", () => {
    writeFileSync(join(ctx.repo, "prd_refined.md"), "already refined\n");
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, ["--dry-run", "--refine", "--task", "fix a typo", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(refineLine(r.stdout)).toBe("refine: true");
  });

  // VAL-M0-033 (a) ALREADY_REFINED → false
  it("refine decision: ALREADY_REFINED yields refine=false", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    writeFileSync(join(ctx.repo, "prd_refined.md"), "already refined\n");
    const r = run(ctx, [
      "--dry-run",
      "--task",
      "add login, add logout, and build a dashboard",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(refineLine(r.stdout)).toBe("refine: false");
  });

  // VAL-M0-033 (b) TICKET_COUNT >= 3 → true
  it("refine decision: TICKET_COUNT >= 3 (no prior refinement) yields refine=true", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, [
      "--dry-run",
      "--task",
      "add login, add logout, and build a dashboard",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(refineLine(r.stdout)).toBe("refine: true");
  });

  // VAL-M0-033 (c) single-file → false
  it("refine decision: single-file well-shaped PRD yields refine=false", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, ["--dry-run", "--task", "fix a typo in the header", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(refineLine(r.stdout)).toBe("refine: false");
  });

  // VAL-M0-034
  it("spawns no agent subprocess during --dry-run and the module has no spawn sites", () => {
    const r = run(ctx, ["--dry-run", "--task", "audit against PRD conformance", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(spawnCount(ctx)).toBe(0);
    const src = readFileSync(join(import.meta.dirname, "../../src/lifecycle/cronenberg.ts"), "utf-8");
    expect(src).not.toMatch(/omnigent/);
    expect(src).not.toMatch(/spawn/);
    expect(src).not.toMatch(/exec/);
  });

  // VAL-M0-035
  it("fails closed when there is no task and no PRD", () => {
    const r = run(ctx, ["--dry-run", "--repo", ctx.repo]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/task/i);
    expect(r.stderr).toMatch(/prd/i);
    expect(metaphorLine(r.stdout)).toBe("");
  });

  // Delegation (non-dry-run) — cronenberg runs the chosen command as a child
  // rickgent process; the agent spawning is that child's responsibility.
  it("non-dry-run delegates to the chosen metaphor command (child rickgent process)", () => {
    const r = run(ctx, [
      "--task",
      "optimize coverage to 90%",
      "--metric",
      "echo 5",
      "--target",
      "5",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
    ]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: microverse");
    // The delegated microverse child measured the metric and wrote state.
    expect(existsSync(join(ctx.rickgentDir, "microverse.json"))).toBe(true);
  });
});
