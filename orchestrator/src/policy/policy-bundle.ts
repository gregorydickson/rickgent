import { execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { parse, stringify } from "yaml";
import { canonicalJson, TICKET_CONTRACT_SCHEMA_VERSION, ticketOwnedPaths, type TicketContract } from "../contracts/ticket-contract.js";
import { BUILD_COMMIT } from "../build-commit.js";
import type { ReadyRunWorkspace } from "../git/run-workspace.js";
import type { RouterSelection } from "../lifecycle/routing.js";
import {
  ATTEMPT_LEASE_SCHEMA_VERSION,
  NONCE_CLAIM_SCHEMA_VERSION,
  POLICY_ABI_VERSION,
  RUNTIME_PROVENANCE_SCHEMA_VERSION,
  canonicalDispatchId,
  createExecutionContext,
  materializeExecutionContext,
  verifyMaterializedExecutionContext,
  type ExecutionContext,
  type ExecutionDispatchId,
  type ExecutionRuntimeProvenance,
  type MaterializedExecutionContext,
} from "../context/execution-context.js";

export const POLICY_CONFIG_KEYS = Object.freeze([
  "rickgent_policy_abi",
  "context_path",
  "context_sha256",
  "context_owner_token_sha256",
  "lease_path",
  "receipt_path",
  "dispatch_id",
] as const);

export type PolicyConfigKey = typeof POLICY_CONFIG_KEYS[number];
export type PolicyReferenceConfig = Readonly<Record<PolicyConfigKey, string>>;

export const REQUIRED_POLICY_ATTACHMENTS = Object.freeze([
  Object.freeze({ name: "blast_radius", path: "omnigent.inner.nessie.policies.blast_radius", arguments: Object.freeze({ gate_pushes: true }), rickgent: false }),
  Object.freeze({ name: "scope_fence", path: "rickgent_policies.scope_fence", arguments: null, rickgent: true }),
  Object.freeze({ name: "completion_evidence", path: "rickgent_policies.completion_evidence", arguments: null, rickgent: true }),
  Object.freeze({ name: "convergence_gate", path: "rickgent_policies.convergence_gate", arguments: null, rickgent: true }),
  Object.freeze({ name: "subtract_before_add", path: "rickgent_policies.subtract_before_add", arguments: null, rickgent: true }),
  Object.freeze({ name: "cross_vendor_review", path: "rickgent_policies.cross_vendor_review", arguments: null, rickgent: true }),
  Object.freeze({ name: "autonomous_pr_flow", path: "rickgent_policies.autonomous_pr_flow", arguments: Object.freeze({}), rickgent: true }),
] as const);

export const TRUSTED_SPAWN_ENVIRONMENT_KEYS = Object.freeze([
  "RICKGENT_STATE_ROOT",
  "RICKGENT_POLICY_ROOT",
  "RICKGENT_CONTEXT_PATH",
  "RICKGENT_CONTEXT_SHA256",
  "RICKGENT_CONTEXT_OWNER_TOKEN",
  "RICKGENT_CONTEXT_OWNER_TOKEN_SHA256",
  "RICKGENT_NONCE_CLAIM_PATH",
  "RICKGENT_LEASE_PATH",
  "RICKGENT_RECEIPT_PATH",
  "RICKGENT_DISPATCH_ID",
  "RICKGENT_RUN_ID",
  "RICKGENT_TICKET_ID",
  "RICKGENT_ATTEMPT",
  "RICKGENT_LIFECYCLE_PHASE",
  "RICKGENT_ROLE",
  "RICKGENT_CALLER_REPO_REALPATH",
  "RICKGENT_WORKTREE_REALPATH",
  "RICKGENT_BUNDLE_ROOT_REALPATH",
  "RICKGENT_REQUESTED_BUNDLE_SHA256",
  "RICKGENT_REQUESTED_CONFIG_SHA256",
  "RICKGENT_INVOKED_BUNDLE_SHA256",
  "RICKGENT_INVOKED_CONFIG_SHA256",
  "RICKGENT_OMNIGENT_PYTHON_ENTRYPOINT",
  "RICKGENT_OMNIGENT_PYTHON_REALPATH",
  "RICKGENT_OMNIGENT_PYTHON_SHA256",
  "RICKGENT_OMNIGENT_ROOT_REALPATH",
  "RICKGENT_OMNIGENT_ORIGIN_REALPATH",
  "RICKGENT_POLICIES_ORIGIN_REALPATH",
  "RICKGENT_POLICIES_SHA256",
  "RICKGENT_NODE_REALPATH",
  "RICKGENT_NODE_SHA256",
  "RICKGENT_CLI_REALPATH",
  "RICKGENT_CLI_SHA256",
  "RICKGENT_BUILD_COMMIT",
] as const);

export interface TrustedSpawnCommand {
  readonly executable: string;
  /** Append `run`, bundle path, prompt arguments after this isolated prefix. */
  readonly argvPrefix: readonly string[];
}

export interface PolicyBundleMaterializationOptions {
  readonly agentRoot: string;
  readonly stateRoot: string;
  readonly dispatch: ExecutionDispatchId;
  readonly ticket: TicketContract;
  readonly workspace: ReadyRunWorkspace;
  readonly selection: RouterSelection;
  readonly leaseExpiresAtMs?: number;
  readonly omnigentRoot?: string;
  readonly omnigentPython?: string;
  /** Absolute path or symlink to the exact Node interpreter used for the CLI. */
  readonly nodeExecutable?: string;
  /** Absolute path or symlink to the exact Rickgent CLI artifact. */
  readonly rickgentCli?: string;
}

export interface PolicyBundleHandle {
  readonly kind: "materialized_authenticated_policy_bundle";
  readonly templateDir: string;
  readonly stateRoot: string;
  readonly attemptsRoot: string;
  readonly attemptRoot: string;
  readonly policyRoot: string;
  readonly bundleDir: string;
  readonly configPath: string;
  /** Compatibility alias. This is explicitly the invoked, context-bound config digest. */
  readonly configSha256: string;
  readonly requestedConfigSha256: string;
  readonly requestedBundleSha256: string;
  readonly invokedConfigSha256: string;
  readonly invokedBundleSha256: string;
  readonly context: ExecutionContext;
  readonly contextPath: string;
  readonly contextSha256: string;
  readonly contextByteLength: number;
  readonly ownerToken: string;
  readonly ownerTokenSha256: string;
  readonly nonce: string;
  readonly nonceClaimPath: string;
  readonly leasePath: string;
  readonly receiptPath: string;
  readonly leaseExpiresAtMs: number;
  readonly policyConfig: PolicyReferenceConfig;
  readonly runtimeProvenance: ExecutionRuntimeProvenance;
  readonly trustedSpawnCommand: TrustedSpawnCommand;
  readonly spawnEnvironment: Readonly<Record<typeof TRUSTED_SPAWN_ENVIRONMENT_KEYS[number], string>>;
  readonly declaredPaths: readonly string[];
}

export interface PolicyBundleFinalizationProof {
  readonly childClosed: boolean;
  readonly workspaceCleanupProven: boolean;
  readonly disposition: "retain" | "remove" | "quarantine";
}

export interface PolicyBundleFinalizationResult {
  readonly disposition: "retained" | "removed" | "quarantined";
  readonly path: string;
  readonly leaseClosed: boolean;
}

interface LeaseDocument {
  readonly schema_version: typeof ATTEMPT_LEASE_SCHEMA_VERSION;
  readonly dispatch_id: string;
  readonly run_id: string;
  readonly ticket_id: string;
  readonly attempt: number;
  readonly lifecycle_phase: string;
  readonly role: string;
  readonly context_sha256: string;
  readonly owner_token_sha256: string;
  readonly nonce: string;
  readonly nonce_claim_path: string;
  readonly expires_at_ms: number;
  readonly status: "active" | "closed";
  readonly closed_at_ms: number | null;
}

interface NonceClaimDocument {
  readonly schema_version: typeof NONCE_CLAIM_SCHEMA_VERSION;
  readonly dispatch_id: string;
  readonly run_id: string;
  readonly ticket_id: string;
  readonly attempt: number;
  readonly lifecycle_phase: string;
  readonly role: string;
  readonly context_sha256: string;
  readonly owner_token_sha256: string;
  readonly nonce: string;
}

type JsonMap = Record<string, unknown>;

function pathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathInside(left, right) || pathInside(right, left);
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function assertOwned(info: { readonly uid: number }, label: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the orchestrator uid`);
  }
}

function assertNoSymlinkComponents(absolutePath: string, label: string): void {
  if (!isAbsolute(absolutePath) || resolve(absolutePath) !== absolutePath) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const root = resolve(absolutePath, sep);
  const rel = relative(root, absolutePath);
  let cursor = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symlink component: ${cursor}`);
  }
}

