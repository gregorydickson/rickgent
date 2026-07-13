// B2 — evidence-based dispatch completion (VAL-DISPATCH-001..009).
//
// Drives the REAL Dispatcher against the deterministic fixture omnigent
// (architecture §4) and observes REAL effects (git HEAD, chat.db rows, ledger
// state) — never a mock's return value. A dispatch may reach `completed` ONLY
// after all four evidence conditions hold AND the completion oracle passes;
// exit 0 alone, false success tokens, and out-of-scope deltas do not complete.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  DispatchLedger,
  TicketLock,
  Dispatcher,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
} from "../../src/dispatch/dispatch.js";
import { insertConversation } from "../fixtures/omnigent-fixture/chat-db.mjs";

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");

function makeId(ticketId = "T-1"): DispatchId {
  return { runId: "run-1", ticketId, phase: "implement", attempt: 1, role: "worker" };
}

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

interface FixtureConfig {
  writeDb?: boolean;
  transcriptItems?: number;
  gitFile?: string;
  exitCode?: number;
  stdout?: string;
  declaredPaths?: string[];
  seedConversation?: { id: string; items: number; createdAt: number };
  preDirtyFile?: string;
}

interface RunResult {
  entry: DispatchEntry;
  ledgerPath: string;
  dispatchId: string;
  repo: string;
  dataDir: string;
  baselineHead: string;
}

