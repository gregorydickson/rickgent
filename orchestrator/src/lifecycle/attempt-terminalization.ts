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

/**
 * Production attempt terminalization service (t22A fix round 2).
 *
 * The single production entrypoint for terminalizing an attempt's cleanup
 * disposition.  The production build/dispatch path calls this service (not the
 * authority class directly) so the purpose-specific
 * {@link AttemptTerminalizationAuthority.terminalizeFailure}/
 * {@link AttemptTerminalizationAuthority.terminalizePromotion}/
 * {@link AttemptTerminalizationAuthority.terminalizeQuarantine} routes are the
 * authority route on the real production path.  A generic cleanup record
 * cannot authorize any terminalization: it is rejected at the entry point by
 * the underlying authority.
 *
 * This is the production route the future AttemptRunner (t22C) and the current
 * build path's outcome-handling call.  The generic {@link CleanupService} path
 * remains only as a physical workspace-removal seam; it is NOT the authority
 * route for disposition terminalization.
 */
export interface AttemptTerminalizationFailureInput
  extends Omit<FailureFinalizationInput, "store" | "leases"> {
  readonly receipt: FailureCleanupReceipt;
}
export interface AttemptTerminalizationPromotionInput
  extends Omit<PromotionFinalizationInput, "store" | "leases"> {
  readonly receipt: PromotionCleanupReceipt;
}
export interface AttemptTerminalizationQuarantineInput
  extends Omit<QuarantineFinalizationInput, "store" | "leases"> {
  readonly receipt: QuarantineReceipt;
}

/**
 * Discriminated production terminalization input.  Exactly one of
 * {@link AttemptTerminalizationInput.failure}/
 * {@link AttemptTerminalizationInput.promotion}/
 * {@link AttemptTerminalizationInput.quarantine} must be present, matching
 * {@link AttemptTerminalizationInput.kind}.
 */
export interface AttemptTerminalizationInput {
  readonly kind: DispositionFinalizationKind;
  readonly failure?: AttemptTerminalizationFailureInput;
  readonly promotion?: AttemptTerminalizationPromotionInput;
  readonly quarantine?: AttemptTerminalizationQuarantineInput;
}

/** The minted disposition receipt union returned by the production route. */
export type AttemptTerminalizationResult =
  | MintedDispositionReceipt<FailureCleanupReceipt>
  | MintedDispositionReceipt<PromotionCleanupReceipt>
  | MintedDispositionReceipt<QuarantineReceipt>;

export class AttemptTerminalizationService {
  readonly #authority: AttemptTerminalizationAuthority;

  constructor(store: StateStore, leases: LeaseAuthority) {
    this.#authority = new AttemptTerminalizationAuthority(store, leases);
  }

  /**
   * Terminalizes an attempt's cleanup disposition through the purpose-specific
   * authority route.  A generic cleanup record is rejected by the underlying
   * authority; the generic path is not the authority route.
   */
  terminalize(input: AttemptTerminalizationInput): AttemptTerminalizationResult {
    switch (input.kind) {
      case "failure": {
        if (input.failure === undefined) {
          throw new TypeError("failure terminalization requires a failure input");
        }
        return this.#authority.terminalizeFailure(input.failure);
      }
      case "promotion": {
        if (input.promotion === undefined) {
          throw new TypeError("promotion terminalization requires a promotion input");
        }
        return this.#authority.terminalizePromotion(input.promotion);
      }
      case "quarantine": {
        if (input.quarantine === undefined) {
          throw new TypeError("quarantine terminalization requires a quarantine input");
        }
        return this.#authority.terminalizeQuarantine(input.quarantine);
      }
    }
  }
}

/**
 * Production terminalization entrypoint.  The build/dispatch path calls this
 * function to terminalize an attempt's disposition through the purpose-specific
 * authority route.  A generic cleanup record is rejected at the entry point.
 *
 * This is the real production terminalization entrypoint (not a test wrapper):
 * it constructs the production {@link AttemptTerminalizationService} and routes
 * through {@link AttemptTerminalizationAuthority}.  The generic
 * {@link CleanupService} path is not the authority route.
 */
export function terminalizeAttemptDisposition(
  store: StateStore,
  leases: LeaseAuthority,
  input: AttemptTerminalizationInput,
): AttemptTerminalizationResult {
  return new AttemptTerminalizationService(store, leases).terminalize(input);
}
