import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  canonicalJson,
  ticketContractDigest,
  type TicketContract,
  type TicketScopeEntry,
} from "../contracts/ticket-contract.js";
import {
  canonicalGitDeltaFromRaw,
  type CanonicalGitDelta,
  type CanonicalGitDeltaEntry,
  type StateStore,
} from "../state/store.js";
import {
  isAuthorizedAttemptOwnershipGrant,
  type AttemptOwnershipGrant,
  type LeaseAuthority,
} from "../state/leases.js";
import {
  isAuthorizedReadyAttemptWorkspace,
  snapshotAttemptCaller,
  type ReadyAttemptWorkspace,
} from "./attempt-workspace.js";

const COMMIT_SERVICE_AUTHORITY = Symbol("rickgent.commit-service-command");
const AUTHORIZED_COMMIT_SERVICE_COMMANDS = new WeakSet<object>();
const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CHANGED_PATHS = 2_048;
const MAX_BASELINE_PATHS = 100_000;
const MAX_BASELINE_SCAN_BYTES = 512 * 1024 * 1024;
const ORCHESTRATOR_NAME = "Rickgent Orchestrator";
const ORCHESTRATOR_EMAIL = "orchestrator@rickgent.invalid";
const GIT_BASE_ARGS = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "core.attributesFile=/dev/null",
  "-c", "commit.gpgSign=false",
]);

export const COMMIT_SERVICE_SCHEMA_VERSION = "rickgent.commit-service/v1" as const;

export interface CommitServicePhaseIdentity {
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly contextDigest: `sha256:${string}`;
}

export interface CommitResourceVersions {
  readonly delivery_ref: number;
  readonly attempt_ref: number;
  readonly worktree: number;
  readonly isolated_index: number;
}

export interface CommitMetadata {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerDate: string;
  readonly messageDigest: `sha256:${string}`;
}

export interface CommitCommandReceipt {
  readonly purpose: string;
  readonly executable: typeof GIT_EXECUTABLE;
  readonly argvDigest: `sha256:${string}`;
  readonly inputDigest: `sha256:${string}`;
  readonly inputBytes: number;
  readonly stdoutDigest: `sha256:${string}`;
  readonly stdoutBytes: number;
  readonly stderrDigest: `sha256:${string}`;
  readonly stderrBytes: number;
  readonly status: number;
}

export interface CommitIntentPrepareRequest {
  readonly commitIntentId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipStateVersion: number;
  readonly ownershipContextDigest: `sha256:${string}`;
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly executionContextDigest: `sha256:${string}`;
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly baselineOid: string;
  readonly contractDigest: `sha256:${string}`;
  readonly deliveryRef: string;
  readonly attemptRef: string;
  readonly expectedResourceVersions: CommitResourceVersions;
  readonly treeBeforeOid: string;
  readonly treeAfterOid: string;
  readonly candidateDiffDigest: `sha256:${string}`;
  readonly pathSetDigest: `sha256:${string}`;
  readonly changeKindSetDigest: `sha256:${string}`;
  readonly modeSetDigest: `sha256:${string}`;
  readonly normalizedDelta: readonly CanonicalGitDeltaEntry[];
  readonly verificationReceiptDigests: readonly `sha256:${string}`[];
  readonly commitMetadata: CommitMetadata;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface CommitAttributionFinalizeRequest {
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
  readonly contractDigest: `sha256:${string}`;
  readonly contextDigest: `sha256:${string}`;
  readonly deliveryRef: string;
  readonly deliveryRefObservedOid: string;
  readonly attemptRef: string;
  readonly attemptRefBeforeOid: string;
  readonly attemptRefAfterOid: string;
  readonly candidateDiffDigest: `sha256:${string}`;
  readonly pathSetDigest: `sha256:${string}`;
  readonly changeKindSetDigest: `sha256:${string}`;
  readonly modeSetDigest: `sha256:${string}`;
  readonly normalizedDelta: readonly CanonicalGitDeltaEntry[];
  readonly commandReceipts: readonly CommitCommandReceipt[];
  readonly createdAt: string;
}

export type CommitServiceCommandRequest =
  | { readonly kind: "prepare"; readonly request: CommitIntentPrepareRequest }
  | { readonly kind: "finalize"; readonly request: CommitAttributionFinalizeRequest };

export class CommitServiceCommand {
  readonly command: CommitServiceCommandRequest;

