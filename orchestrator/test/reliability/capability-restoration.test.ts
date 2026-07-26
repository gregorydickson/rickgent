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
  sourceGitOid: "dcf5d46ebbe7e6ce09495944eef1fcd355b54647",
  releaseId: "rickgent-trust-spine-release-v1",
  releaseSha256: "d0a97bd72502ea7af9554efa99be571424ad8be631ecb74dd2b22371c33a44e0",
  buildId: "dcf5d46ebbe7e6ce09495944eef1fcd355b54647",
  buildSha256: "aa3e843863f3ec7b6486513033d5eb42f7c7b2ac12166bce5770bb9a94fd52db",
  npmArchiveSha256: "e891c35e9ebefc3fb2d9a0e668d7c48c126c7e44445269ea555f172e93512109",
  wheelArchiveSha256: "b45febac86418cdb5ecde5b2188b100ce7f77d0e249f7cd791db8fd30e17e981",
  packedInstallReceiptSha256: "364a2575ffe4754c6e2b66320ffcdf6b82add56e4561d1cfe8ea86550ca09bdc",
  requiredCheckIds: [],
  now: new Date("2026-07-25T22:10:00.000Z"),
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
