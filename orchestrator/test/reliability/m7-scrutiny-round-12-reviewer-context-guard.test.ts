//
// M7 scrutiny round 12 — remediation_captured to reviewing transition
// must use a REVIEWER execution context, not a REMEDIATOR context.
//
// The remediation_captured to reviewing edge is declared in the
// PHASE_TRANSITION_TABLE with evidenceProducer "ReviewService" and
// role "reviewer".  The execution-context guard must verify that the
// context's role matches the edge's declared owner role ("reviewer"),
// and must fail closed when a remediator context (role "remediator") is
// supplied instead.
//
// This test has two parts:
//   1. Negative proof: a REMEDIATOR context CANNOT authorize the
//      remediation_captured to reviewing edge.  The guard must reject
//      cross-role context substitution fail-closed.
//   2. Positive proof: a REVIEWER context CAN authorize the edge.
//      The production AttemptRunner creates and binds a REVIEWER context
//      before calling transitionAttempt for this edge.
//
// Red against unfixed code: the guard does not check role, so a remediator
// context passes the execution_context guard for the ReviewService edge.
// After the fix, the guard rejects the remediator context and the
// production path uses a reviewer context.
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
import {
  AttemptRunner,
  type AttemptRunnerRequest,
  type DispatchInput,
  type RemediationInput,
  type RemediationResult,
  type SupervisedDispatchResult,
} from "../../src/lifecycle/attempt-runner.js";
import { AttemptTerminalizationService } from "../../src/lifecycle/attempt-terminalization.js";
import { TargetStartGateAuthority } from "../../src/lifecycle/target-start-gate.js";
import { FixtureContainmentBackend } from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import {
  LifecycleEngine,
} from "../../src/lifecycle/engine.js";
import { TransitionAuthority } from "../../src/state/transitions.js";
import {
  openStateStore,
  canonicalGitDeltaFromRaw,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";
import { buildAttemptRunnerProviders } from "../../src/lifecycle/attempt-runner-providers.js";
import { writeObservedIdentityFixture } from "../helpers/observed-identity-fixture.js";

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

function makeRepo(label = "m7r12"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r12-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R12 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r12@example.test"]);
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
    id: "t81",
    title: "M7 round 12 test",
    description: "Prove remediation transition uses a REVIEWER context, not remediator.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R12",
      description: "Remediation transition carries a reviewer context.",
      interface_ids: [],
      verification_ids: ["VER-M7R12"],
    }],
    verifications: [{
      id: "VER-M7R12",
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
  readonly worktreePath: string;
  readonly baselineOid: string;
  readonly candidateOid: string;
  readonly targetStartGateId: string;
  readonly executionContext: AttemptExecutionContextAuthority;
}

function buildRealAuthorityFixture(label = "real-authority-r12"): RealAuthorityFixture {
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

  // Commit a candidate in the worktree with a banned pattern ("as any")
  // so the REAL production review provider rejects it on cycle 1.
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(
    join(provisioned.workspace.worktreePath, "src", "output.ts"),
    "export const x = 1 as any;\n",
    "utf8",
  );
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/output.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "candidate"]);
  const candidateOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);

  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "reset", "--hard", candidateOid]);

  return {
    repo, store, leases, contract: sealedContract, run, attempt,
    ownership, worktreePath: provisioned.workspace.worktreePath,
    baselineOid, candidateOid,
    targetStartGateId: `attempt-target-start-gate:${attempt.attemptId}`,
    executionContext: new AttemptExecutionContextAuthority(store),
  };
}

