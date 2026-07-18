import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { canonicalJson } from "../contracts/ticket-contract.js";
import type { AttemptOwnershipGrant, LeaseAuthority } from "../state/leases.js";
import type { StateLocation } from "../state/store.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GIT_EXECUTABLE = "/usr/bin/git";
const MAX_GIT_OUTPUT = 1024 * 1024;
const MAX_CALLER_PATHS = 100_000;
const MAX_CALLER_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CALLER_TOTAL_BYTES = 512 * 1024 * 1024;
const SAFE_REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_RECEIPT_AUTHORITY = Symbol("rickgent.attempt-workspace-receipt");
const AUTHORIZED_WORKSPACE_RECEIPTS = new WeakSet<object>();
const READY_WORKSPACE_AUTHORITY = Symbol("rickgent.ready-attempt-workspace");
const AUTHORIZED_READY_WORKSPACES = new WeakSet<object>();
const SPAWN_AUTHORIZATION_AUTHORITY = Symbol("rickgent.attempt-workspace-spawn-authorization");
const AUTHORIZED_SPAWN_AUTHORIZATIONS = new WeakSet<object>();
const CONSUMED_SPAWN_AUTHORIZATIONS = new WeakSet<object>();

export const ATTEMPT_OWNERSHIP_SCHEMA_VERSION = "rickgent.attempt-ownership/v1" as const;

export const FIXED_ATTEMPT_RESOURCE_KINDS = Object.freeze([
  "delivery_ref",
  "attempt_ref",
  "worktree",
  "isolated_index",
  "policy_context",
  "policy_bundle",
  "process_group",
  "stdout",
  "stderr",
  "verification_output",
  "salvage_archive",
] as const);

export type FixedAttemptResourceKind = (typeof FIXED_ATTEMPT_RESOURCE_KINDS)[number];

export interface AttemptOwnershipLineage {
  readonly repositoryId: string;
  readonly runId: string;
  readonly ticketInstanceId: string;
  readonly ticketId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly contractDigest: string;
  readonly resourceIdentityVersion: string;
  readonly deliveryBaselineOid: string;
  readonly deliveryRef: string;
}

export interface AttemptResourceIdentity {
  readonly resourceClaimId: string;
  readonly slot: FixedAttemptResourceKind;
  readonly kind: FixedAttemptResourceKind;
  readonly canonicalIdentity: string;
  readonly identityDigest: `sha256:${string}`;
}

export class AttemptWorkspaceResourceReceipt {
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly generation: number;
  readonly slot: "delivery_ref" | "attempt_ref" | "worktree" | "isolated_index";
  readonly expectedState: "reserved" | "allocated";
  readonly expectedVersion: number;
  readonly toState: "allocated" | "active";
  readonly observationDigest: `sha256:${string}`;

  constructor(
    authority: symbol,
    ownership: AttemptOwnershipGrant,
    slot: AttemptWorkspaceResourceReceipt["slot"],
    expectedState: AttemptWorkspaceResourceReceipt["expectedState"],
    toState: AttemptWorkspaceResourceReceipt["toState"],
    observationDigest: `sha256:${string}`,
  ) {
    if (authority !== WORKSPACE_RECEIPT_AUTHORITY) throw new TypeError("workspace receipts can only be minted by the attempt workspace authority");
    const resource = ownership.resources.find((candidate) => candidate.slot === slot);
    if (resource === undefined || resource.state !== expectedState) throw new TypeError(`workspace receipt preimage is not ${expectedState}`);
    this.attemptId = ownership.attemptId;
    this.ownershipId = ownership.ownership.ownershipId;
    this.generation = ownership.ownership.generation;
    this.slot = slot;
    this.expectedState = expectedState;
    this.expectedVersion = resource.stateVersion;
    this.toState = toState;
    this.observationDigest = observationDigest;
    AUTHORIZED_WORKSPACE_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedAttemptWorkspaceResourceReceipt(value: unknown): value is AttemptWorkspaceResourceReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_WORKSPACE_RECEIPTS.has(value);
}

/** Unforgeable observation receipt for the future t22 spawn consumer. */
export class AttemptWorkspaceSpawnAuthorization {
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly generation: number;
  readonly ownershipVersion: number;
  readonly expiresAt: string;
  readonly repositoryId: string;
  readonly commonGitDirectory: string;
  readonly allocationDigest: `sha256:${string}`;
  readonly deliveryRef: string;
  readonly baselineOid: string;
  readonly attemptRef: string;
  readonly worktreePath: string;
  readonly worktreeGitDirectory: string;
  readonly isolatedIndexPath: string;
  readonly observationDigest: `sha256:${string}`;

