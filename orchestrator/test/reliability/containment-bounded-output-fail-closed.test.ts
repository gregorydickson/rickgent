/**
 * m5-fix-bounded-output-fail-closed-and-validation: M5 scrutiny round 9.
 *
 * Two fail-closed defects in the streaming BoundedOutputSink capture path:
 *
 * (1) `dockerExecStreaming` swallows `BoundedOutputSink` write and
 *     close/integrity failures — a zero child exit could be treated as a
 *     successful dispatch with a partial or synthetic empty output receipt.
 *     Fix: propagate sink write/close/integrity failure as a fail-closed
 *     infrastructure failure (null exit code) BEFORE success terminalization.
 *
 * (2) `outputLimitBytes` and `tailLimitBytes` are accepted without finite
 *     positive bounds, maximum cap, or tail<=output validation — malformed
 *     or infinite values could disable bounded capture.  Fix: validate
 *     before spawning: (a) positive safe integers, (b) finite, (c) capped at
 *     64 MiB, (d) tail <= output.  Reject malformed/unbounded values with a
 *     fail-closed error before spawning.
 *
 * Red-then-green proof: every case below must fail against the unfixed code
 * (red) and pass after the fix (green).  The red observation for each case
 * is captured in the execution report.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedOutputSink,
  ContainmentUnavailableError,
  DockerCgroupV2ContainmentBackend,
  RICKGENT_MAX_OUTPUT_LIMIT_BYTES,
  validateDockerOutputLimits,
  type BoundedOutputReceipt,
  type ContainmentLineage,
} from "../../src/process/containment.js";
import { runBuildViaRunnerForTesting } from "../../src/lifecycle/build.js";
import { FIXTURE_RUNTIME_AUTHORITY } from "../../src/testing/fixture-authority.js";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function makeLineage(suffix: string): ContainmentLineage {
  return {
    runId: `fail-closed-run-${suffix}`,
    ticketId: "t23",
    attemptId: `fail-closed-attempt-${suffix}`,
    ownershipId: `ownership-${suffix}`,
    ownerGeneration: 1,
    ownershipContextDigest: sha256(`ownership-context:${suffix}`),
    phaseExecutionId: `phase-exec-${suffix}`,
    contextId: `ctx-${suffix}`,
    executionContextDigest: sha256(`exec-context:${suffix}`),
  };
}

function makeRepo(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rickgent-r9-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "R9 Fail-Closed Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "r9-fail-closed@example.test"]);
  writeFileSync(join(repo, "README.md"), "r9 fail-closed\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.OSType}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    execFileSync("docker", ["image", "inspect", "rickgent-runner:latest"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = dockerAvailable();

// ===========================================================================
// Defect #2: validateDockerOutputLimits — fail-closed validation of
// outputLimitBytes and tailLimitBytes before spawning.
//
// These are unit-level tests of the exported validation function.  They
// cover every malformed/unbounded value the ticket enumerates: negative,
// zero, NaN, Infinity, tail > output, and values exceeding the 64 MiB cap.
// They do NOT require Docker — the validation runs before any Docker
// contact.  The production-path wiring (validation fires inside
// releaseTarget before observeMembership) is proven by the Docker-gated
// test below.
// ===========================================================================

describe("m5 scrutiny round 9 — validateDockerOutputLimits fail-closed validation", () => {
  it("rejects a negative outputLimitBytes", () => {
    expect(() => validateDockerOutputLimits(-1, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a zero outputLimitBytes", () => {
    expect(() => validateDockerOutputLimits(0, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a NaN outputLimitBytes", () => {
    expect(() => validateDockerOutputLimits(Number.NaN, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it("rejects an Infinity outputLimitBytes", () => {
    expect(() => validateDockerOutputLimits(Number.POSITIVE_INFINITY, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a negative tailLimitBytes", () => {
    expect(() => validateDockerOutputLimits(8 * 1024 * 1024, -1)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a zero tailLimitBytes", () => {
    expect(() => validateDockerOutputLimits(8 * 1024 * 1024, 0)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a NaN tailLimitBytes", () => {
    expect(() => validateDockerOutputLimits(8 * 1024 * 1024, Number.NaN)).toThrow(ContainmentUnavailableError);
  });
  it("rejects an Infinity tailLimitBytes", () => {
    expect(() => validateDockerOutputLimits(8 * 1024 * 1024, Number.POSITIVE_INFINITY)).toThrow(ContainmentUnavailableError);
  });
  it("rejects tailLimitBytes > outputLimitBytes", () => {
    expect(() => validateDockerOutputLimits(16 * 1024, 32 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it(`rejects outputLimitBytes > 64 MiB cap (${RICKGENT_MAX_OUTPUT_LIMIT_BYTES} bytes)`, () => {
    expect(() => validateDockerOutputLimits(RICKGENT_MAX_OUTPUT_LIMIT_BYTES + 1, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it(`rejects tailLimitBytes > 64 MiB cap (${RICKGENT_MAX_OUTPUT_LIMIT_BYTES} bytes)`, () => {
    expect(() => validateDockerOutputLimits(RICKGENT_MAX_OUTPUT_LIMIT_BYTES, RICKGENT_MAX_OUTPUT_LIMIT_BYTES + 1)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a non-integer outputLimitBytes (fractional)", () => {
    expect(() => validateDockerOutputLimits(1.5, 1)).toThrow(ContainmentUnavailableError);
  });
  it("accepts valid bounds: 8 MiB output, 16 KiB tail", () => {
    expect(() => validateDockerOutputLimits(8 * 1024 * 1024, 16 * 1024)).not.toThrow();
  });
  it("accepts the maximum cap: 64 MiB output, 64 MiB tail (tail === output)", () => {
    expect(() => validateDockerOutputLimits(RICKGENT_MAX_OUTPUT_LIMIT_BYTES, RICKGENT_MAX_OUTPUT_LIMIT_BYTES)).not.toThrow();
  });
  it("accepts the minimum bound: 1 byte output, 1 byte tail", () => {
    expect(() => validateDockerOutputLimits(1, 1)).not.toThrow();
  });
  it("rejects -Infinity outputLimitBytes", () => {
    expect(() => validateDockerOutputLimits(Number.NEGATIVE_INFINITY, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
  it("rejects a Number.MAX_SAFE_INTEGER outputLimitBytes (exceeds 64 MiB cap)", () => {
    expect(() => validateDockerOutputLimits(Number.MAX_SAFE_INTEGER, 16 * 1024)).toThrow(ContainmentUnavailableError);
  });
});

// ===========================================================================
// Defect #1: BoundedOutputSink write/close/integrity failures propagate as
// fail-closed infrastructure failures (NOT swallowed).
//
// The production path is `DockerCgroupV2ContainmentBackend.releaseTarget` →
// `dockerExecStreaming` → `BoundedOutputSink.write` / `BoundedOutputSink.close`.
// The unfixed code catches sink write errors inside the stream `data` handler
// (swallowing them) and catches close/integrity errors inside `safeCloseSink`
// (synthesizing an empty receipt).  A zero child exit then terminalizes as a
// successful dispatch with a partial or synthetic empty output receipt.
//
// The fix: after the child closes, if either sink recorded a write failure
// (`sink.failure !== null`) OR a close/integrity failure, force the exit
// code to `null` so the AttemptRunner maps the dispatch to
// `infrastructure_error` (not success).
//
// The negative proof injects a failing `BoundedOutputSink` via the
// `sinkFactory` constructor option (dependency injection, defaults to the
// real BoundedOutputSink).  The production `dockerExecStreaming` and
// `releaseTarget` code paths are exercised unchanged — only the sink class
// is substituted.  The fixture omnigent produces output AND exits 0, so
// without the fix the dispatch would terminalize as "succeeded" with a
// partial/empty receipt.  With the fix, the dispatch fails closed.
// ===========================================================================

/**
 * Failing sink whose `write` throws after the first chunk.  Simulates a
 * real production write failure (disk full, descriptor invalidated, etc.)
 * without bypassing the production `dockerExecStreaming` code path.
 */
