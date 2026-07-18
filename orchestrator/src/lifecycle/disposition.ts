/**
 * Runtime proof types for the t22 attempt-disposition boundary.
 *
 * This module deliberately does not observe the filesystem, process tree, Git,
 * or durable state.  An authority can mint a receipt only from a prerequisite
 * observation already branded by the service that owns that observation.  No
 * prerequisite observation producer is exposed here; integration services must
 * add the real observation edge instead of converting caller data into proof.
 */

export const TARGET_NEVER_RELEASED_SCHEMA_VERSION = "rickgent.target-never-released.v1" as const;
export const CLEANUP_ELIGIBILITY_SCHEMA_VERSION = "rickgent.cleanup-eligibility.v1" as const;
export const FAILURE_CLEANUP_SCHEMA_VERSION = "rickgent.failure-cleanup.v1" as const;
export const PROMOTION_CLEANUP_SCHEMA_VERSION = "rickgent.promotion-cleanup.v1" as const;
export const QUARANTINE_SCHEMA_VERSION = "rickgent.quarantine.v1" as const;

export type Sha256Digest = `sha256:${string}`;

export type AttemptResourceSlot =
  | "delivery_ref"
  | "attempt_ref"
  | "worktree"
  | "isolated_index"
  | "policy_context"
  | "policy_bundle"
  | "process_group"
  | "stdout"
  | "stderr"
  | "verification_output"
  | "salvage_archive";

export interface DispositionLineage {
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipContextDigest: Sha256Digest;
  readonly contextId: string;
}

export interface CleanupDispositionLineage extends DispositionLineage {
  readonly ownershipStateVersion: number;
}

export interface ResourceClaimPreimage {
  readonly resourceClaimId: string;
  readonly slot: AttemptResourceSlot;
  readonly expectedState: "cleanup_pending";
  readonly expectedVersion: number;
}

export interface TargetProofReference {
  readonly phaseExecutionId: string;
  readonly contextId: string;
  readonly targetStartGateId: string;
  readonly gateEvidenceId: string;
  readonly gateEvidenceDigest: Sha256Digest;
  readonly launchId: string | null;
  readonly processReceiptId: string | null;
  readonly groupDeathEvidenceId: string | null;
  readonly groupDeathEvidenceDigest: Sha256Digest | null;
  readonly proofKind: "never_released" | "terminal_process";
  readonly memberDigest: Sha256Digest;
}

export interface QuarantineInventoryEntry {
  readonly resourceClaimId: string;
  readonly slot: AttemptResourceSlot;
  readonly logicalDisposition: "quarantined";
  readonly physicalDisposition: "absent" | "retained" | "unknown" | "not_applicable";
  readonly canonicalIdentity: string;
  readonly observedPath: string | null;
  readonly observedKind: "file" | "directory" | "git_ref" | "process_boundary" | null;
  readonly contentDigest: Sha256Digest | null;
}

export interface TargetNeverReleasedObservation extends DispositionLineage {
  readonly kind: "target_never_released_observation";
  readonly receiptId: string;
  readonly phaseExecutionId: string;
  readonly launchId: string | null;
  readonly gateId: string;
  readonly gateVersion: number;
  readonly containmentId: string | null;
  readonly containmentDisposition: "not_created" | "authoritatively_empty";
  readonly containmentEvidenceDigest: Sha256Digest | null;
  readonly reason:
    | "containment_unavailable"
    | "policy_unavailable"
    | "executable_unavailable"
    | "output_unavailable"
    | "spawn_failed";
  readonly observedAt: string;
}

export interface CleanupEligibilityObservation extends CleanupDispositionLineage {
  readonly kind: "cleanup_eligibility_observation";
  readonly receiptId: string;
  readonly commitIntentId: string;
  readonly commitAttributionId: string;
  readonly candidateOid: string;
  readonly attemptRefObservedOid: string;
  readonly deliveryRef: string;
  readonly deliveryBaselineOid: string;
  readonly deliveryObservedOid: string;
  readonly attemptRef: string;
  readonly claims: readonly ResourceClaimPreimage[];
  readonly targetProofs: readonly TargetProofReference[];
  readonly observedAt: string;
}

