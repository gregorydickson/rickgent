// Reconcile — rebuilds registry from git + dispatch ledger truth.
// AC-4: crash recovery via dual-source truth reconciliation.
//
// B6: the ledger is a single shared schema. reconcile consumes exactly the
// camelCase fields DispatchLedger.append writes (trace identity parsed from the
// `dispatchId` string, plus commitSha/baselineSha/declaredPaths/state) via the
// canonical dispatchLedgerPath — never a snake_case shape the writer never emits
// and never a hardcoded filename that can diverge from the Dispatcher. Every git
// invocation is execFileSync array-argv (invariant-9). A ledger entry that
// claims `completed` is never trusted as a bare completion claim: its commit is
// re-validated through the single completion oracle before the ticket is Done.

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dispatchLedgerPath } from "../dispatch/dispatch.js";
import { evaluateCompletion, type CompletionInput } from "../core/completion.js";
import type { PipelineStatus, TicketState } from "./registry.js";

export interface ReconcileResult {
  ok: boolean;
  rebuilt: boolean;
  ticketsFound: number;
  errors: string[];
  registry: PipelineStatus;
}

function gitTry(workingDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

function commitExists(workingDir: string, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: workingDir,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// git-tree-truth: did the tree at `commitSha` actually differ from the baseline
// (or, absent a baseline, from its parent)? A root commit differs from the empty
// tree. Unreadable/unknown → false (fail closed, not Done).
function treeChangedSince(workingDir: string, baselineSha: string, commitSha: string): boolean {
  if (baselineSha) {
    const out = gitTry(workingDir, ["diff", "--name-only", baselineSha, commitSha]);
    return out !== null && out.length > 0;
  }
  const parent = gitTry(workingDir, ["rev-parse", `${commitSha}^`]);
  if (parent) {
    const out = gitTry(workingDir, ["diff", "--name-only", parent, commitSha]);
    return out !== null && out.length > 0;
  }
  return true;
}

// Re-validate a ledger commit through the single completion oracle. Reconcile
// must never manufacture Done from `state === "completed"` alone (B6).
function commitIsComplete(workingDir: string, commitSha: string | null, baselineSha: string): boolean {
  if (!commitSha) return false;
  const input: CompletionInput = {
    claimedSha: commitSha,
    baselineSha,
    shaExists: commitExists(workingDir, commitSha),
    treeChanged: treeChangedSince(workingDir, baselineSha, commitSha),
    gateGreen: null,
  };
  return evaluateCompletion(input, "reconcile.completion").verdict === "COMMITTED";
}

interface TraceIdentity {
  runId: string;
  ticketId: string;
  phase: string;
  attempt: number;
  role: string;
}

// Parse trace identity from the ledger's `dispatchId` string
// (`runId/ticketId/phase/attempt/role`). No parseable ticketId → null.
function parseDispatchId(dispatchId: string): TraceIdentity | null {
  const parts = dispatchId.split("/");
  if (parts.length < 5) return null;
  const ticketId = parts[1];
  if (!ticketId) return null;
  const attempt = parseInt(parts[3] ?? "", 10);
  return {
    runId: parts[0] ?? "",
    ticketId,
    phase: parts[2] ?? "",
    attempt: Number.isNaN(attempt) ? 1 : attempt,
    role: parts[4] ?? "",
  };
}

export function reconcile(
  workingDir: string,
  rickgentDir: string,
  ledgerPath: string = dispatchLedgerPath(rickgentDir),
): ReconcileResult {
  const errors: string[] = [];
  const tickets: Record<string, TicketState> = {};

  // 1. Read git truth — find commits with rickgent trace in commit messages.
  const log = gitTry(workingDir, ["log", "--oneline", "--all"]);
  if (log === null) {
    errors.push("git log failed");
  } else {
    const commits = log.split("\n").filter(Boolean);
    for (const line of commits) {
      const match = line.match(/^([a-f0-9]+)\s(.*)$/);
      if (match && match[2]) {
        const ticketMatch = match[2].match(/ticket[:\s]+([A-Za-z0-9_-]+)/i);
        if (ticketMatch && ticketMatch[1]) {
          const ticketId = ticketMatch[1];
          if (!tickets[ticketId]) {
            tickets[ticketId] = {
              id: ticketId,
              title: match[2],
              status: "Done",
              phase: "simplify",
              declaredPaths: [],
              attempt: 1,
              completionCommitSha: match[1] ?? null,
              updatedAt: new Date().toISOString(),
            };
          }
        }
      }
    }
  }

  // 2. Read the dispatch ledger — the SAME shared schema the Dispatcher writes.
  if (existsSync(ledgerPath)) {
    try {
      const ledger = readFileSync(ledgerPath, "utf-8");
      for (const line of ledger.trim().split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const dispatchId = entry["dispatchId"];
          if (typeof dispatchId !== "string") continue; // not the shared schema → skip
          if (entry["state"] !== "completed") continue;
          const trace = parseDispatchId(dispatchId);
          if (!trace || tickets[trace.ticketId]) continue; // git truth precedence

          const commitSha = typeof entry["commitSha"] === "string" ? entry["commitSha"] : null;
          const baselineSha = typeof entry["baselineSha"] === "string" ? entry["baselineSha"] : "";
          const declaredPaths = Array.isArray(entry["declaredPaths"])
            ? (entry["declaredPaths"] as unknown[]).filter((p): p is string => typeof p === "string")
            : [];

          // Oracle validation gates Done — a completed claim whose commit does
          // not verify is recovered as In Progress (unfinished work to re-run).
          const done = commitIsComplete(workingDir, commitSha, baselineSha);

          tickets[trace.ticketId] = {
            id: trace.ticketId,
            title: typeof entry["title"] === "string" ? entry["title"] : trace.ticketId,
            status: done ? "Done" : "In Progress",
            phase: trace.phase || "simplify",
            declaredPaths,
            attempt: trace.attempt,
            completionCommitSha: done ? commitSha : null,
            updatedAt: new Date().toISOString(),
          };
        } catch {
          // Skip malformed ledger entries
        }
      }
    } catch (err) {
      errors.push(`ledger read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const registry: PipelineStatus = {
    runId: "reconciled",
    tickets,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: errors.length === 0,
    rebuilt: Object.keys(tickets).length > 0,
    ticketsFound: Object.keys(tickets).length,
    errors,
    registry,
  };
}
