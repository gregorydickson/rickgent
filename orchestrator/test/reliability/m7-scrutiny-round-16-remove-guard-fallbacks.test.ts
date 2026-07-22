//
// M7 scrutiny round 16 — commitAttemptEdge must NOT derive any guard
// operands from request.guard.  All guard operands (contextId,
// gateResultIds, commitAttributionId) must come from the dedicated request
// fields ONLY.  The request.guard field is completely ignored for operand
// derivation.
//
// Round 15 fixed the guard KIND and expectedRole derivation (both come from
// the PHASE_TRANSITION_TABLE edge definition, not the caller).  But the
// guard's DATA FIELDS (contextId, gateResultIds, commitAttributionId) are
// still extracted from request.guard as a FALLBACK when the dedicated
// request fields are not provided.  This means a caller can still select
// the execution context, gate result IDs, or commit attribution by
// providing them inside request.guard (without providing the dedicated
// fields), contrary to the full no-caller-influence guard contract.
//
// Fix: remove ALL request.guard fallbacks in #deriveEdgeGuard.  The
// dedicated request fields (contextId, gateResultIds, commitAttributionId)
// are the SOLE source for guard operands.  request.guard is completely
// ignored for operand derivation.
//
// This test calls commitAttemptEdge DIRECTLY (not through the
// LifecycleEngine).
//
// Three behavioral negative tests:
//   (a) Provide a request.guard with a valid contextId and NO dedicated
//       contextId field.  The transition MUST THROW because the dedicated
//       contextId field is the sole source and it is missing.  Against the
//       unfixed code, the fallback extracts contextId from the guard and
//       the transition SUCCEEDS — the test expects a throw but gets none
//       (RED).  After the fix, the missing dedicated field causes a
//       fail-closed throw (GREEN).
//
//   (b) Provide a request.guard with valid gateResultIds and NO dedicated
//       gateResultIds field.  The transition MUST THROW because the
//       dedicated gateResultIds field is the sole source and it is
//       missing.  Against the unfixed code, the fallback extracts
//       gateResultIds from the guard and the transition SUCCEEDS — the
//       test expects a throw but gets none (RED).  After the fix, the
//       missing dedicated field causes a fail-closed throw (GREEN).
//
//   (c) Provide a request.guard with a FAKE commitAttributionId and NO
//       dedicated commitAttributionId field, but provide evidence with
//       purpose "failure" (the no-attribution cleanup path).  The
//       transition MUST SUCCEED because the guard's fake
//       commitAttributionId is IGNORED and the no-attribution path is
//       used.  Against the unfixed code, the fallback extracts the FAKE
//       commitAttributionId from the guard, the store looks it up, fails
//       to find it, and the transition THROWS — the test expects success
//       but gets a throw (RED).  After the fix, the guard's fake
//       commitAttributionId is ignored, commitAttributionId is undefined,
//       the store uses the "failure" evidence path, and the transition
//       SUCCEEDS (GREEN).
//

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sealTicketContracts, type TicketContract, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../src/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../src/context/attempt-execution-context.js";
import {
  TransitionAuthority,
  LifecycleRecordAuthority,
  type GateResultRecordRequest,
  type ExistingTransitionEvidenceReference,
  type InlineTransitionEvidenceReference,
} from "../../src/state/transitions.js";
import {
  canonicalGitDeltaFromRaw,
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
  type StateRowInput,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";
import { LeaseAuthority } from "../../src/state/leases.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const ORACLE_VERSION = "rickgent.oracle.v2";
const scratchRoots = new Set<string>();
const stores = new Set<StateStore>();

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* best effort */ }
  }
  stores.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function makeRepo(label = "m7r16"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r16-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R16 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r16@example.test"]);
  writeFileSync(join(repo, "README.md"), `${label}\n`, "utf8");
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
    id: "t85",
    title: "M7 round 16 test",
    description: "Prove commitAttemptEdge ignores request.guard for ALL guard operands.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R16",
      description: "commitAttemptEdge derives ALL guard operands from dedicated request fields, not request.guard.",
      interface_ids: [],
      verification_ids: ["VER-M7R16"],
    }],
    verifications: [{
      id: "VER-M7R16",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 3, max_review_cycles: 3, wall_clock_ms: 120_000, remediation_limit: 2 },
  };
}

