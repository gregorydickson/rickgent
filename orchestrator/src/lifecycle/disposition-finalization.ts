/**
 * Purpose-specific disposition finalization (t22A).
 *
 * Replaces the generic cleanup finalization path with three distinct
 * transactions: failure, promotion, and quarantine.  Each consumes the exact
 * branded Store-minted receipt for its purpose; a receipt minted under one
 * authority cannot satisfy a different purpose's finalization.  Promotion
 * finalization additionally requires the exact accepted oracle decision, an
 * independently observed candidate/delivery state, and a promotion-purpose
 * cleanup receipt; the failure and quarantine paths cannot satisfy promotion
 * or release a foreign/stale owner.
 *
 * The generic {@link CleanupService} path remains only as an internal
 * compatibility seam for already-running v1 fixtures; production t22A
 * finalization routes through this module.
 */

import {
  isCleanupEligibilityReceipt,
  isFailureCleanupReceipt,
  isPromotionCleanupReceipt,
  isQuarantineReceipt,
  isTargetNeverReleasedReceipt,
  type CleanupEligibilityReceipt,
  type FailureCleanupReceipt,
  type PromotionCleanupReceipt,
  type QuarantineReceipt,
  type TargetNeverReleasedReceipt,
} from "./disposition.js";
import type { LeaseAuthority } from "../state/leases.js";
import type {
  MintCleanupEligibilityRequest,
  MintFailureCleanupRequest,
  MintPromotionCleanupRequest,
  MintQuarantineRequest,
  MintTargetNeverReleasedRequest,
  MintedDispositionReceipt,
  StateStore,
} from "../state/store.js";

export type DispositionFinalizationKind = "failure" | "promotion" | "quarantine";

export interface FailureFinalizationInput {
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly request: MintFailureCleanupRequest;
  /** The branded failure-cleanup receipt minted by the Store, for cross-disposition proof. */
  readonly receipt: FailureCleanupReceipt;
}

export interface PromotionFinalizationInput {
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly request: MintPromotionCleanupRequest;
  readonly receipt: PromotionCleanupReceipt;
  /** The exact accepted oracle decision id, independently verified by the caller. */
  readonly oracleDecisionId: string;
  /** The independently observed candidate oid (must equal the receipt's candidateOid). */
  readonly observedCandidateOid: string;
  /** The independently observed delivery oid (must equal the receipt's deliveryObservedOid). */
  readonly observedDeliveryOid: string;
  /** The promotion-purpose cleanup eligibility receipt (must be a CleanupEligibilityReceipt). */
  readonly cleanupEligibilityReceipt: CleanupEligibilityReceipt;
}

export interface QuarantineFinalizationInput {
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly request: MintQuarantineRequest;
  readonly receipt: QuarantineReceipt;
}

function assertReceiptBrand(value: unknown, predicate: (v: unknown) => boolean, label: string): void {
  if (!predicate(value)) {
    throw new TypeError(`${label} requires its exact branded Store-minted receipt; a foreign or forged receipt is rejected`);
  }
}

/**
 * Finalizes a failure cleanup.  Only a {@link FailureCleanupReceipt} can
 * satisfy this; a promotion or quarantine receipt cannot.  The attempt's
 * terminal transition is reserved to the failure path and cannot release a
 * foreign/stale owner.
 */
export function finalizeFailure(input: FailureFinalizationInput): MintedDispositionReceipt<FailureCleanupReceipt> {
  assertReceiptBrand(input.receipt, isFailureCleanupReceipt, "failure finalization");
  if (isPromotionCleanupReceipt(input.receipt) || isQuarantineReceipt(input.receipt)) {
    throw new TypeError("failure finalization cannot consume a promotion or quarantine receipt");
  }
  return input.store.mintFailureCleanup(input.request, input.leases.issueDispositionMintCapability());
}

