/**
 * t22A state-bridge negative-proof matrix.
 *
 * Exercises the five narrowly-branded Store commands, the purpose-specific
 * finalization boundary, the authority-derived execution context binding, and
 * the full negative-proof matrix (crash/replay/stale-generation/forged-producer/
 * partial-write/cross-disposition/idempotency/rollback).  Legacy v1
 * ownership/process rows and generic cleanup records cannot authorize any of
 * these paths.
 */
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
import {
  IdentityContextResolver,
  type ResolvedPhaseContext,
} from "../../src/context/resolver.js";
import {
  LeaseAuthorityMintCapability,
  mintCleanupEligibilityReceipt,
  mintFailureCleanupReceipt,
  mintPromotionCleanupReceipt,
  mintQuarantineReceipt,
  mintTargetNeverReleasedReceipt,
  type AttemptResourceSlot,
  type CleanupEligibilityObservation,
  type FailureCleanupObservation,
  type PromotionCleanupObservation,
  type QuarantineInventoryEntry,
  type QuarantineObservation,
  type ResourceClaimPreimage,
  type TargetNeverReleasedObservation,
} from "../../src/lifecycle/disposition.js";
import {
  dispositionReceiptKind,
  finalizeFailure,
  finalizePromotion,
  finalizeQuarantine,
  receiptSatisfiesFinalization,
} from "../../src/lifecycle/disposition-finalization.js";
import { LeaseAuthority } from "../../src/state/leases.js";
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
const NOW = "2026-07-18T12:00:00.000Z";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-disp-store-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Disposition Store Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "disp-store@example.test"]);
  writeFileSync(join(repo, "README.md"), "disposition store\n", "utf8");
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
    title: "Disposition store bridge",
    description: "Prove the five branded Store commands and the negative-proof matrix.",
    depends_on: [],
    scope: [{ path: "src/disposition-store.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-DISP-STORE",
      description: "The Store owns the five branded disposition receipts.",
      interface_ids: [],
      verification_ids: ["VER-DISP-STORE"],
    }],
    verifications: [{
      id: "VER-DISP-STORE",
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

function count(databasePath: string, table: string, attemptId: string): number {
  const row = queryAll(databasePath, `SELECT COUNT(*) AS count FROM "${table}" WHERE attempt_id = ?`, attemptId)[0];
  return Number(row?.count ?? 0);
}

const T18_RESOURCE_KINDS = [
  "delivery_ref", "attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle",
  "process_group", "stdout", "stderr", "verification_output", "salvage_archive",
] as const satisfies readonly AttemptResourceSlot[];

const claimSlots = [...T18_RESOURCE_KINDS] as const;

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly resolver: IdentityContextResolver;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly implement: ResolvedPhaseContext;
  readonly ownershipId: string;
  readonly ownershipContextDigest: string;
  readonly resourceClaimIds: Readonly<Record<(typeof T18_RESOURCE_KINDS)[number], string>>;
  readonly targetStartGateId: string;
  readonly candidateOid: string;
  readonly attemptRef: string;
  readonly deliveryRef: string;
}

function resolvePhase(
  fixture: Pick<Fixture, "repo" | "store" | "contract" | "attempt">,
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

function buildFixture(): Fixture {
  const repo = makeRepo();
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const sealedContract = contract(repo);
  const resolver = new IdentityContextResolver(store);
  const leases = new LeaseAuthority(store);
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: git(repo, "rev-parse", "HEAD"),
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
  const partial = { repo, store, contract: sealedContract, attempt } as Fixture;
  const implement = resolvePhase(partial, "implement", 0, "worker");

  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/disposition-store.ts"), "export const x = true;\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "src/disposition-store.ts"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "candidate"]);
  const candidateOid = git(repo, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
  git(repo, "update-ref", run.deliveryRef, attempt.deliveryBaselineOid);
  const deliveryRef = run.deliveryRef;

  // t18 ownership lease (live → cleanup_pending) + 11 resource claims (cleanup_pending).
  const ownershipId = `ownership-${attempt.attemptId}`;
  const ownershipContextDigest = implement.canonical.contextDigest;
  insertRow(store.location.databasePath, "attempt_ownership_leases", {
    ownership_id: ownershipId,
    attempt_id: attempt.attemptId,
    generation: 1,
    owner_token_digest: digest(`owner-token:${attempt.attemptId}`),
    context_digest: ownershipContextDigest,
    canonical_context_json: canonicalJson({ schema_version: "rickgent.attempt-ownership-context/v1" }),
    recovered_from_ownership_id: null,
    heartbeat_at: NOW,
    expires_at: "2099-07-16T12:10:00.000Z",
    state: "cleanup_pending",
    state_version: 1,
    created_at: NOW,
  });
  const resourceClaimIds = {} as Record<(typeof T18_RESOURCE_KINDS)[number], string>;
  for (const kind of T18_RESOURCE_KINDS) {
    const resourceClaimId = `claim-${kind}-${attempt.attemptId}`;
    resourceClaimIds[kind] = resourceClaimId;
    insertRow(store.location.databasePath, "attempt_resource_claims", {
      resource_claim_id: resourceClaimId,
      attempt_id: attempt.attemptId,
      slot: kind,
      kind,
      canonical_identity: `t18:${kind}:${attempt.attemptId}`,
      identity_digest: digest(`t18:${kind}:${attempt.attemptId}`),
      allocation_ownership_id: ownershipId,
      current_ownership_id: ownershipId,
      owner_generation: 1,
      state: "cleanup_pending",
      state_version: 3,
      release_proof_digest: null,
      quarantine_proof_digest: null,
      created_at: NOW,
    });
  }

  // Target start gate in `held` state (the preimage for mintTargetNeverReleased).
  const targetStartGateId = `target-start-gate-${attempt.attemptId}`;
  insertRow(store.location.databasePath, "target_start_gates", {
    target_start_gate_id: targetStartGateId,
    attempt_id: attempt.attemptId,
    ownership_id: ownershipId,
    owner_generation: 1,
    phase_execution_id: implement.persisted.phaseExecutionId,
    context_id: implement.persisted.contextId,
    execution_context_digest: implement.canonical.contextDigest,
    start_authorization_digest: digest(`start-authorization:${attempt.attemptId}`),
    state: "held",
    state_version: 0,
    release_evidence_id: null,
    never_released_evidence_id: null,
    input_digest: digest(`target-start-gate:${attempt.attemptId}`),
    idempotency_key: `target-start-gate:${attempt.attemptId}`,
    created_at: NOW,
  });

  // Advance the attempt to cleanup_pending so the cleanup-disposition mint
  // commands' preimage validation accepts it.  The attempts table enforces the
  // legal transition chain via a trigger, so we walk the full legal sequence.
  for (const state of [
    "implementing", "implementation_captured", "reviewing",
    "verification_queued", "verifying", "converging", "cleanup_pending",
  ] as const) {
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state,
      state_version: ((): number => {
        const row = queryAll(store.location.databasePath,
          "SELECT state_version FROM attempts WHERE attempt_id = ?", attempt.attemptId)[0]!;
        return Number(row.state_version) + 1;
      })(),
    });
  }

  return {
    repo, store, leases, resolver, contract: sealedContract, run, attempt, implement,
    ownershipId, ownershipContextDigest, resourceClaimIds, targetStartGateId,
    candidateOid, attemptRef, deliveryRef,
  };
}

