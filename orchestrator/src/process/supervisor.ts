import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson } from "../contracts/ticket-contract.js";
import {
  consumeAttemptWorkspaceSpawnAuthorization,
  isAuthorizedAttemptWorkspaceSpawnAuthorization,
  type AttemptWorkspaceSpawnAuthorization,
} from "../git/attempt-workspace.js";
import {
  isAuthorizedAttemptOwnershipGrant,
  type AttemptOwnershipGrant,
  type LeaseAuthority,
} from "../state/leases.js";
import type { StateStore } from "../state/store.js";
import {
  PosixProcessController,
  ProcessPlatformError,
  type PosixProcessIdentity,
  type ProcessDeathObservation,
  type ProcessSignalObservation,
  type TrackedSignalResult,
} from "./posix.js";
import {
  BoundedOutputSink,
  ContainmentUnavailableError,
  assertContainmentMembershipForLaunch,
  type ContainmentLineage,
  type ContainmentMembership,
  type BoundedOutputReceipt,
} from "./containment.js";

// Re-export BoundedOutputReceipt so existing consumers that imported it
// from supervisor.ts continue to resolve.  The canonical definition lives
// in containment.ts (the lower-level module) so both the containment and
// supervisor paths produce the same receipt shape (scrutiny round 7).
export type { BoundedOutputReceipt };

const PROCESS_SUPERVISOR_COMMAND_AUTHORITY = Symbol("rickgent.process-supervisor-command");
const AUTHORIZED_PROCESS_SUPERVISOR_COMMANDS = new WeakSet<object>();
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_DEATH_OBSERVATION_MS = 5_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TAIL_LIMIT_BYTES = 16 * 1024;
const MIN_HEARTBEAT_INTERVAL_MS = 100;
const DESCENDANT_CAPTURE_INTERVAL_MS = 20;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_ENVIRONMENT_BYTES = 64 * 1024;
const BOOTSTRAP_SOURCE = String.raw`
const executable = process.argv[1];
const argv = process.argv.slice(1);
const chunks = [];
let bytes = 0;
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > ${MAX_ENVIRONMENT_BYTES}) {
    process.stderr.write("rickgent bootstrap start gate exceeded its bound\n");
    process.exit(125);
  }
  chunks.push(chunk);
});
process.stdin.once("end", () => {
  try {
    const gate = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (gate === null || gate.schema_version !== "rickgent.process-start-gate.v1" ||
        gate.environment === null || typeof gate.environment !== "object" || Array.isArray(gate.environment)) {
      throw new Error("invalid start-gate envelope");
    }
    process.execve(executable, argv, gate.environment);
  } catch (error) {
    process.stderr.write("rickgent bootstrap execve failed: " + (error && error.message ? error.message : String(error)) + "\n");
    process.exit(126);
  }
});
process.stdin.resume();
`;

export const PROCESS_SUPERVISOR_SCHEMA_VERSION = "rickgent.process-supervisor/v1" as const;

export type ProcessObservationKind =
  | "stdout"
  | "stderr"
  | "exit"
  | "termination"
  | "group_death"
  | "infrastructure_error";

export interface ProcessResourceVersions {
  readonly process_group: number;
  readonly stdout: number;
  readonly stderr: number;
}

export interface ProcessLaunchCommitRequest {
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly repositoryId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipContextDigest: string;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly executionContextDigest: string;
  readonly spawnAuthorizationDigest: string;
  readonly pid: number;
  readonly pgid: number;
  readonly platform: "darwin" | "linux";
  readonly bootIdentity: string;
  readonly processStartIdentity: string;
  readonly argvDigest: string;
  readonly environmentDigest: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly outputLimitBytes: number;
  readonly tailLimitBytes: number;
  readonly launchEvidenceId: string;
  readonly launchEvidencePayload: Readonly<Record<string, unknown>>;
  readonly expectedResourceVersions: ProcessResourceVersions;
  readonly createdAt: string;
}

export interface ProcessTerminalObservationRequest {
  readonly observationId: string;
  readonly sequence: number;
  readonly kind: ProcessObservationKind;
  readonly evidenceId: string;
  readonly schemaVersion: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type ProcessTerminalOutcome =
  | "exit_zero"
  | "exit_nonzero"
  | "timed_out"
  | "ownership_lost"
  | "supervision_error";

export interface ProcessTerminalCommitRequest {
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly outcome: ProcessTerminalOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly groupDead: boolean;
  readonly descendantsConfirmedDead: boolean;
  readonly observations: readonly ProcessTerminalObservationRequest[];
  readonly resultDigest: string;
  readonly createdAt: string;
}

export type ProcessSupervisorCommandRequest =
  | { readonly kind: "launch"; readonly request: ProcessLaunchCommitRequest }
  | { readonly kind: "terminal"; readonly request: ProcessTerminalCommitRequest };

export class ProcessSupervisorCommand {
  readonly command: ProcessSupervisorCommandRequest;

