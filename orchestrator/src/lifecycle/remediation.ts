/**
 * t27 — Bounded remediation authority.
 *
 * The RemediationAuthority is the single authority for performing a bounded
 * remediation cycle and driving the full review-remediation-re-review loop.
 * It enforces:
 *
 *   - Bounded remediation: rejection enters remediation only within the
 *     contract budget (`maxReviewCycles` and `remediationLimit`).  When the
 *     budget is exhausted, the loop returns `budget_exhausted` (which blocks
 *     later phases and enters cleanup/failure).
 *   - Same owned attempt scope: remediation changes remain in the same
 *     owned attempt scope — the worker identity is preserved throughout the
 *     loop.  The reviewer changes each cycle (fresh reviewer process), but
 *     the worker (the owner) does not.
 *   - Fresh reviewer per cycle: each review cycle uses a fresh reviewer
 *     context (supplied by `freshReviewerContextId` and
 *     `freshReviewerContextDigest`).
 *   - Fail-closed propagation: a review fail-closed or a remediation
 *     fail-closed propagates as `fail_closed` (which blocks later phases
 *     and enters cleanup/failure).
 *   - Independent review, not cross-vendor: the remediation schema version
 *     is `rickgent.remediation.v1` (never cross-vendor).
 *
 * @invariant Fail closed, everywhere.  Only `accepted` does not block.
 * @invariant The authority-produced outcome is frozen (authority-owned, not
 *   caller-mutable).
 */

import {
  performReview,
  type ReviewFinding,
  type ReviewImmutableInputs,
  type ReviewHook,
  type ReviewOutcome,
  type ReviewerIdentity,
  type WorkerIdentity,
} from "./review.js";

/**
 * The schema version for the remediation authority.  This is intentionally
 * `remediation`, NOT `cross_vendor`.
 */
export const REMEDIATION_AUTHORITY_SCHEMA_VERSION = "rickgent.remediation.v1" as const;

/**
 * The result of the remediation hook.  The remediator produces a new
 * candidate tree OID and a new diff digest.
 */
export interface RemediationHookResult {
  readonly resultTreeOid: string;
  readonly resultDiffDigest: string;
}

/**
 * The remediation hook is a function that receives the structured findings
 * from the rejecting review and produces a remediated candidate.  The hook
 * runs within the same owned attempt scope (the worker's scope).
 */
export type RemediationHook = (findings: readonly ReviewFinding[]) => RemediationHookResult;

/**
 * A request to perform a single remediation cycle.
 */
export interface RemediationRequest {
  /** The 1-based remediation cycle number. */
  readonly cycle: number;
  /** The structured findings from the rejecting review. */
  readonly findings: readonly ReviewFinding[];
  /** The remediation hook. */
  readonly remediationHook: RemediationHook;
  /** The maximum number of remediation cycles (from the contract budget). */
  readonly maxRemediationCycles: number;
}

/**
 * The outcome of a single remediation cycle.  `remediated` means the
 * remediator produced a new candidate; `fail_closed` means the remediation
 * could not produce a valid result and later phases are blocked.
 */
export interface RemediationOutcome {
  readonly status: "remediated" | "fail_closed";
  readonly resultTreeOid: string | null;
  readonly resultDiffDigest: string | null;
  readonly failClosedReason?: string;
  readonly cycle: number;
}

/**
 * A request to run the full bounded remediation loop (review, reject,
 * remediate, re-review, repeat until accept or budget exhausted).
 */
export interface RemediationLoopRequest {
  /** The maximum number of review cycles (from contract.budgets.max_review_cycles). */
  readonly maxReviewCycles: number;
  /** The maximum number of remediation cycles (from contract.budgets.remediation_limit). */
  readonly remediationLimit: number;
  /** The initial immutable inputs for the first review cycle. */
  readonly initialInputs: ReviewImmutableInputs;
  /** The implementation worker identity (preserved throughout the loop). */
  readonly worker: WorkerIdentity;
  /** The read-only review hook. */
  readonly reviewHook: ReviewHook;
  /** The remediation hook. */
  readonly remediationHook: RemediationHook;
  /** Supplies a fresh reviewer context ID for each cycle. */
  readonly freshReviewerContextId: (cycle: number) => string;
  /** Supplies a fresh reviewer context digest for each cycle. */
  readonly freshReviewerContextDigest: (cycle: number) => string;
  /** Optional: supplies a fresh reviewer model identity for each cycle. */
  readonly freshReviewerModelIdentity?: (cycle: number) => string | undefined;
}

