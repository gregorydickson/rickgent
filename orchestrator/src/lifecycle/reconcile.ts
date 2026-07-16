// Reconciliation is intentionally unavailable in the reliability preview.
//
// Historical implementations rebuilt lifecycle state from commit subjects and
// append-only JSONL dispatch claims. Neither source carries the canonical run,
// ticket-instance, attempt, owner-context, cleanup, and oracle lineage required
// by the transactional StateStore. Importing either source would let legacy
// evidence manufacture terminal state, so this boundary has no recovery
// implementation until the owner-checked recovery phase lands.

import {
  CapabilityUnavailableError,
  getCapability,
} from "../capabilities/registry.js";

/** Kept for cleanup result compatibility while reconciliation is unavailable. */
export interface ReconcileResult {
  readonly ok: false;
  readonly rebuilt: false;
  readonly ticketsFound: 0;
  readonly errors: readonly string[];
}

/**
 * Fail closed independently of the fixture runtime capability gate.
 *
 * Test builds replace that gate to exercise the contained dispatch fixture;
 * such replacement must never turn legacy Git/JSONL import into authority.
 */
export function reconcile(
  workingDir: string,
  diagnosticStateDir: string,
  diagnosticLedgerPath?: string,
): ReconcileResult {
  void workingDir;
  void diagnosticStateDir;
  void diagnosticLedgerPath;
  throw new CapabilityUnavailableError(getCapability("reconciliation"));
}
