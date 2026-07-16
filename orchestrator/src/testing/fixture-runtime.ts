/**
 * Test-only bridge for deterministic lifecycle fixtures.
 *
 * This module is compiled so the subprocess fixture can use the same CLI
 * implementation, but the package export map deliberately makes it
 * unreachable through the installed `rickgent` package API.
 */

import { createHash } from "crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { delimiter, join, resolve } from "path";

import {
  runCliWithDependenciesForTesting,
  type InternalCliDependencies,
} from "../cli.js";
import {
  runBuildWithDependenciesForTesting,
  runPipelineWithDependenciesForTesting,
  type BuildOptions,
  type BuildResult,
  type InternalBuildDependencies,
  type PipelineResult,
} from "../lifecycle/build.js";
import type { DispatcherDependencies } from "../dispatch/dispatch.js";
import type { MaterializedWorkerBundle } from "../dispatch/worker-materialization.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "./fixture-authority.js";

export type FixtureCliDependencies = InternalCliDependencies;
export type FixtureBuildDependencies = InternalBuildDependencies;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureExecutable(options: BuildOptions): string {
  const pathValue = options.env?.PATH ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, "omnigent");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue until the deterministic fixture executable is found.
    }
  }
  throw new Error("fixture runtime requires an executable omnigent on the supplied PATH");
}

/**
 * The fixture bridge still exercises the production Dispatcher, queue,
 * workspace, evidence, and ownership paths. It replaces only authenticated
 * policy materialization with an explicit test-only receipt bundle so legacy
 * capture tests do not pretend their scripted worker is a real Omnigent
 * FunctionPolicy runtime.
 */
function fixtureDispatcherDependencies(options: BuildOptions): DispatcherDependencies {
  const executable = fixtureExecutable(options);
  return {
    materializePolicyBundle(request): MaterializedWorkerBundle {
      const dispatchKey = [
        request.dispatch.runId,
        request.dispatch.ticketId,
        request.dispatch.phase,
        request.dispatch.attempt,
        request.dispatch.role,
      ].join("/");
      const attemptsRoot = join(request.stateRoot, "fixture-policy-attempts");
      mkdirSync(attemptsRoot, { recursive: true, mode: 0o700 });
      const attemptRoot = join(attemptsRoot, sha256(dispatchKey));
      mkdirSync(attemptRoot, { mode: 0o700 });
      const bundleDir = join(attemptRoot, "agents", "rickgent", "agents", "worker");
      const templateDir = join(request.agentRoot, "agents", "worker");
      if (existsSync(templateDir)) {
        cpSync(templateDir, bundleDir, { recursive: true, errorOnExist: true });
      } else {
        mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(bundleDir, "config.yaml"), "name: fixture-worker\n", { mode: 0o600 });
      }
      const configPath = join(bundleDir, "config.yaml");
      const configBytes = existsSync(configPath)
        ? readFileSync(configPath)
        : Buffer.from("name: fixture-worker\n", "utf8");
      if (!existsSync(configPath)) writeFileSync(configPath, configBytes, { mode: 0o600 });
      const contextPath = join(attemptRoot, "context.json");
      const contextBytes = Buffer.from(JSON.stringify({ fixture: true, dispatch_id: dispatchKey }) + "\n");
      writeFileSync(contextPath, contextBytes, { mode: 0o600 });
      const leasePath = join(attemptRoot, "lease.json");
      writeFileSync(
        leasePath,
        JSON.stringify({ fixture: true, status: "active", closed_at_ms: null }) + "\n",
        { mode: 0o600 },
      );
      const configSha = sha256(configBytes);
      const bundleSha = sha256(Buffer.concat([configBytes, contextBytes]));
      return {
        kind: "materialized_authenticated_policy_bundle",
        attemptRoot,
        bundleDir,
        configPath,
        configSha256: configSha,
        requestedConfigSha256: configSha,
        requestedBundleSha256: bundleSha,
        invokedConfigSha256: configSha,
        invokedBundleSha256: bundleSha,
        contextPath,
        contextSha256: sha256(contextBytes),
        leasePath,
        trustedSpawnCommand: { executable, argvPrefix: [] },
        spawnEnvironment: {},
      } as unknown as MaterializedWorkerBundle;
    },
    verifyPolicyBundleForSpawn(bundle): void {
      const lease = JSON.parse(readFileSync(bundle.leasePath, "utf8")) as { status?: unknown };
      if (!existsSync(bundle.bundleDir) || lease.status !== "active") {
        throw new Error("fixture policy receipt is missing or inactive");
      }
    },
    finalizePolicyBundle(bundle, proof) {
      if (!proof.childClosed || proof.workspaceCleanupProven || proof.disposition !== "retain") {
        throw new Error("fixture policy receipt received invalid finalization proof");
      }
      const lease = JSON.parse(readFileSync(bundle.leasePath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        bundle.leasePath,
        JSON.stringify({ ...lease, status: "closed", closed_at_ms: Date.now() }) + "\n",
        { mode: 0o600 },
      );
      return Object.freeze({
        disposition: "retained" as const,
        path: bundle.attemptRoot,
        leaseClosed: true,
      });
    },
  };
}

function withFixtureDispatcher(
  options: BuildOptions,
  dependencies: FixtureBuildDependencies,
): FixtureBuildDependencies {
  return dependencies.dispatcherDependencies === undefined
    ? { ...dependencies, dispatcherDependencies: fixtureDispatcherDependencies(options) }
    : dependencies;
}

export function runFixtureCli(
  args: string[],
  dependencies: FixtureCliDependencies,
): Promise<void> {
  return runCliWithDependenciesForTesting(FIXTURE_RUNTIME_AUTHORITY, args, dependencies);
}

export function runFixtureBuild(
  options: BuildOptions,
  dependencies: FixtureBuildDependencies,
): Promise<BuildResult> {
  return runBuildWithDependenciesForTesting(
    FIXTURE_RUNTIME_AUTHORITY,
    options,
    withFixtureDispatcher(options, dependencies),
  );
}

export function runFixturePipeline(
  options: BuildOptions,
  dependencies: FixtureBuildDependencies,
): Promise<PipelineResult> {
  return runPipelineWithDependenciesForTesting(
    FIXTURE_RUNTIME_AUTHORITY,
    options,
    withFixtureDispatcher(options, dependencies),
  );
}
