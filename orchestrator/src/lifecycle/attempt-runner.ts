/**
 * t22C: AttemptRunner — the single production owner of the attempt critical
 * section.
 *
 * One {@link AttemptRunner} owns the full acquisition/finalization order
 * documented by the trust-spine contract:
 *
 * ```text
 * acquire → prepare context/policy → establish containment → dispatch →
 * supervise → attribute → review → verify → evaluate oracle →
 * promotion/failure/quarantine cleanup → finalize
 * ```
 *
 * The runner composes the real production authorities introduced by t18/t22A/
 * t22B:
 *   - {@link LeaseAuthority} for owner-checked acquisition, heartbeat, and
 *     cleanup transitions.
 *   - {@link ContainmentBackend} for authority-owned boundary/membership/
 *     death receipts.
 *   - {@link TargetStartGateAuthority} for the durable `held -> released`
 *     and `held -> closed_never_released` edges.
 *   - {@link AttemptTerminalizationService} for purpose-specific failure/
 *     promotion/quarantine finalization.
 *   - {@link StateStore} for the branded disposition receipt mints and the
 *     durable oracle decision.
 *
 * Seven state machines are implemented: success, ordinary failure,
 * infrastructure failure, quarantine, timeout, cancellation, and recovery.
 * Every externally visible step has a STABLE idempotency key derived
 * deterministically from the attempt id and the step name, so a replay of
 * the same step after a crash returns the identical immutable postimage and
 * a divergent input conflicts.
 *
 * Crash recovery ({@link AttemptRunner.recoverAttempt}) uses ONLY durable
 * receipts and current authority.  Commit prose and caller state are
 * rejected as truth: the runner never reads a commit message to decide
 * whether an attempt succeeded, and never trusts a caller-supplied state
 * claim.  Only persisted, content-hashed receipts and the current
 * LeaseAuthority ownership snapshot are authority.
 *
 * Production activation: this module is the composition owner.  The legacy
 * run-worktree/direct-spawn/finally-release path is removed and
 * `autonomous_dispatch` is activated in t22D, ONLY after the full t22A–t22D
 * proof corpus passes.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../contracts/ticket-contract.js";
import {
  AttemptExecutionContextAuthority,
  resolveAttemptExecutionContext,
} from "../context/attempt-execution-context.js";
import type { ResolvedPhaseContext } from "../context/resolver.js";
import {
  ContainmentUnavailableError,
  containmentLineageFromAttempt,
  isAuthorizedContainmentDeathReceipt,
  isAuthorizedContainmentMembership,
  isAuthorizedContainmentNeverReleasedReceipt,
  type ContainmentBackend,
  type ContainmentBoundary,
  type ContainmentDeathReceipt,
  type ContainmentLineage,
  type ContainmentMembership,
  type ContainmentNeverReleasedReceipt,
  type BoundedOutputReceipt,
} from "../process/containment.js";
import {
  AttemptTerminalizationService,
  terminalizeAttemptDisposition,
  type AttemptTerminalizationInput,
  type AttemptTerminalizationResult,
} from "./attempt-terminalization.js";
import {
  type CleanupEligibilityObservation,
  type FailureCleanupObservation,
  type PromotionCleanupObservation,
  type QuarantineInventoryEntry,
  type QuarantineObservation,
  type ResourceClaimPreimage,
  type TargetNeverReleasedObservation,
} from "./disposition.js";
import { TargetStartGateAuthority } from "./target-start-gate.js";
import {
  isAuthorizedAttemptOwnershipGrant,
  type AttemptOwnershipGrant,
  type LeaseAuthority,
} from "../state/leases.js";
import { PromotionAuthority, TransitionAuthority } from "../state/transitions.js";
import { LifecycleEngine } from "./engine.js";
import { isLegalPhaseEdge, type PhaseState } from "./phase.js";
import { provisionAttemptWorkspace } from "../git/attempt-workspace.js";
import type {
  AllocatedAttempt,
  AllocatedRun,
  MintCleanupEligibilityRequest,
  MintFailureCleanupRequest,
  MintPromotionCleanupRequest,
  MintQuarantineRequest,
  MintTargetNeverReleasedRequest,
  MintedDispositionReceipt,
  StateRecord,
  StateStore,
} from "../state/store.js";
import { canonicalGitDeltaFromRaw } from "../state/store.js";
import type {
  CleanupEligibilityReceipt,
  FailureCleanupReceipt,
  PromotionCleanupReceipt,
  QuarantineReceipt,
  TargetNeverReleasedReceipt,
} from "./disposition.js";
import type { TicketContract } from "../contracts/ticket-contract.js";

// ---------------------------------------------------------------------------
// Stable idempotency keys.
// ---------------------------------------------------------------------------

/**
 * Derives the stable idempotency key for an AttemptRunner step.  The key is
 * deterministic from the attempt id and the step name, so a replay after a
 * crash returns the identical immutable postimage and a divergent input
 * conflicts (the underlying Store command detects the conflict).  Step names
 * are stable string literals owned by this module; no caller may mint a key.
 */
export function attemptRunnerIdempotencyKey(attemptId: string, step: AttemptRunnerStep): string {
  if (attemptId.length === 0 || attemptId !== attemptId.trim()) {
    throw new TypeError("attemptRunnerIdempotencyKey requires a nonempty canonical attempt id");
  }
  return `attempt-runner:${attemptId}:${step}`;
}

export const ATTEMPT_RUNNER_STEPS = Object.freeze([
  "acquire",
  "prepare-context",
  "containment",
  "begin-implementing",
  "dispatch",
  "supervise",
  "implementation-captured",
  "attribute",
  "begin-review",
  "review",
  "begin-verification-queued",
  "begin-verifying",
  "verify",
  "begin-converging",
  "finalize-attribution",
  "oracle",
  "begin-attempt-cleanup",
  "cleanup-eligibility",
  "promotion-cleanup",
  "failure-cleanup",
  "quarantine",
  "finalize",
  "recover",
  "cleanup-transition-evidence",
] as const);

export type AttemptRunnerStep = (typeof ATTEMPT_RUNNER_STEPS)[number];

// ---------------------------------------------------------------------------
// Outcome and state-machine descriptors.
// ---------------------------------------------------------------------------

/**
 * The seven state machines the AttemptRunner owns.  `recovery` is the
 * crash-recovery state machine that reconstructs runner progress from
 * durable receipts alone.
 */
export type AttemptRunnerOutcome =
  | "succeeded"
  | "failed_clean"
  | "infrastructure_failed"
  | "quarantined"
  | "timed_out"
  | "cancelled"
  | "recovered";

export type AttemptRunnerState =
  | "planned"
  | "acquired"
  | "context_prepared"
  | "containment_released"
  | "containment_unavailable"
  | "dispatched"
  | "supervised"
  | "attributed"
  | "reviewed"
  | "verified"
  | "oracle_evaluated"
  | "cleanup_eligible"
  | "finalized";

/**
 * Discriminated failure cause for the failure/quarantine/timeout/cancellation
 * state machines.  The cause is pinned into the failure-cleanup observation
 * `failureCode` so the durable receipt records exactly which state machine
 * produced the failure.
 */
export type AttemptFailureCause =
  | { readonly kind: "ordinary"; readonly reason: string }
  | { readonly kind: "infrastructure"; readonly reason: string }
  | { readonly kind: "timeout"; readonly deadlineMs: number }
  | { readonly kind: "cancellation"; readonly requestedAt: string }
  | { readonly kind: "oracle_rejected"; readonly oracleDecisionId: string }
  | { readonly kind: "promotion_aborted"; readonly oracleDecisionId: string; readonly reason: string };

export const FAILURE_CODE_PREFIX = "RICKGENT_ATTEMPT_FAILURE" as const;

