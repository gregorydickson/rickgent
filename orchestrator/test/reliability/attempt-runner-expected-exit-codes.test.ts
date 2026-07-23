/**
 * m4-fix-expected-exit-codes: M4 scrutiny round 6 blocking defect.
 *
 * The verification provider in attempt-runner-providers.ts treated every
 * nonzero verification exit as failed and ignored
 * `TicketVerification.expected_exit_codes`. A permitted nonzero exit (e.g., a
 * linter that exits 1 on warnings but is configured with `expected_exit_codes
 * [0, 1]`) could not successfully terminalize a valid contract — the provider
 * returned `status: "fail"` and the gate result was persisted as "failed",
 * so the oracle rejected and the runner branched to the ordinary-failure
 * state machine instead of terminalizing.
 *
 * Fix: pass each verification's sealed `expected_exit_codes` to the
 * command-result classifier and compare the observed exit against that
 * allowlist. Exit code is "pass" if it is in `expected_exit_codes`; "fail"
 * otherwise.
 *
 * Tests:
 *   (a) accepted nonzero exit: `expected_exit_codes` includes a nonzero
 *       value, the command exits with that value, verification passes
 *       (status "pass", gate status "passed").
 *   (b) excluded exit fails closed: `expected_exit_codes` is `[0, 1]`, the
 *       command exits with 2 (NOT in the allowlist), verification fails
 *       (status "fail", gate status "failed").
 *   (c) structural: the provider source passes per-verification
 *       `expected_exit_codes` to the classifier and does NOT hardcode
 *       `e.status === 0` as the only pass condition.
 *
 * Red-then-green proof: before the fix, test (a) fails because exit 1 is
 * classified as "fail" even though `expected_exit_codes` includes 1; the
 * structural test fails because the source hardcodes `e.status === 0`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver, type ResolvedPhaseContext } from "../../src/context/resolver.js";
import { AttemptExecutionContextAuthority } from "../../src/context/attempt-execution-context.js";
import { buildAttemptRunnerProviders } from "../../src/lifecycle/attempt-runner-providers.js";
import { FixtureContainmentBackend } from "../../src/process/containment.js";
import { LeaseAuthority } from "../../src/state/leases.js";
import { RICKGENT_ORACLE_VERSION } from "../../src/state/oracle.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateStore,
} from "../../src/state/store.js";
import { provisionAttemptWorkspace } from "../../src/git/attempt-workspace.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const ORACLE_VERSION = RICKGENT_ORACLE_VERSION;
const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
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

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value), "utf8",
  ).digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-exit-codes-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Exit-Codes Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "exit-codes@example.test"]);
  writeFileSync(join(repo, "README.md"), "expected exit codes\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function openRaw(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, { enableForeignKeyConstraints: false, timeout: 1_000 });
}

function updateRow(databasePath: string, table: string, idColumn: string, id: string, changes: Readonly<Record<string, SqlValue>>): void {
  const database = openRaw(databasePath);
  try {
    const columns = Object.keys(changes);
    const result = database.prepare(
      `UPDATE "${table}" SET ${columns.map((c) => `"${c}" = ?`).join(", ")} WHERE "${idColumn}" = ?`,
    ).run(...columns.map((c) => changes[c] ?? null), id);
    expect(result.changes).toBe(1);
  } finally {
    database.close();
  }
}

function queryAll(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

/**
 * Build a contract draft with a single verification whose exit code is
 * controlled by `node -e "process.exit(N)"`.  The `expectedExitCodes`
 * parameter is the contract's sealed allowlist.
 */
function exitCodeDraft(opts: {
  readonly expectedExitCodes: readonly number[];
  readonly exitCode: number;
}): TicketContractDraft {
  const verificationId = "VER-EXIT";
  return {
    schema_version: "1.0.0",
    id: "t91",
    title: "Expected exit codes",
    description: "Prove the verification provider honors TicketVerification.expected_exit_codes.",
    depends_on: [],
    scope: [{ path: "src/feature.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-EXIT",
      description: "Verification honors expected_exit_codes.",
      interface_ids: [],
      verification_ids: [verificationId],
    }],
    verifications: [{
      id: verificationId,
      executable: "node",
      args: ["-e", `process.exit(${opts.exitCode})`],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [...opts.expectedExitCodes],
    }],
    budgets: { max_attempts: 2, max_review_cycles: 2, wall_clock_ms: 120_000, remediation_limit: 1 },
  };
}

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly ownership: ReturnType<typeof provisionAttemptWorkspace> extends { readonly workspace?: infer W } ? W : never;
  readonly verifyPhase: ResolvedPhaseContext;
  readonly candidateOid: string;
  readonly baselineOid: string;
}

