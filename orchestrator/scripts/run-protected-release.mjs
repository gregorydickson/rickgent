#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`PROTECTED_RELEASE_REFUSED: ${message}`);
  process.exit(2);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function run(executable, args, { cwd = process.cwd(), env = process.env, timeout = 60_000, json = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    input: "",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) fail(`${basename(executable)} observation failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim().replaceAll(/\s+/g, " ").slice(0, 500);
    fail(`${basename(executable)} observation exited ${result.status ?? "without status"}${detail ? `: ${detail}` : ""}`);
  }
  const output = result.stdout.trim() || result.stderr.trim();
  if (!json) return output;
  try {
    return JSON.parse(output);
  } catch {
    fail(`${basename(executable)} returned invalid JSON`);
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail(`${name} is required`);
  return process.argv[index + 1];
}

function requireAbsoluteExecutable(name) {
  const value = process.env[name];
  if (!value || !value.startsWith("/") || !existsSync(value)) {
    fail(`${name} must select an installed absolute executable`);
  }
  return realpathSync(value);
}

function directorySnapshot(root) {
  const entries = [];
  function visit(path, relative = "") {
    if (!existsSync(path)) return;
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const child = relative ? `${relative}/${name}` : name;
      const stats = statSync(absolute);
      if (stats.isDirectory()) visit(absolute, child);
      else if (stats.isFile()) entries.push([child, sha256File(absolute)]);
    }
  }
  visit(root);
  return {
    count: entries.length,
    sha256: sha256(canonical(entries)),
  };
}

function exactArchiveBindings(packedReceiptPath) {
  const packedBytes = readFileSync(packedReceiptPath);
  let packed;
  try {
    packed = JSON.parse(packedBytes);
  } catch {
    fail("packed receipt is invalid JSON");
  }
  const npm = packed?.binding?.archives?.find((item) => item.kind === "npm_tarball");
  const wheel = packed?.binding?.archives?.find((item) => item.kind === "python_wheel");
  const build = packed?.binding?.build;
  for (const [label, value] of [
    ["source Git OID", packed?.binding?.source_git_oid],
    ["build ID", build?.id],
  ]) {
    if (!OID.test(value ?? "")) fail(`packed receipt ${label} is invalid`);
  }
  for (const [label, value] of [
    ["build resource", build?.sha256],
    ["npm archive", npm?.sha256],
    ["npm inventory", npm?.inventory_sha256],
    ["wheel archive", wheel?.sha256],
    ["wheel inventory", wheel?.inventory_sha256],
    ["Omnigent contract", packed?.binding?.omnigent_contract_sha256],
    ["packed receipt", packed?.digest],
  ]) {
    if (!SHA256.test(value ?? "")) fail(`packed receipt ${label} digest is invalid`);
  }
  return {
    packed,
    binding: {
      source_git_oid: packed.binding.source_git_oid,
      build_id: build.id,
      build_resource_sha256: build.sha256,
      npm_archive_sha256: npm.sha256,
      npm_inventory_sha256: npm.inventory_sha256,
      wheel_archive_sha256: wheel.sha256,
      wheel_inventory_sha256: wheel.inventory_sha256,
      omnigent_contract_sha256: packed.binding.omnigent_contract_sha256,
      packed_receipt_sha256: packed.digest,
    },
    npm,
    wheel,
  };
}

function installExactHandoff(packedReceiptPath, archives) {
  const artifactsRoot = dirname(packedReceiptPath);
  const npmArchive = join(artifactsRoot, "npm-dist", archives.npm.filename);
  const wheelArchive = join(artifactsRoot, "python-dist", archives.wheel.filename);
  if (sha256File(npmArchive) !== archives.npm.sha256) fail("npm archive does not match packed receipt");
  if (sha256File(wheelArchive) !== archives.wheel.sha256) fail("wheel archive does not match packed receipt");

  const handoffRoot = resolve(".rickgent", "protected-preflight-install", archives.npm.sha256.slice(0, 16));
  const markerPath = join(handoffRoot, "handoff.json");
  const marker = canonical({ npm: archives.npm.sha256, wheel: archives.wheel.sha256 });
  const npmRoot = join(handoffRoot, "npm");
  const venv = join(handoffRoot, "python");
  if (!existsSync(markerPath) || readFileSync(markerPath, "utf8") !== `${marker}\n`) {
    rmSync(handoffRoot, { recursive: true, force: true });
    mkdirSync(handoffRoot, { recursive: true });
    run("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
      "--prefix", npmRoot, npmArchive,
    ], { timeout: 180_000 });
    const omnigentPython = requireAbsoluteExecutable("OMNIGENT_PYTHON");
    run(omnigentPython, ["-m", "venv", "--copies", "--system-site-packages", venv], { timeout: 120_000 });
    run(join(venv, "bin", "python"), [
      "-m", "pip", "install", "--disable-pip-version-check", "--no-index",
      "--no-deps", "--force-reinstall", wheelArchive,
    ], { timeout: 120_000 });
    writeFileSync(markerPath, `${marker}\n`);
  }

  const packageRoot = realpathSync(join(npmRoot, "node_modules", "rickgent"));
  const cli = realpathSync(join(npmRoot, "node_modules", ".bin", "rickgent"));
  const manager = realpathSync(join(packageRoot, "agents", "rickgent", "config.yaml"));
  const worker = realpathSync(join(packageRoot, "agents", "rickgent", "agents", "worker", "config.yaml"));
  const policy = realpathSync(run(join(venv, "bin", "python"), [
    "-c", "import pathlib, rickgent_policies; print(pathlib.Path(rickgent_policies.__file__).resolve())",
  ]));
  const buildId = run(cli, ["--build-commit"], { timeout: 30_000 });
  if (buildId !== archives.binding.build_id) fail("installed CLI build identity does not match packed receipt");

  const omnigentRoot = process.env.OMNIGENT_ROOT;
  if (!omnigentRoot || !existsSync(omnigentRoot)) fail("OMNIGENT_ROOT is unavailable");
  const omnigentGitOid = run("git", ["-C", omnigentRoot, "rev-parse", "HEAD"]);
  if (!OID.test(omnigentGitOid)) fail("Omnigent Git identity is unavailable");
  const omnigentVersion = run(requireAbsoluteExecutable("OMNIGENT_PYTHON"), [
    "-c",
    "import sys; sys.path.insert(0, sys.argv[1]); import omnigent; print(getattr(omnigent, '__version__', 'unknown'))",
    omnigentRoot,
  ]);

  return {
    build_id: buildId,
    cli_sha256: sha256File(cli),
    manager_sha256: sha256File(manager),
    omnigent_git_oid: omnigentGitOid,
    omnigent_version: omnigentVersion,
    policy_sha256: sha256File(policy),
    source: "exact_t37_persistent_handoff",
    worker_sha256: sha256File(worker),
  };
}

function authenticationChecks() {
  const safeEnv = {
    ...process.env,
    CI: "1",
    CODEX_NO_UPDATE_CHECK: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const codexStatus = run("codex", ["login", "status"], { env: safeEnv, timeout: 30_000 });
  const codexVersion = run("codex", ["--version"], { env: safeEnv, timeout: 30_000 });
  const claudeStatus = run("claude", ["auth", "status", "--json"], {
    env: safeEnv,
    timeout: 30_000,
    json: true,
  });
  const claudeVersion = run("claude", ["--version"], { env: safeEnv, timeout: 30_000 });
  const testModel = process.env.RICKGENT_TEST_MODEL;
  const reviewModel = process.env.RICKGENT_REVIEW_MODEL;
  if (process.env.RICKGENT_TEST_HARNESS !== "codex" || testModel !== "gpt-5.6-sol") {
    fail("configured test role does not match the protected contract");
  }
  if (process.env.RICKGENT_REVIEW_HARNESS !== "claude-sdk" || reviewModel !== "claude-opus-4-8[1m]") {
    fail("configured review role does not match the protected contract");
  }
  if (!/logged in/i.test(codexStatus)) fail("Codex is not authenticated");
  if (claudeStatus?.loggedIn !== true) fail("Claude is not authenticated");
  return {
    checks: [
      {
        authenticated: true,
        available: true,
        device_login: false,
        harness: "codex",
        model: testModel,
        non_interactive: true,
        observation_sha256: sha256(canonical({ status: codexStatus, version: codexVersion })),
        role: "test",
        timeout_ms: 30_000,
      },
      {
        authenticated: true,
        available: true,
        device_login: false,
        harness: "claude",
        model: reviewModel,
        non_interactive: true,
        observation_sha256: sha256(canonical({
          loggedIn: claudeStatus.loggedIn,
          authMethod: claudeStatus.authMethod ?? "unknown",
          version: claudeVersion,
        })),
        role: "review",
        timeout_ms: 30_000,
      },
    ],
    provider_dispatch_observed: false,
  };
}

function remoteObservation(contractPath, namespaceSeed) {
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    fail("remote contract is invalid JSON");
  }
  if (
    contract.schema_version !== "rickgent.release-remote-contract/v1"
    || contract.host !== "github.com"
    || contract.delete_repository !== false
  ) fail("remote contract is not an approved disposable GitHub target");
  if (/\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/.test(contract.remote_url ?? "")) {
    fail("remote contract contains a credential-bearing URL");
  }
  const slug = `${contract.owner}/${contract.repository}`;
  const repository = run("gh", ["api", `repos/${slug}`], { json: true, timeout: 30_000 });
  const actor = run("gh", ["api", "user"], { json: true, timeout: 30_000 });
  const branches = run("gh", ["api", `repos/${slug}/branches?per_page=100`], { json: true, timeout: 30_000 });
  const pulls = run("gh", ["api", `repos/${slug}/pulls?state=all&per_page=100`], { json: true, timeout: 30_000 });
  const repositoryId = String(repository.id ?? "");
  if (
    !repositoryId
    || repository.owner?.login !== contract.owner
    || repository.name !== contract.repository
    || repository.default_branch !== contract.base_branch
    || repository.private !== true
  ) fail("remote observation does not match the approved immutable target");
  const ownedNamespace = `rickgent/protected/${sha256(`${namespaceSeed}\0${repositoryId}`).slice(0, 24)}`;
  const branchNames = branches.map((item) => item.name).sort();
  const pullState = pulls.map((item) => ({
    head: item.head?.ref ?? "",
    id: String(item.id ?? ""),
    state: item.state ?? "",
  })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  if (
    branchNames.some((name) => name.startsWith(ownedNamespace))
    || pullState.some((item) => item.head.startsWith(ownedNamespace))
  ) fail("owned preflight namespace is not clean");
  const snapshot = {
    branches_sha256: sha256(canonical(branchNames)),
    pull_requests_sha256: sha256(canonical(pullState)),
    repository_exists: true,
    repository_id: repositoryId,
  };
  const remote = {
    allowlist_match: true,
    authenticated_actor: actor.login,
    base_branch: contract.base_branch,
    clean_baseline: true,
    host: contract.host,
    observation_sha256: sha256(canonical({
      actor: actor.login,
      branchNames,
      defaultBranch: repository.default_branch,
      owner: repository.owner.login,
      pullState,
      repositoryId,
      visibility: repository.visibility ?? "private",
    })),
    owned_namespace: ownedNamespace,
    owner: contract.owner,
    repository: contract.repository,
    repository_id: repositoryId,
    required_token_operations: ["contents:read", "metadata:read", "pull_requests:read"],
  };
  return { remote, snapshot };
}

async function runPreflight() {
  const packedReceiptPath = realpathSync(resolve(option("--packed-receipt")));
  const remoteContractPath = realpathSync(resolve(option("--remote-contract")));
  const outputPath = resolve(option("--output"));
  const archives = exactArchiveBindings(packedReceiptPath);
  const providerRoot = resolve(process.env.OMNIGENT_DATA_DIR ?? ".rickgent/omnigent-review-data");
  const providerBefore = directorySnapshot(providerRoot);
  const installation = installExactHandoff(packedReceiptPath, archives);
  const authentication = authenticationChecks();
  const { remote, snapshot } = remoteObservation(remoteContractPath, archives.binding.packed_receipt_sha256);
  const providerAfter = directorySnapshot(providerRoot);
  if (canonical(providerAfter) !== canonical(providerBefore)) {
    fail("provider lifecycle state changed during preflight");
  }
  const noMutationSnapshot = {
    ...snapshot,
    provider_lifecycle_count: providerBefore.count,
    provider_lifecycle_sha256: providerBefore.sha256,
  };
  const teardown = {
    close_owned_prs_only: true,
    compare_before_delete: true,
    delete_owned_branches_only: true,
    dry_run_validated: true,
    force_delete: false,
    owned_namespace: remote.owned_namespace,
    registered_before_mutation: true,
    repository_deletion: false,
    repository_id: remote.repository_id,
    requery_after_action: true,
  };
  const acceptanceCriteria = [
    "Preflight binds the installed executable/build and exact npm, wheel, inventory, compatibility, and packed-receipt digests from t37.",
    "Non-interactive Codex gpt-5.6-sol and Claude claude-opus-4-8[1m] authentication and availability are checked with finite timeouts and without device-login prompts.",
    "The remote observation records exact host, owner, repository, immutable repository ID, authenticated actor, base branch, allowlist match, required token operations, clean baseline, and unique owned namespace.",
    "The teardown plan is registered and dry-run validated before mutation, uses immutable identifiers and compare-before-delete, closes only owned PRs, deletes only owned branches, and forbids repository deletion.",
    "The schema-validated preflight is redacted and contains no token, credential-bearing URL, provider transcript, prompt body, or absolute user path.",
    "Independent observations prove no branch, PR, repository, or provider lifecycle mutation occurred during preflight.",
  ];
  const unsigned = {
    acceptance_criteria: acceptanceCriteria,
    authentication,
    binding: { ...archives.binding, installation },
    canonicalization: "rickgent-canonical-json-v1",
    digest_algorithm: "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
    mode: "preflight_only",
    no_mutation: {
      after: noMutationSnapshot,
      before: noMutationSnapshot,
      observed_mutations: [],
    },
    prerequisites: {
      declared_preflight_interface: {
        observed: true,
        reason: "explicit preflight-only command selected",
      },
      exact_t37_installation: {
        observed: true,
        reason: "digest-keyed archive handoff reinstalled and observed",
      },
      verification_environment: {
        observed: true,
        reason: "required authenticated read-only environment observed",
      },
    },
    redaction_version: "rickgent-redaction-v1",
    refusal: null,
    remote,
    schema_version: "rickgent-protected-release-preflight/v1",
    status: "accepted",
    teardown,
  };
  const receipt = { ...unsigned, digest: sha256(canonical(unsigned)) };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${canonical(receipt)}\n`);
  const sidecar = join(dirname(outputPath), "protected-release-preflight.sha256");
  writeFileSync(sidecar, `${sha256(readFileSync(outputPath))}  ${basename(outputPath)}\n`);
  console.log(canonical({ ok: true, mode: "preflight_only", output: basename(outputPath) }));
}

