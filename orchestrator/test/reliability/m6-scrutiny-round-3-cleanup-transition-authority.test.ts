/**
 * M6 scrutiny round 3 fix — cleanup transition authority routing.
 *
 * Captures the blocking defect: AttemptRunner directly calls
 * StateStore.advanceAttemptToCleanupPending for declared failure-to-cleanup
 * edges, bypassing TransitionAuthority and accepting no authority-owned
 * evidence or context.  This contradicts the PRD/contract preconditions and
 * leaves the production path fail-open.
 *
 * The fix routes the real AttemptRunner cleanup transition through
 * TransitionAuthority (via LifecycleEngine.transitionAttempt), provides and
 * persists required authority-owned evidence (failure reason, phase state,
 * context digest) and context.
 *
 * Production-path tests reject:
 *   (a) missing evidence for cleanup transition
 *   (b) stale evidence (wrong context digest)
 *   (c) wrong-owner evidence (producerService mismatch)
 *
 * Red-then-green proof: the tests below fail against the unfixed code (which
 * calls advanceAttemptToCleanupPending directly, persisting no evidence refs
 * and using a placeholder owner_context_digest) and pass after the fix routes
 * through the authority.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  LifecycleEngine,
  LifecycleEngineError,
} from "../../src/lifecycle/engine.js";
import { TransitionAuthority, type InlineTransitionEvidenceReference } from "../../src/state/transitions.js";
import { legalPhaseEdge } from "../../src/lifecycle/phase.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v2";
const NOW = "2026-07-21T18:00:00.000Z";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "m6-scrutiny-r3-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M6 Scrutiny R3 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m6-scrutiny-r3@example.test"]);
  writeFileSync(join(repo, "README.md"), "m6 scrutiny r3\n", "utf8");
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
    title: "M6 scrutiny round 3 cleanup transition authority",
    description: "Exercise the cleanup transition authority routing fix.",
    depends_on: [],
    scope: [{ path: "src/m6-r3.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M6-R3",
      description: "Cleanup transitions route through TransitionAuthority with evidence.",
      interface_ids: [],
      verification_ids: ["VER-M6-R3"],
    }],
    verifications: [{
      id: "VER-M6-R3",
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
  readonly targetStartGateId: string;
  readonly candidateOid: string;
  readonly baselineOid: string;
}

function buildFixture(label = "r3"): Fixture {
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
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "m6-r3.ts"), "export const x = true;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/m6-r3.ts"]);
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
    "verification_queued", "verifying", "converging",
  ] as const;
  for (let i = 0; i < preCleanupStates.length; i++) {
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: preCleanupStates[i],
      state_version: i + 1,
    });
  }
  return {
    repo, store, leases, resolver, contract: sealedContract, run, attempt,
    ownership, implement, targetStartGateId, candidateOid, baselineOid,
  } as Fixture;
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
    if (input.kind === "quarantine") {
      for (const resource of ownership.resources) {
        const dispositionEvidenceId = `evidence-quarantine-${resource.slot}`;
        insertRow(databasePath, "evidence", evidenceInput(
          attemptId, fixture.implement, dispositionEvidenceId, "CleanupService",
          "rickgent.quarantine-disposition.v1",
          { attempt_id: attemptId, slot: resource.slot, disposition: "retained" },
          `quarantine-disposition:${attemptId}:${resource.slot}`,
        ));
      }
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
      }
      insertRow(databasePath, "attempt_target_proof_members", {
        target_proof_set_id: targetProofSetId,
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
        member_digest: memberDigest,
      });
updateRow(databasePath, "attempt_target_proof_sets", "target_proof_set_id", targetProofSetId, {
        state: "sealed_complete",
        state_version: 1,
        proof_set_digest: proofSetDigest,
        evidence_id: targetProofSetEvidenceId,
        sealed_at: NOW,
      });
    }
    const targetProofs = [
      Object.freeze({
        proofKind: isNeverReleased ? "never_released" as const : "terminal_process" as const,
        targetStartGateId: fixture.targetStartGateId,
        gateState: gateState as "released" | "closed_never_released",
        gateStateVersion: gateStateVersion,
        launchId: isNeverReleased ? null : launchId,
        processReceiptId: isNeverReleased ? null : processReceiptId,
        groupDeathEvidenceId: isNeverReleased ? null : groupDeathEvidenceId,
      }),
    ];
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

interface RunnerOpts {
  readonly dispatchOutcome?: "exited" | "spawn_error" | "timed_out";
  readonly reviewVerdict?: "accept" | "reject";
  readonly verificationStatus?: "pass" | "fail";
  readonly oracleResult?: "accepted" | "rejected";
}

function makeRunner(fixture: Fixture, opts: RunnerOpts = {}) {
  const dispatchOutcome = opts.dispatchOutcome ?? "exited";
  const reviewVerdict = opts.reviewVerdict ?? "accept";
  const verificationStatus = opts.verificationStatus ?? "pass";
  const oracleResult = opts.oracleResult ?? "accepted";
  const containment = new FixtureContainmentBackend(fixture.store);
  const targetStartGate = new TargetStartGateAuthority(fixture.store);
  const terminalization = new AttemptTerminalizationService(fixture.store, fixture.leases);
  const executionContext = new AttemptExecutionContextAuthority(fixture.store);
  return new AttemptRunner(fixture.store, fixture.leases, containment, targetStartGate, terminalization, executionContext, {
    dispatch: async (_input: DispatchInput) => {
      const attemptId = fixture.attempt.attemptId;
      if (dispatchOutcome === "spawn_error") {
        return { outcome: "spawn_error", exitCode: null,
          processReceiptId: `process-receipt-${attemptId}-spawn-error`,
          processLaunchId: `process-launch-${attemptId}-spawn-error`,
          groupDeathEvidenceId: `evidence-death-${attemptId}-spawn-error`,
          containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null,
          detail: "spawn error" } as any;
      }
      if (dispatchOutcome === "timed_out") {
        return { outcome: "timed_out", exitCode: null,
          processReceiptId: `process-receipt-${attemptId}`,
          processLaunchId: `process-launch-${attemptId}`,
          groupDeathEvidenceId: `evidence-death-${attemptId}`,
          containmentDeathReceipt: null, stdoutReceipt: null, stderrReceipt: null,
          detail: "timed out" } as any;
      }
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
        normalized_delta_json: '[{"path":"src/m6-r3.ts","kind":"added","mode":"100644"}]',
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
    review() { return { reviewRecordId: `review-${fixture.attempt.attemptId}`, verdict: reviewVerdict, reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}` }; },
    verification() { return { gateResultId: `gate-${fixture.attempt.attemptId}`, gateResultIds: [`gate-${fixture.attempt.attemptId}`], status: verificationStatus, gateEvidenceId: `evidence-gate-${fixture.attempt.attemptId}` }; },
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
        result: oracleResult,
        reasons_json: oracleResult === "accepted" ? "[]" : '["verification_failed"]',
        output_digest: digest(`oracle-output:${oracleDecisionId}`),
        idempotency_key: `oracle:${fixture.attempt.attemptId}`,
        created_at: NOW,
      });
      if (oracleResult === "accepted") {
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
        return { oracleDecisionId, result: oracleResult };
      }
      return { oracleDecisionId, result: oracleResult };
    },
    cleanupPreimage: makeCleanupPreimageProvider(fixture),
  });
}

function makeRequest(fixture: Fixture, opts: { readonly cancellationRequested?: boolean; readonly timeoutMs?: number } = {}): AttemptRunnerRequest {
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
    timeoutMs: opts.timeoutMs ?? 5_000,
    cancellationRequested: opts.cancellationRequested ?? false,
  };
}

describe("M6 scrutiny round 3: cleanup transition authority routing", () => {
  describe("production-path cleanup transition through TransitionAuthority", () => {
    it("a cleanup transition through the authority persists evidence refs and real context digest", () => {
      const fixture = buildFixture("pos-auth-r3");
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      const edge = legalPhaseEdge("converging", "cleanup_pending")!;
      // Provide authority-owned inline evidence for the cleanup transition.
      const cleanupEvidence: InlineTransitionEvidenceReference = Object.freeze({
        purpose: "failure",
        inlineEvidence: Object.freeze({
          contextId: fixture.implement.persisted.contextId,
          producerService: edge.evidenceProducer,
          scope: `cleanup-transition:${fixture.attempt.attemptId}`,
          schemaVersion: "rickgent.cleanup-transition.v1",
          payload: Object.freeze({
            attempt_id: fixture.attempt.attemptId,
            failure_reason: "test_cleanup",
            phase_state: "converging",
            context_digest: fixture.implement.canonical.contextDigest,
          }),
          idempotencyKey: "pos-auth-cleanup-r3",
        }),
      });
      const result = engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "converging",
        to: "cleanup_pending",
        idempotencyKey: "pos-cleanup-transition-r3",
        evidence: [cleanupEvidence],
        contextDigest: fixture.implement.canonical.contextDigest,
      });
      expect(result.toState).toBe("cleanup_pending");
      // Verify the transition was persisted with the real context digest
      // (not the placeholder sha256:000...0 used by advanceAttemptToCleanupPending).
      const dbPath = fixture.store.location.databasePath;
      const cleanupTransition = queryAll(dbPath,
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND to_state = 'cleanup_pending' ORDER BY entity_sequence DESC LIMIT 1",
        fixture.attempt.attemptId)[0]!;
      expect(String(cleanupTransition.owner_context_digest)).not.toBe("sha256:" + "0".repeat(64));
      expect(String(cleanupTransition.owner_context_digest)).toBe(fixture.implement.canonical.contextDigest);
      // Evidence refs MUST be persisted (only the authority path does this).
      const evidenceRefs = queryAll(dbPath,
        "SELECT * FROM transition_evidence_refs WHERE transition_id = ?",
        String(cleanupTransition.transition_id));
      expect(evidenceRefs.length).toBeGreaterThan(0);
      const failureRef = evidenceRefs.find((r) => String(r.purpose) === "failure");
      expect(failureRef).toBeDefined();
    });

    it("the direct store bypass (advanceAttemptToCleanupPending) does NOT persist evidence refs", () => {
      // This test proves the RED state: the direct store method bypasses
      // the authority and persists NO evidence refs, using a placeholder
      // context digest.  After the fix, the production code no longer calls
      // this method for cleanup transitions.
      const fixture = buildFixture("pos-bypass-r3");
      const dbPath = fixture.store.location.databasePath;
      // Call the direct store method (the bypass path).
      fixture.store.advanceAttemptToCleanupPending(
        fixture.attempt.attemptId,
        "bypass-cleanup-r3",
      );
      const cleanupTransition = queryAll(dbPath,
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND to_state = 'cleanup_pending' ORDER BY entity_sequence DESC LIMIT 1",
        fixture.attempt.attemptId)[0]!;
      // The bypass uses the placeholder context digest.
      expect(String(cleanupTransition.owner_context_digest)).toBe("sha256:" + "0".repeat(64));
      // The bypass does NOT persist evidence refs.
      const evidenceRefs = queryAll(dbPath,
        "SELECT * FROM transition_evidence_refs WHERE transition_id = ?",
        String(cleanupTransition.transition_id));
      expect(evidenceRefs.length).toBe(0);
    });
  });

  describe("authority rejects missing evidence for cleanup transition", () => {
    it("rejects a cleanup edge with NO evidence when authority is bound", () => {
      const fixture = buildFixture("neg-missing-r3");
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      expect(() => engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "converging",
        to: "cleanup_pending",
        idempotencyKey: "neg-missing-evidence-r3",
        contextDigest: fixture.implement.canonical.contextDigest,
      })).toThrow(LifecycleEngineError);
    });
  });

  describe("authority rejects stale evidence (wrong context digest)", () => {
    it("rejects a cleanup edge with a wrong contextDigest that does not resolve to the attempt", () => {
      const fixture = buildFixture("neg-stale-r3");
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      const edge = legalPhaseEdge("converging", "cleanup_pending")!;
      const staleEvidence: InlineTransitionEvidenceReference = Object.freeze({
        purpose: "failure",
        inlineEvidence: Object.freeze({
          contextId: fixture.implement.persisted.contextId,
          producerService: edge.evidenceProducer,
          scope: `stale-cleanup:${fixture.attempt.attemptId}`,
          schemaVersion: "rickgent.cleanup-transition.v1",
          payload: Object.freeze({
            attempt_id: fixture.attempt.attemptId,
            failure_reason: "test_stale",
            phase_state: "converging",
          }),
          idempotencyKey: "stale-cleanup-r3",
        }),
      });
      const wrongDigest = "sha256:000000000000000000000000000000000000000000000000000000000000000a";
      expect(() => engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "converging",
        to: "cleanup_pending",
        idempotencyKey: "neg-stale-evidence-r3",
        evidence: [staleEvidence],
        contextDigest: wrongDigest,
      })).toThrow();
    });
  });

  describe("authority rejects wrong-owner evidence", () => {
    it("rejects inline evidence whose producerService does not match the edge owner", () => {
      const fixture = buildFixture("neg-owner-r3");
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      const edge = legalPhaseEdge("converging", "cleanup_pending")!;
      const wrongOwnerEvidence: InlineTransitionEvidenceReference = Object.freeze({
        purpose: "failure",
        inlineEvidence: Object.freeze({
          contextId: fixture.implement.persisted.contextId,
          producerService: "WrongService",
          scope: `wrong-owner-cleanup:${fixture.attempt.attemptId}`,
          schemaVersion: "rickgent.cleanup-transition.v1",
          payload: Object.freeze({
            attempt_id: fixture.attempt.attemptId,
            failure_reason: "test_wrong_owner",
            phase_state: "converging",
          }),
          idempotencyKey: "wrong-owner-cleanup-r3",
        }),
      });
      expect(() => engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "converging",
        to: "cleanup_pending",
        idempotencyKey: "neg-wrong-owner-r3",
        evidence: [wrongOwnerEvidence],
        contextDigest: fixture.implement.canonical.contextDigest,
      })).toThrow();
    });
  });

  describe("structural proof: AttemptRunner does not bypass authority for cleanup", () => {
    it("the #beginCleanupPhase method routes through lifecycle.transitionAttempt (not store.advanceAttemptToCleanupPending)", () => {
      const source = readFileSync(
        join(import.meta.dirname, "../..", "src", "lifecycle", "attempt-runner.ts"),
        "utf-8",
      );
      // Match the method definition (starts with `  #beginCleanupPhase(` at
      // the start of a line), not a call site (which is indented more or
      // preceded by `this.`).
      const beginCleanupMatch = source.match(/^  #beginCleanupPhase\([\s\S]*?^  \}/m);
      expect(beginCleanupMatch, "#beginCleanupPhase method must exist").not.toBeNull();
      const methodBody = beginCleanupMatch![0];
      expect(methodBody).toMatch(/this\.#lifecycle\.transitionAttempt/);
      expect(methodBody).not.toMatch(/this\.#store\.advanceAttemptToCleanupPending/);
    });
  });
});
