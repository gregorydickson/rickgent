import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const orchestratorRoot = join(repoRoot, "orchestrator");
const manifestPath = join(repoRoot, "release-manifest.json");
const validatorScript = join(orchestratorRoot, "scripts", "validate-release-manifest.mjs");
const inventoryScript = join(orchestratorRoot, "scripts", "assert-package-inventory.mjs");

const NPM_INVENTORY = join(repoRoot, "artifacts", "reliability", "npm-pack-inventory.json");
const PYTHON_DIST = join(repoRoot, "artifacts", "reliability", "python-dist");

const tmpRoots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `rickgent-release-${prefix}-`));
  tmpRoots.push(root);
  return root;
}

function runNode(script: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}):
  { status: number; stdout: string; stderr: string } {
  const result = execFileSync("node", [script, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
  });
  return { status: 0, stdout: result, stderr: "" };
}

function runNodeAllowFail(script: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}):
  { status: number; stdout: string; stderr: string } {
  try {
    const result = runNode(script, args, opts);
    return result;
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("unified release manifest (t35)", () => {
  it("the release manifest is committed and validates against all cross-language sources", () => {
    expect(existsSync(manifestPath), "release-manifest.json must be committed at repo root").toBe(true);
    const result = runNode(validatorScript, [relative(repoRoot, manifestPath)]);
    expect(result.status, `validator stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("release manifest valid");
  });

  it("manifest version agrees with npm, python, CLI, build-commit, and omnigent contract", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const pkg = JSON.parse(readFileSync(join(orchestratorRoot, "package.json"), "utf8")) as
      { version: string; engines: { node: string }; packageManager: string; license?: string };

    const version = manifest.version as { npm: string; python: string; cli_display: string };
    expect(pkg.version).toBe(version.npm);

    // CLI --version output reflects the manifest cli_display.
    const cliVersion = execFileSync("node", [join(orchestratorRoot, "dist", "cli.js"), "--version"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    }).trim();
    expect(cliVersion).toContain(version.cli_display);

    // CLI --build-commit returns a real 40-char git SHA (not "dev").
    const buildCommit = execFileSync("node", [join(orchestratorRoot, "dist", "cli.js"), "--build-commit"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    }).trim();
    expect(buildCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(buildCommit).not.toBe("dev");

    // Omnigent compatibility contract exists and its contract_id matches the manifest.
    const omnigent = manifest.omnigent_compatibility as { contract: string; contract_id: string };
    const contractAbs = join(repoRoot, omnigent.contract);
    expect(existsSync(contractAbs), `omnigent contract at ${omnigent.contract}`).toBe(true);
    const contract = JSON.parse(readFileSync(contractAbs, "utf8")) as { contract_id: string };
    expect(contract.contract_id).toBe(omnigent.contract_id);
  });

  it("toolchain ranges agree with package.json engines and pyproject requires-python", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const toolchain = manifest.toolchain as {
      node: { range: string };
      python: { range: string };
      package_manager: { name: string; version: string };
      platforms: { supported: string[]; windows: string };
    };
    const pkg = JSON.parse(readFileSync(join(orchestratorRoot, "package.json"), "utf8")) as
      { engines: { node: string }; packageManager: string; rickgentToolchain?: { platforms?: { supported: string[]; windows?: string }; python?: { range?: string } } };

    expect(pkg.engines.node).toBe(toolchain.node.range);
    expect(pkg.packageManager).toBe(`${toolchain.package_manager.name}@${toolchain.package_manager.version}`);
    expect(pkg.rickgentToolchain?.platforms?.supported).toEqual(toolchain.platforms.supported);
    expect(pkg.rickgentToolchain?.platforms?.windows).toBe(toolchain.platforms.windows);
    expect(pkg.rickgentToolchain?.python?.range).toBe(toolchain.python.range);

    const pyproject = readFileSync(join(repoRoot, "rickgent-policies", "pyproject.toml"), "utf8");
    expect(pyproject).toContain(`requires-python = "${toolchain.python.range}"`);
  });

  it("a real Apache-2.0 LICENSE is present and npm/python metadata reference it", () => {
    const licensePath = join(repoRoot, "LICENSE");
    expect(existsSync(licensePath), "LICENSE must exist at repo root").toBe(true);
    const license = readFileSync(licensePath, "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const licenseBlock = manifest.license as { spdx: string; file: string };
    expect(licenseBlock.spdx).toBe("Apache-2.0");
    expect(licenseBlock.file).toBe("LICENSE");

    const pkg = JSON.parse(readFileSync(join(orchestratorRoot, "package.json"), "utf8")) as
      { license?: string };
    expect(pkg.license).toBe("Apache-2.0");

    const pyproject = readFileSync(join(repoRoot, "rickgent-policies", "pyproject.toml"), "utf8");
    expect(pyproject).toContain("Apache-2.0");
  });

  it("npm pack inventory excludes tests/source/secrets and includes the executable", () => {
    // Generate into an isolated path. The canonical retained inventory is
    // release evidence and must never be rewritten by an ordinary test.
    const scratch = tmpRoot("inventory");
    const generatedInventory = join(scratch, "npm-pack-inventory.json");
    const packOut = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      {
        cwd: orchestratorRoot,
        encoding: "utf8",
        shell: false,
        timeout: 120_000,
        env: { ...process.env },
      },
    );
    writeFileSync(generatedInventory, packOut, { encoding: "utf8" });

    // Build the python dist if not already present.
    if (!existsSync(PYTHON_DIST)) {
      execFileSync(
        "python3",
        ["-m", "build", join(repoRoot, "rickgent-policies"), "--outdir", PYTHON_DIST],
        { cwd: repoRoot, encoding: "utf8", shell: false, timeout: 180_000, env: { ...process.env } },
      );
    }

    const result = runNode(inventoryScript, [generatedInventory, relative(repoRoot, PYTHON_DIST)]);
    expect(result.status, `inventory stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("package inventory aligned");
  }, 240_000);

  // --- Negative proofs: validation fails closed on drift/missing/forged ---

  it("validator rejects a manifest whose npm version drifts from package.json", () => {
    const scratch = tmpRoot("drift");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const drifted = structuredClone(manifest);
    (drifted.version as { npm: string }).npm = "9.9.9-wrong";
    const driftedPath = join(scratch, "release-manifest.json");
    writeFileSync(driftedPath, JSON.stringify(drifted), "utf8");

    const result = runNodeAllowFail(validatorScript, [driftedPath], { cwd: repoRoot });
    expect(result.status, `validator should fail: ${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain("npm version");
  });

  it("validator rejects a manifest missing a required field", () => {
    const scratch = tmpRoot("missing");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const missing = structuredClone(manifest);
    delete missing.omnigent_compatibility;
    const missingPath = join(scratch, "release-manifest.json");
    writeFileSync(missingPath, JSON.stringify(missing), "utf8");

    const result = runNodeAllowFail(validatorScript, [missingPath], { cwd: repoRoot });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("omnigent_compatibility");
  });

  it("validator rejects a manifest referencing a missing LICENSE", () => {
    const scratch = tmpRoot("nolicense");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const forged = structuredClone(manifest);
    (forged.license as { file: string }).file = "NO_SUCH_LICENSE";
    const forgedPath = join(scratch, "release-manifest.json");
    writeFileSync(forgedPath, JSON.stringify(forged), "utf8");

    const result = runNodeAllowFail(validatorScript, [forgedPath], { cwd: repoRoot });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LICENSE");
  });

  it("inventory assertion fails when npm pack includes a forbidden test path", () => {
    const scratch = tmpRoot("badinventory");
    const realInventory = JSON.parse(readFileSync(NPM_INVENTORY, "utf8")) as Array<{
      files: Array<{ path: string }>;
    }>;
    // Forge an inventory that claims a test/ file is shipped.
    const forged = structuredClone(realInventory) as Array<{ files: Array<{ path: string }> }>;
    forged[0]!.files.push({ path: "test/reliability/release-manifest.test.ts" });
    const forgedInventoryPath = join(scratch, "npm-pack-inventory.json");
    writeFileSync(forgedInventoryPath, JSON.stringify(forged), "utf8");

    const result = runNodeAllowFail(inventoryScript, [forgedInventoryPath, relative(repoRoot, PYTHON_DIST)], {
      cwd: repoRoot,
    });
    expect(result.status, `inventory should reject forbidden path: ${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain("forbidden");
  });

  it("inventory assertion fails when the python dist is absent", () => {
    const scratch = tmpRoot("nopydist");
    const result = runNodeAllowFail(inventoryScript, [relative(repoRoot, NPM_INVENTORY), join(scratch, "no-dist")], {
      cwd: repoRoot,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("python");
  });
});
