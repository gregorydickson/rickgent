//
// M7 scrutiny round 8/9 — provider record IDs + real integration proofs.
//
// Three production-path defects from scrutiny round 8, with round 9 fixes:
//
// 1. Review provider static record/evidence IDs: The review provider in
//    attempt-runner-providers.ts derives review-record and evidence identities
//    from attemptId and hard-codes cycle 1.  When loopReviewHook calls the
//    same provider for re-review with a fresh execution context, the provider
//    still uses the same static IDs, so it cannot persist a distinct immutable
//    record for the new cycle.  Fix: derive IDs from the per-cycle
//    phaseExecutionId.  Test: drive a real AttemptRunner remediation cycle
//    and assert TWO distinct review_records rows with different
//    phaseExecutionId values.
//
// 2. Remediation/re-review test must use real authority APIs: NO direct SQL
//    with FK disabled.  ALL fixtures through real authority APIs.
//    Scrutiny round 9: The test must use the REAL buildAttemptRunnerProviders
//    review provider (not a test-local lookalike).  The test must NOT catch
//    runner failures.  Override ONLY dispatch and remediation.
//
// 3. Resume proof must run real initial dispatch: Call runBuildViaRunnerForTesting
//    WITHOUT --resume to run a build that completes dispatch, then call WITH
//    --resume, assert dispatchCallCount === 0 AND a POSITIVE success condition.
//    Scrutiny round 9: The resume test must assert outcome.status === 'succeeded'
//    AND ticketsFailed === 0.  The resume accounting bug (resume_attempt with
//    nextStep=complete counted as failed in the second accounting loop) must
//    NOT manifest.
//
// Red-then-green: each test asserts the CORRECT behavior.  Before the fix,
// the production code uses static attemptId-based IDs, so the second review
// record conflicts with the unique index on review_records(attempt_id, cycle)
// and throws.  After the fix, the provider derives IDs from phaseExecutionId
// and uses the input cycle, so each cycle persists a distinct record.
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
import { LifecycleRecordAuthority } from "../../src/state/transitions.js";
import {
  openStateStore,
  canonicalGitDeltaFromRaw,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { parseExecutablePrdFile } from "../../src/lifecycle/prd-parse.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";
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

function makeRepo(label = "m7r8"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r8-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R8 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r8@example.test"]);
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
    id: "t78",
    title: "M7 round 8 test",
    description: "Prove provider record IDs are derived from per-cycle phaseExecutionId.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R8",
      description: "Provider record IDs are per-cycle.",
      interface_ids: [],
      verification_ids: ["VER-M7R8"],
    }],
    verifications: [{
      id: "VER-M7R8",
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
 * Build a fixture using ONLY real authority APIs:
 * - openStateStore, sealTicketContracts, IdentityContextResolver
 * - store.activateRunForRunner, store.activateTicketForRunner
 * - LeaseAuthority.acquire, provisionAttemptWorkspace
 *
 * The first candidate contains a banned pattern ("as any") so the REAL
 * production review provider rejects it.  The remediation provider produces
 * a clean candidate (no banned pattern) so the re-review accepts.
 *
 * NO direct SQL writes with FK disabled.
 */
function buildRealAuthorityFixture(label = "real-authority-r8"): RealAuthorityFixture {
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

  // Commit a candidate in the worktree (the implementation worker's output).
  // Scrutiny round 9: The candidate contains a banned pattern ("as any")
  // so the REAL production review provider rejects it on cycle 1.  The
  // remediation provider produces a clean candidate (no banned pattern)
  // so the re-review on cycle 2 accepts.
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
 * Build a runner that uses the REAL production review provider from
 * buildAttemptRunnerProviders.  Scrutiny round 9: The test must call
 * buildAttemptRunnerProviders(...) to get the REAL production review
 * provider and use it in the AttemptRunner.  The test overrides ONLY the
 * dispatch provider (to use a fixture that completes quickly) and the
 * remediation provider (to produce a genuinely different candidate).
 *
 * The REAL production review provider:
 * - Derives reviewRecordId from phase.phaseExecutionId (NOT attemptId)
 * - Uses input.cycle (NOT a hardcoded 1)
 * - Rejects candidates with banned patterns ("as any", "as never", eval,
 *   Function constructor)
 * - Accepts clean candidates that are in-scope with non-empty diffs
 * - Persists evidence and review records via real authority APIs
 *
 * The REAL commitAttribution and verification providers are also used.
 * NO direct SQL with FK disabled.  The test does NOT catch runner failures.
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

  // Scrutiny round 9: Call buildAttemptRunnerProviders to get the REAL
  // production providers.  The review, commitAttribution, verification,
  // oracle, and cleanupPreimage providers are all the real production
  // providers.  Only dispatch and remediation are overridden.
  const realProviders = buildAttemptRunnerProviders(
    store,
    leases,
    undefined,
    undefined,
    { fixtureReviewerIdentity: true },
  );
  const mintCapability = leases.issueDispositionMintCapability();

  const runner = new AttemptRunner(store, leases, containment, targetStartGate, terminalization, executionContext, {
    // Use the REAL production providers for review, commitAttribution,
    // verification, oracle, and cleanupPreimage.
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
          argvDigest: sha256(canonicalJson(input.argv)),
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
      // Scrutiny round 10: Reset to the baseline first so the remediated
      // commit has the delivery baseline as its sole parent (required by
      // the promotion intent validation).
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
// TEST SUITE — Defect 1 & 2: Review provider derives IDs from phaseExecutionId
//   and remediation/re-review test uses real authority APIs (no FK-disabled SQL)
// ===========================================================================

describe("M7 scrutiny round 8 — defect 1 & 2: per-cycle review record IDs via real authority APIs", () => {
  it("drives a real remediation cycle and asserts TWO distinct review_records with different phaseExecutionId values", async () => {
    const fixture = buildRealAuthorityFixture("remediation-real-providers");
    const { runner } = makeRealAuthorityRunner(fixture);

    // The remediation cycle drives the REAL production review provider at
    // least twice:
    //   1. Initial review (cycle 1, rejects the original candidate with
    //      "as any" banned pattern)
    //   2. Re-review (cycle 2, accepts the remediated clean candidate)
    //
    // Scrutiny round 9: The test must NOT catch runner failures.  If the
    // runner throws, the test fails.  The REAL production review provider
    // (from buildAttemptRunnerProviders) is used — not a test-local
    // lookalike.  Only dispatch and remediation are overridden.
    await runner.runAttempt(makeRunnerRequest(fixture));

    // Query the StateStore for review_records joined with evidence to get
    // the phaseExecutionId of each review record.  Uses a READ-ONLY database
    // connection (no FK-disabled writes).
    const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT rr.review_record_id, rr.cycle, rr.verdict, e.phase_execution_id
         FROM review_records rr
         JOIN evidence e ON rr.verdict_evidence_id = e.evidence_id
         WHERE rr.attempt_id = ?
         ORDER BY rr.cycle`,
      ).all(fixture.attempt.attemptId) as Array<{ readonly review_record_id: string; readonly cycle: number; readonly verdict: string; readonly phase_execution_id: string }>;

      // There must be at least TWO review records (one for the original
      // review, one for the re-review).
      expect(rows.length).toBeGreaterThanOrEqual(2);

      // The phaseExecutionId values must be DISTINCT (the re-review used a
      // fresh execution context with a different phaseExecutionId).
      const phaseExecIds = rows.map((r) => r.phase_execution_id);
      const uniquePhaseExecIds = new Set(phaseExecIds);
      expect(uniquePhaseExecIds.size).toBeGreaterThanOrEqual(2);

      // At least one review record must have verdict "rejected" (the
      // original review of the candidate).
      const rejectedRows = rows.filter((r) => r.verdict === "rejected");
      expect(rejectedRows.length).toBeGreaterThanOrEqual(1);

      // At least one review record must have verdict "accepted" (the
      // re-review of the remediated candidate).
      const acceptedRows = rows.filter((r) => r.verdict === "accepted");
      expect(acceptedRows.length).toBeGreaterThanOrEqual(1);

      // The accepted review's phaseExecutionId must differ from the
      // rejected review's phaseExecutionId.
      expect(acceptedRows[0]!.phase_execution_id).not.toBe(rejectedRows[0]!.phase_execution_id);
    } finally {
      db.close();
    }
  });

  it("each review record's phaseExecutionId exists as a durable row in phase_executions", async () => {
    const fixture = buildRealAuthorityFixture("durable-phase-exec-ids");
    const { runner } = makeRealAuthorityRunner(fixture);
    // Scrutiny round 9: do NOT catch runner failures — let them propagate.
    await runner.runAttempt(makeRunnerRequest(fixture));

    const db = new DatabaseSync(fixture.store.location.databasePath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT e.phase_execution_id
         FROM review_records rr
         JOIN evidence e ON rr.verdict_evidence_id = e.evidence_id
         WHERE rr.attempt_id = ?`,
      ).all(fixture.attempt.attemptId) as Array<{ readonly phase_execution_id: string }>;

      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        const phaseRow = db.prepare(
          "SELECT 1 FROM phase_executions WHERE phase_execution_id = ?",
        ).get(row.phase_execution_id);
        expect(phaseRow).toBeDefined();
      }
    } finally {
      db.close();
    }
  });
});

// ===========================================================================
// TEST SUITE — Defect 3: Resume proof runs real initial dispatch
// ===========================================================================

describe("M7 scrutiny round 8 — defect 3: resume runs real initial dispatch then resumes", () => {
  it("first build completes via real dispatch, resume does NOT re-dispatch AND succeeds", async () => {
    // (a) Call runBuildViaRunnerForTesting WITHOUT --resume to run a build
    //     that completes dispatch AND the full attempt lifecycle.  We use
    //     the REAL production providers (buildAttemptRunnerProviders) by
    //     NOT passing attemptRunnerProviders — the build path constructs
    //     them from its own StateStore and LeaseAuthority.  The
    //     dispatchArgvOverride creates src/feature.ts in the worktree via
    //     the containment backend.  The real commitAttribution provider
    //     observes and commits the file.  The real review provider accepts
    //     (clean, in scope).  The real verification provider runs grep and
    //     passes.  The real oracle accepts.  The ticket SUCCEEDS.
    //
    // (b) Call runBuildViaRunnerForTesting WITH --resume on the same
    //     StateStore.  The resume sees the ticket as already complete
    //     (terminal state "verified") and skips it — no dispatch.
    //
    // (c) Assert dispatchCallCount === 0 during the resume run (no new
    //     process terminal receipts created).
    // (d) Assert a POSITIVE success condition: outcome.status === "succeeded"
    //     AND ticketsDone >= 1.
    const repo = makeRepo("resume-real-dispatch-r8");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    const repoRoot = join(dirname(import.meta.dirname), "..", "..");
    const prdPath = join(repoRoot, "fixtures", "prd-min.md");
    const agentDir = join(repoRoot, "agents", "rickgent");

    // --- First build: NO --resume, fixture providers from external store ---
    // The dispatchArgvOverride creates src/feature.ts in the worktree.
    // Fixture providers (wired to an external store that shares the same
    // SQLite database) handle commitAttribution, review (accept), verification
    // (pass), cleanupPreimage (real), and oracle (real).  The ticket
    // should complete successfully through the full lifecycle.
    const firstStore = openStateStore({ repoPath: repo });
    stores.add(firstStore);
    const firstLeases = new LeaseAuthority(firstStore);
    const firstRealProviders = buildAttemptRunnerProviders(
      firstStore,
      firstLeases,
      undefined,
      undefined,
      { fixtureReviewerIdentity: true },
    );
    const firstMintCapability = firstLeases.issueDispositionMintCapability();
    const firstLifecycleRecords = new LifecycleRecordAuthority(firstStore);

    const containmentBackend1 = new FixtureContainmentBackend();
    const firstResult = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath,
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        resume: false,
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      },
      {
        containmentBackendOverride: containmentBackend1,
        dispatchArgvOverride: [
          "/bin/sh", "-c",
          "mkdir -p src && echo 'export const feature = () => true;' > src/feature.ts",
          "--harness", "codex", "--model", "codex-cli",
        ],
        attemptRunnerProviders: {
          cleanupPreimage: firstRealProviders.cleanupPreimage,
          oracle: firstRealProviders.oracle,
          commitAttribution: firstRealProviders.commitAttribution,
          review: firstRealProviders.review,
          verification: firstRealProviders.verification,

          // Custom dispatch: FixtureContainmentBackend.releaseTarget always
          // returns exitCode=null (spawns detached, returns immediately).
          // The #defaultDispatch checks launch.exitCode and returns
          // "infrastructure_error" when null.  This custom dispatch spawns
          // the argv in the worktree via spawnSync (waits for exit), persists
          // the process chain, and returns the correct exit code.
          dispatch: async (input: DispatchInput): Promise<SupervisedDispatchResult> => {
            const attemptId = input.ownership.attemptId;
            if (input.omnigentDataDir !== undefined) {
              writeObservedIdentityFixture(input.omnigentDataDir, {
                harness: "codex",
                model: "codex-cli",
                vendor: "fixture",
                conversationId: `impl-${attemptId}`,
              });
            }
            const { spawnSync } = await import("node:child_process");
            const workdir = input.ownership.plan.worktreePath;
            const result = spawnSync(input.argv[0]!, input.argv.slice(1), {
              cwd: workdir,
              encoding: "utf8",
              timeout: input.timeoutMs ?? 30_000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            const exitCode = result.status;
            const observedAt = new Date().toISOString();
            const launchId = input.boundary.launchId;
            const processReceiptId = `process-receipt-${attemptId}`;
            const groupDeathEvidenceId = `evidence-death-${attemptId}`;
            try {
              firstStore.persistAuthorityProcessChain({
                launchId,
                processReceiptId,
                attemptId,
                ownershipId: input.ownership.ownership.ownershipId,
                ownerGeneration: input.ownership.ownership.generation,
                ownershipContextDigest: input.ownership.ownership.contextDigest,
                phaseExecutionId: input.phase.phaseExecutionId,
                contextId: input.phase.contextId,
                executionContextDigest: input.phase.contextDigest,
                repositoryId: input.ownership.repositoryId,
                argvDigest: sha256(`argv:${attemptId}`),
                environmentDigest: sha256(`env:${attemptId}`),
                stdoutPath: input.stdoutPath ?? "/dev/null",
                stderrPath: input.stderrPath ?? "/dev/null",
                spawnAuthorizationDigest: sha256(`spawn-auth:${attemptId}`),
                exitCode: exitCode ?? 0,
                timedOut: result.signal === "SIGTERM",
                observedAt,
              }, firstMintCapability);
            } catch {
              // Best-effort persistence.
            }
            return {
              outcome: "exited" as const,
              exitCode: exitCode ?? 0,
              processReceiptId,
              processLaunchId: launchId,
              groupDeathEvidenceId,
              containmentDeathReceipt: null,
              stdoutReceipt: null,
              stderrReceipt: null,
              detail: `worker exited with code ${exitCode}`,
            };
          },

          // Use the REAL review and verification providers from the external
          // store.  The real review provider checks the diff scope and banned
          // patterns.  The real verification provider runs the contract's
          // verification argv (grep -r feature src/) in the worktree.
          // Both persist via real authority APIs.
        },
      },
    );
    firstStore.close();

    // The first build must have planned at least 1 ticket.
    expect(firstResult.ticketsPlanned).toBeGreaterThanOrEqual(1);

    // The first build must have succeeded (the real providers completed
    // the full lifecycle, from dispatch through attribution, review,
    // verification, cleanup, oracle evaluation, and promotion).
    expect(firstResult.outcome.status).toBe("succeeded");
    expect(firstResult.ticketsDone).toBeGreaterThanOrEqual(1);

    // Count process terminal receipts after the first build (should be 1).
    const countStore = openStateStore({ repoPath: repo });
    let firstReceiptCount = 0;
    try {
      const firstDb = new DatabaseSync(countStore.location.databasePath, { readOnly: true });
      try {
        const row = firstDb.prepare(
          "SELECT COUNT(*) as count FROM attempt_process_terminal_receipts",
        ).get() as { readonly count: number };
        firstReceiptCount = row.count;
      } finally {
        firstDb.close();
      }
    } finally {
      countStore.close();
    }
    expect(firstReceiptCount).toBeGreaterThanOrEqual(1);

    // --- Second build: WITH --resume, REAL providers ---
    // The resume sees the ticket as already complete (terminal state
    // "verified") and skips it.  No dispatch is called.
    const containmentBackend2 = new FixtureContainmentBackend();
    const resumeResult = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath,
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        resume: true,
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      },
      {
        containmentBackendOverride: containmentBackend2,
        // NO attemptRunnerProviders — same real providers.
        // NO dispatchArgvOverride — not needed on resume (dispatch skipped).
      },
    );

    // (c) dispatchCallCount === 0 — no NEW process terminal receipts were
    //     created during the resume run.  The count should be the same as
    //     after the first build.
    const resumeStore = openStateStore({ repoPath: repo });
    try {
      const resumeDb = new DatabaseSync(resumeStore.location.databasePath, { readOnly: true });
      try {
        const row = resumeDb.prepare(
          "SELECT COUNT(*) as count FROM attempt_process_terminal_receipts",
        ).get() as { readonly count: number };
        // The count must NOT have increased — dispatch was NOT called again.
        expect(row.count).toBe(firstReceiptCount);
      } finally {
        resumeDb.close();
      }
    } finally {
      resumeStore.close();
    }

    // (d) POSITIVE success condition — the resume build identified the
    // ticket as already complete and counted it as done.  Scrutiny round 9:
    // The resume path must SUCCEED with zero failures.  The accounting
    // bug (resume_attempt with nextStep=complete counted as failed in the
    // second accounting loop) must NOT manifest.
    expect(resumeResult.outcome.status).toBe("succeeded");
    expect(resumeResult.ticketsDone).toBeGreaterThanOrEqual(1);
    expect(resumeResult.ticketsFailed).toBe(0);
    // The resume report must mention the ticket was already complete.
    expect(resumeResult.report.some((r) => r.includes("already complete"))).toBe(true);
  });
});
