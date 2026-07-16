#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const RESULT_PREFIX = "RICKGENT_OMNIGENT_PROBE_RESULT=";
const FORBIDDEN_KEYS = new Set(["required_sha", "sha_source"]);

function fail(message) {
  process.stderr.write(`verify-omnigent-contract: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    writeResult: false,
    python: process.env.OMNIGENT_PYTHON,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write-result") {
      parsed.writeResult = true;
      continue;
    }
    if (!["--root", "--python", "--contract", "--result"].includes(arg)) {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    parsed[arg.slice(2)] = value;
    i += 1;
  }
  for (const key of ["root", "contract"]) {
    if (!parsed[key]) fail(`--${key} is required`);
  }
  if (!parsed.python) {
    fail("--python or OMNIGENT_PYTHON is required");
  }
  return parsed;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireNonEmptyStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${label} must be a non-empty string array`);
  }
  return value;
}

function rejectForbiddenKeys(value, path = "contract") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key} is forbidden for the evolving contract`);
    rejectForbiddenKeys(child, `${path}.${key}`);
  }
}

function validateContract(contract) {
  requireObject(contract, "contract");
  if (contract.schema_version !== "1.0.0") fail("unsupported contract schema_version");
  if (contract.contract_mode !== "current-compatible") fail("contract_mode must be current-compatible");
  rejectForbiddenKeys(contract);

  const authority = requireObject(contract.compatibility_authority, "compatibility_authority");
  if (authority.kind !== "behavioral-probe" || authority.exact_commit_pin !== false || authority.failure_is_skippable !== false) {
    fail("compatibility authority must be an unpinned, non-skipping behavioral probe");
  }
  const discovery = requireObject(contract.discovery, "discovery");
  if (
    discovery.mode !== "mounted-root-python-module"
    || discovery.root_env !== "OMNIGENT_ROOT"
    || discovery.python_env !== "OMNIGENT_PYTHON"
    || discovery.runtime_invocation !== "selected-python-module"
    || discovery.path_command_is_authoritative !== false
  ) {
    fail("discovery must bind the mounted root to the selected Python module runtime");
  }

  requireNonEmptyStrings(contract.required_seams, "required_seams");
  const abi = requireObject(contract.function_policy_abi, "function_policy_abi");
  const config = requireObject(abi.config_encoding, "function_policy_abi.config_encoding");
  if (config.key_type !== "string" || config.value_type !== "string" || config.structured_values_inline !== false) {
    fail("FunctionPolicy config must be reference-only string-to-string data");
  }
  requireNonEmptyStrings(config.required_keys, "function_policy_abi.config_encoding.required_keys");
  const event = requireObject(abi.event, "function_policy_abi.event");
  const phases = requireNonEmptyStrings(event.phase_values, "function_policy_abi.event.phase_values");
  const expectedPhases = ["request", "tool_call", "tool_result", "response", "llm_request", "llm_response"];
  if (JSON.stringify(phases) !== JSON.stringify(expectedPhases)) fail("native event phase corpus changed");

  const context = requireObject(contract.trusted_context, "trusted_context");
  if (context.event_context_is_authoritative !== false || context.file_mode !== "0600") {
    fail("trusted context must reject event.context authority and require mode 0600");
  }
  if (context.binding?.function_policy_exposes_conversation_id !== false) {
    fail("contract must record the current conversation-id ABI limitation");
  }

  const observation = requireObject(contract.observed_identity_source, "observed_identity_source");
  for (const field of ["requested", "invoked", "conversation_id", "harness", "model", "provider_vendor"]) {
    requireObject(observation[field], `observed_identity_source.${field}`);
  }
  if (
    observation.harness.strength !== "effective-runtime-config"
    || observation.model.strength !== "harness-reported-or-config-fallback"
    || observation.provider_vendor.strength !== "unavailable-generically"
    || observation.transcript_prose_is_observation !== false
    || observation.router_or_ledger_label_is_observation !== false
  ) {
    fail("observed identity sources overstate current runtime evidence");
  }

  const profiles = requireObject(contract.identity_observation_profiles, "identity_observation_profiles");
  const offline = requireObject(profiles["effective-session-v1"], "effective-session-v1 profile");
  const live = requireObject(profiles["runtime-reported-identity-v1"], "runtime-reported-identity-v1 profile");
  if (offline.allows_strict_identity_completion !== false || offline.allows_cross_vendor_claim !== false) {
    fail("offline profile must not activate strict identity or cross-vendor claims");
  }
  if (
    live.status !== "unavailable-until-live-proof"
    || live.activation?.requires_separate_live_probe !== true
    || live.allows_strict_identity_completion !== false
    || live.allows_cross_vendor_claim !== false
  ) {
    fail("live identity profile must remain unavailable pending separate proof");
  }

  const aliases = requireObject(contract.identity_normalization?.harness_aliases, "harness alias corpus");
  if (Object.keys(aliases).length === 0) fail("harness alias corpus must not be empty");
  const probe = requireObject(contract.supported_compatibility_probe, "supported_compatibility_probe");
  requireNonEmptyStrings(probe.required_checks, "supported_compatibility_probe.required_checks");
  if (probe.offline !== true || probe.network !== "denied" || probe.mutates_omnigent_root !== false) {
    fail("compatibility probe must be offline and non-mutating");
  }
}

function safeRepoPath(rawPath, label) {
  if (isAbsolute(rawPath)) fail(`${label} must be repository-relative`);
  const repoRoot = process.cwd();
  const absolute = resolve(repoRoot, rawPath);
  const rel = relative(repoRoot, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) fail(`${label} escapes the repository`);
  return absolute;
}

function selectedEnvironment() {
  const env = {
    LANG: "C",
    LC_ALL: "C",
    NO_PROXY: "*",
    PYTHONHASHSEED: "0",
    TZ: "UTC",
  };
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const [name, path] of [["root", args.root], ["python", args.python], ["contract", args.contract]]) {
    if (!existsSync(path)) fail(`${name} does not exist: ${path}`);
  }
  const root = realpathSync(args.root);
  // Preserve the selected entrypoint exactly. Resolving a virtualenv's
  // `bin/python` symlink before spawn discards its pyvenv.cfg/site-packages
  // semantics even though the target executable bytes are identical.
  const pythonEntrypoint = resolve(args.python);
  const pythonTarget = realpathSync(pythonEntrypoint);
  const contractPath = realpathSync(args.contract);
  if (!statSync(root).isDirectory()) fail("--root must be a directory");
  if (!statSync(pythonTarget).isFile()) fail("--python must resolve to a file");
  if (!existsSync(resolve(root, "omnigent/policies/function.py"))) {
    fail("mounted root does not contain omnigent/policies/function.py");
  }

  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch (error) {
    fail(`cannot parse contract JSON: ${error.message}`);
  }
  validateContract(contract);

  const probePath = safeRepoPath(contract.supported_compatibility_probe.python_probe, "python_probe");
  if (!existsSync(probePath)) fail(`Python probe does not exist: ${probePath}`);
  const completed = spawnSync(
    pythonEntrypoint,
    ["-I", probePath, "--root", root, "--contract", contractPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: selectedEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 120_000,
    },
  );
  if (completed.error) fail(`probe could not execute: ${completed.error.message}`);
  if (completed.status !== 0) {
    fail(`probe failed with status ${completed.status}\n${completed.stderr || completed.stdout}`);
  }
  const resultLine = completed.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) fail("probe produced no machine-readable result");
  let payload;
  try {
    payload = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  } catch (error) {
    fail(`probe result was invalid JSON: ${error.message}`);
  }
  const result = requireObject(payload.deterministic_result, "deterministic_result");
  if (
    result.contract_id !== contract.contract_id
    || result.probe_id !== contract.supported_compatibility_probe.id
    || result.status !== "compatible"
    || result.network !== "denied"
  ) {
    fail("probe result does not match the contract");
  }
  const requiredChecks = new Set(contract.supported_compatibility_probe.required_checks);
  const observedChecks = new Set((result.checks || []).filter((check) => check.status === "pass").map((check) => check.id));
  const missingChecks = [...requiredChecks].filter((id) => !observedChecks.has(id));
  if (missingChecks.length > 0) fail(`probe omitted required passing checks: ${missingChecks.join(", ")}`);

  const resultPath = safeRepoPath(
    args.result || contract.supported_compatibility_probe.result_artifact,
    "result artifact",
  );
  const serialized = canonicalJson(result);
  if (args.writeResult) {
    const temporary = resolve(dirname(resultPath), `.${basename(resultPath)}.tmp`);
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, resultPath);
  } else {
    if (!existsSync(resultPath)) fail(`deterministic result artifact is missing: ${resultPath}`);
    if (readFileSync(resultPath, "utf8") !== serialized) {
      fail("deterministic result artifact is stale; review the ABI change before using --write-result");
    }
  }
  process.stdout.write(
    `Omnigent contract compatible: ${contract.supported_compatibility_probe.id} `
    + `(runtime version ${payload.runtime_version}; informational only; ${observedChecks.size} checks)\n`,
  );
}

main();
