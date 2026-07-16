// Microverse CLI — standalone metric-driven convergence loop.
//
// Wraps the existing MicroverseLoop (lifecycle/microverse.ts) as the
// `rickgent microverse` command. It resolves flags, fails closed on malformed
// input BEFORE any state is written or worker spawned, spawns workers via
// `omnigent run <agentDir> -p <prompt>` (array argv — never a shell string),
// measures a metric (a shell command's last numeric line) or a `--goal` LLM
// judge (also via `omnigent run`), accepts/reverts per the loop's owned-paths
// discipline, and converges on plateau/target. Session state is persisted to
// `.rickgent/microverse.json` for `--resume`.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";
import {
  MicroverseLoop,
  parseLastNumericLine,
  type MetricDirection,
  type MicroverseLoopResult,
} from "./microverse.js";
import {
  failLifecycleCommand,
  lifecycleCommandSucceeded,
  type LifecycleCommandResult,
} from "./command-result.js";

const MICROVERSE_USAGE = `rickgent microverse — metric-driven convergence loop

Usage:
  rickgent microverse (--metric <cmd> | --goal <text>) --task <text> [options]

Objective (exactly one required):
  --metric <cmd>            Shell command whose last numeric stdout line is the score
  --goal <text>             Natural-language goal scored by an omnigent-run LLM judge

Required:
  --task <text>             What each worker iteration should attempt

Options:
  --direction higher|lower  Improvement direction (default: higher)
  --max-iterations <N>      Iteration cap (default: 50)
  --stall-limit <N>         Consecutive non-improving iterations before stopping (default: 5)
  --epsilon <F>             Plateau delta threshold (default: 1.0)
  --window <N>              Plateau window of recent deltas (default: 3)
  --target <F>              Converge as soon as the score meets/crosses this target
  --repo <dir>              Target git repo (default: cwd)
  --agent <dir>             omnigent agent bundle directory
  --owned-paths <list>      Comma/space-separated in-scope path prefixes (default: .)
  --iteration-deadline-ms <N>  Per-iteration hard deadline in ms (default: 300000)
  --non-interactive         Never prompt stdin (this command never prompts)
  --resume                  Continue from .rickgent/microverse.json
`;

interface StateHistoryEntry {
  iteration: number;
  score: number | null;
  classification: string;
  committedSha: string | null;
}

interface FailedApproach {
  iteration: number;
  score: number | null;
  classification: string;
}

interface MicroverseState {
  task: string;
  mode: "metric" | "goal";
  metric: string | null;
  goal: string | null;
  direction: MetricDirection;
  baseline_score: number;
  final_score: number | null;
  converged: boolean;
  status: string;
  convergence: {
    reason: string;
    history: StateHistoryEntry[];
  };
  failed_approaches: FailedApproach[];
  updatedAt: string;
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseIntFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = parseInt(raw, 10);
  return Number.isNaN(v) ? fallback : v;
}

function parseFloatFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function parseOwnedPaths(raw: string | undefined): string[] {
  if (!raw) return ["."];
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : ["."];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function getRickgentDir(): string {
  return process.env.RICKGENT_DIR ?? join(process.cwd(), ".rickgent");
}

function buildJudgePrompt(goal: string): string {
  return [
    "You are a read-only evaluation judge. Do NOT modify any files; use only read-only tools.",
    `Goal: ${goal}`,
    "Inspect the current repository state and score progress toward the goal on a 0-100 numeric scale.",
    "Output ONLY the numeric score as the last line of your response.",
  ].join("\n");
}

function buildWorkerPrompt(
  iteration: number,
  task: string,
  goal: string | null,
  metric: string | null,
  direction: MetricDirection,
  failed: FailedApproach[],
): string {
  const lines: string[] = [
    `Microverse iteration ${iteration + 1}.`,
    `Task: ${task}`,
  ];
  if (goal) {
    lines.push(`Goal: ${goal}`);
  } else if (metric) {
    lines.push(`Optimize this metric (direction: ${direction} is better): ${metric}`);
  }
  lines.push(
    "Make ONE focused, incremental change toward the objective. Only edit files within the owned scope. Leave the change uncommitted; the loop commits improvements and reverts regressions.",
  );
  if (failed.length > 0) {
    lines.push("Previously reverted/failed approaches (do not repeat them):");
    for (const f of failed.slice(-5)) {
      lines.push(`- iteration ${f.iteration}: ${f.classification} (score ${f.score ?? "n/a"})`);
    }
  }
  return lines.join("\n");
}

function measureViaJudge(
  agentDir: string,
  workingDir: string,
  goal: string,
  dataDir: string,
): number | null {
  const res = spawnSync("omnigent", ["run", agentDir, "-p", buildJudgePrompt(goal)], {
    cwd: workingDir,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, OMNIGENT_DATA_DIR: dataDir },
  });
  if (res.error) return null;
  if (res.status !== 0 && res.status !== null) return null;
  return parseLastNumericLine(res.stdout ?? "");
}

