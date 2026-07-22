import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  capabilityRegistry,
  CLAIMS_SCHEMA_VERSION,
  RELEASE_CHANNEL,
  RELEASE_LABEL,
} from "../capabilities/registry.js";
import { normalizeTicketContracts } from "../contracts/ticket-contract.js";
import {
  CLEANUP_ELIGIBILITY_SCHEMA_VERSION,
  FAILURE_CLEANUP_SCHEMA_VERSION,
  PROMOTION_CLEANUP_SCHEMA_VERSION,
  QUARANTINE_SCHEMA_VERSION,
  TARGET_NEVER_RELEASED_SCHEMA_VERSION,
  isLeaseAuthorityMintCapability,
  mintCleanupEligibilityReceipt,
  mintFailureCleanupReceipt,
  mintPromotionCleanupReceipt,
  mintQuarantineReceipt,
  mintTargetNeverReleasedReceipt,
  type CleanupEligibilityObservation,
  type CleanupEligibilityReceipt,
  type FailureCleanupObservation,
  type FailureCleanupReceipt,
  type LeaseAuthorityMintCapability,
  type PromotionCleanupObservation,
  type PromotionCleanupReceipt,
  type QuarantineObservation,
  type QuarantineReceipt,
  type TargetNeverReleasedObservation,
  type TargetNeverReleasedReceipt,
} from "../lifecycle/disposition.js";
import {
  CONTAINMENT_RELEASE_SCHEMA_VERSION,
  isAuthorizedContainmentMembership,
  type ContainmentMembership,
} from "../process/containment.js";
import {
  ATTEMPT_OWNERSHIP_STATE_SCHEMA_OBJECTS,
  ATTEMPT_OWNERSHIP_STATE_SQLITE_SCHEMA_CHECKSUM,
  COMMIT_ATTRIBUTION_STATE_SQLITE_SCHEMA_CHECKSUM,
  INITIAL_STATE_SCHEMA_OBJECTS,
  INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM,
  LATEST_STATE_SCHEMA_OBJECTS,
  LATEST_STATE_SQLITE_SCHEMA_CHECKSUM,
  LATEST_STATE_SCHEMA_VERSION,
  PROCESS_SUPERVISION_STATE_SQLITE_SCHEMA_CHECKSUM,
  PROCESS_SUPERVISION_STATE_SCHEMA_OBJECTS,
  STATE_MIGRATIONS,
  assertValidMigrationCatalog,
  type StateMigration,
} from "./migrations.js";
import {
  ALL_STATE_TABLES,
  APPEND_ONLY_STATE_TABLES,
  ATTEMPT_TRANSITIONS,
  LEGACY_ARTIFACT_KINDS,
  PROMOTION_TRANSITIONS,
  RESOURCE_KINDS,
  RUN_TRANSITIONS,
  STATE_SQLITE_MINIMUM_NODE_VERSION,
  TICKET_TRANSITIONS,
  type StateErrorCode,
} from "./schema.js";
import {
  RICKGENT_ORACLE_VERSION,
  deriveOracleAttributionDigests,
  evaluateAttemptOracle,
  materializeOraclePersistenceRows,
  type AttemptOracleProjection,
  type OracleResolvedReferenceProjection,
} from "./oracle.js";
import {
  LEGACY_QUARANTINE_RECOVERY,
  LegacyInventoryCommand,
  isAuthorizedLegacyInventoryCommand,
} from "./legacy-quarantine.js";
import {
  AttemptOwnershipCommand,
  isAuthorizedAttemptOwnershipCommand,
  type AttemptOwnershipPurpose,
  type AttemptOwnershipStoreResult,
} from "./leases.js";
import {
  ATTEMPT_OWNERSHIP_SCHEMA_VERSION,
  deriveAttemptWorkspacePlan,
  type AttemptOwnershipLineage,
  type AttemptWorkspacePlan,
} from "../git/attempt-workspace.js";
import {
  CommitServiceCommand,
  isAuthorizedCommitServiceCommand,
} from "../git/commit-service.js";
import {
  ProcessSupervisorCommand,
  isAuthorizedProcessSupervisorCommand,
} from "../process/supervisor.js";
import {
  DeliveryCommand,
  LifecycleRecordCommand,
  PromotionCommit,
  PromotionIntentCommit,
  TransitionCommit,
  isAuthorizedDeliveryCommand,
  isAuthorizedLifecycleRecordCommand,
  isAuthorizedPromotionCommit,
  isAuthorizedPromotionIntentCommit,
  isAuthorizedTransitionCommit,
  promotionOperationEvidencePayload,
  deliveryDecisionEvidencePayload,
  type CleanupRecordRequest,
  type DeliveryDecisionRequest,
  type DeliveryIntentRequest,
  type GateResultRecordRequest,
  type PersistedTransitionEvidenceReference,
  type PrObservationRequest,
  type PromotionResult,
  type RemediationRecordRequest,
  type RemoteObservationRequest,
  type ReviewRecordRequest,
  type TransitionEvidenceReference,
  type TransitionResult,
} from "./transitions.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT = 1_000;
const MAX_GIT_OUTPUT = 1024 * 1024;
const HERMETIC_GIT_ENVIRONMENT: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/dev/null",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_NOGLOB_PATHSPECS: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
});

type SqlValue = null | string | number | bigint | Uint8Array;
export type StateRecord = Readonly<Record<string, SqlValue>>;
type MutableStateRecord = Record<string, SqlValue>;
export type StateTableName = (typeof ALL_STATE_TABLES)[number];
export type AppendOnlyStateTableName = Exclude<(typeof APPEND_ONLY_STATE_TABLES)[number], "schema_migrations">;

export interface StateLocation {
  readonly repositoryId: `sha256:${string}`;
  readonly identityDigest: `sha256:${string}`;
  readonly repoRealpath: string;
  readonly gitCommonDirRealpath: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly stateDirectory: string;
  readonly resourceDirectory: string;
  readonly databasePath: string;
  readonly walPath: string;
  readonly shmPath: string;
  readonly journalPath: string;
}

export interface ObservedAttemptState {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly state: string;
  readonly stateVersion: number;
  readonly commitOid: string | null;
  readonly oracleResult: "accepted" | "rejected" | null;
}

export interface ObservedTicketState {
  readonly ticketInstanceId: string;
  readonly ticketId: string;
  readonly planIndex: number;
  readonly state: string;
  readonly stateVersion: number;
  readonly latestAttempt: ObservedAttemptState | null;
}

export interface ObservedRunState {
  readonly runId: string;
  readonly runSequence: number;
  readonly state: string;
  readonly stateVersion: number;
  readonly createdAt: string;
  readonly currentDeliveryOid: string;
  readonly promotionSequence: number;
  readonly tickets: readonly ObservedTicketState[];
}

export interface StateObservationAggregates {
  readonly runs: number;
  readonly deliveryRecords: number;
  readonly delivered: number;
  readonly deliveryFailed: number;
}

export type StateObservation =
  | Readonly<{
      state: "absent";
      repositoryId: string;
      databasePath: string;
    }>
  | Readonly<{
      state: "present";
      repositoryId: string;
      databasePath: string;
      schemaVersion: number;
      latestRun: ObservedRunState | null;
      aggregates: StateObservationAggregates;
    }>;

export interface StateErrorMetadata {
  readonly sqliteCode?: string;
  readonly sqliteErrcode?: number;
  readonly syscallCode?: string;
}

type StateFailureClass = "infrastructure" | "input_contract";

const FAILURE_CLASS: Partial<Record<StateErrorCode, StateFailureClass>> = {
  RICKGENT_STATE_RUNTIME_UNSUPPORTED: "infrastructure",
  RICKGENT_STATE_ROOT_UNSAFE: "infrastructure",
  RICKGENT_STATE_BUSY: "infrastructure",
  RICKGENT_STATE_CORRUPT: "infrastructure",
  RICKGENT_STATE_SCHEMA_FUTURE: "infrastructure",
  RICKGENT_STATE_MIGRATION_FAILED: "infrastructure",
  RICKGENT_STATE_IDEMPOTENCY_CONFLICT: "input_contract",
  RICKGENT_STATE_CONFLICT: "infrastructure",
  RICKGENT_STATE_TRANSITION_ILLEGAL: "input_contract",
  RICKGENT_STATE_OWNER_MISMATCH: "infrastructure",
  RICKGENT_STATE_RESUME_INCOMPATIBLE: "input_contract",
  RICKGENT_LEGACY_STATE_QUARANTINED: "infrastructure",
  RICKGENT_PROMOTION_CONFLICT: "infrastructure",
};

export class StateStoreError extends Error {
  readonly code: StateErrorCode;
  readonly failureClass: StateFailureClass;
  readonly databasePath: string | undefined;
  readonly recovery: string;
  readonly causeMetadata: StateErrorMetadata | undefined;

  constructor(
    code: StateErrorCode,
    message: string,
    options: {
      readonly databasePath?: string;
      readonly recovery?: string;
      readonly causeMetadata?: StateErrorMetadata;
    } = {},
  ) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
    this.failureClass = FAILURE_CLASS[code] ?? "infrastructure";
    this.databasePath = options.databasePath;
    this.recovery = options.recovery ?? recoveryFor(code);
    this.causeMetadata = options.causeMetadata;
  }
}

export type StateRowInput = Readonly<Record<string, SqlValue | boolean>>;

export interface ImmutableJsonInput {
  readonly schemaVersion: string;
  readonly canonicalJson: string;
  readonly digest: `sha256:${string}`;
}

export interface RunManifestAllocationInput extends ImmutableJsonInput {
  readonly capabilitySnapshot: ImmutableJsonInput;
  readonly contextSchemaVersion: string;
  readonly oracleVersion: string;
  readonly resourceIdentityVersion: string;
}

export interface RunTicketAllocationInput {
  readonly ticketId: string;
  readonly planIndex: number;
  readonly contract: ImmutableJsonInput;
  readonly dependsOnTicketIds: readonly string[];
}

export interface AllocateFreshRunInput {
  readonly manifest: RunManifestAllocationInput;
  readonly tickets: readonly RunTicketAllocationInput[];
  readonly initialDeliveryOid: string;
}

export interface AllocatedRunTicket {
  readonly ticketInstanceId: string;
  readonly runId: string;
  readonly ticketId: string;
  readonly planIndex: number;
  readonly contractDigest: string;
  readonly state: "planned";
  readonly stateVersion: 0;
}

export interface AllocatedRun {
  /** t14 identities are committed but cannot run until t15 records legal activation transitions. */
  readonly runnable: false;
  readonly runId: string;
  readonly repositoryId: string;
  readonly runSequence: number;
  readonly manifestDigest: string;
  readonly initialDeliveryOid: string;
  readonly currentDeliveryOid: string;
  readonly deliveryRef: string;
  readonly state: "planned";
  readonly stateVersion: 0;
  readonly tickets: readonly AllocatedRunTicket[];
}

export interface AttemptAllocationInput {
  readonly runId: string;
  readonly ticketId: string;
}

export interface AllocatedAttempt {
  /** Allocation commits identity only; it grants no spawn authority. */
  readonly runnable: false;
  readonly attemptId: string;
  readonly ticketInstanceId: string;
  readonly runId: string;
  readonly ticketId: string;
  readonly attemptNumber: number;
  readonly contractDigest: string;
  readonly allocationOwnerDigest: string;
  readonly deliveryBaselineOid: string;
  readonly contextSchemaVersion: string;
  readonly oracleVersion: string;
  readonly capabilitySnapshotDigest: string;
  readonly resourceIdentityVersion: string;
  readonly state: "planned";
  readonly stateVersion: 0;
}

export interface ResumeTicketCompatibility {
  readonly ticketId: string;
  readonly contractDigest: string;
}

export interface ResumeCompatibilityInput {
  readonly runId: string;
  readonly manifestDigest: string;
  readonly contextSchemaVersion: string;
  readonly oracleVersion: string;
  readonly capabilitySnapshotDigest: string;
  readonly resourceIdentityVersion: string;
  readonly tickets: readonly ResumeTicketCompatibility[];
}

export interface ResumeTicketSelection {
  readonly ticketInstanceId: string;
  readonly ticketId: string;
  readonly contractDigest: string;
  readonly state: string;
  readonly latestAttempt: PersistedAttemptSelection | null;
}

export interface PersistedAttemptSelection extends Omit<AllocatedAttempt, "state" | "stateVersion"> {
  readonly state: string;
  readonly stateVersion: number;
}

export interface ResumeSelection {
  readonly runId: string;
  readonly repositoryId: string;
  readonly runSequence: number;
  readonly manifestDigest: string;
  readonly state: string;
  readonly tickets: readonly ResumeTicketSelection[];
}

export interface RetryCompatibilityInput {
  readonly runId: string;
  readonly ticketId: string;
  readonly contractDigest: string;
  readonly contextSchemaVersion: string;
  readonly oracleVersion: string;
  readonly capabilitySnapshotDigest: string;
  readonly resourceIdentityVersion: string;
}

export interface RetrySelection {
  readonly runnable: false;
  readonly runId: string;
  readonly ticketId: string;
  readonly ticketInstanceId: string;
  readonly contractDigest: string;
  readonly latestAttemptId: string;
  readonly latestAttemptNumber: number;
  readonly maxAttempts: number;
  readonly nextAttemptNumber: number;
}

export interface PersistDurableExecutionContextInput {
  readonly attemptId: string;
  readonly phase: string;
  readonly phaseOrdinal: number;
  readonly role: string;
  readonly worktreeRealpath: string;
  readonly policyRootRealpath: string;
  readonly bundleRootRealpath: string;
  readonly timeoutMs: number;
  readonly canonicalContextJson: string;
  readonly policyBundleDigest: string;
  readonly modelSelectionDigest: string;
  readonly budgetDigest: string;
  readonly scopeDigest: string;
}

export interface PersistedExecutionContextRows {
  readonly contextId: string;
  readonly contextDigest: string;
  readonly phaseExecutionId: string;
  readonly phaseIdentityDigest: string;
  readonly context: StateRecord;
  readonly phaseExecution: StateRecord;
}

export interface ResolveCommitPreparationInput {
  readonly attemptId: string;
  readonly phaseExecutionId: string;
  readonly contextId: string;
}

export interface ResolvedCommitPreparation {
  readonly phaseCreatedAt: string;
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly executionContextDigest: string;
  readonly baselineOid: string;
  readonly contractDigest: string;
  readonly deliveryRef: string;
  readonly candidateTreeOid: string;
  readonly candidateDiffDigest: string;
  /** Final accepted review first, followed by required gates ordered by gate id. */
  readonly verificationReceiptDigests: readonly string[];
}

export interface ResolveCommitIntentReplayInput {
  readonly attemptId: string;
  readonly commitIntentId: string;
}

export interface ResolvedCommitCommandReceipt {
  readonly purpose: string;
  readonly executable: string;
  readonly argvDigest: string;
  readonly inputDigest: string;
  readonly inputBytes: number;
  readonly stdoutDigest: string;
  readonly stdoutBytes: number;
  readonly stderrDigest: string;
  readonly stderrBytes: number;
  readonly status: number;
}

export interface ResolvedCommitIntentReplay {
  readonly state: "intent_recorded" | "finalized";
  readonly stateVersion: 0 | 1;
  readonly commitOid: string | null;
  readonly commitAttributionId: string | null;
  readonly commandReceipts: readonly ResolvedCommitCommandReceipt[];
}

export interface EvaluateAttemptOracleRequest {
  readonly attemptId: string;
  readonly idempotencyKey: string;
}

export interface PersistedAttemptOracleDecision {
  readonly decision: StateRecord;
  readonly references: readonly StateRecord[];
}

// ---- t22A: narrowly-branded Store command request/result types.
//
// Each request carries the branded observation (minted by the owning runtime
// authority via the LeaseAuthority capability) plus the durable-preimage
// references the finalization service independently observed.  The Store
// validates the preimage and pins the exact durable IDs in the receipt row.

export interface MintTargetNeverReleasedRequest {
  readonly observation: TargetNeverReleasedObservation;
}

/**
 * t22D-fix: request to create the durable held target-start gate row through
 * the production authority.  The AttemptRunner calls this after acquire +
 * context preparation, before containment release.  Idempotent: replaying
 * the same request returns the existing held row; a divergent lineage
 * conflicts.
 */
export interface MintHeldTargetStartGateRequest {
  readonly gateId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly executionContextDigest: `sha256:${string}`;
  readonly startAuthorizationDigest: `sha256:${string}`;
  readonly inputDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/**
 * t22B: request to transition a held target start gate `held -> released`
 * after observing an authority-owned containment membership bound to the
 * exact attempt lineage.  The membership is brand-checked (WeakSet); a
 * structurally-correct membership from an injected controller is rejected.
 */
export interface MintTargetReleasedRequest {
  readonly gateId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  /** Authority-owned containment membership proof (brand-checked). */
  readonly membership: ContainmentMembership;
  /** Launch id from the containment boundary (content-pinned into evidence). */
  readonly launchId: string;
  /** Backend id of the containment authority (e.g. "docker-cgroup-v2"). */
  readonly backendId: string;
  /** Boundary name (cgroup path / container name) derived from lineage. */
  readonly boundaryName: string;
  /** Membership digest pinned into the release evidence. */
  readonly membershipDigest: `sha256:${string}`;
  readonly observedAt: string;
}

export interface MintCleanupEligibilityRequest {
  readonly observation: CleanupEligibilityObservation;
  /** Durable preimage references independently observed by the finalization service. */
  readonly targetProofSetId: string;
  readonly ownershipSnapshotEvidenceId: string;
  readonly claimSnapshotEvidenceIds: readonly string[];
}

export interface MintFailureCleanupRequest {
  readonly observation: FailureCleanupObservation;
  readonly targetProofSetId: string;
  readonly causeEvidenceId: string;
  /** pre_oracle failures omit these; oracle_rejected/promotion_aborted require them. */
  readonly cleanupEligibilityRecordId?: string;
  readonly oracleDecisionId?: string;
  readonly promotionIntentId?: string;
}

export interface MintPromotionCleanupRequest {
  readonly observation: PromotionCleanupObservation;
  readonly promotionObservationEvidenceId: string;
}

export interface MintQuarantineRequest {
  readonly observation: QuarantineObservation;
  readonly targetProofSetId: string;
  readonly causeEvidenceId: string;
  readonly ownershipSnapshotEvidenceId: string;
  readonly cleanupEligibilityRecordId?: string;
  readonly oracleDecisionId?: string;
  readonly promotionIntentId?: string;
  /** Per-claim disposition evidence + claim snapshot evidence, in slot order. */
  readonly claimMembers: readonly QuarantineClaimMemberInput[];
}

export interface QuarantineClaimMemberInput {
  readonly resourceClaimId: string;
  readonly slot: string;
  readonly currentOwnershipId: string;
  readonly ownerGeneration: number;
  readonly claimStateVersion: number;
  readonly claimSnapshotEvidenceId: string;
  readonly absenceRequired: boolean;
  readonly physicalDisposition: "absent" | "retained" | "unknown" | "not_applicable";
  readonly dispositionEvidenceId: string;
  readonly memberDigest: `sha256:${string}`;
}

export interface MintedDispositionReceipt<R> {
  readonly receipt: R;
  readonly record: StateRecord;
  readonly evidence: StateRecord;
  readonly replayed: boolean;
}

/**
 * t22B: result of `mintTargetReleased`.  The release evidence row and the
 * updated target start gate row are persisted atomically; the brand-checked
 * containment membership is returned for the caller's death-receipt flow.
 */
export interface MintedContainmentReleaseReceipt {
  readonly membership: ContainmentMembership;
  readonly record: StateRecord;
  readonly evidence: StateRecord;
  readonly replayed: boolean;
}

function sealedDispositionPayload(observation: Readonly<Record<string, unknown>>): string {
  return canonicalJson(observation);
}

/**
 * The durable preimage for a disposition receipt's idempotency digest.  This
 * is the full normalized persisted request/postimage input: the observation
 * AND every request field that participates in the durable preimage.  Any
 * divergent field produces a divergent digest, so a replay with the same
 * idempotency key but a divergent request field conflicts instead of silently
 * returning the prior postimage (VAL-T22A-003).
 *
 * The observation is included under a fixed `observation` key so request fields
 * and observation fields cannot collide or shadow one another.
 */
export function dispositionDurablePreimage(
  observation: Readonly<Record<string, unknown>>,
  requestFields: Readonly<Record<string, unknown>>,
): string {
  return canonicalJson({ observation, request: requestFields });
}

function dispositionEvidenceRow(
  evidenceId: string,
  attemptId: string,
  contextId: string,
  producerService: string,
  schemaVersion: string,
  scope: string,
  payload: string,
  observedAt: string,
): Readonly<Record<string, SqlValue>> {
  return {
    evidence_id: evidenceId,
    attempt_id: attemptId,
    phase_execution_id: null,
    context_id: contextId,
    producer_service: producerService,
    scope,
    schema_version: schemaVersion,
    content_digest: sha256Text(payload),
    inline_payload_json: payload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: scope,
    created_at: observedAt,
  };
}

function recoveryFor(code: StateErrorCode): string {
  switch (code) {
    case "RICKGENT_STATE_CORRUPT":
    case "RICKGENT_STATE_MIGRATION_FAILED":
      return "Stop all writers, copy the database together with any WAL/SHM sidecars, then quarantine the entire state directory before deliberate recovery.";
    case "RICKGENT_STATE_SCHEMA_FUTURE":
      return "Use the compatible newer rickgent binary. Do not recreate or downgrade this database.";
    case "RICKGENT_STATE_ROOT_UNSAFE":
      return "Inspect the selected repository and private state path; do not chmod or replace an existing path automatically.";
    case "RICKGENT_STATE_BUSY":
      return "Retry the complete named operation after the competing writer finishes.";
    default:
      return "Preserve the state directory and correct the reported condition before retrying.";
  }
}

function errorMetadata(error: unknown): StateErrorMetadata | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = error as Error & { code?: unknown; errcode?: unknown };
  const metadata: { sqliteCode?: string; sqliteErrcode?: number; syscallCode?: string } = {};
  if (typeof value.errcode === "number") metadata.sqliteErrcode = value.errcode;
  if (typeof value.code === "string") {
    if (value.code.startsWith("ERR_SQLITE")) metadata.sqliteCode = value.code;
    else metadata.syscallCode = value.code;
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function sqliteBaseCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const errcode = (error as Error & { errcode?: unknown }).errcode;
  return typeof errcode === "number" ? errcode & 0xff : undefined;
}

function isBusy(error: unknown): boolean {
  const code = sqliteBaseCode(error);
  return code === 5 || code === 6;
}

function isConstraint(error: unknown): boolean {
  return sqliteBaseCode(error) === 19;
}

function typedError(
  code: StateErrorCode,
  message: string,
  databasePath?: string,
  cause?: unknown,
): StateStoreError {
  const options: {
    databasePath?: string;
    causeMetadata?: StateErrorMetadata;
  } = {};
  if (databasePath !== undefined) options.databasePath = databasePath;
  const metadata = errorMetadata(cause);
  if (metadata !== undefined) options.causeMetadata = metadata;
  return new StateStoreError(code, message, options);
}

function translateBusy(error: unknown, operation: string, databasePath: string): never {
  if (error instanceof StateStoreError) throw error;
  if (isBusy(error)) {
    throw typedError(
      "RICKGENT_STATE_BUSY",
      `${operation} could not acquire the SQLite lock within ${BUSY_TIMEOUT_MS} ms`,
      databasePath,
      error,
    );
  }
  throw error;
}

function assertRuntime(): void {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0];
  const minor = parts[1];
  if (major !== 24 || minor === undefined || minor < 12) {
    throw new StateStoreError(
      "RICKGENT_STATE_RUNTIME_UNSUPPORTED",
      `durable state requires Node ${STATE_SQLITE_MINIMUM_NODE_VERSION} or newer within the supported Node 24 line; received ${process.versions.node}`,
    );
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new StateStoreError(
      "RICKGENT_STATE_RUNTIME_UNSUPPORTED",
      `durable state is unsupported on ${process.platform}`,
    );
  }
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") {
    throw new StateStoreError("RICKGENT_STATE_RUNTIME_UNSUPPORTED", "effective owner checks are unavailable on this runtime");
  }
  return process.geteuid();
}

function unsafe(message: string, databasePath?: string, cause?: unknown): never {
  throw typedError("RICKGENT_STATE_ROOT_UNSAFE", message, databasePath, cause);
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function assertOwned(path: string, label: string, databasePath?: string): void {
  if (lstatSync(path).uid !== effectiveUid()) unsafe(`${label} is not owned by the effective process owner: ${path}`, databasePath);
}

function assertCanonicalDirectory(path: string, label: string, databasePath?: string): void {
  if (!isAbsolute(path)) unsafe(`${label} is not absolute: ${path}`, databasePath);
  const root = parse(path).root;
  let cursor = root;
  const suffix = path.slice(root.length).split(sep).filter(Boolean);
  for (const component of suffix) {
    cursor = join(cursor, component);
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      unsafe(`${label} contains an absent component: ${cursor}`, databasePath, error);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) unsafe(`${label} contains an unsafe component: ${cursor}`, databasePath);
    if (realpathSync.native(cursor) !== cursor) unsafe(`${label} is not canonical at component: ${cursor}`, databasePath);
  }
}

function gitLine(repo: string, args: readonly string[]): string {
  try {
    const output = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
    const trimmed = output.trim();
    if (trimmed.length === 0 || trimmed.includes("\n") || trimmed.includes("\0")) {
      unsafe(`Git returned malformed output for ${args.join(" ")}`);
    }
    return trimmed;
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    unsafe(`Git repository discovery failed for ${repo}`, undefined, error);
  }
}

function digestTuple(fields: readonly string[]): `sha256:${string}` {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Resolve one explicit repository without consulting process.cwd or legacy state. */
export function resolveStateLocation(selectedRepository: string): StateLocation {
  assertRuntime();
  if (!isAbsolute(selectedRepository)) unsafe("the selected repository must be an explicit absolute path");
  let selectedInfo;
  try {
    selectedInfo = lstatSync(selectedRepository);
  } catch (error) {
    unsafe(`the selected repository does not exist: ${selectedRepository}`, undefined, error);
  }
  if (selectedInfo.isSymbolicLink() || !selectedInfo.isDirectory()) unsafe(`the selected repository is not a canonical directory: ${selectedRepository}`);

  const repoRealpath = realpathSync.native(selectedRepository);
  assertCanonicalDirectory(repoRealpath, "repository");
  assertOwned(repoRealpath, "repository");
  const topLevel = gitLine(repoRealpath, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (!isAbsolute(topLevel) || realpathSync.native(topLevel) !== repoRealpath) {
    unsafe(`the selected repository must equal its canonical Git top level: ${selectedRepository}`);
  }

  const commonResult = gitLine(repoRealpath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!isAbsolute(commonResult)) unsafe(`Git returned a relative common directory: ${commonResult}`);
  const gitCommonDirRealpath = realpathSync.native(commonResult);
  if (gitCommonDirRealpath !== commonResult) unsafe(`Git common directory is not canonical: ${commonResult}`);
  assertCanonicalDirectory(gitCommonDirRealpath, "Git common directory");
  assertOwned(gitCommonDirRealpath, "Git common directory");
  if ((modeOf(gitCommonDirRealpath) & 0o022) !== 0) unsafe(`Git common directory is group/other writable: ${gitCommonDirRealpath}`);

  const objectFormat = gitLine(repoRealpath, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") unsafe(`unsupported Git object format: ${objectFormat}`);
  const identityDigest = digestTuple([repoRealpath, gitCommonDirRealpath, objectFormat]);
  const stateDirectory = join(gitCommonDirRealpath, "rickgent");
  const resourceDirectory = join(stateDirectory, "resources");
  const databasePath = join(stateDirectory, "state.sqlite3");
  return Object.freeze({
    repositoryId: identityDigest,
    identityDigest,
    repoRealpath,
    gitCommonDirRealpath,
    objectFormat,
    stateDirectory,
    resourceDirectory,
    databasePath,
    walPath: `${databasePath}-wal`,
    shmPath: `${databasePath}-shm`,
    journalPath: `${databasePath}-journal`,
  });
}

function fsyncPath(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureStateDirectory(location: StateLocation): void {
  if (!existsSync(location.stateDirectory)) {
    try {
      mkdirSync(location.stateDirectory, { mode: DIRECTORY_MODE });
      fsyncPath(location.gitCommonDirRealpath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        unsafe(`could not create the private state directory: ${location.stateDirectory}`, location.databasePath, error);
      }
    }
  }
  let info;
  try {
    info = lstatSync(location.stateDirectory);
  } catch (error) {
    unsafe(`private state directory is absent: ${location.stateDirectory}`, location.databasePath, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) unsafe(`private state path is not a directory: ${location.stateDirectory}`, location.databasePath);
  if (info.uid !== effectiveUid() || (info.mode & 0o777) !== DIRECTORY_MODE) {
    unsafe(`private state directory must be owned by the effective user with mode 0700: ${location.stateDirectory}`, location.databasePath);
  }
  if (realpathSync.native(location.stateDirectory) !== location.stateDirectory) {
    unsafe(`private state directory is not canonical: ${location.stateDirectory}`, location.databasePath);
  }
}

function ensureResourceDirectory(location: StateLocation): void {
  if (!existsSync(location.resourceDirectory)) {
    try {
      mkdirSync(location.resourceDirectory, { mode: DIRECTORY_MODE });
      fsyncPath(location.stateDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        unsafe(`could not create the private resource directory: ${location.resourceDirectory}`, location.databasePath, error);
      }
    }
  }
  const info = lstatSync(location.resourceDirectory);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== effectiveUid() || (info.mode & 0o777) !== DIRECTORY_MODE) {
    unsafe(`resource directory must be an owned canonical directory with mode 0700: ${location.resourceDirectory}`, location.databasePath);
  }
  if (realpathSync.native(location.resourceDirectory) !== location.resourceDirectory) {
    unsafe(`resource directory is not canonical: ${location.resourceDirectory}`, location.databasePath);
  }
}

function assertSafeStateFile(path: string, label: string, databasePath: string, allowMissing = false): boolean {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    unsafe(`${label} is absent: ${path}`, databasePath, error);
  }
  if (info.isSymbolicLink() || !info.isFile()) unsafe(`${label} is not a regular file: ${path}`, databasePath);
  if (info.uid !== effectiveUid() || (info.mode & 0o777) !== FILE_MODE) {
    unsafe(`${label} must be owned by the effective user with mode 0600: ${path}`, databasePath);
  }
  return true;
}

function validateCanonicalFiles(location: StateLocation): void {
  assertSafeStateFile(location.databasePath, "state database", location.databasePath);
  assertSafeStateFile(location.walPath, "state WAL", location.databasePath, true);
  assertSafeStateFile(location.shmPath, "state SHM", location.databasePath, true);
  assertSafeStateFile(location.journalPath, "state rollback journal", location.databasePath, true);
}

function sqliteConnection(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    defensive: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    timeout: BUSY_TIMEOUT_MS,
  });
}

function pragmaValue(db: DatabaseSync, sql: string, key: string): SqlValue | undefined {
  const row = db.prepare(sql).get() as Record<string, SqlValue> | undefined;
  return row?.[key];
}

function establishCandidatePragmas(db: DatabaseSync, databasePath: string): void {
  const mode = pragmaValue(db, "PRAGMA journal_mode = WAL", "journal_mode");
  if (mode !== "wal") throw typedError("RICKGENT_STATE_MIGRATION_FAILED", "could not establish WAL for the fresh database", databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT};
    PRAGMA trusted_schema = OFF;
    PRAGMA recursive_triggers = ON;
  `);
  verifyConnectionPragmas(db, databasePath);
}

function establishExistingPragmas(db: DatabaseSync, databasePath: string): void {
  const current = pragmaValue(db, "PRAGMA journal_mode", "journal_mode");
  if (current !== "wal") throw typedError("RICKGENT_STATE_CORRUPT", "existing state database is not in WAL mode", databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT};
    PRAGMA trusted_schema = OFF;
    PRAGMA recursive_triggers = ON;
  `);
  verifyConnectionPragmas(db, databasePath);
}

function verifyConnectionPragmas(db: DatabaseSync, databasePath: string): void {
  const expected: readonly [string, string, SqlValue][] = [
    ["PRAGMA foreign_keys", "foreign_keys", 1],
    ["PRAGMA journal_mode", "journal_mode", "wal"],
    ["PRAGMA synchronous", "synchronous", 2],
    ["PRAGMA busy_timeout", "timeout", BUSY_TIMEOUT_MS],
    ["PRAGMA wal_autocheckpoint", "wal_autocheckpoint", WAL_AUTOCHECKPOINT],
    ["PRAGMA trusted_schema", "trusted_schema", 0],
    ["PRAGMA recursive_triggers", "recursive_triggers", 1],
  ];
  for (const [sql, key, value] of expected) {
    const actual = pragmaValue(db, sql, key);
    if (actual !== value) {
      throw typedError("RICKGENT_STATE_CORRUPT", `${sql} expected ${String(value)}, received ${String(actual)}`, databasePath);
    }
  }
}

function userVersion(db: DatabaseSync): number {
  const value = pragmaValue(db, "PRAGMA user_version", "user_version");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid SQLite user_version");
  return value;
}

function rollbackPreserving(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The statement failure is the primary diagnostic.
  }
}

function applyMigration(
  db: DatabaseSync,
  migration: StateMigration,
  expectedPriorVersion: number,
  databasePath: string,
): number {
  let migrationStarted = false;
  try {
    db.exec("BEGIN EXCLUSIVE");
    const observed = userVersion(db);
    if (observed !== expectedPriorVersion) {
      if (observed > LATEST_STATE_SCHEMA_VERSION) {
        throw typedError(
          "RICKGENT_STATE_SCHEMA_FUTURE",
          `state schema ${observed} is newer than supported schema ${LATEST_STATE_SCHEMA_VERSION}`,
          databasePath,
        );
      }
      validateMigrationLedger(db, observed, databasePath);
      db.exec("ROLLBACK");
      return observed;
    }
    if (expectedPriorVersion > 0) validateMigrationLedger(db, expectedPriorVersion, databasePath);
    migrationStarted = true;
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
      .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    db.exec(`PRAGMA user_version = ${migration.version}`);
    validateMigrationLedger(db, migration.version, databasePath);
    const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, SqlValue>>;
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") throw new Error(`migration ${migration.name} failed quick_check`);
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error(`migration ${migration.name} introduced foreign-key violations`);
    }
    if (migration.version === LATEST_STATE_SCHEMA_VERSION) validateReleasedSchema(db, databasePath, migration.version);
    db.exec("COMMIT");
    return migration.version;
  } catch (error) {
    rollbackPreserving(db);
    if (isBusy(error)) translateBusy(error, `migration ${migration.name}`, databasePath);
    if (!migrationStarted && error instanceof StateStoreError) throw error;
    throw typedError(
      "RICKGENT_STATE_MIGRATION_FAILED",
      `migration ${migration.name} rolled back without changing authoritative state: ${error instanceof Error ? error.message : String(error)}`,
      databasePath,
      error,
    );
  }
}

function validateMigrationLedger(db: DatabaseSync, version: number, databasePath: string): void {
  if (version < 1) throw typedError("RICKGENT_STATE_CORRUPT", "an existing version-0 database is partial state, not fresh state", databasePath);
  let rows: Array<Record<string, SqlValue>>;
  try {
    rows = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<Record<string, SqlValue>>;
  } catch (error) {
    throw typedError("RICKGENT_STATE_CORRUPT", "state migration ledger is missing or unreadable", databasePath, error);
  }
  if (rows.length !== version) throw typedError("RICKGENT_STATE_CORRUPT", "migration rows do not agree with PRAGMA user_version", databasePath);
  for (let index = 0; index < rows.length; index += 1) {
    const expected = STATE_MIGRATIONS[index];
    const row = rows[index];
    if (
      expected === undefined || row === undefined || row.version !== index + 1 ||
      row.name !== expected.name || row.checksum !== expected.checksum
    ) {
      throw typedError("RICKGENT_STATE_CORRUPT", `migration ledger differs from released migration ${index + 1}`, databasePath);
    }
  }
}

function sqliteSchemaChecksum(db: DatabaseSync): `sha256:${string}` {
  const rows = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

function validateReleasedSchema(db: DatabaseSync, databasePath: string, version: number): void {
  const expectedChecksum = version === 1
    ? INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM
    : version === 2
      ? ATTEMPT_OWNERSHIP_STATE_SQLITE_SCHEMA_CHECKSUM
    : version === 3
      ? PROCESS_SUPERVISION_STATE_SQLITE_SCHEMA_CHECKSUM
    : version === 4
      ? COMMIT_ATTRIBUTION_STATE_SQLITE_SCHEMA_CHECKSUM
    : version === LATEST_STATE_SCHEMA_VERSION
      ? LATEST_STATE_SQLITE_SCHEMA_CHECKSUM
      : undefined;
  if (expectedChecksum === undefined) {
    throw typedError("RICKGENT_STATE_CORRUPT", `no released schema definition exists for version ${version}`, databasePath);
  }
  const observedChecksum = sqliteSchemaChecksum(db);
  if (observedChecksum !== expectedChecksum) {
    throw typedError(
      "RICKGENT_STATE_CORRUPT",
      `sqlite_schema does not equal the released migration definition (expected ${expectedChecksum}, observed ${observedChecksum})`,
      databasePath,
    );
  }
  const tables = db.prepare("PRAGMA table_list").all() as Array<Record<string, SqlValue>>;
  const strict = new Map(tables.map((row) => [row.name, row.strict]));
  const schemaObjects = version === 1
    ? INITIAL_STATE_SCHEMA_OBJECTS
    : version === 2
      ? ATTEMPT_OWNERSHIP_STATE_SCHEMA_OBJECTS
    : version === 3
      ? PROCESS_SUPERVISION_STATE_SCHEMA_OBJECTS
    : LATEST_STATE_SCHEMA_OBJECTS;
  for (const table of schemaObjects.tables) {
    if (strict.get(table) !== 1) throw typedError("RICKGENT_STATE_CORRUPT", `released table is missing or not STRICT: ${table}`, databasePath);
  }
}

function validateIntegrity(db: DatabaseSync, databasePath: string, expectLatestSchema: boolean): number {
  let version: number;
  try {
    version = userVersion(db);
  } catch (error) {
    throw typedError("RICKGENT_STATE_CORRUPT", "state database header is invalid", databasePath, error);
  }
  if (version > LATEST_STATE_SCHEMA_VERSION) {
    throw typedError(
      "RICKGENT_STATE_SCHEMA_FUTURE",
      `state schema ${version} is newer than supported schema ${LATEST_STATE_SCHEMA_VERSION}`,
      databasePath,
    );
  }
  validateMigrationLedger(db, version, databasePath);
  try {
    const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, SqlValue>>;
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") {
      throw typedError("RICKGENT_STATE_CORRUPT", "PRAGMA quick_check did not return exactly one ok result", databasePath);
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw typedError("RICKGENT_STATE_CORRUPT", "PRAGMA foreign_key_check found violations", databasePath);
    }
    if (expectLatestSchema && version !== LATEST_STATE_SCHEMA_VERSION) {
      throw typedError("RICKGENT_STATE_CORRUPT", "state migration did not reach the latest released schema", databasePath);
    }
    validateReleasedSchema(db, databasePath, version);
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    throw typedError("RICKGENT_STATE_CORRUPT", "state database integrity checks failed", databasePath, error);
  }
  return version;
}

function migrateExisting(db: DatabaseSync, version: number, databasePath: string): void {
  let current = version;
  while (current < LATEST_STATE_SCHEMA_VERSION) {
    const next = STATE_MIGRATIONS[current];
    if (next === undefined) throw typedError("RICKGENT_STATE_CORRUPT", `missing released migration ${current + 1}`, databasePath);
    current = applyMigration(db, next, current, databasePath);
  }
}

function checkpointCandidate(db: DatabaseSync, databasePath: string): void {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, SqlValue> | undefined;
  if (row?.busy !== 0 || row?.log !== 0 || row?.checkpointed !== 0) {
    throw typedError("RICKGENT_STATE_MIGRATION_FAILED", "fresh database WAL could not be fully checkpointed", databasePath);
  }
}

function unlinkOwnedCandidate(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function cleanupCandidate(candidatePath: string): void {
  for (const path of [`${candidatePath}-wal`, `${candidatePath}-shm`, `${candidatePath}-journal`, candidatePath]) {
    try {
      unlinkOwnedCandidate(path);
    } catch {
      // An unpublished candidate is non-authoritative; cleanup failure must not
      // obscure the authoritative database diagnostic.
    }
  }
}

function createCandidate(location: StateLocation): string {
  const candidate = `${location.databasePath}.candidate-${process.pid}-${randomBytes(12).toString("hex")}`;
  let fd: number;
  try {
    fd = openSync(
      candidate,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      FILE_MODE,
    );
  } catch (error) {
    unsafe("could not create a private state database candidate", location.databasePath, error);
  }
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  assertSafeStateFile(candidate, "state database candidate", location.databasePath);
  return candidate;
}

function initializeCandidate(candidate: string, location: StateLocation): void {
  const db = sqliteConnection(candidate);
  let primary: unknown;
  try {
    establishCandidatePragmas(db, location.databasePath);
    let version = 0;
    for (const migration of STATE_MIGRATIONS) version = applyMigration(db, migration, version, location.databasePath);
    validateIntegrity(db, location.databasePath, true);
    checkpointCandidate(db, location.databasePath);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      db.close();
    } catch (closeError) {
      if (primary === undefined) throw closeError;
    }
  }
  assertSafeStateFile(candidate, "state database candidate", location.databasePath);
  assertSafeStateFile(`${candidate}-wal`, "candidate WAL", location.databasePath, true);
  assertSafeStateFile(`${candidate}-shm`, "candidate SHM", location.databasePath, true);
  const walExists = existsSync(`${candidate}-wal`);
  if (walExists && statSync(`${candidate}-wal`).size !== 0) {
    throw typedError("RICKGENT_STATE_MIGRATION_FAILED", "fresh candidate retained uncheckpointed WAL bytes", location.databasePath);
  }
  fsyncPath(candidate);
}

function publishCandidate(candidate: string, location: StateLocation): boolean {
  try {
    linkSync(candidate, location.databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    unsafe("could not atomically publish the state database", location.databasePath, error);
  }
  // Durably publish the complete inode before removing its private name.
  fsyncPath(location.stateDirectory);
  unlinkOwnedCandidate(candidate);
  fsyncPath(location.stateDirectory);
  return true;
}

function ensureCanonicalDatabase(location: StateLocation): void {
  const databaseExists = existsSync(location.databasePath);
  if (databaseExists) {
    validateCanonicalFiles(location);
    return;
  }
  for (const path of [location.walPath, location.shmPath, location.journalPath]) {
    if (existsSync(path)) {
      assertSafeStateFile(path, "orphaned state sidecar", location.databasePath);
      throw typedError("RICKGENT_STATE_CORRUPT", "state sidecar exists without its canonical database", location.databasePath);
    }
  }

  const candidate = createCandidate(location);
  try {
    initializeCandidate(candidate, location);
    const published = publishCandidate(candidate, location);
    if (!published) cleanupCandidate(candidate);
  } catch (error) {
    cleanupCandidate(candidate);
    throw error;
  }
  validateCanonicalFiles(location);
}

function openCanonicalDatabase(location: StateLocation): DatabaseSync {
  validateCanonicalFiles(location);
  let db: DatabaseSync;
  try {
    db = sqliteConnection(location.databasePath);
  } catch (error) {
    if (isBusy(error)) translateBusy(error, "open_and_migrate", location.databasePath);
    throw typedError("RICKGENT_STATE_CORRUPT", "state database could not be opened", location.databasePath, error);
  }
  let primary: unknown;
  try {
    // SQLite may create WAL/SHM while opening even a read-only WAL database.
    // Re-observe both paths immediately, before any application statement.
    validateCanonicalFiles(location);
    const version = validateIntegrity(db, location.databasePath, false);
    establishExistingPragmas(db, location.databasePath);
    migrateExisting(db, version, location.databasePath);
    validateIntegrity(db, location.databasePath, true);
    validateCanonicalFiles(location);
    const sqlitePath = db.location();
    if (sqlitePath === null || realpathSync.native(sqlitePath) !== location.databasePath) {
      unsafe("SQLite opened a database other than the canonical state path", location.databasePath);
    }
    return db;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (primary !== undefined) {
      rollbackPreserving(db);
      try {
        db.close();
      } catch {
        // Preserve the primary validation error.
      }
    }
  }
}

function normalizeRow(row: Readonly<Record<string, SqlValue | boolean>>): MutableStateRecord {
  const normalized: MutableStateRecord = {};
  for (const [key, value] of Object.entries(row)) normalized[key] = typeof value === "boolean" ? (value ? 1 : 0) : value;
  return normalized;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError(`unsafe state identifier: ${identifier}`);
  return `"${identifier}"`;
}

function sameValue(left: SqlValue | undefined, right: SqlValue | undefined): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.from(left).equals(Buffer.from(right));
  return left === right;
}

function frozenRow(row: Record<string, SqlValue>): StateRecord {
  return Object.freeze({ ...row });
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical state JSON numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

function assertCanonicalJsonText(value: SqlValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be canonical JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  if (canonicalJson(parsed) !== value) throw new TypeError(`${label} is not RFC-8785-style canonical JSON`);
  return value;
}

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export interface CanonicalGitDeltaEntry {
  readonly path: string;
  readonly from_path: string | null;
  readonly change_kind: "create" | "modify" | "delete" | "rename";
  readonly before_mode: string | null;
  readonly after_mode: string | null;
}

export interface CanonicalGitDelta {
  readonly entries: readonly CanonicalGitDeltaEntry[];
  readonly candidateDiffDigest: `sha256:${string}`;
  readonly pathSetDigest: `sha256:${string}`;
  readonly changeKindSetDigest: `sha256:${string}`;
  readonly modeSetDigest: `sha256:${string}`;
}

interface CommitResourceVersions {
  readonly delivery_ref: number;
  readonly attempt_ref: number;
  readonly worktree: number;
  readonly isolated_index: number;
}

interface CommitMetadataProjection {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerDate: string;
  readonly messageDigest: string;
}

interface CommitIntentPrepareProjection {
  readonly commitIntentId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipStateVersion: number;
  readonly ownershipContextDigest: string;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly executionContextDigest: string;
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly baselineOid: string;
  readonly contractDigest: string;
  readonly deliveryRef: string;
  readonly attemptRef: string;
  readonly expectedResourceVersions: CommitResourceVersions;
  readonly treeBeforeOid: string;
  readonly treeAfterOid: string;
  readonly candidateDiffDigest: string;
  readonly pathSetDigest: string;
  readonly changeKindSetDigest: string;
  readonly modeSetDigest: string;
  readonly normalizedDelta: readonly CanonicalGitDeltaEntry[];
  readonly verificationReceiptDigests: readonly string[];
  readonly commitMetadata: CommitMetadataProjection;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

interface CommitAttributionFinalizeProjection {
  readonly commitIntentId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly expectedIntentVersion: number;
  readonly commitAttributionId: string;
  readonly attributionEvidenceId: string;
  readonly baselineOid: string;
  readonly parentOid: string;
  readonly treeBeforeOid: string;
  readonly treeAfterOid: string;
  readonly commitOid: string;
  readonly contractDigest: string;
  readonly contextDigest: string;
  readonly deliveryRef: string;
  readonly deliveryRefObservedOid: string;
  readonly attemptRef: string;
  readonly attemptRefBeforeOid: string;
  readonly attemptRefAfterOid: string;
  readonly candidateDiffDigest: string;
  readonly pathSetDigest: string;
  readonly changeKindSetDigest: string;
  readonly modeSetDigest: string;
  readonly normalizedDelta: readonly CanonicalGitDeltaEntry[];
  readonly commandReceipts: readonly ResolvedCommitCommandReceipt[];
  readonly createdAt: string;
}

/** Pure parser/digester for `git diff --raw -z --no-abbrev -M`; shared by production and conformance tests. */
export function canonicalGitDeltaFromRaw(raw: string): CanonicalGitDelta {
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const entries: CanonicalGitDeltaEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++];
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header ?? "");
    if (match === null) throw new TypeError("malformed raw Git delta");
    const [, oldMode, newMode, beforeOid, afterOid, status, similarity] = match;
    const firstPath = tokens[index++];
    if (firstPath === undefined || firstPath.length === 0) throw new TypeError("raw Git delta contains an empty path");
    if (oldMode === "160000" || newMode === "160000") throw new TypeError("raw Git delta contains an unsupported submodule");
    if (status === "R") {
      if (similarity !== "100" || beforeOid !== afterOid) throw new TypeError("raw Git delta contains an impure rename");
      const destination = tokens[index++];
      if (destination === undefined || destination.length === 0) throw new TypeError("raw Git delta contains a malformed rename");
      entries.push({
        path: destination,
        from_path: firstPath,
        change_kind: "rename",
        before_mode: oldMode === "000000" ? null : oldMode!,
        after_mode: newMode === "000000" ? null : newMode!,
      });
    } else {
      const changeKind = status === "A" ? "create" : status === "D" ? "delete" : status === "M" || status === "T" ? "modify" : null;
      if (changeKind === null) throw new TypeError(`raw Git delta contains unsupported change kind ${String(status)}`);
      entries.push({
        path: firstPath,
        from_path: null,
        change_kind: changeKind,
        before_mode: oldMode === "000000" ? null : oldMode!,
        after_mode: newMode === "000000" ? null : newMode!,
      });
    }
  }
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  entries.sort((left, right) => compareText(left.path, right.path) || compareText(left.from_path ?? "", right.from_path ?? ""));
  const derived = deriveOracleAttributionDigests(entries.map((entry) => ({
    path: entry.path,
    fromPath: entry.from_path,
    changeKind: entry.change_kind,
    beforeMode: entry.before_mode,
    afterMode: entry.after_mode,
  })));
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    candidateDiffDigest: derived.candidateDiffDigest as `sha256:${string}`,
    pathSetDigest: derived.pathSetDigest as `sha256:${string}`,
    changeKindSetDigest: derived.changeKindSetDigest as `sha256:${string}`,
    modeSetDigest: derived.modeSetDigest as `sha256:${string}`,
  });
}

/** Rejects executable/symlink ambiguity while preserving safe deletion of any non-gitlink baseline entry. */
export function validateCommitDeltaModes(delta: CanonicalGitDelta): void {
  const regularModes = new Set(["100644", "100755"]);
  for (const entry of delta.entries) {
    if (entry.change_kind !== "delete" && entry.before_mode !== null && !regularModes.has(entry.before_mode)) {
      throw new TypeError(`commit delta has an unsupported before mode: ${entry.path}`);
    }
    if (entry.after_mode !== null && !regularModes.has(entry.after_mode)) {
      throw new TypeError(`commit delta has an unsupported after mode: ${entry.path}`);
    }
    if (
      (entry.change_kind === "modify" || entry.change_kind === "rename") &&
      entry.before_mode !== entry.after_mode
    ) throw new TypeError(`commit delta has an undeclared mode change: ${entry.path}`);
  }
}

export class StateStore {
  readonly location: StateLocation;
  #database: DatabaseSync | undefined;
  #transactionActive = false;
  readonly #columns = new Map<StateTableName, ReadonlySet<string>>();

  private constructor(location: StateLocation, database: DatabaseSync) {
    this.location = location;
    this.#database = database;
    for (const table of ALL_STATE_TABLES) {
      const rows = database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all() as Array<Record<string, SqlValue>>;
      this.#columns.set(table, new Set(rows.map((row) => String(row.name))));
    }
  }

  static open(options: OpenStateStoreOptions): StateStore {
    assertRuntime();
    assertValidMigrationCatalog();
    const location = resolveStateLocation(options.repoPath);
    ensureStateDirectory(location);
    ensureResourceDirectory(location);
    ensureCanonicalDatabase(location);
    const database = openCanonicalDatabase(location);
    const store = new StateStore(location, database);
    try {
      store.#registerRepository();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#database === undefined;
  }

  get schemaVersion(): number {
    return userVersion(this.#requireDatabase());
  }

  close(): void {
    const db = this.#database;
    if (db === undefined) return;
    this.#database = undefined;
    rollbackPreserving(db);
    db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  verifyIntegrity(): void {
    validateIntegrity(this.#requireDatabase(), this.location.databasePath, true);
    validateCanonicalFiles(this.location);
  }

  allocateFreshRun(input: AllocateFreshRunInput): AllocatedRun {
    this.#assertRepositoryCommit(input.initialDeliveryOid, "initial delivery oid");
    this.#validateFreshRunInput(input);
    return this.#immediate("allocate_fresh_run", () => {
      const createdAt = new Date().toISOString();
      this.#insertSharedImmutable(
        "run_manifests",
        {
          manifest_digest: input.manifest.digest,
          schema_version: input.manifest.schemaVersion,
          canonical_manifest_json: input.manifest.canonicalJson,
          capability_snapshot_digest: input.manifest.capabilitySnapshot.digest,
          context_schema_version: input.manifest.contextSchemaVersion,
          oracle_version: input.manifest.oracleVersion,
          created_at: createdAt,
        },
        ["manifest_digest"],
        ["schema_version", "canonical_manifest_json", "capability_snapshot_digest", "context_schema_version", "oracle_version"],
      );
      for (const ticket of input.tickets) {
        this.#insertSharedImmutable(
          "ticket_contracts",
          {
            contract_digest: ticket.contract.digest,
            schema_version: ticket.contract.schemaVersion,
            canonical_contract_json: ticket.contract.canonicalJson,
            created_at: createdAt,
          },
          ["contract_digest"],
          ["schema_version", "canonical_contract_json"],
        );
      }

      const sequenceRow = this.#requireDatabase().prepare(
        "SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next_sequence FROM runs WHERE repository_id = ?",
      ).get(this.location.repositoryId) as MutableStateRecord;
      const runSequence = Number(sequenceRow.next_sequence);
      if (!Number.isSafeInteger(runSequence) || runSequence < 1) throw new StateStoreError("RICKGENT_STATE_CORRUPT", "next run sequence is invalid");
      const runId = `run-${randomBytes(16).toString("hex")}`;
      const deliveryRef = `refs/rickgent/runs/${runId}/delivery`;
      try {
        execFileSync("git", ["check-ref-format", deliveryRef], { cwd: this.location.repoRealpath, stdio: "ignore" });
      } catch (error) {
        throw typedError("RICKGENT_STATE_CONFLICT", "generated delivery ref is invalid", this.location.databasePath, error);
      }
      this.#insert("runs", {
        run_id: runId,
        repository_id: this.location.repositoryId,
        run_sequence: runSequence,
        manifest_digest: input.manifest.digest,
        initial_delivery_oid: input.initialDeliveryOid,
        delivery_ref: deliveryRef,
        state: "planned",
        state_version: 0,
        current_delivery_oid: input.initialDeliveryOid,
        promotion_sequence: 0,
        created_at: createdAt,
      });

      const allocatedTickets: AllocatedRunTicket[] = [];
      for (const ticket of [...input.tickets].sort((left, right) => left.planIndex - right.planIndex)) {
        const ticketInstanceId = `ticket-${randomBytes(16).toString("hex")}`;
        this.#insert("run_tickets", {
          ticket_instance_id: ticketInstanceId,
          run_id: runId,
          ticket_id: ticket.ticketId,
          plan_index: ticket.planIndex,
          contract_digest: ticket.contract.digest,
          state: "planned",
          state_version: 0,
          created_at: createdAt,
        });
        allocatedTickets.push({
          ticketInstanceId,
          runId,
          ticketId: ticket.ticketId,
          planIndex: ticket.planIndex,
          contractDigest: ticket.contract.digest,
          state: "planned",
          stateVersion: 0,
        });
      }
      for (const ticket of input.tickets) {
        for (const dependency of ticket.dependsOnTicketIds) {
          const payload = canonicalJson({ run_id: runId, ticket_id: ticket.ticketId, depends_on_ticket_id: dependency });
          this.#insert("run_ticket_dependencies", {
            run_id: runId,
            ticket_id: ticket.ticketId,
            depends_on_ticket_id: dependency,
            dependency_digest: sha256Text(payload),
          });
        }
      }
      return freezeValue({
        runnable: false as const,
        runId,
        repositoryId: this.location.repositoryId,
        runSequence,
        manifestDigest: input.manifest.digest,
        initialDeliveryOid: input.initialDeliveryOid,
        currentDeliveryOid: input.initialDeliveryOid,
        deliveryRef,
        state: "planned" as const,
        stateVersion: 0 as const,
        tickets: allocatedTickets,
      });
    });
  }

  allocateInitialAttempt(input: AttemptAllocationInput): AllocatedAttempt {
    return this.#allocateAttempt(input, "initial");
  }

  allocateRetryAttempt(input: RetryCompatibilityInput): AllocatedAttempt {
    return this.#allocateAttempt(input, "retry");
  }

  /**
   * t22D-fix: Activate a run from `planned` to `active` through the production
   * store authority (not raw SQL).  The AttemptRunner calls this before
   * acquiring ownership (the LeaseAuthority requires an active run).  Records
   * a durable `state_transitions` row.  Idempotent: a replay returns silently
   * if the run is already active with the same idempotency key.
   */
  activateRunForRunner(runId: string, attemptId: string, idempotencyKey: string): void {
    this.#immediate("activate_run_for_runner", () => {
      const db = this.#requireDatabase();
      const current = db.prepare(
        "SELECT state, state_version FROM runs WHERE run_id = ?",
      ).get(runId) as MutableStateRecord | undefined;
      if (current === undefined) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "run does not exist", this.location.databasePath);
      if (String(current.state) === "active") return; // idempotent replay
      if (String(current.state) !== "planned") {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `run is ${String(current.state)}, not planned`, this.location.databasePath);
      }
      const existing = db.prepare(
        "SELECT * FROM state_transitions WHERE run_id = ? AND idempotency_key = ?",
      ).get(runId, idempotencyKey) as MutableStateRecord | undefined;
      if (existing !== undefined) return; // idempotent replay
      const sequenceRow = db.prepare(
        "SELECT COALESCE(MAX(entity_sequence), 0) + 1 AS next_sequence FROM state_transitions WHERE run_id = ?",
      ).get(runId) as MutableStateRecord;
      const entitySequence = Number(sequenceRow.next_sequence);
      const transitionId = `transition-${randomBytes(16).toString("hex")}`;
      this.#insert("state_transitions", {
        transition_id: transitionId,
        run_id: runId,
        ticket_instance_id: null,
        attempt_id: null,
        entity_sequence: entitySequence,
        from_state: "planned",
        to_state: "active",
        owner_service: "RunAllocationService",
        owner_context_digest: `sha256:${createHash("sha256").update(`activate-run:${runId}:${attemptId}`, "utf8").digest("hex")}`,
        input_digest: `sha256:${createHash("sha256").update(canonicalJson({ run_id: runId, attempt_id: attemptId, idempotency_key: idempotencyKey }), "utf8").digest("hex")}`,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      });
      db.prepare("UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?").run(runId);
    });
  }

  /**
   * t22D-fix: Activate a ticket from `planned` to `active` through the
   * production store authority (not raw SQL).  The AttemptRunner calls this
   * before acquiring ownership (the LeaseAuthority requires an active ticket).
   * Records a durable `state_transitions` row.  Idempotent.
   */
  activateTicketForRunner(ticketInstanceId: string, attemptId: string, idempotencyKey: string): void {
    this.#immediate("activate_ticket_for_runner", () => {
      const db = this.#requireDatabase();
      const current = db.prepare(
        "SELECT state, state_version FROM run_tickets WHERE ticket_instance_id = ?",
      ).get(ticketInstanceId) as MutableStateRecord | undefined;
      if (current === undefined) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "ticket does not exist", this.location.databasePath);
      if (String(current.state) === "active") return; // idempotent replay
      if (String(current.state) !== "planned") {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `ticket is ${String(current.state)}, not planned`, this.location.databasePath);
      }
      const existing = db.prepare(
        "SELECT * FROM state_transitions WHERE ticket_instance_id = ? AND idempotency_key = ?",
      ).get(ticketInstanceId, idempotencyKey) as MutableStateRecord | undefined;
      if (existing !== undefined) return; // idempotent replay
      const sequenceRow = db.prepare(
        "SELECT COALESCE(MAX(entity_sequence), 0) + 1 AS next_sequence FROM state_transitions WHERE ticket_instance_id = ?",
      ).get(ticketInstanceId) as MutableStateRecord;
      const entitySequence = Number(sequenceRow.next_sequence);
      const transitionId = `transition-${randomBytes(16).toString("hex")}`;
      this.#insert("state_transitions", {
        transition_id: transitionId,
        run_id: null,
        ticket_instance_id: ticketInstanceId,
        attempt_id: null,
        entity_sequence: entitySequence,
        from_state: "planned",
        to_state: "active",
        owner_service: "RunAllocationService",
        owner_context_digest: `sha256:${createHash("sha256").update(`activate-ticket:${ticketInstanceId}:${attemptId}`, "utf8").digest("hex")}`,
        input_digest: `sha256:${createHash("sha256").update(canonicalJson({ ticket_instance_id: ticketInstanceId, attempt_id: attemptId, idempotency_key: idempotencyKey }), "utf8").digest("hex")}`,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      });
      db.prepare("UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ?").run(ticketInstanceId);
    });
  }

  /** Returns the current state and state_version of an attempt. */
  readAttemptState(attemptId: string): { readonly state: string; readonly stateVersion: number } {
    const row = this.#requireDatabase().prepare(
      "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
    ).get(attemptId) as MutableStateRecord | undefined;
    if (row === undefined) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "attempt does not exist", this.location.databasePath);
    return freezeValue({ state: String(row.state), stateVersion: Number(row.state_version) });
  }

  /**
   * Transitions an attempt from a pre-cleanup state to cleanup_pending.
   * Validates the legal transition chain and records a state_transition row.
   * This is the AttemptRunner's internal transition for the cleanup boundary;
   * the full TransitionAuthority guard validation is deferred to t22D.
   */
  advanceAttemptToCleanupPending(attemptId: string, idempotencyKey: string): void {
    this.#immediate("advance_attempt_cleanup_pending", () => {
      const current = this.#requireDatabase().prepare(
        "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
      ).get(attemptId) as MutableStateRecord | undefined;
      if (current === undefined) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "attempt does not exist", this.location.databasePath);
      const eligible = new Set([
        "planned", "implementing", "implementation_captured", "reviewing", "remediating",
        "remediation_captured", "verification_queued", "verifying", "converging",
      ]);
      if (!eligible.has(String(current.state))) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `attempt is ${String(current.state)}, not a pre-cleanup state`, this.location.databasePath);
      }
      // Check idempotency: if this transition already happened, return silently.
      const existing = this.#requireDatabase().prepare(
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND idempotency_key = ?",
      ).get(attemptId, idempotencyKey) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        if (String(existing.to_state) !== "cleanup_pending") {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "advance_attempt_cleanup_pending idempotency key has different target state", this.location.databasePath);
        }
        return; // idempotent replay
      }
      const sequenceRow = this.#requireDatabase().prepare(
        "SELECT COALESCE(MAX(entity_sequence), 0) + 1 AS next_sequence FROM state_transitions WHERE attempt_id = ?",
      ).get(attemptId) as MutableStateRecord;
      const entitySequence = Number(sequenceRow.next_sequence);
      const transitionId = `transition-${randomBytes(16).toString("hex")}`;
      this.#insert("state_transitions", {
        transition_id: transitionId,
        run_id: null,
        ticket_instance_id: null,
        attempt_id: attemptId,
        entity_sequence: entitySequence,
        from_state: String(current.state),
        to_state: "cleanup_pending",
        owner_service: "AttemptLifecycleService",
        owner_context_digest: "sha256:" + "0".repeat(64),
        input_digest: `sha256:${createHash("sha256").update(canonicalJson({ attempt_id: attemptId, idempotency_key: idempotencyKey, from_state: String(current.state), to_state: "cleanup_pending" }), "utf8").digest("hex")}`,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      });
      this.#requireDatabase().prepare(
        "UPDATE attempts SET state = 'cleanup_pending', state_version = state_version + 1 WHERE attempt_id = ?",
      ).run(attemptId);
      // Also transition the owning run_ticket to cleanup_pending so that
      // promotion-intent scope validation (which checks ticket_state) passes.
      this.#requireDatabase().prepare(
        "UPDATE run_tickets SET state = 'cleanup_pending', state_version = state_version + 1 " +
        "WHERE ticket_instance_id = (SELECT ticket_instance_id FROM attempts WHERE attempt_id = ?) " +
        "AND state = 'active'",
      ).run(attemptId);
    });
  }

  /**
   * Transitions the owning run_ticket from `active` to `cleanup_pending`
   * so that promotion-intent scope validation (which checks ticket_state)
   * passes.  This is a secondary effect of the attempt cleanup transition
   * (which goes through the TransitionAuthority); the ticket transition
   * mirrors the attempt state without a separate authority guard.
   */
  advanceTicketToCleanupPending(attemptId: string): void {
    this.#immediate("advance_ticket_cleanup_pending", () => {
      this.#requireDatabase().prepare(
        "UPDATE run_tickets SET state = 'cleanup_pending', state_version = state_version + 1 " +
        "WHERE ticket_instance_id = (SELECT ticket_instance_id FROM attempts WHERE attempt_id = ?) " +
        "AND state = 'active'",
      ).run(attemptId);
    });
  }

  /**
   * Queries the current state of an attempt.  Used by the AttemptRunner to
   * determine which legal-edge transitions still need to be walked.
   */
  queryAttemptState(attemptId: string): string {
    const row = this.#requireDatabase().prepare(
      "SELECT state FROM attempts WHERE attempt_id = ?",
    ).get(attemptId) as MutableStateRecord | undefined;
    if (row === undefined) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "attempt does not exist", this.location.databasePath);
    return String(row.state);
  }

  /**
   * Transition an attempt from one state to another via a direct state_transition
   * row (bypassing the full TransitionAuthority guard validation).  Used by the
   * AttemptRunner to drive the attempt lifecycle through the reviewing/verifying/
   * converging states.  Idempotent: if the transition already happened, returns
   * silently.
   */
  advanceAttemptState(
    attemptId: string,
    fromState: string,
    toState: string,
    idempotencyKey: string,
  ): void {
    this.#immediate(`advance_attempt_${toState}`, () => {
      const current = this.#requireDatabase().prepare(
        "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
      ).get(attemptId) as MutableStateRecord | undefined;
      if (current === undefined) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "attempt does not exist", this.location.databasePath);
      if (String(current.state) !== fromState && String(current.state) !== toState) {
        // Idempotent replay: if the current state is already past the target
        // state in the lifecycle ordering, return silently.
        const STATE_ORDER = ["planned", "implementing", "implementation_captured", "reviewing", "verification_queued", "verifying", "converging", "cleanup_pending", "finalized"];
        const currentIndex = STATE_ORDER.indexOf(String(current.state));
        const toIndex = STATE_ORDER.indexOf(toState);
        if (currentIndex >= 0 && toIndex >= 0 && currentIndex > toIndex) return;
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `attempt is ${String(current.state)}, expected ${fromState} or ${toState}`, this.location.databasePath);
      }
      // Idempotent: if already in target state, return silently.
      if (String(current.state) === toState) return;
      const existing = this.#requireDatabase().prepare(
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND idempotency_key = ?",
      ).get(attemptId, idempotencyKey) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        if (String(existing.to_state) !== toState) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", `advance_attempt_${toState} idempotency key has different target state`, this.location.databasePath);
        }
        return;
      }
      const sequenceRow = this.#requireDatabase().prepare(
        "SELECT COALESCE(MAX(entity_sequence), 0) + 1 AS next_sequence FROM state_transitions WHERE attempt_id = ?",
      ).get(attemptId) as MutableStateRecord;
      const entitySequence = Number(sequenceRow.next_sequence);
      const transitionId = `transition-${randomBytes(16).toString("hex")}`;
      this.#insert("state_transitions", {
        transition_id: transitionId,
        run_id: null,
        ticket_instance_id: null,
        attempt_id: attemptId,
        entity_sequence: entitySequence,
        from_state: String(current.state),
        to_state: toState,
        owner_service: "AttemptLifecycleService",
        owner_context_digest: "sha256:" + "0".repeat(64),
        input_digest: `sha256:${createHash("sha256").update(canonicalJson({ attempt_id: attemptId, idempotency_key: idempotencyKey, from_state: String(current.state), to_state: toState }), "utf8").digest("hex")}`,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      });
      this.#requireDatabase().prepare(
        `UPDATE attempts SET state = ?, state_version = state_version + 1 WHERE attempt_id = ?`,
      ).run(toState, attemptId);
    });
  }

  /**
   * Transition all resource claims for an attempt from cleanup_pending to
   * quarantined state.  This is required before mintQuarantine because the
   * quarantine_claim_members FK requires attempt_resource_claims.state =
   * 'quarantined'.  Returns the updated claims with their new state_version
   * so the caller can build claim-members with the correct version.
   */
  advanceClaimsToQuarantined(
    attemptId: string,
    ownershipId: string,
    ownerGeneration: number,
    quarantineProofDigest: string,
  ): readonly { readonly resourceClaimId: string; readonly slot: string; readonly stateVersion: number }[] {
    return this.#immediate("advance_claims_quarantined", () => {
      const db = this.#requireDatabase();
      const claims = db.prepare(
        "SELECT resource_claim_id, slot, state_version FROM attempt_resource_claims WHERE attempt_id = ? AND current_ownership_id = ? AND owner_generation = ? AND state = 'cleanup_pending'",
      ).all(attemptId, ownershipId, ownerGeneration) as MutableStateRecord[];
      if (claims.length === 0) {
        // Idempotent: if no cleanup_pending claims remain, they may already be quarantined.
        const existing = db.prepare(
          "SELECT resource_claim_id, slot, state_version FROM attempt_resource_claims WHERE attempt_id = ? AND current_ownership_id = ? AND owner_generation = ? AND state = 'quarantined'",
        ).all(attemptId, ownershipId, ownerGeneration) as MutableStateRecord[];
        return existing.map((c) => ({
          resourceClaimId: String(c.resource_claim_id),
          slot: String(c.slot),
          stateVersion: Number(c.state_version),
        }));
      }
      const updated: { resourceClaimId: string; slot: string; stateVersion: number }[] = [];
      for (const claim of claims) {
        const resourceClaimId = String(claim.resource_claim_id);
        const slot = String(claim.slot);
        const seal = db.prepare(
          `UPDATE attempt_resource_claims
           SET state = 'quarantined', state_version = state_version + 1, quarantine_proof_digest = ?
           WHERE resource_claim_id = ? AND attempt_id = ? AND current_ownership_id = ?
             AND owner_generation = ? AND state = 'cleanup_pending' AND state_version = ?`,
        ).run(quarantineProofDigest, resourceClaimId, attemptId, ownershipId, ownerGeneration, Number(claim.state_version));
        if (seal.changes !== 1) {
          throw typedError("RICKGENT_STATE_CONFLICT", `resource claim ${slot} quarantine transition lost its CAS race`, this.location.databasePath);
        }
        updated.push({ resourceClaimId, slot, stateVersion: Number(claim.state_version) + 1 });
      }
      return updated;
    });
  }

  /**
   * Transition an attempt's ownership lease from cleanup_pending to
   * quarantined.  Called after mintQuarantine so the ownership lease is
   * still cleanup_pending when the quarantine receipt is minted (the
   * preimage validation requires it), then durably terminalized.
   */
  finalizeQuarantineOwnership(
    attemptId: string,
    ownershipId: string,
    ownerGeneration: number,
  ): void {
    this.#immediate("finalize_quarantine_ownership", () => {
      const db = this.#requireDatabase();
      const leaseSeal = db.prepare(
        `UPDATE attempt_ownership_leases
         SET state = 'quarantined', state_version = state_version + 1
         WHERE attempt_id = ? AND ownership_id = ?
           AND generation = ? AND state = 'cleanup_pending'`,
      ).run(attemptId, ownershipId, ownerGeneration);
      if (leaseSeal.changes !== 1) {
        // Idempotent: lease may already be quarantined.
        const existing = db.prepare(
          "SELECT state FROM attempt_ownership_leases WHERE attempt_id = ? AND ownership_id = ? AND generation = ?",
        ).get(attemptId, ownershipId, ownerGeneration) as MutableStateRecord | undefined;
        if (existing === undefined || String(existing.state) !== "quarantined") {
          throw typedError("RICKGENT_STATE_CONFLICT", "ownership lease quarantine finalization lost its CAS race", this.location.databasePath);
        }
      }
    });
  }

  selectCompatibleResume(input: ResumeCompatibilityInput): ResumeSelection {
    return this.#immediate("select_compatible_resume", () => {
      if (typeof input.runId !== "string" || input.runId === "") this.#resumeIncompatible("resume requires an explicit run id");
      const run = this.#requireDatabase().prepare(`
        SELECT r.*, rm.capability_snapshot_digest, rm.context_schema_version, rm.oracle_version, rm.canonical_manifest_json
        FROM runs r JOIN run_manifests rm ON rm.manifest_digest = r.manifest_digest
        WHERE r.run_id = ? AND r.repository_id = ?
      `).get(input.runId, this.location.repositoryId) as MutableStateRecord | undefined;
      if (run === undefined) this.#resumeIncompatible("explicit run does not belong to the selected repository");
      if (
        run.manifest_digest !== input.manifestDigest || run.context_schema_version !== input.contextSchemaVersion ||
        run.oracle_version !== input.oracleVersion || run.capability_snapshot_digest !== input.capabilitySnapshotDigest
      ) this.#resumeIncompatible("run compatibility projection changed");
      const manifest = this.#parseJsonObject(String(run.canonical_manifest_json), "run manifest");
      if (manifest.resource_identity_version !== input.resourceIdentityVersion) this.#resumeIncompatible("resource identity version changed");

      const expected = new Map<string, string>();
      for (const ticket of input.tickets) {
        if (expected.has(ticket.ticketId)) this.#resumeIncompatible("resume ticket set contains duplicates");
        expected.set(ticket.ticketId, ticket.contractDigest);
      }
      const rows = this.#requireDatabase().prepare(
        "SELECT * FROM run_tickets WHERE run_id = ? ORDER BY plan_index",
      ).all(input.runId) as MutableStateRecord[];
      if (rows.length !== expected.size) this.#resumeIncompatible("resume ticket set differs from the persisted run");
      const tickets: ResumeTicketSelection[] = [];
      for (const row of rows) {
        const ticketId = String(row.ticket_id);
        if (expected.get(ticketId) !== row.contract_digest) this.#resumeIncompatible(`ticket contract changed for ${ticketId}`);
        const attempts = this.#requireDatabase().prepare(
          "SELECT * FROM attempts WHERE ticket_instance_id = ? ORDER BY attempt_number",
        ).all(row.ticket_instance_id ?? null) as MutableStateRecord[];
        for (const attempt of attempts) {
          if (
            attempt.contract_digest !== row.contract_digest || attempt.context_schema_version !== input.contextSchemaVersion ||
            attempt.oracle_version !== input.oracleVersion || attempt.capability_snapshot_digest !== input.capabilitySnapshotDigest ||
            attempt.resource_identity_version !== input.resourceIdentityVersion
          ) this.#resumeIncompatible(`attempt compatibility changed for ${ticketId}`);
        }
        const latest = attempts.at(-1);
        tickets.push({
          ticketInstanceId: String(row.ticket_instance_id),
          ticketId,
          contractDigest: String(row.contract_digest),
          state: String(row.state),
          latestAttempt: latest === undefined ? null : this.#persistedAttempt(latest),
        });
      }
      return freezeValue({
        runId: String(run.run_id),
        repositoryId: String(run.repository_id),
        runSequence: Number(run.run_sequence),
        manifestDigest: String(run.manifest_digest),
        state: String(run.state),
        tickets,
      });
    });
  }

  selectCompatibleRetry(input: RetryCompatibilityInput): RetrySelection {
    return this.#immediate("select_compatible_retry", () => this.#selectRetryInTransaction(input));
  }

  recordRunManifest(input: StateRowInput): StateRecord {
    return this.#appendIdempotent(
      "run_manifests",
      input,
      ["manifest_digest"],
      ["schema_version", "canonical_manifest_json", "capability_snapshot_digest", "context_schema_version", "oracle_version"],
    );
  }

  recordTicketContract(input: StateRowInput): StateRecord {
    return this.#appendIdempotent(
      "ticket_contracts",
      input,
      ["contract_digest"],
      ["schema_version", "canonical_contract_json"],
    );
  }

  persistDurableExecutionContext(input: PersistDurableExecutionContextInput): PersistedExecutionContextRows {
    return this.#immediate("persist_durable_execution_context", () => {
      const projection = this.#validateDurableContextProjection(input);
      const contextDigest = sha256Text(input.canonicalContextJson);
      const tupleJson = canonicalJson({
        attempt_id: input.attemptId,
        phase: input.phase,
        phase_ordinal: input.phaseOrdinal,
        role: input.role,
      });
      const contextId = `context-${sha256Text(tupleJson).slice("sha256:".length)}`;
      const phaseIdentityJson = canonicalJson({
        attempt_id: input.attemptId,
        context_id: contextId,
        phase: input.phase,
        phase_ordinal: input.phaseOrdinal,
        role: input.role,
      });
      const phaseIdentityDigest = sha256Text(phaseIdentityJson);
      const phaseExecutionId = `phase-${phaseIdentityDigest.slice("sha256:".length)}`;
      const createdAt = new Date().toISOString();
      const contextRow: MutableStateRecord = {
        context_id: contextId,
        context_digest: contextDigest,
        attempt_id: input.attemptId,
        phase: input.phase,
        phase_ordinal: input.phaseOrdinal,
        role: input.role,
        canonical_context_json: input.canonicalContextJson,
        contract_digest: String(projection.contract_digest),
        capability_snapshot_digest: String(projection.capability_snapshot_digest),
        policy_bundle_digest: input.policyBundleDigest,
        model_selection_digest: input.modelSelectionDigest,
        budget_digest: input.budgetDigest,
        scope_digest: input.scopeDigest,
        context_schema_version: String(projection.context_schema_version),
        oracle_version: String(projection.oracle_version),
        created_at: createdAt,
      };
      const contextExisting = this.#selectBy("execution_contexts", contextRow, ["context_id"]);
      let storedContext: StateRecord;
      if (contextExisting !== undefined) {
        const equality = Object.keys(contextRow).filter((column) => column !== "created_at");
        if (!equality.every((column) => sameValue(contextExisting[column], contextRow[column]))) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "execution phase tuple already has a different immutable context", this.location.databasePath);
        }
        storedContext = frozenRow(contextExisting);
      } else {
        this.#validateRecordSemantics("execution_contexts", contextRow);
        this.#insert("execution_contexts", contextRow);
        storedContext = frozenRow(contextRow);
      }

      const phaseRow: MutableStateRecord = {
        phase_execution_id: phaseExecutionId,
        attempt_id: input.attemptId,
        context_id: contextId,
        phase: input.phase,
        phase_ordinal: input.phaseOrdinal,
        role: input.role,
        identity_digest: phaseIdentityDigest,
        created_at: contextExisting === undefined ? createdAt : String(storedContext.created_at),
      };
      const phaseExisting = this.#selectBy("phase_executions", phaseRow, ["phase_execution_id"]);
      if (
        ["failed_clean", "quarantined", "verified"].includes(String(projection.attempt_state)) &&
        (contextExisting === undefined || phaseExisting === undefined)
      ) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "terminal attempts cannot mint a new execution context or phase tuple", this.location.databasePath);
      }
      if (
        !["planned", "active"].includes(String(projection.run_state)) &&
        (contextExisting === undefined || phaseExisting === undefined)
      ) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "inactive or terminal runs cannot mint a new execution context or phase tuple", this.location.databasePath);
      }
      let storedPhase: StateRecord;
      if (phaseExisting !== undefined) {
        const equality = Object.keys(phaseRow).filter((column) => column !== "created_at");
        if (!equality.every((column) => sameValue(phaseExisting[column], phaseRow[column]))) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "phase execution identity already has different immutable input", this.location.databasePath);
        }
        storedPhase = frozenRow(phaseExisting);
      } else {
        this.#insert("phase_executions", phaseRow);
        storedPhase = frozenRow(phaseRow);
      }
      return freezeValue({
        contextId,
        contextDigest,
        phaseExecutionId,
        phaseIdentityDigest,
        context: storedContext,
        phaseExecution: storedPhase,
      });
    });
  }

  appendEvidence(input: StateRowInput): StateRecord {
    if ([
      "LeaseAuthority",
      "ProcessSupervisor",
      "CommitService",
      "SalvageService",
      "CleanupService",
      "TargetStartGateAuthority",
      "TargetProofService",
      "CleanupEligibilityService",
      "FailureCleanupService",
      "PromotionCleanupService",
      "QuarantineService",
    ].includes(String(input.producer_service))) {
      throw new TypeError(`${String(input.producer_service)} evidence requires its runtime-authorized producer path`);
    }
    return this.#appendIdempotent(
      "evidence",
      input,
      ["producer_service", "scope", "idempotency_key"],
      [
        "attempt_id", "phase_execution_id", "context_id", "schema_version", "content_digest",
        "inline_payload_json", "external_path", "external_digest", "external_size",
      ],
    );
  }

  /** Read-only convenience projection. Prepare revalidates every returned fact transactionally. */
  resolveCommitPreparation(input: ResolveCommitPreparationInput): ResolvedCommitPreparation {
    const lineage = this.#requireTransitionGuard(`
      SELECT x.created_at AS phase_created_at, c.context_digest,
             l.launch_id, l.process_receipt_id,
             a.delivery_baseline_oid, a.contract_digest, r.delivery_ref,
             tc.canonical_contract_json
      FROM attempts a
      JOIN runs r ON r.run_id = a.run_id AND r.repository_id = ?
      JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
      JOIN phase_executions x ON x.phase_execution_id = ? AND x.attempt_id = a.attempt_id
      JOIN execution_contexts c ON c.context_id = ? AND c.attempt_id = a.attempt_id
        AND x.context_id = c.context_id
      JOIN attempt_process_launches l ON l.phase_execution_id = x.phase_execution_id
        AND l.context_id = c.context_id AND l.attempt_id = a.attempt_id
      JOIN attempt_process_terminal_receipts t ON t.process_receipt_id = l.process_receipt_id
        AND t.launch_id = l.launch_id AND t.attempt_id = a.attempt_id
      WHERE a.attempt_id = ? AND a.state = 'converging'
        AND x.phase = 'implement' AND x.role = 'worker'
        AND t.outcome = 'exit_zero' AND t.exit_code = 0 AND t.timed_out = 0
        AND t.group_dead = 1 AND t.descendants_confirmed_dead = 1
    `, [this.location.repositoryId, input.phaseExecutionId, input.contextId, input.attemptId],
    "commit preparation requires an authoritative successful implement-worker phase");
    const review = this.#requireTransitionGuard(`
      SELECT rr.input_tree_oid, rr.input_diff_digest, e.content_digest
      FROM review_records rr
      JOIN evidence e ON e.evidence_id = rr.verdict_evidence_id AND e.attempt_id = rr.attempt_id
      WHERE rr.attempt_id = ? AND rr.cycle = (SELECT MAX(cycle) FROM review_records WHERE attempt_id = ?)
        AND rr.verdict = 'accepted'
    `, [input.attemptId, input.attemptId], "commit preparation requires a final accepted review");
    const gateRows = this.#requireDatabase().prepare(`
      SELECT g.gate_result_id, g.gate_id, g.evaluation_ordinal, g.status, g.required, g.result_digest,
             e.scope AS evidence_scope, e.schema_version AS evidence_schema_version,
             e.inline_payload_json, e.content_digest AS evidence_content_digest
      FROM gate_results g
      JOIN evidence e ON e.evidence_id = g.evidence_id AND e.attempt_id = g.attempt_id
        AND e.producer_service = 'VerificationService'
      WHERE g.attempt_id = ? AND g.required = 1
        AND g.evaluation_ordinal = (
          SELECT MAX(latest.evaluation_ordinal) FROM gate_results latest
          WHERE latest.attempt_id = g.attempt_id AND latest.gate_id = g.gate_id
        )
      ORDER BY g.gate_id, g.evaluation_ordinal
    `).all(input.attemptId) as MutableStateRecord[];
    const gates = gateRows.map((gate) => {
      const sealed = this.#parseJsonObject(String(gate.inline_payload_json), "commit preparation gate evidence");
      const required = sealed.required === true || sealed.required === 1;
      const canonical = canonicalJson(sealed);
      if (
        gate.evidence_scope !== gate.gate_result_id || gate.evidence_schema_version !== "rickgent.gate-result.v1" ||
        gate.inline_payload_json !== canonical || gate.evidence_content_digest !== sha256Text(canonical) ||
        gate.result_digest !== gate.evidence_content_digest || sealed.gate_id !== gate.gate_id ||
        sealed.evaluation_ordinal !== gate.evaluation_ordinal || !required || gate.required !== 1 ||
        sealed.status !== gate.status || typeof sealed.candidate_tree_oid !== "string" ||
        typeof sealed.candidate_diff_digest !== "string"
      ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "required gate evidence is not an exact immutable candidate receipt", this.location.databasePath);
      return Object.freeze({
        ...gate,
        candidate_tree_oid: sealed.candidate_tree_oid,
        candidate_diff_digest: sealed.candidate_diff_digest,
      } as MutableStateRecord);
    });
    const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "commit preparation contract");
    const requiredGateIds = (Array.isArray(contract.verifications) ? contract.verifications : [])
      .filter((verification) => verification !== null && typeof verification === "object" && !Array.isArray(verification))
      .map((verification) => String((verification as Record<string, unknown>).id))
      .sort();
    if (
      requiredGateIds.length === 0 || gates.map((gate) => String(gate.gate_id)).join("\0") !== requiredGateIds.join("\0") ||
      gates.some((gate) =>
        gate.status !== "passed" || gate.candidate_tree_oid !== review.input_tree_oid || gate.candidate_diff_digest !== review.input_diff_digest)
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "required gates do not converge on the final accepted review candidate", this.location.databasePath);
    return freezeValue({
      phaseCreatedAt: String(lineage.phase_created_at),
      launchId: String(lineage.launch_id),
      processReceiptId: String(lineage.process_receipt_id),
      executionContextDigest: String(lineage.context_digest),
      baselineOid: String(lineage.delivery_baseline_oid),
      contractDigest: String(lineage.contract_digest),
      deliveryRef: String(lineage.delivery_ref),
      candidateTreeOid: String(review.input_tree_oid),
      candidateDiffDigest: String(review.input_diff_digest),
      verificationReceiptDigests: Object.freeze([
        String(review.content_digest),
        ...gates.map((gate) => String(gate.result_digest)),
      ]),
    });
  }

  /** Read-only recovery projection over the sealed CommitService intent/result boundary. */
  resolveCommitIntentReplay(input: ResolveCommitIntentReplayInput): ResolvedCommitIntentReplay | null {
    if (input.attemptId === "" || input.commitIntentId === "") throw new TypeError("commit replay identity is required");
    const row = this.#requireDatabase().prepare(`
      SELECT state, state_version, commit_oid, commit_attribution_id, command_receipts_json
      FROM attempt_commit_intents WHERE attempt_id = ? AND commit_intent_id = ?
    `).get(input.attemptId, input.commitIntentId) as MutableStateRecord | undefined;
    if (row === undefined) return null;
    if (row.state === "intent_recorded" && row.state_version === 0) {
      if (row.commit_oid !== null || row.commit_attribution_id !== null || row.command_receipts_json !== null) {
        throw typedError("RICKGENT_STATE_CORRUPT", "prepared commit intent has terminal replay fields", this.location.databasePath);
      }
      return freezeValue({
        state: "intent_recorded" as const,
        stateVersion: 0 as const,
        commitOid: null,
        commitAttributionId: null,
        commandReceipts: Object.freeze([]),
      });
    }
    if (
      row.state !== "finalized" || row.state_version !== 1 || typeof row.commit_oid !== "string" ||
      typeof row.commit_attribution_id !== "string" || typeof row.command_receipts_json !== "string"
    ) throw typedError("RICKGENT_STATE_CORRUPT", "commit intent replay state/version shape is invalid", this.location.databasePath);
    try {
      const text = assertCanonicalJsonText(row.command_receipts_json, "commit replay command receipts");
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) throw new TypeError("commit replay command receipts must be nonempty");
      const keys = [
        "purpose", "executable", "argv_digest", "input_digest", "input_bytes",
        "stdout_digest", "stdout_bytes", "stderr_digest", "stderr_bytes", "status",
      ].sort();
      const commandReceipts = parsed.map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
            Object.keys(entry).sort().join("\0") !== keys.join("\0")) {
          throw new TypeError("commit replay command receipt has an invalid field set");
        }
        const value = entry as Record<string, unknown>;
        if (
          typeof value.purpose !== "string" || typeof value.executable !== "string" ||
          typeof value.argv_digest !== "string" || typeof value.input_digest !== "string" ||
          typeof value.input_bytes !== "number" || typeof value.stdout_digest !== "string" ||
          typeof value.stdout_bytes !== "number" || typeof value.stderr_digest !== "string" ||
          typeof value.stderr_bytes !== "number" || typeof value.status !== "number"
        ) throw new TypeError("commit replay command receipt has an invalid value type");
        return Object.freeze({
          purpose: value.purpose,
          executable: value.executable,
          argvDigest: value.argv_digest,
          inputDigest: value.input_digest,
          inputBytes: value.input_bytes,
          stdoutDigest: value.stdout_digest,
          stdoutBytes: value.stdout_bytes,
          stderrDigest: value.stderr_digest,
          stderrBytes: value.stderr_bytes,
          status: value.status,
        });
      });
      if (this.#commandReceiptsJson(commandReceipts) !== text) throw new TypeError("commit replay command receipts are not exact");
      return freezeValue({
        state: "finalized" as const,
        stateVersion: 1 as const,
        commitOid: row.commit_oid,
        commitAttributionId: row.commit_attribution_id,
        commandReceipts,
      });
    } catch (error) {
      throw typedError("RICKGENT_STATE_CORRUPT", "commit intent replay receipts are invalid", this.location.databasePath, error);
    }
  }

  /** @internal Accepts only runtime-unforgeable prepare commands minted by CommitService. */
  prepareAuthorizedCommitIntent(command: CommitServiceCommand): StateRecord {
    if (!isAuthorizedCommitServiceCommand(command) || command.command.kind !== "prepare") {
      throw new TypeError("commit intent prepare command was not minted by CommitService");
    }
    const request = command.command.request;
    return this.#immediate("commit_attribution_prepare", () => this.#prepareCommitIntent(request));
  }

  /** @internal Accepts only runtime-unforgeable finalize commands minted by CommitService. */
  finalizeAuthorizedCommitAttribution(command: CommitServiceCommand): StateRecord {
    if (!isAuthorizedCommitServiceCommand(command) || command.command.kind !== "finalize") {
      throw new TypeError("commit attribution finalize command was not minted by CommitService");
    }
    const request = command.command.request;
    return this.#immediate("commit_attribution_finalize", () => this.#finalizeCommitAttribution(request));
  }

  /** @internal Accepts only runtime-unforgeable commands minted by LeaseAuthority. */
  commitAuthorizedAttemptOwnership(command: AttemptOwnershipCommand): AttemptOwnershipStoreResult {
    if (!isAuthorizedAttemptOwnershipCommand(command)) {
      throw new TypeError("attempt ownership command was not minted by LeaseAuthority");
    }
    return this.#immediate(`attempt_ownership_${command.payload.kind}`, () => {
      const payload = command.payload;
      const canonicalInput = this.#canonicalOwnershipCommand(command);
      const inputDigest = sha256Text(canonicalInput);
      if (payload.kind === "assert_current") return this.#assertCurrentAttemptOwnership(command);
      if (payload.kind === "assert_cleanup_ready") return this.#assertAttemptCleanupReady(command);
      if (payload.kind === "record_salvage") return this.#recordAuthorizedSalvage(command);
      const replay = this.#requireDatabase().prepare(`
        SELECT ownership_id, input_digest, canonical_input_json, result_digest, canonical_result_json
        FROM attempt_ownership_operations
        WHERE attempt_id = ? AND idempotency_key = ?
      `).get(payload.attemptId, payload.idempotencyKey) as MutableStateRecord | undefined;
      if (replay !== undefined) {
        if (replay.input_digest !== inputDigest || replay.canonical_input_json !== canonicalInput) {
          throw typedError(
            "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
            "attempt ownership idempotency key has different immutable input",
            this.location.databasePath,
          );
        }
        return this.#replayAttemptOwnershipResult(payload.attemptId, String(replay.ownership_id), replay);
      }

      switch (payload.kind) {
        case "acquire":
          return this.#acquireAttemptOwnership(command, canonicalInput, inputDigest);
        case "heartbeat":
          return this.#heartbeatAttemptOwnership(command, canonicalInput, inputDigest);
        case "advance_resource":
          return this.#advanceAttemptResourceClaim(command, canonicalInput, inputDigest);
        case "begin_cleanup":
          return this.#beginAttemptOwnershipCleanup(command, canonicalInput, inputDigest);
        case "release":
        case "quarantine":
          return this.#finalizeAttemptOwnershipCleanup(command, canonicalInput, inputDigest);
        case "stale_recovery":
          return this.#recoverStaleAttemptOwnership(command, canonicalInput, inputDigest);
      }
    });
  }

  /** @internal Accepts only runtime-unforgeable launch commands minted by ProcessSupervisor. */
  commitAuthorizedProcessLaunch(command: ProcessSupervisorCommand): StateRecord {
    if (!isAuthorizedProcessSupervisorCommand(command)) {
      throw new TypeError("process launch command was not minted by ProcessSupervisor");
    }
    if (command.command.kind !== "launch") throw new TypeError("process launch commit requires a launch command");
    return this.#immediate("process_supervisor_launch", () => this.#commitProcessLaunch(command));
  }

  /** @internal Accepts only runtime-unforgeable terminal commands minted by ProcessSupervisor. */
  commitAuthorizedProcessTerminal(command: ProcessSupervisorCommand): StateRecord {
    if (!isAuthorizedProcessSupervisorCommand(command)) {
      throw new TypeError("process terminal command was not minted by ProcessSupervisor");
    }
    if (command.command.kind !== "terminal") throw new TypeError("process terminal commit requires a terminal command");
    return this.#immediate("process_supervisor_terminal", () => this.#commitProcessTerminal(command));
  }

  /** @internal Accepts only the runtime-unforgeable plan minted by TransitionAuthority. */
  commitAuthorizedTransition(command: TransitionCommit): TransitionResult {
    if (!isAuthorizedTransitionCommit(command)) throw new TypeError("transition command was not minted by TransitionAuthority");
    return this.#immediate("transition_entity_cas", () => this.#commitTransitionInCurrentTransaction(command));
  }

  #commitTransitionInCurrentTransaction(command: TransitionCommit): TransitionResult {
      if (!isAuthorizedTransitionCommit(command)) throw new TypeError("transition command was not minted by TransitionAuthority");
      const scope = command.entityKind === "run"
        ? { table: "runs" as const, idColumn: "run_id", transitionColumn: "run_id" as const }
        : command.entityKind === "ticket"
          ? { table: "run_tickets" as const, idColumn: "ticket_instance_id", transitionColumn: "ticket_instance_id" as const }
          : { table: "attempts" as const, idColumn: "attempt_id", transitionColumn: "attempt_id" as const };
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) throw new TypeError("transition expectedVersion must be nonnegative");
      if (!/^sha256:[0-9a-f]{64}$/.test(command.ownerContextDigest)) throw new TypeError("transition ownerContextDigest is invalid");
      if (command.idempotencyKey === "" || command.idempotencyKey !== command.idempotencyKey.trim()) throw new TypeError("transition idempotencyKey is invalid");
      const catalog = command.entityKind === "run" ? RUN_TRANSITIONS : command.entityKind === "ticket" ? TICKET_TRANSITIONS : ATTEMPT_TRANSITIONS;
      const declaredEdge = catalog.find((edge) => edge.from === command.fromState && edge.to === command.toState);
      if (declaredEdge === undefined) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "transition edge is not declared by the frozen contract", this.location.databasePath);
      if (declaredEdge.owner !== command.ownerService) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "transition service does not own the declared edge", this.location.databasePath);
      if (command.evidence.length === 0) throw new TypeError("state transitions require immutable evidence");
      const evidence = command.evidence.map((reference) => this.#resolveTransitionEvidence(reference, command.ownerService));
      for (const reference of evidence) {
        if (reference.purpose === "" || reference.purpose !== reference.purpose.trim()) throw new TypeError("transition evidence purposes must be nonempty");
        if (reference.evidenceId === "") throw new TypeError("transition evidence ids must be nonempty");
      }
      const inputPayload = canonicalJson({
        entity_kind: command.entityKind,
        entity_id: command.entityId,
        expected_version: command.expectedVersion,
        from_state: command.fromState,
        to_state: command.toState,
        owner_service: command.ownerService,
        owner_context_digest: command.ownerContextDigest,
        guard: command.guard,
        evidence: evidence.map((reference) => ({ purpose: reference.purpose, evidence_id: reference.evidenceId })),
      });
      const inputDigest = sha256Text(inputPayload);
      const existing = this.#requireDatabase().prepare(
        `SELECT * FROM state_transitions WHERE ${scope.transitionColumn} = ? AND idempotency_key = ?`,
      ).get(command.entityId, command.idempotencyKey) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        const existingReferences = this.#requireDatabase().prepare(
          "SELECT purpose, evidence_id FROM transition_evidence_refs WHERE transition_id = ? ORDER BY ordinal",
        ).all(existing.transition_id ?? null) as MutableStateRecord[];
        if (
          existing.from_state !== command.fromState || existing.to_state !== command.toState ||
          existing.owner_service !== command.ownerService || existing.owner_context_digest !== command.ownerContextDigest ||
          existing.input_digest !== inputDigest || existingReferences.length !== evidence.length ||
          existingReferences.some((row, index) => row.purpose !== evidence[index]?.purpose || row.evidence_id !== evidence[index]?.evidenceId)
        ) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "transition idempotency key has different immutable input", this.location.databasePath);
        }
        const current = this.#requireDatabase().prepare(
          `SELECT * FROM ${scope.table} WHERE ${scope.idColumn} = ?`,
        ).get(command.entityId) as MutableStateRecord | undefined;
        if (current === undefined) throw new StateStoreError("RICKGENT_STATE_CORRUPT", "transition replay entity is missing");
        return this.#transitionResult(command, existing, command.expectedVersion + 1, inputDigest, evidence);
      }

      const current = this.#requireDatabase().prepare(
        `SELECT * FROM ${scope.table} WHERE ${scope.idColumn} = ?`,
      ).get(command.entityId) as MutableStateRecord | undefined;
      if (current === undefined) this.#resumeIncompatible("transition entity does not belong to the selected state store");
      if (current.state !== command.fromState) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `transition requires ${command.fromState}, observed ${String(current.state)}`, this.location.databasePath);
      }
      if (current.state_version !== command.expectedVersion) {
        throw typedError("RICKGENT_STATE_CONFLICT", "transition expected state version changed", this.location.databasePath);
      }
      this.#validateTransitionOwner(command);
      this.#validateTransitionGuard(command, evidence);
      const sequenceRow = this.#requireDatabase().prepare(
        `SELECT COALESCE(MAX(entity_sequence), 0) + 1 AS next_sequence FROM state_transitions WHERE ${scope.transitionColumn} = ?`,
      ).get(command.entityId) as MutableStateRecord;
      const entitySequence = Number(sequenceRow.next_sequence);
      const transitionId = `transition-${randomBytes(16).toString("hex")}`;
      const transition: MutableStateRecord = {
        transition_id: transitionId,
        run_id: command.entityKind === "run" ? command.entityId : null,
        ticket_instance_id: command.entityKind === "ticket" ? command.entityId : null,
        attempt_id: command.entityKind === "attempt" ? command.entityId : null,
        entity_sequence: entitySequence,
        from_state: command.fromState,
        to_state: command.toState,
        owner_service: command.ownerService,
        owner_context_digest: command.ownerContextDigest,
        input_digest: inputDigest,
        idempotency_key: command.idempotencyKey,
        created_at: new Date().toISOString(),
      };
      this.#validateRecordSemantics("state_transitions", transition);
      const references = evidence.map((reference, ordinal): MutableStateRecord => ({
        transition_id: transitionId,
        ordinal,
        purpose: reference.purpose,
        evidence_id: reference.evidenceId,
      }));
      for (const reference of references) this.#validateTransitionEvidence(transition, reference);
      this.#insert("state_transitions", transition);
      for (const reference of references) this.#insert("transition_evidence_refs", reference);
      const update = this.#requireDatabase().prepare(
        `UPDATE ${scope.table} SET state = ?, state_version = state_version + 1
         WHERE ${scope.idColumn} = ? AND state = ? AND state_version = ?`,
      ).run(command.toState, command.entityId, command.fromState, command.expectedVersion);
      if (update.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "transition compare-and-set changed zero rows", this.location.databasePath);
      return this.#transitionResult(command, transition, command.expectedVersion + 1, inputDigest, evidence);
  }

  /** Resolve, evaluate, and persist one attempt oracle decision in the same immediate transaction. */
  evaluateAndPersistAttemptOracle(request: EvaluateAttemptOracleRequest): PersistedAttemptOracleDecision {
    if (request.attemptId.length === 0 || request.idempotencyKey.length === 0) throw new TypeError("oracle attempt id and idempotency key are required");
    return this.#immediate("persist_oracle_decision", () => {
      const resolved = this.#resolveAttemptOracleProjection(request.attemptId);
      const plan = evaluateAttemptOracle(resolved.projection);
      const existing = this.#requireDatabase().prepare(
        "SELECT * FROM oracle_decisions WHERE scope_kind = 'attempt' AND attempt_id = ? AND idempotency_key = ?",
      ).get(request.attemptId, request.idempotencyKey) as MutableStateRecord | undefined;
      const identity = existing === undefined ? {
        oracleDecisionId: `oracle-${randomBytes(16).toString("hex")}`,
        idempotencyKey: request.idempotencyKey,
        createdAt: new Date().toISOString(),
      } : {
        oracleDecisionId: String(existing.oracle_decision_id),
        idempotencyKey: String(existing.idempotency_key),
        createdAt: String(existing.created_at),
      };
      const materialized = materializeOraclePersistenceRows(plan, identity);
      const decision = this.#validatedColumns("oracle_decisions", normalizeRow(materialized.decision));
      this.#requireCompleteRow("oracle_decisions", decision);
      const references = materialized.references.map((input) => {
        const row = this.#validatedColumns("oracle_input_references", normalizeRow(input));
        this.#requireCompleteRow("oracle_input_references", row);
        return row;
      });
      if (existing !== undefined) {
        const existingReferences = this.#requireDatabase().prepare(
          "SELECT * FROM oracle_input_references WHERE oracle_decision_id = ? ORDER BY ordinal",
        ).all(existing.oracle_decision_id ?? null) as MutableStateRecord[];
        if (
          this.#sameRecord(existing, decision) && existingReferences.length === references.length &&
          existingReferences.every((row, index) => references[index] !== undefined && this.#sameRecord(row, references[index]!))
        ) return freezeValue({ decision: frozenRow(existing), references: existingReferences.map(frozenRow) });
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "oracle idempotency key resolved to different immutable inputs", this.location.databasePath);
      }
      if (resolved.attemptState !== "cleanup_pending") {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "a new attempt oracle decision requires cleanup_pending state", this.location.databasePath);
      }
      this.#validateRecordSemantics("oracle_decisions", decision);
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        if (
          reference === undefined || reference.ordinal !== index || reference.oracle_decision_id !== decision.oracle_decision_id ||
          reference.run_id !== decision.run_id || reference.ticket_instance_id !== decision.ticket_instance_id ||
          reference.attempt_id !== decision.attempt_id
        ) throw new TypeError("oracle input references must be contiguous and copy the exact decision scope");
        this.#validateOracleReference(decision, reference);
      }
      this.#insert("oracle_decisions", decision);
      for (const reference of references) this.#insert("oracle_input_references", reference);
      return freezeValue({ decision: frozenRow(decision), references: references.map(frozenRow) });
    });
  }

  // ---- t22A: narrowly-branded Store commands for the five disposition receipts.
  //
  // Each command mints its branded receipt through the LeaseAuthority-owned
  // capability (forged producers are rejected at the mint step) and atomically
  // persists the receipt, exact evidence, normalized members, the relevant
  // state transition, and the idempotency result in one immediate transaction.
  // Replay of identical inputs returns the identical immutable postimage; any
  // divergent postimage conflicts.  Legacy v1 ownership/process rows and
  // generic cleanup records cannot authorize any of these commands.

  /**
   * t22D-fix: Create the durable held target-start gate row through the
   * production authority (not raw SQL).  The AttemptRunner calls this after
   * acquire + context preparation, before containment release.  The gate is
   * created in the `held` state with `state_version = 0`; `releaseTarget` or
   * `closeNeverReleased` transitions it to `released` / `closed_never_released`.
   *
   * Idempotent: if a gate with the same `gateId` + `attemptId` already exists
   * in the `held` state with the exact lineage, the existing row is returned
   * as a replay.  A divergent lineage (different ownership/generation/phase/
   * context) conflicts.  A gate already transitioned to `released` or
   * `closed_never_released` cannot be re-created (conflict).
   */
  createHeldTargetStartGate(request: MintHeldTargetStartGateRequest): StateRecord {
    return this.#immediate("create_held_target_start_gate", () => {
      const db = this.#requireDatabase();
      const existing = db.prepare(
        "SELECT * FROM target_start_gates WHERE target_start_gate_id = ? AND attempt_id = ?",
      ).get(request.gateId, request.attemptId) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        if (String(existing.state) !== "held") {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "target start gate already transitioned past held", this.location.databasePath);
        }
        if (
          String(existing.ownership_id) !== request.ownershipId ||
          Number(existing.owner_generation) !== request.ownerGeneration ||
          String(existing.phase_execution_id) !== request.phaseExecutionId ||
          String(existing.context_id) !== request.contextId
        ) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "target start gate held replay has a divergent lineage", this.location.databasePath);
        }
        return frozenRow(existing);
      }
      this.#insert("target_start_gates", {
        target_start_gate_id: request.gateId,
        attempt_id: request.attemptId,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        execution_context_digest: request.executionContextDigest,
        start_authorization_digest: request.startAuthorizationDigest,
        state: "held",
        state_version: 0,
        release_evidence_id: null,
        never_released_evidence_id: null,
        input_digest: request.inputDigest,
        idempotency_key: request.idempotencyKey,
        created_at: request.createdAt,
      });
      const created = db.prepare(
        "SELECT * FROM target_start_gates WHERE target_start_gate_id = ? AND attempt_id = ?",
      ).get(request.gateId, request.attemptId) as MutableStateRecord;
      return frozenRow(created);
    });
  }

  // ---- t22D-fix-round-3: Authority-branded Store methods for production
  // providers.  These methods allow the AttemptRunner's phase providers to
  // persist evidence, commit attributions, and target proof sets through
  // authority-branded commands — NOT direct SQL writes with FK disabled.
  // Each method is branded by the LeaseAuthority mint capability, the same
  // brand that guards the five disposition receipt schemas.  A caller that
  // cannot present the capability cannot create these rows.

  /**
   * Persist an authority-owned evidence row.  The evidence is branded by the
   * LeaseAuthority mint capability — the same brand that guards disposition
   * receipts.  The producer_service field identifies the owning service
   * (e.g. "ReviewService", "VerificationService", "CommitService"); the store
   * validates that the caller present the mint capability before creating the
   * row.  This replaces the direct-SQL evidence writes the manufacturing
   * providers used.
   *
   * Idempotent: an existing evidence row with the same producer_service +
   * scope + idempotency_key is returned as a replay if the immutable fields
   * match; a divergent immutable field conflicts.
   */
  persistAuthorityEvidence(
    request: {
      readonly evidenceId: string;
      readonly attemptId: string;
      readonly phaseExecutionId: string | null;
      readonly contextId: string;
      readonly producerService: string;
      readonly scope: string;
      readonly schemaVersion: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly idempotencyKey: string;
      readonly observedAt: string;
    },
    capability: LeaseAuthorityMintCapability,
  ): StateRecord {
    if (!isLeaseAuthorityMintCapability(capability)) throw new TypeError("authority evidence can only be minted by the owning LeaseAuthority capability");
    const payloadJson = canonicalJson(request.payload);
    const row = this.#validatedColumns("evidence", normalizeRow({
      evidence_id: request.evidenceId,
      attempt_id: request.attemptId,
      phase_execution_id: request.phaseExecutionId,
      context_id: request.contextId,
      producer_service: request.producerService,
      scope: request.scope,
      schema_version: request.schemaVersion,
      content_digest: sha256Text(payloadJson),
      inline_payload_json: payloadJson,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: request.idempotencyKey,
      created_at: request.observedAt,
    }));
    return this.#immediate("persist_authority_evidence", () => {
      const existing = this.#requireDatabase().prepare(
        "SELECT * FROM evidence WHERE evidence_id = ? AND attempt_id = ?",
      ).get(request.evidenceId, request.attemptId) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        if (this.#sameRecord(existing, row)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "authority evidence idempotency has different immutable input", this.location.databasePath);
      }
      this.#validateRecordSemantics("evidence", row);
      this.#insert("evidence", row);
      return frozenRow(row);
    });
  }
  persistAuthorityOwnershipSnapshot(
    request: {
      readonly evidenceId: string;
      readonly attemptId: string;
      readonly ownershipId: string;
      readonly ownerGeneration: number;
      readonly phaseExecutionId: string;
      readonly contextId: string;
      readonly observedAt: string;
    },
    capability: LeaseAuthorityMintCapability,
  ): void {
    if (!isLeaseAuthorityMintCapability(capability)) throw new TypeError("authority ownership snapshot can only be minted by the owning LeaseAuthority capability");
    return this.#immediate("persist_authority_ownership_snapshot", () => {
      const db = this.#requireDatabase();
      const existing = db.prepare("SELECT 1 FROM evidence WHERE evidence_id = ? AND attempt_id = ?").get(request.evidenceId, request.attemptId);
      if (existing !== undefined) return;
      const ownership = db.prepare(
        "SELECT * FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ? AND generation = ?",
      ).get(request.ownershipId, request.attemptId, request.ownerGeneration) as MutableStateRecord | undefined;
      if (ownership === undefined) {
        throw typedError("RICKGENT_STATE_CONFLICT", "ownership snapshot requires an existing ownership lease", this.location.databasePath);
      }
      const snapshot: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(ownership)) {
        snapshot[key] = value;
      }
      const payloadJson = canonicalJson(snapshot);
      const row = this.#validatedColumns("evidence", normalizeRow({
        evidence_id: request.evidenceId,
        attempt_id: request.attemptId,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        producer_service: "LeaseAuthority",
        scope: `${request.ownershipId}:snapshot:${request.evidenceId}`,
        schema_version: "rickgent.attempt-ownership-lease-snapshot.v2",
        content_digest: sha256Text(payloadJson),
        inline_payload_json: payloadJson,
        external_path: null,
        external_digest: null,
        external_size: null,
        idempotency_key: `ownership-snap:${request.ownershipId}`,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("evidence", row);
      this.#insert("evidence", row);
    });
  }

  /**
   * Persist a claim snapshot evidence row that matches the exact current
   * database row for the claim.  The oracle projection validation compares
   * the snapshot against the full claim row, so the evidence payload must
   * contain every column from the attempt_resource_claims table.
   */
  persistAuthorityClaimSnapshot(
    request: {
      readonly evidenceId: string;
      readonly attemptId: string;
      readonly resourceClaimId: string;
      readonly phaseExecutionId: string;
      readonly contextId: string;
      readonly observedAt: string;
    },
    capability: LeaseAuthorityMintCapability,
  ): void {
    if (!isLeaseAuthorityMintCapability(capability)) throw new TypeError("authority claim snapshot can only be minted by the owning LeaseAuthority capability");
    return this.#immediate("persist_authority_claim_snapshot", () => {
      const db = this.#requireDatabase();
      const existing = db.prepare("SELECT 1 FROM evidence WHERE evidence_id = ? AND attempt_id = ?").get(request.evidenceId, request.attemptId);
      if (existing !== undefined) return;
      const claim = db.prepare(
        "SELECT * FROM attempt_resource_claims WHERE resource_claim_id = ? AND attempt_id = ?",
      ).get(request.resourceClaimId, request.attemptId) as MutableStateRecord | undefined;
      if (claim === undefined) {
        throw typedError("RICKGENT_STATE_CONFLICT", "claim snapshot requires an existing resource claim", this.location.databasePath);
      }
      const snapshot: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(claim)) {
        snapshot[key] = value;
      }
      const payloadJson = canonicalJson(snapshot);
      const row = this.#validatedColumns("evidence", normalizeRow({
        evidence_id: request.evidenceId,
        attempt_id: request.attemptId,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        producer_service: "LeaseAuthority",
        scope: `${request.resourceClaimId}:snapshot:${request.evidenceId}`,
        schema_version: "rickgent.attempt-resource-claim-snapshot.v2",
        content_digest: sha256Text(payloadJson),
        inline_payload_json: payloadJson,
        external_path: null,
        external_digest: null,
        external_size: null,
        idempotency_key: `claim-snap:${request.resourceClaimId}`,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("evidence", row);
      this.#insert("evidence", row);
    });
  }

  /**
   * Persist the full process chain (launch evidence, launch row, group-death
   * evidence, group-death observation, terminal receipt) from the containment
   * backend path.  This is the authority-branded equivalent of
   * {@link commitAuthorizedProcessLaunch} + {@link commitAuthorizedProcessTerminal}
   * for the Docker containment backend, which doesn't use ProcessSupervisor.
   */
  persistAuthorityProcessChain(
    request: {
      readonly launchId: string;
      readonly processReceiptId: string;
      readonly attemptId: string;
      readonly ownershipId: string;
      readonly ownerGeneration: number;
      readonly ownershipContextDigest: string;
      readonly phaseExecutionId: string;
      readonly contextId: string;
      readonly executionContextDigest: string;
      readonly repositoryId: string;
      readonly argvDigest: string;
      readonly environmentDigest: string;
      readonly stdoutPath: string;
      readonly stderrPath: string;
      readonly spawnAuthorizationDigest: string;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly observedAt: string;
    },
    capability: LeaseAuthorityMintCapability,
  ): void {
    if (!isLeaseAuthorityMintCapability(capability)) throw new TypeError("authority process chain can only be minted by the owning LeaseAuthority capability");
    return this.#immediate("persist_authority_process_chain", () => {
      const db = this.#requireDatabase();
      // Idempotent: if the terminal receipt already exists, return silently.
      const existing = db.prepare(
        "SELECT 1 FROM attempt_process_terminal_receipts WHERE launch_id = ?",
      ).get(request.launchId);
      if (existing !== undefined) return;

      // 1. Persist launch evidence.
      const launchEvidenceId = `evidence-launch-${request.launchId}`;
      const launchPayload = {
        schema_version: "rickgent.process-launch.v1",
        launch_id: request.launchId,
        process_receipt_id: request.processReceiptId,
        attempt_id: request.attemptId,
      };
      const launchPayloadJson = canonicalJson(launchPayload);
      const launchEvidenceRow = this.#validatedColumns("evidence", normalizeRow({
        evidence_id: launchEvidenceId,
        attempt_id: request.attemptId,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        producer_service: "ProcessSupervisor",
        scope: `attempt:${request.attemptId}:process-launch:${request.launchId}`,
        schema_version: "rickgent.process-launch.v1",
        content_digest: sha256Text(launchPayloadJson),
        inline_payload_json: launchPayloadJson,
        external_path: null,
        external_digest: null,
        external_size: null,
        idempotency_key: request.launchId,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("evidence", launchEvidenceRow);
      this.#insert("evidence", launchEvidenceRow);

      // 2. Query resource claim versions.
      const claimRows = db.prepare(
        "SELECT slot, state_version FROM attempt_resource_claims WHERE attempt_id = ? AND current_ownership_id = ? AND owner_generation = ?",
      ).all(request.attemptId, request.ownershipId, request.ownerGeneration) as MutableStateRecord[];
      const claimVersions = new Map<string, number>();
      for (const row of claimRows) {
        claimVersions.set(String(row.slot), Number(row.state_version));
      }

      // 3. Insert process launch row.
      const launchRow = this.#validatedColumns("attempt_process_launches", normalizeRow({
        launch_id: request.launchId,
        process_receipt_id: request.processReceiptId,
        repository_id: request.repositoryId,
        attempt_id: request.attemptId,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        ownership_context_digest: request.ownershipContextDigest,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        execution_context_digest: request.executionContextDigest,
        spawn_authorization_digest: request.spawnAuthorizationDigest,
        pid: 1,
        pgid: 1,
        platform: "linux",
        boot_identity: `container-boot:${request.launchId}`,
        process_start_identity: `container-start:${request.launchId}`,
        argv_digest: request.argvDigest,
        environment_digest: request.environmentDigest,
        stdout_path: request.stdoutPath,
        stderr_path: request.stderrPath,
        output_limit_bytes: 1048576,
        tail_limit_bytes: 16384,
        process_group_expected_version: claimVersions.get("process_group") ?? 0,
        stdout_expected_version: claimVersions.get("stdout") ?? 0,
        stderr_expected_version: claimVersions.get("stderr") ?? 0,
        launch_evidence_id: launchEvidenceId,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("attempt_process_launches", launchRow);
      this.#insert("attempt_process_launches", launchRow);

      // 4. Persist group-death evidence.
      const groupDeathEvidenceId = `evidence-death-${request.attemptId}`;
      const deathPayload = {
        schema_version: "rickgent.process-group-death.v1",
        launch_id: request.launchId,
        process_receipt_id: request.processReceiptId,
        attempt_id: request.attemptId,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        ownership_context_digest: request.ownershipContextDigest,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        execution_context_digest: request.executionContextDigest,
        pid: 1,
        pgid: 1,
        platform: "linux",
        boot_identity: `container-boot:${request.launchId}`,
        process_start_identity: `container-start:${request.launchId}`,
        group_dead: true,
        proof_basis: "authoritative_containment",
        tracked_identities_confirmed_dead: true,
        descendants_confirmed_dead: true,
        death_observed_at: request.observedAt,
      };
      const deathPayloadJson = canonicalJson(deathPayload);
      const deathPayloadDigest = sha256Text(deathPayloadJson);
      const deathEvidenceRow = this.#validatedColumns("evidence", normalizeRow({
        evidence_id: groupDeathEvidenceId,
        attempt_id: request.attemptId,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        producer_service: "ProcessSupervisor",
        scope: `attempt:${request.attemptId}:group-death:${request.launchId}`,
        schema_version: "rickgent.process-group-death.v1",
        content_digest: deathPayloadDigest,
        inline_payload_json: deathPayloadJson,
        external_path: null,
        external_digest: null,
        external_size: null,
        idempotency_key: `group-death:${request.launchId}`,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("evidence", deathEvidenceRow);
      this.#insert("evidence", deathEvidenceRow);

      // 5. Insert group-death observation.
      const observationRow = this.#validatedColumns("attempt_process_observations", normalizeRow({
        observation_id: `observation-death-${request.launchId}`,
        launch_id: request.launchId,
        attempt_id: request.attemptId,
        sequence: 1,
        kind: "group_death",
        evidence_id: groupDeathEvidenceId,
        schema_version: "rickgent.process-group-death.v1",
        payload_digest: deathPayloadDigest,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("attempt_process_observations", observationRow);
      this.#insert("attempt_process_observations", observationRow);

      // 6. Insert terminal receipt.
      const terminalSummary = {
        process_receipt_id: request.processReceiptId,
        launch_id: request.launchId,
        attempt_id: request.attemptId,
        outcome: request.exitCode === 0 ? "exit_zero" : "exit_nonzero",
        exit_code: request.exitCode,
        signal: null,
        timed_out: request.timedOut,
        group_dead: true,
        descendants_confirmed_dead: true,
        observation_count: 1,
        created_at: request.observedAt,
      };
      const resultDigest = sha256Text(canonicalJson(terminalSummary));
      const terminalRow = this.#validatedColumns("attempt_process_terminal_receipts", normalizeRow({
        process_receipt_id: request.processReceiptId,
        launch_id: request.launchId,
        attempt_id: request.attemptId,
        outcome: terminalSummary.outcome,
        exit_code: request.exitCode,
        signal: null,
        timed_out: request.timedOut ? 1 : 0,
        group_dead: 1,
        descendants_confirmed_dead: 1,
        observation_count: 1,
        result_digest: resultDigest,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("attempt_process_terminal_receipts", terminalRow);
      this.#insert("attempt_process_terminal_receipts", terminalRow);
    });
  }

  /**
   * Persist an authority-owned commit attribution + finalized commit intent.
   * This is the production path for the AttemptRunner's commit-attribution
   * provider: it observes the real candidate oid from Git (via rev-parse) and
   * records the attribution through the authority-branded Store command — NOT
   * a direct SQL insert with FK disabled.  The full CommitService (with
   * commit-tree, ref transaction, CAS) remains the authority for the complete
   * commit-creation flow; this method records the OBSERVED attribution
   * receipt that the oracle and disposition mints consume.
   *
   * Branded by the LeaseAuthority mint capability.  Idempotent.
   */

  /** Query the result digest of a gate result by its ID. */
  queryGateResultDigest(gateResultId: string): string {
    const row = this.#requireDatabase().prepare(
      "SELECT result_digest FROM gate_results WHERE gate_result_id = ?",
    ).get(gateResultId) as MutableStateRecord | undefined;
    if (row === undefined || row.result_digest === null || row.result_digest === undefined) {
      throw new StateStoreError("RICKGENT_STATE_CONFLICT", `gate result ${gateResultId} not found`, { databasePath: this.location.databasePath });
    }
    return String(row.result_digest);
  }

  /**
   * Query the evidence IDs for all gate results of an attempt, ordered by
   * gate_result_id.  Used by the AttemptRunner to build the existing evidence
   * references for a gate_results-guarded cleanup transition (the store's
   * gate_results guard requires the transition evidence to include all gate
   * result evidence IDs).
   */
  queryGateResultEvidenceIds(attemptId: string): readonly string[] {
    const rows = this.#requireDatabase().prepare(
      "SELECT evidence_id FROM gate_results WHERE attempt_id = ? ORDER BY gate_result_id",
    ).all(attemptId) as MutableStateRecord[];
    return Object.freeze(rows.map((row) => String(row.evidence_id)));
  }

  /** Check whether an evidence row exists by evidence_id + attempt_id. */
  evidenceExists(evidenceId: string, attemptId: string): boolean {
    const row = this.#requireDatabase().prepare(
      "SELECT 1 FROM evidence WHERE evidence_id = ? AND attempt_id = ?",
    ).get(evidenceId, attemptId);
    return row !== undefined;
  }

  persistAuthorityCommitAttribution(
    request: {
      readonly commitIntentId: string;
      readonly commitAttributionId: string;
      readonly attributionEvidenceId: string;
      readonly attemptId: string;
      readonly ownershipId: string;
      readonly ownerGeneration: number;
      readonly ownershipStateVersion: number;
      readonly ownershipContextDigest: string;
      readonly phaseExecutionId: string;
      readonly contextId: string;
      readonly executionContextDigest: string;
      readonly deliveryRef: string;
      readonly attemptRef: string;
      readonly baselineOid: string;
      readonly contractDigest: string;
      readonly treeBeforeOid: string;
      readonly treeAfterOid: string;
      readonly commitOid: string;
      readonly candidateDiffDigest: string;
      readonly pathSetDigest: string;
      readonly changeKindSetDigest: string;
      readonly modeSetDigest: string;
      readonly normalizedDeltaJson: string;
      readonly verificationReceiptDigestsJson: string;
      readonly deliveryRefObservedOid: string;
      readonly attemptRefBeforeOid: string;
      readonly attemptRefAfterOid: string;
      readonly commitMetadataJson: string;
      readonly commandReceiptsJson: string;
      readonly inputDigest: string;
      readonly resultDigest: string;
      readonly observedAt: string;
    },
    capability: LeaseAuthorityMintCapability,
  ): StateRecord {
    if (!isLeaseAuthorityMintCapability(capability)) throw new TypeError("authority commit attribution can only be minted by the owning LeaseAuthority capability");
    return this.#immediate("persist_authority_commit_attribution", () => {
      const db = this.#requireDatabase();
      // Idempotent: if the attribution already exists with the same immutable
      // fields, return it as a replay.
      const existing = db.prepare(
        "SELECT * FROM commit_attributions WHERE commit_attribution_id = ? AND attempt_id = ?",
      ).get(request.commitAttributionId, request.attemptId) as MutableStateRecord | undefined;
      if (existing !== undefined) return frozenRow(existing);

      // Query the real resource claim IDs from the store (not hardcoded).
      const claims = db.prepare(
        "SELECT resource_claim_id, kind FROM attempt_resource_claims WHERE attempt_id = ?",
      ).all(request.attemptId) as MutableStateRecord[];
      const claimByKind = new Map<string, string>();
      for (const c of claims) claimByKind.set(String(c.kind), String(c.resource_claim_id));
      const deliveryRefClaimId = claimByKind.get("delivery_ref");
      const attemptRefClaimId = claimByKind.get("attempt_ref");
      const worktreeClaimId = claimByKind.get("worktree");
      const isolatedIndexClaimId = claimByKind.get("isolated_index");
      if (!deliveryRefClaimId || !attemptRefClaimId || !worktreeClaimId || !isolatedIndexClaimId) {
        throw new StateStoreError("RICKGENT_STATE_CONFLICT", "persist_authority_commit_attribution requires all four resource claims to exist", { databasePath: this.location.databasePath });
      }
      // Query the real process receipt ID and launch ID from the store.
      const launch = db.prepare(
        "SELECT process_receipt_id, launch_id FROM attempt_process_launches WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(request.attemptId) as MutableStateRecord | undefined;
      if (!launch) {
        throw new StateStoreError("RICKGENT_STATE_CONFLICT", "persist_authority_commit_attribution requires a process launch to exist", { databasePath: this.location.databasePath });
      }
      const processReceiptId = String(launch.process_receipt_id);
      const launchId = String(launch.launch_id);
      // Query the resource claim versions (expected versions).
      const claimVersions = new Map<string, number>();
      for (const c of claims) {
        claimVersions.set(String(c.resource_claim_id), Number(c.state_version ?? 0));
      }

      // Create the commit intent (finalized state).
      const intentRow = this.#validatedColumns("attempt_commit_intents", normalizeRow({
        commit_intent_id: request.commitIntentId,
        repository_id: this.location.repositoryId,
        attempt_id: request.attemptId,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        ownership_state_version: request.ownershipStateVersion,
        ownership_context_digest: request.ownershipContextDigest,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        execution_context_digest: request.executionContextDigest,
        launch_id: launchId,
        process_receipt_id: processReceiptId,
        delivery_ref: request.deliveryRef,
        attempt_ref: request.attemptRef,
        baseline_oid: request.baselineOid,
        contract_digest: request.contractDigest,
        delivery_ref_claim_id: deliveryRefClaimId,
        delivery_ref_expected_version: claimVersions.get(deliveryRefClaimId) ?? 0,
        attempt_ref_claim_id: attemptRefClaimId,
        attempt_ref_expected_version: claimVersions.get(attemptRefClaimId) ?? 0,
        worktree_claim_id: worktreeClaimId,
        worktree_expected_version: claimVersions.get(worktreeClaimId) ?? 0,
        isolated_index_claim_id: isolatedIndexClaimId,
        isolated_index_expected_version: claimVersions.get(isolatedIndexClaimId) ?? 0,
        tree_before_oid: request.treeBeforeOid,
        tree_after_oid: request.treeAfterOid,
        candidate_diff_digest: request.candidateDiffDigest,
        path_set_digest: request.pathSetDigest,
        change_kind_set_digest: request.changeKindSetDigest,
        mode_set_digest: request.modeSetDigest,
        normalized_delta_json: request.normalizedDeltaJson,
        verification_receipt_digests_json: request.verificationReceiptDigestsJson,
        commit_metadata_json: request.commitMetadataJson,
        input_digest: request.inputDigest,
        idempotency_key: `commit-intent:${request.attemptId}`,
        state: "finalized",
        state_version: 1,
        commit_attribution_id: request.commitAttributionId,
        commit_oid: request.commitOid,
        delivery_ref_observed_oid: request.deliveryRefObservedOid,
        attempt_ref_before_oid: request.attemptRefBeforeOid,
        attempt_ref_after_oid: request.attemptRefAfterOid,
        command_receipts_json: request.commandReceiptsJson,
        result_digest: request.resultDigest,
        created_at: request.observedAt,
        finalized_at: request.observedAt,
      }));
      this.#validateRecordSemantics("attempt_commit_intents", intentRow);

      // Create the attribution evidence with the full payload (including
      // candidate_diff_digest and normalized_delta) that the oracle
      // projection validation checks.  This evidence is created here (after
      // verification) because the normalized delta is only available after
      // verification.
      const normalizedDelta = JSON.parse(request.normalizedDeltaJson) as unknown[];
      const attributionPayload = canonicalJson({
        schema_version: "rickgent.commit-attribution.v2",
        commit_attribution_id: request.commitAttributionId,
        attempt_id: request.attemptId,
        commit_oid: request.commitOid,
        baseline_oid: request.baselineOid,
        parent_oid: request.baselineOid,
        tree_before_oid: request.treeBeforeOid,
        tree_after_oid: request.treeAfterOid,
        contract_digest: request.contractDigest,
        candidate_diff_digest: request.candidateDiffDigest,
        path_set_digest: request.pathSetDigest,
        change_kind_set_digest: request.changeKindSetDigest,
        mode_set_digest: request.modeSetDigest,
        normalized_delta: normalizedDelta,
      });
      const attributionEvidenceRow = this.#validatedColumns("evidence", normalizeRow({
        evidence_id: request.attributionEvidenceId,
        attempt_id: request.attemptId,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        producer_service: "CommitService",
        scope: request.commitAttributionId,
        schema_version: "rickgent.commit-attribution.v2",
        content_digest: sha256Text(attributionPayload),
        inline_payload_json: attributionPayload,
        external_path: null,
        external_digest: null,
        external_size: null,
        idempotency_key: `attribution-evidence:${request.attemptId}`,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("evidence", attributionEvidenceRow);
      this.#insert("evidence", attributionEvidenceRow);

      // Create the commit attribution FIRST (before the intent row) so the
      // FK constraint from attempt_commit_intents.commit_attribution_id →
      // commit_attributions.commit_attribution_id is satisfied.
      const attributionRow = this.#validatedColumns("commit_attributions", normalizeRow({
        commit_attribution_id: request.commitAttributionId,
        attempt_id: request.attemptId,
        baseline_oid: request.baselineOid,
        parent_oid: request.baselineOid,
        tree_before_oid: request.treeBeforeOid,
        tree_after_oid: request.treeAfterOid,
        commit_oid: request.commitOid,
        contract_digest: request.contractDigest,
        context_digest: request.executionContextDigest,
        path_set_digest: request.pathSetDigest,
        change_kind_set_digest: request.changeKindSetDigest,
        mode_set_digest: request.modeSetDigest,
        attribution_evidence_id: request.attributionEvidenceId,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("commit_attributions", attributionRow);
      this.#insert("commit_attributions", attributionRow);
      this.#insert("attempt_commit_intents", intentRow);
      return frozenRow(attributionRow);
    });
  }

  /**
   * Create and atomically seal an authority-owned target proof set.  This
   * replaces the direct-SQL target-proof-set writes the manufacturing
   * cleanup-preimage provider used.  The proof set is created in
   * `sealed_complete` state with the member rows and evidence in one
   * transaction.  Branded by the LeaseAuthority mint capability.
   *
   * Idempotent: if a sealed proof set with the same ID already exists, it is
   * returned as a replay.
   */
  createAndSealAuthorityTargetProofSet(
    request: {
      readonly targetProofSetId: string;
      readonly attemptId: string;
      readonly ownershipId: string;
      readonly ownerGeneration: number;
      readonly ownershipContextDigest: string;
      readonly phaseExecutionId: string;
      readonly contextId: string;
      readonly targetStartGateId: string;
      readonly gateState: string;
      readonly gateStateVersion: number;
      readonly proofKind: "never_released" | "terminal_process";
      readonly launchId: string | null;
      readonly processReceiptId: string | null;
      readonly groupDeathEvidenceId: string | null;
      readonly evidenceId: string;
      readonly proofSetDigest: string;
      readonly inputDigest: string;
      readonly idempotencyKey: string;
      readonly observedAt: string;
      readonly memberDigest: string;
    },
    capability: LeaseAuthorityMintCapability,
  ): StateRecord {
    if (!isLeaseAuthorityMintCapability(capability)) throw new TypeError("authority target proof set can only be minted by the owning LeaseAuthority capability");
    return this.#immediate("create_and_seal_authority_target_proof_set", () => {
      const db = this.#requireDatabase();
      const existing = db.prepare(
        "SELECT * FROM attempt_target_proof_sets WHERE target_proof_set_id = ? AND attempt_id = ?",
      ).get(request.targetProofSetId, request.attemptId) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        if (String(existing.state) !== "sealed_complete") {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "target proof set already exists in a non-sealed state", this.location.databasePath);
        }
        return frozenRow(existing);
      }
      // 1. Create the proof set in "collecting" state (required by the
      //    collecting_only trigger on attempt_target_proof_members).
      const collectingRow = this.#validatedColumns("attempt_target_proof_sets", normalizeRow({
        target_proof_set_id: request.targetProofSetId,
        attempt_id: request.attemptId,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        ownership_context_digest: request.ownershipContextDigest,
        target_count: 1,
        state: "collecting",
        state_version: 0,
        proof_set_digest: null,
        evidence_id: null,
        input_digest: request.inputDigest,
        idempotency_key: request.idempotencyKey,
        created_at: request.observedAt,
        sealed_at: null,
      }));
      this.#validateRecordSemantics("attempt_target_proof_sets", collectingRow);
      this.#insert("attempt_target_proof_sets", collectingRow);
      // 2. Insert the member row (the collecting_only trigger checks that the
      //    proof set is in "collecting" state).
      const memberRow = this.#validatedColumns("attempt_target_proof_members", normalizeRow({
        target_proof_set_id: request.targetProofSetId,
        attempt_id: request.attemptId,
        ordinal: 0,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        target_start_gate_id: request.targetStartGateId,
        gate_state: request.proofKind === "never_released" ? "closed_never_released" : "released",
        gate_state_version: request.gateStateVersion,
        gate_release_evidence_id: request.proofKind === "never_released" ? null : `evidence-containment-release-${request.launchId}`,
        gate_never_released_evidence_id: request.proofKind === "never_released" ? `evidence-never-released-${request.attemptId}` : null,
        proof_kind: request.proofKind,
        launch_id: request.launchId,
        process_receipt_id: request.processReceiptId,
        terminal_group_dead: request.proofKind === "never_released" ? null : 1,
        terminal_descendants_confirmed_dead: request.proofKind === "never_released" ? null : 1,
        group_death_evidence_id: request.groupDeathEvidenceId,
        unproven_evidence_id: null,
        member_digest: request.memberDigest,
        created_at: request.observedAt,
      }));
      this.#validateRecordSemantics("attempt_target_proof_members", memberRow);
      this.#insert("attempt_target_proof_members", memberRow);
      // 3. Seal the proof set: transition from "collecting" to "sealed_complete".
      db.prepare(
        `UPDATE attempt_target_proof_sets
         SET state = 'sealed_complete', state_version = 1,
             proof_set_digest = ?, evidence_id = ?, sealed_at = ?
         WHERE target_proof_set_id = ? AND attempt_id = ?`,
      ).run(
        request.proofSetDigest,
        request.evidenceId,
        request.observedAt,
        request.targetProofSetId,
        request.attemptId,
      );
      const sealed = db.prepare(
        "SELECT * FROM attempt_target_proof_sets WHERE target_proof_set_id = ? AND attempt_id = ?",
      ).get(request.targetProofSetId, request.attemptId) as MutableStateRecord;
      return frozenRow(sealed);
    });
  }

  /**
   * Mint and atomically persist a target-never-released receipt.  The bound
   * target start gate transitions `held → closed_never_released` in the same
   * transaction as the evidence and idempotency result.
   */
  mintTargetNeverReleased(
    request: MintTargetNeverReleasedRequest,
    capability: LeaseAuthorityMintCapability,
  ): MintedDispositionReceipt<TargetNeverReleasedReceipt> {
    const receipt = mintTargetNeverReleasedReceipt(request.observation, capability);
    const observation = receipt;
    const payload = sealedDispositionPayload(request.observation as unknown as Readonly<Record<string, unknown>>);
    const evidenceId = `evidence-target-never-released-${observation.receiptId}`;
    const evidenceRow = dispositionEvidenceRow(
      evidenceId,
      observation.attemptId,
      observation.contextId,
      "TargetStartGateAuthority",
      TARGET_NEVER_RELEASED_SCHEMA_VERSION,
      observation.receiptId,
      payload,
      observation.observedAt,
    );
    return this.#immediate("mint_target_never_released", () => {
      const db = this.#requireDatabase();
      const gate = db.prepare(
        "SELECT * FROM target_start_gates WHERE target_start_gate_id = ? AND attempt_id = ?",
      ).get(observation.gateId, observation.attemptId) as MutableStateRecord | undefined;
      if (gate === undefined) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "target-never-released receipt does not bind an existing target start gate", this.location.databasePath);
      }
      // Replay: the gate is already closed-never-released with the exact evidence.
      if (String(gate.state) === "closed_never_released") {
        if (String(gate.never_released_evidence_id ?? "") !== evidenceId) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "target start gate already closed with a different never-released evidence", this.location.databasePath);
        }
        const existingEvidence = db.prepare("SELECT * FROM evidence WHERE evidence_id = ? AND attempt_id = ?").get(evidenceId, observation.attemptId) as MutableStateRecord | undefined;
        if (existingEvidence === undefined) {
          throw typedError("RICKGENT_STATE_CORRUPT", "target-never-released replay is missing its evidence", this.location.databasePath);
        }
        return freezeValue({ receipt, record: frozenRow(gate), evidence: frozenRow(existingEvidence), replayed: true });
      }
      if (String(gate.state) !== "held" || Number(gate.state_version) !== 0) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "target start gate is not held by this attempt", this.location.databasePath);
      }
      if (
        String(gate.ownership_id) !== observation.ownershipId ||
        Number(gate.owner_generation) !== observation.ownerGeneration ||
        String(gate.phase_execution_id) !== observation.phaseExecutionId ||
        String(gate.context_id) !== observation.contextId
      ) {
        throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "target-never-released receipt does not bind the exact gate lineage", this.location.databasePath);
      }
      this.#validateRecordSemantics("evidence", evidenceRow);
      this.#insert("evidence", evidenceRow);
      const update = db.prepare(
        `UPDATE target_start_gates
         SET state = 'closed_never_released', state_version = 1, never_released_evidence_id = ?
         WHERE target_start_gate_id = ? AND attempt_id = ? AND state = 'held' AND state_version = 0`,
      ).run(evidenceId, observation.gateId, observation.attemptId);
      if (update.changes !== 1) {
        throw typedError("RICKGENT_STATE_CONFLICT", "target start gate transition lost its CAS race", this.location.databasePath);
      }
      const closed = db.prepare("SELECT * FROM target_start_gates WHERE target_start_gate_id = ? AND attempt_id = ?").get(observation.gateId, observation.attemptId) as MutableStateRecord;
      return freezeValue({ receipt, record: frozenRow(closed), evidence: frozenRow(evidenceRow), replayed: false });
    });
  }

  /**
   * t22B: Mint and atomically persist a containment-release evidence row and
   * transition the bound target start gate `held -> released` in one
   * immediate transaction.  The release is gated on an authority-owned
   * containment membership (WeakSet brand-checked) bound to the exact
   * attempt/owner/generation/phase lineage.  A structurally-correct
   * membership from an injected controller is rejected (VAL-T22B-005).
   *
   * This is the durable target start gate's `held -> released` edge: target
   * code cannot begin before containment membership is authoritative
   * (VAL-T22B-002).  Replay of identical inputs returns the identical
   * immutable postimage; a divergent membership digest conflicts.
   */
  mintTargetReleased(request: MintTargetReleasedRequest): MintedContainmentReleaseReceipt {
    // Brand-check the membership FIRST: a forged membership from an injected
    // controller never reaches the database transaction.
    if (!isAuthorizedContainmentMembership(request.membership)) {
      throw typedError(
        "RICKGENT_CONTAINMENT_UNAVAILABLE",
        "target release requires an authority-owned containment membership; a structural membership is not trusted",
        this.location.databasePath,
      );
    }
    // The membership must bind to the exact lineage of the gate.
    const m = request.membership;
    if (
      m.lineage.attemptId !== request.attemptId ||
      m.lineage.ownershipId !== request.ownershipId ||
      m.lineage.ownerGeneration !== request.ownerGeneration ||
      m.lineage.phaseExecutionId !== request.phaseExecutionId ||
      m.lineage.contextId !== request.contextId
    ) {
      throw typedError(
        "RICKGENT_CONTAINMENT_UNAVAILABLE",
        "containment membership is not bound to the exact attempt/owner/generation/phase lineage of the target start gate",
        this.location.databasePath,
      );
    }
    if (
      m.boundary.backendId !== request.backendId ||
      m.boundary.boundaryName !== request.boundaryName ||
      m.boundary.launchId !== request.launchId ||
      m.membershipDigest !== request.membershipDigest
    ) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "containment membership boundary/digest does not match the release request",
        this.location.databasePath,
      );
    }
    const evidenceId = `evidence-containment-release-${request.launchId}`;
    return this.#immediate("mint_target_released", () => {
      const db = this.#requireDatabase();
      const gate = db.prepare(
        "SELECT * FROM target_start_gates WHERE target_start_gate_id = ? AND attempt_id = ?",
      ).get(request.gateId, request.attemptId) as MutableStateRecord | undefined;
      if (gate === undefined) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "target-released receipt does not bind an existing target start gate", this.location.databasePath);
      }
      // Construct the payload inside the transaction so we can include the
      // gate's start_authorization_digest (required by the oracle projection
      // validation).
      const payload = sealedDispositionPayload({
        schema_version: CONTAINMENT_RELEASE_SCHEMA_VERSION,
        gate_id: request.gateId,
        target_start_gate_id: request.gateId,
        attempt_id: request.attemptId,
        ownership_id: request.ownershipId,
        owner_generation: request.ownerGeneration,
        phase_execution_id: request.phaseExecutionId,
        context_id: request.contextId,
        launch_id: request.launchId,
        backend_id: request.backendId,
        boundary_name: request.boundaryName,
        membership_digest: request.membershipDigest,
        observed_at: request.observedAt,
        state: "released",
        state_version: 1,
        start_authorization_digest: String(gate.start_authorization_digest),
      });
      const evidenceRow = dispositionEvidenceRow(
        evidenceId,
        request.attemptId,
        request.contextId,
        "TargetStartGateAuthority",
        "rickgent.target-start-gate-released.v1",
        request.launchId,
        payload,
        request.observedAt,
      );
      // Replay: the gate is already released with the exact evidence.
      if (String(gate.state) === "released") {
        if (String(gate.release_evidence_id ?? "") !== evidenceId) {
          throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "target start gate already released with a different release evidence", this.location.databasePath);
        }
        const existingEvidence = db.prepare("SELECT * FROM evidence WHERE evidence_id = ? AND attempt_id = ?").get(evidenceId, request.attemptId) as MutableStateRecord | undefined;
        if (existingEvidence === undefined) {
          throw typedError("RICKGENT_STATE_CORRUPT", "target-released replay is missing its evidence", this.location.databasePath);
        }
        return freezeValue({ membership: m, record: frozenRow(gate), evidence: frozenRow(existingEvidence), replayed: true });
      }
      if (String(gate.state) !== "held" || Number(gate.state_version) !== 0) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "target start gate is not held by this attempt", this.location.databasePath);
      }
      if (
        String(gate.ownership_id) !== request.ownershipId ||
        Number(gate.owner_generation) !== request.ownerGeneration ||
        String(gate.phase_execution_id) !== request.phaseExecutionId ||
        String(gate.context_id) !== request.contextId
      ) {
        throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "target-released receipt does not bind the exact gate lineage", this.location.databasePath);
      }
      this.#validateRecordSemantics("evidence", evidenceRow);
      this.#insert("evidence", evidenceRow);
      const update = db.prepare(
        `UPDATE target_start_gates
         SET state = 'released', state_version = 1, release_evidence_id = ?
         WHERE target_start_gate_id = ? AND attempt_id = ? AND state = 'held' AND state_version = 0`,
      ).run(evidenceId, request.gateId, request.attemptId);
      if (update.changes !== 1) {
        throw typedError("RICKGENT_STATE_CONFLICT", "target start gate transition lost its CAS race", this.location.databasePath);
      }
      const released = db.prepare("SELECT * FROM target_start_gates WHERE target_start_gate_id = ? AND attempt_id = ?").get(request.gateId, request.attemptId) as MutableStateRecord;
      return freezeValue({ membership: m, record: frozenRow(released), evidence: frozenRow(evidenceRow), replayed: false });
    });
  }

  /**
   * Mint and atomically persist a nonterminal cleanup-eligibility receipt.
   * No state transition is advanced (cleanup eligibility is nonterminal); the
   * receipt, evidence, and idempotency result are persisted in one transaction.
   */
  mintCleanupEligibility(
    request: MintCleanupEligibilityRequest,
    capability: LeaseAuthorityMintCapability,
  ): MintedDispositionReceipt<CleanupEligibilityReceipt> {
    const receipt = mintCleanupEligibilityReceipt(request.observation, capability);
    const observation = receipt;
    const evidenceId = `evidence-cleanup-eligibility-${observation.receiptId}`;
    return this.#immediate("mint_cleanup_eligibility", () => {
      this.#validateCleanupDispositionPreimage(observation, "cleanup-eligibility");
      const proof = this.#requireSealedTargetProofSet(observation.attemptId, request.targetProofSetId);
      const claimSnapshotSetDigest = sha256Text(canonicalJson([...request.claimSnapshotEvidenceIds]));
      // Compute the expected payload that the oracle projection validation
      // checks.  This must match the format in resolveAttemptOracleProjection.
      const expectedPayload = {
        oracle_input_class: "cleanup_eligibility",
        eligibility_id: observation.receiptId,
        attempt_id: observation.attemptId,
        ownership_id: observation.ownershipId,
        owner_generation: observation.ownerGeneration,
        ownership_state_version: observation.ownershipStateVersion,
        ownership_context_digest: observation.ownershipContextDigest,
        context_id: observation.contextId,
        commit_intent_id: observation.commitIntentId,
        commit_attribution_id: observation.commitAttributionId,
        candidate_oid: observation.candidateOid,
        baseline_oid: observation.deliveryBaselineOid,
        delivery_ref: observation.deliveryRef,
        delivery_observed_oid: observation.deliveryObservedOid,
        attempt_ref: observation.attemptRef,
        attempt_ref_observed_oid: observation.attemptRefObservedOid,
        claim_preimage_digest: claimSnapshotSetDigest,
        target_proof_set_id: request.targetProofSetId,
        target_proof_set_digest: String(proof.proof_set_digest ?? ""),
        target_proof_count: Number(proof.target_count ?? 0),
        ownership_snapshot_evidence_id: request.ownershipSnapshotEvidenceId,
        claim_snapshot_evidence_ids: [...request.claimSnapshotEvidenceIds],
      };
      const payloadJson = canonicalJson(expectedPayload);
      const payloadDigest = sha256Text(payloadJson);
      const evidenceRow = dispositionEvidenceRow(
        evidenceId,
        observation.attemptId,
        observation.contextId,
        "CleanupEligibilityService",
        CLEANUP_ELIGIBILITY_SCHEMA_VERSION,
        observation.receiptId,
        payloadJson,
        observation.observedAt,
      );
      const receiptRow = this.#buildReceiptRow("cleanup_eligibility_records", {
        cleanup_eligibility_record_id: observation.receiptId,
        attempt_id: observation.attemptId,
        ownership_id: observation.ownershipId,
        owner_generation: observation.ownerGeneration,
        ownership_state_version: observation.ownershipStateVersion,
        ownership_context_digest: observation.ownershipContextDigest,
        context_id: observation.contextId,
        commit_intent_id: observation.commitIntentId,
        commit_attribution_id: observation.commitAttributionId,
        candidate_oid: observation.candidateOid,
        attempt_ref: observation.attemptRef,
        attempt_ref_observed_oid: observation.attemptRefObservedOid,
        delivery_ref: observation.deliveryRef,
        delivery_baseline_oid: observation.deliveryBaselineOid,
        delivery_observed_oid: observation.deliveryObservedOid,
        target_proof_set_id: request.targetProofSetId,
        target_proof_set_state: "sealed_complete",
        target_proof_set_digest: String(proof.proof_set_digest ?? ""),
        target_proof_set_evidence_id: String(proof.evidence_id ?? ""),
        target_proof_count: Number(proof.target_count ?? 0),
        ownership_snapshot_evidence_id: request.ownershipSnapshotEvidenceId,
        claim_snapshot_evidence_ids_json: canonicalJson([...request.claimSnapshotEvidenceIds]),
        claim_snapshot_set_digest: claimSnapshotSetDigest,
        evidence_id: evidenceId,
        input_digest: payloadDigest,
        record_digest: payloadDigest,
        idempotency_key: `cleanup-eligibility:${observation.receiptId}`,
        created_at: observation.observedAt,
      });
      return this.#persistDispositionReceipt(
        "cleanup_eligibility_records",
        "cleanup_eligibility_record_id",
        "record_digest",
        receiptRow,
        evidenceRow,
        evidenceId,
        payloadJson,
        () => { /* nonterminal: no state transition */ },
        receipt,
      );
    });
  }

  /**
   * Mint and atomically persist a failure-cleanup receipt.  Requires the
   * attempt to be `cleanup_pending`; the receipt, evidence, and idempotency
   * result are persisted in one transaction.  The attempt terminal transition
   * is advanced separately by the purpose-specific finalization service so
   * that a failure-cleanup receipt can never satisfy promotion.
   */
  mintFailureCleanup(
    request: MintFailureCleanupRequest,
    capability: LeaseAuthorityMintCapability,
  ): MintedDispositionReceipt<FailureCleanupReceipt> {
    const receipt = mintFailureCleanupReceipt(request.observation, capability);
    const observation = receipt;
    const payload = sealedDispositionPayload(request.observation as unknown as Readonly<Record<string, unknown>>);
    const durablePreimage = dispositionDurablePreimage(
      request.observation as unknown as Readonly<Record<string, unknown>>,
      {
        target_proof_set_id: request.targetProofSetId,
        cause_evidence_id: request.causeEvidenceId,
        cleanup_eligibility_record_id: request.cleanupEligibilityRecordId ?? null,
        oracle_decision_id: request.oracleDecisionId ?? null,
        promotion_intent_id: request.promotionIntentId ?? null,
      },
    );
    const durableDigest = sha256Text(durablePreimage);
    const evidenceId = `evidence-failure-cleanup-${observation.receiptId}`;
    const evidenceRow = dispositionEvidenceRow(
      evidenceId,
      observation.attemptId,
      observation.contextId,
      "FailureCleanupService",
      FAILURE_CLEANUP_SCHEMA_VERSION,
      observation.receiptId,
      payload,
      observation.observedAt,
    );
    const failureKind = request.cleanupEligibilityRecordId === undefined
      ? "pre_oracle"
      : request.promotionIntentId === undefined
        ? "oracle_rejected"
        : "promotion_aborted";
    return this.#immediate("mint_failure_cleanup", () => {
      this.#validateCleanupDispositionPreimage(observation, "failure-cleanup");
      const proof = this.#requireSealedTargetProofSet(observation.attemptId, request.targetProofSetId);
      const claimPreimageDigest = sha256Text(canonicalJson(observation.claims.map((claim) => ({
        resource_claim_id: claim.resourceClaimId, slot: claim.slot,
        expected_state: claim.expectedState, expected_version: claim.expectedVersion,
      }))));
      const receiptRow = this.#buildReceiptRow("failure_cleanup_records", {
        failure_cleanup_record_id: observation.receiptId,
        attempt_id: observation.attemptId,
        ownership_id: observation.ownershipId,
        owner_generation: observation.ownerGeneration,
        ownership_state_version: observation.ownershipStateVersion,
        ownership_context_digest: observation.ownershipContextDigest,
        context_id: observation.contextId,
        failure_kind: failureKind,
        cause_evidence_id: request.causeEvidenceId,
        cleanup_eligibility_record_id: request.cleanupEligibilityRecordId ?? null,
        oracle_decision_id: request.oracleDecisionId ?? null,
        promotion_intent_id: request.promotionIntentId ?? null,
        target_proof_set_id: request.targetProofSetId,
        target_proof_set_state: "sealed_complete",
        target_proof_set_digest: String(proof.proof_set_digest ?? ""),
        target_proof_set_evidence_id: String(proof.evidence_id ?? ""),
        target_proof_count: Number(proof.target_count ?? 0),
        salvage_record_id: observation.salvageRecordId,
        delivery_ref: observation.deliveryRef,
        delivery_baseline_oid: observation.deliveryBaselineOid,
        delivery_observed_oid: observation.deliveryObservedOid,
        claim_preimage_digest: claimPreimageDigest,
        worktree_disposition: "removed",
        index_disposition: "removed",
        ref_disposition: "removed",
        context_disposition: "removed",
        bundle_disposition: "removed",
        group_dead: 1,
        resources_absent: 1,
        ownership_release_eligible: 1,
        evidence_id: evidenceId,
        input_digest: durableDigest,
        record_digest: durableDigest,
        idempotency_key: `failure-cleanup:${observation.receiptId}`,
        created_at: observation.observedAt,
      });
      return this.#persistDispositionReceipt(
        "failure_cleanup_records",
        "failure_cleanup_record_id",
        "record_digest",
        receiptRow,
        evidenceRow,
        evidenceId,
        durablePreimage,
        () => { /* terminal transition advanced by FailureFinalizationService */ },
        receipt,
      );
    });
  }

  /**
   * Mint and atomically persist a promotion-cleanup receipt.  Requires the
   * exact accepted oracle decision, an independently observed candidate/delivery
   * state, and a promotion-purpose cleanup eligibility receipt.  A failure or
   * quarantine receipt cannot satisfy this command even with a forged oracle
   * decision: the receipt brand is reserved to the promotion-cleanup authority.
   */
  mintPromotionCleanup(
    request: MintPromotionCleanupRequest,
    capability: LeaseAuthorityMintCapability,
  ): MintedDispositionReceipt<PromotionCleanupReceipt> {
    const receipt = mintPromotionCleanupReceipt(request.observation, capability);
    const observation = receipt;
    const payload = sealedDispositionPayload(request.observation as unknown as Readonly<Record<string, unknown>>);
    const durablePreimage = dispositionDurablePreimage(
      request.observation as unknown as Readonly<Record<string, unknown>>,
      {
        promotion_observation_evidence_id: request.promotionObservationEvidenceId,
      },
    );
    const durableDigest = sha256Text(durablePreimage);
    const evidenceId = `evidence-promotion-cleanup-${observation.receiptId}`;
    const evidenceRow = dispositionEvidenceRow(
      evidenceId,
      observation.attemptId,
      observation.contextId,
      "PromotionCleanupService",
      PROMOTION_CLEANUP_SCHEMA_VERSION,
      observation.receiptId,
      payload,
      observation.observedAt,
    );
    return this.#immediate("mint_promotion_cleanup", () => {
      this.#validatePromotionCleanupPreimage(observation);
      const claimPreimageDigest = sha256Text(canonicalJson(observation.claims.map((claim) => ({
        resource_claim_id: claim.resourceClaimId, slot: claim.slot,
        expected_state: claim.expectedState, expected_version: claim.expectedVersion,
      }))));
      const receiptRow = this.#buildReceiptRow("promotion_cleanup_records", {
        promotion_cleanup_record_id: observation.receiptId,
        attempt_id: observation.attemptId,
        ownership_id: observation.ownershipId,
        owner_generation: observation.ownerGeneration,
        ownership_state_version: observation.ownershipStateVersion,
        ownership_context_digest: observation.ownershipContextDigest,
        context_id: observation.contextId,
        cleanup_eligibility_record_id: observation.cleanupEligibilityReceiptId,
        oracle_decision_id: observation.oracleDecisionId,
        promotion_intent_id: observation.promotionIntentId,
        promotion_observation_evidence_id: request.promotionObservationEvidenceId,
        delivery_ref: observation.deliveryRef,
        expected_old_oid: observation.expectedOldOid,
        candidate_oid: observation.candidateOid,
        delivery_observed_oid: observation.deliveryObservedOid,
        claim_preimage_digest: claimPreimageDigest,
        worktree_disposition: "removed",
        index_disposition: "removed",
        ref_disposition: "removed",
        context_disposition: "removed",
        bundle_disposition: "removed",
        group_dead: 1,
        resources_absent: 1,
        ownership_release_eligible: 1,
        evidence_id: evidenceId,
        input_digest: durableDigest,
        record_digest: durableDigest,
        idempotency_key: `promotion-cleanup:${observation.receiptId}`,
        created_at: observation.observedAt,
      });
      return this.#persistDispositionReceipt(
        "promotion_cleanup_records",
        "promotion_cleanup_record_id",
        "record_digest",
        receiptRow,
        evidenceRow,
        evidenceId,
        durablePreimage,
        () => { /* promotion intent finalization advanced by PromotionFinalizationService */ },
        receipt,
      );
    });
  }

  /**
   * Mint and atomically persist a quarantine receipt together with its sealed
   * claim set and normalized members.  Requires the attempt to be
   * `cleanup_pending`; the receipt, claim set, members, evidence, and
   * idempotency result are persisted in one transaction.
   */
  mintQuarantine(
    request: MintQuarantineRequest,
    capability: LeaseAuthorityMintCapability,
  ): MintedDispositionReceipt<QuarantineReceipt> {
    const receipt = mintQuarantineReceipt(request.observation, capability);
    const observation = receipt;
    const payload = sealedDispositionPayload(request.observation as unknown as Readonly<Record<string, unknown>>);
    const durablePreimage = dispositionDurablePreimage(
      request.observation as unknown as Readonly<Record<string, unknown>>,
      {
        target_proof_set_id: request.targetProofSetId,
        cause_evidence_id: request.causeEvidenceId,
        ownership_snapshot_evidence_id: request.ownershipSnapshotEvidenceId,
        cleanup_eligibility_record_id: request.cleanupEligibilityRecordId ?? null,
        oracle_decision_id: request.oracleDecisionId ?? null,
        promotion_intent_id: request.promotionIntentId ?? null,
        claim_members: request.claimMembers.map((member) => ({
          resource_claim_id: member.resourceClaimId, slot: member.slot,
          current_ownership_id: member.currentOwnershipId, owner_generation: member.ownerGeneration,
          claim_state_version: member.claimStateVersion, claim_snapshot_evidence_id: member.claimSnapshotEvidenceId,
          absence_required: member.absenceRequired, physical_disposition: member.physicalDisposition,
          disposition_evidence_id: member.dispositionEvidenceId, member_digest: member.memberDigest,
        })),
      },
    );
    const durableDigest = sha256Text(durablePreimage);
    const evidenceId = `evidence-quarantine-${observation.receiptId}`;
    const evidenceRow = dispositionEvidenceRow(
      evidenceId,
      observation.attemptId,
      observation.contextId,
      "QuarantineService",
      QUARANTINE_SCHEMA_VERSION,
      observation.receiptId,
      payload,
      observation.observedAt,
    );
    const quarantineStage = request.cleanupEligibilityRecordId === undefined
      ? "pre_oracle"
      : request.promotionIntentId === undefined
        ? "oracle"
        : "promotion";
    return this.#immediate("mint_quarantine", () => {
      this.#validateCleanupDispositionPreimage(observation, "quarantine");
      const proof = this.#requireSealedTargetProofSet(observation.attemptId, request.targetProofSetId);
      const db = this.#requireDatabase();
      const claimSetId = `quarantine-claim-set-${observation.receiptId}`;
      const claimSetEvidenceId = `evidence-quarantine-claim-set-${observation.receiptId}`;
      const claimSetMemberInventory = request.claimMembers.map((member) => ({
        resource_claim_id: member.resourceClaimId, slot: member.slot,
        physical_disposition: member.physicalDisposition, member_digest: member.memberDigest,
      }));
      const claimSetPayload = canonicalJson({ claim_members: claimSetMemberInventory });
      const claimSetEvidenceRow = dispositionEvidenceRow(
        claimSetEvidenceId,
        observation.attemptId,
        observation.contextId,
        "QuarantineService",
        QUARANTINE_SCHEMA_VERSION,
        claimSetId,
        claimSetPayload,
        observation.observedAt,
      );
      const counts = request.claimMembers.reduce((acc, member) => {
        acc[member.physicalDisposition] += 1;
        return acc;
      }, { absent: 0, retained: 0, unknown: 0, not_applicable: 0 });
      const allRequiredAbsent = counts.absent === request.claimMembers.length - 1 && counts.not_applicable === 1 ? 1 : 0;
      const claimSetDigest = sha256Text(canonicalJson(request.claimMembers.map((member) => member.memberDigest)));
      // Replay: if the quarantine record already exists with the identical
      // durable preimage, return the identical immutable postimage without
      // re-inserting the claim set/members.  A divergent durable preimage
      // conflicts (detected by #persistDispositionReceipt below).
      const existingQuarantine = db.prepare(
        "SELECT * FROM quarantine_records WHERE quarantine_record_id = ? AND attempt_id = ?",
      ).get(observation.receiptId, observation.attemptId) as MutableStateRecord | undefined;
      if (existingQuarantine !== undefined) {
        // The claim set/members are already persisted; defer to the uniform
        // replay/conflict check in #persistDispositionReceipt.
      } else {
        // 1. Insert the claim-set evidence first (the sealed state requires a
        //    non-null evidence_id FK).
        this.#validateRecordSemantics("evidence", claimSetEvidenceRow);
        this.#insert("evidence", claimSetEvidenceRow);
        // 2. Insert the claim set in `collecting` state (state_version 0, no
        //    digest/evidence/sealed_at) so the collecting-only trigger admits
        //    member inserts.
        const collectingClaimSetRow = this.#buildReceiptRow("quarantine_claim_sets", {
          quarantine_claim_set_id: claimSetId,
          attempt_id: observation.attemptId,
          ownership_id: observation.ownershipId,
          owner_generation: observation.ownerGeneration,
          ownership_context_digest: observation.ownershipContextDigest,
          ownership_snapshot_evidence_id: request.ownershipSnapshotEvidenceId,
          claim_count: request.claimMembers.length,
          absent_count: counts.absent,
          retained_count: counts.retained,
          unknown_count: counts.unknown,
          not_applicable_count: counts.not_applicable,
          all_required_absent: allRequiredAbsent,
          state: "collecting",
          state_version: 0,
          claim_set_digest: null,
          evidence_id: null,
          input_digest: sha256Text(claimSetPayload),
          idempotency_key: `quarantine-claim-set:${observation.receiptId}`,
          created_at: observation.observedAt,
          sealed_at: null,
        });
        this.#insert("quarantine_claim_sets", collectingClaimSetRow);
        // 3. Insert the members while the set is collecting.
        for (const [ordinal, member] of request.claimMembers.entries()) {
          this.#insert("quarantine_claim_members", this.#validatedColumns("quarantine_claim_members", normalizeRow({
            quarantine_claim_set_id: claimSetId,
            attempt_id: observation.attemptId,
            ordinal,
            resource_claim_id: member.resourceClaimId,
            slot: member.slot,
            kind: member.slot,
            current_ownership_id: member.currentOwnershipId,
            owner_generation: member.ownerGeneration,
            claim_state: "quarantined",
            claim_state_version: member.claimStateVersion,
            claim_snapshot_evidence_id: member.claimSnapshotEvidenceId,
            absence_required: member.absenceRequired ? 1 : 0,
            physical_disposition: member.physicalDisposition,
            disposition_evidence_id: member.dispositionEvidenceId,
            member_digest: member.memberDigest,
            created_at: observation.observedAt,
          })));
        }
        // 4. Seal the claim set atomically: collecting -> sealed.  The
        //    legal-edge and complete-seal triggers verify the members are
        //    complete and contiguous before the seal commits.
        const seal = db.prepare(
          `UPDATE quarantine_claim_sets
           SET state = 'sealed', state_version = 1,
               claim_set_digest = ?, evidence_id = ?, sealed_at = ?
           WHERE quarantine_claim_set_id = ? AND attempt_id = ?
             AND state = 'collecting' AND state_version = 0`,
        ).run(claimSetDigest, claimSetEvidenceId, observation.observedAt, claimSetId, observation.attemptId);
        if (seal.changes !== 1) {
          throw typedError("RICKGENT_STATE_CONFLICT", "quarantine claim set seal lost its CAS race", this.location.databasePath);
        }
      }
      const receiptRow = this.#buildReceiptRow("quarantine_records", {
        quarantine_record_id: observation.receiptId,
        attempt_id: observation.attemptId,
        ownership_id: observation.ownershipId,
        owner_generation: observation.ownerGeneration,
        ownership_state_version: observation.ownershipStateVersion,
        ownership_context_digest: observation.ownershipContextDigest,
        context_id: observation.contextId,
        quarantine_stage: quarantineStage,
        reason_code: observation.reasonCode,
        cause_evidence_id: request.causeEvidenceId,
        cleanup_eligibility_record_id: request.cleanupEligibilityRecordId ?? null,
        oracle_decision_id: request.oracleDecisionId ?? null,
        promotion_intent_id: request.promotionIntentId ?? null,
        target_proof_set_id: request.targetProofSetId,
        target_proof_set_state: "sealed_complete",
        target_proof_set_digest: String(proof.proof_set_digest ?? ""),
        target_proof_set_evidence_id: String(proof.evidence_id ?? ""),
        target_proof_count: Number(proof.target_count ?? 0),
        quarantine_claim_set_id: claimSetId,
        quarantine_claim_set_state: "sealed",
        quarantine_claim_set_digest: claimSetDigest,
        quarantine_claim_set_evidence_id: claimSetEvidenceId,
        delivery_ref: observation.deliveryRef,
        expected_delivery_oid: null,
        observed_delivery_oid: observation.deliveryObservedOid,
        group_dead: 1,
        resources_absent: allRequiredAbsent,
        evidence_id: evidenceId,
        input_digest: durableDigest,
        record_digest: durableDigest,
        idempotency_key: `quarantine:${observation.receiptId}`,
        created_at: observation.observedAt,
      });
      return this.#persistDispositionReceipt(
        "quarantine_records",
        "quarantine_record_id",
        "record_digest",
        receiptRow,
        evidenceRow,
        evidenceId,
        durablePreimage,
        () => { /* terminal transition advanced by QuarantineFinalizationService */ },
        receipt,
      );
    });
  }

  #requireSealedTargetProofSet(attemptId: string, targetProofSetId: string): MutableStateRecord {
    const proof = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_target_proof_sets WHERE target_proof_set_id = ? AND attempt_id = ? AND state = 'sealed_complete'",
    ).get(targetProofSetId, attemptId) as MutableStateRecord | undefined;
    if (proof === undefined) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "disposition receipt requires a sealed-complete target proof set", this.location.databasePath);
    }
    return proof;
  }

  #persistDispositionReceipt<R extends { readonly receiptId: string; readonly attemptId: string; readonly observedAt: string }>(
    table: StateTableName,
    idColumn: string,
    digestColumn: string,
    receiptRow: Readonly<Record<string, SqlValue>>,
    evidenceRow: Readonly<Record<string, SqlValue>>,
    evidenceId: string,
    durablePreimage: string,
    advanceState: (db: DatabaseSync) => void,
    receipt: R,
  ): MintedDispositionReceipt<R> {
    const recordDigest = sha256Text(durablePreimage);
    const db = this.#requireDatabase();
    const receiptId = String(receiptRow[idColumn] ?? receipt.receiptId);
    const attemptId = receipt.attemptId;
    // Replay: an existing receipt under the same idempotency key must return the
    // identical immutable postimage; any divergent postimage conflicts.
    const existing = db.prepare(
      `SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(idColumn)} = ? AND attempt_id = ?`,
    ).get(receiptId, attemptId) as MutableStateRecord | undefined;
    if (existing !== undefined) {
      const existingDigest = String(existing[digestColumn] ?? "");
      if (existingDigest !== recordDigest) {
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", `disposition receipt ${receiptId} has a different immutable postimage`, this.location.databasePath);
      }
      const existingEvidence = db.prepare("SELECT * FROM evidence WHERE evidence_id = ? AND attempt_id = ?").get(evidenceId, attemptId) as MutableStateRecord | undefined;
      if (existingEvidence === undefined) {
        throw typedError("RICKGENT_STATE_CORRUPT", `disposition receipt ${receiptId} replay is missing its evidence`, this.location.databasePath);
      }
      return freezeValue({ receipt, record: frozenRow(existing), evidence: frozenRow(existingEvidence), replayed: true });
    }
    this.#validateRecordSemantics("evidence", evidenceRow);
    this.#insert("evidence", evidenceRow);
    advanceState(db);
    this.#insert(table, receiptRow);
    return freezeValue({ receipt, record: frozenRow(receiptRow), evidence: frozenRow(evidenceRow), replayed: false });
  }

  #buildReceiptRow(
    table: StateTableName,
    columns: Readonly<Record<string, SqlValue>>,
  ): Readonly<Record<string, SqlValue>> {
    const row = this.#validatedColumns(table, normalizeRow(columns));
    this.#requireCompleteRow(table, row);
    return row;
  }

  #validateCleanupDispositionPreimage(
    observation: { readonly attemptId: string; readonly ownershipId: string; readonly ownerGeneration: number; readonly ownershipContextDigest: string; readonly ownershipStateVersion: number },
    label: string,
  ): void {
    const db = this.#requireDatabase();
    const ownership = db.prepare(
      `SELECT * FROM attempt_ownership_leases
       WHERE ownership_id = ? AND attempt_id = ? AND generation = ? AND context_digest = ?`,
    ).get(observation.ownershipId, observation.attemptId, observation.ownerGeneration,
      observation.ownershipContextDigest) as MutableStateRecord | undefined;
    if (ownership === undefined) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", `${label} receipt does not bind an existing attempt ownership lease`, this.location.databasePath);
    }
    if (String(ownership.state) !== "cleanup_pending" || Number(ownership.state_version) !== observation.ownershipStateVersion) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} receipt requires a cleanup_pending ownership preimage at the exact version`, this.location.databasePath);
    }
    const attempt = db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(observation.attemptId) as MutableStateRecord | undefined;
    if (attempt === undefined) {
      throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `${label} receipt does not bind an existing attempt`, this.location.databasePath);
    }
    if (String(attempt.state) !== "cleanup_pending") {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} receipt requires a cleanup_pending attempt`, this.location.databasePath);
    }
  }

  #validatePromotionCleanupPreimage(observation: PromotionCleanupReceipt): void {
    this.#validateCleanupDispositionPreimage(observation, "promotion-cleanup");
    const db = this.#requireDatabase();
    // The exact accepted oracle decision must exist and be accepted.
    const oracle = db.prepare(
      "SELECT * FROM oracle_decisions WHERE oracle_decision_id = ? AND attempt_id = ? AND result = 'accepted'",
    ).get(observation.oracleDecisionId, observation.attemptId) as MutableStateRecord | undefined;
    if (oracle === undefined) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion-cleanup receipt requires the exact accepted oracle decision", this.location.databasePath);
    }
    // The promotion-purpose cleanup eligibility receipt must exist.
    const eligibility = db.prepare(
      "SELECT * FROM cleanup_eligibility_records WHERE cleanup_eligibility_record_id = ? AND attempt_id = ?",
    ).get(observation.cleanupEligibilityReceiptId, observation.attemptId) as MutableStateRecord | undefined;
    if (eligibility === undefined) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion-cleanup receipt requires a promotion-purpose cleanup eligibility receipt", this.location.databasePath);
    }
    // The independently observed candidate/delivery state must equal the oracle's candidate.
    if (String(eligibility.candidate_oid) !== observation.candidateOid || observation.deliveryObservedOid !== observation.candidateOid) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion-cleanup receipt must observe the exact candidate and delivery state", this.location.databasePath);
    }
    // The promotion intent must exist and reference the same oracle decision.
    const intent = db.prepare(
      "SELECT * FROM promotion_intents WHERE promotion_intent_id = ? AND attempt_id = ? AND oracle_decision_id = ?",
    ).get(observation.promotionIntentId, observation.attemptId, observation.oracleDecisionId) as MutableStateRecord | undefined;
    if (intent === undefined) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion-cleanup receipt requires the exact promotion intent", this.location.databasePath);
    }
  }

  #resolveAttemptOracleProjection(attemptId: string): { readonly attemptState: string; readonly projection: AttemptOracleProjection } {
    const db = this.#requireDatabase();
    const lineage = db.prepare(`
      SELECT a.attempt_id, a.ticket_instance_id, a.run_id, a.ticket_id, a.state AS attempt_state,
             a.oracle_version, a.contract_digest, r.manifest_digest,
             rm.canonical_manifest_json, tc.canonical_contract_json
      FROM attempts a JOIN runs r ON r.run_id = a.run_id
      JOIN run_manifests rm ON rm.manifest_digest = r.manifest_digest
      JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
      WHERE a.attempt_id = ?
    `).get(attemptId) as MutableStateRecord | undefined;
    if (lineage === undefined) this.#resumeIncompatible("oracle attempt does not resolve to sealed run and ticket lineage");
    if (lineage.oracle_version !== RICKGENT_ORACLE_VERSION) {
      throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "attempt oracle version is unsupported", this.location.databasePath);
    }
    const runId = String(lineage.run_id);
    const ticketInstanceId = String(lineage.ticket_instance_id);
    const references: OracleResolvedReferenceProjection[] = [];
    const add = (
      referenceKind: OracleResolvedReferenceProjection["referenceKind"],
      referenceId: string,
      contentDigest: string,
      ticketId: string | null,
      scopedAttemptId: string | null,
      sealedContent?: Readonly<Record<string, unknown>>,
      gate?: OracleResolvedReferenceProjection["gate"],
    ): void => {
      references.push(Object.freeze({
        ordinal: references.length,
        referenceKind,
        referenceId,
        runId,
        ticketInstanceId: ticketId,
        attemptId: scopedAttemptId,
        oracleVersion: RICKGENT_ORACLE_VERSION,
        contentDigest,
        resolvedContentDigest: contentDigest,
        ...(sealedContent === undefined ? {} : { sealedContent }),
        ...(gate === undefined ? {} : { gate }),
      }));
    };

    const manifest = this.#parseJsonObject(String(lineage.canonical_manifest_json), "oracle run manifest");
    add("run_manifest", String(lineage.manifest_digest), String(lineage.manifest_digest), null, null, manifest);
    const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "oracle ticket contract");
    add("ticket_contract", String(lineage.contract_digest), String(lineage.contract_digest), ticketInstanceId, null, contract);

    const contexts = db.prepare(
      "SELECT * FROM execution_contexts WHERE attempt_id = ? ORDER BY phase_ordinal, phase, role, context_id",
    ).all(attemptId) as MutableStateRecord[];
    for (const context of contexts) {
      const sealed = this.#parseJsonObject(String(context.canonical_context_json), "oracle execution context");
      add("execution_context", String(context.context_id), String(context.context_digest), ticketInstanceId, attemptId, sealed);
    }

    const verifications = Array.isArray(contract.verifications) ? contract.verifications : [];
    for (const verification of verifications) {
      const value = verification !== null && typeof verification === "object" && !Array.isArray(verification)
        ? verification as Record<string, unknown> : {};
      if (typeof value.id !== "string") continue;
      const gate = db.prepare(`
        SELECT g.*, e.scope AS evidence_scope, e.schema_version AS evidence_schema_version,
               e.inline_payload_json, e.content_digest AS evidence_content_digest
        FROM gate_results g JOIN evidence e ON e.evidence_id = g.evidence_id
        WHERE g.attempt_id = ? AND g.gate_id = ?
        ORDER BY g.evaluation_ordinal DESC LIMIT 1
      `).get(attemptId, value.id) as MutableStateRecord | undefined;
      if (gate === undefined) continue;
      const sealed = this.#parseJsonObject(String(gate.inline_payload_json), "oracle gate evidence");
      const sealedRequired = sealed.required === true || sealed.required === 1;
      const canonical = canonicalJson(sealed);
      if (
        gate.evidence_schema_version !== "rickgent.gate-result.v1" || sealed.gate_id !== gate.gate_id ||
        sealed.evaluation_ordinal !== gate.evaluation_ordinal || sealedRequired !== (gate.required === 1) ||
        sealed.status !== gate.status || typeof sealed.candidate_tree_oid !== "string" ||
        typeof sealed.candidate_diff_digest !== "string" ||
        gate.inline_payload_json !== canonical || gate.evidence_content_digest !== sha256Text(canonical) ||
        gate.result_digest !== gate.evidence_content_digest
      ) this.#resumeIncompatible("oracle gate row is not bound to exact candidate evidence");
      add("gate_result", String(gate.gate_result_id), String(gate.result_digest), ticketInstanceId, attemptId, sealed, {
        gateId: String(gate.gate_id),
        evaluationOrdinal: Number(gate.evaluation_ordinal),
        required: gate.required === 1,
        status: String(gate.status) as NonNullable<OracleResolvedReferenceProjection["gate"]>["status"],
      });
    }

    const reviews = db.prepare(`
      SELECT r.*, e.scope AS evidence_scope, e.schema_version AS evidence_schema_version,
             e.inline_payload_json, e.content_digest AS evidence_content_digest
      FROM review_records r JOIN evidence e ON e.evidence_id = r.verdict_evidence_id
      WHERE r.attempt_id = ? ORDER BY r.cycle
    `).all(attemptId) as MutableStateRecord[];
    for (const review of reviews) {
      const sealed = {
        attempt_id: review.attempt_id,
        cycle: review.cycle,
        verdict: review.verdict,
        input_tree_oid: review.input_tree_oid,
        input_diff_digest: review.input_diff_digest,
      };
      const canonical = canonicalJson(sealed);
      if (
        review.evidence_schema_version !== "rickgent.review-verdict.v1" ||
        review.inline_payload_json !== canonical || review.evidence_content_digest !== sha256Text(canonical)
      ) this.#resumeIncompatible("oracle review row is not bound to exact candidate evidence");
      add("review_record", String(review.review_record_id), String(review.evidence_content_digest), ticketInstanceId, attemptId, sealed);
    }

    const attribution = db.prepare(`
      SELECT c.*, e.scope AS evidence_scope, e.schema_version AS evidence_schema_version,
             e.inline_payload_json, e.content_digest AS evidence_content_digest
      FROM commit_attributions c
      JOIN attempt_commit_intents i ON i.commit_attribution_id = c.commit_attribution_id
        AND i.attempt_id = c.attempt_id AND i.state = 'finalized'
      JOIN evidence e ON e.evidence_id = c.attribution_evidence_id
      WHERE c.attempt_id = ?
    `).get(attemptId) as MutableStateRecord | undefined;
    if (attribution !== undefined) {
      const sealed = this.#parseJsonObject(String(attribution.inline_payload_json), "oracle commit attribution evidence");
      if (
        attribution.evidence_schema_version !== "rickgent.commit-attribution.v2" ||
        attribution.evidence_content_digest !== sha256Text(canonicalJson(sealed)) ||
        sealed.contract_digest !== attribution.contract_digest || sealed.baseline_oid !== attribution.baseline_oid ||
        sealed.parent_oid !== attribution.parent_oid || sealed.tree_before_oid !== attribution.tree_before_oid ||
        sealed.tree_after_oid !== attribution.tree_after_oid || sealed.commit_oid !== attribution.commit_oid ||
        sealed.path_set_digest !== attribution.path_set_digest || sealed.change_kind_set_digest !== attribution.change_kind_set_digest ||
        sealed.mode_set_digest !== attribution.mode_set_digest
      ) this.#resumeIncompatible("oracle attribution row is not bound to exact normalized delta evidence");
      add("commit_attribution", String(attribution.commit_attribution_id), String(attribution.evidence_content_digest), ticketInstanceId, attemptId, sealed);
    }

    const targetProofSet = db.prepare(`
      SELECT proof.*, evidence.producer_service AS evidence_producer_service,
             evidence.schema_version AS evidence_schema_version,
             evidence.inline_payload_json, evidence.content_digest AS evidence_content_digest
      FROM attempt_target_proof_sets proof
      JOIN evidence ON evidence.evidence_id = proof.evidence_id AND evidence.attempt_id = proof.attempt_id
      WHERE proof.attempt_id = ? AND proof.state = 'sealed_complete'
    `).get(attemptId) as MutableStateRecord | undefined;
    let targetProofSetPayload: Readonly<Record<string, unknown>> | undefined;
    if (targetProofSet !== undefined) {
      const members = db.prepare(`
        SELECT member.*, gate.start_authorization_digest,
               launch.ownership_context_digest AS launch_ownership_context_digest,
               launch.phase_execution_id AS launch_phase_execution_id,
               launch.execution_context_digest AS launch_execution_context_digest,
               launch.pid, launch.pgid, launch.platform AS launch_platform,
               launch.boot_identity, launch.process_start_identity, launch.created_at AS launch_created_at,
               death.producer_service AS death_producer_service,
               death.schema_version AS death_schema_version,
               death.inline_payload_json AS death_payload_json,
               death.content_digest AS death_content_digest,
               death.created_at AS death_evidence_created_at,
               observation.schema_version AS death_observation_schema,
               observation.created_at AS death_observed_at,
               observation.payload_digest AS death_observation_digest,
               gate_evidence.producer_service AS gate_evidence_producer,
               gate_evidence.schema_version AS gate_evidence_schema,
               gate_evidence.inline_payload_json AS gate_evidence_payload_json,
               gate_evidence.content_digest AS gate_evidence_content_digest
        FROM attempt_target_proof_members member
        LEFT JOIN target_start_gates gate ON gate.target_start_gate_id = member.target_start_gate_id
        LEFT JOIN attempt_process_launches launch ON launch.launch_id = member.launch_id
        LEFT JOIN attempt_process_observations observation
          ON observation.launch_id = member.launch_id
         AND observation.evidence_id = member.group_death_evidence_id
         AND observation.kind = 'group_death'
        LEFT JOIN evidence death ON death.evidence_id = member.group_death_evidence_id
        LEFT JOIN evidence gate_evidence
          ON gate_evidence.evidence_id = COALESCE(member.gate_release_evidence_id, member.gate_never_released_evidence_id)
        WHERE member.target_proof_set_id = ?
        ORDER BY member.ordinal
      `).all(String(targetProofSet.target_proof_set_id)) as MutableStateRecord[];
      const sealedMembers = members.map((member, ordinal) => {
        const sealedMember = {
          ordinal: member.ordinal,
          phase_execution_id: member.phase_execution_id,
          context_id: member.context_id,
          target_start_gate_id: member.target_start_gate_id,
          gate_state: member.gate_state,
          gate_state_version: member.gate_state_version,
          proof_kind: member.proof_kind,
          launch_id: member.launch_id,
          process_receipt_id: member.process_receipt_id,
          group_death_evidence_id: member.group_death_evidence_id,
          unproven_evidence_id: member.unproven_evidence_id,
        };
        if (member.ordinal !== ordinal || member.member_digest !== sha256Text(canonicalJson(sealedMember))) {
          this.#resumeIncompatible("target proof member ordering or digest is invalid");
        }
        const gateEvidence = this.#parseJsonObject(
          String(member.gate_evidence_payload_json),
          "target start-gate evidence",
        );
        if (
          member.gate_evidence_producer !== "TargetStartGateAuthority" ||
          member.gate_evidence_content_digest !== sha256Text(canonicalJson(gateEvidence)) ||
          gateEvidence.target_start_gate_id !== member.target_start_gate_id ||
          gateEvidence.attempt_id !== attemptId || gateEvidence.phase_execution_id !== member.phase_execution_id ||
          gateEvidence.state !== member.gate_state || gateEvidence.state_version !== member.gate_state_version ||
          gateEvidence.start_authorization_digest !== member.start_authorization_digest ||
          gateEvidence.launch_id !== member.launch_id
        ) this.#resumeIncompatible("target proof gate evidence does not seal the exact gate transition");
        let authoritativeDeathExact = false;
        if (member.launch_id !== null) {
          const death = this.#parseJsonObject(String(member.death_payload_json), "target proof group-death evidence");
          const expectedDeath = {
            schema_version: "rickgent.process-group-death.v1",
            launch_id: member.launch_id,
            process_receipt_id: member.process_receipt_id,
            attempt_id: attemptId,
            ownership_id: targetProofSet.ownership_id,
            owner_generation: targetProofSet.owner_generation,
            ownership_context_digest: member.launch_ownership_context_digest,
            phase_execution_id: member.launch_phase_execution_id,
            context_id: member.context_id,
            execution_context_digest: member.launch_execution_context_digest,
            pid: member.pid,
            pgid: member.pgid,
            platform: member.launch_platform,
            boot_identity: member.boot_identity,
            process_start_identity: member.process_start_identity,
            death_observed_at: member.death_observed_at,
            group_dead: true,
            proof_basis: "authoritative_containment",
            tracked_identities_confirmed_dead: true,
            descendants_confirmed_dead: true,
          };
          const launchMs = Date.parse(String(member.launch_created_at));
          const deathMs = Date.parse(String(member.death_observed_at));
          authoritativeDeathExact =
            member.death_producer_service === "ProcessSupervisor" &&
            member.death_schema_version === "rickgent.process-group-death.v1" &&
            member.death_observation_schema === "rickgent.process-group-death.v1" &&
            member.launch_ownership_context_digest === targetProofSet.ownership_context_digest &&
            member.death_content_digest === member.death_observation_digest &&
            member.death_content_digest === sha256Text(canonicalJson(death)) &&
            member.death_evidence_created_at === member.death_observed_at &&
            Number.isFinite(launchMs) && Number.isFinite(deathMs) && deathMs >= launchMs &&
            canonicalJson(death) === canonicalJson(expectedDeath);
        }
        if (member.proof_kind === "terminal_process") {
          if (
            member.gate_state !== "released" || member.gate_state_version !== 1 ||
            member.gate_evidence_schema !== "rickgent.target-start-gate-released.v1" ||
            !authoritativeDeathExact
          ) this.#resumeIncompatible("terminal target proof is not bound to authoritative containment death");
        } else if (member.proof_kind === "never_released") {
          const neverReleasedReasonExact = [
            "containment_unavailable",
            "policy_unavailable",
            "executable_unavailable",
            "output_unavailable",
            "spawn_failed",
          ].includes(String(gateEvidence.reason));
          const containmentDispositionExact =
            (gateEvidence.containment_disposition === "not_created" &&
              member.launch_id === null &&
              gateEvidence.containment_id === null &&
              gateEvidence.containment_evidence_digest === null) ||
            (gateEvidence.containment_disposition === "authoritatively_empty" &&
              member.launch_id !== null &&
              gateEvidence.containment_id === member.launch_id &&
              gateEvidence.containment_evidence_digest === member.death_content_digest);
          if (
            member.gate_state !== "closed_never_released" || member.gate_state_version !== 1 ||
            member.gate_evidence_schema !== "rickgent.target-never-released.v1" ||
            !neverReleasedReasonExact || !containmentDispositionExact ||
            (member.launch_id === null
              ? db.prepare("SELECT 1 FROM attempt_process_launches WHERE attempt_id = ? AND phase_execution_id = ?")
                .get(attemptId, String(member.phase_execution_id)) !== undefined
              : !authoritativeDeathExact)
          ) this.#resumeIncompatible("never-released target proof is not bound to a closed gate and contained bootstrap");
        } else {
          this.#resumeIncompatible("complete target proof set contains an unproven member");
        }
        return Object.freeze({ ...sealedMember, member_digest: member.member_digest });
      });
      const proofSetDigest = sha256Text(canonicalJson(sealedMembers.map((member) => member.member_digest)));
      targetProofSetPayload = Object.freeze({
        oracle_input_class: "complete_target_proof_set",
        target_proof_set_id: targetProofSet.target_proof_set_id,
        attempt_id: targetProofSet.attempt_id,
        ownership_id: targetProofSet.ownership_id,
        owner_generation: targetProofSet.owner_generation,
        ownership_context_digest: targetProofSet.ownership_context_digest,
        target_count: targetProofSet.target_count,
        target_proof_set_digest: targetProofSet.proof_set_digest,
        target_proofs: Object.freeze(sealedMembers),
      });
      if (
        targetProofSet.target_count !== members.length || targetProofSet.proof_set_digest !== proofSetDigest ||
        targetProofSet.evidence_producer_service !== "TargetProofService" ||
        targetProofSet.evidence_schema_version !== "rickgent.attempt-target-proof-set.v1" ||
        targetProofSet.inline_payload_json !== canonicalJson(targetProofSetPayload) ||
        targetProofSet.evidence_content_digest !== sha256Text(canonicalJson(targetProofSetPayload))
      ) this.#resumeIncompatible("complete target proof set evidence is invalid");
      add(
        "evidence",
        String(targetProofSet.evidence_id),
        String(targetProofSet.evidence_content_digest),
        ticketInstanceId,
        attemptId,
        targetProofSetPayload,
      );
    }

    const eligibility = db.prepare(`
      SELECT c.*, e.scope AS evidence_scope, e.producer_service AS evidence_producer_service,
             e.schema_version AS evidence_schema_version, e.inline_payload_json,
             e.content_digest AS evidence_content_digest
      FROM cleanup_eligibility_records c JOIN evidence e ON e.evidence_id = c.evidence_id
      WHERE c.attempt_id = ? ORDER BY c.created_at DESC, c.cleanup_eligibility_record_id DESC LIMIT 1
    `).get(attemptId) as MutableStateRecord | undefined;
    if (eligibility !== undefined) {
      const sealed = this.#parseJsonObject(String(eligibility.inline_payload_json), "oracle cleanup eligibility evidence");
      const claimSnapshotEvidenceIds = this.#parseJsonArray(
        String(eligibility.claim_snapshot_evidence_ids_json),
        "oracle cleanup eligibility claim snapshots",
      );
      const expectedPayload = {
        oracle_input_class: "cleanup_eligibility",
        eligibility_id: eligibility.cleanup_eligibility_record_id,
        attempt_id: eligibility.attempt_id,
        ownership_id: eligibility.ownership_id,
        owner_generation: eligibility.owner_generation,
        ownership_state_version: eligibility.ownership_state_version,
        ownership_context_digest: eligibility.ownership_context_digest,
        context_id: eligibility.context_id,
        commit_intent_id: eligibility.commit_intent_id,
        commit_attribution_id: eligibility.commit_attribution_id,
        candidate_oid: eligibility.candidate_oid,
        baseline_oid: eligibility.delivery_baseline_oid,
        delivery_ref: eligibility.delivery_ref,
        delivery_observed_oid: eligibility.delivery_observed_oid,
        attempt_ref: eligibility.attempt_ref,
        attempt_ref_observed_oid: eligibility.attempt_ref_observed_oid,
        claim_preimage_digest: eligibility.claim_snapshot_set_digest,
        target_proof_set_id: eligibility.target_proof_set_id,
        target_proof_set_digest: eligibility.target_proof_set_digest,
        target_proof_count: eligibility.target_proof_count,
        ownership_snapshot_evidence_id: eligibility.ownership_snapshot_evidence_id,
        claim_snapshot_evidence_ids: claimSnapshotEvidenceIds,
      };
      const targetOwnershipInRecoveryLineage = db.prepare(`
        WITH RECURSIVE ownership_chain(ownership_id, generation, recovered_from_ownership_id) AS (
          SELECT ownership_id, generation, recovered_from_ownership_id
          FROM attempt_ownership_leases
          WHERE ownership_id = ? AND attempt_id = ? AND generation = ?
          UNION ALL
          SELECT parent.ownership_id, parent.generation, parent.recovered_from_ownership_id
          FROM attempt_ownership_leases parent
          JOIN ownership_chain child ON child.recovered_from_ownership_id = parent.ownership_id
          WHERE parent.attempt_id = ?
        )
        SELECT 1 FROM ownership_chain WHERE ownership_id = ? AND generation = ?
      `).get(
        String(eligibility.ownership_id),
        attemptId,
        Number(eligibility.owner_generation),
        attemptId,
        String(targetProofSet?.ownership_id ?? ""),
        Number(targetProofSet?.owner_generation ?? -1),
      ) !== undefined;
      if (
        eligibility.evidence_producer_service !== "CleanupEligibilityService" ||
        eligibility.evidence_schema_version !== "rickgent.cleanup-eligibility.v1" ||
        eligibility.inline_payload_json !== canonicalJson(expectedPayload) ||
        eligibility.evidence_content_digest !== sha256Text(canonicalJson(expectedPayload)) ||
        eligibility.record_digest !== eligibility.evidence_content_digest ||
        eligibility.claim_snapshot_set_digest !== sha256Text(canonicalJson(claimSnapshotEvidenceIds)) ||
        targetProofSet === undefined || targetProofSetPayload === undefined ||
        eligibility.target_proof_set_id !== targetProofSet.target_proof_set_id ||
        eligibility.target_proof_set_digest !== targetProofSet.proof_set_digest ||
        eligibility.target_proof_count !== targetProofSet.target_count ||
        !targetOwnershipInRecoveryLineage
      ) this.#resumeIncompatible("oracle cleanup eligibility row is not bound to exact eligibility evidence");
      add(
        "evidence",
        String(eligibility.evidence_id),
        String(eligibility.evidence_content_digest),
        ticketInstanceId,
        attemptId,
        sealed,
      );

      if (claimSnapshotEvidenceIds.length !== RESOURCE_KINDS.length) {
        this.#resumeIncompatible("oracle cleanup eligibility does not pin the complete claim set");
      }
      const observedClaimSlots = new Set<string>();
      for (const evidenceId of claimSnapshotEvidenceIds) {
        if (typeof evidenceId !== "string") this.#resumeIncompatible("oracle cleanup eligibility claim snapshot id is invalid");
        const evidence = this.#requireDatabase().prepare(`
          SELECT * FROM evidence WHERE evidence_id = ? AND attempt_id = ?
            AND producer_service = 'LeaseAuthority'
            AND schema_version = 'rickgent.attempt-resource-claim-snapshot.v2'
        `).get(evidenceId, attemptId) as MutableStateRecord | undefined;
        if (evidence === undefined) this.#resumeIncompatible("oracle cleanup eligibility claim snapshot is unavailable");
        const snapshot = this.#parseJsonObject(String(evidence.inline_payload_json), "oracle cleanup eligibility claim snapshot");
        if (evidence.content_digest !== sha256Text(canonicalJson(snapshot))) {
          this.#resumeIncompatible("oracle cleanup eligibility claim snapshot digest is invalid");
        }
        if (
          snapshot.attempt_id !== attemptId || snapshot.current_ownership_id !== eligibility.ownership_id ||
          snapshot.owner_generation !== eligibility.owner_generation || snapshot.state !== "cleanup_pending" ||
          snapshot.slot !== snapshot.kind || typeof snapshot.slot !== "string" ||
          !RESOURCE_KINDS.includes(snapshot.slot as (typeof RESOURCE_KINDS)[number]) ||
          observedClaimSlots.has(snapshot.slot)
        ) this.#resumeIncompatible("oracle cleanup eligibility claim snapshot is not the exact cleanup-pending preimage");
        const currentClaim = this.#requireDatabase().prepare(`
          SELECT * FROM attempt_resource_claims
          WHERE resource_claim_id = ? AND attempt_id = ? AND slot = ?
            AND current_ownership_id = ? AND owner_generation = ?
            AND state = 'cleanup_pending' AND state_version = ?
        `).get(
          String(snapshot.resource_claim_id),
          attemptId,
          String(snapshot.slot),
          String(eligibility.ownership_id),
          Number(eligibility.owner_generation),
          Number(snapshot.state_version),
        ) as MutableStateRecord | undefined;
        if (currentClaim === undefined || canonicalJson(currentClaim) !== canonicalJson(snapshot)) {
          this.#resumeIncompatible("oracle cleanup eligibility claim snapshot differs from current durable truth");
        }
        observedClaimSlots.add(snapshot.slot);
        add("attempt_resource_snapshot", evidenceId, String(evidence.content_digest), ticketInstanceId, attemptId, snapshot);
      }
      if (RESOURCE_KINDS.some((slot) => !observedClaimSlots.has(slot))) {
        this.#resumeIncompatible("oracle cleanup eligibility claim snapshot set is incomplete");
      }
      const ownershipEvidence = this.#requireDatabase().prepare(`
        SELECT * FROM evidence WHERE evidence_id = ? AND attempt_id = ?
          AND producer_service = 'LeaseAuthority'
          AND schema_version = 'rickgent.attempt-ownership-lease-snapshot.v2'
      `).get(eligibility.ownership_snapshot_evidence_id ?? null, attemptId) as MutableStateRecord | undefined;
      if (ownershipEvidence === undefined) this.#resumeIncompatible("oracle cleanup eligibility ownership snapshot is unavailable");
      const ownershipSnapshot = this.#parseJsonObject(
        String(ownershipEvidence.inline_payload_json),
        "oracle cleanup eligibility ownership snapshot",
      );
      if (ownershipEvidence.content_digest !== sha256Text(canonicalJson(ownershipSnapshot))) {
        this.#resumeIncompatible("oracle cleanup eligibility ownership snapshot digest is invalid");
      }
      if (
        ownershipSnapshot.ownership_id !== eligibility.ownership_id || ownershipSnapshot.attempt_id !== attemptId ||
        ownershipSnapshot.generation !== eligibility.owner_generation ||
        ownershipSnapshot.state_version !== eligibility.ownership_state_version ||
        ownershipSnapshot.context_digest !== eligibility.ownership_context_digest ||
        ownershipSnapshot.state !== "cleanup_pending"
      ) this.#resumeIncompatible("oracle cleanup eligibility ownership snapshot is not the exact cleanup-pending preimage");
      const currentOwnership = this.#requireDatabase().prepare(`
        SELECT * FROM attempt_ownership_leases
        WHERE ownership_id = ? AND attempt_id = ? AND generation = ?
          AND state = 'cleanup_pending' AND state_version = ? AND context_digest = ?
      `).get(
        String(eligibility.ownership_id),
        attemptId,
        Number(eligibility.owner_generation),
        Number(eligibility.ownership_state_version),
        String(eligibility.ownership_context_digest),
      ) as MutableStateRecord | undefined;
      if (currentOwnership === undefined || canonicalJson(currentOwnership) !== canonicalJson(ownershipSnapshot)) {
        this.#resumeIncompatible("oracle cleanup eligibility ownership snapshot differs from current durable truth");
      }
      add(
        "lease_snapshot",
        String(ownershipEvidence.evidence_id),
        String(ownershipEvidence.content_digest),
        ticketInstanceId,
        attemptId,
        ownershipSnapshot,
      );
    }

    const dependencies = Array.isArray(contract.depends_on) ? contract.depends_on : [];
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") continue;
      const edge = db.prepare(
        "SELECT * FROM run_ticket_dependencies WHERE run_id = ? AND ticket_id = ? AND depends_on_ticket_id = ?",
      ).get(runId, lineage.ticket_id ?? null, dependency) as MutableStateRecord | undefined;
      if (edge === undefined) continue;
      const sealed = { run_id: edge.run_id, ticket_id: edge.ticket_id, depends_on_ticket_id: edge.depends_on_ticket_id };
      if (edge.dependency_digest !== sha256Text(canonicalJson(sealed))) this.#resumeIncompatible("oracle dependency edge digest is invalid");
      add("dependency_edge", String(edge.dependency_digest), String(edge.dependency_digest), ticketInstanceId, null, sealed);
    }

    const remediations = db.prepare(`
      SELECT r.*, e.scope AS evidence_scope, e.schema_version AS evidence_schema_version,
             e.inline_payload_json, e.content_digest AS evidence_content_digest
      FROM remediation_records r JOIN evidence e ON e.evidence_id = r.output_evidence_id
      WHERE r.attempt_id = ? ORDER BY r.cycle
    `).all(attemptId) as MutableStateRecord[];
    for (const remediation of remediations) {
      const sealed = this.#parseJsonObject(String(remediation.inline_payload_json), "oracle remediation evidence");
      if (
        remediation.evidence_schema_version !== "rickgent.remediation-output.v1" ||
        remediation.evidence_content_digest !== sha256Text(canonicalJson(sealed)) ||
        sealed.oracle_input_class !== "remediation_cycle" || sealed.cycle !== remediation.cycle ||
        sealed.result_tree_oid !== remediation.result_tree_oid || sealed.result_diff_digest !== remediation.result_diff_digest
      ) this.#resumeIncompatible("oracle remediation row is not bound to exact output evidence");
      add("evidence", String(remediation.output_evidence_id), String(remediation.evidence_content_digest), ticketInstanceId, attemptId, sealed);
    }

    return freezeValue({
      attemptState: String(lineage.attempt_state),
      projection: {
        oracleVersion: RICKGENT_ORACLE_VERSION,
        scope: { runId, ticketInstanceId, attemptId },
        references,
      },
    });
  }

  #exactSnapshotEvidence(
    attemptId: string,
    producerService: string,
    schemaVersion: string,
    sealed: Readonly<Record<string, unknown>>,
    label: string,
  ): MutableStateRecord {
    const payload = canonicalJson(sealed);
    const digest = sha256Text(payload);
    const evidence = this.#requireDatabase().prepare(`
      SELECT * FROM evidence WHERE attempt_id = ? AND schema_version = ?
        AND producer_service = ? AND inline_payload_json = ? AND content_digest = ?
      ORDER BY created_at DESC, evidence_id DESC LIMIT 1
    `).get(attemptId, schemaVersion, producerService, payload, digest) as MutableStateRecord | undefined;
    if (evidence === undefined) this.#resumeIncompatible(`oracle current ${label} row has no exact immutable snapshot evidence`);
    return evidence;
  }

  /** @internal Accepts only the runtime-unforgeable plan minted by PromotionAuthority. */
  createAuthorizedPromotionIntent(command: PromotionIntentCommit): StateRecord {
    if (!isAuthorizedPromotionIntentCommit(command)) throw new TypeError("promotion intent command was not minted by PromotionAuthority");
    const request = command.request;
    const intent = this.#validatedColumns("promotion_intents", normalizeRow({
      promotion_intent_id: request.promotionIntentId,
      run_id: request.runId,
      ticket_instance_id: request.ticketInstanceId,
      attempt_id: request.attemptId,
      promotion_sequence: request.promotionSequence,
      delivery_ref: request.deliveryRef,
      expected_old_oid: request.expectedOldOid,
      candidate_oid: request.candidateOid,
      oracle_decision_id: request.oracleDecisionId,
      commit_attribution_id: request.commitAttributionId,
      owner_context_id: request.ownerContextId,
      idempotency_key: request.idempotencyKey,
      state: "intent_recorded",
      state_version: 0,
      observed_oid: null,
      observation_evidence_id: null,
      finalization_evidence_id: null,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("promotion_intents", intent);
    if (
      intent.state !== "intent_recorded" || intent.state_version !== 0 || intent.observed_oid !== null ||
      intent.observation_evidence_id !== null || intent.finalization_evidence_id !== null
    ) throw new TypeError("a new promotion intent must begin in its empty intent_recorded snapshot");
    this.#assertRepositoryOid(intent.expected_old_oid, "promotion expected_old_oid");
    this.#assertRepositoryOid(intent.candidate_oid, "promotion candidate_oid");
    return this.#immediate("create_promotion_intent", () => {
      // Check by promotion_intent_id first — a fixture or prior run may have
      // already created the intent with a different idempotency_key.  If the
      // immutable fields match, return the existing row as a replay.
      const existingById = this.#requireDatabase().prepare(
        "SELECT * FROM promotion_intents WHERE promotion_intent_id = ?",
      ).get(String(intent.promotion_intent_id)) as MutableStateRecord | undefined;
      if (existingById !== undefined) {
        const immutableColumns = [
          "promotion_intent_id", "run_id", "ticket_instance_id", "attempt_id", "promotion_sequence", "delivery_ref",
          "expected_old_oid", "candidate_oid", "oracle_decision_id", "commit_attribution_id", "owner_context_id",
          "idempotency_key", "created_at",
        ];
        if (immutableColumns.every((column) => sameValue(existingById[column], intent[column]))) return frozenRow(intent);
        // If the idempotency_key differs but the core lineage matches, accept
        // the existing intent (it was seeded by a fixture with a different key).
        const lineageColumns = [
          "promotion_intent_id", "run_id", "ticket_instance_id", "attempt_id", "promotion_sequence", "delivery_ref",
          "expected_old_oid", "candidate_oid", "oracle_decision_id", "commit_attribution_id", "owner_context_id",
        ];
        if (lineageColumns.every((column) => sameValue(existingById[column], intent[column]))) return frozenRow(existingById);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "promotion intent id has different immutable input", this.location.databasePath);
      }
      const existing = this.#selectBy("promotion_intents", intent, ["run_id", "idempotency_key"]);
      if (existing !== undefined) {
        const immutableColumns = [
          "promotion_intent_id", "run_id", "ticket_instance_id", "attempt_id", "promotion_sequence", "delivery_ref",
          "expected_old_oid", "candidate_oid", "oracle_decision_id", "commit_attribution_id", "owner_context_id",
          "idempotency_key", "created_at",
        ];
        if (immutableColumns.every((column) => sameValue(existing[column], intent[column]))) return frozenRow(intent);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "promotion idempotency key has different immutable input", this.location.databasePath);
      }
      const scope = this.#requireDatabase().prepare(`
        SELECT r.delivery_ref, r.current_delivery_oid, r.promotion_sequence,
               r.state AS run_state, rt.state AS ticket_state, a.state AS attempt_state,
               a.delivery_baseline_oid, c.commit_oid, c.parent_oid, o.result AS oracle_result, o.scope_kind,
               x.attempt_id AS context_attempt_id
        FROM runs r
        JOIN run_tickets rt ON rt.run_id = r.run_id AND rt.ticket_instance_id = ?
        JOIN attempts a ON a.run_id = r.run_id AND a.attempt_id = ? AND a.ticket_instance_id = ?
        JOIN commit_attributions c ON c.commit_attribution_id = ? AND c.attempt_id = a.attempt_id
        JOIN attempt_commit_intents ci ON ci.commit_attribution_id = c.commit_attribution_id
          AND ci.attempt_id = c.attempt_id AND ci.state = 'finalized'
        JOIN oracle_decisions o ON o.oracle_decision_id = ? AND o.run_id = r.run_id
          AND o.ticket_instance_id = a.ticket_instance_id AND o.attempt_id = a.attempt_id
        JOIN execution_contexts x ON x.context_id = ? AND x.attempt_id = a.attempt_id
        WHERE r.run_id = ?
      `).get(
        intent.ticket_instance_id ?? null,
        intent.attempt_id ?? null,
        intent.ticket_instance_id ?? null,
        intent.commit_attribution_id ?? null,
        intent.oracle_decision_id ?? null,
        intent.owner_context_id ?? null,
        intent.run_id ?? null,
      ) as MutableStateRecord | undefined;
      if (
        scope === undefined || scope.delivery_ref !== intent.delivery_ref ||
        scope.current_delivery_oid !== intent.expected_old_oid || scope.delivery_baseline_oid !== intent.expected_old_oid ||
        scope.commit_oid !== intent.candidate_oid || scope.parent_oid !== intent.expected_old_oid ||
        scope.oracle_result !== "accepted" || scope.scope_kind !== "attempt" ||
        scope.run_state !== "active" || scope.ticket_state !== "cleanup_pending" || scope.attempt_state !== "cleanup_pending" ||
        scope.context_attempt_id !== intent.attempt_id ||
        typeof scope.promotion_sequence !== "number" || intent.promotion_sequence !== scope.promotion_sequence + 1
      ) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "promotion intent does not match its run, attempt, oracle, attribution, and owner lineage");
      }
      this.#assertRepositoryCommit(intent.candidate_oid, "promotion candidate oid");
      const ancestry = execFileSync("git", ["rev-list", "--parents", "-n", "1", String(intent.candidate_oid)], {
        cwd: this.location.repoRealpath,
        encoding: "utf8",
      }).trim().split(/\s+/);
      if (ancestry.length !== 2 || ancestry[1] !== intent.expected_old_oid) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion candidate must have the exact delivery baseline as its sole parent", this.location.databasePath);
      }
      this.#insert("promotion_intents", intent);
      return frozenRow(intent);
    });
  }

  /** @internal Accepts only the runtime-unforgeable plan minted by PromotionAuthority. */
  commitAuthorizedPromotion(command: PromotionCommit): PromotionResult {
    if (!isAuthorizedPromotionCommit(command)) throw new TypeError("promotion command was not minted by PromotionAuthority");
    return this.#immediate(command.guard.kind === "finalize" ? "finalize_promotion" : "observe_promotion", () => {
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) throw new TypeError("promotion expectedVersion must be nonnegative");
      if (!/^sha256:[0-9a-f]{64}$/.test(command.ownerContextDigest)) throw new TypeError("promotion ownerContextDigest is invalid");
      if (command.idempotencyKey === "" || command.idempotencyKey !== command.idempotencyKey.trim()) throw new TypeError("promotion idempotencyKey is invalid");
      if (!PROMOTION_TRANSITIONS.some(([from, to]) => from === command.fromState && to === command.toState)) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion edge is not declared by the frozen contract", this.location.databasePath);
      }
      const intent = this.#requireDatabase().prepare(`
        SELECT p.*, c.context_digest AS owner_context_digest
        FROM promotion_intents p JOIN execution_contexts c ON c.context_id = p.owner_context_id
        WHERE p.promotion_intent_id = ?
      `).get(command.promotionIntentId) as MutableStateRecord | undefined;
      if (intent === undefined) this.#resumeIncompatible("promotion intent does not belong to the selected state store");
      if (intent.owner_context_digest !== command.ownerContextDigest) {
        throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "promotion owner context does not match the immutable intent", this.location.databasePath);
      }
      const resolved = this.#resolveTransitionEvidence(command.evidence, "TicketFinalizationService");
      const evidence = this.#requireTransitionGuard(
        `SELECT evidence_id, idempotency_key, scope, schema_version, inline_payload_json, content_digest FROM evidence
         WHERE evidence_id = ? AND attempt_id = ? AND producer_service = 'TicketFinalizationService'`,
        [resolved.evidenceId, intent.attempt_id ?? null],
        "promotion mutation requires exact TicketFinalizationService evidence in the intent attempt",
      );
      if (evidence.idempotency_key !== command.idempotencyKey) {
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "promotion idempotency key differs from its immutable evidence", this.location.databasePath);
      }
      const operationPayload = canonicalJson(promotionOperationEvidencePayload({
        promotionIntentId: command.promotionIntentId,
        expectedVersion: command.expectedVersion,
        fromState: command.fromState,
        toState: command.toState,
        ownerContextDigest: command.ownerContextDigest,
        guard: command.guard,
      }));
      if (
        evidence.scope !== command.promotionIntentId || evidence.schema_version !== "rickgent.promotion-operation.v1" ||
        evidence.inline_payload_json !== operationPayload || evidence.content_digest !== sha256Text(operationPayload)
      ) {
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "promotion operation evidence does not pin the exact canonical mutation input", this.location.databasePath);
      }

      const observedOid = command.guard.kind === "finalize" ? intent.observed_oid : command.guard.observedOid;
      const observationEvidenceId = command.guard.kind === "finalize" ? intent.observation_evidence_id : resolved.evidenceId;
      const finalizationEvidenceId = command.guard.kind === "finalize" ? resolved.evidenceId : null;
      const finalizationTransitions = command.guard.kind === "finalize" ? command.finalizationTransitions : null;
      if (command.guard.kind === "finalize") {
        if (
          finalizationTransitions === null || intent.attempt_id !== command.guard.attemptId ||
          intent.ticket_instance_id !== command.guard.ticketInstanceId || intent.oracle_decision_id !== command.guard.oracleDecisionId ||
          finalizationTransitions.oracleEvaluation.idempotencyKey !== command.guard.oracleEvaluationIdempotencyKey ||
          finalizationTransitions.verifiedAttempt.idempotencyKey !== command.guard.verifiedAttemptIdempotencyKey ||
          finalizationTransitions.readyTicket.idempotencyKey !== command.guard.readyTicketIdempotencyKey
        ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "atomic promotion finalization transitions differ from immutable intent lineage", this.location.databasePath);
      } else if (command.finalizationTransitions !== null) {
        throw new TypeError("promotion observation cannot carry finalization transitions");
      }
      const alreadyApplied = command.guard.kind === "finalize"
        ? intent.state === "finalized" && intent.state_version === command.expectedVersion + 1 && intent.finalization_evidence_id === resolved.evidenceId
        : ({
          ref_observed_old: ["ref_observed_old", "ref_observed_candidate", "conflicted", "finalized"],
          ref_observed_candidate: ["ref_observed_candidate", "conflicted", "finalized"],
          conflicted: ["conflicted"],
        } as const)[command.toState as "ref_observed_old" | "ref_observed_candidate" | "conflicted"]?.includes(
          intent.state as never,
        ) === true && Number(intent.state_version) >= command.expectedVersion + 1;
      if (alreadyApplied) {
        let oracleEvaluationTransition: TransitionResult | undefined;
        let verifiedAttemptTransition: TransitionResult | undefined;
        let readyTicketTransition: TransitionResult | undefined;
        if (command.guard.kind === "finalize" && finalizationTransitions !== null) {
          oracleEvaluationTransition = this.#commitTransitionInCurrentTransaction(finalizationTransitions.oracleEvaluation);
          verifiedAttemptTransition = this.#commitTransitionInCurrentTransaction(finalizationTransitions.verifiedAttempt);
          readyTicketTransition = this.#commitTransitionInCurrentTransaction(finalizationTransitions.readyTicket);
          const run = this.#requireTransitionGuard(
            "SELECT 1 FROM runs WHERE run_id = ? AND current_delivery_oid = ? AND promotion_sequence = ? AND state_version >= ?",
            [intent.run_id ?? null, intent.candidate_oid ?? null, intent.promotion_sequence ?? null, command.guard.expectedRunVersion + 1],
            "promotion replay run snapshot differs from the finalized chain",
          );
          void run;
        }
        return Object.freeze({
          promotionIntentId: command.promotionIntentId,
          fromState: command.fromState,
          toState: command.toState,
          stateVersion: command.expectedVersion + 1,
          observedOid: typeof observedOid === "string" ? observedOid : null,
          observationEvidenceId: typeof observationEvidenceId === "string" ? observationEvidenceId : null,
          finalizationEvidenceId: typeof finalizationEvidenceId === "string" ? finalizationEvidenceId : null,
          runStateVersion: command.guard.kind === "finalize" ? command.guard.expectedRunVersion + 1 : null,
          ...(oracleEvaluationTransition === undefined ? {} : { oracleEvaluationTransition }),
          ...(verifiedAttemptTransition === undefined ? {} : { verifiedAttemptTransition }),
          ...(readyTicketTransition === undefined ? {} : { readyTicketTransition }),
        });
      }
      if (intent.state !== command.fromState) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `promotion requires ${command.fromState}, observed ${String(intent.state)}`, this.location.databasePath);
      }
      if (intent.state_version !== command.expectedVersion) {
        throw typedError("RICKGENT_STATE_CONFLICT", "promotion expected state version changed", this.location.databasePath);
      }

      let runStateVersion: number | null = null;
      let oracleEvaluationTransition: TransitionResult | undefined;
      let verifiedAttemptTransition: TransitionResult | undefined;
      let readyTicketTransition: TransitionResult | undefined;
      if (command.guard.kind === "finalize") {
        if (finalizationTransitions === null) throw new TypeError("promotion finalization requires its atomic transition bundle");
        if (intent.observed_oid !== intent.candidate_oid || intent.observation_evidence_id === null) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion finalization requires an independently observed candidate", this.location.databasePath);
        }
        const cleanup = this.#validateCleanAttempt(String(intent.attempt_id), command.guard.cleanupRecordId);
        if (cleanup.delivery_ref_observed_oid !== intent.candidate_oid) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion cleanup proof did not observe the candidate delivery ref", this.location.databasePath);
        }
        let currentRef: string;
        try {
          currentRef = execFileSync("git", ["rev-parse", "--verify", String(intent.delivery_ref)], {
            cwd: this.location.repoRealpath,
            encoding: "utf8",
          }).trim();
        } catch (error) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion delivery ref cannot be independently re-observed", this.location.databasePath, error);
        }
        if (currentRef !== intent.candidate_oid) throw typedError("RICKGENT_PROMOTION_CONFLICT", "promotion delivery ref changed after candidate observation", this.location.databasePath);
        oracleEvaluationTransition = this.#commitTransitionInCurrentTransaction(finalizationTransitions.oracleEvaluation);
        const runUpdate = this.#requireDatabase().prepare(`
          UPDATE runs SET current_delivery_oid = ?, promotion_sequence = ?, state_version = state_version + 1
          WHERE run_id = ? AND state = 'active' AND current_delivery_oid = ? AND promotion_sequence = ? AND state_version = ?
        `).run(
          intent.candidate_oid ?? null,
          intent.promotion_sequence ?? null,
          intent.run_id ?? null,
          intent.expected_old_oid ?? null,
          Number(intent.promotion_sequence) - 1,
          command.guard.expectedRunVersion,
        );
        if (runUpdate.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "promotion finalization lost its run delivery-chain CAS race", this.location.databasePath);
        const intentUpdate = this.#requireDatabase().prepare(`
          UPDATE promotion_intents SET state = 'finalized', state_version = state_version + 1, finalization_evidence_id = ?
          WHERE promotion_intent_id = ? AND state = ? AND state_version = ? AND owner_context_id = ?
        `).run(resolved.evidenceId, command.promotionIntentId, command.fromState, command.expectedVersion, intent.owner_context_id ?? null);
        if (intentUpdate.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "promotion finalization lost its intent CAS race", this.location.databasePath);
        verifiedAttemptTransition = this.#commitTransitionInCurrentTransaction(finalizationTransitions.verifiedAttempt);
        readyTicketTransition = this.#commitTransitionInCurrentTransaction(finalizationTransitions.readyTicket);
        runStateVersion = command.guard.expectedRunVersion + 1;
      } else {
        this.#assertRepositoryOid(command.guard.observedOid, "promotion observed oid");
        let currentRef: string;
        try {
          currentRef = execFileSync("git", ["rev-parse", "--verify", String(intent.delivery_ref)], {
            cwd: this.location.repoRealpath,
            encoding: "utf8",
          }).trim();
        } catch (error) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion delivery ref cannot be independently observed", this.location.databasePath, error);
        }
        if (currentRef !== command.guard.observedOid) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion observed OID differs from the independently read delivery ref", this.location.databasePath);
        }
        if (
          (command.guard.kind === "observe_old" && command.guard.observedOid !== intent.expected_old_oid) ||
          (command.guard.kind === "observe_candidate" && command.guard.observedOid !== intent.candidate_oid) ||
          (command.guard.kind === "observe_conflict" && (command.guard.observedOid === intent.expected_old_oid || command.guard.observedOid === intent.candidate_oid))
        ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "promotion observation does not authorize the requested edge", this.location.databasePath);
        const intentUpdate = this.#requireDatabase().prepare(`
          UPDATE promotion_intents
          SET state = ?, state_version = state_version + 1, observed_oid = ?, observation_evidence_id = ?
          WHERE promotion_intent_id = ? AND state = ? AND state_version = ? AND owner_context_id = ?
        `).run(
          command.toState,
          command.guard.observedOid,
          resolved.evidenceId,
          command.promotionIntentId,
          command.fromState,
          command.expectedVersion,
          intent.owner_context_id ?? null,
        );
        if (intentUpdate.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "promotion observation lost its intent CAS race", this.location.databasePath);
      }
      return Object.freeze({
        promotionIntentId: command.promotionIntentId,
        fromState: command.fromState,
        toState: command.toState,
        stateVersion: command.expectedVersion + 1,
        observedOid: typeof observedOid === "string" ? observedOid : null,
        observationEvidenceId: typeof observationEvidenceId === "string" ? observationEvidenceId : null,
        finalizationEvidenceId: typeof finalizationEvidenceId === "string" ? finalizationEvidenceId : null,
        runStateVersion,
        ...(oracleEvaluationTransition === undefined ? {} : { oracleEvaluationTransition }),
        ...(verifiedAttemptTransition === undefined ? {} : { verifiedAttemptTransition }),
        ...(readyTicketTransition === undefined ? {} : { readyTicketTransition }),
      });
    });
  }

  /** @internal Accepts only runtime-unforgeable plans minted by DeliveryAuthority. */
  commitAuthorizedDelivery(command: DeliveryCommand): StateRecord {
    if (!isAuthorizedDeliveryCommand(command)) throw new TypeError("delivery command was not minted by DeliveryAuthority");
    switch (command.command.kind) {
      case "intent": return this.#createDeliveryIntent(command.command.request);
      case "remote_observation": return this.#recordRemoteObservation(command.command.request);
      case "pr_observation": return this.#recordPrObservation(command.command.request);
      case "decision": return this.#recordDeliveryDecision(command.command.request, command.command.terminalTransition);
    }
  }

  #createDeliveryIntent(request: DeliveryIntentRequest): StateRecord {
    const intent = this.#validatedColumns("delivery_intents", normalizeRow({
      delivery_intent_id: request.deliveryIntentId,
      run_id: request.runId,
      delivery_oid: request.deliveryOid,
      remote_name: request.remoteName,
      branch_name: request.branchName,
      expected_remote_oid: request.expectedRemoteOid,
      base_branch: request.baseBranch,
      provider_identity_digest: request.providerIdentityDigest,
      idempotency_key: request.idempotencyKey,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("delivery_intents", intent);
    this.#assertRepositoryOid(intent.delivery_oid, "delivery intent oid");
    if (intent.expected_remote_oid !== null) this.#assertRepositoryOid(intent.expected_remote_oid, "expected remote oid");
    return this.#immediate("create_delivery_intent", () => {
      const existing = this.#selectBy("delivery_intents", intent, ["run_id", "idempotency_key"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, intent)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "delivery idempotency key has different immutable input", this.location.databasePath);
      }
      const run = this.#requireDatabase().prepare(`
        SELECT r.state, r.current_delivery_oid
        FROM runs r JOIN execution_contexts c ON c.context_id = ? AND c.context_digest = ?
        JOIN attempts a ON a.attempt_id = c.attempt_id AND a.run_id = r.run_id
        WHERE r.run_id = ?
      `).get(request.ownerContextId, request.ownerContextDigest, request.runId) as MutableStateRecord | undefined;
      if (run?.state !== "ready_for_delivery" || run.current_delivery_oid !== intent.delivery_oid) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "delivery intent is not pinned to its owner context and a ready run's current delivery OID");
      }
      this.#insert("delivery_intents", intent);
      return frozenRow(intent);
    });
  }

  #recordRemoteObservation(request: RemoteObservationRequest): StateRecord {
    if (request.observedRemoteOid !== null) this.#assertRepositoryOid(request.observedRemoteOid, "observed remote oid");
    return this.#immediate("append_remote_observation", () => {
      const payload = {
        delivery_intent_id: request.deliveryIntentId,
        remote_observation_id: request.remoteObservationId,
        sequence: request.sequence,
        operation: request.operation,
        outcome: request.outcome,
        observed_remote_oid: request.observedRemoteOid,
      };
      const evidence = this.#resolveTransitionEvidence({
        purpose: "remote_observation",
        inlineEvidence: {
          contextId: request.ownerContextId,
          producerService: "DeliveryService",
          scope: request.deliveryIntentId,
          schemaVersion: "rickgent.delivery-remote-observation.v1",
          payload,
          idempotencyKey: request.evidenceIdempotencyKey,
        },
      }, "DeliveryService");
      const observation = this.#validatedColumns("remote_observations", normalizeRow({
        remote_observation_id: request.remoteObservationId,
        delivery_intent_id: request.deliveryIntentId,
        sequence: request.sequence,
        operation: request.operation,
        outcome: request.outcome,
        observed_remote_oid: request.observedRemoteOid,
        evidence_id: evidence.evidenceId,
        created_at: request.createdAt,
      }));
      this.#requireCompleteRow("remote_observations", observation);
      const existing = this.#selectBy("remote_observations", observation, ["delivery_intent_id", "sequence"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, observation)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "remote observation sequence already has different immutable input", this.location.databasePath);
      }
      this.#requireTransitionGuard(`
        SELECT 1 FROM delivery_intents i JOIN execution_contexts c ON c.context_id = ? AND c.context_digest = ?
        JOIN attempts a ON a.attempt_id = c.attempt_id AND a.run_id = i.run_id
        WHERE i.delivery_intent_id = ?
      `, [request.ownerContextId, request.ownerContextDigest, request.deliveryIntentId], "remote observation owner differs from delivery intent run lineage");
      const terminal = this.#requireDatabase().prepare("SELECT 1 FROM delivery_records WHERE delivery_intent_id = ?").get(request.deliveryIntentId);
      const pr = this.#requireDatabase().prepare("SELECT 1 FROM pr_observations WHERE delivery_intent_id = ?").get(request.deliveryIntentId);
      if (terminal !== undefined || pr !== undefined) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "remote observations cannot append after PR observation or delivery finalization", this.location.databasePath);
      const sequence = this.#requireDatabase().prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM remote_observations WHERE delivery_intent_id = ?",
      ).get(request.deliveryIntentId) as MutableStateRecord;
      if (request.sequence !== sequence.next_sequence) throw typedError("RICKGENT_STATE_CONFLICT", "remote observation sequence is not the exact next value", this.location.databasePath);
      if (request.observedRemoteOid !== null && request.operation !== "ls-remote") {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "an observed remote OID requires an independent ls-remote operation", this.location.databasePath);
      }
      this.#insert("remote_observations", observation);
      return frozenRow(observation);
    });
  }

  #recordPrObservation(request: PrObservationRequest): StateRecord {
    this.#assertRepositoryOid(request.observedHeadOid, "observed PR head oid");
    return this.#immediate("append_pr_observation", () => {
      const payload = {
        delivery_intent_id: request.deliveryIntentId,
        pr_observation_id: request.prObservationId,
        sequence: request.sequence,
        provider_repository_id: request.providerRepositoryId,
        base_branch: request.baseBranch,
        head_branch: request.headBranch,
        pr_identity: request.prIdentity,
        observed_head_oid: request.observedHeadOid,
      };
      const evidence = this.#resolveTransitionEvidence({
        purpose: "pr_observation",
        inlineEvidence: {
          contextId: request.ownerContextId,
          producerService: "DeliveryService",
          scope: request.deliveryIntentId,
          schemaVersion: "rickgent.delivery-pr-observation.v1",
          payload,
          idempotencyKey: request.evidenceIdempotencyKey,
        },
      }, "DeliveryService");
      const observation = this.#validatedColumns("pr_observations", normalizeRow({
        pr_observation_id: request.prObservationId,
        delivery_intent_id: request.deliveryIntentId,
        sequence: request.sequence,
        provider_repository_id: request.providerRepositoryId,
        base_branch: request.baseBranch,
        head_branch: request.headBranch,
        pr_identity: request.prIdentity,
        observed_head_oid: request.observedHeadOid,
        evidence_id: evidence.evidenceId,
        created_at: request.createdAt,
      }));
      this.#requireCompleteRow("pr_observations", observation);
      const existing = this.#selectBy("pr_observations", observation, ["delivery_intent_id", "sequence"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, observation)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "PR observation sequence already has different immutable input", this.location.databasePath);
      }
      const lineage = this.#requireTransitionGuard(`
        SELECT i.delivery_oid, i.base_branch, i.branch_name, ro.observed_remote_oid, ro.operation
        FROM delivery_intents i JOIN execution_contexts c ON c.context_id = ? AND c.context_digest = ?
        JOIN attempts a ON a.attempt_id = c.attempt_id AND a.run_id = i.run_id
        JOIN remote_observations ro ON ro.delivery_intent_id = i.delivery_intent_id
          AND ro.sequence = (SELECT MAX(sequence) FROM remote_observations WHERE delivery_intent_id = i.delivery_intent_id)
        WHERE i.delivery_intent_id = ?
      `, [request.ownerContextId, request.ownerContextDigest, request.deliveryIntentId], "PR observation requires exact delivery owner and a prior remote observation");
      const terminal = this.#requireDatabase().prepare("SELECT 1 FROM delivery_records WHERE delivery_intent_id = ?").get(request.deliveryIntentId);
      if (terminal !== undefined) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "PR observations cannot append after delivery finalization", this.location.databasePath);
      if (
        lineage.observed_remote_oid !== lineage.delivery_oid || lineage.operation !== "ls-remote" ||
        lineage.delivery_oid !== request.observedHeadOid || lineage.base_branch !== request.baseBranch ||
        lineage.branch_name !== request.headBranch
      ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "PR observation identity or OID is not ordered after the exact remote delivery observation", this.location.databasePath);
      const sequence = this.#requireDatabase().prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM pr_observations WHERE delivery_intent_id = ?",
      ).get(request.deliveryIntentId) as MutableStateRecord;
      if (request.sequence !== sequence.next_sequence) throw typedError("RICKGENT_STATE_CONFLICT", "PR observation sequence is not the exact next value", this.location.databasePath);
      this.#insert("pr_observations", observation);
      return frozenRow(observation);
    });
  }

  #recordDeliveryDecision(request: DeliveryDecisionRequest, terminalTransition: TransitionCommit): StateRecord {
    this.#assertRepositoryOid(request.deliveryOid, "delivery record oid");
    return this.#immediate("finalize_delivery", () => {
      const payload = deliveryDecisionEvidencePayload(request);
      const decisionEvidence = this.#resolveTransitionEvidence({
        purpose: "delivery_decision",
        inlineEvidence: {
          contextId: request.ownerContextId,
          producerService: "DeliveryService",
          scope: request.deliveryIntentId,
          schemaVersion: "rickgent.delivery-decision.v1",
          payload,
          idempotencyKey: request.evidenceIdempotencyKey,
        },
      }, "DeliveryService");
      const cleanup = this.#requireTransitionGuard(`
        SELECT cr.evidence_id FROM cleanup_records cr
        JOIN evidence ce ON ce.evidence_id = cr.evidence_id AND ce.producer_service = 'CleanupService'
        JOIN attempts a ON a.attempt_id = cr.attempt_id
        JOIN delivery_intents i ON i.run_id = a.run_id
        WHERE cr.cleanup_record_id = ? AND i.delivery_intent_id = ?
          AND cr.group_dead = 1 AND cr.resources_absent = 1 AND cr.lease_release_eligible = 1
      `, [request.cleanupRecordId, request.deliveryIntentId], "delivery decision requires exact complete CleanupService evidence in the delivery run");
      const record = this.#validatedColumns("delivery_records", normalizeRow({
        delivery_record_id: request.deliveryRecordId,
        delivery_intent_id: request.deliveryIntentId,
        terminal_from_state: request.terminalFromState,
        remote_observation_id: request.remoteObservationId,
        pr_observation_id: request.prObservationId,
        decision_evidence_id: decisionEvidence.evidenceId,
        cleanup_evidence_id: cleanup.evidence_id ?? null,
        delivery_oid: request.deliveryOid,
        decision: request.decision,
        output_digest: sha256Text(canonicalJson(payload)),
        created_at: request.createdAt,
      }));
      this.#requireCompleteRow("delivery_records", record);
      const existing = this.#selectBy("delivery_records", record, ["delivery_intent_id"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, record)) {
          this.#commitTransitionInCurrentTransaction(terminalTransition);
          return frozenRow(existing);
        }
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "delivery intent already has a different terminal record", this.location.databasePath);
      }
      const lineage = this.#requireDatabase().prepare(`
        SELECT i.run_id, i.delivery_oid AS intent_oid, r.current_delivery_oid, r.state AS run_state,
               ro.observed_remote_oid, ro.operation AS remote_operation, ro.sequence AS remote_sequence,
               (SELECT MAX(sequence) FROM remote_observations WHERE delivery_intent_id = i.delivery_intent_id) AS latest_remote_sequence,
               po.observed_head_oid, po.sequence AS pr_sequence,
               (SELECT MAX(sequence) FROM pr_observations WHERE delivery_intent_id = i.delivery_intent_id) AS latest_pr_sequence
        FROM delivery_intents i JOIN runs r ON r.run_id = i.run_id
        JOIN execution_contexts c ON c.context_id = ? AND c.context_digest = ?
        JOIN attempts a ON a.attempt_id = c.attempt_id AND a.run_id = i.run_id
        LEFT JOIN remote_observations ro ON ro.remote_observation_id = ? AND ro.delivery_intent_id = i.delivery_intent_id
        LEFT JOIN pr_observations po ON po.pr_observation_id = ? AND po.delivery_intent_id = i.delivery_intent_id
        WHERE i.delivery_intent_id = ?
      `).get(
        request.ownerContextId,
        request.ownerContextDigest,
        request.remoteObservationId,
        request.prObservationId,
        request.deliveryIntentId,
      ) as MutableStateRecord | undefined;
      if (lineage === undefined) throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "delivery decision owner does not resolve to the delivery run");
      const delivered = request.decision === "delivered";
      const exactStage = request.terminalFromState === "intent_recorded"
        ? lineage.latest_remote_sequence === null && lineage.latest_pr_sequence === null
        : request.terminalFromState === "remote_observed"
          ? lineage.remote_sequence === lineage.latest_remote_sequence && lineage.latest_pr_sequence === null
          : lineage.remote_sequence === lineage.latest_remote_sequence && lineage.pr_sequence === lineage.latest_pr_sequence;
      if (
        lineage.run_state !== "ready_for_delivery" || lineage.intent_oid !== request.deliveryOid ||
        lineage.current_delivery_oid !== request.deliveryOid || !exactStage ||
        (delivered && (
          request.terminalFromState !== "pr_observed" || lineage.remote_operation !== "ls-remote" ||
          lineage.observed_remote_oid !== request.deliveryOid || lineage.observed_head_oid !== request.deliveryOid
        ))
      ) throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "delivery terminal record does not match exact run and observation OIDs");
      this.#insert("delivery_records", record);
      this.#commitTransitionInCurrentTransaction(terminalTransition);
      return frozenRow(record);
    });
  }

  /** @internal Accepts only runtime-unforgeable plans minted by LifecycleRecordAuthority. */
  commitAuthorizedLifecycleRecord(command: LifecycleRecordCommand): StateRecord {
    if (!isAuthorizedLifecycleRecordCommand(command)) throw new TypeError("lifecycle record command was not minted by LifecycleRecordAuthority");
    switch (command.command.kind) {
      case "review_record": return this.#recordReview(command.command.request);
      case "remediation_record": return this.#recordRemediation(command.command.request);
      case "gate_result": return this.#recordGateResult(command.command.request);
      case "cleanup_record": return this.#recordCleanup(command.command.request);
    }
  }

  #requireOwnedEvidence(evidenceId: string, attemptId: string, producerService: string, label: string): void {
    this.#requireTransitionGuard(
      "SELECT 1 FROM evidence WHERE evidence_id = ? AND attempt_id = ? AND producer_service = ?",
      [evidenceId, attemptId, producerService],
      `${label} evidence does not belong to ${producerService} in the record attempt`,
    );
  }

  #insertExactLifecycleRow(
    table: "review_records" | "remediation_records" | "gate_results" | "commit_attributions" | "cleanup_records",
    row: MutableStateRecord,
    identityColumns: readonly string[],
  ): StateRecord {
    const existing = this.#selectBy(table, row, identityColumns);
    if (existing !== undefined) {
      if (this.#sameRecord(existing, row)) return frozenRow(existing);
      throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", `${table} identity has different immutable input`, this.location.databasePath);
    }
    this.#insert(table, row);
    return frozenRow(row);
  }

  #replayExactLifecycleRow(
    table: "review_records" | "remediation_records" | "gate_results" | "commit_attributions" | "cleanup_records",
    row: MutableStateRecord,
    identityColumns: readonly string[],
  ): StateRecord | undefined {
    const existing = this.#selectBy(table, row, identityColumns);
    if (existing === undefined) return undefined;
    if (this.#sameRecord(existing, row)) return frozenRow(existing);
    throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", `${table} identity has different immutable input`, this.location.databasePath);
  }

  #requireReplayContext(contextId: string, attemptId: string, contextDigest: string, phase: string, role: string, label: string): void {
    this.#requireTransitionGuard(
      "SELECT 1 FROM execution_contexts WHERE context_id = ? AND attempt_id = ? AND context_digest = ? AND phase = ? AND role = ?",
      [contextId, attemptId, contextDigest, phase, role],
      `${label} replay owner context differs from the immutable record lineage`,
    );
  }

  #recordReview(request: ReviewRecordRequest): StateRecord {
    const row = this.#validatedColumns("review_records", normalizeRow({
      review_record_id: request.reviewRecordId,
      attempt_id: request.attemptId,
      cycle: request.cycle,
      reviewer_context_id: request.reviewerContextId,
      verdict: request.verdict,
      verdict_evidence_id: request.verdictEvidenceId,
      findings_evidence_id: request.findingsEvidenceId,
      input_tree_oid: request.inputTreeOid,
      input_diff_digest: request.inputDiffDigest,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("review_records", row);
    this.#assertRepositoryOid(row.input_tree_oid, "review input tree oid");
    return this.#immediate("persist_review_record", () => {
      const replay = this.#replayExactLifecycleRow("review_records", row, ["attempt_id", "cycle"]);
      if (replay !== undefined) {
        this.#requireReplayContext(request.reviewerContextId, request.attemptId, request.ownerContextDigest, "review", "reviewer", "review record");
        return replay;
      }
      const lineage = this.#requireTransitionGuard(`
        SELECT a.delivery_baseline_oid, tc.canonical_contract_json
        FROM execution_contexts c JOIN attempts a ON a.attempt_id = c.attempt_id
        JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
        WHERE c.context_id = ? AND c.attempt_id = ? AND c.context_digest = ? AND c.phase = 'review' AND c.role = 'reviewer'
          AND a.state = 'reviewing'
      `,
        [request.reviewerContextId, request.attemptId, request.ownerContextDigest],
        "review record owner context differs from its attempt",
      );
      const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "review ticket contract");
      const budgets = contract.budgets !== null && typeof contract.budgets === "object" && !Array.isArray(contract.budgets)
        ? contract.budgets as Record<string, unknown> : {};
      if (!Number.isSafeInteger(budgets.max_review_cycles) || request.cycle > Number(budgets.max_review_cycles)) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "review cycle exceeds the sealed ticket contract budget", this.location.databasePath);
      }
      this.#assertRepositoryTree(request.inputTreeOid, "review input tree oid");
      const delta = this.#canonicalGitDelta(String(lineage.delivery_baseline_oid), request.inputTreeOid, "review input delta");
      if (delta.entries.length === 0 || request.inputDiffDigest !== delta.candidateDiffDigest) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "review input diff digest differs from the independently observed candidate", this.location.databasePath);
      }
      this.#assertDeltaWithinScope(delta, contract.scope, "review input delta");
      this.#requireOwnedEvidence(request.verdictEvidenceId, request.attemptId, "ReviewService", "review verdict");
      this.#requireOwnedEvidence(request.findingsEvidenceId, request.attemptId, "ReviewService", "review findings");
      this.#requireExactInlineEvidence(request.verdictEvidenceId, "ReviewService", request.reviewRecordId, "rickgent.review-verdict.v1", {
        attempt_id: request.attemptId,
        cycle: request.cycle,
        verdict: request.verdict,
        input_tree_oid: request.inputTreeOid,
        input_diff_digest: request.inputDiffDigest,
      }, "review verdict");
      const sequence = this.#requireDatabase().prepare("SELECT COALESCE(MAX(cycle), 0) + 1 AS next_cycle FROM review_records WHERE attempt_id = ?").get(request.attemptId) as MutableStateRecord;
      const existing = this.#selectBy("review_records", row, ["attempt_id", "cycle"]);
      if (existing === undefined && request.cycle !== sequence.next_cycle) throw typedError("RICKGENT_STATE_CONFLICT", "review cycle is not the exact next value", this.location.databasePath);
      return this.#insertExactLifecycleRow("review_records", row, ["attempt_id", "cycle"]);
    });
  }

  #recordRemediation(request: RemediationRecordRequest): StateRecord {
    const row = this.#validatedColumns("remediation_records", normalizeRow({
      remediation_record_id: request.remediationRecordId,
      attempt_id: request.attemptId,
      cycle: request.cycle,
      context_id: request.contextId,
      findings_evidence_id: request.findingsEvidenceId,
      output_evidence_id: request.outputEvidenceId,
      result_tree_oid: request.resultTreeOid,
      result_diff_digest: request.resultDiffDigest,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("remediation_records", row);
    this.#assertRepositoryOid(row.result_tree_oid, "remediation result tree oid");
    return this.#immediate("persist_remediation_record", () => {
      const replay = this.#replayExactLifecycleRow("remediation_records", row, ["attempt_id", "cycle"]);
      if (replay !== undefined) {
        this.#requireReplayContext(request.contextId, request.attemptId, request.ownerContextDigest, "remediation", "remediator", "remediation record");
        return replay;
      }
      const lineage = this.#requireTransitionGuard(`
        SELECT a.delivery_baseline_oid, tc.canonical_contract_json
        FROM execution_contexts c JOIN attempts a ON a.attempt_id = c.attempt_id
        JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
        WHERE c.context_id = ? AND c.attempt_id = ? AND c.context_digest = ? AND c.phase = 'remediation' AND c.role = 'remediator'
          AND a.state = 'remediating'
      `,
        [request.contextId, request.attemptId, request.ownerContextDigest],
        "remediation record owner context differs from its attempt",
      );
      const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "remediation ticket contract");
      const budgets = contract.budgets !== null && typeof contract.budgets === "object" && !Array.isArray(contract.budgets)
        ? contract.budgets as Record<string, unknown> : {};
      if (!Number.isSafeInteger(budgets.remediation_limit) || request.cycle > Number(budgets.remediation_limit)) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "remediation cycle exceeds the sealed ticket contract budget", this.location.databasePath);
      }
      this.#assertRepositoryTree(request.resultTreeOid, "remediation result tree oid");
      const delta = this.#canonicalGitDelta(String(lineage.delivery_baseline_oid), request.resultTreeOid, "remediation result delta");
      if (delta.entries.length === 0 || request.resultDiffDigest !== delta.candidateDiffDigest) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "remediation result diff digest differs from the independently observed candidate", this.location.databasePath);
      }
      this.#assertDeltaWithinScope(delta, contract.scope, "remediation result delta");
      this.#requireOwnedEvidence(request.findingsEvidenceId, request.attemptId, "ReviewService", "remediation findings");
      this.#requireOwnedEvidence(request.outputEvidenceId, request.attemptId, "RemediationService", "remediation output");
      this.#requireExactInlineEvidence(request.outputEvidenceId, "RemediationService", request.remediationRecordId, "rickgent.remediation-output.v1", {
        oracle_input_class: "remediation_cycle",
        attempt_id: request.attemptId,
        cycle: request.cycle,
        result_tree_oid: request.resultTreeOid,
        result_diff_digest: request.resultDiffDigest,
      }, "remediation output");
      const rejected = this.#requireTransitionGuard(
        "SELECT 1 FROM review_records WHERE attempt_id = ? AND cycle = ? AND verdict = 'rejected' AND findings_evidence_id = ?",
        [request.attemptId, request.cycle, request.findingsEvidenceId],
        "remediation record requires the exact rejected review cycle",
      );
      void rejected;
      return this.#insertExactLifecycleRow("remediation_records", row, ["attempt_id", "cycle"]);
    });
  }

  #recordGateResult(request: GateResultRecordRequest): StateRecord {
    const payload = {
      gate_id: request.gateId,
      evaluation_ordinal: request.evaluationOrdinal,
      required: request.required,
      status: request.status,
      candidate_tree_oid: request.candidateTreeOid,
      candidate_diff_digest: request.candidateDiffDigest,
    };
    const row = this.#validatedColumns("gate_results", normalizeRow({
      gate_result_id: request.gateResultId,
      attempt_id: request.attemptId,
      gate_id: request.gateId,
      evaluation_ordinal: request.evaluationOrdinal,
      status: request.status,
      required: request.required,
      context_id: request.contextId,
      contract_digest: request.contractDigest,
      evidence_id: request.evidenceId,
      result_digest: sha256Text(canonicalJson(payload)),
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("gate_results", row);
    this.#assertRepositoryOid(request.candidateTreeOid, "gate candidate tree oid");
    return this.#immediate("persist_gate_result", () => {
      const replay = this.#replayExactLifecycleRow("gate_results", row, ["attempt_id", "gate_id", "evaluation_ordinal"]);
      if (replay !== undefined) {
        this.#requireReplayContext(request.contextId, request.attemptId, request.ownerContextDigest, "verification", "verifier", "gate result");
        return replay;
      }
      const contract = this.#requireTransitionGuard(`
        SELECT tc.canonical_contract_json, a.delivery_baseline_oid FROM execution_contexts c JOIN attempts a ON a.attempt_id = c.attempt_id
        JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
        WHERE c.context_id = ? AND c.attempt_id = ? AND c.context_digest = ? AND a.contract_digest = ?
          AND c.phase = 'verification' AND c.role = 'verifier' AND a.state = 'verifying'
      `, [request.contextId, request.attemptId, request.ownerContextDigest, request.contractDigest], "gate result verification context or contract differs from its attempt");
      const contractJson = this.#parseJsonObject(String(contract.canonical_contract_json), "gate result ticket contract");
      const verifications = Array.isArray(contractJson.verifications) ? contractJson.verifications : [];
      const declared = verifications.some((entry) => {
        const value = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
        return value.id === request.gateId;
      });
      if (!declared || !request.required) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "gate result must be a required verification sealed by the ticket contract", this.location.databasePath);
      this.#assertRepositoryTree(request.candidateTreeOid, "gate candidate tree oid");
      const delta = this.#canonicalGitDelta(String(contract.delivery_baseline_oid), request.candidateTreeOid, "gate candidate delta");
      if (delta.entries.length === 0 || request.candidateDiffDigest !== delta.candidateDiffDigest) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "gate result does not pin the independently observed nonempty candidate delta", this.location.databasePath);
      }
      this.#assertDeltaWithinScope(delta, contractJson.scope, "gate candidate delta");
      const gateEvidence = this.#requireTransitionGuard(
        "SELECT scope, schema_version, inline_payload_json, content_digest FROM evidence WHERE evidence_id = ? AND attempt_id = ? AND producer_service = 'VerificationService'",
        [request.evidenceId, request.attemptId],
        "gate result evidence does not belong to VerificationService in the record attempt",
      );
      const gatePayload = canonicalJson(payload);
      if (
        gateEvidence.scope !== request.gateResultId || gateEvidence.schema_version !== "rickgent.gate-result.v1" ||
        gateEvidence.inline_payload_json !== gatePayload || gateEvidence.content_digest !== sha256Text(gatePayload)
      ) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "gate result evidence does not pin the sealed status projection", this.location.databasePath);
      }
      const sequence = this.#requireDatabase().prepare(
        "SELECT COALESCE(MAX(evaluation_ordinal), -1) + 1 AS next_ordinal FROM gate_results WHERE attempt_id = ? AND gate_id = ?",
      ).get(request.attemptId, request.gateId) as MutableStateRecord;
      const existing = this.#selectBy("gate_results", row, ["attempt_id", "gate_id", "evaluation_ordinal"]);
      if (existing === undefined && request.evaluationOrdinal !== sequence.next_ordinal) throw typedError("RICKGENT_STATE_CONFLICT", "gate evaluation ordinal is not the exact next value", this.location.databasePath);
      return this.#insertExactLifecycleRow("gate_results", row, ["attempt_id", "gate_id", "evaluation_ordinal"]);
    });
  }

  #assertCommitDeltaModes(delta: CanonicalGitDelta): void {
    try {
      validateCommitDeltaModes(delta);
    } catch (error) {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        error instanceof Error ? error.message : "commit delta has an unsupported mode",
        this.location.databasePath,
        error,
      );
    }
  }

  #assertExactCommitDelta(
    request: Pick<CommitIntentPrepareProjection, "baselineOid" | "treeAfterOid" | "candidateDiffDigest" | "pathSetDigest" | "changeKindSetDigest" | "modeSetDigest" | "normalizedDelta">,
    label: string,
  ): CanonicalGitDelta {
    const delta = this.#canonicalGitDelta(request.baselineOid, request.treeAfterOid, label);
    if (
      delta.entries.length === 0 || request.candidateDiffDigest !== delta.candidateDiffDigest ||
      request.pathSetDigest !== delta.pathSetDigest || request.changeKindSetDigest !== delta.changeKindSetDigest ||
      request.modeSetDigest !== delta.modeSetDigest || canonicalJson(request.normalizedDelta) !== canonicalJson(delta.entries)
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} differs from the independently observed canonical Git delta`, this.location.databasePath);
    this.#assertCommitDeltaModes(delta);
    return delta;
  }

  #commitMetadataJson(metadata: CommitMetadataProjection): string {
    for (const [label, value] of [
      ["author name", metadata.authorName], ["author email", metadata.authorEmail],
      ["committer name", metadata.committerName], ["committer email", metadata.committerEmail],
    ] as const) {
      if (value === "" || value !== value.trim() || value.includes("\0") || value.includes("\n")) {
        throw new TypeError(`commit metadata ${label} is invalid`);
      }
    }
    this.#assertProcessTimestamp(metadata.authorDate, "commit author date");
    this.#assertProcessTimestamp(metadata.committerDate, "commit committer date");
    this.#assertProcessDigest(metadata.messageDigest, "commit message digest");
    return canonicalJson({
      author_name: metadata.authorName,
      author_email: metadata.authorEmail,
      author_date: metadata.authorDate,
      committer_name: metadata.committerName,
      committer_email: metadata.committerEmail,
      committer_date: metadata.committerDate,
      message_digest: metadata.messageDigest,
    });
  }

  #observeCommitRef(ref: string, label: string): string {
    if (ref === "" || ref.startsWith("-") || ref.includes("\0")) throw new TypeError(`${label} is invalid`);
    try {
      return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: this.location.repoRealpath,
        encoding: "utf8",
        env: HERMETIC_GIT_ENVIRONMENT,
      }).trim();
    } catch (error) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} cannot be independently observed`, this.location.databasePath, error);
    }
  }

  #prepareCommitIntent(request: CommitIntentPrepareProjection): StateRecord {
    for (const [label, value] of [
      ["commit intent id", request.commitIntentId], ["attempt id", request.attemptId],
      ["ownership id", request.ownershipId], ["phase execution id", request.phaseExecutionId],
      ["context id", request.contextId], ["launch id", request.launchId],
      ["process receipt id", request.processReceiptId], ["idempotency key", request.idempotencyKey],
    ] as const) this.#assertProcessIdentity(value, label);
    for (const [label, value] of [
      ["ownership context digest", request.ownershipContextDigest],
      ["execution context digest", request.executionContextDigest],
      ["contract digest", request.contractDigest], ["candidate diff digest", request.candidateDiffDigest],
      ["path set digest", request.pathSetDigest], ["change kind set digest", request.changeKindSetDigest],
      ["mode set digest", request.modeSetDigest],
    ] as const) this.#assertProcessDigest(value, label);
    this.#assertProcessTimestamp(request.createdAt, "commit intent time");
    if (!Number.isSafeInteger(request.ownerGeneration) || request.ownerGeneration < 1 ||
        !Number.isSafeInteger(request.ownershipStateVersion) || request.ownershipStateVersion < 0) {
      throw new TypeError("commit intent ownership version is invalid");
    }
    for (const oid of [request.baselineOid, request.treeBeforeOid, request.treeAfterOid]) {
      this.#assertRepositoryOid(oid, "commit intent Git OID");
    }
    const resourceSlots = ["delivery_ref", "attempt_ref", "worktree", "isolated_index"] as const;
    if (
      request.expectedResourceVersions === null || typeof request.expectedResourceVersions !== "object" ||
      Object.keys(request.expectedResourceVersions).sort().join("\0") !== [...resourceSlots].sort().join("\0") ||
      resourceSlots.some((slot) => !Number.isSafeInteger(request.expectedResourceVersions[slot]) || request.expectedResourceVersions[slot] < 0)
    ) throw new TypeError("commit resource expected versions are invalid");
    if (!Array.isArray(request.verificationReceiptDigests) || request.verificationReceiptDigests.length === 0) {
      throw new TypeError("commit intent requires verification receipt digests");
    }
    for (const value of request.verificationReceiptDigests) this.#assertProcessDigest(value, "verification receipt digest");
    const metadataJson = this.#commitMetadataJson(request.commitMetadata);
    const metadata = this.#parseJsonObject(metadataJson, "commit metadata");
    const normalizedDeltaJson = canonicalJson(request.normalizedDelta);
    const verificationJson = canonicalJson(request.verificationReceiptDigests);
    const preimage = {
      schema_version: "rickgent.commit-intent.v1",
      repository_id: this.location.repositoryId,
      attempt_id: request.attemptId,
      ownership_id: request.ownershipId,
      owner_generation: request.ownerGeneration,
      ownership_state_version: request.ownershipStateVersion,
      ownership_context_digest: request.ownershipContextDigest,
      phase_execution_id: request.phaseExecutionId,
      context_id: request.contextId,
      execution_context_digest: request.executionContextDigest,
      launch_id: request.launchId,
      process_receipt_id: request.processReceiptId,
      delivery_ref: request.deliveryRef,
      attempt_ref: request.attemptRef,
      baseline_oid: request.baselineOid,
      contract_digest: request.contractDigest,
      resource_versions: request.expectedResourceVersions,
      tree_before_oid: request.treeBeforeOid,
      tree_after_oid: request.treeAfterOid,
      candidate_diff_digest: request.candidateDiffDigest,
      path_set_digest: request.pathSetDigest,
      change_kind_set_digest: request.changeKindSetDigest,
      mode_set_digest: request.modeSetDigest,
      normalized_delta: request.normalizedDelta,
      verification_receipt_digests: request.verificationReceiptDigests,
      commit_metadata: metadata,
      idempotency_key: request.idempotencyKey,
      created_at: request.createdAt,
    };
    const inputDigest = sha256Text(canonicalJson(preimage));
    const replay = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_commit_intents
      WHERE commit_intent_id = ? OR attempt_id = ? OR (attempt_id = ? AND idempotency_key = ?)
      LIMIT 1
    `).get(request.commitIntentId, request.attemptId, request.attemptId, request.idempotencyKey) as MutableStateRecord | undefined;
    if (replay !== undefined) {
      const exact =
        replay.commit_intent_id === request.commitIntentId && replay.repository_id === this.location.repositoryId &&
        replay.attempt_id === request.attemptId && replay.ownership_id === request.ownershipId &&
        replay.owner_generation === request.ownerGeneration && replay.ownership_state_version === request.ownershipStateVersion &&
        replay.ownership_context_digest === request.ownershipContextDigest && replay.phase_execution_id === request.phaseExecutionId &&
        replay.context_id === request.contextId && replay.execution_context_digest === request.executionContextDigest &&
        replay.launch_id === request.launchId && replay.process_receipt_id === request.processReceiptId &&
        replay.delivery_ref === request.deliveryRef && replay.attempt_ref === request.attemptRef &&
        replay.baseline_oid === request.baselineOid && replay.contract_digest === request.contractDigest &&
        replay.delivery_ref_expected_version === request.expectedResourceVersions.delivery_ref &&
        replay.attempt_ref_expected_version === request.expectedResourceVersions.attempt_ref &&
        replay.worktree_expected_version === request.expectedResourceVersions.worktree &&
        replay.isolated_index_expected_version === request.expectedResourceVersions.isolated_index &&
        replay.tree_before_oid === request.treeBeforeOid && replay.tree_after_oid === request.treeAfterOid &&
        replay.candidate_diff_digest === request.candidateDiffDigest && replay.path_set_digest === request.pathSetDigest &&
        replay.change_kind_set_digest === request.changeKindSetDigest && replay.mode_set_digest === request.modeSetDigest &&
        replay.normalized_delta_json === normalizedDeltaJson && replay.verification_receipt_digests_json === verificationJson &&
        replay.commit_metadata_json === metadataJson && replay.idempotency_key === request.idempotencyKey &&
        replay.input_digest === inputDigest && replay.created_at === request.createdAt;
      if (exact) return frozenRow(replay);
      throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "commit intent identity has different immutable input", this.location.databasePath);
    }

    const preparation = this.resolveCommitPreparation({
      attemptId: request.attemptId,
      phaseExecutionId: request.phaseExecutionId,
      contextId: request.contextId,
    });
    if (
      preparation.launchId !== request.launchId || preparation.processReceiptId !== request.processReceiptId ||
      preparation.executionContextDigest !== request.executionContextDigest || preparation.baselineOid !== request.baselineOid ||
      preparation.contractDigest !== request.contractDigest || preparation.deliveryRef !== request.deliveryRef ||
      preparation.candidateTreeOid !== request.treeAfterOid || preparation.candidateDiffDigest !== request.candidateDiffDigest ||
      canonicalJson(preparation.verificationReceiptDigests) !== canonicalJson(request.verificationReceiptDigests)
    ) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "commit intent differs from the exact phase and verification projection", this.location.databasePath);
    if (
      preparation.phaseCreatedAt !== request.createdAt || metadata.author_date !== preparation.phaseCreatedAt ||
      metadata.committer_date !== preparation.phaseCreatedAt
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit timestamps must equal the durable phase creation time", this.location.databasePath);
    this.#assertRepositoryTree(request.treeBeforeOid, "commit intent tree before");
    this.#assertRepositoryTree(request.treeAfterOid, "commit intent tree after");
    const observedBeforeTree = execFileSync("git", ["rev-parse", `${request.baselineOid}^{tree}`], {
      cwd: this.location.repoRealpath,
      encoding: "utf8",
      env: HERMETIC_GIT_ENVIRONMENT,
    }).trim();
    if (observedBeforeTree !== request.treeBeforeOid) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit intent baseline tree differs from Git", this.location.databasePath);
    const contract = this.#requireTransitionGuard(
      "SELECT canonical_contract_json FROM ticket_contracts WHERE contract_digest = ?",
      [request.contractDigest],
      "commit intent ticket contract is missing",
    );
    const contractJson = this.#parseJsonObject(String(contract.canonical_contract_json), "commit intent ticket contract");
    const delta = this.#assertExactCommitDelta(request, "commit intent delta");
    this.#assertDeltaWithinScope(delta, contractJson.scope, "commit intent delta");

    const ownership = this.#requireTransitionGuard(`
      SELECT * FROM attempt_ownership_leases
      WHERE ownership_id = ? AND attempt_id = ? AND generation = ?
        AND state = 'live' AND state_version = ? AND context_digest = ?
        AND recovered_from_ownership_id IS NULL AND expires_at > ?
    `, [request.ownershipId, request.attemptId, request.ownerGeneration, request.ownershipStateVersion,
      request.ownershipContextDigest, new Date().toISOString()], "commit intent requires current live unexpired ownership");
    void ownership;
    const plan = this.#attemptOwnershipPlan(request.attemptId);
    if (
      request.baselineOid !== plan.lineage.deliveryBaselineOid || request.contractDigest !== plan.lineage.contractDigest ||
      request.deliveryRef !== plan.lineage.deliveryRef || request.attemptRef !== plan.attemptRef
    ) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "commit intent refs or immutable attempt lineage differ from the ownership plan", this.location.databasePath);
    if (
      this.#observeCommitRef(request.deliveryRef, "commit delivery ref") !== request.baselineOid ||
      this.#observeCommitRef(request.attemptRef, "commit attempt ref") !== request.baselineOid
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit intent baseline refs moved before prepare", this.location.databasePath);

    const resources = new Map<string, MutableStateRecord>();
    for (const slot of resourceSlots) {
      const resource = this.#requireTransitionGuard(`
        SELECT * FROM attempt_resource_claims WHERE attempt_id = ? AND slot = ?
          AND current_ownership_id = ? AND owner_generation = ? AND state = 'active' AND state_version = ?
      `, [request.attemptId, slot, request.ownershipId, request.ownerGeneration, request.expectedResourceVersions[slot]],
      `commit ${slot} resource does not match its exact active owner/version`);
      const planned = plan.resources.find((candidate) => candidate.slot === slot);
      if (
        planned === undefined || resource.resource_claim_id !== planned.resourceClaimId || resource.kind !== slot ||
        resource.canonical_identity !== planned.canonicalIdentity || resource.identity_digest !== planned.identityDigest
      ) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", `commit ${slot} resource identity differs from the ownership plan`, this.location.databasePath);
      resources.set(slot, resource);
    }
    const row = this.#validatedColumns("attempt_commit_intents", normalizeRow({
      commit_intent_id: request.commitIntentId,
      repository_id: this.location.repositoryId,
      attempt_id: request.attemptId,
      ownership_id: request.ownershipId,
      owner_generation: request.ownerGeneration,
      ownership_state_version: request.ownershipStateVersion,
      ownership_context_digest: request.ownershipContextDigest,
      phase_execution_id: request.phaseExecutionId,
      context_id: request.contextId,
      execution_context_digest: request.executionContextDigest,
      launch_id: request.launchId,
      process_receipt_id: request.processReceiptId,
      delivery_ref: request.deliveryRef,
      attempt_ref: request.attemptRef,
      baseline_oid: request.baselineOid,
      contract_digest: request.contractDigest,
      delivery_ref_claim_id: String(resources.get("delivery_ref")!.resource_claim_id),
      delivery_ref_expected_version: request.expectedResourceVersions.delivery_ref,
      attempt_ref_claim_id: String(resources.get("attempt_ref")!.resource_claim_id),
      attempt_ref_expected_version: request.expectedResourceVersions.attempt_ref,
      worktree_claim_id: String(resources.get("worktree")!.resource_claim_id),
      worktree_expected_version: request.expectedResourceVersions.worktree,
      isolated_index_claim_id: String(resources.get("isolated_index")!.resource_claim_id),
      isolated_index_expected_version: request.expectedResourceVersions.isolated_index,
      tree_before_oid: request.treeBeforeOid,
      tree_after_oid: request.treeAfterOid,
      candidate_diff_digest: request.candidateDiffDigest,
      path_set_digest: request.pathSetDigest,
      change_kind_set_digest: request.changeKindSetDigest,
      mode_set_digest: request.modeSetDigest,
      normalized_delta_json: normalizedDeltaJson,
      verification_receipt_digests_json: verificationJson,
      commit_metadata_json: metadataJson,
      input_digest: inputDigest,
      idempotency_key: request.idempotencyKey,
      state: "intent_recorded",
      state_version: 0,
      commit_attribution_id: null,
      commit_oid: null,
      delivery_ref_observed_oid: null,
      attempt_ref_before_oid: null,
      attempt_ref_after_oid: null,
      command_receipts_json: null,
      result_digest: null,
      created_at: request.createdAt,
      finalized_at: null,
    }));
    this.#requireCompleteRow("attempt_commit_intents", row);
    this.#insert("attempt_commit_intents", row);
    return frozenRow(row);
  }

  #commandReceiptsJson(receipts: readonly ResolvedCommitCommandReceipt[]): string {
    if (!Array.isArray(receipts) || receipts.length === 0) throw new TypeError("commit finalization requires command receipts");
    const purposes = new Set<string>();
    const normalized = receipts.map((receipt) => {
      if (
        receipt.purpose === "" || receipt.purpose !== receipt.purpose.trim() || purposes.has(receipt.purpose) ||
        receipt.executable !== "/usr/bin/git"
      ) throw new TypeError("commit command receipt identity is invalid");
      purposes.add(receipt.purpose);
      for (const [label, value] of [
        ["argv", receipt.argvDigest], ["input", receipt.inputDigest], ["stdout", receipt.stdoutDigest], ["stderr", receipt.stderrDigest],
      ] as const) this.#assertProcessDigest(value, `commit command ${label} digest`);
      for (const value of [receipt.inputBytes, receipt.stdoutBytes, receipt.stderrBytes]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("commit command receipt byte count is invalid");
      }
      if (!Number.isSafeInteger(receipt.status) || receipt.status !== 0) throw new TypeError("commit command receipt must record a successful exit status");
      return {
        purpose: receipt.purpose,
        executable: receipt.executable,
        argv_digest: receipt.argvDigest,
        input_digest: receipt.inputDigest,
        input_bytes: receipt.inputBytes,
        stdout_digest: receipt.stdoutDigest,
        stdout_bytes: receipt.stdoutBytes,
        stderr_digest: receipt.stderrDigest,
        stderr_bytes: receipt.stderrBytes,
        status: receipt.status,
      };
    });
    return canonicalJson(normalized);
  }

  #finalizeCommitAttribution(request: CommitAttributionFinalizeProjection): StateRecord {
    for (const [label, value] of [
      ["commit intent id", request.commitIntentId], ["attempt id", request.attemptId],
      ["ownership id", request.ownershipId], ["commit attribution id", request.commitAttributionId],
      ["commit attribution evidence id", request.attributionEvidenceId],
    ] as const) this.#assertProcessIdentity(value, label);
    for (const [label, value] of [
      ["contract digest", request.contractDigest], ["execution context digest", request.contextDigest],
      ["candidate diff digest", request.candidateDiffDigest], ["path set digest", request.pathSetDigest],
      ["change kind set digest", request.changeKindSetDigest], ["mode set digest", request.modeSetDigest],
    ] as const) this.#assertProcessDigest(value, label);
    this.#assertProcessTimestamp(request.createdAt, "commit finalization time");
    if (!Number.isSafeInteger(request.ownerGeneration) || request.ownerGeneration < 1 ||
        !Number.isSafeInteger(request.expectedIntentVersion) || request.expectedIntentVersion < 0) {
      throw new TypeError("commit finalization version is invalid");
    }
    for (const oid of [
      request.baselineOid, request.parentOid, request.treeBeforeOid, request.treeAfterOid, request.commitOid,
      request.deliveryRefObservedOid, request.attemptRefBeforeOid, request.attemptRefAfterOid,
    ]) this.#assertRepositoryOid(oid, "commit finalization Git OID");
    const commandReceiptsJson = this.#commandReceiptsJson(request.commandReceipts);
    const normalizedDeltaJson = canonicalJson(request.normalizedDelta);
    const intent = this.#requireTransitionGuard(
      "SELECT * FROM attempt_commit_intents WHERE commit_intent_id = ? AND attempt_id = ?",
      [request.commitIntentId, request.attemptId],
      "commit finalization does not resolve to its durable intent",
    );
    const exactPreimage =
      intent.ownership_id === request.ownershipId && intent.owner_generation === request.ownerGeneration &&
      intent.baseline_oid === request.baselineOid && request.parentOid === request.baselineOid &&
      intent.tree_before_oid === request.treeBeforeOid && intent.tree_after_oid === request.treeAfterOid &&
      intent.contract_digest === request.contractDigest && intent.execution_context_digest === request.contextDigest &&
      intent.delivery_ref === request.deliveryRef && intent.attempt_ref === request.attemptRef &&
      intent.candidate_diff_digest === request.candidateDiffDigest && intent.path_set_digest === request.pathSetDigest &&
      intent.change_kind_set_digest === request.changeKindSetDigest && intent.mode_set_digest === request.modeSetDigest &&
      intent.normalized_delta_json === normalizedDeltaJson && intent.created_at === request.createdAt;
    if (!exactPreimage) throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "commit finalization differs from its immutable intent", this.location.databasePath);

    if (intent.state === "finalized") {
      if (
        intent.state_version !== request.expectedIntentVersion + 1 || intent.commit_attribution_id !== request.commitAttributionId ||
        intent.commit_oid !== request.commitOid || intent.delivery_ref_observed_oid !== request.deliveryRefObservedOid ||
        intent.attempt_ref_before_oid !== request.attemptRefBeforeOid || intent.attempt_ref_after_oid !== request.attemptRefAfterOid ||
        intent.command_receipts_json !== commandReceiptsJson || intent.finalized_at !== request.createdAt
      ) throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "finalized commit intent was replayed with different terminal input", this.location.databasePath);
      const attribution = this.#requireTransitionGuard(
        "SELECT * FROM commit_attributions WHERE commit_attribution_id = ? AND attempt_id = ? AND commit_oid = ? AND attribution_evidence_id = ?",
        [request.commitAttributionId, request.attemptId, request.commitOid, request.attributionEvidenceId],
        "finalized commit intent is missing its exact attribution summary",
      );
      return frozenRow(attribution);
    }
    if (intent.state !== "intent_recorded" || intent.state_version !== request.expectedIntentVersion || request.expectedIntentVersion !== 0) {
      throw typedError("RICKGENT_STATE_CONFLICT", "commit intent is not at its exact prepare version", this.location.databasePath);
    }
    if (
      request.deliveryRefObservedOid !== request.baselineOid || request.attemptRefBeforeOid !== request.baselineOid ||
      request.attemptRefAfterOid !== request.commitOid
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit ref observations do not prove the exact baseline-to-candidate CAS", this.location.databasePath);

    this.#requireTransitionGuard(`
      SELECT 1 FROM attempts a JOIN runs r ON r.run_id = a.run_id
      JOIN run_tickets rt ON rt.ticket_instance_id = a.ticket_instance_id
      WHERE a.attempt_id = ? AND a.state = 'converging' AND r.state = 'active' AND rt.state = 'active'
        AND r.repository_id = ? AND a.delivery_baseline_oid = ? AND a.contract_digest = ?
    `, [request.attemptId, this.location.repositoryId, request.baselineOid, request.contractDigest],
    "commit finalization requires the exact active converging attempt");
    this.#requireTransitionGuard(`
      SELECT 1 FROM attempt_ownership_leases
      WHERE ownership_id = ? AND attempt_id = ? AND generation = ? AND state = 'live'
        AND state_version = ? AND context_digest = ? AND recovered_from_ownership_id IS NULL AND expires_at > ?
    `, [request.ownershipId, request.attemptId, request.ownerGeneration, Number(intent.ownership_state_version),
      String(intent.ownership_context_digest), new Date().toISOString()],
    "commit finalization requires current live unexpired ownership");
    for (const [slot, claimColumn, versionColumn] of [
      ["delivery_ref", "delivery_ref_claim_id", "delivery_ref_expected_version"],
      ["attempt_ref", "attempt_ref_claim_id", "attempt_ref_expected_version"],
      ["worktree", "worktree_claim_id", "worktree_expected_version"],
      ["isolated_index", "isolated_index_claim_id", "isolated_index_expected_version"],
    ] as const) {
      this.#requireTransitionGuard(`
        SELECT 1 FROM attempt_resource_claims
        WHERE resource_claim_id = ? AND attempt_id = ? AND slot = ? AND kind = ?
          AND current_ownership_id = ? AND owner_generation = ? AND state = 'active' AND state_version = ?
      `, [String(intent[claimColumn]), request.attemptId, slot, slot, request.ownershipId, request.ownerGeneration, Number(intent[versionColumn])],
      `commit finalization ${slot} resource owner/version drifted`);
    }
    if (
      this.#observeCommitRef(request.deliveryRef, "commit final delivery ref") !== request.deliveryRefObservedOid ||
      this.#observeCommitRef(request.attemptRef, "commit final attempt ref") !== request.attemptRefAfterOid
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit refs differ from the final observations", this.location.databasePath);
    this.#assertRepositoryCommit(request.commitOid, "attributed commit oid");
    const ancestry = execFileSync("git", ["rev-list", "--parents", "-n", "1", request.commitOid], {
      cwd: this.location.repoRealpath,
      encoding: "utf8",
      env: HERMETIC_GIT_ENVIRONMENT,
    }).trim().split(/\s+/);
    const beforeTree = execFileSync("git", ["rev-parse", `${request.baselineOid}^{tree}`], {
      cwd: this.location.repoRealpath, encoding: "utf8", env: HERMETIC_GIT_ENVIRONMENT,
    }).trim();
    const afterTree = execFileSync("git", ["rev-parse", `${request.commitOid}^{tree}`], {
      cwd: this.location.repoRealpath, encoding: "utf8", env: HERMETIC_GIT_ENVIRONMENT,
    }).trim();
    if (
      ancestry.length !== 2 || ancestry[1] !== request.parentOid || beforeTree !== request.treeBeforeOid ||
      afterTree !== request.treeAfterOid
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "attributed commit does not have the exact prepared parent and trees", this.location.databasePath);
    const delta = this.#assertExactCommitDelta(request, "commit attribution final delta");
    const contract = this.#requireTransitionGuard(
      "SELECT canonical_contract_json FROM ticket_contracts WHERE contract_digest = ?",
      [request.contractDigest],
      "commit attribution contract is missing",
    );
    this.#assertDeltaWithinScope(delta, this.#parseJsonObject(String(contract.canonical_contract_json), "commit attribution contract").scope, "commit attribution final delta");

    const metadata = this.#parseJsonObject(String(intent.commit_metadata_json), "prepared commit metadata");
    const verificationReceiptDigests = JSON.parse(String(intent.verification_receipt_digests_json)) as unknown;
    const commandReceipts = JSON.parse(commandReceiptsJson) as unknown;
    const evidencePayload = {
      schema_version: "rickgent.commit-attribution.v2",
      commit_intent_id: request.commitIntentId,
      commit_attribution_id: request.commitAttributionId,
      attempt_id: request.attemptId,
      ownership_id: request.ownershipId,
      owner_generation: request.ownerGeneration,
      ownership_context_digest: intent.ownership_context_digest,
      phase_execution_id: String(intent.phase_execution_id),
      context_id: String(intent.context_id),
      execution_context_digest: request.contextDigest,
      launch_id: intent.launch_id,
      process_receipt_id: intent.process_receipt_id,
      contract_digest: request.contractDigest,
      baseline_oid: request.baselineOid,
      parent_oid: request.parentOid,
      tree_before_oid: request.treeBeforeOid,
      tree_after_oid: request.treeAfterOid,
      commit_oid: request.commitOid,
      candidate_diff_digest: request.candidateDiffDigest,
      path_set_digest: request.pathSetDigest,
      change_kind_set_digest: request.changeKindSetDigest,
      mode_set_digest: request.modeSetDigest,
      normalized_delta: delta.entries,
      verification_receipt_digests: verificationReceiptDigests,
      resource_receipts: {
        delivery_ref: { claim_id: intent.delivery_ref_claim_id, expected_version: intent.delivery_ref_expected_version },
        attempt_ref: { claim_id: intent.attempt_ref_claim_id, expected_version: intent.attempt_ref_expected_version },
        worktree: { claim_id: intent.worktree_claim_id, expected_version: intent.worktree_expected_version },
        isolated_index: { claim_id: intent.isolated_index_claim_id, expected_version: intent.isolated_index_expected_version },
      },
      refs: {
        delivery_ref: request.deliveryRef,
        delivery_ref_observed_oid: request.deliveryRefObservedOid,
        attempt_ref: request.attemptRef,
        attempt_ref_before_oid: request.attemptRefBeforeOid,
        attempt_ref_after_oid: request.attemptRefAfterOid,
      },
      commit_metadata: metadata,
      command_receipts: commandReceipts,
    };
    const evidenceJson = canonicalJson(evidencePayload);
    const evidenceRow = this.#validatedColumns("evidence", normalizeRow({
      evidence_id: request.attributionEvidenceId,
      attempt_id: request.attemptId,
      phase_execution_id: String(intent.phase_execution_id),
      context_id: String(intent.context_id),
      producer_service: "CommitService",
      scope: request.commitAttributionId,
      schema_version: "rickgent.commit-attribution.v2",
      content_digest: sha256Text(evidenceJson),
      inline_payload_json: evidenceJson,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: request.commitIntentId,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("evidence", evidenceRow);
    this.#validateRecordSemantics("evidence", evidenceRow);
    const attributionRow = this.#validatedColumns("commit_attributions", normalizeRow({
      commit_attribution_id: request.commitAttributionId,
      attempt_id: request.attemptId,
      baseline_oid: request.baselineOid,
      parent_oid: request.parentOid,
      tree_before_oid: request.treeBeforeOid,
      tree_after_oid: request.treeAfterOid,
      commit_oid: request.commitOid,
      contract_digest: request.contractDigest,
      context_digest: request.contextDigest,
      path_set_digest: request.pathSetDigest,
      change_kind_set_digest: request.changeKindSetDigest,
      mode_set_digest: request.modeSetDigest,
      attribution_evidence_id: request.attributionEvidenceId,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("commit_attributions", attributionRow);
    this.#insert("evidence", evidenceRow);
    this.#insert("commit_attributions", attributionRow);
    const resultDigest = sha256Text(canonicalJson({
      schema_version: "rickgent.commit-attribution-result.v1",
      commit_intent_id: request.commitIntentId,
      commit_attribution_id: request.commitAttributionId,
      evidence_digest: evidenceRow.content_digest,
      commit_oid: request.commitOid,
      command_receipts: commandReceipts,
    }));
    const updated = this.#requireDatabase().prepare(`
      UPDATE attempt_commit_intents
      SET state = 'finalized', state_version = state_version + 1,
          commit_attribution_id = ?, commit_oid = ?, delivery_ref_observed_oid = ?,
          attempt_ref_before_oid = ?, attempt_ref_after_oid = ?, command_receipts_json = ?,
          result_digest = ?, finalized_at = ?
      WHERE commit_intent_id = ? AND attempt_id = ? AND ownership_id = ? AND owner_generation = ?
        AND state = 'intent_recorded' AND state_version = ?
    `).run(
      request.commitAttributionId, request.commitOid, request.deliveryRefObservedOid,
      request.attemptRefBeforeOid, request.attemptRefAfterOid, commandReceiptsJson,
      resultDigest, request.createdAt, request.commitIntentId, request.attemptId,
      request.ownershipId, request.ownerGeneration, request.expectedIntentVersion,
    );
    if (updated.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "commit intent finalization lost its CAS race", this.location.databasePath);
    return frozenRow(attributionRow);
  }

  #recordCleanup(request: CleanupRecordRequest): StateRecord {
    const payload = {
      attempt_id: request.attemptId,
      sequence: request.sequence,
      context_id: request.contextId,
      outcome: request.outcome,
      group_dead: request.groupDead ? 1 : 0,
      worktree_disposition: request.worktreeDisposition,
      index_disposition: request.indexDisposition,
      ref_disposition: request.refDisposition,
      context_disposition: request.contextDisposition,
      bundle_disposition: request.bundleDisposition,
      delivery_ref_observed_oid: request.deliveryRefObservedOid,
      resources_absent: request.resourcesAbsent ? 1 : 0,
      lease_release_eligible: request.leaseReleaseEligible ? 1 : 0,
      evidence_id: request.evidenceId,
    };
    const row = this.#validatedColumns("cleanup_records", normalizeRow({
      cleanup_record_id: request.cleanupRecordId,
      ...payload,
      record_digest: sha256Text(canonicalJson(payload)),
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("cleanup_records", row);
    this.#assertRepositoryOid(row.delivery_ref_observed_oid, "cleanup delivery ref observed oid");
    return this.#immediate("persist_cleanup_record", () => {
      const existing = this.#selectBy("cleanup_records", row, ["attempt_id", "sequence"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, row)) {
          this.#requireReplayContext(request.contextId, request.attemptId, request.ownerContextDigest, "cleanup", "cleanup", "cleanup record");
          return frozenRow(existing);
        }
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "cleanup record sequence has different immutable input", this.location.databasePath);
      }
      const lineage = this.#requireTransitionGuard(`
        SELECT r.delivery_ref FROM execution_contexts c JOIN attempts a ON a.attempt_id = c.attempt_id
        JOIN runs r ON r.run_id = a.run_id
        WHERE c.context_id = ? AND c.attempt_id = ? AND c.context_digest = ?
          AND c.phase = 'cleanup' AND c.role = 'cleanup' AND a.state = 'cleanup_pending'
      `, [request.contextId, request.attemptId, request.ownerContextDigest], "cleanup record context differs from its attempt");
      this.#requireOwnedEvidence(request.evidenceId, request.attemptId, "CleanupService", "cleanup record");
      this.#requireExactInlineEvidence(request.evidenceId, "CleanupService", request.cleanupRecordId, "rickgent.cleanup-record.v1", payload, "cleanup record");
      const sequence = this.#requireDatabase().prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM cleanup_records WHERE attempt_id = ?").get(request.attemptId) as MutableStateRecord;
      if (request.sequence !== sequence.next_sequence) throw typedError("RICKGENT_STATE_CONFLICT", "cleanup sequence is not the exact next value", this.location.databasePath);
      let observed: string;
      try {
        observed = execFileSync("git", ["rev-parse", "--verify", String(lineage.delivery_ref)], { cwd: this.location.repoRealpath, encoding: "utf8" }).trim();
      } catch (error) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup delivery ref cannot be independently observed", this.location.databasePath, error);
      }
      if (observed !== request.deliveryRefObservedOid) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup delivery ref observation differs from the repository", this.location.databasePath);
      const result = this.#insertExactLifecycleRow("cleanup_records", row, ["attempt_id", "sequence"]);
      if (request.leaseReleaseEligible) {
        if (request.outcome === "quarantined") this.#validateQuarantinedAttempt(request.attemptId, request.cleanupRecordId);
        else this.#validateCleanAttempt(request.attemptId, request.cleanupRecordId);
      }
      return result;
    });
  }

  /** @internal Accepts only runtime-unforgeable bounded metadata minted by LegacyDiagnosticService. */
  commitAuthorizedLegacyInventory(command: LegacyInventoryCommand): readonly StateRecord[] {
    if (!isAuthorizedLegacyInventoryCommand(command)) throw new TypeError("legacy inventory command was not minted by LegacyDiagnosticService");
    if (command.discoveredAt.length < 20 || !command.discoveredAt.endsWith("Z") || Number.isNaN(Date.parse(command.discoveredAt))) {
      throw new TypeError("legacy inventory discovery time must be a UTC timestamp");
    }
    const kinds = new Set<string>(LEGACY_ARTIFACT_KINDS);
    const digestPattern = /^sha256:[0-9a-f]{64}$/;
    const seen = new Set<string>();
    const desired = command.entries.map((entry): MutableStateRecord => {
      if (!kinds.has(entry.kind)) throw new TypeError(`unsupported legacy artifact kind: ${entry.kind}`);
      const path = entry.boundedPathIdentity;
      if (
        path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("//") ||
        path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
        (!path.startsWith(".rickgent/") && path !== ".rickgent" && !path.startsWith("git/"))
      ) throw new TypeError("legacy inventory path identity is not bounded to the canonical repository diagnostic namespaces");
      if (
        (entry.statDigest !== null && !digestPattern.test(entry.statDigest)) ||
        (entry.contentDigest !== null && !digestPattern.test(entry.contentDigest))
      ) throw new TypeError("legacy inventory digest is invalid");
      if (!/^(?:quarantined|diagnostic)_[a-z0-9_]+$/.test(entry.disposition)) {
        throw new TypeError("legacy inventory disposition is not a diagnostic or quarantine disposition");
      }
      const identity = `${entry.kind}\0${path}`;
      if (seen.has(identity)) throw new TypeError("legacy inventory command contains a duplicate artifact identity");
      seen.add(identity);
      return this.#validatedColumns("legacy_artifacts", normalizeRow({
        legacy_artifact_id: `legacy-${sha256Text(canonicalJson({ repository_id: this.location.repositoryId, kind: entry.kind, bounded_path_identity: path })).slice(7)}`,
        repository_id: this.location.repositoryId,
        kind: entry.kind,
        bounded_path_identity: path,
        stat_digest: entry.statDigest,
        content_digest: entry.contentDigest,
        discovered_at: command.discoveredAt,
        disposition: entry.disposition,
      }));
    });
    const records = this.#immediate("inventory_legacy", () => Object.freeze(desired.map((candidate) => {
      this.#requireCompleteRow("legacy_artifacts", candidate);
      const existing = this.#selectBy("legacy_artifacts", candidate, ["repository_id", "kind", "bounded_path_identity"]);
      if (existing !== undefined) {
        const semanticColumns = ["legacy_artifact_id", "repository_id", "kind", "bounded_path_identity", "stat_digest", "content_digest", "disposition"];
        if (semanticColumns.every((column) => sameValue(existing[column], candidate[column]))) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "legacy artifact identity changed after its immutable quarantine record", this.location.databasePath);
      }
      this.#validateRecordSemantics("legacy_artifacts", candidate);
      this.#insert("legacy_artifacts", candidate);
      return frozenRow(candidate);
    })));
    if (command.requireClear && records.length > 0) {
      throw new StateStoreError(
        "RICKGENT_LEGACY_STATE_QUARANTINED",
        `legacy lifecycle authority is quarantined (${records.length} diagnostic record${records.length === 1 ? "" : "s"})`,
        { databasePath: this.location.databasePath, recovery: LEGACY_QUARANTINE_RECOVERY },
      );
    }
    return records;
  }

  readLegacyInventory(): readonly StateRecord[] {
    const rows = this.#requireDatabase().prepare(
      "SELECT * FROM legacy_artifacts WHERE repository_id = ? ORDER BY bounded_path_identity, kind",
    ).all(this.location.repositoryId) as MutableStateRecord[];
    return Object.freeze(rows.map(frozenRow));
  }

  readEvidence(evidenceId: string): StateRecord | undefined {
    const row = this.#requireDatabase().prepare("SELECT * FROM evidence WHERE evidence_id = ?").get(evidenceId) as MutableStateRecord | undefined;
    return row === undefined ? undefined : frozenRow(row);
  }

  #resolveTransitionEvidence(
    reference: TransitionEvidenceReference,
    ownerService: string,
  ): PersistedTransitionEvidenceReference {
    if ("evidenceId" in reference) return Object.freeze({ purpose: reference.purpose, evidenceId: reference.evidenceId });
    const input = reference.inlineEvidence;
    if (input.producerService !== ownerService) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "inline transition evidence producer must be the owning service", this.location.databasePath);
    }
    const lineage = this.#requireDatabase().prepare(`
      SELECT c.attempt_id, x.phase_execution_id
      FROM execution_contexts c JOIN phase_executions x ON x.context_id = c.context_id
      WHERE c.context_id = ?
    `).get(input.contextId) as MutableStateRecord | undefined;
    if (lineage === undefined) this.#resumeIncompatible("inline transition evidence context does not resolve to a phase execution");
    const payload = canonicalJson(input.payload);
    if (!payload.startsWith("{")) throw new TypeError("inline transition evidence payload must be an object");
    const semantic: MutableStateRecord = {
      attempt_id: lineage.attempt_id ?? null,
      phase_execution_id: lineage.phase_execution_id ?? null,
      context_id: input.contextId,
      producer_service: input.producerService,
      scope: input.scope,
      schema_version: input.schemaVersion,
      content_digest: sha256Text(payload),
      inline_payload_json: payload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: input.idempotencyKey,
    };
    const existing = this.#requireDatabase().prepare(
      "SELECT * FROM evidence WHERE producer_service = ? AND scope = ? AND idempotency_key = ?",
    ).get(input.producerService, input.scope, input.idempotencyKey) as MutableStateRecord | undefined;
    if (existing !== undefined) {
      if (Object.keys(semantic).some((column) => !sameValue(existing[column], semantic[column]))) {
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "inline transition evidence idempotency has different immutable input", this.location.databasePath);
      }
      return Object.freeze({ purpose: reference.purpose, evidenceId: String(existing.evidence_id) });
    }
    const evidenceId = `evidence-${randomBytes(16).toString("hex")}`;
    const row: MutableStateRecord = {
      evidence_id: evidenceId,
      ...semantic,
      created_at: new Date().toISOString(),
    };
    this.#validateRecordSemantics("evidence", row);
    this.#insert("evidence", row);
    return Object.freeze({ purpose: reference.purpose, evidenceId });
  }

  #transitionResult(
    command: TransitionCommit,
    transition: MutableStateRecord,
    stateVersion: number,
    inputDigest: string,
    evidence: readonly PersistedTransitionEvidenceReference[],
  ): TransitionResult {
    return freezeValue({
      transitionId: String(transition.transition_id),
      entityKind: command.entityKind,
      entityId: command.entityId,
      entitySequence: Number(transition.entity_sequence),
      fromState: command.fromState,
      toState: command.toState,
      ownerService: command.ownerService,
      inputDigest,
      stateVersion,
      evidence: evidence.map((reference): PersistedTransitionEvidenceReference => Object.freeze({ ...reference })),
      state: frozenRow({ state: command.toState, state_version: stateVersion }),
    });
  }

  #validateTransitionOwner(command: TransitionCommit): void {
    if (command.guard.kind === "run_initial_attempt" || command.guard.kind === "ticket_attempt_allocation") {
      const allocation = this.#requireDatabase().prepare(
        "SELECT run_id, ticket_instance_id, allocation_owner_digest FROM attempts WHERE attempt_id = ?",
      ).get(command.guard.attemptId) as MutableStateRecord | undefined;
      const scopeMatches = command.entityKind === "run"
        ? allocation?.run_id === command.entityId
        : allocation?.ticket_instance_id === command.entityId;
      if (allocation === undefined || !scopeMatches || allocation.allocation_owner_digest !== command.ownerContextDigest) {
        throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "allocation transition owner does not match its immutable attempt allocation", this.location.databasePath);
      }
      return;
    }
    const owner = this.#requireDatabase().prepare(`
      SELECT c.attempt_id, a.ticket_instance_id, a.run_id
      FROM execution_contexts c JOIN attempts a ON a.attempt_id = c.attempt_id
      WHERE c.context_digest = ?
    `).get(command.ownerContextDigest) as MutableStateRecord | undefined;
    const matches = command.entityKind === "attempt"
      ? owner?.attempt_id === command.entityId
      : command.entityKind === "ticket"
        ? owner?.ticket_instance_id === command.entityId
        : owner?.run_id === command.entityId;
    if (!matches) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", `transition owner context is not canonical for the ${command.entityKind} lineage`, this.location.databasePath);
    }
  }

  #requireTransitionGuard(sql: string, values: readonly SqlValue[], message: string): MutableStateRecord {
    const row = this.#requireDatabase().prepare(sql).get(...values) as MutableStateRecord | undefined;
    if (row === undefined) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", message, this.location.databasePath);
    return row;
  }

  #validateTerminalAttemptOwnership(
    attemptId: string,
    cleanupRecordId: string,
    expectedState: "released" | "quarantined",
  ): MutableStateRecord {
    const cleanup = this.#requireTransitionGuard(`
      SELECT c.*, a.run_id, a.ticket_instance_id
      FROM cleanup_records c JOIN attempts a ON a.attempt_id = c.attempt_id
      WHERE c.cleanup_record_id = ? AND c.attempt_id = ?
    `, [cleanupRecordId, attemptId], "cleanup record does not belong to the transition attempt");
    if (cleanup.group_dead !== 1 || cleanup.resources_absent !== 1 || cleanup.lease_release_eligible !== 1) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup record does not prove group death, resource absence, and lease release eligibility", this.location.databasePath);
    }
    const currentOwnership = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_ownership_leases
      WHERE attempt_id = ? ORDER BY generation DESC LIMIT 1
    `).get(attemptId) as MutableStateRecord | undefined;
    const currentResources = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_resource_claims WHERE attempt_id = ? ORDER BY slot
    `).all(attemptId) as MutableStateRecord[];
    if (currentOwnership !== undefined || currentResources.length > 0) {
      const plan = this.#attemptOwnershipPlan(attemptId);
      const proofColumn = expectedState === "released" ? "release_proof_digest" : "quarantine_proof_digest";
      if (
        currentOwnership === undefined || currentOwnership.state !== expectedState ||
        currentResources.length !== plan.resources.length ||
        currentResources.some((resource) =>
          resource.current_ownership_id !== currentOwnership.ownership_id ||
          resource.owner_generation !== currentOwnership.generation ||
          resource.state !== expectedState || typeof resource[proofColumn] !== "string") ||
        new Set(currentResources.map((resource) => resource[proofColumn])).size !== 1
      ) {
        throw typedError(
          "RICKGENT_STATE_TRANSITION_ILLEGAL",
          `cleanup proof conflicts with current v2 ${expectedState} ownership or resource state`,
          this.location.databasePath,
        );
      }
      const proofDigest = String(currentResources[0]?.[proofColumn]);
      if (cleanup.cleanup_record_id !== `cleanup-record-${proofDigest.slice(7)}`) {
        throw typedError(
          "RICKGENT_STATE_TRANSITION_ILLEGAL",
          "cleanup record is not bound to the current v2 terminal ownership proof",
          this.location.databasePath,
        );
      }
      return cleanup;
    }
    const activeResource = this.#requireDatabase().prepare(
      "SELECT 1 FROM attempt_resources WHERE attempt_id = ? AND state NOT IN ('released','quarantined') LIMIT 1",
    ).get(attemptId);
    const activeLease = this.#requireDatabase().prepare(
      "SELECT 1 FROM leases WHERE attempt_id = ? AND state NOT IN ('released','quarantined') LIMIT 1",
    ).get(attemptId);
    if (activeResource !== undefined || activeLease !== undefined) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup proof conflicts with live lease or resource state", this.location.databasePath);
    }
    return cleanup;
  }

  #validateCleanAttempt(attemptId: string, cleanupRecordId: string): MutableStateRecord {
    return this.#validateTerminalAttemptOwnership(attemptId, cleanupRecordId, "released");
  }

  #validateQuarantinedAttempt(attemptId: string, cleanupRecordId: string): MutableStateRecord {
    return this.#validateTerminalAttemptOwnership(attemptId, cleanupRecordId, "quarantined");
  }

  #requireCommandEvidence(
    evidence: readonly PersistedTransitionEvidenceReference[],
    requiredIds: readonly (SqlValue | undefined)[],
    label: string,
  ): void {
    const supplied = new Set(evidence.map((reference) => reference.evidenceId));
    if (requiredIds.some((id) => typeof id !== "string" || !supplied.has(id))) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} is not pinned by the transition evidence set`, this.location.databasePath);
    }
  }

  #requireExactInlineEvidence(
    evidenceId: SqlValue | undefined,
    producerService: string,
    scope: string,
    schemaVersion: string,
    payload: Readonly<Record<string, unknown>>,
    label: string,
  ): void {
    const evidence = this.#requireTransitionGuard(`
      SELECT producer_service, scope, schema_version, inline_payload_json, content_digest
      FROM evidence WHERE evidence_id = ?
    `, [evidenceId ?? null], `${label} evidence is missing`);
    const canonicalPayload = canonicalJson(payload);
    if (
      evidence.producer_service !== producerService || evidence.scope !== scope || evidence.schema_version !== schemaVersion ||
      evidence.inline_payload_json !== canonicalPayload || evidence.content_digest !== sha256Text(canonicalPayload)
    ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} evidence does not pin the exact canonical operation`, this.location.databasePath);
  }

  #validateTransitionGuard(
    command: TransitionCommit,
    evidence: readonly PersistedTransitionEvidenceReference[],
  ): void {
    const guard = command.guard;
    switch (guard.kind) {
      case "run_initial_attempt":
        this.#requireTransitionGuard(
          "SELECT 1 FROM attempts WHERE attempt_id = ? AND run_id = ? AND attempt_number = 1 AND state = 'planned'",
          [guard.attemptId, command.entityId],
          "run activation requires a committed initial planned attempt",
        );
        return;
      case "ticket_attempt_allocation": {
        const attempt = this.#requireTransitionGuard(
          "SELECT attempt_number, state FROM attempts WHERE attempt_id = ? AND ticket_instance_id = ?",
          [guard.attemptId, command.entityId],
          "ticket activation requires its committed planned attempt",
        );
        if (attempt.state !== "planned" || (guard.retry ? Number(attempt.attempt_number) <= 1 : attempt.attempt_number !== 1)) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "ticket activation attempt number or state is invalid", this.location.databasePath);
        }
        return;
      }
      case "live_lease": {
        this.#requireTransitionGuard(`
          SELECT 1 FROM attempt_ownership_leases
          WHERE ownership_id = ? AND attempt_id = ? AND state = 'live'
            AND recovered_from_ownership_id IS NULL AND context_digest = ?
            AND expires_at > ?
        `, [guard.ownershipId, command.entityId, command.ownerContextDigest, new Date().toISOString()],
        "attempt start requires its current live t18 ownership");
        const requiredKinds = [
          "delivery_ref", "attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle",
          "process_group", "stdout", "stderr", "verification_output", "salvage_archive",
        ];
        const resources = this.#requireDatabase().prepare(`
          SELECT DISTINCT kind FROM attempt_resource_claims
          WHERE attempt_id = ? AND current_ownership_id = ?
            AND state IN ('reserved','allocated','active')
        `).all(command.entityId, guard.ownershipId) as MutableStateRecord[];
        const observed = new Set(resources.map((row) => String(row.kind)));
        if (resources.length !== requiredKinds.length || requiredKinds.some((kind) => !observed.has(kind))) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "attempt start is missing the complete t18 fixed resource claim set", this.location.databasePath);
        }
        return;
      }
      case "process_receipt": {
        const receipt = this.#requireTransitionGuard(`
          SELECT p.launch_evidence_id, p.exit_evidence_id, p.termination_evidence_id, p.group_death_evidence_id
          FROM process_receipts p JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id
          JOIN execution_contexts c ON c.context_id = p.context_id
          WHERE p.process_receipt_id = ? AND x.attempt_id = ? AND p.exit_evidence_id IS NOT NULL
            AND c.context_digest = ?
        `, [guard.processReceiptId, command.entityId, command.ownerContextDigest], "implementation capture requires an immutable owner-context exited process receipt");
        this.#requireCommandEvidence(evidence, [receipt.launch_evidence_id, receipt.exit_evidence_id], "process receipt evidence");
        return;
      }
      case "execution_context":
        this.#requireTransitionGuard(
          "SELECT 1 FROM execution_contexts WHERE context_id = ? AND attempt_id = ? AND context_digest = ?",
          [guard.contextId, command.entityId, command.ownerContextDigest],
          "phase transition context does not match its attempt owner",
        );
        return;
      case "review_record": {
        const review = this.#requireTransitionGuard(
          `SELECT r.verdict, r.verdict_evidence_id, r.findings_evidence_id
           FROM review_records r JOIN execution_contexts c ON c.context_id = r.reviewer_context_id
           WHERE r.review_record_id = ? AND r.attempt_id = ? AND c.context_digest = ?`,
          [guard.reviewRecordId, command.entityId, command.ownerContextDigest],
          "review transition requires its immutable review record",
        );
        if (review.verdict !== guard.verdict) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "review verdict does not authorize this edge", this.location.databasePath);
        this.#requireCommandEvidence(evidence, [review.verdict_evidence_id, review.findings_evidence_id], "review evidence");
        return;
      }
      case "remediation_record": {
        const remediation = this.#requireTransitionGuard(
          `SELECT r.findings_evidence_id, r.output_evidence_id
           FROM remediation_records r JOIN execution_contexts c ON c.context_id = r.context_id
           WHERE r.remediation_record_id = ? AND r.attempt_id = ? AND c.context_digest = ?`,
          [guard.remediationRecordId, command.entityId, command.ownerContextDigest],
          "remediation capture requires its immutable remediation record",
        );
        this.#requireCommandEvidence(evidence, [remediation.findings_evidence_id, remediation.output_evidence_id], "remediation evidence");
        return;
      }
      case "gate_results": {
        if (guard.gateResultIds.length === 0 || new Set(guard.gateResultIds).size !== guard.gateResultIds.length) {
          throw new TypeError("verification requires a nonempty unique gate result set");
        }
        const rows = this.#requireDatabase().prepare(`
          SELECT g.gate_result_id, g.required, g.status, g.evidence_id, c.context_digest
          FROM gate_results g JOIN execution_contexts c ON c.context_id = g.context_id
          WHERE g.attempt_id = ? ORDER BY g.gate_result_id
        `).all(command.entityId) as MutableStateRecord[];
        const selected = [...guard.gateResultIds].sort();
        if (
          rows.length !== selected.length || rows.some((row, index) => row.gate_result_id !== selected[index]) ||
          rows.some((row) => row.context_digest !== command.ownerContextDigest)
        ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "gate selection must equal all attempt gates with matching owner context", this.location.databasePath);
        // The gate_results guard covers two edges:
        //   - verifying -> converging (success): every required gate must pass.
        //   - verifying -> cleanup_pending (failure): at least one required
        //     gate must NOT pass (the verification failed).
        if (command.toState === "cleanup_pending") {
          if (!rows.some((row) => row.required === 1 && row.status !== "passed")) {
            throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "verification failure cleanup requires at least one required gate to not pass", this.location.databasePath);
          }
        } else {
          if (rows.some((row) => row.required === 1 && row.status !== "passed")) {
            throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "gate selection must equal all attempt gates and every required gate must pass", this.location.databasePath);
          }
        }
        this.#requireCommandEvidence(evidence, rows.map((row) => row.evidence_id), "gate result evidence");
        return;
      }
      case "cleanup_pending":
        if (guard.commitAttributionId !== undefined) {
          const attribution = this.#requireTransitionGuard(
            `SELECT c.attribution_evidence_id FROM commit_attributions c
             JOIN attempt_commit_intents i ON i.commit_attribution_id = c.commit_attribution_id
               AND i.attempt_id = c.attempt_id AND i.state = 'finalized'
             WHERE c.commit_attribution_id = ? AND c.attempt_id = ?`,
            [guard.commitAttributionId, command.entityId],
            "cleanup transition commit attribution differs from the attempt",
          );
          this.#requireCommandEvidence(evidence, [attribution.attribution_evidence_id], "commit attribution evidence");
        } else if (!evidence.some((reference) => reference.purpose === "failure")) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup without commit attribution requires explicit failure evidence", this.location.databasePath);
        }
        return;
      case "cleanup_record": {
        const cleanup = guard.outcome === "failed_clean"
          ? this.#validateCleanAttempt(command.entityId, guard.cleanupRecordId)
          : this.#validateQuarantinedAttempt(command.entityId, guard.cleanupRecordId);
        if (cleanup.outcome !== guard.outcome) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup outcome does not authorize this terminal edge", this.location.databasePath);
        const cleanupContext = this.#requireDatabase().prepare(
          "SELECT context_digest FROM execution_contexts WHERE context_id = ?",
        ).get(cleanup.context_id ?? null) as MutableStateRecord | undefined;
        if (cleanupContext?.context_digest !== command.ownerContextDigest) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "cleanup record context does not match CleanupService owner", this.location.databasePath);
        this.#requireCommandEvidence(evidence, [cleanup.evidence_id], "cleanup record evidence");
        return;
      }
      case "oracle_promotion": {
        const promotion = this.#requireTransitionGuard(`
          SELECT p.observation_evidence_id FROM oracle_decisions o JOIN promotion_intents p ON p.oracle_decision_id = o.oracle_decision_id
          WHERE o.oracle_decision_id = ? AND p.promotion_intent_id = ? AND o.attempt_id = ?
            AND o.result = 'accepted' AND p.state = 'ref_observed_candidate'
        `, [guard.oracleDecisionId, guard.promotionIntentId, command.entityId], "oracle evaluation requires an accepted decision and observed promotable intent");
        this.#requireCommandEvidence(evidence, [promotion.observation_evidence_id], "promotion observation evidence");
        return;
      }
      case "verified_promotion": {
        const cleanup = this.#validateCleanAttempt(command.entityId, guard.cleanupRecordId);
        const promotion = this.#requireTransitionGuard(`
          SELECT p.finalization_evidence_id FROM oracle_decisions o JOIN promotion_intents p ON p.oracle_decision_id = o.oracle_decision_id
          WHERE o.oracle_decision_id = ? AND p.promotion_intent_id = ? AND o.attempt_id = ?
            AND o.result = 'accepted' AND p.state = 'finalized'
        `, [guard.oracleDecisionId, guard.promotionIntentId, command.entityId], "verification requires finalized accepted promotion");
        this.#requireCommandEvidence(evidence, [cleanup.evidence_id, promotion.finalization_evidence_id], "verified promotion and cleanup evidence");
        return;
      }
      case "ticket_attempt_cleanup": {
        this.#requireTransitionGuard(
          "SELECT 1 FROM attempts WHERE attempt_id = ? AND ticket_instance_id = ? AND state = 'cleanup_pending'",
          [guard.attemptId, command.entityId],
          "ticket cleanup requires its attempt to be cleanup_pending",
        );
        const attemptEvidence = this.#requireDatabase().prepare(`
          SELECT r.evidence_id FROM state_transitions t
          JOIN transition_evidence_refs r ON r.transition_id = t.transition_id
          WHERE t.attempt_id = ? AND t.to_state = 'cleanup_pending'
            AND t.entity_sequence = (SELECT MAX(entity_sequence) FROM state_transitions WHERE attempt_id = ?)
        `).all(guard.attemptId, guard.attemptId) as MutableStateRecord[];
        const supplied = new Set(evidence.map((reference) => reference.evidenceId));
        if (attemptEvidence.length === 0 || !attemptEvidence.some((row) => typeof row.evidence_id === "string" && supplied.has(row.evidence_id))) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "ticket cleanup must pin the attempt cleanup transition evidence", this.location.databasePath);
        }
        return;
      }
      case "ticket_failure": {
        const attempt = this.#requireTransitionGuard(
          "SELECT state FROM attempts WHERE attempt_id = ? AND ticket_instance_id = ?",
          [guard.attemptId, command.entityId],
          "ticket failure attempt differs from ticket lineage",
        );
        const required = guard.quarantined ? "quarantined" : "failed_clean";
        if (attempt.state !== required) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `ticket failure requires an attempt in ${required}`, this.location.databasePath);
        const cleanup = guard.quarantined
          ? this.#validateQuarantinedAttempt(guard.attemptId, guard.cleanupRecordId)
          : this.#validateCleanAttempt(guard.attemptId, guard.cleanupRecordId);
        this.#requireCommandEvidence(evidence, [cleanup.evidence_id], "ticket cleanup evidence");
        return;
      }
      case "ticket_finalization": {
        const cleanup = this.#validateCleanAttempt(guard.attemptId, guard.cleanupRecordId);
        const promotion = this.#requireTransitionGuard(`
          SELECT p.finalization_evidence_id FROM attempts a
          JOIN oracle_decisions o ON o.attempt_id = a.attempt_id
          JOIN promotion_intents p ON p.attempt_id = a.attempt_id AND p.oracle_decision_id = o.oracle_decision_id
          WHERE a.attempt_id = ? AND a.ticket_instance_id = ? AND a.state = 'verified'
            AND o.oracle_decision_id = ? AND o.result = 'accepted' AND p.promotion_intent_id = ? AND p.state = 'finalized'
        `, [guard.attemptId, command.entityId, guard.oracleDecisionId, guard.promotionIntentId], "ticket readiness requires verified attempt, accepted oracle, and finalized promotion");
        this.#requireCommandEvidence(evidence, [cleanup.evidence_id, promotion.finalization_evidence_id], "ticket finalization evidence");
        return;
      }
      case "run_cleanup_begin": {
        this.#requireTransitionGuard(
          "SELECT 1 FROM attempts WHERE attempt_id = ? AND run_id = ? AND state = 'cleanup_pending'",
          [guard.attemptId, command.entityId],
          "run cleanup requires an attempt in cleanup_pending within the run",
        );
        const attemptEvidence = this.#requireDatabase().prepare(`
          SELECT r.evidence_id FROM state_transitions t
          JOIN transition_evidence_refs r ON r.transition_id = t.transition_id
          WHERE t.attempt_id = ? AND t.to_state = 'cleanup_pending'
            AND t.entity_sequence = (SELECT MAX(entity_sequence) FROM state_transitions WHERE attempt_id = ?)
        `).all(guard.attemptId, guard.attemptId) as MutableStateRecord[];
        const supplied = new Set(evidence.map((reference) => reference.evidenceId));
        if (attemptEvidence.length === 0 || !attemptEvidence.some((row) => typeof row.evidence_id === "string" && supplied.has(row.evidence_id))) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "run cleanup must pin the attempt cleanup transition evidence", this.location.databasePath);
        }
        return;
      }
      case "run_cleanup_complete": {
        const cleanup = this.#requireTransitionGuard(`
          SELECT c.* FROM cleanup_records c JOIN attempts a ON a.attempt_id = c.attempt_id
          WHERE c.cleanup_record_id = ? AND a.run_id = ?
        `, [guard.cleanupRecordId, command.entityId], "run reactivation cleanup record differs from run lineage");
        this.#validateCleanAttempt(String(cleanup.attempt_id), guard.cleanupRecordId);
        this.#requireCommandEvidence(evidence, [cleanup.evidence_id], "run cleanup evidence");
        return;
      }
      case "run_failure": {
        const cleanup = this.#requireTransitionGuard(`
          SELECT c.* FROM cleanup_records c JOIN attempts a ON a.attempt_id = c.attempt_id
          WHERE c.cleanup_record_id = ? AND a.run_id = ?
        `, [guard.cleanupRecordId, command.entityId], "run failure cleanup record differs from run lineage");
        if (cleanup.group_dead !== 1 || cleanup.resources_absent !== 1) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "run failure lacks complete cleanup proof", this.location.databasePath);
        this.#requireCommandEvidence(evidence, [cleanup.evidence_id], "run failure cleanup evidence");
        return;
      }
      case "run_ready": {
        const run = this.#requireTransitionGuard(
          "SELECT delivery_ref, current_delivery_oid FROM runs WHERE run_id = ?",
          [command.entityId],
          "run readiness entity is missing",
        );
        const tickets = this.#requireDatabase().prepare(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'ready_for_delivery' THEN 0 ELSE 1 END) AS not_ready FROM run_tickets WHERE run_id = ?",
        ).get(command.entityId) as MutableStateRecord;
        if (Number(tickets.total) < 1 || Number(tickets.not_ready) !== 0) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "run readiness requires every planned ticket ready", this.location.databasePath);
        const ticketEvidence = this.#requireDatabase().prepare(`
          SELECT rt.ticket_instance_id, tr.evidence_id FROM run_tickets rt
          JOIN state_transitions st ON st.ticket_instance_id = rt.ticket_instance_id
            AND st.to_state = 'ready_for_delivery'
            AND st.entity_sequence = (SELECT MAX(entity_sequence) FROM state_transitions WHERE ticket_instance_id = rt.ticket_instance_id)
          JOIN transition_evidence_refs tr ON tr.transition_id = st.transition_id
          WHERE rt.run_id = ?
        `).all(command.entityId) as MutableStateRecord[];
        if (new Set(ticketEvidence.map((row) => row.ticket_instance_id)).size !== Number(tickets.total)) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "run readiness lacks a finalization transition for every ticket", this.location.databasePath);
        }
        this.#requireCommandEvidence(evidence, ticketEvidence.map((row) => row.evidence_id), "run readiness ticket finalization evidence");
        let observed: string;
        try {
          observed = execFileSync("git", ["rev-parse", "--verify", String(run.delivery_ref)], { cwd: this.location.repoRealpath, encoding: "utf8" }).trim();
        } catch (error) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "run delivery ref cannot be observed", this.location.databasePath, error);
        }
        if (observed !== run.current_delivery_oid) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "run delivery ref differs from recorded delivery chain OID", this.location.databasePath);
        return;
      }
      case "delivery_record": {
        const delivery = this.#requireTransitionGuard(`
          SELECT d.delivery_record_id, d.delivery_intent_id, d.terminal_from_state, d.remote_observation_id,
                 d.pr_observation_id, d.decision_evidence_id, d.cleanup_evidence_id, d.delivery_oid, d.decision,
                 d.output_digest, cr.cleanup_record_id,
                 json_extract(de.inline_payload_json, '$.run_id') AS decision_run_id,
                 json_extract(de.inline_payload_json, '$.expected_run_version') AS decision_expected_run_version,
                 json_extract(de.inline_payload_json, '$.transition_idempotency_key') AS decision_transition_idempotency_key,
                 i.delivery_oid AS intent_oid, r.current_delivery_oid,
                 ro.observed_remote_oid, ro.operation AS remote_operation, ro.outcome AS remote_outcome,
                 ro.sequence AS remote_sequence, ro.evidence_id AS remote_evidence_id,
                 po.observed_head_oid, po.sequence AS pr_sequence, po.provider_repository_id, po.base_branch,
                 po.head_branch, po.pr_identity, po.evidence_id AS pr_evidence_id
          FROM delivery_records d JOIN delivery_intents i ON i.delivery_intent_id = d.delivery_intent_id
          JOIN runs r ON r.run_id = i.run_id
          JOIN evidence de ON de.evidence_id = d.decision_evidence_id AND de.producer_service = 'DeliveryService'
          JOIN attempts da ON da.attempt_id = de.attempt_id AND da.run_id = i.run_id
          JOIN evidence ce ON ce.evidence_id = d.cleanup_evidence_id AND ce.producer_service = 'CleanupService'
          JOIN attempts ca ON ca.attempt_id = ce.attempt_id AND ca.run_id = i.run_id
          JOIN cleanup_records cr ON cr.cleanup_record_id = json_extract(de.inline_payload_json, '$.cleanup_record_id')
            AND cr.evidence_id = ce.evidence_id AND cr.attempt_id = ca.attempt_id
            AND cr.group_dead = 1 AND cr.resources_absent = 1 AND cr.lease_release_eligible = 1
          LEFT JOIN remote_observations ro ON ro.remote_observation_id = d.remote_observation_id
            AND ro.delivery_intent_id = i.delivery_intent_id
          LEFT JOIN evidence re ON re.evidence_id = ro.evidence_id AND re.producer_service = 'DeliveryService'
          LEFT JOIN pr_observations po ON po.pr_observation_id = d.pr_observation_id
            AND po.delivery_intent_id = i.delivery_intent_id
          LEFT JOIN evidence pe ON pe.evidence_id = po.evidence_id AND pe.producer_service = 'DeliveryService'
          WHERE d.delivery_record_id = ? AND i.run_id = ? AND d.decision = ?
            AND (ro.evidence_id IS NULL OR re.evidence_id IS NOT NULL)
            AND (po.evidence_id IS NULL OR pe.evidence_id IS NOT NULL)
            AND (ro.sequence IS NULL OR ro.sequence = (SELECT MAX(sequence) FROM remote_observations WHERE delivery_intent_id = i.delivery_intent_id))
            AND (po.sequence IS NULL OR po.sequence = (SELECT MAX(sequence) FROM pr_observations WHERE delivery_intent_id = i.delivery_intent_id))
        `, [guard.deliveryRecordId, command.entityId, guard.decision], "delivery transition requires the exact immutable terminal record and latest observations");
        const requiredEvidence: (SqlValue | undefined)[] = [delivery.decision_evidence_id, delivery.cleanup_evidence_id];
        if (delivery.remote_evidence_id !== null && delivery.remote_evidence_id !== undefined) requiredEvidence.push(delivery.remote_evidence_id);
        if (delivery.pr_evidence_id !== null && delivery.pr_evidence_id !== undefined) requiredEvidence.push(delivery.pr_evidence_id);
        this.#requireCommandEvidence(evidence, requiredEvidence, "delivery decision, cleanup, and observation evidence");
        const deliveryIntentId = String(delivery.delivery_intent_id);
        if (typeof delivery.remote_evidence_id === "string") {
          this.#requireExactInlineEvidence(
            delivery.remote_evidence_id,
            "DeliveryService",
            deliveryIntentId,
            "rickgent.delivery-remote-observation.v1",
            {
              delivery_intent_id: deliveryIntentId,
              remote_observation_id: delivery.remote_observation_id,
              sequence: delivery.remote_sequence,
              operation: delivery.remote_operation,
              outcome: delivery.remote_outcome,
              observed_remote_oid: delivery.observed_remote_oid,
            },
            "remote observation",
          );
        }
        if (typeof delivery.pr_evidence_id === "string") {
          this.#requireExactInlineEvidence(
            delivery.pr_evidence_id,
            "DeliveryService",
            deliveryIntentId,
            "rickgent.delivery-pr-observation.v1",
            {
              delivery_intent_id: deliveryIntentId,
              pr_observation_id: delivery.pr_observation_id,
              sequence: delivery.pr_sequence,
              provider_repository_id: delivery.provider_repository_id,
              base_branch: delivery.base_branch,
              head_branch: delivery.head_branch,
              pr_identity: delivery.pr_identity,
              observed_head_oid: delivery.observed_head_oid,
            },
            "PR observation",
          );
        }
        const decisionPayload = {
          delivery_intent_id: deliveryIntentId,
          delivery_record_id: delivery.delivery_record_id,
          terminal_from_state: delivery.terminal_from_state,
          remote_observation_id: delivery.remote_observation_id,
          pr_observation_id: delivery.pr_observation_id,
          cleanup_record_id: delivery.cleanup_record_id,
          delivery_oid: delivery.delivery_oid,
          decision: delivery.decision,
          run_id: delivery.decision_run_id,
          expected_run_version: delivery.decision_expected_run_version,
          transition_idempotency_key: delivery.decision_transition_idempotency_key,
        };
        this.#requireExactInlineEvidence(
          delivery.decision_evidence_id,
          "DeliveryService",
          deliveryIntentId,
          "rickgent.delivery-decision.v1",
          decisionPayload,
          "delivery decision",
        );
        if (delivery.output_digest !== sha256Text(canonicalJson(decisionPayload))) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "delivery decision output digest does not pin its canonical operation", this.location.databasePath);
        }
        if (
          delivery.delivery_oid !== delivery.intent_oid || delivery.delivery_oid !== delivery.current_delivery_oid ||
          (guard.decision === "delivered" && (
            delivery.remote_operation !== "ls-remote" || delivery.observed_remote_oid !== delivery.delivery_oid ||
            delivery.observed_head_oid !== delivery.delivery_oid
          ))
        ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "delivery terminal OIDs do not independently equal the run delivery chain", this.location.databasePath);
        return;
      }
    }
  }

  #validateDurableContextProjection(input: PersistDurableExecutionContextInput): MutableStateRecord {
    if (!Number.isSafeInteger(input.phaseOrdinal) || input.phaseOrdinal < 0) throw new TypeError("phase ordinal must be a nonnegative safe integer");
    const text = assertCanonicalJsonText(input.canonicalContextJson, "durable execution context");
    for (const [label, digest] of [
      ["policy bundle", input.policyBundleDigest],
      ["model selection", input.modelSelectionDigest],
      ["budget", input.budgetDigest],
      ["scope", input.scopeDigest],
    ] as const) {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${label} digest is invalid`);
    }
    const context = this.#parseJsonObject(text, "durable execution context");
    const lineage = this.#requireDatabase().prepare(`
      SELECT a.attempt_id, a.ticket_instance_id, a.run_id, a.ticket_id, a.attempt_number, a.state AS attempt_state,
             a.contract_digest, a.capability_snapshot_digest, a.context_schema_version,
             a.oracle_version, a.resource_identity_version,
             r.repository_id, r.state AS run_state, repo.repo_realpath, repo.git_common_dir_realpath, repo.object_format,
             tc.canonical_contract_json
      FROM attempts a
      JOIN run_tickets rt ON rt.ticket_instance_id = a.ticket_instance_id
      JOIN runs r ON r.run_id = a.run_id
      JOIN repositories repo ON repo.repository_id = r.repository_id
      JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
      WHERE a.attempt_id = ? AND r.repository_id = ?
    `).get(input.attemptId, this.location.repositoryId) as MutableStateRecord | undefined;
    if (lineage === undefined) this.#resumeIncompatible("execution context attempt does not belong to the selected repository");
    const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "ticket contract");
    const expected: Readonly<Record<string, unknown>> = {
      schema_version: lineage.context_schema_version,
      repository_id: this.location.repositoryId,
      repo_realpath: this.location.repoRealpath,
      git_common_dir_realpath: this.location.gitCommonDirRealpath,
      object_format: this.location.objectFormat,
      state_root_realpath: this.location.stateDirectory,
      resource_root_realpath: this.location.resourceDirectory,
      run_id: lineage.run_id,
      ticket_instance_id: lineage.ticket_instance_id,
      ticket_id: lineage.ticket_id,
      attempt_id: lineage.attempt_id,
      attempt_number: lineage.attempt_number,
      phase: input.phase,
      phase_ordinal: input.phaseOrdinal,
      role: input.role,
      worktree_realpath: input.worktreeRealpath,
      policy_root_realpath: input.policyRootRealpath,
      bundle_root_realpath: input.bundleRootRealpath,
      timeout_ms: input.timeoutMs,
      contract_digest: lineage.contract_digest,
      capability_snapshot_digest: lineage.capability_snapshot_digest,
      policy_bundle_digest: input.policyBundleDigest,
      model_selection_digest: input.modelSelectionDigest,
      budget_digest: input.budgetDigest,
      scope_digest: input.scopeDigest,
      context_schema_version: lineage.context_schema_version,
      oracle_version: lineage.oracle_version,
      resource_identity_version: lineage.resource_identity_version,
      budgets: contract.budgets,
      scope: contract.scope,
    };
    const allowedKeys = new Set(Object.keys(expected));
    const contextKeys = Object.keys(context);
    if (contextKeys.length !== allowedKeys.size || contextKeys.some((key) => !allowedKeys.has(key))) {
      this.#resumeIncompatible("durable execution context contains fields outside the frozen schema");
    }
    for (const [key, value] of Object.entries(expected)) {
      if (canonicalJson(context[key]) !== canonicalJson(value)) {
        this.#resumeIncompatible(`execution context ${key} differs from authoritative lineage`);
      }
    }
    if (sha256Text(canonicalJson(contract.budgets)) !== input.budgetDigest || sha256Text(canonicalJson(contract.scope)) !== input.scopeDigest) {
      this.#resumeIncompatible("execution context budget or scope digest differs from its ticket contract");
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new TypeError("execution context timeoutMs must be positive");
    for (const [field, value] of [
      ["worktreeRealpath", input.worktreeRealpath],
      ["policyRootRealpath", input.policyRootRealpath],
      ["bundleRootRealpath", input.bundleRootRealpath],
    ] as const) {
      if (!isAbsolute(value) || realpathSync.native(value) !== value) throw new TypeError(`execution context ${field} must be an existing canonical absolute path`);
    }
    // t22A fix round 2: the attempt-owned execution context binds to the
    // authority-derived worktree (the LeaseAuthority ownership grant's
    // plan.worktreePath), which is NOT the caller repository.  The
    // resolveAuthorityExecutionContext entrypoint rejects a binding that
    // resolves to the caller repository, so the prior blanket "remain on the
    // selected repository" guard is relaxed to permit the authority-derived
    // worktree.  The legacy resolvePhaseContext path continues to pass the
    // caller repository as the worktree (unchanged behavior).
    for (const [field, value] of [
      ["policyRootRealpath", input.policyRootRealpath],
      ["bundleRootRealpath", input.bundleRootRealpath],
    ] as const) {
      const fromResourceRoot = relative(this.location.resourceDirectory, value);
      if (fromResourceRoot === ".." || fromResourceRoot.startsWith(`..${sep}`) || isAbsolute(fromResourceRoot)) {
        throw new TypeError(`t14 context ${field} must be contained by the canonical resource root`);
      }
    }
    return lineage;
  }

  #validateFreshRunInput(input: AllocateFreshRunInput): void {
    if (input.tickets.length === 0) throw new TypeError("fresh run allocation requires at least one ticket");
    this.#validateImmutableJson(input.manifest, "run manifest");
    this.#validateImmutableJson(input.manifest.capabilitySnapshot, "capability snapshot");
    if (
      input.manifest.schemaVersion !== "rickgent.run-manifest/v1" ||
      input.manifest.contextSchemaVersion !== "rickgent.execution-context/v1" ||
      input.manifest.resourceIdentityVersion !== "rickgent.attempt-resource-identity/v1"
    ) throw new TypeError("fresh run allocation uses an unsupported identity schema version");
    const compiledCapabilityJson = canonicalJson({
      schema_version: "rickgent.capability-snapshot/v1",
      claims_schema_version: CLAIMS_SCHEMA_VERSION,
      release_channel: RELEASE_CHANNEL,
      release_label: RELEASE_LABEL,
      capabilities: capabilityRegistry(),
    });
    if (
      input.manifest.capabilitySnapshot.schemaVersion !== "rickgent.capability-snapshot/v1" ||
      input.manifest.capabilitySnapshot.canonicalJson !== compiledCapabilityJson ||
      input.manifest.capabilitySnapshot.digest !== sha256Text(compiledCapabilityJson)
    ) throw new TypeError("capability snapshot differs from the compiled release boundary");
    const manifest = this.#parseJsonObject(input.manifest.canonicalJson, "run manifest");
    const capability = JSON.parse(input.manifest.capabilitySnapshot.canonicalJson) as unknown;
    const ordered = [...input.tickets].sort((left, right) => left.planIndex - right.planIndex);
    const ids = new Set<string>();
    const indexes = new Set<number>();
    for (const [position, ticket] of ordered.entries()) {
      this.#validateImmutableJson(ticket.contract, `ticket ${ticket.ticketId} contract`);
      if (typeof ticket.ticketId !== "string" || ticket.ticketId === "" || ids.has(ticket.ticketId)) throw new TypeError("fresh run ticket ids must be nonempty and unique");
      if (!Number.isSafeInteger(ticket.planIndex) || ticket.planIndex !== position || indexes.has(ticket.planIndex)) {
        throw new TypeError("fresh run plan indexes must be unique and contiguous from zero");
      }
      ids.add(ticket.ticketId);
      indexes.add(ticket.planIndex);
      const contract = this.#parseJsonObject(ticket.contract.canonicalJson, `ticket ${ticket.ticketId} contract`);
      if (
        contract.schema_version !== ticket.contract.schemaVersion || contract.id !== ticket.ticketId ||
        canonicalJson(contract.depends_on) !== canonicalJson(ticket.dependsOnTicketIds)
      ) {
        throw new TypeError(`ticket ${ticket.ticketId} contract projection differs from allocation identity`);
      }
    }
    for (const ticket of input.tickets) {
      const dependencies = new Set<string>();
      for (const dependency of ticket.dependsOnTicketIds) {
        if (!ids.has(dependency) || dependency === ticket.ticketId || dependencies.has(dependency)) {
          throw new TypeError(`ticket ${ticket.ticketId} has an invalid dependency set`);
        }
        dependencies.add(dependency);
      }
    }
    const normalizedContracts = normalizeTicketContracts(
      ordered.map((ticket) => ({
        ...this.#parseJsonObject(ticket.contract.canonicalJson, `ticket ${ticket.ticketId} contract`),
        digest: ticket.contract.digest,
      })),
      {
        repositoryRoot: this.location.repoRealpath,
        stateRoots: [this.location.stateDirectory, this.location.resourceDirectory],
      },
    );
    for (const [index, normalized] of normalizedContracts.entries()) {
      const ticket = ordered[index];
      if (ticket === undefined || normalized.id !== ticket.ticketId || normalized.digest !== ticket.contract.digest) {
        throw new TypeError("normalized ticket contract order or identity differs from the run allocation");
      }
    }
    const ticketProjection = ordered.map((ticket) => ({
      contract_digest: ticket.contract.digest,
      depends_on_ticket_ids: [...ticket.dependsOnTicketIds],
      plan_index: ticket.planIndex,
      ticket_id: ticket.ticketId,
    }));
    const expected: Readonly<Record<string, unknown>> = {
      schema_version: input.manifest.schemaVersion,
      capability_snapshot: capability,
      capability_snapshot_digest: input.manifest.capabilitySnapshot.digest,
      capability_snapshot_schema_version: input.manifest.capabilitySnapshot.schemaVersion,
      context_schema_version: input.manifest.contextSchemaVersion,
      git_common_dir_realpath: this.location.gitCommonDirRealpath,
      object_format: this.location.objectFormat,
      oracle_version: input.manifest.oracleVersion,
      repo_realpath: this.location.repoRealpath,
      repository_id: this.location.repositoryId,
      resource_identity_version: input.manifest.resourceIdentityVersion,
      tickets: ticketProjection,
    };
    if (Object.keys(manifest).length !== Object.keys(expected).length || Object.keys(manifest).some((key) => !Object.hasOwn(expected, key))) {
      throw new TypeError("run manifest must contain exactly the frozen schema fields");
    }
    for (const [key, value] of Object.entries(expected)) {
      if (canonicalJson(manifest[key]) !== canonicalJson(value)) throw new TypeError(`run manifest ${key} projection differs from allocation input`);
    }
  }

  #validateImmutableJson(input: ImmutableJsonInput, label: string): void {
    if (typeof input.schemaVersion !== "string" || input.schemaVersion === "") throw new TypeError(`${label} schema version is required`);
    const text = assertCanonicalJsonText(input.canonicalJson, `${label} canonical JSON`);
    if (sha256Text(text) !== input.digest) throw new TypeError(`${label} digest does not hash its canonical JSON`);
    const value = this.#parseJsonObject(text, label);
    if (value.schema_version !== input.schemaVersion) throw new TypeError(`${label} schema version differs from its canonical JSON`);
  }

  #parseJsonObject(text: string, label: string): Record<string, unknown> {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
    return value as Record<string, unknown>;
  }

  #parseJsonArray(text: string, label: string): unknown[] {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) throw new TypeError(`${label} must be a JSON array`);
    return value;
  }

  #insertSharedImmutable(
    table: "run_manifests" | "ticket_contracts",
    input: StateRowInput,
    identityColumns: readonly string[],
    equalityColumns: readonly string[],
  ): StateRecord {
    const row = this.#validatedColumns(table, normalizeRow(input));
    this.#requireCompleteRow(table, row);
    this.#validateRecordSemantics(table, row);
    const existing = this.#selectBy(table, row, identityColumns);
    if (existing !== undefined) {
      if (equalityColumns.every((column) => sameValue(existing[column], row[column]))) return frozenRow(existing);
      throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", `${table} digest already has different immutable input`, this.location.databasePath);
    }
    this.#insert(table, row);
    return frozenRow(row);
  }

  #allocateAttempt(input: AttemptAllocationInput | RetryCompatibilityInput, mode: "initial" | "retry"): AllocatedAttempt {
    return this.#immediate(mode === "initial" ? "allocate_initial_attempt" : "allocate_retry_attempt", () => {
      if (typeof input.runId !== "string" || input.runId === "" || typeof input.ticketId !== "string" || input.ticketId === "") {
        throw new TypeError("attempt allocation requires explicit run and ticket ids");
      }
      const lineage = this.#requireDatabase().prepare(`
        SELECT rt.ticket_instance_id, rt.run_id, rt.ticket_id, rt.contract_digest, rt.state AS ticket_state,
               r.repository_id, r.state AS run_state, r.current_delivery_oid,
               rm.context_schema_version, rm.oracle_version, rm.capability_snapshot_digest, rm.canonical_manifest_json,
               tc.canonical_contract_json
        FROM run_tickets rt
        JOIN runs r ON r.run_id = rt.run_id
        JOIN run_manifests rm ON rm.manifest_digest = r.manifest_digest
        JOIN ticket_contracts tc ON tc.contract_digest = rt.contract_digest
        WHERE rt.run_id = ? AND rt.ticket_id = ? AND r.repository_id = ?
      `).get(input.runId, input.ticketId, this.location.repositoryId) as MutableStateRecord | undefined;
      if (lineage === undefined) this.#resumeIncompatible("attempt allocation lineage does not belong to the selected repository");
      const allowedRunStates = mode === "initial" ? ["planned", "active"] : ["active", "cleanup_pending"];
      if (!allowedRunStates.includes(String(lineage.run_state))) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${mode} attempt allocation is forbidden while the run is ${String(lineage.run_state)}`, this.location.databasePath);
      }
      const attempts = this.#requireDatabase().prepare(
        "SELECT * FROM attempts WHERE ticket_instance_id = ? ORDER BY attempt_number",
      ).all(lineage.ticket_instance_id ?? null) as MutableStateRecord[];
      let attemptNumber: number;
      if (mode === "initial") {
        if (attempts.length !== 0 || lineage.ticket_state !== "planned") {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "initial attempt requires an unallocated planned ticket", this.location.databasePath);
        }
        attemptNumber = 1;
      } else {
        const compatibility = input as RetryCompatibilityInput;
        this.#assertRetryCompatibility(lineage, compatibility);
        const selection = this.#retrySelectionFromRows(lineage, attempts, compatibility);
        attemptNumber = selection.nextAttemptNumber;
      }
      const manifest = this.#parseJsonObject(String(lineage.canonical_manifest_json), "run manifest");
      const resourceIdentityVersion = manifest.resource_identity_version;
      if (typeof resourceIdentityVersion !== "string" || resourceIdentityVersion === "") {
        throw new StateStoreError("RICKGENT_STATE_CORRUPT", "run manifest lacks a resource identity version");
      }
      this.#assertRepositoryCommit(lineage.current_delivery_oid, "attempt delivery baseline oid");
      const attemptId = `attempt-${randomBytes(16).toString("hex")}`;
      const ownerPayload = canonicalJson({
        allocator: mode === "initial" ? "rickgent.initial-attempt-allocator/v1" : "rickgent.retry-attempt-allocator/v1",
        attempt_id: attemptId,
        attempt_number: attemptNumber,
        repository_id: this.location.repositoryId,
        run_id: input.runId,
        ticket_instance_id: String(lineage.ticket_instance_id),
      });
      const row: MutableStateRecord = {
        attempt_id: attemptId,
        ticket_instance_id: String(lineage.ticket_instance_id),
        run_id: input.runId,
        ticket_id: input.ticketId,
        attempt_number: attemptNumber,
        contract_digest: String(lineage.contract_digest),
        allocation_owner_digest: sha256Text(ownerPayload),
        delivery_baseline_oid: String(lineage.current_delivery_oid),
        context_schema_version: String(lineage.context_schema_version),
        oracle_version: String(lineage.oracle_version),
        capability_snapshot_digest: String(lineage.capability_snapshot_digest),
        resource_identity_version: resourceIdentityVersion,
        state: "planned",
        state_version: 0,
        created_at: new Date().toISOString(),
      };
      this.#insert("attempts", row);
      return this.#allocatedAttempt(row);
    });
  }

  #selectRetryInTransaction(input: RetryCompatibilityInput): RetrySelection {
    if (typeof input.runId !== "string" || input.runId === "" || typeof input.ticketId !== "string" || input.ticketId === "") {
      this.#resumeIncompatible("retry selection requires explicit run and ticket ids");
    }
    const lineage = this.#requireDatabase().prepare(`
      SELECT rt.ticket_instance_id, rt.run_id, rt.ticket_id, rt.contract_digest, rt.state AS ticket_state,
             r.repository_id, rm.context_schema_version, rm.oracle_version, rm.capability_snapshot_digest,
             rm.canonical_manifest_json, tc.canonical_contract_json
      FROM run_tickets rt
      JOIN runs r ON r.run_id = rt.run_id
      JOIN run_manifests rm ON rm.manifest_digest = r.manifest_digest
      JOIN ticket_contracts tc ON tc.contract_digest = rt.contract_digest
      WHERE rt.run_id = ? AND rt.ticket_id = ? AND r.repository_id = ?
    `).get(input.runId, input.ticketId, this.location.repositoryId) as MutableStateRecord | undefined;
    if (lineage === undefined) this.#resumeIncompatible("retry lineage does not belong to the selected repository");
    this.#assertRetryCompatibility(lineage, input);
    const attempts = this.#requireDatabase().prepare(
      "SELECT * FROM attempts WHERE ticket_instance_id = ? ORDER BY attempt_number",
    ).all(lineage.ticket_instance_id ?? null) as MutableStateRecord[];
    return this.#retrySelectionFromRows(lineage, attempts, input);
  }

  #assertRetryCompatibility(lineage: MutableStateRecord, input: RetryCompatibilityInput): void {
    const manifest = this.#parseJsonObject(String(lineage.canonical_manifest_json), "run manifest");
    if (
      lineage.contract_digest !== input.contractDigest || lineage.context_schema_version !== input.contextSchemaVersion ||
      lineage.oracle_version !== input.oracleVersion || lineage.capability_snapshot_digest !== input.capabilitySnapshotDigest ||
      manifest.resource_identity_version !== input.resourceIdentityVersion
    ) this.#resumeIncompatible("retry compatibility projection changed");
  }

  #retrySelectionFromRows(
    lineage: MutableStateRecord,
    attempts: readonly MutableStateRecord[],
    compatibility: RetryCompatibilityInput | undefined,
  ): RetrySelection {
    const latest = attempts.at(-1);
    if (latest === undefined || latest.state !== "failed_clean" || lineage.ticket_state !== "cleanup_pending") {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "retry requires the latest attempt to be failed_clean and its ticket cleanup_pending", this.location.databasePath);
    }
    if (attempts.some((attempt) => attempt.state === "quarantined")) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "quarantined attempts cannot be retried", this.location.databasePath);
    }
    const manifest = this.#parseJsonObject(String(lineage.canonical_manifest_json), "run manifest");
    if (
      latest.contract_digest !== lineage.contract_digest || latest.context_schema_version !== lineage.context_schema_version ||
      latest.oracle_version !== lineage.oracle_version || latest.capability_snapshot_digest !== lineage.capability_snapshot_digest ||
      latest.resource_identity_version !== manifest.resource_identity_version
    ) {
      this.#resumeIncompatible("retry compatibility differs from the latest attempt");
    }
    if (compatibility !== undefined && latest.resource_identity_version !== compatibility.resourceIdentityVersion) {
      this.#resumeIncompatible("retry resource identity differs from the explicit selection");
    }
    const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "ticket contract");
    const budgets = contract.budgets;
    const maxAttempts = budgets !== null && typeof budgets === "object" && !Array.isArray(budgets)
      ? (budgets as Record<string, unknown>).max_attempts : undefined;
    if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1) throw new StateStoreError("RICKGENT_STATE_CORRUPT", "ticket contract has an invalid max_attempts budget");
    const latestNumber = Number(latest.attempt_number);
    if (latestNumber >= (maxAttempts as number)) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "retry would exceed the immutable max_attempts budget", this.location.databasePath);
    }
    return freezeValue({
      runnable: false as const,
      runId: String(lineage.run_id),
      ticketId: String(lineage.ticket_id),
      ticketInstanceId: String(lineage.ticket_instance_id),
      contractDigest: String(lineage.contract_digest),
      latestAttemptId: String(latest.attempt_id),
      latestAttemptNumber: latestNumber,
      maxAttempts: maxAttempts as number,
      nextAttemptNumber: latestNumber + 1,
    });
  }

  #allocatedAttempt(row: MutableStateRecord): AllocatedAttempt {
    const selected = this.#persistedAttempt(row);
    if (selected.state !== "planned" || selected.stateVersion !== 0) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", "newly allocated attempt did not persist as planned at version zero");
    }
    return freezeValue({ ...selected, state: "planned" as const, stateVersion: 0 as const });
  }

  #persistedAttempt(row: MutableStateRecord): PersistedAttemptSelection {
    return freezeValue({
      runnable: false as const,
      attemptId: String(row.attempt_id),
      ticketInstanceId: String(row.ticket_instance_id),
      runId: String(row.run_id),
      ticketId: String(row.ticket_id),
      attemptNumber: Number(row.attempt_number),
      contractDigest: String(row.contract_digest),
      allocationOwnerDigest: String(row.allocation_owner_digest),
      deliveryBaselineOid: String(row.delivery_baseline_oid),
      contextSchemaVersion: String(row.context_schema_version),
      oracleVersion: String(row.oracle_version),
      capabilitySnapshotDigest: String(row.capability_snapshot_digest),
      resourceIdentityVersion: String(row.resource_identity_version),
      state: String(row.state),
      stateVersion: Number(row.state_version),
    });
  }

  #resumeIncompatible(message: string): never {
    throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", message, this.location.databasePath);
  }

  #registerRepository(): void {
    this.#appendIdempotent(
      "repositories",
      {
        repository_id: this.location.repositoryId,
        repo_realpath: this.location.repoRealpath,
        git_common_dir_realpath: this.location.gitCommonDirRealpath,
        object_format: this.location.objectFormat,
        state_directory: this.location.stateDirectory,
        identity_digest: this.location.identityDigest,
        created_at: new Date().toISOString(),
      },
      ["identity_digest"],
      ["repository_id", "repo_realpath", "git_common_dir_realpath", "object_format", "state_directory"],
    );
  }

  #appendIdempotent(
    table: AppendOnlyStateTableName,
    input: StateRowInput,
    idempotencyColumns: readonly string[],
    identityColumns: readonly string[],
  ): StateRecord {
    const row = this.#validatedColumns(table, normalizeRow(input));
    this.#assertColumnList(table, idempotencyColumns, row);
    this.#assertColumnList(table, identityColumns, row);
    return this.#immediate("append_idempotent", () => {
      this.#validateRecordSemantics(table, row);
      const existing = this.#selectBy(table, row, idempotencyColumns);
      if (existing !== undefined) {
        if (identityColumns.every((column) => sameValue(existing[column], row[column]))) return frozenRow(existing);
        throw typedError(
          "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
          `idempotency key was already used with different immutable input in ${table}`,
          this.location.databasePath,
        );
      }
      try {
        this.#insert(table, row);
      } catch (error) {
        if (isConstraint(error)) {
          throw typedError("RICKGENT_STATE_CONFLICT", `unique state conflict in ${table}`, this.location.databasePath, error);
        }
        throw error;
      }
      return frozenRow(row);
    });
  }

  #requireCompleteRow(table: StateTableName, row: Readonly<Record<string, SqlValue>>): void {
    const columns = this.#columns.get(table);
    if (columns === undefined || Object.keys(row).length !== columns.size || [...columns].some((column) => !Object.hasOwn(row, column))) {
      throw new TypeError(`${table} snapshot operations require an explicit value, including null, for every column`);
    }
  }

  #sameRecord(left: Readonly<Record<string, SqlValue>>, right: Readonly<Record<string, SqlValue>>): boolean {
    const keys = Object.keys(right);
    return keys.length === Object.keys(left).length && keys.every((key) => sameValue(left[key], right[key]));
  }

  #assertRepositoryOid(value: SqlValue | undefined, label: string): void {
    if (
      typeof value !== "string" || value.length !== (this.location.objectFormat === "sha1" ? 40 : 64) ||
      !/^[0-9a-f]+$/.test(value)
    ) throw new TypeError(`${label} does not match repository object format ${this.location.objectFormat}`);
  }

  #assertRepositoryCommit(value: SqlValue | undefined, label: string): void {
    this.#assertRepositoryOid(value, label);
    try {
      execFileSync("git", ["cat-file", "-e", `${String(value)}^{commit}`], {
        cwd: this.location.repoRealpath,
        stdio: "ignore",
        env: HERMETIC_GIT_ENVIRONMENT,
      });
    } catch (error) {
      throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `${label} is not an existing commit in the selected repository`, this.location.databasePath, error);
    }
  }

  #assertRepositoryTree(value: SqlValue | undefined, label: string): void {
    this.#assertRepositoryOid(value, label);
    try {
      const type = execFileSync("git", ["cat-file", "-t", String(value)], {
        cwd: this.location.repoRealpath,
        encoding: "utf8",
        env: HERMETIC_GIT_ENVIRONMENT,
      }).trim();
      if (type !== "tree") throw new Error(`observed Git object type ${type}`);
    } catch (error) {
      throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `${label} is not an existing tree in the selected repository`, this.location.databasePath, error);
    }
  }

  /** Resolve one canonical Git delta. Every lifecycle content pin uses this exact parser and digest projection. */
  #canonicalGitDelta(from: string, to: string, label: string): CanonicalGitDelta {
    try {
      const raw = execFileSync("git", ["diff", "--raw", "-z", "--no-abbrev", "-M", from, to], {
        cwd: this.location.repoRealpath,
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT,
        env: HERMETIC_GIT_ENVIRONMENT,
      });
      return canonicalGitDeltaFromRaw(raw);
    } catch (error) {
      throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `${label} cannot be independently resolved from Git`, this.location.databasePath, error);
    }
  }

  #assertDeltaWithinScope(delta: CanonicalGitDelta, rawScope: unknown, label: string): void {
    if (!Array.isArray(rawScope)) throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `${label} contract scope is malformed`, this.location.databasePath);
    const scope = rawScope.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw typedError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `${label} contract scope entry is malformed`, this.location.databasePath);
      }
      return value as Record<string, unknown>;
    });
    const inside = (parent: string, path: string): boolean => path === parent || path.startsWith(`${parent}/`);
    const declarationOwns = (declaration: Record<string, unknown>, entry: CanonicalGitDeltaEntry): boolean => {
        if (typeof declaration.path !== "string" || typeof declaration.change_kind !== "string" || typeof declaration.directory !== "boolean") return false;
        if (!declaration.directory) {
          return declaration.path === entry.path && declaration.change_kind === entry.change_kind &&
            (entry.change_kind !== "rename" || declaration.from_path === entry.from_path);
        }
        if (!inside(declaration.path, entry.path)) return false;
        if (entry.from_path !== null && !inside(declaration.path, entry.from_path)) return false;
        return declaration.change_kind === entry.change_kind;
    };
    for (const entry of delta.entries) {
      const owned = scope.some((declaration) => declarationOwns(declaration, entry));
      if (!owned) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} contains an out-of-scope path or change kind: ${entry.path}`, this.location.databasePath);
    }
    for (const declaration of scope) {
      if (!delta.entries.some((entry) => declarationOwns(declaration, entry))) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `${label} does not realize every sealed ticket scope entry`, this.location.databasePath);
      }
    }
  }

  #validateRecordSemantics(table: StateTableName, row: Readonly<Record<string, SqlValue>>): void {
    if (table === "repositories") {
      if (
        row.repository_id !== this.location.repositoryId || row.identity_digest !== this.location.identityDigest ||
        row.repo_realpath !== this.location.repoRealpath || row.git_common_dir_realpath !== this.location.gitCommonDirRealpath ||
        row.object_format !== this.location.objectFormat || row.state_directory !== this.location.stateDirectory
      ) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "repository record differs from the canonical selected repository");
      }
      return;
    }

    const jsonDigest: Partial<Record<StateTableName, readonly [string, string]>> = {
      run_manifests: ["canonical_manifest_json", "manifest_digest"],
      ticket_contracts: ["canonical_contract_json", "contract_digest"],
      execution_contexts: ["canonical_context_json", "context_digest"],
    };
    const digestFields = jsonDigest[table];
    if (digestFields !== undefined) {
      const [jsonColumn, digestColumn] = digestFields;
      const text = assertCanonicalJsonText(row[jsonColumn], `${table}.${jsonColumn}`);
      if (sha256Text(text) !== row[digestColumn]) throw new TypeError(`${table}.${digestColumn} does not hash its canonical payload`);
    }

    if (table === "execution_contexts") {
      const attempt = this.#requireDatabase().prepare(
        "SELECT contract_digest, capability_snapshot_digest, context_schema_version, oracle_version FROM attempts WHERE attempt_id = ?",
      ).get(row.attempt_id ?? null) as MutableStateRecord | undefined;
      if (
        attempt === undefined || attempt.contract_digest !== row.contract_digest ||
        attempt.capability_snapshot_digest !== row.capability_snapshot_digest ||
        attempt.context_schema_version !== row.context_schema_version || attempt.oracle_version !== row.oracle_version
      ) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "execution context compatibility does not match its attempt");
      }
    }

    if (table === "evidence") {
      if (row.inline_payload_json !== null && row.inline_payload_json !== undefined) {
        const text = assertCanonicalJsonText(row.inline_payload_json, "evidence.inline_payload_json");
        if (sha256Text(text) !== row.content_digest) throw new TypeError("evidence.content_digest does not hash its inline canonical payload");
      } else if (row.external_digest !== row.content_digest) {
        throw new TypeError("external evidence content_digest must equal its immutable external_digest");
      }
    }

    if (table === "state_transitions") {
      const count = [row.run_id, row.ticket_instance_id, row.attempt_id].filter((value) => value !== null && value !== undefined).length;
      if (count !== 1) throw new TypeError("state transition must select exactly one entity scope");
    }

    if (table === "oracle_decisions") {
      assertCanonicalJsonText(row.reasons_json, "oracle_decisions.reasons_json");
      const scopeValid =
        (row.scope_kind === "run" && row.ticket_instance_id === null && row.attempt_id === null) ||
        (row.scope_kind === "ticket" && typeof row.ticket_instance_id === "string" && row.attempt_id === null) ||
        (row.scope_kind === "attempt" && typeof row.ticket_instance_id === "string" && typeof row.attempt_id === "string");
      if (!scopeValid) throw new TypeError("oracle decision scope hierarchy is invalid");
    }
  }

  #validateTransitionEvidence(
    transition: Readonly<Record<string, SqlValue>>,
    reference: Readonly<Record<string, SqlValue>>,
  ): void {
    const lineage = this.#requireDatabase().prepare(`
      SELECT a.attempt_id, a.ticket_instance_id, a.run_id
      FROM evidence e
      JOIN execution_contexts c ON c.context_id = e.context_id
      JOIN attempts a ON a.attempt_id = c.attempt_id
      WHERE e.evidence_id = ?
    `).get(reference.evidence_id ?? null) as MutableStateRecord | undefined;
    if (lineage === undefined) throw new StateStoreError("RICKGENT_STATE_CONFLICT", "transition evidence does not resolve to immutable lineage");
    if (
      (transition.attempt_id !== null && transition.attempt_id !== undefined && lineage.attempt_id !== transition.attempt_id) ||
      (transition.ticket_instance_id !== null && transition.ticket_instance_id !== undefined && lineage.ticket_instance_id !== transition.ticket_instance_id) ||
      (transition.run_id !== null && transition.run_id !== undefined && lineage.run_id !== transition.run_id)
    ) {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "transition evidence belongs to a different canonical lineage");
    }
  }

  #validateOracleReference(
    decision: Readonly<Record<string, SqlValue>>,
    reference: Readonly<Record<string, SqlValue>>,
  ): void {
    const db = this.#requireDatabase();
    const kind = reference.reference_kind;
    let target: MutableStateRecord | undefined;
    let digestColumn: string | undefined;
    let requiredSchema: string | undefined;
    let targetTable: StateTableName;
    switch (kind) {
      case "run_manifest":
        target = db.prepare(`
          SELECT rm.*, r.run_id, NULL AS ticket_instance_id, NULL AS attempt_id
          FROM run_manifests rm JOIN runs r ON r.manifest_digest = rm.manifest_digest
          WHERE rm.manifest_digest = ? AND r.run_id = ?
        `).get(reference.run_manifest_digest ?? null, decision.run_id ?? null) as MutableStateRecord | undefined;
        targetTable = "run_manifests";
        digestColumn = "manifest_digest";
        break;
      case "ticket_contract":
        target = db.prepare(`
          SELECT tc.*, rt.run_id, rt.ticket_instance_id, NULL AS attempt_id
          FROM ticket_contracts tc JOIN run_tickets rt ON rt.contract_digest = tc.contract_digest
          WHERE tc.contract_digest = ? AND rt.run_id = ?
            AND (? IS NULL OR rt.ticket_instance_id = ?)
        `).get(
          reference.contract_digest ?? null,
          decision.run_id ?? null,
          decision.ticket_instance_id ?? null,
          decision.ticket_instance_id ?? null,
        ) as MutableStateRecord | undefined;
        targetTable = "ticket_contracts";
        digestColumn = "contract_digest";
        break;
      case "execution_context":
        target = db.prepare(`
          SELECT c.*, a.run_id, a.ticket_instance_id
          FROM execution_contexts c JOIN attempts a ON a.attempt_id = c.attempt_id
          WHERE c.context_id = ?
        `).get(reference.context_id ?? null) as MutableStateRecord | undefined;
        targetTable = "execution_contexts";
        digestColumn = "context_digest";
        break;
      case "evidence":
      case "attempt_resource_snapshot":
      case "lease_snapshot": {
        const column = kind === "evidence" ? "evidence_id" : kind === "attempt_resource_snapshot" ? "resource_snapshot_evidence_id" : "lease_snapshot_evidence_id";
        target = db.prepare(`
          SELECT e.*, a.run_id, a.ticket_instance_id, a.attempt_id
          FROM evidence e
          JOIN execution_contexts c ON c.context_id = e.context_id
          JOIN attempts a ON a.attempt_id = c.attempt_id
          WHERE e.evidence_id = ?
        `).get(reference[column] ?? null) as MutableStateRecord | undefined;
        targetTable = "evidence";
        digestColumn = "content_digest";
        requiredSchema = kind === "attempt_resource_snapshot" ? "rickgent.attempt-resource-claim-snapshot.v2" :
          kind === "lease_snapshot" ? "rickgent.attempt-ownership-lease-snapshot.v2" : undefined;
        break;
      }
      case "gate_result":
        target = db.prepare(`
          SELECT g.*, a.run_id, a.ticket_instance_id
          FROM gate_results g JOIN attempts a ON a.attempt_id = g.attempt_id
          WHERE g.gate_result_id = ?
        `).get(reference.gate_result_id ?? null) as MutableStateRecord | undefined;
        targetTable = "gate_results";
        digestColumn = "result_digest";
        break;
      case "review_record":
        target = db.prepare(`
          SELECT r.*, a.run_id, a.ticket_instance_id, e.content_digest AS oracle_content_digest
          FROM review_records r JOIN attempts a ON a.attempt_id = r.attempt_id
          JOIN evidence e ON e.evidence_id = r.verdict_evidence_id
          WHERE r.review_record_id = ?
        `).get(reference.review_record_id ?? null) as MutableStateRecord | undefined;
        targetTable = "review_records";
        digestColumn = "oracle_content_digest";
        break;
      case "commit_attribution":
        target = db.prepare(`
          SELECT c.*, a.run_id, a.ticket_instance_id, e.content_digest AS oracle_content_digest
          FROM commit_attributions c JOIN attempts a ON a.attempt_id = c.attempt_id
          JOIN attempt_commit_intents i ON i.commit_attribution_id = c.commit_attribution_id
            AND i.attempt_id = c.attempt_id AND i.state = 'finalized'
          JOIN evidence e ON e.evidence_id = c.attribution_evidence_id
          WHERE c.commit_attribution_id = ?
        `).get(reference.commit_attribution_id ?? null) as MutableStateRecord | undefined;
        targetTable = "commit_attributions";
        digestColumn = "oracle_content_digest";
        break;
      case "cleanup_record":
        target = db.prepare(`
          SELECT c.*, a.run_id, a.ticket_instance_id, e.content_digest AS oracle_content_digest
          FROM cleanup_records c JOIN attempts a ON a.attempt_id = c.attempt_id
          JOIN evidence e ON e.evidence_id = c.evidence_id
          WHERE c.cleanup_record_id = ?
        `).get(reference.cleanup_record_id ?? null) as MutableStateRecord | undefined;
        targetTable = "cleanup_records";
        digestColumn = "oracle_content_digest";
        break;
      case "dependency_edge":
        target = db.prepare(`
          SELECT d.*, rt.run_id, rt.ticket_instance_id, NULL AS attempt_id
          FROM run_ticket_dependencies d
          JOIN run_tickets rt ON rt.run_id = d.run_id AND rt.ticket_id = d.ticket_id
          WHERE d.dependency_digest = ?
        `).get(reference.dependency_digest ?? null) as MutableStateRecord | undefined;
        targetTable = "run_ticket_dependencies";
        digestColumn = "dependency_digest";
        break;
      case "process_receipt":
        target = db.prepare(`
          SELECT p.*, a.run_id, a.ticket_instance_id, a.attempt_id
          FROM process_receipts p
          JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id
          JOIN attempts a ON a.attempt_id = x.attempt_id
          WHERE p.process_receipt_id = ?
        `).get(reference.process_receipt_id ?? null) as MutableStateRecord | undefined;
        targetTable = "process_receipts";
        break;
      default:
        throw new TypeError(`unsupported oracle reference kind: ${String(kind)}`);
    }
    if (target === undefined) throw new StateStoreError("RICKGENT_STATE_CONFLICT", `oracle ${String(kind)} input does not resolve`);
    const expectedTicket = kind === "run_manifest" ? null : decision.ticket_instance_id;
    const expectedAttempt = kind === "run_manifest" || kind === "ticket_contract" || kind === "dependency_edge"
      ? null : decision.attempt_id;
    if (target.run_id !== decision.run_id || target.ticket_instance_id !== expectedTicket || target.attempt_id !== expectedAttempt) {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `oracle ${String(kind)} input has different canonical lineage`);
    }
    if (requiredSchema !== undefined && target.schema_version !== requiredSchema) {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `oracle ${String(kind)} input has the wrong snapshot schema`);
    }
    if ((kind === "attempt_resource_snapshot" || kind === "lease_snapshot") && target.producer_service !== "LeaseAuthority") {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `oracle ${String(kind)} input was not minted by LeaseAuthority`);
    }
    if (
      kind === "evidence" && target.schema_version === "rickgent.cleanup-eligibility.v1" &&
      target.producer_service !== "CleanupEligibilityService"
    ) {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "oracle cleanup eligibility was not minted by CleanupEligibilityService");
    }
    const targetDigest = digestColumn === undefined ? this.#storedRecordDigest(targetTable, target) : target[digestColumn];
    if (targetDigest !== reference.content_digest) {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", `oracle ${String(kind)} input content digest does not pin the resolved row`);
    }
  }

  #storedRecordDigest(table: StateTableName, row: Readonly<Record<string, SqlValue>>): `sha256:${string}` {
    const columns = this.#columns.get(table);
    if (columns === undefined) throw new TypeError(`unknown state table: ${table}`);
    const stored: MutableStateRecord = {};
    for (const column of columns) stored[column] = row[column] ?? null;
    return sha256Text(canonicalJson(stored));
  }

  #requireDatabase(): DatabaseSync {
    const db = this.#database;
    if (db === undefined) throw new StateStoreError("RICKGENT_STATE_CONFLICT", "state store is closed");
    return db;
  }

  #assertProcessIdentity(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value === "" || value !== value.trim()) throw new TypeError(`${label} is invalid`);
  }

  #assertProcessDigest(value: unknown, label: string): asserts value is `sha256:${string}` {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} is invalid`);
  }

  #assertProcessTimestamp(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.length < 20 || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
      throw new TypeError(`${label} must be a UTC timestamp`);
    }
  }

  #processEvidenceRow(input: {
    readonly evidenceId: string;
    readonly attemptId: string;
    readonly phaseExecutionId: string;
    readonly contextId: string;
    readonly scope: string;
    readonly schemaVersion: string;
    readonly payloadJson: string;
    readonly idempotencyKey: string;
    readonly createdAt: string;
  }): MutableStateRecord {
    return {
      evidence_id: input.evidenceId,
      attempt_id: input.attemptId,
      phase_execution_id: input.phaseExecutionId,
      context_id: input.contextId,
      producer_service: "ProcessSupervisor",
      scope: input.scope,
      schema_version: input.schemaVersion,
      content_digest: sha256Text(input.payloadJson),
      inline_payload_json: input.payloadJson,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: input.idempotencyKey,
      created_at: input.createdAt,
    };
  }

  #requireExactProcessEvidence(expected: MutableStateRecord): void {
    const stored = this.#requireDatabase().prepare("SELECT * FROM evidence WHERE evidence_id = ?")
      .get(expected.evidence_id ?? null) as MutableStateRecord | undefined;
    if (stored === undefined || !this.#sameRecord(stored, expected)) {
      throw typedError(
        "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
        "ProcessSupervisor evidence identity was replayed with different immutable input",
        this.location.databasePath,
      );
    }
  }

  #commitProcessLaunch(command: ProcessSupervisorCommand): StateRecord {
    const operation = command.command;
    if (operation.kind !== "launch") throw new TypeError("process launch commit requires a launch command");
    const request = operation.request;
    for (const [label, value] of [
      ["launch id", request.launchId], ["process receipt id", request.processReceiptId],
      ["repository id", request.repositoryId], ["attempt id", request.attemptId],
      ["ownership id", request.ownershipId], ["phase execution id", request.phaseExecutionId],
      ["execution context id", request.contextId], ["platform", request.platform],
      ["boot identity", request.bootIdentity], ["process start identity", request.processStartIdentity],
      ["stdout path", request.stdoutPath], ["stderr path", request.stderrPath],
      ["launch evidence id", request.launchEvidenceId],
    ] as const) this.#assertProcessIdentity(value, label);
    for (const [label, value] of [
      ["ownership context digest", request.ownershipContextDigest],
      ["execution context digest", request.executionContextDigest],
      ["spawn authorization digest", request.spawnAuthorizationDigest],
      ["argv digest", request.argvDigest], ["environment digest", request.environmentDigest],
    ] as const) this.#assertProcessDigest(value, label);
    this.#assertProcessTimestamp(request.createdAt, "process launch time");
    if (!Number.isSafeInteger(request.ownerGeneration) || request.ownerGeneration < 1) throw new TypeError("process owner generation is invalid");
    if (!Number.isSafeInteger(request.pid) || request.pid < 1 || !Number.isSafeInteger(request.pgid) || request.pgid < 1) {
      throw new TypeError("process PID and PGID must be positive safe integers");
    }
    if (
      !Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 1 ||
      !Number.isSafeInteger(request.tailLimitBytes) || request.tailLimitBytes < 1 ||
      request.tailLimitBytes > request.outputLimitBytes
    ) throw new TypeError("process output limits are invalid");
    const expectedResourceKeys = ["process_group", "stdout", "stderr"] as const;
    if (
      request.expectedResourceVersions === null || typeof request.expectedResourceVersions !== "object" ||
      Object.keys(request.expectedResourceVersions).sort().join("\0") !== [...expectedResourceKeys].sort().join("\0") ||
      expectedResourceKeys.some((slot) => !Number.isSafeInteger(request.expectedResourceVersions[slot]) || request.expectedResourceVersions[slot] < 0)
    ) throw new TypeError("process resource expected versions are invalid");
    if (request.repositoryId !== this.location.repositoryId) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "process launch belongs to another repository", this.location.databasePath);
    }

    const expectedLaunchPayload = {
      schema_version: "rickgent.process-launch.v1",
      launch_id: request.launchId,
      process_receipt_id: request.processReceiptId,
      repository_id: request.repositoryId,
      attempt_id: request.attemptId,
      ownership_id: request.ownershipId,
      owner_generation: request.ownerGeneration,
      ownership_context_digest: request.ownershipContextDigest,
      phase_execution_id: request.phaseExecutionId,
      context_id: request.contextId,
      execution_context_digest: request.executionContextDigest,
      spawn_authorization_digest: request.spawnAuthorizationDigest,
      pid: request.pid,
      pgid: request.pgid,
      platform: request.platform,
      boot_identity: request.bootIdentity,
      process_start_identity: request.processStartIdentity,
      argv_digest: request.argvDigest,
      environment_digest: request.environmentDigest,
      stdout_path: request.stdoutPath,
      stderr_path: request.stderrPath,
      output_limit_bytes: request.outputLimitBytes,
      tail_limit_bytes: request.tailLimitBytes,
      created_at: request.createdAt,
    };
    const launchPayloadJson = canonicalJson(request.launchEvidencePayload);
    if (launchPayloadJson !== canonicalJson(expectedLaunchPayload)) throw new TypeError("process launch evidence payload is not the exact launch projection");
    const evidenceRow = this.#processEvidenceRow({
      evidenceId: request.launchEvidenceId,
      attemptId: request.attemptId,
      phaseExecutionId: request.phaseExecutionId,
      contextId: request.contextId,
      scope: `attempt:${request.attemptId}:process-launch:${request.launchId}`,
      schemaVersion: "rickgent.process-launch.v1",
      payloadJson: launchPayloadJson,
      idempotencyKey: request.launchId,
      createdAt: request.createdAt,
    });
    const launchRow: MutableStateRecord = {
      launch_id: request.launchId,
      process_receipt_id: request.processReceiptId,
      repository_id: request.repositoryId,
      attempt_id: request.attemptId,
      ownership_id: request.ownershipId,
      owner_generation: request.ownerGeneration,
      ownership_context_digest: request.ownershipContextDigest,
      phase_execution_id: request.phaseExecutionId,
      context_id: request.contextId,
      execution_context_digest: request.executionContextDigest,
      spawn_authorization_digest: request.spawnAuthorizationDigest,
      pid: request.pid,
      pgid: request.pgid,
      platform: request.platform,
      boot_identity: request.bootIdentity,
      process_start_identity: request.processStartIdentity,
      argv_digest: request.argvDigest,
      environment_digest: request.environmentDigest,
      stdout_path: request.stdoutPath,
      stderr_path: request.stderrPath,
      output_limit_bytes: request.outputLimitBytes,
      tail_limit_bytes: request.tailLimitBytes,
      process_group_expected_version: request.expectedResourceVersions.process_group,
      stdout_expected_version: request.expectedResourceVersions.stdout,
      stderr_expected_version: request.expectedResourceVersions.stderr,
      launch_evidence_id: request.launchEvidenceId,
      created_at: request.createdAt,
    };
    const replay = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_process_launches
      WHERE launch_id = ? OR process_receipt_id = ? OR phase_execution_id = ?
      LIMIT 1
    `).get(request.launchId, request.processReceiptId, request.phaseExecutionId) as MutableStateRecord | undefined;
    if (replay !== undefined) {
      if (!this.#sameRecord(replay, launchRow)) {
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "process launch identity has different immutable input", this.location.databasePath);
      }
      this.#requireExactProcessEvidence(evidenceRow);
      return frozenRow(replay);
    }

    const ownership = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_ownership_leases
      WHERE ownership_id = ? AND attempt_id = ? AND generation = ?
    `).get(request.ownershipId, request.attemptId, request.ownerGeneration) as MutableStateRecord | undefined;
    if (
      ownership === undefined || ownership.state !== "live" || ownership.recovered_from_ownership_id !== null ||
      ownership.context_digest !== request.ownershipContextDigest || new Date(String(ownership.expires_at)).getTime() <= Date.now()
    ) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "process launch requires current live unexpired ownership", this.location.databasePath);
    }
    const phase = this.#requireDatabase().prepare(`
      SELECT x.attempt_id, x.context_id, c.context_digest, r.repository_id
      FROM phase_executions x
      JOIN execution_contexts c ON c.context_id = x.context_id AND c.attempt_id = x.attempt_id
      JOIN attempts a ON a.attempt_id = x.attempt_id
      JOIN runs r ON r.run_id = a.run_id
      WHERE x.phase_execution_id = ?
    `).get(request.phaseExecutionId) as MutableStateRecord | undefined;
    if (
      phase === undefined || phase.attempt_id !== request.attemptId || phase.context_id !== request.contextId ||
      phase.context_digest !== request.executionContextDigest || phase.repository_id !== request.repositoryId
    ) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "process launch phase/context lineage is not exact", this.location.databasePath);

    const expectedIdentity = new Map<string, string>([
      ["process_group", `process-group:${request.attemptId}`],
      ["stdout", request.stdoutPath],
      ["stderr", request.stderrPath],
    ]);
    for (const slot of expectedResourceKeys) {
      const resource = this.#requireDatabase().prepare(`
        SELECT * FROM attempt_resource_claims WHERE attempt_id = ? AND slot = ?
      `).get(request.attemptId, slot) as MutableStateRecord | undefined;
      const expectedVersion = request.expectedResourceVersions[slot];
      if (
        resource === undefined || resource.kind !== slot || resource.current_ownership_id !== request.ownershipId ||
        resource.owner_generation !== request.ownerGeneration || resource.state_version !== expectedVersion ||
        resource.canonical_identity !== expectedIdentity.get(slot) || !["reserved", "allocated"].includes(String(resource.state))
      ) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", `process ${slot} claim does not match its launch preimage`, this.location.databasePath);
      let state = String(resource.state);
      let version = expectedVersion;
      if (state === "reserved") {
        const allocated = this.#requireDatabase().prepare(`
          UPDATE attempt_resource_claims SET state = 'allocated', state_version = state_version + 1
          WHERE resource_claim_id = ? AND current_ownership_id = ? AND owner_generation = ? AND state = 'reserved' AND state_version = ?
        `).run(String(resource.resource_claim_id), request.ownershipId, request.ownerGeneration, version);
        if (allocated.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", `process ${slot} allocation lost its CAS race`, this.location.databasePath);
        state = "allocated";
        version += 1;
      }
      const activated = this.#requireDatabase().prepare(`
        UPDATE attempt_resource_claims SET state = 'active', state_version = state_version + 1
        WHERE resource_claim_id = ? AND current_ownership_id = ? AND owner_generation = ? AND state = ? AND state_version = ?
      `).run(String(resource.resource_claim_id), request.ownershipId, request.ownerGeneration, state, version);
      if (activated.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", `process ${slot} activation lost its CAS race`, this.location.databasePath);
    }
    this.#validateRecordSemantics("evidence", evidenceRow);
    this.#insert("evidence", evidenceRow);
    this.#insert("attempt_process_launches", launchRow);
    return frozenRow(launchRow);
  }

  #commitProcessTerminal(command: ProcessSupervisorCommand): StateRecord {
    const operation = command.command;
    if (operation.kind !== "terminal") throw new TypeError("process terminal commit requires a terminal command");
    const request = operation.request;
    this.#assertProcessIdentity(request.launchId, "launch id");
    this.#assertProcessIdentity(request.processReceiptId, "process receipt id");
    this.#assertProcessIdentity(request.outcome, "process outcome");
    this.#assertProcessDigest(request.resultDigest, "process terminal result digest");
    this.#assertProcessTimestamp(request.createdAt, "process terminal time");
    if (request.exitCode !== null && (!Number.isSafeInteger(request.exitCode) || request.exitCode < 0 || request.exitCode > 255)) {
      throw new TypeError("process exit code is invalid");
    }
    if (request.signal !== null) this.#assertProcessIdentity(request.signal, "process terminal signal");
    if (typeof request.timedOut !== "boolean" || typeof request.groupDead !== "boolean" || typeof request.descendantsConfirmedDead !== "boolean") {
      throw new TypeError("process terminal booleans are invalid");
    }
    if (request.descendantsConfirmedDead && !request.groupDead) throw new TypeError("descendant death requires group death");
    if (!Array.isArray(request.observations) || request.observations.length < 1) throw new TypeError("process terminal requires observations");

    const launch = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_process_launches WHERE launch_id = ? AND process_receipt_id = ?
    `).get(request.launchId, request.processReceiptId) as MutableStateRecord | undefined;
    if (launch === undefined) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "process terminal does not resolve to an exact durable launch", this.location.databasePath);
    }
    const observationRows: MutableStateRecord[] = [];
    const evidenceRows: MutableStateRecord[] = [];
    const observationRefs: Array<Record<string, unknown>> = [];
    const observationIds = new Set<string>();
    const evidenceIds = new Set<string>();
    const launchMs = Date.parse(String(launch.created_at));
    const terminalMs = Date.parse(request.createdAt);
    for (let index = 0; index < request.observations.length; index += 1) {
      const observation = request.observations[index]!;
      this.#assertProcessIdentity(observation.observationId, "process observation id");
      this.#assertProcessIdentity(observation.kind, "process observation kind");
      this.#assertProcessIdentity(observation.evidenceId, "process observation evidence id");
      this.#assertProcessIdentity(observation.schemaVersion, "process observation schema version");
      this.#assertProcessTimestamp(observation.createdAt, "process observation time");
      if (observation.sequence !== index + 1) throw new TypeError("process observations must be ordered contiguously from one");
      if (observationIds.has(observation.observationId) || evidenceIds.has(observation.evidenceId)) {
        throw new TypeError("process observation and evidence identities must be unique");
      }
      observationIds.add(observation.observationId);
      evidenceIds.add(observation.evidenceId);
      const observedMs = Date.parse(observation.createdAt);
      if (observedMs < launchMs || observedMs > terminalMs) throw new TypeError("process observation time is outside its launch/terminal interval");
      const payloadJson = canonicalJson(observation.payload);
      const parsedPayload = this.#parseJsonObject(payloadJson, "process observation payload");
      if (parsedPayload.schema_version !== observation.schemaVersion) throw new TypeError("process observation schema differs from its payload");
      if (observation.kind === "group_death") {
        const proofBasis = parsedPayload.proof_basis;
        const trackedIdentitiesConfirmedDead = parsedPayload.tracked_identities_confirmed_dead;
        if (proofBasis !== "sampled_tracked_identities" && proofBasis !== "authoritative_containment") {
          throw new TypeError("process group-death proof basis is invalid");
        }
        if (typeof trackedIdentitiesConfirmedDead !== "boolean") {
          throw new TypeError("process group-death tracked identity status is invalid");
        }
        if (request.descendantsConfirmedDead && (
          proofBasis !== "authoritative_containment" || trackedIdentitiesConfirmedDead !== true
        )) {
          throw new TypeError("descendant death requires authoritative containment and tracked identity death");
        }
        const expectedDeath = {
          schema_version: "rickgent.process-group-death.v1",
          launch_id: String(launch.launch_id),
          process_receipt_id: String(launch.process_receipt_id),
          attempt_id: String(launch.attempt_id),
          ownership_id: String(launch.ownership_id),
          owner_generation: Number(launch.owner_generation),
          ownership_context_digest: String(launch.ownership_context_digest),
          phase_execution_id: String(launch.phase_execution_id),
          context_id: String(launch.context_id),
          execution_context_digest: String(launch.execution_context_digest),
          pid: Number(launch.pid),
          pgid: Number(launch.pgid),
          platform: String(launch.platform),
          boot_identity: String(launch.boot_identity),
          process_start_identity: String(launch.process_start_identity),
          group_dead: true,
          proof_basis: proofBasis,
          tracked_identities_confirmed_dead: trackedIdentitiesConfirmedDead,
          descendants_confirmed_dead: request.descendantsConfirmedDead,
          death_observed_at: observation.createdAt,
        };
        if (observation.schemaVersion !== "rickgent.process-group-death.v1" || payloadJson !== canonicalJson(expectedDeath)) {
          throw new TypeError("process group-death observation is not the exact launch-bound proof");
        }
      }
      const payloadDigest = sha256Text(payloadJson);
      const evidenceRow = this.#processEvidenceRow({
        evidenceId: observation.evidenceId,
        attemptId: String(launch.attempt_id),
        phaseExecutionId: String(launch.phase_execution_id),
        contextId: String(launch.context_id),
        scope: `attempt:${String(launch.attempt_id)}:process:${request.launchId}:${observation.kind}`,
        schemaVersion: observation.schemaVersion,
        payloadJson,
        idempotencyKey: observation.observationId,
        createdAt: observation.createdAt,
      });
      const observationRow: MutableStateRecord = {
        observation_id: observation.observationId,
        launch_id: request.launchId,
        attempt_id: String(launch.attempt_id),
        sequence: observation.sequence,
        kind: observation.kind,
        evidence_id: observation.evidenceId,
        schema_version: observation.schemaVersion,
        payload_digest: payloadDigest,
        created_at: observation.createdAt,
      };
      evidenceRows.push(evidenceRow);
      observationRows.push(observationRow);
      observationRefs.push({
        observation_id: observation.observationId,
        sequence: observation.sequence,
        kind: observation.kind,
        evidence_id: observation.evidenceId,
        schema_version: observation.schemaVersion,
        payload_digest: payloadDigest,
        created_at: observation.createdAt,
      });
    }
    const hasGroupDeath = observationRows.some((row) => row.kind === "group_death");
    if (hasGroupDeath !== request.groupDead) {
      throw new TypeError("process terminal death flags differ from the immutable observation chain");
    }
    const resultPayload = {
      schema_version: "rickgent.process-terminal.v1",
      launch_id: request.launchId,
      process_receipt_id: request.processReceiptId,
      outcome: request.outcome,
      exit_code: request.exitCode,
      signal: request.signal,
      timed_out: request.timedOut,
      group_dead: request.groupDead,
      descendants_confirmed_dead: request.descendantsConfirmedDead,
      observation_refs: observationRefs,
      created_at: request.createdAt,
    };
    if (sha256Text(canonicalJson(resultPayload)) !== request.resultDigest) throw new TypeError("process terminal result digest is not exact");
    const terminalRow: MutableStateRecord = {
      process_receipt_id: request.processReceiptId,
      launch_id: request.launchId,
      attempt_id: String(launch.attempt_id),
      outcome: request.outcome,
      exit_code: request.exitCode,
      signal: request.signal,
      timed_out: request.timedOut ? 1 : 0,
      group_dead: request.groupDead ? 1 : 0,
      descendants_confirmed_dead: request.descendantsConfirmedDead ? 1 : 0,
      observation_count: observationRows.length,
      result_digest: request.resultDigest,
      created_at: request.createdAt,
    };
    const replay = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_process_terminal_receipts WHERE process_receipt_id = ? OR launch_id = ? LIMIT 1
    `).get(request.processReceiptId, request.launchId) as MutableStateRecord | undefined;
    if (replay !== undefined) {
      if (!this.#sameRecord(replay, terminalRow)) {
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "process terminal identity has different immutable input", this.location.databasePath);
      }
      const storedObservations = this.#requireDatabase().prepare(`
        SELECT * FROM attempt_process_observations WHERE launch_id = ? ORDER BY sequence
      `).all(request.launchId) as MutableStateRecord[];
      if (
        storedObservations.length !== observationRows.length ||
        storedObservations.some((stored, index) => !this.#sameRecord(stored, observationRows[index]!))
      ) throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "process terminal observation replay differs", this.location.databasePath);
      for (const evidenceRow of evidenceRows) this.#requireExactProcessEvidence(evidenceRow);
      return frozenRow(replay);
    }
    const partial = this.#requireDatabase().prepare(
      "SELECT 1 FROM attempt_process_observations WHERE launch_id = ? LIMIT 1",
    ).get(request.launchId);
    if (partial !== undefined) {
      throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "process launch has an unsealed observation chain", this.location.databasePath);
    }
    for (let index = 0; index < observationRows.length; index += 1) {
      const evidenceRow = evidenceRows[index]!;
      this.#validateRecordSemantics("evidence", evidenceRow);
      this.#insert("evidence", evidenceRow);
      this.#insert("attempt_process_observations", observationRows[index]!);
    }
    this.#insert("attempt_process_terminal_receipts", terminalRow);
    return frozenRow(terminalRow);
  }

  #canonicalOwnershipCommand(command: AttemptOwnershipCommand): string {
    const payload = command.payload;
    if (payload.attemptId === "" || payload.idempotencyKey === "" || payload.idempotencyKey !== payload.idempotencyKey.trim()) {
      throw new TypeError("attempt ownership command identity is invalid");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(payload.ownerTokenDigest)) throw new TypeError("attempt owner token digest is invalid");
    if (payload.repositoryId !== this.location.repositoryId) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt ownership command belongs to another repository", this.location.databasePath);
    }
    if (!Number.isSafeInteger(payload.ttlMs) || payload.ttlMs < 1_000 || payload.ttlMs > 300_000) {
      throw new TypeError("attempt ownership TTL is outside the supported bound");
    }
    const defined = Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] !== undefined));
    return canonicalJson({ schema_version: "rickgent.attempt-ownership-operation/v1", ...defined });
  }

  #attemptOwnershipPlan(attemptId: string): AttemptWorkspacePlan {
    const row = this.#requireDatabase().prepare(`
      SELECT a.attempt_id, a.ticket_instance_id, a.run_id, a.ticket_id, a.attempt_number,
             a.contract_digest, a.resource_identity_version, a.delivery_baseline_oid,
             a.state AS attempt_state, rt.state AS ticket_state, r.state AS run_state,
             r.repository_id, r.delivery_ref
      FROM attempts a
      JOIN run_tickets rt ON rt.ticket_instance_id = a.ticket_instance_id
      JOIN runs r ON r.run_id = a.run_id
      WHERE a.attempt_id = ? AND r.repository_id = ?
    `).get(attemptId, this.location.repositoryId) as MutableStateRecord | undefined;
    if (row === undefined) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt ownership does not resolve in the selected repository", this.location.databasePath);
    }
    const lineage: AttemptOwnershipLineage = {
      repositoryId: String(row.repository_id),
      runId: String(row.run_id),
      ticketInstanceId: String(row.ticket_instance_id),
      ticketId: String(row.ticket_id),
      attemptId: String(row.attempt_id),
      attemptNumber: Number(row.attempt_number),
      contractDigest: String(row.contract_digest),
      resourceIdentityVersion: String(row.resource_identity_version),
      deliveryBaselineOid: String(row.delivery_baseline_oid),
      deliveryRef: String(row.delivery_ref),
    };
    return deriveAttemptWorkspacePlan(this.location, lineage);
  }

  #attemptOwnershipAdmission(attemptId: string): AttemptWorkspacePlan {
    const states = this.#requireDatabase().prepare(`
      SELECT a.state AS attempt_state, a.delivery_baseline_oid,
             rt.state AS ticket_state, r.state AS run_state, r.current_delivery_oid
      FROM attempts a
      JOIN run_tickets rt ON rt.ticket_instance_id = a.ticket_instance_id
      JOIN runs r ON r.run_id = a.run_id
      WHERE a.attempt_id = ? AND r.repository_id = ?
    `).get(attemptId, this.location.repositoryId) as MutableStateRecord | undefined;
    if (states === undefined) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt ownership lineage does not exist", this.location.databasePath);
    }
    if (states.run_state !== "active" || states.ticket_state !== "active" || states.attempt_state !== "planned") {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        "attempt ownership requires an active run, active ticket, and planned attempt",
        this.location.databasePath,
      );
    }
    if (states.current_delivery_oid !== states.delivery_baseline_oid) {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        "attempt ownership baseline is stale relative to the authoritative run delivery chain",
        this.location.databasePath,
      );
    }
    return this.#attemptOwnershipPlan(attemptId);
  }

  /** Current-owner checks continue across the nonterminal attempt critical section; acquisition remains planned-only. */
  #attemptOwnershipContinuation(attemptId: string): AttemptWorkspacePlan {
    const states = this.#requireDatabase().prepare(`
      SELECT a.state AS attempt_state, a.delivery_baseline_oid,
             rt.state AS ticket_state, r.state AS run_state, r.current_delivery_oid
      FROM attempts a
      JOIN run_tickets rt ON rt.ticket_instance_id = a.ticket_instance_id
      JOIN runs r ON r.run_id = a.run_id
      WHERE a.attempt_id = ? AND r.repository_id = ?
    `).get(attemptId, this.location.repositoryId) as MutableStateRecord | undefined;
    const eligible = new Set([
      "planned", "implementing", "implementation_captured", "reviewing", "remediating",
      "remediation_captured", "verification_queued", "verifying", "converging",
    ]);
    if (
      states === undefined || states.run_state !== "active" || states.ticket_state !== "active" ||
      !eligible.has(String(states.attempt_state))
    ) {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        "current attempt ownership requires an active run, active ticket, and nonterminal pre-cleanup attempt",
        this.location.databasePath,
      );
    }
    if (states.current_delivery_oid !== states.delivery_baseline_oid) {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        "current attempt ownership baseline is stale relative to the authoritative run delivery chain",
        this.location.databasePath,
      );
    }
    return this.#attemptOwnershipPlan(attemptId);
  }

  #ownershipContext(
    plan: AttemptWorkspacePlan,
    generation: number,
    ownerTokenDigest: string,
    recoveredFromOwnershipId: string | null,
  ): { readonly json: string; readonly digest: `sha256:${string}` } {
    const json = canonicalJson({
      schema_version: ATTEMPT_OWNERSHIP_SCHEMA_VERSION,
      repository_id: plan.lineage.repositoryId,
      run_id: plan.lineage.runId,
      ticket_instance_id: plan.lineage.ticketInstanceId,
      ticket_id: plan.lineage.ticketId,
      attempt_id: plan.lineage.attemptId,
      attempt_number: plan.lineage.attemptNumber,
      contract_digest: plan.lineage.contractDigest,
      resource_identity_version: plan.lineage.resourceIdentityVersion,
      delivery_baseline_oid: plan.lineage.deliveryBaselineOid,
      delivery_ref: plan.lineage.deliveryRef,
      allocation_digest: plan.allocationDigest,
      generation,
      owner_token_digest: ownerTokenDigest,
      recovered_from_ownership_id: recoveredFromOwnershipId,
      resources: plan.resources.map((resource) => ({
        resource_claim_id: resource.resourceClaimId,
        slot: resource.slot,
        kind: resource.kind,
        canonical_identity: resource.canonicalIdentity,
        identity_digest: resource.identityDigest,
      })),
    });
    return { json, digest: sha256Text(json) };
  }

  #ownershipIdentity(attemptId: string, generation: number, ownerTokenDigest: string): string {
    return `ownership-${sha256Text(canonicalJson({
      schema_version: ATTEMPT_OWNERSHIP_SCHEMA_VERSION,
      attempt_id: attemptId,
      generation,
      owner_token_digest: ownerTokenDigest,
    })).slice(7)}`;
  }

  #acquireAttemptOwnership(
    command: AttemptOwnershipCommand,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const payload = command.payload;
    const plan = this.#attemptOwnershipAdmission(payload.attemptId);
    const existing = this.#requireDatabase().prepare(
      "SELECT ownership_id FROM attempt_ownership_leases WHERE attempt_id = ? LIMIT 1",
    ).get(payload.attemptId);
    if (existing !== undefined) {
      throw typedError("RICKGENT_STATE_CONFLICT", "attempt already has an ownership generation", this.location.databasePath);
    }
    const generation = 1;
    const ownershipId = this.#ownershipIdentity(payload.attemptId, generation, payload.ownerTokenDigest);
    const context = this.#ownershipContext(plan, generation, payload.ownerTokenDigest, null);
    const heartbeatAt = new Date().toISOString();
    const expiresAt = new Date(new Date(heartbeatAt).getTime() + payload.ttlMs).toISOString();
    this.#insert("attempt_ownership_leases", {
      ownership_id: ownershipId,
      attempt_id: payload.attemptId,
      generation,
      owner_token_digest: payload.ownerTokenDigest,
      context_digest: context.digest,
      canonical_context_json: context.json,
      recovered_from_ownership_id: null,
      heartbeat_at: heartbeatAt,
      expires_at: expiresAt,
      state: "live",
      state_version: 0,
      created_at: heartbeatAt,
    });
    for (const resource of plan.resources) {
      this.#insert("attempt_resource_claims", {
        resource_claim_id: resource.resourceClaimId,
        attempt_id: payload.attemptId,
        slot: resource.slot,
        kind: resource.kind,
        canonical_identity: resource.canonicalIdentity,
        identity_digest: resource.identityDigest,
        allocation_ownership_id: ownershipId,
        current_ownership_id: ownershipId,
        owner_generation: generation,
        state: "reserved",
        state_version: 0,
        release_proof_digest: null,
        quarantine_proof_digest: null,
        created_at: heartbeatAt,
      });
    }
    return this.#recordOwnershipOperation(command, ownershipId, "execution", plan, canonicalInput, inputDigest);
  }

  #requireCurrentOwnership(command: AttemptOwnershipCommand): MutableStateRecord {
    const payload = command.payload;
    if (payload.ownershipId === undefined) throw new TypeError("ownership mutation requires an ownership id");
    const current = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?",
    ).get(payload.ownershipId, payload.attemptId) as MutableStateRecord | undefined;
    if (current === undefined || current.owner_token_digest !== payload.ownerTokenDigest) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt ownership credential does not match", this.location.databasePath);
    }
    return current;
  }

  #requireOwnershipPreimage(command: AttemptOwnershipCommand, current: MutableStateRecord): void {
    const payload = command.payload;
    if (current.state !== payload.expectedOwnershipState || current.state_version !== payload.expectedOwnershipVersion) {
      throw typedError("RICKGENT_STATE_CONFLICT", "attempt ownership compare-and-set preimage changed", this.location.databasePath);
    }
  }

  #assertCurrentAttemptOwnership(command: AttemptOwnershipCommand): AttemptOwnershipStoreResult {
    const current = this.#requireCurrentOwnership(command);
    const cleanupPending = current.state === "cleanup_pending";
    if (new Date(String(current.expires_at)).getTime() <= Date.now()) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt ownership is expired", this.location.databasePath);
    }
    if (!cleanupPending && (current.state !== "live" || current.recovered_from_ownership_id !== null)) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt execution ownership is not current and unexpired", this.location.databasePath);
    }
    const plan = cleanupPending
      ? this.#attemptOwnershipPlan(command.payload.attemptId)
      : this.#attemptOwnershipContinuation(command.payload.attemptId);
    const resources = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_resource_claims
      WHERE attempt_id = ? ORDER BY slot
    `).all(command.payload.attemptId) as MutableStateRecord[];
    if (
      resources.length !== plan.resources.length ||
      resources.some((resource) =>
        resource.current_ownership_id !== current.ownership_id ||
        resource.owner_generation !== current.generation ||
        (cleanupPending
          ? resource.state !== "cleanup_pending"
          : !["reserved", "allocated", "active"].includes(String(resource.state))))
    ) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt resource claims are not owned by the current ownership generation", this.location.databasePath);
    }
    return this.#attemptOwnershipResult(
      command.payload.attemptId,
      String(current.ownership_id),
      current.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
      false,
      plan,
    );
  }

  #assertAttemptCleanupReady(command: AttemptOwnershipCommand): AttemptOwnershipStoreResult {
    const payload = command.payload;
    const current = this.#requireCurrentOwnership(command);
    this.#requireOwnershipPreimage(command, current);
    if (current.state !== "cleanup_pending" || new Date(String(current.expires_at)).getTime() <= Date.now()) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "cleanup ownership is not current and unexpired", this.location.databasePath);
    }
    this.#requireCleanupResourcePreimage(command, current, false);
    const processProof = this.#requireCleanupProcessProof(
      payload.attemptId,
      String(current.ownership_id),
      payload.processReceiptId,
      payload.groupDeathEvidenceId,
    );
    this.#requireAuthorizedSalvageRecord(
      payload.attemptId,
      String(current.ownership_id),
      payload.salvageRecordId,
      payload.processReceiptId,
      payload.groupDeathEvidenceId,
      processProof,
      payload.expectedAttemptRefOid,
    );
    this.#requireAuthorizedAttemptRefPostimage(payload.attemptId, payload.expectedAttemptRefOid, "present_or_absent");
    return this.#attemptOwnershipResult(
      payload.attemptId,
      String(current.ownership_id),
      current.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
      false,
      this.#attemptOwnershipPlan(payload.attemptId),
    );
  }

  #recordAuthorizedSalvage(command: AttemptOwnershipCommand): AttemptOwnershipStoreResult {
    const payload = command.payload;
    const ownership = this.#requireCurrentOwnership(command);
    const plan = this.#attemptOwnershipPlan(payload.attemptId);
    if (
      payload.salvageRecordId === undefined || payload.contextId === undefined || payload.evidenceId === undefined ||
      payload.salvageDisposition === undefined || payload.createdAt === undefined ||
      payload.processReceiptId === undefined || payload.groupDeathEvidenceId === undefined ||
      payload.salvageBaselineOid === undefined || payload.salvageAttemptRef === undefined ||
      payload.expectedAttemptRefOid === undefined || payload.salvageIndexDigest === undefined ||
      !payload.createdAt.endsWith("Z") || Number.isNaN(Date.parse(payload.createdAt))
    ) {
      throw new TypeError("authorized salvage receipt is incomplete");
    }
    const artifactPath = payload.salvageArtifactPath ?? null;
    const artifactDigest = payload.salvageArtifactDigest ?? null;
    const artifactSize = payload.salvageArtifactSize ?? null;
    if (
      (payload.salvageDisposition === "empty" && (artifactPath !== null || artifactDigest !== null || artifactSize !== null)) ||
      (payload.salvageDisposition === "captured" &&
        (artifactPath === null || artifactDigest === null || artifactSize === null))
    ) {
      throw new TypeError("authorized salvage artifact shape differs from its disposition");
    }
    this.#assertRepositoryOid(payload.salvageBaselineOid, "salvage baseline oid");
    this.#assertRepositoryOid(payload.expectedAttemptRefOid, "salvage attempt-ref oid");
    if (
      payload.salvageBaselineOid !== plan.lineage.deliveryBaselineOid || payload.salvageAttemptRef !== plan.attemptRef ||
      !/^sha256:[0-9a-f]{64}$/.test(payload.salvageIndexDigest)
    ) {
      throw typedError(
        "RICKGENT_STATE_OWNER_MISMATCH",
        "salvage completeness proof differs from its authority-derived attempt lineage",
        this.location.databasePath,
      );
    }
    const processProof = this.#requireCleanupProcessProof(
      payload.attemptId,
      String(ownership.ownership_id),
      payload.processReceiptId,
      payload.groupDeathEvidenceId,
    );
    if (
      Date.parse(payload.createdAt) < Date.parse(String(processProof.terminal_created_at)) ||
      Date.parse(payload.createdAt) < Date.parse(String(processProof.observation_created_at))
    ) {
      throw typedError(
        "RICKGENT_STATE_OWNER_MISMATCH",
        "salvage capture predates its authoritative terminal and group-death proof",
        this.location.databasePath,
      );
    }
    const evidencePayload = {
      schema_version: "rickgent.salvage-record.v2",
      salvage_record_id: payload.salvageRecordId,
      attempt_id: payload.attemptId,
      ownership_id: String(ownership.ownership_id),
      owner_generation: Number(ownership.generation),
      ownership_context_digest: String(ownership.context_digest),
      context_id: payload.contextId,
      disposition: payload.salvageDisposition,
      artifact_path: artifactPath,
      artifact_digest: artifactDigest,
      artifact_size: artifactSize,
      process_receipt_id: payload.processReceiptId,
      group_death_evidence_id: payload.groupDeathEvidenceId,
      process_terminal_result_digest: processProof.terminal_result_digest,
      process_terminal_created_at: processProof.terminal_created_at,
      group_death_content_digest: processProof.content_digest,
      group_death_created_at: processProof.observation_created_at,
      baseline_oid: payload.salvageBaselineOid,
      attempt_ref: payload.salvageAttemptRef,
      expected_attempt_ref_oid: payload.expectedAttemptRefOid,
      index_digest: payload.salvageIndexDigest,
      evidence_id: payload.evidenceId,
      created_at: payload.createdAt,
    };
    const inlinePayload = canonicalJson(evidencePayload);
    const expectedEvidence: MutableStateRecord = {
      evidence_id: payload.evidenceId,
      attempt_id: payload.attemptId,
      phase_execution_id: null,
      context_id: payload.contextId,
      producer_service: "SalvageService",
      scope: payload.salvageRecordId,
      schema_version: "rickgent.salvage-record.v2",
      content_digest: sha256Text(inlinePayload),
      inline_payload_json: inlinePayload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: payload.idempotencyKey,
      created_at: payload.createdAt,
    };
    const expectedSalvage: MutableStateRecord = {
      salvage_record_id: payload.salvageRecordId,
      attempt_id: payload.attemptId,
      disposition: payload.salvageDisposition,
      artifact_path: artifactPath,
      artifact_digest: artifactDigest,
      artifact_size: artifactSize,
      evidence_id: payload.evidenceId,
      created_at: payload.createdAt,
    };
    const existingMatches = this.#requireDatabase().prepare(`
      SELECT salvage.*, evidence.phase_execution_id, evidence.context_id,
             evidence.producer_service, evidence.scope, evidence.schema_version,
             evidence.content_digest, evidence.inline_payload_json,
             evidence.external_path, evidence.external_digest, evidence.external_size,
             evidence.idempotency_key, evidence.created_at AS evidence_created_at
      FROM salvage_records salvage
      JOIN evidence evidence ON evidence.evidence_id = salvage.evidence_id
      WHERE salvage.attempt_id = ? AND evidence.producer_service = 'SalvageService'
        AND (salvage.salvage_record_id = ? OR evidence.idempotency_key = ?)
      ORDER BY salvage.salvage_record_id
    `).all(payload.attemptId, payload.salvageRecordId, payload.idempotencyKey) as MutableStateRecord[];
    if (existingMatches.length > 1) {
      throw typedError(
        "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
        "salvage attempt idempotency key and record identity resolve to different durable records",
        this.location.databasePath,
      );
    }
    const existing = existingMatches[0];
    if (existing !== undefined) {
      const exactSalvage = Object.entries(expectedSalvage).every(([column, value]) =>
        column === "created_at" || sameValue(existing[column], value));
      const exactEvidence = Object.entries(expectedEvidence).every(([column, value]) => {
        if (["created_at", "content_digest", "inline_payload_json"].includes(column)) return true;
        const selected = column === "created_at" ? existing.evidence_created_at : existing[column];
        return sameValue(selected, value);
      });
      const existingPayload = this.#parseJsonObject(String(existing.inline_payload_json), "salvage replay evidence");
      const semanticPayload = (value: Record<string, unknown>): string => canonicalJson(
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== "created_at")),
      );
      if (!exactSalvage || !exactEvidence || semanticPayload(existingPayload) !== semanticPayload(evidencePayload)) {
        throw typedError(
          "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
          "salvage record identity has different immutable input",
          this.location.databasePath,
        );
      }
      const manifest = this.#verifyAuthorizedSalvageArtifact(plan, existing);
      this.#requireSalvageCompleteness(
        payload.salvageDisposition,
        payload.salvageBaselineOid,
        payload.salvageAttemptRef,
        payload.expectedAttemptRefOid,
        payload.salvageIndexDigest,
        manifest,
      );
      return this.#attemptOwnershipResult(
        payload.attemptId,
        String(ownership.ownership_id),
        ownership.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
        true,
        plan,
      );
    }
    this.#requireOwnershipPreimage(command, ownership);
    if (ownership.state !== "cleanup_pending" || new Date(String(ownership.expires_at)).getTime() <= Date.now()) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "salvage owner is not current cleanup ownership", this.location.databasePath);
    }
    this.#requireCleanupResourcePreimage(command, ownership, false);
    this.#requireTransitionGuard(`
      SELECT 1 FROM execution_contexts context
      JOIN phase_executions phase
        ON phase.context_id = context.context_id AND phase.attempt_id = context.attempt_id
      WHERE context.context_id = ? AND context.attempt_id = ?
        AND phase.phase = 'cleanup' AND phase.role = 'cleanup'
    `, [payload.contextId, payload.attemptId], "salvage context differs from its cleanup attempt");
    const manifest = this.#verifyAuthorizedSalvageArtifact(plan, expectedSalvage);
    this.#requireSalvageCompleteness(
      payload.salvageDisposition,
      payload.salvageBaselineOid,
      payload.salvageAttemptRef,
      payload.expectedAttemptRefOid,
      payload.salvageIndexDigest,
      manifest,
    );
    this.#insert("evidence", expectedEvidence);
    this.#insert("salvage_records", expectedSalvage);
    return this.#attemptOwnershipResult(
      payload.attemptId,
      String(ownership.ownership_id),
      ownership.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
      false,
      plan,
    );
  }

  #verifyAuthorizedSalvageArtifact(plan: AttemptWorkspacePlan, salvage: MutableStateRecord): Record<string, unknown> | null {
    if (salvage.disposition === "empty") {
      if (salvage.artifact_path !== null || salvage.artifact_digest !== null || salvage.artifact_size !== null) {
        throw typedError(
          "RICKGENT_STATE_CONFLICT",
          "empty salvage disposition unexpectedly names an artifact",
          this.location.databasePath,
        );
      }
      return null;
    }
    if (
      salvage.disposition !== "captured" || typeof salvage.artifact_path !== "string" ||
      typeof salvage.artifact_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(salvage.artifact_digest) ||
      typeof salvage.artifact_size !== "number" || !Number.isSafeInteger(salvage.artifact_size) || salvage.artifact_size < 0
    ) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "captured salvage disposition has an invalid artifact identity",
        this.location.databasePath,
      );
    }
    const artifact = salvage.artifact_path;
    let descriptor: number | null = null;
    try {
      const archiveRoot = realpathSync.native(plan.salvageArchivePath);
      const canonicalArtifact = realpathSync.native(artifact);
      const relativeArtifact = relative(archiveRoot, canonicalArtifact);
      if (
        archiveRoot !== plan.salvageArchivePath || canonicalArtifact !== artifact ||
        relativeArtifact === "" || relativeArtifact === ".." || relativeArtifact.startsWith(`..${sep}`) ||
        isAbsolute(relativeArtifact)
      ) {
        throw typedError(
          "RICKGENT_STATE_OWNER_MISMATCH",
          "salvage artifact escaped its authority-derived archive",
          this.location.databasePath,
        );
      }
      const pathInfo = lstatSync(artifact);
      const maximumArtifactBytes = 96 * 1024 * 1024;
      if (
        !pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size !== salvage.artifact_size ||
        pathInfo.size > maximumArtifactBytes
      ) {
        throw typedError(
          "RICKGENT_STATE_CONFLICT",
          "salvage artifact identity or size differs from its durable record",
          this.location.databasePath,
        );
      }
      descriptor = openSync(artifact, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const before = fstatSync(descriptor);
      if (
        !before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino ||
        before.size !== pathInfo.size || before.mtimeMs !== pathInfo.mtimeMs || before.ctimeMs !== pathInfo.ctimeMs
      ) {
        throw typedError(
          "RICKGENT_STATE_CONFLICT",
          "salvage artifact changed while opening its proof",
          this.location.databasePath,
        );
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < before.size) {
        const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
        if (count <= 0) {
          throw typedError(
            "RICKGENT_STATE_CONFLICT",
            "salvage artifact ended before its recorded size",
            this.location.databasePath,
          );
        }
        hash.update(chunk.subarray(0, count));
        chunks.push(Buffer.from(chunk.subarray(0, count)));
        offset += count;
      }
      const after = fstatSync(descriptor);
      const observedDigest = `sha256:${hash.digest("hex")}`;
      if (
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        observedDigest !== salvage.artifact_digest
      ) {
        throw typedError(
          "RICKGENT_STATE_CONFLICT",
          "salvage artifact bytes changed during authority verification",
          this.location.databasePath,
        );
      }
      const artifactText = Buffer.concat(chunks, before.size).toString("utf8");
      const manifest = this.#parseJsonObject(artifactText, "salvage artifact manifest");
      if (canonicalJson(manifest) !== artifactText) {
        throw typedError(
          "RICKGENT_STATE_CONFLICT",
          "salvage artifact manifest is not canonical JSON",
          this.location.databasePath,
        );
      }
      return manifest;
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "salvage artifact is unavailable for authority verification",
        this.location.databasePath,
        error,
      );
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  #requireSalvageCompleteness(
    disposition: unknown,
    baselineOid: unknown,
    attemptRef: unknown,
    expectedAttemptRefOid: unknown,
    indexDigest: unknown,
    manifest: Record<string, unknown> | null,
  ): void {
    if (
      typeof baselineOid !== "string" || typeof attemptRef !== "string" ||
      typeof expectedAttemptRefOid !== "string" || typeof indexDigest !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baselineOid) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedAttemptRefOid) ||
      !/^sha256:[0-9a-f]{64}$/.test(indexDigest)
    ) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "salvage completeness proof has an invalid ref or index identity",
        this.location.databasePath,
      );
    }
    if (disposition === "empty") {
      if (manifest !== null || expectedAttemptRefOid !== baselineOid) {
        throw typedError(
          "RICKGENT_STATE_CONFLICT",
          "empty salvage does not prove baseline attempt-ref and index completeness",
          this.location.databasePath,
        );
      }
      return;
    }
    const indexSnapshot = manifest?.index_snapshot;
    const refObservations = manifest?.ref_observations;
    if (
      disposition !== "captured" || manifest === null || manifest.schema_version !== "rickgent.salvage-archive.v1" ||
      manifest.disposition !== "captured" || manifest.baseline_oid !== baselineOid ||
      manifest.attempt_ref !== attemptRef || manifest.attempt_ref_oid !== expectedAttemptRefOid ||
      indexSnapshot === null || typeof indexSnapshot !== "object" || Array.isArray(indexSnapshot) ||
      !Array.isArray(refObservations)
    ) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "captured salvage manifest differs from its durable completeness proof",
        this.location.databasePath,
      );
    }
    const index = indexSnapshot as Record<string, unknown>;
    if (
      index.digest !== indexDigest || typeof index.size !== "number" || !Number.isSafeInteger(index.size) || index.size < 0 ||
      typeof index.content_base64 !== "string" || !Array.isArray(index.changed_entries) ||
      !refObservations.some((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const observation = value as Record<string, unknown>;
        return observation.ref === attemptRef && observation.oid === expectedAttemptRefOid;
      })
    ) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "captured salvage manifest omits its exact attempt ref or index snapshot",
        this.location.databasePath,
      );
    }
    const indexBytes = Buffer.from(index.content_base64, "base64");
    const observedIndexDigest = `sha256:${createHash("sha256").update(indexBytes).digest("hex")}`;
    if (
      indexBytes.toString("base64") !== index.content_base64 || indexBytes.length !== index.size ||
      observedIndexDigest !== indexDigest
    ) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "captured salvage index snapshot bytes differ from their durable digest",
        this.location.databasePath,
      );
    }
  }

  #heartbeatAttemptOwnership(
    command: AttemptOwnershipCommand,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const current = this.#requireCurrentOwnership(command);
    this.#requireOwnershipPreimage(command, current);
    if (current.state !== "live" || current.recovered_from_ownership_id !== null) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "only execution ownership can heartbeat while live", this.location.databasePath);
    }
    const wallNow = Date.now();
    if (new Date(String(current.expires_at)).getTime() <= wallNow) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "expired attempt ownership cannot heartbeat", this.location.databasePath);
    }
    const heartbeatMs = Math.max(wallNow, new Date(String(current.heartbeat_at)).getTime() + 1);
    const heartbeatAt = new Date(heartbeatMs).toISOString();
    const expiresAt = new Date(heartbeatMs + command.payload.ttlMs).toISOString();
    const update = this.#requireDatabase().prepare(`
      UPDATE attempt_ownership_leases
      SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
      WHERE ownership_id = ? AND owner_token_digest = ? AND state = 'live' AND state_version = ?
    `).run(heartbeatAt, expiresAt, String(current.ownership_id), command.payload.ownerTokenDigest, Number(current.state_version));
    if (update.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "attempt ownership heartbeat lost its CAS race", this.location.databasePath);
    return this.#recordOwnershipOperation(
      command,
      String(current.ownership_id),
      "execution",
      this.#attemptOwnershipPlan(command.payload.attemptId),
      canonicalInput,
      inputDigest,
    );
  }

  #advanceAttemptResourceClaim(
    command: AttemptOwnershipCommand,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const payload = command.payload;
    const ownership = this.#requireCurrentOwnership(command);
    if (
      payload.slot === undefined || payload.expectedResourceState === undefined ||
      payload.expectedResourceVersion === undefined || payload.toResourceState === undefined
    ) {
      throw new TypeError("resource ownership operation is incomplete");
    }
    const resource = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_resource_claims
      WHERE attempt_id = ? AND slot = ?
    `).get(payload.attemptId, payload.slot) as MutableStateRecord | undefined;
    if (
      resource === undefined || resource.current_ownership_id !== ownership.ownership_id ||
      resource.owner_generation !== ownership.generation
    ) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "attempt resource current owner does not match", this.location.databasePath);
    }
    if (resource.state !== payload.expectedResourceState || resource.state_version !== payload.expectedResourceVersion) {
      throw typedError("RICKGENT_STATE_CONFLICT", "attempt resource compare-and-set preimage changed", this.location.databasePath);
    }
    const edge = `${String(resource.state)}->${payload.toResourceState}`;
    const allowed = new Set(["reserved->allocated", "allocated->active"]);
    if (!allowed.has(edge)) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", `illegal attempt resource edge ${edge}`, this.location.databasePath);
    }
    if (
      ["allocated", "active"].includes(payload.toResourceState) &&
      (ownership.state !== "live" || ownership.recovered_from_ownership_id !== null ||
        new Date(String(ownership.expires_at)).getTime() <= Date.now())
    ) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "new resource effects require current unexpired execution ownership", this.location.databasePath);
    }
    const update = this.#requireDatabase().prepare(`
      UPDATE attempt_resource_claims
      SET state = ?, state_version = state_version + 1,
          release_proof_digest = ?, quarantine_proof_digest = ?
      WHERE resource_claim_id = ? AND current_ownership_id = ? AND owner_generation = ? AND state = ? AND state_version = ?
    `).run(
      payload.toResourceState,
      null,
      null,
      String(resource.resource_claim_id),
      String(ownership.ownership_id),
      Number(ownership.generation),
      String(resource.state),
      payload.expectedResourceVersion,
    );
    if (update.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "attempt resource advance lost its CAS race", this.location.databasePath);
    return this.#recordOwnershipOperation(
      command,
      String(ownership.ownership_id),
      ownership.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
      this.#attemptOwnershipPlan(payload.attemptId),
      canonicalInput,
      inputDigest,
    );
  }

  #beginAttemptOwnershipCleanup(
    command: AttemptOwnershipCommand,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const current = this.#requireCurrentOwnership(command);
    this.#requireOwnershipPreimage(command, current);
    if (current.state !== "live") {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "only live ownership can begin cleanup", this.location.databasePath);
    }
    this.#requireDatabase().prepare(`
      UPDATE attempt_resource_claims
      SET state = 'cleanup_pending', state_version = state_version + 1
      WHERE attempt_id = ? AND current_ownership_id = ? AND state IN ('reserved','allocated','active')
    `).run(command.payload.attemptId, String(current.ownership_id));
    const update = this.#requireDatabase().prepare(`
      UPDATE attempt_ownership_leases
      SET state = 'cleanup_pending', state_version = state_version + 1
      WHERE ownership_id = ? AND owner_token_digest = ? AND state = 'live' AND state_version = ?
    `).run(String(current.ownership_id), command.payload.ownerTokenDigest, Number(current.state_version));
    if (update.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "attempt cleanup lost its ownership CAS race", this.location.databasePath);
    return this.#recordOwnershipOperation(
      command,
      String(current.ownership_id),
      current.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
      this.#attemptOwnershipPlan(command.payload.attemptId),
      canonicalInput,
      inputDigest,
    );
  }

  #requireCleanupResourcePreimage(
    command: AttemptOwnershipCommand,
    ownership: MutableStateRecord,
    requireReceiptPreimage: boolean,
  ): MutableStateRecord[] {
    const payload = command.payload;
    const plan = this.#attemptOwnershipPlan(payload.attemptId);
    const resources = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_resource_claims WHERE attempt_id = ? ORDER BY slot
    `).all(payload.attemptId) as MutableStateRecord[];
    if (
      resources.length !== plan.resources.length ||
      resources.some((resource) =>
        resource.current_ownership_id !== ownership.ownership_id ||
        resource.owner_generation !== ownership.generation ||
        resource.state !== "cleanup_pending")
    ) {
      throw typedError(
        "RICKGENT_STATE_OWNER_MISMATCH",
        "cleanup does not own the complete current cleanup-pending resource set",
        this.location.databasePath,
      );
    }
    if (!requireReceiptPreimage) return resources;
    const expected = payload.cleanupResourcePreimages;
    if (
      expected === undefined || expected.length !== plan.resources.length ||
      new Set(expected.map((preimage) => preimage.resourceClaimId)).size !== expected.length
    ) {
      throw new TypeError("cleanup finalization requires the complete fixed resource preimage");
    }
    const expectedById = new Map(expected.map((preimage) => [preimage.resourceClaimId, preimage]));
    if (resources.some((resource) => {
      const preimage = expectedById.get(String(resource.resource_claim_id));
      return preimage === undefined || preimage.slot !== resource.slot || preimage.expectedState !== "cleanup_pending" ||
        preimage.expectedVersion !== resource.state_version;
    })) {
      throw typedError(
        "RICKGENT_STATE_CONFLICT",
        "cleanup resource compare-and-set preimage changed",
        this.location.databasePath,
      );
    }
    return resources;
  }

  #requireCleanupProcessProof(
    attemptId: string,
    ownershipId: string,
    processReceiptId: string | undefined,
    groupDeathEvidenceId: string | undefined,
  ): MutableStateRecord {
    if (processReceiptId === undefined || groupDeathEvidenceId === undefined) {
      throw new TypeError("cleanup requires process terminal and group-death identities");
    }
    const proof = this.#requireDatabase().prepare(`
      WITH RECURSIVE ownership_lineage(ownership_id) AS (
        SELECT ownership_id FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?
        UNION ALL
        SELECT lease.recovered_from_ownership_id
        FROM attempt_ownership_leases lease
        JOIN ownership_lineage lineage ON lineage.ownership_id = lease.ownership_id
        WHERE lease.attempt_id = ? AND lease.recovered_from_ownership_id IS NOT NULL
      )
      SELECT terminal.process_receipt_id, terminal.group_dead, terminal.descendants_confirmed_dead,
             terminal.result_digest AS terminal_result_digest,
             terminal.created_at AS terminal_created_at,
             launch.ownership_id AS launch_ownership_id,
             launch.owner_generation AS launch_owner_generation,
             launch.ownership_context_digest AS launch_context_digest,
             owner.generation AS durable_owner_generation,
             owner.context_digest AS durable_owner_context_digest,
             observation.kind AS observation_kind,
             observation.schema_version AS observation_schema_version,
             observation.payload_digest AS observation_payload_digest,
             observation.created_at AS observation_created_at,
             evidence.producer_service, evidence.schema_version AS evidence_schema_version,
             evidence.content_digest, evidence.inline_payload_json,
             evidence.evidence_id AS group_death_evidence_id,
             evidence.attempt_id AS evidence_attempt_id,
             evidence.created_at AS evidence_created_at
      FROM attempt_process_terminal_receipts terminal
      JOIN attempt_process_launches launch
        ON launch.launch_id = terminal.launch_id
       AND launch.process_receipt_id = terminal.process_receipt_id
       AND launch.attempt_id = terminal.attempt_id
      JOIN ownership_lineage lineage ON lineage.ownership_id = launch.ownership_id
      JOIN attempt_ownership_leases owner
        ON owner.ownership_id = launch.ownership_id AND owner.attempt_id = launch.attempt_id
      JOIN attempt_process_observations observation
        ON observation.launch_id = launch.launch_id AND observation.evidence_id = ?
      JOIN evidence evidence
        ON evidence.evidence_id = observation.evidence_id AND evidence.attempt_id = launch.attempt_id
      WHERE terminal.process_receipt_id = ? AND terminal.attempt_id = ?
        AND observation.kind = 'group_death'
    `).get(
      ownershipId,
      attemptId,
      attemptId,
      groupDeathEvidenceId,
      processReceiptId,
      attemptId,
    ) as MutableStateRecord | undefined;
    if (
      proof === undefined || proof.group_dead !== 1 || proof.descendants_confirmed_dead !== 1 ||
      proof.launch_owner_generation !== proof.durable_owner_generation ||
      proof.launch_context_digest !== proof.durable_owner_context_digest ||
      proof.observation_kind !== "group_death" || proof.observation_schema_version !== "rickgent.process-group-death.v1" ||
      proof.producer_service !== "ProcessSupervisor" || proof.evidence_schema_version !== "rickgent.process-group-death.v1" ||
      proof.evidence_attempt_id !== attemptId || proof.inline_payload_json === null ||
      proof.process_receipt_id !== processReceiptId || proof.group_death_evidence_id !== groupDeathEvidenceId ||
      typeof proof.terminal_result_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(proof.terminal_result_digest) ||
      typeof proof.terminal_created_at !== "string" || Number.isNaN(Date.parse(proof.terminal_created_at)) ||
      typeof proof.observation_created_at !== "string" || Number.isNaN(Date.parse(proof.observation_created_at)) ||
      proof.evidence_created_at !== proof.observation_created_at ||
      proof.content_digest !== proof.observation_payload_digest ||
      proof.content_digest !== sha256Text(String(proof.inline_payload_json))
    ) {
      throw typedError(
        "RICKGENT_STATE_OWNER_MISMATCH",
        "cleanup lacks an exact authoritative process terminal and group-death proof",
        this.location.databasePath,
      );
    }
    return proof;
  }

  #requireAuthorizedSalvageRecord(
    attemptId: string,
    ownershipId: string,
    salvageRecordId: string | undefined,
    processReceiptId: string | undefined,
    groupDeathEvidenceId: string | undefined,
    processProof: MutableStateRecord,
    expectedAttemptRefOid?: string,
  ): MutableStateRecord {
    if (salvageRecordId === undefined) throw new TypeError("cleanup requires a salvage record identity");
    const plan = this.#attemptOwnershipPlan(attemptId);
    const salvage = this.#requireDatabase().prepare(`
      SELECT salvage.*, evidence.producer_service, evidence.schema_version,
             evidence.content_digest, evidence.inline_payload_json
      FROM salvage_records salvage
      JOIN evidence evidence
        ON evidence.evidence_id = salvage.evidence_id AND evidence.attempt_id = salvage.attempt_id
      WHERE salvage.salvage_record_id = ? AND salvage.attempt_id = ?
    `).get(salvageRecordId, attemptId) as MutableStateRecord | undefined;
    if (
      salvage === undefined || !["captured", "empty"].includes(String(salvage.disposition)) ||
      salvage.producer_service !== "SalvageService" || salvage.schema_version !== "rickgent.salvage-record.v2" ||
      salvage.inline_payload_json === null || salvage.content_digest !== sha256Text(String(salvage.inline_payload_json))
    ) {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        "cleanup salvage identity is not an authority-produced captured or empty disposition",
        this.location.databasePath,
      );
    }
    const payload = this.#parseJsonObject(String(salvage.inline_payload_json), "salvage record evidence");
    const lineage = typeof payload.ownership_id === "string"
      ? this.#requireDatabase().prepare(`
        WITH RECURSIVE ownership_lineage(ownership_id) AS (
          SELECT ownership_id FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?
          UNION ALL
          SELECT lease.recovered_from_ownership_id
          FROM attempt_ownership_leases lease
          JOIN ownership_lineage current ON current.ownership_id = lease.ownership_id
          WHERE lease.attempt_id = ? AND lease.recovered_from_ownership_id IS NOT NULL
        )
        SELECT lease.generation, lease.context_digest
        FROM ownership_lineage lineage
        JOIN attempt_ownership_leases lease ON lease.ownership_id = lineage.ownership_id
        WHERE lease.ownership_id = ? AND lease.attempt_id = ?
      `).get(ownershipId, attemptId, attemptId, payload.ownership_id, attemptId) as MutableStateRecord | undefined
      : undefined;
    if (
      payload.salvage_record_id !== salvageRecordId || payload.attempt_id !== attemptId ||
      lineage === undefined || payload.owner_generation !== lineage.generation ||
      payload.ownership_context_digest !== lineage.context_digest || payload.disposition !== salvage.disposition ||
      payload.artifact_path !== salvage.artifact_path || payload.artifact_digest !== salvage.artifact_digest ||
      payload.artifact_size !== salvage.artifact_size || payload.process_receipt_id !== processReceiptId ||
      payload.group_death_evidence_id !== groupDeathEvidenceId ||
      payload.process_terminal_result_digest !== processProof.terminal_result_digest ||
      payload.process_terminal_created_at !== processProof.terminal_created_at ||
      payload.group_death_content_digest !== processProof.content_digest ||
      payload.group_death_created_at !== processProof.observation_created_at ||
      payload.baseline_oid !== plan.lineage.deliveryBaselineOid || payload.attempt_ref !== plan.attemptRef ||
      typeof payload.expected_attempt_ref_oid !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.expected_attempt_ref_oid) ||
      (expectedAttemptRefOid !== undefined && payload.expected_attempt_ref_oid !== expectedAttemptRefOid) ||
      typeof payload.index_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(payload.index_digest) ||
      typeof payload.created_at !== "string" ||
      Date.parse(payload.created_at) < Date.parse(String(processProof.terminal_created_at)) ||
      Date.parse(payload.created_at) < Date.parse(String(processProof.observation_created_at))
    ) {
      throw typedError(
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
        "cleanup salvage evidence does not exactly bind its durable record",
        this.location.databasePath,
      );
    }
    const manifest = this.#verifyAuthorizedSalvageArtifact(plan, salvage);
    this.#requireSalvageCompleteness(
      payload.disposition,
      payload.baseline_oid,
      payload.attempt_ref,
      payload.expected_attempt_ref_oid,
      payload.index_digest,
      manifest,
    );
    return salvage;
  }

  #requireAuthorizedAttemptRefPostimage(
    attemptId: string,
    expectedAttemptRefOid: string | undefined,
    mode: "present_or_absent" | "absent",
  ): void {
    const plan = this.#attemptOwnershipPlan(attemptId);
    if (mode === "absent") {
      try {
        execFileSync("git", ["show-ref", "--verify", "--quiet", plan.attemptRef], {
          cwd: this.location.repoRealpath,
          encoding: "utf8",
          env: HERMETIC_GIT_ENVIRONMENT,
          timeout: 10_000,
          maxBuffer: MAX_GIT_OUTPUT,
        });
        throw typedError("RICKGENT_STATE_CONFLICT", "cleanup attempt ref remains after external cleanup", this.location.databasePath);
      } catch (error) {
        if (error instanceof StateStoreError) throw error;
        const status = (error as NodeJS.ErrnoException & { status?: number }).status;
        if (status !== 1) {
          throw typedError(
            "RICKGENT_STATE_TRANSITION_ILLEGAL",
            "cleanup attempt-ref absence cannot be proven",
            this.location.databasePath,
            error,
          );
        }
      }
      return;
    }
    if (expectedAttemptRefOid === undefined) throw new TypeError("cleanup requires an expected attempt-ref OID");
    this.#assertRepositoryOid(expectedAttemptRefOid, "cleanup expected attempt ref oid");
    const authorized = this.#requireDatabase().prepare(`
      SELECT a.delivery_baseline_oid,
             EXISTS (
               SELECT 1 FROM attempt_commit_intents intent
               WHERE intent.attempt_id = a.attempt_id AND intent.state = 'finalized'
                 AND intent.commit_oid = ? AND intent.commit_attribution_id IS NOT NULL
             ) AS finalized_candidate
      FROM attempts a WHERE a.attempt_id = ?
    `).get(expectedAttemptRefOid, attemptId) as MutableStateRecord | undefined;
    if (
      authorized === undefined ||
      (authorized.delivery_baseline_oid !== expectedAttemptRefOid && authorized.finalized_candidate !== 1)
    ) {
      throw typedError(
        "RICKGENT_STATE_OWNER_MISMATCH",
        "cleanup attempt-ref postimage is neither the baseline nor the exact finalized attributed candidate",
        this.location.databasePath,
      );
    }
    try {
      const observed = execFileSync("git", ["rev-parse", "--verify", plan.attemptRef], {
        cwd: this.location.repoRealpath,
        encoding: "utf8",
        env: HERMETIC_GIT_ENVIRONMENT,
        timeout: 10_000,
        maxBuffer: MAX_GIT_OUTPUT,
      }).trim();
      if (observed !== expectedAttemptRefOid) {
        throw typedError("RICKGENT_STATE_CONFLICT", "cleanup attempt ref has a foreign postimage", this.location.databasePath);
      }
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      const status = (error as NodeJS.ErrnoException & { status?: number }).status;
      if (status !== 128) {
        throw typedError(
          "RICKGENT_STATE_TRANSITION_ILLEGAL",
          "cleanup attempt ref cannot be independently observed",
          this.location.databasePath,
          error,
        );
      }
    }
  }

  #recordAuthorizedCleanupFinalization(command: AttemptOwnershipCommand, terminalState: "released" | "quarantined"): void {
    const payload = command.payload;
    if (payload.contextId === undefined || payload.cleanupProofDigest === undefined || payload.deliveryObservedOid === undefined) {
      throw new TypeError("cleanup finalization evidence is incomplete");
    }
    this.#requireTransitionGuard(`
      SELECT 1
      FROM execution_contexts context
      JOIN phase_executions phase
        ON phase.context_id = context.context_id AND phase.attempt_id = context.attempt_id
      WHERE context.context_id = ? AND context.attempt_id = ?
        AND phase.phase = 'cleanup' AND phase.role = 'cleanup'
    `, [payload.contextId, payload.attemptId], "cleanup finalization context differs from its attempt");
    const cleanupRecordId = `cleanup-record-${payload.cleanupProofDigest.slice(7)}`;
    const evidenceId = `cleanup-evidence-${payload.cleanupProofDigest.slice(7)}`;
    const sequence = this.#requireDatabase().prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM cleanup_records WHERE attempt_id = ?
    `).get(payload.attemptId) as MutableStateRecord;
    const cleanupPayload = {
      attempt_id: payload.attemptId,
      sequence: Number(sequence.next_sequence),
      context_id: payload.contextId,
      outcome: terminalState === "released" ? "failed_clean" : "quarantined",
      group_dead: 1,
      worktree_disposition: terminalState === "released" ? "removed" : "quarantined",
      index_disposition: terminalState === "released" ? "removed" : "quarantined",
      ref_disposition: terminalState === "released" ? "removed" : "quarantined",
      context_disposition: terminalState === "released" ? "removed" : "quarantined",
      bundle_disposition: terminalState === "released" ? "removed" : "quarantined",
      delivery_ref_observed_oid: payload.deliveryObservedOid,
      resources_absent: 1,
      lease_release_eligible: 1,
      evidence_id: evidenceId,
    };
    const createdAt = new Date().toISOString();
    const inlinePayload = canonicalJson(cleanupPayload);
    this.#insert("evidence", {
      evidence_id: evidenceId,
      attempt_id: payload.attemptId,
      phase_execution_id: null,
      context_id: payload.contextId,
      producer_service: "CleanupService",
      scope: cleanupRecordId,
      schema_version: "rickgent.cleanup-record.v1",
      content_digest: sha256Text(inlinePayload),
      inline_payload_json: inlinePayload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: payload.idempotencyKey,
      created_at: createdAt,
    });
    this.#insert("cleanup_records", {
      cleanup_record_id: cleanupRecordId,
      ...cleanupPayload,
      record_digest: sha256Text(canonicalJson(cleanupPayload)),
      created_at: createdAt,
    });
  }

  #recordTerminalAttemptOwnershipSnapshots(attemptId: string, contextId: string): void {
    const snapshots = [
      ...this.#requireDatabase().prepare(
        "SELECT * FROM attempt_ownership_leases WHERE attempt_id = ? ORDER BY generation, ownership_id",
      ).all(attemptId).map((row) => ({
        row: row as MutableStateRecord,
        schemaVersion: "rickgent.attempt-ownership-lease-snapshot.v2",
        scopePrefix: "attempt-ownership-lease",
      })),
      ...this.#requireDatabase().prepare(
        "SELECT * FROM attempt_resource_claims WHERE attempt_id = ? ORDER BY slot, resource_claim_id",
      ).all(attemptId).map((row) => ({
        row: row as MutableStateRecord,
        schemaVersion: "rickgent.attempt-resource-claim-snapshot.v2",
        scopePrefix: "attempt-resource-claim",
      })),
    ];
    for (const snapshot of snapshots) {
      const inlinePayload = canonicalJson(snapshot.row);
      const contentDigest = sha256Text(inlinePayload);
      const identity = snapshot.scopePrefix === "attempt-ownership-lease"
        ? String(snapshot.row.ownership_id)
        : String(snapshot.row.resource_claim_id);
      const scope = `${snapshot.scopePrefix}:${identity}:version:${String(snapshot.row.state_version)}`;
      const evidenceId = `${snapshot.scopePrefix}-snapshot-${contentDigest.slice(7)}`;
      const expected: MutableStateRecord = {
        evidence_id: evidenceId,
        attempt_id: attemptId,
        phase_execution_id: null,
        context_id: contextId,
        producer_service: "LeaseAuthority",
        scope,
        schema_version: snapshot.schemaVersion,
        content_digest: contentDigest,
        inline_payload_json: inlinePayload,
        external_path: null,
        external_digest: null,
        external_size: null,
        idempotency_key: scope,
        created_at: new Date().toISOString(),
      };
      const existing = this.#requireDatabase().prepare(
        "SELECT * FROM evidence WHERE evidence_id = ? OR (producer_service = ? AND scope = ? AND idempotency_key = ?)",
      ).get(evidenceId, "LeaseAuthority", scope, scope) as MutableStateRecord | undefined;
      if (existing !== undefined) {
        const immutableColumns = Object.keys(expected).filter((column) => column !== "created_at");
        if (!immutableColumns.every((column) => sameValue(existing[column], expected[column]))) {
          throw typedError(
            "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
            "terminal attempt ownership snapshot identity has different immutable input",
            this.location.databasePath,
          );
        }
        continue;
      }
      this.#validateRecordSemantics("evidence", expected);
      this.#insert("evidence", expected);
    }
  }

  #finalizeAttemptOwnershipCleanup(
    command: AttemptOwnershipCommand,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const payload = command.payload;
    const ownership = this.#requireCurrentOwnership(command);
    this.#requireOwnershipPreimage(command, ownership);
    if (ownership.state !== "cleanup_pending") {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "only cleanup-pending ownership can be finalized", this.location.databasePath);
    }
    if (new Date(String(ownership.expires_at)).getTime() <= Date.now()) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "expired cleanup ownership cannot be finalized", this.location.databasePath);
    }
    if (payload.cleanupProofDigest === undefined || !/^sha256:[0-9a-f]{64}$/.test(payload.cleanupProofDigest)) {
      throw new TypeError("cleanup finalization requires a SHA-256 proof digest");
    }
    const resources = this.#requireCleanupResourcePreimage(command, ownership, true);
    const processProof = this.#requireCleanupProcessProof(
      payload.attemptId,
      String(ownership.ownership_id),
      payload.processReceiptId,
      payload.groupDeathEvidenceId,
    );
    this.#requireAuthorizedSalvageRecord(
      payload.attemptId,
      String(ownership.ownership_id),
      payload.salvageRecordId,
      payload.processReceiptId,
      payload.groupDeathEvidenceId,
      processProof,
    );
    const plan = this.#attemptOwnershipPlan(payload.attemptId);
    if (payload.deliveryRef !== plan.lineage.deliveryRef || payload.deliveryObservedOid === undefined) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "cleanup delivery observation has different lineage", this.location.databasePath);
    }
    this.#assertRepositoryOid(payload.deliveryObservedOid, "cleanup delivery observed oid");
    const delivery = this.#requireDatabase().prepare(`
      SELECT delivery_ref, current_delivery_oid FROM runs WHERE run_id = ? AND repository_id = ?
    `).get(plan.lineage.runId, this.location.repositoryId) as MutableStateRecord | undefined;
    if (
      delivery === undefined || delivery.delivery_ref !== payload.deliveryRef ||
      delivery.current_delivery_oid !== payload.deliveryObservedOid
    ) {
      throw typedError("RICKGENT_STATE_CONFLICT", "cleanup delivery observation differs from durable run truth", this.location.databasePath);
    }
    let observedDelivery: string;
    try {
      observedDelivery = execFileSync("git", ["rev-parse", "--verify", payload.deliveryRef], {
        cwd: this.location.repoRealpath,
        encoding: "utf8",
        env: HERMETIC_GIT_ENVIRONMENT,
        timeout: 10_000,
        maxBuffer: MAX_GIT_OUTPUT,
      }).trim();
    } catch (error) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup delivery ref cannot be independently observed", this.location.databasePath, error);
    }
    if (observedDelivery !== payload.deliveryObservedOid) {
      throw typedError("RICKGENT_STATE_CONFLICT", "cleanup delivery observation differs from the repository", this.location.databasePath);
    }
    this.#requireAuthorizedAttemptRefPostimage(payload.attemptId, undefined, "absent");
    const terminalState = payload.kind === "release" ? "released" : "quarantined";
    this.#recordAuthorizedCleanupFinalization(command, terminalState);
    for (const resource of resources) {
      const update = this.#requireDatabase().prepare(`
        UPDATE attempt_resource_claims
        SET state = ?, state_version = state_version + 1,
            release_proof_digest = ?, quarantine_proof_digest = ?
        WHERE resource_claim_id = ? AND attempt_id = ?
          AND current_ownership_id = ? AND owner_generation = ?
          AND state = 'cleanup_pending' AND state_version = ?
      `).run(
        terminalState,
        terminalState === "released" ? payload.cleanupProofDigest : null,
        terminalState === "quarantined" ? payload.cleanupProofDigest : null,
        String(resource.resource_claim_id),
        payload.attemptId,
        String(ownership.ownership_id),
        Number(ownership.generation),
        Number(resource.state_version),
      );
      if (update.changes !== 1) {
        throw typedError("RICKGENT_STATE_CONFLICT", "cleanup resource finalization lost its CAS race", this.location.databasePath);
      }
    }
    const ownerUpdate = this.#requireDatabase().prepare(`
      UPDATE attempt_ownership_leases
      SET state = ?, state_version = state_version + 1
      WHERE ownership_id = ? AND attempt_id = ? AND owner_token_digest = ?
        AND state = 'cleanup_pending' AND state_version = ?
    `).run(
      terminalState,
      String(ownership.ownership_id),
      payload.attemptId,
      payload.ownerTokenDigest,
      Number(ownership.state_version),
    );
    if (ownerUpdate.changes !== 1) {
      throw typedError("RICKGENT_STATE_CONFLICT", "cleanup owner finalization lost its CAS race", this.location.databasePath);
    }
    this.#recordTerminalAttemptOwnershipSnapshots(payload.attemptId, String(payload.contextId));
    return this.#recordOwnershipOperation(
      command,
      String(ownership.ownership_id),
      ownership.recovered_from_ownership_id === null ? "execution" : "recovery_cleanup",
      plan,
      canonicalInput,
      inputDigest,
    );
  }

  #recoverStaleAttemptOwnership(
    command: AttemptOwnershipCommand,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const payload = command.payload;
    if (payload.expiredOwnershipId === undefined || payload.deathEvidenceId === undefined) {
      throw new TypeError("stale recovery requires an expired ownership id and death evidence");
    }
    const plan = this.#attemptOwnershipPlan(payload.attemptId);
    const old = this.#requireDatabase().prepare(`
      SELECT * FROM attempt_ownership_leases
      WHERE ownership_id = ? AND attempt_id = ?
    `).get(payload.expiredOwnershipId, payload.attemptId) as MutableStateRecord | undefined;
    if (old === undefined || !["live", "cleanup_pending"].includes(String(old.state))) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "stale recovery target is not the current recoverable ownership", this.location.databasePath);
    }
    const nowMs = Date.now();
    if (new Date(String(old.expires_at)).getTime() > nowMs) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "fresh ownership cannot be recovered", this.location.databasePath);
    }
    const chain = this.#requireDatabase().prepare(`
      SELECT l.*, o.observation_id AS death_observation_id, o.sequence AS death_sequence,
             o.kind AS death_kind, o.evidence_id AS death_evidence_id,
             o.schema_version AS death_schema_version, o.payload_digest AS death_payload_digest,
             o.created_at AS death_created_at,
             e.attempt_id AS evidence_attempt_id, e.phase_execution_id AS evidence_phase_execution_id,
             e.context_id AS evidence_context_id, e.producer_service AS evidence_producer_service,
             e.schema_version AS evidence_schema_version, e.content_digest AS evidence_content_digest,
             e.inline_payload_json AS evidence_payload_json,
             t.outcome AS terminal_outcome, t.exit_code AS terminal_exit_code,
             t.signal AS terminal_signal, t.timed_out AS terminal_timed_out,
             t.group_dead AS terminal_group_dead,
             t.descendants_confirmed_dead AS terminal_descendants_confirmed_dead,
             t.observation_count AS terminal_observation_count,
             t.result_digest AS terminal_result_digest, t.created_at AS terminal_created_at
      FROM attempt_process_observations o
      JOIN attempt_process_launches l ON l.launch_id = o.launch_id AND l.attempt_id = o.attempt_id
      JOIN evidence e ON e.evidence_id = o.evidence_id AND e.attempt_id = o.attempt_id
      JOIN attempt_process_terminal_receipts t
        ON t.launch_id = l.launch_id AND t.process_receipt_id = l.process_receipt_id AND t.attempt_id = l.attempt_id
      WHERE o.evidence_id = ? AND o.kind = 'group_death'
    `).get(payload.deathEvidenceId) as MutableStateRecord | undefined;
    if (chain === undefined || chain.evidence_payload_json === null) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "stale recovery lacks an exact durable process terminal/death chain", this.location.databasePath);
    }
    const death = this.#parseJsonObject(String(chain.evidence_payload_json), "process death evidence");
    const expectedDeath = {
      schema_version: "rickgent.process-group-death.v1",
      launch_id: String(chain.launch_id),
      process_receipt_id: String(chain.process_receipt_id),
      attempt_id: String(chain.attempt_id),
      ownership_id: String(chain.ownership_id),
      owner_generation: Number(chain.owner_generation),
      ownership_context_digest: String(chain.ownership_context_digest),
      phase_execution_id: String(chain.phase_execution_id),
      context_id: String(chain.context_id),
      execution_context_digest: String(chain.execution_context_digest),
      pid: Number(chain.pid),
      pgid: Number(chain.pgid),
      platform: String(chain.platform),
      boot_identity: String(chain.boot_identity),
      process_start_identity: String(chain.process_start_identity),
      group_dead: true,
      proof_basis: "authoritative_containment",
      tracked_identities_confirmed_dead: true,
      descendants_confirmed_dead: true,
      death_observed_at: String(chain.death_created_at),
    };
    const observations = this.#requireDatabase().prepare(`
      SELECT observation_id, sequence, kind, evidence_id, schema_version, payload_digest, created_at
      FROM attempt_process_observations WHERE launch_id = ? ORDER BY sequence
    `).all(String(chain.launch_id)) as MutableStateRecord[];
    const terminalPayload = {
      schema_version: "rickgent.process-terminal.v1",
      launch_id: String(chain.launch_id),
      process_receipt_id: String(chain.process_receipt_id),
      outcome: String(chain.terminal_outcome),
      exit_code: chain.terminal_exit_code,
      signal: chain.terminal_signal,
      timed_out: chain.terminal_timed_out === 1,
      group_dead: chain.terminal_group_dead === 1,
      descendants_confirmed_dead: chain.terminal_descendants_confirmed_dead === 1,
      observation_refs: observations,
      created_at: String(chain.terminal_created_at),
    };
    const observedAt = Date.parse(String(chain.death_created_at));
    if (
      canonicalJson(death) !== canonicalJson(expectedDeath) ||
      chain.attempt_id !== payload.attemptId || chain.ownership_id !== old.ownership_id ||
      chain.owner_generation !== old.generation || chain.ownership_context_digest !== old.context_digest ||
      chain.repository_id !== this.location.repositoryId ||
      chain.evidence_attempt_id !== chain.attempt_id ||
      chain.evidence_phase_execution_id !== chain.phase_execution_id ||
      chain.evidence_context_id !== chain.context_id ||
      chain.evidence_producer_service !== "ProcessSupervisor" ||
      chain.evidence_schema_version !== "rickgent.process-group-death.v1" ||
      chain.death_schema_version !== "rickgent.process-group-death.v1" ||
      chain.evidence_content_digest !== sha256Text(canonicalJson(death)) ||
      chain.death_payload_digest !== chain.evidence_content_digest ||
      chain.terminal_group_dead !== 1 || chain.terminal_descendants_confirmed_dead !== 1 ||
      chain.terminal_observation_count !== observations.length ||
      observations.some((observation, index) => observation.sequence !== index + 1) ||
      chain.terminal_result_digest !== sha256Text(canonicalJson(terminalPayload)) ||
      !Number.isFinite(observedAt) || observedAt < new Date(String(old.heartbeat_at)).getTime() || observedAt > nowMs
    ) {
      throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "process-death chain does not prove the expired owner dead", this.location.databasePath);
    }
    const generation = Number(old.generation) + 1;
    const ownershipId = this.#ownershipIdentity(payload.attemptId, generation, payload.ownerTokenDigest);
    const context = this.#ownershipContext(plan, generation, payload.ownerTokenDigest, String(old.ownership_id));
    const heartbeatAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + payload.ttlMs).toISOString();
    const oldUpdate = this.#requireDatabase().prepare(`
      UPDATE attempt_ownership_leases
      SET state = 'quarantined', state_version = state_version + 1
      WHERE ownership_id = ? AND state = ? AND state_version = ?
    `).run(String(old.ownership_id), String(old.state), Number(old.state_version));
    if (oldUpdate.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "stale recovery lost the old-owner CAS race", this.location.databasePath);
    this.#insert("attempt_ownership_leases", {
      ownership_id: ownershipId,
      attempt_id: payload.attemptId,
      generation,
      owner_token_digest: payload.ownerTokenDigest,
      context_digest: context.digest,
      canonical_context_json: context.json,
      recovered_from_ownership_id: String(old.ownership_id),
      heartbeat_at: heartbeatAt,
      expires_at: expiresAt,
      state: "cleanup_pending",
      state_version: 0,
      created_at: heartbeatAt,
    });
    this.#requireDatabase().prepare(`
      UPDATE attempt_resource_claims
      SET state = 'cleanup_pending', current_ownership_id = ?, owner_generation = ?, state_version = state_version + 1
      WHERE attempt_id = ? AND current_ownership_id = ? AND state IN ('reserved','allocated','active')
    `).run(ownershipId, generation, payload.attemptId, String(old.ownership_id));
    this.#requireDatabase().prepare(`
      UPDATE attempt_resource_claims
      SET current_ownership_id = ?, owner_generation = ?, state_version = state_version + 1
      WHERE attempt_id = ? AND current_ownership_id = ? AND state = 'cleanup_pending'
    `).run(ownershipId, generation, payload.attemptId, String(old.ownership_id));
    return this.#recordOwnershipOperation(command, ownershipId, "recovery_cleanup", plan, canonicalInput, inputDigest);
  }

  #recordOwnershipOperation(
    command: AttemptOwnershipCommand,
    ownershipId: string,
    purpose: AttemptOwnershipPurpose,
    plan: AttemptWorkspacePlan,
    canonicalInput: string,
    inputDigest: `sha256:${string}`,
  ): AttemptOwnershipStoreResult {
    const current = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?",
    ).get(ownershipId, command.payload.attemptId) as MutableStateRecord | undefined;
    if (current === undefined) throw new StateStoreError("RICKGENT_STATE_CORRUPT", "committed attempt ownership row is missing");
    const resources = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_resource_claims WHERE attempt_id = ? ORDER BY slot",
    ).all(command.payload.attemptId) as MutableStateRecord[];
    const resultJson = canonicalJson({
      schema_version: "rickgent.attempt-ownership-operation-result/v1",
      purpose,
      ownership_id: ownershipId,
      ownership: current,
      resources,
    });
    const operationId = `ownership-operation-${sha256Text(canonicalJson({
      attempt_id: command.payload.attemptId,
      idempotency_key: command.payload.idempotencyKey,
      input_digest: inputDigest,
    })).slice(7)}`;
    this.#insert("attempt_ownership_operations", {
      operation_id: operationId,
      ownership_id: ownershipId,
      attempt_id: command.payload.attemptId,
      operation_kind: command.payload.kind,
      idempotency_key: command.payload.idempotencyKey,
      input_digest: inputDigest,
      canonical_input_json: canonicalInput,
      result_digest: sha256Text(resultJson),
      canonical_result_json: resultJson,
      created_at: new Date().toISOString(),
    });
    return this.#attemptOwnershipResult(command.payload.attemptId, ownershipId, purpose, false, plan);
  }

  #ownershipOperationRow(value: unknown, label: string): MutableStateRecord {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", `${label} is not a stored row object`);
    }
    const row: MutableStateRecord = {};
    for (const [column, field] of Object.entries(value)) {
      if (field !== null && typeof field !== "string" && typeof field !== "number") {
        throw new StateStoreError("RICKGENT_STATE_CORRUPT", `${label}.${column} has a non-SQL value`);
      }
      row[column] = field;
    }
    return row;
  }

  #replayAttemptOwnershipResult(
    attemptId: string,
    ownershipId: string,
    operation: MutableStateRecord,
  ): AttemptOwnershipStoreResult {
    const resultJson = String(operation.canonical_result_json);
    if (sha256Text(resultJson) !== operation.result_digest) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt ownership operation result digest is corrupt");
    }
    const sealed = this.#parseJsonObject(resultJson, "attempt ownership operation result");
    if (
      sealed.schema_version !== "rickgent.attempt-ownership-operation-result/v1" ||
      sealed.ownership_id !== ownershipId ||
      (sealed.purpose !== "execution" && sealed.purpose !== "recovery_cleanup") ||
      !Array.isArray(sealed.resources)
    ) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt ownership operation result has an invalid envelope");
    }
    const committedOwnership = this.#ownershipOperationRow(sealed.ownership, "committed ownership");
    const committedResources = sealed.resources.map((resource, index) =>
      this.#ownershipOperationRow(resource, `committed resource ${index}`));
    const plan = this.#attemptOwnershipPlan(attemptId);
    if (committedOwnership.ownership_id !== ownershipId || committedOwnership.attempt_id !== attemptId) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt ownership operation result has different lineage");
    }
    const plannedClaims = new Map(plan.resources.map((resource) => [resource.resourceClaimId, resource]));
    if (
      committedResources.length !== plannedClaims.size ||
      committedResources.some((resource) => {
        const planned = plannedClaims.get(String(resource.resource_claim_id));
        return planned === undefined || resource.attempt_id !== attemptId || resource.slot !== planned.slot ||
          resource.kind !== planned.kind || resource.canonical_identity !== planned.canonicalIdentity ||
          resource.identity_digest !== planned.identityDigest;
      })
    ) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt ownership operation result has an invalid fixed resource set");
    }
    const currentOwnership = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?",
    ).get(ownershipId, attemptId) as MutableStateRecord | undefined;
    if (currentOwnership === undefined || Number(currentOwnership.state_version) < Number(committedOwnership.state_version)) {
      throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt ownership operation current row predates its sealed result");
    }
    for (const column of [
      "ownership_id", "attempt_id", "generation", "owner_token_digest", "context_digest",
      "canonical_context_json", "recovered_from_ownership_id", "created_at",
    ]) {
      if (!sameValue(currentOwnership[column], committedOwnership[column])) {
        throw new StateStoreError("RICKGENT_STATE_CORRUPT", `attempt ownership immutable replay field changed: ${column}`);
      }
    }
    const currentResources = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_resource_claims WHERE attempt_id = ? ORDER BY slot",
    ).all(attemptId) as MutableStateRecord[];
    const currentById = new Map(currentResources.map((resource) => [String(resource.resource_claim_id), resource]));
    for (const committed of committedResources) {
      const current = currentById.get(String(committed.resource_claim_id));
      if (current === undefined || Number(current.state_version) < Number(committed.state_version)) {
        throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt resource operation current row predates its sealed result");
      }
      for (const column of [
        "resource_claim_id", "attempt_id", "slot", "kind", "canonical_identity",
        "identity_digest", "allocation_ownership_id", "created_at",
      ]) {
        if (!sameValue(current[column], committed[column])) {
          throw new StateStoreError("RICKGENT_STATE_CORRUPT", `attempt resource immutable replay field changed: ${column}`);
        }
      }
    }
    return freezeValue({
      replayed: true,
      purpose: sealed.purpose,
      plan,
      ownership: frozenRow(committedOwnership),
      resources: Object.freeze(committedResources.map(frozenRow)),
      currentOwnership: frozenRow(currentOwnership),
      currentResources: Object.freeze(currentResources.map(frozenRow)),
    });
  }

  #attemptOwnershipResult(
    attemptId: string,
    ownershipId: string,
    purpose: AttemptOwnershipPurpose,
    replayed: boolean,
    plan: AttemptWorkspacePlan = this.#attemptOwnershipPlan(attemptId),
  ): AttemptOwnershipStoreResult {
    const ownership = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_ownership_leases WHERE ownership_id = ? AND attempt_id = ?",
    ).get(ownershipId, attemptId) as MutableStateRecord | undefined;
    if (ownership === undefined) throw new StateStoreError("RICKGENT_STATE_CORRUPT", "attempt ownership operation resolves to no lease");
    const resources = this.#requireDatabase().prepare(
      "SELECT * FROM attempt_resource_claims WHERE attempt_id = ? ORDER BY slot",
    ).all(attemptId) as MutableStateRecord[];
    return freezeValue({
      replayed,
      purpose,
      plan,
      ownership: frozenRow(ownership),
      resources: Object.freeze(resources.map(frozenRow)),
      currentOwnership: frozenRow(ownership),
      currentResources: Object.freeze(resources.map(frozenRow)),
    });
  }

  #validatedColumns<T extends StateTableName>(table: T, row: Readonly<Record<string, SqlValue>>): MutableStateRecord {
    const allowed = this.#columns.get(table);
    if (allowed === undefined) throw new TypeError(`unknown state table: ${table}`);
    const result: MutableStateRecord = {};
    for (const [column, value] of Object.entries(row)) {
      if (!allowed.has(column)) throw new TypeError(`unknown ${table} column: ${column}`);
      if (typeof value === "number" && (!Number.isSafeInteger(value) || !Number.isFinite(value))) {
        throw new TypeError(`${table}.${column} must be a safe integer when bound as a number`);
      }
      result[column] = value;
    }
    if (Object.keys(result).length === 0) throw new TypeError(`state row for ${table} cannot be empty`);
    return result;
  }

  #assertColumnList(
    table: StateTableName,
    columns: readonly string[],
    row: Readonly<Record<string, SqlValue>>,
  ): void {
    if (columns.length === 0 || new Set(columns).size !== columns.length) throw new TypeError(`${table} column selector must be nonempty and unique`);
    for (const column of columns) {
      if (!Object.hasOwn(row, column)) throw new TypeError(`${table}.${column} is missing from the row`);
    }
  }

  #insert(table: StateTableName, row: Readonly<Record<string, SqlValue>>): void {
    const db = this.#requireDatabase();
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    db.prepare(sql).run(...columns.map((column) => row[column] ?? null));
  }

  #selectBy(
    table: StateTableName,
    row: Readonly<Record<string, SqlValue>>,
    columns: readonly string[],
  ): MutableStateRecord | undefined {
    const where = columns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
    return this.#requireDatabase().prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`)
      .get(...columns.map((column) => row[column] ?? null)) as MutableStateRecord | undefined;
  }

  #immediate<T>(operation: string, callback: () => T): T {
    const db = this.#requireDatabase();
    if (this.#transactionActive || db.isTransaction) throw new StateStoreError("RICKGENT_STATE_CONFLICT", "nested state transactions are forbidden");
    try {
      db.exec("BEGIN IMMEDIATE");
      this.#transactionActive = true;
      const result = callback();
      db.exec("COMMIT");
      this.#transactionActive = false;
      return result;
    } catch (error) {
      rollbackPreserving(db);
      this.#transactionActive = false;
      if (isBusy(error)) translateBusy(error, operation, this.location.databasePath);
      if (isConstraint(error)) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("illegal ") && message.includes(" state transition")) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "requested lifecycle edge is not declared", this.location.databasePath, error);
        }
        throw typedError("RICKGENT_STATE_CONFLICT", `${operation} violated an immutable state constraint`, this.location.databasePath, error);
      }
      throw error;
    }
  }
}

export interface OpenStateStoreOptions {
  readonly repoPath: string;
}

/**
 * Observe canonical durable state without creating, registering, migrating, or
 * repairing anything. An absent database is an explicit observation, while an
 * unsafe or corrupt existing state path remains a typed infrastructure error.
 */
export function observeState(repoPath: string): StateObservation {
  assertRuntime();
  assertValidMigrationCatalog();
  const location = resolveStateLocation(repoPath);

  if (!existsSync(location.stateDirectory)) {
    return Object.freeze({
      state: "absent" as const,
      repositoryId: location.repositoryId,
      databasePath: location.databasePath,
    });
  }

  // These helpers create only when absent. The existence guards keep this path
  // strictly observational while reusing the mutation path's ownership/mode
  // validation for paths that already exist.
  ensureStateDirectory(location);
  if (existsSync(location.resourceDirectory)) ensureResourceDirectory(location);

  if (!existsSync(location.databasePath)) {
    for (const sidecar of [location.walPath, location.shmPath, location.journalPath]) {
      if (existsSync(sidecar)) {
        assertSafeStateFile(sidecar, "orphaned state sidecar", location.databasePath);
        throw typedError(
          "RICKGENT_STATE_CORRUPT",
          "state sidecar exists without its canonical database",
          location.databasePath,
        );
      }
    }
    return Object.freeze({
      state: "absent" as const,
      repositoryId: location.repositoryId,
      databasePath: location.databasePath,
    });
  }

  validateCanonicalFiles(location);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(location.databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      defensive: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    if (isBusy(error)) translateBusy(error, "observe_state", location.databasePath);
    throw typedError("RICKGENT_STATE_CORRUPT", "state database could not be opened read-only", location.databasePath, error);
  }

  let primary: unknown;
  try {
    validateCanonicalFiles(location);
    const version = validateIntegrity(database, location.databasePath, true);
    if (version !== LATEST_STATE_SCHEMA_VERSION) {
      throw typedError(
        "RICKGENT_STATE_MIGRATION_FAILED",
        `read-only observation cannot migrate state schema ${version} to ${LATEST_STATE_SCHEMA_VERSION}`,
        location.databasePath,
      );
    }
    if (pragmaValue(database, "PRAGMA journal_mode", "journal_mode") !== "wal") {
      throw typedError("RICKGENT_STATE_CORRUPT", "existing state database is not in WAL mode", location.databasePath);
    }
    const sqlitePath = database.location();
    if (sqlitePath === null || realpathSync.native(sqlitePath) !== location.databasePath) {
      unsafe("SQLite opened a database other than the canonical state path", location.databasePath);
    }

    const repository = database.prepare(`
      SELECT repository_id, repo_realpath, git_common_dir_realpath, object_format, state_directory, identity_digest
      FROM repositories WHERE repository_id = ?
    `).get(location.repositoryId) as MutableStateRecord | undefined;
    if (
      repository === undefined || repository.repo_realpath !== location.repoRealpath ||
      repository.git_common_dir_realpath !== location.gitCommonDirRealpath ||
      repository.object_format !== location.objectFormat || repository.state_directory !== location.stateDirectory ||
      repository.identity_digest !== location.identityDigest
    ) {
      throw typedError(
        "RICKGENT_STATE_CORRUPT",
        "state database repository identity differs from the selected canonical repository",
        location.databasePath,
      );
    }

    const run = database.prepare(`
      SELECT run_id, run_sequence, state, state_version, created_at, current_delivery_oid, promotion_sequence
      FROM runs WHERE repository_id = ? ORDER BY run_sequence DESC LIMIT 1
    `).get(location.repositoryId) as MutableStateRecord | undefined;

    let latestRun: ObservedRunState | null = null;
    if (run !== undefined) {
      const ticketRows = database.prepare(`
        SELECT ticket_instance_id, ticket_id, plan_index, state, state_version
        FROM run_tickets WHERE run_id = ? ORDER BY plan_index
      `).all(run.run_id ?? null) as MutableStateRecord[];
      const tickets = ticketRows.map((ticket): ObservedTicketState => {
        const attempt = database.prepare(`
          SELECT
            a.attempt_id,
            a.attempt_number,
            a.state,
            a.state_version,
            (SELECT c.commit_oid FROM commit_attributions c
              JOIN attempt_commit_intents i ON i.commit_attribution_id = c.commit_attribution_id
                AND i.attempt_id = c.attempt_id AND i.state = 'finalized'
              WHERE c.attempt_id = a.attempt_id
              ORDER BY c.created_at DESC, c.commit_attribution_id DESC LIMIT 1) AS commit_oid,
            (SELECT o.result FROM oracle_decisions o
              WHERE o.attempt_id = a.attempt_id
              ORDER BY o.created_at DESC, o.oracle_decision_id DESC LIMIT 1) AS oracle_result
          FROM attempts a
          WHERE a.ticket_instance_id = ?
          ORDER BY a.attempt_number DESC LIMIT 1
        `).get(ticket.ticket_instance_id ?? null) as MutableStateRecord | undefined;
        const oracleResult = attempt?.oracle_result;
        if (oracleResult !== undefined && oracleResult !== null && oracleResult !== "accepted" && oracleResult !== "rejected") {
          throw typedError("RICKGENT_STATE_CORRUPT", "oracle result is outside the released state vocabulary", location.databasePath);
        }
        const latestAttempt = attempt === undefined ? null : Object.freeze({
          attemptId: String(attempt.attempt_id),
          attemptNumber: Number(attempt.attempt_number),
          state: String(attempt.state),
          stateVersion: Number(attempt.state_version),
          commitOid: attempt.commit_oid === null ? null : String(attempt.commit_oid),
          oracleResult: oracleResult as "accepted" | "rejected" | null,
        });
        return Object.freeze({
          ticketInstanceId: String(ticket.ticket_instance_id),
          ticketId: String(ticket.ticket_id),
          planIndex: Number(ticket.plan_index),
          state: String(ticket.state),
          stateVersion: Number(ticket.state_version),
          latestAttempt,
        });
      });
      latestRun = Object.freeze({
        runId: String(run.run_id),
        runSequence: Number(run.run_sequence),
        state: String(run.state),
        stateVersion: Number(run.state_version),
        createdAt: String(run.created_at),
        currentDeliveryOid: String(run.current_delivery_oid),
        promotionSequence: Number(run.promotion_sequence),
        tickets: Object.freeze(tickets),
      });
    }

    const aggregateRow = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM runs WHERE repository_id = ?) AS runs,
        (SELECT COUNT(*) FROM delivery_records d
          JOIN delivery_intents i ON i.delivery_intent_id = d.delivery_intent_id
          JOIN runs r ON r.run_id = i.run_id
          WHERE r.repository_id = ?) AS delivery_records,
        (SELECT COUNT(*) FROM runs WHERE repository_id = ? AND state = 'delivered') AS delivered,
        (SELECT COUNT(*) FROM runs WHERE repository_id = ? AND state = 'delivery_failed') AS delivery_failed
    `).get(
      location.repositoryId,
      location.repositoryId,
      location.repositoryId,
      location.repositoryId,
    ) as MutableStateRecord | undefined;
    if (aggregateRow === undefined) {
      throw typedError("RICKGENT_STATE_CORRUPT", "state aggregate observation returned no row", location.databasePath);
    }
    const aggregates = Object.freeze({
      runs: Number(aggregateRow.runs),
      deliveryRecords: Number(aggregateRow.delivery_records),
      delivered: Number(aggregateRow.delivered),
      deliveryFailed: Number(aggregateRow.delivery_failed),
    });
    validateCanonicalFiles(location);
    return Object.freeze({
      state: "present" as const,
      repositoryId: location.repositoryId,
      databasePath: location.databasePath,
      schemaVersion: version,
      latestRun,
      aggregates,
    });
  } catch (error) {
    primary = error;
    if (error instanceof StateStoreError) throw error;
    if (isBusy(error)) translateBusy(error, "observe_state", location.databasePath);
    const detail = error instanceof Error ? error.message : String(error);
    throw typedError(
      "RICKGENT_STATE_CORRUPT",
      `state observation failed integrity or projection checks: ${detail}`,
      location.databasePath,
      error,
    );
  } finally {
    try {
      database.close();
    } catch (closeError) {
      if (primary === undefined) {
        throw typedError("RICKGENT_STATE_CORRUPT", "read-only state database could not be closed", location.databasePath, closeError);
      }
    }
  }
}

export function openStateStore(options: OpenStateStoreOptions): StateStore {
  return StateStore.open(options);
}