  constructor(authority: symbol, command: CommitServiceCommandRequest) {
    if (authority !== COMMIT_SERVICE_AUTHORITY) {
      throw new TypeError("commit service commands can only be minted after exact Git observation");
    }
    this.command = Object.freeze({
      ...command,
      request: Object.freeze({ ...command.request }),
    }) as CommitServiceCommandRequest;
    AUTHORIZED_COMMIT_SERVICE_COMMANDS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedCommitServiceCommand(value: unknown): value is CommitServiceCommand {
  return typeof value === "object" && value !== null && AUTHORIZED_COMMIT_SERVICE_COMMANDS.has(value);
}

export interface CommitServiceRequest {
  readonly ownership: AttemptOwnershipGrant;
  readonly workspace: ReadyAttemptWorkspace;
  readonly phase: CommitServicePhaseIdentity;
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly contract: TicketContract;
  readonly idempotencyKey: string;
}

export type CommitServiceOutcome = "accepted" | "rejected" | "infrastructure_error";

export interface CommitServiceResult {
  readonly outcome: CommitServiceOutcome;
  readonly ownership: AttemptOwnershipGrant;
  readonly commitIntentId: string | null;
  readonly commitAttributionId: string | null;
  readonly attributionEvidenceId: string | null;
  readonly baselineOid: string;
  readonly treeOid: string | null;
  readonly commitOid: string | null;
  readonly normalizedDelta: readonly CanonicalGitDeltaEntry[];
  readonly commandReceipts: readonly CommitCommandReceipt[];
  readonly detail: string;
}

export type CommitServiceBarrier =
  | "after_candidate_tree"
  | "after_intent_persisted"
  | "after_commit_created"
  | "before_ref_transaction"
  | "after_ref_transaction"
  | "after_attribution_finalized";

export interface CommitServiceOptions {
  readonly barrier?: (barrier: CommitServiceBarrier) => void;
}

type CommitCapableStore = StateStore;

class CommitRejectedError extends Error {}
class CommitInfrastructureError extends Error {}
class CommitBarrierCrash extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256(canonicalJson(value)).slice("sha256:".length)}`;
}

function sameCaller(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertDigest(value: string, label: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new CommitRejectedError(`${label} is not a SHA-256 digest`);
}

function assertOid(value: string, label: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new CommitRejectedError(`${label} is not a canonical Git OID`);
}

function commandText(value: Buffer, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new CommitInfrastructureError(`${label} was not canonical UTF-8`);
  }
  const text = decoded.trim();
  if (text === "" || text.includes("\n") || text.includes("\r")) {
    throw new CommitInfrastructureError(`${label} did not contain exactly one value`);
  }
  return text;
}

function validateRepoPath(value: string): void {
  if (
    value === "" || value.includes("\0") || value.includes("\\") || isAbsolute(value) ||
    value === "." || value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..")
  ) throw new CommitRejectedError(`Git reported a noncanonical repository path: ${JSON.stringify(value)}`);
  if (value.split("/").some((segment) => segment.startsWith(":"))) {
    throw new CommitRejectedError(`ticket-contract v1 rejects pathspec-magic path components: ${JSON.stringify(value)}`);
  }
}

function decodeNulPaths(raw: Buffer): readonly string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new CommitRejectedError("Git reported a path that is not canonical UTF-8");
  }
  const paths = text.split("\0");
  if (paths.at(-1) === "") paths.pop();
  for (const path of paths) validateRepoPath(path);
  return Object.freeze(paths);
}

function lstatOrNull(path: string): ReturnType<typeof fstatSync> | null {
  try {
    return lstatSync(path) as ReturnType<typeof fstatSync>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertContainedPath(root: string, candidate: string, label: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new CommitRejectedError(`${label} escapes the attempt worktree`);
  }
}

function resolveNoSymlinkPath(rootInput: string, repoPath: string, allowLeafSymlink = false): string {
  const root = realpathSync.native(rootInput);
  if (root !== rootInput || !lstatSync(root).isDirectory()) {
    throw new CommitInfrastructureError("attempt worktree is not a canonical directory");
  }
  let cursor = root;
  const segments = repoPath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]!);
    assertContainedPath(root, cursor, "candidate path");
    const observed = lstatOrNull(cursor);
    if (observed !== null) {
      if (observed.isSymbolicLink() && (!allowLeafSymlink || index < segments.length - 1)) {
        throw new CommitRejectedError(`candidate path traverses or names a symlink: ${repoPath}`);
      }
      if (index < segments.length - 1 && !observed.isDirectory()) {
        throw new CommitRejectedError(`candidate path has a non-directory parent: ${repoPath}`);
      }
    }
  }
  return cursor;
}

function stableRegularFile(
  path: string,
  repoPath: string,
  maxBytes = MAX_FILE_BYTES,
  purpose = "candidate",
): { readonly content: Buffer; readonly mode: "100644" | "100755" } | null {
  const before = lstatOrNull(path);
  if (before === null) return null;
  const initial = before;
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new CommitRejectedError(`ticket-contract v1 accepts only regular worktree files: ${repoPath}`);
  }
  if (initial.size > maxBytes) throw new CommitRejectedError(`${purpose} file exceeds the per-file limit: ${repoPath}`);
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new CommitRejectedError(`candidate file could not be opened without following links: ${repoPath}: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) {
      throw new CommitRejectedError(`candidate file changed identity while opening: ${repoPath}`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      content.length !== opened.size
    ) throw new CommitRejectedError(`candidate file changed while being read: ${repoPath}`);
    return Object.freeze({
      content,
      mode: (opened.mode & 0o111) === 0 ? "100644" : "100755",
    });
  } finally {
    closeSync(descriptor);
  }
}

function uniqueSortedPaths(...groups: readonly (readonly string[])[]): readonly string[] {
  const paths = [...new Set(groups.flat())].sort();
  if (paths.length > MAX_CHANGED_PATHS) {
    throw new CommitRejectedError(`candidate exceeds the ${MAX_CHANGED_PATHS} path attribution limit`);
  }
  return Object.freeze(paths);
}

interface BaselineIndexEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}

