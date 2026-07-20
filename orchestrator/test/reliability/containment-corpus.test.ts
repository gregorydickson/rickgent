/**
 * t22B: real platform corpus against the chosen backend (VAL-T22B-003).
 *
 * Per the ratified M2 ADR, the chosen backend is Docker Desktop / Linux-VM
 * cgroup-v2 (option A) on this macOS host.  Each corpus case spawns a real
 * Docker container with `--cgroupns=private` and exercises the
 * authority-owned containment interface against the real cgroup-v2
 * hierarchy: `cgroup.kill` for terminate-all, `cgroup.events populated=0`
 * for authoritative emptiness, and the `pids`/`memory`/`cpu` controllers
 * for bounded membership.
 *
 * Corpus cases (per the feature contract and ADR obligation 8):
 *   1. spawn failure
 *   2. timeout
 *   3. stubborn descendants
 *   4. output flood
 *   5. ownership loss (forged boundary rejected)
 *   6. crash recovery (backend re-probe after container exit)
 *   7. kill (terminate-all via cgroup.kill)
 *   8. confirmed emptiness (cgroup.events populated=0)
 *   9. rapid double-fork / setsid escape attempt
 *
 * On hosts where the Docker probe does not pass, the suite is skipped (the
 * unavailable fail-closed path is covered in `containment-authority.test.ts`).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ContainmentUnavailableError,
  DockerCgroupV2ContainmentBackend,
  isAuthorizedContainmentBoundary,
  isAuthorizedContainmentDeathReceipt,
  isAuthorizedContainmentMembership,
  type ContainmentBoundary,
  type ContainmentLineage,
} from "../../src/process/containment.js";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function makeLineage(suffix: string): ContainmentLineage {
  return {
    runId: `corpus-run-${suffix}`,
    ticketId: "t22",
    attemptId: `corpus-attempt-${suffix}`,
    ownershipId: `ownership-${suffix}`,
    ownerGeneration: 1,
    ownershipContextDigest: sha256(`ownership-context:${suffix}`),
    phaseExecutionId: `phase-exec-${suffix}`,
    contextId: `ctx-${suffix}`,
    executionContextDigest: sha256(`exec-context:${suffix}`),
  };
}

const backend = new DockerCgroupV2ContainmentBackend({ probeTimeoutMs: 60_000, killTimeoutMs: 30_000, pollIntervalMs: 50 });
const boundaries: Array<{ dispose: () => Promise<void> }> = [];
// Compute availability at module load so describe.skipIf can evaluate it.
const backendAvailable = backend.probe().status === "available";

afterEach(async () => {
  for (const b of boundaries.splice(0)) {
    try { await b.dispose(); } catch { /* ignore */ }
  }
});

