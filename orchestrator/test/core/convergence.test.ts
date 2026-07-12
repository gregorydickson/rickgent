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
