// Evidence-based dispatch observation utilities (B2).
//
// This module provides the pure observation functions used to gather git-delta
// and DB-session evidence for a dispatch.  The terminal completion decision
// itself is handled solely by Oracle v2 (evaluateAttemptOracle in
// state/oracle.ts) via CompletionService (lifecycle/completion-service.ts) —
// the single production completion predicate (t28/t30 VAL-ORC-005).
//
// The legacy gatherCompletionEvidence function that called the core
// evaluateCompletion with a nullable gate flag was a second terminal predicate
// shortcut and has been removed (t30).  The useful pure observation
// functions (captureGitBaseline, measureGitDelta, observeDbSession,
// captureConversationIds, isolatedDataDir) remain for diagnostic and
// evidence-gathering use.

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { isPathInScope } from "../core/scope.js";

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

// (t30) The gatherCompletionEvidence function and CompletionEvidence types
// have been removed.  They provided a second terminal predicate via the core
// evaluateCompletion with a nullable gate flag, bypassing Oracle v2.  The single
// production completion predicate is Oracle v2 (evaluateAttemptOracle) via
// CompletionService.  The pure observation functions above (captureGitBaseline,
// measureGitDelta, observeDbSession, captureConversationIds, isolatedDataDir)
// remain for evidence gathering.
