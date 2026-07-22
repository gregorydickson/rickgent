//
// M7 scrutiny round 15 — commitAttemptEdge must derive the ENTIRE guard
// (both kind AND expectedRole) from the PHASE_TRANSITION_TABLE edge
// definition, NOT from the caller.
//
// Round 14 fixed only the expectedRole for execution_context guards: if the
// caller passes an execution_context guard, the edge's declared role
// overrides the caller's expectedRole.  But the guard KIND is still
// caller-selected.  A genuine remediator-owned remediation_record guard can
// authorize the reviewer-only remediation_captured → reviewing edge,
// bypassing the execution_context requirement entirely.  The caller
// controls which guard kind is used; the edge's declared guard kind
// ("execution_context") is ignored when the caller passes a different kind.
//
// Fix: commitAttemptEdge looks up the edge in PHASE_TRANSITION_TABLE and
// CONSTRUCTS the guard from the edge's declared guard kind and role,
// completely ignoring any caller-provided guard.  The caller-provided guard
// is IGNORED entirely — both kind and role come from the normative edge.
//
// This test calls commitAttemptEdge DIRECTLY (not through
// beginReviewAfterRemediation or LifecycleEngine).
//
// Negative proof: create a GENUINE remediation_record (via
// LifecycleRecordAuthority.recordRemediation with a real remediator context
// and real evidence rows), then call commitAttemptEdge with a
// remediation_record guard for the remediation_captured-to-reviewing edge.
// The edge declares guard kind "execution_context" with role "reviewer".
// The remediation_record guard must be REJECTED because the edge requires
// an execution_context guard — the caller cannot substitute a different
// guard kind.
//
// Red against unfixed code: commitAttemptEdge passes the caller-provided
// remediation_record guard directly to StateStore (the #deriveEdgeGuard
// method only overrides expectedRole for execution_context guards, and
// returns other guard kinds unchanged).  The StateStore validates the
// remediation_record guard, finds the genuine remediation record, and the
// transition SUCCEEDS.  The test expects a throw but gets none.
//
// Positive proof: call commitAttemptEdge with NO guard but with a contextId
// field for a reviewer context.  commitAttemptEdge derives the
// execution_context guard from the edge definition (kind + role) and uses
// the provided contextId.  The transition SUCCEEDS because the guard is
// always derived from the edge, not the caller.
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
import { TransitionAuthority, LifecycleRecordAuthority, type RemediationRecordRequest, type ReviewRecordRequest, type ExistingTransitionEvidenceReference } from "../../src/state/transitions.js";
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

