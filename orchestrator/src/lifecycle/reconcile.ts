// Reconcile — rebuilds registry from git + dispatch ledger truth.
// AC-4: crash recovery via dual-source truth reconciliation.

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { PipelineStatus, TicketState } from "./registry.js";

export interface ReconcileResult {
  ok: boolean;
  rebuilt: boolean;
  ticketsFound: number;
  errors: string[];
  registry: PipelineStatus;
}

export function reconcile(workingDir: string, rickgentDir: string): ReconcileResult {
  const errors: string[] = [];
  const tickets: Record<string, TicketState> = {};

  // 1. Read git truth — find commits with rickgent trace in notes
  try {
    const log = execSync("git log --oneline --all", { cwd: workingDir, encoding: "utf-8", timeout: 10000 });
    // Parse commits — in a real implementation, we'd read git notes for trace identity
    const commits = log.trim().split("\n").filter(Boolean);
    for (const line of commits) {
      const match = line.match(/^([a-f0-9]+)\s(.*)$/);
      if (match && match[2]) {
        // Look for ticket IDs in commit messages
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
  } catch (err) {
    errors.push(`git log failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Read dispatch ledger if it exists
  const ledgerPath = join(rickgentDir, "dispatch-ledger.jsonl");
  if (existsSync(ledgerPath)) {
    try {
      const ledger = readFileSync(ledgerPath, "utf-8");
      for (const line of ledger.trim().split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const ticketId = entry["ticket_id"];
          if (typeof ticketId === "string" && entry["state"] === "completed" && !tickets[ticketId]) {
            tickets[ticketId] = {
              id: ticketId,
              title: typeof entry["title"] === "string" ? entry["title"] : ticketId,
              status: "Done",
              phase: typeof entry["phase"] === "string" ? entry["phase"] : "simplify",
              declaredPaths: Array.isArray(entry["declared_paths"]) ? (entry["declared_paths"] as string[]) : [],
              attempt: typeof entry["attempt"] === "number" ? entry["attempt"] : 1,
              completionCommitSha: typeof entry["commit_sha"] === "string" ? entry["commit_sha"] : null,
              updatedAt: new Date().toISOString(),
            };
          }
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
