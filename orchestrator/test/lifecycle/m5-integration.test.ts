// M5 — Integration + end-to-end (VAL-INTEGR-001..012).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync. Covers:
//   001  All 7 commands appear in top-level --help
//   002  No command exits 1 with "not yet implemented"
//   003  cronenberg routes MEASURABLE_METRIC → microverse
//   004  cronenberg routes MULTI_STAGE → pipeline
//   005  cronenberg routes TICKET_COUNT >= 3 → build
//   006  cronenberg default → build
//   007  cronenberg followups append correctly (citadel, anatomy, szechuan)
//   008  cronenberg routing is deterministic (no LLM inside the matrix)
//   009  Commands either run in the fixture profile or fail at their contracted boundary
//   010  Admitted stages run; raw-metric Microverse is blocked before side effects
//   011  Cronenberg routes a task and propagates the selected child's capability denial
//   012  cronenberg --dry-run shows correct plan for varied inputs
//
// The test uses a combination of the shared fixture omnigent (for build-style
// dispatches that need DB-session + git-delta completion evidence) and an
// inline universal stub that dispatches based on prompt content for the
// review/loop commands (refine, szechuan, anatomy, microverse, prd interactive).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  chmodSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");

// ── Helpers ─────────────────────────────────────────────────────────────

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

// A well-formed strict PRD whose JSON bullets adapt to TicketContract.
const VALID_PRD = `# PRD: Example

## Title: Example Feature

## Description
Do a thing.

## Acceptance Criteria

### AC-1: health endpoint
- **interfaceIds:** \`[]\`
- **verifications:** \`[{"id":"VERIFY-HANDLER-01","executable":"test","args":["-f","src/handler.ts"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]\`
- **scope:** \`src/handler.ts\`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: minimal

## Tickets

### Ticket 01: implement src/handler.ts
- **description:** create src/handler.ts
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"src/handler.ts","change_kind":"create","directory":false}]\`
- **interfaces:** \`[]\`
- **acceptanceCriteria:** \`["AC-1"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`
`;

// A multi-ticket PRD for build with 3 tickets (triggers TICKET_COUNT >= 3).
const MULTI_TICKET_PRD = `# PRD: Multi Feature

## Title: Multi Feature

## Description
Multi-ticket build fixture.

## Acceptance Criteria

### AC-1: handler
- **interfaceIds:** \`[]\`
- **verifications:** \`[{"id":"VERIFY-HANDLER-01","executable":"test","args":["-f","src/handler.ts"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]\`
- **scope:** \`src/handler.ts\`
- **type:** grep

### AC-2: utils
- **interfaceIds:** \`[]\`
- **verifications:** \`[{"id":"VERIFY-UTILS-01","executable":"test","args":["-f","src/utils.ts"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]\`
- **scope:** \`src/utils.ts\`
- **type:** grep

### AC-3: types
- **interfaceIds:** \`[]\`
- **verifications:** \`[{"id":"VERIFY-TYPES-01","executable":"test","args":["-f","src/types.ts"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]\`
- **scope:** \`src/types.ts\`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: minimal

## Tickets

### Ticket 01: implement src/handler.ts
- **description:** create src/handler.ts
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"src/handler.ts","change_kind":"create","directory":false}]\`
- **interfaces:** \`[]\`
- **acceptanceCriteria:** \`["AC-1"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`

### Ticket 02: implement src/utils.ts
- **description:** create src/utils.ts
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"src/utils.ts","change_kind":"create","directory":false}]\`
- **interfaces:** \`[]\`
- **acceptanceCriteria:** \`["AC-2"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`

