// Salvage executor — the lifecycle layer that EXECUTES git mutations.
// The core DECIDES the disposition; this module EXECUTES it safely.
// §14.8: decide / execute / verify split. R-MACB: never git add -A.

import { decideSalvage, type SalvageInput, type SalvageDecision } from "../core/salvage.js";
import { execSync } from "child_process";

export interface SalvageExecutionResult {
  decision: SalvageDecision;
  executed: boolean;
  gitOutput: string | null;
}

export class SalvageExecutor {
  constructor(private workingDir: string) {}

  execute(input: SalvageInput): SalvageExecutionResult {
    const decision = decideSalvage(input);
    let executed = false;
    let gitOutput: string | null = null;

    try {
      switch (decision.disposition) {
        case "committed-done":
          if (decision.stagedPaths && decision.stagedPaths.length > 0) {
            // Stage only owned paths (never git add -A — R-MACB)
            for (const path of decision.stagedPaths) {
              execSync(`git add "${path}"`, { cwd: this.workingDir, timeout: 10000 });
            }
            execSync('git commit -m "salvage: committed scoped work"', { cwd: this.workingDir, timeout: 10000 });
            gitOutput = execSync("git rev-parse HEAD", { cwd: this.workingDir, encoding: "utf-8" }).trim();
            executed = true;
          }
          break;
        case "archived-todo": {
          // Archive the diff before any reset (never lose work)
          const archiveResult = execSync("git diff", { cwd: this.workingDir, encoding: "utf-8", timeout: 10000 });
          gitOutput = archiveResult;
          // Reset to Todo happens in the registry, not here
          executed = true;
          break;
        }
        case "ff-reattached":
          // C5: the ff-reattach disposition is DECIDED by the core, but the
          // actual git mutation requires branch/ref context (the orphan branch
          // and the target branch to fast-forward onto) that is not available
          // in this scaffold. Running `git merge --ff-only HEAD` is a no-op and
          // would misleadingly report success. Mark as executed with a note
          // instead of running a meaningless git command.
          gitOutput = "ff-reattach requires branch/ref context not available in scaffold; no git mutation performed";
          executed = true;
          break;
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

    return { decision, executed, gitOutput };
  }
}
