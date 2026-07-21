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
 *   spawn-stubborn-supervised
 *                       Spawn a stubborn descendant tree (double-fork-escape)
 *                       through the ProcessSupervisor; observe and reap the
 *                       detached grandchild; report groupDead,
 *                       descendantsConfirmedDead, survivorPid, survivorReaped.
 *   flood-output          Write a large volume to the attempt's stdout/stderr
 *                         paths; report the bytes written.
 *   flood-output-supervised
 *                       Run the output-flood fixture through the
 *                       ProcessSupervisor so output is captured by the
 *                       bounded-output sinks; report the BoundedOutputReceipt
 *                       fields for stdout/stderr and the StateStore integrity
 *                       (quick_check / foreign_key_check) result.
 *
 * All scenarios report via process.send with { type: "result", ... } on
 * success or { type: "error", code, message } on failure.  The parent test
 * treats an unexpected error as an infrastructure error (not a caught race).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LeaseAuthority } from "../../../dist/state/leases.js";
import { openStateStore } from "../../../dist/state/store.js";
import { provisionAttemptWorkspace } from "../../../dist/git/attempt-workspace.js";
import { ProcessSupervisor } from "../../../dist/process/supervisor.js";
import { canonicalJson } from "../../../dist/contracts/ticket-contract.js";

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
// Supervised fixture helper.
//
// The supervised scenarios (spawn-stubborn-supervised, flood-output-supervised)
// route process execution through the real ProcessSupervisor so that:
//   - output is captured by the BoundedOutputSink (bounded-output receipts),
//   - the process tree is observed and reaped by the PosixProcessController,
//   - the durable StateStore records the launch + terminal observations.
//
// The worker opens the shared StateStore against the disposable repo, ensures
// the execution_contexts / phase_executions rows the launch foreign-keys
// reference are present, acquires ownership, provisions the workspace, and
// constructs the ProcessSupervisor.  The parent test seeds the repo (runs,
// tickets, attempts) and passes the attempt id + phase identity; the worker
// seeds the phase/context rows if they are not already present so the
// supervised launch's foreign keys resolve.
// ---------------------------------------------------------------------------

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ensurePhaseContext(store, args) {
  const attemptId = args["attempt-id"];
  const contextId = args["context-id"] ?? `context-${attemptId}`;
  const phaseExecutionId = args["phase-execution-id"] ?? `phase-${attemptId}`;
  const contextDigest = args["context-digest"] ?? `sha256:${sha256Hex(canonicalJson({ attempt_id: attemptId, phase: "implement" }))}`;
  const now = new Date().toISOString();
  const db = new DatabaseSync(store.location.databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const ctxRow = db.prepare("SELECT 1 FROM execution_contexts WHERE context_id = ? AND attempt_id = ?").get(contextId, attemptId);
    if (ctxRow === undefined) {
      const contextJson = canonicalJson({
        schema_version: "rickgent.execution-context/v1",
        attempt_id: attemptId,
        phase: "implement",
        phase_ordinal: 0,
        role: "worker",
      });
      const contractDigest = db.prepare("SELECT contract_digest FROM attempts WHERE attempt_id = ?").get(attemptId).contract_digest;
      const capabilityDigest = db.prepare("SELECT capability_snapshot_digest FROM attempts WHERE attempt_id = ?").get(attemptId).capability_snapshot_digest;
      db.prepare(
        `INSERT INTO execution_contexts (context_id, context_digest, attempt_id, phase, phase_ordinal, role, canonical_context_json, contract_digest, capability_snapshot_digest, policy_bundle_digest, model_selection_digest, budget_digest, scope_digest, context_schema_version, oracle_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        contextId,
        contextDigest,
        attemptId,
        "implement",
        0,
        "worker",
        contextJson,
        contractDigest,
        capabilityDigest,
        `sha256:${sha256Hex("policy:" + attemptId)}`,
        `sha256:${sha256Hex("model:" + attemptId)}`,
        `sha256:${sha256Hex("budget:" + attemptId)}`,
        `sha256:${sha256Hex("scope:" + attemptId)}`,
        "rickgent.execution-context/v1",
        "rickgent.oracle.v2",
        now,
      );
    }
    const phaseRow = db.prepare("SELECT 1 FROM phase_executions WHERE phase_execution_id = ? AND attempt_id = ?").get(phaseExecutionId, attemptId);
    if (phaseRow === undefined) {
      db.prepare(
        `INSERT INTO phase_executions (phase_execution_id, attempt_id, context_id, phase, phase_ordinal, role, identity_digest, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        phaseExecutionId,
        attemptId,
        contextId,
        "implement",
        0,
        "worker",
        `sha256:${sha256Hex("phase:" + attemptId)}`,
        now,
      );
    }
  } finally {
    db.close();
  }
  return { contextId, phaseExecutionId, contextDigest };
}

function setupSupervisedFixture(args) {
  const repo = args["repo"];
  const store = openStateStore({ repoPath: repo });
  const phase = ensurePhaseContext(store, args);
  const leases = new LeaseAuthority(store);
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: args["attempt-id"],
    idempotencyKey: args["idempotency-key"],
    ttlMs: 60_000,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) {
    throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  }
  const supervisor = new ProcessSupervisor(store, leases);
  return {
    store,
    leases,
    supervisor,
    ownership: provisioned.workspace.ownership,
    authorization: provisioned.authorization,
    phase,
  };
}

