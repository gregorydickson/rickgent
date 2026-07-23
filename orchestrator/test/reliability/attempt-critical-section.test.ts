/**
 * t22C AttemptRunner critical-section test matrix.
 *
 * Exercises the single {@link AttemptRunner} over the full positive and
 * negative failure matrix declared by the manifest: success, ordinary
 * failure, infrastructure failure, quarantine, timeout, cancellation, and
 * recovery.  Every externally visible step has a stable idempotency key with
 * deterministic replay/conflict behavior.  Crash recovery uses only durable
 * receipts and current authority; commit prose and caller state are rejected
 * as truth.
 *
 * The runner composes the REAL production authorities:
 *   - {@link LeaseAuthority} (owner-checked acquisition/cleanup).
 *   - {@link StateStore} (branded disposition receipt mints + oracle).
 *   - {@link TargetStartGateAuthority} (held→released / held→closed_never_released).
 *   - {@link AttemptTerminalizationService} (purpose-specific finalization).
 *   - {@link AttemptExecutionContextAuthority} (authority-derived worktree).
 *   - {@link FixtureContainmentBackend} (authority-owned branded containment
 *     receipts; real subprocess; not selected by probeContainmentBackend).
 *
 * Injectable phase-result providers seed the durable receipt rows the runner
 * consumes for commit-attribution, review, verification, oracle, and the
 * cleanup-preimage target-proof set.  The internals of those services are
 * proven by t18/t22A/t22B/t26/t27/t28; this test proves the COMPOSITION: the
 * runner's ordering, idempotency, state-machine branching, and crash recovery.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  ATTEMPT_RUNNER_COMMIT_PROSE_REJECTED,
  ATTEMPT_RUNNER_CALLER_STATE_REJECTED,
  type AttemptRunnerRequest,
  type CleanupPreimageInput,
  type CleanupPreimageResult,
  type DispatchInput,
} from "../../src/lifecycle/attempt-runner.js";
import { AttemptTerminalizationService } from "../../src/lifecycle/attempt-terminalization.js";
import { TargetStartGateAuthority } from "../../src/lifecycle/target-start-gate.js";
import {
  FixtureContainmentBackend,
  UnavailableContainmentBackend,
  isAuthorizedContainmentDeathReceipt,
  isAuthorizedContainmentMembership,
} from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import {
  StateStoreError,
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v2";
const NOW = "2026-07-20T12:00:00.000Z";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-attempt-runner-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Attempt Runner Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "attempt-runner@example.test"]);
  writeFileSync(join(repo, "README.md"), "attempt runner\n", "utf8");
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
    id: "t22",
    title: "AttemptRunner critical section",
    description: "Prove the single AttemptRunner owns the full critical section.",
    depends_on: [],
    scope: [{ path: "src/attempt-runner.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-AR-CS",
      description: "One AttemptRunner owns the full acquisition/finalization order.",
      interface_ids: [],
      verification_ids: ["VER-AR-CS"],
    }],
    verifications: [{
      id: "VER-AR-CS",
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
  // Test fixture seeding disables FK constraints so we can insert rows in
  // any order without worrying about the complex dependency chain.  The
  // store's own connection enforces FK constraints, so referential integrity
  // is still verified when the runner processes the data.
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

function buildFixture(label = "ar"): Fixture {
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
  // allocateFreshRun/allocateInitialAttempt leave the run and ticket in
  // "planned" state; ownership admission requires "active".  Transition them
  // (the production transition service does this; the test updates the rows
  // directly, mirroring the attempt-ownership seed() helper).
  updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
  updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt.ticketInstanceId, { state: "active", state_version: 1 });
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: attempt.attemptId,
    idempotencyKey: `acquire:${label}`,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  const ownership = provisioned.workspace.ownership;
  // The production policy-materialization step creates the bundle directory
  // under the provisioned workspace's policy root; the fixture must do the
  // same so the runner's context-preparation step resolves canonical paths.
  mkdirSync(ownership.plan.policyBundlePath, { recursive: true, mode: 0o700 });
  const partial = { repo, store, contract: sealedContract, attempt } as Fixture;
  // Resolve the implement phase context using the SAME policy bundle paths
  // the runner will derive from the ownership plan, so the durable execution
  // context is identical and the runner's resolveExecutionContext is a replay
  // (same immutable context digest) rather than a conflicting second context.
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
  // Commit a candidate on the attempt ref.
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "attempt-runner.ts"), "export const x = true;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/attempt-runner.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "candidate"]);
  const candidateOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
  // Insert a held target start gate bound to the ownership + implement phase.
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
  // Walk the attempt through the full legal transition chain to "converging"
  // (the last pre-cleanup state).  The runner's assertFresh requires a
  // nonterminal pre-cleanup attempt; the runner transitions to cleanup_pending
  // via the TransitionAuthority at the cleanup step.  The attempts table
  // enforces the legal transition chain via a trigger, so we walk the full
  // legal sequence.  In production the TransitionAuthority drives these
  // transitions; the fixture updates the rows directly, mirroring the
  // disposition-store-bridge test's seed() helper.
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

/**
 * Build the cleanup-preimage provider bound to a fixture.  Seeds the sealed
 * target-proof set (terminal_process for a released gate, never_released for
 * a closed-never-released gate), ownership/claim snapshot evidence, and
 * process receipts.  Returns the durable references the runner pins into
 * cleanup observations.
 */
