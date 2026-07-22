// Phase — the normative phase/remediation transition table (t24).
//
// Replaces the unused boolean 8-phase scaffold (`research` -> ... ->
// `simplify`) with one versioned typed transition table that defines every
// legal attempt edge, guard, evidence producer, role, retry/remediation
// budget, and failure target.  The boolean scaffold's `shouldAdvance` /
// `nextPhase` / `isTerminal` helpers are removed; the table is the single
// normative authority for which attempt transitions are legal.
//
// The table is synchronized with the `ATTEMPT_TRANSITIONS` frozen catalog in
// `state/schema.ts` (the forward success edges) and extends it with the
// failure edges (every pre-cleanup state to `cleanup_pending`) and the
// enriched metadata (evidence producer, role, remediation budget, failure
// target) required by t24 AC-1.  The `LifecycleEngine` in `engine.ts`
// validates every production attempt transition against this table and
// rejects illegal edges fail-closed.

/**
 * The versioned schema tag for this transition table.  A change to the table
 * structure or any declared edge MUST bump this version so persisted
 * transition replays can detect schema drift.  The version is intentionally
 * distinct from `ATTEMPT_TRANSITIONS` catalog versioning because the table
 * carries richer metadata (evidenceProducer / role / budget / failureTarget).
 */
export const PHASE_TABLE_VERSION = "rickgent.phase-table.v1" as const;

/**
 * The normative attempt lifecycle states.  These are the persisted states an
 * attempt may occupy; they replace the boolean 8-phase scaffold's
 * `research`/`research_review`/`plan`/`plan_review`/`implement`/
 * `spec_conformance`/`code_review`/`simplify` states, which were never
 * persisted and never used by the production AttemptRunner.
 */
export const PHASE_STATES = Object.freeze([
  "planned",
  "implementing",
  "implementation_captured",
  "reviewing",
  "remediating",
  "remediation_captured",
  "verification_queued",
  "verifying",
  "converging",
  "cleanup_pending",
  "oracle_evaluation",
  "verified",
  "failed_clean",
  "quarantined",
] as const);

export type PhaseState = (typeof PHASE_STATES)[number];

/**
 * The terminal attempt states.  An attempt that reaches one of these states
 * cannot transition further.  `verified` is the success terminal (the
 * promotion was finalized); `failed_clean` and `quarantined` are the failure
 * terminals.  `ready_for_delivery` is a TICKET state, not an attempt state.
 */
export const PHASE_TERMINAL_STATES = Object.freeze([
  "verified",
  "failed_clean",
  "quarantined",
] as const);

/**
 * The typed guard kinds the normative table recognizes.  Each guard is
 * enforced by the transactional transition service (the `TransitionAuthority`
 * for the typed path, the store CAS for the production path).  The guard
 * kind names mirror the `TransitionGuard` discriminated union in
 * `state/transitions.ts` but are intentionally string-identified so the
 * table is a pure data structure with no import cycle into the state layer.
 */
export type PhaseGuardKind =
  | "live_lease"
  | "process_receipt"
  | "execution_context"
  | "review_record_accepted"
  | "review_record_rejected"
  | "remediation_record"
  | "gate_results"
  | "cleanup_pending"
  | "cleanup_record_failed"
  | "cleanup_record_quarantined"
  | "oracle_promotion"
  | "verified_promotion"
  | "budget_exhausted";

/**
 * The service that produces the immutable evidence a transition must cite.
 * Mirrors the `owner` field of the `ATTEMPT_TRANSITIONS` catalog so the
 * table and the frozen catalog agree on which service owns each edge.
 */
export type EvidenceProducer =
  | "AttemptLifecycleService"
  | "ReviewService"
  | "RemediationService"
  | "VerificationService"
  | "CleanupService"
  | "TicketFinalizationService";

/**
 * The role that drives a transition.  Used by the engine to resolve the
 * execution context for the phase.  Mirrors the lifecycle roles already
 * recognized by `IdentityContextResolver`.
 */
export type PhaseRole =
  | "worker"
  | "reviewer"
  | "remediator"
  | "verifier"
  | "cleanup"
  | "finalizer";

/**
 * One declared legal edge in the normative phase/remediation transition
 * table.  Every field is immutable and the table is `Object.freeze`-d at
 * module load.
 */
