import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver, type ResolvedPhaseContext } from "../../src/context/resolver.js";
import { deriveOracleAttributionDigests, type OracleNormalizedDeltaEntry } from "../../src/state/oracle.js";
import {
  StateStoreError,
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateRecord,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v1";
const NOW = "2026-07-16T12:00:00.000Z";
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
    typeof value === "string" ? value : canonicalJson(value),
    "utf8",
  ).digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-oracle-store-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Oracle Store Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "oracle-store@example.test"]);
  writeFileSync(join(repo, "README.md"), "oracle store\n", "utf8");
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
    id: "t15",
    title: "Store-owned oracle",
    description: "Prove atomic Store-owned completion-oracle input resolution.",
    depends_on: [],
    scope: [{ path: "src/oracle-store.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-ORACLE-STORE",
      description: "The Store owns exhaustive deterministic oracle persistence.",
      interface_ids: [],
      verification_ids: ["VER-ORACLE-STORE"],
    }],
    verifications: [{
      id: "VER-ORACLE-STORE",
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

function contract(repo: string): TicketContract {
  return sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
}

function openRaw(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

function insertRow(databasePath: string, table: string, row: Readonly<Record<string, SqlValue>>): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(row);
    database.prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => row[column] ?? null));
  } finally {
    database.close();
  }
}

/** Isolated oracle fixtures project an already-proved upstream t20 aggregate; t20 has its own authority corpus. */
function insertUpstreamRowWithoutForeignKeys(
  databasePath: string,
  table: string,
  row: Readonly<Record<string, SqlValue>>,
): void {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false, timeout: 1_000 });
  try {
    const columns = Object.keys(row);
    database.prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => row[column] ?? null));
  } finally {
    database.close();
  }
}

function updateRow(
  databasePath: string,
  table: string,
  idColumn: string,
  id: string,
  changes: Readonly<Record<string, SqlValue>>,
): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(changes);
    const result = database.prepare(
      `UPDATE "${table}" SET ${columns.map((column) => `"${column}" = ?`).join(", ")} WHERE "${idColumn}" = ?`,
    ).run(...columns.map((column) => changes[column] ?? null), id);
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

function count(databasePath: string, table: string, attemptId: string): number {
  const row = queryAll(databasePath, `SELECT COUNT(*) AS count FROM "${table}" WHERE attempt_id = ?`, attemptId)[0];
  return Number(row?.count ?? 0);
}

function resolvePhase(
  fixture: Pick<OracleFixture, "repo" | "store" | "contract" | "attempt">,
  phase: "implement" | "review" | "verification",
  phaseOrdinal: number,
  role: "worker" | "reviewer" | "verifier",
): ResolvedPhaseContext {
  const policyRoot = join(fixture.store.location.resourceDirectory, `policy-${phaseOrdinal}`);
  const bundleDir = join(policyRoot, "bundle");
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  return new IdentityContextResolver(fixture.store).resolvePhaseContext({
    attempt: fixture.attempt,
    contract: fixture.contract,
    phase,
    phaseOrdinal,
    role,
    worktreeRealpath: fixture.repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir,
      requestedBundleSha256: String(phaseOrdinal + 1).repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: fixture.contract.verifications[0]!.timeout_ms,
  });
}

interface OracleFixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly implement: ResolvedPhaseContext;
  readonly review: ResolvedPhaseContext;
  readonly verification: ResolvedPhaseContext;
  readonly candidateOid: string;
  readonly candidateTreeOid: string;
  readonly candidateDiffDigest: string;
  readonly gateResultIds: readonly string[];
  readonly reviewRecordId: string;
  readonly attributionId: string;
  readonly cleanupRecordId: string;
  readonly processReceiptIds: readonly string[];
  readonly resourceSnapshotEvidenceId: string;
  readonly leaseSnapshotEvidenceId: string;
}