### Ticket 03: implement src/types.ts
- **description:** create src/types.ts
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"src/types.ts","change_kind":"create","directory":false}]\`
- **interfaces:** \`[]\`
- **acceptanceCriteria:** \`["AC-3"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`
`;

// Minimal valid model roster for build dispatch.
const TEST_ROSTER_JSON = JSON.stringify([
  { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: { cost_per_dispatch: 0.5 } },
  { harness: "codex", model: "openai/gpt-5-mini", vendor: "openai", tier: "cheap", pricing: { cost_per_dispatch: 0.04 } },
]);

// ── Universal inline stub omnigent ──────────────────────────────────────
//
// Dispatches based on -p prompt content. Handles all command patterns:
//   refine analyst  → role-specific analysis text
//   szechuan judge  → numeric violation count
//   szechuan worker → "worker done"
//   anatomy REVIEW  → JSON findings + numeric count
//   anatomy FIX     → "fix applied"
//   anatomy VERIFY  → "PASS"
//   microverse judge→ numeric score
//   microverse worker / build / prd interactive → "worker done"
//
// Records every invocation to $INT_SPAWN_LOG.
const UNIVERSAL_STUB = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.INT_SPAWN_LOG) fs.appendFileSync(process.env.INT_SPAWN_LOG, JSON.stringify(argv) + "\\n");
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? String(argv[pIdx + 1] || "") : "";

// Refine analyst roles
if (/requirements analyst/i.test(prompt)) {
  process.stdout.write("## Requirements Analysis\\n\\n");
  process.stdout.write("- Missing AC for error handling (P1)\\n");
  process.stdout.write("- Verification command needed for input validation (P2)\\n");
  process.exit(0);
}
if (/codebase analyst/i.test(prompt)) {
  process.stdout.write("## Codebase Analysis\\n\\n");
  process.stdout.write("- src/handler.ts exports processRequest()\\n");
  process.stdout.write("- Existing pattern: src/utils/validate.ts\\n");
  process.exit(0);
}
if (/risk-scope analyst/i.test(prompt)) {
  process.stdout.write("## Risk-Scope Analysis\\n\\n");
  process.stdout.write("- Breaking change risk (P1)\\n");
  process.stdout.write("- Scope boundary: avoid src/legacy/ (P2)\\n");
  process.exit(0);
}

// Szechuan violation judge (read-only)
if (/read-only.*Szechuan Sauce violation judge|Szechuan.*violation.*judge/i.test(prompt)) {
  process.stdout.write((process.env.INT_JUDGE_COUNT || "0") + "\\n");
  process.exit(0);
}

// Anatomy REVIEW (read-only)
if (/REVIEW/i.test(prompt) && /read-only|anatomy|trace.*data/i.test(prompt)) {
  process.stdout.write((process.env.INT_REVIEW_FINDINGS || "[]") + "\\n");
  process.stdout.write((process.env.INT_REVIEW_COUNT || "0") + "\\n");
  process.exit(0);
}

// Anatomy FIX
if (/FIX/i.test(prompt) && /anatomy|minimal edit|highest.*severity/i.test(prompt)) {
  process.stdout.write("fix applied\\n");
  process.exit(0);
}

// Anatomy VERIFY
if (/VERIFY/i.test(prompt) && /read-only|anatomy|combinatorial/i.test(prompt)) {
  process.stdout.write("PASS\\n");
  process.exit(0);
}

// Microverse judge (read-only evaluation)
if (/read-only evaluation judge/i.test(prompt)) {
  process.stdout.write((process.env.INT_JUDGE_SCORE || "5") + "\\n");
  process.exit(0);
}

// Default: worker done (microverse worker, prd interactive, szechuan worker)
process.stdout.write("worker done\\n");
process.exit(0);
`;

// ── Test context ────────────────────────────────────────────────────────

interface Ctx {
  root: string;
  repo: string;
  agentDir: string;
  binDir: string; // universal stub bin
  rickgentDir: string;
  dataDir: string;
  spawnLog: string;
}

