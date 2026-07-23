//
// M7 scrutiny round 11 — remediation_captured to reviewing transition
// must route through the LifecycleEngine's TransitionAuthority.
//
// In attempt-runner.ts, the remediation flow directly persisted the
// remediation_captured to reviewing transition via
// StateStore.advanceAttemptState, bypassing the LifecycleEngine, its
// ReviewService ownership, and the execution-context guard.  The resulting
// durable transition carried placeholder authority metadata
// (owner_service "AttemptLifecycleService", owner_context_digest all-zeros),
// violating M7's one lifecycle engine and fail-closed requirements.
//
// This test drives the REAL production path (AttemptRunner with real
// providers) through a remediation cycle, then queries the StateStore's
// state_transitions table for the remediation_captured to reviewing
// transition record and verifies:
//   1. owner_service is "ReviewService" (the edge's declared owner),
//      NOT "AttemptLifecycleService" (the placeholder from the direct
//      store bypass).
//   2. owner_context_digest is a real context digest (NOT the all-zeros
//      placeholder "sha256:000...0").
//   3. The transition has at least one evidence reference in
//      transition_evidence_refs (the direct store bypass persists zero
//      evidence refs).
//
// Red against unfixed code: the transition has owner_service
// "AttemptLifecycleService", all-zeros context digest, and zero evidence
// refs — because it was persisted by advanceAttemptState, not the
// TransitionAuthority.
//

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeRepo(label = "m7r11"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r11-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R11 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r11@example.test"]);
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
    id: "t80",
    title: "M7 round 11 test",
    description: "Prove remediation transition routes through LifecycleEngine authority.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R11",
      description: "Remediation transition carries real authority evidence.",
      interface_ids: [],
      verification_ids: ["VER-M7R11"],
    }],
    verifications: [{
      id: "VER-M7R11",
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
// Fixture: real authority API setup (NO direct SQL with FK disabled)
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
}

/**
 * Build a fixture using ONLY real authority APIs.  The first candidate
 * contains a banned pattern ("as any") so the REAL production review
 * provider rejects it on cycle 1.  The remediation provider produces a
 * clean candidate (no banned pattern) so the re-review accepts.
 */
function buildRealAuthorityFixture(label = "real-authority-r11"): RealAuthorityFixture {
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
  };
}

