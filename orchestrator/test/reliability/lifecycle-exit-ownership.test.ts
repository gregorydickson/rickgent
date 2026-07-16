import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnatomyCommand } from "../../dist-fixture/lifecycle/anatomy.js";
import { runCitadelCommand } from "../../dist-fixture/lifecycle/citadel-cli.js";
import {
  LifecycleCommandError,
  lifecycleCommandCompleted,
  lifecycleCommandSucceeded,
} from "../../src/lifecycle/command-result.js";
import { runCronenbergCommand } from "../../dist-fixture/lifecycle/cronenberg-run.js";
import { runMicroverseCommand } from "../../dist-fixture/lifecycle/microverse-cli.js";
import { runPrdCommand } from "../../dist-fixture/lifecycle/prd-interview.js";
import { runRefineCommand } from "../../dist-fixture/lifecycle/refine.js";
import { runSzechuanCommand } from "../../dist-fixture/lifecycle/szechuan-cli.js";

const FIXTURE_CLI = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const roots: string[] = [];

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function lifecycleSources(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  visit(root);
  return files;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("lifecycle exit ownership", () => {
  it("keeps every lifecycle source free of process termination", () => {
    const root = join(import.meta.dirname, "../../src/lifecycle");
    const offenders = lifecycleSources(root).filter((path) =>
      /process\.exit(?:Code)?\b/.test(readFileSync(path, "utf-8")));
    expect(offenders).toEqual([]);
  });

  it("returns typed success and throws typed failures without terminating the embedding process", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const missing = join(tempRoot("lifecycle-embed"), "missing");

    const successful = await Promise.all([
      runPrdCommand(["--help"]),
      runRefineCommand(["--help"]),
      runMicroverseCommand(["--help"]),
      runSzechuanCommand(["--help"]),
      runAnatomyCommand(["--help"]),
      runCitadelCommand(["--help"]),
      runCronenbergCommand(["--help"]),
    ]);
    expect(successful).toEqual(Array.from({ length: 7 }, () => lifecycleCommandSucceeded()));

    const failingCalls: Array<() => Promise<unknown>> = [
      () => runPrdCommand(["--non-interactive", "--repo", missing]),
      () => runRefineCommand([]),
      () => runMicroverseCommand([]),
      () => runSzechuanCommand(["--repo", missing, "--agent", missing]),
      () => runAnatomyCommand(["--repo", missing, "--agent", missing]),
      () => runCitadelCommand([]),
      () => runCronenbergCommand(["--dry-run", "--repo", missing]),
    ];
    for (const execute of failingCalls) {
      await expect(execute()).rejects.toMatchObject({
        name: LifecycleCommandError.name,
        exitCode: 1,
      });
    }
  });

  it("lets embeddings inspect completed failures while the CLI alone maps them to an exit", async () => {
    const root = tempRoot("lifecycle-complete");
    const child = join(root, "exit-seven.mjs");
    writeFileSync(child, "process.exitCode = 7;\n", "utf-8");
    chmodSync(child, 0o755);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const args = ["--task", "exercise completion mapping", "--repo", root];
    const embedded = await runCronenbergCommand(args, child);
    expect(embedded).toEqual(lifecycleCommandCompleted(7));

    const cli = spawnSync(process.execPath, [FIXTURE_CLI, "cronenberg", ...args], {
      encoding: "utf-8",
      env: {
        ...process.env,
        RICKGENT_DIR: join(root, ".rickgent-cli"),
        RICKGENT_FIXTURE_CHILD_CLI_PATH: child,
      },
    });
    expect(cli.status, `${cli.stdout}\n${cli.stderr}`).toBe(7);
    expect(cli.stderr).toContain("step failed (exit 7)");
  });
});