export interface FailureCleanupObservation extends CleanupDispositionLineage {
  readonly kind: "failure_cleanup_observation";
  readonly receiptId: string;
  readonly cleanupIntentId: string;
  readonly failureCode: string;
  readonly deliveryRef: string;
  readonly deliveryBaselineOid: string;
  readonly deliveryObservedOid: string;
  readonly attemptRef: string;
  readonly expectedAttemptRefOid: string;
  readonly salvageRecordId: string;
  readonly targetProofs: readonly TargetProofReference[];
  readonly claims: readonly ResourceClaimPreimage[];
  readonly absentResourceSlots: readonly AttemptResourceSlot[];
  readonly callerBeforeDigest: Sha256Digest;
  readonly callerAfterDigest: Sha256Digest;
  readonly observedAt: string;
}

export interface PromotionCleanupObservation extends CleanupDispositionLineage {
  readonly kind: "promotion_cleanup_observation";
  readonly receiptId: string;
  readonly cleanupIntentId: string;
  readonly cleanupEligibilityReceiptId: string;
  readonly oracleDecisionId: string;
  readonly promotionIntentId: string;
  readonly promotionObservationEvidenceId: string;
  readonly commitAttributionId: string;
  readonly deliveryRef: string;
  readonly expectedOldOid: string;
  readonly candidateOid: string;
  readonly deliveryObservedOid: string;
  readonly claims: readonly ResourceClaimPreimage[];
  readonly absentResourceSlots: readonly AttemptResourceSlot[];
  readonly callerBeforeDigest: Sha256Digest;
  readonly callerAfterDigest: Sha256Digest;
  readonly observedAt: string;
}

export interface QuarantineObservation extends CleanupDispositionLineage {
  readonly kind: "quarantine_observation";
  readonly receiptId: string;
  readonly quarantineIntentId: string;
  readonly reasonCode: string;
  readonly deliveryRef: string;
  readonly deliveryObservedOid: string;
  readonly targetProofs: readonly TargetProofReference[];
  readonly claims: readonly ResourceClaimPreimage[];
  readonly inventory: readonly QuarantineInventoryEntry[];
  readonly callerBeforeDigest: Sha256Digest;
  readonly callerAfterDigest: Sha256Digest;
  readonly observedAt: string;
}

const TARGET_NEVER_RELEASED_RECEIPT_AUTHORITY = Symbol("rickgent.target-never-released-receipt");
const CLEANUP_ELIGIBILITY_RECEIPT_AUTHORITY = Symbol("rickgent.cleanup-eligibility-receipt");
const FAILURE_CLEANUP_RECEIPT_AUTHORITY = Symbol("rickgent.failure-cleanup-receipt");
const PROMOTION_CLEANUP_RECEIPT_AUTHORITY = Symbol("rickgent.promotion-cleanup-receipt");
const QUARANTINE_RECEIPT_AUTHORITY = Symbol("rickgent.quarantine-receipt");

const AUTHORIZED_TARGET_NEVER_RELEASED_RECEIPTS = new WeakSet<object>();
const AUTHORIZED_CLEANUP_ELIGIBILITY_RECEIPTS = new WeakSet<object>();
const AUTHORIZED_FAILURE_CLEANUP_RECEIPTS = new WeakSet<object>();
const AUTHORIZED_PROMOTION_CLEANUP_RECEIPTS = new WeakSet<object>();
const AUTHORIZED_QUARANTINE_RECEIPTS = new WeakSet<object>();

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RESOURCE_SLOTS = new Set<AttemptResourceSlot>([
  "delivery_ref", "attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle",
  "process_group", "stdout", "stderr", "verification_output", "salvage_archive",
]);

function canonicalText(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim() || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new TypeError(`${label} must be a nonempty canonical string`);
  }
  return value;
}

