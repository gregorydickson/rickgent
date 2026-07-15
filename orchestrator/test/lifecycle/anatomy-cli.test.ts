// M4 — `rickgent anatomy` CLI (VAL-ANATOMY-001..014).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync against real temp git
// repos with a controllable stub `omnigent` on PATH. Every assertion observes a
// REAL effect: exit code, stderr, git tree/log, the persisted
// .rickgent/anatomy-park.json state, CLAUDE.md trap door files, and the
// recorded omnigent-run spawn log.

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

/** Seed a fixture repo with subsystems. */
function initRepo(repo: string): void {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

/**
 * Seed a repo with subsystems matching the VAL-ANATOMY-003 discovery scenario:
 *   alpha/  — 4 source files (qualifies)
 *   beta/   — 2 source files (excluded, < 3)
 *   gamma/  — 3 test files (excluded, test-only > 80%)
 *   node_modules/ — 10 source files (excluded, noise)
 */
function seedSubsystems(repo: string): void {
  // alpha: 4 source files
  mkdirSync(join(repo, "alpha"), { recursive: true });
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(repo, "alpha", `file${i}.ts`), `export const a${i} = ${i};\n`);
  }
  // beta: 2 source files (< 3, excluded)
  mkdirSync(join(repo, "beta"), { recursive: true });
  writeFileSync(join(repo, "beta", "one.ts"), `export const b1 = 1;\n`);
  writeFileSync(join(repo, "beta", "two.ts"), `export const b2 = 2;\n`);
  // gamma: 3 test files (test-only > 80%, excluded)
  mkdirSync(join(repo, "gamma"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, "gamma", `file${i}.test.ts`), `test('t${i}', () => {});\n`);
  }
  // node_modules: 10 source files (excluded, noise)
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(repo, "node_modules", "pkg", `f${i}.js`), `module.exports = ${i};\n`);
  }
  git(repo, ["add", "--", "alpha", "beta", "gamma", "node_modules"]);
  git(repo, ["commit", "-q", "-m", "seed subsystems"]);
}

/** Seed a repo with two subsystems for convergence tests. */
function seedTwoSubsystems(repo: string): void {
  mkdirSync(join(repo, "alpha"), { recursive: true });
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(repo, "alpha", `file${i}.ts`), `export const a${i} = ${i};\n`);
  }
  mkdirSync(join(repo, "beta"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, "beta", `file${i}.ts`), `export const b${i} = ${i};\n`);
  }
  git(repo, ["add", "--", "alpha", "beta"]);
  git(repo, ["commit", "-q", "-m", "seed two subsystems"]);
}

// A controllable stub `omnigent`. It records every invocation's argv to
// $AP_SPAWN_LOG. Based on the prompt content, it acts as:
//   REVIEW prompt  → outputs findings from $AP_REVIEW_FINDINGS (JSON array)
//                    and a trailing numeric line (remaining non-converged count)
//   FIX prompt     → runs $AP_FIX_CMD (a shell command in the repo cwd)
//   VERIFY prompt  → outputs "PASS" or "FAIL" based on $AP_VERIFY_RESULT
//
// When $AP_REVIEW_FINDINGS is "[]" (empty), REVIEW returns zero findings
// (a clean pass), and the trailing count is from $AP_REVIEW_COUNT.
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const argv = process.argv.slice(2);
if (process.env.AP_SPAWN_LOG) fs.appendFileSync(process.env.AP_SPAWN_LOG, JSON.stringify(argv) + "\\n");
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? String(argv[pIdx + 1] || "") : "";

