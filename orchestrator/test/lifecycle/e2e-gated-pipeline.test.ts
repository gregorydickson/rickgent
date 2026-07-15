// M6 E2E — full gated pipeline twice consecutively (VAL-E2E-001..004).
//
// M1 end-to-end validation: `rickgent build` may capture implementation, but it
// must remain nonterminal and keep later verification/delivery gates unreachable.
//
// Drives the REAL `rickgent` CLI (dist/cli.js) against the deterministic
// fixture omnigent and observes REAL effects: the dispatch ledger, isolated deltas,
// the intervention ledger, and the build report
// output enumerating each enforced gate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");
// Real agent bundle dir — the E2E test exercises the real policy attachment
// gate, so it must point at the actual manager + worker bundles.
const AGENT_DIR = join(import.meta.dirname, "../../../agents/rickgent");

// Minimal valid multi-vendor roster (same as build-loop tests).
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
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length);
    if (worktree !== current) {
      try { git(repo, ["worktree", "remove", "--force", worktree]); } catch { /* test cleanup */ }
    }
  }
}

/** Reset a fixture repo to its initial state (remove feature branches, reset HEAD). */
function resetRepo(repo: string): void {
  // Checkout main/master and remove any feature branches.
  const branches = git(repo, ["branch", "--list"]).split("\n").map((b) => b.trim());
  const mainBranch = branches.find((b) => b.startsWith("*"))?.replace("*", "").trim() ?? "main";
  // Find and remove rickgent/* branches
  for (const b of branches) {
    const name = b.replace("*", "").trim();
    if (name && name !== mainBranch && name.startsWith("rickgent/")) {
      try {
        git(repo, ["branch", "-D", name]);
      } catch {
        // ignore
      }
    }
  }
  // Hard reset to the initial commit (first commit)
  const commits = git(repo, ["log", "--oneline", "--reverse"]).split("\n");
  const firstCommit = commits[0]?.split(/\s/)[0];
  if (firstCommit) {
    git(repo, ["reset", "--hard", firstCommit]);
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
  const root = mkdtempSync(join(tmpdir(), "rickgent-e2e-"));
  const repo = join(root, "repo");
  initGitRepo(repo);
  const dataDir = join(root, "data");
  const rickgentDir = join(root, ".rickgent");
  const agentDir = join(root, "agent");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, repo, dataDir, rickgentDir, agentDir, ghLog: join(root, "gh.log") };
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
    input: "",
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

/** Gate evidence markers that the E2E test checks for in the build output. */
const GATE_MARKERS = {
  policyAttachment: /policy attachment/i,
  evidenceDispatch: /implementation captured|db_session/i,
  salvage: /salvage|breaker/i,
  crossVendor: /router|routing|roster|vendor/i,
  conformance: /conformance/i,
  deslop: /deslop/i,
  localProfile: /local profile complete/i,
};

describe("M6 E2E — full gated pipeline (VAL-E2E-001..004)", () => {
  let d: Dirs;
  beforeEach(() => {
    d = setupDirs();
  });
  afterEach(() => {
    cleanupRunWorktrees(d.repo);
    rmSync(d.root, { recursive: true, force: true });
  });

  it("runs capture end-to-end while later gates remain observably unreachable", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d);
    expect(out.status).toBe(5);

    // Each named gate must be observably invoked in the build report.
    // Policy attachment verification at startup.
    expect(out.stdout).toMatch(GATE_MARKERS.policyAttachment);
    // Fixture evidence settles only as a nonterminal capture.
    expect(out.stdout).toMatch(GATE_MARKERS.evidenceDispatch);
    // Salvage/breaker infrastructure (observable even on success path).
    expect(out.stdout).toMatch(GATE_MARKERS.salvage);
    // Cross-vendor routing (B8).
    expect(out.stdout).toMatch(GATE_MARKERS.crossVendor);
    // Later gates are reported as skipped because nothing completed.
    expect(out.stdout).toMatch(GATE_MARKERS.conformance);
    // Deslop gate.
    expect(out.stdout).toMatch(GATE_MARKERS.deslop);
    expect(out.stdout).toMatch(GATE_MARKERS.localProfile);

    // The build decomposed >=1 ticket and dispatched via the real Dispatcher.
    const s = summary(out.stdout);
    expect(Number(s.planned)).toBeGreaterThanOrEqual(1);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);

    expect(Number(s.captured)).toBe(1);
    expect(Number(s.done)).toBe(0);
    expect(s.outcome).toBe("failed");
    expect(existsSync(d.ghLog)).toBe(false);
  });

  // VAL-E2E-002: zero required human interventions
  it("captures with zero required human interventions", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d);
    expect(out.status).toBe(5);
    const s = summary(out.stdout);
    expect(Number(s.interventions)).toBe(0);
    // No intervention ledger file created (0 interventions = no file).
    expect(existsSync(join(d.rickgentDir, "interventions.jsonl"))).toBe(false);
    // Non-interactive: no prompt / no manual command.
    expect(out.stdout).not.toMatch(/run this yourself|press enter|awaiting input|\? \(y\/n\)/i);
  });

  it("runs the nonterminal capture seam twice consecutively", () => {
    // ── Run 1 ──────────────────────────────────────────────────────────
    const out1 = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d);
    expect(out1.status).toBe(5);
    const s1 = summary(out1.stdout);
    expect(Number(s1.interventions)).toBe(0);
    expect(s1.outcome).toBe("failed");
    expect(Number(s1.captured)).toBe(1);
    // All gates observable in run 1.
    expect(out1.stdout).toMatch(GATE_MARKERS.conformance);
    expect(out1.stdout).toMatch(GATE_MARKERS.deslop);
    expect(out1.stdout).toMatch(GATE_MARKERS.policyAttachment);

    // ── Reset fixture state between runs ────────────────────────────────
    // Reset the git repo to initial state (no residue from run 1).
    cleanupRunWorktrees(d.repo);
    resetRepo(d.repo);
    // Use a fresh .rickgent dir + data dir for run 2 (no ledger/registry residue).
    const rickgentDir2 = join(d.root, ".rickgent-2");
    const dataDir2 = join(d.root, "data-2");
    mkdirSync(rickgentDir2, { recursive: true });
    mkdirSync(dataDir2, { recursive: true });
    const ghLog2 = join(d.root, "gh-2.log");
    const d2: Dirs = { ...d, rickgentDir: rickgentDir2, dataDir: dataDir2, ghLog: ghLog2 };

    // ── Run 2 ──────────────────────────────────────────────────────────
    const out2 = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d2);
    expect(out2.status).toBe(5);
    const s2 = summary(out2.stdout);
    expect(Number(s2.interventions)).toBe(0);
    expect(s2.outcome).toBe("failed");
    expect(Number(s2.captured)).toBe(1);
    // All gates observable in run 2 (not inherited from run 1).
    expect(out2.stdout).toMatch(GATE_MARKERS.conformance);
    expect(out2.stdout).toMatch(GATE_MARKERS.deslop);
    expect(out2.stdout).toMatch(GATE_MARKERS.policyAttachment);

    // Delivery remains absent independently in both runs.
    expect(existsSync(d.ghLog)).toBe(false);
    expect(existsSync(ghLog2)).toBe(false);

    expect(Number(s1.done) + Number(s2.done)).toBe(0);
  });

  // VAL-E2E-004: E2E flow is distinct from M3 single-build assertions
  it("does not invoke conformance for a capture-only run", () => {
    const controlOut = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR],
      d,
      { RICKGENT_FIXTURE_SKIP_CONFORMANCE: "1" },
    );
    expect(controlOut.status).toBe(5);
    expect(controlOut.stdout).not.toContain("conformance gate");

    const s = summary(controlOut.stdout);
    expect(Number(s.planned)).toBeGreaterThanOrEqual(1);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);
    expect(s.outcome).toBe("failed");

  });

  it("does not invoke deslop for a capture-only run", () => {
    const controlOut = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR],
      d,
      { RICKGENT_FIXTURE_SKIP_DESLOP: "1" },
    );
    expect(controlOut.status).toBe(5);
    expect(controlOut.stdout).not.toContain("deslop gate");
    const s = summary(controlOut.stdout);
    expect(s.outcome).toBe("failed");
  });

  it("fails closed when the required policy-attachment check is disabled", () => {
    const controlOut = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR],
      d,
      { RICKGENT_FIXTURE_SKIP_POLICY_ATTACH: "1" },
    );
    expect(controlOut.status).toBe(6);
    expect(controlOut.stdout).toContain("policy attachment — skipped");
    expect(controlOut.stdout).toContain("required_gate_failed");
    const s = summary(controlOut.stdout);
    expect(s.outcome).toBe("failed");
  });
});
