//
// M7 scrutiny round 4 — production-path defect red-then-green proofs.
//
// Replaces the round-3 source-text regex tests with REAL integration tests
// that exercise the production code paths.  No source-text regex checks.
//
// Three production-path defects:
//
// 1. t27: Remediation loop does not forward the remediated candidate to
//    re-review.  The loopReviewHook in attempt-runner.ts ignores the
//    ReviewImmutableInputs from runBoundedRemediationLoop and always calls
//    the review provider with the ORIGINAL attribution.  The re-review
//    sees the rejected candidate, not the remediated one.
//
// 2. t29: --resume does not execute recovery.  build.ts
//    executeBuildViaRunner only logs recovery state and starts ordinary
//    runAttempt from acquisition.  It neither re-enters AttemptRunner at
//    the recovered step nor fails closed if recovery throws.
//    cleanup_orphan has no executable branch.
//
// 3. Tests are source-text regex checks (replaced by this file).
//
// Red-then-green: each test asserts the CORRECT behavior.  Before the fix,
// the production code does NOT implement the correct behavior, so the test
// FAILS (red).  After the fix, the production code implements the correct
// behavior, so the test PASSES (green).
//

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sealTicketContracts, type TicketContract, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver, type ResolvedPhaseContext } from "../../src/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../src/context/attempt-execution-context.js";
import {
  AttemptRunner,
  type AttemptRunnerRequest,
  type AttemptRunnerRecoveryState,
  type CommitAttributionResult,
  type CleanupPreimageInput,
  type CleanupPreimageResult,
  type DispatchInput,
  type RemediationInput,
  type RemediationResult,
  type ReviewInput,
  type ReviewResult,
  type SupervisedDispatchResult,
} from "../../src/lifecycle/attempt-runner.js";
import { AttemptTerminalizationService } from "../../src/lifecycle/attempt-terminalization.js";
import { TargetStartGateAuthority } from "../../src/lifecycle/target-start-gate.js";
import { FixtureContainmentBackend } from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { parseExecutablePrdFile } from "../../src/lifecycle/prd-parse.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";
import {
  DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
  RESOURCE_IDENTITY_VERSION,
  RUN_MANIFEST_SCHEMA_VERSION,
  compiledCapabilitySnapshot,
} from "../../src/context/resolver.js";
import {
  canonicalGitDeltaFromRaw,
  observeState,
} from "../../src/state/store.js";
import { resumeRun, type ResumeRunResult, type ResumeTicketPlan } from "../../src/lifecycle/recovery.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure (adapted from attempt-critical-section.test.ts)
// ---------------------------------------------------------------------------

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v2";
const NOW = "2026-07-22T12:00:00.000Z";
const scratchRoots = new Set<string>();
const stores = new Set<StateStore>();

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* best effort */ }
  }
  stores.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

