/**
 * Coverage manifest generator + mutation check (C2 / VAL-COV-001..003).
 *
 * The manifest is GENERATED from discovered executable test ids — not hardcoded
 * booleans. Every referenced file and test case is verified to exist. A
 * mutation check confirms that removing any incident-class guard fails the
 * suite (proving the guard is genuinely tested, not pass-on-nothing).
 *
 * This is a CommonJS module so it can be imported by vitest tests and also
 * run as a standalone script.
 */

"use strict";

const {
  readFileSync,
  existsSync,
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
} = require("fs");
const { join, basename } = require("path");
const { tmpdir } = require("os");
const { spawnSync } = require("child_process");

const REPO_ROOT = join(__dirname, "..", "..");
const ORCH_DIR = join(REPO_ROOT, "orchestrator");
const POLICIES_DIR = join(REPO_ROOT, "rickgent-policies");

const PATH_ENV = () => ({ ...process.env });

// ── Incident class definitions ──────────────────────────────────────────────
// Each incident class maps a guard in the source code to the test that verifies
// it. The `guardMarker` is a unique substring that proves the guard exists in
// the source. The `mutate` function applies a minimal change that breaks the
// guard; if the test suite still passes after mutation, the guard is untested.

const TS_INCIDENT_CLASSES = [
  // ── Completion (src/core/completion.ts) ──
  {
    id: "completion-committed",
    testFile: "test/core/completion.test.ts",
    testCase: "returns COMMITTED when all checks pass",
    sourceFile: "src/core/completion.ts",
    guardMarker: 'return { verdict: "COMMITTED", commitSha: claimedSha, treeChanged: true };',
    mutate: (s) => s.replace(
      'return { verdict: "COMMITTED", commitSha: claimedSha, treeChanged: true };',
      'return { verdict: "UNVERIFIED", reason: "mutation: committed guard removed" };'
    ),
  },
  {
    id: "completion-unverified",
    testFile: "test/core/completion.test.ts",
    testCase: "returns UNVERIFIED when no claimed SHA",
    sourceFile: "src/core/completion.ts",
    guardMarker: "if (!claimedSha || !shaExists) {",
    mutate: (s) => s.replace(
      'return { verdict: "UNVERIFIED", reason: "no reachable commit" };',
      'return { verdict: "COMMITTED", commitSha: "mutation", treeChanged: true };'
    ),
  },
  {
    id: "completion-baseline-sha",
    testFile: "test/core/completion.test.ts",
    testCase: "returns BASELINE_SHA when claimed SHA equals baseline",
    sourceFile: "src/core/completion.ts",
    guardMarker: "if (claimedSha === baselineSha) {",
    mutate: (s) => s.replace(
      "if (claimedSha === baselineSha) {",
      "if (false && claimedSha === baselineSha) {"
    ),
  },
  {
    id: "completion-no-tree-change",
    testFile: "test/core/completion.test.ts",
    testCase: "returns NO_TREE_CHANGE when tree matches baseline",
    sourceFile: "src/core/completion.ts",
    guardMarker: "if (!treeChanged) {",
    mutate: (s) => s.replace(
      "if (!treeChanged) {",
      "if (false && !treeChanged) {"
    ),
  },
  // ── Salvage (src/core/salvage.ts) ──
  {
    id: "salvage-committed-done",
    testFile: "test/core/salvage.test.ts",
    testCase: "returns committed-done when gate green and tree changed",
    sourceFile: "src/core/salvage.ts",
    guardMarker: "if (gatePassed && treeChanged) {",
    mutate: (s) => s.replace(
      "if (gatePassed && treeChanged) {",
      "if (false && gatePassed && treeChanged) {"
    ),
  },
  {
    id: "salvage-archived-todo",
    testFile: "test/core/salvage.test.ts",
    testCase: "returns archived-todo when gate failing but tree changed",
    sourceFile: "src/core/salvage.ts",
    guardMarker: "if (!gatePassed && treeChanged) {",
    mutate: (s) => s.replace(
      "if (!gatePassed && treeChanged) {",
      "if (false && !gatePassed && treeChanged) {"
    ),
  },
  {
    id: "salvage-ff-reattached",
    testFile: "test/core/salvage.test.ts",
    testCase: "returns ff-reattached when orphan reset detected and reattach possible",
    sourceFile: "src/core/salvage.ts",
    guardMarker: "if (orphanReset && ffReattachPossible) {",
    mutate: (s) => s.replace(
      "if (orphanReset && ffReattachPossible) {",
      "if (false && orphanReset && ffReattachPossible) {"
    ),
  },
  {
    id: "salvage-no-op",
    testFile: "test/core/salvage.test.ts",
    testCase: "returns no-op when no tree changes",
    sourceFile: "src/core/salvage.ts",
    guardMarker: "if (gatePassed && !treeChanged) {",
    mutate: (s) => s.replace(
      "if (gatePassed && !treeChanged) {",
      "if (false && gatePassed && !treeChanged) {"
    ),
  },
  {
    id: "salvage-error",
    testFile: "test/core/salvage.test.ts",
    testCase: "coerces a non-array ownedPaths to an empty array (VAL-BUG-008)",
    sourceFile: "src/core/salvage.ts",
    guardMarker: "Array.isArray(input.ownedPaths)",
    mutate: (s) => s.replace(
      "Array.isArray(input.ownedPaths)",
      "true /* mutation: skip array coercion */"
    ),
  },
  // ── Breaker (src/core/breaker.ts) ──
  {
    id: "breaker-trips",
    testFile: "test/core/breaker.test.ts",
    testCase: "trips after threshold identical errors",
    sourceFile: "src/core/breaker.ts",
    guardMarker: "if (state.errorCounts[sig] >= state.threshold) {",
    mutate: (s) => s.replace(
      "state.open = true;\n      return { transition: \"opened\", canExecute: false, reason: `threshold reached for ${sig}` };",
      "state.open = false;\n      return { transition: \"closed\", canExecute: true };"
    ),
  },
  {
    id: "breaker-resets",
    testFile: "test/core/breaker.test.ts",
    testCase: "resets on git tree progress",
    sourceFile: "src/core/breaker.ts",
    guardMarker: 'reason: "successful iteration with tree change"',
    mutate: (s) => s.replace(
      'return { transition: "reset", canExecute: true, reason: "successful iteration with tree change" };',
      'state.open = true; /* mutation: reset disabled */\n      return { transition: "reset", canExecute: true, reason: "successful iteration with tree change" };'
    ),
  },
  {
    id: "breaker-rejects-claimed-progress",
    testFile: "test/core/breaker.test.ts",
    testCase: "rejects claimed progress without tree change",
    sourceFile: "src/core/breaker.ts",
    guardMarker: "// Detect progress via git tree truth, not worker claims",
    mutate: (s) => s.replace(
      "// Detect progress via git tree truth, not worker claims\n    if (result.gitTreeChanged) {",
      "// Detect progress via worker claims (MUTATION)\n    if (result.gitTreeChanged || result.workerClaimedFilesChanged) {"
    ),
  },
  // ── Convergence (src/core/convergence.ts) ──
  {
    id: "gate-stale-baseline",
    testFile: "test/core/convergence.test.ts",
    testCase: "detects stale baseline (zero baseline checks)",
    sourceFile: "src/core/convergence.ts",
    guardMarker: "const staleBaseline = baseline.length === 0 || isBaselineStale(baseline, current);",
    mutate: (s) => s.replace(
      "const staleBaseline = baseline.length === 0 || isBaselineStale(baseline, current);",
      "const staleBaseline = false; /* mutation: stale baseline guard removed */"
    ),
  },
  {
    id: "gate-silence-not-success",
    testFile: "test/core/convergence.test.ts",
    testCase: "fails on zero current checks (silence is not success)",
    sourceFile: "src/core/convergence.ts",
    guardMarker: 'failures.push("no checks executed — silence is not success");',
    mutate: (s) => s.replace(
      'failures.push("no checks executed — silence is not success");',
      "/* mutation: silence-is-not-success guard removed */"
    ),
  },
  {
    id: "gate-scope-filtering",
    testFile: "test/core/convergence.test.ts",
    testCase: "VAL-BUG-001: excludes a sibling directory that shares a name prefix",
    sourceFile: "src/core/convergence.ts",
    guardMarker: "scope.some((s) => isPathInScope(f.file, s)),",
    mutate: (s) => s.replace(
      "scope.some((s) => isPathInScope(f.file, s)),",
      "scope.some((s) => f.file.startsWith(s)), /* mutation: bypass isPathInScope */"
    ),
  },
  // ── Scope (src/core/scope.ts) ──
  {
    id: "scope-traversal",
    testFile: "test/core/scope-resolved.test.ts",
    testCase: "denies traversal even when it normalizes into declared scope",
    sourceFile: "src/core/scope.ts",
    guardMarker: 'if (components.some((part) => part === "" || part === "." || part === "..")) {',
    mutate: (s) => s.replace(
      'if (components.some((part) => part === "" || part === "." || part === "..")) {',
      'if (false && components.some((part) => part === "" || part === "." || part === "..")) { /* mutation: traversal guard removed */'
    ),
  },
  {
    id: "scope-outside-paths",
    testFile: "test/core/scope.test.ts",
    testCase: "denies writes outside declared paths",
    sourceFile: "src/core/scope.ts",
    guardMarker: "for (const declared of declaredPaths) {",
    mutate: (s) => s.replace(
      "for (const declared of declaredPaths) {",
      "for (const declared of [canonicalTarget]) { /* mutation: trust the target as declared */"
    ),
  },
  // ── PRD (src/core/prd.ts) ──
  {
    id: "prd-no-ac",
    testFile: "test/core/prd.test.ts",
    testCase: "rejects PRD without ACs",
    sourceFile: "src/core/prd.ts",
    guardMarker: 'errors.push("PRD must have at least one acceptance criterion");',
    mutate: (s) => s.replace(
      "if (acceptanceCriteria.length === 0) {",
      "if (false && acceptanceCriteria.length === 0) {"
    ),
  },
  {
    id: "prd-no-simplification",
    testFile: "test/core/prd.test.ts",
    testCase: "rejects PRD without simplification review",
    sourceFile: "src/core/prd.ts",
    guardMarker: 'errors.push("PRD must have a simplification review (subtract before you add)");',
    mutate: (s) => s.replace(
      'errors.push("PRD must have a simplification review (subtract before you add)");',
      "/* mutation: missing simplification review accepted */"
    ),
  },
  // ── Microverse (src/lifecycle/microverse.ts) ──
  {
    id: "microverse-convergence",
    testFile: "test/lifecycle/microverse.test.ts",
    testCase: "plateau: last N improvement deltas below epsilon converges",
    sourceFile: "src/lifecycle/microverse.ts",
    guardMarker: "window.every((d) => d < config.epsilon)",
    mutate: (s) => s.replace(
      "window.every((d) => d < config.epsilon)",
      "false /* mutation: plateau detection disabled */"
    ),
  },
  {
    id: "microverse-rollback",
    testFile: "test/lifecycle/microverse.test.ts",
    testCase: "rollback on regression preserves baseline",
    sourceFile: "src/lifecycle/microverse.ts",
    guardMarker: 'return { score, classification: "regressed", rolledBack: true };',
    mutate: (s) => s.replace(
      'return { score, classification: "regressed", rolledBack: true };',
      'return { score, classification: "improved", rolledBack: false }; /* mutation: rollback disabled */'
    ),
  },
  {
    id: "microverse-stall",
    testFile: "test/lifecycle/microverse.test.ts",
    testCase: "detects stall after stallLimit iterations (attrition, not convergence)",
    sourceFile: "src/lifecycle/microverse.ts",
    guardMarker: 'return this.result(false, "stalled");',
    mutate: (s) => s.replace(
      'if (this.stallCount >= this.config.stallLimit) {\n          return this.result(false, "stalled");',
      'if (false && this.stallCount >= this.config.stallLimit) {\n          return this.result(false, "stalled");'
    ),
  },
  // ── Dispatch (src/dispatch/dispatch.ts) ──
  {
    id: "dispatch-contract-incompatibility",
    testFile: "test/dispatch/dispatch.test.ts",
    testCase: "rejects a changed ticket contract instead of treating its allocation as a cache hit",
    sourceFile: "src/dispatch/dispatch.ts",
    guardMarker: 'throw new InputContractError("dispatch ticket contract differs from its canonical allocated attempt");',
    mutate: (s) => s.replace(
      'throw new InputContractError("dispatch ticket contract differs from its canonical allocated attempt");',
      "/* mutation: changed contract accepted */"
    ),
  },
  {
    id: "dispatch-backpressure",
    testFile: "test/dispatch/dispatch.test.ts",
    testCase: "records planned state without spawning when the legal sequential slot is occupied",
    sourceFile: "src/dispatch/dispatch.ts",
    guardMarker: "if (this.active >= opts.maxConcurrent) {",
    mutate: (s) => s.replace(
      "if (this.active >= opts.maxConcurrent) {",
      "if (false && this.active >= opts.maxConcurrent) {"
    ),
  },
  // ── Malformed input (multiple source files) ──
  {
    id: "malformed-null-input",
    testFile: "test/core/malformed-input.test.ts",
    testCase: "handles null input by failing closed",
    sourceFile: "src/core/completion.ts",
    guardMarker: 'if (input == null || typeof input !== "object") {',
    mutate: (s) => s.replace(
      'if (input == null || typeof input !== "object") {',
      "if (false) { /* mutation: null-input guard removed */"
    ),
  },
  {
    id: "malformed-wrong-types",
    testFile: "test/core/malformed-input.test.ts",
    testCase: "handles wrong types by failing closed",
    sourceFile: "src/core/completion.ts",
    guardMarker: 'const claimedSha = typeof input.claimedSha === "string" ? input.claimedSha : null;',
    mutate: (s) => s
      .replace('const claimedSha = typeof input.claimedSha === "string" ? input.claimedSha : null;', "const claimedSha = input.claimedSha; /* mutation: type coercion removed */")
      .replace("const shaExists = input.shaExists === true;", "const shaExists = input.shaExists;")
      .replace("const treeChanged = input.treeChanged === true;", "const treeChanged = input.treeChanged;"),
  },
];