  constructor(
    authority: symbol,
    ownership: AttemptOwnershipGrant,
    workspace: ReadyAttemptWorkspace,
    observationDigest: `sha256:${string}`,
  ) {
    if (authority !== SPAWN_AUTHORIZATION_AUTHORITY) {
      throw new TypeError("spawn authorizations can only be minted by the attempt workspace authority");
    }
    this.attemptId = ownership.attemptId;
    this.ownershipId = ownership.ownership.ownershipId;
    this.generation = ownership.ownership.generation;
    this.ownershipVersion = ownership.ownership.stateVersion;
    this.expiresAt = ownership.ownership.expiresAt;
    this.repositoryId = ownership.repositoryId;
    this.commonGitDirectory = ownership.gitCommonDirectory;
    this.allocationDigest = ownership.plan.allocationDigest;
    this.deliveryRef = workspace.deliveryRef;
    this.baselineOid = workspace.baselineOid;
    this.attemptRef = workspace.attemptRef;
    this.worktreePath = workspace.worktreePath;
    this.worktreeGitDirectory = workspace.worktreeGitDirectory;
    this.isolatedIndexPath = workspace.isolatedIndexPath;
    this.observationDigest = observationDigest;
    AUTHORIZED_SPAWN_AUTHORIZATIONS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedAttemptWorkspaceSpawnAuthorization(value: unknown): value is AttemptWorkspaceSpawnAuthorization {
  return typeof value === "object" && value !== null && AUTHORIZED_SPAWN_AUTHORIZATIONS.has(value);
}

/** Single-use internal handoff consumed by the t19 supervisor and wired by t22. */
export function consumeAttemptWorkspaceSpawnAuthorization(authorization: AttemptWorkspaceSpawnAuthorization): void {
  if (!isAuthorizedAttemptWorkspaceSpawnAuthorization(authorization)) {
    throw new TypeError("spawn authorization was not minted by the attempt workspace authority");
  }
  if (CONSUMED_SPAWN_AUTHORIZATIONS.has(authorization)) {
    throw new TypeError("spawn authorization has already been consumed");
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new TypeError("spawn authorization has expired");
  }
  CONSUMED_SPAWN_AUTHORIZATIONS.add(authorization);
}

export interface AttemptWorkspacePlan {
  readonly schemaVersion: typeof ATTEMPT_OWNERSHIP_SCHEMA_VERSION;
  readonly lineage: AttemptOwnershipLineage;
  readonly allocationDigest: `sha256:${string}`;
  readonly allocationRoot: string;
  readonly attemptRef: string;
  readonly worktreePath: string;
  readonly isolatedIndexPath: string;
  readonly policyContextPath: string;
  readonly policyBundlePath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly verificationOutputPath: string;
  readonly salvageArchivePath: string;
  readonly resources: readonly AttemptResourceIdentity[];
}

export interface AttemptCallerSnapshot {
  readonly headOid: string;
  readonly symbolicRef: string | null;
  readonly indexDigest: `sha256:${string}`;
  readonly statusDigest: `sha256:${string}`;
}

interface ReadyAttemptWorkspaceInput {
  readonly kind: "ready_attempt_workspace";
  readonly ownership: AttemptOwnershipGrant;
  readonly callerRepository: string;
  readonly commonGitDirectory: string;
  readonly callerBefore: AttemptCallerSnapshot;
  readonly allocationRoot: string;
  readonly deliveryRef: string;
  readonly baselineOid: string;
  readonly attemptRef: string;
  readonly worktreePath: string;
  readonly worktreeGitDirectory: string;
  readonly isolatedIndexPath: string;
}

export class ReadyAttemptWorkspace implements ReadyAttemptWorkspaceInput {
  readonly kind: "ready_attempt_workspace";
  readonly ownership: AttemptOwnershipGrant;
  readonly callerRepository: string;
  readonly commonGitDirectory: string;
  readonly callerBefore: AttemptCallerSnapshot;
  readonly allocationRoot: string;
  readonly deliveryRef: string;
  readonly baselineOid: string;
  readonly attemptRef: string;
  readonly worktreePath: string;
  readonly worktreeGitDirectory: string;
  readonly isolatedIndexPath: string;

  constructor(authority: symbol, input: ReadyAttemptWorkspaceInput) {
    if (authority !== READY_WORKSPACE_AUTHORITY) {
      throw new TypeError("ready attempt workspaces can only be minted by the attempt workspace authority");
    }
    this.kind = input.kind;
    this.ownership = input.ownership;
    this.callerRepository = input.callerRepository;
    this.commonGitDirectory = input.commonGitDirectory;
    this.callerBefore = input.callerBefore;
    this.allocationRoot = input.allocationRoot;
    this.deliveryRef = input.deliveryRef;
    this.baselineOid = input.baselineOid;
    this.attemptRef = input.attemptRef;
    this.worktreePath = input.worktreePath;
    this.worktreeGitDirectory = input.worktreeGitDirectory;
    this.isolatedIndexPath = input.isolatedIndexPath;
    AUTHORIZED_READY_WORKSPACES.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedReadyAttemptWorkspace(value: unknown): value is ReadyAttemptWorkspace {
  return typeof value === "object" && value !== null && AUTHORIZED_READY_WORKSPACES.has(value);
}

export type ProvisionAttemptWorkspaceResult =
  | {
      readonly ok: true;
      readonly workspace: ReadyAttemptWorkspace;
      readonly authorization: AttemptWorkspaceSpawnAuthorization;
    }
  | {
      readonly ok: false;
      readonly code:
        | "ATTEMPT_WORKSPACE_FOREIGN_RESOURCE"
        | "ATTEMPT_WORKSPACE_INVALID_IDENTITY"
        | "ATTEMPT_WORKSPACE_GIT_FAILURE"
        | "ATTEMPT_WORKSPACE_CALLER_CHANGED"
        | "ATTEMPT_WORKSPACE_QUARANTINE_FAILED";
      readonly detail: string;
      readonly ownership: AttemptOwnershipGrant;
    };

export type AttemptWorkspaceReadiness =
  | {
      readonly ready: true;
      readonly detail: string;
      readonly ownership: AttemptOwnershipGrant;
      readonly authorization: AttemptWorkspaceSpawnAuthorization;
    }
  | {
      readonly ready: false;
      readonly code: "identity_changed" | "dirty" | "caller_changed" | "unavailable";
      readonly detail: string;
      readonly ownership: AttemptOwnershipGrant;
    };

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function trustedGitEnvironment(overrides: NodeJS.ProcessEnv = {}, optionalLocks = false): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: optionalLocks ? "0" : "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NOGLOB_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...overrides,
  };
}

function gitText(repo: string, args: readonly string[], env?: NodeJS.ProcessEnv, optionalLocks = false): string {
  return execFileSync(GIT_EXECUTABLE, ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
    encoding: "utf8",
    env: trustedGitEnvironment(env, optionalLocks),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: MAX_GIT_OUTPUT,
  }).trim();
}

function gitBuffer(repo: string, args: readonly string[], optionalLocks = false): Buffer {
  return execFileSync(GIT_EXECUTABLE, ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
    encoding: "buffer",
    env: trustedGitEnvironment({}, optionalLocks),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

function assertSelectedGitBoundary(repo: string, expectedCommonDirectory: string): void {
  if (realpathSync.native(repo) !== repo || realpathSync.native(expectedCommonDirectory) !== expectedCommonDirectory) {
    throw new Error("selected repository or Git common directory is no longer canonical");
  }
  const observed = realpathSync.native(gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (observed !== expectedCommonDirectory) {
    throw new Error("repository Git common directory differs from the StateStore selection");
  }
}

function assertSafeRefComponent(value: string, label: string): void {
  if (!SAFE_REF_COMPONENT.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} cannot be represented in the private attempt ref namespace`);
  }
}

function assertContained(root: string, path: string, label: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`${label} is not a strict descendant of the canonical resource root`);
  }
}

function identity(
  kind: FixedAttemptResourceKind,
  canonicalIdentity: string,
  attemptId: string,
  resourceIdentityVersion: string,
): AttemptResourceIdentity {
  const identityDigest = sha256(canonicalJson({
    schema_version: resourceIdentityVersion,
    kind,
    canonical_identity: canonicalIdentity,
  }));
  return Object.freeze({
    resourceClaimId: `claim-${sha256(canonicalJson({
      schema_version: resourceIdentityVersion,
      attempt_id: attemptId,
      slot: kind,
      canonical_identity: canonicalIdentity,
    })).slice(7)}`,
    slot: kind,
    kind,
    canonicalIdentity,
    identityDigest,
  });
}

/** Pure derivation. No caller-provided path or ref component reaches an identity. */
export function deriveAttemptWorkspacePlan(
  location: StateLocation,
  lineage: AttemptOwnershipLineage,
): AttemptWorkspacePlan {
  if (lineage.repositoryId !== location.repositoryId) throw new TypeError("attempt lineage belongs to another repository");
  assertSafeRefComponent(lineage.runId, "run id");
  assertSafeRefComponent(lineage.attemptId, "attempt id");
  if (!Number.isSafeInteger(lineage.attemptNumber) || lineage.attemptNumber < 1) {
    throw new TypeError("attempt number must be a positive safe integer");
  }
  const allocationDigest = sha256(canonicalJson({
    repository_id: lineage.repositoryId,
    run_id: lineage.runId,
    ticket_instance_id: lineage.ticketInstanceId,
    attempt_id: lineage.attemptId,
  }));
  const allocationRoot = join(location.resourceDirectory, allocationDigest.slice(7));
  const attemptRef = `refs/rickgent/runs/${lineage.runId}/attempts/${lineage.attemptId}`;
  const worktreePath = join(allocationRoot, "worktree");
  const isolatedIndexPath = join(allocationRoot, "index");
  const policyContextPath = join(allocationRoot, "policy", "context.json");
  const policyBundlePath = join(allocationRoot, "policy", "bundle");
  const stdoutPath = join(allocationRoot, "output", "stdout.log");
  const stderrPath = join(allocationRoot, "output", "stderr.log");
  const verificationOutputPath = join(allocationRoot, "output", "verification.json");
  // Salvage is evidence for the failed allocation, so it must not live below
  // the allocation root that cleanup removes. Keep it in a sibling, private
  // namespace whose identity is still derived entirely from the attempt.
  const salvageArchivePath = join(location.resourceDirectory, "salvage", allocationDigest.slice(7), "archive");
  for (const [label, path] of [
    ["allocation root", allocationRoot],
    ["worktree", worktreePath],
    ["isolated index", isolatedIndexPath],
    ["policy context", policyContextPath],
    ["policy bundle", policyBundlePath],
    ["stdout", stdoutPath],
    ["stderr", stderrPath],
    ["verification output", verificationOutputPath],
    ["salvage archive", salvageArchivePath],
  ] as const) assertContained(location.resourceDirectory, path, label);
  const resources = Object.freeze([
    identity("delivery_ref", lineage.deliveryRef, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("attempt_ref", attemptRef, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("worktree", worktreePath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("isolated_index", isolatedIndexPath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("policy_context", policyContextPath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("policy_bundle", policyBundlePath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("process_group", `process-group:${lineage.attemptId}`, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("stdout", stdoutPath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("stderr", stderrPath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("verification_output", verificationOutputPath, lineage.attemptId, lineage.resourceIdentityVersion),
    identity("salvage_archive", salvageArchivePath, lineage.attemptId, lineage.resourceIdentityVersion),
  ]);
  return Object.freeze({
    schemaVersion: ATTEMPT_OWNERSHIP_SCHEMA_VERSION,
    lineage: Object.freeze({ ...lineage }),
    allocationDigest,
    allocationRoot,
    attemptRef,
    worktreePath,
    isolatedIndexPath,
    policyContextPath,
    policyBundlePath,
    stdoutPath,
    stderrPath,
    verificationOutputPath,
    salvageArchivePath,
    resources,
  });
}

function pathMode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function assertPrivateDirectory(path: string, label: string): void {
  const info = lstatSync(path);
  if (typeof process.geteuid !== "function") throw new Error("effective owner checks are unavailable");
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.geteuid() || pathMode(path) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`${label} is not an owned, non-symlink 0700 directory`);
  }
  if (realpathSync.native(path) !== path) throw new Error(`${label} is not canonical`);
}

function assertCanonicalDirectoryComponents(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} is not absolute`);
  const root = parse(path).root;
  let cursor = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync.native(cursor) !== cursor) {
      throw new Error(`${label} contains a symlinked, foreign, or noncanonical component: ${cursor}`);
    }
  }
}

function ensurePrivateDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(path, label);
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function gitIndexPath(repo: string): string {
  const path = gitText(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (!isAbsolute(path) || !lstatSync(path).isFile()) throw new Error("caller index is unavailable");
  return path;
}

function filterFreeCallerFilesystemInventory(repo: string): Buffer {
  const paths: string[] = [];
  let reservedEntries = 0;
  const visit = (directory: string, prefix: string): void => {
    const names: Array<{ readonly name: string; readonly raw: Buffer }> = [];
    const handle = opendirSync(directory, { encoding: "utf8" });
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        const name = entry.name;
        if (name.includes("\uFFFD")) throw new Error("caller worktree contains a non-UTF-8 filesystem path");
        const rawName = Buffer.from(name, "utf8");
        if (prefix === "" && name === ".git") continue;
        if (name === ".git") throw new Error("caller worktree contains an embedded Git repository");
        if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
          throw new Error("caller worktree contains a noncanonical filesystem entry");
        }
        if (paths.length + reservedEntries >= MAX_CALLER_PATHS) {
          throw new Error("caller worktree path inventory exceeds its hard bound");
        }
        names.push({ name, raw: rawName });
        reservedEntries += 1;
      }
    } finally {
      handle.closeSync();
    }
    names.sort((left, right) => Buffer.compare(left.raw, right.raw));
    for (const { name } of names) {
      reservedEntries -= 1;
      if (paths.length >= MAX_CALLER_PATHS) throw new Error("caller worktree path inventory exceeds its hard bound");
      const path = prefix === "" ? name : `${prefix}/${name}`;
      paths.push(path);
      const absolute = join(directory, name);
      const observed = lstatSync(absolute);
      if (observed.isDirectory() && !observed.isSymbolicLink()) visit(absolute, path);
    }
  };
  visit(repo, "");
  return Buffer.from(paths.sort().join("\0") + (paths.length === 0 ? "" : "\0"), "utf8");
}