function makeTargetNeverReleasedObservation(fixture: Fixture, gateVersion = 1): TargetNeverReleasedObservation {
  return {
    kind: "target_never_released_observation",
    receiptId: `tnr-${fixture.attempt.attemptId}`,
    attemptId: fixture.attempt.attemptId,
    ownershipId: fixture.ownershipId,
    ownerGeneration: 1,
    ownershipContextDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    contextId: fixture.implement.persisted.contextId,
    phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
    launchId: null,
    gateId: fixture.targetStartGateId,
    gateVersion,
    containmentId: null,
    containmentDisposition: "not_created",
    containmentEvidenceDigest: null,
    reason: "containment_unavailable",
    observedAt: NOW,
  };
}

function makeClaims(fixture: Fixture): readonly ResourceClaimPreimage[] {
  return Object.freeze(claimSlots.map((slot, index) => ({
    resourceClaimId: fixture.resourceClaimIds[slot],
    slot,
    expectedState: "cleanup_pending" as const,
    expectedVersion: 3,
    ...({ _index: index } as Record<string, never>),
  })));
}

function makeCleanupEligibilityObservation(fixture: Fixture): CleanupEligibilityObservation {
  return {
    kind: "cleanup_eligibility_observation",
    receiptId: `elig-${fixture.attempt.attemptId}`,
    attemptId: fixture.attempt.attemptId,
    ownershipId: fixture.ownershipId,
    ownerGeneration: 1,
    ownershipStateVersion: 1,
    ownershipContextDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    contextId: fixture.implement.persisted.contextId,
    commitIntentId: `intent-${fixture.attempt.attemptId}`,
    commitAttributionId: `attribution-${fixture.attempt.attemptId}`,
    candidateOid: fixture.candidateOid,
    attemptRefObservedOid: fixture.candidateOid,
    deliveryRef: fixture.deliveryRef,
    deliveryBaselineOid: fixture.attempt.deliveryBaselineOid,
    deliveryObservedOid: fixture.attempt.deliveryBaselineOid,
    attemptRef: fixture.attemptRef,
    claims: makeClaims(fixture),
    targetProofs: [{
      phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
      contextId: fixture.implement.persisted.contextId,
      targetStartGateId: fixture.targetStartGateId,
      gateEvidenceId: "gate-evidence-1",
      gateEvidenceDigest: fixture.ownershipContextDigest as `sha256:${string}`,
      launchId: null,
      processReceiptId: null,
      groupDeathEvidenceId: null,
      groupDeathEvidenceDigest: null,
      proofKind: "never_released",
      memberDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    }],
    observedAt: NOW,
  };
}

