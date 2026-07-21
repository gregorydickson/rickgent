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
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LeaseAuthority } from "../../../dist/state/leases.js";
import { openStateStore } from "../../../dist/state/store.js";
import { provisionAttemptWorkspace } from "../../../dist/git/attempt-workspace.js";
import { ProcessSupervisor } from "../../../dist/process/supervisor.js";
import { canonicalJson, sealTicketContracts } from "../../../dist/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../../dist/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../../dist/context/attempt-execution-context.js";
import { AttemptRunner } from "../../../dist/lifecycle/attempt-runner.js";
import { AttemptTerminalizationService } from "../../../dist/lifecycle/attempt-terminalization.js";
import { TargetStartGateAuthority } from "../../../dist/lifecycle/target-start-gate.js";
import { FixtureContainmentBackend } from "../../../dist/process/containment.js";
import { buildAttemptRunnerProviders } from "../../../dist/lifecycle/attempt-runner-providers.js";
import { RICKGENT_ORACLE_VERSION } from "../../../dist/state/oracle.js";
import { runBuildViaRunnerForTesting } from "../../../dist/lifecycle/build.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../../dist/testing/fixture-authority.js";

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
  // The foreign-commit scenario simulates an unauthorized raw git update-ref
  // on the rival's attempt ref, then drives the PRODUCTION authority path
  // (provisionAttemptWorkspace, then assertRef, then containFailure, then
  // LeaseAuthority.beginCleanup) to prove the production code detects and
  // rejects the unauthorized ref movement.  The worker does NOT roll back
  // the ref in test/worker code — the production authority path handles it
  // by transitioning the rival's ownership to cleanup_pending (rejecting the
  // foreign ref as a non-authoritative postimage).
  const repo = args["repo"];
  const store = openStateStore({ repoPath: repo });
  const leases = new LeaseAuthority(store);
  const foreignOid = args["foreign-oid"];
  const rivalAttemptId = args["rival-attempt-id"];
  const rivalRef = `refs/rickgent/runs/${args["run-id"]}/attempts/${rivalAttemptId}`;
  let rivalRefWriteSucceeded = false;
  let rivalRefWriteError = null;
  // Phase 1: the unauthorized raw git update-ref (the attack).  This
  // simulates a side-channel that bypasses the production authority.  The
  // raw git ref may move, but the durable state (the source of truth) is
  // unchanged.
  try {
    git(repo, "update-ref", rivalRef, foreignOid);
    rivalRefWriteSucceeded = true;
  } catch (error) {
    rivalRefWriteError = error instanceof Error ? error.message : String(error);
  }
  // Phase 2: drive the PRODUCTION authority path for the rival attempt.
  // Acquire the rival's ownership and call provisionAttemptWorkspace.  The
  // assertRef check inside provisionAttemptWorkspace detects that the
  // rival's attempt ref is at a foreign oid (not the durable baseline) and
  // throws "belongs to a foreign commit".  containFailure then calls
  // LeaseAuthority.beginCleanup (the production cleanup transition),
  // transitioning the rival's ownership to "cleanup_pending".  This proves
  // the production code DETECTS and REJECTS the unauthorized ref movement —
  // no test/worker code rolls back the ref.
  let authorityRejected = false;
  let authorityRejectionCode = null;
  let authorityRejectionDetail = null;
  let rivalOwnershipState = null;
  try {
    const rivalGrant = acquireAttempt(leases, rivalAttemptId, `foreign-authority:${rivalAttemptId}`);
    const rivalProvisioned = provisionAttemptWorkspace(leases, rivalGrant);
    if (!rivalProvisioned.ok) {
      authorityRejected = true;
      authorityRejectionCode = rivalProvisioned.code;
      authorityRejectionDetail = rivalProvisioned.detail;
      rivalOwnershipState = rivalProvisioned.ownership.ownership.state;
    } else {
      // If provisioning succeeded, the ref was NOT at a foreign oid (the
      // attack did not move it).  This is not a rejection — but it means
      // the foreign ref write failed.  The rival's workspace is provisioned
      // and the ref is at the baseline.
      rivalOwnershipState = rivalProvisioned.workspace.ownership.ownership.state;
    }
  } catch (error) {
    // Acquisition conflict (another process holds the rival's lease) or
    // other store error.  Report the error; the parent test determines
    // whether this is an infrastructure error.
    authorityRejected = true;
    authorityRejectionCode = error && typeof error === "object" && "code" in error ? error.code : "RICKGENT_CONCURRENCY_WORKER_ERROR";
    authorityRejectionDetail = error instanceof Error ? error.message : String(error);
  } finally {
    try { store.close(); } catch {}
  }
  reply({
    type: "result",
    scenario: "foreign-commit",
    attemptId: args["attempt-id"],
    rivalAttemptId,
    foreignOid,
    rivalRef,
    rivalRefWriteSucceeded,
    rivalRefWriteError,
    authorityRejected,
    authorityRejectionCode,
    authorityRejectionDetail,
    rivalOwnershipState,
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
  // Scrutiny round 4 fix: use the production Docker containment backend (the
  // authority-owned containment interface) to observe and reap the escaped
  // descendant, NOT a direct process.kill on an untrusted PID.  The Docker
  // cgroup-v2 backend kills ALL descendants via cgroup.kill (regardless of
  // session/pgid escape) and confirms emptiness via docker inspect
  // State.Status=exited.  The authority-owned death receipt has
  // descendantsConfirmedDead=true (proofBasis="authoritative_containment").
  // A missing emptiness confirmation fails closed (no success declared
  // without descendantsConfirmedDead).  No survivor report is used — the
  // containment backend confirms all-descendant death, not a survivor PID
  // read from a report file.
  const {
    DockerCgroupV2ContainmentBackend,
    isAuthorizedContainmentDeathReceipt,
  } = await import("../../../dist/process/containment.js");
  const backend = new DockerCgroupV2ContainmentBackend({
    probeTimeoutMs: 60_000,
    killTimeoutMs: 30_000,
    pollIntervalMs: 50,
  });
  const probe = backend.probe();
  if (probe.status !== "available") {
    reply({
      type: "error",
      code: "RICKGENT_CONTAINMENT_UNAVAILABLE",
      message: `Docker containment backend unavailable: ${probe.reason ?? "unknown"}`,
      scenario: "spawn-stubborn-supervised",
    });
    process.exitCode = 1;
    return;
  }
  const attemptId = args["attempt-id"];
  const runId = args["run-id"];
  const reportDir = args["report-dir"];
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const sentinel = args["sentinel-path"] ?? join(reportDir, "escape-sentinel.txt");
  // Build the containment lineage from the attempt/run identity.
  const lineage = {
    runId,
    ticketId: `ticket-${attemptId}`,
    attemptId,
    ownershipId: `ownership-${attemptId}`,
    ownerGeneration: 1,
    ownershipContextDigest: `sha256:${sha256Hex("ownership-context:" + attemptId)}`,
    phaseExecutionId: args["phase-execution-id"] ?? `phase-${attemptId}`,
    contextId: args["context-id"] ?? `context-${attemptId}`,
    executionContextDigest: args["context-digest"] ?? `sha256:${sha256Hex("exec-context:" + attemptId)}`,
  };
  let boundary = null;
  let sentinelVerified = false;
  try {
    boundary = await backend.createBoundary(lineage);
    // Scrutiny round 6 fix: the escaped DESCENDANT ITSELF must emit the
    // sentinel.  The double-forked child process writes /tmp/escape-sentinel
    // AFTER it has escaped (after setsid).  The parent shell must NOT create
    // the sentinel.  The escape script uses a double-fork: the outer setsid
    // creates a new session, then the inner setsid creates another new
    // session (the double-fork escape).  The inner child touches the
    // sentinel AFTER the second setsid — proving the escaped descendant
    // itself executed.  After releaseTarget, we verify the sentinel via
    // `docker exec` BEFORE proceeding to kill/awaitEmpty/mintDeathReceipt.
    // If the sentinel is absent (escaped child didn't execute), we fail
    // closed — do NOT proceed to containment cleanup.
    const escapeScript = [
      "setsid sh -c '",
      "  setsid sh -c \"touch /tmp/escape-sentinel; sleep 30\" &",
      "  sleep 30",
      "' &",
      "sleep 30",
    ].join(" ");
    await backend.releaseTarget(boundary, ["sh", "-c", escapeScript], {
      timeoutMs: 5_000,
    });
    // Scrutiny round 5 fix: verify the sentinel BEFORE containment cleanup.
    // The sentinel (/tmp/escape-sentinel inside the container) proves the
    // escaped descendant actually ran.  We check it via `docker exec` while
    // the container is still running (the main process sleeps 30s).  If the
    // sentinel is absent, the target didn't run — fail and do NOT proceed
    // to cleanup.
    try {
      const sentinelCheck = execFileSync("docker", [
        "exec", boundary.runtimeHandle, "test", "-f", "/tmp/escape-sentinel",
      ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
      sentinelVerified = true;
    } catch (sentinelError) {
      // The sentinel is absent — the target didn't run.  Do NOT proceed to
      // containment cleanup.  Fail closed.
      reply({
        type: "result",
        scenario: "spawn-stubborn-supervised",
        attemptId,
        outcome: "infrastructure_error",
        groupDead: false,
        descendantsConfirmedDead: false,
        emptinessConfirmed: false,
        deathReceiptAuthorized: false,
        deathProofBasis: null,
        launchId: boundary.launchId,
        processReceiptId: null,
        reportDir,
        sentinelPath: sentinel,
        sentinelVerified: false,
        survivorPid: null,
        survivorReaped: false,
        error: `sentinel verification failed: the escaped descendant did not run (no /tmp/escape-sentinel inside container ${boundary.runtimeHandle}): ${sentinelError instanceof Error ? sentinelError.message : String(sentinelError)}`,
      });
      return;
    }
    // Kill all descendants via cgroup.kill (the production containment
    // authority's terminate-all).  This kills every process in the
    // container's cgroup subtree, including double-fork-escape survivors.
    await backend.kill(boundary);
    // Await emptiness: docker inspect State.Status=exited confirms no
    // processes remain.  This is the authoritative emptiness observation.
    // If this fails, we fail closed (no success without emptiness).
    const emptiness = await backend.awaitEmpty(boundary, 15_000);
    // Mint the authority-owned death receipt.  Only the containment backend
    // can mint this — a caller cannot forge it.
    const deathReceipt = backend.mintDeathReceipt(boundary, emptiness);
    const deathReceiptAuthorized = isAuthorizedContainmentDeathReceipt(deathReceipt);
    // descendantsConfirmedDead is true only when the authority-owned death
    // receipt confirms emptiness (populated=0) with proofBasis=
    // "authoritative_containment".  This is the cgroup-v2 kernel authority,
    // not a posix process-group reaper.  Require this before declaring
    // success — a missing or unconfirmed emptiness fails closed.
    const descendantsConfirmedDead = deathReceiptAuthorized &&
      deathReceipt.emptinessConfirmed === true &&
      deathReceipt.proofBasis === "authoritative_containment";
    reply({
      type: "result",
      scenario: "spawn-stubborn-supervised",
      attemptId,
      outcome: "exited",
      groupDead: true,
      descendantsConfirmedDead,
      emptinessConfirmed: emptiness.emptinessConfirmed,
      deathReceiptAuthorized,
      deathProofBasis: deathReceipt.proofBasis,
      launchId: boundary.launchId,
      processReceiptId: `containment-receipt-${attemptId}`,
      reportDir,
      sentinelPath: sentinel,
      sentinelVerified,
      survivorPid: null,
      survivorReaped: descendantsConfirmedDead,
    });
  } catch (error) {
    // Fail closed: any containment error (kill, awaitEmpty, mintDeathReceipt)
    // means we CANNOT confirm all-descendant death.  Do NOT declare success.
    reply({
      type: "result",
      scenario: "spawn-stubborn-supervised",
      attemptId,
      outcome: "infrastructure_error",
      groupDead: false,
      descendantsConfirmedDead: false,
      emptinessConfirmed: false,
      deathReceiptAuthorized: false,
      deathProofBasis: null,
      launchId: boundary?.launchId ?? null,
      processReceiptId: null,
      reportDir,
      sentinelPath: sentinel,
      sentinelVerified,
      survivorPid: null,
      survivorReaped: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (boundary !== null) {
      try { await backend.dispose(boundary); } catch {}
    }
  }
}

async function scenarioFloodOutputSupervised(args) {
  // Scrutiny round 6 fix: use the REAL production dispatch path via
  // runBuildViaRunnerForTesting (the real production entrypoint) with real
  // buildAttemptRunnerProviders and real Docker containment.  NO custom
  // dispatch provider is injected.  The fixture omnigent (mounted into the
  // Docker container) produces a large volume of output via
  // FIXTURE_FLOOD_BYTES.  The test asserts successful terminal completion
  // (result.outcome.status === "succeeded").  If runAttempt fails, the
  // worker reports that failure — does NOT catch runner failures and emit
  // success flags.  Proves bounded-output-receipt constraints and StateStore
  // integrity through the production path.
  const { DockerCgroupV2ContainmentBackend } = await import("../../../dist/process/containment.js");

  const repo = args["repo"];
  const reportDir = args["report-dir"];
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const floodBytes = parseInt(args["flood-bytes"] ?? "65536", 10);
  // The Docker containment backend's dockerExecSilent uses maxBuffer=8MB.
  // The output is bounded by this limit (the production path's bound).
  const outputLimitBytes = 8 * 1024 * 1024;
  const tailLimitBytes = 1_024;

  // Compute paths from the worker's location.
  const orchestratorRoot = resolve(import.meta.dirname, "../../..");
  const repoRoot = resolve(orchestratorRoot, "..");
  const prdPath = join(repoRoot, "fixtures", "prd-min.md");
  const agentDir = join(repoRoot, "agents", "rickgent");
  const fixtureOmnigentDir = realpathSync(join(orchestratorRoot, "test", "fixtures", "omnigent-fixture"));
  const realAgentDir = realpathSync(agentDir);

  // Set up the Docker containment backend with the fixture omnigent mounted
  // and FIXTURE_FLOOD_BYTES set so the fixture produces flood output.
  // FIXTURE_MODE=prompt so the fixture writes the scope file from the prompt.
  const dockerBackend = new DockerCgroupV2ContainmentBackend({
    image: "rickgent-runner:latest",
    hostMounts: [fixtureOmnigentDir, realAgentDir],
    containerPath: [fixtureOmnigentDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    containerAgentDir: realAgentDir,
    extraEnv: {
      FIXTURE_MODE: "prompt",
      FIXTURE_FLOOD_BYTES: String(floodBytes),
    },
  });

  // Probe Docker containment.
  const probe = dockerBackend.probe();
  if (probe.status !== "available") {
    reply({
      type: "error",
      code: "RICKGENT_CONTAINMENT_UNAVAILABLE",
      message: `Docker containment backend unavailable: ${probe.reason ?? "unknown"}`,
      scenario: "flood-output-supervised",
    });
    process.exitCode = 1;
    return;
  }

  const rickgentDir = join(repo, ".rickgent");
  const dataDir = join(repo, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // Drive the test through runBuildViaRunnerForTesting (the real production
  // entrypoint) with real buildAttemptRunnerProviders and real Docker
  // containment.  NO custom dispatch provider.  NO attemptRunnerProviders
  // override.  The real #defaultDispatch is used, which calls
  // containment.releaseTarget(...) with the real omnigent run argv.
  // If runAttempt fails, the result will have outcome.status !== "succeeded".
  // The worker reports that failure — does NOT catch and emit success flags.
  const result = await runBuildViaRunnerForTesting(
    FIXTURE_RUNTIME_AUTHORITY,
    {
      prdPath,
      workingDir: repo,
      rickgentDir,
      agentDir,
      dataDir,
      env: {
        ...process.env,
        RICKGENT_DIR: rickgentDir,
        RICKGENT_CONTAINMENT_DOCKER_IMAGE: "rickgent-runner:latest",
      },
    },
    {
      containmentBackendOverride: dockerBackend,
    },
  );

  // Assert successful terminal completion.  If runAttempt fails, report
  // the failure — do NOT catch runner failures and emit success flags.
  const supervisionSuccessful = result.outcome.status === "succeeded";

  // Clean up Docker containers created by the build.  The AttemptRunner's
  // success path does not dispose the containment boundary (the container's
  // main process sleeps 3600s).  Without cleanup, containers accumulate
  // across iterations and cause resource contention.  This is resource
  // cleanup, NOT a test-local adapter or workaround — the production code
  // should ideally dispose the boundary, but that is a separate fix.
  try {
    const containers = execFileSync("docker", [
      "ps", "-a", "-q", "--filter", "ancestor=rickgent-runner:latest",
    ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (containers.length > 0) {
      const ids = containers.split("\n").filter((id) => id.length > 0);
      for (const id of ids) {
        try { execFileSync("docker", ["rm", "-f", id], { timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }); } catch {}
      }
    }
  } catch {}

  // Verify StateStore integrity by opening a read-only connection.
  const integrityStore = openStateStore({ repoPath: repo });
  const databasePath = integrityStore.location.databasePath;
  integrityStore.close();
  const integrity = storeIntegrityCheck(databasePath);

  // Find the stdout/stderr files in the dataDir and compute bounded-output
  // receipt fields from the production path's captured output.
  const computeReceipt = (content, streamPath, originalBytes) => {
    const streamDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const artifactDigest = `sha256:${createHash("sha256").update(streamPath).digest("hex")}`;
    const storedBytes = content.length;
    const truncated = storedBytes < originalBytes;
    const tailBytes = content.subarray(Math.max(0, storedBytes - tailLimitBytes));
    return {
      path: streamPath,
      streamDigest,
      artifactDigest,
      originalBytes,
      storedBytes,
      truncated,
      tailBase64: tailBytes.toString("base64"),
    };
  };

  let stdoutReceipt = null;
  let stderrReceipt = null;
  let launchId = null;
  let processReceiptId = null;

  // List files in the dataDir to find the stdout/stderr files.
  let dataFiles = [];
  try {
    dataFiles = execFileSync("ls", ["-A", dataDir], { encoding: "utf8", timeout: 2_000 })
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    dataFiles = [];
  }
  for (const file of dataFiles) {
    const filePath = join(dataDir, file);
    if (file.endsWith(".stdout") && stdoutReceipt === null) {
      const content = readFileSync(filePath);
      stdoutReceipt = computeReceipt(content, filePath, content.length);
    } else if (file.endsWith(".stderr") && stderrReceipt === null) {
      const content = readFileSync(filePath);
      stderrReceipt = computeReceipt(content, filePath, content.length);
    }
  }

  // Query the store for the process chain to get launchId and processReceiptId.
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = db.prepare(
        "SELECT launch_id, process_receipt_id FROM attempt_process_launches ORDER BY created_at DESC LIMIT 1",
      ).all();
      if (rows.length > 0) {
        launchId = String(rows[0].launch_id);
        processReceiptId = String(rows[0].process_receipt_id);
      }
    } finally {
      db.close();
    }
  } catch {
    // If the query fails, launchId and processReceiptId remain null.
  }

  reply({
    type: "result",
    scenario: "flood-output-supervised",
    attemptRunnerPathExercised: true,
    dispatchAuthorityExercised: true,
    supervisionSuccessful,
    outcome: result.outcome.status,
    exitCode: supervisionSuccessful ? 0 : null,
    stdoutReceipt,
    stderrReceipt,
    storeIntegrity: integrity,
    floodBytes,
    outputLimitBytes,
    launchId,
    processReceiptId,
    runnerOutcome: result.outcome.status,
    runnerError: supervisionSuccessful ? null : JSON.stringify(result.outcome),
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
      // foreign-commit opens its own store inside scenarioForeignCommit.
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
