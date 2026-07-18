import { execFileSync } from "child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { pathToFileURL } from "url";
import { afterAll, describe, expect, it } from "vitest";

const orchestratorRoot = join(import.meta.dirname, "../..");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rickgent-packed-boundary-"));
  roots.push(root);
  return root;
}

function inventory(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else paths.push(relative(root, path));
    }
  };
  visit(root);
  return paths.sort();
}

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("packed capability boundary", () => {
  it("excludes fixture authority and rejects absolute-path dependency injection before injected code runs", async () => {
    const root = tempRoot();
    const packedJson = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", root],
      {
        cwd: orchestratorRoot,
        encoding: "utf-8",
        env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
      },
    );
    const packed = JSON.parse(packedJson) as Array<{ filename: string }>;
    const archive = join(root, packed[0]!.filename);
    execFileSync("tar", ["-xzf", archive, "-C", root]);

    const packageRoot = join(root, "package");
    const files = inventory(packageRoot);
    expect(files).toContain("dist/pnpm-lock.yaml");
    expect(files.some((path) => path.startsWith("dist/testing/"))).toBe(false);
    expect(files.some((path) => path.startsWith("dist/internal/"))).toBe(false);
    expect(files.some((path) => path.startsWith("dist-fixture/"))).toBe(false);
    expect(files.some((path) => path.startsWith("src/"))).toBe(false);
    expect(files.some((path) => path.startsWith("test/"))).toBe(false);
    expect(files).toContain("dist/lifecycle/salvage.js");
    const runtimeMap = JSON.parse(
      readFileSync(join(packageRoot, "dist", "capabilities", "runtime-gate.js.map"), "utf-8"),
    ) as { sourcesContent?: unknown[] };
    expect(runtimeMap.sourcesContent).toEqual([expect.any(String)]);

    symlinkSync(
      realpathSync(join(orchestratorRoot, "node_modules")),
      join(packageRoot, "node_modules"),
      "dir",
    );

    const packageJsonUrl = pathToFileURL(join(packageRoot, "package.json"));
    const resolvedRoot = new URL(".", packageJsonUrl);
    const missingPrivateModules = [
      "dist/testing/fixture-authority.js",
      "dist/testing/fixture-runtime.js",
      "dist/internal/fixture-authority.js",
    ];
    for (const path of missingPrivateModules) {
      await expect(import(new URL(path, resolvedRoot).href)).rejects.toMatchObject({
        code: "ERR_MODULE_NOT_FOUND",
      });
    }
    const salvage = await import(new URL("dist/lifecycle/salvage.js", resolvedRoot).href);
    expect(salvage.captureDurableSalvageArchive).toBeTypeOf("function");
    expect(() => new salvage.SalvageDispositionReceipt(Symbol("forged"), {})).toThrow(TypeError);

    const runtime = await import(new URL("dist/capabilities/runtime-gate.js", resolvedRoot).href);
    expect(Object.isFrozen(runtime.RUNTIME_CAPABILITY_GATE)).toBe(true);
    const doctor = await import(new URL("dist/commands/doctor.js", resolvedRoot).href);
    expect(doctor.observeDoctorRuntime().lockfileVersion).toBe("9.0");

    const priorManager = process.env.RICKGENT_MANAGER_DIR;
    const priorWorker = process.env.RICKGENT_WORKER_DIR;
    try {
      const managerDir = realpathSync(join(orchestratorRoot, "..", "agents", "rickgent"));
      process.env.RICKGENT_MANAGER_DIR = managerDir;
      process.env.RICKGENT_WORKER_DIR = join(managerDir, "agents", "worker");
      const health = await import(new URL("dist/lifecycle/doctor.js", resolvedRoot).href);
      const result = await health.runDoctorCheck();
      expect(result.ok, result.report).toBe(true);
      expect(result.report).toContain("configured manager + worker config.yaml files found");
    } finally {
      if (priorManager === undefined) delete process.env.RICKGENT_MANAGER_DIR;
      else process.env.RICKGENT_MANAGER_DIR = priorManager;
      if (priorWorker === undefined) delete process.env.RICKGENT_WORKER_DIR;
      else process.env.RICKGENT_WORKER_DIR = priorWorker;
    }

    let injected = false;
    const fakeDependencies = {
      capabilityGate: { require(): void { injected = true; } },
      assertEnvironment(): void { injected = true; },
    };
    const options = {
      prdPath: "/missing.md",
      workingDir: packageRoot,
      rickgentDir: join(root, "state"),
      agentDir: packageRoot,
      dataDir: join(root, "data"),
      env: {},
    };

    const build = await import(new URL("dist/lifecycle/build.js", resolvedRoot).href);
    await expect(Reflect.apply(build.runBuild, undefined, [options, fakeDependencies]))
      .rejects.toThrow("RICKGENT_AUTONOMOUS_FIXTURE_ONLY");
    expect(injected).toBe(false);

    await expect(build.runBuildWithDependenciesForTesting({}, options, fakeDependencies))
      .rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
    expect(injected).toBe(false);

    const cli = await import(new URL("dist/cli.js", resolvedRoot).href);
    await expect(Reflect.apply(cli.main, undefined, [
      ["prd", "--from", "/missing.md"],
      fakeDependencies,
    ])).rejects.toThrow("RICKGENT_AUTONOMOUS_FIXTURE_ONLY");
    expect(injected).toBe(false);

    await expect(cli.runCliWithDependenciesForTesting(
      {},
      ["prd", "--from", "/missing.md"],
      fakeDependencies,
    )).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
    expect(injected).toBe(false);

    const shippedMutationBoundaries = [
      "dist/cli.js",
      "dist/dispatch/dispatch.js",
      "dist/dispatch/queue.js",
      "dist/lifecycle/anatomy.js",
      "dist/lifecycle/build.js",
      "dist/lifecycle/citadel.js",
      "dist/lifecycle/cronenberg-run.js",
      "dist/lifecycle/microverse.js",
      "dist/lifecycle/microverse-cli.js",
      "dist/lifecycle/pr-flow.js",
      "dist/lifecycle/prd-interview.js",
      "dist/lifecycle/reconcile.js",
      "dist/lifecycle/refine.js",
      "dist/lifecycle/routing.js",
      "dist/lifecycle/szechuan-cli.js",
    ];
    for (const path of shippedMutationBoundaries) {
      const source = readFileSync(join(packageRoot, path), "utf-8");
      expect(source, path).not.toMatch(/\bcapabilityGate\b|FIXTURE_RUNTIME_AUTHORITY/);
    }
  });
});
