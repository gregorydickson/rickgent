// ── Conformance gate (citadel) ──────────────────────────────────────────────
//
// Post-implementation conformance audit. Strict builds execute normalized argv;
// the capability-gated legacy entry point remains for read-only migration paths.
// A failing AC is absorbed (salvage disposition recorded), not an intervention.
//
// Extracted from build.ts so both the build pipeline and the standalone
// `rickgent citadel` command import the gate from a single source.

import { execFileSync, spawnSync } from "child_process";
import { join } from "path";
import type { AcceptanceCriterion } from "../core/prd.js";
import type { TicketContract, TicketVerification } from "../contracts/ticket-contract.js";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";

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
  RUNTIME_CAPABILITY_GATE.require("raw_shell");
  const results: Array<{ acId: string; pass: boolean; detail: string }> = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < acceptanceCriteria.length; i++) {
    const ac = acceptanceCriteria[i]!;
    const acId = `AC-${i + 1}`;
    // Strip markdown backtick delimiters that the PRD parser preserves.
    const cmd = (ac.verifyCommand ?? "").replace(/^`+|`+$/g, "").trim();
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

function verificationCwd(verification: TicketVerification, workingDir: string): string | null {
  if (verification.cwd_class === "repository_root") return workingDir;
  if (verification.cwd_class === "orchestrator_package") return join(workingDir, "orchestrator");
  return null;
}

/**
 * M1 structured fixture gate. This is direct argv execution, not sandbox proof;
 * the common supervisor and sandbox receipts remain the t26 authority.
 */
export function runContractConformanceGate(
  contracts: readonly TicketContract[],
  workingDir: string,
  sourceEnv: NodeJS.ProcessEnv,
): ConformanceResult {
  const results: ConformanceResult["results"] = [];
  let passed = 0;
  let failed = 0;

  for (const contract of contracts) {
    const verificationById = new Map(contract.verifications.map((verification) => [verification.id, verification]));
    for (const criterion of contract.acceptance_criteria) {
      let criterionPassed = true;
      const details: string[] = [];
      for (const verificationId of criterion.verification_ids) {
        const verification = verificationById.get(verificationId)!;
        const cwd = verificationCwd(verification, workingDir);
        if (cwd === null) {
          criterionPassed = false;
          details.push(`${verificationId}: attempt_output cwd is unavailable in the M1 fixture gate`);
          continue;
        }
        const env: NodeJS.ProcessEnv = {};
        for (const name of verification.env_allowlist) {
          if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
        }
        const execution = spawnSync(verification.executable, [...verification.args], {
          cwd,
          env,
          encoding: "utf8",
          timeout: verification.timeout_ms,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        });
        const exitCode = execution.status;
        if (
          execution.error !== undefined ||
          exitCode === null ||
          !verification.expected_exit_codes.includes(exitCode)
        ) {
          criterionPassed = false;
          details.push(
            `${verificationId}: failed (${execution.error?.message ?? `exit ${exitCode ?? "null"}`})`,
          );
        } else {
          details.push(`${verificationId}: passed (exit ${exitCode})`);
        }
      }
      results.push({
        acId: criterion.id,
        pass: criterionPassed,
        detail: details.join("; "),
      });
      if (criterionPassed) passed++;
      else failed++;
    }
  }
  return { total: results.length, passed, failed, results };
}
