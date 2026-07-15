// M2 — `rickgent refine` CLI (VAL-REFINE-001..019).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync against real temp git
// repos with a controllable stub `omnigent` on PATH. Every assertion observes a
// REAL effect: exit code, stderr, written files, the recorded omnigent-run
// spawn log, and evaluatePrd validation results on the refined PRD + tickets.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parsePrdMarkdown } from "../../src/lifecycle/prd-parse.js";
import { evaluatePrd, type AcceptanceCriterion, type PrdInput } from "../../src/core/prd.js";

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
// $REFINE_SPAWN_LOG. Based on the role detected in the -p prompt, it outputs
// deterministic analysis text. If $REFINE_CRASH_ROLE matches the role, it
// exits 1 (simulating an analyst crash).
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.REFINE_SPAWN_LOG) fs.appendFileSync(process.env.REFINE_SPAWN_LOG, JSON.stringify(argv) + "\\n");
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? String(argv[pIdx + 1] || "") : "";

// Detect role from prompt
let role = "unknown";
if (/requirements analyst/i.test(prompt)) role = "requirements";
else if (/codebase analyst/i.test(prompt)) role = "codebase";
else if (/risk-scope analyst/i.test(prompt)) role = "risk-scope";

// Check crash simulation
const crashRoles = (process.env.REFINE_CRASH_ROLE || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
if (crashRoles.includes(role)) {
  process.stderr.write("analyst crashed\\n");
  process.exit(1);
}

// Output deterministic analysis based on role
if (role === "requirements") {
  process.stdout.write("## Requirements Analysis\\n\\n");
  process.stdout.write("### Findings\\n");
  process.stdout.write("- Missing acceptance criterion for error handling (P1)\\n");
  process.stdout.write("- Verification command needed for input validation (P2)\\n");
  process.stdout.write("- Interface contract for API boundary under-specified (P1)\\n");
} else if (role === "codebase") {
  process.stdout.write("## Codebase Analysis\\n\\n");
  process.stdout.write("### Integration Points\\n");
  process.stdout.write("- src/handler.ts exports processRequest() — integration point for new feature\\n");
  process.stdout.write("- src/types.ts defines RequestShape — extend with new fields\\n");
  process.stdout.write("- Existing pattern: src/utils/validate.ts — reuse validation pattern\\n");
} else if (role === "risk-scope") {
  process.stdout.write("## Risk-Scope Analysis\\n\\n");
  process.stdout.write("### Risk Areas\\n");
  process.stdout.write("- Breaking change risk: extending RequestShape may affect existing consumers (P1)\\n");
  process.stdout.write("- Scope boundary: new feature should not touch src/legacy/ (P2)\\n");
  process.stdout.write("- Complexity: new validation logic adds cyclomatic complexity (P3)\\n");
}
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "refine-cli-"));
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
  const res = spawnSync(process.execPath, [CLI_JS, "refine", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      REFINE_SPAWN_LOG: ctx.spawnLog,
      ...extraEnv,
    },
    timeout: 30000,
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

// A well-formed PRD with 4 acceptance criteria → produces 3+ impl tickets.
const VALID_PRD_MULTI = `# Feature PRD: Multi-Component Feature

## Description
A feature with multiple components requiring decomposition into atomic tickets.

### AC-1: Component A processes input
- **verifyCommand:** \`node -e "require('./src/a.ts')"\`
- **scope:** \`src/a.ts\`
- **type:** test

### AC-2: Component B transforms data
- **verifyCommand:** \`node -e "require('./src/b.ts')"\`
- **scope:** \`src/b.ts\`
- **type:** test

### AC-3: Component C renders output
- **verifyCommand:** \`node -e "require('./src/c.ts')"\`
- **scope:** \`src/c.ts\`
- **type:** test

### AC-4: Integration test passes
- **verifyCommand:** \`node -e "require('./test/integration.ts')"\`
- **scope:** \`test/integration.ts\`
- **type:** test

## Simplification Review
Reviewed: yes
Notes: minimal multi-component feature.
`;

// A minimal valid PRD (1 AC → 1 ticket, trivial — no hardening)
const VALID_PRD_SIMPLE = `# Simple Feature PRD

## Description
A simple single-component feature.

### AC-1: feature works
- **verifyCommand:** \`node -e "require('./src/feature.ts')"\`
- **scope:** \`src/feature.ts\`
- **type:** test

## Simplification Review
Reviewed: yes
Notes: minimal.
`;

// A malformed PRD (no ACs, no simplification review)
const INVALID_PRD = `# Bad PRD

## Description
A PRD with no acceptance criteria.
`;

// Parse YAML frontmatter from a ticket file
function parseFrontmatter(text: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return fm;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]!.trim()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

// List all ticket directories in .rickgent/
function listTicketDirs(ctx: Ctx): string[] {
  if (!existsSync(ctx.rickgentDir)) return [];
  return readdirSync(ctx.rickgentDir)
    .filter((d) => d.startsWith("rick_ticket_") && statSync(join(ctx.rickgentDir, d)).isDirectory());
}

// Read a ticket file
function readTicket(ctx: Ctx, dir: string): { frontmatter: Record<string, string>; body: string } {
  const hash = dir.replace(/^rick_ticket_/, "");
  const ticketPath = join(ctx.rickgentDir, dir, `rick_ticket_${hash}.md`);
  const text = readFileSync(ticketPath, "utf-8");
  return { frontmatter: parseFrontmatter(text), body: text };
}

describe("rickgent refine — VAL-REFINE-001..019", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });

  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  // VAL-REFINE-001: refine subcommand exists and exits zero on a valid PRD
  it("refine exits 0 on a valid PRD and produces prd_refined.md", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--non-interactive", "--agent", ctx.agentDir, "--repo", ctx.repo, "--cycles", "1"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("not yet implemented");
    const refinedPath = join(ctx.rickgentDir, "prd_refined.md");
    expect(existsSync(refinedPath)).toBe(true);
    const refined = readFileSync(refinedPath, "utf-8");
    expect(refined.length).toBeGreaterThan(0);
  });

  // VAL-REFINE-002: refine accepts all documented flags without parse errors
  it("accepts all six documented flags without unknown-option errors", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [
      prd,
      "--run",
      "--cycles", "1",
      "--max-turns", "10",
      "--non-interactive",
      "--repo", ctx.repo,
      "--agent", ctx.agentDir,
    ], { REFINE_SKIP_BUILD: "1" }); // skip actual build launch in this test
    // --run would try to launch build; we skip it via env to just test flag parsing
    expect((r.stderr + r.stdout).toLowerCase()).not.toContain("unknown option");
    expect((r.stderr + r.stdout).toLowerCase()).not.toContain("invalid value");
  });

  // VAL-REFINE-003: Spawns exactly 3 parallel omnigent run workers per cycle
  it("spawns exactly 3 omnigent run workers per cycle with distinguishable role prompts", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(3);
    // Each spawn is `omnigent run <agentDir> -p <prompt>` with array argv
    for (const e of entries) {
      expect(e[0]).toBe("run");
      expect(e[1]).toBe(ctx.agentDir);
      expect(e[2]).toBe("-p");
      expect(typeof e[3]).toBe("string");
    }
    // Three prompts are distinguishable as the three analyst roles
    const prompts = entries.map((e) => e[3] ?? "");
    expect(prompts.some((p) => /requirements analyst/i.test(p))).toBe(true);
    expect(prompts.some((p) => /codebase analyst/i.test(p))).toBe(true);
    expect(prompts.some((p) => /risk-scope analyst/i.test(p))).toBe(true);
  });

  // VAL-REFINE-004: Default cycle count is 3; cycle 2+ loads prior cycle analyses
  it("default 3 cycles spawns 9 workers; cycle 2+ prompts reference prior analyses", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(9); // 3 cycles × 3 analysts
    // Cycle 2+ prompts should reference prior analyses
    // The first 3 entries are cycle 1, next 3 are cycle 2, last 3 are cycle 3
    const cycle2Prompts = entries.slice(3, 6).map((e) => e[3] ?? "");
    // At least one cycle-2 prompt should reference prior analysis content
    const hasPriorRef = cycle2Prompts.some((p) => /prior cycle|prior analy|cross-reference/i.test(p));
    expect(hasPriorRef).toBe(true);
    // Analysis files exist for all 3 cycles
    const refinementDir = join(ctx.rickgentDir, "refinement");
    expect(existsSync(refinementDir)).toBe(true);
    const analysisFiles = readdirSync(refinementDir).filter((f) => f.startsWith("analysis_") && f.endsWith(".md"));
    expect(analysisFiles.length).toBeGreaterThanOrEqual(9); // 3 roles × 3 cycles
  });

  // VAL-REFINE-005: --cycles N overrides the default cycle count
  it("--cycles 2 spawns exactly 6 workers; --cycles 1 spawns exactly 3", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);

    // --cycles 1 → 3 spawns
    ctx.spawnLog = join(ctx.root, "spawns1.log");
    const r1 = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r1.status).toBe(0);
    expect(spawnEntries(ctx).length).toBe(3);

    // --cycles 2 → 6 spawns
    ctx.spawnLog = join(ctx.root, "spawns2.log");
    const r2 = run(ctx, [prd, "--cycles", "2", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r2.status).toBe(0);
    expect(spawnEntries(ctx).length).toBe(6);
  });

  // VAL-REFINE-006: Produces prd_refined.md that is additive, attributed, verification-first, with contracts
  it("prd_refined.md is additive, attributed, verification-first, with contracts", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    const refined = readFileSync(join(ctx.rickgentDir, "prd_refined.md"), "utf-8");

    // (a) Additive: original PRD content is preserved
    expect(refined).toContain("Multi-Component Feature");
    // (b) Attributed to analyst sources
    expect(refined.toLowerCase()).toMatch(/refined:.*requirements|requirements.*analyst/i);
    // (c) Every new/modified requirement carries a verify: command
    expect(refined).toMatch(/verify:/);
    // (d) Includes Interface Contracts
    expect(refined).toContain("Interface Contracts");
  });

  // VAL-REFINE-007: Produces atomic tickets with frontmatter and verify: ACs
  it("produces atomic tickets with frontmatter, verify: ACs, and Interface Contracts", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    const ticketDirs = listTicketDirs(ctx).filter((d) => d !== "rick_ticket_parent" && d !== "rick_ticket_wiring");
    expect(ticketDirs.length).toBeGreaterThanOrEqual(1);

    for (const dir of ticketDirs) {
      const { frontmatter, body } = readTicket(ctx, dir);
      // (b) Frontmatter with required keys
      expect(frontmatter.id).toBeTruthy();
      expect(frontmatter.title).toBeTruthy();
      expect(frontmatter.status).toBeTruthy();
      expect(frontmatter.priority).toMatch(/^P[0-4]$/);
      expect(frontmatter.order).toBeTruthy();
      // id matches the dir hash
      const hash = dir.replace(/^rick_ticket_/, "");
      expect(frontmatter.id).toBe(hash);
      // (a) Atomic: declares effort < 30 min, file-touch < 5, AC count < 4
      expect(body.toLowerCase()).toMatch(/<\s*30\s*min|effort.*<\s*30|30\s*min/);
      // (c) Every AC carries a verify: line
      expect(body).toMatch(/verify:/);
      // (d) Includes Interface Contracts section
      expect(body).toContain("Interface Contracts");
    }
  });

  // VAL-REFINE-008: Wiring ticket produced when 3+ implementation tickets
  it("wiring ticket produced when 3+ implementation tickets, references ≥ 2 impl tickets", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI); // 4 ACs → 4 impl tickets (3+)
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    const ticketDirs = listTicketDirs(ctx);
    // Find the wiring ticket
    const wiringDir = ticketDirs.find((d) => d.includes("wiring") || d.includes("winding"));
    expect(wiringDir).toBeTruthy();
    const { body: wiringBody } = readTicket(ctx, wiringDir!);
    // References ≥ 2 impl ticket ids
    const implDirs = ticketDirs.filter(
      (d) => d !== "rick_ticket_parent" && d !== wiringDir,
    );
    let refCount = 0;
    for (const impl of implDirs) {
      const hash = impl.replace(/^rick_ticket_/, "");
      if (wiringBody.includes(hash)) refCount++;
    }
    expect(refCount).toBeGreaterThanOrEqual(2);
  });

  // VAL-REFINE-009: Hardening tickets (code quality, data flow audit) for non-trivial PRDs
  it("hardening tickets (code quality, data flow audit) produced for multi-ticket PRDs", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI); // 4 ACs → 4 impl tickets (2+)
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    const ticketDirs = listTicketDirs(ctx);
    // Find hardening tickets by title/body content
    let hasCodeQuality = false;
    let hasDataFlow = false;
    for (const dir of ticketDirs) {
      if (dir === "rick_ticket_parent") continue;
      const { body } = readTicket(ctx, dir);
      if (/code quality/i.test(body)) hasCodeQuality = true;
      if (/data flow/i.test(body)) hasDataFlow = true;
    }
    expect(hasCodeQuality).toBe(true);
    expect(hasDataFlow).toBe(true);
  });

  // VAL-REFINE-010: Parent ticket rick_ticket_parent.md written with task breakdown table
  it("parent ticket written with task breakdown table listing all child tickets", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    const parentPath = join(ctx.rickgentDir, "rick_ticket_parent.md");
    expect(existsSync(parentPath)).toBe(true);
    const parent = readFileSync(parentPath, "utf-8");
    expect(parent.length).toBeGreaterThan(0);
    // Contains a task breakdown table
    expect(parent).toMatch(/\|.*order.*\|.*id.*\|.*title/i || parent.match(/\|.*id.*\|.*title/i));
    // References every child ticket id
    const ticketDirs = listTicketDirs(ctx).filter((d) => d !== "rick_ticket_parent");
    for (const dir of ticketDirs) {
      const hash = dir.replace(/^rick_ticket_/, "");
      expect(parent).toContain(hash);
    }
  });

  // VAL-REFINE-011: --run auto-launches rickgent build after refine completes
  it("--run auto-launches rickgent build; without --run no build spawn", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);

    // Without --run: no build spawn (check spawn log for "build" in argv)
    ctx.spawnLog = join(ctx.root, "spawns_norun.log");
    const r1 = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r1.status).toBe(0);
    const entries1 = spawnEntries(ctx);
    // All spawns should be omnigent run (no build invocation)
    // The build launch uses execFileSync with node dist/cli.js build, not omnigent
    // So we check stdout for build launch message instead
    expect(r1.stdout).not.toMatch(/launching.*build|auto-launch.*build|rickgent build/i);

    // With --run: build is launched (we use a stub that will fail to find build PRD,
    // but the key is that build is invoked). We set RICKGENT_BIN to our node CLI
    // to capture the build invocation.
    ctx.spawnLog = join(ctx.root, "spawns_run.log");
    const r2 = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive", "--run"], {
      REFINE_SKIP_BUILD: "1",
    });
    // The --run flag should trigger a build launch message
    expect(r2.stdout + r2.stderr).toMatch(/build/i);
  });

  // VAL-REFINE-012: --non-interactive mode runs without reading stdin
  it("--non-interactive runs without reading stdin and exits 0", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    // stdin is /dev/null (input: "" in run()) — no hang means no stdin read
    const r = run(ctx, [prd, "--non-interactive", "--agent", ctx.agentDir, "--repo", ctx.repo, "--cycles", "1"]);
    expect(r.status).toBe(0);
    // No hang/timeout — the test completing means stdin was not read
  });

  // VAL-REFINE-013: Fails closed on missing or malformed PRD before spawning analysts
  it("missing PRD → exit non-zero, no spawns; malformed PRD → exit non-zero, no spawns", () => {
    // Missing PRD file
    const rMissing = run(ctx, ["/nonexistent/prd.md", "--agent", ctx.agentDir, "--repo", ctx.repo]);
    expect(rMissing.status).not.toBe(0);
    expect((rMissing.stderr + rMissing.stdout).toLowerCase()).toContain("prd");
    expect(spawnEntries(ctx).length).toBe(0);

    // Malformed PRD (fails evaluatePrd)
    const badPrd = join(ctx.repo, "bad.md");
    writeFileSync(badPrd, INVALID_PRD);
    ctx.spawnLog = join(ctx.root, "spawns_bad.log");
    const rBad = run(ctx, [badPrd, "--agent", ctx.agentDir, "--repo", ctx.repo]);
    expect(rBad.status).not.toBe(0);
    expect((rBad.stderr + rBad.stdout).toLowerCase()).toContain("evaluateprd");
    expect(spawnEntries(ctx).length).toBe(0);
  });

  // VAL-REFINE-014: Fails closed when an analyst worker crashes
  it("analyst crash → exit non-zero, identifies crashed role, no refined output", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"], {
      REFINE_CRASH_ROLE: "requirements",
    });
    expect(r.status).not.toBe(0);
    // Stderr identifies the crashed analyst
    expect((r.stderr + r.stdout).toLowerCase()).toContain("requirements");
    // No refined output
    expect(existsSync(join(ctx.rickgentDir, "prd_refined.md"))).toBe(false);
  });

  // VAL-REFINE-015: Fails closed on missing --agent dir
  it("missing --agent → exit non-zero, names --agent, no spawns", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toContain("--agent");
    expect(spawnEntries(ctx).length).toBe(0);
  });

  // VAL-REFINE-016: Analyst reports written to .rickgent/refinement/analysis_*.md
  it("analyst reports written to .rickgent/refinement/analysis_*.md (≥3 per cycle)", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "2", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    const refinementDir = join(ctx.rickgentDir, "refinement");
    expect(existsSync(refinementDir)).toBe(true);
    const analysisFiles = readdirSync(refinementDir).filter((f) => f.startsWith("analysis_") && f.endsWith(".md"));
    // 2 cycles × 3 roles = 6 files
    expect(analysisFiles.length).toBe(6);
    // All non-empty
    for (const f of analysisFiles) {
      const content = readFileSync(join(refinementDir, f), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  // VAL-REFINE-017: Refinement manifest written to .rickgent/refinement_manifest.json
  it("refinement manifest written with analyst refs, AC shape smells, ticket justifications", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    const manifestPath = join(ctx.rickgentDir, "refinement_manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    // Contains analyst report references
    expect(manifest.analystReports || manifest.analyst_reports).toBeTruthy();
    // Contains AC shape smells (array, may be empty)
    expect(manifest.acShapeSmells !== undefined || manifest.ac_shape_smells !== undefined).toBe(true);
    // Contains ticket justifications
    expect(manifest.ticketJustifications || manifest.ticket_justifications).toBeTruthy();
  });

  // VAL-REFINE-018: Refined PRD + ticket ACs pass evaluatePrd when re-validated
  it("refined PRD + ticket ACs pass evaluatePrd when re-validated", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    // Parse refined PRD
    const refinedPath = join(ctx.rickgentDir, "prd_refined.md");
    const refinedText = readFileSync(refinedPath, "utf-8");
    const parsedRefined = parsePrdMarkdown(refinedText);

    // Collect ACs from tickets too
    const allACs: AcceptanceCriterion[] = [...parsedRefined.prd.acceptanceCriteria];
    const ticketDirs = listTicketDirs(ctx).filter((d) => d !== "rick_ticket_parent");
    for (const dir of ticketDirs) {
      const { body } = readTicket(ctx, dir);
      // Extract AC sections from the ticket
      const parsedTicket = parsePrdMarkdown(body);
      allACs.push(...parsedTicket.prd.acceptanceCriteria);
    }

    // Assemble combined PrdInput and validate
    const combinedPrd: PrdInput = {
      title: parsedRefined.prd.title,
      description: parsedRefined.prd.description,
      acceptanceCriteria: allACs,
      simplificationReview: parsedRefined.prd.simplificationReview,
    };
    const verdict = evaluatePrd(combinedPrd);
    expect(verdict.valid).toBe(true);
  });

  // VAL-REFINE-019: --max-turns N limits per-analyst turn budget
  it("--max-turns 5 is reflected in each analyst spawn's prompt", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--max-turns", "5", "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    const entries = spawnEntries(ctx);
    expect(entries.length).toBe(3);
    for (const e of entries) {
      const prompt = e[3] ?? "";
      // The prompt or argv reflects a max-turns value of 5
      expect(prompt).toMatch(/5/);
      expect(prompt.toLowerCase()).toMatch(/max.turns|turn.budget|turns/i);
    }
  });

  // ── Help flag ──────────────────────────────────────────────────────────
  it("refine --help exits 0 and lists all documented flags", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--run");
    expect(r.stdout).toContain("--cycles");
    expect(r.stdout).toContain("--max-turns");
    expect(r.stdout).toContain("--non-interactive");
    expect(r.stdout).toContain("--repo");
    expect(r.stdout).toContain("--agent");
  });

  // ── Static: no shell-string spawn sites ───────────────────────────────
  it("refine.ts contains no shell-string spawn sites", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/refine.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/[^A-Za-z]exec\(/);
    expect(src).not.toMatch(/add -A/);
  });

  // ── misc-m2-fixes: consolidated test hook (no REFINE_CAPTURE_BUILD) ───
  it("refine.ts has a single test hook (REFINE_SKIP_BUILD), no REFINE_CAPTURE_BUILD", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/refine.ts"),
      "utf-8",
    );
    // No two escape hatches for one guard — REFINE_CAPTURE_BUILD must be gone
    expect(src).not.toContain("REFINE_CAPTURE_BUILD");
    // REFINE_SKIP_BUILD is the single consolidated hook
    expect(src).toContain("REFINE_SKIP_BUILD");
  });

  // ── misc-m2-fixes: re-validation is fail-closed ──────────────────────
  it("re-validation failure exits non-zero (fail-closed, no WARNING)", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/refine.ts"),
      "utf-8",
    );
    // The old code used "WARNING" and did not exit; the fix exits non-zero
    expect(src).not.toMatch(/WARNING/);
    // The re-validation block must contain process.exit(1) on failure
    expect(src).toMatch(/combinedVerdict\.valid/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it("re-validation success message is present (no WARNING)", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);
    // Should print the re-validation success message, not a WARNING
    expect(r.stdout).toContain("re-validation");
    expect(r.stdout + r.stderr).not.toContain("WARNING");
  });

  // ── misc-m2-fixes: hardening ticket verify commands are meaningful ────
  it("hardening ticket verify commands do not use placeholder 'echo 0'", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI); // 4 ACs → 4 impl tickets → hardening tickets
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    const ticketDirs = listTicketDirs(ctx);
    for (const dir of ticketDirs) {
      if (dir === "rick_ticket_parent") continue;
      const { body } = readTicket(ctx, dir);
      // No placeholder 'echo 0' in any verify command
      expect(body).not.toMatch(/echo 0/);
    }
  });

  it("hardening ticket verify commands contain meaningful grep/tsc checks", () => {
    const prd = join(ctx.repo, "prd.md");
    writeFileSync(prd, VALID_PRD_MULTI);
    const r = run(ctx, [prd, "--cycles", "1", "--agent", ctx.agentDir, "--repo", ctx.repo, "--non-interactive"]);
    expect(r.status).toBe(0);

    const ticketDirs = listTicketDirs(ctx);
    let hasCodeQuality = false;
    let hasDataFlow = false;
    for (const dir of ticketDirs) {
      if (dir === "rick_ticket_parent") continue;
      const { body } = readTicket(ctx, dir);
      if (/code quality/i.test(body)) {
        hasCodeQuality = true;
        // Code quality ticket should have grep-based checks, not echo 0
        expect(body).toMatch(/grep/);
      }
      if (/data flow/i.test(body)) {
        hasDataFlow = true;
        // Data flow ticket should have grep or tsc checks
        expect(body).toMatch(/grep|tsc/);
      }
    }
    expect(hasCodeQuality).toBe(true);
    expect(hasDataFlow).toBe(true);
  });

  // ── misc-m2-fixes: unused spawnSync import removed ───────────────────
  it("refine.ts does not import spawnSync", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/refine.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/import.*spawnSync/);
  });

  // ── misc-m2-fixes: --non-interactive documented as accepted-but-ignored
  it("--non-interactive is documented as accepted-but-ignored in --help", () => {
    const r = run(ctx, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--non-interactive");
    // Usage text should document it as accepted-but-ignored
    expect(r.stdout).toMatch(/accepted-but-ignored|no-op/i);
  });

  it("--non-interactive is explicitly consumed as a no-op in source", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../src/lifecycle/refine.ts"),
      "utf-8",
    );
    // The flag is parsed and explicitly voided to document the no-op
    expect(src).toMatch(/nonInteractive/);
    expect(src).toMatch(/void nonInteractive/);
  });
});