// process.env is set (not just opts.env) so the child fixture is reachable and
// data-isolated regardless of whether the code under test forwards opts.env —
// this keeps the red-first assertions honest (they fail on the completion
// logic, not on an unreachable binary).
async function runDispatch(cfg: FixtureConfig, dir: string): Promise<RunResult> {
  const repo = join(dir, "repo");
  initGitRepo(repo);
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });

  if (cfg.seedConversation) {
    insertConversation(dataDir, cfg.seedConversation.id, cfg.seedConversation.items, cfg.seedConversation.createdAt);
  }
  if (cfg.preDirtyFile) {
    const abs = join(repo, cfg.preDirtyFile);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "pre-existing dirty content\n");
  }

  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = new DispatchLedger(ledgerPath);
  const lock = new TicketLock(join(dir, "locks"));
  const dispatcher = new Dispatcher(ledger, lock, dir);

  const fixtureEnv: Record<string, string> = {
    PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    OMNIGENT_DATA_DIR: dataDir,
    FIXTURE_TARGET_REPO: repo,
    FIXTURE_STDOUT: cfg.stdout ?? "fixture worker transcript line",
    FIXTURE_EXIT_CODE: String(cfg.exitCode ?? 0),
  };
  if (cfg.writeDb) {
    fixtureEnv.FIXTURE_WRITE_DB = "1";
    fixtureEnv.FIXTURE_TRANSCRIPT_ITEMS = String(cfg.transcriptItems ?? 1);
  }
  if (cfg.gitFile) fixtureEnv.FIXTURE_GIT_FILE = cfg.gitFile;

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(fixtureEnv)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const id = makeId();
    const entry = await dispatcher.dispatch(id, {
      agentDir: join(dir, "agent"),
      prompt: "do work",
      timeout: 20000,
      maxConcurrent: 2,
      targetRepo: repo,
      dataDir,
      declaredPaths: cfg.declaredPaths ?? ["src"],
      env: fixtureEnv,
    });
    return { entry, ledgerPath, dispatchId: dispatchIdString(id), repo, dataDir, baselineHead };
  } finally {
    for (const k of Object.keys(fixtureEnv)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function ledgerStates(ledgerPath: string, dispatchId: string): string[] {
  const raw = readFileSync(ledgerPath, "utf-8").trim();
  return raw
    .split("\n")
    .map((l) => JSON.parse(l) as DispatchEntry)
    .filter((e) => e.dispatchId === dispatchId)
    .map((e) => e.state);
}

describe("B2 evidence-based dispatch completion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rickgent-b2-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // VAL-DISPATCH-001
  it("exit 0 with no git delta is NOT completed", async () => {
    const r = await runDispatch({ writeDb: true, transcriptItems: 1 }, dir);
    expect(r.entry.state).not.toBe("completed");
    // git-tree-truth: HEAD unchanged from baseline.
    expect(git(r.repo, ["rev-parse", "HEAD"])).toBe(r.baselineHead);
    expect(ledgerStates(r.ledgerPath, r.dispatchId)).not.toContain("completed");
  });

  // VAL-DISPATCH-002
  it("emits db_session_observed BEFORE completed for a fully-satisfying dispatch", async () => {
    const r = await runDispatch({ writeDb: true, transcriptItems: 2, gitFile: "src/feature.ts" }, dir);
    expect(r.entry.state).toBe("completed");
    const states = ledgerStates(r.ledgerPath, r.dispatchId);
    const obs = states.indexOf("db_session_observed");
    const done = states.indexOf("completed");
    expect(obs).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThanOrEqual(0);
    expect(obs).toBeLessThan(done);
    expect(r.entry.conversationId).toBeTruthy();
  });

  // VAL-DISPATCH-003
  it("missing DB session blocks completion", async () => {
    const r = await runDispatch({ writeDb: false, gitFile: "src/feature.ts" }, dir);
    expect(r.entry.state).not.toBe("completed");
    const states = ledgerStates(r.ledgerPath, r.dispatchId);
    expect(states).not.toContain("db_session_observed");
    expect(states).not.toContain("completed");
  });

  // VAL-DISPATCH-004
  it("empty transcript blocks completion", async () => {
    const r = await runDispatch({ writeDb: true, transcriptItems: 0, gitFile: "src/feature.ts" }, dir);
    expect(r.entry.state).not.toBe("completed");
    expect(ledgerStates(r.ledgerPath, r.dispatchId)).not.toContain("completed");
  });

  // VAL-DISPATCH-005 — positive plus each single condition dropped.
  it("completion requires all four evidence conditions AND an oracle pass", async () => {
    const full = await runDispatch(
      { writeDb: true, transcriptItems: 1, gitFile: "src/feature.ts" },
      mkdtempSync(join(tmpdir(), "rickgent-b2-full-")),
    );
    expect(full.entry.state).toBe("completed");

    // (a) drop DB session
    const noDb = await runDispatch(
      { writeDb: false, gitFile: "src/feature.ts" },
      mkdtempSync(join(tmpdir(), "rickgent-b2-nodb-")),
    );
    expect(noDb.entry.state).not.toBe("completed");

    // (b) drop transcript
    const noTx = await runDispatch(
      { writeDb: true, transcriptItems: 0, gitFile: "src/feature.ts" },
      mkdtempSync(join(tmpdir(), "rickgent-b2-notx-")),
    );
    expect(noTx.entry.state).not.toBe("completed");

    // (c) drop in-scope git delta
    const noDelta = await runDispatch(
      { writeDb: true, transcriptItems: 1 },
      mkdtempSync(join(tmpdir(), "rickgent-b2-nodelta-")),
    );
    expect(noDelta.entry.state).not.toBe("completed");
  });

  // VAL-DISPATCH-006
  it("false success token without a git delta is rejected (git-truth over claims)", async () => {
    const r = await runDispatch(
      { writeDb: true, transcriptItems: 1, stdout: "DONE ✅ ALL TESTS PASS SUCCESS" },
      dir,
    );
    expect(r.entry.state).not.toBe("completed");
    // The success token was really printed, yet ignored — HEAD is unchanged.
    expect(r.entry.stdout).toContain("SUCCESS");
    expect(git(r.repo, ["rev-parse", "HEAD"])).toBe(r.baselineHead);
  });

  // VAL-DISPATCH-007
  it("out-of-scope git delta does not satisfy completion", async () => {
    const r = await runDispatch(
      { writeDb: true, transcriptItems: 1, gitFile: "other/x.ts", declaredPaths: ["src"] },
      dir,
    );
    expect(r.entry.state).not.toBe("completed");
    // A real commit landed (HEAD advanced) but only out-of-scope files changed.
    expect(git(r.repo, ["rev-parse", "HEAD"])).not.toBe(r.baselineHead);
    const changed = git(r.repo, ["diff", "--name-only", r.baselineHead, "HEAD"]);
    expect(changed).toContain("other/x.ts");
  });

  // VAL-DISPATCH-008
  it("a pre-existing/foreign DB session does not count — must be created by THIS dispatch", async () => {
    const r = await runDispatch(
      {
        writeDb: false, // this dispatch creates NO new conversation
        gitFile: "src/feature.ts",
        seedConversation: { id: "foreign-conv", items: 3, createdAt: 1000 },
      },
      dir,
    );
    expect(r.entry.state).not.toBe("completed");
    const states = ledgerStates(r.ledgerPath, r.dispatchId);
    expect(states).not.toContain("db_session_observed");
    expect(states).not.toContain("completed");
  });

  // VAL-DISPATCH-009
  it("the required git delta is measured against the pre-dispatch baseline", async () => {
    const r = await runDispatch(
      {
        writeDb: true,
        transcriptItems: 1,
        preDirtyFile: "src/already-dirty.ts", // in-scope change present BEFORE dispatch
        // no gitFile → this dispatch performs no new mutation
      },
      dir,
    );
    expect(r.entry.state).not.toBe("completed");
    // HEAD is unchanged; the pre-existing dirty file is not this dispatch's delta.
    expect(git(r.repo, ["rev-parse", "HEAD"])).toBe(r.baselineHead);
    expect(ledgerStates(r.ledgerPath, r.dispatchId)).not.toContain("completed");
  });
});
