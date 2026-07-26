import { readFileSync } from "node:fs";
import { receiptDigest } from "./canonical.js";
import { validateAgainstSchema } from "./schema-validator.js";

export type ProofDiagnosticCode =
  | "PROOF_MALFORMED"
  | "PROOF_SCHEMA_INVALID"
  | "PROOF_DIGEST_MISMATCH"
  | "PROOF_BINDING_MISMATCH"
  | "PROOF_FIXTURE_FORBIDDEN"
  | "PROOF_SECRET_PRESENT"
  | "PROOF_CHECK_INCOMPLETE"
  | "PROOF_CHECK_FAILED"
  | "PROOF_EVIDENCE_INCOMPLETE"
  | "PROOF_RUN_INCOMPLETE"
  | "PROOF_STALE";

export interface ProofDiagnostic {
  readonly code: ProofDiagnosticCode;
  readonly detail: string;
}

export interface ReceiptValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ProofDiagnostic[];
  readonly digest: string | null;
}

export interface ReceiptExpectations {
  readonly sourceGitOid: string;
  readonly releaseId: string;
  readonly releaseSha256: string;
  readonly buildId: string;
  readonly buildSha256: string;
  readonly npmArchiveSha256: string;
  readonly wheelArchiveSha256: string;
  readonly requiredCheckIds: readonly string[];
  readonly requiredCorpusIds?: readonly string[];
  readonly packedInstallReceiptSha256?: string;
  readonly requiredProviderPair?: {
    readonly implementation: { readonly adapter: string; readonly model: string; readonly provider: string };
    readonly review: { readonly adapter: string; readonly model: string; readonly provider: string };
  };
  readonly now?: Date;
  readonly maxAgeMs?: number;
}

