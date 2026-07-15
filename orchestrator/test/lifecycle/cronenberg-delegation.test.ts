// M0 — cronenberg NON-dry-run delegation fixes.
//
// Two blocking bugs found by scrutiny round 1:
//   1. Pipeline delegation passed raw task text as the positional PRD path.
//      The pipeline requires a PRD *file that exists*. The router must hand a
//      real PRD path (an existing prd.md, or a materialized temp PRD).
//   2. The refine pre-pass stripped option VALUES when forwarding flags
//      (`--repo /x` became just `--repo`). Flag-value pairs must survive.
//
// Unit tests below exercise the pure planner (buildCronenbergPlan) for precise
// argv assertions. CLI tests drive the real built dist/cli.js and observe a
// real effect. A complete strict PRD records a run; a task-only placeholder is
// read but rejected before allocation because Cronenberg cannot safely invent
// ticket identity, scope, verification policy, or budgets from free text.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCronenbergPlan, type CronenbergFlags } from "../../src/lifecycle/cronenberg.js";

const CLI_JS = join(import.meta.dirname, "../fixtures/fixture-cli.mjs");

const DEFAULT_FLAGS: CronenbergFlags = { dryRun: false, noFollowups: false, noRefine: false, refine: false };

const VALID_PRD = `# PRD: Example

## Title: Example

## Description
Do a thing.

## Acceptance Criteria

### AC-1: README remains present
- **interfaceIds:** \`[]\`
- **verifications:** \`[{"id":"VERIFY-README-01","executable":"test","args":["-f","README.md"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]\`
- **scope:** \`README.md\`
- **type:** test

## Simplification Review
- Reviewed: yes
- Notes: one existing file

## Tickets

### Ticket 01: update README
- **description:** Update the README for the requested task
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"README.md","change_kind":"modify","directory":false}]\`
- **interfaces:** \`[]\`
- **acceptanceCriteria:** \`["AC-1"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`
`;

describe("cronenberg non-dry-run delegation — pure planner argv", () => {
  let root: string;
  let workingDir: string;
  let rickgentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cr-deleg-"));
    workingDir = join(root, "repo");
    rickgentDir = join(root, "rickgent");
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(rickgentDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Bug 1 — pipeline with no PRD: the router must materialize a task PRD and
  // pass ITS PATH, never the raw task text.
  it("pipeline (no prd) passes a materialized PRD path, not raw task text", () => {
    const task = "refine and build the export module";
    const plan = buildCronenbergPlan({
      task,
      workingDir,
      rickgentDir,
      forward: ["--repo", workingDir],
      flags: DEFAULT_FLAGS,
      diffLoc: 0,
    });
    expect(plan.ok).toBe(true);
    expect(plan.metaphor).toBe("pipeline");
    // A temp PRD must be scheduled for materialization.
    expect(plan.taskPrd).not.toBeNull();
    expect(plan.taskPrd!.path).toBe(join(rickgentDir, "cronenberg-task.md"));
    expect(plan.taskPrd!.content).toContain(task);
    // The pipeline argv's positional must be the PRD path, not the task text.
    expect(plan.metaphorCommand.argv[0]).toBe("pipeline");
    expect(plan.metaphorCommand.argv[1]).toBe(plan.taskPrd!.path);
    expect(plan.metaphorCommand.argv).not.toContain(task);
  });

  // Bug 1 — pipeline with an existing prd.md: use the real PRD path, no temp.
  it("pipeline (existing prd) uses the real PRD path", () => {
    writeFileSync(join(workingDir, "prd.md"), VALID_PRD);
    const plan = buildCronenbergPlan({
      task: "refine and build the export module",
      workingDir,
      rickgentDir,
      forward: ["--repo", workingDir],
      flags: DEFAULT_FLAGS,
      diffLoc: 0,
    });
    expect(plan.metaphor).toBe("pipeline");
    expect(plan.taskPrd).toBeNull();
    expect(plan.metaphorCommand.argv[0]).toBe("pipeline");
    expect(plan.metaphorCommand.argv[1]).toBe(join(workingDir, "prd.md"));
  });

  // Bug 2 — refine pre-pass must forward flag-VALUE pairs intact.
  it("refine pre-pass preserves flag-value pairs", () => {
    writeFileSync(join(workingDir, "prd.md"), VALID_PRD);
    const plan = buildCronenbergPlan({
      task: "fix a typo",
      workingDir,
      rickgentDir,
      forward: ["--repo", workingDir, "--max-concurrent", "3"],
      flags: { ...DEFAULT_FLAGS, refine: true },
      diffLoc: 0,
    });
    expect(plan.refine.value).toBe(true);
    expect(plan.refinePrePass).not.toBeNull();
    const argv = plan.refinePrePass!.argv;
    // Each flag that takes a value must be followed by that value.
    const repoIdx = argv.indexOf("--repo");
    expect(repoIdx).toBeGreaterThanOrEqual(0);
    expect(argv[repoIdx + 1]).toBe(workingDir);
    const mcIdx = argv.indexOf("--max-concurrent");
    expect(mcIdx).toBeGreaterThanOrEqual(0);
    expect(argv[mcIdx + 1]).toBe("3");
  });

  // Bug 2 sibling — the metaphor (build) command must also keep flag values.
  it("build metaphor forwards flag-value pairs intact", () => {
    writeFileSync(join(workingDir, "prd.md"), VALID_PRD);
    const plan = buildCronenbergPlan({
      task: "add login, add logout, and build a dashboard",
      workingDir,
      rickgentDir,
      forward: ["--max-concurrent", "3"],
      flags: DEFAULT_FLAGS,
      diffLoc: 0,
    });
    expect(plan.metaphor).toBe("build");
    const argv = plan.metaphorCommand.argv;
    const mcIdx = argv.indexOf("--max-concurrent");
    expect(mcIdx).toBeGreaterThanOrEqual(0);
    expect(argv[mcIdx + 1]).toBe("3");
  });
});

// ── CLI end-to-end: a complete delegated PRD records a run. A task-only
//    placeholder is materialized at the planned path but fails strict admission
//    before run allocation instead of receiving inferred executable identity.

interface Ctx {
  root: string;
  repo: string;
  binDir: string;
  rickgentDir: string;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
}

const STUB = `#!/usr/bin/env node
process.stdout.write("worker done\\n");
process.exit(0);
`;

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "cr-deleg-cli-"));
  const repo = join(root, "repo");
  const binDir = join(root, "bin");
  const rickgentDir = join(root, "rickgent");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rickgentDir, { recursive: true });
  const stubPath = join(binDir, "omnigent");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return { root, repo, binDir, rickgentDir };
}

function run(ctx: Ctx, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_JS, "cronenberg", ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      RICKGENT_DIR: ctx.rickgentDir,
      RICKGENT_FIXTURE_SKIP_POLICY_ATTACH: "1",
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("cronenberg non-dry-run delegation — CLI pipeline path", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it("pipeline delegation with an existing prd.md reads the PRD (records a run)", () => {
    writeFileSync(join(ctx.repo, "prd.md"), VALID_PRD);
    const r = run(ctx, ["--task", "refine and build the export module", "--repo", ctx.repo]);
    expect(r.stdout).toContain("metaphor: pipeline");
    // The pipeline could only record a run if it READ a valid PRD path.
    expect(existsSync(join(ctx.rickgentDir, "runs.jsonl"))).toBe(true);
  });

  it("pipeline delegation with no prd materializes a task PRD but does not infer a contract", () => {
    const r = run(ctx, ["--task", "refine and build the export module", "--repo", ctx.repo]);
    expect(r.stdout).toContain("metaphor: pipeline");
    // Router writes the task input, but strict build admission rejects it before
    // allocating a run because free text cannot supply the mandatory contract.
    expect(existsSync(join(ctx.rickgentDir, "cronenberg-task.md"))).toBe(true);
    expect(existsSync(join(ctx.rickgentDir, "runs.jsonl"))).toBe(false);
    expect(r.stdout).toContain("before run allocation");
  });
});
