import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  DispatchLedger,
  InMemoryDispatchJournal,
  TicketLock,
  Dispatcher,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
} from "../../dist-fixture/dispatch/dispatch.js";
import type { ReadyRunWorkspace } from "../../src/git/run-workspace.js";
import type { AllocatedAttempt } from "../../src/state/store.js";
import type { TicketContract } from "../../src/contracts/ticket-contract.js";

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

function allocatedAttempt(overrides: Partial<AllocatedAttempt> = {}): AllocatedAttempt {
  return {
    runnable: false,
    attemptId: "attempt-1",
    ticketInstanceId: "ticket-instance-1",
    runId: "run-1",
    ticketId: "T-1",
    attemptNumber: 1,
    contractDigest: "sha256:contract",
    allocationOwnerDigest: "sha256:owner",
    deliveryBaselineOid: "a".repeat(40),
    contextSchemaVersion: "1",
    oracleVersion: "1",
    capabilitySnapshotDigest: "sha256:capability",
    resourceIdentityVersion: "1",
    state: "planned",
    stateVersion: 0,
    ...overrides,
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

  it("never reclaims an aged active lock without an explicit recovery owner", () => {
    expect(lock.acquire("T-1")).toBe(true);
    const lockPath = join(dir, "T-1.lock");
    const lines = readFileSync(lockPath, "utf8").split("\n");
    lines[0] = String(Date.now() - 10_000_000);
    writeFileSync(lockPath, lines.join("\n"));
    expect(new TicketLock(dir).acquire("T-1")).toBe(false);
  });

  it("release does not throw for unknown ticket", () => {
    expect(() => lock.release("T-unknown")).not.toThrow();
  });

  it("release is owner-bound and cannot remove another instance's lock", () => {
    expect(lock.acquire("T-1")).toBe(true);
    const intruder = new TicketLock(dir);
    intruder.release("T-1");
    expect(existsSync(join(dir, "T-1.lock"))).toBe(true);
    lock.release("T-1");
    expect(existsSync(join(dir, "T-1.lock"))).toBe(false);
  });

  it("never reclaims a cleanup-pending lock by age", () => {
    expect(lock.acquire("T-1")).toBe(true);
    expect(lock.markCleanupPending("T-1")).toBe(true);
    const lockPath = join(dir, "T-1.lock");
    const lines = readFileSync(lockPath, "utf8").split("\n");
    lines[0] = String(Date.now() - 10_000_000);
    writeFileSync(lockPath, lines.join("\n"));
    expect(new TicketLock(dir).acquire("T-1")).toBe(false);
  });

  // VAL-BUG-011 (A-BUG-4): an empty record can be a crash-truncated cleanup
  // sentinel and must remain fail-closed until explicit recovery.
  it("does not reclaim an empty lock file", () => {
    const lockPath = join(dir, "T-1.lock");
    writeFileSync(lockPath, "");
    expect(lock.acquire("T-1")).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe("");
  });

  // VAL-BUG-012 (A-BUG-4): partial/corrupt authority is retained rather than
  // interpreted as absence.
  it("does not reclaim a corrupt lock file", () => {
    const lockPath = join(dir, "T-1.lock");
    writeFileSync(lockPath, "not-a-number-garbage");
    expect(lock.acquire("T-1")).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe("not-a-number-garbage");
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

  // VAL-BUG-026 (A-BUG-4 + A-BUG-9): neither corrupt nor valid extant
  // authority can be stolen without the later recovery protocol.
  it("does not steal corrupt or valid extant locks", () => {
    const corruptPath = join(dir, "T-corrupt.lock");
    writeFileSync(corruptPath, "xyz");
    expect(lock.acquire("T-corrupt")).toBe(false);

    const livePath = join(dir, "T-live.lock");
    const liveStamp = String(Date.now() - 60_000);
    writeFileSync(livePath, liveStamp);
    expect(lock.acquire("T-live")).toBe(false);
    expect(readFileSync(livePath, "utf-8")).toBe(liveStamp);
  });
});

describe("Dispatcher diagnostic ledger non-authority", () => {
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

  it("does not replay a recorded completed row", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    const terminal = makeTerminalEntry(idStr, "completed");
    ledger.append(terminal);

    await expect(dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
    })).rejects.toThrow(/verified run workspace/i);
    expect(dispatcher.activeCount).toBe(0);
  });

  it("does not replay a recorded failed row", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    ledger.append(makeTerminalEntry(idStr, "failed"));

    await expect(dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
    })).rejects.toThrow(/verified run workspace/i);
    expect(dispatcher.activeCount).toBe(0);
  });

  it("does not replay a recorded timed_out row", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    ledger.append(makeTerminalEntry(idStr, "timed_out"));

    await expect(dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
    })).rejects.toThrow(/verified run workspace/i);
    expect(dispatcher.activeCount).toBe(0);
  });

  it("requires the diagnostic dispatch id to match its canonical allocation", async () => {
    const journal = new InMemoryDispatchJournal();
    const canonicalDispatcher = new Dispatcher(journal, dir);

    await expect(canonicalDispatcher.dispatch(makeId(), {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
      attempt: allocatedAttempt({ runId: "different-run" }),
    })).rejects.toThrow(/diagnostic dispatch identity differs/i);
    expect(journal.observations()).toEqual([]);
  });

  it("rejects a changed ticket contract instead of treating its allocation as a cache hit", async () => {
    const journal = new InMemoryDispatchJournal();
    const canonicalDispatcher = new Dispatcher(journal, dir);
    const attempt = allocatedAttempt();
    const changedContract = { id: attempt.ticketId, digest: "sha256:changed" } as TicketContract;

    await expect(canonicalDispatcher.dispatch(makeId(), {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
      attempt,
      ticket: changedContract,
    })).rejects.toThrow(/ticket contract differs/i);
    expect(journal.observations()).toEqual([]);
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

  it("rejects maxConcurrent 0 before ledger or spawn side effects", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);

    await expect(dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 0,
    })).rejects.toThrow("maxConcurrent must be exactly 1");
    expect(dispatcher.activeCount).toBe(0);
    expect(ledger.find(idStr)).toBeNull();
  });

  it("records planned state without spawning when the legal sequential slot is occupied", async () => {
    const id = makeId();
    const idStr = dispatchIdString(id);
    const materializationRoot = join(dir, "materialized");
    (dispatcher as unknown as { active: number }).active = 1;

    const result = await dispatcher.dispatch(id, {
      agentDir: join(dir, "agent"),
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
      workspace: {} as ReadyRunWorkspace,
      materializationRoot,
    });

    expect(result).toMatchObject({ state: "planned", pid: null, startedAt: null });
    expect(dispatcher.activeCount).toBe(1);
    expect(ledger.find(idStr)).toMatchObject({ state: "planned", pid: null });
    expect(existsSync(materializationRoot)).toBe(false);
  });

  it("does not preserve a caller-repository or raw-agent compatibility spawn path", async () => {
    const repo = join(dir, "repo");
    initFixtureRepo(repo);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const fixtureEnv: Record<string, string> = {
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      OMNIGENT_DATA_DIR: dataDir,
      FIXTURE_TARGET_REPO: repo,
      FIXTURE_WRITE_DB: "1",
      FIXTURE_TRANSCRIPT_ITEMS: "2",
      FIXTURE_GIT_FILE: "src/feature.ts",
      FIXTURE_EXIT_CODE: "0",
    };
    const id = makeId();
    const idStr = dispatchIdString(id);
    await expect(dispatcher.dispatch(id, {
      agentDir: join(dir, "agent"),
      prompt: "do work",
      timeout: 20000,
      maxConcurrent: 1,
      dataDir,
      declaredPaths: ["src"],
      env: fixtureEnv,
    })).rejects.toThrow("verified run workspace");
    expect(ledger.find(idStr)).toBeNull();
    expect(git(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
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

  // Lock denial happens before the dispatcher dereferences workspace identity.
  const unreachableWorkspace = {} as ReadyRunWorkspace;

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
      maxConcurrent: 1,
      workspace: unreachableWorkspace,
      materializationRoot: join(dir, "materialized"),
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
      maxConcurrent: 1,
      workspace: unreachableWorkspace,
      materializationRoot: join(dir, "materialized"),
    });

    // Fail closed on the lock — the specific lock stderr proves B did not steal
    // the lock and fall through to spawning (which would yield a spawn error).
    expect(result.state).toBe("failed");
    expect(result.stderr).toBe("could not acquire ticket lock");
    // A's live lock must be untouched.
    expect(readFileSync(lockPath, "utf-8")).toBe(liveStamp);
  });
});
