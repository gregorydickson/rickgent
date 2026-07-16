// Build loop (B1) — the contained PRD → local-profile lifecycle.
//
// `runBuild` decomposes a PRD into ≥1 ticket and dispatches each through the
// REAL production `Dispatcher` path. The M1 fixture path can only capture a
// nonterminal implementation delta; it cannot create commits or declare Done.
// After the plan gate, the loop is strictly non-interactive: a ticket failure
// is absorbed by the circuit breaker and retained-workspace evidence, and the
// queue continues without prompting a human. Required local gates and every
// planned ticket are aggregated before a typed outcome is returned.
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
  type DispatcherDependencies,
} from "../dispatch/dispatch.js";
import { DispatchQueue } from "../dispatch/queue.js";
import { Registry, type TicketState } from "./registry.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import {
  createBreakerState,
  recordIterationResult,
  canExecute,
  type CircuitBreakerState,
} from "../core/breaker.js";
import { evaluatePrd } from "../core/prd.js";
import { parseExecutablePrdFile } from "./prd-parse.js";
import {
  TicketContractError,
  canonicalJson,
  ticketOwnedPaths,
  type TicketContract,
} from "../contracts/ticket-contract.js";
import {
  reapOrphanedWorkerProcs,
  detectBackend,
  type ReapResult,
} from "./orphan-reaper.js";
import { routeDispatch, type ModelEntry } from "./routing.js";
import { recordRun } from "./metrics.js";
import { runContractConformanceGate } from "./citadel.js";
import { runDeslopGate } from "./szechuan.js";
import {
  CapabilityUnavailableError,
  InputContractError,
  assertNoProductionBypasses,
} from "../capabilities/registry.js";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";
import {
  aggregateRunOutcome,
  runIssue,
  type RunIssue,
  type RunOutcome,
} from "./run-outcome.js";
import {
  callerRepositoryUnchanged,
  finalizeRunWorkspace,
  provisionRunWorkspace,
  type ProvisionRunWorkspaceResult,
  type ReadyRunWorkspace,
  type RunWorkspaceCleanupEvidence,
} from "../git/run-workspace.js";
import type { ImplementationCapturedReceipt } from "../git/mutation-capture.js";

