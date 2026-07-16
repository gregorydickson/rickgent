import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { reconcile } from "../../src/lifecycle/reconcile.js";
import { DispatchLedger, dispatchIdString, dispatchLedgerPath, type DispatchEntry } from "../../src/dispatch/dispatch.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

// Unit-only access to legacy reconciliation mechanics. The M1 fixture runtime
// remains contracted and the resume boundary is tested adversarially elsewhere.
vi.mock("../../src/capabilities/runtime-gate.js", () => ({
  RUNTIME_CAPABILITY_GATE: Object.freeze({ require(): void {} }),
}));

describe("reconcile", () => {
  let tempDir: string;
  let rickgentDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rickgent-reconcile-"));
    rickgentDir = join(tempDir, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    // Initialize a git repo with identity
    execSync("git init", { cwd: tempDir, timeout: 10000 });
    execSync('git config user.email "test@rickgent.dev"', { cwd: tempDir, timeout: 10000 });
    execSync('git config user.name "Test"', { cwd: tempDir, timeout: 10000 });
    execSync('git config commit.gpgsign false', { cwd: tempDir, timeout: 10000 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function commit(message: string): string {
    writeFileSync(join(tempDir, `file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), "content");
    execSync("git add -A", { cwd: tempDir, timeout: 10000 });
    execSync(`git commit -m "${message}"`, { cwd: tempDir, timeout: 10000 });
    return execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
  }

  function appendCompleted(over: Partial<DispatchEntry> & { ticketId: string; phase?: string; attempt?: number }): void {
    const ledger = new DispatchLedger(dispatchLedgerPath(rickgentDir));
    const dispatchId = dispatchIdString({
      runId: "run",
      ticketId: over.ticketId,
      phase: over.phase ?? "simplify",
      attempt: over.attempt ?? 1,
      role: "impl",
    });
    ledger.append({
      dispatchId,
      state: "completed",
      pid: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      stdout: null,
      stderr: null,
      baselineSha: "",
      ...over,
    });
  }

  it("builds registry from git commits with ticket IDs", () => {
    commit("ticket: T-001 implement feature");
    commit("ticket: T-002 fix bug");

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ok).toBe(true);
    expect(result.rebuilt).toBe(true);
    expect(result.ticketsFound).toBe(2);
    expect(result.registry.tickets["T-001"]).toBeDefined();
    expect(result.registry.tickets["T-001"]?.status).toBe("Done");
    expect(result.registry.tickets["T-002"]).toBeDefined();
  });

  it("captures completion commit SHA from git", () => {
    commit("ticket: T-100 first pass");
    const sha = execSync("git rev-parse --short HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
    const result = reconcile(tempDir, rickgentDir);
    expect(result.registry.tickets["T-100"]?.completionCommitSha).toBe(sha);
  });

  it("returns empty registry when no ticket commits exist", () => {
    commit("just a regular commit");
    const result = reconcile(tempDir, rickgentDir);
    expect(result.ok).toBe(true);
    expect(result.rebuilt).toBe(false);
    expect(result.ticketsFound).toBe(0);
  });

  it("reads dispatch ledger for completed tickets (shared camelCase schema)", () => {
    const sha1 = commit("work 1");
    const sha2 = commit("work 2");
    appendCompleted({ ticketId: "T-LEDGER-1", phase: "code_review", attempt: 2, commitSha: sha1, declaredPaths: ["src/foo.ts"] });
    appendCompleted({ ticketId: "T-LEDGER-2", phase: "simplify", attempt: 1, commitSha: sha2, declaredPaths: [] });

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ticketsFound).toBe(2);
    expect(result.registry.tickets["T-LEDGER-1"]?.status).toBe("Done");
    expect(result.registry.tickets["T-LEDGER-1"]?.phase).toBe("code_review");
    expect(result.registry.tickets["T-LEDGER-1"]?.attempt).toBe(2);
    expect(result.registry.tickets["T-LEDGER-1"]?.completionCommitSha).toBe(sha1);
    expect(result.registry.tickets["T-LEDGER-1"]?.declaredPaths).toEqual(["src/foo.ts"]);
    expect(result.registry.tickets["T-LEDGER-2"]).toBeDefined();
  });

  it("git truth takes precedence over ledger for same ticket", () => {
    commit("ticket: T-DUP git version");
    appendCompleted({ ticketId: "T-DUP", phase: "research", commitSha: "abc" });

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ticketsFound).toBe(1);
    expect(result.registry.tickets["T-DUP"]?.title).toContain("git version");
  });

  it("skips malformed ledger entries", () => {
    const sha = commit("valid work");
    const ledgerPath = dispatchLedgerPath(rickgentDir);
    const validLine = JSON.stringify({
      dispatchId: dispatchIdString({ runId: "run", ticketId: "T-VALID", phase: "simplify", attempt: 1, role: "impl" }),
      state: "completed",
      commitSha: sha,
      baselineSha: "",
      declaredPaths: [],
    });
    writeFileSync(ledgerPath, ["{ not valid json", validLine].join("\n") + "\n");

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ticketsFound).toBe(1);
    expect(result.registry.tickets["T-VALID"]).toBeDefined();
    expect(result.registry.tickets["T-VALID"]?.status).toBe("Done");
  });

  it("sets runId to reconciled", () => {
    commit("ticket: T-X test");
    const result = reconcile(tempDir, rickgentDir);
    expect(result.registry.runId).toBe("reconciled");
  });

  it("handles missing ledger file gracefully", () => {
    commit("ticket: T-NOLEDGER test");
    // No ledger file created
    const result = reconcile(tempDir, rickgentDir);
    expect(result.ok).toBe(true);
    expect(result.registry.tickets["T-NOLEDGER"]).toBeDefined();
  });
});
