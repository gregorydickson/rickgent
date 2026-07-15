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
import {
  PRODUCTION_CAPABILITY_GATE,
  type CapabilityGate,
} from "../capabilities/registry.js";

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
  capabilityGate: CapabilityGate = PRODUCTION_CAPABILITY_GATE,
): ReconcileResult {
  capabilityGate.require("reconciliation");
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
  //
  // The ledger is append-only, so the LAST entry for a dispatchId is its current
  // state. Resume must reconstruct the full queue, not just Done: a killed run
  // leaves completed (→ Done), in-flight (spawned/db_session_observed, →
  // In Progress), and still-queued (planned, → Todo) tickets, plus absorbed
  // failures (→ In Progress, unfinished work to continue). All are recovered so
  // no queued or in-progress ticket is silently dropped (B3 / VAL-QUEUE-004).
  if (existsSync(ledgerPath)) {
    try {
      const ledger = readFileSync(ledgerPath, "utf-8");
      const latestByTicket = new Map<string, { entry: Record<string, unknown>; trace: TraceIdentity }>();
      for (const line of ledger.trim().split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const dispatchId = entry["dispatchId"];
          if (typeof dispatchId !== "string") continue; // not the shared schema → skip
          const trace = parseDispatchId(dispatchId);
          if (!trace) continue;
          latestByTicket.set(trace.ticketId, { entry, trace }); // append-only → last wins
        } catch {
          // Skip malformed ledger entries
        }
      }

      for (const [ticketId, { entry, trace }] of latestByTicket) {
        if (tickets[ticketId]) continue; // git truth precedence over the ledger
        const state = typeof entry["state"] === "string" ? entry["state"] : "";
        const commitSha = typeof entry["commitSha"] === "string" ? entry["commitSha"] : null;
        const baselineSha = typeof entry["baselineSha"] === "string" ? entry["baselineSha"] : "";
        const declaredPaths = Array.isArray(entry["declaredPaths"])
          ? (entry["declaredPaths"] as unknown[]).filter((p): p is string => typeof p === "string")
          : [];

        let status: TicketState["status"];
        let completionCommitSha: string | null = null;
        if (state === "completed") {
          // Oracle validation gates Done — a completed claim whose commit does
          // not verify is recovered as In Progress (unfinished work to re-run).
          const done = commitIsComplete(workingDir, commitSha, baselineSha);
          status = done ? "Done" : "In Progress";
          completionCommitSha = done ? commitSha : null;
        } else if (state === "planned") {
          status = "Todo"; // still queued — never spawned before the kill
        } else {
          // spawned / db_session_observed (in-flight) OR an absorbed terminal
          // failure (failed/timed_out/killed/salvaged/retried/ignored_late) —
          // unfinished work the resume continues.
          status = "In Progress";
        }

        tickets[ticketId] = {
          id: ticketId,
          title: typeof entry["title"] === "string" ? entry["title"] : ticketId,
          status,
          phase: trace.phase || "simplify",
          declaredPaths,
          attempt: trace.attempt,
          completionCommitSha,
          updatedAt: new Date().toISOString(),
        };
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
