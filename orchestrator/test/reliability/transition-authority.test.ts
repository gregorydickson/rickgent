import { execFileSync, fork, type ChildProcess } from "node:child_process";
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
  canonicalGitDeltaFromRaw,
  StateStoreError,
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateRecord,
  type StateStore,
} from "../../src/state/store.js";
import {
  DeliveryAuthority,
  DeliveryCommand,
  LifecycleRecordAuthority,
  LifecycleRecordCommand,
  PromotionAuthority,
  PromotionCommit,
  TransitionAuthority,
  TransitionCommit,
  type DeliveryDecisionRequest,
  type DeliveryIntentRequest,
  type CleanupRecordRequest,
  type CommitAttributionRecordRequest,
  type GateResultRecordRequest,
  type ProcessReceiptRecordRequest,
  type PrObservationRequest,
  type RemediationRecordRequest,
  type RemoteObservationRequest,
  type ReviewRecordRequest,
  type ExistingTransitionEvidenceReference,
  type PromotionFinalizationRequest,
  type PromotionIntentRequest,
  type PromotionResult,
  type TransitionResult,
} from "../../src/state/transitions.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = "rickgent.oracle.v1";
const childFixture = join(import.meta.dirname, "../fixtures/transition-authority/child.mjs");
const scratchRoots = new Set<string>();
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-transition-authority-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Transition Authority Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "transition-authority@example.test"]);
  writeFileSync(join(repo, "README.md"), "transition authority\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function repoHead(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function createCandidateCommit(fixture: LineageFixture): string {
  mkdirSync(join(fixture.repo, "src"), { recursive: true });
  writeFileSync(join(fixture.repo, "src", "t15.ts"), "export const promotion = true;\n", "utf8");
  execFileSync("git", ["-C", fixture.repo, "add", "src/t15.ts"]);
  execFileSync("git", ["-C", fixture.repo, "commit", "-qm", "promotion candidate"]);
  const candidateOid = repoHead(fixture.repo);
  execFileSync("git", ["-C", fixture.repo, "update-ref", fixture.run.deliveryRef, fixture.run.currentDeliveryOid]);
  return candidateOid;
}

function repositoryTree(repo: string, oid: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", `${oid}^{tree}`], { encoding: "utf8" }).trim();
}

function canonicalFixtureDelta(fixture: LineageFixture, to: string) {
  const raw = execFileSync("git", [
    "-C",
    fixture.repo,
    "diff",
    "--raw",
    "-z",
    "--no-abbrev",
    "-M",
    fixture.attempt.deliveryBaselineOid,
    to,
  ], { encoding: "utf8" });
  return canonicalGitDeltaFromRaw(raw);
}

function ticketDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t15",
    title: "Transition authority",
    description: "Exercise transaction-scoped lifecycle transition authority.",
    depends_on: [],
    scope: [{ path: "src/t15.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-TRANSITION",
      description: "Only guarded owner-checked transitions can change lifecycle state.",
      interface_ids: [],
      verification_ids: ["VER-TRANSITION"],
    }],
    verifications: [{
      id: "VER-TRANSITION",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 2,
      wall_clock_ms: 120_000,
      remediation_limit: 1,
    },
  };
}

function ticketContract(repo: string): TicketContract {
  return sealTicketContracts([ticketDraft()], { repositoryRoot: repo })[0]!;
}

interface LineageFixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly phase: ResolvedPhaseContext;
}

function lineageFixture(): LineageFixture {
  const repo = makeRepo();
  const store = openStateStore({ repoPath: repo });
  const contract = ticketContract(repo);
  const resolver = new IdentityContextResolver(store);
  const run = resolver.allocateFreshRun({
    contracts: [contract],
    initialDeliveryOid: repoHead(repo),
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
  const policyRoot = join(store.location.resourceDirectory, "policy");
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  const phase = resolver.resolvePhaseContext({
    attempt,
    contract,
    phase: "implement",
    phaseOrdinal: 0,
    role: "worker",
    worktreeRealpath: repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir: bundleRoot,
      requestedBundleSha256: "a".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: contract.verifications[0]!.timeout_ms,
  });
  return { repo, store, contract, run, attempt, phase };
}

function additionalPhaseContext(
  fixture: LineageFixture,
  phaseOrdinal = 1,
): ResolvedPhaseContext {
  const policyRoot = join(fixture.store.location.resourceDirectory, `policy-${phaseOrdinal}`);
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  return new IdentityContextResolver(fixture.store).resolvePhaseContext({
    attempt: fixture.attempt,
    contract: fixture.contract,
    phase: "review",
    phaseOrdinal,
    role: "reviewer",
    worktreeRealpath: fixture.repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir: bundleRoot,
      requestedBundleSha256: "b".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: fixture.contract.verifications[0]!.timeout_ms,
  });
}

function lifecyclePhaseContext(
  fixture: LineageFixture,
  phase: "review" | "remediation" | "verification" | "cleanup",
  role: "reviewer" | "remediator" | "verifier" | "cleanup",
  phaseOrdinal: number,
): ResolvedPhaseContext {
  const policyRoot = join(fixture.store.location.resourceDirectory, `policy-${phase}-${phaseOrdinal}`);
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
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
      bundleDir: bundleRoot,
      requestedBundleSha256: "d".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: fixture.contract.verifications[0]!.timeout_ms,
  });
}

function additionalLineage(fixture: LineageFixture): LineageFixture {
  const resolver = new IdentityContextResolver(fixture.store);
  const run = resolver.allocateFreshRun({
    contracts: [fixture.contract],
    initialDeliveryOid: repoHead(fixture.repo),
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: fixture.contract.id });
  const policyRoot = join(fixture.store.location.resourceDirectory, `policy-${run.runId}`);
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  const phase = resolver.resolvePhaseContext({
    attempt,
    contract: fixture.contract,
    phase: "implement",
    phaseOrdinal: 0,
    role: "worker",
    worktreeRealpath: fixture.repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir: bundleRoot,
      requestedBundleSha256: "c".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: fixture.contract.verifications[0]!.timeout_ms,
  });
  return { ...fixture, run, attempt, phase };
}

function appendEvidence(
  fixture: LineageFixture,
  label: string,
  producerService = "TransitionAuthorityTest",
): StateRecord {
  const payload = canonicalJson({
    schema_version: "rickgent.transition-test-evidence/v1",
    label,
    attempt_id: fixture.attempt.attemptId,
    context_id: fixture.phase.persisted.contextId,
  });
  const row = {
    evidence_id: `evidence-${label}`,
    attempt_id: fixture.attempt.attemptId,
    phase_execution_id: fixture.phase.persisted.phaseExecutionId,
    context_id: fixture.phase.persisted.contextId,
    producer_service: producerService,
    scope: `attempt:${fixture.attempt.attemptId}`,
    schema_version: "rickgent.transition-test-evidence/v1",
    content_digest: digest(payload),
    inline_payload_json: payload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence:${label}`,
    created_at: "2026-07-16T12:00:00.000Z",
  } as const;
  if (producerService === "CleanupService") {
    insertFixtureRow(fixture.store.location.databasePath, "evidence", row);
    return Object.freeze({ ...row });
  }
  return fixture.store.appendEvidence(row);
}

function appendLifecycleEvidence(
  fixture: LineageFixture,
  label: string,
  producerService: string,
  schemaVersion: string,
  payload: Readonly<Record<string, unknown>>,
  scope = `attempt:${fixture.attempt.attemptId}`,
): StateRecord {
  const text = canonicalJson(payload);
  const row = {
    evidence_id: `evidence-${label}`,
    attempt_id: fixture.attempt.attemptId,
    phase_execution_id: fixture.phase.persisted.phaseExecutionId,
    context_id: fixture.phase.persisted.contextId,
    producer_service: producerService,
    scope,
    schema_version: schemaVersion,
    content_digest: digest(text),
    inline_payload_json: text,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence:${label}`,
    created_at: "2026-07-16T12:00:00.000Z",
  } as const;
  if (producerService === "CleanupService") {
    insertFixtureRow(fixture.store.location.databasePath, "evidence", row);
    return Object.freeze({ ...row });
  }
  return fixture.store.appendEvidence(row);
}

function evidenceReference(evidence: StateRecord, purpose = "authority"): ExistingTransitionEvidenceReference {
  return { purpose, evidenceId: String(evidence.evidence_id) };
}

function commonRequest(
  fixture: LineageFixture,
  idempotencyKey: string,
  evidence: readonly ExistingTransitionEvidenceReference[],
  expectedVersion = 0,
) {
  return {
    expectedVersion,
    ownerContextDigest: fixture.phase.canonical.contextDigest,
    idempotencyKey,
    evidence,
  } as const;
}

function allocationRequest(
  fixture: LineageFixture,
  idempotencyKey: string,
  evidence: readonly ExistingTransitionEvidenceReference[],
) {
  return {
    ...commonRequest(fixture, idempotencyKey, evidence),
    ownerContextDigest: fixture.attempt.allocationOwnerDigest,
  } as const;
}

interface ChildOutcome {
  readonly type: "result" | "error";
  readonly result?: TransitionResult;
  readonly code?: string;
  readonly message?: string;
}

function runChild(
  repo: string,
  method: string,
  request: Readonly<Record<string, unknown>>,
  label: string,
): Promise<ChildOutcome> {
  const inputPath = join(repo, `.transition-${label}.json`);
  writeFileSync(inputPath, JSON.stringify({ method, request }), { encoding: "utf8", mode: 0o600 });
  const child = fork(childFixture, [repo, inputPath], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  return new Promise((resolve, reject) => {
    let outcome: ChildOutcome | undefined;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`transition authority child timed out: ${label}`));
    }, 12_000);
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null) outcome = message as ChildOutcome;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      children.delete(child);
      if (outcome !== undefined) resolve(outcome);
      else reject(new Error(`transition authority child exited without result: ${String(code ?? signal)}`));
    });
  });
}

function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