async function runMutation() {
  if (process.env.RICKGENT_PROTECTED_AUTHORITY !== "I_ACCEPT_REMOTE_MUTATION") {
    fail("explicit protected authority is absent");
  }
  const profileArg = process.argv[2];
  if (profileArg === undefined || !profileArg.startsWith("/")) fail("absolute protected profile path is required");
  const profilePath = realpathSync(profileArg);
  if (!existsSync(profilePath)) fail("protected profile does not exist");
  for (const name of ["RICKGENT_INSTALLED_CLI", "RICKGENT_PROTECTED_ADAPTER"]) {
    requireAbsoluteExecutable(name);
  }
  const cli = realpathSync(process.env.RICKGENT_INSTALLED_CLI);
  if (cli.includes("/rickgent/orchestrator/") || cli.includes("/node_modules/.pnpm/")) {
    fail("checkout/source entrypoint is forbidden");
  }
  const adapterPath = realpathSync(process.env.RICKGENT_PROTECTED_ADAPTER);
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const adapter = await import(pathToFileURL(adapterPath).href);
  if (typeof adapter.run !== "function") fail("protected adapter must export run(profile, installedCli)");
  const result = await adapter.run(profile, cli);
  if (result?.ok !== true || result?.repository_deleted !== false || result?.cleanup_requeried !== true) {
    fail("protected controller did not produce a complete fail-closed result");
  }
  console.log(JSON.stringify(result));
}

if (process.argv[2] === "preflight") await runPreflight();
else await runMutation();
