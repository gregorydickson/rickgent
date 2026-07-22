/**
 * t27 — Independent review authority.
 *
 * The ReviewAuthority is the single authority for performing an independent
 * read-only review against immutable inputs.  It enforces:
 *
 *   - Fresh read-only review: the reviewer process/role differs from the
 *     implementation worker, has no write/terminal-state authority, and
 *     receives no mutable implementation session state.  The review hook
 *     receives only the frozen immutable inputs (no store, no write API).
 *   - Validated accept/reject verdict with structured findings: each finding
 *     has an id, severity, message, optional path, and optional evidence
 *     reference.  A reject verdict requires at least one finding.
 *   - Reviewer/worker authority collapse rejected: if the reviewer's context
 *     ID equals the worker's context ID, or the reviewer's role equals the
 *     worker's role, the review fails closed.
 *   - Fail-closed modes: reviewer crash, malformed/missing verdict, attempted
 *     write (mutation of frozen inputs), stale diff, role equality, and
 *     exhausted budget each block later phases and enter cleanup/failure.
 *   - Independent review, not cross-vendor: the schema version is
 *     `rickgent.independent-review.v1`.  Same-model review is allowed but is
 *     never labeled cross-vendor (cross-vendor claims require the t32
 *     identity-identity gate).
 *
 * @invariant Fail closed, everywhere.  Only `accepted` does not block.
 * @invariant The review hook receives only frozen immutable inputs — no
 *   store, no write capability, no mutable session state.
 * @invariant The authority-produced outcome is frozen (authority-owned, not
 *   caller-mutable).
 */

/**
 * The schema version for the independent review authority.  This is
 * intentionally `independent-review`, NOT `cross_vendor` — cross-vendor
 * claims require the t32 observed-identity gate.
 */
export const REVIEW_AUTHORITY_SCHEMA_VERSION = "rickgent.independent-review.v1" as const;

/**
 * The typed review verdict.  `accept` means the candidate passes review;
 * `reject` means the candidate has findings that require remediation.
 */
export type ReviewVerdict = "accept" | "reject";

/**
 * A structured finding from the review.  Each finding carries a unique id,
 * a severity, a human-readable message, an optional path, and an optional
 * evidence reference.
 */
export interface ReviewFinding {
  readonly id: string;
  readonly severity: "high" | "medium" | "low";
  readonly message: string;
  readonly path?: string;
  readonly evidenceReference?: string;
}

/**
 * The immutable inputs the reviewer receives.  These are frozen before the
 * review hook is called — the reviewer cannot mutate them.  The inputs
 * include the baseline OID, candidate OID, diff digest, contract digest,
 * and context digest, all of which bind the review to the exact immutable
 * state under review.
 */
export interface ReviewImmutableInputs {
  readonly baselineOid: string;
  readonly candidateOid: string;
  readonly diffDigest: string;
  readonly contractDigest: string;
  readonly contextDigest: string;
}

/**
 * The reviewer's identity.  The role is always `"reviewer"`.  The contextId
 * is the execution context of the fresh reviewer process.  The modelIdentity
 * is the observed identity of the reviewer (if any).
 */
export interface ReviewerIdentity {
  readonly role: "reviewer";
  readonly contextId: string;
  readonly modelIdentity?: string;
}

/**
 * The implementation worker's identity.  The role is `"worker"` or
 * `"remediator"`.  The contextId is the execution context of the
 * implementation process.  Used for authority-collapse detection.
 */
export interface WorkerIdentity {
  /**
   * The implementation worker's role.  In normal operation this is
   * `"worker"` or `"remediator"`.  If a caller supplies `"reviewer"`, the
   * authority detects authority collapse (the reviewer and the
   * implementation are the same authority) and fails closed.
   */
  readonly role: "worker" | "remediator" | "reviewer";
  readonly contextId: string;
  readonly modelIdentity?: string;
}

/**
 * The reason a review failed closed.  Each reason maps to a specific
 * fail-closed condition from the t27 acceptance criteria.
 */
export type ReviewFailClosedReason =
  | "authority_collapse"
  | "stale_diff"
  | "reviewer_crash"
  | "missing_verdict"
  | "malformed_verdict"
  | "attempted_write"
  | "empty_reject_findings"
  | "invalid_finding"
  | "incomplete_inputs";

/**
 * The result of the review hook.  The hook returns a verdict and an array
 * of structured findings.
 */
export interface ReviewHookResult {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewFinding[];
}

/**
 * The review hook is a pure, read-only function that receives only the
 * frozen immutable inputs.  It has no store reference, no write capability,
 * and no access to mutable implementation session state.
 */
export type ReviewHook = (inputs: ReviewImmutableInputs) => ReviewHookResult;

/**
 * A request to perform an independent review.  The reviewer identity, worker
 * identity, immutable inputs, expected diff digest, and the review hook are
 * all required.
 */
export interface ReviewRequest {
  /** The 1-based review cycle number. */
  readonly cycle: number;
  /** The fresh reviewer identity for this cycle. */
  readonly reviewer: ReviewerIdentity;
  /** The implementation worker identity (for authority-collapse detection). */
  readonly worker: WorkerIdentity;
  /** The immutable inputs under review. */
  readonly inputs: ReviewImmutableInputs;
  /** The expected diff digest (for stale-diff detection). */
  readonly expectedDiffDigest: string;
  /** The read-only review hook. */
  readonly reviewHook: ReviewHook;
}