function digest(value: string, label: string): Sha256Digest {
  if (!DIGEST.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return value as Sha256Digest;
}

function gitOid(value: string, label: string): string {
  if (!GIT_OID.test(value)) throw new TypeError(`${label} must be a Git object id`);
  return value;
}

function timestamp(value: string, label: string): string {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function lineage<T extends DispositionLineage>(value: T): T {
  canonicalText(value.attemptId, "attemptId");
  canonicalText(value.ownershipId, "ownershipId");
  if (!Number.isSafeInteger(value.ownerGeneration) || value.ownerGeneration < 1) {
    throw new TypeError("ownerGeneration must be a positive safe integer");
  }
  digest(value.ownershipContextDigest, "ownershipContextDigest");
  canonicalText(value.contextId, "contextId");
  return value;
}

function freezeClaims(value: readonly ResourceClaimPreimage[]): readonly ResourceClaimPreimage[] {
  if (!Array.isArray(value) || value.length !== RESOURCE_SLOTS.size) {
    throw new TypeError("claims must contain the exact 11 resource slots");
  }
  const claims = value.map((claim) => {
    canonicalText(claim.resourceClaimId, "resourceClaimId");
    if (!RESOURCE_SLOTS.has(claim.slot) || claim.expectedState !== "cleanup_pending" ||
      !Number.isSafeInteger(claim.expectedVersion) || claim.expectedVersion < 0) {
      throw new TypeError("resource claim preimage is invalid");
    }
    return Object.freeze({ ...claim });
  });
  if (new Set(claims.map((claim) => claim.resourceClaimId)).size !== claims.length ||
    new Set(claims.map((claim) => claim.slot)).size !== claims.length) {
    throw new TypeError("resource claim preimages must have unique ids and slots");
  }
  return Object.freeze(claims);
}

function freezeTargetProofs(value: readonly TargetProofReference[]): readonly TargetProofReference[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("targetProofs must be a nonempty array");
  const proofs = value.map((proof) => {
    canonicalText(proof.phaseExecutionId, "phaseExecutionId");
    canonicalText(proof.contextId, "target proof contextId");
    canonicalText(proof.targetStartGateId, "targetStartGateId");
    canonicalText(proof.gateEvidenceId, "gateEvidenceId");
    digest(proof.gateEvidenceDigest, "gateEvidenceDigest");
    digest(proof.memberDigest, "target proof memberDigest");
    if (proof.proofKind !== "never_released" && proof.proofKind !== "terminal_process") {
      throw new TypeError("target proof kind is invalid");
    }
    if (proof.launchId === null) {
      if (proof.proofKind !== "never_released" || proof.processReceiptId !== null ||
        proof.groupDeathEvidenceId !== null || proof.groupDeathEvidenceDigest !== null) {
        throw new TypeError("only target-never-released proof may omit launchId");
      }
    } else {
      canonicalText(proof.launchId, "launchId");
      if (proof.processReceiptId === null || proof.groupDeathEvidenceId === null || proof.groupDeathEvidenceDigest === null) {
        throw new TypeError("launched target proof requires terminal receipt and group-death evidence");
      }
      canonicalText(proof.processReceiptId, "processReceiptId");
      canonicalText(proof.groupDeathEvidenceId, "groupDeathEvidenceId");
      digest(proof.groupDeathEvidenceDigest, "groupDeathEvidenceDigest");
    }
    return Object.freeze({ ...proof });
  });
  if (new Set(proofs.map((proof) => proof.phaseExecutionId)).size !== proofs.length) {
    throw new TypeError("target proofs must have unique phase identities");
  }
  return Object.freeze(proofs);
}

function freezeAbsentSlots(value: readonly AttemptResourceSlot[], claims: readonly ResourceClaimPreimage[]): readonly AttemptResourceSlot[] {
  if (!Array.isArray(value) || value.length !== claims.length || new Set(value).size !== value.length ||
    value.some((slot) => !RESOURCE_SLOTS.has(slot)) ||
    claims.some((claim) => !value.includes(claim.slot))) {
    throw new TypeError("absentResourceSlots must cover the exact claim slots");
  }
  return Object.freeze([...value]);
}

function freezeInventory(value: readonly QuarantineInventoryEntry[], claims: readonly ResourceClaimPreimage[]): readonly QuarantineInventoryEntry[] {
  if (!Array.isArray(value) || value.length !== claims.length) throw new TypeError("quarantine inventory must cover every claim");
  const inventory = value.map((entry) => {
    canonicalText(entry.resourceClaimId, "quarantine resourceClaimId");
    if (!RESOURCE_SLOTS.has(entry.slot) || entry.logicalDisposition !== "quarantined" ||
      !["absent", "retained", "unknown", "not_applicable"].includes(entry.physicalDisposition) ||
      (entry.slot === "delivery_ref") !== (entry.physicalDisposition === "not_applicable")) {
      throw new TypeError("quarantine inventory disposition is invalid");
    }
    canonicalText(entry.canonicalIdentity, "quarantine canonicalIdentity");
    if ((entry.observedPath === null) !== (entry.observedKind === null)) {
      throw new TypeError("quarantine observed path and kind must be jointly present or absent");
    }
    if (entry.observedPath !== null) canonicalText(entry.observedPath, "quarantine observedPath");
    if (entry.observedKind !== null && !["file", "directory", "git_ref", "process_boundary"].includes(entry.observedKind)) {
      throw new TypeError("quarantine observed kind is invalid");
    }
    if (entry.contentDigest !== null) digest(entry.contentDigest, "quarantine contentDigest");
    return Object.freeze({ ...entry });
  });
  const claimsById = new Map(claims.map((claim) => [claim.resourceClaimId, claim]));
  if (new Set(inventory.map((entry) => entry.resourceClaimId)).size !== inventory.length ||
    inventory.some((entry) => claimsById.get(entry.resourceClaimId)?.slot !== entry.slot)) {
    throw new TypeError("quarantine inventory differs from the exact claim set");
  }
  return Object.freeze(inventory);
}

function baseSnapshot<T extends DispositionLineage & { readonly receiptId: string; readonly observedAt: string }>(value: T): T {
  lineage(value);
  canonicalText(value.receiptId, "receiptId");
  timestamp(value.observedAt, "observedAt");
  return value;
}

function cleanupSnapshot<T extends CleanupDispositionLineage & { readonly receiptId: string; readonly observedAt: string }>(value: T): T {
  baseSnapshot(value);
  if (!Number.isSafeInteger(value.ownershipStateVersion) || value.ownershipStateVersion < 0) {
    throw new TypeError("ownershipStateVersion must be a nonnegative safe integer");
  }
  return value;
}

function validateTargetNeverReleasedInput(input: TargetNeverReleasedObservation): void {
  baseSnapshot(input);
  canonicalText(input.phaseExecutionId, "phaseExecutionId");
  if (input.launchId !== null) canonicalText(input.launchId, "launchId");
  canonicalText(input.gateId, "gateId");
  if (input.gateVersion !== 1) {
    throw new TypeError("gateVersion must be 1 for a closed-never-released gate");
  }
  if (input.containmentId !== null) canonicalText(input.containmentId, "containmentId");
  if (!["not_created", "authoritatively_empty"].includes(input.containmentDisposition)) {
    throw new TypeError("target-never-released containment disposition is invalid");
  }
  if ((input.containmentDisposition === "not_created") !== (input.containmentEvidenceDigest === null)) {
    throw new TypeError("containment evidence must exist exactly when containment was authoritatively emptied");
  }
  if ((input.containmentDisposition === "not_created") !== (input.containmentId === null)) {
    throw new TypeError("containment identity must exist exactly when containment was authoritatively emptied");
  }
  if (input.containmentEvidenceDigest !== null) digest(input.containmentEvidenceDigest, "containmentEvidenceDigest");
  if (!["containment_unavailable", "policy_unavailable", "executable_unavailable", "output_unavailable", "spawn_failed"].includes(input.reason)) {
    throw new TypeError("target-never-released reason is invalid");
  }
  if ((input.launchId === null) !== (input.containmentDisposition === "not_created")) {
    throw new TypeError("launch identity must exist exactly when containment was authoritatively emptied");
  }
  if (input.launchId !== null && input.containmentId !== input.launchId) {
    throw new TypeError("containment identity must equal the launched bootstrap identity");
  }
}

function validateCleanupEligibilityInput(input: CleanupEligibilityObservation): {
  readonly claims: readonly ResourceClaimPreimage[];
  readonly targetProofs: readonly TargetProofReference[];
} {
  cleanupSnapshot(input);
  for (const [label, value] of [["commitIntentId", input.commitIntentId], ["commitAttributionId", input.commitAttributionId], ["deliveryRef", input.deliveryRef], ["attemptRef", input.attemptRef]] as const) canonicalText(value, label);
  for (const [label, value] of [["candidateOid", input.candidateOid], ["attemptRefObservedOid", input.attemptRefObservedOid], ["deliveryBaselineOid", input.deliveryBaselineOid], ["deliveryObservedOid", input.deliveryObservedOid]] as const) gitOid(value, label);
  if (input.candidateOid !== input.attemptRefObservedOid) {
    throw new TypeError("cleanup eligibility must observe the exact candidate on the attempt ref");
  }
  if (input.deliveryBaselineOid !== input.deliveryObservedOid) {
    throw new TypeError("cleanup eligibility must observe the delivery baseline unchanged");
  }
  return { claims: freezeClaims(input.claims), targetProofs: freezeTargetProofs(input.targetProofs) };
}

function validateQuarantineInput(input: QuarantineObservation): {
  readonly claims: readonly ResourceClaimPreimage[];
  readonly targetProofs: readonly TargetProofReference[];
  readonly inventory: readonly QuarantineInventoryEntry[];
} {
  cleanupSnapshot(input);
  for (const [label, value] of [["quarantineIntentId", input.quarantineIntentId], ["reasonCode", input.reasonCode], ["deliveryRef", input.deliveryRef]] as const) canonicalText(value, label);
  gitOid(input.deliveryObservedOid, "deliveryObservedOid");
  digest(input.callerBeforeDigest, "callerBeforeDigest");
  digest(input.callerAfterDigest, "callerAfterDigest");
  if (input.callerBeforeDigest !== input.callerAfterDigest) throw new TypeError("quarantine changed the caller checkout");
  const claims = freezeClaims(input.claims);
  return {
    claims,
    targetProofs: freezeTargetProofs(input.targetProofs),
    inventory: freezeInventory(input.inventory, claims),
  };
}

/** Pure validation only; these functions do not brand or mint receipts. */
export function assertTargetNeverReleasedObservation(input: TargetNeverReleasedObservation): void {
  validateTargetNeverReleasedInput(input);
}

export function assertCleanupEligibilityObservation(input: CleanupEligibilityObservation): void {
  validateCleanupEligibilityInput(input);
}

export function assertQuarantineObservation(input: QuarantineObservation): void {
  validateQuarantineInput(input);
}

export class TargetNeverReleasedReceipt implements TargetNeverReleasedObservation {
  readonly kind = "target_never_released_observation" as const;
  readonly schemaVersion = TARGET_NEVER_RELEASED_SCHEMA_VERSION;
  readonly receiptId!: string;
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipContextDigest!: Sha256Digest;
  readonly contextId!: string;
  readonly phaseExecutionId!: string;
  readonly launchId!: string | null;
  readonly gateId!: string;
  readonly gateVersion!: number;
  readonly containmentId!: string | null;
  readonly containmentDisposition!: TargetNeverReleasedObservation["containmentDisposition"];
  readonly containmentEvidenceDigest!: Sha256Digest | null;
  readonly reason!: TargetNeverReleasedObservation["reason"];
  readonly observedAt!: string;

  constructor(authority: symbol, input: TargetNeverReleasedObservation) {
    if (authority !== TARGET_NEVER_RELEASED_RECEIPT_AUTHORITY) throw new TypeError("target-never-released receipts require TargetStartGateAuthority");
    validateTargetNeverReleasedInput(input);
    Object.assign(this, input);
    AUTHORIZED_TARGET_NEVER_RELEASED_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export class CleanupEligibilityReceipt implements CleanupEligibilityObservation {
  readonly kind = "cleanup_eligibility_observation" as const;
  readonly schemaVersion = CLEANUP_ELIGIBILITY_SCHEMA_VERSION;
  readonly receiptId!: string;
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipStateVersion!: number;
  readonly ownershipContextDigest!: Sha256Digest;
  readonly contextId!: string;
  readonly commitIntentId!: string;
  readonly commitAttributionId!: string;
  readonly candidateOid!: string;
  readonly attemptRefObservedOid!: string;
  readonly deliveryRef!: string;
  readonly deliveryBaselineOid!: string;
  readonly deliveryObservedOid!: string;
  readonly attemptRef!: string;
  readonly claims!: readonly ResourceClaimPreimage[];
  readonly targetProofs!: readonly TargetProofReference[];
  readonly observedAt!: string;

  constructor(authority: symbol, input: CleanupEligibilityObservation) {
    if (authority !== CLEANUP_ELIGIBILITY_RECEIPT_AUTHORITY) throw new TypeError("cleanup-eligibility receipts require CleanupEligibilityAuthority");
    const validated = validateCleanupEligibilityInput(input);
    Object.assign(this, input, validated);
    AUTHORIZED_CLEANUP_ELIGIBILITY_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export class FailureCleanupReceipt implements FailureCleanupObservation {
  readonly kind = "failure_cleanup_observation" as const;
  readonly schemaVersion = FAILURE_CLEANUP_SCHEMA_VERSION;
  readonly receiptId!: string;
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipStateVersion!: number;
  readonly ownershipContextDigest!: Sha256Digest;
  readonly contextId!: string;
  readonly cleanupIntentId!: string;
  readonly failureCode!: string;
  readonly deliveryRef!: string;
  readonly deliveryBaselineOid!: string;
  readonly deliveryObservedOid!: string;
  readonly attemptRef!: string;
  readonly expectedAttemptRefOid!: string;
  readonly salvageRecordId!: string;
  readonly targetProofs!: readonly TargetProofReference[];
  readonly claims!: readonly ResourceClaimPreimage[];
  readonly absentResourceSlots!: readonly AttemptResourceSlot[];
  readonly callerBeforeDigest!: Sha256Digest;
  readonly callerAfterDigest!: Sha256Digest;
  readonly observedAt!: string;

  constructor(authority: symbol, input: FailureCleanupObservation) {
    if (authority !== FAILURE_CLEANUP_RECEIPT_AUTHORITY) throw new TypeError("failure-cleanup receipts require FailureCleanupAuthority");
    cleanupSnapshot(input);
    for (const [label, value] of [["cleanupIntentId", input.cleanupIntentId], ["failureCode", input.failureCode], ["deliveryRef", input.deliveryRef], ["attemptRef", input.attemptRef], ["salvageRecordId", input.salvageRecordId]] as const) canonicalText(value, label);
    for (const [label, value] of [["deliveryBaselineOid", input.deliveryBaselineOid], ["deliveryObservedOid", input.deliveryObservedOid], ["expectedAttemptRefOid", input.expectedAttemptRefOid]] as const) gitOid(value, label);
    if (input.deliveryObservedOid !== input.deliveryBaselineOid) throw new TypeError("failure cleanup must preserve the delivery baseline");
    digest(input.callerBeforeDigest, "callerBeforeDigest");
    digest(input.callerAfterDigest, "callerAfterDigest");
    if (input.callerBeforeDigest !== input.callerAfterDigest) throw new TypeError("failure cleanup changed the caller checkout");
    const claims = freezeClaims(input.claims);
    Object.assign(this, input, { claims, targetProofs: freezeTargetProofs(input.targetProofs), absentResourceSlots: freezeAbsentSlots(input.absentResourceSlots, claims) });
    AUTHORIZED_FAILURE_CLEANUP_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export class PromotionCleanupReceipt implements PromotionCleanupObservation {
  readonly kind = "promotion_cleanup_observation" as const;
  readonly schemaVersion = PROMOTION_CLEANUP_SCHEMA_VERSION;
  readonly receiptId!: string;
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipStateVersion!: number;
  readonly ownershipContextDigest!: Sha256Digest;
  readonly contextId!: string;
  readonly cleanupIntentId!: string;
  readonly cleanupEligibilityReceiptId!: string;
  readonly oracleDecisionId!: string;
  readonly promotionIntentId!: string;
  readonly promotionObservationEvidenceId!: string;
  readonly commitAttributionId!: string;
  readonly deliveryRef!: string;
  readonly expectedOldOid!: string;
  readonly candidateOid!: string;
  readonly deliveryObservedOid!: string;
  readonly claims!: readonly ResourceClaimPreimage[];
  readonly absentResourceSlots!: readonly AttemptResourceSlot[];
  readonly callerBeforeDigest!: Sha256Digest;
  readonly callerAfterDigest!: Sha256Digest;
  readonly observedAt!: string;

  constructor(authority: symbol, input: PromotionCleanupObservation) {
    if (authority !== PROMOTION_CLEANUP_RECEIPT_AUTHORITY) throw new TypeError("promotion-cleanup receipts require PromotionCleanupAuthority");
    cleanupSnapshot(input);
    for (const [label, value] of [["cleanupIntentId", input.cleanupIntentId], ["cleanupEligibilityReceiptId", input.cleanupEligibilityReceiptId], ["oracleDecisionId", input.oracleDecisionId], ["promotionIntentId", input.promotionIntentId], ["promotionObservationEvidenceId", input.promotionObservationEvidenceId], ["commitAttributionId", input.commitAttributionId], ["deliveryRef", input.deliveryRef]] as const) canonicalText(value, label);
    for (const [label, value] of [["expectedOldOid", input.expectedOldOid], ["candidateOid", input.candidateOid], ["deliveryObservedOid", input.deliveryObservedOid]] as const) gitOid(value, label);
    if (input.deliveryObservedOid !== input.candidateOid) throw new TypeError("promotion cleanup must observe the exact candidate");
    digest(input.callerBeforeDigest, "callerBeforeDigest");
    digest(input.callerAfterDigest, "callerAfterDigest");
    if (input.callerBeforeDigest !== input.callerAfterDigest) throw new TypeError("promotion cleanup changed the caller checkout");
    const claims = freezeClaims(input.claims);
    Object.assign(this, input, { claims, absentResourceSlots: freezeAbsentSlots(input.absentResourceSlots, claims) });
    AUTHORIZED_PROMOTION_CLEANUP_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export class QuarantineReceipt implements QuarantineObservation {
  readonly kind = "quarantine_observation" as const;
  readonly schemaVersion = QUARANTINE_SCHEMA_VERSION;
  readonly receiptId!: string;
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipStateVersion!: number;
  readonly ownershipContextDigest!: Sha256Digest;
  readonly contextId!: string;
  readonly quarantineIntentId!: string;
  readonly reasonCode!: string;
  readonly deliveryRef!: string;
  readonly deliveryObservedOid!: string;
  readonly targetProofs!: readonly TargetProofReference[];
  readonly claims!: readonly ResourceClaimPreimage[];
  readonly inventory!: readonly QuarantineInventoryEntry[];
  readonly callerBeforeDigest!: Sha256Digest;
  readonly callerAfterDigest!: Sha256Digest;
  readonly observedAt!: string;

  constructor(authority: symbol, input: QuarantineObservation) {
    if (authority !== QUARANTINE_RECEIPT_AUTHORITY) throw new TypeError("quarantine receipts require QuarantineAuthority");
    const validated = validateQuarantineInput(input);
    Object.assign(this, input, validated);
    AUTHORIZED_QUARANTINE_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export function isTargetNeverReleasedReceipt(value: unknown): value is TargetNeverReleasedReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_TARGET_NEVER_RELEASED_RECEIPTS.has(value);
}

export function isCleanupEligibilityReceipt(value: unknown): value is CleanupEligibilityReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_CLEANUP_ELIGIBILITY_RECEIPTS.has(value);
}

export function isFailureCleanupReceipt(value: unknown): value is FailureCleanupReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_FAILURE_CLEANUP_RECEIPTS.has(value);
}

export function isPromotionCleanupReceipt(value: unknown): value is PromotionCleanupReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_PROMOTION_CLEANUP_RECEIPTS.has(value);
}

export function isQuarantineReceipt(value: unknown): value is QuarantineReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_QUARANTINE_RECEIPTS.has(value);
}

/*
 * Deliberately no public minting helper exists yet. The real observer services
 * must be implemented in this module, or enter through a non-exported
 * capability seam, once they can independently establish each physical fact.
 * Turning raw caller input into a branded "observation" would only relocate the
 * forgery boundary.
 */
