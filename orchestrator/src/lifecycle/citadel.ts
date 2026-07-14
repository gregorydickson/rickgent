// ── Conformance gate (citadel) ──────────────────────────────────────────────
//
// Post-implementation conformance audit: runs each acceptance criterion's
// verifyCommand against the working repo. A failing AC is absorbed (salvage
// disposition recorded), not a human intervention.
//
// Extracted from build.ts so both the build pipeline and the standalone
// `rickgent citadel` command import the gate from a single source.

import { execFileSync } from "child_process";
import type { AcceptanceCriterion } from "../core/prd.js";

export interface ConformanceResult {
  total: number;
  passed: number;
  failed: number;
  results: Array<{ acId: string; pass: boolean; detail: string }>;
}

export function runConformanceGate(
  acceptanceCriteria: AcceptanceCriterion[],
  workingDir: string,
  env: NodeJS.ProcessEnv,
): ConformanceResult {
  const results: Array<{ acId: string; pass: boolean; detail: string }> = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < acceptanceCriteria.length; i++) {
    const ac = acceptanceCriteria[i]!;
    const acId = `AC-${i + 1}`;
    // Strip markdown backtick delimiters that the PRD parser preserves.
    const cmd = ac.verifyCommand.replace(/^`+|`+$/g, "").trim();
    if (!cmd) {
      results.push({ acId, pass: true, detail: "no verify command" });
      passed++;
      continue;
    }
    try {
      execFileSync("sh", ["-c", cmd], {
        cwd: workingDir,
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      results.push({ acId, pass: true, detail: "verify command succeeded" });
      passed++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ acId, pass: false, detail: `verify command failed: ${detail}` });
      failed++;
    }
  }

  return { total: acceptanceCriteria.length, passed, failed, results };
}
