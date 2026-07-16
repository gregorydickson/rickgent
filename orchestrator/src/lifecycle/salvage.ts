// Salvage executor — the lifecycle layer that EXECUTES git mutations.
// The core DECIDES the disposition; this module EXECUTES it safely.
// §14.8: decide / execute / verify split. R-MACB: never git add -A.
//
// Legacy dispositions are capture-only here. This executor may preserve an
// owned-path patch, but it cannot commit, move refs, reset lifecycle state, or
// claim terminal completion. Those authorities belong to the SQLite trust
// spine and its commit/promotion/finalization services.

import { decideSalvage, type SalvageInput, type SalvageDecision } from "../core/salvage.js";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface SalvageExecutionResult {
  decision: SalvageDecision;
  executed: boolean;
  gitOutput: string | null;
  /** Path to the durable on-disk archive written for an archived-todo. */
  archivePath: string | null;
  /** Always false: salvage capture is evidence, never terminal authority. */
  terminal: false;
}

/**
 * Per-execution context for capture location and diagnostic identity only.
 */
export interface SalvageExecutionContext {
  ticketId?: string;
  /** @deprecated Ignored legacy diagnostic; registry JSON is not authority. */
  registry?: unknown;
  /** @deprecated Diagnostic only; salvage cannot move refs. */
  sourceRef?: string;
  /** @deprecated Diagnostic only; salvage cannot move refs. */
  targetRef?: string;
  /** Override for the archive directory (defaults to <workingDir>/.rickgent/salvage-archives). */
  archiveDir?: string;
}

export class SalvageExecutor {
  constructor(private workingDir: string) {}

  execute(input: SalvageInput, ctx: SalvageExecutionContext = {}): SalvageExecutionResult {
    const decision = decideSalvage(input);
    let executed = false;
    let gitOutput: string | null = null;
    let archivePath: string | null = null;

    try {
      switch (decision.disposition) {
        case "committed-done":
          if (decision.stagedPaths && decision.stagedPaths.length > 0) {
            archivePath = this.writeArchive(decision.stagedPaths, ctx);
            gitOutput = archivePath;
            executed = true;
          }
          break;
        case "archived-todo": {
          // Write a durable, restorable, owned-paths-scoped patch to disk BEFORE
          // any reset (never lose work). The archive is a `git apply`-able diff.
          archivePath = this.writeArchive(decision.stagedPaths ?? [], ctx);
          gitOutput = archivePath;
          executed = true;
          break;
        }
        case "ff-reattached": {
          gitOutput = "ff-reattach requires SQLite recovery authority; no git mutation performed";
          executed = false;
          break;
        }
        case "no-op":
          executed = true;
          break;
        case "error":
          executed = false;
          break;
      }
    } catch (err) {
      executed = false;
      gitOutput = err instanceof Error ? err.message : String(err);
    }

    return { decision, executed, gitOutput, archivePath, terminal: false };
  }

  private archiveDir(ctx: SalvageExecutionContext): string {
    return ctx.archiveDir ?? join(this.workingDir, ".rickgent", "salvage-archives");
  }

  private writeArchive(ownedPaths: string[], ctx: SalvageExecutionContext): string {
    const dir = this.archiveDir(ctx);
    mkdirSync(dir, { recursive: true });
    const patch = this.buildOwnedDiff(ownedPaths);
    const label = ctx.ticketId ? ctx.ticketId.replace(/[^A-Za-z0-9_-]/g, "_") : "salvage";
    const file = join(dir, `${label}-${Date.now()}.patch`);
    writeFileSync(file, patch);
    return file;
  }

  /**
   * Owned-paths-only, restorable diff vs HEAD. Plain `git diff HEAD` sees only
   * TRACKED changes, so owned UNTRACKED work would be silently dropped and the
   * archive non-restorable. We first intent-to-add (`git add -N`) the owned
   * untracked files so `git diff HEAD` emits them as new-file additions, then
   * undo the intent-to-add so archiving leaves no residual index state. Only the
   * untracked files git itself reports under the owned pathspec are added, so the
   * archive can never capture out-of-scope/unowned files, and array-argv with
   * `--` keeps a hostile path from being reinterpreted as a git option.
   */
  private buildOwnedDiff(ownedPaths: string[]): string {
    const diff = (paths: string[]): string =>
      execFileSync("git", paths.length > 0 ? ["diff", "HEAD", "--", ...paths] : ["diff", "HEAD"], {
        cwd: this.workingDir,
        encoding: "utf-8",
        timeout: 10000,
      });

    if (ownedPaths.length === 0) {
      return diff(ownedPaths);
    }

    const untracked = this.ownedUntrackedFiles(ownedPaths);
    if (untracked.length === 0) {
      return diff(ownedPaths);
    }

    execFileSync("git", ["add", "-N", "--", ...untracked], { cwd: this.workingDir, timeout: 10000 });
    try {
      return diff(ownedPaths);
    } finally {
      execFileSync("git", ["reset", "-q", "--", ...untracked], { cwd: this.workingDir, timeout: 10000 });
    }
  }

  private ownedUntrackedFiles(ownedPaths: string[]): string[] {
    const out = execFileSync(
      "git",
      ["ls-files", "-o", "--exclude-standard", "-z", "--", ...ownedPaths],
      { cwd: this.workingDir, encoding: "utf-8", timeout: 10000 },
    );
    return out.split("\0").filter((p) => p.length > 0);
  }
}
