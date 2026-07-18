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

const ORACLE_VERSION = "rickgent.oracle.v2";
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
  readonly cleanupEligibilityRecordId: string;
  readonly resourceSnapshotEvidenceIds: readonly string[];
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
  const row = evidenceInput(fixture, phase, id, producerService, schemaVersion, payload, scope);
  return fixture.store.appendEvidence(row);
}

const T18_RESOURCE_KINDS = [
  "delivery_ref", "attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle",
  "process_group", "stdout", "stderr", "verification_output", "salvage_archive",
] as const;

function insertT18Ownership(
  fixture: Pick<OracleFixture, "store" | "attempt" | "implement">,
): {
  readonly ownershipId: string;
  readonly ownershipContextDigest: string;
  readonly resourceClaimIds: Readonly<Record<(typeof T18_RESOURCE_KINDS)[number], string>>;
} {
  const ownershipId = `ownership-${fixture.attempt.attemptId}`;
  const ownershipContextDigest = fixture.implement.canonical.contextDigest;
  const ownership: Readonly<Record<string, SqlValue>> = {
    ownership_id: ownershipId,
    attempt_id: fixture.attempt.attemptId,
    generation: 1,
    owner_token_digest: digest(`owner-token:${fixture.attempt.attemptId}`),
    context_digest: ownershipContextDigest,
    canonical_context_json: canonicalJson({ schema_version: "rickgent.attempt-ownership-context/v1" }),
    recovered_from_ownership_id: null,
    heartbeat_at: NOW,
    expires_at: "2099-07-16T12:10:00.000Z",
    state: "live",
    state_version: 0,
    created_at: NOW,
  };
  insertRow(fixture.store.location.databasePath, "attempt_ownership_leases", ownership);

  const resourceClaimIds = {} as Record<(typeof T18_RESOURCE_KINDS)[number], string>;
  for (const kind of T18_RESOURCE_KINDS) {
    const resourceClaimId = `claim-${kind}-${fixture.attempt.attemptId}`;
    resourceClaimIds[kind] = resourceClaimId;
    const resource: Readonly<Record<string, SqlValue>> = {
      resource_claim_id: resourceClaimId,
      attempt_id: fixture.attempt.attemptId,
      slot: kind,
      kind,
      canonical_identity: `t18:${kind}:${fixture.attempt.attemptId}`,
      identity_digest: digest(`t18:${kind}:${fixture.attempt.attemptId}`),
      allocation_ownership_id: ownershipId,
      current_ownership_id: ownershipId,
      owner_generation: 1,
      state: "active",
      state_version: 2,
      release_proof_digest: null,
      quarantine_proof_digest: null,
      created_at: NOW,
    };
    insertRow(fixture.store.location.databasePath, "attempt_resource_claims", resource);
  }
  return {
    ownershipId,
    ownershipContextDigest,
    resourceClaimIds: Object.freeze(resourceClaimIds),
  };
}

