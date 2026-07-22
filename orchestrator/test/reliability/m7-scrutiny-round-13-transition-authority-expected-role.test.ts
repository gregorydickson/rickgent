//
// M7 scrutiny round 13 — TransitionAuthority typed guard must bind expectedRole.
//
// The typed TransitionAuthority.beginReviewAfterRemediation method creates
// an execution_context guard.  Round 12 added expectedRole to the guard
// TYPE and the LifecycleEngine's guardForEdge, but the TYPED
// TransitionAuthority methods themselves (beginReview,
// beginReviewAfterRemediation, beginVerification) do NOT bind expectedRole
// in the guard they construct.  As a result, a caller that invokes the
// typed authority API directly (not through the LifecycleEngine) can pass a
// REMEDIATOR execution context to authorize a ReviewService/reviewer edge.
// The StateStore falls back to the legacy context+digest-only check and
// the cross-role substitution succeeds.
//
// This test calls TransitionAuthority.beginReviewAfterRemediation DIRECTLY
// (not through AttemptRunner or LifecycleEngine) with a remediator context
// and asserts the transition fails closed with
// RICKGENT_STATE_TRANSITION_ILLEGAL.
//
// Red against unfixed code: the typed method does not set expectedRole, so
// the guard passes and the transition SUCCEEDS — the test expects a throw
// but gets none.
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

function makeRepo(label = "m7r13"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r13-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R13 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r13@example.test"]);
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
    id: "t82",
    title: "M7 round 13 test",
    description: "Prove typed TransitionAuthority guard binds expectedRole.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R13",
      description: "Typed authority guard rejects cross-role context.",
      interface_ids: [],
      verification_ids: ["VER-M7R13"],
    }],
    verifications: [{
      id: "VER-M7R13",
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

function buildRealAuthorityFixture(label = "real-authority-r13"): RealAuthorityFixture {
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
// in isolation through the typed TransitionAuthority API.
function walkToRemediationCaptured(store: StateStore, attemptId: string): number {
  store.advanceAttemptState(attemptId, "planned", "implementing", `r13-impl:${attemptId}`);
  store.advanceAttemptState(attemptId, "implementing", "implementation_captured", `r13-impl-captured:${attemptId}`);
  store.advanceAttemptState(attemptId, "implementation_captured", "reviewing", `r13-reviewing:${attemptId}`);
  store.advanceAttemptState(attemptId, "reviewing", "remediating", `r13-remediating:${attemptId}`);
  store.advanceAttemptState(attemptId, "remediating", "remediation_captured", `r13-remediation-captured:${attemptId}`);
  // After 5 advanceAttemptState calls, state_version = 5.
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
// TEST SUITE — Typed TransitionAuthority guard binds expectedRole
// ===========================================================================

describe("M7 scrutiny round 13 — TransitionAuthority.beginReviewAfterRemediation binds expectedRole in typed guard", () => {
  it("negative proof: remediator context CANNOT authorize the remediation_captured to reviewing edge through the typed TransitionAuthority API (guard fails closed)", () => {
    const fixture = buildRealAuthorityFixture("typed-authority-negative");

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

    // Call the TYPED TransitionAuthority.beginReviewAfterRemediation DIRECTLY
    // (not through the LifecycleEngine or AttemptRunner).  Pass the REMEDIATOR
    // context.  The guard must reject cross-role context substitution
    // fail-closed with RICKGENT_STATE_TRANSITION_ILLEGAL.
    const transitions = new TransitionAuthority(fixture.store);

    const remediationContextDigest = remediationContext.persisted.contextDigest as `sha256:${string}`;
    const attemptId = fixture.attempt.attemptId;

    let threw = false;
    try {
      transitions.beginReviewAfterRemediation({
        attemptId,
        contextId: remediationContext.persisted.contextId,
        expectedVersion,
        ownerContextDigest: remediationContextDigest,
        idempotencyKey: `r13-direct-cross-role:${attemptId}`,
        evidence: [Object.freeze({
          purpose: "review_after_remediation",
          inlineEvidence: Object.freeze({
            contextId: remediationContext.persisted.contextId,
            producerService: "ReviewService",
            scope: `direct-cross-role-test:${attemptId}`,
            schemaVersion: "rickgent.review-after-remediation.v1",
            payload: Object.freeze({
              attempt_id: attemptId,
              from_state: "remediation_captured",
              to_state: "reviewing",
              remediation_cycle: 1,
              context_digest: remediationContextDigest,
            }),
            idempotencyKey: `r13-direct-cross-role:${attemptId}`,
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

  it("positive proof: reviewer context CAN authorize the remediation_captured to reviewing edge through the typed TransitionAuthority API", () => {
    const fixture = buildRealAuthorityFixture("typed-authority-positive");

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

    // Call the typed TransitionAuthority.beginReviewAfterRemediation DIRECTLY
    // with a REVIEWER context.  This must succeed.
    const result = transitions.beginReviewAfterRemediation({
      attemptId,
      contextId: reviewerContext.persisted.contextId,
      expectedVersion,
      ownerContextDigest: reviewerContextDigest,
      idempotencyKey: `r13-direct-correct-role:${attemptId}`,
      evidence: [Object.freeze({
        purpose: "review_after_remediation",
        inlineEvidence: Object.freeze({
          contextId: reviewerContext.persisted.contextId,
          producerService: "ReviewService",
          scope: `direct-correct-role-test:${attemptId}`,
          schemaVersion: "rickgent.review-after-remediation.v1",
          payload: Object.freeze({
            attempt_id: attemptId,
            from_state: "remediation_captured",
            to_state: "reviewing",
            remediation_cycle: 1,
            context_digest: reviewerContextDigest,
          }),
          idempotencyKey: `r13-direct-correct-role:${attemptId}`,
        }),
      })],
    });

    expect(result.toState).toBe("reviewing");
    expect(result.fromState).toBe("remediation_captured");
  });
});
