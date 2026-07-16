import { readFileSync } from "node:fs";
import { openStateStore } from "../../../dist/state/store.js";
import { TransitionAuthority } from "../../../dist/state/transitions.js";

const [repoPath, inputPath] = process.argv.slice(2);
if (!repoPath || !inputPath) throw new Error("usage: child.mjs <repo> <input.json>");

const { method, request } = JSON.parse(readFileSync(inputPath, "utf8"));
let store;
try {
  store = openStateStore({ repoPath });
  const authority = new TransitionAuthority(store);
  const operation = authority[method];
  if (typeof operation !== "function") throw new TypeError(`unknown transition method: ${String(method)}`);
  const result = operation.call(authority, request);
  if (typeof process.send === "function") process.send({ type: "result", result });
} catch (error) {
  if (typeof process.send === "function") {
    process.send({
      type: "error",
      code: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
} finally {
  store?.close();
}
