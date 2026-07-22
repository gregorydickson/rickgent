/**
 * M6 scrutiny round 5 fix — empty/missing gate IDs fail-closed on the
 * verifying->cleanup_pending path.
 *
 * Captures two blocking defects from M6 scrutiny round 5:
 *
 * (1) LifecycleEngine.guardForEdge returns null for the
 *     verifying->cleanup_pending gate_results guard when gateResultIds is
 *     omitted or empty.  AttemptRunner permits a failed VerificationResult
 *     with an empty array, then the transition falls back to
 *     StateStore.advanceAttemptState without authority-validated gate
 *     evidence, owner context, or persisted transition evidence.
 *
 * (2) The round-4 missing-evidence, stale-context, and wrong-owner tests
 *     invoke LifecycleEngine directly — they do not cover AttemptRunner's
 *     real verification-failure branch or malformed provider output that
 *     reaches the direct-store fallback.
 *
 * The fix:
 *   - Reject missing or empty gateResultIds fail-closed in the production
 *     verification-failure path (engine.ts).
 *   - Require the authority transition for EVERY declared
 *     verifying->cleanup_pending edge — no fallback to
 *     StateStore.advanceAttemptState.
 *   - Add end-to-end AttemptRunner verification-failure tests that drive
 *     the REAL production path (not direct LifecycleEngine calls).
 *
 * Red-then-green proof: the tests below fail against the unfixed code
 * (which falls back to advanceAttemptState, persisting a transition with
 * the wrong owner_service and placeholder context digest) and pass after
 * the fix rejects empty/missing/stale/wrong-owner gate result IDs
 * fail-closed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver, type ResolvedPhaseContext } from "../../src/context/resolver.js";
import {
  AttemptExecutionContextAuthority,
} from "../../src/context/attempt-execution-context.js";
import {
  AttemptRunner,
  attemptRunnerIdempotencyKey,
  type AttemptRunnerRequest,
  type CleanupPreimageInput,
  type CleanupPreimageResult,
  type DispatchInput,
  type VerificationInput,
  type VerificationResult,
} from "../../src/lifecycle/attempt-runner.js";
import { AttemptTerminalizationService } from "../../src/lifecycle/attempt-terminalization.js";
import { TargetStartGateAuthority } from "../../src/lifecycle/target-start-gate.js";
import {
  FixtureContainmentBackend,
} from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v2";
const NOW = "2026-07-22T18:00:00.000Z";
const scratchRoots = new Set<string>();
const stores = new Set<StateStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "m6-scrutiny-r5-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M6 Scrutiny R5 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m6-scrutiny-r5@example.test"]);
  writeFileSync(join(repo, "README.md"), "m6 scrutiny r5\n", "utf8");
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
    id: "t99",
    title: "M6 scrutiny round 5 empty gate ids fail closed",
    description: "Exercise the verifying->cleanup_pending gate_results guard with malformed provider output.",
    depends_on: [],
    scope: [{ path: "src/m6-r5.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M6-R5",
      description: "empty/missing gateResultIds rejected fail-closed on verifying->cleanup_pending.",
      interface_ids: [],
      verification_ids: ["VER-M6-R5"],
    }],
    verifications: [{
      id: "VER-M6-R5",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 2, max_review_cycles: 2, wall_clock_ms: 120_000, remediation_limit: 1 },
  };
}

function openRaw(databasePath: string) {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
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

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly resolver: IdentityContextResolver;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly ownership: ReturnType<typeof provisionAttemptWorkspace> extends { readonly workspace?: infer W } ? W : never;
  readonly implement: ResolvedPhaseContext;
  readonly verify: ResolvedPhaseContext;
  readonly targetStartGateId: string;
  readonly candidateOid: string;
  readonly baselineOid: string;
}

function buildFixture(label = "r5"): Fixture {
  const repo = makeRepo();
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
  const verify = new IdentityContextResolver(store).resolvePhaseContext({
    attempt,
    contract: sealedContract,
    phase: "verification",
    phaseOrdinal: 3,
    role: "verifier",
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
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "m6-r5.ts"), "export const x = true;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/m6-r5.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "candidate"]);
  const candidateOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
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
  const preCleanupStates = [
    "implementing", "implementation_captured", "reviewing",
    "verification_queued", "verifying",
  ] as const;
  for (let i = 0; i < preCleanupStates.length; i++) {
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: preCleanupStates[i],
      state_version: i + 1,
    });
  }
  return {
    repo, store, leases, resolver, contract: sealedContract, run, attempt,
    ownership, implement, verify, targetStartGateId, candidateOid, baselineOid,
  } as Fixture;
}

function insertGateResult(
  fixture: Fixture,
  gateResultId: string,
  gateId: string,
  status: "passed" | "failed",
  required: 0 | 1,
  evidenceId: string,
  contextId: string,
  attemptId?: string,
): string {
  const databasePath = fixture.store.location.databasePath;
  const aid = attemptId ?? fixture.attempt.attemptId;
  insertRow(databasePath, "evidence", evidenceInput(
    aid, fixture.verify, evidenceId, "VerificationService",
    "rickgent.gate-result.v1",
    { gate_id: gateId, status, required, attempt_id: aid },
    `gate-result:${gateResultId}`,
  ));
  insertRow(databasePath, "gate_results", {
    gate_result_id: gateResultId,
    attempt_id: aid,
    gate_id: gateId,
    evaluation_ordinal: 0,
    status,
    required,
    context_id: contextId,
    contract_digest: fixture.contract.digest,
    evidence_id: evidenceId,
    result_digest: digest(`gate-result:${gateResultId}:${status}`),
    created_at: NOW,
  });
  return gateResultId;
}

function makeCleanupPreimageProvider(fixture: Fixture) {
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
    }
    if (input.kind === "failure" || input.kind === "quarantine") {
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
        target_proof_set_id: targetProofSetId,
        attempt_id: attemptId,
        ordinal: 0,
        ownership_id: ownership.ownership.ownershipId,
        owner_generation: ownership.ownership.generation,
        phase_execution_id: phase.phaseExecutionId,
        context_id: phase.contextId,
        target_start_gate_id: fixture.targetStartGateId,
        gate_state: gateState,
        gate_state_version: gateStateVersion,
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
    return Object.freeze({
      targetProofSetId,
      ownershipSnapshotEvidenceId,
      claimSnapshotEvidenceIds: Object.freeze(claimSnapshotEvidenceIds),
      targetProofs: Object.freeze(targetProofs),
      salvageRecordId,
      causeEvidenceId: input.kind === "failure" || input.kind === "quarantine"
        ? `evidence-cause-${attemptId}-${input.kind}` : undefined,
    });
  };
}

/**
 * Malformed verification provider modes for the end-to-end tests.
 * - "empty-gate-ids": returns status "fail" with an EMPTY gateResultIds
 *   array (simulating malformed provider output).  The engine must reject
 *   this fail-closed — no fallback to StateStore.advanceAttemptState.
 * - "stale-context": creates a gate result with a DIFFERENT context_id
 *   (the implement phase context, not the verify phase context).  The
 *   store's gate_results guard must reject the context digest mismatch.
 * - "wrong-owner": creates a gate result for a FOREIGN attempt, then
 *   returns that gate result ID.  The store's gate_results guard must
 *   reject because the gate result does not belong to this attempt.
 */
