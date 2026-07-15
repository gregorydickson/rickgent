// Build loop (B1) — the contained PRD → local-profile lifecycle.
//
// `runBuild` decomposes a PRD into ≥1 ticket and dispatches each through the
// REAL production `Dispatcher` path. Every Done is the terminal `completed`
// state of a dispatch, which is only reachable through the single completion
// oracle (`evaluateCompletion`, caller `dispatch.completion`) — the build never
// declares Done by any other path. After the plan gate, the loop is strictly
// non-interactive: a ticket failure is ABSORBED by the circuit breaker + salvage
// executor and the run continues; it never prompts a human or prints a "run this
// yourself" instruction. Required local gates and every planned ticket are
// aggregated before a typed outcome is returned.
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
import { reconcile, type ReconcileResult } from "./reconcile.js";
import {
  createBreakerState,
  recordIterationResult,
  canExecute,
  type CircuitBreakerState,
} from "../core/breaker.js";
import { evaluatePrd } from "../core/prd.js";
import { parsePrdFile, type TicketPlan } from "./prd-parse.js";
import {
  reapOrphanedWorkerProcs,
  detectBackend,
  type ReapResult,
} from "./orphan-reaper.js";
import { routeDispatch, type ModelEntry } from "./routing.js";
import { recordRun } from "./metrics.js";
import { runConformanceGate } from "./citadel.js";
import { runDeslopGate } from "./szechuan.js";
import {
  CapabilityUnavailableError,
  PRODUCTION_CAPABILITY_GATE,
  assertNoProductionBypasses,
  type CapabilityGate,
} from "../capabilities/registry.js";
import {
  aggregateRunOutcome,
  runIssue,
  type RunIssue,
  type RunOutcome,
} from "./run-outcome.js";

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
  /**
   * Live model roster (B8 multi-vendor routing). When provided, the build loop
   * calls the Python `select_model` router before each dispatch to select a
   * harness/model/vendor. The selected vendor flows into every ledger entry.
   * When absent or empty, the router returns ROSTER_EMPTY (DENY) and no
   * dispatch spawns — fail-closed, no silent hardcoded default vendor.
   */
  roster?: ModelEntry[] | undefined;
  /** Hard per-dispatch cost limit in USD (cost gate). */
  costBudgetUsd?: number | undefined;
  /** Soft cost threshold in USD (ASK when exceeded but under hard budget). */
  softThresholdUsd?: number | undefined;
  /** Explicit raw-shell request. Production rejects it before any side effect. */
  rawShell?: boolean;
  /** True when a CLI/caller supplied any delivery-related configuration. */
  deliveryConfigured?: boolean;
}

export interface BuildDependencies {
  capabilityGate?: CapabilityGate;
  assertEnvironment?: (env: NodeJS.ProcessEnv) => void;
  verifyPolicyAttachment?: typeof verifyPolicyAttachment;
  runConformanceGate?: typeof runConformanceGate;
  runDeslopGate?: typeof runDeslopGate;
  /** Explicit fixture-only omissions; production entrypoints never set these. */
  skipPolicyAttachment?: boolean;
  skipConformance?: boolean;
  skipDeslop?: boolean;
}

export interface BuildResult {
  outcome: RunOutcome;
  gateHit: string | null;
  ticketsPlanned: number;
  ticketsDispatched: number;
  ticketsDone: number;
  ticketsFailed: number;
  ticketsRecovered: number;
  interventions: number;
  report: string[];
}

type BuildObservation = Omit<BuildResult, "outcome">;

function finishBuild(base: BuildObservation, issues: readonly RunIssue[]): BuildResult {
  const outcome = aggregateRunOutcome(issues);
  const reasons = outcome.issues.map((issue) => issue.reason).join(",") || "none";
  base.report.push(
    `build: outcome=${outcome.status} primary=${outcome.primary} ` +
      `code=${outcome.stableCode} issues=${reasons}`,
  );
  return { ...base, outcome };
}