function supervisedRequest(fixture, argv, overrides = {}) {
  return {
    ownership: fixture.ownership,
    authorization: fixture.authorization,
    phase: {
      phaseExecutionId: fixture.phase.phaseExecutionId,
      contextId: fixture.phase.contextId,
      contextDigest: fixture.phase.contextDigest,
    },
    argv,
    environment: {},
    allowedEnvironmentKeys: [],
    timeoutMs: 5_000,
    terminationGraceMs: 200,
    deathObservationMs: 800,
    outputLimitBytes: 8_192,
    tailLimitBytes: 1_024,
    ...overrides,
  };
}

function storeIntegrityCheck(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const quick = db.prepare("PRAGMA quick_check").get();
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    return {
      quick_check: quick && typeof quick === "object" ? String(quick.quick_check ?? quick[Object.keys(quick)[0]] ?? "") : String(quick),
      foreign_key_check_violations: Array.isArray(fk) ? fk.length : 0,
    };
  } finally {
    db.close();
  }
}

async function scenarioSpawnStubbornSupervised(args) {
  const fixture = setupSupervisedFixture(args);
  try {
    const reportDir = args["report-dir"];
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const sentinel = args["sentinel-path"] ?? join(reportDir, "escape-sentinel.txt");
    const stubbornFixture = args["stubborn-fixture"];
    if (!stubbornFixture || !existsSync(stubbornFixture)) {
      throw new Error(`--stubborn-fixture is required and must exist: ${String(stubbornFixture)}`);
    }
    const result = await fixture.supervisor.run(supervisedRequest(fixture, [
      process.execPath,
      stubbornFixture,
      "double-fork-escape",
      "--report-dir",
      reportDir,
      "--lifetime-ms",
      "3000",
      "--mutation-delay-ms",
      "200",
      "--sentinel",
      sentinel,
    ], {
      timeoutMs: 4_000,
      deathObservationMs: 1_000,
    }));
    // Read the survivor report written by the double-fork-escape fixture.
    let survivorPid = null;
    let survivorReaped = false;
    const survivorReportPath = join(reportDir, "escape-survivor.json");
    if (existsSync(survivorReportPath)) {
      try {
        const survivorReport = JSON.parse(readFileSync(survivorReportPath, "utf8"));
        survivorPid = Number(survivorReport.pid ?? null);
      } catch {}
    }
    // Reap the detached grandchild: the ProcessSupervisor's posix reaper
    // kills the process GROUP but a double-fork-escape survivor detaches into
    // its own session, so the supervisor honestly reports
    // descendantsConfirmedDead=false.  The worker explicitly kills and
    // verifies the survivor to prove the detached descendant is reaped.
    if (survivorPid !== null && Number.isSafeInteger(survivorPid) && survivorPid > 0) {
      try { process.kill(survivorPid, "SIGKILL"); } catch {}
      // Wait briefly for the kernel to reap, then verify ESRCH.
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(survivorPid, 0);
        survivorReaped = false;
      } catch (error) {
        survivorReaped = error instanceof Error && /ESRCH|No such process/.test(error.message);
      }
    } else {
      survivorReaped = true; // no survivor to reap
    }
    reply({
      type: "result",
      scenario: "spawn-stubborn-supervised",
      attemptId: args["attempt-id"],
      outcome: result.outcome,
      groupDead: result.groupDead,
      descendantsConfirmedDead: result.descendantsConfirmedDead,
      exitCode: result.exitCode,
      pid: result.pid,
      survivorPid,
      survivorReaped,
      reportDir,
      sentinelPath: sentinel,
      launchId: result.launchId,
      processReceiptId: result.processReceiptId,
    });
  } finally {
    try { fixture.store.close(); } catch {}
  }
}

