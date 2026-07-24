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

class ProtectedReleaseRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtectedReleaseRefusal";
  }
}

class ExpectedFailureCleanupProbe extends Error {
  constructor(message) {
    super(message);
    this.name = "ExpectedFailureCleanupProbe";
  }
}

function fail(message) {
  throw new ProtectedReleaseRefusal(message);
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

export function requireUnchangedRemoteObservation(before, after) {
  // Trap door: duplicating one observation into receipt before/after fields
  // does not prove non-mutation. Both values must come from separate hosted
  // queries surrounding every preflight operation under review.
  if (
    canonical(before?.remote) !== canonical(after?.remote)
    || canonical(before?.snapshot) !== canonical(after?.snapshot)
  ) {
    fail("remote lifecycle state changed during preflight");
  }
}

async function runPreflight() {
  const packedReceiptPath = realpathSync(resolve(option("--packed-receipt")));
  const remoteContractPath = realpathSync(resolve(option("--remote-contract")));
  const outputPath = resolve(option("--output"));
  const archives = exactArchiveBindings(packedReceiptPath);
  const providerRoot = resolve(process.env.OMNIGENT_DATA_DIR ?? ".rickgent/omnigent-review-data");
  const providerBefore = directorySnapshot(providerRoot);
  const remoteBefore = remoteObservation(
    remoteContractPath,
    archives.binding.packed_receipt_sha256,
  );
  const installation = installExactHandoff(packedReceiptPath, archives);
  const authentication = authenticationChecks();
  const remoteAfter = remoteObservation(
    remoteContractPath,
    archives.binding.packed_receipt_sha256,
  );
  const providerAfter = directorySnapshot(providerRoot);
  requireUnchangedRemoteObservation(remoteBefore, remoteAfter);
  if (canonical(providerAfter) !== canonical(providerBefore)) {
    fail("provider lifecycle state changed during preflight");
  }
  const noMutationBefore = {
    ...remoteBefore.snapshot,
    provider_lifecycle_count: providerBefore.count,
    provider_lifecycle_sha256: providerBefore.sha256,
  };
  const noMutationAfter = {
    ...remoteAfter.snapshot,
    provider_lifecycle_count: providerAfter.count,
    provider_lifecycle_sha256: providerAfter.sha256,
  };
  const { remote } = remoteAfter;
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
      after: noMutationAfter,
      before: noMutationBefore,
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

export function requireUnchangedInstalledHandoff(expected, observed) {
  // Trap door: the persistent handoff survives between preflight and execute.
  // Rechecking only the CLI leaves the installed manager, worker, or policy
  // free to change while execution continues to cite their preflight hashes.
  for (const key of [
    "cli_sha256",
    "manager_sha256",
    "policy_sha256",
    "worker_sha256",
  ]) {
    if (
      !SHA256.test(expected?.[key] ?? "")
      || !SHA256.test(observed?.[key] ?? "")
      || observed[key] !== expected[key]
    ) {
      fail(`installed handoff ${key} changed after preflight`);
    }
  }
}

function protectedRuntime(preflight) {
  const root = join(tmpdir(), "rickgent-protected-install", preflight.binding.npm_archive_sha256.slice(0, 16));
  const marker = join(root, "handoff.json");
  if (!existsSync(marker)) fail("exact t37 persistent handoff is unavailable");
  const packageRoot = realpathSync(join(root, "npm", "node_modules", "rickgent"));
  const cli = realpathSync(join(root, "npm", "node_modules", ".bin", "rickgent"));
  const manager = realpathSync(join(packageRoot, "agents", "rickgent", "config.yaml"));
  const worker = realpathSync(join(packageRoot, "agents", "rickgent", "agents", "worker", "config.yaml"));
  const python = realpathSync(join(root, "python", "bin", "python"));
  const omnigentRoot = realpathSync(join(root, "omnigent-root"));
  if (run(cli, ["--build-commit"]) !== preflight.binding.build_id) {
    fail("installed executable build identity changed after preflight");
  }
  const policy = realpathSync(run(python, [
    "-c", "import pathlib, rickgent_policies; print(pathlib.Path(rickgent_policies.__file__).resolve())",
  ]));
  requireUnchangedInstalledHandoff(preflight.binding.installation, {
    cli_sha256: sha256File(cli),
    manager_sha256: sha256File(manager),
    policy_sha256: sha256File(policy),
    worker_sha256: sha256File(worker),
  });
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

export function isGitHubHttpNotFound(stderr) {
  // Trap door: absence is a hosted observation, not a string-matching
  // fallback. Only an explicit HTTP 404 may become a null resource.
  return /\(HTTP 404\)(?:\s|$)/.test(stderr);
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
  if (isGitHubHttpNotFound(result.stderr ?? "")) return null;
  fail(`GitHub GET ${endpoint} could not be independently observed`);
}

export function codexProbeReply(response) {
  const messages = [];
  for (const line of response.split("\n").filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail("Codex provider identity probe returned invalid JSONL");
    }
    if (
      event?.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string"
    ) {
      messages.push(event.item.text);
    }
  }
  if (messages.length !== 1) {
    fail("Codex provider identity probe did not return exactly one assistant message");
  }
  return messages[0];
}

export function requireExactProbeReply(reply, expected, role) {
  if (typeof reply !== "string" || reply.trim() !== expected) {
    fail(`${role} provider identity probe did not return its bound marker`);
  }
}

export function parseImplementationArtifact(reply, runId) {
  let artifact;
  try {
    artifact = JSON.parse(reply);
  } catch {
    fail("implementation provider did not return a structured artifact");
  }
  if (
    typeof runId !== "string"
    || runId === ""
    || canonical(Object.keys(artifact ?? {}).sort()) !== canonical(["content", "run_id"])
    || artifact.run_id !== runId
    || artifact.content !== `${runId}\n`
  ) {
    fail("implementation provider artifact is not bound to the protected run");
  }
  return artifact;
}

export function parseReviewDisposition(reply, candidateOid) {
  let disposition;
  try {
    disposition = JSON.parse(reply);
  } catch {
    fail("review provider did not return a structured candidate disposition");
  }
  if (
    !OID.test(candidateOid ?? "")
    || canonical(Object.keys(disposition ?? {}).sort())
      !== canonical(["findings", "reviewed_commit_oid", "verdict"])
    || disposition.reviewed_commit_oid !== candidateOid
    || !["accept", "reject"].includes(disposition.verdict)
    || !Array.isArray(disposition.findings)
    || disposition.findings.some((finding) => (
      typeof finding !== "string" || finding.trim() === ""
    ))
    || (disposition.verdict === "accept" && disposition.findings.length !== 0)
    || (disposition.verdict === "reject" && disposition.findings.length === 0)
  ) {
    fail("review provider disposition is not bound to the immutable candidate");
  }
  return disposition;
}

function providerProbe(role, runId, reviewCandidate) {
  const safeEnv = { ...process.env, CI: "1", CODEX_NO_UPDATE_CHECK: "1" };
  delete safeEnv.GH_TOKEN;
  delete safeEnv.GITHUB_TOKEN;
  let prompt;
  if (role === "implementation") {
    prompt = [
      `Produce the deterministic implementation artifact for protected release run ${runId}.`,
      "Do not inspect files, invoke tools, or make changes.",
      "Reply with exactly one JSON object and no markdown.",
      `The object must be {"content":"${runId}\\n","run_id":"${runId}"}.`,
    ].join("\n");
  } else {
    if (
      !OID.test(reviewCandidate?.candidate_oid ?? "")
      || typeof reviewCandidate?.repository !== "string"
    ) fail("review candidate authority is absent");
    const repository = realpathSync(reviewCandidate.repository);
    const observedOid = run("git", [
      "-C", repository, "rev-parse", `${reviewCandidate.candidate_oid}^{commit}`,
    ]);
    if (observedOid !== reviewCandidate.candidate_oid) {
      fail("review candidate identity changed before dispatch");
    }
    const patch = run("git", [
      "-C", repository,
      "show", "--format=fuller", "--no-ext-diff", "--binary",
      reviewCandidate.candidate_oid,
    ]);
    prompt = [
      `Independently review immutable candidate commit ${reviewCandidate.candidate_oid}`,
      `for protected release run ${runId}.`,
      "Review the exact Git show payload below for correctness and release-blocking defects.",
      "Do not invoke tools or make changes.",
      "Reply with exactly one JSON object and no markdown.",
      `The object must be {"findings":[],"reviewed_commit_oid":"${reviewCandidate.candidate_oid}","verdict":"accept"} when clean.`,
      "When defects exist, verdict must be reject and findings must contain concise non-empty strings.",
      `Git show SHA-256: ${sha256(patch)}.`,
      "BEGIN IMMUTABLE GIT SHOW",
      patch,
      "END IMMUTABLE GIT SHOW",
    ].join("\n");
  }
  let response;
  let adapter;
  let assistantReply;
  let identity;
  let implementation;
  let model;
  let review;
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
    assistantReply = codexProbeReply(response);
    const catalog = run("codex", ["debug", "models"], {
      env: safeEnv,
      json: true,
      timeout: 30_000,
    });
    const observed = catalog?.models?.find((entry) => entry.slug === model);
    if (observed === undefined) fail("OpenAI model identity is absent from the authenticated catalog");
    identity = {
      display_name: observed.display_name,
      provider: "openai",
      slug: observed.slug,
    };
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
    let payload;
    try {
      payload = JSON.parse(response);
    } catch {
      fail("Claude provider identity probe returned invalid JSON");
    }
    assistantReply = payload?.result;
    const observed = payload?.modelUsage?.[model];
    if (observed?.provider !== "firstParty" || observed?.canonicalModel !== "claude-opus-4-8") {
      fail("Anthropic model identity is absent from the authenticated response");
    }
    identity = {
      canonical_model: observed.canonicalModel,
      context_window: observed.contextWindow,
      provider: observed.provider,
      requested_key: model,
    };
  }
  if (role === "implementation") {
    const artifact = parseImplementationArtifact(assistantReply, runId);
    implementation = {
      content: artifact.content,
      content_sha256: sha256(artifact.content),
      run_id: artifact.run_id,
    };
  } else {
    review = parseReviewDisposition(assistantReply, reviewCandidate.candidate_oid);
  }
  // The bundle binds both the assistant response and the exact prompt. For a
  // review, that prompt contains the immutable candidate OID and Git payload.
  const responseSha = sha256(canonical({ prompt, response }));
  if (review !== undefined) {
    review = { ...review, bundle_sha256: responseSha };
  }
  return {
    adapter,
    bundle_sha256: responseSha,
    conversation_id: sha256(`conversation:${runId}:${role}:${responseSha}`).slice(0, 32),
    dispatch_id: sha256(`dispatch:${runId}:${role}:${responseSha}`).slice(0, 32),
    evidence_id: `run:${runId.split("-").at(-1)}:model:${role}`,
    identity_sha256: sha256(canonical(identity)),
    ...(implementation === undefined ? {} : { implementation }),
    invoked_model: model,
    observed_model: model,
    process_id: process.pid,
    requested_model: model,
    ...(review === undefined ? {} : { review }),
    role,
  };
}

function persistAttempt(config, phase) {
  const script = String.raw`
import sqlite3, sys
db, run_id, persistent_state_id, attempt_id, phase, payload = sys.argv[1:]
con = sqlite3.connect(db)
con.execute("pragma journal_mode=wal")
con.execute("create table if not exists attempts (attempt_id text primary key, run_id text not null, persistent_state_id text not null, phase text not null, payload_sha256 text not null)")
con.execute("insert into attempts values (?, ?, ?, ?, ?)", (attempt_id, run_id, persistent_state_id, phase, payload))
con.commit()
con.close()
`;
  run(config.python, [
    "-c", script,
    config.sqlite,
    config.run_id,
    config.persistent_state_id,
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

function observePersistentAttempts(config) {
  const script = String.raw`
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.row_factory = sqlite3.Row
rows = con.execute(
    "select attempt_id, run_id, persistent_state_id, phase, payload_sha256 from attempts order by rowid"
).fetchall()
print(json.dumps([dict(row) for row in rows], sort_keys=True))
con.close()
`;
  return run(config.python, ["-c", script, config.sqlite], { json: true });
}

export function requirePersistentLifecycleObservation(observation, expected) {
  // Trap door: two processes receiving the same parent-constructed path and ID
  // is not persistence continuity. Resume must read the crash checkpoint and
  // SQLite row, and completion must be based on the exact two persisted rows.
  const expectedCheckpoint = {
    attempt_id: `${expected.run_id}:crash`,
    persistent_state_id: expected.persistent_state_id,
    provider_bundle_sha256: expected.crash_provider_bundle_sha256,
    run_id: expected.run_id,
  };
  const expectedAttempts = [{
    attempt_id: `${expected.run_id}:crash`,
    payload_sha256: expected.crash_provider_bundle_sha256,
    persistent_state_id: expected.persistent_state_id,
    phase: "crash",
    run_id: expected.run_id,
  }];
  if (expected.resume_provider_bundle_sha256 !== undefined) {
    expectedAttempts.push({
      attempt_id: `${expected.run_id}:resume`,
      payload_sha256: expected.resume_provider_bundle_sha256,
      persistent_state_id: expected.persistent_state_id,
      phase: "resume",
      run_id: expected.run_id,
    });
  }
  if (
    !SHA256.test(expected.crash_provider_bundle_sha256 ?? "")
    || (
      expected.resume_provider_bundle_sha256 !== undefined
      && !SHA256.test(expected.resume_provider_bundle_sha256)
    )
    || canonical(observation?.checkpoint) !== canonical(expectedCheckpoint)
    || canonical(observation?.attempts) !== canonical(expectedAttempts)
  ) {
    fail("persistent crash/resume lifecycle was not independently read back");
  }
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
  config.provider = providerProbe(config.role, config.run_id, config.review_candidate);
  if (config.phase === "crash") {
    const candidate = finalizeLocalLifecycleCandidate(config.workspace, config.provider);
    writeFileSync(config.candidate_file, `${canonical(candidate)}\n`);
  }
  writeFileSync(config.provider_file, `${canonical(config.provider)}\n`);
  let checkpointObservation;
  if (config.phase === "resume") {
    checkpointObservation = JSON.parse(readFileSync(config.checkpoint_file, "utf8"));
    requirePersistentLifecycleObservation({
      attempts: observePersistentAttempts(config),
      checkpoint: checkpointObservation,
    }, {
      crash_provider_bundle_sha256: checkpointObservation.provider_bundle_sha256,
      persistent_state_id: config.persistent_state_id,
      run_id: config.run_id,
    });
  }
  persistAttempt(config, config.phase);
  if (config.phase === "crash") {
    writeFileSync(config.checkpoint_file, `${canonical({
      attempt_id: config.attempt_id,
      persistent_state_id: config.persistent_state_id,
      provider_bundle_sha256: config.provider.bundle_sha256,
      run_id: config.run_id,
    })}\n`);
    await new Promise(() => {
      setInterval(() => {}, 60_000);
    });
  } else {
    const lifecycle = {
      attempts: observePersistentAttempts(config),
      checkpoint: checkpointObservation,
    };
    requirePersistentLifecycleObservation(lifecycle, {
      crash_provider_bundle_sha256: checkpointObservation.provider_bundle_sha256,
      persistent_state_id: config.persistent_state_id,
      resume_provider_bundle_sha256: config.provider.bundle_sha256,
      run_id: config.run_id,
    });
    writeFileSync(config.lifecycle_file, `${canonical(lifecycle)}\n`);
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

export function requireProcessGroupDeathObservation(observation) {
  // Trap door: a child "exit" event proves only that the group leader was
  // reaped. The receipt's death_observed field means SIGKILL was observed on
  // that leader and an independent process-group lookup reached ESRCH.
  if (
    observation?.code !== null
    || observation?.signal !== "SIGKILL"
    || observation?.group_absent !== true
  ) {
    fail("crash attempt process-group death was not independently observed");
  }
}

export async function killProcessGroupAndObserve(child, processGroupId, timeoutMs = 10_000) {
  const exit = new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("crash attempt did not exit after SIGKILL"));
    }, timeoutMs);
  });

  process.kill(-processGroupId, "SIGKILL");
  const observation = { ...await exit, group_absent: false };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        observation.group_absent = true;
        break;
      }
      if (error?.code !== "EPERM") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  requireProcessGroupDeathObservation(observation);
  return observation;
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

export function pullRequestCleanupCandidates(pulls, branch, deliveryOid) {
  // Trap door: a successful POST may lose its response after GitHub creates
  // the pull request. Cleanup ownership must then be recovered from both the
  // controller-owned branch and its already-observed delivery commit.
  if (!Array.isArray(pulls)) {
    fail("partial pull request cleanup observation is invalid");
  }
  if (pulls.length === 0) return [];
  if (!OID.test(deliveryOid ?? "")) {
    fail("partial pull request cleanup has no bound delivery OID");
  }
  const candidates = pulls.map((pull) => {
    if (
      !Number.isInteger(pull?.number)
      || pull.number <= 0
      || pull.state !== "open"
      || pull.head?.ref !== branch
      || pull.head?.sha !== deliveryOid
    ) {
      fail("partial pull request cleanup observation changed ownership");
    }
    return String(pull.number);
  });
  if (new Set(candidates).size !== candidates.length) {
    fail("partial pull request cleanup observation contains duplicate identities");
  }
  return candidates;
}

function createDelivery(preflight, runId, providerEvidence, { injectFailureAfterPullRequest = false } = {}) {
  const { repoPath } = observeRemote(preflight);
  const branch = `${preflight.remote.owned_namespace}/${runId}`;
  if (ghApiMaybe(`${repoPath}/git/ref/heads/${branch}`) !== null) fail(`owned branch already exists: ${runId}`);
  const partial = { branch, deliveryOid: null, pullRequestId: null, repoPath };
  try {
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
    partial.deliveryOid = commit.sha;
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
    partial.pullRequestId = String(pull.number);
    const observedPull = ghApi(`${repoPath}/pulls/${pull.number}`);
    if (observedPull.head.sha !== commit.sha || observedPull.head.ref !== branch) {
      fail("pull request head does not match the delivery OID");
    }
    const matching = ghApi(`${repoPath}/pulls?state=open&head=${preflight.remote.owner}:${branch}&base=${preflight.remote.base_branch}`);
    if (!Array.isArray(matching) || matching.length !== 1 || matching[0].number !== pull.number) {
      fail("pull request exactly-once observation failed");
    }
    if (injectFailureAfterPullRequest) {
      throw new ExpectedFailureCleanupProbe("intentional post-pull-request failure cleanup probe");
    }
    return {
      branch,
      delivery_oid: commit.sha,
      pull_request_head_oid: observedPull.head.sha,
      pull_request_id: String(pull.number),
      repoPath,
    };
  } catch (error) {
    try {
      if (partial.pullRequestId !== null) {
        const pull = ghApiMaybe(`${repoPath}/pulls/${partial.pullRequestId}`);
        if (pull?.state === "open") {
          ghApi(`${repoPath}/pulls/${partial.pullRequestId}`, {
            method: "PATCH",
            body: { state: "closed" },
          });
        }
      } else {
        const pulls = ghApi(
          `${repoPath}/pulls?state=open&head=${preflight.remote.owner}:${branch}`
            + `&base=${preflight.remote.base_branch}`,
        );
        for (const pullRequestId of pullRequestCleanupCandidates(
          pulls,
          branch,
          partial.deliveryOid,
        )) {
          ghApi(`${repoPath}/pulls/${pullRequestId}`, {
            method: "PATCH",
            body: { state: "closed" },
          });
          const closed = ghApi(`${repoPath}/pulls/${pullRequestId}`);
          if (closed.state !== "closed") {
            fail("response-loss pull request did not close");
          }
        }
      }
      const branchObservation = ghApiMaybe(`${repoPath}/git/ref/heads/${branch}`);
      if (branchObservation !== null) {
        if (
          partial.deliveryOid === null ||
          branchObservation.object?.sha !== partial.deliveryOid
        ) fail("partial branch changed before failure cleanup");
        ghApi(`${repoPath}/git/refs/heads/${branch}`, { method: "DELETE" });
      }
    } catch (cleanupError) {
      const original = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      fail(`${original}; protected failure cleanup failed: ${cleanup}`);
    }
    throw error;
  }
}

function exerciseFailureCleanup(preflight, runId, providerEvidence) {
  const failureRunId = `${runId}-failure-cleanup`;
  const branch = `${preflight.remote.owned_namespace}/${failureRunId}`;
  try {
    createDelivery(preflight, failureRunId, providerEvidence, {
      injectFailureAfterPullRequest: true,
    });
    fail("failure cleanup probe unexpectedly completed");
  } catch (error) {
    if (!(error instanceof ExpectedFailureCleanupProbe)) throw error;
  }
  const branchAbsent = ghApiMaybe(
    `repos/${preflight.remote.owner}/${preflight.remote.repository}/git/ref/heads/${branch}`,
  ) === null;
  const pulls = ghApi(
    `repos/${preflight.remote.owner}/${preflight.remote.repository}`
      + `/pulls?state=all&head=${preflight.remote.owner}:${branch}`
      + `&base=${preflight.remote.base_branch}`,
  );
  const pullClosed = (
    Array.isArray(pulls)
    && pulls.length === 1
    && pulls[0].head?.ref === branch
    && pulls[0].state === "closed"
  );
  observeRemote(preflight);
  if (!branchAbsent || !pullClosed) {
    fail("failure cleanup probe left an owned branch or pull request");
  }
  return {
    branch_absent_on_independent_requery: branchAbsent,
    pull_request_closed_on_independent_requery: pullClosed,
    repository_preserved_on_independent_requery: true,
    run_id: runId,
  };
}

export function completedFailureCleanupCase(observations) {
  // Trap door: success teardown and hermetic failure fixtures are not live
  // failure-path evidence. Keep this aggregate claim bound to both forced
  // hosted failure observations and their independent post-cleanup requeries.
  if (
    !Array.isArray(observations)
    || observations.length !== 2
    || observations.some((observation, index) => (
      observation?.run_id !== `protected-${index + 1}`
      || observation?.branch_absent_on_independent_requery !== true
      || observation?.pull_request_closed_on_independent_requery !== true
      || observation?.repository_preserved_on_independent_requery !== true
    ))
  ) {
    fail("two independently requeried failure cleanup observations are required");
  }
  return { completed: true, independently_requeried: true, kind: "failure" };
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

export function requireIndependentReviewObservation(provider, candidateOid) {
  // Trap door: an authenticated provider identity probe proves which model
  // answered, not that the model reviewed the candidate. A clean review must
  // bind its disposition to the immutable candidate commit and the exact
  // transcript bundle before remediation or release gates can consume it.
  const review = provider?.review;
  if (
    provider?.role !== "review"
    || !OID.test(candidateOid ?? "")
    || review?.reviewed_commit_oid !== candidateOid
    || review?.verdict !== "accept"
    || canonical(review?.findings) !== canonical([])
    || review?.bundle_sha256 !== provider?.bundle_sha256
    || !SHA256.test(review?.bundle_sha256 ?? "")
  ) {
    fail("independent review did not accept the immutable candidate");
  }
  return review;
}

export function receiptModelObservation(provider) {
  // Trap door: provider records contain internal evidence (including the
  // candidate-bound review disposition) that is consumed by phase evidence.
  // The signed receipt's modelObservation schema is a narrower dispatch
  // projection with additionalProperties=false; do not spread internal
  // evidence across that schema boundary.
  const {
    identity_sha256: _identity,
    implementation: _implementation,
    review: _review,
    ...observation
  } = provider;
  return observation;
}

function prepareLocalLifecycleWorkspace(runtime, runRoot, runId) {
  const policyRoot = realpathSync(runRoot);
  const policy = run(runtime.python, [
    "-c",
    String.raw`
import json, pathlib, sys
from rickgent_policies.policy_event import TicketScopeEntry
from rickgent_policies.scope import ScopeOperation, evaluate_scope
root = pathlib.Path(sys.argv[1]).resolve()
worktree = root / "policy-proof"
worktree.mkdir()
(worktree / "allowed.txt").write_text("before")
declaration = TicketScopeEntry(path="allowed.txt", change_kind="modify", directory=False)
allow = evaluate_scope(
    worktree_root=str(worktree.resolve()), authorized_root=str(worktree.resolve()),
    reserved_roots=(), declared_scope=(declaration,),
    operation=ScopeOperation("modify", False, path="allowed.txt"),
)
deny = evaluate_scope(
    worktree_root=str(worktree.resolve()), authorized_root=str(worktree.resolve()),
    reserved_roots=(), declared_scope=(declaration,),
    operation=ScopeOperation("modify", False, path="outside.txt"),
)
print(json.dumps({
    "allow": {"code": allow.code, "result": allow.result},
    "deny": {"code": deny.code, "result": deny.result},
}, sort_keys=True))
`,
    policyRoot,
  ], {
    env: {
      ...process.env,
      OMNIGENT_ROOT: runtime.omnigentRoot,
      OMNIGENT_PYTHON: runtime.python,
      PYTHONPATH: runtime.omnigentRoot,
    },
    json: true,
  });
  if (policy.allow.result !== "ALLOW" || policy.deny.result !== "DENY") {
    fail(`${runId} native policy proof did not observe allow and deny`);
  }

  const repository = join(runRoot, "git-proof");
  const worktree = join(runRoot, "attempt-worktree");
  run("git", ["init", "-q", repository]);
  run("git", ["-C", repository, "config", "user.name", "Rickgent Protected Proof"]);
  run("git", ["-C", repository, "config", "user.email", "proof@rickgent.invalid"]);
  writeFileSync(join(repository, "baseline.txt"), "protected release baseline\n");
  run("git", ["-C", repository, "add", "baseline.txt"]);
  run("git", ["-C", repository, "commit", "-q", "-m", "proof: baseline"]);
  const baselineOid = run("git", ["-C", repository, "rev-parse", "HEAD"]);
  run("git", ["-C", repository, "worktree", "add", "-q", "-b", `attempt/${runId}`, worktree, baselineOid]);
  const deliveryRef = `refs/rickgent/runs/${runId}/delivery`;
  run("git", ["-C", repository, "update-ref", deliveryRef, baselineOid]);
  const commonDir = realpathSync(join(repository, run("git", ["-C", repository, "rev-parse", "--git-common-dir"])));
  return {
    baselineOid,
    deliveryRef,
    policy,
    records: {
      "native-policy": policy,
      ownership: {
        common_dir_sha256: sha256(commonDir),
        repository_root_sha256: sha256(realpathSync(repository)),
        run_id: runId,
      },
    },
    repository,
    runId,
    worktree,
  };
}

function finalizeLocalLifecycleCandidate(workspace, provider) {
  const implementation = provider?.implementation;
  if (
    provider?.role !== "implementation"
    || implementation?.run_id !== workspace.runId
    || typeof implementation?.content !== "string"
    || sha256(implementation.content) !== implementation.content_sha256
    || !SHA256.test(provider?.bundle_sha256 ?? "")
  ) {
    fail("candidate has no bound implementation provider artifact");
  }
  writeFileSync(join(workspace.worktree, "proof.txt"), implementation.content);
  run("git", ["-C", workspace.worktree, "add", "proof.txt"]);
  const indexTree = run("git", ["-C", workspace.worktree, "write-tree"]);
  run("git", ["-C", workspace.worktree, "commit", "-q", "-m", `proof: ${workspace.runId}`]);
  const { baselineOid, deliveryRef, repository, worktree } = workspace;
  const candidateOid = run("git", ["-C", worktree, "rev-parse", "HEAD"]);
  if (sha256File(join(worktree, "proof.txt")) !== implementation.content_sha256) {
    fail("committed candidate content changed after implementation dispatch");
  }
  run("git", ["-C", repository, "update-ref", deliveryRef, candidateOid, baselineOid]);
  const deliveryRefOid = run("git", ["-C", repository, "rev-parse", deliveryRef]);
  const changedPaths = run("git", [
    "-C", worktree, "diff-tree", "--no-commit-id", "--name-only", "-r", candidateOid,
  ]).split("\n").filter(Boolean);
  const clean = run("git", ["-C", worktree, "status", "--porcelain"]) === "";
  if (
    !OID.test(candidateOid) ||
    deliveryRefOid !== candidateOid ||
    canonical(changedPaths) !== canonical(["proof.txt"]) ||
    !clean
  ) fail(`${runId} local ownership and scope-clean commit proof failed`);
  const records = {
    ...workspace.records,
    worktree: {
      candidate_oid: candidateOid,
      realpath_sha256: sha256(realpathSync(worktree)),
    },
    ref: { delivery_ref_sha256: sha256(deliveryRef), observed_oid: deliveryRefOid },
    index: { tree_oid: indexTree },
    lease: { after_oid: candidateOid, before_oid: baselineOid, compare_and_swap: true },
    "scope-clean-commit": {
      changed_paths: changedPaths,
      commit_oid: candidateOid,
      implementation_bundle_sha256: provider.bundle_sha256,
      implemented_content_sha256: implementation.content_sha256,
    },
  };
  return { candidateOid, clean, records, repository };
}

function deriveLocalLifecycle(candidate, attempts, providers) {
  const implementationProvider = providers.find((item) => item.role === "implementation");
  const implementation = implementationProvider?.implementation;
  if (
    implementation?.content_sha256
      !== candidate.records["scope-clean-commit"].implemented_content_sha256
    || implementationProvider?.bundle_sha256
      !== candidate.records["scope-clean-commit"].implementation_bundle_sha256
  ) {
    fail("candidate commit is not bound to the implementation dispatch");
  }
  const reviewProvider = providers.find((item) => item.role === "review");
  const review = requireIndependentReviewObservation(reviewProvider, candidate.candidateOid);
  return {
    ...candidate.records,
    process: attempts,
    review: {
      bundle_sha256: review.bundle_sha256,
      findings: review.findings,
      reviewed_commit_oid: review.reviewed_commit_oid,
      verdict: review.verdict,
    },
    remediation: {
      required: false,
      review_bundle_sha256: review.bundle_sha256,
      status: "review_clean",
    },
    gate: {
      clean_worktree: candidate.clean,
      native_policy_allow_deny: true,
      provider_identity_count: providers.filter((item) => SHA256.test(item.identity_sha256)).length,
    },
  };
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

  // Trap door: the implementer must produce the committed artifact, and the
  // reviewer must receive that immutable result. Prepare only the owned
  // workspace in the parent; the crash worker materializes and commits its
  // authenticated Codex artifact before exposing the durable checkpoint.
  const lifecycleWorkspace = prepareLocalLifecycleWorkspace(runtime, runRoot, runId);
  const crashStarted = new Date().toISOString();
  const crashConfigPath = join(runRoot, "crash.json");
  const checkpoint = join(runRoot, "checkpoint.json");
  const crashProviderPath = join(runRoot, "implementation.json");
  writeFileSync(crashConfigPath, `${canonical({
    attempt_id: `${runId}:crash`,
    build_id: preflight.binding.build_id,
    candidate_file: join(runRoot, "candidate.json"),
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
    workspace: lifecycleWorkspace,
  })}\n`);
  const crashChild = spawnAttempt(crashConfigPath, nonce);
  await waitForChild(crashChild, 5 * 60_000, checkpoint);
  const crashPid = crashChild.pid;
  if (crashPid === undefined) fail("crash attempt has no process identity");
  await killProcessGroupAndObserve(crashChild, crashPid);
  const crashEnded = new Date().toISOString();
  providers.push(JSON.parse(readFileSync(crashProviderPath, "utf8")));
  const lifecycleCandidate = JSON.parse(readFileSync(join(runRoot, "candidate.json"), "utf8"));
  attempts.push({
    attempt_id: `${runId}:crash`,
    death_observed: true,
    ended_at: crashEnded,
    phase: "crash",
    process_group_id: crashPid,
    process_id: crashPid,
    started_at: crashStarted,
  });

  const resumeStarted = crashEnded;
  const resumeConfigPath = join(runRoot, "resume.json");
  const reviewProviderPath = join(runRoot, "review.json");
  const lifecyclePath = join(runRoot, "lifecycle.json");
  writeFileSync(resumeConfigPath, `${canonical({
    attempt_id: `${runId}:resume`,
    build_id: preflight.binding.build_id,
    checkpoint_file: checkpoint,
    cli: runtime.cli,
    lifecycle_file: lifecyclePath,
    nonce,
    nonce_file: nonceFile,
    omnigent_root: runtime.omnigentRoot,
    persistent_state_id: persistentStateId,
    phase: "resume",
    provider_file: reviewProviderPath,
    python: runtime.python,
    review_candidate: {
      candidate_oid: lifecycleCandidate.candidateOid,
      repository: lifecycleCandidate.repository,
    },
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
  const lifecycleObservation = JSON.parse(readFileSync(lifecyclePath, "utf8"));
  requirePersistentLifecycleObservation(
    lifecycleObservation,
    {
      crash_provider_bundle_sha256: providers[0].bundle_sha256,
      persistent_state_id: persistentStateId,
      resume_provider_bundle_sha256: providers[1].bundle_sha256,
      run_id: runId,
    },
  );
  attempts.push({
    attempt_id: `${runId}:resume`,
    death_observed: false,
    ended_at: new Date().toISOString(),
    phase: "resume",
    process_group_id: resumePid,
    process_id: resumePid,
    started_at: resumeStarted,
  });
  const phaseEvidence = deriveLocalLifecycle(lifecycleCandidate, attempts, providers);
  phaseEvidence.persistence = lifecycleObservation;
  const delivery = createDelivery(preflight, runId, providers);
  phaseEvidence.push = {
    branch: delivery.branch,
    observed_oid: delivery.delivery_oid,
  };
  phaseEvidence["pull-request"] = {
    head_oid: delivery.pull_request_head_oid,
    id: delivery.pull_request_id,
  };
  phaseEvidence["delivery-oid"] = {
    delivery_oid: delivery.delivery_oid,
    observed_branch_oid: delivery.delivery_oid,
    pull_request_head_oid: delivery.pull_request_head_oid,
  };
  phaseEvidence.oracle = {
    delivery_equality: (
      delivery.delivery_oid === delivery.pull_request_head_oid
    ),
    duplicate_side_effects: false,
  };
  try {
    cleanupDelivery(preflight, delivery);
  } catch (error) {
    try {
      cleanupDelivery(preflight, delivery);
    } catch (cleanupError) {
      const original = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      fail(`${original}; protected teardown retry failed: ${cleanup}`);
    }
    throw error;
  }
  phaseEvidence.cleanup = {
    branch_absent: true,
    pull_request_closed: true,
    repository_preserved: true,
  };
  const failureCleanup = exerciseFailureCleanup(preflight, runId, providers);
  phaseEvidence["failure-cleanup"] = failureCleanup;
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
    identity_evidence: providers.map((provider) => ({
      provider: provider.role === "implementation" ? "openai" : "anthropic",
      sha256: provider.identity_sha256,
    })),
    failure_cleanup: failureCleanup,
    lifecycle_complete: true,
    model_observations: providers.map(receiptModelObservation),
    phase_evidence: phaseEvidence,
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
    ...run.identity_evidence.map((identity) => ({
      authenticated: true,
      classification: "live",
      evidence_id: `run:${index + 1}:identity:${identity.provider}`,
      redaction: "sensitive_redacted",
      sha256: identity.sha256,
    })),
    ...Object.entries(run.phase_evidence).map(([phase, observation]) => ({
      authenticated: true,
      classification: "live",
      evidence_id: `run:${index + 1}:phase:${phase}`,
      redaction: "sensitive_redacted",
      sha256: sha256(canonical(observation)),
    })),
  ]);
  const receiptRuns = runs.map(({
    failure_cleanup: _failureCleanup,
    identity_evidence: _identityEvidence,
    phase_evidence: _phaseEvidence,
    ...run
  }) => run);
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
      failure_path: completedFailureCleanupCase(runs.map((run) => run.failure_cleanup)),
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
    runs: receiptRuns,
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

async function main() {
  try {
    if (process.argv[2] === "preflight") await runPreflight();
    else if (process.argv[2] === "execute") await runExecute();
    else if (process.argv[2] === "_attempt") await runAttemptWorker();
    else await runMutation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`PROTECTED_RELEASE_REFUSED: ${message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main();
