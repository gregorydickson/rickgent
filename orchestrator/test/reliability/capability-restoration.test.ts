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
  sourceGitOid: "a1fe32a3dcb1950a61db82e5985ac141f4024583",
  releaseId: "rickgent-trust-spine-release-v1",
  releaseSha256: "d0a97bd72502ea7af9554efa99be571424ad8be631ecb74dd2b22371c33a44e0",
  buildId: "a1fe32a3dcb1950a61db82e5985ac141f4024583",
  buildSha256: "f5ccad7188dba9ec12d8258806857f800781b27a29166a07cc1dae49864c284a",
  npmArchiveSha256: "641ef9a04f1eb659ba3049370415ce1bfdc5e06e941d7bbec3d9601e362e79d1",
  wheelArchiveSha256: "ecfb65dad232096eb1778e403f1dee6bab7e0d9d799824642da2698c7af109be",
  packedInstallReceiptSha256: "ac32d6f1845b7c2fae7f0be3f003af4a2257587b1fcb8f477948c6ad0281d58a",
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