async function scenarioFloodOutputSupervised(args) {
  const fixture = setupSupervisedFixture(args);
  try {
    const reportDir = args["report-dir"];
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const floodFixture = args["flood-fixture"];
    if (!floodFixture || !existsSync(floodFixture)) {
      throw new Error(`--flood-fixture is required and must exist: ${String(floodFixture)}`);
    }
    const floodBytes = parseInt(args["flood-bytes"] ?? "65536", 10);
    const outputLimitBytes = parseInt(args["output-limit-bytes"] ?? "4096", 10);
    const result = await fixture.supervisor.run(supervisedRequest(fixture, [
      process.execPath,
      floodFixture,
      "simultaneous",
      "--report-dir",
      reportDir,
      "--bytes",
      String(floodBytes),
    ], {
      timeoutMs: 10_000,
      outputLimitBytes,
      tailLimitBytes: Math.min(1_024, outputLimitBytes),
    }));
    // The supervisor captures stdout/stderr via BoundedOutputSink and produces
    // BoundedOutputReceipts.  Report the receipt fields so the parent test can
    // assert bounded-output-receipt constraints.
    const stdoutReceipt = result.stdout === null ? null : {
      path: result.stdout.path,
      streamDigest: result.stdout.streamDigest,
      artifactDigest: result.stdout.artifactDigest,
      originalBytes: result.stdout.originalBytes,
      storedBytes: result.stdout.storedBytes,
      truncated: result.stdout.truncated,
      tailBase64: result.stdout.tailBase64,
    };
    const stderrReceipt = result.stderr === null ? null : {
      path: result.stderr.path,
      streamDigest: result.stderr.streamDigest,
      artifactDigest: result.stderr.artifactDigest,
      originalBytes: result.stderr.originalBytes,
      storedBytes: result.stderr.storedBytes,
      truncated: result.stderr.truncated,
      tailBase64: result.stderr.tailBase64,
    };
    const integrity = storeIntegrityCheck(fixture.store.location.databasePath);
    reply({
      type: "result",
      scenario: "flood-output-supervised",
      attemptId: args["attempt-id"],
      outcome: result.outcome,
      groupDead: result.groupDead,
      descendantsConfirmedDead: result.descendantsConfirmedDead,
      exitCode: result.exitCode,
      stdoutReceipt,
      stderrReceipt,
      storeIntegrity: integrity,
      floodBytes,
      outputLimitBytes,
      launchId: result.launchId,
      processReceiptId: result.processReceiptId,
    });
  } finally {
    try { fixture.store.close(); } catch {}
  }
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
    } else if (scenario === "spawn-stubborn-supervised") {
      // setupSupervisedFixture opens/closes its own store.
      await scenarioSpawnStubbornSupervised(args);
    } else if (scenario === "flood-output") {
      scenarioFloodOutput(args);
    } else if (scenario === "flood-output-supervised") {
      await scenarioFloodOutputSupervised(args);
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
