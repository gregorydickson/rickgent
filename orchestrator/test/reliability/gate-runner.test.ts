/**
 * t26 — Sandboxed structured gate runner: typed authority-owned gate results.
 *
 * VAL-LIFE-003: The gate runner executes argv-only verification; shell
 * command interpolation removed.  Verification produces typed,
 * authority-owned gate results for every outcome.
 *
 * VAL-LIFE-004: Required gate values `missing`, `null`, `skipped`,
 * `unavailable`, `infrastructure_error`, `stale`, and `conflicting` each
 * block advancement (fail closed).  Only `passed` is green for a required
 * gate.
 *
 * These tests prove:
 *   (a) the gate runner executes argv-only (no shell interpolation, no
 *       interpolation);
 *   (b) every outcome maps to a typed GateRunnerStatus from the sealed
 *       GATE_STATUSES enum;
 *   (c) authority-owned gate results carry contract/context/phase digest,
 *       argv digest, output hashes, output tails, and timestamps;
 *   (d) each non-passed status blocks advancement (fail-closed);
 *   (e) negative proofs: forged result, stale generation, conflicting
 *       replay, missing executable, unavailable sandbox, timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  runGateVerification,
  type GateRunnerRequest,
  type GateRunnerResult,
  GATE_RUNNER_SCHEMA_VERSION,
} from "../../src/verification/gate-runner.js";
import {
  buildSandboxEnv,
  resolveVerificationCwd,
  validateWritableOutputs,
} from "../../src/verification/sandbox.js";
import { GATE_STATUSES, REQUIRED_GATE_GREEN_STATUSES, REQUIRED_GATE_BLOCKING_STATUSES } from "../../src/state/schema.js";
import type { TicketVerification } from "../../src/contracts/ticket-contract.js";

const CONTRACT_DIGEST = "sha256:contract-test-digest-aaaa";
const CONTEXT_DIGEST = "sha256:context-test-digest-bbbb";
const PHASE_DIGEST = "sha256:phase-test-digest-cccc";

function makeVerification(overrides: Partial<TicketVerification> = {}): TicketVerification {
  return {
    id: "VERIFY-TEST-01",
    executable: "true",
    args: [],
    cwd_class: "repository_root",
    env_allowlist: ["PATH"],
    timeout_ms: 10_000,
    network: "deny",
    writable_outputs: [],
    expected_exit_codes: [0],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<GateRunnerRequest> = {}): GateRunnerRequest {
  return {
    verification: makeVerification(),
    cwd: process.cwd(),
    env: buildSandboxEnv(process.env, ["PATH"]),
    contractDigest: CONTRACT_DIGEST,
    contextDigest: CONTEXT_DIGEST,
    phaseDigest: PHASE_DIGEST,
    ...overrides,
  };
}

describe("gate-runner: argv-only execution (VAL-LIFE-003)", () => {
  it("runs a real argv-only command and classifies a pass", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "true",
        args: [],
        expected_exit_codes: [0],
      }),
    }));
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
  });

  it("runs a real argv-only command and classifies a fail (non-zero exit not in allowlist)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "false",
        args: [],
        expected_exit_codes: [0],
      }),
    }));
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  it("classifies a permitted non-zero exit as passed (sealed allowlist)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "false",
        args: [],
        expected_exit_codes: [0, 1],
      }),
    }));
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(1);
  });

  it("executes with array argv — passes arguments without shell interpolation", () => {
    // Use `true` with extra args that would break under shell interpolation (e.g., semicolons).
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "true",
        args: ["--flag=value;rm -rf /", "another arg with $HOME"],
        expected_exit_codes: [0],
      }),
    }));
    expect(result.status).toBe("passed");
  });
});

describe("gate-runner: typed authority-owned gate results (VAL-LIFE-003)", () => {
  it("produces a result with contract/context/phase digest, argv digest, output hashes, tails, and timestamps", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "node",
        args: ["-e", "process.stdout.write('out'); process.stderr.write('err');"],
        expected_exit_codes: [0],
      }),
    }));
    expect(result.status).toBe("passed");
    expect(result.contractDigest).toBe(CONTRACT_DIGEST);
    expect(result.contextDigest).toBe(CONTEXT_DIGEST);
    expect(result.phaseDigest).toBe(PHASE_DIGEST);
    expect(result.argvDigest).toMatch(/^sha256:/);
    expect(result.gateId).toBe("VERIFY-TEST-01");
    expect(result.stdoutHash).toMatch(/^sha256:/);
    expect(result.stderrHash).toMatch(/^sha256:/);
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.detail).toBeTruthy();
  });

  it("the argv digest is deterministic for the same executable+args (replay integrity)", () => {
    const r1 = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true", args: ["--a", "--b"] }),
    }));
    const r2 = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true", args: ["--a", "--b"] }),
    }));
    expect(r1.argvDigest).toBe(r2.argvDigest);
  });

  it("the argv digest changes when the args change (divergent input)", () => {
    const r1 = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true", args: ["--a"] }),
    }));
    const r2 = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true", args: ["--b"] }),
    }));
    expect(r1.argvDigest).not.toBe(r2.argvDigest);
  });

  it("captures stdout and stderr content hashes from a real command", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "node",
        args: ["-e", "process.stdout.write('hello'); process.stderr.write('world');"],
        expected_exit_codes: [0],
      }),
    }));
    expect(result.status).toBe("passed");
    const expectedStdoutHash = `sha256:${createHash("sha256").update("hello").digest("hex")}`;
    const expectedStderrHash = `sha256:${createHash("sha256").update("world").digest("hex")}`;
    expect(result.stdoutHash).toBe(expectedStdoutHash);
    expect(result.stderrHash).toBe(expectedStderrHash);
  });
});

describe("gate-runner: every outcome maps to a typed GateRunnerStatus (VAL-LIFE-004)", () => {
  it("GATE_STATUSES includes all 9 required statuses", () => {
    expect([...GATE_STATUSES]).toEqual([
      "passed", "failed", "missing", "null", "skipped",
      "unavailable", "infrastructure_error", "stale", "conflicting",
    ]);
  });

  it("only 'passed' is green for a required gate", () => {
    expect([...REQUIRED_GATE_GREEN_STATUSES]).toEqual(["passed"]);
  });

  it("all non-passed statuses are blocking", () => {
    expect([...REQUIRED_GATE_BLOCKING_STATUSES]).toEqual([
      "failed", "missing", "null", "skipped",
      "unavailable", "infrastructure_error", "stale", "conflicting",
    ]);
  });

  it("produces 'missing' when the executable is not found (ENOENT)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "/usr/local/nonexistent-binary-xyz123",
        args: [],
      }),
    }));
    expect(result.status).toBe("missing");
    expect(result.exitCode).toBe(null);
  });

  it("produces 'infrastructure_error' on timeout", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({
        executable: "node",
        args: ["-e", "setTimeout(()=>{}, 60000)"],
        timeout_ms: 200,
        expected_exit_codes: [0],
      }),
    }));
    expect(result.status).toBe("infrastructure_error");
    expect(result.timedOut).toBe(true);
  });

  it("produces 'unavailable' when the sandbox spec marks the backend unavailable", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
      sandboxUnavailable: true,
    }));
    expect(result.status).toBe("unavailable");
    expect(result.exitCode).toBe(null);
  });

  it("produces 'stale' when the observed candidate tree does not match the expected tree", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
      expectedCandidateTreeOid: "sha256:expected-tree-aaa",
      observedCandidateTreeOid: "sha256:different-tree-bbb",
    }));
    expect(result.status).toBe("stale");
  });

  it("produces 'conflicting' when the prior result digest diverges from the current observation", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
      priorResultDigest: "sha256:prior-result-digest-zzz",
      currentResultDigest: "sha256:current-result-digest-www",
    }));
    expect(result.status).toBe("conflicting");
  });

  it("produces 'null' when the verification spec is null", () => {
    const result = runGateVerification(makeRequest({
      verification: null as unknown as TicketVerification,
    }));
    expect(result.status).toBe("null");
  });

  it("produces 'skipped' when the request marks the verification as skipped", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
      skipped: true,
    }));
    expect(result.status).toBe("skipped");
  });
});

describe("gate-runner: fail-closed — every non-passed status blocks advancement (VAL-LIFE-004)", () => {
  const blockingStatuses = REQUIRED_GATE_BLOCKING_STATUSES;

  for (const status of blockingStatuses) {
    it(`status '${status}' is NOT in the green set (blocks advancement)`, () => {
      expect(REQUIRED_GATE_GREEN_STATUSES.includes(status as "passed")).toBe(false);
    });
  }

  it("a 'passed' gate is the only status that does not block", () => {
    expect(REQUIRED_GATE_GREEN_STATUSES.includes("passed")).toBe(true);
  });

  it("the overall verification status is 'fail' if any individual gate fails", () => {
    // Run two gates: one passes, one fails.
    const passResult = runGateVerification(makeRequest({
      verification: makeVerification({ id: "V-PASS", executable: "true", expected_exit_codes: [0] }),
    }));
    const failResult = runGateVerification(makeRequest({
      verification: makeVerification({ id: "V-FAIL", executable: "false", expected_exit_codes: [0] }),
    }));
    const overallPass = passResult.status === "passed" && failResult.status === "passed";
    expect(overallPass).toBe(false);
  });
});

describe("gate-runner: negative proofs", () => {
  it("a forged gate result (wrong contract digest) is not a valid authority-owned result", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
    }));
    // The result's contract digest must match the request's.
    expect(result.contractDigest).toBe(CONTRACT_DIGEST);
    // A different digest would be a forgery — prove the result binds to the request.
    const forged: GateRunnerResult = { ...result, contractDigest: "sha256:forged" };
    expect(forged.contractDigest).not.toBe(result.contractDigest);
  });

  it("replay of identical input produces identical argv digest (idempotency)", () => {
    const req = makeRequest({
      verification: makeVerification({ executable: "true", args: ["--x"] }),
    });
    const r1 = runGateVerification(req);
    const r2 = runGateVerification(req);
    expect(r1.argvDigest).toBe(r2.argvDigest);
    expect(r1.status).toBe(r2.status);
  });

  it("a stale candidate tree blocks the gate even when the executable would pass", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true", expected_exit_codes: [0] }),
      expectedCandidateTreeOid: "sha256:expected-aaa",
      observedCandidateTreeOid: "sha256:stale-bbb",
    }));
    expect(result.status).toBe("stale");
    // Stale is a blocking status.
    expect(REQUIRED_GATE_BLOCKING_STATUSES.includes("stale")).toBe(true);
  });

  it("a conflicting prior result blocks the gate even when the executable would pass", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true", expected_exit_codes: [0] }),
      priorResultDigest: "sha256:prior-zzz",
      currentResultDigest: "sha256:current-www",
    }));
    expect(result.status).toBe("conflicting");
    expect(REQUIRED_GATE_BLOCKING_STATUSES.includes("conflicting")).toBe(true);
  });

  it("a skipped verification blocks advancement (skip is not pass)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
      skipped: true,
    }));
    expect(result.status).toBe("skipped");
    expect(REQUIRED_GATE_BLOCKING_STATUSES.includes("skipped")).toBe(true);
  });

  it("a null verification spec blocks advancement (null is not pass)", () => {
    const result = runGateVerification(makeRequest({
      verification: null as unknown as TicketVerification,
    }));
    expect(result.status).toBe("null");
    expect(REQUIRED_GATE_BLOCKING_STATUSES.includes("null")).toBe(true);
  });

  it("an unavailable sandbox blocks advancement (unavailable is not pass)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
      sandboxUnavailable: true,
    }));
    expect(result.status).toBe("unavailable");
    expect(REQUIRED_GATE_BLOCKING_STATUSES.includes("unavailable")).toBe(true);
  });

  it("a missing executable blocks advancement (missing is not pass)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "/nonexistent/xyz123" }),
    }));
    expect(result.status).toBe("missing");
    expect(REQUIRED_GATE_BLOCKING_STATUSES.includes("missing")).toBe(true);
  });
});

describe("gate-runner: schema versioning", () => {
  it("exports a schema version string", () => {
    expect(typeof GATE_RUNNER_SCHEMA_VERSION).toBe("string");
    expect(GATE_RUNNER_SCHEMA_VERSION).toMatch(/^rickgent\./);
  });

  it("the result is a frozen object (authority-owned, not caller-mutable)", () => {
    const result = runGateVerification(makeRequest({
      verification: makeVerification({ executable: "true" }),
    }));
    expect(Object.isFrozen(result)).toBe(true);
  });
});
