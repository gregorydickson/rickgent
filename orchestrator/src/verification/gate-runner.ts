/**
 * t26 — Sandboxed structured gate runner.
 *
 * Replaces acceptance shell execution with structured `TicketVerification`
 * argv executed through the sandbox, producing typed, authority-owned gate
 * results for every outcome.  The gate runner is the single authority for
 * classifying verification outcomes into the sealed `GATE_STATUSES` enum.
 *
 * VAL-LIFE-003: argv-only verification; shell command interpolation removed.
 * Typed, authority-owned gate results for every outcome.
 *
 * VAL-LIFE-004: Required gate values `missing`, `null`, `skipped`,
 * `unavailable`, `infrastructure_error`, `stale`, and `conflicting` each
 * block advancement (fail closed).  Only `passed` is green.
 *
 * Classification:
 *   - `passed`: exit code is in the sealed `expected_exit_codes`.
 *   - `failed`: exit code is NOT in the sealed `expected_exit_codes`.
 *   - `missing`: executable not found (ENOENT).
 *   - `null`: verification spec is null/undefined.
 *   - `skipped`: verification was skipped (not allowed for required gates).
 *   - `unavailable`: sandbox backend unavailable.
 *   - `infrastructure_error`: timeout, spawn error (non-ENOENT), or other
 *     infrastructure failure.
 *   - `stale`: observed candidate tree does not match the expected tree.
 *   - `conflicting`: prior result digest diverges from the current observation.
 *
 * @invariant Fail closed, everywhere.  Only `passed` does not block.
 * @invariant No shell interpolation — uses spawnSync with array argv only.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { GATE_STATUSES } from "../state/schema.js";
import type { TicketVerification } from "../contracts/ticket-contract.js";
import { canonicalJson } from "../contracts/ticket-contract.js";
import { buildSandboxSpec, type SandboxExecutionSpec } from "./sandbox.js";

/**
 * The schema version for gate-runner results.
 */
export const GATE_RUNNER_SCHEMA_VERSION = "rickgent.gate-runner.v1" as const;

/**
 * The typed gate status, sourced from the sealed `GATE_STATUSES` enum.
 * Only `passed` is green; every other status blocks advancement.
 */
export type GateRunnerStatus = (typeof GATE_STATUSES)[number];

/**
 * A typed, authority-owned gate result.  Every field is derived from the
 * sealed verification contract or the real execution observation — no
 * caller-asserted values.
 */
export interface GateRunnerResult {
  /** The gate ID from the sealed verification contract. */
  readonly gateId: string;
  /** The typed status from `GATE_STATUSES`. */
  readonly status: GateRunnerStatus;
  /** The observed exit code, or `null` if the process did not exit normally. */
  readonly exitCode: number | null;
  /** SHA-256 hash of stdout, or `null` if no stdout was captured. */
  readonly stdoutHash: string | null;
  /** SHA-256 hash of stderr, or `null` if no stderr was captured. */
  readonly stderrHash: string | null;
  /** The last N bytes of stdout (for human-readable diagnostics). */
  readonly stdoutTail: string | null;
  /** The last N bytes of stderr (for human-readable diagnostics). */
  readonly stderrTail: string | null;
  /** Whether the verification timed out. */
  readonly timedOut: boolean;
  /** ISO-8601 timestamp when the verification started. */
  readonly startedAt: string;
  /** ISO-8601 timestamp when the verification completed. */
  readonly completedAt: string;
  /** Human-readable detail string. */
  readonly detail: string;
  /** The contract digest binding this gate to its sealed contract. */
  readonly contractDigest: string;
  /** The context digest binding this gate to its execution context. */
  readonly contextDigest: string;
  /** The phase digest binding this gate to its phase execution. */
  readonly phaseDigest: string;
  /** SHA-256 digest of the executable + args (replay integrity). */
  readonly argvDigest: string;
  /** The schema version. */
  readonly schemaVersion: string;
}

/**
 * A request to run a single verification gate.  The verification spec, the
 * sandbox parameters, and the binding digests come from the sealed contract
 * and the persisted execution context.
 */
