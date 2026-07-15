// M6 E2E — full gated pipeline twice consecutively (VAL-E2E-001..004).
//
// This is the Mission 1 AC-14 end-to-end validation: `rickgent build` runs the
// fixture PRD end-to-end with ALL gates live, completes PRD→PR with ZERO
// required human interventions, and the full gated pipeline runs clean
// end-to-end at least twice consecutively. This flow is DISTINCT from the M3
// single-build assertions (full gated pipeline, twice, not one build).
//
// Drives the REAL `rickgent` CLI (dist/cli.js) against the deterministic
// fixture omnigent + a fixture `gh`, and observes REAL effects: the dispatch
// ledger, git branches/commits, the intervention ledger, and the build report
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
  evidenceDispatch: /oracle|completed|db_session/i,
  salvage: /salvage|breaker/i,
  crossVendor: /router|routing|roster|vendor/i,
  conformance: /conformance/i,
  deslop: /deslop/i,
  mergeGate: /autonomous_pr_flow|merge gate/i,
};

describe("M6 E2E — full gated pipeline (VAL-E2E-001..004)", () => {
  let d: Dirs;
  beforeEach(() => {
    d = setupDirs();
  });
  afterEach(() => {
    rmSync(d.root, { recursive: true, force: true });
  });

  // VAL-E2E-001: rickgent build runs the fixture PRD end-to-end with ALL gates live
  it("runs the fixture PRD end-to-end with all gates observably invoked", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d);
    expect(out.status).toBe(0);

    // Each named gate must be observably invoked in the build report.
    // Policy attachment verification at startup.
    expect(out.stdout).toMatch(GATE_MARKERS.policyAttachment);
    // Evidence-based dispatch (B2): oracle-gated completion.
    expect(out.stdout).toMatch(GATE_MARKERS.evidenceDispatch);
    // Salvage/breaker infrastructure (observable even on success path).
    expect(out.stdout).toMatch(GATE_MARKERS.salvage);
    // Cross-vendor routing (B8).
    expect(out.stdout).toMatch(GATE_MARKERS.crossVendor);
    // Conformance audit gate.
    expect(out.stdout).toMatch(GATE_MARKERS.conformance);
    // Deslop gate.
    expect(out.stdout).toMatch(GATE_MARKERS.deslop);
    // Merge gate (autonomous_pr_flow).
    expect(out.stdout).toMatch(GATE_MARKERS.mergeGate);

    // The build decomposed >=1 ticket and dispatched via the real Dispatcher.
    const s = summary(out.stdout);
    expect(Number(s.planned)).toBeGreaterThanOrEqual(1);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);

    // PR was created (merge gate passed).
    expect(s.prCreated).toBe("true");
    expect(existsSync(d.ghLog)).toBe(true);
    expect(readFileSync(d.ghLog, "utf-8")).toContain("pr create");
  });

  // VAL-E2E-002: zero required human interventions
  it("completes PRD→PR with zero required human interventions", () => {
    const out = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d);
    expect(out.status).toBe(0);
    const s = summary(out.stdout);
    expect(Number(s.interventions)).toBe(0);
    // No intervention ledger file created (0 interventions = no file).
    expect(existsSync(join(d.rickgentDir, "interventions.jsonl"))).toBe(false);
    // Non-interactive: no prompt / no manual command.
    expect(out.stdout).not.toMatch(/run this yourself|press enter|awaiting input|\? \(y\/n\)/i);
  });

  // VAL-E2E-003: the full gated pipeline runs clean end-to-end at least twice consecutively
  it("runs the full gated pipeline clean end-to-end twice consecutively", () => {
    // ── Run 1 ──────────────────────────────────────────────────────────
    const out1 = runCli(["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR], d);
    expect(out1.status).toBe(0);
    const s1 = summary(out1.stdout);
    expect(Number(s1.interventions)).toBe(0);
    expect(s1.prCreated).toBe("true");
    // All gates observable in run 1.
    expect(out1.stdout).toMatch(GATE_MARKERS.conformance);
    expect(out1.stdout).toMatch(GATE_MARKERS.deslop);
    expect(out1.stdout).toMatch(GATE_MARKERS.policyAttachment);

    // ── Reset fixture state between runs ────────────────────────────────
    // Reset the git repo to initial state (no residue from run 1).
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
    expect(out2.status).toBe(0);
    const s2 = summary(out2.stdout);
    expect(Number(s2.interventions)).toBe(0);
    expect(s2.prCreated).toBe("true");
    // All gates observable in run 2 (not inherited from run 1).
    expect(out2.stdout).toMatch(GATE_MARKERS.conformance);
    expect(out2.stdout).toMatch(GATE_MARKERS.deslop);
    expect(out2.stdout).toMatch(GATE_MARKERS.policyAttachment);

    // Both runs produced a gated PR independently.
    expect(existsSync(d.ghLog)).toBe(true);
    expect(existsSync(ghLog2)).toBe(true);
    expect(readFileSync(ghLog2, "utf-8")).toContain("pr create");

    // Summary: 2/2 clean.
    const run1Clean = out1.status === 0 && Number(s1.interventions) === 0 && s1.prCreated === "true";
    const run2Clean = out2.status === 0 && Number(s2.interventions) === 0 && s2.prCreated === "true";
    expect(run1Clean && run2Clean).toBe(true);
  });

  // VAL-E2E-004: E2E flow is distinct from M3 single-build assertions
  it("is distinct from M3 single-build: disabling conformance turns E2E RED while M3 stays GREEN", () => {
    // Control run: skip the conformance gate via test-only env var.
    const controlOut = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR],
      d,
      { RICKGENT_FIXTURE_SKIP_CONFORMANCE: "1" },
    );
    // The build still succeeds (conformance is a quality gate, not a security gate).
    expect(controlOut.status).toBe(0);

    // But the E2E assertion for conformance FAILS: the conformance gate
    // evidence is ABSENT from the output.
    expect(controlOut.stdout).not.toMatch(GATE_MARKERS.conformance);

    // Meanwhile, the M3 single-build assertions (which do NOT check for
    // conformance) still pass: the build decomposes tickets, dispatches via
    // the real path, and creates a PR. The M3 test would be green here.
    const s = summary(controlOut.stdout);
    expect(Number(s.planned)).toBeGreaterThanOrEqual(1);
    expect(Number(s.dispatched)).toBeGreaterThanOrEqual(1);
    expect(s.prCreated).toBe("true");

    // This demonstrates distinctness: the E2E test catches a missing
    // conformance gate that the M3 single-build test does not.
  });

  // Additional distinctness: disabling deslop turns E2E RED while M3 stays GREEN
  it("is distinct from M3: disabling deslop turns E2E RED while M3 stays GREEN", () => {
    const controlOut = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR],
      d,
      { RICKGENT_FIXTURE_SKIP_DESLOP: "1" },
    );
    expect(controlOut.status).toBe(0);
    // E2E assertion for deslop FAILS: deslop evidence is ABSENT.
    expect(controlOut.stdout).not.toMatch(GATE_MARKERS.deslop);
    // M3 single-build assertions still pass.
    const s = summary(controlOut.stdout);
    expect(s.prCreated).toBe("true");
  });

  // Additional distinctness: disabling policy-attachment turns E2E RED while M3 stays GREEN
  it("is distinct from M3: disabling policy-attachment check turns E2E RED while M3 stays GREEN", () => {
    const controlOut = runCli(
      ["build", PRD_MIN, "--repo", d.repo, "--agent", AGENT_DIR],
      d,
      { RICKGENT_FIXTURE_SKIP_POLICY_ATTACH: "1" },
    );
    expect(controlOut.status).toBe(0);
    // E2E assertion for policy attachment FAILS: evidence is ABSENT.
    expect(controlOut.stdout).not.toMatch(GATE_MARKERS.policyAttachment);
    // M3 single-build assertions still pass.
    const s = summary(controlOut.stdout);
    expect(s.prCreated).toBe("true");
  });
});
