// B6 — durable salvage dispositions. Legacy reconcile coverage was removed
// with the Git/JSONL reconstruction implementation; the fail-closed boundary
// is covered by reconcile.test.ts and reconcile-queue.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
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

  it("VAL-SALVAGE-005: archived capture does not use registry JSON as lifecycle authority", () => {
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
    expect(registry.getTicketState("T-ARCH")?.status).toBe("In Progress");
  });

  it("VAL-SALVAGE-006: ff-reattach remains non-authoritative without SQLite recovery", () => {
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
    expect(result.executed).toBe(false);
    expect(result.terminal).toBe(false);
    expect(result.gitOutput).toContain("SQLite recovery authority");
    expect(git(tempDir, ["rev-parse", targetBranch])).toBe(baseSha);
    expect(orphanSha).not.toBe(baseSha);
  });

  it("VAL-SALVAGE-006b: ff-reattached fails closed when refs are absent (no silent success)", () => {
    commitFile(tempDir, "base.txt", "base", "A");
    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(ffInput());
    expect(result.executed).toBe(false);
  });

  it("VAL-SALVAGE-009: legacy committed-done captures owned paths without creating a commit", () => {
    commitFile(tempDir, "seed.txt", "seed", "seed");
    writeFileSync(join(tempDir, "real.txt"), "owned change");
    writeFileSync(join(tempDir, "evil.txt"), "out of scope untracked");

    const executor = new SalvageExecutor(tempDir);
    const baseline = git(tempDir, ["rev-parse", "HEAD"]);
    const result = executor.execute(committedDoneInput(["real.txt"]));
    expect(result.executed).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.archivePath).not.toBeNull();
    expect(git(tempDir, ["rev-parse", "HEAD"])).toBe(baseline);
    const porcelain = git(tempDir, ["status", "--porcelain"]);
    expect(porcelain).toContain("?? evil.txt");
  });

  it("VAL-SALVAGE-008: no execSync template-string git invocation remains in the executor", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/lifecycle/salvage.ts"), "utf-8");
    expect(src).not.toMatch(/execSync\(\s*`git/);
    expect(src).toMatch(/execFileSync\("git", \[/);
  });
});
