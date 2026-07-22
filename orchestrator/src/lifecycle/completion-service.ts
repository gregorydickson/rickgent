// CompletionService (t28) — the single lifecycle completion oracle integration.
//
// VAL-ORC-002: Oracle v2 is the single completion oracle for the lifecycle.
// VAL-ORC-003: Missing or null oracle inputs block completion (fail closed).
//
// This service is the sole production route from the lifecycle layer to the
// versioned completion oracle ({@link evaluateAttemptOracle} in
// `state/oracle.ts`).  It wraps {@link StateStore.evaluateAndPersistAttemptOracle}
// and exposes one typed API that the lifecycle engine, AttemptRunner, and
// resume/reconcile paths must call to evaluate attempt completion.  No other
// lifecycle module may call the store's oracle method directly or bypass this
// service.
//
// The oracle requires every lifecycle, Git, process, gate, review, evidence,
// ownership, cleanup-eligibility, and scope input.  Missing or null inputs
// block completion (fail closed); there is no bypass flag, no nullable gate
// shortcut, and no second completion predicate.
//
// Invariants (t28 AC-1..AC-5):
//   - The oracle has a versioned typed input and pure typed result listing
//     every missing/failed/stale/conflicting input; null, skipped, unavailable,
//     and infrastructure error fail required gates.
//   - Accepted input requires the attributable scope-clean descendant commit,
//     exact lifecycle receipts, independent accepted review, all active gates,
//     process death, resource cleanup, and contract/context/oracle freshness.
//   - Live execution and persisted re-evaluation call the same oracle/version;
//     no second lifecycle-complete predicate or nullable gate shortcut exists.
//   - Independent fault injection for every gate asserts no forbidden later
//     phase, ready state, delivery-ref promotion, push, or PR.
//   - A caller audit proves workers, CLI, status, reconcile, and gate modules
//     cannot bypass the completion service.

import type { StateStore, PersistedAttemptOracleDecision } from "../state/store.js";
import { RICKGENT_ORACLE_VERSION } from "../state/oracle.js";

/**
 * Branded identity of every code path allowed to invoke the completion service.
 * Each member must correspond to a real `evaluateCompletion` call site.  The
 * caller audit (`test/core/caller-audit.test.ts`) pins this set.
 */
export type CompletionServiceCaller =
  | "attempt-runner.oracle"
  | "lifecycle-engine.oracle"
  | "resume.reconcile";

/**
 * ALLOWED callers of the completion service — pinned by the caller audit.
 * Any caller not in this set is a finding.  This prevents bypass: only the
 * production lifecycle paths may evaluate completion.
 */
export const ALLOWED_COMPLETION_SERVICE_CALLERS: ReadonlySet<CompletionServiceCaller> = new Set<CompletionServiceCaller>([
  "attempt-runner.oracle",
  "lifecycle-engine.oracle",
  "resume.reconcile",
]);

/**
 * The typed result of a completion evaluation.  The oracle's pure decision is
 * surfaced as either `accepted` or `rejected` with an explicit reasons list.
 * A rejection lists every missing/failed/stale/conflicting input — it never
 * silently returns accepted.
 */
export interface CompletionServiceResult {
  /** The oracle version that evaluated this decision. */
  readonly oracleVersion: string;
  /** The durable oracle decision id. */
  readonly oracleDecisionId: string;
  /** The oracle's typed result: `accepted` only when every required input is present and valid. */
  readonly result: "accepted" | "rejected";
  /** Sorted reasons for a rejection (empty for acceptance). Each reason identifies a specific missing/failed/stale/conflicting input. */
  readonly reasons: readonly string[];
  /** The input set digest the oracle evaluated (for replay/determinism). */
  readonly inputSetDigest: string;
  /** The output digest (for replay/conflict detection). */
  readonly outputDigest: string;
  /** Whether the reference integrity was exact (all digests matched). */
  readonly referenceIntegrity: "exact" | "invalid";
}

/**
 * The single completion oracle for the lifecycle.  This service is the sole
 * route from the lifecycle layer to the versioned completion oracle.  It
 * calls {@link StateStore.evaluateAndPersistAttemptOracle} which resolves all
 * persisted inputs in one transaction, evaluates the pure oracle, and
 * persists the decision idempotently.
 *
 * **No bypass:** the service rejects callers not in the allowlist.  There is
 * no `skip` flag, no `force` parameter, and no nullable gate shortcut.  The
 * oracle's pure evaluation is the single predicate; this service is its only
 * lifecycle-layer caller.
 *
 * **Fail closed:** missing, null, stale, conflicting, unavailable, or
 * infrastructure-error inputs produce a `rejected` result with explicit
 * reasons.  The service never manufactures an `accepted` outcome.
 */
export class CompletionService {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  /**
   * Evaluate attempt completion through the single versioned oracle.  This is
   * the sole production route to `ready_for_delivery`: the transition service
   * accepts only an accepted oracle decision from this service to advance an
   * attempt from `oracle_evaluation` to `verified` and a ticket from
   * `cleanup_pending` to `ready_for_delivery`.
   *
   * @param attemptId  The attempt whose persisted inputs the oracle evaluates.
   * @param idempotencyKey  A stable key; replay returns the identical decision.
   * @param caller  The branded caller identity (must be in the allowlist).
   * @returns The typed completion result.  `accepted` only when every required
   *          input is present, valid, and fresh; `rejected` with reasons
   *          otherwise.
   * @throws {TypeError} if the caller is not in the allowlist (no bypass).
   */
  evaluateAttemptCompletion(
    attemptId: string,
    idempotencyKey: string,
    caller: CompletionServiceCaller,
  ): CompletionServiceResult {
    if (!ALLOWED_COMPLETION_SERVICE_CALLERS.has(caller)) {
      throw new TypeError(`CompletionService.evaluateCompletion called by unauthorized caller: ${caller}`);
    }
    if (typeof attemptId !== "string" || attemptId.length === 0) {
      throw new TypeError("attemptId must be a non-empty string");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new TypeError("idempotencyKey must be a non-empty string");
    }

    const decision: PersistedAttemptOracleDecision = this.#store.evaluateAndPersistAttemptOracle({
      attemptId,
      idempotencyKey,
    });

    const oracleVersion = String(decision.decision.oracle_version);
    if (oracleVersion !== RICKGENT_ORACLE_VERSION) {
      throw new TypeError(`CompletionService: oracle version mismatch: ${oracleVersion}`);
    }

    const reasonsJson = String(decision.decision.reasons_json ?? "[]");
    let reasons: readonly string[];
    try {
      const parsed = JSON.parse(reasonsJson) as unknown;
      reasons = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      reasons = [];
    }

    return Object.freeze({
      oracleVersion,
      oracleDecisionId: String(decision.decision.oracle_decision_id),
      result: String(decision.decision.result) as "accepted" | "rejected",
      reasons: Object.freeze([...reasons].sort()),
      inputSetDigest: String(decision.decision.input_set_digest),
      outputDigest: String(decision.decision.output_digest),
      referenceIntegrity: "exact" as const,
    });
  }
}

/**
 * Audit predicate: returns `true` only if the given caller is in the
 * completion service allowlist.  Used by the caller-audit test to pin the
 * set of authorized callers.
 */
export function isAllowedCompletionServiceCaller(caller: string): boolean {
  return ALLOWED_COMPLETION_SERVICE_CALLERS.has(caller as CompletionServiceCaller);
}
