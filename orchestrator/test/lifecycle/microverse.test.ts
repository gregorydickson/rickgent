import { describe, it, expect } from "vitest";
import { MicroverseRunner, classifyConvergence } from "../../src/lifecycle/microverse.js";

// B5: convergence is plateau/diminishing-delta + target-threshold.
// The Mission-1 "N consecutive improvements = converged" heuristic is RETIRED
// (docs/decisions/microverse.md). A still-climbing series is NOT converged.

describe("AC-6 (B5) — convergence semantics: plateau / diminishing-delta + target", () => {
  it("RETIRED: [60,70,80] (three large improvements, no target) is NOT converged", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 5, maxIterations: 10 });
    const result = runner.runSimulated([60, 70, 80]);
    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(3);
  });

  it("plateau: last N improvement deltas below epsilon converges", () => {
    const runner = new MicroverseRunner({
      metric: "coverage",
      stallLimit: 5,
      maxIterations: 10,
      epsilon: 1.0,
      window: 3,
    });
    const result = runner.runSimulated([60, 80, 80.5, 80.8, 81.0]);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("plateau");
  });

  it("target reached converges even while deltas are still large (VAL-MICRO-008)", () => {
    const runner = new MicroverseRunner({
      metric: "coverage",
      stallLimit: 5,
      maxIterations: 10,
      target: 75,
    });
    const result = runner.runSimulated([60, 70, 80]);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("target");
  });

  it("identical series stopping just below target is NOT converged (VAL-MICRO-008 pair)", () => {
    const runner = new MicroverseRunner({
      metric: "coverage",
      stallLimit: 5,
      maxIterations: 10,
      target: 85,
    });
    const result = runner.runSimulated([60, 70, 80]);
    expect(result.converged).toBe(false);
  });

  it("still-improving series (each delta above epsilon, target unmet) is NOT converged", () => {
    const runner = new MicroverseRunner({
      metric: "coverage",
      stallLimit: 5,
      maxIterations: 10,
      epsilon: 1.0,
      window: 3,
    });
    const result = runner.runSimulated([10, 30, 50, 70]);
    expect(result.converged).toBe(false);
  });

  it("rollback on regression preserves baseline", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 3, maxIterations: 10 });
    const result = runner.runSimulated([80, 70]);
    expect(result.history[1]?.rolledBack).toBe(true);
    expect(result.finalScore).toBe(80);
  });

  it("detects stall after stallLimit iterations (attrition, not convergence)", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 3, maxIterations: 10 });
    const result = runner.runSimulated([80, 80, 80, 80]);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe("stalled");
  });

  it("classifies first score as improved (baseline set)", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 3, maxIterations: 10 });
    const result = runner.runSimulated([50]);
    expect(result.history[0]?.classification).toBe("improved");
    expect(result.history[0]?.score).toBe(50);
  });

  it("regression does not update baseline", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 5, maxIterations: 10 });
    const result = runner.runSimulated([80, 70, 75]);
    expect(result.finalScore).toBe(80);
    expect(result.history[1]?.classification).toBe("regressed");
    expect(result.history[2]?.classification).toBe("regressed");
  });
});

describe("classifyConvergence — pure decision over an accepted-baseline score series", () => {
  const cfg = { epsilon: 1.0, window: 3, target: null as number | null, direction: "higher" as const, stallLimit: 3 };

  it("still-climbing large deltas → improving (not converged)", () => {
    expect(classifyConvergence([60, 70, 80], cfg).status).toBe("improving");
  });

  it("plateau (last N deltas < epsilon) → converged", () => {
    expect(classifyConvergence([60, 80, 80.5, 80.8, 81.0], cfg).status).toBe("converged");
  });

  it("target reached with large deltas → converged via target", () => {
    const d = classifyConvergence([60, 70, 80], { ...cfg, target: 75 });
    expect(d.status).toBe("converged");
    expect(d.via).toBe("target");
  });

  it("below target → improving", () => {
    expect(classifyConvergence([60, 70, 80], { ...cfg, target: 100 }).status).toBe("improving");
  });

  it("no improvement for stallLimit deltas → stalled (attrition)", () => {
    expect(classifyConvergence([80, 80, 80, 80], cfg).status).toBe("stalled");
  });

  it("lower-is-better: target crossed downward → converged via target", () => {
    const d = classifyConvergence([100, 90, 80], { ...cfg, target: 85, direction: "lower" });
    expect(d.status).toBe("converged");
    expect(d.via).toBe("target");
  });
});