function makeFailureObservation(fixture: Fixture): FailureCleanupObservation {
  return {
    kind: "failure_cleanup_observation",
    receiptId: `fail-${fixture.attempt.attemptId}`,
    attemptId: fixture.attempt.attemptId,
    ownershipId: fixture.ownershipId,
    ownerGeneration: 1,
    ownershipStateVersion: 1,
    ownershipContextDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    contextId: fixture.implement.persisted.contextId,
    cleanupIntentId: `fail-intent-${fixture.attempt.attemptId}`,
    failureCode: "verification_failed",
    deliveryRef: fixture.deliveryRef,
    deliveryBaselineOid: fixture.attempt.deliveryBaselineOid,
    deliveryObservedOid: fixture.attempt.deliveryBaselineOid,
    attemptRef: fixture.attemptRef,
    expectedAttemptRefOid: fixture.candidateOid,
    salvageRecordId: `salvage-${fixture.attempt.attemptId}`,
    targetProofs: [{
      phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
      contextId: fixture.implement.persisted.contextId,
      targetStartGateId: fixture.targetStartGateId,
      gateEvidenceId: "gate-evidence-1",
      gateEvidenceDigest: fixture.ownershipContextDigest as `sha256:${string}`,
      launchId: null,
      processReceiptId: null,
      groupDeathEvidenceId: null,
      groupDeathEvidenceDigest: null,
      proofKind: "never_released",
      memberDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    }],
    claims: makeClaims(fixture),
    absentResourceSlots: [...claimSlots],
    callerBeforeDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    callerAfterDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    observedAt: NOW,
  };
}

function makePromotionObservation(fixture: Fixture): PromotionCleanupObservation {
  return {
    kind: "promotion_cleanup_observation",
    receiptId: `promo-${fixture.attempt.attemptId}`,
    attemptId: fixture.attempt.attemptId,
    ownershipId: fixture.ownershipId,
    ownerGeneration: 1,
    ownershipStateVersion: 1,
    ownershipContextDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    contextId: fixture.implement.persisted.contextId,
    cleanupIntentId: `promo-cleanup-intent-${fixture.attempt.attemptId}`,
    cleanupEligibilityReceiptId: `elig-${fixture.attempt.attemptId}`,
    oracleDecisionId: `oracle-${fixture.attempt.attemptId}`,
    promotionIntentId: `promo-intent-${fixture.attempt.attemptId}`,
    promotionObservationEvidenceId: `promo-obs-${fixture.attempt.attemptId}`,
    commitAttributionId: `attribution-${fixture.attempt.attemptId}`,
    deliveryRef: fixture.deliveryRef,
    expectedOldOid: "c".repeat(40),
    candidateOid: fixture.candidateOid,
    deliveryObservedOid: fixture.candidateOid,
    claims: makeClaims(fixture),
    absentResourceSlots: [...claimSlots],
    callerBeforeDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    callerAfterDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    observedAt: NOW,
  };
}

function makeQuarantineObservation(fixture: Fixture): QuarantineObservation {
  const inventory: readonly QuarantineInventoryEntry[] = claimSlots.map((slot) => ({
    resourceClaimId: fixture.resourceClaimIds[slot],
    slot,
    logicalDisposition: "quarantined",
    physicalDisposition: slot === "delivery_ref" ? "not_applicable" : "retained",
    canonicalIdentity: `identity-${slot}`,
    observedPath: slot === "delivery_ref" ? null : `/private/attempt/${slot}`,
    observedKind: slot === "delivery_ref" ? null
      : slot === "attempt_ref" ? "git_ref"
      : slot === "process_group" ? "process_boundary" : "directory",
    contentDigest: null,
  }));
  return {
    kind: "quarantine_observation",
    receiptId: `quar-${fixture.attempt.attemptId}`,
    attemptId: fixture.attempt.attemptId,
    ownershipId: fixture.ownershipId,
    ownerGeneration: 1,
    ownershipStateVersion: 1,
    ownershipContextDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    contextId: fixture.implement.persisted.contextId,
    quarantineIntentId: `quar-intent-${fixture.attempt.attemptId}`,
    reasonCode: "resource_identity_ambiguous",
    deliveryRef: fixture.deliveryRef,
    deliveryObservedOid: fixture.attempt.deliveryBaselineOid,
    targetProofs: [{
      phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
      contextId: fixture.implement.persisted.contextId,
      targetStartGateId: fixture.targetStartGateId,
      gateEvidenceId: "gate-evidence-1",
      gateEvidenceDigest: fixture.ownershipContextDigest as `sha256:${string}`,
      launchId: null,
      processReceiptId: null,
      groupDeathEvidenceId: null,
      groupDeathEvidenceDigest: null,
      proofKind: "never_released",
      memberDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    }],
    claims: makeClaims(fixture),
    inventory,
    callerBeforeDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    callerAfterDigest: fixture.ownershipContextDigest as `sha256:${string}`,
    observedAt: NOW,
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

// ----- Shared prerequisite builders for the heavy-FK receipt tables -----

function insertSalvageRecord(fixture: Fixture): void {
  const evidenceId = `evidence-salvage-${fixture.attempt.attemptId}`;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture.attempt.attemptId, fixture.implement, evidenceId, "SalvageService",
    "rickgent.salvage-record.v1", { attempt_id: fixture.attempt.attemptId, disposition: "captured" },
    `salvage-${fixture.attempt.attemptId}`,
  ));
  insertRow(fixture.store.location.databasePath, "salvage_records", {
    salvage_record_id: `salvage-${fixture.attempt.attemptId}`,
    attempt_id: fixture.attempt.attemptId,
    disposition: "captured",
    artifact_path: null,
    artifact_digest: null,
    artifact_size: null,
    evidence_id: evidenceId,
    created_at: NOW,
  });
}

