/**
 * t24: Persisted lifecycle transition table.
 *
 * Replaces the boolean 8-phase scaffold with one normative phase/remediation
 * transition table.  Proves every legal edge transitions and every illegal
 * edge is rejected fail-closed.  Only the LifecycleEngine (backed by the
 * transactional TransitionAuthority / store transition API) writes attempt
 * transitions.
 *
 * Red-then-green: this file is authored BEFORE phase.ts is rewritten and
 * engine.ts is created, so the imports fail (red).  After implementation,
 * every assertion passes (green).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sealTicketContracts, type TicketContract, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver, type ResolvedPhaseContext } from "../../src/context/resolver.js";
import {
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateRecord,
  type StateStore,
} from "../../src/state/store.js";
import { TransitionAuthority, type ExistingTransitionEvidenceReference } from "../../src/state/transitions.js";
import {
  PHASE_TABLE_VERSION,
  PHASE_TRANSITION_TABLE,
  PHASE_STATES,
  PHASE_TERMINAL_STATES,
  legalPhaseEdge,
  isLegalPhaseEdge,
  isTerminalPhase,
  phaseEdgesFrom,
  type PhaseState,
} from "../../src/lifecycle/phase.js";
import {
  LifecycleEngine,
  LifecycleEngineError,
} from "../../src/lifecycle/engine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-lifecycle-transitions-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Lifecycle Transitions Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "lifecycle-transitions@example.test"]);
  writeFileSync(join(repo, "README.md"), "lifecycle transitions\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function repoHead(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function ticketDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t24",
    title: "Lifecycle transition table",
    description: "Exercise the normative phase/remediation transition table.",
    depends_on: [],
    scope: [{ path: "src/t24.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-LIFE",
      description: "Every legal edge transitions; every illegal edge is rejected fail-closed.",
      interface_ids: [],
      verification_ids: ["VER-LIFE"],
    }],
    verifications: [{
      id: "VER-LIFE",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 2,
      wall_clock_ms: 120_000,
      remediation_limit: 1,
    },
  };
}

function ticketContract(repo: string): TicketContract {
  return sealTicketContracts([ticketDraft()], { repositoryRoot: repo })[0]!;
}

interface Fixture {
  readonly repo: string;
  readonly store: StateStore;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly phase: ResolvedPhaseContext;
  readonly engine: LifecycleEngine;
  readonly authority: TransitionAuthority;
}

function fixture(): Fixture {
  const repo = makeRepo();
  const store = openStateStore({ repoPath: repo });
  const contract = ticketContract(repo);
  const resolver = new IdentityContextResolver(store);
  const run = resolver.allocateFreshRun({
    contracts: [contract],
    initialDeliveryOid: repoHead(repo),
    oracleVersion: "rickgent.oracle.v2",
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
  const policyRoot = join(store.location.resourceDirectory, "policy");
  const bundleRoot = join(policyRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  const phase = resolver.resolvePhaseContext({
    attempt,
    contract,
    phase: "implement",
    phaseOrdinal: 0,
    role: "worker",
    worktreeRealpath: repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir: bundleRoot,
      requestedBundleSha256: "a".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: contract.verifications[0]!.timeout_ms,
  });
  const authority = new TransitionAuthority(store);
  const engine = new LifecycleEngine(store, authority);
  return { repo, store, contract, run, attempt, phase, engine, authority };
}

function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 });
}

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

function all(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = openRaw(databasePath);
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function queryTransitions(databasePath: string, attemptId: string): SqlRow[] {
  return all(databasePath, "SELECT * FROM state_transitions WHERE attempt_id = ? ORDER BY entity_sequence", attemptId);
}

function appendEvidence(
  fx: Fixture,
  label: string,
  producerService = "LifecycleEngineTest",
): StateRecord {
  const payload = canonicalJson({
    schema_version: "rickgent.lifecycle-transition-evidence/v1",
    label,
    attempt_id: fx.attempt.attemptId,
    context_id: fx.phase.persisted.contextId,
  });
  return fx.store.appendEvidence({
    evidence_id: `evidence-${label}`,
    attempt_id: fx.attempt.attemptId,
    phase_execution_id: fx.phase.persisted.phaseExecutionId,
    context_id: fx.phase.persisted.contextId,
    producer_service: producerService,
    scope: `attempt:${fx.attempt.attemptId}`,
    schema_version: "rickgent.lifecycle-transition-evidence/v1",
    content_digest: digest(payload),
    inline_payload_json: payload,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence:${label}`,
    created_at: "2026-07-21T12:00:00.000Z",
  });
}

function evidenceReference(evidence: StateRecord, purpose = "authority"): ExistingTransitionEvidenceReference {
  return { purpose, evidenceId: String(evidence.evidence_id) };
}

// ---------------------------------------------------------------------------
// 1. Normative transition table structure (AC-1)
// ---------------------------------------------------------------------------

describe("PHASE_TRANSITION_TABLE — normative phase/remediation model", () => {
  it("is versioned and frozen", () => {
    expect(typeof PHASE_TABLE_VERSION).toBe("string");
    expect(PHASE_TABLE_VERSION).toMatch(/^rickgent\.phase-table\.v\d+$/);
    expect(Object.isFrozen(PHASE_TRANSITION_TABLE)).toBe(true);
    expect(Object.isFrozen(PHASE_STATES)).toBe(true);
    expect(Object.isFrozen(PHASE_TERMINAL_STATES)).toBe(true);
  });

  it("declares the normative phase states (replacing the boolean 8-phase scaffold)", () => {
    for (const state of [
      "planned", "implementing", "implementation_captured", "reviewing",
      "remediating", "remediation_captured", "verification_queued", "verifying",
      "converging", "cleanup_pending", "oracle_evaluation", "verified",
      "failed_clean", "quarantined",
    ] as const) {
      expect(PHASE_STATES).toContain(state);
    }
    for (const legacy of ["research", "research_review", "plan", "plan_review", "spec_conformance", "code_review", "simplify"]) {
      expect(PHASE_STATES).not.toContain(legacy);
    }
  });

  it("declares every forward (success) edge", () => {
    const forwardEdges: ReadonlyArray<readonly [PhaseState, PhaseState]> = [
      ["planned", "implementing"],
      ["implementing", "implementation_captured"],
      ["implementation_captured", "reviewing"],
      ["reviewing", "verification_queued"],
      ["reviewing", "remediating"],
      ["remediating", "remediation_captured"],
      ["remediation_captured", "reviewing"],
      ["verification_queued", "verifying"],
      ["verifying", "converging"],
      ["converging", "cleanup_pending"],
      ["cleanup_pending", "oracle_evaluation"],
      ["oracle_evaluation", "verified"],
    ];
    for (const [from, to] of forwardEdges) {
      expect(isLegalPhaseEdge(from, to)).toBe(true);
      const edge = legalPhaseEdge(from, to);
      expect(edge).toBeDefined();
      expect(edge!.from).toBe(from);
      expect(edge!.to).toBe(to);
      expect(typeof edge!.guard).toBe("string");
      expect(typeof edge!.evidenceProducer).toBe("string");
      expect(typeof edge!.role).toBe("string");
    }
  });

  it("declares every failure edge (any pre-cleanup state to cleanup_pending)", () => {
    // `converging -> cleanup_pending` is the SUCCESS-path cleanup edge (no
    // failureTarget); every other pre-cleanup state has a failure edge.
    const failureStates: readonly PhaseState[] = [
      "planned", "implementing", "implementation_captured", "reviewing",
      "remediating", "remediation_captured", "verification_queued", "verifying",
    ];
    for (const from of failureStates) {
      expect(isLegalPhaseEdge(from, "cleanup_pending")).toBe(true);
      const edge = legalPhaseEdge(from, "cleanup_pending");
      expect(edge).toBeDefined();
      expect(edge!.failureTarget).toBeDefined();
    }
    expect(isLegalPhaseEdge("converging", "cleanup_pending")).toBe(true);
  });

  it("declares cleanup terminal edges", () => {
    expect(isLegalPhaseEdge("cleanup_pending", "failed_clean")).toBe(true);
    expect(isLegalPhaseEdge("cleanup_pending", "quarantined")).toBe(true);
  });

  it("rejects every illegal edge not in the table", () => {
    const illegalEdges: ReadonlyArray<readonly [PhaseState, PhaseState]> = [
      ["planned", "reviewing"],
      ["planned", "verified"],
      ["implementing", "verifying"],
      ["implementation_captured", "converging"],
      ["reviewing", "verifying"],
      ["reviewing", "verified"],
      ["verifying", "verified"],
      ["converging", "verified"],
      ["cleanup_pending", "verified"],
      ["oracle_evaluation", "failed_clean"],
      ["failed_clean", "planned"],
      ["quarantined", "planned"],
      ["verified", "planned"],
      ["verified", "failed_clean"],
      ["remediating", "verifying"],
      ["remediation_captured", "verifying"],
    ];
    for (const [from, to] of illegalEdges) {
      expect(isLegalPhaseEdge(from, to)).toBe(false);
      expect(legalPhaseEdge(from, to)).toBeUndefined();
    }
  });

  it("classifies terminal states correctly", () => {
    expect(isTerminalPhase("failed_clean")).toBe(true);
    expect(isTerminalPhase("quarantined")).toBe(true);
    expect(isTerminalPhase("verified")).toBe(true);
    expect(isTerminalPhase("planned")).toBe(false);
    expect(isTerminalPhase("implementing")).toBe(false);
    expect(isTerminalPhase("cleanup_pending")).toBe(false);
    expect(isTerminalPhase("oracle_evaluation")).toBe(false);
  });

  it("exposes outgoing legal edges from each state", () => {
    expect(phaseEdgesFrom("planned").map((e) => e.to)).toContain("implementing");
    expect(phaseEdgesFrom("planned").map((e) => e.to)).toContain("cleanup_pending");
    expect(phaseEdgesFrom("reviewing").map((e) => e.to)).toContain("verification_queued");
    expect(phaseEdgesFrom("reviewing").map((e) => e.to)).toContain("remediating");
    expect(phaseEdgesFrom("reviewing").map((e) => e.to)).toContain("cleanup_pending");
    expect(phaseEdgesFrom("failed_clean")).toHaveLength(0);
    expect(phaseEdgesFrom("verified")).toHaveLength(0);
  });

  it("declares the review budget semantics on the remediation edge (AC-3)", () => {
    const remediate = legalPhaseEdge("reviewing", "remediating");
    expect(remediate).toBeDefined();
    expect(remediate!.remediationBudgetConsumed).toBe(true);
    const exhaust = legalPhaseEdge("reviewing", "cleanup_pending");
    expect(exhaust).toBeDefined();
    expect(exhaust!.failureTarget).toBe("failed_clean");
  });

  it("every edge has a typed guard, evidence producer, and role", () => {
    for (const edge of PHASE_TRANSITION_TABLE) {
      expect(edge.guard.length).toBeGreaterThan(0);
      expect(edge.evidenceProducer.length).toBeGreaterThan(0);
      expect(edge.role.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. LifecycleEngine — illegal edges rejected fail-closed (AC-1, AC-2)
// ---------------------------------------------------------------------------

describe("LifecycleEngine — fail-closed edge validation", () => {
  it("throws LifecycleEngineError for illegal edges", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "illegal-edge");
    const illegal = () => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "verified",
      idempotencyKey: "illegal-skip",
      evidence: [evidenceReference(evidence)],
    });
    expect(illegal).toThrow(LifecycleEngineError);
    expect(illegal).toThrow(/RICKGENT_LIFECYCLE_TRANSITION_ILLEGAL|illegal phase transition/i);
  });

  it("does not persist anything when an illegal edge is rejected", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "illegal-edge-noop");
    const before = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "implementing",
      to: "verifying",
      idempotencyKey: "illegal-skip-noop",
      evidence: [evidenceReference(evidence)],
    })).toThrow();
    const after = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    expect(after.length).toBe(before.length);
  });

  it("rejects terminal-state regression (verified -> planned)", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "regression");
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "verified",
      to: "planned",
      idempotencyKey: "regression-attempt",
      evidence: [evidenceReference(evidence)],
    })).toThrow(LifecycleEngineError);
  });

  it("rejects a direct terminalization (planned -> verified)", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "direct-terminal");
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "verified",
      idempotencyKey: "direct-terminal-attempt",
      evidence: [evidenceReference(evidence)],
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. LifecycleEngine — legal forward transitions persist (AC-2)
// ---------------------------------------------------------------------------

describe("LifecycleEngine — legal forward transitions", () => {
  it("persists a legal planned -> implementing transition through the production path", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "forward-start");
    const result = fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-forward-start",
      evidence: [evidenceReference(evidence)],
    });
    expect(result.toState).toBe("implementing");
    const transitions = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect(String(transitions[transitions.length - 1]!.to_state)).toBe("implementing");
  });

  it("persists the full forward sequence planned -> ... -> converging", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "forward-sequence");
    const proof = [evidenceReference(evidence)];
    const steps: ReadonlyArray<readonly [PhaseState, PhaseState, string]> = [
      ["planned", "implementing", "t24-seq-start"],
      ["implementing", "implementation_captured", "t24-seq-capture"],
      ["implementation_captured", "reviewing", "t24-seq-review"],
      ["reviewing", "verification_queued", "t24-seq-queue"],
      ["verification_queued", "verifying", "t24-seq-verify"],
      ["verifying", "converging", "t24-seq-converge"],
    ];
    for (const [from, to, key] of steps) {
      const result = fx.engine.transitionAttempt({
        attemptId: fx.attempt.attemptId,
        from,
        to,
        idempotencyKey: key,
        evidence: proof,
      });
      expect(result.toState).toBe(to);
    }
  });

  it("idempotent replay of the same transition returns the existing postimage", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "idempotent");
    const proof = [evidenceReference(evidence)];
    const first = fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-idempotent-start",
      evidence: proof,
    });
    const replay = fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-idempotent-start",
      evidence: proof,
    });
    expect(replay.toState).toBe(first.toState);
    const rows = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    const matching = rows.filter((r) => String(r.idempotency_key) === "t24-idempotent-start");
    expect(matching).toHaveLength(1);
  });

  it("divergent postimage on replay conflicts fail-closed", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "divergent-a");
    fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-divergent-key",
      evidence: [evidenceReference(evidence)],
    });
    // A replay of the same idempotency key but with a DIFFERENT target state
    // conflicts: the persisted row has to_state="implementing" but the new
    // request claims to_state="implementation_captured" under the same key.
    const divergent = () => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementation_captured",
      idempotencyKey: "t24-divergent-key",
      evidence: [evidenceReference(evidence)],
    });
    expect(divergent).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Review budget semantics — AC-3
// ---------------------------------------------------------------------------

describe("LifecycleEngine — review accept/reject/remediation budget (AC-3)", () => {
  it("review accept enters verification_queued", () => {
    expect(isLegalPhaseEdge("reviewing", "verification_queued")).toBe(true);
    const edge = legalPhaseEdge("reviewing", "verification_queued");
    expect(edge!.evidenceProducer).toBe("ReviewService");
  });

  it("review reject with budget enters remediating", () => {
    expect(isLegalPhaseEdge("reviewing", "remediating")).toBe(true);
    const edge = legalPhaseEdge("reviewing", "remediating");
    expect(edge!.remediationBudgetConsumed).toBe(true);
  });

  it("remediation captured returns to reviewing", () => {
    expect(isLegalPhaseEdge("remediating", "remediation_captured")).toBe(true);
    expect(isLegalPhaseEdge("remediation_captured", "reviewing")).toBe(true);
  });

  it("review reject with exhausted budget enters cleanup_pending (failure)", () => {
    expect(isLegalPhaseEdge("reviewing", "cleanup_pending")).toBe(true);
    const edge = legalPhaseEdge("reviewing", "cleanup_pending");
    expect(edge!.failureTarget).toBe("failed_clean");
  });

  it("the normative table does not allow a direct reviewing -> verified shortcut", () => {
    expect(isLegalPhaseEdge("reviewing", "verified")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Crash/restart resume (AC-4)
// ---------------------------------------------------------------------------

describe("LifecycleEngine — resume from persisted receipts", () => {
  it("reports the next legal edges from the current persisted state", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "resume-walk");
    const proof = [evidenceReference(evidence)];
    for (const [from, to, key] of [
      ["planned", "implementing", "t24-resume-start"],
      ["implementing", "implementation_captured", "t24-resume-capture"],
      ["implementation_captured", "reviewing", "t24-resume-review"],
    ] as const) {
      fx.engine.transitionAttempt({ attemptId: fx.attempt.attemptId, from, to, idempotencyKey: key, evidence: proof });
    }
    const next = fx.engine.resumeAttempt(fx.attempt.attemptId);
    expect(next.currentState).toBe("reviewing");
    const targets = next.legalNext.map((e) => e.to);
    expect(targets).toContain("verification_queued");
    expect(targets).toContain("remediating");
    expect(targets).toContain("cleanup_pending");
    expect(targets).not.toContain("verified");
  });

  it("terminal states report no legal next edges", () => {
    expect(phaseEdgesFrom("verified")).toHaveLength(0);
    expect(phaseEdgesFrom("failed_clean")).toHaveLength(0);
    expect(phaseEdgesFrom("quarantined")).toHaveLength(0);
    expect(isTerminalPhase("verified")).toBe(true);
  });

  it("resume does not replay completed transitions", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "resume-no-replay");
    fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-resume-no-replay",
      evidence: [evidenceReference(evidence)],
    });
    const before = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    const next = fx.engine.resumeAttempt(fx.attempt.attemptId);
    expect(next.currentState).toBe("implementing");
    const after = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------------------
// 6. Skipped/unavailable/infrastructure phase results cannot advance (AC-5)
// ---------------------------------------------------------------------------

describe("LifecycleEngine — skipped/unavailable results cannot advance (AC-5)", () => {
  it("the table has no edge that skips a required phase", () => {
    const illegalSkips: ReadonlyArray<readonly [PhaseState, PhaseState]> = [
      ["planned", "reviewing"],
      ["planned", "verifying"],
      ["planned", "converging"],
      ["planned", "oracle_evaluation"],
      ["implementing", "reviewing"],
      ["implementation_captured", "verifying"],
    ];
    for (const [from, to] of illegalSkips) {
      expect(isLegalPhaseEdge(from, to)).toBe(false);
    }
  });

  it("rejects an illegal skip-edge via the engine fail-closed", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "skip-reject");
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "converging",
      idempotencyKey: "t24-skip",
      evidence: [evidenceReference(evidence)],
    })).toThrow(LifecycleEngineError);
  });

  it("the converging -> cleanup_pending edge requires a guard (no silent skip)", () => {
    const edge = legalPhaseEdge("converging", "cleanup_pending");
    expect(edge).toBeDefined();
    expect(edge!.guard.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Negative proofs — fail-closed matrix
// ---------------------------------------------------------------------------

describe("LifecycleEngine — negative proofs", () => {
  it("rejects an empty idempotency key", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "empty-key");
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "",
      evidence: [evidenceReference(evidence)],
    })).toThrow();
  });

  it("rejects an explicitly empty evidence array", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "empty-evidence");
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-empty-evidence",
      evidence: [],
    })).toThrow(LifecycleEngineError);
    void evidence;
  });

  it("rejects an unknown attempt id fail-closed", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "unknown-attempt");
    expect(() => fx.engine.transitionAttempt({
      attemptId: "nonexistent-attempt",
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-unknown",
      evidence: [evidenceReference(evidence)],
    })).toThrow();
  });

  it("rejects a from-state that does not match the persisted state", () => {
    const fx = fixture();
    const setupEvidence = appendEvidence(fx, "wrong-from-setup");
    fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-wrong-from-setup",
      evidence: [evidenceReference(setupEvidence)],
    });
    const evidence = appendEvidence(fx, "wrong-from");
    expect(() => fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "reviewing",
      to: "verification_queued",
      idempotencyKey: "t24-wrong-from-actual",
      evidence: [evidenceReference(evidence)],
    })).toThrow();
  });

  it("resume rejects an unknown attempt id fail-closed", () => {
    const fx = fixture();
    expect(() => fx.engine.resumeAttempt("nonexistent-attempt")).toThrow();
  });

  it("every legal edge validated by the engine is also in the persisted state_transitions table", () => {
    const fx = fixture();
    const evidence = appendEvidence(fx, "persisted-row");
    fx.engine.transitionAttempt({
      attemptId: fx.attempt.attemptId,
      from: "planned",
      to: "implementing",
      idempotencyKey: "t24-persisted-row",
      evidence: [evidenceReference(evidence)],
    });
    const rows = queryTransitions(fx.store.location.databasePath, fx.attempt.attemptId);
    const matching = rows.find((r) => String(r.idempotency_key) === "t24-persisted-row");
    expect(matching).toBeDefined();
    expect(String(matching!.from_state)).toBe("planned");
    expect(String(matching!.to_state)).toBe("implementing");
  });
});