function decodeBaselineIndex(raw: Buffer): readonly BaselineIndexEntry[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new CommitRejectedError("isolated index contains a non-UTF-8 path");
  }
  const records = text.split("\0");
  if (records.at(-1) === "") records.pop();
  const entries = records.map((record) => {
    const match = /^([0-7]{6}) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(record);
    if (match === null) throw new CommitRejectedError("isolated index contains a noncanonical or unmerged entry");
    const [, mode, oid, path] = match;
    validateRepoPath(path!);
    assertOid(oid!, `isolated index blob for ${path}`);
    return Object.freeze({ mode: mode!, oid: oid!, path: path! });
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (entries.length > MAX_BASELINE_PATHS) {
    throw new CommitRejectedError(`baseline exceeds the ${MAX_BASELINE_PATHS} path scan limit`);
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new CommitRejectedError("isolated index contains duplicate paths");
  }
  return Object.freeze(entries);
}

function gitBlobOid(content: Buffer, oidLength: number): string {
  const algorithm = oidLength === 40 ? "sha1" : oidLength === 64 ? "sha256" : null;
  if (algorithm === null) throw new CommitRejectedError("repository object format is unsupported");
  return createHash(algorithm).update(`blob ${content.length}\0`, "utf8").update(content).digest("hex");
}

function assertSamePaths(left: readonly string[], right: readonly string[], label: string): void {
  if (left.length !== right.length || left.some((path, index) => path !== right[index])) {
    throw new CommitRejectedError(`${label} changed during commit attribution`);
  }
}

function scopeOwnsPath(scope: readonly TicketScopeEntry[], path: string): boolean {
  return scope.some((entry) =>
    path === entry.path || (entry.directory && path.startsWith(`${entry.path}/`)) ||
    entry.from_path === path || (entry.directory && entry.from_path !== undefined && path.startsWith(`${entry.from_path}/`))
  );
}

function scopeOwnsDelta(entry: CanonicalGitDeltaEntry, declaration: TicketScopeEntry): boolean {
  const inside = (parent: string, path: string): boolean => path === parent || path.startsWith(`${parent}/`);
  if (!declaration.directory) {
    return declaration.path === entry.path && declaration.change_kind === entry.change_kind &&
      (entry.change_kind !== "rename" || declaration.from_path === entry.from_path);
  }
  return inside(declaration.path, entry.path) &&
    (entry.from_path === null || inside(declaration.path, entry.from_path)) &&
    declaration.change_kind === entry.change_kind;
}

function assertExactScope(delta: CanonicalGitDelta, scope: readonly TicketScopeEntry[]): void {
  if (delta.entries.length === 0) throw new CommitRejectedError("attempt workspace has no attributable change");
  for (const entry of delta.entries) {
    if (!scope.some((declaration) => scopeOwnsDelta(entry, declaration))) {
      throw new CommitRejectedError(`candidate delta has an out-of-contract path or kind: ${entry.path}`);
    }
    if (entry.before_mode === "160000" || entry.after_mode === "160000") {
      throw new CommitRejectedError(`candidate delta contains an unsupported gitlink: ${entry.path}`);
    }
    if (entry.change_kind === "create" && entry.after_mode !== "100644") {
      throw new CommitRejectedError(`ticket-contract v1 can create only regular 100644 files: ${entry.path}`);
    }
    if ((entry.change_kind === "modify" || entry.change_kind === "rename") && entry.before_mode !== entry.after_mode) {
      throw new CommitRejectedError(`ticket-contract v1 forbids mode or type changes: ${entry.path}`);
    }
    if (entry.change_kind === "rename" && entry.before_mode === "120000") {
      throw new CommitRejectedError(`ticket-contract v1 forbids symlink rename: ${entry.path}`);
    }
  }
  for (const declaration of scope) {
    if (!delta.entries.some((entry) => scopeOwnsDelta(entry, declaration))) {
      throw new CommitRejectedError(`candidate delta does not realize sealed scope: ${declaration.path}`);
    }
  }
}

function resourceVersions(ownership: AttemptOwnershipGrant): CommitResourceVersions {
  const version = (slot: keyof CommitResourceVersions): number => {
    const resource = ownership.resources.find((candidate) => candidate.slot === slot);
    if (resource === undefined || resource.state !== "active") {
      throw new CommitRejectedError(`commit resource ${slot} is not active`);
    }
    return resource.stateVersion;
  };
  return Object.freeze({
    delivery_ref: version("delivery_ref"),
    attempt_ref: version("attempt_ref"),
    worktree: version("worktree"),
    isolated_index: version("isolated_index"),
  });
}

class GitRecorder {
  readonly receipts: CommitCommandReceipt[] = [];
  readonly #worktree: string;
  readonly #indexPath: string;

  constructor(worktree: string, indexPath: string) {
    this.#worktree = worktree;
    this.#indexPath = indexPath;
  }

  run(
    purpose: string,
    args: readonly string[],
    options: {
      readonly input?: Buffer | string;
      readonly useIndex?: boolean;
      readonly allowedStatuses?: readonly number[];
      readonly env?: Readonly<Record<string, string>>;
    } = {},
  ): { readonly stdout: Buffer; readonly stderr: Buffer; readonly status: number } {
    const argv = [...GIT_BASE_ARGS, "-C", this.#worktree, ...args];
    const input = options.input === undefined ? Buffer.alloc(0) : Buffer.from(options.input);
    const environment: NodeJS.ProcessEnv = {
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
      ...(options.useIndex === true ? { GIT_INDEX_FILE: this.#indexPath } : {}),
      ...options.env,
    };
    const result = spawnSync(GIT_EXECUTABLE, argv, {
      env: environment,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
    const status = result.status ?? -1;
    this.receipts.push(Object.freeze({
      purpose,
      executable: GIT_EXECUTABLE,
      argvDigest: sha256(canonicalJson(argv)),
      inputDigest: sha256(input),
      inputBytes: input.length,
      stdoutDigest: sha256(stdout),
      stdoutBytes: stdout.length,
      stderrDigest: sha256(stderr),
      stderrBytes: stderr.length,
      status,
    }));
    if (result.error !== undefined) {
      throw new CommitInfrastructureError(`${purpose} failed: ${result.error.message}`);
    }
    const allowed = options.allowedStatuses ?? [0];
    if (!allowed.includes(status)) {
      throw new CommitInfrastructureError(`${purpose} exited ${status}: ${stderr.toString("utf8").trim()}`);
    }
    return { stdout, stderr, status };
  }
}

export class CommitService {
  readonly #store: CommitCapableStore;
  readonly #leases: LeaseAuthority;
  readonly #options: CommitServiceOptions;

  constructor(store: StateStore, leases: LeaseAuthority, options: CommitServiceOptions = {}) {
    this.#store = store as CommitCapableStore;
    this.#leases = leases;
    this.#options = Object.freeze({ ...options });
  }

  run(request: CommitServiceRequest): CommitServiceResult {
    let ownership = request.ownership;
    const baselineOid = request.workspace.baselineOid;
    const recorder = new GitRecorder(request.workspace.worktreePath, request.workspace.isolatedIndexPath);
    try {
      ownership = this.#leases.assertFresh(ownership);
      const accepted = this.#run(request, ownership, recorder);
      return accepted;
    } catch (error) {
      if (error instanceof CommitBarrierCrash) throw error.cause;
      try {
        ownership = this.#leases.beginCleanup({
          ownership,
          idempotencyKey: `commit-service-cleanup:${deterministicId("failure", {
            attempt_id: ownership.attemptId,
            idempotency_key: request.idempotencyKey,
          })}`,
        });
      } catch (cleanupError) {
        return Object.freeze({
          outcome: "infrastructure_error",
          ownership,
          commitIntentId: null,
          commitAttributionId: null,
          attributionEvidenceId: null,
          baselineOid,
          treeOid: null,
          commitOid: null,
          normalizedDelta: Object.freeze([]),
          commandReceipts: Object.freeze([...recorder.receipts]),
          detail: `${error instanceof Error ? error.message : String(error)}; cleanup containment failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        });
      }
      const failureClass = typeof error === "object" && error !== null && "failureClass" in error
        ? error.failureClass
        : null;
      return Object.freeze({
        outcome: error instanceof CommitRejectedError || error instanceof TypeError || failureClass === "input_contract"
          ? "rejected"
          : "infrastructure_error",
        ownership,
        commitIntentId: null,
        commitAttributionId: null,
        attributionEvidenceId: null,
        baselineOid,
        treeOid: null,
        commitOid: null,
        normalizedDelta: Object.freeze([]),
        commandReceipts: Object.freeze([...recorder.receipts]),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #barrier(barrier: CommitServiceBarrier): void {
    try {
      this.#options.barrier?.(barrier);
    } catch (error) {
      throw new CommitBarrierCrash(error);
    }
  }

  #run(
    request: CommitServiceRequest,
    initialOwnership: AttemptOwnershipGrant,
    git: GitRecorder,
  ): CommitServiceResult {
    if (!isAuthorizedAttemptOwnershipGrant(initialOwnership)) {
      throw new CommitRejectedError("commit ownership was not minted by LeaseAuthority");
    }
    if (!isAuthorizedReadyAttemptWorkspace(request.workspace)) {
      throw new CommitRejectedError("commit workspace was not minted by the attempt workspace authority");
    }
    const workspace = request.workspace;
    const plan = initialOwnership.plan;
    if (
      initialOwnership.purpose !== "execution" || initialOwnership.ownership.state !== "live" ||
      workspace.ownership.attemptId !== initialOwnership.attemptId ||
      workspace.ownership.ownership.ownershipId !== initialOwnership.ownership.ownershipId ||
      workspace.ownership.ownership.generation !== initialOwnership.ownership.generation ||
      workspace.callerRepository !== initialOwnership.repositoryPath ||
      workspace.commonGitDirectory !== initialOwnership.gitCommonDirectory ||
      workspace.allocationRoot !== plan.allocationRoot ||
      workspace.deliveryRef !== plan.lineage.deliveryRef ||
      workspace.baselineOid !== plan.lineage.deliveryBaselineOid ||
      workspace.attemptRef !== plan.attemptRef ||
      workspace.worktreePath !== plan.worktreePath ||
      !workspace.worktreeGitDirectory.startsWith(`${join(initialOwnership.gitCommonDirectory, "worktrees")}${sep}`) ||
      workspace.isolatedIndexPath !== plan.isolatedIndexPath
    ) throw new CommitRejectedError("workspace identity differs from its live ownership plan");
    if (
      request.contract.id !== plan.lineage.ticketId || request.contract.digest !== plan.lineage.contractDigest ||
      ticketContractDigest(request.contract) !== request.contract.digest || request.contract.scope.length === 0
    ) throw new CommitRejectedError("ticket contract differs from the immutable attempt lineage");
    assertDigest(request.contract.digest, "ticket contract digest");
    assertDigest(request.phase.contextDigest, "execution context digest");
    if (
      request.phase.phaseExecutionId === "" || request.phase.contextId === "" ||
      request.launchId === "" || request.processReceiptId === "" ||
      request.idempotencyKey === "" || request.idempotencyKey !== request.idempotencyKey.trim() ||
      request.idempotencyKey.length > 240
    ) throw new CommitRejectedError("commit phase or idempotency identity is invalid");
    assertOid(workspace.baselineOid, "attempt baseline");
    const commitIntentId = deterministicId("commit-intent", {
      schema_version: COMMIT_SERVICE_SCHEMA_VERSION,
      attempt_id: initialOwnership.attemptId,
      idempotency_key: request.idempotencyKey,
    });

    if (!sameCaller(workspace.callerBefore, snapshotAttemptCaller(workspace.callerRepository, workspace.commonGitDirectory))) {
      throw new CommitRejectedError("caller repository changed after attempt allocation");
    }
    if (realpathSync.native(workspace.worktreePath) !== workspace.worktreePath) {
      throw new CommitRejectedError("attempt worktree identity is no longer canonical");
    }
    const indexStat = lstatSync(workspace.isolatedIndexPath);
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || realpathSync.native(workspace.isolatedIndexPath) !== workspace.isolatedIndexPath) {
      throw new CommitRejectedError("isolated index identity is no longer a canonical regular file");
    }
    const observedCommon = commandText(git.run(
      "observe_git_common_directory",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ).stdout, "Git common directory");
    const observedWorktreeGit = commandText(git.run(
      "observe_worktree_git_directory",
      ["rev-parse", "--path-format=absolute", "--git-dir"],
    ).stdout, "worktree Git directory");
    if (
      realpathSync.native(observedCommon) !== workspace.commonGitDirectory ||
      realpathSync.native(observedWorktreeGit) !== workspace.worktreeGitDirectory
    ) throw new CommitRejectedError("attempt worktree points at a foreign Git administrative directory");

    const deliveryObserved = commandText(git.run(
      "observe_delivery_ref_before",
      ["rev-parse", "--verify", `${workspace.deliveryRef}^{commit}`],
    ).stdout, "delivery ref");
    const attemptObservedInitially = commandText(git.run(
      "observe_attempt_ref_before",
      ["rev-parse", "--verify", `${workspace.attemptRef}^{commit}`],
    ).stdout, "attempt ref");
    const headObserved = commandText(git.run(
      "observe_attempt_head_before",
      ["rev-parse", "--verify", "HEAD^{commit}"],
    ).stdout, "attempt HEAD");
    for (const [label, value] of [
      ["delivery ref", deliveryObserved], ["attempt ref", attemptObservedInitially], ["attempt HEAD", headObserved],
    ] as const) assertOid(value, label);
    if (deliveryObserved !== workspace.baselineOid || headObserved !== workspace.baselineOid) {
      throw new CommitRejectedError("delivery ref or attempt HEAD moved outside the owned lineage");
    }
    if (
      attemptObservedInitially !== workspace.baselineOid &&
      this.#store.resolveCommitIntentReplay({
        attemptId: initialOwnership.attemptId,
        commitIntentId,
      }) === null
    ) throw new CommitRejectedError("attempt ref moved to a foreign commit without a durable CommitService intent");

    const defaultIndex = git.run(
      "verify_default_index_baseline",
      ["diff", "--cached", "--quiet", "--no-ext-diff", workspace.baselineOid, "--"],
      { allowedStatuses: [0, 1] },
    );
    if (defaultIndex.status !== 0) throw new CommitRejectedError("attempt worktree default index was modified by the worker");
    const treeBeforeOid = commandText(git.run(
      "resolve_baseline_tree",
      ["rev-parse", `${workspace.baselineOid}^{tree}`],
    ).stdout, "baseline tree");
    const isolatedTreeBefore = commandText(git.run(
      "verify_isolated_index_baseline",
      ["write-tree"],
      { useIndex: true },
    ).stdout, "isolated index tree");
    assertOid(treeBeforeOid, "baseline tree");
    if (isolatedTreeBefore !== treeBeforeOid) throw new CommitRejectedError("isolated index differs from the attempt baseline");
    const baselineIndex = decodeBaselineIndex(git.run(
      "observe_baseline_index_entries",
      ["ls-files", "--stage", "-z", "--"],
      { useIndex: true },
    ).stdout);
    let initialUntrackedPaths: readonly string[] = Object.freeze([]);

    const observePaths = (suffix: string): readonly string[] => {
      const tracked: string[] = [];
      let scannedBytes = 0;
      for (const entry of baselineIndex) {
        const absolute = resolveNoSymlinkPath(workspace.worktreePath, entry.path, entry.mode === "120000");
        const observed = lstatOrNull(absolute);
        if (observed === null) {
          tracked.push(entry.path);
          continue;
        }
        if (entry.mode === "120000") {
          if (!observed.isSymbolicLink()) {
            tracked.push(entry.path);
            continue;
          }
          if (observed.size > MAX_BASELINE_SCAN_BYTES - scannedBytes) {
            throw new CommitRejectedError("baseline exceeds the aggregate scan byte limit");
          }
          const target = readlinkSync(absolute, { encoding: "buffer" });
          scannedBytes += target.length;
          if (scannedBytes > MAX_BASELINE_SCAN_BYTES) {
            throw new CommitRejectedError("baseline exceeds the aggregate scan byte limit");
          }
          if (gitBlobOid(target, workspace.baselineOid.length) !== entry.oid) tracked.push(entry.path);
          continue;
        }
        if (entry.mode === "160000") {
          if (!observed.isDirectory()) {
            tracked.push(entry.path);
            continue;
          }
          const submoduleHead = commandText(git.run(
            `observe_submodule_head_${suffix}_${sha256(entry.path).slice(7, 27)}`,
            ["-C", absolute, "rev-parse", "--verify", "HEAD^{commit}"],
          ).stdout, `submodule HEAD for ${entry.path}`);
          if (submoduleHead !== entry.oid) tracked.push(entry.path);
          continue;
        }
        const file = stableRegularFile(
          absolute,
          entry.path,
          MAX_BASELINE_SCAN_BYTES - scannedBytes,
          "baseline scan",
        );
        if (file !== null) {
          scannedBytes += file.content.length;
          if (scannedBytes > MAX_BASELINE_SCAN_BYTES) {
            throw new CommitRejectedError("baseline exceeds the aggregate scan byte limit");
          }
        }
        if (
          file === null || file.mode !== entry.mode ||
          gitBlobOid(file.content, workspace.baselineOid.length) !== entry.oid
        ) tracked.push(entry.path);
      }
      const newlyUntracked = decodeNulPaths(git.run(
        `observe_untracked_delta_${suffix}`,
        ["ls-files", "--others", "-z", "--"],
        { useIndex: true },
      ).stdout);
      if (suffix === "initial") initialUntrackedPaths = newlyUntracked;
      const paths = uniqueSortedPaths(tracked, newlyUntracked, initialUntrackedPaths);
      for (const path of paths) {
        resolveNoSymlinkPath(workspace.worktreePath, path);
        if (!scopeOwnsPath(request.contract.scope, path)) {
          throw new CommitRejectedError(`candidate contains an out-of-contract path or rename source: ${path}`);
        }
      }
      return paths;
    };
    const changedPaths = observePaths("initial");
    if (changedPaths.length === 0) throw new CommitRejectedError("attempt workspace has no attributable change");

    const materializeCandidate = (suffix: string): string => {
      let totalBytes = 0;
      for (const path of changedPaths) {
        const absolute = resolveNoSymlinkPath(workspace.worktreePath, path);
        const file = stableRegularFile(absolute, path);
        const purpose = `${suffix}_${sha256(path).slice("sha256:".length, "sha256:".length + 20)}`;
        if (file === null) {
          git.run(`remove_candidate_path_${purpose}`, ["update-index", "--force-remove", "--", path], { useIndex: true });
          continue;
        }
        totalBytes += file.content.length;
        if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new CommitRejectedError("candidate exceeds the total attributed byte limit");
        const blobOid = commandText(git.run(
          `hash_candidate_path_${purpose}`,
          ["hash-object", "-w", "--no-filters", "--stdin"],
          { input: file.content },
        ).stdout, `candidate blob for ${path}`);
        assertOid(blobOid, `candidate blob for ${path}`);
        git.run(
          `index_candidate_path_${purpose}`,
          ["update-index", "--add", "--cacheinfo", `${file.mode},${blobOid},${path}`],
          { useIndex: true },
        );
      }
      return commandText(git.run(
        `write_candidate_tree_${suffix}`,
        ["write-tree"],
        { useIndex: true },
      ).stdout, "candidate tree");
    };

    const treeAfterOid = materializeCandidate("initial");
    assertOid(treeAfterOid, "candidate tree");
    let rawDeltaText: string;
    try {
      rawDeltaText = new TextDecoder("utf-8", { fatal: true }).decode(git.run(
        "resolve_candidate_delta",
        ["diff", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-M", workspace.baselineOid, treeAfterOid],
      ).stdout);
    } catch (error) {
      if (error instanceof CommitInfrastructureError) throw error;
      throw new CommitRejectedError(`candidate delta is not canonical UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    let delta: CanonicalGitDelta;
    try {
      delta = canonicalGitDeltaFromRaw(rawDeltaText);
    } catch (error) {
      throw new CommitRejectedError(`candidate delta is unsupported: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertExactScope(delta, request.contract.scope);
    const projection = this.#store.resolveCommitPreparation({
      attemptId: initialOwnership.attemptId,
      phaseExecutionId: request.phase.phaseExecutionId,
      contextId: request.phase.contextId,
    });
    for (const digest of projection.verificationReceiptDigests) assertDigest(digest, "verification receipt digest");
    if (
      projection.launchId !== request.launchId || projection.processReceiptId !== request.processReceiptId ||
      projection.executionContextDigest !== request.phase.contextDigest ||
      projection.baselineOid !== workspace.baselineOid || projection.contractDigest !== request.contract.digest ||
      projection.deliveryRef !== workspace.deliveryRef
    ) throw new CommitRejectedError("commit request differs from the authoritative phase and process projection");
    if (projection.candidateTreeOid !== treeAfterOid || projection.candidateDiffDigest !== delta.candidateDiffDigest) {
      throw new CommitRejectedError("candidate tree or diff differs from the accepted review and required gates");
    }

    if (decodeNulPaths(git.run(
      "verify_candidate_untracked_exact",
      ["ls-files", "--others", "-z", "--"],
      { useIndex: true },
    ).stdout).length !== 0) throw new CommitRejectedError("worktree changed while the candidate tree was built");
    assertSamePaths(changedPaths, observePaths("after_tree"), "candidate path set");
    git.run("restore_isolated_index_baseline", ["read-tree", workspace.baselineOid], { useIndex: true });
    const restoredTree = commandText(git.run(
      "verify_restored_isolated_index",
      ["write-tree"],
      { useIndex: true },
    ).stdout, "restored isolated index tree");
    if (restoredTree !== treeBeforeOid) throw new CommitInfrastructureError("isolated index baseline restoration failed");
    this.#barrier("after_candidate_tree");

    const commitMessage = `rickgent: accept ${request.contract.id}\n`;
    const commitMetadata: CommitMetadata = Object.freeze({
      authorName: ORCHESTRATOR_NAME,
      authorEmail: ORCHESTRATOR_EMAIL,
      authorDate: projection.phaseCreatedAt,
      committerName: ORCHESTRATOR_NAME,
      committerEmail: ORCHESTRATOR_EMAIL,
      committerDate: projection.phaseCreatedAt,
      messageDigest: sha256(commitMessage),
    });
    const prepareRequest: CommitIntentPrepareRequest = Object.freeze({
      commitIntentId,
      attemptId: initialOwnership.attemptId,
      ownershipId: initialOwnership.ownership.ownershipId,
      ownerGeneration: initialOwnership.ownership.generation,
      ownershipStateVersion: initialOwnership.ownership.stateVersion,
      ownershipContextDigest: initialOwnership.ownership.contextDigest as `sha256:${string}`,
      phaseExecutionId: request.phase.phaseExecutionId,
      contextId: request.phase.contextId,
      executionContextDigest: request.phase.contextDigest,
      launchId: request.launchId,
      processReceiptId: request.processReceiptId,
      baselineOid: workspace.baselineOid,
      contractDigest: request.contract.digest as `sha256:${string}`,
      deliveryRef: workspace.deliveryRef,
      attemptRef: workspace.attemptRef,
      expectedResourceVersions: resourceVersions(initialOwnership),
      treeBeforeOid,
      treeAfterOid,
      candidateDiffDigest: delta.candidateDiffDigest,
      pathSetDigest: delta.pathSetDigest,
      changeKindSetDigest: delta.changeKindSetDigest,
      modeSetDigest: delta.modeSetDigest,
      normalizedDelta: delta.entries,
      verificationReceiptDigests: projection.verificationReceiptDigests as readonly `sha256:${string}`[],
      commitMetadata,
      idempotencyKey: request.idempotencyKey,
      createdAt: projection.phaseCreatedAt,
    });
    assertDigest(prepareRequest.ownershipContextDigest, "ownership context digest");
    if (attemptObservedInitially === workspace.baselineOid) {
      this.#store.prepareAuthorizedCommitIntent(new CommitServiceCommand(
        COMMIT_SERVICE_AUTHORITY,
        { kind: "prepare", request: prepareRequest },
      ));
    }
    this.#barrier("after_intent_persisted");

    const commitOid = commandText(git.run(
      "create_candidate_commit",
      ["commit-tree", treeAfterOid, "-p", workspace.baselineOid],
      {
        input: commitMessage,
        env: {
          GIT_AUTHOR_NAME: commitMetadata.authorName,
          GIT_AUTHOR_EMAIL: commitMetadata.authorEmail,
          GIT_AUTHOR_DATE: commitMetadata.authorDate,
          GIT_COMMITTER_NAME: commitMetadata.committerName,
          GIT_COMMITTER_EMAIL: commitMetadata.committerEmail,
          GIT_COMMITTER_DATE: commitMetadata.committerDate,
        },
      },
    ).stdout, "candidate commit");
    assertOid(commitOid, "candidate commit");
    if (attemptObservedInitially !== workspace.baselineOid && attemptObservedInitially !== commitOid) {
      throw new CommitRejectedError("attempt ref names a foreign commit");
    }
    const ancestry = commandText(git.run(
      "verify_candidate_commit_parent",
      ["rev-list", "--parents", "-n", "1", commitOid],
    ).stdout, "candidate commit ancestry").split(" ");
    const committedTree = commandText(git.run(
      "verify_candidate_commit_tree",
      ["rev-parse", `${commitOid}^{tree}`],
    ).stdout, "candidate commit tree");
    if (ancestry.length !== 2 || ancestry[0] !== commitOid || ancestry[1] !== workspace.baselineOid || committedTree !== treeAfterOid) {
      throw new CommitInfrastructureError("commit-tree did not produce the exact one-parent candidate");
    }
    this.#barrier("after_commit_created");

    let ownership = initialOwnership;
    if (!sameCaller(workspace.callerBefore, snapshotAttemptCaller(workspace.callerRepository, workspace.commonGitDirectory))) {
      throw new CommitRejectedError("caller repository changed before the ref transaction");
    }
    const finalTree = materializeCandidate("before_ref");
    if (finalTree !== treeAfterOid) throw new CommitRejectedError("worktree content changed before the ref transaction");
    if (decodeNulPaths(git.run(
      "verify_candidate_untracked_before_ref",
      ["ls-files", "--others", "-z", "--"],
      { useIndex: true },
    ).stdout).length !== 0) throw new CommitRejectedError("worktree changed before the ref transaction");
    assertSamePaths(changedPaths, observePaths("before_ref"), "candidate path set");
    git.run("restore_isolated_index_before_ref", ["read-tree", workspace.baselineOid], { useIndex: true });
    const finalRestoredTree = commandText(git.run(
      "verify_restored_isolated_index_before_ref",
      ["write-tree"],
      { useIndex: true },
    ).stdout, "restored isolated index tree before ref");
    if (finalRestoredTree !== treeBeforeOid) throw new CommitInfrastructureError("isolated index pre-ref restoration failed");
    const deliveryBeforeCas = commandText(git.run(
      "observe_delivery_ref_for_cas",
      ["rev-parse", "--verify", `${workspace.deliveryRef}^{commit}`],
    ).stdout, "delivery ref before CAS");
    const attemptBeforeCas = commandText(git.run(
      "observe_attempt_ref_for_cas",
      ["rev-parse", "--verify", `${workspace.attemptRef}^{commit}`],
    ).stdout, "attempt ref before CAS");
    if (deliveryBeforeCas !== workspace.baselineOid || (attemptBeforeCas !== workspace.baselineOid && attemptBeforeCas !== commitOid)) {
      throw new CommitRejectedError("delivery or attempt ref lost its exact CAS preimage");
    }
    this.#barrier("before_ref_transaction");
    ownership = this.#leases.assertFresh(ownership);
    const refOwnerProof = this.#leases.deriveCommitRefProof(ownership, {
      commitIntentId,
      attemptRef: workspace.attemptRef,
      baselineOid: workspace.baselineOid,
      commitOid,
    });
    const refTransactionReason = `rickgent-commit-intent:${commitIntentId}:${refOwnerProof.slice("sha256:".length)}`;
    const refTransaction = attemptBeforeCas === workspace.baselineOid
      ? `start\nverify ${workspace.deliveryRef} ${workspace.baselineOid}\nupdate ${workspace.attemptRef} ${commitOid} ${workspace.baselineOid}\nprepare\ncommit\n`
      : `start\nverify ${workspace.deliveryRef} ${workspace.baselineOid}\nverify ${workspace.attemptRef} ${commitOid}\nprepare\ncommit\n`;
    git.run(
      attemptBeforeCas === workspace.baselineOid ? "cas_attempt_ref_to_candidate" : "verify_replayed_attempt_ref_candidate",
      ["update-ref", "--no-deref", "--create-reflog", "-m", refTransactionReason, "--stdin"],
      { input: refTransaction },
    );
    this.#barrier("after_ref_transaction");

    ownership = this.#leases.assertFresh(ownership);
    const deliveryAfterCas = commandText(git.run(
      "observe_delivery_ref_after_cas",
      ["rev-parse", "--verify", `${workspace.deliveryRef}^{commit}`],
    ).stdout, "delivery ref after CAS");
    const attemptAfterCas = commandText(git.run(
      "observe_attempt_ref_after_cas",
      ["rev-parse", "--verify", `${workspace.attemptRef}^{commit}`],
    ).stdout, "attempt ref after CAS");
    if (deliveryAfterCas !== workspace.baselineOid || attemptAfterCas !== commitOid) {
      throw new CommitInfrastructureError("atomic ref transaction post-image differs from the candidate");
    }
    const reflogObservation = git.run(
      "verify_attempt_ref_cas_reflog",
      ["log", "-g", "-1", "--format=%H%x00%gs", workspace.attemptRef],
    ).stdout;
    const expectedReflogObservation = Buffer.from(`${commitOid}\0${refTransactionReason}\n`, "utf8");
    if (!reflogObservation.equals(expectedReflogObservation)) {
      throw new CommitRejectedError("attempt ref candidate lacks the exact CommitService CAS reflog proof");
    }
    const postCasTree = materializeCandidate("after_ref");
    if (postCasTree !== treeAfterOid) throw new CommitRejectedError("worktree content changed after the ref transaction");
    if (decodeNulPaths(git.run(
      "verify_candidate_untracked_after_ref",
      ["ls-files", "--others", "-z", "--"],
      { useIndex: true },
    ).stdout).length !== 0) throw new CommitRejectedError("worktree changed after the ref transaction");
    assertSamePaths(changedPaths, observePaths("after_ref"), "candidate path set");
    git.run("restore_isolated_index_after_ref", ["read-tree", workspace.baselineOid], { useIndex: true });
    const postCasRestoredTree = commandText(git.run(
      "verify_restored_isolated_index_after_ref",
      ["write-tree"],
      { useIndex: true },
    ).stdout, "restored isolated index tree after ref");
    if (postCasRestoredTree !== treeBeforeOid) throw new CommitInfrastructureError("isolated index post-ref restoration failed");
    const postCasDefaultIndex = git.run(
      "verify_default_index_after_ref",
      ["diff", "--cached", "--quiet", "--no-ext-diff", workspace.baselineOid, "--"],
      { allowedStatuses: [0, 1] },
    );
    const postCasHead = commandText(git.run(
      "verify_attempt_head_after_ref",
      ["rev-parse", "--verify", "HEAD^{commit}"],
    ).stdout, "attempt HEAD after ref");
    if (postCasDefaultIndex.status !== 0 || postCasHead !== workspace.baselineOid) {
      throw new CommitRejectedError("worker HEAD or default index changed during commit attribution");
    }
    if (!sameCaller(workspace.callerBefore, snapshotAttemptCaller(workspace.callerRepository, workspace.commonGitDirectory))) {
      throw new CommitRejectedError("caller repository changed during commit attribution");
    }

    const commitAttributionId = deterministicId("commit-attribution", {
      commit_intent_id: commitIntentId,
      commit_oid: commitOid,
    });
    const attributionEvidenceId = deterministicId("evidence", {
      schema_version: "rickgent.commit-attribution.v2",
      commit_attribution_id: commitAttributionId,
    });
    const replay = this.#store.resolveCommitIntentReplay({
      attemptId: initialOwnership.attemptId,
      commitIntentId,
    });
    if (replay === null) throw new CommitRejectedError("candidate attempt ref has no durable CommitService intent");
    if (
      replay.state === "finalized" &&
      (replay.commitOid !== commitOid || replay.commitAttributionId !== commitAttributionId)
    ) throw new CommitRejectedError("finalized commit replay differs from the exact candidate identity");
    const commandReceipts: readonly CommitCommandReceipt[] = replay.state === "finalized"
      ? Object.freeze(replay.commandReceipts.map((receipt) => {
          if (receipt.executable !== GIT_EXECUTABLE || receipt.status !== 0) {
            throw new CommitRejectedError("durable commit replay contains an invalid command receipt");
          }
          for (const [label, digest] of [
            ["argv", receipt.argvDigest], ["input", receipt.inputDigest],
            ["stdout", receipt.stdoutDigest], ["stderr", receipt.stderrDigest],
          ] as const) assertDigest(digest, `durable command ${label} digest`);
          return Object.freeze({
            ...receipt,
            executable: GIT_EXECUTABLE,
            argvDigest: receipt.argvDigest as `sha256:${string}`,
            inputDigest: receipt.inputDigest as `sha256:${string}`,
            stdoutDigest: receipt.stdoutDigest as `sha256:${string}`,
            stderrDigest: receipt.stderrDigest as `sha256:${string}`,
          });
        }))
      : Object.freeze([...git.receipts]);
    const finalizeRequest: CommitAttributionFinalizeRequest = Object.freeze({
      commitIntentId,
      attemptId: initialOwnership.attemptId,
      ownershipId: ownership.ownership.ownershipId,
      ownerGeneration: ownership.ownership.generation,
      expectedIntentVersion: 0,
      commitAttributionId,
      attributionEvidenceId,
      baselineOid: workspace.baselineOid,
      parentOid: workspace.baselineOid,
      treeBeforeOid,
      treeAfterOid,
      commitOid,
      contractDigest: request.contract.digest as `sha256:${string}`,
      contextDigest: request.phase.contextDigest,
      deliveryRef: workspace.deliveryRef,
      deliveryRefObservedOid: deliveryAfterCas,
      attemptRef: workspace.attemptRef,
      attemptRefBeforeOid: workspace.baselineOid,
      attemptRefAfterOid: attemptAfterCas,
      candidateDiffDigest: delta.candidateDiffDigest,
      pathSetDigest: delta.pathSetDigest,
      changeKindSetDigest: delta.changeKindSetDigest,
      modeSetDigest: delta.modeSetDigest,
      normalizedDelta: delta.entries,
      commandReceipts,
      createdAt: projection.phaseCreatedAt,
    });
    const attribution = this.#store.finalizeAuthorizedCommitAttribution(new CommitServiceCommand(
      COMMIT_SERVICE_AUTHORITY,
      { kind: "finalize", request: finalizeRequest },
    ));
    this.#barrier("after_attribution_finalized");
    return Object.freeze({
      outcome: "accepted",
      ownership,
      commitIntentId,
      commitAttributionId: String(attribution.commit_attribution_id),
      attributionEvidenceId: String(attribution.attribution_evidence_id),
      baselineOid: workspace.baselineOid,
      treeOid: treeAfterOid,
      commitOid,
      normalizedDelta: delta.entries,
      commandReceipts,
      detail: "orchestrator-owned candidate commit and attribution evidence finalized",
    });
  }
}
