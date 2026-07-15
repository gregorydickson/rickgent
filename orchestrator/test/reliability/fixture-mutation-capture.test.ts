import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBuild } from "../../src/lifecycle/build.js";
import type { BuildDependencies, BuildOptions } from "../../src/lifecycle/build.js";
import { FIXTURE_BUILD_DEPENDENCIES } from "../helpers/capabilities.js";

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepository(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Fixture"]);
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
  const refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/rickgent/runs"]);
  for (const ref of refs.split("\n").filter(Boolean)) {
    try { git(repo, ["update-ref", "-d", ref]); } catch { /* test cleanup */ }
  }
}

describe("fixture mutation capture is explicitly nonterminal", () => {
  let root: string;
  let repo: string;
  let state: string;
  let data: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rickgent-capture-test-"));
    repo = join(root, "repo");
    state = join(root, "state");
    data = join(root, "data");
    initRepository(repo);
  });

  afterEach(() => {
    cleanupDedicatedWorktrees(repo);
    rmSync(root, { recursive: true, force: true });
  });

  function options(extraEnv: Record<string, string> = {}): BuildOptions {
    return {
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: state,
      agentDir: AGENT_ROOT,
      dataDir: data,
      maxConcurrent: 1,
      roster: [{ harness: "codex", model: "fixture", vendor: "openai", tier: "fixture", pricing: { cost_per_dispatch: 0.01 } }],
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_MODE: "prompt",
        ...extraEnv,
      },
    };
  }

  it("emits only implementation_captured_nonterminal and cannot reach verification, delivery, or Done", async () => {
    let conformanceCalls = 0;
    let deslopCalls = 0;
    const dependencies: BuildDependencies = {
      ...FIXTURE_BUILD_DEPENDENCIES,
      runConformanceGate() {
        conformanceCalls++;
        throw new Error("unreachable");
      },
      runDeslopGate() {
        deslopCalls++;
        throw new Error("unreachable");
      },
    };
    const result = await runBuild(options(), dependencies);
    expect(result.ticketsCaptured).toBe(1);
    expect(result.ticketsDone).toBe(0);
    expect(result.ticketsRecovered).toBe(0);
    expect(result.captureReceipts).toHaveLength(1);
    const receipt = result.captureReceipts[0]!;
    expect(receipt.kind).toBe("implementation_captured_nonterminal");
    expect(receipt.changedPaths.map((entry) => entry.path)).toEqual(["src/feature.ts"]);
    expect(receipt.materializedWorkerBundle).toContain("agents/rickgent/agents/worker");
    expect(Object.prototype.hasOwnProperty.call(receipt, "commitSha")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(receipt, "verified")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(receipt, "ready_for_delivery")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(receipt, "delivered")).toBe(false);
    expect(conformanceCalls).toBe(0);
    expect(deslopCalls).toBe(0);
    expect(result.outcome.status).toBe("failed");
    expect(result.outcome.issues.some((issue) => issue.reason === "zero_completion")).toBe(true);

    const registry = JSON.parse(readFileSync(join(state, "registry.json"), "utf-8")) as {
      tickets: Record<string, { status: string; phase: string; completionCommitSha: string | null }>;
    };
    expect(registry.tickets["t01"]).toMatchObject({
      status: "In Progress",
      phase: "implementation_captured",
      completionCommitSha: null,
    });

    const ledger = readFileSync(join(state, "dispatch-ledger.jsonl"), "utf-8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const capture = ledger.find((entry) => entry["state"] === "implementation_captured");
    expect(capture?.["captureReceipt"]).toMatchObject({ kind: "implementation_captured_nonterminal" });
    expect(ledger.some((entry) => ["completed", "verified", "ready_for_delivery", "delivered", "Done"].includes(String(entry["state"])))).toBe(false);
  });

  it.each([
    ["no delta", { FIXTURE_UNVERIFIABLE_PATHS: "src/feature.ts" }],
    ["worker nonzero", { FIXTURE_FAIL_PATHS: "src/feature.ts" }],
  ])("produces no capture receipt for %s", async (_label, fixtureEnv) => {
    const result = await runBuild(options(fixtureEnv), FIXTURE_BUILD_DEPENDENCIES);
    expect(result.ticketsCaptured).toBe(0);
    expect(result.captureReceipts).toEqual([]);
    expect(result.ticketsDone).toBe(0);
  });

  it.each([
    ["staged delta", "0"],
    ["worker commit/moved HEAD", "1"],
  ])("rejects %s without treating a worker commit as evidence", async (_label, mode) => {
    const opts = options({
      FIXTURE_MODE: "direct",
      FIXTURE_WRITE_DB: "1",
      FIXTURE_TRANSCRIPT_ITEMS: "2",
      FIXTURE_GIT_FILE: "src/feature.ts",
      FIXTURE_GIT_COMMIT: mode,
    });
    const callerHead = git(repo, ["rev-parse", "HEAD"]);
    const result = await runBuild(opts, FIXTURE_BUILD_DEPENDENCIES);
    expect(result.ticketsCaptured).toBe(0);
    expect(result.captureReceipts).toEqual([]);
    expect(result.ticketsDone).toBe(0);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(callerHead);
    const ledgerText = readFileSync(join(state, "dispatch-ledger.jsonl"), "utf-8");
    expect(ledgerText).not.toContain('"state":"completed"');
  });
});
