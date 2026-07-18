import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureDurableSalvageArchive,
  DURABLE_SALVAGE_LIMITS,
  isAuthorizedSalvageReceipt,
  restoreDurableSalvageArchive,
  type DurableSalvageArchiveRequest,
} from "../../src/lifecycle/salvage.js";

function git(repo: string, args: readonly string[]): string {
  return execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("durable t21 salvage archive", () => {
  let root: string;
  let repo: string;
  let archiveRoot: string;
  let baselineOid: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rickgent-durable-salvage-"));
    repo = join(root, "attempt-worktree");
    archiveRoot = join(root, "external-archive");
    mkdirSync(repo, { mode: 0o700 });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Durable Salvage"]);
    git(repo, ["config", "user.email", "salvage@example.test"]);
    writeFileSync(join(repo, ".gitignore"), "ignored.bin\n", "utf8");
    writeFileSync(join(repo, "tracked.txt"), "baseline\n", "utf8");
    git(repo, ["add", ".gitignore", "tracked.txt"]);
    git(repo, ["commit", "-qm", "baseline"]);
    baselineOid = git(repo, ["rev-parse", "HEAD"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function request(overrides: Partial<DurableSalvageArchiveRequest> = {}): DurableSalvageArchiveRequest {
    return {
      archiveRoot,
      baselineOid,
      attemptRef: git(repo, ["symbolic-ref", "HEAD"]),
      expectedAttemptRefOid: baselineOid,
      salvageRecordId: "salvage-record-1",
      attemptId: "attempt-1",
      ownershipId: "owner-1",
      ownerGeneration: 1,
      ownershipContextDigest: digest("owner-context"),
      contextId: "context-cleanup-1",
      evidenceId: "evidence-salvage-1",
      processReceiptId: "process-receipt-1",
      groupDeathEvidenceId: "group-death-evidence-1",
      ...overrides,
    };
  }

  it("distinguishes a positive empty proof from capture failure and mints no artifact", () => {
    const result = captureDurableSalvageArchive(repo, request());
    expect(result.outcome, result.detail).toBe("empty");
    expect(result.artifactPath).toBeNull();
    expect(result.artifactDigest).toBeNull();
    expect(result.artifactSize).toBeNull();
    expect(result.receipt).toMatchObject({
      disposition: "empty",
      artifactPath: null,
      artifactDigest: null,
      artifactSize: null,
      contextId: "context-cleanup-1",
    });
    expect(isAuthorizedSalvageReceipt(result.receipt)).toBe(true);

    execFileSync("/usr/bin/mkfifo", [join(repo, "unsupported-pipe")]);
    const failed = captureDurableSalvageArchive(repo, request({ salvageRecordId: "salvage-record-2" }));
    expect(failed.outcome).toBe("capture_failed");
    expect(failed.receipt).toBeNull();
    expect(failed.detail).toMatch(/unsupported special entry/i);
  });

  it("atomically captures and round-trips tracked, untracked, ignored, binary, symlink, empty, and mode state", () => {
    writeFileSync(join(repo, "tracked.txt"), "modified\n", "utf8");
    chmodSync(join(repo, "tracked.txt"), 0o640);
    writeFileSync(join(repo, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(repo, "ignored.bin"), Buffer.from([9, 0, 8, 255]));
    writeFileSync(join(repo, "empty.txt"), Buffer.alloc(0));
    symlinkSync("tracked.txt", join(repo, "owned-link"));

    const first = captureDurableSalvageArchive(repo, request());
    expect(first.outcome, first.detail).toBe("captured");
    expect(first.receipt).not.toBeNull();
    expect(isAuthorizedSalvageReceipt(first.receipt)).toBe(true);
    expect(first.receipt).toMatchObject({
      artifactPath: first.artifactPath,
      artifactDigest: first.artifactDigest,
      artifactSize: first.artifactSize,
      disposition: "captured",
    });
    expect(relative(repo, first.artifactPath!)).toMatch(/^\.\./);
    expect(lstatSync(first.artifactPath!).mode & 0o777).toBe(0o600);

    const replay = captureDurableSalvageArchive(repo, request());
    expect(replay.outcome, replay.detail).toBe("captured");
    expect(replay.replayed).toBe(true);
    expect(replay.artifactPath).toBe(first.artifactPath);
    expect(replay.artifactDigest).toBe(first.artifactDigest);

    const restored = join(root, "restored");
    mkdirSync(restored, { mode: 0o700 });
    const restoration = restoreDurableSalvageArchive(first.artifactPath!, first.artifactDigest!, restored);
    expect(restoration.outcome, restoration.detail).toBe("restored");
    expect(readFileSync(join(restored, "tracked.txt"), "utf8")).toBe("modified\n");
    expect(lstatSync(join(restored, "tracked.txt")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(restored, "untracked.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(readFileSync(join(restored, "ignored.bin"))).toEqual(Buffer.from([9, 0, 8, 255]));
    expect(readFileSync(join(restored, "empty.txt"))).toHaveLength(0);
    expect(readlinkSync(join(restored, "owned-link"))).toBe("tracked.txt");
    expect(restoration.manifest?.entries.find((entry) => entry.path === "untracked.bin")?.contentKind).toBe("binary");
    expect(restoration.manifest?.entries.find((entry) => entry.path === "empty.txt")?.contentKind).toBe("empty");
    expect(restoration.manifest?.entries.find((entry) => entry.path === "ignored.bin")?.classification).toBe("untracked");
  });

  it("captures a clean committed tree and embeds bounded commit recovery data", () => {
    writeFileSync(join(repo, "committed.bin"), Buffer.from([7, 0, 6, 255]));
    git(repo, ["add", "committed.bin"]);
    git(repo, ["commit", "-qm", "failed committed work"]);

    const result = captureDurableSalvageArchive(repo, request({ expectedAttemptRefOid: git(repo, ["rev-parse", "HEAD"]) }));
    expect(result.outcome, result.detail).toBe("captured");
    const restored = join(root, "committed-restored");
    mkdirSync(restored, { mode: 0o700 });
    const restoration = restoreDurableSalvageArchive(result.artifactPath!, result.artifactDigest!, restored);
    expect(restoration.outcome, restoration.detail).toBe("restored");
    expect(readFileSync(join(restored, "committed.bin"))).toEqual(Buffer.from([7, 0, 6, 255]));
    expect(restoration.manifest?.head_oid).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(restoration.manifest?.commit_oids).toContain(git(repo, ["rev-parse", "HEAD"]));
    expect(restoration.manifest?.commit_bundle?.size).toBeGreaterThan(0);
  });

  it("captures staged index-only work when the worktree is reversed to baseline", () => {
    writeFileSync(join(repo, "tracked.txt"), "staged-only\n", "utf8");
    git(repo, ["add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "baseline\n", "utf8");

    const result = captureDurableSalvageArchive(repo, request());
    expect(result.outcome, result.detail).toBe("captured");
    const manifest = JSON.parse(readFileSync(result.artifactPath!, "utf8")) as {
      index_snapshot: { changed_entries: Array<{ path: string; content_base64: string }> };
      entries: unknown[];
    };
    expect(manifest.entries).toEqual([]);
    const staged = manifest.index_snapshot.changed_entries.find((entry) => entry.path === "tracked.txt");
    expect(staged).toBeDefined();
    expect(Buffer.from(staged!.content_base64, "base64").toString("utf8")).toBe("staged-only\n");
  });

  it("verifies the complete artifact before restore and leaves an empty destination untouched on corruption", () => {
    writeFileSync(join(repo, "failed.txt"), "failed work\n", "utf8");
    const result = captureDurableSalvageArchive(repo, request());
    expect(result.outcome, result.detail).toBe("captured");
    const bytes = readFileSync(result.artifactPath!);
    const corruptAt = Math.floor(bytes.length / 2);
    bytes[corruptAt] = bytes[corruptAt]! ^ 1;
    writeFileSync(result.artifactPath!, bytes);

    const restored = join(root, "corrupt-restored");
    mkdirSync(restored, { mode: 0o700 });
    const restoration = restoreDurableSalvageArchive(result.artifactPath!, result.artifactDigest!, restored);
    expect(restoration.outcome).toBe("restore_failed");
    expect(restoration.detail).toMatch(/digest|identity/i);
    expect(existsSync(join(restored, "failed.txt"))).toBe(false);
  });

  it("rejects archive roots that overlap the attempt worktree or traverse a symlink", () => {
    writeFileSync(join(repo, "failed.txt"), "failed work\n", "utf8");
    const inside = captureDurableSalvageArchive(repo, request({ archiveRoot: join(repo, "archive") }));
    expect(inside.outcome).toBe("capture_failed");
    expect(inside.detail).toMatch(/external|disjoint/i);

    const actual = join(root, "actual-archive");
    mkdirSync(actual, { mode: 0o700 });
    const link = join(root, "archive-link");
    symlinkSync(actual, link);
    const linked = captureDurableSalvageArchive(repo, request({ archiveRoot: link }));
    expect(linked.outcome).toBe("capture_failed");
    expect(linked.detail).toMatch(/safe directory/i);
  });

  it("fails closed at the file bound without confusing the failure for empty work", () => {
    const oversized = join(repo, "oversized.bin");
    writeFileSync(oversized, Buffer.alloc(0));
    truncateSync(oversized, DURABLE_SALVAGE_LIMITS.maxFileBytes + 1);

    const result = captureDurableSalvageArchive(repo, request());
    expect(result.outcome).toBe("capture_failed");
    expect(result.receipt).toBeNull();
    expect(result.detail).toMatch(/file exceeds.*bound/i);
    expect(existsSync(archiveRoot)).toBe(false);
  });

  it("does not charge unchanged baseline bytes to the failed-work archive bound", () => {
    const unchanged = join(repo, "large-baseline.bin");
    writeFileSync(unchanged, Buffer.alloc(0));
    truncateSync(unchanged, DURABLE_SALVAGE_LIMITS.maxFileBytes + 1);
    git(repo, ["add", "large-baseline.bin"]);
    git(repo, ["commit", "-qm", "large unchanged baseline"]);
    baselineOid = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "small-failure.txt"), "preserve me\n", "utf8");

    const result = captureDurableSalvageArchive(repo, request());
    expect(result.outcome, result.detail).toBe("captured");
    const restored = join(root, "delta-only-restored");
    mkdirSync(restored, { mode: 0o700 });
    const restoration = restoreDurableSalvageArchive(result.artifactPath!, result.artifactDigest!, restored);
    expect(restoration.outcome, restoration.detail).toBe("restored");
    expect(readFileSync(join(restored, "small-failure.txt"), "utf8")).toBe("preserve me\n");
    expect(existsSync(join(restored, "large-baseline.bin"))).toBe(false);
    expect(restoration.manifest?.entries.some((entry) => entry.classification === "tracked_unchanged")).toBe(false);
  });

  it("replays the exact published artifact after response loss before receipt minting", () => {
    writeFileSync(join(repo, "failed.txt"), "durable before receipt\n", "utf8");
    const interrupted = captureDurableSalvageArchive(repo, request(), {
      afterBarrier(barrier) {
        expect(barrier).toBe("after_artifact_publish_fsync");
        throw new Error("simulated response loss");
      },
    });
    expect(interrupted.outcome).toBe("capture_failed");
    expect(interrupted.receipt).toBeNull();
    expect(readdirSync(archiveRoot)).toHaveLength(1);

    const replay = captureDurableSalvageArchive(repo, request());
    expect(replay.outcome, replay.detail).toBe("captured");
    expect(replay.replayed).toBe(true);
    expect(readdirSync(archiveRoot)).toEqual([`${replay.artifactDigest!.slice(7)}.salvage.json`]);
    expect(isAuthorizedSalvageReceipt(replay.receipt)).toBe(true);
  });
});
