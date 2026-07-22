// t32: Cross-vendor reviewer distinction authority.
//
// Cross-vendor review is permitted ONLY when the canonical observed identities
// of the implementer and reviewer are genuinely distinct. Same-identity
// requests are rejected. The distinction is based on OBSERVED identity (from
// the isolated omnigent chat.db root conversation), never on router/ledger
// labels or requested/invoked identity alone.
//
// The t00 compatibility contract defines the distinction rule:
//   - Independent review requires: roles differ, process IDs differ, root
//     conversation IDs differ, read-only reviewer tools, immutable diff input,
//     and separate valid identity receipts.
//   - Cross-vendor additionally requires: canonical observed vendors differ
//     and both vendor observations have live-profile strength.
//
// Since `provider_vendor` is unavailable generically under the
// `effective-session-v1` profile (observed canonical_vendor is null), the
// strongest available distinction signal is the combination of canonical
// observed harness AND canonical observed model. Different harness alone is
// NOT cross-vendor (per the t00 contract:
// `different-harness-string-alone-is_cross_vendor: false`). Both harness AND
// model must differ to establish a genuine identity distinction.
//
// No router/ledger label alone can satisfy the gate. Missing, equal,
// ambiguous, spoofed, or stale reviewer identity blocks the cross-vendor
// claim without invalidating honest same-vendor independent-review mode.

import type { IdentityReceipt, IdentityReceiptSet } from "./model-identity.js";

// ── Result types ───────────────────────────────────────────────────────────

export const CROSS_VENDOR_DISTINCTION_SCHEMA_VERSION =
  "rickgent-cross-vendor-distinction/v1" as const;

export type CrossVendorDistinctionOutcome =
  | "permitted"
  | "denied";

export type CrossVendorDenialReason =
  | "missing_implementer_observed_identity"
  | "missing_reviewer_observed_identity"
  | "missing_implementer_harness"
  | "missing_reviewer_harness"
  | "missing_implementer_model"
  | "missing_reviewer_model"
  | "missing_implementer_vendor"
  | "missing_reviewer_vendor"
  | "same_observed_harness"
  | "same_observed_model"
  | "same_observed_vendor"
  | "same_observed_identity"
  | "same_conversation_id"
  | "same_role"
  | "spoofed_implementer_provenance"
  | "spoofed_reviewer_provenance"
  | "missing_implementer_conversation_id"
  | "missing_reviewer_conversation_id"
  | "missing_implementer_live_profile"
  | "missing_reviewer_live_profile"
  | "label_only_no_observed_identity";

export interface CrossVendorDistinctionResult {
  readonly schema_version: typeof CROSS_VENDOR_DISTINCTION_SCHEMA_VERSION;
  readonly outcome: CrossVendorDistinctionOutcome;
  readonly denial_reason: CrossVendorDenialReason | null;
  readonly implementer_observed_harness: string | null;
  readonly implementer_observed_model: string | null;
  readonly implementer_observed_vendor: string | null;
  readonly reviewer_observed_harness: string | null;
  readonly reviewer_observed_model: string | null;
  readonly reviewer_observed_vendor: string | null;
  readonly implementer_conversation_id: string | null;
  readonly reviewer_conversation_id: string | null;
  readonly implementer_live_profile: string | null;
  readonly reviewer_live_profile: string | null;
  readonly implementer_role: string;
  readonly reviewer_role: string;
  readonly genuine_distinction: boolean;
}

// ── Authority ──────────────────────────────────────────────────────────────

/**
 * Evaluate whether cross-vendor review is permitted based on the observed
 * identity receipts of the implementer and reviewer.
 *
 * The implementer and reviewer identity receipt sets must each contain a
 * valid observed identity receipt (from the chat.db seam). The observed
 * canonical harness AND model must both differ to establish a genuine
 * identity distinction. The conversation IDs must differ (separate
 * process/session). The roles must differ (implementer vs reviewer).
 *
 * No router/ledger label alone (requested or invoked without observed) can
 * satisfy the gate. Missing, equal, ambiguous, spoofed, or stale identity
 * blocks the cross-vendor claim.
 *
 * @returns A frozen `CrossVendorDistinctionResult`.
 */
