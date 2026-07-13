import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";

// Control (hoisted so the fs mock factory can close over it) that forces a
// `.lock` read to throw a chosen errno, simulating either a concurrent-release
// ENOENT race or a genuine read failure (EACCES/EIO) during acquire().
const ctrl = vi.hoisted(() => ({ errorCode: null as string | null }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (ctrl.errorCode && typeof path === "string" && path.endsWith(".lock")) {
        const err = new Error(`${ctrl.errorCode}: simulated read failure '${path}'`) as NodeJS.ErrnoException;
        err.code = ctrl.errorCode;
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
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
    expect(() => lock.acquire("T-3")).not.toThrow();
    expect(lock.acquire("T-3")).toBe(true);
  });

  it("still steals an empty/corrupt (NaN) lock", () => {
    const lock = new TicketLock(dir);
    writeFileSync(join(dir, "T-4.lock"), "");
    expect(lock.acquire("T-4")).toBe(true);

    writeFileSync(join(dir, "T-5.lock"), "not-a-number");
    expect(lock.acquire("T-5")).toBe(true);
  });

  it("does NOT steal a live, valid lock", () => {
    const lock = new TicketLock(dir);
    writeFileSync(join(dir, "T-6.lock"), String(Date.now()));
    expect(lock.acquire("T-6")).toBe(false);
  });
});
