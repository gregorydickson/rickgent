import { describe, expect, it } from "vitest";
import {
  closeOwnedPullRequestWithRetry,
  pullRequestCleanupAction,
} from "../../scripts/run-protected-release.mjs";

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

  it("reconciles a lost partial-cleanup PATCH response without changing authority", () => {
    let observed = pull;
    let closeCalls = 0;
    closeOwnedPullRequestWithRetry(
      expected,
      () => observed,
      () => {
        closeCalls += 1;
        observed = { ...pull, state: "closed" };
        throw new Error("PATCH response lost");
      },
    );
    expect(closeCalls).toBe(1);
    expect(observed.state).toBe("closed");
  });

  it("refuses changed identity during partial-cleanup retry", () => {
    let observations = 0;
    expect(() => closeOwnedPullRequestWithRetry(
      expected,
      () => {
        observations += 1;
        return observations === 1
          ? pull
          : { ...pull, head: { ...pull.head, sha: "b".repeat(40) } };
      },
      () => {
        throw new Error("PATCH response lost");
      },
    )).toThrow("pull request cleanup authority changed");
  });
});
