// Evidence-based dispatch completion (B2).
//
// A dispatch reaches `completed` ONLY when all four evidence conditions hold
// AND the completion oracle passes (architecture §3.3, §8.2 — git-tree-truth >
// exit code > logs > claims):
//   (a) db_session_observed — a conversations row created by THIS dispatch,
//   (b) non-empty transcript — conversation_items for that conversation,
//   (c) an in-scope git delta measured against the pre-dispatch baseline,
//   (d) evaluateCompletion returns COMMITTED, invoked with a valid caller.
// Exit code 0 alone is never completion. Every failure fails closed.

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { isPathInScope } from "../core/scope.js";
import { evaluateCompletion, type CompletionInput } from "../core/completion.js";

export interface GitBaseline {
  /** HEAD sha at dispatch start; null if the repo has no commits / is unreadable. */
  headSha: string | null;
}

function revParseHead(repoDir: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Capture the pre-dispatch git baseline. Delta is later measured against this. */
export function captureGitBaseline(repoDir: string): GitBaseline {
  return { headSha: revParseHead(repoDir) };
}

export interface GitDelta {
  claimedSha: string | null;
  baselineSha: string;
  shaExists: boolean;
  treeChanged: boolean;
  /** Changed paths (from commits after the baseline) that fall inside declared scope. */
  inScopePaths: string[];
}

/**
 * Measure the git delta produced by a dispatch, relative to the baseline HEAD
 * captured at dispatch start. Only changes landed as commits after the baseline
 * count — a working tree that was already dirty BEFORE dispatch (same HEAD) is
 * not a delta (VAL-DISPATCH-009). The reported paths are filtered to declared
 * scope through the single canonical matcher `isPathInScope`.
 */
export function measureGitDelta(
  repoDir: string,
  baseline: GitBaseline,
  declaredPaths: string[],
): GitDelta {
  const baselineSha = baseline.headSha ?? "";
  const currentSha = revParseHead(repoDir);

  // No readable HEAD, or no new commit since the baseline → no delta.
  if (!currentSha || currentSha === baselineSha) {
    return { claimedSha: null, baselineSha, shaExists: false, treeChanged: false, inScopePaths: [] };
  }

  let changed: string[] = [];
  try {
    const out = baselineSha
      ? execFileSync("git", ["-C", repoDir, "diff", "--name-only", baselineSha, currentSha], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      : execFileSync("git", ["-C", repoDir, "show", "--name-only", "--pretty=format:", currentSha], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
    changed = out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  } catch {
    changed = [];
  }

  return {
    claimedSha: currentSha,
    baselineSha,
    shaExists: true,
    treeChanged: changed.length > 0,
    inScopePaths: filterInScope(changed, declaredPaths),
  };
}

function filterInScope(paths: string[], declaredPaths: string[]): string[] {
  const decls = Array.isArray(declaredPaths)
    ? declaredPaths.filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];
  if (decls.length === 0) return [];
  return paths.filter((p) => decls.some((d) => isPathInScope(p, d)));
}

function chatDbPath(dataDir: string): string {
  return join(dataDir, "chat.db");
}

/**
 * Per-dispatch OMNIGENT_DATA_DIR isolation. Each dispatch gets its own chat.db
 * under a subdir keyed by its unique dispatchId, so a `conversations` row this
 * dispatch's worker creates cannot be confused with one a CONCURRENT foreign
 * dispatch writes to the shared store. Without this, the pre-dispatch baseline
 * snapshot only excludes conversations that existed BEFORE spawn — a foreign
 * dispatch that writes DURING the run would be wrongly attributed here
 * (VAL-DISPATCH-008, concurrent-foreign case). Isolation makes attribution
 * provable: the only sessions in this dir are the ones this dispatch created.
 */
export function isolatedDataDir(rootDataDir: string, dispatchId: string): string {
  const safe = dispatchId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(rootDataDir, ".rickgent-dispatch", safe);
}

interface ConversationRow {
  id: string;
  createdAt: number;
}

function readConversations(dataDir: string): ConversationRow[] {
  const p = chatDbPath(dataDir);
  if (!existsSync(p)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    const rows = db.prepare("SELECT id, created_at FROM conversations").all() as Array<{
      id: unknown;
      created_at: unknown;
    }>;
    return rows.map((r) => ({ id: String(r.id), createdAt: Number(r.created_at) || 0 }));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Snapshot the conversation ids present BEFORE dispatch, so a session created
 *  by THIS dispatch can be distinguished from a pre-existing/foreign one. */
export function captureConversationIds(dataDir: string): Set<string> {
  return new Set(readConversations(dataDir).map((r) => r.id));
}

function countTranscript(dataDir: string, conversationId: string): number {
  const p = chatDbPath(dataDir);
  if (!existsSync(p)) return 0;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE conversation_id = ?")
      .get(conversationId) as { n: unknown } | undefined;
    return Number(row?.n) || 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export interface DbObservation {
  /** The conversation created by this dispatch, or null if none was created. */
  conversationId: string | null;
  transcriptCount: number;
}

/**
 * Observe a DB session created by THIS dispatch: a `conversations` row absent
 * from the pre-dispatch baseline. A stale/foreign conversation that already
 * existed does not count (VAL-DISPATCH-008).
 */
export function observeDbSession(dataDir: string, baselineConvIds: Set<string>): DbObservation {
  const created = readConversations(dataDir).filter((r) => !baselineConvIds.has(r.id));
  // Attribute to the newest conversation created during the run.
  created.sort((a, b) => b.createdAt - a.createdAt);
  const newest = created[0];
  if (!newest) return { conversationId: null, transcriptCount: 0 };
  return { conversationId: newest.id, transcriptCount: countTranscript(dataDir, newest.id) };
}

export interface CompletionEvidenceContext {
  repoDir: string;
  dataDir: string;
  baseline: GitBaseline;
  baselineConvIds: Set<string>;
  declaredPaths: string[];
}

export interface CompletionEvidence {
  dbObserved: boolean;
  conversationId: string | null;
  transcriptCount: number;
  inScopePaths: string[];
  oraclePass: boolean;
  oracleVerdict: string;
  /** Commit sha the delta landed on (persisted to the ledger for reconcile). */
  commitSha: string | null;
  /** Baseline HEAD sha the delta was measured against. */
  baselineSha: string;
  /** Whether the tree changed relative to the baseline. */
  treeChanged: boolean;
  /** True iff ALL four evidence conditions hold and the oracle passed. */
  completed: boolean;
}

/**
 * Gather all completion evidence for a dispatch and decide, fail-closed,
 * whether it may be marked `completed`. The completion oracle is the single
 * predicate; it is invoked here with the allowlisted `dispatch.completion`
 * caller.
 */
export function gatherCompletionEvidence(ctx: CompletionEvidenceContext): CompletionEvidence {
  const observation = observeDbSession(ctx.dataDir, ctx.baselineConvIds);
  const dbObserved = observation.conversationId !== null;
  const transcriptNonEmpty = observation.transcriptCount > 0;

  const delta = measureGitDelta(ctx.repoDir, ctx.baseline, ctx.declaredPaths);
  const inScope = delta.inScopePaths.length > 0;

  const input: CompletionInput = {
    claimedSha: delta.claimedSha,
    baselineSha: delta.baselineSha,
    shaExists: delta.shaExists,
    treeChanged: delta.treeChanged,
    gateGreen: null,
  };
  const verdict = evaluateCompletion(input, "dispatch.completion");
  const oraclePass = verdict.verdict === "COMMITTED";

  return {
    dbObserved,
    conversationId: observation.conversationId,
    transcriptCount: observation.transcriptCount,
    inScopePaths: delta.inScopePaths,
    oraclePass,
    oracleVerdict: verdict.verdict,
    commitSha: delta.claimedSha,
    baselineSha: delta.baselineSha,
    treeChanged: delta.treeChanged,
    completed: dbObserved && transcriptNonEmpty && inScope && oraclePass,
  };
}
