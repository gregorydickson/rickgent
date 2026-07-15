import type { CapabilityGate } from "../../src/capabilities/registry.js";
import type { BuildDependencies } from "../../src/lifecycle/build.js";

export const FIXTURE_CAPABILITY_GATE: CapabilityGate = Object.freeze({
  require(): void {
    // Explicit fixture dependency: never constructed by a production entrypoint.
  },
});

export const FIXTURE_BUILD_DEPENDENCIES: BuildDependencies = Object.freeze({
  capabilityGate: FIXTURE_CAPABILITY_GATE,
  assertEnvironment(): void {
    // Historical fixtures inject their gate controls directly.
  },
  verifyPolicyAttachment() {
    return {
      ok: true,
      detail: "explicit fixture attachment proof",
      managerCount: 1,
      workerCount: 1,
    };
  },
});
