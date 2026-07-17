import { DatabaseSync } from "node:sqlite";
import { readFileSync, readSync, writeSync } from "node:fs";

function reply(message) {
  if (typeof process.send !== "function") return Promise.reject(new Error("crash child IPC channel is unavailable"));
  return new Promise((resolve, reject) => {
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function errorReply(error) {
  return reply({
    type: "error",
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
  });
}

function waitForProceed() {
  return new Promise((resolve, reject) => {
    process.once("message", (received) => {
      if (received !== "proceed") {
        reject(new Error(`expected parent proceed, received ${String(received)}`));
        return;
      }
      resolve();
    });
  });
}

function checkpoint(type, operation) {
  const frame = `${JSON.stringify({ type: "checkpoint", checkpoint: type, operation })}\n`;
  writeSync(1, frame, undefined, "utf8");
  readSync(0, Buffer.alloc(1), 0, 1, null);
}

const [command, repoPath, inputPath, crashSide = "none"] = process.argv.slice(2);
if (!command || !repoPath || !inputPath) {
  throw new Error("usage: child.mjs <probe|retry> <repo> <input.json> [before_commit|after_commit_before_return|none]");
}

const originalExec = DatabaseSync.prototype.exec;
let armed = false;
let observedTransaction = false;
DatabaseSync.prototype.exec = function instrumentedExec(sql) {
  const isCommit = armed && sql.trim().toUpperCase() === "COMMIT";
  if (isCommit && observedTransaction) throw new Error("crash probe observed more than one target transaction");
  if (isCommit) {
    observedTransaction = true;
    if (crashSide === "before_commit") checkpoint("before_commit", command);
  }
  const result = originalExec.call(this, sql);
  if (isCommit && crashSide === "after_commit_before_return") checkpoint("after_commit_before_return", command);
  return result;
};

let store;
try {
  const { openStateStore } = await import("../../../dist/state/store.js");
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  store = openStateStore({ repoPath });
  await reply({ type: "ready", command, crashSide });
  await waitForProceed();
  armed = true;

  const result = command === "probe"
    ? store.appendEvidence(input)
    : command === "retry"
      ? store.allocateRetryAttempt(input)
      : (() => { throw new Error(`unknown crash-matrix command: ${command}`); })();

  armed = false;
  if (!observedTransaction) throw new Error("crash probe did not observe a target transaction commit");
  await reply({ type: "result", result });
} catch (error) {
  try {
    await errorReply(error);
  } catch {
    // The parent may have intentionally terminated or disconnected the child.
  }
  process.exitCode = 1;
} finally {
  armed = false;
  store?.close();
  DatabaseSync.prototype.exec = originalExec;
}
