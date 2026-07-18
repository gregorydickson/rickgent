import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../contracts/ticket-contract.js";
import {
  isAuthorizedAttemptWorkspaceResourceReceipt,
  type AttemptWorkspacePlan,
  type AttemptWorkspaceResourceReceipt,
  type FixedAttemptResourceKind,
} from "../git/attempt-workspace.js";
import type { StateRecord, StateStore } from "./store.js";

const OWNERSHIP_COMMAND_AUTHORITY = Symbol("rickgent.attempt-ownership-authority");
const PREPARED_ACQUISITIONS = new WeakSet<object>();
const AUTHORIZED_OWNERSHIP_COMMANDS = new WeakSet<object>();
const AUTHORIZED_OWNERSHIP_GRANTS = new WeakSet<object>();
const GRANT_TOKENS = new WeakMap<object, string>();

const DEFAULT_TTL_MS = 30_000;
export const MINIMUM_OWNERSHIP_TTL_MS = 1_000;
export const MAXIMUM_OWNERSHIP_TTL_MS = 300_000;

export type AttemptOwnershipPurpose = "execution" | "recovery_cleanup";
export type AttemptOwnershipState = "live" | "cleanup_pending" | "released" | "quarantined";
export type AttemptResourceClaimState = "reserved" | "allocated" | "active" | "cleanup_pending" | "released" | "quarantined";

export interface AttemptOwnershipSnapshot {
  readonly ownershipId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly contextDigest: string;
  readonly recoveredFromOwnershipId: string | null;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly state: AttemptOwnershipState;
  readonly stateVersion: number;
  readonly createdAt: string;
}

export interface AttemptResourceClaimSnapshot {
  readonly resourceClaimId: string;
  readonly attemptId: string;
  readonly slot: FixedAttemptResourceKind;
  readonly kind: FixedAttemptResourceKind;
  readonly canonicalIdentity: string;
  readonly identityDigest: string;
  readonly allocationOwnershipId: string;
  readonly currentOwnershipId: string;
  readonly ownerGeneration: number;
  readonly state: AttemptResourceClaimState;
  readonly stateVersion: number;
  readonly releaseProofDigest: string | null;
  readonly quarantineProofDigest: string | null;
  readonly createdAt: string;
}

export interface AttemptOwnershipStoreResult {
  readonly replayed: boolean;
  readonly purpose: AttemptOwnershipPurpose;
  readonly plan: AttemptWorkspacePlan;
  /** Exact immutable post-image committed by this operation. */
  readonly ownership: StateRecord;
  readonly resources: readonly StateRecord[];
  /** Current durable image, which may have advanced after an idempotent replay. */
  readonly currentOwnership: StateRecord;
  readonly currentResources: readonly StateRecord[];
}

export interface PrepareOwnershipAcquisitionRequest {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly ttlMs?: number;
}

export interface AdvanceAttemptWorkspaceResourceRequest {
  readonly ownership: AttemptOwnershipGrant;
  readonly receipt: AttemptWorkspaceResourceReceipt;
  readonly idempotencyKey: string;
}

export interface OwnershipMutationRequest {
  readonly ownership: AttemptOwnershipGrant;
  readonly idempotencyKey: string;
}

export interface CommitRefProofInput {
  readonly commitIntentId: string;
  readonly attemptRef: string;
  readonly baselineOid: string;
  readonly commitOid: string;
}

export interface PrepareStaleRecoveryRequest {
  readonly attemptId: string;
  readonly expiredOwnershipId: string;
  readonly deathEvidenceId: string;
  readonly idempotencyKey: string;
  readonly ttlMs?: number;
}

export type AttemptOwnershipCommandKind =
  | "acquire"
  | "assert_current"
  | "heartbeat"
  | "advance_resource"
  | "begin_cleanup"
  | "stale_recovery";

export interface AttemptOwnershipCommandPayload {
  readonly kind: AttemptOwnershipCommandKind;
  readonly repositoryId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly ownerTokenDigest: string;
  readonly ttlMs: number;
  readonly ownershipId?: string;
  readonly expectedOwnershipState?: AttemptOwnershipState;
  readonly expectedOwnershipVersion?: number;
  readonly slot?: FixedAttemptResourceKind;
  readonly expectedResourceState?: AttemptResourceClaimState;
  readonly expectedResourceVersion?: number;
  readonly toResourceState?: AttemptResourceClaimState;
  readonly expiredOwnershipId?: string;
  readonly deathEvidenceId?: string;
}

