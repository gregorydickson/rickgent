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
  sourceGitOid: "fdfa6f4fd61f0fc21583d6106535b4d198981fcd",
  releaseId: "rickgent-trust-spine-release-v1",
  releaseSha256: "d0a97bd72502ea7af9554efa99be571424ad8be631ecb74dd2b22371c33a44e0",
  buildId: "fdfa6f4fd61f0fc21583d6106535b4d198981fcd",
  buildSha256: "de94f6f126074eac9cc377d8bd982476f57ae363aeee3cceefd6a3448335b688",
  npmArchiveSha256: "1eceecb2c55f2f13f521c5464a26b27e8cce5fff44661321e344a47410577a34",
  wheelArchiveSha256: "0eb851486e8966c5509d53172b3491e6daa1bc836b9255c267863fa3d82e72f0",
  packedInstallReceiptSha256: "d650760e0c89b437bace6b27e17eceed45d4b71eb2cad163b9606faaf5b11215",
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
