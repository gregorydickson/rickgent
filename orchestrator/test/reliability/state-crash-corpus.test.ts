import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getCapability } from "../../src/capabilities/registry.js";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import { DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION } from "../../src/context/execution-context.js";
import {
  RESOURCE_IDENTITY_VERSION,
  RUN_MANIFEST_SCHEMA_VERSION,
  compiledCapabilitySnapshot,
} from "../../src/context/resolver.js";
import { STATE_TRANSACTION_NAMES } from "../../src/state/schema.js";
import {
  openStateStore,
  type AllocateFreshRunInput,
  type AllocatedAttempt,
  type AllocatedRun,
  type ResumeCompatibilityInput,
  type RetryCompatibilityInput,
  type StateLocation,
  type StateStore,
} from "../../src/state/store.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;
type CrashSide = "before_commit" | "after_commit_before_return";

interface CrashManifest {
  readonly schema_version: string;
  readonly corpus_id: string;
  readonly complete: boolean;
  readonly proof_scope: string;
  readonly inventory_kind: string;
  readonly fault_sides: readonly CrashSide[];
  readonly assertions: readonly string[];
  readonly fault_points: readonly string[];
  readonly direct_crash_points: readonly string[];
  readonly semantic_proof_suites: readonly string[];
  readonly deferred_recovery: Readonly<Record<string, string>>;
  readonly public_capability: Readonly<Record<string, string>>;
}

interface FaultPoint {
  readonly id: string;
  readonly boundary: string;
  readonly contract_transaction: string | null;
  readonly implementation_operation: string | null;
  readonly proof_level: "semantic_suite" | "common_wrapper_crash" | "direct_retry_crash";
  readonly semantic_proof: string;
  readonly semantic_proof_id: string;
  readonly deferred_ticket?: string;
  readonly crash_parity_ticket: "t29";
}

interface FaultInventory {
  readonly schema_version: string;
  readonly corpus_id: string;
  readonly points: readonly FaultPoint[];
}

interface CrashSummary {
  readonly schema_version: string;
  readonly corpus_id: string;
  readonly status: string;
  readonly manifest_digest: string;
  readonly fault_points_digest: string;
  readonly inventory_point_count: number;
  readonly common_wrapper_crash_cases: number;
  readonly direct_retry_crash_cases: number;
  readonly synchronized_retry_races: number;
  readonly proof_scope: string;
  readonly deferred_full_recovery_ticket: "t29";
  readonly harness_digest: string;
  readonly test_digest: string;
  readonly assertions: readonly string[];
  readonly proof_corpus: readonly string[];
}

interface IpcMessage {
  readonly type: "ready" | "result" | "error";
  readonly code?: string;
  readonly message?: string;
  readonly result?: Record<string, unknown>;
}

interface CheckpointFrame {
  readonly type: "checkpoint";
  readonly checkpoint: CrashSide;
  readonly operation: "probe" | "retry";
}

interface ChildEvent {
  readonly channel: "ipc" | "checkpoint";
  readonly value: IpcMessage | CheckpointFrame;
}