/** Test fixture setup for t16+ producers that do not yet expose typed persistence services. */
function insertFixtureRow(
  databasePath: string,
  table: string,
  row: Readonly<Record<string, SqlValue>>,
): void {
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

/** Only for isolated downstream-authority fixtures whose current upstream producer has its own corpus. */
function insertUpstreamFixtureRowWithoutForeignKeys(
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

interface PhaseGuardFixtures {
  readonly ownershipId: string;
  readonly leaseId: string;
  readonly processReceiptId: string;
  readonly reviewRecordId: string;
  readonly gateResultId: string;
  readonly cleanupRecordId: string;
}

const T18_RESOURCE_KINDS = [
  "delivery_ref", "attempt_ref", "worktree", "isolated_index", "policy_context", "policy_bundle",
  "process_group", "stdout", "stderr", "verification_output", "salvage_archive",
] as const;

function insertT18Ownership(fixture: LineageFixture, ownershipId: string, label: string): void {
  const now = "2026-07-16T12:00:00.000Z";
  insertFixtureRow(fixture.store.location.databasePath, "attempt_ownership_leases", {
    ownership_id: ownershipId,
    attempt_id: fixture.attempt.attemptId,
    generation: 1,
    owner_token_digest: digest(`t18-owner-token:${label}`),
    context_digest: fixture.phase.canonical.contextDigest,
    canonical_context_json: canonicalJson({ schema_version: "rickgent.attempt-ownership-context/v1", label }),
    recovered_from_ownership_id: null,
    heartbeat_at: now,
    expires_at: "2099-07-16T12:10:00.000Z",
    state: "live",
    state_version: 0,
    created_at: now,
  });
  for (const kind of T18_RESOURCE_KINDS) {
    insertFixtureRow(fixture.store.location.databasePath, "attempt_resource_claims", {
      resource_claim_id: `claim-${label}-${kind}-${fixture.attempt.attemptId}`,
      attempt_id: fixture.attempt.attemptId,
      slot: kind,
      kind,
      canonical_identity: `t18:${label}:${kind}:${fixture.attempt.attemptId}`,
      identity_digest: digest(`t18:${label}:${kind}:${fixture.attempt.attemptId}`),
      allocation_ownership_id: ownershipId,
      current_ownership_id: ownershipId,
      owner_generation: 1,
      state: "reserved",
      state_version: 0,
      release_proof_digest: null,
      quarantine_proof_digest: null,
      created_at: now,
    });
  }
}

function insertGateFixture(
  fixture: LineageFixture,
  evidenceId: string,
  label: string,
  status: "passed" | "failed",
  evaluationOrdinal: number,
  contextId = fixture.phase.persisted.contextId,
): string {
  const gateResultId = `gate-${label}-${fixture.attempt.attemptId}`;
  insertFixtureRow(fixture.store.location.databasePath, "gate_results", {
    gate_result_id: gateResultId,
    attempt_id: fixture.attempt.attemptId,
    gate_id: `required-${label}`,
    evaluation_ordinal: evaluationOrdinal,
    status,
    required: 1,
    context_id: contextId,
    contract_digest: fixture.attempt.contractDigest,
    evidence_id: evidenceId,
    result_digest: digest(`gate-result:${label}:${status}`),
    created_at: "2026-07-16T12:00:00.000Z",
  });
  return gateResultId;
}

function phaseGuardFixtures(
  fixture: LineageFixture,
  evidence: StateRecord,
  cleanupOutcome: "failed_clean" | "quarantined" | "verified" = "failed_clean",
  cleanupObservedOid = fixture.run.currentDeliveryOid,
  cleanupEvidence = evidence,
): PhaseGuardFixtures {
  const databasePath = fixture.store.location.databasePath;
  const evidenceId = String(evidence.evidence_id);
  const contextId = fixture.phase.persisted.contextId;
  const phaseExecutionId = fixture.phase.persisted.phaseExecutionId;
  const leaseId = `lease-${fixture.attempt.attemptId}`;
  const ownershipId = `ownership-${fixture.attempt.attemptId}`;
  const processReceiptId = `receipt-${fixture.attempt.attemptId}`;
  const reviewRecordId = `review-${fixture.attempt.attemptId}`;
  const terminalProofDigest = cleanupOutcome === "quarantined"
    ? digest(`quarantine-proof:${fixture.attempt.attemptId}`)
    : digest(`release-proof:${fixture.attempt.attemptId}`);
  const cleanupRecordId = `cleanup-record-${terminalProofDigest.slice(7)}`;
  const now = "2026-07-16T12:00:00.000Z";
  insertFixtureRow(databasePath, "leases", {
    lease_id: leaseId,
    attempt_id: fixture.attempt.attemptId,
    generation: 1,
    owner_token_digest: digest("transition-authority-owner-token"),
    owner_context_id: contextId,
    heartbeat_at: now,
    expires_at: "2026-07-16T12:10:00.000Z",
    state: "live",
    state_version: 1,
    acquisition_evidence_id: evidenceId,
    release_evidence_id: null,
    created_at: now,
  });
  insertT18Ownership(fixture, ownershipId, "phase-guard");
  for (const kind of [
    "attempt_ref",
    "worktree",
    "isolated_index",
    "policy_context",
    "policy_bundle",
    "process_group",
    "stdout",
    "stderr",
  ]) {
    insertFixtureRow(databasePath, "attempt_resources", {
      resource_id: `resource-${kind}-${fixture.attempt.attemptId}`,
      attempt_id: fixture.attempt.attemptId,
      slot: kind,
      kind,
      canonical_identity: `${kind}:${fixture.attempt.attemptId}`,
      identity_digest: digest(`${kind}:${fixture.attempt.attemptId}`),
      allocation_lease_id: leaseId,
      allocation_evidence_id: evidenceId,
      owner_generation: 1,
      owner_context_id: contextId,
      state: "allocated",
      state_version: 1,
      release_evidence_id: null,
      quarantine_evidence_id: null,
      created_at: now,
    });
  }
  insertFixtureRow(databasePath, "process_receipts", {
    process_receipt_id: processReceiptId,
    phase_execution_id: phaseExecutionId,
    context_id: contextId,
    lease_id: leaseId,
    lease_generation: 1,
    pid: 42,
    pgid: 42,
    boot_identity: "boot-transition-authority",
    process_start_identity: "process-transition-authority",
    argv_digest: digest("argv"),
    environment_digest: digest("environment"),
    launch_evidence_id: evidenceId,
    exit_evidence_id: evidenceId,
    termination_evidence_id: null,
    group_death_evidence_id: evidenceId,
    stdout_evidence_id: null,
    stderr_evidence_id: null,
    created_at: now,
  });
  insertFixtureRow(databasePath, "review_records", {
    review_record_id: reviewRecordId,
    attempt_id: fixture.attempt.attemptId,
    cycle: 1,
    reviewer_context_id: contextId,
    verdict: "accepted",
    verdict_evidence_id: evidenceId,
    findings_evidence_id: evidenceId,
    input_tree_oid: execFileSync("git", ["-C", fixture.repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    input_diff_digest: digest("review-input-diff"),
    created_at: now,
  });
  const gateResultId = insertGateFixture(fixture, evidenceId, "transition-test", "passed", 0);
  insertFixtureRow(databasePath, "cleanup_records", {
    cleanup_record_id: cleanupRecordId,
    attempt_id: fixture.attempt.attemptId,
    sequence: 1,
    context_id: contextId,
    outcome: cleanupOutcome,
    group_dead: 1,
    worktree_disposition: "removed",
    index_disposition: "removed",
    ref_disposition: "removed",
    context_disposition: "retained_immutable",
    bundle_disposition: "retained_immutable",
    delivery_ref_observed_oid: cleanupObservedOid,
    resources_absent: 1,
    lease_release_eligible: 1,
    evidence_id: String(cleanupEvidence.evidence_id),
    record_digest: digest(`cleanup-record:${fixture.attempt.attemptId}:${cleanupOutcome}`),
    created_at: now,
  });
  return { ownershipId, leaseId, processReceiptId, reviewRecordId, gateResultId, cleanupRecordId };
}

function lifecycleLeaseResources(
  fixture: LineageFixture,
  evidence: StateRecord,
  label: string,
): string {
  const leaseId = `lease-lifecycle-${label}-${fixture.attempt.attemptId}`;
  const evidenceId = String(evidence.evidence_id);
  const now = "2026-07-16T12:00:00.000Z";
  insertFixtureRow(fixture.store.location.databasePath, "leases", {
    lease_id: leaseId,
    attempt_id: fixture.attempt.attemptId,
    generation: 1,
    owner_token_digest: digest(`lifecycle-owner:${label}`),
    owner_context_id: fixture.phase.persisted.contextId,
    heartbeat_at: now,
    expires_at: "2026-07-16T12:10:00.000Z",
    state: "live",
    state_version: 1,
    acquisition_evidence_id: evidenceId,
    release_evidence_id: null,
    created_at: now,
  });
  insertT18Ownership(fixture, leaseId, `lifecycle-${label}`);
  for (const kind of [
    "attempt_ref",
    "worktree",
    "isolated_index",
    "policy_context",
    "policy_bundle",
    "process_group",
    "stdout",
    "stderr",
  ]) {
    insertFixtureRow(fixture.store.location.databasePath, "attempt_resources", {
      resource_id: `resource-lifecycle-${label}-${kind}-${fixture.attempt.attemptId}`,
      attempt_id: fixture.attempt.attemptId,
      slot: kind,
      kind,
      canonical_identity: `lifecycle:${label}:${kind}:${fixture.attempt.attemptId}`,
      identity_digest: digest(`lifecycle:${label}:${kind}:${fixture.attempt.attemptId}`),
      allocation_lease_id: leaseId,
      allocation_evidence_id: evidenceId,
      owner_generation: 1,
      owner_context_id: fixture.phase.persisted.contextId,
      state: "allocated",
      state_version: 1,
      release_evidence_id: null,
      quarantine_evidence_id: null,
      created_at: now,
    });
  }
  return leaseId;
}

function releaseFixtureLease(
  fixture: LineageFixture,
  ownershipId: string,
  evidenceId: string,
  disposition: "released" | "quarantined" = "released",
): void {
  const database = openRaw(fixture.store.location.databasePath);
  try {
    database.prepare(
      "UPDATE attempt_resources SET state = 'cleanup_pending', state_version = state_version + 1 WHERE attempt_id = ?",
    ).run(fixture.attempt.attemptId);
    database.prepare(
      "UPDATE attempt_resources SET state = 'released', state_version = state_version + 1, release_evidence_id = ? WHERE attempt_id = ?",
    ).run(evidenceId, fixture.attempt.attemptId);
    database.prepare(
      "UPDATE leases SET state = 'cleanup_pending', state_version = state_version + 1 WHERE lease_id = ?",
    ).run(ownershipId);
    database.prepare(
      "UPDATE leases SET state = 'released', state_version = state_version + 1, release_evidence_id = ? WHERE lease_id = ?",
    ).run(evidenceId, ownershipId);
    database.prepare(
      "UPDATE attempt_resource_claims SET state = 'cleanup_pending', state_version = state_version + 1 WHERE attempt_id = ? AND current_ownership_id = ?",
    ).run(fixture.attempt.attemptId, ownershipId);
    database.prepare(
      "UPDATE attempt_ownership_leases SET state = 'cleanup_pending', state_version = state_version + 1 WHERE ownership_id = ?",
    ).run(ownershipId);
    const proofDigest = disposition === "released"
      ? digest(`release-proof:${fixture.attempt.attemptId}`)
      : digest(`quarantine-proof:${fixture.attempt.attemptId}`);
    database.prepare(`
      UPDATE attempt_resource_claims
      SET state = ?, state_version = state_version + 1,
          release_proof_digest = ?, quarantine_proof_digest = ?
      WHERE attempt_id = ? AND current_ownership_id = ?
    `).run(
      disposition,
      disposition === "released" ? proofDigest : null,
      disposition === "quarantined" ? proofDigest : null,
      fixture.attempt.attemptId,
      ownershipId,
    );
    database.prepare(
      "UPDATE attempt_ownership_leases SET state = ?, state_version = state_version + 1 WHERE ownership_id = ?",
    ).run(disposition, ownershipId);
  } finally {
    database.close();
  }
}

interface PromotionPrerequisites {
  readonly commitAttributionId: string;
  readonly oracleDecisionId: string;
}

/** Isolated upstream rows: lifecycle/oracle production paths are covered by their dedicated authority suites. */
function promotionPrerequisites(
  fixture: LineageFixture,
  evidence: StateRecord,
  candidateOid: string,
): PromotionPrerequisites {
  const commitAttributionId = `attribution-${fixture.attempt.attemptId}`;
  const oracleDecisionId = `oracle-${fixture.attempt.attemptId}`;
  insertFixtureRow(fixture.store.location.databasePath, "commit_attributions", {
    commit_attribution_id: commitAttributionId,
    attempt_id: fixture.attempt.attemptId,
    baseline_oid: fixture.attempt.deliveryBaselineOid,
    parent_oid: fixture.attempt.deliveryBaselineOid,
    tree_before_oid: execFileSync(
      "git",
      ["-C", fixture.repo, "rev-parse", `${fixture.attempt.deliveryBaselineOid}^{tree}`],
      { encoding: "utf8" },
    ).trim(),
    tree_after_oid: execFileSync("git", ["-C", fixture.repo, "rev-parse", `${candidateOid}^{tree}`], { encoding: "utf8" }).trim(),
    commit_oid: candidateOid,
    contract_digest: fixture.attempt.contractDigest,
    context_digest: fixture.phase.canonical.contextDigest,
    path_set_digest: digest("promotion-path-set"),
    change_kind_set_digest: digest("promotion-change-kind-set"),
    mode_set_digest: digest("promotion-mode-set"),
    attribution_evidence_id: String(evidence.evidence_id),
    created_at: "2026-07-16T12:00:00.000Z",
  });
  const delta = canonicalFixtureDelta(fixture, candidateOid);
  const baselineTreeOid = repositoryTree(fixture.repo, fixture.attempt.deliveryBaselineOid);
  const candidateTreeOid = repositoryTree(fixture.repo, candidateOid);
  insertUpstreamFixtureRowWithoutForeignKeys(fixture.store.location.databasePath, "attempt_commit_intents", {
    commit_intent_id: `intent-${fixture.attempt.attemptId}`,
    repository_id: fixture.store.location.repositoryId,
    attempt_id: fixture.attempt.attemptId,
    ownership_id: `fixture-owner-${fixture.attempt.attemptId}`,
    owner_generation: 1,
    ownership_state_version: 0,
    ownership_context_digest: digest(`fixture-owner-context:${fixture.attempt.attemptId}`),
    phase_execution_id: fixture.phase.persisted.phaseExecutionId,
    context_id: fixture.phase.persisted.contextId,
    execution_context_digest: fixture.phase.canonical.contextDigest,
    launch_id: `fixture-launch-${fixture.attempt.attemptId}`,
    process_receipt_id: `fixture-receipt-${fixture.attempt.attemptId}`,
    delivery_ref: fixture.run.deliveryRef,
    attempt_ref: `refs/rickgent/runs/${fixture.run.runId}/attempts/${fixture.attempt.attemptId}`,
    baseline_oid: fixture.attempt.deliveryBaselineOid,
    contract_digest: fixture.attempt.contractDigest,
    delivery_ref_claim_id: `fixture-delivery-claim-${fixture.attempt.attemptId}`,
    delivery_ref_expected_version: 0,
    attempt_ref_claim_id: `fixture-attempt-claim-${fixture.attempt.attemptId}`,
    attempt_ref_expected_version: 0,
    worktree_claim_id: `fixture-worktree-claim-${fixture.attempt.attemptId}`,
    worktree_expected_version: 0,
    isolated_index_claim_id: `fixture-index-claim-${fixture.attempt.attemptId}`,
    isolated_index_expected_version: 0,
    tree_before_oid: baselineTreeOid,
    tree_after_oid: candidateTreeOid,
    candidate_diff_digest: delta.candidateDiffDigest,
    path_set_digest: delta.pathSetDigest,
    change_kind_set_digest: delta.changeKindSetDigest,
    mode_set_digest: delta.modeSetDigest,
    normalized_delta_json: JSON.stringify(delta.entries),
    verification_receipt_digests_json: JSON.stringify([digest(`fixture-verification:${fixture.attempt.attemptId}`)]),
    commit_metadata_json: JSON.stringify({ fixture: true }),
    input_digest: digest(`fixture-intent-input:${fixture.attempt.attemptId}`),
    idempotency_key: `fixture-intent:${fixture.attempt.attemptId}`,
    state: "finalized",
    state_version: 1,
    commit_attribution_id: commitAttributionId,
    commit_oid: candidateOid,
    delivery_ref_observed_oid: fixture.attempt.deliveryBaselineOid,
    attempt_ref_before_oid: fixture.attempt.deliveryBaselineOid,
    attempt_ref_after_oid: candidateOid,
    command_receipts_json: JSON.stringify([{ fixture: true }]),
    result_digest: digest(`fixture-intent-result:${fixture.attempt.attemptId}`),
    created_at: "2026-07-16T12:00:00.000Z",
    finalized_at: "2026-07-16T12:00:00.000Z",
  });
  insertFixtureRow(fixture.store.location.databasePath, "oracle_decisions", {
    oracle_decision_id: oracleDecisionId,
    oracle_version: fixture.attempt.oracleVersion,
    scope_kind: "attempt",
    run_id: fixture.run.runId,
    ticket_instance_id: fixture.attempt.ticketInstanceId,
    attempt_id: fixture.attempt.attemptId,
    input_set_digest: digest(`promotion-oracle-input:${fixture.attempt.attemptId}`),
    result: "accepted",
    reasons_json: "[]",
    output_digest: digest(`promotion-oracle-output:${fixture.attempt.attemptId}`),
    idempotency_key: `promotion-oracle:${fixture.attempt.attemptId}`,
    created_at: "2026-07-16T12:00:00.000Z",
  });
  return { commitAttributionId, oracleDecisionId };
}

function all(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function one(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  return all(databasePath, sql, ...values)[0];
}

function expectStateCode(action: () => unknown, code: string): StateStoreError {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(StateStoreError);
  expect(captured).toMatchObject({ code });
  return captured as StateStoreError;
}

function advanceToVerifying(
  fixture: LineageFixture,
  authority: TransitionAuthority,
  evidence: StateRecord,
  guards: PhaseGuardFixtures,
  label: string,
): readonly ExistingTransitionEvidenceReference[] {
  const proof = [evidenceReference(evidence)];
  authority.activateRun({
    runId: fixture.run.runId,
    initialAttemptId: fixture.attempt.attemptId,
    ...allocationRequest(fixture, `${label}:run:activate`, proof),
  });
  authority.activateInitialTicket({
    ticketInstanceId: fixture.attempt.ticketInstanceId,
    attemptId: fixture.attempt.attemptId,
    ...allocationRequest(fixture, `${label}:ticket:activate`, proof),
  });
  authority.startAttempt({
    attemptId: fixture.attempt.attemptId,
    ownershipId: guards.ownershipId,
    ...commonRequest(fixture, `${label}:attempt:start`, proof, 0),
  });
  authority.captureImplementation({
    attemptId: fixture.attempt.attemptId,
    processReceiptId: guards.processReceiptId,
    ...commonRequest(fixture, `${label}:attempt:capture`, proof, 1),
  });
  authority.beginReview({
    attemptId: fixture.attempt.attemptId,
    contextId: fixture.phase.persisted.contextId,
    ...commonRequest(fixture, `${label}:attempt:review`, proof, 2),
  });
  authority.queueVerification({
    attemptId: fixture.attempt.attemptId,
    reviewRecordId: guards.reviewRecordId,
    ...commonRequest(fixture, `${label}:attempt:queue`, proof, 3),
  });
  authority.beginVerification({
    attemptId: fixture.attempt.attemptId,
    contextId: fixture.phase.persisted.contextId,
    ...commonRequest(fixture, `${label}:attempt:verify`, proof, 4),
  });
  return proof;
}

interface PromotionFixtureData {
  readonly fixture: LineageFixture;
  readonly authority: PromotionAuthority;
  readonly candidateOid: string;
  readonly evidence: StateRecord;
  readonly cleanupEvidence: StateRecord;
  readonly guards: PhaseGuardFixtures;
  readonly prerequisites: PromotionPrerequisites;
  readonly createRequest: PromotionIntentRequest;
  readonly created: StateRecord | undefined;
}

function promotionInlineEvidence(
  fixture: LineageFixture,
  promotionIntentId: string,
  idempotencyKey: string,
  expectedVersion: number,
  fromState: string,
  toState: string,
  guard: Readonly<Record<string, unknown>>,
) {
  return {
    purpose: "promotion-operation",
    inlineEvidence: {
      contextId: fixture.phase.persisted.contextId,
      producerService: "TicketFinalizationService",
      scope: promotionIntentId,
      schemaVersion: "rickgent.promotion-operation.v1",
      payload: {
        promotion_intent_id: promotionIntentId,
        expected_version: expectedVersion,
        from_state: fromState,
        to_state: toState,
        owner_context_digest: fixture.phase.canonical.contextDigest,
        guard,
      },
      idempotencyKey,
    },
  } as const;
}

function preparePromotionFixture(label: string, createIntent = true): PromotionFixtureData {
  const fixture = lineageFixture();
  const transitionAuthority = new TransitionAuthority(fixture.store);
  const authority = new PromotionAuthority(fixture.store);
  const candidateOid = createCandidateCommit(fixture);
  const evidence = appendEvidence(fixture, `promotion-${label}`);
  const cleanupEvidence = appendEvidence(fixture, `promotion-${label}-cleanup`, "CleanupService");
  const prerequisites = promotionPrerequisites(fixture, evidence, candidateOid);
  const guards = phaseGuardFixtures(fixture, evidence, "verified", candidateOid, cleanupEvidence);
  const proof = advanceToVerifying(fixture, transitionAuthority, evidence, guards, `promotion-${label}`);
  transitionAuthority.completeVerification({
    attemptId: fixture.attempt.attemptId,
    gateResultIds: [guards.gateResultId],
    ...commonRequest(fixture, `promotion-${label}:complete`, proof, 5),
  });
  transitionAuthority.beginAttemptCleanup({
    attemptId: fixture.attempt.attemptId,
    commitAttributionId: prerequisites.commitAttributionId,
    ...commonRequest(fixture, `promotion-${label}:attempt-cleanup`, proof, 6),
  });
  transitionAuthority.beginTicketCleanup({
    ticketInstanceId: fixture.attempt.ticketInstanceId,
    attemptId: fixture.attempt.attemptId,
    ...commonRequest(fixture, `promotion-${label}:ticket-cleanup`, proof, 1),
  });
  releaseFixtureLease(fixture, guards.ownershipId, String(evidence.evidence_id));
  const createRequest: PromotionIntentRequest = {
    promotionIntentId: `promotion-${label}-${fixture.attempt.attemptId}`,
    runId: fixture.run.runId,
    ticketInstanceId: fixture.attempt.ticketInstanceId,
    attemptId: fixture.attempt.attemptId,
    promotionSequence: 1,
    deliveryRef: fixture.run.deliveryRef,
    expectedOldOid: fixture.run.currentDeliveryOid,
    candidateOid,
    oracleDecisionId: prerequisites.oracleDecisionId,
    commitAttributionId: prerequisites.commitAttributionId,
    ownerContextId: fixture.phase.persisted.contextId,
    idempotencyKey: `promotion-intent:${label}`,
    createdAt: "2026-07-16T12:00:00.000Z",
  };
  const created = createIntent ? authority.createIntent(createRequest) : undefined;
  return { fixture, authority, candidateOid, evidence, cleanupEvidence, guards, prerequisites, createRequest, created };
}

function finalizePromotionRequest(
  data: PromotionFixtureData,
  observation: PromotionResult,
  idempotencyKey: string,
  expectedVersion = 1,
): PromotionFinalizationRequest {
  const guard = {
    kind: "finalize",
    expectedRunVersion: 1,
    cleanupRecordId: data.guards.cleanupRecordId,
    attemptId: data.fixture.attempt.attemptId,
    ticketInstanceId: data.fixture.attempt.ticketInstanceId,
    oracleDecisionId: data.prerequisites.oracleDecisionId,
    attemptExpectedVersion: 7,
    ticketExpectedVersion: 2,
    oracleEvaluationIdempotencyKey: `${idempotencyKey}:oracle-evaluation`,
    verifiedAttemptIdempotencyKey: `${idempotencyKey}:verified-attempt`,
    readyTicketIdempotencyKey: `${idempotencyKey}:ready-ticket`,
  } as const;
  const finalizationEvidence = promotionInlineEvidence(
    data.fixture,
    data.createRequest.promotionIntentId,
    idempotencyKey,
    expectedVersion,
    "ref_observed_candidate",
    "finalized",
    guard,
  );
  const cleanupEvidence = evidenceReference(data.cleanupEvidence, "cleanup");
  const observationEvidence = {
    purpose: "candidate-observation",
    evidenceId: String(observation.observationEvidenceId),
  } as const;
  return {
    promotionIntentId: data.createRequest.promotionIntentId,
    expectedVersion,
    expectedRunVersion: 1,
    ownerContextDigest: data.fixture.phase.canonical.contextDigest,
    idempotencyKey,
    evidence: finalizationEvidence,
    cleanupRecordId: data.guards.cleanupRecordId,
    attemptId: data.fixture.attempt.attemptId,
    ticketInstanceId: data.fixture.attempt.ticketInstanceId,
    oracleDecisionId: data.prerequisites.oracleDecisionId,
    attemptExpectedVersion: 7,
    ticketExpectedVersion: 2,
    oracleEvaluation: {
      idempotencyKey: `${idempotencyKey}:oracle-evaluation`,
      evidence: [observationEvidence],
    },
    verifiedAttempt: {
      idempotencyKey: `${idempotencyKey}:verified-attempt`,
      evidence: [cleanupEvidence, finalizationEvidence],
    },
    readyTicket: {
      idempotencyKey: `${idempotencyKey}:ready-ticket`,
      evidence: [cleanupEvidence, finalizationEvidence],
    },
  };
}

function observePromotionCandidate(data: PromotionFixtureData, idempotencyKey: string): PromotionResult {
  execFileSync("git", ["-C", data.fixture.repo, "update-ref", data.fixture.run.deliveryRef, data.candidateOid]);
  return data.authority.observeCandidate({
    promotionIntentId: data.createRequest.promotionIntentId,
    expectedVersion: 0,
    ownerContextDigest: data.fixture.phase.canonical.contextDigest,
    idempotencyKey,
    evidence: promotionInlineEvidence(
      data.fixture,
      data.createRequest.promotionIntentId,
      idempotencyKey,
      0,
      "intent_recorded",
      "ref_observed_candidate",
      { kind: "observe_candidate", observedOid: data.candidateOid },
    ),
    observedOid: data.candidateOid,
  });
}

type InvalidPromotionLifecycleEntity = "run" | "attempt" | "ticket";

function invalidatePromotionLifecycle(
  data: PromotionFixtureData,
  entity: InvalidPromotionLifecycleEntity,
): void {
  const database = openRaw(data.fixture.store.location.databasePath);
  try {
    switch (entity) {
      case "run":
        database.prepare(`
          UPDATE runs SET state = 'cleanup_pending', state_version = state_version + 1 WHERE run_id = ?
        `).run(data.fixture.run.runId);
        return;
      case "attempt":
        database.prepare(`
          UPDATE attempts SET state = 'failed_clean', state_version = state_version + 1 WHERE attempt_id = ?
        `).run(data.fixture.attempt.attemptId);
        return;
      case "ticket":
        database.prepare(`
          UPDATE run_tickets SET state = 'failed', state_version = state_version + 1 WHERE ticket_instance_id = ?
        `).run(data.fixture.attempt.ticketInstanceId);
        return;
    }
  } finally {
    database.close();
  }
}

interface DeliveryFixtureData {
  readonly promotion: PromotionFixtureData;
  readonly authority: DeliveryAuthority;
  readonly intentRequest: DeliveryIntentRequest;
  readonly intent: StateRecord;
}

function prepareDeliveryFixture(label: string): DeliveryFixtureData {
  const promotion = preparePromotionFixture(`delivery-${label}`);
  const observation = observePromotionCandidate(
    promotion,
    `delivery:${label}:promotion-observation`,
  );
  const finalized = promotion.authority.finalize(finalizePromotionRequest(
    promotion,
    observation,
    `delivery:${label}:promotion-finalization`,
  ));
  if (finalized.readyTicketTransition === undefined) {
    throw new Error("promotion finalization omitted its ready-ticket transition");
  }
  new TransitionAuthority(promotion.fixture.store).finalizeReadyRun({
    runId: promotion.fixture.run.runId,
    expectedVersion: 2,
    ownerContextDigest: promotion.fixture.phase.canonical.contextDigest,
    idempotencyKey: `delivery:${label}:run-ready`,
    evidence: finalized.readyTicketTransition.evidence,
  });

  const authority = new DeliveryAuthority(promotion.fixture.store);
  const intentRequest: DeliveryIntentRequest = {
    deliveryIntentId: `delivery-intent-${label}-${promotion.fixture.run.runId}`,
    runId: promotion.fixture.run.runId,
    deliveryOid: promotion.candidateOid,
    remoteName: "origin",
    branchName: "rickgent-delivery",
    expectedRemoteOid: null,
    baseBranch: "main",
    providerIdentityDigest: digest(`provider:${label}`),
    ownerContextId: promotion.fixture.phase.persisted.contextId,
    ownerContextDigest: promotion.fixture.phase.canonical.contextDigest,
    idempotencyKey: `delivery:${label}:intent`,
    createdAt: "2026-07-16T12:00:00.000Z",
  };
  const intent = authority.createIntent(intentRequest);
  return { promotion, authority, intentRequest, intent };
}

function remoteObservationRequest(
  data: DeliveryFixtureData,
  label: string,
  overrides: Partial<RemoteObservationRequest> = {},
): RemoteObservationRequest {
  return {
    deliveryIntentId: data.intentRequest.deliveryIntentId,
    remoteObservationId: `remote-${label}-${data.promotion.fixture.run.runId}`,
    sequence: 1,
    operation: "ls-remote",
    outcome: "observed",
    observedRemoteOid: data.promotion.candidateOid,
    ownerContextId: data.promotion.fixture.phase.persisted.contextId,
    ownerContextDigest: data.promotion.fixture.phase.canonical.contextDigest,
    evidenceIdempotencyKey: `delivery:${label}:remote-evidence`,
    createdAt: "2026-07-16T12:01:00.000Z",
    ...overrides,
  };
}

function prObservationRequest(
  data: DeliveryFixtureData,
  label: string,
  overrides: Partial<PrObservationRequest> = {},
): PrObservationRequest {
  return {
    deliveryIntentId: data.intentRequest.deliveryIntentId,
    prObservationId: `pr-${label}-${data.promotion.fixture.run.runId}`,
    sequence: 1,
    providerRepositoryId: `provider-repository-${label}`,
    baseBranch: data.intentRequest.baseBranch,
    headBranch: data.intentRequest.branchName,
    prIdentity: `pr-${label}`,
    observedHeadOid: data.promotion.candidateOid,
    ownerContextId: data.promotion.fixture.phase.persisted.contextId,
    ownerContextDigest: data.promotion.fixture.phase.canonical.contextDigest,
    evidenceIdempotencyKey: `delivery:${label}:pr-evidence`,
    createdAt: "2026-07-16T12:02:00.000Z",
    ...overrides,
  };
}

function deliveryDecisionRequest(
  data: DeliveryFixtureData,
  label: string,
  decision: "delivered" | "delivery_failed",
  terminalFromState: "intent_recorded" | "remote_observed" | "pr_observed",
  remote: StateRecord | null,
  pr: StateRecord | null,
): DeliveryDecisionRequest {
  const transitionEvidence: ExistingTransitionEvidenceReference[] = [
    evidenceReference(data.promotion.cleanupEvidence, "cleanup"),
  ];
  if (remote !== null) {
    transitionEvidence.push({ purpose: "remote-observation", evidenceId: String(remote.evidence_id) });
  }
  if (pr !== null) {
    transitionEvidence.push({ purpose: "pr-observation", evidenceId: String(pr.evidence_id) });
  }
  return {
    deliveryIntentId: data.intentRequest.deliveryIntentId,
    deliveryRecordId: `delivery-record-${label}-${data.promotion.fixture.run.runId}`,
    terminalFromState,
    remoteObservationId: remote === null ? null : String(remote.remote_observation_id),
    prObservationId: pr === null ? null : String(pr.pr_observation_id),
    cleanupRecordId: data.promotion.guards.cleanupRecordId,
    deliveryOid: data.promotion.candidateOid,
    decision,
    runId: data.promotion.fixture.run.runId,
    expectedRunVersion: 3,
    transitionIdempotencyKey: `delivery:${label}:terminal-transition`,
    transitionEvidence,
    ownerContextId: data.promotion.fixture.phase.persisted.contextId,
    ownerContextDigest: data.promotion.fixture.phase.canonical.contextDigest,
    evidenceIdempotencyKey: `delivery:${label}:decision-evidence`,
    createdAt: "2026-07-16T12:03:00.000Z",
  };
}

interface LifecycleFixtureData {
  readonly fixture: LineageFixture;
  readonly authority: LifecycleRecordAuthority;
  readonly candidateOid: string;
  readonly candidateTreeOid: string;
  readonly delta: ReturnType<typeof canonicalGitDeltaFromRaw>;
  readonly reviewContext: ResolvedPhaseContext;
  readonly remediationContext: ResolvedPhaseContext;
  readonly verificationContext: ResolvedPhaseContext;
  readonly cleanupContext: ResolvedPhaseContext;
  readonly processEvidence: StateRecord;
  readonly leaseId: string;
}

function prepareLifecycleFixture(label: string): LifecycleFixtureData {
  const fixture = lineageFixture();
  const reviewContext = lifecyclePhaseContext(fixture, "review", "reviewer", 1);
  const remediationContext = lifecyclePhaseContext(fixture, "remediation", "remediator", 2);
  const verificationContext = lifecyclePhaseContext(fixture, "verification", "verifier", 3);
  const cleanupContext = lifecyclePhaseContext(fixture, "cleanup", "cleanup", 4);
  const candidateOid = createCandidateCommit(fixture);
  const candidateTreeOid = repositoryTree(fixture.repo, candidateOid);
  const delta = canonicalFixtureDelta(fixture, candidateTreeOid);
  const processEvidence = appendLifecycleEvidence(
    fixture,
    `lifecycle-${label}-process`,
    "AttemptLifecycleService",
    "rickgent.process-receipt-evidence.v1",
    { attempt_id: fixture.attempt.attemptId, label },
  );
  const leaseId = lifecycleLeaseResources(fixture, processEvidence, label);
  return {
    fixture,
    authority: new LifecycleRecordAuthority(fixture.store),
    candidateOid,
    candidateTreeOid,
    delta,
    reviewContext,
    remediationContext,
    verificationContext,
    cleanupContext,
    processEvidence,
    leaseId,
  };
}

function lifecycleProcessRequest(data: LifecycleFixtureData, label: string): ProcessReceiptRecordRequest {
  const evidenceId = String(data.processEvidence.evidence_id);
  return {
    processReceiptId: `process-lifecycle-${label}-${data.fixture.attempt.attemptId}`,
    phaseExecutionId: data.fixture.phase.persisted.phaseExecutionId,
    attemptId: data.fixture.attempt.attemptId,
    contextId: data.fixture.phase.persisted.contextId,
    ownerContextDigest: data.fixture.phase.canonical.contextDigest,
    leaseId: data.leaseId,
    leaseGeneration: 1,
    pid: 42,
    pgid: 42,
    bootIdentity: "boot-lifecycle",
    processStartIdentity: `process-lifecycle-${label}`,
    argvDigest: digest(`argv:${label}`),
    environmentDigest: digest(`environment:${label}`),
    launchEvidenceId: evidenceId,
    exitEvidenceId: evidenceId,
    terminationEvidenceId: null,
    groupDeathEvidenceId: evidenceId,
    stdoutEvidenceId: null,
    stderrEvidenceId: null,
    createdAt: "2026-07-16T12:00:00.000Z",
  };
}

function insertLegacyProcessReceiptFixture(
  data: LifecycleFixtureData,
  request: ProcessReceiptRecordRequest,
): StateRecord {
  insertFixtureRow(data.fixture.store.location.databasePath, "process_receipts", {
    process_receipt_id: request.processReceiptId,
    phase_execution_id: request.phaseExecutionId,
    context_id: request.contextId,
    lease_id: request.leaseId,
    lease_generation: request.leaseGeneration,
    pid: request.pid,
    pgid: request.pgid,
    boot_identity: request.bootIdentity,
    process_start_identity: request.processStartIdentity,
    argv_digest: request.argvDigest,
    environment_digest: request.environmentDigest,
    launch_evidence_id: request.launchEvidenceId,
    exit_evidence_id: request.exitEvidenceId,
    termination_evidence_id: request.terminationEvidenceId,
    group_death_evidence_id: request.groupDeathEvidenceId,
    stdout_evidence_id: request.stdoutEvidenceId,
    stderr_evidence_id: request.stderrEvidenceId,
    created_at: request.createdAt,
  });
  const stored = one(
    data.fixture.store.location.databasePath,
    "SELECT * FROM process_receipts WHERE process_receipt_id = ?",
    request.processReceiptId,
  );
  if (stored === undefined) throw new Error("legacy process receipt fixture was not inserted");
  return Object.freeze(stored);
}

function lifecycleReviewRequest(
  data: LifecycleFixtureData,
  label: string,
  cycle: number,
  verdict: "accepted" | "rejected" = "rejected",
): ReviewRecordRequest {
  const reviewRecordId = `review-lifecycle-${label}-${data.fixture.attempt.attemptId}`;
  const verdictPayload = {
    attempt_id: data.fixture.attempt.attemptId,
    cycle,
    verdict,
    input_tree_oid: data.candidateTreeOid,
    input_diff_digest: data.delta.candidateDiffDigest,
  };
  const verdictEvidence = appendLifecycleEvidence(
    data.fixture,
    `lifecycle-${label}-verdict`,
    "ReviewService",
    "rickgent.review-verdict.v1",
    verdictPayload,
    reviewRecordId,
  );
  const findingsEvidence = appendLifecycleEvidence(
    data.fixture,
    `lifecycle-${label}-findings`,
    "ReviewService",
    "rickgent.review-findings.v1",
    { attempt_id: data.fixture.attempt.attemptId, cycle, verdict },
    reviewRecordId,
  );
  return {
    reviewRecordId,
    attemptId: data.fixture.attempt.attemptId,
    cycle,
    reviewerContextId: data.reviewContext.persisted.contextId,
    ownerContextDigest: data.reviewContext.canonical.contextDigest,
    verdict,
    verdictEvidenceId: String(verdictEvidence.evidence_id),
    findingsEvidenceId: String(findingsEvidence.evidence_id),
    inputTreeOid: data.candidateTreeOid,
    inputDiffDigest: data.delta.candidateDiffDigest,
    createdAt: "2026-07-16T12:01:00.000Z",
  };
}

function lifecycleRemediationRequest(
  data: LifecycleFixtureData,
  label: string,
  review: ReviewRecordRequest,
): RemediationRecordRequest {
  const remediationRecordId = `remediation-lifecycle-${label}-${data.fixture.attempt.attemptId}`;
  const outputEvidence = appendLifecycleEvidence(
    data.fixture,
    `lifecycle-${label}-remediation`,
    "RemediationService",
    "rickgent.remediation-output.v1",
    {
      oracle_input_class: "remediation_cycle",
      attempt_id: data.fixture.attempt.attemptId,
      cycle: review.cycle,
      result_tree_oid: data.candidateTreeOid,
      result_diff_digest: data.delta.candidateDiffDigest,
    },
    remediationRecordId,
  );
  return {
    remediationRecordId,
    attemptId: data.fixture.attempt.attemptId,
    cycle: review.cycle,
    contextId: data.remediationContext.persisted.contextId,
    ownerContextDigest: data.remediationContext.canonical.contextDigest,
    findingsEvidenceId: review.findingsEvidenceId,
    outputEvidenceId: String(outputEvidence.evidence_id),
    resultTreeOid: data.candidateTreeOid,
    resultDiffDigest: data.delta.candidateDiffDigest,
    createdAt: "2026-07-16T12:02:00.000Z",
  };
}

function lifecycleGateRequest(
  data: LifecycleFixtureData,
  label: string,
  gateId = "VER-TRANSITION",
  required = true,
): GateResultRecordRequest {
  const gateResultId = `gate-lifecycle-${label}-${data.fixture.attempt.attemptId}`;
  const payload = {
    gate_id: gateId,
    evaluation_ordinal: 0,
    required,
    status: "passed" as const,
    candidate_tree_oid: data.candidateTreeOid,
    candidate_diff_digest: data.delta.candidateDiffDigest,
  };
  const evidence = appendLifecycleEvidence(
    data.fixture,
    `lifecycle-${label}-gate`,
    "VerificationService",
    "rickgent.gate-result.v1",
    payload,
    gateResultId,
  );
  return {
    gateResultId,
    attemptId: data.fixture.attempt.attemptId,
    gateId,
    evaluationOrdinal: 0,
    status: "passed",
    required,
    contextId: data.verificationContext.persisted.contextId,
    ownerContextDigest: data.verificationContext.canonical.contextDigest,
    contractDigest: data.fixture.attempt.contractDigest,
    evidenceId: String(evidence.evidence_id),
    candidateTreeOid: data.candidateTreeOid,
    candidateDiffDigest: data.delta.candidateDiffDigest,
    createdAt: "2026-07-16T12:03:00.000Z",
  };
}

function lifecycleAttributionRequest(
  data: LifecycleFixtureData,
  label: string,
): CommitAttributionRecordRequest {
  const commitAttributionId = `attribution-lifecycle-${label}-${data.fixture.attempt.attemptId}`;
  const treeBeforeOid = repositoryTree(data.fixture.repo, data.fixture.attempt.deliveryBaselineOid);
  const evidence = appendLifecycleEvidence(
    data.fixture,
    `lifecycle-${label}-attribution`,
    "AttemptLifecycleService",
    "rickgent.commit-attribution.v1",
    {
      contract_digest: data.fixture.attempt.contractDigest,
      baseline_oid: data.fixture.attempt.deliveryBaselineOid,
      parent_oid: data.fixture.attempt.deliveryBaselineOid,
      tree_before_oid: treeBeforeOid,
      tree_after_oid: data.candidateTreeOid,
      commit_oid: data.candidateOid,
      candidate_diff_digest: data.delta.candidateDiffDigest,
      path_set_digest: data.delta.pathSetDigest,
      change_kind_set_digest: data.delta.changeKindSetDigest,
      mode_set_digest: data.delta.modeSetDigest,
      normalized_delta: data.delta.entries,
    },
    commitAttributionId,
  );
  return {
    commitAttributionId,
    attemptId: data.fixture.attempt.attemptId,
    baselineOid: data.fixture.attempt.deliveryBaselineOid,
    parentOid: data.fixture.attempt.deliveryBaselineOid,
    treeBeforeOid,
    treeAfterOid: data.candidateTreeOid,
    commitOid: data.candidateOid,
    contractDigest: data.fixture.attempt.contractDigest,
    contextDigest: data.fixture.phase.canonical.contextDigest,
    pathSetDigest: data.delta.pathSetDigest,
    changeKindSetDigest: data.delta.changeKindSetDigest,
    modeSetDigest: data.delta.modeSetDigest,
    attributionEvidenceId: String(evidence.evidence_id),
    createdAt: "2026-07-16T12:04:00.000Z",
  };
}

function lifecycleCleanupRequest(data: LifecycleFixtureData, label: string): CleanupRecordRequest {
  const cleanupProofDigest = digest(`release-proof:${data.fixture.attempt.attemptId}`);
  const cleanupRecordId = `cleanup-record-${cleanupProofDigest.slice(7)}`;
  const evidenceId = `evidence-lifecycle-${label}-cleanup`;
  const payload = {
    attempt_id: data.fixture.attempt.attemptId,
    sequence: 1,
    context_id: data.cleanupContext.persisted.contextId,
    outcome: "verified",
    group_dead: 1,
    worktree_disposition: "removed",
    index_disposition: "removed",
    ref_disposition: "removed",
    context_disposition: "retained_immutable",
    bundle_disposition: "retained_immutable",
    delivery_ref_observed_oid: data.fixture.run.currentDeliveryOid,
    resources_absent: 1,
    lease_release_eligible: 1,
    evidence_id: evidenceId,
  };
  const evidence = appendLifecycleEvidence(
    data.fixture,
    `lifecycle-${label}-cleanup`,
    "CleanupService",
    "rickgent.cleanup-record.v1",
    payload,
    cleanupRecordId,
  );
  return {
    cleanupRecordId,
    attemptId: data.fixture.attempt.attemptId,
    sequence: 1,
    contextId: data.cleanupContext.persisted.contextId,
    ownerContextDigest: data.cleanupContext.canonical.contextDigest,
    outcome: "verified",
    groupDead: true,
    worktreeDisposition: "removed",
    indexDisposition: "removed",
    refDisposition: "removed",
    contextDisposition: "retained_immutable",
    bundleDisposition: "retained_immutable",
    deliveryRefObservedOid: data.fixture.run.currentDeliveryOid,
    resourcesAbsent: true,
    leaseReleaseEligible: true,
    evidenceId: String(evidence.evidence_id),
    createdAt: "2026-07-16T12:05:00.000Z",
  };
}

function ownedTransitionRequest(
  ownerContextDigest: string,
  idempotencyKey: string,
  evidence: readonly ExistingTransitionEvidenceReference[],
  expectedVersion: number,
) {
  return { ownerContextDigest, idempotencyKey, evidence, expectedVersion } as const;
}

interface LifecycleReviewStart {
  readonly transitions: TransitionAuthority;
  readonly proof: readonly ExistingTransitionEvidenceReference[];
  readonly processRequest: ProcessReceiptRecordRequest;
  readonly process: StateRecord;
}

function advanceLifecycleToReview(data: LifecycleFixtureData, label: string): LifecycleReviewStart {
  const transitions = new TransitionAuthority(data.fixture.store);
  const proof = [evidenceReference(data.processEvidence, "attempt-lifecycle")];
  transitions.activateRun({
    runId: data.fixture.run.runId,
    initialAttemptId: data.fixture.attempt.attemptId,
    ...allocationRequest(data.fixture, `lifecycle:${label}:run-active`, proof),
  });
  transitions.activateInitialTicket({
    ticketInstanceId: data.fixture.attempt.ticketInstanceId,
    attemptId: data.fixture.attempt.attemptId,
    ...allocationRequest(data.fixture, `lifecycle:${label}:ticket-active`, proof),
  });
  transitions.startAttempt({
    attemptId: data.fixture.attempt.attemptId,
    ownershipId: data.leaseId,
    ...ownedTransitionRequest(
      data.fixture.phase.canonical.contextDigest,
      `lifecycle:${label}:attempt-start`,
      proof,
      0,
    ),
  });
  const processRequest = lifecycleProcessRequest(data, label);
  // Frozen v1 compatibility fixture only. Current process truth is produced by
  // ProcessSupervisor into the additive v3 tables.
  const process = insertLegacyProcessReceiptFixture(data, processRequest);
  transitions.captureImplementation({
    attemptId: data.fixture.attempt.attemptId,
    processReceiptId: processRequest.processReceiptId,
    ...ownedTransitionRequest(
      data.fixture.phase.canonical.contextDigest,
      `lifecycle:${label}:implementation-captured`,
      proof,
      1,
    ),
  });
  transitions.beginReview({
    attemptId: data.fixture.attempt.attemptId,
    contextId: data.reviewContext.persisted.contextId,
    ...ownedTransitionRequest(
      data.reviewContext.canonical.contextDigest,
      `lifecycle:${label}:reviewing`,
      proof,
      2,
    ),
  });
  return { transitions, proof, processRequest, process };
}

interface LifecycleVerificationStart extends LifecycleReviewStart {
  readonly reviewRequest: ReviewRecordRequest;
  readonly review: StateRecord;
}

function advanceLifecycleToVerification(data: LifecycleFixtureData, label: string): LifecycleVerificationStart {
  const started = advanceLifecycleToReview(data, label);
  const reviewRequest = lifecycleReviewRequest(data, `${label}-accepted`, 1, "accepted");
  const review = data.authority.recordReview(reviewRequest);
  const reviewProof = [
    { purpose: "review-verdict", evidenceId: reviewRequest.verdictEvidenceId },
    { purpose: "review-findings", evidenceId: reviewRequest.findingsEvidenceId },
  ] as const;
  started.transitions.queueVerification({
    attemptId: data.fixture.attempt.attemptId,
    reviewRecordId: reviewRequest.reviewRecordId,
    ...ownedTransitionRequest(
      data.reviewContext.canonical.contextDigest,
      `lifecycle:${label}:verification-queued`,
      reviewProof,
      3,
    ),
  });
  started.transitions.beginVerification({
    attemptId: data.fixture.attempt.attemptId,
    contextId: data.verificationContext.persisted.contextId,
    ...ownedTransitionRequest(
      data.verificationContext.canonical.contextDigest,
      `lifecycle:${label}:verifying`,
      reviewProof,
      4,
    ),
  });
  return { ...started, reviewRequest, review };
}

interface LifecycleConvergingStart extends LifecycleVerificationStart {
  readonly gateRequest: GateResultRecordRequest;
  readonly gate: StateRecord;
}

function advanceLifecycleToConverging(data: LifecycleFixtureData, label: string): LifecycleConvergingStart {
  const started = advanceLifecycleToVerification(data, label);
  const gateRequest = lifecycleGateRequest(data, `${label}-gate`);
  const gate = data.authority.recordGateResult(gateRequest);
  started.transitions.completeVerification({
    attemptId: data.fixture.attempt.attemptId,
    gateResultIds: [gateRequest.gateResultId],
    ...ownedTransitionRequest(
      data.verificationContext.canonical.contextDigest,
      `lifecycle:${label}:converging`,
      [{ purpose: "gate-result", evidenceId: gateRequest.evidenceId }],
      5,
    ),
  });
  return { ...started, gateRequest, gate };
}

describe("transactional lifecycle transition authority", () => {
  it("rejects constructor and prototype-forged transition and promotion commits", () => {
    const fixture = lineageFixture();
    try {
      expect(() => Reflect.construct(TransitionCommit, [
        Symbol("forged-transition"),
        "run",
        fixture.run.runId,
        "planned",
        "active",
        "RunAllocationService",
        0,
        fixture.attempt.allocationOwnerDigest,
        "forged:transition",
        [],
        { kind: "run_initial_attempt", attemptId: fixture.attempt.attemptId },
      ])).toThrow(/TransitionAuthority/);
      expect(() => fixture.store.commitAuthorizedTransition(
        Object.create(TransitionCommit.prototype) as TransitionCommit,
      )).toThrow(/minted by TransitionAuthority/);

      expect(() => Reflect.construct(PromotionCommit, [
        Symbol("forged-promotion"),
        "promotion-forged",
        "intent_recorded",
        "ref_observed_old",
        0,
        fixture.phase.canonical.contextDigest,
        "forged:promotion",
        { purpose: "forged", evidenceId: "evidence-forged" },
        { kind: "observe_old", observedOid: fixture.run.currentDeliveryOid },
      ])).toThrow(/PromotionAuthority/);
      expect(() => fixture.store.commitAuthorizedPromotion(
        Object.create(PromotionCommit.prototype) as PromotionCommit,
      )).toThrow(/minted by PromotionAuthority/);
      expect(all(fixture.store.location.databasePath, "SELECT transition_id FROM state_transitions")).toEqual([]);
      expect(all(fixture.store.location.databasePath, "SELECT promotion_intent_id FROM promotion_intents")).toEqual([]);
    } finally {
      fixture.store.close();
    }
  });

  it("records legal run and ticket activation with exact independent sequences", () => {
    const fixture = lineageFixture();
    const authority = new TransitionAuthority(fixture.store);
    try {
      const activationEvidence = evidenceReference(appendEvidence(fixture, "activation"));
      const runActivationRequest = {
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "run:activate", [activationEvidence]),
      };
      const runActive = authority.activateRun(runActivationRequest);
      const ticketActive = authority.activateInitialTicket({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "ticket:activate", [activationEvidence]),
      });
      expect(runActive).toMatchObject({
        entityKind: "run",
        entityId: fixture.run.runId,
        entitySequence: 1,
        fromState: "planned",
        toState: "active",
        ownerService: "RunAllocationService",
        stateVersion: 1,
      });
      expect(ticketActive).toMatchObject({
        entityKind: "ticket",
        entityId: fixture.attempt.ticketInstanceId,
        entitySequence: 1,
        fromState: "planned",
        toState: "active",
        ownerService: "RunAllocationService",
        stateVersion: 1,
      });
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", fixture.run.runId))
        .toEqual({ state: "active", state_version: 1 });
      expect(one(
        fixture.store.location.databasePath,
        "SELECT state, state_version FROM run_tickets WHERE ticket_instance_id = ?",
        fixture.attempt.ticketInstanceId,
      )).toEqual({ state: "active", state_version: 1 });
      expect(all(
        fixture.store.location.databasePath,
        "SELECT entity_sequence, from_state, to_state FROM state_transitions WHERE run_id = ? ORDER BY entity_sequence",
        fixture.run.runId,
      )).toEqual([
        { entity_sequence: 1, from_state: "planned", to_state: "active" },
      ]);
    } finally {
      fixture.store.close();
    }
  });

  it("records a guarded phase flow through clean attempt, ticket, and run failure terminals", () => {
    const fixture = lineageFixture();
    const authority = new TransitionAuthority(fixture.store);
    try {
      const evidence = appendEvidence(fixture, "phase-flow");
      const proof = [evidenceReference(evidence, "failure")];
      const guards = phaseGuardFixtures(fixture, evidence);
      authority.activateRun({
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "run:phase-flow:activate", proof),
      });
      authority.activateInitialTicket({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "ticket:phase-flow:activate", proof),
      });
      const startRequest = {
        attemptId: fixture.attempt.attemptId,
        ownershipId: guards.ownershipId,
        ...commonRequest(fixture, "attempt:start", proof, 0),
      };
      const startResult = authority.startAttempt(startRequest);
      const attemptResults = [
        startResult,
        authority.captureImplementation({
          attemptId: fixture.attempt.attemptId,
          processReceiptId: guards.processReceiptId,
          ...commonRequest(fixture, "attempt:capture", proof, 1),
        }),
        authority.beginReview({
          attemptId: fixture.attempt.attemptId,
          contextId: fixture.phase.persisted.contextId,
          ...commonRequest(fixture, "attempt:review", proof, 2),
        }),
        authority.queueVerification({
          attemptId: fixture.attempt.attemptId,
          reviewRecordId: guards.reviewRecordId,
          ...commonRequest(fixture, "attempt:queue-verification", proof, 3),
        }),
        authority.beginVerification({
          attemptId: fixture.attempt.attemptId,
          contextId: fixture.phase.persisted.contextId,
          ...commonRequest(fixture, "attempt:verify", proof, 4),
        }),
        authority.completeVerification({
          attemptId: fixture.attempt.attemptId,
          gateResultIds: [guards.gateResultId],
          ...commonRequest(fixture, "attempt:complete-verification", proof, 5),
        }),
        authority.beginAttemptCleanup({
          attemptId: fixture.attempt.attemptId,
          ...commonRequest(fixture, "attempt:cleanup", proof, 6),
        }),
      ];
      authority.beginTicketCleanup({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        ...commonRequest(fixture, "ticket:cleanup", proof, 1),
      });
      authority.beginRunCleanup({
        runId: fixture.run.runId,
        attemptId: fixture.attempt.attemptId,
        ...commonRequest(fixture, "run:failure-cleanup", proof, 1),
      });
      releaseFixtureLease(fixture, guards.ownershipId, String(evidence.evidence_id));
      const attemptTerminal = authority.markAttemptFailedClean({
        attemptId: fixture.attempt.attemptId,
        cleanupRecordId: guards.cleanupRecordId,
        ...commonRequest(fixture, "attempt:failed-clean", proof, 7),
      });
      const ticketTerminal = authority.failTicket({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        cleanupRecordId: guards.cleanupRecordId,
        ...commonRequest(fixture, "ticket:failed", proof, 2),
      });
      const runTerminal = authority.finalizeFailedRun({
        runId: fixture.run.runId,
        cleanupRecordId: guards.cleanupRecordId,
        ...commonRequest(fixture, "run:failed", proof, 2),
      });

      expect(attemptResults.map((result) => result.toState)).toEqual([
        "implementing",
        "implementation_captured",
        "reviewing",
        "verification_queued",
        "verifying",
        "converging",
        "cleanup_pending",
      ]);
      expect(attemptResults.map((result) => result.entitySequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(attemptTerminal).toMatchObject({
        entitySequence: 8,
        fromState: "cleanup_pending",
        toState: "failed_clean",
        ownerService: "CleanupService",
        stateVersion: 8,
      });
      expect(ticketTerminal).toMatchObject({ toState: "failed", stateVersion: 3 });
      expect(runTerminal).toMatchObject({ toState: "failed", stateVersion: 3 });
      expect(authority.startAttempt(startRequest)).toEqual(startResult);
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM attempts WHERE attempt_id = ?", fixture.attempt.attemptId))
        .toEqual({ state: "failed_clean", state_version: 8 });
      expect(one(
        fixture.store.location.databasePath,
        "SELECT state, state_version FROM run_tickets WHERE ticket_instance_id = ?",
        fixture.attempt.ticketInstanceId,
      )).toEqual({ state: "failed", state_version: 3 });
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", fixture.run.runId))
        .toEqual({ state: "failed", state_version: 3 });
    } finally {
      fixture.store.close();
    }
  });

  it("rejects failed required gates and omission of any recorded required gate without mutation", () => {
    for (const scenario of ["failed", "omitted"] as const) {
      const fixture = lineageFixture();
      const authority = new TransitionAuthority(fixture.store);
      try {
        const evidence = appendEvidence(fixture, `gate-${scenario}`);
        const guards = phaseGuardFixtures(fixture, evidence);
        const proof = advanceToVerifying(fixture, authority, evidence, guards, `gate-${scenario}`);
        const secondGateId = insertGateFixture(
          fixture,
          String(evidence.evidence_id),
          `second-${scenario}`,
          scenario === "failed" ? "failed" : "passed",
          1,
        );
        const selected = scenario === "failed"
          ? [guards.gateResultId, secondGateId]
          : [guards.gateResultId];
        expectStateCode(() => authority.completeVerification({
          attemptId: fixture.attempt.attemptId,
          gateResultIds: selected,
          ...commonRequest(fixture, `gate-${scenario}:complete`, proof, 5),
        }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
        expect(one(
          fixture.store.location.databasePath,
          "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
          fixture.attempt.attemptId,
        )).toEqual({ state: "verifying", state_version: 5 });
        expect(all(
          fixture.store.location.databasePath,
          "SELECT to_state FROM state_transitions WHERE attempt_id = ? ORDER BY entity_sequence",
          fixture.attempt.attemptId,
        )).toEqual([
          { to_state: "implementing" },
          { to_state: "implementation_captured" },
          { to_state: "reviewing" },
          { to_state: "verification_queued" },
          { to_state: "verifying" },
        ]);
      } finally {
        fixture.store.close();
      }
    }
  });

  it("rejects a guard record whose immutable evidence is absent from the transition references", () => {
    const fixture = lineageFixture();
    const authority = new TransitionAuthority(fixture.store);
    try {
      const guardEvidence = appendEvidence(fixture, "guard-evidence");
      const unrelatedEvidence = appendEvidence(fixture, "unrelated-command-evidence");
      const guards = phaseGuardFixtures(fixture, guardEvidence);
      const unrelatedProof = [evidenceReference(unrelatedEvidence)];
      authority.activateRun({
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "guard-evidence:run", unrelatedProof),
      });
      authority.activateInitialTicket({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "guard-evidence:ticket", unrelatedProof),
      });
      authority.startAttempt({
        attemptId: fixture.attempt.attemptId,
        ownershipId: guards.ownershipId,
        ...commonRequest(fixture, "guard-evidence:start", unrelatedProof, 0),
      });
      expectStateCode(() => authority.captureImplementation({
        attemptId: fixture.attempt.attemptId,
        processReceiptId: guards.processReceiptId,
        ...commonRequest(fixture, "guard-evidence:capture", unrelatedProof, 1),
      }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
      expect(one(
        fixture.store.location.databasePath,
        "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toEqual({ state: "implementing", state_version: 1 });
      expect(all(
        fixture.store.location.databasePath,
        "SELECT to_state FROM state_transitions WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toEqual([{ to_state: "implementing" }]);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects process, review, and gate guards owned by a different canonical phase context", () => {
    for (const scenario of ["process", "review", "gate"] as const) {
      const fixture = lineageFixture();
      const authority = new TransitionAuthority(fixture.store);
      try {
        const evidence = appendEvidence(fixture, `context-mismatch-${scenario}`);
        const proof = [evidenceReference(evidence)];
        const guards = phaseGuardFixtures(fixture, evidence);
        const otherContext = additionalPhaseContext(fixture);
        if (scenario === "gate") {
          advanceToVerifying(fixture, authority, evidence, guards, "context-mismatch-gate");
          expectStateCode(() => authority.completeVerification({
            attemptId: fixture.attempt.attemptId,
            gateResultIds: [guards.gateResultId],
            ...commonRequest(fixture, "context-mismatch-gate:complete", proof, 5),
            ownerContextDigest: otherContext.canonical.contextDigest,
          }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
          expect(one(
            fixture.store.location.databasePath,
            "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
            fixture.attempt.attemptId,
          )).toEqual({ state: "verifying", state_version: 5 });
          continue;
        }

        authority.activateRun({
          runId: fixture.run.runId,
          initialAttemptId: fixture.attempt.attemptId,
          ...allocationRequest(fixture, `context-mismatch-${scenario}:run`, proof),
        });
        authority.activateInitialTicket({
          ticketInstanceId: fixture.attempt.ticketInstanceId,
          attemptId: fixture.attempt.attemptId,
          ...allocationRequest(fixture, `context-mismatch-${scenario}:ticket`, proof),
        });
        authority.startAttempt({
          attemptId: fixture.attempt.attemptId,
          ownershipId: guards.ownershipId,
          ...commonRequest(fixture, `context-mismatch-${scenario}:start`, proof, 0),
        });
        if (scenario === "process") {
          expectStateCode(() => authority.captureImplementation({
            attemptId: fixture.attempt.attemptId,
            processReceiptId: guards.processReceiptId,
            ...commonRequest(fixture, "context-mismatch-process:capture", proof, 1),
            ownerContextDigest: otherContext.canonical.contextDigest,
          }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
          expect(one(
            fixture.store.location.databasePath,
            "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
            fixture.attempt.attemptId,
          )).toEqual({ state: "implementing", state_version: 1 });
        } else {
          authority.captureImplementation({
            attemptId: fixture.attempt.attemptId,
            processReceiptId: guards.processReceiptId,
            ...commonRequest(fixture, "context-mismatch-review:capture", proof, 1),
          });
          expectStateCode(() => authority.beginReview({
            attemptId: fixture.attempt.attemptId,
            contextId: fixture.phase.persisted.contextId,
            ...commonRequest(fixture, "context-mismatch-review:begin", proof, 2),
            ownerContextDigest: otherContext.canonical.contextDigest,
          }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
          expect(one(
            fixture.store.location.databasePath,
            "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
            fixture.attempt.attemptId,
          )).toEqual({ state: "implementation_captured", state_version: 2 });
        }
      } finally {
        fixture.store.close();
      }
    }
  });

  it("rejects ticket quarantine when its cleanup record belongs to an unrelated attempt", () => {
    const fixture = lineageFixture();
    const authority = new TransitionAuthority(fixture.store);
    try {
      const evidence = appendEvidence(fixture, "quarantine-target");
      const targetGuards = phaseGuardFixtures(fixture, evidence, "quarantined");
      const proof = advanceToVerifying(
        fixture,
        authority,
        evidence,
        targetGuards,
        "quarantine-target",
      );
      authority.completeVerification({
        attemptId: fixture.attempt.attemptId,
        gateResultIds: [targetGuards.gateResultId],
        ...commonRequest(fixture, "quarantine-target:complete", proof, 5),
      });
      authority.beginAttemptCleanup({
        attemptId: fixture.attempt.attemptId,
        ...commonRequest(
          fixture,
          "quarantine-target:cleanup",
          [evidenceReference(evidence, "failure")],
          6,
        ),
      });
      authority.beginTicketCleanup({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        ...commonRequest(fixture, "quarantine-target:ticket-cleanup", proof, 1),
      });
      releaseFixtureLease(fixture, targetGuards.ownershipId, String(evidence.evidence_id), "quarantined");
      authority.quarantineAttempt({
        attemptId: fixture.attempt.attemptId,
        cleanupRecordId: targetGuards.cleanupRecordId,
        ...commonRequest(fixture, "quarantine-target:attempt", proof, 7),
      });

      const unrelated = additionalLineage(fixture);
      const unrelatedEvidence = appendEvidence(unrelated, "quarantine-unrelated");
      const unrelatedCleanup = phaseGuardFixtures(unrelated, unrelatedEvidence).cleanupRecordId;
      expectStateCode(() => authority.quarantineTicket({
        ticketInstanceId: fixture.attempt.ticketInstanceId,
        attemptId: fixture.attempt.attemptId,
        cleanupRecordId: unrelatedCleanup,
        ...commonRequest(fixture, "quarantine-target:ticket", proof, 2),
      }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
      expect(one(
        fixture.store.location.databasePath,
        "SELECT state, state_version FROM run_tickets WHERE ticket_instance_id = ?",
        fixture.attempt.ticketInstanceId,
      )).toEqual({ state: "cleanup_pending", state_version: 2 });
    } finally {
      fixture.store.close();
    }
  });

  it("does not expose split delivery terminalization through TransitionAuthority", () => {
    const fixture = lineageFixture();
    try {
      const authority = new TransitionAuthority(fixture.store);
      expect(authority).not.toHaveProperty("finalizeDeliveredRun");
      expect(authority).not.toHaveProperty("finalizeDeliveryFailedRun");
    } finally {
      fixture.store.close();
    }
  });

  it("rejects wrong owners, missing evidence, out-of-order edges, and divergent idempotent input without mutation", () => {
    const fixture = lineageFixture();
    const authority = new TransitionAuthority(fixture.store);
    try {
      const proof = evidenceReference(appendEvidence(fixture, "negative"));
      expectStateCode(() => authority.activateRun({
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "run:wrong-owner", [proof]),
        ownerContextDigest: digest("foreign context"),
      }), "RICKGENT_STATE_OWNER_MISMATCH");
      expect(() => authority.activateRun({
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "run:missing-evidence", []),
      })).toThrow(/evidence/i);
      expectStateCode(() => authority.beginRunCleanup({
        runId: fixture.run.runId,
        attemptId: fixture.attempt.attemptId,
        ...commonRequest(fixture, "run:out-of-order", [proof]),
      }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", fixture.run.runId))
        .toEqual({ state: "planned", state_version: 0 });
      expect(all(fixture.store.location.databasePath, "SELECT transition_id FROM state_transitions")).toEqual([]);

      const request = {
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "run:idempotent", [proof]),
      };
      const committed = authority.activateRun(request);
      expect(authority.activateRun(request)).toEqual(committed);
      expectStateCode(() => authority.activateRun({
        ...request,
        evidence: [{ ...proof, purpose: "different-purpose" }],
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", fixture.run.runId))
        .toEqual({ state: "active", state_version: 1 });
      expect(all(fixture.store.location.databasePath, "SELECT transition_id FROM state_transitions")).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  it("chooses one concurrent winner and returns the committed result for exact idempotent replay", async () => {
    const fixture = lineageFixture();
    const proof = evidenceReference(appendEvidence(fixture, "race"));
    const exact = {
      runId: fixture.run.runId,
      initialAttemptId: fixture.attempt.attemptId,
      ...allocationRequest(fixture, "run:race:exact", [proof]),
    };
    fixture.store.close();

    const exactOutcomes = await Promise.all([
      runChild(fixture.repo, "activateRun", exact, "exact-left"),
      runChild(fixture.repo, "activateRun", exact, "exact-right"),
    ]);
    expect(exactOutcomes.every((outcome) => outcome.type === "result")).toBe(true);
    expect(exactOutcomes[0]?.result).toEqual(exactOutcomes[1]?.result);

    const second = lineageFixture();
    const secondProof = evidenceReference(appendEvidence(second, "race-winner"));
    const base = {
      runId: second.run.runId,
      initialAttemptId: second.attempt.attemptId,
      ...allocationRequest(second, "placeholder", [secondProof]),
    };
    second.store.close();
    const winnerOutcomes = await Promise.all([
      runChild(second.repo, "activateRun", { ...base, idempotencyKey: "run:race:left" }, "winner-left"),
      runChild(second.repo, "activateRun", { ...base, idempotencyKey: "run:race:right" }, "winner-right"),
    ]);
    expect(winnerOutcomes.filter((outcome) => outcome.type === "result")).toHaveLength(1);
    expect(winnerOutcomes.filter((outcome) =>
      outcome.code === "RICKGENT_STATE_CONFLICT" || outcome.code === "RICKGENT_STATE_TRANSITION_ILLEGAL"
    )).toHaveLength(1);
    const reopened = openStateStore({ repoPath: second.repo });
    try {
      expect(one(reopened.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", second.run.runId))
        .toEqual({ state: "active", state_version: 1 });
      expect(all(reopened.location.databasePath, "SELECT transition_id FROM state_transitions WHERE run_id = ?", second.run.runId))
        .toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("rolls back to the complete old image on a late failure and commits the complete new image otherwise", () => {
    const fixture = lineageFixture();
    const authority = new TransitionAuthority(fixture.store);
    try {
      const request = {
        runId: fixture.run.runId,
        initialAttemptId: fixture.attempt.attemptId,
        ...allocationRequest(fixture, "run:rollback", []),
        evidence: [{
          purpose: "activation",
          inlineEvidence: {
            contextId: fixture.phase.persisted.contextId,
            producerService: "RunAllocationService",
            scope: `run:${fixture.run.runId}`,
            schemaVersion: "rickgent.transition-activation/v1",
            payload: { run_id: fixture.run.runId, attempt_id: fixture.attempt.attemptId },
            idempotencyKey: "evidence:run:rollback",
          },
        }],
      };
      const database = openRaw(fixture.store.location.databasePath);
      try {
        database.exec(`
          CREATE TRIGGER transition_authority_late_abort
          BEFORE UPDATE ON runs
          WHEN NEW.run_id = '${fixture.run.runId}' AND NEW.state = 'active'
          BEGIN SELECT RAISE(ABORT, 'fixture late transition abort'); END;
        `);
      } finally {
        database.close();
      }

      expectStateCode(() => authority.activateRun(request), "RICKGENT_STATE_CONFLICT");
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", fixture.run.runId))
        .toEqual({ state: "planned", state_version: 0 });
      expect(all(fixture.store.location.databasePath, "SELECT transition_id FROM state_transitions")).toEqual([]);
      expect(all(fixture.store.location.databasePath, "SELECT transition_id FROM transition_evidence_refs")).toEqual([]);
      expect(all(fixture.store.location.databasePath, "SELECT evidence_id FROM evidence")).toEqual([]);

      const cleanup = openRaw(fixture.store.location.databasePath);
      try {
        cleanup.exec("DROP TRIGGER transition_authority_late_abort");
      } finally {
        cleanup.close();
      }
      const committed = authority.activateRun(request);
      expect(committed).toMatchObject({ toState: "active", stateVersion: 1 });
      expect(one(fixture.store.location.databasePath, "SELECT state, state_version FROM runs WHERE run_id = ?", fixture.run.runId))
        .toEqual({ state: "active", state_version: 1 });
      expect(all(fixture.store.location.databasePath, "SELECT transition_id FROM state_transitions"))
        .toEqual([{ transition_id: committed.transitionId }]);
      expect(all(fixture.store.location.databasePath, "SELECT transition_id, evidence_id FROM transition_evidence_refs"))
        .toEqual([{ transition_id: committed.transitionId, evidence_id: committed.evidence[0]!.evidenceId }]);
      expect(all(fixture.store.location.databasePath, "SELECT evidence_id FROM evidence"))
        .toEqual([{ evidence_id: committed.evidence[0]!.evidenceId }]);
    } finally {
      fixture.store.close();
    }
  });
});

describe("promotion authority", () => {
  it("creates, observes, and atomically finalizes a promotion with stable replay semantics", () => {
    const data = preparePromotionFixture("happy");
    try {
      const created = data.created!;
      execFileSync("git", ["-C", data.fixture.repo, "update-ref", data.fixture.run.deliveryRef, data.candidateOid]);
      const observationKey = "promotion:happy:observe-candidate";
      const observationRequest = {
        promotionIntentId: data.createRequest.promotionIntentId,
        expectedVersion: 0,
        ownerContextDigest: data.fixture.phase.canonical.contextDigest,
        idempotencyKey: observationKey,
        evidence: promotionInlineEvidence(
          data.fixture,
          data.createRequest.promotionIntentId,
          observationKey,
          0,
          "intent_recorded",
          "ref_observed_candidate",
          { kind: "observe_candidate", observedOid: data.candidateOid },
        ),
        observedOid: data.candidateOid,
      };
      const observation = data.authority.observeCandidate(observationRequest);
      const finalizationRequest = finalizePromotionRequest(data, observation, "promotion:happy:finalize");
      const finalized = data.authority.finalize(finalizationRequest);

      expect(observation).toMatchObject({
        fromState: "intent_recorded",
        toState: "ref_observed_candidate",
        stateVersion: 1,
        observedOid: data.candidateOid,
      });
      expect(finalized).toMatchObject({
        fromState: "ref_observed_candidate",
        toState: "finalized",
        stateVersion: 2,
        runStateVersion: 2,
      });
      expect(finalized.oracleEvaluationTransition).toMatchObject({ toState: "oracle_evaluation", stateVersion: 8 });
      expect(finalized.verifiedAttemptTransition).toMatchObject({ toState: "verified", stateVersion: 9 });
      expect(finalized.readyTicketTransition).toMatchObject({ toState: "ready_for_delivery", stateVersion: 3 });
      expect(data.authority.createIntent(data.createRequest)).toEqual(created);
      expect(data.authority.observeCandidate(observationRequest)).toEqual(observation);
      expect(data.authority.finalize(finalizationRequest)).toEqual(finalized);
      expectStateCode(() => data.authority.createIntent({
        ...data.createRequest,
        promotionIntentId: `${data.createRequest.promotionIntentId}-changed`,
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.finalize({
        ...finalizationRequest,
        cleanupRecordId: "cleanup-unrelated",
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.finalize({
        ...finalizationRequest,
        expectedRunVersion: finalizationRequest.expectedRunVersion + 1,
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version, current_delivery_oid, promotion_sequence FROM runs WHERE run_id = ?",
        data.fixture.run.runId,
      )).toEqual({
        state: "active",
        state_version: 2,
        current_delivery_oid: data.candidateOid,
        promotion_sequence: 1,
      });
    } finally {
      data.fixture.store.close();
    }
  });

  it("replays observe-old after candidate finalization and rejects same-key observation drift", () => {
    const data = preparePromotionFixture("observe-old");
    try {
      const oldKey = "promotion:observe-old:old";
      const oldRequest = {
        promotionIntentId: data.createRequest.promotionIntentId,
        expectedVersion: 0,
        ownerContextDigest: data.fixture.phase.canonical.contextDigest,
        idempotencyKey: oldKey,
        evidence: promotionInlineEvidence(
          data.fixture,
          data.createRequest.promotionIntentId,
          oldKey,
          0,
          "intent_recorded",
          "ref_observed_old",
          { kind: "observe_old", observedOid: data.fixture.run.currentDeliveryOid },
        ),
        observedOid: data.fixture.run.currentDeliveryOid,
      };
      const observedOld = data.authority.observeOld(oldRequest);
      execFileSync("git", ["-C", data.fixture.repo, "update-ref", data.fixture.run.deliveryRef, data.candidateOid]);
      const candidateKey = "promotion:observe-old:candidate";
      const observedCandidate = data.authority.observeCandidateAfterOld({
        promotionIntentId: data.createRequest.promotionIntentId,
        expectedVersion: 1,
        ownerContextDigest: data.fixture.phase.canonical.contextDigest,
        idempotencyKey: candidateKey,
        evidence: promotionInlineEvidence(
          data.fixture,
          data.createRequest.promotionIntentId,
          candidateKey,
          1,
          "ref_observed_old",
          "ref_observed_candidate",
          { kind: "observe_candidate", observedOid: data.candidateOid },
        ),
        observedOid: data.candidateOid,
      });
      data.authority.finalize(finalizePromotionRequest(
        data,
        observedCandidate,
        "promotion:observe-old:finalize",
        2,
      ));

      expect(data.authority.observeOld(oldRequest)).toEqual(observedOld);
      expectStateCode(() => data.authority.observeOld({
        ...oldRequest,
        observedOid: data.candidateOid,
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.observeOld({
        ...oldRequest,
        evidence: {
          ...oldRequest.evidence,
          inlineEvidence: {
            ...oldRequest.evidence.inlineEvidence,
            schemaVersion: "rickgent.promotion-operation.v2",
          },
        },
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
    } finally {
      data.fixture.store.close();
    }
  });

  it.each(["run", "attempt", "ticket"] as const)(
    "rejects intent creation when the %s has left the promotion-ready lifecycle state",
    (entity) => {
      const data = preparePromotionFixture(`invalid-intent-${entity}`, false);
      try {
        invalidatePromotionLifecycle(data, entity);
        expectStateCode(
          () => data.authority.createIntent(data.createRequest),
          "RICKGENT_STATE_RESUME_INCOMPATIBLE",
        );
        expect(one(
          data.fixture.store.location.databasePath,
          "SELECT promotion_intent_id FROM promotion_intents WHERE promotion_intent_id = ?",
          data.createRequest.promotionIntentId,
        )).toBeUndefined();
      } finally {
        data.fixture.store.close();
      }
    },
  );

  it.each(["run", "attempt", "ticket"] as const)(
    "rejects finalization atomically when the %s has left the promotion-ready lifecycle state",
    (entity) => {
      const data = preparePromotionFixture(`invalid-finalize-${entity}`);
      try {
        const observation = observePromotionCandidate(
          data,
          `promotion:invalid-finalize-${entity}:observe`,
        );
        const request = finalizePromotionRequest(
          data,
          observation,
          `promotion:invalid-finalize-${entity}:finalize`,
        );
        invalidatePromotionLifecycle(data, entity);

        expect(() => data.authority.finalize(request)).toThrow(StateStoreError);
        expect(one(
          data.fixture.store.location.databasePath,
          "SELECT state, state_version, finalization_evidence_id FROM promotion_intents WHERE promotion_intent_id = ?",
          data.createRequest.promotionIntentId,
        )).toEqual({
          state: "ref_observed_candidate",
          state_version: 1,
          finalization_evidence_id: null,
        });
        expect(one(
          data.fixture.store.location.databasePath,
          "SELECT current_delivery_oid, promotion_sequence FROM runs WHERE run_id = ?",
          data.fixture.run.runId,
        )).toEqual({
          current_delivery_oid: data.fixture.run.currentDeliveryOid,
          promotion_sequence: 0,
        });
        expect(all(
          data.fixture.store.location.databasePath,
          `SELECT to_state FROM state_transitions
           WHERE (attempt_id = ? AND to_state IN ('oracle_evaluation', 'verified'))
              OR (ticket_instance_id = ? AND to_state = 'ready_for_delivery')`,
          data.fixture.attempt.attemptId,
          data.fixture.attempt.ticketInstanceId,
        )).toEqual([]);
      } finally {
        data.fixture.store.close();
      }
    },
  );

  it("rolls back run, intent, attempt, ticket, transitions, and evidence on a late finalization failure", () => {
    const data = preparePromotionFixture("atomic-rollback");
    try {
      const observation = observePromotionCandidate(data, "promotion:atomic-rollback:observe");
      const finalizationKey = "promotion:atomic-rollback:finalize";
      const request = finalizePromotionRequest(data, observation, finalizationKey);
      const database = openRaw(data.fixture.store.location.databasePath);
      try {
        database.exec(`
          CREATE TRIGGER promotion_authority_late_abort
          BEFORE UPDATE ON run_tickets
          WHEN NEW.ticket_instance_id = '${data.fixture.attempt.ticketInstanceId}'
            AND NEW.state = 'ready_for_delivery'
          BEGIN SELECT RAISE(ABORT, 'fixture late promotion abort'); END;
        `);
      } finally {
        database.close();
      }

      expectStateCode(() => data.authority.finalize(request), "RICKGENT_STATE_CONFLICT");
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version, current_delivery_oid, promotion_sequence FROM runs WHERE run_id = ?",
        data.fixture.run.runId,
      )).toEqual({
        state: "active",
        state_version: 1,
        current_delivery_oid: data.fixture.run.currentDeliveryOid,
        promotion_sequence: 0,
      });
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version, finalization_evidence_id FROM promotion_intents WHERE promotion_intent_id = ?",
        data.createRequest.promotionIntentId,
      )).toEqual({
        state: "ref_observed_candidate",
        state_version: 1,
        finalization_evidence_id: null,
      });
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
        data.fixture.attempt.attemptId,
      )).toEqual({ state: "cleanup_pending", state_version: 7 });
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version FROM run_tickets WHERE ticket_instance_id = ?",
        data.fixture.attempt.ticketInstanceId,
      )).toEqual({ state: "cleanup_pending", state_version: 2 });
      expect(all(
        data.fixture.store.location.databasePath,
        `SELECT to_state FROM state_transitions
         WHERE (attempt_id = ? AND to_state IN ('oracle_evaluation', 'verified'))
            OR (ticket_instance_id = ? AND to_state = 'ready_for_delivery')`,
        data.fixture.attempt.attemptId,
        data.fixture.attempt.ticketInstanceId,
      )).toEqual([]);
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT evidence_id FROM evidence WHERE idempotency_key = ?",
        finalizationKey,
      )).toBeUndefined();

      const cleanup = openRaw(data.fixture.store.location.databasePath);
      try {
        cleanup.exec("DROP TRIGGER promotion_authority_late_abort");
      } finally {
        cleanup.close();
      }
      const finalized = data.authority.finalize(request);
      expect(finalized).toMatchObject({
        toState: "finalized",
        stateVersion: 2,
        runStateVersion: 2,
        oracleEvaluationTransition: { toState: "oracle_evaluation", stateVersion: 8 },
        verifiedAttemptTransition: { toState: "verified", stateVersion: 9 },
        readyTicketTransition: { toState: "ready_for_delivery", stateVersion: 3 },
      });
      expect(data.authority.finalize(request)).toEqual(finalized);
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version, current_delivery_oid, promotion_sequence FROM runs WHERE run_id = ?",
        data.fixture.run.runId,
      )).toEqual({
        state: "active",
        state_version: 2,
        current_delivery_oid: data.candidateOid,
        promotion_sequence: 1,
      });
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version FROM attempts WHERE attempt_id = ?",
        data.fixture.attempt.attemptId,
      )).toEqual({ state: "verified", state_version: 9 });
      expect(one(
        data.fixture.store.location.databasePath,
        "SELECT state, state_version FROM run_tickets WHERE ticket_instance_id = ?",
        data.fixture.attempt.ticketInstanceId,
      )).toEqual({ state: "ready_for_delivery", state_version: 3 });
    } finally {
      data.fixture.store.close();
    }
  });
});

describe("delivery authority", () => {
  it("rejects constructor and prototype-forged delivery commands", () => {
    const fixture = lineageFixture();
    try {
      expect(() => Reflect.construct(DeliveryCommand, [
        Symbol("forged-delivery"),
        { kind: "intent", request: {} },
      ])).toThrow(/DeliveryAuthority/);
      expect(() => fixture.store.commitAuthorizedDelivery(
        Object.create(DeliveryCommand.prototype) as DeliveryCommand,
      )).toThrow(/minted by DeliveryAuthority/);
      expect(all(fixture.store.location.databasePath, "SELECT delivery_intent_id FROM delivery_intents"))
        .toEqual([]);
    } finally {
      fixture.store.close();
    }
  });

  it("records an exact typed delivery chain and rejects every replay input drift", () => {
    const data = prepareDeliveryFixture("happy");
    try {
      const remoteRequest = remoteObservationRequest(data, "happy");
      const remote = data.authority.recordRemoteObservation(remoteRequest);
      const prRequest = prObservationRequest(data, "happy");
      const pr = data.authority.recordPrObservation(prRequest);
      const decisionRequest = deliveryDecisionRequest(
        data,
        "happy",
        "delivered",
        "pr_observed",
        remote,
        pr,
      );
      const decision = data.authority.recordDecision(decisionRequest);

      expect(data.intent).toMatchObject({
        delivery_intent_id: data.intentRequest.deliveryIntentId,
        run_id: data.promotion.fixture.run.runId,
        delivery_oid: data.promotion.candidateOid,
      });
      expect(remote).toMatchObject({
        operation: "ls-remote",
        observed_remote_oid: data.promotion.candidateOid,
      });
      expect(pr).toMatchObject({
        base_branch: data.intentRequest.baseBranch,
        head_branch: data.intentRequest.branchName,
        observed_head_oid: data.promotion.candidateOid,
      });
      expect(decision).toMatchObject({
        delivery_intent_id: data.intentRequest.deliveryIntentId,
        terminal_from_state: "pr_observed",
        decision: "delivered",
        delivery_oid: data.promotion.candidateOid,
      });
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        "SELECT state, state_version FROM runs WHERE run_id = ?",
        data.promotion.fixture.run.runId,
      )).toEqual({ state: "delivered", state_version: 4 });
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        `SELECT from_state, to_state, owner_service, idempotency_key
         FROM state_transitions WHERE run_id = ? AND to_state = 'delivered'`,
        data.promotion.fixture.run.runId,
      )).toEqual({
        from_state: "ready_for_delivery",
        to_state: "delivered",
        owner_service: "DeliveryService",
        idempotency_key: decisionRequest.transitionIdempotencyKey,
      });
      expect(all(
        data.promotion.fixture.store.location.databasePath,
        `SELECT tr.evidence_id FROM transition_evidence_refs tr
         JOIN state_transitions st ON st.transition_id = tr.transition_id
         WHERE st.run_id = ? AND st.to_state = 'delivered'`,
        data.promotion.fixture.run.runId,
      )).toHaveLength(4);

      expect(data.authority.createIntent(data.intentRequest)).toEqual(data.intent);
      expect(data.authority.recordRemoteObservation(remoteRequest)).toEqual(remote);
      expect(data.authority.recordPrObservation(prRequest)).toEqual(pr);
      expect(data.authority.recordDecision(decisionRequest)).toEqual(decision);

      expectStateCode(() => data.authority.createIntent({
        ...data.intentRequest,
        remoteName: "upstream",
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.createIntent({
        ...data.intentRequest,
        providerIdentityDigest: digest("changed-provider"),
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(() => data.authority.createIntent({
        ...data.intentRequest,
        idempotencyKey: `${data.intentRequest.idempotencyKey}:changed`,
      })).toThrow(StateStoreError);
      expectStateCode(() => data.authority.recordRemoteObservation({
        ...remoteRequest,
        observedRemoteOid: data.promotion.fixture.run.currentDeliveryOid,
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(() => data.authority.recordRemoteObservation({
        ...remoteRequest,
        evidenceIdempotencyKey: `${remoteRequest.evidenceIdempotencyKey}:changed`,
      })).toThrow(StateStoreError);
      for (const changed of [
        { providerRepositoryId: `${prRequest.providerRepositoryId}-changed` },
        { baseBranch: "develop" },
        { headBranch: "other-delivery" },
        { observedHeadOid: data.promotion.fixture.run.currentDeliveryOid },
      ] as const) {
        expectStateCode(() => data.authority.recordPrObservation({
          ...prRequest,
          ...changed,
        }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      }
      expect(() => data.authority.recordPrObservation({
        ...prRequest,
        evidenceIdempotencyKey: `${prRequest.evidenceIdempotencyKey}:changed`,
      })).toThrow(StateStoreError);
      expectStateCode(() => data.authority.recordDecision({
        ...decisionRequest,
        deliveryOid: data.promotion.fixture.run.currentDeliveryOid,
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(() => data.authority.recordDecision({
        ...decisionRequest,
        evidenceIdempotencyKey: `${decisionRequest.evidenceIdempotencyKey}:changed`,
      })).toThrow(StateStoreError);
      expectStateCode(() => data.authority.recordDecision({
        ...decisionRequest,
        transitionIdempotencyKey: `${decisionRequest.transitionIdempotencyKey}:changed`,
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.recordDecision({
        ...decisionRequest,
        transitionEvidence: decisionRequest.transitionEvidence.slice(1),
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
    } finally {
      data.promotion.fixture.store.close();
    }
  });

  it("rejects PR observation before remote observation and rejects push-only remote proof", () => {
    const beforeRemote = prepareDeliveryFixture("pr-before-remote");
    try {
      expect(() => beforeRemote.authority.recordPrObservation(
        prObservationRequest(beforeRemote, "pr-before-remote"),
      )).toThrow(StateStoreError);
      expect(all(
        beforeRemote.promotion.fixture.store.location.databasePath,
        "SELECT pr_observation_id FROM pr_observations",
      )).toEqual([]);
    } finally {
      beforeRemote.promotion.fixture.store.close();
    }

    const pushOnly = prepareDeliveryFixture("push-only");
    try {
      expectStateCode(() => pushOnly.authority.recordRemoteObservation(remoteObservationRequest(
        pushOnly,
        "push-with-oid",
        { operation: "push", observedRemoteOid: pushOnly.promotion.candidateOid },
      )), "RICKGENT_STATE_TRANSITION_ILLEGAL");
      const push = pushOnly.authority.recordRemoteObservation(remoteObservationRequest(
        pushOnly,
        "push-only",
        { operation: "push", observedRemoteOid: null },
      ));
      expect(push).toMatchObject({ operation: "push", observed_remote_oid: null });
      expectStateCode(() => pushOnly.authority.recordPrObservation(
        prObservationRequest(pushOnly, "push-only"),
      ), "RICKGENT_STATE_TRANSITION_ILLEGAL");
      expect(all(
        pushOnly.promotion.fixture.store.location.databasePath,
        "SELECT pr_observation_id FROM pr_observations",
      )).toEqual([]);
    } finally {
      pushOnly.promotion.fixture.store.close();
    }
  });

  it.each(["intent_recorded", "remote_observed", "pr_observed"] as const)(
    "atomically records delivery_failed from %s and terminalizes the run",
    (terminalFromState) => {
      const data = prepareDeliveryFixture(`failed-${terminalFromState}`);
      try {
        const remote = terminalFromState === "intent_recorded"
          ? null
          : data.authority.recordRemoteObservation(remoteObservationRequest(
            data,
            `failed-${terminalFromState}`,
          ));
        const pr = terminalFromState === "pr_observed"
          ? data.authority.recordPrObservation(prObservationRequest(
            data,
            `failed-${terminalFromState}`,
          ))
          : null;
        const request = deliveryDecisionRequest(
          data,
          `failed-${terminalFromState}`,
          "delivery_failed",
          terminalFromState,
          remote,
          pr,
        );
        const decision = data.authority.recordDecision(request);
        expect(decision).toMatchObject({
          terminal_from_state: terminalFromState,
          decision: "delivery_failed",
        });
        expect(data.authority.recordDecision(request)).toEqual(decision);
        expect(one(
          data.promotion.fixture.store.location.databasePath,
          "SELECT state, state_version FROM runs WHERE run_id = ?",
          data.promotion.fixture.run.runId,
        )).toEqual({ state: "delivery_failed", state_version: 4 });
        expect(one(
          data.promotion.fixture.store.location.databasePath,
          `SELECT from_state, to_state FROM state_transitions
           WHERE run_id = ? AND to_state = 'delivery_failed'`,
          data.promotion.fixture.run.runId,
        )).toEqual({ from_state: "ready_for_delivery", to_state: "delivery_failed" });
      } finally {
        data.promotion.fixture.store.close();
      }
    },
  );

  it("rolls back decision, evidence, transition history, and run state on a late terminal failure", () => {
    const data = prepareDeliveryFixture("atomic-rollback");
    try {
      const remote = data.authority.recordRemoteObservation(remoteObservationRequest(data, "atomic-rollback"));
      const pr = data.authority.recordPrObservation(prObservationRequest(data, "atomic-rollback"));
      const request = deliveryDecisionRequest(
        data,
        "atomic-rollback",
        "delivered",
        "pr_observed",
        remote,
        pr,
      );
      const database = openRaw(data.promotion.fixture.store.location.databasePath);
      try {
        database.exec(`
          CREATE TRIGGER delivery_authority_late_abort
          BEFORE UPDATE ON runs
          WHEN NEW.run_id = '${data.promotion.fixture.run.runId}' AND NEW.state = 'delivered'
          BEGIN SELECT RAISE(ABORT, 'fixture late delivery abort'); END;
        `);
      } finally {
        database.close();
      }

      expectStateCode(() => data.authority.recordDecision(request), "RICKGENT_STATE_CONFLICT");
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        "SELECT state, state_version FROM runs WHERE run_id = ?",
        data.promotion.fixture.run.runId,
      )).toEqual({ state: "ready_for_delivery", state_version: 3 });
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        "SELECT delivery_record_id FROM delivery_records WHERE delivery_intent_id = ?",
        data.intentRequest.deliveryIntentId,
      )).toBeUndefined();
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        "SELECT transition_id FROM state_transitions WHERE run_id = ? AND to_state = 'delivered'",
        data.promotion.fixture.run.runId,
      )).toBeUndefined();
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        "SELECT evidence_id FROM evidence WHERE idempotency_key = ?",
        request.evidenceIdempotencyKey,
      )).toBeUndefined();

      const cleanup = openRaw(data.promotion.fixture.store.location.databasePath);
      try {
        cleanup.exec("DROP TRIGGER delivery_authority_late_abort");
      } finally {
        cleanup.close();
      }
      const decision = data.authority.recordDecision(request);
      expect(data.authority.recordDecision(request)).toEqual(decision);
      expect(one(
        data.promotion.fixture.store.location.databasePath,
        "SELECT state, state_version FROM runs WHERE run_id = ?",
        data.promotion.fixture.run.runId,
      )).toEqual({ state: "delivered", state_version: 4 });
      expect(all(
        data.promotion.fixture.store.location.databasePath,
        "SELECT transition_id FROM state_transitions WHERE run_id = ? AND to_state = 'delivered'",
        data.promotion.fixture.run.runId,
      )).toHaveLength(1);
    } finally {
      data.promotion.fixture.store.close();
    }
  });
});

describe("lifecycle record authority", () => {
  it("rejects constructor and prototype-forged lifecycle record commands", () => {
    const fixture = lineageFixture();
    try {
      expect(() => Reflect.construct(LifecycleRecordCommand, [
        Symbol("forged-lifecycle-record"),
        { kind: "review_record", request: {} },
      ])).toThrow(/LifecycleRecordAuthority/);
      expect(() => fixture.store.commitAuthorizedLifecycleRecord(
        Object.create(LifecycleRecordCommand.prototype) as LifecycleRecordCommand,
      )).toThrow(/minted by LifecycleRecordAuthority/);
      for (const table of [
        "process_receipts",
        "review_records",
        "remediation_records",
        "gate_results",
        "commit_attributions",
        "cleanup_records",
      ]) {
        expect(all(fixture.store.location.databasePath, `SELECT * FROM ${table}`)).toEqual([]);
      }
    } finally {
      fixture.store.close();
    }
  });

  it("creates and exactly replays current typed lifecycle proofs while v1 process receipts remain read-only", () => {
    const data = prepareLifecycleFixture("happy");
    try {
      const started = advanceLifecycleToReview(data, "happy");
      const processRequest = started.processRequest;
      const process = started.process;
      const rejectedReviewRequest = lifecycleReviewRequest(data, "happy-rejected", 1);
      const rejectedReview = data.authority.recordReview(rejectedReviewRequest);
      const rejectedReviewProof = [
        { purpose: "review-verdict", evidenceId: rejectedReviewRequest.verdictEvidenceId },
        { purpose: "review-findings", evidenceId: rejectedReviewRequest.findingsEvidenceId },
      ] as const;
      started.transitions.beginRemediation({
        attemptId: data.fixture.attempt.attemptId,
        reviewRecordId: rejectedReviewRequest.reviewRecordId,
        ...ownedTransitionRequest(
          data.reviewContext.canonical.contextDigest,
          "lifecycle:happy:remediating",
          rejectedReviewProof,
          3,
        ),
      });
      const remediationRequest = lifecycleRemediationRequest(data, "happy", rejectedReviewRequest);
      const remediation = data.authority.recordRemediation(remediationRequest);
      const remediationProof = [
        { purpose: "remediation-findings", evidenceId: remediationRequest.findingsEvidenceId },
        { purpose: "remediation-output", evidenceId: remediationRequest.outputEvidenceId },
      ] as const;
      started.transitions.captureRemediation({
        attemptId: data.fixture.attempt.attemptId,
        remediationRecordId: remediationRequest.remediationRecordId,
        ...ownedTransitionRequest(
          data.remediationContext.canonical.contextDigest,
          "lifecycle:happy:remediation-captured",
          remediationProof,
          4,
        ),
      });
      started.transitions.beginReviewAfterRemediation({
        attemptId: data.fixture.attempt.attemptId,
        contextId: data.reviewContext.persisted.contextId,
        ...ownedTransitionRequest(
          data.reviewContext.canonical.contextDigest,
          "lifecycle:happy:reviewing-after-remediation",
          remediationProof,
          5,
        ),
      });
      const acceptedReviewRequest = lifecycleReviewRequest(data, "happy-accepted", 2, "accepted");
      const acceptedReview = data.authority.recordReview(acceptedReviewRequest);
      const acceptedReviewProof = [
        { purpose: "review-verdict", evidenceId: acceptedReviewRequest.verdictEvidenceId },
        { purpose: "review-findings", evidenceId: acceptedReviewRequest.findingsEvidenceId },
      ] as const;
      started.transitions.queueVerification({
        attemptId: data.fixture.attempt.attemptId,
        reviewRecordId: acceptedReviewRequest.reviewRecordId,
        ...ownedTransitionRequest(
          data.reviewContext.canonical.contextDigest,
          "lifecycle:happy:verification-queued",
          acceptedReviewProof,
          6,
        ),
      });
      started.transitions.beginVerification({
        attemptId: data.fixture.attempt.attemptId,
        contextId: data.verificationContext.persisted.contextId,
        ...ownedTransitionRequest(
          data.verificationContext.canonical.contextDigest,
          "lifecycle:happy:verifying",
          acceptedReviewProof,
          7,
        ),
      });
      const gateRequest = lifecycleGateRequest(data, "happy");
      const gate = data.authority.recordGateResult(gateRequest);
      started.transitions.completeVerification({
        attemptId: data.fixture.attempt.attemptId,
        gateResultIds: [gateRequest.gateResultId],
        ...ownedTransitionRequest(
          data.verificationContext.canonical.contextDigest,
          "lifecycle:happy:converging",
          [{ purpose: "gate-result", evidenceId: gateRequest.evidenceId }],
          8,
        ),
      });
      const attributionRequest = lifecycleAttributionRequest(data, "happy");
      expect(() => data.authority.recordCommitAttribution(attributionRequest)).toThrow(/only CommitService/);
      const attributionEvidence = one(
        data.fixture.store.location.databasePath,
        "SELECT * FROM evidence WHERE evidence_id = ?",
        attributionRequest.attributionEvidenceId,
      ) as StateRecord;
      const durableAttribution = promotionPrerequisites(data.fixture, attributionEvidence, data.candidateOid);
      const attributionProof = [{
        purpose: "commit-attribution",
        evidenceId: attributionRequest.attributionEvidenceId,
      }] as const;
      started.transitions.beginAttemptCleanup({
        attemptId: data.fixture.attempt.attemptId,
        commitAttributionId: durableAttribution.commitAttributionId,
        ...ownedTransitionRequest(
          data.fixture.phase.canonical.contextDigest,
          "lifecycle:happy:attempt-cleanup",
          attributionProof,
          9,
        ),
      });
      started.transitions.beginTicketCleanup({
        ticketInstanceId: data.fixture.attempt.ticketInstanceId,
        attemptId: data.fixture.attempt.attemptId,
        ...ownedTransitionRequest(
          data.fixture.phase.canonical.contextDigest,
          "lifecycle:happy:ticket-cleanup",
          attributionProof,
          1,
        ),
      });
      const cleanupRequest = lifecycleCleanupRequest(data, "happy");
      releaseFixtureLease(data.fixture, data.leaseId, cleanupRequest.evidenceId);
      const cleanup = data.authority.recordCleanup(cleanupRequest);

      expect(process).toMatchObject({ process_receipt_id: processRequest.processReceiptId });
      expect(rejectedReview).toMatchObject({ verdict: "rejected", cycle: 1 });
      expect(acceptedReview).toMatchObject({ verdict: "accepted", cycle: 2 });
      expect(remediation).toMatchObject({ cycle: 1, result_tree_oid: data.candidateTreeOid });
      expect(gate).toMatchObject({ gate_id: "VER-TRANSITION", status: "passed", required: 1 });
      expect(cleanup).toMatchObject({ outcome: "verified", delivery_ref_observed_oid: data.fixture.run.currentDeliveryOid });

      expect(() => data.authority.recordProcessReceipt(processRequest)).toThrow(/only ProcessSupervisor/);
      expect(data.authority.recordReview(rejectedReviewRequest)).toEqual(rejectedReview);
      expect(data.authority.recordReview(acceptedReviewRequest)).toEqual(acceptedReview);
      expect(data.authority.recordRemediation(remediationRequest)).toEqual(remediation);
      expect(data.authority.recordGateResult(gateRequest)).toEqual(gate);
      expect(() => data.authority.recordCommitAttribution(attributionRequest)).toThrow(/only CommitService/);
      expect(data.authority.recordCleanup(cleanupRequest)).toEqual(cleanup);

      expectStateCode(() => data.authority.recordReview({
        ...rejectedReviewRequest,
        createdAt: "2026-07-16T13:01:00.000Z",
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.recordRemediation({
        ...remediationRequest,
        createdAt: "2026-07-16T13:02:00.000Z",
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expectStateCode(() => data.authority.recordGateResult({
        ...gateRequest,
        createdAt: "2026-07-16T13:03:00.000Z",
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");
      expect(() => data.authority.recordCommitAttribution({
        ...attributionRequest,
        createdAt: "2026-07-16T13:04:00.000Z",
      })).toThrow(/only CommitService/);
      expectStateCode(() => data.authority.recordCleanup({
        ...cleanupRequest,
        createdAt: "2026-07-16T13:05:00.000Z",
      }), "RICKGENT_STATE_IDEMPOTENCY_CONFLICT");

      writeFileSync(join(data.fixture.repo, "README.md"), "changed after lifecycle records\n", "utf8");
      execFileSync("git", ["-C", data.fixture.repo, "add", "README.md"]);
      execFileSync("git", ["-C", data.fixture.repo, "commit", "-qm", "later live state"]);
      const laterOid = repoHead(data.fixture.repo);
      execFileSync("git", ["-C", data.fixture.repo, "update-ref", data.fixture.run.deliveryRef, laterOid]);
      expect(() => data.authority.recordCommitAttribution(attributionRequest)).toThrow(/only CommitService/);
      expect(data.authority.recordCleanup(cleanupRequest)).toEqual(cleanup);

      for (const table of [
        "process_receipts",
        "remediation_records",
        "gate_results",
        "commit_attributions",
        "cleanup_records",
      ]) {
        expect(all(data.fixture.store.location.databasePath, `SELECT * FROM ${table}`)).toHaveLength(1);
      }
      expect(all(data.fixture.store.location.databasePath, "SELECT * FROM review_records")).toHaveLength(2);
    } finally {
      data.fixture.store.close();
    }
  });

  it("rejects wrong reviewer role/context and unknown or non-required contract gates", () => {
    const data = prepareLifecycleFixture("reviewer-negatives");
    try {
      advanceLifecycleToReview(data, "reviewer-negatives");
      const reviewRequest = lifecycleReviewRequest(data, "wrong-reviewer", 1);
      expectStateCode(() => data.authority.recordReview({
        ...reviewRequest,
        reviewerContextId: data.fixture.phase.persisted.contextId,
        ownerContextDigest: data.fixture.phase.canonical.contextDigest,
      }), "RICKGENT_STATE_TRANSITION_ILLEGAL");
      expectStateCode(() => data.authority.recordReview({
        ...reviewRequest,
        ownerContextDigest: data.fixture.phase.canonical.contextDigest,
      }), "RICKGENT_STATE_TRANSITION_ILLEGAL");

      expect(all(data.fixture.store.location.databasePath, "SELECT review_record_id FROM review_records"))
        .toEqual([]);
    } finally {
      data.fixture.store.close();
    }

    const gateData = prepareLifecycleFixture("gate-negatives");
    try {
      advanceLifecycleToVerification(gateData, "gate-negatives");
      const unknownGate = lifecycleGateRequest(gateData, "unknown-gate", "VER-UNKNOWN");
      expectStateCode(
        () => gateData.authority.recordGateResult(unknownGate),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );
      const nonRequiredGate = lifecycleGateRequest(gateData, "non-required-gate", "VER-TRANSITION", false);
      expectStateCode(
        () => gateData.authority.recordGateResult(nonRequiredGate),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );
      expect(all(gateData.fixture.store.location.databasePath, "SELECT gate_result_id FROM gate_results"))
        .toEqual([]);
    } finally {
      gateData.fixture.store.close();
    }
  });

  it("rejects review and remediation cycles beyond the sealed contract budgets", () => {
    const data = prepareLifecycleFixture("budget-overflow");
    try {
      const started = advanceLifecycleToReview(data, "budget-overflow");
      const firstReview = lifecycleReviewRequest(data, "budget-review-1", 1);
      data.authority.recordReview(firstReview);
      const firstReviewProof = [
        { purpose: "review-verdict", evidenceId: firstReview.verdictEvidenceId },
        { purpose: "review-findings", evidenceId: firstReview.findingsEvidenceId },
      ] as const;
      started.transitions.beginRemediation({
        attemptId: data.fixture.attempt.attemptId,
        reviewRecordId: firstReview.reviewRecordId,
        ...ownedTransitionRequest(
          data.reviewContext.canonical.contextDigest,
          "lifecycle:budget:remediating-1",
          firstReviewProof,
          3,
        ),
      });
      const firstRemediation = lifecycleRemediationRequest(data, "budget-remediation-1", firstReview);
      data.authority.recordRemediation(firstRemediation);
      const firstRemediationProof = [
        { purpose: "remediation-findings", evidenceId: firstRemediation.findingsEvidenceId },
        { purpose: "remediation-output", evidenceId: firstRemediation.outputEvidenceId },
      ] as const;
      started.transitions.captureRemediation({
        attemptId: data.fixture.attempt.attemptId,
        remediationRecordId: firstRemediation.remediationRecordId,
        ...ownedTransitionRequest(
          data.remediationContext.canonical.contextDigest,
          "lifecycle:budget:remediation-captured-1",
          firstRemediationProof,
          4,
        ),
      });
      started.transitions.beginReviewAfterRemediation({
        attemptId: data.fixture.attempt.attemptId,
        contextId: data.reviewContext.persisted.contextId,
        ...ownedTransitionRequest(
          data.reviewContext.canonical.contextDigest,
          "lifecycle:budget:reviewing-2",
          firstRemediationProof,
          5,
        ),
      });
      const secondReview = lifecycleReviewRequest(data, "budget-review-2", 2);
      data.authority.recordReview(secondReview);
      const overflowReview = lifecycleReviewRequest(data, "budget-review-3", 3);
      expectStateCode(
        () => data.authority.recordReview(overflowReview),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );

      const secondReviewProof = [
        { purpose: "review-verdict", evidenceId: secondReview.verdictEvidenceId },
        { purpose: "review-findings", evidenceId: secondReview.findingsEvidenceId },
      ] as const;
      started.transitions.beginRemediation({
        attemptId: data.fixture.attempt.attemptId,
        reviewRecordId: secondReview.reviewRecordId,
        ...ownedTransitionRequest(
          data.reviewContext.canonical.contextDigest,
          "lifecycle:budget:remediating-2",
          secondReviewProof,
          6,
        ),
      });
      const overflowRemediation = lifecycleRemediationRequest(
        data,
        "budget-remediation-2",
        secondReview,
      );
      expectStateCode(
        () => data.authority.recordRemediation(overflowRemediation),
        "RICKGENT_STATE_TRANSITION_ILLEGAL",
      );
      expect(all(data.fixture.store.location.databasePath, "SELECT cycle FROM review_records ORDER BY cycle"))
        .toEqual([{ cycle: 1 }, { cycle: 2 }]);
      expect(all(data.fixture.store.location.databasePath, "SELECT cycle FROM remediation_records"))
        .toEqual([{ cycle: 1 }]);
    } finally {
      data.fixture.store.close();
    }
  });

  it("keeps legacy attribution production disabled even for drifted and out-of-scope inputs", () => {
    const digestMismatch = prepareLifecycleFixture("attribution-digest");
    try {
      advanceLifecycleToConverging(digestMismatch, "attribution-digest");
      const request = lifecycleAttributionRequest(digestMismatch, "attribution-digest");
      expect(() => digestMismatch.authority.recordCommitAttribution({
        ...request,
        pathSetDigest: digest("wrong-path-set"),
      })).toThrow(/only CommitService/);
      expect(all(
        digestMismatch.fixture.store.location.databasePath,
        "SELECT commit_attribution_id FROM commit_attributions",
      )).toEqual([]);
    } finally {
      digestMismatch.fixture.store.close();
    }

    const outOfScope = prepareLifecycleFixture("attribution-scope");
    try {
      advanceLifecycleToConverging(outOfScope, "attribution-scope");
      execFileSync("git", [
        "-C",
        outOfScope.fixture.repo,
        "checkout",
        "-q",
        "--detach",
        outOfScope.fixture.attempt.deliveryBaselineOid,
      ]);
      writeFileSync(join(outOfScope.fixture.repo, "README.md"), "out of scope\n", "utf8");
      execFileSync("git", ["-C", outOfScope.fixture.repo, "add", "README.md"]);
      execFileSync("git", ["-C", outOfScope.fixture.repo, "commit", "-qm", "out-of-scope candidate"]);
      const commitOid = repoHead(outOfScope.fixture.repo);
      const treeAfterOid = repositoryTree(outOfScope.fixture.repo, commitOid);
      const delta = canonicalFixtureDelta(outOfScope.fixture, commitOid);
      const commitAttributionId = `attribution-out-of-scope-${outOfScope.fixture.attempt.attemptId}`;
      const evidence = appendLifecycleEvidence(
        outOfScope.fixture,
        "lifecycle-attribution-out-of-scope",
        "AttemptLifecycleService",
        "rickgent.commit-attribution.v1",
        {
          contract_digest: outOfScope.fixture.attempt.contractDigest,
          baseline_oid: outOfScope.fixture.attempt.deliveryBaselineOid,
          parent_oid: outOfScope.fixture.attempt.deliveryBaselineOid,
          tree_before_oid: repositoryTree(outOfScope.fixture.repo, outOfScope.fixture.attempt.deliveryBaselineOid),
          tree_after_oid: treeAfterOid,
          commit_oid: commitOid,
          candidate_diff_digest: delta.candidateDiffDigest,
          path_set_digest: delta.pathSetDigest,
          change_kind_set_digest: delta.changeKindSetDigest,
          mode_set_digest: delta.modeSetDigest,
          normalized_delta: delta.entries,
        },
        commitAttributionId,
      );
      expect(() => outOfScope.authority.recordCommitAttribution({
        commitAttributionId,
        attemptId: outOfScope.fixture.attempt.attemptId,
        baselineOid: outOfScope.fixture.attempt.deliveryBaselineOid,
        parentOid: outOfScope.fixture.attempt.deliveryBaselineOid,
        treeBeforeOid: repositoryTree(outOfScope.fixture.repo, outOfScope.fixture.attempt.deliveryBaselineOid),
        treeAfterOid,
        commitOid,
        contractDigest: outOfScope.fixture.attempt.contractDigest,
        contextDigest: outOfScope.fixture.phase.canonical.contextDigest,
        pathSetDigest: delta.pathSetDigest,
        changeKindSetDigest: delta.changeKindSetDigest,
        modeSetDigest: delta.modeSetDigest,
        attributionEvidenceId: String(evidence.evidence_id),
        createdAt: "2026-07-16T12:04:00.000Z",
      })).toThrow(/only CommitService/);
      expect(all(
        outOfScope.fixture.store.location.databasePath,
        "SELECT commit_attribution_id FROM commit_attributions",
      )).toEqual([]);
    } finally {
      outOfScope.fixture.store.close();
    }
  });
});
