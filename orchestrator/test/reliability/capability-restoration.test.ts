import { describe, expect, it } from "vitest";
import { createProofGatedCapabilityGate } from "../../src/capabilities/runtime-gate.js";
import type { ProofRootValidation } from "../../src/release-proof/proof-root.js";

describe("proof-root capability restoration", () => {
  it.each(["resume_retry", "cross_vendor_review", "automatic_delivery"] as const)(
    "contracts %s without complete proof",
    (name) => {
      expect(() => createProofGatedCapabilityGate(null).require(name)).toThrow(/installed proof root did not validate/);
      const invalid = {
        ok: false,
        diagnostics: ["PROOF_STALE: stale"],
        packed: { ok: false, diagnostics: [], digest: null },
        vertical: { ok: false, diagnostics: [], digest: null },
      } satisfies ProofRootValidation;
      expect(() => createProofGatedCapabilityGate(invalid).require(name)).toThrow(/PROOF_STALE/);
    },
  );

  it("restores only after both strict receipts validate", () => {
    const valid = {
      ok: true,
      diagnostics: [],
      packed: { ok: true, diagnostics: [], digest: "a".repeat(64) },
      vertical: { ok: true, diagnostics: [], digest: "b".repeat(64) },
    } satisfies ProofRootValidation;
    expect(() => createProofGatedCapabilityGate(valid).require("resume_retry")).not.toThrow();
    expect(() => createProofGatedCapabilityGate(valid).require("cross_vendor_review")).not.toThrow();
    expect(() => createProofGatedCapabilityGate(valid).require("automatic_delivery")).not.toThrow();
    expect(() => createProofGatedCapabilityGate(valid).require("raw_shell")).toThrow();
  });
});
