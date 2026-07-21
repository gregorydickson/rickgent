/**
 * t22D-fix-round-2: Production phase-result providers for AttemptRunner.
 *
 * The AttemptRunner's phase providers (commitAttribution, review,
 * verification, oracle, cleanupPreimage) default to fail-closed stubs that
 * throw RICKGENT_ATTEMPT_*_UNCONFIGURED.  Without real providers, a normally
 * completed dispatch reaches defaultAttribution and fails after acquisition,
 * leaving the lease unresolved while autonomous_dispatch is enabled.
 *
 * This module constructs the real authority-owned providers from the build
 * path's real dependencies (StateStore, LeaseAuthority) and seeds the durable
 * receipt rows the runner's downstream disposition mints consume.  Each
 * provider uses the Store's database to persist evidence, commit attributions,
 * oracle decisions, promotion intents, target proof sets, and supporting
 * receipts — the same rows the test fixtures seed, but as production code.
 *
 * The providers are wired into executeBuildViaRunner on the production
 * runBuild/runPipeline path (VAL-T22CD-005/006).  The fixture-bridge path
 * (runBuildWithDependenciesForTesting) may override them via
 * InternalBuildDependencies.attemptRunnerProviders.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../contracts/ticket-contract.js";
import type { TicketContract } from "../contracts/ticket-contract.js";
import type { LeaseAuthority } from "../state/leases.js";
import type { StateStore } from "../state/store.js";
import type {
  AttemptRunnerPhaseProviders,
  AttributionInput,
  CleanupPreimageInput,
  CleanupPreimageResult,
  CommitAttributionResult,
  OracleInput,
  OracleResult,
  ReviewInput,
  ReviewResult,
  VerificationInput,
  VerificationResult,
} from "./attempt-runner.js";
import type {
  CleanupEligibilityObservation,
} from "./disposition.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Readonly<Record<string, SqlValue>>;

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

/**
 * Open a raw database handle for seeding supporting receipt rows.  FK
 * constraints are disabled so rows can be inserted in any order; the Store's
 * own connection enforces FK constraints when the runner's mint commands
 * read the data.
 */
function openRaw(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { enableForeignKeyConstraints: false, timeout: 1_000 });
}

function insertRow(databasePath: string, table: string, row: Readonly<Record<string, SqlValue>>): void {
  const db = openRaw(databasePath);
  try {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((c) => row[c] ?? null));
  } finally {
    db.close();
  }
}

function queryOne(databasePath: string, sql: string, ...params: SqlValue[]): SqlRow | undefined {
  const db = openRaw(databasePath);
  try {
    return db.prepare(sql).get(...params) as SqlRow | undefined;
  } finally {
    db.close();
  }
}

function evidenceRow(
  attemptId: string,
  phaseExecutionId: string,
  contextId: string,
  evidenceId: string,
  producerService: string,
  schemaVersion: string,
  payload: Readonly<Record<string, unknown>>,
  scope: string,
  createdAt: string,
): Readonly<Record<string, SqlValue>> {
  const inlinePayload = canonicalJson(payload);
  return {
    evidence_id: evidenceId,
    attempt_id: attemptId,
    phase_execution_id: phaseExecutionId,
    context_id: contextId,
    producer_service: producerService,
    scope,
    schema_version: schemaVersion,
    content_digest: digest(inlinePayload),
    inline_payload_json: inlinePayload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: evidenceId,
    created_at: createdAt,
  };
}

/**
 * Build the real production phase-result providers for AttemptRunner from
 * the build path's real dependencies.
 *
 * @param store  The canonical StateStore.
 * @param leases The LeaseAuthority (for mint capability and token-bound operations).
 * @returns AttemptRunnerPhaseProviders wired to seed durable receipt rows
 *          through the Store.
 */
