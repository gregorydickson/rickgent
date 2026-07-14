// B1 — build loop (VAL-BUILD-001..008).
//
// Drives the REAL `rickgent` CLI (dist/cli.js) against the deterministic fixture
// omnigent + a fixture `gh`, and observes REAL effects: the dispatch ledger, the
// registry, git branches/commits, the intervention ledger, the salvage-
// disposition ledger, and the captured `gh pr create` invocation. No mocks —
// every Done is the terminal `completed` state of a real Dispatcher path (only
// reachable through the completion oracle), failures are absorbed by
// salvage/breaker, and a human-gate hit exits non-zero + records an intervention.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../../dist/cli.js");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");

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
  const root = mkdtempSync(join(tmpdir(), "rickgent-build-"));
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
    .map((p, i) => `### AC-${i + 1}: criterion ${i + 1}\n- **verifyCommand:** \`grep -r x ${p}\`\n- **scope:** \`${p}\`\n- **type:** grep\n`)
    .join("\n");
  const tk = tickets
    .map((p, i) => `### Ticket ${i + 1}: implement ${p}\n- **description:** create ${p}\n- **declaredPaths:** \`${p}\`\n`)
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

function ledgerEntries(rickgentDir: string): Array<Record<string, unknown>> {
  const p = join(rickgentDir, "dispatch-ledger.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("B1 build loop", () => {
  let d: Dirs;
  beforeEach(() => {
    d = setupDirs();
  });
  afterEach(() => {
    rmSync(d.root, { recursive: true, force: true });
  });

  // VAL-BUILD-001
  it("decomposes >=1 ticket and dispatches via a real Dispatcher path", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(0);
    const s = summary(out.stdout);
    expect(Number(s.planned)).toBeGreaterThanOrEqual(1);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);
    const entries = ledgerEntries(d.rickgentDir);
    const spawned = entries.filter((e) => e.state === "spawned");
    expect(spawned.length).toBeGreaterThanOrEqual(1);
    // Ledger entries are Dispatcher-written (carry the trace dispatchId shape).
    expect(spawned.every((e) => typeof e.dispatchId === "string" && (e.dispatchId as string).includes("/T1/"))).toBe(true);
  });

  // VAL-BUILD-002 — positive routing: Done is the completed dispatch state,
  // which is only reachable through evaluateCompletion (dispatch.completion).
  it("every Done routes through evaluateCompletion (oracle-gated completed state)", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(0);
    const entries = ledgerEntries(d.rickgentDir);
    const completed = entries.filter((e) => e.state === "completed");
    expect(completed.length).toBeGreaterThanOrEqual(1);
    // Oracle evidence is present on every completed entry (proves the delta was
    // verified, not exit-code-only): a real commit sha + tree change.
    for (const c of completed) {
      expect(typeof c.commitSha).toBe("string");
      expect(c.treeChanged).toBe(true);
    }
    // The registry Done ticket carries that same oracle-verified commit.
    const reg = JSON.parse(readFileSync(join(d.rickgentDir, "registry.json"), "utf-8"));
    const done = Object.values(reg.tickets).filter((t: any) => t.status === "Done");
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const t of done as any[]) {
      expect(typeof t.completionCommitSha).toBe("string");
    }
  });

  // VAL-BUILD-003
  it("completes with zero human interventions and non-interactively", () => {
    const prd = writeMultiPrd(d.root, ["src/a.ts", "src/b.ts"]);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(0);
    const s = summary(out.stdout);
    expect(Number(s.interventions)).toBe(0);
    expect(existsSync(join(d.rickgentDir, "interventions.jsonl"))).toBe(false);
    // Non-interactive: no prompt / no "run this yourself" instruction emitted.
    expect(out.stdout).not.toMatch(/run this yourself|press enter|awaiting input|\? \(y\/n\)/i);
  });

  // VAL-BUILD-004
  it("a human-gate hit exits non-zero and records exactly one intervention", () => {
    const out = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir, "--no-autonomous-pr"],
      d,
    );
    expect(out.status).not.toBe(0);
    const p = join(d.rickgentDir, "interventions.jsonl");
    expect(existsSync(p)).toBe(true);
    const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).gate).toBe("merge-gate");
  });

  // VAL-BUILD-005
  it("produces a PR branch + a gh pr create gated by autonomous_pr_flow", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(0);
    // PR feature branch exists in the repo.
    const branches = git(d.repo, ["branch", "--list"]);
    expect(branches).toMatch(/rickgent\//);
    // gh pr create was actually issued (captured by the fixture gh).
    expect(existsSync(d.ghLog)).toBe(true);
    expect(readFileSync(d.ghLog, "utf-8")).toContain("pr create");
    // The invocation passed through autonomous_pr_flow with an ALLOW verdict.
    expect(out.stdout).toContain("autonomous_pr_flow push=ALLOW");
    expect(out.stdout).toContain("gh-pr-create=ALLOW");
  });

  // VAL-BUILD-006
  it("pipeline runs build then the cleanup chain", () => {
    const out = runCli(["pipeline", PRD_MIN, "--repo", d.repo, "--agent", d.agentDir], d);
    expect(out.status).toBe(0);
    const s = summary(out.stdout);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);
    expect(out.stdout).toContain("cleanup: orphan-reaper");
    expect(out.stdout).toContain("cleanup: reconcile");
  });

  // VAL-BUILD-007
  it("--resume continues a killed run via reconcile (only unfinished re-dispatched)", () => {
    const prd = writeMultiPrd(d.root, ["src/a.ts", "src/b.ts"]);
    // Phase 1: T2 (src/b.ts) fails, so T1 completes and T2 is left unfinished.
    const first = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir], d, {
      FIXTURE_FAIL_PATHS: "src/b.ts",
    });
    expect(first.status).toBe(0);
    const s1 = summary(first.stdout);
    expect(Number(s1.done)).toBe(1);
    expect(Number(s1.failed)).toBe(1);
    const t1SpawnsBefore = ledgerEntries(d.rickgentDir).filter(
      (e) => e.state === "spawned" && String(e.dispatchId).includes("/T1/"),
    ).length;

    // Phase 2: resume with T2 now succeeding.
    const second = runCli(["build", prd, "--resume", "--repo", d.repo, "--agent", d.agentDir], d);
    expect(second.status).toBe(0);
    const s2 = summary(second.stdout);
    expect(Number(s2.recovered)).toBeGreaterThanOrEqual(1); // T1 recovered
    expect(Number(s2.dispatched)).toBe(1); // only T2 re-dispatched
    expect(second.stdout).toMatch(/recovered Done via reconcile/);

    // T1 was NOT re-dispatched: its spawned-entry count is unchanged.
    const t1SpawnsAfter = ledgerEntries(d.rickgentDir).filter(
      (e) => e.state === "spawned" && String(e.dispatchId).includes("/T1/"),
    ).length;
    expect(t1SpawnsAfter).toBe(t1SpawnsBefore);
  });

  // VAL-BUILD-008
  it("a ticket failure is absorbed by salvage/breaker and the run continues non-interactively", () => {
    const prd = writeMultiPrd(d.root, ["src/a.ts", "src/b.ts"]);
    const out = runCli(["build", prd, "--repo", d.repo, "--agent", d.agentDir], d, {
      FIXTURE_FAIL_PATHS: "src/b.ts",
    });
    expect(out.status).toBe(0); // run continues to completion despite the failure
    const s = summary(out.stdout);
    expect(Number(s.failed)).toBe(1);
    expect(Number(s.interventions)).toBe(0); // failure is NOT a human intervention
    // Durable salvage disposition recorded for the failed ticket.
    const salvagePath = join(d.rickgentDir, "salvage-dispositions.jsonl");
    expect(existsSync(salvagePath)).toBe(true);
    const salvage = readFileSync(salvagePath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const t2 = salvage.find((x) => x.ticketId === "T2");
    expect(t2).toBeTruthy();
    expect(typeof t2.disposition).toBe("string");
    expect(t2.breaker).toBeTruthy();
    // Non-interactive: no prompt emitted.
    expect(out.stdout).not.toMatch(/run this yourself|press enter|awaiting input/i);
  });
});
