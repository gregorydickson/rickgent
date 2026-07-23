import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveInstalledRuntime, InstalledRuntimeError } from "../../src/install/installed-runtime.js";
import { isCliEntrypoint } from "../../src/cli.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rickgent-installed-"));
  roots.push(root);
  const packageRoot = join(root, "npm", "node_modules", "rickgent");
  const omnigentRoot = join(root, "omnigent");
  for (const path of [
    join(packageRoot, "dist"),
    join(packageRoot, "agents/rickgent/agents/worker"),
    join(packageRoot, "runtime"),
    join(packageRoot, "proof"),
    join(packageRoot, "validators"),
    omnigentRoot,
  ]) mkdirSync(path, { recursive: true });
  for (const path of ["dist/cli.js", "agents/rickgent/config.yaml", "agents/rickgent/agents/worker/config.yaml", "proof/metadata.json", "validators/schema.json", "LICENSE"]) {
    writeFileSync(join(packageRoot, path), `${path}\n`);
  }
  writeFileSync(join(packageRoot, "runtime/resource-map.json"), JSON.stringify({
    schema_version: "rickgent-resource-map/v1",
    resources: {
      cli: { path: "dist/cli.js" },
      manager: { path: "agents/rickgent/config.yaml" },
      worker: { path: "agents/rickgent/agents/worker/config.yaml" },
      proof_metadata: { path: "proof/metadata.json" },
      validators_root: { path: "validators" },
      license: { path: "LICENSE" },
    },
  }));
  return { root, packageRoot, omnigentRoot };
}

describe("archive-only installer and installed resolver", () => {
  it("resolves canonical installed resources with hashes", () => {
    const value = fixture();
    const runtime = resolveInstalledRuntime({
      packageRoot: value.packageRoot,
      omnigentRoot: value.omnigentRoot,
      omnigentPython: process.execPath,
    });
    expect(runtime.cli.realpath).toContain("/node_modules/rickgent/dist/cli.js");
    expect(runtime.cli.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects checkout ancestry and escaping symlinks", () => {
    const value = fixture();
    expect(() => resolveInstalledRuntime({
      packageRoot: value.packageRoot,
      omnigentRoot: value.omnigentRoot,
      omnigentPython: process.execPath,
      forbiddenCheckoutRoots: [value.root],
    })).toThrowError(InstalledRuntimeError);
    rmSync(join(value.packageRoot, "proof/metadata.json"));
    symlinkSync("/etc/hosts", join(value.packageRoot, "proof/metadata.json"));
    expect(() => resolveInstalledRuntime({
      packageRoot: value.packageRoot,
      omnigentRoot: value.omnigentRoot,
      omnigentPython: process.execPath,
    })).toThrow(/(?:escapes package root|symlink is not an immutable resource)/);
  });

  it("rejects source node_modules and incomplete runtime inventory", () => {
    const source = fixture();
    mkdirSync(join(source.packageRoot, "src"));
    expect(() => resolveInstalledRuntime({
      packageRoot: source.packageRoot,
      omnigentRoot: source.omnigentRoot,
      omnigentPython: process.execPath,
    })).toThrow(/contains source tree/);

    const incomplete = fixture();
    const mapPath = join(incomplete.packageRoot, "runtime/resource-map.json");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { resources: Record<string, unknown> };
    delete map.resources["license"];
    writeFileSync(mapPath, JSON.stringify(map));
    expect(() => resolveInstalledRuntime({
      packageRoot: incomplete.packageRoot,
      omnigentRoot: incomplete.omnigentRoot,
      omnigentPython: process.execPath,
    })).toThrow(/inventory is incomplete/);
  });

  it("installer contains no checkout build/editable/ambient fallback", () => {
    const source = readFileSync(join(process.cwd(), "..", "install.sh"), "utf8");
    expect(source).toContain("--npm-tarball");
    expect(source).toContain("--wheel");
    expect(source).toContain("OMNIGENT_ROOT");
    expect(source).toContain("OMNIGENT_PYTHON");
    expect(source).not.toContain("pip install -e");
    expect(source).not.toContain("pnpm build");
    expect(source).not.toContain("git clone");
  });

  it("recognizes the npm bin symlink as the installed CLI entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "rickgent-bin-"));
    roots.push(root);
    const target = join(root, "cli.js");
    const bin = join(root, "rickgent");
    writeFileSync(target, "#!/usr/bin/env node\n");
    symlinkSync(target, bin);
    expect(isCliEntrypoint(bin, pathToFileURL(target).href)).toBe(true);
  });
});