/** Exact raw-byte caller snapshot. It never invokes attributes, filters, textconv, or status conversion. */
function filterFreeCallerWorktreeDigest(repo: string): `sha256:${string}` {
  const enumerate = (): Buffer => gitBuffer(repo, ["ls-files", "--cached", "--others", "-z", "--"], true);
  const listedBefore = enumerate();
  const filesystemBefore = filterFreeCallerFilesystemInventory(repo);
  const decodeInventory = (raw: Buffer, label: string): string[] => {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(`caller worktree contains a non-UTF-8 ${label} path`);
    }
    const paths = decoded.split("\0");
    if (paths.at(-1) === "") paths.pop();
    if (new Set(paths).size !== paths.length) throw new Error(`caller worktree ${label} path inventory is duplicate`);
    return paths;
  };
  const gitPaths = decodeInventory(listedBefore, "Git");
  const filesystemPaths = decodeInventory(filesystemBefore, "filesystem");
  const uniquePaths = [...new Set([...gitPaths, ...filesystemPaths])].sort();
  if (uniquePaths.length > MAX_CALLER_PATHS) {
    throw new Error("caller worktree path inventory exceeds its hard bound");
  }
  const digest = createHash("sha256").update("rickgent.caller-worktree.v1\0");
  let totalBytes = 0;
  for (const path of uniquePaths) {
    if (
      path === "" || path.includes("\0") || path.includes("\\") || isAbsolute(path) ||
      path === "." || path === ".." || path.startsWith("../") || path.includes("/../") || path.endsWith("/..")
    ) throw new Error(`caller worktree contains a noncanonical Git path: ${JSON.stringify(path)}`);
    const absolute = join(repo, ...path.split("/"));
    const fromRoot = relative(repo, absolute);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("caller worktree path escapes the selected repository");
    }
    digest.update(Buffer.from(`${Buffer.byteLength(path)}:`, "utf8")).update(path, "utf8").update("\0");
    let before: Stats | null;
    try {
      before = lstatSync(absolute) as Stats;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") before = null;
      else throw error;
    }
    if (before === null) {
      digest.update("missing\0");
      continue;
    }
    const mode = before.mode & 0o177777;
    if (before.isSymbolicLink()) {
      const target = readlinkSync(absolute, { encoding: "buffer" });
      digest.update(`symlink:${mode}:${target.length}:`).update(target).update("\0");
      continue;
    }
    if (before.isDirectory()) {
      digest.update(`directory:${mode}\0`);
      continue;
    }
    if (!before.isFile()) {
      throw new Error(`caller worktree contains an unsupported non-file entry: ${path}`);
    }
    if (before.size > MAX_CALLER_FILE_BYTES) throw new Error(`caller file exceeds its snapshot bound: ${path}`);
    totalBytes += before.size;
    if (totalBytes > MAX_CALLER_TOTAL_BYTES) throw new Error("caller worktree exceeds its total snapshot byte bound");
    const descriptor = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || !opened.isFile()) {
        throw new Error(`caller file changed identity while opening: ${path}`);
      }
      const content = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (
        after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        content.length !== opened.size
      ) throw new Error(`caller file changed while being snapshotted: ${path}`);
      digest.update(`file:${mode}:${content.length}:`).update(content).update("\0");
    } finally {
      closeSync(descriptor);
    }
  }
  if (
    !listedBefore.equals(enumerate()) ||
    !filesystemBefore.equals(filterFreeCallerFilesystemInventory(repo))
  ) throw new Error("caller worktree path inventory changed during snapshot");
  return `sha256:${digest.digest("hex")}`;
}

