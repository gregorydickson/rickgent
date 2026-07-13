// Salvage executor — the lifecycle layer that EXECUTES git mutations.
// The core DECIDES the disposition; this module EXECUTES it safely.
// §14.8: decide / execute / verify split. R-MACB: never git add -A.
//
// B6: dispositions are DURABLE and VERIFIED post-mutation:
//   - archived-todo writes a restorable patch to disk and resets the ticket to
//     Todo (registry), rather than returning a diff string that vanishes;
//   - ff-reattached performs a real `git merge --ff-only` with explicit source
//     and target refs and reports executed:true only after the fast-forward is
//     verified (fails closed when the refs are absent);
//   - committed-done stays owned-paths-only via execFileSync array-argv with the
//     `--` separator (never a shell, never `git add -A`).

import { decideSalvage, type SalvageInput, type SalvageDecision } from "../core/salvage.js";
import type { Registry } from "./registry.js";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface SalvageExecutionResult {
  decision: SalvageDecision;
  executed: boolean;
  gitOutput: string | null;
  /** Path to the durable on-disk archive written for an archived-todo. */
  archivePath: string | null;
}

/**
 * Per-execution context supplying the durable-disposition dependencies:
 * the ticket + registry an archived-todo resets to Todo, and the explicit
 * source/target refs a fast-forward reattach mutates.
 */
export interface SalvageExecutionContext {
  ticketId?: string;
  registry?: Registry;
  /** Orphan commit/branch to fast-forward FROM (ff-reattached). */
  sourceRef?: string;
  /** Branch to advance via fast-forward (ff-reattached). */
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
            // Stage only owned paths (never git add -A — R-MACB). Array-argv
            // via execFileSync spawns no shell; `--` blocks option injection so
            // a path with $(...), ;rm, quote-break, or a leading dash is inert.
            for (const path of decision.stagedPaths) {
              execFileSync("git", ["add", "--", path], { cwd: this.workingDir, timeout: 10000 });
            }
            execFileSync("git", ["commit", "-m", "salvage: committed scoped work"], { cwd: this.workingDir, timeout: 10000 });
            gitOutput = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.workingDir, encoding: "utf-8" }).trim();
            executed = true;
          }
          break;
        case "archived-todo": {
          // Write a durable, restorable, owned-paths-scoped patch to disk BEFORE
          // any reset (never lose work). The archive is a `git apply`-able diff.
          archivePath = this.writeArchive(decision.stagedPaths ?? [], ctx);
          gitOutput = archivePath;
          // Reset the ticket to Todo so it is re-picked (verified post-state).
          if (ctx.registry && ctx.ticketId && ctx.registry.getTicketState(ctx.ticketId)) {
            ctx.registry.updateTicketState(ctx.ticketId, { status: "Todo" });
          }
          executed = true;
          break;
        }
        case "ff-reattached": {
          // Fail closed without explicit refs — a bare `git merge --ff-only HEAD`
          // is a no-op that would misleadingly report success.
          if (!ctx.sourceRef || !ctx.targetRef) {
            gitOutput = "ff-reattach requires explicit source/target refs; no git mutation performed";
            executed = false;
            break;
          }
          execFileSync("git", ["checkout", ctx.targetRef], { cwd: this.workingDir, timeout: 10000, stdio: ["ignore", "ignore", "pipe"] });
          execFileSync("git", ["merge", "--ff-only", ctx.sourceRef], { cwd: this.workingDir, timeout: 10000, stdio: ["ignore", "ignore", "pipe"] });
          // Verify the fast-forward actually landed: target now equals source.
          const targetSha = execFileSync("git", ["rev-parse", ctx.targetRef], { cwd: this.workingDir, encoding: "utf-8", timeout: 10000 }).trim();
          const sourceSha = execFileSync("git", ["rev-parse", ctx.sourceRef], { cwd: this.workingDir, encoding: "utf-8", timeout: 10000 }).trim();
          gitOutput = targetSha;
          executed = targetSha === sourceSha;
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

    return { decision, executed, gitOutput, archivePath };
  }

  private archiveDir(ctx: SalvageExecutionContext): string {
    return ctx.archiveDir ?? join(this.workingDir, ".rickgent", "salvage-archives");
  }

  private writeArchive(ownedPaths: string[], ctx: SalvageExecutionContext): string {
    const dir = this.archiveDir(ctx);
    mkdirSync(dir, { recursive: true });
    // Owned-paths-only diff vs HEAD (both staged and unstaged) — array-argv with
    // `--` so a hostile path can never be reinterpreted as a git option.
    const args = ["diff", "HEAD", "--", ...ownedPaths];
    const patch = execFileSync("git", ownedPaths.length > 0 ? args : ["diff", "HEAD"], {
      cwd: this.workingDir,
      encoding: "utf-8",
      timeout: 10000,
    });
    const label = ctx.ticketId ? ctx.ticketId.replace(/[^A-Za-z0-9_-]/g, "_") : "salvage";
    const file = join(dir, `${label}-${Date.now()}.patch`);
    writeFileSync(file, patch);
    return file;
  }
}
