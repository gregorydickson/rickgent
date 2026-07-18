// Salvage executor — the lifecycle layer that EXECUTES git mutations.
// The core DECIDES the disposition; this module EXECUTES it safely.
// §14.8: decide / execute / verify split. R-MACB: never git add -A.
//
// Legacy dispositions are capture-only here. This executor may preserve an
// owned-path patch, but it cannot commit, move refs, reset lifecycle state, or
// claim terminal completion. Those authorities belong to the SQLite trust
// spine and its commit/promotion/finalization services.

import { decideSalvage, type SalvageInput, type SalvageDecision } from "../core/salvage.js";
import { execFileSync } from "child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";
import { canonicalJson } from "../contracts/ticket-contract.js";

export interface SalvageExecutionResult {
  decision: SalvageDecision;
  executed: boolean;
  gitOutput: string | null;
  /** Path to the durable on-disk archive written for an archived-todo. */
  archivePath: string | null;
  /** Always false: salvage capture is evidence, never terminal authority. */
  terminal: false;
}

/**
 * Per-execution context for capture location and diagnostic identity only.
 */
export interface SalvageExecutionContext {
  ticketId?: string;
  /** @deprecated Ignored legacy diagnostic; registry JSON is not authority. */
  registry?: unknown;
  /** @deprecated Diagnostic only; salvage cannot move refs. */
  sourceRef?: string;
  /** @deprecated Diagnostic only; salvage cannot move refs. */
  targetRef?: string;
  /** Override for the archive directory (defaults to <workingDir>/.rickgent/salvage-archives). */
  archiveDir?: string;
}

export class SalvageExecutor {
  constructor(private workingDir: string) {}

  execute(input: SalvageInput, ctx: SalvageExecutionContext = {}): SalvageExecutionResult {
    const decision = decideSalvage(input);
    let executed = false;
    let gitOutput: string | null = null;
    let archivePath: string | null = null;

    try {
      switch (decision.disposition) {
        case "committed-done":
          if (decision.stagedPaths && decision.stagedPaths.length > 0) {
            archivePath = this.writeArchive(decision.stagedPaths, ctx);
            gitOutput = archivePath;
            executed = true;
          }
          break;
        case "archived-todo": {
          // Write a durable, restorable, owned-paths-scoped patch to disk BEFORE
          // any reset (never lose work). The archive is a `git apply`-able diff.
          archivePath = this.writeArchive(decision.stagedPaths ?? [], ctx);
          gitOutput = archivePath;
          executed = true;
          break;
        }
        case "ff-reattached": {
          gitOutput = "ff-reattach requires SQLite recovery authority; no git mutation performed";
          executed = false;
          break;
        }
        case "no-op":
          executed = true;
          break;
        case "error":
          executed = false;
          break;
      }
    } catch (err) {
      executed = false;
      gitOutput = err instanceof Error ? err.message : String(err);
    }

    return { decision, executed, gitOutput, archivePath, terminal: false };
  }

  /** Strict t21 capture path. Unlike execute(), this never mutates any Git index. */
  captureDurable(
    request: DurableSalvageArchiveRequest,
    hooks: DurableSalvageCaptureHooks = {},
  ): DurableSalvageCaptureResult {
    return captureDurableSalvageArchive(this.workingDir, request, hooks);
  }

  private archiveDir(ctx: SalvageExecutionContext): string {
    return ctx.archiveDir ?? join(this.workingDir, ".rickgent", "salvage-archives");
  }

  private writeArchive(ownedPaths: string[], ctx: SalvageExecutionContext): string {
    const dir = this.archiveDir(ctx);
    mkdirSync(dir, { recursive: true });
    const patch = this.buildOwnedDiff(ownedPaths);
    const label = ctx.ticketId ? ctx.ticketId.replace(/[^A-Za-z0-9_-]/g, "_") : "salvage";
    const file = join(dir, `${label}-${Date.now()}.patch`);
    writeFileSync(file, patch);
    return file;
  }

  /**
   * Owned-paths-only, restorable diff vs HEAD. Plain `git diff HEAD` sees only
   * TRACKED changes, so owned UNTRACKED work would be silently dropped and the
   * archive non-restorable. We first intent-to-add (`git add -N`) the owned
   * untracked files so `git diff HEAD` emits them as new-file additions, then
   * undo the intent-to-add so archiving leaves no residual index state. Only the
   * untracked files git itself reports under the owned pathspec are added, so the
   * archive can never capture out-of-scope/unowned files, and array-argv with
   * `--` keeps a hostile path from being reinterpreted as a git option.
   */
  private buildOwnedDiff(ownedPaths: string[]): string {
    const diff = (paths: string[]): string =>
      execFileSync("git", paths.length > 0 ? ["diff", "HEAD", "--", ...paths] : ["diff", "HEAD"], {
        cwd: this.workingDir,
        encoding: "utf-8",
        timeout: 10000,
      });

    if (ownedPaths.length === 0) {
      return diff(ownedPaths);
    }

    const untracked = this.ownedUntrackedFiles(ownedPaths);
    if (untracked.length === 0) {
      return diff(ownedPaths);
    }

    execFileSync("git", ["add", "-N", "--", ...untracked], { cwd: this.workingDir, timeout: 10000 });
    try {
      return diff(ownedPaths);
    } finally {
      execFileSync("git", ["reset", "-q", "--", ...untracked], { cwd: this.workingDir, timeout: 10000 });
    }
  }

  private ownedUntrackedFiles(ownedPaths: string[]): string[] {
    const out = execFileSync(
      "git",
      ["ls-files", "-o", "--exclude-standard", "-z", "--", ...ownedPaths],
      { cwd: this.workingDir, encoding: "utf-8", timeout: 10000 },
    );
    return out.split("\0").filter((p) => p.length > 0);
  }
}

const DURABLE_SALVAGE_SCHEMA_VERSION = "rickgent.salvage-archive.v1" as const;
const SALVAGE_RECEIPT_AUTHORITY = Symbol("rickgent.salvage-disposition-receipt");
const AUTHORIZED_SALVAGE_RECEIPTS = new WeakSet<object>();
const GIT_EXECUTABLE = "/usr/bin/git";

export const DURABLE_SALVAGE_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
  maxArtifactBytes: 96 * 1024 * 1024,
  maxGitMetadataBytes: 8 * 1024 * 1024,
  maxIndexBytes: 16 * 1024 * 1024,
  maxRefs: 16,
} as const);

export type DurableSalvageDisposition = "captured" | "empty";

