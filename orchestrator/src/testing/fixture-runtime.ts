/**
 * Test-only bridge for deterministic lifecycle fixtures.
 *
 * This module is compiled so the subprocess fixture can use the same CLI
 * implementation, but the package export map deliberately makes it
 * unreachable through the installed `rickgent` package API.
 */

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
import { FIXTURE_RUNTIME_AUTHORITY } from "./fixture-authority.js";

export type FixtureCliDependencies = InternalCliDependencies;
export type FixtureBuildDependencies = InternalBuildDependencies;

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
  return runBuildWithDependenciesForTesting(FIXTURE_RUNTIME_AUTHORITY, options, dependencies);
}

export function runFixturePipeline(
  options: BuildOptions,
  dependencies: FixtureBuildDependencies,
): Promise<PipelineResult> {
  return runPipelineWithDependenciesForTesting(FIXTURE_RUNTIME_AUTHORITY, options, dependencies);
}
