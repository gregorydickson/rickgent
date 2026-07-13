// Verdict CLI subcommand: `rickgent verdict <check> --json`
// Exposes the core verdict functions as JSON I/O for non-TS callers (Python shims).
// Input on stdin, typed verdict JSON on stdout.

import { evaluateCompletion, type CompletionInput, type CompletionVerdict } from "./completion.js";
import { decideSalvage, type SalvageInput, type SalvageDecision } from "./salvage.js";
import { evaluateConvergenceGate, type GateInput, type GateVerdict } from "./convergence.js";
import { checkScope, checkScopeResolved, type ScopeInput, type ResolvedScopeInput, type ScopeVerdict } from "./scope.js";
import { evaluatePrd, type PrdInput, type PrdVerdict } from "./prd.js";
import { createBreakerState, recordIterationResult, canExecute } from "./breaker.js";
import { BUILD_COMMIT } from "../build-commit.js";

export async function runVerdict(args: string[]): Promise<void> {
  const check = args[0];
  const jsonFlag = args.includes("--json");
  const buildCommitFlag = args.includes("--build-commit");

  if (buildCommitFlag) {
    console.log(BUILD_COMMIT);
    return;
  }

  if (!check) {
    console.error("rickgent verdict: missing <check> argument");
    console.error("Usage: rickgent verdict <completion|salvage|gate|scope|scope-resolved|prd|breaker> --json");
    process.exit(1);
  }

  if (!jsonFlag) {
    console.error("rickgent verdict: --json flag required");
    process.exit(1);
  }

  // Read JSON input from stdin
  const inputText = await readStdin();
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    outputError("INVALID_JSON", "Failed to parse JSON input from stdin");
    process.exit(1);
  }

  try {
    switch (check) {
      case "completion":
        outputResult(evaluateCompletion(input as CompletionInput, "cli.verdict"));
        break;
      case "salvage":
        outputResult(decideSalvage(input as SalvageInput));
        break;
      case "gate":
        outputResult(evaluateConvergenceGate(input as GateInput));
        break;
      case "scope":
        outputResult(checkScope(input as ScopeInput));
        break;
      case "scope-resolved":
        outputResult(checkScopeResolved(input as ResolvedScopeInput));
        break;
      case "prd":
        outputResult(evaluatePrd(input as PrdInput));
        break;
      case "breaker": {
        // Breaker fixture input: {threshold, iterations: [{error, gitTreeChanged, workerClaimedFilesChanged}]}
        // Output: {canExecute, transition, reason, errorCount}
        const breakerInput = input as {
          threshold?: number;
          iterations?: Array<{
            error?: string | null;
            gitTreeChanged?: boolean;
            workerClaimedFilesChanged?: number | null;
          }>;
        };
        const threshold = typeof breakerInput.threshold === "number" ? breakerInput.threshold : 5;
        const iterations = Array.isArray(breakerInput.iterations) ? breakerInput.iterations : [];
        const state = createBreakerState(threshold);
        let lastTransition: ReturnType<typeof recordIterationResult> | undefined;
        for (const iter of iterations) {
          lastTransition = recordIterationResult(state, {
            error: iter.error ?? null,
            gitTreeChanged: iter.gitTreeChanged ?? false,
            workerClaimedFilesChanged: iter.workerClaimedFilesChanged ?? null,
          });
        }
        outputResult({
          canExecute: canExecute(state),
          transition: lastTransition?.transition,
          reason: (lastTransition as { reason?: string } | undefined)?.reason,
          errorCount: Object.values(state.errorCounts)[0] ?? 0,
        });
        break;
      }
      default:
        outputError("UNKNOWN_CHECK", `Unknown verdict check: ${check}`);
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputError("VERDICT_ERROR", message);
    process.exit(1);
  }
}

function outputResult(verdict: unknown): void {
  console.log(JSON.stringify(verdict));
}

function outputError(code: string, message: string): void {
  console.log(JSON.stringify({ error: true, code, message }));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