function evidenceInput(
  fixture: Pick<OracleFixture, "attempt">,
  phase: ResolvedPhaseContext,
  id: string,
  producerService: string,
  schemaVersion: string,
  payload: Readonly<Record<string, unknown>>,
  scope = `attempt:${fixture.attempt.attemptId}`,
): Readonly<Record<string, SqlValue>> {
  const inlinePayload = canonicalJson(payload);
  return {
    evidence_id: id,
    attempt_id: fixture.attempt.attemptId,
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

function appendEvidence(
  fixture: Pick<OracleFixture, "store" | "attempt">,
  phase: ResolvedPhaseContext,
  id: string,
  producerService: string,
  schemaVersion: string,
  payload: Readonly<Record<string, unknown>>,
  scope?: string,
): StateRecord {
  return fixture.store.appendEvidence(evidenceInput(fixture, phase, id, producerService, schemaVersion, payload, scope));
}

function snapshotEvidence(
  fixture: Pick<OracleFixture, "attempt">,
  phase: ResolvedPhaseContext,
  evidenceId: string,
  schemaVersion: "rickgent.lease-snapshot.v1" | "rickgent.attempt-resource-snapshot.v1",
  postImage: Readonly<Record<string, SqlValue>>,
): Readonly<Record<string, SqlValue>> {
  return evidenceInput(fixture, phase, evidenceId, "OracleStoreTest", schemaVersion, postImage);
}

function advanceLifecycle(fixture: Pick<OracleFixture, "store" | "run" | "attempt">): void {
  const database = openRaw(fixture.store.location.databasePath);
  try {
    database.prepare("UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?")
      .run(fixture.run.runId);
    database.prepare("UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ?")
      .run(fixture.attempt.ticketInstanceId);
    const states = [
      "implementing",
      "implementation_captured",
      "reviewing",
      "verification_queued",
      "verifying",
      "converging",
      "cleanup_pending",
    ];
    for (const state of states) {
      database.prepare("UPDATE attempts SET state = ?, state_version = state_version + 1 WHERE attempt_id = ?")
        .run(state, fixture.attempt.attemptId);
    }
    database.prepare("UPDATE run_tickets SET state = 'cleanup_pending', state_version = state_version + 1 WHERE ticket_instance_id = ?")
      .run(fixture.attempt.ticketInstanceId);
  } finally {
    database.close();
  }
}

function completeFixture(gateStatuses: readonly ("passed" | "failed" | "missing" | "null")[] = ["passed"]): OracleFixture {
  const repo = makeRepo();
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const sealedContract = contract(repo);
  const resolver = new IdentityContextResolver(store);
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: git(repo, "rev-parse", "HEAD"),
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
  const partial = { repo, store, contract: sealedContract, attempt };
  const implement = resolvePhase(partial as OracleFixture, "implement", 0, "worker");
  const review = resolvePhase(partial as OracleFixture, "review", 1, "reviewer");
  const verification = resolvePhase(partial as OracleFixture, "verification", 2, "verifier");
  const fixtureBase = { repo, store, contract: sealedContract, run, attempt, implement, review, verification };

  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/oracle-store.ts"), "export const oracleStore = true;\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "src/oracle-store.ts"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "oracle candidate"]);
  const candidateOid = git(repo, "rev-parse", "HEAD");
  const candidateTreeOid = git(repo, "rev-parse", `${candidateOid}^{tree}`);
  const baselineTreeOid = git(repo, "rev-parse", `${attempt.deliveryBaselineOid}^{tree}`);
  const normalizedDelta: readonly OracleNormalizedDeltaEntry[] = [{
    path: "src/oracle-store.ts",
    changeKind: "create",
    fromPath: null,
    beforeMode: null,
    afterMode: "100644",
  }];
  const attributionDigests = deriveOracleAttributionDigests(normalizedDelta);

  const leaseId = `lease-${attempt.attemptId}`;
  const ownerTokenDigest = digest("owner-token");
  const leaseAcquisitionEvidenceId = `evidence-lease-0-${attempt.attemptId}`;
  let lease: StateRecord = {
    lease_id: leaseId,
    attempt_id: attempt.attemptId,
    generation: 1,
    owner_token_digest: ownerTokenDigest,
    owner_context_id: implement.persisted.contextId,
    heartbeat_at: NOW,
    expires_at: "2026-07-16T12:10:00.000Z",
    state: "reserved",
    state_version: 0,
    acquisition_evidence_id: leaseAcquisitionEvidenceId,
    release_evidence_id: null,
    created_at: NOW,
  };
  store.appendEvidence(snapshotEvidence(fixtureBase, implement, leaseAcquisitionEvidenceId, "rickgent.lease-snapshot.v1", lease));
  insertRow(store.location.databasePath, "leases", lease);

  const resourceId = `resource-${attempt.attemptId}`;
  const resourceAcquisitionEvidenceId = `evidence-resource-0-${attempt.attemptId}`;
  let resource: StateRecord = {
    resource_id: resourceId,
    attempt_id: attempt.attemptId,
    slot: "worktree",
    kind: "worktree",
    canonical_identity: `worktree:${attempt.attemptId}`,
    identity_digest: digest(`worktree:${attempt.attemptId}`),
    allocation_lease_id: leaseId,
    allocation_evidence_id: resourceAcquisitionEvidenceId,
    owner_generation: 1,
    owner_context_id: implement.persisted.contextId,
    state: "reserved",
    state_version: 0,
    release_evidence_id: null,
    quarantine_evidence_id: null,
    created_at: NOW,
  };
  store.appendEvidence(snapshotEvidence(fixtureBase, implement, resourceAcquisitionEvidenceId, "rickgent.attempt-resource-snapshot.v1", resource));
  insertRow(store.location.databasePath, "attempt_resources", resource);

  const launchEvidenceIds = [implement, review, verification].map((phase, ordinal) => String(appendEvidence(
    fixtureBase,
    phase,
    `evidence-launch-${ordinal}-${attempt.attemptId}`,
    "AttemptLifecycleService",
    "rickgent.process-launch.v1",
    { attempt_id: attempt.attemptId, phase_execution_id: phase.persisted.phaseExecutionId },
  ).evidence_id));
  const processReceiptIds = [implement, review, verification].map((phase, ordinal) => {
    const processReceiptId = `receipt-${ordinal}-${attempt.attemptId}`;
    insertRow(store.location.databasePath, "process_receipts", {
      process_receipt_id: processReceiptId,
      phase_execution_id: phase.persisted.phaseExecutionId,
      context_id: phase.persisted.contextId,
      lease_id: leaseId,
      lease_generation: 1,
      pid: 100 + ordinal,
      pgid: 100 + ordinal,
      boot_identity: "boot-oracle-store",
      process_start_identity: `process-${ordinal}-oracle-store`,
      argv_digest: digest(`argv-${ordinal}`),
      environment_digest: digest(`environment-${ordinal}`),
      launch_evidence_id: launchEvidenceIds[ordinal]!,
      exit_evidence_id: launchEvidenceIds[ordinal]!,
      termination_evidence_id: null,
      group_death_evidence_id: launchEvidenceIds[ordinal]!,
      stdout_evidence_id: null,
      stderr_evidence_id: null,
      created_at: NOW,
    });
    return processReceiptId;
  });

  const reviewRecordId = `review-${attempt.attemptId}`;
  const reviewPayload = {
    attempt_id: attempt.attemptId,
    cycle: 1,
    verdict: "accepted",
    input_tree_oid: candidateTreeOid,
    input_diff_digest: attributionDigests.candidateDiffDigest,
  } as const;
  const reviewEvidenceId = String(appendEvidence(
    fixtureBase,
    review,
    `evidence-review-${attempt.attemptId}`,
    "ReviewService",
    "rickgent.review-verdict.v1",
    reviewPayload,
    reviewRecordId,
  ).evidence_id);
  insertRow(store.location.databasePath, "review_records", {
    review_record_id: reviewRecordId,
    attempt_id: attempt.attemptId,
    cycle: 1,
    reviewer_context_id: review.persisted.contextId,
    verdict: "accepted",
    verdict_evidence_id: reviewEvidenceId,
    findings_evidence_id: reviewEvidenceId,
    input_tree_oid: candidateTreeOid,
    input_diff_digest: attributionDigests.candidateDiffDigest,
    created_at: NOW,
  });

  const gateResultIds = gateStatuses.map((status, evaluationOrdinal) => {
    const gateResultId = `gate-${evaluationOrdinal}-${attempt.attemptId}`;
    const gatePayload = {
      gate_id: "VER-ORACLE-STORE",
      evaluation_ordinal: evaluationOrdinal,
      required: true,
      status,
      candidate_tree_oid: candidateTreeOid,
      candidate_diff_digest: attributionDigests.candidateDiffDigest,
    } as const;
    const gateEvidenceId = String(appendEvidence(
      fixtureBase,
      verification,
      `evidence-gate-${evaluationOrdinal}-${attempt.attemptId}`,
      "VerificationService",
      "rickgent.gate-result.v1",
      gatePayload,
      gateResultId,
    ).evidence_id);
    insertRow(store.location.databasePath, "gate_results", {
      gate_result_id: gateResultId,
      attempt_id: attempt.attemptId,
      gate_id: "VER-ORACLE-STORE",
      evaluation_ordinal: evaluationOrdinal,
      status,
      required: 1,
      context_id: verification.persisted.contextId,
      contract_digest: attempt.contractDigest,
      evidence_id: gateEvidenceId,
      result_digest: digest(gatePayload),
      created_at: NOW,
    });
    return gateResultId;
  });

  const attributionId = `attribution-${attempt.attemptId}`;
  const attributionPayload = {
    contract_digest: attempt.contractDigest,
    baseline_oid: attempt.deliveryBaselineOid,
    parent_oid: attempt.deliveryBaselineOid,
    tree_before_oid: baselineTreeOid,
    tree_after_oid: candidateTreeOid,
    commit_oid: candidateOid,
    candidate_diff_digest: attributionDigests.candidateDiffDigest,
    path_set_digest: attributionDigests.pathSetDigest,
    change_kind_set_digest: attributionDigests.changeKindSetDigest,
    mode_set_digest: attributionDigests.modeSetDigest,
    normalized_delta: normalizedDelta.map((entry) => ({
      path: entry.path,
      change_kind: entry.changeKind,
      from_path: entry.fromPath,
      before_mode: entry.beforeMode,
      after_mode: entry.afterMode,
    })),
  } as const;
  const attributionEvidenceId = `evidence-attribution-${attempt.attemptId}`;
  const attributionPayloadJson = canonicalJson(attributionPayload);
  insertRow(store.location.databasePath, "evidence", {
    evidence_id: attributionEvidenceId,
    attempt_id: attempt.attemptId,
    phase_execution_id: implement.persisted.phaseExecutionId,
    context_id: implement.persisted.contextId,
    producer_service: "CommitService",
    scope: attributionId,
    schema_version: "rickgent.commit-attribution.v2",
    content_digest: digest(attributionPayloadJson),
    inline_payload_json: attributionPayloadJson,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `intent-${attempt.attemptId}`,
    created_at: NOW,
  });
  insertRow(store.location.databasePath, "commit_attributions", {
    commit_attribution_id: attributionId,
    attempt_id: attempt.attemptId,
    baseline_oid: attempt.deliveryBaselineOid,
    parent_oid: attempt.deliveryBaselineOid,
    tree_before_oid: baselineTreeOid,
    tree_after_oid: candidateTreeOid,
    commit_oid: candidateOid,
    contract_digest: attempt.contractDigest,
    context_digest: implement.canonical.contextDigest,
    path_set_digest: attributionDigests.pathSetDigest,
    change_kind_set_digest: attributionDigests.changeKindSetDigest,
    mode_set_digest: attributionDigests.modeSetDigest,
    attribution_evidence_id: attributionEvidenceId,
    created_at: NOW,
  });
  insertUpstreamRowWithoutForeignKeys(store.location.databasePath, "attempt_commit_intents", {
    commit_intent_id: `intent-${attempt.attemptId}`,
    repository_id: run.repositoryId,
    attempt_id: attempt.attemptId,
    ownership_id: `fixture-owner-${attempt.attemptId}`,
    owner_generation: 1,
    ownership_state_version: 0,
    ownership_context_digest: digest(`fixture-owner-context:${attempt.attemptId}`),
    phase_execution_id: implement.persisted.phaseExecutionId,
    context_id: implement.persisted.contextId,
    execution_context_digest: implement.canonical.contextDigest,
    launch_id: `fixture-launch-${attempt.attemptId}`,
    process_receipt_id: `fixture-receipt-${attempt.attemptId}`,
    delivery_ref: run.deliveryRef,
    attempt_ref: `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`,
    baseline_oid: attempt.deliveryBaselineOid,
    contract_digest: attempt.contractDigest,
    delivery_ref_claim_id: `fixture-delivery-claim-${attempt.attemptId}`,
    delivery_ref_expected_version: 0,
    attempt_ref_claim_id: `fixture-attempt-claim-${attempt.attemptId}`,
    attempt_ref_expected_version: 0,
    worktree_claim_id: `fixture-worktree-claim-${attempt.attemptId}`,
    worktree_expected_version: 0,
    isolated_index_claim_id: `fixture-index-claim-${attempt.attemptId}`,
    isolated_index_expected_version: 0,
    tree_before_oid: baselineTreeOid,
    tree_after_oid: candidateTreeOid,
    candidate_diff_digest: attributionDigests.candidateDiffDigest,
    path_set_digest: attributionDigests.pathSetDigest,
    change_kind_set_digest: attributionDigests.changeKindSetDigest,
    mode_set_digest: attributionDigests.modeSetDigest,
    normalized_delta_json: canonicalJson(attributionPayload.normalized_delta),
    verification_receipt_digests_json: canonicalJson([digest(`fixture-verification:${attempt.attemptId}`)]),
    commit_metadata_json: canonicalJson({ fixture: true }),
    input_digest: digest(`fixture-intent-input:${attempt.attemptId}`),
    idempotency_key: `fixture-intent:${attempt.attemptId}`,
    state: "finalized",
    state_version: 1,
    commit_attribution_id: attributionId,
    commit_oid: candidateOid,
    delivery_ref_observed_oid: attempt.deliveryBaselineOid,
    attempt_ref_before_oid: attempt.deliveryBaselineOid,
    attempt_ref_after_oid: candidateOid,
    command_receipts_json: canonicalJson([{ fixture: true }]),
    result_digest: digest(`fixture-intent-result:${attempt.attemptId}`),
    created_at: NOW,
    finalized_at: NOW,
  });

  const releaseEvidenceId = String(appendEvidence(
    fixtureBase,
    implement,
    `evidence-release-${attempt.attemptId}`,
    "AttemptLifecycleService",
    "rickgent.resource-release.v1",
    { attempt_id: attempt.attemptId, released: true },
  ).evidence_id);
  for (const [state, version] of [["allocated", 1], ["cleanup_pending", 2], ["released", 3]] as const) {
    const evidenceId = `evidence-resource-${version}-${attempt.attemptId}`;
    const desired = { ...resource, state, state_version: version, release_evidence_id: state === "released" ? releaseEvidenceId : null };
    store.appendEvidence(snapshotEvidence(fixtureBase, implement, evidenceId, "rickgent.attempt-resource-snapshot.v1", desired));
    updateRow(store.location.databasePath, "attempt_resources", "resource_id", resourceId, {
      state,
      state_version: version,
      release_evidence_id: desired.release_evidence_id,
    });
    resource = desired;
  }
  const resourceSnapshotEvidenceId = `evidence-resource-3-${attempt.attemptId}`;

  for (const [state, version] of [["live", 1], ["cleanup_pending", 2], ["released", 3]] as const) {
    const evidenceId = `evidence-lease-${version}-${attempt.attemptId}`;
    const desired = { ...lease, state, state_version: version, release_evidence_id: state === "released" ? releaseEvidenceId : null };
    store.appendEvidence(snapshotEvidence(fixtureBase, implement, evidenceId, "rickgent.lease-snapshot.v1", desired));
    updateRow(store.location.databasePath, "leases", "lease_id", leaseId, {
      state,
      state_version: version,
      release_evidence_id: desired.release_evidence_id,
    });
    lease = desired;
  }
  const leaseSnapshotEvidenceId = `evidence-lease-3-${attempt.attemptId}`;

  const cleanupRecordId = `cleanup-${attempt.attemptId}`;
  const cleanupEvidenceId = `evidence-cleanup-${attempt.attemptId}`;
  const cleanupPayload = {
    attempt_id: attempt.attemptId,
    sequence: 1,
    context_id: implement.persisted.contextId,
    outcome: "verified",
    group_dead: 1,
    worktree_disposition: "removed",
    index_disposition: "removed",
    ref_disposition: "removed",
    context_disposition: "retained_immutable",
    bundle_disposition: "retained_immutable",
    delivery_ref_observed_oid: run.currentDeliveryOid,
    resources_absent: 1,
    lease_release_eligible: 1,
    evidence_id: cleanupEvidenceId,
  } as const;
  appendEvidence(
    fixtureBase,
    implement,
    cleanupEvidenceId,
    "CleanupService",
    "rickgent.cleanup-record.v1",
    cleanupPayload,
    cleanupRecordId,
  );
  insertRow(store.location.databasePath, "cleanup_records", {
    cleanup_record_id: cleanupRecordId,
    ...cleanupPayload,
    record_digest: digest(cleanupPayload),
    created_at: NOW,
  });

  const fixture: OracleFixture = {
    ...fixtureBase,
    candidateOid,
    candidateTreeOid,
    candidateDiffDigest: attributionDigests.candidateDiffDigest,
    gateResultIds,
    reviewRecordId,
    attributionId,
    cleanupRecordId,
    processReceiptIds,
    resourceSnapshotEvidenceId,
    leaseSnapshotEvidenceId,
  };
  advanceLifecycle(fixture);
  return fixture;
}

