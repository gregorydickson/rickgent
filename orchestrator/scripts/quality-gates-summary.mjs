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
import { spawnSync } from "node:child_process";
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
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf-8",
      timeout,
      env: env ?? PATH_ENV(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Infrastructure error: spawn failed, timeout, or no exit status
    if (result.error || result.signal || result.status === null) {
      return {
        name,
        status: "infrastructure_error",
        detail: result.error?.message || `signal: ${result.signal}` || "no exit status",
        exitCode: null,
      };
    }
    // Exit 0 = pass, nonzero = fail (threshold not met)
    const detail = (result.stdout || "").trim().split("\n").slice(-3).join(" | ");
    return {
      name,
      status: result.status === 0 ? "pass" : "fail",
      detail: detail || `exit ${result.status}`,
      exitCode: result.status,
    };
  } catch (e) {
    return {
      name,
      status: "infrastructure_error",
      detail: e.message,
      exitCode: null,
    };
  }
}

/**
 * Run all quality gates and produce a summary.
 */
export function runAllGates(outputPath) {
  const gates = [];
  const infrastructureErrors = [];
  const skippedRequired = [];

  // 1. TypeScript typecheck
  const typecheck = runGate("typecheck", "npx", ["tsc", "--noEmit"], { cwd: ORCH_DIR, timeout: 60_000 });
  gates.push(typecheck);
  if (typecheck.status === "infrastructure_error") { infrastructureErrors.push({ gate: "typecheck", error: typecheck.detail }); }

  // 2. TypeScript build
  const retainedBuildCommit = readFileSync(
    join(ORCH_DIR, "src", "build-commit.ts"),
    "utf8",
  ).match(/BUILD_COMMIT = "([0-9a-f]{40})"/)?.[1];
  const build = runGate("build", "node", ["scripts/generate-build-commit.cjs"], {
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

  // 3. Full TypeScript regression with coverage. The global thresholds cover
  // the production tree, so a tiny meta-test subset cannot honestly satisfy
  // them.
  const tsTest = runGate(
    "ts_test_coverage",
    "npx",
    [
      "vitest",
      "run",
      "--maxWorkers=4",
      "--coverage",
    ],
    { cwd: ORCH_DIR, timeout: 900_000 },
  );
  gates.push(tsTest);
  if (tsTest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "ts_test_coverage", error: tsTest.detail }); }

  // 4. Python lint (ruff)
  const ruff = runGate("ruff_lint", "ruff", ["check", "."], { cwd: POLICIES_DIR, timeout: 30_000 });
  gates.push(ruff);
  if (ruff.status === "infrastructure_error") { infrastructureErrors.push({ gate: "ruff_lint", error: ruff.detail }); }

  // 5. Python typecheck (mypy)
  const mypy = runGate("mypy_typecheck", "mypy", ["rickgent_policies"], { cwd: POLICIES_DIR, timeout: 60_000 });
  gates.push(mypy);
  if (mypy.status === "infrastructure_error") { infrastructureErrors.push({ gate: "mypy_typecheck", error: mypy.detail }); }

  // 6. Python test with coverage
  const pythonCli = join(ORCH_DIR, "dist", "cli.js");
  const generatedBuildCommit = readFileSync(
    join(ORCH_DIR, "src", "build-commit.ts"),
    "utf8",
  ).match(/BUILD_COMMIT = "([0-9a-f]{40})"/)?.[1];
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const pyTest = runGate(
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
  const manifest = runGate(
    "coverage_manifest_verify",
    "node",
    [join(ORCH_DIR, "scripts/coverage-manifest.cjs"), "--verify", "--temp-worktrees-only"],
    { cwd: ORCH_DIR, timeout: 30_000 },
  );
  gates.push(manifest);
  if (manifest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "coverage_manifest_verify", error: manifest.detail }); }

  // 8. Release manifest validation
  const releaseManifest = runGate(
    "release_manifest",
    "node",
    [join(ORCH_DIR, "scripts/validate-release-manifest.mjs"), join(REPO_ROOT, "release-manifest.json")],
    { cwd: REPO_ROOT, timeout: 30_000 },
  );
  gates.push(releaseManifest);
  if (releaseManifest.status === "infrastructure_error") { infrastructureErrors.push({ gate: "release_manifest", error: releaseManifest.detail }); }

  // 9. Package inventory assertion
  const pkgInventory = runGate(
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
    thresholds_passed: thresholdsPassed,
    skipped_required: skippedRequired,
    infrastructure_errors: infrastructureErrors,
    gates: gates.map((g) => ({ name: g.name, status: g.status, detail: g.detail })),
    generated_at: new Date().toISOString(),
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
    const summary = runAllGates(outputPath);
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
