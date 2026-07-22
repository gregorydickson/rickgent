// Recovery module (t29) — explicit-run resume from persisted receipts.
//
// VAL-ORC-004: Resume of explicit runs uses persisted receipts; response-lost
// planned retries resolve through typed no-side-effect cleanup; later attempts
// allocated only after reconciliation; commit messages remain non-authoritative.
//
// This module is the production entrypoint for resuming an explicit run after
// an interruption.  It reads the canonical repository state from the durable
// SQLite state store, validates contract/context/oracle version compatibility,
// and determines the next safe action for each ticket:
//
//   - If the latest attempt is in a mid-flight state (implementing, reviewing,
//     etc.), the ticket resumes from durable receipts (the AttemptRunner's
//     recoverAttempt reconstructs progress).
//   - If the latest attempt is a planned retry that was allocated but never
//     activated (response-lost retry), it is recovered as a typed no-side-
//     effect cleanup image via StateStore.recoverOrphanedPlannedAttempt, then
//     a newly committed higher-numbered attempt is allocated.
//   - If the latest attempt is terminal (failed_clean, quarantined, verified),
//     a retry may be allocated if the budget allows.
//
// Commit prose and caller state are never treated as truth.  Only durable
// receipts and current authority are authority.

import { DatabaseSync } from "node:sqlite";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type PersistedAttemptSelection,
  type ResumeCompatibilityInput,
  type RetryCompatibilityInput,
  type StateStore,
} from "../state/store.js";

/**
 * Input to {@link resumeRun}.  The caller supplies the explicit run id and
 * compatibility projection; the recovery module resolves the canonical
 * repository state from the durable state store at `repoPath`.
 */
export interface ResumeRunInput {
  /** The explicit run id to resume. */
  readonly runId: string;
  /** The repository path containing the `.git/rickgent/state.sqlite3` store. */
  readonly repoPath: string;
  /** The manifest digest the caller expects (must match the persisted run). */
  readonly manifestDigest: string;
  /** The context schema version the caller expects. */
  readonly contextSchemaVersion: string;
  /** The oracle version the caller expects. */
  readonly oracleVersion: string;
  /** The capability snapshot digest the caller expects. */
  readonly capabilitySnapshotDigest: string;
  /** The resource identity version the caller expects. */
  readonly resourceIdentityVersion: string;
  /** The ticket set the caller expects to resume. */
  readonly tickets: readonly ResumeRunTicket[];
}

export interface ResumeRunTicket {
  readonly ticketId: string;
  readonly contractDigest: string;
}

/** Information about an orphaned planned attempt detected during resume. */
export interface OrphanedPlannedAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
}

/** The next action to take for a ticket during resume. */
export type ResumeNextAction =
  | "resume_attempt"
  | "cleanup_orphan"
  | "allocate_retry"
  | "complete"
  | "await_reconciliation";

/** The plan for a single ticket during resume. */
export interface ResumeTicketPlan {
  readonly ticketId: string;
  readonly ticketInstanceId: string;
  readonly state: string;
  readonly latestAttempt: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly state: string;
  } | null;
  /** Non-null when the latest attempt is an orphaned planned retry. */
  readonly orphanedPlannedAttempt: OrphanedPlannedAttempt | null;
  /** The evidence id of the typed cleanup record (set after cleanup). */
  readonly orphanedPlannedCleanupRecordId: string | null;
  /** The newly allocated attempt (set after cleanup + allocation). */
  readonly newAttempt: {
    readonly attemptId: string;
    readonly attemptNumber: number;
  } | null;
  /**
   * The full attempt data for the attempt that should be dispatched or
   * re-entered by the build path.  Non-null for resume_attempt,
   * allocate_retry, and cleanup_orphan actions; null for complete and
   * await_reconciliation.  For resume_attempt, this is the latest persisted
   * attempt (the runner calls recoverAttempt on it).  For allocate_retry and
   * cleanup_orphan, this is the newly allocated retry attempt.
   */
  readonly dispatchAttempt: AllocatedAttempt | null;
  readonly nextAction: ResumeNextAction;
}