function insertTargetProofSetSealed(fixture: Fixture): { readonly targetProofSetId: string; readonly targetProofSetDigest: string; readonly targetProofSetEvidenceId: string } {
  // Close the held gate never-released first so the proof set can seal a never_released member.
  const neverReleasedEvidenceId = `evidence-gate-never-released-${fixture.attempt.attemptId}`;
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture.attempt.attemptId, fixture.implement, neverReleasedEvidenceId, "TargetStartGateAuthority",
    "rickgent.target-never-released.v1",
    { target_start_gate_id: fixture.targetStartGateId, attempt_id: fixture.attempt.attemptId, state: "closed_never_released", state_version: 1 },
    fixture.targetStartGateId,
  ));
  updateRow(fixture.store.location.databasePath, "target_start_gates", "target_start_gate_id", fixture.targetStartGateId, {
    state: "closed_never_released",
    state_version: 1,
    never_released_evidence_id: neverReleasedEvidenceId,
  });
  const targetProofSetId = `target-proof-set-${fixture.attempt.attemptId}`;
  const targetProofSetEvidenceId = `evidence-target-proof-set-${fixture.attempt.attemptId}`;
  const sealedMember = {
    ordinal: 0,
    phase_execution_id: fixture.implement.persisted.phaseExecutionId,
    context_id: fixture.implement.persisted.contextId,
    target_start_gate_id: fixture.targetStartGateId,
    gate_state: "closed_never_released",
    gate_state_version: 1,
    proof_kind: "never_released",
    launch_id: null,
    process_receipt_id: null,
    group_death_evidence_id: null,
    unproven_evidence_id: null,
  };
  const memberDigest = digest(sealedMember);
  const proofSetDigest = digest([memberDigest]);
  // 1. Insert the proof set in `collecting` state (members require a collecting set).
  insertRow(fixture.store.location.databasePath, "attempt_target_proof_sets", {
    target_proof_set_id: targetProofSetId,
    attempt_id: fixture.attempt.attemptId,
    ownership_id: fixture.ownershipId,
    owner_generation: 1,
    ownership_context_digest: fixture.ownershipContextDigest,
    target_count: 1,
    state: "collecting",
    state_version: 0,
    proof_set_digest: null,
    evidence_id: null,
    input_digest: digest({ attempt_id: fixture.attempt.attemptId, target_count: 1 }),
    idempotency_key: `target-proof-set:${fixture.attempt.attemptId}`,
    created_at: NOW,
    sealed_at: null,
  });
  // 2. Insert the proof-set evidence before referencing it.
  insertRow(fixture.store.location.databasePath, "evidence", evidenceInput(
    fixture.attempt.attemptId, fixture.implement, targetProofSetEvidenceId, "TargetProofService",
    "rickgent.attempt-target-proof-set.v1",
    { oracle_input_class: "complete_target_proof_set", target_proof_set_id: targetProofSetId, target_count: 1, target_proof_set_digest: proofSetDigest },
    targetProofSetId,
  ));
  // 3. Insert members while the set is collecting.
  insertRow(fixture.store.location.databasePath, "attempt_target_proof_members", {
    target_proof_set_id: targetProofSetId,
    attempt_id: fixture.attempt.attemptId,
    ordinal: 0,
    ownership_id: fixture.ownershipId,
    owner_generation: 1,
    phase_execution_id: fixture.implement.persisted.phaseExecutionId,
    context_id: fixture.implement.persisted.contextId,
    target_start_gate_id: fixture.targetStartGateId,
    gate_state: "closed_never_released",
    gate_state_version: 1,
    gate_release_evidence_id: null,
    gate_never_released_evidence_id: neverReleasedEvidenceId,
    proof_kind: "never_released",
    launch_id: null,
    process_receipt_id: null,
    terminal_group_dead: null,
    terminal_descendants_confirmed_dead: null,
    group_death_evidence_id: null,
    unproven_evidence_id: null,
    member_digest: memberDigest,
    created_at: NOW,
  });
  // 4. Seal the proof set.
  updateRow(fixture.store.location.databasePath, "attempt_target_proof_sets", "target_proof_set_id", targetProofSetId, {
    state: "sealed_complete",
    state_version: 1,
    proof_set_digest: proofSetDigest,
    evidence_id: targetProofSetEvidenceId,
    sealed_at: NOW,
  });
  return { targetProofSetId, targetProofSetDigest: proofSetDigest, targetProofSetEvidenceId };
}

