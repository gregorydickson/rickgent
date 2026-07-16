import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  INITIAL_STATE_SCHEMA_OBJECTS,
  INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM,
  LATEST_STATE_SCHEMA_VERSION,
  STATE_MIGRATIONS,
  assertValidMigrationCatalog,
  type StateMigration,
} from "./migrations.js";
import {
  APPEND_ONLY_STATE_TABLES,
  ATTEMPT_TRANSITIONS,
  LEGACY_ARTIFACT_KINDS,
  PROMOTION_TRANSITIONS,
  RUN_TRANSITIONS,
  STATE_SQLITE_MINIMUM_NODE_VERSION,
  STATE_TABLES,
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
  type CommitAttributionRecordRequest,
  type DeliveryDecisionRequest,
  type DeliveryIntentRequest,
  type GateResultRecordRequest,
  type PersistedTransitionEvidenceReference,
  type ProcessReceiptRecordRequest,
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

type SqlValue = null | string | number | bigint | Uint8Array;
export type StateRecord = Readonly<Record<string, SqlValue>>;
type MutableStateRecord = Record<string, SqlValue>;
export type StateTableName = (typeof STATE_TABLES)[number];
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

export interface EvaluateAttemptOracleRequest {
  readonly attemptId: string;
  readonly idempotencyKey: string;
}

export interface PersistedAttemptOracleDecision {
  readonly decision: StateRecord;
  readonly references: readonly StateRecord[];
}

export interface LeaseCasRequest {
  readonly leaseId: string;
  readonly ownerTokenDigest: string;
  readonly generation: number;
  readonly ownerContextId: string;
  readonly expectedState: string;
  readonly expectedVersion: number;
  readonly changes: StateRowInput;
  readonly snapshotEvidence: StateRowInput;
}

export interface ResourceCasRequest {
  readonly resourceId: string;
  readonly allocationLeaseId: string;
  readonly ownerTokenDigest: string;
  readonly ownerGeneration: number;
  readonly ownerContextId: string;
  readonly expectedState: string;
  readonly expectedVersion: number;
  readonly changes: StateRowInput;
  readonly snapshotEvidence: StateRowInput;
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
    if (migration.version === LATEST_STATE_SCHEMA_VERSION) validateReleasedSchema(db, databasePath);
    db.exec("COMMIT");
    return migration.version;
  } catch (error) {
    rollbackPreserving(db);
    if (isBusy(error)) translateBusy(error, `migration ${migration.name}`, databasePath);
    if (!migrationStarted && error instanceof StateStoreError) throw error;
    throw typedError(
      "RICKGENT_STATE_MIGRATION_FAILED",
      `migration ${migration.name} rolled back without changing authoritative state`,
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

function validateReleasedSchema(db: DatabaseSync, databasePath: string): void {
  if (LATEST_STATE_SCHEMA_VERSION !== 1) return;
  if (sqliteSchemaChecksum(db) !== INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM) {
    throw typedError("RICKGENT_STATE_CORRUPT", "sqlite_schema does not equal the released migration definition", databasePath);
  }
  const tables = db.prepare("PRAGMA table_list").all() as Array<Record<string, SqlValue>>;
  const strict = new Map(tables.map((row) => [row.name, row.strict]));
  for (const table of INITIAL_STATE_SCHEMA_OBJECTS.tables) {
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
    if (expectLatestSchema && version === LATEST_STATE_SCHEMA_VERSION) validateReleasedSchema(db, databasePath);
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

/** Pure parser/digester for `git diff --raw -z --no-abbrev -M`; shared by production and conformance tests. */
export function canonicalGitDeltaFromRaw(raw: string): CanonicalGitDelta {
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const entries: CanonicalGitDeltaEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++];
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(header ?? "");
    if (match === null) throw new TypeError("malformed raw Git delta");
    const [, oldMode, newMode, , , status] = match;
    const firstPath = tokens[index++];
    if (firstPath === undefined || firstPath.length === 0) throw new TypeError("raw Git delta contains an empty path");
    if (oldMode === "160000" || newMode === "160000") throw new TypeError("raw Git delta contains an unsupported submodule");
    if (status === "R") {
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

export class StateStore {
  readonly location: StateLocation;
  #database: DatabaseSync | undefined;
  #transactionActive = false;
  readonly #columns = new Map<StateTableName, ReadonlySet<string>>();

  private constructor(location: StateLocation, database: DatabaseSync) {
    this.location = location;
    this.#database = database;
    for (const table of STATE_TABLES) {
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

  createLease(leaseInput: StateRowInput, snapshotEvidence: StateRowInput): StateRecord {
    const lease = this.#validatedColumns("leases", normalizeRow(leaseInput));
    this.#requireCompleteRow("leases", lease);
    if (lease.state !== "reserved" || lease.state_version !== 0) throw new TypeError("a new lease must begin reserved at state_version 0");
    return this.#immediate("acquire_lease", () => {
      const existing = this.#selectBy("leases", lease, ["lease_id"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, lease)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "lease identity already has different immutable input", this.location.databasePath);
      }
      const evidence = this.#prepareSnapshotEvidence("rickgent.lease-snapshot.v1", lease, snapshotEvidence);
      if (evidence.evidence_id !== lease.acquisition_evidence_id) throw new TypeError("lease acquisition evidence id does not match its snapshot");
      this.#insertEvidenceInTransaction(evidence);
      this.#insert("leases", lease);
      return frozenRow(lease);
    });
  }

  updateLease(request: LeaseCasRequest): StateRecord {
    return this.#immediate("heartbeat_lease", () => {
      const current = this.#selectBy("leases", { lease_id: request.leaseId }, ["lease_id"]);
      if (
        current === undefined || current.owner_token_digest !== request.ownerTokenDigest ||
        current.generation !== request.generation || current.owner_context_id !== request.ownerContextId
      ) {
        throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "lease owner proof does not match", this.location.databasePath);
      }
      if (current.state !== request.expectedState || current.state_version !== request.expectedVersion) {
        throw typedError("RICKGENT_STATE_CONFLICT", "lease compare-and-set preimage changed", this.location.databasePath);
      }
      const changes = this.#validatedColumns("leases", normalizeRow(request.changes));
      const allowed = new Set(["heartbeat_at", "expires_at", "state", "release_evidence_id"]);
      for (const column of Object.keys(changes)) if (!allowed.has(column)) throw new TypeError(`lease CAS cannot update ${column}`);
      const desired = { ...current, ...changes, state_version: request.expectedVersion + 1 };
      const evidence = this.#prepareSnapshotEvidence("rickgent.lease-snapshot.v1", desired, request.snapshotEvidence);
      this.#insertEvidenceInTransaction(evidence);
      const assignments = [...Object.keys(changes), "state_version"];
      const result = this.#requireDatabase().prepare(
        `UPDATE leases SET ${assignments.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")}
         WHERE lease_id = ? AND owner_token_digest = ? AND generation = ? AND owner_context_id = ? AND state = ? AND state_version = ?`,
      ).run(
        ...Object.keys(changes).map((column) => changes[column] ?? null),
        request.expectedVersion + 1,
        request.leaseId,
        request.ownerTokenDigest,
        request.generation,
        request.ownerContextId,
        request.expectedState,
        request.expectedVersion,
      );
      if (result.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "lease compare-and-set changed zero rows", this.location.databasePath);
      return frozenRow(desired);
    });
  }

  createAttemptResource(resourceInput: StateRowInput, snapshotEvidence: StateRowInput, ownerTokenDigest: string): StateRecord {
    const resource = this.#validatedColumns("attempt_resources", normalizeRow(resourceInput));
    this.#requireCompleteRow("attempt_resources", resource);
    if (resource.state !== "reserved" || resource.state_version !== 0) throw new TypeError("a new resource must begin reserved at state_version 0");
    return this.#immediate("reserve_resource", () => {
      const lease = this.#requireDatabase().prepare(
        `SELECT lease_id FROM leases WHERE lease_id = ? AND attempt_id = ? AND generation = ?
         AND owner_context_id = ? AND owner_token_digest = ? AND state IN ('reserved','live','cleanup_pending')`,
      ).get(
        resource.allocation_lease_id ?? null,
        resource.attempt_id ?? null,
        resource.owner_generation ?? null,
        resource.owner_context_id ?? null,
        ownerTokenDigest,
      );
      if (lease === undefined) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "resource allocation lease proof does not match", this.location.databasePath);
      const existing = this.#selectBy("attempt_resources", resource, ["resource_id"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, resource)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "resource identity already has different immutable input", this.location.databasePath);
      }
      const evidence = this.#prepareSnapshotEvidence("rickgent.attempt-resource-snapshot.v1", resource, snapshotEvidence);
      if (evidence.evidence_id !== resource.allocation_evidence_id) throw new TypeError("resource allocation evidence id does not match its snapshot");
      this.#insertEvidenceInTransaction(evidence);
      this.#insert("attempt_resources", resource);
      return frozenRow(resource);
    });
  }

  updateAttemptResource(request: ResourceCasRequest): StateRecord {
    return this.#immediate("advance_resource", () => {
      const current = this.#selectBy("attempt_resources", { resource_id: request.resourceId }, ["resource_id"]);
      if (
        current === undefined || current.allocation_lease_id !== request.allocationLeaseId ||
        current.owner_generation !== request.ownerGeneration || current.owner_context_id !== request.ownerContextId
      ) {
        throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "resource owner proof does not match", this.location.databasePath);
      }
      const lease = this.#requireDatabase().prepare(
        "SELECT lease_id FROM leases WHERE lease_id = ? AND generation = ? AND owner_context_id = ? AND owner_token_digest = ?",
      ).get(request.allocationLeaseId, request.ownerGeneration, request.ownerContextId, request.ownerTokenDigest);
      if (lease === undefined) throw typedError("RICKGENT_STATE_OWNER_MISMATCH", "resource lease token proof does not match", this.location.databasePath);
      if (current.state !== request.expectedState || current.state_version !== request.expectedVersion) {
        throw typedError("RICKGENT_STATE_CONFLICT", "resource compare-and-set preimage changed", this.location.databasePath);
      }
      const changes = this.#validatedColumns("attempt_resources", normalizeRow(request.changes));
      const allowed = new Set(["owner_generation", "owner_context_id", "state", "release_evidence_id", "quarantine_evidence_id"]);
      for (const column of Object.keys(changes)) if (!allowed.has(column)) throw new TypeError(`resource CAS cannot update ${column}`);
      const desired = { ...current, ...changes, state_version: request.expectedVersion + 1 };
      const evidence = this.#prepareSnapshotEvidence("rickgent.attempt-resource-snapshot.v1", desired, request.snapshotEvidence);
      this.#insertEvidenceInTransaction(evidence);
      const assignments = [...Object.keys(changes), "state_version"];
      const result = this.#requireDatabase().prepare(
        `UPDATE attempt_resources SET ${assignments.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")}
         WHERE resource_id = ? AND owner_generation = ? AND owner_context_id = ? AND state = ? AND state_version = ? AND allocation_lease_id = ?`,
      ).run(
        ...Object.keys(changes).map((column) => changes[column] ?? null),
        request.expectedVersion + 1,
        request.resourceId,
        request.ownerGeneration,
        request.ownerContextId,
        request.expectedState,
        request.expectedVersion,
        request.allocationLeaseId,
      );
      if (result.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "resource compare-and-set changed zero rows", this.location.databasePath);
      return frozenRow(desired);
    });
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

    const receipts = db.prepare(`
      SELECT p.* FROM process_receipts p JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id
      WHERE x.attempt_id = ? ORDER BY x.phase_ordinal, x.phase, x.role, p.process_receipt_id
    `).all(attemptId) as MutableStateRecord[];
    for (const receipt of receipts) {
      const sealed = { ...receipt } as Readonly<Record<string, unknown>>;
      add("process_receipt", String(receipt.process_receipt_id), this.#storedRecordDigest("process_receipts", receipt), ticketInstanceId, attemptId, sealed);
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
      FROM commit_attributions c JOIN evidence e ON e.evidence_id = c.attribution_evidence_id
      WHERE c.attempt_id = ?
    `).get(attemptId) as MutableStateRecord | undefined;
    if (attribution !== undefined) {
      const sealed = this.#parseJsonObject(String(attribution.inline_payload_json), "oracle commit attribution evidence");
      if (
        attribution.evidence_schema_version !== "rickgent.commit-attribution.v1" ||
        attribution.evidence_content_digest !== sha256Text(canonicalJson(sealed)) ||
        sealed.contract_digest !== attribution.contract_digest || sealed.baseline_oid !== attribution.baseline_oid ||
        sealed.parent_oid !== attribution.parent_oid || sealed.tree_before_oid !== attribution.tree_before_oid ||
        sealed.tree_after_oid !== attribution.tree_after_oid || sealed.commit_oid !== attribution.commit_oid ||
        sealed.path_set_digest !== attribution.path_set_digest || sealed.change_kind_set_digest !== attribution.change_kind_set_digest ||
        sealed.mode_set_digest !== attribution.mode_set_digest
      ) this.#resumeIncompatible("oracle attribution row is not bound to exact normalized delta evidence");
      add("commit_attribution", String(attribution.commit_attribution_id), String(attribution.evidence_content_digest), ticketInstanceId, attemptId, sealed);
    }

    const cleanup = db.prepare(`
      SELECT c.*, e.scope AS evidence_scope, e.schema_version AS evidence_schema_version,
             e.inline_payload_json, e.content_digest AS evidence_content_digest
      FROM cleanup_records c JOIN evidence e ON e.evidence_id = c.evidence_id
      WHERE c.attempt_id = ? ORDER BY c.sequence DESC LIMIT 1
    `).get(attemptId) as MutableStateRecord | undefined;
    if (cleanup !== undefined) {
      const sealed = this.#parseJsonObject(String(cleanup.inline_payload_json), "oracle cleanup evidence");
      const recordPayload = {
        attempt_id: cleanup.attempt_id,
        sequence: cleanup.sequence,
        context_id: cleanup.context_id,
        outcome: cleanup.outcome,
        group_dead: cleanup.group_dead,
        worktree_disposition: cleanup.worktree_disposition,
        index_disposition: cleanup.index_disposition,
        ref_disposition: cleanup.ref_disposition,
        context_disposition: cleanup.context_disposition,
        bundle_disposition: cleanup.bundle_disposition,
        delivery_ref_observed_oid: cleanup.delivery_ref_observed_oid,
        resources_absent: cleanup.resources_absent,
        lease_release_eligible: cleanup.lease_release_eligible,
        evidence_id: cleanup.evidence_id,
      };
      const cleanupEvidenceMatches = [
        "attempt_id", "sequence", "context_id", "outcome", "group_dead", "worktree_disposition",
        "index_disposition", "ref_disposition", "context_disposition", "bundle_disposition",
        "delivery_ref_observed_oid", "resources_absent", "lease_release_eligible",
      ].every((column) => sealed[column] === cleanup[column]) &&
        (sealed.evidence_id === undefined || sealed.evidence_id === cleanup.evidence_id);
      if (
        cleanup.evidence_schema_version !== "rickgent.cleanup-record.v1" ||
        cleanup.record_digest !== sha256Text(canonicalJson(recordPayload)) ||
        cleanup.evidence_content_digest !== sha256Text(canonicalJson(sealed)) || !cleanupEvidenceMatches
      ) this.#resumeIncompatible("oracle cleanup row is not bound to exact cleanup evidence");
      add("cleanup_record", String(cleanup.cleanup_record_id), String(cleanup.evidence_content_digest), ticketInstanceId, attemptId, sealed);
    }

    const resources = db.prepare("SELECT * FROM attempt_resources WHERE attempt_id = ? ORDER BY slot, resource_id").all(attemptId) as MutableStateRecord[];
    for (const resource of resources) {
      const sealed = { ...resource } as Readonly<Record<string, unknown>>;
      const evidence = this.#exactSnapshotEvidence(attemptId, "rickgent.attempt-resource-snapshot.v1", sealed, "attempt resource");
      add("attempt_resource_snapshot", String(evidence.evidence_id), String(evidence.content_digest), ticketInstanceId, attemptId, sealed);
    }
    const leases = db.prepare("SELECT * FROM leases WHERE attempt_id = ? ORDER BY generation, lease_id").all(attemptId) as MutableStateRecord[];
    for (const lease of leases) {
      const sealed = { ...lease } as Readonly<Record<string, unknown>>;
      const evidence = this.#exactSnapshotEvidence(attemptId, "rickgent.lease-snapshot.v1", sealed, "lease");
      add("lease_snapshot", String(evidence.evidence_id), String(evidence.content_digest), ticketInstanceId, attemptId, sealed);
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
    schemaVersion: string,
    sealed: Readonly<Record<string, unknown>>,
    label: string,
  ): MutableStateRecord {
    const payload = canonicalJson(sealed);
    const digest = sha256Text(payload);
    const evidence = this.#requireDatabase().prepare(`
      SELECT * FROM evidence WHERE attempt_id = ? AND schema_version = ?
        AND inline_payload_json = ? AND content_digest = ?
      ORDER BY created_at DESC, evidence_id DESC LIMIT 1
    `).get(attemptId, schemaVersion, payload, digest) as MutableStateRecord | undefined;
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
      case "process_receipt": return this.#recordProcessReceipt(command.command.request);
      case "review_record": return this.#recordReview(command.command.request);
      case "remediation_record": return this.#recordRemediation(command.command.request);
      case "gate_result": return this.#recordGateResult(command.command.request);
      case "commit_attribution": return this.#recordCommitAttribution(command.command.request);
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
    table: "process_receipts" | "review_records" | "remediation_records" | "gate_results" | "commit_attributions" | "cleanup_records",
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
    table: "process_receipts" | "review_records" | "remediation_records" | "gate_results" | "commit_attributions" | "cleanup_records",
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

  #recordProcessReceipt(request: ProcessReceiptRecordRequest): StateRecord {
    const row = this.#validatedColumns("process_receipts", normalizeRow({
      process_receipt_id: request.processReceiptId,
      phase_execution_id: request.phaseExecutionId,
      context_id: request.contextId,
      lease_id: request.leaseId,
      lease_generation: request.leaseGeneration,
      pid: request.pid,
      pgid: request.pgid,
      boot_identity: request.bootIdentity,
      process_start_identity: request.processStartIdentity,
      argv_digest: request.argvDigest,
      environment_digest: request.environmentDigest,
      launch_evidence_id: request.launchEvidenceId,
      exit_evidence_id: request.exitEvidenceId,
      termination_evidence_id: request.terminationEvidenceId,
      group_death_evidence_id: request.groupDeathEvidenceId,
      stdout_evidence_id: request.stdoutEvidenceId,
      stderr_evidence_id: request.stderrEvidenceId,
      created_at: request.createdAt,
    }));
    this.#requireCompleteRow("process_receipts", row);
    return this.#immediate("persist_process_receipt", () => {
      const replay = this.#replayExactLifecycleRow("process_receipts", row, ["phase_execution_id"]);
      if (replay !== undefined) {
        this.#requireReplayContext(request.contextId, request.attemptId, request.ownerContextDigest, "implement", "worker", "process receipt");
        return replay;
      }
      this.#requireTransitionGuard(`
        SELECT 1 FROM phase_executions x JOIN execution_contexts c ON c.context_id = x.context_id
        JOIN leases l ON l.lease_id = ? AND l.attempt_id = x.attempt_id AND l.generation = ?
        JOIN attempts a ON a.attempt_id = x.attempt_id AND a.state = 'implementing'
        WHERE x.phase_execution_id = ? AND x.attempt_id = ? AND x.context_id = ? AND c.context_digest = ?
          AND c.phase = 'implement' AND c.role = 'worker' AND x.phase = c.phase AND x.role = c.role
      `, [request.leaseId, request.leaseGeneration, request.phaseExecutionId, request.attemptId, request.contextId, request.ownerContextDigest], "process receipt phase, lease, or owner lineage differs");
      for (const [id, label] of [
        [request.launchEvidenceId, "launch"], [request.exitEvidenceId, "exit"],
        [request.terminationEvidenceId, "termination"], [request.groupDeathEvidenceId, "group death"],
        [request.stdoutEvidenceId, "stdout"], [request.stderrEvidenceId, "stderr"],
      ] as const) if (id !== null) this.#requireOwnedEvidence(id, request.attemptId, "AttemptLifecycleService", label);
      return this.#insertExactLifecycleRow("process_receipts", row, ["phase_execution_id"]);
    });
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

  #recordCommitAttribution(request: CommitAttributionRecordRequest): StateRecord {
    const row = this.#validatedColumns("commit_attributions", normalizeRow({
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
    this.#requireCompleteRow("commit_attributions", row);
    return this.#immediate("persist_commit_attribution", () => {
      const existing = this.#selectBy("commit_attributions", row, ["attempt_id"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, row)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "commit attribution attempt has different immutable input", this.location.databasePath);
      }
      const lineage = this.#requireTransitionGuard(`
        SELECT a.delivery_baseline_oid, a.contract_digest, c.scope_digest, tc.canonical_contract_json
        FROM attempts a JOIN execution_contexts c ON c.attempt_id = a.attempt_id AND c.context_digest = ?
        JOIN ticket_contracts tc ON tc.contract_digest = a.contract_digest
        WHERE a.attempt_id = ?
          AND c.phase = 'implement' AND c.role = 'worker' AND a.state = 'converging'
      `, [request.contextDigest, request.attemptId], "commit attribution context differs from its attempt");
      if (lineage.delivery_baseline_oid !== request.baselineOid || lineage.contract_digest !== request.contractDigest || request.parentOid !== request.baselineOid) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit attribution baseline, parent, or contract differs from its attempt", this.location.databasePath);
      }
      this.#assertRepositoryCommit(request.commitOid, "attributed commit oid");
      const ancestry = execFileSync("git", ["rev-list", "--parents", "-n", "1", request.commitOid], { cwd: this.location.repoRealpath, encoding: "utf8" }).trim().split(/\s+/);
      const beforeTree = execFileSync("git", ["rev-parse", `${request.baselineOid}^{tree}`], { cwd: this.location.repoRealpath, encoding: "utf8" }).trim();
      const afterTree = execFileSync("git", ["rev-parse", `${request.commitOid}^{tree}`], { cwd: this.location.repoRealpath, encoding: "utf8" }).trim();
      if (ancestry.length !== 2 || ancestry[1] !== request.parentOid || beforeTree !== request.treeBeforeOid || afterTree !== request.treeAfterOid) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit attribution does not match the repository parent and tree identities", this.location.databasePath);
      }
      const contract = this.#parseJsonObject(String(lineage.canonical_contract_json), "commit attribution ticket contract");
      if (lineage.scope_digest !== sha256Text(canonicalJson(contract.scope))) {
        throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit attribution context scope digest differs from the sealed ticket scope", this.location.databasePath);
      }
      const delta = this.#canonicalGitDelta(request.baselineOid, request.commitOid, "commit attribution delta");
      if (delta.entries.length === 0) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit attribution cannot authorize an empty delta", this.location.databasePath);
      this.#assertDeltaWithinScope(delta, contract.scope, "commit attribution delta");
      if (
        request.pathSetDigest !== delta.pathSetDigest || request.changeKindSetDigest !== delta.changeKindSetDigest ||
        request.modeSetDigest !== delta.modeSetDigest
      ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "commit attribution digests differ from the independently observed Git delta", this.location.databasePath);
      this.#requireOwnedEvidence(request.attributionEvidenceId, request.attemptId, "AttemptLifecycleService", "commit attribution");
      this.#requireExactInlineEvidence(request.attributionEvidenceId, "AttemptLifecycleService", request.commitAttributionId, "rickgent.commit-attribution.v1", {
        contract_digest: request.contractDigest,
        baseline_oid: request.baselineOid,
        parent_oid: request.parentOid,
        tree_before_oid: request.treeBeforeOid,
        tree_after_oid: request.treeAfterOid,
        commit_oid: request.commitOid,
        candidate_diff_digest: delta.candidateDiffDigest,
        path_set_digest: request.pathSetDigest,
        change_kind_set_digest: request.changeKindSetDigest,
        mode_set_digest: request.modeSetDigest,
        normalized_delta: delta.entries,
      }, "commit attribution");
      return this.#insertExactLifecycleRow("commit_attributions", row, ["attempt_id"]);
    });
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
      if (request.leaseReleaseEligible) this.#validateCleanAttempt(request.attemptId, request.cleanupRecordId);
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

  #validateCleanAttempt(attemptId: string, cleanupRecordId: string): MutableStateRecord {
    const cleanup = this.#requireTransitionGuard(`
      SELECT c.*, a.run_id, a.ticket_instance_id
      FROM cleanup_records c JOIN attempts a ON a.attempt_id = c.attempt_id
      WHERE c.cleanup_record_id = ? AND c.attempt_id = ?
    `, [cleanupRecordId, attemptId], "cleanup record does not belong to the transition attempt");
    if (cleanup.group_dead !== 1 || cleanup.resources_absent !== 1 || cleanup.lease_release_eligible !== 1) {
      throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "cleanup record does not prove group death, resource absence, and lease release eligibility", this.location.databasePath);
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
          SELECT 1 FROM leases l JOIN execution_contexts c ON c.context_id = l.owner_context_id
          WHERE l.lease_id = ? AND l.attempt_id = ? AND l.state = 'live' AND c.context_digest = ?
        `, [guard.leaseId, command.entityId, command.ownerContextDigest], "attempt start requires its live owner-checked lease");
        const requiredKinds = ["attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle", "process_group", "stdout", "stderr"];
        const resources = this.#requireDatabase().prepare(`
          SELECT DISTINCT r.kind FROM attempt_resources r
          JOIN execution_contexts c ON c.context_id = r.owner_context_id
          WHERE r.attempt_id = ? AND r.allocation_lease_id = ? AND r.state IN ('reserved','allocated','active')
            AND c.context_digest = ?
        `).all(command.entityId, guard.leaseId, command.ownerContextDigest) as MutableStateRecord[];
        const observed = new Set(resources.map((row) => String(row.kind)));
        if (requiredKinds.some((kind) => !observed.has(kind))) {
          throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "attempt start is missing required reserved resources", this.location.databasePath);
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
          throw new TypeError("verification convergence requires a nonempty unique gate result set");
        }
        const rows = this.#requireDatabase().prepare(`
          SELECT g.gate_result_id, g.required, g.status, g.evidence_id, c.context_digest
          FROM gate_results g JOIN execution_contexts c ON c.context_id = g.context_id
          WHERE g.attempt_id = ? ORDER BY g.gate_result_id
        `).all(command.entityId) as MutableStateRecord[];
        const selected = [...guard.gateResultIds].sort();
        if (
          rows.length !== selected.length || rows.some((row, index) => row.gate_result_id !== selected[index]) ||
          rows.some((row) => row.context_digest !== command.ownerContextDigest) ||
          rows.some((row) => row.required === 1 && row.status !== "passed")
        ) throw typedError("RICKGENT_STATE_TRANSITION_ILLEGAL", "gate selection must equal all attempt gates and every required gate must pass", this.location.databasePath);
        this.#requireCommandEvidence(evidence, rows.map((row) => row.evidence_id), "gate result evidence");
        return;
      }
      case "cleanup_pending":
        if (guard.commitAttributionId !== undefined) {
          const attribution = this.#requireTransitionGuard(
            "SELECT attribution_evidence_id FROM commit_attributions WHERE commit_attribution_id = ? AND attempt_id = ?",
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
          : this.#requireTransitionGuard(
            "SELECT * FROM cleanup_records WHERE cleanup_record_id = ? AND attempt_id = ?",
            [guard.cleanupRecordId, command.entityId],
            "quarantine transition requires an immutable cleanup observation",
          );
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
          ? this.#requireTransitionGuard(
            "SELECT * FROM cleanup_records WHERE cleanup_record_id = ? AND attempt_id = ? AND outcome = 'quarantined'",
            [guard.cleanupRecordId, guard.attemptId],
            "ticket quarantine requires its attempt quarantine cleanup record",
          )
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
    if (input.worktreeRealpath !== this.location.repoRealpath) {
      throw new TypeError("t14 context worktree must remain the selected repository until t15 persists attempt resources");
    }
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

  #prepareSnapshotEvidence(
    schemaVersion: string,
    postImage: Readonly<Record<string, SqlValue>>,
    evidenceInput: StateRowInput,
  ): MutableStateRecord {
    const evidence = this.#validatedColumns("evidence", normalizeRow(evidenceInput));
    this.#requireCompleteRow("evidence", evidence);
    if (
      evidence.schema_version !== schemaVersion || evidence.attempt_id !== postImage.attempt_id ||
      evidence.context_id !== postImage.owner_context_id || evidence.external_path !== null ||
      evidence.external_digest !== null || evidence.external_size !== null
    ) {
      throw new TypeError(`${schemaVersion} evidence does not match its source post-image scope`);
    }
    const expectedPayload = canonicalJson(postImage);
    if (evidence.inline_payload_json !== expectedPayload || evidence.content_digest !== sha256Text(expectedPayload)) {
      throw new TypeError(`${schemaVersion} evidence is not the exact canonical post-image`);
    }
    this.#validateRecordSemantics("evidence", evidence);
    return evidence;
  }

  #insertEvidenceInTransaction(evidence: MutableStateRecord): StateRecord {
    const existing = this.#selectBy("evidence", evidence, ["producer_service", "scope", "idempotency_key"]);
    if (existing !== undefined) {
      if (this.#sameRecord(existing, evidence)) return frozenRow(existing);
      throw typedError(
        "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
        "snapshot evidence idempotency key has different immutable input",
        this.location.databasePath,
      );
    }
    this.#insert("evidence", evidence);
    return frozenRow(evidence);
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
        requiredSchema = kind === "attempt_resource_snapshot" ? "rickgent.attempt-resource-snapshot.v1" :
          kind === "lease_snapshot" ? "rickgent.lease-snapshot.v1" : undefined;
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