function setup(): Ctx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "m5-int-")));
  const repo = join(root, "repo");
  const agentDir = AGENT_ROOT;
  const binDir = join(root, "bin");
  const rickgentDir = join(root, "rickgent");
  const dataDir = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rickgentDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true });
  const stubPath = join(binDir, "omnigent");
  writeFileSync(stubPath, UNIVERSAL_STUB);
  chmodSync(stubPath, 0o755);
  return { root, repo, agentDir, binDir, rickgentDir, dataDir, spawnLog: join(root, "spawns.log") };
}

/** Run a CLI command with the universal stub on PATH. */
function runStub(
  ctx: Ctx,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_JS, command, ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      OMNIGENT_DATA_DIR: ctx.dataDir,
      INT_SPAWN_LOG: ctx.spawnLog,
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run a CLI command with the shared fixture omnigent on PATH (for build). */
function runFixture(
  ctx: Ctx,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: "utf-8",
    input: "",
    cwd: ctx.repo,
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      OMNIGENT_DATA_DIR: ctx.dataDir,
      FIXTURE_MODE: "prompt",
      FIXTURE_TARGET_REPO: ctx.repo,
      RICKGENT_MODEL_ROSTER: TEST_ROSTER_JSON,
      RICKGENT_COST_BUDGET_USD: "10.0",
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function spawnCount(ctx: Ctx): number {
  if (!existsSync(ctx.spawnLog)) return 0;
  return readFileSync(ctx.spawnLog, "utf-8").split("\n").filter((l) => l.length > 0).length;
}

function clearSpawnLog(ctx: Ctx): void {
  if (existsSync(ctx.spawnLog)) {
    writeFileSync(ctx.spawnLog, "");
  }
}

function cleanupRunWorktrees(repo: string): void {
  if (!existsSync(repo)) return;
  const current = git(repo, ["rev-parse", "--show-toplevel"]);
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length);
    if (worktree !== current) {
      try { git(repo, ["worktree", "remove", "--force", worktree]); } catch { /* test cleanup */ }
    }
  }
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

// ════════════════════════════════════════════════════════════════════════
// VAL-INTEGR-001 & VAL-INTEGR-002: top-level --help + no stubs
// ════════════════════════════════════════════════════════════════════════

describe("M5 Integration — VAL-INTEGR-001..002: top-level help + no stubs", () => {
  const SEVEN_COMMANDS = ["prd", "refine", "build", "citadel", "szechuan", "anatomy", "microverse"];

  // VAL-INTEGR-001
  it("all 7 commands appear in top-level --help", () => {
    const res = spawnSync(process.execPath, [CLI_JS, "--help"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    for (const cmd of SEVEN_COMMANDS) {
      expect(res.stdout).toContain(cmd);
    }
  });

  // VAL-INTEGR-002
  it("no command exits 1 with 'not yet implemented'", () => {
    for (const cmd of SEVEN_COMMANDS) {
      const res = spawnSync(process.execPath, [CLI_JS, cmd, "--help"], { encoding: "utf-8" });
      expect(res.status).toBe(0);
      expect(res.stdout).not.toMatch(/not yet implemented/i);
      expect(res.stderr).not.toMatch(/not yet implemented/i);
    }
  });

  // VAL-INTEGR-002 (explicit stub-exit check for completeness)
  // The contract specifies `prd --non-interactive` (not --help) as the
  // invocation for prd. Verify the functional invocation does not emit the
  // stub message either. Other commands' functional invocations are covered
  // by VAL-INTEGR-009 below.
  it("prd --non-interactive does not emit stub message", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "m5-stub-"));
    const rgDir = join(tmpDir, "rickgent");
    mkdirSync(rgDir, { recursive: true });
    try {
      const res = spawnSync(process.execPath, [CLI_JS, "prd", "--non-interactive", "--output", join(tmpDir, "out.md")], {
        encoding: "utf-8",
        input: "",
        env: { ...process.env, RICKGENT_DIR: rgDir },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).not.toMatch(/not yet implemented/i);
      expect(res.stderr).not.toMatch(/not yet implemented/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// VAL-INTEGR-003..008: cronenberg routing
// ════════════════════════════════════════════════════════════════════════

describe("M5 Integration — cronenberg routing (VAL-INTEGR-003..008)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  function cron(args: string[], extraEnv: Record<string, string> = {}) {
    return runStub(ctx, "cronenberg", args, extraEnv);
  }

  // VAL-INTEGR-003
  it("routes MEASURABLE_METRIC → microverse", () => {
    const r = cron(["--dry-run", "--task", "optimize coverage to 90%", "--metric", "echo 5", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: microverse");
  });

  // VAL-INTEGR-004
  it("routes MULTI_STAGE → pipeline", () => {
    const r = cron(["--dry-run", "--task", "refine and build the export module", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: pipeline");
    // followups skipped for pipeline
    expect(followupsLine(r.stdout)).toBe("followups: []");
  });

  // VAL-INTEGR-005
  it("routes TICKET_COUNT >= 3 → build", () => {
    const r = cron(["--dry-run", "--task", "add login, add logout, and build a dashboard", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
  });

  // VAL-INTEGR-006
  it("default (no matching signal) → build", () => {
    const r = cron(["--dry-run", "--task", "fix a typo in the header", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
  });

  // VAL-INTEGR-007
  it("followups append correctly: citadel, anatomy, szechuan", () => {
    // CITADEL_RISK → citadel (needs PRD + ticket count or conformance keyword)
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    // Make a 600-LOC diff so szechuan triggers too
    writeFileSync(join(ctx.repo, "README.md"), Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const r = cron([
      "--dry-run",
      "--task",
      "audit against PRD conformance in auth/ and billing/ modules",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(metaphorLine(r.stdout)).toBe("metaphor: build");
    expect(followupsLine(r.stdout)).toContain("citadel");
    expect(followupsLine(r.stdout)).toContain("anatomy");
    expect(followupsLine(r.stdout)).toContain("szechuan");
  });

  // VAL-INTEGR-007: --no-followups suppresses all
  it("--no-followups suppresses every followup", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = cron([
      "--dry-run",
      "--no-followups",
      "--task",
      "audit against PRD conformance in auth/ and billing/ modules",
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(followupsLine(r.stdout)).toBe("followups: []");
  });

  // VAL-INTEGR-008: deterministic — no omnigent spawn
  it("routing is deterministic — zero omnigent spawns during --dry-run", () => {
    clearSpawnLog(ctx);
    const r = cron(["--dry-run", "--task", "optimize coverage to 90%", "--metric", "echo 5", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(spawnCount(ctx)).toBe(0);
  });

  // VAL-INTEGR-008: same inputs → same output
  it("same inputs produce byte-identical plan", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const args = ["--dry-run", "--task", "add login, add logout, and build dashboard", "--repo", ctx.repo];
    const r1 = cron(args);
    const r2 = cron(args);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
  });
});

// ════════════════════════════════════════════════════════════════════════
// VAL-INTEGR-012: cronenberg --dry-run plan matrix
// ════════════════════════════════════════════════════════════════════════

describe("M5 Integration — cronenberg --dry-run plan matrix (VAL-INTEGR-012)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  function cron(args: string[]): { status: number | null; stdout: string; stderr: string } {
    return runStub(ctx, "cronenberg", args);
  }

  type MatrixCase = {
    name: string;
    task: string;
    extraArgs?: string[];
    setupRepo?: (repo: string) => void;
    expectedMetaphor: string;
    expectedFollowups?: string[]; // labels that must appear
    notFollowups?: string[]; // labels that must NOT appear
  };

  const cases: MatrixCase[] = [
    {
      name: "metric-only → microverse, no followups",
      task: "optimize latency",
      extraArgs: ["--metric", "echo 1"],
      expectedMetaphor: "microverse",
      expectedFollowups: [],
      notFollowups: ["citadel", "anatomy", "szechuan"],
    },
    {
      name: "multi-stage → pipeline, no followups",
      task: "refine and build the export module",
      expectedMetaphor: "pipeline",
      expectedFollowups: [],
      notFollowups: ["citadel", "anatomy", "szechuan"],
    },
    {
      name: "ticket-count-3 → build",
      task: "add login, add logout, and build a dashboard",
      expectedMetaphor: "build",
    },
    {
      name: "default (no signal) → build, no followups",
      task: "fix a typo",
      expectedMetaphor: "build",
      notFollowups: ["citadel", "anatomy", "szechuan"],
    },
    {
      name: "citadel-risk → build + citadel followup",
      task: "audit against PRD conformance",
      setupRepo: (repo) => writeFileSync(join(repo, "prd.md"), VALID_PRD),
      expectedMetaphor: "build",
      expectedFollowups: ["citadel"],
      notFollowups: ["anatomy", "szechuan"],
    },
    {
      name: "multi-subsystem → build + anatomy followup",
      task: "review auth/ and billing/ modules",
      expectedMetaphor: "build",
      expectedFollowups: ["anatomy"],
      notFollowups: ["citadel", "szechuan"],
    },
    {
      name: "large-diff → build + szechuan followup",
      task: "work on the thing",
      setupRepo: (repo) => {
        writeFileSync(join(repo, "README.md"), Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\n");
      },
      expectedMetaphor: "build",
      expectedFollowups: ["szechuan"],
      notFollowups: ["citadel", "anatomy"],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      if (c.setupRepo) c.setupRepo(ctx.repo);
      const args = ["--dry-run", "--task", c.task, "--repo", ctx.repo, ...(c.extraArgs ?? [])];
      const r = cron(args);
      expect(r.status).toBe(0);
      expect(metaphorLine(r.stdout)).toBe(`metaphor: ${c.expectedMetaphor}`);
      const fl = followupsLine(r.stdout);
      for (const f of c.expectedFollowups ?? []) {
        expect(fl).toContain(f);
      }
      for (const f of c.notFollowups ?? []) {
        expect(fl).not.toContain(f);
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// VAL-INTEGR-009: All commands work with fixture omnigent
// ════════════════════════════════════════════════════════════════════════

describe("M5 Integration — all commands work with fixture omnigent (VAL-INTEGR-009)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });
  afterEach(() => {
    cleanupRunWorktrees(ctx.repo);
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it("prd --non-interactive: emits template, no agent, exit 0", () => {
    const r = runStub(ctx, "prd", ["--non-interactive", "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "prd.md"))).toBe(true);
  });

  it("prd interactive: spawns omnigent, exit 0", () => {
    const r = runStub(ctx, "prd", ["--agent", ctx.agentDir, "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(spawnCount(ctx)).toBeGreaterThan(0);
  });

  it("refine: spawns 3 analysts, produces refined PRD, exit 0", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = runStub(ctx, "refine", [
      join(ctx.repo, "prd.md"),
      "--cycles",
      "1",
      "--non-interactive",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "prd_refined.md"))).toBe(true);
  });

  it("build: dispatches tickets via fixture omnigent and captures nonterminal work", () => {
    const prdPath = join(ctx.root, "build-prd.md");
    writeFileSync(prdPath, VALID_PRD);
    // Delivery flags remain absent; M1 may only capture nonterminal fixture work.
    const r = runFixture(ctx, ["build", prdPath, "--repo", ctx.repo, "--agent", ctx.agentDir]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(5);
    expect(r.stdout).toContain("captured=1 done=0");
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    // Build should produce a registry and dispatch ledger
    expect(existsSync(join(ctx.rickgentDir, "registry.json"))).toBe(true);
    expect(existsSync(join(ctx.rickgentDir, "dispatch-ledger.jsonl"))).toBe(true);
  });

  it("citadel: pure JS audit, no omnigent, exit 0", () => {
    const prdPath = join(ctx.repo, "prd.md");
    writeFileSync(prdPath, VALID_PRD);
    // Make a second commit so the default diff range HEAD~1..HEAD is valid
    writeFileSync(join(ctx.repo, "src", "app.ts"), "export const x = 1;\n");
    git(ctx.repo, ["add", "--", "src/app.ts"]);
    git(ctx.repo, ["commit", "-q", "-m", "add app"]);
    clearSpawnLog(ctx);
    const r = runStub(ctx, "citadel", ["--prd", prdPath, "--repo", ctx.repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    // citadel is pure JS — no omnigent spawns
    expect(spawnCount(ctx)).toBe(0);
  });

  it("szechuan: runs 1 iteration with judge, produces state, no spawn failure", () => {
    // Seed a source file with a violation
    writeFileSync(join(ctx.repo, "src", "app.ts"), "export function f() { console.log('debug'); }\n");
    git(ctx.repo, ["add", "--", "src/app.ts"]);
    git(ctx.repo, ["commit", "-q", "-m", "add app"]);
    const r = runStub(ctx, "szechuan", [
      "--repo",
      ctx.repo,
      "--agent",
      ctx.agentDir,
      "--max-iterations",
      "1",
      "--stall-limit",
      "2",
    ], { INT_JUDGE_COUNT: "0" });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
  });

  it("anatomy: runs 1 iteration with REVIEW, produces state, no spawn failure", () => {
    // Seed subsystems (alpha with 4 files qualifies)
    mkdirSync(join(ctx.repo, "alpha"), { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(ctx.repo, "alpha", `file${i}.ts`), `export const a${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "alpha"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed alpha"]);
    const r = runStub(ctx, "anatomy", [
      "--repo",
      ctx.repo,
      "--agent",
      ctx.agentDir,
      "--max-iterations",
      "2",
      "--stall-limit",
      "2",
    ], { INT_REVIEW_FINDINGS: "[]", INT_REVIEW_COUNT: "0" });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "anatomy-park.json"))).toBe(true);
  });

  it("microverse --metric: returns the raw-shell capability denial before spawn or state", () => {
    const headBefore = git(ctx.repo, ["rev-parse", "HEAD"]);
    const statusBefore = git(ctx.repo, ["status", "--porcelain"]);
    const r = runStub(ctx, "microverse", [
      "--metric",
      "echo 5",
      "--task",
      "optimize the thing",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--max-iterations",
      "1",
      "--non-interactive",
    ]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
    expect(r.stderr).toContain("RICKGENT_RAW_SHELL_UNAVAILABLE");
    expect(existsSync(join(ctx.rickgentDir, "microverse.json"))).toBe(false);
    expect(spawnCount(ctx)).toBe(0);
    expect(git(ctx.repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(ctx.repo, ["status", "--porcelain"])).toBe(statusBefore);
  });
});

// ════════════════════════════════════════════════════════════════════════
// VAL-INTEGR-010: admitted chain stages run; raw-metric Microverse stays unavailable
// ════════════════════════════════════════════════════════════════════════

describe("M5 Integration — full pipeline chain (VAL-INTEGR-010)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });
  afterEach(() => {
    cleanupRunWorktrees(ctx.repo);
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it("runs admitted stages and stops the raw-metric stage at its capability boundary", () => {
    // ── Stage 1: prd → prd.md ──
    const prdRes = runStub(ctx, "prd", ["--non-interactive", "--repo", ctx.repo]);
    expect(prdRes.status).toBe(0);
    const prdPath = join(ctx.rickgentDir, "prd.md");
    expect(existsSync(prdPath)).toBe(true);
    expect(readFileSync(prdPath, "utf-8").length).toBeGreaterThan(0);

    // ── Stage 2: refine → prd_refined.md + tickets ──
    // Use a PRD with content that refine can process
    writeFileSync(prdPath, VALID_PRD);
    const refineRes = runStub(ctx, "refine", [
      prdPath,
      "--cycles",
      "1",
      "--non-interactive",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
    ]);
    expect(refineRes.status).toBe(0);
    expect(existsSync(join(ctx.rickgentDir, "prd_refined.md"))).toBe(true);
    // Tickets: parent ticket or ticket dirs
    const hasTickets =
      existsSync(join(ctx.rickgentDir, "rick_ticket_parent.md")) ||
      readdirSync(ctx.rickgentDir).some((n) => /^rick_ticket_/.test(n));
    expect(hasTickets).toBe(true);

    // ── Stage 3: build → registry.json + dispatch-ledger.jsonl ──
    // Build needs a PRD with tickets and declaredPaths. Use the original PRD
    // which has the right format. Use the shared fixture omnigent for dispatch.
    const buildPrd = prdPath;
    writeFileSync(buildPrd, VALID_PRD);
    const buildRes = runFixture(ctx, ["build", buildPrd, "--repo", ctx.repo, "--agent", ctx.agentDir]);
    expect(buildRes.status).toBe(5);
    expect(buildRes.stdout).toContain("captured=1 done=0");
    expect(buildRes.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "registry.json"))).toBe(true);
    expect(existsSync(join(ctx.rickgentDir, "dispatch-ledger.jsonl"))).toBe(true);

    // ── Stage 4: citadel → citadel_report.json ──
    // Capture no longer creates a caller-repository commit. Seed a second
    // caller commit so Citadel's historical HEAD~1 comparison remains valid.
    mkdirSync(join(ctx.repo, "src"), { recursive: true });
    writeFileSync(join(ctx.repo, "src", "audit-seed.ts"), "export const auditSeed = 1;\n");
    git(ctx.repo, ["add", "--", "src/audit-seed.ts"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed citadel comparison"]);
    const citadelRes = runStub(ctx, "citadel", ["--prd", buildPrd, "--repo", ctx.repo, "--report", join(ctx.rickgentDir, "citadel_report.json")]);
    expect(citadelRes.status).toBe(0);
    expect(existsSync(join(ctx.rickgentDir, "citadel_report.json"))).toBe(true);

    // ── Stage 5: szechuan → szechuan.json + gap_analysis.md ──
    // Seed a source file for szechuan to review
    writeFileSync(join(ctx.repo, "src", "app.ts"), "export function f() { console.log('debug'); }\n");
    git(ctx.repo, ["add", "--", "src/app.ts"]);
    git(ctx.repo, ["commit", "-q", "-m", "add app for szechuan"]);
    const szechuanRes = runStub(ctx, "szechuan", [
      "--repo",
      ctx.repo,
      "--agent",
      ctx.agentDir,
      "--max-iterations",
      "1",
      "--stall-limit",
      "2",
    ], { INT_JUDGE_COUNT: "0" });
    expect(szechuanRes.status).toBe(0);
    expect(szechuanRes.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "szechuan.json"))).toBe(true);
    expect(existsSync(join(ctx.rickgentDir, "gap_analysis.md"))).toBe(true);

    // ── Stage 6: anatomy → anatomy-park.json ──
    // Seed subsystems
    mkdirSync(join(ctx.repo, "alpha"), { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(ctx.repo, "alpha", `file${i}.ts`), `export const a${i} = ${i};\n`);
    }
    git(ctx.repo, ["add", "--", "alpha"]);
    git(ctx.repo, ["commit", "-q", "-m", "seed alpha for anatomy"]);
    const anatomyRes = runStub(ctx, "anatomy", [
      "--repo",
      ctx.repo,
      "--agent",
      ctx.agentDir,
      "--max-iterations",
      "2",
      "--stall-limit",
      "2",
    ], { INT_REVIEW_FINDINGS: "[]", INT_REVIEW_COUNT: "0" });
    expect(anatomyRes.status).toBe(0);
    expect(anatomyRes.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    expect(existsSync(join(ctx.rickgentDir, "anatomy-park.json"))).toBe(true);

    // ── Stage 7: raw-metric microverse is unavailable in the M1 profile ──
    const spawnsBeforeMicroverse = spawnCount(ctx);
    const headBeforeMicroverse = git(ctx.repo, ["rev-parse", "HEAD"]);
    const statusBeforeMicroverse = git(ctx.repo, ["status", "--porcelain"]);
    const microverseRes = runStub(ctx, "microverse", [
      "--metric",
      "echo 5",
      "--task",
      "optimize the thing",
      "--agent",
      ctx.agentDir,
      "--repo",
      ctx.repo,
      "--owned-paths",
      "src",
      "--max-iterations",
      "1",
      "--non-interactive",
    ]);
    expect(microverseRes.status).toBe(3);
    expect(microverseRes.stderr).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
    expect(microverseRes.stderr).toContain("RICKGENT_RAW_SHELL_UNAVAILABLE");
    expect(existsSync(join(ctx.rickgentDir, "microverse.json"))).toBe(false);
    expect(spawnCount(ctx)).toBe(spawnsBeforeMicroverse);
    expect(git(ctx.repo, ["rev-parse", "HEAD"])).toBe(headBeforeMicroverse);
    expect(git(ctx.repo, ["status", "--porcelain"])).toBe(statusBeforeMicroverse);
  });
});

// ════════════════════════════════════════════════════════════════════════
// VAL-INTEGR-011: cronenberg end-to-end propagates selected child boundaries
// ════════════════════════════════════════════════════════════════════════

describe("M5 Integration — cronenberg end-to-end (VAL-INTEGR-011)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    initRepo(ctx.repo);
  });
  afterEach(() => {
    cleanupRunWorktrees(ctx.repo);
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it("non-dry-run surfaces the selected Microverse child's raw-shell denial", () => {
    const headBefore = git(ctx.repo, ["rev-parse", "HEAD"]);
    const statusBefore = git(ctx.repo, ["status", "--porcelain"]);
    const r = runStub(ctx, "cronenberg", [
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
      "--max-iterations",
      "1",
      "--non-interactive",
    ]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("metaphor: microverse");
    expect(r.stderr).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
    expect(r.stderr).toContain("RICKGENT_RAW_SHELL_UNAVAILABLE");
    expect(existsSync(join(ctx.rickgentDir, "microverse.json"))).toBe(false);
    expect(spawnCount(ctx)).toBe(0);
    expect(git(ctx.repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(ctx.repo, ["status", "--porcelain"])).toBe(statusBefore);
  });

  it("non-dry-run with build metaphor delegates to build", () => {
    // Use a 3-ticket task with a PRD on disk so cronenberg routes to build.
    const prdPath = join(ctx.repo, "prd.md");
    writeFileSync(prdPath, MULTI_TICKET_PRD);
    git(ctx.repo, ["add", "--", "prd.md"]);
    git(ctx.repo, ["commit", "-q", "-m", "add build contract"]);
    // Use the shared fixture omnigent for the build dispatch
    const r = runFixture(ctx, [
      "cronenberg",
      "--task",
      "add login, add logout, and build a dashboard",
      "--repo",
      ctx.repo,
      "--agent",
      ctx.agentDir,
      "--no-followups",
      "--no-refine",
    ], {
      RICKGENT_DIR: ctx.rickgentDir,
      INT_SPAWN_LOG: ctx.spawnLog,
    });
    expect(r.status).toBe(5);
    expect(r.stdout).toContain("metaphor: build");
    expect(r.stderr).not.toMatch(/omnigent not found|spawn.*fail/i);
    // The delegated build child produced a registry.
    expect(existsSync(join(ctx.rickgentDir, "registry.json"))).toBe(true);
  });
});
