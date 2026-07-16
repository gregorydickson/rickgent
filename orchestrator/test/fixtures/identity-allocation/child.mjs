import { readFileSync } from "node:fs";
import { openStateStore } from "../../../dist/state/store.js";

function reply(message) {
  if (typeof process.send === "function") process.send(message);
}

const [command, repoPath, inputPath] = process.argv.slice(2);
let store;
try {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  store = openStateStore({ repoPath });
  let result;
  if (command === "fresh-run") {
    if (typeof store.allocateFreshRun !== "function") throw new Error("compiled state store lacks allocateFreshRun");
    result = store.allocateFreshRun(input);
  } else if (command === "retry-attempt") {
    if (typeof store.allocateRetryAttempt !== "function") throw new Error("compiled state store lacks allocateRetryAttempt");
    result = store.allocateRetryAttempt(input);
  }
  else throw new Error(`unknown identity-allocation fixture command: ${String(command)}`);
  reply({ type: "result", result });
} catch (error) {
  reply({
    type: "error",
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
  });
  process.exitCode = 1;
} finally {
  store?.close();
}
