// B3 — backpressure queue drains through the REAL build loop (VAL-QUEUE-001,
// 002, 005). Drives the actual `rickgent build` CLI against the deterministic
// fixture omnigent with 5 tickets and a 2-slot cap, then reads the durable
// dispatch ledger: every ticket drains past `planned`, the spawn order is FIFO,
// and a failing ticket's slot frees so the queue keeps draining.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../../dist/cli.js");
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
    .map((p, i) => `### AC-${i + 1}: criterion ${i + 1}\n- **verifyCommand:** \`grep -r x ${p}\`\n- **scope:** \`${p}\`\n- **type:** grep\n`)
    .join("\n");
  const tk = paths
    .map((p, i) => `### Ticket ${i + 1}: implement ${p}\n- **description:** create ${p}\n- **declaredPaths:** \`${p}\`\n`)
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

  // VAL-QUEUE-001 + VAL-QUEUE-002: all 5 tickets drain under a 2-slot cap, none
  // left 'planned', spawned in FIFO (enqueue) order.
  it("drains all 5 tickets under a 2-slot cap in FIFO order (none left planned)", () => {
    const prd = writeMultiPrd(d.root, FIVE);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir, "--max-concurrent", "2"], d);
    expect(out.status).toBe(0);

    const entries = ledgerEntries(d.rickgentDir);
    const tickets = ["T1", "T2", "T3", "T4", "T5"];

    // Every ticket was queued (planned recorded) AND spawned.
    for (const t of tickets) {
      expect(entries.some((e) => ticketOf(String(e.dispatchId)) === t && e.state === "planned")).toBe(true);
      expect(entries.some((e) => ticketOf(String(e.dispatchId)) === t && e.state === "spawned")).toBe(true);
    }

    // No ticket is left stuck: its latest state is beyond 'planned'.
    const latest = latestStateByTicket(entries);
    for (const t of tickets) {
      expect(latest[t]).toBeDefined();
      expect(latest[t]).not.toBe("planned");
      expect(latest[t]).toBe("completed");
    }

    // FIFO: the first spawn of each ticket follows enqueue order T1..T5.
    const firstSpawnOrder: string[] = [];
    for (const e of entries) {
      if (e.state !== "spawned") continue;
      const t = ticketOf(String(e.dispatchId));
      if (!firstSpawnOrder.includes(t)) firstSpawnOrder.push(t);
    }
    expect(firstSpawnOrder).toEqual(tickets);
  });

  // VAL-QUEUE-005: a failing dispatch frees its slot and the queue keeps
  // draining — the other four still complete, none left permanently planned.
  it("a failing dispatch frees its slot and the queue keeps draining", () => {
    const prd = writeMultiPrd(d.root, FIVE);
    // T3 (src/c.ts) fails; its slot must free so T4/T5 still drain.
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir, "--max-concurrent", "2"], d, {
      FIXTURE_FAIL_PATHS: "src/c.ts",
    });
    expect(out.status).toBe(0);

    const entries = ledgerEntries(d.rickgentDir);
    const latest = latestStateByTicket(entries);
    // The failing ticket reached a terminal non-completed state.
    expect(latest["T3"]).not.toBe("completed");
    expect(latest["T3"]).not.toBe("planned");
    // The other four drained to completion despite the failure.
    for (const t of ["T1", "T2", "T4", "T5"]) {
      expect(latest[t]).toBe("completed");
    }
    // Ledger shows the failing slot freed and later tickets spawned after it.
    expect(entries.some((e) => ticketOf(String(e.dispatchId)) === "T5" && e.state === "spawned")).toBe(true);
  });
});