const PY_INCIDENT_CLASSES = [
  {
    id: "drill-false-completion",
    testFile: "test/test_native_function_policy_corpus.py",
    testCase: "test_every_policy_event_and_bundle_verdict",
    testSelector: "test_every_policy_event_and_bundle_verdict and false_completion",
    sourceFile: "rickgent_policies/completion.py",
    guardMarker: 'return _deny("protected completion receipt is empty")',
    mutate: (s) => s.replace(
      'return _deny("protected completion receipt is empty")',
      'return None  # mutation: completion with an empty protected receipt allowed'
    ),
  },
  {
    id: "drill-same-vendor",
    testFile: "test/test_native_function_policy_corpus.py",
    testCase: "test_every_policy_event_and_bundle_verdict",
    testSelector: "test_every_policy_event_and_bundle_verdict and review_equality",
    sourceFile: "rickgent_policies/review.py",
    guardMarker: 'protected implementer/reviewer identity pair requires',
    mutate: (s) => s.replace(
      '"protected implementer/reviewer identity pair requires "',
      '"mutation: same-vendor review allowed" # mutation: same-vendor review allowed'
    ),
  },
  {
    id: "drill-shim-exception",
    testFile: "test/test_native_scope_corpus.py",
    testCase: "test_scope_fence_fails_closed_on_unexpected_exception",
    sourceFile: "rickgent_policies/scope.py",
    guardMarker: 'reason": f"{SCOPE_DENIAL_CODE}: scope policy failed safely"',
    mutate: (s) => s.replace(
      'reason": f"{SCOPE_DENIAL_CODE}: scope policy failed safely"',
      'reason": "mutation: scope policy exception allowed"'
    ),
  },
];

