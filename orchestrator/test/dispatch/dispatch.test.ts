import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DispatchLedger,
  TicketLock,
  Dispatcher,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
} from "../../src/dispatch/dispatch.js";

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

  it("does not apply backpressure when under maxConcurrent", async () => {
    const id = makeId();

    // maxConcurrent=1, active=0 → should attempt to spawn (will fail since omnigent not installed)
    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
    });

    // Should not be "planned" — it should have attempted spawn
    expect(result.state).not.toBe("planned");
    // The spawned entry should be in the ledger
    const raw = readFileSync(join(dir, "ledger.jsonl"), "utf-8");
    expect(raw).toContain("spawned");
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
});
