import { describe, expect, it } from "vitest";
import {
  completeGitHubCollection,
  requireExecuteRemoteAuthority,
  requireTeardownDryRun,
  requireUnchangedRemoteObservation,
} from "../../scripts/run-protected-release.mjs";

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
  const namespaceSeed = "a".repeat(64);
  const contract = {
    base_branch: "main",
    delete_repository: false,
    host: "github.com",
    owner: "owner",
    remote_url: "https://github.com/owner/repository.git",
    repository: "repository",
    schema_version: "rickgent.release-remote-contract/v1",
  };
  const remote = {
    allowlist_match: true,
    base_branch: "main",
    host: "github.com",
    owned_namespace: "rickgent/protected/d19726c525997862746f2066",
    owner: "owner",
    repository: "repository",
    repository_id: "123",
  };
  const teardown = {
    close_owned_prs_only: true,
    compare_before_delete: true,
    delete_owned_branches_only: true,
    force_delete: false,
    owned_namespace: remote.owned_namespace,
    registered_before_mutation: true,
    repository_deletion: false,
    repository_id: remote.repository_id,
    requery_after_action: true,
  };

  it("binds execute mutations to the independently supplied remote contract", () => {
    expect(() => requireExecuteRemoteAuthority(remote, contract, namespaceSeed)).not.toThrow();

    for (const forged of [
      { ...remote, owner: "other" },
      { ...remote, repository: "other" },
      { ...remote, base_branch: "release" },
      { ...remote, repository_id: "456" },
      { ...remote, owned_namespace: "rickgent/protected/d19726c525997862746f2067" },
    ]) {
      expect(() => requireExecuteRemoteAuthority(forged, contract, namespaceSeed)).toThrow(
        "execute preflight does not match the approved remote contract",
      );
    }
  });

  it("retains records from every GitHub response page", () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}` })),
      [{ name: "rickgent/protected/leaked-owned-branch" }],
    ];

    const collection = completeGitHubCollection(pages, "branch");

    expect(collection).toHaveLength(101);
    expect(collection.at(-1)).toEqual({ name: "rickgent/protected/leaked-owned-branch" });
    expect(() => completeGitHubCollection([], "branch")).toThrow(
      "paginated GitHub branch observation is invalid",
    );
    expect(() => completeGitHubCollection([[{ name: "main" }], null], "branch")).toThrow(
      "paginated GitHub branch observation is invalid",
    );
  });

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

  it("earns teardown dry-run evidence from exact cleanup state transitions", () => {
    expect(requireTeardownDryRun(remote, teardown)).toBe(true);

    for (const changed of [
      { ...teardown, compare_before_delete: false },
      { ...teardown, owned_namespace: "rickgent/protected/other" },
      { ...teardown, repository_id: "456" },
      { ...teardown, requery_after_action: false },
    ]) {
      expect(() => requireTeardownDryRun(remote, changed)).toThrow(
        "protected teardown dry run is not bound to the observed remote",
      );
    }
  });
});