export interface PhaseEdge {
  /** The state the attempt must currently occupy. */
  readonly from: PhaseState;
  /** The state the transition enters. */
  readonly to: PhaseState;
  /** The typed guard that must be satisfied for the edge to fire. */
  readonly guard: PhaseGuardKind;
  /** The service that produces the evidence the transition cites. */
  readonly evidenceProducer: EvidenceProducer;
  /** The role that drives the transition. */
  readonly role: PhaseRole;
  /**
   * `true` only on the `reviewing -> remediating` edge, indicating the
   * attempt's immutable remediation budget is consumed by the transition.
   * The `LifecycleEngine` enforces the budget cap (t24 AC-3).
   */
  readonly remediationBudgetConsumed?: boolean;
  /**
   * For failure edges, the terminal state the cleanup path eventually
   * reaches (`failed_clean` or `quarantined`).  Forward success edges do
   * not declare a failure target.
   */
  readonly failureTarget?: "failed_clean" | "quarantined";
}

/**
 * The one normative phase/remediation transition table.  Declares every
 * legal attempt edge:
 *
 * ```text
 * planned
 *   -> implementing
 *   -> implementation_captured
 *   -> reviewing
 *       -> verification_queued                       (accept)
 *       -> remediating -> remediation_captured -> reviewing  (reject, budget remains)
 *       -> cleanup_pending -> failed_clean|quarantined        (reject, budget exhausted)
 *   -> verifying
 *   -> converging
 *   -> cleanup_pending
 *   -> oracle_evaluation
 *   -> verified
 * ```
 *
 * Failure edges: every pre-cleanup state has a legal `-> cleanup_pending`
 * edge with `failureTarget: "failed_clean"`.  `cleanup_pending` then
 * branches to `failed_clean`, `quarantined`, or `oracle_evaluation`
 * (success).  `oracle_evaluation -> verified` is the success terminal.
 */