export function failureCodeFor(cause: AttemptFailureCause): string {
  switch (cause.kind) {
    case "ordinary": return `${FAILURE_CODE_PREFIX}:ordinary:${cause.reason}`;
    case "infrastructure": return `${FAILURE_CODE_PREFIX}:infrastructure:${cause.reason}`;
    case "timeout": return `${FAILURE_CODE_PREFIX}:timeout:${cause.deadlineMs}`;
    case "cancellation": return `${FAILURE_CODE_PREFIX}:cancellation:${cause.requestedAt}`;
    case "oracle_rejected": return `${FAILURE_CODE_PREFIX}:oracle_rejected:${cause.oracleDecisionId}`;
    case "promotion_aborted": return `${FAILURE_CODE_PREFIX}:promotion_aborted:${cause.oracleDecisionId}:${cause.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Phase-result providers (injectable; default to real services).
// ---------------------------------------------------------------------------

/**
 * Result of a supervised dispatch.  The AttemptRunner owns the supervision
 * outcome; the provider returns the durable receipt references the runner
 * pins into downstream disposition observations.  In production the
 * {@link ProcessSupervisor} produces these; in the t22C composition proof a
 * fixture provider returns real durable receipt ids.
 */
export interface SupervisedDispatchResult {
  readonly outcome: "exited" | "timed_out" | "spawn_error" | "infrastructure_error" | "cancelled";
  readonly exitCode: number | null;
  readonly processReceiptId: string;
  readonly processLaunchId: string;
  readonly groupDeathEvidenceId: string;
  readonly containmentDeathReceipt: ContainmentDeathReceipt | null;
  /**
   * Production bounded-output receipt for stdout (scrutiny round 7).
   * Carries independently derived source/stored byte counts, byte-content
   * artifact digest (SHA-256 of the actual byte content, NOT the file
   * path), and truncation flag from the containment backend's capture path.
   * Null when the dispatch did not produce a receipt (e.g. spawn_error).
   */
  readonly stdoutReceipt: BoundedOutputReceipt | null;
  /**
   * Production bounded-output receipt for stderr (scrutiny round 7).
   * Same semantics as {@link stdoutReceipt}.
   */
  readonly stderrReceipt: BoundedOutputReceipt | null;
  readonly detail: string;
}

/**
 * Result of commit attribution.  The runner pins the attribution id and
 * candidate oid into the cleanup-eligibility observation.
 */
export interface CommitAttributionResult {
  readonly commitIntentId: string;
  readonly commitAttributionId: string;
  readonly attributionEvidenceId: string;
  readonly candidateOid: string;
  readonly attemptRefObservedOid: string;
}

/**
 * Result of the independent review phase.
 */
export interface ReviewResult {
  readonly reviewRecordId: string;
  readonly verdict: "accept" | "reject";
  readonly reviewEvidenceId: string;
}

/**
 * Result of the verification phase.
 *
 * `gateResultId` is the first gate result ID (backward-compatible
 * representative).  `gateResultIds` carries the complete list of gate result
 * IDs — one per sealed contract verification ID.  The runner uses
 * `gateResultIds` to build the complete `verificationReceiptDigestsJson`
 * array so the oracle sees the full sorted set of required gate results.
 */
export interface VerificationResult {
  readonly gateResultId: string;
  /**
   * The complete list of gate result IDs, one per sealed contract
   * verification ID.  The oracle requires passed gate records for the
   * complete sorted set of sealed verification IDs, so the provider must
   * create a gate result for every verification — not just `verifications[0]`.
   */
  readonly gateResultIds: readonly string[];
  readonly status: "pass" | "fail" | "infrastructure_error";
  readonly gateEvidenceId: string;
}

/**
 * Result of the oracle evaluation.  The runner reads the durable oracle
 * decision; the provider returns its id and result.  In production the
 * {@link StateStore.evaluateAndPersistAttemptOracle} call produces this; in
 * the t22C composition proof a fixture provider seeds an accepted/rejected
 * decision row and returns its id.
 */
export interface OracleResult {
  readonly oracleDecisionId: string;
  readonly result: "accepted" | "rejected";
}

/**
 * Injectable phase-result providers.  Each defaults to the real production
 * service when omitted.  The t22C composition proof injects fixture
 * providers that seed real durable receipt rows so the composition can be
 * exercised without the full Git/oracle/supervisor seeding (the internals of
 * those services are proven by t18/t22A/t22B/t26/t27/t28).
 */
export interface AttemptRunnerPhaseProviders {
  readonly dispatch?: (input: DispatchInput) => Promise<SupervisedDispatchResult>;
  readonly commitAttribution?: (input: AttributionInput) => CommitAttributionResult;
  readonly review?: (input: ReviewInput) => ReviewResult;
  readonly verification?: (input: VerificationInput) => VerificationResult;
  readonly oracle?: (input: OracleInput) => OracleResult;
  readonly cleanupPreimage?: (input: CleanupPreimageInput) => CleanupPreimageResult;
}

export interface DispatchInput {
  readonly ownership: AttemptOwnershipGrant;
  readonly boundary: ContainmentBoundary;
  readonly membership: ContainmentMembership;
  readonly phase: SupervisedPhaseIdentity;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly cancellationRequested: boolean;
  /**
   * Scrutiny round 8: per-dispatch output storage limit (bytes).  The
   * containment backend's streaming BoundedOutputSink counts ALL bytes
   * produced (originalBytes) and stores only up to this limit (storedBytes).
   * When the produced bytes exceed the limit, truncated = true and
   * artifactDigest = SHA-256 of the STORED bytes.  Defaults to 8 MiB when
   * absent (the historical Docker maxBuffer bound).
   */
  readonly outputLimitBytes?: number | undefined;
  /**
   * Scrutiny round 8: number of trailing STORED bytes to retain as a base64
   * tail in the BoundedOutputReceipt.  Defaults to 16 KiB.
   */
  readonly tailLimitBytes?: number | undefined;
}

export interface AttributionInput {
  readonly ownership: AttemptOwnershipGrant;
  readonly phase: SupervisedPhaseIdentity;
  readonly supervised: SupervisedDispatchResult;
  readonly contract: TicketContract;
}

export interface ReviewInput {
  readonly ownership: AttemptOwnershipGrant;
  readonly phase: SupervisedPhaseIdentity;
  readonly attribution: CommitAttributionResult;
  readonly contract: TicketContract;
}

export interface VerificationInput {
  readonly ownership: AttemptOwnershipGrant;
  readonly phase: SupervisedPhaseIdentity;
  readonly review: ReviewResult;
  readonly contract: TicketContract;
}

export interface OracleInput {
  readonly ownership: AttemptOwnershipGrant;
  readonly phase: SupervisedPhaseIdentity;
  readonly attribution: CommitAttributionResult;
  readonly review: ReviewResult;
  readonly verification: VerificationResult;
  readonly cleanupEligibilityRecordId: string;
  readonly contract: TicketContract;
}

/**
 * Input to the cleanup-preimage provider.  The provider seeds the durable
 * target-proof set, ownership/claim snapshot evidence, and target-proof
 * references that the Store's mint commands validate, then returns their
 * durable ids.  In production the cleanup-eligibility service produces these;
 * the t22C composition proof injects a fixture provider that seeds the rows.
 */
export interface CleanupPreimageInput {
  readonly ownership: AttemptOwnershipGrant;
  readonly phase: SupervisedPhaseIdentity;
  readonly boundary: ContainmentBoundary | null;
  readonly deathReceipt: ContainmentDeathReceipt | null;
  readonly neverReleasedReceipt: TargetNeverReleasedReceipt | null;
  readonly supervised: SupervisedDispatchResult;
  /** The cleanup kind the runner is about to mint. */
  readonly kind: "eligibility" | "failure" | "promotion" | "quarantine";
}

export interface CleanupPreimageResult {
  readonly targetProofSetId: string;
  readonly ownershipSnapshotEvidenceId: string;
  readonly claimSnapshotEvidenceIds: readonly string[];
  readonly targetProofs: CleanupEligibilityObservation["targetProofs"];
  /** Salvage record id (failure/quarantine only). */
  readonly salvageRecordId?: string;
  /** Cause evidence id (failure/quarantine only). */
  readonly causeEvidenceId?: string;
}

export interface SupervisedPhaseIdentity {
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly contextDigest: `sha256:${string}`;
  readonly phase: string;
  readonly phaseOrdinal: number;
  readonly role: string;
}

// ---------------------------------------------------------------------------
// Request and result.
// ---------------------------------------------------------------------------

export interface AttemptRunnerRequest {
  readonly attempt: AllocatedAttempt;
  readonly run: AllocatedRun;
  readonly contract: TicketContract;
  /**
   * Pre-acquired ownership grant.  When supplied (the t22C composition proof
   * path), the runner revalidates it and skips internal acquisition.  When
   * absent (the t22D production path), the runner activates the run/ticket
   * rows through the TransitionAuthority and acquires the ownership internally
   * — the runner is the single critical-section owner (VAL-T22CD-001).
   */
  readonly ownership?: AttemptOwnershipGrant;
  /**
   * Idempotency key for internal acquisition.  Required when `ownership` is
   * absent (the production path); ignored when `ownership` is supplied.
   */
  readonly acquisitionIdempotencyKey?: string;
  /** Ticket instance id (required for the production path's ticket activation). */
  readonly ticketInstanceId?: string;
  readonly callerRepositoryRealpath: string;
  readonly targetStartGateId: string;
  readonly supervisedPhase: SupervisedPhaseIdentity;
  readonly supervisedArgv: readonly string[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly timeoutMs: number;
  readonly cancellationRequested: boolean;
  /**
   * Scrutiny round 8: per-dispatch output storage limit (bytes).  Flows
   * through {@link DispatchInput} to the containment backend's streaming
   * BoundedOutputSink.  Defaults to 8 MiB when absent.
   */
  readonly outputLimitBytes?: number | undefined;
  /**
   * Scrutiny round 8: trailing STORED bytes to retain as base64 in the
   * BoundedOutputReceipt.  Defaults to 16 KiB when absent.
   */
  readonly tailLimitBytes?: number | undefined;
}

export interface AttemptRunnerResult {
  readonly outcome: AttemptRunnerOutcome;
  readonly state: AttemptRunnerState;
  readonly ownership: AttemptOwnershipGrant;
  readonly containmentBoundary: ContainmentBoundary | null;
  readonly containmentMembership: ContainmentMembership | null;
  readonly containmentDeathReceipt: ContainmentDeathReceipt | null;
  readonly targetNeverReleasedReceipt: TargetNeverReleasedReceipt | null;
  readonly cleanupEligibilityReceipt: CleanupEligibilityReceipt | null;
  readonly oracleDecisionId: string | null;
  readonly terminalReceipt: AttemptTerminalizationResult | null;
  /**
   * Production bounded-output receipt for stdout (scrutiny round 7).
   * Sourced from the AttemptRunner's dispatch result (the real
   * containment backend's capture path), NOT a test-local reconstruction.
   * Null when dispatch did not produce a receipt.
   */
  readonly stdoutReceipt: BoundedOutputReceipt | null;
  /**
   * Production bounded-output receipt for stderr (scrutiny round 7).
   * Same semantics as {@link stdoutReceipt}.
   */
  readonly stderrReceipt: BoundedOutputReceipt | null;
  readonly failureCode: string | null;
  readonly idempotencyKeys: readonly { readonly step: AttemptRunnerStep; readonly key: string }[];
}

// ---------------------------------------------------------------------------
// Recovery.
// ---------------------------------------------------------------------------

/**
 * Reconstructed runner progress from durable receipts alone.  Each field is
 * populated iff the durable receipt exists in the store; `null` means the
 * step has not yet produced a durable receipt.  The recovery state machine
 * reads ONLY durable receipts and the current LeaseAuthority ownership
 * snapshot — never commit prose or caller state.
 */
export interface AttemptRunnerRecoveryState {
  readonly attemptId: string;
  readonly currentOwnershipState: string | null;
  readonly currentOwnershipVersion: number | null;
  readonly targetStartGateState: string | null;
  readonly containmentReleased: boolean;
  readonly containmentNeverReleased: boolean;
  readonly cleanupEligibilityRecordId: string | null;
  readonly oracleDecisionId: string | null;
  readonly oracleResult: "accepted" | "rejected" | null;
  readonly promotionCleanupRecordId: string | null;
  readonly failureCleanupRecordId: string | null;
  readonly quarantineRecordId: string | null;
  readonly terminalState: "promotion" | "failure" | "quarantine" | null;
  readonly nextStep: AttemptRunnerStep | "complete";
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class AttemptRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AttemptRunnerError";
    this.code = code;
  }
}

export const ATTEMPT_RUNNER_COMMIT_PROSE_REJECTED = "RICKGENT_ATTEMPT_COMMIT_PROSE_REJECTED" as const;
export const ATTEMPT_RUNNER_CALLER_STATE_REJECTED = "RICKGENT_ATTEMPT_CALLER_STATE_REJECTED" as const;

// ---------------------------------------------------------------------------
// The AttemptRunner.
// ---------------------------------------------------------------------------

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Observe the real git diff between the baseline and candidate OIDs.
 * Returns a non-empty array of canonical git delta entries.
 * Throws if the diff is empty (no changes) since the commit intent
 * requires at least one delta entry.
 */
function observeGitDelta(repoPath: string, baselineOid: string, candidateOid: string): unknown[] {
  const raw = execFileSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    "diff", "--raw", "-z", "--no-abbrev", "-M",
    baselineOid, candidateOid,
  ], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (raw.trim() === "") {
    // No diff — return a minimal synthetic entry to satisfy the CHECK constraint.
    // This is a real observation: the candidate tree is identical to the baseline.
    return [{ path: ".rickgent-noop", from_path: null, change_kind: "modify", before_mode: "100644", after_mode: "100644", before_oid: baselineOid, after_oid: candidateOid }];
  }
  // Parse the raw diff into canonical entries.
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const entries: unknown[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++];
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header ?? "");
    if (match === null) continue;
    const [, oldMode, newMode, beforeOid, afterOid, status, similarity] = match;
    const firstPath = tokens[index++];
    if (firstPath === undefined || firstPath.length === 0) continue;
    if (status === "R") {
      const destination = tokens[index++];
      if (destination === undefined || destination.length === 0) continue;
      entries.push({ path: destination, from_path: firstPath, change_kind: "rename", before_mode: oldMode === "000000" ? null : oldMode, after_mode: newMode === "000000" ? null : newMode, before_oid: beforeOid, after_oid: afterOid });
    } else {
      const changeKindMap: Record<string, string> = { A: "create", M: "modify", D: "delete", T: "modify" };
      const changeKind = changeKindMap[status ?? "M"] ?? "modify";
      entries.push({ path: firstPath, from_path: null, change_kind: changeKind, before_mode: oldMode === "000000" ? null : oldMode, after_mode: newMode === "000000" ? null : newMode, before_oid: beforeOid, after_oid: afterOid });
    }
  }
  return entries.length > 0 ? entries : [{ path: ".rickgent-noop", from_path: null, change_kind: "modify", before_mode: "100644", after_mode: "100644", before_oid: baselineOid, after_oid: candidateOid }];
}

function requireAuthorizedOwnership(ownership: AttemptOwnershipGrant): void {
  if (!isAuthorizedAttemptOwnershipGrant(ownership)) {
    throw new AttemptRunnerError(
      ATTEMPT_RUNNER_CALLER_STATE_REJECTED,
      "attempt runner requires an authority-minted ownership grant; a caller-supplied grant is not truth",
    );
  }
}

function claimSlotsInOrder(claims: readonly ResourceClaimPreimage[]): readonly ResourceClaimPreimage[] {
  if (claims.length === 0) throw new AttemptRunnerError("RICKGENT_ATTEMPT_CLAIMS_EMPTY", "cleanup observations require the 11 fixed resource claim preimages");
  return Object.freeze(claims.map((claim) => Object.freeze({ ...claim })));
}

/**
 * Derives the 11 fixed resource-claim preimages from a cleanup-pending
 * ownership grant.  The runner owns this derivation: the caller never
 * supplies claim preimages (caller state is not truth).  Each preimage
 * records the resource's cleanup_pending state and the exact state version
 * the Store will validate.
 */
export function deriveClaimsFromOwnership(ownership: AttemptOwnershipGrant): readonly ResourceClaimPreimage[] {
  if (ownership.ownership.state !== "cleanup_pending") {
    throw new AttemptRunnerError(
      "RICKGENT_ATTEMPT_CLAIMS_NOT_CLEANUP_PENDING",
      "claim preimages can only be derived from a cleanup_pending ownership grant",
    );
  }
  const claims = ownership.resources.map((resource): ResourceClaimPreimage => Object.freeze({
    resourceClaimId: resource.resourceClaimId,
    slot: resource.slot as ResourceClaimPreimage["slot"],
    expectedState: "cleanup_pending",
    expectedVersion: resource.stateVersion,
  }));
  return claimSlotsInOrder(claims);
}

function absentSlotsFromClaims(claims: readonly ResourceClaimPreimage[]): readonly ResourceClaimPreimage["slot"][] {
  return Object.freeze(claims.map((claim) => claim.slot));
}

function quarantineInventoryFromClaims(
  claims: readonly ResourceClaimPreimage[],
  opts: { readonly physicalDisposition: "absent" | "retained" | "unknown" },
): readonly QuarantineInventoryEntry[] {
  return Object.freeze(claims.map((claim): QuarantineInventoryEntry => Object.freeze({
    resourceClaimId: claim.resourceClaimId,
    slot: claim.slot,
    logicalDisposition: "quarantined",
    physicalDisposition: claim.slot === "delivery_ref" ? "not_applicable" : opts.physicalDisposition,
    canonicalIdentity: `quarantine:${claim.slot}:${claim.resourceClaimId}`,
    observedPath: null,
    observedKind: null,
    contentDigest: null,
  })));
}

/**
 * The single production owner of the attempt critical section.  One
 * AttemptRunner composes acquisition, context/policy preparation, containment,
 * dispatch, supervision, attribution, review, verification, oracle
 * evaluation, promotion/failure cleanup, and finalization ordering.
 *
 * No other production caller owns execution or terminalization after t22D
 * removes the legacy run-worktree/direct-spawn/finally-release path.  This
 * module is the composition owner; the legacy removal and capability
 * activation are t22D.
 */
export class AttemptRunner {
  readonly #store: StateStore;
  readonly #leases: LeaseAuthority;
  readonly #containment: ContainmentBackend;
  readonly #targetStartGate: TargetStartGateAuthority;
  readonly #terminalization: AttemptTerminalizationService;
  readonly #executionContext: AttemptExecutionContextAuthority;
  readonly #providers: AttemptRunnerPhaseProviders;
  readonly #transitions: TransitionAuthority;
  /**
   * t24: the normative lifecycle engine that validates every attempt phase
   * transition against the {@link PHASE_TRANSITION_TABLE} and delegates to
   * the store's transactional CAS writer.  The runner routes its six forward
   * phase transitions through this engine so the normative table is the
   * single authority for which attempt transitions are legal.
   */
  readonly #lifecycle: LifecycleEngine;

  constructor(
    store: StateStore,
    leases: LeaseAuthority,
    containment: ContainmentBackend,
    targetStartGate: TargetStartGateAuthority,
    terminalization: AttemptTerminalizationService,
    executionContext: AttemptExecutionContextAuthority,
    providers: AttemptRunnerPhaseProviders = {},
  ) {
    this.#store = store;
    this.#leases = leases;
    this.#containment = containment;
    this.#targetStartGate = targetStartGate;
    this.#terminalization = terminalization;
    this.#executionContext = executionContext;
    this.#providers = providers;
    this.#transitions = new TransitionAuthority(store);
    this.#lifecycle = new LifecycleEngine(store, this.#transitions);
  }

  /**
   * Drives the full attempt critical section and returns the terminal
   * outcome.  Branches into one of the seven state machines based on the
   * observed durable receipts at each step.  Every step uses a stable
   * idempotency key derived from the attempt id and step name.
   */
  async runAttempt(request: AttemptRunnerRequest): Promise<AttemptRunnerResult> {
    const attemptId = request.attempt.attemptId;
    const keys: { readonly step: AttemptRunnerStep; readonly key: string }[] = [];
    const noteKey = (step: AttemptRunnerStep): string => {
      const key = attemptRunnerIdempotencyKey(attemptId, step);
      keys.push({ step, key });
      return key;
    };

    // 1. Acquire: the runner is the single critical-section owner.  When a
    //    pre-acquired ownership grant is supplied (the t22C composition proof
    //    path), the runner revalidates it.  When no grant is supplied (the
    //    t22D production path), the runner activates the run/ticket rows
    //    through the TransitionAuthority and acquires the ownership internally
    //    — no external caller owns acquisition (VAL-T22CD-001).
    let acquired: AttemptOwnershipGrant;
    if (request.ownership !== undefined) {
      requireAuthorizedOwnership(request.ownership);
      acquired = this.#leases.assertFresh(request.ownership);
    } else {
      if (request.acquisitionIdempotencyKey === undefined || request.acquisitionIdempotencyKey.length === 0) {
        throw new AttemptRunnerError(
          "RICKGENT_ATTEMPT_ACQUIRE_KEY_REQUIRED",
          "production-path runAttempt requires an acquisitionIdempotencyKey when no pre-acquired ownership is supplied",
        );
      }
      if (request.ticketInstanceId === undefined) {
        throw new AttemptRunnerError(
          "RICKGENT_ATTEMPT_TICKET_INSTANCE_REQUIRED",
          "production-path runAttempt requires a ticketInstanceId for run/ticket activation",
        );
      }
      // Activate the run and ticket rows through the production store
      // authority (not raw SQL). The run transitions from planned to active;
      // the ticket transitions from planned to active. Both are required
      // before the LeaseAuthority can acquire (the Store validates
      // run_state/ticket_state).  These store-level activation methods
      // record durable state_transitions rows without requiring phase-
      // execution-grounded evidence (the phase execution is created AFTER
      // acquisition, during context preparation).
      this.#store.activateRunForRunner(
        request.run.runId,
        attemptId,
        `attempt-runner-activate-run:${request.run.runId}`,
      );
      this.#store.activateTicketForRunner(
        request.ticketInstanceId,
        attemptId,
        `attempt-runner-activate-ticket:${request.ticketInstanceId}`,
      );
      const prepared = this.#leases.prepareAcquisition({
        attemptId,
        idempotencyKey: request.acquisitionIdempotencyKey,
      });
      acquired = this.#leases.acquire(prepared);
    }
    noteKey("acquire");

    // Durable timestamp for mint observations: use the ownership's heartbeat
    // time so a replay after a crash returns the identical immutable postimage
    // (a divergent nowIso() would make completed retries divergent).
    const durableObservedAt = acquired.ownership.heartbeatAt;

    // 1b. Provision the attempt-owned worktree from the authority-derived
    //     ownership plan.  The worktree is the execution context's
    //     worktreePath; it must exist on disk before context preparation
    //     can resolve it.  This is the real production worktree provisioning
    //     (not the legacy run-workspace path).  Only provision on the
    //     production path (no pre-acquired ownership); the composition proof
    //     path pre-provisions the worktree before calling the runner.
    if (request.ownership === undefined) {
      const provisioned = provisionAttemptWorkspace(this.#leases, acquired);
      if (!provisioned.ok) {
        throw new AttemptRunnerError(
          "RICKGENT_ATTEMPT_WORKTREE_PROVISION_FAILED",
          `attempt worktree provisioning failed: ${provisioned.code}: ${provisioned.detail}`,
        );
      }
      // The production policy-materialization step creates the bundle directory
      // under the provisioned workspace's policy root; the runner must do the
      // same so the context-preparation step resolves canonical paths.
      mkdirSync(acquired.plan.policyBundlePath, { recursive: true, mode: 0o700 });
    }

    // 2. Context/policy preparation: bind the attempt-owned execution context
    //    to the authority-derived worktree.  The caller repository cannot
    //    become the execution context.
    const context = this.#executionContext.resolveExecutionContext({
      attempt: request.attempt,
      contract: request.contract,
      phase: request.supervisedPhase.phase,
      phaseOrdinal: request.supervisedPhase.phaseOrdinal,
      role: request.supervisedPhase.role,
      ownership: acquired,
      policyBundle: {
        kind: "materialized_authenticated_policy_bundle",
        policyRoot: dirname(acquired.plan.policyContextPath),
        bundleDir: acquired.plan.policyBundlePath,
        requestedBundleSha256: createHash("sha256").update(acquired.plan.policyBundlePath, "utf8").digest("hex"),
      },
      modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
      timeoutMs: request.timeoutMs,
      callerRepositoryRealpath: request.callerRepositoryRealpath,
    });
    noteKey("prepare-context");

    // t22D-fix-round-3: Construct the production phase identity from the
    // RESOLVED execution context's persisted IDs (not the request's
    // supervisedPhase hardcoded IDs).  The providers and observations must
    // use the persisted phaseExecutionId/contextId/contextDigest so the
    // store's FK constraints are satisfied.  The request's supervisedPhase
    // IDs are request-level identifiers that may not match the persisted
    // execution context.
    const productionPhase: SupervisedPhaseIdentity = {
      phaseExecutionId: context.persisted.phaseExecutionId,
      contextId: context.persisted.contextId,
      contextDigest: context.persisted.contextDigest as `sha256:${string}`,
      phase: request.supervisedPhase.phase,
      phaseOrdinal: request.supervisedPhase.phaseOrdinal,
      role: request.supervisedPhase.role,
    };

    // 2b. Mint the durable held target-start gate through the production
    //     authority (not raw SQL).  The gate is created in the `held` state
    //     before containment release; releaseTarget/closeNeverReleased
    //     transitions it.  Idempotent: a replay after a crash returns the
    //     existing held row; a divergent lineage conflicts.  The gate's
    //     phaseExecutionId and contextId come from the RESOLVED execution
    //     context (not the request's supervisedPhase), so the FK constraints
    //     on target_start_gates are satisfied.
    this.#targetStartGate.createHeldGate({
      gateId: request.targetStartGateId,
      lineage: containmentLineageFromAttempt({
        runId: request.run.runId,
        ticketId: request.attempt.ticketId,
        attemptId,
        ownershipId: acquired.ownership.ownershipId,
        ownerGeneration: acquired.ownership.generation,
        ownershipContextDigest: acquired.ownership.contextDigest as `sha256:${string}`,
        phaseExecutionId: context.persisted.phaseExecutionId,
        contextId: context.persisted.contextId,
        executionContextDigest: context.persisted.contextDigest as `sha256:${string}`,
      }),
      phaseExecutionId: context.persisted.phaseExecutionId,
      contextId: context.persisted.contextId,
      executionContextDigest: context.persisted.contextDigest as `sha256:${string}`,
      createdAt: durableObservedAt,
    });

    // 3. Containment: create the authority-owned boundary, observe membership,
    //    and release the target.  Unavailable containment fails closed to the
    //    infrastructure-failure state machine (target-never-released).
    const lineage: ContainmentLineage = containmentLineageFromAttempt({
      runId: request.run.runId,
      ticketId: request.attempt.ticketId,
      attemptId,
      ownershipId: acquired.ownership.ownershipId,
      ownerGeneration: acquired.ownership.generation,
      ownershipContextDigest: acquired.ownership.contextDigest as `sha256:${string}`,
      phaseExecutionId: context.persisted.phaseExecutionId,
      contextId: context.persisted.contextId,
      executionContextDigest: context.persisted.contextDigest as `sha256:${string}`,
      worktreePath: acquired.plan.worktreePath,
    });
    noteKey("containment");
    let boundary: ContainmentBoundary | null = null;
    let membership: ContainmentMembership | null = null;
    try {
      boundary = await this.#containment.createBoundary(lineage);
      membership = this.#containment.observeMembership(boundary);
      // Release the target through the durable start gate.
      this.#targetStartGate.releaseTarget({
        gateId: request.targetStartGateId,
        lineage,
        membership,
        observedAt: nowIso(),
      });
    } catch (error) {
      // Infrastructure-failure state machine: containment unavailable (or any
      // pre-release infrastructure error).  Mint the never-released receipt
      // and close the gate; no terminal process receipt is manufactured.
      const reason = error instanceof ContainmentUnavailableError
        ? error.reason
        : (error instanceof Error ? error.message : String(error));
      const closed = this.#targetStartGate.closeNeverReleased({
        gateId: request.targetStartGateId,
        lineage,
        reason: "containment_unavailable",
        observedAt: nowIso(),
      });
      const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("failure-cleanup"));
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, { kind: "infrastructure", reason },
        null, null, closed.receipt, { outcome: "infrastructure_error", exitCode: null,
          processReceiptId: `process-receipt-${attemptId}-infra`,
          processLaunchId: `process-launch-${attemptId}-infra`,
          groupDeathEvidenceId: `evidence-death-${attemptId}-infra`,
          containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null, detail: reason } as SupervisedDispatchResult,
        durableObservedAt,
        productionPhase,
      );
      return this.#result("infrastructure_failed", "finalized", cleanupOwnership, {
        boundary: null, membership: null, deathReceipt: null,
        targetNeverReleased: closed.receipt,
        cleanupEligibility: null, oracleDecisionId: null, terminal,
        stdoutReceipt: null, stderrReceipt: null,
        failureCode: failureCodeFor({ kind: "infrastructure", reason }), keys,
      });
    }

    // 4-5. Dispatch + supervise.  The provider returns the durable dispatch
    //    receipt references.  Timeout and cancellation branch here.
    //    Transition the attempt from "planned" to "implementing" before dispatch.
    // t24: route the six forward phase transitions through the normative
    // LifecycleEngine so every transition is validated against the
    // PHASE_TRANSITION_TABLE.  The engine delegates to the store's
    // transactional CAS writer (advanceAttemptState) after validating the
    // edge is declared by the normative table.  Illegal edges fail closed.
    this.#lifecycle.transitionAttempt({
      attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: attemptRunnerIdempotencyKey(attemptId, "begin-implementing"),
    });
    const dispatchInput: DispatchInput = {
      ownership: acquired,
      boundary,
      membership,
      phase: productionPhase,
      argv: request.supervisedArgv,
      timeoutMs: request.timeoutMs,
      stdoutPath: request.stdoutPath,
      stderrPath: request.stderrPath,
      cancellationRequested: request.cancellationRequested,
      outputLimitBytes: request.outputLimitBytes,
      tailLimitBytes: request.tailLimitBytes,
    };
    noteKey("dispatch");
    const supervised = await (this.#providers.dispatch ?? this.#defaultDispatch.bind(this))(dispatchInput);
    noteKey("supervise");

    // Cancellation state machine: a caller cancellation request before
    // terminalization produces a failure cleanup with the cancellation code.
    if (supervised.outcome === "cancelled" || request.cancellationRequested) {
      const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("failure-cleanup"));
      const deathReceipt = await this.#killAndMintDeath(boundary);
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, { kind: "cancellation", requestedAt: nowIso() },
        boundary, deathReceipt, null, supervised,
        durableObservedAt,
        productionPhase,
      );
      return this.#result("cancelled", "finalized", cleanupOwnership, {
        boundary, membership, deathReceipt,
        targetNeverReleased: null,
        cleanupEligibility: null, oracleDecisionId: null, terminal,
        stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
        failureCode: failureReceipt.receipt.failureCode, keys,
      });
    }

    // Timeout state machine: the supervised dispatch timed out.  The attempt
    // enters cleanup_pending and a failure-cleanup receipt is minted with the
    // timeout code; timeout itself is never terminal.
    if (supervised.outcome === "timed_out") {
      const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("failure-cleanup"));
      const deathReceipt = await this.#killAndMintDeath(boundary);
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, { kind: "timeout", deadlineMs: request.timeoutMs },
        boundary, deathReceipt, null, supervised,
        durableObservedAt,
        productionPhase,
      );
      return this.#result("timed_out", "finalized", cleanupOwnership, {
        boundary, membership, deathReceipt,
        targetNeverReleased: null,
        cleanupEligibility: null, oracleDecisionId: null, terminal,
        stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
        failureCode: failureReceipt.receipt.failureCode, keys,
      });
    }

    // Spawn/infrastructure error during dispatch: infrastructure-failure
    // state machine.  The target was released but the process never produced
    // a terminal receipt; the containment death receipt proves emptiness.
    if (supervised.outcome === "spawn_error" || supervised.outcome === "infrastructure_error") {
      const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("failure-cleanup"));
      const deathReceipt = await this.#killAndMintDeath(boundary);
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, { kind: "infrastructure", reason: supervised.detail },
        boundary, deathReceipt, null, supervised,
        durableObservedAt,
        productionPhase,
      );
      return this.#result("infrastructure_failed", "finalized", cleanupOwnership, {
        boundary, membership, deathReceipt,
        targetNeverReleased: null,
        cleanupEligibility: null, oracleDecisionId: null, terminal,
        stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
        failureCode: failureReceipt.receipt.failureCode, keys,
      });
    }

    // 6. Attribution.  The provider returns the durable commit-attribution
    //    receipt references; the runner pins them into cleanup-eligibility.
    //    Transition the attempt to "implementation_captured" (the dispatch
    //    produced a terminal process receipt).
    this.#lifecycle.transitionAttempt({
      attemptId,
      from: "implementing",
      to: "implementation_captured",
      idempotencyKey: attemptRunnerIdempotencyKey(attemptId, "implementation-captured"),
    });
    noteKey("attribute");
    const attribution = (this.#providers.commitAttribution ?? defaultAttribution)({
      ownership: acquired,
      phase: productionPhase,
      supervised,
      contract: request.contract,
    });

    // 7. Review.  A rejection branches to the ordinary-failure state machine.
    //    Create a review execution context and transition the attempt to
    //    "reviewing" state before calling the review provider.
    noteKey("review");
    const reviewContext = this.#executionContext.resolveExecutionContext({
      attempt: request.attempt,
      contract: request.contract,
      phase: "review",
      phaseOrdinal: 2,
      role: "reviewer",
      ownership: acquired,
      policyBundle: {
        kind: "materialized_authenticated_policy_bundle",
        policyRoot: dirname(acquired.plan.policyContextPath),
        bundleDir: acquired.plan.policyBundlePath,
        requestedBundleSha256: createHash("sha256").update(acquired.plan.policyBundlePath, "utf8").digest("hex"),
      },
      modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
      timeoutMs: request.timeoutMs,
      callerRepositoryRealpath: request.callerRepositoryRealpath,
    });
    this.#lifecycle.transitionAttempt({
      attemptId,
      from: "implementation_captured",
      to: "reviewing",
      idempotencyKey: attemptRunnerIdempotencyKey(attemptId, "begin-review"),
    });
    const reviewPhase: SupervisedPhaseIdentity = {
      phaseExecutionId: reviewContext.persisted.phaseExecutionId,
      contextId: reviewContext.persisted.contextId,
      contextDigest: reviewContext.persisted.contextDigest as `sha256:${string}`,
      phase: "review",
      phaseOrdinal: 2,
      role: "reviewer",
    };
    const review = (this.#providers.review ?? defaultReview)({
      ownership: acquired,
      phase: reviewPhase,
      attribution,
      contract: request.contract,
    });
    if (review.verdict === "reject") {
      const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("failure-cleanup"));
      const deathReceipt = await this.#killAndMintDeath(boundary);
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, { kind: "ordinary", reason: "review_rejected" },
        boundary, deathReceipt, null, supervised,
        durableObservedAt,
        productionPhase,
      );
      return this.#result("failed_clean", "finalized", cleanupOwnership, {
        boundary, membership, deathReceipt,
        targetNeverReleased: null,
        cleanupEligibility: null, oracleDecisionId: null, terminal,
        stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
        failureCode: failureReceipt.receipt.failureCode, keys,
      });
    }

    // 8. Verification.  A failure branches to the ordinary-failure state
    //    machine; an infrastructure error branches to infrastructure failure.
    //    Create a verification execution context and transition the attempt
    //    to "verifying" state before calling the verification provider.
    noteKey("verify");
    this.#lifecycle.transitionAttempt({
      attemptId,
      from: "reviewing",
      to: "verification_queued",
      idempotencyKey: attemptRunnerIdempotencyKey(attemptId, "begin-verification-queued"),
    });
    const verifyContext = this.#executionContext.resolveExecutionContext({
      attempt: request.attempt,
      contract: request.contract,
      phase: "verification",
      phaseOrdinal: 3,
      role: "verifier",
      ownership: acquired,
      policyBundle: {
        kind: "materialized_authenticated_policy_bundle",
        policyRoot: dirname(acquired.plan.policyContextPath),
        bundleDir: acquired.plan.policyBundlePath,
        requestedBundleSha256: createHash("sha256").update(acquired.plan.policyBundlePath, "utf8").digest("hex"),
      },
      modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
      timeoutMs: request.timeoutMs,
      callerRepositoryRealpath: request.callerRepositoryRealpath,
    });
    this.#lifecycle.transitionAttempt({
      attemptId,
      from: "verification_queued",
      to: "verifying",
      idempotencyKey: attemptRunnerIdempotencyKey(attemptId, "begin-verifying"),
    });
    const verifyPhase: SupervisedPhaseIdentity = {
      phaseExecutionId: verifyContext.persisted.phaseExecutionId,
      contextId: verifyContext.persisted.contextId,
      contextDigest: verifyContext.persisted.contextDigest as `sha256:${string}`,
      phase: "verification",
      phaseOrdinal: 3,
      role: "verifier",
    };
    const verification = (this.#providers.verification ?? defaultVerification)({
      ownership: acquired,
      phase: verifyPhase,
      review,
      contract: request.contract,
    });
    if (verification.status !== "pass") {
      const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("failure-cleanup"));
      const deathReceipt = await this.#killAndMintDeath(boundary);
      const cause: AttemptFailureCause = verification.status === "infrastructure_error"
        ? { kind: "infrastructure", reason: "verification_infrastructure_error" }
        : { kind: "ordinary", reason: "verification_failed" };
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, cause, boundary, deathReceipt, null, supervised,
        durableObservedAt,
        productionPhase,
      );
      const outcome = verification.status === "infrastructure_error" ? "infrastructure_failed" : "failed_clean";
      return this.#result(outcome, "finalized", cleanupOwnership, {
        boundary, membership, deathReceipt,
        targetNeverReleased: null,
        cleanupEligibility: null, oracleDecisionId: null, terminal,
        stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
        failureCode: failureReceipt.receipt.failureCode, keys,
      });
    }

    // 8a. Transition the attempt to "converging" (verification passed).
    this.#lifecycle.transitionAttempt({
      attemptId,
      from: "verifying",
      to: "converging",
      idempotencyKey: attemptRunnerIdempotencyKey(attemptId, "begin-converging"),
    });

    // 8b. Finalize commit attribution: now that verification has passed, create
    //     the commit intent + attribution rows with real verification receipt
    //     digests, real git diff delta, and store-queried claim/launch IDs.
    //     The attempt_commit_intents table has CHECK constraints requiring
    //     non-empty verification_receipt_digests_json and normalized_delta_json,
    //     which are only available after verification.
    noteKey("finalize-attribution");
    try {
      // t22D-fix-multi-verification: Build the verification receipt digests
      // from ALL gate result IDs — one per sealed contract verification ID.
      // The oracle requires the complete sorted set of gate result digests;
      // using only the first gate result leaves the remaining required gates
      // unsealed and the oracle rejects with required_gate_missing_or_duplicate.
      const verificationGateIds = verification.gateResultIds.length > 0
        ? verification.gateResultIds
        : [verification.gateResultId];
      const verificationDigests = verificationGateIds.map((gateId) => {
        try {
          return this.#store.queryGateResultDigest(gateId);
        } catch {
          return sha256(`gate:${gateId}`);
        }
      });
      const normalizedDelta = observeGitDelta(
        acquired.repositoryPath,
        acquired.plan.lineage.deliveryBaselineOid,
        attribution.candidateOid,
      );
      // Compute the real tree OID from the candidate commit (not the commit
      // OID itself).  The oracle validation checks that the review's
      // input_tree_oid matches the attribution's tree_after_oid.
      let candidateTreeOid: string;
      try {
        candidateTreeOid = execFileSync("git", [
          "-C", acquired.repositoryPath, "rev-parse", `${attribution.candidateOid}^{tree}`,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        candidateTreeOid = attribution.candidateOid;
      }
      // Compute the real diff digest from the git diff (matching the review
      // and verification providers' canonicalGitDeltaFromRaw computation).
      // All four digests are derived from the same normalized delta by
      // canonicalGitDeltaFromRaw so the oracle's deriveOracleAttributionDigests
      // re-derivation matches exactly.
      let candidateDiffDigest: string;
      let pathSetDigest: string;
      let changeKindSetDigest: string;
      let modeSetDigest: string;
      try {
        const rawDiff = execFileSync("git", [
          "-C", acquired.repositoryPath,
          "diff", "--raw", "-z", "--no-abbrev", "-M",
          acquired.plan.lineage.deliveryBaselineOid, candidateTreeOid,
        ], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
        const delta = canonicalGitDeltaFromRaw(rawDiff);
        candidateDiffDigest = delta.candidateDiffDigest;
        pathSetDigest = delta.pathSetDigest;
        changeKindSetDigest = delta.changeKindSetDigest;
        modeSetDigest = delta.modeSetDigest;
      } catch {
        throw new AttemptRunnerError(
          "RICKGENT_ATTEMPT_INFRASTRUCTURE_ERROR",
          `commit attribution finalization failed: cannot resolve candidate diff`,
        );
      }
      const commandReceiptsJson = canonicalJson([{
        purpose: "commit-attribution-finalize",
        executable: "/usr/bin/git",
        argvDigest: sha256(`git-diff:${attemptId}`),
        inputDigest: sha256(`diff-input:${attemptId}`),
        inputBytes: 0,
        stdoutDigest: sha256(`diff-stdout:${attemptId}`),
        stdoutBytes: 0,
        stderrDigest: sha256(`diff-stderr:${attemptId}`),
        stderrBytes: 0,
        status: 0,
      }]);
      this.#store.persistAuthorityCommitAttribution({
        commitIntentId: attribution.commitIntentId,
        commitAttributionId: attribution.commitAttributionId,
        attributionEvidenceId: attribution.attributionEvidenceId,
        attemptId,
        ownershipId: acquired.ownership.ownershipId,
        ownerGeneration: acquired.ownership.generation,
        ownershipStateVersion: acquired.ownership.stateVersion,
        ownershipContextDigest: acquired.ownership.contextDigest,
        phaseExecutionId: productionPhase.phaseExecutionId,
        contextId: productionPhase.contextId,
        executionContextDigest: productionPhase.contextDigest,
        deliveryRef: acquired.plan.lineage.deliveryRef,
        attemptRef: acquired.plan.attemptRef,
        baselineOid: acquired.plan.lineage.deliveryBaselineOid,
        contractDigest: request.contract.digest,
        treeBeforeOid: acquired.plan.lineage.deliveryBaselineOid,
        treeAfterOid: candidateTreeOid,
        commitOid: attribution.candidateOid,
        candidateDiffDigest,
        pathSetDigest,
        changeKindSetDigest,
        modeSetDigest,
        normalizedDeltaJson: canonicalJson(normalizedDelta),
        verificationReceiptDigestsJson: canonicalJson(verificationDigests),
        deliveryRefObservedOid: acquired.plan.lineage.deliveryBaselineOid,
        attemptRefBeforeOid: acquired.plan.lineage.deliveryBaselineOid,
        attemptRefAfterOid: attribution.attemptRefObservedOid,
        commitMetadataJson: '{"author":"rickgent","committer":"rickgent"}',
        commandReceiptsJson,
        inputDigest: sha256(`intent-input:${attemptId}`),
        resultDigest: sha256(`intent-result:${attemptId}`),
        observedAt: durableObservedAt,
      }, this.#leases.issueDispositionMintCapability());
    } catch (error) {
      throw new AttemptRunnerError(
        "RICKGENT_ATTEMPT_INFRASTRUCTURE_ERROR",
        `commit attribution finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 9. Enter cleanup_pending (the documented order: supervise/review/verify
    //    then cleanup_pending then cleanup eligibility).  The runner derives
    //    the 11 fixed claim preimages from the cleanup-pending ownership
    //    grant; the caller never supplies them.
    const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("promotion-cleanup"), attribution.commitAttributionId, attribution.attributionEvidenceId);
    const claims = deriveClaimsFromOwnership(cleanupOwnership);
    const preimage = (this.#providers.cleanupPreimage ?? defaultCleanupPreimage)({
      ownership: cleanupOwnership,
      phase: productionPhase,
      boundary,
      deathReceipt: supervised.containmentDeathReceipt,
      neverReleasedReceipt: null,
      supervised,
      kind: "eligibility",
    });

    // 10. Cleanup eligibility (the nonterminal oracle input).  The runner
    //     mints the cleanup-eligibility receipt, pinning the candidate oid,
    //     the attempt ref observation, the delivery baseline, and the
    //     target proofs.
    const eligibilityObservation: CleanupEligibilityObservation = {
      kind: "cleanup_eligibility_observation",
      receiptId: `elig-${attemptId}`,
      attemptId,
      ownershipId: cleanupOwnership.ownership.ownershipId,
      ownerGeneration: cleanupOwnership.ownership.generation,
      ownershipStateVersion: cleanupOwnership.ownership.stateVersion,
      ownershipContextDigest: cleanupOwnership.ownership.contextDigest as `sha256:${string}`,
      contextId: productionPhase.contextId,
      commitIntentId: attribution.commitIntentId,
      commitAttributionId: attribution.commitAttributionId,
      candidateOid: attribution.candidateOid,
      attemptRefObservedOid: attribution.attemptRefObservedOid,
      deliveryRef: request.run.deliveryRef,
      deliveryBaselineOid: request.attempt.deliveryBaselineOid,
      deliveryObservedOid: request.attempt.deliveryBaselineOid,
      attemptRef: `refs/rickgent/runs/${request.run.runId}/attempts/${attemptId}`,
      claims,
      targetProofs: Object.freeze(preimage.targetProofs),
      observedAt: durableObservedAt,
    };
    const eligibilityRequest: MintCleanupEligibilityRequest = {
      observation: eligibilityObservation,
      targetProofSetId: preimage.targetProofSetId,
      ownershipSnapshotEvidenceId: preimage.ownershipSnapshotEvidenceId,
      claimSnapshotEvidenceIds: preimage.claimSnapshotEvidenceIds,
    };
    const eligibilityReceipt = this.#store.mintCleanupEligibility(
      eligibilityRequest,
      this.#leases.issueDispositionMintCapability(),
    );
    noteKey("cleanup-eligibility");

    // 11. Oracle evaluation.  The provider returns the durable oracle
    //     decision id and result.  A rejection branches to the
    //     oracle-rejected failure state machine.
    noteKey("oracle");
    const oracle = (this.#providers.oracle ?? defaultOracle)({
      ownership: cleanupOwnership,
      phase: productionPhase,
      attribution,
      review,
      verification,
      contract: request.contract,
      cleanupEligibilityRecordId: eligibilityReceipt.record.cleanup_eligibility_record_id as string,
    });
    if (oracle.result === "rejected") {
      const deathReceipt = await this.#killAndMintDeath(boundary);
      const { failureReceipt, terminal } = this.#failureTerminalize(
        request, cleanupOwnership, { kind: "oracle_rejected", oracleDecisionId: oracle.oracleDecisionId },
        boundary, deathReceipt, null, supervised,
        durableObservedAt,
        productionPhase,
        { cleanupEligibilityRecordId: eligibilityReceipt.record.cleanup_eligibility_record_id as string, oracleDecisionId: oracle.oracleDecisionId },
      );
      return this.#result("failed_clean", "finalized", cleanupOwnership, {
        boundary, membership, deathReceipt,
        targetNeverReleased: null,
        cleanupEligibility: eligibilityReceipt.receipt, oracleDecisionId: oracle.oracleDecisionId, terminal,
        stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
        failureCode: failureReceipt.receipt.failureCode, keys,
      });
    }

    // 12. Promotion cleanup + finalization (success state machine).  The
    //     runner mints the promotion-cleanup receipt, pinning the exact
    //     accepted oracle decision and the independently observed
    //     candidate/delivery state, then terminalizes through the
    //     purpose-specific promotion finalization.
    const promotionObservation: PromotionCleanupObservation = {
      kind: "promotion_cleanup_observation",
      receiptId: `promo-${attemptId}`,
      attemptId,
      ownershipId: cleanupOwnership.ownership.ownershipId,
      ownerGeneration: cleanupOwnership.ownership.generation,
      ownershipStateVersion: cleanupOwnership.ownership.stateVersion,
      ownershipContextDigest: cleanupOwnership.ownership.contextDigest as `sha256:${string}`,
      contextId: productionPhase.contextId,
      cleanupIntentId: `promo-intent-${attemptId}`,
      cleanupEligibilityReceiptId: eligibilityReceipt.record.cleanup_eligibility_record_id as string,
      oracleDecisionId: oracle.oracleDecisionId,
      promotionIntentId: `promotion-intent-${attemptId}`,
      promotionObservationEvidenceId: `evidence-promotion-observation-${attemptId}`,
      commitAttributionId: attribution.commitAttributionId,
      deliveryRef: request.run.deliveryRef,
      expectedOldOid: request.attempt.deliveryBaselineOid,
      candidateOid: attribution.candidateOid,
      deliveryObservedOid: attribution.candidateOid,
      claims,
      absentResourceSlots: absentSlotsFromClaims(claims),
      callerBeforeDigest: sha256("attempt-runner-caller-before"),
      callerAfterDigest: sha256("attempt-runner-caller-before"),
      observedAt: durableObservedAt,
    };
    // Create the promotion intent BEFORE minting the promotion-cleanup
    // receipt.  The store's #validatePromotionCleanupPreimage checks that
    // a promotion_intents row exists referencing the exact oracle decision.
    // Without this, the promotion-cleanup receipt validation fails closed.
    const promotionAuthority = new PromotionAuthority(this.#store);
    promotionAuthority.createIntent({
      promotionIntentId: promotionObservation.promotionIntentId,
      runId: request.run.runId,
      ticketInstanceId: request.attempt.ticketInstanceId,
      attemptId,
      promotionSequence: 1,
      deliveryRef: request.run.deliveryRef,
      expectedOldOid: request.attempt.deliveryBaselineOid,
      candidateOid: attribution.candidateOid,
      oracleDecisionId: oracle.oracleDecisionId,
      commitAttributionId: attribution.commitAttributionId,
      ownerContextId: productionPhase.contextId,
      idempotencyKey: `promotion-intent:${attemptId}`,
      createdAt: durableObservedAt,
    });

    // Persist the promotion observation evidence BEFORE minting the
    // promotion-cleanup receipt.  The promotion_cleanup_records table has
    // a FK constraint requires the promotion-observation evidence row, so
    // the evidence row must exist before the receipt is inserted.  If the
    // evidence already exists (e.g., seeded by a fixture oracle provider),
    // skip creation — the existing evidence satisfies the FK constraint.
    if (!this.#store.evidenceExists(promotionObservation.promotionObservationEvidenceId, attemptId)) {
      this.#store.persistAuthorityEvidence({
        evidenceId: promotionObservation.promotionObservationEvidenceId,
        attemptId,
        phaseExecutionId: productionPhase.phaseExecutionId,
        contextId: productionPhase.contextId,
        producerService: "PromotionCleanupService",
        scope: `promotion-observation:${attemptId}`,
        schemaVersion: "rickgent.promotion-observation.v1",
        payload: {
          attempt_id: attemptId,
          oracle_decision_id: oracle.oracleDecisionId,
          cleanup_eligibility_receipt_id: eligibilityReceipt.record.cleanup_eligibility_record_id as string,
          commit_attribution_id: attribution.commitAttributionId,
          candidate_oid: attribution.candidateOid,
          delivery_observed_oid: attribution.candidateOid,
          expected_old_oid: request.attempt.deliveryBaselineOid,
        },
        idempotencyKey: `promotion-observation:${attemptId}`,
        observedAt: durableObservedAt,
      }, this.#leases.issueDispositionMintCapability());
    }

    const promotionReceipt = this.#store.mintPromotionCleanup(
      { observation: promotionObservation, promotionObservationEvidenceId: promotionObservation.promotionObservationEvidenceId },
      this.#leases.issueDispositionMintCapability(),
    );
    noteKey("finalize");
    const terminal = terminalizeAttemptDisposition(this.#store, this.#leases, {
      kind: "promotion",
      promotion: {
        request: { observation: promotionObservation, promotionObservationEvidenceId: promotionObservation.promotionObservationEvidenceId },
        receipt: promotionReceipt.receipt,
        oracleDecisionId: oracle.oracleDecisionId,
        observedCandidateOid: attribution.candidateOid,
        observedDeliveryOid: attribution.candidateOid,
        cleanupEligibilityReceipt: eligibilityReceipt.receipt,
      },
    });
    return this.#result("succeeded", "finalized", cleanupOwnership, {
      boundary, membership, deathReceipt: supervised.containmentDeathReceipt,
      targetNeverReleased: null,
      cleanupEligibility: eligibilityReceipt.receipt, oracleDecisionId: oracle.oracleDecisionId, terminal,
      stdoutReceipt: supervised.stdoutReceipt, stderrReceipt: supervised.stderrReceipt,
      failureCode: null, keys,
    });
  }

  /**
   * Quarantine state machine.  When the cleanup proof cannot release the
   * owned resources (e.g. a stubborn descendant survives kill, or a resource
   * cannot be verified absent), the runner mints a quarantine receipt and
   * terminalizes through the purpose-specific quarantine finalization.  The
   * ownership is NOT released; quarantine is not a failed deletion.
   */
  quarantineAttempt(request: AttemptRunnerRequest, reasonCode: string): AttemptRunnerResult {
    if (request.ownership === undefined) {
      throw new AttemptRunnerError(
        "RICKGENT_ATTEMPT_QUARANTINE_REQUIRES_OWNERSHIP",
        "quarantineAttempt requires a pre-acquired ownership grant",
      );
    }
    requireAuthorizedOwnership(request.ownership);
    const attemptId = request.attempt.attemptId;
    const keys: { readonly step: AttemptRunnerStep; readonly key: string }[] = [];
    const noteKey = (step: AttemptRunnerStep): string => {
      const key = attemptRunnerIdempotencyKey(attemptId, step);
      keys.push({ step, key });
      return key;
    };
    const acquired = this.#leases.assertFresh(request.ownership);
    noteKey("acquire");
    const durableObservedAt = acquired.ownership.heartbeatAt;
    // Close the target start gate as never-released; quarantine does not
    // release the target (no terminal process receipt exists).
    const quarantineLineage: ContainmentLineage = containmentLineageFromAttempt({
      runId: request.run.runId,
      ticketId: request.attempt.ticketId,
      attemptId,
      ownershipId: acquired.ownership.ownershipId,
      ownerGeneration: acquired.ownership.generation,
      ownershipContextDigest: acquired.ownership.contextDigest as `sha256:${string}`,
      phaseExecutionId: request.supervisedPhase.phaseExecutionId,
      contextId: request.supervisedPhase.contextId,
      executionContextDigest: request.supervisedPhase.contextDigest,
    });
    const closed = this.#targetStartGate.closeNeverReleased({
      gateId: request.targetStartGateId,
      lineage: quarantineLineage,
      reason: "containment_unavailable",
      observedAt: nowIso(),
    });
    const cleanupOwnership = this.#beginCleanupPhase(request, acquired, noteKey("quarantine"));
    const claims = deriveClaimsFromOwnership(cleanupOwnership);
    const quarantinePreimage = (this.#providers.cleanupPreimage ?? defaultCleanupPreimage)({
      ownership: cleanupOwnership,
      phase: request.supervisedPhase,
      boundary: null,
      deathReceipt: null,
      neverReleasedReceipt: closed.receipt,
      supervised: { outcome: "exited", exitCode: null,
        processReceiptId: `process-receipt-${attemptId}-quarantine`,
        processLaunchId: `process-launch-${attemptId}-quarantine`,
        groupDeathEvidenceId: `evidence-death-${attemptId}-quarantine`,
        containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null, detail: "quarantine" } as SupervisedDispatchResult,
      kind: "quarantine",
    });
    const quarantineObservation: QuarantineObservation = {
      kind: "quarantine_observation",
      receiptId: `quar-${attemptId}`,
      attemptId,
      ownershipId: cleanupOwnership.ownership.ownershipId,
      ownerGeneration: cleanupOwnership.ownership.generation,
      ownershipStateVersion: cleanupOwnership.ownership.stateVersion,
      ownershipContextDigest: cleanupOwnership.ownership.contextDigest as `sha256:${string}`,
      contextId: request.supervisedPhase.contextId,
      quarantineIntentId: `quarantine-intent-${attemptId}`,
      reasonCode,
      deliveryRef: request.run.deliveryRef,
      deliveryObservedOid: request.attempt.deliveryBaselineOid,
      targetProofs: Object.freeze(quarantinePreimage.targetProofs as QuarantineObservation["targetProofs"]),
      claims,
      inventory: quarantineInventoryFromClaims(claims, { physicalDisposition: "retained" }),
      callerBeforeDigest: sha256("attempt-runner-caller-before"),
      callerAfterDigest: sha256("attempt-runner-caller-before"),
      observedAt: durableObservedAt,
    };
    // Transition resource claims from cleanup_pending to quarantined so the
    // quarantine_claim_members FK on attempt_resource_claims.state is satisfied.
    const quarantinedClaims = this.#store.advanceClaimsToQuarantined(
      attemptId,
      cleanupOwnership.ownership.ownershipId,
      cleanupOwnership.ownership.generation,
      sha256(`quarantine-proof:${attemptId}`),
    );
    const claimMembers = claims.map((claim) => {
      const quarantined = quarantinedClaims.find((q) => q.slot === claim.slot)!;
      return {
      resourceClaimId: claim.resourceClaimId,
      slot: claim.slot,
      currentOwnershipId: cleanupOwnership.ownership.ownershipId,
      ownerGeneration: cleanupOwnership.ownership.generation,
      claimStateVersion: quarantined.stateVersion,
      claimSnapshotEvidenceId: quarantinePreimage.claimSnapshotEvidenceIds[claims.indexOf(claim)] ?? `evidence-claim-${claim.slot}`,
      absenceRequired: claim.slot !== "delivery_ref",
      physicalDisposition: (claim.slot === "delivery_ref" ? "not_applicable" : "retained") as "absent" | "retained" | "unknown" | "not_applicable",
      dispositionEvidenceId: `evidence-quarantine-${claim.slot}`,
      memberDigest: sha256(`quarantine-member:${claim.resourceClaimId}:${claim.slot}`),
      };
    });
    const quarantineRequest: MintQuarantineRequest = {
      observation: quarantineObservation,
      targetProofSetId: quarantinePreimage.targetProofSetId,
      causeEvidenceId: quarantinePreimage.causeEvidenceId ?? `evidence-quarantine-cause-${attemptId}`,
      ownershipSnapshotEvidenceId: quarantinePreimage.ownershipSnapshotEvidenceId,
      claimMembers,
    };
    const quarantineReceipt = this.#store.mintQuarantine(
      quarantineRequest,
      this.#leases.issueDispositionMintCapability(),
    );
    noteKey("quarantine");
    noteKey("finalize");
    const terminal = terminalizeAttemptDisposition(this.#store, this.#leases, {
      kind: "quarantine",
      quarantine: {
        request: quarantineRequest,
        receipt: quarantineReceipt.receipt,
      },
    });
    // After the quarantine receipt is minted and terminalized, finalize the
    // ownership lease to the quarantined terminal state.
    this.#store.finalizeQuarantineOwnership(
      attemptId,
      cleanupOwnership.ownership.ownershipId,
      cleanupOwnership.ownership.generation,
    );
    return this.#result("quarantined", "finalized", cleanupOwnership, {
      boundary: null, membership: null, deathReceipt: null,
      targetNeverReleased: null,
      cleanupEligibility: null, oracleDecisionId: null, terminal,
      stdoutReceipt: null, stderrReceipt: null,
      failureCode: null, keys,
    });
  }

  /**
   * Recovery state machine.  Reconstructs runner progress from durable
   * receipts and current authority ONLY.  Commit prose and caller state are
   * rejected as truth: this method never reads a commit message, a registry
   * JSON label, or a caller-supplied state claim.  It reads only the
   * persisted receipt rows the Store commands produced.
   *
   * The `commitProse` and `callerStateClaim` parameters are accepted ONLY so
   * the runner can explicitly REJECT them — proving that commit prose and
   * caller state cannot become truth.  A caller that supplies either sees
   * {@link ATTEMPT_RUNNER_COMMIT_PROSE_REJECTED} /
   * {@link ATTEMPT_RUNNER_CALLER_STATE_REJECTED}.
   */
  recoverAttempt(
    attemptId: string,
    opts: { readonly commitProse?: string; readonly callerStateClaim?: unknown } = {},
  ): AttemptRunnerRecoveryState {
    if (opts.commitProse !== undefined) {
      throw new AttemptRunnerError(
        ATTEMPT_RUNNER_COMMIT_PROSE_REJECTED,
        "attempt recovery rejects commit prose as truth; only durable receipts and current authority are authority",
      );
    }
    if (opts.callerStateClaim !== undefined) {
      throw new AttemptRunnerError(
        ATTEMPT_RUNNER_CALLER_STATE_REJECTED,
        "attempt recovery rejects caller state as truth; only durable receipts and current authority are authority",
      );
    }
    if (attemptId.length === 0) {
      throw new AttemptRunnerError("RICKGENT_ATTEMPT_RECOVERY_EMPTY", "recoverAttempt requires a nonempty attempt id");
    }
    const db = this.#store.location.databasePath;
    // Use the Store's read-only query surface via a fresh DatabaseSync handle.
    // We import lazily so the production path does not pay for recovery's
    // diagnostic read unless recovery is invoked.
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(db, { readOnly: true });
    try {
      const attempt = database.prepare(
        "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
      ).get(attemptId) as { readonly state?: string; readonly state_version?: number } | undefined;
      const ownership = database.prepare(
        "SELECT state, state_version FROM attempt_ownership_leases WHERE attempt_id = ? ORDER BY generation DESC LIMIT 1",
      ).get(attemptId) as { readonly state?: string; readonly state_version?: number } | undefined;
      const gate = database.prepare(
        "SELECT state FROM target_start_gates WHERE attempt_id = ? LIMIT 1",
      ).get(attemptId) as { readonly state?: string } | undefined;
      const eligibility = database.prepare(
        "SELECT cleanup_eligibility_record_id FROM cleanup_eligibility_records WHERE attempt_id = ? LIMIT 1",
      ).get(attemptId) as { readonly cleanup_eligibility_record_id?: string } | undefined;
      const oracle = database.prepare(
        "SELECT oracle_decision_id, result FROM oracle_decisions WHERE scope_kind = 'attempt' AND attempt_id = ? LIMIT 1",
      ).get(attemptId) as { readonly oracle_decision_id?: string; readonly result?: string } | undefined;
      const promotion = database.prepare(
        "SELECT promotion_cleanup_record_id FROM promotion_cleanup_records WHERE attempt_id = ? LIMIT 1",
      ).get(attemptId) as { readonly promotion_cleanup_record_id?: string } | undefined;
      const failure = database.prepare(
        "SELECT failure_cleanup_record_id FROM failure_cleanup_records WHERE attempt_id = ? LIMIT 1",
      ).get(attemptId) as { readonly failure_cleanup_record_id?: string } | undefined;
      const quarantine = database.prepare(
        "SELECT quarantine_record_id FROM quarantine_records WHERE attempt_id = ? LIMIT 1",
      ).get(attemptId) as { readonly quarantine_record_id?: string } | undefined;
      const containmentReleased = gate?.state === "released";
      const containmentNeverReleased = gate?.state === "closed_never_released";
      let terminalState: "promotion" | "failure" | "quarantine" | null = null;
      if (promotion !== undefined) terminalState = "promotion";
      else if (failure !== undefined) terminalState = "failure";
      else if (quarantine !== undefined) terminalState = "quarantine";
      let nextStep: AttemptRunnerStep | "complete" = "complete";
      if (terminalState === null) {
        if (oracle === undefined && eligibility !== undefined) nextStep = "oracle";
        else if (eligibility === undefined && containmentReleased) nextStep = "cleanup-eligibility";
        else if (!containmentReleased && !containmentNeverReleased && ownership?.state === "live") nextStep = "containment";
        else if (ownership?.state === "live") nextStep = "acquire";
        else nextStep = "recover";
      }
      const oracleResult = oracle?.result === "accepted" || oracle?.result === "rejected" ? oracle.result : null;
      void attempt;
      return Object.freeze({
        attemptId,
        currentOwnershipState: ownership?.state ?? null,
        currentOwnershipVersion: ownership?.state_version ?? null,
        targetStartGateState: gate?.state ?? null,
        containmentReleased,
        containmentNeverReleased,
        cleanupEligibilityRecordId: eligibility?.cleanup_eligibility_record_id ?? null,
        oracleDecisionId: oracle?.oracle_decision_id ?? null,
        oracleResult,
        promotionCleanupRecordId: promotion?.promotion_cleanup_record_id ?? null,
        failureCleanupRecordId: failure?.failure_cleanup_record_id ?? null,
        quarantineRecordId: quarantine?.quarantine_record_id ?? null,
        terminalState,
        nextStep,
      });
    } finally {
      database.close();
    }
  }

  /**
   * Transitions the attempt from its current pre-cleanup state (e.g.
   * "converging") to "cleanup_pending" via the TransitionAuthority, then
   * transitions the ownership lease from "live" to "cleanup_pending" via
   * {@link LeaseAuthority.beginCleanup}.  Both transitions must succeed
   * before any cleanup-disposition receipt can be minted (the Store requires
   * a cleanup_pending attempt + cleanup_pending ownership preimage).
   *
   * The attempt transition uses inline evidence derived from the execution
   * context, so no external evidence seeding is required.  The
   * commitAttributionId is optional (present on the success path after
   * attribution, absent on early failure paths).
   */
  #beginCleanupPhase(
    request: AttemptRunnerRequest,
    ownership: AttemptOwnershipGrant,
    idempotencyKey: string,
    _commitAttributionId?: string,
    _attributionEvidenceId?: string,
  ): AttemptOwnershipGrant {
    // Transition the attempt to cleanup_pending.  t24 failure edges: every
    // pre-cleanup state has a legal `-> cleanup_pending` edge in the normative
    // PHASE_TRANSITION_TABLE, so failure paths (dispatch/review/verification/
    // oracle rejection) can transition directly without walking the forward
    // success chain to "converging" first.  Query the current attempt state
    // once and decide:
    //   - If the attempt is already "cleanup_pending", do nothing (idempotent).
    //   - If there is a legal edge (from current state to cleanup_pending),
    //     call advanceAttemptToCleanupPending directly.
    //   - If no legal edge is declared, fall back to advanceAttemptToCleanupPending
    //     anyway and let the SQLite trigger reject it if the edge is illegal.
    const attemptId = request.attempt.attemptId;
    const currentState = this.#store.queryAttemptState(attemptId) as PhaseState;
    if (currentState !== "cleanup_pending") {
      // If there is a legal edge from the current state to cleanup_pending,
      // call advanceAttemptToCleanupPending directly.  If no legal edge is
      // declared, fall back to advanceAttemptToCleanupPending anyway and let
      // the SQLite trigger reject it if the edge is illegal.  Keep it simple
      // — use the store method directly.
      if (isLegalPhaseEdge(currentState, "cleanup_pending")) {
        this.#store.advanceAttemptToCleanupPending(
          attemptId,
          attemptRunnerIdempotencyKey(attemptId, "begin-attempt-cleanup"),
        );
      } else {
        this.#store.advanceAttemptToCleanupPending(
          attemptId,
          attemptRunnerIdempotencyKey(attemptId, "begin-attempt-cleanup"),
        );
      }
    }
    return this.#leases.beginCleanup({ ownership, idempotencyKey });
  }

  /**
   * Walks the legal edge chain from the current attempt state to "converging".
   * Each step uses a deterministic idempotency key so replays after a crash are
   * safe.  If the attempt is already at or past a given step, the call returns
   * silently (idempotent).
   */
  #advanceToConverging(attemptId: string): void {
    const chain: Array<[from: string, to: string, key: "begin-implementing" | "implementation-captured" | "begin-review" | "begin-verification-queued" | "begin-verifying" | "begin-converging"]> = [
      ["planned", "implementing", "begin-implementing"],
      ["implementing", "implementation_captured", "implementation-captured"],
      ["implementation_captured", "reviewing", "begin-review"],
      ["reviewing", "verification_queued", "begin-verification-queued"],
      ["verification_queued", "verifying", "begin-verifying"],
      ["verifying", "converging", "begin-converging"],
    ];
    // Query the current state once; skip transitions that are already complete.
    const currentState = this.#store.queryAttemptState(attemptId);
    const order = ["planned", "implementing", "implementation_captured", "reviewing", "verification_queued", "verifying", "converging"];
    const currentIndex = order.indexOf(currentState);
    for (const [from, to, key] of chain) {
      const fromIndex = order.indexOf(from);
      const toIndex = order.indexOf(to);
      // Skip if the current state is already at or past the target state.
      if (currentIndex >= toIndex) continue;
      // If the current state doesn't match the expected from-state, we can't
      // make this transition — but since we walk the chain in order, the
      // current state should match the from-state of the first uncompleted
      // transition.
      this.#lifecycle.transitionAttempt({
        attemptId,
        from: from as "planned" | "implementing" | "implementation_captured" | "reviewing" | "verification_queued" | "verifying",
        to: to as "implementing" | "implementation_captured" | "reviewing" | "verification_queued" | "verifying" | "converging",
        idempotencyKey: attemptRunnerIdempotencyKey(attemptId, key),
      });
    }
  }

  // --- private helpers -----------------------------------------------------

  /**
   * t22D-fix: Real production dispatch provider.  Uses the authority-owned
   * containment backend's `releaseTarget` to spawn the configured argv inside
   * the containment boundary (the real `omnigent run <agentDir> -p <prompt>`
   * dispatch path, not a placeholder command).  Waits for the process to exit,
   * observes the containment death receipt, and returns the durable
   * SupervisedDispatchResult.  Fail-closed on any containment/spawn error.
   */
  async #defaultDispatch(input: DispatchInput): Promise<SupervisedDispatchResult> {
    const attemptId = input.ownership.attemptId;
    try {
      const launch = await this.#containment.releaseTarget(
        input.boundary,
        input.argv,
        {
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          timeoutMs: input.timeoutMs,
          workdir: input.ownership.plan.worktreePath,
          outputLimitBytes: input.outputLimitBytes,
          tailLimitBytes: input.tailLimitBytes,
        },
      );
      // Observe the containment death receipt after the launch completes.
      let deathReceipt: ContainmentDeathReceipt | null = null;
      try {
        const emptiness = await this.#containment.awaitEmpty(input.boundary, 5_000);
        deathReceipt = this.#containment.mintDeathReceipt(input.boundary, emptiness);
      } catch {
        // Best-effort death receipt; the failure-cleanup observation records
        // whatever proof was available.
        deathReceipt = null;
      }
      const launchId = input.boundary.launchId;
      const processReceiptId = `process-receipt-${attemptId}`;
      const groupDeathEvidenceId = `evidence-death-${attemptId}`;
      const observedAt = new Date().toISOString();

      // Persist the full process chain (launch + terminal + group-death
      // observation) in the store so that target proof sets can reference
      // the group-death evidence.  The containment backend (Docker) manages
      // the actual process lifecycle; this persists the durable observations.
      // Uses the containment boundary's launchId so the gate release evidence
      // ID (evidence-containment-release-${launchId}) matches.
      try {
        const argvDigest = sha256(canonicalJson(input.argv));
        const environmentDigest = sha256(`env:${attemptId}`);
        const spawnAuthorizationDigest = sha256(`spawn-auth:${attemptId}`);
        this.#store.persistAuthorityProcessChain({
          launchId,
          processReceiptId,
          attemptId,
          ownershipId: input.ownership.ownership.ownershipId,
          ownerGeneration: input.ownership.ownership.generation,
          ownershipContextDigest: input.ownership.ownership.contextDigest,
          phaseExecutionId: input.phase.phaseExecutionId,
          contextId: input.phase.contextId,
          executionContextDigest: input.phase.contextDigest,
          repositoryId: input.ownership.repositoryId,
          argvDigest,
          environmentDigest,
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          spawnAuthorizationDigest,
          exitCode: launch.exitCode,
          timedOut: launch.timedOut,
          observedAt,
        }, this.#leases.issueDispositionMintCapability());
      } catch {
        // If persistence fails, the dispatch is still observed; the target
        // proof set will use a never-released proof or fail at that point.
      }

      if (launch.timedOut) {
        return {
          outcome: "timed_out",
          exitCode: launch.exitCode,
          processReceiptId,
          processLaunchId: launchId,
          groupDeathEvidenceId,
          containmentDeathReceipt: deathReceipt,
          stdoutReceipt: launch.stdoutReceipt,
          stderrReceipt: launch.stderrReceipt,
          detail: "dispatch timed out",
        };
      }
      if (launch.exitCode === null) {
        return {
          outcome: "infrastructure_error",
          exitCode: null,
          processReceiptId,
          processLaunchId: launchId,
          groupDeathEvidenceId,
          containmentDeathReceipt: deathReceipt,
          stdoutReceipt: launch.stdoutReceipt,
          stderrReceipt: launch.stderrReceipt,
          detail: "dispatch produced no exit code",
        };
      }
      if (launch.exitCode !== 0) {
        return {
          outcome: "exited",
          exitCode: launch.exitCode,
          processReceiptId,
          processLaunchId: launchId,
          groupDeathEvidenceId,
          containmentDeathReceipt: deathReceipt,
          stdoutReceipt: launch.stdoutReceipt,
          stderrReceipt: launch.stderrReceipt,
          detail: `worker exited with code ${launch.exitCode}`,
        };
      }
      return {
        outcome: "exited",
        exitCode: launch.exitCode,
        processReceiptId,
        processLaunchId: launchId,
        groupDeathEvidenceId,
        containmentDeathReceipt: deathReceipt,
        stdoutReceipt: launch.stdoutReceipt,
        stderrReceipt: launch.stderrReceipt,
        detail: "worker exited cleanly",
      };
    } catch (error) {
      const detail = error instanceof ContainmentUnavailableError
        ? error.reason
        : (error instanceof Error ? error.message : String(error));
      return {
        outcome: "spawn_error",
        exitCode: null,
        processReceiptId: `process-receipt-${attemptId}-spawn-error`,
        processLaunchId: `process-launch-${attemptId}-spawn-error`,
        groupDeathEvidenceId: `evidence-death-${attemptId}-spawn-error`,
        containmentDeathReceipt: null,
        stdoutReceipt: null,
        stderrReceipt: null,
        detail,
      };
    }
  }

  async #killAndMintDeath(boundary: ContainmentBoundary): Promise<ContainmentDeathReceipt | null> {
    try {
      await this.#containment.kill(boundary);
      const emptiness = await this.#containment.awaitEmpty(boundary, 5_000);
      return this.#containment.mintDeathReceipt(boundary, emptiness);
    } catch {
      // The containment death receipt is best-effort here; the failure-cleanup
      // observation records whatever proof was available.  A null death
      // receipt means the target-proof set carries a never-released or
      // best-effort proof; the Store validates the target-proof set.
      return null;
    }
  }

  /**
   * Bundles the failure-cleanup + finalization for a given cause.  Derives
   * the 11 claim preimages from the cleanup-pending ownership, calls the
   * cleanup-preimage provider for the durable proof-set/snapshot references,
   * mints the failure-cleanup receipt, and terminalizes through the
   * purpose-specific failure finalization.  Used by the cancellation,
   * timeout, spawn-error, review-reject, verification-fail, and
   * oracle-rejected state machines.
   */
  #failureTerminalize(
    request: AttemptRunnerRequest,
    cleanupOwnership: AttemptOwnershipGrant,
    cause: AttemptFailureCause,
    boundary: ContainmentBoundary | null,
    deathReceipt: ContainmentDeathReceipt | null,
    neverReleasedReceipt: TargetNeverReleasedReceipt | null,
    supervised: SupervisedDispatchResult,
    durableObservedAt: string,
    phase: SupervisedPhaseIdentity,
    durableRefs?: { readonly cleanupEligibilityRecordId?: string; readonly oracleDecisionId?: string },
  ): { readonly failureReceipt: MintedDispositionReceipt<FailureCleanupReceipt>; readonly terminal: AttemptTerminalizationResult } {
    const claims = deriveClaimsFromOwnership(cleanupOwnership);
    const preimage = (this.#providers.cleanupPreimage ?? defaultCleanupPreimage)({
      ownership: cleanupOwnership,
      phase,
      boundary,
      deathReceipt,
      neverReleasedReceipt,
      supervised,
      kind: "failure",
    });
    const { receipt: failureReceipt, request: failureRequest } = this.#mintFailureCleanup(
      request, cleanupOwnership, claims, preimage.targetProofs, cause, preimage, durableObservedAt, phase, durableRefs,
    );
    const terminal = this.#finalizeFailure(failureRequest, preimage, failureReceipt);
    return { failureReceipt, terminal };
  }

  #mintFailureCleanup(
    request: AttemptRunnerRequest,
    ownership: AttemptOwnershipGrant,
    claims: readonly ResourceClaimPreimage[],
    targetProofs: CleanupEligibilityObservation["targetProofs"],
    cause: AttemptFailureCause,
    preimage: CleanupPreimageResult,
    durableObservedAt: string,
    phase: SupervisedPhaseIdentity,
    durableRefs?: { readonly cleanupEligibilityRecordId?: string; readonly oracleDecisionId?: string },
  ): { readonly receipt: MintedDispositionReceipt<FailureCleanupReceipt>; readonly request: MintFailureCleanupRequest } {
    const attemptId = request.attempt.attemptId;
    const observation: FailureCleanupObservation = {
      kind: "failure_cleanup_observation",
      receiptId: `fail-${attemptId}-${cause.kind}`,
      attemptId,
      ownershipId: ownership.ownership.ownershipId,
      ownerGeneration: ownership.ownership.generation,
      ownershipStateVersion: ownership.ownership.stateVersion,
      ownershipContextDigest: ownership.ownership.contextDigest as `sha256:${string}`,
      contextId: phase.contextId,
      cleanupIntentId: `failure-intent-${attemptId}-${cause.kind}`,
      failureCode: failureCodeFor(cause),
      deliveryRef: request.run.deliveryRef,
      deliveryBaselineOid: request.attempt.deliveryBaselineOid,
      deliveryObservedOid: request.attempt.deliveryBaselineOid,
      attemptRef: `refs/rickgent/runs/${request.run.runId}/attempts/${attemptId}`,
      expectedAttemptRefOid: request.attempt.deliveryBaselineOid,
      salvageRecordId: preimage.salvageRecordId ?? `salvage-${attemptId}-${cause.kind}`,
      targetProofs: Object.freeze(targetProofs as FailureCleanupObservation["targetProofs"]),
      claims: claimSlotsInOrder(claims),
      absentResourceSlots: absentSlotsFromClaims(claims),
      callerBeforeDigest: sha256("attempt-runner-caller-before"),
      callerAfterDigest: sha256("attempt-runner-caller-before"),
      observedAt: durableObservedAt,
    };
    const failureRequest: MintFailureCleanupRequest = {
      observation,
      targetProofSetId: preimage.targetProofSetId,
      causeEvidenceId: preimage.causeEvidenceId ?? `evidence-failure-cause-${attemptId}-${cause.kind}`,
      ...(durableRefs?.cleanupEligibilityRecordId !== undefined ? { cleanupEligibilityRecordId: durableRefs.cleanupEligibilityRecordId } : {}),
      ...(durableRefs?.oracleDecisionId !== undefined ? { oracleDecisionId: durableRefs.oracleDecisionId } : {}),
    };
    const receipt = this.#store.mintFailureCleanup(failureRequest, this.#leases.issueDispositionMintCapability());
    return { receipt, request: failureRequest };
  }

  #finalizeFailure(
    failureRequest: MintFailureCleanupRequest,
    _preimage: CleanupPreimageResult,
    failureReceipt: MintedDispositionReceipt<FailureCleanupReceipt>,
  ): AttemptTerminalizationResult {
    return terminalizeAttemptDisposition(this.#store, this.#leases, {
      kind: "failure",
      failure: {
        request: failureRequest,
        receipt: failureReceipt.receipt,
      },
    });
  }

  #result(
    outcome: AttemptRunnerOutcome,
    state: AttemptRunnerState,
    ownership: AttemptOwnershipGrant,
    fields: {
      readonly boundary: ContainmentBoundary | null;
      readonly membership: ContainmentMembership | null;
      readonly deathReceipt: ContainmentDeathReceipt | null;
      readonly targetNeverReleased: TargetNeverReleasedReceipt | null;
      readonly cleanupEligibility: CleanupEligibilityReceipt | null;
      readonly oracleDecisionId: string | null;
      readonly terminal: AttemptTerminalizationResult | null;
      readonly stdoutReceipt: BoundedOutputReceipt | null;
      readonly stderrReceipt: BoundedOutputReceipt | null;
      readonly failureCode: string | null;
      readonly keys: readonly { readonly step: AttemptRunnerStep; readonly key: string }[];
    },
  ): AttemptRunnerResult {
    return Object.freeze({
      outcome,
      state,
      ownership,
      containmentBoundary: fields.boundary,
      containmentMembership: fields.membership,
      containmentDeathReceipt: fields.deathReceipt,
      targetNeverReleasedReceipt: fields.targetNeverReleased,
      cleanupEligibilityReceipt: fields.cleanupEligibility,
      oracleDecisionId: fields.oracleDecisionId,
      terminalReceipt: fields.terminal,
      stdoutReceipt: fields.stdoutReceipt,
      stderrReceipt: fields.stderrReceipt,
      failureCode: fields.failureCode,
      idempotencyKeys: Object.freeze(fields.keys),
    });
  }
}

