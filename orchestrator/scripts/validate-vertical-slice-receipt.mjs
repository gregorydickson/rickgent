#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}$/;
const PHASES = [
  "native-policy",
  "ownership",
  "worktree",
  "ref",
  "index",
  "lease",
  "process",
  "scope-clean-commit",
  "review",
  "remediation",
  "gate",
  "oracle",
  "cleanup",
  "push",
  "pull-request",
  "delivery-oid",
];

function fail(message) {
  process.stderr.write(`validate-vertical-slice-receipt: ${message}\n`);
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

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length) fail(`${name} requires a path`);
  return resolve(process.argv[index + 1]);
}

function parseCanonical(path, schemaVersion) {
  let value;
  const bytes = readFileSync(path);
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    fail(`${basename(path)} is invalid JSON: ${error.message}`);
  }
  if (value?.schema_version !== schemaVersion || !SHA256.test(value?.digest ?? "")) {
    fail(`${basename(path)} has the wrong schema or digest`);
  }
  const { digest, ...unsigned } = value;
  if (digest !== sha256(canonical(unsigned))) fail(`${basename(path)} digest does not match its content`);
  if (bytes.toString("utf8") !== `${canonical(value)}\n`) fail(`${basename(path)} is not canonical JSON`);
  return { bytes, value };
}

function equal(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) fail(`${label} does not match its authority`);
}

function requireTrue(value, label) {
  if (value !== true) fail(`${label} must be independently true`);
}

const receiptPath = resolve(process.argv[2] ?? "artifacts/reliability/vertical-slice-receipt.json");
const packedPath = option("--packed-receipt", join(dirname(receiptPath), "packed-install-summary.json"));
const preflightPath = option("--preflight", join(dirname(receiptPath), "protected-release-preflight.json"));
for (const path of [receiptPath, packedPath, preflightPath]) {
  if (!existsSync(path)) fail(`${path} does not exist`);
}

const receiptResult = parseCanonical(receiptPath, "1.0.0");
const receipt = receiptResult.value;
const packed = parseCanonical(packedPath, "1.0.0").value;
const preflight = parseCanonical(preflightPath, "rickgent-protected-release-preflight/v1").value;

const sidecarPath = join(dirname(receiptPath), "vertical-slice-receipt.sha256");
if (!existsSync(sidecarPath)) fail("receipt SHA-256 sidecar is missing");
const expectedSidecar = `${sha256(receiptResult.bytes)}  ${basename(receiptPath)}\n`;
if (readFileSync(sidecarPath, "utf8") !== expectedSidecar) fail("receipt SHA-256 sidecar does not match exact bytes");

const diagnosticsPath = join(dirname(receiptPath), "vertical-slice-failure-diagnostics.json");
const diagnostics = parseCanonical(
  diagnosticsPath,
  "rickgent-protected-release-diagnostics/v1",
).value;
equal(diagnostics.status, "clear", "diagnostics.status");
equal(diagnostics.codes, [], "diagnostics.codes");
equal(diagnostics.infrastructure_errors, [], "diagnostics.infrastructure_errors");
equal(diagnostics.skipped_required, [], "diagnostics.skipped_required");

equal(preflight.status, "accepted", "preflight.status");
equal(preflight.mode, "preflight_only", "preflight.mode");
equal(receipt.binding.source_git_oid, packed.binding.source_git_oid, "source Git OID");
equal(receipt.binding.source_git_oid, preflight.binding.source_git_oid, "preflight source Git OID");
equal(receipt.binding.build, packed.binding.build, "packed build");
equal(receipt.binding.build.id, preflight.binding.build_id, "preflight build ID");
equal(receipt.binding.build.sha256, preflight.binding.build_resource_sha256, "preflight build digest");
equal(receipt.binding.npm_archive_sha256, preflight.binding.npm_archive_sha256, "npm archive");
equal(receipt.binding.wheel_archive_sha256, preflight.binding.wheel_archive_sha256, "wheel archive");
equal(receipt.binding.packed_install_receipt_sha256, packed.digest, "packed receipt digest");
equal(receipt.binding.packed_install_receipt_sha256, preflight.binding.packed_receipt_sha256, "preflight packed receipt");
equal(packed.binding.omnigent_contract_sha256, preflight.binding.omnigent_contract_sha256, "Omnigent contract");

equal(receipt.repository, {
  allowlisted_disposable: true,
  base_branch: preflight.remote.base_branch,
  host: preflight.remote.host,
  name: preflight.remote.repository,
  owned_branch_prefix: preflight.remote.owned_namespace,
  owner: preflight.remote.owner,
  pre_existing: true,
  repository_id: preflight.remote.repository_id,
}, "repository binding");
equal(receipt.cleanup.repository_deleted, false, "repository deletion");
equal(receipt.evidence.contains_raw_secrets, false, "raw-secret flag");
equal(receipt.evidence.fixture_substitution, false, "fixture-substitution flag");

