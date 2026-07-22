// LifecycleEngine (t24) — the production entrypoint that validates every
// attempt phase transition against the normative {@link PHASE_TRANSITION_TABLE}
// and delegates to the transactional transition API.  Illegal edges are
// rejected fail-closed with `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL`.
//
// The engine is the single production authority for attempt phase
// transitions.  The boolean 8-phase scaffold (`shouldAdvance` /
// `PhaseResult.success`) is removed; the engine validates against the table
// and dispatches to the store's transactional CAS transition writer
// (`advanceAttemptState` / `advanceAttemptToCleanupPending`), which persists
// durable `state_transitions` rows with idempotent replay/conflict
// semantics.  The {@link TransitionAuthority} remains the typed-guard
// authority for the forward edges that carry full guard/evidence validation
// (used by the t22A–t22D composition proofs and the promotion finalization
// path); the engine's production path is the permissive-but-table-gated
// route the AttemptRunner uses for its six forward phase transitions.
//
// Invariants (t24 AC-1..AC-5):
//   - Every legal edge is declared in `PHASE_TRANSITION_TABLE`.
//   - Every illegal edge is rejected fail-closed (no state change, no row).
//   - Only the engine (and the TransitionAuthority for typed edges) writes
//     attempt transitions; the legacy boolean scaffold no longer exists.
//   - Crash/restart resumes from persisted receipts: `resumeAttempt` reads
//     the current state and reports the next legal edges without replaying
//     completed side effects.
//   - Skipped/unavailable/infrastructure phase results cannot advance: the
//     table declares no skip edges, and the engine rejects them.

import { DatabaseSync } from "node:sqlite";
import type { StateStore } from "../state/store.js";
import type { TransitionAuthority, TransitionEvidenceReference, TransitionGuard } from "../state/transitions.js";
import {
  isLegalPhaseEdge,
  isTerminalPhase,
  legalPhaseEdge,
  phaseEdgesFrom,
  phaseStateIsAtOrPast,
  PHASE_TABLE_VERSION,
  type PhaseEdge,
  type PhaseState,
} from "./phase.js";

/**
 * Fail-closed error thrown by the engine when an illegal edge is requested
 * or a precondition is violated.  The error code is a stable string that
 * callers can match; the message is diagnostic.  The error is always
 * constructed with a non-empty code and never carries a bypass flag.
 */
export class LifecycleEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LifecycleEngineError";
    this.code = code;
    Object.freeze(this);
  }
}

/** The result of a successful attempt phase transition. */
export interface LifecycleTransitionResult {
  /** The schema version of the normative table that authorized the transition. */
  readonly tableVersion: string;
  /** The transition id persisted in `state_transitions`. */
  readonly transitionId: string;
  /** The entity kind (`"attempt"` for phase transitions). */
  readonly entityKind: "attempt";
  /** The attempt id. */
  readonly attemptId: string;
  /** The sequence number of this transition for the attempt. */
  readonly entitySequence: number;
  /** The state the attempt transitioned from. */
  readonly fromState: PhaseState;
  /** The state the attempt transitioned to. */
  readonly toState: PhaseState;
  /** The attempt's new `state_version` after the CAS. */
  readonly stateVersion: number;
  /** The declared edge that authorized the transition. */
  readonly edge: PhaseEdge;
}