export function snapshotAttemptCaller(repo: string, expectedCommonDirectory?: string): AttemptCallerSnapshot {
  if (expectedCommonDirectory !== undefined) assertSelectedGitBoundary(repo, expectedCommonDirectory);
  const headOid = gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (expectedCommonDirectory !== undefined) assertSelectedGitBoundary(repo, expectedCommonDirectory);
  let symbolicRef: string | null = null;
  try {
    symbolicRef = gitText(repo, ["symbolic-ref", "-q", "HEAD"]);
  } catch (error) {
    if (commandStatus(error) !== 1) throw error;
    // Detached callers are valid inputs; status 1 is Git's documented quiet miss.
  }
  if (expectedCommonDirectory !== undefined) assertSelectedGitBoundary(repo, expectedCommonDirectory);
  const statusDigest = filterFreeCallerWorktreeDigest(repo);
  if (expectedCommonDirectory !== undefined) assertSelectedGitBoundary(repo, expectedCommonDirectory);
  return Object.freeze({
    headOid,
    symbolicRef,
    indexDigest: sha256(readFileSync(gitIndexPath(repo))),
    statusDigest,
  });
}

function sameCaller(left: AttemptCallerSnapshot, right: AttemptCallerSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function commandStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function assertRef(repo: string, expectedCommonDirectory: string, ref: string, baselineOid: string, allowCreate: boolean): void {
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  gitText(repo, ["check-ref-format", ref]);
  try {
    execFileSync(GIT_EXECUTABLE, ["-c", "core.hooksPath=/dev/null", "-C", repo, "show-ref", "--verify", "--quiet", ref], {
      env: trustedGitEnvironment({}, true),
      stdio: "ignore",
    });
  } catch (error) {
    if (commandStatus(error) !== 1) throw error;
    if (!allowCreate) throw new Error(`${ref} disappeared after its durable allocation observation`);
    assertSelectedGitBoundary(repo, expectedCommonDirectory);
    const zeroOid = "0".repeat(baselineOid.length);
    execFileSync(GIT_EXECUTABLE, ["-c", "core.hooksPath=/dev/null", "-C", repo, "update-ref", ref, baselineOid, zeroOid], {
      env: trustedGitEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  if (gitText(repo, ["rev-parse", "--verify", `${ref}^{commit}`]) !== baselineOid) {
    throw new Error(`${ref} belongs to a foreign commit`);
  }
}

function observeWorktree(repo: string, expectedCommonDirectory: string, plan: AttemptWorkspacePlan, allowCreate: boolean): string {
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  if (!existsSync(plan.worktreePath)) {
    if (!allowCreate) throw new Error("attempt worktree disappeared after durable allocation");
    assertSelectedGitBoundary(repo, expectedCommonDirectory);
    execFileSync(GIT_EXECUTABLE, ["-c", "core.hooksPath=/dev/null", "-C", repo, "worktree", "add", "--detach", "--quiet", plan.worktreePath, plan.lineage.deliveryBaselineOid], {
      env: trustedGitEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  assertPrivateDirectory(plan.allocationRoot, "attempt allocation root");
  const info = lstatSync(plan.worktreePath);
  if (
    typeof process.geteuid !== "function" || info.isSymbolicLink() || !info.isDirectory() ||
    info.uid !== process.geteuid() || realpathSync.native(plan.worktreePath) !== plan.worktreePath
  ) {
    throw new Error("attempt worktree path is foreign or noncanonical");
  }
  const dotGitPath = join(plan.worktreePath, ".git");
  const dotGit = lstatSync(dotGitPath);
  if (dotGit.isSymbolicLink() || !dotGit.isFile() || dotGit.uid !== process.geteuid()) {
    throw new Error("attempt worktree .git boundary is foreign or symlinked");
  }
  const head = gitText(plan.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const common = realpathSync.native(gitText(plan.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (head !== plan.lineage.deliveryBaselineOid || common !== expectedCommonDirectory) {
    throw new Error("attempt worktree identity or baseline is foreign");
  }
  if (gitBuffer(plan.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true).length !== 0) {
    throw new Error("attempt worktree is dirty");
  }
  const worktreeGitDirectory = realpathSync.native(gitText(plan.worktreePath, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  assertContained(join(expectedCommonDirectory, "worktrees"), worktreeGitDirectory, "attempt worktree administrative directory");
  const dotGitTarget = readFileSync(dotGitPath, "utf8").trim();
  if (dotGitTarget !== `gitdir: ${worktreeGitDirectory}`) throw new Error("attempt worktree .git file names a foreign administrative directory");
  const registrations = gitText(repo, ["worktree", "list", "--porcelain"], undefined, true)
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realpathSync.native(line.slice("worktree ".length)));
  if (registrations.filter((path) => path === plan.worktreePath).length !== 1) {
    throw new Error("attempt worktree does not have one exact canonical registration");
  }
  return worktreeGitDirectory;
}

function observeIsolatedIndex(repo: string, expectedCommonDirectory: string, plan: AttemptWorkspacePlan, allowCreate: boolean): void {
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  const env = { GIT_INDEX_FILE: plan.isolatedIndexPath };
  const created = !existsSync(plan.isolatedIndexPath);
  if (created) {
    if (!allowCreate) throw new Error("isolated index disappeared after durable allocation");
    assertSelectedGitBoundary(repo, expectedCommonDirectory);
    gitText(repo, ["read-tree", `${plan.lineage.deliveryBaselineOid}^{tree}`], env);
  }
  let info = lstatSync(plan.isolatedIndexPath);
  if (typeof process.geteuid !== "function") throw new Error("effective owner checks are unavailable");
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.geteuid() || (!created && pathMode(plan.isolatedIndexPath) !== PRIVATE_FILE_MODE)) {
    throw new Error(
      `isolated index is foreign, symlinked, or has unsafe permissions ` +
      `(symlink=${String(info.isSymbolicLink())}, file=${String(info.isFile())}, uid=${info.uid}, expected_uid=${process.geteuid()}, mode=${pathMode(plan.isolatedIndexPath).toString(8)})`,
    );
  }
  if (realpathSync.native(plan.isolatedIndexPath) !== plan.isolatedIndexPath) throw new Error("isolated index is noncanonical");
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  const expectedTree = gitText(repo, ["rev-parse", `${plan.lineage.deliveryBaselineOid}^{tree}`]);
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  if (gitText(repo, ["write-tree"], env) !== expectedTree) throw new Error("isolated index does not represent the immutable baseline tree");
  // Git may replace the index through an index.lock rename even for
  // write-tree. Re-apply the private mode after that owned observation.
  chmodSync(plan.isolatedIndexPath, PRIVATE_FILE_MODE);
  info = lstatSync(plan.isolatedIndexPath);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.geteuid() || pathMode(plan.isolatedIndexPath) !== PRIVATE_FILE_MODE) {
    throw new Error(`isolated index permissions changed during independent observation (mode=${pathMode(plan.isolatedIndexPath).toString(8)})`);
  }
  fsyncFile(plan.isolatedIndexPath);
}

function observeExistingIsolatedIndexReadOnly(
  repo: string,
  expectedCommonDirectory: string,
  plan: AttemptWorkspacePlan,
): void {
  assertSelectedGitBoundary(repo, expectedCommonDirectory);
  const info = lstatSync(plan.isolatedIndexPath);
  if (
    typeof process.geteuid !== "function" || info.isSymbolicLink() || !info.isFile() ||
    info.uid !== process.geteuid() || pathMode(plan.isolatedIndexPath) !== PRIVATE_FILE_MODE ||
    realpathSync.native(plan.isolatedIndexPath) !== plan.isolatedIndexPath
  ) {
    throw new Error("isolated index is not the exact owned, canonical 0600 file");
  }
  try {
    execFileSync(GIT_EXECUTABLE, [
      "-c", "core.hooksPath=/dev/null", "-C", repo,
      "diff-index", "--cached", "--quiet", plan.lineage.deliveryBaselineOid, "--",
    ], {
      env: trustedGitEnvironment({ GIT_INDEX_FILE: plan.isolatedIndexPath }, true),
      stdio: "ignore",
      timeout: 10_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch (error) {
    if (commandStatus(error) === 1) throw new Error("isolated index does not represent the immutable baseline tree");
    throw error;
  }
}

function resourceState(ownership: AttemptOwnershipGrant, slot: FixedAttemptResourceKind): string {
  const claim = ownership.resources.find((candidate) => candidate.slot === slot);
  if (claim === undefined) throw new Error(`ownership is missing fixed resource slot ${slot}`);
  return claim.state;
}

function advanceIf(
  authority: LeaseAuthority,
  ownership: AttemptOwnershipGrant,
  slot: AttemptWorkspaceResourceReceipt["slot"],
  expected: "reserved" | "allocated",
  next: "allocated" | "active",
  suffix: string,
): AttemptOwnershipGrant {
  if (resourceState(ownership, slot) !== expected) return ownership;
  const receipt = new AttemptWorkspaceResourceReceipt(
    WORKSPACE_RECEIPT_AUTHORITY,
    ownership,
    slot,
    expected,
    next,
    sha256(canonicalJson({
      schema_version: "rickgent.attempt-workspace-observation/v1",
      attempt_id: ownership.attemptId,
      ownership_id: ownership.ownership.ownershipId,
      generation: ownership.ownership.generation,
      allocation_digest: ownership.plan.allocationDigest,
      slot,
      observed_state: next,
    })),
  );
  return authority.advanceWorkspaceResource({
    ownership,
    receipt,
    idempotencyKey: `workspace:${suffix}:${slot}`,
  });
}

function containFailure(
  authority: LeaseAuthority,
  ownership: AttemptOwnershipGrant,
  detail: string,
): ProvisionAttemptWorkspaceResult {
  try {
    const cleanup = authority.beginCleanup({
      ownership,
      idempotencyKey: `workspace:cleanup:${sha256(detail).slice(7)}`,
    });
    return { ok: false, code: "ATTEMPT_WORKSPACE_FOREIGN_RESOURCE", detail, ownership: cleanup };
  } catch (error) {
    return {
      ok: false,
      code: "ATTEMPT_WORKSPACE_QUARANTINE_FAILED",
      detail: `${detail}; durable cleanup containment failed: ${error instanceof Error ? error.message : String(error)}`,
      ownership,
    };
  }
}

/** Reconciles a durable reservation with Git/filesystem effects. It never guesses cleanup. */
export function provisionAttemptWorkspace(
  authority: LeaseAuthority,
  initialOwnership: AttemptOwnershipGrant,
): ProvisionAttemptWorkspaceResult {
  let ownership = initialOwnership;
  const plan = ownership.plan;
  const repo = plan.lineage.repositoryId === ownership.repositoryId ? ownership.repositoryPath : "";
  if (repo === "") {
    return { ok: false, code: "ATTEMPT_WORKSPACE_INVALID_IDENTITY", detail: "ownership repository identity is inconsistent", ownership };
  }
  let callerBefore: AttemptCallerSnapshot;
  try {
    assertSelectedGitBoundary(repo, ownership.gitCommonDirectory);
    callerBefore = snapshotAttemptCaller(repo, ownership.gitCommonDirectory);
    const resourceDirectory = dirname(plan.allocationRoot);
    assertCanonicalDirectoryComponents(resourceDirectory, "canonical attempt resource root");
    assertPrivateDirectory(resourceDirectory, "canonical attempt resource root");
    ownership = authority.assertFresh(ownership);
    ensurePrivateDirectory(plan.allocationRoot, "attempt allocation root");
    ensurePrivateDirectory(join(plan.allocationRoot, "policy"), "attempt policy root");
    ensurePrivateDirectory(join(plan.allocationRoot, "output"), "attempt output root");

    assertRef(repo, ownership.gitCommonDirectory, plan.lineage.deliveryRef, plan.lineage.deliveryBaselineOid, resourceState(ownership, "delivery_ref") === "reserved");
    ownership = advanceIf(authority, ownership, "delivery_ref", "reserved", "allocated", "observed");
    ownership = authority.assertFresh(ownership);
    assertRef(repo, ownership.gitCommonDirectory, plan.attemptRef, plan.lineage.deliveryBaselineOid, resourceState(ownership, "attempt_ref") === "reserved");
    ownership = advanceIf(authority, ownership, "attempt_ref", "reserved", "allocated", "created");
    ownership = authority.assertFresh(ownership);
    const worktreeGitDirectory = observeWorktree(repo, ownership.gitCommonDirectory, plan, resourceState(ownership, "worktree") === "reserved");
    ownership = advanceIf(authority, ownership, "worktree", "reserved", "allocated", "created");
    ownership = authority.assertFresh(ownership);
    observeIsolatedIndex(repo, ownership.gitCommonDirectory, plan, resourceState(ownership, "isolated_index") === "reserved");
    ownership = advanceIf(authority, ownership, "isolated_index", "reserved", "allocated", "created");

    for (const slot of ["delivery_ref", "attempt_ref", "worktree", "isolated_index"] as const) {
      ownership = authority.assertFresh(ownership);
      ownership = advanceIf(authority, ownership, slot, "allocated", "active", "verified");
    }
    const callerAfter = snapshotAttemptCaller(repo, ownership.gitCommonDirectory);
    if (!sameCaller(callerBefore, callerAfter)) throw new Error("caller HEAD, index, or dirty state changed during attempt allocation");
    const workspace = new ReadyAttemptWorkspace(READY_WORKSPACE_AUTHORITY, {
      kind: "ready_attempt_workspace",
      ownership,
      callerRepository: repo,
      commonGitDirectory: ownership.gitCommonDirectory,
      callerBefore,
      allocationRoot: plan.allocationRoot,
      deliveryRef: plan.lineage.deliveryRef,
      baselineOid: plan.lineage.deliveryBaselineOid,
      attemptRef: plan.attemptRef,
      worktreePath: plan.worktreePath,
      worktreeGitDirectory,
      isolatedIndexPath: plan.isolatedIndexPath,
    });
    const ready = attemptWorkspaceReadyForSpawn(authority, workspace);
    if (!ready.ready) {
      return { ok: false, code: "ATTEMPT_WORKSPACE_FOREIGN_RESOURCE", detail: ready.detail, ownership: ready.ownership };
    }
    const readyWorkspace = new ReadyAttemptWorkspace(READY_WORKSPACE_AUTHORITY, {
      ...workspace,
      ownership: ready.ownership,
    });
    return { ok: true, workspace: readyWorkspace, authorization: ready.authorization };
  } catch (error) {
    return containFailure(authority, ownership, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Adjacent pre-spawn observation. Success re-reads the current unexpired
 * token-bound owner. Failure enters durable cleanup containment when that
 * owner is still current. Git may rewrite index metadata, so the private mode
 * is restored before returning.
 */
export function attemptWorkspaceReadyForSpawn(
  authority: LeaseAuthority,
  workspace: ReadyAttemptWorkspace,
): AttemptWorkspaceReadiness {
  if (!AUTHORIZED_READY_WORKSPACES.has(workspace)) {
    throw new TypeError("ready attempt workspace was not minted by the attempt workspace authority");
  }
  let ownership = workspace.ownership;
  const fail = (code: "identity_changed" | "dirty" | "caller_changed" | "unavailable", detail: string): AttemptWorkspaceReadiness => {
    try {
      ownership = authority.beginCleanup({
        ownership,
        idempotencyKey: `workspace:pre-spawn-cleanup:${sha256(canonicalJson({ code, detail })).slice(7)}`,
      });
      return { ready: false, code, detail: `${detail}; durable cleanup containment entered`, ownership };
    } catch (error) {
      return {
        ready: false,
        code,
        detail: `${detail}; cleanup containment unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ownership,
      };
    }
  };
  try {
    ownership = authority.assertFresh(ownership);
    const plan = ownership.plan;
    if (
      workspace.callerRepository !== ownership.repositoryPath ||
      workspace.commonGitDirectory !== ownership.gitCommonDirectory ||
      workspace.allocationRoot !== plan.allocationRoot ||
      workspace.deliveryRef !== plan.lineage.deliveryRef ||
      workspace.baselineOid !== plan.lineage.deliveryBaselineOid ||
      workspace.attemptRef !== plan.attemptRef ||
      workspace.worktreePath !== plan.worktreePath ||
      workspace.isolatedIndexPath !== plan.isolatedIndexPath
    ) {
      return fail("identity_changed", "workspace execution identity differs from the authority-derived plan");
    }
    assertSelectedGitBoundary(workspace.callerRepository, ownership.gitCommonDirectory);
    assertPrivateDirectory(plan.allocationRoot, "attempt allocation root");
    const callerAfter = snapshotAttemptCaller(workspace.callerRepository, ownership.gitCommonDirectory);
    if (!sameCaller(workspace.callerBefore, callerAfter)) {
      return fail("caller_changed", "caller HEAD, index, or dirty state changed after allocation");
    }
    if (
      gitText(workspace.callerRepository, ["rev-parse", "--verify", `${workspace.deliveryRef}^{commit}`]) !== workspace.baselineOid ||
      gitText(workspace.callerRepository, ["rev-parse", "--verify", `${workspace.attemptRef}^{commit}`]) !== workspace.baselineOid
    ) return fail("identity_changed", "attempt ref or delivery baseline changed");
    if (gitBuffer(workspace.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true).length !== 0) {
      return fail("dirty", "attempt worktree contains an uncommitted delta");
    }
    const observedWorktreeGitDirectory = observeWorktree(
      workspace.callerRepository,
      ownership.gitCommonDirectory,
      plan,
      false,
    );
    if (observedWorktreeGitDirectory !== workspace.worktreeGitDirectory) {
      return fail("identity_changed", "attempt worktree administrative identity changed");
    }
    ownership = authority.assertFresh(ownership);
    observeExistingIsolatedIndexReadOnly(workspace.callerRepository, ownership.gitCommonDirectory, plan);
    if (["delivery_ref", "attempt_ref", "worktree", "isolated_index"].some((slot) => resourceState(ownership, slot as FixedAttemptResourceKind) !== "active")) {
      return fail("identity_changed", "durable attempt workspace resources are not active");
    }
    assertSelectedGitBoundary(workspace.callerRepository, ownership.gitCommonDirectory);
    ownership = authority.assertFresh(ownership);
    const observationDigest = sha256(canonicalJson({
      schema_version: "rickgent.attempt-workspace-spawn-authorization/v1",
      attempt_id: ownership.attemptId,
      ownership_id: ownership.ownership.ownershipId,
      generation: ownership.ownership.generation,
      ownership_version: ownership.ownership.stateVersion,
      expires_at: ownership.ownership.expiresAt,
      repository_id: ownership.repositoryId,
      common_git_directory: ownership.gitCommonDirectory,
      allocation_digest: ownership.plan.allocationDigest,
      delivery_ref: workspace.deliveryRef,
      baseline_oid: workspace.baselineOid,
      attempt_ref: workspace.attemptRef,
      worktree_path: workspace.worktreePath,
      worktree_git_directory: workspace.worktreeGitDirectory,
      isolated_index_path: workspace.isolatedIndexPath,
    }));
    const authorization = new AttemptWorkspaceSpawnAuthorization(
      SPAWN_AUTHORIZATION_AUTHORITY,
      ownership,
      workspace,
      observationDigest,
    );
    return {
      ready: true,
      detail: "attempt workspace ownership, baseline, caller, worktree, and index are exact",
      ownership,
      authorization,
    };
  } catch (error) {
    return fail("unavailable", error instanceof Error ? error.message : String(error));
  }
}
