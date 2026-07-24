import { describe, expect, it } from "vitest";
import {
  requireExactOmnigentHandoff,
  requireExactInstalledPackage,
  requireUnchangedInstalledHandoff,
} from "../../scripts/run-protected-release.mjs";

const installed = {
  cli_sha256: "1".repeat(64),
  manager_sha256: "2".repeat(64),
  policy_inventory_sha256: "5".repeat(64),
  policy_sha256: "3".repeat(64),
  worker_sha256: "4".repeat(64),
};

describe("protected release installed handoff continuity", () => {
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
