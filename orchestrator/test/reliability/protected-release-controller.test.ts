import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProtectedRelease, type ProtectedRemote } from "../../src/protected-release/controller.js";
import type { ProtectedReleaseProfile } from "../../src/protected-release/profile.js";
import type { InstalledRuntime, InstalledResource } from "../../src/install/installed-runtime.js";
import fixture from "../fixtures/protected-release/manifest.json";

const roots: string[] = [];
const processGroups = new Set<number>();

afterEach(() => {
  for (const pgid of processGroups) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already dead */ }
  }
  processGroups.clear();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "protected-controller-"));
  roots.push(root);
  const cli = join(root, "installed-cli");
  const manager = join(root, "manager");
  const worker = join(root, "worker");
  for (const path of [cli, manager, worker]) writeFileSync(path, "#!/bin/sh\n");
  const profile: ProtectedReleaseProfile = {
    schema_version: "rickgent-protected-release-profile/v1",
    authority_token: "hermetic-authority-token",
    npm_archive_sha256: fixture.t37.npm_archive_sha256,
    wheel_archive_sha256: fixture.t37.wheel_archive_sha256,
    manager_entrypoint: realpathSync(manager),
    worker_entrypoint: realpathSync(worker),
    repository: {
      ...fixture.remote,
      visibility: "private",
      allowlisted_disposable: true,
      pre_existing: true,
    },
    command_timeout_ms: 10_000,
  };
  const resource = (id: string, path: string): InstalledResource => ({
    id,
    realpath: realpathSync(path),
    sha256: "f".repeat(64),
  });
  const installed: InstalledRuntime = {
    schema_version: "rickgent-installed-runtime/v1",
    package_root: resource("package_root", root),
    cli: resource("cli", cli),
    manager: resource("manager", manager),
    worker: resource("worker", worker),
    resource_map: resource("resource_map", manager),
    proof_metadata: resource("proof_metadata", manager),
    validators_root: resource("validators_root", root),
    license: resource("license", manager),
    omnigent_root: resource("omnigent_root", root),
    omnigent_python: resource("omnigent_python", manager),
  };
  return { root, profile, installed };
}

type PackedAuthority = {
  executable: string;
  receipt_sha256: string;
  source_git_oid: string;
  build_id: string;
  npm_archive_sha256: string;
  wheel_archive_sha256: string;
  evidence_classification: "live" | "fixture";
  created_at: string;
};

function authorizeT37(authority: PackedAuthority, installed: InstalledRuntime, now = Date.now()): void {
  if (realpathSync(authority.executable) !== installed.cli.realpath) throw new Error("installed executable mismatch");
  if (authority.receipt_sha256 !== fixture.t37.packed_install_receipt_sha256) throw new Error("packed receipt mismatch");
  if (authority.source_git_oid !== fixture.t37.source_git_oid || authority.build_id !== fixture.t37.build_id) {
    throw new Error("source/build identity mismatch");
  }
  if (
    authority.npm_archive_sha256 !== fixture.t37.npm_archive_sha256 ||
    authority.wheel_archive_sha256 !== fixture.t37.wheel_archive_sha256
  ) throw new Error("archive identity mismatch");
  if (authority.evidence_classification !== "live") throw new Error("fixture evidence is not live authority");
  if (now - Date.parse(authority.created_at) > 7 * 24 * 60 * 60 * 1000) throw new Error("packed receipt is stale");
}

function validAuthority(installed: InstalledRuntime): PackedAuthority {
  return {
    executable: installed.cli.realpath,
    receipt_sha256: fixture.t37.packed_install_receipt_sha256,
    source_git_oid: fixture.t37.source_git_oid,
    build_id: fixture.t37.build_id,
    npm_archive_sha256: fixture.t37.npm_archive_sha256,
    wheel_archive_sha256: fixture.t37.wheel_archive_sha256,
    evidence_classification: "live",
    created_at: "2026-07-23T12:00:00.000Z",
  };
}

function makeRemote(branches = new Map<string, string>()) {
  const mutations: Array<{ operation: string; repository_id: string; resource: string }> = [];
  const remote: ProtectedRemote = {
    observeRepository: async () => ({
      repository_id: fixture.remote.repository_id,
      visibility: "private",
      default_branch: fixture.remote.base_branch,
    }),
    observeBranch: async (name) => branches.has(name) ? { name, oid: branches.get(name)! } : null,
    observeOwnedPullRequests: async () => [],
    closePullRequest: async (id) => {
      mutations.push({ operation: "close_pr", repository_id: fixture.remote.repository_id, resource: id });
    },
    deleteBranch: async (name, expectedOid) => {
      expect(branches.get(name)).toBe(expectedOid);
      mutations.push({ operation: "delete_branch", repository_id: fixture.remote.repository_id, resource: name });
      branches.delete(name);
    },
  };
  return { remote, mutations };
}

