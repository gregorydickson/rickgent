import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "../../src/lifecycle/reconcile.js";

// Prove that reconciliation (activated by t29) ignores legacy JSONL ledgers
// and reads only from the durable SQLite state store.
vi.mock("../../src/capabilities/runtime-gate.js", () => ({
  RUNTIME_CAPABILITY_GATE: Object.freeze({ require(): void {} }),
}));

describe("reconciliation ignores legacy JSONL and reads only the state store", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("cannot reconstruct planned, in-flight, or terminal tickets from JSONL", () => {
    const root = mkdtempSync(join(tmpdir(), "rickgent-reconcile-queue-"));
    roots.push(root);
    const diagnosticDir = join(root, ".rickgent");
    mkdirSync(diagnosticDir, { recursive: true });
    const ledger = join(diagnosticDir, "dispatch-ledger.jsonl");
    writeFileSync(ledger, [
      { dispatchId: "run/T-PLANNED/implement/1/worker", state: "planned" },
      { dispatchId: "run/T-INFLIGHT/implement/1/worker", state: "spawned" },
      { dispatchId: "run/T-DONE/implement/1/worker", state: "completed", commitSha: "deadbeef" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    // reconciliation is activated (t29); the gate passes.  The function
    // reads only from the state store (<root>/.git/rickgent/state.sqlite3),
    // which does not exist.  The JSONL ledger is ignored — no tickets are
    // reconstructed from it.
    const result = reconcile(root, diagnosticDir, ledger);
    expect(result.ok).toBe(true);
    expect(result.ticketsFound).toBe(0);
    expect(result.rebuilt).toBe(false);
  });
});