export interface GateRunnerRequest {
  /** The sealed verification contract (argv-only). */
  readonly verification: TicketVerification;
  /** The cwd to execute in. */
  readonly cwd: string;
  /** The filtered env (from `buildSandboxEnv`). */
  readonly env: Readonly<Record<string, string>>;
  /** The contract digest binding. */
  readonly contractDigest: string;
  /** The context digest binding. */
  readonly contextDigest: string;
  /** The phase digest binding. */
  readonly phaseDigest: string;
  /**
   * The expected candidate tree OID (for stale detection).  If supplied and
   * the observed tree differs, the gate is `stale`.
   */
  readonly expectedCandidateTreeOid?: string;
  /**
   * The observed candidate tree OID (for stale detection).  If supplied and
   * differs from `expectedCandidateTreeOid`, the gate is `stale`.
   */
  readonly observedCandidateTreeOid?: string;
  /**
   * The prior result digest (for conflicting-replay detection).  If supplied
   * and differs from `currentResultDigest`, the gate is `conflicting`.
   */
  readonly priorResultDigest?: string;
  /**
   * The current result digest (for conflicting-replay detection).  If
   * supplied and differs from `priorResultDigest`, the gate is `conflicting`.
   */
  readonly currentResultDigest?: string;
  /**
   * If true, the sandbox backend is unavailable.  The gate is `unavailable`.
   */
  readonly sandboxUnavailable?: boolean;
  /**
   * If true, the verification was skipped (not allowed for required gates).
   * The gate is `skipped`.
   */
  readonly skipped?: boolean;
}

const TAIL_LIMIT = 4096;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function argvDigest(verification: TicketVerification): string {
  return sha256(canonicalJson({
    executable: verification.executable,
    args: verification.args,
  }));
}

function tail(text: string): string {
  if (text.length <= TAIL_LIMIT) return text;
  return text.slice(text.length - TAIL_LIMIT);
}

function hashOrNull(text: string | undefined | null): string | null {
  if (text === undefined || text === null || text.length === 0) return null;
  return sha256(text);
}

function nowIso(): string {
  return new Date().toISOString();
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  return obj;
}

/**
 * Run a single verification gate and produce a typed, authority-owned
 * `GateRunnerResult`.  The gate runner is the single authority for
 * classifying verification outcomes.
 *
 * @returns A frozen `GateRunnerResult` (authority-owned, not caller-mutable).
 */
