#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let TicketContractError;
let canonicalJson;
let normalizeTicketContracts;
let ticketContractDigest;

async function compileAndLoadContractRuntime() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const orchestratorRoot = resolve(scriptDir, "..");
  const outputRoot = mkdtempSync(join(tmpdir(), "rickgent-ticket-contract-validator-"));
  const compiler = join(orchestratorRoot, "node_modules", ".bin", "tsc");
  if (!existsSync(compiler)) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw new Error(`repository-local TypeScript compiler is unavailable: ${compiler}`);
  }
  try {
    execFileSync(
      compiler,
      [
        "--project", join(orchestratorRoot, "tsconfig.json"),
        "--outDir", outputRoot,
        "--declaration", "false",
        "--declarationMap", "false",
        "--sourceMap", "false",
        "--inlineSources", "false",
      ],
      { cwd: orchestratorRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    const runtime = await import(pathToFileURL(join(outputRoot, "contracts", "ticket-contract.js")).href);
    ({ TicketContractError, canonicalJson, normalizeTicketContracts, ticketContractDigest } = runtime);
    return outputRoot;
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

const REQUIRED_CATEGORIES = [
  "identity",
  "references",
  "dependencies",
  "scope",
  "repository_paths",
  "change_kinds",
  "verification",
  "markdown_adapter",
];

class FixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new FixtureError(code, message);
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
    if (!allowed.includes(key)) fail(code, `${label}.${key} is unknown`);
  }
  for (const key of required) {
    if (!(key in value)) fail(code, `${label}.${key} is required`);
  }
}

function isEqualOrBelow(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function applyMutations(base, mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    fail("FIXTURE_INVALID_CASE", "mutations must not be empty");
  }
  const output = structuredClone(base);
  for (const mutation of mutations) {
    assertExactKeys(
      mutation,
      ["op", "path", "value"],
      ["op", "path"],
      "FIXTURE_INVALID_CASE",
      "mutation",
    );
    if (
      !["set", "delete"].includes(mutation.op) ||
      !Array.isArray(mutation.path) ||
      mutation.path.length === 0 ||
      mutation.path.some((segment) => !(typeof segment === "string" || Number.isInteger(segment)))
    ) {
      fail("FIXTURE_INVALID_CASE", "mutation operation or path is invalid");
    }
    let target = output;
    for (const segment of mutation.path.slice(0, -1)) {
      if (target === null || typeof target !== "object" || !(segment in target)) {
        fail("FIXTURE_INVALID_CASE", `mutation path ${mutation.path.join(".")} is absent`);
      }
      target = target[segment];
    }
    const key = mutation.path.at(-1);
    if (mutation.op === "delete") delete target[key];
    else if (!("value" in mutation)) fail("FIXTURE_INVALID_CASE", "set mutation requires value");
    else target[key] = mutation.value;
  }
  return output;
}

function resolveSchemaPointer(schema, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) {
    fail("FIXTURE_SCHEMA_PARITY_INVALID", `invalid local schema pointer ${String(pointer)}`);
  }
  let current = schema;
  for (const encoded of pointer.slice(2).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(segment in current)) {
      fail("FIXTURE_SCHEMA_PARITY_INVALID", `schema pointer does not resolve: ${pointer}`);
    }
    current = current[segment];
  }
  return current;
}