export class SalvageDispositionReceipt {
  readonly salvageRecordId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipContextDigest: `sha256:${string}`;
  readonly contextId: string;
  readonly disposition: DurableSalvageDisposition;
  readonly artifactPath: string | null;
  readonly artifactDigest: `sha256:${string}` | null;
  readonly artifactSize: number | null;
  readonly evidenceId: string;
  readonly processReceiptId: string;
  readonly groupDeathEvidenceId: string;
  readonly baselineOid: string;
  readonly attemptRef: string;
  readonly expectedAttemptRefOid: string;
  readonly indexDigest: `sha256:${string}`;
  readonly createdAt: string;

  constructor(
    authority: symbol,
    input: {
      readonly salvageRecordId: string;
      readonly attemptId: string;
      readonly ownershipId: string;
      readonly ownerGeneration: number;
      readonly ownershipContextDigest: `sha256:${string}`;
      readonly contextId: string;
      readonly disposition: DurableSalvageDisposition;
      readonly artifactPath: string | null;
      readonly artifactDigest: `sha256:${string}` | null;
      readonly artifactSize: number | null;
      readonly evidenceId: string;
      readonly processReceiptId: string;
      readonly groupDeathEvidenceId: string;
      readonly baselineOid: string;
      readonly attemptRef: string;
      readonly expectedAttemptRefOid: string;
      readonly indexDigest: `sha256:${string}`;
      readonly createdAt: string;
    },
  ) {
    if (authority !== SALVAGE_RECEIPT_AUTHORITY) {
      throw new TypeError("salvage receipts can only be minted by durable salvage capture");
    }
    this.salvageRecordId = input.salvageRecordId;
    this.attemptId = input.attemptId;
    this.ownershipId = input.ownershipId;
    this.ownerGeneration = input.ownerGeneration;
    this.ownershipContextDigest = input.ownershipContextDigest;
    this.contextId = input.contextId;
    this.disposition = input.disposition;
    this.artifactPath = input.artifactPath;
    this.artifactDigest = input.artifactDigest;
    this.artifactSize = input.artifactSize;
    this.evidenceId = input.evidenceId;
    this.processReceiptId = input.processReceiptId;
    this.groupDeathEvidenceId = input.groupDeathEvidenceId;
    this.baselineOid = input.baselineOid;
    this.attemptRef = input.attemptRef;
    this.expectedAttemptRefOid = input.expectedAttemptRefOid;
    this.indexDigest = input.indexDigest;
    this.createdAt = input.createdAt;
    AUTHORIZED_SALVAGE_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedSalvageReceipt(value: unknown): value is SalvageDispositionReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_SALVAGE_RECEIPTS.has(value);
}

export interface DurableSalvageArchiveRequest {
  readonly archiveRoot: string;
  readonly baselineOid: string;
  readonly attemptRef: string;
  readonly expectedAttemptRefOid: string;
  readonly indexPath?: string;
  readonly includeRefs?: readonly string[];
  readonly salvageRecordId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipContextDigest: `sha256:${string}`;
  readonly contextId: string;
  readonly evidenceId: string;
  readonly processReceiptId: string;
  readonly groupDeathEvidenceId: string;
}

export interface DurableSalvageCaptureResult {
  readonly outcome: DurableSalvageDisposition | "capture_failed";
  readonly receipt: SalvageDispositionReceipt | null;
  readonly artifactPath: string | null;
  readonly artifactDigest: `sha256:${string}` | null;
  readonly artifactSize: number | null;
  readonly entryCount: number;
  readonly payloadBytes: number;
  readonly replayed: boolean;
  readonly detail: string;
}

export type DurableSalvageCaptureBarrier = "after_artifact_publish_fsync";

/** Test/recovery seam; callbacks are deliberately excluded from artifact bytes. */
export interface DurableSalvageCaptureHooks {
  readonly afterBarrier?: (barrier: DurableSalvageCaptureBarrier) => void;
}

export interface DurableSalvageManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: string;
  readonly classification: "tracked_unchanged" | "tracked_modified" | "untracked";
  readonly contentKind: "none" | "empty" | "text" | "binary" | "symlink";
  readonly size: number;
  readonly contentDigest: `sha256:${string}`;
  readonly contentBase64: string;
  readonly baselineMode: string | null;
  readonly baselineOid: string | null;
}

export interface DurableSalvageManifest {
  readonly schema_version: typeof DURABLE_SALVAGE_SCHEMA_VERSION;
  readonly baseline_oid: string;
  readonly head_oid: string;
  readonly head_symbolic_ref: string | null;
  readonly object_format: "sha1" | "sha256";
  readonly attempt_ref: string;
  readonly attempt_ref_oid: string;
  readonly index_snapshot: {
    readonly size: number;
    readonly digest: `sha256:${string}`;
    readonly content_base64: string;
    readonly tree_oid: string | null;
    readonly changed_entries: readonly {
      readonly path: string;
      readonly mode: string;
      readonly oid: string;
      readonly size: number;
      readonly digest: `sha256:${string}`;
      readonly content_base64: string;
    }[];
  };
  readonly ref_observations: readonly { readonly ref: string; readonly oid: string }[];
  readonly commit_oids: readonly string[];
  readonly commit_bundle: {
    readonly size: number;
    readonly digest: `sha256:${string}`;
    readonly content_base64: string;
  } | null;
  readonly disposition: DurableSalvageDisposition;
  readonly entries: readonly DurableSalvageManifestEntry[];
  readonly deleted_baseline_entries: readonly {
    readonly path: string;
    readonly mode: string;
    readonly oid: string;
  }[];
  readonly limits: typeof DURABLE_SALVAGE_LIMITS;
}

export interface DurableSalvageRestoreResult {
  readonly outcome: "restored" | "restore_failed";
  readonly entryCount: number;
  readonly payloadBytes: number;
  readonly manifest: DurableSalvageManifest | null;
  readonly detail: string;
}

interface RawSalvageEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly content: Buffer;
}

