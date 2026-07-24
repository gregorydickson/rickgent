#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const receiptPath = resolve(process.argv[2] ?? "artifacts/reliability/protected-release-preflight.json");
const allowedKeys = new Set([
  "acceptance_criteria", "after", "allowlist_match", "authenticated", "authenticated_actor",
  "authentication", "available", "base_branch", "before", "binding", "branches_sha256",
  "build_id", "build_resource_sha256", "canonicalization", "checks", "clean_baseline",
  "cli_sha256", "close_owned_prs_only", "codes", "compare_before_delete",
  "declared_preflight_interface", "delete_owned_branches_only", "device_login", "digest",
  "digest_algorithm", "dry_run_validated", "exact_t37_installation", "force_delete",
  "harness", "host", "installation", "manager_sha256", "mode", "model",
  "mutation_attempted", "no_mutation", "non_interactive", "npm_archive_sha256",
  "npm_inventory_sha256", "observation_sha256", "observed", "observed_mutations",
  "omnigent_contract_sha256", "omnigent_git_oid", "omnigent_version", "owned_namespace",
  "owner", "packed_receipt_sha256", "policy_sha256", "prerequisites",
  "provider_dispatch_observed", "provider_lifecycle_count", "provider_lifecycle_sha256",
  "pull_requests_sha256", "reason", "redaction_version", "refusal", "registered_before_mutation",
  "remote", "repository", "repository_deletion", "repository_exists", "repository_id",
  "required_token_operations", "requery_after_action", "role", "schema_version", "source",
  "source_git_oid", "status", "teardown", "timeout_ms", "verification_environment",
  "wheel_archive_sha256", "wheel_inventory_sha256", "worker_sha256",
]);
const forbiddenKey = /(?:token|secret|password|credential|authorization|transcript|prompt|stdout|stderr|command_output|raw_output)/i;
const secretValue = /(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*[:=]\s*(?:bearer|token))/i;
const credentialUrl = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/i;
const absoluteUserPath = /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/;
const expiredProofPath = /rickgent-packed-proof-[A-Za-z0-9_-]+/;
const providerTranscript = /(?:assistant|provider|conversation)[_-]?(?:message|response|transcript|body)/i;

function fail(message) {
  process.stderr.write(`scan-release-evidence: ${message}\n`);
  process.exit(1);
}
function visit(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (!allowedKeys.has(key)) fail(`unexpected key at ${path}.${key}`);
      if (forbiddenKey.test(key) && key !== "required_token_operations") {
        fail(`forbidden evidence key at ${path}.${key}`);
      }
      visit(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (secretValue.test(value)) fail(`secret-like value at ${path}`);
  if (credentialUrl.test(value)) fail(`credential-bearing URL at ${path}`);
  if (absoluteUserPath.test(value)) fail(`absolute user path at ${path}`);
  if (expiredProofPath.test(value)) fail(`expired t37 temporary path at ${path}`);
  if (providerTranscript.test(value)) fail(`provider transcript-like value at ${path}`);
}

let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
} catch (error) {
  fail(`cannot parse receipt: ${error.message}`);
}
visit(receipt);
process.stdout.write("scan-release-evidence: redaction and key allowlist passed\n");
