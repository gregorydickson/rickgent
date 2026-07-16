// Sequential queue (M1) — a durable FIFO scheduler for fixture dispatches.
//
// Every enqueued ticket is recorded `planned` in the shared dispatch ledger, so
// a killed run can reconstruct the queued (planned) state on resume (reconcile
// reads it back). The M1 fixture profile admits exactly one dispatch at a time;
// a throwing dispatch is captured fail-closed and the remaining FIFO work keeps
// draining.

import {
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
  type DispatchJournal,
} from "./dispatch.js";
import { InputContractError } from "../capabilities/registry.js";

/** Dispatches one ticket and resolves with its terminal/interim ledger entry. */
export type DispatchFn = (id: DispatchId) => Promise<DispatchEntry>;

export interface DrainHooks {
  /** Called synchronously the moment a queued ticket is spawned (FIFO order). */
  onSpawn?: (dispatchId: string, activeAfterSpawn: number) => void;
  /** Called after a ticket settles, once its slot has been released. */
  onSettle?: (dispatchId: string, entry: DispatchEntry, activeAfterSettle: number) => void;
}

export interface DrainResult {
  /** Terminal/interim entry per dispatchId, keyed by the dispatchId string. */
  results: Map<string, DispatchEntry>;
  /** dispatchIds in the order they were spawned (FIFO). */
  spawnOrder: string[];
  /** Peak simultaneous in-flight dispatches observed during the drain (≤ cap). */
  maxActiveObserved: number;
}

function plannedEntry(dispatchId: string): DispatchEntry {
  return {
    dispatchId,
    state: "planned",
    pid: null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    stdout: null,
    stderr: null,
  };
}

function failClosedEntry(dispatchId: string, reason: string): DispatchEntry {
  return {
    dispatchId,
    state: "failed",
    pid: null,
    startedAt: null,
    completedAt: new Date().toISOString(),
    exitCode: null,
    stdout: null,
    stderr: reason,
    terminalReason: "infrastructure_error",
  };
}

export class DispatchQueue {
  private queued: DispatchId[] = [];

  constructor(
    private ledger: DispatchJournal,
    maxConcurrent: number,
  ) {
    if (maxConcurrent !== 1) {
      throw new InputContractError("maxConcurrent must be exactly 1 for the sequential fixture profile");
    }
  }

  /** M1 is deliberately sequential; later milestones replace this scheduler. */
  get cap(): number {
    return 1;
  }

  get length(): number {
    return this.queued.length;
  }

  /**
   * Enqueue a ticket and record a diagnostic `planned` observation. JSONL is
   * never consulted for terminal replay; ordinary reruns are fresh attempts.
   */
  enqueue(id: DispatchId): void {
    this.queued.push(id);
    const idStr = dispatchIdString(id);
    this.ledger.append(plannedEntry(idStr));
  }

  /**
   * Drain queued tickets in FIFO order through the single M1 slot. Ownership-
   * pending dispatches stop the drain: starting another worker while a prior
   * mutation-capable descendant may live would violate ticket isolation.
   */
  async drain(dispatchFn: DispatchFn, hooks?: DrainHooks): Promise<DrainResult> {
    const results = new Map<string, DispatchEntry>();
    const spawnOrder: string[] = [];
    for (const id of this.queued) {
      const idStr = dispatchIdString(id);
      spawnOrder.push(idStr);
      hooks?.onSpawn?.(idStr, 1);
      let entry: DispatchEntry;
      try {
        entry = await dispatchFn(id);
      } catch (error) {
        entry = failClosedEntry(
          idStr,
          `dispatch threw (fail-closed): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      results.set(idStr, entry);
      hooks?.onSettle?.(idStr, entry, 0);
      if (entry.ownershipReleased === false) break;
    }
    return {
      results,
      spawnOrder,
      maxActiveObserved: this.queued.length === 0 ? 0 : 1,
    };
  }
}
