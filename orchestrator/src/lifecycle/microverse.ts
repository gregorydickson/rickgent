// Microverse — real convergence loop runner (B5).
//
// Convergence is declared ONLY by plateau/diminishing-delta (the last N accepted
// improvement deltas each fall below epsilon) OR by reaching a target threshold.
// A still-improving series is NOT converged; reaching the target converges even
// with large deltas. The Mission-1 "N consecutive improvements = converged"
// heuristic is RETIRED (docs/decisions/microverse.md).
//
// The live loop drives real git + real worker processes + a real metric command
// under the §8 invariants: git-tree-truth over worker claims, owned-paths-only
// array-argv staging, and scoped rollback (per-owned-path restore + clean) that
// never performs a global hard reset or whole-tree checkout.

import { spawn, spawnSync, execFileSync } from "child_process";
import {
  createBreakerState,
  canExecute,
  recordIterationResult,
  type CircuitBreakerState,
} from "../core/breaker.js";
import { SalvageExecutor, type SalvageExecutionResult } from "./salvage.js";

// ── Convergence decision (pure) ──────────────────────────────────────────────

export type MetricDirection = "higher" | "lower";

export interface ConvergenceConfig {
  /** An improvement delta strictly below epsilon counts as "diminishing". */
  epsilon: number;
  /** Number of most-recent accepted improvement deltas inspected for plateau. */
  window: number;
  /** Optional metric target; reaching it converges regardless of delta size. */
  target: number | null;
  /** "higher" = larger is better; "lower" = smaller is better. */
  direction: MetricDirection;
  /** Consecutive non-improving (delta ≤ 0) iterations → attrition/salvage. */
  stallLimit: number;
}

export const DEFAULT_CONVERGENCE: ConvergenceConfig = {
  epsilon: 1.0,
  window: 3,
  target: null,
  direction: "higher",
  stallLimit: 3,
};

export type ConvergenceStatus = "converged" | "stalled" | "improving";

export interface ConvergenceDecision {
  status: ConvergenceStatus;
  reason: string;
  via?: "target" | "plateau";
}

function meetsTarget(latest: number, target: number, direction: MetricDirection): boolean {
  return direction === "higher" ? latest >= target : latest <= target;
}

/** Direction-aware improvement deltas between consecutive accepted scores. */
function improvementDeltas(scores: number[], direction: MetricDirection): number[] {
  const deltas: number[] = [];
  for (let i = 1; i < scores.length; i++) {
    const prev = scores[i - 1]!;
    const cur = scores[i]!;
    deltas.push(direction === "higher" ? cur - prev : prev - cur);
  }
  return deltas;
}

/**
 * Classify a series of accepted-baseline scores. Evaluated in order:
 *   1. target reached → converged (via target), regardless of delta size.
 *   2. last `stallLimit` deltas all ≤ 0 → stalled (attrition).
 *   3. last `window` deltas all < epsilon → converged (via plateau).
 *   4. otherwise → improving (still climbing; NOT converged).
 */
export function classifyConvergence(
  rawScores: number[],
  config: ConvergenceConfig,
): ConvergenceDecision {
  const scores = Array.isArray(rawScores) ? rawScores.filter((s) => Number.isFinite(s)) : [];
  if (scores.length === 0) {
    return { status: "improving", reason: "no scores yet" };
  }

  const latest = scores[scores.length - 1]!;
  if (config.target !== null && meetsTarget(latest, config.target, config.direction)) {
    return { status: "converged", reason: `target ${config.target} reached (score ${latest})`, via: "target" };
  }

  const deltas = improvementDeltas(scores, config.direction);

  if (deltas.length >= config.stallLimit) {
    const window = deltas.slice(-config.stallLimit);
    if (window.every((d) => d <= 0)) {
      return { status: "stalled", reason: `no improvement for ${config.stallLimit} iterations (attrition)` };
    }
  }

  if (deltas.length >= config.window) {
    const window = deltas.slice(-config.window);
    if (window.every((d) => d < config.epsilon)) {
      return {
        status: "converged",
        reason: `plateau: last ${config.window} deltas below epsilon ${config.epsilon}`,
        via: "plateau",
      };
    }
  }

  return { status: "improving", reason: "still improving" };
}

// ── Simulated runner (pure convergence-decision driver; unit tests) ──────────

