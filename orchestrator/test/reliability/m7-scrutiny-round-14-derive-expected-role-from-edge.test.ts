//
// M7 scrutiny round 14 — commitAttemptEdge must derive expectedRole from the
// normative PHASE_TRANSITION_TABLE edge definition, NOT from the caller.
//
// The public TransitionAuthority.commitAttemptEdge method still accepts a
// caller-selected execution_context guard with a caller-provided
// expectedRole.  A caller can select expectedRole 'remediator' with a genuine
// remediator context for the reviewer-only remediation_captured-to-reviewing
// edge, and StateStore accepts it because it validates the caller-provided
// role against the context's role (both 'remediator' — match — pass).
//
// Fix: commitAttemptEdge looks up the edge in PHASE_TRANSITION_TABLE and uses
// the edge's declared role as the expectedRole, ignoring the caller-provided
// value.  The caller cannot override the edge's declared role.
//
// This test calls commitAttemptEdge DIRECTLY (not through beginReviewAfterRemediation
// or LifecycleEngine) with a remediator context and expectedRole 'remediator'
// for the remediation_captured-to-reviewing edge.  It asserts the transition
// fails closed because the edge's declared role is 'reviewer', not 'remediator'.
//
// Red against unfixed code: commitAttemptEdge passes the caller-provided guard
// directly to StateStore.  The context's role ('remediator') matches the
// caller-provided expectedRole ('remediator') — the guard PASSES and the
// transition SUCCEEDS.  The test expects a throw but gets none.
//

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sealTicketContracts, type TicketContract, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../src/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../src/context/attempt-execution-context.js";
import { TransitionAuthority } from "../../src/state/transitions.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
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

function makeRepo(label = "m7r14"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r14-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R14 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r14@example.test"]);
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
    id: "t83",
    title: "M7 round 14 test",
    description: "Prove commitAttemptEdge derives expectedRole from the edge definition.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R14",
      description: "commitAttemptEdge derives expectedRole from PHASE_TRANSITION_TABLE edge.",
      interface_ids: [],
      verification_ids: ["VER-M7R14"],
    }],
    verifications: [{
      id: "VER-M7R14",
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
}

function buildRealAuthorityFixture(label = "real-authority-r14"): RealAuthorityFixture {
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
  };
}

// Walk an attempt to the remediation_captured state via the store CAS path
// (no authority) so we can test the remediation_captured -> reviewing edge
// in isolation through the generic commitAttemptEdge API.
function walkToRemediationCaptured(store: StateStore, attemptId: string): number {
  store.advanceAttemptState(attemptId, "planned", "implementing", `r14-impl:${attemptId}`);
  store.advanceAttemptState(attemptId, "implementing", "implementation_captured", `r14-impl-captured:${attemptId}`);
  store.advanceAttemptState(attemptId, "implementation_captured", "reviewing", `r14-reviewing:${attemptId}`);
  store.advanceAttemptState(attemptId, "reviewing", "remediating", `r14-remediating:${attemptId}`);
  store.advanceAttemptState(attemptId, "remediating", "remediation_captured", `r14-remediation-captured:${attemptId}`);
  const db = new DatabaseSync(store.location.databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT state_version FROM attempts WHERE attempt_id = ?").get(attemptId) as { readonly state_version: number } | undefined;
    if (row === undefined) throw new Error("attempt not found");
    return Number(row.state_version);
  } finally {
    db.close();
  }
}

// ===========================================================================
// TEST SUITE — commitAttemptEdge derives expectedRole from the edge definition
// ===========================================================================

