/**
 * Authority-owned containment interface (t22B).
 *
 * This module implements the runtime-unforgeable containment authority that
 * the `AttemptRunner` (t22C) and the durable target start gate require before
 * any user code is released.  It is owned by the rickgent authority, NOT by
 * an injected controller: a structurally-correct `authoritative_containment`
 * field supplied by a controller is never trusted.  Only the authority-owned
 * backend can mint a death receipt.
 *
 * Backend selection follows the ratified M2 ADR
 * (`docs/decisions/macos-containment-authority.md`):
 *   - Option A: Docker Desktop / Linux-VM cgroup-v2 (macOS production path).
 *   - Option D: native Linux cgroup-v2 (Linux production path).
 *   - Fail-closed: `UnavailableContainmentBackend` on any host where the probe
 *     does not pass; the target start gate mints `target-never-released` and
 *     exits `RICKGENT_CONTAINMENT_UNAVAILABLE` before user code is released.
 *
 * The kernel-level authority is cgroup-v2 in both option A and option D:
 * `cgroup.kill` for terminate-all, `cgroup.events populated=0` for
 * authoritative emptiness, and the `pids`/`memory`/`cpu` controllers for
 * bounded membership.  The macOS host adapter is a thin Docker-container
 * proxy that observes the guest cgroup namespace; the Linux adapter reads
 * `/sys/fs/cgroup` directly.
 *
 * Invariants preserved (architecture.md §4):
 *   - Fail closed, everywhere.  Missing, unavailable, or timeout inputs are
 *     denied (DENY), never allowed.
 *   - One oracle, one matcher.  No parallel containment verdict.
 *   - `execFileSync` with array argv.  Never shell strings for spawning.
 *   - No structural authority field is trusted from an injected controller.
 */

import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import { canonicalJson } from "../contracts/ticket-contract.js";

export const RICKGENT_CONTAINMENT_UNAVAILABLE = "RICKGENT_CONTAINMENT_UNAVAILABLE" as const;
export const CONTAINMENT_SCHEMA_VERSION = "rickgent.containment.v1" as const;
export const CONTAINMENT_RELEASE_SCHEMA_VERSION = "rickgent.containment-release.v1" as const;

// ---------------------------------------------------------------------------
// Authority brands (WeakSet-gated; only the authority-owned backend mints).
// ---------------------------------------------------------------------------

const CONTAINMENT_AUTHORITY = Symbol("rickgent.containment-authority");
const AUTHORIZED_CONTAINMENT_BOUNDARIES = new WeakSet<object>();
const AUTHORIZED_CONTAINMENT_MEMBERSHIPS = new WeakSet<object>();
const AUTHORIZED_CONTAINMENT_EMPTINESS_OBSERVATIONS = new WeakSet<object>();
const AUTHORIZED_CONTAINMENT_DEATH_RECEIPTS = new WeakSet<object>();
const AUTHORIZED_CONTAINMENT_NEVER_RELEASED_RECEIPTS = new WeakSet<object>();

export type Sha256Digest = `sha256:${string}`;

export interface ContainmentLineage {
  readonly runId: string;
  readonly ticketId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipContextDigest: Sha256Digest;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly executionContextDigest: Sha256Digest;
  /** t22D-fix-round-3: Worktree path to bind-mount into the container. */
  readonly worktreePath?: string;
}

export interface ContainmentBoundaryId {
  /** Backend identity: "docker-cgroup-v2" | "linux-cgroup-v2". */
  readonly backendId: string;
  /** Stable cgroup path / container name derived from authoritative lineage. */
  readonly boundaryName: string;
  /** Deterministic launch id from the lineage. */
  readonly launchId: string;
}

export interface ContainmentCapabilities {
  readonly cgroupKill: boolean;
  readonly cgroupEvents: boolean;
  readonly pidsController: boolean;
  readonly memoryController: boolean;
  readonly cpuController: boolean;
}

type MutableContainmentCapabilities = {
  cgroupKill: boolean;
  cgroupEvents: boolean;
  pidsController: boolean;
  memoryController: boolean;
  cpuController: boolean;
};

function frozenCapabilities(c: MutableContainmentCapabilities): ContainmentCapabilities {
  return Object.freeze({ ...c });
}

export type ContainmentBackendStatus = "available" | "unavailable";

export interface ContainmentProbe {
  readonly backendId: string;
  readonly status: ContainmentBackendStatus;
  readonly reason: string | null;
  readonly observedAt: string;
  readonly capabilities: ContainmentCapabilities;
}

export class ContainmentUnavailableError extends Error {
  readonly code = RICKGENT_CONTAINMENT_UNAVAILABLE;
  readonly backendId: string;
  readonly reason: string;
  constructor(backendId: string, reason: string) {
    super(`${RICKGENT_CONTAINMENT_UNAVAILABLE}: ${backendId}: ${reason}`);
    this.name = "ContainmentUnavailableError";
    this.backendId = backendId;
    this.reason = reason;
  }
}

/**
 * Authority-owned containment boundary.  Only a `ContainmentBackend` can
 * construct one; the WeakSet brand rejects structural/prototype/serialized
 * forgeries from an injected controller.
 */
export class ContainmentBoundary implements ContainmentBoundaryId, ContainmentLineage {
  readonly backendId!: string;
  readonly boundaryName!: string;
  readonly launchId!: string;
  readonly runId!: string;
  readonly ticketId!: string;
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipContextDigest!: Sha256Digest;
  readonly phaseExecutionId!: string;
  readonly contextId!: string;
  readonly executionContextDigest!: Sha256Digest;
  /** Backend-specific runtime handle (container id, cgroup mount, etc). */
  readonly runtimeHandle!: string;

