import { describe, it, expect } from "vitest";
import { evaluateCompletion } from "../../src/core/completion.js";
import { decideSalvage } from "../../src/core/salvage.js";
import { evaluateConvergenceGate } from "../../src/core/convergence.js";
import { checkScope } from "../../src/core/scope.js";
import { evaluatePrd } from "../../src/core/prd.js";

describe("AC-16 — malformed-input matrix, fail closed", () => {
  describe("completion oracle", () => {
    it("handles null input by failing closed", () => {
      const result = evaluateCompletion(null as any);
      expect(result.verdict).toBe("UNVERIFIED");
    });

    it("handles undefined fields by failing closed", () => {
      const result = evaluateCompletion({} as any);
      expect(result.verdict).toBe("UNVERIFIED");
    });

    it("handles wrong types by failing closed", () => {
      const result = evaluateCompletion({
        claimedSha: 123,
        baselineSha: null,
        shaExists: "yes" as any,
        treeChanged: "true" as any,
        gateGreen: "green" as any,
      } as any);
      expect(result.verdict).toBe("UNVERIFIED");
    });
  });

  describe("salvage", () => {
    it("handles null input by returning error disposition", () => {
      const result = decideSalvage(null as any);
      expect(result.disposition).toBe("error");
    });

    it("handles undefined fields by returning error or no-op", () => {
      const result = decideSalvage({} as any);
      // Missing fields default to falsy — no tree change = no-op
      expect(["no-op", "error"].includes(result.disposition)).toBe(true);
    });
  });

  describe("convergence gate", () => {
    it("handles null input without throwing", () => {
      expect(() => evaluateConvergenceGate(null as any)).not.toThrow();
    });

    it("handles empty input by detecting stale baseline", () => {
      const result = evaluateConvergenceGate({} as any);
      expect(result.staleBaseline).toBe(true);
      expect(result.passed).toBe(false);
    });
  });

  describe("scope fence", () => {
    it("handles null input by denying", () => {
      const result = checkScope(null as any);
      expect(result.result).toBe("DENY");
    });

    it("handles empty input by denying", () => {
      const result = checkScope({} as any);
      expect(result.result).toBe("DENY");
    });
  });

  describe("PRD validation", () => {
    it("handles null input by returning invalid", () => {
      const result = evaluatePrd(null as any);
      expect(result.valid).toBe(false);
    });

    it("handles empty input by returning invalid", () => {
      const result = evaluatePrd({} as any);
      expect(result.valid).toBe(false);
    });
  });
});
