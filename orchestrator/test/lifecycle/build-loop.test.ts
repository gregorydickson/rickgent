// B1 — build loop (VAL-BUILD-001..008).
//
// Drives the REAL `rickgent` CLI (dist/cli.js) against the deterministic fixture
// omnigent and observes REAL effects: canonical SQLite allocations, git
// nonterminal capture reports, and caller-workspace isolation. No fixture
// worker output can terminalize a ticket.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");

// Minimal valid multi-vendor roster for build-loop tests. After the M4 router
// wiring, the build path calls select_model before each dispatch; without a
// roster the router DENYs (ROSTER_EMPTY) and no dispatch spawns.
const TEST_ROSTER_JSON = JSON.stringify([
  { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: { cost_per_dispatch: 0.50 } },
  { harness: "codex", model: "openai/gpt-5-mini", vendor: "openai", tier: "cheap", pricing: { cost_per_dispatch: 0.04 } },
]);

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

function cleanupRunWorktrees(repo: string): void {
  if (!existsSync(repo)) return;
  const current = git(repo, ["rev-parse", "--show-toplevel"]);
  const lines = git(repo, ["worktree", "list", "--porcelain"]).split("\n");
  for (const line of lines) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length);
    if (worktree !== current) {
      try { git(repo, ["worktree", "remove", "--force", worktree]); } catch { /* test cleanup */ }
    }
  }
}

interface Dirs {
  root: string;
  repo: string;
  dataDir: string;
  rickgentDir: string;
  agentDir: string;
  ghLog: string;
}

function setupDirs(): Dirs {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-build-")));
  const repo = join(root, "repo");
  initGitRepo(repo);
  const dataDir = join(root, "data");
  const rickgentDir = join(root, ".rickgent");
  const agentDir = join(root, "agent");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, repo, dataDir, rickgentDir, agentDir, ghLog: join(root, "gh.log") };
}

function writeMultiPrd(dir: string, tickets: string[]): string {
  const acs = tickets
    .map((p, i) => {
      const verification = JSON.stringify([{
        id: `VERIFY-FILE-${i + 1}`,
        executable: "test",
        args: ["-f", p],
        cwd_class: "repository_root",
        env_allowlist: ["PATH"],
        timeout_ms: 30000,
        network: "deny",
        writable_outputs: [],
        expected_exit_codes: [0],
      }]);
      return `### AC-${i + 1}: criterion ${i + 1}\n- **interfaceIds:** \`[]\`\n- **verifications:** \`${verification}\`\n- **scope:** \`${p}\`\n- **type:** grep\n`;
    })
    .join("\n");
  const tk = tickets
    .map((p, i) => `### Ticket ${String(i + 1).padStart(2, "0")}: implement ${p}\n- **description:** create ${p}\n- **dependsOn:** \`[]\`\n- **scope:** \`${JSON.stringify([{ path: p, change_kind: "create", directory: false }])}\`\n- **interfaces:** \`[]\`\n- **acceptanceCriteria:** \`${JSON.stringify([`AC-${i + 1}`])}\`\n- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`\n`)
    .join("\n");
  const md = `# Multi PRD\n\n## Title: Multi Ticket Fixture\n\n## Description\nmulti ticket build fixture\n\n## Acceptance Criteria\n\n${acs}\n## Simplification Review\n- Reviewed: yes\n- Notes: minimal, one function per file\n\n## Tickets\n\n${tk}`;
  const p = join(dir, "prd.md");
  writeFileSync(p, md);
  return p;
}

interface CliOut {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], d: Dirs, extraEnv: Record<string, string> = {}): CliOut {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    RICKGENT_DIR: d.rickgentDir,
    OMNIGENT_DATA_DIR: d.dataDir,
    FIXTURE_MODE: "prompt",
    FIXTURE_TARGET_REPO: d.repo,
    FAKE_GH_LOG: d.ghLog,
    RICKGENT_MODEL_ROSTER: TEST_ROSTER_JSON,
    RICKGENT_COST_BUDGET_USD: "10.0",
    RICKGENT_ORPHAN_REAP: "off",
    ...extraEnv,
  };
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: "utf-8",
    env,
    cwd: d.repo,
    input: "", // non-interactive: closed stdin must not hang
    timeout: 90000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function summary(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((l) => l.startsWith("build:") && l.includes("planned=")) ??
    stdout.split("\n").find((l) => l.startsWith("pipeline:") && l.includes("planned="));
  const out: Record<string, string> = {};
  if (!line) return out;
  for (const m of line.matchAll(/(\w+)=([^\s]+)/g)) out[m[1]!] = m[2]!;
  return out;
}

