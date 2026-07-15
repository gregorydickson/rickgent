import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  cpSync,
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
import { runBuild } from "../../src/lifecycle/build.js";
import { provisionRunWorkspace } from "../../src/git/run-workspace.js";
import { materializeWorkerBundle } from "../../src/dispatch/worker-materialization.js";
import { FIXTURE_BUILD_DEPENDENCIES } from "../helpers/capabilities.js";

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
    cleanupDedicatedWorktrees(repo);
    rmSync(root, { recursive: true, force: true });
  });

  it("spawns the attempt worker only after a clean dedicated worktree exists and leaves caller byte-for-byte unchanged", async () => {
    const before = callerSnapshot(repo);
    const spawnRecord = join(root, "spawn.json");
    const result = await runBuild({
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
    }, FIXTURE_BUILD_DEPENDENCIES);

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
      await expect(runBuild({
        prdPath: PRD_MIN,
        workingDir: repo,
        rickgentDir: state,
        agentDir: AGENT_ROOT,
        dataDir: join(root, "data"),
        maxConcurrent,
        env: { ...process.env, FIXTURE_SPAWN_RECORD: spawnRecord },
      }, FIXTURE_BUILD_DEPENDENCIES)).rejects.toMatchObject({ name: "InputContractError" });
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
      expect(invalid.cleanup).toMatchObject({ disposition: "not_created", worktreeAbsent: true, refAbsent: true });
    }

    const unbornRepo = join(root, "unborn");
    mkdirSync(unbornRepo);
    git(unbornRepo, ["init", "-q"]);
    const unborn = provisionRunWorkspace({ targetRepo: unbornRepo, runId: "unborn" });
    expect(unborn.ok).toBe(false);
    if (!unborn.ok) {
      expect(unborn.code).toBe("RUN_WORKSPACE_INVALID_BASELINE");
      expect(unborn.cleanup).toMatchObject({ disposition: "not_created", worktreeAbsent: true, refAbsent: true });
    }
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
    const result = await runBuild({
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
    }, FIXTURE_BUILD_DEPENDENCIES);
    expect(result.ticketsCaptured).toBe(0);
    expect(result.ticketsFailed).toBe(1);
    expect(callerSnapshot(repo)).toEqual(before); // failure caller byte-for-byte unchanged
    const spawned = JSON.parse(readFileSync(spawnRecord, "utf-8")) as { cwd: string };
    expect(relative(repo, spawned.cwd).startsWith("..")).toBe(true);
    expect(result.workspaceCleanup?.disposition).toBe("retained");
  });
});
