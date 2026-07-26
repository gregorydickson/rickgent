import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import packedSchema from "../../schemas/packed-install-receipt.schema.json";
import verticalSchema from "../../schemas/vertical-slice-receipt.schema.json";
import {
  validatePackedInstallReceipt,
  validateVerticalSliceReceipt,
  type ReceiptExpectations,
} from "../../src/release-proof/receipt-validator.js";

const expected: ReceiptExpectations = {
  sourceGitOid: "a".repeat(40),
  releaseId: "release",
  releaseSha256: "b".repeat(64),
  buildId: "build",
  buildSha256: "c".repeat(64),
  npmArchiveSha256: "d".repeat(64),
  wheelArchiveSha256: "e".repeat(64),
  requiredCheckIds: ["installed_behavior"],
  packedInstallReceiptSha256: "f".repeat(64),
};

describe("strict receipt validation", () => {
  it("applies provider identity requirements only to the vertical receipt schema", () => {
    const script = resolve("scripts/validate-receipt-schema.mjs");
    const packed = execFileSync(process.execPath, [
      script,
      resolve("schemas/packed-install-receipt.schema.json"),
    ], { encoding: "utf8" });
    const vertical = execFileSync(process.execPath, [
      script,
      resolve("schemas/vertical-slice-receipt.schema.json"),
    ], { encoding: "utf8" });
    expect(packed).toContain("packed-install-receipt-v1");
    expect(vertical).toContain("vertical-slice-receipt-v1");
  });

  it("rejects malformed, skipped/infrastructure, fixture, and unredacted packed evidence", () => {
    const result = validatePackedInstallReceipt({
      schema_version: "1.0.0",
      checks: [{ check_id: "installed_behavior", outcome: "infrastructure_error", required: true, evidence_ids: ["fixture"] }],
      evidence: { contains_raw_secrets: false, items: [{ evidence_id: "fixture", classification: "fixture", sha256: "0".repeat(64), redaction: "public" }] },
      leaked: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz",
    }, packedSchema as Record<string, unknown>, expected);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "PROOF_SCHEMA_INVALID", "PROOF_DIGEST_MISMATCH", "PROOF_FIXTURE_FORBIDDEN", "PROOF_SECRET_PRESENT", "PROOF_CHECK_FAILED",
    ]));
  });

  it("rejects incomplete or stale vertical runs and wrong linkage", () => {
    const result = validateVerticalSliceReceipt({
      schema_version: "1.0.0",
      digest: "0".repeat(64),
      binding: {},
      evidence: { contains_raw_secrets: false, items: [] },
      checks: [],
      runs: [],
    }, verticalSchema as Record<string, unknown>, expected);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("PROOF_RUN_INCOMPLETE");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("PROOF_BINDING_MISMATCH");
  });

  it("rejects a build-identity-only vertical receipt without packed lifecycle invocation", () => {
    const receipt = JSON.parse(readFileSync(resolve("../artifacts/reliability/vertical-slice-receipt.json"), "utf8"));
    delete receipt.runs[0].installed_lifecycle;
    const binding = receipt.binding;
    const actualExpected: ReceiptExpectations = {
      sourceGitOid: binding.source_git_oid,
      releaseId: binding.release.id,
      releaseSha256: binding.release.sha256,
      buildId: binding.build.id,
      buildSha256: binding.build.sha256,
      npmArchiveSha256: binding.npm_archive_sha256,
      wheelArchiveSha256: binding.wheel_archive_sha256,
      packedInstallReceiptSha256: binding.packed_install_receipt_sha256,
      requiredCheckIds: ["protected-run-1", "protected-run-2"],
    };
    const result = validateVerticalSliceReceipt(
      receipt,
      verticalSchema as Record<string, unknown>,
      actualExpected,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "PROOF_SCHEMA_INVALID", "PROOF_RUN_INCOMPLETE",
    ]));
  });
});