describe("M7 scrutiny round 14 — commitAttemptEdge derives expectedRole from PHASE_TRANSITION_TABLE edge, not caller", () => {
  it("negative proof: remediator context + caller-provided expectedRole 'remediator' CANNOT authorize the remediation_captured to reviewing edge through commitAttemptEdge (guard fails closed)", () => {
    const fixture = buildRealAuthorityFixture("generic-authority-negative");

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

    // Walk the attempt to remediation_captured.
    const expectedVersion = walkToRemediationCaptured(fixture.store, fixture.attempt.attemptId);

    // Call commitAttemptEdge DIRECTLY (not through beginReviewAfterRemediation
    // or LifecycleEngine).  Pass a REMEDIATOR context and a caller-provided
    // expectedRole 'remediator' in the guard.  The edge's declared role is
    // 'reviewer' (from PHASE_TRANSITION_TABLE).  commitAttemptEdge must derive
    // the expectedRole from the edge definition, NOT from the caller.  The
    // remediator context must be rejected fail-closed with
    // RICKGENT_STATE_TRANSITION_ILLEGAL.
    const transitions = new TransitionAuthority(fixture.store);

    const remediationContextDigest = remediationContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    let threw = false;
    try {
      transitions.commitAttemptEdge({
        attemptId,
        from: "remediation_captured",
        to: "reviewing",
        ownerService: "ReviewService",
        guard: {
          kind: "execution_context",
          contextId: remediationContext.persisted.contextId,
          expectedRole: "remediator", // caller-provided — must be IGNORED
        },
        expectedVersion,
        ownerContextDigest: remediationContextDigest,
        idempotencyKey: `r14-cross-role-negative:${attemptId}`,
        evidence: [Object.freeze({
          purpose: "review_after_remediation",
          inlineEvidence: Object.freeze({
            contextId: remediationContext.persisted.contextId,
            producerService: "ReviewService",
            scope: `direct-generic-cross-role-test:${attemptId}`,
            schemaVersion: "rickgent.review-after-remediation.v1",
            payload: Object.freeze({
              attempt_id: attemptId,
              from_state: "remediation_captured",
              to_state: "reviewing",
              remediation_cycle: 1,
              context_digest: remediationContextDigest,
            }),
            idempotencyKey: `r14-cross-role-negative:${attemptId}`,
          }),
        })],
      });
    } catch (err) {
      threw = true;
      const code = (err as { readonly code?: string }).code;
      expect(code).toBeDefined();
      expect(code).toMatch(/RICKGENT_STATE_TRANSITION_ILLEGAL/);
    }
    expect(threw).toBe(true);
  });

  it("positive proof: reviewer context + caller-provided expectedRole 'reviewer' CAN authorize the remediation_captured to reviewing edge through commitAttemptEdge", () => {
    const fixture = buildRealAuthorityFixture("generic-authority-positive");

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

    const expectedVersion = walkToRemediationCaptured(fixture.store, fixture.attempt.attemptId);

    const transitions = new TransitionAuthority(fixture.store);
    const reviewerContextDigest = reviewerContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    // Call commitAttemptEdge DIRECTLY with a REVIEWER context and the correct
    // expectedRole 'reviewer'.  This must succeed.
    const result = transitions.commitAttemptEdge({
      attemptId,
      from: "remediation_captured",
      to: "reviewing",
      ownerService: "ReviewService",
      guard: {
        kind: "execution_context",
        contextId: reviewerContext.persisted.contextId,
        expectedRole: "reviewer",
      },
      expectedVersion,
      ownerContextDigest: reviewerContextDigest,
      idempotencyKey: `r14-correct-role-positive:${attemptId}`,
      evidence: [Object.freeze({
        purpose: "review_after_remediation",
        inlineEvidence: Object.freeze({
          contextId: reviewerContext.persisted.contextId,
          producerService: "ReviewService",
          scope: `direct-generic-correct-role-test:${attemptId}`,
          schemaVersion: "rickgent.review-after-remediation.v1",
          payload: Object.freeze({
            attempt_id: attemptId,
            from_state: "remediation_captured",
            to_state: "reviewing",
            remediation_cycle: 1,
            context_digest: reviewerContextDigest,
          }),
          idempotencyKey: `r14-correct-role-positive:${attemptId}`,
        }),
      })],
    });

    expect(result.toState).toBe("reviewing");
    expect(result.fromState).toBe("remediation_captured");
  });

  it("positive proof: reviewer context + caller-provided expectedRole 'remediator' (WRONG) still succeeds because commitAttemptEdge IGNORES the caller and derives 'reviewer' from the edge", () => {
    const fixture = buildRealAuthorityFixture("generic-authority-override-ignore");

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

    const expectedVersion = walkToRemediationCaptured(fixture.store, fixture.attempt.attemptId);

    const transitions = new TransitionAuthority(fixture.store);
    const reviewerContextDigest = reviewerContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    // Call commitAttemptEdge with a REVIEWER context but a WRONG caller-
    // provided expectedRole 'remediator'.  commitAttemptEdge must IGNORE the
    // caller's 'remediator' and derive 'reviewer' from the edge definition.
    // The reviewer context (role 'reviewer') matches the edge's declared
    // role 'reviewer', so the transition SUCCEEDS despite the wrong caller
    // value.  This proves the caller cannot override the edge's role.
    const result = transitions.commitAttemptEdge({
      attemptId,
      from: "remediation_captured",
      to: "reviewing",
      ownerService: "ReviewService",
      guard: {
        kind: "execution_context",
        contextId: reviewerContext.persisted.contextId,
        expectedRole: "remediator", // wrong caller value — must be IGNORED
      },
      expectedVersion,
      ownerContextDigest: reviewerContextDigest,
      idempotencyKey: `r14-override-ignore:${attemptId}`,
      evidence: [Object.freeze({
        purpose: "review_after_remediation",
        inlineEvidence: Object.freeze({
          contextId: reviewerContext.persisted.contextId,
          producerService: "ReviewService",
          scope: `direct-generic-override-ignore-test:${attemptId}`,
          schemaVersion: "rickgent.review-after-remediation.v1",
          payload: Object.freeze({
            attempt_id: attemptId,
            from_state: "remediation_captured",
            to_state: "reviewing",
            remediation_cycle: 1,
            context_digest: reviewerContextDigest,
          }),
          idempotencyKey: `r14-override-ignore:${attemptId}`,
        }),
      })],
    });

    expect(result.toState).toBe("reviewing");
    expect(result.fromState).toBe("remediation_captured");
  });
});
