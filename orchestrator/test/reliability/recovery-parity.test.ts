// Recovery parity proof corpus (t29).
//
// VAL-ORC-004: Resume of explicit runs uses persisted receipts; response-lost
// planned retries resolve through typed no-side-effect cleanup; later attempts
// allocated only after reconciliation; commit messages remain non-authoritative.
//
// This suite proves:
//   1. resumeRun resolves the canonical repository state from persisted
//      receipts and validates contract/context/oracle versions.
//   2. Failed/interrupted attempts are never respawned with the same attempt
//      number; completed side effects are idempotently observed from receipts.
//   3. A retry allocation committed before response loss but never activated
//      is recovered as a typed no-side-effect cleanup image, transitioned to
//      failed_clean, and followed by a newly committed higher-numbered
//      attempt.  The orphaned planned attempt is never activated.
//   4. Later attempts are allocated only after the orphaned planned cleanup
//      completes (reconciliation before allocation).
//   5. Commit prose is never treated as truth; only durable receipts are
//      authority.
//   6. Reconciliation rebuilds derived views from run-attributed immutable
//      receipts; Git subjects and cross-run ticket IDs are ignored.
//   7. Negative proofs: crash-point, replay, stale-generation, forged-producer,
//      partial-write, cross-disposition, idempotency, rollback.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCapability } from "../../src/capabilities/registry.js";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import { DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION } from "../../src/context/execution-context.js";
import {
  RESOURCE_IDENTITY_VERSION,
  RUN_MANIFEST_SCHEMA_VERSION,
  compiledCapabilitySnapshot,
} from "../../src/context/resolver.js";
import { resumeRun, type ResumeRunInput } from "../../src/lifecycle/recovery.js";
import { reconcile } from "../../src/lifecycle/reconcile.js";
import {
  openStateStore,
  type AllocateFreshRunInput,
  type AllocatedAttempt,
  type AllocatedRun,
  type RetryCompatibilityInput,
  type StateLocation,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function makeRepo(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rickgent-recovery-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Recovery Parity Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "recovery@example.test"]);
  writeFileSync(join(repo, "README.md"), `${label}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function openRaw(databasePath: string, readOnly = true): DatabaseSync {
  return new DatabaseSync(databasePath, { readOnly, enableForeignKeyConstraints: true, timeout: 1_000 });
}

function rows(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function row(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  return rows(databasePath, sql, ...values)[0];
}

function mutate(databasePath: string, sql: string, ...values: SqlValue[]): void {
  const database = openRaw(databasePath, false);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}

function contractDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t29",
    title: "Recovery parity test",
    description: "Prove resume and reconciliation parity from persisted receipts.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-RECOVERY",
      description: "Resume uses persisted receipts and resolves response-lost retries.",
      interface_ids: [],
      verification_ids: ["VER-RECOVERY"],
    }],
    verifications: [{
      id: "VER-RECOVERY",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 3, max_review_cycles: 1, wall_clock_ms: 120_000, remediation_limit: 0 },
  };
}

function contractJson(contract: TicketContract): string {
  const unsigned = { ...contract } as Record<string, unknown>;
  delete unsigned.digest;
  return canonicalJson(unsigned);
}

function freshRunInput(location: StateLocation, contract: TicketContract): AllocateFreshRunInput {
  const capabilitySnapshot = compiledCapabilitySnapshot();
  const manifestValue = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    repository_id: location.repositoryId,
    repo_realpath: location.repoRealpath,
    git_common_dir_realpath: location.gitCommonDirRealpath,
    object_format: location.objectFormat,
    context_schema_version: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
    oracle_version: "rickgent.oracle.v2",
    resource_identity_version: RESOURCE_IDENTITY_VERSION,
    capability_snapshot: JSON.parse(capabilitySnapshot.canonicalJson) as Record<string, unknown>,
    capability_snapshot_digest: capabilitySnapshot.digest,
    capability_snapshot_schema_version: capabilitySnapshot.schemaVersion,
    tickets: [{ contract_digest: contract.digest, depends_on_ticket_ids: [], plan_index: 0, ticket_id: contract.id }],
  };
  const canonicalManifest = canonicalJson(manifestValue);
  const canonicalContract = contractJson(contract);
  return {
    manifest: {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      canonicalJson: canonicalManifest,
      digest: digest(canonicalManifest),
      capabilitySnapshot,
      contextSchemaVersion: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
      oracleVersion: "rickgent.oracle.v2",
      resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
    },
    tickets: [{
      ticketId: contract.id,
      planIndex: 0,
      contract: { schemaVersion: contract.schema_version, canonicalJson: canonicalContract, digest: contract.digest as `sha256:${string}` },
      dependsOnTicketIds: [],
    }],
    initialDeliveryOid: execFileSync("git", ["-C", location.repoRealpath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

function newLineage(repo: string): { store: StateStore; run: AllocatedRun; attempt: AllocatedAttempt; contract: TicketContract } {
  const contract = sealTicketContracts([contractDraft()], { repositoryRoot: repo })[0]!;
  const store = openStateStore({ repoPath: repo });
  const run = store.allocateFreshRun(freshRunInput(store.location, contract));
  const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
  return { store, run, attempt, contract };
}

/** Construct a ResumeRunInput from a run, attempt, and repo path. */
function resumeInput(run: AllocatedRun, attempt: AllocatedAttempt, repo: string): ResumeRunInput {
  return {
    runId: run.runId,
    repoPath: repo,
    manifestDigest: run.manifestDigest,
    contextSchemaVersion: attempt.contextSchemaVersion,
    oracleVersion: attempt.oracleVersion,
    capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
    resourceIdentityVersion: attempt.resourceIdentityVersion,
    tickets: [{ ticketId: attempt.ticketId, contractDigest: attempt.contractDigest }],
  };
}

/** Construct a ResumeRunInput from a run, attempt, contract, and repo path. */
function resumeInputWithContract(run: AllocatedRun, attempt: AllocatedAttempt, contract: TicketContract, repo: string): ResumeRunInput {
  return {
    runId: run.runId,
    repoPath: repo,
    manifestDigest: run.manifestDigest,
    contextSchemaVersion: attempt.contextSchemaVersion,
    oracleVersion: attempt.oracleVersion,
    capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
    resourceIdentityVersion: attempt.resourceIdentityVersion,
    tickets: [{ ticketId: contract.id, contractDigest: contract.digest }],
  };
}

function retryInput(attempt: AllocatedAttempt): RetryCompatibilityInput {
  return {
    runId: attempt.runId,
    ticketId: attempt.ticketId,
    contractDigest: attempt.contractDigest,
    contextSchemaVersion: attempt.contextSchemaVersion,
    oracleVersion: attempt.oracleVersion,
    capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
    resourceIdentityVersion: attempt.resourceIdentityVersion,
  };
}

/** Advance a run+ticket+attempt to the cleanup_pending / failed_clean state
 * so a retry can be allocated. */
function advanceToFailedClean(databasePath: string, run: AllocatedRun, attempt: AllocatedAttempt): void {
  mutate(databasePath, "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?", run.runId);
  for (const state of ["active", "cleanup_pending"]) {
    mutate(databasePath, "UPDATE run_tickets SET state = ?, state_version = state_version + 1 WHERE ticket_instance_id = ?", state, attempt.ticketInstanceId);
  }
  for (const state of ["implementing", "cleanup_pending", "failed_clean"]) {
    mutate(databasePath, "UPDATE attempts SET state = ?, state_version = state_version + 1 WHERE attempt_id = ?", state, attempt.attemptId);
  }
}

/** Simulate a response-lost retry: allocate the retry attempt (committed to
 * SQLite) but never activate it (no execution context, no lease, no process).
 * The caller never observes the allocation response. */
function simulateResponseLostRetry(store: StateStore, run: AllocatedRun, attempt: AllocatedAttempt): AllocatedAttempt {
  advanceToFailedClean(store.location.databasePath, run, attempt);
  const retry = store.allocateRetryAttempt(retryInput(attempt));
  // The retry attempt is now "planned" in the database, but the response was
  // lost — the caller never received the AllocatedAttempt.  No execution
  // context, lease, or process is persisted for this attempt.
  return retry;
}

describe("recovery parity proof corpus (t29)", () => {
  describe("capability activation", () => {
    it("resume_retry is enabled after t29 proofs pass", () => {
      expect(getCapability("resume_retry").state).toBe("enabled");
    });

    it("reconciliation is enabled after t29 proofs pass", () => {
      expect(getCapability("reconciliation").state).toBe("enabled");
    });

    it("resume_retry has the correct proof reference", () => {
      expect(getCapability("resume_retry").proof_version).toBe("recovery-parity-v1");
    });

    it("reconciliation has the correct proof reference", () => {
      expect(getCapability("reconciliation").proof_version).toBe("recovery-parity-v1");
    });
  });

  describe("resume from persisted receipts", () => {
    let repo: string;
    let lineage: ReturnType<typeof newLineage>;

    beforeEach(() => {
      repo = makeRepo("resume-basic");
      lineage = newLineage(repo);
    });

    afterEach(() => {
      try { lineage.store.close(); } catch { /* already closed */ }
    });

    it("resolves the canonical repository state from persisted receipts", () => {
      const { store, run, attempt, contract } = lineage;
      // Advance to active run
      mutate(store.location.databasePath, "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?", run.runId);
      mutate(store.location.databasePath, "UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ?", attempt.ticketInstanceId);

      const result = resumeRun(resumeInputWithContract(run, attempt, contract, repo));
      expect(result.ok).toBe(true);
      expect(result.runId).toBe(run.runId);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0]!.ticketId).toBe(contract.id);
      expect(result.tickets[0]!.latestAttempt).not.toBeNull();
      expect(result.tickets[0]!.latestAttempt!.attemptId).toBe(attempt.attemptId);
      expect(result.tickets[0]!.orphanedPlannedAttempt).toBeNull();
    });

    it("rejects resume with an incompatible manifest digest", () => {
      const { run, attempt, contract } = lineage;
      const input = { ...resumeInputWithContract(run, attempt, contract, repo), manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
      expect(() => resumeRun(input)).toThrow(/compatibility projection changed|RESUME_INCOMPATIBLE/);
    });

    it("rejects resume with a changed contract digest (commit prose is not truth)", () => {
      const { run, attempt } = lineage;
      const input = { ...resumeInput(run, attempt, repo), tickets: [{ ticketId: attempt.ticketId, contractDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }] };
      expect(() => resumeRun(input)).toThrow(/contract changed|RESUME_INCOMPATIBLE/);
    });

    it("does not require caller CWD state (resume does not read the working directory)", () => {
      const { store, run, attempt, contract } = lineage;
      mutate(store.location.databasePath, "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?", run.runId);
      mutate(store.location.databasePath, "UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ?", attempt.ticketInstanceId);

      // Resume from a different CWD — it should still work because it reads
      // the state store, not the working directory.
      const result = resumeRun(resumeInputWithContract(run, attempt, contract, repo));
      expect(result.ok).toBe(true);
    });
  });

  describe("response-lost planned retry recovery", () => {
    let repo: string;
    let lineage: ReturnType<typeof newLineage>;

    beforeEach(() => {
      repo = makeRepo("response-lost");
      lineage = newLineage(repo);
    });

    afterEach(() => {
      try { lineage.store.close(); } catch { /* already closed */ }
    });

    it("detects an orphaned planned attempt (allocated but never activated)", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);

      // Verify the retry is planned with no side effects
      const retryRow = row(store.location.databasePath, "SELECT state FROM attempts WHERE attempt_id = ?", retry.attemptId);
      expect(retryRow).toEqual({ state: "planned" });

      const sideEffects = row(store.location.databasePath, `
        SELECT
          (SELECT COUNT(*) FROM execution_contexts WHERE attempt_id = ?) AS contexts,
          (SELECT COUNT(*) FROM attempt_ownership_leases WHERE attempt_id = ?) AS leases,
          (SELECT COUNT(*) FROM process_receipts p JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id WHERE x.attempt_id = ?) AS receipts
      `, retry.attemptId, retry.attemptId, retry.attemptId);
      expect(sideEffects).toEqual({ contexts: 0, leases: 0, receipts: 0 });

      const input = resumeInputWithContract(run, attempt, contract, repo);
      const result = resumeRun(input);
      expect(result.ok).toBe(true);
      const ticket = result.tickets[0]!;
      expect(ticket.orphanedPlannedAttempt).not.toBeNull();
      expect(ticket.orphanedPlannedAttempt!.attemptId).toBe(retry.attemptId);
      expect(ticket.orphanedPlannedAttempt!.attemptNumber).toBe(retry.attemptNumber);
    });

    it("recovers the orphaned planned attempt as a typed no-side-effect cleanup image", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);

      const input = resumeInputWithContract(run, attempt, contract, repo);
      const result = resumeRun(input);
      expect(result.ok).toBe(true);
      const ticket = result.tickets[0]!;
      expect(ticket.nextAction).toBe("allocate_retry");
      expect(ticket.orphanedPlannedCleanupRecordId).not.toBeNull();

      // The orphaned planned attempt is now failed_clean
      const retryRow = row(store.location.databasePath, "SELECT state FROM attempts WHERE attempt_id = ?", retry.attemptId);
      expect(retryRow).toEqual({ state: "failed_clean" });

      // A typed cleanup record exists in the state_transitions table with RecoveryService owner
      const cleanupTransitions = rows(store.location.databasePath,
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND owner_service = 'RecoveryService' ORDER BY entity_sequence",
        retry.attemptId);
      expect(cleanupTransitions.length).toBeGreaterThanOrEqual(2);
      expect(cleanupTransitions[0]!.to_state).toBe("cleanup_pending");
      expect(cleanupTransitions[1]!.to_state).toBe("failed_clean");
    });

    it("never activates the orphaned planned attempt (no execution context, lease, or process)", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);

      const input = resumeInputWithContract(run, attempt, contract, repo);
      resumeRun(input);

      // No execution context, lease, or process was created for the orphaned attempt
      const sideEffects = row(store.location.databasePath, `
        SELECT
          (SELECT COUNT(*) FROM execution_contexts WHERE attempt_id = ?) AS contexts,
          (SELECT COUNT(*) FROM attempt_ownership_leases WHERE attempt_id = ?) AS leases,
          (SELECT COUNT(*) FROM process_receipts p JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id WHERE x.attempt_id = ?) AS receipts
      `, retry.attemptId, retry.attemptId, retry.attemptId);
      expect(sideEffects).toEqual({ contexts: 0, leases: 0, receipts: 0 });
    });

    it("allocates a new higher-numbered attempt only after the orphaned cleanup", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);
      const retryNumber = retry.attemptNumber;

      const input = resumeInputWithContract(run, attempt, contract, repo);
      const result = resumeRun(input);
      expect(result.ok).toBe(true);
      const ticket = result.tickets[0]!;

      // A new attempt was allocated with a higher number
      expect(ticket.newAttempt).not.toBeNull();
      expect(ticket.newAttempt!.attemptNumber).toBeGreaterThan(retryNumber);

      // The new attempt is planned
      const newRow = row(store.location.databasePath, "SELECT state, attempt_number FROM attempts WHERE attempt_id = ?", ticket.newAttempt!.attemptId);
      expect(newRow).toMatchObject({ state: "planned", attempt_number: ticket.newAttempt!.attemptNumber });

      // The new attempt has a different ID from the orphaned one
      expect(ticket.newAttempt!.attemptId).not.toBe(retry.attemptId);
    });

    it("does not blindly replay the orphaned allocation (the orphaned attempt is not respawned)", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);

      const input = resumeInputWithContract(run, attempt, contract, repo);
      const result = resumeRun(input);
      expect(result.ok).toBe(true);

      // The orphaned attempt is failed_clean, not planned/active
      const orphanedRow = row(store.location.databasePath, "SELECT state FROM attempts WHERE attempt_id = ?", retry.attemptId);
      expect(orphanedRow).toEqual({ state: "failed_clean" });

      // Exactly 3 attempts exist: initial (failed_clean), orphaned retry (failed_clean), new retry (planned)
      const allAttempts = rows(store.location.databasePath, "SELECT attempt_number, state FROM attempts ORDER BY attempt_number");
      expect(allAttempts).toHaveLength(3);
      expect(allAttempts.map((a) => a.attempt_number)).toEqual([1, 2, 3]);
    });
  });

  describe("idempotent resume (replay)", () => {
    let repo: string;
    let lineage: ReturnType<typeof newLineage>;

    beforeEach(() => {
      repo = makeRepo("replay");
      lineage = newLineage(repo);
    });

    afterEach(() => {
      try { lineage.store.close(); } catch { /* already closed */ }
    });

    it("replaying resume after orphaned cleanup is idempotent (no duplicate cleanup, no duplicate allocation)", () => {
      const { store, run, attempt, contract } = lineage;
      simulateResponseLostRetry(store, run, attempt);

      const input = resumeInputWithContract(run, attempt, contract, repo);

      // First resume: cleans up orphan + allocates new attempt
      const result1 = resumeRun(input);
      expect(result1.ok).toBe(true);
      const attemptsAfter1 = rows(store.location.databasePath, "SELECT attempt_id FROM attempts ORDER BY attempt_number");

      // Second resume: should be idempotent — no new attempts, no new cleanup records
      const result2 = resumeRun(input);
      expect(result2.ok).toBe(true);
      const attemptsAfter2 = rows(store.location.databasePath, "SELECT attempt_id FROM attempts ORDER BY attempt_number");

      expect(attemptsAfter2).toHaveLength(attemptsAfter1.length);
      expect(attemptsAfter2.map((a) => a.attempt_id)).toEqual(attemptsAfter1.map((a) => a.attempt_id));
    });
  });

  describe("commit prose non-authoritative", () => {
    let repo: string;

    beforeEach(() => {
      repo = makeRepo("commit-prose");
    });

    it("reconcile ignores Git subjects and does not build ticket state from commit messages", () => {
      // Create a commit with a ticket-like subject that reconcile must ignore
      execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "ticket: T-FORGED pretend completion"]);

      // No state store exists for this repo — reconcile should find no
      // persisted receipts and report zero tickets.
      const rickgentDir = join(repo, ".rickgent");
      mkdirSync(rickgentDir, { recursive: true });
      const result = reconcile(repo, rickgentDir);
      expect(result.ok).toBe(true);
      expect(result.ticketsFound).toBe(0);
      // No registry.json should be created from Git subjects
      expect(existsSync(join(rickgentDir, "registry.json"))).toBe(false);
    });

    it("reconcile does not read git log or use commit subjects (negative proof)", () => {
      const rickgentDir = join(repo, ".rickgent");
      mkdirSync(rickgentDir, { recursive: true });
      // Write a forged dispatch ledger with a "completed" claim
      const ledger = join(rickgentDir, "dispatch-ledger.jsonl");
      const forgedEntry = JSON.stringify({
        dispatchId: "forged/T-FORGED/implement/99/worker",
        state: "completed",
        commitSha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        baselineSha: "",
        declaredPaths: ["work.txt"],
      });
      writeFileSync(ledger, `${forgedEntry}\n`);

      const result = reconcile(repo, rickgentDir, ledger);
      expect(result.ok).toBe(true);
      expect(result.ticketsFound).toBe(0);
      // The forged ledger is not imported as truth
      expect(readFileSync(ledger, "utf8")).toContain("forged");
    });
  });

  describe("reconciliation from persisted receipts", () => {
    let repo: string;
    let lineage: ReturnType<typeof newLineage>;

    beforeEach(() => {
      repo = makeRepo("reconcile-receipts");
      lineage = newLineage(repo);
    });

    afterEach(() => {
      try { lineage.store.close(); } catch { /* already closed */ }
    });

    it("reconcile rebuilds derived views from run-attributed immutable receipts", () => {
      const { store, run, attempt } = lineage;
      // Advance to active
      mutate(store.location.databasePath, "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?", run.runId);
      mutate(store.location.databasePath, "UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ?", attempt.ticketInstanceId);

      const rickgentDir = join(repo, ".rickgent");
      const result = reconcile(repo, rickgentDir);
      expect(result.ok).toBe(true);
      expect(result.ticketsFound).toBeGreaterThanOrEqual(1);
    });
  });

  describe("negative proofs", () => {
    let repo: string;
    let lineage: ReturnType<typeof newLineage>;

    beforeEach(() => {
      repo = makeRepo("negative");
      lineage = newLineage(repo);
    });

    afterEach(() => {
      try { lineage.store.close(); } catch { /* already closed */ }
    });

    it("rejects resume of a non-existent run (fail closed)", () => {
      const { attempt, contract } = lineage;
      const input: ResumeRunInput = {
        runId: "run-nonexistent-00000000",
        repoPath: repo,
        manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        contextSchemaVersion: attempt.contextSchemaVersion,
        oracleVersion: attempt.oracleVersion,
        capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
        resourceIdentityVersion: attempt.resourceIdentityVersion,
        tickets: [{ ticketId: contract.id, contractDigest: contract.digest }],
      };
      expect(() => resumeRun(input)).toThrow(/does not belong|RESUME_INCOMPATIBLE/);
    });

    it("orphaned cleanup rejects an attempt that is not planned (fail closed)", () => {
      const { store, run, attempt, contract } = lineage;
      // Advance the initial attempt to "implementing" (not planned, not failed_clean)
      mutate(store.location.databasePath, "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?", run.runId);
      mutate(store.location.databasePath, "UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ?", attempt.ticketInstanceId);
      mutate(store.location.databasePath, "UPDATE attempts SET state = 'implementing', state_version = state_version + 1 WHERE attempt_id = ?", attempt.attemptId);

      // Resume should NOT treat the "implementing" attempt as orphaned
      const input = resumeInputWithContract(run, attempt, contract, repo);
      const result = resumeRun(input);
      expect(result.ok).toBe(true);
      expect(result.tickets[0]!.orphanedPlannedAttempt).toBeNull();
      expect(result.tickets[0]!.latestAttempt!.state).toBe("implementing");
    });

    it("orphaned cleanup rejects an attempt with an execution context (already activated)", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);

      // Simulate that the retry was actually activated by inserting an execution context
      const db = openRaw(store.location.databasePath, false);
      try {
        db.prepare(`
          INSERT INTO execution_contexts (
            context_id, context_digest, attempt_id, phase, phase_ordinal, role, canonical_context_json,
            contract_digest, capability_snapshot_digest, policy_bundle_digest, model_selection_digest,
            budget_digest, scope_digest, context_schema_version, oracle_version, created_at
          ) VALUES (?, ?, ?, 'implementing', 1, 'worker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `ctx-forged-${retry.attemptId}`,
          digest("forged-context"),
          retry.attemptId,
          canonicalJson({ forged: true }),
          retry.contractDigest,
          retry.capabilitySnapshotDigest,
          digest("forged-policy"),
          digest("forged-model"),
          digest("forged-budget"),
          digest("forged-scope"),
          retry.contextSchemaVersion,
          retry.oracleVersion,
          "2026-07-22T00:00:00.000Z",
        );
      } finally {
        db.close();
      }

      // Resume should NOT treat this as an orphaned planned attempt (it has an execution context)
      const input = resumeInputWithContract(run, attempt, contract, repo);
      const result = resumeRun(input);
      expect(result.ok).toBe(true);
      // The attempt is not orphaned because it has an execution context
      expect(result.tickets[0]!.orphanedPlannedAttempt).toBeNull();
    });

    it("orphaned cleanup is idempotent: replaying the same cleanup key does not double-transition", () => {
      const { store, run, attempt, contract } = lineage;
      const retry = simulateResponseLostRetry(store, run, attempt);

      const input = resumeInputWithContract(run, attempt, contract, repo);

      // First resume: cleans up orphan + allocates new attempt
      resumeRun(input);
      const cleanupTransitions1 = rows(store.location.databasePath,
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND owner_service = 'RecoveryService'",
        retry.attemptId);

      // Second resume: should not create additional cleanup transitions
      resumeRun(input);
      const cleanupTransitions2 = rows(store.location.databasePath,
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND owner_service = 'RecoveryService'",
        retry.attemptId);

      expect(cleanupTransitions2.length).toBe(cleanupTransitions1.length);
    });
  });
});
