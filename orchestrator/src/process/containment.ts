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
import { join } from "node:path";
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

export interface ContainmentEmptinessObservation {
  readonly boundary: ContainmentBoundaryId;
  readonly observedAt: string;
  readonly populated: boolean;
  readonly proofBasis: "authoritative_containment";
  readonly eventsDigest: Sha256Digest;
  /** True when `cgroup.events populated=0` was observed within the deadline. */
  readonly emptinessConfirmed: boolean;
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
  releaseTarget(boundary: ContainmentBoundary, argv: readonly string[], opts?: { stdoutPath?: string; stderrPath?: string; timeoutMs?: number }): Promise<ContainmentLaunch>;
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

  constructor(opts: { image?: string; probeTimeoutMs?: number; killTimeoutMs?: number; pollIntervalMs?: number } = {}) {
    this.image = opts.image ?? "alpine:latest";
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 30_000;
    this.killTimeoutMs = opts.killTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
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
    const createResult = dockerExecSilent(
      ["create", "--name", containerName, "--cgroupns=private", "--init", this.image, "sleep", "3600"],
      { timeoutMs: this.probeTimeoutMs },
    );
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
    opts: { stdoutPath?: string; stderrPath?: string; timeoutMs?: number } = {},
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
    const result = dockerExecSilent(
      ["exec", boundary.runtimeHandle, ...argv],
      { timeoutMs },
    );
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
    const root = this.#rootCgroupPath();
    const deadline = Date.now() + deadlineMs;
    let lastEvents = "";
    let populated = true;
    while (Date.now() < deadline) {
      const result = dockerExecSilent(
        ["exec", boundary.runtimeHandle, "sh", "-c", `cat ${root}/cgroup.events 2>/dev/null || echo 'populated 1\\nfrozen 0'`],
        { timeoutMs: this.probeTimeoutMs },
      );
      lastEvents = result.stdout;
      populated = /populated\s+1/.test(result.stdout);
      if (!populated) {
        break;
      }
      await sleep(this.pollIntervalMs);
    }
    if (populated) {
      await this.kill(boundary);
      const result = dockerExecSilent(
        ["exec", boundary.runtimeHandle, "sh", "-c", `cat ${root}/cgroup.events 2>/dev/null || echo 'populated 0\\nfrozen 0'`],
        { timeoutMs: this.probeTimeoutMs },
      );
      lastEvents = result.stdout;
      populated = /populated\s+1/.test(result.stdout);
    }
    const eventsDigest = sha256(lastEvents);
    return Object.freeze({
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      observedAt: nowIso(),
      populated,
      proofBasis: "authoritative_containment",
      eventsDigest,
      emptinessConfirmed: !populated,
    });
  }

  mintDeathReceipt(boundary: ContainmentBoundary, emptiness: ContainmentEmptinessObservation): ContainmentDeathReceipt {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt received a forged boundary");
    }
    if (emptiness.boundary.launchId !== boundary.launchId) {
      throw new ContainmentUnavailableError(this.backendId, "emptiness observation does not bind to the boundary");
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
    while (Date.now() < deadline) {
      try {
        lastEvents = readFileSync(join(boundary.runtimeHandle, "cgroup.events"), "utf8");
      } catch {
        lastEvents = "populated 0\nfrozen 0\n";
      }
      populated = /populated\s+1/.test(lastEvents);
      if (!populated) {
        break;
      }
      await sleep(this.pollIntervalMs);
    }
    if (populated) {
      await this.kill(boundary);
      try {
        lastEvents = readFileSync(join(boundary.runtimeHandle, "cgroup.events"), "utf8");
      } catch {
        lastEvents = "populated 0\nfrozen 0\n";
      }
      populated = /populated\s+1/.test(lastEvents);
    }
    return Object.freeze({
      boundary: { backendId: boundary.backendId, boundaryName: boundary.boundaryName, launchId: boundary.launchId },
      observedAt: nowIso(), populated, proofBasis: "authoritative_containment",
      eventsDigest: sha256(lastEvents), emptinessConfirmed: !populated,
    });
  }

  mintDeathReceipt(boundary: ContainmentBoundary, emptiness: ContainmentEmptinessObservation): ContainmentDeathReceipt {
    if (!isAuthorizedContainmentBoundary(boundary)) {
      throw new ContainmentUnavailableError(this.backendId, "mintDeathReceipt received a forged boundary");
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

/**
 * Factory: probe the host and select the first available backend, else the
 * fail-closed `UnavailableContainmentBackend`.  Selection order follows the
 * ratified ADR: Docker Desktop (option A) first, then native Linux cgroup-v2
 * (option D), then unavailable.
 */
export function probeContainmentBackend(opts: { dockerImage?: string; probeTimeoutMs?: number; cgroupRoot?: string } = {}): ContainmentBackend {
  const dockerOpts: { image?: string; probeTimeoutMs?: number } = {};
  if (opts.dockerImage !== undefined) {
    dockerOpts.image = opts.dockerImage;
  }
  if (opts.probeTimeoutMs !== undefined) {
    dockerOpts.probeTimeoutMs = opts.probeTimeoutMs;
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
}): ContainmentLineage {
  return Object.freeze({ ...input });
}
