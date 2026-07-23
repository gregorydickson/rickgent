// M8 scrutiny round 5 — test stability and timeout fixes.
//
// This suite proves the 2 blocking test-stability defects from scrutiny
// round 5 are fixed:
//
// Issue 1: Five m8-scrutiny-round-4-fixes behavioral tests time out under
//          cross-suite load because they use the default vitest testTimeout
//          (15s) while performing real git operations (init, push, ls-remote)
//          and StateStore setup.  Fix: add explicit { timeout: 30_000 } to
//          every behavioral test that performs git operations, and add
//          timeout options to every execFileSync call in test helpers.
//
// Issue 2: pr-protocol.test.ts wrong-repository test times out and the
//          existing-wrong-head test has a fixture setup failure under load.
//          The execFileSync calls in the test helpers (makeRepo, makeBareRepo,
//          createDeliveryCommit, preparePrFixture) have no timeout option and
//          can hang indefinitely under load.  Fix: add timeout options to all
//          execFileSync calls and increase the per-test timeout budget.
//
// Both issues share a common root cause: execFileSync calls without timeout
// options in test helper functions.  Under heavy cross-suite load (machine
// load ~19), git operations can exceed the default test deadline, causing
// tests to time out or hang.  The production code (push.ts, pull-request.ts)
// already has timeouts on its execFileSync calls; only the test helpers
// lack them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, "../..");
const RELIABILITY_DIR = join(import.meta.dirname, ".");

function readTest(rel: string): string {
  return readFileSync(join(RELIABILITY_DIR, rel), "utf-8");
}

function readConfig(rel: string): string {
  return readFileSync(join(TEST_DIR, rel), "utf-8");
}

// ─── Issue 1: m8-scrutiny-round-4-fixes behavioral tests need explicit timeouts ─

describe("Issue 1: m8-scrutiny-round-4-fixes behavioral tests have explicit timeouts", () => {
  it("every behavioral test in m8-scrutiny-round-4-fixes.test.ts has an explicit timeout option", () => {
    const src = readTest("m8-scrutiny-round-4-fixes.test.ts");
    // The behavioral tests are the ones that call setupOracleFixture,
    // makeRepo, makeBareRepo, or perform git operations.  They must
    // all have { timeout: N } in their test declaration.
    //
    // The behavioral test names:
    // - oracle rejects identity binding when referenced IDs are non-identity-receipt evidence
    // - oracle rejects identity binding when referenced IDs do not exist at all
    // - oracle rejects identity binding when receipts have wrong roles (incoherent set)
    // - oracle rejects identity binding when receipts have mismatched dispatch_ids (incoherent)
    // - oracle ACCEPTS identity binding when receipts form a coherent set (positive proof)
    // - behavioral: fixture PR with correct owner/repo identity is accepted
    // - behavioral: fixture PR with GraphQL node ID is rejected (wrong format)
    // - behavioral: recordDecision failure propagates (not swallowed)

    // Check that the "oracle rejects" and "oracle ACCEPTS" tests have timeouts
    const oracleTests = src.match(/it\("(oracle (rejects|ACCEPTS)[^"]+)"/g) ?? [];
    expect(oracleTests.length).toBeGreaterThanOrEqual(5);
    for (const testMatch of oracleTests) {
      // Find the timeout option after each test declaration
      const testIdx = src.indexOf(testMatch);
      const afterTest = src.slice(testIdx, testIdx + 200);
      expect(afterTest, `Test "${testMatch}" must have explicit timeout`).toMatch(/\{[^}]*timeout:\s*\d+/);
    }

    // Check that the "behavioral:" tests have timeouts
    const behavioralTests = src.match(/it\("(behavioral:[^"]+)"/g) ?? [];
    expect(behavioralTests.length).toBeGreaterThanOrEqual(3);
    for (const testMatch of behavioralTests) {
      const testIdx = src.indexOf(testMatch);
      const afterTest = src.slice(testIdx, testIdx + 200);
      expect(afterTest, `Test "${testMatch}" must have explicit timeout`).toMatch(/\{[^}]*timeout:\s*\d+/);
    }
  });

  it("m8-scrutiny-round-4-fixes.test.ts execFileSync calls in helpers have timeout options", () => {
    const src = readTest("m8-scrutiny-round-4-fixes.test.ts");
    // The helper functions makeRepo and makeBareRepo use execFileSync
    // to run git commands.  Every execFileSync call must have a timeout
    // option to prevent indefinite hangs under load.
    const helperSection = src.slice(src.indexOf("function makeRepo"), src.indexOf("function repoHead"));
    const execCalls = helperSection.match(/execFileSync\(/g) ?? [];
    expect(execCalls.length).toBeGreaterThan(0);
    // Every execFileSync call in the helper must have a timeout option
    // Check that there are no execFileSync calls without timeout
    const withoutTimeout = helperSection.match(/execFileSync\([^)]+\)\s*(?:;|\n)/g) ?? [];
    for (const call of withoutTimeout) {
      expect(call, "execFileSync call must have timeout option").toMatch(/timeout/);
    }
  });
});

