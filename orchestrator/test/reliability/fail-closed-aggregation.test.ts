import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exitCodeForRunOutcome } from "../../src/cli.js";
import { aggregateRunOutcome, runIssue } from "../../src/lifecycle/run-outcome.js";

const FIXTURE_CLI = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");
const PRODUCTION_CLI = join(import.meta.dirname, "../../dist/cli.js");
const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const BUILD_SOURCE = join(import.meta.dirname, "../../src/lifecycle/build.ts");
const TEST_ROSTER_JSON = JSON.stringify([
  {
    harness: "claude",
    model: "anthropic/claude-sonnet-4",
    vendor: "anthropic",
    tier: "mid",
    pricing: { cost_per_dispatch: 0.5 },
  },
]);

interface Dirs {
  root: string;
  repo: string;
  dataDir: string;
  rickgentDir: string;
  agentDir: string;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function setupDirs(): Dirs {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-fail-closed-")));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const rickgentDir = join(root, ".rickgent");
  const agentDir = join(root, "agent");
  mkdirSync(repo, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return { root, repo, dataDir, rickgentDir, agentDir };
}

function cleanupRunWorktrees(repo: string): void {
  if (!existsSync(repo)) return;
  const current = git(repo, ["rev-parse", "--show-toplevel"]);
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length);
    if (worktree !== current) {
      try { git(repo, ["worktree", "remove", "--force", worktree]); } catch { /* test cleanup */ }
    }
  }
}