function assertIdempotencyKey(value: string): void {
  if (value === "" || value !== value.trim() || value.length > 240) throw new TypeError("ownership idempotency key is invalid");
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < MINIMUM_OWNERSHIP_TTL_MS || value > MAXIMUM_OWNERSHIP_TTL_MS) {
    throw new TypeError(`ownership TTL must be between ${MINIMUM_OWNERSHIP_TTL_MS} and ${MAXIMUM_OWNERSHIP_TTL_MS} ms`);
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} is not a SHA-256 digest`);
}

function tokenDigest(token: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("rickgent.attempt-owner-token.v1\0").update(token).digest("hex")}`;
}

export class PreparedOwnershipAcquisition {
  readonly command: AttemptOwnershipCommand;
  readonly #token: string;

  constructor(authority: symbol, command: AttemptOwnershipCommand, token: string) {
    if (authority !== OWNERSHIP_COMMAND_AUTHORITY) throw new TypeError("ownership acquisition can only be prepared by LeaseAuthority");
    this.command = command;
    this.#token = token;
    PREPARED_ACQUISITIONS.add(this);
    Object.freeze(this);
  }

  /** @internal The secret is consumed only by LeaseAuthority when minting the grant. */
  consumeToken(authority: symbol): string {
    if (authority !== OWNERSHIP_COMMAND_AUTHORITY || !PREPARED_ACQUISITIONS.has(this)) {
      throw new TypeError("ownership acquisition token access is unauthorized");
    }
    return this.#token;
  }
}

export class AttemptOwnershipCommand {
  readonly payload: AttemptOwnershipCommandPayload;