/** The result of a successful resume. */
export interface ResumeRunResult {
  readonly ok: true;
  readonly runId: string;
  readonly repositoryId: string;
  readonly runState: string;
  readonly tickets: readonly ResumeTicketPlan[];
}

/**
 * Resume an explicit run from persisted receipts.  This is the production
 * entrypoint for the `resume_retry` capability.
 *
 * @throws {CapabilityUnavailableError} if the `resume_retry` capability is not enabled.
 * @throws {RickgentBoundaryError} if the run is incompatible or does not exist.
 */
export function resumeRun(input: ResumeRunInput): ResumeRunResult {
  RUNTIME_CAPABILITY_GATE.require("resume_retry");

  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new TypeError("resumeRun requires a non-empty runId");
  }
  if (typeof input.repoPath !== "string" || input.repoPath.length === 0) {
    throw new TypeError("resumeRun requires a non-empty repoPath");
  }

  const store = openStateStore({ repoPath: input.repoPath });
  try {
    // Validate compatibility and get the current state from persisted receipts
    const resumeInput: ResumeCompatibilityInput = {
      runId: input.runId,
      manifestDigest: input.manifestDigest,
      contextSchemaVersion: input.contextSchemaVersion,
      oracleVersion: input.oracleVersion,
      capabilitySnapshotDigest: input.capabilitySnapshotDigest,
      resourceIdentityVersion: input.resourceIdentityVersion,
      tickets: input.tickets.map((t) => ({ ticketId: t.ticketId, contractDigest: t.contractDigest })),
    };
    const selection = store.selectCompatibleResume(resumeInput);

    const ticketPlans: ResumeTicketPlan[] = [];
    for (const ticket of selection.tickets) {
      ticketPlans.push(planTicketRecovery(store, ticket));
    }

    return Object.freeze({
      ok: true as const,
      runId: selection.runId,
      repositoryId: selection.repositoryId,
      runState: selection.state,
      tickets: Object.freeze(ticketPlans),
    });
  } finally {
    store.close();
  }
}

/**
 * Plan the recovery for a single ticket.  If the latest attempt is an
 * orphaned planned retry (allocated but never activated), it is cleaned up
 * and a new higher-numbered attempt is allocated.
 */
