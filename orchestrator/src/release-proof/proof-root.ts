import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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

type JsonRecord = Record<string, unknown>;

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function indexedPath(root: string, value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.startsWith("/")) {
    throw new Error(`proof index ${label} path is invalid`);
  }
  const path = realpathSync(join(root, value));
  if (!contained(root, path)) throw new Error(`proof index ${label} escapes proof root`);
  return path;
}

function indexedProofRoot(root: string): {
  readonly paths: {
    readonly packed: string;
    readonly vertical: string;
    readonly packedSchema: string;
    readonly verticalSchema: string;
  };
  readonly expected: ReceiptExpectations;
} | null {
  const indexCandidates = [
    join(root, "release-proof-index.json"),
    join(root, "artifacts", "reliability", "release-proof-index.json"),
  ];
  const indexPath = indexCandidates.find(existsSync);
  if (indexPath === undefined) return null;
  const index = record(JSON.parse(readFileSync(realpathSync(indexPath), "utf8")));
  if (
    index["schema_version"] !== 1 ||
    index["proof_profile"] !== "installed_t38_retained_proof_v1" ||
    index["status"] !== "valid"
  ) throw new Error("proof index profile or status is invalid");
  const receipts = record(index["receipts"]);
  const packedIndex = record(receipts["packed"]);
  const verticalIndex = record(receipts["vertical"]);
  const bindings = record(index["bindings"]);
  const schemas = record(bindings["schemas"]);
  const packedSchemaIndex = record(schemas["packed"]);
  const verticalSchemaIndex = record(schemas["vertical"]);
  const paths = {
    packed: indexedPath(root, packedIndex["path"], "packed receipt"),
    vertical: indexedPath(root, verticalIndex["path"], "vertical receipt"),
    packedSchema: indexedPath(root, packedSchemaIndex["path"], "packed schema"),
    verticalSchema: indexedPath(root, verticalSchemaIndex["path"], "vertical schema"),
  };
  for (const [label, path, expectedDigest] of [
    ["packed receipt", paths.packed, packedIndex["file_sha256"]],
    ["vertical receipt", paths.vertical, verticalIndex["file_sha256"]],
    ["packed schema", paths.packedSchema, packedSchemaIndex["sha256"]],
    ["vertical schema", paths.verticalSchema, verticalSchemaIndex["sha256"]],
  ] as const) {
    if (typeof expectedDigest !== "string" || sha256(readFileSync(path)) !== expectedDigest) {
      throw new Error(`proof index ${label} byte digest mismatch`);
    }
  }
  const release = record(bindings["release"]);
  const build = record(bindings["build"]);
  const archives = array(bindings["archives"]).map(record);
  const npm = archives.find((entry) => entry["kind"] === "npm_tarball");
  const wheel = archives.find((entry) => entry["kind"] === "python_wheel");
  const execution = record(index["execution"]);
  const runIds = array(execution["run_ids"]).filter((value): value is string => typeof value === "string");
  const providerPair = record(execution["provider_pair"]);
  const implementation = record(providerPair["implementation"]);
  const review = record(providerPair["review"]);
  const corpora = array(bindings["corpora"]).map(record);
  const expected: ReceiptExpectations = {
    sourceGitOid: String(bindings["source_git_oid"] ?? ""),
    releaseId: String(release["id"] ?? ""),
    releaseSha256: String(release["sha256"] ?? ""),
    buildId: String(build["id"] ?? ""),
    buildSha256: String(build["sha256"] ?? ""),
    npmArchiveSha256: String(npm?.["sha256"] ?? ""),
    wheelArchiveSha256: String(wheel?.["sha256"] ?? ""),
    packedInstallReceiptSha256: String(packedIndex["digest"] ?? ""),
    requiredCheckIds: runIds.map((runId) => `protected-run-${runId.replace(/^protected-/, "")}`),
    requiredCorpusIds: corpora
      .map((entry) => entry["id"])
      .filter((value): value is string => typeof value === "string"),
    requiredProviderPair: {
      implementation: {
        adapter: String(implementation["adapter"] ?? ""),
        model: String(implementation["model"] ?? ""),
      },
      review: {
        adapter: String(review["adapter"] ?? ""),
        model: String(review["model"] ?? ""),
      },
    },
  };
  return { paths, expected };
}

export function validateProofRoot(rootPath: string, suppliedExpected?: ReceiptExpectations): ProofRootValidation {
  try {
    const root = realpathSync(rootPath);
    const indexed = indexedProofRoot(root);
    const expected = suppliedExpected ?? indexed?.expected;
    if (expected === undefined) throw new Error("proof index or explicit expectations are required");
    const paths = indexed?.paths ?? {
      packed: realpathSync(join(root, "packed-install-receipt.json")),
      vertical: realpathSync(join(root, "vertical-slice-receipt.json")),
      packedSchema: realpathSync(join(root, "packed-install-receipt.schema.json")),
      verticalSchema: realpathSync(join(root, "vertical-slice-receipt.schema.json")),
    };
    if (!Object.values(paths).every((path) => contained(root, path))) throw new Error("proof-root symlink escape");
    const maxAge = expected.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    if (
      Date.now() - statSync(paths.vertical).mtimeMs > maxAge ||
      Date.now() - statSync(paths.packed).mtimeMs > maxAge
    ) throw new Error("proof-root receipt file is stale");
    const packedValue = JSON.parse(readFileSync(paths.packed, "utf8"));
    const packedSchema = JSON.parse(readFileSync(paths.packedSchema, "utf8")) as Record<string, unknown>;
    const verticalValue = JSON.parse(readFileSync(paths.vertical, "utf8"));
    const verticalSchema = JSON.parse(readFileSync(paths.verticalSchema, "utf8")) as Record<string, unknown>;
    const packed = validatePackedInstallReceipt(packedValue, packedSchema, {
      ...expected,
      requiredCheckIds: [],
      requiredCorpusIds: [],
    });
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
