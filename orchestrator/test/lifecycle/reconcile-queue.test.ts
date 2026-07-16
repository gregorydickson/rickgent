// B3 — resume reconstructs in-flight + planned queue state from ledger + git
// (VAL-QUEUE-004). A killed run leaves a mix of completed / in-flight (spawned,
// non-terminal) / still-planned (queued) tickets in the durable ledger; resume
// must reconstruct ALL THREE from ledger + git, not just completed, so no
// queued or in-progress ticket is silently dropped on resume.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  DispatchLedger,
  dispatchIdString,
  dispatchLedgerPath,
  type DispatchEntry,
  type DispatchId,
} from "../../dist-fixture/dispatch/dispatch.js";
import { DispatchQueue } from "../../dist-fixture/dispatch/queue.js";
import { reconcile } from "../../src/lifecycle/reconcile.js";

// Unit-only access to legacy reconciliation mechanics; not fixture authority.
vi.mock("../../src/capabilities/runtime-gate.js", () => ({
  RUNTIME_CAPABILITY_GATE: Object.freeze({ require(): void {} }),
}));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(dir: string): void {
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@rickgent.dev"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitFile(dir: string, relPath: string, content: string, message: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  git(dir, ["add", "--", relPath]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function id(ticketId: string): DispatchId {
  return { runId: "run-r", ticketId, phase: "implement", attempt: 1, role: "worker" };
}

function entry(over: Partial<DispatchEntry> & { dispatchId: string; state: DispatchEntry["state"] }): DispatchEntry {
  return {
    pid: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    stdout: null,
    stderr: null,
    ...over,
  };
}

describe("B3 resume — reconcile reconstructs in-flight + planned (VAL-QUEUE-004)", () => {
  let tempDir: string;
  let rickgentDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rickgent-queue-reconcile-"));
    rickgentDir = join(tempDir, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    initRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reconstructs completed→Done, in-flight→In Progress, and planned→Todo from the ledger", () => {
    const baselineSha = commitFile(tempDir, "base.txt", "base", "baseline");
    const doneSha = commitFile(tempDir, "src/done.ts", "export const x = 1;", "done work");

    const ledger = new DispatchLedger(dispatchLedgerPath(rickgentDir));

    // T-DONE: planned → spawned → completed (a real, oracle-verifiable commit).
    const doneId = dispatchIdString(id("T-DONE"));
    ledger.append(entry({ dispatchId: doneId, state: "planned" }));
    ledger.append(entry({ dispatchId: doneId, state: "spawned" }));
    ledger.append(
      entry({
        dispatchId: doneId,
        state: "completed",
        commitSha: doneSha,
        baselineSha,
        declaredPaths: ["src"],
        treeChanged: true,
        completedAt: new Date().toISOString(),
        exitCode: 0,
      }),
    );

    // T-INFLIGHT: planned → spawned, then the run was killed (no terminal entry).
    const inflightId = dispatchIdString(id("T-INFLIGHT"));
    ledger.append(entry({ dispatchId: inflightId, state: "planned" }));
    ledger.append(entry({ dispatchId: inflightId, state: "spawned" }));

    // T-PLANNED: queued only — never spawned before the kill.
    const plannedId = dispatchIdString(id("T-PLANNED"));
    ledger.append(entry({ dispatchId: plannedId, state: "planned" }));

    const result = reconcile(tempDir, rickgentDir);

    expect(result.registry.tickets["T-DONE"]?.status).toBe("Done");
    expect(result.registry.tickets["T-DONE"]?.completionCommitSha).toBe(doneSha);

    // In-flight recovered as unfinished work to continue — NOT dropped, NOT Done.
    expect(result.registry.tickets["T-INFLIGHT"]).toBeDefined();
    expect(result.registry.tickets["T-INFLIGHT"]?.status).toBe("In Progress");

    // Planned recovered as still-queued work — NOT dropped, NOT Done.
    expect(result.registry.tickets["T-PLANNED"]).toBeDefined();
    expect(result.registry.tickets["T-PLANNED"]?.status).toBe("Todo");

    expect(result.ticketsFound).toBe(3);
  });

  it("a planned entry later superseded by completed is reconstructed as Done (latest state wins)", () => {
    const baselineSha = commitFile(tempDir, "base.txt", "base", "baseline");
    const sha = commitFile(tempDir, "src/foo.ts", "export const y = 2;", "work");
    const queue = new DispatchQueue(new DispatchLedger(dispatchLedgerPath(rickgentDir)), 1);
    // enqueue writes planned; then a completed supersedes it.
    queue.enqueue(id("T-SUP"));
    const ledger = new DispatchLedger(dispatchLedgerPath(rickgentDir));
    ledger.append(
      entry({
        dispatchId: dispatchIdString(id("T-SUP")),
        state: "completed",
        commitSha: sha,
        baselineSha,
        declaredPaths: ["src"],
        treeChanged: true,
        completedAt: new Date().toISOString(),
        exitCode: 0,
      }),
    );
    const result = reconcile(tempDir, rickgentDir);
    expect(result.registry.tickets["T-SUP"]?.status).toBe("Done");
  });
});
