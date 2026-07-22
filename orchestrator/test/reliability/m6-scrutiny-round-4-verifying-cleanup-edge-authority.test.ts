/**
 * M6 scrutiny round 4 fix — verifying->cleanup_pending edge authority.
 *
 * Captures two blocking defects:
 *
 * (1) engine.ts has no gate_results guard for the declared
 *     verifying->cleanup_pending edge.  AttemptRunner verification failure
 *     reaches that edge, then LifecycleEngine falls back to
 *     StateStore.advanceAttemptState, persisting neither validated context
 *     nor transition evidence (and using the wrong owner_service
 *     "AttemptLifecycleService" and a placeholder context digest).
 *
 * (2) The cleanup-transition-authority regression suite (round 3) does not
 *     drive AttemptRunner's verification-failure branch, so it misses the
 *     direct-store fallback.
 *
 * The fix:
 *   - Adds a gate_results guard case to guardForEdge in engine.ts.
 *   - Modifies the store's gate_results guard validation to handle the
 *     failure path (toState = "cleanup_pending"): at least one required gate
 *     must NOT pass (instead of all required gates must pass).
 *   - Routes the AttemptRunner verification-failure branch through
 *     TransitionAuthority with the verify phase context, gate result IDs,
 *     and gate result evidence references.
 *
 * Red-then-green proof: the tests below fail against the unfixed code (which
 * falls back to advanceAttemptState, persisting no evidence refs and using a
 * placeholder owner_context_digest + wrong owner_service) and pass after the
 * fix routes through the authority.
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
import {
  LifecycleEngine,
  LifecycleEngineError,
} from "../../src/lifecycle/engine.js";
import {
  TransitionAuthority,
  type ExistingTransitionEvidenceReference,
  type InlineTransitionEvidenceReference,
} from "../../src/state/transitions.js";
import { legalPhaseEdge } from "../../src/lifecycle/phase.js";

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "m6-scrutiny-r4-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M6 Scrutiny R4 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m6-scrutiny-r4@example.test"]);
  writeFileSync(join(repo, "README.md"), "m6 scrutiny r4\n", "utf8");
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
    title: "M6 scrutiny round 4 verifying cleanup edge authority",
    description: "Exercise the verifying->cleanup_pending gate_results guard.",
    depends_on: [],
    scope: [{ path: "src/m6-r4.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M6-R4",
      description: "verifying->cleanup_pending routes through TransitionAuthority with gate_results guard.",
      interface_ids: [],
      verification_ids: ["VER-M6-R4"],
    }],
    verifications: [{
      id: "VER-M6-R4",
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
  readonly verify: ResolvedPhaseContext;
  readonly targetStartGateId: string;
  readonly candidateOid: string;
  readonly baselineOid: string;
}

function buildFixture(label = "r4"): Fixture {
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
  // Create the verification phase context (needed for gate_results guard
  // validation — the gate results' context_id must resolve to this context).
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
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "m6-r4.ts"), "export const x = true;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/m6-r4.ts"]);
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
  // Walk the attempt through each legal forward state up to "verifying"
  // (the SQLite attempts_legal_edge trigger rejects direct jumps, so each
  // update must be a legal edge).  state_version increments by 1 per step,
  // matching the forward lifecycle: planned(0) -> implementing(1) ->
  // implementation_captured(2) -> reviewing(3) -> verification_queued(4) ->
  // verifying(5).
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

/**
 * Insert a gate result row into the gate_results table.
 * Returns the gate_result_id.
 */
