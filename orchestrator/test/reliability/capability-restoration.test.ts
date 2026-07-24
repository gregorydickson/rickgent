import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProofGatedCapabilityGate } from "../../src/capabilities/runtime-gate.js";

const repoRoot = join(import.meta.dirname, "../../..");
const proofRoot = mkdtempSync(join(tmpdir(), "rickgent-retained-proof-"));
for (const [source, target] of [
  ["artifacts/reliability/packed-install-summary.json", "packed-install-receipt.json"],
  ["artifacts/reliability/vertical-slice-receipt.json", "vertical-slice-receipt.json"],
  ["orchestrator/schemas/packed-install-receipt.schema.json", "packed-install-receipt.schema.json"],
  ["orchestrator/schemas/vertical-slice-receipt.schema.json", "vertical-slice-receipt.schema.json"],
]) cpSync(join(repoRoot, source), join(proofRoot, target));

const expected = {
  sourceGitOid: "d83405ee20e2cb8c5a9418c8913d646e876269bc",
  releaseId: "rickgent-trust-spine-release-v1",
  releaseSha256: "62a70c1eeaa21095a0bc57a01763a8b7ce5225e2a67a4aadacc841e0c0e4ff48",
  buildId: "a6525b76631e880f852d358bdf8a03b61f135fe4",
  buildSha256: "644e358326f475ae8e06958e5c7169bbc2fa3ff7b9b2b926d42917c2581c1a9e",
  npmArchiveSha256: "642512459c175bf0f566d37676512b77ae6e9b88f928d9ef239a56bf37d9edf7",
  wheelArchiveSha256: "0eb851486e8966c5509d53172b3491e6daa1bc836b9255c267863fa3d82e72f0",
  packedInstallReceiptSha256: "2dd3587120acf8f909fbbfb23607648225212ce7eb7ada28e8c219736a3db058",
  requiredCheckIds: [],
  now: new Date("2026-07-24T03:45:00.000Z"),
};

afterAll(() => rmSync(proofRoot, { recursive: true, force: true }));

describe("proof-root capability restoration", () => {
  it.each(["resume_retry", "cross_vendor_review", "automatic_delivery"] as const)(
    "restores %s from the retained index without caller-shaped expectations",
    (name) => {
      expect(() => createProofGatedCapabilityGate(repoRoot).require(name)).not.toThrow();
    },
  );

  it.each(["resume_retry", "cross_vendor_review", "automatic_delivery"] as const)(
    "restores %s only through the valid retained t38 proof",
    (name) => {
      expect(() => createProofGatedCapabilityGate(proofRoot, expected).require(name)).not.toThrow();
    },
  );

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

  it("keeps local reconciliation separate and globally unavailable capabilities contracted", () => {
    const contracted = createProofGatedCapabilityGate(null);
    expect(() => contracted.require("reconciliation")).not.toThrow();
    expect(() => contracted.require("parallel_dispatch")).toThrow(/RICKGENT_PARALLEL_DISPATCH_UNAVAILABLE/);
    expect(() => contracted.require("raw_shell")).toThrow(/RICKGENT_RAW_SHELL_UNAVAILABLE/);
  });
});
