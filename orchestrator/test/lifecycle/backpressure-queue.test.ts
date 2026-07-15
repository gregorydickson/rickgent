// M1 sequential queue coverage through the REAL build loop. Parallel dispatch
// is unavailable: maxConcurrent must be exactly one and every admitted spawn
// remains FIFO.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");

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

interface Dirs {
  root: string;
  repo: string;
  dataDir: string;
  rickgentDir: string;
  agentDir: string;
  ghLog: string;
}

function setupDirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), "rickgent-bp-"));
  const repo = join(root, "repo");
  initGitRepo(repo);
  const dataDir = join(root, "data");
  const rickgentDir = join(root, ".rickgent");
  const agentDir = join(root, "agent");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, repo, dataDir, rickgentDir, agentDir, ghLog: join(root, "gh.log") };
}

function writeMultiPrd(dir: string, paths: string[]): string {
  const acs = paths
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
  const tk = paths
    .map((p, i) => `### Ticket ${String(i + 1).padStart(2, "0")}: implement ${p}\n- **description:** create ${p}\n- **dependsOn:** \`[]\`\n- **scope:** \`${JSON.stringify([{ path: p, change_kind: "create", directory: false }])}\`\n- **interfaces:** \`[]\`\n- **acceptanceCriteria:** \`${JSON.stringify([`AC-${i + 1}`])}\`\n- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`\n`)
    .join("\n");
  const md = `# Multi PRD\n\n## Title: Backpressure Fixture\n\n## Description\nfive ticket backpressure fixture\n\n## Acceptance Criteria\n\n${acs}\n## Simplification Review\n- Reviewed: yes\n- Notes: minimal, one function per file\n\n## Tickets\n\n${tk}`;
  const p = join(dir, "prd.md");
  writeFileSync(p, md);
  return p;
}

function runCli(args: string[], d: Dirs, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    RICKGENT_DIR: d.rickgentDir,
    OMNIGENT_DATA_DIR: d.dataDir,
    FIXTURE_MODE: "prompt",
    FIXTURE_TARGET_REPO: d.repo,
    FAKE_GH_LOG: d.ghLog,
    RICKGENT_MODEL_ROSTER: JSON.stringify([
      { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: { cost_per_dispatch: 0.50 } },
      { harness: "codex", model: "openai/gpt-5-mini", vendor: "openai", tier: "cheap", pricing: { cost_per_dispatch: 0.04 } },
    ]),
    RICKGENT_COST_BUDGET_USD: "10.0",
    ...extraEnv,
  };
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: "utf-8",
    env,
    cwd: d.repo,
    input: "",
    timeout: 90000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ledgerEntries(rickgentDir: string): Array<Record<string, unknown>> {
  const p = join(rickgentDir, "dispatch-ledger.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function ticketOf(dispatchId: string): string {
  return dispatchId.split("/")[1] ?? "";
}

/** Latest ledger state for each ticketId, in ledger (append) order. */
function latestStateByTicket(entries: Array<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) out[ticketOf(String(e.dispatchId))] = String(e.state);
  return out;
}

describe("B3 backpressure queue via the real build loop", () => {
  let d: Dirs;
  beforeEach(() => {
    d = setupDirs();
  });
  afterEach(() => {
    rmSync(d.root, { recursive: true, force: true });
  });

  const FIVE = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];

  it("drains admitted work sequentially in FIFO order", () => {
    const prd = writeMultiPrd(d.root, FIVE);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir, "--max-concurrent", "1"], d);
    expect(out.status).toBe(5);

    const entries = ledgerEntries(d.rickgentDir);
    const tickets = ["t01", "t02", "t03", "t04", "t05"];

    // Every ticket was durably queued. Only the first can spawn: its retained
    // nonterminal delta makes the run-level worktree dirty, so later workers
    // fail closed before spawn until per-attempt ownership lands.
    for (const t of tickets) {
      expect(entries.some((e) => ticketOf(String(e.dispatchId)) === t && e.state === "planned")).toBe(true);
    }
    expect(entries.filter((entry) => entry.state === "spawned").map((entry) => ticketOf(String(entry.dispatchId)))).toEqual(["t01"]);

    // No ticket is left stuck: its latest state is beyond 'planned'.
    const latest = latestStateByTicket(entries);
    for (const t of tickets) {
      expect(latest[t]).toBeDefined();
      expect(latest[t]).not.toBe("planned");
      expect(latest[t]).not.toBe("completed");
    }

    // The only safe spawn is the FIFO head.
    const firstSpawnOrder: string[] = [];
    for (const e of entries) {
      if (e.state !== "spawned") continue;
      const t = ticketOf(String(e.dispatchId));
      if (!firstSpawnOrder.includes(t)) firstSpawnOrder.push(t);
    }
    expect(firstSpawnOrder).toEqual(["t01"]);
    expect(entries.filter((entry) => entry.state === "implementation_captured")).toHaveLength(1);
    expect(Object.values(latest).filter((state) => state === "failed")).toHaveLength(4);
  });

  it("rejects maxConcurrent greater than one before allocation or spawn", () => {
    const prd = writeMultiPrd(d.root, FIVE);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir, "--max-concurrent", "2"], d, {
      FIXTURE_FAIL_PATHS: "src/c.ts",
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--max-concurrent must be exactly 1");
    expect(existsSync(join(d.rickgentDir, "dispatch-ledger.jsonl"))).toBe(false);
  });
});