interface BaselineEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeIdentifier(value: string, label: string): void {
  if (value === "" || value !== value.trim() || value.length > 240 || value.includes("\0") || value.includes("\n")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validateCaptureRequest(request: DurableSalvageArchiveRequest): void {
  for (const [label, value] of [
    ["salvage record id", request.salvageRecordId],
    ["attempt id", request.attemptId],
    ["ownership id", request.ownershipId],
    ["context id", request.contextId],
    ["evidence id", request.evidenceId],
    ["process receipt id", request.processReceiptId],
    ["group death evidence id", request.groupDeathEvidenceId],
  ] as const) safeIdentifier(value, label);
  if (!Number.isSafeInteger(request.ownerGeneration) || request.ownerGeneration < 1) {
    throw new TypeError("owner generation must be a positive safe integer");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(request.ownershipContextDigest)) {
    throw new TypeError("ownership context digest is invalid");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.baselineOid)) {
    throw new TypeError("baseline OID is not canonical");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.expectedAttemptRefOid)) {
    throw new TypeError("expected attempt-ref OID is not canonical");
  }
  if (!/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,240}$/.test(request.attemptRef) || request.attemptRef.includes("..") || request.attemptRef.includes("@{")) {
    throw new TypeError("attempt ref is not canonical");
  }
  const refs = request.includeRefs ?? [];
  if (refs.length > DURABLE_SALVAGE_LIMITS.maxRefs || new Set(refs).size !== refs.length) {
    throw new TypeError("salvage ref inventory is duplicate or exceeds its hard bound");
  }
  for (const ref of refs) {
    if (!/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,240}$/.test(ref) || ref.includes("..") || ref.includes("@{")) {
      throw new TypeError(`salvage ref is not canonical: ${ref}`);
    }
  }
}

function sealedGitEnvironment(): NodeJS.ProcessEnv {
  return {
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
  };
}

function salvageGit(
  repo: string,
  args: readonly string[],
  maxBuffer = DURABLE_SALVAGE_LIMITS.maxGitMetadataBytes,
  environment: NodeJS.ProcessEnv = {},
): Buffer {
  return execFileSync(GIT_EXECUTABLE, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    "-c", "core.attributesFile=/dev/null",
    "-C", repo,
    ...args,
  ], {
    encoding: "buffer",
    env: { ...sealedGitEnvironment(), ...environment },
    timeout: 15_000,
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface CapturedIndexSnapshot {
  readonly size: number;
  readonly digest: `sha256:${string}`;
  readonly content_base64: string;
  readonly tree_oid: string | null;
  readonly changed_entries: readonly {
    readonly path: string;
    readonly mode: string;
    readonly oid: string;
    readonly size: number;
    readonly digest: `sha256:${string}`;
    readonly content_base64: string;
  }[];
  readonly payloadBytes: number;
  readonly hasDelta: boolean;
}

function captureIndexSnapshot(repo: string, baselineOid: string, requestedPath?: string): CapturedIndexSnapshot {
  const gitPath = requestedPath ?? salvageGitText(repo, ["rev-parse", "--git-path", "index"]);
  const absolute = resolve(repo, gitPath);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile() || info.size > DURABLE_SALVAGE_LIMITS.maxIndexBytes) {
    throw new Error("salvage index is not a bounded regular file");
  }
  const descriptor = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      throw new Error("salvage index changed identity while opening");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("salvage index changed while being captured");
  } finally {
    closeSync(descriptor);
  }
  const environment = { GIT_INDEX_FILE: absolute };
  const changedRaw = salvageGit(
    repo,
    ["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", baselineOid, "--"],
    DURABLE_SALVAGE_LIMITS.maxGitMetadataBytes,
    environment,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const changedPaths: string[] = [];
  let start = 0;
  for (let index = 0; index <= changedRaw.length; index += 1) {
    if (index !== changedRaw.length && changedRaw[index] !== 0) continue;
    if (index > start) {
      const path = decoder.decode(changedRaw.subarray(start, index));
      canonicalPath(path, "staged index path");
      changedPaths.push(path);
    }
    start = index + 1;
  }
  if (changedPaths.length > DURABLE_SALVAGE_LIMITS.maxEntries) throw new Error("staged index inventory exceeds its hard bound");
  const records = changedPaths.length === 0
    ? Buffer.alloc(0)
    : salvageGit(repo, ["ls-files", "--stage", "-z", "--", ...changedPaths], DURABLE_SALVAGE_LIMITS.maxGitMetadataBytes, environment);
  const entries: Array<CapturedIndexSnapshot["changed_entries"][number]> = [];
  let payloadBytes = bytes.length;
  for (const record of records.toString("binary").split("\0")) {
    if (record === "") continue;
    const raw = Buffer.from(record, "binary");
    const tab = raw.indexOf(0x09);
    if (tab < 0) throw new Error("staged index entry lacks a path separator");
    const [mode, oid, stage] = raw.subarray(0, tab).toString("ascii").split(" ");
    const path = decoder.decode(raw.subarray(tab + 1));
    canonicalPath(path, "staged index entry path");
    if (stage !== "0" || !/^[0-7]{6}$/.test(mode ?? "") || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid ?? "")) {
      throw new Error(`staged index entry is unresolved or invalid: ${path}`);
    }
    const content = salvageGit(repo, ["cat-file", "blob", oid!], DURABLE_SALVAGE_LIMITS.maxFileBytes);
    if (content.length > DURABLE_SALVAGE_LIMITS.maxFileBytes) throw new Error(`staged blob exceeds its hard bound: ${path}`);
    payloadBytes += content.length;
    if (payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage index payload exceeds its total bound");
    entries.push(Object.freeze({
      path, mode: mode!, oid: oid!, size: content.length, digest: sha256(content), content_base64: content.toString("base64"),
    }));
  }
  entries.sort(bytewisePathSort);
  return Object.freeze({
    size: bytes.length,
    digest: sha256(bytes),
    content_base64: bytes.toString("base64"),
    tree_oid: changedPaths.length === 0 ? salvageGitText(repo, ["rev-parse", "--verify", `${baselineOid}^{tree}`]) : null,
    changed_entries: Object.freeze(entries),
    payloadBytes,
    hasDelta: changedPaths.length > 0,
  });
}

function salvageGitText(repo: string, args: readonly string[]): string {
  return salvageGit(repo, args).toString("utf8").trim();
}

function bytewisePathSort(left: { readonly path: string }, right: { readonly path: string }): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function canonicalPath(path: string, label: string): void {
  if (
    path === "" || path.includes("\0") || path.includes("\\") || isAbsolute(path) ||
    path === "." || path === ".." || path.startsWith("../") || path.includes("/../") || path.endsWith("/..") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")
  ) throw new Error(`${label} is not a canonical safe path: ${JSON.stringify(path)}`);
}

interface RawSalvageCapture {
  readonly entries: readonly RawSalvageEntry[];
  readonly observedPaths: readonly string[];
  readonly payloadBytes: number;
}

/**
 * Observe the complete bounded namespace, but materialize bytes only for the
 * delta from the exact baseline. In particular, a large unchanged baseline
 * blob must not consume the failed-work byte budget merely because it exists
 * in the worktree.
 */
function captureRawFilesystem(
  root: string,
  baselineByPath: ReadonlyMap<string, BaselineEntry>,
  baselineDirectories: ReadonlySet<string>,
  changedTrackedPaths: ReadonlySet<string>,
): RawSalvageCapture {
  const entries: RawSalvageEntry[] = [];
  const observedPaths: string[] = [];
  let observedEntryCount = 0;
  let payloadBytes = 0;
  const visit = (directory: string, prefix: string): boolean => {
    const capturedBefore = entries.length;
    const pending: string[] = [];
    const handle = opendirSync(directory, { encoding: "utf8" });
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        const name = entry.name;
        if (name.includes("\uFFFD")) throw new Error("salvage worktree contains a non-UTF-8 path");
        if (prefix === "" && name === ".git") continue;
        if (name === ".git") throw new Error("salvage worktree contains an embedded Git repository");
        if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
          throw new Error("salvage worktree contains a noncanonical entry");
        }
        observedEntryCount += 1;
        if (observedEntryCount > DURABLE_SALVAGE_LIMITS.maxEntries) {
          throw new Error("salvage entry inventory exceeds its hard bound");
        }
        pending.push(name);
      }
    } finally {
      handle.closeSync();
    }
    pending.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    for (const name of pending) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      canonicalPath(path, "salvage entry path");
      observedPaths.push(path);
      const absolute = join(directory, name);
      const before = lstatSync(absolute) as Stats;
      const mode = before.mode & 0o777;
      if (before.isSymbolicLink()) {
        const baselineEntry = baselineByPath.get(path);
        if (baselineEntry?.type === "blob" && !changedTrackedPaths.has(path)) continue;
        const content = readlinkSync(absolute, { encoding: "buffer" });
        const after = lstatSync(absolute);
        if (!after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode) {
          throw new Error(`salvage symlink changed while being captured: ${path}`);
        }
        if (!content.equals(readlinkSync(absolute, { encoding: "buffer" }))) {
          throw new Error(`salvage symlink target changed while being captured: ${path}`);
        }
        if (content.length > DURABLE_SALVAGE_LIMITS.maxFileBytes) throw new Error(`salvage symlink target exceeds its hard bound: ${path}`);
        payloadBytes += content.length;
        if (payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage payload exceeds its hard bound");
        entries.push(Object.freeze({ path, kind: "symlink" as const, mode, content }));
        continue;
      }
      if (before.isDirectory()) {
        const descendantCaptured = visit(absolute, path);
        const baselineEntry = baselineByPath.get(path);
        const untrackedOrTypeChanged = !baselineDirectories.has(path) || baselineEntry !== undefined;
        if (descendantCaptured || untrackedOrTypeChanged) {
          entries.push(Object.freeze({ path, kind: "directory" as const, mode, content: Buffer.alloc(0) }));
        }
        continue;
      }
      if (!before.isFile()) throw new Error(`salvage worktree contains an unsupported special entry: ${path}`);
      const baselineEntry = baselineByPath.get(path);
      if (baselineEntry?.type === "blob" && !changedTrackedPaths.has(path)) continue;
      if (before.size > DURABLE_SALVAGE_LIMITS.maxFileBytes) throw new Error(`salvage file exceeds its hard bound: ${path}`);
      const descriptor = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || !opened.isFile()) {
          throw new Error(`salvage file changed identity while opening: ${path}`);
        }
        const content = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (
          after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
          after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
          content.length !== opened.size
        ) throw new Error(`salvage file changed while being captured: ${path}`);
        payloadBytes += content.length;
        if (payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage payload exceeds its hard bound");
        entries.push(Object.freeze({ path, kind: "file" as const, mode, content }));
      } finally {
        closeSync(descriptor);
      }
    }
    return entries.length > capturedBefore;
  };
  visit(root, "");
  entries.sort(bytewisePathSort);
  observedPaths.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return Object.freeze({ entries: Object.freeze(entries), observedPaths: Object.freeze(observedPaths), payloadBytes });
}

