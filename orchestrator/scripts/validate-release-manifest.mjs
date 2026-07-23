#!/usr/bin/env node
// validate-release-manifest.mjs
//
// Validates the unified cross-language release manifest and cross-checks every
// version/compatibility value against its authoritative source (npm, Python,
// CLI, build-commit, Omnigent contract, toolchain, license). Fails closed
// (exit 1) on any missing field, drift, or mismatch. Archive creation alone
// is not success: every declared value must agree with its source.
//
// Usage: node orchestrator/scripts/validate-release-manifest.mjs <release-manifest.json>
// Run from the repository root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`validate-release-manifest: ${message}\n`);
  process.exit(1);
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireField(obj, field, label) {
  if (!(field in obj)) {
    fail(`${label} is missing required field "${field}"`);
  }
  return obj[field];
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse JSON at ${path}: ${error.message}`);
  }
}

function repoPath(raw, label) {
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(abs)) {
    fail(`${label} does not exist: ${raw}`);
  }
  return abs;
}

function cliOutput(repoRoot, flag) {
  const cli = resolve(repoRoot, "orchestrator", "dist", "cli.js");
  if (!existsSync(cli)) {
    fail("orchestrator/dist/cli.js does not exist; run `pnpm build` first");
  }
  try {
    return execFileSync("node", [cli, flag], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    }).trim();
  } catch (error) {
    fail(`CLI ${flag} invocation failed: ${error.message}`);
  }
}

// Parse a `version = "..."` line from a pyproject.toml [project] table.
function pyprojectVersion(toml, label) {
  const match = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    fail(`${label}: cannot find project.version`);
  }
  return match[1];
}

function pyprojectRequiresPython(toml, label) {
  const match = toml.match(/^requires-python\s*=\s*"([^"]+)"/m);
  if (!match) {
    fail(`${label}: cannot find project.requires-python`);
  }
  return match[1];
}

function pyprojectLicense(toml, label) {
  const match = toml.match(/license\s*=\s*\{[^}]*text\s*=\s*"([^"]+)"/);
  if (!match) {
    fail(`${label}: cannot find project.license.text`);
  }
  return match[1];
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    fail("usage: validate-release-manifest.mjs <release-manifest.json>");
  }
  const manifestPath = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (!existsSync(manifestPath)) {
    fail(`release manifest does not exist: ${arg}`);
  }

  const repoRoot = realpathSync(process.cwd());
  const manifest = requireObject(loadJson(manifestPath), "manifest");

  // --- Required top-level fields ---
  const requiredTop = [
    "schema_version",
    "release_id",
    "version",
    "license",
    "toolchain",
    "build_identity",
    "omnigent_compatibility",
    "package_contents",
    "installer",
    "runtime_paths",
    "assembly_plan",
    "validators",
  ];
  for (const field of requiredTop) {
    if (!(field in manifest)) {
      fail(`manifest is missing required field "${field}"`);
    }
  }
  if (manifest.schema_version !== "1.0.0") {
    fail(`unsupported schema_version: ${manifest.schema_version}`);
  }

  // --- Version cross-checks ---
  const version = requireObject(manifest.version, "version");
  const npmVersion = requireField(version, "npm", "version");
  const pythonVersion = requireField(version, "python", "version");
  const cliDisplay = requireField(version, "cli_display", "version");
  requireField(version, "docs", "version");

  const pkgPath = repoPath("orchestrator/package.json", "npm manifest");
  const pkg = requireObject(loadJson(pkgPath), "orchestrator/package.json");
  if (pkg.version !== npmVersion) {
    fail(`npm version drift: manifest=${npmVersion} package.json=${pkg.version}`);
  }

  const pyprojectPath = repoPath("rickgent-policies/pyproject.toml", "python manifest");
  const pyproject = readFileSync(pyprojectPath, "utf8");
  const pyVer = pyprojectVersion(pyproject, "pyproject.toml");
  if (pyVer !== pythonVersion) {
    fail(`python version drift: manifest=${pythonVersion} pyproject.toml=${pyVer}`);
  }

  // CLI --version must contain the manifest cli_display.
  const cliVersion = cliOutput(repoRoot, "--version");
  if (!cliVersion.includes(cliDisplay)) {
    fail(`CLI --version drift: manifest cli_display=${cliDisplay} cli output=${cliVersion}`);
  }

  // CLI --build-commit must be a real 40-char SHA, never "dev".
  const buildCommit = cliOutput(repoRoot, "--build-commit");
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) {
    fail(`build identity is not a valid 40-char git SHA: ${buildCommit}`);
  }
  if (buildCommit === "dev") {
    fail('build identity is the literal "dev" — build was not regenerated from git');
  }

  // --- License cross-checks ---
  const license = requireObject(manifest.license, "license");
  const spdx = requireField(license, "spdx", "license");
  const licenseFile = requireField(license, "file", "license");
  if (spdx !== "Apache-2.0") {
    fail(`license.spdx must be Apache-2.0, got ${spdx}`);
  }
  const licenseAbs = repoPath(licenseFile, "LICENSE");
  const licenseText = readFileSync(licenseAbs, "utf8");
  if (!licenseText.includes("Apache License") || !licenseText.includes("Version 2.0")) {
    fail(`LICENSE at ${licenseFile} is not an Apache-2.0 license`);
  }
  if (pkg.license !== "Apache-2.0") {
    fail(`orchestrator/package.json license must be "Apache-2.0", got ${pkg.license ?? "<missing>"}`);
  }
  const pyLicense = pyprojectLicense(pyproject, "pyproject.toml");
  if (pyLicense !== "Apache-2.0") {
    fail(`rickgent-policies/pyproject.toml license.text must be "Apache-2.0", got ${pyLicense}`);
  }

  // --- Toolchain cross-checks ---
  const toolchain = requireObject(manifest.toolchain, "toolchain");
  const nodeRange = requireField(requireObject(toolchain.node, "toolchain.node"), "range", "toolchain.node");
  const pythonRange = requireField(requireObject(toolchain.python, "toolchain.python"), "range", "toolchain.python");
  const pm = requireObject(toolchain.package_manager, "toolchain.package_manager");
  const pmName = requireField(pm, "name", "toolchain.package_manager");
  const pmVersion = requireField(pm, "version", "toolchain.package_manager");
  const platforms = requireObject(toolchain.platforms, "toolchain.platforms");
  const supportedPlatforms = requireField(platforms, "supported", "toolchain.platforms");

  if (pkg.engines?.node !== nodeRange) {
    fail(`node range drift: manifest=${nodeRange} package.json=${pkg.engines?.node ?? "<missing>"}`);
  }
  if (pkg.packageManager !== `${pmName}@${pmVersion}`) {
    fail(`package manager drift: manifest=${pmName}@${pmVersion} package.json=${pkg.packageManager ?? "<missing>"}`);
  }
  const pyReqPython = pyprojectRequiresPython(pyproject, "pyproject.toml");
  if (pyReqPython !== pythonRange) {
    fail(`python range drift: manifest=${pythonRange} pyproject.toml=${pyReqPython}`);
  }
  const rtToolchain = pkg.rickgentToolchain;
  if (!rtToolchain) {
    fail("orchestrator/package.json is missing rickgentToolchain");
  }
  if (rtToolchain.python?.range !== pythonRange) {
    fail(`rickgentToolchain.python.range drift: manifest=${pythonRange} package.json=${rtToolchain.python?.range ?? "<missing>"}`);
  }
  if (JSON.stringify(rtToolchain.platforms?.supported ?? null) !== JSON.stringify(supportedPlatforms)) {
    fail(`platforms drift: manifest=${JSON.stringify(supportedPlatforms)} package.json=${JSON.stringify(rtToolchain.platforms?.supported ?? null)}`);
  }
  if (rtToolchain.platforms?.windows !== platforms.windows) {
    fail(`platforms.windows drift: manifest=${platforms.windows} package.json=${rtToolchain.platforms?.windows ?? "<missing>"}`);
  }

  // --- Omnigent compatibility cross-checks ---
  const omnigent = requireObject(manifest.omnigent_compatibility, "omnigent_compatibility");
  const contractRel = requireField(omnigent, "contract", "omnigent_compatibility");
  const contractId = requireField(omnigent, "contract_id", "omnigent_compatibility");
  const contractAbs = repoPath(contractRel, "omnigent contract");
  const contract = requireObject(loadJson(contractAbs), "omnigent contract");
  if (contract.contract_id !== contractId) {
    fail(`omnigent contract_id drift: manifest=${contractId} contract=${contract.contract_id}`);
  }
  if (contract.contract_mode !== omnigent.contract_mode) {
    fail(`omnigent contract_mode drift: manifest=${omnigent.contract_mode} contract=${contract.contract_mode}`);
  }
  const verifierRel = requireField(omnigent, "verifier", "omnigent_compatibility");
  if (!existsSync(resolve(repoRoot, verifierRel))) {
    fail(`omnigent verifier script does not exist: ${verifierRel}`);
  }

  // --- Package contents structural checks ---
  const pkgContents = requireObject(manifest.package_contents, "package_contents");
  const npmContents = requireObject(pkgContents.npm, "package_contents.npm");
  requireField(npmContents, "manifest", "package_contents.npm");
  requireField(npmContents, "pack_command", "package_contents.npm");
  requireField(npmContents, "inventory_artifact", "package_contents.npm");
  if (!Array.isArray(npmContents.must_include) || npmContents.must_include.length === 0) {
    fail("package_contents.npm.must_include must be a non-empty array");
  }
  if (!Array.isArray(npmContents.must_exclude) || npmContents.must_exclude.length === 0) {
    fail("package_contents.npm.must_exclude must be a non-empty array");
  }
  const pyContents = requireObject(pkgContents.python, "package_contents.python");
  requireField(pyContents, "manifest", "package_contents.python");
  requireField(pyContents, "build_command", "package_contents.python");
  requireField(pyContents, "import_module", "package_contents.python");
  if (!Array.isArray(pyContents.must_include_modules) || pyContents.must_include_modules.length === 0) {
    fail("package_contents.python.must_include_modules must be a non-empty array");
  }

  // --- Installer checks ---
  const installer = requireObject(manifest.installer, "installer");
  const installerScript = requireField(installer, "script", "installer");
  if (!existsSync(resolve(repoRoot, installerScript))) {
    fail(`installer script does not exist: ${installerScript}`);
  }
  if (installer.doctor_failure_is_fatal !== true) {
    fail("installer.doctor_failure_is_fatal must be true (fail closed on behavioral doctor failure)");
  }
  if (installer.preserves_unrelated_user_data !== true) {
    fail("installer.preserves_unrelated_user_data must be true");
  }
  if (installer.idempotent !== true) {
    fail("installer.idempotent must be true");
  }

  // --- Runtime paths checks ---
  const runtimePaths = requireObject(manifest.runtime_paths, "runtime_paths");
  requireField(runtimePaths, "cli_entrypoint", "runtime_paths");
  requireField(runtimePaths, "agent_bundles", "runtime_paths");
  requireField(runtimePaths, "policies_module", "runtime_paths");
  const agentBundlesRel = runtimePaths.agent_bundles;
  if (!existsSync(resolve(repoRoot, agentBundlesRel))) {
    fail(`runtime_paths.agent_bundles does not exist: ${agentBundlesRel}`);
  }
  const policiesSourceRel = requireField(runtimePaths, "policies_source", "runtime_paths");
  if (!existsSync(resolve(repoRoot, policiesSourceRel))) {
    fail(`runtime_paths.policies_source does not exist: ${policiesSourceRel}`);
  }

  // --- Validators checks ---
  const validators = requireObject(manifest.validators, "validators");
  const manifestValidator = requireField(validators, "manifest", "validators");
  if (!existsSync(resolve(repoRoot, manifestValidator))) {
    fail(`validators.manifest script does not exist: ${manifestValidator}`);
  }
  const inventoryValidator = requireField(validators, "package_inventory", "validators");
  if (!existsSync(resolve(repoRoot, inventoryValidator))) {
    fail(`validators.package_inventory script does not exist: ${inventoryValidator}`);
  }

  process.stdout.write(
    `release manifest valid: ${manifest.release_id} `
    + `(npm ${npmVersion}, python ${pythonVersion}, build ${buildCommit.slice(0, 12)}, `
    + `omnigent ${contractId})\n`,
  );
}

main();
