// Salvage disposition logic — PURE decision functions.
// The verdict core DECIDES the disposition; the lifecycle layer EXECUTES git mutations.
// §14.8: decide / execute / verify split.

export type SalvageDisposition =
  | "ff-reattached"
  | "committed-done"
  | "archived-todo"
  | "no-op"
  | "error";

export interface SalvageInput {
  /** Whether the gate passed. */
  gatePassed: boolean;
  /** Whether the working tree has changes. */
  treeChanged: boolean;
  /** Whether an orphan-reset was detected (head regression). */
  orphanReset: boolean;
  /** Whether a fast-forward reattach is possible. */
  ffReattachPossible: boolean;
  /** Owned paths for the ticket (for scoped staging). */
  ownedPaths: string[];
}

export interface SalvageDecision {
  disposition: SalvageDisposition;
  commitSha?: string;
  reason: string;
  stagedPaths?: string[];
}

export function decideSalvage(input: SalvageInput): SalvageDecision {
  // AC-16: Fail closed on malformed input
  if (input == null || typeof input !== "object") {
    return { disposition: "error", reason: "invalid input" };
  }

  const gatePassed = input.gatePassed === true;
  const treeChanged = input.treeChanged === true;
  const orphanReset = input.orphanReset === true;
  const ffReattachPossible = input.ffReattachPossible === true;
  const ownedPaths = Array.isArray(input.ownedPaths)
    ? input.ownedPaths.filter((p): p is string => typeof p === "string")
    : [];

  // ff-reattached: orphan-reset detected → fast-forward reattach
  if (orphanReset && ffReattachPossible) {
    return {
      disposition: "ff-reattached",
      reason: "orphan-reset detected, fast-forward reattach possible",
    };
  }

  // committed-done: gate-green + tree changed
  if (gatePassed && treeChanged) {
    return {
      disposition: "committed-done",
      reason: "gate passing and tree changed",
      stagedPaths: ownedPaths,
    };
  }

  // archived-todo: gate-failing but tree changed
  if (!gatePassed && treeChanged) {
    return {
      disposition: "archived-todo",
      reason: "gate failing but tree changed, archive and reset to Todo",
      stagedPaths: ownedPaths,
    };
  }

  // no-op: gate passing and nothing to salvage
  if (gatePassed && !treeChanged) {
    return {
      disposition: "no-op",
      reason: "no tree changes to salvage",
    };
  }

  // error: gate failing with no tree changes, or salvage could not determine a disposition
  return {
    disposition: "error",
    reason: "salvage could not determine a disposition",
  };
}