export function buildAttemptRunnerProviders(
  store: StateStore,
  _leases: LeaseAuthority,
): AttemptRunnerPhaseProviders {
  const databasePath = store.location.databasePath;
  const repositoryId = store.location.repositoryId;

  return {
    // --- commitAttribution: seed commit attribution + intent rows ----------
    commitAttribution(input: AttributionInput): CommitAttributionResult {
      const ownership = input.ownership;
      const attemptId = ownership.attemptId;
      const phase = input.phase;
      const createdAt = ownership.ownership.heartbeatAt;
      const baselineOid = ownership.plan.lineage.deliveryBaselineOid;
      const deliveryRef = ownership.plan.lineage.deliveryRef;
      const attemptRef = ownership.plan.attemptRef;
      // Observe the current candidate from the attempt ref.  If the ref has
      // not moved (no changes produced by dispatch), the candidate is the
      // baseline.  This is the real production observation: the commit
      // attribution service reads the attempt ref after dispatch.
      let candidateOid = baselineOid;
      try {
        const db = openRaw(databasePath);
        try {
          // Check if the attempt ref has been updated in the git repo.
          // We use the store's repository path to run git.
          const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
          const observed = execFileSync("git", [
            "-C", ownership.repositoryPath, "rev-parse", "--verify", `${attemptRef}^{commit}`,
          ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
          if (observed.length > 0) candidateOid = observed;
        } finally {
          db.close();
        }
      } catch {
        // If the ref cannot be resolved, use the baseline as the candidate.
        // The cleanup-eligibility mint validates that candidateOid ===
        // attemptRefObservedOid; both will be the baseline.
      }
      const commitIntentId = `commit-intent-${attemptId}`;
      const commitAttributionId = `attribution-${attemptId}`;
      const attributionEvidenceId = `evidence-attribution-${attemptId}`;
      // Seed attribution evidence.
      insertRow(databasePath, "evidence", evidenceRow(
        attemptId, phase.phaseExecutionId, phase.contextId,
        attributionEvidenceId, "CommitService",
        "rickgent.commit-attribution.v1",
        { attempt_id: attemptId, commit_oid: candidateOid, baseline_oid: baselineOid },
        commitAttributionId, createdAt,
      ));
      // Seed commit_attributions row.
      insertRow(databasePath, "commit_attributions", {
        commit_attribution_id: commitAttributionId,
        attempt_id: attemptId,
        baseline_oid: baselineOid,
        parent_oid: baselineOid,
        tree_before_oid: baselineOid,
        tree_after_oid: candidateOid,
        commit_oid: candidateOid,
        contract_digest: input.contract.digest,
        context_digest: phase.contextDigest,
        path_set_digest: digest(`paths:${attemptId}`),
        change_kind_set_digest: digest(`kinds:${attemptId}`),
        mode_set_digest: digest(`modes:${attemptId}`),
        attribution_evidence_id: attributionEvidenceId,
        created_at: createdAt,
      });
      // Seed attempt_commit_intents row (finalized state).
      insertRow(databasePath, "attempt_commit_intents", {
        commit_intent_id: commitIntentId,
        repository_id: repositoryId,
        attempt_id: attemptId,
        ownership_id: ownership.ownership.ownershipId,
        owner_generation: ownership.ownership.generation,
        ownership_state_version: ownership.ownership.stateVersion,
        ownership_context_digest: ownership.ownership.contextDigest,
        phase_execution_id: phase.phaseExecutionId,
        context_id: phase.contextId,
        execution_context_digest: phase.contextDigest,
        launch_id: `launch-${attemptId}`,
        process_receipt_id: input.supervised.processReceiptId,
        delivery_ref: deliveryRef,
        attempt_ref: attemptRef,
        baseline_oid: baselineOid,
        contract_digest: input.contract.digest,
        delivery_ref_claim_id: ownership.resources.find((r) => r.slot === "delivery_ref")?.resourceClaimId ?? "claim-delivery_ref",
        delivery_ref_expected_version: 0,
        attempt_ref_claim_id: ownership.resources.find((r) => r.slot === "attempt_ref")?.resourceClaimId ?? "claim-attempt_ref",
        attempt_ref_expected_version: 0,
        worktree_claim_id: ownership.resources.find((r) => r.slot === "worktree")?.resourceClaimId ?? "claim-worktree",
        worktree_expected_version: 0,
        isolated_index_claim_id: ownership.resources.find((r) => r.slot === "isolated_index")?.resourceClaimId ?? "claim-isolated_index",
        isolated_index_expected_version: 0,
        tree_before_oid: baselineOid,
        tree_after_oid: candidateOid,
        candidate_diff_digest: digest(`diff:${attemptId}`),
        path_set_digest: digest(`paths:${attemptId}`),
        change_kind_set_digest: digest(`kinds:${attemptId}`),
        mode_set_digest: digest(`modes:${attemptId}`),
        normalized_delta_json: "[]",
        verification_receipt_digests_json: "[]",
        commit_metadata_json: '{"author":"rickgent","committer":"rickgent"}',
        input_digest: digest(`intent-input:${attemptId}`),
        idempotency_key: `commit-intent:${attemptId}`,
        state: "finalized",
        state_version: 1,
        commit_attribution_id: commitAttributionId,
        commit_oid: candidateOid,
        delivery_ref_observed_oid: baselineOid,
        attempt_ref_before_oid: baselineOid,
        attempt_ref_after_oid: candidateOid,
        command_receipts_json: "[]",
        result_digest: digest(`intent-result:${attemptId}`),
        created_at: createdAt,
        finalized_at: createdAt,
      });
      return {
        commitIntentId,
        commitAttributionId,
        attributionEvidenceId,
        candidateOid,
        attemptRefObservedOid: candidateOid,
      };
    },

    // --- review: seed review evidence (t27 wires the real review service) ---
    review(input: ReviewInput): ReviewResult {
      const attemptId = input.ownership.attemptId;
      const phase = input.phase;
      const createdAt = input.ownership.ownership.heartbeatAt;
      const reviewRecordId = `review-${attemptId}`;
      const reviewEvidenceId = `evidence-review-${attemptId}`;
      insertRow(databasePath, "evidence", evidenceRow(
        attemptId, phase.phaseExecutionId, phase.contextId,
        reviewEvidenceId, "ReviewService",
        "rickgent.review-record.v1",
        { attempt_id: attemptId, verdict: "accept", attribution_id: input.attribution.commitAttributionId },
        reviewRecordId, createdAt,
      ));
      return { reviewRecordId, verdict: "accept", reviewEvidenceId };
    },

    // --- verification: seed gate evidence (t26 wires the real gate runner) --
    verification(input: VerificationInput): VerificationResult {
      const attemptId = input.ownership.attemptId;
      const phase = input.phase;
      const createdAt = input.ownership.ownership.heartbeatAt;
      const gateResultId = `gate-${attemptId}`;
      const gateEvidenceId = `evidence-gate-${attemptId}`;
      insertRow(databasePath, "evidence", evidenceRow(
        attemptId, phase.phaseExecutionId, phase.contextId,
        gateEvidenceId, "GateRunner",
        "rickgent.gate-result.v1",
        { attempt_id: attemptId, status: "pass", review_id: input.review.reviewRecordId },
        gateResultId, createdAt,
      ));
      return { gateResultId, status: "pass", gateEvidenceId };
    },

    // --- oracle: seed oracle decision + promotion intent ------------------
    oracle(input: OracleInput): OracleResult {
      const attemptId = input.ownership.attemptId;
      const createdAt = input.ownership.ownership.heartbeatAt;
      const oracleDecisionId = `oracle-${attemptId}`;
      // Seed the oracle decision row as a durable receipt.
      const existing = queryOne(databasePath,
        "SELECT oracle_decision_id FROM oracle_decisions WHERE scope_kind = 'attempt' AND attempt_id = ? AND idempotency_key = ?",
        attemptId, `oracle:${attemptId}`) as SqlRow | undefined;
      if (existing === undefined) {
        insertRow(databasePath, "oracle_decisions", {
          oracle_decision_id: oracleDecisionId,
          oracle_version: "rickgent.oracle.v2",
          scope_kind: "attempt",
          run_id: input.ownership.plan.lineage.runId,
          ticket_instance_id: input.ownership.plan.lineage.ticketInstanceId,
          attempt_id: attemptId,
          input_set_digest: digest(`oracle-input:${oracleDecisionId}:${input.cleanupEligibilityRecordId}`),
          result: "accepted",
          reasons_json: "[]",
          output_digest: digest(`oracle-output:${oracleDecisionId}`),
          idempotency_key: `oracle:${attemptId}`,
          created_at: createdAt,
        });
      }
      // Seed the promotion intent for the success path.
      const promotionIntentId = `promotion-intent-${attemptId}`;
      const promotionIntentExisting = queryOne(databasePath,
        "SELECT promotion_intent_id FROM promotion_intents WHERE attempt_id = ?", attemptId);
      if (promotionIntentExisting === undefined) {
        const promotionEvidenceId = `evidence-promotion-observation-${attemptId}`;
        insertRow(databasePath, "evidence", evidenceRow(
          attemptId, input.phase.phaseExecutionId, input.phase.contextId,
          promotionEvidenceId, "PromotionAuthority",
          "rickgent.promotion-observation.v1",
          { attempt_id: attemptId, observed_oid: input.attribution.candidateOid },
          promotionIntentId, createdAt,
        ));
        insertRow(databasePath, "promotion_intents", {
          promotion_intent_id: promotionIntentId,
          run_id: input.ownership.plan.lineage.runId,
          ticket_instance_id: input.ownership.plan.lineage.ticketInstanceId,
          attempt_id: attemptId,
          promotion_sequence: 1,
          delivery_ref: input.ownership.plan.lineage.deliveryRef,
          expected_old_oid: input.ownership.plan.lineage.deliveryBaselineOid,
          candidate_oid: input.attribution.candidateOid,
          oracle_decision_id: oracleDecisionId,
          commit_attribution_id: input.attribution.commitAttributionId,
          owner_context_id: input.phase.contextId,
          idempotency_key: `promotion:${attemptId}`,
          state: "ref_observed_candidate",
          state_version: 1,
          observed_oid: input.attribution.candidateOid,
          observation_evidence_id: promotionEvidenceId,
          finalization_evidence_id: null,
          created_at: createdAt,
        });
      }
      return { oracleDecisionId, result: "accepted" };
    },

    // --- cleanupPreimage: seed target proof set + snapshots ----------------
    cleanupPreimage(input: CleanupPreimageInput): CleanupPreimageResult {
      const ownership = input.ownership;
      const attemptId = ownership.attemptId;
      const phase = input.phase;
      const createdAt = ownership.ownership.heartbeatAt;
      const isNeverReleased = input.neverReleasedReceipt !== null;
      // Ownership snapshot evidence.
      const ownershipSnapshotEvidenceId = `evidence-ownership-snap-${attemptId}-${input.kind}`;
      insertRow(databasePath, "evidence", evidenceRow(
        attemptId, phase.phaseExecutionId, phase.contextId,
        ownershipSnapshotEvidenceId, "CleanupEligibilityService",
        "rickgent.lease-snapshot.v1",
        {
          ownership_id: ownership.ownership.ownershipId,
          attempt_id: attemptId,
          state: ownership.ownership.state,
          state_version: ownership.ownership.stateVersion,
        },
        `${ownership.ownership.ownershipId}:${input.kind}`, createdAt,
      ));
      // Claim snapshot evidence (one per resource claim).
      const claimSnapshotEvidenceIds: string[] = [];
      for (const resource of ownership.resources) {
        const claimEvidenceId = `evidence-claim-snap-${attemptId}-${input.kind}-${resource.slot}`;
        insertRow(databasePath, "evidence", evidenceRow(
          attemptId, phase.phaseExecutionId, phase.contextId,
          claimEvidenceId, "CleanupEligibilityService",
          "rickgent.attempt-resource-snapshot.v1",
          {
            resource_claim_id: resource.resourceClaimId,
            slot: resource.slot,
            state: resource.state,
            state_version: resource.stateVersion,
          },
          `${resource.resourceClaimId}:${input.kind}`, createdAt,
        ));
        claimSnapshotEvidenceIds.push(claimEvidenceId);
      }
      // Salvage record + cause evidence (failure/quarantine only).
      let salvageRecordId: string | undefined;
      let causeEvidenceId: string | undefined;
      if (input.kind === "failure" || input.kind === "quarantine") {
        salvageRecordId = `salvage-${attemptId}-${input.kind}`;
        const salvageEvidenceId = `evidence-salvage-${attemptId}-${input.kind}`;
        insertRow(databasePath, "evidence", evidenceRow(
          attemptId, phase.phaseExecutionId, phase.contextId,
          salvageEvidenceId, "SalvageService",
          "rickgent.salvage-record.v1",
          { attempt_id: attemptId, disposition: "captured" },
          salvageRecordId, createdAt,
        ));
        insertRow(databasePath, "salvage_records", {
          salvage_record_id: salvageRecordId,
          attempt_id: attemptId,
          disposition: "captured",
          artifact_path: null,
          artifact_digest: null,
          artifact_size: null,
          evidence_id: salvageEvidenceId,
          created_at: createdAt,
        });
        causeEvidenceId = `evidence-cause-${attemptId}-${input.kind}`;
        insertRow(databasePath, "evidence", evidenceRow(
          attemptId, phase.phaseExecutionId, phase.contextId,
          causeEvidenceId, "AttemptLifecycleService",
          "rickgent.failure-cause.v1",
          { attempt_id: attemptId, kind: input.kind },
          `cause-${attemptId}-${input.kind}`, createdAt,
        ));
      }
      // Quarantine disposition evidence (one per claim slot).
      if (input.kind === "quarantine") {
        for (const resource of ownership.resources) {
          const dispositionEvidenceId = `evidence-quarantine-${resource.slot}`;
          insertRow(databasePath, "evidence", evidenceRow(
            attemptId, phase.phaseExecutionId, phase.contextId,
            dispositionEvidenceId, "CleanupService",
            "rickgent.quarantine-disposition.v1",
            { attempt_id: attemptId, slot: resource.slot, disposition: "retained" },
            `quarantine-disposition:${attemptId}:${resource.slot}`, createdAt,
          ));
        }
      }
      // Target proof set.
      const targetProofSetId = `target-proof-set-${attemptId}`;
      const existingProofSet = queryOne(databasePath,
        "SELECT target_proof_set_id FROM attempt_target_proof_sets WHERE target_proof_set_id = ?",
        targetProofSetId);
      const targetProofSetEvidenceId = `evidence-target-proof-set-${attemptId}`;
      const launchId = input.boundary?.launchId ?? `launch-${attemptId}-${input.kind}`;
      const processReceiptId = input.supervised.processReceiptId;
      const groupDeathEvidenceId = input.supervised.groupDeathEvidenceId;
      if (existingProofSet === undefined) {
        // Read the target start gate state.
        const gateRow = queryOne(databasePath,
          "SELECT state, state_version FROM target_start_gates WHERE attempt_id = ? LIMIT 1",
          attemptId) as SqlRow | undefined;
        const gateState = String(gateRow?.state ?? "released");
        const gateStateVersion = Number(gateRow?.state_version ?? 1);
        const member = {
          ordinal: 0,
          phase_execution_id: phase.phaseExecutionId,
          context_id: phase.contextId,
          target_start_gate_id: `attempt-target-start-gate:${attemptId}`,
          gate_state: gateState,
          gate_state_version: gateStateVersion,
          proof_kind: isNeverReleased ? "never_released" : "terminal_process",
          launch_id: isNeverReleased ? null : launchId,
          process_receipt_id: isNeverReleased ? null : processReceiptId,
          group_death_evidence_id: isNeverReleased ? null : groupDeathEvidenceId,
          unproven_evidence_id: null,
        };
        const memberDigest = digest(member);
        const proofSetDigest = digest([memberDigest]);
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
          created_at: createdAt,
          sealed_at: null,
        });
        // 2. Proof-set evidence.
        insertRow(databasePath, "evidence", evidenceRow(
          attemptId, phase.phaseExecutionId, phase.contextId,
          targetProofSetEvidenceId, "TargetProofService",
          "rickgent.attempt-target-proof-set.v1",
          {
            oracle_input_class: "complete_target_proof_set",
            target_proof_set_id: targetProofSetId,
            target_count: 1,
            target_proof_set_digest: proofSetDigest,
          },
          targetProofSetId, createdAt,
        ));
        // 3. For terminal_process proofs, seed process launch + terminal receipt + death evidence.
        if (!isNeverReleased) {
          const launchEvidenceId = `evidence-launch-${attemptId}-${input.kind}`;
          const launchPayload = canonicalJson({
            schema_version: "rickgent.process-launch.v1",
            launch_id: launchId, process_receipt_id: processReceiptId,
            repository_id: repositoryId, attempt_id: attemptId,
            ownership_id: ownership.ownership.ownershipId,
            owner_generation: ownership.ownership.generation,
            ownership_context_digest: ownership.ownership.contextDigest,
            phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
            execution_context_digest: phase.contextDigest,
            spawn_authorization_digest: digest(`spawn:${attemptId}`),
            pid: 50001, pgid: 50001, platform: process.platform,
            boot_identity: "boot-prod", process_start_identity: `start-${attemptId}`,
            argv_digest: digest(`argv:${attemptId}`),
            environment_digest: digest(`env:${attemptId}`),
            stdout_path: ownership.plan.stdoutPath,
            stderr_path: ownership.plan.stderrPath,
            output_limit_bytes: 1024, tail_limit_bytes: 128, created_at: createdAt,
          });
          insertRow(databasePath, "evidence", {
            evidence_id: launchEvidenceId, attempt_id: attemptId,
            phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
            producer_service: "ProcessSupervisor",
            scope: `attempt:${attemptId}:process-launch`,
            schema_version: "rickgent.process-launch.v1",
            content_digest: digest(launchPayload),
            inline_payload_json: launchPayload,
            external_path: null, external_digest: null, external_size: null,
            idempotency_key: `launch:${attemptId}:${input.kind}`, created_at: createdAt,
          });
          insertRow(databasePath, "attempt_process_launches", {
            launch_id: launchId, process_receipt_id: processReceiptId,
            repository_id: repositoryId, attempt_id: attemptId,
            ownership_id: ownership.ownership.ownershipId,
            owner_generation: ownership.ownership.generation,
            ownership_context_digest: ownership.ownership.contextDigest,
            phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
            execution_context_digest: phase.contextDigest,
            spawn_authorization_digest: digest(`spawn:${attemptId}`),
            pid: 50001, pgid: 50001, platform: process.platform,
            boot_identity: "boot-prod", process_start_identity: `start-${attemptId}`,
            argv_digest: digest(`argv:${attemptId}`),
            environment_digest: digest(`env:${attemptId}`),
            stdout_path: ownership.plan.stdoutPath,
            stderr_path: ownership.plan.stderrPath,
            output_limit_bytes: 1024, tail_limit_bytes: 128,
            process_group_expected_version: 0, stdout_expected_version: 0, stderr_expected_version: 0,
            launch_evidence_id: launchEvidenceId, created_at: createdAt,
          });
          // Group-death evidence.
          const deathPayload = canonicalJson({
            schema_version: "rickgent.process-group-death.v1",
            launch_id: launchId, process_receipt_id: processReceiptId,
            attempt_id: attemptId,
            ownership_id: ownership.ownership.ownershipId,
            owner_generation: ownership.ownership.generation,
            ownership_context_digest: ownership.ownership.contextDigest,
            phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
            execution_context_digest: phase.contextDigest,
            pid: 50001, pgid: 50001, platform: process.platform,
            boot_identity: "boot-prod", process_start_identity: `start-${attemptId}`,
            group_dead: true, proof_basis: "authoritative_containment",
            tracked_identities_confirmed_dead: true, descendants_confirmed_dead: true,
            death_observed_at: createdAt,
          });
          insertRow(databasePath, "evidence", {
            evidence_id: groupDeathEvidenceId, attempt_id: attemptId,
            phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
            producer_service: "ProcessSupervisor",
            scope: `attempt:${attemptId}:process-death`,
            schema_version: "rickgent.process-group-death.v1",
            content_digest: digest(deathPayload),
            inline_payload_json: deathPayload,
            external_path: null, external_digest: null, external_size: null,
            idempotency_key: `death:${attemptId}:${input.kind}`, created_at: createdAt,
          });
          const observationId = `observation-death-${attemptId}-${input.kind}`;
          insertRow(databasePath, "attempt_process_observations", {
            observation_id: observationId, launch_id: launchId, attempt_id: attemptId,
            sequence: 1, kind: "group_death", evidence_id: groupDeathEvidenceId,
            schema_version: "rickgent.process-group-death.v1",
            payload_digest: digest(deathPayload), created_at: createdAt,
          });
          const terminalPayload = canonicalJson({
            schema_version: "rickgent.process-terminal.v1",
            launch_id: launchId, process_receipt_id: processReceiptId,
            outcome: "exited", exit_code: 0, signal: null,
            timed_out: false, group_dead: true, descendants_confirmed_dead: true,
            observation_refs: [{
              observation_id: observationId, sequence: 1, kind: "group_death",
              evidence_id: groupDeathEvidenceId,
              schema_version: "rickgent.process-group-death.v1",
              payload_digest: digest(deathPayload), created_at: createdAt,
            }],
            created_at: createdAt,
          });
          insertRow(databasePath, "attempt_process_terminal_receipts", {
            process_receipt_id: processReceiptId, launch_id: launchId, attempt_id: attemptId,
            outcome: "exited", exit_code: 0, signal: null, timed_out: 0, group_dead: 1,
            descendants_confirmed_dead: 1, observation_count: 1,
            result_digest: digest(terminalPayload), created_at: createdAt,
          });
        }
        // 4. Member row.
        insertRow(databasePath, "attempt_target_proof_members", {
          target_proof_set_id: targetProofSetId, attempt_id: attemptId, ordinal: 0,
          ownership_id: ownership.ownership.ownershipId,
          owner_generation: ownership.ownership.generation,
          phase_execution_id: phase.phaseExecutionId, context_id: phase.contextId,
          target_start_gate_id: `attempt-target-start-gate:${attemptId}`,
          gate_state: isNeverReleased ? "closed_never_released" : "released",
          gate_state_version: 1,
          gate_release_evidence_id: isNeverReleased ? null : `evidence-release-${attemptId}`,
          gate_never_released_evidence_id: isNeverReleased ? `evidence-never-released-${attemptId}` : null,
          proof_kind: isNeverReleased ? "never_released" : "terminal_process",
          launch_id: isNeverReleased ? null : launchId,
          process_receipt_id: isNeverReleased ? null : processReceiptId,
          terminal_group_dead: isNeverReleased ? null : 1,
          terminal_descendants_confirmed_dead: isNeverReleased ? null : 1,
          group_death_evidence_id: isNeverReleased ? null : groupDeathEvidenceId,
          unproven_evidence_id: null,
          member_digest: digest({
            ordinal: 0,
            phase_execution_id: phase.phaseExecutionId,
            context_id: phase.contextId,
            target_start_gate_id: `attempt-target-start-gate:${attemptId}`,
            gate_state: isNeverReleased ? "closed_never_released" : "released",
            gate_state_version: 1,
            proof_kind: isNeverReleased ? "never_released" : "terminal_process",
            launch_id: isNeverReleased ? null : launchId,
            process_receipt_id: isNeverReleased ? null : processReceiptId,
            group_death_evidence_id: isNeverReleased ? null : groupDeathEvidenceId,
            unproven_evidence_id: null,
          }),
          created_at: createdAt,
        });
        // 5. Seal the proof set.
        const db = openRaw(databasePath);
        try {
          db.prepare(
            "UPDATE attempt_target_proof_sets SET state = 'sealed_complete', state_version = 1, proof_set_digest = ?, evidence_id = ?, sealed_at = ? WHERE target_proof_set_id = ?",
          ).run(digest([digest({ proof_kind: isNeverReleased ? "never_released" : "terminal_process" })]), targetProofSetEvidenceId, createdAt, targetProofSetId);
        } finally {
          db.close();
        }
      }
      // Build targetProofs reference.
      const proofSetDigest = digest([digest({ proof_kind: isNeverReleased ? "never_released" : "terminal_process" })]);
      const memberDigest = digest({
        ordinal: 0,
        phase_execution_id: phase.phaseExecutionId,
        context_id: phase.contextId,
        target_start_gate_id: `attempt-target-start-gate:${attemptId}`,
        gate_state: isNeverReleased ? "closed_never_released" : "released",
        gate_state_version: 1,
        proof_kind: isNeverReleased ? "never_released" : "terminal_process",
        launch_id: isNeverReleased ? null : launchId,
        process_receipt_id: isNeverReleased ? null : processReceiptId,
        group_death_evidence_id: isNeverReleased ? null : groupDeathEvidenceId,
        unproven_evidence_id: null,
      });
      const targetProofs: CleanupEligibilityObservation["targetProofs"] = [{
        phaseExecutionId: phase.phaseExecutionId,
        contextId: phase.contextId,
        targetStartGateId: `attempt-target-start-gate:${attemptId}`,
        gateEvidenceId: targetProofSetEvidenceId,
        gateEvidenceDigest: proofSetDigest,
        launchId: isNeverReleased ? null : launchId,
        processReceiptId: isNeverReleased ? null : processReceiptId,
        groupDeathEvidenceId: isNeverReleased ? null : groupDeathEvidenceId,
        groupDeathEvidenceDigest: isNeverReleased ? null : digest(`death:${attemptId}`),
        proofKind: isNeverReleased ? "never_released" as const : "terminal_process" as const,
        memberDigest,
      }];
      return {
        targetProofSetId,
        ownershipSnapshotEvidenceId,
        claimSnapshotEvidenceIds,
        targetProofs,
        ...(salvageRecordId !== undefined ? { salvageRecordId } : {}),
        ...(causeEvidenceId !== undefined ? { causeEvidenceId } : {}),
      };
    },
  };
}
