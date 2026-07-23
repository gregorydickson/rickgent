import { describe, expect, it } from "vitest";
import { createProofGatedCapabilityGate } from "../../src/capabilities/runtime-gate.js";

describe("proof-root capability restoration", () => {
  it.each(["resume_retry", "cross_vendor_review", "automatic_delivery"] as const)(
    "contracts %s without complete proof",
    (name) => {
      expect(() => createProofGatedCapabilityGate(null).require(name)).toThrow(/installed proof root did not validate/);
      expect(() => createProofGatedCapabilityGate("/missing-proof-root", {
        sourceGitOid: "a".repeat(40),
        releaseId: "release",
        releaseSha256: "b".repeat(64),
        buildId: "build",
        buildSha256: "c".repeat(64),
        npmArchiveSha256: "d".repeat(64),
        wheelArchiveSha256: "e".repeat(64),
        requiredCheckIds: ["installed_behavior"],
      }).require(name)).toThrow(/PROOF_MALFORMED/);
    },
  );

  it("does not accept caller-shaped validation objects as authority", () => {
    const shaped = { ok: true, diagnostics: [], packed: {}, vertical: {} };
    expect(() => createProofGatedCapabilityGate(shaped as unknown as string).require("resume_retry"))
      .toThrow(/proof root not selected/);
    expect(() => createProofGatedCapabilityGate(null).require("raw_shell")).toThrow();
  });
});
