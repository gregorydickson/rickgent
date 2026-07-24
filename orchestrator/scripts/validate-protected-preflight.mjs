#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const receiptPath = resolve(process.argv[2] ?? "artifacts/reliability/protected-release-preflight.json");
const sidecarPath = join(dirname(receiptPath), "protected-release-preflight.sha256");
const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}$/;
const EXPECTED_T37 = Object.freeze({
  source_git_oid: "fdfa6f4fd61f0fc21583d6106535b4d198981fcd",
  build_id: "fdfa6f4fd61f0fc21583d6106535b4d198981fcd",
  build_resource_sha256: "de94f6f126074eac9cc377d8bd982476f57ae363aeee3cceefd6a3448335b688",
  npm_archive_sha256: "1eceecb2c55f2f13f521c5464a26b27e8cce5fff44661321e344a47410577a34",
  npm_inventory_sha256: "0205c2569e7df6db8a1ec1312fcf90396fc6acb89687e7dc61ebdda5b595ef0f",
  wheel_archive_sha256: "0eb851486e8966c5509d53172b3491e6daa1bc836b9255c267863fa3d82e72f0",
  wheel_inventory_sha256: "abeac2ab3ca773840a59c9a5439dc8c3c7e52742a3081f2f0a3e7eb88c543b2a",
  omnigent_contract_sha256: "d1db539f7c602db8750a7187a3f74fee5ae46386d4f4a05df9c94fba13604b64",
  packed_receipt_sha256: "d650760e0c89b437bace6b27e17eceed45d4b71eb2cad163b9606faaf5b11215",
});
const EXPECTED_INSTALLATION = Object.freeze({
  build_id: EXPECTED_T37.build_id,
  cli_sha256: "7ca98adfccafd4c2a296baa82b1a4c5061bb464ff5ea9275c896f3fc05f0e03a",
  manager_sha256: "b97e32aa45ae0b3f740764ea48207b286092a4c0e31f7b73f736e06f9e3f7d2a",
  omnigent_git_oid: "6e3c77855b08c9b612bf20763fe14f57a7ff9ad4",
  omnigent_version: "unknown",
  policy_sha256: "4205630cb6881f0f103f2157b2d5576a7ad5027b6ded5b1cb131027399250b48",
  source: "exact_t37_persistent_handoff",
  worker_sha256: "a7c8a1dc8bb4eec0a5e340dcc292d7ebfdc3b52dd9a5ea87fe0a3c3e93c499ca",
});
const EXPECTED_REMOTE = Object.freeze({
  host: "github.com",
  owner: "gregorydickson",
  repository: "rickgent-release-proof-20260723",
  repository_id: "1310051293",
  authenticated_actor: "gregorydickson",
  base_branch: "main",
});

