#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_KEYS = [
  "schema_version",
  "id",
  "title",
  "description",
  "depends_on",
  "scope",
  "interfaces",
  "acceptance_criteria",
  "verifications",
  "budgets",
  "digest",
];
const LOCAL_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const TICKET_ID = /^t[0-9]{2,}$/;
const SHELLS = new Set(["sh", "bash", "zsh", "cmd", "powershell", "pwsh"]);
const CHANGE_KINDS = new Set(["create", "modify", "delete", "rename"]);
const CWD_CLASSES = new Set(["repository_root", "orchestrator_package", "attempt_output"]);

class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContractError(code, message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("FIXTURE_JSON_INVALID", `${path}: ${error.message}`);
  }
}

function assertObject(value, code, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(code, `${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, required, code, label) {
  assertObject(value, code, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("TICKET_SCHEMA_UNKNOWN_FIELD", `${label}.${key} is unknown`);
  }
  for (const key of required) {
    if (!(key in value)) fail(code, `${label}.${key} is required`);
  }
}

function assertString(value, code, label, pattern) {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
    fail(code, `${label} is invalid`);
  }
}

function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    assertString(item.id, "TICKET_ID_INVALID", `${label}.id`, LOCAL_ID);
    if (seen.has(item.id)) fail("TICKET_ID_DUPLICATE", `${label} duplicates ${item.id}`);
    seen.add(item.id);
  }
  return seen;
}

function validatePath(value, label) {
  assertString(value, "TICKET_SCOPE_PATH_INVALID", label);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    fail("TICKET_SCOPE_PATH_ABSOLUTE", `${label} must be repository-relative`);
  }
  if (value.includes("\\") || value.includes("\0") || value.includes("//") || value.endsWith("/")) {
    fail("TICKET_SCOPE_PATH_INVALID", `${label} is not canonical POSIX form`);
  }
  const segments = value.split("/");
  if (segments.some((part) => part === "." || part === "..")) {
    fail("TICKET_SCOPE_PATH_TRAVERSAL", `${label} contains traversal`);
  }
  if (segments.some((part) => part === ".git" || part === ".rickgent")) {
    fail("TICKET_SCOPE_PATH_RESERVED", `${label} names a reserved Git or state root`);
  }
}

function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) fail("TICKET_NO_OP", "scope must not be empty");
  const paths = new Set();
  for (const [index, entry] of scope.entries()) {
    const label = `scope[${index}]`;
    assertExactKeys(entry, ["path", "change_kind", "directory", "from_path"], ["path", "change_kind", "directory"], "TICKET_SCOPE_INVALID", label);
    validatePath(entry.path, `${label}.path`);
    if (!CHANGE_KINDS.has(entry.change_kind) || typeof entry.directory !== "boolean") {
      fail("TICKET_SCOPE_INVALID", `${label} has an invalid kind or directory flag`);
    }
    if (entry.change_kind === "rename") {
      if (!("from_path" in entry)) fail("TICKET_SCOPE_RENAME_INVALID", `${label}.from_path is required`);
      validatePath(entry.from_path, `${label}.from_path`);
      if (entry.from_path === entry.path) fail("TICKET_SCOPE_RENAME_INVALID", `${label} rename is a no-op`);
    } else if ("from_path" in entry) {
      fail("TICKET_SCOPE_RENAME_INVALID", `${label}.from_path is allowed only for rename`);
    }
    for (const candidate of [entry.path, entry.from_path].filter(Boolean)) {
      if (paths.has(candidate)) fail("TICKET_SCOPE_DUPLICATE", `${candidate} is declared more than once`);
      paths.add(candidate);
    }
  }
}

function validateInterfaces(interfaces) {
  if (!Array.isArray(interfaces)) fail("TICKET_INTERFACE_INVALID", "interfaces must be an array");
  const ids = assertUniqueIds(interfaces, "interfaces");
  for (const [index, entry] of interfaces.entries()) {
    const label = `interfaces[${index}]`;
    assertExactKeys(entry, ["id", "direction", "path", "owner", "description"], ["id", "direction", "path", "owner", "description"], "TICKET_INTERFACE_INVALID", label);
    if (!new Set(["provides", "consumes"]).has(entry.direction)) fail("TICKET_INTERFACE_INVALID", `${label}.direction is invalid`);
    validatePath(entry.path, `${label}.path`);
    assertString(entry.owner, "TICKET_INTERFACE_INVALID", `${label}.owner`);
    assertString(entry.description, "TICKET_INTERFACE_INVALID", `${label}.description`);
  }
  return ids;
}

function validateVerifications(verifications) {
  if (!Array.isArray(verifications) || verifications.length === 0) fail("TICKET_VERIFICATION_INVALID", "verifications must not be empty");
  const ids = assertUniqueIds(verifications, "verifications");
  for (const [index, entry] of verifications.entries()) {
    const label = `verifications[${index}]`;
    assertExactKeys(
      entry,
      ["id", "executable", "args", "cwd_class", "env_allowlist", "timeout_ms", "network", "writable_outputs", "expected_exit_codes"],
      ["id", "executable", "args", "cwd_class", "env_allowlist", "timeout_ms", "network", "writable_outputs", "expected_exit_codes"],
      "TICKET_VERIFICATION_INVALID",
      label,
    );
    assertString(entry.executable, "TICKET_VERIFICATION_INVALID", `${label}.executable`, /^[A-Za-z0-9._+/-]+$/);
    if (SHELLS.has(entry.executable.split("/").at(-1).toLowerCase())) {
      fail("TICKET_VERIFICATION_SHELL_FORBIDDEN", `${label}.executable is a shell`);
    }
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) fail("TICKET_VERIFICATION_INVALID", `${label}.args must be argv strings`);
    if (!CWD_CLASSES.has(entry.cwd_class)) fail("TICKET_VERIFICATION_CWD_INVALID", `${label}.cwd_class is invalid`);
    if (!Array.isArray(entry.env_allowlist) || new Set(entry.env_allowlist).size !== entry.env_allowlist.length || entry.env_allowlist.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))) {
      fail("TICKET_VERIFICATION_ENV_INVALID", `${label}.env_allowlist is invalid`);
    }
    if (!Number.isSafeInteger(entry.timeout_ms) || entry.timeout_ms < 1 || entry.timeout_ms > 3_600_000) fail("TICKET_VERIFICATION_TIMEOUT_INVALID", `${label}.timeout_ms is invalid`);
    if (entry.network !== "deny") fail("TICKET_VERIFICATION_NETWORK_FORBIDDEN", `${label}.network must be deny`);
    if (!Array.isArray(entry.writable_outputs) || new Set(entry.writable_outputs).size !== entry.writable_outputs.length) fail("TICKET_VERIFICATION_OUTPUT_INVALID", `${label}.writable_outputs is invalid`);
    entry.writable_outputs.forEach((path, outputIndex) => validatePath(path, `${label}.writable_outputs[${outputIndex}]`));
    if (!Array.isArray(entry.expected_exit_codes) || entry.expected_exit_codes.length === 0 || new Set(entry.expected_exit_codes).size !== entry.expected_exit_codes.length || entry.expected_exit_codes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) {
      fail("TICKET_VERIFICATION_EXIT_INVALID", `${label}.expected_exit_codes is invalid`);
    }
  }
  return ids;
}

function validateAcceptanceCriteria(criteria, interfaceIds, verificationIds) {
  if (!Array.isArray(criteria) || criteria.length === 0) fail("TICKET_AC_INVALID", "acceptance_criteria must not be empty");
  assertUniqueIds(criteria, "acceptance_criteria");
  for (const [index, entry] of criteria.entries()) {
    const label = `acceptance_criteria[${index}]`;
    assertExactKeys(entry, ["id", "description", "interface_ids", "verification_ids"], ["id", "description", "interface_ids", "verification_ids"], "TICKET_AC_INVALID", label);
    assertString(entry.description, "TICKET_AC_INVALID", `${label}.description`);
    if (!Array.isArray(entry.interface_ids) || new Set(entry.interface_ids).size !== entry.interface_ids.length) fail("TICKET_AC_INVALID", `${label}.interface_ids is invalid`);
    if (!Array.isArray(entry.verification_ids) || entry.verification_ids.length === 0 || new Set(entry.verification_ids).size !== entry.verification_ids.length) fail("TICKET_AC_INVALID", `${label}.verification_ids is invalid`);
    for (const id of entry.interface_ids) if (!interfaceIds.has(id)) fail("TICKET_INTERFACE_REFERENCE_UNKNOWN", `${label} references ${id}`);
    for (const id of entry.verification_ids) if (!verificationIds.has(id)) fail("TICKET_VERIFICATION_REFERENCE_UNKNOWN", `${label} references ${id}`);
  }
}

function validateBudgets(budgets) {
  assertExactKeys(budgets, ["max_attempts", "max_review_cycles", "wall_clock_ms", "remediation_limit"], ["max_attempts", "max_review_cycles", "wall_clock_ms", "remediation_limit"], "TICKET_BUDGET_INVALID", "budgets");
  const ranges = {
    max_attempts: [1, 100],
    max_review_cycles: [0, 100],
    wall_clock_ms: [1, 86_400_000],
    remediation_limit: [0, 100],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] < minimum || budgets[key] > maximum) fail("TICKET_BUDGET_INVALID", `budgets.${key} is invalid`);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("TICKET_CANONICAL_VALUE_INVALID", "only safe integers are admitted");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("TICKET_CANONICAL_VALUE_INVALID", `unsupported canonical value ${typeof value}`);
}

export function contractDigest(contract) {
  const payload = { ...contract };
  delete payload.digest;
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}

export function validateContract(contract, context = {}) {
  assertExactKeys(contract, CONTRACT_KEYS, CONTRACT_KEYS, "TICKET_SCHEMA_INVALID", "contract");
  if (contract.schema_version !== "1.0.0") fail("TICKET_SCHEMA_VERSION_UNSUPPORTED", "schema_version must be 1.0.0");
  assertString(contract.id, "TICKET_ID_INVALID", "contract.id", TICKET_ID);
  assertString(contract.title, "TICKET_SCHEMA_INVALID", "contract.title");
  assertString(contract.description, "TICKET_SCHEMA_INVALID", "contract.description");
  if (!Array.isArray(contract.depends_on) || new Set(contract.depends_on).size !== contract.depends_on.length || contract.depends_on.some((id) => !TICKET_ID.test(id))) fail("TICKET_DEPENDENCY_INVALID", "depends_on is invalid");
  if (contract.depends_on.includes(contract.id)) fail("TICKET_DEPENDENCY_CYCLE", "a ticket cannot depend on itself");
  if (context.known_ticket_ids) {
    const known = new Set(context.known_ticket_ids);
    for (const id of contract.depends_on) if (!known.has(id)) fail("TICKET_DEPENDENCY_UNKNOWN", `dependency ${id} is unknown`);
  }
  validateScope(contract.scope);
  const interfaceIds = validateInterfaces(contract.interfaces);
  const verificationIds = validateVerifications(contract.verifications);
  validateAcceptanceCriteria(contract.acceptance_criteria, interfaceIds, verificationIds);
  validateBudgets(contract.budgets);
  if (typeof contract.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(contract.digest)) fail("TICKET_DIGEST_INVALID", "digest is invalid");
  const expected = contractDigest(contract);
  if (contract.digest !== expected) fail("TICKET_DIGEST_MISMATCH", `expected ${expected}`);
  const payload = { ...contract };
  delete payload.digest;
  return { digest: expected, canonical: canonicalJson(payload) };
}

function applyMutations(base, mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) fail("FIXTURE_INVALID_CASE", "mutations must not be empty");
  const output = structuredClone(base);
  for (const mutation of mutations) {
    assertExactKeys(mutation, ["op", "path", "value"], ["op", "path"], "FIXTURE_INVALID_CASE", "mutation");
    if (!new Set(["set", "delete"]).has(mutation.op) || !Array.isArray(mutation.path) || mutation.path.length === 0 || mutation.path.some((segment) => !(typeof segment === "string" || Number.isInteger(segment)))) {
      fail("FIXTURE_INVALID_CASE", "mutation operation or path is invalid");
    }
    let target = output;
    for (const segment of mutation.path.slice(0, -1)) {
      if (target === null || typeof target !== "object" || !(segment in target)) fail("FIXTURE_INVALID_CASE", `mutation path ${mutation.path.join(".")} is absent`);
      target = target[segment];
    }
    const key = mutation.path.at(-1);
    if (mutation.op === "delete") delete target[key];
    else if (!("value" in mutation)) fail("FIXTURE_INVALID_CASE", "set mutation requires value");
    else target[key] = mutation.value;
  }
  return output;
}

function validateSchema(schema) {
  assertObject(schema, "FIXTURE_SCHEMA_INVALID", "schema");
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.additionalProperties !== false) fail("FIXTURE_SCHEMA_INVALID", "schema must be draft 2020-12 and strict");
  if (schema.properties?.schema_version?.const !== "1.0.0" || schema.properties?.digest?.pattern !== "^sha256:[0-9a-f]{64}$") fail("FIXTURE_SCHEMA_INVALID", "schema identity or digest is not frozen");
  if (schema.$defs?.verification?.additionalProperties !== false || schema.$defs?.verification?.properties?.network?.const !== "deny") fail("FIXTURE_SCHEMA_INVALID", "verification schema is not fail closed");
}

function main() {
  const directory = resolve(process.argv[2] ?? "orchestrator/test/fixtures/ticket-contract");
  const scriptRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const schemaPath = resolve(scriptRoot, "docs/architecture/reliability/ticket-contract.schema.json");
  validateSchema(readJson(schemaPath));

  const valid = readJson(join(directory, "valid.json"));
  const result = validateContract(valid, { known_ticket_ids: ["t00", "t01", "t02"] });

  const vectors = readJson(join(directory, "canonicalization-vectors.json"));
  if (vectors.schema_version !== "1.0.0" || !Array.isArray(vectors.vectors) || vectors.vectors.length < 2) fail("FIXTURE_VECTOR_INVALID", "at least two canonicalization vectors are required");
  for (const vector of vectors.vectors) {
    assertExactKeys(vector, ["name", "input", "permuted_input", "expected_digest"], ["name", "input", "permuted_input", "expected_digest"], "FIXTURE_VECTOR_INVALID", "vector");
    const first = contractDigest(vector.input);
    const second = contractDigest(vector.permuted_input);
    if (first !== vector.expected_digest || second !== vector.expected_digest || canonicalJson(vector.input) !== canonicalJson(vector.permuted_input)) fail("FIXTURE_VECTOR_MISMATCH", `${vector.name} is not canonicalization-stable`);
  }

  const invalidDirectory = join(directory, "invalid");
  const invalidFiles = readdirSync(invalidDirectory).filter((name) => name.endsWith(".json")).sort();
  if (invalidFiles.length < 8) fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", "at least eight invalid fixtures are required");
  const observedCodes = new Set();
  for (const name of invalidFiles) {
    const fixture = readJson(join(invalidDirectory, name));
    assertExactKeys(fixture, ["name", "expected_error", "context", "mutations"], ["name", "expected_error", "mutations"], "FIXTURE_INVALID_CASE", name);
    const invalidContract = applyMutations(valid, fixture.mutations);
    try {
      validateContract(invalidContract, fixture.context ?? { known_ticket_ids: ["t00", "t01", "t02"] });
      fail("FIXTURE_INVALID_ACCEPTED", `${name} unexpectedly passed`);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      if (error.code !== fixture.expected_error) fail("FIXTURE_ERROR_MISMATCH", `${name}: expected ${fixture.expected_error}, received ${error.code}`);
      observedCodes.add(error.code);
    }
  }
  if (observedCodes.size < 8) fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", "negative fixtures must exercise at least eight stable errors");

  process.stdout.write(`${JSON.stringify({ schema_version: "1.0.0", valid_digest: result.digest, canonicalization_vectors: vectors.vectors.length, invalid_fixtures: invalidFiles.length, stable_error_codes: [...observedCodes].sort() })}\n`);
}

try {
  main();
} catch (error) {
  const code = error instanceof ContractError ? error.code : "FIXTURE_VALIDATOR_INTERNAL";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exit(1);
}
