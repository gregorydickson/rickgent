#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA256 = /^[0-9a-f]{64}$/;
const EXPECTED = Object.freeze({
  packed_file_sha256: "66a73f7ae98c158c3af08b73fa832591b3db9fd7ab2f710b9ce19538e4f57994",
  packed_digest: "364a2575ffe4754c6e2b66320ffcdf6b82add56e4561d1cfe8ea86550ca09bdc",
  vertical_file_sha256: "5ef541dcbd3cf466daad5b1f0eb6c2315a360fe8ea0ab0ece470b3b472f4a9bf",
  vertical_digest: "93a40ab2193bbe78ad2c6f832f835ed55f9e91c5a042abc50f5e8b28c014d903",
  packed_schema_sha256: "772ce8915d06869a181c49c2c636038f9e3adeda816d17f7bd1e5ee455f1aecb",
  vertical_schema_sha256: "07e4a1f5fdf0d7f3e8c2c005681ea6c7d8bf78261dd42993869ff0cba573f1b8",
  preflight_sha256: "2f22219e0aee989a12b7747f50a5c065a0167b18ee7035b854b559f969f59368",
  diagnostics_sha256: "2e9daa0a9286511e401ac169102267a78c5ec23ae116a891f7648cb36c58a12c",
  release_sha256: "d0a97bd72502ea7af9554efa99be571424ad8be631ecb74dd2b22371c33a44e0",
  t37_completion_commit: "d4bed226c02e90fae9d47f44b3772194942f049e",
  t38_completion_marker: "640d78eebdfbf76a52cb2121ff205bdb4e4300be",
  retained_receipt_commit: "640d78eebdfbf76a52cb2121ff205bdb4e4300be",
});

const PATHS = Object.freeze({
  packed: "artifacts/reliability/packed-install-summary.json",
  packedSidecar: "artifacts/reliability/packed-install-summary.sha256",
  vertical: "artifacts/reliability/vertical-slice-receipt.json",
  verticalSidecar: "artifacts/reliability/vertical-slice-receipt.sha256",
  preflight: "artifacts/reliability/protected-release-preflight.json",
  diagnostics: "artifacts/reliability/vertical-slice-failure-diagnostics.json",
  packedSchema: "orchestrator/schemas/packed-install-receipt.schema.json",
  verticalSchema: "orchestrator/schemas/vertical-slice-receipt.schema.json",
  release: "release-manifest.json",
});

