import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reconcile } from "../../src/lifecycle/reconcile.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

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

  function commit(message: string): void {
    writeFileSync(join(tempDir, `file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), "content");
    execSync("git add -A", { cwd: tempDir, timeout: 10000 });
    execSync(`git commit -m "${message}"`, { cwd: tempDir, timeout: 10000 });
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

  it("reads dispatch ledger for completed tickets", () => {
    const ledgerPath = join(rickgentDir, "dispatch-ledger.jsonl");
    writeFileSync(
      ledgerPath,
      [
        JSON.stringify({
          ticket_id: "T-LEDGER-1",
          state: "completed",
          title: "Ledger ticket",
          phase: "code_review",
          declared_paths: ["src/foo.ts"],
          attempt: 2,
          commit_sha: "deadbeef",
        }),
        JSON.stringify({
          ticket_id: "T-LEDGER-2",
          state: "completed",
          title: "Another ledger ticket",
          phase: "simplify",
          declared_paths: [],
          attempt: 1,
          commit_sha: "cafef00d",
        }),
      ].join("\n") + "\n",
    );

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ticketsFound).toBe(2);
    expect(result.registry.tickets["T-LEDGER-1"]?.title).toBe("Ledger ticket");
    expect(result.registry.tickets["T-LEDGER-1"]?.phase).toBe("code_review");
    expect(result.registry.tickets["T-LEDGER-1"]?.completionCommitSha).toBe("deadbeef");
    expect(result.registry.tickets["T-LEDGER-2"]).toBeDefined();
  });

  it("git truth takes precedence over ledger for same ticket", () => {
    commit("ticket: T-DUP git version");
    const ledgerPath = join(rickgentDir, "dispatch-ledger.jsonl");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        ticket_id: "T-DUP",
        state: "completed",
        title: "ledger version",
        phase: "research",
        declared_paths: [],
        attempt: 1,
        commit_sha: null,
      }) + "\n",
    );

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ticketsFound).toBe(1);
    expect(result.registry.tickets["T-DUP"]?.title).toContain("git version");
  });

  it("skips malformed ledger entries", () => {
    const ledgerPath = join(rickgentDir, "dispatch-ledger.jsonl");
    writeFileSync(
      ledgerPath,
      [
        "{ not valid json",
        JSON.stringify({
          ticket_id: "T-VALID",
          state: "completed",
          title: "valid entry",
          phase: "simplify",
          declared_paths: [],
          attempt: 1,
          commit_sha: "abc",
        }),
      ].join("\n") + "\n",
    );

    const result = reconcile(tempDir, rickgentDir);
    expect(result.ticketsFound).toBe(1);
    expect(result.registry.tickets["T-VALID"]).toBeDefined();
    expect(result.registry.tickets["T-VALID"]?.title).toBe("valid entry");
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
