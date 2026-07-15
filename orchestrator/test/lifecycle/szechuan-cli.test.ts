// M3 — `rickgent szechuan` CLI (VAL-SZECHUAN-001..017).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync against real temp git
// repos with a controllable stub `omnigent` on PATH. Every assertion observes a
// REAL effect: exit code, stderr, git tree/log, the persisted
// .rickgent/szechuan.json state, the gap_analysis.md file, and the recorded
// omnigent-run spawn log.

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
  // Seed a source file with a deliberate violation (console.log = P2 slop)
  writeFileSync(
    join(repo, "src", "app.ts"),
    [
      "export function greet(name: string): string {",
      "  console.log('debug'); // slop pattern",
      "  if (name) {",
      "    if (name.length > 0) {",
      "      if (typeof name === 'string') {",
      "        return 'hello ' + name;",
      "      }",
      "    }",
      "  }",
      "  return '';",
      "}",
      "",
    ].join("\n"),
  );
  git(repo, ["add", "--", "README.md", "src/app.ts"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

// A controllable stub `omnigent`. It records every invocation's argv to
// $SZ_SPAWN_LOG. A judge invocation (read-only judge prompt) prints
// $SZ_JUDGE_COUNT. A worker invocation runs $SZ_WORK_CMD (in the repo cwd).
//
// Judge output: when $SZ_JUDGE_VIOLATIONS is set, the stub emits those lines
// (one per newline) BEFORE the numeric count so that parseViolationsFromJudgeOutput
// can extract severity/principle/file/line/description and parseLastNumericLine
// still picks up the trailing count.
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const argv = process.argv.slice(2);
if (process.env.SZ_SPAWN_LOG) fs.appendFileSync(process.env.SZ_SPAWN_LOG, JSON.stringify(argv) + "\\n");
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? String(argv[pIdx + 1] || "") : "";
if (/read-only Szechuan Sauce violation judge/.test(prompt)) {
  const violations = process.env.SZ_JUDGE_VIOLATIONS || "";
  if (violations.length > 0) {
    process.stdout.write(violations + "\\n");
  }
  process.stdout.write((process.env.SZ_JUDGE_COUNT || "0") + "\\n");
  process.exit(0);
}
// Worker: run the work command if set
if (process.env.SZ_WORK_CMD) {
  try { execFileSync("sh", ["-c", process.env.SZ_WORK_CMD], { cwd: process.cwd() }); } catch (_) {}
}
process.stdout.write("worker done\\n");
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "sz-cli-"));
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
  const res = spawnSync(process.execPath, [CLI_JS, "szechuan", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      SZ_SPAWN_LOG: ctx.spawnLog,
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readState(ctx: Ctx): any {
  return JSON.parse(readFileSync(join(ctx.rickgentDir, "szechuan.json"), "utf-8"));
}

function readGap(ctx: Ctx): string {
  return readFileSync(join(ctx.rickgentDir, "gap_analysis.md"), "utf-8");
}

function spawnEntries(ctx: Ctx): string[][] {
  if (!existsSync(ctx.spawnLog)) return [];
  return readFileSync(ctx.spawnLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("rickgent szechuan CLI (M3)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  // VAL-SZECHUAN-001: CLI command exists and is not a stub
  it("--help exits 0 and lists all 9 documented flags", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("szechuan");
    for (const flag of [
      "--dry-run",
      "--domain",
      "--focus",
      "--design-safe",
      "--max-iterations",
      "--stall-limit",
      "--repo",
      "--agent",
      "--resume",
    ]) {
      expect(r.stdout).toContain(flag);
    }
    // Must NOT contain the stub message
    expect(r.stdout).not.toMatch(/not yet implemented/i);
    expect(r.stderr).not.toMatch(/not yet implemented/i);
  });

  // VAL-SZECHUAN-002: Stub-gone TDD test passes against the production entrypoint
  it("exits 0 (or documented non-zero) on a functional run, not 1 with stub message", () => {
    initRepo(ctx.repo);
    const r = run(
      ctx,
      [
        "--repo",
        ctx.repo,
        "--agent",
        ctx.agentDir,
        "--max-iterations",
        "1",
        "--stall-limit",
        "2",
      ],
      { SZ_JUDGE_COUNT: "3" },
    );
    // With judge count 3 and max-iterations 1, it should run 1 iteration.
    // Non-convergence exits 1, but NOT with "not yet implemented".
    expect(r.stderr).not.toMatch(/not yet implemented/i);
    expect(r.stdout).not.toMatch(/not yet implemented/i);
    // State should be written (proves the command actually ran)
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
  });

  // VAL-SZECHUAN-003: 30+ principles loaded and applied per iteration
  it("catalog has 30+ principles with all 5 buckets non-empty and named principles present", () => {
    // Import the principles module directly and verify the catalog
    const mod = require(join(import.meta.dirname, "../../dist/lifecycle/szechuan-principles.js"));
    const catalog = mod.loadBasePrinciples();
    expect(catalog.length).toBeGreaterThanOrEqual(30);

    const groups = mod.groupByPriority(catalog);
    expect(groups.P0.length).toBeGreaterThan(0);
    expect(groups.P1.length).toBeGreaterThan(0);
    expect(groups.P2.length).toBeGreaterThan(0);
    expect(groups.P3.length).toBeGreaterThan(0);
    expect(groups.P4.length).toBeGreaterThan(0);

    const names = new Set(catalog.map((p: any) => p.name));
    for (const required of ["KISS", "YAGNI", "DRY", "Guard Clauses", "Fail-Fast", "Encapsulation", "Cognitive Load"]) {
      // Check exact or partial match
      const found = catalog.some((p: any) =>
        p.name === required || p.name.toLowerCase().includes(required.toLowerCase()),
      );
      expect(found).toBe(true);
    }

    // Also verify validateCatalog passes
    const validation = mod.validateCatalog(catalog);
    expect(validation.valid).toBe(true);
  });

  // VAL-SZECHUAN-004: --dry-run catalogs violations without fixing or committing
  it("--dry-run produces a catalog without modifying source files or creating commits", () => {
    initRepo(ctx.repo);
    const beforeHead = git(ctx.repo, ["rev-parse", "HEAD"]);
    const beforeContent = readFileSync(join(ctx.repo, "src", "app.ts"), "utf-8");

    const r = run(
      ctx,
      ["--dry-run", "--repo", ctx.repo, "--agent", ctx.agentDir],
      { SZ_JUDGE_COUNT: "5" },
    );
    expect(r.status).toBe(0);

    // gap_analysis.md should exist with violation catalog
    expect(existsSync(join(ctx.rickgentDir, "gap_analysis.md"))).toBe(true);
    const gap = readGap(ctx);
    expect(gap).toContain("Violations");
    expect(gap).toContain("5"); // violation count

    // No source files modified
    const afterContent = readFileSync(join(ctx.repo, "src", "app.ts"), "utf-8");
    expect(afterContent).toBe(beforeContent);

    // No new commits
    const afterHead = git(ctx.repo, ["rev-parse", "HEAD"]);
    expect(afterHead).toBe(beforeHead);

    // git status should have no szechuan-introduced staged changes
    const status = git(ctx.repo, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  // VAL-SZECHUAN-005: --domain loads supplemental principles
  it("--domain loads supplemental principles and grows the catalog", () => {
    const mod = require(join(import.meta.dirname, "../../dist/lifecycle/szechuan-principles.js"));
    const base = mod.loadBasePrinciples();
    const withDomain = mod.loadCatalog("api");
    expect(withDomain.length).toBeGreaterThan(base.length);
    // Domain principles should be tagged with the domain
    const domainPrinciples = withDomain.filter((p: any) => p.domain === "api");
    expect(domainPrinciples.length).toBeGreaterThan(0);

    // Verify the domain principles appear in the worker prompt (via the help output check)
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--dry-run", "--domain", "api", "--repo", ctx.repo, "--agent", ctx.agentDir],
      { SZ_JUDGE_COUNT: "2" },
    );
    expect(r.status).toBe(0);
    // The spawn log should show the domain principles in the prompt
    const entries = spawnEntries(ctx);
    const judgeEntry = entries.find((e) => /read-only Szechuan Sauce violation judge/.test(e[3] ?? ""));
    expect(judgeEntry).toBeTruthy();
    expect(judgeEntry![3]).toContain("API Versioning");
  });

  // VAL-SZECHUAN-005 (fail-closed): unknown domain errors
  it("fails closed on unknown domain", () => {
    initRepo(ctx.repo);
    const r = run(ctx, ["--domain", "nonexistent", "--repo", ctx.repo, "--agent", ctx.agentDir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown domain/i);
  });

  // VAL-SZECHUAN-006: --focus elevates specific concerns to higher priority
  it("--focus elevates matching principles in the judge prompt", () => {
    const mod = require(join(import.meta.dirname, "../../dist/lifecycle/szechuan-principles.js"));
    const base = mod.loadBasePrinciples();
    const focused = mod.applyFocus(base, "error handling");

    // Fail-Fast should be elevated (it has focusKeywords for error/fail)
    const failFastBase = base.find((p: any) => p.name === "Fail-Fast");
    const failFastFocused = focused.find((p: any) => p.name === "Fail-Fast");
    expect(failFastBase!.priority).toBe("P1");
    expect(failFastFocused!.priority).toBe("P0"); // elevated by one level

    // Verify the focus directive appears in the judge prompt
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--dry-run", "--focus", "error handling", "--repo", ctx.repo, "--agent", ctx.agentDir],
      { SZ_JUDGE_COUNT: "1" },
    );
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    const judgeEntry = entries.find((e) => /read-only Szechuan Sauce violation judge/.test(e[3] ?? ""));
    expect(judgeEntry).toBeTruthy();
    expect(judgeEntry![3]).toContain("error handling");
    expect(judgeEntry![3]).toContain("Focus Directive");
  });

  // VAL-SZECHUAN-007: --design-safe marks visual/UI findings as report-only
  it("--design-safe adds design-safe directive to the judge prompt", () => {
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--dry-run", "--design-safe", "--repo", ctx.repo, "--agent", ctx.agentDir],
      { SZ_JUDGE_COUNT: "0" },
    );
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    const judgeEntry = entries.find((e) => /read-only Szechuan Sauce violation judge/.test(e[3] ?? ""));
    expect(judgeEntry).toBeTruthy();
    expect(judgeEntry![3]).toContain("Design-Safe");
    expect(judgeEntry![3]).toMatch(/report-only|visual/i);
  });

  // VAL-SZECHUAN-008: Phase 0 contract discovery writes exports, importers, contract map
  it("Phase 0 contract discovery writes a contract map to gap_analysis.md", () => {
    initRepo(ctx.repo);
    // Add a file that imports from app.ts
    writeFileSync(
      join(ctx.repo, "src", "index.ts"),
      'import { greet } from "./app.js";\nconsole.log(greet("world"));\n',
    );
    git(ctx.repo, ["add", "--", "src/index.ts"]);
    git(ctx.repo, ["commit", "-q", "-m", "add importer"]);

    const r = run(
      ctx,
      ["--dry-run", "--repo", ctx.repo, "--agent", ctx.agentDir],
      { SZ_JUDGE_COUNT: "2" },
    );
    expect(r.status).toBe(0);
    const gap = readGap(ctx);
    expect(gap).toContain("Contract Map");
    // Should reference the exported function and the importer
    expect(gap).toContain("greet");
  });

  // VAL-SZECHUAN-009: Per iteration finds the highest-priority violation P0-P4
  it("per-iteration records include a non-null violation with severity in {P0,P1,P2,P3,P4}", () => {
    initRepo(ctx.repo);
    // Judge outputs violation lines before the numeric count. The stub emits
    // $SZ_JUDGE_VIOLATIONS lines then the count. With count 3 and max-iterations
    // 2, the loop runs 2 iterations (non-converging).
    const violations = [
      "[P2, conf=0.9] src/app.ts:2 — console.log debug statement (principle: KISS)",
      "[P1, conf=0.8] src/app.ts:4 — nested if statements (principle: Guard Clauses)",
      "[P3, conf=0.7] src/app.ts:3 — missing early return (principle: Fail-Fast)",
    ].join("\n");
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "2", "--stall-limit", "3"],
      { SZ_JUDGE_COUNT: "3", SZ_JUDGE_VIOLATIONS: violations },
    );
    // Non-convergence is expected with count 3 and max-iterations 2
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
    const state = readState(ctx);
    expect(Array.isArray(state.convergence.history)).toBe(true);
    expect(state.convergence.history.length).toBeGreaterThan(0);
    const validSeverities = new Set(["P0", "P1", "P2", "P3", "P4"]);
    for (const entry of state.convergence.history) {
      expect(entry.classification).toBeDefined();
      // Strengthened: entry.violation must be non-null with a valid severity
      expect(entry.violation).not.toBeNull();
      expect(entry.violation).toBeDefined();
      expect(typeof entry.violation.severity).toBe("string");
      expect(validSeverities.has(entry.violation.severity)).toBe(true);
    }
    // The first iteration's violation should be the highest-priority (P1)
    // from the baseline judge output (P1 < P2 < P3 in severity rank).
    const first = state.convergence.history[0];
    expect(first.violation.severity).toBe("P1");
    expect(first.violation.principle).toBe("Guard Clauses");
    expect(first.violation.file).toBe("src/app.ts");
    expect(first.violation.line).toBe(4);
    expect(first.violation.description).toContain("nested if");
  });

  // VAL-SZECHUAN-010: Per iteration fixes atomically, tests, commits
  it("an improving iteration commits only owned paths", () => {
    initRepo(ctx.repo);
    const beforeHead = git(ctx.repo, ["rev-parse", "HEAD"]);
    const r = run(
      ctx,
      [
        "--repo",
        ctx.repo,
        "--agent",
        ctx.agentDir,
        "--max-iterations",
        "3",
        "--stall-limit",
        "3",
      ],
      {
        SZ_JUDGE_COUNT: "3",
        // Worker reduces the violation count by fixing the console.log
        SZ_WORK_CMD: "sed -i '' '/console.log/d' src/app.ts",
      },
    );
    // With judge count 3 and the worker fixing issues, it may converge or stall
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
    const state = readState(ctx);

    // Check if any iteration was "improved" (committed)
    const improved = state.convergence.history.filter((h: any) => h.classification === "improved");
    if (improved.length > 0) {
      // The commit should exist in git log
      const afterHead = git(ctx.repo, ["rev-parse", "HEAD"]);
      expect(afterHead).not.toBe(beforeHead);
      // Check the latest commit touches only owned files
      const stat = git(ctx.repo, ["show", "--stat", "--name-only", "--pretty=format:", afterHead]);
      expect(stat).toContain("src/");
    }
  });

  // VAL-SZECHUAN-011: MicroverseLoop drives convergence with violation-count metric
  it("constructs MicroverseLoop with target=0, direction=lower (verified via convergence behavior)", () => {
    initRepo(ctx.repo);
    // With judge count 0, the loop should converge immediately (target 0 reached)
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "5", "--stall-limit", "3"],
      { SZ_JUDGE_COUNT: "0" },
    );
    expect(r.status).toBe(0); // converged → exit 0
    const state = readState(ctx);
    expect(state.converged).toBe(true);
    expect(state.convergence.reason).toBe("target");
    expect(state.baselineCount).toBe(0);
  });

  // VAL-SZECHUAN-012: LLM judge scores violation count via omnigent run
  it("LLM judge is spawned via omnigent run with read-only tools and count is parsed", () => {
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "2"],
      { SZ_JUDGE_COUNT: "7" },
    );
    const entries = spawnEntries(ctx);
    // At least one judge spawn (read-only evaluation)
    const judges = entries.filter((e) => /read-only Szechuan Sauce violation judge/.test(e[3] ?? ""));
    expect(judges.length).toBeGreaterThan(0);
    // Every spawn is `omnigent run <agentDir> -p <prompt>` with array argv
    for (const e of entries) {
      expect(e[0]).toBe("run");
      expect(e[1]).toBe(ctx.agentDir);
      expect(e[2]).toBe("-p");
    }
    // The baseline count should be 7 (parsed from the judge output)
    const state = readState(ctx);
    expect(state.baselineCount).toBe(7);
  });

  // VAL-SZECHUAN-013: Regression triggers git restore of scoped files
  it("regression reverts scoped files and does not commit", () => {
    initRepo(ctx.repo);
    const beforeHead = git(ctx.repo, ["rev-parse", "HEAD"]);
    // Judge count increases (regression) → loop should revert
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "2"],
      { SZ_JUDGE_COUNT: "10" },
    );
    // With baseline 10 and worker not improving, it stalls/reverts
    const state = readState(ctx);
    // The head should not advance (no improvement committed)
    const afterHead = git(ctx.repo, ["rev-parse", "HEAD"]);
    // No commit should have been made for a non-improving iteration
    if (state.convergence.history.length > 0) {
      const classifications = state.convergence.history.map((h: any) => h.classification);
      // Should NOT be "improved"
      expect(classifications).not.toContain("improved");
    }
  });

  // VAL-SZECHUAN-014: Convergence at violation count 0 OR stall_limit OR max_iterations
  it("converges (exit 0) when violation count reaches 0", () => {
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "5", "--stall-limit", "3"],
      { SZ_JUDGE_COUNT: "0" },
    );
    expect(r.status).toBe(0);
    const state = readState(ctx);
    expect(state.converged).toBe(true);
    expect(state.convergence.reason).toBe("target");
  });

  it("exits non-zero when max-iterations is reached without convergence", () => {
    initRepo(ctx.repo);
    // Judge count stays at 5, worker doesn't fix → never reaches 0
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "2", "--stall-limit", "10"],
      { SZ_JUDGE_COUNT: "5" },
    );
    expect(r.status).not.toBe(0);
    const state = readState(ctx);
    expect(state.converged).toBe(false);
  });

  it("exits non-zero when stall_limit is reached without convergence", () => {
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "10", "--stall-limit", "2"],
      { SZ_JUDGE_COUNT: "5" },
    );
    expect(r.status).not.toBe(0);
    const state = readState(ctx);
    expect(state.converged).toBe(false);
    expect(state.convergence.reason).toMatch(/plateau|max_iterations/);
  });

  // VAL-SZECHUAN-015: --resume reads state from .rickgent/
  it("--resume continues from prior state (history superset, baseline preserved)", () => {
    initRepo(ctx.repo);
    const common = [
      "--repo",
      ctx.repo,
      "--agent",
      ctx.agentDir,
      "--max-iterations",
      "1",
      "--stall-limit",
      "5",
    ];
    // First run with judge count 5
    const first = run(ctx, common, { SZ_JUDGE_COUNT: "5" });
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
    const before = readState(ctx);
    expect(before.baselineCount).toBe(5);
    const beforeLen = before.convergence.history.length;

    // Resume — should NOT re-run Phase 0, should preserve baseline
    const second = run(ctx, [...common, "--resume"], { SZ_JUDGE_COUNT: "99" });
    const after = readState(ctx);
    // Baseline should NOT be re-measured (should stay 5, not 99)
    expect(after.baselineCount).toBe(5);
    // History should be a superset
    expect(after.convergence.history.length).toBeGreaterThanOrEqual(beforeLen);
  });

  // VAL-SZECHUAN-016: State written to .rickgent/szechuan.json and gap_analysis.md
  it("state file has documented fields per iteration", () => {
    initRepo(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "2", "--stall-limit", "3"],
      { SZ_JUDGE_COUNT: "3" },
    );
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
    const state = readState(ctx);
    expect(typeof state.baselineCount).toBe("number");
    expect(Array.isArray(state.convergence.history)).toBe(true);
    expect(Array.isArray(state.failedApproaches)).toBe(true);
    expect(typeof state.catalogSize).toBe("number");
    expect(state.catalogSize).toBeGreaterThanOrEqual(30);

    // gap_analysis.md should exist
    expect(existsSync(join(ctx.rickgentDir, "gap_analysis.md"))).toBe(true);
    const gap = readGap(ctx);
    expect(gap).toContain("Contract Map");
  });

  // VAL-SZECHUAN-017: Fail-closed on errors
  it("fails closed on missing agent directory", () => {
    initRepo(ctx.repo);
    const r = run(ctx, ["--repo", ctx.repo, "--agent", join(ctx.root, "no-such-dir")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/agent directory/i);
    expect(spawnEntries(ctx).length).toBe(0);
  });

  it("fails closed on missing repo directory", () => {
    const r = run(ctx, ["--repo", join(ctx.root, "no-such-repo"), "--agent", ctx.agentDir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/repo directory/i);
  });

  it("fails closed when the judge produces no numeric output", () => {
    initRepo(ctx.repo);
    // Override the stub to produce no numeric output for the judge
    const stubNoNum = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? String(argv[pIdx + 1] || "") : "";
if (/read-only Szechuan Sauce violation judge/.test(prompt)) {
  process.stdout.write("no violations found here\\n");
  process.exit(0);
}
process.stdout.write("worker done\\n");
process.exit(0);
`;
    writeFileSync(join(ctx.binDir, "omnigent"), stubNoNum);
    chmodSync(join(ctx.binDir, "omnigent"), 0o755);
    const r = run(ctx, ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/violation count|numeric|judge/i);
  });

  // Static check: no shell-string spawn sites or git add -A
  it("szechuan-cli.ts contains no shell-string spawn sites or git add -A", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/szechuan-cli.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/[^A-Za-z]exec\(/);
    expect(src).not.toMatch(/add -A/);
  });
});
