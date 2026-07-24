import { describe, expect, it } from "vitest";
import { pullRequestCleanupCandidates } from "../../scripts/run-protected-release.mjs";

const branch = "protected-release/protected-1";
const deliveryOid = "a".repeat(40);

function pull(number: number) {
  return {
    head: { ref: branch, sha: deliveryOid },
    number,
    state: "open",
  };
}

describe("protected release pull-request response-loss cleanup", () => {
  it("recovers cleanup identities only from the bound branch and delivery commit", () => {
    expect(pullRequestCleanupCandidates([], branch, null)).toEqual([]);
    expect(pullRequestCleanupCandidates([pull(41)], branch, deliveryOid)).toEqual(["41"]);
    expect(pullRequestCleanupCandidates(
      [pull(41), pull(42)],
      branch,
      deliveryOid,
    )).toEqual(["41", "42"]);

    expect(() => pullRequestCleanupCandidates([pull(41)], branch, null)).toThrow(
      "partial pull request cleanup has no bound delivery OID",
    );
    expect(() => pullRequestCleanupCandidates([
      { ...pull(41), head: { ref: branch, sha: "b".repeat(40) } },
    ], branch, deliveryOid)).toThrow(
      "partial pull request cleanup observation changed ownership",
    );
    expect(() => pullRequestCleanupCandidates([
      { ...pull(41), head: { ref: "foreign/protected-1", sha: deliveryOid } },
    ], branch, deliveryOid)).toThrow(
      "partial pull request cleanup observation changed ownership",
    );
  });
});
