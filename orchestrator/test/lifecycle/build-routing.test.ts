// M4 fix — Router wiring end-to-end tests (VAL-ROUTE-WIRING).
//
// Drives the REAL build path (`runBuild`) with a live roster and verifies:
//   1. The Python `select_model` router is called before each dispatch (via
//      subprocess) and the selected `vendor` flows into every ledger entry
//      (not null) — the production path populates the vendor label.
//   2. The pre-dispatch cost gate is enforced: an all-unpriced roster → DENY
//      → no dispatch spawns (fail-closed).
//   3. The cross-vendor review exclusion flows through the router in the real
//      dispatch path: a code_review dispatch selects a vendor != implementer's.
//   4. An over-hard-budget roster → DENY → no dispatch.
//
// These tests FAIL against the unwired code (build.ts never calls select_model,
// so every ledger entry has vendor: null) and PASS after the wiring fix.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBuild } from "../../src/lifecycle/build.js";
import { callSelectModel, routeDispatch, type ModelEntry } from "../../src/lifecycle/routing.js";
import { FIXTURE_BUILD_DEPENDENCIES, FIXTURE_CAPABILITY_GATE } from "../helpers/capabilities.js";

const fixtureBuild = (options: Parameters<typeof runBuild>[0]) =>
  runBuild(options, FIXTURE_BUILD_DEPENDENCIES);

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");

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

function cleanupDedicatedWorktrees(repo: string): void {
  if (!existsSync(repo)) return;
  const list = git(repo, ["worktree", "list", "--porcelain"]);
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (realpathSync(path) !== realpathSync(repo)) {
      try { git(repo, ["worktree", "remove", "--force", path]); } catch { /* test cleanup */ }
    }
  }
}

interface Dirs {
  root: string;
  repo: string;
  dataDir: string;
  rickgentDir: string;
  agentDir: string;
}

function setupDirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), "rickgent-route-"));
  const repo = join(root, "repo");
  initGitRepo(repo);
  const dataDir = join(root, "data");
  const rickgentDir = join(root, ".rickgent");
  const agentDir = AGENT_ROOT;
  mkdirSync(dataDir, { recursive: true });
  return { root, repo, dataDir, rickgentDir, agentDir };
}

// Multi-vendor roster with priced models across anthropic + openai + alibaba.
const MULTI_VENDOR_ROSTER: ModelEntry[] = [
  { harness: "claude", model: "anthropic/claude-haiku-4", vendor: "anthropic", tier: "cheap", pricing: { cost_per_dispatch: 0.05 } },
  { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: { cost_per_dispatch: 0.50 } },
  { harness: "codex", model: "openai/gpt-5-mini", vendor: "openai", tier: "cheap", pricing: { cost_per_dispatch: 0.04 } },
  { harness: "codex", model: "openai/gpt-5", vendor: "openai", tier: "capable", pricing: { cost_per_dispatch: 2.00 } },
  { harness: "qwen", model: "qwen/qwen-coder", vendor: "alibaba", tier: "mid", pricing: { cost_per_dispatch: 0.10 } },
];

// All-unpriced roster — cost gate must DENY.
const UNPRICED_ROSTER: ModelEntry[] = [
  { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: null },
];

// Over-hard-budget roster — every model exceeds the budget.
const OVER_BUDGET_ROSTER: ModelEntry[] = [
  { harness: "codex", model: "openai/gpt-5", vendor: "openai", tier: "capable", pricing: { cost_per_dispatch: 100.0 } },
];

function ledgerEntries(rickgentDir: string): Array<Record<string, unknown>> {
  const p = join(rickgentDir, "dispatch-ledger.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function fixtureEnv(d: Dirs, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    RICKGENT_DIR: d.rickgentDir,
    OMNIGENT_DATA_DIR: d.dataDir,
    FIXTURE_MODE: "prompt",
    FIXTURE_TARGET_REPO: d.repo,
    ...extra,
  };
}

