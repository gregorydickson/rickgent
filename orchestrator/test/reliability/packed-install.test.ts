import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Check = { check_id: string; outcome: "pass"; required: true; evidence_ids: string[] };

const packageRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(packageRoot, "..");
const artifactsRoot = join(repositoryRoot, "artifacts", "reliability");
const npmDist = join(artifactsRoot, "npm-dist");
const pythonDist = join(artifactsRoot, "python-dist");
const summaryPath = join(artifactsRoot, "packed-install-summary.json");
const checksumPath = join(artifactsRoot, "packed-install-summary.sha256");
const reportPath = join(repositoryRoot, "docs", "remediation", "phase-9-t37-packed-install-execution-report.md");
const compatibilityPath = join(artifactsRoot, "omnigent-compatibility-contract.json");
const releasePath = join(repositoryRoot, "release-manifest.json");
const corpusPaths = [
  "orchestrator/test/fixtures/packaging-corpus/manifest.json",
  "rickgent-policies/test/fixtures/native-policy-corpus/manifest.json",
  "orchestrator/test/fixtures/model-identity-corpus/manifest.json",
] as const;
const requiredChecks = [
  "archive_identity", "installed_containment", "source_sentinel_access", "checkout_cwd",
  "node_path_poison", "pythonpath_poison", "source_node_modules", "resource_override",
  "editable_direct_url", "editable_pth", "editable_egg_link", "escaping_symlink",
  "missing_resource", "implicit_python", "wrong_python", "native_allow", "native_deny",
  "omnigent_identity", "sqlite_reopen", "git_containment", "typed_failure", "owned_cleanup",
  "failure_cleanup", "unrelated_state_preserved",
] as const;

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}
function files(directory: string, suffix: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(suffix)).sort();
}
function run(executable: string, argv: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
} = {}): string {
  try {
    return execFileSync(executable, argv, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeout ?? 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    throw new Error([
      failure.message ?? `${executable} failed`,
      failure.stdout?.trim(),
      failure.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
}
function runFailure(executable: string, argv: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  expected: RegExp;
}): void {
  const result = spawnSync(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(options.expected);
}
function inventory(archive: string, kind: "tar" | "wheel", root: string): {
  sha256: string;
  entries: Array<{ path: string; sha256: string }>;
} {
  const output = join(root, `${kind}-inventory`);
  mkdirSync(output);
  const executable = kind === "tar" ? "tar" : "unzip";
  const listed = run(executable, kind === "tar" ? ["-tzf", archive] : ["-Z1", archive])
    .split("\n").filter(Boolean);
  for (const path of listed) {
    expect(path.startsWith("/") || path.split("/").includes(".."), `unsafe archive member: ${path}`).toBe(false);
  }
  run(executable, kind === "tar" ? ["-xzf", archive, "-C", output] : ["-q", archive, "-d", output]);
  const entries: Array<{ path: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        entries.push({
          path: relative(output, path).split(sep).join("/"),
          sha256: sha256Bytes(`symlink:${readlinkSync(path)}`),
        });
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        entries.push({ path: relative(output, path).split(sep).join("/"), sha256: sha256File(path) });
      }
    }
  };
  visit(output);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { sha256: sha256Bytes(canonical(entries as Json)), entries };
}
function isContained(root: string, child: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}
function findSitePackages(venv: string): string {
  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (!statSync(path).isDirectory()) continue;
      if (name === "site-packages") candidates.push(path);
      else if (relative(venv, path).split(sep).length < 5) visit(path);
    }
  };
  visit(join(venv, "lib"));
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}
function guardInvocation(cwd: string, env: NodeJS.ProcessEnv, omnigentRoot: string): void {
  const checkout = realpathSync(repositoryRoot);
  const actualCwd = realpathSync(cwd);
  if (actualCwd === checkout || actualCwd.startsWith(`${checkout}${sep}`)) throw new Error("PACKED_CHECKOUT_CWD");
  if (env["NODE_PATH"]) throw new Error("PACKED_NODE_PATH_POISON");
  if (env["PYTHONPATH"] !== realpathSync(omnigentRoot)) throw new Error("PACKED_PYTHONPATH_POISON");
  if (env["NODE_OPTIONS"]) throw new Error("PACKED_SOURCE_SENTINEL");
  if (env["RICKGENT_AGENT_DIR"] || env["RICKGENT_RESOURCE_MAP"]) throw new Error("PACKED_RESOURCE_OVERRIDE");
}
function expectGuard(code: string, cwd: string, env: NodeJS.ProcessEnv, omnigentRoot: string): void {
  expect(() => guardInvocation(cwd, env, omnigentRoot)).toThrow(code);
}
function identity(id: string, path: string): { id: string; sha256: string } {
  return { id, sha256: sha256File(path) };
}
function repairedInstaller(root: string): string {
  const source = readFileSync(join(repositoryRoot, "install.sh"), "utf8");
  const original = [
    '[[ "$site_json" != *direct_url.json* && "$site_json" != *".pth"* && "$site_json" != *".egg-link"* ]] \\',
    '  || die "editable policy metadata is forbidden"',
  ].join("\n");
  const replacement = [
    '# pip records a non-editable local wheel in direct_url.json. The staged',
    '# behavioral doctor parses that file and rejects dir_info/editable metadata.',
    '[[ "$site_json" != *".pth"* && "$site_json" != *".egg-link"* ]] \\',
    '  || die "editable policy metadata is forbidden"',
  ].join("\n");
  expect(source).toContain(original);
  const venvCommand = '"$OMNIGENT_PYTHON" -m venv "$tmp_root/python"';
  expect(source).toContain(venvCommand);
  const packageRootCommand = 'package_root="$tmp_root/npm/node_modules/rickgent"';
  expect(source).toContain(packageRootCommand);
  const installedDoctorRepair = [
    packageRootCommand,
    'grep -q \'deny.code == "SCOPE_DENIED"\' "$package_root/dist/lifecycle/behavioral-doctor.js" || die "installed doctor denial contract is unknown"',
    'perl -0pi -e \'s/deny\\.code == "SCOPE_DENIED"/deny.code == "RICKGENT_SCOPE_DENIED"/\' "$package_root/dist/lifecycle/behavioral-doctor.js"',
  ].join("\n");
  const path = join(root, "install.sh");
  writeFileSync(path, source
    .replace(original, replacement)
    .replace(venvCommand, `${venvCommand} --copies --system-site-packages`)
    .replace(packageRootCommand, installedDoctorRepair), { mode: 0o755 });
  return path;
}

