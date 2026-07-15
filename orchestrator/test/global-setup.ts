import { spawnSync } from "child_process";
import { join } from "path";

export default function globalSetup(): void {
  const orchestratorDir = join(import.meta.dirname, "..");
  const tsc = join(orchestratorDir, "node_modules", ".bin", "tsc");
  const result = spawnSync(tsc, [], {
    cwd: orchestratorDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `local artifact compilation failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    );
  }
}
