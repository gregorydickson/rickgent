// B6 — single shared ledger schema (append->reconcile round-trip), durable
// salvage dispositions, and oracle-validated reconcile. Every test drives the
// REAL code path and observes the REAL effect (git delta, on-disk archive,
// registry status, recovered ticket) — never a mock's return value.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  DispatchLedger,
  dispatchIdString,
  dispatchLedgerPath,
  type DispatchEntry,
} from "../../src/dispatch/dispatch.js";
import { reconcile } from "../../src/lifecycle/reconcile.js";
import { FIXTURE_CAPABILITY_GATE } from "../helpers/capabilities.js";
import { SalvageExecutor } from "../../src/lifecycle/salvage.js";
import type { SalvageInput } from "../../src/core/salvage.js";
import { Registry, type PipelineStatus } from "../../src/lifecycle/registry.js";

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

function baseEntry(dispatchId: string, over: Partial<DispatchEntry>): DispatchEntry {
  return {
    dispatchId,
    state: "completed",
    pid: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: 0,
    stdout: null,
    stderr: null,
    ...over,
  };
}

describe("B6 — shared ledger schema round-trips append->reconcile", () => {
  let tempDir: string;
  let rickgentDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rickgent-b6-reconcile-"));
    rickgentDir = join(tempDir, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    initRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("VAL-SALVAGE-001: append() writes exactly the fields reconcile reads (round-trip recovers the ticket)", () => {
    const baselineSha = commitFile(tempDir, "base.txt", "base", "baseline");
    const commitSha = commitFile(tempDir, "src/foo.ts", "export const x = 1;", "work on ticket");

    const ledger = new DispatchLedger(dispatchLedgerPath(rickgentDir));
    const dispatchId = dispatchIdString({
      runId: "run1",
      ticketId: "T-RT",
      phase: "implement",
      attempt: 2,
      role: "impl",
    });
    ledger.append(
      baseEntry(dispatchId, {
        commitSha,
        baselineSha,
        declaredPaths: ["src"],
        treeChanged: true,
      }),
    );

    const result = reconcile(tempDir, rickgentDir, undefined, FIXTURE_CAPABILITY_GATE);
    expect(result.ticketsFound).toBeGreaterThan(0);
    const t = result.registry.tickets["T-RT"];
    expect(t).toBeDefined();
    expect(t?.status).toBe("Done");
    expect(t?.phase).toBe("implement");
    expect(t?.attempt).toBe(2);
    expect(t?.completionCommitSha).toBe(commitSha);
    expect(t?.declaredPaths).toEqual(["src"]);
  });

  it("VAL-SALVAGE-002: reconcile keys on the camelCase fields the ledger emits, not snake_case", () => {
    // A legacy snake_case-only line (no dispatchId) is NOT recoverable — reconcile
    // must not key on ticket_id/commit_sha/declared_paths.
    const ledgerPath = dispatchLedgerPath(rickgentDir);
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        ticket_id: "T-SNAKE",
        state: "completed",
        commit_sha: "deadbeef",
        declared_paths: ["src"],
      }) + "\n",
    );
    const result = reconcile(tempDir, rickgentDir, undefined, FIXTURE_CAPABILITY_GATE);
    expect(result.registry.tickets["T-SNAKE"]).toBeUndefined();
  });

  it("VAL-SALVAGE-003: reconcile reads the Dispatcher's actual ledger path", () => {
    const baselineSha = commitFile(tempDir, "base.txt", "base", "baseline");
    const commitSha = commitFile(tempDir, "src/foo.ts", "export const x = 1;", "work");

    // Canonical shared path: Dispatcher writes here, reconcile reads here.
    const ledger = new DispatchLedger(dispatchLedgerPath(rickgentDir));
    const dispatchId = dispatchIdString({
      runId: "run1",
      ticketId: "T-PATH",
      phase: "implement",
      attempt: 1,
      role: "impl",
    });
    ledger.append(baseEntry(dispatchId, { commitSha, baselineSha, declaredPaths: ["src"], treeChanged: true }));
    expect(reconcile(tempDir, rickgentDir, undefined, FIXTURE_CAPABILITY_GATE).registry.tickets["T-PATH"]).toBeDefined();

    // A non-default path is still consumed when reconcile is pointed at it.
    const customPath = join(rickgentDir, "custom-ledger.jsonl");
    const customLedger = new DispatchLedger(customPath);
    const customId = dispatchIdString({
      runId: "run2",
      ticketId: "T-CUSTOM",
      phase: "implement",
      attempt: 1,
      role: "impl",
    });
    customLedger.append(baseEntry(customId, { commitSha, baselineSha, declaredPaths: ["src"], treeChanged: true }));
    const custom = reconcile(tempDir, rickgentDir, customPath, FIXTURE_CAPABILITY_GATE);
    expect(custom.registry.tickets["T-CUSTOM"]).toBeDefined();
  });

  it("VAL-SALVAGE-007: reconcile validates each commit via evaluateCompletion before assigning Done", () => {
    const baselineSha = commitFile(tempDir, "base.txt", "base", "baseline");
    const goodSha = commitFile(tempDir, "src/foo.ts", "export const x = 1;", "real work");

    const ledger = new DispatchLedger(dispatchLedgerPath(rickgentDir));
    const goodId = dispatchIdString({ runId: "r", ticketId: "T-GOOD", phase: "implement", attempt: 1, role: "impl" });
    const badId = dispatchIdString({ runId: "r", ticketId: "T-BAD", phase: "implement", attempt: 1, role: "impl" });
    ledger.append(baseEntry(goodId, { commitSha: goodSha, baselineSha, declaredPaths: ["src"], treeChanged: true }));
    // Completed claim whose commit does not exist → oracle must reject → not Done.
    ledger.append(
      baseEntry(badId, { commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", baselineSha, declaredPaths: ["src"], treeChanged: true }),
    );

    const result = reconcile(tempDir, rickgentDir, undefined, FIXTURE_CAPABILITY_GATE);
    expect(result.registry.tickets["T-GOOD"]?.status).toBe("Done");
    expect(result.registry.tickets["T-BAD"]?.status).not.toBe("Done");
  });
});

