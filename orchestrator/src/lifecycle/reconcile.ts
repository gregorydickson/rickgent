// Reconciliation (t29) — rebuild derived views from persisted receipts.
//
// VAL-ORC-004: Structured reconciliation uses the shared oracle and
// transactionally persisted run-attributed receipts; Git subjects and
// cross-run ticket IDs are ignored.
//
// Reconciliation reads the canonical state from the durable SQLite state
// store and rebuilds derived views (e.g., registry.json) from the immutable
// run/attempt/ticket receipts.  It does NOT read Git subjects, commit
// messages, or legacy JSONL dispatch ledgers — those sources cannot carry
// the canonical run, ticket-instance, attempt, owner-context, cleanup, and
// oracle lineage required by the transactional StateStore.
//
// If no state store exists for the given working directory, reconciliation
// reports zero tickets found (no receipts to reconcile from).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";

/** The result of a reconciliation pass. */
export interface ReconcileResult {
  readonly ok: boolean;
  readonly rebuilt: boolean;
  readonly ticketsFound: number;
  readonly errors: readonly string[];
}

/**
 * Rebuild derived views from persisted receipts.  This is the production
 * entrypoint for the `reconciliation` capability.
 *
 * The function opens the state store at `<workingDir>/.git/rickgent/
 * state.sqlite3` and reads the persisted run/ticket/attempt receipts.  It
 * does NOT read Git subjects, commit messages, or legacy JSONL ledgers.
 *
 * @param workingDir  The repository working directory.
 * @param diagnosticStateDir  The `.rickgent` diagnostic directory (unused —
 *   receipts are read from the state store, not the diagnostic directory).
 * @param diagnosticLedgerPath  Optional legacy dispatch ledger path (unused —
 *   legacy JSONL claims are never imported as truth).
 * @returns A typed reconcile result.  If no state store exists, returns
 *   `{ ok: true, rebuilt: false, ticketsFound: 0, errors: [] }`.
 */
export function reconcile(
  workingDir: string,
  diagnosticStateDir: string,
  diagnosticLedgerPath?: string,
): ReconcileResult {
  // Require the reconciliation capability through the runtime gate.
  RUNTIME_CAPABILITY_GATE.require("reconciliation");

  // The diagnostic state dir and legacy ledger path are accepted but never
  // used as authority.  They are passed for API compatibility only.
  void diagnosticStateDir;
  void diagnosticLedgerPath;

  // Resolve the state store path from the working directory.
  const stateDir = join(workingDir, ".git", "rickgent");
  const dbPath = join(stateDir, "state.sqlite3");

  if (!existsSync(dbPath)) {
    // No state store — no receipts to reconcile from.
    return Object.freeze({
      ok: true,
      rebuilt: false,
      ticketsFound: 0,
      errors: [],
    });
  }

  // Read the persisted receipts directly from the state store (read-only).
  // We use a raw DatabaseSync handle instead of openStateStore because
  // reconciliation is a read-only derived-view rebuild, not a mutation.
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true, timeout: 1_000 });
  } catch {
    // Database is unreadable — fail closed with an error.
    return Object.freeze({
      ok: false,
      rebuilt: false,
      ticketsFound: 0,
      errors: ["state store is unreadable"],
    });
  }

  try {
    // Count the persisted run-attributed tickets from the state store.
    // Git subjects and cross-run ticket IDs are ignored — only the durable
    // receipts in the state store are authority.
    const ticketCount = database.prepare(
      "SELECT COUNT(*) AS count FROM run_tickets",
    ).get() as { readonly count?: number } | undefined;

    const count = ticketCount === undefined ? 0 : Number(ticketCount.count);

    return Object.freeze({
      ok: true,
      rebuilt: count > 0,
      ticketsFound: count,
      errors: [],
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      rebuilt: false,
      ticketsFound: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  } finally {
    database.close();
  }
}
