import {
  CapabilityUnavailableError,
  getCapability,
} from "./registry.js";

/**
 * Fixture-tree capability authority. The test compiler copies this file over
 * the production runtime-gate module in dist-fixture only.
 *
 * The fixture profile mirrors the production gate for all enabled
 * capabilities. After t29, autonomous_dispatch, resume_retry, and
 * reconciliation are all enabled. The remaining capabilities
 * (parallel_dispatch, cross_vendor_review, automatic_delivery, raw_shell)
 * remain unavailable, so fixture evidence cannot be promoted through
 * delivery or parallel dispatch.
 */
const FIXTURE_ENABLED = new Set([
  "autonomous_dispatch",
  "resume_retry",
  "reconciliation",
]);
export const RUNTIME_CAPABILITY_GATE = Object.freeze({
  require(name) {
    if (!FIXTURE_ENABLED.has(name)) {
      throw new CapabilityUnavailableError(getCapability(name));
    }
  },
});