function insertGateResult(
  fixture: Fixture,
  gateResultId: string,
  gateId: string,
  status: "passed" | "failed",
  required: 0 | 1,
  evidenceId: string,
  contextId: string,
): string {
  const databasePath = fixture.store.location.databasePath;
  insertRow(databasePath, "evidence", evidenceInput(
    fixture.attempt.attemptId, fixture.verify, evidenceId, "VerificationService",
    "rickgent.gate-result.v1",
    { gate_id: gateId, status, required, attempt_id: fixture.attempt.attemptId },
    `gate-result:${gateResultId}`,
  ));
  insertRow(databasePath, "gate_results", {
    gate_result_id: gateResultId,
    attempt_id: fixture.attempt.attemptId,
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
        normalized_delta_json: '[{"path":"src/m6-r4.ts","kind":"added","mode":"100644"}]',
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
    verification(input: VerificationInput): VerificationResult {
      const attemptId = fixture.attempt.attemptId;
      const gateResultId = `gate-${attemptId}`;
      const gateEvidenceId = `evidence-gate-${attemptId}`;
      // Insert a gate result with the verification phase context.
      // For the failure case, the required gate has status "failed".
      // For the success case, the required gate has status "passed".
      const status = verificationStatus === "pass" ? "passed" as const : "failed" as const;
      insertGateResult(
        fixture,
        gateResultId,
        `required-${attemptId}`,
        status,
        1,
        gateEvidenceId,
        input.phase.contextId,
      );
      return {
        gateResultId,
        gateResultIds: [gateResultId],
        status: verificationStatus,
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
        result: oracleResult,
        reasons_json: oracleResult === "accepted" ? "[]" : '["verification_failed"]',
        output_digest: digest(`oracle-output:${oracleDecisionId}`),
        idempotency_key: `oracle:${fixture.attempt.attemptId}`,
        created_at: NOW,
      });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("M6 scrutiny round 4: verifying->cleanup_pending edge authority", () => {
  describe("(a) AttemptRunner verification-failure routes through TransitionAuthority", () => {
    it("the cleanup transition persists evidence refs, real context digest, and correct owner_service", async () => {
      const fixture = buildFixture("e2e-pos-r4");
      const runner = makeRunner(fixture, { verificationStatus: "fail" });
      const request = makeRequest(fixture);
      const result = await runner.runAttempt(request);
      // The attempt should terminalize as failed_clean (verification failed).
      expect(result.outcome).toBe("failed_clean");
      const dbPath = fixture.store.location.databasePath;
      // Find the verifying->cleanup_pending transition.
      const cleanupTransition = queryAll(dbPath,
        "SELECT * FROM state_transitions WHERE attempt_id = ? AND from_state = 'verifying' AND to_state = 'cleanup_pending' ORDER BY entity_sequence DESC LIMIT 1",
        fixture.attempt.attemptId)[0]!;
      // The authority path persists the REAL context digest (not the
      // placeholder sha256:000...0 used by advanceAttemptState).
      expect(String(cleanupTransition.owner_context_digest)).not.toBe("sha256:" + "0".repeat(64));
      // The authority path uses the edge's owner_service ("VerificationService"),
      // not the hardcoded "AttemptLifecycleService" from advanceAttemptState.
      expect(String(cleanupTransition.owner_service)).toBe("VerificationService");
      // Evidence refs MUST be persisted (only the authority path does this).
      const evidenceRefs = queryAll(dbPath,
        "SELECT * FROM transition_evidence_refs WHERE transition_id = ?",
        String(cleanupTransition.transition_id));
      expect(evidenceRefs.length).toBeGreaterThan(0);
      // The evidence must include the gate result evidence reference.
      const gateEvidenceRef = evidenceRefs.find((r) => String(r.purpose) === "gate_result");
      expect(gateEvidenceRef).toBeDefined();
      // The evidence must include the failure evidence reference.
      const failureRef = evidenceRefs.find((r) => String(r.purpose) === "failure");
      expect(failureRef).toBeDefined();
    });
  });

  describe("(b) missing evidence rejected for verifying->cleanup_pending", () => {
    it("rejects a verifying->cleanup_pending edge with NO evidence when authority is bound", () => {
      const fixture = buildFixture("neg-missing-r4");
      // Insert a failed required gate result for the verify context.
      insertGateResult(
        fixture,
        `gate-${fixture.attempt.attemptId}`,
        `required-${fixture.attempt.attemptId}`,
        "failed",
        1,
        `evidence-gate-${fixture.attempt.attemptId}`,
        fixture.verify.persisted.contextId,
      );
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      expect(() => engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "verifying",
        to: "cleanup_pending",
        idempotencyKey: "neg-missing-evidence-r4",
        contextDigest: fixture.verify.canonical.contextDigest,
        gateResultIds: [`gate-${fixture.attempt.attemptId}`],
      })).toThrow(LifecycleEngineError);
    });
  });

  describe("(c) stale context evidence rejected for verifying->cleanup_pending", () => {
    it("rejects a verifying->cleanup_pending edge with a wrong contextDigest", () => {
      const fixture = buildFixture("neg-stale-r4");
      insertGateResult(
        fixture,
        `gate-${fixture.attempt.attemptId}`,
        `required-${fixture.attempt.attemptId}`,
        "failed",
        1,
        `evidence-gate-${fixture.attempt.attemptId}`,
        fixture.verify.persisted.contextId,
      );
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      const edge = legalPhaseEdge("verifying", "cleanup_pending")!;
      const evidence: InlineTransitionEvidenceReference = Object.freeze({
        purpose: "failure",
        inlineEvidence: Object.freeze({
          contextId: fixture.verify.persisted.contextId,
          producerService: edge.evidenceProducer,
          scope: `stale-cleanup:${fixture.attempt.attemptId}`,
          schemaVersion: "rickgent.cleanup-transition.v1",
          payload: Object.freeze({
            attempt_id: fixture.attempt.attemptId,
            failure_reason: "test_stale",
            from_state: "verifying",
            to_state: "cleanup_pending",
            context_digest: fixture.verify.canonical.contextDigest,
          }),
          idempotencyKey: "stale-context-r4-inline",
        }),
      });
      // Add the gate result evidence reference.
      const gateEvidenceRef: ExistingTransitionEvidenceReference = Object.freeze({
        purpose: "gate_result",
        evidenceId: `evidence-gate-${fixture.attempt.attemptId}`,
      });
      const wrongDigest = "sha256:000000000000000000000000000000000000000000000000000000000000000a";
      expect(() => engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "verifying",
        to: "cleanup_pending",
        idempotencyKey: "neg-stale-context-r4",
        evidence: [evidence, gateEvidenceRef],
        contextDigest: wrongDigest,
        gateResultIds: [`gate-${fixture.attempt.attemptId}`],
      })).toThrow();
    });
  });

  describe("(d) wrong-owner evidence rejected for verifying->cleanup_pending", () => {
    it("rejects inline evidence whose producerService does not match the edge owner", () => {
      const fixture = buildFixture("neg-owner-r4");
      insertGateResult(
        fixture,
        `gate-${fixture.attempt.attemptId}`,
        `required-${fixture.attempt.attemptId}`,
        "failed",
        1,
        `evidence-gate-${fixture.attempt.attemptId}`,
        fixture.verify.persisted.contextId,
      );
      const authority = new TransitionAuthority(fixture.store);
      const engine = new LifecycleEngine(fixture.store, authority);
      const wrongOwnerEvidence: InlineTransitionEvidenceReference = Object.freeze({
        purpose: "failure",
        inlineEvidence: Object.freeze({
          contextId: fixture.verify.persisted.contextId,
          producerService: "WrongService",
          scope: `wrong-owner-cleanup:${fixture.attempt.attemptId}`,
          schemaVersion: "rickgent.cleanup-transition.v1",
          payload: Object.freeze({
            attempt_id: fixture.attempt.attemptId,
            failure_reason: "test_wrong_owner",
            from_state: "verifying",
            to_state: "cleanup_pending",
            context_digest: fixture.verify.canonical.contextDigest,
          }),
          idempotencyKey: "wrong-owner-r4-inline",
        }),
      });
      const gateEvidenceRef: ExistingTransitionEvidenceReference = Object.freeze({
        purpose: "gate_result",
        evidenceId: `evidence-gate-${fixture.attempt.attemptId}`,
      });
      expect(() => engine.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "verifying",
        to: "cleanup_pending",
        idempotencyKey: "neg-wrong-owner-r4",
        evidence: [wrongOwnerEvidence, gateEvidenceRef],
        contextDigest: fixture.verify.canonical.contextDigest,
        gateResultIds: [`gate-${fixture.attempt.attemptId}`],
      })).toThrow();
    });
  });

  describe("structural proof: engine routes verifying->cleanup_pending through gate_results guard", () => {
    it("guardForEdge handles the gate_results guard kind (not returning null)", () => {
      const source = readFileSync(
        join(import.meta.dirname, "../..", "src", "lifecycle", "engine.ts"),
        "utf-8",
      );
      // The guardForEdge function must have a case for "gate_results".
      expect(source).toMatch(/case "gate_results"/);
    });

    it("AttemptRunner verification-failure passes gateResultIds and verifyPhase to #beginCleanupPhase", () => {
      const source = readFileSync(
        join(import.meta.dirname, "../..", "src", "lifecycle", "attempt-runner.ts"),
        "utf-8",
      );
      // The verification-failure branch must pass the verification gate result
      // IDs to #beginCleanupPhase.  Match the branch up to the killAndMintDeath
      // call so the full #beginCleanupPhase call is captured.
      const verifyFailMatch = source.match(/if \(verification\.status !== "pass"\) \{[\s\S]*?#killAndMintDeath/);
      expect(verifyFailMatch, "verification-failure branch must exist").not.toBeNull();
      const branchBody = verifyFailMatch![0];
      // The branch must reference verification.gateResultIds (passing them to
      // #beginCleanupPhase).
      expect(branchBody).toMatch(/verification\.gateResultIds/);
      // The branch must use the verifyPhase (not productionPhase) so the
      // gate_results guard validates against the verification context.
      expect(branchBody).toMatch(/verifyPhase/);
    });
  });
});