// ---------------------------------------------------------------------------
// Fixture: real authority API setup
// ---------------------------------------------------------------------------

interface RealAuthorityFixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly ownership: ReturnType<typeof provisionAttemptWorkspace> extends { readonly workspace?: infer W } ? W extends { readonly ownership: infer O } ? O : never : never;
  readonly executionContext: AttemptExecutionContextAuthority;
  readonly records: LifecycleRecordAuthority;
}

function buildRealAuthorityFixture(label = "real-authority-r16"): RealAuthorityFixture {
  const repo = makeRepo(label);
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const sealedContract = sealTicketContracts([draft()], { repositoryRoot: repo })[0]!;
  const resolver = new IdentityContextResolver(store);
  const baselineOid = git(repo, "rev-parse", "HEAD");
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: baselineOid,
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });

  store.activateRunForRunner(run.runId, attempt.attemptId, `activate-run:${run.runId}`);
  store.activateTicketForRunner(attempt.ticketInstanceId, attempt.attemptId, `activate-ticket:${attempt.ticketInstanceId}`);

  const leases = new LeaseAuthority(store);
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: attempt.attemptId,
    idempotencyKey: `acquire:${label}`,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  const ownership = provisioned.workspace.ownership;

  mkdirSync(ownership.plan.policyBundlePath, { recursive: true, mode: 0o700 });

  return {
    repo, store, leases, contract: sealedContract, run, attempt,
    ownership,
    executionContext: new AttemptExecutionContextAuthority(store),
    records: new LifecycleRecordAuthority(store),
  };
}

// Walk an attempt to the specified state via the store CAS path (no
// authority) so we can test edges in isolation through the generic
// commitAttemptEdge API.
function walkAttemptTo(store: StateStore, attemptId: string, toState: string): number {
  // Two paths through the lifecycle:
  //   Path A (review reject): planned -> implementing -> implementation_captured
  //     -> reviewing -> remediating -> remediation_captured
  //   Path B (review accept): planned -> implementing -> implementation_captured
  //     -> reviewing -> verification_queued -> verifying -> converging
  const pathA: ReadonlyArray<readonly [string, string]> = [
    ["planned", "implementing"],
    ["implementing", "implementation_captured"],
    ["implementation_captured", "reviewing"],
    ["reviewing", "remediating"],
    ["remediating", "remediation_captured"],
  ];
  const pathB: ReadonlyArray<readonly [string, string]> = [
    ["planned", "implementing"],
    ["implementing", "implementation_captured"],
    ["implementation_captured", "reviewing"],
    ["reviewing", "verification_queued"],
    ["verification_queued", "verifying"],
    ["verifying", "converging"],
  ];

  // Choose the right path based on the target state.
  const pathAStates = new Set(["remediating", "remediation_captured"]);
  const pathBStates = new Set(["verification_queued", "verifying", "converging"]);
  const path = pathAStates.has(toState) ? pathA : pathBStates.has(toState) ? pathB : pathB;

  const seen = new Set<string>(["planned"]);
  for (const [from, to] of path) {
    if (seen.has(toState)) break;
    if (!seen.has(from)) continue;
    store.advanceAttemptState(attemptId, from, to, `r16-walk:${from}:${to}:${attemptId}`);
    seen.add(to);
  }
  if (toState !== "planned" && !seen.has(toState)) {
    throw new Error(`cannot walk to ${toState}`);
  }
  const db = new DatabaseSync(store.location.databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT state_version FROM attempts WHERE attempt_id = ?").get(attemptId) as { readonly state_version: number } | undefined;
    if (row === undefined) throw new Error("attempt not found");
    return Number(row.state_version);
  } finally {
    db.close();
  }
}

