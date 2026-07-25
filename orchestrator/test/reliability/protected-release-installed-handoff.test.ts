import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  committedDirectoryInventory,
  requireExactOmnigentHandoff,
  requireExactInstalledPackage,
  requireUnchangedInstalledHandoff,
} from "../../scripts/run-protected-release.mjs";

const installed = {
  cli_sha256: "1".repeat(64),
  manager_sha256: "2".repeat(64),
  policy_inventory_sha256: "5".repeat(64),
  policy_sha256: "3".repeat(64),
  python_sha256: "6".repeat(64),
  worker_sha256: "4".repeat(64),
};

describe("protected release installed handoff continuity", () => {
  it("binds dereferenced package symlinks to their target tree at the pinned commit", () => {
    const repository = mkdtempSync(join(tmpdir(), "rickgent-omnigent-inventory-"));
    const git = (args: string[]): string => execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
    try {
      git(["init", "-q"]);
      mkdirSync(join(repository, "package", "resources"), { recursive: true });
      mkdirSync(join(repository, "examples", "demo"), { recursive: true });
      writeFileSync(join(repository, "package", "__init__.py"), "package\n");
      writeFileSync(join(repository, "examples", "demo", "value.txt"), "bound target\n");
      symlinkSync("../../examples/demo", join(repository, "package", "resources", "demo"));
      git(["add", "."]);
      git(["-c", "user.name=Rickgent Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
      const commit = git(["rev-parse", "HEAD"]);
      const packageOid = git(["rev-parse", `${commit}:package/__init__.py`]);
      const targetOid = git(["rev-parse", `${commit}:examples/demo/value.txt`]);

      expect(committedDirectoryInventory(repository, commit, "package")).toEqual([
        ["__init__.py", packageOid],
        ["resources/demo/value.txt", targetOid],
      ]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("requires every preflight-hashed runtime resource to remain unchanged", () => {
    expect(() => requireUnchangedInstalledHandoff(installed, { ...installed })).not.toThrow();

    for (const key of Object.keys(installed) as Array<keyof typeof installed>) {
      expect(() => requireUnchangedInstalledHandoff(installed, {
        ...installed,
        [key]: "f".repeat(64),
      })).toThrow(`installed handoff ${key} changed after preflight`);
    }

    expect(() => requireUnchangedInstalledHandoff(installed, {
      ...installed,
      policy_sha256: undefined,
    })).toThrow("installed handoff policy_sha256 changed after preflight");

    expect(() => requireUnchangedInstalledHandoff(installed, {
      ...installed,
      python_sha256: undefined,
    })).toThrow("installed handoff python_sha256 changed after preflight");
  });

  it("binds the copied Omnigent package bytes to the recorded Git tree", () => {
    const oid = "a".repeat(40);
    const inventory = [
      ["__init__.py", "b".repeat(40)],
      ["runtime.py", "c".repeat(40)],
    ];
    expect(() => requireExactOmnigentHandoff(
      oid,
      oid,
      inventory,
      inventory.map((entry) => [...entry]),
    )).not.toThrow();

    expect(() => requireExactOmnigentHandoff(
      oid,
      oid,
      inventory,
      [...inventory, ["injected.py", "d".repeat(40)]],
    )).toThrow("installed Omnigent package does not match its bound Git identity");

    expect(() => requireExactOmnigentHandoff(
      oid,
      "e".repeat(40),
      inventory,
      inventory,
    )).toThrow("installed Omnigent package does not match its bound Git identity");
  });

  it("binds every installed policy module to the exact wheel inventory", () => {
    const inventory = [
      ["__init__.py", "a".repeat(40)],
      ["policy_event.py", "b".repeat(40)],
      ["scope.py", "c".repeat(40)],
    ];
    expect(() => requireExactInstalledPackage(
      inventory,
      inventory.map((entry) => [...entry]),
    )).not.toThrow();

    expect(() => requireExactInstalledPackage(
      inventory,
      inventory.map((entry) => (
        entry[0] === "scope.py" ? [entry[0], "d".repeat(40)] : [...entry]
      )),
    )).toThrow("installed policy package does not match the bound wheel");

    expect(() => requireExactInstalledPackage(
      inventory,
      inventory.slice(0, 2),
    )).toThrow("installed policy package does not match the bound wheel");
  });
});