function measureViaMetric(
  metricCommand: string,
  workingDir: string,
): { ok: boolean; score: number | null; exitCode: number | null } {
  const res = spawnSync("sh", ["-c", metricCommand], {
    cwd: workingDir,
    encoding: "utf-8",
    timeout: 30000,
  });
  if (res.error) return { ok: false, score: null, exitCode: null };
  const exitCode = res.status;
  if (exitCode !== 0 && exitCode !== null) return { ok: false, score: null, exitCode };
  return { ok: true, score: parseLastNumericLine(res.stdout ?? ""), exitCode };
}

function mapClassification(classification: string): string {
  return classification === "deadline" ? "deadline_exceeded" : classification;
}

function deriveReason(result: MicroverseLoopResult): string {
  switch (result.status) {
    case "converged":
      return /target/i.test(result.reason) ? "target" : "plateau";
    case "attrition":
      return "plateau";
    case "max-iterations":
      return "max_iterations";
    case "deadline-salvaged":
      return "deadline_exceeded";
    case "breaker-tripped":
      return "breaker";
    default:
      return result.status;
  }
}

function readPriorState(statePath: string): MicroverseState | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MicroverseState>;
    if (parsed == null || typeof parsed !== "object") return null;
    return parsed as MicroverseState;
  } catch {
    return null;
  }
}