function planTicketRecovery(
  store: StateStore,
  ticket: {
    readonly ticketInstanceId: string;
    readonly ticketId: string;
    readonly contractDigest: string;
    readonly state: string;
    readonly latestAttempt: PersistedAttemptSelection | null;
  },
): ResumeTicketPlan {
  const latest = ticket.latestAttempt;

  if (latest === null) {
    // No attempt has been allocated yet — the ticket is in its initial state
    return Object.freeze({
      ticketId: ticket.ticketId,
      ticketInstanceId: ticket.ticketInstanceId,
      state: ticket.state,
      latestAttempt: null,
      orphanedPlannedAttempt: null,
      orphanedPlannedCleanupRecordId: null,
      newAttempt: null,
      dispatchAttempt: null,
      nextAction: "complete" as const,
    });
  }

  // Check if the latest attempt is an orphaned planned retry
  const orphaned = detectOrphanedPlannedAttempt(store, latest.attemptId, latest.state, latest.attemptNumber);

  if (orphaned && latest.state === "planned") {
    // Recover the orphaned planned attempt as a typed no-side-effect cleanup
    const cleanupIdempotencyKey = `orphaned-cleanup-${latest.attemptId}`;
    const cleanupEvidenceId = store.recoverOrphanedPlannedAttempt(latest.attemptId, cleanupIdempotencyKey);

    // Allocate a new higher-numbered retry attempt
    const retryInput: RetryCompatibilityInput = {
      runId: latest.runId,
      ticketId: latest.ticketId,
      contractDigest: latest.contractDigest,
      contextSchemaVersion: latest.contextSchemaVersion,
      oracleVersion: latest.oracleVersion,
      capabilitySnapshotDigest: latest.capabilitySnapshotDigest,
      resourceIdentityVersion: latest.resourceIdentityVersion,
    };

    let newAttempt: AllocatedAttempt;
    try {
      newAttempt = store.allocateRetryAttempt(retryInput);
    } catch {
      // Retry allocation may fail if budget is exhausted — the orphaned
      // cleanup still succeeded; the ticket is now awaiting reconciliation
      return Object.freeze({
        ticketId: ticket.ticketId,
        ticketInstanceId: ticket.ticketInstanceId,
        state: ticket.state,
        latestAttempt: {
          attemptId: latest.attemptId,
          attemptNumber: latest.attemptNumber,
          state: "failed_clean",
        },
        orphanedPlannedAttempt: {
          attemptId: latest.attemptId,
          attemptNumber: latest.attemptNumber,
        },
        orphanedPlannedCleanupRecordId: cleanupEvidenceId,
        newAttempt: null,
        dispatchAttempt: null,
        nextAction: "await_reconciliation" as const,
      });
    }

    return Object.freeze({
      ticketId: ticket.ticketId,
      ticketInstanceId: ticket.ticketInstanceId,
      state: ticket.state,
      latestAttempt: {
        attemptId: latest.attemptId,
        attemptNumber: latest.attemptNumber,
        state: "failed_clean",
      },
      orphanedPlannedAttempt: {
        attemptId: latest.attemptId,
        attemptNumber: latest.attemptNumber,
      },
      orphanedPlannedCleanupRecordId: cleanupEvidenceId,
      newAttempt: {
        attemptId: newAttempt.attemptId,
        attemptNumber: newAttempt.attemptNumber,
      },
      dispatchAttempt: newAttempt,
      nextAction: "allocate_retry" as const,
    });
  }

  // Check if the latest attempt is terminal and a retry is possible
  if (latest.state === "failed_clean" && ticket.state === "cleanup_pending") {
    // The latest attempt already failed clean — check if a new retry was
    // already allocated (idempotent resume)
    const alreadyAllocated = checkForLaterAttempt(store, ticket.ticketInstanceId, latest.attemptNumber);
    if (alreadyAllocated !== null) {
      // The later attempt is the one to resume — construct an
      // AllocatedAttempt-compatible object from the persisted data.
      // The full PersistedAttemptSelection was the latest from
      // selectCompatibleResume, but checkForLaterAttempt may find a newer
      // one.  Use the latest from the selection as the dispatch attempt
      // since it has the full field set.
      return Object.freeze({
        ticketId: ticket.ticketId,
        ticketInstanceId: ticket.ticketInstanceId,
        state: ticket.state,
        latestAttempt: {
          attemptId: alreadyAllocated.attemptId,
          attemptNumber: alreadyAllocated.attemptNumber,
          state: alreadyAllocated.state,
        },
        orphanedPlannedAttempt: null,
        orphanedPlannedCleanupRecordId: null,
        newAttempt: null,
        dispatchAttempt: latest as unknown as AllocatedAttempt,
        nextAction: "resume_attempt" as const,
      });
    }
    // Try to allocate a retry
    const retryInput: RetryCompatibilityInput = {
      runId: latest.runId,
      ticketId: latest.ticketId,
      contractDigest: latest.contractDigest,
      contextSchemaVersion: latest.contextSchemaVersion,
      oracleVersion: latest.oracleVersion,
      capabilitySnapshotDigest: latest.capabilitySnapshotDigest,
      resourceIdentityVersion: latest.resourceIdentityVersion,
    };
    try {
      const newAttempt = store.allocateRetryAttempt(retryInput);
      return Object.freeze({
        ticketId: ticket.ticketId,
        ticketInstanceId: ticket.ticketInstanceId,
        state: ticket.state,
        latestAttempt: {
          attemptId: newAttempt.attemptId,
          attemptNumber: newAttempt.attemptNumber,
          state: newAttempt.state,
        },
        orphanedPlannedAttempt: null,
        orphanedPlannedCleanupRecordId: null,
        newAttempt: {
          attemptId: newAttempt.attemptId,
          attemptNumber: newAttempt.attemptNumber,
        },
        dispatchAttempt: newAttempt,
        nextAction: "allocate_retry" as const,
      });
    } catch {
      // Budget exhausted or retry not possible
      return Object.freeze({
        ticketId: ticket.ticketId,
        ticketInstanceId: ticket.ticketInstanceId,
        state: ticket.state,
        latestAttempt: {
          attemptId: latest.attemptId,
          attemptNumber: latest.attemptNumber,
          state: latest.state,
        },
        orphanedPlannedAttempt: null,
        orphanedPlannedCleanupRecordId: null,
        newAttempt: null,
        dispatchAttempt: null,
        nextAction: "complete" as const,
      });
    }
  }

  // For any other state (implementing, reviewing, etc.), resume from receipts
  const isTerminal = latest.state === "failed_clean" || latest.state === "quarantined" || latest.state === "verified";
  return Object.freeze({
    ticketId: ticket.ticketId,
    ticketInstanceId: ticket.ticketInstanceId,
    state: ticket.state,
    latestAttempt: {
      attemptId: latest.attemptId,
      attemptNumber: latest.attemptNumber,
      state: latest.state,
    },
    orphanedPlannedAttempt: null,
    orphanedPlannedCleanupRecordId: null,
    newAttempt: null,
    dispatchAttempt: isTerminal ? null : (latest as unknown as AllocatedAttempt),
    nextAction: isTerminal ? ("complete" as const) : ("resume_attempt" as const),
  });
}

