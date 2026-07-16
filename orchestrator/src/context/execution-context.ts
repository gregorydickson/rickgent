import { createHash } from "crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "fs";
import { canonicalJson, TICKET_CONTRACT_SCHEMA_VERSION, type TicketScopeEntry } from "../contracts/ticket-contract.js";

export const EXECUTION_CONTEXT_SCHEMA_VERSION = "rickgent-attempt-context/v1" as const;
export const POLICY_ABI_VERSION = "omnigent-function-policy/current-v1" as const;
export const IDENTITY_NORMALIZATION_VERSION = "rickgent-identity-normalization/v1" as const;
export const RUNTIME_PROVENANCE_SCHEMA_VERSION = "rickgent-runtime-provenance/v2" as const;
export const ATTEMPT_LEASE_SCHEMA_VERSION = "rickgent-attempt-lease/v1" as const;
export const NONCE_CLAIM_SCHEMA_VERSION = "rickgent-attempt-nonce-claim/v1" as const;
export const MAX_EXECUTION_CONTEXT_BYTES = 1_048_576;

const ID_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TICKET_DIGEST = /^sha256:[0-9a-f]{64}$/;

const HARNESS_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  agy: "antigravity",
  claude: "claude-sdk",
  "github-copilot": "copilot",
  "google-antigravity": "antigravity",
  "kimi-code": "kimi",
  "native-antigravity": "antigravity-native",
  "native-goose": "goose-native",
  "native-hermes": "hermes-native",
  "native-kimi": "kimi-native",
  "native-kiro": "kiro-native",
  "native-opencode": "opencode-native",
  "native-pi": "pi-native",
  "native-qwen": "qwen-native",
  "openai-agents-sdk": "openai-agents",
  opencode: "opencode-native",
  "qwen-code": "qwen",
  "acp:probe": "acp",
});

export interface ExecutionDispatchId {
  readonly runId: string;
  readonly ticketId: string;
  readonly phase: string;
  readonly attempt: number;
  readonly role: string;
}

export interface RequestedExecutionIdentity {
  readonly normalization_version: typeof IDENTITY_NORMALIZATION_VERSION;
  readonly raw_harness: string;
  readonly canonical_harness: string;
  readonly raw_provider: string;
  readonly canonical_provider: string;
  readonly raw_vendor: string;
  readonly canonical_vendor: string;
  readonly raw_model_id: string;
  readonly canonical_model_id: string;
  readonly bundle_digest: string;
  readonly config_digest: string;
  readonly profile: "effective-session-v1";
  readonly profile_available: true;
  readonly conflict: false;
}

export interface ExecutionScopeEntry {
  readonly path: string;
  readonly change_kind: TicketScopeEntry["change_kind"];
  readonly directory: boolean;
  readonly from_path?: string;
}

export interface ExecutionRuntimeProvenance {
  readonly schema_version: typeof RUNTIME_PROVENANCE_SCHEMA_VERSION;
  /** Exact invocation path, including virtual-environment entrypoint semantics. */
  readonly omnigent_python_entrypoint: string;
  /** Canonical target reached by the authenticated Python entrypoint. */
  readonly omnigent_python_realpath: string;
  readonly omnigent_python_sha256: string;
  readonly omnigent_root_realpath: string;
  readonly omnigent_origin_realpath: string;
  readonly rickgent_policies_origin_realpath: string;
  readonly rickgent_policies_sha256: string;
  readonly rickgent_node_realpath: string;
  readonly rickgent_node_sha256: string;
  readonly rickgent_cli_realpath: string;
  readonly rickgent_cli_sha256: string;
  readonly rickgent_build_commit: string;
}

export interface ExecutionContext {
  readonly schema_version: typeof EXECUTION_CONTEXT_SCHEMA_VERSION;
  readonly policy_abi_version: typeof POLICY_ABI_VERSION;
  readonly ticket_contract_schema_version: typeof TICKET_CONTRACT_SCHEMA_VERSION;
  readonly identity_normalization_version: typeof IDENTITY_NORMALIZATION_VERSION;
  readonly dispatch_id: string;
  readonly run_id: string;
  readonly ticket_id: string;
  readonly attempt: number;
  readonly lifecycle_phase: string;
  readonly role: string;
  readonly target_repo_realpath: string;
  readonly worktree_realpath: string;
  readonly state_root_realpath: string;
  readonly policy_root_realpath: string;
  readonly bundle_root_realpath: string;
  readonly ticket_contract_digest: string;
  readonly declared_scope: readonly ExecutionScopeEntry[];
  readonly requested_identity: RequestedExecutionIdentity;
  readonly runtime_provenance: ExecutionRuntimeProvenance;
  readonly requested_bundle_sha256: string;
  readonly requested_config_sha256: string;
  readonly attempt_digest: string;
  readonly owner_token_sha256: string;
  readonly nonce: string;
  readonly nonce_claim_path: string;
  readonly lease_path: string;
  readonly receipt_path: string;
}