describe("M4 fix: build path calls select_model before each dispatch", () => {
  let d: Dirs;
  beforeEach(() => { d = setupDirs(); });
  afterEach(() => {
    cleanupDedicatedWorktrees(d.repo);
    rmSync(d.root, { recursive: true, force: true });
  });

  // VAL-ROUTE-WIRING-001: the production build path populates the vendor label
  // from the router's selection. Ledger entries have vendor != null.
  it("populates vendor from the router's selection in every spawned ledger entry", async () => {
    const result = await fixtureBuild({
      prdPath: PRD_MIN,
      workingDir: d.repo,
      rickgentDir: d.rickgentDir,
      agentDir: d.agentDir,
      dataDir: d.dataDir,
      roster: MULTI_VENDOR_ROSTER,
      costBudgetUsd: 10.0,
      env: fixtureEnv(d),
    });
    expect(result.outcome.status).toBe("failed");
    expect(result.ticketsCaptured).toBe(1);
    const entries = ledgerEntries(d.rickgentDir);
    const spawned = entries.filter((e) => e.state === "spawned" || e.state === "implementation_captured");
    expect(spawned.length).toBeGreaterThan(0);
    // Every spawned/completed entry carries a non-null vendor from the router.
    for (const e of spawned) {
      expect(e.vendor).not.toBeNull();
      expect(typeof e.vendor).toBe("string");
      expect(e.vendor).not.toBe("");
      // The vendor must be one from the roster (not a fabricated default).
      expect(MULTI_VENDOR_ROSTER.some((m) => m.vendor === e.vendor)).toBe(true);
    }
  });

  // VAL-ROUTE-WIRING-002: the vendor label matches the router's ALLOW selection.
  it("the ledger vendor matches the router's ALLOW selection for the implement role", async () => {
    // First, determine what the router selects for the implement role.
    const routed = routeDispatch(MULTI_VENDOR_ROSTER, "implement", { costBudgetUsd: 10.0 });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    const expectedVendor = routed.selection.vendor;

    const result = await fixtureBuild({
      prdPath: PRD_MIN,
      workingDir: d.repo,
      rickgentDir: d.rickgentDir,
      agentDir: d.agentDir,
      dataDir: d.dataDir,
      roster: MULTI_VENDOR_ROSTER,
      costBudgetUsd: 10.0,
      env: fixtureEnv(d),
    });
    expect(result.outcome.status).toBe("failed");
    expect(result.ticketsCaptured).toBe(1);
    const entries = ledgerEntries(d.rickgentDir);
    const spawned = entries.filter((e) => e.state === "spawned");
    expect(spawned.length).toBeGreaterThan(0);
    for (const e of spawned) {
      expect(e.vendor).toBe(expectedVendor);
    }
  });
});

