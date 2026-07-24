import { describe, expect, it } from "vitest";
import { requireUnchangedInstalledHandoff } from "../../scripts/run-protected-release.mjs";

const installed = {
  cli_sha256: "1".repeat(64),
  manager_sha256: "2".repeat(64),
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
});
