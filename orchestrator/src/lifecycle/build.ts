// Build loop (B1) — the autonomous PRD → PR lifecycle.
//
// `runBuild` decomposes a PRD into ≥1 ticket and dispatches each through the
// REAL production `Dispatcher` path. Every Done is the terminal `completed`
// state of a dispatch, which is only reachable through the single completion
// oracle (`evaluateCompletion`, caller `dispatch.completion`) — the build never
// declares Done by any other path. Between the plan gate and the merge gate the
// loop is strictly non-interactive: a ticket failure is ABSORBED by the circuit
// breaker + salvage executor and the run continues; it never prompts a human or
// prints a "run this yourself" instruction. A genuine human-gate hit (an invalid
// PRD, an empty decomposition, or a merge gate that autonomous_pr_flow will not
// grant) records an intervention in the durable ledger and exits non-zero.
//
// `runPipeline` runs the full build then the cleanup chain (orphan-reaper +
// reconcile). `runBuild({resume:true})` recovers the completed tickets from the
// ledger + git via `reconcile` and re-dispatches only the unfinished ones.

import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  Dispatcher,
  DispatchLedger,
  TicketLock,
  dispatchLedgerPath,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
} from "../dispatch/dispatch.js";
import { DispatchQueue } from "../dispatch/queue.js";
import { Registry, type TicketState } from "./registry.js";
import { SalvageExecutor } from "./salvage.js";
import { reconcile } from "./reconcile.js";
import {
  createBreakerState,
  recordIterationResult,
  canExecute,
  type CircuitBreakerState,
} from "../core/breaker.js";
import { evaluatePrd } from "../core/prd.js";
import { parsePrdFile, type TicketPlan } from "./prd-parse.js";
import { createPullRequest } from "./pr-flow.js";
import {
  reapOrphanedWorkerProcs,
  detectBackend,
  type ReapResult,
} from "./orphan-reaper.js";

export interface BuildOptions {
  prdPath: string;
  /** Target git repo the workers mutate. */
  workingDir: string;
  /** `.rickgent` state dir (ledger, registry, interventions, salvage). */
  rickgentDir: string;
  /** omnigent agent bundle dir the Dispatcher spawns. */
  agentDir: string;
  /** OMNIGENT_DATA_DIR root for per-dispatch DB-session isolation. */
  dataDir: string;
  resume?: boolean;
  /** Default true. When false the merge gate is a human gate (fail-closed). */
  autonomousPrFlow?: boolean;
  featureBranch?: string | undefined;
  runId?: string | undefined;
  maxConcurrent?: number | undefined;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BuildResult {
  ok: boolean;
  exitCode: number;
  gateHit: string | null;
  ticketsPlanned: number;
  ticketsDispatched: number;
  ticketsDone: number;
  ticketsFailed: number;
  ticketsRecovered: number;
  interventions: number;
  prBranch: string | null;
  prCreated: boolean;
  report: string[];
}

export function interventionLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "interventions.jsonl");
}

function salvageLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "salvage-dispositions.jsonl");
}

/** Record a human-gate hit. A build that runs autonomously never appends here. */
export function recordIntervention(rickgentDir: string, gate: string, reason: string): void {
  mkdirSync(rickgentDir, { recursive: true });
  appendFileSync(
    interventionLedgerPath(rickgentDir),
    JSON.stringify({ gate, reason, at: new Date().toISOString() }) + "\n",
  );
}

export function countInterventions(rickgentDir: string): number {
  const p = interventionLedgerPath(rickgentDir);
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

function recordSalvageDisposition(rickgentDir: string, entry: Record<string, unknown>): void {
  mkdirSync(rickgentDir, { recursive: true });
  appendFileSync(
    salvageLedgerPath(rickgentDir),
    JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n",
  );
}

function revParseHead(repo: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
  } catch {
    return null;
  }
}

function computeTreeChanged(repo: string, baseline: string | null, env: NodeJS.ProcessEnv): boolean {
  let dirty = "";
  try {
    dirty = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
  } catch {
    dirty = "";
  }
  const head = revParseHead(repo, env);
  return dirty.length > 0 || (head !== null && head !== baseline);
}