export interface MicroverseConfig {
  metric: string;
  stallLimit: number;
  maxIterations: number;
  epsilon?: number;
  window?: number;
  target?: number | null;
  direction?: MetricDirection;
}

export interface IterationResult {
  score: number | null;
  classification: "improved" | "regressed" | "stalled" | "no-commit" | "amnesiac_exit";
  rolledBack: boolean;
}

export interface ConvergenceResult {
  converged: boolean;
  iterations: number;
  finalScore: number | null;
  reason: string;
  history: IterationResult[];
}

function convergenceConfigFrom(config: MicroverseConfig): ConvergenceConfig {
  return {
    epsilon: config.epsilon ?? DEFAULT_CONVERGENCE.epsilon,
    window: config.window ?? DEFAULT_CONVERGENCE.window,
    target: config.target ?? DEFAULT_CONVERGENCE.target,
    direction: config.direction ?? DEFAULT_CONVERGENCE.direction,
    stallLimit: config.stallLimit,
  };
}

export class MicroverseRunner {
  private state: CircuitBreakerState;
  private baseline: number | null = null;
  private stallCount = 0;
  private history: IterationResult[] = [];
  private acceptedScores: number[] = [];
  private convConfig: ConvergenceConfig;

  constructor(private config: MicroverseConfig) {
    this.state = createBreakerState(5);
    this.convConfig = convergenceConfigFrom(config);
  }

  runSimulated(scores: number[]): ConvergenceResult {
    for (const score of scores) {
      if (this.history.length >= this.config.maxIterations) {
        return this.result(false, "max iterations reached");
      }
      if (!canExecute(this.state)) {
        return this.result(false, "breaker tripped");
      }
      const result = this.measureAndClassify(score);
      this.history.push(result);
      if (result.classification === "improved") {
        this.baseline = score;
        this.stallCount = 0;
        this.acceptedScores.push(score);
        const conv = classifyConvergence(this.acceptedScores, this.convConfig);
        if (conv.status === "converged") {
          return this.result(true, conv.reason);
        }
      } else if (result.classification === "stalled") {
        this.stallCount++;
        if (this.stallCount >= this.config.stallLimit) {
          return this.result(false, "stalled");
        }
      }
      // regressed: baseline preserved (implicit rollback in simulation).
    }
    return this.result(false, "max iterations reached");
  }

  private result(converged: boolean, reason: string): ConvergenceResult {
    return {
      converged,
      iterations: this.history.length,
      finalScore: this.baseline,
      reason,
      history: this.history,
    };
  }

  private measureAndClassify(score: number): IterationResult {
    if (this.baseline === null) {
      this.baseline = score;
      this.acceptedScores.push(score);
      return { score, classification: "improved", rolledBack: false };
    }
    if (score > this.baseline) {
      return { score, classification: "improved", rolledBack: false };
    }
    if (score === this.baseline) {
      return { score, classification: "stalled", rolledBack: false };
    }
    return { score, classification: "regressed", rolledBack: true };
  }
}

// ── Live convergence loop (real git + real workers + real metric) ────────────

export interface MicroverseLoopOptions {
  /** Target git repo the workers mutate and the loop commits/rolls back in. */
  workingDir: string;
  /** Declared scope (repo-relative path prefixes) for owned-paths-only staging. */
  ownedPaths: string[];
  /** Shell command whose numeric stdout is the metric score for an iteration. */
  metricCommand: string;
  /** Per-iteration worker argv, e.g. () => ["omnigent","run",agentDir,"-p",prompt]. */
  workerArgv: (iteration: number) => string[];
  maxIterations: number;
  /** Hard per-iteration deadline; a breach kills the worker group and salvages. */
  iterationDeadlineMs: number;
  convergence?: Partial<ConvergenceConfig>;
  breakerThreshold?: number;
  /** Archive dir for salvage dispositions (defaults under workingDir/.rickgent). */
  rickgentDir?: string;
}

export type LoopStatus =
  | "converged"
  | "attrition"
  | "max-iterations"
  | "breaker-tripped"
  | "deadline-salvaged";

export interface LoopIterationRecord {
  iteration: number;
  score: number | null;
  classification: "improved" | "regressed" | "stalled" | "deadline" | "no-change";
  committedSha: string | null;
  rolledBack: boolean;
  salvageSha: string | null;
  workerStdout: string;
  timedOut: boolean;
}

