import { describe, it, expect } from "vitest";
import { evaluateCompletion, type CompletionInput } from "../../src/core/completion.js";

describe("completion oracle", () => {
  const baseInput: CompletionInput = {
    claimedSha: "abc123def456",
    baselineSha: "baseline789",
    shaExists: true,
    treeChanged: true,
    gateGreen: true,
  };

  it("returns COMMITTED when all checks pass", () => {
    const result = evaluateCompletion(baseInput);
    expect(result.verdict).toBe("COMMITTED");
  });

  it("returns UNVERIFIED when no claimed SHA", () => {
    const result = evaluateCompletion({ ...baseInput, claimedSha: null });
    expect(result.verdict).toBe("UNVERIFIED");
  });

  it("returns UNVERIFIED when SHA does not exist", () => {
    const result = evaluateCompletion({ ...baseInput, shaExists: false });
    expect(result.verdict).toBe("UNVERIFIED");
  });

  it("returns BASELINE_SHA when claimed SHA equals baseline", () => {
    const result = evaluateCompletion({ ...baseInput, claimedSha: "baseline789" });
    expect(result.verdict).toBe("BASELINE_SHA");
  });

  it("returns NO_TREE_CHANGE when tree matches baseline", () => {
    const result = evaluateCompletion({ ...baseInput, treeChanged: false });
    expect(result.verdict).toBe("NO_TREE_CHANGE");
  });

  it("returns UNVERIFIED when gate was not green", () => {
    const result = evaluateCompletion({ ...baseInput, gateGreen: false });
    expect(result.verdict).toBe("UNVERIFIED");
  });
});
