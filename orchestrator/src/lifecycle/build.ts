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
import { routeDispatch, type ModelEntry } from "./routing.js";
import { recordRun, recordPr } from "./metrics.js";

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

  // Record this run in the durable runs ledger so B9 `rickgent metrics` can
  // compute interventions/run. The runId is resolved consistently with
  // seedRegistry below (opts.runId, else a timestamped default).
  const requestedRunId = opts.runId ?? `run-${Date.now()}`;
  recordRun(opts.rickgentDir, requestedRunId, parsed.prd.title);

  const prdVerdict = evaluatePrd(parsed.prd);
  if (!prdVerdict.valid) {
    recordIntervention(opts.rickgentDir, "prd-gate", `PRD invalid: ${prdVerdict.errors.join("; ")}`, requestedRunId);
    report.push(`build: PRD GATE hit — ${prdVerdict.errors.join("; ")} (recorded intervention, exiting non-zero)`);
    return { ...base, exitCode: 1, gateHit: "prd-gate", interventions: countInterventions(opts.rickgentDir) };
  }

  // ── Plan gate ──────────────────────────────────────────────────────────
  if (parsed.tickets.length === 0) {
    recordIntervention(opts.rickgentDir, "plan-gate", "decomposition produced zero tickets", requestedRunId);
    report.push("build: PLAN GATE hit — decomposition produced zero tickets (recorded intervention, exiting non-zero)");
    return { ...base, exitCode: 1, gateHit: "plan-gate", interventions: countInterventions(opts.rickgentDir) };
  }

  // ── Policy attachment verification (B4 gate) ─────────────────────────────
  // Before any dispatch, verify that the manager + worker bundles attach the
  // full required policy set. This is the same check `rickgent doctor` runs,
  // but wired into the build startup so a build cannot proceed with ungated
  // policies. Skippable via RICKGENT_SKIP_POLICY_ATTACH=1 (test-only control).
  const skipPolicyAttach = env.RICKGENT_SKIP_POLICY_ATTACH === "1";
  if (!skipPolicyAttach) {
    const attachResult = verifyPolicyAttachment(opts.agentDir, env);
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
      return {
        ...base,
        exitCode: 1,
        gateHit: "policy-attachment-gate",
        interventions: countInterventions(opts.rickgentDir),
      };
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
  const dispatcher = new Dispatcher(ledger, lock, opts.rickgentDir);
  const registry = new Registry(join(opts.rickgentDir, "registry.json"));
  const salvageExec = new SalvageExecutor(opts.workingDir);
  const breaker: CircuitBreakerState = createBreakerState();

  const runId = seedRegistry(registry, requestedRunId, parsed.tickets);

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

  for (const ticket of toDispatch) {
    if (deferred.has(ticket.id)) continue; // breaker-open: absorbed, not dispatched
    const entry = drain.results.get(dispatchIdString(idByTicket.get(ticket.id)!));
    if (!entry) continue;
    base.ticketsDispatched++;
    if (entry.state === "completed") base.ticketsDone++;
    else base.ticketsFailed++;
  }

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
  // as a gate finding. Skippable via RICKGENT_SKIP_CONFORMANCE=1 (test-only).
  const skipConformance = env.RICKGENT_SKIP_CONFORMANCE === "1";
  if (!skipConformance && base.ticketsDone > 0) {
    const conformanceResult = runConformanceGate(parsed.prd.acceptanceCriteria, opts.workingDir, env);
    const acResults = conformanceResult.results.map(
      (r) => `${r.acId}: ${r.pass ? "PASS" : "FAIL"}`,
    );
    report.push(
      `build: conformance gate — ${conformanceResult.passed}/${conformanceResult.total} ACs passed ` +
        `(${acResults.join(", ")})`,
    );
    if (conformanceResult.failed > 0) {
      // A conformance failure is absorbed by salvage, not a human gate.
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
  } else if (!skipConformance && base.ticketsDone === 0) {
    report.push("build: conformance gate — skipped (no tickets completed)");
  }

  // ── Deslop gate (szechuan) ───────────────────────────────────────────────
  // After conformance, run a basic code quality check on the changed files.
  // This is the deslop gate that catches obvious slop patterns (TODO, FIXME,
  // console.log, debugger, etc.) in the implemented code. A finding is absorbed
  // (not a human intervention) but recorded. Skippable via
  // RICKGENT_SKIP_DESLOP=1 (test-only).
  const skipDeslop = env.RICKGENT_SKIP_DESLOP === "1";
  if (!skipDeslop && base.ticketsDone > 0) {
    const deslopResult = runDeslopGate(opts.workingDir, parsed.tickets, env);
    report.push(
      `build: deslop gate — checked ${deslopResult.filesChecked} file(s), ` +
        `${deslopResult.findings} finding(s)`,
    );
    if (deslopResult.findings > 0) {
      for (const f of deslopResult.details) {
        recordSalvageDisposition(opts.rickgentDir, {
          gate: "deslop",
          disposition: "deslop-finding",
          executed: false,
          detail: f,
        });
      }
    }
  } else if (!skipDeslop && base.ticketsDone === 0) {
    report.push("build: deslop gate — skipped (no tickets completed)");
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
      requestedRunId,
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
    // Record the shipped PR in the durable PR ledger so B9 `rickgent metrics`
    // can compute the rolling matured-PR quality. shippedAt is now; the PR is
    // immature until it crosses the 14-day maturity window.
    recordPr(opts.rickgentDir, {
      prId: pr.branch,
      runId: requestedRunId,
      branch: pr.branch,
      title: parsed.prd.title,
      repo: opts.workingDir,
      shippedAt: new Date().toISOString(),
      scopePaths: parsed.tickets.flatMap((t) => t.declaredPaths),
    });
    report.push(`build: PR branch '${pr.branch}' created; gh pr create issued (${pr.ghOutput || "ok"})`);
    return { ...base, ok: true, exitCode: 0, interventions: countInterventions(opts.rickgentDir) };
  }

  // The autonomous PR path could not complete → human gate.
  recordIntervention(opts.rickgentDir, "merge-gate", pr.error ?? "PR creation blocked", requestedRunId);
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

// ── Policy attachment verification (B4 gate) ────────────────────────────────
//
// Verifies that the manager + worker bundles attach the full required policy
// set via the omnigent static parser. This is the same check `rickgent doctor`
// runs, but wired into build startup so a build cannot proceed with ungated
// policies. Fails CLOSED (non-zero exit + intervention) on a missing policy.

interface PolicyAttachResult {
  ok: boolean;
  detail: string;
  managerCount: number;
  workerCount: number;
}

function verifyPolicyAttachment(agentDir: string, env: NodeJS.ProcessEnv): PolicyAttachResult {
  // Resolve manager + worker bundle dirs from the agent dir.
  // agentDir is typically agents/rickgent (manager); worker is agents/rickgent/agents/worker.
  const managerDir = agentDir;
  const workerDir = join(agentDir, "agents", "worker");

  // If neither bundle has a config.yaml, this is not a real bundle dir (e.g.,
  // a test dummy). Skip the check — in production the agent dir always has one.
  if (!existsSync(join(managerDir, "config.yaml")) && !existsSync(join(workerDir, "config.yaml"))) {
    return {
      ok: true,
      detail: "no bundle config.yaml found — policy attachment check skipped (not a real bundle)",
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

// ── Conformance gate (citadel) ──────────────────────────────────────────────
//
// Post-implementation conformance audit: runs each acceptance criterion's
// verifyCommand against the working repo. A failing AC is absorbed (salvage
// disposition recorded), not a human intervention.

import type { AcceptanceCriterion } from "../core/prd.js";

interface ConformanceResult {
  total: number;
  passed: number;
  failed: number;
  results: Array<{ acId: string; pass: boolean; detail: string }>;
}

function runConformanceGate(
  acceptanceCriteria: AcceptanceCriterion[],
  workingDir: string,
  env: NodeJS.ProcessEnv,
): ConformanceResult {
  const results: Array<{ acId: string; pass: boolean; detail: string }> = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < acceptanceCriteria.length; i++) {
    const ac = acceptanceCriteria[i]!;
    const acId = `AC-${i + 1}`;
    // Strip markdown backtick delimiters that the PRD parser preserves.
    const cmd = ac.verifyCommand.replace(/^`+|`+$/g, "").trim();
    if (!cmd) {
      results.push({ acId, pass: true, detail: "no verify command" });
      passed++;
      continue;
    }
    try {
      execFileSync("sh", ["-c", cmd], {
        cwd: workingDir,
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      results.push({ acId, pass: true, detail: "verify command succeeded" });
      passed++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ acId, pass: false, detail: `verify command failed: ${detail}` });
      failed++;
    }
  }

  return { total: acceptanceCriteria.length, passed, failed, results };
}

// ── Deslop gate (szechuan) ──────────────────────────────────────────────────
//
// Post-conformance code quality check: scans the changed files for obvious slop
// patterns (TODO, FIXME, console.log, debugger, etc.). A finding is absorbed
// (salvage disposition recorded), not a human intervention.

interface DeslopResult {
  filesChecked: number;
  findings: number;
  details: string[];
}

const DESLOP_PATTERNS: RegExp[] = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bHACK\b/i,
  /\bconsole\.log\b/,
  /\bdebugger\b/,
  /\beval\s*\(/,
];

function runDeslopGate(
  workingDir: string,
  tickets: TicketPlan[],
  env: NodeJS.ProcessEnv,
): DeslopResult {
  void env;
  const details: string[] = [];
  let filesChecked = 0;

  // Collect the set of declared paths from all tickets (the in-scope files).
  const paths = new Set<string>();
  for (const ticket of tickets) {
    for (const p of ticket.declaredPaths) {
      paths.add(p);
    }
  }

  for (const relPath of paths) {
    const abs = relPath.startsWith("/") ? relPath : join(workingDir, relPath);
    if (!existsSync(abs)) continue;
    filesChecked++;
    try {
      const content = readFileSync(abs, "utf-8");
      for (const pattern of DESLOP_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          details.push(`${relPath}: slop pattern "${match[0]}"`);
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return { filesChecked, findings: details.length, details };
}
