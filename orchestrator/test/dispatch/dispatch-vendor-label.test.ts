// B8 / M4 — Per-dispatch vendor label persistence (VAL-ROUTE-004).
//
// Each dispatch persists a vendor label (harness/model identity) into the
// shared ledger entry. After a dispatch, the ledger entry for that run
// carries a non-empty vendor/harness label matching the router selection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
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
import { FIXTURE_CAPABILITY_GATE } from "../helpers/capabilities.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rickgent-vendor-${prefix}-`));
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

describe("DispatchEntry vendor label round-trip (VAL-ROUTE-004)", () => {
  let dir: string;
  let ledgerPath: string;
  let ledger: DispatchLedger;

  beforeEach(() => {
    dir = tmpDir("rt");
    ledgerPath = join(dir, "ledger.jsonl");
    ledger = new DispatchLedger(ledgerPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a non-empty vendor label in the ledger entry and round-trips it", () => {
    const id = "run-1/T-1/implement/1/worker";
    const entry: DispatchEntry = {
      dispatchId: id,
      state: "completed",
      pid: 12345,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
      exitCode: 0,
      stdout: "done",
      stderr: null,
      vendor: "anthropic",
    };
    ledger.append(entry);

    const found = ledger.find(id);
    expect(found).not.toBeNull();
    expect(found!.vendor).toBe("anthropic");
    expect(found!.vendor).not.toBe("");
    expect(found!.vendor).not.toBeNull();
  });

  it("persists a vendor label for a non-anthropic vendor", () => {
    const id = "run-1/T-2/implement/1/worker";
    const entry: DispatchEntry = {
      dispatchId: id,
      state: "completed",
      pid: 999,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
      exitCode: 0,
      stdout: "done",
      stderr: null,
      vendor: "openai",
    };
    ledger.append(entry);

    const found = ledger.find(id);
    expect(found).not.toBeNull();
    expect(found!.vendor).toBe("openai");
  });

  it("the raw ledger JSONL line carries the vendor field", () => {
    const id = "run-1/T-3/implement/1/worker";
    const entry: DispatchEntry = {
      dispatchId: id,
      state: "spawned",
      pid: 42,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      exitCode: null,
      stdout: null,
      stderr: null,
      vendor: "alibaba",
    };
    ledger.append(entry);

    const raw = readFileSync(ledgerPath, "utf-8").trim();
    const parsed = JSON.parse(raw);
    expect(parsed.vendor).toBe("alibaba");
  });
});

describe("Dispatcher vendor label in spawned entries (VAL-ROUTE-004)", () => {
  let dir: string;
  let ledger: DispatchLedger;
  let lock: TicketLock;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dir = tmpDir("disp");
    ledger = new DispatchLedger(join(dir, "ledger.jsonl"));
    lock = new TicketLock(join(dir, "locks"));
    dispatcher = new Dispatcher(ledger, lock, dir, FIXTURE_CAPABILITY_GATE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes the vendor label in every ledger entry the Dispatcher writes", async () => {
    const id = makeId();
    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
      vendor: "openai",
    });

    // The dispatch will fail (omnigent not installed in test env), but every
    // entry the Dispatcher wrote must still carry the vendor label.
    expect(result.vendor).toBe("openai");

    // Verify the raw ledger contains the vendor in every line.
    const raw = readFileSync(join(dir, "ledger.jsonl"), "utf-8").trim();
    const lines = raw.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.vendor).toBe("openai");
    }
  });

  // NOTE: The previous "defaults vendor to null when not provided" test was
  // REMOVED (M4 fix). It blessed the gap where the production build path never
  // consulted the router, so every ledger entry had vendor: null. The
  // production path (build.ts) now calls select_model before each dispatch and
  // populates opts.vendor from the router's selection — see
  // build-routing.test.ts for the end-to-end test that drives
  // select_model -> Dispatcher.dispatch -> ledger vendor label.
  //
  // At the Dispatcher level, omitting vendor still yields null (the Dispatcher
  // does not call the router itself), but this is no longer tested as a
  // production behavior — it is an internal contract, not the production path.

  it("backpressure planned entry carries the vendor label", async () => {
    const id = makeId();
    const result = await dispatcher.dispatch(id, {
      agentDir: "/tmp/agent",
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 0, // at capacity → planned
      vendor: "alibaba",
    });

    expect(result.state).toBe("planned");
    expect(result.vendor).toBe("alibaba");

    const idStr = dispatchIdString(id);
    const found = ledger.find(idStr);
    expect(found).not.toBeNull();
    expect(found!.vendor).toBe("alibaba");
  });
});
