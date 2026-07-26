/**
 * Quality Gates Summary (VAL-REL-002)
 *
 * Runs all quality gates (typecheck, build, coverage, lint, mutation, package
 * inventory) and produces a summary JSON at artifacts/reliability/quality-gates-summary.json.
 *
 * Infrastructure failures are NOT reported as successful quality results.
 * A gate that cannot run (missing tool, timeout, spawn error) is recorded as
 * an infrastructure_error, not a pass. The summary's `thresholds_passed` field
 * is false if any infrastructure_error or skipped_required entry exists.
 *
 * CLI:
 *   node quality-gates-summary.mjs run [--output <path>]   — run all gates
 *   node quality-gates-summary.mjs check <summary.json>     — verify a summary
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ORCH_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(ORCH_DIR, "..");
const POLICIES_DIR = join(REPO_ROOT, "rickgent-policies");
const ARTIFACTS_DIR = join(REPO_ROOT, "artifacts", "reliability");
const GIT_OID = /^[0-9a-f]{40}$/;
const POST_QUALITY_EVIDENCE_PATHS = new Set([
  "artifacts/reliability/citadel-release-report.json",
  "artifacts/reliability/closure-preservation-evidence.json",
  "artifacts/reliability/mission-3-completion-summary.json",
  "artifacts/reliability/quality-gates-summary.json",
  "docs/remediation/phase-9-t39-release-closure-execution-report.md",
  "docs/remediation/trust-spine-manifest.json",
]);

// CI-bound scripts must not hardcode machine-specific PATH prefixes (AGENTS.md
// convention 20). Use process.env.PATH as-is so the script works in both local
// and CI environments.
const PATH_ENV = () => ({
  ...process.env,
});

/**
 * Evaluate a summary object and determine if it passes all quality gates.
 * Infrastructure failures and skipped required gates make the summary fail.
 */
