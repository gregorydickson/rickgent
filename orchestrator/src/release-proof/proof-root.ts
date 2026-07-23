import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type ReceiptExpectations,
  type ReceiptValidationResult,
  validatePackedInstallReceipt,
  validateVerticalSliceReceipt,
} from "./receipt-validator.js";

export interface ProofRootValidation {
  readonly ok: boolean;
  readonly packed: ReceiptValidationResult;
  readonly vertical: ReceiptValidationResult;
  readonly diagnostics: readonly string[];
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function validateProofRoot(rootPath: string, expected: ReceiptExpectations): ProofRootValidation {
  try {
    const root = realpathSync(rootPath);
    const paths = {
      packed: realpathSync(join(root, "packed-install-receipt.json")),
      vertical: realpathSync(join(root, "vertical-slice-receipt.json")),
      packedSchema: realpathSync(join(root, "packed-install-receipt.schema.json")),
      verticalSchema: realpathSync(join(root, "vertical-slice-receipt.schema.json")),
    };
    if (!Object.values(paths).every((path) => contained(root, path))) throw new Error("proof-root symlink escape");
    const maxAge = expected.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - statSync(paths.vertical).mtimeMs > maxAge) throw new Error("proof-root receipt file is stale");
    const packedValue = JSON.parse(readFileSync(paths.packed, "utf8"));
    const packedSchema = JSON.parse(readFileSync(paths.packedSchema, "utf8")) as Record<string, unknown>;
    const verticalValue = JSON.parse(readFileSync(paths.vertical, "utf8"));
    const verticalSchema = JSON.parse(readFileSync(paths.verticalSchema, "utf8")) as Record<string, unknown>;
    const packed = validatePackedInstallReceipt(packedValue, packedSchema, expected);
    const packedDigest = typeof packedValue === "object" && packedValue !== null
      ? (packedValue as Record<string, unknown>)["digest"]
      : null;
    const vertical = validateVerticalSliceReceipt(verticalValue, verticalSchema, {
      ...expected,
      packedInstallReceiptSha256: typeof packedDigest === "string" ? packedDigest : "",
    });
    return Object.freeze({
      ok: packed.ok && vertical.ok,
      packed,
      vertical,
      diagnostics: Object.freeze([...packed.diagnostics, ...vertical.diagnostics].map((entry) => `${entry.code}: ${entry.detail}`)),
    });
  } catch (error) {
    const failed: ReceiptValidationResult = Object.freeze({
      ok: false,
      digest: null,
      diagnostics: Object.freeze([{ code: "PROOF_MALFORMED" as const, detail: error instanceof Error ? error.message : String(error) }]),
    });
    return Object.freeze({ ok: false, packed: failed, vertical: failed, diagnostics: Object.freeze([`PROOF_MALFORMED: ${error instanceof Error ? error.message : String(error)}`]) });
  }
}
