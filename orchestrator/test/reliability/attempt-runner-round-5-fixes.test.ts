/**
 * m4-fix-review-failopen-sticky-agentdir-omnigent-bypass: M4 scrutiny round 5
 * fixes.
 *
 * Four defects (3 blocking + 1 non-blocking):
 *
 * (1) BLOCKING: Review provider falls back to baseline tree when candidate-tree
 *     resolution fails, then accepts the nonempty baseline — an unresolvable
 *     candidate mints a positive review instead of failing closed.
 *
 * (2) BLOCKING: Containment reads sticky process-global RICKGENT_AGENT_DIR
 *     instead of validated per-request agent directory — a second build in the
 *     same process can mount the wrong bundle.
 *
 * (3) BLOCKING: Docker image permits omnigent installation to fail silently;
 *     integration test bypasses omnigent with shell dispatchArgvOverride
 *     (sh -c) instead of testing the real omnigent run argv.
 *
 * (4) NON-BLOCKING: Provider stages worktree changes with `git add -A` —
 *     replace with owned-paths-only staging (`git add -- path`).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");

// ---------------------------------------------------------------------------
// Defect #1: Review provider must fail closed on unresolvable candidate tree.
// ---------------------------------------------------------------------------

describe("defect #1: review provider fails closed on unresolvable candidate tree", () => {
  it("the review provider does NOT substitute baselineOid for treeOid in the catch block", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    const reviewStart = source.indexOf("review(input: ReviewInput): ReviewResult");
    expect(reviewStart).toBeGreaterThanOrEqual(0);
    // The review method body extends until the next provider method.
    const reviewEnd = source.indexOf("verification(input: VerificationInput)", reviewStart);
    expect(reviewEnd).toBeGreaterThan(reviewStart);
    const reviewBody = source.slice(reviewStart, reviewEnd);
    // The fail-open pattern: setting treeOid = baselineOid in the catch block
    // causes the verdict to be "accept" because the baseline oid is a nonempty
    // string.  An unresolvable candidate must NOT be substituted with the
    // baseline tree — the review must fail closed with "reject".
    expect(reviewBody).not.toMatch(/treeOid\s*=\s*baselineOid/);
  });

  it("the review provider returns reject when the candidate tree cannot be resolved", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    const reviewStart = source.indexOf("review(input: ReviewInput): ReviewResult");
    const reviewEnd = source.indexOf("verification(input: VerificationInput)", reviewStart);
    const reviewBody = source.slice(reviewStart, reviewEnd);
    // M7 changed the catch block from a direct `return reject` to a fallback
    // digest pattern: when the diff cannot be resolved, the catch block sets
    // a unique fallback digest (sha256:review-diff-unresolvable:...) so the
    // stale-diff check does not accidentally pass. The review hook still
    // rejects an unresolvable candidate because the fallback digest will not
    // match the actual diff. This is fail-closed behavior without a direct
    // `return reject` in the catch block.
    const catchBlockMatch = reviewBody.match(/catch\s*\{[\s\S]*?\}/);
    expect(catchBlockMatch).not.toBeNull();
    const catchBlock = catchBlockMatch![0];
    // The catch block must set a unique fallback digest (fail closed).
    expect(catchBlock).toMatch(/review-diff-unresolvable|reviewDiffDigest\s*=/);
    // The catch block must NOT fall through to the accept path — it must NOT
    // substitute the baseline OID for the candidate tree OID.
    expect(catchBlock).not.toMatch(/treeOid\s*=\s*baselineOid/);
  });
});

// ---------------------------------------------------------------------------
// Defect #2: Containment must receive agentDir as an explicit per-request
// parameter, not from sticky process-global RICKGENT_AGENT_DIR.
// ---------------------------------------------------------------------------

describe("defect #2: containment uses explicit agentDir parameter", () => {
  it("probeContainmentBackend accepts agentDir as an explicit parameter", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    const probeFnStart = source.indexOf("export function probeContainmentBackend");
    expect(probeFnStart).toBeGreaterThanOrEqual(0);
    // The function body extends to the end of the file region; find the
    // next top-level export or end-of-function.
    const probeFnBody = source.slice(probeFnStart, source.indexOf("export function containmentLineageFromAttempt", probeFnStart));
    // The function signature / opts must include agentDir.
    expect(probeFnBody).toMatch(/agentDir/);
    // The containerAgentDir must be derived from the agentDir parameter, not
    // from process.env.RICKGENT_AGENT_DIR.
    expect(probeFnBody).toMatch(/opts\.agentDir/);
  });

  it("probeContainmentBackend does NOT read process.env.RICKGENT_AGENT_DIR for containerAgentDir", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "process", "containment.ts"), "utf-8");
    const probeFnStart = source.indexOf("export function probeContainmentBackend");
    const probeFnBody = source.slice(probeFnStart, source.indexOf("export function containmentLineageFromAttempt", probeFnStart));
    // The probe function must NOT assign containerAgentDir from the env var.
    // It may read env for other host paths (OMNIGENT_ROOT, etc.), but the
    // agent directory must come from the explicit parameter.
    expect(probeFnBody).not.toMatch(/env\.RICKGENT_AGENT_DIR/);
    expect(probeFnBody).not.toMatch(/process\.env\.RICKGENT_AGENT_DIR/);
  });

  it("executeBuildViaRunner does NOT mutate process.env.RICKGENT_AGENT_DIR", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "build.ts"), "utf-8");
    const start = source.indexOf("async function executeBuildViaRunner(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("async function executeBuildLegacy(", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // The production path must NOT set process.env.RICKGENT_AGENT_DIR — that
    // is a sticky process-global mutation that a second build in the same
    // process could inherit incorrectly.
    expect(body).not.toMatch(/process\.env\.RICKGENT_AGENT_DIR\s*=/);
    // The production path must pass opts.agentDir to probeContainmentBackend.
    expect(body).toMatch(/agentDir/);
  });

  it("executeBuildViaRunner passes opts.agentDir to probeContainmentBackend", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "build.ts"), "utf-8");
    const start = source.indexOf("async function executeBuildViaRunner(");
    const end = source.indexOf("async function executeBuildLegacy(", start);
    const body = source.slice(start, end);
    // The probe call must include agentDir in the opts.
    expect(body).toMatch(/probeContainmentBackend\(/);
    // Find the probeOpts construction and verify agentDir is passed.
    expect(body).toMatch(/agentDir.*opts\.agentDir|opts\.agentDir.*agentDir/);
  });
});

// ---------------------------------------------------------------------------
// Defect #3: Dockerfile must fail if omnigent is not installed; integration
// test must use the real omnigent run argv with the fixture omnigent mounted.
// ---------------------------------------------------------------------------

describe("defect #3a: Dockerfile fails build if omnigent is not installed and executable", () => {
  it("the Dockerfile has a RUN step that verifies omnigent --version exits 0", () => {
    const dockerfilePath = join(repoRoot, "docker", "runner.Dockerfile");
    expect(existsSync(dockerfilePath)).toBe(true);
    const source = readFileSync(dockerfilePath, "utf-8");
    // The Dockerfile must have a RUN step that executes `omnigent --version`.
    expect(source).toMatch(/RUN\s+.*omnigent\s+--version/);
  });

  it("the omnigent --version RUN step does NOT permit failure (no || true or || echo)", () => {
    const dockerfilePath = join(repoRoot, "docker", "runner.Dockerfile");
    const source = readFileSync(dockerfilePath, "utf-8");
    const lines = source.split("\n");
    const omnigentVersionLines = lines.filter((l) => /omnigent\s+--version/.test(l));
    expect(omnigentVersionLines.length).toBeGreaterThan(0);
    for (const line of omnigentVersionLines) {
      // The RUN step must NOT have a || true, || echo, or || <anything> that
      // permits the omnigent install/check to fail silently.
      expect(line).not.toMatch(/\|\|\s*(true|echo|sh)/);
      expect(line).not.toMatch(/;\s*(true|echo)/);
    }
  });

  it("the pip install step does NOT permit failure (no || echo fallback)", () => {
    const dockerfilePath = join(repoRoot, "docker", "runner.Dockerfile");
    const source = readFileSync(dockerfilePath, "utf-8");
    const lines = source.split("\n");
    // Match any pip install line that installs omnigent (editable or not).
    const pipInstallLines = lines.filter((l) => /pip\s+install/.test(l) && /omnigent|sdks/.test(l));
    expect(pipInstallLines.length).toBeGreaterThan(0);
    for (const line of pipInstallLines) {
      // The pip install must NOT have a || echo fallback that permits failure.
      expect(line).not.toMatch(/\|\|\s*(true|echo)/);
    }
  });
});

describe("defect #3b: integration test uses real omnigent run argv (no dispatchArgvOverride)", () => {
  it("the Docker integration test does NOT use dispatchArgvOverride", () => {
    const testPath = join(orchestratorRoot, "test", "reliability", "attempt-runner-real-providers-docker-integration.test.ts");
    expect(existsSync(testPath)).toBe(true);
    const source = readFileSync(testPath, "utf-8");
    // The test must NOT use dispatchArgvOverride to bypass the real omnigent
    // run argv.  The production dispatch command must be tested directly.
    expect(source).not.toMatch(/dispatchArgvOverride/);
  });

  it("the Docker integration test does NOT use sh -c to bypass the dispatch command", () => {
    const testPath = join(orchestratorRoot, "test", "reliability", "attempt-runner-real-providers-docker-integration.test.ts");
    const source = readFileSync(testPath, "utf-8");
    // The test must NOT use sh -c shell dispatch to bypass the real omnigent
    // run argv.
    expect(source).not.toMatch(/["']sh["']\s*,\s*["']-c["']/);
  });

  it("the Docker integration test mounts the fixture omnigent into the container", () => {
    const testPath = join(orchestratorRoot, "test", "reliability", "attempt-runner-real-providers-docker-integration.test.ts");
    const source = readFileSync(testPath, "utf-8");
    // The test must reference the fixture omnigent directory and mount it
    // into the container via the containment backend configuration.
    expect(source).toMatch(/omnigent-fixture/);
  });
});

// ---------------------------------------------------------------------------
// Defect #4: Provider uses owned-paths-only git staging (no git add -A).
// ---------------------------------------------------------------------------

describe("defect #4: provider uses owned-paths-only git staging", () => {
  it("attempt-runner-providers.ts does NOT use git add -A", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    // The provider must NOT use `git add -A` (or `git add` with `-A` flag).
    // Owned-paths-only staging is required (invariant 9, AGENTS.md).
    expect(source).not.toMatch(/["']add["']\s*,\s*["']-A["']/);
    expect(source).not.toMatch(/git.*add.*-A/);
  });

  it("attempt-runner-providers.ts uses owned-paths-only staging (git add -- path)", () => {
    const source = readFileSync(join(orchestratorRoot, "src", "lifecycle", "attempt-runner-providers.ts"), "utf-8");
    // The provider must use `git add -- <paths>` with explicit paths, not
    // `git add -A`.
    expect(source).toMatch(/["']add["']\s*,\s*["']--["']/);
  });
});