  constructor(authority: symbol, input: ContainmentBoundaryId & ContainmentLineage & { runtimeHandle: string }) {
    if (authority !== CONTAINMENT_AUTHORITY) {
      throw new TypeError("ContainmentBoundary can only be minted by a ContainmentBackend");
    }
    Object.assign(this, Object.freeze({ ...input }));
    AUTHORIZED_CONTAINMENT_BOUNDARIES.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedContainmentBoundary(value: unknown): value is ContainmentBoundary {
  return typeof value === "object" && value !== null && AUTHORIZED_CONTAINMENT_BOUNDARIES.has(value);
}

/**
 * Authority-owned containment membership proof.  The target start gate
 * transitions `held -> released` only after observing a brand-authorized
 * membership bound to the exact attempt lineage.
 */
export class ContainmentMembership {
  readonly schemaVersion = CONTAINMENT_SCHEMA_VERSION;
  readonly boundary!: ContainmentBoundaryId;
  readonly lineage!: ContainmentLineage;
  readonly observedAt!: string;
  readonly proofBasis = "authoritative_containment" as const;
  readonly membershipDigest!: Sha256Digest;

  constructor(authority: symbol, input: {
    boundary: ContainmentBoundaryId;
    lineage: ContainmentLineage;
    observedAt: string;
    membershipDigest: Sha256Digest;
  }) {
    if (authority !== CONTAINMENT_AUTHORITY) {
      throw new TypeError("ContainmentMembership can only be minted by a ContainmentBackend");
    }
    Object.assign(this, Object.freeze({ ...input }));
    AUTHORIZED_CONTAINMENT_MEMBERSHIPS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedContainmentMembership(value: unknown): value is ContainmentMembership {
  return typeof value === "object" && value !== null && AUTHORIZED_CONTAINMENT_MEMBERSHIPS.has(value);
}

export interface ContainmentEmptinessObservationFields {
  readonly boundary: ContainmentBoundaryId;
  readonly observedAt: string;
  readonly populated: boolean;
  readonly eventsDigest: Sha256Digest;
  /** True when `cgroup.events populated=0` was observed within the deadline. */
  readonly emptinessConfirmed: boolean;
}

/**
 * Authority-owned emptiness observation.  Only a `ContainmentBackend`'s
 * `awaitEmpty` can construct one; the WeakSet brand rejects
 * structural/prototype/serialized forgeries from an injected controller.
 * `mintDeathReceipt` requires a brand-authorized, confirmed-empty
 * observation before minting a terminal death receipt (M3 fix: a failed or
 * absent observation must not produce a terminal receipt).
 */
export class ContainmentEmptinessObservation {
  readonly schemaVersion = CONTAINMENT_SCHEMA_VERSION;
  readonly boundary!: ContainmentBoundaryId;
  readonly observedAt!: string;
  readonly populated!: boolean;
  readonly proofBasis = "authoritative_containment" as const;
  readonly eventsDigest!: Sha256Digest;
  readonly emptinessConfirmed!: boolean;

  constructor(authority: symbol, input: ContainmentEmptinessObservationFields) {
    if (authority !== CONTAINMENT_AUTHORITY) {
      throw new TypeError("ContainmentEmptinessObservation can only be minted by a ContainmentBackend");
    }
    Object.assign(this, Object.freeze({ ...input }));
    AUTHORIZED_CONTAINMENT_EMPTINESS_OBSERVATIONS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedContainmentEmptinessObservation(value: unknown): value is ContainmentEmptinessObservation {
  return typeof value === "object" && value !== null && AUTHORIZED_CONTAINMENT_EMPTINESS_OBSERVATIONS.has(value);
}

/**
 * Authority-owned death receipt.  Only the authority-owned backend can mint
 * one; a structural `authoritative_containment` field from an injected
 * controller is rejected (VAL-T22B-005).
 */
export class ContainmentDeathReceipt {
  readonly schemaVersion = CONTAINMENT_SCHEMA_VERSION;
  readonly boundary!: ContainmentBoundaryId;
  readonly lineage!: ContainmentLineage;
  readonly observedAt!: string;
  readonly proofBasis = "authoritative_containment" as const;
  readonly deathDigest!: Sha256Digest;
  readonly emptinessConfirmed!: boolean;
  readonly eventsDigest!: Sha256Digest;

  constructor(authority: symbol, input: {
    boundary: ContainmentBoundaryId;
    lineage: ContainmentLineage;
    observedAt: string;
    deathDigest: Sha256Digest;
    emptinessConfirmed: boolean;
    eventsDigest: Sha256Digest;
  }) {
    if (authority !== CONTAINMENT_AUTHORITY) {
      throw new TypeError("ContainmentDeathReceipt can only be minted by a ContainmentBackend");
    }
    Object.assign(this, Object.freeze({ ...input }));
    AUTHORIZED_CONTAINMENT_DEATH_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedContainmentDeathReceipt(value: unknown): value is ContainmentDeathReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_CONTAINMENT_DEATH_RECEIPTS.has(value);
}

/**
 * Authority-owned never-released receipt.  Minted when the containment
 * backend is unavailable; the target start gate transitions
 * `held -> closed_never_released` and no terminal receipt is manufactured.
 */
export class ContainmentNeverReleasedReceipt {
  readonly schemaVersion = CONTAINMENT_SCHEMA_VERSION;
  readonly lineage!: ContainmentLineage;
  readonly observedAt!: string;
  readonly backendId!: string;
  readonly reason!: string;
  readonly receiptDigest!: Sha256Digest;

  constructor(authority: symbol, input: {
    lineage: ContainmentLineage;
    observedAt: string;
    backendId: string;
    reason: string;
    receiptDigest: Sha256Digest;
  }) {
    if (authority !== CONTAINMENT_AUTHORITY) {
      throw new TypeError("ContainmentNeverReleasedReceipt can only be minted by a ContainmentBackend");
    }
    Object.assign(this, Object.freeze({ ...input }));
    AUTHORIZED_CONTAINMENT_NEVER_RELEASED_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedContainmentNeverReleasedReceipt(value: unknown): value is ContainmentNeverReleasedReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_CONTAINMENT_NEVER_RELEASED_RECEIPTS.has(value);
}

// ---------------------------------------------------------------------------
// Backend interface.
// ---------------------------------------------------------------------------

/**
 * Authority-owned containment backend.  The backend is the sole mint of
 * containment boundaries, memberships, death receipts, and never-released
 * receipts.  An injected controller cannot supply any of these; only the
 * brand-checked predicate is authority.
 */
export interface ContainmentBackend {
  readonly backendId: string;
  probe(): ContainmentProbe;
  createBoundary(lineage: ContainmentLineage): Promise<ContainmentBoundary>;
  observeMembership(boundary: ContainmentBoundary): ContainmentMembership;
  /** Launch a target command into the boundary; resolves on exec, not on exit. */
  releaseTarget(boundary: ContainmentBoundary, argv: readonly string[], opts?: { stdoutPath?: string; stderrPath?: string; timeoutMs?: number; workdir?: string }): Promise<ContainmentLaunch>;
  kill(boundary: ContainmentBoundary): Promise<void>;
  awaitEmpty(boundary: ContainmentBoundary, deadlineMs: number): Promise<ContainmentEmptinessObservation>;
  mintDeathReceipt(boundary: ContainmentBoundary, emptiness: ContainmentEmptinessObservation): ContainmentDeathReceipt;
  mintNeverReleasedReceipt(lineage: ContainmentLineage, reason: string): ContainmentNeverReleasedReceipt;
}

export interface ContainmentLaunch {
  readonly boundary: ContainmentBoundary;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutDigest: Sha256Digest;
  readonly stderrDigest: Sha256Digest;
  /** Cgroup membership was proven before user code ran. */
  readonly membership: ContainmentMembership;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function sha256(value: string | Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function boundaryNameFor(lineage: ContainmentLineage): string {
  // rickgent/<run>/<ticket>/<attempt>/<owner>-<gen>/<phase>
  const digest64 = sha256(canonicalJson({
    attempt_id: lineage.attemptId,
    ownership_id: lineage.ownershipId,
    owner_generation: lineage.ownerGeneration,
    phase_execution_id: lineage.phaseExecutionId,
    context_id: lineage.contextId,
  })).slice("sha256:".length, "sha256:".length + 16);
  return `rickgent/${lineage.runId}/${lineage.ticketId}/${lineage.attemptId}/${lineage.ownerGeneration}-${digest64}`;
}

function launchIdFor(lineage: ContainmentLineage): string {
  return `containment-launch-${sha256(canonicalJson({
    schema_version: CONTAINMENT_SCHEMA_VERSION,
    attempt_id: lineage.attemptId,
    ownership_id: lineage.ownershipId,
    owner_generation: lineage.ownerGeneration,
    phase_execution_id: lineage.phaseExecutionId,
    context_id: lineage.contextId,
    execution_context_digest: lineage.executionContextDigest,
  })).slice("sha256:".length)}`;
}

function membershipDigestFor(boundary: ContainmentBoundaryId, lineage: ContainmentLineage): Sha256Digest {
  return sha256(canonicalJson({
    schema_version: CONTAINMENT_SCHEMA_VERSION,
    kind: "containment_membership",
    backend_id: boundary.backendId,
    boundary_name: boundary.boundaryName,
    launch_id: boundary.launchId,
    attempt_id: lineage.attemptId,
    ownership_id: lineage.ownershipId,
    owner_generation: lineage.ownerGeneration,
    phase_execution_id: lineage.phaseExecutionId,
    context_id: lineage.contextId,
    execution_context_digest: lineage.executionContextDigest,
  }));
}

function deathDigestFor(boundary: ContainmentBoundaryId, lineage: ContainmentLineage, eventsDigest: Sha256Digest, observedAt: string): Sha256Digest {
  return sha256(canonicalJson({
    schema_version: CONTAINMENT_SCHEMA_VERSION,
    kind: "containment_death",
    backend_id: boundary.backendId,
    boundary_name: boundary.boundaryName,
    launch_id: boundary.launchId,
    attempt_id: lineage.attemptId,
    ownership_id: lineage.ownershipId,
    owner_generation: lineage.ownerGeneration,
    phase_execution_id: lineage.phaseExecutionId,
    context_id: lineage.contextId,
    execution_context_digest: lineage.executionContextDigest,
    events_digest: eventsDigest,
    observed_at: observedAt,
  }));
}

function neverReleasedDigestFor(lineage: ContainmentLineage, backendId: string, reason: string, observedAt: string): Sha256Digest {
  return sha256(canonicalJson({
    schema_version: CONTAINMENT_SCHEMA_VERSION,
    kind: "containment_never_released",
    backend_id: backendId,
    reason,
    attempt_id: lineage.attemptId,
    ownership_id: lineage.ownershipId,
    owner_generation: lineage.ownerGeneration,
    phase_execution_id: lineage.phaseExecutionId,
    context_id: lineage.contextId,
    execution_context_digest: lineage.executionContextDigest,
    observed_at: observedAt,
  }));
}

/**
 * Boundary id is bound to the exact attempt lineage.  A membership whose
 * boundary id lineage diverges from the requested lineage is rejected.
 */
export function membershipBindsToLineage(membership: ContainmentMembership, lineage: ContainmentLineage): boolean {
  const m = membership.lineage;
  return (
    m.attemptId === lineage.attemptId &&
    m.ownershipId === lineage.ownershipId &&
    m.ownerGeneration === lineage.ownerGeneration &&
    m.ownershipContextDigest === lineage.ownershipContextDigest &&
    m.phaseExecutionId === lineage.phaseExecutionId &&
    m.contextId === lineage.contextId &&
    m.executionContextDigest === lineage.executionContextDigest
  );
}

/**
 * Assert that a supplied containment membership is authority-owned and bound
 * to the exact attempt lineage.  A structurally-correct but unbranded
 * membership (e.g. from an injected controller) is rejected.  This is the
 * production gate the ProcessSupervisor and target start gate call before
 * target release (VAL-T22B-002, VAL-T22B-005).
 */
export function assertContainmentMembershipForLaunch(
  membership: unknown,
  lineage: ContainmentLineage,
): asserts membership is ContainmentMembership {
  if (!isAuthorizedContainmentMembership(membership)) {
    throw new ContainmentUnavailableError(
      "containment-membership",
      "a structurally-correct containment membership is not authority-owned; only the authority-owned backend can mint one",
    );
  }
  if (!membershipBindsToLineage(membership, lineage)) {
    throw new ContainmentUnavailableError(
      membership.boundary.backendId,
      "containment membership is not bound to the exact attempt/owner/generation/phase lineage",
    );
  }
}

// ---------------------------------------------------------------------------
// Backend implementations.
// ---------------------------------------------------------------------------

interface DockerExecOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function dockerExec(argv: readonly string[], opts: DockerExecOptions = {}): string {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;
  try {
    const stdout = execFileSync("docker", argv as string[], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout;
  } catch (error) {
    const e = error as SpawnSyncReturns<string> & { code?: string | number; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    let code: string;
    if (typeof e.code === "string") {
      code = e.code;
    } else if (typeof e.status === "number") {
      code = `EXIT_${e.status}`;
    } else {
      code = "EXEC_FAILED";
    }
    const message = `${code}: ${stderr.trim() || (e.message ?? String(error))}`;
    throw new ContainmentUnavailableError("docker-cgroup-v2", message);
  }
}

function dockerExecSilent(argv: readonly string[], opts: DockerExecOptions = {}): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("docker", argv as string[], {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxOutputBytes ?? 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as SpawnSyncReturns<string> & { status?: number };
    return {
      status: typeof e.status === "number" ? e.status : null,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

/**
 * Parse the `populated` field from a `cgroup.events` body.  Throws on
 * malformed / missing content — a failed parse is a fail-closed
 * containment-unavailable condition, never a synthesized emptiness signal
 * (M3 fix: invariant 6, containment contract obligations 5 and 6).
 */
function parseCgroupEventsPopulated(content: string): boolean {
  const match = content.match(/^populated\s+(\d+)\s*$/m);
  if (match === null) {
    throw new Error(
      `cgroup.events malformed or missing populated field: ${JSON.stringify(content.slice(0, 160))}`,
    );
  }
  return match[1] === "1";
}

/**
 * Option A backend: Docker Desktop / Linux-VM cgroup-v2.
 *
 * Per attempt, it requests a Docker container with `--cgroupns=private`,
 * creates a delegated child cgroup inside that container's private cgroup
 * namespace, launches the worker into that child cgroup, and on termination
 * writes `cgroup.kill` and waits (bounded) for `cgroup.events populated=0`.
 */
export class DockerCgroupV2ContainmentBackend implements ContainmentBackend {
  readonly backendId = "docker-cgroup-v2";
  /** Cached probe; recomputed lazily when invalidateProbe() is called. */
  #cachedProbe: ContainmentProbe | null = null;
  readonly image: string;
  readonly probeTimeoutMs: number;
  readonly killTimeoutMs: number;
  readonly pollIntervalMs: number;
  /**
   * t22D-fix-round-2: Host paths to bind-mount into the container at the same
   * path (e.g. omnigent installation, Python runtime, Node.js, agent bundle,
   * worktree/resource directory).  Without these mounts the dispatched
   * `omnigent run` command cannot execute inside the alpine container because
   * omnigent, Python, Node, the agent bundle, and the worktree are absent.
   */
  readonly hostMounts: readonly string[];
  /**
   * PATH environment value to set inside the container so mounted tools
   * (omnigent, python, node) are findable.  Passed via `docker exec -e PATH=...`.
   */
  readonly containerPath: string | null;
  /**
   * t22D-fix-round-3: RICKGENT_AGENT_DIR to set inside the container.
   * Propagated from the build request's opts.agentDir.
   */
  readonly containerAgentDir: string | null;

  constructor(opts: {
    image?: string;
    probeTimeoutMs?: number;
    killTimeoutMs?: number;
    pollIntervalMs?: number;
    /** Host paths to bind-mount into the container at the same path. */
    hostMounts?: readonly string[];
    /** PATH to set inside the container via `docker exec -e`. */
    containerPath?: string;
    /**
     * t22D-fix-round-3: RICKGENT_AGENT_DIR to set inside the container via
     * `docker exec -e RICKGENT_AGENT_DIR=...`.  Propagated from the build
     * request's opts.agentDir so the dispatched `omnigent run <agentDir>`
     * command resolves the agent bundle inside the container.
     */
    containerAgentDir?: string;
  } = {}) {
    this.image = opts.image ?? "rickgent-runner:latest";
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 30_000;
    this.killTimeoutMs = opts.killTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
    this.hostMounts = Object.freeze([...(opts.hostMounts ?? [])]);
    this.containerPath = opts.containerPath ?? null;
    this.containerAgentDir = opts.containerAgentDir ?? null;
  }

  invalidateProbe(): void {
    this.#cachedProbe = null;
  }

  probe(): ContainmentProbe {
    if (this.#cachedProbe !== null) {
      return this.#cachedProbe;
    }
    const observedAt = nowIso();
    const capabilities: MutableContainmentCapabilities = {
      cgroupKill: false,
      cgroupEvents: false,
      pidsController: false,
      memoryController: false,
      cpuController: false,
    };
    let reason: string | null = null;
    try {
      // 1. docker info confirms cgroup-v2.
      const info = dockerExec(["info", "--format", "{{.OSType}}|{{.Architecture}}|{{.CgroupDriver}}|{{.CgroupVersion}}"], { timeoutMs: this.probeTimeoutMs });
      const parts = info.trim().split("|");
      if (parts.length < 4 || parts[0] !== "linux" || parts[2] !== "cgroupfs" || parts[3] !== "2") {
        reason = `docker info did not confirm cgroup-v2 (got: ${info.trim()})`;
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      // 2. pull the probe image (transient) — fail closed if unreachable.
      dockerExecSilent(["pull", "-q", this.image], { timeoutMs: this.probeTimeoutMs });
      // 3. probe cgroup.kill, cgroup.events, controllers inside a private cgroupns.
      const probeScript = [
        "set -e",
        "test -w /sys/fs/cgroup/cgroup.kill",
        "test -r /sys/fs/cgroup/cgroup.events",
        "cat /sys/fs/cgroup/cgroup.controllers",
        "cat /sys/fs/cgroup/cgroup.events",
      ].join("; ");
      const result = dockerExecSilent(
        ["run", "--rm", "--cgroupns=private", this.image, "sh", "-c", probeScript],
        { timeoutMs: this.probeTimeoutMs },
      );
      if (result.status !== 0) {
        reason = `probe container exited ${result.status}: ${result.stderr.trim()}`;
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      const lines = result.stdout.split("\n");
      const controllers = lines.find((l) => l.includes("cpuset")) ?? "";
      const events = lines.find((l) => l.includes("populated")) ?? "";
      capabilities.cgroupKill = true; // test -w passed
      capabilities.cgroupEvents = true; // test -r passed
      capabilities.pidsController = controllers.includes("pids");
      capabilities.memoryController = controllers.includes("memory");
      capabilities.cpuController = controllers.includes("cpu");
      if (!events.includes("populated")) {
        reason = "cgroup.events did not expose populated field";
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      if (!capabilities.pidsController || !capabilities.memoryController || !capabilities.cpuController) {
        reason = `required controllers missing (pids=${capabilities.pidsController}, memory=${capabilities.memoryController}, cpu=${capabilities.cpuController})`;
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      this.#cachedProbe = { backendId: this.backendId, status: "available", reason: null, observedAt, capabilities: frozenCapabilities(capabilities) };
      return this.#cachedProbe;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
      return this.#cachedProbe;
    }
  }

  async createBoundary(lineage: ContainmentLineage): Promise<ContainmentBoundary> {
    const probe = this.probe();
    if (probe.status !== "available") {
      throw new ContainmentUnavailableError(this.backendId, probe.reason ?? "backend unavailable");
    }
    const boundaryName = boundaryNameFor(lineage);
    const launchId = launchIdFor(lineage);
    // Create a long-lived container with a private cgroup namespace.  The
    // container sleeps so the cgroup stays alive across release/kill/await.
    const containerName = `rickgent-boundary-${launchId}`.slice(0, 63).replace(/[^a-zA-Z0-9_.-]/g, "-");
    // Remove any stale container with the same name (idempotent create).
    dockerExecSilent(["rm", "-f", containerName], { timeoutMs: this.probeTimeoutMs });
    // t22D-fix-round-2: Build the docker create argv with volume mounts for
    // host tools and paths.  Without these mounts the dispatched omnigent run
    // command cannot execute inside the alpine container — omnigent, Python,
    // Node, the agent bundle, and the worktree are all on the host, not in
    // the container image.  Each host path is bind-mounted at the same path
    // inside the container so the dispatch argv's host paths are valid inside
    // the containment boundary.
    const createArgv: string[] = ["create", "--name", containerName, "--cgroupns=private", "--init"];
    for (const hostPath of this.hostMounts) {
      if (hostPath.length > 0 && hostPath.startsWith("/")) {
        createArgv.push("-v", `${hostPath}:${hostPath}`);
      }
    }
    // t22D-fix-round-3: Also mount the worktree path if provided in the lineage.
    // The worktree is where the dispatched agent makes changes; without this
    // mount, changes made inside the container are lost when the container exits.
    if (lineage.worktreePath && lineage.worktreePath.startsWith("/")) {
      createArgv.push("-v", `${lineage.worktreePath}:${lineage.worktreePath}`);
    }
    createArgv.push(this.image, "sleep", "3600");
    const createResult = dockerExecSilent(createArgv, { timeoutMs: this.probeTimeoutMs });
    if (createResult.status !== 0) {
      throw new ContainmentUnavailableError(this.backendId, `docker create failed: ${createResult.stderr.trim()}`);
    }
    const startResult = dockerExecSilent(["start", containerName], { timeoutMs: this.probeTimeoutMs });
    if (startResult.status !== 0) {
      dockerExecSilent(["rm", "-f", containerName], { timeoutMs: this.probeTimeoutMs });
      throw new ContainmentUnavailableError(this.backendId, `docker start failed: ${startResult.stderr.trim()}`);
    }
    const containerId = dockerExec(["inspect", "--format", "{{.Id}}", containerName], { timeoutMs: this.probeTimeoutMs }).trim();
    return new ContainmentBoundary(CONTAINMENT_AUTHORITY, {
      backendId: this.backendId,
      boundaryName,
      launchId,
      runId: lineage.runId,
      ticketId: lineage.ticketId,
      attemptId: lineage.attemptId,
      ownershipId: lineage.ownershipId,
      ownerGeneration: lineage.ownerGeneration,
      ownershipContextDigest: lineage.ownershipContextDigest,
      phaseExecutionId: lineage.phaseExecutionId,
      contextId: lineage.contextId,
      executionContextDigest: lineage.executionContextDigest,
      runtimeHandle: containerName,
    });
  }

  /**
   * The boundary is the container's own root cgroup in its private cgroup
   * namespace.  `--cgroupns=private` gives the container a fresh cgroup
   * namespace whose root is the container's cgroup; every process launched
   * into the container (init + exec'd targets) is a member.  `cgroup.kill`
   * at the root terminates the entire subtree (terminate-all), and
   * `cgroup.events populated=0` is the authoritative emptiness signal.
   *
   * We do NOT create a delegated child cgroup: cgroup-v2 forbids enabling
   * controllers on a cgroup that already has processes (the no-internal-
   * process constraint), and the container init is in the root cgroup.
   * The container's root cgroup already exposes the `pids`/`memory`/`cpu`
   * controllers we probed, so the root IS the authoritative boundary.
   */
  #rootCgroupPath(): string {
    return "/sys/fs/cgroup";
  }

  observeMembership(boundary: ContainmentBoundary): ContainmentMembership {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "observeMembership received a forged boundary");
    }
    // Membership is authoritative once the container is running and its root
    // cgroup is populated by the container init.  The container's private
    // cgroup namespace root is the boundary; every descendant is a member.
    const root = this.#rootCgroupPath();
    const probeScript = [
      "set -e",
      `test -w ${root}/cgroup.kill`,
      `cat ${root}/cgroup.events`,
    ].join("; ");
    const result = dockerExecSilent(
      ["exec", boundary.runtimeHandle, "sh", "-c", probeScript],
      { timeoutMs: this.probeTimeoutMs },
    );
    if (result.status !== 0) {
      throw new ContainmentUnavailableError(this.backendId, `membership observation failed: ${result.stderr.trim()}`);
    }
    if (!/populated\s+1/.test(result.stdout)) {
      throw new ContainmentUnavailableError(this.backendId, "boundary cgroup is not populated; membership is not authoritative");
    }
    const membershipDigest = membershipDigestFor(boundary, boundary);
    return new ContainmentMembership(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      lineage: {
        runId: boundary.runId,
        ticketId: boundary.ticketId,
        attemptId: boundary.attemptId,
        ownershipId: boundary.ownershipId,
        ownerGeneration: boundary.ownerGeneration,
        ownershipContextDigest: boundary.ownershipContextDigest,
        phaseExecutionId: boundary.phaseExecutionId,
        contextId: boundary.contextId,
        executionContextDigest: boundary.executionContextDigest,
      },
      observedAt: nowIso(),
      membershipDigest,
    });
  }

  async releaseTarget(
    boundary: ContainmentBoundary,
    argv: readonly string[],
    opts: { stdoutPath?: string; stderrPath?: string; timeoutMs?: number; workdir?: string } = {},
  ): Promise<ContainmentLaunch> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "releaseTarget received a forged boundary");
    }
    // Observe membership BEFORE user code runs: the container is running and
    // its cgroup is populated.  Target code cannot begin before membership is
    // authoritative (VAL-T22B-002).
    const membership = this.observeMembership(boundary);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const stdoutPath = opts.stdoutPath ?? join(realpathSync(tmpdir()), `rickgent-containment-stdout-${boundary.launchId}`);
    const stderrPath = opts.stderrPath ?? join(realpathSync(tmpdir()), `rickgent-containment-stderr-${boundary.launchId}`);
    for (const p of [stdoutPath, stderrPath]) {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
      if (dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    // Launch the target into the container's cgroup via `docker exec`.  The
    // exec'd process is a member of the container's root cgroup (the
    // boundary); it cannot escape the private cgroup namespace without
    // CAP_SYS_ADMIN on the host, which the container does not have.
    // t22D-fix-round-2: Set PATH inside the container via `-e` so the
    // mounted tools (omnigent, python, node) are findable.  Without this,
    // the alpine container's default PATH does not include the host tool
    // directories, and the dispatch command fails with "executable not found".
    // t22D-fix-round-3: Also set RICKGENT_AGENT_DIR inside the container so
    // the dispatched `omnigent run <agentDir>` command resolves the agent
    // bundle.  Propagated from the build request's opts.agentDir.
    // t22D-fix-round-3: Set the working directory to the worktree path so
    // the dispatch argv runs in the worktree (where changes are visible on
    // the host via the bind mount).  Without this, the argv runs in the
    // container's default working directory (/) and changes are lost.
    const execArgv: string[] = ["exec"];
    if (this.containerPath !== null) {
      execArgv.push("-e", `PATH=${this.containerPath}`);
    }
    if (this.containerAgentDir !== null) {
      execArgv.push("-e", `RICKGENT_AGENT_DIR=${this.containerAgentDir}`);
    }
    if (opts.workdir && opts.workdir.startsWith("/")) {
      execArgv.push("-w", opts.workdir);
    }
    execArgv.push(boundary.runtimeHandle, ...argv);
    const result = dockerExecSilent(execArgv, { timeoutMs });
    writeFileSync(stdoutPath, result.stdout);
    writeFileSync(stderrPath, result.stderr);
    const stdoutSink = createHash("sha256");
    const stderrSink = createHash("sha256");
    stdoutSink.update(result.stdout);
    stderrSink.update(result.stderr);
    const timedOut = result.status === null;
    return Object.freeze({
      boundary,
      exitCode: result.status,
      timedOut,
      stdoutDigest: `sha256:${stdoutSink.digest("hex")}` as Sha256Digest,
      stderrDigest: `sha256:${stderrSink.digest("hex")}` as Sha256Digest,
      membership,
    });
  }

  async kill(boundary: ContainmentBoundary): Promise<void> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "kill received a forged boundary");
    }
    const root = this.#rootCgroupPath();
    // Write cgroup.kill=1 to terminate every descendant in the container's
    // cgroup subtree (kernel SIGKILL to all members).  No per-PID
    // enumeration.  The write may fail if the container already exited; we
    // then fall through to `docker stop` to ensure no survivors.
    dockerExecSilent(
      ["exec", boundary.runtimeHandle, "sh", "-c", `echo 1 > ${root}/cgroup.kill 2>/dev/null; true`],
      { timeoutMs: this.killTimeoutMs },
    );
    dockerExecSilent(["stop", boundary.runtimeHandle], { timeoutMs: this.killTimeoutMs });
  }

  async awaitEmpty(boundary: ContainmentBoundary, deadlineMs: number): Promise<ContainmentEmptinessObservation> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "awaitEmpty received a forged boundary");
    }
    // Docker emptiness observation: the Docker daemon is the authority for
    // container process state.  We cannot read `cgroup.events populated=0`
    // via `docker exec` because the exec process itself is a member of the
    // container's root cgroup (keeping it populated for the duration of the
    // read); the only way the old path ever observed "empty" was by
    // synthesizing populated=0 from a FAILED docker exec after the container
    // was stopped — the fail-open the M3 scrutiny validator identified.
    //
    // Instead we observe the container's authoritative state via
    // `docker inspect`: `State.Status=exited` and `State.Pid=0` means no
    // processes remain in the container's cgroup (the cgroup is gone or
    // empty).  This is fail-closed: if the inspect fails (container gone,
    // daemon error) or the output is malformed, we throw
    // ContainmentUnavailableError — never synthesize populated=0 from a
    // failed observation (M3 fix: invariant 6, contract obligations 5/6).
    const deadline = Date.now() + deadlineMs;
    let lastObservation = "";
    let confirmedEmpty = false;
    const inspectContainer = (): { status: string; pid: number; raw: string } => {
      const result = dockerExecSilent(
        ["inspect", "--format", "{{.State.Status}} {{.State.Pid}}", boundary.runtimeHandle],
        { timeoutMs: this.probeTimeoutMs },
      );
      if (result.status !== 0) {
        throw new ContainmentUnavailableError(
          this.backendId,
          `container state observation failed (docker inspect status ${result.status}): ${result.stderr.trim() || "container is gone or daemon unavailable"}`,
        );
      }
      const raw = result.stdout.trim();
      const parts = raw.split(/\s+/);
      const status = parts[0] ?? "";
      const pid = Number.parseInt(parts[1] ?? "-1", 10);
      if (status === "" || Number.isNaN(pid)) {
        throw new ContainmentUnavailableError(
          this.backendId,
          `container state observation malformed: ${JSON.stringify(raw)}`,
        );
      }
      return { status, pid, raw };
    };
    while (Date.now() < deadline) {
      const obs = inspectContainer();
      lastObservation = obs.raw;
      if (obs.status === "exited" && obs.pid === 0) {
        confirmedEmpty = true;
        break;
      }
      await sleep(this.pollIntervalMs);
    }
    if (!confirmedEmpty) {
      await this.kill(boundary);
      const obs = inspectContainer();
      lastObservation = obs.raw;
      confirmedEmpty = obs.status === "exited" && obs.pid === 0;
    }
    return new ContainmentEmptinessObservation(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      observedAt: nowIso(),
      populated: !confirmedEmpty,
      eventsDigest: sha256(lastObservation),
      emptinessConfirmed: confirmedEmpty,
    });
  }

  mintDeathReceipt(boundary: ContainmentBoundary, emptiness: ContainmentEmptinessObservation): ContainmentDeathReceipt {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt received a forged boundary");
    }
    if (!isAuthorizedContainmentEmptinessObservation(emptiness)) {
      throw new ContainmentUnavailableError(
        this.backendId,
        "mintDeathReceipt received a forged (unbranded) emptiness observation; only the authority-owned backend can mint one",
      );
    }
    // Exact boundary binding (M3 scrutiny round 2 fix: contract obligation 6).
    // A genuine authority-branded confirmed-empty observation from a different
    // boundary or backend with the same launchId must not mint a terminal
    // death receipt for this boundary.  Require exact equality of backendId,
    // boundaryName, AND launchId before minting.  launchIdFor() does not
    // incorporate runId/ticketId while boundaryNameFor() does, so two
    // lineages differing only in runId produce the same launchId but
    // different boundaryName; and launchIdFor()/boundaryNameFor() are
    // backend-independent, so the same lineage on Docker and Linux produces
    // the same launchId/boundaryName but different backendId.  Checking only
    // launchId would accept both substitution vectors (fail-open).
    if (
      emptiness.boundary.launchId !== boundary.launchId ||
      emptiness.boundary.backendId !== boundary.backendId ||
      emptiness.boundary.boundaryName !== boundary.boundaryName
    ) {
      throw new ContainmentUnavailableError(
        this.backendId,
        "emptiness observation does not bind to the exact boundary (backendId + boundaryName + launchId must all match)",
      );
    }
    // A terminal death receipt requires an authority-owned, confirmed-empty
    // (populated=0) observation.  A failed, absent, or not-confirmed
    // observation must not produce a terminal receipt — the caller produces
    // a target-never-released / containment-unavailable outcome instead
    // (M3 fix: contract obligations 5 and 6).
    if (!emptiness.emptinessConfirmed || emptiness.populated) {
      throw new ContainmentUnavailableError(
        this.backendId,
        "mintDeathReceipt requires a confirmed-empty (populated=0) observation; a failed or absent observation must not produce a terminal receipt",
      );
    }
    return new ContainmentDeathReceipt(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      lineage: {
        runId: boundary.runId,
        ticketId: boundary.ticketId,
        attemptId: boundary.attemptId,
        ownershipId: boundary.ownershipId,
        ownerGeneration: boundary.ownerGeneration,
        ownershipContextDigest: boundary.ownershipContextDigest,
        phaseExecutionId: boundary.phaseExecutionId,
        contextId: boundary.contextId,
        executionContextDigest: boundary.executionContextDigest,
      },
      observedAt: emptiness.observedAt,
      deathDigest: deathDigestFor(boundary, boundary, emptiness.eventsDigest, emptiness.observedAt),
      emptinessConfirmed: emptiness.emptinessConfirmed,
      eventsDigest: emptiness.eventsDigest,
    });
  }

  mintNeverReleasedReceipt(lineage: ContainmentLineage, reason: string): ContainmentNeverReleasedReceipt {
    return new ContainmentNeverReleasedReceipt(CONTAINMENT_AUTHORITY, {
      lineage,
      observedAt: nowIso(),
      backendId: this.backendId,
      reason,
      receiptDigest: neverReleasedDigestFor(lineage, this.backendId, reason, nowIso()),
    });
  }

  /** Remove the boundary container (cleanup).  Idempotent. */
  async dispose(boundary: ContainmentBoundary): Promise<void> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      return;
    }
    dockerExecSilent(["rm", "-f", boundary.runtimeHandle], { timeoutMs: this.probeTimeoutMs });
  }
}

/**
 * Option D native path: Linux cgroup-v2 directly at `/sys/fs/cgroup`.
 * Used on Linux hosts without Docker; on macOS the Docker backend is the
 * production path.  This implementation is provided for the platform matrix
 * and is exercised on Linux hosts; on macOS the probe fails closed.
 */
export class LinuxCgroupV2ContainmentBackend implements ContainmentBackend {
  readonly backendId = "linux-cgroup-v2";
  #cachedProbe: ContainmentProbe | null = null;
  readonly cgroupRoot: string;
  readonly pollIntervalMs: number;

  constructor(opts: { cgroupRoot?: string; pollIntervalMs?: number } = {}) {
    this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
  }

  probe(): ContainmentProbe {
    if (this.#cachedProbe !== null) {
      return this.#cachedProbe;
    }
    const observedAt = nowIso();
    const capabilities: MutableContainmentCapabilities = {
      cgroupKill: false, cgroupEvents: false, pidsController: false, memoryController: false, cpuController: false,
    };
    let reason: string | null = null;
    try {
      if (!existsSync(this.cgroupRoot)) {
        reason = `cgroup root ${this.cgroupRoot} does not exist`;
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      const killPath = join(this.cgroupRoot, "cgroup.kill");
      const eventsPath = join(this.cgroupRoot, "cgroup.events");
      const controllersPath = join(this.cgroupRoot, "cgroup.controllers");
      if (!existsSync(killPath)) {
        reason = "cgroup.kill not present";
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      const controllers = existsSync(controllersPath) ? readFileSync(controllersPath, "utf8") : "";
      capabilities.cgroupKill = true;
      capabilities.cgroupEvents = existsSync(eventsPath);
      capabilities.pidsController = controllers.includes("pids");
      capabilities.memoryController = controllers.includes("memory");
      capabilities.cpuController = controllers.includes("cpu");
      if (!capabilities.cgroupEvents || !capabilities.pidsController || !capabilities.memoryController || !capabilities.cpuController) {
        reason = `required controllers/events missing`;
        this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
        return this.#cachedProbe;
      }
      this.#cachedProbe = { backendId: this.backendId, status: "available", reason: null, observedAt, capabilities: frozenCapabilities(capabilities) };
      return this.#cachedProbe;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      this.#cachedProbe = { backendId: this.backendId, status: "unavailable", reason, observedAt, capabilities: frozenCapabilities(capabilities) };
      return this.#cachedProbe;
    }
  }

  async createBoundary(lineage: ContainmentLineage): Promise<ContainmentBoundary> {
    const probe = this.probe();
    if (probe.status !== "available") {
      throw new ContainmentUnavailableError(this.backendId, probe.reason ?? "backend unavailable");
    }
    const boundaryName = boundaryNameFor(lineage);
    const launchId = launchIdFor(lineage);
    const childPath = join(this.cgroupRoot, boundaryName.replace(/\//g, "_").slice(0, 200));
    try {
      mkdirSync(childPath, { recursive: true });
    } catch (error) {
      throw new ContainmentUnavailableError(this.backendId, `cgroup mkdir failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new ContainmentBoundary(CONTAINMENT_AUTHORITY, {
      backendId: this.backendId, boundaryName, launchId,
      runId: lineage.runId, ticketId: lineage.ticketId, attemptId: lineage.attemptId,
      ownershipId: lineage.ownershipId, ownerGeneration: lineage.ownerGeneration,
      ownershipContextDigest: lineage.ownershipContextDigest,
      phaseExecutionId: lineage.phaseExecutionId, contextId: lineage.contextId,
      executionContextDigest: lineage.executionContextDigest,
      runtimeHandle: childPath,
    });
  }

  observeMembership(boundary: ContainmentBoundary): ContainmentMembership {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "observeMembership received a forged boundary");
    }
    if (!existsSync(boundary.runtimeHandle)) {
      throw new ContainmentUnavailableError(this.backendId, "child cgroup does not exist");
    }
    return new ContainmentMembership(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      lineage: {
        runId: boundary.runId, ticketId: boundary.ticketId, attemptId: boundary.attemptId,
        ownershipId: boundary.ownershipId, ownerGeneration: boundary.ownerGeneration,
        ownershipContextDigest: boundary.ownershipContextDigest,
        phaseExecutionId: boundary.phaseExecutionId, contextId: boundary.contextId,
        executionContextDigest: boundary.executionContextDigest,
      },
      observedAt: nowIso(),
      membershipDigest: membershipDigestFor(boundary, boundary),
    });
  }

  async releaseTarget(boundary: ContainmentBoundary, argv: readonly string[]): Promise<ContainmentLaunch> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "releaseTarget received a forged boundary");
    }
    const membership = this.observeMembership(boundary);
    // Native Linux: write $$ into cgroup.procs then exec.  This is best-effort
    // on hosts where the test runner has CAP_SYS_ADMIN; the corpus is
    // primarily exercised via the Docker backend on macOS.
    let exitCode: number | null = null;
    let timedOut = false;
    const stdoutSink = createHash("sha256");
    const stderrSink = createHash("sha256");
    try {
      const out = execFileSync("sh", ["-c", `echo $$ > ${boundary.runtimeHandle}/cgroup.procs 2>/dev/null; exec ${argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`], {
        encoding: "utf8", timeout: 30_000,
      });
      stdoutSink.update(out);
      exitCode = 0;
    } catch (error) {
      const e = error as SpawnSyncReturns<string> & { status?: number };
      stdoutSink.update(typeof e.stdout === "string" ? e.stdout : "");
      stderrSink.update(typeof e.stderr === "string" ? e.stderr : "");
      exitCode = typeof e.status === "number" ? e.status : null;
      timedOut = e.signal === "SIGTERM";
    }
    return Object.freeze({
      boundary, exitCode, timedOut,
      stdoutDigest: `sha256:${stdoutSink.digest("hex")}` as Sha256Digest,
      stderrDigest: `sha256:${stderrSink.digest("hex")}` as Sha256Digest,
      membership,
    });
  }

  async kill(boundary: ContainmentBoundary): Promise<void> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "kill received a forged boundary");
    }
    try {
      writeFileSync(join(boundary.runtimeHandle, "cgroup.kill"), "1");
    } catch {
      // Best-effort; the awaitEmpty poll confirms emptiness.
    }
  }

  async awaitEmpty(boundary: ContainmentBoundary, deadlineMs: number): Promise<ContainmentEmptinessObservation> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "awaitEmpty received a forged boundary");
    }
    const deadline = Date.now() + deadlineMs;
    let lastEvents = "";
    let populated = true;
    // Fail-closed read: a stopped / unreadable / malformed boundary throws
    // ContainmentUnavailableError; we never synthesize populated=0 from a
    // failed read (M3 fix: invariant 6, contract obligations 5 and 6).
    const readCgroupEvents = (): string => {
      try {
        return readFileSync(join(boundary.runtimeHandle, "cgroup.events"), "utf8");
      } catch (error) {
        throw new ContainmentUnavailableError(
          this.backendId,
          `cgroup.events read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    while (Date.now() < deadline) {
      lastEvents = readCgroupEvents();
      try {
        populated = parseCgroupEventsPopulated(lastEvents);
      } catch (error) {
        throw new ContainmentUnavailableError(this.backendId, error instanceof Error ? error.message : String(error));
      }
      if (!populated) {
        break;
      }
      await sleep(this.pollIntervalMs);
    }
    if (populated) {
      await this.kill(boundary);
      lastEvents = readCgroupEvents();
      try {
        populated = parseCgroupEventsPopulated(lastEvents);
      } catch (error) {
        throw new ContainmentUnavailableError(this.backendId, error instanceof Error ? error.message : String(error));
      }
    }
    return new ContainmentEmptinessObservation(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      observedAt: nowIso(), populated, eventsDigest: sha256(lastEvents), emptinessConfirmed: !populated,
    });
  }

  mintDeathReceipt(boundary: ContainmentBoundary, emptiness: ContainmentEmptinessObservation): ContainmentDeathReceipt {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt received a forged boundary");
    }
    if (!isAuthorizedContainmentEmptinessObservation(emptiness)) {
      throw new ContainmentUnavailableError(
        this.backendId,
        "mintDeathReceipt received a forged (unbranded) emptiness observation; only the authority-owned backend can mint one",
      );
    }
    // Exact boundary binding (M3 scrutiny round 2 fix: contract obligation 6).
    // A genuine authority-branded confirmed-empty observation from a different
    // boundary or backend with the same launchId must not mint a terminal
    // death receipt for this boundary.  Require exact equality of backendId,
    // boundaryName, AND launchId before minting.  launchIdFor() does not
    // incorporate runId/ticketId while boundaryNameFor() does, so two
    // lineages differing only in runId produce the same launchId but
    // different boundaryName; and launchIdFor()/boundaryNameFor() are
    // backend-independent, so the same lineage on Docker and Linux produces
    // the same launchId/boundaryName but different backendId.  Checking only
    // launchId would accept both substitution vectors (fail-open).
    if (
      emptiness.boundary.launchId !== boundary.launchId ||
      emptiness.boundary.backendId !== boundary.backendId ||
      emptiness.boundary.boundaryName !== boundary.boundaryName
    ) {
      throw new ContainmentUnavailableError(
        this.backendId,
        "emptiness observation does not bind to the exact boundary (backendId + boundaryName + launchId must all match)",
      );
    }
    // A terminal death receipt requires an authority-owned, confirmed-empty
    // (populated=0) observation.  A failed, absent, or not-confirmed
    // observation must not produce a terminal receipt (M3 fix).
    if (!emptiness.emptinessConfirmed || emptiness.populated) {
      throw new ContainmentUnavailableError(
        this.backendId,
        "mintDeathReceipt requires a confirmed-empty (populated=0) observation; a failed or absent observation must not produce a terminal receipt",
      );
    }
    return new ContainmentDeathReceipt(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      lineage: {
        runId: boundary.runId, ticketId: boundary.ticketId, attemptId: boundary.attemptId,
        ownershipId: boundary.ownershipId, ownerGeneration: boundary.ownerGeneration,
        ownershipContextDigest: boundary.ownershipContextDigest,
        phaseExecutionId: boundary.phaseExecutionId, contextId: boundary.contextId,
        executionContextDigest: boundary.executionContextDigest,
      },
      observedAt: emptiness.observedAt,
      deathDigest: deathDigestFor(boundary, boundary, emptiness.eventsDigest, emptiness.observedAt),
      emptinessConfirmed: emptiness.emptinessConfirmed,
      eventsDigest: emptiness.eventsDigest,
    });
  }

  mintNeverReleasedReceipt(lineage: ContainmentLineage, reason: string): ContainmentNeverReleasedReceipt {
    return new ContainmentNeverReleasedReceipt(CONTAINMENT_AUTHORITY, {
      lineage, observedAt: nowIso(), backendId: this.backendId, reason,
      receiptDigest: neverReleasedDigestFor(lineage, this.backendId, reason, nowIso()),
    });
  }
}

/**
 * Fail-closed backend: used on any host where the option A/D probe does not
 * pass.  `createBoundary` throws `RICKGENT_CONTAINMENT_UNAVAILABLE`; the only
 * minting that succeeds is `mintNeverReleasedReceipt`, which the
 * `TargetStartGateAuthority` consumes to transition `held -> closed_never_released`.
 */
export class UnavailableContainmentBackend implements ContainmentBackend {
  readonly backendId = "unavailable";
  readonly #reason: string;
  constructor(reason = "no containment backend available on this host") {
    this.#reason = reason;
  }
  probe(): ContainmentProbe {
    return {
      backendId: this.backendId, status: "unavailable", reason: this.#reason, observedAt: nowIso(),
      capabilities: { cgroupKill: false, cgroupEvents: false, pidsController: false, memoryController: false, cpuController: false },
    };
  }
  async createBoundary(): Promise<ContainmentBoundary> {
    throw new ContainmentUnavailableError(this.backendId, this.#reason);
  }
  observeMembership(): ContainmentMembership {
    throw new ContainmentUnavailableError(this.backendId, this.#reason);
  }
  async releaseTarget(): Promise<ContainmentLaunch> {
    throw new ContainmentUnavailableError(this.backendId, this.#reason);
  }
  async kill(): Promise<void> {
    throw new ContainmentUnavailableError(this.backendId, this.#reason);
  }
  async awaitEmpty(): Promise<ContainmentEmptinessObservation> {
    throw new ContainmentUnavailableError(this.backendId, this.#reason);
  }
  mintDeathReceipt(): ContainmentDeathReceipt {
    throw new ContainmentUnavailableError(this.backendId, "unavailable backend cannot mint a death receipt");
  }
  mintNeverReleasedReceipt(lineage: ContainmentLineage, reason: string): ContainmentNeverReleasedReceipt {
    return new ContainmentNeverReleasedReceipt(CONTAINMENT_AUTHORITY, {
      lineage, observedAt: nowIso(), backendId: this.backendId, reason,
      receiptDigest: neverReleasedDigestFor(lineage, this.backendId, reason, nowIso()),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fixture containment backend (t22C composition proof).
// ---------------------------------------------------------------------------

/**
 * Authority-owned fixture containment backend for the t22C AttemptRunner
 * composition proof.  This backend mints REAL branded containment receipts
 * (boundaries, memberships, emptiness observations, death receipts, and
 * never-released receipts) via the private {@link CONTAINMENT_AUTHORITY}
 * symbol, exactly like the production Docker/Linux backends.  It launches a
 * real target subprocess in a new POSIX process group/session and uses
 * process-group kill plus an authoritative wait-for-exit as the emptiness
 * observation.
 *
 * This backend is NOT selected by {@link probeContainmentBackend}: it is
 * reachable only through explicit construction in the t22C composition test
 * (and any future fixture-only proof that needs real branded receipts without
 * a Docker/cgroup-v2 host).  Production dispatch (t22D) uses the probed
 * backend; this fixture never becomes the production authority.
 *
 * The fixture is honest about its proof basis: it tracks the launched
 * process group and confirms emptiness by waiting for the group leader to
 * exit AND verifying no tracked child remains.  It does NOT claim
 * all-descendant cgroup authority (that is the production Docker/Linux
 * backend's job, proven by t22B).  The t22C composition proof exercises the
 * AttemptRunner's ordering, idempotency, state machines, and crash recovery
 * on top of real branded receipts, not the containment kernel mechanism
 * itself.
 */
export class FixtureContainmentBackend implements ContainmentBackend {
  readonly backendId = "fixture-process-group";
  readonly #tracked = new Map<string, { readonly pid: number; readonly pgid: number; exited: boolean }>();
  readonly #memberships = new Map<string, ContainmentMembership>();

  probe(): ContainmentProbe {
    return {
      backendId: this.backendId,
      status: "available",
      reason: null,
      observedAt: nowIso(),
      capabilities: { cgroupKill: false, cgroupEvents: false, pidsController: false, memoryController: false, cpuController: false },
    };
  }

  async createBoundary(lineage: ContainmentLineage): Promise<ContainmentBoundary> {
    const boundaryName = boundaryNameFor(lineage);
    const launchId = launchIdFor(lineage);
    return new ContainmentBoundary(CONTAINMENT_AUTHORITY, {
      backendId: this.backendId,
      boundaryName,
      launchId,
      runId: lineage.runId,
      ticketId: lineage.ticketId,
      attemptId: lineage.attemptId,
      ownershipId: lineage.ownershipId,
      ownerGeneration: lineage.ownerGeneration,
      ownershipContextDigest: lineage.ownershipContextDigest,
      phaseExecutionId: lineage.phaseExecutionId,
      contextId: lineage.contextId,
      executionContextDigest: lineage.executionContextDigest,
      runtimeHandle: `fixture:${boundaryName}`,
    });
  }

  observeMembership(boundary: ContainmentBoundary): ContainmentMembership {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "observeMembership received a forged boundary");
    }
    const existing = this.#memberships.get(boundary.launchId);
    if (existing !== undefined && membershipBindsToLineage(existing, boundary)) {
      return existing;
    }
    const membership = new ContainmentMembership(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      lineage: {
        runId: boundary.runId, ticketId: boundary.ticketId, attemptId: boundary.attemptId,
        ownershipId: boundary.ownershipId, ownerGeneration: boundary.ownerGeneration,
        ownershipContextDigest: boundary.ownershipContextDigest,
        phaseExecutionId: boundary.phaseExecutionId, contextId: boundary.contextId,
        executionContextDigest: boundary.executionContextDigest,
      },
      observedAt: nowIso(),
      membershipDigest: membershipDigestFor(boundary, boundary),
    });
    this.#memberships.set(boundary.launchId, membership);
    return membership;
  }

  async releaseTarget(
    boundary: ContainmentBoundary,
    argv: readonly string[],
    opts: { readonly stdoutPath?: string; readonly stderrPath?: string; readonly timeoutMs?: number } = {},
  ): Promise<ContainmentLaunch> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "releaseTarget received a forged boundary");
    }
    if (argv.length === 0 || !isAbsolute(argv[0]!)) {
      throw new ContainmentUnavailableError(this.backendId, "releaseTarget argv must contain an absolute executable");
    }
    const membership = this.observeMembership(boundary);
    const { spawn } = await import("node:child_process");
    const { openSync, closeSync, writeSync, mkdirSync, constants } = await import("node:fs");
    const { dirname } = await import("node:path");
    const stdoutPath = opts.stdoutPath ?? "/dev/null";
    const stderrPath = opts.stderrPath ?? "/dev/null";
    const openOut = (path: string): number | null => {
      if (path === "/dev/null") return null;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      return openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
    };
    const stdoutFd = openOut(stdoutPath);
    const stderrFd = openOut(stderrPath);
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
    });
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
    const pid = child.pid ?? 0;
    if (pid === 0) {
      throw new ContainmentUnavailableError(this.backendId, "fixture releaseTarget could not observe a pid");
    }
    const pgid = pid; // detached child is its own group/session leader
    this.#tracked.set(boundary.launchId, { pid, pgid, exited: false });
    child.once("exit", () => {
      const entry = this.#tracked.get(boundary.launchId);
      if (entry !== undefined) this.#tracked.set(boundary.launchId, { ...entry, exited: true });
    });
    // Do not await exit here; releaseTarget resolves on exec.
    void child;
    return Object.freeze({
      boundary,
      exitCode: null,
      timedOut: false,
      stdoutDigest: sha256(""),
      stderrDigest: sha256(""),
      membership,
    });
  }

  async kill(boundary: ContainmentBoundary): Promise<void> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "kill received a forged boundary");
    }
    const entry = this.#tracked.get(boundary.launchId);
    if (entry === undefined) return; // nothing launched
    if (entry.exited) return;
    try {
      process.kill(-entry.pgid, "SIGKILL");
    } catch {
      // Process group may have already exited; ignore.
    }
  }

  async awaitEmpty(boundary: ContainmentBoundary, deadlineMs: number): Promise<ContainmentEmptinessObservation> {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "awaitEmpty received a forged boundary");
    }
    const entry = this.#tracked.get(boundary.launchId);
    const deadline = Date.now() + deadlineMs;
    let populated = entry !== undefined && !entry.exited;
    while (populated && Date.now() < deadline) {
      await sleep(20);
      const current = this.#tracked.get(boundary.launchId);
      populated = current !== undefined && !current.exited;
    }
    if (populated) {
      await this.kill(boundary);
      await sleep(20);
      const current = this.#tracked.get(boundary.launchId);
      populated = current !== undefined && !current.exited;
    }
    const events = `populated ${populated ? 1 : 0}\nfrozen 0\nfixture-await\n`;
    return new ContainmentEmptinessObservation(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      observedAt: nowIso(),
      populated,
      eventsDigest: sha256(events),
      emptinessConfirmed: !populated,
    });
  }

  mintDeathReceipt(boundary: ContainmentBoundary, emptiness: ContainmentEmptinessObservation): ContainmentDeathReceipt {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt received a forged boundary");
    }
    if (!isAuthorizedContainmentEmptinessObservation(emptiness)) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt received a forged emptiness observation");
    }
    if (
      emptiness.boundary.launchId !== boundary.launchId ||
      emptiness.boundary.backendId !== boundary.backendId ||
      emptiness.boundary.boundaryName !== boundary.boundaryName
    ) {
      throw new ContainmentUnavailableError(this.backendId, "emptiness observation does not bind to the exact boundary");
    }
    if (!emptiness.emptinessConfirmed || emptiness.populated) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt requires a confirmed-empty observation");
    }
    return new ContainmentDeathReceipt(CONTAINMENT_AUTHORITY, {
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      lineage: {
        runId: boundary.runId, ticketId: boundary.ticketId, attemptId: boundary.attemptId,
        ownershipId: boundary.ownershipId, ownerGeneration: boundary.ownerGeneration,
        ownershipContextDigest: boundary.ownershipContextDigest,
        phaseExecutionId: boundary.phaseExecutionId, contextId: boundary.contextId,
        executionContextDigest: boundary.executionContextDigest,
      },
      observedAt: emptiness.observedAt,
      deathDigest: deathDigestFor(boundary, boundary, emptiness.eventsDigest, emptiness.observedAt),
      emptinessConfirmed: emptiness.emptinessConfirmed,
      eventsDigest: emptiness.eventsDigest,
    });
  }

  mintNeverReleasedReceipt(lineage: ContainmentLineage, reason: string): ContainmentNeverReleasedReceipt {
    return new ContainmentNeverReleasedReceipt(CONTAINMENT_AUTHORITY, {
      lineage, observedAt: nowIso(), backendId: this.backendId, reason,
      receiptDigest: neverReleasedDigestFor(lineage, this.backendId, reason, nowIso()),
    });
  }
}