/**
 * The outcome of the full bounded remediation loop.
 * - `accepted`: the review accepted (possibly after remediation cycles).
 * - `budget_exhausted`: the review rejected and the budget is exhausted.
 * - `fail_closed`: a review or remediation fail-closed propagated.
 */
export interface RemediationLoopOutcome {
  readonly status: "accepted" | "budget_exhausted" | "fail_closed";
  readonly finalOutcome: ReviewOutcome;
  readonly cyclesUsed: number;
  readonly reviews: readonly ReviewOutcome[];
  readonly remediations: readonly RemediationOutcome[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  return obj;
}

/**
 * Build a fresh reviewer identity for a cycle.  Handles the optional
 * modelIdentity correctly under `exactOptionalPropertyTypes: true`.
 */
function buildReviewer(
  cycle: number,
  freshContextId: (cycle: number) => string,
  freshModelIdentity?: (cycle: number) => string | undefined,
): ReviewerIdentity {
  const base: ReviewerIdentity = {
    role: "reviewer",
    contextId: freshContextId(cycle),
  };
  if (freshModelIdentity !== undefined) {
    const mi = freshModelIdentity(cycle);
    if (mi !== undefined) {
      return { role: "reviewer", contextId: freshContextId(cycle), modelIdentity: mi };
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Single remediation cycle
// ---------------------------------------------------------------------------

/**
 * Perform a single remediation cycle.  The remediation hook receives the
 * structured findings from the rejecting review and produces a remediated
 * candidate.  Fail closed on crash, missing result, or empty OIDs.
 *
 * @returns A frozen `RemediationOutcome` (authority-owned).
 */
export function performRemediation(request: RemediationRequest): RemediationOutcome {
  const { cycle, findings, remediationHook, maxRemediationCycles } = request;

  // Findings must be non-empty (a rejection with no findings should have
  // been caught by the review authority, but defense in depth).
  if (!Array.isArray(findings) || findings.length === 0) {
    return deepFreeze({
      status: "fail_closed",
      resultTreeOid: null,
      resultDiffDigest: null,
      failClosedReason: "empty_findings",
      cycle,
    });
  }

  // Budget check: if the cycle exceeds the max, fail closed.
  if (cycle > maxRemediationCycles) {
    return deepFreeze({
      status: "fail_closed",
      resultTreeOid: null,
      resultDiffDigest: null,
      failClosedReason: "budget_exhausted",
      cycle,
    });
  }

  // Run the remediation hook.
  let hookResult: unknown;
  try {
    hookResult = remediationHook(Object.freeze([...findings]) as readonly ReviewFinding[]);
  } catch {
    return deepFreeze({
      status: "fail_closed",
      resultTreeOid: null,
      resultDiffDigest: null,
      failClosedReason: "remediation_crash",
      cycle,
    });
  }

  // Missing result.
  if (hookResult === null || hookResult === undefined) {
    return deepFreeze({
      status: "fail_closed",
      resultTreeOid: null,
      resultDiffDigest: null,
      failClosedReason: "missing_result",
      cycle,
    });
  }

  const result = hookResult as { resultTreeOid?: unknown; resultDiffDigest?: unknown };

  // Validate result tree OID.
  if (typeof result.resultTreeOid !== "string" || result.resultTreeOid.length === 0) {
    return deepFreeze({
      status: "fail_closed",
      resultTreeOid: null,
      resultDiffDigest: null,
      failClosedReason: "empty_result_tree_oid",
      cycle,
    });
  }

  // Validate result diff digest.
  if (typeof result.resultDiffDigest !== "string" || result.resultDiffDigest.length === 0) {
    return deepFreeze({
      status: "fail_closed",
      resultTreeOid: null,
      resultDiffDigest: null,
      failClosedReason: "empty_result_diff_digest",
      cycle,
    });
  }

  return deepFreeze({
    status: "remediated",
    resultTreeOid: result.resultTreeOid,
    resultDiffDigest: result.resultDiffDigest,
    cycle,
  });
}

// ---------------------------------------------------------------------------
// Bounded remediation loop
// ---------------------------------------------------------------------------

/**
 * Run the full bounded remediation loop: review, reject, remediate,
 * re-review (fresh reviewer), repeat until accept or budget exhausted.
 *
 * Each review cycle uses a fresh reviewer context (supplied by
 * `freshReviewerContextId` and `freshReviewerContextDigest`).  The worker
 * identity is preserved throughout (remediation stays in the same owned
 * attempt scope).
 *
 * @returns A frozen `RemediationLoopOutcome` (authority-owned).
 */
export function runBoundedRemediationLoop(
  request: RemediationLoopRequest,
): RemediationLoopOutcome {
  const {
    maxReviewCycles,
    remediationLimit,
    initialInputs,
    worker,
    reviewHook,
    remediationHook,
    freshReviewerContextId,
    freshReviewerContextDigest,
    freshReviewerModelIdentity,
  } = request;

  const reviews: ReviewOutcome[] = [];
  const remediations: RemediationOutcome[] = [];
  let currentInputs = initialInputs;
  let remediationCyclesUsed = 0;
  let cycle = 1;
  let lastOutcome: ReviewOutcome;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // --- Fresh reviewer for this cycle ---
    const reviewer: ReviewerIdentity = buildReviewer(cycle, freshReviewerContextId, freshReviewerModelIdentity);

    // --- Perform the review ---
    lastOutcome = performReview({
      cycle,
      reviewer,
      worker,
      inputs: currentInputs,
      expectedDiffDigest: currentInputs.diffDigest,
      reviewHook,
    });
    reviews.push(lastOutcome);

    // --- Accepted: done ---
    if (lastOutcome.status === "accepted") {
      return deepFreeze({
        status: "accepted",
        finalOutcome: lastOutcome,
        cyclesUsed: cycle,
        reviews: Object.freeze([...reviews]) as readonly ReviewOutcome[],
        remediations: Object.freeze([...remediations]) as readonly RemediationOutcome[],
      });
    }

    // --- Fail-closed: propagate ---
    if (lastOutcome.status === "fail_closed") {
      return deepFreeze({
        status: "fail_closed",
        finalOutcome: lastOutcome,
        cyclesUsed: cycle,
        reviews: Object.freeze([...reviews]) as readonly ReviewOutcome[],
        remediations: Object.freeze([...remediations]) as readonly RemediationOutcome[],
      });
    }

    // --- Rejected: check budget ---
    // If we've used all review cycles, or all remediation cycles, the
    // budget is exhausted.
    if (cycle >= maxReviewCycles || remediationCyclesUsed >= remediationLimit) {
      return deepFreeze({
        status: "budget_exhausted",
        finalOutcome: lastOutcome,
        cyclesUsed: cycle,
        reviews: Object.freeze([...reviews]) as readonly ReviewOutcome[],
        remediations: Object.freeze([...remediations]) as readonly RemediationOutcome[],
      });
    }

    // --- Perform remediation ---
    remediationCyclesUsed++;
    const remediationOutcome = performRemediation({
      cycle: remediationCyclesUsed,
      findings: lastOutcome.findings,
      remediationHook,
      maxRemediationCycles: remediationLimit,
    });
    remediations.push(remediationOutcome);

    // --- Remediation fail-closed: propagate ---
    if (remediationOutcome.status === "fail_closed") {
      return deepFreeze({
        status: "fail_closed",
        finalOutcome: lastOutcome,
        cyclesUsed: cycle,
        reviews: Object.freeze([...reviews]) as readonly ReviewOutcome[],
        remediations: Object.freeze([...remediations]) as readonly RemediationOutcome[],
      });
    }

    // --- Build new immutable inputs for the re-review ---
    currentInputs = deepFreeze({
      baselineOid: currentInputs.baselineOid,
      candidateOid: remediationOutcome.resultTreeOid as string,
      diffDigest: remediationOutcome.resultDiffDigest as string,
      contractDigest: currentInputs.contractDigest,
      contextDigest: freshReviewerContextDigest(cycle + 1),
    }) as ReviewImmutableInputs;

    // --- Next cycle with fresh reviewer ---
    cycle++;
  }
}
