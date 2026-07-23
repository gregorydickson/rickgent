import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProtectedRelease, type ProtectedRemote } from "../../src/protected-release/controller.js";
import type { ProtectedReleaseProfile } from "../../src/protected-release/profile.js";
import type { InstalledRuntime, InstalledResource } from "../../src/install/installed-runtime.js";

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
  const resource = (id: string, realpath: string): InstalledResource => ({ id, realpath, sha256: "f".repeat(64) });
  const installed: InstalledRuntime = {
    schema_version: "rickgent-installed-runtime/v1",
    package_root: resource("package_root", root),
    cli: resource("cli", manager),
    manager: resource("manager", realpathSync(manager)),
    worker: resource("worker", realpathSync(worker)),
    resource_map: resource("resource_map", manager),
    proof_metadata: resource("proof_metadata", manager),
    validators_root: resource("validators_root", root),
    license: resource("license", manager),
    omnigent_root: resource("omnigent_root", root),
    omnigent_python: resource("omnigent_python", manager),
  };
  return { profile, installed };
}

describe("protected release controller", () => {
  it("enforces two crash/resume runs and compare-before-delete cleanup", async () => {
    const { profile, installed } = setup();
    const branches = new Map<string, string>();
    const deletes: string[] = [];
    const remote: ProtectedRemote = {
      observeRepository: async () => ({ repository_id: "repo-1", visibility: "private", default_branch: "main" }),
      observeBranch: async (name) => branches.has(name) ? { name, oid: branches.get(name)! } : null,
      observeOwnedPullRequests: async () => [],
      closePullRequest: async () => undefined,
      deleteBranch: async (name, expectedOid) => { expect(branches.get(name)).toBe(expectedOid); deletes.push(name); branches.delete(name); },
    };
    const result = await runProtectedRelease(profile, installed, remote, {
      interruptRun: async () => undefined,
      executeTwoPhaseRun: async ({ runId, persistentStateId, branch }) => {
        const delivery = (runId === "protected-1" ? "c" : "d").repeat(40);
        branches.set(branch, delivery);
        return {
          run_id: runId, persistent_state_id: persistentStateId, owned_branch: branch, delivery_oid: delivery,
          crash: { process_id: 10, process_group_id: 10, death_observed: true },
          resume: { process_id: 11, process_group_id: 11, death_observed: false },
          response_loss_recovered: true,
        };
      },
    });
    expect(result.runs).toHaveLength(2);
    expect(deletes).toHaveLength(2);
    expect(result.repository_deleted).toBe(false);
  });

  it("rejects public or wrong-identity remotes before mutation", async () => {
    const { profile, installed } = setup();
    let executed = false;
    await expect(runProtectedRelease(profile, installed, {
      observeRepository: async () => ({ repository_id: "wrong", visibility: "public", default_branch: "main" }),
      observeBranch: async () => null,
      observeOwnedPullRequests: async () => [],
      closePullRequest: async () => undefined,
      deleteBranch: async () => undefined,
    }, {
      interruptRun: async () => undefined,
      executeTwoPhaseRun: async () => { executed = true; throw new Error("unreachable"); },
    })).rejects.toMatchObject({ code: "REMOTE_IDENTITY_MISMATCH" });
    expect(executed).toBe(false);
  });

  it("interrupts a timed-out run and still performs bounded cleanup", async () => {
    const { profile: base, installed } = setup();
    const profile = { ...base, command_timeout_ms: 1_000 } satisfies ProtectedReleaseProfile;
    const interrupted: string[] = [];
    await expect(runProtectedRelease(profile, installed, {
      observeRepository: async () => ({ repository_id: "repo-1", visibility: "private", default_branch: "main" }),
      observeBranch: async () => null,
      observeOwnedPullRequests: async () => [],
      closePullRequest: async () => undefined,
      deleteBranch: async () => undefined,
    }, {
      interruptRun: async (runId) => { interrupted.push(runId); },
      executeTwoPhaseRun: async () => await new Promise(() => undefined),
    })).rejects.toMatchObject({ code: "RUN_TIMEOUT" });
    expect(interrupted).toEqual(["protected-1"]);
  }, 5_000);
});