function stateRows(repo: string, sql: string): Array<Record<string, unknown>> {
  const database = new DatabaseSync(join(repo, ".git", "rickgent", "state.sqlite3"), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

describe("B1 build loop", () => {
  let d: Dirs;
  beforeEach(() => {
    d = setupDirs();
  });
  afterEach(() => {
    cleanupRunWorktrees(d.repo);
    rmSync(d.root, { recursive: true, force: true });
  });

  // VAL-BUILD-001
  it("decomposes >=1 ticket and dispatches via a real Dispatcher path", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(5);
    const s = summary(out.stdout);
    expect(Number(s.planned)).toBeGreaterThanOrEqual(1);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);
    expect(out.stdout).toContain("implementation captured (nonterminal)");
    expect(stateRows(d.repo, "SELECT ticket_id, attempt_number, state FROM attempts"))
      .toEqual([expect.objectContaining({ ticket_id: "t01", attempt_number: 1, state: "planned" })]);
    expect(existsSync(join(d.rickgentDir, "dispatch-ledger.jsonl"))).toBe(false);
    expect(existsSync(join(d.rickgentDir, "locks"))).toBe(false);
  });

  // VAL-BUILD-002 is intentionally contracted in M1: fixture output is a
  // nonterminal capture and cannot reach legacy completion authority.
  it("captures implementation without producing completed or Done", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(5);
    const s = summary(out.stdout);
    expect(Number(s.captured)).toBe(1);
    expect(Number(s.done)).toBe(0);
    expect(existsSync(join(d.rickgentDir, "registry.json"))).toBe(false);
    expect(existsSync(join(d.rickgentDir, "dispatch-ledger.jsonl"))).toBe(false);
    expect(stateRows(d.repo, "SELECT state, state_version FROM runs"))
      .toEqual([expect.objectContaining({ state: "planned", state_version: 0 })]);
    expect(stateRows(d.repo, "SELECT state, state_version FROM run_tickets"))
      .toEqual([expect.objectContaining({ state: "planned", state_version: 0 })]);
    expect(stateRows(d.repo, "SELECT state, state_version FROM attempts"))
      .toEqual([expect.objectContaining({ state: "planned", state_version: 0 })]);
    expect(stateRows(d.repo, "SELECT transition_id FROM state_transitions")).toEqual([]);
  });

  // VAL-BUILD-003
  it("captures with zero human interventions and non-interactively", () => {
    const prd = writeMultiPrd(d.root, ["src/a.ts", "src/b.ts"]);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(5);
    const s = summary(out.stdout);
    expect(Number(s.interventions)).toBe(0);
    expect(existsSync(join(d.rickgentDir, "interventions.jsonl"))).toBe(false);
    // Non-interactive: no prompt / no "run this yourself" instruction emitted.
    expect(out.stdout).not.toMatch(/run this yourself|press enter|awaiting input|\? \(y\/n\)/i);
  });

  // VAL-BUILD-004
  it("delivery configuration fails at the unavailable capability boundary before allocation", () => {
    const out = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir, "--no-autonomous-pr"],
      d,
    );
    expect(out.status).toBe(3);
    expect(out.stderr).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
    const p = join(d.rickgentDir, "interventions.jsonl");
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(d.rickgentDir, "registry.json"))).toBe(false);
  });

  // VAL-BUILD-005
  it("finishes the nonterminal local profile without invoking delivery", () => {
    const callerHead = git(d.repo, ["rev-parse", "HEAD"]);
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(5);
    expect(git(d.repo, ["rev-parse", "HEAD"])).toBe(callerHead);
    expect(existsSync(d.ghLog)).toBe(false);
    expect(out.stdout).toContain("automatic delivery is structurally absent");
  });

  // VAL-BUILD-006
  it("pipeline fails at reconciliation authority before build or cleanup", () => {
    const spawnRecord = join(d.root, "pipeline-spawn.json");
    const out = runCli(
      ["pipeline", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir],
      d,
      { FIXTURE_SPAWN_RECORD: spawnRecord },
    );
    expect(out.status).toBe(3);
    expect(out.stderr).toContain("RICKGENT_RECONCILIATION_UNAVAILABLE");
    expect(out.stdout).not.toContain("cleanup: orphan-reaper");
    expect(out.stdout).not.toContain("cleanup: reconcile");
    expect(existsSync(spawnRecord)).toBe(false);
    expect(existsSync(join(d.rickgentDir, "runs.jsonl"))).toBe(false);
    expect(existsSync(join(d.rickgentDir, "registry.json"))).toBe(false);
  });

  // VAL-BUILD-007
  it("accounts for every planned ticket when all dispatches fail", () => {
    const prd = writeMultiPrd(d.root, ["src/a.ts", "src/b.ts"]);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir], d, {
      FIXTURE_FAIL_PATHS: "src/a.ts,src/b.ts",
    });
    // A scripted nonzero child cannot prove detached-descendant release. The
    // conservative M2 bridge retains ownership and gives cleanup precedence.
    expect(out.status).toBe(7);
    const s = summary(out.stdout);
    expect(Number(s.planned)).toBe(2);
    expect(Number(s.done)).toBe(0);
    expect(Number(s.failed)).toBe(2);
    expect(Number(s.captured) + Number(s.done) + Number(s.failed) + Number(s.recovered)).toBe(Number(s.planned));
    expect(out.stdout).toContain("zero_completion");
    expect(out.stdout).toContain("cleanup_failed");
  });

  // VAL-BUILD-008
  it("a ticket failure is absorbed by salvage/breaker and the run continues non-interactively", () => {
    const prd = writeMultiPrd(d.root, ["src/a.ts", "src/b.ts"]);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir], d, {
      FIXTURE_FAIL_PATHS: "src/b.ts",
    });
    expect(out.status).toBe(5); // queue drains, but aggregation fails closed
    const s = summary(out.stdout);
    expect(Number(s.failed)).toBe(1);
    expect(Number(s.interventions)).toBe(0); // failure is NOT a human intervention
    expect(out.stdout).toContain("FAILED");
    expect(existsSync(join(d.rickgentDir, "salvage-dispositions.jsonl"))).toBe(false);
    expect(existsSync(join(d.rickgentDir, "dispatch-ledger.jsonl"))).toBe(false);
    // Non-interactive: no prompt emitted.
    expect(out.stdout).not.toMatch(/run this yourself|press enter|awaiting input/i);
  });
});