export interface BuildOptions {
  prdPath: string;
  /** Caller repository used only to provision the isolated run worktree. */
  workingDir: string;
  /** `.rickgent` state dir (ledger, registry, interventions, salvage). */
  rickgentDir: string;
  /** Rickgent agent root containing the sole admitted agents/worker template. */
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

/**
 * Test-harness dependencies for the contained lifecycle implementation.
 *
 * This type is intentionally not accepted by the public `runBuild` and
 * `runPipeline` entrypoints.  The only supported consumer is the package-
 * private fixture bridge under `src/testing/`.
 *
 * @internal
 */
export interface InternalBuildDependencies {
  assertEnvironment?: (env: NodeJS.ProcessEnv) => void;
  verifyPolicyAttachment?: typeof verifyPolicyAttachment;
  runConformanceGate?: typeof runContractConformanceGate;
  runDeslopGate?: typeof runDeslopGate;
  provisionRunWorkspace?: typeof provisionRunWorkspace;
  finalizeRunWorkspace?: typeof finalizeRunWorkspace;
  recordRun?: typeof recordRun;
  /** Deterministic fixture materialization; production always uses the authenticated bundle. */
  dispatcherDependencies?: DispatcherDependencies;
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
  ticketsCaptured: number;
  ticketsFailed: number;
  ticketsRecovered: number;
  interventions: number;
  report: string[];
  captureReceipts: ImplementationCapturedReceipt[];
  workspaceCleanup: RunWorkspaceCleanupEvidence | null;
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

type RunWorkspaceChangeObservation =
  | { readonly status: "changed"; readonly detail: string }
  | { readonly status: "unchanged"; readonly detail: string }
  | { readonly status: "unknown"; readonly detail: string };

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

function observeRunWorkspaceChange(
  repo: string,
  baseline: string,
  env: NodeJS.ProcessEnv,
): RunWorkspaceChangeObservation {
  let dirty: string;
  try {
    dirty = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
  } catch (error) {
    return {
      status: "unknown",
      detail: `run workspace status could not be observed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let head: string;
  try {
    head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
  } catch (error) {
    return {
      status: "unknown",
      detail: `run workspace HEAD could not be observed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (dirty.length > 0 || head !== baseline) {
    return { status: "changed", detail: "run workspace differs from its allocation baseline" };
  }
  return { status: "unchanged", detail: "run workspace matches its allocation baseline" };
}

function cleanupFailureDetail(
  cleanup: RunWorkspaceCleanupEvidence,
  retainRequested: boolean,
): string | null {
  const errors = cleanup.errors.length > 0 ? cleanup.errors.join("; ") : null;
  const observedExpectedState = retainRequested
    ? cleanup.disposition === "retained" && !cleanup.worktreeAbsent &&
      !cleanup.worktreeRegistrationAbsent && !cleanup.refAbsent
    : cleanup.disposition === "removed" && cleanup.worktreeAbsent &&
      cleanup.worktreeRegistrationAbsent && cleanup.refAbsent;
  if (errors === null && observedExpectedState) return null;
  const expected = retainRequested
    ? "retained worktree, registration, and ref"
    : "absent worktree, registration, and ref";
  const observed =
    `disposition=${cleanup.disposition} worktreeAbsent=${cleanup.worktreeAbsent} ` +
    `worktreeRegistrationAbsent=${cleanup.worktreeRegistrationAbsent} ` +
    `refAbsent=${cleanup.refAbsent}`;
  return `run workspace cleanup/retention did not prove ${expected}: ${observed}` +
    (errors === null ? "" : ` errors=${errors}`);
}

function provisionFailureIssue(result: Exclude<ProvisionRunWorkspaceResult, { readonly ok: true }>): RunIssue {
  const cleanupProven =
    result.cleanup.errors.length === 0 &&
    result.cleanup.worktreeAbsent &&
    result.cleanup.worktreeRegistrationAbsent &&
    result.cleanup.refAbsent &&
    result.cleanup.disposition !== "retained";
  const cleanupDetail = cleanupProven
    ? null
    : `run workspace allocation cleanup was not proven: disposition=${result.cleanup.disposition} ` +
      `worktreeAbsent=${result.cleanup.worktreeAbsent} ` +
      `worktreeRegistrationAbsent=${result.cleanup.worktreeRegistrationAbsent} ` +
      `refAbsent=${result.cleanup.refAbsent}` +
      (result.cleanup.errors.length === 0 ? "" : ` errors=${result.cleanup.errors.join("; ")}`);
  if (cleanupDetail !== null) {
    return runIssue({
      reason: "cleanup_failed",
      class: "cleanup",
      detail: `${result.code}: ${result.detail}; ${cleanupDetail}`,
      gate: "run-workspace",
    });
  }
  if (result.failureClass === "infrastructure") {
    return runIssue({
      reason: "infrastructure_error",
      class: "infrastructure",
      detail: `${result.code}: ${result.detail}`,
      gate: "run-workspace",
    });
  }
  return runIssue({
    reason: "input_contract_error",
    class: "input_contract",
    detail: `${result.code}: ${result.detail}`,
    gate: "run-workspace",
  });
}

export function ticketPrompt(ticket: TicketContract): string {
  return [
    "Implement the following normalized TicketContract exactly.",
    "The digest and every executable field are authoritative:",
    canonicalJson(ticket),
  ].join("\n");
}

function seedRegistry(registry: Registry, runId: string, tickets: readonly TicketContract[]): string {
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
        declaredPaths: ticketOwnedPaths(t),
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

async function executeBuild(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<BuildResult> {
  const env = opts.env ?? process.env;
  (dependencies.assertEnvironment ?? assertNoProductionBypasses)(env);
  const cap = opts.maxConcurrent ?? 1;
  if (cap !== 1) {
    throw new InputContractError("maxConcurrent must be exactly 1 for the sequential fixture profile");
  }
  if (opts.resume) RUNTIME_CAPABILITY_GATE.require("resume_retry");
  if (opts.deliveryConfigured || opts.featureBranch !== undefined || opts.autonomousPrFlow !== undefined) {
    RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  }
  if (opts.rawShell || env.RICKGENT_RAW_SHELL === "1") RUNTIME_CAPABILITY_GATE.require("raw_shell");
  RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");

  const report: string[] = [];

  const base: BuildObservation = {
    gateHit: null,
    ticketsPlanned: 0,
    ticketsDispatched: 0,
    ticketsDone: 0,
    ticketsCaptured: 0,
    ticketsFailed: 0,
    ticketsRecovered: 0,
    interventions: 0,
    report,
    captureReceipts: [],
    workspaceCleanup: null,
  };
  const issues: RunIssue[] = [];

  // ── Parse + strict contract gate (before any run/state allocation) ─────
  let parsed: ReturnType<typeof parseExecutablePrdFile>;
  try {
    parsed = parseExecutablePrdFile(opts.prdPath, {
      repositoryRoot: opts.workingDir,
      stateRoots: [opts.rickgentDir],
    });
  } catch (error) {
    const contractError = error instanceof TicketContractError ? error : null;
    const detail = contractError?.message ?? `PRD contract could not be read: ${error instanceof Error ? error.message : String(error)}`;
    report.push(`build: TICKET CONTRACT GATE hit — ${detail}`);
    issues.push(runIssue({
      reason: contractError?.kind === "infrastructure" ? "infrastructure_error" : "input_contract_error",
      class: contractError?.kind === "infrastructure" ? "infrastructure" : "input_contract",
      detail,
      gate: "ticket-contract",
    }));
    return finishBuild({ ...base, gateHit: "ticket-contract-gate" }, issues);
  }

  const tickets = parsed.contracts;
  base.ticketsPlanned = tickets.length;
  report.push(
    `build: parsed PRD "${parsed.prd.title}" — ${tickets.length} normalized ticket contract(s), ` +
      `${parsed.prd.acceptanceCriteria.length} acceptance criteria`,
  );

  const prdVerdict = evaluatePrd(parsed.prd);
  if (!prdVerdict.valid) {
    report.push(`build: PRD GATE hit — ${prdVerdict.errors.join("; ")} (before run allocation)`);
    issues.push(runIssue({
      reason: "input_contract_error",
      class: "input_contract",
      detail: `PRD invalid: ${prdVerdict.errors.join("; ")}`,
      gate: "prd-gate",
    }));
    return finishBuild({
      ...base,
      gateHit: "prd-gate",
    }, issues);
  }

  // ── Plan gate ──────────────────────────────────────────────────────────
  if (tickets.length === 0) {
    report.push("build: PLAN GATE hit — decomposition produced zero tickets (before run allocation)");
    issues.push(runIssue({
      reason: "zero_ticket",
      class: "execution",
      detail: "decomposition produced zero tickets",
      gate: "plan-gate",
    }));
    return finishBuild({
      ...base,
      gateHit: "plan-gate",
    }, issues);
  }

  const requestedRunId = opts.runId ?? `run-${Date.now()}`;

  // ── Policy attachment verification (B4 gate) ─────────────────────────────
  // Before any dispatch, verify the manager + worker *templates* attach the
  // full required policy set. This is structural compatibility only: the
  // shipped manager template has no attempt authority and is not runnable as
  // an authenticated policy bundle. Worker materialization performs the real
  // configured startup smoke immediately before spawn.
  if (dependencies.skipPolicyAttachment) {
    report.push("build: policy attachment — skipped by explicit fixture dependency (blocking)");
    issues.push(runIssue({
      reason: "required_gate_failed",
      class: "verification",
      detail: "required policy attachment gate was skipped",
      gate: "policy-attachment",
    }));
    return finishBuild({
      ...base,
      gateHit: "policy-attachment-gate",
      interventions: countInterventions(opts.rickgentDir),
    }, issues);
  } else {
    const attachResult = (dependencies.verifyPolicyAttachment ?? verifyPolicyAttachment)(opts.agentDir, env);
    if (attachResult.ok) {
      report.push(
        `build: policy attachment templates — manager: PASS (structural only), ` +
          `worker: PASS (${attachResult.managerCount}/${attachResult.workerCount} policies); ` +
          "configured worker startup is verified per attempt",
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

  // ── Dedicated fixture run workspace ─────────────────────────────────────
  // No mutation-capable child can exist before this clean ref/worktree is
  // allocated and verified. Public callers never reach this seam because the
  // production capability gate above remains fixture-only.
  const provisioned = (dependencies.provisionRunWorkspace ?? provisionRunWorkspace)({
    targetRepo: opts.workingDir,
    runId: requestedRunId,
    externalRoots: [opts.rickgentDir, opts.dataDir],
  });
  if (!provisioned.ok) {
    report.push(`build: RUN WORKSPACE GATE hit — ${provisioned.code}: ${provisioned.detail}`);
    issues.push(provisionFailureIssue(provisioned));
    return finishBuild({
      ...base,
      gateHit: "run-workspace-gate",
      workspaceCleanup: provisioned.cleanup,
    }, issues);
  }
  const runWorkspace: ReadyRunWorkspace = provisioned.workspace;
  let workerOwnershipUnreleased = false;
  report.push(
    `build: dedicated run workspace ready — ref=${runWorkspace.runRef} ` +
      `baseline=${runWorkspace.baselineSha.slice(0, 12)}`,
  );

  try {
  mkdirSync(opts.rickgentDir, { recursive: true, mode: 0o700 });
  // Durable state allocation begins only after normalized tickets and the
  // clean mutation owner have both been admitted.
  (dependencies.recordRun ?? recordRun)(opts.rickgentDir, requestedRunId, parsed.prd.title);

  // ── Dispatch infra ───────────────────────────────────────────────────────
  const ledger = new DispatchLedger(dispatchLedgerPath(opts.rickgentDir));
  const lock = new TicketLock(join(opts.rickgentDir, "locks"));
  const dispatcher = new Dispatcher(
    ledger,
    lock,
    opts.rickgentDir,
    dependencies.dispatcherDependencies,
  );
  const registry = new Registry(join(opts.rickgentDir, "registry.json"));
  const breaker: CircuitBreakerState = createBreakerState();

  const runId = seedRegistry(registry, requestedRunId, tickets);

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
  // There are NO human prompts after the plan gate: a failure is absorbed by
  // the circuit breaker + salvage and the queue keeps draining.
  const toDispatch: TicketContract[] = [];
  for (const ticket of tickets) {
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
  const ticketByDispatchId = new Map<string, TicketContract>();
  for (const ticket of toDispatch) {
    const id: DispatchId = { runId, ticketId: ticket.id, phase: "implement", attempt: 1, role: "worker" };
    idByTicket.set(ticket.id, id);
    ticketByDispatchId.set(dispatchIdString(id), ticket);
    queue.enqueue(id);
  }

  const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
    const ticket = ticketByDispatchId.get(dispatchIdString(id))!;

    if (workerOwnershipUnreleased) {
      report.push(`  ${ticket.id}: not spawned — prior worker ownership is cleanup-pending`);
      return {
        dispatchId: dispatchIdString(id),
        state: "failed",
        pid: null,
        startedAt: null,
        completedAt: new Date().toISOString(),
        exitCode: null,
        stdout: null,
        stderr: "prior dispatch ownership remains cleanup-pending",
        terminalReason: "infrastructure_error",
      };
    }

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
    });

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
      const treeObservation = observeRunWorkspaceChange(
        runWorkspace.worktreeDir,
        runWorkspace.baselineSha,
        env,
      );
      const treeChanged = treeObservation.status === "changed";
      if (treeObservation.status === "unknown") {
        issues.push(runIssue({
          reason: "infrastructure_error",
          class: "infrastructure",
          detail: treeObservation.detail,
          ticketId: ticket.id,
          gate: "salvage-observation",
        }));
      }
      const transition = recordIterationResult(breaker, {
        error: reason,
        gitTreeChanged: treeChanged,
        workerClaimedFilesChanged: null,
      });
      recordSalvageDisposition(opts.rickgentDir, {
        ticketId: ticket.id,
        dispatchState: "failed",
        disposition: treeObservation.status === "unchanged" ? "no-op" : "retained-run-workspace",
        executed: false,
        archivePath: null,
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

    let entry: DispatchEntry;
    try {
      entry = await dispatcher.dispatch(id, {
        agentDir: opts.agentDir,
        prompt: ticketPrompt(ticket),
        timeout: opts.timeout ?? 60000,
        maxConcurrent: cap,
        workspace: runWorkspace,
        dataDir: opts.dataDir,
        ticket,
        selection: routed.selection,
        env,
      });
    } catch (error) {
      workerOwnershipUnreleased = true;
      throw error;
    }
    if (entry.ownershipReleased === false) {
      workerOwnershipUnreleased = true;
      report.push(
        `  ${ticket.id}: worker ownership remains unproven — retaining ticket lock, ` +
          "policy lease, and run workspace for later recovery",
      );
    }

    if (entry.state === "implementation_captured" && entry.captureReceipt) {
      if (registry.getTicketState(ticket.id)) {
        registry.updateTicketState(ticket.id, {
          status: "In Progress",
          phase: "implementation_captured",
          completionCommitSha: null,
          attempt: id.attempt,
        });
      }
      report.push(
        `  ${ticket.id}: implementation captured (nonterminal) — ` +
          `${entry.captureReceipt.changedPaths.length} observed path(s)`,
      );
      return entry;
    }

    // FAILURE ABSORBED — circuit breaker + salvage, never a prompt.
    const treeObservation = observeRunWorkspaceChange(
      runWorkspace.worktreeDir,
      runWorkspace.baselineSha,
      env,
    );
    const treeChanged = treeObservation.status === "changed";
    if (treeObservation.status === "unknown") {
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail: treeObservation.detail,
        ticketId: ticket.id,
        gate: "salvage-observation",
      }));
    }
    const transition = recordIterationResult(breaker, {
      error: entry.stderr || `dispatch terminal state ${entry.state}`,
      gitTreeChanged: treeChanged,
      workerClaimedFilesChanged: null,
    });
    recordSalvageDisposition(opts.rickgentDir, {
      ticketId: ticket.id,
      dispatchState: entry.state,
      disposition: treeObservation.status === "unchanged" ? "no-op" : "retained-run-workspace",
      executed: false,
      archivePath: null,
      breaker: transition.transition,
    });
    report.push(
      `  ${ticket.id}: FAILED (${entry.state}) → workspace=${treeObservation.status === "unchanged" ? "clean" : "retained"} ` +
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
    if (entry.state === "implementation_captured" && entry.captureReceipt) {
      base.ticketsCaptured++;
      base.captureReceipts.push(entry.captureReceipt);
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

  const accounted = base.ticketsDone + base.ticketsCaptured + base.ticketsFailed + base.ticketsRecovered;
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
  if (workerOwnershipUnreleased) {
    issues.push(runIssue({
      reason: "cleanup_failed",
      class: "cleanup",
      detail: "forced worker termination left descendant ownership cleanup-pending",
      gate: "worker-ownership",
    }));
    throw new Error(
      "worker ownership is cleanup-pending; later mutation-reading gates are suppressed",
    );
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
  // After implementation, run each contract's typed verification argv directly.
  // A failing AC is absorbed (not a human intervention) but recorded as a gate
  // finding. Test fixtures may replace it only by dependency injection.
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
      const conformanceResult = (dependencies.runConformanceGate ?? runContractConformanceGate)(
        tickets,
        opts.workingDir,
        env,
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
      const deslopResult = (dependencies.runDeslopGate ?? runDeslopGate)(opts.workingDir, tickets, env);
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
  base.interventions = countInterventions(opts.rickgentDir);
  } catch (error) {
    const detail = `post-provision build failure: ${error instanceof Error ? error.message : String(error)}`;
    report.push(`build: INFRASTRUCTURE ERROR — ${detail}`);
    issues.push(runIssue({
      reason: "infrastructure_error",
      class: "infrastructure",
      detail,
      gate: "run-workspace-owner",
    }));
  } finally {
  const treeObservation = observeRunWorkspaceChange(
    runWorkspace.worktreeDir,
    runWorkspace.baselineSha,
    env,
  );
  const retainWorkspace = workerOwnershipUnreleased || treeObservation.status !== "unchanged";
  if (workerOwnershipUnreleased) {
    report.push(
      "build: run workspace retained because forced worker termination could not prove descendant ownership release",
    );
  }
  if (treeObservation.status === "unknown") {
    report.push(`build: run workspace observation unavailable — retaining: ${treeObservation.detail}`);
    issues.push(runIssue({
      reason: "infrastructure_error",
      class: "infrastructure",
      detail: treeObservation.detail,
      gate: "run-workspace-finalization",
    }));
  }
  try {
    base.workspaceCleanup = (dependencies.finalizeRunWorkspace ?? finalizeRunWorkspace)(
      runWorkspace,
      retainWorkspace,
    );
  } catch (error) {
    base.workspaceCleanup = Object.freeze({
      disposition: "retained" as const,
      worktreeAbsent: false,
      worktreeRegistrationAbsent: false,
      refAbsent: false,
      errors: Object.freeze([
        `run workspace finalizer threw: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    });
  }
  const cleanupDetail = cleanupFailureDetail(base.workspaceCleanup, retainWorkspace);
  if (cleanupDetail !== null) {
    issues.push(runIssue({
      reason: "cleanup_failed",
      class: "cleanup",
      detail: cleanupDetail,
      gate: "run-workspace-finalization",
    }));
  }
  const callerCheck = callerRepositoryUnchanged(runWorkspace);
  report.push(
    `build: caller checkout — ${callerCheck.unchanged ? "unchanged" : "CHANGED"}; ` +
      `run workspace=${base.workspaceCleanup.disposition}`,
  );
  if (!callerCheck.unchanged) {
    issues.push(runIssue({
      reason: "infrastructure_error",
      class: "infrastructure",
      detail: callerCheck.detail,
      gate: "caller-integrity",
    }));
  }
  }
  return finishBuild({
    ...base,
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
): CleanupResult {
  const issues: RunIssue[] = [];
  const report: string[] = [];
  let reap: ReapResult;
  let rec: ReconcileResult | null = null;

  try {
    RUNTIME_CAPABILITY_GATE.require("reconciliation");
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
    rec = reconcile(workingDir, rickgentDir);
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

async function executePipeline(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<PipelineResult> {
  // Preflight cleanup before build mutation; unavailable required cleanup can
  // never be discovered only after work has started.
  RUNTIME_CAPABILITY_GATE.require("reconciliation");
  const build = await executeBuild(opts, dependencies);
  const cleanup = runCleanup(
    opts.workingDir,
    opts.rickgentDir,
    opts.env,
  );
  const outcome = aggregateRunOutcome([...build.outcome.issues, ...cleanup.issues]);
  const report = [...build.report, ...cleanup.report];
  report.push(
    `pipeline: outcome=${outcome.status} primary=${outcome.primary} ` +
      `code=${outcome.stableCode} issues=${outcome.issues.map((issue) => issue.reason).join(",") || "none"}`,
  );
  return { ...build, outcome, report, cleanup };
}

/** Public production build entrypoint. Capability authority is not injectable. */
export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  return executeBuild(opts, {});
}

/** `rickgent pipeline` — the production build followed by the cleanup chain. */
export async function runPipeline(opts: BuildOptions): Promise<PipelineResult> {
  return executePipeline(opts, {});
}

async function requireFixtureRuntimeAuthority(authority: object): Promise<void> {
  // This module is deliberately excluded from the npm artifact. A caller that
  // reaches this internal export through an absolute path therefore fails at
  // this import before any injected dependency can execute.
  const { assertFixtureRuntimeAuthority } = await import("../testing/fixture-authority.js");
  assertFixtureRuntimeAuthority(authority);
}

/**
 * Package-private fixture bridge. It is deliberately absent from the package
 * export map and should only be re-exported by `src/testing/fixture-runtime`.
 *
 * @internal
 */
export async function runBuildWithDependenciesForTesting(
  authority: object,
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<BuildResult> {
  await requireFixtureRuntimeAuthority(authority);
  return executeBuild(opts, dependencies);
}

/** @internal — see `runBuildWithDependenciesForTesting`. */
export async function runPipelineWithDependenciesForTesting(
  authority: object,
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<PipelineResult> {
  await requireFixtureRuntimeAuthority(authority);
  return executePipeline(opts, dependencies);
}

// ── Policy attachment verification (B4 gate) ────────────────────────────────
//
// Verifies the exact manager + worker template attachment order, paths,
// factory shape, config posture, and FunctionPolicy construction. It does not
// claim either unmaterialized template has authenticated runtime authority.

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
    "from rickgent_policies import validate_attached_policy_bundle",
    "bundles = {'manager': os.environ['RG_MGR'], 'worker': os.environ['RG_WKR']}",
    "counts = {}",
    "errors = {}",
    "for label, d in bundles.items():",
    "    try:",
    "        resolved = validate_attached_policy_bundle(d)",
    "        counts[label] = len(resolved)",
    "    except Exception as e:",
    "        errors[label] = str(e)",
    "        counts[label] = 0",
    "print(json.dumps({'errors': errors, 'counts': counts}))",
  ].join("\n");

  try {
    const stdout = execFileSync("python3", ["-c", py], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, RG_MGR: managerDir, RG_WKR: workerDir },
    }).trim();
    const parsed = JSON.parse(stdout) as {
      errors: Record<string, string>;
      counts: Record<string, number>;
    };
    const labels = Object.keys(parsed.errors);
    const mgrCount = parsed.counts["manager"] ?? 0;
    const wkrCount = parsed.counts["worker"] ?? 0;
    if (labels.length > 0) {
      const detail = labels
        .map((l) => `${l}: ${parsed.errors[l] ?? "attachment validation failed"}`)
        .join("; ");
      return { ok: false, detail, managerCount: mgrCount, workerCount: wkrCount };
    }
    return {
      ok: true,
      detail: "manager + worker templates have exact structural FunctionPolicy compatibility; configured worker startup is verified per attempt",
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
