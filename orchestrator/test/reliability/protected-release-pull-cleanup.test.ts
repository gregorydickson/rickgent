import { describe, expect, it } from "vitest";
import { pullRequestCleanupAction } from "../../scripts/run-protected-release.mjs";

const deliveryOid = "a".repeat(40);
const expected = {
  baseBranch: "main",
  branch: "rickgent/protected/run-1",
  deliveryOid,
  pullRequestId: "17",
};
const pull = {
  number: 17,
  state: "open",
  head: { ref: expected.branch, sha: deliveryOid },
  base: { ref: expected.baseBranch },
};

describe("protected release pull request cleanup authority", () => {
  it("accepts response-loss closure only after the owned close was attempted", () => {
    expect(pullRequestCleanupAction(pull, expected, false)).toBe("close");
    expect(pullRequestCleanupAction(
      { ...pull, state: "closed" },
      expected,
      true,
    )).toBe("already-closed");
    expect(() => pullRequestCleanupAction(
      { ...pull, state: "closed" },
      expected,
      false,
    )).toThrow("owned pull request closed before cleanup");
  });

  it.each([
    ["number", { ...pull, number: 18 }],
    ["head branch", { ...pull, head: { ...pull.head, ref: "other" } }],
    ["reviewed OID", { ...pull, head: { ...pull.head, sha: "b".repeat(40) } }],
    ["base branch", { ...pull, base: { ref: "other" } }],
  ])("refuses changed %s authority", (_label, observed) => {
    expect(() => pullRequestCleanupAction(
      observed,
      expected,
      false,
    )).toThrow("pull request cleanup authority changed");
  });
});