function makeRepo(label = "m7r15"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r15-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R15 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r15@example.test"]);
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
    id: "t84",
    title: "M7 round 15 test",
    description: "Prove commitAttemptEdge derives the ENTIRE guard from the edge definition.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R15",
      description: "commitAttemptEdge derives guard kind AND role from PHASE_TRANSITION_TABLE edge.",
      interface_ids: [],
      verification_ids: ["VER-M7R15"],
    }],
    verifications: [{
      id: "VER-M7R15",
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

function buildRealAuthorityFixture(label = "real-authority-r15"): RealAuthorityFixture {
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

// Walk an attempt to the specified state via the store CAS path
// (no authority) so we can test edges in isolation through the generic
// commitAttemptEdge API.
function walkAttemptTo(store: StateStore, attemptId: string, toState: string): number {
  const sequence: ReadonlyArray<readonly [string, string]> = [
    ["planned", "implementing"],
    ["implementing", "implementation_captured"],
    ["implementation_captured", "reviewing"],
    ["reviewing", "remediating"],
    ["remediating", "remediation_captured"],
  ];
  const seen = new Set<string>(["planned"]);
  for (const [from, to] of sequence) {
    if (seen.has(toState)) break;
    if (!seen.has(from)) continue;
    store.advanceAttemptState(attemptId, from, to, `r15-walk:${from}:${to}:${attemptId}`);
    seen.add(to);
  }
  if (toState !== "planned" && !seen.has(toState)) {
    throw new Error(`cannot walk to ${toState} from planned`);
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

// Create a rejected review record via the real authority API.
// The attempt MUST be in 'reviewing' state when this is called.
function createRejectedReviewRecord(
  fixture: RealAuthorityFixture,
  reviewerContext: ReturnType<AttemptExecutionContextAuthority["resolveExecutionContext"]>,
  candidate: { readonly candidateTreeOid: string; readonly candidateDiffDigest: `sha256:${string}` },
  label: string,
): { readonly reviewRecordId: string; readonly findingsEvidenceId: string } {
  const attemptId = fixture.attempt.attemptId;
  const reviewRecordId = `review-r15-${label}-${attemptId}`;
  const verdictEvidenceId = `evidence-r15-verdict-${label}-${attemptId}`;
  const findingsEvidenceId = `evidence-r15-findings-${label}-${attemptId}`;
  const contextId = reviewerContext.persisted.contextId;
  const phaseExecutionId = reviewerContext.persisted.phaseExecutionId;
  const contextDigest = reviewerContext.persisted.contextDigest as `sha256:${string}`;

  // Create verdict evidence (producer='ReviewService', scope=reviewRecordId,
  // schema='rickgent.review-verdict.v1').
  createExactEvidence(
    fixture, contextId, phaseExecutionId, verdictEvidenceId,
    "ReviewService", reviewRecordId, "rickgent.review-verdict.v1",
    {
      attempt_id: attemptId,
      cycle: 1,
      verdict: "rejected",
      input_tree_oid: candidate.candidateTreeOid,
      input_diff_digest: candidate.candidateDiffDigest,
    },
    "review verdict",
  );

  // Create findings evidence (producer='ReviewService').
  const findingsPayload = canonicalJson({
    schema_version: "rickgent.review-findings.v1",
    attempt_id: attemptId,
    cycle: 1,
    verdict: "rejected",
  });
  const findingsRow: StateRowInput = {
    evidence_id: findingsEvidenceId,
    attempt_id: attemptId,
    phase_execution_id: phaseExecutionId,
    context_id: contextId,
    producer_service: "ReviewService",
    scope: `review-findings:${reviewRecordId}`,
    schema_version: "rickgent.review-findings.v1",
    content_digest: sha256(findingsPayload),
    inline_payload_json: findingsPayload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence-findings:${reviewRecordId}`,
    created_at: "2026-07-22T12:00:30.000Z",
  };
  fixture.store.appendEvidence(findingsRow);

  // Create the rejected review record.
  const reviewRequest: ReviewRecordRequest = {
    reviewRecordId,
    attemptId,
    cycle: 1,
    reviewerContextId: contextId,
    ownerContextDigest: contextDigest,
    verdict: "rejected",
    verdictEvidenceId,
    findingsEvidenceId,
    inputTreeOid: candidate.candidateTreeOid,
    inputDiffDigest: candidate.candidateDiffDigest,
    createdAt: "2026-07-22T12:01:00.000Z",
  };
  fixture.records.recordReview(reviewRequest);

  return { reviewRecordId, findingsEvidenceId };
}

// Create a genuine remediation record in the store via the real
// LifecycleRecordAuthority API.  The attempt MUST be in 'remediating' state
// when this is called.  Returns the remediation record ID and the evidence
// references that the remediation_record guard requires.
function createGenuineRemediationRecord(
  fixture: RealAuthorityFixture,
  remediatorContext: ReturnType<AttemptExecutionContextAuthority["resolveExecutionContext"]>,
  reviewFindings: { readonly findingsEvidenceId: string },
  candidate: { readonly candidateTreeOid: string; readonly candidateDiffDigest: `sha256:${string}` },
  label: string,
): {
  readonly remediationRecordId: string;
  readonly findingsEvidenceId: string;
  readonly outputEvidenceId: string;
  readonly contextDigest: `sha256:${string}`;
} {
  const attemptId = fixture.attempt.attemptId;
  const remediationRecordId = `remediation-r15-${label}-${attemptId}`;
  const outputEvidenceId = `evidence-r15-output-${label}-${attemptId}`;
  const contextId = remediatorContext.persisted.contextId;
  const phaseExecutionId = remediatorContext.persisted.phaseExecutionId;
  const contextDigest = remediatorContext.persisted.contextDigest as `sha256:${string}`;

  // The findings evidence ID comes from the rejected review record.
  const findingsEvidenceId = reviewFindings.findingsEvidenceId;

  // Create the output evidence with the exact inline payload the store
  // validates (producer='RemediationService', scope=remediationRecordId,
  // schema='rickgent.remediation-output.v1').
  createExactEvidence(
    fixture, contextId, phaseExecutionId, outputEvidenceId,
    "RemediationService", remediationRecordId, "rickgent.remediation-output.v1",
    {
      oracle_input_class: "remediation_cycle",
      attempt_id: attemptId,
      cycle: 1,
      result_tree_oid: candidate.candidateTreeOid,
      result_diff_digest: candidate.candidateDiffDigest,
    },
    "remediation output",
  );

  // Create the genuine remediation record via the real authority API.
  const remediationRequest: RemediationRecordRequest = {
    remediationRecordId,
    attemptId,
    cycle: 1,
    contextId,
    ownerContextDigest: contextDigest,
    findingsEvidenceId,
    outputEvidenceId,
    resultTreeOid: candidate.candidateTreeOid,
    resultDiffDigest: candidate.candidateDiffDigest,
    createdAt: "2026-07-22T12:02:00.000Z",
  };
  fixture.records.recordRemediation(remediationRequest);

  return { remediationRecordId, findingsEvidenceId, outputEvidenceId, contextDigest };
}

// ===========================================================================
// TEST SUITE — commitAttemptEdge derives ENTIRE guard from edge definition
// ===========================================================================

describe("M7 scrutiny round 15 — commitAttemptEdge derives ENTIRE guard (kind + role) from PHASE_TRANSITION_TABLE edge, not caller", () => {

  // -------------------------------------------------------------------------
  // NEGATIVE PROOF: a genuine remediation_record guard CANNOT authorize the
  // remediation_captured → reviewing edge.  The edge declares guard kind
  // "execution_context" with role "reviewer".  The caller-provided
  // remediation_record guard must be IGNORED — the guard kind must come from
  // the edge, not the caller.
  //
  // Red against unfixed code: commitAttemptEdge's #deriveEdgeGuard only
  // overrides expectedRole for execution_context guards.  For a
  // remediation_record guard, it returns the caller guard unchanged.  The
  // StateStore validates the genuine remediation record and the transition
  // SUCCEEDS — the test expects a throw but gets none.
  // -------------------------------------------------------------------------
  it("negative proof: genuine remediation_record guard CANNOT authorize the remediation_captured to reviewing edge through commitAttemptEdge (guard kind derived from edge, not caller)", () => {
    const fixture = buildRealAuthorityFixture("generic-authority-negative-r15");

    // Ensure the policy context directory exists for the execution context resolver.
    mkdirSync(dirname(fixture.ownership.plan.policyContextPath), { recursive: true });

    // Build a REMEDIATOR execution context (role "remediator") through the
    // real authority API.
    const remediationContext = fixture.executionContext.resolveExecutionContext({
      attempt: fixture.attempt,
      contract: fixture.contract,
      phase: "remediation",
      phaseOrdinal: 3,
      role: "remediator",
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

    // Build a REVIEWER execution context for the review record.
    const reviewerContext = fixture.executionContext.resolveExecutionContext({
      attempt: fixture.attempt,
      contract: fixture.contract,
      phase: "review",
      phaseOrdinal: 3,
      role: "reviewer",
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

    // Create a candidate commit with actual changes.
    const candidate = createCandidateCommit(fixture);

    // Walk to 'reviewing' and create a rejected review record.
    walkAttemptTo(fixture.store, fixture.attempt.attemptId, "reviewing");
    const review = createRejectedReviewRecord(fixture, reviewerContext, candidate, "negative");

    // Walk to 'remediating' state.
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "reviewing", "remediating",
      `r15-remediating:${fixture.attempt.attemptId}`,
    );

    // Create a GENUINE remediation record via the real authority API.
    const remediation = createGenuineRemediationRecord(fixture, remediationContext, review, candidate, "negative");

    // Walk the attempt from 'remediating' to 'remediation_captured'.
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "remediating", "remediation_captured",
      `r15-remediation-captured:${fixture.attempt.attemptId}`,
    );
    const expectedVersion = (() => {
      const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
      try {
        const row = db.prepare("SELECT state_version FROM attempts WHERE attempt_id = ?").get(fixture.attempt.attemptId) as { readonly state_version: number } | undefined;
        if (row === undefined) throw new Error("attempt not found");
        return Number(row.state_version);
      } finally {
        db.close();
      }
    })();

    // Call commitAttemptEdge DIRECTLY with a remediation_record guard.
    // The edge declares guard kind "execution_context" with role "reviewer".
    // The remediation_record guard must be REJECTED because the edge
    // requires an execution_context guard — the caller cannot substitute
    // a different guard kind.
    const transitions = new TransitionAuthority(fixture.store);
    const attemptId = fixture.attempt.attemptId;

    const findingsRef: ExistingTransitionEvidenceReference = { purpose: "remediation-findings", evidenceId: remediation.findingsEvidenceId };
    const outputRef: ExistingTransitionEvidenceReference = { purpose: "remediation-output", evidenceId: remediation.outputEvidenceId };

    let threw = false;
    try {
      transitions.commitAttemptEdge({
        attemptId,
        from: "remediation_captured",
        to: "reviewing",
        ownerService: "ReviewService",
        guard: {
          kind: "remediation_record",
          remediationRecordId: remediation.remediationRecordId,
        },
        expectedVersion,
        ownerContextDigest: remediation.contextDigest,
        idempotencyKey: `******************************:${attemptId}`,
        evidence: [findingsRef, outputRef],
      });
    } catch (err) {
      threw = true;
      // The transition must fail closed.  commitAttemptEdge derives the
      // guard from the edge definition (execution_context with role
      // reviewer), NOT from the caller's remediation_record guard.  Since
      // no contextId field is provided (the caller passed a
      // remediation_record guard, not a contextId), the guard derivation
      // fails closed.  The error may be a TypeError (missing contextId)
      // or a StateStoreError with RICKGENT_STATE_TRANSITION_ILLEGAL.
      const code = (err as { readonly code?: string }).code;
      const message = (err as { readonly message?: string }).message ?? String(err);
      // Verify the error is related to the guard derivation or transition
      // rejection — not some unrelated failure.
      expect(
        code !== undefined && code.match(/RICKGENT_STATE_TRANSITION_ILLEGAL|RICKGENT_STATE_TRANSITION_GUARD/) ||
        message.includes("execution_context") ||
        message.includes("contextId") ||
        message.includes("guard") ||
        err instanceof TypeError,
      ).toBe(true);
    }
    expect(threw).toBe(true);
  });

  // -------------------------------------------------------------------------
  // POSITIVE PROOF: call commitAttemptEdge with NO guard but with a
  // contextId field for a reviewer context.  commitAttemptEdge derives the
  // execution_context guard from the edge definition (kind + role) and uses
  // the provided contextId.  The transition SUCCEEDS because the guard is
  // always derived from the edge, not the caller.
  //
  // This test requires the API change (optional guard + contextId field).
  // It is added after the fix is applied.
  // -------------------------------------------------------------------------
  it("positive proof: NO guard + contextId field succeeds because commitAttemptEdge derives the execution_context guard from the edge definition", () => {
    const fixture = buildRealAuthorityFixture("generic-authority-positive-r15");

    mkdirSync(dirname(fixture.ownership.plan.policyContextPath), { recursive: true });

    // Build a REVIEWER execution context (role "reviewer") through the real
    // authority API.
    const reviewerContext = fixture.executionContext.resolveExecutionContext({
      attempt: fixture.attempt,
      contract: fixture.contract,
      phase: "review",
      phaseOrdinal: 3,
      role: "reviewer",
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

    const expectedVersion = walkAttemptTo(fixture.store, fixture.attempt.attemptId, "remediation_captured");

    const transitions = new TransitionAuthority(fixture.store);
    const reviewerContextDigest = reviewerContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    // Call commitAttemptEdge with NO guard — only a contextId field.
    // commitAttemptEdge must derive the execution_context guard from the
    // edge definition (kind "execution_context", role "reviewer") and use
    // the provided contextId.  The reviewer context matches the edge's
    // declared role, so the transition SUCCEEDS.
    const result = transitions.commitAttemptEdge({
      attemptId,
      from: "remediation_captured",
      to: "reviewing",
      ownerService: "ReviewService",
      // NO guard — commitAttemptEdge derives it from the edge definition
      contextId: reviewerContext.persisted.contextId,
      expectedVersion,
      ownerContextDigest: reviewerContextDigest,
      idempotencyKey: `r15-positive-no-guard:${attemptId}`,
      evidence: [Object.freeze({
        purpose: "review_after_remediation",
        inlineEvidence: Object.freeze({
          contextId: reviewerContext.persisted.contextId,
          producerService: "ReviewService",
          scope: `r15-positive-no-guard:${attemptId}`,
          schemaVersion: "rickgent.review-after-remediation.v1",
          payload: Object.freeze({
            attempt_id: attemptId,
            from_state: "remediation_captured",
            to_state: "reviewing",
            remediation_cycle: 1,
            context_digest: reviewerContextDigest,
          }),
          idempotencyKey: `r15-positive-no-guard:${attemptId}`,
        }),
      })],
    });

    expect(result.toState).toBe("reviewing");
    expect(result.fromState).toBe("remediation_captured");
  });

  // -------------------------------------------------------------------------
  // POSITIVE PROOF 2: call commitAttemptEdge with a WRONG guard kind
  // (remediation_record) but with a contextId field for a reviewer context.
  // commitAttemptEdge IGNORES the wrong guard and derives the
  // execution_context guard from the edge definition.  The transition
  // SUCCEEDS because the guard is always derived from the edge.
  //
  // This test requires the API change (contextId field).  It is added after
  // the fix is applied.
  // -------------------------------------------------------------------------
  it("positive proof: WRONG guard kind (remediation_record) + contextId field succeeds because commitAttemptEdge IGNORES the caller guard and derives execution_context from the edge", () => {
    const fixture = buildRealAuthorityFixture("generic-authority-wrong-guard-r15");

    mkdirSync(dirname(fixture.ownership.plan.policyContextPath), { recursive: true });

    // Build a REVIEWER execution context (role "reviewer").
    const reviewerContext = fixture.executionContext.resolveExecutionContext({
      attempt: fixture.attempt,
      contract: fixture.contract,
      phase: "review",
      phaseOrdinal: 3,
      role: "reviewer",
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

    const expectedVersion = walkAttemptTo(fixture.store, fixture.attempt.attemptId, "remediation_captured");

    const transitions = new TransitionAuthority(fixture.store);
    const reviewerContextDigest = reviewerContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    // Call commitAttemptEdge with a WRONG guard kind (remediation_record)
    // but provide the correct contextId.  commitAttemptEdge must IGNORE
    // the remediation_record guard and derive the execution_context guard
    // from the edge.  The reviewer context matches the edge's declared
    // role, so the transition SUCCEEDS.
    const result = transitions.commitAttemptEdge({
      attemptId,
      from: "remediation_captured",
      to: "reviewing",
      ownerService: "ReviewService",
      guard: {
        kind: "remediation_record",
        remediationRecordId: "fake-remediation-record-id",
      },
      contextId: reviewerContext.persisted.contextId,
      expectedVersion,
      ownerContextDigest: reviewerContextDigest,
      idempotencyKey: `r15-positive-wrong-guard:${attemptId}`,
      evidence: [Object.freeze({
        purpose: "review_after_remediation",
        inlineEvidence: Object.freeze({
          contextId: reviewerContext.persisted.contextId,
          producerService: "ReviewService",
          scope: `r15-positive-wrong-guard:${attemptId}`,
          schemaVersion: "rickgent.review-after-remediation.v1",
          payload: Object.freeze({
            attempt_id: attemptId,
            from_state: "remediation_captured",
            to_state: "reviewing",
            remediation_cycle: 1,
            context_digest: reviewerContextDigest,
          }),
          idempotencyKey: `r15-positive-wrong-guard:${attemptId}`,
        }),
      })],
    });

    expect(result.toState).toBe("reviewing");
    expect(result.fromState).toBe("remediation_captured");
  });
});