/**
 * Build a runner that uses the REAL production review/commitAttribution/
 * verification/oracle/cleanupPreimage providers from
 * buildAttemptRunnerProviders.  Only dispatch and remediation are
 * overridden with fixture implementations.
 */
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
  const executionContext = new AttemptExecutionContextAuthority(store);

  const realProviders = buildAttemptRunnerProviders(store, leases);
  const mintCapability = leases.issueDispositionMintCapability();

  const runner = new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {
    cleanupPreimage: realProviders.cleanupPreimage,
    oracle: realProviders.oracle,
    commitAttribution: realProviders.commitAttribution,
    review: realProviders.review,
    verification: realProviders.verification,

    // Override ONLY the dispatch provider (fixture that completes quickly).
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

    // Fixture remediation provider: writes a clean candidate and commits.
    remediation(input: RemediationInput): RemediationResult {
      const attemptId = input.ownership.attemptId;
      const phase = input.phase;
      const createdAt = input.ownership.ownership.heartbeatAt;
      const remediationRecordId = `remediation-${attemptId}-${input.cycle}`;
      const remediationEvidenceId = `evidence-remediation-${attemptId}-${input.cycle}`;

      // Write a clean version of the file (different from the original).
      // Reset to the baseline first so the remediated commit has the
      // delivery baseline as its sole parent (required by the promotion
      // intent validation).
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

// The all-zeros placeholder digest used by StateStore.advanceAttemptState.
const PLACEHOLDER_DIGEST = "sha256:" + "0".repeat(64);

// ===========================================================================
// TEST SUITE — Remediation transition authority
// ===========================================================================

describe("M7 scrutiny round 11 — remediation_captured to reviewing transition authority", () => {
  it("runner.runAttempt succeeds after remediation loop accepts", async () => {
    const fixture = buildRealAuthorityFixture("remediation-transition-authority");
    const { runner } = makeRealAuthorityRunner(fixture);

    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    expect(result.outcome).toBe("succeeded");
  });

  it("remediation_captured to reviewing transition has owner_service ReviewService (not AttemptLifecycleService placeholder)", async () => {
    const fixture = buildRealAuthorityFixture("remediation-transition-owner-service");
    const { runner } = makeRealAuthorityRunner(fixture);

    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    expect(result.outcome).toBe("succeeded");

    // Query the StateStore for the remediation_captured to reviewing
    // transition record.  This transition must have been created by the
    // LifecycleEngine's TransitionAuthority, not by a direct
    // StateStore.advanceAttemptState call.
    const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT transition_id, owner_service, owner_context_digest
         FROM state_transitions
         WHERE attempt_id = ? AND from_state = 'remediation_captured' AND to_state = 'reviewing'
         ORDER BY entity_sequence`,
      ).all(fixture.attempt.attemptId) as Array<{
        readonly transition_id: string;
        readonly owner_service: string;
        readonly owner_context_digest: string;
      }>;

      // At least one remediation_captured to reviewing transition must
      // exist (the first remediation cycle produces one).
      expect(rows.length).toBeGreaterThanOrEqual(1);

      for (const row of rows) {
        // CRITICAL: owner_service must be "ReviewService" (the edge's
        // declared owner in the PHASE_TRANSITION_TABLE and
        // ATTEMPT_TRANSITIONS catalog), NOT "AttemptLifecycleService"
        // (the placeholder used by the direct store bypass).
        expect(row.owner_service).toBe("ReviewService");

        // CRITICAL: owner_context_digest must NOT be the all-zeros
        // placeholder.  It must be a real context digest from a persisted
        // execution context.
        expect(row.owner_context_digest).not.toBe(PLACEHOLDER_DIGEST);
      }
    } finally {
      db.close();
    }
  });

  it("remediation_captured to reviewing transition has real evidence references (not zero)", async () => {
    const fixture = buildRealAuthorityFixture("remediation-transition-evidence");
    const { runner } = makeRealAuthorityRunner(fixture);

    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    expect(result.outcome).toBe("succeeded");

    // Query the StateStore for the transition evidence references.
    // The direct store bypass (advanceAttemptState) persists ZERO
    // evidence references.  The TransitionAuthority path persists at
    // least one evidence reference per transition.
    const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
    try {
      const transitions = db.prepare(
        `SELECT transition_id
         FROM state_transitions
         WHERE attempt_id = ? AND from_state = 'remediation_captured' AND to_state = 'reviewing'
         ORDER BY entity_sequence`,
      ).all(fixture.attempt.attemptId) as Array<{ readonly transition_id: string }>;

      expect(transitions.length).toBeGreaterThanOrEqual(1);

      for (const t of transitions) {
        const refs = db.prepare(
          `SELECT purpose, evidence_id FROM transition_evidence_refs WHERE transition_id = ? ORDER BY ordinal`,
        ).all(t.transition_id) as Array<{ readonly purpose: string; readonly evidence_id: string }>;

        // CRITICAL: the transition MUST have at least one evidence
        // reference.  The direct store bypass persists zero.
        expect(refs.length).toBeGreaterThanOrEqual(1);

        // Each evidence reference must have a non-empty purpose and
        // evidence_id (not placeholder/empty values).
        for (const ref of refs) {
          expect(ref.purpose.length).toBeGreaterThan(0);
          expect(ref.evidence_id.length).toBeGreaterThan(0);
        }
      }
    } finally {
      db.close();
    }
  });

  it("remediation_captured to reviewing transition owner_context_digest resolves to a real execution context", async () => {
    const fixture = buildRealAuthorityFixture("remediation-transition-context");
    const { runner } = makeRealAuthorityRunner(fixture);

    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    expect(result.outcome).toBe("succeeded");

    // Verify that the owner_context_digest on the transition record
    // corresponds to a real execution_context row for this attempt.
    // The direct store bypass uses an all-zeros digest that does NOT
    // resolve to any execution context.
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
        // The owner_context_digest must resolve to a real execution
        // context for this attempt.
        const ctx = db.prepare(
          `SELECT context_id, attempt_id FROM execution_contexts WHERE context_digest = ?`,
        ).get(t.owner_context_digest) as { readonly context_id: string; readonly attempt_id: string } | undefined;

        expect(ctx).toBeDefined();
        expect(ctx!.attempt_id).toBe(fixture.attempt.attemptId);
      }
    } finally {
      db.close();
    }
  });
});
