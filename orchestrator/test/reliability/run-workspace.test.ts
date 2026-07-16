import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { exitCodeForRunOutcome } from "../../src/cli.js";
import { finalizeRunWorkspace, provisionRunWorkspace } from "../../src/git/run-workspace.js";
import { materializeWorkerBundle } from "../../src/dispatch/worker-materialization.js";
import { FIXTURE_BUILD_DEPENDENCIES, runFixtureBuild } from "../helpers/capabilities.js";

const filesystemFaults = vi.hoisted(() => ({
  lstatUnknown: new Set<string>(),
  rmFailure: new Set<string>(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    lstatSync(path: import("fs").PathLike) {
      if (filesystemFaults.lstatUnknown.has(String(path))) {
        const error = Object.assign(new Error(`injected lstat failure: ${String(path)}`), {
          code: "EACCES",
        });
        throw error;
      }
      return actual.lstatSync(path);
    },
    rmSync(path: import("fs").PathLike, options?: import("fs").RmDirOptions) {
      if (filesystemFaults.rmFailure.has(String(path))) {
        const error = Object.assign(new Error(`injected rm failure: ${String(path)}`), {
          code: "EACCES",
        });
        throw error;
      }
      return actual.rmSync(path, options);
    },
  };
});

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const PRD_MIN = join(import.meta.dirname, "../../../fixtures/prd-min.md");
// The only admitted source template is agents/rickgent/agents/worker.
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepository(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Fixture"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function walkUntracked(repo: string): Array<Record<string, unknown>> {
  const raw = execFileSync(
    "git",
    ["-C", repo, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer" },
  );
  return raw.toString("utf-8").split("\0").filter(Boolean).sort().map((path) => {
    const absolute = join(repo, path);
    const info = lstatSync(absolute);
    return {
      path,
      mode: info.mode,
      type: info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other",
      content: info.isSymbolicLink() ? readlinkSync(absolute) : info.isFile() ? hash(readFileSync(absolute)) : null,
    };
  });
}

function callerSnapshot(repo: string): Record<string, unknown> {
  const index = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  let branch: string | null = null;
  try { branch = git(repo, ["symbolic-ref", "HEAD"]); } catch { /* detached */ }
  return {
    head: git(repo, ["rev-parse", "HEAD"]),
    branch,
    index: hash(readFileSync(index)),
    staged: execFileSync("git", ["-C", repo, "diff", "--cached", "--binary"], { encoding: "buffer" }).toString("base64"),
    unstaged: execFileSync("git", ["-C", repo, "diff", "--binary"], { encoding: "buffer" }).toString("base64"),
    untracked: walkUntracked(repo),
  };
}

function cleanupDedicatedWorktrees(repo: string): void {
  let list = "";
  try {
    list = git(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    return;
  }
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (realpathSync(path) !== realpathSync(repo)) {
      try { git(repo, ["worktree", "remove", "--force", path]); } catch { /* test cleanup */ }
    }
  }
  let refs = "";
  try { refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/rickgent/runs"]); } catch { /* none */ }
  for (const ref of refs.split("\n").filter(Boolean)) {
    try { git(repo, ["update-ref", "-d", ref]); } catch { /* test cleanup */ }
  }
}

describe("M1 sequential run workspace", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rickgent-run-workspace-test-"));
    repo = join(root, "repo");
    initRepository(repo);
  });

  afterEach(() => {
    filesystemFaults.lstatUnknown.clear();
    filesystemFaults.rmFailure.clear();
    cleanupDedicatedWorktrees(repo);
    rmSync(root, { recursive: true, force: true });
  });

  it("spawns the attempt worker only after a clean dedicated worktree exists and leaves caller byte-for-byte unchanged", async () => {
    const before = callerSnapshot(repo);
    const spawnRecord = join(root, "spawn.json");
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      maxConcurrent: 1,
      roster: [{
        harness: "codex",
        model: "openai/fixture",
        vendor: "openai",
        tier: "fixture",
        pricing: { cost_per_dispatch: 0.01 },
      }],
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_MODE: "prompt",
        FIXTURE_TARGET_REPO: repo,
        FIXTURE_SPAWN_RECORD: spawnRecord,
      },
    });

    expect(result.ticketsCaptured).toBe(1);
    expect(result.ticketsDone).toBe(0);
    expect(result.outcome.status).toBe("failed");
    expect(result.outcome.issues.some((issue) => issue.reason === "zero_completion")).toBe(true);
    expect(callerSnapshot(repo)).toEqual(before); // caller byte-for-byte unchanged

    const spawned = JSON.parse(readFileSync(spawnRecord, "utf-8")) as {
      argv: string[];
      cwd: string;
      bundle: string;
      config: string;
      git: { head: string; branch: string; status: string };
    };
    expect(spawned.git.status).toBe("");
    expect(spawned.git.head).toBe(before["head"]);
    expect(spawned.git.branch).toMatch(/^refs\/heads\/rickgent\/runs\//);
    expect(spawned.cwd).not.toBe(repo);
    expect(spawned.bundle).toBe(spawned.argv[1]);
    expect(spawned.bundle).toContain("agents/rickgent/agents/worker");
    expect(spawned.bundle).not.toBe(AGENT_ROOT);
    expect(spawned.config).toContain("name: worker");
    expect(spawned.config).not.toContain("sys_os_shell");
    expect(spawned.config).not.toMatch(/sys_os_shell|ensure[^\n]*commit|must[^\n]*commit/i);
    expect(git(spawned.cwd, ["status", "--porcelain", "--untracked-files=all"])).toContain("src/feature.ts");
    expect(result.workspaceCleanup?.disposition).toBe("retained");
  });

  it.each([0, -1, 0.5, 2, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects maxConcurrent=%s before state, workspace, materialization, or spawn",
    async (maxConcurrent) => {
      const state = join(root, "state");
      const spawnRecord = join(root, "spawn.json");
      const before = callerSnapshot(repo);
      await expect(runFixtureBuild({
        prdPath: PRD_MIN,
        workingDir: repo,
        rickgentDir: state,
        agentDir: AGENT_ROOT,
        dataDir: join(root, "data"),
        maxConcurrent,
        env: { ...process.env, FIXTURE_SPAWN_RECORD: spawnRecord },
      })).rejects.toMatchObject({ name: "InputContractError" });
      expect(readdirSync(root).sort()).toEqual(["repo"]);
      expect(callerSnapshot(repo)).toEqual(before);
    },
  );

  it("rejects dirty and detached baselines before spawn with not-created cleanup evidence", async () => {
    writeFileSync(join(repo, "untracked.txt"), "caller-owned\n");
    const dirtyBefore = callerSnapshot(repo);
    const dirty = provisionRunWorkspace({
      targetRepo: repo,
      runId: "dirty",
      externalRoots: [join(root, "state")],
    });
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) {
      expect(dirty.code).toBe("RUN_WORKSPACE_DIRTY_BASELINE");
      expect(dirty.failureClass).toBe("input_contract");
      expect(dirty.cleanup).toMatchObject({ disposition: "not_created", worktreeAbsent: true, refAbsent: true });
    }
    expect(callerSnapshot(repo)).toEqual(dirtyBefore); // dirty caller remains unchanged

    rmSync(join(repo, "untracked.txt"));
    git(repo, ["checkout", "--detach", "-q"]);
    const detachedBefore = callerSnapshot(repo);
    const detached = provisionRunWorkspace({ targetRepo: repo, runId: "detached" });
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.cleanup.disposition).toBe("not_created");
    expect(callerSnapshot(repo)).toEqual(detachedBefore); // detached caller remains unchanged
  });

  it("rejects protected or colliding run refs before worktree creation", () => {
    const protectedResult = provisionRunWorkspace({
      targetRepo: repo,
      runId: "protected",
      requestedRunRef: "refs/heads/main",
    });
    expect(protectedResult.ok).toBe(false);
    if (!protectedResult.ok) {
      expect(protectedResult.code).toBe("RUN_WORKSPACE_PROTECTED_REF");
      expect(protectedResult.cleanup.worktreeAbsent).toBe(true);
    }

    const collision = "refs/heads/rickgent/runs/existing";
    git(repo, ["branch", collision.slice("refs/heads/".length), "HEAD"]);
    const collisionResult = provisionRunWorkspace({
      targetRepo: repo,
      runId: "collision",
      requestedRunRef: collision,
    });
    expect(collisionResult.ok).toBe(false);
    if (!collisionResult.ok) expect(collisionResult.code).toBe("RUN_WORKSPACE_REF_COLLISION");
  });

  it("rejects non-repository and unborn baselines with explicit absence evidence", () => {
    const notRepo = join(root, "not-repo");
    mkdirSync(notRepo);
    const invalid = provisionRunWorkspace({ targetRepo: notRepo, runId: "invalid" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe("RUN_WORKSPACE_INVALID_REPOSITORY");
      expect(invalid.failureClass).toBe("input_contract");
      expect(invalid.cleanup).toMatchObject({ disposition: "not_created", worktreeAbsent: true, refAbsent: true });
    }

    const unbornRepo = join(root, "unborn");
    mkdirSync(unbornRepo);
    git(unbornRepo, ["init", "-q"]);
    const unborn = provisionRunWorkspace({ targetRepo: unbornRepo, runId: "unborn" });
    expect(unborn.ok).toBe(false);
    if (!unborn.ok) {
      expect(unborn.code).toBe("RUN_WORKSPACE_INVALID_BASELINE");
      expect(unborn.failureClass).toBe("input_contract");
      expect(unborn.cleanup).toMatchObject({ disposition: "not_created", worktreeAbsent: true, refAbsent: true });
    }
  });

  it("classifies an unavailable Git observation as infrastructure instead of invalid input", async () => {
    const fakeBin = join(root, "failing-initial-git-bin");
    mkdirSync(fakeBin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    executable(
      join(fakeBin, "git"),
      `#!/bin/sh\ncase "$*" in\n  *"rev-parse --show-toplevel"*) exit 92 ;;\nesac\nexec "${realGit}" "$@"\n`,
    );

    const originalPath = process.env.PATH;
    let result;
    try {
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
      result = await runFixtureBuild({
        prdPath: PRD_MIN,
        workingDir: repo,
        rickgentDir: join(root, "state"),
        agentDir: AGENT_ROOT,
        dataDir: join(root, "data"),
        roster: [],
        env: { ...process.env },
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(result.outcome.primary).toBe("infrastructure");
    expect(result.outcome.issues.some((issue) =>
      issue.reason === "infrastructure_error" && issue.detail.includes("RUN_WORKSPACE_INVALID_REPOSITORY")
    )).toBe(true);
    expect(exitCodeForRunOutcome(result.outcome)).toBe(4);
  });

  it("reports retained cleanup evidence when Git cannot remove the linked worktree", () => {
    const provisioned = provisionRunWorkspace({ targetRepo: repo, runId: "cleanup-failure" });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;

    const fakeBin = join(root, "failing-cleanup-bin");
    mkdirSync(fakeBin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    executable(
      join(fakeBin, "git"),
      `#!/bin/sh\ncase "$*" in\n  *"worktree remove"*) exit 91 ;;\nesac\nexec "${realGit}" "$@"\n`,
    );

    const originalPath = process.env.PATH;
    let cleanup;
    try {
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
      cleanup = finalizeRunWorkspace(provisioned.workspace, false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(cleanup).toMatchObject({
      disposition: "retained",
      worktreeAbsent: false,
      refAbsent: true,
    });
    expect(cleanup.errors.join("\n")).toContain("worktree cleanup failed");
    expect(existsSync(provisioned.workspace.worktreeDir)).toBe(true);
  });

  it("removes a linked-worktree registration after its directory has vanished", () => {
    const provisioned = provisionRunWorkspace({ targetRepo: repo, runId: "vanished-worktree" });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;

    const { worktreeDir, worktreeGitDir } = provisioned.workspace;
    rmSync(worktreeDir, { recursive: true, force: true });
    expect(existsSync(worktreeDir)).toBe(false);
    expect(existsSync(worktreeGitDir)).toBe(true);

    const cleanup = finalizeRunWorkspace(provisioned.workspace, false);

    expect(cleanup).toEqual({
      disposition: "removed",
      worktreeAbsent: true,
      worktreeRegistrationAbsent: true,
      refAbsent: true,
      errors: [],
    });
    expect(existsSync(worktreeGitDir)).toBe(false);
  });

  it("never reports a run ref absent when Git cannot observe it during cleanup", async () => {
    const fakeBin = join(root, "failing-ref-observation-bin");
    const counter = join(root, "show-ref-count");
    mkdirSync(fakeBin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    executable(
      join(fakeBin, "git"),
      `#!/bin/sh\ncase "$*" in\n  *"show-ref --verify --quiet"*)\n    count=0\n    test -f "${counter}" && count=$(tr -d '\\n' < "${counter}")\n    count=$((count + 1))\n    printf '%s' "$count" > "${counter}"\n    test "$count" -gt 1 && exit 93\n    ;;\nesac\nexec "${realGit}" "$@"\n`,
    );

    const originalPath = process.env.PATH;
    let result;
    try {
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
      result = await runFixtureBuild({
        prdPath: PRD_MIN,
        workingDir: repo,
        rickgentDir: join(root, "state"),
        agentDir: AGENT_ROOT,
        dataDir: join(root, "data"),
        roster: [],
        env: { ...process.env },
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(result.workspaceCleanup).toMatchObject({
      disposition: "retained",
      worktreeAbsent: true,
      refAbsent: false,
    });
    expect(result.workspaceCleanup?.errors.join("\n")).toContain("run ref observation failed");
    expect(result.outcome.primary).toBe("cleanup");
    expect(exitCodeForRunOutcome(result.outcome)).toBe(7);
    expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/rickgent/runs"])).not.toBe("");
  });

  it("fails cleanup when worktree presence cannot be observed", async () => {
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [],
      env: { ...process.env },
    }, {
      ...FIXTURE_BUILD_DEPENDENCIES,
      finalizeRunWorkspace(workspace, retain) {
        filesystemFaults.lstatUnknown.add(workspace.worktreeDir);
        try {
          return finalizeRunWorkspace(workspace, retain);
        } finally {
          filesystemFaults.lstatUnknown.clear();
          rmSync(workspace.allocationRoot, { recursive: true, force: true });
        }
      },
    });

    expect(result.workspaceCleanup).toMatchObject({
      disposition: "retained",
      worktreeAbsent: false,
      refAbsent: true,
    });
    expect(result.workspaceCleanup?.errors.join("\n")).toContain("worktree path observation failed");
    expect(result.outcome.primary).toBe("cleanup");
    expect(exitCodeForRunOutcome(result.outcome)).toBe(7);
  });

  it("records allocation-root removal failure as retained cleanup evidence", async () => {
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [],
      env: { ...process.env },
    }, {
      ...FIXTURE_BUILD_DEPENDENCIES,
      finalizeRunWorkspace(workspace, retain) {
        filesystemFaults.rmFailure.add(workspace.allocationRoot);
        try {
          return finalizeRunWorkspace(workspace, retain);
        } finally {
          filesystemFaults.rmFailure.clear();
          rmSync(workspace.allocationRoot, { recursive: true, force: true });
        }
      },
    });

    expect(result.workspaceCleanup).toMatchObject({
      disposition: "retained",
      worktreeAbsent: true,
      refAbsent: true,
    });
    expect(result.workspaceCleanup?.errors.join("\n")).toContain("allocation root cleanup failed");
    expect(result.outcome.primary).toBe("cleanup");
    expect(exitCodeForRunOutcome(result.outcome)).toBe(7);
  });

  it("finalizes an unchanged workspace when post-provision state allocation throws", async () => {
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [],
      env: { ...process.env },
    }, {
      ...FIXTURE_BUILD_DEPENDENCIES,
      recordRun(): void {
        throw new Error("injected run-ledger failure");
      },
    });

    expect(result.outcome.primary).toBe("infrastructure");
    expect(result.outcome.issues.some((issue) =>
      issue.reason === "infrastructure_error" && issue.detail.includes("injected run-ledger failure")
    )).toBe(true);
    expect(result.workspaceCleanup).toMatchObject({
      disposition: "removed",
      worktreeAbsent: true,
      refAbsent: true,
      errors: [],
    });
    expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/rickgent/runs"])).toBe("");
  });

  it("classifies allocation infrastructure separately from allocation cleanup residue", async () => {
    const options = {
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [],
      env: { ...process.env },
    };
    const infrastructure = await runFixtureBuild(options, {
      ...FIXTURE_BUILD_DEPENDENCIES,
      provisionRunWorkspace() {
        return {
          ok: false as const,
          code: "RUN_WORKSPACE_ALLOCATION_FAILED" as const,
          failureClass: "infrastructure" as const,
          detail: "injected allocation failure",
          cleanup: {
            disposition: "removed" as const,
            worktreeAbsent: true,
            worktreeRegistrationAbsent: true,
            refAbsent: true,
            errors: [],
          },
        };
      },
    });
    expect(infrastructure.outcome.primary).toBe("infrastructure");
    expect(exitCodeForRunOutcome(infrastructure.outcome)).toBe(4);

    const cleanup = await runFixtureBuild(options, {
      ...FIXTURE_BUILD_DEPENDENCIES,
      provisionRunWorkspace() {
        return {
          ok: false as const,
          code: "RUN_WORKSPACE_ALLOCATION_FAILED" as const,
          failureClass: "infrastructure" as const,
          detail: "injected allocation failure with residue",
          cleanup: {
            disposition: "retained" as const,
            worktreeAbsent: false,
            worktreeRegistrationAbsent: false,
            refAbsent: false,
            errors: ["injected cleanup failure"],
          },
        };
      },
    });
    expect(cleanup.outcome.primary).toBe("cleanup");
    expect(cleanup.outcome.issues.some((issue) => issue.reason === "cleanup_failed")).toBe(true);
    expect(exitCodeForRunOutcome(cleanup.outcome)).toBe(7);
  });

  it("retains the run workspace and fails infrastructure when final Git observation is unknown", async () => {
    const fakeBin = join(root, "failing-observation-bin");
    mkdirSync(fakeBin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    executable(
      join(fakeBin, "git"),
      `#!/bin/sh\ncase "$*" in\n  *"status --porcelain"*) exit 92 ;;\nesac\nexec "${realGit}" "$@"\n`,
    );
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [{
        harness: "codex",
        model: "fixture",
        vendor: "openai",
        tier: "fixture",
        pricing: { cost_per_dispatch: 0.01 },
      }],
      env: {
        ...process.env,
        PATH: `${fakeBin}:${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_MODE: "prompt",
      },
    }, FIXTURE_BUILD_DEPENDENCIES);

    expect(result.ticketsCaptured).toBe(1);
    expect(result.outcome.primary).toBe("infrastructure");
    expect(result.report.join("\n")).toContain("run workspace observation unavailable — retaining");
    expect(result.workspaceCleanup).toMatchObject({
      disposition: "retained",
      worktreeAbsent: false,
      refAbsent: false,
      errors: [],
    });
  });

  it("promotes finalization residue to cleanup failure precedence", async () => {
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [],
      env: { ...process.env },
    }, {
      ...FIXTURE_BUILD_DEPENDENCIES,
      recordRun(): void {
        throw new Error("injected state failure");
      },
      finalizeRunWorkspace() {
        return {
          disposition: "retained" as const,
          worktreeAbsent: false,
          worktreeRegistrationAbsent: false,
          refAbsent: false,
          errors: ["injected finalizer failure"],
        };
      },
    });

    expect(result.outcome.primary).toBe("cleanup");
    expect(result.outcome.issues.map((issue) => issue.reason)).toContain("cleanup_failed");
    expect(exitCodeForRunOutcome(result.outcome)).toBe(7);
  });

  it("rejects a worker template whose instructions ask for a commit", () => {
    const agentRoot = join(root, "malicious-agent");
    const worker = join(agentRoot, "agents", "worker");
    mkdirSync(join(agentRoot, "agents"), { recursive: true });
    cpSync(join(AGENT_ROOT, "agents", "worker"), worker, { recursive: true });
    const configPath = join(worker, "config.yaml");
    const config = readFileSync(configPath, "utf-8").replace(
      "Do not stage or commit changes, mutate Git refs, or run Git mutation",
      "Commit changes after editing, but do not mutate Git refs or run Git mutation",
    );
    writeFileSync(configPath, config);
    expect(() => materializeWorkerBundle(agentRoot, join(root, "materialized"), {
      runId: "run",
      ticketId: "t01",
      phase: "implement",
      attempt: 1,
      role: "worker",
    })).toThrow("request Git mutation or a commit");
    expect(readdirSync(root)).not.toContain("materialized");
  });

  it("pins failure cwd to the run worktree and leaves caller byte-for-byte unchanged", async () => {
    const before = callerSnapshot(repo);
    const spawnRecord = join(root, "failure-spawn.json");
    const result = await runFixtureBuild({
      prdPath: PRD_MIN,
      workingDir: repo,
      rickgentDir: join(root, "state"),
      agentDir: AGENT_ROOT,
      dataDir: join(root, "data"),
      roster: [{ harness: "codex", model: "fixture", vendor: "openai", tier: "fixture", pricing: { cost_per_dispatch: 0.01 } }],
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_MODE: "prompt",
        FIXTURE_FAIL_PATHS: "src/feature.ts",
        FIXTURE_TARGET_REPO: repo,
        FIXTURE_SPAWN_RECORD: spawnRecord,
      },
    });
    expect(result.ticketsCaptured).toBe(0);
    expect(result.ticketsFailed).toBe(1);
    expect(callerSnapshot(repo)).toEqual(before); // failure caller byte-for-byte unchanged
    const spawned = JSON.parse(readFileSync(spawnRecord, "utf-8")) as { cwd: string };
    expect(relative(repo, spawned.cwd).startsWith("..")).toBe(true);
    expect(result.workspaceCleanup?.disposition).toBe("retained");
  });
});