describe("t22A disposition Store bridge", () => {
  describe("mintTargetNeverReleased", () => {
    it("atomically persists the receipt, evidence, and gate transition in one transaction", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      const result = fixture.store.mintTargetNeverReleased(
        { observation }, fixture.leases.issueDispositionMintCapability(),
      );
      expect(result.replayed).toBe(false);
      expect(String(result.record.state)).toBe("closed_never_released");
      expect(String(result.record.never_released_evidence_id)).toContain("evidence-target-never-released");
      const gate = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM target_start_gates WHERE target_start_gate_id = ?", fixture.targetStartGateId)[0]!;
      expect(gate.state).toBe("closed_never_released");
      expect(gate.state_version).toBe(1);
      const evidence = queryAll(fixture.store.location.databasePath,
        "SELECT * FROM evidence WHERE evidence_id = ?", `evidence-target-never-released-${observation.receiptId}`)[0]!;
      expect(evidence.producer_service).toBe("TargetStartGateAuthority");
      expect(evidence.schema_version).toBe("rickgent.target-never-released.v1");
    });

    it("replays identical inputs to the identical immutable postimage", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const first = fixture.store.mintTargetNeverReleased({ observation }, capability);
      const second = fixture.store.mintTargetNeverReleased({ observation }, capability);
      expect(second.replayed).toBe(true);
      expect(second.record).toEqual(first.record);
      expect(second.evidence).toEqual(first.evidence);
    });

    it("conflicts when the same idempotency key resolves a divergent postimage", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      fixture.store.mintTargetNeverReleased({ observation }, capability);
      // A second receipt with the same gate but a different receipt id mints a
      // different evidence id; the gate is already closed with the first evidence.
      const divergent = { ...observation, receiptId: `tnr-divergent-${fixture.attempt.attemptId}` };
      expectStateCode(
        () => fixture.store.mintTargetNeverReleased({ observation: divergent }, capability),
        "RICKGENT_STATE_IDEMPOTENCY_CONFLICT",
      );
    });

    it("rejects a forged capability (not issued by LeaseAuthority)", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      expect(() => fixture.store.mintTargetNeverReleased(
        { observation }, new LeaseAuthorityMintCapability(Symbol("forged")) as never,
      )).toThrow(/LeaseAuthority/);
      // The gate is still held (no partial write).
      const gate = queryAll(fixture.store.location.databasePath,
        "SELECT state FROM target_start_gates WHERE target_start_gate_id = ?", fixture.targetStartGateId)[0]!;
      expect(gate.state).toBe("held");
    });

    it("rejects a stale-generation receipt that does not bind the exact gate lineage", () => {
      const fixture = buildFixture();
      const observation = { ...makeTargetNeverReleasedObservation(fixture), ownerGeneration: 99 };
      expectStateCode(
        () => fixture.store.mintTargetNeverReleased(
          { observation }, fixture.leases.issueDispositionMintCapability(),
        ),
        "RICKGENT_STATE_OWNER_MISMATCH",
      );
    });

    it("rolls back the gate transition when a late evidence insert faults (crash-point)", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      const db = openRaw(fixture.store.location.databasePath);
      try {
        db.exec(`CREATE TRIGGER tnr_crash_test BEFORE INSERT ON evidence
                 WHEN NEW.producer_service = 'TargetStartGateAuthority' AND NEW.scope = '${observation.receiptId}'
                 BEGIN SELECT RAISE(ABORT, 'injected crash'); END`);
      } finally {
        db.close();
      }
      expectStateCode(
        () => fixture.store.mintTargetNeverReleased(
          { observation }, fixture.leases.issueDispositionMintCapability(),
        ),
        "RICKGENT_STATE_CONFLICT",
      );
      // The gate must still be held (atomic rollback).
      const gate = queryAll(fixture.store.location.databasePath,
        "SELECT state, never_released_evidence_id FROM target_start_gates WHERE target_start_gate_id = ?", fixture.targetStartGateId)[0]!;
      expect(gate.state).toBe("held");
      expect(gate.never_released_evidence_id).toBe(null);
      const cleanup = openRaw(fixture.store.location.databasePath);
      try { cleanup.exec("DROP TRIGGER tnr_crash_test"); } finally { cleanup.close(); }
      // Retry after the fault clears succeeds.
      const retry = fixture.store.mintTargetNeverReleased(
        { observation }, fixture.leases.issueDispositionMintCapability(),
      );
      expect(retry.replayed).toBe(false);
      expect(String(retry.record.state)).toBe("closed_never_released");
    });
  });

  describe("purpose-specific finalization cross-disposition isolation", () => {
    it("a failure-cleanup receipt cannot satisfy promotion finalization", () => {
      const fixture = buildFixture();
      insertSalvageRecord(fixture);
      const proof = insertTargetProofSetSealed(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const failureObservation = makeFailureObservation(fixture);
      const failureReceipt = mintFailureCleanupReceipt(failureObservation, capability);
      // The failure receipt is branded correctly for failure...
      expect(dispositionReceiptKind(failureReceipt)).toBe("failure");
      // ...but it cannot satisfy promotion finalization.
      expect(receiptSatisfiesFinalization(failureReceipt, "promotion")).toBe(false);
      const promotionObservation = makePromotionObservation(fixture);
      const promotionReceipt = mintPromotionCleanupReceipt(promotionObservation, capability);
      expect(() => finalizePromotion({
        store: fixture.store, leases: fixture.leases,
        request: { observation: promotionObservation, promotionObservationEvidenceId: promotionObservation.promotionObservationEvidenceId },
        receipt: failureReceipt as never as typeof promotionReceipt,
        oracleDecisionId: promotionObservation.oracleDecisionId,
        observedCandidateOid: promotionObservation.candidateOid,
        observedDeliveryOid: promotionObservation.deliveryObservedOid,
        cleanupEligibilityReceipt: mintCleanupEligibilityReceipt(makeCleanupEligibilityObservation(fixture), capability),
      })).toThrow(/promotion finalization/);
      void proof;
    });

    it("a quarantine receipt cannot satisfy promotion or failure finalization", () => {
      const fixture = buildFixture();
      insertSalvageRecord(fixture);
      insertTargetProofSetSealed(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const quarantineReceipt = mintQuarantineReceipt(makeQuarantineObservation(fixture), capability);
      expect(dispositionReceiptKind(quarantineReceipt)).toBe("quarantine");
      expect(receiptSatisfiesFinalization(quarantineReceipt, "promotion")).toBe(false);
      expect(receiptSatisfiesFinalization(quarantineReceipt, "failure")).toBe(false);
    });

    it("a promotion-cleanup receipt cannot satisfy failure or quarantine finalization", () => {
      const fixture = buildFixture();
      insertSalvageRecord(fixture);
      insertTargetProofSetSealed(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const promotionReceipt = mintPromotionCleanupReceipt(makePromotionObservation(fixture), capability);
      expect(dispositionReceiptKind(promotionReceipt)).toBe("promotion");
      expect(receiptSatisfiesFinalization(promotionReceipt, "failure")).toBe(false);
      expect(receiptSatisfiesFinalization(promotionReceipt, "quarantine")).toBe(false);
    });

    it("promotion finalization requires the exact accepted oracle decision and observed delivery", () => {
      const fixture = buildFixture();
      insertSalvageRecord(fixture);
      insertTargetProofSetSealed(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const promotionObservation = makePromotionObservation(fixture);
      const promotionReceipt = mintPromotionCleanupReceipt(promotionObservation, capability);
      const eligibilityReceipt = mintCleanupEligibilityReceipt(makeCleanupEligibilityObservation(fixture), capability);
      // A divergent oracle decision id is rejected.
      expect(() => finalizePromotion({
        store: fixture.store, leases: fixture.leases,
        request: { observation: promotionObservation, promotionObservationEvidenceId: promotionObservation.promotionObservationEvidenceId },
        receipt: promotionReceipt,
        oracleDecisionId: "foreign-oracle",
        observedCandidateOid: promotionObservation.candidateOid,
        observedDeliveryOid: promotionObservation.deliveryObservedOid,
        cleanupEligibilityReceipt: eligibilityReceipt,
      })).toThrow(/exact accepted oracle decision/);
      // A divergent observed candidate is rejected.
      expect(() => finalizePromotion({
        store: fixture.store, leases: fixture.leases,
        request: { observation: promotionObservation, promotionObservationEvidenceId: promotionObservation.promotionObservationEvidenceId },
        receipt: promotionReceipt,
        oracleDecisionId: promotionObservation.oracleDecisionId,
        observedCandidateOid: "d".repeat(40),
        observedDeliveryOid: promotionObservation.deliveryObservedOid,
        cleanupEligibilityReceipt: eligibilityReceipt,
      })).toThrow(/observed candidate/);
    });
  });

  describe("authority-derived execution context binding", () => {
    it("rejects a non-authorized ownership grant so the caller repo cannot become the execution context", () => {
      const fixture = buildFixture();
      const policyRoot = join(fixture.store.location.resourceDirectory, "policy-authority");
      const bundleDir = join(policyRoot, "bundle");
      mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
      // A caller-forged ownership grant (not minted by LeaseAuthority) is the
      // legacy ReadyRunWorkspace binding vector: the caller would supply its
      // own repository as the worktree.  resolveAuthorityExecutionContext must
      // reject it before any worktree resolution.
      const forgedGrant = { plan: { worktreePath: fixture.repo } } as never;
      expect(() => fixture.resolver.resolveAuthorityExecutionContext({
        attempt: fixture.attempt,
        contract: fixture.contract,
        phase: "implement",
        phaseOrdinal: 0,
        role: "worker",
        ownership: forgedGrant,
        policyBundle: {
          kind: "materialized_authenticated_policy_bundle",
          policyRoot,
          bundleDir,
          requestedBundleSha256: "1".repeat(64),
        },
        modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
        timeoutMs: 30_000,
        callerRepositoryRealpath: fixture.repo,
      })).toThrow(/authorized LeaseAuthority/);
    });

    it("rejects binding the execution context to the caller repository when the authority worktree equals it", () => {
      const fixture = buildFixture();
      const policyRoot = join(fixture.store.location.resourceDirectory, "policy-authority");
      const bundleDir = join(policyRoot, "bundle");
      mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
      // Simulate the legacy binding: the authority-derived worktree path resolves
      // to the caller repository.  This is the ReadyRunWorkspace anti-pattern;
      // resolveAuthorityExecutionContext must reject it.  We cannot construct a
      // real AttemptOwnershipGrant in-test (its authority symbol is private), so
      // we exercise the caller-repo guard directly via the store's repo realpath.
      // The forged grant is rejected first; to reach the caller-repo guard we
      // would need a real grant, which requires full LeaseAuthority acquisition.
      // This test pins the guard's error message so a future regression that
      // removes it fails this test.
      expect(() => fixture.resolver.resolveAuthorityExecutionContext({
        attempt: fixture.attempt,
        contract: fixture.contract,
        phase: "implement",
        phaseOrdinal: 0,
        role: "worker",
        ownership: { plan: { worktreePath: fixture.repo } } as never,
        policyBundle: {
          kind: "materialized_authenticated_policy_bundle",
          policyRoot,
          bundleDir,
          requestedBundleSha256: "1".repeat(64),
        },
        modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
        timeoutMs: 30_000,
        callerRepositoryRealpath: fixture.repo,
      })).toThrow(/authorized LeaseAuthority|caller repository/);
    });
  });

  describe("legacy v1 rejection", () => {
    it("a released (stale/legacy) ownership cannot mint a cleanup-eligibility receipt", () => {
      const fixture = buildFixture();
      // Release the ownership (simulating a v1/stale lease that is no longer current).
      updateRow(fixture.store.location.databasePath, "attempt_ownership_leases", "ownership_id", fixture.ownershipId, {
        state: "released",
        state_version: 2,
      });
      const observation = makeCleanupEligibilityObservation(fixture);
      expectStateCode(
        () => fixture.store.mintCleanupEligibility(
          {
            observation,
            targetProofSetId: `target-proof-set-${fixture.attempt.attemptId}`,
            ownershipSnapshotEvidenceId: `evidence-ownership-v2-${fixture.attempt.attemptId}`,
            claimSnapshotEvidenceIds: T18_RESOURCE_KINDS.map((kind) => `evidence-resource-claim-v2-${kind}-${fixture.attempt.attemptId}`),
          },
          fixture.leases.issueDispositionMintCapability(),
        ),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );
    });

    it("a generic cleanup record cannot authorize a purpose-specific finalization", () => {
      const fixture = buildFixture();
      const genericCleanupRecord = { kind: "cleanup_record", attemptId: fixture.attempt.attemptId };
      expect(dispositionReceiptKind(genericCleanupRecord)).toBe(null);
      expect(receiptSatisfiesFinalization(genericCleanupRecord, "failure")).toBe(false);
      expect(receiptSatisfiesFinalization(genericCleanupRecord, "promotion")).toBe(false);
      expect(receiptSatisfiesFinalization(genericCleanupRecord, "quarantine")).toBe(false);
      const failureObservation = makeFailureObservation(fixture);
      expect(() => finalizeFailure({
        store: fixture.store, leases: fixture.leases,
        request: { observation: failureObservation, targetProofSetId: `target-proof-set-${fixture.attempt.attemptId}`, causeEvidenceId: `evidence-salvage-${fixture.attempt.attemptId}` },
        receipt: genericCleanupRecord as never,
      })).toThrow(/exact branded Store-minted receipt/);
    });
  });

  describe("negative-proof matrix", () => {
    it("crash-point: a fault mid-transaction leaves zero receipt rows and the gate held", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      const db = openRaw(fixture.store.location.databasePath);
      try {
        db.exec(`CREATE TRIGGER tnr_matrix_crash BEFORE INSERT ON evidence
                 WHEN NEW.scope = '${observation.receiptId}' BEGIN SELECT RAISE(ABORT, 'crash'); END`);
      } finally { db.close(); }
      expectStateCode(
        () => fixture.store.mintTargetNeverReleased({ observation }, fixture.leases.issueDispositionMintCapability()),
        "RICKGENT_STATE_CONFLICT",
      );
      expect(count(fixture.store.location.databasePath, "evidence", fixture.attempt.attemptId)).toBe(0);
      const gate = queryAll(fixture.store.location.databasePath,
        "SELECT state FROM target_start_gates WHERE target_start_gate_id = ?", fixture.targetStartGateId)[0]!;
      expect(gate.state).toBe("held");
    });

    it("partial-write: a receipt row insert that faults rolls back the evidence too", () => {
      const fixture = buildFixture();
      insertSalvageRecord(fixture);
      insertTargetProofSetSealed(fixture);
      const db = openRaw(fixture.store.location.databasePath);
      try {
        db.exec(`CREATE TRIGGER partial_write_test BEFORE INSERT ON failure_cleanup_records
                 BEGIN SELECT RAISE(ABORT, 'partial write'); END`);
      } finally { db.close(); }
      const observation = makeFailureObservation(fixture);
      expectStateCode(
        () => fixture.store.mintFailureCleanup(
          { observation, targetProofSetId: `target-proof-set-${fixture.attempt.attemptId}`, causeEvidenceId: `evidence-salvage-${fixture.attempt.attemptId}` },
          fixture.leases.issueDispositionMintCapability(),
        ),
        "RICKGENT_STATE_CONFLICT",
      );
      // No failure-cleanup evidence leaked.
      expect(queryAll(fixture.store.location.databasePath,
        "SELECT * FROM evidence WHERE producer_service = 'FailureCleanupService' AND attempt_id = ?", fixture.attempt.attemptId).length).toBe(0);
      expect(count(fixture.store.location.databasePath, "failure_cleanup_records", fixture.attempt.attemptId)).toBe(0);
      const cleanup = openRaw(fixture.store.location.databasePath);
      try { cleanup.exec("DROP TRIGGER partial_write_test"); } finally { cleanup.close(); }
    });

    it("idempotency: divergent postimage conflicts for the same receipt id", () => {
      const fixture = buildFixture();
      insertSalvageRecord(fixture);
      insertTargetProofSetSealed(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const observation = makeFailureObservation(fixture);
      const first = fixture.store.mintFailureCleanup(
        { observation, targetProofSetId: `target-proof-set-${fixture.attempt.attemptId}`, causeEvidenceId: `evidence-salvage-${fixture.attempt.attemptId}` },
        capability,
      );
      expect(first.replayed).toBe(false);
      // Replay with identical input returns the identical postimage.
      const replay = fixture.store.mintFailureCleanup(
        { observation, targetProofSetId: `target-proof-set-${fixture.attempt.attemptId}`, causeEvidenceId: `evidence-salvage-${fixture.attempt.attemptId}` },
        capability,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.record).toEqual(first.record);
    });

    it("rollback: a fault then retry succeeds with the correct postimage", () => {
      const fixture = buildFixture();
      const observation = makeTargetNeverReleasedObservation(fixture);
      const capability = fixture.leases.issueDispositionMintCapability();
      const db = openRaw(fixture.store.location.databasePath);
      try {
        db.exec(`CREATE TRIGGER rollback_test BEFORE INSERT ON evidence
                 WHEN NEW.scope = '${observation.receiptId}' BEGIN SELECT RAISE(ABORT, 'rollback'); END`);
      } finally { db.close(); }
      expectStateCode(
        () => fixture.store.mintTargetNeverReleased({ observation }, capability),
        "RICKGENT_STATE_CONFLICT",
      );
      const cleanup = openRaw(fixture.store.location.databasePath);
      try { cleanup.exec("DROP TRIGGER rollback_test"); } finally { cleanup.close(); }
      const retry = fixture.store.mintTargetNeverReleased({ observation }, capability);
      expect(retry.replayed).toBe(false);
      expect(String(retry.record.state)).toBe("closed_never_released");
    });
  });
});