const ALL_INCIDENT_CLASSES = [...TS_INCIDENT_CLASSES, ...PY_INCIDENT_CLASSES];

// ── Test case discovery ─────────────────────────────────────────────────────

/**
 * Discover test case names by scanning a test file.
 * TS: matches it("..."), test("..."), describe("...")
 * Python: matches def test_...
 */
function discoverTestCases(filePath) {
  const absPath = resolvePath(filePath);
  if (!existsSync(absPath)) return [];
  const content = readFileSync(absPath, "utf-8");
  const cases = [];

  if (filePath.endsWith(".py")) {
    const pyRegex = /def\s+(test_\w+)/g;
    let m;
    while ((m = pyRegex.exec(content)) !== null) {
      cases.push(m[1]);
    }
  } else {
    // Match it("..."), it('...'), it(`...`), test("..."), describe("...")
    const tsRegex = /(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    let m;
    while ((m = tsRegex.exec(content)) !== null) {
      cases.push(m[1]);
    }
  }
  return cases;
}

// ── Path resolution ─────────────────────────────────────────────────────────

function resolvePath(relPath) {
  // TS paths are relative to orchestrator/
  if (!relPath.endsWith(".py") && !relPath.includes("rickgent_policies")) {
    return join(ORCH_DIR, relPath);
  }
  // Python paths are relative to rickgent-policies/
  return join(POLICIES_DIR, relPath);
}

function resolveSourcePath(cls) {
  if (cls.sourceFile.includes("rickgent_policies")) {
    return join(POLICIES_DIR, cls.sourceFile);
  }
  return join(ORCH_DIR, cls.sourceFile);
}

// ── Manifest generation (VAL-COV-001, VAL-COV-002) ──────────────────────────

/**
 * Generate the coverage manifest by discovering executable test ids.
 * Coverage is determined by actual discovery, NOT hardcoded booleans.
 */
function generateManifest() {
  const incidentClasses = ALL_INCIDENT_CLASSES.map((cls) => {
    const testFilePath = cls.testFile.endsWith(".py")
      ? join(POLICIES_DIR, cls.testFile)
      : join(ORCH_DIR, cls.testFile);
    const sourcePath = resolveSourcePath(cls);

    const fileExists = existsSync(testFilePath);
    const sourceExists = existsSync(sourcePath);
    const discoveredCases = discoverTestCases(cls.testFile);
    const testCaseExists = discoveredCases.includes(cls.testCase);

    let guardExists = false;
    if (sourceExists) {
      const sourceContent = readFileSync(sourcePath, "utf-8");
      guardExists = sourceContent.includes(cls.guardMarker);
    }

    return {
      id: cls.id,
      test: cls.testFile,
      testCase: cls.testCase,
      ...(cls.testSelector ? { testSelector: cls.testSelector } : {}),
      source: cls.sourceFile,
      fileExists,
      testCaseExists,
      guardExists,
      covered: fileExists && testCaseExists && guardExists,
    };
  });

  // Also verify required fixtures exist
  const fixtureDir = join(REPO_ROOT, "conformance", "fixtures");
  const requiredFixtures = [
    "completion-001-committed.json", "completion-002-unverified-no-sha.json",
    "completion-003-baseline-sha.json", "completion-004-no-tree-change.json",
    "completion-005-gate-red.json",
    "salvage-001-committed-done.json", "salvage-002-archived-todo.json",
    "salvage-003-ff-reattached.json", "salvage-004-no-op-clean-tree.json",
    "salvage-005-error.json",
    "breaker-001-trips-on-threshold.json", "breaker-002-resets-on-progress.json",
    "breaker-003-rejects-claimed-progress.json",
    "gate-001-fresh-baseline-pass.json", "gate-002-stale-baseline-zero-checks.json",
    "gate-003-silence-not-success.json", "gate-004-scope-filtering.json",
    "scope-001-allows-in-scope.json", "scope-002-denies-outside-scope.json",
    "scope-003-denies-traversal.json", "scope-004-allows-read.json",
    "prd-001-valid.json", "prd-002-no-ac.json", "prd-003-no-simplification.json",
  ].map((f) => {
    const fullPath = join(fixtureDir, f);
    return { id: f.replace(".json", ""), file: `conformance/fixtures/${f}`, exists: existsSync(fullPath) };
  });

  return {
    version: "2.0",
    generated: true,
    incidentClasses,
    requiredFixtures,
  };
}

// ── Mutation check (VAL-COV-003) ────────────────────────────────────────────

/**
 * Run a mutation check for a single incident class.
 * Applies the mutation, runs the test suite, and checks if the test FAILS
 * (proving the guard is genuinely tested).
 *
 * Returns { id, guardFound, testFailed, error }
 * - guardFound: the guardMarker was found in the source (guard exists)
 * - testFailed: the test suite failed with the mutation applied (guard is tested)
 */
function runMutationCheck(incidentClassId) {
  const cls = ALL_INCIDENT_CLASSES.find((c) => c.id === incidentClassId);
  if (!cls) throw new Error(`Unknown incident class: ${incidentClassId}`);

  const sourcePath = resolveSourcePath(cls);
  const original = readFileSync(sourcePath, "utf-8");

  // Verify guard exists in source
  if (!original.includes(cls.guardMarker)) {
    return {
      id: incidentClassId,
      guardFound: false,
      testFailed: false,
      error: "Guard marker not found in source file",
    };
  }

  // Apply mutation
  let mutated;
  try {
    mutated = cls.mutate(original);
  } catch (e) {
    return {
      id: incidentClassId,
      guardFound: true,
      testFailed: false,
      error: `Mutation function failed: ${e.message}`,
    };
  }

  if (mutated === original) {
    return {
      id: incidentClassId,
      guardFound: true,
      testFailed: false,
      error: "Mutation produced no change to source",
    };
  }

  const disposableRoot = mkdtempSync(join(tmpdir(), "rickgent-mutation-"));
  const disposableOrchestrator = join(disposableRoot, "orchestrator");
  const disposablePolicies = join(disposableRoot, "rickgent-policies");

  // Python policy fixtures authenticate and execute the built CLI. Keep dist
  // in the disposable tree so their unmutated baseline is runnable; only the
  // selected source file is mutated below.
  const copyFilter = (source) => !["node_modules", ".git", ".pytest_cache", "__pycache__"].includes(basename(source));
  cpSync(ORCH_DIR, disposableOrchestrator, { recursive: true, filter: copyFilter });
  cpSync(POLICIES_DIR, disposablePolicies, { recursive: true, filter: copyFilter });
  cpSync(join(REPO_ROOT, "agents", "rickgent"), join(disposableRoot, "agents", "rickgent"), { recursive: true, filter: copyFilter });
  cpSync(join(REPO_ROOT, "conformance"), join(disposableRoot, "conformance"), { recursive: true, filter: copyFilter });
  symlinkSync(realpathSync(join(ORCH_DIR, "node_modules")), join(disposableOrchestrator, "node_modules"), "dir");

  const disposableSource = cls.sourceFile.includes("rickgent_policies")
    ? join(disposablePolicies, cls.sourceFile)
    : join(disposableOrchestrator, cls.sourceFile);

  try {
    const isPython = cls.testFile.endsWith(".py");
    const runTargetedTest = () => {
      if (isPython) {
        return spawnSync(
          "python3",
          ["-m", "pytest", cls.testFile, "-k", cls.testSelector ?? cls.testCase, "-x", "--no-header", "-q"],
          {
            cwd: disposablePolicies,
            encoding: "utf-8",
            timeout: 60000,
            env: PATH_ENV(),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      }
      const vitestBin = join(disposableOrchestrator, "node_modules", ".bin", "vitest");
      const literalTestName = cls.testCase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return spawnSync(
        vitestBin,
        ["run", cls.testFile, "-t", literalTestName, "--reporter=json", "--no-cache"],
        {
          cwd: disposableOrchestrator,
          encoding: "utf-8",
          timeout: 60000,
          env: PATH_ENV(),
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    };

    const baseline = runTargetedTest();
    const baselineInfrastructure = baseline.error || baseline.signal || baseline.status === null;
    let baselineJson = null;
    const hasTargetAssertion = (parsed, status) => parsed.testResults?.some((suite) =>
      suite.assertionResults?.some((assertion) =>
        assertion.status === status &&
        (assertion.title === cls.testCase || assertion.fullName?.endsWith(cls.testCase))
      )
    ) === true;
    if (!isPython && !baselineInfrastructure) {
      try {
        baselineJson = JSON.parse(baseline.stdout || "");
      } catch {
        return {
          id: incidentClassId,
          guardFound: true,
          testFailed: false,
          error: "Mutation baseline produced no machine-readable Vitest result",
          status: baseline.status,
          sourceUnchanged: readFileSync(sourcePath, "utf-8") === original,
        };
      }
    }
    const baselinePassed = !baselineInfrastructure && baseline.status === 0 && (
      isPython ||
      (baselineJson.numFailedTests === 0 && hasTargetAssertion(baselineJson, "passed"))
    );
    if (!baselinePassed) {
      return {
        id: incidentClassId,
        guardFound: true,
        testFailed: false,
        error: `Mutation baseline did not pass: ${baseline.error?.message || baseline.signal || baseline.stderr || baseline.stdout || `status ${baseline.status}`}`,
        status: baseline.status,
        sourceUnchanged: readFileSync(sourcePath, "utf-8") === original,
      };
    }

    writeFileSync(disposableSource, mutated);
    const result = runTargetedTest();

    const infrastructureError = result.error || result.signal || result.status === null;
    let mutationResultError = null;
    let testFailed = false;
    if (!infrastructureError && isPython) {
      // Pytest exit 1 is an assertion/test failure; collection and usage errors
      // use different exits and must never count as a killed mutant.
      testFailed = result.status === 1;
      if (!testFailed && result.status !== 0) mutationResultError = `pytest infrastructure/collection exit ${result.status}`;
    } else if (!infrastructureError) {
      try {
        const parsed = JSON.parse(result.stdout || "");
        testFailed = result.status !== 0 && parsed.numFailedTests >= 1 && hasTargetAssertion(parsed, "failed");
        if (result.status !== 0 && !testFailed) {
          mutationResultError = "Vitest failed without a failed targeted assertion";
        }
      } catch {
        mutationResultError = "Mutation run produced no machine-readable Vitest result";
      }
    }
    return {
      id: incidentClassId,
      guardFound: true,
      testFailed,
      error: infrastructureError
        ? `Mutation test infrastructure failure: ${result.error?.message || result.signal || "no exit status"}`
        : mutationResultError
          ? mutationResultError
        : testFailed
          ? null
          : "Test passed with mutation applied (guard not tested)",
      stdout: result.stdout ? result.stdout.slice(-500) : undefined,
      stderr: result.stderr ? result.stderr.slice(-5000) : undefined,
      status: result.status,
      sourceUnchanged: readFileSync(sourcePath, "utf-8") === original,
    };
  } catch (e) {
    return {
      id: incidentClassId,
      guardFound: true,
      testFailed: false,
      error: `Test execution failed: ${e.message}`,
      sourceUnchanged: readFileSync(sourcePath, "utf-8") === original,
    };
  } finally {
    rmSync(disposableRoot, { recursive: true, force: true });
  }
}

/**
 * Run mutation checks for all incident classes.
 * Returns an array of results.
 */
function runAllMutationChecks() {
  return ALL_INCIDENT_CLASSES.map((cls) => runMutationCheck(cls.id));
}

// ── Verification (VAL-REL-002) ──────────────────────────────────────────────

/**
 * Verify the coverage manifest: generate it and confirm every incident class
 * is covered (file exists, test case discovered, guard marker found in source).
 * Returns a structured result object.
 */
function verifyManifest() {
  const manifest = generateManifest();
  const uncovered = manifest.incidentClasses.filter((cls) => !cls.covered);
  const missingFixtures = manifest.requiredFixtures.filter((f) => !f.exists);
  const allCovered = uncovered.length === 0 && missingFixtures.length === 0;
  return {
    verified: allCovered,
    allCovered,
    uncoveredCount: uncovered.length,
    uncovered: uncovered.map((c) => ({ id: c.id, fileExists: c.fileExists, testCaseExists: c.testCaseExists, guardExists: c.guardExists })),
    missingFixtureCount: missingFixtures.length,
    missingFixtures: missingFixtures.map((f) => f.id),
    guardExistenceChecked: true,
    totalClasses: manifest.incidentClasses.length,
  };
}

/**
 * Statically verify that mutation runs use disposable worktrees only.
 * Checks the source of coverage-manifest.cjs itself for the required patterns:
 *   1. mkdtempSync — creates a disposable temporary directory
 *   2. cpSync — copies source into the disposable tree (never mutates in place)
 *   3. writeFileSync to disposableSource — mutation written to the copy, not the original
 *   4. rmSync — disposable tree cleaned up after the run
 *   5. sourceUnchanged — the original source is verified unchanged after the run
 *
 * This is a static code audit, not a runtime check. It confirms the mutation
 * infrastructure is structurally incapable of mutating the production source.
 */
function verifyTempWorktreesOnly() {
  const selfSource = readFileSync(__filename, "utf-8");
  const checks = [
    { id: "mkdtempSync", pattern: /mkdtempSync\s*\(/, description: "creates a disposable temporary directory" },
    { id: "cpSync", pattern: /cpSync\s*\(\s*ORCH_DIR/, description: "copies orchestrator into disposable tree" },
    { id: "cpSyncPolicies", pattern: /cpSync\s*\(\s*POLICIES_DIR/, description: "copies policies into disposable tree" },
    { id: "writeDisposableSource", pattern: /writeFileSync\s*\(\s*disposableSource/, description: "mutation written to disposable copy, not original" },
    { id: "rmSync", pattern: /rmSync\s*\(\s*disposableRoot/, description: "disposable tree cleaned up after run" },
    { id: "sourceUnchangedCheck", pattern: /sourceUnchanged.*readFileSync\s*\(\s*sourcePath/, description: "original source verified unchanged after mutation" },
    { id: "noInPlaceWrite", pattern: /writeFileSync\s*\(\s*sourcePath/, description: "must NOT write directly to original source path", negate: true },
  ];
  const results = checks.map((c) => {
    const found = c.pattern.test(selfSource);
    const passed = c.negate ? !found : found;
    return { id: c.id, description: c.description, found, passed };
  });
  const allPassed = results.every((r) => r.passed);
  return {
    tempWorktreesOnly: allPassed,
    allChecksPassed: allPassed,
    checks: results,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  INCIDENT_CLASSES: ALL_INCIDENT_CLASSES,
  discoverTestCases,
  generateManifest,
  runMutationCheck,
  runAllMutationChecks,
  verifyManifest,
  verifyTempWorktreesOnly,
  resolvePath,
  resolveSourcePath,
  ORCH_DIR,
  POLICIES_DIR,
  REPO_ROOT,
};

// CLI entry point
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "generate") {
    const manifest = generateManifest();
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  } else if (cmd === "mutate" && process.argv[3]) {
    const result = runMutationCheck(process.argv[3]);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.testFailed ? 0 : 1);
  } else if (cmd === "mutate-all") {
    const results = runAllMutationChecks();
    const allPassed = results.every((r) => r.testFailed);
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    process.exit(allPassed ? 0 : 1);
  } else if (cmd === "--verify") {
    const tempWorktreesOnly = process.argv.includes("--temp-worktrees-only");
    const manifestResult = verifyManifest();
    if (!manifestResult.verified) {
      process.stderr.write(`coverage manifest verification failed: ${manifestResult.uncoveredCount} uncovered classes, ${manifestResult.missingFixtureCount} missing fixtures\n`);
      process.stdout.write(JSON.stringify(manifestResult, null, 2) + "\n");
      process.exit(1);
    }
    if (tempWorktreesOnly) {
      const twResult = verifyTempWorktreesOnly();
      if (!twResult.tempWorktreesOnly) {
        process.stderr.write(`temp-worktrees-only verification failed: ${twResult.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}\n`);
        process.stdout.write(JSON.stringify({ ...manifestResult, ...twResult }, null, 2) + "\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ ...manifestResult, ...twResult }, null, 2) + "\n");
    } else {
      process.stdout.write(JSON.stringify(manifestResult, null, 2) + "\n");
    }
  } else {
    process.stderr.write("Usage: node coverage-manifest.cjs [generate|mutate <id>|mutate-all|--verify [--temp-worktrees-only]]\n");
    process.exit(1);
  }
}
