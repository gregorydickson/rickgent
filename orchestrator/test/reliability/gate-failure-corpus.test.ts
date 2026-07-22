// t28 — Gate failure corpus: every non-passed gate status blocks completion.
//
// VAL-ORC-003: Missing or null oracle inputs block completion (fail closed).
// VAL-LIFE-004: Required gate values `missing`, `null`, `skipped`, `unavailable`,
// `infrastructure_error`, `stale`, and `conflicting` each block advancement.
//
// This corpus injects each non-passed gate status into a complete attempt
// fixture and asserts:
//   (a) the Oracle v2 rejects (fail-closed) with a `required_gate_blocking`
//       reason;
//   (b) no forbidden downstream state is reachable (no ready_for_delivery,
//       no delivery-ref promotion, no push, no PR);
//   (c) the positive control (passed) accepts.
//
// The corpus manifest and fault definitions are in
// `orchestrator/test/fixtures/gate-corpus/`.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompletionService } from "../../src/lifecycle/completion-service.js";
import { GATE_STATUSES, REQUIRED_GATE_BLOCKING_STATUSES, REQUIRED_GATE_GREEN_STATUSES } from "../../src/state/schema.js";
import {
  completeFixture,
  cleanupOracleFixtures,
  queryAll,
  type OracleFixture,
} from "../helpers/oracle-fixture.js";

const manifestPath = join(import.meta.dirname, "../fixtures/gate-corpus/manifest.json");
const faultsPath = join(import.meta.dirname, "../fixtures/gate-corpus/faults.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  readonly complete: boolean;
  readonly required_gates: readonly string[];
  readonly statuses: readonly string[];
  readonly blocking_statuses: readonly string[];
  readonly green_statuses: readonly string[];
  readonly assertions: readonly string[];
};
const faults = JSON.parse(readFileSync(faultsPath, "utf-8")) as {
  readonly faults: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly inject: { readonly gate_id: string; readonly status: string };
    readonly expected_oracle_result: "accepted" | "rejected";
    readonly expected_reason_contains: string | null;
    readonly forbidden_downstream: readonly string[];
  }>;
};

afterEach(() => {
  cleanupOracleFixtures();
});

describe("gate-corpus manifest validation", () => {
  it("the manifest is complete and declares required gates and all statuses", () => {
    expect(manifest.complete).toBe(true);
    expect(manifest.required_gates.length).toBeGreaterThan(0);
    expect(manifest.statuses).toEqual([...GATE_STATUSES]);
    expect(manifest.statuses.includes("infrastructure_error")).toBe(true);
  });

  it("the manifest blocking statuses match the schema REQUIRED_GATE_BLOCKING_STATUSES", () => {
    expect([...manifest.blocking_statuses].sort()).toEqual([...REQUIRED_GATE_BLOCKING_STATUSES].sort());
  });

  it("the manifest green statuses match the schema REQUIRED_GATE_GREEN_STATUSES", () => {
    expect([...manifest.green_statuses].sort()).toEqual([...REQUIRED_GATE_GREEN_STATUSES].sort());
  });

  it("the manifest declares all required assertions", () => {
    expect(manifest.assertions).toContain("each_blocking_status_rejects_oracle");
    expect(manifest.assertions).toContain("no_forbidden_later_phase");
    expect(manifest.assertions).toContain("no_ready_for_delivery");
    expect(manifest.assertions).toContain("fail_closed_no_bypass");
  });

  it("the faults file declares a fault for each blocking status plus positive control", () => {
    const faultStatuses = faults.faults.map((f) => f.inject.status);
    for (const status of manifest.blocking_statuses) {
      expect(faultStatuses).toContain(status);
    }
    expect(faultStatuses).toContain("passed");
    expect(faultStatuses).toContain("absent");
  });
});

