import { describe, expect, it } from "vitest";
import { requireUnchangedRemoteObservation } from "../../scripts/run-protected-release.mjs";

function observation() {
  return {
    remote: {
      observation_sha256: "a".repeat(64),
      owned_namespace: "rickgent/protected/fixture",
      repository_id: "123",
    },
    snapshot: {
      branches_sha256: "b".repeat(64),
      pull_requests_sha256: "c".repeat(64),
      repository_exists: true,
      repository_id: "123",
    },
  };
}

describe("protected release preflight remote observation", () => {
  it("requires independently queried remote state to remain identical", () => {
    const before = observation();
    expect(() => requireUnchangedRemoteObservation(before, structuredClone(before))).not.toThrow();

    const changedBranch = structuredClone(before);
    changedBranch.snapshot.branches_sha256 = "d".repeat(64);
    expect(() => requireUnchangedRemoteObservation(before, changedBranch)).toThrow(
      "remote lifecycle state changed during preflight",
    );

    const changedIdentity = structuredClone(before);
    changedIdentity.remote.repository_id = "456";
    expect(() => requireUnchangedRemoteObservation(before, changedIdentity)).toThrow(
      "remote lifecycle state changed during preflight",
    );
  });
});