export const PHASE_TRANSITION_TABLE: readonly PhaseEdge[] = Object.freeze([
  // Forward (success) edges.
  {
    from: "planned",
    to: "implementing",
    guard: "live_lease",
    evidenceProducer: "AttemptLifecycleService",
    role: "worker",
  },
  {
    from: "implementing",
    to: "implementation_captured",
    guard: "process_receipt",
    evidenceProducer: "AttemptLifecycleService",
    role: "worker",
  },
  {
    from: "implementation_captured",
    to: "reviewing",
    guard: "execution_context",
    evidenceProducer: "ReviewService",
    role: "reviewer",
  },
  {
    from: "reviewing",
    to: "verification_queued",
    guard: "review_record_accepted",
    evidenceProducer: "ReviewService",
    role: "reviewer",
  },
  {
    from: "reviewing",
    to: "remediating",
    guard: "review_record_rejected",
    evidenceProducer: "ReviewService",
    role: "remediator",
    remediationBudgetConsumed: true,
  },
  {
    from: "remediating",
    to: "remediation_captured",
    guard: "remediation_record",
    evidenceProducer: "RemediationService",
    role: "remediator",
  },
  {
    from: "remediation_captured",
    to: "reviewing",
    guard: "execution_context",
    evidenceProducer: "ReviewService",
    role: "reviewer",
  },
  {
    from: "verification_queued",
    to: "verifying",
    guard: "execution_context",
    evidenceProducer: "VerificationService",
    role: "verifier",
  },
  {
    from: "verifying",
    to: "converging",
    guard: "gate_results",
    evidenceProducer: "VerificationService",
    role: "verifier",
  },
  {
    from: "converging",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "AttemptLifecycleService",
    role: "cleanup",
  },
  {
    from: "cleanup_pending",
    to: "oracle_evaluation",
    guard: "oracle_promotion",
    evidenceProducer: "TicketFinalizationService",
    role: "finalizer",
  },
  {
    from: "oracle_evaluation",
    to: "verified",
    guard: "verified_promotion",
    evidenceProducer: "TicketFinalizationService",
    role: "finalizer",
  },

  // Failure edges: every pre-cleanup state may enter cleanup_pending.
  // The attempt's remediation budget and the cleanup record outcome
  // determine which terminal state is eventually reached.
  {
    from: "planned",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "AttemptLifecycleService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "implementing",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "AttemptLifecycleService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "implementation_captured",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "AttemptLifecycleService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "reviewing",
    to: "cleanup_pending",
    guard: "budget_exhausted",
    evidenceProducer: "ReviewService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "remediating",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "RemediationService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "remediation_captured",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "RemediationService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "verification_queued",
    to: "cleanup_pending",
    guard: "cleanup_pending",
    evidenceProducer: "VerificationService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },
  {
    from: "verifying",
    to: "cleanup_pending",
    guard: "gate_results",
    evidenceProducer: "VerificationService",
    role: "cleanup",
    failureTarget: "failed_clean",
  },

  // Cleanup terminal edges.
  {
    from: "cleanup_pending",
    to: "failed_clean",
    guard: "cleanup_record_failed",
    evidenceProducer: "CleanupService",
    role: "cleanup",
  },
  {
    from: "cleanup_pending",
    to: "quarantined",
    guard: "cleanup_record_quarantined",
    evidenceProducer: "CleanupService",
    role: "cleanup",
  },
]);

/**
 * Return the declared legal edge for `(from, to)`, or `undefined` if no such
 * edge is declared.  The table is the single source of truth: the engine,
 * tests, and any future introspection tooling call this helper instead of
 * re-implementing the matcher.
 */
export function legalPhaseEdge(from: PhaseState, to: PhaseState): PhaseEdge | undefined {
  return PHASE_TRANSITION_TABLE.find((edge) => edge.from === from && edge.to === to);
}

/** `true` iff `(from, to)` is a declared legal edge in the normative table. */
export function isLegalPhaseEdge(from: PhaseState, to: PhaseState): boolean {
  return legalPhaseEdge(from, to) !== undefined;
}

/** `true` iff `state` is an attempt terminal state (`verified`, `failed_clean`, `quarantined`). */
export function isTerminalPhase(state: PhaseState): boolean {
  return (PHASE_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Return every legal outgoing edge from `state`.  Terminal states return an
 * empty array.  Used by `LifecycleEngine.resumeAttempt` to report the next
 * legal transitions after a crash/restart.
 */
export function phaseEdgesFrom(state: PhaseState): readonly PhaseEdge[] {
  return PHASE_TRANSITION_TABLE.filter((edge) => edge.from === state);
}

/**
 * The forward lifecycle ordering of non-terminal phase states.  Used by
 * {@link phaseStateIsAtOrPast} to determine whether an attempt is already at
 * or past a target state in the normative lifecycle sequence.  Terminal
 * states (`verified`, `failed_clean`, `quarantined`) and `cleanup_pending`
 * are intentionally excluded from this ordering because they are not part of
 * the forward phase walk the AttemptRunner drives.
 */
const FORWARD_PHASE_ORDER: readonly PhaseState[] = Object.freeze([
  "planned",
  "implementing",
  "implementation_captured",
  "reviewing",
  "remediating",
  "remediation_captured",
  "verification_queued",
  "verifying",
  "converging",
]);

/**
 * Return `true` iff `current` is at or past `target` in the forward lifecycle
 * ordering.  States not in the forward ordering (cleanup_pending, terminal
 * states) return `false` — they are not "past" any forward phase.  This
 * mirrors the store's `advanceAttemptState` idempotent short-circuit: if the
 * attempt is already past the target state, the transition is a no-op.
 */
export function phaseStateIsAtOrPast(current: PhaseState, target: PhaseState): boolean {
  const currentIndex = FORWARD_PHASE_ORDER.indexOf(current);
  const targetIndex = FORWARD_PHASE_ORDER.indexOf(target);
  if (currentIndex < 0 || targetIndex < 0) return false;
  return currentIndex > targetIndex;
}

/**
 * Return `true` iff `(from, to)` is a forward edge in the normative lifecycle
 * ordering (i.e. `from` strictly precedes `to` in
 * {@link FORWARD_PHASE_ORDER}).  Cycle edges like
 * `remediation_captured -> reviewing` (where `from` comes after `to` in the
 * forward order) return `false`.  States not in the forward ordering return
 * `false`.
 *
 * Used by the {@link LifecycleEngine} to distinguish forward edges (where the
 * `phaseStateIsAtOrPast` idempotent short-circuit is safe) from cycle edges
 * (where the short-circuit would incorrectly suppress a legitimate
 * backward-in-order transition).
 */
export function isForwardPhaseEdge(from: PhaseState, to: PhaseState): boolean {
  const fromIndex = FORWARD_PHASE_ORDER.indexOf(from);
  const toIndex = FORWARD_PHASE_ORDER.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return false;
  return fromIndex < toIndex;
}