/**
 * Detect whether an attempt is an orphaned planned retry: allocated but never
 * activated (no execution context, no lease, no process receipts).  Only
 * retry attempts (attempt_number > 1) can be orphaned — an initial attempt
 * (attempt_number == 1) in "planned" state is the normal starting state.
 */
function detectOrphanedPlannedAttempt(store: StateStore, attemptId: string, state: string, attemptNumber: number): boolean {
  if (state !== "planned") return false;
  if (attemptNumber <= 1) return false; // initial attempt is not an orphaned retry
  const db = new DatabaseSync(store.location.databasePath, { readOnly: true });
  try {
    const sideEffects = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM execution_contexts WHERE attempt_id = ?) AS contexts,
        (SELECT COUNT(*) FROM attempt_ownership_leases WHERE attempt_id = ?) AS leases,
        (SELECT COUNT(*) FROM process_receipts p JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id WHERE x.attempt_id = ?) AS receipts
    `).get(attemptId, attemptId, attemptId) as { readonly contexts?: number; readonly leases?: number; readonly receipts?: number };
    return Number(sideEffects.contexts) === 0 && Number(sideEffects.leases) === 0 && Number(sideEffects.receipts) === 0;
  } finally {
    db.close();
  }
}

/**
 * Check if a later attempt (higher attempt number) was already allocated for
 * this ticket instance.  Used for idempotent resume.
 */
function checkForLaterAttempt(
  store: StateStore,
  ticketInstanceId: string,
  latestAttemptNumber: number,
): { readonly attemptId: string; readonly attemptNumber: number; readonly state: string } | null {
  const db = new DatabaseSync(store.location.databasePath, { readOnly: true });
  try {
    const later = db.prepare(
      "SELECT attempt_id, attempt_number, state FROM attempts WHERE ticket_instance_id = ? AND attempt_number > ? ORDER BY attempt_number LIMIT 1",
    ).get(ticketInstanceId, latestAttemptNumber) as { readonly attempt_id?: string; readonly attempt_number?: number; readonly state?: string } | undefined;
    if (later === undefined) return null;
    return {
      attemptId: String(later.attempt_id),
      attemptNumber: Number(later.attempt_number),
      state: String(later.state),
    };
  } finally {
    db.close();
  }
}