function makeRealAuthorityRunner(
  fixture: RealAuthorityFixture,
): {
  readonly runner: AttemptRunner;
} {
  const store = fixture.store;
  const leases = fixture.leases;
  const containment = new FixtureContainmentBackend();
  const targetStartGate = new TargetStartGateAuthority(store, leases, containment);
  const terminalization = new AttemptTerminalizationService(store, leases);
  const executionContext = fixture.executionContext;

  const realProviders = buildAttemptRunnerProviders(
    store,
    leases,
    undefined,
    undefined,
    { fixtureReviewerIdentity: true },
  );
  const mintCapability = leases.issueDispositionMintCapability();

  const runner = new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {
    cleanupPreimage: realProviders.cleanupPreimage,
    oracle: realProviders.oracle,
    commitAttribution: realProviders.commitAttribution,
    review: realProviders.review,
    verification: realProviders.verification,

    async dispatch(input: DispatchInput): Promise<SupervisedDispatchResult> {
      if (input.omnigentDataDir !== undefined) {
        writeObservedIdentityFixture(input.omnigentDataDir, {
          harness: "codex",
          model: "codex-cli",
          vendor: "fixture",
          conversationId: `impl-${input.ownership.attemptId}`,
        });
      }
      const launch = await containment.releaseTarget(
        input.boundary,
        input.argv,
        {
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          timeoutMs: input.timeoutMs,
          workdir: input.ownership.plan.worktreePath,
        },
      );
      let deathReceipt: import("../../src/process/containment.js").ContainmentDeathReceipt | null = null;
      try {
        await containment.kill(input.boundary);
        const emptiness = await containment.awaitEmpty(input.boundary, 5_000);
        deathReceipt = containment.mintDeathReceipt(input.boundary, emptiness);
      } catch { deathReceipt = null; }
      const attemptId = input.ownership.attemptId;
      const launchId = input.boundary.launchId;
      const processReceiptId = `process-receipt-${attemptId}`;
      const groupDeathEvidenceId = `evidence-death-${attemptId}`;
      const observedAt = new Date().toISOString();
      try {
        store.persistAuthorityProcessChain({
          launchId,
          processReceiptId,
          attemptId,
          ownershipId: input.ownership.ownership.ownershipId,
          ownerGeneration: input.ownership.ownership.generation,
          ownershipContextDigest: input.ownership.ownership.contextDigest,
          phaseExecutionId: input.phase.phaseExecutionId,
          contextId: input.phase.contextId,
          executionContextDigest: input.phase.contextDigest,
          repositoryId: store.location.repositoryId,
          argvDigest: sha256(JSON.stringify(input.argv)),
          environmentDigest: sha256(`env:${attemptId}`),
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          spawnAuthorizationDigest: sha256(`spawn-auth:${attemptId}`),
          exitCode: 0,
          timedOut: false,
          observedAt,
        }, mintCapability);
      } catch { /* best effort */ }
      return {
        outcome: "exited" as const,
        exitCode: 0,
        processReceiptId,
        processLaunchId: launchId,
        groupDeathEvidenceId,
        containmentDeathReceipt: deathReceipt,
        stdoutReceipt: launch.stdoutReceipt,
        stderrReceipt: launch.stderrReceipt,
        detail: "ok",
      };
    },

    remediation(input: RemediationInput): RemediationResult {
      const attemptId = input.ownership.attemptId;
      const phase = input.phase;
      const createdAt = input.ownership.ownership.heartbeatAt;
      const remediationRecordId = `remediation-${attemptId}-${input.cycle}`;
      const remediationEvidenceId = `evidence-remediation-${attemptId}-${input.cycle}`;

      execFileSync("git", ["-C", fixture.worktreePath, "reset", "--hard", fixture.baselineOid]);
      mkdirSync(join(fixture.worktreePath, "src"), { recursive: true });
      writeFileSync(
        join(fixture.worktreePath, "src", "output.ts"),
        `export const x = ${input.cycle + 1};\n`,
        "utf8",
      );
      execFileSync("git", ["-C", fixture.worktreePath, "add", "src/output.ts"]);
      execFileSync("git", ["-C", fixture.worktreePath, "commit", "-qm", `remediation-cycle-${input.cycle}`]);
      const newCandidateOid = git(fixture.worktreePath, "rev-parse", "HEAD");
      const attemptRef = `refs/rickgent/runs/${fixture.run.runId}/attempts/${attemptId}`;
      git(fixture.repo, "update-ref", attemptRef, newCandidateOid);

      let resultDiffDigest: string;
      try {
        const rawDiff = execFileSync("git", [
          "-C", fixture.repo, "diff", "--raw", "-z", "--no-abbrev", "-M",
          fixture.baselineOid, newCandidateOid,
        ], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
        resultDiffDigest = canonicalGitDeltaFromRaw(rawDiff).candidateDiffDigest;
      } catch {
        resultDiffDigest = sha256(`remediation-diff-unresolvable:${attemptId}:${input.cycle}`).slice("sha256:".length);
      }

      let resultTreeOid: string;
      try {
        resultTreeOid = execFileSync("git", [
          "-C", fixture.repo, "rev-parse", `${newCandidateOid}^{tree}`,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        resultTreeOid = newCandidateOid;
      }

      store.persistAuthorityEvidence({
        evidenceId: remediationEvidenceId, attemptId,
        phaseExecutionId: phase.phaseExecutionId, contextId: phase.contextId,
        producerService: "RemediationService", scope: remediationRecordId,
        schemaVersion: "rickgent.remediation.v1",
        payload: { attempt_id: attemptId, cycle: input.cycle, findings_count: input.findings.length, result_tree_oid: resultTreeOid, result_diff_digest: resultDiffDigest, previous_candidate_oid: input.attribution.candidateOid, new_candidate_oid: newCandidateOid },
        idempotencyKey: `remediation:${attemptId}:${input.cycle}`, observedAt: createdAt,
      }, mintCapability);

      return { remediationRecordId, resultTreeOid: newCandidateOid, resultDiffDigest, remediationEvidenceId };
    },
  });
  return { runner };
}

function makeRunnerRequest(fixture: RealAuthorityFixture): AttemptRunnerRequest {
  return {
    attempt: fixture.attempt,
    run: fixture.run,
    contract: fixture.contract,
    ownership: fixture.ownership,
    callerRepositoryRealpath: fixture.repo,
    targetStartGateId: fixture.targetStartGateId,
    supervisedPhase: {
      phaseExecutionId: "placeholder-implement",
      contextId: "placeholder-implement",
      contextDigest: sha256("placeholder-implement"),
      phase: "implement",
      phaseOrdinal: 1,
      role: "worker",
    },
    supervisedArgv: ["/usr/bin/true", "--harness", "codex", "--model", "codex-cli"],
    stdoutPath: join(fixture.store.location.resourceDirectory, "stdout"),
    stderrPath: join(fixture.store.location.resourceDirectory, "stderr"),
    timeoutMs: 30_000,
    cancellationRequested: false,
    omnigentDataDir: join(fixture.store.location.resourceDirectory, "omnigent-data"),
  };
}

// ===========================================================================
// TEST SUITE — Reviewer context guard for remediation_captured -> reviewing
// ===========================================================================

describe("M7 scrutiny round 12 — remediation_captured to reviewing transition uses REVIEWER context", () => {
  it("remediation_captured to reviewing transition owner_context_digest resolves to a REVIEWER execution context (not remediator)", async () => {
    const fixture = buildRealAuthorityFixture("reviewer-context-positive");
    const { runner } = makeRealAuthorityRunner(fixture);

    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    expect(result.outcome).toBe("succeeded");

    const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
    try {
      const transitions = db.prepare(
        `SELECT owner_context_digest
         FROM state_transitions
         WHERE attempt_id = ? AND from_state = 'remediation_captured' AND to_state = 'reviewing'
         ORDER BY entity_sequence`,
      ).all(fixture.attempt.attemptId) as Array<{ readonly owner_context_digest: string }>;

      expect(transitions.length).toBeGreaterThanOrEqual(1);

      for (const t of transitions) {
        // The owner_context_digest must resolve to an execution context
        // with role "reviewer" — NOT "remediator".
        const ctx = db.prepare(
          `SELECT context_id, attempt_id, role FROM execution_contexts WHERE context_digest = ?`,
        ).get(t.owner_context_digest) as { readonly context_id: string; readonly attempt_id: string; readonly role: string } | undefined;

        expect(ctx).toBeDefined();
        expect(ctx!.attempt_id).toBe(fixture.attempt.attemptId);
        // CRITICAL: the context's role must be "reviewer", not "remediator".
        expect(ctx!.role).toBe("reviewer");
      }
    } finally {
      db.close();
    }
  });

  it("negative proof: remediator context CANNOT authorize the remediation_captured to reviewing edge (guard fails closed)", async () => {
    const fixture = buildRealAuthorityFixture("reviewer-context-negative");

    // Ensure the policy context directory exists for the execution context resolver.
    mkdirSync(dirname(fixture.ownership.plan.policyContextPath), { recursive: true });

    // Build a remediation context (role "remediator") through the real authority API.
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

    // Manually transition the attempt through reviewing -> remediating ->
    // remediation_captured so we can test the remediation_captured ->
    // reviewing edge in isolation.
    const transitions = new TransitionAuthority(fixture.store);
    const lifecycle = new LifecycleEngine(fixture.store, transitions);

    // Walk the attempt forward to remediation_captured state.
    // First we need a process receipt and attribution for the
    // implementation_captured transition.  We'll use the store CAS path
    // (no authority) for the prerequisite edges since we're testing the
    // remediation_captured -> reviewing edge specifically.
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "planned",
      "implementing",
      `test-impl:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "implementing",
      "implementation_captured",
      `test-impl-captured:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "implementation_captured",
      "reviewing",
      `test-reviewing:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "reviewing",
      "remediating",
      `test-remediating:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "remediating",
      "remediation_captured",
      `test-remediation-captured:${fixture.attempt.attemptId}`,
    );

    // Now attempt the remediation_captured -> reviewing transition
    // through the LifecycleEngine with a REMEDIATOR context.
    // The guard must reject this cross-role context substitution.
    // The rejection is fail-closed: the store's execution_context guard
    // throws RICKGENT_STATE_TRANSITION_ILLEGAL (a StateStoreError) or the
    // engine wraps it as a LifecycleEngineError.  Either is a valid
    // fail-closed rejection.
    let threw = false;
    try {
      lifecycle.transitionAttempt({
        attemptId: fixture.attempt.attemptId,
        from: "remediation_captured",
        to: "reviewing",
        idempotencyKey: `test-cross-role:${fixture.attempt.attemptId}`,
        contextId: remediationContext.persisted.contextId,
        contextDigest: remediationContext.persisted.contextDigest as `sha256:${string}`,
        evidence: [Object.freeze({
          purpose: "review_after_remediation",
          inlineEvidence: Object.freeze({
            contextId: remediationContext.persisted.contextId,
            producerService: "ReviewService",
            scope: `cross-role-test:${fixture.attempt.attemptId}`,
            schemaVersion: "rickgent.review-after-remediation.v1",
            payload: Object.freeze({
              attempt_id: fixture.attempt.attemptId,
              from_state: "remediation_captured",
              to_state: "reviewing",
              remediation_cycle: 1,
              context_digest: remediationContext.persisted.contextDigest,
            }),
            idempotencyKey: `test-cross-role:${fixture.attempt.attemptId}`,
          }),
        })],
      });
    } catch (err) {
      threw = true;
      // The error must be a fail-closed rejection with a code indicating
      // the transition was illegal (either StateStoreError or
      // LifecycleEngineError wrapping it).
      const code = (err as { readonly code?: string }).code;
      expect(code).toBeDefined();
      expect(code).toMatch(/RICKGENT_STATE_TRANSITION_ILLEGAL|RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL/);
    }
    expect(threw).toBe(true);
  });

  it("positive proof: reviewer context CAN authorize the remediation_captured to reviewing edge", async () => {
    const fixture = buildRealAuthorityFixture("reviewer-context-positive-unit");

    // Ensure the policy context directory exists for the execution context resolver.
    mkdirSync(dirname(fixture.ownership.plan.policyContextPath), { recursive: true });

    // Build a reviewer context (role "reviewer") through the real authority API.
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

    // Walk the attempt forward to remediation_captured state.
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "planned",
      "implementing",
      `test-impl-p:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "implementing",
      "implementation_captured",
      `test-impl-captured-p:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "implementation_captured",
      "reviewing",
      `test-reviewing-p:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "reviewing",
      "remediating",
      `test-remediating-p:${fixture.attempt.attemptId}`,
    );
    fixture.store.advanceAttemptState(
      fixture.attempt.attemptId,
      "remediating",
      "remediation_captured",
      `test-remediation-captured-p:${fixture.attempt.attemptId}`,
    );

    const transitions = new TransitionAuthority(fixture.store);
    const lifecycle = new LifecycleEngine(fixture.store, transitions);

    // Attempt the remediation_captured -> reviewing transition with a
    // REVIEWER context.  This must succeed.
    const result = lifecycle.transitionAttempt({
      attemptId: fixture.attempt.attemptId,
      from: "remediation_captured",
      to: "reviewing",
      idempotencyKey: `test-correct-role:${fixture.attempt.attemptId}`,
      contextId: reviewerContext.persisted.contextId,
      contextDigest: reviewerContext.persisted.contextDigest as `sha256:${string}`,
      evidence: [Object.freeze({
        purpose: "review_after_remediation",
        inlineEvidence: Object.freeze({
          contextId: reviewerContext.persisted.contextId,
          producerService: "ReviewService",
          scope: `correct-role-test:${fixture.attempt.attemptId}`,
          schemaVersion: "rickgent.review-after-remediation.v1",
          payload: Object.freeze({
            attempt_id: fixture.attempt.attemptId,
            from_state: "remediation_captured",
            to_state: "reviewing",
            remediation_cycle: 1,
            context_digest: reviewerContext.persisted.contextDigest,
          }),
          idempotencyKey: `test-correct-role:${fixture.attempt.attemptId}`,
        }),
      })],
    });

    expect(result.toState).toBe("reviewing");
    expect(result.edge.evidenceProducer).toBe("ReviewService");
  });
});
