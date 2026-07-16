import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "fs";
import { join } from "path";
import { isPathInScope } from "../core/scope.js";
import type { DispatchId } from "../dispatch/dispatch.js";
import type { MaterializedWorkerBundle } from "../dispatch/worker-materialization.js";
import type { ReadyRunWorkspace } from "./run-workspace.js";

export interface CapturedPathObservation {
  readonly path: string;
  readonly status: string;
  readonly kind: "file" | "symlink" | "deleted" | "other";
  readonly contentSha256: string | null;
}

export interface ImplementationCapturedReceipt {
  readonly kind: "implementation_captured_nonterminal";
  readonly dispatch: Readonly<DispatchId>;
  readonly callerRepository: string;
  readonly workspace: string;
  readonly deliveryRef: string;
  readonly runRef: string;
  readonly baselineSha: string;
  readonly materializedWorkerBundle: string;
  readonly materializedConfigSha256: string;
  readonly contextPath: string;
  readonly contextSha256: string;
  readonly requestedBundleSha256: string;
  readonly requestedConfigSha256: string;
  readonly invokedBundleSha256: string;
  readonly invokedConfigSha256: string;
  readonly changedPaths: readonly CapturedPathObservation[];
  readonly conversationId: string | null;
  readonly transcriptCount: number;
  readonly capturedAt: string;
}

export type CaptureMutationResult =
  | { readonly ok: true; readonly receipt: ImplementationCapturedReceipt }
  | { readonly ok: false; readonly detail: string };

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

interface StatusObservation {
  readonly status: string;
  readonly path: string;
  readonly sourcePath: string | null;
}

function parsePorcelain(raw: Buffer): StatusObservation[] {
  const fields = raw.toString("utf-8").split("\0");
  const observations: StatusObservation[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") throw new Error("malformed Git status observation");
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) throw new Error("Git status observation has an empty path");
    let sourcePath: string | null = null;
    if (status.includes("R") || status.includes("C")) {
      sourcePath = fields[++index] ?? null;
      if (!sourcePath) throw new Error("Git rename/copy observation has an empty source path");
    }
    observations.push({ status, path, sourcePath });
  }
  return observations;
}

function observePath(worktree: string, status: string, path: string): CapturedPathObservation {
  const absolute = join(worktree, path);
  if (!existsSync(absolute)) {
    return Object.freeze({ path, status, kind: "deleted" as const, contentSha256: null });
  }
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) {
    return Object.freeze({
      path,
      status,
      kind: "symlink" as const,
      contentSha256: createHash("sha256").update(readlinkSync(absolute)).digest("hex"),
    });
  }
  if (info.isFile()) {
    return Object.freeze({
      path,
      status,
      kind: "file" as const,
      contentSha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    });
  }
  return Object.freeze({ path, status, kind: "other" as const, contentSha256: null });
}

export function captureNonterminalMutation(
  id: DispatchId,
  workspace: ReadyRunWorkspace,
  bundle: MaterializedWorkerBundle,
  declaredPaths: readonly string[],
  conversation: { readonly conversationId: string | null; readonly transcriptCount: number },
): CaptureMutationResult {
  try {
    const head = gitText(workspace.worktreeDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const runRefHead = gitText(workspace.worktreeDir, ["rev-parse", `${workspace.runRef}^{commit}`]);
    if (head !== workspace.baselineSha || runRefHead !== workspace.baselineSha) {
      return { ok: false, detail: "worker Git mutation moved HEAD or the dedicated run ref" };
    }
    if (gitBuffer(workspace.worktreeDir, ["diff", "--cached", "--binary", "--no-ext-diff"]).length !== 0) {
      return { ok: false, detail: "worker Git mutation staged changes in the isolated index" };
    }
    const status = parsePorcelain(
      gitBuffer(workspace.worktreeDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    );
    if (status.length === 0) return { ok: false, detail: "worker exited zero without a captured implementation delta" };
    const scope = declaredPaths.filter((path) => typeof path === "string" && path.length > 0);
    if (
      scope.length === 0 ||
      status.some((entry) =>
        !scope.some((declared) => isPathInScope(entry.path, declared)) ||
        (entry.sourcePath !== null && !scope.some((declared) => isPathInScope(entry.sourcePath!, declared)))
      )
    ) {
      return { ok: false, detail: "captured implementation delta escaped the normalized ticket scope" };
    }
    const changedPaths = Object.freeze(
      status.map((entry) => observePath(workspace.worktreeDir, entry.status, entry.path)),
    );
    const receipt: ImplementationCapturedReceipt = Object.freeze({
      kind: "implementation_captured_nonterminal" as const,
      dispatch: Object.freeze({ ...id }),
      callerRepository: workspace.callerRepo,
      workspace: workspace.worktreeDir,
      deliveryRef: workspace.deliveryRef,
      runRef: workspace.runRef,
      baselineSha: workspace.baselineSha,
      materializedWorkerBundle: bundle.bundleDir,
      materializedConfigSha256: bundle.configSha256,
      contextPath: bundle.contextPath,
      contextSha256: bundle.contextSha256,
      requestedBundleSha256: bundle.requestedBundleSha256,
      requestedConfigSha256: bundle.requestedConfigSha256,
      invokedBundleSha256: bundle.invokedBundleSha256,
      invokedConfigSha256: bundle.invokedConfigSha256,
      changedPaths,
      conversationId: conversation.conversationId,
      transcriptCount: conversation.transcriptCount,
      capturedAt: new Date().toISOString(),
    });
    return { ok: true, receipt };
  } catch (error) {
    return {
      ok: false,
      detail: `mutation capture could not be proven: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
