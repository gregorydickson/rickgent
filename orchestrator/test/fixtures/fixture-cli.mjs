#!/usr/bin/env node
import { fileURLToPath } from "url";
import { cpSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { handleFatal } from "../../dist-fixture/cli.js";
import { runFixtureCli } from "../../dist-fixture/testing/fixture-runtime.js";
const buildDependencies = {
  verifyPolicyAttachment: (agentDir) => {
    const workerDir = join(agentDir, "agents", "worker");
    if (!existsSync(join(workerDir, "config.yaml"))) {
      const sourceWorker = new URL("../../../agents/rickgent/agents/worker/", import.meta.url);
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      cpSync(sourceWorker, workerDir, { recursive: true, errorOnExist: true });
    }
    return {
      ok: true,
      detail: "explicit fixture structured-worker attachment proof",
      managerCount: 0,
      workerCount: 1,
    };
  },
  skipPolicyAttachment: process.env.RICKGENT_FIXTURE_SKIP_POLICY_ATTACH === "1",
  skipConformance: process.env.RICKGENT_FIXTURE_SKIP_CONFORMANCE === "1",
  skipDeslop: process.env.RICKGENT_FIXTURE_SKIP_DESLOP === "1",
};

runFixtureCli(process.argv.slice(2), {
  buildDependencies,
  assertEnvironment() {},
  cronenbergChildCliPath:
    process.env.RICKGENT_FIXTURE_CHILD_CLI_PATH ?? fileURLToPath(import.meta.url),
}).catch(handleFatal);
