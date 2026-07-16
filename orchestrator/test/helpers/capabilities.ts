import type {
  BuildOptions,
  BuildResult,
  InternalBuildDependencies as FixtureBuildDependencies,
} from "../../src/lifecycle/build.js";
import { runFixtureBuild as executeFixtureBuild } from "../../dist-fixture/testing/fixture-runtime.js";

export type { FixtureBuildDependencies };

export const FIXTURE_BUILD_DEPENDENCIES: FixtureBuildDependencies = Object.freeze({
  assertEnvironment(): void {
    // Historical fixtures explicitly waive environment-only preflight checks.
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

export function runFixtureBuild(
  options: BuildOptions,
  dependencies: FixtureBuildDependencies = FIXTURE_BUILD_DEPENDENCIES,
): Promise<BuildResult> {
  return executeFixtureBuild(options, dependencies);
}