interface EventWaiter {
  readonly predicate: (event: ChildEvent) => boolean;
  readonly resolve: (event: ChildEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ManagedChild {
  readonly child: ChildProcess;
  readonly events: ChildEvent[];
  readonly waiters: EventWaiter[];
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  stderr: string;
  stdoutRemainder: string;
}

interface RetryFixture {
  readonly repo: string;
  readonly inputPath: string;
  readonly databasePath: string;
  readonly initial: AllocatedAttempt;
  readonly initialRow: SqlRow;
  readonly resume: ResumeCompatibilityInput;
}

const manifestPath = join(import.meta.dirname, "../fixtures/crash-matrix/manifest.json");
const inventoryPath = join(import.meta.dirname, "../fixtures/crash-matrix/fault-points.json");
const summaryPath = join(import.meta.dirname, "../../../artifacts/reliability/state-crash-summary.json");
const childFixture = join(import.meta.dirname, "../fixtures/crash-matrix/child.mjs");
const testSourcePath = join(import.meta.dirname, "state-crash-corpus.test.ts");
const storeSourcePath = join(import.meta.dirname, "../../src/state/store.ts");
const workspaceRoot = realpathSync(join(import.meta.dirname, "../../.."));
const manifestBytes = readFileSync(manifestPath, "utf8");
const inventoryBytes = readFileSync(inventoryPath, "utf8");
const childFixtureBytes = readFileSync(childFixture, "utf8");
const testSourceBytes = readFileSync(testSourcePath, "utf8");
const manifest = JSON.parse(manifestBytes) as CrashManifest;
const inventory = JSON.parse(inventoryBytes) as FaultInventory;
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as CrashSummary;
const scratchRoots = new Set<string>();
const managedChildren = new Set<ManagedChild>();

const REQUIRED_POINT_IDS = [
  "open_and_migrate",
  "run_creation",
  "contract_insert",
  "initial_attempt_allocation",
  "resume_selection",
  "retry_selection",
  "retry_attempt_allocation",
  "execution_context_insert",
  "immutable_evidence_insert",
  "lease_acquisition",
  "ownership_assertion",
  "lease_heartbeat",
  "lease_cleanup_begin",
  "lease_release",
  "resource_reservation",
  "resource_activation",
  "resource_quarantine",
  "resource_release",
  "stale_ownership_recovery",
  "phase_start",
  "phase_finish",
  "process_launch",
  "process_terminal",
  "review_record",
  "remediation_record",
  "required_gate_result",
  "commit_attribution_prepare",
  "commit_attribution",
  "cleanup_record",
  "oracle_decision",
  "promotion_intent",
  "promotion_observation",
  "promotion_finalization",
  "delivery_intent",
  "remote_observation",
  "pr_observation",
  "terminal_commit_delivered",
  "terminal_commit_failed",
  "legacy_inventory",
  "runner_run_activation",
  "runner_ticket_activation",
  "attempt_cleanup_pending_transition",
  "claims_quarantine_transition",
  "ticket_cleanup_pending_transition",
  "target_proof_set_seal",
  "target_start_gate_create",
  "quarantine_ownership_finalize",
  "cleanup_eligibility_mint",
  "failure_cleanup_mint",
  "promotion_cleanup_mint",
  "quarantine_mint",
  "target_never_released_mint",
  "target_released_mint",
  "authority_claim_snapshot",
  "authority_commit_attribution",
  "authority_evidence",
  "authority_ownership_snapshot",
  "authority_process_chain",
  "orphaned_planned_cleanup",
  "authority_salvage_record",
] as const;

const REQUIRED_ASSERTIONS = [
  "inventory_exact",
  "same_canonical_database_path",
  "state_readable",
  "integrity_clean",
  "old_or_new_committed_state",
  "immutable_prior_evidence",
  "expected_sigkill_observed",
  "precommit_rolls_back",
  "postcommit_survives_without_return",
  "new_attempt_before_retry_side_effects",
  "retry_response_loss_selects_planned_attempt",
  "one_retry_allocator_wins",
  "busy_is_not_success",
  "no_replay",
  "no_manufactured_terminal",
  "public_resume_activated_after_proof",
] as const;

const DYNAMIC_IMPLEMENTATION_OPERATIONS = [
  "open_and_migrate",
  "allocate_initial_attempt",
  "allocate_retry_attempt",
  "observe_promotion",
  "finalize_promotion",
  "attempt_ownership_acquire",
  "attempt_ownership_assert_current",
  "attempt_ownership_heartbeat",
  "attempt_ownership_begin_cleanup",
  "attempt_ownership_advance_resource",
  "attempt_ownership_stale_recovery",
] as const;

const STATE_STORE_SUITE = "orchestrator/test/reliability/state-store.test.ts";
const IDENTITY_SUITE = "orchestrator/test/reliability/identity-allocation.test.ts";
const TRANSITION_SUITE = "orchestrator/test/reliability/transition-authority.test.ts";
const ORACLE_SUITE = "orchestrator/test/reliability/oracle-store-integration.test.ts";
const LEGACY_SUITE = "orchestrator/test/reliability/legacy-state-quarantine.test.ts";
const ATTEMPT_OWNERSHIP_SUITE = "orchestrator/test/reliability/attempt-ownership.test.ts";
const PROCESS_SUPERVISOR_SUITE = "orchestrator/test/reliability/process-supervisor-corpus.test.ts";
const GIT_ATTRIBUTION_SUITE = "orchestrator/test/reliability/git-attribution-corpus.test.ts";
const STORE_OPEN_PROOF = "creates and reopens the exact released schema and canonical repository row";
const RUN_ALLOCATION_PROOF = "allocates distinct ordinary runs for identical normalized input and persists exact contracts";
const ATTEMPT_ALLOCATION_PROOF = "commits monotonic attempts before downstream work and preserves prior rows";
const RESUME_SELECTION_PROOF = "selects only an explicit exactly compatible run and rejects every compatibility drift";
const RETRY_RACE_PROOF = "allows one winner when concurrent retry allocators race on max+1";
const CONTEXT_PROOF = "resolves and persists complete immutable context without copying process.env";
const EVIDENCE_PROOF = "is idempotent for identical immutable input and conflicts on divergent input";
const ORACLE_REFERENCE_PROOF = "resolves the exhaustive reference set itself and persists deterministic contiguous ordering";
const PHASE_PROOF = "records a guarded phase flow through clean attempt, ticket, and run failure terminals";
const LIFECYCLE_RECORD_PROOF = "creates and exactly replays current typed lifecycle proofs while v1 process receipts remain read-only";
const PROMOTION_PROOF = "creates, observes, and atomically finalizes a promotion with stable replay semantics";
const DELIVERY_PROOF = "records an exact typed delivery chain and rejects every replay input drift";
const LEGACY_PROOF = "quarantines valid terminal registry, terminal ledgers, locks, and Git subjects without importing truth";
const OWNERSHIP_ACQUISITION_PROOF = "atomically acquires one credential and the complete fixed resource set with response-loss replay";
const OWNERSHIP_MUTATION_PROOF = "rejects stale versions and forged resource truth while replaying the sealed committed result";
const OWNERSHIP_WORKSPACE_PROOF = "provisions a detached attempt worktree and isolated index without changing dirty caller state";
const OWNERSHIP_RECOVERY_PROOF = "allows stale cleanup ownership only after expiry and exact immutable process-death evidence";
const PROCESS_LAUNCH_PROOF = "persists the launch before target exec, passes only explicit environment, and consumes authorization once";
const PROCESS_TERMINAL_PROOF = "persists a nonzero terminal outcome and contains every owned resource for cleanup";
const COMMIT_PREPARE_PROOF = "records an immutable commit intent before Git mutation and exactly replays the prepare boundary";
const COMMIT_FINALIZE_PROOF = "finalizes exact attribution after the ref CAS and exactly replays response loss";

type PointProjection = readonly [
  boundary: string,
  contractTransaction: string | null,
  implementationOperation: string | null,
  proofLevel: FaultPoint["proof_level"],
  semanticSuite: string,
  semanticProofId: string,
  deferredTicket: string | null,
];

const REQUIRED_POINT_PROJECTIONS: Readonly<Record<(typeof REQUIRED_POINT_IDS)[number], PointProjection>> = {
  open_and_migrate: ["state_open", "open_and_migrate", "open_and_migrate", "semantic_suite", STATE_STORE_SUITE, STORE_OPEN_PROOF, null],
  run_creation: ["run_creation", "allocate_run", "allocate_fresh_run", "semantic_suite", IDENTITY_SUITE, RUN_ALLOCATION_PROOF, null],
  contract_insert: ["contract_insert", "allocate_run", "allocate_fresh_run", "semantic_suite", IDENTITY_SUITE, RUN_ALLOCATION_PROOF, null],
  initial_attempt_allocation: ["attempt_allocation", "allocate_attempt", "allocate_initial_attempt", "semantic_suite", IDENTITY_SUITE, ATTEMPT_ALLOCATION_PROOF, null],
  resume_selection: ["resume_selection", null, "select_compatible_resume", "semantic_suite", IDENTITY_SUITE, RESUME_SELECTION_PROOF, null],
  retry_selection: ["retry_selection", null, "select_compatible_retry", "semantic_suite", IDENTITY_SUITE, ATTEMPT_ALLOCATION_PROOF, null],
  retry_attempt_allocation: ["retry_identity", "allocate_attempt", "allocate_retry_attempt", "direct_retry_crash", IDENTITY_SUITE, RETRY_RACE_PROOF, null],
  execution_context_insert: ["phase_context", null, "persist_durable_execution_context", "semantic_suite", IDENTITY_SUITE, CONTEXT_PROOF, null],
  immutable_evidence_insert: ["common_transaction_wrapper", "append_evidence", "append_idempotent", "common_wrapper_crash", STATE_STORE_SUITE, EVIDENCE_PROOF, null],
  lease_acquisition: ["lease_row", "acquire_lease", "attempt_ownership_acquire", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_ACQUISITION_PROOF, null],
  ownership_assertion: ["ownership_read", null, "attempt_ownership_assert_current", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_MUTATION_PROOF, null],
  lease_heartbeat: ["lease_row", "heartbeat_lease", "attempt_ownership_heartbeat", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_MUTATION_PROOF, null],
  lease_cleanup_begin: ["lease_row", "begin_lease_cleanup", "attempt_ownership_begin_cleanup", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_MUTATION_PROOF, null],
  lease_release: ["lease_row", "release_lease", null, "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_MUTATION_PROOF, "t21"],
  resource_reservation: ["resource_row", "reserve_resource", "attempt_ownership_acquire", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_ACQUISITION_PROOF, null],
  resource_activation: ["resource_row", "advance_resource", "attempt_ownership_advance_resource", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_WORKSPACE_PROOF, null],
  resource_quarantine: ["resource_row", "quarantine_resource", null, "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_MUTATION_PROOF, "t21"],
  resource_release: ["resource_row", "release_resource", null, "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_MUTATION_PROOF, "t21"],
  stale_ownership_recovery: ["ownership_recovery", null, "attempt_ownership_stale_recovery", "semantic_suite", ATTEMPT_OWNERSHIP_SUITE, OWNERSHIP_RECOVERY_PROOF, null],
  phase_start: ["phase_transition", "transition_entity_cas", "transition_entity_cas", "semantic_suite", TRANSITION_SUITE, PHASE_PROOF, null],
  phase_finish: ["phase_transition", "transition_entity_cas", "transition_entity_cas", "semantic_suite", TRANSITION_SUITE, PHASE_PROOF, null],
  process_launch: ["process_launch_rows", "process_supervisor_launch", "process_supervisor_launch", "semantic_suite", PROCESS_SUPERVISOR_SUITE, PROCESS_LAUNCH_PROOF, null],
  process_terminal: ["process_terminal_rows", "process_supervisor_terminal", "process_supervisor_terminal", "semantic_suite", PROCESS_SUPERVISOR_SUITE, PROCESS_TERMINAL_PROOF, null],
  review_record: ["review_row", null, "persist_review_record", "semantic_suite", TRANSITION_SUITE, LIFECYCLE_RECORD_PROOF, null],
  remediation_record: ["remediation_row", null, "persist_remediation_record", "semantic_suite", TRANSITION_SUITE, LIFECYCLE_RECORD_PROOF, null],
  required_gate_result: ["ticket_contract_gate_row", null, "persist_gate_result", "semantic_suite", TRANSITION_SUITE, LIFECYCLE_RECORD_PROOF, null],
  commit_attribution_prepare: ["commit_intent_row", "commit_attribution_prepare", "commit_attribution_prepare", "semantic_suite", GIT_ATTRIBUTION_SUITE, COMMIT_PREPARE_PROOF, null],
  commit_attribution: ["commit_attribution_row", "commit_attribution_finalize", "commit_attribution_finalize", "semantic_suite", GIT_ATTRIBUTION_SUITE, COMMIT_FINALIZE_PROOF, null],
  cleanup_record: ["cleanup_row", null, "persist_cleanup_record", "semantic_suite", TRANSITION_SUITE, LIFECYCLE_RECORD_PROOF, "t21"],
  oracle_decision: ["oracle_rows", "persist_oracle_decision", "persist_oracle_decision", "semantic_suite", ORACLE_SUITE, ORACLE_REFERENCE_PROOF, null],
  promotion_intent: ["promotion_rows", "create_promotion_intent", "create_promotion_intent", "semantic_suite", TRANSITION_SUITE, PROMOTION_PROOF, null],
  promotion_observation: ["promotion_rows", "observe_promotion", "observe_promotion", "semantic_suite", TRANSITION_SUITE, PROMOTION_PROOF, null],
  promotion_finalization: ["promotion_rows", "finalize_promotion", "finalize_promotion", "semantic_suite", TRANSITION_SUITE, PROMOTION_PROOF, null],
  delivery_intent: ["delivery_rows", "create_delivery_intent", "create_delivery_intent", "semantic_suite", TRANSITION_SUITE, DELIVERY_PROOF, "t29"],
  remote_observation: ["delivery_rows", "append_remote_observation", "append_remote_observation", "semantic_suite", TRANSITION_SUITE, DELIVERY_PROOF, "t29"],
  pr_observation: ["delivery_rows", "append_pr_observation", "append_pr_observation", "semantic_suite", TRANSITION_SUITE, DELIVERY_PROOF, "t29"],
  terminal_commit_delivered: ["delivery_terminal_rows", "finalize_delivery", "finalize_delivery", "semantic_suite", TRANSITION_SUITE, DELIVERY_PROOF, "t29"],
  terminal_commit_failed: ["delivery_terminal_rows", "finalize_delivery", "finalize_delivery", "semantic_suite", TRANSITION_SUITE, DELIVERY_PROOF, "t29"],
  legacy_inventory: ["legacy_inventory_rows", "inventory_legacy", "inventory_legacy", "semantic_suite", LEGACY_SUITE, LEGACY_PROOF, null],
  runner_run_activation: ["runner_activation", "transition_entity_cas", "activate_run_for_runner", "semantic_suite", "orchestrator/test/reliability/attempt-critical-section.test.ts", "the AttemptRunner is the sole production owner exported from attempt-runner.ts", null],
  runner_ticket_activation: ["runner_activation", "transition_entity_cas", "activate_ticket_for_runner", "semantic_suite", "orchestrator/test/reliability/attempt-critical-section.test.ts", "the AttemptRunner is the sole production owner exported from attempt-runner.ts", null],
  attempt_cleanup_pending_transition: ["attempt_cleanup_transition", "transition_entity_cas", "advance_attempt_cleanup_pending", "semantic_suite", "orchestrator/test/reliability/lifecycle-transitions.test.ts", "declares every failure edge (any pre-cleanup state to cleanup_pending)", null],
  claims_quarantine_transition: ["claims_quarantine", "transition_entity_cas", "advance_claims_quarantined", "semantic_suite", "orchestrator/test/reliability/lifecycle-transitions.test.ts", "declares cleanup terminal edges", null],
  ticket_cleanup_pending_transition: ["ticket_cleanup_transition", "transition_entity_cas", "advance_ticket_cleanup_pending", "semantic_suite", "orchestrator/test/reliability/lifecycle-transitions.test.ts", "declares every failure edge (any pre-cleanup state to cleanup_pending)", null],
  target_proof_set_seal: ["target_proof_rows", "seal_target_proof_set", "create_and_seal_authority_target_proof_set", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "atomically persists the receipt, evidence, and gate transition in one transaction", null],
  target_start_gate_create: ["target_start_gate_rows", "create_target_start_gate", "create_held_target_start_gate", "semantic_suite", "orchestrator/test/reliability/containment-authority.test.ts", "exports the full interface surface (create/membership/release/kill/empty-death/receipts)", null],
  quarantine_ownership_finalize: ["quarantine_ownership_rows", "transition_entity_cas", "finalize_quarantine_ownership", "semantic_suite", "orchestrator/test/reliability/disposition-authority.test.ts", "rejects structural and prototype forgeries across all five proof types", null],
  cleanup_eligibility_mint: ["cleanup_eligibility_rows", "mint_cleanup_eligibility", "mint_cleanup_eligibility", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "atomically persists the receipt, evidence, and gate transition in one transaction", null],
  failure_cleanup_mint: ["failure_cleanup_rows", "mint_failure_cleanup", "mint_failure_cleanup", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "a failure-cleanup receipt cannot satisfy promotion finalization", null],
  promotion_cleanup_mint: ["promotion_cleanup_rows", "mint_promotion_cleanup", "mint_promotion_cleanup", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "a promotion-cleanup receipt cannot satisfy failure or quarantine finalization", null],
  quarantine_mint: ["quarantine_rows", "mint_quarantine", "mint_quarantine", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "a quarantine receipt cannot satisfy promotion or failure finalization", null],
  target_never_released_mint: ["target_never_released_rows", "mint_target_never_released", "mint_target_never_released", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "rejects a stale-generation receipt that does not bind the exact gate lineage", null],
  target_released_mint: ["target_released_rows", "mint_target_released", "mint_target_released", "semantic_suite", "orchestrator/test/reliability/containment-authority.test.ts", "exports the full interface surface (create/membership/release/kill/empty-death/receipts)", null],
  authority_claim_snapshot: ["authority_snapshot_rows", "persist_authority_claim_snapshot", "persist_authority_claim_snapshot", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "replays identical inputs to the identical immutable postimage", null],
  authority_commit_attribution: ["authority_attribution_rows", "commit_attribution_finalize", "persist_authority_commit_attribution", "semantic_suite", "orchestrator/test/reliability/git-attribution-corpus.test.ts", "finalizes exact attribution after the ref CAS and exactly replays response loss", null],
  authority_evidence: ["authority_evidence_rows", "append_evidence", "persist_authority_evidence", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "replays identical inputs to the identical immutable postimage", null],
  authority_ownership_snapshot: ["authority_ownership_rows", "persist_authority_ownership_snapshot", "persist_authority_ownership_snapshot", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "replays identical inputs to the identical immutable postimage", null],
  authority_process_chain: ["authority_process_chain_rows", "process_supervisor_terminal", "persist_authority_process_chain", "semantic_suite", "orchestrator/test/reliability/process-supervisor-corpus.test.ts", "persists a nonzero terminal outcome and contains every owned resource for cleanup", null],
  authority_salvage_record: ["authority_salvage_rows", null, "persist_authority_salvage_record", "semantic_suite", "orchestrator/test/reliability/disposition-store-bridge.test.ts", "replays identical inputs to the identical immutable postimage", "t21"],
  orphaned_planned_cleanup: ["orphaned_cleanup_rows", "recover_orphaned_planned_attempt", "recover_orphaned_planned_attempt", "semantic_suite", "orchestrator/test/reliability/recovery-parity.test.ts", "recovers the orphaned planned attempt as a typed no-side-effect cleanup image", null],
};

afterEach(async () => {
  const exits: Array<Promise<unknown>> = [];
  for (const managed of managedChildren) {
    if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill("SIGKILL");
    exits.push(managed.exit);
  }
  await Promise.allSettled(exits.map((exit) => within(exit, 5_000, "child reap")));
  managedChildren.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function makeRepo(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rickgent-crash-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "State Crash Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "state-crash@example.test"]);
  writeFileSync(join(repo, "README.md"), `${label}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function writeInput(repo: string, label: string, input: unknown): string {
  const path = join(repo, ".git", `crash-${label}.json`);
  writeFileSync(path, `${JSON.stringify(input)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function openRaw(databasePath: string, readOnly = true): DatabaseSync {
  return new DatabaseSync(databasePath, { readOnly, enableForeignKeyConstraints: true, timeout: 1_000 });
}

function rows(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function row(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow | undefined {
  return rows(databasePath, sql, ...values)[0];
}

function mutate(databasePath: string, sql: string, ...values: SqlValue[]): void {
  const database = openRaw(databasePath, false);
  try {
    expect(database.prepare(sql).run(...values).changes).toBe(1);
  } finally {
    database.close();
  }
}

function dispatchEvent(managed: ManagedChild, event: ChildEvent): void {
  const index = managed.waiters.findIndex((waiter) => waiter.predicate(event));
  if (index === -1) {
    managed.events.push(event);
    return;
  }
  const [waiter] = managed.waiters.splice(index, 1);
  clearTimeout(waiter!.timer);
  waiter!.resolve(event);
}

function rejectWaiters(managed: ManagedChild, error: Error): void {
  for (const waiter of managed.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function waitEvent(managed: ManagedChild, predicate: (event: ChildEvent) => boolean, label: string): Promise<ChildEvent> {
  const queued = managed.events.findIndex(predicate);
  if (queued !== -1) return Promise.resolve(managed.events.splice(queued, 1)[0]!);
  return new Promise((resolve, reject) => {
    const waiter: EventWaiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = managed.waiters.indexOf(waiter);
        if (index !== -1) managed.waiters.splice(index, 1);
        reject(new Error(`child timed out waiting for ${label}; stderr=${managed.stderr}`));
      }, 10_000),
    };
    managed.waiters.push(waiter);
  });
}

function spawnManaged(command: "probe" | "retry", repo: string, inputPath: string, side: CrashSide | "none"): ManagedChild {
  const child = fork(childFixture, [command, repo, inputPath, side], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let exitResolve!: (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => { exitResolve = resolve; });
  const managed: ManagedChild = { child, events: [], waiters: [], exit, stderr: "", stdoutRemainder: "" };
  let exitSettled = false;
  const settleExit = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void => {
    if (exitSettled) return;
    exitSettled = true;
    managedChildren.delete(managed);
    exitResolve(result);
  };
  managedChildren.add(managed);
  child.on("message", (value) => dispatchEvent(managed, { channel: "ipc", value: value as IpcMessage }));
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    managed.stdoutRemainder += chunk;
    for (;;) {
      const newline = managed.stdoutRemainder.indexOf("\n");
      if (newline === -1) break;
      const line = managed.stdoutRemainder.slice(0, newline);
      managed.stdoutRemainder = managed.stdoutRemainder.slice(newline + 1);
      if (line !== "") {
        try {
          dispatchEvent(managed, { channel: "checkpoint", value: JSON.parse(line) as CheckpointFrame });
        } catch (cause) {
          const error = new Error(`invalid child checkpoint frame: ${line}; stderr=${managed.stderr}`, { cause });
          rejectWaiters(managed, error);
          managed.child.kill("SIGKILL");
        }
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { managed.stderr = `${managed.stderr}${chunk}`.slice(-16_384); });
  child.once("error", (cause) => {
    const error = new Error(`child process error: ${cause.message}; stderr=${managed.stderr}`, { cause });
    rejectWaiters(managed, error);
    settleExit({ code: null, signal: null, error });
  });
  child.once("exit", (code, signal) => {
    const error = new Error(`child exited: code=${String(code)} signal=${String(signal)} stderr=${managed.stderr}`);
    rejectWaiters(managed, error);
    settleExit({ code, signal });
  });
  return managed;
}

async function ready(managed: ManagedChild): Promise<void> {
  const event = await waitEvent(managed, (candidate) => candidate.channel === "ipc" && candidate.value.type === "ready", "ready");
  expect(event.value.type).toBe("ready");
}

async function crashAt(
  command: "probe" | "retry",
  repo: string,
  inputPath: string,
  side: CrashSide,
): Promise<void> {
  const managed = spawnManaged(command, repo, inputPath, side);
  await ready(managed);
  managed.child.send("proceed");
  const event = await waitEvent(
    managed,
    (candidate) => candidate.channel === "checkpoint" && candidate.value.type === "checkpoint",
    side,
  );
  expect(event.value).toEqual({ type: "checkpoint", checkpoint: side, operation: command });
  expect(managed.child.kill("SIGKILL")).toBe(true);
  expect(await managed.exit).toEqual({ code: null, signal: "SIGKILL" });
}

async function finish(managed: ManagedChild): Promise<IpcMessage> {
  const event = await waitEvent(
    managed,
    (candidate) => candidate.channel === "ipc" && (candidate.value.type === "result" || candidate.value.type === "error"),
    "result|error",
  );
  const outcome = event.value as IpcMessage;
  const exited = await managed.exit;
  expect(exited.signal).toBeNull();
  if (outcome.type === "result") expect(exited.code).toBe(0);
  else expect(exited.code).not.toBe(0);
  return outcome;
}

async function runToCompletion(command: "probe" | "retry", repo: string, inputPath: string): Promise<IpcMessage> {
  const managed = spawnManaged(command, repo, inputPath, "none");
  await ready(managed);
  managed.child.send("proceed");
  return finish(managed);
}

function reopen(repo: string): string {
  const store = openStateStore({ repoPath: repo });
  try {
    store.verifyIntegrity();
    return store.location.databasePath;
  } finally {
    store.close();
  }
}

function evidenceRows(databasePath: string): SqlRow[] {
  return rows(databasePath, "SELECT * FROM evidence ORDER BY evidence_id");
}

function marker(side: CrashSide, attemptId: string, contextId: string): SqlRow {
  const payload = canonicalJson({ crash_side: side, proof: "common_sqlite_commit_boundary" });
  return {
    evidence_id: `crash-${digest(side).slice("sha256:".length)}`,
    attempt_id: attemptId,
    phase_execution_id: null,
    context_id: contextId,
    producer_service: "StateCrashCorpus",
    scope: "common-transaction-wrapper",
    schema_version: "rickgent.state-crash-marker.v2",
    content_digest: digest(payload),
    inline_payload_json: payload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: side,
    created_at: "2026-07-16T12:00:00.000Z",
  };
}

function expectPriorEvidenceUnchanged(before: readonly SqlRow[], after: readonly SqlRow[]): void {
  const byId = new Map(after.map((value) => [String(value.evidence_id), value]));
  for (const prior of before) expect(byId.get(String(prior.evidence_id))).toEqual(prior);
}

function expectNoManufacturedTerminal(databasePath: string): void {
  expect(row(databasePath, `
    SELECT
      (SELECT COUNT(*) FROM attempts WHERE state IN ('failed_clean','quarantined','verified')) AS attempts,
      (SELECT COUNT(*) FROM run_tickets WHERE state IN ('failed','quarantined','ready_for_delivery')) AS tickets,
      (SELECT COUNT(*) FROM runs WHERE state IN ('failed','delivery_failed','delivered')) AS runs,
      (SELECT COUNT(*) FROM delivery_records) AS delivery_records
  `)).toEqual({ attempts: 0, tickets: 0, runs: 0, delivery_records: 0 });
}

function contractDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t17",
    title: "Crash recovery",
    description: "Prove transaction restart and retry identity without enabling public resume.",
    depends_on: [],
    scope: [{ path: "src/t17.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-CRASH",
      description: "Retry allocates a new identity before side effects.",
      interface_ids: [],
      verification_ids: ["VER-CRASH"],
    }],
    verifications: [{
      id: "VER-CRASH",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 3, max_review_cycles: 1, wall_clock_ms: 120_000, remediation_limit: 0 },
  };
}

function contractJson(contract: TicketContract): string {
  const unsigned = { ...contract } as Record<string, unknown>;
  delete unsigned.digest;
  return canonicalJson(unsigned);
}

function freshRunInput(location: StateLocation, contract: TicketContract): AllocateFreshRunInput {
  const capabilitySnapshot = compiledCapabilitySnapshot();
  const manifestValue = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    repository_id: location.repositoryId,
    repo_realpath: location.repoRealpath,
    git_common_dir_realpath: location.gitCommonDirRealpath,
    object_format: location.objectFormat,
    context_schema_version: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
    oracle_version: "rickgent.oracle.v2",
    resource_identity_version: RESOURCE_IDENTITY_VERSION,
    capability_snapshot: JSON.parse(capabilitySnapshot.canonicalJson) as Record<string, unknown>,
    capability_snapshot_digest: capabilitySnapshot.digest,
    capability_snapshot_schema_version: capabilitySnapshot.schemaVersion,
    tickets: [{ contract_digest: contract.digest, depends_on_ticket_ids: [], plan_index: 0, ticket_id: contract.id }],
  };
  const canonicalManifest = canonicalJson(manifestValue);
  const canonicalContract = contractJson(contract);
  return {
    manifest: {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      canonicalJson: canonicalManifest,
      digest: digest(canonicalManifest),
      capabilitySnapshot,
      contextSchemaVersion: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
      oracleVersion: "rickgent.oracle.v2",
      resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
    },
    tickets: [{
      ticketId: contract.id,
      planIndex: 0,
      contract: { schemaVersion: contract.schema_version, canonicalJson: canonicalContract, digest: contract.digest as `sha256:${string}` },
      dependsOnTicketIds: [],
    }],
    initialDeliveryOid: execFileSync("git", ["-C", location.repoRealpath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

function seedEvidenceContext(store: StateStore, attempt: AllocatedAttempt): string {
  const contextId = `context-crash-${digest(attempt.attemptId).slice("sha256:".length)}`;
  const contextJson = canonicalJson({ fixture: "state-crash-corpus", owner: attempt.attemptId });
  const database = openRaw(store.location.databasePath, false);
  try {
    database.prepare(`
      INSERT INTO execution_contexts (
        context_id, context_digest, attempt_id, phase, phase_ordinal, role, canonical_context_json,
        contract_digest, capability_snapshot_digest, policy_bundle_digest, model_selection_digest,
        budget_digest, scope_digest, context_schema_version, oracle_version, created_at
      ) VALUES (?, ?, ?, 'recovery_probe', 0, 'state_crash_corpus', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contextId,
      digest(contextJson),
      attempt.attemptId,
      contextJson,
      attempt.contractDigest,
      attempt.capabilitySnapshotDigest,
      digest("crash-policy"),
      digest("crash-model"),
      digest("crash-budget"),
      digest("crash-scope"),
      attempt.contextSchemaVersion,
      attempt.oracleVersion,
      "2026-07-16T12:00:00.000Z",
    );
  } finally {
    database.close();
  }
  return contextId;
}

function newLineage(repo: string): { store: StateStore; run: AllocatedRun; attempt: AllocatedAttempt; contextId: string } {
  const contract = sealTicketContracts([contractDraft()], { repositoryRoot: repo })[0]!;
  const store = openStateStore({ repoPath: repo });
  const run = store.allocateFreshRun(freshRunInput(store.location, contract));
  const attempt = store.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
  const contextId = seedEvidenceContext(store, attempt);
  return { store, run, attempt, contextId };
}

function advanceRetryPrecondition(databasePath: string, run: AllocatedRun, attempt: AllocatedAttempt): void {
  mutate(databasePath, "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ?", run.runId);
  for (const state of ["active", "cleanup_pending"]) {
    mutate(databasePath, "UPDATE run_tickets SET state = ?, state_version = state_version + 1 WHERE ticket_instance_id = ?", state, attempt.ticketInstanceId);
  }
  for (const state of ["implementing", "implementation_captured", "reviewing", "verification_queued", "verifying", "converging", "cleanup_pending", "failed_clean"]) {
    mutate(databasePath, "UPDATE attempts SET state = ?, state_version = state_version + 1 WHERE attempt_id = ?", state, attempt.attemptId);
  }
}

function retryInput(attempt: AllocatedAttempt): RetryCompatibilityInput {
  return {
    runId: attempt.runId,
    ticketId: attempt.ticketId,
    contractDigest: attempt.contractDigest,
    contextSchemaVersion: attempt.contextSchemaVersion,
    oracleVersion: attempt.oracleVersion,
    capabilitySnapshotDigest: attempt.capabilitySnapshotDigest,
    resourceIdentityVersion: attempt.resourceIdentityVersion,
  };
}

function makeRetryFixture(label: string): RetryFixture {
  const repo = makeRepo(label);
  const { store, run, attempt: initial } = newLineage(repo);
  try {
    advanceRetryPrecondition(store.location.databasePath, run, initial);
    const initialRow = row(store.location.databasePath, "SELECT * FROM attempts WHERE attempt_id = ?", initial.attemptId)!;
    return {
      repo,
      inputPath: writeInput(repo, `${label}-retry`, retryInput(initial)),
      databasePath: store.location.databasePath,
      initial,
      initialRow,
      resume: {
        runId: run.runId,
        manifestDigest: run.manifestDigest,
        contextSchemaVersion: initial.contextSchemaVersion,
        oracleVersion: initial.oracleVersion,
        capabilitySnapshotDigest: initial.capabilitySnapshotDigest,
        resourceIdentityVersion: initial.resourceIdentityVersion,
        tickets: [{ ticketId: initial.ticketId, contractDigest: initial.contractDigest }],
      },
    };
  } finally {
    store.close();
  }
}

function attempts(databasePath: string): SqlRow[] {
  return rows(databasePath, "SELECT * FROM attempts ORDER BY attempt_number");
}

function expectRecoveredRetry(fixture: RetryFixture): SqlRow {
  const recovered = attempts(fixture.databasePath);
  expect(recovered).toHaveLength(2);
  expect(recovered[0]).toEqual(fixture.initialRow);
  expect(recovered.map((value) => value.attempt_number)).toEqual([1, 2]);
  const second = recovered[1]!;
  expect(second).toMatchObject({ state: "planned", state_version: 0 });
  expect(second.attempt_id).not.toBe(fixture.initial.attemptId);
  expect(second.allocation_owner_digest).not.toBe(fixture.initial.allocationOwnerDigest);
  expect(row(fixture.databasePath, `
    SELECT
      (SELECT COUNT(*) FROM execution_contexts WHERE attempt_id = ?) AS contexts,
      (SELECT COUNT(*) FROM leases WHERE attempt_id = ?) AS leases,
      (SELECT COUNT(*) FROM attempt_resources WHERE attempt_id = ?) AS resources,
      (SELECT COUNT(*) FROM process_receipts p JOIN phase_executions x ON x.phase_execution_id = p.phase_execution_id WHERE x.attempt_id = ?) AS receipts
  `, second.attempt_id!, second.attempt_id!, second.attempt_id!, second.attempt_id!))
    .toEqual({ contexts: 0, leases: 0, resources: 0, receipts: 0 });
  const store = openStateStore({ repoPath: fixture.repo });
  try {
    store.verifyIntegrity();
    const selection = store.selectCompatibleResume(fixture.resume);
    expect(selection.tickets[0]?.latestAttempt?.attemptId).toBe(second.attempt_id);
    expect(selection.tickets[0]?.latestAttempt?.state).toBe("planned");
  } finally {
    store.close();
  }
  return second;
}

describe("bounded state crash and retry proof", () => {
  it("requires the canonical transaction inventory, proof levels, deferrals, and semantic suites", () => {
    expect(manifest.schema_version).toBe("rickgent.state-crash-manifest.v2");
    expect(inventory.schema_version).toBe("rickgent.state-crash-inventory.v2");
    expect(manifest.corpus_id).toBe("t17-state-crash-v1");
    expect(inventory.corpus_id).toBe(manifest.corpus_id);
    expect(manifest.complete).toBe(true);
    expect(manifest.proof_scope).toBe("common_sqlite_commit_boundary_and_internal_retry_identity");
    expect(manifest.inventory_kind).toBe("transaction_projection_not_operation_specific_crash_case");
    expect(manifest.fault_sides).toEqual(["before_commit", "after_commit_before_return"]);
    expect(manifest.fault_points).toEqual(REQUIRED_POINT_IDS);
    expect(inventory.points.map((point) => point.id)).toEqual(REQUIRED_POINT_IDS);
    expect(sortedUnique(manifest.assertions)).toEqual(sortedUnique(REQUIRED_ASSERTIONS));
    expect(manifest.direct_crash_points).toEqual(["immutable_evidence_insert", "retry_attempt_allocation"]);
    expect(new Set(inventory.points.map((point) => point.id)).size).toBe(REQUIRED_POINT_IDS.length);

    const projections = Object.fromEntries(inventory.points.map((point) => [point.id, [
      point.boundary,
      point.contract_transaction,
      point.implementation_operation,
      point.proof_level,
      point.semantic_proof,
      point.semantic_proof_id,
      point.deferred_ticket ?? null,
    ]])) as Record<string, PointProjection>;
    expect(projections).toEqual(REQUIRED_POINT_PROJECTIONS);

    expect(sortedUnique(inventory.points.flatMap((point) =>
      point.contract_transaction === null ? [] : [point.contract_transaction]
    )))
      .toEqual(sortedUnique(STATE_TRANSACTION_NAMES));
    const source = readFileSync(storeSourcePath, "utf8");
    const literalOperations = [...source.matchAll(/#immediate\("([^"]+)"/g)].map((match) => match[1]!);
    const requiredOperations = sortedUnique([...literalOperations, ...DYNAMIC_IMPLEMENTATION_OPERATIONS]);
    expect(sortedUnique(inventory.points.flatMap((point) =>
      point.implementation_operation === null ? [] : [point.implementation_operation]
    ))).toEqual(requiredOperations);
    expect(source.match(/db\.exec\("BEGIN IMMEDIATE"\)/g)).toHaveLength(1);

    const proofSuites = sortedUnique(inventory.points.map((point) => point.semantic_proof));
    expect(sortedUnique(manifest.semantic_proof_suites)).toEqual(proofSuites);
    const proofSources = new Map<string, string>();
    for (const suite of proofSuites) {
      const path = join(workspaceRoot, suite);
      expect(existsSync(path)).toBe(true);
      proofSources.set(suite, readFileSync(path, "utf8"));
    }
    for (const point of inventory.points) {
      expect(point.id).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(point.crash_parity_ticket).toBe("t29");
      expect(proofSources.get(point.semantic_proof)).toContain(`it("${point.semantic_proof_id}"`);
    }
    expect(manifest.deferred_recovery).toEqual({
      operational_lease_and_resource_ownership: "t18",
      process_group_spawn_and_death: "t29_complete",
      external_git_commit_recovery: "t29_complete",
      salvage_and_cleanup_side_effects: "t21",
      operation_specific_recovery_and_oracle_parity: "t29_complete",
    });
    expect(manifest.public_capability).toEqual({ resume_retry: "enabled", reconciliation: "enabled" });
    expect(getCapability("resume_retry").state).toBe("enabled");
    expect(getCapability("reconciliation").state).toBe("enabled");
  });

  it("proves old/new WAL visibility at the real pre-COMMIT and post-COMMIT/pre-return checkpoints", async () => {
    const repo = makeRepo("wrapper");
    const { store, attempt, contextId } = newLineage(repo);
    const databasePath = store.location.databasePath;
    const sentinel = marker("before_commit", attempt.attemptId, contextId);
    sentinel.evidence_id = "crash-sentinel";
    sentinel.scope = "immutable-prior-evidence";
    sentinel.idempotency_key = "sentinel";
    store.appendEvidence(sentinel);
    store.close();

    for (const side of manifest.fault_sides) {
      const before = evidenceRows(databasePath);
      const input = marker(side, attempt.attemptId, contextId);
      const inputPath = writeInput(repo, `wrapper-${side}`, input);
      await crashAt("probe", repo, inputPath, side);
      expect(reopen(repo)).toBe(databasePath);
      const afterCrash = evidenceRows(databasePath);
      expectPriorEvidenceUnchanged(before, afterCrash);
      expect(afterCrash.filter((value) => value.evidence_id === input.evidence_id))
        .toHaveLength(side === "before_commit" ? 0 : 1);
      expectNoManufacturedTerminal(databasePath);

      expect(await runToCompletion("probe", repo, inputPath)).toMatchObject({ type: "result" });
      expect(reopen(repo)).toBe(databasePath);
      const afterReplay = evidenceRows(databasePath);
      expectPriorEvidenceUnchanged(before, afterReplay);
      expect(afterReplay.filter((value) => value.evidence_id === input.evidence_id)).toHaveLength(1);
      expectNoManufacturedTerminal(databasePath);
    }
  }, 30_000);

  it("proves retry identity at both commit checkpoints without manufacturing downstream side effects", async () => {
    for (const side of manifest.fault_sides) {
      const fixture = makeRetryFixture(`retry-${side}`);
      await crashAt("retry", fixture.repo, fixture.inputPath, side);
      expect(reopen(fixture.repo)).toBe(fixture.databasePath);
      expect(row(fixture.databasePath, "SELECT state FROM run_tickets WHERE ticket_instance_id = ?", fixture.initial.ticketInstanceId))
        .toEqual({ state: "cleanup_pending" });

      if (side === "before_commit") {
        expect(attempts(fixture.databasePath)).toEqual([fixture.initialRow]);
        expect(await runToCompletion("retry", fixture.repo, fixture.inputPath)).toMatchObject({ type: "result" });
      } else {
        expectRecoveredRetry(fixture);
        expect(await runToCompletion("retry", fixture.repo, fixture.inputPath))
          .toMatchObject({ type: "error", code: "RICKGENT_STATE_TRANSITION_ILLEGAL" });
      }
      expectRecoveredRetry(fixture);
      expect(attempts(fixture.databasePath)).toHaveLength(2);
    }
  }, 30_000);

  it("starts concurrent retry allocators from one barrier and accepts one typed winner only", async () => {
    const fixture = makeRetryFixture("retry-race");
    const left = spawnManaged("retry", fixture.repo, fixture.inputPath, "none");
    const right = spawnManaged("retry", fixture.repo, fixture.inputPath, "none");
    await Promise.all([ready(left), ready(right)]);
    left.child.send("proceed");
    right.child.send("proceed");
    const outcomes = await Promise.all([finish(left), finish(right)]);
    expect(outcomes.filter((outcome) => outcome.type === "result")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.code === "RICKGENT_STATE_TRANSITION_ILLEGAL")).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.code === "RICKGENT_STATE_BUSY")).toBe(false);
    expectRecoveredRetry(fixture);
  }, 30_000);

  it("binds the checked summary to this exact corpus instead of trusting a free-standing certificate", () => {
    expect(summary).toMatchObject({
      schema_version: "rickgent.state-crash-summary.v2",
      corpus_id: manifest.corpus_id,
      status: "complete",
      manifest_digest: digest(manifestBytes),
      fault_points_digest: digest(inventoryBytes),
      inventory_point_count: REQUIRED_POINT_IDS.length,
      common_wrapper_crash_cases: manifest.fault_sides.length,
      direct_retry_crash_cases: manifest.fault_sides.length,
      synchronized_retry_races: 1,
      proof_scope: manifest.proof_scope,
      deferred_full_recovery_ticket: "t29",
      harness_digest: digest(childFixtureBytes),
      test_digest: digest(testSourceBytes),
    });
    expect(sortedUnique(summary.assertions)).toEqual(sortedUnique(REQUIRED_ASSERTIONS));
    expect(summary.proof_corpus).toEqual([
      "orchestrator/test/fixtures/crash-matrix/manifest.json",
      "orchestrator/test/fixtures/crash-matrix/fault-points.json",
      "orchestrator/test/fixtures/crash-matrix/child.mjs",
      "orchestrator/test/reliability/state-crash-corpus.test.ts",
    ]);
  });
});
