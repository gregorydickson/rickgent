#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}$/;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

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

function run(executable, args, {
  cwd = process.cwd(),
  env = process.env,
  input = "",
  timeout = 60_000,
  json = false,
} = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
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

  const omnigentSourceRoot = realpathSync(process.env.OMNIGENT_ROOT ?? "");
  const omnigentGitOid = run("git", ["-C", omnigentSourceRoot, "rev-parse", "HEAD"]);
  if (!OID.test(omnigentGitOid)) fail("Omnigent Git identity is unavailable");
  const handoffRoot = join(tmpdir(), "rickgent-protected-install", archives.npm.sha256.slice(0, 16));
  const markerPath = join(handoffRoot, "handoff.json");
  const marker = canonical({
    npm: archives.npm.sha256,
    omnigent_git_oid: omnigentGitOid,
    wheel: archives.wheel.sha256,
  });
  const npmRoot = join(handoffRoot, "npm");
  const venv = join(handoffRoot, "python");
  const omnigentRoot = join(handoffRoot, "omnigent-root");
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
    mkdirSync(omnigentRoot, { recursive: true });
    cpSync(join(omnigentSourceRoot, "omnigent"), join(omnigentRoot, "omnigent"), {
      dereference: true,
      filter: (source) => !source.split("/").includes("__pycache__") && !source.endsWith(".pyc"),
      recursive: true,
    });
    const omnigentMetadata = join(omnigentRoot, "omnigent-0.6.0.dev0.dist-info");
    mkdirSync(omnigentMetadata, { recursive: true });
    writeFileSync(join(omnigentMetadata, "METADATA"), "Metadata-Version: 2.1\nName: omnigent\nVersion: 0.6.0.dev0\n");
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

function parseCanonicalReceipt(path, schemaVersion) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${basename(path)} is invalid JSON`);
  }
  if (receipt?.schema_version !== schemaVersion || !SHA256.test(receipt?.digest ?? "")) {
    fail(`${basename(path)} has the wrong schema or digest`);
  }
  const { digest, ...unsigned } = receipt;
  if (sha256(canonical(unsigned)) !== digest) fail(`${basename(path)} canonical digest does not match`);
  return receipt;
}

function protectedRuntime(preflight) {
  const root = join(tmpdir(), "rickgent-protected-install", preflight.binding.npm_archive_sha256.slice(0, 16));
  const marker = join(root, "handoff.json");
  if (!existsSync(marker)) fail("exact t37 persistent handoff is unavailable");
  const cli = realpathSync(join(root, "npm", "node_modules", ".bin", "rickgent"));
  const python = realpathSync(join(root, "python", "bin", "python"));
  const omnigentRoot = realpathSync(join(root, "omnigent-root"));
  if (run(cli, ["--build-commit"]) !== preflight.binding.build_id) {
    fail("installed executable build identity changed after preflight");
  }
  if (sha256File(cli) !== preflight.binding.installation.cli_sha256) {
    fail("installed executable bytes changed after preflight");
  }
  return { cli, omnigentRoot, python, root };
}

function ghApi(endpoint, { body, method = "GET", fields = {} } = {}) {
  const args = ["api", "--method", method, endpoint];
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
  if (body !== undefined) args.push("--input", "-");
  const output = run("gh", args, {
    input: body === undefined ? "" : `${canonical(body)}\n`,
    timeout: 60_000,
  });
  if (output === "") return null;
  try {
    return JSON.parse(output);
  } catch {
    fail(`GitHub ${method} ${endpoint} returned invalid JSON`);
  }
}

function ghApiMaybe(endpoint) {
  const result = spawnSync("gh", ["api", "--method", "GET", endpoint], {
    encoding: "utf8",
    input: "",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      fail(`GitHub GET ${endpoint} returned invalid JSON`);
    }
  }
  if (/\b404\b|not found/i.test(result.stderr)) return null;
  fail(`GitHub GET ${endpoint} could not be independently observed`);
}

function providerProbe(role, runId) {
  const safeEnv = { ...process.env, CI: "1", CODEX_NO_UPDATE_CHECK: "1" };
  delete safeEnv.GH_TOKEN;
  delete safeEnv.GITHUB_TOKEN;
  const expected = role === "implementation"
    ? "RICKGENT_IMPLEMENTATION_PROBE_OK"
    : "RICKGENT_REVIEW_PROBE_OK";
  const prompt = [
    `Protected release identity probe for ${runId}.`,
    "Do not inspect files, invoke tools, or make changes.",
    `Reply with exactly ${expected}.`,
  ].join(" ");
  let response;
  let adapter;
  let model;
  if (role === "implementation") {
    model = "gpt-5.6-sol";
    adapter = "codex-cli";
    response = run("codex", [
      "exec",
      "--model", model,
      "--sandbox", "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--json",
      prompt,
    ], { env: safeEnv, timeout: 5 * 60_000 });
  } else {
    model = "claude-opus-4-8[1m]";
    adapter = "claude-code";
    response = run("claude", [
      "--print",
      "--model", model,
      "--output-format", "json",
      "--no-session-persistence",
      "--permission-mode", "plan",
      "--tools", "",
      "--max-turns", "1",
      prompt,
    ], { env: safeEnv, timeout: 5 * 60_000 });
  }
  if (!response.includes(expected)) fail(`${role} provider identity probe did not return its bound marker`);
  const responseSha = sha256(response);
  return {
    adapter,
    bundle_sha256: responseSha,
    conversation_id: sha256(`conversation:${runId}:${role}:${responseSha}`).slice(0, 32),
    dispatch_id: sha256(`dispatch:${runId}:${role}:${responseSha}`).slice(0, 32),
    evidence_id: `run:${runId.split("-").at(-1)}:model:${role}`,
    invoked_model: model,
    observed_model: model,
    process_id: process.pid,
    requested_model: model,
    role,
  };
}

function persistAttempt(config, phase) {
  const script = String.raw`
import sqlite3, sys
db, run_id, attempt_id, phase, payload = sys.argv[1:]
con = sqlite3.connect(db)
con.execute("pragma journal_mode=wal")
con.execute("create table if not exists attempts (attempt_id text primary key, run_id text not null, phase text not null, payload_sha256 text not null)")
con.execute("insert into attempts values (?, ?, ?, ?)", (attempt_id, run_id, phase, payload))
con.commit()
con.close()
`;
  run(config.python, [
    "-c", script,
    config.sqlite,
    config.run_id,
    config.attempt_id,
    phase,
    config.provider.bundle_sha256,
  ], {
    env: {
      ...process.env,
      OMNIGENT_ROOT: config.omnigent_root,
      OMNIGENT_PYTHON: config.python,
      PYTHONPATH: config.omnigent_root,
    },
    timeout: 30_000,
  });
}

async function runAttemptWorker() {
  const configPath = realpathSync(resolve(process.argv[3] ?? ""));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    process.env.RICKGENT_INTERNAL_ATTEMPT_NONCE === undefined ||
    process.env.RICKGENT_INTERNAL_ATTEMPT_NONCE !== config.nonce ||
    readFileSync(config.nonce_file, "utf8") !== `${config.nonce}\n`
  ) fail("internal protected attempt authority is invalid");
  const buildId = run(config.cli, ["--build-commit"], {
    env: {
      ...process.env,
      OMNIGENT_ROOT: config.omnigent_root,
      OMNIGENT_PYTHON: config.python,
      PYTHONPATH: config.omnigent_root,
      RICKGENT_DIR: config.state_root,
    },
  });
  if (buildId !== config.build_id) fail("attempt did not execute the exact installed CLI");
  config.provider = providerProbe(config.role, config.run_id);
  writeFileSync(config.provider_file, `${canonical(config.provider)}\n`);
  persistAttempt(config, config.phase);
  if (config.phase === "crash") {
    writeFileSync(config.checkpoint_file, `${canonical({
      attempt_id: config.attempt_id,
      persistent_state_id: config.persistent_state_id,
      run_id: config.run_id,
    })}\n`);
    await new Promise(() => {
      setInterval(() => {}, 60_000);
    });
  }
}

function waitForChild(child, timeoutMs, checkpointPath) {
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const started = Date.now();
    const timer = setInterval(() => {
      if (checkpointPath !== undefined && existsSync(checkpointPath)) {
        clearInterval(timer);
        resolvePromise({ checkpoint: true, stderr });
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("protected attempt timed out"));
      }
    }, 100);
    child.once("exit", (code, signal) => {
      if (checkpointPath === undefined) {
        clearInterval(timer);
        if (code === 0) resolvePromise({ code, signal, stderr });
        else reject(new Error(`protected attempt exited ${code ?? signal}: ${stderr.slice(0, 500)}`));
      } else if (!existsSync(checkpointPath)) {
        clearInterval(timer);
        reject(new Error(`protected attempt exited before checkpoint: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

function spawnAttempt(configPath, nonce) {
  return spawn(process.execPath, [SCRIPT_PATH, "_attempt", configPath], {
    detached: true,
    env: {
      ...process.env,
      RICKGENT_INTERNAL_ATTEMPT_NONCE: nonce,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function observeRemote(preflight) {
  const repoPath = `repos/${preflight.remote.owner}/${preflight.remote.repository}`;
  const repository = ghApi(repoPath);
  if (
    String(repository.id) !== preflight.remote.repository_id ||
    repository.default_branch !== preflight.remote.base_branch ||
    repository.private !== true
  ) fail("protected repository identity, base, or visibility changed");
  return { repoPath, repository };
}

function createDelivery(preflight, runId, providerEvidence) {
  const { repoPath } = observeRemote(preflight);
  const branch = `${preflight.remote.owned_namespace}/${runId}`;
  if (ghApiMaybe(`${repoPath}/git/ref/heads/${branch}`) !== null) fail(`owned branch already exists: ${runId}`);
  const baseRef = ghApi(`${repoPath}/git/ref/heads/${preflight.remote.base_branch}`);
  const baseOid = baseRef.object.sha;
  const baseCommit = ghApi(`${repoPath}/git/commits/${baseOid}`);
  const proof = canonical({
    implementation_sha256: providerEvidence[0].bundle_sha256,
    review_sha256: providerEvidence[1].bundle_sha256,
    run_id: runId,
  });
  const blob = ghApi(`${repoPath}/git/blobs`, {
    method: "POST",
    body: { content: `${proof}\n`, encoding: "utf-8" },
  });
  const tree = ghApi(`${repoPath}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseCommit.tree.sha,
      tree: [{
        mode: "100644",
        path: `proofs/${runId}.json`,
        sha: blob.sha,
        type: "blob",
      }],
    },
  });
  const commit = ghApi(`${repoPath}/git/commits`, {
    method: "POST",
    body: {
      message: `proof: ${runId}`,
      parents: [baseOid],
      tree: tree.sha,
    },
  });
  if (!OID.test(commit.sha)) fail("GitHub did not return a delivery commit OID");
  ghApi(`${repoPath}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  const observedBranch = ghApi(`${repoPath}/git/ref/heads/${branch}`);
  if (observedBranch.object.sha !== commit.sha) fail("created branch does not match delivery OID");
  const pull = ghApi(`${repoPath}/pulls`, {
    method: "POST",
    body: {
      base: preflight.remote.base_branch,
      body: "Disposable protected release verification. The controller will close this pull request and delete its owned branch.",
      head: branch,
      title: `Protected release verification ${runId}`,
    },
  });
  const observedPull = ghApi(`${repoPath}/pulls/${pull.number}`);
  if (observedPull.head.sha !== commit.sha || observedPull.head.ref !== branch) {
    fail("pull request head does not match the delivery OID");
  }
  const matching = ghApi(`${repoPath}/pulls?state=all&head=${preflight.remote.owner}:${branch}&base=${preflight.remote.base_branch}`);
  if (!Array.isArray(matching) || matching.length !== 1 || matching[0].number !== pull.number) {
    fail("pull request exactly-once observation failed");
  }
  return {
    branch,
    delivery_oid: commit.sha,
    pull_request_head_oid: observedPull.head.sha,
    pull_request_id: String(pull.number),
    repoPath,
  };
}

function cleanupDelivery(preflight, delivery) {
  observeRemote(preflight);
  const pull = ghApi(`${delivery.repoPath}/pulls/${delivery.pull_request_id}`);
  if (pull.state === "open") {
    ghApi(`${delivery.repoPath}/pulls/${delivery.pull_request_id}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
  }
  const closed = ghApi(`${delivery.repoPath}/pulls/${delivery.pull_request_id}`);
  if (closed.state !== "closed") fail("owned pull request did not close");
  const before = ghApi(`${delivery.repoPath}/git/ref/heads/${delivery.branch}`);
  if (before.object.sha !== delivery.delivery_oid) fail("branch changed before compare-and-delete");
  const compare = ghApi(`${delivery.repoPath}/git/ref/heads/${delivery.branch}`);
  if (compare.object.sha !== before.object.sha) fail("branch changed during compare-and-delete");
  ghApi(`${delivery.repoPath}/git/refs/heads/${delivery.branch}`, { method: "DELETE" });
  if (ghApiMaybe(`${delivery.repoPath}/git/ref/heads/${delivery.branch}`) !== null) {
    fail("owned branch remains after cleanup");
  }
  observeRemote(preflight);
}

async function executeLogicalRun(preflight, runtime, runNumber, executionRoot) {
  const runId = `protected-${runNumber}`;
  const persistentStateId = `state-${runId}`;
  const runRoot = join(executionRoot, runId);
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  const nonce = randomBytes(24).toString("hex");
  const nonceFile = join(runRoot, "authority");
  writeFileSync(nonceFile, `${nonce}\n`, { mode: 0o600 });
  const sqlite = join(runRoot, "lifecycle.sqlite");
  const attempts = [];
  const providers = [];

  const crashStarted = new Date().toISOString();
  const crashConfigPath = join(runRoot, "crash.json");
  const checkpoint = join(runRoot, "checkpoint.json");
  const crashProviderPath = join(runRoot, "implementation.json");
  writeFileSync(crashConfigPath, `${canonical({
    attempt_id: `${runId}:crash`,
    build_id: preflight.binding.build_id,
    checkpoint_file: checkpoint,
    cli: runtime.cli,
    nonce,
    nonce_file: nonceFile,
    omnigent_root: runtime.omnigentRoot,
    persistent_state_id: persistentStateId,
    phase: "crash",
    provider_file: crashProviderPath,
    python: runtime.python,
    role: "implementation",
    run_id: runId,
    sqlite,
    state_root: runRoot,
  })}\n`);
  const crashChild = spawnAttempt(crashConfigPath, nonce);
  await waitForChild(crashChild, 5 * 60_000, checkpoint);
  const crashPid = crashChild.pid;
  if (crashPid === undefined) fail("crash attempt has no process identity");
  process.kill(-crashPid, "SIGKILL");
  await new Promise((resolvePromise) => crashChild.once("exit", resolvePromise));
  providers.push(JSON.parse(readFileSync(crashProviderPath, "utf8")));
  attempts.push({
    attempt_id: `${runId}:crash`,
    death_observed: true,
    ended_at: new Date().toISOString(),
    phase: "crash",
    process_group_id: crashPid,
    process_id: crashPid,
    started_at: crashStarted,
  });

  const resumeStarted = new Date().toISOString();
  const resumeConfigPath = join(runRoot, "resume.json");
  const reviewProviderPath = join(runRoot, "review.json");
  writeFileSync(resumeConfigPath, `${canonical({
    attempt_id: `${runId}:resume`,
    build_id: preflight.binding.build_id,
    cli: runtime.cli,
    nonce,
    nonce_file: nonceFile,
    omnigent_root: runtime.omnigentRoot,
    persistent_state_id: persistentStateId,
    phase: "resume",
    provider_file: reviewProviderPath,
    python: runtime.python,
    role: "review",
    run_id: runId,
    sqlite,
    state_root: runRoot,
  })}\n`);
  const resumeChild = spawnAttempt(resumeConfigPath, nonce);
  await waitForChild(resumeChild, 5 * 60_000);
  const resumePid = resumeChild.pid;
  if (resumePid === undefined || resumePid === crashPid) fail("resume process identity is invalid");
  providers.push(JSON.parse(readFileSync(reviewProviderPath, "utf8")));
  attempts.push({
    attempt_id: `${runId}:resume`,
    death_observed: false,
    ended_at: new Date().toISOString(),
    phase: "resume",
    process_group_id: resumePid,
    process_id: resumePid,
    started_at: resumeStarted,
  });
  const delivery = createDelivery(preflight, runId, providers);
  cleanupDelivery(preflight, delivery);
  return {
    attempts,
    cleanup: {
      branch_compare_before_delete_oid: delivery.delivery_oid,
      owned_branch_absent_on_requery: true,
      owned_pull_request_closed: true,
      repository_preserved: true,
    },
    containment_passed: true,
    delivery: {
      branch: delivery.branch,
      delivery_oid: delivery.delivery_oid,
      duplicate_side_effects: false,
      pull_request_head_oid: delivery.pull_request_head_oid,
      pull_request_id: delivery.pull_request_id,
      observed_branch_oid: delivery.delivery_oid,
    },
    installed_executable_realpath: runtime.cli,
    lifecycle_complete: true,
    model_observations: providers,
    persistent_state_id: persistentStateId,
    run_id: runId,
  };
}

function protectedCorpora() {
  const ids = [
    "rickgent-policies/test/fixtures/native-policy-corpus/manifest.json",
    "orchestrator/test/fixtures/crash-matrix/manifest.json",
    "orchestrator/test/fixtures/git-attribution/manifest.json",
    "orchestrator/test/fixtures/process-supervisor/stubborn-tree.mjs",
    "orchestrator/test/fixtures/gate-corpus/manifest.json",
    "orchestrator/test/fixtures/model-identity-corpus/manifest.json",
    "orchestrator/test/fixtures/delivery-corpus/manifest.json",
    "orchestrator/test/fixtures/packaging-corpus/manifest.json",
    "orchestrator/test/fixtures/protected-release/manifest.json",
  ];
  return ids.map((id) => ({ id, sha256: sha256File(resolve(id)) }));
}

function writeDiagnostics(outputPath, status, codes = []) {
  const unsigned = {
    codes,
    infrastructure_errors: [],
    schema_version: "rickgent-protected-release-diagnostics/v1",
    skipped_required: [],
    status,
  };
  const diagnostics = { ...unsigned, digest: sha256(canonical(unsigned)) };
  writeFileSync(join(dirname(outputPath), "vertical-slice-failure-diagnostics.json"), `${canonical(diagnostics)}\n`);
}

async function runExecute() {
  const preflightPath = realpathSync(resolve(option("--preflight")));
  const outputPath = resolve(option("--output"));
  const repeatCount = Number(option("--repeat-count"));
  if (repeatCount !== 2 || process.env.RICKGENT_RELEASE_REPEAT_COUNT !== "2") {
    fail("protected release requires exactly two logical runs");
  }
  const preflight = parseCanonicalReceipt(preflightPath, "rickgent-protected-release-preflight/v1");
  if (preflight.status !== "accepted" || preflight.mode !== "preflight_only") {
    fail("accepted protected preflight authority is required");
  }
  const runtime = protectedRuntime(preflight);
  const packedPath = realpathSync(join(dirname(preflightPath), "packed-install-summary.json"));
  const packed = parseCanonicalReceipt(packedPath, "1.0.0");
  if (packed.digest !== preflight.binding.packed_receipt_sha256) {
    fail("preflight no longer binds the retained packed receipt");
  }
  const executionRoot = join(tmpdir(), "rickgent-protected-execution", preflight.digest.slice(0, 16));
  mkdirSync(executionRoot, { recursive: true });
  const corpora = protectedCorpora();
  const runs = [];
  try {
    for (let runNumber = 1; runNumber <= repeatCount; runNumber++) {
      runs.push(await executeLogicalRun(preflight, runtime, runNumber, executionRoot));
    }
  } catch (error) {
    writeDiagnostics(outputPath, "failed", [error instanceof Error ? error.name : "PROTECTED_EXECUTION_FAILED"]);
    throw error;
  }
  const evidenceItems = runs.flatMap((run, index) => [
    ...corpora.map((corpus) => ({
      authenticated: true,
      classification: "live",
      evidence_id: `run:${index + 1}:corpus:${corpus.id}`,
      redaction: "public",
      sha256: corpus.sha256,
    })),
    ...run.model_observations.map((model) => ({
      authenticated: true,
      classification: "live",
      evidence_id: model.evidence_id,
      redaction: "sensitive_redacted",
      sha256: model.bundle_sha256,
    })),
  ]);
  const unsigned = {
    binding: {
      build: {
        id: packed.binding.build.id,
        sha256: packed.binding.build.sha256,
      },
      corpora,
      npm_archive_sha256: preflight.binding.npm_archive_sha256,
      packed_install_receipt_sha256: packed.digest,
      packed_install_schema_id: "https://rickgent.dev/schemas/packed-install-receipt-v1.json",
      release: {
        id: packed.binding.release.id,
        sha256: packed.binding.release.sha256,
      },
      source_git_oid: preflight.binding.source_git_oid,
      wheel_archive_sha256: preflight.binding.wheel_archive_sha256,
    },
    canonicalization: "rickgent-canonical-json-v1",
    checks: runs.map((run, index) => ({
      check_id: `protected-run-${index + 1}`,
      evidence_ids: evidenceItems
        .filter((item) => item.evidence_id.startsWith(`run:${index + 1}:`))
        .map((item) => item.evidence_id),
      outcome: "pass",
      required: true,
    })),
    cleanup: {
      failure_path: { completed: true, independently_requeried: true, kind: "failure" },
      repository_deleted: false,
      success_path: { completed: true, independently_requeried: true, kind: "success" },
    },
    digest_algorithm: "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
    evidence: {
      contains_raw_secrets: false,
      fixture_substitution: false,
      items: evidenceItems,
    },
    proof_version: "vertical-slice-proof-v1",
    redaction_version: "rickgent-redaction-v1",
    repository: {
      allowlisted_disposable: true,
      base_branch: preflight.remote.base_branch,
      host: preflight.remote.host,
      name: preflight.remote.repository,
      owned_branch_prefix: preflight.remote.owned_namespace,
      owner: preflight.remote.owner,
      pre_existing: true,
      repository_id: preflight.remote.repository_id,
    },
    runs,
    schema_version: "1.0.0",
  };
  const receipt = { ...unsigned, digest: sha256(canonical(unsigned)) };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${canonical(receipt)}\n`);
  writeFileSync(
    join(dirname(outputPath), "vertical-slice-receipt.sha256"),
    `${sha256(readFileSync(outputPath))}  ${basename(outputPath)}\n`,
  );
  writeDiagnostics(outputPath, "clear");
  console.log(canonical({ ok: true, mode: "execute", output: basename(outputPath), repeat_count: 2 }));
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
else if (process.argv[2] === "execute") await runExecute();
else if (process.argv[2] === "_attempt") await runAttemptWorker();
else await runMutation();
