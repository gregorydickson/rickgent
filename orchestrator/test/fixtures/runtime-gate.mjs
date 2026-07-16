import {
  CapabilityUnavailableError,
  getCapability,
} from "./registry.js";

/**
 * Fixture-tree capability authority. The test compiler copies this file over
 * the production runtime-gate module in dist-fixture only.
 *
 * The M1 fixture profile owns exactly one unavailable production capability:
 * autonomous dispatch. All later lifecycle authority remains unavailable, so
 * fixture evidence cannot be promoted through reconciliation or delivery.
 */
export const RUNTIME_CAPABILITY_GATE = Object.freeze({
  require(name) {
    if (name !== "autonomous_dispatch") {
      throw new CapabilityUnavailableError(getCapability(name));
    }
  },
});