export function runGateVerification(request: GateRunnerRequest): GateRunnerResult {
  const startedAt = nowIso();

  // --- Pre-execution fail-closed checks (before any process spawn) ---

  // null: verification spec is null/undefined.
  if (request.verification === null || request.verification === undefined) {
    return deepFreeze({
      gateId: "<null>",
      status: "null" as GateRunnerStatus,
      exitCode: null,
      stdoutHash: null,
      stderrHash: null,
      stdoutTail: null,
      stderrTail: null,
      timedOut: false,
      startedAt,
      completedAt: nowIso(),
      detail: "verification spec is null",
      contractDigest: request.contractDigest,
      contextDigest: request.contextDigest,
      phaseDigest: request.phaseDigest,
      argvDigest: sha256("null"),
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    });
  }

  const verification = request.verification;
  const gateId = verification.id;
  const digest = argvDigest(verification);

  // skipped: verification was explicitly skipped (not allowed for required gates).
  if (request.skipped === true) {
    return deepFreeze({
      gateId,
      status: "skipped" as GateRunnerStatus,
      exitCode: null,
      stdoutHash: null,
      stderrHash: null,
      stdoutTail: null,
      stderrTail: null,
      timedOut: false,
      startedAt,
      completedAt: nowIso(),
      detail: "verification was skipped",
      contractDigest: request.contractDigest,
      contextDigest: request.contextDigest,
      phaseDigest: request.phaseDigest,
      argvDigest: digest,
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    });
  }

  // unavailable: sandbox backend is unavailable.
  if (request.sandboxUnavailable === true) {
    return deepFreeze({
      gateId,
      status: "unavailable" as GateRunnerStatus,
      exitCode: null,
      stdoutHash: null,
      stderrHash: null,
      stdoutTail: null,
      stderrTail: null,
      timedOut: false,
      startedAt,
      completedAt: nowIso(),
      detail: "sandbox backend unavailable",
      contractDigest: request.contractDigest,
      contextDigest: request.contextDigest,
      phaseDigest: request.phaseDigest,
      argvDigest: digest,
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    });
  }

  // stale: observed candidate tree does not match the expected tree.
  if (
    request.expectedCandidateTreeOid !== undefined &&
    request.observedCandidateTreeOid !== undefined &&
    request.expectedCandidateTreeOid !== request.observedCandidateTreeOid
  ) {
    return deepFreeze({
      gateId,
      status: "stale" as GateRunnerStatus,
      exitCode: null,
      stdoutHash: null,
      stderrHash: null,
      stdoutTail: null,
      stderrTail: null,
      timedOut: false,
      startedAt,
      completedAt: nowIso(),
      detail: `candidate tree stale: expected ${request.expectedCandidateTreeOid}, observed ${request.observedCandidateTreeOid}`,
      contractDigest: request.contractDigest,
      contextDigest: request.contextDigest,
      phaseDigest: request.phaseDigest,
      argvDigest: digest,
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    });
  }

  // conflicting: prior result digest diverges from the current observation.
  if (
    request.priorResultDigest !== undefined &&
    request.currentResultDigest !== undefined &&
    request.priorResultDigest !== request.currentResultDigest
  ) {
    return deepFreeze({
      gateId,
      status: "conflicting" as GateRunnerStatus,
      exitCode: null,
      stdoutHash: null,
      stderrHash: null,
      stdoutTail: null,
      stderrTail: null,
      timedOut: false,
      startedAt,
      completedAt: nowIso(),
      detail: `result conflict: prior ${request.priorResultDigest}, current ${request.currentResultDigest}`,
      contractDigest: request.contractDigest,
      contextDigest: request.contextDigest,
      phaseDigest: request.phaseDigest,
      argvDigest: digest,
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    });
  }

  // --- Execute the verification argv (argv-only, no shell interpolation) ---

  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let detail = "";
  let status: GateRunnerStatus;

  // The sandbox env contains only the allowlisted vars.  PATH is always
  // included (if available in the source env) so the executable can be
  // resolved by the system — PATH does not carry secrets and is required
  // for the process to start.  All other env vars are filtered to the
  // allowlist.
  const execEnv: Record<string, string> = { ...request.env };
  if (execEnv.PATH === undefined && process.env.PATH !== undefined) {
    execEnv.PATH = process.env.PATH;
  }

  try {
    const result = spawnSync(verification.executable, [...verification.args], {
      cwd: request.cwd,
      encoding: "utf8",
      timeout: verification.timeout_ms,
      env: execEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = typeof result.stdout === "string" ? result.stdout : "";
    stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (result.error !== undefined) {
      // Spawn error (before the process could start).
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        status = "missing";
        detail = `executable not found: ${verification.executable}`;
      } else if (result.signal === "SIGTERM" || result.error.message?.includes("timed out")) {
        timedOut = true;
        status = "infrastructure_error";
        detail = `verification timed out after ${verification.timeout_ms}ms`;
      } else {
        status = "infrastructure_error";
        detail = `infrastructure error: ${result.error.message}`;
      }
    } else if (result.signal !== null) {
      // Killed by a signal (e.g. timeout SIGTERM).
      timedOut = result.signal === "SIGTERM";
      status = "infrastructure_error";
      detail = `killed by signal ${result.signal}`;
    } else if (typeof result.status === "number") {
      // The process exited with a code.  Classify against the sealed
      // allowlist: a permitted code passes; anything else fails closed.
      exitCode = result.status;
      status = verification.expected_exit_codes.includes(result.status) ? "passed" : "failed";
      detail = status === "passed"
        ? `exit ${result.status} is in expected_exit_codes`
        : `exit ${result.status} not in expected_exit_codes`;
    } else {
      // No status, no signal, no error — unknown infrastructure failure.
      status = "infrastructure_error";
      detail = "verification produced no status, signal, or error";
    }
  } catch (error) {
    // spawnSync is synchronous and does not normally throw, but guard
    // against any unexpected throw (fail-closed to infrastructure_error).
    const e = error as { message?: string };
    status = "infrastructure_error";
    detail = `infrastructure error: ${e.message ?? String(error)}`;
  }

  const completedAt = nowIso();

  return deepFreeze({
    gateId,
    status,
    exitCode,
    stdoutHash: hashOrNull(stdout),
    stderrHash: hashOrNull(stderr),
    stdoutTail: stdout.length > 0 ? tail(stdout) : null,
    stderrTail: stderr.length > 0 ? tail(stderr) : null,
    timedOut,
    startedAt,
    completedAt,
    detail,
    contractDigest: request.contractDigest,
    contextDigest: request.contextDigest,
    phaseDigest: request.phaseDigest,
    argvDigest: digest,
    schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
  });
}

/**
 * Build a `GateRunnerRequest` from a sealed `TicketVerification` and the
 * sandbox spec.  This is the convenience entry point for the production
 * verification provider — it composes the sandbox env, resolves the cwd,
 * and binds the contract/context/phase digests.
 *
 * @throws If the sandbox spec cannot be built (shell executable, unresolvable
 *   cwd, invalid writable outputs).  The caller maps this to
 *   `infrastructure_error`.
 */
export function buildGateRunnerRequest(
  verification: TicketVerification,
  sourceEnv: NodeJS.ProcessEnv,
  repositoryRoot: string,
  digests: {
    contractDigest: string;
    contextDigest: string;
    phaseDigest: string;
  },
  worktreePath?: string,
): GateRunnerRequest {
  const spec: SandboxExecutionSpec = buildSandboxSpec(verification, sourceEnv, repositoryRoot, worktreePath);
  return {
    verification,
    cwd: spec.cwd,
    env: spec.env,
    contractDigest: digests.contractDigest,
    contextDigest: digests.contextDigest,
    phaseDigest: digests.phaseDigest,
  };
}
