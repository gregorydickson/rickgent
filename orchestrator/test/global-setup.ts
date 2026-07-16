import { spawnSync } from "child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

function compile(
  compiler: string,
  orchestratorDir: string,
  extraArgs: string[] = [],
): void {
  const result = spawnSync(compiler, [...extraArgs], {
    cwd: orchestratorDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `local artifact compilation failed: ${result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`)}`,
    );
  }
}

export default function globalSetup(): void {
  const orchestratorDir = join(import.meta.dirname, "..");
  const tsc = join(orchestratorDir, "node_modules", ".bin", "tsc");
  rmSync(join(orchestratorDir, "dist"), { recursive: true, force: true });
  compile(tsc, orchestratorDir);
  copyFileSync(
    join(orchestratorDir, "pnpm-lock.yaml"),
    join(orchestratorDir, "dist", "pnpm-lock.yaml"),
  );
  chmodSync(join(orchestratorDir, "dist", "cli.js"), 0o755);

  const fixtureOut = join(orchestratorDir, "dist-fixture");
  rmSync(fixtureOut, { recursive: true, force: true });
  compile(tsc, orchestratorDir, ["--outDir", fixtureOut]);
  const fixtureGate = join(orchestratorDir, "test", "fixtures", "runtime-gate.mjs");
  const compiledGate = join(fixtureOut, "capabilities", "runtime-gate.js");
  mkdirSync(join(fixtureOut, "capabilities"), { recursive: true });
  copyFileSync(fixtureGate, compiledGate);
}