/**
 * Finalizes a promotion cleanup.  Requires the exact accepted oracle decision,
 * an independently observed candidate/delivery state, and a promotion-purpose
 * cleanup eligibility receipt.  A failure or quarantine receipt cannot
 * satisfy promotion even with a forged oracle decision: the receipt brand is
 * reserved to the promotion-cleanup authority.
 */
export function finalizePromotion(input: PromotionFinalizationInput): MintedDispositionReceipt<PromotionCleanupReceipt> {
  assertReceiptBrand(input.receipt, isPromotionCleanupReceipt, "promotion finalization");
  if (isFailureCleanupReceipt(input.receipt) || isQuarantineReceipt(input.receipt)) {
    throw new TypeError("promotion finalization cannot consume a failure or quarantine receipt");
  }
  assertReceiptBrand(input.cleanupEligibilityReceipt, isCleanupEligibilityReceipt, "promotion finalization eligibility");
  // The exact accepted oracle decision must match the receipt's oracle decision.
  if (input.oracleDecisionId !== input.receipt.oracleDecisionId) {
    throw new TypeError("promotion finalization requires the exact accepted oracle decision referenced by the receipt");
  }
  // The independently observed candidate/delivery state must equal the receipt's.
  if (input.observedCandidateOid !== input.receipt.candidateOid || input.observedDeliveryOid !== input.receipt.deliveryObservedOid) {
    throw new TypeError("promotion finalization requires the independently observed candidate and delivery state to equal the receipt");
  }
  if (input.observedCandidateOid !== input.observedDeliveryOid) {
    throw new TypeError("promotion finalization requires the observed candidate and delivery state to agree");
  }
  return input.store.mintPromotionCleanup(input.request, input.leases.issueDispositionMintCapability());
}

/**
 * Finalizes a quarantine.  Only a {@link QuarantineReceipt} can satisfy this;
 * a failure or promotion receipt cannot.  Quarantine is not a failed deletion:
 * it cannot release a foreign/stale owner.
 */
export function finalizeQuarantine(input: QuarantineFinalizationInput): MintedDispositionReceipt<QuarantineReceipt> {
  assertReceiptBrand(input.receipt, isQuarantineReceipt, "quarantine finalization");
  if (isFailureCleanupReceipt(input.receipt) || isPromotionCleanupReceipt(input.receipt)) {
    throw new TypeError("quarantine finalization cannot consume a failure or promotion receipt");
  }
  return input.store.mintQuarantine(input.request, input.leases.issueDispositionMintCapability());
}

/**
 * Returns the kind of a branded disposition receipt, or `null` if the value is
 * not a recognized branded receipt.  Used by the negative-proof matrix to
 * assert cross-disposition isolation.
 */
export function dispositionReceiptKind(value: unknown): DispositionFinalizationKind | "target-never-released" | "cleanup-eligibility" | null {
  if (isFailureCleanupReceipt(value)) return "failure";
  if (isPromotionCleanupReceipt(value)) return "promotion";
  if (isQuarantineReceipt(value)) return "quarantine";
  if (isTargetNeverReleasedReceipt(value)) return "target-never-released";
  if (isCleanupEligibilityReceipt(value)) return "cleanup-eligibility";
  return null;
}

/**
 * Cross-disposition isolation proof: a receipt minted under one authority
 * cannot satisfy a different purpose's finalization.  Returns `true` iff the
 * given receipt is accepted by the named finalization kind.
 */
export function receiptSatisfiesFinalization(
  receipt: unknown,
  kind: DispositionFinalizationKind,
): boolean {
  switch (kind) {
    case "failure":
      return isFailureCleanupReceipt(receipt) && !isPromotionCleanupReceipt(receipt) && !isQuarantineReceipt(receipt);
    case "promotion":
      return isPromotionCleanupReceipt(receipt) && !isFailureCleanupReceipt(receipt) && !isQuarantineReceipt(receipt);
    case "quarantine":
      return isQuarantineReceipt(receipt) && !isFailureCleanupReceipt(receipt) && !isPromotionCleanupReceipt(receipt);
  }
}