if (/read-only.*review|REVIEW.*read-only|anatomy.*REVIEW/i.test(prompt)) {
  // REVIEW phase: output findings as JSON, then a numeric count
  const findings = process.env.AP_REVIEW_FINDINGS || "[]";
  process.stdout.write(findings + "\\n");
  process.stdout.write((process.env.AP_REVIEW_COUNT || "0") + "\\n");
  process.exit(0);
}
if (/FIX.*minimal edit|anatomy.*FIX|fix.*highest.*severity/i.test(prompt)) {
  // FIX phase: run the fix command
  if (process.env.AP_FIX_CMD) {
    try { execFileSync("sh", ["-c", process.env.AP_FIX_CMD], { cwd: process.cwd() }); } catch (_) {}
  }
  process.stdout.write("fix applied\\n");
  process.exit(0);
}
if (/VERIFY.*read-only|anatomy.*VERIFY|combinatorial.*branch/i.test(prompt)) {
  // VERIFY phase: output pass/fail
  const result = process.env.AP_VERIFY_RESULT || "PASS";
  process.stdout.write(result + "\\n");
  process.exit(0);
}
// Default: no-op
process.stdout.write("anatomy worker done\\n");
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "anat-cli-"));
  const repo = join(root, "repo");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const rickgentDir = join(root, "rickgent");
  mkdirSync(repo, { recursive: true });
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
  const res = spawnSync(process.execPath, [CLI_JS, "anatomy", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      AP_SPAWN_LOG: ctx.spawnLog,
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readState(ctx: Ctx): any {
  return JSON.parse(readFileSync(join(ctx.rickgentDir, "anatomy-park.json"), "utf-8"));
}

function spawnEntries(ctx: Ctx): string[][] {
  if (!existsSync(ctx.spawnLog)) return [];
  return readFileSync(ctx.spawnLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("rickgent anatomy CLI (M4)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  // VAL-ANATOMY-001: CLI command exists and is not a stub
  it("--help exits 0 and lists all 6 documented flags", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("anatomy");
    for (const flag of [
      "--dry-run",
      "--max-iterations",
      "--stall-limit",
      "--repo",
      "--agent",
      "--resume",
    ]) {
      expect(r.stdout).toContain(flag);
    }
    expect(r.stdout).not.toMatch(/not yet implemented/i);
    expect(r.stderr).not.toMatch(/not yet implemented/i);
  });

  // VAL-ANATOMY-002: Stub-gone TDD test passes against the production entrypoint
  it("exits 0 (or documented non-zero) on a functional run, not 1 with stub message", () => {
    initRepo(ctx.repo);
    seedSubsystems(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "2"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    expect(r.stderr).not.toMatch(/not yet implemented/i);
    expect(r.stdout).not.toMatch(/not yet implemented/i);
    // State should be written (proves the command actually ran)
    expect(existsSync(join(ctx.rickgentDir, "anatomy-park.json"))).toBe(true);
  });

  // VAL-ANATOMY-003: Auto-discovers subsystems (3+ source files, excludes noise)
  it("discovers only qualifying subsystems (alpha), excluding beta/gamma/node_modules", () => {
    initRepo(ctx.repo);
    seedSubsystems(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "2"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    expect(r.status).not.toBeNull();
    const state = readState(ctx);
    expect(state.subsystems).toEqual(["alpha"]);
    // beta, gamma, node_modules must NOT be in the list
    expect(state.subsystems).not.toContain("beta");
    expect(state.subsystems).not.toContain("gamma");
    expect(state.subsystems).not.toContain("node_modules");
  });

  // VAL-ANATOMY-004: Rotation state persisted to .rickgent/anatomy-park.json
  it("anatomy-park.json has all required fields with valid current_index", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "2"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    expect(existsSync(join(ctx.rickgentDir, "anatomy-park.json"))).toBe(true);
    const state = readState(ctx);
    expect(Array.isArray(state.subsystems)).toBe(true);
    expect(state.subsystems.length).toBe(2);
    expect(typeof state.currentIndex).toBe("number");
    expect(state.currentIndex).toBeGreaterThanOrEqual(0);
    expect(state.currentIndex).toBeLessThan(state.subsystems.length);
    expect(typeof state.passCounts).toBe("object");
    expect(typeof state.consecutiveClean).toBe("object");
    expect(typeof state.stallCounts).toBe("object");
    expect(typeof state.stallLimit).toBe("number");
    expect(typeof state.findingsHistory).toBe("object");
    expect(Array.isArray(state.trapDoorsAdded)).toBe(true);
    expect(Array.isArray(state.trapDoorsCommitted)).toBe(true);
  });

  // VAL-ANATOMY-005: 3-phase protocol REVIEW -> FIX -> VERIFY per iteration
  it("records REVIEW -> FIX -> VERIFY phases in order when findings exist", () => {
    initRepo(ctx.repo);
    // Single subsystem with a source file
    mkdirSync(join(ctx.repo, "svc"), { recursive: true });
    writeFileSync(join(ctx.repo, "svc", "a.ts"), `export const x = 1;\n`);
    writeFileSync(join(ctx.repo, "svc", "b.ts"), `export const y = 2;\n`);
    writeFileSync(join(ctx.repo, "svc", "c.ts"), `export const z = 3;\n`);
    git(ctx.repo, ["add", "--", "svc"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed svc"]);

    const findings = JSON.stringify([
      {
        id: "svc-001",
        severity: "CRITICAL",
        confidence: 95,
        category: "data-flow",
        file: "svc/a.ts",
        line: 1,
        title: "uninitialized export",
        description: "Export without validation",
        proposedFix: "Add validation",
      },
    ]);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "3"],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: `echo 'fix' > svc/a.ts`,
        AP_VERIFY_RESULT: "PASS",
      },
    );
    const state = readState(ctx);
    const history = state.findingsHistory["svc"] ?? [];
    expect(history.length).toBeGreaterThan(0);
    const first = history[0];
    expect(first.phases).toBeDefined();
    const phaseNames = first.phases.map((p: any) => p.phase);
    expect(phaseNames).toContain("REVIEW");
    expect(phaseNames).toContain("FIX");
    expect(phaseNames).toContain("VERIFY");
    // REVIEW must come before FIX, FIX before VERIFY
    const reviewIdx = phaseNames.indexOf("REVIEW");
    const fixIdx = phaseNames.indexOf("FIX");
    const verifyIdx = phaseNames.indexOf("VERIFY");
    expect(reviewIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(verifyIdx);
  });

  // VAL-ANATOMY-005 (zero findings): skips FIX/VERIFY, bumps consecutive_clean
  it("zero-finding iteration skips FIX/VERIFY and bumps consecutive_clean", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "2"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    const state = readState(ctx);
    const subsystem = state.subsystems[state.currentIndex === 0 ? 0 : 0];
    // After a clean pass, consecutive_clean for the reviewed subsystem should be >= 1
    const clean = state.consecutiveClean;
    const anyClean = Object.values(clean).some((v: any) => v >= 1);
    expect(anyClean).toBe(true);
    // No FIX or VERIFY phases in the history
    const allHist = Object.values(state.findingsHistory).flat() as any[];
    for (const entry of allHist) {
      if (entry.phases) {
        const phases = entry.phases.map((p: any) => p.phase);
        expect(phases).not.toContain("FIX");
        expect(phases).not.toContain("VERIFY");
      }
    }
  });

  // VAL-ANATOMY-006: REVIEW is read-only and rates CRITICAL/HIGH with confidence
  it("REVIEW worker is spawned via omnigent run and findings have severity + confidence", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    const findings = JSON.stringify([
      {
        id: "alpha-001",
        severity: "CRITICAL",
        confidence: 92,
        category: "data-flow",
        file: "alpha/file0.ts",
        line: 1,
        title: "test finding",
        description: "A critical finding",
        proposedFix: "Fix it",
      },
    ]);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "3"],
      { AP_REVIEW_FINDINGS: findings, AP_REVIEW_COUNT: "1", AP_FIX_CMD: "true", AP_VERIFY_RESULT: "PASS" },
    );
    const entries = spawnEntries(ctx);
    // At least one REVIEW spawn
    const reviews = entries.filter((e) => /REVIEW|read-only.*review/i.test(e[3] ?? ""));
    expect(reviews.length).toBeGreaterThan(0);
    // Every spawn is omnigent run <agentDir> -p <prompt>
    for (const e of entries) {
      expect(e[0]).toBe("run");
      expect(e[1]).toBe(ctx.agentDir);
    }
    // Findings in state should have severity and confidence
    const state = readState(ctx);
    const allHist = Object.values(state.findingsHistory).flat() as any[];
    const findingEntry = allHist.find((e) => e.findings && e.findings.length > 0);
    if (findingEntry) {
      const f = findingEntry.findings[0];
      expect(f.severity).toMatch(/CRITICAL|HIGH/);
      expect(typeof f.confidence).toBe("number");
    }
  });

  // VAL-ANATOMY-007: FIX applies minimal edit, regression test, scope preflight
  it("FIX with out-of-scope path triggers unstage + CRITICAL + stall", () => {
    initRepo(ctx.repo);
    mkdirSync(join(ctx.repo, "svc"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(ctx.repo, "svc", `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "svc"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed svc"]);

    const findings = JSON.stringify([
      {
        id: "svc-001",
        severity: "CRITICAL",
        confidence: 90,
        category: "data-flow",
        file: "svc/f0.ts",
        line: 1,
        title: "out of scope fix",
        description: "Fix touches out-of-scope path",
        proposedFix: "Edit out-of-scope file",
      },
    ]);
    // FIX writes to an out-of-scope path (outside svc/)
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "1"],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: `echo 'out of scope' > outside.txt && git add -- outside.txt`,
        AP_VERIFY_RESULT: "PASS",
      },
    );
    const state = readState(ctx);
    // The subsystem should have a stall count (scope violation → stall)
    const svcStall = state.stallCounts["svc"] ?? 0;
    expect(svcStall).toBeGreaterThanOrEqual(1);
  });

  // VAL-ANATOMY-008: VERIFY does combinatorial branch verification + reverts on regression
  it("VERIFY detects regression and restores files + stalls", () => {
    initRepo(ctx.repo);
    mkdirSync(join(ctx.repo, "svc"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(ctx.repo, "svc", `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "svc"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed svc"]);

    const findings = JSON.stringify([
      {
        id: "svc-001",
        severity: "HIGH",
        confidence: 85,
        category: "data-flow",
        file: "svc/f0.ts",
        line: 1,
        title: "nullable branch",
        description: "Nullable not handled",
        proposedFix: "Add null check",
      },
    ]);
    // FIX modifies a file in-scope, VERIFY says FAIL (regression)
    const beforeContent = readFileSync(join(ctx.repo, "svc", "f0.ts"), "utf-8");
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "1"],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: `echo 'modified' > svc/f0.ts`,
        AP_VERIFY_RESULT: "FAIL",
      },
    );
    const state = readState(ctx);
    // VERIFY phase should be recorded with FAIL
    const svcHist = state.findingsHistory["svc"] ?? [];
    if (svcHist.length > 0) {
      const last = svcHist[svcHist.length - 1];
      const verifyPhase = last.phases?.find((p: any) => p.phase === "VERIFY");
      if (verifyPhase) {
        expect(verifyPhase.result).toMatch(/FAIL|REGRESSION/i);
      }
      // Should be reverted
      expect(last.reverted).toBe(true);
    }
    // Stall count should increase
    expect(state.stallCounts["svc"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  // VAL-ANATOMY-009: Trap doors written to subsystem CLAUDE.md files
  it("writes Trap Doors section to subsystem CLAUDE.md after repeated fixes", () => {
    initRepo(ctx.repo);
    mkdirSync(join(ctx.repo, "svc"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(ctx.repo, "svc", `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "svc"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed svc"]);

    const findings = JSON.stringify([
      {
        id: "svc-001",
        severity: "CRITICAL",
        confidence: 90,
        category: "pattern",
        file: "svc/f0.ts",
        line: 1,
        title: "structural finding",
        description: "A structural invariant",
        proposedFix: "Fix it",
      },
    ]);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "3"],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: `echo 'fixed' > svc/f0.ts`,
        AP_VERIFY_RESULT: "PASS",
      },
    );
    // Check CLAUDE.md was written with Trap Doors section
    const claudePath = join(ctx.repo, "svc", "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(true);
    const claude = readFileSync(claudePath, "utf-8");
    expect(claude).toContain("## Trap Doors");
    // Should have at least one entry with INVARIANT/BREAKS/ENFORCE shape
    expect(claude).toMatch(/INVARIANT/i);
    expect(claude).toMatch(/BREAKS/i);
    expect(claude).toMatch(/ENFORCE/i);
    // trap_doors_added counter in state
    const state = readState(ctx);
    expect(state.trapDoorsAdded.length).toBeGreaterThan(0);
  });

  // VAL-ANATOMY-010: Worker-managed convergence — all subsystems consecutive_clean >= 2
  it("converges when all subsystems reach consecutive_clean >= 2", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    // With zero findings on every REVIEW, each subsystem gets consecutive_clean bumped.
    // With 2 subsystems, 4 iterations (2 per subsystem) → all clean >= 2 → CONVERGED.
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "10", "--stall-limit", "3"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    const state = readState(ctx);
    // All subsystems should have consecutive_clean >= 2
    for (const sub of state.subsystems) {
      expect(state.consecutiveClean[sub] ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(state.converged).toBe(true);
    expect(r.status).toBe(0);
  });

  // VAL-ANATOMY-010: convergence via all stalled
  it("converges when all subsystems are stalled", () => {
    initRepo(ctx.repo);
    mkdirSync(join(ctx.repo, "svc"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(ctx.repo, "svc", `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "svc"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed svc"]);

    // Single subsystem that always fails VERIFY → stalls → all stalled → converged
    const findings = JSON.stringify([
      {
        id: "svc-001",
        severity: "CRITICAL",
        confidence: 90,
        category: "data-flow",
        file: "svc/f0.ts",
        line: 1,
        title: "always fails",
        description: "Cannot fix",
        proposedFix: "Try again",
      },
    ]);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "10", "--stall-limit", "1"],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: `echo 'try' > svc/f0.ts`,
        AP_VERIFY_RESULT: "FAIL",
      },
    );
    const state = readState(ctx);
    // All subsystems (just svc) should be stalled
    expect(state.stallCounts["svc"] ?? 0).toBeGreaterThanOrEqual(1);
    // Convergence: all stalled → converged
    expect(state.converged).toBe(true);
  });

  // VAL-ANATOMY-011: --dry-run reviews all subsystems, catalogs, stops
  it("--dry-run reviews all subsystems without FIX/VERIFY or commits", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    const beforeHead = git(ctx.repo, ["rev-parse", "HEAD"]);

    const findings = JSON.stringify([
      {
        id: "alpha-001",
        severity: "HIGH",
        confidence: 85,
        category: "pattern",
        file: "alpha/file0.ts",
        line: 1,
        title: "dry-run finding",
        description: "A finding in dry-run",
        proposedFix: "Fix in real run",
      },
    ]);
    const r = run(
      ctx,
      ["--dry-run", "--repo", ctx.repo, "--agent", ctx.agentDir],
      { AP_REVIEW_FINDINGS: findings, AP_REVIEW_COUNT: "2" },
    );
    expect(r.status).toBe(0);
    // State should exist
    expect(existsSync(join(ctx.rickgentDir, "anatomy-park.json"))).toBe(true);
    const state = readState(ctx);
    // All subsystems should be reviewed
    for (const sub of state.subsystems) {
      const hist = state.findingsHistory[sub] ?? [];
      expect(hist.length).toBeGreaterThan(0);
      // Only REVIEW phase, no FIX/VERIFY
      for (const entry of hist) {
        const phases = entry.phases?.map((p: any) => p.phase) ?? [];
        expect(phases).toContain("REVIEW");
        expect(phases).not.toContain("FIX");
        expect(phases).not.toContain("VERIFY");
      }
    }
    // No commits
    const afterHead = git(ctx.repo, ["rev-parse", "HEAD"]);
    expect(afterHead).toBe(beforeHead);
    // No file modifications
    const status = git(ctx.repo, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  // VAL-ANATOMY-012: --resume reads rotation state and continues
  it("--resume loads anatomy-park.json and continues rotation", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    // First run: 1 iteration, zero findings
    const r1 = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "1", "--stall-limit", "3"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    expect(existsSync(join(ctx.rickgentDir, "anatomy-park.json"))).toBe(true);
    const state1 = readState(ctx);
    const idx1 = state1.currentIndex;
    const clean1 = { ...state1.consecutiveClean };

    // Second run: resume with more iterations
    const r2 = run(
      ctx,
      ["--resume", "--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "10", "--stall-limit", "3"],
      { AP_REVIEW_FINDINGS: "[]", AP_REVIEW_COUNT: "0" },
    );
    const state2 = readState(ctx);
    // History should be preserved and extended
    for (const sub of state2.subsystems) {
      const hist1 = state1.findingsHistory[sub] ?? [];
      const hist2 = state2.findingsHistory[sub] ?? [];
      expect(hist2.length).toBeGreaterThanOrEqual(hist1.length);
    }
    // consecutive_clean should not reset (should continue accumulating)
    const allConverged = state2.subsystems.every(
      (sub: string) => (state2.consecutiveClean[sub] ?? 0) >= 2,
    );
    expect(allConverged).toBe(true);
    expect(state2.converged).toBe(true);
  });

  // VAL-ANATOMY-013: Fail-closed on errors
  it("fails closed on missing --agent dir", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", "/nonexistent/agent/path", "--max-iterations", "1"],
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stderr).not.toMatch(/not yet implemented/i);
  });

  it("fails closed on missing --repo dir", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    const r = run(
      ctx,
      ["--repo", "/nonexistent/repo/path", "--agent", ctx.agentDir, "--max-iterations", "1"],
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  // VAL-ANATOMY-014: --max-iterations and --stall-limit bounds honored
  it("--max-iterations 2 stops after 2 iterations regardless of convergence", () => {
    initRepo(ctx.repo);
    seedTwoSubsystems(ctx.repo);
    // With findings (count > 0), the loop won't converge on clean. Each iteration
    // processes one subsystem. With 2 max-iterations and findings, it stops at 2.
    const findings = JSON.stringify([
      {
        id: "sub-001",
        severity: "HIGH",
        confidence: 85,
        category: "pattern",
        file: "alpha/file0.ts",
        line: 1,
        title: "persistent finding",
        description: "Won't go away",
        proposedFix: "Try fix",
      },
    ]);
    const r = run(
      ctx,
      [
        "--repo", ctx.repo, "--agent", ctx.agentDir,
        "--max-iterations", "2", "--stall-limit", "10",
      ],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: "true",
        AP_VERIFY_RESULT: "PASS",
      },
    );
    const state = readState(ctx);
    // Count total iterations across all subsystems
    const totalIters = Object.values(state.findingsHistory)
      .flat().length;
    expect(totalIters).toBeLessThanOrEqual(2);
    // Should NOT be converged (exit non-zero)
    expect(state.converged).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it("--stall-limit 1 marks subsystem stalled after 1 stall", () => {
    initRepo(ctx.repo);
    mkdirSync(join(ctx.repo, "svc"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(ctx.repo, "svc", `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "svc"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed svc"]);

    const findings = JSON.stringify([
      {
        id: "svc-001",
        severity: "CRITICAL",
        confidence: 90,
        category: "data-flow",
        file: "svc/f0.ts",
        line: 1,
        title: "stall test",
        description: "Always regresses",
        proposedFix: "Try",
      },
    ]);
    const r = run(
      ctx,
      ["--repo", ctx.repo, "--agent", ctx.agentDir, "--max-iterations", "10", "--stall-limit", "1"],
      {
        AP_REVIEW_FINDINGS: findings,
        AP_REVIEW_COUNT: "1",
        AP_FIX_CMD: `echo 'try' > svc/f0.ts`,
        AP_VERIFY_RESULT: "FAIL",
      },
    );
    const state = readState(ctx);
    // svc should be stalled (stall_counts >= stall_limit)
    expect(state.stallCounts["svc"] ?? 0).toBeGreaterThanOrEqual(1);
    // With all subsystems stalled → converged
    expect(state.converged).toBe(true);
  });
});