export async function runMicroverseCommand(
  rest: string[],
): Promise<LifecycleCommandResult> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(MICROVERSE_USAGE);
    return lifecycleCommandSucceeded();
  }

  if (rest.includes("--resume")) RUNTIME_CAPABILITY_GATE.require("resume_retry");
  if (rest.includes("--metric")) RUNTIME_CAPABILITY_GATE.require("raw_shell");
  RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");

  const task = flagValue(rest, "--task");
  const metric = flagValue(rest, "--metric");
  const goal = flagValue(rest, "--goal");
  const resume = rest.includes("--resume");

  // ── Fail-closed input validation (before any spawn or state write) ──────
  if (!task || task.trim() === "") {
    failLifecycleCommand("rickgent microverse: --task is required");
  }

  const hasMetric = metric !== undefined;
  const hasGoal = goal !== undefined;
  if (hasMetric && hasGoal) {
    failLifecycleCommand("rickgent microverse: --metric and --goal are mutually exclusive");
  }
  if (!hasMetric && !hasGoal) {
    failLifecycleCommand("rickgent microverse: exactly one of --metric or --goal is required");
  }

  const workingDir = resolve(flagValue(rest, "--repo") ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd());
  const agentDir = resolve(
    flagValue(rest, "--agent") ??
      process.env.RICKGENT_AGENT_DIR ??
      join(new URL("../../../", import.meta.url).pathname, "agents", "rickgent"),
  );

  if (!isDir(agentDir)) {
    failLifecycleCommand(`rickgent microverse: missing agent directory: ${agentDir}`);
  }
  if (!isDir(workingDir)) {
    failLifecycleCommand(`rickgent microverse: missing repo directory: ${workingDir}`);
  }

  const direction: MetricDirection = flagValue(rest, "--direction") === "lower" ? "lower" : "higher";
  const maxIterations = parseIntFlag(flagValue(rest, "--max-iterations"), 50);
  const stallLimit = parseIntFlag(flagValue(rest, "--stall-limit"), 5);
  const epsilon = parseFloatFlag(flagValue(rest, "--epsilon"), 1.0);
  const window = parseIntFlag(flagValue(rest, "--window"), 3);
  const targetRaw = flagValue(rest, "--target");
  const target = targetRaw !== undefined && Number.isFinite(Number(targetRaw)) ? Number(targetRaw) : null;
  const ownedPaths = parseOwnedPaths(flagValue(rest, "--owned-paths"));
  const iterationDeadlineMs = parseIntFlag(flagValue(rest, "--iteration-deadline-ms"), 300000);

  const rickgentDir = getRickgentDir();
  const dataDir = process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data");
  const statePath = join(rickgentDir, "microverse.json");

  // ── Resume: load prior state (baseline + accepted series + failed set) ──
  let prior: MicroverseState | null = null;
  if (resume) {
    prior = readPriorState(statePath);
    if (!prior) {
      failLifecycleCommand(`rickgent microverse: --resume but no readable state at ${statePath}`);
    }
  }

  // ── Measure and validate the baseline BEFORE writing state / spawning ──
  let baselineScore: number;
  let initialAcceptedScores: number[] | undefined;
  if (prior) {
    if (typeof prior.baseline_score !== "number" || !Number.isFinite(prior.baseline_score)) {
      failLifecycleCommand("rickgent microverse: --resume state has no numeric baseline_score");
    }
    baselineScore = prior.baseline_score;
    // Reconstruct the accepted-score series so convergence continues cleanly.
    const acceptedFromHistory = Array.isArray(prior.convergence?.history)
      ? prior.convergence.history
          .filter((h) => h.classification === "improved" && typeof h.score === "number")
          .map((h) => h.score as number)
      : [];
    initialAcceptedScores = [baselineScore, ...acceptedFromHistory];
  } else if (hasMetric) {
    const measured = measureViaMetric(metric!, workingDir);
    if (!measured.ok) {
      failLifecycleCommand(
        `rickgent microverse: metric command failed (exit ${measured.exitCode ?? "spawn-error"}): ${metric}`,
      );
    }
    if (measured.score === null) {
      failLifecycleCommand(`rickgent microverse: metric command produced no numeric output: ${metric}`);
    }
    baselineScore = measured.score;
  } else {
    const judged = measureViaJudge(agentDir, workingDir, goal!, dataDir);
    if (judged === null) {
      failLifecycleCommand("rickgent microverse: goal judge produced no numeric score");
    }
    baselineScore = judged;
  }

  const priorFailed: FailedApproach[] = prior && Array.isArray(prior.failed_approaches)
    ? prior.failed_approaches
    : [];
  const priorHistory: StateHistoryEntry[] = prior && Array.isArray(prior.convergence?.history)
    ? prior.convergence.history
    : [];

  const metricFn = hasGoal ? (): number | null => measureViaJudge(agentDir, workingDir, goal!, dataDir) : undefined;

  const loop = new MicroverseLoop({
    workingDir,
    ownedPaths,
    metricCommand: hasMetric ? metric! : undefined,
    metricFn,
    initialBaselineScore: prior ? undefined : baselineScore,
    initialAcceptedScores,
    workerArgv: (iteration: number) => [
      "omnigent",
      "run",
      agentDir,
      "-p",
      buildWorkerPrompt(iteration, task, hasGoal ? goal! : null, hasMetric ? metric! : null, direction, [
        ...priorFailed,
      ]),
    ],
    maxIterations,
    iterationDeadlineMs,
    convergence: { epsilon, window, target, direction, stallLimit },
    rickgentDir,
  });

  const result = await loop.run();

  // ── Persist state (history is a superset of any prior --resume history) ──
  const newHistory: StateHistoryEntry[] = result.iterations.map((it, idx) => ({
    iteration: priorHistory.length + idx,
    score: it.score,
    classification: mapClassification(it.classification),
    committedSha: it.committedSha ?? null,
  }));
  const history = [...priorHistory, ...newHistory];

  const newFailed: FailedApproach[] = result.iterations
    .filter((it) => ["regressed", "stalled", "deadline", "no-change"].includes(it.classification))
    .map((it, idx) => ({
      iteration: priorHistory.length + idx,
      score: it.score,
      classification: mapClassification(it.classification),
    }));
  const failedApproaches = [...priorFailed, ...newFailed];

  const state: MicroverseState = {
    task,
    mode: hasGoal ? "goal" : "metric",
    metric: hasMetric ? metric! : null,
    goal: hasGoal ? goal! : null,
    direction,
    baseline_score: baselineScore,
    final_score: result.finalScore,
    converged: result.converged,
    status: result.status,
    convergence: {
      reason: deriveReason(result),
      history,
    },
    failed_approaches: failedApproaches,
    updatedAt: new Date().toISOString(),
  };

  if (!existsSync(rickgentDir)) mkdirSync(rickgentDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

  const lines: string[] = [
    "rickgent microverse — convergence loop",
    "=".repeat(50),
    `task: ${task}`,
    `mode: ${state.mode}`,
    `direction: ${direction}`,
    `baseline_score: ${baselineScore}`,
    `final_score: ${result.finalScore ?? "(none)"}`,
    `iterations: ${result.iterations.length}`,
    `converged: ${result.converged}`,
    `status: ${result.status}`,
    `reason: ${state.convergence.reason} (${result.reason})`,
    `state: ${statePath}`,
    "=".repeat(50),
  ];
  console.log(lines.join("\n"));
  return lifecycleCommandSucceeded();
}
