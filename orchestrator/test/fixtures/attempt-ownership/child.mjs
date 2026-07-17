import { LeaseAuthority } from "../../../dist/state/leases.js";
import { openStateStore } from "../../../dist/state/store.js";

function reply(message) {
  if (typeof process.send === "function") process.send(message);
}

const [repoPath] = process.argv.slice(2);
let store;

process.once("message", (message) => {
  if (message !== "start") return;
  try {
    store = openStateStore({ repoPath });
    const authority = new LeaseAuthority(store);
    const prepared = authority.prepareAcquisition({
      attemptId: "attempt-race",
      idempotencyKey: `race:${process.pid}`,
      ttlMs: 30_000,
    });
    const grant = authority.acquire(prepared);
    reply({ type: "result", ownershipId: grant.ownership.ownershipId });
  } catch (error) {
    reply({
      type: "error",
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    store?.close();
  }
});

reply({ type: "ready" });
