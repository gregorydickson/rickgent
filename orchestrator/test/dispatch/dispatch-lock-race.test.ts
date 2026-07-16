import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";

// Control flag (hoisted so the fs mock factory can close over it) that forces
// a `.lock` read to throw ENOENT, simulating a concurrent release removing the
// lock file between existsSync() and readFileSync() inside acquire().
const ctrl = vi.hoisted(() => ({ simulateLockEnoent: false }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (ctrl.simulateLockEnoent && typeof path === "string" && path.endsWith(".lock")) {
        ctrl.simulateLockEnoent = false;
        actual.rmSync(path, { force: true });
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    },
  };
});

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { DispatchLedger, TicketLock, Dispatcher, dispatchIdString, type DispatchId } from "../../dist-fixture/dispatch/dispatch.js";
import type { ReadyRunWorkspace } from "../../src/git/run-workspace.js";

function makeId(ticketId = "T-1"): DispatchId {
  return { runId: "run-1", ticketId, phase: "implement", attempt: 1, role: "worker" };
}

describe("TicketLock concurrent-release race (VAL-BUG-013)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rickgent-lock-race-"));
  });

  afterEach(() => {
    ctrl.simulateLockEnoent = false;
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquire() does not throw when the lock file is removed between existsSync and read", () => {
    const lock = new TicketLock(dir);
    writeFileSync(join(dir, "T-1.lock"), String(Date.now()));
    ctrl.simulateLockEnoent = true;
    // The read races with a concurrent release — acquire must handle it, not throw.
    expect(lock.acquire("T-1")).toBe(true);
    // The first call owns the replacement. A second acquire cannot steal it.
    expect(lock.acquire("T-1")).toBe(false);
  });

  it("dispatch() does not reject when a concurrent release removes the lock during acquire", async () => {
    const ledger = new DispatchLedger(join(dir, "ledger.jsonl"));
    const lock = new TicketLock(join(dir, "locks"));
    writeFileSync(join(dir, "locks", "T-1.lock"), String(Date.now()));
    const dispatcher = new Dispatcher(ledger, lock, dir);
    const id = makeId("T-1");

    ctrl.simulateLockEnoent = true;
    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
      workspace: {} as ReadyRunWorkspace,
      materializationRoot: join(dir, "materialized"),
    });
    expect(result.dispatchId).toBe(dispatchIdString(id));
    expect(result.state).toBe("failed");
  });
});
