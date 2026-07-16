import { DatabaseSync } from "node:sqlite";
import { openStateStore, resolveStateLocation } from "../../../dist/state/store.js";

function reply(message) {
  if (typeof process.send === "function") process.send(message);
}

function fail(error) {
  reply({
    type: "error",
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
  });
  process.exitCode = 1;
}

const [command, repoPath] = process.argv.slice(2);

try {
  if (command === "open") {
    const store = openStateStore({ repoPath });
    reply({ type: "opened", databasePath: store.location.databasePath });
    store.close();
  } else if (command === "hold-write-lock") {
    const location = resolveStateLocation(repoPath);
    const database = new DatabaseSync(location.databasePath, { timeout: 1_000 });
    database.exec("BEGIN IMMEDIATE");
    reply({ type: "locked" });

    const deadline = setTimeout(() => {
      try {
        database.exec("ROLLBACK");
        database.close();
      } finally {
        fail(new Error("write-lock fixture timed out waiting for release"));
      }
    }, 20_000);

    process.once("message", (message) => {
      if (message !== "release") return;
      clearTimeout(deadline);
      database.exec("ROLLBACK");
      database.close();
      reply({ type: "released" });
    });
  } else {
    throw new Error(`unknown state-store fixture command: ${String(command)}`);
  }
} catch (error) {
  fail(error);
}