function insertT18CleanupSnapshots(
  fixture: Pick<OracleFixture, "store" | "attempt" | "implement">,
  ownershipId: string,
  ownershipContextDigest: string,
  resourceClaimIds: Readonly<Record<(typeof T18_RESOURCE_KINDS)[number], string>>,
): { readonly resourceSnapshotEvidenceIds: readonly string[]; readonly leaseSnapshotEvidenceId: string } {
  updateRow(fixture.store.location.databasePath, "attempt_ownership_leases", "ownership_id", ownershipId, {
    state: "cleanup_pending",
    state_version: 1,
  });
  const ownership: Readonly<Record<string, SqlValue>> = {
    ownership_id: ownershipId,
    attempt_id: fixture.attempt.attemptId,
    generation: 1,
    owner_token_digest: digest(`owner-token:${fixture.attempt.attemptId}`),
    context_digest: ownershipContextDigest,
    canonical_context_json: canonicalJson({ schema_version: "rickgent.attempt-ownership-context/v1" }),
    recovered_from_ownership_id: null,
    heartbeat_at: NOW,
    expires_at: "2099-07-16T12:10:00.000Z",
    state: "cleanup_pending",
    state_version: 1,
    created_at: NOW,
  };
  const leaseSnapshotEvidenceId = `evidence-ownership-v2-${fixture.attempt.attemptId}`;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture,
    fixture.implement,
    leaseSnapshotEvidenceId,
    "LeaseAuthority",
    "rickgent.attempt-ownership-lease-snapshot.v2",
    ownership,
    `attempt-ownership-lease:${ownershipId}:version:1`,
  ));

  const resourceSnapshotEvidenceIds = T18_RESOURCE_KINDS.map((kind) => {
    const resourceClaimId = resourceClaimIds[kind];
    updateRow(fixture.store.location.databasePath, "attempt_resource_claims", "resource_claim_id", resourceClaimId, {
      state: "cleanup_pending",
      state_version: 3,
    });
    const resource: Readonly<Record<string, SqlValue>> = {
      resource_claim_id: resourceClaimId,
      attempt_id: fixture.attempt.attemptId,
      slot: kind,
      kind,
      canonical_identity: `t18:${kind}:${fixture.attempt.attemptId}`,
      identity_digest: digest(`t18:${kind}:${fixture.attempt.attemptId}`),
      allocation_ownership_id: ownershipId,
      current_ownership_id: ownershipId,
      owner_generation: 1,
      state: "cleanup_pending",
      state_version: 3,
      release_proof_digest: null,
      quarantine_proof_digest: null,
      created_at: NOW,
    };
    const evidenceId = `evidence-resource-claim-v2-${kind}-${fixture.attempt.attemptId}`;
    insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
      fixture,
      fixture.implement,
      evidenceId,
      "LeaseAuthority",
      "rickgent.attempt-resource-claim-snapshot.v2",
      resource,
      `attempt-resource-claim:${resourceClaimId}:version:3`,
    ));
    return evidenceId;
  });
  return { resourceSnapshotEvidenceIds, leaseSnapshotEvidenceId };
}

