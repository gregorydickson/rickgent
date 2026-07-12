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
  // ff-reattached: orphan-reset detected → fast-forward reattach
  if (input.orphanReset && input.ffReattachPossible) {
    return {
      disposition: "ff-reattached",
      reason: "orphan-reset detected, fast-forward reattach possible",
    };
  }

  // committed-done: gate-green + tree changed
  if (input.gatePassed && input.treeChanged) {
    return {
      disposition: "committed-done",
      reason: "gate passing and tree changed",
      stagedPaths: input.ownedPaths,
    };
  }

  // archived-todo: gate-failing but tree changed
  if (!input.gatePassed && input.treeChanged) {
    return {
      disposition: "archived-todo",
      reason: "gate failing but tree changed, archive and reset to Todo",
      stagedPaths: input.ownedPaths,
    };
  }

  // no-op: nothing to salvage
  if (!input.treeChanged) {
    return {
      disposition: "no-op",
      reason: "no tree changes to salvage",
    };
  }

  // error: salvage itself failed
  return {
    disposition: "error",
    reason: "salvage could not determine a disposition",
  };
}