// Create a candidate commit with actual changes (so the tree differs from
// the baseline) and return the candidate tree OID and canonical diff digest.
function createCandidateCommit(fixture: RealAuthorityFixture): {
  readonly candidateTreeOid: string;
  readonly candidateDiffDigest: `sha256:${string}`;
  readonly candidateOid: string;
} {
  mkdirSync(join(fixture.repo, "src"), { recursive: true });
  writeFileSync(join(fixture.repo, "src", "output.ts"), "export const value = true;\n", "utf8");
  execFileSync("git", ["-C", fixture.repo, "add", "src/output.ts"]);
  execFileSync("git", ["-C", fixture.repo, "commit", "-qm", "candidate commit"]);
  const candidateOid = git(fixture.repo, "rev-parse", "HEAD");
  const candidateTreeOid = git(fixture.repo, "rev-parse", `${candidateOid}^{tree}`);
  const raw = execFileSync("git", [
    "-C", fixture.repo, "diff", "--raw", "-z", "--no-abbrev", "-M",
    fixture.attempt.deliveryBaselineOid, candidateOid,
  ], { encoding: "utf8" });
  const delta = canonicalGitDeltaFromRaw(raw);
  if (delta.entries.length === 0) throw new Error("candidate commit produced no diff entries");
  return { candidateTreeOid, candidateDiffDigest: delta.candidateDiffDigest, candidateOid };
}