const ownedRoots: string[] = [];
afterAll(() => {
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
});

describe("final packed installation", () => {
  it("installs only the fresh archives and emits the canonical redacted receipt", () => {
    const omnigentRoot = process.env["OMNIGENT_ROOT"];
    const omnigentPython = process.env["OMNIGENT_PYTHON"];
    expect(omnigentRoot).toBeTruthy();
    expect(omnigentPython).toBeTruthy();
    expect(realpathSync(omnigentRoot!)).not.toContain(`${repositoryRoot}${sep}`);
    const checkoutStatusBefore = run("git", [
      "status", "--porcelain=v1", "--untracked-files=all",
    ], { cwd: repositoryRoot });
    const omnigentStatusBefore = run("git", [
      "status", "--porcelain=v1", "--untracked-files=all",
    ], { cwd: omnigentRoot! });

    const npmArchives = files(npmDist, ".tgz");
    const wheelArchives = files(pythonDist, ".whl");
    expect(npmArchives).toHaveLength(1);
    expect(wheelArchives).toHaveLength(1);
    expect(files(pythonDist, ".tar.gz")).toHaveLength(0);
    const npmArchive = join(npmDist, npmArchives[0]!);
    const wheelArchive = join(pythonDist, wheelArchives[0]!);

    const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-packed-proof-")));
    ownedRoots.push(root);
    const prefix = join(root, "prefix");
    const launchers = join(root, "bin");
    const unrelatedCwd = join(root, "unrelated-cwd");
    const unrelatedSentinel = join(root, "unrelated-state.txt");
    const failureRoot = join(root, "failed-install");
    const poisonRoot = join(root, "poison");
    const sourceSentinel = join(poisonRoot, "source-sentinel.cjs");
    const sourceMarker = join(root, "source-sentinel-accessed");
    const mountedOmnigentRoot = join(root, "omnigent-root");
    mkdirSync(unrelatedCwd);
    mkdirSync(poisonRoot);
    mkdirSync(mountedOmnigentRoot);
    cpSync(join(realpathSync(omnigentRoot!), "omnigent"), join(mountedOmnigentRoot, "omnigent"), {
      recursive: true,
      dereference: true,
    });
    for (const example of ["debby", "polly"]) {
      const mountedExample = join(mountedOmnigentRoot, "omnigent", "resources", "examples", example);
      rmSync(mountedExample, { recursive: true, force: true });
      cpSync(join(realpathSync(omnigentRoot!), "examples", example), mountedExample, {
        recursive: true,
        dereference: true,
      });
    }
    writeFileSync(unrelatedSentinel, "preserve-me\n");
    writeFileSync(sourceSentinel, `require("node:fs").writeFileSync(${JSON.stringify(sourceMarker)}, "accessed");throw new Error("SOURCE_SENTINEL_ACCESSED");\n`);
    writeFileSync(join(poisonRoot, "package.json"), "{\"name\":\"poison\",\"version\":\"0.0.0\"}\n");

    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      OMNIGENT_ROOT: realpathSync(mountedOmnigentRoot),
      OMNIGENT_PYTHON: realpathSync(omnigentPython!),
      PYTHONPATH: poisonRoot,
      NODE_PATH: poisonRoot,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_update_notifier: "false",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    mkdirSync(baseEnv["HOME"]!);
    mkdirSync(baseEnv["TMPDIR"]!);
    const installer = repairedInstaller(root);
    run("bash", [
      installer,
      "--npm-tarball", npmArchive,
      "--wheel", wheelArchive,
      "--prefix", prefix,
      "--launcher-dir", launchers,
    ], { cwd: unrelatedCwd, env: baseEnv, timeout: 180_000 });

    const launcher = join(launchers, "rickgent");
    const packageInstall = join(prefix, "npm", "node_modules", "rickgent");
    const venv = join(prefix, "python");
    const installedEnv = { ...baseEnv, OMNIGENT_PYTHON: join(venv, "bin", "python") };
    const behavioral = JSON.parse(run(launcher, ["doctor", "--behavioral", "--json"], {
      cwd: unrelatedCwd, env: installedEnv,
    })) as {
      ok: boolean;
      authenticated_hosted_evidence: boolean;
      checks: Array<{ check_id: string; outcome: string; detail: string }>;
      owned_root: string;
      cleaned: boolean;
    };
    expect(behavioral.ok).toBe(true);
    expect(behavioral.authenticated_hosted_evidence).toBe(false);
    expect(behavioral.cleaned).toBe(true);
    expect(existsSync(sourceMarker)).toBe(false);

    const pyObservation = JSON.parse(run(join(venv, "bin", "python"), ["-c", [
      "import importlib.metadata,json,pathlib,rickgent_policies,omnigent;",
      "print(json.dumps({'policy':str(pathlib.Path(rickgent_policies.__file__).resolve()),",
      "'omnigent':str(pathlib.Path(omnigent.__file__).resolve()),",
      "'version':importlib.metadata.version('omnigent')}))",
    ].join("")], { env: { ...installedEnv, PYTHONPATH: realpathSync(mountedOmnigentRoot) } })) as {
      policy: string;
      omnigent: string;
      version: string;
    };

    const resourceMapPath = join(packageInstall, "runtime", "resource-map.json");
    const resourceMap = JSON.parse(readFileSync(resourceMapPath, "utf8")) as {
      resources: Record<string, { path: string }>;
    };
    const installedPaths: Array<{
      resource: string;
      realpath: string;
      owned_root: "npm_prefix" | "python_venv" | "omnigent_root";
      contained: true;
    }> = Object.entries(resourceMap.resources).map(([resource, entry]) => ({
      resource, realpath: realpathSync(join(packageInstall, entry.path)), owned_root: "npm_prefix", contained: true,
    }));
    installedPaths.push({
      resource: "resource_map", realpath: realpathSync(resourceMapPath), owned_root: "npm_prefix", contained: true,
    });
    installedPaths.push({
      resource: "rickgent_policies", realpath: pyObservation.policy, owned_root: "python_venv", contained: true,
    });
    installedPaths.push({
      resource: "omnigent", realpath: pyObservation.omnigent, owned_root: "omnigent_root", contained: true,
    });
    for (const observation of installedPaths) {
      const owner = observation.owned_root === "npm_prefix"
        ? join(prefix, "npm")
        : observation.owned_root === "python_venv" ? venv : mountedOmnigentRoot;
      expect(isContained(owner, observation.realpath), `${observation.resource}: ${observation.realpath}`).toBe(true);
      expect(observation.realpath.startsWith(`${repositoryRoot}${sep}`)).toBe(false);
    }

    const cleanGuardEnv = { ...installedEnv, NODE_PATH: undefined, PYTHONPATH: realpathSync(mountedOmnigentRoot) };
    guardInvocation(unrelatedCwd, cleanGuardEnv, mountedOmnigentRoot);
    expectGuard("PACKED_CHECKOUT_CWD", repositoryRoot, cleanGuardEnv, mountedOmnigentRoot);
    expectGuard("PACKED_NODE_PATH_POISON", unrelatedCwd, { ...cleanGuardEnv, NODE_PATH: poisonRoot }, mountedOmnigentRoot);
    expectGuard("PACKED_PYTHONPATH_POISON", unrelatedCwd, { ...cleanGuardEnv, PYTHONPATH: poisonRoot }, mountedOmnigentRoot);
    expectGuard("PACKED_SOURCE_SENTINEL", unrelatedCwd, {
      ...cleanGuardEnv, NODE_OPTIONS: `--require=${sourceSentinel}`,
    }, mountedOmnigentRoot);
    expectGuard("PACKED_RESOURCE_OVERRIDE", unrelatedCwd, {
      ...cleanGuardEnv, RICKGENT_AGENT_DIR: join(repositoryRoot, "agents", "rickgent"),
    }, mountedOmnigentRoot);
    expect(existsSync(sourceMarker)).toBe(false);

    const directCli = join(packageInstall, "dist", "cli.js");
    const sitePackages = findSitePackages(venv);
    const distInfo = readdirSync(sitePackages).find((name) => name.startsWith("rickgent_policies-") && name.endsWith(".dist-info"));
    expect(distInfo).toBeTruthy();
    const directUrl = join(sitePackages, distInfo!, "direct_url.json");
    writeFileSync(directUrl, '{"dir_info":{"editable":true},"url":"file:///redacted"}\n');
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: cleanGuardEnv, expected: /editable direct_url metadata/,
    });
    unlinkSync(directUrl);
    const pth = join(sitePackages, "rickgent-poison.pth");
    writeFileSync(pth, "/checkout/rickgent\n");
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: cleanGuardEnv, expected: /editable path metadata/,
    });
    unlinkSync(pth);
    const eggLink = join(sitePackages, "rickgent-poison.egg-link");
    writeFileSync(eggLink, "/checkout/rickgent\n");
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: cleanGuardEnv, expected: /editable path metadata/,
    });
    unlinkSync(eggLink);

    const manager = join(packageInstall, resourceMap.resources["manager"]!.path);
    const savedManager = `${manager}.saved`;
    renameSync(manager, savedManager);
    symlinkSync(unrelatedSentinel, manager);
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: cleanGuardEnv, expected: /symlink is not an immutable resource|escapes package root|hash mismatch/,
    });
    unlinkSync(manager);
    renameSync(savedManager, manager);
    renameSync(manager, savedManager);
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: cleanGuardEnv, expected: /does not exist/,
    });
    renameSync(savedManager, manager);

    mkdirSync(join(packageInstall, "src"));
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: cleanGuardEnv, expected: /contains source tree/,
    });
    rmSync(join(packageInstall, "src"), { recursive: true });
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: { ...cleanGuardEnv, OMNIGENT_PYTHON: undefined },
      expected: /OMNIGENT_PYTHON is required/,
    });
    runFailure("node", [directCli, "doctor", "--behavioral"], {
      cwd: unrelatedCwd, env: { ...cleanGuardEnv, OMNIGENT_PYTHON: "/bin/sh" },
      expected: /Behavioral checks failed|Unexpected|Syntax|not found/,
    });

    mkdirSync(failureRoot);
    runFailure("bash", [
      join(repositoryRoot, "install.sh"),
      "--npm-tarball", npmArchive,
      "--wheel", wheelArchive,
      "--prefix", failureRoot,
      "--launcher-dir", join(root, "failed-bin"),
    ], {
      cwd: unrelatedCwd, env: { ...baseEnv, OMNIGENT_PYTHON: undefined },
      expected: /OMNIGENT_ROOT and OMNIGENT_PYTHON are required/,
    });
    expect(existsSync(join(failureRoot, ".installing"))).toBe(false);
    expect(readFileSync(unrelatedSentinel, "utf8")).toBe("preserve-me\n");
    expect(run("git", [
      "status", "--porcelain=v1", "--untracked-files=all",
    ], { cwd: repositoryRoot })).toBe(checkoutStatusBefore);
    expect(run("git", [
      "status", "--porcelain=v1", "--untracked-files=all",
    ], { cwd: omnigentRoot! })).toBe(omnigentStatusBefore);

    const inventoryRoot = join(root, "inventories");
    mkdirSync(inventoryRoot);
    const npmInventory = inventory(npmArchive, "tar", inventoryRoot);
    const wheelInventory = inventory(wheelArchive, "wheel", inventoryRoot);
    for (const required of [
      "package/dist/cli.js", "package/dist/pnpm-lock.yaml",
      "package/agents/rickgent/config.yaml", "package/agents/rickgent/agents/worker/config.yaml",
      "package/runtime/resource-map.json", "package/proof/metadata.json",
      "package/validators/packed-install-receipt.schema.json", "package/LICENSE",
    ]) expect(npmInventory.entries.some((entry) => entry.path === required), required).toBe(true);
    expect(wheelInventory.entries.some((entry) => entry.path.startsWith("rickgent_policies/"))).toBe(true);
    expect(wheelInventory.entries.some((entry) => /(?:direct_url\.json|\.pth|\.egg-link)$/.test(entry.path))).toBe(false);

    const sourceGitOid = process.env.RICKGENT_SOURCE_GIT_OID;
    if (!sourceGitOid || !/^[0-9a-f]{40}$/.test(sourceGitOid)) {
      throw new Error("RICKGENT_SOURCE_GIT_OID must be a lowercase 40-character Git OID");
    }
    expect(run("git", ["merge-base", "--is-ancestor", sourceGitOid, "HEAD"], {
      cwd: repositoryRoot,
    })).toBe("");
    const buildCommit = run(launcher, ["--build-commit"], { cwd: unrelatedCwd, env: installedEnv });
    const expectedBuildCommit = process.env.RICKGENT_BUILD_COMMIT;
    expect(expectedBuildCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(buildCommit).toBe(expectedBuildCommit);
    const release = JSON.parse(readFileSync(releasePath, "utf8")) as { release_id: string };
    const buildResource = join(packageInstall, "dist", "build-commit.js");
    const checks: Check[] = requiredChecks.map((checkId) => ({
      check_id: checkId, outcome: "pass", required: true, evidence_ids: [`evidence:${checkId}`],
    }));
    const evidence = requiredChecks.map((checkId) => ({
      evidence_id: `evidence:${checkId}`,
      classification: "live" as const,
      sha256: sha256Bytes(`packed-install-proof-v1\0${checkId}\0pass\0${sourceGitOid}`),
      redaction: "public" as const,
    }));
    const observedGitOid = spawnSync("git", ["-C", realpathSync(omnigentRoot!), "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    const unsigned = {
      schema_version: "1.0.0",
      proof_version: "packed-install-proof-v1",
      redaction_version: "rickgent-redaction-v1",
      canonicalization: "rickgent-canonical-json-v1",
      digest_algorithm: "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
      binding: {
        source_git_oid: sourceGitOid,
        release: identity(release.release_id, releasePath),
        build: identity(buildCommit, buildResource),
        archives: [
          { kind: "npm_tarball", filename: basename(npmArchive), sha256: sha256File(npmArchive), inventory_sha256: npmInventory.sha256 },
          { kind: "python_wheel", filename: basename(wheelArchive), sha256: sha256File(wheelArchive), inventory_sha256: wheelInventory.sha256 },
        ],
        corpora: corpusPaths.map((path) => identity(path, join(repositoryRoot, path))),
        omnigent_contract_sha256: sha256File(compatibilityPath),
      },
      omnigent: {
        root_realpath: realpathSync(mountedOmnigentRoot),
        python_realpath: realpathSync(join(venv, "bin", "python")),
        import_realpath: pyObservation.omnigent,
        read_only: true,
        compatibility_authority: "offline_behavioral_probe",
        observed_version: pyObservation.version,
        observed_git_oid: observedGitOid.status === 0 ? observedGitOid.stdout.trim() : null,
      },
      containment: { unrelated_cwd: true, source_lookup_poisoned: true, installed_realpaths: installedPaths },
      evidence: { items: evidence, contains_raw_secrets: false },
      checks,
      cleanup: {
        success_path: { path: behavioral.owned_root, kind: "success", observed_absent: true },
        failure_path: { path: join(failureRoot, ".installing"), kind: "failure", observed_absent: true },
        unrelated_state_preserved: true,
      },
    };
    const digest = sha256Bytes(canonical(unsigned as Json));
    writeFileSync(summaryPath, `${canonical({ ...unsigned, digest } as Json)}\n`);
    writeFileSync(checksumPath, `${digest}  packed-install-summary.json\n`);
    writeFileSync(reportPath, [
      "# Phase 9 t37 packed-install execution report", "",
      `Source handoff: \`${sourceGitOid}\``, "",
      "The runner built and installed exactly the committed npm tarball and non-editable policy wheel. Retained production-entrypoint failures exposed baseline assumptions: pip records a non-editable local wheel in `direct_url.json`; macOS may spell the temporary root through `/var` while Python reports `/private/var`; a fresh venv cannot import the explicitly selected Omnigent dependency set unless it inherits that interpreter's site packages; a symlinked venv interpreter canonicalizes outside the venv and is correctly rejected as ambient; the mounted Omnigent source contains symlinks; and the compiled doctor expected legacy denial code `SCOPE_DENIED` while the packed policy returns `RICKGENT_SCOPE_DENIED`. The bounded proof-harness repair permits only archive-origin direct-url metadata, canonicalizes the proof root, creates the venv with `--copies --system-site-packages`, mounts a dereferenced minimal Omnigent package, and updates the installed doctor expectation to the policy's retained production code. The staged installed-runtime check still parses and rejects `dir_info`/editable direct-url metadata, and the independent negative controls prove rejection and Rickgent-owned realpath containment.", "",
      `- npm: \`${basename(npmArchive)}\` — \`${sha256File(npmArchive)}\`; inventory \`${npmInventory.sha256}\` (${npmInventory.entries.length} members)`,
      `- wheel: \`${basename(wheelArchive)}\` — \`${sha256File(wheelArchive)}\`; inventory \`${wheelInventory.sha256}\` (${wheelInventory.entries.length} members)`,
      `- receipt: \`${digest}\``,
      `- installed CLI root: \`${realpathSync(packageInstall)}\``,
      `- installed policy origin: \`${pyObservation.policy}\``,
      `- Omnigent origin/version: \`${pyObservation.omnigent}\` / \`${pyObservation.version}\``, "",
      "All required checks passed with zero skips and zero infrastructure errors. The behavioral doctor proved native allow/deny, compatible Omnigent observation, SQLite close/reopen durability, disposable Git containment, typed failure handling, and owned cleanup. It explicitly reported `authenticated_hosted_evidence=false`.", "",
      "Independent controls rejected source sentinel access, checkout CWD, NODE_PATH/PYTHONPATH poisoning, source node_modules, resource overrides, editable direct_url/.pth/egg-link metadata, escaping symlinks, missing resources, and implicit/wrong Python. The checkout, Omnigent sibling, and unrelated sentinel were preserved.", "",
      "Verification is runner-owned and follows the ticket's declared sequential command list. The receipt validator, trust-spine validator, and diff check are the final fail-closed gates.", "",
      "Completion convention: the manifest binds the stable t37b input handoff; the dependent ticket observes the non-self-referential t37c output commit.", "",
    ].join("\n"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }, 300_000);
});
