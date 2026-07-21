/**
 * t23 concurrency corpus worker fixture.
 *
 * This module is spawned as a separate Node process via `fork()` by the
 * concurrency-corpus test.  Each worker opens the shared StateStore against a
 * disposable repository, exercises one conflict scenario from the corpus
 * manifest, and reports the observed result back to the parent via IPC.
 *
 * The worker imports from the BUILT `dist/` tree (not `src/`) because it runs
 * in a separate Node process outside vitest's TS resolver.  `init.sh`
 * rebuilds dist before the test runs.
 *
 * Usage:
 *   node worker-fixtures.mjs --repo <path> --scenario <name> [options]
 *
 * Scenarios (selected by --scenario):
 *   acquire-competing     Acquire ownership for --attempt-id; report ownershipId
 *                         or RICKGENT_STATE_CONFLICT.
 *   acquire-distinct      Acquire ownership for --attempt-id (a distinct
 *                         attempt); report ownershipId.
 *   provision-overlapping Acquire + provision workspace + commit to the
 *                         attempt ref; report candidateOid and worktreePath.
 *   foreign-commit        Acquire attempt A, then try to update attempt B's
 *                         attempt ref to a foreign oid; report whether the git
 *                         update-ref succeeded (the parent verifies the rival's
 *                         durable baseline is unaffected).
 *   move-delivery-ref     Acquire attempt A, then move the run delivery ref to
 *                         a new oid; report the new delivery oid.
 *   spawn-stubborn        Spawn a stubborn descendant process tree that tries
 *                         to write an escape marker; report the escape attempt.
 *   flood-output          Write a large volume to the attempt's stdout/stderr
 *                         paths; report the bytes written.
 *
 * All scenarios report via process.send with { type: "result", ... } on
 * success or { type: "error", code, message } on failure.  The parent test
 * treats an unexpected error as an infrastructure error (not a caught race).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LeaseAuthority } from "../../../dist/state/leases.js";
import { openStateStore } from "../../../dist/state/store.js";
import { provisionAttemptWorkspace } from "../../../dist/git/attempt-workspace.js";

// ---------------------------------------------------------------------------
// IPC helpers.
// ---------------------------------------------------------------------------

function reply(message) {
  if (typeof process.send === "function") process.send(message);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (typeof arg !== "string" || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
      args[key] = true;
    } else {
      args[key] = value;
      index++;
    }
  }
  return args;
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

// ---------------------------------------------------------------------------
// Scenario implementations.
// ---------------------------------------------------------------------------

function acquireAttempt(leases, attemptId, idempotencyKey) {
  const prepared = leases.prepareAcquisition({ attemptId, idempotencyKey });
  return leases.acquire(prepared);
}

function scenarioAcquireCompeting(leases, args) {
  const grant = acquireAttempt(leases, args["attempt-id"], args["idempotency-key"]);
  reply({
    type: "result",
    scenario: "acquire-competing",
    ownershipId: grant.ownership.ownershipId,
    attemptId: args["attempt-id"],
  });
}

function scenarioAcquireDistinct(leases, args) {
  const grant = acquireAttempt(leases, args["attempt-id"], args["idempotency-key"]);
  reply({
    type: "result",
    scenario: "acquire-distinct",
    ownershipId: grant.ownership.ownershipId,
    attemptId: args["attempt-id"],
  });
}

function scenarioProvisionOverlapping(leases, args) {
  const grant = acquireAttempt(leases, args["attempt-id"], args["idempotency-key"]);
  const provisioned = provisionAttemptWorkspace(leases, grant);
  if (!provisioned.ok) {
    throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  }
  const worktreePath = provisioned.workspace.worktreePath;
  const label = args["label"] ?? args["attempt-id"];
  // Write a scenario-specific file and commit on the attempt ref.
  mkdirSync(join(worktreePath, "src"), { recursive: true });
  writeFileSync(join(worktreePath, "src", "concurrency.ts"), `export const label = ${JSON.stringify(label)};\n`, "utf8");
  execFileSync("git", ["-C", worktreePath, "add", "src/concurrency.ts"]);
  execFileSync("git", ["-C", worktreePath, "commit", "-qm", `concurrency:${label}`]);
  const candidateOid = git(worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${args["run-id"]}/attempts/${args["attempt-id"]}`;
  git(args["repo"], "update-ref", attemptRef, candidateOid);
  reply({
    type: "result",
    scenario: "provision-overlapping",
    ownershipId: grant.ownership.ownershipId,
    attemptId: args["attempt-id"],
    candidateOid,
    attemptRef,
    worktreePath,
  });
}

function scenarioForeignCommit(args) {
  // The foreign-commit scenario does NOT acquire ownership.  It receives a
  // pre-provisioned foreign oid and tries to overwrite the rival's attempt
  // ref with it via raw git update-ref.  The parent test verifies that the
  // rival's DURABLE baseline_oid in the store is unchanged regardless of
  // whether the raw git update-ref succeeded.  The isolation invariant is
  // that durable state (not raw git refs) is the source of truth.
  const foreignOid = args["foreign-oid"];
  const rivalRef = `refs/rickgent/runs/${args["run-id"]}/attempts/${args["rival-attempt-id"]}`;
  let rivalRefWriteSucceeded = false;
  let rivalRefWriteError = null;
  try {
    git(args["repo"], "update-ref", rivalRef, foreignOid);
    rivalRefWriteSucceeded = true;
  } catch (error) {
    rivalRefWriteError = error instanceof Error ? error.message : String(error);
  }
  reply({
    type: "result",
    scenario: "foreign-commit",
    attemptId: args["attempt-id"],
    rivalAttemptId: args["rival-attempt-id"],
    foreignOid,
    rivalRef,
    rivalRefWriteSucceeded,
    rivalRefWriteError,
  });
}

function scenarioMoveDeliveryRef(leases, args) {
  const grant = acquireAttempt(leases, args["attempt-id"], args["idempotency-key"]);
  const provisioned = provisionAttemptWorkspace(leases, grant);
  if (!provisioned.ok) {
    throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  }
  const worktreePath = provisioned.workspace.worktreePath;
  const label = args["label"] ?? args["attempt-id"];
  mkdirSync(join(worktreePath, "src"), { recursive: true });
  writeFileSync(join(worktreePath, "src", "delivery.ts"), `export const delivery = ${JSON.stringify(label)};\n`, "utf8");
  execFileSync("git", ["-C", worktreePath, "add", "src/delivery.ts"]);
  execFileSync("git", ["-C", worktreePath, "commit", "-qm", `delivery:${label}`]);
  const newOid = git(worktreePath, "rev-parse", "HEAD");
  const deliveryRef = `refs/rickgent/runs/${args["run-id"]}/delivery`;
  const oldDeliveryOid = git(args["repo"], "rev-parse", "--verify", deliveryRef);
  git(args["repo"], "update-ref", deliveryRef, newOid);
  reply({
    type: "result",
    scenario: "move-delivery-ref",
    ownershipId: grant.ownership.ownershipId,
    attemptId: args["attempt-id"],
    deliveryRef,
    oldDeliveryOid,
    newDeliveryOid: newOid,
  });
}

function scenarioSpawnStubborn(args) {
  // Spawn a stubborn descendant tree that writes markers inside the attempt's
  // owned output directory.  The descendant's output is scoped to the owned
  // directory (the worker's cwd is the owned dir).  The parent test verifies
  // that the marker appears inside the owned dir and that the rival's output
  // directory is not mutated (the worker never writes outside the owned dir).
  const escapeMarkerPath = args["escape-marker-path"];
  const ownedOutputDir = args["owned-output-dir"];
  mkdirSync(ownedOutputDir, { recursive: true, mode: 0o700 });
  // Spawn a child that double-forks and writes markers inside the owned dir.
  const child = spawn(process.execPath, [
    "-e",
    `const { spawn } = require("node:child_process");
     const { writeFileSync } = require("node:fs");
     // Write the escape marker inside the owned output directory.
     try { writeFileSync(${JSON.stringify(escapeMarkerPath)}, "escaped\\n"); } catch (e) {}
     // Spawn a detached grandchild that also writes inside the owned dir.
     const grandchild = spawn(process.execPath, ["-e", \`
       const { writeFileSync } = require("node:fs");
       try { writeFileSync(${JSON.stringify(escapeMarkerPath)}, "escaped-by-grandchild\\n", { flag: "a" }); } catch (e) {}
     \`], { detached: true, stdio: "ignore" });
     grandchild.unref();
     process.exit(0);
    `,
  ], {
    cwd: ownedOutputDir,
    stdio: "ignore",
    detached: false,
  });
  child.unref();
  return new Promise((resolve) => {
    child.once("exit", () => {
      setTimeout(() => {
        reply({
          type: "result",
          scenario: "spawn-stubborn",
          attemptId: args["attempt-id"],
          escapeMarkerPath,
          ownedOutputDir,
        });
        resolve();
      }, 200);
    });
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reply({
        type: "result",
        scenario: "spawn-stubborn",
        attemptId: args["attempt-id"],
        escapeMarkerPath,
        ownedOutputDir,
        timeout: true,
      });
      resolve();
    }, 5_000);
  });
}

function scenarioFloodOutput(args) {
  const stdoutPath = args["stdout-path"];
  const stderrPath = args["stderr-path"];
  const floodBytes = parseInt(args["flood-bytes"] ?? "1048576", 10);
  const chunk = "x".repeat(Math.min(64 * 1024, floodBytes));
  let written = 0;
  while (written < floodBytes) {
    const remaining = floodBytes - written;
    const writeSize = Math.min(chunk.length, remaining);
    writeFileSync(stdoutPath, chunk.slice(0, writeSize), { flag: "a" });
    writeFileSync(stderrPath, chunk.slice(0, writeSize), { flag: "a" });
    written += writeSize;
  }
  reply({
    type: "result",
    scenario: "flood-output",
    attemptId: args["attempt-id"],
    stdoutPath,
    stderrPath,
    bytesWritten: written,
  });
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args["repo"];
  const scenario = args["scenario"];
  if (!repo || !scenario) {
    reply({ type: "error", code: "RICKGENT_CONCURRENCY_WORKER_ARGS", message: "--repo and --scenario are required" });
    process.exitCode = 1;
    return;
  }

  let store;
  try {
    // Scenarios that need the store + leases.
    if (scenario === "acquire-competing" || scenario === "acquire-distinct" ||
        scenario === "provision-overlapping" || scenario === "move-delivery-ref") {
      store = openStateStore({ repoPath: repo });
      const leases = new LeaseAuthority(store);
      switch (scenario) {
        case "acquire-competing": scenarioAcquireCompeting(leases, args); break;
        case "acquire-distinct": scenarioAcquireDistinct(leases, args); break;
        case "provision-overlapping": scenarioProvisionOverlapping(leases, args); break;
        case "move-delivery-ref": scenarioMoveDeliveryRef(leases, args); break;
      }
    } else if (scenario === "foreign-commit") {
      // foreign-commit does not need the store; it does a raw git update-ref.
      scenarioForeignCommit(args);
    } else if (scenario === "spawn-stubborn") {
      await scenarioSpawnStubborn(args);
    } else if (scenario === "flood-output") {
      scenarioFloodOutput(args);
    } else {
      reply({ type: "error", code: "RICKGENT_CONCURRENCY_WORKER_UNKNOWN_SCENARIO", message: `unknown scenario: ${scenario}` });
      process.exitCode = 1;
    }
  } catch (error) {
    reply({
      type: "error",
      code: error && typeof error === "object" && "code" in error ? error.code : "RICKGENT_CONCURRENCY_WORKER_ERROR",
      message: error instanceof Error ? error.message : String(error),
      scenario,
    });
    process.exitCode = 1;
  } finally {
    if (store) {
      try { store.close(); } catch {}
    }
  }
}

main().catch((error) => {
  reply({
    type: "error",
    code: "RICKGENT_CONCURRENCY_WORKER_FATAL",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