function buildFixture(opts: {
  readonly expectedExitCodes: readonly number[];
  readonly exitCode: number;
}): Fixture {
  const repo = makeRepo();
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  const draft = exitCodeDraft(opts);
  const sealedContract = sealTicketContracts([draft], { repositoryRoot: repo })[0]!;
  const resolver = new IdentityContextResolver(store);
  const leases = new LeaseAuthority(store);
  const baselineOid = git(repo, "rev-parse", "HEAD");
  const run = resolver.allocateFreshRun({
    contracts: [sealedContract],
    initialDeliveryOid: baselineOid,
    oracleVersion: ORACLE_VERSION,
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: sealedContract.id });
  updateRow(store.location.databasePath, "runs", "run_id", run.runId, { state: "active", state_version: 1 });
  updateRow(store.location.databasePath, "run_tickets", "ticket_instance_id", attempt.ticketInstanceId, { state: "active", state_version: 1 });
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: attempt.attemptId,
    idempotencyKey: `acquire:exit-codes`,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) {
    throw new Error(`provision failed: ${provisioned.code}: ${provisioned.detail}`);
  }
  const ownership = provisioned.workspace.ownership;
  mkdirSync(ownership.plan.policyBundlePath, { recursive: true, mode: 0o700 });
  const verifyPhase = new AttemptExecutionContextAuthority(store).resolveExecutionContext({
    attempt,
    contract: sealedContract,
    phase: "verification",
    phaseOrdinal: 3,
    role: "verifier",
    ownership: acquired,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot: dirname(acquired.plan.policyContextPath),
      bundleDir: acquired.plan.policyBundlePath,
      requestedBundleSha256: createHash("sha256").update(acquired.plan.policyBundlePath, "utf8").digest("hex"),
    },
    modelSelection: { harness: "fixture", model: "fixture", vendor: "fixture" },
    timeoutMs: 30_000,
    callerRepositoryRealpath: repo,
  });
  mkdirSync(join(provisioned.workspace.worktreePath, "src"), { recursive: true });
  writeFileSync(join(provisioned.workspace.worktreePath, "src", "feature.ts"), "export const feature = true;\n", "utf8");
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "add", "src/feature.ts"]);
  execFileSync("git", ["-C", provisioned.workspace.worktreePath, "commit", "-qm", "candidate"]);
  const candidateOid = git(provisioned.workspace.worktreePath, "rev-parse", "HEAD");
  const attemptRef = `refs/rickgent/runs/${run.runId}/attempts/${attempt.attemptId}`;
  git(repo, "update-ref", attemptRef, candidateOid);
  const preVerifyStates = [
    "implementing", "implementation_captured", "reviewing",
    "verification_queued", "verifying",
  ] as const;
  for (let i = 0; i < preVerifyStates.length; i++) {
    updateRow(store.location.databasePath, "attempts", "attempt_id", attempt.attemptId, {
      state: preVerifyStates[i],
      state_version: i + 1,
    });
  }
  return {
    repo, store, leases, contract: sealedContract, run, attempt,
    ownership, verifyPhase, candidateOid, baselineOid,
  } as Fixture;
}

function callVerification(fixture: Fixture): {
  readonly status: "pass" | "fail" | "infrastructure_error";
  readonly gateResultIds: readonly string[];
} {
  const providers = buildAttemptRunnerProviders(
    fixture.store,
    fixture.leases,
    undefined,
    undefined,
    { fixtureReviewerIdentity: true },
  );
  const result = providers.verification!({
    ownership: fixture.ownership,
    phase: {
      phaseExecutionId: fixture.verifyPhase.persisted.phaseExecutionId,
      contextId: fixture.verifyPhase.persisted.contextId,
      contextDigest: fixture.verifyPhase.persisted.contextDigest as `sha256:${string}`,
      phase: "verification",
      phaseOrdinal: 3,
      role: "verifier",
    },
    review: {
      reviewRecordId: `review-${fixture.attempt.attemptId}`,
      verdict: "accept",
      reviewEvidenceId: `evidence-review-${fixture.attempt.attemptId}`,
    },
    contract: fixture.contract,
  });
  return {
    status: result.status,
    gateResultIds: (result as { readonly gateResultIds?: readonly string[] }).gateResultIds ?? [],
  };
}

// ---------------------------------------------------------------------------
// Structural: the provider source honors expected_exit_codes.
// ---------------------------------------------------------------------------

