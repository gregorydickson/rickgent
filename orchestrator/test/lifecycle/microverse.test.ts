import { describe, it, expect } from "vitest";
import { MicroverseRunner } from "../../src/lifecycle/microverse.js";

describe("AC-6 — microverse convergence loop", () => {
  it("converges on improving metric", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 3, maxIterations: 10 });
    const result = runner.runSimulated([60, 70, 80]);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(3);
  });

  it("rollback on regression preserves baseline", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 3, maxIterations: 10 });
    const result = runner.runSimulated([80, 70]);
    expect(result.history[1]?.rolledBack).toBe(true);
    expect(result.finalScore).toBe(80);
  });

  it("detects stall after stallLimit iterations", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 3, maxIterations: 10 });
    const result = runner.runSimulated([80, 80, 80, 80]);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe("stalled");
  });

  it("does not converge with fewer than 3 improvements", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 5, maxIterations: 10 });
    const result = runner.runSimulated([60, 70]);
    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(2);
  });

  it("reports max iterations when scores run out", () => {
    const runner = new MicroverseRunner({ metric: "coverage", stallLimit: 10, maxIterations: 10 });
    const result = runner.runSimulated([50, 55]);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe("max iterations reached");
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
    // baseline stays at 80 after regression to 70, then 75 < 80 = regressed again
    expect(result.finalScore).toBe(80);
    expect(result.history[1]?.classification).toBe("regressed");
    expect(result.history[2]?.classification).toBe("regressed");
  });
});