// ─── Issue 2: pr-protocol.test.ts fixture stability ────────────────────

describe("Issue 2: pr-protocol.test.ts fixture helpers have timeout options", () => {
  it("makeRepo helper in pr-protocol.test.ts has timeout on execFileSync calls", () => {
    const src = readTest("pr-protocol.test.ts");
    const helperSection = src.slice(src.indexOf("function makeRepo("), src.indexOf("function makeBareRepo("));
    const execCalls = helperSection.match(/execFileSync\(/g) ?? [];
    expect(execCalls.length).toBeGreaterThan(0);
    // Every execFileSync call in makeRepo must have a timeout
    const lines = helperSection.split("\n").filter((l) => l.includes("execFileSync"));
    for (const line of lines) {
      expect(line, "execFileSync in makeRepo must have timeout").toMatch(/timeout/);
    }
  });

  it("makeBareRepo helper in pr-protocol.test.ts has timeout on execFileSync calls", () => {
    const src = readTest("pr-protocol.test.ts");
    const helperSection = src.slice(src.indexOf("function makeBareRepo("), src.indexOf("function repoHead("));
    const execCalls = helperSection.match(/execFileSync\(/g) ?? [];
    expect(execCalls.length).toBeGreaterThan(0);
    const lines = helperSection.split("\n").filter((l) => l.includes("execFileSync"));
    for (const line of lines) {
      expect(line, "execFileSync in makeBareRepo must have timeout").toMatch(/timeout/);
    }
  });

  it("createDeliveryCommit helper in pr-protocol.test.ts has timeout on execFileSync calls", () => {
    const src = readTest("pr-protocol.test.ts");
    const helperSection = src.slice(src.indexOf("function createDeliveryCommit("), src.indexOf("function ticketContract("));
    const execCalls = helperSection.match(/execFileSync\(/g) ?? [];
    expect(execCalls.length).toBeGreaterThan(0);
    const lines = helperSection.split("\n").filter((l) => l.includes("execFileSync"));
    for (const line of lines) {
      expect(line, "execFileSync in createDeliveryCommit must have timeout").toMatch(/timeout/);
    }
  });

  it("pr-protocol.test.ts TEST_TIMEOUT is at least 30000ms", () => {
    const src = readTest("pr-protocol.test.ts");
    const match = src.match(/TEST_TIMEOUT\s*=\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const timeout = Number(match![1].replace(/_/g, ""));
    expect(timeout).toBeGreaterThanOrEqual(30_000);
  });
});

// ─── Cross-cutting: all M8 test helpers have timeout options ───────────

describe("Cross-cutting: all M8 git-using test files have timeout on helper execFileSync calls", () => {
  const m8Files = [
    "m8-scrutiny-round-2-fixes.test.ts",
    "m8-scrutiny-round-3-fixes.test.ts",
    "m8-scrutiny-round-4-fixes.test.ts",
    "push-protocol.test.ts",
    "delivery-negative.test.ts",
    "pr-protocol.test.ts",
  ];

  for (const file of m8Files) {
    it(`${file}: makeRepo helper has timeout on all execFileSync calls`, () => {
      const src = readTest(file);
      const makeRepoIdx = src.indexOf("function makeRepo(");
      if (makeRepoIdx === -1) return; // file may not have makeRepo
      // Find the end of makeRepo (next function or blank line pattern)
      const nextFuncIdx = src.indexOf("\nfunction ", makeRepoIdx + 1);
      const helperSection = src.slice(makeRepoIdx, nextFuncIdx === -1 ? undefined : nextFuncIdx);
      const lines = helperSection.split("\n").filter((l) => l.includes("execFileSync(") && !l.includes("function"));
      expect(lines.length, `${file} makeRepo should have execFileSync calls`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${file} makeRepo execFileSync must have timeout`).toMatch(/timeout/);
      }
    });
  }
});

// ─── Vitest config: hookTimeout for cleanup under load ──────────────────

describe("Vitest config has adequate hookTimeout for cleanup under load", () => {
  it("vitest.config.ts defines hookTimeout >= 15000ms", () => {
    const src = readConfig("vitest.config.ts");
    // The config must have a hookTimeout setting so that afterEach hooks
    // (which clean up temp directories with recursive rmSync) don't
    // time out under load.
    expect(src).toMatch(/hookTimeout/);
    const match = src.match(/hookTimeout:\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const timeout = Number(match![1].replace(/_/g, ""));
    expect(timeout).toBeGreaterThanOrEqual(15_000);
  });
});
