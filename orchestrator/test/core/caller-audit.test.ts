import { describe, it, expect } from "vitest";
import { evaluateCompletion, ALLOWED_COMPLETION_CALLERS } from "../../src/core/completion.js";

describe("AC-5 — completion oracle single predicate, pinned callers", () => {
  it("exports exactly one completion evaluation function", async () => {
    const completionModule = await import("../../src/core/completion.js");
    const exports = Object.keys(completionModule);
    const evalFunctions = exports.filter(e => e.startsWith("evaluate") || e.startsWith("check"));
    // W5: evaluateCompletion must be the ONLY exported evaluation function.
    // The previous assertion only checked containment, so a second evaluation
    // export would have slipped through silently.
    expect(evalFunctions).toEqual(["evaluateCompletion"]);
  });

  it("has an explicit caller allowlist", () => {
    expect(ALLOWED_COMPLETION_CALLERS.size).toBeGreaterThan(0);
    expect(ALLOWED_COMPLETION_CALLERS.has("cli.verdict")).toBe(true);
    expect(ALLOWED_COMPLETION_CALLERS.has("policy.completion-evidence")).toBe(true);
  });

  it("allowlist does not contain wildcard entries", () => {
    for (const caller of ALLOWED_COMPLETION_CALLERS) {
      expect(caller).not.toContain("*");
      expect(caller.length).toBeGreaterThan(0);
    }
  });

  it("evaluateCompletion is a pure function (same input, same output)", () => {
    const input = {
      claimedSha: "abc123",
      baselineSha: "def456",
      shaExists: true,
      treeChanged: true,
      gateGreen: true,
    };
    const result1 = evaluateCompletion(input);
    const result2 = evaluateCompletion(input);
    expect(result1).toEqual(result2);
  });

  it("throws when called by an unauthorized caller (W1 enforcement)", () => {
    const input = {
      claimedSha: "abc123",
      baselineSha: "def456",
      shaExists: true,
      treeChanged: true,
      gateGreen: true,
    };
    expect(() => evaluateCompletion(input, "rogue.caller")).toThrow();
  });

  it("does not throw when called by an authorized caller (W1 enforcement)", () => {
    const input = {
      claimedSha: "abc123",
      baselineSha: "def456",
      shaExists: true,
      treeChanged: true,
      gateGreen: true,
    };
    expect(() => evaluateCompletion(input, "cli.verdict")).not.toThrow();
  });
});