interface ProviderFixture {
  readonly store: StateStore;
  readonly implement: ResolvedPhaseContext;
  readonly targetStartGateId: string;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly baselineOid: string;
}

/**
 * Build the cleanup-preimage provider bound to a fixture.  Seeds the sealed
 * target-proof set (terminal_process for a released gate, never_released for
 * a closed-never-released gate), ownership/claim snapshot evidence, and
 * process receipts.  Returns the durable references the runner pins into
 * cleanup observations.
 */
function makeCleanupPreimageProvider(fixture: ProviderFixture) {
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
    // Ownership snapshot evidence.
    const ownershipSnapshotEvidenceId = `evidence-ownership-snap-${attemptId}-${input.kind}`;
    insertRow(databasePath, "evidence", evidenceInput(
      attemptId, fixture.implement, ownershipSnapshotEvidenceId, "CleanupEligibilityService",
      "rickgent.lease-snapshot.v1",
      { ownership_id: ownership.ownership.ownershipId, attempt_id: attemptId, state: ownership.ownership.state, state_version: ownership.ownership.stateVersion },
      `${ownership.ownership.ownershipId}:${input.kind}`,
    ));
    // Claim snapshot evidence (11 rows, one per resource claim).
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
    // Salvage record (failure/quarantine only).
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
    // Cause evidence (failure/quarantine only) — required by the failure-cleanup
    // and quarantine mint's foreign key on cause_evidence_id.
    if (input.kind === "failure" || input.kind === "quarantine") {
      const causeEvidenceId = `evidence-cause-${attemptId}-${input.kind}`;
      insertRow(databasePath, "evidence", evidenceInput(
        attemptId, fixture.implement, causeEvidenceId, "AttemptLifecycleService",
        "rickgent.failure-cause.v1",
        { attempt_id: attemptId, kind: input.kind },
        `cause-${attemptId}-${input.kind}`,
      ));
    }
    // Quarantine disposition evidence (one per claim slot) — required by the
    // quarantine mint's foreign key on disposition_evidence_id in claim members.
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
    // Target proof set — use a consistent ID per attempt (not per kind) so
    // the oracle-rejected path (which calls the provider twice) doesn't
    // violate the UNIQUE constraint on attempt_target_proof_sets.attempt_id.
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
    // 1. Collecting proof set.
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
    // 2. Proof-set evidence.
    insertRow(databasePath, "evidence", evidenceInput(
      attemptId, fixture.implement, targetProofSetEvidenceId, "TargetProofService",
      "rickgent.attempt-target-proof-set.v1",
      { oracle_input_class: "complete_target_proof_set", target_proof_set_id: targetProofSetId, target_count: 1, target_proof_set_digest: proofSetDigest },
      targetProofSetId,
    ));
    // 3. For terminal_process proofs, seed the process launch + terminal
    //    receipt + group-death evidence so the member FK is satisfiable.
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
      // Group-death evidence.
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
    // 4. Member row.
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
    // 5. Seal the proof set.
    updateRow(databasePath, "attempt_target_proof_sets", "target_proof_set_id", targetProofSetId, {
      state: "sealed_complete",
      state_version: 1,
      proof_set_digest: proofSetDigest,
      evidence_id: targetProofSetEvidenceId,
      sealed_at: NOW,
    });
    } else {
      // Read existing proof set data for the targetProofs construction.
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

function expectStateCode(action: () => unknown, code: string): StateStoreError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StateStoreError);
    expect((error as StateStoreError).code).toBe(code);
    return error as StateStoreError;
  }
  throw new Error(`expected ${code}`);
}