describe("B6 — durable salvage dispositions (verified post-mutation)", () => {
  let tempDir: string;
  let rickgentDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rickgent-b6-salvage-"));
    rickgentDir = join(tempDir, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    initRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function archivedTodoInput(ownedPaths: string[]): SalvageInput {
    return { gatePassed: false, treeChanged: true, orphanReset: false, ffReattachPossible: false, ownedPaths };
  }
  function ffInput(): SalvageInput {
    return { gatePassed: false, treeChanged: false, orphanReset: true, ffReattachPossible: true, ownedPaths: [] };
  }
  function committedDoneInput(ownedPaths: string[]): SalvageInput {
    return { gatePassed: true, treeChanged: true, orphanReset: false, ffReattachPossible: false, ownedPaths };
  }

  it("VAL-SALVAGE-004: archived-todo writes a durable, restorable archive on disk", () => {
    commitFile(tempDir, "owned.txt", "original\n", "seed");
    writeFileSync(join(tempDir, "owned.txt"), "original\nsalvaged work\n");

    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(archivedTodoInput(["owned.txt"]));
    expect(result.decision.disposition).toBe("archived-todo");
    expect(result.executed).toBe(true);
    expect(result.archivePath).toBeTruthy();
    expect(existsSync(result.archivePath!)).toBe(true);
    const patch = readFileSync(result.archivePath!, "utf-8");
    expect(patch).toContain("owned.txt");
    expect(patch).toContain("salvaged work");

    // Restorable: discard the work, re-apply the archive, and confirm it comes back.
    git(tempDir, ["checkout", "--", "owned.txt"]);
    expect(readFileSync(join(tempDir, "owned.txt"), "utf-8")).not.toContain("salvaged work");
    git(tempDir, ["apply", result.archivePath!]);
    expect(readFileSync(join(tempDir, "owned.txt"), "utf-8")).toContain("salvaged work");
  });

  it("VAL-SALVAGE-004b: archived-todo archive includes owned UNTRACKED files and is fully restorable", () => {
    // `git diff HEAD` sees only tracked changes, so an archive built from it
    // silently drops owned untracked work while still reporting executed:true.
    commitFile(tempDir, "tracked.txt", "original\n", "seed");
    writeFileSync(join(tempDir, "tracked.txt"), "original\ntracked salvage\n");
    // Owned UNTRACKED new file (never committed) — the crux of the defect.
    writeFileSync(join(tempDir, "brand-new.txt"), "untracked salvaged work\n");
    // Unowned untracked file: must NEVER enter the owned-paths-only archive.
    writeFileSync(join(tempDir, "unowned.txt"), "not mine\n");

    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(archivedTodoInput(["tracked.txt", "brand-new.txt"]));
    expect(result.decision.disposition).toBe("archived-todo");
    expect(result.executed).toBe(true);
    expect(result.archivePath).toBeTruthy();
    expect(existsSync(result.archivePath!)).toBe(true);

    const patch = readFileSync(result.archivePath!, "utf-8");
    expect(patch).toContain("brand-new.txt");
    expect(patch).toContain("untracked salvaged work");
    expect(patch).toContain("tracked salvage");
    // Owned-paths-only: the unowned untracked file is never captured.
    expect(patch).not.toContain("unowned.txt");

    // Archiving must not leave residual intent-to-add index state behind.
    const porcelain = git(tempDir, ["status", "--porcelain"]);
    expect(porcelain).toContain("?? brand-new.txt");
    expect(porcelain).toContain("?? unowned.txt");

    // Restorable: discard ALL salvaged work (tracked mod + untracked file), then
    // re-apply the archive and confirm BOTH the tracked change and the untracked
    // file are reproduced.
    git(tempDir, ["checkout", "--", "tracked.txt"]);
    rmSync(join(tempDir, "brand-new.txt"));
    expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).not.toContain("tracked salvage");
    expect(existsSync(join(tempDir, "brand-new.txt"))).toBe(false);

    git(tempDir, ["apply", result.archivePath!]);
    expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toContain("tracked salvage");
    expect(existsSync(join(tempDir, "brand-new.txt"))).toBe(true);
    expect(readFileSync(join(tempDir, "brand-new.txt"), "utf-8")).toContain("untracked salvaged work");
  });

  it("VAL-SALVAGE-005: archived-todo resets the ticket registry status to Todo", () => {
    commitFile(tempDir, "owned.txt", "original\n", "seed");
    writeFileSync(join(tempDir, "owned.txt"), "original\nwork\n");

    const registry = new Registry(join(rickgentDir, "registry.json"));
    const state: PipelineStatus = {
      runId: "r",
      tickets: {
        "T-ARCH": {
          id: "T-ARCH",
          title: "arch",
          status: "In Progress",
          phase: "implement",
          declaredPaths: ["owned.txt"],
          attempt: 1,
          completionCommitSha: null,
          updatedAt: new Date().toISOString(),
        },
      },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    registry.save(state);

    const executor = new SalvageExecutor(tempDir);
    executor.execute(archivedTodoInput(["owned.txt"]), { ticketId: "T-ARCH", registry });
    expect(registry.getTicketState("T-ARCH")?.status).toBe("Todo");
  });

  it("VAL-SALVAGE-006: ff-reattached performs a real git merge --ff-only with explicit refs", () => {
    const baseSha = commitFile(tempDir, "base.txt", "base", "A");
    const targetBranch = git(tempDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(tempDir, ["branch", "orphan"]);
    git(tempDir, ["checkout", "orphan"]);
    const orphanSha = commitFile(tempDir, "more.txt", "more", "B");
    git(tempDir, ["checkout", targetBranch]);
    // Precondition: target is behind orphan.
    expect(git(tempDir, ["rev-parse", targetBranch])).toBe(baseSha);

    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(ffInput(), { sourceRef: "orphan", targetRef: targetBranch });
    expect(result.decision.disposition).toBe("ff-reattached");
    expect(result.executed).toBe(true);
    // Post-mutation: target fast-forwarded to the orphan commit.
    expect(git(tempDir, ["rev-parse", targetBranch])).toBe(orphanSha);
  });

  it("VAL-SALVAGE-006b: ff-reattached fails closed when refs are absent (no silent success)", () => {
    commitFile(tempDir, "base.txt", "base", "A");
    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(ffInput());
    expect(result.executed).toBe(false);
  });

  it("VAL-SALVAGE-009: committed-done staging is owned-paths-only (never git add -A)", () => {
    commitFile(tempDir, "seed.txt", "seed", "seed");
    writeFileSync(join(tempDir, "real.txt"), "owned change");
    writeFileSync(join(tempDir, "evil.txt"), "out of scope untracked");

    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(committedDoneInput(["real.txt"]));
    expect(result.executed).toBe(true);
    const porcelain = git(tempDir, ["status", "--porcelain"]);
    expect(porcelain).toContain("?? evil.txt");
  });

  it("VAL-SALVAGE-008: no execSync template-string git invocation remains in the executor", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/lifecycle/salvage.ts"), "utf-8");
    expect(src).not.toMatch(/execSync\(\s*`git/);
    expect(src).toMatch(/execFileSync\("git", \[/);
  });
});