function fail(message) {
  process.stderr.write(`validate-protected-preflight: ${message}\n`);
  process.exit(1);
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} keys mismatch`);
}
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
}
function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
}

if (!existsSync(receiptPath)) fail(`receipt does not exist: ${receiptPath}`);
if (!existsSync(sidecarPath)) fail(`checksum sidecar does not exist: ${sidecarPath}`);
let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
} catch (error) {
  fail(`cannot parse receipt: ${error.message}`);
}
exactKeys(receipt, [
  "acceptance_criteria", "authentication", "binding", "canonicalization", "digest",
  "digest_algorithm", "mode", "no_mutation", "prerequisites", "redaction_version",
  "refusal", "remote", "schema_version", "status", "teardown",
], "receipt");
equal(receipt.schema_version, "rickgent-protected-release-preflight/v1", "schema_version");
equal(receipt.canonicalization, "rickgent-canonical-json-v1", "canonicalization");
equal(receipt.digest_algorithm, "sha256_over_utf8_canonical_bytes_excluding_top_level_digest", "digest_algorithm");
equal(receipt.redaction_version, "rickgent-redaction-v1", "redaction_version");
equal(receipt.mode, "preflight_only", "mode");
if (!SHA256.test(receipt.digest)) fail("digest must be lowercase SHA-256");
const { digest, ...unsigned } = receipt;
equal(readFileSync(receiptPath, "utf8"), `${canonical(receipt)}\n`, "canonical receipt bytes");
equal(digest, sha256(canonical(unsigned)), "canonical digest");
equal(readFileSync(sidecarPath, "utf8"), `${sha256(readFileSync(receiptPath))}  ${basename(receiptPath)}\n`, "checksum sidecar");

exactKeys(receipt.prerequisites, [
  "declared_preflight_interface", "exact_t37_installation", "verification_environment",
], "prerequisites");
for (const [name, prerequisite] of Object.entries(receipt.prerequisites)) {
  exactKeys(prerequisite, ["observed", "reason"], `prerequisites.${name}`);
  if (typeof prerequisite.observed !== "boolean") fail(`prerequisites.${name}.observed must be boolean`);
  nonempty(prerequisite.reason, `prerequisites.${name}.reason`);
}

if (receipt.status !== "accepted") {
  equal(receipt.status, "refused", "status");
  exactKeys(receipt.binding, Object.keys(EXPECTED_T37), "binding");
  for (const [key, expected] of Object.entries(EXPECTED_T37)) {
    equal(receipt.binding[key], expected, `binding.${key}`);
  }
  for (const key of ["acceptance_criteria", "authentication", "no_mutation", "remote", "teardown"]) {
    equal(receipt[key], null, `${key} on refusal`);
  }
  exactKeys(receipt.refusal, ["codes", "mutation_attempted"], "refusal");
  equal(receipt.refusal.mutation_attempted, false, "refusal.mutation_attempted");
  if (!Array.isArray(receipt.refusal.codes) || receipt.refusal.codes.length === 0) fail("refusal.codes must be non-empty");
  if (receipt.refusal.codes.some((code) => ![
    "DECLARED_PREFLIGHT_INTERFACE_UNREACHABLE",
    "EXACT_T37_INSTALLATION_UNAVAILABLE",
    "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
  ].includes(code))) fail("refusal contains an unknown code");
  fail(`preflight was refused (${receipt.refusal.codes.join(", ")})`);
}

equal(receipt.refusal, null, "refusal on accepted receipt");
if (Object.values(receipt.prerequisites).some((item) => item.observed !== true)) {
  fail("all accepted prerequisites must be observed");
}

exactKeys(receipt.binding, [...Object.keys(EXPECTED_T37), "installation"], "binding");
for (const [key, expected] of Object.entries(EXPECTED_T37)) equal(receipt.binding[key], expected, `binding.${key}`);
const installation = record(receipt.binding.installation, "binding.installation");
exactKeys(installation, [
  "build_id", "cli_sha256", "manager_sha256", "omnigent_git_oid", "omnigent_version",
  "policy_sha256", "source", "worker_sha256",
], "binding.installation");
for (const [key, expected] of Object.entries(EXPECTED_INSTALLATION)) {
  equal(installation[key], expected, `installation.${key}`);
}
for (const key of ["cli_sha256", "manager_sha256", "policy_sha256", "worker_sha256"]) {
  if (!SHA256.test(installation[key])) fail(`installation.${key} must be lowercase SHA-256`);
}
if (!OID.test(installation.omnigent_git_oid)) fail("installation.omnigent_git_oid must be a full OID");
nonempty(installation.omnigent_version, "installation.omnigent_version");

exactKeys(receipt.authentication, ["checks", "provider_dispatch_observed"], "authentication");
equal(receipt.authentication.provider_dispatch_observed, false, "authentication.provider_dispatch_observed");
if (!Array.isArray(receipt.authentication.checks) || receipt.authentication.checks.length !== 2) {
  fail("exactly two authentication checks are required");
}
const expectedRoles = new Map([
  ["test", { harness: "codex", model: "gpt-5.6-sol" }],
  ["review", { harness: "claude", model: "claude-opus-4-8[1m]" }],
]);
for (const check of receipt.authentication.checks) {
  exactKeys(check, [
    "authenticated", "available", "device_login", "harness", "model", "non_interactive",
    "observation_sha256", "role", "timeout_ms",
  ], `authentication.${check?.role ?? "unknown"}`);
  const expected = expectedRoles.get(check.role);
  if (expected === undefined) fail("unexpected authentication role");
  equal(check.harness, expected.harness, `${check.role}.harness`);
  equal(check.model, expected.model, `${check.role}.model`);
  for (const key of ["authenticated", "available", "non_interactive"]) equal(check[key], true, `${check.role}.${key}`);
  equal(check.device_login, false, `${check.role}.device_login`);
  if (!Number.isInteger(check.timeout_ms) || check.timeout_ms < 1_000 || check.timeout_ms > 120_000) {
    fail(`${check.role}.timeout_ms must be finite`);
  }
  if (!SHA256.test(check.observation_sha256)) fail(`${check.role}.observation_sha256 must be lowercase SHA-256`);
  expectedRoles.delete(check.role);
}
if (expectedRoles.size !== 0) fail("authentication role coverage mismatch");

const remote = record(receipt.remote, "remote");
exactKeys(remote, [
  "allowlist_match", "authenticated_actor", "base_branch", "clean_baseline", "host",
  "observation_sha256", "owned_namespace", "owner", "repository", "repository_id",
  "required_token_operations",
], "remote");
for (const key of ["host", "owner", "repository", "repository_id", "authenticated_actor", "base_branch"]) {
  nonempty(remote[key], `remote.${key}`);
}
for (const [key, expected] of Object.entries(EXPECTED_REMOTE)) {
  equal(remote[key], expected, `remote.${key}`);
}
equal(remote.allowlist_match, true, "remote.allowlist_match");
equal(remote.clean_baseline, true, "remote.clean_baseline");
if (!/^rickgent\/protected\/[0-9a-f]{24}$/.test(remote.owned_namespace)) {
  fail("remote.owned_namespace must be unique and owned");
}
equal(remote.required_token_operations, [
  "contents:read", "metadata:read", "pull_requests:read",
], "remote.required_token_operations");
if (!SHA256.test(remote.observation_sha256)) fail("remote.observation_sha256 must be lowercase SHA-256");

const teardown = record(receipt.teardown, "teardown");
exactKeys(teardown, [
  "close_owned_prs_only", "compare_before_delete", "delete_owned_branches_only",
  "dry_run_validated", "force_delete", "owned_namespace", "registered_before_mutation",
  "repository_deletion", "repository_id", "requery_after_action",
], "teardown");
equal(teardown.repository_id, remote.repository_id, "teardown.repository_id");
equal(teardown.owned_namespace, remote.owned_namespace, "teardown.owned_namespace");
for (const key of [
  "close_owned_prs_only", "compare_before_delete", "delete_owned_branches_only",
  "dry_run_validated", "registered_before_mutation", "requery_after_action",
]) equal(teardown[key], true, `teardown.${key}`);
equal(teardown.force_delete, false, "teardown.force_delete");
equal(teardown.repository_deletion, false, "teardown.repository_deletion");

exactKeys(receipt.no_mutation, ["after", "before", "observed_mutations"], "no_mutation");
equal(receipt.no_mutation.observed_mutations, [], "no_mutation.observed_mutations");
const snapshotKeys = [
  "branches_sha256", "provider_lifecycle_count", "provider_lifecycle_sha256",
  "pull_requests_sha256", "repository_exists", "repository_id",
];
for (const phase of ["before", "after"]) {
  const snapshot = receipt.no_mutation[phase];
  exactKeys(snapshot, snapshotKeys, `no_mutation.${phase}`);
  equal(snapshot.repository_exists, true, `no_mutation.${phase}.repository_exists`);
  equal(snapshot.repository_id, remote.repository_id, `no_mutation.${phase}.repository_id`);
  for (const key of ["branches_sha256", "provider_lifecycle_sha256", "pull_requests_sha256"]) {
    if (!SHA256.test(snapshot[key])) fail(`no_mutation.${phase}.${key} must be lowercase SHA-256`);
  }
  if (!Number.isInteger(snapshot.provider_lifecycle_count) || snapshot.provider_lifecycle_count < 0) {
    fail(`no_mutation.${phase}.provider_lifecycle_count must be non-negative`);
  }
}
equal(receipt.no_mutation.after, receipt.no_mutation.before, "before/after observations");

const expectedCriteria = [
  "Preflight binds the installed executable/build and exact npm, wheel, inventory, compatibility, and packed-receipt digests from t37.",
  "Non-interactive Codex gpt-5.6-sol and Claude claude-opus-4-8[1m] authentication and availability are checked with finite timeouts and without device-login prompts.",
  "The remote observation records exact host, owner, repository, immutable repository ID, authenticated actor, base branch, allowlist match, required token operations, clean baseline, and unique owned namespace.",
  "The teardown plan is registered and dry-run validated before mutation, uses immutable identifiers and compare-before-delete, closes only owned PRs, deletes only owned branches, and forbids repository deletion.",
  "The schema-validated preflight is redacted and contains no token, credential-bearing URL, provider transcript, prompt body, or absolute user path.",
  "Independent observations prove no branch, PR, repository, or provider lifecycle mutation occurred during preflight.",
];
equal(receipt.acceptance_criteria, expectedCriteria, "acceptance_criteria");
process.stdout.write("validate-protected-preflight: accepted preflight passed\n");