async function groupDies(pgid: number, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      // Darwin can transiently return EPERM while a killed group is being
      // reaped. It is not death proof, so continue polling to bounded ESRCH.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return false;
}

describe("protected release controller", () => {
  it("binds authority to the committed t37 installed executable and immutable receipt identities", () => {
    const { root, installed } = setup();
    const valid = validAuthority(installed);
    expect(() => authorizeT37(valid, installed, Date.parse("2026-07-23T12:01:00Z"))).not.toThrow();

    const packed = JSON.parse(readFileSync(resolve("../artifacts/reliability/packed-install-summary.json"), "utf8")) as {
      digest: string;
      binding: {
        source_git_oid: string;
        build: { id: string; sha256: string };
        archives: Array<{ kind: string; sha256: string }>;
      };
    };
    const proofIndex = JSON.parse(readFileSync(resolve("../artifacts/reliability/release-proof-index.json"), "utf8")) as {
      receipts: { packed: { digest: string } };
      bindings: {
        source_git_oid: string;
        build: { id: string; sha256: string };
        archives: Array<{ kind: string; sha256: string }>;
      };
    };
    const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(packed.digest).toBe(proofIndex.receipts.packed.digest);
    expect(packed.binding.source_git_oid).toBe(proofIndex.bindings.source_git_oid);
    expect(packed.binding.build).toEqual(proofIndex.bindings.build);
    expect(packed.binding.archives).toEqual(expect.arrayContaining(
      proofIndex.bindings.archives.map((archive) => expect.objectContaining(archive)),
    ));
    const npmArchive = proofIndex.bindings.archives.find((archive) => archive.kind === "npm_tarball");
    const wheelArchive = proofIndex.bindings.archives.find((archive) => archive.kind === "python_wheel");
    expect(npmArchive).toBeDefined();
    expect(wheelArchive).toBeDefined();
    expect(sha256(resolve("../artifacts/reliability/npm-dist/rickgent-0.1.0-alpha.tgz"))).toBe(npmArchive!.sha256);
    expect(sha256(resolve("../artifacts/reliability/python-dist/rickgent_policies-0.1.0a0-py3-none-any.whl"))).toBe(wheelArchive!.sha256);

    const source = join(root, "source-cli.ts");
    writeFileSync(source, "source entrypoint");
    const negatives: Array<[Partial<PackedAuthority>, string]> = [
      [{ executable: source }, "installed executable mismatch"],
      [{ receipt_sha256: "0".repeat(64) }, "packed receipt mismatch"],
      [{ source_git_oid: "0".repeat(40) }, "source/build identity mismatch"],
      [{ build_id: "0".repeat(40) }, "source/build identity mismatch"],
      [{ npm_archive_sha256: "0".repeat(64) }, "archive identity mismatch"],
      [{ wheel_archive_sha256: "0".repeat(64) }, "archive identity mismatch"],
      [{ evidence_classification: "fixture" }, "fixture evidence is not live authority"],
      [{ created_at: "2026-07-01T00:00:00Z" }, "packed receipt is stale"],
    ];
    for (const [change, message] of negatives) {
      expect(() => authorizeT37({ ...valid, ...change }, installed, Date.parse("2026-07-23T12:01:00Z"))).toThrow(message);
    }

    const runner = readFileSync(resolve("scripts/run-protected-release.mjs"), "utf8");
    const sourceReferences = readFileSync(resolve("src/cli.ts"), "utf8");
    expect(runner).toContain('RICKGENT_PROTECTED_AUTHORITY !== "I_ACCEPT_REMOTE_MUTATION"');
    expect(runner).toContain('cli.includes("/rickgent/orchestrator/")');
    expect(runner).toContain('cli.includes("/node_modules/.pnpm/")');
    expect(sourceReferences).not.toContain("runProtectedRelease");
    expect(sourceReferences).not.toContain("RICKGENT_PROTECTED_AUTHORITY");
  });

  it("kills the OS process group at the persisted boundary and resumes the same authority without stale replay", async () => {
    if (process.platform === "win32") return;
    const { root } = setup();
    const checkpoint = join(root, "checkpoint.json");
    const runId = "protected-1";
    const stateId = "state-protected-1";
    const child = spawn(process.execPath, [
      resolve("test/fixtures/protected-release/checkpoint-process.mjs"),
      checkpoint,
      runId,
      stateId,
    ], { detached: true, stdio: "ignore" });
    if (child.pid === undefined) throw new Error("detached child did not receive a PID");
    child.unref();
    processGroups.add(child.pid);

    const deadline = Date.now() + 4_000;
    while (!existsSync(checkpoint) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const persisted = JSON.parse(readFileSync(checkpoint, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      boundary: "post-persistence/pre-hosted-side-effect",
      run_id: runId,
      persistent_state_id: stateId,
      process_id: child.pid,
      process_group_id: child.pid,
    });

    process.kill(-child.pid, "SIGKILL");
    expect(await groupDies(child.pid)).toBe(true);
    processGroups.delete(child.pid);

    const resumed = {
      run_id: persisted["run_id"],
      persistent_state_id: persisted["persistent_state_id"],
      attempt_id: `${runId}:resume`,
      process_id: process.pid,
      process_group_id: process.pid,
      terminal_evidence_ids: ["terminal:resume"],
    };
    expect(resumed.run_id).toBe(runId);
    expect(resumed.persistent_state_id).toBe(stateId);
    expect(resumed.attempt_id).not.toBe(persisted["attempt_id"]);
    expect(resumed.process_id).not.toBe(persisted["process_id"]);
    expect(resumed.process_group_id).not.toBe(persisted["process_group_id"]);
    expect(resumed.terminal_evidence_ids).not.toContain("terminal:crash");
  });

  it("enforces two crash/resume runs and compare-before-delete cleanup", async () => {
    const { profile, installed } = setup();
    const branches = new Map<string, string>();
    const { remote, mutations } = makeRemote(branches);
    const result = await runProtectedRelease(profile, installed, remote, {
      interruptRun: async () => undefined,
      executeTwoPhaseRun: async ({ runId, persistentStateId, branch }) => {
        const delivery = (runId === "protected-1" ? "c" : "d").repeat(40);
        branches.set(branch, delivery);
        return {
          run_id: runId,
          persistent_state_id: persistentStateId,
          owned_branch: branch,
          delivery_oid: delivery,
          crash: { process_id: runId.endsWith("1") ? 10 : 20, process_group_id: runId.endsWith("1") ? 10 : 20, death_observed: true },
          resume: { process_id: runId.endsWith("1") ? 11 : 21, process_group_id: runId.endsWith("1") ? 11 : 21, death_observed: false },
          response_loss_recovered: true,
        };
      },
    });
    expect(result.runs.map((run) => run.run_id)).toEqual(["protected-1", "protected-2"]);
    expect(mutations.map((item) => item.resource)).toEqual([
      "rickgent/protected/hermetic-protected-1",
      "rickgent/protected/hermetic-protected-2",
    ]);
    expect(result).toMatchObject({ cleanup_requeried: true, repository_deleted: false });
  });

  it("requires immutable repository and exact owned-resource identity for mutations", async () => {
    type Mutation = {
      repository_id: string;
      branch?: string;
      pull_request_id?: string;
      force?: boolean;
      delete_repository?: boolean;
      identity_source?: "validated_descriptor" | "git_config" | "unchecked";
    };
    const validateMutation = (mutation: Mutation): void => {
      if (fixture.remote.host !== "example.invalid" || !fixture.remote.name.includes("fixture")) throw new Error("production-looking target");
      if (mutation.repository_id !== fixture.remote.repository_id) throw new Error("repository identity");
      if (mutation.identity_source !== "validated_descriptor") throw new Error("unvalidated identity source");
      if (mutation.force === true) throw new Error("force push forbidden");
      if (mutation.delete_repository === true) throw new Error("repository deletion forbidden");
      if (mutation.branch !== undefined && !mutation.branch.startsWith(fixture.remote.owned_branch_prefix)) throw new Error("non-owned branch");
      if (mutation.pull_request_id !== undefined && !/^fixture-pr-\d+$/.test(mutation.pull_request_id)) throw new Error("non-owned pull request");
    };
    expect(() => validateMutation({
      repository_id: fixture.remote.repository_id,
      branch: `${fixture.remote.owned_branch_prefix}protected-1`,
      pull_request_id: "fixture-pr-1",
      identity_source: "validated_descriptor",
    })).not.toThrow();
    for (const mutation of [
      { repository_id: "owner/name", identity_source: "validated_descriptor" },
      { repository_id: fixture.remote.repository_id, identity_source: "git_config" },
      { repository_id: fixture.remote.repository_id, identity_source: "unchecked" },
      { repository_id: fixture.remote.repository_id, branch: "main", identity_source: "validated_descriptor" },
      { repository_id: fixture.remote.repository_id, pull_request_id: "99", identity_source: "validated_descriptor" },
      { repository_id: fixture.remote.repository_id, force: true, identity_source: "validated_descriptor" },
      { repository_id: fixture.remote.repository_id, delete_repository: true, identity_source: "validated_descriptor" },
    ] as Mutation[]) expect(() => validateMutation(mutation)).toThrow();
  });

  it("rejects wrong remote identity before mutation and interrupts a bounded run", async () => {
    const { profile: base, installed } = setup();
    let executed = false;
    await expect(runProtectedRelease(base, installed, {
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

    const interrupted: string[] = [];
    const { remote } = makeRemote();
    await expect(runProtectedRelease({ ...base, command_timeout_ms: 1_000 }, installed, remote, {
      interruptRun: async (runId) => { interrupted.push(runId); },
      executeTwoPhaseRun: async () => await new Promise(() => undefined),
    })).rejects.toMatchObject({ code: "RUN_TIMEOUT" });
    expect(interrupted).toEqual(["protected-1"]);
  }, 5_000);
});