function parse(value: unknown, diagnostics: ProofDiagnostic[]): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      diagnostics.push({ code: "PROOF_MALFORMED", detail: "receipt is not valid JSON" });
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({ code: "PROOF_MALFORMED", detail: "receipt must be an object" });
    return null;
  }
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function containsSecret(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return /(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization["']?\s*:\s*["']?(?:bearer|token))/i.test(serialized);
}

function commonSemanticChecks(
  receipt: Record<string, unknown>,
  expected: ReceiptExpectations,
  diagnostics: ProofDiagnostic[],
): void {
  if (receipt["digest"] !== receiptDigest(receipt)) diagnostics.push({ code: "PROOF_DIGEST_MISMATCH", detail: "canonical digest mismatch" });
  const binding = record(receipt["binding"]);
  const release = record(binding["release"]);
  const build = record(binding["build"]);
  const mismatch =
    binding["source_git_oid"] !== expected.sourceGitOid ||
    release["id"] !== expected.releaseId ||
    release["sha256"] !== expected.releaseSha256 ||
    build["id"] !== expected.buildId ||
    build["sha256"] !== expected.buildSha256;
  if (mismatch) diagnostics.push({ code: "PROOF_BINDING_MISMATCH", detail: "release/build/source binding mismatch" });
  const corpora = array(binding["corpora"]).map(record);
  for (const id of expected.requiredCorpusIds ?? []) {
    if (!corpora.some((corpus) => corpus["id"] === id)) diagnostics.push({ code: "PROOF_BINDING_MISMATCH", detail: `required corpus missing: ${id}` });
  }
  const evidence = record(receipt["evidence"]);
  const items = array(evidence["items"]).map(record);
  if (evidence["contains_raw_secrets"] !== false || containsSecret(receipt)) diagnostics.push({ code: "PROOF_SECRET_PRESENT", detail: "raw secret evidence is forbidden" });
  if (items.some((item) => item["classification"] === "fixture")) diagnostics.push({ code: "PROOF_FIXTURE_FORBIDDEN", detail: "fixture evidence cannot restore production capability" });
  const ids = new Set(items.map((item) => item["evidence_id"]).filter((id): id is string => typeof id === "string"));
  const checks = array(receipt["checks"]).map(record);
  const checkIds = new Set(checks.map((check) => check["check_id"]));
  for (const required of expected.requiredCheckIds) {
    if (!checkIds.has(required)) diagnostics.push({ code: "PROOF_CHECK_INCOMPLETE", detail: `required check missing: ${required}` });
  }
  for (const check of checks) {
    if (check["required"] !== true || check["outcome"] !== "pass") diagnostics.push({ code: "PROOF_CHECK_FAILED", detail: `non-passing required check: ${String(check["check_id"])}` });
    for (const evidenceId of array(check["evidence_ids"])) {
      if (typeof evidenceId !== "string" || !ids.has(evidenceId)) diagnostics.push({ code: "PROOF_EVIDENCE_INCOMPLETE", detail: `unknown check evidence: ${String(evidenceId)}` });
    }
  }
}

function finish(receipt: Record<string, unknown> | null, diagnostics: ProofDiagnostic[]): ReceiptValidationResult {
  return Object.freeze({
    ok: receipt !== null && diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
    digest: receipt === null ? null : receiptDigest(receipt),
  });
}

export function validatePackedInstallReceipt(
  value: unknown,
  schema: Record<string, unknown>,
  expected: ReceiptExpectations,
): ReceiptValidationResult {
  const diagnostics: ProofDiagnostic[] = [];
  const receipt = parse(value, diagnostics);
  if (receipt === null) return finish(null, diagnostics);
  const schemaErrors = validateAgainstSchema(receipt, schema);
  if (schemaErrors.length > 0) diagnostics.push({ code: "PROOF_SCHEMA_INVALID", detail: schemaErrors.join("; ") });
  commonSemanticChecks(receipt, expected, diagnostics);
  const archives = array(record(receipt["binding"])["archives"]).map(record);
  if (
    archives.find((archive) => archive["kind"] === "npm_tarball")?.["sha256"] !== expected.npmArchiveSha256 ||
    archives.find((archive) => archive["kind"] === "python_wheel")?.["sha256"] !== expected.wheelArchiveSha256
  ) diagnostics.push({ code: "PROOF_BINDING_MISMATCH", detail: "archive binding mismatch" });
  return finish(receipt, diagnostics);
}

export function validateVerticalSliceReceipt(
  value: unknown,
  schema: Record<string, unknown>,
  expected: ReceiptExpectations,
): ReceiptValidationResult {
  const diagnostics: ProofDiagnostic[] = [];
  const receipt = parse(value, diagnostics);
  if (receipt === null) return finish(null, diagnostics);
  const schemaErrors = validateAgainstSchema(receipt, schema);
  if (schemaErrors.length > 0) diagnostics.push({ code: "PROOF_SCHEMA_INVALID", detail: schemaErrors.join("; ") });
  commonSemanticChecks(receipt, expected, diagnostics);
  const binding = record(receipt["binding"]);
  if (
    binding["npm_archive_sha256"] !== expected.npmArchiveSha256 ||
    binding["wheel_archive_sha256"] !== expected.wheelArchiveSha256 ||
    binding["packed_install_receipt_sha256"] !== expected.packedInstallReceiptSha256
  ) diagnostics.push({ code: "PROOF_BINDING_MISMATCH", detail: "archive or packed-receipt linkage mismatch" });
  const runs = array(receipt["runs"]).map(record);
  const evidence = record(receipt["evidence"]);
  const evidenceItems = array(evidence["items"]).map(record);
  const evidenceIds = new Set(evidenceItems.map((item) => item["evidence_id"]));
  if (
    evidenceItems.some((item) => item["authenticated"] !== true || item["classification"] !== "live") ||
    evidenceIds.size !== evidenceItems.length
  ) diagnostics.push({ code: "PROOF_EVIDENCE_INCOMPLETE", detail: "vertical evidence must be unique authenticated live evidence" });
  if (
    runs.length !== 2 ||
    new Set(runs.map((run) => run["run_id"])).size !== 2 ||
    new Set(runs.map((run) => run["persistent_state_id"])).size !== 2
  ) diagnostics.push({ code: "PROOF_RUN_INCOMPLETE", detail: "exactly two independent runs and state roots are required" });
  const cutoff = (expected.now ?? new Date()).getTime() - (expected.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000);
  for (const run of runs) {
    const attempts = array(run["attempts"]).map(record);
    if (
      attempts.length !== 2 ||
      attempts[0]?.["phase"] !== "crash" ||
      attempts[0]?.["death_observed"] !== true ||
      attempts[1]?.["phase"] !== "resume" ||
      attempts[1]?.["death_observed"] !== false ||
      attempts[0]?.["process_id"] === attempts[1]?.["process_id"] ||
      attempts[0]?.["process_group_id"] === attempts[1]?.["process_group_id"]
    ) diagnostics.push({ code: "PROOF_RUN_INCOMPLETE", detail: `crash/resume topology incomplete: ${String(run["run_id"])}` });
    const observations = array(run["model_observations"]).map(record);
    const byRole = new Map(observations.map((item) => [item["role"], item]));
    const pair = expected.requiredProviderPair;
    if (
      run["lifecycle_complete"] !== true ||
      run["containment_passed"] !== true ||
      observations.length !== 2 ||
      !observations.some((item) => item["role"] === "implementation") ||
      !observations.some((item) => item["role"] === "review") ||
      observations.some((item) =>
        item["requested_model"] !== item["invoked_model"] ||
        item["requested_model"] !== item["observed_model"] ||
        typeof item["observed_canonical_model"] !== "string" ||
        item["observed_canonical_model"] === "" ||
        typeof item["observed_provider"] !== "string" ||
        item["observed_provider"] === "" ||
        typeof item["provider_process_id"] !== "number" ||
        item["provider_process_id"] <= 0 ||
        typeof item["identity_sha256"] !== "string" ||
        !/^[0-9a-f]{64}$/.test(item["identity_sha256"]) ||
        typeof item["conversation_id"] !== "string" ||
        item["conversation_id"] === ""
      ) ||
      (pair !== undefined && (
        byRole.get("implementation")?.["adapter"] !== pair.implementation.adapter ||
        byRole.get("implementation")?.["observed_model"] !== pair.implementation.model ||
        byRole.get("implementation")?.["canonical_provider"] !== pair.implementation.provider ||
        byRole.get("review")?.["adapter"] !== pair.review.adapter ||
        byRole.get("review")?.["observed_model"] !== pair.review.model ||
        byRole.get("review")?.["canonical_provider"] !== pair.review.provider
      ))
    ) diagnostics.push({ code: "PROOF_RUN_INCOMPLETE", detail: `production identity evidence incomplete: ${String(run["run_id"])}` });
    const delivery = record(run["delivery"]);
    const cleanup = record(run["cleanup"]);
    if (
      delivery["observed_branch_oid"] !== delivery["pull_request_head_oid"] ||
      delivery["observed_branch_oid"] !== delivery["delivery_oid"] ||
      delivery["duplicate_side_effects"] !== false ||
      cleanup["owned_pull_request_closed"] !== true ||
      cleanup["owned_branch_absent_on_requery"] !== true ||
      cleanup["repository_preserved"] !== true ||
      cleanup["branch_compare_before_delete_oid"] !== delivery["delivery_oid"]
    ) diagnostics.push({ code: "PROOF_RUN_INCOMPLETE", detail: `delivery identity incomplete: ${String(run["run_id"])}` });
    const runNumber = String(run["run_id"]).replace(/^protected-/, "");
    if (pair !== undefined) {
      for (const id of [
        `run:${runNumber}:identity:openai`,
        `run:${runNumber}:identity:anthropic`,
        ...[
          "native-policy", "ownership", "worktree", "ref", "index", "lease", "process",
          "scope-clean-commit", "review", "remediation", "gate", "oracle", "cleanup",
          "push", "pull-request", "delivery-oid",
        ].map((phase) => `run:${runNumber}:phase:${phase}`),
      ]) {
        if (!evidenceIds.has(id)) {
          diagnostics.push({ code: "PROOF_EVIDENCE_INCOMPLETE", detail: `required protected evidence missing: ${id}` });
        }
      }
    }
    const check = array(receipt["checks"]).map(record)
      .find((item) => item["check_id"] === `protected-run-${runNumber}`);
    const referenced = new Set(array(check?.["evidence_ids"]));
    for (const item of evidenceItems.filter((entry) =>
      typeof entry["evidence_id"] === "string" &&
      entry["evidence_id"].startsWith(`run:${runNumber}:`)
    )) {
      if (!referenced.has(item["evidence_id"])) {
        diagnostics.push({ code: "PROOF_EVIDENCE_INCOMPLETE", detail: `run evidence is not closed by its check: ${String(item["evidence_id"])}` });
      }
    }
    const started = attempts[0]?.["started_at"];
    if (typeof started !== "string" || Date.parse(started) < cutoff) diagnostics.push({ code: "PROOF_STALE", detail: `run is stale: ${String(run["run_id"])}` });
  }
  const aggregateCleanup = record(receipt["cleanup"]);
  for (const kind of ["success_path", "failure_path"]) {
    const item = record(aggregateCleanup[kind]);
    if (item["completed"] !== true || item["independently_requeried"] !== true) {
      diagnostics.push({ code: "PROOF_RUN_INCOMPLETE", detail: `${kind} cleanup is incomplete` });
    }
  }
  if (aggregateCleanup["repository_deleted"] !== false) {
    diagnostics.push({ code: "PROOF_RUN_INCOMPLETE", detail: "protected repository preservation is incomplete" });
  }
  return finish(receipt, diagnostics);
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