export function evaluateCrossVendorDistinction(
  implementer: IdentityReceiptSet,
  reviewer: IdentityReceiptSet,
): CrossVendorDistinctionResult {
  const impl = implementer.observed;
  const rev = reviewer.observed;
  const implRole = implementer.requested.role;
  const revRole = reviewer.requested.role;

  const base = {
    schema_version: CROSS_VENDOR_DISTINCTION_SCHEMA_VERSION,
    implementer_observed_harness: impl.canonical_harness,
    implementer_observed_model: impl.canonical_model,
    implementer_observed_vendor: impl.canonical_vendor,
    reviewer_observed_harness: rev.canonical_harness,
    reviewer_observed_model: rev.canonical_model,
    reviewer_observed_vendor: rev.canonical_vendor,
    implementer_conversation_id: impl.conversation_id,
    reviewer_conversation_id: rev.conversation_id,
    implementer_live_profile: extractLiveProfile(implementer),
    reviewer_live_profile: extractLiveProfile(reviewer),
    implementer_role: implRole,
    reviewer_role: revRole,
  };

  // 1. Both observed identities must be present (not null producer).
  if (impl.producer !== "observed") {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_implementer_observed_identity",
      genuine_distinction: false,
    });
  }
  if (rev.producer !== "observed") {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_reviewer_observed_identity",
      genuine_distinction: false,
    });
  }

  // 2. Both observed provenances must be the external chat.db seam.
  if (impl.provenance !== "isolated-omnigent-chat-db-root-conversation") {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "spoofed_implementer_provenance",
      genuine_distinction: false,
    });
  }
  if (rev.provenance !== "isolated-omnigent-chat-db-root-conversation") {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "spoofed_reviewer_provenance",
      genuine_distinction: false,
    });
  }

  // 3. Both observed harnesses must be present (non-null).
  if (impl.canonical_harness === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_implementer_harness",
      genuine_distinction: false,
    });
  }
  if (rev.canonical_harness === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_reviewer_harness",
      genuine_distinction: false,
    });
  }

  // 4. Both observed models must be present (non-null).
  if (impl.canonical_model === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_implementer_model",
      genuine_distinction: false,
    });
  }
  if (rev.canonical_model === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_reviewer_model",
      genuine_distinction: false,
    });
  }

  // 5. Both conversation IDs must be present (non-null).
  if (impl.conversation_id === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_implementer_conversation_id",
      genuine_distinction: false,
    });
  }
  if (rev.conversation_id === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_reviewer_conversation_id",
      genuine_distinction: false,
    });
  }

  // 6. Roles must differ (implementer vs reviewer).
  if (implRole === revRole) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "same_role",
      genuine_distinction: false,
    });
  }

  // 7. Conversation IDs must differ (separate process/session).
  if (impl.conversation_id === rev.conversation_id) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "same_conversation_id",
      genuine_distinction: false,
    });
  }

  // 8. Observed harnesses must differ (genuine identity distinction).
  //    Check harness and model first (primary identity signals), then
  //    vendor (additional cross-vendor requirement).
  if (impl.canonical_harness === rev.canonical_harness) {
    // Same harness — not genuinely distinct. Check if model also matches.
    if (impl.canonical_model === rev.canonical_model) {
      return freeze({
        ...base,
        outcome: "denied",
        denial_reason: "same_observed_identity",
        genuine_distinction: false,
      });
    }
    // Same harness but different model — still not cross-vendor per t00
    // contract: different-harness-string-alone-is_cross_vendor: false.
    // But this is also different-model-alone which is not cross-vendor either.
    // Both harness AND model must differ.
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "same_observed_harness",
      genuine_distinction: false,
    });
  }

  // 9. Observed models must differ (genuine identity distinction).
  if (impl.canonical_model === rev.canonical_model) {
    // Different harness but same model — not cross-vendor.
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "same_observed_model",
      genuine_distinction: false,
    });
  }

  // 10. Both observed vendors must be present (non-null) for cross-vendor.
  //     The t00 contract requires distinct canonical observed vendors for a
  //     genuine cross-vendor distinction.  Under the effective-session-v1
  //     profile, vendor may be null; in that case the cross-vendor claim is
  //     denied because we cannot establish a genuine vendor distinction.
  if (impl.canonical_vendor === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_implementer_vendor",
      genuine_distinction: false,
    });
  }
  if (rev.canonical_vendor === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_reviewer_vendor",
      genuine_distinction: false,
    });
  }

  // 11. Both observations must have live-profile-strength (the profile must
  //     be a live-profile, not the offline effective-session-v1 profile).
  //     Live-profile-strength means the observed identity was captured from
  //     a real runtime observation, not just a requested label.
  const implLiveProfile = extractLiveProfile(implementer);
  const revLiveProfile = extractLiveProfile(reviewer);
  if (implLiveProfile === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_implementer_live_profile",
      genuine_distinction: false,
    });
  }
  if (revLiveProfile === null) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "missing_reviewer_live_profile",
      genuine_distinction: false,
    });
  }

  // 12. Observed vendors must differ (genuine cross-vendor distinction).
  if (impl.canonical_vendor === rev.canonical_vendor) {
    return freeze({
      ...base,
      outcome: "denied",
      denial_reason: "same_observed_vendor",
      genuine_distinction: false,
    });
  }

  // 13. All checks pass: distinct canonical observed vendors with
  //     live-profile-strength observations, different harness AND model,
  //     different conversation IDs, different roles — genuine cross-vendor
  //     distinction.
  return freeze({
    ...base,
    outcome: "permitted",
    denial_reason: null,
    genuine_distinction: true,
  });
}