function trackedDeltaPaths(repo: string, baselineOid: string): ReadonlySet<string> {
  const raw = salvageGit(repo, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", baselineOid, "--"]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = new Set<string>();
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0) continue;
    if (index === start) {
      start = index + 1;
      continue;
    }
    const path = decoder.decode(raw.subarray(start, index));
    canonicalPath(path, "tracked delta path");
    paths.add(path);
    if (paths.size > DURABLE_SALVAGE_LIMITS.maxEntries) throw new Error("tracked delta inventory exceeds its hard bound");
    start = index + 1;
  }
  return paths;
}

function parseBaselineTree(repo: string, baselineOid: string): readonly BaselineEntry[] {
  const raw = salvageGit(repo, ["ls-tree", "-r", "-z", "--full-tree", baselineOid]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result: BaselineEntry[] = [];
  for (const record of raw.subarray(0, raw.length > 0 && raw[raw.length - 1] === 0 ? raw.length - 1 : raw.length).toString("binary").split("\0")) {
    if (record === "") continue;
    const bytes = Buffer.from(record, "binary");
    const tab = bytes.indexOf(0x09);
    if (tab < 0) throw new Error("baseline tree record lacks a path separator");
    const header = bytes.subarray(0, tab).toString("ascii").split(" ");
    if (header.length !== 3) throw new Error("baseline tree record has an invalid header");
    const path = decoder.decode(bytes.subarray(tab + 1));
    canonicalPath(path, "baseline tree path");
    const [mode, type, oid] = header;
    if (!/^[0-7]{6}$/.test(mode!) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid!)) {
      throw new Error("baseline tree record has invalid mode or OID");
    }
    result.push(Object.freeze({ path, mode: mode!, type: type!, oid: oid! }));
    if (result.length > DURABLE_SALVAGE_LIMITS.maxEntries) throw new Error("baseline tree exceeds the salvage entry bound");
  }
  result.sort(bytewisePathSort);
  return Object.freeze(result);
}

function contentKind(kind: RawSalvageEntry["kind"], content: Buffer): DurableSalvageManifestEntry["contentKind"] {
  if (kind === "directory") return "none";
  if (kind === "symlink") return "symlink";
  if (content.length === 0) return "empty";
  if (content.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return "text";
  } catch {
    return "binary";
  }
}

function rawInventoryDigest(entries: readonly RawSalvageEntry[]): `sha256:${string}` {
  return sha256(canonicalJson(entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    size: entry.content.length,
    content_digest: sha256(entry.content),
  }))));
}

function refSnapshot(repo: string, refs: readonly string[]): readonly { readonly ref: string; readonly oid: string }[] {
  const rows = [
    { ref: "HEAD", oid: salvageGitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"]) },
    ...refs.map((ref) => ({ ref, oid: salvageGitText(repo, ["rev-parse", "--verify", `${ref}^{commit}`]) })),
  ];
  for (const row of rows) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.oid)) throw new Error(`salvage ref ${row.ref} is not a commit OID`);
  }
  return Object.freeze(rows.map((row) => Object.freeze({ ref: row.ref, oid: row.oid })));
}

