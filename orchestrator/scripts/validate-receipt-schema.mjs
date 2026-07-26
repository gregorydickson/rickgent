#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`validate-receipt-schema: ${message}\n`);
  process.exit(1);
}

function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse ${path}: ${error.message}`);
  }
}

function at(root, pointer) {
  let value = root;
  for (const part of pointer.split(".").filter(Boolean)) {
    value = value?.[part];
  }
  if (value === undefined) {
    fail(`missing schema authority at ${pointer}`);
  }
  return value;
}

function requireEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function validateClosedDefinitions(schema) {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    fail("receipt root must be a closed object");
  }
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    if (definition.type === "object" && definition.additionalProperties !== false) {
      fail(`$defs.${name} must set additionalProperties=false`);
    }
    if (definition.type === "object") {
      if (!Array.isArray(definition.required) || definition.required.length === 0) {
        fail(`$defs.${name} must have a non-empty required list`);
      }
      const propertyNames = Object.keys(definition.properties ?? {});
      const missing = propertyNames.filter((field) => !definition.required.includes(field));
      if (missing.length > 0) {
        fail(`$defs.${name} properties are optional: ${missing.join(", ")}`);
      }
    }
  }
}

function validateCommon(schema) {
  requireEqual(schema.$schema, "https://json-schema.org/draft/2020-12/schema", "$schema");
  requireEqual(at(schema, "properties.schema_version.const"), "1.0.0", "schema_version");
  requireEqual(
    at(schema, "properties.canonicalization.const"),
    "rickgent-canonical-json-v1",
    "canonicalization",
  );
  requireEqual(
    at(schema, "properties.redaction_version.const"),
    "rickgent-redaction-v1",
    "redaction_version",
  );
  requireEqual(
    at(schema, "properties.digest_algorithm.const"),
    "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
    "digest algorithm",
  );
  requireEqual(at(schema, "$defs.sha256.pattern"), "^[0-9a-f]{64}$", "sha256 pattern");
  requireEqual(
    at(schema, "$defs.check.properties.outcome.enum"),
    ["pass", "fail", "infrastructure_error"],
    "typed check outcomes",
  );
  requireEqual(at(schema, "$defs.check.properties.required.const"), true, "required check marker");
  requireEqual(at(schema, "$defs.evidence.properties.contains_raw_secrets.const"), false, "secret exclusion");
  validateClosedDefinitions(schema);

  const serialized = JSON.stringify(schema);
  for (const forbidden of ["skip", "skipped", "additionalProperties\":true"]) {
    if (serialized.includes(forbidden)) {
      fail(`schema contains forbidden permissive token: ${forbidden}`);
    }
  }
}

function validatePacked(schema) {
  requireEqual(schema.$id, "https://rickgent.dev/schemas/packed-install-receipt-v1.json", "$id");
  requireEqual(
    at(schema, "properties.proof_version.const"),
    "packed-install-proof-v1",
    "proof_version",
  );
  requireEqual(at(schema, "$defs.archive.properties.kind.enum"), ["npm_tarball", "python_wheel"], "archive kinds");
  requireEqual(at(schema, "$defs.omnigent.properties.read_only.const"), true, "Omnigent read-only");
  requireEqual(
    at(schema, "$defs.omnigent.properties.compatibility_authority.const"),
    "offline_behavioral_probe",
    "Omnigent compatibility authority",
  );
  requireEqual(at(schema, "$defs.containment.properties.unrelated_cwd.const"), true, "unrelated cwd");
  requireEqual(at(schema, "$defs.containment.properties.source_lookup_poisoned.const"), true, "source poisoning");
  requireEqual(at(schema, "$defs.cleanup.properties.unrelated_state_preserved.const"), true, "cleanup");

  for (const required of [
    "source_git_oid",
    "release",
    "build",
    "archives",
    "corpora",
    "omnigent_contract_sha256",
  ]) {
    if (!at(schema, "$defs.binding.required").includes(required)) {
      fail(`packed binding must require ${required}`);
    }
  }
}

function validateVertical(schema) {
  requireEqual(schema.$id, "https://rickgent.dev/schemas/vertical-slice-receipt-v1.json", "$id");
  requireEqual(
    at(schema, "properties.proof_version.const"),
    "vertical-slice-proof-v1",
    "proof_version",
  );
  requireEqual(at(schema, "properties.runs.minItems"), 2, "run minimum");
  requireEqual(at(schema, "properties.runs.maxItems"), 2, "run maximum");
  requireEqual(at(schema, "$defs.evidenceItem.properties.classification.const"), "live", "live evidence");
  requireEqual(at(schema, "$defs.evidenceItem.properties.authenticated.const"), true, "authentication");
  requireEqual(at(schema, "$defs.evidence.properties.fixture_substitution.const"), false, "fixture exclusion");
  requireEqual(at(schema, "$defs.run.properties.attempts.minItems"), 2, "attempt minimum");
  requireEqual(at(schema, "$defs.run.properties.attempts.maxItems"), 2, "attempt maximum");
  requireEqual(at(schema, "$defs.run.properties.lifecycle_complete.const"), true, "lifecycle completion");
  requireEqual(at(schema, "$defs.run.properties.containment_passed.const"), true, "containment");
  requireEqual(
    at(schema, "$defs.run.properties.installed_lifecycle.properties.entrypoint.const"),
    "rickgent __protected-release",
    "installed lifecycle entrypoint",
  );
  if (!at(schema, "$defs.run.required").includes("installed_lifecycle")) {
    fail("vertical run must require installed_lifecycle");
  }
  requireEqual(at(schema, "$defs.cleanup.properties.repository_deleted.const"), false, "repository preservation");
  requireEqual(
    at(schema, "$defs.runCleanup.properties.owned_branch_absent_on_requery.const"),
    true,
    "cleanup re-query",
  );

  for (const required of [
    "canonical_provider",
    "requested_model",
    "invoked_model",
    "observed_model",
    "observed_canonical_model",
    "observed_provider",
    "dispatch_id",
    "conversation_id",
    "process_id",
    "provider_process_id",
    "adapter",
    "bundle_sha256",
    "identity_sha256",
  ]) {
    if (!at(schema, "$defs.modelObservation.required").includes(required)) {
      fail(`model observation must require ${required}`);
    }
  }
  for (const required of [
    "npm_archive_sha256",
    "wheel_archive_sha256",
    "packed_install_receipt_sha256",
    "corpora",
  ]) {
    if (!at(schema, "$defs.binding.required").includes(required)) {
      fail(`vertical binding must require ${required}`);
    }
  }
}

const argument = process.argv[2];
if (!argument) {
  fail("usage: validate-receipt-schema.mjs <receipt.schema.json>");
}
const schemaPath = isAbsolute(argument) ? argument : resolve(process.cwd(), argument);
if (!existsSync(schemaPath)) {
  fail(`schema does not exist: ${argument}`);
}
const schema = load(schemaPath);
validateCommon(schema);
if (schema.$id === "https://rickgent.dev/schemas/packed-install-receipt-v1.json") {
  validatePacked(schema);
} else if (schema.$id === "https://rickgent.dev/schemas/vertical-slice-receipt-v1.json") {
  validateVertical(schema);
} else {
  fail(`unsupported receipt schema id: ${schema.$id ?? "<missing>"}`);
}
process.stdout.write(`receipt schema valid: ${schema.$id}\n`);