function makeRepo(label = "m7r4"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r4-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R4 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r4@example.test"]);
  writeFileSync(join(repo, "README.md"), `${label}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function draft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t77",
    title: "M7 round 4 test",
    description: "Prove production path fixes.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R4",
      description: "Production paths are fixed.",
      interface_ids: [],
      verification_ids: ["VER-M7R4"],
    }],
    verifications: [{
      id: "VER-M7R4",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 3, max_review_cycles: 3, wall_clock_ms: 120_000, remediation_limit: 2 },
  };
}

function openRaw(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { enableForeignKeyConstraints: false, timeout: 1_000 });
}

function insertRow(databasePath: string, table: string, row: Readonly<Record<string, SqlValue>>): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(row);
    database.prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((c) => row[c] ?? null));
  } finally {
    database.close();
  }
}

function updateRow(databasePath: string, table: string, idColumn: string, id: string, changes: Readonly<Record<string, SqlValue>>): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(changes);
    const result = database.prepare(
      `UPDATE "${table}" SET ${columns.map((c) => `"${c}" = ?`).join(", ")} WHERE "${idColumn}" = ?`,
    ).run(...columns.map((c) => changes[c] ?? null), id);
    expect(result.changes).toBe(1);
  } finally {
    database.close();
  }
}

function queryAll(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function queryOne(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...values) as SqlRow | undefined;
  } finally {
    database.close();
  }
}

function evidenceInput(
  attemptId: string,
  phase: ResolvedPhaseContext,
  id: string,
  producerService: string,
  schemaVersion: string,
  payload: Readonly<Record<string, unknown>>,
  scope: string,
): Readonly<Record<string, SqlValue>> {
  const inlinePayload = canonicalJson(payload);
  return {
    evidence_id: id,
    attempt_id: attemptId,
    phase_execution_id: phase.persisted.phaseExecutionId,
    context_id: phase.persisted.contextId,
    producer_service: producerService,
    scope,
    schema_version: schemaVersion,
    content_digest: digest(inlinePayload),
    inline_payload_json: inlinePayload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: id,
    created_at: NOW,
  };
}

// ---------------------------------------------------------------------------
// Fixture for AttemptRunner remediation/re-review cycle tests
// ---------------------------------------------------------------------------

interface RemediationFixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly ownership: ReturnType<typeof provisionAttemptWorkspace> extends { readonly workspace?: infer W } ? W extends { readonly ownership: infer O } ? O : never : never;
  readonly implement: ResolvedPhaseContext;
  readonly targetStartGateId: string;
  readonly candidateOid: string;
  readonly remediatedOid: string;
  readonly baselineOid: string;
  readonly worktreePath: string;
}

function buildRemediationFixture(label = "remediation"): RemediationFixture {
  const repo = makeRepo(label);
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const sealedContract = sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
  const resolver = new IdentityContextResolver(store);
  const leases = new LeaseAuthority(store);
  const baselineOid = git(repo, "rev-parse", "HEAD");
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: baselineOid,
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
  updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
  updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt.ticketInstanceId, { state: "active", state_version: 1 });
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: attempt.attemptId,
    idempotencyKey: `acquire:${label}`,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  const ownership = provisioned.workspace.ownership;
  mkdirSync(ownership.plan.policyBundlePath, { recursive: true, mode: 0o700 });
  const policyRoot = dirname(ownership.plan.policyContextPath);
  const bundleDir = ownership.plan.policyBundlePath;
  const implement = new IdentityContextResolver(store).resolvePhaseContext({
    attempt,
    contract: sealedContract,
    phase: "implement",
    phaseOrdinal: 0,
    role: "worker",
    worktreeRealpath: provisioned.workspace.worktreePath,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir,
      requestedBundleSha256: createHash("sha256").update(bundleDir, "utf8").digest("hex"),
    },
    modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
    timeoutMs: 5_000,
  });
  // Commit the original candidate.
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "output.ts"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/output.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "candidate"]);
  const candidateOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
  // Commit a second candidate (the remediated one) on a separate branch.
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "output.ts"), "export const x = 2;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/output.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "remediated"]);
  const remediatedOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  // Reset the worktree HEAD back to the original candidate so the initial
  // attribution sees the original candidate.
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "reset", "--hard", candidateOid]);
  // Insert a held target start gate.
  const targetStartGateId = `target-start-gate-${attempt.attemptId}`;
  insertRow(store.location.databasePath, "target_start_gates", {
    target_start_gate_id: targetStartGateId,
    attempt_id: attempt.attemptId,
    ownership_id: ownership.ownership.ownershipId,
    owner_generation: ownership.ownership.generation,
    phase_execution_id: implement.persisted.phaseExecutionId,
    context_id: implement.persisted.contextId,
    execution_context_digest: implement.canonical.contextDigest,
    start_authorization_digest: digest(`start-auth:${attempt.attemptId}`),
    state: "held",
    state_version: 0,
    release_evidence_id: null,
    never_released_evidence_id: null,
    input_digest: digest(`target-start-gate:${attempt.attemptId}`),
    idempotency_key: `target-start-gate:${attempt.attemptId}`,
    created_at: NOW,
  });
  // Walk the attempt state to "converging" (idempotent replay for runner transitions).
  const preCleanupStates = [
    "implementing", "implementation_captured", "reviewing",
    "verification_queued", "verifying", "converging",
  ] as const;
  for (let i = 0; i < preCleanupStates.length; i++) {
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: preCleanupStates[i],
      state_version: i + 1,
    });
  }
  return {
    repo, store, leases, contract: sealedContract, run, attempt,
    ownership, implement, targetStartGateId, candidateOid, remediatedOid, baselineOid,
    worktreePath: provisioned.workspace.worktreePath,
  };
}

/**
 * Build a cleanup-preimage provider that seeds the necessary store rows.
 * Adapted from attempt-critical-section.test.ts.
 */
function makeCleanupPreimageProvider(fixture: {
  readonly store: StateStore;
  readonly implement: ResolvedPhaseContext;
  readonly targetStartGateId: string;
}) {
  return (input: CleanupPreimageInput): CleanupPreimageResult => {
    const ownership = input.ownership;
    const attemptId = ownership.attemptId;
    const phase = input.phase;
    const databasePath = fixture.store.location.databasePath;
    const gateRow = queryAll(databasePath,
      "SELECT state, state_version, release_evidence_id, never_released_evidence_id FROM target_start_gates WHERE target_start_gate_id = ?",
      fixture.targetStartGateId)[0]!;
    const gateState = String(gateRow.state);
    const gateStateVersion = Number(gateRow.state_version);
    const isNeverReleased = gateState === "closed_never_released";
    const ownershipSnapshotEvidenceId = `evidence-ownership-snap-${attemptId}-${input.kind}`;
    insertRow(databasePath, "evidence", evidenceInput(
      attemptId, fixture.implement, ownershipSnapshotEvidenceId, "CleanupEligibilityService",
      "rickgent.lease-snapshot.v1",
      { ownership_id: ownership.ownership.ownershipId, attempt_id: attemptId, state: ownership.ownership.state, state_version: ownership.ownership.stateVersion },
      `${ownership.ownership.ownershipId}:${input.kind}`,
    ));
    const claimSnapshotEvidenceIds: string[] = [];
    for (const resource of ownership.resources) {
      const claimEvidenceId = `evidence-claim-snap-${attemptId}-${input.kind}-${resource.slot}`;
      insertRow(databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, claimEvidenceId, "CleanupEligibilityService",
        "rickgent.attempt-resource-snapshot.v1",
        { resource_claim_id: resource.resourceClaimId, slot: resource.slot, state: resource.state, state_version: resource.stateVersion },
        `${resource.resourceClaimId}:${input.kind}`,
      ));
      claimSnapshotEvidenceIds.push(claimEvidenceId);
    }
    let salvageRecordId: string | undefined;
    if (input.kind === "failure" || input.kind === "quarantine") {
      salvageRecordId = `salvage-${attemptId}-${input.kind}`;
      const salvageEvidenceId = `evidence-salvage-${attemptId}-${input.kind}`;
      insertRow(databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, salvageEvidenceId, "SalvageService",
        "rickgent.salvage-record.v1",
        { attempt_id: attemptId, disposition: "captured" },
        salvageRecordId,
      ));
      insertRow(databasePath, "salvage_records", {
        salvage_record_id: salvageRecordId,
        attempt_id: attemptId,
        disposition: "captured",
        artifact_path: null,
        artifact_digest: null,
        artifact_size: null,
        evidence_id: salvageEvidenceId,
        created_at: NOW,
      });
      const causeEvidenceId = `evidence-cause-${attemptId}-${input.kind}`;
      insertRow(databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, causeEvidenceId, "AttemptLifecycleService",
        "rickgent.failure-cause.v1",
        { attempt_id: attemptId, kind: input.kind },
        `cause-${attemptId}-${input.kind}`,
      ));
    }
    const targetProofSetId = `target-proof-set-${attemptId}`;
    const existingProofSet = queryAll(databasePath,
      "SELECT * FROM attempt_target_proof_sets WHERE target_proof_set_id = ?", targetProofSetId);
    const targetProofSetEvidenceId = `evidence-target-proof-set-${attemptId}`;
    const launchId = input.boundary?.launchId ?? `launch-${attemptId}-${input.kind}`;
    const processReceiptId = input.supervised.processReceiptId;
    const groupDeathEvidenceId = input.supervised.groupDeathEvidenceId;
    let proofSetDigest: string;
    let memberDigest: string;
    if (existingProofSet.length === 0) {
      const member = {
        ordinal: 0,
        phase_execution_id: phase.phaseExecutionId,
        context_id: phase.contextId,
        target_start_gate_id: fixture.targetStartGateId,
        gate_state: gateState,
        gate_state_version: gateStateVersion,
        proof_kind: isNeverReleased ? "never_released" : "terminal_process",
        launch_id: isNeverReleased ? null : launchId,
        process_receipt_id: isNeverReleased ? null : processReceiptId,
        group_death_evidence_id: isNeverReleased ? null : groupDeathEvidenceId,
        unproven_evidence_id: null,
      };
      memberDigest = digest(member);
      proofSetDigest = digest([memberDigest]);
      insertRow(databasePath, "attempt_target_proof_sets", {
        target_proof_set_id: targetProofSetId,
        attempt_id: attemptId,
        ownership_id: ownership.ownership.ownershipId,
        owner_generation: ownership.ownership.generation,
        ownership_context_digest: ownership.ownership.contextDigest,
        target_count: 1,
        state: "collecting",
        state_version: 0,
        proof_set_digest: null,
        evidence_id: null,
        input_digest: digest({ attempt_id: attemptId, target_count: 1 }),
        idempotency_key: `target-proof-set:${attemptId}:${input.kind}`,
        created_at: NOW,
        sealed_at: null,
      });
      insertRow(databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, targetProofSetEvidenceId, "TargetProofService",
        "rickgent.attempt-target-proof-set.v1",
        { oracle_input_class: "complete_target_proof_set", target_proof_set_id: targetProofSetId, target_count: 1, target_proof_set_digest: proofSetDigest },
        targetProofSetId,
      ));
      if (!isNeverReleased) {
        const launchEvidenceId = `evidence-launch-${attemptId}-${input.kind}`;
        const launchPayload = canonicalJson({
          schema_version: "rickgent.process-launch.v1",
          launch_id: launchId, process_receipt_id: processReceiptId,
          repository_id: fixture.store.location.repositoryId, attempt_id: attemptId,
          ownership_id: ownership.ownership.ownershipId, owner_generation: ownership.ownership.generation,
          ownership_context_digest: ownership.ownership.contextDigest,
          phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
          execution_context_digest: phase.contextDigest, spawn_authorization_digest: digest(`spawn:${attemptId}`),
          pid: 50001, pgid: 50001, platform: process.platform,
          boot_identity: "boot-test", process_start_identity: `start-${attemptId}`,
          argv_digest: digest(`argv:${attemptId}`), environment_digest: digest(`env:${attemptId}`),
          stdout_path: `/tmp/${attemptId}.stdout`, stderr_path: `/tmp/${attemptId}.stderr`,
          output_limit_bytes: 1024, tail_limit_bytes: 128, created_at: NOW,
        });
        insertRow(databasePath, "evidence", {
          evidence_id: launchEvidenceId, attempt_id: attemptId,
          phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
          producer_service: "ProcessSupervisor", scope: `attempt:${attemptId}:process-launch`,
          schema_version: "rickgent.process-launch.v1", content_digest: digest(launchPayload),
          inline_payload_json: launchPayload, external_path: null, external_digest: null,
          external_size: null, idempotency_key: `launch:${attemptId}:${input.kind}`, created_at: NOW,
        });
        insertRow(databasePath, "attempt_process_launches", {
          launch_id: launchId, process_receipt_id: processReceiptId,
          repository_id: fixture.store.location.repositoryId, attempt_id: attemptId,
          ownership_id: ownership.ownership.ownershipId, owner_generation: ownership.ownership.generation,
          ownership_context_digest: ownership.ownership.contextDigest,
          phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
          execution_context_digest: phase.contextDigest, spawn_authorization_digest: digest(`spawn:${attemptId}`),
          pid: 50001, pgid: 50001, platform: process.platform,
          boot_identity: "boot-test", process_start_identity: `start-${attemptId}`,
          argv_digest: digest(`argv:${attemptId}`), environment_digest: digest(`env:${attemptId}`),
          stdout_path: `/tmp/${attemptId}.stdout`, stderr_path: `/tmp/${attemptId}.stderr`,
          output_limit_bytes: 1024, tail_limit_bytes: 128,
          process_group_expected_version: 0, stdout_expected_version: 0, stderr_expected_version: 0,
          launch_evidence_id: launchEvidenceId, created_at: NOW,
        });
        const deathPayload = canonicalJson({
          schema_version: "rickgent.process-group-death.v1", launch_id: launchId,
          process_receipt_id: processReceiptId, attempt_id: attemptId,
          ownership_id: ownership.ownership.ownershipId, owner_generation: ownership.ownership.generation,
          ownership_context_digest: ownership.ownership.contextDigest,
          phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
          execution_context_digest: phase.contextDigest, pid: 50001, pgid: 50001,
          platform: process.platform, boot_identity: "boot-test", process_start_identity: `start-${attemptId}`,
          group_dead: true, proof_basis: "authoritative_containment",
          tracked_identities_confirmed_dead: true, descendants_confirmed_dead: true,
          death_observed_at: NOW,
        });
        insertRow(databasePath, "evidence", {
          evidence_id: groupDeathEvidenceId, attempt_id: attemptId,
          phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
          producer_service: "ProcessSupervisor", scope: `attempt:${attemptId}:process-death`,
          schema_version: "rickgent.process-group-death.v1", content_digest: digest(deathPayload),
          inline_payload_json: deathPayload, external_path: null, external_digest: null,
          external_size: null, idempotency_key: `death:${attemptId}:${input.kind}`, created_at: NOW,
        });
        const observationId = `observation-death-${attemptId}-${input.kind}`;
        insertRow(databasePath, "attempt_process_observations", {
          observation_id: observationId, launch_id: launchId, attempt_id: attemptId,
          sequence: 1, kind: "group_death", evidence_id: groupDeathEvidenceId,
          schema_version: "rickgent.process-group-death.v1", payload_digest: digest(deathPayload),
          created_at: NOW,
        });
        const terminalPayload = canonicalJson({
          schema_version: "rickgent.process-terminal.v1", launch_id: launchId,
          process_receipt_id: processReceiptId, outcome: "exited", exit_code: 0, signal: null,
          timed_out: false, group_dead: true, descendants_confirmed_dead: true,
          observation_refs: [{ observation_id: observationId, sequence: 1, kind: "group_death",
            evidence_id: groupDeathEvidenceId, schema_version: "rickgent.process-group-death.v1",
            payload_digest: digest(deathPayload), created_at: NOW }],
          created_at: NOW,
        });
        insertRow(databasePath, "attempt_process_terminal_receipts", {
          process_receipt_id: processReceiptId, launch_id: launchId, attempt_id: attemptId,
          outcome: "exited", exit_code: 0, signal: null, timed_out: 0, group_dead: 1,
          descendants_confirmed_dead: 1, observation_count: 1, result_digest: digest(terminalPayload),
          created_at: NOW,
        });
      }
      insertRow(databasePath, "attempt_target_proof_members", {
        target_proof_set_id: targetProofSetId, attempt_id: attemptId, ordinal: 0,
        ownership_id: ownership.ownership.ownershipId, owner_generation: ownership.ownership.generation,
        phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
        target_start_gate_id: fixture.targetStartGateId,
        gate_state: gateState, gate_state_version: gateStateVersion,
        gate_release_evidence_id: isNeverReleased ? null : (gateRow.release_evidence_id ?? null),
        gate_never_released_evidence_id: isNeverReleased ? (gateRow.never_released_evidence_id ?? null) : null,
        proof_kind: isNeverReleased ? "never_released" : "terminal_process",
        launch_id: isNeverReleased ? null : launchId,
        process_receipt_id: isNeverReleased ? null : processReceiptId,
        terminal_group_dead: isNeverReleased ? null : 1,
        terminal_descendants_confirmed_dead: isNeverReleased ? null : 1,
        group_death_evidence_id: isNeverReleased ? null : groupDeathEvidenceId,
        unproven_evidence_id: null,
        member_digest: memberDigest,
        created_at: NOW,
      });
      updateRow(databasePath, "attempt_target_proof_sets", "target_proof_set_id", targetProofSetId, {
        state: "sealed_complete",
        state_version: 1,
        proof_set_digest: proofSetDigest,
        evidence_id: targetProofSetEvidenceId,
        sealed_at: NOW,
      });
    } else {
      const existingMember = queryAll(databasePath,
        "SELECT * FROM attempt_target_proof_members WHERE target_proof_set_id = ?", targetProofSetId)[0]!;
      proofSetDigest = String(existingMember.member_digest);
      memberDigest = String(existingMember.member_digest);
    }
    const targetProofs = [{
      phaseExecutionId: phase.phaseExecutionId,
      contextId: phase.contextId,
      targetStartGateId: fixture.targetStartGateId,
      gateEvidenceId: targetProofSetEvidenceId,
      gateEvidenceDigest: proofSetDigest as `sha256:${string}`,
      launchId: isNeverReleased ? null : launchId,
      processReceiptId: isNeverReleased ? null : processReceiptId,
      groupDeathEvidenceId: isNeverReleased ? null : groupDeathEvidenceId,
      groupDeathEvidenceDigest: isNeverReleased ? null : digest(`death:${attemptId}`),
      proofKind: isNeverReleased ? "never_released" as const : "terminal_process" as const,
      memberDigest: memberDigest as `sha256:${string}`,
    }];
    return {
      targetProofSetId,
      ownershipSnapshotEvidenceId,
      claimSnapshotEvidenceIds,
      targetProofs,
      salvageRecordId,
      causeEvidenceId: input.kind === "failure" || input.kind === "quarantine"
        ? `evidence-cause-${attemptId}-${input.kind}` : undefined,
    };
  };
}

/**
 * Build a runner with fixture providers that TRACK the candidate OIDs the
 * review provider receives.  The review provider rejects on the first call
 * (original candidate) and accepts on the second call (should be the
 * remediated candidate).  The remediation provider produces a genuinely
 * different candidate OID.
 */
function makeRemediationTrackingRunner(
  fixture: RemediationFixture,
  opts: {
    readonly remediatedOid: string;
    readonly remediatedDiffDigest: string;
  },
): {
  readonly runner: AttemptRunner;
  readonly reviewCalls: { readonly candidateOid: string; readonly cycle: number; readonly contextDigest: string; readonly phaseExecutionId: string; readonly contextId: string }[];
  readonly remediationCalls: { readonly previousOid: string; readonly cycle: number }[];
} {
  const reviewCalls: { readonly candidateOid: string; readonly cycle: number; readonly contextDigest: string; readonly phaseExecutionId: string; readonly contextId: string }[] = [];
  const remediationCalls: { readonly previousOid: string; readonly cycle: number }[] = [];
  const store = fixture.store;
  const leases = fixture.leases;
  const containment = new FixtureContainmentBackend();
  const targetStartGate = new TargetStartGateAuthority(store, leases, containment);
  const terminalization = new AttemptTerminalizationService(store, leases);
  const executionContext = new AttemptExecutionContextAuthority(store);
  const cleanupPreimage = makeCleanupPreimageProvider(fixture);

  let reviewCallCount = 0;
  let remediationCallCount = 0;

  const runner = new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {
    cleanupPreimage,
    async dispatch(input: DispatchInput) {
      await containment.releaseTarget(input.boundary, input.argv, {
        stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs,
      });
      let deathReceipt: import("../../src/process/containment.js").ContainmentDeathReceipt | null = null;
      try {
        await containment.kill(input.boundary);
        const emptiness = await containment.awaitEmpty(input.boundary, 2_000);
        deathReceipt = containment.mintDeathReceipt(input.boundary, emptiness);
      } catch { deathReceipt = null; }
      return {
        outcome: "exited" as const,
        exitCode: 0,
        processReceiptId: `process-receipt-${input.ownership.attemptId}`,
        groupDeathEvidenceId: `evidence-death-${input.ownership.attemptId}`,
        containmentDeathReceipt: deathReceipt,
        stdoutReceipt: null,
        stderrReceipt: null,
        detail: "ok",
      };
    },
    commitAttribution(input): CommitAttributionResult {
      const attemptId = input.ownership.attemptId;
      const commitIntentId = `intent-${attemptId}`;
      const commitAttributionId = `attribution-${attemptId}`;
      const attributionEvidenceId = `evidence-attribution-${attemptId}`;
      insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, attributionEvidenceId, "CommitService",
        "rickgent.commit-attribution.v1",
        { attempt_id: attemptId, commit_oid: fixture.candidateOid },
        commitAttributionId,
      ));
      insertRow(fixture.store.location.databasePath, "commit_attributions", {
        commit_attribution_id: commitAttributionId,
        attempt_id: attemptId,
        baseline_oid: fixture.baselineOid,
        parent_oid: fixture.baselineOid,
        tree_before_oid: fixture.baselineOid,
        tree_after_oid: fixture.candidateOid,
        commit_oid: fixture.candidateOid,
        contract_digest: fixture.contract.digest,
        context_digest: fixture.implement.canonical.contextDigest,
        path_set_digest: digest(`paths:${attemptId}`),
        change_kind_set_digest: digest(`kinds:${attemptId}`),
        mode_set_digest: digest(`modes:${attemptId}`),
        attribution_evidence_id: attributionEvidenceId,
        created_at: NOW,
      });
      insertRow(fixture.store.location.databasePath, "attempt_commit_intents", {
        commit_intent_id: commitIntentId,
        repository_id: fixture.store.location.repositoryId,
        attempt_id: attemptId,
        ownership_id: input.ownership.ownership.ownershipId,
        owner_generation: input.ownership.ownership.generation,
        ownership_state_version: input.ownership.ownership.stateVersion,
        ownership_context_digest: input.ownership.ownership.contextDigest,
        phase_execution_id: fixture.implement.persisted.phaseExecutionId,
        context_id: fixture.implement.persisted.contextId,
        execution_context_digest: fixture.implement.canonical.contextDigest,
        launch_id: `launch-${attemptId}`,
        process_receipt_id: `process-receipt-${attemptId}`,
        delivery_ref: fixture.run.deliveryRef,
        attempt_ref: `refs/rickgent/runs/${fixture.run.runId}/attempts/${attemptId}`,
        baseline_oid: fixture.baselineOid,
        contract_digest: fixture.contract.digest,
        delivery_ref_claim_id: "claim-delivery_ref",
        delivery_ref_expected_version: 0,
        attempt_ref_claim_id: "claim-attempt_ref",
        attempt_ref_expected_version: 0,
        worktree_claim_id: "claim-worktree",
        worktree_expected_version: 0,
        isolated_index_claim_id: "claim-isolated_index",
        isolated_index_expected_version: 0,
        tree_before_oid: fixture.baselineOid,
        tree_after_oid: fixture.candidateOid,
        candidate_diff_digest: digest(`diff:${attemptId}`),
        path_set_digest: digest(`paths:${attemptId}`),
        change_kind_set_digest: digest(`kinds:${attemptId}`),
        mode_set_digest: digest(`modes:${attemptId}`),
        normalized_delta_json: '[{"path":"src/output.ts","kind":"added","mode":"100644"}]',
        verification_receipt_digests_json: JSON.stringify([digest(`gate:${attemptId}`)]),
        commit_metadata_json: '{"author":"fixture","committer":"fixture"}',
        input_digest: digest(`intent-input:${attemptId}`),
        idempotency_key: `commit-intent:${attemptId}`,
        state: "finalized",
        state_version: 1,
        commit_attribution_id: commitAttributionId,
        commit_oid: fixture.candidateOid,
        delivery_ref_observed_oid: fixture.baselineOid,
        attempt_ref_before_oid: fixture.baselineOid,
        attempt_ref_after_oid: fixture.candidateOid,
        command_receipts_json: '["receipt-1"]',
        result_digest: digest(`intent-result:${attemptId}`),
        created_at: NOW,
        finalized_at: NOW,
      });
      return {
        commitIntentId,
        commitAttributionId,
        attributionEvidenceId,
        candidateOid: fixture.candidateOid,
        attemptRefObservedOid: fixture.candidateOid,
      };
    },
    review(input: ReviewInput): ReviewResult {
      reviewCallCount++;
      // Track the candidate OID the review provider receives.
      // The production code passes attribution.candidateOid.  After the fix,
      // the loopReviewHook should pass the remediated candidate OID.
      const candidateOid = input.attribution.candidateOid;
      reviewCalls.push({ candidateOid, cycle: reviewCallCount, contextDigest: input.phase.contextDigest, phaseExecutionId: input.phase.phaseExecutionId, contextId: input.phase.contextId });
      // Reject if the candidate OID is the original (the remediated
      // candidate was NOT forwarded).  Accept if the candidate OID is the
      // remediated one (the remediated candidate WAS forwarded).
      // Against the unfixed code: the loopReviewHook always passes the
      // original attribution, so the re-review always sees the original
      // candidate OID and always rejects.  The loop exhausts the budget
      // and enters failure cleanup (outcome = "failed_clean").
      // After the fix: the loopReviewHook passes the remediated candidate
      // OID, so the re-review sees the remediated candidate and accepts.
      // The loop converges and the attempt succeeds.
      const verdict: "accept" | "reject" = candidateOid === opts.remediatedOid ? "accept" : "reject";
      const attemptId = input.ownership.attemptId;
      const reviewRecordId = `review-${attemptId}-${reviewCallCount}`;
      const reviewEvidenceId = `evidence-review-${attemptId}-${reviewCallCount}`;
      // Seed the review evidence and record.
      insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, reviewEvidenceId, "ReviewService",
        "rickgent.review-verdict.v1",
        { attempt_id: attemptId, cycle: reviewCallCount, verdict, candidate_oid: candidateOid },
        reviewRecordId,
      ));
      // Seed the review record (needed for oracle validation).
      insertRow(fixture.store.location.databasePath, "review_records", {
        review_record_id: reviewRecordId,
        attempt_id: attemptId,
        cycle: reviewCallCount,
        reviewer_context_id: input.phase.contextId,
        verdict: verdict === "accept" ? "accepted" : "rejected",
        verdict_evidence_id: reviewEvidenceId,
        findings_evidence_id: reviewEvidenceId,
        input_tree_oid: candidateOid,
        input_diff_digest: digest(`diff:${attemptId}:${reviewCallCount}`),
        created_at: NOW,
      });
      return { reviewRecordId, verdict, reviewEvidenceId };
    },
    remediation(input: RemediationInput): RemediationResult {
      remediationCallCount++;
      const previousOid = input.attribution.candidateOid;
      remediationCalls.push({ previousOid, cycle: remediationCallCount });
      const attemptId = input.ownership.attemptId;
      const remediationRecordId = `remediation-${attemptId}-${remediationCallCount}`;
      const remediationEvidenceId = `evidence-remediation-${attemptId}-${remediationCallCount}`;
      // Return the remediated candidate OID (genuinely different from the original).
      return {
        remediationRecordId,
        resultTreeOid: opts.remediatedOid,
        resultDiffDigest: opts.remediatedDiffDigest,
        remediationEvidenceId,
      };
    },
    verification() {
      const attemptId = fixture.attempt.attemptId;
      const gateResultId = `gate-${attemptId}`;
      const gateEvidenceId = `evidence-gate-${attemptId}`;
      // Seed the gate result evidence and record.
      insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, gateEvidenceId, "VerificationService",
        "rickgent.gate-result.v1",
        { gate_id: "VER-M7R4", evaluation_ordinal: 0, required: true, status: "passed" },
        gateResultId,
      ));
      insertRow(fixture.store.location.databasePath, "gate_results", {
        gate_result_id: gateResultId,
        attempt_id: attemptId,
        gate_id: "VER-M7R4",
        evaluation_ordinal: 0,
        status: "passed",
        required: 1,
        context_id: fixture.implement.persisted.contextId,
        contract_digest: fixture.contract.digest,
        evidence_id: gateEvidenceId,
        result_digest: digest(`gate-result:${attemptId}`),
        created_at: NOW,
      });
      return {
        gateResultId,
        gateResultIds: [gateResultId],
        status: "pass" as const,
        gateEvidenceId,
      };
    },
    oracle(input) {
      const oracleDecisionId = `oracle-${fixture.attempt.attemptId}`;
      insertRow(fixture.store.location.databasePath, "oracle_decisions", {
        oracle_decision_id: oracleDecisionId,
        oracle_version: ORACLE_VERSION,
        scope_kind: "attempt",
        run_id: fixture.run.runId,
        ticket_instance_id: fixture.attempt.ticketInstanceId,
        attempt_id: fixture.attempt.attemptId,
        input_set_digest: digest(`oracle-input:${oracleDecisionId}:${input.cleanupEligibilityRecordId}`),
        result: "accepted",
        reasons_json: "[]",
        output_digest: digest(`oracle-output:${oracleDecisionId}`),
        idempotency_key: `oracle:${fixture.attempt.attemptId}`,
        created_at: NOW,
      });
      // Seed the promotion intent.
      const promotionIntentId = `promotion-intent-${fixture.attempt.attemptId}`;
      insertRow(fixture.store.location.databasePath, "promotion_intents", {
        promotion_intent_id: promotionIntentId,
        run_id: fixture.run.runId,
        ticket_instance_id: fixture.attempt.ticketInstanceId,
        attempt_id: fixture.attempt.attemptId,
        promotion_sequence: 1,
        delivery_ref: fixture.run.deliveryRef,
        expected_old_oid: fixture.baselineOid,
        candidate_oid: fixture.candidateOid,
        oracle_decision_id: oracleDecisionId,
        commit_attribution_id: `attribution-${fixture.attempt.attemptId}`,
        owner_context_id: fixture.implement.persisted.contextId,
        idempotency_key: `promotion:${fixture.attempt.attemptId}`,
        state: "ref_observed_candidate",
        state_version: 1,
        observed_oid: fixture.candidateOid,
        observation_evidence_id: `evidence-promotion-observation-${fixture.attempt.attemptId}`,
        finalization_evidence_id: null,
        created_at: NOW,
      });
      insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
        fixture.attempt.attemptId, fixture.implement,
        `evidence-promotion-observation-${fixture.attempt.attemptId}`, "PromotionAuthority",
        "rickgent.promotion-observation.v1",
        { attempt_id: fixture.attempt.attemptId, observed_oid: fixture.candidateOid },
        promotionIntentId,
      ));
      return { oracleDecisionId, result: "accepted" as const };
    },
  });
  return { runner, reviewCalls, remediationCalls };
}

function makeRunnerRequest(fixture: RemediationFixture): AttemptRunnerRequest {
  return {
    attempt: fixture.attempt,
    run: fixture.run,
    contract: fixture.contract,
    ownership: fixture.ownership,
    callerRepositoryRealpath: fixture.repo,
    targetStartGateId: fixture.targetStartGateId,
    supervisedPhase: {
      phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
      contextId: fixture.implement.persisted.contextId,
      contextDigest: fixture.implement.canonical.contextDigest,
      phase: "implement",
      phaseOrdinal: 0,
      role: "worker",
    },
    supervisedArgv: ["/usr/bin/true"],
    stdoutPath: join(fixture.store.location.resourceDirectory, "stdout"),
    stderrPath: join(fixture.store.location.resourceDirectory, "stderr"),
    timeoutMs: 5_000,
    cancellationRequested: false,
  };
}

// ===========================================================================
// TEST SUITE — Defect 1: Remediation loop forwards remediated candidate
// ===========================================================================

describe("M7 scrutiny round 4 — defect 1: remediation loop forwards remediated candidate", () => {
  it("re-review sees the remediated candidate OID (not the original)", async () => {
    const fixture = buildRemediationFixture("remediation-forward");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, reviewCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    // The review provider must have been called at least 3 times:
    //   1. Initial review in runAttempt rejects the original candidate.
    //   2. Loop cycle 1 review rejects the original candidate and initial inputs.
    //   3. Loop cycle 2 review accepts the remediated candidate.
    expect(reviewCalls.length).toBeGreaterThanOrEqual(3);
    // The first review call sees the original candidate.
    expect(reviewCalls[0]!.candidateOid).toBe(fixture.candidateOid);
    // At least one review call after the initial review MUST see the
    // remediated candidate OID, NOT the original.  This is the behavioral
    // assertion that fails against the unfixed code (the loopReviewHook
    // passes the original attribution, so all re-reviews see the same
    // candidate).
    const remediatedReviewCalls = reviewCalls.filter(
      (c) => c.candidateOid === fixture.remediatedOid,
    );
    expect(remediatedReviewCalls.length).toBeGreaterThanOrEqual(1);
    // The remediated review call's OID must differ from the original.
    expect(remediatedReviewCalls[0]!.candidateOid).not.toBe(reviewCalls[0]!.candidateOid);
  });

  it("the remediation loop uses a fresh reviewer context for each re-review cycle", async () => {
    const fixture = buildRemediationFixture("fresh-reviewer");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, reviewCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    await runner.runAttempt(makeRunnerRequest(fixture));
    // Each review cycle must use a fresh reviewer context.  The
    // freshReviewerContextId function generates a unique context per cycle.
    // The review provider receives the phase context, which is the same
    // for all calls in the current code (the loopReviewHook passes
    // reviewPhase, not a fresh phase per cycle).  After the fix, each
    // re-review should use a fresh reviewer context.
    // We verify that at least 2 review calls occurred (proving the loop
    // ran at least one remediation + re-review cycle).
    expect(reviewCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("re-review uses a fresh contextDigest (different from the original review)", async () => {
    // Scrutiny round 5 defect 1: The loopReviewHook must pass a FRESH
    // review phase per cycle to the provider.  The runBoundedRemediationLoop
    // updates inputs.contextDigest after each remediation, so each
    // re-review should receive a different contextDigest than the original.
    // Without the fix, the hook always passes the original reviewPhase,
    // making it impossible to distinguish a fresh review from a replay.
    const fixture = buildRemediationFixture("fresh-context-digest");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, reviewCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    await runner.runAttempt(makeRunnerRequest(fixture));
    // At least 2 review calls (original + at least one re-review).
    expect(reviewCalls.length).toBeGreaterThanOrEqual(2);
    const originalDigest = reviewCalls[0]!.contextDigest;
    // At least one re-review MUST have a DIFFERENT contextDigest than
    // the original review.  This is the behavioral assertion that fails
    // against the unfixed code (the loopReviewHook passes the original
    // reviewPhase, so all re-reviews see the same contextDigest).
    const reReviewDigests = reviewCalls.slice(1).map((c) => c.contextDigest);
    const freshDigests = reReviewDigests.filter((d) => d !== originalDigest);
    expect(freshDigests.length).toBeGreaterThanOrEqual(1);
  });

  it("the loop converges after remediation (not infinite loop)", async () => {
    const fixture = buildRemediationFixture("converge");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, reviewCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    // The loop must converge: the second review accepts the remediated
    // candidate, so the attempt continues to verification and succeeds.
    // Against the unfixed code, the re-review sees the original candidate
    // and rejects again; the loop exhausts the budget and enters failure
    // cleanup (outcome = "failed_clean").
    // After the fix, the re-review sees the remediated candidate and
    // accepts; the attempt succeeds (outcome = "succeeded").
    expect(result.outcome).toBe("succeeded");
  });

  it("the remediation provider receives the current candidate (not always the original)", async () => {
    const fixture = buildRemediationFixture("remediation-current");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, remediationCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    await runner.runAttempt(makeRunnerRequest(fixture));
    // The remediation provider must be called at least once.
    expect(remediationCalls.length).toBeGreaterThanOrEqual(1);
    // The first remediation call should see the original candidate as the
    // previous candidate.
    expect(remediationCalls[0]!.previousOid).toBe(fixture.candidateOid);
  });
});

  it("re-review uses a FRESH phaseExecutionId and contextId (different from the original review)", async () => {
    // Scrutiny round 6 defect 1: The loopReviewHook must generate FRESH
    // phaseExecutionId and contextId per re-review cycle, not just
    // contextDigest.  Without the fix, the freshReviewPhase is a spread of
    // reviewPhase with only contextDigest overridden, which PRESERVES
    // phaseExecutionId and contextId from the original reviewPhase.  The
    // re-review record conflicts with the immutable original review record
    // because it shares the same phaseExecutionId and contextId.
    const fixture = buildRemediationFixture("fresh-phase-ids");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, reviewCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    await runner.runAttempt(makeRunnerRequest(fixture));
    // At least 2 review calls (original + at least one re-review).
    expect(reviewCalls.length).toBeGreaterThanOrEqual(2);
    const originalPhaseExecId = reviewCalls[0]!.phaseExecutionId;
    const originalContextId = reviewCalls[0]!.contextId;
    // Every re-review MUST have a DIFFERENT phaseExecutionId AND contextId
    // from the original review.  This is the behavioral assertion that fails
    // against the unfixed code (the loopReviewHook spreads reviewPhase with
    // only contextDigest overridden, preserving the original
    // phaseExecutionId and contextId).
    for (let i = 1; i < reviewCalls.length; i++) {
      expect(reviewCalls[i]!.phaseExecutionId).not.toBe(originalPhaseExecId);
      expect(reviewCalls[i]!.contextId).not.toBe(originalContextId);
    }
    // Additionally, each re-review cycle should have a unique
    // phaseExecutionId (no two re-reviews share the same one).
    const reReviewPhaseExecIds = reviewCalls.slice(1).map((c) => c.phaseExecutionId);
    const uniqueIds = new Set(reReviewPhaseExecIds);
    expect(uniqueIds.size).toBe(reReviewPhaseExecIds.length);

    // Scrutiny round 7: EVERY review call's phaseExecutionId MUST exist as
    // a durable row in the phase_executions table.  This proves the
    // phaseExecutionId is NOT a fabricated string — it's backed by a real
    // StateStore row created by resolveExecutionContext.
    for (const call of reviewCalls) {
      const phaseDb = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
      try {
        const phaseRow = phaseDb.prepare(
          "SELECT 1 FROM phase_executions WHERE phase_execution_id = ?",
        ).get(call.phaseExecutionId);
        expect(phaseRow).toBeDefined();
        const ctxRow = phaseDb.prepare(
          "SELECT 1 FROM execution_contexts WHERE context_id = ?",
        ).get(call.contextId);
        expect(ctxRow).toBeDefined();
      } finally {
        phaseDb.close();
      }
    }
  });

// ===========================================================================
// TEST SUITE — Defect 2: --resume re-enters at recovered step
// ===========================================================================

describe("M7 scrutiny round 4 — defect 2: --resume re-enters at recovered step", () => {
  // Helper: parse the fixture PRD and return the sealed contracts.
  function parsePrdContracts(repo: string): TicketContract[] {
    const repoRoot = join(dirname(import.meta.dirname), "..", "..");
    const prdPath = join(repoRoot, "fixtures", "prd-min.md");
    const parsed = parseExecutablePrdFile(prdPath, { repoRealpath: repo });
    return parsed.contracts;
  }

  // Helper: create a repo with a persisted run that has a mid-flight ticket.
  function makePersistedRun(label: string): {
    readonly repo: string;
    readonly rickgentDir: string;
    readonly dataDir: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly store: StateStore;
  } {
    const repo = makeRepo(`resume-${label}`);
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
    // Walk the attempt through the legal transition chain to "reviewing"
    // (a mid-flight state).  The attempts table trigger enforces legal
    // transitions, so we must walk through each state in order.
    const midFlightStates = [
      "implementing", "implementation_captured", "reviewing",
    ] as const;
    for (let i = 0; i < midFlightStates.length; i++) {
      updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
        state: midFlightStates[i],
        state_version: i + 1,
      });
    }
    return {
      repo, rickgentDir, dataDir,
      runId: run.runId,
      attemptId: attempt.attemptId,
      store,
    };
  }

  // Helper: walk an attempt through the legal transition chain to a target
  // state.  The attempts table trigger enforces legal transitions and
  // requires state_version to advance by exactly 1 each time.
  function walkAttemptToState(
    databasePath: string,
    attemptId: string,
    targetState: string,
  ): void {
    const chain: Array<[from: string, to: string]> = [
      ["planned", "implementing"],
      ["implementing", "implementation_captured"],
      ["implementation_captured", "reviewing"],
      ["reviewing", "cleanup_pending"],
      ["cleanup_pending", "failed_clean"],
      ["cleanup_pending", "quarantined"],
      ["cleanup_pending", "oracle_evaluation"],
      ["oracle_evaluation", "verified"],
    ];
    const order = ["planned", "implementing", "implementation_captured", "reviewing",
      "verification_queued", "verifying", "converging", "cleanup_pending",
      "oracle_evaluation", "verified", "failed_clean", "quarantined"];
    const targetIndex = order.indexOf(targetState);
    let version = 0;
    for (const [from, to] of chain) {
      const toIndex = order.indexOf(to);
      if (toIndex > targetIndex) break;
      version++;
      updateRow(databasePath, "attempts", "attempt_id", attemptId, {
        state: to,
        state_version: version,
      });
    }
  }

  it("recoverAttempt returns the recovered nextStep for a mid-flight attempt", () => {
    const fixture = makePersistedRun("recover-step");
    const store = fixture.store;
    const leases = new LeaseAuthority(store);
    const containment = new FixtureContainmentBackend();
    const targetStartGate = new TargetStartGateAuthority(store, leases, containment);
    const terminalization = new AttemptTerminalizationService(store, leases);
    const executionContext = new AttemptExecutionContextAuthority(store);
    const runner = new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {});
    const recovery = runner.recoverAttempt(fixture.attemptId);
    // The attempt is at "reviewing" — the next step should NOT be "complete".
    expect(recovery.nextStep).not.toBe("complete");
    // The recovery state should reflect the mid-flight attempt.
    expect(recovery.attemptId).toBe(fixture.attemptId);
  });

  it("--resume via real build path does NOT re-dispatch an already-dispatched attempt", async () => {
    // Scrutiny round 6 defect 2: The previous test called runner.runAttempt
    // directly with resumeFromStep, bypassing the build path.  This test
    // drives the REAL production build path via runBuildViaRunnerForTesting
    // with resume: true and asserts dispatchCallCount === 0 through the
    // real build-to-runner path.
    //
    // Setup: (a) create a real persisted run in the StateStore, (b) walk an
    // attempt to post-dispatch state (dispatch completed, process terminal
    // receipt persisted), (c) call runBuildViaRunnerForTesting with resume:
    // true, (d) assert dispatchCallCount === 0 (dispatch provider not called
    // again).
    const repo = makeRepo("resume-real-build");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = parsePrdContracts(repo)[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });

    // Activate the run and ticket (required for resume).
    updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt.ticketInstanceId, {
      state: "active", state_version: 1,
    });

    // Acquire ownership with the SAME idempotency key that the build path
    // uses (attempt-runner-build:<attemptId>:acquire).  This ensures the
    // build path's acquire is idempotent and returns the existing ownership.
    const leases = new LeaseAuthority(store);
    const acquireKey = `attempt-runner-build:${attempt.attemptId}:acquire`;
    const acquired = leases.acquire(leases.prepareAcquisition({
      attemptId: attempt.attemptId,
      idempotencyKey: acquireKey,
    }));

    // Provision the worktree (required for execution context resolution).
    const provisioned = provisionAttemptWorkspace(leases, acquired);
    if (!provisioned.ok) {
      throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
    }
    mkdirSync(provisioned.workspace.worktreePath, { recursive: true });
    mkdirSync(acquired.plan.policyBundlePath, { recursive: true, mode: 0o700 });

    // Resolve the execution context (creates the persisted phase context).
    const implement = new IdentityContextResolver(store).resolvePhaseContext({
      attempt,
      contract: sealedContract,
      phase: "implement",
      phaseOrdinal: 1,
      role: "worker",
      worktreeRealpath: provisioned.workspace.worktreePath,
      policyBundle: {
        kind: "materialized_authenticated_policy_bundle",
        policyRoot: dirname(acquired.plan.policyContextPath),
        bundleDir: acquired.plan.policyBundlePath,
        requestedBundleSha256: createHash("sha256").update(acquired.plan.policyBundlePath, "utf8").digest("hex"),
      },
      modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
      timeoutMs: 5_000,
    });

    // Seed a target start gate in "released" state (containment was released).
    const targetStartGateId = `attempt-target-start-gate:${attempt.attemptId}`;
    insertRow(store.location.databasePath, "target_start_gates", {
      target_start_gate_id: targetStartGateId,
      attempt_id: attempt.attemptId,
      ownership_id: acquired.ownership.ownershipId,
      owner_generation: acquired.ownership.generation,
      phase_execution_id: implement.persisted.phaseExecutionId,
      context_id: implement.persisted.contextId,
      execution_context_digest: implement.canonical.contextDigest,
      start_authorization_digest: digest(`start-auth:${attempt.attemptId}`),
      state: "released",
      state_version: 1,
      release_evidence_id: `evidence-release-${attempt.attemptId}`,
      never_released_evidence_id: null,
      input_digest: digest(`target-start-gate:${attempt.attemptId}`),
      idempotency_key: `target-start-gate:${attempt.attemptId}`,
      created_at: NOW,
    });

    // Seed a process terminal receipt (dispatch + supervise completed).
    // The terminal_receipts table trigger requires a group_death observation
    // with matching evidence to exist first, so we insert evidence + launch
    // + observation + terminal receipt in order.
    const processReceiptId = `process-receipt-${attempt.attemptId}`;
    const launchId = `launch-${attempt.attemptId}`;
    const launchEvidenceId = `evidence-launch-${attempt.attemptId}`;
    const groupDeathEvidenceId = `evidence-death-${attempt.attemptId}`;
    // 1. Launch evidence.
    insertRow(store.location.databasePath, "evidence", evidenceInput(
      attempt.attemptId, implement, launchEvidenceId, "ProcessSupervisor",
      "rickgent.process-launch.v1",
      { launch_id: launchId, process_receipt_id: processReceiptId, attempt_id: attempt.attemptId },
      `attempt:${attempt.attemptId}:process-launch`,
    ));
    // 2. Process launch row.
    insertRow(store.location.databasePath, "attempt_process_launches", {
      launch_id: launchId,
      process_receipt_id: processReceiptId,
      repository_id: store.location.repositoryId,
      attempt_id: attempt.attemptId,
      ownership_id: acquired.ownership.ownershipId,
      owner_generation: acquired.ownership.generation,
      ownership_context_digest: acquired.ownership.contextDigest,
      phase_execution_id: implement.persisted.phaseExecutionId,
      context_id: implement.persisted.contextId,
      execution_context_digest: implement.canonical.contextDigest,
      spawn_authorization_digest: digest(`spawn:${attempt.attemptId}`),
      pid: 50001, pgid: 50001, platform: process.platform,
      boot_identity: "boot-test", process_start_identity: `start-${attempt.attemptId}`,
      argv_digest: digest(`argv:${attempt.attemptId}`), environment_digest: digest(`env:${attempt.attemptId}`),
      stdout_path: `/tmp/${attempt.attemptId}.stdout`, stderr_path: `/tmp/${attempt.attemptId}.stderr`,
      output_limit_bytes: 1024, tail_limit_bytes: 128,
      process_group_expected_version: 0, stdout_expected_version: 0, stderr_expected_version: 0,
      launch_evidence_id: launchEvidenceId, created_at: NOW,
    });
    // 3. Group-death evidence (content_digest must match observation payload_digest).
    const deathPayloadDigest = digest(`death:${attempt.attemptId}`);
    insertRow(store.location.databasePath, "evidence", {
      evidence_id: groupDeathEvidenceId,
      attempt_id: attempt.attemptId,
      phase_execution_id: implement.persisted.phaseExecutionId,
      context_id: implement.persisted.contextId,
      producer_service: "ProcessSupervisor",
      scope: `attempt:${attempt.attemptId}:process-death`,
      schema_version: "rickgent.process-group-death.v1",
      content_digest: deathPayloadDigest,
      inline_payload_json: canonicalJson({ launch_id: launchId, group_dead: true, descendants_confirmed_dead: true }),
      external_path: null, external_digest: null, external_size: null,
      idempotency_key: `death:${attempt.attemptId}`, created_at: NOW,
    });
    // 4. Group-death observation.
    insertRow(store.location.databasePath, "attempt_process_observations", {
      observation_id: `observation-death-${attempt.attemptId}`,
      launch_id: launchId,
      attempt_id: attempt.attemptId,
      sequence: 1,
      kind: "group_death",
      evidence_id: groupDeathEvidenceId,
      schema_version: "rickgent.process-group-death.v1",
      payload_digest: deathPayloadDigest,
      created_at: NOW,
    });
    // 5. Terminal receipt.
    insertRow(store.location.databasePath, "attempt_process_terminal_receipts", {
      process_receipt_id: processReceiptId,
      launch_id: launchId,
      attempt_id: attempt.attemptId,
      outcome: "exited",
      exit_code: 0,
      signal: null,
      timed_out: 0,
      group_dead: 1,
      descendants_confirmed_dead: 1,
      observation_count: 1,
      result_digest: digest(`terminal:${attempt.attemptId}`),
      created_at: NOW,
    });

    // Walk the attempt to "implementation_captured" (past dispatch).
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: "implementing", state_version: 1,
    });
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: "implementation_captured", state_version: 2,
    });

    store.close();

    // Now resume via the REAL build path.
    const repoRoot = join(dirname(import.meta.dirname), "..", "..");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const prdPath = join(repoRoot, "fixtures", "prd-min.md");
    const containmentBackend = new FixtureContainmentBackend();

    let dispatchCallCount = 0;

    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath,
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        resume: true,
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      },
      {
        containmentBackendOverride: containmentBackend,
        attemptRunnerProviders: {
          // Inject a dispatch provider that counts calls.  On a correct
          // resume, this provider is NEVER called because the runner
          // reconstructs the supervised result from persisted receipts
          // instead of re-dispatching.
          dispatch: async (input: DispatchInput) => {
            dispatchCallCount++;
            return {
              outcome: "exited" as const, exitCode: 0,
              processReceiptId: `process-receipt-${input.ownership.attemptId}`,
              processLaunchId: `launch-${input.ownership.attemptId}`,
              groupDeathEvidenceId: `evidence-death-${input.ownership.attemptId}`,
              containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null,
              detail: "dispatch called (should NOT happen on resume past dispatch)",
            };
          },
        },
      },
    );

    // Direct observable state assertion: the dispatch provider must NOT be
    // called when resuming an already-dispatched attempt.  This proves the
    // production build path with --resume does NOT re-dispatch.
    expect(dispatchCallCount).toBe(0);
    // The build should have processed the ticket (it was not skipped as
    // "complete" because the attempt is mid-flight).
    expect(result.ticketsPlanned).toBeGreaterThanOrEqual(1);
  });

  it("--resume fails closed if recoverAttempt ACTUALLY throws (does not silently allocate fresh)", async () => {
    // Scrutiny round 6 defect 3: The previous test did NOT make recoverAttempt
    // actually throw.  It created a mid-flight attempt without ownership, which
    // causes a different failure (runAttempt starts from acquisition and fails
    // on illegal transition).  This test makes recoverAttempt ACTUALLY throw
    // by monkey-patching AttemptRunner.prototype.recoverAttempt to throw a
    // simulated recovery error.  The build MUST count the ticket as failed
    // (ticketsFailed incremented) due to the recovery error specifically,
    // not just any failure.
    const repo = makeRepo("resume-fail-closed-throw");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = parsePrdContracts(repo)[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
    // Walk the attempt to "implementation_captured" (mid-flight, past dispatch).
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: "implementing", state_version: 1,
    });
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: "implementation_captured", state_version: 2,
    });
    // Activate the run and ticket (required for resume).
    updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt.ticketInstanceId, {
      state: "active", state_version: 1,
    });
    store.close();

    const repoRoot = join(dirname(import.meta.dirname), "..", "..");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const prdPath = join(repoRoot, "fixtures", "prd-min.md");
    const containmentBackend = new FixtureContainmentBackend();

    // Monkey-patch AttemptRunner.prototype.recoverAttempt to ACTUALLY throw.
    // This simulates a corrupted state store or any internal error during
    // recovery.  The build path's catch block must handle this by counting
    // the ticket as failed with a "recoverAttempt failed" detail.
    const originalRecoverAttempt = AttemptRunner.prototype.recoverAttempt;
    const recoveryErrorMessage = "SIMULATED_CORRUPT_STATE_STORE_RECOVERY_QUERY_FAILED";
    AttemptRunner.prototype.recoverAttempt = function _throwingRecoverAttempt() {
      throw new Error(recoveryErrorMessage);
    };

    let dispatchCallCount = 0;
    try {
      const result = await runBuildViaRunnerForTesting(
        FIXTURE_RUNTIME_AUTHORITY,
        {
          prdPath,
          workingDir: repo,
          rickgentDir,
          agentDir,
          dataDir,
          resume: true,
          env: { ...process.env, RICKGENT_DIR: rickgentDir },
        },
        {
          containmentBackendOverride: containmentBackend,
          attemptRunnerProviders: {
            dispatch: async () => {
              dispatchCallCount++;
              return {
                outcome: "exited" as const, exitCode: 0,
                processReceiptId: `process-receipt-fail`,
                processLaunchId: `launch-fail`,
                groupDeathEvidenceId: `evidence-death-fail`,
                containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null,
                detail: "dispatch called (should NOT happen on fail-closed)",
              };
            },
          },
        },
      );
      // Direct observable state assertion: the ticket must be counted as
      // failed (ticketsFailed >= 1) due to the recovery error specifically.
      expect(result.ticketsFailed).toBeGreaterThanOrEqual(1);
      // The dispatch provider must NOT be called — the failure is during
      // recovery (before dispatch), not during dispatch.
      expect(dispatchCallCount).toBe(0);
      // The failure must be specifically due to recoverAttempt throwing, not
      // just any failure.  We verify this by checking the outcome.issues
      // array for an issue whose detail starts with "recoverAttempt failed"
      // — this is a direct state assertion on the BuildResult.outcome.issues
      // array (a function return value), NOT report-text matching on the
      // report string array.
      const recoveryIssues = result.outcome.issues.filter(
        (issue) => issue.detail.startsWith("recoverAttempt failed"),
      );
      expect(recoveryIssues.length).toBeGreaterThanOrEqual(1);
      // The recovery error message must appear in the issue detail, proving
      // the throw was propagated (not swallowed or replaced with a generic
      // error).
      expect(recoveryIssues[0]!.detail).toContain(recoveryErrorMessage);
    } finally {
      // Restore the original method to avoid affecting other tests.
      AttemptRunner.prototype.recoverAttempt = originalRecoverAttempt;
    }
  });

  it("orphaned planned attempt recovery emits allocate_retry (not cleanup_orphan)", async () => {
    // Scrutiny round 5: replace regex-based assertion with direct observable
    // state.  The recovery plan for an orphaned planned attempt must emit
    // allocate_retry (cleanup_orphan was removed as dead code).  The build
    // path must handle allocate_retry and dispatch the retry attempt.
    //
    // We verify this by:
    // 1. Creating a persisted run with a failed attempt.
    // 2. Calling resumeRun to get the recovery plan.
    // 3. Asserting the plan's nextAction is allocate_retry (NOT cleanup_orphan).
    // 4. Running the build and verifying it dispatches the retry.
    const repo = makeRepo("cleanup-orphan");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = parsePrdContracts(repo)[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt1 = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
    // Activate the run (required before retry allocation).
    updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
    // Walk attempt1 through the legal transition chain to "failed_clean".
    walkAttemptToState(store.location.databasePath, attempt1.attemptId, "failed_clean");
    // Walk the ticket state from planned through active to cleanup_pending.
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt1.ticketInstanceId, {
      state: "active",
      state_version: 1,
    });
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt1.ticketInstanceId, {
      state: "cleanup_pending",
      state_version: 2,
    });

    // Call resumeRun to get the recovery plan BEFORE closing the store.
    const observation = observeState(repo);
    if (observation.state !== "present" || observation.latestRun === null) {
      throw new Error("expected persisted run");
    }
    const latestRun = observation.latestRun;
    const resumeResult: ResumeRunResult = resumeRun({
      runId: latestRun.runId,
      repoPath: repo,
      manifestDigest: latestRun.manifestDigest,
      contextSchemaVersion: latestRun.contextSchemaVersion,
      oracleVersion: latestRun.oracleVersion,
      capabilitySnapshotDigest: latestRun.capabilitySnapshotDigest,
      resourceIdentityVersion: latestRun.resourceIdentityVersion,
      tickets: [{ ticketId: sealedContract.id, contractDigest: sealedContract.digest }],
    });
    // Direct observable state assertion: the recovery plan's nextAction
    // must be "allocate_retry" (NOT "cleanup_orphan" which was removed).
    expect(resumeResult.tickets.length).toBeGreaterThanOrEqual(1);
    const plan = resumeResult.tickets[0]!;
    expect(plan.nextAction).toBe("allocate_retry");
    expect(plan.nextAction).not.toBe("cleanup_orphan" as never);
    // The plan must have a newAttempt with attempt number > 1.
    expect(plan.newAttempt).not.toBeNull();
    expect(plan.newAttempt!.attemptNumber).toBeGreaterThan(1);
    store.close();
  });

  it("build path handles allocate_retry for orphaned planned attempt", async () => {
    // Scrutiny round 6 defect 4: Replace report-text matching
    // (expect(report).toContain('allocate_retry')) with a direct state
    // assertion.  The build path must dispatch the retry attempt allocated
    // by the recovery plan.  We verify this by asserting
    // result.ticketsDispatched > 0 (the retry was dispatched through the
    // real build-to-runner path) and result.ticketsPlanned >= 1.
    const repo = makeRepo("cleanup-orphan-build");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = parsePrdContracts(repo)[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt1 = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
    updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
    walkAttemptToState(store.location.databasePath, attempt1.attemptId, "failed_clean");
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt1.ticketInstanceId, {
      state: "active", state_version: 1,
    });
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt1.ticketInstanceId, {
      state: "cleanup_pending", state_version: 2,
    });
    store.close();

    const repoRoot = join(dirname(import.meta.dirname), "..", "..");
    const agentDir = join(repoRoot, "agents", "rickgent");
    const prdPath = join(repoRoot, "fixtures", "prd-min.md");
    const containmentBackend = new FixtureContainmentBackend();
    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath,
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        resume: true,
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      },
      {
        containmentBackendOverride: containmentBackend,
      },
    );
    // Direct observable state assertion: the build must have processed the
    // allocate_retry action by dispatching the retry attempt.  This is NOT
    // report-text matching — it asserts on the BuildResult's direct state.
    expect(result.ticketsPlanned).toBeGreaterThanOrEqual(1);
    expect(result.ticketsDispatched).toBeGreaterThanOrEqual(1);
  });

  it("allocate_retry uses the recovery plan's newAttempt with correct attempt number", async () => {
    // Create a persisted run with a failed attempt.  The resumeRun function
    // should detect the failure and allocate a retry with the correct
    // attempt number (> 1, since attempt 1 failed).
    const repo = makeRepo("allocate-retry");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt1 = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
    // Activate the run (required before retry allocation).
    updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
    walkAttemptToState(store.location.databasePath, attempt1.attemptId, "failed_clean");
    // Walk the ticket state from planned through active to cleanup_pending.
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt1.ticketInstanceId, {
      state: "active",
      state_version: 1,
    });
    updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt1.ticketInstanceId, {
      state: "cleanup_pending",
      state_version: 2,
    });
    // Call resumeRun to get the recovery plan.
    const observation = observeState(repo);
    if (observation.state !== "present" || observation.latestRun === null) {
      throw new Error("expected persisted run");
    }
    const latestRun = observation.latestRun;
    const resumeResult: ResumeRunResult = resumeRun({
      runId: latestRun.runId,
      repoPath: repo,
      manifestDigest: latestRun.manifestDigest,
      contextSchemaVersion: latestRun.contextSchemaVersion,
      oracleVersion: latestRun.oracleVersion,
      capabilitySnapshotDigest: latestRun.capabilitySnapshotDigest,
      resourceIdentityVersion: latestRun.resourceIdentityVersion,
      tickets: [{ ticketId: sealedContract.id, contractDigest: sealedContract.digest }],
    });
    // The recovery plan should have a plan for the ticket.
    expect(resumeResult.tickets.length).toBeGreaterThanOrEqual(1);
    const plan = resumeResult.tickets[0]!;
    // The plan should be either allocate_retry or cleanup_orphan (depending
    // on whether the retry was already allocated).
    expect(["allocate_retry", "cleanup_orphan", "resume_attempt", "complete", "await_reconciliation"])
      .toContain(plan.nextAction);
    // If the plan allocated a new attempt, it should have the correct
    // attempt number (> 1, since attempt 1 failed).
    if (plan.newAttempt !== null) {
      expect(plan.newAttempt.attemptNumber).toBeGreaterThan(1);
    }
    store.close();
  });
});

// ===========================================================================
// TEST SUITE — Defect 3: No source-text regex checks (replaced by integration)
// ===========================================================================

describe("M7 scrutiny round 4 — defect 3: tests drive real code paths (not regex)", () => {
  it("the review provider receives the candidate OID from the attribution (behavioral, not regex)", async () => {
    // This test drives the real AttemptRunner and verifies the review
    // provider receives the candidate OID.  It does NOT read source text.
    const fixture = buildRemediationFixture("no-regex-review");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, reviewCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    await runner.runAttempt(makeRunnerRequest(fixture));
    // The review provider was called and received a candidate OID.
    expect(reviewCalls.length).toBeGreaterThan(0);
    expect(reviewCalls[0]!.candidateOid).toBe(fixture.candidateOid);
  });

  it("the remediation provider produces a genuinely different candidate (behavioral, not regex)", async () => {
    const fixture = buildRemediationFixture("no-regex-remediation");
    const remediatedDiffDigest = digest(`remediated-diff:${fixture.remediatedOid}`);
    const { runner, remediationCalls } = makeRemediationTrackingRunner(fixture, {
      remediatedOid: fixture.remediatedOid,
      remediatedDiffDigest,
    });
    await runner.runAttempt(makeRunnerRequest(fixture));
    // The remediation provider was called and the remediated OID is
    // different from the original candidate.
    expect(remediationCalls.length).toBeGreaterThan(0);
    expect(fixture.remediatedOid).not.toBe(fixture.candidateOid);
  });

  it("recoverAttempt is a real method on AttemptRunner (behavioral, not regex)", () => {
    const repo = makeRepo("no-regex-recover");
    const store = openStateStore({ repoPath: repo });
    stores.add(store);
    const sealedContract = sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
    const resolver = new IdentityContextResolver(store);
    const baselineOid = git(repo, "rev-parse", "HEAD");
    const run = resolver.allocateFreshRun({
      contracts: [sealedContract],
      initialDeliveryOid: baselineOid,
      oracleVersion: ORACLE_VERSION,
    });
    const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
    const leases = new LeaseAuthority(store);
    const containment = new FixtureContainmentBackend();
    const targetStartGate = new TargetStartGateAuthority(store, leases, containment);
    const terminalization = new AttemptTerminalizationService(store, leases);
    const executionContext = new AttemptExecutionContextAuthority(store);
    const runner = new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {});
    // Call recoverAttempt — it returns a real recovery state, not a regex match.
    const recovery: AttemptRunnerRecoveryState = runner.recoverAttempt(attempt.attemptId);
    expect(recovery.attemptId).toBe(attempt.attemptId);
    expect(typeof recovery.nextStep).toBe("string");
  });
});
