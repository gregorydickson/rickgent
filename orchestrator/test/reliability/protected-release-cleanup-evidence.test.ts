import { describe, expect, it } from "vitest";
import { completedFailureCleanupCase } from "../../scripts/run-protected-release.mjs";

function observation(run: number) {
  return {
    branch_absent_on_independent_requery: true,
    pull_request_closed_on_independent_requery: true,
    repository_preserved_on_independent_requery: true,
    run_id: `protected-${run}`,
  };
}

describe("protected release aggregate cleanup evidence", () => {
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