export function evaluateSummary(summary) {
  const errors = [];
  if (!GIT_OID.test(summary.tested_commit ?? "")) {
    errors.push("tested_commit is not a full Git commit OID");
  }
  if (!summary.thresholds_passed) {
    errors.push("thresholds_passed is false");
  }
  if (summary.skipped_required && summary.skipped_required.length > 0) {
    errors.push(`skipped required gates: ${summary.skipped_required.join(", ")}`);
  }
  if (summary.infrastructure_errors && summary.infrastructure_errors.length > 0) {
    errors.push(`infrastructure errors: ${summary.infrastructure_errors.map((e) => e.gate || e.name || "unknown").join(", ")}`);
  }
  return {
    passed: errors.length === 0,
    errors,
  };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function verifyTestedCommit(testedCommit) {
  try {
    git(["cat-file", "-e", `${testedCommit}^{commit}`]);
    execFileSync("git", ["merge-base", "--is-ancestor", testedCommit, "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
  } catch {
    return ["tested_commit is not an ancestor of the reviewed HEAD"];
  }
  const changedPaths = git(["diff", "--name-only", `${testedCommit}..HEAD`])
    .split("\n")
    .filter(Boolean);
  const disallowed = changedPaths.filter((path) => !POST_QUALITY_EVIDENCE_PATHS.has(path));
  return disallowed.length === 0
    ? []
    : [`code or test paths changed after tested_commit: ${disallowed.join(", ")}`];
}

/**
 * Run a single gate and classify the result.
 * Returns { name, status, detail, exitCode }
 * status is one of: "pass", "fail", "infrastructure_error"
 *
 * Infrastructure errors (spawn errors, missing binaries, timeouts) are
 * distinguished from threshold failures. An infrastructure error is NEVER
 * reported as a pass.
 */
function runGate(name, command, args, options = {}) {
  const { cwd = ORCH_DIR, timeout = 120_000, env } = options;
  return new Promise((resolveGate) => {
    const outputLimit = 64 * 1024 * 1024;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let spawnError = null;
    let timedOut = false;
    let outputOverflow = false;
    let killTimer;
    const child = spawn(command, args, {
      cwd,
      env: env ?? PATH_ENV(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const signalTree = (signal) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") spawnError ??= error;
      }
    };
    const terminateTree = () => {
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const capture = (bucket) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        if (!outputOverflow) {
          outputOverflow = true;
          terminateTree();
        }
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", (error) => { spawnError = error; });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, timeout);
    timeoutTimer.unref();

    child.on("close", (status, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (spawnError || timedOut || outputOverflow || signal || status === null) {
        const detail = spawnError?.message
          ?? (timedOut ? `timed out after ${timeout}ms` : undefined)
          ?? (outputOverflow ? `output exceeded ${outputLimit} bytes` : undefined)
          ?? (signal ? `signal: ${signal}` : "no exit status");
        resolveGate({
        name,
        status: "infrastructure_error",
        detail,
        exitCode: null,
        });
        return;
      }
      const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`.trim();
      const outputLines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      const failureLines = outputLines.filter((line) => /^(FAIL|Error:|AssertionError:|Test Files|Tests\s)/.test(line));
      const detail = (failureLines.length > 0 ? failureLines : outputLines).slice(-8).join(" | ");
      resolveGate({
        name,
        status: status === 0 ? "pass" : "fail",
        detail: status === 0 ? "exit 0" : (detail || `exit ${status}`),
        exitCode: status,
      });
    });
  });
}

/**
 * Run all quality gates and produce a summary.
 */
export async function runAllGates(outputPath) {
  const testedCommit = git(["rev-parse", "HEAD"]);
  if (!GIT_OID.test(testedCommit)) {
    throw new Error("quality gates could not bind the tested Git commit");
  }
  const gates = [];
  const infrastructureErrors = [];
  const skippedRequired = [];

  // 1. TypeScript lint. This is deliberately distinct from compilation:
  // release authority must prove both static style/bug rules and type safety.
  const tsLint = await runGate("ts_lint", "pnpm", ["exec", "eslint", "src", "--max-warnings=0"], {
    cwd: ORCH_DIR,
    timeout: 120_000,
  });
  gates.push(tsLint);
  if (tsLint.status === "infrastructure_error") { infrastructureErrors.push({ gate: "ts_lint", error: tsLint.detail }); }

  // 2. TypeScript typecheck
  const typecheck = await runGate("typecheck", "npx", ["tsc", "--noEmit"], { cwd: ORCH_DIR, timeout: 60_000 });
  gates.push(typecheck);
  if (typecheck.status === "infrastructure_error") { infrastructureErrors.push({ gate: "typecheck", error: typecheck.detail }); }

  // 3. TypeScript build
  const retainedBuildCommit = readFileSync(
    join(ORCH_DIR, "src", "build-commit.ts"),
    "utf8",
  ).match(/BUILD_COMMIT = "([0-9a-f]{40})"/)?.[1];
  const build = await runGate("build", "node", ["scripts/generate-build-commit.cjs"], {
    cwd: ORCH_DIR,
    timeout: 30_000,
    env: {
      ...PATH_ENV(),
      ...(retainedBuildCommit === undefined
        ? {}
        : { RICKGENT_BUILD_COMMIT: retainedBuildCommit }),
    },
  });
  build.name = "build";
  gates.push(build);
  if (build.status === "infrastructure_error") { infrastructureErrors.push({ gate: "build", error: build.detail }); }

  // 4. Full TypeScript regression with coverage. The mutation driver is run
  // immediately afterward in isolation because it launches many nested test
  // processes that otherwise starve unrelated file workers.
  const tsTest = await runGate(
    "ts_test_coverage",
    "npx",
    [
      "vitest",
      "run",
      "--maxWorkers=2",
      "--exclude",
      "test/lifecycle/manifest.test.ts",
      "--coverage",
    ],
    { cwd: ORCH_DIR, timeout: 1_200_000 },
  );
  gates.push(tsTest);
  if (tsTest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "ts_test_coverage", error: tsTest.detail }); }

  // 5. Complete mutation corpus, isolated from ordinary file workers but
  // still required. This is not a skip: the exact excluded file runs here.
  const mutationManifest = await runGate(
    "mutation_manifest",
    "npx",
    ["vitest", "run", "test/lifecycle/manifest.test.ts", "--maxWorkers=1"],
    { cwd: ORCH_DIR, timeout: 1_800_000 },
  );
  gates.push(mutationManifest);
  if (mutationManifest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "mutation_manifest", error: mutationManifest.detail }); }

  // 6. Python lint (ruff)
  const ruff = await runGate("ruff_lint", "ruff", ["check", "."], { cwd: POLICIES_DIR, timeout: 30_000 });
  gates.push(ruff);
  if (ruff.status === "infrastructure_error") { infrastructureErrors.push({ gate: "ruff_lint", error: ruff.detail }); }

  // 6. Python typecheck (mypy)
  const mypy = await runGate("mypy_typecheck", "mypy", ["rickgent_policies"], { cwd: POLICIES_DIR, timeout: 60_000 });
  gates.push(mypy);
  if (mypy.status === "infrastructure_error") { infrastructureErrors.push({ gate: "mypy_typecheck", error: mypy.detail }); }

  // 7. Python test with coverage
  const pythonCli = join(ORCH_DIR, "dist", "cli.js");
  const generatedBuildCommit = readFileSync(
    join(ORCH_DIR, "src", "build-commit.ts"),
    "utf8",
  ).match(/BUILD_COMMIT = "([0-9a-f]{40})"/)?.[1];
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const pyTest = await runGate(
    "py_test_coverage",
    "python3",
    ["-m", "pytest", "test/", "-p", "no:cacheprovider", "-q", "--cov=rickgent_policies", "--cov-fail-under=90"],
    {
      cwd: POLICIES_DIR,
      timeout: 120_000,
      env: {
        ...PATH_ENV(),
        RICKGENT_CLI_REALPATH: pythonCli,
        RICKGENT_CLI_SHA256: digest(pythonCli),
        RICKGENT_NODE_REALPATH: process.execPath,
        RICKGENT_NODE_SHA256: digest(process.execPath),
        ...(generatedBuildCommit === undefined
          ? {}
          : { RICKGENT_BUILD_COMMIT: generatedBuildCommit }),
      },
    },
  );
  gates.push(pyTest);
  if (pyTest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "py_test_coverage", error: pyTest.detail }); }

  // 7. Coverage manifest verify (temp-worktrees-only)
  const manifest = await runGate(
    "coverage_manifest_verify",
    "node",
    [join(ORCH_DIR, "scripts/coverage-manifest.cjs"), "--verify", "--temp-worktrees-only"],
    { cwd: ORCH_DIR, timeout: 30_000 },
  );
  gates.push(manifest);
  if (manifest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "coverage_manifest_verify", error: manifest.detail }); }

  // 8. Release manifest validation
  const releaseManifest = await runGate(
    "release_manifest",
    "node",
    [join(ORCH_DIR, "scripts/validate-release-manifest.mjs"), join(REPO_ROOT, "release-manifest.json")],
    { cwd: REPO_ROOT, timeout: 30_000 },
  );
  gates.push(releaseManifest);
  if (releaseManifest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "release_manifest", error: releaseManifest.detail }); }

  // 9. Package inventory assertion
  const pkgInventory = await runGate(
    "package_inventory",
    "node",
    [join(ORCH_DIR, "scripts/assert-package-inventory.mjs"), join(ARTIFACTS_DIR, "npm-pack-inventory.json"), join(ARTIFACTS_DIR, "python-dist")],
    { cwd: REPO_ROOT, timeout: 30_000 },
  );
  gates.push(pkgInventory);
  if (pkgInventory.status === "infrastructure_error") { infrastructureErrors.push({ gate: "package_inventory", error: pkgInventory.detail }); }

  // Determine overall result
  const failedGates = gates.filter((g) => g.status === "fail");
  const thresholdsPassed = failedGates.length === 0 && infrastructureErrors.length === 0 && skippedRequired.length === 0;

  const summary = {
    tested_commit: testedCommit,
    thresholds_passed: thresholdsPassed,
    skipped_required: skippedRequired,
    infrastructure_errors: infrastructureErrors,
    gates: gates.map((g) => ({ name: g.name, status: g.status, detail: g.detail })),
  };

  // Write summary to output path
  const outPath = outputPath || join(ARTIFACTS_DIR, "quality-gates-summary.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");

  return summary;
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const cmd = process.argv[2];
  if (cmd === "run") {
    const outputIdx = process.argv.indexOf("--output");
    const outputPath = outputIdx >= 0 ? process.argv[outputIdx + 1] : undefined;
    const summary = await runAllGates(outputPath);
    const evalResult = evaluateSummary(summary);
    if (!evalResult.passed) {
      process.stderr.write(`quality gates failed: ${evalResult.errors.join("; ")}\n`);
      process.exit(1);
    }
    process.stdout.write(`quality gates passed: all thresholds met, 0 infrastructure errors, 0 skipped required\n`);
  } else if (cmd === "check") {
    const summaryPath = process.argv[3];
    if (!summaryPath || !existsSync(summaryPath)) {
      process.stderr.write(`usage: node quality-gates-summary.mjs check <summary.json>\n`);
      process.exit(2);
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
    const evalResult = evaluateSummary(summary);
    evalResult.errors.push(...verifyTestedCommit(summary.tested_commit));
    evalResult.passed = evalResult.errors.length === 0;
    if (!evalResult.passed) {
      process.stderr.write(`quality gates summary rejected: ${evalResult.errors.join("; ")}\n`);
      process.exit(1);
    }
    process.stdout.write(`quality gates summary accepted: all thresholds passed, 0 infrastructure errors, 0 skipped required\n`);
  } else {
    process.stderr.write(`usage: node quality-gates-summary.mjs [run [--output <path>] | check <summary.json>]\n`);
    process.exit(2);
  }
}