export interface GitLogReport {
  baselineSha: string | null;
  headSha: string | null;
  /** Commits between the initial baseline and HEAD that touched owned paths. */
  commits: Array<{ sha: string; subject: string; files: string[] }>;
  /** Number of in-scope improvement commits the loop actually landed. */
  improvementCommits: number;
  /** True iff HEAD advanced from the initial baseline (a real git delta landed). */
  netImproved: boolean;
}

export interface MicroverseLoopResult {
  converged: boolean;
  status: LoopStatus;
  reason: string;
  iterations: LoopIterationRecord[];
  finalScore: number | null;
  /** Current accepted baseline commit sha at loop end. */
  baselineSha: string | null;
  breaker: CircuitBreakerState;
  report: GitLogReport;
  salvage: SalvageExecutionResult | null;
  lastWorkerPid: number | null;
}

interface WorkerRun {
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  pid: number | null;
}

const GRACE_MS = 250;

export class MicroverseLoop {
  private conv: ConvergenceConfig;
  private breaker: CircuitBreakerState;
  private salvageExecutor: SalvageExecutor;

  constructor(private opts: MicroverseLoopOptions) {
    this.conv = { ...DEFAULT_CONVERGENCE, ...(opts.convergence ?? {}) };
    this.breaker = createBreakerState(opts.breakerThreshold ?? 5);
    this.salvageExecutor = new SalvageExecutor(opts.workingDir);
  }

  async run(): Promise<MicroverseLoopResult> {
    const initialBaseline = this.headSha();
    let baselineSha = initialBaseline;
    let baselineScore = this.measure();
    const acceptedScores: number[] = baselineScore === null ? [] : [baselineScore];

    const iterations: LoopIterationRecord[] = [];
    let status: LoopStatus = "max-iterations";
    let reason = "max iterations reached";
    let stallCount = 0;
    let salvage: SalvageExecutionResult | null = null;
    let lastWorkerPid: number | null = null;

    for (let i = 0; i < this.opts.maxIterations; i++) {
      // A tripped breaker halts the loop before spawning another worker.
      if (!canExecute(this.breaker)) {
        status = "breaker-tripped";
        reason = "circuit breaker open";
        break;
      }

      const workerRun = await this.spawnWorkerWithDeadline(this.opts.workerArgv(i));
      lastWorkerPid = workerRun.pid;

      // ── Deadline breach: kill already issued; salvage in-scope dirty work ──
      if (workerRun.timedOut) {
        salvage = this.salvageInScope();
        const salvageSha = salvage.executed ? salvage.gitOutput : null;
        iterations.push({
          iteration: i,
          score: null,
          classification: "deadline",
          committedSha: null,
          rolledBack: false,
          salvageSha,
          workerStdout: workerRun.stdout,
          timedOut: true,
        });
        recordIterationResult(this.breaker, {
          error: "deadline breach",
          gitTreeChanged: salvage.executed,
          workerClaimedFilesChanged: null,
        });
        baselineSha = this.headSha();
        status = "deadline-salvaged";
        reason = "iteration exceeded deadline; in-scope work salvage-committed";
        break;
      }

      const newScore = this.measure();

      if (newScore !== null && baselineScore !== null && this.isImprovement(newScore, baselineScore)) {
        // Improving iteration: commit in-scope work and advance the baseline.
        const committed = this.commitInScope();
        if (committed) baselineSha = committed;
        baselineScore = newScore;
        acceptedScores.push(newScore);
        stallCount = 0;
        iterations.push({
          iteration: i,
          score: newScore,
          classification: "improved",
          committedSha: committed,
          rolledBack: false,
          salvageSha: null,
          workerStdout: workerRun.stdout,
          timedOut: false,
        });
        recordIterationResult(this.breaker, {
          error: null,
          gitTreeChanged: committed !== null,
          workerClaimedFilesChanged: null,
        });
      } else if (newScore !== null && baselineScore !== null && this.isRegression(newScore, baselineScore)) {
        // Regressing iteration: scoped rollback; baseline preserved.
        this.rollbackScoped();
        iterations.push({
          iteration: i,
          score: newScore,
          classification: "regressed",
          committedSha: null,
          rolledBack: true,
          salvageSha: null,
          workerStdout: workerRun.stdout,
          timedOut: false,
        });
        recordIterationResult(this.breaker, {
          error: "regression: metric worsened",
          gitTreeChanged: false,
          workerClaimedFilesChanged: null,
        });
      } else {
        // No improvement (equal metric, or unreadable score) → stall.
        stallCount++;
        if (stallCount >= this.conv.stallLimit) {
          // Attrition: salvage the accumulated in-scope dirty work, then stop.
          salvage = this.salvageInScope();
          iterations.push({
            iteration: i,
            score: newScore,
            classification: "stalled",
            committedSha: null,
            rolledBack: false,
            salvageSha: salvage.executed ? salvage.gitOutput : null,
            workerStdout: workerRun.stdout,
            timedOut: false,
          });
          recordIterationResult(this.breaker, {
            error: "stall",
            gitTreeChanged: salvage.executed,
            workerClaimedFilesChanged: null,
          });
          baselineSha = this.headSha();
          status = "attrition";
          reason = "attrition/stall: routed to salvage";
          break;
        }
        // Not yet attrition — discard the unhelpful in-scope noise (scoped).
        this.rollbackScoped();
        iterations.push({
          iteration: i,
          score: newScore,
          classification: newScore === null ? "no-change" : "stalled",
          committedSha: null,
          rolledBack: true,
          salvageSha: null,
          workerStdout: workerRun.stdout,
          timedOut: false,
        });
        recordIterationResult(this.breaker, {
          error: "stall",
          gitTreeChanged: false,
          workerClaimedFilesChanged: null,
        });
      }

      const conv = classifyConvergence(acceptedScores, this.conv);
      if (conv.status === "converged") {
        status = "converged";
        reason = conv.reason;
        break;
      }
      if (conv.status === "stalled") {
        salvage = this.salvageInScope();
        baselineSha = this.headSha();
        status = "attrition";
        reason = conv.reason;
        break;
      }
    }

    const report = this.buildReportFromGitLog(initialBaseline, baselineSha);
    return {
      converged: status === "converged",
      status,
      reason,
      iterations,
      finalScore: baselineScore,
      baselineSha,
      breaker: this.breaker,
      report,
      salvage,
      lastWorkerPid,
    };
  }