export class ProofClaimError extends Error {
  constructor(claim, detail) {
    super(`${claim}: ${detail}`);
    this.name = "ProofClaimError";
    this.claim = claim;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function claim(condition, name, detail) {
  if (!condition) throw new ProofClaimError(name, detail);
}

function same(actual, expected, name) {
  claim(canonical(actual) === canonical(expected), name, "does not match retained authority");
}

function read(root, relative) {
  const path = join(root, relative);
  claim(existsSync(path), `path.${relative}`, "required retained authority is missing");
  return readFileSync(path);
}

function parse(root, relative) {
  const bytes = read(root, relative);
  try {
    return { bytes, value: JSON.parse(bytes) };
  } catch {
    throw new ProofClaimError(`json.${relative}`, "retained authority is malformed");
  }
}

function validateCanonicalReceipt(bytes, receipt, expectedDigest, claimPrefix) {
  claim(receipt.schema_version === "1.0.0", `${claimPrefix}.schema_version`, "must be 1.0.0");
  claim(receipt.redaction_version === "rickgent-redaction-v1", `${claimPrefix}.redaction`, "unexpected redaction contract");
  claim(receipt.canonicalization === "rickgent-canonical-json-v1", `${claimPrefix}.canonicalization`, "unexpected canonicalization contract");
  const { digest, ...unsigned } = receipt;
  same(digest, expectedDigest, `${claimPrefix}.logical_digest`);
  same(digest, sha256(canonical(unsigned)), `${claimPrefix}.canonical_digest`);
  same(bytes.toString("utf8"), `${canonical(receipt)}\n`, `${claimPrefix}.canonical_bytes`);
  if (claimPrefix === "vertical_receipt") {
    claim(receipt.evidence?.fixture_substitution === false, `${claimPrefix}.fixture_substitution`, "fixture evidence cannot activate capabilities");
  }
  claim(receipt.evidence?.contains_raw_secrets === false, `${claimPrefix}.redaction`, "raw secrets are forbidden");
}

export function validateProofAuthorities({
  packed,
  packedBytes,
  vertical,
  verticalBytes,
  preflight,
  diagnostics,
  fileDigests,
  sidecars,
  now = Date.now(),
  expected = EXPECTED,
  enforceExactBytes = true,
}) {
  validateCanonicalReceipt(packedBytes, packed, expected.packed_digest, "packed_receipt");
  validateCanonicalReceipt(verticalBytes, vertical, expected.vertical_digest, "vertical_receipt");
  if (enforceExactBytes) {
    same(sha256(packedBytes), expected.packed_file_sha256, "packed_receipt.file_digest");
    same(sha256(verticalBytes), expected.vertical_file_sha256, "vertical_receipt.file_digest");
    same(sidecars.packed, `${expected.packed_digest}  packed-install-summary.json\n`, "packed_receipt.sidecar");
    same(sidecars.vertical, `${expected.vertical_file_sha256}  vertical-slice-receipt.json\n`, "vertical_receipt.sidecar");
  }
  for (const [name, expectedDigest] of Object.entries({
    packed_schema_sha256: expected.packed_schema_sha256,
    vertical_schema_sha256: expected.vertical_schema_sha256,
    preflight_sha256: expected.preflight_sha256,
    diagnostics_sha256: expected.diagnostics_sha256,
    release_sha256: expected.release_sha256,
  })) same(fileDigests[name], expectedDigest, `binding.${name}`);

  same(packed.proof_version, "packed-install-proof-v1", "packed_receipt.proof_version");
  same(vertical.proof_version, "vertical-slice-proof-v1", "vertical_receipt.proof_version");
  same(vertical.binding?.packed_install_receipt_sha256, packed.digest, "binding.packed_receipt");
  same(vertical.binding?.build, packed.binding?.build, "binding.build");
  same(vertical.binding?.npm_archive_sha256, packed.binding?.archives?.find((x) => x.kind === "npm_tarball")?.sha256, "binding.npm_archive");
  same(vertical.binding?.wheel_archive_sha256, packed.binding?.archives?.find((x) => x.kind === "python_wheel")?.sha256, "binding.wheel_archive");
  same(packed.binding?.release?.sha256, expected.release_sha256, "binding.release");

  const verticalEvidence = new Map(
    (vertical.evidence?.items ?? []).map((item) => [item.evidence_id, item]),
  );
  for (const run of vertical.runs ?? []) {
    const runNumber = run.run_id?.replace("protected-", "");
    for (const provider of ["openai", "anthropic"]) {
      const identity = verticalEvidence.get(`run:${runNumber}:identity:${provider}`);
      claim(identity?.authenticated === true && identity?.classification === "live",
        `provider_pair.${run.run_id}.${provider}_identity`, "authenticated provider identity evidence is missing");
    }
  }

  for (const receipt of [packed, vertical]) {
    const prefix = receipt === packed ? "packed_receipt" : "vertical_receipt";
    claim(Array.isArray(receipt.checks) && receipt.checks.length > 0, `${prefix}.checks`, "required checks are missing");
    claim(receipt.checks.every((x) => x.required === true && x.outcome === "pass"), `${prefix}.checks`, "every required check must pass");
    const ids = new Set((receipt.evidence?.items ?? []).map((x) => x.evidence_id));
    claim(ids.size === receipt.evidence?.items?.length, `${prefix}.evidence`, "evidence identities must be unique");
    claim(receipt.evidence.items.every((x) => x.classification === "live"
      && (prefix === "packed_receipt" || x.authenticated === true)),
      `${prefix}.evidence.classification`, "all retained evidence must be authenticated live evidence");
    for (const check of receipt.checks) {
      claim(check.evidence_ids?.every((id) => ids.has(id)), `${prefix}.evidence.${check.check_id}`, "check evidence closure is incomplete");
    }
  }

  same(preflight.status, "accepted", "preflight.status");
  same(preflight.mode, "preflight_only", "preflight.mode");
  same(preflight.binding?.packed_receipt_sha256, packed.digest, "preflight.packed_receipt");
  same(preflight.binding?.build_id, packed.binding?.build?.id, "preflight.build");
  same(diagnostics.status, "clear", "diagnostics.status");
  same(diagnostics.codes, [], "diagnostics.codes");
  same(diagnostics.infrastructure_errors, [], "diagnostics.infrastructure_errors");
  same(diagnostics.skipped_required, [], "diagnostics.skipped_required");

  claim(Array.isArray(vertical.runs) && vertical.runs.length === 2, "runs.count", "exactly two protected runs are required");
  claim(new Set(vertical.runs.map((run) => run.run_id)).size === 2, "runs.identity", "run identities must be distinct");
  claim(new Set(vertical.runs.map((run) => run.persistent_state_id)).size === 2, "runs.state_identity", "persistent state identities must be distinct");
  for (const run of vertical.runs) {
    claim(run.lifecycle_complete === true, `lifecycle.${run.run_id}`, "lifecycle must be complete");
    claim(run.cleanup?.owned_branch_absent_on_requery === true, `cleanup.${run.run_id}.branch`, "branch cleanup was not independently verified");
    claim(run.cleanup?.owned_pull_request_closed === true, `cleanup.${run.run_id}.pull_request`, "pull request cleanup failed");
    claim(run.cleanup?.repository_preserved === true, `cleanup.${run.run_id}.repository`, "disposable repository must be preserved");
    same(run.delivery?.delivery_oid, run.delivery?.observed_branch_oid, `delivery.${run.run_id}.branch_oid`);
    same(run.delivery?.delivery_oid, run.delivery?.pull_request_head_oid, `delivery.${run.run_id}.pr_oid`);
    same(run.delivery?.duplicate_side_effects, false, `delivery.${run.run_id}.idempotence`);
    const failureCleanup = run.cleanup?.failure_path;
    // Legacy retained v1 proofs predate the exact failure-path projection.
    // New receipts require it in JSON Schema and validate it here whenever
    // present, without rewriting historical signed evidence.
    if (failureCleanup !== undefined) {
      same(failureCleanup.run_id, run.run_id, `cleanup.${run.run_id}.failure_run`);
      same(failureCleanup.base_branch, vertical.repository?.base_branch, `cleanup.${run.run_id}.failure_base`);
      same(
        failureCleanup.branch,
        `${vertical.repository?.owned_branch_prefix}/${run.run_id}-failure-cleanup`,
        `cleanup.${run.run_id}.failure_branch`,
      );
      same(failureCleanup.delivery_oid, run.delivery?.delivery_oid, `cleanup.${run.run_id}.failure_oid`);
      same(
        failureCleanup.pull_request_head_oid,
        run.delivery?.delivery_oid,
        `cleanup.${run.run_id}.failure_pr_oid`,
      );
      claim(
        /^[1-9][0-9]*$/.test(failureCleanup.pull_request_id ?? ""),
        `cleanup.${run.run_id}.failure_pr`,
        "failure cleanup pull request identity is invalid",
      );
      claim(
        failureCleanup.owned_branch_absent_on_requery === true
          && failureCleanup.owned_pull_request_closed === true
          && failureCleanup.repository_preserved === true,
        `cleanup.${run.run_id}.failure_observation`,
        "failure cleanup was not independently observed",
      );
    }
    const observations = Object.fromEntries((run.model_observations ?? []).map((x) => [x.role, x]));
    same(
      [
        observations.implementation?.adapter,
        observations.implementation?.canonical_provider,
        observations.implementation?.invoked_model,
        observations.implementation?.observed_model,
        observations.implementation?.observed_canonical_model,
        observations.implementation?.observed_provider,
      ],
      ["codex-cli", "openai", "gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol", "openai"],
      `provider_pair.${run.run_id}.implementation`,
    );
    same(
      [
        observations.review?.adapter,
        observations.review?.canonical_provider,
        observations.review?.invoked_model,
        observations.review?.observed_model,
        observations.review?.observed_canonical_model,
        observations.review?.observed_provider,
      ],
      ["claude-code", "anthropic", "claude-opus-4-8[1m]", "claude-opus-4-8[1m]", "claude-opus-4-8", "firstParty"],
      `provider_pair.${run.run_id}.review`,
    );
    for (const [role, observation] of Object.entries(observations)) {
      claim(
        Number.isSafeInteger(observation?.provider_process_id)
          && observation.provider_process_id > 0
          && SHA256.test(observation?.identity_sha256 ?? ""),
        `provider_pair.${run.run_id}.${role}_runtime_identity`,
        "provider runtime process or identity digest is invalid",
      );
    }
  }
  for (const path of ["success_path", "failure_path"]) {
    claim(vertical.cleanup?.[path]?.completed === true, `cleanup.aggregate.${path}`, "cleanup did not complete");
    claim(vertical.cleanup?.[path]?.independently_requeried === true, `cleanup.aggregate.${path}`, "cleanup was not independently requeried");
  }
  claim(vertical.cleanup?.repository_deleted === false, "cleanup.aggregate.repository", "pre-existing repository must not be deleted");

  const timestamps = vertical.runs.flatMap((run) => run.attempts ?? []).map((x) => Date.parse(x.ended_at)).filter(Number.isFinite);
  claim(timestamps.length === 4, "staleness.timestamps", "all attempt terminal timestamps are required");
  claim(now + 24 * 60 * 60 * 1000 >= Math.max(...timestamps), "staleness.clock", "proof terminal time is implausibly in the future");
  claim(now - Math.min(...timestamps) <= 7 * 24 * 60 * 60 * 1000, "staleness.age", "retained proof is older than seven days");
  return true;
}

export function buildProofIndex(root = DEFAULT_ROOT) {
  const packedResult = parse(root, PATHS.packed);
  const verticalResult = parse(root, PATHS.vertical);
  const preflightResult = parse(root, PATHS.preflight);
  const diagnosticsResult = parse(root, PATHS.diagnostics);
  const fileDigests = {
    packed_schema_sha256: sha256(read(root, PATHS.packedSchema)),
    vertical_schema_sha256: sha256(read(root, PATHS.verticalSchema)),
    preflight_sha256: sha256(preflightResult.bytes),
    diagnostics_sha256: sha256(diagnosticsResult.bytes),
    release_sha256: sha256(read(root, PATHS.release)),
  };
  const packed = packedResult.value;
  const vertical = verticalResult.value;
  for (const archive of packed.binding?.archives ?? []) {
    const directory = archive.kind === "npm_tarball" ? "npm-dist" : "python-dist";
    same(
      sha256(read(root, `artifacts/reliability/${directory}/${archive.filename}`)),
      archive.sha256,
      `binding.archive.${archive.kind}`,
    );
  }
  const corpora = new Map([
    ...(packed.binding?.corpora ?? []),
    ...(vertical.binding?.corpora ?? []),
  ].map((entry) => [entry.id, entry.sha256]));
  for (const [path, digest] of corpora) {
    same(sha256(read(root, path)), digest, `binding.corpus.${path}`);
  }
  validateProofAuthorities({
    packed,
    packedBytes: packedResult.bytes,
    vertical,
    verticalBytes: verticalResult.bytes,
    preflight: preflightResult.value,
    diagnostics: diagnosticsResult.value,
    fileDigests,
    sidecars: {
      packed: read(root, PATHS.packedSidecar).toString("utf8"),
      vertical: read(root, PATHS.verticalSidecar).toString("utf8"),
    },
  });
  return {
    schema_version: 1,
    proof_profile: "installed_t38_retained_proof_v1",
    status: "valid",
    authority_commits: {
      t37_completion: EXPECTED.t37_completion_commit,
      t38_completion_marker: EXPECTED.t38_completion_marker,
      final_retained_receipt_bytes: EXPECTED.retained_receipt_commit,
    },
    receipts: {
      packed: { path: PATHS.packed, file_sha256: EXPECTED.packed_file_sha256, digest: packed.digest, proof_version: packed.proof_version },
      vertical: { path: PATHS.vertical, file_sha256: EXPECTED.vertical_file_sha256, digest: vertical.digest, proof_version: vertical.proof_version },
    },
    bindings: {
      source_git_oid: packed.binding.source_git_oid,
      release: packed.binding.release,
      build: packed.binding.build,
      archives: packed.binding.archives,
      schemas: {
        packed: { path: PATHS.packedSchema, sha256: fileDigests.packed_schema_sha256 },
        vertical: { path: PATHS.verticalSchema, sha256: fileDigests.vertical_schema_sha256 },
      },
      redaction_version: packed.redaction_version,
      canonicalization: packed.canonicalization,
      corpora: vertical.binding.corpora,
      preflight: { path: PATHS.preflight, sha256: fileDigests.preflight_sha256, status: preflightResult.value.status },
      diagnostics: { path: PATHS.diagnostics, sha256: fileDigests.diagnostics_sha256, status: diagnosticsResult.value.status },
    },
    execution: {
      run_ids: vertical.runs.map((run) => run.run_id),
      persistent_state_ids: vertical.runs.map((run) => run.persistent_state_id),
      provider_pair: {
        implementation: { adapter: "codex-cli", provider: "openai", model: "gpt-5.6-sol" },
        review: { adapter: "claude-code", provider: "anthropic", model: "claude-opus-4-8[1m]" },
      },
      lifecycle_terminal: "delivered",
      done_alias: "delivered_only",
      cleanup: vertical.cleanup,
    },
    capability_activation: ["resume_retry", "cross_vendor_review", "automatic_delivery"],
  };
}

function output(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function main() {
  const checkAt = process.argv.indexOf("--check");
  const target = resolve(checkAt >= 0
    ? (process.argv[checkAt + 1] ?? join(DEFAULT_ROOT, "artifacts/reliability/release-proof-index.json"))
    : (process.argv[2] ?? join(DEFAULT_ROOT, "artifacts/reliability/release-proof-index.json")));
  try {
    const rendered = output(buildProofIndex(DEFAULT_ROOT));
    if (checkAt >= 0) {
      claim(existsSync(target), "proof_index.output", "generated proof index is missing");
      same(readFileSync(target, "utf8"), rendered, "proof_index.output");
      process.stdout.write("generate-release-proof-index: retained proof and index passed\n");
    } else {
      writeFileSync(target, rendered, "utf8");
      process.stdout.write(`generate-release-proof-index: wrote ${target}\n`);
    }
  } catch (error) {
    process.stderr.write(`generate-release-proof-index: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