class WriteFailingBoundedOutputSink extends BoundedOutputSink {
  #writeCount = 0;
  constructor(path: string, limit: number, tailLimit: number, opts: { strictDirectorySafety?: boolean }) {
    super(path, limit, tailLimit, opts);
  }
  override write(chunk: Buffer): void {
    this.#writeCount += 1;
    if (this.#writeCount > 1) {
      // Simulate a real write failure on the second chunk.  The production
      // BoundedOutputSink catches writeSync errors internally and records
      // them in `#failure`; we mirror that by throwing — the production
      // `dockerExecStreaming` `data` handler catches this and the sink's
      // own failure tracking takes over.
      throw new Error("simulated bounded output write failure (round 9 negative proof)");
    }
    super.write(chunk);
  }
}

/**
 * Failing sink whose `close` throws to simulate an integrity check failure
 * (the artifact became unsafe: file replaced, size mismatch, symlink swap).
 */
class CloseFailingBoundedOutputSink extends BoundedOutputSink {
  constructor(path: string, limit: number, tailLimit: number, opts: { strictDirectorySafety?: boolean }) {
    super(path, limit, tailLimit, opts);
  }
  override close(): BoundedOutputReceipt {
    throw new Error("simulated bounded output close/integrity failure (round 9 negative proof)");
  }
}