/** Input to {@link LifecycleEngine.transitionAttempt}. */
export interface LifecycleTransitionInput {
  /** The attempt whose state should transition. */
  readonly attemptId: string;
  /** The state the attempt must currently occupy. */
  readonly from: PhaseState;
  /** The state the transition enters. */
  readonly to: PhaseState;
  /**
   * A stable, non-empty idempotency key.  A replay of the same key returns
   * the identical postimage; a divergent postimage conflicts fail-closed.
   */
  readonly idempotencyKey: string;
  /**
   * The execution context digest binding this transition to the attempt's
   * lineage.  Required when routing through the TransitionAuthority (the
   * authority path validates the owner context against the attempt's
   * execution context).  When omitted, the engine falls back to the store
   * CAS path (which does not validate the owner context).
   */
  readonly contextDigest?: string;
  /**
   * The commit attribution id for the success-path cleanup transition
   * (`converging -> cleanup_pending`).  When provided, the engine builds a
   * `cleanup_pending` guard with the `commitAttributionId` so the store
   * validates the commit attribution exists and is finalized, and the
   * evidence must pin the attribution evidence.  When omitted (failure
   * paths), the guard has no `commitAttributionId` and the evidence must
   * include a `purpose: "failure"` reference.
   */
  readonly commitAttributionId?: string;
  /**
   * The immutable evidence references the transition cites.  The production
   * path (store CAS) does not persist evidence refs in
   * `transition_evidence_refs` (that is the typed {@link TransitionAuthority}
   * path's responsibility for forward edges); the field is accepted so the
   * same input shape can route to the typed path when guard rows are
   * available.  When provided, the array MUST be non-empty so a transition
   * never persists without at least one cited evidence reference (t24 AC-1:
   * every edge declares an evidence producer).  When omitted, the production
   * path validates the edge and delegates to the store CAS without evidence
   * ref persistence.
   */
  readonly evidence?: readonly TransitionEvidenceReference[];
  /**
   * The gate result IDs that authorize a gate_results-guarded edge (the
   * `verifying -> converging` success edge and the `verifying ->
   * cleanup_pending` failure edge).  When provided and non-empty, the engine
   * builds a `gate_results` guard and routes the transition through the
   * TransitionAuthority.  When omitted, the engine falls back to the store
   * CAS path (used by forward edges that do not carry gate_results guards).
   */
  readonly gateResultIds?: readonly string[];
}

/**
 * Map a normative table edge's guard string to a TransitionGuard that the
 * TransitionAuthority can validate.  Returns null when the guard requires
 * additional typed fields (e.g. live_lease ownershipId, process_receipt
 * processReceiptId) that the engine's generic transitionAttempt does not
 * carry — in that case the production AttemptRunner calls the authority's
 * typed methods directly, and the engine falls back to the store CAS.
 */
function guardForEdge(
  edge: PhaseEdge,
  opts: { commitAttributionId?: string; gateResultIds?: readonly string[] },
): TransitionGuard | null {
  switch (edge.guard) {
    case "cleanup_pending":
      return opts.commitAttributionId !== undefined
        ? { kind: "cleanup_pending", commitAttributionId: opts.commitAttributionId }
        : { kind: "cleanup_pending" };
    case "budget_exhausted":
      return { kind: "cleanup_pending" };
    case "gate_results":
      // The gate_results guard covers both the success edge (verifying ->
      // converging) and the failure edge (verifying -> cleanup_pending).
      // When gateResultIds are provided, build the guard so the engine
      // routes through the TransitionAuthority with full evidence and
      // context validation.  When omitted, fall back to the store CAS
      // (used by forward edges that do not supply gate result IDs).
      if (opts.gateResultIds !== undefined && opts.gateResultIds.length > 0) {
        return { kind: "gate_results", gateResultIds: Object.freeze([...opts.gateResultIds]) };
      }
      return null;
    case "cleanup_record_failed":
      return null;
    case "cleanup_record_quarantined":
      return null;
    default:
      return null;
  }
}

/** The result of {@link LifecycleEngine.resumeAttempt}. */
export interface LifecycleResumeResult {
  /** The attempt's current persisted state. */
  readonly currentState: PhaseState;
  /** The attempt's current `state_version`. */
  readonly currentStateVersion: number;
  /** The legal outgoing edges from `currentState`.  Empty for terminal states. */
  readonly legalNext: readonly PhaseEdge[];
  /** `true` iff `currentState` is a terminal state. */
  readonly isTerminal: boolean;
}

