// M2 — `rickgent prd` CLI (VAL-PRD-001..009).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync against real temp git
// repos with a controllable stub `omnigent` on PATH. Every assertion observes a
// REAL effect: exit code, stderr, written files, the recorded omnigent-run
// spawn log, and evaluatePrd validation results on the emitted template.

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
import { parsePrdMarkdown } from "../../src/lifecycle/prd-parse.js";
import { evaluatePrd } from "../../src/core/prd.js";

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

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

// A controllable stub `omnigent`. It records every invocation's argv to
// $PRD_SPAWN_LOG and exits 0. Used to verify interactive-mode spawn behavior.
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.PRD_SPAWN_LOG) fs.appendFileSync(process.env.PRD_SPAWN_LOG, JSON.stringify(argv) + "\\n");
process.stdout.write("interview done\\n");
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "prd-cli-"));
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
  const res = spawnSync(process.execPath, [CLI_JS, "prd", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      PRD_SPAWN_LOG: ctx.spawnLog,
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

// A well-formed PRD that passes evaluatePrd.
const VALID_PRD = `# Test Feature PRD

## Description
A test feature.

### AC-1: feature works
- **verifyCommand:** \`node -e "require('./src/feature.ts')"\`
- **scope:** \`src/feature.ts\`
- **type:** test

## Simplification Review
Reviewed: yes
Notes: minimal.
`;

// A malformed PRD with no ACs and no simplification review.
const INVALID_PRD = `# Bad PRD

## Description
A PRD with no acceptance criteria.
`;

describe("rickgent prd — VAL-PRD-001..009", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });

  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  // VAL-PRD-001: prd subcommand exists and exits zero in non-interactive template mode
  it("prd --non-interactive exits 0", () => {
    const r = run(ctx, ["--non-interactive", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("not yet implemented");
  });

  // VAL-PRD-002: prd accepts all documented flags without parse errors
  it("accepts all five documented flags without unknown-option errors", () => {
    const validPrd = join(ctx.repo, "valid.md");
    writeFileSync(validPrd, VALID_PRD);
    const out = join(ctx.root, "out", "prd.md");
    const r = run(ctx, [
      "--non-interactive",
      "--repo", ctx.repo,
      "--agent", ctx.agentDir,
      "--output", out,
      "--from", validPrd,
    ]);
    expect(r.status).toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).not.toContain("unknown option");
    expect((r.stderr + r.stdout).toLowerCase()).not.toContain("invalid value");
  });

  // VAL-PRD-003: Interactive mode spawns a single omnigent run agent with array argv
  it("interactive mode spawns exactly one omnigent run with array argv", () => {
    const r = run(ctx, ["--repo", ctx.repo, "--agent", ctx.agentDir]);
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(1);
    const argv = entries[0]!;
    // The stub records process.argv.slice(2), so argv[0] is "run" (the stub
    // binary "omnigent" is the first spawnSync arg, proven by the stub being
    // on PATH). The full spawn was ["omnigent", "run", agentDir, "-p", prompt].
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe(ctx.agentDir);
    expect(argv[2]).toBe("-p");
    expect(typeof argv[3]).toBe("string");
    expect(argv[3]!.length).toBeGreaterThan(0);
  });

  // VAL-PRD-004: Non-interactive mode emits the PRD template without spawning an agent or reading stdin
  it("non-interactive emits template, no spawn, no stdin read, has all sections + verify: line", () => {
    const r = run(ctx, ["--non-interactive", "--agent", ctx.agentDir, "--repo", ctx.repo], {
      // stdin is /dev/null (input: "" in run()) — no hang means no stdin read
    });
    expect(r.status).toBe(0);
    // No omnigent run spawned
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(0);
    // Template written to default path
    const defaultPath = join(ctx.rickgentDir, "prd.md");
    expect(existsSync(defaultPath)).toBe(true);
    const text = readFileSync(defaultPath, "utf-8");
    // All required section headers present
    expect(text).toContain("Introduction");
    expect(text).toContain("Problem Statement");
    expect(text).toContain("Scope");
    expect(text).toContain("Functional Requirements");
    expect(text).toContain("Interface Contracts");
    expect(text).toContain("Acceptance Criteria");
    expect(text).toContain("Test Expectations");
    expect(text).toContain("Risks");
    // At least one verify: placeholder line
    expect(text).toMatch(/verify:\s/);
    // Verification column in functional requirements
    expect(text).toContain("Verification");
  });

  // VAL-PRD-005: --output writes to the specified path; default is .rickgent/prd.md
  it("--output writes to custom path; default is .rickgent/prd.md", () => {
    // Custom path
    const custom = join(ctx.root, "custom", "my-prd.md");
    const r1 = run(ctx, ["--non-interactive", "--output", custom, "--repo", ctx.repo]);
    expect(r1.status).toBe(0);
    expect(existsSync(custom)).toBe(true);
    const customContent = readFileSync(custom, "utf-8");
    expect(customContent.length).toBeGreaterThan(0);

    // Default path
    const r2 = run(ctx, ["--non-interactive", "--repo", ctx.repo]);
    expect(r2.status).toBe(0);
    const defaultPath = join(ctx.rickgentDir, "prd.md");
    expect(existsSync(defaultPath)).toBe(true);
    const defaultContent = readFileSync(defaultPath, "utf-8");
    expect(defaultContent.length).toBeGreaterThan(0);
  });

  // VAL-PRD-006: --from validates an existing PRD via evaluatePrd
  it("--from validates valid PRD → exit 0; invalid PRD → exit non-zero", () => {
    const validPrd = join(ctx.repo, "valid.md");
    writeFileSync(validPrd, VALID_PRD);
    const rValid = run(ctx, ["--non-interactive", "--from", validPrd, "--repo", ctx.repo]);
    expect(rValid.status).toBe(0);
    expect(rValid.stdout).toContain("evaluatePrd");

    const invalidPrd = join(ctx.repo, "invalid.md");
    writeFileSync(invalidPrd, INVALID_PRD);
    const rInvalid = run(ctx, ["--non-interactive", "--from", invalidPrd, "--repo", ctx.repo]);
    expect(rInvalid.status).not.toBe(0);
    expect((rInvalid.stderr + rInvalid.stdout).toLowerCase()).toContain("evaluateprd");
  });

  // VAL-PRD-007: Output PRD has machine-checkable ACs with verify: and passes evaluatePrd
  it("emitted template has ACs with verify: lines and passes evaluatePrd", () => {
    const out = join(ctx.root, "prd-out.md");
    const r = run(ctx, ["--non-interactive", "--output", out, "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    const text = readFileSync(out, "utf-8");
    // ≥1 AC block with verify: lines
    expect(text).toMatch(/### AC-\d/);
    expect(text).toMatch(/verify:\s/);
    // Parse and validate with the single PRD oracle
    const parsed = parsePrdMarkdown(text);
    expect(parsed.prd.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
    const verdict = evaluatePrd(parsed.prd);
    expect(verdict.valid).toBe(true);
  });

  // VAL-PRD-008: Fails closed when --agent is missing in interactive mode
  it("interactive mode without --agent exits non-zero, names --agent, no spawn", () => {
    const r = run(ctx, ["--repo", ctx.repo]);
    expect(r.status).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toContain("--agent");
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(0);
  });

  // VAL-PRD-009: Fails closed on missing repo or missing --from file
  it("missing repo → exit non-zero, no template; missing --from file → exit non-zero, no template", () => {
    // Missing repo
    const rRepo = run(ctx, ["--non-interactive", "--repo", "/nonexistent/path/xyz"]);
    expect(rRepo.status).not.toBe(0);
    expect((rRepo.stderr + rRepo.stdout).toLowerCase()).toContain("repo");
    // No template written to default path
    expect(existsSync(join(ctx.rickgentDir, "prd.md"))).toBe(false);

    // Missing --from file
    const rFrom = run(ctx, ["--non-interactive", "--from", "/nonexistent/prd.md", "--repo", ctx.repo]);
    expect(rFrom.status).not.toBe(0);
    expect((rFrom.stderr + rFrom.stdout).toLowerCase()).toContain("not found");
    // No template written
    expect(existsSync(join(ctx.rickgentDir, "prd.md"))).toBe(false);
    // No agent spawned
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(0);
  });

  // ── Help flag ──────────────────────────────────────────────────────────
  it("prd --help exits 0 and lists all documented flags", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--from");
    expect(r.stdout).toContain("--non-interactive");
    expect(r.stdout).toContain("--repo");
    expect(r.stdout).toContain("--agent");
    expect(r.stdout).toContain("--output");
  });

  // ── misc-m2-fixes: dead outDir variable removed ──────────────────────
  it("prd-interview.ts has no dead outDir variable", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/prd-interview.ts"),
      "utf-8",
    );
    // The dead outDir variable has been removed
    expect(src).not.toMatch(/const outDir/);
  });

  // ── misc-m2-fixes: path.dirname() used instead of regex ──────────────
  it("prd-interview.ts uses path.dirname() instead of regex-based dirname", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/prd-interview.ts"),
      "utf-8",
    );
    // dirname is imported from path
    expect(src).toMatch(/import.*dirname.*from.*["']path["']/);
    // No regex-based dirname pattern
    expect(src).not.toMatch(/\.replace\(\/\\\/\[\^\/\]\*/);
  });

  it("non-interactive template write works with nested --output path (dirname integration)", () => {
    // Verify path.dirname() works correctly for nested output paths
    const nested = join(ctx.root, "deep", "nested", "dir", "prd.md");
    const r = run(ctx, ["--non-interactive", "--output", nested, "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(existsSync(nested)).toBe(true);
    const content = readFileSync(nested, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });
});