/**
 * Verify that a cross-vendor claim is valid by checking the distinction
 * between implementer and reviewer observed identity receipts.
 *
 * Throws `CrossVendorDistinctionError` on denial. Returns the result on
 * success.
 */
export function verifyCrossVendorDistinction(
  implementer: IdentityReceiptSet,
  reviewer: IdentityReceiptSet,
): CrossVendorDistinctionResult {
  const result = evaluateCrossVendorDistinction(implementer, reviewer);
  if (result.outcome === "denied") {
    const reason = result.denial_reason ?? "same_observed_identity";
    throw new CrossVendorDistinctionError(
      reason,
      `cross-vendor review denied: ${reason}`,
    );
  }
  return result;
}

export class CrossVendorDistinctionError extends Error {
  readonly code: string;
  readonly reason: CrossVendorDenialReason;

  constructor(reason: CrossVendorDenialReason, message: string) {
    super(message);
    this.name = "CrossVendorDistinctionError";
    this.code = `CROSS_VENDOR_${reason.toUpperCase()}`;
    this.reason = reason;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the live-profile-strength signal from an identity receipt set.
 *
 * A live-profile-strength observation means the observed identity receipt
 * was captured from a real runtime observation (the chat.db seam with a
 * non-null conversation_id and non-null harness/model).  The
 * effective-session-v1 profile is an offline profile that authenticates only
 * the requested reviewer — it does not prove a distinct protected implementer
 * identity.  Only the runtime-reported-identity-v1 profile (or equivalent
 * live profile) has live-profile-strength.
 *
 * For the purposes of cross-vendor distinction, a receipt set has
 * live-profile-strength when:
 *   - The observed receipt has a non-null conversation_id (proven runtime
 *     observation from the chat.db seam)
 *   - The observed receipt has non-null canonical_harness and canonical_model
 *
 * @returns The profile string ("runtime-reported-identity-v1" when
 *          live-profile-strength is established, null otherwise).
 */
function extractLiveProfile(receiptSet: IdentityReceiptSet): string | null {
  const observed = receiptSet.observed;
  if (
    observed.conversation_id !== null &&
    observed.canonical_harness !== null &&
    observed.canonical_model !== null &&
    observed.provenance === "isolated-omnigent-chat-db-root-conversation"
  ) {
    return "runtime-reported-identity-v1";
  }
  return null;
}

function freeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Build a single identity receipt set from individual receipts. This is a
 * convenience helper for tests and consumers that have the three receipts
 * from separate producers.
 */
export function makeIdentityReceiptSet(
  requested: IdentityReceipt,
  invoked: IdentityReceipt,
  observed: IdentityReceipt,
): IdentityReceiptSet {
  return Object.freeze({ requested, invoked, observed });
}