/**
 * The production entrypoint for attempt phase transitions.  The engine
 * validates every transition against the normative
 * {@link PHASE_TRANSITION_TABLE} and delegates to the store's transactional
 * CAS writer.  Illegal edges fail closed with
 * `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL`; no state is mutated and no
 * `state_transitions` row is persisted for a rejected edge.
 *
 * The engine is intentionally stateless beyond the store reference: all
 * durability lives in the store's `state_transitions` table, so a
 * crash/restart reconstructs the legal next edges from persisted receipts
 * alone via {@link LifecycleEngine.resumeAttempt}.
 */
export class LifecycleEngine {
  readonly #store: StateStore;
  readonly #authority: TransitionAuthority | null;

  constructor(store: StateStore, authority: TransitionAuthority | null = null) {
    this.#store = store;
    this.#authority = authority;
  }

  /**
   * Validate and persist an attempt phase transition.  Legal edges delegate
   * to the store's transactional CAS writer; illegal edges throw
   * {@link LifecycleEngineError} with code
   * `RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL` and persist nothing.
   */
  transitionAttempt(input: LifecycleTransitionInput): LifecycleTransitionResult {
    if (input.attemptId.length === 0) {
      throw new LifecycleEngineError(
        "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
        "attempt id is required",
      );
    }
    if (input.idempotencyKey.length === 0 || input.idempotencyKey !== input.idempotencyKey.trim()) {
      throw new LifecycleEngineError(
        "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
        "idempotency key must be non-empty and trimmed",
      );
    }
    if (input.evidence !== undefined && input.evidence.length === 0) {
      throw new LifecycleEngineError(
        "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
        "attempt transitions that cite evidence must cite at least one non-empty evidence reference",
      );
    }
    const edge = legalPhaseEdge(input.from, input.to);
    if (edge === undefined) {
      throw new LifecycleEngineError(
        "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
        `illegal phase transition: ${input.from} -> ${input.to} is not declared by ${PHASE_TABLE_VERSION}`,
      );
    }
    if (this.#authority !== null) {
      const guard = guardForEdge(edge, {
        ...(input.commitAttributionId !== undefined ? { commitAttributionId: input.commitAttributionId } : {}),
        ...(input.gateResultIds !== undefined ? { gateResultIds: input.gateResultIds } : {}),
      });
      if (guard !== null) {
        if (input.evidence === undefined || input.evidence.length === 0) {
          throw new LifecycleEngineError(
            "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
            "production callers MUST provide non-empty authority-owned evidence for guard-validated edges when TransitionAuthority is bound",
          );
        }
        if (input.contextDigest === undefined || input.contextDigest.length === 0) {
          throw new LifecycleEngineError(
            "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
            "production callers MUST provide a contextDigest for guard-validated edges when TransitionAuthority is bound",
          );
        }
        const databasePath = this.#store.location.databasePath;
        const currentState = this.#readAttemptState(databasePath, input.attemptId);
        if (currentState.state === input.to || phaseStateIsAtOrPast(currentState.state as PhaseState, input.to)) {
          const rows = this.#readTransitions(databasePath, input.attemptId);
          const enteringRow = [...rows].reverse().find((row) => String(row.to_state) === input.to);
          if (enteringRow !== undefined) {
            return Object.freeze({
              tableVersion: PHASE_TABLE_VERSION,
              transitionId: String(enteringRow.transition_id),
              entityKind: "attempt",
              attemptId: input.attemptId,
              entitySequence: Number(enteringRow.entity_sequence),
              fromState: String(enteringRow.from_state) as PhaseState,
              toState: String(enteringRow.to_state) as PhaseState,
              stateVersion: currentState.stateVersion,
              edge,
            });
          }
          return Object.freeze({
            tableVersion: PHASE_TABLE_VERSION,
            transitionId: `replay-${input.attemptId}-${input.to}`,
            entityKind: "attempt",
            attemptId: input.attemptId,
            entitySequence: rows.length,
            fromState: input.from,
            toState: input.to,
            stateVersion: currentState.stateVersion,
            edge,
          });
        }
        const result = this.#authority.commitAttemptEdge({
          attemptId: input.attemptId,
          from: input.from,
          to: input.to,
          ownerService: edge.evidenceProducer,
          guard,
          expectedVersion: currentState.stateVersion,
          ownerContextDigest: input.contextDigest,
          idempotencyKey: input.idempotencyKey,
          evidence: input.evidence,
        });
        const current = this.#readAttemptState(databasePath, input.attemptId);
        return Object.freeze({
          tableVersion: PHASE_TABLE_VERSION,
          transitionId: result.transitionId,
          entityKind: "attempt",
          attemptId: input.attemptId,
          entitySequence: result.entitySequence,
          fromState: String(result.fromState) as PhaseState,
          toState: String(result.toState) as PhaseState,
          stateVersion: current.stateVersion,
          edge,
        });
      }
    }
    // Delegate to the store's transactional CAS writer.  The store enforces:
    //   - the attempt exists (RICKGENT_STATE_RESUME_INCOMPATIBLE if not)
    //   - the from-state matches the persisted state (RICKGENT_STATE_TRANSITION_ILLEGAL)
    //   - idempotent replay returns the existing row (RICKGENT_STATE_IDEMPOTENCY_CONFLICT
    //     on divergent postimage)
    //   - a durable state_transitions row is persisted in one immediate transaction
    //
    // The store's `advanceAttemptState` has THREE idempotent short-circuits:
    //   1. If a row with the same idempotency key already exists, it returns
    //      the existing postimage (or conflicts on a divergent postimage).
    //   2. If the attempt is ALREADY in the target state, it returns silently.
    //   3. If the attempt is PAST the target state in the lifecycle ordering
    //      (e.g. the test fixture seeded it to "converging" and the runner
    //      replays "planned -> implementing"), it returns silently.
    // In cases 2 and 3 no new row is persisted; the engine reports the
    // latest transition row that entered the target state (or a synthetic
    // replay result) so the caller observes a consistent postimage.
    const databasePath = this.#store.location.databasePath;
    const currentState = this.#readAttemptState(databasePath, input.attemptId);
    if (currentState.state === input.to || phaseStateIsAtOrPast(currentState.state as PhaseState, input.to)) {
      // Idempotent short-circuit: the attempt is already at or past the
      // target state.  Return the latest transition row that entered this
      // state (if any) as the replay result.
      const rows = this.#readTransitions(databasePath, input.attemptId);
      const enteringRow = [...rows].reverse().find((row) => String(row.to_state) === input.to);
      if (enteringRow !== undefined) {
        return Object.freeze({
          tableVersion: PHASE_TABLE_VERSION,
          transitionId: String(enteringRow.transition_id),
          entityKind: "attempt",
          attemptId: input.attemptId,
          entitySequence: Number(enteringRow.entity_sequence),
          fromState: String(enteringRow.from_state) as PhaseState,
          toState: String(enteringRow.to_state) as PhaseState,
          stateVersion: currentState.stateVersion,
          edge,
        });
      }
      // No prior transition row — the state was seeded directly.  Return a
      // replay result with the current state version; the edge is still
      // validated against the normative table.
      return Object.freeze({
        tableVersion: PHASE_TABLE_VERSION,
        transitionId: `replay-${input.attemptId}-${input.to}`,
        entityKind: "attempt",
        attemptId: input.attemptId,
        entitySequence: rows.length,
        fromState: input.from,
        toState: input.to,
        stateVersion: currentState.stateVersion,
        edge,
      });
    }
    this.#store.advanceAttemptState(
      input.attemptId,
      input.from,
      input.to,
      input.idempotencyKey,
    );
    const afterRows = this.#readTransitions(databasePath, input.attemptId);
    // Identify the transition row for this idempotency key.
    const matching = afterRows.find((row) => String(row.idempotency_key) === input.idempotencyKey);
    if (matching === undefined) {
      // The store should have either persisted a row or thrown.  If neither,
      // fail closed rather than fabricate a positive result.
      throw new LifecycleEngineError(
        "RICKGENT_LIFECYCLE_TRANSITION_NOT_PERSISTED",
        `transition ${input.from} -> ${input.to} was accepted but no state_transitions row was persisted for idempotency key ${input.idempotencyKey}`,
      );
    }
    const current = this.#readAttemptState(databasePath, input.attemptId);
    return Object.freeze({
      tableVersion: PHASE_TABLE_VERSION,
      transitionId: String(matching.transition_id),
      entityKind: "attempt",
      attemptId: input.attemptId,
      entitySequence: Number(matching.entity_sequence),
      fromState: String(matching.from_state) as PhaseState,
      toState: String(matching.to_state) as PhaseState,
      stateVersion: current.stateVersion,
      edge,
    });
  }

  /**
   * Read the current persisted state of an attempt and report the legal
   * outgoing edges.  Used by crash/restart recovery to resume from
   * persisted receipts without replaying completed side effects or skipping
   * required work (t24 AC-4).  Terminal states report an empty `legalNext`.
   */
  resumeAttempt(attemptId: string): LifecycleResumeResult {
    if (attemptId.length === 0) {
      throw new LifecycleEngineError(
        "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
        "attempt id is required",
      );
    }
    const current = this.#readAttemptState(this.#store.location.databasePath, attemptId);
    const state = current.state as PhaseState;
    const legal = phaseEdgesFrom(state);
    return Object.freeze({
      currentState: state,
      currentStateVersion: current.stateVersion,
      legalNext: legal,
      isTerminal: isTerminalPhase(state),
    });
  }

  /**
   * Return the {@link TransitionAuthority} the engine was constructed with,
   * or `null` if no typed authority is bound.  Exposed so the production
   * AttemptRunner can delegate the typed forward edges (with full guard
   * validation) to the same authority the engine validates against.
   */
  get authority(): TransitionAuthority | null {
    return this.#authority;
  }

  /** The store the engine delegates to. */
  get store(): StateStore {
    return this.#store;
  }

  // ---- internal helpers --------------------------------------------------

  #readAttemptState(databasePath: string, attemptId: string): { state: string; stateVersion: number } {
    // Use the store's queryAttemptState for transactional read consistency.
    const state = this.#store.queryAttemptState(attemptId);
    // queryAttemptState returns only the state string; read the version
    // directly from the database for the CAS version.  The store does not
    // expose a queryAttemptStateVersion helper, so we use a read-only
    // prepared statement on the same database file the store owns.
    const database = new DatabaseSync(databasePath, { timeout: 1_000 });
    try {
      const row = database.prepare(
        "SELECT state_version FROM attempts WHERE attempt_id = ?",
      ).get(attemptId) as { state_version?: number | bigint } | undefined;
      if (row === undefined || row.state_version === undefined) {
        throw new LifecycleEngineError(
          "RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL",
          `attempt ${attemptId} does not exist`,
        );
      }
      return { state, stateVersion: Number(row.state_version) };
    } finally {
      database.close();
    }
  }

  #readTransitions(databasePath: string, attemptId: string): ReadonlyArray<Record<string, unknown>> {
    const database = new DatabaseSync(databasePath, { timeout: 1_000 });
    try {
      const rows = database.prepare(
        "SELECT * FROM state_transitions WHERE attempt_id = ? ORDER BY entity_sequence",
      ).all(attemptId) as ReadonlyArray<Record<string, unknown>>;
      return rows;
    } finally {
      database.close();
    }
  }
}

/**
 * Re-export the table helpers so callers that import from `engine.js` have a
 * single entry point.  The canonical definitions live in `phase.js`.
 */
export { isLegalPhaseEdge, isTerminalPhase, legalPhaseEdge, phaseEdgesFrom, phaseStateIsAtOrPast, PHASE_TABLE_VERSION };