/** Execute the JSON Schema keywords used by the lexical parity fragments. */
function schemaFragmentAccepts(schema, fragment, value) {
  assertObject(fragment, "FIXTURE_SCHEMA_PARITY_INVALID", "schema fragment");
  const supportedKeywords = ["$ref", "type", "const", "enum", "minLength", "pattern", "allOf", "not"];
  const unsupported = Object.keys(fragment).filter((key) => !supportedKeywords.includes(key));
  if (unsupported.length > 0) {
    fail(
      "FIXTURE_SCHEMA_PARITY_INVALID",
      `lexical schema fragment uses unsupported keyword(s): ${unsupported.join(", ")}`,
    );
  }
  if (fragment.$ref !== undefined) {
    return schemaFragmentAccepts(schema, resolveSchemaPointer(schema, fragment.$ref), value);
  }
  if (fragment.type !== undefined && fragment.type !== "string") {
    fail("FIXTURE_SCHEMA_PARITY_INVALID", `unsupported lexical schema type ${String(fragment.type)}`);
  }
  if (fragment.type === "string" && typeof value !== "string") return false;
  if (fragment.const !== undefined && JSON.stringify(value) !== JSON.stringify(fragment.const)) return false;
  if (Array.isArray(fragment.enum) && !fragment.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return false;
  }
  if (typeof value === "string") {
    if (Number.isInteger(fragment.minLength) && [...value].length < fragment.minLength) return false;
    if (typeof fragment.pattern === "string") {
      let expression;
      try {
        expression = new RegExp(fragment.pattern, "u");
      } catch (error) {
        fail(
          "FIXTURE_SCHEMA_INVALID",
          `schema pattern is not valid ECMAScript: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!expression.test(value)) return false;
    }
  }
  if (Array.isArray(fragment.allOf) && fragment.allOf.some((item) => !schemaFragmentAccepts(schema, item, value))) {
    return false;
  }
  if (fragment.not !== undefined && schemaFragmentAccepts(schema, fragment.not, value)) return false;
  return true;
}

function setContractValue(contract, path, value) {
  if (!Array.isArray(path) || path.length === 0) {
    fail("FIXTURE_SCHEMA_PARITY_INVALID", "contract_path must not be empty");
  }
  let target = contract;
  for (const segment of path.slice(0, -1)) {
    if (
      !(typeof segment === "string" || Number.isInteger(segment)) ||
      target === null ||
      typeof target !== "object" ||
      !(segment in target)
    ) {
      fail("FIXTURE_SCHEMA_PARITY_INVALID", `contract path does not resolve: ${path.join(".")}`);
    }
    target = target[segment];
  }
  const key = path.at(-1);
  if (
    !(typeof key === "string" || Number.isInteger(key)) ||
    target === null ||
    typeof target !== "object" ||
    !(key in target)
  ) {
    fail("FIXTURE_SCHEMA_PARITY_INVALID", `contract path does not resolve: ${path.join(".")}`);
  }
  target[key] = value;
}

function validateLexicalParity(directory, schema, validContract) {
  const corpus = readJson(join(directory, "lexical-parity-vectors.json"));
  assertExactKeys(
    corpus,
    ["schema_version", "vectors"],
    ["schema_version", "vectors"],
    "FIXTURE_SCHEMA_PARITY_INVALID",
    "lexical-parity-vectors",
  );
  if (corpus.schema_version !== "1.0.0" || !Array.isArray(corpus.vectors) || corpus.vectors.length < 20) {
    fail("FIXTURE_SCHEMA_PARITY_INVALID", "lexical parity corpus is incomplete or has the wrong version");
  }

  const names = new Set();
  const pointers = new Set();
  for (const [index, vector] of corpus.vectors.entries()) {
    const label = `lexical-parity-vectors.vectors[${index}]`;
    assertExactKeys(
      vector,
      ["name", "schema_pointer", "contract_path", "value", "expected_accept", "expected_runtime_error"],
      ["name", "schema_pointer", "contract_path", "value", "expected_accept", "expected_runtime_error"],
      "FIXTURE_SCHEMA_PARITY_INVALID",
      label,
    );
    if (typeof vector.name !== "string" || vector.name.trim() === "" || names.has(vector.name)) {
      fail("FIXTURE_SCHEMA_PARITY_INVALID", `${label}.name is invalid or duplicated`);
    }
    names.add(vector.name);
    if (
      typeof vector.schema_pointer !== "string" ||
      !Array.isArray(vector.contract_path) ||
      typeof vector.value !== "string" ||
      typeof vector.expected_accept !== "boolean" ||
      !(vector.expected_runtime_error === null || (
        typeof vector.expected_runtime_error === "string" && /^[A-Z][A-Z0-9_]+$/.test(vector.expected_runtime_error)
      )) ||
      (vector.expected_accept ? vector.expected_runtime_error !== null : vector.expected_runtime_error === null)
    ) {
      fail("FIXTURE_SCHEMA_PARITY_INVALID", `${vector.name} has malformed parity expectations`);
    }
    pointers.add(vector.schema_pointer);

    const fragment = resolveSchemaPointer(schema, vector.schema_pointer);
    const schemaAccepted = schemaFragmentAccepts(schema, fragment, vector.value);
    const candidate = structuredClone(validContract);
    setContractValue(candidate, vector.contract_path, vector.value);
    candidate.digest = ticketContractDigest(candidate);

    let runtimeAccepted = false;
    let runtimeError = null;
    try {
      normalizeTicketContracts([candidate], { knownExternalDependencyIds: ["t01"] });
      runtimeAccepted = true;
    } catch (error) {
      if (!(error instanceof TicketContractError)) throw error;
      runtimeError = error.code;
    }

    if (
      schemaAccepted !== vector.expected_accept ||
      runtimeAccepted !== vector.expected_accept ||
      runtimeError !== vector.expected_runtime_error
    ) {
      fail(
        "FIXTURE_SCHEMA_PARITY_MISMATCH",
        `${vector.name}: expected accept=${vector.expected_accept} error=${vector.expected_runtime_error}; ` +
          `schema accepted=${schemaAccepted}, runtime accepted=${runtimeAccepted}, runtime error=${runtimeError}`,
      );
    }
  }
  const requiredPointers = [
    "#/$defs/nonEmptyString",
    "#/$defs/repoPath",
    "#/$defs/verification/properties/executable",
  ];
  if (requiredPointers.some((pointer) => !pointers.has(pointer))) {
    fail("FIXTURE_SCHEMA_PARITY_INVALID", "lexical parity corpus does not cover every strict lexical definition");
  }
  return { vectors: corpus.vectors.length, definitions: pointers.size };
}

function validateSchema(schema) {
  assertObject(schema, "FIXTURE_SCHEMA_INVALID", "schema");
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.additionalProperties !== false) {
    fail("FIXTURE_SCHEMA_INVALID", "schema must be draft 2020-12 and strict");
  }
  if (
    schema.properties?.schema_version?.const !== "1.0.0" ||
    schema.properties?.digest?.pattern !== "^sha256:[0-9a-f]{64}$"
  ) {
    fail("FIXTURE_SCHEMA_INVALID", "schema identity or digest is not frozen");
  }
  if (
    schema.$defs?.verification?.additionalProperties !== false ||
    schema.$defs?.verification?.properties?.network?.const !== "deny"
  ) {
    fail("FIXTURE_SCHEMA_INVALID", "verification schema is not fail closed");
  }
}

function validateNegativeCorpus(directory, repositoryRoot, exercisedFixtures) {
  const corpus = readJson(join(directory, "negative-corpus.json"));
  assertExactKeys(
    corpus,
    ["schema_version", "required_categories", "minimum_distinct_error_codes", "cases"],
    ["schema_version", "required_categories", "minimum_distinct_error_codes", "cases"],
    "FIXTURE_NEGATIVE_CORPUS_INVALID",
    "negative-corpus",
  );
  if (corpus.schema_version !== "1.0.0") {
    fail("FIXTURE_NEGATIVE_CORPUS_INVALID", "negative corpus schema version is not frozen");
  }
  if (
    !Array.isArray(corpus.required_categories) ||
    new Set(corpus.required_categories).size !== corpus.required_categories.length ||
    REQUIRED_CATEGORIES.some((category) => !corpus.required_categories.includes(category))
  ) {
    fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", "negative corpus is missing a required category");
  }
  if (!Number.isSafeInteger(corpus.minimum_distinct_error_codes) || corpus.minimum_distinct_error_codes < 8) {
    fail("FIXTURE_NEGATIVE_CORPUS_INVALID", "minimum_distinct_error_codes is invalid");
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", "negative corpus cases are empty");
  }

  const names = new Set();
  const codes = new Set();
  const categories = new Set();
  const fixtureProofs = new Set();
  for (const [index, entry] of corpus.cases.entries()) {
    assertExactKeys(
      entry,
      ["name", "category", "expected_error", "proof"],
      ["name", "category", "expected_error", "proof"],
      "FIXTURE_NEGATIVE_CORPUS_INVALID",
      `negative-corpus.cases[${index}]`,
    );
    if (typeof entry.name !== "string" || entry.name.trim() === "" || names.has(entry.name)) {
      fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `case ${index} has an invalid or duplicate name`);
    }
    names.add(entry.name);
    if (typeof entry.category !== "string" || !corpus.required_categories.includes(entry.category)) {
      fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `${entry.name} has an unknown category`);
    }
    categories.add(entry.category);
    if (typeof entry.expected_error !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(entry.expected_error)) {
      fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `${entry.name} has an invalid stable error`);
    }
    codes.add(entry.expected_error);
    if (typeof entry.proof !== "string" || entry.proof.trim() === "") {
      fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `${entry.name} has no proof reference`);
    }
    const proof = resolve(directory, entry.proof);
    if (!isEqualOrBelow(repositoryRoot, proof) || !existsSync(proof)) {
      fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `${entry.name} proof is missing or outside the repository`);
    }
    if (!readFileSync(proof, "utf8").includes(entry.expected_error)) {
      fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `${entry.name} proof does not name ${entry.expected_error}`);
    }
    const invalidRelative = relative(join(directory, "invalid"), proof);
    if (!invalidRelative.startsWith("..") && invalidRelative.endsWith(".json")) {
      fixtureProofs.add(invalidRelative);
      if (exercisedFixtures.get(invalidRelative) !== entry.expected_error) {
        fail("FIXTURE_NEGATIVE_CORPUS_INVALID", `${entry.name} proof was not exercised with its declared error`);
      }
    }
  }
  for (const file of exercisedFixtures.keys()) {
    if (!fixtureProofs.has(file)) {
      fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", `${file} is not inventoried`);
    }
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", `${category} has no case`);
  }
  if (codes.size < corpus.minimum_distinct_error_codes) {
    fail(
      "FIXTURE_NEGATIVE_CORPUS_INCOMPLETE",
      `expected ${corpus.minimum_distinct_error_codes} distinct stable errors, found ${codes.size}`,
    );
  }
  return { cases: corpus.cases.length, categories: categories.size, codes };
}

function main() {
  const directory = process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/ticket-contract")
    : resolve(process.argv[2]);
  const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const schema = readJson(join(repositoryRoot, "docs/architecture/reliability/ticket-contract.schema.json"));
  validateSchema(schema);

  const valid = readJson(join(directory, "valid.json"));
  const [contract] = normalizeTicketContracts([valid], {
    knownExternalDependencyIds: ["t01"],
  });
  const lexical = validateLexicalParity(directory, schema, valid);

  const vectors = readJson(join(directory, "canonicalization-vectors.json"));
  if (vectors.schema_version !== "1.0.0" || !Array.isArray(vectors.vectors) || vectors.vectors.length < 2) {
    fail("FIXTURE_VECTOR_INVALID", "at least two canonicalization vectors are required");
  }
  for (const vector of vectors.vectors) {
    assertExactKeys(
      vector,
      ["name", "input", "permuted_input", "expected_digest"],
      ["name", "input", "permuted_input", "expected_digest"],
      "FIXTURE_VECTOR_INVALID",
      "vector",
    );
    if (
      ticketContractDigest(vector.input) !== vector.expected_digest ||
      ticketContractDigest(vector.permuted_input) !== vector.expected_digest ||
      canonicalJson(vector.input) !== canonicalJson(vector.permuted_input)
    ) {
      fail("FIXTURE_VECTOR_MISMATCH", `${vector.name} is not canonicalization-stable`);
    }
  }

  const invalidDirectory = join(directory, "invalid");
  const invalidFiles = readdirSync(invalidDirectory).filter((name) => name.endsWith(".json")).sort();
  if (invalidFiles.length < 8) {
    fail("FIXTURE_NEGATIVE_CORPUS_INCOMPLETE", "at least eight invalid fixtures are required");
  }
  const exercisedFixtures = new Map();
  const observedCodes = new Set();
  for (const name of invalidFiles) {
    const fixture = readJson(join(invalidDirectory, name));
    assertExactKeys(
      fixture,
      ["name", "expected_error", "context", "mutations"],
      ["name", "expected_error", "mutations"],
      "FIXTURE_INVALID_CASE",
      name,
    );
    const invalidContract = applyMutations(valid, fixture.mutations);
    try {
      normalizeTicketContracts([invalidContract], {
        knownExternalDependencyIds: ["t00", "t01"],
      });
      fail("FIXTURE_INVALID_ACCEPTED", `${name} unexpectedly passed`);
    } catch (error) {
      if (!(error instanceof TicketContractError)) throw error;
      if (error.code !== fixture.expected_error) {
        fail("FIXTURE_ERROR_MISMATCH", `${name}: expected ${fixture.expected_error}, received ${error.code}`);
      }
      observedCodes.add(error.code);
      exercisedFixtures.set(name, error.code);
    }
  }

  const negative = validateNegativeCorpus(directory, repositoryRoot, exercisedFixtures);
  const allCodes = new Set([...observedCodes, ...negative.codes]);
  process.stdout.write(`${JSON.stringify({
    schema_version: "1.0.0",
    valid_digest: contract.digest,
    canonicalization_vectors: vectors.vectors.length,
    lexical_parity_vectors: lexical.vectors,
    lexical_parity_definitions: lexical.definitions,
    invalid_fixtures: invalidFiles.length,
    negative_cases: negative.cases,
    negative_categories: negative.categories,
    stable_error_codes: [...allCodes].sort(),
  })}\n`);
}

let compiledRuntimeRoot;
try {
  compiledRuntimeRoot = await compileAndLoadContractRuntime();
  main();
} catch (error) {
  const isContractError = typeof TicketContractError === "function" && error instanceof TicketContractError;
  const code = error instanceof FixtureError || isContractError
    ? error.code
    : "FIXTURE_VALIDATOR_INTERNAL";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exit(1);
} finally {
  if (compiledRuntimeRoot) rmSync(compiledRuntimeRoot, { recursive: true, force: true });
}