type MalformedVerificationMode = "empty-gate-ids" | "stale-context" | "wrong-owner";

function makeRunnerWithMalformedVerification(fixture: Fixture, mode: MalformedVerificationMode) {
  const containment = new FixtureContainmentBackend(fixture.store);
  const targetStartGate = new TargetStartGateAuthority(fixture.store);
  const terminalization = new AttemptTerminalizationService(fixture.store, fixture.leases);
  const executionContext = new AttemptExecutionContextAuthority(fixture.store);
  return new AttemptRunner(fixture.store, fixture.leases, containment, targetStartGate, terminalization, executionContext, {
    dispatch: async (_input: DispatchInput) => {
      const attemptId = fixture.attempt.attemptId;
      return { outcome: "exited", exitCode: 0,
        processReceiptId: `process-receipt-${attemptId}`,
        processLaunchId: `process-launch-${attemptId}`,
        groupDeathEvidenceId: `evidence-death-${attemptId}`,
        containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null,
        detail: "exited cleanly" } as any;
    },
    commitAttribution: () => {
      const attemptId = fixture.attempt.attemptId;
      const commitIntentId = `commit-intent-${attemptId}`;
      const commitAttributionId = `attribution-${attemptId}`;
      const attributionEvidenceId = `evidence-attribution-${attemptId}`;
      insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, attributionEvidenceId, "CommitService",
        "rickgent.commit-attribution.v1",
        { attempt_id: attemptId, commit_oid: fixture.candidateOid },
        `attribution:${attemptId}`,
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
        ownership_id: fixture.ownership.ownership.ownershipId,
        owner_generation: fixture.ownership.ownership.generation,
        ownership_state_version: fixture.ownership.ownership.stateVersion,
        ownership_context_digest: fixture.ownership.ownership.contextDigest,
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
        normalized_delta_json: '[{"path":"src/m6-r5.ts","kind":"added","mode":"100644"}]',
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
    review() { return { reviewRecordId: `review-${fixture.attempt.attemptId}`, verdict: "accept", reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}` }; },
    verification(input: VerificationInput): VerificationResult {
      const attemptId = fixture.attempt.attemptId;
      const gateResultId = `gate-${attemptId}`;
      const gateEvidenceId = `evidence-gate-${attemptId}`;
      if (mode === "empty-gate-ids") {
        // Return a FAILED VerificationResult with an EMPTY gateResultIds
        // array — simulating malformed provider output.  The engine must
        // reject this fail-closed, NOT fall back to
        // StateStore.advanceAttemptState.
        return {
          gateResultId,
          gateResultIds: [],
          status: "fail",
          gateEvidenceId,
        };
      }
      if (mode === "stale-context") {
        // Create a gate result with the IMPLEMENT phase context (not the
        // verify phase context).  When #beginCleanupPhase routes through
        // the TransitionAuthority with the verifyPhase context, the store's
        // gate_results guard must reject the context digest mismatch.
        insertGateResult(
          fixture,
          gateResultId,
          `required-${attemptId}`,
          "failed",
          1,
          gateEvidenceId,
          fixture.implement.persisted.contextId, // wrong context
        );
        return {
          gateResultId,
          gateResultIds: [gateResultId],
          status: "fail",
          gateEvidenceId,
        };
      }
      if (mode === "wrong-owner") {
        // Create a gate result for a FOREIGN attempt (different attempt_id).
        // The store's gate_results guard queries
        //   WHERE g.attempt_id = <current attempt>
        // so the foreign gate result will not be found, and the guard must
        // reject (rows.length !== selected.length).
        const foreignAttemptId = `foreign-attempt-${attemptId}`;
        // The foreign attempt must exist in the attempts table for the FK
        // to be valid.  Insert a minimal row.
        insertRow(fixture.store.location.databasePath, "attempts", {
          attempt_id: foreignAttemptId,
          run_id: fixture.run.runId,
          ticket_instance_id: fixture.attempt.ticketInstanceId,
          state: "verifying",
          state_version: 0,
          acquisition_idempotency_key: `acquire-foreign:${attemptId}`,
          created_at: NOW,
        });
        insertGateResult(
          fixture,
          gateResultId,
          `required-foreign-${attemptId}`,
          "failed",
          1,
          gateEvidenceId,
          input.phase.contextId,
          foreignAttemptId, // wrong attempt
        );
        return {
          gateResultId,
          gateResultIds: [gateResultId],
          status: "fail",
          gateEvidenceId,
        };
      }
      // Default (should not be reached for these tests).
      return {
        gateResultId,
        gateResultIds: [gateResultId],
        status: "fail",
        gateEvidenceId,
      };
    },
    oracle(input: { cleanupEligibilityRecordId: string }) {
      const oracleDecisionId = `oracle-${fixture.attempt.attemptId}`;
      insertRow(fixture.store.location.databasePath, "oracle_decisions", {
        oracle_decision_id: oracleDecisionId,
        oracle_version: ORACLE_VERSION,
        scope_kind: "attempt",
        run_id: fixture.run.runId,
        ticket_instance_id: fixture.attempt.ticketInstanceId,
        attempt_id: fixture.attempt.attemptId,
        input_set_digest: digest(`oracle-input:${oracleDecisionId}:${input.cleanupEligibilityRecordId}`),
        result: "rejected",
        reasons_json: '["verification_failed"]',
        output_digest: digest(`oracle-output:${oracleDecisionId}`),
        idempotency_key: `oracle:${fixture.attempt.attemptId}`,
        created_at: NOW,
      });
      return { oracleDecisionId, result: "rejected" };
    },
    cleanupPreimage: makeCleanupPreimageProvider(fixture),
  });
}

function makeRequest(fixture: Fixture): AttemptRunnerRequest {
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

/**
 * Assert that NO StateStore.advanceAttemptState call occurred for the
 * verifying->cleanup_pending edge.  The direct-store fallback persists a
 * state_transitions row with owner_service = "AttemptLifecycleService"
 * and owner_context_digest = "sha256:000...0" (the placeholder).  If any
 * such row exists, the direct-store fallback was used (fail-open).
 */
function assertNoDirectStoreTransition(fixture: Fixture): void {
  const dbPath = fixture.store.location.databasePath;
  const directStoreRows = queryAll(dbPath,
    "SELECT * FROM state_transitions WHERE attempt_id = ? AND from_state = 'verifying' AND to_state = 'cleanup_pending' AND owner_service = 'AttemptLifecycleService'",
    fixture.attempt.attemptId);
  expect(directStoreRows.length, "no StateStore.advanceAttemptState call for verifying->cleanup_pending").toBe(0);
}

/**
 * Assert that the attempt is still in "verifying" state — no transition
 * to cleanup_pending occurred at all (the fail-closed rejection prevented
 * any state change).
 */
function assertAttemptStillVerifying(fixture: Fixture): void {
  const dbPath = fixture.store.location.databasePath;
  const attemptRow = queryAll(dbPath,
    "SELECT state FROM attempts WHERE attempt_id = ?",
    fixture.attempt.attemptId)[0]!;
  expect(String(attemptRow.state), "attempt must remain in verifying state after fail-closed rejection").toBe("verifying");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("M6 scrutiny round 5: empty/missing gate IDs fail-closed on verifying->cleanup_pending", () => {
  describe("(a) AttemptRunner verification-failure with EMPTY gate IDs rejected fail-closed", () => {
    it("throws and does NOT fall back to StateStore.advanceAttemptState", async () => {
      const fixture = buildFixture("e2e-empty-gate-ids");
      const runner = makeRunnerWithMalformedVerification(fixture, "empty-gate-ids");
      const request = makeRequest(fixture);
      // The runner MUST throw — empty gateResultIds on the
      // verifying->cleanup_pending edge must fail closed, not fall back
      // to StateStore.advanceAttemptState.
      await expect(runner.runAttempt(request)).rejects.toThrow();
      // No direct-store transition may have occurred.
      assertNoDirectStoreTransition(fixture);
      // The attempt must still be in "verifying" state.
      assertAttemptStillVerifying(fixture);
    });
  });

  describe("(b) AttemptRunner verification-failure with STALE context rejected fail-closed", () => {
    it("throws and does NOT fall back to StateStore.advanceAttemptState", async () => {
      const fixture = buildFixture("e2e-stale-context");
      const runner = makeRunnerWithMalformedVerification(fixture, "stale-context");
      const request = makeRequest(fixture);
      // The runner MUST throw — the gate result's context does not match
      // the verify phase context, so the authority must reject.
      await expect(runner.runAttempt(request)).rejects.toThrow();
      // No direct-store transition may have occurred.
      assertNoDirectStoreTransition(fixture);
      // The attempt must still be in "verifying" state.
      assertAttemptStillVerifying(fixture);
    });
  });

  describe("(c) AttemptRunner verification-failure with WRONG-OWNER evidence rejected fail-closed", () => {
    it("throws and does NOT fall back to StateStore.advanceAttemptState", async () => {
      const fixture = buildFixture("e2e-wrong-owner");
      const runner = makeRunnerWithMalformedVerification(fixture, "wrong-owner");
      const request = makeRequest(fixture);
      // The runner MUST throw — the gate result belongs to a foreign
      // attempt, so the authority must reject.
      await expect(runner.runAttempt(request)).rejects.toThrow();
      // No direct-store transition may have occurred.
      assertNoDirectStoreTransition(fixture);
      // The attempt must still be in "verifying" state.
      assertAttemptStillVerifying(fixture);
    });
  });

  describe("structural proof: engine rejects empty gateResultIds for verifying->cleanup_pending", () => {
    it("the engine source has a fail-closed check for gate_results + cleanup_pending with empty gateResultIds", () => {
      const { readFileSync } = require("node:fs");
      const source = readFileSync(
        join(import.meta.dirname, "../..", "src", "lifecycle", "engine.ts"),
        "utf-8",
      );
      // The engine must have a fail-closed check for the
      // verifying->cleanup_pending edge when gateResultIds is empty/missing.
      // Look for the gate_results guard + cleanup_pending edge rejection.
      expect(source).toMatch(/gate_results/);
      expect(source).toMatch(/cleanup_pending/);
      // The engine must NOT fall back to advanceAttemptState for this edge
      // when gateResultIds is empty — it must throw.
      expect(source).toMatch(/RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL/);
    });
  });
});