function insertT22TerminalProcess(
  fixture: Pick<OracleFixture, "store" | "attempt" | "run">,
  phase: ResolvedPhaseContext,
  label: string,
  pid: number,
  ownershipId: string,
  ownershipContextDigest: string,
  invalidateDeathProof = false,
): {
  readonly launchId: string;
  readonly processReceiptId: string;
  readonly groupDeathEvidenceId: string;
  readonly targetStartGateId: string;
  readonly releaseEvidenceId: string;
} {
  const attemptId = fixture.attempt.attemptId;
  const launchId = `launch-${label}-${attemptId}`;
  const processReceiptId = `terminal-${label}-${attemptId}`;
  const groupDeathEvidenceId = `evidence-group-death-${label}-${attemptId}`;
  const exitEvidenceId = `evidence-process-exit-${label}-${attemptId}`;
  const launchEvidenceId = `evidence-process-launch-${label}-${attemptId}`;
  const observationId = `observation-group-death-${label}-${attemptId}`;
  const targetStartGateId = `target-start-gate-${label}-${attemptId}`;
  const releaseEvidenceId = `evidence-target-start-released-${label}-${attemptId}`;
  const startAuthorizationDigest = digest(`start-authorization:${label}:${attemptId}`);
  insertRow(fixture.store.location.databasePath, "target_start_gates", {
    target_start_gate_id: targetStartGateId,
    attempt_id: attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    phase_execution_id: phase.persisted.phaseExecutionId,
    context_id: phase.persisted.contextId,
    execution_context_digest: phase.canonical.contextDigest,
    start_authorization_digest: startAuthorizationDigest,
    state: "held",
    state_version: 0,
    release_evidence_id: null,
    never_released_evidence_id: null,
    input_digest: digest(`target-start-gate:${label}:${attemptId}`),
    idempotency_key: `target-start-gate:${label}:${attemptId}`,
    created_at: NOW,
  });
  const releasePayload = {
    target_start_gate_id: targetStartGateId,
    attempt_id: attemptId,
    phase_execution_id: phase.persisted.phaseExecutionId,
    state: "released",
    state_version: 1,
    start_authorization_digest: startAuthorizationDigest,
    launch_id: launchId,
  } as const;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture,
    phase,
    releaseEvidenceId,
    "TargetStartGateAuthority",
    "rickgent.target-start-gate-released.v1",
    releasePayload,
    targetStartGateId,
  ));
  updateRow(fixture.store.location.databasePath, "target_start_gates", "target_start_gate_id", targetStartGateId, {
    state: "released",
    state_version: 1,
    release_evidence_id: releaseEvidenceId,
  });
  const launchPayload = { attempt_id: attemptId, launch_id: launchId, released: true } as const;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture,
    phase,
    launchEvidenceId,
    "ProcessSupervisor",
    "rickgent.process-launch.v1",
    launchPayload,
    `attempt:${attemptId}:process-launch`,
  ));
  insertRow(fixture.store.location.databasePath, "attempt_process_launches", {
    launch_id: launchId,
    process_receipt_id: processReceiptId,
    repository_id: fixture.run.repositoryId,
    attempt_id: attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_context_digest: ownershipContextDigest,
    phase_execution_id: phase.persisted.phaseExecutionId,
    context_id: phase.persisted.contextId,
    execution_context_digest: phase.canonical.contextDigest,
    spawn_authorization_digest: digest(`spawn:${label}:${attemptId}`),
    pid,
    pgid: pid,
    platform: process.platform,
    boot_identity: "boot-oracle-store",
    process_start_identity: `start:${label}:${attemptId}`,
    argv_digest: digest(`argv:${label}:${attemptId}`),
    environment_digest: digest(`environment:${label}:${attemptId}`),
    stdout_path: `stdout-${label}-${attemptId}.log`,
    stderr_path: `stderr-${label}-${attemptId}.log`,
    output_limit_bytes: 1024,
    tail_limit_bytes: 128,
    process_group_expected_version: 1,
    stdout_expected_version: 1,
    stderr_expected_version: 1,
    launch_evidence_id: launchEvidenceId,
    created_at: NOW,
  });
  const exitPayload = { attempt_id: attemptId, launch_id: launchId, exit_code: 0, timed_out: false } as const;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture,
    phase,
    exitEvidenceId,
    "ProcessSupervisor",
    "rickgent.process-exit.v1",
    exitPayload,
    `attempt:${attemptId}:process-exit`,
  ));
  insertRow(fixture.store.location.databasePath, "attempt_process_observations", {
    observation_id: `observation-exit-${label}-${attemptId}`,
    launch_id: launchId,
    attempt_id: attemptId,
    sequence: 1,
    kind: "exit",
    evidence_id: exitEvidenceId,
    schema_version: "rickgent.process-exit.v1",
    payload_digest: digest(exitPayload),
    created_at: NOW,
  });
  const deathPayload = {
    schema_version: "rickgent.process-group-death.v1",
    launch_id: launchId,
    process_receipt_id: processReceiptId,
    attempt_id: attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_context_digest: ownershipContextDigest,
    phase_execution_id: phase.persisted.phaseExecutionId,
    context_id: phase.persisted.contextId,
    execution_context_digest: phase.canonical.contextDigest,
    pid,
    pgid: pid,
    platform: process.platform,
    boot_identity: "boot-oracle-store",
    process_start_identity: `start:${label}:${attemptId}`,
    death_observed_at: NOW,
    group_dead: true,
    proof_basis: "authoritative_containment",
    tracked_identities_confirmed_dead: !invalidateDeathProof,
    descendants_confirmed_dead: true,
  } as const;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture,
    phase,
    groupDeathEvidenceId,
    "ProcessSupervisor",
    "rickgent.process-group-death.v1",
    deathPayload,
    `attempt:${attemptId}:process-death`,
  ));
  insertRow(fixture.store.location.databasePath, "attempt_process_observations", {
    observation_id: observationId,
    launch_id: launchId,
    attempt_id: attemptId,
    sequence: 2,
    kind: "group_death",
    evidence_id: groupDeathEvidenceId,
    schema_version: "rickgent.process-group-death.v1",
    payload_digest: digest(deathPayload),
    created_at: NOW,
  });
  insertRow(fixture.store.location.databasePath, "attempt_process_terminal_receipts", {
    process_receipt_id: processReceiptId,
    launch_id: launchId,
    attempt_id: attemptId,
    outcome: "exited",
    exit_code: 0,
    signal: null,
    timed_out: 0,
    group_dead: 1,
    descendants_confirmed_dead: 1,
    observation_count: 2,
    result_digest: digest({ process_receipt_id: processReceiptId, launch_id: launchId, group_dead: true }),
    created_at: NOW,
  });
  return { launchId, processReceiptId, groupDeathEvidenceId, targetStartGateId, releaseEvidenceId };
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

