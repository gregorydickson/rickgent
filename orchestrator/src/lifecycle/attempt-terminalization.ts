/**
 * Production attempt terminalization authority (t22A fix).
 *
 * This is the production entry path for terminalizing an attempt's cleanup
 * disposition.  It routes every terminal outcome through the purpose-specific
 * finalization transactions ({@link finalizeFailure},
 * {@link finalizePromotion}, {@link finalizeQuarantine}) and rejects generic
 * cleanup records.  The generic {@link CleanupService} path remains only as an
 * internal compatibility seam for already-running v1 fixtures; it is NOT the
 * authority path for t22A terminalization.
 *
 * The future AttemptRunner (t22C) calls this authority as the sole
 * terminalization entry point.  A generic cleanup record
 * ({@link isAuthorizedCleanupReceipt}) cannot authorize any purpose-specific
 * terminalization: failure, promotion, and quarantine each require their exact
 * branded Store-minted receipt.
 */

import { isAuthorizedCleanupReceipt } from "./cleanup.js";
import {
  dispositionReceiptKind,
  finalizeFailure,
  finalizePromotion,
  finalizeQuarantine,
  receiptSatisfiesFinalization,
  type DispositionFinalizationKind,
  type FailureFinalizationInput,
  type PromotionFinalizationInput,
  type QuarantineFinalizationInput,
} from "./disposition-finalization.js";
import type { LeaseAuthority } from "../state/leases.js";
import type {
  MintedDispositionReceipt,
  StateStore,
} from "../state/store.js";
import type {
  FailureCleanupReceipt,
  PromotionCleanupReceipt,
  QuarantineReceipt,
} from "./disposition.js";

/**
 * Rejects a generic cleanup record as a terminalization authority input.  A
 * generic {@link CleanupService} receipt is structurally incompatible with the
 * purpose-specific finalization boundary: it carries no branded disposition
 * kind and cannot satisfy failure, promotion, or quarantine finalization.
 */
function rejectGenericCleanupReceipt(receipt: unknown): void {
  if (isAuthorizedCleanupReceipt(receipt)) {
    throw new TypeError(
      "attempt terminalization requires a purpose-specific branded Store-minted receipt; a generic CleanupService record is not the authority path",
    );
  }
}

/**
 * Production attempt terminalization authority.  The sole entry path for
 * terminalizing an attempt's cleanup disposition through purpose-specific
 * finalization transactions.
 */
export class AttemptTerminalizationAuthority {
  readonly #store: StateStore;
  readonly #leases: LeaseAuthority;

  constructor(store: StateStore, leases: LeaseAuthority) {
    this.#store = store;
    this.#leases = leases;
  }

  /**
   * Terminalizes a failure cleanup.  Routes through {@link finalizeFailure} so
   * the failure-cleanup receipt is the authority proof; a generic cleanup
   * record or a cross-disposition receipt is rejected.
   */
  terminalizeFailure(
    input: Omit<FailureFinalizationInput, "store" | "leases"> & { readonly receipt: FailureCleanupReceipt },
  ): MintedDispositionReceipt<FailureCleanupReceipt> {
    rejectGenericCleanupReceipt(input.receipt);
    if (!receiptSatisfiesFinalization(input.receipt, "failure")) {
      throw new TypeError("failure terminalization requires an exact branded failure-cleanup receipt");
    }
    return finalizeFailure({
      store: this.#store,
      leases: this.#leases,
      request: input.request,
      receipt: input.receipt,
    });
  }

  /**
   * Terminalizes a promotion cleanup.  Routes through {@link finalizePromotion}
   * so the promotion-cleanup receipt, the exact accepted oracle decision, and
   * the independently observed candidate/delivery state are the authority
   * proof; a generic cleanup record or a cross-disposition receipt is rejected.
   */
  terminalizePromotion(
    input: Omit<PromotionFinalizationInput, "store" | "leases"> & { readonly receipt: PromotionCleanupReceipt },
  ): MintedDispositionReceipt<PromotionCleanupReceipt> {
    rejectGenericCleanupReceipt(input.receipt);
    rejectGenericCleanupReceipt(input.cleanupEligibilityReceipt);
    if (!receiptSatisfiesFinalization(input.receipt, "promotion")) {
      throw new TypeError("promotion terminalization requires an exact branded promotion-cleanup receipt");
    }
    return finalizePromotion({
      store: this.#store,
      leases: this.#leases,
      request: input.request,
      receipt: input.receipt,
      oracleDecisionId: input.oracleDecisionId,
      observedCandidateOid: input.observedCandidateOid,
      observedDeliveryOid: input.observedDeliveryOid,
      cleanupEligibilityReceipt: input.cleanupEligibilityReceipt,
    });
  }

  /**
   * Terminalizes a quarantine.  Routes through {@link finalizeQuarantine} so
   * the quarantine receipt is the authority proof; a generic cleanup record or
   * a cross-disposition receipt is rejected.  Quarantine is not a failed
   * deletion and cannot release a foreign/stale owner.
   */
  terminalizeQuarantine(
    input: Omit<QuarantineFinalizationInput, "store" | "leases"> & { readonly receipt: QuarantineReceipt },
  ): MintedDispositionReceipt<QuarantineReceipt> {
    rejectGenericCleanupReceipt(input.receipt);
    if (!receiptSatisfiesFinalization(input.receipt, "quarantine")) {
      throw new TypeError("quarantine terminalization requires an exact branded quarantine receipt");
    }
    return finalizeQuarantine({
      store: this.#store,
      leases: this.#leases,
      request: input.request,
      receipt: input.receipt,
    });
  }
}

/**
 * Returns `true` iff the given receipt is accepted by the production
 * terminalization authority for the named kind.  A generic cleanup record is
 * never accepted.  Used by the production-path parity proof.
 */
export function receiptAcceptsTerminalization(
  receipt: unknown,
  kind: DispositionFinalizationKind,
): boolean {
  if (isAuthorizedCleanupReceipt(receipt)) return false;
  return receiptSatisfiesFinalization(receipt, kind);
}

/**
 * Returns the branded disposition kind of a terminalization authority input,
 * or `null` if the value is a generic cleanup record or not a recognized
 * branded receipt.  Used by the production-path parity proof.
 */
export function terminalizationReceiptKind(value: unknown): DispositionFinalizationKind | null {
  if (isAuthorizedCleanupReceipt(value)) return null;
  const kind = dispositionReceiptKind(value);
  if (kind === "failure" || kind === "promotion" || kind === "quarantine") return kind;
  return null;
}