// Create evidence with exact inline payload that the store validates.
function createExactEvidence(
  fixture: RealAuthorityFixture,
  contextId: string,
  phaseExecutionId: string,
  evidenceId: string,
  producerService: string,
  scope: string,
  schemaVersion: string,
  payload: Readonly<Record<string, unknown>>,
  label: string,
): string {
  void label;
  const text = canonicalJson(payload);
  const row: StateRowInput = {
    evidence_id: evidenceId,
    attempt_id: fixture.attempt.attemptId,
    phase_execution_id: phaseExecutionId,
    context_id: contextId,
    producer_service: producerService,
    scope,
    schema_version: schemaVersion,
    content_digest: sha256(text),
    inline_payload_json: text,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence:${evidenceId}`,
    created_at: "2026-07-22T12:00:00.000Z",
  };
  fixture.store.appendEvidence(row);
  return evidenceId;
}

// Build a context through the real authority API.
function buildContext(
  fixture: RealAuthorityFixture,
  phase: string,
  phaseOrdinal: number,
  role: string,
) {
  mkdirSync(dirname(fixture.ownership.plan.policyContextPath), { recursive: true });
  return fixture.executionContext.resolveExecutionContext({
    attempt: fixture.attempt,
    contract: fixture.contract,
    phase,
    phaseOrdinal,
    role,
    ownership: fixture.ownership,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot: dirname(fixture.ownership.plan.policyContextPath),
      bundleDir: fixture.ownership.plan.policyBundlePath,
      requestedBundleSha256: createHash("sha256").update(fixture.ownership.plan.policyBundlePath, "utf8").digest("hex"),
    },
    modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
    timeoutMs: 30_000,
    callerRepositoryRealpath: fixture.repo,
  });
}

// ===========================================================================
// TEST SUITE — commitAttemptEdge ignores request.guard for ALL operands
// ===========================================================================

describe("M7 scrutiny round 16 — commitAttemptEdge ignores request.guard for ALL guard operands (contextId, gateResultIds, commitAttributionId)", () => {

  // -------------------------------------------------------------------------
  // TEST (a): execution_context guard — contextId from guard fallback
  // removed.  Provide a guard with a VALID contextId and NO dedicated
  // contextId field.  The transition MUST THROW because the dedicated
  // contextId field is the sole source and it is missing.
  //
  // Red against unfixed code: the fallback in #deriveEdgeGuard extracts
  // contextId from the guard (since request.contextId is undefined and
  // request.guard.kind === "execution_context").  The store validates the
  // context and the transition SUCCEEDS.  The test expects a throw but
  // gets none.
  //
  // Green after fix: no fallback, contextId is undefined, #deriveEdgeGuard
  // throws "no contextId was provided".
  // -------------------------------------------------------------------------
  it("negative proof (a): guard with valid contextId but NO dedicated contextId field MUST throw — guard fallback removed", () => {
    const fixture = buildRealAuthorityFixture("guard-fallback-ctx-r16");

    // Build a REVIEWER execution context (role "reviewer").
    const reviewerContext = buildContext(fixture, "review", 3, "reviewer");

    // Walk to remediation_captured so the remediation_captured -> reviewing
    // edge is legal.
    const expectedVersion = walkAttemptTo(fixture.store, fixture.attempt.attemptId, "remediation_captured");

    const transitions = new TransitionAuthority(fixture.store);
    const reviewerContextDigest = reviewerContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    // Call commitAttemptEdge with a guard that has a VALID contextId but
    // NO dedicated contextId field.  The guard's contextId is the correct
    // reviewer context — if the fallback were used, the transition would
    // succeed.  But the dedicated contextId field is missing, so the
    // transition MUST throw (the dedicated field is the sole source).
    const inlineEvidence: InlineTransitionEvidenceReference = Object.freeze({
      purpose: "review_after_remediation",
      inlineEvidence: Object.freeze({
        contextId: reviewerContext.persisted.contextId,
        producerService: "ReviewService",
        scope: `r16-ctx-fallback:${attemptId}`,
        schemaVersion: "rickgent.review-after-remediation.v1",
        payload: Object.freeze({
          attempt_id: attemptId,
          from_state: "remediation_captured",
          to_state: "reviewing",
          remediation_cycle: 1,
          context_digest: reviewerContextDigest,
        }),
        idempotencyKey: `r16-ctx-fallback-ev:${attemptId}`,
      }),
    });

    let threw = false;
    try {
      transitions.commitAttemptEdge({
        attemptId,
        from: "remediation_captured",
        to: "reviewing",
        ownerService: "ReviewService",
        // Guard has a valid contextId — the unfixed code's fallback would
        // use this.  After the fix, this is IGNORED.
        guard: {
          kind: "execution_context",
          contextId: reviewerContext.persisted.contextId,
          expectedRole: "reviewer",
        },
        // NO dedicated contextId field — the sole source is missing.
        expectedVersion,
        ownerContextDigest: reviewerContextDigest,
        idempotencyKey: `r16-ctx-fallback:${attemptId}`,
        evidence: [inlineEvidence],
      });
    } catch (err) {
      threw = true;
      // The error must be from the missing dedicated contextId field.
      const message = (err as { readonly message?: string }).message ?? String(err);
      expect(
        message.includes("contextId") ||
        message.includes("execution_context") ||
        err instanceof TypeError,
      ).toBe(true);
    }
    expect(threw).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TEST (b): gate_results guard — gateResultIds from guard fallback
  // removed.  Provide a guard with VALID gateResultIds and NO dedicated
  // gateResultIds field.  The transition MUST THROW because the dedicated
  // gateResultIds field is the sole source and it is missing.
  //
  // Red against unfixed code: the fallback in #deriveEdgeGuard extracts
  // gateResultIds from the guard (since request.gateResultIds is undefined
  // and request.guard.kind === "gate_results").  The store validates the
  // gate results and the transition SUCCEEDS.  The test expects a throw
  // but gets none.
  //
  // Green after fix: no fallback, gateResultIds is undefined,
  // #deriveEdgeGuard throws "no gateResultIds were provided".
  // -------------------------------------------------------------------------
  it("negative proof (b): guard with valid gateResultIds but NO dedicated gateResultIds field MUST throw — guard fallback removed", () => {
    const fixture = buildRealAuthorityFixture("guard-fallback-gate-r16");

    // Build a VERIFIER execution context (role "verifier").
    const verifierContext = buildContext(fixture, "verification", 5, "verifier");

    // Create a candidate commit with actual changes.
    const candidate = createCandidateCommit(fixture);

    // Walk to "verifying" so the verifying -> converging edge is legal.
    walkAttemptTo(fixture.store, fixture.attempt.attemptId, "verifying");

    // Create a gate result record via the real authority API.
    const attemptId = fixture.attempt.attemptId;
    const gateResultId = `gate-r16-${attemptId}`;
    const gateEvidenceId = `evidence-r16-gate-${attemptId}`;
    const contextId = verifierContext.persisted.contextId;
    const phaseExecutionId = verifierContext.persisted.phaseExecutionId;
    const contextDigest = verifierContext.persisted.contextDigest as `sha256:${string}`;
    const contractDigest = fixture.attempt.contractDigest;

    // Create the gate result evidence (producer='VerificationService',
    // schema='rickgent.gate-result.v1').
    const gatePayload = canonicalJson({
      gate_id: "VER-M7R16",
      evaluation_ordinal: 0,
      required: true,
      status: "passed",
      candidate_tree_oid: candidate.candidateTreeOid,
      candidate_diff_digest: candidate.candidateDiffDigest,
    });
    const gateRow: StateRowInput = {
      evidence_id: gateEvidenceId,
      attempt_id: attemptId,
      phase_execution_id: phaseExecutionId,
      context_id: contextId,
      producer_service: "VerificationService",
      scope: gateResultId,
      schema_version: "rickgent.gate-result.v1",
      content_digest: sha256(gatePayload),
      inline_payload_json: gatePayload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: `evidence-gate:${gateResultId}`,
      created_at: "2026-07-22T12:10:00.000Z",
    };
    fixture.store.appendEvidence(gateRow);

    // Record the gate result via the real authority API.
    const gateRequest: GateResultRecordRequest = {
      gateResultId,
      attemptId,
      gateId: "VER-M7R16",
      evaluationOrdinal: 0,
      status: "passed",
      required: true,
      contextId,
      ownerContextDigest: contextDigest,
      contractDigest,
      evidenceId: gateEvidenceId,
      candidateTreeOid: candidate.candidateTreeOid,
      candidateDiffDigest: candidate.candidateDiffDigest,
      createdAt: "2026-07-22T12:10:30.000Z",
    };
    fixture.records.recordGateResult(gateRequest);

    // Read the current state version after the walk.
    const expectedVersion = (() => {
      const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
      try {
        const row = db.prepare("SELECT state_version FROM attempts WHERE attempt_id = ?").get(attemptId) as { readonly state_version: number } | undefined;
        if (row === undefined) throw new Error("attempt not found");
        return Number(row.state_version);
      } finally {
        db.close();
      }
    })();

    const transitions = new TransitionAuthority(fixture.store);

    // The gate result evidence must be referenced in the transition evidence.
    const gateEvidenceRef: ExistingTransitionEvidenceReference = {
      purpose: "gate_result",
      evidenceId: gateEvidenceId,
    };

    // Call commitAttemptEdge with a guard that has VALID gateResultIds
    // but NO dedicated gateResultIds field.  The guard's gateResultIds
    // are the correct ones — if the fallback were used, the transition
    // would succeed.  But the dedicated gateResultIds field is missing,
    // so the transition MUST throw.
    let threw = false;
    try {
      transitions.commitAttemptEdge({
        attemptId,
        from: "verifying",
        to: "converging",
        ownerService: "VerificationService",
        // Guard has valid gateResultIds — the unfixed code's fallback
        // would use these.  After the fix, this is IGNORED.
        guard: {
          kind: "gate_results",
          gateResultIds: [gateResultId],
        },
        // NO dedicated gateResultIds field — sole source is missing.
        expectedVersion,
        ownerContextDigest: contextDigest,
        idempotencyKey: `r16-gate-fallback:${attemptId}`,
        evidence: [gateEvidenceRef],
      });
    } catch (err) {
      threw = true;
      const message = (err as { readonly message?: string }).message ?? String(err);
      expect(
        message.includes("gateResultIds") ||
        message.includes("gate_results") ||
        err instanceof TypeError,
      ).toBe(true);
    }
    expect(threw).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TEST (c): cleanup_pending guard — commitAttributionId from guard
  // fallback removed.  Provide a guard with a FAKE commitAttributionId
  // and NO dedicated commitAttributionId field, but provide evidence with
  // purpose "failure" (the no-attribution cleanup path).  The transition
  // MUST SUCCEED because the guard's fake commitAttributionId is IGNORED
  // and the no-attribution path is used.
  //
  // Red against unfixed code: the fallback in #deriveEdgeGuard extracts
  // the FAKE commitAttributionId from the guard (since
  // request.commitAttributionId is undefined and request.guard.kind ===
  // "cleanup_pending").  The store tries to look up the fake
  // commitAttributionId, fails to find it, and throws.  The test expects
  // success but gets a throw.
  //
  // Green after fix: no fallback, commitAttributionId is undefined, the
  // guard has no commitAttributionId, the store checks for "failure"
  // evidence (which is provided), and the transition SUCCEEDS.
  // -------------------------------------------------------------------------
  it("negative proof (c): guard with FAKE commitAttributionId but NO dedicated field MUST succeed (no-attribution path) — guard fallback removed", () => {
    const fixture = buildRealAuthorityFixture("guard-fallback-attr-r16");

    // Build a CLEANUP execution context for the evidence row.
    const cleanupContext = buildContext(fixture, "cleanup", 7, "cleanup");

    // Walk to "converging" so the converging -> cleanup_pending edge is
    // legal.
    walkAttemptTo(fixture.store, fixture.attempt.attemptId, "converging");

    const attemptId = fixture.attempt.attemptId;
    const contextId = cleanupContext.persisted.contextId;
    const phaseExecutionId = cleanupContext.persisted.phaseExecutionId;
    const contextDigest = cleanupContext.persisted.contextDigest as `sha256:${string}`;

    // Create an evidence row that belongs to the attempt (required by
    // #validateTransitionEvidence).  Use "AttemptLifecycleService" as the
    // producer (not in the restricted list for appendEvidence).
    const failureEvidenceId = `evidence-r16-failure-${attemptId}`;
    const failurePayload = canonicalJson({
      attempt_id: attemptId,
      from_state: "converging",
      to_state: "cleanup_pending",
      reason: "verification failure cleanup",
    });
    const failureRow: StateRowInput = {
      evidence_id: failureEvidenceId,
      attempt_id: attemptId,
      phase_execution_id: phaseExecutionId,
      context_id: contextId,
      producer_service: "AttemptLifecycleService",
      scope: `r16-failure:${attemptId}`,
      schema_version: "rickgent.attempt-lifecycle-failure.v1",
      content_digest: sha256(failurePayload),
      inline_payload_json: failurePayload,
      external_path: null,
      external_digest: null,
      external_size: null,
      idempotency_key: `evidence-failure:${failureEvidenceId}`,
      created_at: "2026-07-22T12:20:00.000Z",
    };
    fixture.store.appendEvidence(failureRow);

    // Read the current state version.
    const expectedVersion = (() => {
      const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
      try {
        const row = db.prepare("SELECT state_version FROM attempts WHERE attempt_id = ?").get(attemptId) as { readonly state_version: number } | undefined;
        if (row === undefined) throw new Error("attempt not found");
        return Number(row.state_version);
      } finally {
        db.close();
      }
    })();

    const transitions = new TransitionAuthority(fixture.store);

    // The "failure" evidence reference — the store checks for
    // a failure-purpose evidence reference when the guard has no
    // commitAttributionId.
    const failureRef: ExistingTransitionEvidenceReference = {
      purpose: "failure",
      evidenceId: failureEvidenceId,
    };

    // Call commitAttemptEdge with a guard that has a FAKE
    // commitAttributionId but NO dedicated commitAttributionId field.
    // The guard's fake commitAttributionId is "fake-nonexistent-id" — if
    // the fallback were used, the store would look it up, fail to find
    // it, and throw.  After the fix, the guard is ignored,
    // commitAttributionId is undefined, and the "failure" evidence path
    // is used instead, so the transition SUCCEEDS.
    const result = transitions.commitAttemptEdge({
      attemptId,
      from: "converging",
      to: "cleanup_pending",
      ownerService: "AttemptLifecycleService",
      // Guard has a FAKE commitAttributionId — the unfixed code's
      // fallback would use this and fail.  After the fix, this is
      // IGNORED.
      guard: {
        kind: "cleanup_pending",
        commitAttributionId: "fake-nonexistent-attribution-id",
      },
      // NO dedicated commitAttributionId field — the no-attribution path
      // is the correct one.
      expectedVersion,
      ownerContextDigest: contextDigest,
      idempotencyKey: `r16-attr-fallback:${attemptId}`,
      evidence: [failureRef],
    });

    // The transition MUST SUCCEED — the guard's fake commitAttributionId
    // is ignored, and the no-attribution "failure" evidence path is used.
    expect(result.toState).toBe("cleanup_pending");
    expect(result.fromState).toBe("converging");
  });
});