function appendChangedGate(fixture: OracleFixture, status: "passed" | "failed"): string {
  const evaluationOrdinal = fixture.gateResultIds.length;
  const gateResultId = `gate-${evaluationOrdinal}-${fixture.attempt.attemptId}`;
  const payload = {
    gate_id: "VER-ORACLE-STORE",
    evaluation_ordinal: evaluationOrdinal,
    required: true,
    status,
    candidate_tree_oid: fixture.candidateTreeOid,
    candidate_diff_digest: fixture.candidateDiffDigest,
  } as const;
  const evidenceId = String(appendEvidence(
    fixture,
    fixture.verification,
    `evidence-gate-${evaluationOrdinal}-${fixture.attempt.attemptId}`,
    "VerificationService",
    "rickgent.gate-result.v1",
    payload,
    gateResultId,
  ).evidence_id);
  insertRow(fixture.store.location.databasePath, "gate_results", {
    gate_result_id: gateResultId,
    attempt_id: fixture.attempt.attemptId,
    gate_id: "VER-ORACLE-STORE",
    evaluation_ordinal: evaluationOrdinal,
    status,
    required: 1,
    context_id: fixture.verification.persisted.contextId,
    contract_digest: fixture.attempt.contractDigest,
    evidence_id: evidenceId,
    result_digest: digest(payload),
    created_at: NOW,
  });
  return gateResultId;
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

describe("Store-owned attempt oracle integration", () => {
  it("resolves the exhaustive reference set itself and persists deterministic contiguous ordering", () => {
    const fixture = completeFixture();
    const result = fixture.store.evaluateAndPersistAttemptOracle({
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:exhaustive",
    });
    expect(result.decision.result).toBe("accepted");
    const references = queryAll(
      fixture.store.location.databasePath,
      "SELECT * FROM oracle_input_references WHERE oracle_decision_id = ? ORDER BY ordinal",
      String(result.decision.oracle_decision_id),
    );
    expect(references.map((row) => row.ordinal)).toEqual(references.map((_, ordinal) => ordinal));

    const kindRank = new Map([
      "run_manifest",
      "ticket_contract",
      "execution_context",
      "process_receipt",
      "gate_result",
      "review_record",
      "commit_attribution",
      "cleanup_record",
      "attempt_resource_snapshot",
      "lease_snapshot",
      "dependency_edge",
      "evidence",
    ].map((kind, index) => [kind, index]));
    const ranks = references.map((row) => kindRank.get(String(row.reference_kind)) ?? -1);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(references.map((row) => row.reference_kind)).toEqual([
      "run_manifest",
      "ticket_contract",
      "execution_context",
      "execution_context",
      "execution_context",
      "process_receipt",
      "process_receipt",
      "process_receipt",
      "gate_result",
      "review_record",
      "commit_attribution",
      "cleanup_record",
      "attempt_resource_snapshot",
      "lease_snapshot",
    ]);
    expect(references.map((row) => row.context_id).filter((value) => value !== null)).toEqual([
      fixture.implement.persisted.contextId,
      fixture.review.persisted.contextId,
      fixture.verification.persisted.contextId,
    ]);
    expect(references.map((row) => row.process_receipt_id).filter((value) => value !== null))
      .toEqual(fixture.processReceiptIds);
    expect(references.find((row) => row.reference_kind === "gate_result")?.gate_result_id)
      .toBe(fixture.gateResultIds[0]);
    expect(references.find((row) => row.reference_kind === "review_record")?.review_record_id)
      .toBe(fixture.reviewRecordId);
    expect(references.find((row) => row.reference_kind === "commit_attribution")?.commit_attribution_id)
      .toBe(fixture.attributionId);
    expect(references.find((row) => row.reference_kind === "cleanup_record")?.cleanup_record_id)
      .toBe(fixture.cleanupRecordId);
    expect(references.find((row) => row.reference_kind === "attempt_resource_snapshot")?.resource_snapshot_evidence_id)
      .toBe(fixture.resourceSnapshotEvidenceId);
    expect(references.find((row) => row.reference_kind === "lease_snapshot")?.lease_snapshot_evidence_id)
      .toBe(fixture.leaseSnapshotEvidenceId);
    expect(result.references).toEqual(references);
  });

  it("uses only the latest required gate evaluation, including a latest blocking result", () => {
    const fixture = completeFixture(["passed", "failed"]);
    const result = fixture.store.evaluateAndPersistAttemptOracle({
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:latest-gate",
    });
    expect(result.decision.result).toBe("rejected");
    expect(JSON.parse(String(result.decision.reasons_json))).toContain(
      `required_gate_blocking:${fixture.gateResultIds[1]}:failed`,
    );
    expect(result.references.filter((row) => row.reference_kind === "gate_result").map((row) => row.gate_result_id))
      .toEqual([fixture.gateResultIds[1]]);
  });

  it("accepts natural run/ticket ancestor targets while copying the full decision scope into reference rows", () => {
    const fixture = completeFixture();
    const result = fixture.store.evaluateAndPersistAttemptOracle({
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:ancestor-lineage",
    });
    const ancestors = result.references.filter((row) =>
      row.reference_kind === "run_manifest" || row.reference_kind === "ticket_contract");
    expect(ancestors).toHaveLength(2);
    for (const row of ancestors) {
      expect(row).toMatchObject({
        run_id: fixture.run.runId,
        ticket_instance_id: fixture.attempt.ticketInstanceId,
        attempt_id: fixture.attempt.attemptId,
      });
    }
  });

  it("returns the exact stored result after unrelated lifecycle advancement", () => {
    const fixture = completeFixture();
    const request = { attemptId: fixture.attempt.attemptId, idempotencyKey: "oracle:replay" } as const;
    const first = fixture.store.evaluateAndPersistAttemptOracle(request);
    const database = openRaw(fixture.store.location.databasePath);
    try {
      database.prepare("UPDATE attempts SET state = 'oracle_evaluation', state_version = state_version + 1 WHERE attempt_id = ?")
        .run(fixture.attempt.attemptId);
    } finally {
      database.close();
    }
    expect(fixture.store.evaluateAndPersistAttemptOracle(request)).toEqual(first);
    expect(count(fixture.store.location.databasePath, "oracle_decisions", fixture.attempt.attemptId)).toBe(1);
  });

  it("conflicts when the same idempotency key resolves a changed deterministic input set", () => {
    const fixture = completeFixture();
    const request = { attemptId: fixture.attempt.attemptId, idempotencyKey: "oracle:changed-input" } as const;
    fixture.store.evaluateAndPersistAttemptOracle(request);
    appendChangedGate(fixture, "failed");
    expectStateCode(
      () => fixture.store.evaluateAndPersistAttemptOracle(request),
      "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
    );
    expect(count(fixture.store.location.databasePath, "oracle_decisions", fixture.attempt.attemptId)).toBe(1);
  });

  it("rolls back the decision and every reference when a late reference insert faults", () => {
    const fixture = completeFixture();
    const database = openRaw(fixture.store.location.databasePath);
    try {
      database.exec(`
        CREATE TRIGGER oracle_store_test_fault BEFORE INSERT ON oracle_input_references
        WHEN NEW.ordinal = 8 BEGIN SELECT RAISE(ABORT, 'injected oracle reference fault'); END
      `);
    } finally {
      database.close();
    }
    expectStateCode(() => fixture.store.evaluateAndPersistAttemptOracle({
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:rollback",
    }), "RICKGENT_STATE_CONFLICT");
    expect(count(fixture.store.location.databasePath, "oracle_decisions", fixture.attempt.attemptId)).toBe(0);
    expect(count(fixture.store.location.databasePath, "oracle_input_references", fixture.attempt.attemptId)).toBe(0);

    const cleanup = openRaw(fixture.store.location.databasePath);
    try {
      cleanup.exec("DROP TRIGGER oracle_store_test_fault");
    } finally {
      cleanup.close();
    }
    const retry = fixture.store.evaluateAndPersistAttemptOracle({
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:rollback",
    });
    expect(retry.references.length).toBeGreaterThan(8);
  });

  it("exposes one Store-owned oracle entrypoint and no raw-row or caller-plan writer", () => {
    const fixture = completeFixture();
    const prototype = Object.getPrototypeOf(fixture.store) as object;
    const oracleMethods = Object.getOwnPropertyNames(prototype).filter((name) => /oracle/i.test(name));
    expect(oracleMethods).toEqual(["evaluateAndPersistAttemptOracle"]);
    expect((fixture.store as unknown as Record<string, unknown>).persistOracleDecision).toBeUndefined();
    expect(oracleMethods.some((name) => /authorized|plan|row/i.test(name))).toBe(false);
  });
});