describe("gate-failure-corpus: each blocking status rejects the oracle (fail closed)", () => {
  // Test each blocking status from the schema.
  for (const status of REQUIRED_GATE_BLOCKING_STATUSES) {
    it(`required gate status '${status}' blocks oracle acceptance`, () => {
      const fixture = completeFixture([status]);
      const service = new CompletionService(fixture.store);
      const result = service.evaluateAttemptCompletion(
        fixture.attempt.attemptId, `oracle:gate-fault:${status}`, "attempt-runner.oracle",
      );
      expect(result.result).toBe("rejected");
      expect(result.reasons.some((r) => r.includes("required_gate_blocking"))).toBe(true);
      // No forbidden downstream state: the attempt is NOT verified, the ticket
      // is NOT ready_for_delivery, the run is NOT ready_for_delivery or delivered.
      const attemptState = queryAll(
        fixture.store.location.databasePath,
        "SELECT state FROM attempts WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )[0]?.state;
      expect(attemptState).toBe("cleanup_pending");
      const ticketState = queryAll(
        fixture.store.location.databasePath,
        "SELECT state FROM run_tickets WHERE ticket_instance_id = ?",
        fixture.attempt.ticketInstanceId,
      )[0]?.state;
      expect(ticketState).toBe("cleanup_pending");
      const runState = queryAll(
        fixture.store.location.databasePath,
        "SELECT state FROM runs WHERE run_id = ?",
        fixture.run.runId,
      )[0]?.state;
      expect(runState).toBe("active");
      // No delivery ref promotion: the delivery ref still equals the baseline.
      const deliveryOid = queryAll(
        fixture.store.location.databasePath,
        "SELECT current_delivery_oid FROM runs WHERE run_id = ?",
        fixture.run.runId,
      )[0]?.current_delivery_oid;
      expect(String(deliveryOid)).toBe(fixture.attempt.deliveryBaselineOid);
      // No oracle-accepted decision was persisted.
      const acceptedCount = queryAll(
        fixture.store.location.databasePath,
        "SELECT COUNT(*) AS count FROM oracle_decisions WHERE attempt_id = ? AND result = 'accepted'",
        fixture.attempt.attemptId,
      )[0]?.count;
      expect(Number(acceptedCount)).toBe(0);
    });
  }

  it("missing required gate (no gate_result row at all) blocks oracle acceptance", () => {
    const fixture = completeFixture(["passed"], { omitGate: true });
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:gate-fault:absent", "attempt-runner.oracle",
    );
    expect(result.result).toBe("rejected");
    expect(result.reasons.some((r) => r.includes("required_gate_missing_or_duplicate"))).toBe(true);
  });
});

describe("gate-failure-corpus: positive control (passed accepts)", () => {
  it("required gate status 'passed' accepts the oracle", () => {
    const fixture = completeFixture(["passed"]);
    const service = new CompletionService(fixture.store);
    const result = service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:gate-control:passed", "attempt-runner.oracle",
    );
    expect(result.result).toBe("accepted");
    expect(result.reasons).toEqual([]);
  });
});

describe("gate-failure-corpus: no forbidden downstream after rejection", () => {
  it("a rejected oracle does not produce a promotion_intent or delivery_intent", () => {
    const fixture = completeFixture(["failed"]);
    const service = new CompletionService(fixture.store);
    service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:no-downstream:failed", "attempt-runner.oracle",
    );
    const promotionCount = queryAll(
      fixture.store.location.databasePath,
      "SELECT COUNT(*) AS count FROM promotion_intents WHERE attempt_id = ?",
      fixture.attempt.attemptId,
    )[0]?.count;
    expect(Number(promotionCount)).toBe(0);
    const deliveryCount = queryAll(
      fixture.store.location.databasePath,
      "SELECT COUNT(*) AS count FROM delivery_intents WHERE run_id = ?",
      fixture.run.runId,
    )[0]?.count;
    expect(Number(deliveryCount)).toBe(0);
  });

  it("a rejected oracle leaves the attempt in cleanup_pending (no forbidden later phase)", () => {
    const fixture = completeFixture(["infrastructure_error"]);
    const service = new CompletionService(fixture.store);
    service.evaluateAttemptCompletion(
      fixture.attempt.attemptId, "oracle:no-later-phase:infra", "attempt-runner.oracle",
    );
    const attemptState = queryAll(
      fixture.store.location.databasePath,
      "SELECT state FROM attempts WHERE attempt_id = ?",
      fixture.attempt.attemptId,
    )[0]?.state;
    // The attempt must remain in cleanup_pending (or a failure terminal),
    // never in oracle_evaluation, verified, or ready_for_delivery.
    expect(["cleanup_pending", "failed_clean", "quarantined"]).toContain(String(attemptState));
  });
});