describe("structural: verification provider honors expected_exit_codes", () => {
  it("attempt-runner-providers.ts delegates to the structured gate runner (t26)", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    // t26: the verification provider delegates to runGateVerification from
    // the structured gate runner module.  The gate runner is the single
    // authority for classifying verification outcomes (including
    // expected_exit_codes classification).
    expect(source).toMatch(/runGateVerification/);
    expect(source).toMatch(/from\s+["']\.\.\/verification\/gate-runner\.js["']/);
  });

  it("the gate runner source (gate-runner.ts) honors expected_exit_codes classification", () => {
    const gateRunnerSource = readFileSync(join(orchestratorRoot, "src", "verification", "gate-runner.ts"), "utf-8");
    // The gate runner must consult the sealed expected_exit_codes allowlist
    // when classifying the exit code — not hardcode exit 0 as the only pass.
    expect(gateRunnerSource).toMatch(/expected_exit_codes/);
    expect(gateRunnerSource).not.toMatch(/e\.status\s*===\s*0\s*\?\s*"pass"\s*:\s*"fail"/);
  });

  it("attempt-runner-providers.ts does NOT hardcode exit 0 as the only pass condition", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    // The fail-open pattern: `e.status === 0 ? "pass" : "fail"` classifies
    // every nonzero exit as fail regardless of expected_exit_codes.  After
    // the fix, the classifier must consult the allowlist instead.
    expect(source).not.toMatch(/e\.status\s*===\s*0\s*\?\s*"pass"\s*:\s*"fail"/);
  });
});

// ---------------------------------------------------------------------------
// (a) Accepted nonzero exit: expected_exit_codes includes a nonzero value,
//     the command exits with that value, verification passes.
// ---------------------------------------------------------------------------

describe("(a) accepted nonzero exit: exit code in expected_exit_codes passes", () => {
  it("returns status 'pass' when the command exits 1 and expected_exit_codes is [0, 1]", () => {
    const fixture = buildFixture({ expectedExitCodes: [0, 1], exitCode: 1 });
    const result = callVerification(fixture);
    expect(result.status).toBe("pass");
    // The gate result must be persisted as "passed".
    const gateResults = queryAll(fixture.store.location.databasePath,
      "SELECT gate_id, status FROM gate_results WHERE attempt_id = ?",
      fixture.attempt.attemptId);
    expect(gateResults.length).toBe(1);
    expect(String(gateResults[0]!.gate_id)).toBe("VER-EXIT");
    expect(String(gateResults[0]!.status)).toBe("passed");
  });

  it("returns status 'pass' when the command exits 2 and expected_exit_codes is [2]", () => {
    // A purely nonzero allowlist (no 0) — the only permitted exit is 2.
    const fixture = buildFixture({ expectedExitCodes: [2], exitCode: 2 });
    const result = callVerification(fixture);
    expect(result.status).toBe("pass");
    const gateResults = queryAll(fixture.store.location.databasePath,
      "SELECT gate_id, status FROM gate_results WHERE attempt_id = ?",
      fixture.attempt.attemptId);
    expect(gateResults.length).toBe(1);
    expect(String(gateResults[0]!.status)).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// (b) Excluded exit fails closed: exit code NOT in expected_exit_codes fails.
// ---------------------------------------------------------------------------

describe("(b) excluded exit fails closed: exit code not in expected_exit_codes fails", () => {
  it("returns status 'fail' when the command exits 2 and expected_exit_codes is [0, 1]", () => {
    const fixture = buildFixture({ expectedExitCodes: [0, 1], exitCode: 2 });
    const result = callVerification(fixture);
    expect(result.status).toBe("fail");
    const gateResults = queryAll(fixture.store.location.databasePath,
      "SELECT gate_id, status FROM gate_results WHERE attempt_id = ?",
      fixture.attempt.attemptId);
    expect(gateResults.length).toBe(1);
    expect(String(gateResults[0]!.gate_id)).toBe("VER-EXIT");
    expect(String(gateResults[0]!.status)).toBe("failed");
  });

  it("returns status 'fail' when the command exits 0 and expected_exit_codes is [1] (zero not permitted)", () => {
    // Edge case: 0 is NOT in the allowlist, so an exit-0 result fails closed.
    // This proves the classifier consults the allowlist rather than assuming
    // exit 0 always passes.
    const fixture = buildFixture({ expectedExitCodes: [1], exitCode: 0 });
    const result = callVerification(fixture);
    expect(result.status).toBe("fail");
    const gateResults = queryAll(fixture.store.location.databasePath,
      "SELECT gate_id, status FROM gate_results WHERE attempt_id = ?",
      fixture.attempt.attemptId);
    expect(gateResults.length).toBe(1);
    expect(String(gateResults[0]!.status)).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Sanity: FixtureContainmentBackend import is exercised (keeps the import
// meaningful and guards against accidental removal of the production import).
// ---------------------------------------------------------------------------

describe("sanity: fixture containment backend is constructible", () => {
  it("FixtureContainmentBackend can be constructed", () => {
    const backend = new FixtureContainmentBackend();
    expect(backend).toBeDefined();
  });
});
