import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchCleanupAction,
  deleteBranchWithLease,
  requireBranchAbsentAfterCleanup,
  requireBranchPresentAfterPush,
} from "../../scripts/run-protected-release.mjs";

const roots: string[] = [];

function git(args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(repository: string, message: string) {
  git([
    "-C", repository,
    "-c", "user.name=Protected Release Test",
    "-c", "user.email=protected-release@example.invalid",
    "commit", "--allow-empty", "-m", message,
  ]);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("protected release branch deletion lease", () => {
  it("accepts response-loss absence only after the exact-OID lease was attempted", () => {
    const ownedOid = "a".repeat(40);
    expect(() => branchCleanupAction(null, ownedOid, false)).toThrow(
      "owned branch disappeared before compare-and-delete",
    );
    expect(branchCleanupAction(null, ownedOid, true)).toBe("already-absent");
    expect(branchCleanupAction(
      { object: { sha: ownedOid } },
      ownedOid,
      false,
    )).toBe("delete-with-lease");
    expect(() => branchCleanupAction(
      { object: { sha: "b".repeat(40) } },
      ownedOid,
      true,
    )).toThrow("branch changed before compare-and-delete");
  });

  it("tolerates bounded hosted read-after-delete lag without weakening the lease", () => {
    const ownedOid = "a".repeat(40);
    const observations = [
      { object: { sha: ownedOid } },
      { object: { sha: ownedOid } },
      null,
    ];
    expect(requireBranchAbsentAfterCleanup(
      () => observations.shift(),
      ownedOid,
      true,
      { attempts: 3, delayMs: 0 },
    )).toBe(true);
    expect(() => requireBranchAbsentAfterCleanup(
      () => ({ object: { sha: "b".repeat(40) } }),
      ownedOid,
      true,
      { attempts: 3, delayMs: 0 },
    )).toThrow("branch changed before compare-and-delete");
    expect(() => requireBranchAbsentAfterCleanup(
      () => ({ object: { sha: ownedOid } }),
      ownedOid,
      true,
      { attempts: 2, delayMs: 0 },
    )).toThrow("owned branch remains after cleanup");
  });

  it("tolerates bounded hosted read-after-push lag while binding the exact OID", () => {
    const ownedOid = "a".repeat(40);
    const observations = [null, null, { object: { sha: ownedOid } }];
    expect(requireBranchPresentAfterPush(
      () => observations.shift(),
      ownedOid,
      { attempts: 3, delayMs: 0 },
    )).toEqual({ object: { sha: ownedOid } });
    expect(() => requireBranchPresentAfterPush(
      () => ({ object: { sha: "b".repeat(40) } }),
      ownedOid,
      { attempts: 2, delayMs: 0 },
    )).toThrow("pushed branch changed before observation");
    expect(() => requireBranchPresentAfterPush(
      () => null,
      ownedOid,
      { attempts: 2, delayMs: 0 },
    )).toThrow("pushed branch was not observable");
  });

  it("refuses to delete a branch that advanced after the owned OID was observed", () => {
    const root = mkdtempSync(join(tmpdir(), "protected-release-lease-"));
    roots.push(root);
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    git(["init", "-q", repository]);
    git(["init", "-q", "--bare", remote]);

    commit(repository, "owned");
    const ownedOid = git(["-C", repository, "rev-parse", "HEAD"]);
    git(["-C", repository, "push", remote, "HEAD:refs/heads/protected/test"]);

    commit(repository, "advanced");
    const advancedOid = git(["-C", repository, "rev-parse", "HEAD"]);
    git(["-C", repository, "push", remote, "HEAD:refs/heads/protected/test"]);

    expect(() => deleteBranchWithLease(
      repository,
      remote,
      "protected/test",
      ownedOid,
    )).toThrow();
    expect(git([
      "--git-dir", remote,
      "rev-parse", "refs/heads/protected/test",
    ])).toBe(advancedOid);

    deleteBranchWithLease(repository, remote, "protected/test", advancedOid);
    expect(git([
      "--git-dir", remote,
      "for-each-ref", "--format=%(refname)",
      "refs/heads/protected/test",
    ])).toBe("");
  });
});