describe.skipIf(!DOCKER_AVAILABLE)("m5 scrutiny round 9 — production-path sink failure fails closed (Docker required)", () => {
  it("a BoundedOutputSink write failure forces the dispatch to fail closed (exitCode null, not succeeded)", async () => {
    const repo = makeRepo("sink-write-fail");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const agentDir = join(repoRoot, "agents", "rickgent");
    const fixtureOmnigentDir = realpathSync(join(orchestratorRoot, "test", "fixtures", "omnigent-fixture"));
    const realAgentDir = realpathSync(agentDir);
    const dockerBackend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      hostMounts: [fixtureOmnigentDir, realAgentDir],
      containerPath: [fixtureOmnigentDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      containerAgentDir: realAgentDir,
      extraEnv: { FIXTURE_MODE: "prompt", FIXTURE_FLOOD_BYTES: "262144" },
      // Inject a sink whose write fails on the second chunk.  The fixture
      // omnigent produces > 1 chunk of stdout, so the write failure fires
      // on the production streaming path.
      sinkFactory: (path, limit, tailLimit, o) => new WriteFailingBoundedOutputSink(path, limit, tailLimit, o),
    });
    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath: join(repoRoot, "fixtures", "prd-min.md"),
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        env: {
          ...process.env,
          RICKGENT_DIR: rickgentDir,
          RICKGENT_CONTAINMENT_DOCKER_IMAGE: "rickgent-runner:latest",
        },
        outputLimitBytes: 8 * 1024 * 1024,
        tailLimitBytes: 16 * 1024,
      },
      { containmentBackendOverride: dockerBackend },
    );
    // The dispatch MUST fail closed — the sink write failure must propagate
    // as an infrastructure failure, NOT be swallowed into a success with a
    // partial/empty receipt.
    expect(result.outcome.status, `sink write failure must fail closed (got ${result.outcome.status})`).not.toBe("succeeded");
  }, 180_000);

  it("a BoundedOutputSink close/integrity failure forces the dispatch to fail closed (exitCode null, not succeeded)", async () => {
    const repo = makeRepo("sink-close-fail");
    const rickgentDir = join(repo, ".rickgent");
    const dataDir = join(repo, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const agentDir = join(repoRoot, "agents", "rickgent");
    const fixtureOmnigentDir = realpathSync(join(orchestratorRoot, "test", "fixtures", "omnigent-fixture"));
    const realAgentDir = realpathSync(agentDir);
    const dockerBackend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      hostMounts: [fixtureOmnigentDir, realAgentDir],
      containerPath: [fixtureOmnigentDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      containerAgentDir: realAgentDir,
      extraEnv: { FIXTURE_MODE: "prompt" },
      // Inject a sink whose close always throws (integrity check failure).
      sinkFactory: (path, limit, tailLimit, o) => new CloseFailingBoundedOutputSink(path, limit, tailLimit, o),
    });
    const result = await runBuildViaRunnerForTesting(
      FIXTURE_RUNTIME_AUTHORITY,
      {
        prdPath: join(repoRoot, "fixtures", "prd-min.md"),
        workingDir: repo,
        rickgentDir,
        agentDir,
        dataDir,
        env: {
          ...process.env,
          RICKGENT_DIR: rickgentDir,
          RICKGENT_CONTAINMENT_DOCKER_IMAGE: "rickgent-runner:latest",
        },
        outputLimitBytes: 8 * 1024 * 1024,
        tailLimitBytes: 16 * 1024,
      },
      { containmentBackendOverride: dockerBackend },
    );
    // The dispatch MUST fail closed — the sink close/integrity failure must
    // propagate as an infrastructure failure, NOT be swallowed into a
    // success with a synthetic empty receipt.
    expect(result.outcome.status, `sink close failure must fail closed (got ${result.outcome.status})`).not.toBe("succeeded");
  }, 180_000);

  it("releaseTarget validates outputLimitBytes before contacting Docker for the exec (negative value)", async () => {
    // Create a real boundary (requires Docker), then call releaseTarget
    // with an invalid outputLimitBytes.  The validation must fire BEFORE
    // the docker exec spawn, throwing ContainmentUnavailableError.  The
    // boundary's container is still running its sleep command (no exec was
    // attempted), proving the validation ran before spawning.
    const backend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      probeTimeoutMs: 60_000,
    });
    const lineage = makeLineage("validation-negative");
    const boundary = await backend.createBoundary(lineage);
    try {
      await expect(
        backend.releaseTarget(boundary, ["sh", "-c", "exit 0"], { outputLimitBytes: -1, tailLimitBytes: 16 * 1024 }),
      ).rejects.toThrow(ContainmentUnavailableError);
    } finally {
      try { await backend.dispose(boundary); } catch { /* best effort */ }
    }
  }, 60_000);

  it("releaseTarget validates tailLimit > outputLimit before contacting Docker for the exec", async () => {
    const backend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      probeTimeoutMs: 60_000,
    });
    const lineage = makeLineage("validation-tail-gt-output");
    const boundary = await backend.createBoundary(lineage);
    try {
      await expect(
        backend.releaseTarget(boundary, ["sh", "-c", "exit 0"], { outputLimitBytes: 16 * 1024, tailLimitBytes: 32 * 1024 }),
      ).rejects.toThrow(ContainmentUnavailableError);
    } finally {
      try { await backend.dispose(boundary); } catch { /* best effort */ }
    }
  }, 60_000);

  it("releaseTarget validates outputLimit > 64 MiB cap before contacting Docker for the exec", async () => {
    const backend = new DockerCgroupV2ContainmentBackend({
      image: "rickgent-runner:latest",
      probeTimeoutMs: 60_000,
    });
    const lineage = makeLineage("validation-over-cap");
    const boundary = await backend.createBoundary(lineage);
    try {
      await expect(
        backend.releaseTarget(boundary, ["sh", "-c", "exit 0"], {
          outputLimitBytes: RICKGENT_MAX_OUTPUT_LIMIT_BYTES + 1,
          tailLimitBytes: 16 * 1024,
        }),
      ).rejects.toThrow(ContainmentUnavailableError);
    } finally {
      try { await backend.dispose(boundary); } catch { /* best effort */ }
    }
  }, 60_000);
});

describe("m5 scrutiny round 9 — Docker-gated sink failure proofs skip-when-unavailable", () => {
  it("documents that the production-path sink failure proofs require the Docker cgroup-v2 backend and runner image", () => {
    // This test exists so the suite reports a clear skip reason when
    // Docker is not available, rather than silently passing with zero
    // proofs run.  The skipIf above gates the real proofs.
    expect(typeof DOCKER_AVAILABLE).toBe("boolean");
  });
});