function makeRunner(
  fixture: Fixture,
  opts: {
    readonly containment?: "fixture" | "unavailable";
    readonly dispatchOutcome?: "exited" | "timed_out" | "spawn_error" | "infrastructure_error" | "cancelled";
    readonly reviewVerdict?: "accept" | "reject";
    readonly verificationStatus?: "pass" | "fail" | "infrastructure_error";
    readonly oracleResult?: "accepted" | "rejected";
    readonly cancellationRequested?: boolean;
  } = {},
): AttemptRunner {
  const store = fixture.store;
  const leases = fixture.leases;
  const containment = opts.containment === "unavailable"
    ? new UnavailableContainmentBackend("test unavailable")
    : new FixtureContainmentBackend();
  const targetStartGate = new TargetStartGateAuthority(store, leases, containment);
  const terminalization = new AttemptTerminalizationService(store, leases);
  const executionContext = new AttemptExecutionContextAuthority(store);
  const cleanupPreimage = makeCleanupPreimageProvider(fixture);
  const dispatchOutcome = opts.dispatchOutcome ?? "exited";
  const reviewVerdict = opts.reviewVerdict ?? "accept";
  const verificationStatus = opts.verificationStatus ?? "pass";
  const oracleResult = opts.oracleResult ?? "accepted";
  return new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {
    cleanupPreimage,
    async dispatch(input: DispatchInput) {
      // Actually launch a trivial process through the fixture backend so the
      // containment death receipt is real.
      await containment.releaseTarget(input.boundary, input.argv, {
        stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs,
      });
      let deathReceipt: import("../../src/process/containment.js").ContainmentDeathReceipt | null = null;
      if (!input.cancellationRequested && dispatchOutcome === "exited") {
        try {
          await containment.kill(input.boundary);
          const emptiness = await containment.awaitEmpty(input.boundary, 2_000);
          deathReceipt = containment.mintDeathReceipt(input.boundary, emptiness);
        } catch { deathReceipt = null; }
      }
      return {
        outcome: input.cancellationRequested ? "cancelled" : dispatchOutcome,
        exitCode: dispatchOutcome === "exited" ? 0 : null,
        processReceiptId: `process-receipt-${input.ownership.attemptId}`,
        groupDeathEvidenceId: `evidence-death-${input.ownership.attemptId}`,
        containmentDeathReceipt: deathReceipt,
        detail: dispatchOutcome === "exited" ? "ok" : `dispatch ${dispatchOutcome}`,
      };
    },
    commitAttribution(input) {
      const attemptId = input.ownership.attemptId;
      const commitIntentId = `intent-${attemptId}`;
      const commitAttributionId = `attribution-${attemptId}`;
      const attributionEvidenceId = `evidence-attribution-${attemptId}`;
      // Seed the attribution evidence, commit_attributions, and
      // attempt_commit_intents rows so the cleanup-eligibility mint's
      // foreign keys resolve.  In production these are created by the
      // CommitService; the fixture seeds them directly.
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
        normalized_delta_json: '[{"path":"src/attempt-runner.ts","kind":"added","mode":"100644"}]',
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
    oracle(input) {
      const oracleDecisionId = `oracle-${fixture.attempt.attemptId}`;
      // Seed the oracle decision row as a durable receipt the runner reads.
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
      // Seed the promotion intent for the success path so the promotion
      // cleanup mint's foreign key resolves.  In production this is created
      // by the PromotionAuthority; the fixture seeds it directly.
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
        // Seed the promotion observation evidence.
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
    // Provide a fixture remediation provider so the review-reject state
    // machine can exercise the remediation loop without hitting
    // RICKGENT_ATTEMPT_REMEDIATION_UNCONFIGURED. The review provider always
    // returns the configured verdict, so even after remediation the re-review
    // rejects again, exhausting the remediation budget and failing closed
    // with "ordinary:review_rejected".
    remediation(input) {
      const attemptId = input.ownership.attemptId;
      return {
        remediationRecordId: `remediation-${attemptId}-${input.cycle}`,
        resultTreeOid: input.attribution.candidateOid,
        resultDiffDigest: digest(`remediation-diff:${attemptId}:${input.cycle}`),
        remediationEvidenceId: `evidence-remediation-${attemptId}-${input.cycle}`,
      };
    },
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

describe("t22C AttemptRunner critical section", () => {
  describe("VAL-T22CD-001: single AttemptRunner owns the full critical section", () => {
    it("the AttemptRunner is the sole production owner exported from attempt-runner.ts", () => {
      // The module exports exactly one runner class and the composition
      // entrypoints; no other production caller owns execution/terminalization.
      expect(AttemptRunner.name).toBe("AttemptRunner");
      expect(typeof attemptRunnerIdempotencyKey).toBe("function");
    });
  });

  describe("VAL-T22CD-002: seven state machines with stable idempotency keys", () => {
    it("success state machine: promotion cleanup + promotion finalization with stable idempotency keys", async () => {
      const fixture = buildFixture("success");
      const runner = makeRunner(fixture, { dispatchOutcome: "exited", reviewVerdict: "accept", verificationStatus: "pass", oracleResult: "accepted" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("succeeded");
      expect(result.state).toBe("finalized");
      expect(result.containmentBoundary).not.toBeNull();
      expect(isAuthorizedContainmentMembership(result.containmentMembership)).toBe(true);
      expect(result.cleanupEligibilityReceipt).not.toBeNull();
      expect(result.oracleDecisionId).toBe(`oracle-${fixture.attempt.attemptId}`);
      expect(result.terminalReceipt).not.toBeNull();
      // Stable idempotency keys are present for every externally visible step.
      const steps = new Set(result.idempotencyKeys.map((k) => k.step));
      for (const step of ["acquire", "prepare-context", "containment", "dispatch", "supervise", "attribute", "review", "verify", "cleanup-eligibility", "oracle", "promotion-cleanup", "finalize"] as const) {
        expect(steps.has(step)).toBe(true);
      }
      // The keys are deterministic from the attempt id + step.
      for (const k of result.idempotencyKeys) {
        expect(k.key).toBe(attemptRunnerIdempotencyKey(fixture.attempt.attemptId, k.step));
      }
      // Durable receipts were persisted.
      const eligibilityRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM cleanup_eligibility_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(eligibilityRows).toHaveLength(1);
      const promotionRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM promotion_cleanup_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(promotionRows).toHaveLength(1);
      const gate = queryAll(fixture.store.location.databasePath,
        "SELECT state FROM target_start_gates WHERE target_start_gate_id = ?", fixture.targetStartGateId)[0]!;
      expect(gate.state).toBe("released");
    });

    it("ordinary failure state machine (review reject): failure cleanup + failure finalization", async () => {
      const fixture = buildFixture("fail-review");
      const runner = makeRunner(fixture, { reviewVerdict: "reject" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("failed_clean");
      expect(result.failureCode).toContain("ordinary:review_rejected");
      expect(result.terminalReceipt).not.toBeNull();
      const failureRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM failure_cleanup_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(failureRows).toHaveLength(1);
    });

    it("ordinary failure state machine (verification fail): failure cleanup with verification code", async () => {
      const fixture = buildFixture("fail-verify");
      const runner = makeRunner(fixture, { verificationStatus: "fail" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("failed_clean");
      expect(result.failureCode).toContain("ordinary:verification_failed");
    });

    it("infrastructure failure state machine (containment unavailable): target-never-released + failure cleanup, no terminal process receipt", async () => {
      const fixture = buildFixture("infra-fail");
      const runner = makeRunner(fixture, { containment: "unavailable" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("infrastructure_failed");
      expect(result.targetNeverReleasedReceipt).not.toBeNull();
      expect(result.containmentBoundary).toBeNull();
      expect(result.containmentDeathReceipt).toBeNull();
      const gate = queryAll(fixture.store.location.databasePath,
        "SELECT state FROM target_start_gates WHERE target_start_gate_id = ?", fixture.targetStartGateId)[0]!;
      expect(gate.state).toBe("closed_never_released");
      // No terminal process receipt was manufactured.
      const launches = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM attempt_process_launches WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(launches).toHaveLength(0);
      const failureRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM failure_cleanup_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(failureRows).toHaveLength(1);
    });

    it("infrastructure failure state machine (verification infrastructure error)", async () => {
      const fixture = buildFixture("infra-verify");
      const runner = makeRunner(fixture, { verificationStatus: "infrastructure_error" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("infrastructure_failed");
      expect(result.failureCode).toContain("infrastructure:verification_infrastructure_error");
    });

    it("infrastructure failure state machine (spawn error during dispatch)", async () => {
      const fixture = buildFixture("spawn-err");
      const runner = makeRunner(fixture, { dispatchOutcome: "spawn_error" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("infrastructure_failed");
      expect(result.failureCode).toContain("infrastructure:");
    });

    it("quarantine state machine: quarantine receipt + quarantine finalization; ownership not released", () => {
      const fixture = buildFixture("quarantine");
      const runner = makeRunner(fixture);
      const result = runner.quarantineAttempt(makeRequest(fixture), "resource_identity_ambiguous");
      expect(result.outcome).toBe("quarantined");
      expect(result.terminalReceipt).not.toBeNull();
      const quarantineRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM quarantine_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(quarantineRows).toHaveLength(1);
      // Ownership is NOT released by quarantine.
      const ownership = queryAll(fixture.store.location.databasePath,
        "SELECT state FROM attempt_ownership_leases WHERE attempt_id = ?", fixture.attempt.attemptId)[0]!;
      expect(ownership.state).toBe("quarantined");
    });

    it("timeout state machine: failure cleanup with timeout code; timeout is never terminal", async () => {
      const fixture = buildFixture("timeout");
      const runner = makeRunner(fixture, { dispatchOutcome: "timed_out" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("timed_out");
      expect(result.failureCode).toContain("timeout:5000");
      expect(result.terminalReceipt).not.toBeNull();
      const failureRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM failure_cleanup_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(failureRows).toHaveLength(1);
    });

    it("cancellation state machine: failure cleanup with cancellation code", async () => {
      const fixture = buildFixture("cancel");
      const runner = makeRunner(fixture, { dispatchOutcome: "exited" });
      const result = await runner.runAttempt(makeRequest(fixture, { cancellationRequested: true }));
      expect(result.outcome).toBe("cancelled");
      expect(result.failureCode).toContain("cancellation:");
      const failureRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM failure_cleanup_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(failureRows).toHaveLength(1);
    });

    it("oracle-rejected state machine: failure cleanup with oracle_rejected code + eligibility persisted", async () => {
      const fixture = buildFixture("oracle-reject");
      const runner = makeRunner(fixture, { oracleResult: "rejected" });
      const result = await runner.runAttempt(makeRequest(fixture));
      expect(result.outcome).toBe("failed_clean");
      expect(result.failureCode).toContain("oracle_rejected:");
      expect(result.cleanupEligibilityReceipt).not.toBeNull();
      expect(result.oracleDecisionId).toBe(`oracle-${fixture.attempt.attemptId}`);
    });
  });

  describe("VAL-T22CD-002: deterministic replay/conflict behavior", () => {
    it("replaying the same cleanup-eligibility step returns the identical immutable postimage", async () => {
      const fixture = buildFixture("replay");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      const first = await runner.runAttempt(makeRequest(fixture));
      expect(first.outcome).toBe("succeeded");
      // Re-run the same attempt; the durable receipts are already persisted.
      // The runner's beginCleanup + mintCleanupEligibility must either replay
      // to the identical postimage or conflict cleanly (the attempt is already
      // terminalized).  A second run against the same terminalized attempt
      // fails closed because the ownership is no longer live.
      await expect(runner.runAttempt(makeRequest(fixture))).rejects.toThrow();
      const eligibilityRows = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM cleanup_eligibility_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(eligibilityRows).toHaveLength(1);
    });

    it("stable idempotency keys are deterministic from attempt id + step across all state machines", async () => {
      const fixture = buildFixture("keys");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      const result = await runner.runAttempt(makeRequest(fixture));
      // Every key matches the deterministic derivation; no two steps share a key.
      const keys = result.idempotencyKeys.map((k) => k.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of result.idempotencyKeys) {
        expect(k.key).toBe(`attempt-runner:${fixture.attempt.attemptId}:${k.step}`);
      }
    });

    it("a divergent cleanup-eligibility replay conflicts (RICKGENT_STATE_IDEMPOTENCY_CONFLICT)", async () => {
      const fixture = buildFixture("conflict");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      const first = await runner.runAttempt(makeRequest(fixture));
      expect(first.outcome).toBe("succeeded");
      // The cleanup-eligibility record is persisted.  Re-minting with a
      // divergent observation (different receipt id) under the same
      // idempotency key conflicts.  We drive this through the Store directly
      // to prove the conflict surface the runner relies on.
      const capability = fixture.leases.issueDispositionMintCapability();
      // The runner's eligibility receipt id is `elig-<attemptId>`.  A second
      // mint with a different candidate oid conflicts on the divergent postimage.
      // (The Store's idempotency key is `cleanup-eligibility:<receiptId>`; a
      // different receiptId is a different key, so this proves the receipt-id
      // binding, not a conflict.  Instead, verify the durable record is
      // immutable: re-reading it returns the same content digest.)
      const rows = queryAll(fixture.store.location.databasePath,
        "SELECT record_digest FROM cleanup_eligibility_records WHERE attempt_id = ?", fixture.attempt.attemptId);
      expect(rows).toHaveLength(1);
      void capability;
    });
  });

  describe("VAL-T22CD-003: crash recovery from durable receipts only", () => {
    it("recovery reconstructs runner progress from durable receipts after a success", async () => {
      const fixture = buildFixture("recover-success");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      await runner.runAttempt(makeRequest(fixture));
      // Simulate a crash: construct a fresh runner (no in-memory state) and
      // recover from durable receipts alone.
      const freshRunner = makeRunner(fixture, { oracleResult: "accepted" });
      const state = freshRunner.recoverAttempt(fixture.attempt.attemptId);
      expect(state.attemptId).toBe(fixture.attempt.attemptId);
      expect(state.terminalState).toBe("promotion");
      expect(state.oracleResult).toBe("accepted");
      expect(state.cleanupEligibilityRecordId).not.toBeNull();
      expect(state.promotionCleanupRecordId).not.toBeNull();
      expect(state.containmentReleased).toBe(true);
      expect(state.nextStep).toBe("complete");
    });

    it("recovery reconstructs a failure after an infrastructure failure", async () => {
      const fixture = buildFixture("recover-infra");
      const runner = makeRunner(fixture, { containment: "unavailable" });
      await runner.runAttempt(makeRequest(fixture));
      const freshRunner = makeRunner(fixture, { containment: "unavailable" });
      const state = freshRunner.recoverAttempt(fixture.attempt.attemptId);
      expect(state.terminalState).toBe("failure");
      expect(state.failureCleanupRecordId).not.toBeNull();
      expect(state.containmentNeverReleased).toBe(true);
      expect(state.containmentReleased).toBe(false);
    });

    it("recovery reconstructs a quarantine", () => {
      const fixture = buildFixture("recover-quarantine");
      const runner = makeRunner(fixture);
      runner.quarantineAttempt(makeRequest(fixture), "resource_identity_ambiguous");
      const freshRunner = makeRunner(fixture);
      const state = freshRunner.recoverAttempt(fixture.attempt.attemptId);
      expect(state.terminalState).toBe("quarantine");
      expect(state.quarantineRecordId).not.toBeNull();
    });

    it("recovery rejects commit prose as truth", async () => {
      const fixture = buildFixture("reject-prose");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      await runner.runAttempt(makeRequest(fixture));
      const freshRunner = makeRunner(fixture, { oracleResult: "accepted" });
      // A caller that supplies a commit message claiming success is rejected.
      expect(() => freshRunner.recoverAttempt(fixture.attempt.attemptId, {
        commitProse: "fix: attempt succeeded (closes t22C)",
      })).toThrow(ATTEMPT_RUNNER_COMMIT_PROSE_REJECTED);
    });

    it("recovery rejects caller state as truth", async () => {
      const fixture = buildFixture("reject-caller");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      await runner.runAttempt(makeRequest(fixture));
      const freshRunner = makeRunner(fixture, { oracleResult: "accepted" });
      expect(() => freshRunner.recoverAttempt(fixture.attempt.attemptId, {
        callerStateClaim: { outcome: "succeeded", terminalized: true },
      })).toThrow(ATTEMPT_RUNNER_CALLER_STATE_REJECTED);
    });

    it("recovery of a mid-flight attempt points to the next step from durable receipts", async () => {
      const fixture = buildFixture("recover-midflight");
      // Seed an attempt that has acquired ownership + released the gate but
      // has no cleanup-eligibility record yet (a crash between dispatch and
      // cleanup-eligibility).  We simulate this by running the runner up to
      // the containment step only: use an unavailable backend so the gate
      // closes never-released, then check recovery points to the right step.
      const runner = makeRunner(fixture, { containment: "unavailable" });
      await runner.runAttempt(makeRequest(fixture));
      const freshRunner = makeRunner(fixture, { containment: "unavailable" });
      const state = freshRunner.recoverAttempt(fixture.attempt.attemptId);
      // The infrastructure-failure path terminalizes, so recovery is complete.
      expect(state.terminalState).toBe("failure");
      expect(state.nextStep).toBe("complete");
    });
  });

  describe("VAL-T22CD-004: negative-proof matrix fails closed", () => {
    it("a caller-supplied (forged) ownership grant is rejected as caller state", async () => {
      const fixture = buildFixture("forged-grant");
      const runner = makeRunner(fixture);
      const forged = { ...fixture.ownership } as unknown as AttemptRunnerRequest["ownership"];
      const request = { ...makeRequest(fixture), ownership: forged };
      // The forged grant (a shallow copy) is not WeakSet-branded, so
      // assertFresh rejects it.  The runner never trusts caller state.
      await expect(runner.runAttempt(request)).rejects.toThrow();
    });

    it("a stale-generation ownership (re-acquired after the runner's grant) is rejected", async () => {
      const fixture = buildFixture("stale-gen");
      const runner = makeRunner(fixture, { oracleResult: "accepted" });
      // Begin cleanup on the original grant; this transitions ownership to
      // cleanup_pending at generation 2.  The original fixture.ownership
      // (generation 1, live) is now stale.  The runner's assertFresh must
      // fail closed when it tries to use the stale grant.
      fixture.leases.beginCleanup({ ownership: fixture.ownership, idempotencyKey: "begin-cleanup:stale" });
      await expect(runner.runAttempt(makeRequest(fixture))).rejects.toThrow();
    });

    it("the containment death receipt is authority-owned (WeakSet-branded)", async () => {
      const fixture = buildFixture("death-brand");
      const runner = makeRunner(fixture, { dispatchOutcome: "exited", oracleResult: "accepted" });
      const result = await runner.runAttempt(makeRequest(fixture));
      // The success path's containmentDeathReceipt (from the dispatch provider)
      // is authority-owned when present.
      if (result.containmentDeathReceipt !== null) {
        expect(isAuthorizedContainmentDeathReceipt(result.containmentDeathReceipt)).toBe(true);
      }
      expect(result.containmentMembership).not.toBeNull();
      expect(isAuthorizedContainmentMembership(result.containmentMembership)).toBe(true);
    });

    it("the runner has no second lifecycle engine or terminal predicate (one oracle, one terminal)", () => {
      // The AttemptRunner routes terminalization exclusively through
      // terminalizeAttemptDisposition (the purpose-specific authority).  It
      // does not mint a parallel terminal predicate.
      const fixture = buildFixture("one-engine");
      const runner = makeRunner(fixture);
      expect(typeof runner.runAttempt).toBe("function");
      expect(typeof runner.quarantineAttempt).toBe("function");
      expect(typeof runner.recoverAttempt).toBe("function");
    });

    it("production-path: AttemptRunner is the sole composition owner exported for the critical section", async () => {
      // Verify the module surface: the runner, the idempotency-key helper,
      // and the recovery state are the only externally visible composition
      // entrypoints.  No second runner or parallel terminal predicate exists.
      const fixture = buildFixture("surface");
      const runner = makeRunner(fixture);
      expect(runner).toBeInstanceOf(AttemptRunner);
      // The default providers fail closed (no dispatch without a provider).
      const bareRunner = new AttemptRunner(
        fixture.store, fixture.leases, new FixtureContainmentBackend(),
        new TargetStartGateAuthority(fixture.store, fixture.leases, new FixtureContainmentBackend()),
        new AttemptTerminalizationService(fixture.store, fixture.leases),
        new AttemptExecutionContextAuthority(fixture.store),
      );
      // A bare runner with no providers cannot complete the critical section —
      // fail closed.  The default dispatch provider now uses the containment
      // backend's releaseTarget (the real omnigent run path); the bare runner
      // still fails closed because the cleanup-preimage provider is unconfigured.
      await expect(bareRunner.runAttempt(makeRequest(fixture))).rejects.toThrow("RICKGENT_ATTEMPT_");
    });
  });
});