function verifiedCompletion(entry: DispatchEntry): boolean {
  return entry.state === "completed" &&
    entry.exitCode === 0 &&
    typeof entry.conversationId === "string" &&
    entry.conversationId.length > 0 &&
    typeof entry.commitSha === "string" &&
    entry.commitSha.length > 0 &&
    typeof entry.baselineSha === "string" &&
    entry.baselineSha.length > 0 &&
    entry.treeChanged === true &&
    Array.isArray(entry.declaredPaths);
}

export function interventionLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "interventions.jsonl");
}

function salvageLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "salvage-dispositions.jsonl");
}

/** Record a human-gate hit. A build that runs autonomously never appends here. */
export function recordIntervention(
  rickgentDir: string,
  gate: string,
  reason: string,
  runId?: string,
): void {
  mkdirSync(rickgentDir, { recursive: true });
  const rec: Record<string, unknown> = { gate, reason, at: new Date().toISOString() };
  if (runId) rec.runId = runId;
  appendFileSync(
    interventionLedgerPath(rickgentDir),
    JSON.stringify(rec) + "\n",
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

/** Parse the RICKGENT_MODEL_ROSTER env var (JSON array of model entries). */
function parseRosterEnv(env: NodeJS.ProcessEnv): ModelEntry[] {
  const raw = env.RICKGENT_MODEL_ROSTER;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m) => m && typeof m.harness === "string" && typeof m.model === "string" && typeof m.vendor === "string",
    );
  } catch {
    return [];
  }
}

