import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

describe("authority-bearing protected release (explicit runner only)", () => {
  it("is reachable only with the protected authority boundary", () => {
    if (process.env["RICKGENT_PROTECTED_AUTHORITY"] !== "I_ACCEPT_REMOTE_MUTATION") {
      throw new Error("protected live test requires RICKGENT_PROTECTED_AUTHORITY");
    }
    const result = spawnSync(process.execPath, ["scripts/run-protected-release.mjs"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});