  constructor(authority: symbol, payload: AttemptOwnershipCommandPayload) {
    if (authority !== OWNERSHIP_COMMAND_AUTHORITY) throw new TypeError("ownership commands can only be minted by LeaseAuthority");
    this.payload = Object.freeze({ ...payload });
    AUTHORIZED_OWNERSHIP_COMMANDS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedAttemptOwnershipCommand(value: unknown): value is AttemptOwnershipCommand {
  return typeof value === "object" && value !== null && AUTHORIZED_OWNERSHIP_COMMANDS.has(value);
}

function ownershipSnapshot(row: StateRecord): AttemptOwnershipSnapshot {
  return Object.freeze({
    ownershipId: String(row.ownership_id),
    attemptId: String(row.attempt_id),
    generation: Number(row.generation),
    contextDigest: String(row.context_digest),
    recoveredFromOwnershipId: row.recovered_from_ownership_id === null ? null : String(row.recovered_from_ownership_id),
    heartbeatAt: String(row.heartbeat_at),
    expiresAt: String(row.expires_at),
    state: String(row.state) as AttemptOwnershipState,
    stateVersion: Number(row.state_version),
    createdAt: String(row.created_at),
  });
}

function resourceSnapshot(row: StateRecord): AttemptResourceClaimSnapshot {
  return Object.freeze({
    resourceClaimId: String(row.resource_claim_id),
    attemptId: String(row.attempt_id),
    slot: String(row.slot) as FixedAttemptResourceKind,
    kind: String(row.kind) as FixedAttemptResourceKind,
    canonicalIdentity: String(row.canonical_identity),
    identityDigest: String(row.identity_digest),
    allocationOwnershipId: String(row.allocation_ownership_id),
    currentOwnershipId: String(row.current_ownership_id),
    ownerGeneration: Number(row.owner_generation),
    state: String(row.state) as AttemptResourceClaimState,
    stateVersion: Number(row.state_version),
    releaseProofDigest: row.release_proof_digest === null ? null : String(row.release_proof_digest),
    quarantineProofDigest: row.quarantine_proof_digest === null ? null : String(row.quarantine_proof_digest),
    createdAt: String(row.created_at),
  });
}

export class AttemptOwnershipGrant {
  readonly purpose: AttemptOwnershipPurpose;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly gitCommonDirectory: string;
  readonly plan: AttemptWorkspacePlan;
  readonly ownership: AttemptOwnershipSnapshot;
  readonly resources: readonly AttemptResourceClaimSnapshot[];
  readonly currentOwnership: AttemptOwnershipSnapshot;
  readonly currentResources: readonly AttemptResourceClaimSnapshot[];
  readonly replayed: boolean;

  constructor(
    authority: symbol,
    repositoryId: string,
    repositoryPath: string,
    gitCommonDirectory: string,
    token: string,
    result: AttemptOwnershipStoreResult,
  ) {
    if (authority !== OWNERSHIP_COMMAND_AUTHORITY) throw new TypeError("ownership grants can only be minted by LeaseAuthority");
    this.purpose = result.purpose;
    this.repositoryId = repositoryId;
    this.repositoryPath = repositoryPath;
    this.gitCommonDirectory = gitCommonDirectory;
    this.plan = result.plan;
    this.ownership = ownershipSnapshot(result.ownership);
    this.resources = Object.freeze(result.resources.map(resourceSnapshot));
    this.currentOwnership = ownershipSnapshot(result.currentOwnership);
    this.currentResources = Object.freeze(result.currentResources.map(resourceSnapshot));
    this.replayed = result.replayed;
    GRANT_TOKENS.set(this, token);
    AUTHORIZED_OWNERSHIP_GRANTS.add(this);
    Object.freeze(this);
  }

  get attemptId(): string {
    return this.ownership.attemptId;
  }
}

export function isAuthorizedAttemptOwnershipGrant(value: unknown): value is AttemptOwnershipGrant {
  return typeof value === "object" && value !== null && AUTHORIZED_OWNERSHIP_GRANTS.has(value);
}

function requireGrantToken(grant: AttemptOwnershipGrant): string {
  if (!isAuthorizedAttemptOwnershipGrant(grant)) throw new TypeError("ownership grant was not minted by LeaseAuthority");
  const token = GRANT_TOKENS.get(grant);
  if (token === undefined) throw new TypeError("ownership credential is unavailable");
  return token;
}

function command(payload: AttemptOwnershipCommandPayload): AttemptOwnershipCommand {
  assertIdempotencyKey(payload.idempotencyKey);
  assertTtl(payload.ttlMs);
  assertDigest(payload.ownerTokenDigest, "owner token digest");
  return new AttemptOwnershipCommand(OWNERSHIP_COMMAND_AUTHORITY, payload);
}

/** Raw credentials stay in this module; Store receives only authorized digest-bearing commands. */
export class LeaseAuthority {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  prepareAcquisition(request: PrepareOwnershipAcquisitionRequest): PreparedOwnershipAcquisition {
    const ttlMs = request.ttlMs ?? DEFAULT_TTL_MS;
    const token = randomBytes(32).toString("base64url");
    return new PreparedOwnershipAcquisition(OWNERSHIP_COMMAND_AUTHORITY, command({
      kind: "acquire",
      repositoryId: this.#store.location.repositoryId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      ownerTokenDigest: tokenDigest(token),
      ttlMs,
    }), token);
  }

  acquire(prepared: PreparedOwnershipAcquisition): AttemptOwnershipGrant {
    if (!PREPARED_ACQUISITIONS.has(prepared)) throw new TypeError("ownership acquisition was not prepared by LeaseAuthority");
    const token = prepared.consumeToken(OWNERSHIP_COMMAND_AUTHORITY);
    return this.#grant(token, this.#store.commitAuthorizedAttemptOwnership(prepared.command));
  }

  heartbeat(request: OwnershipMutationRequest): AttemptOwnershipGrant {
    return this.#commitForGrant(request.ownership, {
      kind: "heartbeat",
      idempotencyKey: request.idempotencyKey,
      expectedOwnershipState: "live",
      expectedOwnershipVersion: request.ownership.ownership.stateVersion,
    });
  }