  constructor(authority: symbol, command: ProcessSupervisorCommandRequest) {
    if (authority !== PROCESS_SUPERVISOR_COMMAND_AUTHORITY) {
      throw new TypeError("process supervisor commands can only be minted after runtime observation");
    }
    this.command = Object.freeze({
      ...command,
      request: Object.freeze({ ...command.request }),
    }) as ProcessSupervisorCommandRequest;
    AUTHORIZED_PROCESS_SUPERVISOR_COMMANDS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedProcessSupervisorCommand(value: unknown): value is ProcessSupervisorCommand {
  return typeof value === "object" && value !== null && AUTHORIZED_PROCESS_SUPERVISOR_COMMANDS.has(value);
}

export interface SupervisedPhaseIdentity {
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly contextDigest: string;
}

export interface SupervisedProcessRequest {
  readonly ownership: AttemptOwnershipGrant;
  readonly authorization: AttemptWorkspaceSpawnAuthorization;
  readonly phase: SupervisedPhaseIdentity;
  readonly argv: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedEnvironmentKeys: readonly string[];
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly deathObservationMs?: number;
  readonly outputLimitBytes?: number;
  readonly tailLimitBytes?: number;
  /**
   * t22B: authority-owned containment membership proof.  When supplied, the
   * supervisor asserts it (brand + lineage) BEFORE spawn; a forged or
   * foreign-lineage membership fails closed to a `spawn_error` with
   * `RICKGENT_CONTAINMENT_UNAVAILABLE` and the gate is not released.  When
   * absent, the legacy fixture path continues (the production cutover that
   * makes this field mandatory is t22D).
   */
  readonly containmentMembership?: ContainmentMembership;
  /** The exact attempt lineage the membership must bind to (t22B). */
  readonly containmentLineage?: ContainmentLineage;
}

export interface VerificationSupervisionRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly contextDigest?: string;
}

export interface VerificationSupervisorReceipt {
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly exitCode: number | null;
  readonly spawnError: string | null;
  readonly stdoutHash: string | null;
  readonly stderrHash: string | null;
  readonly stdoutTail: string | null;
  readonly stderrTail: string | null;
  readonly timedOut: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly groupDead: boolean;
  readonly descendantsConfirmedDead: boolean;
  readonly schemaVersion: string;
}

export type ProcessSupervisorResult = Readonly<{
  outcome: ProcessTerminalOutcome | "spawn_error" | "platform_unsupported";
  launchId: string | null;
  processReceiptId: string | null;
  pid: number | null;
  pgid: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  groupDead: boolean;
  descendantsConfirmedDead: boolean;
  ownership: AttemptOwnershipGrant;
  stdout: BoundedOutputReceipt | null;
  stderr: BoundedOutputReceipt | null;
  detail: string;
}>;

interface RunningTerminalState {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  ownershipLost: boolean;
  supervisionError: string | null;
  term: ProcessSignalObservation | null;
  kill: ProcessSignalObservation | null;
  termTracked: TrackedSignalResult | null;
  killTracked: TrackedSignalResult | null;
  death: ProcessDeathObservation | null;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function buildBoundedOutputReceipt(
  stdout: string,
  stderr: string,
  timedOut: boolean,
  startedAt: string,
  completedAt: string,
  exitCode: number | null,
  spawnError: string | null,
  launchId: string,
  processReceiptId: string,
): VerificationSupervisorReceipt {
  const hash = (text: string): string | null =>
    text.length > 0 ? `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` : null;
  const tail = (text: string, max = 4096): string =>
    text.length > max ? text.slice(-max) : text;
  return Object.freeze({
    launchId,
    processReceiptId,
    exitCode,
    spawnError,
    stdoutHash: hash(stdout),
    stderrHash: hash(stderr),
    stdoutTail: stdout.length > 0 ? tail(stdout) : null,
    stderrTail: stderr.length > 0 ? tail(stderr) : null,
    timedOut,
    startedAt,
    completedAt,
    groupDead: true,
    descendantsConfirmedDead: true,
    schemaVersion: "rickgent.verification-supervisor.v1",
  });
}

function assertPositiveBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertMaximumBound(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new TypeError(`${label} exceeds the maximum ${maximum}`);
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256(canonicalJson(value)).slice("sha256:".length)}`;
}

function resourceVersions(ownership: AttemptOwnershipGrant): ProcessResourceVersions {
  const version = (slot: "process_group" | "stdout" | "stderr"): number => {
    const resource = ownership.resources.find((candidate) => candidate.slot === slot);
    if (resource === undefined || !["reserved", "allocated", "active"].includes(resource.state)) {
      throw new TypeError(`process supervisor resource ${slot} is not owned and available`);
    }
    return resource.stateVersion;
  };
  return Object.freeze({
    process_group: version("process_group"),
    stdout: version("stdout"),
    stderr: version("stderr"),
  });
}

function trackedIdentityDeathConfirmed(death: ProcessDeathObservation | null): boolean {
  return death?.groupDead === true && death.trackedIdentitiesConfirmedDead === true;
}

function authoritativeDescendantDeathConfirmed(death: ProcessDeathObservation | null): boolean {
  return trackedIdentityDeathConfirmed(death) &&
    death?.proofBasis === "authoritative_containment" &&
    death.descendantsConfirmedDead === true;
}

// The canonical BoundedOutputSink now lives in ./containment.js (the
// lower-level module) and is imported above.  Both the containment and
// supervisor paths produce the same BoundedOutputReceipt shape from the
// same streaming sink (scrutiny round 8).

function validateEnvironment(request: SupervisedProcessRequest): Readonly<Record<string, string>> {
  const allowed = new Set(request.allowedEnvironmentKeys);
  if (allowed.size !== request.allowedEnvironmentKeys.length) {
    throw new TypeError("process environment allowlist contains duplicate keys");
  }
  for (const key of allowed) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`process environment allowlist key is invalid: ${key}`);
  }
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(request.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !allowed.has(key)) {
      throw new TypeError(`process environment key is not allowlisted: ${key}`);
    }
    if (typeof value !== "string") throw new TypeError(`process environment value is not a string: ${key}`);
    if (value.includes("\0")) throw new TypeError(`process environment value contains NUL: ${key}`);
    environment[key] = value;
  }
  if (Buffer.byteLength(canonicalJson(environment), "utf8") > MAX_ENVIRONMENT_BYTES) {
    throw new TypeError(`process environment exceeds the ${MAX_ENVIRONMENT_BYTES}-byte bound`);
  }
  return Object.freeze(environment);
}

function validateRequest(request: SupervisedProcessRequest): void {
  if (!isAuthorizedAttemptOwnershipGrant(request.ownership)) throw new TypeError("process ownership grant is unauthorized");
  if (!isAuthorizedAttemptWorkspaceSpawnAuthorization(request.authorization)) {
    throw new TypeError("process spawn authorization is unauthorized");
  }
  if (
    request.authorization.attemptId !== request.ownership.attemptId ||
    request.authorization.ownershipId !== request.ownership.ownership.ownershipId ||
    request.authorization.generation !== request.ownership.ownership.generation ||
    request.authorization.repositoryId !== request.ownership.repositoryId ||
    request.authorization.worktreePath !== request.ownership.plan.worktreePath ||
    request.authorization.isolatedIndexPath !== request.ownership.plan.isolatedIndexPath
  ) throw new TypeError("process spawn authorization does not match ownership");
  if (request.phase.phaseExecutionId === "" || request.phase.contextId === "" || !/^sha256:[0-9a-f]{64}$/.test(request.phase.contextDigest)) {
    throw new TypeError("process phase identity is invalid");
  }
  if (request.argv.length === 0 || !isAbsolute(request.argv[0]) || request.argv.some((argument) => argument.includes("\0"))) {
    throw new TypeError("process argv must contain an absolute executable and NUL-free arguments");
  }
}

function validateExecutable(executable: string): void {
  try {
    const info = lstatSync(executable);
    if (info.isSymbolicLink()) {
      const target = statSync(realpathSync.native(executable));
      if (!target.isFile()) throw new Error("resolved executable is not a regular file");
    } else if (!info.isFile()) {
      throw new Error("executable is not a regular file");
    }
    accessSync(executable, fsConstants.X_OK);
  } catch (error) {
    throw new Error(`process executable is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Internal Phase 19 primitive; production lifecycle cutover remains t22. */
export class ProcessSupervisor {
  readonly #store: StateStore;
  readonly #leases: LeaseAuthority;
  readonly #processes: PosixProcessController;