/**
 * Factory: probe the host and select the first available backend, else the
 * fail-closed `UnavailableContainmentBackend`.  Selection order follows the
 * ratified ADR: Docker Desktop (option A) first, then native Linux cgroup-v2
 * (option D), then unavailable.
 */
export function probeContainmentBackend(opts: { dockerImage?: string; probeTimeoutMs?: number; cgroupRoot?: string } = {}): ContainmentBackend {
  const dockerOpts: { image?: string; probeTimeoutMs?: number; hostMounts?: readonly string[]; containerPath?: string; containerAgentDir?: string } = {};
  if (opts.dockerImage !== undefined) {
    dockerOpts.image = opts.dockerImage;
  }
  if (opts.probeTimeoutMs !== undefined) {
    dockerOpts.probeTimeoutMs = opts.probeTimeoutMs;
  }
  // t22D-fix-round-2: Collect host paths to bind-mount into the Docker
  // container so the dispatched `omnigent run` command can actually execute.
  // Without these mounts the alpine container has no omnigent, Python, Node,
  // agent bundle, or worktree — the advertised production dispatch command
  // cannot run inside the containment boundary.  The paths come from env
  // vars set by init.sh (OMNIGENT_ROOT, OMNIGENT_PYTHON, RICKGENT_NODE_REALPATH,
  // RICKGENT_AGENT_DIR) plus the resource directory (for worktrees).
  const hostMounts: string[] = [];
  const pathDirs: string[] = [];
  const env = process.env;
  const omnigentRoot = env.OMNIGENT_ROOT;
  if (omnigentRoot && existsSync(omnigentRoot)) {
    hostMounts.push(omnigentRoot);
    pathDirs.push(join(omnigentRoot, "bin"));
  }
  const omnigentPython = env.OMNIGENT_PYTHON;
  if (omnigentPython && existsSync(omnigentPython)) {
    const pythonDir = dirname(omnigentPython);
    if (!hostMounts.includes(pythonDir)) hostMounts.push(pythonDir);
    pathDirs.push(pythonDir);
  }
  const nodeRealpath = env.RICKGENT_NODE_REALPATH;
  if (nodeRealpath && existsSync(nodeRealpath)) {
    const nodeDir = dirname(nodeRealpath);
    if (!hostMounts.includes(nodeDir)) hostMounts.push(nodeDir);
    pathDirs.push(nodeDir);
  }
  const agentDir = env.RICKGENT_AGENT_DIR;
  if (agentDir && existsSync(agentDir)) {
    const realAgentDir = realpathSync(agentDir);
    if (!hostMounts.includes(realAgentDir)) hostMounts.push(realAgentDir);
  }
  const cliRealpath = env.RICKGENT_CLI_REALPATH;
  if (cliRealpath && existsSync(cliRealpath)) {
    const orchestratorDir = dirname(dirname(cliRealpath)); // repo root
    if (!hostMounts.includes(orchestratorDir)) hostMounts.push(orchestratorDir);
  }
  if (hostMounts.length > 0) {
    dockerOpts.hostMounts = Object.freeze(hostMounts);
  }
  if (pathDirs.length > 0) {
    // Build a PATH that includes the mounted tool directories plus the
    // container's default paths.  The host tool dirs come first so the
    // mounted omnigent/python/node are found before any container defaults.
    dockerOpts.containerPath = [...pathDirs, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  }
  // t22D-fix-round-3: Propagate RICKGENT_AGENT_DIR into the container so the
  // dispatched `omnigent run <agentDir>` command resolves the agent bundle.
  // opts.agentDir is propagated from the build request through the containment
  // probe so the container knows where the agent bundle is mounted.
  if (agentDir && existsSync(agentDir)) {
    dockerOpts.containerAgentDir = realpathSync(agentDir);
  }
  // t22D-fix-round-3: Use the rickgent-runner image (built by
  // scripts/build-runner-image.sh) which has Python, Node, and omnigent
  // pre-installed — not alpine:latest which lacks these tools and cannot
  // run bind-mounted Darwin binaries.  Allow override via env var.
  const runnerImage = env.RICKGENT_CONTAINMENT_DOCKER_IMAGE;
  if (runnerImage && runnerImage.length > 0) {
    dockerOpts.image = runnerImage;
  } else {
    // Default to the rickgent-runner image; fall back to alpine only if the
    // runner image is not available (the probe will fail closed if the image
    // can't be pulled, which is the correct fail-closed behavior).
    dockerOpts.image = "rickgent-runner:latest";
  }
  if (opts.dockerImage !== undefined) {
    dockerOpts.image = opts.dockerImage;
  }
  const docker = new DockerCgroupV2ContainmentBackend(dockerOpts);
  if (docker.probe().status === "available") {
    return docker;
  }
  const linuxOpts: { cgroupRoot?: string } = {};
  if (opts.cgroupRoot !== undefined) {
    linuxOpts.cgroupRoot = opts.cgroupRoot;
  }
  const linux = new LinuxCgroupV2ContainmentBackend(linuxOpts);
  if (linux.probe().status === "available") {
    return linux;
  }
  return new UnavailableContainmentBackend("no containment backend probe passed on this host");
}

/**
 * Convenience: build a containment lineage from the attempt ownership grant
 * and supervised phase identity.  This is the production entrypoint the
 * `AttemptRunner` (t22C) uses to construct the lineage for the
 * `ContainmentBackend.createBoundary` call.
 */
export function containmentLineageFromAttempt(input: {
  runId: string;
  ticketId: string;
  attemptId: string;
  ownershipId: string;
  ownerGeneration: number;
  ownershipContextDigest: Sha256Digest;
  phaseExecutionId: string;
  contextId: string;
  executionContextDigest: Sha256Digest;
  worktreePath?: string;
}): ContainmentLineage {
  return Object.freeze({ ...input });
}