function privateDirectory(path: string, label: string, create: boolean): string {
  const absolute = resolve(path);
  assertNoSymlinkComponents(absolute, label);
  if (!existsSync(absolute)) {
    if (!create) throw new Error(`${label} does not exist`);
    mkdirSync(absolute, { mode: 0o700 });
  }
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a trusted directory`);
  assertOwned(info, label);
  if ((info.mode & 0o777) !== 0o700) throw new Error(`${label} mode must be exactly 0700`);
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) throw new Error(`${label} is not canonical`);
  return canonical;
}

function privateChildDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  return privateDirectory(path, name, false);
}

function exclusiveChildDirectory(parent: string, name: string, label: string): string {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  return privateDirectory(path, label, false);
}

function requestsCommit(instructions: string): boolean {
  for (const match of instructions.matchAll(/\bcommit(?:s|ted|ting)?\b/gi)) {
    const index = match.index ?? 0;
    const sentenceStart = Math.max(
      instructions.lastIndexOf(".", index - 1),
      instructions.lastIndexOf("!", index - 1),
      instructions.lastIndexOf("?", index - 1),
      instructions.lastIndexOf("\n", index - 1),
    ) + 1;
    if (!/\b(?:do not|never|must not|may not|cannot)\b/i.test(instructions.slice(sentenceStart, index))) {
      return true;
    }
  }
  return false;
}

function mapping(value: unknown, label: string): JsonMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as JsonMap;
}

function exactKeys(value: JsonMap, expected: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys/order mismatch: expected [${expected.join(", ")}], observed [${actual.join(", ")}]`);
  }
}

