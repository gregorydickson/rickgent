import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

export interface CallerRepositorySnapshot {
  readonly headSha: string;
  readonly symbolicRef: string;
  readonly indexSha256: string;
  readonly statusSha256: string;
}

export interface RunWorkspaceCleanupEvidence {
  readonly disposition: "not_created" | "removed" | "retained";
  readonly worktreeAbsent: boolean;
  readonly worktreeRegistrationAbsent: boolean;
  readonly refAbsent: boolean;
  readonly errors: readonly string[];
}

export interface ReadyRunWorkspace {
  readonly kind: "ready_run_workspace";
  readonly callerRepo: string;
  readonly commonGitDir: string;
  readonly callerGitDir: string;
  readonly deliveryRef: string;
  readonly baselineSha: string;
  readonly runRef: string;
  readonly worktreeDir: string;
  readonly worktreeGitDir: string;
  readonly allocationRoot: string;
  readonly callerBefore: CallerRepositorySnapshot;
}

export interface ProvisionRunWorkspaceOptions {
  readonly targetRepo: string;
  readonly runId: string;
  /** State and materialization roots must not be inside the caller checkout. */
  readonly externalRoots?: readonly string[];
  /** Test seam for proving protected/colliding ref rejection. */
  readonly requestedRunRef?: string;
}

export type ProvisionRunWorkspaceFailureCode =
  | "RUN_WORKSPACE_INVALID_REPOSITORY"
  | "RUN_WORKSPACE_NOT_ROOT"
  | "RUN_WORKSPACE_STATE_INSIDE_CALLER"
  | "RUN_WORKSPACE_DIRTY_BASELINE"
  | "RUN_WORKSPACE_GIT_OPERATION"
  | "RUN_WORKSPACE_INVALID_BASELINE"
  | "RUN_WORKSPACE_PROTECTED_REF"
  | "RUN_WORKSPACE_INVALID_REF"
  | "RUN_WORKSPACE_REF_COLLISION"
  | "RUN_WORKSPACE_ALLOCATION_FAILED";

export type ProvisionRunWorkspaceResult =
  | { readonly ok: true; readonly workspace: ReadyRunWorkspace }
  | {
      readonly ok: false;
      readonly code: ProvisionRunWorkspaceFailureCode;
      readonly failureClass: "input_contract" | "infrastructure";
      readonly detail: string;
      readonly cleanup: RunWorkspaceCleanupEvidence;
    };

export type RunWorkspaceSpawnReadiness =
  | {
      readonly ready: true;
      readonly code: "ready";
      readonly detail: string;
    }
  | {
      readonly ready: false;
      readonly code: "dirty" | "identity_changed" | "caller_changed" | "unavailable";
      readonly detail: string;
    };

const PROTECTED_BRANCH = /^(?:main|master|trunk|develop|dev|release(?:\/|$))/;
const RUN_REF_PREFIX = "refs/heads/rickgent/runs/";
const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
] as const;

