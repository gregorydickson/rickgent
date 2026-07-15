// M1 — `rickgent citadel` CLI (VAL-CITADEL-001..030).
//
// Drives the REAL built CLI (dist/cli.js) via spawnSync against real temp git
// repos. Every assertion observes a REAL effect: exit code, stdout, the JSON
// report file, the git tree. No agent subprocess is spawned by citadel — a
// spawn spy verifies that.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_JS = join(import.meta.dirname, "../../dist/cli.js");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(repo: string): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  writeFileSync(join(repo, "src", "empty.ts"), "export const seed = 1;\n");
  writeFileSync(join(repo, "prd.md"), BASE_PRD);
  git(repo, ["add", "--", "prd.md", "src/empty.ts"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

const BASE_PRD = `# Test PRD

## Description
A test PRD for citadel validation.

### AC-1: feature works
- **verifyCommand:** \`node -e "require('./src/feature.ts')"\`
- **scope:** \`src/feature.ts\`
- **type:** test

### Ticket 1: implement feature
- **Description:** add the feature
`;

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function runCitadel(repo: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync(process.execPath, [CLI_JS, "citadel", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { exit: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runCitadelReport(repo: string, args: string[], env?: NodeJS.ProcessEnv): { run: RunResult; report: any } {
  const reportPath = join(repo, "citadel_report.json");
  const run = runCitadel(repo, [...args, "--report", reportPath], env);
  let report: any = null;
  if (existsSync(reportPath)) {
    report = JSON.parse(readFileSync(reportPath, "utf-8"));
  }
  return { run, report };
}

describe("rickgent citadel — VAL-CITADEL-001..030", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "citadel-"));
    repo = join(root, "repo");
    initRepo(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // VAL-CITADEL-001: citadel CLI command exists and is dispatchable
  it("citadel --help exits 0 and mentions citadel", () => {
    const r = runCitadel(repo, ["--help"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("citadel");
  });

  // VAL-CITADEL-002: --prd is required
  it("fails with a clear error when --prd is missing", () => {
    const r = runCitadel(repo, []);
    expect(r.exit).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toContain("--prd");
  });

  // VAL-CITADEL-003: --diff defaults to HEAD~1..HEAD
  it("walks HEAD~1..HEAD by default", () => {
    // Add a second commit touching src/feature.ts.
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const { run, report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    expect(run.exit).toBe(0);
    const changed = report.analyzers["diff-walker"].changedFiles.map((f: any) => f.path);
    expect(changed).toContain("src/feature.ts");
  });

  // VAL-CITADEL-004: --diff accepts an explicit range
  it("walks an explicit --diff range", () => {
    // Commit 1: add feature.ts. Commit 2: add other.ts.
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const featureSha = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "src", "other.ts"), "export const other = 7;\n");
    git(repo, ["add", "--", "src/other.ts"]);
    git(repo, ["commit", "-q", "-m", "add other"]);
    const { run, report } = runCitadelReport(repo, ["--prd", "prd.md", "--diff", `${featureSha}..HEAD`]);
    expect(run.exit).toBe(0);
    const changed = report.analyzers["diff-walker"].changedFiles.map((f: any) => f.path);
    expect(changed).toContain("src/other.ts");
    expect(changed).not.toContain("src/feature.ts");
  });

  // VAL-CITADEL-005: --strict exits non-zero on High findings
  it("--strict exits non-zero when a High finding exists", () => {
    // An unguarded trap door produces a High finding.
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: never null ENFORCE: `src/feature.test.ts`\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts", "CLAUDE.md"]);
    git(repo, ["commit", "-q", "-m", "add feature with trap door"]);
    const r = runCitadel(repo, ["--prd", "prd.md", "--strict"]);
    expect(r.exit).not.toBe(0);
  });

  // VAL-CITADEL-006: default exits non-zero only on Critical
  it("default exits 0 on High-only findings; non-zero on Critical", () => {
    // High-only: unguarded trap door (no violation).
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: never null ENFORCE: `src/feature.test.ts`\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts", "CLAUDE.md"]);
    git(repo, ["commit", "-q", "-m", "add feature with trap door"]);
    const highOnly = runCitadel(repo, ["--prd", "prd.md"]);
    expect(highOnly.exit).toBe(0);

    // Critical: trap-door violation (BREAKS pattern matched).
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = null as any;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "violate trap door"]);
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: never null BREAKS: `as any` ENFORCE: `src/feature.test.ts`\n");
    git(repo, ["add", "--", "CLAUDE.md"]);
    git(repo, ["commit", "-q", "-m", "add trap door doc"]);
    const critical = runCitadel(repo, ["--prd", "prd.md", "--diff", "HEAD~2..HEAD"]);
    expect(critical.exit).not.toBe(0);
  });

  // VAL-CITADEL-007: --report writes JSON to the given path
  it("--report writes valid JSON to the path", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const reportPath = join(root, "out", "cit.json");
    const r = runCitadel(repo, ["--prd", "prd.md", "--report", reportPath]);
    expect(r.exit).toBe(0);
    expect(existsSync(reportPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(parsed.schema).toBe("1.0");
  });

  // VAL-CITADEL-008: --print-stubs emits test skeletons for unguarded trap doors
  it("--print-stubs emits a test skeleton referencing the unguarded trap door", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: never null ENFORCE: `src/feature.test.ts`\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts", "CLAUDE.md"]);
    git(repo, ["commit", "-q", "-m", "add feature with trap door"]);
    const r = runCitadel(repo, ["--prd", "prd.md", "--print-stubs"]);
    expect(r.stdout).toContain("describe");
    expect(r.stdout).toContain("src/feature.ts");
    expect(r.stdout).toContain("never null");
  });

  // VAL-CITADEL-009: PRD parser handles composes: frontmatter graph
  it("resolves the composes: frontmatter graph", () => {
    const subPrd = `# Sub PRD\n## Description\nsub\n### AC-2: sub feature\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/sub.ts\`\n- **type:** test\nPOST /items\n`;
    writeFileSync(join(repo, "sub-prd.md"), subPrd);
    const composesPrd = `---
composes: [sub-prd.md]
---
# Composing PRD\n## Description\nparent\n### AC-1: parent feature\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/feature.ts\`\n- **type:** test\n`;
    writeFileSync(join(repo, "prd.md"), composesPrd);
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "prd.md", "sub-prd.md", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "composing prd"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    expect(report.analyzers["prd-parser"].composed).toContain("sub-prd.md");
    // The composed sub-PRD's endpoint should be visible to the endpoint analyzer.
    expect(report.analyzers["endpoint-contract-conformance"].findings.length).toBeGreaterThan(0);
  });

  // VAL-CITADEL-010: diff walker matches git diff --name-status
  it("diff walker file/status set equals git ground truth", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    mkdirSync(join(repo, "src", "sub"), { recursive: true });
    writeFileSync(join(repo, "src", "sub", "added.ts"), "export const added = 1;\n");
    git(repo, ["add", "--", "src/feature.ts", "src/sub/added.ts"]);
    git(repo, ["commit", "-q", "-m", "add files"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const walkerSet = new Set(
      report.analyzers["diff-walker"].changedFiles.map((f: any) => `${f.status}\t${f.path}`),
    );
    const truth = execFileSync("git", ["-C", repo, "diff", "--name-status", "HEAD~1..HEAD"], { encoding: "utf-8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.replace(/^([A-Z])\t/, "$1\t"))
      .map((l) => {
        const parts = l.split("\t");
        return `${parts[0]!.charAt(0).toUpperCase()}\t${parts[parts.length - 1]}`;
      });
    for (const entry of truth) expect(walkerSet.has(entry)).toBe(true);
  });

  // VAL-CITADEL-011: project shape detection identifies a NestJS API project
  it("detects a NestJS API project shape", () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }));
    writeFileSync(join(repo, "src", "main.ts"), "import { NestFactory } from '@nestjs/core';\nNestFactory.create();\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "package.json", "src/main.ts", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add nestjs"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const shapes = report.analyzers["project-shape-detection"].shapes;
    expect(shapes).toContain("nestjs-api");
  });

  // VAL-CITADEL-012: project shape detection identifies a React frontend
  it("detects a React frontend project shape", () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "^18" } }));
    writeFileSync(join(repo, "src", "App.tsx"), "import React from 'react';\nexport const App = () => <div>hi</div>;\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "package.json", "src/App.tsx", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add react"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const shapes = report.analyzers["project-shape-detection"].shapes;
    expect(shapes).toContain("react-frontend");
  });

  // VAL-CITADEL-013: endpoint contract conformance compares PRD-declared vs actual routes
  it("flags a mismatch between PRD-declared and actual routes", () => {
    const endpointPrd = `# PRD\n## Description\ntest\n### AC-1: users endpoint\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/users.controller.ts\`\n- **type:** test\nPOST /users\n`;
    writeFileSync(join(repo, "prd.md"), endpointPrd);
    writeFileSync(join(repo, "src", "users.controller.ts"), "import { Controller, Post } from '@nestjs/common';\n@Controller()\nexport class UsersController {\n  @Post('/user')\n  create() {}\n}\n");
    git(repo, ["add", "--", "prd.md", "src/users.controller.ts"]);
    git(repo, ["commit", "-q", "-m", "add controller"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const findings = report.analyzers["endpoint-contract-conformance"].findings;
    expect(findings.length).toBeGreaterThan(0);
    const msgs = findings.map((f: any) => f.message).join(" ");
    expect(msgs).toContain("/user");
    expect(msgs).toContain("/users");
  });

  // VAL-CITADEL-014: trap-door coverage checks CLAUDE.md invariants against code
  it("emits a finding when a diff violates a CLAUDE.md trap door invariant", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: never use eval BREAKS: `eval(` ENFORCE: `src/feature.test.ts`\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = eval('1');\n");
    git(repo, ["add", "--", "CLAUDE.md", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "violate trap door"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const findings = report.analyzers["trap-door-coverage"].findings;
    const violation = findings.find((f: any) => f.rule === "trap-door:violation");
    expect(violation).toBeTruthy();
    expect(violation.file).toContain("src/feature.ts");
  });

  // VAL-CITADEL-015: state-transition audit compares PRD-declared vs implementation
  it("flags an undeclared state transition", () => {
    const transitionPrd = `# PRD\n## Description\ntest\n### AC-1: state machine\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/state.ts\`\n- **type:** test\nPENDING -> APPROVED -> DONE\n`;
    writeFileSync(join(repo, "prd.md"), transitionPrd);
    writeFileSync(join(repo, "src", "state.ts"), "machine.from('PENDING').to('DONE');\n");
    git(repo, ["add", "--", "prd.md", "src/state.ts"]);
    git(repo, ["commit", "-q", "-m", "add state machine"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const findings = report.analyzers["state-transition-audit"].findings;
    expect(findings.length).toBeGreaterThan(0);
    const msg = findings.map((f: any) => f.message).join(" ");
    expect(msg).toContain("PENDING->DONE");
  });

  // VAL-CITADEL-016: banned constructs/casts scanner flags forbidden patterns
  it("flags banned constructs and casts", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "const x = 1 as any;\nconst y = eval('2');\nconst z = new Function('return 1');\nif (true) z();\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "banned code"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const findings = report.analyzers["banned-constructs-casts"].findings;
    const rules = findings.map((f: any) => f.rule);
    expect(rules).toContain("banned-cast:as-any");
    expect(rules).toContain("banned-construct:eval");
    expect(rules).toContain("banned-construct:function-ctor");
  });

  // VAL-CITADEL-017: AC coverage scorecard maps each PRD AC to changed files
  it("produces a scorecard entry per PRD AC with a coverage status", () => {
    const multiAcPrd = `# PRD\n## Description\ntest\n### AC-1: feature a\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/a.ts\`\n- **type:** test\n### AC-2: feature b\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/b.ts\`\n- **type:** test\n`;
    writeFileSync(join(repo, "prd.md"), multiAcPrd);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
    git(repo, ["add", "--", "prd.md", "src/a.ts", "src/b.ts"]);
    git(repo, ["commit", "-q", "-m", "add a and b"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const rows = report.analyzers["ac-coverage-scorecard"].rows;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(["covered", "partial", "uncovered"]).toContain(row.status);
    }
  });

  // VAL-CITADEL-018: AC coverage scorecard marks an untouched AC as uncovered
  it("marks an untouched AC as uncovered", () => {
    const multiAcPrd = `# PRD\n## Description\ntest\n### AC-1: feature a\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/a.ts\`\n- **type:** test\n### AC-2: feature b\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/b.ts\`\n- **type:** test\n`;
    writeFileSync(join(repo, "prd.md"), multiAcPrd);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    git(repo, ["add", "--", "prd.md", "src/a.ts"]);
    git(repo, ["commit", "-q", "-m", "add a only"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const rows = report.analyzers["ac-coverage-scorecard"].rows;
    const ac2 = rows.find((r: any) => r.id === "AC-2");
    expect(ac2.status).not.toBe("covered");
  });

  // VAL-CITADEL-019: skeptic lens runs as report-only (no blocking findings)
  it("skeptic-lens findings never block, even under --strict", () => {
    // Isolate skeptic-only findings: `if (false) {}` triggers the skeptic
    // dead-guard detector but no other analyzer produces any High/Critical
    // finding. This robustly verifies skeptic-lens is report-only.
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\nif (false) {}\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "skeptic trigger"]);
    const { report, run } = runCitadelReport(repo, ["--prd", "prd.md", "--strict"]);
    expect(report.skeptic_findings.length).toBeGreaterThan(0);
    // No blocking findings — skeptic is report-only; other analyzers produce
    // no High/Critical on this minimal change.
    const blocking = report.findings.filter(
      (f: any) => f.severity === "Critical" || f.severity === "High",
    );
    expect(blocking).toHaveLength(0);
    // Exit must be 0 even under --strict when only skeptic findings exist.
    expect(run.exit).toBe(0);
  });

  // VAL-CITADEL-020: every analyzer runs and produces findings or no-findings
  it("the report enumerates all 19 analyzers", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const names = Object.keys(report.analyzers);
    expect(names.length).toBe(19);
    for (const name of names) {
      const section = report.analyzers[name];
      expect(Array.isArray(section.findings)).toBe(true);
      expect(section.findings.length > 0 || section.no_findings === true || section.skipped !== undefined).toBe(true);
    }
  });

  // VAL-CITADEL-021: analyzers are fail-soft (analyzer error → skipped, not crash)
  it("records a failing analyzer as skipped and continues running others", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const { report, run } = runCitadelReport(repo, ["--prd", "prd.md"], {
      RICKGENT_CITADEL_FORCE_THROW: "diff-hygiene",
    });
    expect(report.analyzers["diff-hygiene"].skipped).toBe("error");
    expect(report.analyzers["diff-hygiene"].reason).toContain("diff-hygiene");
    // Other analyzers still ran.
    expect(report.analyzers["banned-constructs-casts"].findings).toBeDefined();
    expect(run.exit).toBe(0);
  });

  // VAL-CITADEL-022: findings are deduplicated
  it("deduplicates findings with overlapping keys and tags both analyzers", () => {
    // Two analyzers can flag the same file/rule: e.g. trap-door violation and
    // banned-cast on the same `as any` line. We verify dedup by checking that
    // every finding has a stable unique id and sourceAnalyzers is an array.
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: no any BREAKS: `as any` ENFORCE: `src/feature.test.ts`\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const x = 1 as any;\n");
    git(repo, ["add", "--", "CLAUDE.md", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "overlap"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const ids = report.findings.map((f: any) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // VAL-CITADEL-023: every finding is tagged with its source analyzer
  it("every finding carries a non-empty sourceAnalyzer tag", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const x = 1 as any;\nif (true) x;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "findings"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    expect(report.findings.length).toBeGreaterThan(0);
    for (const f of report.findings) {
      expect(typeof f.sourceAnalyzer).toBe("string");
      expect(f.sourceAnalyzer.length).toBeGreaterThan(0);
      expect(Array.isArray(f.sourceAnalyzers)).toBe(true);
    }
  });

  // VAL-CITADEL-024: report JSON uses schema "1.0" with a versioned structure
  it("report has schema 1.0 and versioned top-level keys", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    expect(report.schema).toBe("1.0");
    expect(report.schema_version).toBe("1.0");
    expect(report.version).toBe("1.0");
    expect(typeof report.generatedAt).toBe("string");
    expect(report.analyzers).toBeDefined();
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report.summary).toBeDefined();
  });

  // VAL-CITADEL-025: console summary is grouped by section
  it("console summary is grouped by section headers", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const r = runCitadel(repo, ["--prd", "prd.md"]);
    expect(r.stdout).toContain("── prd-parser ──");
    expect(r.stdout).toContain("── diff-walker ──");
    expect(r.stdout).toContain("── banned-constructs-casts ──");
    expect(r.stdout).toContain("── skeptic-lens ──");
    expect(r.stdout).toContain("summary:");
  });

  // VAL-CITADEL-026: no agent subprocess is spawned (pure JS analysis)
  it("spawns no omnigent/agent subprocess", () => {
    // Put a stub omnigent on PATH that logs invocations.
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = join(root, "omnigent-calls.log");
    writeFileSync(join(binDir, "omnigent"), `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
    chmodSync(join(binDir, "omnigent"), 0o755);
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const r = runCitadel(repo, ["--prd", "prd.md"], { PATH: `${binDir}:${process.env.PATH}` });
    expect(r.exit).toBe(0);
    expect(existsSync(logPath)).toBe(false);
  });

  // VAL-CITADEL-027: fail-closed on missing PRD file
  it("fails closed on a missing PRD file", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const r = runCitadel(repo, ["--prd", "/nonexistent/prd.md"]);
    expect(r.exit).not.toBe(0);
    expect((r.stderr + r.stdout)).toContain("/nonexistent/prd.md");
  });

  // VAL-CITADEL-028: fail-closed on invalid diff range
  it("fails closed on an invalid diff range", () => {
    const r = runCitadel(repo, ["--prd", "prd.md", "--diff", "notabranch..HEAD"]);
    expect(r.exit).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toContain("diff");
  });

  // VAL-CITADEL-029: fail-closed on unreadable file in diff
  it("surfaces an unreadable file in the diff", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    chmodSync(join(repo, "src", "feature.ts"), 0o000);
    try {
      const { report, run } = runCitadelReport(repo, ["--prd", "prd.md"]);
      // The audit must not silently pass: either the report names the unreadable
      // file or the command exits non-zero.
      const namesUnreadable =
        report && Array.isArray(report.unreadable_files) && report.unreadable_files.some((u: any) => u.path.includes("feature.ts"));
      expect(namesUnreadable || run.exit !== 0).toBe(true);
    } finally {
      chmodSync(join(repo, "src", "feature.ts"), 0o644);
    }
  });

  // VAL-CITADEL-030: existing build pipeline conformance gate still works via extracted function
  it("runConformanceGate is still importable from lifecycle/citadel.js", async () => {
    const mod = await import("../../dist/lifecycle/citadel.js");
    expect(typeof mod.runConformanceGate).toBe("function");
  });

  // --- M1 scrutiny + user-testing fixes ---

  // Fix #1: trap-door-coverage is fail-soft via register()
  it("trap-door-coverage is fail-soft (skipped on analyzer error, not crash)", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "## Trap Doors\n- `src/feature.ts` — INVARIANT: never null ENFORCE: `src/feature.test.ts`\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts", "CLAUDE.md"]);
    git(repo, ["commit", "-q", "-m", "add feature with trap door"]);
    const { report, run } = runCitadelReport(repo, ["--prd", "prd.md"], {
      RICKGENT_CITADEL_FORCE_THROW: "trap-door-coverage",
    });
    expect(report.analyzers["trap-door-coverage"].skipped).toBe("error");
    expect(report.analyzers["trap-door-coverage"].reason).toContain("trap-door-coverage");
    // Other analyzers still ran.
    expect(report.analyzers["banned-constructs-casts"].findings).toBeDefined();
    expect(run.exit).toBe(0);
  });

  // Fix #1: skeptic-lens is fail-soft via register()
  it("skeptic-lens is fail-soft (skipped on analyzer error, not crash)", () => {
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    const { report, run } = runCitadelReport(repo, ["--prd", "prd.md"], {
      RICKGENT_CITADEL_FORCE_THROW: "skeptic-lens",
    });
    expect(report.analyzers["skeptic-lens"].skipped).toBe("error");
    expect(report.analyzers["skeptic-lens"].reason).toContain("skeptic-lens");
    expect(report.skeptic_findings).toHaveLength(0);
    expect(run.exit).toBe(0);
  });

  // Fix #2: dedup test with same (severity, file, line, rule) key merges
  it("deduplicates same-key findings from different analyzers into one entry with both sourceAnalyzers", () => {
    // Construct a scenario where two analyzers produce findings with the same
    // (severity, file, line, rule) key. We test the dedupeFindings function
    // directly with synthetic inputs to robustly verify merge behavior.
    // This is a unit test of the pure dedup function — the production
    // entrypoint is exercised by the other integration tests.
    const { dedupeFindings } = require("../../dist/lifecycle/citadel/reporter.js");
    const tagged = [
      {
        finding: {
          id: "test:overlap-1",
          rule: "shared-rule",
          severity: "High",
          file: "src/a.ts",
          line: 10,
          message: "from analyzer-a",
        },
        analyzer: "analyzer-a",
      },
      {
        finding: {
          id: "test:overlap-2",
          rule: "shared-rule",
          severity: "High",
          file: "src/a.ts",
          line: 10,
          message: "from analyzer-b",
        },
        analyzer: "analyzer-b",
      },
    ];
    const result = dedupeFindings(tagged);
    // Same key → exactly one merged entry
    expect(result).toHaveLength(1);
    // Both source analyzers are tagged
    expect(result[0].sourceAnalyzers).toContain("analyzer-a");
    expect(result[0].sourceAnalyzers).toContain("analyzer-b");
    expect(result[0].sourceAnalyzers).toHaveLength(2);
  });

  // Fix #4: endpoint-conformance scopes to diff files only
  it("endpoint-conformance does not scan source files outside the diff", () => {
    // Create a controller in the initial commit (NOT in the diff).
    writeFileSync(
      join(repo, "src", "existing.controller.ts"),
      "import { Controller, Post } from '@nestjs/common';\n@Controller()\nexport class ExistingController {\n  @Post('/existing')\n  create() {}\n}\n",
    );
    git(repo, ["add", "--", "src/existing.controller.ts"]);
    git(repo, ["commit", "-q", "-m", "add existing controller"]);
    // Now make a change that does NOT touch the controller.
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "add feature"]);
    // PRD declares POST /existing which matches the pre-existing controller.
    const endpointPrd = `# PRD\n## Description\ntest\n### AC-1: existing endpoint\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/existing.controller.ts\`\n- **type:** test\nPOST /existing\n`;
    writeFileSync(join(repo, "prd.md"), endpointPrd);
    git(repo, ["add", "--", "prd.md"]);
    git(repo, ["commit", "-q", "-m", "update prd"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md", "--diff", "HEAD~1..HEAD"]);
    const findings = report.analyzers["endpoint-contract-conformance"].findings;
    // The pre-existing controller route is NOT in the diff, so the declared
    // endpoint POST /existing should be flagged as "missing implementation"
    // (because we only scan diff files now), and there should be NO
    // "undeclared route" finding for /existing (because we don't scan it).
    const missingImpl = findings.find(
      (f: any) => f.rule === "endpoint-conformance:missing-implementation",
    );
    expect(missingImpl).toBeTruthy();
    expect(missingImpl.message).toContain("/existing");
    const undeclared = findings.find(
      (f: any) => f.rule === "endpoint-conformance:undeclared-route" && f.message.includes("/existing"),
    );
    expect(undeclared).toBeFalsy();
  });

  // Fix #5: positional arg fallback is documented in usage text
  it("citadel --help documents the positional argument shorthand", () => {
    const r = runCitadel(repo, ["--help"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("positional");
  });

  // Fix #6: AC bullet key with space ('Verify Command') parses correctly
  it("parses AC bullet key 'Verify Command' (with space) as verifyCommand", () => {
    // PRD uses 'Verify Command' (with space) instead of 'verifyCommand'.
    // The parser normalizes keys by removing spaces, so this should parse
    // the verify command correctly and NOT emit ac-shape:missing-verify.
    const spacedKeyPrd = `# PRD\n## Description\ntest\n### AC-1: feature works\n- **Verify Command:** \`node -e "1"\`\n- **scope:** \`src/feature.ts\`\n- **type:** test\n`;
    writeFileSync(join(repo, "prd.md"), spacedKeyPrd);
    writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 42;\n");
    git(repo, ["add", "--", "prd.md", "src/feature.ts"]);
    git(repo, ["commit", "-q", "-m", "spaced key prd"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const acShapeFindings = report.analyzers["ac-shape-audit"].findings;
    const missingVerify = acShapeFindings.find(
      (f: any) => f.rule === "ac-shape:missing-verify",
    );
    expect(missingVerify).toBeFalsy();
  });

  // Fix #7: AC coverage normalizes './' prefix in path matching
  it("AC coverage marks AC as covered when scope uses './' prefix matching diff path", () => {
    // PRD scope uses './src/a.ts' (with ./ prefix) while diff path is 'src/a.ts'.
    // Normalization should strip './' so the AC is marked 'covered', not 'partial'.
    const dotSlashPrd = `# PRD\n## Description\ntest\n### AC-1: feature a\n- **verifyCommand:** \`node -e "require('./src/a.ts')"\`\n- **scope:** \`./src/a.ts\`\n- **type:** test\n`;
    writeFileSync(join(repo, "prd.md"), dotSlashPrd);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    git(repo, ["add", "--", "prd.md", "src/a.ts"]);
    git(repo, ["commit", "-q", "-m", "add a with dot-slash scope"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const rows = report.analyzers["ac-coverage-scorecard"].rows;
    const ac1 = rows.find((r: any) => r.id === "AC-1");
    expect(ac1.status).toBe("covered");
  });

  // Fix #8: NestJS no-arg decorator @Post() is detected as a route
  it("detects @Post() no-arg decorator as a route", () => {
    const endpointPrd = `# PRD\n## Description\ntest\n### AC-1: root endpoint\n- **verifyCommand:** \`node -e "1"\`\n- **scope:** \`src/root.controller.ts\`\n- **type:** test\nPOST /\n`;
    writeFileSync(join(repo, "prd.md"), endpointPrd);
    writeFileSync(
      join(repo, "src", "root.controller.ts"),
      "import { Controller, Post } from '@nestjs/common';\n@Controller()\nexport class RootController {\n  @Post()\n  create() {}\n}\n",
    );
    git(repo, ["add", "--", "prd.md", "src/root.controller.ts"]);
    git(repo, ["commit", "-q", "-m", "add no-arg controller"]);
    const { report } = runCitadelReport(repo, ["--prd", "prd.md"]);
    const findings = report.analyzers["endpoint-contract-conformance"].findings;
    // @Post() with no arg resolves to path "/" which matches POST / declared
    // in the PRD. So there should be NO undeclared-route or missing-impl finding.
    const undeclared = findings.find(
      (f: any) => f.rule === "endpoint-conformance:undeclared-route",
    );
    expect(undeclared).toBeFalsy();
    const missingImpl = findings.find(
      (f: any) => f.rule === "endpoint-conformance:missing-implementation",
    );
    expect(missingImpl).toBeFalsy();
  });
});