export interface CreateExecutionContextInput {
  readonly dispatch: ExecutionDispatchId;
  readonly ticketContractDigest: string;
  readonly ticketContractSchemaVersion: typeof TICKET_CONTRACT_SCHEMA_VERSION;
  readonly declaredScope: readonly TicketScopeEntry[];
  readonly targetRepoRealpath: string;
  readonly worktreeRealpath: string;
  readonly stateRootRealpath: string;
  readonly policyRootRealpath: string;
  readonly bundleRootRealpath: string;
  readonly requestedHarness: string;
  readonly requestedModel: string;
  readonly requestedVendor: string;
  readonly requestedBundleSha256: string;
  readonly requestedConfigSha256: string;
  readonly runtimeProvenance: ExecutionRuntimeProvenance;
  readonly ownerTokenSha256: string;
  readonly nonce: string;
  readonly nonceClaimPath: string;
  readonly leasePath: string;
  readonly receiptPath: string;
}

export interface MaterializedExecutionContext {
  readonly context: ExecutionContext;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

function requireComponent(value: string, label: string): string {
  if (typeof value !== "string" || !ID_COMPONENT.test(value)) {
    throw new Error(`${label} must be a non-empty canonical identity token`);
  }
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function requireSha256(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

export function canonicalDispatchId(id: ExecutionDispatchId): string {
  const runId = requireComponent(id.runId, "dispatch.runId");
  const ticketId = requireComponent(id.ticketId, "dispatch.ticketId");
  const phase = requireComponent(id.phase, "dispatch.phase");
  const role = requireComponent(id.role, "dispatch.role");
  if (!Number.isSafeInteger(id.attempt) || id.attempt < 1) {
    throw new Error("dispatch.attempt must be a positive safe integer");
  }
  return `${runId}/${ticketId}/${phase}/${id.attempt}/${role}`;
}

/** Apply only the explicit alias corpus frozen by t00. */
export function canonicalHarnessIdentity(rawHarness: string): string {
  requireNonEmpty(rawHarness, "requested harness");
  return HARNESS_ALIASES[rawHarness] ?? rawHarness;
}

function copyScope(scope: readonly TicketScopeEntry[]): ExecutionScopeEntry[] {
  return scope.map((entry) => {
    const common = {
      path: entry.path,
      change_kind: entry.change_kind,
      directory: entry.directory,
    };
    return entry.from_path === undefined
      ? common
      : { ...common, from_path: entry.from_path };
  });
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeRecursively(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function executionAttemptDigest(
  context: Omit<ExecutionContext, "attempt_digest" | "owner_token_sha256" | "nonce" | "nonce_claim_path" | "lease_path" | "receipt_path">,
): string {
  return createHash("sha256").update(canonicalJson(context), "utf8").digest("hex");
}

export function createExecutionContext(input: CreateExecutionContextInput): ExecutionContext {
  const dispatchId = canonicalDispatchId(input.dispatch);
  if (!TICKET_DIGEST.test(input.ticketContractDigest)) {
    throw new Error("ticketContractDigest must retain its canonical sha256: prefix");
  }
  if (input.ticketContractSchemaVersion !== TICKET_CONTRACT_SCHEMA_VERSION) {
    throw new Error("ticket contract schema version is unsupported");
  }
  const requestedBundleSha256 = requireSha256(input.requestedBundleSha256, "requestedBundleSha256");
  const requestedConfigSha256 = requireSha256(input.requestedConfigSha256, "requestedConfigSha256");
  const ownerTokenSha256 = requireSha256(input.ownerTokenSha256, "ownerTokenSha256");
  const provider = requireNonEmpty(input.requestedVendor, "requested vendor/provider");
  const harness = requireNonEmpty(input.requestedHarness, "requested harness");
  const model = requireNonEmpty(input.requestedModel, "requested model");
  const runtimeProvenance: ExecutionRuntimeProvenance = {
    schema_version: input.runtimeProvenance.schema_version,
    omnigent_python_entrypoint: requireNonEmpty(input.runtimeProvenance.omnigent_python_entrypoint, "Omnigent Python entrypoint"),
    omnigent_python_realpath: requireNonEmpty(input.runtimeProvenance.omnigent_python_realpath, "Omnigent Python realpath"),
    omnigent_python_sha256: requireSha256(input.runtimeProvenance.omnigent_python_sha256, "Omnigent Python digest"),
    omnigent_root_realpath: requireNonEmpty(input.runtimeProvenance.omnigent_root_realpath, "Omnigent root realpath"),
    omnigent_origin_realpath: requireNonEmpty(input.runtimeProvenance.omnigent_origin_realpath, "Omnigent origin realpath"),
    rickgent_policies_origin_realpath: requireNonEmpty(input.runtimeProvenance.rickgent_policies_origin_realpath, "Rickgent policies origin realpath"),
    rickgent_policies_sha256: requireSha256(input.runtimeProvenance.rickgent_policies_sha256, "Rickgent policies digest"),
    rickgent_node_realpath: requireNonEmpty(input.runtimeProvenance.rickgent_node_realpath, "Rickgent Node realpath"),
    rickgent_node_sha256: requireSha256(input.runtimeProvenance.rickgent_node_sha256, "Rickgent Node digest"),
    rickgent_cli_realpath: requireNonEmpty(input.runtimeProvenance.rickgent_cli_realpath, "Rickgent CLI realpath"),
    rickgent_cli_sha256: requireSha256(input.runtimeProvenance.rickgent_cli_sha256, "Rickgent CLI digest"),
    rickgent_build_commit: requireNonEmpty(input.runtimeProvenance.rickgent_build_commit, "Rickgent build commit"),
  };
  if (runtimeProvenance.schema_version !== RUNTIME_PROVENANCE_SCHEMA_VERSION) {
    throw new Error("runtime provenance schema version is unsupported");
  }

  const requestedIdentity: RequestedExecutionIdentity = {
    normalization_version: IDENTITY_NORMALIZATION_VERSION,
    raw_harness: harness,
    canonical_harness: canonicalHarnessIdentity(harness),
    raw_provider: provider,
    canonical_provider: provider,
    raw_vendor: provider,
    canonical_vendor: provider,
    raw_model_id: model,
    canonical_model_id: model,
    bundle_digest: requestedBundleSha256,
    config_digest: requestedConfigSha256,
    profile: "effective-session-v1",
    profile_available: true,
    conflict: false,
  };
  const declaredScope = copyScope(input.declaredScope);
  const digestBase = {
    schema_version: EXECUTION_CONTEXT_SCHEMA_VERSION,
    policy_abi_version: POLICY_ABI_VERSION,
    ticket_contract_schema_version: TICKET_CONTRACT_SCHEMA_VERSION,
    identity_normalization_version: IDENTITY_NORMALIZATION_VERSION,
    dispatch_id: dispatchId,
    run_id: input.dispatch.runId,
    ticket_id: input.dispatch.ticketId,
    attempt: input.dispatch.attempt,
    lifecycle_phase: input.dispatch.phase,
    role: input.dispatch.role,
    target_repo_realpath: requireNonEmpty(input.targetRepoRealpath, "targetRepoRealpath"),
    worktree_realpath: requireNonEmpty(input.worktreeRealpath, "worktreeRealpath"),
    state_root_realpath: requireNonEmpty(input.stateRootRealpath, "stateRootRealpath"),
    policy_root_realpath: requireNonEmpty(input.policyRootRealpath, "policyRootRealpath"),
    bundle_root_realpath: requireNonEmpty(input.bundleRootRealpath, "bundleRootRealpath"),
    ticket_contract_digest: input.ticketContractDigest,
    declared_scope: declaredScope,
    requested_identity: requestedIdentity,
    runtime_provenance: runtimeProvenance,
    requested_bundle_sha256: requestedBundleSha256,
    requested_config_sha256: requestedConfigSha256,
  } as const;
  const context: ExecutionContext = {
    ...digestBase,
    attempt_digest: executionAttemptDigest(digestBase),
    owner_token_sha256: ownerTokenSha256,
    nonce: requireNonEmpty(input.nonce, "nonce"),
    nonce_claim_path: requireNonEmpty(input.nonceClaimPath, "nonceClaimPath"),
    lease_path: requireNonEmpty(input.leasePath, "leasePath"),
    receipt_path: requireNonEmpty(input.receiptPath, "receiptPath"),
  };
  return freezeRecursively(context);
}

export function serializeExecutionContext(context: ExecutionContext): Buffer {
  const bytes = Buffer.from(canonicalJson(context), "utf8");
  if (bytes.length > MAX_EXECUTION_CONTEXT_BYTES) {
    throw new Error(`execution context exceeds ${MAX_EXECUTION_CONTEXT_BYTES} bytes`);
  }
  return bytes;
}

function readPrivateRegularFile(path: string, expectedBytes?: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`execution context is not a regular file: ${path}`);
    if ((before.mode & 0o777) !== 0o600) throw new Error(`execution context mode is not 0600: ${path}`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error(`execution context owner is not the orchestrator uid: ${path}`);
    }
    if (expectedBytes !== undefined && before.size !== expectedBytes) {
      throw new Error(`execution context size changed after publication: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`execution context changed while it was read: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function materializeExecutionContext(path: string, context: ExecutionContext): MaterializedExecutionContext {
  const bytes = serializeExecutionContext(context);
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
      throw new Error("published execution context failed descriptor verification");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("published execution context has a foreign owner");
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (createHash("sha256").update(readPrivateRegularFile(path, bytes.length)).digest("hex") !== digest) {
    throw new Error("execution context changed immediately after publication");
  }
  return freezeRecursively({ context, path, sha256: digest, byteLength: bytes.length });
}

export function verifyMaterializedExecutionContext(materialized: MaterializedExecutionContext): void {
  const bytes = readPrivateRegularFile(materialized.path, materialized.byteLength);
  if (bytes.length > MAX_EXECUTION_CONTEXT_BYTES) throw new Error("execution context exceeds the size limit");
  if (createHash("sha256").update(bytes).digest("hex") !== materialized.sha256) {
    throw new Error("execution context digest changed after publication");
  }
  if (!bytes.equals(serializeExecutionContext(materialized.context))) {
    throw new Error("execution context bytes no longer match the immutable projection");
  }
}