function validatePolicyReferenceConfig(value: unknown, label: string): PolicyReferenceConfig {
  const config = mapping(value, label);
  const keys = Object.keys(config);
  if (keys.length !== POLICY_CONFIG_KEYS.length || keys.some((key) => !POLICY_CONFIG_KEYS.includes(key as PolicyConfigKey))) {
    throw new Error(`${label} must contain exactly the seven attempt-reference keys`);
  }
  for (const key of POLICY_CONFIG_KEYS) {
    if (typeof config[key] !== "string" || config[key] === "") {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
  }
  if (config["rickgent_policy_abi"] !== POLICY_ABI_VERSION) {
    throw new Error(`${label} uses an unsupported policy ABI`);
  }
  return config as unknown as PolicyReferenceConfig;
}

export function validatePolicyAttachmentObject(
  value: JsonMap,
  expectedConfig?: PolicyReferenceConfig,
): void {
  const guardrails = mapping(value["guardrails"], "worker guardrails");
  const policies = mapping(guardrails["policies"], "worker guardrail policies");
  exactKeys(policies, REQUIRED_POLICY_ATTACHMENTS.map((row) => row.name), "worker guardrail policies");
  for (const expected of REQUIRED_POLICY_ATTACHMENTS) {
    const policy = mapping(policies[expected.name], `worker policy ${expected.name}`);
    const policyKeys = expected.rickgent && expectedConfig !== undefined
      ? ["type", "function", "config"]
      : ["type", "function"];
    exactKeys(policy, policyKeys, `worker policy ${expected.name}`);
    if (policy["type"] !== "function") throw new Error(`worker policy ${expected.name} must be function-typed`);
    const fn = mapping(policy["function"], `worker policy ${expected.name}.function`);
    const functionKeys = expected.arguments === null ? ["path"] : ["path", "arguments"];
    exactKeys(fn, functionKeys, `worker policy ${expected.name}.function`);
    if (fn["path"] !== expected.path) throw new Error(`worker policy ${expected.name} has incompatible function path`);
    if (expected.arguments !== null && canonicalJson(fn["arguments"]) !== canonicalJson(expected.arguments)) {
      throw new Error(`worker policy ${expected.name} has incompatible factory arguments`);
    }
    if (expected.rickgent) {
      if (expectedConfig === undefined && policy["config"] !== undefined) {
        throw new Error(`worker template policy ${expected.name} must not carry attempt config`);
      }
      if (expectedConfig !== undefined) {
        const observed = validatePolicyReferenceConfig(policy["config"], `worker policy ${expected.name}.config`);
        if (canonicalJson(observed) !== canonicalJson(expectedConfig)) {
          throw new Error(`worker policy ${expected.name} lacks exact attempt config`);
        }
      }
    } else if (policy["config"] !== undefined) {
      throw new Error("blast_radius must not receive Rickgent attempt config");
    }
  }
}

function validateWorkerConfigObject(value: unknown): JsonMap {
  const config = mapping(value, "worker config");
  if (config["name"] !== "worker") throw new Error("worker config name must be exactly 'worker'");
  const instructions = config["instructions"];
  if (typeof instructions !== "string" || instructions.trim() === "") {
    throw new Error("worker instructions must be non-empty");
  }
  if (requestsCommit(instructions) || /\bgit\s+(?:add|commit|push|merge|reset|checkout|switch)\b/i.test(instructions)) {
    throw new Error("worker instructions request Git mutation or a commit");
  }
  if (!/(?:do not|never)[^\n.]{0,120}\b(?:commit|terminal|completion)\b/i.test(instructions)) {
    throw new Error("worker instructions must explicitly forbid commit or terminal completion claims");
  }
  const osEnv = mapping(config["os_env"], "worker os_env");
  const sandbox = mapping(osEnv["sandbox"], "worker os_env sandbox");
  if (
    osEnv["type"] !== "caller_process"
    || osEnv["cwd"] !== "."
    || sandbox["type"] !== "none"
    || Object.keys(sandbox).length !== 1
  ) {
    throw new Error("worker config must use the exact source-mounted caller_process os_env contract");
  }
  const tools = mapping(config["tools"], "worker tools");
  if (Object.keys(tools).length !== 0) {
    throw new Error("worker tools must be registered only through os_env; static builtin declarations are not runtime authority");
  }
  validatePolicyAttachmentObject(config);
  return config;
}

function parseWorkerConfig(configPath: string): JsonMap {
  try {
    return validateWorkerConfigObject(parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("worker ")) throw error;
    throw new Error(`worker config YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateTreeHasNoSymlinks(current: string): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`worker tree contains symlink: ${path}`);
    if (info.isDirectory()) validateTreeHasNoSymlinks(path);
    else if (!info.isFile()) throw new Error(`worker tree contains unsupported entry: ${path}`);
  }
}

export function validateWorkerTemplate(agentRoot: string): { readonly agentRoot: string; readonly templateDir: string } {
  const requestedRoot = resolve(agentRoot);
  assertNoSymlinkComponents(requestedRoot, "Rickgent agent root");
  const canonicalRoot = realpathSync(requestedRoot);
  if (canonicalRoot !== requestedRoot) throw new Error("Rickgent agent root must be canonical and non-symlinked");
  const requestedTemplate = join(canonicalRoot, "agents", "worker");
  const requestedInfo = lstatSync(requestedTemplate);
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
    throw new Error("worker template directory must be a non-symlinked directory");
  }
  const templateDir = realpathSync(requestedTemplate);
  if (!pathInside(canonicalRoot, templateDir) || basename(templateDir) !== "worker") {
    throw new Error("worker template escapes the configured Rickgent agent root");
  }
  validateTreeHasNoSymlinks(templateDir);
  parseWorkerConfig(join(templateDir, "config.yaml"));
  return Object.freeze({ agentRoot: canonicalRoot, templateDir });
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    const info = lstatSync(from);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`worker template entry is unsafe: ${from}`);
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, info.mode & 0o100 ? 0o700 : 0o600);
  }
}

function rewritePrivateFile(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size !== bytes.length) {
      throw new Error(`private file descriptor verification failed: ${path}`);
    }
    assertOwned(info, path);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusivePrivateFile(path: string, bytes: Buffer): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size !== bytes.length) {
      throw new Error(`private file descriptor verification failed: ${path}`);
    }
    assertOwned(info, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function privateFileBytes(path: string, label: string, allowedModes: readonly number[] = [0o600]): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} is not a regular non-symlink file`);
    assertOwned(before, label);
    if (!allowedModes.includes(before.mode & 0o777)) throw new Error(`${label} mode is not private`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableRegularFile(candidate: string, label: string): { readonly path: string; readonly bytes: Buffer } {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  // The selected entrypoint may intentionally be a symlink. Bind its resolved
  // target so later comparisons cannot disagree about the same artifact.
  const path = realpathSync(candidate);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while it was read`);
    }
    return Object.freeze({ path, bytes });
  } finally {
    closeSync(descriptor);
  }
}

function stableExecutableEntrypoint(
  candidate: string,
  label: string,
): { readonly entrypoint: string; readonly target: { readonly path: string; readonly bytes: Buffer } } {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new Error(`${label} entrypoint must be an absolute normalized path`);
  }
  // Do not replace this invocation path with its realpath. Python virtual
  // environments intentionally use a symlinked executable path to discover
  // pyvenv.cfg and construct their package search path.
  accessSync(candidate, constants.X_OK);
  return Object.freeze({ entrypoint: candidate, target: stableRegularFile(candidate, `${label} target`) });
}

function policyPackageSha256(originValue: string): string {
  const origin = realpathSync(originValue);
  const packageRoot = dirname(origin);
  if (basename(origin) !== "__init__.py" || basename(packageRoot) !== "rickgent_policies") {
    throw new Error("Rickgent policies origin is not the package __init__.py");
  }
  const records: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Rickgent policy package contains symlink: ${path}`);
      if (info.isDirectory()) {
        if (entry.name !== "__pycache__") visit(path, rel);
      } else if (info.isFile() && entry.name.endsWith(".py")) {
        const source = stableRegularFile(path, "Rickgent policy source").bytes;
        records.push(`f\0${rel}\0${source.length}\0${sha256(source)}\n`);
      }
    }
  };
  visit(packageRoot, "");
  if (records.length === 0) throw new Error("Rickgent policy package contains no Python source");
  return sha256(`rickgent-policies-source-v1\n${records.join("")}`);
}

interface RuntimeProbe {
  readonly python_entrypoint: string;
  readonly python_target_realpath: string;
  readonly omnigent_origin: string;
  readonly policy_origin: string;
}

const TRUSTED_OMNIGENT_LAUNCHER = [
  "import runpy,sys",
  "omnigent_root=sys.argv.pop(1)",
  "policy_import_root=sys.argv.pop(1)",
  "sys.path[:0]=[omnigent_root,policy_import_root]",
  "from rickgent_policies.context import verify_runtime_provenance_environment",
  "verify_runtime_provenance_environment()",
  "runpy.run_module('omnigent',run_name='__main__')",
].join(";");

function probeRuntime(
  rootValue: string | undefined,
  pythonValue: string | undefined,
  cliValue: string | undefined,
  nodeValue: string | undefined,
): { readonly provenance: ExecutionRuntimeProvenance; readonly policyImportRoot: string } {
  if (!rootValue) throw new Error("OMNIGENT_ROOT is required for authenticated policy execution");
  if (!pythonValue) throw new Error("OMNIGENT_PYTHON must select an absolute interpreter for authenticated policy execution");
  if (!cliValue) throw new Error("an absolute Rickgent CLI path is required for authenticated policy execution");
  if (!nodeValue) throw new Error("an absolute Node interpreter path is required for authenticated policy execution");
  const root = realpathSync(rootValue);
  const pythonExecutable = stableExecutableEntrypoint(pythonValue, "Omnigent Python interpreter");
  const pythonFile = pythonExecutable.target;
  const nodeFile = stableRegularFile(nodeValue, "Rickgent Node interpreter");
  accessSync(nodeFile.path, constants.X_OK);
  const cliFile = stableRegularFile(cliValue, "Rickgent CLI");

  const script = [
    "import inspect,json,sys",
    "from pathlib import Path",
    "root=Path(sys.argv[1]).resolve(strict=True)",
    "sys.path.insert(0,str(root))",
    "import omnigent,rickgent_policies",
    "print(json.dumps({'python_entrypoint':sys.executable,'python_target_realpath':str(Path(sys.executable).resolve(strict=True)),'omnigent_origin':str(Path(inspect.getfile(omnigent)).resolve(strict=True)),'policy_origin':str(Path(inspect.getfile(rickgent_policies)).resolve(strict=True))},sort_keys=True))",
  ].join(";");
  let parsed: RuntimeProbe;
  try {
    parsed = JSON.parse(execFileSync(pythonExecutable.entrypoint, ["-I", "-c", script, root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env: process.env,
    })) as RuntimeProbe;
  } catch (error) {
    throw new Error(`runtime provenance probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const observedPythonEntrypoint = parsed.python_entrypoint;
  const observedPython = realpathSync(parsed.python_target_realpath);
  const omnigentOrigin = realpathSync(parsed.omnigent_origin);
  const policyOrigin = realpathSync(parsed.policy_origin);
  if (observedPythonEntrypoint !== pythonExecutable.entrypoint) {
    throw new Error("runtime provenance probe used a different Python entrypoint");
  }
  if (observedPython !== pythonFile.path) throw new Error("runtime provenance probe used a different Python target");
  if (!pathInside(root, omnigentOrigin)) throw new Error("runtime provenance probe imported shadow Omnigent code");

  let cliCommit: string;
  try {
    cliCommit = execFileSync(nodeFile.path, [cliFile.path, "--build-commit"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: process.env,
    }).trim();
  } catch (error) {
    throw new Error(`Rickgent CLI build provenance failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!cliCommit || cliCommit !== cliCommit.trim() || /\s/.test(cliCommit)) {
    throw new Error("Rickgent CLI returned an empty or malformed build commit");
  }
  if (cliCommit !== BUILD_COMMIT) throw new Error("Rickgent CLI build commit does not match the orchestrator build");

  const provenance: ExecutionRuntimeProvenance = Object.freeze({
    schema_version: RUNTIME_PROVENANCE_SCHEMA_VERSION,
    omnigent_python_entrypoint: pythonExecutable.entrypoint,
    omnigent_python_realpath: pythonFile.path,
    omnigent_python_sha256: sha256(pythonFile.bytes),
    omnigent_root_realpath: root,
    omnigent_origin_realpath: omnigentOrigin,
    rickgent_policies_origin_realpath: policyOrigin,
    rickgent_policies_sha256: policyPackageSha256(policyOrigin),
    rickgent_node_realpath: nodeFile.path,
    rickgent_node_sha256: sha256(nodeFile.bytes),
    rickgent_cli_realpath: cliFile.path,
    rickgent_cli_sha256: sha256(cliFile.bytes),
    rickgent_build_commit: cliCommit,
  });
  return Object.freeze({ provenance, policyImportRoot: dirname(dirname(policyOrigin)) });
}

function renderYaml(value: JsonMap): Buffer {
  return Buffer.from(stringify(value, { lineWidth: 0, sortMapEntries: false }), "utf8");
}

export function policyBundleSha256(bundleDir: string): string {
  const records: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`materialized bundle contains symlink: ${path}`);
      if (info.isDirectory()) {
        if ((info.mode & 0o777) !== 0o700) throw new Error(`materialized bundle directory mode changed: ${path}`);
        records.push(`d\0${rel}\0${"0700"}\n`);
        visit(path, rel);
      } else if (info.isFile()) {
        const mode = info.mode & 0o777;
        if (mode !== 0o600 && mode !== 0o700) throw new Error(`materialized bundle file mode changed: ${path}`);
        const bytes = privateFileBytes(path, "materialized bundle file", [0o600, 0o700]);
        records.push(`f\0${rel}\0${mode.toString(8).padStart(4, "0")}\0${bytes.length}\0${sha256(bytes)}\n`);
      } else {
        throw new Error(`materialized bundle contains unsupported entry: ${path}`);
      }
    }
  };
  visit(bundleDir, "");
  return sha256(records.join(""));
}

