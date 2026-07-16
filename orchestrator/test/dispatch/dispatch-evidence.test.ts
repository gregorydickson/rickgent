// M1 dispatch evidence is capture-only. The dispatcher has no compatibility
// path that can turn a worker-created commit into completion evidence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DispatchLedger,
  Dispatcher,
  TicketLock,
  type DispatchEntry,
  type DispatchId,
} from "../../dist-fixture/dispatch/dispatch.js";
import {
  finalizeRunWorkspace,
  provisionRunWorkspace,
  type ReadyRunWorkspace,
} from "../../src/git/run-workspace.js";

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Fixture"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

function states(path: string): string[] {
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as DispatchEntry).state);
}

describe("M1 capture-only dispatch evidence", () => {
  let root: string;
  let repo: string;
  let workspace: ReadyRunWorkspace;
  let ledgerPath: string;
  let dispatcher: Dispatcher;
  const id: DispatchId = {
    runId: "run-evidence",
    ticketId: "t01",
    phase: "implement",
    attempt: 1,
    role: "worker",
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rickgent-dispatch-evidence-"));
    repo = join(root, "repo");
    initRepo(repo);
    const provisioned = provisionRunWorkspace({ targetRepo: repo, runId: id.runId });
    if (!provisioned.ok) throw new Error(provisioned.detail);
    workspace = provisioned.workspace;
    ledgerPath = join(root, "ledger.jsonl");
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      root,
    );
  });

  afterEach(() => {
    finalizeRunWorkspace(workspace, false);
    rmSync(root, { recursive: true, force: true });
  });

  async function dispatch(extra: Record<string, string> = {}): Promise<DispatchEntry> {
    return dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "implement src/feature.ts",
      timeout: 20_000,
      maxConcurrent: 1,
      workspace,
      materializationRoot: join(root, "materialized"),
      dataDir: join(root, "data"),
      declaredPaths: ["src/feature.ts"],
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_MODE: "direct",
        FIXTURE_WRITE_DB: "1",
        FIXTURE_TRANSCRIPT_ITEMS: "2",
        FIXTURE_GIT_FILE: "src/feature.ts",
        FIXTURE_GIT_COMMIT: "capture",
        ...extra,
      },
    });
  }

  it("emits db observation then implementation_captured, never completed", async () => {
    const callerHead = git(repo, ["rev-parse", "HEAD"]);
    const entry = await dispatch();
    expect(entry.state).toBe("implementation_captured");
    expect(entry.captureReceipt).toMatchObject({ kind: "implementation_captured_nonterminal" });
    expect(states(ledgerPath)).toEqual(["spawned", "db_session_observed", "implementation_captured"]);
    expect(states(ledgerPath)).not.toContain("completed");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(callerHead);
  });

  it.each([
    ["no-op", { FIXTURE_GIT_FILE: "" }],
    ["staged", { FIXTURE_GIT_COMMIT: "0" }],
    ["committed", { FIXTURE_GIT_COMMIT: "1" }],
  ])("rejects %s worker output without completion", async (_label, env) => {
    const entry = await dispatch(env);
    expect(entry.state).toBe("failed");
    expect(states(ledgerPath)).not.toContain("completed");
  });

  it("rejects an unverified mutation cwd before ledger or spawn work", async () => {
    const isolatedLedger = new DispatchLedger(join(root, "isolated-ledger.jsonl"));
    const isolated = new Dispatcher(
      isolatedLedger,
      new TicketLock(join(root, "isolated-locks")),
      root,
    );
    await expect(isolated.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
    })).rejects.toThrow("verified run workspace");
    expect(isolatedLedger.find("run-evidence/t01/implement/1/worker")).toBeNull();
  });
});