function completeFixture(
  gateStatuses: readonly ("passed" | "failed" | "missing" | "null")[] = ["passed"],
  omitLastTargetProof = false,
  mutateDurablePreimage?: "claim" | "ownership",
  invalidateDeathProof = false,
): OracleFixture {
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
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
  git(repo, "update-ref", run.deliveryRef, attempt.deliveryBaselineOid);
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
  const {
    ownershipId,
    ownershipContextDigest,
    resourceClaimIds,
  } = insertT18Ownership({ store, attempt, implement });
  const targetProcesses = ([implement, review, verification] as const).map((phase, ordinal) => ({
    phase,
    ...insertT22TerminalProcess(
      { store, attempt, run },
      phase,
      ["implement", "review", "verification"][ordinal]!,
      7001 + ordinal,
      ownershipId,
      ownershipContextDigest,
      invalidateDeathProof && ordinal === 0,
    ),
  }));
  const { launchId, processReceiptId } = targetProcesses[0]!;
  insertRow(store.location.databasePath, "attempt_commit_intents", {
    commit_intent_id: `intent-${attempt.attemptId}`,
    repository_id: run.repositoryId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_state_version: 0,
    ownership_context_digest: ownershipContextDigest,
    phase_execution_id: implement.persisted.phaseExecutionId,
    context_id: implement.persisted.contextId,
    execution_context_digest: implement.canonical.contextDigest,
    launch_id: launchId,
    process_receipt_id: processReceiptId,
    delivery_ref: run.deliveryRef,
    attempt_ref: attemptRef,
    baseline_oid: attempt.deliveryBaselineOid,
    contract_digest: attempt.contractDigest,
    delivery_ref_claim_id: resourceClaimIds.delivery_ref,
    delivery_ref_expected_version: 2,
    attempt_ref_claim_id: resourceClaimIds.attempt_ref,
    attempt_ref_expected_version: 2,
    worktree_claim_id: resourceClaimIds.worktree,
    worktree_expected_version: 2,
    isolated_index_claim_id: resourceClaimIds.isolated_index,
    isolated_index_expected_version: 2,
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

  const { resourceSnapshotEvidenceIds, leaseSnapshotEvidenceId } = insertT18CleanupSnapshots(
    { store, attempt, implement },
    ownershipId,
    ownershipContextDigest,
    resourceClaimIds,
  );

  const targetProofSetId = `target-proof-set-${attempt.attemptId}`;
  const targetProofSetEvidenceId = `evidence-target-proof-set-${attempt.attemptId}`;
  insertRow(store.location.databasePath, "attempt_target_proof_sets", {
    target_proof_set_id: targetProofSetId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_context_digest: ownershipContextDigest,
    target_count: targetProcesses.length,
    state: "collecting",
    state_version: 0,
    proof_set_digest: null,
    evidence_id: null,
    input_digest: digest({ attempt_id: attempt.attemptId, target_count: targetProcesses.length }),
    idempotency_key: `target-proof-set:${attempt.attemptId}`,
    created_at: NOW,
    sealed_at: null,
  });
  const proofTargets = omitLastTargetProof ? targetProcesses.slice(0, -1) : targetProcesses;
  const targetProofMembers = proofTargets.map((target, ordinal) => {
    const sealedMember = {
      ordinal,
      phase_execution_id: target.phase.persisted.phaseExecutionId,
      context_id: target.phase.persisted.contextId,
      target_start_gate_id: target.targetStartGateId,
      gate_state: "released",
      gate_state_version: 1,
      proof_kind: "terminal_process",
      launch_id: target.launchId,
      process_receipt_id: target.processReceiptId,
      group_death_evidence_id: target.groupDeathEvidenceId,
      unproven_evidence_id: null,
    } as const;
    const memberDigest = digest(sealedMember);
    insertRow(store.location.databasePath, "attempt_target_proof_members", {
      target_proof_set_id: targetProofSetId,
      attempt_id: attempt.attemptId,
      ordinal,
      ownership_id: ownershipId,
      owner_generation: 1,
      phase_execution_id: target.phase.persisted.phaseExecutionId,
      context_id: target.phase.persisted.contextId,
      target_start_gate_id: target.targetStartGateId,
      gate_state: "released",
      gate_state_version: 1,
      gate_release_evidence_id: target.releaseEvidenceId,
      gate_never_released_evidence_id: null,
      proof_kind: "terminal_process",
      launch_id: target.launchId,
      process_receipt_id: target.processReceiptId,
      terminal_group_dead: 1,
      terminal_descendants_confirmed_dead: 1,
      group_death_evidence_id: target.groupDeathEvidenceId,
      unproven_evidence_id: null,
      member_digest: memberDigest,
      created_at: NOW,
    });
    return Object.freeze({ ...sealedMember, member_digest: memberDigest });
  });
  const targetProofSetDigest = digest(targetProofMembers.map((member) => member.member_digest));
  const targetProofSetPayload = {
    oracle_input_class: "complete_target_proof_set",
    target_proof_set_id: targetProofSetId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_context_digest: ownershipContextDigest,
    target_count: targetProofMembers.length,
    target_proof_set_digest: targetProofSetDigest,
    target_proofs: targetProofMembers,
  } as const;
  insertRow(store.location.databasePath, "evidence", evidenceInput(
    fixtureBase,
    implement,
    targetProofSetEvidenceId,
    "TargetProofService",
    "rickgent.attempt-target-proof-set.v1",
    targetProofSetPayload,
    targetProofSetId,
  ));
  updateRow(store.location.databasePath, "attempt_target_proof_sets", "target_proof_set_id", targetProofSetId, {
    state: "sealed_complete",
    state_version: 1,
    proof_set_digest: targetProofSetDigest,
    evidence_id: targetProofSetEvidenceId,
    sealed_at: NOW,
  });

  const cleanupEligibilityRecordId = `cleanup-eligibility-${attempt.attemptId}`;
  const cleanupEligibilityEvidenceId = `evidence-cleanup-eligibility-${attempt.attemptId}`;
  const claimSnapshotSetDigest = digest(resourceSnapshotEvidenceIds);
  const cleanupEligibilityPayload = {
    oracle_input_class: "cleanup_eligibility",
    eligibility_id: cleanupEligibilityRecordId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_state_version: 1,
    ownership_context_digest: ownershipContextDigest,
    context_id: implement.persisted.contextId,
    commit_intent_id: `intent-${attempt.attemptId}`,
    commit_attribution_id: attributionId,
    candidate_oid: candidateOid,
    baseline_oid: attempt.deliveryBaselineOid,
    delivery_ref: run.deliveryRef,
    delivery_observed_oid: attempt.deliveryBaselineOid,
    attempt_ref: attemptRef,
    attempt_ref_observed_oid: candidateOid,
    claim_preimage_digest: claimSnapshotSetDigest,
    target_proof_set_id: targetProofSetId,
    target_proof_set_digest: targetProofSetDigest,
    target_proof_count: targetProofMembers.length,
    ownership_snapshot_evidence_id: leaseSnapshotEvidenceId,
    claim_snapshot_evidence_ids: resourceSnapshotEvidenceIds,
  } as const;
  insertRow(store.location.databasePath, "evidence", evidenceInput(
    fixtureBase,
    implement,
    cleanupEligibilityEvidenceId,
    "CleanupEligibilityService",
    "rickgent.cleanup-eligibility.v1",
    cleanupEligibilityPayload,
    cleanupEligibilityRecordId,
  ));
  insertRow(store.location.databasePath, "cleanup_eligibility_records", {
    cleanup_eligibility_record_id: cleanupEligibilityRecordId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    ownership_state_version: 1,
    ownership_context_digest: ownershipContextDigest,
    context_id: implement.persisted.contextId,
    commit_intent_id: `intent-${attempt.attemptId}`,
    commit_attribution_id: attributionId,
    candidate_oid: candidateOid,
    attempt_ref: cleanupEligibilityPayload.attempt_ref,
    attempt_ref_observed_oid: candidateOid,
    delivery_ref: run.deliveryRef,
    delivery_baseline_oid: attempt.deliveryBaselineOid,
    delivery_observed_oid: attempt.deliveryBaselineOid,
    target_proof_set_id: targetProofSetId,
    target_proof_set_state: "sealed_complete",
    target_proof_set_digest: targetProofSetDigest,
    target_proof_set_evidence_id: targetProofSetEvidenceId,
    target_proof_count: targetProofMembers.length,
    ownership_snapshot_evidence_id: leaseSnapshotEvidenceId,
    claim_snapshot_evidence_ids_json: canonicalJson(resourceSnapshotEvidenceIds),
    claim_snapshot_set_digest: claimSnapshotSetDigest,
    evidence_id: cleanupEligibilityEvidenceId,
    input_digest: digest({ attempt_id: attempt.attemptId, purpose: "cleanup_eligibility" }),
    record_digest: digest(cleanupEligibilityPayload),
    idempotency_key: `cleanup-eligibility:${attempt.attemptId}`,
    created_at: NOW,
  });
  if (mutateDurablePreimage === "claim") {
    updateRow(store.location.databasePath, "attempt_resource_claims", "resource_claim_id", resourceClaimIds.worktree, {
      state: "released",
      state_version: 4,
      release_proof_digest: digest(`late-release:${attempt.attemptId}`),
    });
  } else if (mutateDurablePreimage === "ownership") {
    updateRow(store.location.databasePath, "attempt_ownership_leases", "ownership_id", ownershipId, {
      state: "released",
      state_version: 2,
    });
  }

  const fixture: OracleFixture = {
    ...fixtureBase,
    candidateOid,
    candidateTreeOid,
    candidateDiffDigest: attributionDigests.candidateDiffDigest,
    gateResultIds,
    reviewRecordId,
    attributionId,
    cleanupEligibilityRecordId,
    resourceSnapshotEvidenceIds,
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
  it("refuses to seal a target proof set that omits one launched phase", () => {
    expect(() => completeFixture(["passed"], true)).toThrow(
      /target proof set does not inventory every gate or launch phase|complete target proof set contains an unproven, live, or orphan target/,
    );
  });

  it("rejects a target proof whose group-death payload is not the full authoritative ProcessSupervisor proof", () => {
    const fixture = completeFixture(["passed"], false, undefined, true);
    expect(() => fixture.store.evaluateAndPersistAttemptOracle({
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:invalid-group-death",
    })).toThrow(
      /terminal target proof is not bound to authoritative containment death/,
    );
  });

  it.each(["claim", "ownership"] as const)(
    "rejects eligibility when the current durable %s advances beyond its pinned snapshot",
    (kind) => {
      const fixture = completeFixture(["passed"], false, kind);
      expect(() => fixture.store.evaluateAndPersistAttemptOracle({
        attemptId: fixture.attempt.attemptId,
        idempotencyKey: `oracle:stale-${kind}`,
      })).toThrow(/cleanup eligibility .*snapshot|cleanup-pending preimage/);
    },
  );

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
      "gate_result",
      "review_record",
      "commit_attribution",
      "evidence",
      "attempt_resource_snapshot",
      "lease_snapshot",
      "dependency_edge",
    ].map((kind, index) => [kind, index]));
    const ranks = references.map((row) => kindRank.get(String(row.reference_kind)) ?? -1);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(references.map((row) => row.reference_kind)).toEqual([
      "run_manifest",
      "ticket_contract",
      "execution_context",
      "execution_context",
      "execution_context",
      "gate_result",
      "review_record",
      "commit_attribution",
      "evidence",
      "evidence",
      ...T18_RESOURCE_KINDS.map(() => "attempt_resource_snapshot"),
      "lease_snapshot",
    ]);
    expect(references.map((row) => row.context_id).filter((value) => value !== null)).toEqual([
      fixture.implement.persisted.contextId,
      fixture.review.persisted.contextId,
      fixture.verification.persisted.contextId,
    ]);
    expect(references.find((row) => row.reference_kind === "gate_result")?.gate_result_id)
      .toBe(fixture.gateResultIds[0]);
    expect(references.find((row) => row.reference_kind === "review_record")?.review_record_id)
      .toBe(fixture.reviewRecordId);
    expect(references.find((row) => row.reference_kind === "commit_attribution")?.commit_attribution_id)
      .toBe(fixture.attributionId);
    expect(references.filter((row) => row.reference_kind === "evidence").map((row) => row.evidence_id))
      .toEqual([
        `evidence-target-proof-set-${fixture.attempt.attemptId}`,
        `evidence-cleanup-eligibility-${fixture.attempt.attemptId}`,
      ]);
    const resourceSnapshotReferences = references.filter((row) => row.reference_kind === "attempt_resource_snapshot");
    expect(resourceSnapshotReferences).toHaveLength(T18_RESOURCE_KINDS.length);
    expect(resourceSnapshotReferences.map((row) => row.resource_snapshot_evidence_id).sort())
      .toEqual([...fixture.resourceSnapshotEvidenceIds].sort());
    expect(references.find((row) => row.reference_kind === "lease_snapshot")?.lease_snapshot_evidence_id)
      .toBe(fixture.leaseSnapshotEvidenceId);
    const snapshotEvidence = queryAll(
      fixture.store.location.databasePath,
      `SELECT e.producer_service, e.schema_version
       FROM oracle_input_references reference
       JOIN evidence e ON e.evidence_id = COALESCE(reference.resource_snapshot_evidence_id, reference.lease_snapshot_evidence_id)
       WHERE reference.oracle_decision_id = ?
         AND reference.reference_kind IN ('attempt_resource_snapshot','lease_snapshot')
       ORDER BY reference.ordinal`,
      String(result.decision.oracle_decision_id),
    );
    expect(snapshotEvidence).toEqual([
      ...T18_RESOURCE_KINDS.map(() => ({
        producer_service: "LeaseAuthority",
        schema_version: "rickgent.attempt-resource-claim-snapshot.v2",
      })),
      {
        producer_service: "LeaseAuthority",
        schema_version: "rickgent.attempt-ownership-lease-snapshot.v2",
      },
    ]);
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