if (!Array.isArray(receipt.runs) || receipt.runs.length !== 2) fail("exactly two logical runs are required");
const runIds = new Set();
const stateIds = new Set();
const processIds = new Set();
let priorEndedAt = null;
for (const [index, run] of receipt.runs.entries()) {
  const number = index + 1;
  const expectedRunId = `protected-${number}`;
  equal(run.run_id, expectedRunId, `run ${number} ID`);
  if (runIds.has(run.run_id)) fail("logical run IDs are not distinct");
  if (stateIds.has(run.persistent_state_id)) fail("persistent state IDs are not distinct between runs");
  runIds.add(run.run_id);
  stateIds.add(run.persistent_state_id);
  requireTrue(run.containment_passed, `${run.run_id}.containment_passed`);

  if (!Array.isArray(run.attempts) || run.attempts.length !== 2) {
    fail(`${run.run_id} must contain exactly one crash and one resume attempt`);
  }
  const [crash, resume] = run.attempts;
  equal(crash.phase, "crash", `${run.run_id} crash phase`);
  equal(resume.phase, "resume", `${run.run_id} resume phase`);
  equal(crash.attempt_id, `${run.run_id}:crash`, `${run.run_id} crash attempt ID`);
  equal(resume.attempt_id, `${run.run_id}:resume`, `${run.run_id} resume attempt ID`);
  requireTrue(crash.death_observed, `${run.run_id} crash process-group death`);
  equal(resume.death_observed, false, `${run.run_id} resume death observation`);
  for (const attempt of [crash, resume]) {
    if (!Number.isInteger(attempt.process_id) || attempt.process_id < 1) fail(`${attempt.attempt_id} has no process identity`);
    if (attempt.process_group_id !== attempt.process_id) fail(`${attempt.attempt_id} is not a distinct process-group leader`);
    if (processIds.has(attempt.process_id)) fail("process identity was reused across attempts");
    processIds.add(attempt.process_id);
    if (!(Date.parse(attempt.started_at) < Date.parse(attempt.ended_at))) fail(`${attempt.attempt_id} timestamps are invalid`);
  }
  if (crash.process_id === resume.process_id) fail(`${run.run_id} resume reused the crashed process`);
  if (Date.parse(crash.ended_at) !== Date.parse(resume.started_at)) fail(`${run.run_id} resume is not continuous with crash death`);
  if (priorEndedAt !== null && !(priorEndedAt < Date.parse(crash.started_at))) {
    fail("Run 1 cleanup is not temporally before Run 2");
  }
  priorEndedAt = Date.parse(resume.ended_at);

  if (!run.installed_executable_realpath.endsWith("/npm/node_modules/rickgent/dist/cli.js")) {
    fail(`${run.run_id} did not retain the installed production entrypoint`);
  }
  equal(run.installed_executable_realpath, receipt.runs[0].installed_executable_realpath, "installed executable continuity");

  const delivery = run.delivery;
  for (const key of ["delivery_oid", "observed_branch_oid", "pull_request_head_oid"]) {
    if (!OID.test(delivery?.[key] ?? "")) fail(`${run.run_id}.${key} is not a full Git OID`);
  }
  equal(delivery.delivery_oid, delivery.observed_branch_oid, `${run.run_id} pushed branch OID`);
  equal(delivery.delivery_oid, delivery.pull_request_head_oid, `${run.run_id} pull-request head OID`);
  equal(delivery.delivery_oid, run.cleanup.branch_compare_before_delete_oid, `${run.run_id} cleanup OID`);
  equal(delivery.branch, `${preflight.remote.owned_namespace}/${run.run_id}`, `${run.run_id} owned branch`);
  equal(delivery.duplicate_side_effects, false, `${run.run_id} duplicate side effects`);
  requireTrue(run.cleanup.owned_branch_absent_on_requery, `${run.run_id} branch cleanup`);
  requireTrue(run.cleanup.owned_pull_request_closed, `${run.run_id} pull-request cleanup`);
  requireTrue(run.cleanup.repository_preserved, `${run.run_id} repository preservation`);

  const observations = new Map((run.model_observations ?? []).map((item) => [item.role, item]));
  const implementation = observations.get("implementation");
  const review = observations.get("review");
  equal(
    [implementation?.adapter, implementation?.requested_model, implementation?.invoked_model],
    ["codex-cli", "gpt-5.6-sol", "gpt-5.6-sol"],
    `${run.run_id} implementation dispatch`,
  );
  equal(
    [review?.adapter, review?.requested_model, review?.invoked_model],
    ["claude-code", "claude-opus-4-8[1m]", "claude-opus-4-8[1m]"],
    `${run.run_id} review dispatch`,
  );
  if (implementation?.process_id !== crash.process_id || review?.process_id !== resume.process_id) {
    fail(`${run.run_id} model observations are not bound to their attempt processes`);
  }
}

const evidenceIds = new Set(receipt.evidence.items.map((item) => item.evidence_id));
const missingDerivations = [];
for (let number = 1; number <= 2; number += 1) {
  for (const provider of ["openai", "anthropic"]) {
    const id = `run:${number}:identity:${provider}`;
    if (!evidenceIds.has(id)) missingDerivations.push(id);
  }
  for (const phase of PHASES) {
    const id = `run:${number}:phase:${phase}`;
    if (!evidenceIds.has(id)) missingDerivations.push(id);
  }
}
if (missingDerivations.length > 0) {
  fail(
    `required independently derived evidence is absent (${missingDerivations.join(", ")}); `
    + "corpus digests and asserted lifecycle/model fields do not prove execution",
  );
}

process.stdout.write("validate-vertical-slice-receipt: complete protected evidence passed\n");
