// ── Deslop gate (szechuan) ──────────────────────────────────────────────────
//
// Post-conformance code quality check: scans the changed files for obvious slop
// patterns (TODO, FIXME, console.log, debugger, etc.). A finding is absorbed
// (salvage disposition recorded), not a human intervention.
//
// Extracted from build.ts so both the build pipeline and the standalone
// `rickgent szechuan` command import the gate from a single source.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { ticketOwnedPaths, type TicketContract } from "../contracts/ticket-contract.js";

export interface DeslopResult {
  filesChecked: number;
  findings: number;
  details: string[];
}

const DESLOP_PATTERNS: RegExp[] = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bHACK\b/i,
  /\bconsole\.log\b/,
  /\bdebugger\b/,
  /\beval\s*\(/,
];

export function runDeslopGate(
  workingDir: string,
  tickets: readonly TicketContract[],
  env: NodeJS.ProcessEnv,
): DeslopResult {
  void env;
  const details: string[] = [];
  let filesChecked = 0;

  // Collect the set of declared paths from all tickets (the in-scope files).
  const paths = new Set<string>();
  for (const ticket of tickets) {
    for (const p of ticketOwnedPaths(ticket)) {
      paths.add(p);
    }
  }

  for (const relPath of paths) {
    const abs = relPath.startsWith("/") ? relPath : join(workingDir, relPath);
    if (!existsSync(abs)) continue;
    filesChecked++;
    try {
      const content = readFileSync(abs, "utf-8");
      for (const pattern of DESLOP_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          details.push(`${relPath}: slop pattern "${match[0]}"`);
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return { filesChecked, findings: details.length, details };
}