describe("M4 fix: pre-dispatch cost gate is enforced in the build path", () => {
  let d: Dirs;
  beforeEach(() => { d = setupDirs(); });
  afterEach(() => {
    cleanupDedicatedWorktrees(d.repo);
    rmSync(d.root, { recursive: true, force: true });
  });

  // VAL-ROUTE-WIRING-003: an all-unpriced roster → DENY → no dispatch spawns.
  it("DENYs dispatch on an all-unpriced roster (no spawned entries)", async () => {
    const result = await fixtureBuild({
      prdPath: PRD_MIN,
      workingDir: d.repo,
      rickgentDir: d.rickgentDir,
      agentDir: d.agentDir,
      dataDir: d.dataDir,
      roster: UNPRICED_ROSTER,
      costBudgetUsd: 10.0,
      env: fixtureEnv(d),
    });
    // The build completes (non-interactive, failure absorbed) but no dispatch
    // was spawned — every ticket was blocked by the cost gate.
    const entries = ledgerEntries(d.rickgentDir);
    const spawned = entries.filter((e) => e.state === "spawned");
    expect(spawned.length).toBe(0);
    // The failed entries carry the cost-gate DENY reason.
    const failed = entries.filter((e) => e.state === "failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const e of failed) {
      expect(typeof e.stderr).toBe("string");
      expect(e.stderr as string).toMatch(/routing|NO_PRICED_MODEL|cost/i);
    }
  });

  // VAL-ROUTE-WIRING-004: an over-hard-budget roster → DENY → no dispatch.
  it("DENYs dispatch when every model exceeds the hard budget", async () => {
    const result = await fixtureBuild({
      prdPath: PRD_MIN,
      workingDir: d.repo,
      rickgentDir: d.rickgentDir,
      agentDir: d.agentDir,
      dataDir: d.dataDir,
      roster: OVER_BUDGET_ROSTER,
      costBudgetUsd: 1.0,
      env: fixtureEnv(d),
    });
    const entries = ledgerEntries(d.rickgentDir);
    const spawned = entries.filter((e) => e.state === "spawned");
    expect(spawned.length).toBe(0);
    const failed = entries.filter((e) => e.state === "failed");
    expect(failed.length).toBeGreaterThan(0);
  });

  // VAL-ROUTE-WIRING-005: an empty roster → DENY → no dispatch (fail-closed).
  it("DENYs dispatch on an empty roster (no silent fallback)", async () => {
    const result = await fixtureBuild({
      prdPath: PRD_MIN,
      workingDir: d.repo,
      rickgentDir: d.rickgentDir,
      agentDir: d.agentDir,
      dataDir: d.dataDir,
      roster: [],
      env: fixtureEnv(d),
    });
    const entries = ledgerEntries(d.rickgentDir);
    const spawned = entries.filter((e) => e.state === "spawned");
    expect(spawned.length).toBe(0);
  });
});

describe("M4 fix: cross-vendor review exclusion in the real dispatch path", () => {
  // VAL-ROUTE-WIRING-006: the code_review role through the real router excludes
  // the implementer's vendor. This is driven through the actual subprocess
  // (callSelectModel), not a unit-test mock.
  it("code_review role selects a vendor different from the implementer's", () => {
    const routed = routeDispatch(MULTI_VENDOR_ROSTER, "code_review", {
      implementerVendor: "anthropic",
      costBudgetUsd: 10.0,
    }, FIXTURE_CAPABILITY_GATE);
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.selection.vendor).not.toBe("anthropic");
  });

  it("code_review role with openai implementer selects a non-openai vendor", () => {
    const routed = routeDispatch(MULTI_VENDOR_ROSTER, "code_review", {
      implementerVendor: "openai",
      costBudgetUsd: 10.0,
    }, FIXTURE_CAPABILITY_GATE);
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.selection.vendor).not.toBe("openai");
  });

  it("code_review fails closed when only the implementer's vendor is available", () => {
    const singleVendor: ModelEntry[] = [
      { harness: "claude", model: "anthropic/claude-sonnet-4", vendor: "anthropic", tier: "mid", pricing: { cost_per_dispatch: 0.50 } },
    ];
    const routed = routeDispatch(singleVendor, "code_review", {
      implementerVendor: "anthropic",
      costBudgetUsd: 10.0,
    }, FIXTURE_CAPABILITY_GATE);
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.verdict.result).toBe("DENY");
  });
});

describe("M4 fix: routing module subprocess bridge", () => {
  // Direct subprocess-level test: callSelectModel invokes the real Python
  // select_model and returns a parsed verdict.
  it("callSelectModel returns ALLOW with a selection for a priced roster", () => {
    const verdict = callSelectModel(MULTI_VENDOR_ROSTER, "implement", null, 10.0, null);
    expect(verdict.result).toBe("ALLOW");
    if (verdict.result !== "ALLOW") return;
    expect(verdict.selection.vendor).toBeTruthy();
  });

  it("callSelectModel returns DENY for an empty roster", () => {
    const verdict = callSelectModel([], "implement", null, 10.0, null);
    expect(verdict.result).toBe("DENY");
  });

  it("callSelectModel returns DENY for an unpriced roster", () => {
    const verdict = callSelectModel(UNPRICED_ROSTER, "implement", null, 10.0, null);
    expect(verdict.result).toBe("DENY");
  });
});