function gitText(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitBuffer(repo: string, args: readonly string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveEvenIfMissing(path: string): string {
  let cursor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return resolve(base, ...tail);
}

function indexPath(repo: string): string {
  const path = gitText(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error("Git index is unavailable");
  }
  return path;
}

export function snapshotCallerRepository(repo: string): CallerRepositorySnapshot {
  const headSha = gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const symbolicRef = gitText(repo, ["symbolic-ref", "-q", "HEAD"]);
  const indexSha256 = sha256(readFileSync(indexPath(repo)));
  const statusSha256 = sha256(gitBuffer(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  return Object.freeze({ headSha, symbolicRef, indexSha256, statusSha256 });
}

export function callerRepositoryUnchanged(
  workspace: ReadyRunWorkspace,
): { readonly unchanged: boolean; readonly after: CallerRepositorySnapshot | null; readonly detail: string } {
  try {
    const after = snapshotCallerRepository(workspace.callerRepo);
    const unchanged = JSON.stringify(after) === JSON.stringify(workspace.callerBefore);
    return {
      unchanged,
      after,
      detail: unchanged ? "caller repository unchanged" : "caller repository identity/index/status changed",
    };
  } catch (error) {
    return {
      unchanged: false,
      after: null,
      detail: `caller repository could not be re-observed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Re-prove every immutable/clean allocation invariant immediately before spawn. */
export function runWorkspaceReadyForSpawn(
  workspace: ReadyRunWorkspace,
): RunWorkspaceSpawnReadiness {
  try {
    const head = gitText(workspace.worktreeDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const symbolicRef = gitText(workspace.worktreeDir, ["symbolic-ref", "-q", "HEAD"]);
    const commonGitDir = realpathSync(
      gitText(workspace.worktreeDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const status = gitBuffer(
      workspace.worktreeDir,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    );
    const deliveryHead = gitText(workspace.callerRepo, ["rev-parse", `${workspace.deliveryRef}^{commit}`]);
    const runRefHead = gitText(workspace.callerRepo, ["rev-parse", `${workspace.runRef}^{commit}`]);
    if (
      head !== workspace.baselineSha ||
      deliveryHead !== workspace.baselineSha ||
      runRefHead !== workspace.baselineSha ||
      symbolicRef !== workspace.runRef ||
      commonGitDir !== workspace.commonGitDir
    ) {
      return {
        ready: false,
        code: "identity_changed",
        detail: "run workspace identity or immutable baseline changed before spawn",
      };
    }
    const caller = callerRepositoryUnchanged(workspace);
    if (!caller.unchanged) {
      return { ready: false, code: "caller_changed", detail: caller.detail };
    }
    if (status.length !== 0) {
      return {
        ready: false,
        code: "dirty",
        detail: "run workspace contains an uncommitted prior-worker delta; another worker cannot spawn",
      };
    }
    return {
      ready: true,
      code: "ready",
      detail: "run workspace and caller baseline reverified before spawn",
    };
  } catch (error) {
    return {
      ready: false,
      code: "unavailable",
      detail: `run workspace could not be reverified before spawn: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type RefObservation =
  | { readonly status: "present" | "absent" }
  | { readonly status: "unknown"; readonly detail: string };

type PathObservation =
  | { readonly status: "present" | "absent" }
  | { readonly status: "unknown"; readonly detail: string };

function commandExitStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function commandStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf-8");
  return typeof stderr === "string" ? stderr : "";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isNotRepositoryError(error: unknown): boolean {
  return commandStderr(error).toLowerCase().includes("not a git repository");
}

function isUnbornHeadError(error: unknown): boolean {
  const detail = `${errorDetail(error)} ${commandStderr(error)}`.toLowerCase();
  return detail.includes("needed a single revision") ||
    detail.includes("unknown revision") ||
    detail.includes("ambiguous argument 'head") ||
    detail.includes("bad revision 'head");
}

function observeRef(repo: string, ref: string): RefObservation {
  try {
    gitText(repo, ["show-ref", "--verify", "--quiet", ref]);
    return { status: "present" };
  } catch (error) {
    if (commandExitStatus(error) === 1) return { status: "absent" };
    return {
      status: "unknown",
      detail: `run ref observation failed: ${errorDetail(error)}`,
    };
  }
}

function observePath(path: string): PathObservation {
  try {
    lstatSync(path);
    return { status: "present" };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent" };
    return {
      status: "unknown",
      detail: `worktree path observation failed: ${errorDetail(error)}`,
    };
  }
}

function observeWorktreeRegistration(gitDir: string): PathObservation {
  try {
    lstatSync(gitDir);
    return { status: "present" };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent" };
    return {
      status: "unknown",
      detail: `worktree registration observation failed: ${errorDetail(error)}`,
    };
  }
}

function appendCleanupError(
  cleanup: RunWorkspaceCleanupEvidence,
  detail: string,
): RunWorkspaceCleanupEvidence {
  return Object.freeze({
    disposition: "retained" as const,
    worktreeAbsent: cleanup.worktreeAbsent,
    worktreeRegistrationAbsent: cleanup.worktreeRegistrationAbsent,
    refAbsent: cleanup.refAbsent,
    errors: Object.freeze([...cleanup.errors, detail]),
  });
}

function cleanupAfterAllocation(
  callerRepo: string,
  worktreeDir: string | null,
  worktreeGitDir: string | null,
  worktreeRegistrationExpected: boolean,
  runRef: string | null,
  baselineSha: string | null,
): RunWorkspaceCleanupEvidence {
  const errors: string[] = [];
  const worktreeBefore = worktreeDir === null
    ? { status: "absent" as const }
    : observePath(worktreeDir);
  const registrationBefore = worktreeGitDir === null
    ? worktreeRegistrationExpected
      ? {
          status: "unknown" as const,
          detail: "worktree registration identity was not captured after allocation",
        }
      : { status: "absent" as const }
    : observeWorktreeRegistration(worktreeGitDir);
  if (worktreeBefore.status === "unknown") errors.push(worktreeBefore.detail);
  if (registrationBefore.status === "unknown") errors.push(registrationBefore.detail);
  // Git can still remove its administrative registration after the worktree
  // directory itself has vanished. Never infer registration cleanup from the
  // filesystem path alone.
  if (
    worktreeDir !== null &&
    (worktreeBefore.status !== "absent" || registrationBefore.status !== "absent")
  ) {
    try {
      execFileSync("git", ["-C", callerRepo, "worktree", "remove", "--force", worktreeDir], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      errors.push(`worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (runRef !== null && baselineSha !== null) {
    const before = observeRef(callerRepo, runRef);
    if (before.status === "present") {
      try {
        execFileSync("git", ["-C", callerRepo, "update-ref", "-d", runRef, baselineSha], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        errors.push(`run ref cleanup failed: ${errorDetail(error)}`);
      }
    } else if (before.status === "unknown") {
      errors.push(before.detail);
    }
  }
  const worktreeAfter = worktreeDir === null
    ? { status: "absent" as const }
    : observePath(worktreeDir);
  if (worktreeAfter.status === "unknown") {
    errors.push(`post-cleanup ${worktreeAfter.detail}`);
  }
  const worktreeAbsent = worktreeAfter.status === "absent";
  const registrationAfter = worktreeGitDir === null
    ? worktreeRegistrationExpected
      ? {
          status: "unknown" as const,
          detail: "worktree registration identity remains unavailable after cleanup",
        }
      : { status: "absent" as const }
    : observeWorktreeRegistration(worktreeGitDir);
  if (registrationAfter.status === "unknown") {
    errors.push(`post-cleanup ${registrationAfter.detail}`);
  }
  const worktreeRegistrationAbsent = registrationAfter.status === "absent";
  const after = runRef === null ? { status: "absent" as const } : observeRef(callerRepo, runRef);
  if (after.status === "unknown") errors.push(`post-cleanup ${after.detail}`);
  const refAbsent = after.status === "absent";
  return Object.freeze({
    disposition:
      errors.length === 0 && worktreeAbsent && worktreeRegistrationAbsent && refAbsent
        ? "removed" as const
        : "retained" as const,
    worktreeAbsent,
    worktreeRegistrationAbsent,
    refAbsent,
    errors: Object.freeze(errors),
  });
}

function noAllocationCleanup(): RunWorkspaceCleanupEvidence {
  return Object.freeze({
    disposition: "not_created" as const,
    worktreeAbsent: true,
    worktreeRegistrationAbsent: true,
    refAbsent: true,
    errors: Object.freeze([]),
  });
}

function fail(
  code: ProvisionRunWorkspaceFailureCode,
  failureClass: "input_contract" | "infrastructure",
  detail: string,
): ProvisionRunWorkspaceResult {
  return { ok: false, code, failureClass, detail, cleanup: noAllocationCleanup() };
}

function safeRunId(runId: string): string {
  const normalized = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "run";
}

export function provisionRunWorkspace(
  options: ProvisionRunWorkspaceOptions,
): ProvisionRunWorkspaceResult {
  try {
    lstatSync(options.targetRepo);
  } catch (error) {
    const code = errorCode(error);
    return fail(
      "RUN_WORKSPACE_INVALID_REPOSITORY",
      code === "ENOENT" || code === "ENOTDIR" ? "input_contract" : "infrastructure",
      `target cannot be observed: ${errorDetail(error)}`,
    );
  }
  let callerRepo: string;
  try {
    callerRepo = realpathSync(options.targetRepo);
    if (!lstatSync(callerRepo).isDirectory()) {
      return fail("RUN_WORKSPACE_INVALID_REPOSITORY", "input_contract", "target is not a directory");
    }
    const topLevel = realpathSync(gitText(callerRepo, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== callerRepo) {
      return fail("RUN_WORKSPACE_NOT_ROOT", "input_contract", "target must be the Git worktree root");
    }
  } catch (error) {
    const failureClass = isNotRepositoryError(error) ? "input_contract" : "infrastructure";
    return fail(
      "RUN_WORKSPACE_INVALID_REPOSITORY",
      failureClass,
      `target repository is unavailable: ${errorDetail(error)}`,
    );
  }

  for (const root of options.externalRoots ?? []) {
    let canonical: string;
    try {
      canonical = resolveEvenIfMissing(root);
    } catch (error) {
      return fail(
        "RUN_WORKSPACE_INVALID_REPOSITORY",
        "infrastructure",
        `state/materialization root cannot be resolved: ${errorDetail(error)}`,
      );
    }
    if (pathInside(callerRepo, canonical)) {
      return fail(
        "RUN_WORKSPACE_STATE_INSIDE_CALLER",
        "input_contract",
        `state/materialization root is inside caller checkout: ${root}`,
      );
    }
  }

  let commonGitDir: string;
  let callerGitDir: string;
  let callerBefore: CallerRepositorySnapshot;
  let deliveryRef: string;
  let baselineSha: string;
  try {
    commonGitDir = realpathSync(gitText(callerRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    callerGitDir = realpathSync(gitText(callerRepo, ["rev-parse", "--path-format=absolute", "--git-dir"]));
    callerBefore = snapshotCallerRepository(callerRepo);
    deliveryRef = callerBefore.symbolicRef;
    baselineSha = callerBefore.headSha;
    if (gitBuffer(callerRepo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length !== 0) {
      return fail(
        "RUN_WORKSPACE_DIRTY_BASELINE",
        "input_contract",
        "caller baseline has staged, unstaged, or untracked changes",
      );
    }
    const marker = IN_PROGRESS_MARKERS.find(
      (name) => existsSync(join(callerGitDir, name)) || existsSync(join(commonGitDir, name)),
    );
    if (marker) {
      return fail("RUN_WORKSPACE_GIT_OPERATION", "input_contract", `Git operation is in progress: ${marker}`);
    }
  } catch (error) {
    return fail(
      "RUN_WORKSPACE_INVALID_BASELINE",
      isUnbornHeadError(error) ? "input_contract" : "infrastructure",
      `baseline cannot be proven: ${errorDetail(error)}`,
    );
  }

  const generatedRef = `${RUN_REF_PREFIX}${safeRunId(options.runId)}-${randomUUID()}`;
  const runRef = options.requestedRunRef ?? generatedRef;
  const branchName = runRef.startsWith("refs/heads/") ? runRef.slice("refs/heads/".length) : runRef;
  if (!runRef.startsWith(RUN_REF_PREFIX) || PROTECTED_BRANCH.test(branchName)) {
    return fail(
      "RUN_WORKSPACE_PROTECTED_REF",
      "input_contract",
      `run ref is outside the dedicated namespace or protected: ${runRef}`,
    );
  }
  try {
    gitText(callerRepo, ["check-ref-format", runRef]);
  } catch (error) {
    return fail(
      "RUN_WORKSPACE_INVALID_REF",
      commandExitStatus(error) === 1 ? "input_contract" : "infrastructure",
      `invalid run ref: ${runRef}`,
    );
  }
  const existingRunRef = observeRef(callerRepo, runRef);
  if (existingRunRef.status === "unknown") {
    return fail("RUN_WORKSPACE_REF_COLLISION", "infrastructure", existingRunRef.detail);
  }
  if (existingRunRef.status === "present") {
    return fail("RUN_WORKSPACE_REF_COLLISION", "input_contract", `run ref already exists: ${runRef}`);
  }

  let allocationRoot: string | null = null;
  let worktreeDir: string | null = null;
  let worktreeGitDir: string | null = null;
  let worktreeRegistrationExpected = false;
  let refCreated = false;
  try {
    allocationRoot = mkdtempSync(join(tmpdir(), "rickgent-run-workspace-"));
    worktreeDir = join(allocationRoot, "worktree");
    execFileSync("git", ["-C", callerRepo, "update-ref", runRef, baselineSha, "0".repeat(40)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    refCreated = true;
    execFileSync("git", ["-C", callerRepo, "worktree", "add", "--quiet", worktreeDir, branchName], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    worktreeRegistrationExpected = true;
    worktreeGitDir = realpathSync(
      gitText(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    );

    const worktreeHead = gitText(worktreeDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const worktreeRef = gitText(worktreeDir, ["symbolic-ref", "-q", "HEAD"]);
    const worktreeCommon = realpathSync(gitText(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const worktreeStatus = gitBuffer(worktreeDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (
      worktreeHead !== baselineSha ||
      worktreeRef !== runRef ||
      worktreeCommon !== commonGitDir ||
      worktreeStatus.length !== 0
    ) {
      throw new Error("created worktree failed identity or cleanliness verification");
    }
    if (gitText(callerRepo, ["rev-parse", `${deliveryRef}^{commit}`]) !== baselineSha) {
      throw new Error("delivery ref moved during allocation");
    }

    const workspace: ReadyRunWorkspace = Object.freeze({
      kind: "ready_run_workspace" as const,
      callerRepo,
      commonGitDir,
      callerGitDir,
      deliveryRef,
      baselineSha,
      runRef,
      worktreeDir,
      worktreeGitDir,
      allocationRoot,
      callerBefore,
    });
    const callerCheck = callerRepositoryUnchanged(workspace);
    if (!callerCheck.unchanged) throw new Error(callerCheck.detail);
    return { ok: true, workspace };
  } catch (error) {
    let cleanup = cleanupAfterAllocation(
      callerRepo,
      worktreeDir,
      worktreeGitDir,
      worktreeRegistrationExpected,
      refCreated ? runRef : null,
      refCreated ? baselineSha : null,
    );
    if (cleanup.worktreeAbsent && allocationRoot !== null) {
      try {
        rmSync(allocationRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanup = appendCleanupError(
          cleanup,
          `allocation root cleanup failed: ${errorDetail(cleanupError)}`,
        );
      }
    }
    return {
      ok: false,
      code: "RUN_WORKSPACE_ALLOCATION_FAILED",
      failureClass: "infrastructure",
      detail: `run workspace allocation failed: ${error instanceof Error ? error.message : String(error)}`,
      cleanup,
    };
  }
}

export function finalizeRunWorkspace(
  workspace: ReadyRunWorkspace,
  retain: boolean,
): RunWorkspaceCleanupEvidence {
  if (retain) {
    const ref = observeRef(workspace.callerRepo, workspace.runRef);
    const worktree = observePath(workspace.worktreeDir);
    const registration = observeWorktreeRegistration(workspace.worktreeGitDir);
    const errors = [
      ...(worktree.status === "unknown" ? [worktree.detail] : []),
      ...(registration.status === "unknown" ? [registration.detail] : []),
      ...(ref.status === "unknown" ? [ref.detail] : []),
    ];
    return Object.freeze({
      disposition: "retained" as const,
      worktreeAbsent: worktree.status === "absent",
      worktreeRegistrationAbsent: registration.status === "absent",
      refAbsent: ref.status === "absent",
      errors: Object.freeze(errors),
    });
  }
  let cleanup = cleanupAfterAllocation(
    workspace.callerRepo,
    workspace.worktreeDir,
    workspace.worktreeGitDir,
    true,
    workspace.runRef,
    workspace.baselineSha,
  );
  if (cleanup.worktreeAbsent) {
    try {
      rmSync(workspace.allocationRoot, { recursive: true, force: true });
    } catch (error) {
      cleanup = appendCleanupError(
        cleanup,
        `allocation root cleanup failed: ${errorDetail(error)}`,
      );
    }
  }
  return cleanup;
}