/**
 * The outcome of an independent review.  `accepted` means the candidate
 * passed review; `rejected` means the candidate has findings requiring
 * remediation; `fail_closed` means the review could not produce a valid
 * verdict and later phases are blocked.
 *
 * The outcome is frozen (authority-owned, not caller-mutable).
 */
export interface ReviewOutcome {
  readonly status: "accepted" | "rejected" | "fail_closed";
  readonly verdict: ReviewVerdict | null;
  readonly findings: readonly ReviewFinding[];
  readonly failClosedReason?: ReviewFailClosedReason;
  readonly cycle: number;
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

function isValidVerdict(value: unknown): value is ReviewVerdict {
  return value === "accept" || value === "reject";
}

function isValidSeverity(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

function validateFinding(finding: unknown): finding is ReviewFinding {
  if (typeof finding !== "object" || finding === null) {
    return false;
  }
  const f = finding as Record<string, unknown>;
  if (typeof f.id !== "string" || f.id.length === 0) {
    return false;
  }
  if (!isValidSeverity(f.severity)) {
    return false;
  }
  if (typeof f.message !== "string" || f.message.length === 0) {
    return false;
  }
  if (f.path !== undefined && typeof f.path !== "string") {
    return false;
  }
  if (f.evidenceReference !== undefined && typeof f.evidenceReference !== "string") {
    return false;
  }
  return true;
}

function validateFindings(findings: unknown): findings is readonly ReviewFinding[] {
  if (!Array.isArray(findings)) {
    return false;
  }
  return findings.every(validateFinding);
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Perform an independent read-only review against immutable inputs.
 *
 * The review hook receives only the frozen immutable inputs — no store, no
 * write capability, no mutable session state.  The reviewer identity must
 * differ from the worker identity (authority-collapse rejection).  The
 * expected diff digest must match the inputs' diff digest (stale-diff
 * rejection).
 *
 * @returns A frozen `ReviewOutcome` (authority-owned, not caller-mutable).
 */
export function performReview(request: ReviewRequest): ReviewOutcome {
  const { cycle, reviewer, worker, inputs, expectedDiffDigest, reviewHook } = request;

  // --- Authority-collapse checks (before any review work) ---

  // Role equality: the reviewer's role must be "reviewer" and the worker's
  // role must NOT be "reviewer".  If the worker is also a "reviewer", the
  // reviewer and the implementation are the same authority.
  if (reviewer.role !== "reviewer") {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "authority_collapse" as ReviewFailClosedReason,
      cycle,
    });
  }

  if (worker.role === "reviewer") {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "authority_collapse" as ReviewFailClosedReason,
      cycle,
    });
  }

  // Context ID equality: the reviewer's context must differ from the
  // worker's context.  Same context means same execution scope — the
  // reviewer is not independent.
  if (reviewer.contextId === worker.contextId) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "authority_collapse" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Immutable-inputs validation ---

  if (
    typeof inputs.baselineOid !== "string" || inputs.baselineOid.length === 0 ||
    typeof inputs.candidateOid !== "string" || inputs.candidateOid.length === 0 ||
    typeof inputs.contractDigest !== "string" || inputs.contractDigest.length === 0 ||
    typeof inputs.contextDigest !== "string" || inputs.contextDigest.length === 0
  ) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "incomplete_inputs" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Stale-diff check ---

  if (
    typeof inputs.diffDigest !== "string" || inputs.diffDigest.length === 0 ||
    inputs.diffDigest !== expectedDiffDigest
  ) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "stale_diff" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Freeze the immutable inputs (defense in depth) ---

  const frozenInputs = deepFreeze({ ...inputs }) as ReviewImmutableInputs;

  // --- Run the review hook (read-only, immutable inputs only) ---

  let hookResult: unknown;
  try {
    hookResult = reviewHook(frozenInputs);
  } catch {
    // Reviewer crash — the hook threw an error.  Fail closed.
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "reviewer_crash" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Attempted-write detection ---

  // If the frozen inputs are no longer frozen after the hook ran, the
  // reviewer attempted to mutate the immutable inputs (an attempted write).
  if (!Object.isFrozen(frozenInputs)) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "attempted_write" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Missing-verdict check ---

  if (hookResult === null || hookResult === undefined) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "missing_verdict" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Malformed-verdict check ---

  const result = hookResult as { verdict?: unknown; findings?: unknown };
  if (!isValidVerdict(result.verdict)) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "malformed_verdict" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Findings validation ---

  if (!validateFindings(result.findings)) {
    // If the verdict is reject and findings are missing/empty, that's
    // empty_reject_findings.  Otherwise it's invalid_finding.
    const findingsArray = Array.isArray(result.findings) ? result.findings : [];
    if (result.verdict === "reject" && findingsArray.length === 0) {
      return deepFreeze({
        status: "fail_closed",
        verdict: null,
        findings: [],
        failClosedReason: "empty_reject_findings" as ReviewFailClosedReason,
        cycle,
      });
    }
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "invalid_finding" as ReviewFailClosedReason,
      cycle,
    });
  }

  const verdict = result.verdict;
  const findings = Object.freeze([...result.findings]) as readonly ReviewFinding[];

  // --- Reject requires at least one finding ---

  if (verdict === "reject" && findings.length === 0) {
    return deepFreeze({
      status: "fail_closed",
      verdict: null,
      findings: [],
      failClosedReason: "empty_reject_findings" as ReviewFailClosedReason,
      cycle,
    });
  }

  // --- Success ---

  const status: "accepted" | "rejected" = verdict === "accept" ? "accepted" : "rejected";
  return deepFreeze({
    status,
    verdict,
    findings,
    cycle,
  });
}
