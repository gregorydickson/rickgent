// Completion oracle — the SINGLE predicate.
// Every completion check routes through evaluateCompletion.
// AC-5: one predicate, enumerated caller allowlist, pinned by test.

export type CompletionVerdict =
  | { verdict: "COMMITTED"; commitSha: string; treeChanged: true }
  | { verdict: "UNVERIFIED"; reason: string }
  | { verdict: "BASELINE_SHA"; reason: string }
  | { verdict: "NO_TREE_CHANGE"; reason: string };

export interface CompletionInput {
  /** Git commit SHA claimed by the worker. */
  claimedSha: string | null;
  /** The baseline SHA — the commit before the worker started. */
  baselineSha: string;
  /** Whether git cat-file confirms the claimed SHA exists. */
  shaExists: boolean;
  /** Whether the tree at the claimed SHA differs from the baseline tree. */
  treeChanged: boolean;
  /** Whether the gate verdict was green (if applicable). */
  gateGreen: boolean | null;
}

/**
 * ALLOWED callers of evaluateCompletion — pinned by test (AC-5).
 * Any caller not in this set is a finding.
 */
export const ALLOWED_COMPLETION_CALLERS = new Set([
  "lifecycle.phase-machine",
  "lifecycle.microverse",
  "lifecycle.salvage",
  "lifecycle.reconcile",
  "cli.verdict",
  "policy.completion-evidence",
  "lifecycle.auto-fill-completion",
]);

export function evaluateCompletion(input: CompletionInput, caller?: string): CompletionVerdict {
  // W1: enforce the caller allowlist. If a caller is provided and is not in
  // ALLOWED_COMPLETION_CALLERS, refuse to evaluate — the allowlist exists to
  // keep every completion check routed through a single enumerated predicate.
  if (caller != null && !ALLOWED_COMPLETION_CALLERS.has(caller)) {
    throw new Error(`evaluateCompletion called by unauthorized caller: ${caller}`);
  }

  // AC-16: Fail closed on malformed input
  if (input == null || typeof input !== "object") {
    return { verdict: "UNVERIFIED", reason: "invalid input" };
  }

  // Coerce fields with strict type checks — wrong types fail closed
  const claimedSha = typeof input.claimedSha === "string" ? input.claimedSha : null;
  const baselineSha = typeof input.baselineSha === "string" ? input.baselineSha : "";
  const shaExists = input.shaExists === true;
  const treeChanged = input.treeChanged === true;
  const gateGreen = input.gateGreen;

  // 1. A commit exists and is reachable
  if (!claimedSha || !shaExists) {
    return { verdict: "UNVERIFIED", reason: "no reachable commit" };
  }

  // 2. The commit is not the baseline SHA (rejection of no-op)
  if (claimedSha === baselineSha) {
    return { verdict: "BASELINE_SHA", reason: "claimed SHA equals baseline SHA" };
  }

  // 3. The tree changed (empty commits don't count)
  if (!treeChanged) {
    return { verdict: "NO_TREE_CHANGE", reason: "tree at claimed SHA matches baseline tree" };
  }

  // 4. Gate verdict was green (if applicable)
  if (gateGreen === false) {
    return { verdict: "UNVERIFIED", reason: "gate verdict was not green" };
  }

  return { verdict: "COMMITTED", commitSha: claimedSha, treeChanged: true };
}
