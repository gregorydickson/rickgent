// t28 — Completion Oracle v2 Lifecycle Integration.
//
// VAL-ORC-002: Oracle v2 is the single completion oracle for the lifecycle.
//   It requires every lifecycle, Git, process, gate, review, evidence,
//   ownership, cleanup-eligibility, and scope input.
// VAL-ORC-003: Missing or null oracle inputs block completion (fail closed).
//   No bypass.
//
// These tests prove:
//   (a) the CompletionService is the sole lifecycle route to the oracle;
//   (b) the caller allowlist is enforced (no bypass);
//   (c) every required input class is checked — missing inputs reject;
//   (d) null/skipped/unavailable/infrastructure_error gate statuses reject;
//   (e) live execution and persisted re-evaluation call the same oracle/version
//       (idempotent replay);
//   (f) no second completion predicate exists (one store oracle method);
//   (g) a caller audit proves workers/CLI/status/reconcile/gate modules
//       cannot bypass the completion service.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CompletionService,
  ALLOWED_COMPLETION_SERVICE_CALLERS,
  isAllowedCompletionServiceCaller,
  type CompletionServiceCaller,
} from "../../src/lifecycle/completion-service.js";
import { RICKGENT_ORACLE_VERSION, evaluateAttemptOracle } from "../../src/state/oracle.js";
import {
  completeFixture,
  cleanupOracleFixtures,
  countRows,
  queryAll,
  openRaw,
  type OracleFixture,
} from "../helpers/oracle-fixture.js";

afterEach(() => {
  cleanupOracleFixtures();
});

describe("VAL-ORC-002: Oracle v2 is the single completion oracle for the lifecycle", () => {
  it("the CompletionService evaluates through Oracle v2 (versioned)", () => {
    const fixture = completeFixture();
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId,
      "oracle:integration:001",
      "attempt-runner.oracle",
    );
    expect(result.oracleVersion).toBe(RICKGENT_ORACLE_VERSION);
    expect(result.result).toBe("accepted");
    expect(result.reasons).toEqual([]);
  });

  it("the store exposes exactly one oracle entrypoint (no second predicate)", () => {
    const fixture = completeFixture();
    const prototype = Object.getPrototypeOf(fixture.store) as object;
    // M8 scrutiny round 4 added resolveAttemptOracleProjectionForTesting as
    // a read-only testing helper (used by m8-scrutiny-round-4-fixes.test.ts
    // to inspect the projection without persisting a decision). It is NOT a
    // second completion predicate — it does not evaluate or persist. The
    // production oracle entrypoint remains evaluateAndPersistAttemptOracle.
    const oracleMethods = Object.getOwnPropertyNames(prototype).filter(
      (name) => /oracle/i.test(name) && !name.endsWith("ForTesting"),
    );
    expect(oracleMethods).toEqual(["evaluateAndPersistAttemptOracle"]);
    // No raw-row or plan writer is exposed for bypass.
    expect((fixture.store as unknown as Record<string, unknown>).persistOracleDecision).toBeUndefined();
  });

  it("the pure oracle is the single evaluation function (no parallel verdict)", async () => {
    const oracleModule = evaluateAttemptOracle;
    expect(typeof oracleModule).toBe("function");
    // The module must export only one evaluation entrypoint.
    const oracleExports = Object.keys(await import("../../src/state/oracle.js")).filter(
      (name) => name.startsWith("evaluate") || name.startsWith("check"),
    );
    expect(oracleExports).toEqual(["evaluateAttemptOracle"]);
  });

  it("live execution and persisted re-evaluation call the same oracle/version (idempotent replay)", () => {
    const fixture = completeFixture();
    const service = new CompletionService(fixture.store);
    const request = {
      attemptId: fixture.attempt.attemptId,
      idempotencyKey: "oracle:replay:same-version",
    } as const;
    const first = service.evaluateAttemptCompletion(request.attemptId, request.idempotencyKey, "attempt-runner.oracle");
    const second = service.evaluateAttemptCompletion(request.attemptId, request.idempotencyKey, "attempt-runner.oracle");
    expect(second).toEqual(first);
    expect(countRows(fixture.store.location.databasePath, "oracle_decisions", fixture.attempt.attemptId)).toBe(1);
  });

  it("re-evaluation after unrelated lifecycle advancement returns the same decision", () => {
    const fixture = completeFixture();
    const service = new CompletionService(fixture.store);
    const first = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:advance-replay", "attempt-runner.oracle",
    );
    // Advance the attempt state (does not change oracle inputs).
    const database = openRaw(fixture.store.location.databasePath);
    try {
      database.prepare(
        "UPDATE attempts SET state = 'oracle_evaluation', state_version = state_version + 1 WHERE attempt_id = ?",
      ).run(fixture.attempt.attemptId);
    } finally {
      database.close();
    }
    const second = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:advance-replay", "attempt-runner.oracle",
    );
    expect(second).toEqual(first);
  });
});

