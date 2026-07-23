import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProtectedRelease, type ProtectedRemote } from "../../src/protected-release/controller.js";
import type { ProtectedReleaseProfile } from "../../src/protected-release/profile.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "protected-controller-"));
  roots.push(root);
  const manager = join(root, "manager");
  const worker = join(root, "worker");
  writeFileSync(manager, "#!/bin/sh\n");
  writeFileSync(worker, "#!/bin/sh\n");
  const profile: ProtectedReleaseProfile = {
    schema_version: "rickgent-protected-release-profile/v1",
    authority_token: "authority-token-for-tests",
    npm_archive_sha256: "a".repeat(64),
    wheel_archive_sha256: "b".repeat(64),
    manager_entrypoint: realpathSync(manager),
    worker_entrypoint: realpathSync(worker),
    repository: {
      host: "example.invalid", owner: "owner", name: "disposable", repository_id: "repo-1",
      visibility: "private", allowlisted_disposable: true, pre_existing: true,
      base_branch: "main", owned_branch_prefix: "rickgent/protected/test-",
    },
    command_timeout_ms: 10_000,
  };
  return profile;
}

describe("protected release controller", () => {
  it("enforces two crash/resume runs and compare-before-delete cleanup", async () => {
    const profile = setup();
    const branches = new Map<string, string>();
    const deletes: string[] = [];
    const remote: ProtectedRemote = {
      observeRepository: async () => ({ repository_id: "repo-1", visibility: "private", default_branch: "main" }),
      observeBranch: async (name) => branches.has(name) ? { name, oid: branches.get(name)! } : null,
      observeOwnedPullRequests: async () => [],
      closePullRequest: async () => undefined,
      deleteBranch: async (name, expectedOid) => { expect(branches.get(name)).toBe(expectedOid); deletes.push(name); branches.delete(name); },
    };
    const result = await runProtectedRelease(profile, remote, {
      executeTwoPhaseRun: async ({ runId, persistentStateId, branch }) => {
        const delivery = (runId === "protected-1" ? "c" : "d").repeat(40);
        branches.set(branch, delivery);
        return {
          run_id: runId, persistent_state_id: persistentStateId, owned_branch: branch, delivery_oid: delivery,
          crash: { process_id: 10, process_group_id: 10, death_observed: true },
          resume: { process_id: 11, process_group_id: 11, death_observed: false },
        };
      },
    });
    expect(result.runs).toHaveLength(2);
    expect(deletes).toHaveLength(2);
    expect(result.repository_deleted).toBe(false);
  });

  it("rejects public or wrong-identity remotes before mutation", async () => {
    const profile = setup();
    let executed = false;
    await expect(runProtectedRelease(profile, {
      observeRepository: async () => ({ repository_id: "wrong", visibility: "public", default_branch: "main" }),
      observeBranch: async () => null,
      observeOwnedPullRequests: async () => [],
      closePullRequest: async () => undefined,
      deleteBranch: async () => undefined,
    }, {
      executeTwoPhaseRun: async () => { executed = true; throw new Error("unreachable"); },
    })).rejects.toMatchObject({ code: "REMOTE_IDENTITY_MISMATCH" });
    expect(executed).toBe(false);
  });
});