function writePrd(d: Dirs, paths: string[], verify = "true"): string {
  const tickets = paths.map((path, index) =>
    `### Ticket ${String(index + 1).padStart(2, "0")}: implement ${path}\n` +
    `- **description:** create ${path}\n` +
    `- **dependsOn:** \`[]\`\n` +
    `- **scope:** \`${JSON.stringify([{ path, change_kind: "create", directory: false }])}\`\n` +
    `- **interfaces:** \`[]\`\n` +
    `- **acceptanceCriteria:** \`["AC-1"]\`\n` +
    `- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`\n`,
  ).join("\n");
  const verification = JSON.stringify([{
    id: "VERIFY-LOCAL-01",
    executable: verify,
    args: [],
    cwd_class: "repository_root",
    env_allowlist: ["PATH"],
    timeout_ms: 30000,
    network: "deny",
    writable_outputs: [],
    expected_exit_codes: [0],
  }]);
  const prd = `# Fail Closed Fixture

## Title: Fail Closed Fixture

## Description
Exercise complete run aggregation.

## Acceptance Criteria

### AC-1: local profile gate
- **interfaceIds:** \`[]\`
- **verifications:** \`${verification}\`
- **scope:** \`README.md\`
- **type:** test

## Simplification Review
- Reviewed: yes
- Notes: fixture

## Tickets

${tickets}`;
  const path = join(d.root, `prd-${paths.length}-${Date.now()}.md`);
  writeFileSync(path, prd);
  return path;
}

function runFixture(
  d: Dirs,
  command: "build" | "pipeline",
  prd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): CliResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    RICKGENT_DIR: d.rickgentDir,
    OMNIGENT_DATA_DIR: d.dataDir,
    FIXTURE_MODE: "prompt",
    FIXTURE_TARGET_REPO: d.repo,
    RICKGENT_MODEL_ROSTER: TEST_ROSTER_JSON,
    RICKGENT_COST_BUDGET_USD: "10",
    RICKGENT_ORPHAN_REAP: "off",
    ...extraEnv,
  };
  const result = spawnSync(
    process.execPath,
    [FIXTURE_CLI, command, prd, "--repo", d.repo, "--agent", d.agentDir],
    { cwd: d.repo, env, encoding: "utf-8", input: "", timeout: 90000 },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

describe("fail-closed run aggregation", () => {
  let d: Dirs;

  beforeEach(() => {
    d = setupDirs();
  });

  afterEach(() => {
    cleanupRunWorktrees(d.repo);
    rmSync(d.root, { recursive: true, force: true });
  });

  it("maps the complete typed result at the CLI with documented precedence", () => {
    const outcome = aggregateRunOutcome([
      runIssue({ reason: "partial_failure", class: "execution", detail: "one ticket failed" }),
      runIssue({ reason: "evidence_unverifiable", class: "verification", detail: "receipt missing" }),
      runIssue({ reason: "cleanup_failed", class: "cleanup", detail: "residue unknown" }),
    ]);
    expect(outcome.status).toBe("failed");
    expect(outcome.primary).toBe("cleanup");
    expect(outcome.issues.map((issue) => issue.reason)).toEqual([
      "partial_failure",
      "evidence_unverifiable",
      "cleanup_failed",
    ]);
    expect(exitCodeForRunOutcome(outcome)).toBe(7);
  });

  it("zero-ticket and all-failed subprocess runs exit as execution failures", () => {
    const zero = runFixture(d, "build", writePrd(d, []));
    expect(zero.status).toBe(5);
    expect(zero.stdout).toContain("zero_ticket");

    rmSync(d.rickgentDir, { recursive: true, force: true });
    const allFailed = runFixture(d, "build", writePrd(d, ["src/a.ts"]), {
      FIXTURE_FAIL_PATHS: "src/a.ts",
    });
    expect(allFailed.status).toBe(5);
    expect(allFailed.stdout).toContain("zero_completion");
  });

  it("one capture cannot mask another planned ticket failure", () => {
    const result = runFixture(d, "build", writePrd(d, ["src/a.ts", "src/b.ts"]), {
      FIXTURE_FAIL_PATHS: "src/b.ts",
    });
    expect(result.status).toBe(5);
    expect(result.stdout).toContain("zero_completion");
    expect(result.stdout).toMatch(/planned=2 .*captured=1 done=0 failed=1/);
  });

  it("keeps required local gates unreachable without a verified completion", () => {
    const failed = runFixture(d, "build", writePrd(d, ["src/a.ts"], "false"));
    expect(failed.status).toBe(5);
    expect(failed.stdout).toContain("conformance gate — skipped (no tickets completed)");
    expect(failed.stdout).not.toContain("required_gate_failed");

    rmSync(d.rickgentDir, { recursive: true, force: true });
    const skipped = runFixture(d, "build", writePrd(d, ["src/b.ts"]), {
      RICKGENT_FIXTURE_SKIP_CONFORMANCE: "1",
    });
    expect(skipped.status).toBe(5);
    expect(skipped.stdout).not.toContain("conformance gate");
    expect(skipped.stdout).not.toContain("required_gate_failed");
  });

  it("exit zero without oracle evidence is evidence_unverifiable", () => {
    const result = runFixture(d, "build", writePrd(d, ["src/a.ts"]), {
      FIXTURE_UNVERIFIABLE_PATHS: "src/a.ts",
    });
    expect(result.status).toBe(6);
    expect(result.stdout).toContain("evidence_unverifiable");
    expect(result.stdout).toContain("zero_completion");
  });

  it("pipeline authority fails before cleanup while build infrastructure keeps its distinct exit", () => {
    const failingPs = join(d.root, "failing-ps");
    const psMarker = join(d.root, "ps-invoked");
    mkdirSync(failingPs);
    executable(join(failingPs, "ps"), `#!/bin/sh\n: > "${psMarker}"\nexit 91\n`);
    const cleanup = runFixture(d, "pipeline", writePrd(d, ["src/a.ts"]), {
      PATH: `${failingPs}:${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      RICKGENT_ORPHAN_REAP: "on",
      RICKGENT_SANDBOX: "none",
    });
    expect(cleanup.status).toBe(3);
    expect(cleanup.stderr).toContain("RICKGENT_RECONCILIATION_UNAVAILABLE");
    expect(existsSync(psMarker)).toBe(false);
    expect(existsSync(join(d.rickgentDir, "runs.jsonl"))).toBe(false);

    rmSync(d.rickgentDir, { recursive: true, force: true });
    const failingPython = join(d.root, "failing-python");
    mkdirSync(failingPython);
    executable(join(failingPython, "python3"), "#!/bin/sh\nexit 92\n");
    const infrastructure = runFixture(d, "build", writePrd(d, ["src/b.ts"]), {
      PATH: `${failingPython}:${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    });
    expect(infrastructure.status).toBe(4);
    expect(infrastructure.stdout).toContain("infrastructure_error");
  });

  it("retains all issues while cleanup wins combined failure precedence", () => {
    const outcome = aggregateRunOutcome([
      runIssue({ reason: "ticket_failed", class: "execution", detail: "worker failed", ticketId: "t02" }),
      runIssue({ reason: "zero_completion", class: "execution", detail: "no verified completion" }),
      runIssue({ reason: "cleanup_failed", class: "cleanup", detail: "residue remains" }),
    ]);
    expect(outcome.primary).toBe("cleanup");
    expect(outcome.issues.map((issue) => issue.reason)).toEqual([
      "ticket_failed",
      "zero_completion",
      "cleanup_failed",
    ]);
    expect(exitCodeForRunOutcome(outcome)).toBe(7);
  });

  it("keeps delivery structurally unreachable and never invokes fail-fast push or gh", () => {
    const deliveryBin = join(d.root, "delivery-bin");
    const pushMarker = join(d.root, "push-invoked");
    const ghMarker = join(d.root, "gh-invoked");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    mkdirSync(deliveryBin);
    executable(
      join(deliveryBin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = push ]; then\n    : > "${pushMarker}"\n    exit 94\n  fi\ndone\nexec "${realGit}" "$@"\n`,
    );
    executable(join(deliveryBin, "gh"), `#!/bin/sh\n: > "${ghMarker}"\nexit 95\n`);

    const result = runFixture(d, "build", writePrd(d, ["src/a.ts"]), {
      PATH: `${deliveryBin}:${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    });
    expect(result.status).toBe(5);
    expect(existsSync(pushMarker)).toBe(false);
    expect(existsSync(ghMarker)).toBe(false);

    const source = readFileSync(BUILD_SOURCE, "utf-8");
    expect(source).not.toMatch(/pr-flow|createPullRequest|recordPr|git push|gh pr/);
  });

  it("public unavailable capability fails before state or subprocess side effects", () => {
    const prd = writePrd(d, ["src/a.ts"]);
    const result = spawnSync(
      process.execPath,
      [PRODUCTION_CLI, "build", prd, "--repo", d.repo, "--agent", d.agentDir],
      {
        cwd: d.repo,
        env: { ...process.env, RICKGENT_DIR: d.rickgentDir },
        encoding: "utf-8",
        input: "",
        timeout: 30000,
      },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
    expect(existsSync(d.rickgentDir)).toBe(false);
  });
});