function safeAbsoluteDirectory(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`salvage archive path is not a safe directory: ${cursor}`);
  }
  const info = lstatSync(absolute);
  if (
    info.isSymbolicLink() || !info.isDirectory() || realpathSync.native(absolute) !== absolute ||
    (typeof process.geteuid === "function" && info.uid !== process.geteuid()) || (info.mode & 0o777) !== 0o700
  ) throw new Error("salvage archive root must be an owned canonical 0700 directory");
  return absolute;
}

function contained(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith(`..${sep}`) && fromParent !== ".." && !isAbsolute(fromParent));
}

function canonicalProspectivePath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("salvage archive path has no existing ancestor");
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const info = lstatSync(cursor);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`salvage archive path is not a safe directory: ${cursor}`);
  }
  return join(realpathSync.native(cursor), ...missing);
}

function readExactArtifact(path: string, expectedDigest: `sha256:${string}`): Buffer {
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() || !info.isFile() || info.size > DURABLE_SALVAGE_LIMITS.maxArtifactBytes ||
    (info.mode & 0o777) !== 0o600 ||
    (typeof process.geteuid === "function" && info.uid !== process.geteuid())
  ) {
    throw new Error("salvage artifact is not a bounded regular file");
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== bytes.length || after.dev !== info.dev || after.ino !== info.ino || sha256(bytes) !== expectedDigest) {
      throw new Error("salvage artifact identity or digest differs from its receipt");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function persistContentAddressedArtifact(
  worktree: string,
  archiveRootInput: string,
  bytes: Buffer,
  hooks: DurableSalvageCaptureHooks,
): { readonly path: string; readonly digest: `sha256:${string}`; readonly replayed: boolean } {
  const worktreeReal = realpathSync.native(worktree);
  const archiveResolved = canonicalProspectivePath(archiveRootInput);
  if (contained(worktreeReal, archiveResolved) || contained(archiveResolved, worktreeReal)) {
    throw new Error("salvage archive root must be external to and disjoint from the attempt worktree");
  }
  const archiveRoot = safeAbsoluteDirectory(archiveResolved);
  const archiveReal = realpathSync.native(archiveRoot);
  if (contained(worktreeReal, archiveReal) || contained(archiveReal, worktreeReal)) {
    throw new Error("salvage archive root must be external to and disjoint from the attempt worktree");
  }
  const digest = sha256(bytes);
  const finalPath = join(archiveReal, `${digest.slice("sha256:".length)}.salvage.json`);
  if (existsSync(finalPath)) {
    const existing = readExactArtifact(finalPath, digest);
    if (!existing.equals(bytes)) throw new Error("content-addressed salvage artifact has different bytes");
    return Object.freeze({ path: finalPath, digest, replayed: true });
  }
  const temporaryPath = join(archiveReal, `.${digest.slice(7)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporaryPath, finalPath);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      const existing = readExactArtifact(finalPath, digest);
      if (!existing.equals(bytes)) throw new Error("raced salvage artifact has different bytes");
    }
    unlinkSync(temporaryPath);
    chmodSync(finalPath, 0o600);
    fsyncDirectory(archiveReal);
    readExactArtifact(finalPath, digest);
    hooks.afterBarrier?.("after_artifact_publish_fsync");
    return Object.freeze({ path: finalPath, digest, replayed: false });
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* best-effort removal of an unpublished temporary */ }
    throw error;
  }
}

function makeReceipt(
  request: DurableSalvageArchiveRequest,
  disposition: DurableSalvageDisposition,
  artifact: { readonly path: string; readonly digest: `sha256:${string}`; readonly size: number } | null,
  indexDigest: `sha256:${string}`,
): SalvageDispositionReceipt {
  if ((disposition === "empty") !== (artifact === null)) throw new Error("salvage receipt artifact shape differs from its disposition");
  return new SalvageDispositionReceipt(SALVAGE_RECEIPT_AUTHORITY, {
    salvageRecordId: request.salvageRecordId,
    attemptId: request.attemptId,
    ownershipId: request.ownershipId,
    ownerGeneration: request.ownerGeneration,
    ownershipContextDigest: request.ownershipContextDigest,
    contextId: request.contextId,
    disposition,
    artifactPath: artifact?.path ?? null,
    artifactDigest: artifact?.digest ?? null,
    artifactSize: artifact?.size ?? null,
    evidenceId: request.evidenceId,
    processReceiptId: request.processReceiptId,
    groupDeathEvidenceId: request.groupDeathEvidenceId,
    baselineOid: request.baselineOid,
    attemptRef: request.attemptRef,
    expectedAttemptRefOid: request.expectedAttemptRefOid,
    indexDigest,
    createdAt: new Date().toISOString(),
  });
}

export function captureDurableSalvageArchive(
  workingDir: string,
  request: DurableSalvageArchiveRequest,
  hooks: DurableSalvageCaptureHooks = {},
): DurableSalvageCaptureResult {
  try {
    validateCaptureRequest(request);
    const worktreeInput = resolve(workingDir);
    const inputInfo = lstatSync(worktreeInput);
    if (inputInfo.isSymbolicLink() || !inputInfo.isDirectory()) throw new Error("salvage worktree is not a safe directory");
    const worktree = realpathSync.native(worktreeInput);
    const worktreeInfo = lstatSync(worktree);
    if (
      worktreeInfo.isSymbolicLink() || !worktreeInfo.isDirectory() ||
      inputInfo.dev !== worktreeInfo.dev || inputInfo.ino !== worktreeInfo.ino
    ) throw new Error("salvage worktree is not canonical");
    const baselineObserved = salvageGitText(worktree, ["rev-parse", "--verify", `${request.baselineOid}^{commit}`]);
    if (baselineObserved !== request.baselineOid) throw new Error("salvage baseline OID does not resolve exactly");
    const objectFormat = salvageGitText(worktree, ["rev-parse", "--show-object-format"]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("salvage repository object format is unsupported");
    const symbolicHead = (() => {
      try { return salvageGitText(worktree, ["symbolic-ref", "-q", "HEAD"]); } catch { return null; }
    })();
    const baseline = parseBaselineTree(worktree, request.baselineOid);
    const baselineByPath = new Map(baseline.map((entry) => [entry.path, entry]));
    const baselineDirectories = new Set<string>();
    for (const entry of baseline) {
      const parts = entry.path.split("/");
      for (let index = 1; index < parts.length; index += 1) baselineDirectories.add(parts.slice(0, index).join("/"));
    }
    const refs = [...new Set([request.attemptRef, ...(request.includeRefs ?? [])])]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const refsBefore = refSnapshot(worktree, refs);
    const attemptRefBefore = refsBefore.find((row) => row.ref === request.attemptRef);
    if (attemptRefBefore?.oid !== request.expectedAttemptRefOid) {
      throw new Error("salvage attempt ref differs from its exact expected postimage");
    }
    const indexBefore = captureIndexSnapshot(worktree, request.baselineOid, request.indexPath);
    const changedBefore = trackedDeltaPaths(worktree, request.baselineOid);
    const first = captureRawFilesystem(worktree, baselineByPath, baselineDirectories, changedBefore);
    const changedMiddle = trackedDeltaPaths(worktree, request.baselineOid);
    const second = captureRawFilesystem(worktree, baselineByPath, baselineDirectories, changedMiddle);
    const changedAfter = trackedDeltaPaths(worktree, request.baselineOid);
    const indexAfter = captureIndexSnapshot(worktree, request.baselineOid, request.indexPath);
    if (
      canonicalJson([...changedBefore].sort()) !== canonicalJson([...changedMiddle].sort()) ||
      canonicalJson([...changedMiddle].sort()) !== canonicalJson([...changedAfter].sort()) ||
      rawInventoryDigest(first.entries) !== rawInventoryDigest(second.entries) ||
      canonicalJson(first.observedPaths) !== canonicalJson(second.observedPaths) ||
      first.payloadBytes !== second.payloadBytes
      || canonicalJson(indexAfter) !== canonicalJson(indexBefore)
    ) {
      throw new Error("salvage worktree changed while being captured");
    }
    const currentPaths = new Set(first.observedPaths);
    const manifestEntries = first.entries.map((entry): DurableSalvageManifestEntry => {
      const baselineEntry = baselineByPath.get(entry.path);
      const classification = baselineEntry !== undefined || baselineDirectories.has(entry.path)
        ? "tracked_modified" as const
        : "untracked" as const;
      return Object.freeze({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode.toString(8).padStart(3, "0"),
        classification,
        contentKind: contentKind(entry.kind, entry.content),
        size: entry.content.length,
        contentDigest: sha256(entry.content),
        contentBase64: entry.content.toString("base64"),
        baselineMode: baselineEntry?.mode ?? null,
        baselineOid: baselineEntry?.oid ?? null,
      });
    });
    const deleted = baseline
      .filter((entry) => !currentPaths.has(entry.path))
      .map((entry) => Object.freeze({ path: entry.path, mode: entry.mode, oid: entry.oid }));
    if (manifestEntries.length + deleted.length > DURABLE_SALVAGE_LIMITS.maxEntries) {
      throw new Error("salvage delta inventory exceeds its hard bound");
    }
    const changedRefs = refsBefore.filter((row) => row.oid !== request.baselineOid);
    let bundle: Buffer | null = null;
    let commitOids: readonly string[] = Object.freeze([]);
    if (changedRefs.length > 0) {
      const sources = changedRefs.map((row) => row.ref);
      bundle = salvageGit(
        worktree,
        ["bundle", "create", "-", ...sources, `^${request.baselineOid}`],
        DURABLE_SALVAGE_LIMITS.maxBundleBytes,
      );
      if (bundle.length === 0 || bundle.length > DURABLE_SALVAGE_LIMITS.maxBundleBytes) throw new Error("salvage commit bundle is empty or exceeds its bound");
      const revList = salvageGitText(worktree, ["rev-list", "--topo-order", "--reverse", ...sources, `^${request.baselineOid}`]);
      commitOids = Object.freeze(revList === "" ? [] : revList.split("\n"));
      if (commitOids.length > DURABLE_SALVAGE_LIMITS.maxEntries || commitOids.some((oid) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))) {
        throw new Error("salvage commit inventory is invalid or exceeds its bound");
      }
    }
    const refsAfter = refSnapshot(worktree, refs);
    if (canonicalJson(refsAfter) !== canonicalJson(refsBefore)) throw new Error("salvage refs changed while being captured");
    const symbolicHeadAfter = (() => {
      try { return salvageGitText(worktree, ["symbolic-ref", "-q", "HEAD"]); } catch { return null; }
    })();
    if (symbolicHeadAfter !== symbolicHead) throw new Error("salvage symbolic HEAD changed while being captured");
    const hasDelta = manifestEntries.length > 0 || deleted.length > 0 || changedRefs.length > 0 || indexBefore.hasDelta;
    if (!hasDelta) {
      const receipt = makeReceipt(request, "empty", null, indexBefore.digest);
      return Object.freeze({
        outcome: "empty", receipt, artifactPath: null, artifactDigest: null, artifactSize: null,
        entryCount: manifestEntries.length, payloadBytes: first.payloadBytes, replayed: false,
        detail: "positive bounded observation proved no failed work relative to the exact baseline",
      });
    }
    const bundleBytes = bundle?.length ?? 0;
    if (first.payloadBytes + bundleBytes + indexBefore.payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage archive payload exceeds its total bound");
    const manifest: DurableSalvageManifest = Object.freeze({
      schema_version: DURABLE_SALVAGE_SCHEMA_VERSION,
      baseline_oid: request.baselineOid,
      head_oid: refsBefore[0]!.oid,
      head_symbolic_ref: symbolicHead,
      object_format: objectFormat,
      attempt_ref: request.attemptRef,
      attempt_ref_oid: request.expectedAttemptRefOid,
      index_snapshot: Object.freeze({
        size: indexBefore.size,
        digest: indexBefore.digest,
        content_base64: indexBefore.content_base64,
        tree_oid: indexBefore.tree_oid,
        changed_entries: indexBefore.changed_entries,
      }),
      ref_observations: refsBefore,
      commit_oids: commitOids,
      commit_bundle: bundle === null ? null : Object.freeze({ size: bundle.length, digest: sha256(bundle), content_base64: bundle.toString("base64") }),
      disposition: "captured",
      entries: Object.freeze(manifestEntries),
      deleted_baseline_entries: Object.freeze(deleted),
      limits: DURABLE_SALVAGE_LIMITS,
    });
    const artifactBytes = Buffer.from(canonicalJson(manifest), "utf8");
    if (artifactBytes.length > DURABLE_SALVAGE_LIMITS.maxArtifactBytes) throw new Error("salvage artifact exceeds its serialized bound");
    const persisted = persistContentAddressedArtifact(worktree, request.archiveRoot, artifactBytes, hooks);
    const receipt = makeReceipt(request, "captured", { path: persisted.path, digest: persisted.digest, size: artifactBytes.length }, indexBefore.digest);
    return Object.freeze({
      outcome: "captured", receipt, artifactPath: persisted.path, artifactDigest: persisted.digest,
      artifactSize: artifactBytes.length, entryCount: manifestEntries.length,
      payloadBytes: first.payloadBytes + bundleBytes + indexBefore.payloadBytes, replayed: persisted.replayed,
      detail: persisted.replayed ? "exact durable salvage artifact replayed" : "durable salvage artifact atomically finalized",
    });
  } catch (error) {
    return Object.freeze({
      outcome: "capture_failed", receipt: null, artifactPath: null, artifactDigest: null, artifactSize: null,
      entryCount: 0, payloadBytes: 0, replayed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseAndValidateManifest(bytes: Buffer): { readonly manifest: DurableSalvageManifest; readonly payloadBytes: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error("salvage artifact is not valid JSON", { cause: error }); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("salvage manifest is not an object");
  if (canonicalJson(parsed) !== bytes.toString("utf8")) throw new Error("salvage manifest is not canonical JSON");
  const manifest = parsed as DurableSalvageManifest;
  if (
    manifest.schema_version !== DURABLE_SALVAGE_SCHEMA_VERSION || manifest.disposition !== "captured" ||
    (manifest.object_format !== "sha1" && manifest.object_format !== "sha256") ||
    manifest.index_snapshot === null || typeof manifest.index_snapshot !== "object" ||
    !Array.isArray(manifest.entries) || !Array.isArray(manifest.deleted_baseline_entries) || !Array.isArray(manifest.ref_observations) ||
    !Array.isArray(manifest.commit_oids) || canonicalJson(manifest.limits) !== canonicalJson(DURABLE_SALVAGE_LIMITS)
  ) throw new Error("salvage manifest envelope is invalid");
  const oidPattern = manifest.object_format === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (
    typeof manifest.baseline_oid !== "string" || !oidPattern.test(manifest.baseline_oid) ||
    typeof manifest.head_oid !== "string" || !oidPattern.test(manifest.head_oid) ||
    typeof manifest.attempt_ref !== "string" || !/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,240}$/.test(manifest.attempt_ref) ||
    typeof manifest.attempt_ref_oid !== "string" || !oidPattern.test(manifest.attempt_ref_oid) ||
    (manifest.head_symbolic_ref !== null && (
      typeof manifest.head_symbolic_ref !== "string" ||
      !/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,240}$/.test(manifest.head_symbolic_ref)
    )) ||
    manifest.ref_observations.length < 1 || manifest.ref_observations.length > DURABLE_SALVAGE_LIMITS.maxRefs + 1 ||
    manifest.commit_oids.length > DURABLE_SALVAGE_LIMITS.maxEntries ||
    manifest.entries.length + manifest.deleted_baseline_entries.length > DURABLE_SALVAGE_LIMITS.maxEntries
  ) throw new Error("salvage manifest identity or inventory is invalid");
  let payloadBytes = 0;
  const index = manifest.index_snapshot;
  if (
    !Number.isSafeInteger(index.size) || index.size < 0 || index.size > DURABLE_SALVAGE_LIMITS.maxIndexBytes ||
    typeof index.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(index.digest) ||
    typeof index.content_base64 !== "string" ||
    (index.tree_oid !== null && (typeof index.tree_oid !== "string" || !oidPattern.test(index.tree_oid))) ||
    !Array.isArray(index.changed_entries) || index.changed_entries.length > DURABLE_SALVAGE_LIMITS.maxEntries
  ) throw new Error("salvage index snapshot envelope is invalid");
  const indexBytes = Buffer.from(index.content_base64, "base64");
  if (indexBytes.toString("base64") !== index.content_base64 || indexBytes.length !== index.size || sha256(indexBytes) !== index.digest) {
    throw new Error("salvage index snapshot is corrupt");
  }
  payloadBytes += indexBytes.length;
  const seenIndexPaths = new Set<string>();
  for (const entry of index.changed_entries) {
    if (
      entry === null || typeof entry !== "object" || typeof entry.path !== "string" ||
      typeof entry.mode !== "string" || !/^[0-7]{6}$/.test(entry.mode) ||
      typeof entry.oid !== "string" || !oidPattern.test(entry.oid) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > DURABLE_SALVAGE_LIMITS.maxFileBytes ||
      typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.digest) ||
      typeof entry.content_base64 !== "string"
    ) throw new Error("salvage staged index entry is invalid");
    canonicalPath(entry.path, "salvage staged index entry path");
    if (seenIndexPaths.has(entry.path)) throw new Error("salvage staged index contains duplicate paths");
    seenIndexPaths.add(entry.path);
    const content = Buffer.from(entry.content_base64, "base64");
    if (content.toString("base64") !== entry.content_base64 || content.length !== entry.size || sha256(content) !== entry.digest) {
      throw new Error(`salvage staged index entry is corrupt: ${entry.path}`);
    }
    payloadBytes += content.length;
  }
  if (payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage index restore payload exceeds its bound");
  if (!manifest.ref_observations.some((row) => row.ref === manifest.attempt_ref && row.oid === manifest.attempt_ref_oid)) {
    throw new Error("salvage attempt ref observation is missing or inconsistent");
  }
  const seenRefs = new Set<string>();
  for (const [index, observation] of manifest.ref_observations.entries()) {
    if (
      observation === null || typeof observation !== "object" || typeof observation.ref !== "string" ||
      typeof observation.oid !== "string" || !oidPattern.test(observation.oid) ||
      (index === 0 ? observation.ref !== "HEAD" || observation.oid !== manifest.head_oid :
        !/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,240}$/.test(observation.ref)) ||
      seenRefs.has(observation.ref)
    ) throw new Error("salvage manifest ref observation is invalid");
    seenRefs.add(observation.ref);
  }
  if (new Set(manifest.commit_oids).size !== manifest.commit_oids.length || manifest.commit_oids.some((oid) => typeof oid !== "string" || !oidPattern.test(oid))) {
    throw new Error("salvage manifest commit inventory is invalid");
  }
  const seen = new Set<string>();
  const kinds = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry === null || typeof entry !== "object") throw new Error("salvage manifest entry is invalid");
    if (
      typeof entry.path !== "string" || typeof entry.mode !== "string" || !/^[0-7]{3}$/.test(entry.mode) ||
      !["directory", "file", "symlink"].includes(entry.kind) ||
      !["tracked_modified", "untracked"].includes(entry.classification) ||
      typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      typeof entry.contentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.contentDigest) ||
      typeof entry.contentBase64 !== "string" ||
      (entry.baselineMode !== null && (typeof entry.baselineMode !== "string" || !/^[0-7]{6}$/.test(entry.baselineMode))) ||
      (entry.baselineOid !== null && (typeof entry.baselineOid !== "string" || !oidPattern.test(entry.baselineOid)))
    ) {
      throw new Error(`salvage manifest entry has invalid type or mode: ${entry.path}`);
    }
    canonicalPath(entry.path, "salvage manifest entry path");
    if (seen.has(entry.path)) throw new Error("salvage manifest contains duplicate paths");
    seen.add(entry.path);
    if ((entry.baselineMode === null) !== (entry.baselineOid === null) ||
      (entry.classification === "untracked" && entry.baselineMode !== null)) {
      throw new Error(`salvage manifest entry baseline metadata is inconsistent: ${entry.path}`);
    }
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.toString("base64") !== entry.contentBase64 || content.length !== entry.size || sha256(content) !== entry.contentDigest) {
      throw new Error(`salvage manifest entry content is corrupt: ${entry.path}`);
    }
    if (entry.contentKind !== contentKind(entry.kind, content)) {
      throw new Error(`salvage manifest content kind is invalid: ${entry.path}`);
    }
    if (entry.kind === "symlink" && content.length === 0) throw new Error(`salvage symlink target is empty: ${entry.path}`);
    if (entry.kind !== "directory" && content.length > DURABLE_SALVAGE_LIMITS.maxFileBytes) throw new Error(`salvage file exceeds restore bound: ${entry.path}`);
    payloadBytes += content.length;
    if (payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage restore payload exceeds its bound");
    kinds.set(entry.path, entry.kind);
  }
  for (const path of seen) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      if (kinds.get(components.slice(0, index).join("/")) !== "directory") {
        throw new Error(`salvage manifest path lacks an explicit directory parent: ${path}`);
      }
    }
  }
  const deleted = new Set<string>();
  for (const entry of manifest.deleted_baseline_entries) {
    if (
      entry === null || typeof entry !== "object" || typeof entry.path !== "string" ||
      typeof entry.mode !== "string" || !/^[0-7]{6}$/.test(entry.mode) ||
      typeof entry.oid !== "string" || !oidPattern.test(entry.oid)
    ) throw new Error("salvage deleted-baseline entry is invalid");
    canonicalPath(entry.path, "deleted baseline path");
    if (deleted.has(entry.path) || seen.has(entry.path)) throw new Error("salvage manifest contains duplicate or conflicting deleted paths");
    deleted.add(entry.path);
  }
  if (manifest.commit_bundle !== null) {
    if (
      typeof manifest.commit_bundle !== "object" ||
      typeof manifest.commit_bundle.content_base64 !== "string" ||
      typeof manifest.commit_bundle.size !== "number" || !Number.isSafeInteger(manifest.commit_bundle.size) ||
      typeof manifest.commit_bundle.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(manifest.commit_bundle.digest)
    ) throw new Error("salvage commit bundle envelope is invalid");
    const bundle = Buffer.from(manifest.commit_bundle.content_base64, "base64");
    if (
      bundle.toString("base64") !== manifest.commit_bundle.content_base64 || bundle.length !== manifest.commit_bundle.size ||
      bundle.length > DURABLE_SALVAGE_LIMITS.maxBundleBytes || sha256(bundle) !== manifest.commit_bundle.digest
    ) throw new Error("salvage commit bundle is corrupt");
    payloadBytes += bundle.length;
    if (payloadBytes > DURABLE_SALVAGE_LIMITS.maxTotalBytes) throw new Error("salvage restore payload exceeds its bound");
  }
  if ((manifest.commit_bundle === null) !== (manifest.commit_oids.length === 0)) {
    throw new Error("salvage commit bundle differs from its commit inventory");
  }
  return Object.freeze({ manifest, payloadBytes });
}

export function restoreDurableSalvageArchive(
  artifactPath: string,
  expectedArtifactDigest: `sha256:${string}`,
  destination: string,
): DurableSalvageRestoreResult {
  try {
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedArtifactDigest)) throw new TypeError("expected salvage digest is invalid");
    const artifact = resolve(artifactPath);
    const bytes = readExactArtifact(artifact, expectedArtifactDigest);
    const { manifest, payloadBytes } = parseAndValidateManifest(bytes);
    const destinationInput = resolve(destination);
    const info = lstatSync(destinationInput);
    const destinationAbsolute = realpathSync.native(destinationInput);
    const canonicalInfo = lstatSync(destinationAbsolute);
    if (
      info.isSymbolicLink() || !info.isDirectory() || canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory() ||
      info.dev !== canonicalInfo.dev || info.ino !== canonicalInfo.ino ||
      (typeof process.geteuid === "function" && canonicalInfo.uid !== process.geteuid())
    ) throw new Error("salvage restore destination is not canonical and owned");
    const handle = opendirSync(destinationAbsolute);
    try {
      if (handle.readSync() !== null) throw new Error("salvage restore destination is not empty");
    } finally {
      handle.closeSync();
    }
    const decoded = new Map(manifest.entries.map((entry) => [entry.path, Buffer.from(entry.contentBase64, "base64")]));
    const directories = manifest.entries.filter((entry) => entry.kind === "directory").sort((left, right) => left.path.split("/").length - right.path.split("/").length || bytewisePathSort(left, right));
    for (const entry of directories) mkdirSync(join(destinationAbsolute, ...entry.path.split("/")), { mode: 0o700 });
    for (const entry of manifest.entries) {
      if (entry.kind === "directory") continue;
      const target = join(destinationAbsolute, ...entry.path.split("/"));
      const fromDestination = relative(destinationAbsolute, target);
      if (fromDestination.startsWith(`..${sep}`) || fromDestination === ".." || isAbsolute(fromDestination) || existsSync(target)) {
        throw new Error(`salvage restore path collides or escapes: ${entry.path}`);
      }
      const content = decoded.get(entry.path)!;
      if (entry.kind === "symlink") {
        symlinkSync(content, target);
      } else {
        const descriptor = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, Number.parseInt(entry.mode, 8));
        try {
          let offset = 0;
          while (offset < content.length) offset += writeSync(descriptor, content, offset, content.length - offset, offset);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        chmodSync(target, Number.parseInt(entry.mode, 8));
      }
    }
    for (const entry of [...directories].reverse()) chmodSync(join(destinationAbsolute, ...entry.path.split("/")), Number.parseInt(entry.mode, 8));
    fsyncDirectory(destinationAbsolute);
    return Object.freeze({ outcome: "restored", entryCount: manifest.entries.length, payloadBytes, manifest, detail: "salvage artifact restored after full digest validation" });
  } catch (error) {
    return Object.freeze({ outcome: "restore_failed", entryCount: 0, payloadBytes: 0, manifest: null, detail: error instanceof Error ? error.message : String(error) });
  }
}
