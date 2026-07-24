import { describe, expect, it } from "vitest";
import {
  completedFailureCleanupCase,
  requireFailureCleanupPullObservation,
} from "../../scripts/run-protected-release.mjs";

const expectedPull = {
  baseBranch: "main",
  branch: "rickgent/protected/protected-1-failure-cleanup",
  deliveryOid: "a".repeat(40),
  pullRequestId: "17",
};

const closedPull = {
  base: { ref: expectedPull.baseBranch },
  head: {
    ref: expectedPull.branch,
    sha: expectedPull.deliveryOid,
  },
  number: 17,
  state: "closed",
};

function observation(run: number) {
  return {
    branch_absent_on_independent_requery: true,
    pull_request_closed_on_independent_requery: true,
    repository_preserved_on_independent_requery: true,
    run_id: `protected-${run}`,
  };
}

describe("protected release aggregate cleanup evidence", () => {
  it("binds independent closed-PR evidence to the created reviewed delivery", () => {
    expect(requireFailureCleanupPullObservation([closedPull], expectedPull)).toBe(true);

    for (const changed of [
      { ...closedPull, number: 18 },
      { ...closedPull, state: "open" },
      { ...closedPull, head: { ...closedPull.head, ref: "other" } },
      { ...closedPull, head: { ...closedPull.head, sha: "b".repeat(40) } },
      { ...closedPull, base: { ref: "other" } },
    ]) {
      expect(() => requireFailureCleanupPullObservation(
        [changed],
        expectedPull,
      )).toThrow("failure cleanup pull request identity changed");
    }
  });

  it("requires two complete, ordered live failure-cleanup observations", () => {
    expect(completedFailureCleanupCase([observation(1), observation(2)])).toEqual({
      completed: true,
      independently_requeried: true,
      kind: "failure",
    });

    const incomplete = observation(2);
    incomplete.pull_request_closed_on_independent_requery = false;
    expect(() => completedFailureCleanupCase([observation(1), incomplete])).toThrow(
      "two independently requeried failure cleanup observations are required",
    );
    expect(() => completedFailureCleanupCase([observation(2), observation(1)])).toThrow(
      "two independently requeried failure cleanup observations are required",
    );
    expect(() => completedFailureCleanupCase([observation(1)])).toThrow(
      "two independently requeried failure cleanup observations are required",
    );
  });
});
