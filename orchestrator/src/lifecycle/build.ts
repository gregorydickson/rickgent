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
// `runPipeline` remains unavailable until owner-checked reconciliation lands.
// Resume is unavailable and no Git subject or legacy diagnostic ledger can
// skip a fresh ticket allocation or manufacture completion.

import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { join } from "path";
import {
  Dispatcher,
  InMemoryDispatchJournal,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
  type DispatcherDependencies,
} from "../dispatch/dispatch.js";
import { DispatchQueue } from "../dispatch/queue.js";
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
  type TicketContract,
} from "../contracts/ticket-contract.js";
import {
  reapOrphanedWorkerProcs,
  detectBackend,
  type ReapResult,
} from "./orphan-reaper.js";
import { routeDispatch, type ModelEntry } from "./routing.js";
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
import { IdentityContextResolver } from "../context/resolver.js";
import {
  resolveAttemptExecutionContext,
  type ResolveAttemptExecutionContextInput,
} from "../context/attempt-execution-context.js";
import {
  terminalizeAttemptDisposition,
  type AttemptTerminalizationInput,
  type AttemptTerminalizationResult,
} from "./attempt-terminalization.js";
import type { ResolvedPhaseContext } from "../context/resolver.js";
import {
  openStateStore,
  StateStoreError,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../state/store.js";
import { LeaseAuthority } from "../state/leases.js";
import { RICKGENT_ORACLE_VERSION } from "../state/oracle.js";
import { LegacyDiagnosticService } from "../state/legacy-quarantine.js";
import { probeContainmentBackend } from "../process/containment.js";
import {
  AttemptRunner,
  type AttemptRunnerRequest,
  type AttemptRunnerResult,
} from "./attempt-runner.js";
import { AttemptTerminalizationService } from "./attempt-terminalization.js";
import { TargetStartGateAuthority } from "./target-start-gate.js";
import {
  AttemptExecutionContextAuthority,
} from "../context/attempt-execution-context.js";
import { buildAttemptRunnerProviders } from "./attempt-runner-providers.js";

export interface BuildOptions {
  prdPath: string;
  /** Caller repository used only to provision the isolated run worktree. */
  workingDir: string;
  /** Legacy diagnostic/fixture dir. Authoritative lifecycle state never lives here. */
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
  /**
   * Per-attempt t22A authority substrate provider (t22A fix round 2).  When
   * supplied, the build path routes each attempt's execution-context
   * resolution and terminalization through the production authority APIs
   * ({@link resolveAttemptExecutionContext} /
   * {@link terminalizeAttemptDisposition}) so the authority-derived worktree
   * is the execution context and the purpose-specific disposition receipt is
   * minted.  When absent, the legacy run-workspace path remains in effect
   * (the t22C/t22D cutover removes that fallback).  The
   * {@link autonomous_dispatch} capability remains `fixture_only` regardless;
   * this routes the authority APIs on the production path without activating
   * production dispatch.
   */
  attemptAuthoritySubstrateProvider?: (
    attempt: AllocatedAttempt,
    outcome: "failure" | "promotion" | "quarantine" | "nonterminal",
  ) => AttemptAuthoritySubstrate | null;
  /**
   * Scrutiny round 8: per-dispatch output storage limit (bytes).  Flows
   * through the AttemptRunner to the containment backend's streaming
   * BoundedOutputSink.  When the produced bytes exceed the limit, the
   * BoundedOutputReceipt reports originalBytes = total produced,
   * storedBytes = limit, truncated = true, artifactDigest = SHA-256(stored).
   * Defaults to 8 MiB when absent (the historical Docker maxBuffer bound).
   */
  outputLimitBytes?: number | undefined;
  /**
   * Scrutiny round 8: trailing STORED bytes to retain as base64 in the
   * BoundedOutputReceipt.  Defaults to 16 KiB when absent.
   */
  tailLimitBytes?: number | undefined;
}

/**
 * t22D-fix: Build the real `omnigent run <agentDir> -p <prompt>` dispatch
 * argv from the configured agent bundle and ticket prompt.  This is NOT a
 * placeholder command (e.g. `node --version`); it is the real omnigent
 * dispatch path that the AttemptRunner's containment-backed dispatch
 * provider spawns inside the containment boundary.
 *
 * The argv is `["omnigent", "run", <agentDir>, "--no-session", "-p", <prompt>]`.
 * The containment backend's `releaseTarget` spawns this inside the boundary.
 */
function buildOmnigentDispatchArgv(agentDir: string, prompt: string): readonly string[] {
  return Object.freeze(["omnigent", "run", agentDir, "--no-session", "-p", prompt]);
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
  /** Deterministic fixture materialization; production always uses the authenticated bundle. */
  dispatcherDependencies?: DispatcherDependencies;
  /**
   * Production attempt terminalization route (t22A fix round 2).  The build
   * path calls this for each attempt's terminal outcome; it routes through
   * {@link AttemptTerminalizationAuthority} (the purpose-specific route) and
   * mints the branded disposition receipt.  The generic {@link CleanupService}
   * path is NOT the authority route.  Defaults to the production
   * {@link terminalizeAttemptDisposition} entrypoint.  When no substrate is
   * supplied for an attempt (the legacy build path before the t22C/t22D
   * cutover provides the ownership grant + branded receipt), the build path
   * does not invoke this route for that attempt; the physical workspace
   * finalization ({@link finalizeRunWorkspace}) remains as a non-authority
   * physical effect.
   */
  terminalizeAttemptDisposition?: typeof terminalizeAttemptDisposition;
  /**
   * Production attempt execution-context route (t22A fix round 2).  The build
   * path calls this to bind an attempt's execution context to the
   * authority-derived worktree (NOT the caller repository or the legacy run
   * workspace).  Defaults to the production
   * {@link resolveAttemptExecutionContext} entrypoint.  When no ownership
   * grant is supplied for an attempt, the build path uses the legacy
   * {@link ReadyRunWorkspace} worktree for that attempt (the t22D cutover
   * removes that fallback).
   */
  resolveAttemptExecutionContext?: typeof resolveAttemptExecutionContext;
  /** Explicit fixture-only omissions; production entrypoints never set these. */
  skipPolicyAttachment?: boolean;
  skipConformance?: boolean;
  skipDeslop?: boolean;
  /**
   * t22D-fix: Override the containment backend probe for the production
   * AttemptRunner path.  When supplied, `executeBuildViaRunner` uses this
   * backend instead of probing for Docker/cgroup.  Production never sets
   * this (the probe determines the backend); the integration test injects
   * a `FixtureContainmentBackend` to exercise the full runner critical
   * section deterministically.
   */
  containmentBackendOverride?: import("../process/containment.js").ContainmentBackend;
  /**
   * t22D-fix: Phase-result providers for the AttemptRunner.  When supplied,
   * `executeBuildViaRunner` constructs the AttemptRunner with these
   * providers.  Production omits this (the runner's default dispatch
   * provider uses the containment backend's `releaseTarget` and the real
   * `omnigent run` argv); the integration test injects fixture providers
   * that seed durable receipt rows deterministically.
   */
  attemptRunnerProviders?: import("./attempt-runner.js").AttemptRunnerPhaseProviders;
  /**
   * t22D-fix-round-3: Override the supervised dispatch argv.  When supplied,
   * `executeBuildViaRunner` uses this argv instead of the real `omnigent run`
   * argv.  Production never sets this (the real omnigent dispatch is the
   * production path); the real production-path integration test injects a
   * simple command that produces real git changes inside the containment
   * boundary without requiring real LLM tokens.
   */
  dispatchArgvOverride?: readonly string[];
}

/**
 * A per-attempt substrate that routes the build path's terminalization and
 * execution-context resolution through the t22A authority APIs.  When supplied
 * (by the future AttemptRunner (t22C) or a production-path test), the build
 * path calls {@link terminalizeAttemptDisposition} and
 * {@link resolveAttemptExecutionContext} for that attempt; the
 * authority-derived worktree is the execution context and the purpose-specific
 * disposition receipt is minted.  When absent, the legacy run-workspace path
 * remains in effect for that attempt (the t22D cutover removes it).
 */
export interface AttemptAuthoritySubstrate {
  /** The authority-derived execution-context input (ownership grant + policy bundle). */
  readonly executionContext: ResolveAttemptExecutionContextInput;
  /** The terminalization input for the attempt's outcome, or null if non-terminal. */
  readonly terminalization: AttemptTerminalizationInput | null;
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
  /** Process-local fixture transport observations; never persisted or replayed as authority. */
  dispatchObservations: readonly DispatchEntry[];
  captureReceipts: ImplementationCapturedReceipt[];
  workspaceCleanup: RunWorkspaceCleanupEvidence | null;
  /**
   * Purpose-specific disposition receipts minted by the production
   * terminalization authority route ({@link terminalizeAttemptDisposition})
   * for attempts whose t22A substrate was supplied.  Empty when no substrate
   * is supplied (the legacy build path before the t22C/t22D cutover).  The
   * generic {@link CleanupService} path is NOT the authority route; only
   * branded Store-minted receipts appear here.
   */
  terminalizationReceipts: readonly AttemptTerminalizationResult[];
  /**
   * Authority-derived execution contexts resolved by the production
   * execution-context route ({@link resolveAttemptExecutionContext}) for
   * attempts whose t22A substrate was supplied.  Empty when no substrate is
   * supplied.  Each entry's worktree is the authority-derived worktree, NOT
   * the caller repository or the legacy run workspace.
   */
  authorityExecutionContexts: ReadonlyArray<Readonly<{ readonly attemptId: string; readonly worktreeRealpath: string }>>;
  /**
   * Production bounded-output receipts from the AttemptRunner's dispatch
   * result (scrutiny round 7).  Each entry carries the attempt id and the
   * production BoundedOutputReceipt for stdout/stderr — independently
   * derived source/stored byte counts, byte-content artifact digest
   * (SHA-256 of the actual byte content, NOT the file path), and truncation
   * flag.  Sourced from the real containment backend's capture path, NOT a
   * test-local reconstruction.  Empty for gate-hit builds that never
   * dispatched.
   */
  boundedOutputReceipts: ReadonlyArray<Readonly<{
    readonly attemptId: string;
    readonly stdout: import("../process/containment.js").BoundedOutputReceipt | null;
    readonly stderr: import("../process/containment.js").BoundedOutputReceipt | null;
  }>>;
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

// ---------------------------------------------------------------------------
// t22D production cutover — the production `runBuild`/`runPipeline` path.
//
// The legacy run-worktree / direct-Dispatcher spawn / caller-checkout gates /
// TicketLock finally-release / generic cleanup finalization are REMOVED from
// production.  The production path routes through the single AttemptRunner
// (t22C), which is the sole owner of execution and terminalization.  The
// AttemptRunner requires a validated authority-owned containment backend
// (t22B); when containment is unavailable the production path fails closed
// with an infrastructure error (target-never-released) BEFORE any spawn or
// legacy workspace provisioning.  The DispatchQueue remains only as
// sequential scheduling/diagnostic plumbing feeding tickets to the runner;
// it cannot convert an unknown runner failure into released ownership.
//
// The legacy `executeBuild` (below) is retained ONLY as the package-private
// fixture-bridge body (`runBuildWithDependenciesForTesting`); it is not a
// production caller.
// ---------------------------------------------------------------------------

interface PreparedBuildPlan {
  readonly env: NodeJS.ProcessEnv;
  readonly tickets: readonly TicketContract[];
  readonly allocatedRun: AllocatedRun;
  readonly stateStore: StateStore;
  readonly roster: readonly ModelEntry[];
  readonly costBudgetUsd: number | undefined;
  readonly softThresholdUsd: number | undefined;
  readonly implementerVendorByTicket: Map<string, string>;
  readonly report: string[];
  readonly base: BuildObservation;
  readonly issues: RunIssue[];
}

type PrepareBuildPhaseResult =
  | { readonly ok: true; readonly plan: PreparedBuildPlan }
  | { readonly ok: false; readonly result: BuildResult };

/**
 * Shared pre-dispatch phase for both the production AttemptRunner path and the
 * fixture bridge: env/capability gates, PRD + strict contract gate, plan gate,
 * policy-attachment gate, model roster, and canonical StateStore run
 * allocation.  No workspace provisioning or dispatch happens here.  Returns
 * either a gate-hit {@link BuildResult} or the prepared plan.
 */
async function prepareBuildPhase(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<PrepareBuildPhaseResult> {
  const env = opts.env ?? process.env;
  (dependencies.assertEnvironment ?? assertNoProductionBypasses)(env);
  const cap = opts.maxConcurrent ?? 1;
  if (cap !== 1) {
    throw new InputContractError("maxConcurrent must be exactly 1 for the sequential fixture profile");
  }
  if (opts.runId !== undefined) {
    throw new InputContractError("runId is allocated by the canonical StateStore and cannot be supplied by a caller");
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
    dispatchObservations: [],
    captureReceipts: [],
    workspaceCleanup: null,
    terminalizationReceipts: [],
    authorityExecutionContexts: [],
    boundedOutputReceipts: [],
  };
  const issues: RunIssue[] = [];

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
    return { ok: false, result: finishBuild({ ...base, gateHit: "ticket-contract-gate" }, issues) };
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
    return { ok: false, result: finishBuild({ ...base, gateHit: "prd-gate" }, issues) };
  }

  if (tickets.length === 0) {
    report.push("build: PLAN GATE hit — decomposition produced zero tickets (before run allocation)");
    issues.push(runIssue({
      reason: "zero_ticket",
      class: "execution",
      detail: "decomposition produced zero tickets",
      gate: "plan-gate",
    }));
    return { ok: false, result: finishBuild({ ...base, gateHit: "plan-gate" }, issues) };
  }

  if (dependencies.skipPolicyAttachment) {
    report.push("build: policy attachment — skipped by explicit fixture dependency (blocking)");
    issues.push(runIssue({
      reason: "required_gate_failed",
      class: "verification",
      detail: "required policy attachment gate was skipped",
      gate: "policy-attachment",
    }));
    return { ok: false, result: finishBuild({ ...base, gateHit: "policy-attachment-gate" }, issues) };
  } else {
    const attachResult = (dependencies.verifyPolicyAttachment ?? verifyPolicyAttachment)(opts.agentDir, env);
    if (attachResult.ok) {
      report.push(
        `build: policy attachment templates — manager: PASS (structural only), ` +
          `worker: PASS (${attachResult.managerCount}/${attachResult.workerCount} policies); ` +
          "configured worker startup is verified per attempt",
      );
    } else {
      report.push(
        `build: POLICY ATTACHMENT GATE hit — ${attachResult.detail} ` +
          "(exiting non-zero before lifecycle allocation)",
      );
      issues.push(runIssue({
        reason: "required_gate_failed",
        class: "verification",
        detail: attachResult.detail,
        gate: "policy-attachment",
      }));
      return { ok: false, result: finishBuild({ ...base, gateHit: "policy-attachment-gate" }, issues) };
    }
  }

  const roster = opts.roster ?? parseRosterEnv(env);
  const costBudgetUsd = opts.costBudgetUsd ?? parseNumberEnv(env.RICKGENT_COST_BUDGET_USD);
  const softThresholdUsd = opts.softThresholdUsd ?? parseNumberEnv(env.RICKGENT_SOFT_THRESHOLD_USD);
  if (roster.length > 0) {
    report.push(`build: model roster loaded — ${roster.length} model(s), cost budget=$${costBudgetUsd ?? "unbounded"}`);
  } else {
    report.push("build: no model roster — router will DENY all dispatches (fail-closed)");
  }
  const implementerVendorByTicket = new Map<string, string>();

  let stateStore: StateStore | null = null;
  let allocatedRun: AllocatedRun;
  try {
    stateStore = openStateStore({ repoPath: opts.workingDir });
    new LegacyDiagnosticService(stateStore).requireMutationClear();
    const observedTargetHead = execFileSync(
      "git",
      ["-C", opts.workingDir, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env },
    ).trim();
    const resolver = new IdentityContextResolver(stateStore);
    allocatedRun = resolver.allocateFreshRun({
      contracts: tickets,
      initialDeliveryOid: observedTargetHead,
      oracleVersion: RICKGENT_ORACLE_VERSION,
    });
    report.push(`build: allocated canonical planned run ${allocatedRun.runId}`);
  } catch (error) {
    try {
      stateStore?.close();
    } catch (closeError) {
      report.push(`build: StateStore close failed — ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
    const errorCode = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
      ? `${(error as { code: string }).code}: `
      : "";
    const detail = `canonical run allocation failed: ${errorCode}${error instanceof Error ? error.message : String(error)}`;
    report.push(`build: STATE AUTHORITY GATE hit — ${detail}`);
    const failureClass = error instanceof StateStoreError ? error.failureClass : "infrastructure";
    issues.push(runIssue({
      reason: failureClass === "input_contract" ? "input_contract_error" : "infrastructure_error",
      class: failureClass,
      detail,
      gate: "state-authority",
    }));
    return { ok: false, result: finishBuild({ ...base, gateHit: "state-authority-gate" }, issues) };
  }

  return {
    ok: true,
    plan: {
      env, tickets, allocatedRun, stateStore, roster, costBudgetUsd, softThresholdUsd,
      implementerVendorByTicket, report, base, issues,
    },
  };
}

/**
 * t22D production build path.  Routes through the single AttemptRunner; the
 * legacy run-worktree/direct-dispatcher/caller-checkout/TicketLock/finally-
 * release/generic-cleanup path is NOT used.  Probes the authority-owned
 * containment backend and fails closed with a target-never-released
 * infrastructure error when containment is unavailable — no legacy fallback.
 */
async function executeBuildViaRunner(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<BuildResult> {
  const prepared = await prepareBuildPhase(opts, dependencies);
  if (!prepared.ok) return prepared.result;
  const { env, tickets, allocatedRun, stateStore, roster, report, base, issues } = prepared.plan;

  // ── Containment probe (t22B/t22D) ──────────────────────────────────────
  // The AttemptRunner requires a validated authority-owned containment
  // backend before any target release.  When containment is unavailable the
  // production path fails closed with an infrastructure error; NO legacy
  // run-workspace/direct-dispatcher fallback is provisioned.  This is the
  // cutover: the legacy run-worktree is removed from production execution.
  let containmentBackend;
  if (dependencies.containmentBackendOverride !== undefined) {
    containmentBackend = dependencies.containmentBackendOverride;
    const probe = containmentBackend.probe();
    if (probe.status !== "available") {
      const detail = `containment backend ${probe.backendId} unavailable: ${probe.reason ?? "no reason"}`;
      report.push(`build: CONTAINMENT GATE hit — ${detail} (fail-closed; no legacy fallback)`);
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail,
        gate: "containment",
      }));
      try { stateStore.close(); } catch { /* fail-closed close */ }
      return finishBuild({ ...base, gateHit: "containment-gate" }, issues);
    }
    report.push(`build: containment backend available (${probe.backendId})`);
  } else {
    try {
      // t22D-fix-round-5 (defect #2): Pass opts.agentDir explicitly to
      // probeContainmentBackend as a per-request parameter.  Do NOT mutate
      // the sticky process-global process.env.RICKGENT_AGENT_DIR — a second
      // build in the same process with a different agentDir must not inherit
      // the first build's agent directory.
      const probeOpts: { dockerImage?: string; probeTimeoutMs?: number; cgroupRoot?: string; agentDir?: string } = {};
      if (env.RICKGENT_CONTAINMENT_DOCKER_IMAGE) probeOpts.dockerImage = env.RICKGENT_CONTAINMENT_DOCKER_IMAGE;
      if (env.RICKGENT_CONTAINMENT_PROBE_TIMEOUT_MS) {
        const ms = Number(env.RICKGENT_CONTAINMENT_PROBE_TIMEOUT_MS);
        if (Number.isFinite(ms)) probeOpts.probeTimeoutMs = ms;
      }
      if (opts.agentDir) probeOpts.agentDir = opts.agentDir;
      containmentBackend = probeContainmentBackend(probeOpts);
      const probe = containmentBackend.probe();
      if (probe.status !== "available") {
        throw new Error(`containment backend ${probe.backendId} unavailable: ${probe.reason ?? "no reason"}`);
      }
      report.push(`build: containment backend available (${probe.backendId})`);
    } catch (error) {
      const detail = `containment backend unavailable: ${error instanceof Error ? error.message : String(error)}`;
      report.push(`build: CONTAINMENT GATE hit — ${detail} (fail-closed; no legacy fallback)`);
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail,
        gate: "containment",
      }));
      try { stateStore.close(); } catch { /* fail-closed close */ }
      return finishBuild({ ...base, gateHit: "containment-gate" }, issues);
    }
  }

  // ── AttemptRunner composition ──────────────────────────────────────────
  // The single AttemptRunner owns acquisition, context, containment, dispatch,
  // supervision, attribution, review, verification, oracle evaluation,
  // cleanup, and finalization.
  // The DispatchQueue feeds tickets to the runner sequentially (scheduling/
  // diagnostic plumbing only); it cannot release ownership.
  // t22D-fix-round-2: The runner is constructed with REAL authority-owned
  // providers (buildAttemptRunnerProviders) that seed durable receipt rows
  // through the Store — NOT the default fail-closed stubs.  Without real
  // providers, a normally completed dispatch reaches defaultAttribution and
  // fails RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED after acquisition, leaving
  // the lease unresolved while autonomous_dispatch is enabled.
  // The fixture-bridge may override providers via dependencies.attemptRunnerProviders.
  const leases = new LeaseAuthority(stateStore);
  const targetStartGate = new TargetStartGateAuthority(stateStore, leases, containmentBackend);
  const terminalization = new AttemptTerminalizationService(stateStore, leases);
  const executionContext = new AttemptExecutionContextAuthority(stateStore);
  const realProviders = buildAttemptRunnerProviders(stateStore, leases);
  const runner = new AttemptRunner(
    stateStore,
    leases,
    containmentBackend,
    targetStartGate,
    terminalization,
    executionContext,
    dependencies.attemptRunnerProviders ?? realProviders,
  );
  const resolver = new IdentityContextResolver(stateStore);
  const journal = new InMemoryDispatchJournal();
  const queue = new DispatchQueue(journal, 1);
  const idByTicket = new Map<string, DispatchId>();
  const ticketByDispatchId = new Map<string, TicketContract>();
  const attemptByTicket = new Map<string, AllocatedAttempt>();
  for (const ticket of tickets) {
    const attempt = resolver.allocateInitialAttempt({ runId: allocatedRun.runId, ticketId: ticket.id });
    attemptByTicket.set(ticket.id, attempt);
    const id: DispatchId = {
      runId: attempt.runId, ticketId: attempt.ticketId, phase: "implement",
      attempt: attempt.attemptNumber, role: "worker",
    };
    idByTicket.set(ticket.id, id);
    ticketByDispatchId.set(dispatchIdString(id), ticket);
    queue.enqueue(id);
  }
  report.push(`build: allocated ${attemptByTicket.size} planned initial attempt(s) via AttemptRunner`);

  const runnerResults = new Map<string, AttemptRunnerResult>();
  const dispatchFn = async (id: DispatchId): Promise<DispatchEntry> => {
    const ticket = ticketByDispatchId.get(dispatchIdString(id))!;
    const attempt = attemptByTicket.get(ticket.id)!;
    // t22D-fix: Acquisition is INSIDE AttemptRunner (VAL-T22CD-001).  The
    // build path does NOT acquire ownership before calling the runner — the
    // runner is the single critical-section owner.  No pre-acquired ownership
    // is passed; the runner activates run/ticket rows and acquires internally.
    // The supervised argv is the real `omnigent run <agentDir> -p <prompt>`
    // dispatch path derived from the configured agent bundle and ticket
    // prompt — not a placeholder command.
    const prompt = `Implement ticket ${ticket.id}: ${ticket.title}\n${ticket.description}`;
    const supervisedArgv = dependencies.dispatchArgvOverride ?? buildOmnigentDispatchArgv(opts.agentDir, prompt);
    const request: AttemptRunnerRequest = {
      attempt,
      run: allocatedRun,
      contract: ticket,
      callerRepositoryRealpath: realpathSync(opts.workingDir),
      targetStartGateId: `attempt-target-start-gate:${attempt.attemptId}`,
      acquisitionIdempotencyKey: `attempt-runner-build:${attempt.attemptId}:acquire`,
      ticketInstanceId: attempt.ticketInstanceId,
      supervisedPhase: {
        phaseExecutionId: `phase-exec:${attempt.attemptId}:implement`,
        contextId: `ctx:${attempt.attemptId}`,
        contextDigest: `sha256:${attempt.contractDigest}`,
        phase: "implement",
        phaseOrdinal: 1,
        role: "worker",
      },
      supervisedArgv,
      stdoutPath: join(opts.dataDir, `${attempt.attemptId}.stdout`),
      stderrPath: join(opts.dataDir, `${attempt.attemptId}.stderr`),
      timeoutMs: opts.timeout ?? 60000,
      cancellationRequested: false,
      outputLimitBytes: opts.outputLimitBytes,
      tailLimitBytes: opts.tailLimitBytes,
    };
    let result: AttemptRunnerResult;
    try {
      result = await runner.runAttempt(request);
    } catch (error) {
      const detail = `attempt runner failed: ${error instanceof Error ? error.message : String(error)}`;
      report.push(`  ${ticket.id}: attempt runner threw — fail-closed`);
      // t22D-fix: An unknown runner failure (opaque throw) cannot prove
      // ownership release.  ownershipReleased MUST be false so the
      // DispatchQueue cannot continue with later tickets despite unproven
      // closure (VAL-T22CD-005).
      return {
        dispatchId: dispatchIdString(id), state: "failed", pid: null,
        startedAt: null, completedAt: new Date().toISOString(), exitCode: null,
        stdout: null, stderr: detail, terminalReason: "infrastructure_error",
        ownershipReleased: false,
      };
    }
    runnerResults.set(dispatchIdString(id), result);
    const ok = result.outcome === "succeeded";
    report.push(`  ${ticket.id}: attempt runner outcome=${result.outcome} failureCode=${result.failureCode ?? "n/a"}`);
    return {
      dispatchId: dispatchIdString(id),
      state: ok ? "completed" : "failed",
      pid: null, startedAt: null, completedAt: new Date().toISOString(),
      exitCode: ok ? 0 : null, stdout: null,
      stderr: ok ? null : (result.failureCode ?? result.outcome),
      terminalReason: ok ? "evidence_unverifiable" : "infrastructure_error",
      ownershipReleased: result.outcome === "succeeded" || result.outcome === "failed_clean",
    };
  };

  let drain;
  try {
    drain = await queue.drain(dispatchFn);
  } finally {
    try { stateStore.close(); } catch { /* fail-closed close */ }
  }

  base.dispatchObservations = journal.observations();
  for (const ticket of tickets) {
    const entry = drain.results.get(dispatchIdString(idByTicket.get(ticket.id)!));
    if (!entry) {
      base.ticketsFailed++;
      issues.push(runIssue({
        reason: "infrastructure_error", class: "infrastructure",
        detail: "dispatch queue produced no terminal observation", ticketId: ticket.id,
      }));
      continue;
    }
    base.ticketsDispatched++;
    if (entry.state === "completed") {
      base.ticketsDone++;
    } else {
      base.ticketsFailed++;
      issues.push(runIssue({
        reason: entry.terminalReason === "infrastructure_error" ? "infrastructure_error" : "ticket_failed",
        class: entry.terminalReason === "infrastructure_error" ? "infrastructure" : "execution",
        detail: entry.stderr ?? `dispatch terminal state ${entry.state}`, ticketId: ticket.id,
      }));
    }
  }
  if (base.ticketsDone === 0) {
    issues.push(runIssue({
      reason: "zero_completion", class: "execution",
      detail: "no planned ticket reached verified completion",
    }));
  } else if (base.ticketsFailed > 0) {
    issues.push(runIssue({
      reason: "partial_failure", class: "execution",
      detail: `${base.ticketsFailed} of ${base.ticketsPlanned} planned tickets failed`,
    }));
  }
  report.push("build: production AttemptRunner path complete; automatic delivery remains unavailable");
  // Scrutiny round 7: collect the production BoundedOutputReceipts from the
  // AttemptRunner results so the test can assert the ACTUAL production
  // receipt fields (independently derived source/stored byte counts,
  // byte-content artifact digest, truncation flag) — NOT a test-local
  // reconstruction.
  base.boundedOutputReceipts = Array.from(runnerResults.entries()).map(([dispatchId, result]) => {
    const ticket = ticketByDispatchId.get(dispatchId);
    const attempt = ticket ? attemptByTicket.get(ticket.id) : undefined;
    return Object.freeze({
      attemptId: attempt?.attemptId ?? dispatchId,
      stdout: result.stdoutReceipt,
      stderr: result.stderrReceipt,
    });
  });
  return finishBuild({ ...base }, issues);
}

async function executeBuildLegacy(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<BuildResult> {
  const env = opts.env ?? process.env;
  (dependencies.assertEnvironment ?? assertNoProductionBypasses)(env);
  const cap = opts.maxConcurrent ?? 1;
  if (cap !== 1) {
    throw new InputContractError("maxConcurrent must be exactly 1 for the sequential fixture profile");
  }
  if (opts.runId !== undefined) {
    throw new InputContractError("runId is allocated by the canonical StateStore and cannot be supplied by a caller");
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
    dispatchObservations: [],
    captureReceipts: [],
    workspaceCleanup: null,
    terminalizationReceipts: [],
    authorityExecutionContexts: [],
    boundedOutputReceipts: [],
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
      report.push(
        `build: POLICY ATTACHMENT GATE hit — ${attachResult.detail} ` +
          "(exiting non-zero before lifecycle allocation)",
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

  // ── Canonical run identity ──────────────────────────────────────────────
  // The Store is selected from the explicit repository. It discovers its own
  // private paths and allocates the only run identity before any workspace or
  // worker resource is named. Legacy target-repository artifacts are inventoried
  // first and block mutation without importing any lifecycle value.
  let stateStore: StateStore | null = null;
  let allocatedRun: AllocatedRun;
  try {
    stateStore = openStateStore({ repoPath: opts.workingDir });
    new LegacyDiagnosticService(stateStore).requireMutationClear();
    const observedTargetHead = execFileSync(
      "git",
      ["-C", opts.workingDir, "rev-parse", "--verify", "HEAD^{commit}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      },
    ).trim();
    const resolver = new IdentityContextResolver(stateStore);
    allocatedRun = resolver.allocateFreshRun({
      contracts: tickets,
      initialDeliveryOid: observedTargetHead,
      oracleVersion: RICKGENT_ORACLE_VERSION,
    });
    report.push(`build: allocated canonical planned run ${allocatedRun.runId}`);
  } catch (error) {
    try {
      stateStore?.close();
    } catch (closeError) {
      report.push(`build: StateStore close failed — ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
    const errorCode = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
      ? `${(error as { code: string }).code}: `
      : "";
    const detail = `canonical run allocation failed: ${errorCode}${error instanceof Error ? error.message : String(error)}`;
    report.push(`build: STATE AUTHORITY GATE hit — ${detail}`);
    const failureClass = error instanceof StateStoreError ? error.failureClass : "infrastructure";
    issues.push(runIssue({
      reason: failureClass === "input_contract" ? "input_contract_error" : "infrastructure_error",
      class: failureClass,
      detail,
      gate: "state-authority",
    }));
    return finishBuild({ ...base, gateHit: "state-authority-gate" }, issues);
  }

  // ── Dedicated fixture run workspace ─────────────────────────────────────
  // No mutation-capable child can exist before this clean ref/worktree is
  // allocated and verified. Public callers never reach this seam because the
  // production capability gate above remains fixture-only.
  let provisioned: ProvisionRunWorkspaceResult;
  try {
    provisioned = (dependencies.provisionRunWorkspace ?? provisionRunWorkspace)({
      targetRepo: opts.workingDir,
      runId: allocatedRun.runId,
      externalRoots: [opts.rickgentDir, opts.dataDir],
    });
  } catch (error) {
    try {
      stateStore.close();
    } catch (closeError) {
      report.push(`build: StateStore close failed — ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
    const detail = `run workspace provisioner threw: ${error instanceof Error ? error.message : String(error)}`;
    issues.push(runIssue({
      reason: "infrastructure_error",
      class: "infrastructure",
      detail,
      gate: "run-workspace",
    }));
    report.push(`build: RUN WORKSPACE GATE hit — ${detail}`);
    return finishBuild({ ...base, gateHit: "run-workspace-gate" }, issues);
  }
  if (!provisioned.ok) {
    try {
      stateStore.close();
    } catch (error) {
      issues.push(runIssue({
        reason: "infrastructure_error",
        class: "infrastructure",
        detail: `StateStore close failed: ${error instanceof Error ? error.message : String(error)}`,
        gate: "state-store-close",
      }));
    }
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
    if (runWorkspace.baselineSha !== allocatedRun.initialDeliveryOid) {
      throw new Error(
        "target HEAD changed between canonical run allocation and run workspace admission",
      );
    }
    const resolver = new IdentityContextResolver(stateStore);
    const attemptByTicket = new Map<string, AllocatedAttempt>();
    for (const ticket of tickets) {
      attemptByTicket.set(
        ticket.id,
        resolver.allocateInitialAttempt({ runId: allocatedRun.runId, ticketId: ticket.id }),
      );
    }
    report.push(
      `build: allocated ` +
        `${attemptByTicket.size} planned initial attempt(s)`,
    );
    report.push(
      "build: canonical run, tickets, and attempts remain planned until context- and lease-backed activation",
    );

    // ── Dispatch infra ───────────────────────────────────────────────────────
    const journal = new InMemoryDispatchJournal();
    const dispatcher = new Dispatcher(
      journal,
      stateStore.location.resourceDirectory,
      dependencies.dispatcherDependencies,
    );
    const breaker: CircuitBreakerState = createBreakerState();

    // ── Implementation loop — a backpressure queue drains all tickets under the
    // concurrency cap (B3). Every freshly allocated ticket is enqueued and
    // drained FIFO, at most
    // `maxConcurrent` in flight, a slot freeing the instant a dispatch settles.
    // There are NO human prompts after the plan gate: a failure is absorbed by
    // the circuit breaker + salvage and the queue keeps draining.
    const toDispatch: TicketContract[] = [...tickets];

    const queue = new DispatchQueue(journal, cap);
    const idByTicket = new Map<string, DispatchId>();
    const ticketByDispatchId = new Map<string, TicketContract>();
    for (const ticket of toDispatch) {
      const attempt = attemptByTicket.get(ticket.id);
      if (attempt === undefined) throw new Error(`initial attempt allocation missing for ${ticket.id}`);
      const id: DispatchId = {
        runId: attempt.runId,
        ticketId: attempt.ticketId,
        phase: "implement",
        attempt: attempt.attemptNumber,
        role: "worker",
      };
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
        journal.append(failedEntry);

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
        recordIterationResult(breaker, {
          error: reason,
          gitTreeChanged: treeChanged,
          workerClaimedFilesChanged: null,
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
        const attempt = attemptByTicket.get(ticket.id);
        if (attempt === undefined) throw new Error(`canonical attempt missing for ${ticket.id}`);

        // ── Production execution-context route (t22A fix round 2) ──────────
        // When a t22A authority substrate is supplied for this attempt, bind
        // its execution context to the authority-derived worktree via the
        // production resolveAttemptExecutionContext entrypoint (which routes
        // through AttemptExecutionContextAuthority).  The authority-derived
        // worktree is the production execution context, NOT the caller
        // repository or the legacy run workspace.  When no substrate is
        // supplied (the legacy build path before the t22C/t22D cutover), the
        // legacy run-workspace worktree remains the dispatch cwd for this
        // attempt.  The durable execution context row is persisted by the
        // authority route either way when a substrate is supplied.
        const substrate = opts.attemptAuthoritySubstrateProvider?.(attempt, "nonterminal") ?? null;
        if (substrate !== null) {
          const resolveCtx = dependencies.resolveAttemptExecutionContext ?? resolveAttemptExecutionContext;
          const resolved: ResolvedPhaseContext = resolveCtx(stateStore, substrate.executionContext);
          base.authorityExecutionContexts = Object.freeze([
            ...base.authorityExecutionContexts,
            Object.freeze({
              attemptId: attempt.attemptId,
              worktreeRealpath: resolved.canonical.context.worktree_realpath,
            }),
          ]);
          report.push(
            `  ${ticket.id}: execution context bound to authority-derived worktree ` +
              `(${resolved.canonical.context.worktree_realpath}) via AttemptExecutionContextAuthority`,
          );
        }

        entry = await dispatcher.dispatch(id, {
          agentDir: opts.agentDir,
          prompt: ticketPrompt(ticket),
          timeout: opts.timeout ?? 60000,
          maxConcurrent: cap,
          workspace: runWorkspace,
          dataDir: opts.dataDir,
          ticket,
          attempt,
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
          `  ${ticket.id}: worker ownership remains unproven — retaining ` +
            "canonical attempt resources and run workspace for later recovery",
        );
      }

      if (entry.state === "implementation_captured" && entry.captureReceipt) {
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
      report.push(
        `  ${ticket.id}: FAILED (${entry.state}) → workspace=${treeObservation.status === "unchanged" ? "clean" : "retained"} ` +
          `breaker=${transition.transition} — absorbed, continuing non-interactively`,
      );
      return entry;
    };

    const drain = await queue.drain(dispatchFn);
    base.dispatchObservations = journal.observations();

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

      // ── Production terminalization route (t22A fix round 2) ────────────
      // When a t22A authority substrate is supplied for this attempt's
      // terminal outcome, route the disposition terminalization through the
      // production terminalizeAttemptDisposition entrypoint (which routes
      // through AttemptTerminalizationAuthority).  The purpose-specific
      // branded disposition receipt is minted on the production path; the
      // generic CleanupService path is NOT the authority route.  When no
      // substrate is supplied (the legacy build path before the t22C/t22D
      // cutover), no authority terminalization is performed for this attempt
      // and the physical workspace finalization remains a non-authority
      // physical effect.
      const terminalAttempt = attemptByTicket.get(ticket.id);
      if (terminalAttempt !== undefined && opts.attemptAuthoritySubstrateProvider !== undefined) {
        const outcome: "failure" | "promotion" | "quarantine" | "nonterminal" =
          entry.terminalReason === "infrastructure_error" ? "quarantine"
          : entry.state === "completed" || entry.exitCode === 0 ? "promotion"
          : "failure";
        const terminalSubstrate = opts.attemptAuthoritySubstrateProvider(terminalAttempt, outcome) ?? null;
        if (terminalSubstrate !== null && terminalSubstrate.terminalization !== null) {
          const terminalize = dependencies.terminalizeAttemptDisposition ?? terminalizeAttemptDisposition;
          const receipt = terminalize(stateStore, new LeaseAuthority(stateStore), terminalSubstrate.terminalization);
          base.terminalizationReceipts = Object.freeze([...base.terminalizationReceipts, receipt]);
          report.push(
            `  ${ticket.id}: disposition terminalized via AttemptTerminalizationAuthority ` +
              `(kind=${terminalSubstrate.terminalization.kind}, replayed=${"replayed" in receipt && receipt.replayed})`,
          );
        }
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

    // Process-local diagnostics are observable for this result only. They are
    // never replayed and cannot authorize a lifecycle edge.
    report.push(
      `build: dispatch diagnostics — ${journal.observations().length} observation(s), ` +
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
    try {
      stateStore?.close();
    } catch (error) {
      const detail = `StateStore close failed: ${error instanceof Error ? error.message : String(error)}`;
      report.push(`build: ${detail}`);
      issues.push(runIssue({
        reason: "cleanup_failed",
        class: "cleanup",
        detail,
        gate: "state-store-close",
      }));
    }
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

async function executePipelineLegacy(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<PipelineResult> {
  // Preflight cleanup before build mutation; unavailable required cleanup can
  // never be discovered only after work has started.
  RUNTIME_CAPABILITY_GATE.require("reconciliation");
  const build = await executeBuildLegacy(opts, dependencies);
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

async function executePipelineViaRunner(
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<PipelineResult> {
  // The production pipeline runs the AttemptRunner build path followed by the
  // cleanup chain. Reconciliation remains unavailable; the cleanup chain is
  // the orphan-reaper sweep only on the production path.
  RUNTIME_CAPABILITY_GATE.require("reconciliation");
  const build = await executeBuildViaRunner(opts, dependencies);
  const cleanup = runCleanup(opts.workingDir, opts.rickgentDir, opts.env);
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
  return executeBuildViaRunner(opts, {});
}

/** `rickgent pipeline` — the production build followed by the cleanup chain. */
export async function runPipeline(opts: BuildOptions): Promise<PipelineResult> {
  return executePipelineViaRunner(opts, {});
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
 * The fixture bridge routes through the legacy `executeBuildLegacy` path
 * (deterministic fixture mutation capture); the production `runBuild` path
 * routes through the AttemptRunner (t22D cutover).
 *
 * @internal
 */
export async function runBuildWithDependenciesForTesting(
  authority: object,
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<BuildResult> {
  await requireFixtureRuntimeAuthority(authority);
  return executeBuildLegacy(opts, dependencies);
}

/** @internal — see `runBuildWithDependenciesForTesting`. */
export async function runPipelineWithDependenciesForTesting(
  authority: object,
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<PipelineResult> {
  await requireFixtureRuntimeAuthority(authority);
  return executePipelineLegacy(opts, dependencies);
}

/**
 * Package-private fixture bridge for the AttemptRunner production path.
 * Routes through `executeBuildViaRunner` (the single AttemptRunner) with
 * injectable dependencies (containment backend override, phase providers).
 * This is the integration-test entrypoint for verifying the production wiring
 * (t22D-fix) with a FixtureContainmentBackend and fixture providers.
 *
 * @internal
 */
export async function runBuildViaRunnerForTesting(
  authority: object,
  opts: BuildOptions,
  dependencies: InternalBuildDependencies,
): Promise<BuildResult> {
  await requireFixtureRuntimeAuthority(authority);
  return executeBuildViaRunner(opts, dependencies);
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
