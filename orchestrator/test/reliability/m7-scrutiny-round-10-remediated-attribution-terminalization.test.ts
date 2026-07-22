//
// M7 scrutiny round 10 — remediated attribution terminalization.
//
// After the remediation loop accepts a re-review, the AttemptRunner must
// UPDATE the commit attribution to use the remediated candidate OID (the
// one accepted by re-review).  Before the fix, the runner continues to use
// the ORIGINAL commit attribution for verification, oracle, and
// finalization.  The oracle rejects because the attribution points to the
// original candidate, not the remediated one.  The runner returns
// failed_clean instead of succeeded.
//
// This test:
//   1. Uses REAL production providers (buildAttemptRunnerProviders) for
//      review, commitAttribution, verification, oracle, cleanupPreimage.
//   2. Overrides ONLY dispatch (fixture) and remediation (fixture that
//      produces a clean candidate without the banned pattern).
//   3. Calls runner.runAttempt and asserts outcome === 'succeeded'
//      directly — NO try/catch, NO discarding the result.
//   4. Asserts the persisted commit attribution uses the REMEDIATED
//      candidate OID (not the original).
//
// Red against unfixed code: the runner returns failed_clean (oracle rejects
// because the attribution's candidateOid is the original, not the
// remediated candidate accepted by re-review).
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

function makeRepo(label = "m7r10"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r10-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R10 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r10@example.test"]);
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
    id: "t79",
    title: "M7 round 10 test",
    description: "Prove remediated attribution terminalization succeeds.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R10",
      description: "Remediated attribution flows through to terminalization.",
      interface_ids: [],
      verification_ids: ["VER-M7R10"],
    }],
    verifications: [{
      id: "VER-M7R10",
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
 * provider rejects it.  The remediation provider produces a clean candidate
 * (no banned pattern) so the re-review accepts.
 */
function buildRealAuthorityFixture(label = "real-authority-r10"): RealAuthorityFixture {
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
    supervisedArgv: ["/usr/bin/true"],
    stdoutPath: join(fixture.store.location.resourceDirectory, "stdout"),
    stderrPath: join(fixture.store.location.resourceDirectory, "stderr"),
    timeoutMs: 30_000,
    cancellationRequested: false,
  };
}

// ===========================================================================
// TEST SUITE — Remediated attribution terminalization
// ===========================================================================

describe("M7 scrutiny round 10 — remediated attribution terminalization", () => {
  it("runner.runAttempt returns outcome 'succeeded' after remediation loop accepts (not failed_clean)", async () => {
    const fixture = buildRealAuthorityFixture("remediated-attribution-terminalization");
    const { runner } = makeRealAuthorityRunner(fixture);

    // The test does NOT catch or discard the runner result.
    // It asserts the successful outcome directly.
    // Before the fix: the runner returns failed_clean because the oracle
    // rejects (the attribution's candidateOid is the original, not the
    // remediated candidate accepted by re-review).
    // After the fix: the runner updates the attribution to use the
    // remediated candidate OID after the loop accepts, so the oracle
    // evaluates the remediated candidate and the attempt succeeds.
    const result = await runner.runAttempt(makeRunnerRequest(fixture));

    // CRITICAL assertion: the outcome must be 'succeeded', not 'failed_clean'.
    expect(result.outcome).toBe("succeeded");
  });

  it("persisted commit attribution uses the remediated candidate OID (not the original)", async () => {
    const fixture = buildRealAuthorityFixture("remediated-attribution-persisted");
    const { runner } = makeRealAuthorityRunner(fixture);

    const result = await runner.runAttempt(makeRunnerRequest(fixture));
    expect(result.outcome).toBe("succeeded");

    // Query the StateStore for the persisted commit attribution and verify
    // its commit_oid (candidate OID) is NOT the original candidate.
    const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT commit_oid, tree_after_oid FROM commit_attributions WHERE attempt_id = ?`,
      ).all(fixture.attempt.attemptId) as Array<{ readonly commit_oid: string; readonly tree_after_oid: string }>;

      expect(rows.length).toBeGreaterThanOrEqual(1);

      // The persisted commit attribution's commit_oid must NOT be the
      // original candidate OID.  It must be the remediated candidate.
      for (const row of rows) {
        expect(row.commit_oid).not.toBe(fixture.candidateOid);
      }
    } finally {
      db.close();
    }
  });
});
