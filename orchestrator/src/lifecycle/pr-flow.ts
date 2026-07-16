// Delivery is intentionally absent from the reliability-preview runtime.
//
// The previous prototype evaluated legacy-shaped Python policy events, never
// executed its advertised push, and could create a PR without proving the
// remote head. Keeping that code behind a capability flag made the source look
// more complete than it was. Tickets t36/t37 will add a structured,
// receipt-backed push/PR protocol; until then this module is only the stable
// capability boundary imported by contraction tests and historical callers.

import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";

/**
 * Reject branch mutation before touching the filesystem or spawning Git.
 * Structured delivery is not implemented in the reliability-preview channel.
 */
export function ensureBranch(
  _repoDir: string,
  _branch: string,
  _env: NodeJS.ProcessEnv = process.env,
): never {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  throw new Error("automatic delivery capability gate returned unexpectedly");
}
