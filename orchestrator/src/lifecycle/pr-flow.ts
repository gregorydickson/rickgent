// Delivery is activated (t34): verified push and idempotent PR creation.
//
// The `ensureBranch` function is the stable capability boundary imported by
// contraction tests and historical callers. With automatic_delivery activated,
// the capability gate passes. The actual push/PR protocol is implemented in
// `orchestrator/src/delivery/push.ts` and `orchestrator/src/delivery/pull-request.ts`,
// which enforce verified push (independent ls-remote OID match) and verified
// idempotent PR creation (queried head OID and repository identity equality)
// before marking delivered.

import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";

/**
 * Verify the delivery capability is active and the branch name is valid.
 * The actual push/PR protocol is handled by the delivery module.
 */
export function ensureBranch(
  _repoDir: string,
  branch: string,
  _env: NodeJS.ProcessEnv = process.env,
): void {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("branch name must be a non-empty string");
  }
}
