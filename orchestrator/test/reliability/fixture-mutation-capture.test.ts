import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import type { BuildOptions } from "../../src/lifecycle/build.js";
import {
  FIXTURE_BUILD_DEPENDENCIES,
  runFixtureBuild,
  type FixtureBuildDependencies,
} from "../helpers/capabilities.js";

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

describe("fixture mutation capture is explicitly nonterminal", () => {
  let root: string;
  let repo: string;
  let state: string;
  let data: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-capture-test-")));
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
    const dependencies: FixtureBuildDependencies = {
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
    const result = await runFixtureBuild(options(), dependencies);
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

    expect(existsSync(join(state, "registry.json"))).toBe(false);
    expect(existsSync(join(state, "dispatch-ledger.jsonl"))).toBe(false);
    expect(stateRows(repo, "SELECT state, state_version FROM runs"))
      .toEqual([expect.objectContaining({ state: "planned", state_version: 0 })]);
    expect(stateRows(repo, "SELECT state, state_version FROM run_tickets"))
      .toEqual([expect.objectContaining({ state: "planned", state_version: 0 })]);
    expect(stateRows(repo, "SELECT state, state_version FROM attempts"))
      .toEqual([expect.objectContaining({ state: "planned", state_version: 0 })]);
    expect(stateRows(repo, "SELECT transition_id FROM state_transitions")).toEqual([]);
  });

  it.each([
    ["no delta", { FIXTURE_UNVERIFIABLE_PATHS: "src/feature.ts" }],
    ["worker nonzero", { FIXTURE_FAIL_PATHS: "src/feature.ts" }],
  ])("produces no capture receipt for %s", async (_label, fixtureEnv) => {
    const result = await runFixtureBuild(options(fixtureEnv));
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
    const result = await runFixtureBuild(opts);
    expect(result.ticketsCaptured).toBe(0);
    expect(result.captureReceipts).toEqual([]);
    expect(result.ticketsDone).toBe(0);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(callerHead);
    expect(existsSync(join(state, "dispatch-ledger.jsonl"))).toBe(false);
    expect(existsSync(join(state, "registry.json"))).toBe(false);
    expect(stateRows(repo, "SELECT state FROM attempts"))
      .toEqual([expect.objectContaining({ state: "planned" })]);
  });

  it("quarantines target-repository legacy authority before run allocation or spawn", async () => {
    const legacy = join(repo, ".rickgent");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "registry.json"), JSON.stringify({
      runId: "legacy-run",
      tickets: { t01: { id: "t01", status: "Done", completionCommitSha: git(repo, ["rev-parse", "HEAD"]) } },
    }));
    writeFileSync(join(legacy, "dispatch-ledger.jsonl"), `${JSON.stringify({
      dispatchId: "legacy-run/t01/implement/1/worker",
      state: "completed",
      commitSha: git(repo, ["rev-parse", "HEAD"]),
    })}\n`);
    const spawnRecord = join(root, "legacy-spawn.json");

    const result = await runFixtureBuild(options({ FIXTURE_SPAWN_RECORD: spawnRecord }));

    expect(result.gateHit).toBe("state-authority-gate");
    expect(result.outcome.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining("RICKGENT_LEGACY_STATE_QUARANTINED") }),
    ]));
    expect(existsSync(spawnRecord)).toBe(false);
    expect(stateRows(repo, "SELECT run_id FROM runs")).toEqual([]);
    expect(stateRows(repo, "SELECT kind, disposition FROM legacy_artifacts").length).toBeGreaterThanOrEqual(2);
  });

  it("cannot resume an adversarial ticket-subject baseline or promote lifecycle state", async () => {
    writeFileSync(join(repo, "adversarial.txt"), "not completion evidence\n");
    git(repo, ["add", "--", "adversarial.txt"]);
    git(repo, ["commit", "-q", "-m", "ticket: t01"]);
    const callerHead = git(repo, ["rev-parse", "HEAD"]);
    const spawnRecord = join(root, "spawn.json");

    await expect(runFixtureBuild({
      ...options({ FIXTURE_SPAWN_RECORD: spawnRecord }),
      resume: true,
    })).rejects.toThrow("RICKGENT_RESUME_UNAVAILABLE");

    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("ticket: t01");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(callerHead);
    expect(existsSync(spawnRecord)).toBe(false);
    expect(existsSync(join(state, "registry.json"))).toBe(false);
    expect(existsSync(join(state, "dispatch-ledger.jsonl"))).toBe(false);
    expect(existsSync(join(state, "runs.jsonl"))).toBe(false);
    expect(existsSync(join(state, "materialized-workers"))).toBe(false);
  });

  it("blocks a skipped required policy gate before allocation, materialization, or spawn", async () => {
    const spawnRecord = join(root, "spawn.json");
    let allocationCalls = 0;
    const result = await runFixtureBuild(
      options({ FIXTURE_SPAWN_RECORD: spawnRecord }),
      {
        ...FIXTURE_BUILD_DEPENDENCIES,
        skipPolicyAttachment: true,
        provisionRunWorkspace() {
          allocationCalls++;
          throw new Error("workspace allocation must remain unreachable");
        },
      },
    );

    expect(result.gateHit).toBe("policy-attachment-gate");
    expect(result.outcome.status).toBe("failed");
    expect(result.outcome.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "required_gate_failed", gate: "policy-attachment" }),
    ]));
    expect(result.ticketsDispatched).toBe(0);
    expect(result.ticketsCaptured).toBe(0);
    expect(result.ticketsDone).toBe(0);
    expect(allocationCalls).toBe(0);
    expect(existsSync(spawnRecord)).toBe(false);
    expect(existsSync(join(state, "runs.jsonl"))).toBe(false);
    expect(existsSync(join(state, "registry.json"))).toBe(false);
    expect(existsSync(join(state, "dispatch-ledger.jsonl"))).toBe(false);
    expect(existsSync(join(state, "materialized-workers"))).toBe(false);
  });
});
