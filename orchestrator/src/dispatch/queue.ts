// Backpressure queue (B3) — a durable FIFO scheduler that drains queued
// dispatches under a concurrency cap.
//
// Every enqueued ticket is recorded `planned` in the shared dispatch ledger, so
// a killed run can reconstruct the queued (planned) state on resume (reconcile
// reads it back). The drain then dispatches each in enqueue (FIFO) order,
// keeping at most `maxConcurrent` in flight at once. A slot frees the instant a
// dispatch settles — success OR failure — so a failing dispatch never wedges a
// slot and the queue keeps draining. A `dispatchFn` that throws is captured as
// a fail-closed `failed` terminal entry rather than aborting the whole drain.
//
// The scheduler owns backpressure; the concurrency cap is the queue's cap, so
// no ticket is ever left permanently stranded by capacity pressure (goal 2).

import {
  DispatchLedger,
  dispatchIdString,
  type DispatchEntry,
  type DispatchId,
} from "./dispatch.js";
import {
  PRODUCTION_CAPABILITY_GATE,
  type CapabilityGate,
} from "../capabilities/registry.js";

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
    private ledger: DispatchLedger,
    private maxConcurrent: number,
    capabilityGate: CapabilityGate = PRODUCTION_CAPABILITY_GATE,
  ) {
    if (this.cap > 1) capabilityGate.require("parallel_dispatch");
  }

  /** Cap the queue enforces (always ≥ 1). */
  get cap(): number {
    return Math.max(1, Math.floor(this.maxConcurrent));
  }

  get length(): number {
    return this.queued.length;
  }

  /**
   * Enqueue a ticket and durably record it `planned` in the ledger (unless it
   * already reached a terminal state — idempotent across a resume). The planned
   * entry is what reconcile reads back to reconstruct the queued state.
   */
  enqueue(id: DispatchId): void {
    this.queued.push(id);
    const idStr = dispatchIdString(id);
    if (!this.ledger.isTerminal(idStr)) {
      this.ledger.append(plannedEntry(idStr));
    }
  }

  /**
   * Drain the queue: dispatch every enqueued ticket in FIFO order, at most
   * `cap` in flight at once, freeing a slot the moment a dispatch settles.
   * Resolves once every ticket has settled.
   */
  drain(dispatchFn: DispatchFn, hooks?: DrainHooks): Promise<DrainResult> {
    const results = new Map<string, DispatchEntry>();
    const spawnOrder: string[] = [];
    const cap = this.cap;
    const queue = this.queued;

    let active = 0;
    let maxActive = 0;
    let cursor = 0;

    return new Promise<DrainResult>((resolve) => {
      if (queue.length === 0) {
        resolve({ results, spawnOrder, maxActiveObserved: 0 });
        return;
      }

      const settle = (idStr: string, entry: DispatchEntry): void => {
        results.set(idStr, entry);
        active--;
        hooks?.onSettle?.(idStr, entry, active);
        if (cursor >= queue.length && active === 0) {
          resolve({ results, spawnOrder, maxActiveObserved: maxActive });
          return;
        }
        pump();
      };

      const pump = (): void => {
        while (active < cap && cursor < queue.length) {
          const id = queue[cursor++]!;
          const idStr = dispatchIdString(id);
          active++;
          if (active > maxActive) maxActive = active;
          spawnOrder.push(idStr);
          hooks?.onSpawn?.(idStr, active);
          // A throw is captured fail-closed so one bad dispatch cannot abort the
          // whole drain or leak a never-freed slot.
          Promise.resolve()
            .then(() => dispatchFn(id))
            .then(
              (entry) => settle(idStr, entry),
              (err) =>
                settle(
                  idStr,
                  failClosedEntry(
                    idStr,
                    `dispatch threw (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
                  ),
                ),
            );
        }
      };

      pump();
    });
  }
}
