import { describe, it, expect } from "vitest";
import { evaluateConvergenceGate, type GateInput } from "../../src/core/convergence.js";

describe("convergence gate", () => {
  const baseInput: GateInput = {
    current: [{ name: "lint", passed: true, output: "" }],
    baseline: [{ name: "lint", passed: false, output: "3 findings" }],
    scope: ["src/"],
    findings: [],
  };

  it("passes when all checks pass and baseline is fresh", () => {
    const result = evaluateConvergenceGate(baseInput);
    expect(result.passed).toBe(true);
    expect(result.staleBaseline).toBe(false);
  });

  it("fails when a check fails", () => {
    const result = evaluateConvergenceGate({
      ...baseInput,
      current: [{ name: "lint", passed: false, output: "error" }],
    });
    expect(result.passed).toBe(false);
  });

  it("detects stale baseline (zero baseline checks)", () => {
    const result = evaluateConvergenceGate({
      ...baseInput,
      baseline: [],
    });
    expect(result.staleBaseline).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("detects stale baseline (changed check names)", () => {
    const result = evaluateConvergenceGate({
      ...baseInput,
      current: [{ name: "tsc", passed: true, output: "" }],
    });
    expect(result.staleBaseline).toBe(true);
  });

  it("fails on zero current checks (silence is not success)", () => {
    const result = evaluateConvergenceGate({
      ...baseInput,
      current: [],
    });
    expect(result.passed).toBe(false);
  });
});

describe("convergence scope filtering (A-BUG-1)", () => {
  const passingChecks = {
    current: [{ name: "lint", passed: true, output: "" }],
    baseline: [{ name: "lint", passed: false, output: "" }],
  };

  it("VAL-BUG-001: excludes a sibling directory that shares a name prefix", () => {
    const result = evaluateConvergenceGate({
      ...passingChecks,
      scope: ["src"],
      findings: [{ file: "src2/foo.ts", line: 1, message: "x", check: "lint" }],
    });
    expect(result.newFindings).toHaveLength(0);
  });

  it("VAL-BUG-002: retains an in-scope finding", () => {
    const result = evaluateConvergenceGate({
      ...passingChecks,
      scope: ["src"],
      findings: [{ file: "src/foo.ts", line: 1, message: "x", check: "lint" }],
    });
    expect(result.newFindings).toHaveLength(1);
    expect(result.newFindings[0].file).toBe("src/foo.ts");
  });

  it("VAL-BUG-003: gate is not blocked by an out-of-scope sibling finding", () => {
    const result = evaluateConvergenceGate({
      ...passingChecks,
      scope: ["src"],
      findings: [{ file: "src2/foo.ts", line: 1, message: "x", check: "lint" }],
    });
    expect(result.passed).toBe(true);
  });
});