describe("VAL-ORC-003: Missing or null oracle inputs block completion (fail closed)", () => {
  it("missing gate result (no gate row) rejects with required_gate_missing_or_duplicate", () => {
    const fixture = completeFixture(["passed"], { omitGate: true });
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:missing-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_missing_or_duplicate"))).toBe(true);
  });

  it("null gate status rejects with required_gate_blocking", () => {
    const fixture = completeFixture(["null"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:null-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
  });

  it("skipped gate status rejects with required_gate_blocking", () => {
    const fixture = completeFixture(["skipped"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:skipped-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
  });

  it("unavailable gate status rejects with required_gate_blocking", () => {
    const fixture = completeFixture(["unavailable"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:unavailable-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
  });

  it("infrastructure_error gate status rejects with required_gate_blocking", () => {
    const fixture = completeFixture(["infrastructure_error"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:infra-error-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
  });

  it("stale gate status rejects with required_gate_blocking", () => {
    const fixture = completeFixture(["stale"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:stale-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
  });

  it("conflicting gate status rejects with required_gate_blocking", () => {
    const fixture = completeFixture(["conflicting"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:conflicting-gate", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
  });

  it("missing review record rejects with missing_input_class:independent_review", () => {
    const fixture = completeFixture(["passed"], { omitReview: true });
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:missing-review", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("missing_input_class:independent_review"))).toBe(true);
  });

  it("missing commit attribution rejects with missing_input_class:commit_attribution", () => {
    const fixture = completeFixture(["passed"], { omitAttribution: true });
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:missing-attribution", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("missing_input_class:commit_attribution"))).toBe(true);
  });

  it("missing cleanup eligibility rejects with cleanup_eligibility_cardinality:0", () => {
    const fixture = completeFixture(["passed"], { omitCleanupEligibility: true });
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:missing-cleanup-eligibility", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("cleanup_eligibility_cardinality:0"))).toBe(true);
  });

  it("missing target proof set rejects with complete_target_proof_set_cardinality:0", () => {
    const fixture = completeFixture(["passed"], { omitTargetProofSet: true, omitCleanupEligibility: true });
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:missing-target-proof", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("complete_target_proof_set_cardinality:0"))).toBe(true);
  });
});

describe("VAL-ORC-002/003: CompletionService caller allowlist (no bypass)", () => {
  it("rejects an unauthorized caller with a TypeError (no bypass)", () => {
    const fixture = completeFixture();
    const service = new CompletionService(fixture.store);
    expect(() => service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:rogue", "rogue-caller" as CompletionServiceCaller,
    )).toThrow(TypeError);
    expect(() => service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:rogue", "worker.bypass" as CompletionServiceCaller,
    )).toThrow(TypeError);
  });

  it("rejects a null caller (no != null short-circuit)", () => {
    const fixture = completeFixture();
    const service = new CompletionService(fixture.store);
    expect(() => service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:null-caller", null as unknown as CompletionServiceCaller,
    )).toThrow(TypeError);
  });

  it("rejects an undefined caller (no bypass)", () => {
    const fixture = completeFixture();
    const service = new CompletionService(fixture.store);
    expect(() => service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:undef-caller", undefined as unknown as CompletionServiceCaller,
    )).toThrow(TypeError);
  });

  it("the allowlist contains exactly the production lifecycle callers", () => {
    expect([...ALLOWED_COMPLETION_SERVICE_CALLERS].sort()).toEqual([
      "attempt-runner.oracle",
      "lifecycle-engine.oracle",
      "resume.reconcile",
    ]);
  });

  it("isAllowedCompletionServiceCaller returns false for non-allowlisted callers", () => {
    expect(isAllowedCompletionServiceCaller("worker.bypass")).toBe(false);
    expect(isAllowedCompletionServiceCaller("cli.verdict")).toBe(false);
    expect(isAllowedCompletionServiceCaller("gate.module")).toBe(false);
    expect(isAllowedCompletionServiceCaller("attempt-runner.oracle")).toBe(true);
  });
});

describe("VAL-ORC-002: caller audit — no bypass from workers/CLI/status/reconcile/gate modules", () => {
  const SRC_DIR = join(import.meta.dirname, "../../src");

  function walkTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
      else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("no production module calls evaluateAndPersistAttemptOracle except the authorized routes", () => {
    // The store method is the low-level oracle.  The CompletionService is the
    // lifecycle-layer wrapper.  The attempt-runner-providers module is the
    // production oracle provider (the "attempt-runner.oracle" caller).
    // No other production module may call the store method directly.
    //
    // Authorized callers:
    //   - state/store.ts (defines the method)
    //   - lifecycle/completion-service.ts (the sole lifecycle wrapper)
    //   - lifecycle/attempt-runner-providers.ts (the production provider)
    //
    // attempt-runner.ts may reference the method in documentation comments
    // but must not call it directly.
    const authorized = new Set([
      "src/state/store.ts",
      "src/lifecycle/completion-service.ts",
      "src/lifecycle/attempt-runner-providers.ts",
    ]);
    const files = walkTsFiles(SRC_DIR);
    const directCallers: string[] = [];
    for (const file of files) {
      const relative = file.replace(SRC_DIR, "src");
      if (authorized.has(relative)) continue;
      const source = readFileSync(file, "utf-8");
      // Strip line comments and block comments before scanning.
      const stripped = source
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (stripped.includes("evaluateAndPersistAttemptOracle")) {
        directCallers.push(relative);
      }
    }
    expect(directCallers).toEqual([]);
  });

  it("no production module imports evaluateAttemptOracle directly except state/store.ts and state/oracle.ts", () => {
    const authorized = new Set([
      "src/state/oracle.ts",
      "src/state/store.ts",
    ]);
    const files = walkTsFiles(SRC_DIR);
    const directImporters: string[] = [];
    for (const file of files) {
      const relative = file.replace(SRC_DIR, "src");
      if (authorized.has(relative)) continue;
      const source = readFileSync(file, "utf-8");
      // Strip comments before scanning.
      const stripped = source
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (stripped.includes("evaluateAttemptOracle")) {
        directImporters.push(relative);
      }
    }
    expect(directImporters).toEqual([]);
  });
});

describe("VAL-ORC-002: accepted oracle requires every input class", () => {
  it("a complete fixture with all inputs and passed gates accepts", () => {
    const fixture = completeFixture(["passed"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:complete-accept", "attempt-runner.oracle",
    );
    expect(result.result).toBe("accepted");
    expect(result.reasons).toEqual([]);
    expect(result.oracleVersion).toBe(RICKGENT_ORACLE_VERSION);
    expect(result.oracleDecisionId).toMatch(/^oracle-[0-9a-f]+$/);
    expect(result.inputSetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("the accepted decision persists exactly one oracle_decisions row", () => {
    const fixture = completeFixture(["passed"]);
    const service = new CompletionService(fixture.store);
    service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:persist-once", "attempt-runner.oracle",
    );
    const decisionCount = countRows(fixture.store.location.databasePath, "oracle_decisions", fixture.attempt.attemptId);
    expect(decisionCount).toBe(1);
    const refCount = countRows(fixture.store.location.databasePath, "oracle_input_references", fixture.attempt.attemptId);
    expect(refCount).toBeGreaterThan(0);
  });

  it("the oracle's accepted decision is durable and queryable", () => {
    const fixture = completeFixture(["passed"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:durable-query", "attempt-runner.oracle",
    );
    const rows = queryAll(
      fixture.store.location.databasePath,
      "SELECT * FROM oracle_decisions WHERE oracle_decision_id = ? AND attempt_id = ? AND result = 'accepted'",
      result.oracleDecisionId,
      fixture.attempt.attemptId,
    );
    expect(rows).toHaveLength(1);
  });
});