/** Parse a numeric env var, returning undefined on absence/invalid. */
function parseNumberEnv(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
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

export async function runBuild(
  opts: BuildOptions,
  dependencies: BuildDependencies = {},
): Promise<BuildResult> {
  const env = opts.env ?? process.env;
  (dependencies.assertEnvironment ?? assertNoProductionBypasses)(env);
  const capabilityGate = dependencies.capabilityGate ?? PRODUCTION_CAPABILITY_GATE;
  if (opts.resume) capabilityGate.require("resume_retry");
  if ((opts.maxConcurrent ?? 1) > 1) capabilityGate.require("parallel_dispatch");
  if (opts.deliveryConfigured || opts.featureBranch !== undefined || opts.autonomousPrFlow !== undefined) {
    capabilityGate.require("automatic_delivery");
  }
  if (opts.rawShell || env.RICKGENT_RAW_SHELL === "1") capabilityGate.require("raw_shell");
  capabilityGate.require("autonomous_dispatch");

  const report: string[] = [];
  mkdirSync(opts.rickgentDir, { recursive: true });

  const base: BuildObservation = {
    gateHit: null,
    ticketsPlanned: 0,
    ticketsDispatched: 0,
    ticketsDone: 0,
    ticketsFailed: 0,
    ticketsRecovered: 0,
    interventions: 0,
    report,
  };
  const issues: RunIssue[] = [];

  // ── Parse + PRD gate ───────────────────────────────────────────────────
  const parsed = parsePrdFile(opts.prdPath);
  base.ticketsPlanned = parsed.tickets.length;
  report.push(
    `build: parsed PRD "${parsed.prd.title}" — ${parsed.tickets.length} ticket(s), ` +
      `${parsed.prd.acceptanceCriteria.length} acceptance criteria`,
  );

  // Record this run in the durable runs ledger so B9 `rickgent metrics` can
  // compute interventions/run. The runId is resolved consistently with
  // seedRegistry below (opts.runId, else a timestamped default).
  const requestedRunId = opts.runId ?? `run-${Date.now()}`;
  recordRun(opts.rickgentDir, requestedRunId, parsed.prd.title);

  const prdVerdict = evaluatePrd(parsed.prd);
  if (!prdVerdict.valid) {
    recordIntervention(opts.rickgentDir, "prd-gate", `PRD invalid: ${prdVerdict.errors.join("; ")}`, requestedRunId);
    report.push(`build: PRD GATE hit — ${prdVerdict.errors.join("; ")} (recorded intervention, exiting non-zero)`);
    issues.push(runIssue({
      reason: "input_contract_error",
      class: "input_contract",
      detail: `PRD invalid: ${prdVerdict.errors.join("; ")}`,
      gate: "prd-gate",
    }));
    return finishBuild({
      ...base,
      gateHit: "prd-gate",
      interventions: countInterventions(opts.rickgentDir),
    }, issues);
  }

  // ── Plan gate ──────────────────────────────────────────────────────────
  if (parsed.tickets.length === 0) {
    recordIntervention(opts.rickgentDir, "plan-gate", "decomposition produced zero tickets", requestedRunId);
    report.push("build: PLAN GATE hit — decomposition produced zero tickets (recorded intervention, exiting non-zero)");
    issues.push(runIssue({
      reason: "zero_ticket",
      class: "execution",
      detail: "decomposition produced zero tickets",
      gate: "plan-gate",
    }));
    return finishBuild({
      ...base,
      gateHit: "plan-gate",
      interventions: countInterventions(opts.rickgentDir),
    }, issues);
  }

  // ── Policy attachment verification (B4 gate) ─────────────────────────────
  // Before any dispatch, verify that the manager + worker bundles attach the
  // full required policy set. This is the same check `rickgent doctor` runs,
  // but wired into the build startup so a build cannot proceed with ungated
  // policies. Test fixtures may replace the checker only by dependency injection.
  if (dependencies.skipPolicyAttachment) {
    report.push("build: policy attachment — skipped by explicit fixture dependency (blocking)");
    issues.push(runIssue({
      reason: "required_gate_failed",
      class: "verification",
      detail: "required policy attachment gate was skipped",
      gate: "policy-attachment",
    }));
  } else {
    const attachResult = (dependencies.verifyPolicyAttachment ?? verifyPolicyAttachment)(opts.agentDir, env);
    if (attachResult.ok) {
      report.push(
        `build: policy attachment — manager: PASS, worker: PASS ` +
          `(${attachResult.managerCount}/${attachResult.workerCount} policies)`,
      );
    } else {
      // Fail closed: missing policy attachment is a human gate (not a bypass).
      recordIntervention(
        opts.rickgentDir,
        "policy-attachment-gate",
        attachResult.detail,
        requestedRunId,
      );
      report.push(
        `build: POLICY ATTACHMENT GATE hit — ${attachResult.detail} ` +
          "(recorded intervention, exiting non-zero)",
      );
      issues.push(runIssue({
        reason: "required_gate_failed",
        class: "verification",
        detail: attachResult.detail,
        gate: "policy-attachment",
      }));
      return finishBuild({
        ...base,
        gateHit: "policy-attachment-gate",
        interventions: countInterventions(opts.rickgentDir),
      }, issues);
    }
  }

  // ── Model roster (B8 multi-vendor routing) ────────────────────────────────
  // The live roster is resolved from BuildOptions.roster or the
  // RICKGENT_MODEL_ROSTER env var (JSON). When absent/empty, the router returns
  // ROSTER_EMPTY (DENY) and no dispatch spawns — fail-closed, no silent
  // hardcoded default vendor.
  const roster = opts.roster ?? parseRosterEnv(env);
  const costBudgetUsd = opts.costBudgetUsd ?? parseNumberEnv(env.RICKGENT_COST_BUDGET_USD);
  const softThresholdUsd = opts.softThresholdUsd ?? parseNumberEnv(env.RICKGENT_SOFT_THRESHOLD_USD);
  if (roster.length > 0) {
    report.push(`build: model roster loaded — ${roster.length} model(s), cost budget=$${costBudgetUsd ?? "unbounded"}`);
  } else {
    report.push("build: no model roster — router will DENY all dispatches (fail-closed)");
  }

  // Track the implementer's vendor per ticket so a code_review dispatch can
  // pass it to the router for cross-vendor exclusion.
  const implementerVendorByTicket = new Map<string, string>();

  // ── Dispatch infra ───────────────────────────────────────────────────────
  const ledger = new DispatchLedger(dispatchLedgerPath(opts.rickgentDir));
  const lock = new TicketLock(join(opts.rickgentDir, "locks"));
  const dispatcher = new Dispatcher(ledger, lock, opts.rickgentDir, capabilityGate);
  const registry = new Registry(join(opts.rickgentDir, "registry.json"));
  const salvageExec = new SalvageExecutor(opts.workingDir);
  const breaker: CircuitBreakerState = createBreakerState();

  const runId = seedRegistry(registry, requestedRunId, parsed.tickets);

  // ── Resume: recover completed tickets from ledger + git via reconcile ─────
  const recoveredDone = new Set<string>();
  if (opts.resume) {
    const rec = reconcile(opts.workingDir, opts.rickgentDir, undefined, capabilityGate);
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
  // There are NO human prompts after the plan gate: a failure is absorbed by
  // the circuit breaker + salvage and the queue keeps draining.
  const cap = opts.maxConcurrent ?? 1;

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

  const queue = new DispatchQueue(ledger, cap, capabilityGate);
  const idByTicket = new Map<string, DispatchId>();
  const ticketByDispatchId = new Map<string, TicketPlan>();
  for (const ticket of toDispatch) {
    const id: DispatchId = { runId, ticketId: ticket.id, phase: "implement", attempt: 1, role: "worker" };
    idByTicket.set(ticket.id, id);
    ticketByDispatchId.set(dispatchIdString(id), ticket);
    queue.enqueue(id);
  }

  const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
    const ticket = ticketByDispatchId.get(dispatchIdString(id))!;

    if (!canExecute(breaker)) {
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
        terminalReason: "breaker_deferred",
      };
    }

    // ── Pre-dispatch model routing (B8) ──────────────────────────────────
    // Call the Python select_model router BEFORE spawning the worker. The
    // router enforces: fail-closed on empty roster, cross-vendor review
    // exclusion (code_review role excludes implementer's vendor), and the
    // cost gate (unpriced/over-hard-budget → DENY, over-soft-threshold → ASK).
    // On ALLOW, the selected vendor flows into the dispatch opts and from
    // there into every ledger entry. On DENY/ASK, no dispatch spawns
    // (fail-closed) — the ticket is absorbed by salvage/breaker.
    const routerRole = id.role === "worker" ? "implement" : id.role;
    const implementerVendor = routerRole === "code_review"
      ? (implementerVendorByTicket.get(ticket.id) ?? null)
      : null;
    const routed = routeDispatch(roster, routerRole, {
      implementerVendor,
      costBudgetUsd: costBudgetUsd ?? null,
      softThresholdUsd: softThresholdUsd ?? null,
    }, capabilityGate);

    if (!routed.ok) {
      const v = routed.verdict;
      const reason = v.result === "DENY"
        ? `routing DENY (${v.code}): ${v.reason}`
        : `routing ASK (${v.code}): ${v.reason}`;
      report.push(`  ${ticket.id}: router ${v.result} (${v.code}) — not dispatched (fail-closed)`);
      const failedEntry: DispatchEntry = {
        dispatchId: dispatchIdString(id),
        state: "failed",
        pid: null,
        startedAt: null,
        completedAt: new Date().toISOString(),
        exitCode: null,
        stdout: null,
        stderr: reason,
        terminalReason: ["ROUTING_SUBPROCESS_ERROR", "ROUTING_MALFORMED"].includes(v.code)
          ? "infrastructure_error"
          : "routing_denied",
        vendor: null,
      };
      ledger.append(failedEntry);

      // Absorb via salvage/breaker, same as any other dispatch failure.
      const treeChanged = computeTreeChanged(opts.workingDir, revParseHead(opts.workingDir, env), env);
      const transition = recordIterationResult(breaker, {
        error: reason,
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
        dispatchState: "failed",
        disposition: salvage.decision.disposition,
        executed: salvage.executed,
        archivePath: salvage.archivePath,
        breaker: transition.transition,
        routerVerdict: v.result,
        routerCode: v.code,
      });
      return failedEntry;
    }

    const selectedVendor = routed.selection.vendor;
    // Record the implementer's vendor for cross-vendor review exclusion.
    if (routerRole === "implement") {
      implementerVendorByTicket.set(ticket.id, selectedVendor);
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
      vendor: selectedVendor,
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

  // Account for every planned ticket exactly once. No deferred or missing
  // result is allowed to disappear from the run denominator.
  for (const ticket of toDispatch) {
    const entry = drain.results.get(dispatchIdString(idByTicket.get(ticket.id)!));
    if (!entry) {
      base.ticketsFailed++;
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail: "dispatch queue produced no terminal observation",
        ticketId: ticket.id,
      }));
      continue;
    }

    base.ticketsDispatched++;
    if (verifiedCompletion(entry)) {
      base.ticketsDone++;
      continue;
    }

    base.ticketsFailed++;
    if (entry.state === "completed" || entry.terminalReason === "evidence_unverifiable" || entry.exitCode === 0) {
      issues.push(runIssue({
        reason: "evidence_unverifiable",
        class: "verification",
        detail: "dispatch did not carry complete oracle evidence",
        ticketId: ticket.id,
      }));
    } else if (entry.terminalReason === "infrastructure_error") {
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail: entry.stderr ?? "dispatch infrastructure failed",
        ticketId: ticket.id,
      }));
    } else {
      issues.push(runIssue({
        reason: "ticket_failed",
        class: "execution",
        detail: entry.stderr ?? `dispatch terminal state ${entry.state}`,
        ticketId: ticket.id,
      }));
    }
  }

  const accounted = base.ticketsDone + base.ticketsFailed + base.ticketsRecovered;
  if (accounted !== base.ticketsPlanned) {
    issues.push(runIssue({
      reason: "infrastructure_error",
      class: "infrastructure",
      detail: `ticket accounting mismatch: planned=${base.ticketsPlanned} accounted=${accounted}`,
    }));
  }
  if (base.ticketsDone + base.ticketsRecovered === 0) {
    issues.push(runIssue({
      reason: "zero_completion",
      class: "execution",
      detail: "no planned ticket reached verified completion",
    }));
  } else if (base.ticketsFailed > 0) {
    issues.push(runIssue({
      reason: "partial_failure",
      class: "execution",
      detail: `${base.ticketsFailed} of ${base.ticketsPlanned} planned tickets failed`,
    }));
  }
  const verifiedTickets = base.ticketsDone + base.ticketsRecovered;

  // ── Salvage/breaker infrastructure status ────────────────────────────────
  // Report the salvage/breaker infrastructure state after the dispatch loop.
  // On a failure path, individual ticket salvage dispositions are recorded
  // inline; on a success path, the infrastructure is still live and observable.
  const salvagePath = salvageLedgerPath(opts.rickgentDir);
  const salvageCount = existsSync(salvagePath)
    ? readFileSync(salvagePath, "utf-8").split("\n").filter((l) => l.trim().length > 0).length
    : 0;
  report.push(
    `build: salvage/breaker — ${salvageCount} disposition(s) recorded, ` +
      `breaker state=${canExecute(breaker) ? "CLOSED (executing)" : "OPEN (deferring)"}`,
  );

  // ── Conformance gate (citadel) ───────────────────────────────────────────
  // After implementation, run each acceptance criterion's verifyCommand
  // against the working repo. This is the post-implementation conformance
  // audit that validates the implemented code against the PRD's acceptance
  // criteria. A failing AC is absorbed (not a human intervention) but recorded
  // as a gate finding. Test fixtures may replace it only by dependency injection.
  if (verifiedTickets > 0 && dependencies.skipConformance) {
    report.push("build: conformance gate — skipped by explicit fixture dependency (blocking)");
    issues.push(runIssue({
      reason: "required_gate_failed",
      class: "verification",
      detail: "required conformance gate was skipped",
      gate: "conformance",
    }));
  } else if (verifiedTickets > 0) {
    try {
      const conformanceResult = (dependencies.runConformanceGate ?? runConformanceGate)(
        parsed.prd.acceptanceCriteria,
        opts.workingDir,
        env,
        capabilityGate,
      );
      const acResults = conformanceResult.results.map(
        (r) => `${r.acId}: ${r.pass ? "PASS" : "FAIL"}`,
      );
      report.push(
        `build: conformance gate — ${conformanceResult.passed}/${conformanceResult.total} ACs passed ` +
          `(${acResults.join(", ")})`,
      );
      if (conformanceResult.failed > 0) {
        issues.push(runIssue({
          reason: "required_gate_failed",
          class: "verification",
          detail: `${conformanceResult.failed} conformance checks failed`,
          gate: "conformance",
        }));
        for (const r of conformanceResult.results) {
          if (!r.pass) {
            recordSalvageDisposition(opts.rickgentDir, {
              gate: "conformance",
              acId: r.acId,
              disposition: "conformance-failed",
              executed: false,
              detail: r.detail,
            });
          }
        }
      }
    } catch (error) {
      report.push(`build: conformance gate — infrastructure error: ${error instanceof Error ? error.message : String(error)}`);
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail: `conformance gate threw: ${error instanceof Error ? error.message : String(error)}`,
        gate: "conformance",
      }));
    }
  } else if (!dependencies.skipConformance) {
    report.push("build: conformance gate — skipped (no tickets completed)");
  }

  // ── Deslop gate (szechuan) ───────────────────────────────────────────────
  // After conformance, run a basic code quality check on the changed files.
  // This is the deslop gate that catches obvious slop patterns (TODO, FIXME,
  // console.log, debugger, etc.) in the implemented code. A finding is absorbed
  // (not a human intervention) but recorded. Test fixtures may replace the
  // checker only by dependency injection.
  if (verifiedTickets > 0 && dependencies.skipDeslop) {
    report.push("build: deslop gate — skipped by explicit fixture dependency (blocking)");
    issues.push(runIssue({
      reason: "required_gate_failed",
      class: "verification",
      detail: "required deslop gate was skipped",
      gate: "deslop",
    }));
  } else if (verifiedTickets > 0) {
    try {
      const deslopResult = (dependencies.runDeslopGate ?? runDeslopGate)(opts.workingDir, parsed.tickets, env);
      report.push(
        `build: deslop gate — checked ${deslopResult.filesChecked} file(s), ` +
          `${deslopResult.findings} finding(s)`,
      );
      if (deslopResult.findings > 0) {
        issues.push(runIssue({
          reason: "required_gate_failed",
          class: "verification",
          detail: `${deslopResult.findings} deslop findings remain`,
          gate: "deslop",
        }));
        for (const f of deslopResult.details) {
          recordSalvageDisposition(opts.rickgentDir, {
            gate: "deslop",
            disposition: "deslop-finding",
            executed: false,
            detail: f,
          });
        }
      }
    } catch (error) {
      report.push(`build: deslop gate — infrastructure error: ${error instanceof Error ? error.message : String(error)}`);
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail: `deslop gate threw: ${error instanceof Error ? error.message : String(error)}`,
        gate: "deslop",
      }));
    }
  } else if (!dependencies.skipDeslop) {
    report.push("build: deslop gate — skipped (no tickets completed)");
  }

  report.push("build: local profile complete; automatic delivery is structurally absent");
  return finishBuild({
    ...base,
    interventions: countInterventions(opts.rickgentDir),
  }, issues);
}