  /** Re-reads token-bound ownership immediately before an external side effect or spawn. */
  assertFresh(ownership: AttemptOwnershipGrant): AttemptOwnershipGrant {
    return this.#commitForGrant(ownership, {
      kind: "assert_current",
      idempotencyKey: `assert-current:${ownership.ownership.ownershipId}`,
    });
  }

  /** Token-bound proof that a ref transaction was issued by this exact in-memory owner. */
  deriveCommitRefProof(ownership: AttemptOwnershipGrant, input: CommitRefProofInput): `sha256:${string}` {
    const token = requireGrantToken(ownership);
    for (const [label, value] of [
      ["commit intent id", input.commitIntentId], ["attempt ref", input.attemptRef],
      ["baseline oid", input.baselineOid], ["commit oid", input.commitOid],
    ] as const) {
      if (value === "" || value.includes("\0") || value.includes("\n")) {
        throw new TypeError(`${label} is invalid for commit ref proof`);
      }
    }
    return `sha256:${createHash("sha256")
      .update("rickgent.commit-ref-owner-proof.v1\0")
      .update(token, "utf8")
      .update("\0")
      .update(canonicalJson(input), "utf8")
      .digest("hex")}`;
  }

  advanceWorkspaceResource(request: AdvanceAttemptWorkspaceResourceRequest): AttemptOwnershipGrant {
    if (!isAuthorizedAttemptWorkspaceResourceReceipt(request.receipt)) {
      throw new TypeError("workspace resource state requires an authority-minted observation receipt");
    }
    const receipt = request.receipt;
    if (
      receipt.attemptId !== request.ownership.attemptId ||
      receipt.ownershipId !== request.ownership.ownership.ownershipId ||
      receipt.generation !== request.ownership.ownership.generation
    ) throw new TypeError("workspace receipt belongs to different ownership");
    const current = request.ownership.resources.find((resource) => resource.slot === receipt.slot);
    if (current === undefined || current.state !== receipt.expectedState || current.stateVersion !== receipt.expectedVersion) {
      throw new TypeError(`workspace receipt for ${receipt.slot} does not match the resource preimage`);
    }
    return this.#commitForGrant(request.ownership, {
      kind: "advance_resource",
      idempotencyKey: request.idempotencyKey,
      slot: receipt.slot,
      expectedResourceState: receipt.expectedState,
      expectedResourceVersion: receipt.expectedVersion,
      toResourceState: receipt.toState,
    });
  }

  beginCleanup(request: OwnershipMutationRequest): AttemptOwnershipGrant {
    return this.#commitForGrant(request.ownership, {
      kind: "begin_cleanup",
      idempotencyKey: request.idempotencyKey,
      expectedOwnershipState: "live",
      expectedOwnershipVersion: request.ownership.ownership.stateVersion,
    });
  }

  prepareStaleRecovery(request: PrepareStaleRecoveryRequest): PreparedOwnershipAcquisition {
    const ttlMs = request.ttlMs ?? DEFAULT_TTL_MS;
    const token = randomBytes(32).toString("base64url");
    return new PreparedOwnershipAcquisition(OWNERSHIP_COMMAND_AUTHORITY, command({
      kind: "stale_recovery",
      repositoryId: this.#store.location.repositoryId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      ownerTokenDigest: tokenDigest(token),
      ttlMs,
      expiredOwnershipId: request.expiredOwnershipId,
      deathEvidenceId: request.deathEvidenceId,
    }), token);
  }

  recoverStale(prepared: PreparedOwnershipAcquisition): AttemptOwnershipGrant {
    if (!PREPARED_ACQUISITIONS.has(prepared) || prepared.command.payload.kind !== "stale_recovery") {
      throw new TypeError("stale recovery was not prepared by LeaseAuthority");
    }
    const token = prepared.consumeToken(OWNERSHIP_COMMAND_AUTHORITY);
    return this.#grant(token, this.#store.commitAuthorizedAttemptOwnership(prepared.command));
  }

  #commitForGrant(
    grant: AttemptOwnershipGrant,
    operation: Omit<AttemptOwnershipCommandPayload, "repositoryId" | "attemptId" | "ownershipId" | "ownerTokenDigest" | "ttlMs">,
  ): AttemptOwnershipGrant {
    if (grant.repositoryId !== this.#store.location.repositoryId) {
      throw new TypeError("ownership grant belongs to another StateStore repository");
    }
    const token = requireGrantToken(grant);
    const result = this.#store.commitAuthorizedAttemptOwnership(command({
      ...operation,
      repositoryId: grant.repositoryId,
      attemptId: grant.attemptId,
      ownershipId: grant.ownership.ownershipId,
      ownerTokenDigest: tokenDigest(token),
      ttlMs: Math.max(MINIMUM_OWNERSHIP_TTL_MS, new Date(grant.ownership.expiresAt).getTime() - new Date(grant.ownership.heartbeatAt).getTime()),
    }));
    return this.#grant(token, result);
  }

  #grant(token: string, result: AttemptOwnershipStoreResult): AttemptOwnershipGrant {
    return new AttemptOwnershipGrant(
      OWNERSHIP_COMMAND_AUTHORITY,
      this.#store.location.repositoryId,
      this.#store.location.repoRealpath,
      this.#store.location.gitCommonDirRealpath,
      token,
      result,
    );
  }
}
