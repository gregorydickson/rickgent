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
  STATE_SQLITE_MINIMUM_NODE_VERSION,
  STATE_TABLES,
  type StateErrorCode,
} from "./schema.js";

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

  appendStateTransition(transitionInput: StateRowInput, evidenceReferences: readonly StateRowInput[]): StateRecord {
    const transition = this.#validatedColumns("state_transitions", normalizeRow(transitionInput));
    const references = evidenceReferences.map((input) => this.#validatedColumns("transition_evidence_refs", normalizeRow(input)));
    return this.#immediate("transition_entity_cas", () => {
      this.#validateRecordSemantics("state_transitions", transition);
      for (const reference of references) {
        if (reference.transition_id !== transition.transition_id) throw new TypeError("transition evidence scope does not match its transition");
        this.#validateTransitionEvidence(transition, reference);
      }
      const scopeColumn = transition.run_id !== null && transition.run_id !== undefined ? "run_id" :
        transition.ticket_instance_id !== null && transition.ticket_instance_id !== undefined ? "ticket_instance_id" : "attempt_id";
      const existing = this.#selectBy("state_transitions", transition, [scopeColumn, "idempotency_key"]);
      if (existing !== undefined) {
        const existingReferences = this.#requireDatabase().prepare(
          "SELECT * FROM transition_evidence_refs WHERE transition_id = ? ORDER BY ordinal",
        ).all(existing.transition_id ?? null) as MutableStateRecord[];
        if (
          this.#sameRecord(existing, transition) && existingReferences.length === references.length &&
          existingReferences.every((row, index) => references[index] !== undefined && this.#sameRecord(row, references[index]))
        ) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "transition idempotency key has different immutable input", this.location.databasePath);
      }
      this.#insert("state_transitions", transition);
      for (const reference of references) {
        this.#insert("transition_evidence_refs", reference);
      }
      return frozenRow(transition);
    });
  }

  persistOracleDecision(decisionInput: StateRowInput, referenceInputs: readonly StateRowInput[]): StateRecord {
    const decision = this.#validatedColumns("oracle_decisions", normalizeRow(decisionInput));
    this.#requireCompleteRow("oracle_decisions", decision);
    const references = referenceInputs.map((input) => {
      const row = this.#validatedColumns("oracle_input_references", normalizeRow(input));
      this.#requireCompleteRow("oracle_input_references", row);
      return row;
    });
    return this.#immediate("persist_oracle_decision", () => {
      this.#validateRecordSemantics("oracle_decisions", decision);
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        if (
          reference === undefined || reference.ordinal !== index ||
          reference.oracle_decision_id !== decision.oracle_decision_id || reference.run_id !== decision.run_id ||
          reference.ticket_instance_id !== decision.ticket_instance_id || reference.attempt_id !== decision.attempt_id
        ) {
          throw new TypeError("oracle input references must be contiguous and copy the exact decision scope");
        }
        this.#validateOracleReference(decision, reference);
      }
      const scopeColumn = decision.scope_kind === "run" ? "run_id" : decision.scope_kind === "ticket" ? "ticket_instance_id" : "attempt_id";
      const existing = this.#selectBy("oracle_decisions", decision, ["scope_kind", scopeColumn, "idempotency_key"]);
      if (existing !== undefined) {
        const existingReferences = this.#requireDatabase().prepare(
          "SELECT * FROM oracle_input_references WHERE oracle_decision_id = ? ORDER BY ordinal",
        ).all(existing.oracle_decision_id ?? null) as MutableStateRecord[];
        if (
          this.#sameRecord(existing, decision) && existingReferences.length === references.length &&
          existingReferences.every((row, index) => references[index] !== undefined && this.#sameRecord(row, references[index]))
        ) return frozenRow(existing);
        throw typedError(
          "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
          "oracle idempotency key has different immutable inputs",
          this.location.databasePath,
        );
      }
      this.#insert("oracle_decisions", decision);
      for (const reference of references) this.#insert("oracle_input_references", reference);
      return frozenRow(decision);
    });
  }

  createPromotionIntent(input: StateRowInput): StateRecord {
    const intent = this.#validatedColumns("promotion_intents", normalizeRow(input));
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
        if (this.#sameRecord(existing, intent)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "promotion idempotency key has different immutable input", this.location.databasePath);
      }
      const scope = this.#requireDatabase().prepare(`
        SELECT r.delivery_ref, r.current_delivery_oid, r.promotion_sequence, r.state_version AS run_state_version,
               a.delivery_baseline_oid, c.commit_oid, o.result AS oracle_result, o.scope_kind,
               x.attempt_id AS context_attempt_id
        FROM runs r
        JOIN attempts a ON a.run_id = r.run_id AND a.attempt_id = ? AND a.ticket_instance_id = ?
        JOIN commit_attributions c ON c.commit_attribution_id = ? AND c.attempt_id = a.attempt_id
        JOIN oracle_decisions o ON o.oracle_decision_id = ? AND o.run_id = r.run_id
          AND o.ticket_instance_id = a.ticket_instance_id AND o.attempt_id = a.attempt_id
        JOIN execution_contexts x ON x.context_id = ? AND x.attempt_id = a.attempt_id
        WHERE r.run_id = ?
      `).get(
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
        scope.commit_oid !== intent.candidate_oid || scope.oracle_result !== "accepted" || scope.scope_kind !== "attempt" ||
        scope.context_attempt_id !== intent.attempt_id ||
        typeof scope.promotion_sequence !== "number" || intent.promotion_sequence !== scope.promotion_sequence + 1
      ) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "promotion intent does not match its run, attempt, oracle, attribution, and owner lineage");
      }
      const update = this.#requireDatabase().prepare(`
        UPDATE runs SET promotion_sequence = ?, state_version = state_version + 1
        WHERE run_id = ? AND current_delivery_oid = ? AND promotion_sequence = ? AND state_version = ?
      `).run(
        intent.promotion_sequence ?? null,
        intent.run_id ?? null,
        intent.expected_old_oid ?? null,
        scope.promotion_sequence,
        scope.run_state_version ?? null,
      );
      if (update.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "promotion sequence reservation lost its CAS race", this.location.databasePath);
      this.#insert("promotion_intents", intent);
      return frozenRow(intent);
    });
  }

  createDeliveryIntent(input: StateRowInput): StateRecord {
    const intent = this.#validatedColumns("delivery_intents", normalizeRow(input));
    this.#requireCompleteRow("delivery_intents", intent);
    this.#assertRepositoryOid(intent.delivery_oid, "delivery intent oid");
    if (intent.expected_remote_oid !== null) this.#assertRepositoryOid(intent.expected_remote_oid, "expected remote oid");
    return this.#immediate("create_delivery_intent", () => {
      const existing = this.#selectBy("delivery_intents", intent, ["run_id", "idempotency_key"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, intent)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "delivery idempotency key has different immutable input", this.location.databasePath);
      }
      const run = this.#requireDatabase().prepare(
        "SELECT state, current_delivery_oid FROM runs WHERE run_id = ?",
      ).get(intent.run_id ?? null) as MutableStateRecord | undefined;
      if (run?.state !== "ready_for_delivery" || run.current_delivery_oid !== intent.delivery_oid) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "delivery intent is not pinned to a ready run's current delivery OID");
      }
      this.#insert("delivery_intents", intent);
      return frozenRow(intent);
    });
  }

  appendRemoteObservation(input: StateRowInput): StateRecord {
    return this.#appendExactSequence("remote_observations", input, ["delivery_intent_id", "sequence"]);
  }

  appendPrObservation(input: StateRowInput): StateRecord {
    const observation = this.#validatedColumns("pr_observations", normalizeRow(input));
    this.#requireCompleteRow("pr_observations", observation);
    this.#assertRepositoryOid(observation.observed_head_oid, "observed PR head oid");
    const intent = this.#requireDatabase().prepare(
      "SELECT delivery_oid FROM delivery_intents WHERE delivery_intent_id = ?",
    ).get(observation.delivery_intent_id ?? null) as MutableStateRecord | undefined;
    if (intent?.delivery_oid !== observation.observed_head_oid) {
      throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "PR observation head does not equal the exact delivery OID");
    }
    return this.#appendExactSequence("pr_observations", observation, ["delivery_intent_id", "sequence"]);
  }

  finalizeDelivery(input: StateRowInput, expectedRunVersion: number): StateRecord {
    const record = this.#validatedColumns("delivery_records", normalizeRow(input));
    this.#requireCompleteRow("delivery_records", record);
    this.#assertRepositoryOid(record.delivery_oid, "delivery record oid");
    return this.#immediate("finalize_delivery", () => {
      const existing = this.#selectBy("delivery_records", record, ["delivery_intent_id"]);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, record)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", "delivery intent already has a different terminal record", this.location.databasePath);
      }
      const lineage = this.#requireDatabase().prepare(`
        SELECT i.run_id, i.delivery_oid AS intent_oid, r.current_delivery_oid, r.state AS run_state,
               ro.observed_remote_oid, po.observed_head_oid
        FROM delivery_intents i JOIN runs r ON r.run_id = i.run_id
        LEFT JOIN remote_observations ro ON ro.remote_observation_id = ? AND ro.delivery_intent_id = i.delivery_intent_id
        LEFT JOIN pr_observations po ON po.pr_observation_id = ? AND po.delivery_intent_id = i.delivery_intent_id
        WHERE i.delivery_intent_id = ?
      `).get(
        record.remote_observation_id ?? null,
        record.pr_observation_id ?? null,
        record.delivery_intent_id ?? null,
      ) as MutableStateRecord | undefined;
      const delivered = record.decision === "delivered";
      if (
        lineage === undefined || lineage.run_state !== "ready_for_delivery" || lineage.intent_oid !== record.delivery_oid ||
        lineage.current_delivery_oid !== record.delivery_oid ||
        (delivered && (lineage.observed_remote_oid !== record.delivery_oid || lineage.observed_head_oid !== record.delivery_oid))
      ) {
        throw new StateStoreError("RICKGENT_STATE_RESUME_INCOMPATIBLE", "delivery terminal record does not match exact run and observation OIDs");
      }
      this.#insert("delivery_records", record);
      const nextState = delivered ? "delivered" : "delivery_failed";
      const update = this.#requireDatabase().prepare(`
        UPDATE runs SET state = ?, state_version = state_version + 1
        WHERE run_id = ? AND state = 'ready_for_delivery' AND state_version = ? AND current_delivery_oid = ?
      `).run(nextState, lineage.run_id ?? null, expectedRunVersion, record.delivery_oid ?? null);
      if (update.changes !== 1) throw typedError("RICKGENT_STATE_CONFLICT", "delivery finalization lost its run CAS race", this.location.databasePath);
      return frozenRow(record);
    });
  }

  readEvidence(evidenceId: string): StateRecord | undefined {
    const row = this.#requireDatabase().prepare("SELECT * FROM evidence WHERE evidence_id = ?").get(evidenceId) as MutableStateRecord | undefined;
    return row === undefined ? undefined : frozenRow(row);
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

  #appendExactSequence(
    table: "remote_observations" | "pr_observations",
    input: StateRowInput | MutableStateRecord,
    identityColumns: readonly string[],
  ): StateRecord {
    const row = this.#validatedColumns(table, normalizeRow(input));
    this.#requireCompleteRow(table, row);
    if (table === "remote_observations" && row.observed_remote_oid !== null) {
      this.#assertRepositoryOid(row.observed_remote_oid, "observed remote oid");
    }
    return this.#immediate(table === "remote_observations" ? "append_remote_observation" : "append_pr_observation", () => {
      const existing = this.#selectBy(table, row, identityColumns);
      if (existing !== undefined) {
        if (this.#sameRecord(existing, row)) return frozenRow(existing);
        throw typedError("RICKGENT_STATE_IDEMPOTENCY_CONFLICT", `${table} sequence already has different immutable input`, this.location.databasePath);
      }
      this.#insert(table, row);
      return frozenRow(row);
    });
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
          SELECT r.*, a.run_id, a.ticket_instance_id
          FROM review_records r JOIN attempts a ON a.attempt_id = r.attempt_id
          WHERE r.review_record_id = ?
        `).get(reference.review_record_id ?? null) as MutableStateRecord | undefined;
        targetTable = "review_records";
        break;
      case "commit_attribution":
        target = db.prepare(`
          SELECT c.*, a.run_id, a.ticket_instance_id
          FROM commit_attributions c JOIN attempts a ON a.attempt_id = c.attempt_id
          WHERE c.commit_attribution_id = ?
        `).get(reference.commit_attribution_id ?? null) as MutableStateRecord | undefined;
        targetTable = "commit_attributions";
        break;
      case "cleanup_record":
        target = db.prepare(`
          SELECT c.*, a.run_id, a.ticket_instance_id
          FROM cleanup_records c JOIN attempts a ON a.attempt_id = c.attempt_id
          WHERE c.cleanup_record_id = ?
        `).get(reference.cleanup_record_id ?? null) as MutableStateRecord | undefined;
        targetTable = "cleanup_records";
        digestColumn = "record_digest";
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
    if (
      target.run_id !== decision.run_id ||
      (decision.ticket_instance_id !== null && target.ticket_instance_id !== decision.ticket_instance_id) ||
      (decision.attempt_id !== null && target.attempt_id !== decision.attempt_id)
    ) {
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

export function openStateStore(options: OpenStateStoreOptions): StateStore {
  return StateStore.open(options);
}
