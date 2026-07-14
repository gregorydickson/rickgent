// Cronenberg runner — the I/O + delegation shell around the pure planner.
//
// This module gathers the one signal the pure planner cannot compute without
// touching git (the working-tree diff size), builds the plan, prints it, and —
// unless --dry-run — delegates by running the chosen rickgent command chain as
// child rickgent processes. Cronenberg itself never launches an agent; each
// delegated command owns its own agent lifecycle.

import { execFileSync, spawnSync } from "child_process";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildCronenbergPlan,
  formatCronenbergPlan,
  type CronenbergFlags,
  type PlannedCommand,
} from "./cronenberg.js";

const CRONENBERG_USAGE = `rickgent cronenberg — deterministic meta-router

Usage:
  rickgent cronenberg --task "<goal>" [options]
  rickgent cronenberg "<goal>" [options]

Cronenberg-only flags:
  --dry-run          Print the plan and stop without running the chain
  --no-followups     Skip the cleanup/review followup chain
  --no-refine        Force-skip the refinement pre-pass
  --refine           Force-include the refinement pre-pass

Other options:
  --task <text>      The goal to route (or pass free text)
  --repo <dir>       Target repo (default: cwd)

Any other flag (e.g. --metric, --goal, --agent, --target, --max-iterations) is
forwarded verbatim to the chosen metaphor and its followups.

The router computes deterministic signals from the task + cwd state, picks a
metaphor (microverse | pipeline | build), a refine decision, and a followup
chain (citadel | anatomy | szechuan), then prints or runs the plan.`;

interface ParsedArgs {
  task: string;
  workingDir: string;
  forward: string[];
  flags: CronenbergFlags;
}

function parseArgs(rest: string[]): ParsedArgs {
  const flags: CronenbergFlags = { dryRun: false, noFollowups: false, noRefine: false, refine: false };
  const forward: string[] = [];
  const freeText: string[] = [];
  let task: string | undefined;
  let repo: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (a === "--no-followups") {
      flags.noFollowups = true;
      continue;
    }
    if (a === "--no-refine") {
      flags.noRefine = true;
      continue;
    }
    if (a === "--refine") {
      flags.refine = true;
      continue;
    }
    if (a === "--non-interactive") {
      // accepted (cronenberg never prompts) but not a signal; do not forward
      continue;
    }
    if (a === "--task") {
      task = rest[i + 1];
      i++;
      continue;
    }
    if (a === "--repo") {
      repo = rest[i + 1];
      forward.push(a);
      if (rest[i + 1] !== undefined) forward.push(rest[i + 1]!);
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      forward.push(a);
      // capture a value that does not look like a flag
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        forward.push(next);
        i++;
      }
      continue;
    }
    // bare positional → free text task material (also forwarded)
    freeText.push(a);
    forward.push(a);
  }

  const workingDir = resolve(repo ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd());
  const resolvedTask = (task ?? freeText.join(" ")).trim();
  return { task: resolvedTask, workingDir, forward, flags };
}

function measureDiffLoc(workingDir: string): number {
  for (const args of [["diff", "--numstat", "HEAD"], ["diff", "--numstat"]]) {
    const res = spawnSync("git", ["-C", workingDir, ...args], { encoding: "utf-8", timeout: 15000 });
    if (res.status !== 0 || !res.stdout) continue;
    let total = 0;
    for (const line of res.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const added = Number(parts[0]);
      const deleted = Number(parts[1]);
      if (Number.isFinite(added)) total += added;
      if (Number.isFinite(deleted)) total += deleted;
    }
    if (total > 0) return total;
  }
  return 0;
}

function cliJsPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function runChild(cmd: PlannedCommand, workingDir: string): number {
  const cli = cliJsPath();
  try {
    execFileSync(process.execPath, [cli, ...cmd.argv], {
      cwd: workingDir,
      stdio: "inherit",
    });
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
}

export async function runCronenbergCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(CRONENBERG_USAGE);
    return;
  }

  const { task, workingDir, forward, flags } = parseArgs(rest);
  const rickgentDir = process.env.RICKGENT_DIR ?? join(workingDir, ".rickgent");
  const diffLoc = measureDiffLoc(workingDir);

  const plan = buildCronenbergPlan({ task, workingDir, rickgentDir, forward, flags, diffLoc });

  if (!plan.ok) {
    console.error(`rickgent cronenberg: ${plan.error}`);
    process.exit(1);
  }

  console.log(formatCronenbergPlan(plan));

  if (flags.dryRun) {
    console.log("");
    console.log("Dry run — plan only. Re-invoke without --dry-run to run the chain.");
    return;
  }

  console.log("");
  console.log("Running the chain…");
  const chain: PlannedCommand[] = [];
  if (plan.refinePrePass) chain.push(plan.refinePrePass);
  chain.push(plan.metaphorCommand);
  for (const f of plan.followups) chain.push(f);

  for (const cmd of chain) {
    console.log(`\n▶ ${cmd.label}`);
    const code = runChild(cmd, workingDir);
    if (code !== 0) {
      console.error(`rickgent cronenberg: step failed (exit ${code}): ${cmd.label}`);
      process.exit(code);
    }
  }
}