function ticketPrompt(ticket: TicketPlan): string {
  const paths = ticket.declaredPaths.join(", ");
  return `Implement ${ticket.id}: ${ticket.description}\nDeclared paths: ${paths}`;
}

function seedRegistry(registry: Registry, runId: string, tickets: TicketPlan[]): string {
  const state = registry.load();
  const effectiveRunId = state.runId || runId;
  const merged: Record<string, TicketState> = { ...state.tickets };
  for (const t of tickets) {
    if (!merged[t.id]) {
      merged[t.id] = {
        id: t.id,
        title: t.title,
        status: "Todo",
        phase: "planned",
        declaredPaths: t.declaredPaths,
        attempt: 0,
        completionCommitSha: null,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  registry.save({
    runId: effectiveRunId,
    tickets: merged,
    startedAt: state.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return effectiveRunId;
}

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const env = opts.env ?? process.env;
  const report: string[] = [];
  mkdirSync(opts.rickgentDir, { recursive: true });

  const base: BuildResult = {
    ok: false,
    exitCode: 0,
    gateHit: null,
    ticketsPlanned: 0,
    ticketsDispatched: 0,
    ticketsDone: 0,
    ticketsFailed: 0,
    ticketsRecovered: 0,
    interventions: 0,
    prBranch: null,
    prCreated: false,
    report,
  };

  // ── Parse + PRD gate ───────────────────────────────────────────────────
  const parsed = parsePrdFile(opts.prdPath);
  base.ticketsPlanned = parsed.tickets.length;
  report.push(
    `build: parsed PRD "${parsed.prd.title}" — ${parsed.tickets.length} ticket(s), ` +
      `${parsed.prd.acceptanceCriteria.length} acceptance criteria`,
  );

  const prdVerdict = evaluatePrd(parsed.prd);
  if (!prdVerdict.valid) {
    recordIntervention(opts.rickgentDir, "prd-gate", `PRD invalid: ${prdVerdict.errors.join("; ")}`);
    report.push(`build: PRD GATE hit — ${prdVerdict.errors.join("; ")} (recorded intervention, exiting non-zero)`);
    return { ...base, exitCode: 1, gateHit: "prd-gate", interventions: countInterventions(opts.rickgentDir) };
  }

  // ── Plan gate ──────────────────────────────────────────────────────────
  if (parsed.tickets.length === 0) {
    recordIntervention(opts.rickgentDir, "plan-gate", "decomposition produced zero tickets");
    report.push("build: PLAN GATE hit — decomposition produced zero tickets (recorded intervention, exiting non-zero)");
    return { ...base, exitCode: 1, gateHit: "plan-gate", interventions: countInterventions(opts.rickgentDir) };
  }

  // ── Dispatch infra ───────────────────────────────────────────────────────
  const ledger = new DispatchLedger(dispatchLedgerPath(opts.rickgentDir));
  const lock = new TicketLock(join(opts.rickgentDir, "locks"));
  const dispatcher = new Dispatcher(ledger, lock, opts.rickgentDir);
  const registry = new Registry(join(opts.rickgentDir, "registry.json"));
  const salvageExec = new SalvageExecutor(opts.workingDir);
  const breaker: CircuitBreakerState = createBreakerState();

  const runId = seedRegistry(registry, opts.runId ?? `run-${Date.now()}`, parsed.tickets);

  // ── Resume: recover completed tickets from ledger + git via reconcile ─────
  const recoveredDone = new Set<string>();
  if (opts.resume) {
    const rec = reconcile(opts.workingDir, opts.rickgentDir);
    for (const [id, t] of Object.entries(rec.registry.tickets)) {
      if (t.status === "Done") recoveredDone.add(id);
    }
    report.push(
      `build --resume: reconcile recovered ${recoveredDone.size} completed ticket(s) ` +
        `from ledger + git (${rec.ticketsFound} total ledger/git tickets)`,
    );
  }

  // ── Implementation loop — a backpressure queue drains all tickets under the
  // concurrency cap (B3). Recovered-Done tickets are never re-dispatched; the
  // rest are enqueued (durably recorded `planned`) and drained FIFO, at most
  // `maxConcurrent` in flight, a slot freeing the instant a dispatch settles.
  // There are NO human prompts between the plan and merge gates: a failure is
  // absorbed by the circuit breaker + salvage and the queue keeps draining.
  const cap = opts.maxConcurrent ?? 2;

  const toDispatch: TicketPlan[] = [];
  for (const ticket of parsed.tickets) {
    if (recoveredDone.has(ticket.id)) {
      base.ticketsRecovered++;
      if (registry.getTicketState(ticket.id)) {
        registry.updateTicketState(ticket.id, { status: "Done" });
      }
      report.push(`  ${ticket.id}: recovered Done via reconcile (resume) — not re-dispatched`);
      continue;
    }
    toDispatch.push(ticket);
  }

  const queue = new DispatchQueue(ledger, cap);
  const idByTicket = new Map<string, DispatchId>();
  const ticketByDispatchId = new Map<string, TicketPlan>();
  for (const ticket of toDispatch) {
    const id: DispatchId = { runId, ticketId: ticket.id, phase: "implement", attempt: 1, role: "worker" };
    idByTicket.set(ticket.id, id);
    ticketByDispatchId.set(dispatchIdString(id), ticket);
    queue.enqueue(id);
  }

  // Tickets deferred because the circuit breaker was OPEN at their spawn time —
  // they were absorbed (disposition recorded), not dispatched.
  const deferred = new Set<string>();

  const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
    const ticket = ticketByDispatchId.get(dispatchIdString(id))!;

    if (!canExecute(breaker)) {
      deferred.add(ticket.id);
      recordSalvageDisposition(opts.rickgentDir, {
        ticketId: ticket.id,
        disposition: "breaker-open",
        executed: false,
      });
      report.push(`  ${ticket.id}: circuit breaker OPEN — deferred (absorbed, no prompt)`);
      return {
        dispatchId: dispatchIdString(id),
        state: "failed",
        pid: null,
        startedAt: null,
        completedAt: new Date().toISOString(),
        exitCode: null,
        stdout: null,
        stderr: "breaker-open: deferred, not dispatched",
      };
    }

    const baseline = revParseHead(opts.workingDir, env);
    const entry = await dispatcher.dispatch(id, {
      agentDir: opts.agentDir,
      prompt: ticketPrompt(ticket),
      timeout: opts.timeout ?? 60000,
      maxConcurrent: cap,
      targetRepo: opts.workingDir,
      dataDir: opts.dataDir,
      declaredPaths: ticket.declaredPaths,
      env,
    });

    if (entry.state === "completed") {
      if (registry.getTicketState(ticket.id)) {
        registry.updateTicketState(ticket.id, {
          status: "Done",
          phase: "implement",
          completionCommitSha: entry.commitSha ?? null,
        });
      }
      report.push(
        `  ${ticket.id}: Done — dispatch reached the oracle-gated completed state ` +
          `(commit ${(entry.commitSha ?? "?").slice(0, 12)})`,
      );
      return entry;
    }

    // FAILURE ABSORBED — circuit breaker + salvage, never a prompt.
    const treeChanged = computeTreeChanged(opts.workingDir, baseline, env);
    const transition = recordIterationResult(breaker, {
      error: entry.stderr || `dispatch terminal state ${entry.state}`,
      gitTreeChanged: treeChanged,
      workerClaimedFilesChanged: null,
    });
    const salvage = salvageExec.execute(
      {
        gatePassed: false,
        treeChanged,
        orphanReset: false,
        ffReattachPossible: false,
        ownedPaths: ticket.declaredPaths,
      },
      { ticketId: ticket.id, registry },
    );
    recordSalvageDisposition(opts.rickgentDir, {
      ticketId: ticket.id,
      dispatchState: entry.state,
      disposition: salvage.decision.disposition,
      executed: salvage.executed,
      archivePath: salvage.archivePath,
      breaker: transition.transition,
    });
    report.push(
      `  ${ticket.id}: FAILED (${entry.state}) → salvage=${salvage.decision.disposition} ` +
        `breaker=${transition.transition} — absorbed, continuing non-interactively`,
    );
    return entry;
  };

  const drain = await queue.drain(dispatchFn);

  for (const ticket of toDispatch) {
    if (deferred.has(ticket.id)) continue; // breaker-open: absorbed, not dispatched
    const entry = drain.results.get(dispatchIdString(idByTicket.get(ticket.id)!));
    if (!entry) continue;
    base.ticketsDispatched++;
    if (entry.state === "completed") base.ticketsDone++;
    else base.ticketsFailed++;
  }

  // ── Merge gate ───────────────────────────────────────────────────────────
  const featureBranch =
    opts.featureBranch ?? env.RICKGENT_FEATURE_BRANCH ?? `rickgent/${runId}`;
  const autonomousPr = opts.autonomousPrFlow !== false && env.RICKGENT_AUTONOMOUS_PR_FLOW !== "0";

  if (!autonomousPr) {
    recordIntervention(
      opts.rickgentDir,
      "merge-gate",
      "autonomous PR flow disabled; a human must open the PR",
    );
    report.push(
      "build: MERGE GATE hit — autonomous PR flow disabled; a human must open the PR " +
        "(recorded intervention, exiting non-zero)",
    );
    return {
      ...base,
      exitCode: 1,
      gateHit: "merge-gate",
      prBranch: featureBranch,
      interventions: countInterventions(opts.rickgentDir),
    };
  }

  if (base.ticketsDone === 0) {
    report.push(
      "build: no tickets completed; skipping PR creation " +
        "(ticket failures were absorbed by salvage/breaker — not a human gate)",
    );
    return { ...base, ok: true, exitCode: 0, interventions: countInterventions(opts.rickgentDir) };
  }

  const pr = createPullRequest(opts.workingDir, featureBranch, parsed.prd.title, env);
  base.prBranch = pr.branch;
  report.push(
    `build: merge gate — autonomous_pr_flow push=${pr.pushVerdict.result} ` +
      `gh-pr-create=${pr.prVerdict.result}`,
  );
  if (pr.prCreated) {
    base.prCreated = true;
    report.push(`build: PR branch '${pr.branch}' created; gh pr create issued (${pr.ghOutput || "ok"})`);
    return { ...base, ok: true, exitCode: 0, interventions: countInterventions(opts.rickgentDir) };
  }

  // The autonomous PR path could not complete → human gate.
  recordIntervention(opts.rickgentDir, "merge-gate", pr.error ?? "PR creation blocked");
  report.push(`build: MERGE GATE hit — ${pr.error ?? "PR creation blocked"} (recorded intervention, exiting non-zero)`);
  return {
    ...base,
    exitCode: 1,
    gateHit: "merge-gate",
    interventions: countInterventions(opts.rickgentDir),
  };
}

export interface CleanupResult {
  report: string[];
  reap: ReapResult;
  ticketsReconciled: number;
}

/** The cleanup chain run after a build: orphan-reaper sweep + reconcile. */
export function runCleanup(
  workingDir: string,
  rickgentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CleanupResult {
  void env;
  const reap = reapOrphanedWorkerProcs(detectBackend());
  const rec = reconcile(workingDir, rickgentDir);
  const report = [
    `cleanup: orphan-reaper scanned=${reap.scanned} reaped=${reap.reaped} skipped=${reap.skipped}`,
    `cleanup: reconcile rebuilt=${rec.rebuilt} ticketsFound=${rec.ticketsFound}`,
  ];
  return { report, reap, ticketsReconciled: rec.ticketsFound };
}

export interface PipelineResult extends BuildResult {
  cleanup: CleanupResult;
}

/** `rickgent pipeline` — the full build followed by the cleanup chain. */
export async function runPipeline(opts: BuildOptions): Promise<PipelineResult> {
  const build = await runBuild(opts);
  const cleanup = runCleanup(opts.workingDir, opts.rickgentDir, opts.env);
  return { ...build, report: [...build.report, ...cleanup.report], cleanup };
}