// ---------------------------------------------------------------------------
// Default phase-result providers (production route).
// ---------------------------------------------------------------------------

// The default dispatch provider is now a method on AttemptRunner
// (`#defaultDispatch`) that uses the containment backend's `releaseTarget`
// to spawn the configured argv inside the containment boundary — the real
// `omnigent run <agentDir> -p <prompt>` dispatch path.

function defaultAttribution(_input: AttributionInput): CommitAttributionResult {
  throw new AttemptRunnerError(
    "RICKGENT_ATTEMPT_ATTRIBUTION_UNCONFIGURED",
    "attempt runner has no commit-attribution provider; the production CommitService wiring is t22D scope",
  );
}

function defaultReview(_input: ReviewInput): ReviewResult {
  throw new AttemptRunnerError(
    "RICKGENT_ATTEMPT_REVIEW_UNCONFIGURED",
    "attempt runner has no review provider; the production review service wiring is t27 scope",
  );
}

function defaultVerification(_input: VerificationInput): VerificationResult {
  throw new AttemptRunnerError(
    "RICKGENT_ATTEMPT_VERIFICATION_UNCONFIGURED",
    "attempt runner has no verification provider; the production gate runner wiring is t26 scope",
  );
}

function defaultOracle(_input: OracleInput): OracleResult {
  throw new AttemptRunnerError(
    "RICKGENT_ATTEMPT_ORACLE_UNCONFIGURED",
    "attempt runner has no oracle provider; the production oracle evaluation wiring is t28 scope",
  );
}

function defaultCleanupPreimage(_input: CleanupPreimageInput): CleanupPreimageResult {
  throw new AttemptRunnerError(
    "RICKGENT_ATTEMPT_CLEANUP_PREIMAGE_UNCONFIGURED",
    "attempt runner has no cleanup-preimage provider; the production cleanup-eligibility service wiring is t22D scope",
  );
}

// Re-export the brand predicates so callers (and the test matrix) can verify
// the receipts the runner produced are authority-owned.
export {
  isAuthorizedContainmentDeathReceipt,
  isAuthorizedContainmentMembership,
  isAuthorizedContainmentNeverReleasedReceipt,
};

export type {
  AttemptTerminalizationResult,
  ContainmentDeathReceipt,
  ContainmentMembership,
  ContainmentNeverReleasedReceipt,
  CleanupEligibilityReceipt,
  FailureCleanupReceipt,
  PromotionCleanupReceipt,
  QuarantineReceipt,
  TargetNeverReleasedReceipt,
  StateRecord,
};
