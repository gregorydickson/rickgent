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
    base_branch: "main",
    branch: `rickgent/protected/protected-${run}-failure-cleanup`,
    delivery_oid: "a".repeat(40),
    owned_branch_absent_on_requery: true,
    owned_pull_request_closed: true,
    pull_request_head_oid: "a".repeat(40),
    pull_request_id: String(20 + run),
    repository_preserved: true,
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
    incomplete.owned_pull_request_closed = false;
    expect(() => completedFailureCleanupCase([observation(1), incomplete])).toThrow(
      "two independently requeried failure cleanup observations are required",
    );
    const aliased = observation(2);
    aliased.pull_request_id = observation(1).pull_request_id;
    expect(() => completedFailureCleanupCase([observation(1), aliased])).toThrow(
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
