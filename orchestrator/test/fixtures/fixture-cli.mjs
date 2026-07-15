#!/usr/bin/env node
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { join } from "path";
import { main, handleFatal } from "../../dist/cli.js";
import { verifyPolicyAttachment } from "../../dist/lifecycle/build.js";
import {
  CapabilityUnavailableError,
  getCapability,
} from "../../dist/capabilities/registry.js";

// Historical lifecycle fixtures may exercise local-only machinery, but the M1
// fixture profile never enables delivery. This makes the delivery call graph
// unavailable even when every local gate dependency is injected.
const capabilityGate = Object.freeze({
  require(name) {
    if (name === "automatic_delivery") {
      throw new CapabilityUnavailableError(getCapability(name));
    }
  },
});
const buildDependencies = {
  capabilityGate,
  verifyPolicyAttachment: (agentDir, env) =>
    existsSync(join(agentDir, "config.yaml")) || existsSync(join(agentDir, "agents", "worker", "config.yaml"))
      ? verifyPolicyAttachment(agentDir, env)
      : {
          ok: true,
          detail: "explicit fixture attachment proof",
          managerCount: 1,
          workerCount: 1,
        },
  skipPolicyAttachment: process.env.RICKGENT_FIXTURE_SKIP_POLICY_ATTACH === "1",
  skipConformance: process.env.RICKGENT_FIXTURE_SKIP_CONFORMANCE === "1",
  skipDeslop: process.env.RICKGENT_FIXTURE_SKIP_DESLOP === "1",
};

main(process.argv.slice(2), {
  capabilityGate,
  buildDependencies,
  assertEnvironment() {},
  cronenbergChildCliPath: fileURLToPath(import.meta.url),
}).catch(handleFatal);
