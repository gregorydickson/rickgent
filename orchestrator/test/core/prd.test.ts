import { describe, it, expect } from "vitest";
import { evaluatePrd, type PrdInput } from "../../src/core/prd.js";

describe("PRD validation", () => {
  const validPrd: PrdInput = {
    title: "test",
    description: "test",
    acceptanceCriteria: [
      {
        description: "auth rejects empty password",
        type: "test",
        verifyCommand: "pnpm test -- auth.empty-password.test.ts",
        scope: ["src/auth/", "test/auth.empty-password.test.ts"],
      },
    ],
    simplificationReview: { reviewed: true, notes: "reviewed" },
  };

  it("accepts a valid PRD", () => {
    expect(evaluatePrd(validPrd).valid).toBe(true);
  });

  it("rejects PRD without ACs", () => {
    expect(evaluatePrd({ ...validPrd, acceptanceCriteria: [] }).valid).toBe(false);
  });

  it("rejects PRD without simplification review", () => {
    expect(evaluatePrd({ ...validPrd, simplificationReview: null }).valid).toBe(false);
  });

  it("rejects PRD with empty verify command", () => {
    const prd = {
      ...validPrd,
      acceptanceCriteria: [{ ...validPrd.acceptanceCriteria[0]!, verifyCommand: "" }],
    };
    expect(evaluatePrd(prd).valid).toBe(false);
  });

  it("rejects PRD with interactive command", () => {
    const prd = {
      ...validPrd,
      acceptanceCriteria: [{ ...validPrd.acceptanceCriteria[0]!, verifyCommand: "read -p 'enter:'" }],
    };
    expect(evaluatePrd(prd).valid).toBe(false);
  });

  it("rejects PRD with network command", () => {
    const prd = {
      ...validPrd,
      acceptanceCriteria: [{ ...validPrd.acceptanceCriteria[0]!, verifyCommand: "curl https://example.com" }],
    };
    expect(evaluatePrd(prd).valid).toBe(false);
  });

  it("rejects PRD with empty scope", () => {
    const prd = {
      ...validPrd,
      acceptanceCriteria: [{ ...validPrd.acceptanceCriteria[0]!, scope: [] }],
    };
    expect(evaluatePrd(prd).valid).toBe(false);
  });
});