function injectPolicyConfig(worker: JsonMap, policyConfig: PolicyReferenceConfig): void {
  validatePolicyAttachmentObject(worker);
  const policies = mapping(mapping(worker["guardrails"], "worker guardrails")["policies"], "worker guardrail policies");
  for (const expected of REQUIRED_POLICY_ATTACHMENTS) {
    if (!expected.rickgent) continue;
    const policy = mapping(policies[expected.name], `worker policy ${expected.name}`);
    policy["config"] = { ...policyConfig };
  }
  validatePolicyAttachmentObject(worker, policyConfig);
}

function proveRealOmnigentPolicyConfig(
  bundleDir: string,
  expected: PolicyReferenceConfig,
  smokeEnvironment: Readonly<Record<string, string>>,
  runtime: ExecutionRuntimeProvenance,
  policyImportRoot: string,
): void {
  const script = [
    "import inspect,json,sys",
    "from pathlib import Path",
    "root=Path(sys.argv[1]).resolve(strict=True)",
    "policy_root=Path(sys.argv[2]).resolve(strict=True)",
    "sys.path[:0]=[str(root),str(policy_root)]",
    "import omnigent,rickgent_policies",
    "from rickgent_policies.context import verify_runtime_provenance_environment",
    "verify_runtime_provenance_environment()",
    "origin=Path(inspect.getfile(omnigent)).resolve(strict=True)",
    "policy_origin=Path(inspect.getfile(rickgent_policies)).resolve(strict=True)",
    "expected=json.loads(sys.argv[4])",
    "policies=rickgent_policies.validate_attached_policy_bundle(Path(sys.argv[3]),expected_config=expected,smoke=True)",
    "print(json.dumps({'origin':str(origin),'policy_origin':str(policy_origin),'names':[p.spec.name for p in policies]},sort_keys=True))",
  ].join(";");
  let parsed: { readonly origin: string; readonly policy_origin: string; readonly names: readonly string[] };
  try {
    const output = execFileSync(runtime.omnigent_python_entrypoint, ["-I", "-c", script, runtime.omnigent_root_realpath, policyImportRoot, bundleDir, JSON.stringify(expected)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env, ...smokeEnvironment },
    });
    parsed = JSON.parse(output) as typeof parsed;
  } catch (error) {
    throw new Error(`rendered worker failed real Omnigent FunctionPolicy startup: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (realpathSync(parsed.origin) !== runtime.omnigent_origin_realpath) throw new Error("rendered worker was parsed by a different Omnigent origin");
  if (realpathSync(parsed.policy_origin) !== runtime.rickgent_policies_origin_realpath) throw new Error("rendered worker was parsed by a different Rickgent policy origin");
  if (policyPackageSha256(parsed.policy_origin) !== runtime.rickgent_policies_sha256) throw new Error("Rickgent policy package changed before startup");
  const expectedNames = REQUIRED_POLICY_ATTACHMENTS.map((row) => row.name);
  if (canonicalJson(parsed.names) !== canonicalJson(expectedNames)) {
    throw new Error("real Omnigent FunctionPolicy startup observed the wrong attachment inventory");
  }
}

function leaseDocument(handle: PolicyBundleHandle): LeaseDocument {
  return JSON.parse(privateFileBytes(handle.leasePath, "attempt lease").toString("utf8")) as LeaseDocument;
}

function verifyExactDocument(value: object, expected: object, label: string): void {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(`${label} binding changed after publication`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function materializePolicyBundle(options: PolicyBundleMaterializationOptions): PolicyBundleHandle {
  const dispatchId = canonicalDispatchId(options.dispatch);
  if (options.ticket.id !== options.dispatch.ticketId) throw new Error("dispatch ticket id conflicts with TicketContract identity");
  if (options.ticket.schema_version !== TICKET_CONTRACT_SCHEMA_VERSION) throw new Error("unsupported TicketContract schema");
  if (![options.selection.harness, options.selection.model, options.selection.vendor].every((value) => typeof value === "string" && value.trim() !== "" && value === value.trim())) {
    throw new Error("router selection must contain non-empty canonical strings");
  }

  const template = validateWorkerTemplate(options.agentRoot);
  const targetRepo = realpathSync(options.workspace.callerRepo);
  const worktree = realpathSync(options.workspace.worktreeDir);
  const stateRoot = privateDirectory(options.stateRoot, "Rickgent state root", true);
  for (const [label, forbidden] of [["target repository", targetRepo], ["run worktree", worktree], ["worker template", template.templateDir]] as const) {
    if (pathsOverlap(stateRoot, forbidden)) throw new Error(`Rickgent state root overlaps ${label}`);
  }

  const attemptsRoot = privateChildDirectory(stateRoot, "policy-attempts");
  const nonceClaimsRoot = privateChildDirectory(stateRoot, "policy-nonce-claims");
  const attemptName = sha256(Buffer.from(dispatchId, "utf8"));
  let attemptRoot: string | null = null;
  let nonceClaimPath: string | null = null;
  let nonceClaimCreated = false;
  try {
    attemptRoot = exclusiveChildDirectory(attemptsRoot, attemptName, "attempt policy root");
    const bundleContainer = exclusiveChildDirectory(attemptRoot, "bundle", "attempt bundle container");
    const agents = exclusiveChildDirectory(bundleContainer, "agents", "attempt bundle agents root");
    const rickgent = exclusiveChildDirectory(agents, "rickgent", "attempt bundle Rickgent root");
    const nestedAgents = exclusiveChildDirectory(rickgent, "agents", "attempt bundle nested agents root");
    const bundleDir = join(nestedAgents, "worker");
    copyTree(template.templateDir, bundleDir);
    privateDirectory(bundleDir, "attempt worker bundle", false);

    const configPath = join(bundleDir, "config.yaml");
    const worker = parseWorkerConfig(configPath);
    const executor = mapping(worker["executor"], "worker executor");
    const executorConfig = mapping(executor["config"], "worker executor config");
    executorConfig["harness"] = options.selection.harness;
    const llm = mapping(worker["llm"], "worker llm");
    llm["model"] = options.selection.model;
    rewritePrivateFile(configPath, renderYaml(worker));

    const requestedConfigSha256 = sha256(privateFileBytes(configPath, "requested worker config"));
    const requestedBundleSha256 = policyBundleSha256(bundleDir);
    const runtime = probeRuntime(
      options.omnigentRoot ?? process.env.OMNIGENT_ROOT,
      options.omnigentPython ?? process.env.OMNIGENT_PYTHON,
      options.rickgentCli ?? process.env.RICKGENT_CLI_REALPATH ?? process.env.RICKGENT_BIN,
      options.nodeExecutable ?? process.execPath,
    );
    const ownerToken = randomBytes(32).toString("hex");
    const ownerTokenSha256 = sha256(ownerToken);
    const nonce = randomBytes(32).toString("hex");
    nonceClaimPath = join(nonceClaimsRoot, `${sha256(nonce)}.json`);
    const contextPath = join(attemptRoot, "context.json");
    const leasePath = join(attemptRoot, "lease.json");
    const receiptPath = join(attemptRoot, "receipt.jsonl");
    const leaseExpiresAtMs = options.leaseExpiresAtMs ?? Date.now() + 1_500_000;
    if (!Number.isSafeInteger(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
      throw new Error("attempt lease expiry must be a future safe-integer timestamp");
    }

    const context = createExecutionContext({
      dispatch: options.dispatch,
      ticketContractDigest: options.ticket.digest,
      ticketContractSchemaVersion: options.ticket.schema_version,
      declaredScope: options.ticket.scope,
      targetRepoRealpath: targetRepo,
      worktreeRealpath: worktree,
      stateRootRealpath: stateRoot,
      policyRootRealpath: attemptRoot,
      bundleRootRealpath: bundleDir,
      requestedHarness: options.selection.harness,
      requestedModel: options.selection.model,
      requestedVendor: options.selection.vendor,
      requestedBundleSha256,
      requestedConfigSha256,
      runtimeProvenance: runtime.provenance,
      ownerTokenSha256,
      nonce,
      nonceClaimPath,
      leasePath,
      receiptPath,
    });
    const materializedContext = materializeExecutionContext(contextPath, context);
    const claim: NonceClaimDocument = {
      schema_version: NONCE_CLAIM_SCHEMA_VERSION,
      dispatch_id: dispatchId,
      run_id: options.dispatch.runId,
      ticket_id: options.dispatch.ticketId,
      attempt: options.dispatch.attempt,
      lifecycle_phase: options.dispatch.phase,
      role: options.dispatch.role,
      context_sha256: materializedContext.sha256,
      owner_token_sha256: ownerTokenSha256,
      nonce,
    };
    writeExclusivePrivateFile(nonceClaimPath, Buffer.from(canonicalJson(claim), "utf8"));
    nonceClaimCreated = true;
    const lease: LeaseDocument = {
      schema_version: ATTEMPT_LEASE_SCHEMA_VERSION,
      dispatch_id: dispatchId,
      run_id: options.dispatch.runId,
      ticket_id: options.dispatch.ticketId,
      attempt: options.dispatch.attempt,
      lifecycle_phase: options.dispatch.phase,
      role: options.dispatch.role,
      context_sha256: materializedContext.sha256,
      owner_token_sha256: ownerTokenSha256,
      nonce,
      nonce_claim_path: nonceClaimPath,
      expires_at_ms: leaseExpiresAtMs,
      status: "active",
      closed_at_ms: null,
    };
    writeExclusivePrivateFile(leasePath, Buffer.from(canonicalJson(lease), "utf8"));
    writeExclusivePrivateFile(receiptPath, Buffer.alloc(0));

    const policyConfig: PolicyReferenceConfig = deepFreeze({
      rickgent_policy_abi: POLICY_ABI_VERSION,
      context_path: contextPath,
      context_sha256: materializedContext.sha256,
      context_owner_token_sha256: ownerTokenSha256,
      lease_path: leasePath,
      receipt_path: receiptPath,
      dispatch_id: dispatchId,
    });
    injectPolicyConfig(worker, policyConfig);
    rewritePrivateFile(configPath, renderYaml(worker));
    const invokedConfigSha256 = sha256(privateFileBytes(configPath, "invoked worker config"));
    const invokedBundleSha256 = policyBundleSha256(bundleDir);
    const spawnEnvironment = deepFreeze({
      RICKGENT_STATE_ROOT: stateRoot,
      RICKGENT_POLICY_ROOT: attemptRoot,
      RICKGENT_CONTEXT_PATH: contextPath,
      RICKGENT_CONTEXT_SHA256: materializedContext.sha256,
      RICKGENT_CONTEXT_OWNER_TOKEN: ownerToken,
      RICKGENT_CONTEXT_OWNER_TOKEN_SHA256: ownerTokenSha256,
      RICKGENT_NONCE_CLAIM_PATH: nonceClaimPath,
      RICKGENT_LEASE_PATH: leasePath,
      RICKGENT_RECEIPT_PATH: receiptPath,
      RICKGENT_DISPATCH_ID: dispatchId,
      RICKGENT_RUN_ID: options.dispatch.runId,
      RICKGENT_TICKET_ID: options.dispatch.ticketId,
      RICKGENT_ATTEMPT: String(options.dispatch.attempt),
      RICKGENT_LIFECYCLE_PHASE: options.dispatch.phase,
      RICKGENT_ROLE: options.dispatch.role,
      RICKGENT_CALLER_REPO_REALPATH: targetRepo,
      RICKGENT_WORKTREE_REALPATH: worktree,
      RICKGENT_BUNDLE_ROOT_REALPATH: bundleDir,
      RICKGENT_REQUESTED_BUNDLE_SHA256: requestedBundleSha256,
      RICKGENT_REQUESTED_CONFIG_SHA256: requestedConfigSha256,
      RICKGENT_INVOKED_BUNDLE_SHA256: invokedBundleSha256,
      RICKGENT_INVOKED_CONFIG_SHA256: invokedConfigSha256,
      RICKGENT_OMNIGENT_PYTHON_ENTRYPOINT: runtime.provenance.omnigent_python_entrypoint,
      RICKGENT_OMNIGENT_PYTHON_REALPATH: runtime.provenance.omnigent_python_realpath,
      RICKGENT_OMNIGENT_PYTHON_SHA256: runtime.provenance.omnigent_python_sha256,
      RICKGENT_OMNIGENT_ROOT_REALPATH: runtime.provenance.omnigent_root_realpath,
      RICKGENT_OMNIGENT_ORIGIN_REALPATH: runtime.provenance.omnigent_origin_realpath,
      RICKGENT_POLICIES_ORIGIN_REALPATH: runtime.provenance.rickgent_policies_origin_realpath,
      RICKGENT_POLICIES_SHA256: runtime.provenance.rickgent_policies_sha256,
      RICKGENT_NODE_REALPATH: runtime.provenance.rickgent_node_realpath,
      RICKGENT_NODE_SHA256: runtime.provenance.rickgent_node_sha256,
      RICKGENT_CLI_REALPATH: runtime.provenance.rickgent_cli_realpath,
      RICKGENT_CLI_SHA256: runtime.provenance.rickgent_cli_sha256,
      RICKGENT_BUILD_COMMIT: runtime.provenance.rickgent_build_commit,
    });
    proveRealOmnigentPolicyConfig(
      bundleDir,
      policyConfig,
      spawnEnvironment,
      runtime.provenance,
      runtime.policyImportRoot,
    );
    const handle: PolicyBundleHandle = deepFreeze({
      kind: "materialized_authenticated_policy_bundle" as const,
      templateDir: template.templateDir,
      stateRoot,
      attemptsRoot,
      attemptRoot,
      policyRoot: attemptRoot,
      bundleDir,
      configPath,
      configSha256: invokedConfigSha256,
      requestedConfigSha256,
      requestedBundleSha256,
      invokedConfigSha256,
      invokedBundleSha256,
      context,
      contextPath,
      contextSha256: materializedContext.sha256,
      contextByteLength: materializedContext.byteLength,
      ownerToken,
      ownerTokenSha256,
      nonce,
      nonceClaimPath,
      leasePath,
      receiptPath,
      leaseExpiresAtMs,
      policyConfig,
      runtimeProvenance: runtime.provenance,
      trustedSpawnCommand: deepFreeze({
        executable: runtime.provenance.omnigent_python_entrypoint,
        argvPrefix: [
          "-I",
          "-c",
          TRUSTED_OMNIGENT_LAUNCHER,
          runtime.provenance.omnigent_root_realpath,
          runtime.policyImportRoot,
        ],
      }),
      spawnEnvironment,
      declaredPaths: Object.freeze(ticketOwnedPaths(options.ticket)),
    });
    verifyPolicyBundleForSpawn(handle);
    return handle;
  } catch (error) {
    if (attemptRoot !== null) rmSync(attemptRoot, { recursive: true, force: true });
    if (nonceClaimCreated && nonceClaimPath !== null) rmSync(nonceClaimPath, { force: true });
    throw error;
  }
}

function verifyPolicyBundle(handle: PolicyBundleHandle, requireUnexpiredLease: boolean): void {
  privateDirectory(handle.stateRoot, "Rickgent state root", false);
  privateDirectory(handle.attemptRoot, "attempt policy root", false);
  privateDirectory(handle.bundleDir, "attempt worker bundle", false);
  const materializedContext: MaterializedExecutionContext = {
    context: handle.context,
    path: handle.contextPath,
    sha256: handle.contextSha256,
    byteLength: handle.contextByteLength,
  };
  verifyMaterializedExecutionContext(materializedContext);
  const observedRuntime = probeRuntime(
    handle.runtimeProvenance.omnigent_root_realpath,
    handle.runtimeProvenance.omnigent_python_entrypoint,
    handle.runtimeProvenance.rickgent_cli_realpath,
    handle.runtimeProvenance.rickgent_node_realpath,
  ).provenance;
  verifyExactDocument(observedRuntime, handle.runtimeProvenance, "runtime provenance");
  if (
    handle.trustedSpawnCommand.executable !== handle.runtimeProvenance.omnigent_python_entrypoint
    || handle.trustedSpawnCommand.argvPrefix[0] !== "-I"
    || handle.trustedSpawnCommand.argvPrefix[1] !== "-c"
    || handle.trustedSpawnCommand.argvPrefix[2] !== TRUSTED_OMNIGENT_LAUNCHER
    || handle.trustedSpawnCommand.argvPrefix[3] !== handle.runtimeProvenance.omnigent_root_realpath
    || handle.trustedSpawnCommand.argvPrefix[4] !== dirname(dirname(handle.runtimeProvenance.rickgent_policies_origin_realpath))
    || handle.trustedSpawnCommand.argvPrefix.length !== 5
  ) {
    throw new Error("trusted Omnigent spawn command changed after publication");
  }
  if (sha256(handle.ownerToken) !== handle.ownerTokenSha256) throw new Error("attempt owner token no longer matches its digest");

  const expectedClaim: NonceClaimDocument = {
    schema_version: NONCE_CLAIM_SCHEMA_VERSION,
    dispatch_id: handle.context.dispatch_id,
    run_id: handle.context.run_id,
    ticket_id: handle.context.ticket_id,
    attempt: handle.context.attempt,
    lifecycle_phase: handle.context.lifecycle_phase,
    role: handle.context.role,
    context_sha256: handle.contextSha256,
    owner_token_sha256: handle.ownerTokenSha256,
    nonce: handle.nonce,
  };
  verifyExactDocument(
    JSON.parse(privateFileBytes(handle.nonceClaimPath, "nonce claim").toString("utf8")),
    expectedClaim,
    "attempt nonce claim",
  );
  const expectedLease: LeaseDocument = {
    schema_version: ATTEMPT_LEASE_SCHEMA_VERSION,
    dispatch_id: handle.context.dispatch_id,
    run_id: handle.context.run_id,
    ticket_id: handle.context.ticket_id,
    attempt: handle.context.attempt,
    lifecycle_phase: handle.context.lifecycle_phase,
    role: handle.context.role,
    context_sha256: handle.contextSha256,
    owner_token_sha256: handle.ownerTokenSha256,
    nonce: handle.nonce,
    nonce_claim_path: handle.nonceClaimPath,
    expires_at_ms: handle.leaseExpiresAtMs,
    status: "active",
    closed_at_ms: null,
  };
  verifyExactDocument(leaseDocument(handle), expectedLease, "attempt lease");
  if (requireUnexpiredLease && handle.leaseExpiresAtMs <= Date.now()) throw new Error("attempt lease expired before spawn");
  privateFileBytes(handle.receiptPath, "policy receipt destination");
  if (sha256(privateFileBytes(handle.configPath, "invoked worker config")) !== handle.invokedConfigSha256) {
    throw new Error("invoked worker config digest changed before spawn");
  }
  if (policyBundleSha256(handle.bundleDir) !== handle.invokedBundleSha256) {
    throw new Error("invoked worker bundle digest changed before spawn");
  }
}

export function verifyPolicyBundleForSpawn(handle: PolicyBundleHandle): void {
  verifyPolicyBundle(handle, true);
}

export function closePolicyBundleLease(handle: PolicyBundleHandle): void {
  const lease = leaseDocument(handle);
  if (lease.owner_token_sha256 !== sha256(handle.ownerToken)) throw new Error("attempt lease has the wrong owner token");
  if (lease.status === "closed") return;
  verifyPolicyBundle(handle, false);
  const closed: LeaseDocument = { ...lease, status: "closed", closed_at_ms: Date.now() };
  const temporary = join(dirname(handle.leasePath), `.lease-close-${randomBytes(12).toString("hex")}`);
  writeExclusivePrivateFile(temporary, Buffer.from(canonicalJson(closed), "utf8"));
  renameSync(temporary, handle.leasePath);
  chmodSync(handle.leasePath, 0o600);
  verifyExactDocument(leaseDocument(handle), closed, "closed attempt lease");
}

export function finalizePolicyBundle(
  handle: PolicyBundleHandle,
  proof: PolicyBundleFinalizationProof,
): PolicyBundleFinalizationResult {
  if (!proof.childClosed) {
    if (proof.disposition !== "retain") throw new Error("policy bundle cannot move or delete before child close");
    return Object.freeze({ disposition: "retained" as const, path: handle.attemptRoot, leaseClosed: false });
  }
  closePolicyBundleLease(handle);
  if (proof.disposition === "retain") {
    return Object.freeze({ disposition: "retained" as const, path: handle.attemptRoot, leaseClosed: true });
  }
  if (!proof.workspaceCleanupProven) throw new Error("policy bundle cleanup requires proven workspace cleanup");
  if (proof.disposition === "remove") {
    rmSync(handle.attemptRoot, { recursive: true });
    if (existsSync(handle.attemptRoot)) throw new Error("policy bundle removal was not proven");
    return Object.freeze({ disposition: "removed" as const, path: handle.attemptRoot, leaseClosed: true });
  }
  const quarantineRoot = privateChildDirectory(handle.stateRoot, "policy-quarantine");
  const quarantinePath = join(quarantineRoot, basename(handle.attemptRoot));
  renameSync(handle.attemptRoot, quarantinePath);
  return Object.freeze({ disposition: "quarantined" as const, path: quarantinePath, leaseClosed: true });
}