  constructor(store: StateStore, leases: LeaseAuthority, processes = new PosixProcessController()) {
    this.#store = store;
    this.#leases = leases;
    this.#processes = processes;
  }

  async run(request: SupervisedProcessRequest): Promise<ProcessSupervisorResult> {
    validateRequest(request);
    // t22B: when a containment membership is supplied, assert it is
    // authority-owned and bound to the exact attempt lineage BEFORE any
    // spawn or platform work.  A structurally-correct membership from an
    // injected controller is rejected (VAL-T22B-002, VAL-T22B-005).  When
    // the membership is absent, the legacy fixture path continues; the
    // production cutover that makes this mandatory is t22D.
    if (request.containmentMembership !== undefined) {
      if (request.containmentLineage === undefined) {
        throw new TypeError("containmentLineage is required when containmentMembership is supplied");
      }
      try {
        assertContainmentMembershipForLaunch(request.containmentMembership, request.containmentLineage);
      } catch (error) {
        let ownership = request.ownership;
        try {
          ownership = this.#leases.beginCleanup({
            ownership,
            idempotencyKey: `process-containment-unavailable:${request.phase.phaseExecutionId}`,
          });
        } catch {
          // The containment error remains the authoritative failure.
        }
        return Object.freeze({
          outcome: "spawn_error", launchId: null, processReceiptId: null, pid: null, pgid: null,
          exitCode: null, signal: null, timedOut: false, groupDead: true, descendantsConfirmedDead: true,
          ownership, stdout: null, stderr: null,
          detail: error instanceof ContainmentUnavailableError
            ? `${error.code}: ${error.backendId}: ${error.reason}`
            : `RICKGENT_CONTAINMENT_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = request.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const deathObservationMs = request.deathObservationMs ?? DEFAULT_DEATH_OBSERVATION_MS;
    const outputLimit = request.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    const tailLimit = request.tailLimitBytes ?? DEFAULT_TAIL_LIMIT_BYTES;
    for (const [value, label] of [
      [timeoutMs, "timeout"], [graceMs, "termination grace"], [deathObservationMs, "death observation"],
      [outputLimit, "output limit"], [tailLimit, "tail limit"],
    ] as const) assertPositiveBound(value, label);
    for (const [value, maximum, label] of [
      [timeoutMs, MAX_TIMEOUT_MS, "timeout"],
      [graceMs, MAX_TIMEOUT_MS, "termination grace"],
      [deathObservationMs, MAX_TIMEOUT_MS, "death observation"],
      [outputLimit, MAX_OUTPUT_LIMIT_BYTES, "output limit"],
      [tailLimit, MAX_OUTPUT_LIMIT_BYTES, "tail limit"],
    ] as const) assertMaximumBound(value, maximum, label);
    if (tailLimit > outputLimit) throw new TypeError("tail limit cannot exceed the output limit");
    const environment = validateEnvironment(request);
    let ownership = this.#leases.assertFresh(request.ownership);
    let platform: "darwin" | "linux";
    try {
      platform = this.#processes.assertSupportedPlatform();
    } catch (error) {
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-platform-unsupported:${request.phase.phaseExecutionId}`,
        });
      } catch {
        // The original platform error remains the authoritative failure.
      }
      return Object.freeze({
        outcome: "platform_unsupported", launchId: null, processReceiptId: null, pid: null, pgid: null,
        exitCode: null, signal: null, timedOut: false, groupDead: true, descendantsConfirmedDead: true,
        ownership, stdout: null, stderr: null,
        detail: `RICKGENT_PLATFORM_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    try {
      validateExecutable(request.argv[0]);
    } catch (error) {
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-executable-unavailable:${request.phase.phaseExecutionId}`,
        });
      } catch {
        // The validation error remains the authoritative failure.
      }
      return Object.freeze({
        outcome: "spawn_error", launchId: null, processReceiptId: null, pid: null, pgid: null,
        exitCode: null, signal: null, timedOut: false, groupDead: true, descendantsConfirmedDead: true,
        ownership, stdout: null, stderr: null,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    consumeAttemptWorkspaceSpawnAuthorization(request.authorization);
    let stdoutSink: BoundedOutputSink | null = null;
    let stderrSink: BoundedOutputSink | null = null;
    try {
      stdoutSink = new BoundedOutputSink(ownership.plan.stdoutPath, outputLimit, tailLimit);
      stderrSink = new BoundedOutputSink(ownership.plan.stderrPath, outputLimit, tailLimit);
    } catch (error) {
      const stdout = stdoutSink?.close() ?? null;
      const stderr = stderrSink?.close() ?? null;
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-output-unavailable:${request.phase.phaseExecutionId}`,
        });
      } catch {
        // The output-boundary error remains the authoritative failure.
      }
      return Object.freeze({
        outcome: "supervision_error", launchId: null, processReceiptId: null, pid: null, pgid: null,
        exitCode: null, signal: null, timedOut: false, groupDead: true, descendantsConfirmedDead: true,
        ownership, stdout, stderr,
        detail: `output artifacts could not be opened safely: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (stdoutSink === null || stderrSink === null) throw new Error("output sink initialization returned without both sinks");
    const argvDigest = sha256(canonicalJson(request.argv));
    const environmentDigest = sha256(canonicalJson(environment));
    const identitySeed = {
      schema_version: PROCESS_SUPERVISOR_SCHEMA_VERSION,
      attempt_id: ownership.attemptId,
      ownership_id: ownership.ownership.ownershipId,
      owner_generation: ownership.ownership.generation,
      phase_execution_id: request.phase.phaseExecutionId,
      argv_digest: argvDigest,
      environment_digest: environmentDigest,
    };
    const launchId = deterministicId("process-launch", identitySeed);
    const processReceiptId = deterministicId("process-receipt", identitySeed);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, ["-e", BOOTSTRAP_SOURCE, ...request.argv], {
        cwd: realpathSync.native(request.authorization.worktreePath),
        detached: true,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const stdout = stdoutSink.close();
      const stderr = stderrSink.close();
      try {
        ownership = this.#leases.beginCleanup({ ownership, idempotencyKey: `process-spawn-error:${launchId}` });
      } catch {
        // The spawn error remains the authoritative failure.
      }
      return Object.freeze({
        outcome: "spawn_error", launchId: null, processReceiptId: null, pid: null, pgid: null,
        exitCode: null, signal: null, timedOut: false, groupDead: true, descendantsConfirmedDead: true,
        ownership, stdout, stderr,
        detail: `spawn failed before launch identity: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    child.stdout.on("data", (chunk: Buffer) => stdoutSink.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrSink.write(chunk));
    const pid = await this.#awaitSpawn(child);
    let identity: PosixProcessIdentity;
    try {
      identity = this.#processes.observeIdentity(pid);
      if (identity.pgid !== pid || identity.sid !== pid) throw new Error("spawned bootstrap is not its own POSIX group and session leader");
      this.#processes.trackRoot(identity);
    } catch (error) {
      await this.#abortBeforeRelease(child, pid, graceMs, deathObservationMs);
      await this.#finishOutputStreams(child, Math.min(deathObservationMs, 1_000));
      const stdout = stdoutSink.close();
      const stderr = stderrSink.close();
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-identity-error:${launchId}`,
        });
      } catch {
        // Preserve the pre-release supervision failure.
      }
      return Object.freeze({
        outcome: error instanceof ProcessPlatformError ? "platform_unsupported" : "supervision_error",
        launchId: null, processReceiptId: null, pid, pgid: pid,
        exitCode: null, signal: null, timedOut: false,
        groupDead: false, descendantsConfirmedDead: false, ownership, stdout, stderr,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const createdAt = new Date().toISOString();
    const launchEvidenceId = deterministicId("evidence-process-launch", { launch_id: launchId });
    const launchEvidencePayload = Object.freeze({
      schema_version: "rickgent.process-launch.v1",
      launch_id: launchId,
      process_receipt_id: processReceiptId,
      repository_id: ownership.repositoryId,
      attempt_id: ownership.attemptId,
      ownership_id: ownership.ownership.ownershipId,
      owner_generation: ownership.ownership.generation,
      ownership_context_digest: ownership.ownership.contextDigest,
      phase_execution_id: request.phase.phaseExecutionId,
      context_id: request.phase.contextId,
      execution_context_digest: request.phase.contextDigest,
      spawn_authorization_digest: request.authorization.observationDigest,
      pid: identity.pid,
      pgid: identity.pgid,
      platform,
      boot_identity: identity.bootIdentity,
      process_start_identity: identity.startIdentity,
      argv_digest: argvDigest,
      environment_digest: environmentDigest,
      stdout_path: ownership.plan.stdoutPath,
      stderr_path: ownership.plan.stderrPath,
      output_limit_bytes: outputLimit,
      tail_limit_bytes: tailLimit,
      created_at: createdAt,
    });
    try {
      this.#store.commitAuthorizedProcessLaunch(new ProcessSupervisorCommand(
        PROCESS_SUPERVISOR_COMMAND_AUTHORITY,
        { kind: "launch", request: {
          launchId,
          processReceiptId,
          repositoryId: ownership.repositoryId,
          attemptId: ownership.attemptId,
          ownershipId: ownership.ownership.ownershipId,
          ownerGeneration: ownership.ownership.generation,
          ownershipContextDigest: ownership.ownership.contextDigest,
          phaseExecutionId: request.phase.phaseExecutionId,
          contextId: request.phase.contextId,
          executionContextDigest: request.phase.contextDigest,
          spawnAuthorizationDigest: request.authorization.observationDigest,
          pid: identity.pid,
          pgid: identity.pgid,
          platform,
          bootIdentity: identity.bootIdentity,
          processStartIdentity: identity.startIdentity,
          argvDigest,
          environmentDigest,
          stdoutPath: ownership.plan.stdoutPath,
          stderrPath: ownership.plan.stderrPath,
          outputLimitBytes: outputLimit,
          tailLimitBytes: tailLimit,
          launchEvidenceId,
          launchEvidencePayload,
          expectedResourceVersions: resourceVersions(ownership),
          createdAt,
        } },
      ));
      ownership = this.#leases.assertFresh(ownership);
    } catch (error) {
      await this.#abortBeforeRelease(child, pid, graceMs, deathObservationMs);
      await this.#finishOutputStreams(child, Math.min(deathObservationMs, 1_000));
      const stdout = stdoutSink.close();
      const stderr = stderrSink.close();
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-launch-persistence-error:${launchId}`,
        });
      } catch {
        // Preserve the pre-release persistence failure.
      }
      return Object.freeze({
        outcome: "supervision_error", launchId, processReceiptId, pid, pgid: identity.pgid,
        exitCode: null, signal: null, timedOut: false, groupDead: false, descendantsConfirmedDead: false,
        ownership, stdout, stderr,
        detail: `launch persistence failed before target release: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    child.stdin.end(canonicalJson({
      schema_version: "rickgent.process-start-gate.v1",
      environment,
    }));
    const terminal = await this.#supervise(child, identity, ownership, timeoutMs, graceMs, deathObservationMs);
    ownership = terminal.ownership;
    await this.#finishOutputStreams(child, Math.min(deathObservationMs, 1_000));
    let stdout: BoundedOutputReceipt | null = null;
    let stderr: BoundedOutputReceipt | null = null;
    try {
      stdout = stdoutSink.close();
      stderr = stderrSink.close();
    } catch (error) {
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-output-finalization-error:${launchId}`,
        });
      } catch {
        // Preserve the output finalization failure.
      }
      return Object.freeze({
        outcome: "supervision_error",
        launchId,
        processReceiptId,
        pid,
        pgid: identity.pgid,
        exitCode: terminal.state.exitCode,
        signal: terminal.state.signal,
        timedOut: terminal.state.timedOut,
        groupDead: terminal.state.death?.groupDead === true,
        descendantsConfirmedDead: authoritativeDescendantDeathConfirmed(terminal.state.death),
        ownership,
        stdout,
        stderr,
        detail: `output artifacts could not be finalized safely: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (stdoutSink.failure !== null || stderrSink.failure !== null) {
      terminal.state.supervisionError ??= `bounded output persistence failed: ${
        stdoutSink.failure?.message ?? stderrSink.failure?.message ?? "unknown output failure"
      }`;
    }
    const terminalAt = new Date().toISOString();
    const observations = this.#terminalObservations(
      launchId,
      processReceiptId,
      identity,
      ownership,
      request.phase,
      platform,
      terminal.state,
      stdout,
      stderr,
      terminalAt,
    );
    const groupDead = terminal.state.death?.groupDead === true;
    const trackedIdentitiesConfirmedDead = trackedIdentityDeathConfirmed(terminal.state.death);
    const descendantsConfirmedDead = authoritativeDescendantDeathConfirmed(terminal.state.death);
    let outcome: ProcessTerminalOutcome;
    if (terminal.state.ownershipLost) outcome = "ownership_lost";
    else if (terminal.state.timedOut) outcome = "timed_out";
    else if (terminal.state.supervisionError !== null || !groupDead || !trackedIdentitiesConfirmedDead) outcome = "supervision_error";
    else outcome = terminal.state.exitCode === 0 ? "exit_zero" : "exit_nonzero";
    const terminalSummary = {
      schema_version: "rickgent.process-terminal.v1",
      launch_id: launchId,
      process_receipt_id: processReceiptId,
      outcome,
      exit_code: terminal.state.exitCode,
      signal: terminal.state.signal,
      timed_out: terminal.state.timedOut,
      group_dead: groupDead,
      descendants_confirmed_dead: descendantsConfirmedDead,
      observation_refs: observations.map((observation) => ({
        observation_id: observation.observationId,
        sequence: observation.sequence,
        kind: observation.kind,
        evidence_id: observation.evidenceId,
        schema_version: observation.schemaVersion,
        payload_digest: sha256(canonicalJson(observation.payload)),
        created_at: observation.createdAt,
      })),
      created_at: terminalAt,
    };
    const resultDigest = sha256(canonicalJson(terminalSummary));
    let detail = terminal.state.supervisionError ?? (
      descendantsConfirmedDead
        ? "process supervision completed with authoritative all-descendant death proof"
        : terminal.state.death?.reason ?? "process supervision completed without authoritative descendant death proof"
    );
    let effectiveOutcome = outcome;
    let terminalPersisted = false;
    try {
      this.#store.commitAuthorizedProcessTerminal(new ProcessSupervisorCommand(
        PROCESS_SUPERVISOR_COMMAND_AUTHORITY,
        { kind: "terminal", request: {
          launchId,
          processReceiptId,
          outcome,
          exitCode: terminal.state.exitCode,
          signal: terminal.state.signal,
          timedOut: terminal.state.timedOut,
          groupDead,
          descendantsConfirmedDead,
          observations,
          resultDigest,
          createdAt: terminalAt,
        } },
      ));
      terminalPersisted = true;
    } catch (error) {
      effectiveOutcome = "supervision_error";
      detail = `terminal persistence failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const requiresCleanup = !terminalPersisted || effectiveOutcome !== "exit_zero" || !descendantsConfirmedDead;
    if (requiresCleanup) {
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `process-cleanup:${launchId}`,
        });
        detail = `${detail}; cleanup ownership retained`;
      } catch (error) {
        detail = `${detail}; cleanup ownership unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return Object.freeze({
      outcome: effectiveOutcome,
      launchId,
      processReceiptId,
      pid,
      pgid: identity.pgid,
      exitCode: terminal.state.exitCode,
      signal: terminal.state.signal,
      timedOut: terminal.state.timedOut,
      groupDead,
      descendantsConfirmedDead,
      ownership,
      stdout,
      stderr,
      detail,
    });
  }

  /**
   * t26 scrutiny round 1 fix #6: supervise a verification command synchronously.
   * Returns an authority-owned receipt with exit code, stdout/stderr hashes,
   * and spawn error details.  The receipt is the typed evidence that the
   * gate runner consumes to derive the gate status.
   */
  superviseVerificationSync(req: VerificationSupervisionRequest): VerificationSupervisorReceipt {
    const startedAt = new Date().toISOString();
    const launchId = `verification-launch-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
    const processReceiptId = `verification-receipt-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const result = spawnSync(req.executable, [...req.args], {
        cwd: req.cwd,
        env: req.env,
        timeout: req.timeoutMs,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
      });
      const completedAt = new Date().toISOString();
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      return buildBoundedOutputReceipt(
        stdout, stderr, false, startedAt, completedAt,
        result.status ?? null,
        result.error ? String(result.error) : null,
        launchId, processReceiptId,
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      return buildBoundedOutputReceipt(
        "", "", false, startedAt, completedAt,
        null, error instanceof Error ? error.message : String(error),
        launchId, processReceiptId,
      );
    }
  }

  async #awaitSpawn(child: ChildProcessWithoutNullStreams): Promise<number> {
    if (child.pid !== undefined) return child.pid;
    return new Promise((resolve, reject) => {
      child.once("spawn", () => child.pid === undefined ? reject(new Error("spawned process has no PID")) : resolve(child.pid));
      child.once("error", reject);
    });
  }

  async #abortBeforeRelease(
    child: ChildProcessWithoutNullStreams,
    pid: number,
    graceMs: number,
    deathObservationMs: number,
  ): Promise<void> {
    child.stdin.destroy();
    try {
      this.#processes.signalGroup(pid, "SIGTERM");
    } catch {
      // Continue to the stronger signal and death observation.
    }
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    try {
      this.#processes.signalGroup(pid, "SIGKILL");
    } catch {
      // Death observation below is the authoritative result.
    }
    try {
      await this.#processes.waitForDeath(pid, deathObservationMs);
    } catch {
      // The caller is already fail-closed and will retain cleanup ownership.
    }
  }

