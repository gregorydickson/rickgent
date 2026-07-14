// B3 — backpressure queue (VAL-QUEUE-001/002/003/005).
//
// Drives the REAL DispatchQueue scheduler and observes REAL effects: the peak
// simultaneous active count, the FIFO spawn order, the durable ledger states,
// and that a slot frees the instant a dispatch settles (success OR failure).
// The dispatch function is a controllable stand-in whose concurrency the
// scheduler governs — the scheduling logic under test is production code, not a
// mock's return value.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DispatchLedger,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
} from "../../src/dispatch/dispatch.js";
import { DispatchQueue } from "../../src/dispatch/queue.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rickgent-queue-"));
}

function makeId(ticketId: string): DispatchId {
  return { runId: "run-q", ticketId, phase: "implement", attempt: 1, role: "worker" };
}

function terminalEntry(idStr: string, state: DispatchEntry["state"]): DispatchEntry {
  return {
    dispatchId: idStr,
    state,
    pid: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: state === "completed" ? 0 : 1,
    stdout: null,
    stderr: null,
  };
}

/** Sleep a few microtasks/ticks so concurrent dispatches genuinely overlap. */
function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("DispatchQueue backpressure (B3)", () => {
  let dir: string;
  let ledger: DispatchLedger;

  beforeEach(() => {
    dir = tmpDir();
    ledger = new DispatchLedger(join(dir, "ledger.jsonl"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function latestStateByTicket(): Record<string, string> {
    const raw = readFileSync(join(dir, "ledger.jsonl"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as DispatchEntry;
      out[e.dispatchId] = e.state;
    }
    return out;
  }

  // VAL-QUEUE-003 + VAL-QUEUE-001: 5 tickets, 2 slots — the cap is never
  // exceeded, concurrency actually reaches the cap, and all 5 drain (none left
  // stuck 'planned').
  it("drains 5 tickets under a 2-slot cap, never exceeding the cap, none left planned", async () => {
    const ids = ["T1", "T2", "T3", "T4", "T5"].map(makeId);
    const queue = new DispatchQueue(ledger, 2);
    for (const id of ids) queue.enqueue(id);

    let active = 0;
    let peak = 0;
    const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
      active++;
      if (active > peak) peak = active;
      expect(active).toBeLessThanOrEqual(2); // cap never exceeded, observed live
      await tick();
      const entry = terminalEntry(dispatchIdString(id), "completed");
      ledger.append(entry); // the real Dispatcher writes spawned→terminal; simulate it
      active--;
      return entry;
    };

    const result = await queue.drain(dispatchFn);

    expect(peak).toBe(2); // concurrency genuinely reached the cap
    expect(result.maxActiveObserved).toBe(2);
    expect(result.results.size).toBe(5);
    for (const id of ids) {
      const entry = result.results.get(dispatchIdString(id));
      expect(entry?.state).toBe("completed");
    }
    // Ledger truth: every ticket's latest state is beyond 'planned'.
    const latest = latestStateByTicket();
    for (const id of ids) {
      expect(latest[dispatchIdString(id)]).not.toBe("planned");
    }
  });

  // VAL-QUEUE-002: queued tickets drain in FIFO (enqueue) order.
  it("spawns queued tickets in FIFO (enqueue) order", async () => {
    const ids = ["A", "B", "C", "D", "E"].map(makeId);
    const queue = new DispatchQueue(ledger, 2);
    for (const id of ids) queue.enqueue(id);

    const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
      await tick();
      return terminalEntry(dispatchIdString(id), "completed");
    };

    const result = await queue.drain(dispatchFn);
    expect(result.spawnOrder).toEqual(ids.map(dispatchIdString));
  });

  // VAL-QUEUE-005: a failing dispatch frees its slot and the queue keeps
  // draining; no ticket is left permanently 'planned'.
  it("frees the slot of a failing dispatch and keeps draining the queue", async () => {
    const ids = ["T1", "T2", "T3", "T4", "T5"].map(makeId);
    const queue = new DispatchQueue(ledger, 2);
    for (const id of ids) queue.enqueue(id);

    let active = 0;
    let peak = 0;
    const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
      active++;
      if (active > peak) peak = active;
      expect(active).toBeLessThanOrEqual(2);
      await tick();
      const failing = id.ticketId === "T2";
      const entry = terminalEntry(dispatchIdString(id), failing ? "failed" : "completed");
      ledger.append(entry);
      active--;
      return entry;
    };

    const result = await queue.drain(dispatchFn);

    // All five settled — the failing T2 did not wedge a slot.
    expect(result.results.size).toBe(5);
    expect(result.results.get(dispatchIdString(makeId("T2")))?.state).toBe("failed");
    const drained = ids.filter(
      (id) => result.results.get(dispatchIdString(id))?.state === "completed",
    );
    expect(drained.length).toBe(4); // the other four drained past the failure
    expect(peak).toBe(2);
    const latest = latestStateByTicket();
    for (const id of ids) {
      expect(latest[dispatchIdString(id)]).not.toBe("planned");
    }
  });

  // VAL-QUEUE-005 (fail-closed): a dispatchFn that THROWS still frees its slot
  // and is recorded as a failed terminal entry, not left in flight forever.
  it("a throwing dispatch is recorded failed and its slot is freed", async () => {
    const ids = ["T1", "T2", "T3"].map(makeId);
    const queue = new DispatchQueue(ledger, 2);
    for (const id of ids) queue.enqueue(id);

    const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
      await tick();
      if (id.ticketId === "T1") throw new Error("boom");
      return terminalEntry(dispatchIdString(id), "completed");
    };

    const result = await queue.drain(dispatchFn);
    expect(result.results.size).toBe(3);
    expect(result.results.get(dispatchIdString(makeId("T1")))?.state).toBe("failed");
    expect(result.results.get(dispatchIdString(makeId("T2")))?.state).toBe("completed");
    expect(result.results.get(dispatchIdString(makeId("T3")))?.state).toBe("completed");
  });

  it("enqueue records a durable 'planned' ledger entry for each ticket (resume-visible)", () => {
    const ids = ["T1", "T2", "T3"].map(makeId);
    const queue = new DispatchQueue(ledger, 2);
    for (const id of ids) queue.enqueue(id);
    for (const id of ids) {
      const found = ledger.find(dispatchIdString(id));
      expect(found?.state).toBe("planned");
    }
  });
});
