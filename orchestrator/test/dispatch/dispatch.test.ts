import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
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

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initFixtureRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

/** Read the ordered list of states for a dispatchId from the ledger. */
function ledgerStates(ledgerPath: string, dispatchId: string): string[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => JSON.parse(l) as DispatchEntry)
    .filter((e) => e.dispatchId === dispatchId)
    .map((e) => e.state);
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rickgent-dispatch-${prefix}-`));
}

function makeId(ticketId = "T-1"): DispatchId {
  return {
    runId: "run-1",
    ticketId,
    phase: "implement",
    attempt: 1,
    role: "worker",
  };
}

function makeTerminalEntry(dispatchId: string, state: DispatchEntry["state"]): DispatchEntry {
  return {
    dispatchId,
    state,
    pid: 12345,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:10:00.000Z",
    exitCode: 0,
    stdout: "done",
    stderr: null,
  };
}

describe("DispatchLedger", () => {
  let dir: string;
  let ledgerPath: string;
  let ledger: DispatchLedger;

  beforeEach(() => {
    dir = tmpDir("ledger");
    ledgerPath = join(dir, "ledger.jsonl");
    ledger = new DispatchLedger(ledgerPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends entries and finds the most recent by dispatchId", () => {
    const id = "run-1/T-1/implement/1/worker";
    ledger.append(makeTerminalEntry(id, "spawned"));
    ledger.append(makeTerminalEntry(id, "completed"));

    const found = ledger.find(id);
    expect(found).not.toBeNull();
    expect(found!.state).toBe("completed");
  });

  it("returns null when dispatchId not present", () => {
    ledger.append(makeTerminalEntry("run-1/T-1/implement/1/worker", "completed"));
    expect(ledger.find("run-1/T-2/implement/1/worker")).toBeNull();
  });

  it("returns null when ledger file does not exist", () => {
    const fresh = new DispatchLedger(join(dir, "missing.jsonl"));
    expect(fresh.find("any")).toBeNull();
  });

  it("isTerminal returns true only for terminal states", () => {
    const id = "run-1/T-1/implement/1/worker";
    ledger.append(makeTerminalEntry(id, "completed"));
    expect(ledger.isTerminal(id)).toBe(true);

    const id2 = "run-1/T-2/implement/1/worker";
    ledger.append(makeTerminalEntry(id2, "spawned"));
    expect(ledger.isTerminal(id2)).toBe(false);
  });

  it("isTerminal returns false for unknown dispatchId", () => {
    expect(ledger.isTerminal("nonexistent")).toBe(false);
  });

  it("skips malformed lines without crashing", () => {
    // Manually write a malformed line followed by a valid one
    appendFileSync(ledgerPath, "NOT JSON\n");
    const id = "run-1/T-1/implement/1/worker";
    ledger.append(makeTerminalEntry(id, "completed"));
    const found = ledger.find(id);
    expect(found).not.toBeNull();
    expect(found!.state).toBe("completed");
  });
});

describe("TicketLock", () => {
  let dir: string;
  let lock: TicketLock;

  beforeEach(() => {
    dir = tmpDir("lock");
    lock = new TicketLock(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a lock for an unlocked ticket", () => {
    expect(lock.acquire("T-1")).toBe(true);
    expect(existsSync(join(dir, "T-1.lock"))).toBe(true);
  });

  it("rejects a second acquire for the same ticket", () => {
    expect(lock.acquire("T-1")).toBe(true);
    expect(lock.acquire("T-1")).toBe(false);
  });

  it("acquires different tickets independently", () => {
    expect(lock.acquire("T-1")).toBe(true);
    expect(lock.acquire("T-2")).toBe(true);
  });

  it("takes over a stale lock after timeout", () => {
    expect(lock.acquire("T-1", 5000)).toBe(true);
    // Wait past timeout
    const lockPath = join(dir, "T-1.lock");
    const staleTime = String(Date.now() - 6000);
    writeFileSync(lockPath, staleTime);
    expect(lock.acquire("T-1", 5000)).toBe(true);
  });

  it("release does not throw for unknown ticket", () => {
    expect(() => lock.release("T-unknown")).not.toThrow();
  });

  // VAL-BUG-011 (A-BUG-4): an empty lock file parses to NaN and must be
  // treated as stale, not wedged forever.
  it("treats an empty lock file as stale and takes it", () => {
    const lockPath = join(dir, "T-1.lock");
    writeFileSync(lockPath, "");
    expect(lock.acquire("T-1")).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).not.toBe("");
  });

  // VAL-BUG-012 (A-BUG-4): a corrupt/non-numeric lock file parses to NaN and
  // must be treated as stale.
  it("treats a corrupt (non-numeric) lock file as stale and takes it", () => {
    const lockPath = join(dir, "T-1.lock");
    writeFileSync(lockPath, "not-a-number-garbage");
    expect(lock.acquire("T-1")).toBe(true);
    expect(Number.isNaN(parseInt(readFileSync(lockPath, "utf-8"), 10))).toBe(false);
  });

  // VAL-BUG-024 (A-BUG-9): a lock aged within a normal worker lifetime is not
  // stale under the default staleness policy.
  it("does not steal a lock aged within a normal worker lifetime (default staleness)", () => {
    const lockPath = join(dir, "T-1.lock");
    // Aged 60s — well under a ~1200s worker lifetime, but far past the old 5s default.
    const stamp = String(Date.now() - 60_000);
    writeFileSync(lockPath, stamp);
    expect(lock.acquire("T-1")).toBe(false);
    // The live lock must not have been overwritten (stolen).
    expect(readFileSync(lockPath, "utf-8")).toBe(stamp);
  });

  // VAL-BUG-026 (A-BUG-4 + A-BUG-9): the staleness policy distinguishes a
  // NaN/corrupt lock (stealable) from a valid recent lock (not stealable).
  it("steals a corrupt lock but not a valid recent lock, in one suite", () => {
    const corruptPath = join(dir, "T-corrupt.lock");
    writeFileSync(corruptPath, "xyz");
    expect(lock.acquire("T-corrupt")).toBe(true);

    const livePath = join(dir, "T-live.lock");
    const liveStamp = String(Date.now() - 60_000);
    writeFileSync(livePath, liveStamp);
    expect(lock.acquire("T-live")).toBe(false);
    expect(readFileSync(livePath, "utf-8")).toBe(liveStamp);
  });
});

describe("Dispatcher idempotency", () => {
  let dir: string;
  let ledger: DispatchLedger;
  let lock: TicketLock;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dir = tmpDir("idem");
    ledger = new DispatchLedger(join(dir, "ledger.jsonl"));
    lock = new TicketLock(join(dir, "locks"));
    dispatcher = new Dispatcher(ledger, lock, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns recorded terminal state without re-spawning", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    const terminal = makeTerminalEntry(idStr, "completed");
    ledger.append(terminal);

    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 2,
    });

    expect(result.state).toBe("completed");
    expect(result.exitCode).toBe(0);
    // Should not have spawned — active count stays 0
    expect(dispatcher.activeCount).toBe(0);
  });

  it("returns recorded failed state as terminal", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    ledger.append(makeTerminalEntry(idStr, "failed"));

    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 2,
    });

    expect(result.state).toBe("failed");
    expect(dispatcher.activeCount).toBe(0);
  });

  it("returns recorded timed_out state as terminal", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    ledger.append(makeTerminalEntry(idStr, "timed_out"));

    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 2,
    });

    expect(result.state).toBe("timed_out");
    expect(dispatcher.activeCount).toBe(0);
  });
});

describe("Dispatcher backpressure", () => {
  let dir: string;
  let ledger: DispatchLedger;
  let lock: TicketLock;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dir = tmpDir("bp");
    ledger = new DispatchLedger(join(dir, "ledger.jsonl"));
    lock = new TicketLock(join(dir, "locks"));
    dispatcher = new Dispatcher(ledger, lock, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records planned state and does not spawn when maxConcurrent is 0", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);

    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 0,
    });

    expect(result.state).toBe("planned");
    expect(result.pid).toBeNull();
    // Should not have spawned
    expect(dispatcher.activeCount).toBe(0);

    // Ledger should contain the planned entry
    const found = ledger.find(idStr);
    expect(found).not.toBeNull();
    expect(found!.state).toBe("planned");
  });

  // VAL-TESTINT-002: The under-capacity dispatch test uses a DETERMINISTIC
  // fixture omnigent on PATH (not the absent real binary) and asserts the FULL
  // legal transition sequence, not "pass-on-spawn-failure." The old test passed
  // when spawn failed (omnigent not installed) by merely checking state !==
  // "planned" and a "spawned" substring — a pass-on-nothing anti-pattern.
  it("under-capacity dispatch drives the full success transition sequence via fixture omnigent", async () => {
    const repo = join(dir, "repo");
    initFixtureRepo(repo);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });

    // Put the fixture omnigent ahead of everything on PATH so the Dispatcher
    // spawns IT, not the absent real binary. If the fixture is missing, spawn
    // fails and this test FAILS (does not pass on spawn failure).
    const fixtureEnv: Record<string, string> = {
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      OMNIGENT_DATA_DIR: dataDir,
      FIXTURE_TARGET_REPO: repo,
      FIXTURE_WRITE_DB: "1",
      FIXTURE_TRANSCRIPT_ITEMS: "2",
      FIXTURE_GIT_FILE: "src/feature.ts",
      FIXTURE_EXIT_CODE: "0",
    };

    // env vars are passed via the dispatch `env` option (not process.env) to
    // avoid cross-test contamination in vitest's thread pool.
    const id = makeId();
    const idStr = dispatchIdString(id);
    const entry = await dispatcher.dispatch(id, {
      agentDir: join(dir, "agent"),
      prompt: "do work",
      timeout: 20000,
      maxConcurrent: 2,
      targetRepo: repo,
      dataDir,
      declaredPaths: ["src"],
      env: fixtureEnv,
    });

    // The dispatch must NOT be "planned" — it spawned the fixture.
    expect(entry.state).not.toBe("planned");
    // The terminal state must be "completed" — the fixture produced a DB
    // session, transcript, and in-scope git delta.
    expect(entry.state).toBe("completed");
    expect(entry.exitCode).toBe(0);

    // Assert the FULL ordered transition sequence, not just a "spawned"
    // substring. The legal sequence for a successful dispatch is:
    //   spawned → db_session_observed → completed
    const states = ledgerStates(join(dir, "ledger.jsonl"), idStr);
    expect(states).toEqual(["spawned", "db_session_observed", "completed"]);

    // Git-tree-truth: HEAD advanced (the fixture committed an in-scope file).
    const changed = git(repo, ["diff", "--name-only", "HEAD~1", "HEAD"]);
    expect(changed).toContain("src/feature.ts");
  });

  // VAL-TESTINT-002 (failure/recovery branch): the under-capacity dispatch
  // also asserts a failure/recovery transition sequence via the fixture
  // omnigent. A fixture worker configured to exit non-zero drives:
  //   spawned → failed
  // This proves the test does not pass-on-spawn-failure and observes the REAL
  // terminal state the Dispatcher records for a genuinely failing worker.
  it("under-capacity dispatch drives the failure transition sequence via fixture omnigent", async () => {
    const repo = join(dir, "repo");
    initFixtureRepo(repo);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });

    const fixtureEnv: Record<string, string> = {
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      OMNIGENT_DATA_DIR: dataDir,
      FIXTURE_TARGET_REPO: repo,
      FIXTURE_WRITE_DB: "1",
      FIXTURE_TRANSCRIPT_ITEMS: "1",
      // No git file → no in-scope delta, and exit 1 → the evidence check fails.
      FIXTURE_EXIT_CODE: "1",
    };

    // env vars are passed via the dispatch `env` option (not process.env) to
    // avoid cross-test contamination in vitest's thread pool.
    const id = makeId();
    const idStr = dispatchIdString(id);
    const entry = await dispatcher.dispatch(id, {
      agentDir: join(dir, "agent"),
      prompt: "do work",
      timeout: 20000,
      maxConcurrent: 2,
      targetRepo: repo,
      dataDir,
      declaredPaths: ["src"],
      env: fixtureEnv,
    });

    // The dispatch spawned (not planned) and reached the "failed" terminal.
    expect(entry.state).not.toBe("planned");
    expect(entry.state).toBe("failed");
    expect(entry.exitCode).toBe(1);

    // Assert the FULL ordered transition sequence for a failing dispatch:
    //   spawned → failed
    // (No db_session_observed or completed because exit ≠ 0 short-circuits.)
    const states = ledgerStates(join(dir, "ledger.jsonl"), idStr);
    expect(states).toEqual(["spawned", "failed"]);
  });

  // VAL-TESTINT-002 (no-pass-on-spawn-failure): with the fixture omnigent
  // intentionally NOT on PATH, the dispatch spawn fails. The test must NOT
  // pass by merely checking "not planned" + "spawned" — it must assert a
  // specific terminal state that only a REAL fixture run could produce. This
  // test confirms the anti-pattern is gone: when the fixture is absent, the
  // failure is observable as "failed" (not silently "completed").
  it("fails closed (failed, not completed) when the fixture omnigent is absent from PATH", async () => {
    // Ensure NO omnigent (fixture OR real) is reachable: use a minimal PATH
    // that excludes the fixture dir AND any real omnigent install (e.g. pyenv
    // shims), so spawn('omnigent') gets an immediate ENOENT -> "failed"
    // deterministically, with no race against the timeout under full-suite load.
    // Pass via the dispatch `env` option (not process.env) to avoid cross-test
    // contamination in vitest's thread pool.
    const fixtureEnv: Record<string, string> = {
      PATH: "/usr/bin:/bin",
    };

    const id = makeId();
    const entry = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 2000,
      maxConcurrent: 2,
      env: fixtureEnv,
    });

    // Spawn failed (no omnigent binary) → "failed", NOT "completed".
    // The old test would have passed here (state !== "planned" + "spawned"
    // substring). The new test asserts the SPECIFIC terminal: "failed".
    expect(entry.state).toBe("failed");
  });
});

describe("Dispatcher lock failure", () => {
  let dir: string;
  let ledger: DispatchLedger;
  let lock: TicketLock;

  beforeEach(() => {
    dir = tmpDir("lockfail");
    ledger = new DispatchLedger(join(dir, "ledger.jsonl"));
    lock = new TicketLock(join(dir, "locks"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when ticket lock is held", async () => {
    // Pre-acquire the lock with a separate lock instance
    const otherLock = new TicketLock(join(dir, "locks"));
    otherLock.acquire("T-1");

    const dispatcher = new Dispatcher(ledger, lock, dir);
    const id = makeId("T-1");
    const idStr = dispatchIdString(id);

    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 2,
    });

    expect(result.state).toBe("failed");
    expect(result.stderr).toBe("could not acquire ticket lock");
    expect(ledger.find(idStr)?.state).toBe("failed");
  });

  // VAL-BUG-025 (A-BUG-9): while dispatch A legitimately holds ticket T within
  // a normal worker lifetime, dispatch B must NOT steal the lock and spawn a
  // second worker. B's dispatch must fail closed on the lock, not proceed to spawn.
  it("does not let a second worker run a ticket held within a normal worker lifetime", async () => {
    const lockPath = join(dir, "locks", "T-1.lock");
    // Worker A acquired 60s ago and is still running (well under a ~1200s lifetime).
    const liveStamp = String(Date.now() - 60_000);
    writeFileSync(lockPath, liveStamp);

    const dispatcher = new Dispatcher(ledger, lock, dir);
    const id = makeId("T-1");

    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 2,
    });

    // Fail closed on the lock — the specific lock stderr proves B did not steal
    // the lock and fall through to spawning (which would yield a spawn error).
    expect(result.state).toBe("failed");
    expect(result.stderr).toBe("could not acquire ticket lock");
    // A's live lock must be untouched.
    expect(readFileSync(lockPath, "utf-8")).toBe(liveStamp);
  });
});
