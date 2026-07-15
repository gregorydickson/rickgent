#!/usr/bin/env node

import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContractError(code, message);
}

function readJson(path, code = "TRUST_CONTRACT_JSON_INVALID") {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(code, `${path}: ${error.message}`);
  }
}

function object(value, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
  return value;
}

function equal(actual, expected, code, label) {
  if (actual !== expected) fail(code, `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function array(value, code, label) {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  return value;
}

function versionTuple(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) fail("TRUST_TOOLCHAIN_VERSION_INVALID", `invalid version ${value}`);
  return match.slice(1).map(Number);
}

function compareVersion(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function requireRange(version, minimum, maximum, label) {
  if (compareVersion(version, minimum) < 0 || compareVersion(version, maximum) >= 0) {
    fail("RICKGENT_TOOLCHAIN_INFRASTRUCTURE_ERROR", `${label} ${version} is outside >=${minimum} <${maximum}`);
  }
}

function resolveExecutable(name) {
  if (name.startsWith("/")) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue without invoking a shell or platform-specific lookup helper.
    }
  }
  return undefined;
}

function validateTicketContractDecision(contract, root) {
  const ticket = object(contract.ticket_contract, "TRUST_TICKET_CONTRACT_INVALID", "ticket_contract");
  equal(ticket.schema_version, "1.0.0", "TRUST_TICKET_CONTRACT_INVALID", "ticket_contract.schema_version");
  equal(ticket.schema, "docs/architecture/reliability/ticket-contract.schema.json", "TRUST_TICKET_CONTRACT_INVALID", "ticket_contract.schema");
  equal(ticket.canonicalization, "rickgent-canonical-json-v1", "TRUST_TICKET_CONTRACT_INVALID", "ticket_contract.canonicalization");
  equal(ticket.raw_shell_allowed, false, "TRUST_TICKET_CONTRACT_INVALID", "ticket_contract.raw_shell_allowed");
  equal(ticket.no_op_result, "RICKGENT_NO_OP_REJECTED", "TRUST_TICKET_CONTRACT_INVALID", "ticket_contract.no_op_result");
  const schema = readJson(resolve(root, ticket.schema), "TRUST_TICKET_SCHEMA_INVALID");
  equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", "TRUST_TICKET_SCHEMA_INVALID", "TicketContract $schema");
  equal(schema.additionalProperties, false, "TRUST_TICKET_SCHEMA_INVALID", "TicketContract additionalProperties");
  equal(schema.properties?.schema_version?.const, "1.0.0", "TRUST_TICKET_SCHEMA_INVALID", "TicketContract schema version");
  equal(schema.$defs?.verification?.properties?.network?.const, "deny", "TRUST_TICKET_SCHEMA_INVALID", "TicketContract verification network");
}

function validateState(contract) {
  const stateRoot = object(contract.state_root, "TRUST_STATE_ROOT_INVALID", "state_root");
  equal(stateRoot.default, "<canonical-git-common-dir>/rickgent/state.sqlite3", "TRUST_STATE_ROOT_INVALID", "state_root.default");
  equal(stateRoot.caller_cwd_authoritative, false, "TRUST_STATE_ROOT_INVALID", "state_root.caller_cwd_authoritative");
  equal(stateRoot.symlink_allowed, false, "TRUST_STATE_ROOT_INVALID", "state_root.symlink_allowed");
  equal(stateRoot.unsafe_root_result, "RICKGENT_STATE_ROOT_UNSAFE", "TRUST_STATE_ROOT_INVALID", "state_root.unsafe_root_result");

  const graphs = object(contract.state_graphs, "TRUST_STATE_GRAPH_INVALID", "state_graphs");
  const attempt = object(graphs.attempt, "TRUST_STATE_GRAPH_INVALID", "state_graphs.attempt");
  for (const terminal of ["failed_clean", "quarantined", "verified"]) if (!attempt.terminal?.includes(terminal)) fail("TRUST_STATE_GRAPH_INVALID", `attempt terminal ${terminal} is missing`);
  equal(attempt.timeout_is_terminal, false, "TRUST_STATE_GRAPH_INVALID", "attempt.timeout_is_terminal");
  equal(attempt.transition_owner, "transactional transition service", "TRUST_STATE_GRAPH_INVALID", "attempt.transition_owner");
  equal(graphs.ticket?.ready_transition_owner, "versioned completion oracle plus finalization service", "TRUST_STATE_GRAPH_INVALID", "ticket.ready_transition_owner");
  equal(graphs.run?.delivered_transition_owner, "verified delivery service", "TRUST_STATE_GRAPH_INVALID", "run.delivered_transition_owner");
}

function validateCapabilities(contract) {
  const expected = new Map([
    ["autonomous_dispatch", ["fixture_only", "RICKGENT_AUTONOMOUS_FIXTURE_ONLY"]],
    ["parallel_dispatch", ["unavailable", "RICKGENT_PARALLEL_DISPATCH_UNAVAILABLE"]],
    ["resume_retry", ["unavailable", "RICKGENT_RESUME_UNAVAILABLE"]],
    ["reconciliation", ["unavailable", "RICKGENT_RECONCILIATION_UNAVAILABLE"]],
    ["cross_vendor_review", ["unavailable", "RICKGENT_CROSS_VENDOR_UNAVAILABLE"]],
    ["automatic_delivery", ["unavailable", "RICKGENT_DELIVERY_UNAVAILABLE"]],
    ["raw_shell", ["unavailable", "RICKGENT_RAW_SHELL_UNAVAILABLE"]],
  ]);
  const entries = array(contract.capability_registry, "TRUST_CAPABILITY_INVALID", "capability_registry");
  if (entries.length !== expected.size) fail("TRUST_CAPABILITY_INVALID", "capability registry is incomplete");
  for (const entry of entries) {
    if (!expected.has(entry.name)) fail("TRUST_CAPABILITY_INVALID", `unknown capability ${entry.name}`);
    const [state, code] = expected.get(entry.name);
    equal(entry.m1_state, state, "TRUST_CAPABILITY_INVALID", `${entry.name}.m1_state`);
    equal(entry.error_code, code, "TRUST_CAPABILITY_INVALID", `${entry.name}.error_code`);
    if (!entry.reason || !entry.proof_version || !entry.minimum_profile) fail("TRUST_CAPABILITY_INVALID", `${entry.name} lacks activation metadata`);
    expected.delete(entry.name);
  }

  equal(contract.activation_boundary?.decision_artifacts_enable_capabilities, false, "TRUST_ACTIVATION_BOUNDARY_INVALID", "activation boundary");
  const matrix = array(contract.public_m1_mutation_matrix, "TRUST_MUTATION_MATRIX_INVALID", "public_m1_mutation_matrix");
  const fixture = matrix.find((entry) => entry.surface === "fixture_dispatch");
  if (fixture?.mode !== "explicit_test_dependency_injection" || fixture?.result !== "nonterminal_receipt") fail("TRUST_MUTATION_MATRIX_INVALID", "fixture dispatch is not explicitly nonterminal");
  for (const surface of ["build", "pipeline", "resume_retry", "reconcile", "parallel_dispatch", "automatic_delivery"]) {
    const row = matrix.find((entry) => entry.surface === surface);
    if (!row || row.mutation !== "denied") fail("TRUST_MUTATION_MATRIX_INVALID", `${surface} is not denied at M1`);
  }
}

function validateExecution(contract) {
  const worker = object(contract.worker_dispatch, "TRUST_WORKER_DISPATCH_INVALID", "worker_dispatch");
  equal(worker.m1_mode, "fixture_only", "TRUST_WORKER_DISPATCH_INVALID", "worker_dispatch.m1_mode");
  equal(worker.manager_bundle_is_spawn_target, false, "TRUST_WORKER_DISPATCH_INVALID", "manager bundle boundary");
  equal(worker.worker_git_mutation_allowed, false, "TRUST_WORKER_DISPATCH_INVALID", "worker Git boundary");
  equal(worker.worker_terminalization_allowed, false, "TRUST_WORKER_DISPATCH_INVALID", "worker terminal boundary");

  const supervisor = object(contract.process_supervisor, "TRUST_SUPERVISOR_INVALID", "process_supervisor");
  equal(supervisor.argv_only, true, "TRUST_SUPERVISOR_INVALID", "supervisor argv_only");
  equal(supervisor.new_process_group, true, "TRUST_SUPERVISOR_INVALID", "supervisor process group");

  const profiles = object(contract.sandbox_profiles, "TRUST_SANDBOX_INVALID", "sandbox_profiles");
  const expectations = { darwin: ["sandbox-exec", "/usr/bin/sandbox-exec"], linux: ["bwrap", "bwrap"] };
  for (const [platform, [backend, executable]] of Object.entries(expectations)) {
    const profile = object(profiles[platform], "TRUST_SANDBOX_INVALID", `sandbox_profiles.${platform}`);
    equal(profile.backend, backend, "TRUST_SANDBOX_INVALID", `${platform}.backend`);
    equal(profile.executable, executable, "TRUST_SANDBOX_INVALID", `${platform}.executable`);
    equal(profile.required, true, "TRUST_SANDBOX_INVALID", `${platform}.required`);
    equal(profile.network, "deny", "TRUST_SANDBOX_INVALID", `${platform}.network`);
    equal(profile.git_common_dir, "deny", "TRUST_SANDBOX_INVALID", `${platform}.git_common_dir`);
    equal(profile.unavailable_result, "RICKGENT_SANDBOX_INFRASTRUCTURE_ERROR", "TRUST_SANDBOX_INVALID", `${platform}.unavailable_result`);
  }
  if (!(process.platform in expectations)) fail("RICKGENT_PLATFORM_UNSUPPORTED", `unsupported verification platform ${process.platform}`);
  const activeExecutable = profiles[process.platform].executable;
  if (!resolveExecutable(activeExecutable)) fail("RICKGENT_SANDBOX_INFRASTRUCTURE_ERROR", `${activeExecutable} is not executable`);

  const commit = object(contract.commit_authority, "TRUST_COMMIT_AUTHORITY_INVALID", "commit_authority");
  equal(commit.owner, "orchestrator", "TRUST_COMMIT_AUTHORITY_INVALID", "commit owner");
  equal(commit.worker_commits_allowed, false, "TRUST_COMMIT_AUTHORITY_INVALID", "worker commits");
  equal(commit.earliest_implementation_ticket, "t20", "TRUST_COMMIT_AUTHORITY_INVALID", "commit implementation ticket");
  if (!String(commit.staging).includes("git add -A is forbidden") || !String(commit.m1_behavior).includes("never claim verified")) fail("TRUST_COMMIT_AUTHORITY_INVALID", "commit staging or M1 terminal boundary is incomplete");
}

function validateTerminalAndErrors(contract) {
  const terminal = object(contract.terminal_semantics, "TRUST_TERMINAL_INVALID", "terminal_semantics");
  if (!String(terminal.ready_for_delivery).includes("local oracle") || !String(terminal.delivered).includes("remote branch") || terminal.done_alias !== "delivered") fail("TRUST_TERMINAL_INVALID", "ready/delivered semantics are incomplete");
  const errors = array(contract.exit_error_map, "TRUST_EXIT_MAP_INVALID", "exit_error_map");
  const expected = new Map([["success", 0], ["input_contract", 2], ["capability_unavailable", 3], ["infrastructure", 4], ["execution", 5], ["verification", 6], ["cleanup", 7], ["delivery", 8], ["internal", 70]]);
  const exits = new Set();
  const codes = new Set();
  for (const entry of errors) {
    if (!expected.has(entry.class) || expected.get(entry.class) !== entry.exit_code || exits.has(entry.exit_code) || codes.has(entry.stable_code)) fail("TRUST_EXIT_MAP_INVALID", `invalid or duplicate exit mapping for ${entry.class}`);
    exits.add(entry.exit_code);
    codes.add(entry.stable_code);
    expected.delete(entry.class);
  }
  if (expected.size) fail("TRUST_EXIT_MAP_INVALID", `missing exit classes: ${[...expected.keys()].join(", ")}`);
}

function validateToolchain(contract, root) {
  const expected = {
    node: ">=24.0.0 <25.0.0",
    python: ">=3.12.0 <3.15.0",
    package_manager: "pnpm@10.22.0",
    lockfile: "orchestrator/pnpm-lock.yaml",
    lockfile_version: "9.0",
  };
  const toolchain = object(contract.toolchain, "TRUST_TOOLCHAIN_METADATA_INVALID", "toolchain");
  for (const [key, value] of Object.entries(expected)) equal(toolchain[key], value, "TRUST_TOOLCHAIN_METADATA_INVALID", `toolchain.${key}`);
  if (JSON.stringify(toolchain.supported_platforms) !== JSON.stringify(["darwin", "linux"]) || toolchain.windows?.support !== "fail_fast" || toolchain.windows?.error_code !== "RICKGENT_PLATFORM_UNSUPPORTED") fail("TRUST_TOOLCHAIN_METADATA_INVALID", "platform metadata is invalid");

  const packageJson = readJson(resolve(root, "orchestrator/package.json"), "TRUST_TOOLCHAIN_METADATA_INVALID");
  equal(packageJson.packageManager, expected.package_manager, "TRUST_TOOLCHAIN_METADATA_INVALID", "packageManager");
  equal(packageJson.engines?.node, expected.node, "TRUST_TOOLCHAIN_METADATA_INVALID", "engines.node");
  equal(packageJson.rickgentToolchain?.node?.range, expected.node, "TRUST_TOOLCHAIN_METADATA_INVALID", "rickgentToolchain.node.range");
  equal(packageJson.rickgentToolchain?.python?.range, expected.python, "TRUST_TOOLCHAIN_METADATA_INVALID", "rickgentToolchain.python.range");
  equal(`${packageJson.rickgentToolchain?.packageManager?.name}@${packageJson.rickgentToolchain?.packageManager?.version}`, expected.package_manager, "TRUST_TOOLCHAIN_METADATA_INVALID", "rickgentToolchain.packageManager");

  const pyproject = readFileSync(resolve(root, "rickgent-policies/pyproject.toml"), "utf8");
  if (!pyproject.includes('requires-python = ">=3.12.0,<3.15.0"')) fail("TRUST_TOOLCHAIN_METADATA_INVALID", "Python package range differs from the contract");
  const lockfile = readFileSync(resolve(root, expected.lockfile), "utf8");
  if (!lockfile.startsWith("lockfileVersion: '9.0'")) fail("TRUST_TOOLCHAIN_METADATA_INVALID", "pnpm lockfile version differs from the contract");

  requireRange(process.versions.node, "24.0.0", "25.0.0", "Node");
  const python = spawnSync("python3", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 5000 });
  if (python.error || python.status !== 0) fail("RICKGENT_TOOLCHAIN_INFRASTRUCTURE_ERROR", "python3 is unavailable");
  const pythonVersion = `${python.stdout}${python.stderr}`.trim().replace(/^Python\s+/, "");
  requireRange(pythonVersion, "3.12.0", "3.15.0", "Python");
  return { node: process.versions.node, python: pythonVersion, sandbox: contract.sandbox_profiles[process.platform].backend };
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const root = resolve(dirname(scriptPath), "../..");
  const contractPath = resolve(process.argv[2] ?? "docs/architecture/reliability/trust-spine-contract.json");
  const contract = readJson(contractPath);
  equal(contract.schema_version, "1.0.0", "TRUST_CONTRACT_VERSION_UNSUPPORTED", "schema_version");
  equal(contract.contract_id, "rickgent-trust-spine-v1", "TRUST_CONTRACT_ID_INVALID", "contract_id");
  equal(contract.decision_status, "frozen_decision_only", "TRUST_ACTIVATION_BOUNDARY_INVALID", "decision_status");
  validateTicketContractDecision(contract, root);
  validateState(contract);
  validateCapabilities(contract);
  validateExecution(contract);
  validateTerminalAndErrors(contract);
  const observed = validateToolchain(contract, root);
  const doctor = object(contract.doctor_json_contract, "TRUST_DOCTOR_CONTRACT_INVALID", "doctor_json_contract");
  equal(doctor.release_channel, "reliability_preview", "TRUST_DOCTOR_CONTRACT_INVALID", "doctor release channel");
  equal(doctor.terminal_semantics?.ready_for_delivery, "local_oracle_complete", "TRUST_DOCTOR_CONTRACT_INVALID", "doctor ready semantics");
  equal(doctor.terminal_semantics?.delivered, "remote_delivery_verified", "TRUST_DOCTOR_CONTRACT_INVALID", "doctor delivered semantics");

  process.stdout.write(`${JSON.stringify({ schema_version: contract.schema_version, contract_id: contract.contract_id, decision_status: contract.decision_status, capabilities: contract.capability_registry.length, platform: process.platform, observed_toolchain: observed })}\n`);
}

try {
  main();
} catch (error) {
  const code = error instanceof ContractError ? error.code : "TRUST_CONTRACT_VALIDATOR_INTERNAL";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exit(1);
}
