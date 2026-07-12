import { describe, it, expect } from "vitest";
import { PHASES, shouldAdvance, nextPhase, isTerminal, type Phase, type PhaseResult } from "../../src/lifecycle/phase.js";

describe("phase state machine", () => {
  const successResult = (phase: Phase): PhaseResult => ({
    phase,
    success: true,
    output: "ok",
    commitSha: "abc123",
  });

  it("has exactly 8 phases in order", () => {
    expect(PHASES).toHaveLength(8);
    expect(PHASES[0]).toBe("research");
    expect(PHASES[7]).toBe("simplify");
  });

  it("shouldAdvance returns true on success with correct nextPhase", () => {
    const result = shouldAdvance("research", successResult("research"));
    expect(result.advance).toBe(true);
    expect(result.nextPhase).toBe("research_review");
  });

  it("shouldAdvance returns false on failure", () => {
    const result = shouldAdvance("research", { ...successResult("research"), success: false });
    expect(result.advance).toBe(false);
    expect(result.nextPhase).toBeNull();
  });

  it("shouldAdvance returns false at last phase", () => {
    const result = shouldAdvance("simplify", successResult("simplify"));
    expect(result.advance).toBe(false);
    expect(result.nextPhase).toBeNull();
    expect(result.reason).toContain("last phase");
  });

  it("shouldAdvance transitions through all review gates", () => {
    expect(shouldAdvance("research", successResult("research")).nextPhase).toBe("research_review");
    expect(shouldAdvance("research_review", successResult("research_review")).nextPhase).toBe("plan");
    expect(shouldAdvance("plan", successResult("plan")).nextPhase).toBe("plan_review");
    expect(shouldAdvance("plan_review", successResult("plan_review")).nextPhase).toBe("implement");
    expect(shouldAdvance("implement", successResult("implement")).nextPhase).toBe("spec_conformance");
    expect(shouldAdvance("spec_conformance", successResult("spec_conformance")).nextPhase).toBe("code_review");
    expect(shouldAdvance("code_review", successResult("code_review")).nextPhase).toBe("simplify");
  });

  it("nextPhase returns the next phase in sequence", () => {
    expect(nextPhase("research")).toBe("research_review");
    expect(nextPhase("implement")).toBe("spec_conformance");
  });

  it("nextPhase returns null at terminal phase", () => {
    expect(nextPhase("simplify")).toBeNull();
  });

  it("isTerminal returns true only for simplify", () => {
    expect(isTerminal("simplify")).toBe(true);
    expect(isTerminal("research")).toBe(false);
    expect(isTerminal("implement")).toBe(false);
  });
});