export interface CleanupResult {
  status: "succeeded" | "failed";
  issues: readonly RunIssue[];
  report: string[];
  reap: ReapResult;
  reconcile: ReconcileResult | null;
  ticketsReconciled: number;
}

/** The cleanup chain run after a build: orphan-reaper sweep + reconcile. */
export function runCleanup(
  workingDir: string,
  rickgentDir: string,
  env: NodeJS.ProcessEnv = process.env,
  capabilityGate: CapabilityGate = PRODUCTION_CAPABILITY_GATE,
): CleanupResult {
  const issues: RunIssue[] = [];
  const report: string[] = [];
  let reap: ReapResult;
  let rec: ReconcileResult | null = null;

  try {
    capabilityGate.require("reconciliation");
  } catch (error) {
    if (error instanceof CapabilityUnavailableError) {
      issues.push(runIssue({
        reason: "capability_unavailable",
        class: "capability_unavailable",
        detail: error.message,
        capabilityCode: error.capability.error_code,
      }));
    } else {
      issues.push(runIssue({
        reason: "cleanup_failed",
        class: "cleanup",
        detail: `cleanup preflight threw: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
    reap = { scanned: 0, reaped: 0, skipped: 0, errors: ["cleanup preflight failed"] };
    report.push(`cleanup: preflight failed — ${issues[0]!.detail}`);
    return { status: "failed", issues, report, reap, reconcile: null, ticketsReconciled: 0 };
  }

  try {
    reap = reapOrphanedWorkerProcs(detectBackend(process.platform, env), { env });
  } catch (error) {
    reap = {
      scanned: 0,
      reaped: 0,
      skipped: 0,
      errors: [`reaper threw: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  report.push(
    `cleanup: orphan-reaper scanned=${reap.scanned} reaped=${reap.reaped} ` +
      `skipped=${reap.skipped} errors=${reap.errors.length}`,
  );
  if (reap.errors.length > 0) {
    issues.push(runIssue({
      reason: "cleanup_failed",
      class: "cleanup",
      detail: `orphan reaper errors: ${reap.errors.join("; ")}`,
      gate: "orphan-reaper",
    }));
  }

  try {
    rec = reconcile(workingDir, rickgentDir, undefined, capabilityGate);
    report.push(
      `cleanup: reconcile rebuilt=${rec.rebuilt} ticketsFound=${rec.ticketsFound} ` +
        `errors=${rec.errors.length}`,
    );
    if (!rec.ok || rec.errors.length > 0) {
      issues.push(runIssue({
        reason: "cleanup_failed",
        class: "cleanup",
        detail: `reconcile failed: ${rec.errors.join("; ") || "result was not ok"}`,
        gate: "reconcile",
      }));
    }
  } catch (error) {
    report.push(`cleanup: reconcile threw — ${error instanceof Error ? error.message : String(error)}`);
    issues.push(runIssue({
      reason: "cleanup_failed",
      class: "cleanup",
      detail: `reconcile threw: ${error instanceof Error ? error.message : String(error)}`,
      gate: "reconcile",
    }));
  }

  return {
    status: issues.length === 0 ? "succeeded" : "failed",
    issues: Object.freeze([...issues]),
    report,
    reap,
    reconcile: rec,
    ticketsReconciled: rec?.ticketsFound ?? 0,
  };
}

export interface PipelineResult extends BuildResult {
  cleanup: CleanupResult;
}

/** `rickgent pipeline` — the full build followed by the cleanup chain. */
export async function runPipeline(
  opts: BuildOptions,
  dependencies: BuildDependencies = {},
): Promise<PipelineResult> {
  const capabilityGate = dependencies.capabilityGate ?? PRODUCTION_CAPABILITY_GATE;
  // Preflight cleanup before build mutation; unavailable required cleanup can
  // never be discovered only after work has started.
  capabilityGate.require("reconciliation");
  const build = await runBuild(opts, dependencies);
  const cleanup = runCleanup(
    opts.workingDir,
    opts.rickgentDir,
    opts.env,
    capabilityGate,
  );
  const outcome = aggregateRunOutcome([...build.outcome.issues, ...cleanup.issues]);
  const report = [...build.report, ...cleanup.report];
  report.push(
    `pipeline: outcome=${outcome.status} primary=${outcome.primary} ` +
      `code=${outcome.stableCode} issues=${outcome.issues.map((issue) => issue.reason).join(",") || "none"}`,
  );
  return { ...build, outcome, report, cleanup };
}

// ── Policy attachment verification (B4 gate) ────────────────────────────────
//
// Verifies that the manager + worker bundles attach the full required policy
// set via the omnigent static parser. This is the same check `rickgent doctor`
// runs, but wired into build startup so a build cannot proceed with ungated
// policies. Fails CLOSED (non-zero exit + intervention) on a missing policy.

export interface PolicyAttachResult {
  ok: boolean;
  detail: string;
  managerCount: number;
  workerCount: number;
}

export function verifyPolicyAttachment(agentDir: string, env: NodeJS.ProcessEnv): PolicyAttachResult {
  // Resolve manager + worker bundle dirs from the agent dir.
  // agentDir is typically agents/rickgent (manager); worker is agents/rickgent/agents/worker.
  const managerDir = agentDir;
  const workerDir = join(agentDir, "agents", "worker");

  // Missing bundle configuration is not evidence of attachment.
  if (!existsSync(join(managerDir, "config.yaml")) && !existsSync(join(workerDir, "config.yaml"))) {
    return {
      ok: false,
      detail: "manager and worker config.yaml are missing",
      managerCount: 0,
      workerCount: 0,
    };
  }

  const py = [
    "import json, os, sys",
    "from rickgent_policies import REQUIRED_POLICIES, effective_attached_policies",
    "bundles = {'manager': os.environ['RG_MGR'], 'worker': os.environ['RG_WKR']}",
    "counts = {}",
    "missing = {}",
    "for label, d in bundles.items():",
    "    try:",
    "        eff = effective_attached_policies(d)",
    "        counts[label] = len(eff)",
    "    except Exception as e:",
    "        missing[label] = ['<parse-error: %s>' % e] + sorted(REQUIRED_POLICIES)",
    "        counts[label] = 0",
    "        continue",
    "    gap = sorted(REQUIRED_POLICIES - eff)",
    "    if gap:",
    "        missing[label] = gap",
    "print(json.dumps({'missing': missing, 'counts': counts}))",
  ].join("\n");

  try {
    const stdout = execFileSync("python3", ["-c", py], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, RG_MGR: managerDir, RG_WKR: workerDir },
    }).trim();
    const parsed = JSON.parse(stdout) as {
      missing: Record<string, string[]>;
      counts: Record<string, number>;
    };
    const labels = Object.keys(parsed.missing);
    const mgrCount = parsed.counts["manager"] ?? 0;
    const wkrCount = parsed.counts["worker"] ?? 0;
    if (labels.length > 0) {
      const detail = labels
        .map((l) => `${l} missing [${(parsed.missing[l] ?? []).join(", ")}]`)
        .join("; ");
      return { ok: false, detail, managerCount: mgrCount, workerCount: wkrCount };
    }
    return {
      ok: true,
      detail: "manager + worker bundles attach the full required policy set",
      managerCount: mgrCount,
      workerCount: wkrCount,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `policy attachment check failed: ${err instanceof Error ? err.message : String(err)}`,
      managerCount: 0,
      workerCount: 0,
    };
  }
}
