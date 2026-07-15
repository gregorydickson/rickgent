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

export type ProvisionRunWorkspaceResult =
  | { readonly ok: true; readonly workspace: ReadyRunWorkspace }
  | {
      readonly ok: false;
      readonly code: string;
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

function refExists(repo: string, ref: string): boolean {
  try {
    gitText(repo, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function cleanupAfterAllocation(
  callerRepo: string,
  worktreeDir: string | null,
  runRef: string | null,
  baselineSha: string | null,
): RunWorkspaceCleanupEvidence {
  const errors: string[] = [];
  if (worktreeDir !== null && existsSync(worktreeDir)) {
    try {
      execFileSync("git", ["-C", callerRepo, "worktree", "remove", "--force", worktreeDir], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      errors.push(`worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (runRef !== null && baselineSha !== null && refExists(callerRepo, runRef)) {
    try {
      execFileSync("git", ["-C", callerRepo, "update-ref", "-d", runRef, baselineSha], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      errors.push(`run ref cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const worktreeAbsent = worktreeDir === null || !existsSync(worktreeDir);
  const refAbsent = runRef === null || !refExists(callerRepo, runRef);
  return Object.freeze({
    disposition: "removed" as const,
    worktreeAbsent,
    refAbsent,
    errors: Object.freeze(errors),
  });
}

function noAllocationCleanup(): RunWorkspaceCleanupEvidence {
  return Object.freeze({
    disposition: "not_created" as const,
    worktreeAbsent: true,
    refAbsent: true,
    errors: Object.freeze([]),
  });
}

function fail(code: string, detail: string): ProvisionRunWorkspaceResult {
  return { ok: false, code, detail, cleanup: noAllocationCleanup() };
}

function safeRunId(runId: string): string {
  const normalized = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "run";
}

export function provisionRunWorkspace(
  options: ProvisionRunWorkspaceOptions,
): ProvisionRunWorkspaceResult {
  let callerRepo: string;
  try {
    callerRepo = realpathSync(options.targetRepo);
    if (!lstatSync(callerRepo).isDirectory()) return fail("RUN_WORKSPACE_INVALID_REPOSITORY", "target is not a directory");
    const topLevel = realpathSync(gitText(callerRepo, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== callerRepo) {
      return fail("RUN_WORKSPACE_NOT_ROOT", "target must be the Git worktree root");
    }
  } catch (error) {
    return fail(
      "RUN_WORKSPACE_INVALID_REPOSITORY",
      `target repository is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const root of options.externalRoots ?? []) {
    const canonical = resolveEvenIfMissing(root);
    if (pathInside(callerRepo, canonical)) {
      return fail("RUN_WORKSPACE_STATE_INSIDE_CALLER", `state/materialization root is inside caller checkout: ${root}`);
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
      return fail("RUN_WORKSPACE_DIRTY_BASELINE", "caller baseline has staged, unstaged, or untracked changes");
    }
    const marker = IN_PROGRESS_MARKERS.find(
      (name) => existsSync(join(callerGitDir, name)) || existsSync(join(commonGitDir, name)),
    );
    if (marker) return fail("RUN_WORKSPACE_GIT_OPERATION", `Git operation is in progress: ${marker}`);
  } catch (error) {
    return fail(
      "RUN_WORKSPACE_INVALID_BASELINE",
      `baseline cannot be proven: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const generatedRef = `${RUN_REF_PREFIX}${safeRunId(options.runId)}-${randomUUID()}`;
  const runRef = options.requestedRunRef ?? generatedRef;
  const branchName = runRef.startsWith("refs/heads/") ? runRef.slice("refs/heads/".length) : runRef;
  if (!runRef.startsWith(RUN_REF_PREFIX) || PROTECTED_BRANCH.test(branchName)) {
    return fail("RUN_WORKSPACE_PROTECTED_REF", `run ref is outside the dedicated namespace or protected: ${runRef}`);
  }
  try {
    gitText(callerRepo, ["check-ref-format", runRef]);
  } catch {
    return fail("RUN_WORKSPACE_INVALID_REF", `invalid run ref: ${runRef}`);
  }
  if (refExists(callerRepo, runRef)) {
    return fail("RUN_WORKSPACE_REF_COLLISION", `run ref already exists: ${runRef}`);
  }

  let allocationRoot: string | null = null;
  let worktreeDir: string | null = null;
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
      allocationRoot,
      callerBefore,
    });
    const callerCheck = callerRepositoryUnchanged(workspace);
    if (!callerCheck.unchanged) throw new Error(callerCheck.detail);
    return { ok: true, workspace };
  } catch (error) {
    const cleanup = cleanupAfterAllocation(
      callerRepo,
      worktreeDir,
      refCreated ? runRef : null,
      refCreated ? baselineSha : null,
    );
    if (allocationRoot !== null && existsSync(allocationRoot)) {
      try {
        rmSync(allocationRoot, { recursive: true, force: true });
      } catch {
        // The worktree/ref observations above remain the cleanup authority.
      }
    }
    return {
      ok: false,
      code: "RUN_WORKSPACE_ALLOCATION_FAILED",
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
    return Object.freeze({
      disposition: "retained" as const,
      worktreeAbsent: !existsSync(workspace.worktreeDir),
      refAbsent: !refExists(workspace.callerRepo, workspace.runRef),
      errors: Object.freeze([]),
    });
  }
  const cleanup = cleanupAfterAllocation(
    workspace.callerRepo,
    workspace.worktreeDir,
    workspace.runRef,
    workspace.baselineSha,
  );
  try {
    rmSync(workspace.allocationRoot, { recursive: true, force: true });
  } catch {
    // cleanupAfterAllocation already captured authoritative ref/worktree state.
  }
  return cleanup;
}