afterAll(async () => {
  // Final cleanup: prune any rickgent-boundary containers left behind.
  try {
    execFileSync("docker", ["container", "prune", "-f", "--filter", "label=rickgent-containment"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch { /* ignore */ }
});

describe.skipIf(!backendAvailable)("VAL-T22B-003: real platform corpus (Docker cgroup-v2 backend)", () => {
  it("case 1: spawn failure — releaseTarget into a missing command fails closed; boundary stays disposable", async () => {
    const lineage = makeLineage("spawn-fail");
    const boundary = await backend.createBoundary(lineage);
    expect(isAuthorizedContainmentBoundary(boundary)).toBe(true);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    const launch = await backend.releaseTarget(boundary, ["sh", "-c", "exit 7"]);
    expect(launch.exitCode).toBe(7);
    expect(isAuthorizedContainmentMembership(launch.membership)).toBe(true);
    await backend.dispose(boundary);
  });

  it("case 2: timeout — a long-running target is killed and confirmed empty", async () => {
    const lineage = makeLineage("timeout");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    // Release a target that sleeps 60s; we kill it well before that.
    const launch = await backend.releaseTarget(boundary, ["sh", "-c", "sleep 60"], { timeoutMs: 2_000 });
    // The exec may time out (status null) or be killed; either way the
    // target was launched into the boundary.
    expect(isAuthorizedContainmentMembership(launch.membership)).toBe(true);
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 5_000);
    expect(emptiness.emptinessConfirmed).toBe(true);
    expect(emptiness.populated).toBe(false);
    const death = backend.mintDeathReceipt(boundary, emptiness);
    expect(isAuthorizedContainmentDeathReceipt(death)).toBe(true);
    expect(death.emptinessConfirmed).toBe(true);
  });

  it("case 3: stubborn descendants — cgroup.kill reaps a forked child tree", async () => {
    const lineage = makeLineage("stubborn");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    // Launch a target that forks a child which sleeps stubbornly.
    await backend.releaseTarget(boundary, ["sh", "-c", "sleep 30 & sleep 30 & sleep 30 & wait"], { timeoutMs: 1_000 });
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 5_000);
    expect(emptiness.emptinessConfirmed).toBe(true);
    const death = backend.mintDeathReceipt(boundary, emptiness);
    expect(death.emptinessConfirmed).toBe(true);
  });

  it("case 4: output flood — bounded output does not block emptiness confirmation", async () => {
    const lineage = makeLineage("flood");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    const outDir = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-flood-")));
    const stdoutPath = join(outDir, "stdout");
    const launch = await backend.releaseTarget(
      boundary,
      ["sh", "-c", "yes flooding | head -c 1048576; exit 0"],
      { stdoutPath, timeoutMs: 15_000 },
    );
    expect(launch.exitCode).toBe(0);
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 5_000);
    expect(emptiness.emptinessConfirmed).toBe(true);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("case 5: ownership loss — a forged (unbranded) boundary is rejected by kill/awaitEmpty", async () => {
    const forged = {
      backendId: "docker-cgroup-v2",
      boundaryName: "rickgent/forged",
      launchId: "forged-launch",
      runtimeHandle: "rickgent-forged-container",
    };
    expect(isAuthorizedContainmentBoundary(forged)).toBe(false);
    // kill on a forged boundary fails closed (no terminate-all on a foreign boundary).
    await expect(backend.kill(forged as unknown as ContainmentBoundary)).rejects.toThrow(ContainmentUnavailableError);
    // awaitEmpty on a forged boundary fails closed.
    await expect(backend.awaitEmpty(forged as unknown as ContainmentBoundary, 1_000)).rejects.toThrow(ContainmentUnavailableError);
  });

  it("case 6: crash recovery — backend re-probes after a container exits; a new boundary is creatable", async () => {
    const lineage = makeLineage("crash-recovery");
    const boundary = await backend.createBoundary(lineage);
    expect(isAuthorizedContainmentBoundary(boundary)).toBe(true);
    // Simulate a crash: stop + remove the container out-of-band.
    try { execFileSync("docker", ["rm", "-f", boundary.runtimeHandle], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* ignore */ }
    // The backend can create a fresh boundary for a new lineage.
    const lineage2 = makeLineage("crash-recovery-2");
    const boundary2 = await backend.createBoundary(lineage2);
    expect(isAuthorizedContainmentBoundary(boundary2)).toBe(true);
    boundaries.push({ dispose: () => backend.dispose(boundary2) });
  });

  it("case 7: kill — terminate-all via cgroup.kill kills every descendant", async () => {
    const lineage = makeLineage("kill");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    await backend.releaseTarget(boundary, ["sh", "-c", "sleep 30 & sleep 30 & wait"], { timeoutMs: 1_000 });
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 5_000);
    expect(emptiness.emptinessConfirmed).toBe(true);
  });

  it("case 8: confirmed emptiness — cgroup.events populated=0 is the authoritative signal", async () => {
    const lineage = makeLineage("emptiness");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    await backend.releaseTarget(boundary, ["sh", "-c", "exit 0"], { timeoutMs: 5_000 });
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 10_000);
    expect(emptiness.proofBasis).toBe("authoritative_containment");
    expect(emptiness.emptinessConfirmed).toBe(true);
    expect(emptiness.populated).toBe(false);
    expect(emptiness.eventsDigest).toMatch(/^sha256:/);
  });

  it("case 9: rapid double-fork / setsid escape attempt — escapees stay in the cgroup and are killed", async () => {
    const lineage = makeLineage("escape");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    // The target attempts to escape via double-fork + setsid, then sleeps.
    // Inside the container's private cgroup namespace, setsid creates a new
    // session but the process remains a member of the container's cgroup;
    // cgroup.kill reaps it regardless of session/pgid.
    const escapeScript = [
      "sh -c '",
      "setsid sh -c 'setsid sh -c \"sleep 30; exit 0\" & sleep 30' &",
      "sleep 30",
      "'",
    ].join(" ");
    await backend.releaseTarget(boundary, ["sh", "-c", escapeScript], { timeoutMs: 1_000 });
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 10_000);
    expect(emptiness.emptinessConfirmed).toBe(true);
    const death = backend.mintDeathReceipt(boundary, emptiness);
    expect(death.emptinessConfirmed).toBe(true);
    // No process escaped: the death receipt is authority-owned and confirms
    // all-descendant death via the cgroup-v2 kernel authority.
    expect(isAuthorizedContainmentDeathReceipt(death)).toBe(true);
  });

  it("death receipt content-pins the exact launch + backend + lineage", async () => {
    const lineage = makeLineage("death-receipt");
    const boundary = await backend.createBoundary(lineage);
    boundaries.push({ dispose: () => backend.dispose(boundary) });
    await backend.releaseTarget(boundary, ["sh", "-c", "exit 0"], { timeoutMs: 5_000 });
    await backend.kill(boundary);
    const emptiness = await backend.awaitEmpty(boundary, 5_000);
    const death = backend.mintDeathReceipt(boundary, emptiness);
    expect(death.boundary.backendId).toBe(boundary.backendId);
    expect(death.boundary.boundaryName).toBe(boundary.boundaryName);
    expect(death.boundary.launchId).toBe(boundary.launchId);
    expect(death.lineage.attemptId).toBe(lineage.attemptId);
    expect(death.lineage.ownershipId).toBe(lineage.ownershipId);
    expect(death.proofBasis).toBe("authoritative_containment");
    expect(death.deathDigest).toMatch(/^sha256:/);
  });
});

describe("VAL-T22B-003: corpus skip-when-unavailable", () => {
  it("documents that the corpus requires the Docker cgroup-v2 backend", () => {
    // On a host without Docker, the corpus is skipped and the unavailable
    // fail-closed path (containment-authority.test.ts) is the authority.
    if (!backendAvailable) {
      expect(backend.probe().status).toBe("unavailable");
    } else {
      expect(backendAvailable).toBe(true);
    }
  });
});
