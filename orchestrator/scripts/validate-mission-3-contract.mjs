#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`validate-mission-3-contract: ${message}\n`);
  process.exit(1);
}

function load(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse ${label} at ${path}: ${error.message}`);
  }
}

function get(root, pointer) {
  let value = root;
  for (const part of pointer.split(".")) {
    value = value?.[part];
  }
  if (value === undefined) {
    fail(`missing authority: ${pointer}`);
  }
  return value;
}

function equal(root, pointer, expected) {
  const actual = get(root, pointer);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${pointer} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function arrayIncludes(root, pointer, expected) {
  const actual = get(root, pointer);
  if (!Array.isArray(actual) || !actual.includes(expected)) {
    fail(`${pointer} must include ${JSON.stringify(expected)}`);
  }
}

const argument = process.argv[2];
if (!argument) {
  fail("usage: validate-mission-3-contract.mjs <mission-3-release-contract.json>");
}
const contractPath = isAbsolute(argument) ? argument : resolve(process.cwd(), argument);
if (!existsSync(contractPath)) {
  fail(`contract does not exist: ${argument}`);
}
const contract = load(contractPath, "Mission 3 contract");

equal(contract, "schema_version", "1.0.0");
equal(contract, "contract_id", "rickgent-mission-3-release-v1");
equal(contract, "decision_status", "frozen_decision_only");
equal(contract, "activation_boundary.enables_capability", false);
equal(contract, "activation_boundary.provider_or_hosted_mutation_authorized", false);

equal(contract, "omnigent.compatibility_mode", "behavioral_current_compatible");
equal(contract, "omnigent.selection.root", "OMNIGENT_ROOT");
equal(contract, "omnigent.selection.python", "OMNIGENT_PYTHON");
equal(contract, "omnigent.selection.both_required_explicitly", true);
equal(contract, "omnigent.selection.path_or_ambient_discovery_allowed", false);
equal(contract, "omnigent.compatibility_authority", "offline_behavioral_probe");
equal(contract, "omnigent.observed_version_role", "provenance_only");
equal(contract, "omnigent.observed_git_oid_role", "provenance_only");
equal(contract, "omnigent.sha_compatibility_authority", false);
equal(contract, "omnigent.root_access", "read_only");
equal(contract, "omnigent.python_access", "read_only");
equal(contract, "omnigent.import_origin", "canonical_realpath_beneath_OMNIGENT_ROOT");

equal(contract, "installed_release.installation_model", "archives_only");
equal(contract, "installed_release.npm_tarball.count", 1);
for (const resource of [
  "compiled_cli",
  "agent_bundles",
  "runtime_lookup_metadata",
  "LICENSE",
  "immutable_proof_metadata",
  "package_validation_resources",
]) {
  arrayIncludes(contract, "installed_release.npm_tarball.owns", resource);
}
equal(contract, "installed_release.python_wheel.count", 1);
equal(contract, "installed_release.python_wheel.distribution", "rickgent-policies");
arrayIncludes(contract, "installed_release.python_wheel.owns", "rickgent_policies");
equal(contract, "installed_release.python_wheel.editable", false);
equal(contract, "installed_release.allowed_mounted_external_dependencies", ["omnigent"]);
equal(contract, "installed_release.checkout_resource_resolution_allowed", false);
equal(contract, "installed_release.editable_rickgent_install_allowed", false);
equal(contract, "installed_release.source_tree_fallback_allowed", false);

equal(contract, "evidence.canonicalization", "rickgent-canonical-json-v1");
equal(contract, "evidence.digest", "sha256_over_utf8_canonical_bytes_excluding_top_level_digest");
equal(contract, "evidence.redaction_version", "rickgent-redaction-v1");
equal(contract, "evidence.check_outcomes", ["pass", "fail", "infrastructure_error"]);
equal(contract, "evidence.skips_allowed", false);
equal(contract, "evidence.schemas.vertical_slice.required_successful_runs", 2);

const repoRoot = process.cwd();
for (const kind of ["packed_install", "vertical_slice"]) {
  const schemaRef = get(contract, `evidence.schemas.${kind}`);
  const schemaPath = resolve(repoRoot, schemaRef.path);
  if (!existsSync(schemaPath)) {
    fail(`${kind} schema does not exist: ${schemaRef.path}`);
  }
  const schema = load(schemaPath, `${kind} schema`);
  if (schema.$id !== schemaRef.schema_id) {
    fail(`${kind} schema id drift: contract=${schemaRef.schema_id} schema=${schema.$id}`);
  }
  if (schema.properties?.proof_version?.const !== schemaRef.proof_version) {
    fail(`${kind} proof version drift`);
  }
}

const capabilities = new Map(contract.capability_matrix?.map((entry) => [entry.capability, entry]));
const expectedCapabilities = {
  reconciliation: "enabled_only_for_t29_local_recovery_profile",
  resume_retry: "unavailable_for_installed_profile_until_t38",
  cross_vendor_review: "unavailable_for_installed_profile_until_t38",
  automatic_delivery: "unavailable_for_installed_profile_until_t38",
  parallel_dispatch: "unavailable",
  raw_shell: "unavailable",
};
for (const [name, state] of Object.entries(expectedCapabilities)) {
  if (capabilities.get(name)?.state !== state) {
    fail(`capability ${name} must have state ${state}`);
  }
}
for (const name of ["resume_retry", "cross_vendor_review", "automatic_delivery"]) {
  if (!capabilities.get(name).required_evidence.some((entry) => entry.includes("t38"))) {
    fail(`capability ${name} must require t38 evidence`);
  }
}

equal(contract, "protected_release_verification.visibility", "non_public");
equal(contract, "protected_release_verification.failure_mode", "fail_closed");
equal(contract, "protected_release_verification.activates_public_capability", false);
equal(contract, "protected_release_verification.ordinary_cli_selectable", false);
equal(contract, "protected_release_verification.generic_environment_bypass_allowed", false);
equal(contract, "protected_release_verification.generic_dependency_injection_bypass_allowed", false);

equal(contract, "remote.repository.lifecycle", "pre_existing");
equal(contract, "remote.repository.classification", "allowlisted_disposable");
equal(contract, "remote.repository.immutable_repository_id_required", true);
equal(contract, "remote.repository.exact_base_branch_required", true);
equal(contract, "remote.repository.owned_branch_prefix_required", true);
equal(contract, "remote.repository.repository_deletion_allowed", false);
equal(contract, "remote.cleanup.close_owned_pull_request_only", true);
equal(contract, "remote.cleanup.branch_delete", "compare_before_delete_exact_observed_owned_oid");
equal(contract, "remote.cleanup.independent_remote_requery_required", true);
equal(contract, "remote.cleanup.forceful_foreign_cleanup_allowed", false);

equal(contract, "source_precedence.0.authority", "refinement_manifest.json");
equal(contract, "source_precedence.1.authority", "docs/architecture/reliability/mission-3-release-contract.json");
equal(contract, "sequencing.execution_authority", "refinement_manifest.json");
equal(contract, "sequencing.guaranteed_path", "sequential_codex_exec");
equal(contract, "sequencing.ticket_order", ["t37a", "t37b", "t37c", "t38a", "t38b", "t38c", "t39a", "t39b"]);
equal(contract, "sequencing.milestone_completion_commits", ["t37c", "t38c", "t39b"]);

const manifest = load(resolve(repoRoot, "release-manifest.json"), "release manifest");
equal(manifest, "installer.model", "archive_only_install");
equal(manifest, "assembly_plan.model", "archives_only");
equal(manifest, "assembly_plan.allowed_mounted_external_dependencies", ["omnigent"]);
equal(manifest, "assembly_plan.checkout_resource_resolution_allowed", false);
equal(manifest, "assembly_plan.editable_rickgent_install_allowed", false);
equal(manifest, "package_contents.python.install_mode", "non_editable_wheel");
for (const resource of get(contract, "installed_release.npm_tarball.owns")) {
  arrayIncludes(manifest, "package_contents.npm.owns", resource);
}
if (get(manifest, "mission_3_contract.path") !== argument && resolve(repoRoot, get(manifest, "mission_3_contract.path")) !== contractPath) {
  fail("release manifest does not bind the validated Mission 3 contract");
}
equal(manifest, "mission_3_contract.contract_id", contract.contract_id);

process.stdout.write(`Mission 3 contract valid: ${contract.contract_id}\n`);