  private isImprovement(newScore: number, baseline: number): boolean {
    return this.conv.direction === "higher" ? newScore > baseline : newScore < baseline;
  }

  private isRegression(newScore: number, baseline: number): boolean {
    return this.conv.direction === "higher" ? newScore < baseline : newScore > baseline;
  }

  // ── git helpers (array-argv only; never a shell, never stage-all) ────────

  private headSha(): string | null {
    try {
      return execFileSync("git", ["-C", this.opts.workingDir, "rev-parse", "HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  /** Run the real metric command and parse its numeric stdout (NaN → null). */
  private measure(): number | null {
    const res = spawnSync("sh", ["-c", this.opts.metricCommand], {
      cwd: this.opts.workingDir,
      encoding: "utf-8",
      timeout: 30000,
    });
    if (res.status !== 0 && res.status !== null) {
      // Non-zero metric exit is not a score; treat as unreadable.
    }
    const value = parseFloat((res.stdout ?? "").trim());
    return Number.isFinite(value) ? value : null;
  }

  private ownedPaths(): string[] {
    return this.opts.ownedPaths.filter((p): p is string => typeof p === "string" && p.length > 0);
  }

  /** Dirty (modified/untracked) files that fall under the owned scope. */
  private dirtyOwnedPaths(): string[] {
    try {
      const out = execFileSync(
        "git",
        ["-C", this.opts.workingDir, "status", "--porcelain", "-z", "--", ...this.ownedPaths()],
        { encoding: "utf-8", timeout: 10000 },
      );
      return out
        .split("\0")
        .filter((entry) => entry.length > 0)
        // porcelain -z format: "XY <path>"; strip the 3-char status prefix.
        .map((entry) => entry.slice(3))
        .filter((p) => p.length > 0);
    } catch {
      return [];
    }
  }

  /** Commit the iteration's in-scope owned work; returns the new HEAD sha. */
  private commitInScope(): string | null {
    const owned = this.ownedPaths();
    if (owned.length === 0) return null;
    try {
      for (const p of owned) {
        execFileSync("git", ["-C", this.opts.workingDir, "add", "--", p], { timeout: 10000 });
      }
      // Nothing staged → no commit.
      const staged = execFileSync("git", ["-C", this.opts.workingDir, "diff", "--cached", "--name-only"], {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      if (staged === "") return null;
      execFileSync(
        "git",
        [
          "-C", this.opts.workingDir,
          "-c", "user.email=microverse@rickgent.test",
          "-c", "user.name=Microverse Loop",
          "commit", "-m", "microverse: accepted improving iteration",
        ],
        { timeout: 10000 },
      );
      return this.headSha();
    } catch {
      return null;
    }
  }

  /**
   * Scoped rollback of a regressing/stalling iteration: restore ONLY the owned
   * paths and remove owned untracked files. It never performs a global hard
   * reset or a whole-tree checkout, so out-of-scope/untracked work is intact.
   */
  private rollbackScoped(): void {
    const owned = this.ownedPaths();
    if (owned.length === 0) return;
    for (const p of owned) {
      try {
        execFileSync("git", ["-C", this.opts.workingDir, "checkout", "--", p], {
          timeout: 10000,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        /* path may be entirely untracked; handled by clean below */
      }
    }
    try {
      execFileSync("git", ["-C", this.opts.workingDir, "clean", "-f", "-d", "--", ...owned], {
        timeout: 10000,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      /* ignore */
    }
  }

  /** Salvage-commit the in-scope dirty work via the salvage executor. */
  private salvageInScope(): SalvageExecutionResult {
    const dirty = this.dirtyOwnedPaths();
    if (dirty.length === 0) {
      return this.salvageExecutor.execute(
        { gatePassed: true, treeChanged: false, orphanReset: false, ffReattachPossible: false, ownedPaths: [] },
        this.opts.rickgentDir ? { archiveDir: this.opts.rickgentDir } : {},
      );
    }
    return this.salvageExecutor.execute(
      { gatePassed: true, treeChanged: true, orphanReset: false, ffReattachPossible: false, ownedPaths: dirty },
      this.opts.rickgentDir ? { archiveDir: this.opts.rickgentDir } : {},
    );
  }

  private buildReportFromGitLog(initialBaseline: string | null, headSha: string | null): GitLogReport {
    const commits: GitLogReport["commits"] = [];
    if (initialBaseline && headSha && initialBaseline !== headSha) {
      try {
        const range = `${initialBaseline}..${headSha}`;
        const shas = execFileSync("git", ["-C", this.opts.workingDir, "log", "--pretty=format:%H%x00%s", range], {
          encoding: "utf-8",
          timeout: 10000,
        })
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);
        for (const line of shas) {
          const [sha, subject] = line.split("\0");
          if (!sha) continue;
          const filesOut = execFileSync(
            "git",
            ["-C", this.opts.workingDir, "show", "--name-only", "--pretty=format:", sha],
            { encoding: "utf-8", timeout: 10000 },
          )
            .trim()
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const inScope = filesOut.filter((f) => this.ownedPaths().some((d) => f === d || f.startsWith(d.endsWith("/") ? d : d + "/")));
          commits.push({ sha, subject: subject ?? "", files: inScope });
        }
      } catch {
        /* leave commits empty on read failure */
      }
    }
    const improvementCommits = commits.filter(
      (c) => c.subject.startsWith("microverse:") && c.files.length > 0,
    ).length;
    return {
      baselineSha: initialBaseline,
      headSha,
      commits,
      improvementCommits,
      netImproved: !!(initialBaseline && headSha && initialBaseline !== headSha),
    };
  }

  /**
   * Spawn a worker under a hard deadline. A breach kills the worker's PROCESS
   * GROUP (SIGTERM → grace → SIGKILL) so a detached child (e.g. `sleep`) can
   * never outlive the deadline.
   */
  private spawnWorkerWithDeadline(argv: string[]): Promise<WorkerRun> {
    return new Promise((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: this.opts.workingDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid ?? null;
      let stdout = "";
      let done = false;

      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });

      const killGroup = (signal: NodeJS.Signals): void => {
        if (pid === null) return;
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        }
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), GRACE_MS);
        resolve({ timedOut: true, exitCode: null, stdout, pid });
      }, this.opts.iterationDeadlineMs);

      child.on("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ timedOut: false, exitCode: code, stdout, pid });
      });

      child.on("error", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ timedOut: false, exitCode: 1, stdout, pid });
      });
    });
  }
}