  async #supervise(
    child: ChildProcessWithoutNullStreams,
    identity: PosixProcessIdentity,
    initialOwnership: AttemptOwnershipGrant,
    timeoutMs: number,
    graceMs: number,
    deathObservationMs: number,
  ): Promise<{ readonly state: RunningTerminalState; readonly ownership: AttemptOwnershipGrant }> {
    let ownership = initialOwnership;
    const state: RunningTerminalState = {
      exitCode: null,
      signal: null,
      timedOut: false,
      ownershipLost: false,
      supervisionError: null,
      term: null,
      kill: null,
      termTracked: null,
      killTracked: null,
      death: null,
    };
    let resolveTermination!: () => void;
    const termination = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    let terminationStarted = false;
    const terminate = async (): Promise<void> => {
      if (terminationStarted) return;
      terminationStarted = true;
      try {
        try {
          this.#processes.captureDescendants();
        } catch (error) {
          state.supervisionError ??= `descendant capture failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        state.term = this.#processes.signalGroup(identity.pgid, "SIGTERM");
        state.termTracked = this.#processes.signalTrackedPids("SIGTERM", identity.pgid);
        await new Promise((done) => setTimeout(done, graceMs));
        const alive = this.#processes.observeGroup(identity.pgid, identity.bootIdentity);
        if (alive.alive !== false) state.kill = this.#processes.signalGroup(identity.pgid, "SIGKILL");
        state.killTracked = this.#processes.signalTrackedPids("SIGKILL", identity.pgid);
        state.death = await this.#processes.waitForDeath(identity.pgid, deathObservationMs);
      } catch (error) {
        state.supervisionError ??= `termination supervision failed: ${error instanceof Error ? error.message : String(error)}`;
        try {
          state.kill ??= this.#processes.signalGroup(identity.pgid, "SIGKILL");
          state.killTracked ??= this.#processes.signalTrackedPids("SIGKILL", identity.pgid);
          state.death = await this.#processes.waitForDeath(identity.pgid, deathObservationMs);
        } catch (secondary) {
          state.supervisionError = `${state.supervisionError}; death observation failed: ${
            secondary instanceof Error ? secondary.message : String(secondary)
          }`;
        }
      } finally {
        resolveTermination();
      }
    };
    const timeout = setTimeout(() => {
      state.timedOut = true;
      void terminate();
    }, timeoutMs);
    const heartbeatMs = Math.max(
      MIN_HEARTBEAT_INTERVAL_MS,
      Math.min(1_000, Math.floor((Date.parse(ownership.ownership.expiresAt) - Date.parse(ownership.ownership.heartbeatAt)) / 3)),
    );
    const heartbeat = setInterval(() => {
      try {
        ownership = this.#leases.heartbeat({ ownership, idempotencyKey: `process-heartbeat:${identity.pid}:${Date.now()}` });
      } catch (error) {
        state.ownershipLost = true;
        state.supervisionError = `ownership heartbeat failed: ${error instanceof Error ? error.message : String(error)}`;
        void terminate();
      }
    }, heartbeatMs);
    const descendantCapture = setInterval(() => {
      try {
        this.#processes.captureDescendants();
      } catch (error) {
        state.supervisionError ??= `descendant capture failed: ${error instanceof Error ? error.message : String(error)}`;
        void terminate();
      }
    }, DESCENDANT_CAPTURE_INTERVAL_MS);
    const childCompletion = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        state.supervisionError = `child error: ${error.message}`;
        void terminate();
        resolve();
      });
      child.once("exit", (code, signal) => {
        state.exitCode = code;
        state.signal = signal;
        resolve();
      });
    });
    const completion = await Promise.race([
      childCompletion.then(() => "child" as const),
      termination.then(() => "termination" as const),
    ]);
    if (completion === "termination" && state.exitCode === null && state.signal === null) {
      state.supervisionError ??= state.death?.reason ??
        "termination observation completed before the child emitted an exit event";
    }
    clearTimeout(timeout);
    clearInterval(heartbeat);
    clearInterval(descendantCapture);
    try {
      this.#processes.captureDescendants();
      const group = this.#processes.observeGroup(identity.pgid, identity.bootIdentity);
      if (group.alive !== false) {
        void terminate();
        await termination;
      } else {
        state.death = await this.#processes.waitForDeath(identity.pgid, deathObservationMs);
      }
    } catch (error) {
      state.supervisionError ??= `terminal liveness observation failed: ${error instanceof Error ? error.message : String(error)}`;
      void terminate();
      await termination;
    }
    return { state, ownership };
  }

  async #finishOutputStreams(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    const finish = async (stream: NodeJS.ReadableStream & { readonly readableEnded?: boolean; readonly destroyed?: boolean; destroy(error?: Error): void }) => {
      if (stream.readableEnded === true || stream.destroyed === true) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          stream.destroy();
          settle();
        }, timeoutMs);
        stream.once("end", settle);
        stream.once("close", settle);
        stream.once("error", settle);
      });
    };
    await Promise.all([finish(child.stdout), finish(child.stderr)]);
  }

  #terminalObservations(
    launchId: string,
    processReceiptId: string,
    identity: PosixProcessIdentity,
    ownership: AttemptOwnershipGrant,
    phase: SupervisedPhaseIdentity,
    platform: "darwin" | "linux",
    state: RunningTerminalState,
    stdout: BoundedOutputReceipt,
    stderr: BoundedOutputReceipt,
    observedAt: string,
  ): readonly ProcessTerminalObservationRequest[] {
    const items: Array<Omit<ProcessTerminalObservationRequest, "observationId" | "evidenceId" | "sequence">> = [
      {
        kind: "stdout",
        schemaVersion: "rickgent.process-output.v1",
        payload: {
          schema_version: "rickgent.process-output.v1",
          launch_id: launchId,
          process_receipt_id: processReceiptId,
          stream: "stdout",
          path: stdout.path,
          stream_digest: stdout.streamDigest,
          artifact_digest: stdout.artifactDigest,
          original_bytes: stdout.originalBytes,
          stored_bytes: stdout.storedBytes,
          truncated: stdout.truncated,
          tail_base64: stdout.tailBase64,
        },
        createdAt: observedAt,
      },
      {
        kind: "stderr",
        schemaVersion: "rickgent.process-output.v1",
        payload: {
          schema_version: "rickgent.process-output.v1",
          launch_id: launchId,
          process_receipt_id: processReceiptId,
          stream: "stderr",
          path: stderr.path,
          stream_digest: stderr.streamDigest,
          artifact_digest: stderr.artifactDigest,
          original_bytes: stderr.originalBytes,
          stored_bytes: stderr.storedBytes,
          truncated: stderr.truncated,
          tail_base64: stderr.tailBase64,
        },
        createdAt: observedAt,
      },
      {
        kind: "exit",
        schemaVersion: "rickgent.process-exit.v1",
        payload: {
          schema_version: "rickgent.process-exit.v1",
          launch_id: launchId,
          process_receipt_id: processReceiptId,
          pid: identity.pid,
          pgid: identity.pgid,
          exit_code: state.exitCode,
          signal: state.signal,
          observed_at: observedAt,
        },
        createdAt: observedAt,
      },
    ];
    if (state.term !== null || state.kill !== null || state.timedOut || state.ownershipLost) {
      items.push({
        kind: "termination",
        schemaVersion: "rickgent.process-termination.v1",
        payload: {
          schema_version: "rickgent.process-termination.v1",
          launch_id: launchId,
          process_receipt_id: processReceiptId,
          timed_out: state.timedOut,
          ownership_lost: state.ownershipLost,
          term: state.term,
          term_tracked: state.termTracked,
          kill: state.kill,
          kill_tracked: state.killTracked,
          observed_at: observedAt,
        },
        createdAt: observedAt,
      });
    }
    if (state.death?.groupDead === true) {
      items.push({
        kind: "group_death",
        schemaVersion: "rickgent.process-group-death.v1",
        payload: {
          schema_version: "rickgent.process-group-death.v1",
          launch_id: launchId,
          process_receipt_id: processReceiptId,
          attempt_id: ownership.attemptId,
          ownership_id: ownership.ownership.ownershipId,
          owner_generation: ownership.ownership.generation,
          ownership_context_digest: ownership.ownership.contextDigest,
          phase_execution_id: phase.phaseExecutionId,
          context_id: phase.contextId,
          execution_context_digest: phase.contextDigest,
          pid: identity.pid,
          pgid: identity.pgid,
          platform,
          boot_identity: identity.bootIdentity,
          process_start_identity: identity.startIdentity,
          death_observed_at: state.death.observedAt,
          group_dead: true,
          proof_basis: state.death.proofBasis,
          tracked_identities_confirmed_dead: state.death.trackedIdentitiesConfirmedDead,
          descendants_confirmed_dead: authoritativeDescendantDeathConfirmed(state.death),
        },
        createdAt: state.death.observedAt,
      });
    }
    if (state.supervisionError !== null || !authoritativeDescendantDeathConfirmed(state.death)) {
      items.push({
        kind: "infrastructure_error",
        schemaVersion: "rickgent.process-infrastructure-error.v1",
        payload: {
          schema_version: "rickgent.process-infrastructure-error.v1",
          launch_id: launchId,
          process_receipt_id: processReceiptId,
          detail: state.supervisionError ?? state.death?.reason ?? "descendant death was not confirmed",
          observed_at: observedAt,
        },
        createdAt: observedAt,
      });
    }
    return Object.freeze(items.map((item, index) => {
      const sequence = index + 1;
      const identityValue = { launch_id: launchId, sequence, kind: item.kind };
      return Object.freeze({
        ...item,
        sequence,
        observationId: deterministicId("process-observation", identityValue),
        evidenceId: deterministicId("evidence-process", identityValue),
      });
    }));
  }
}
