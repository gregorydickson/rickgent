import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";

// Control (hoisted so the fs mock factory can close over it) that forces a
// `.lock` read to throw a chosen errno, simulating either a concurrent-release
// ENOENT race or a genuine read failure (EACCES/EIO) during acquire().
const ctrl = vi.hoisted(() => ({
  errorCode: null as string | null,
  partialWriteBytes: null as number | null,
  partialWriteStarted: false,
  failFsync: false,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (ctrl.errorCode && typeof path === "string" && path.endsWith(".lock")) {
        if (ctrl.errorCode === "ENOENT") actual.rmSync(path, { force: true });
        const err = new Error(`${ctrl.errorCode}: simulated read failure '${path}'`) as NodeJS.ErrnoException;
        err.code = ctrl.errorCode;
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    },
    writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => {
      const write = actual.writeSync as unknown as (
        descriptor: number,
        bytes: Uint8Array,
        start: number,
        count: number,
      ) => number;
      if (ctrl.partialWriteBytes !== null) {
        if (ctrl.partialWriteStarted) {
          const error = Object.assign(new Error("ENOSPC: injected cleanup marker write failure"), {
            code: "ENOSPC",
          });
          throw error;
        }
        ctrl.partialWriteStarted = true;
        return write(fd, buffer, offset, Math.min(length, ctrl.partialWriteBytes));
      }
      return write(fd, buffer, offset, length);
    },
    fsyncSync: (fd: number) => {
      if (ctrl.failFsync) {
        const error = Object.assign(new Error("EIO: injected cleanup marker fsync failure"), {
          code: "EIO",
        });
        throw error;
      }
      return actual.fsyncSync(fd);
    },
  };
});

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { TicketLock } from "../../src/dispatch/dispatch.js";

describe("TicketLock.acquire() fails closed on non-ENOENT read errors (A-BUG-4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rickgent-lock-failclosed-"));
  });

  afterEach(() => {
    ctrl.errorCode = null;
    ctrl.partialWriteBytes = null;
    ctrl.partialWriteStarted = false;
    ctrl.failFsync = false;
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT grant the lock when the read fails with EACCES (fail closed)", () => {
    const lock = new TicketLock(dir);
    const lockPath = join(dir, "T-1.lock");
    const original = String(Date.now());
    writeFileSync(lockPath, original);

    ctrl.errorCode = "EACCES";
    expect(lock.acquire("T-1")).toBe(false);

    ctrl.errorCode = null;
    // Ownership was not granted: the existing lock content is left untouched.
    expect(readFileSync(lockPath, "utf-8")).toBe(original);
  });

  it("does NOT grant the lock when the read fails with EIO (fail closed)", () => {
    const lock = new TicketLock(dir);
    writeFileSync(join(dir, "T-2.lock"), String(Date.now()));

    ctrl.errorCode = "EIO";
    expect(lock.acquire("T-2")).toBe(false);
  });

  it("still takes the ticket on a concurrent-release ENOENT race", () => {
    const lock = new TicketLock(dir);
    writeFileSync(join(dir, "T-3.lock"), String(Date.now()));

    ctrl.errorCode = "ENOENT";
    expect(lock.acquire("T-3")).toBe(true);
    ctrl.errorCode = null;
    expect(lock.acquire("T-3")).toBe(false);
  });

  it("does not steal empty or corrupt authority records", () => {
    const lock = new TicketLock(dir);
    writeFileSync(join(dir, "T-4.lock"), "");
    expect(lock.acquire("T-4")).toBe(false);

    writeFileSync(join(dir, "T-5.lock"), "not-a-number");
    expect(lock.acquire("T-5")).toBe(false);
  });

  it("does NOT steal a live owner-bound lock", () => {
    expect(new TicketLock(dir).acquire("T-6")).toBe(true);
    expect(new TicketLock(dir).acquire("T-6")).toBe(false);
  });

  it("retains a crash-partial cleanup marker after a short write", () => {
    const owner = new TicketLock(dir);
    expect(owner.acquire("T-7")).toBe(true);
    ctrl.partialWriteBytes = 8;
    expect(owner.markCleanupPending("T-7")).toBe(false);
    ctrl.partialWriteBytes = null;
    expect(readFileSync(join(dir, "T-7.lock"), "utf8").length).toBeGreaterThan(0);
    expect(new TicketLock(dir).acquire("T-7")).toBe(false);
  });

  it("retains authority when cleanup marker fsync fails", () => {
    const owner = new TicketLock(dir);
    expect(owner.acquire("T-8")).toBe(true);
    ctrl.failFsync = true;
    expect(owner.markCleanupPending("T-8")).toBe(false);
    ctrl.failFsync = false;
    expect(new TicketLock(dir).acquire("T-8")).toBe(false);
  });
});
