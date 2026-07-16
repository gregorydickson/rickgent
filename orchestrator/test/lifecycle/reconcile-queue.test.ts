import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "../../src/lifecycle/reconcile.js";

// Prove a fixture capability-gate replacement cannot reactivate the removed
// legacy queue reconstruction path.
vi.mock("../../src/capabilities/runtime-gate.js", () => ({
  RUNTIME_CAPABILITY_GATE: Object.freeze({ require(): void {} }),
}));

describe("resume queue reconstruction is unavailable", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("cannot reconstruct planned, in-flight, or terminal tickets from JSONL", () => {
    const root = mkdtempSync(join(tmpdir(), "rickgent-reconcile-queue-unavailable-"));
    roots.push(root);
    const diagnosticDir = join(root, ".rickgent");
    mkdirSync(diagnosticDir, { recursive: true });
    const ledger = join(diagnosticDir, "dispatch-ledger.jsonl");
    writeFileSync(ledger, [
      { dispatchId: "run/T-PLANNED/implement/1/worker", state: "planned" },
      { dispatchId: "run/T-INFLIGHT/implement/1/worker", state: "spawned" },
      { dispatchId: "run/T-DONE/implement/1/worker", state: "completed", commitSha: "deadbeef" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    expect(() => reconcile(root, diagnosticDir, ledger)).toThrow(
      "RICKGENT_RECONCILIATION_UNAVAILABLE",
    );
  });
});
