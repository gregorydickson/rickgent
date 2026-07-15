#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const DEFAULT_CONTRACT = "docs/architecture/reliability/evidence-provenance.json";
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function usage(message) {
  if (message) console.error(`evidence-provenance: ${message}`);
  console.error(
    "usage: node orchestrator/scripts/validate-evidence-provenance.mjs " +
      "[--contract <repository-relative-path>] [--require-clean]",
  );
  process.exit(2);
}

let contractPath = DEFAULT_CONTRACT;
let requireClean = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--contract") {
    const value = process.argv[++i];
    if (!value || value.startsWith("--")) usage("--contract requires a path");
    contractPath = value;
  } else if (arg === "--require-clean") {
    requireClean = true;
  } else {
    usage(`unknown argument: ${arg}`);
  }
}

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: options.encoding ?? "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(relativePath) {
  check(
    typeof relativePath === "string" && relativePath.length > 0 && !isAbsolute(relativePath),
    `path must be non-empty and repository-relative: ${String(relativePath)}`,
  );
  const absolute = resolve(repo, relativePath || ".");
  check(
    absolute === repo || absolute.startsWith(`${repo}${sep}`),
    `path escapes repository: ${String(relativePath)}`,
  );
  return absolute;
}

function currentFileHash(artifact, label) {
  check(artifact && typeof artifact.path === "string", `${label} is missing path`);
  check(artifact && HEX_64.test(artifact.sha256 ?? ""), `${label} has invalid SHA-256`);
  if (!artifact || typeof artifact.path !== "string") return;
  try {
    const actual = sha256(readFileSync(repositoryPath(artifact.path)));
    check(actual === artifact.sha256, `${label} SHA-256 mismatch: ${artifact.path}`);
  } catch (error) {
    errors.push(`${label} cannot be read: ${artifact.path}: ${error.message}`);
  }
}

function committedFileHash(commit, artifact, label) {
  check(artifact && typeof artifact.path === "string", `${label} is missing path`);
  check(artifact && HEX_64.test(artifact.sha256 ?? ""), `${label} has invalid SHA-256`);
  if (!artifact || typeof artifact.path !== "string") return;
  try {
    const contents = git(repo, ["show", `${commit}:${artifact.path}`], { encoding: "buffer" });
    check(sha256(contents) === artifact.sha256, `${label} committed SHA-256 mismatch: ${artifact.path}`);
  } catch (error) {
    errors.push(`${label} is absent from ${commit}: ${artifact.path}: ${error.message}`);
  }
}

function validateCommit(label, record) {
  check(record && HEX_40.test(record.commit_oid ?? record.oid ?? ""), `${label} has invalid commit OID`);
  const oid = record?.commit_oid ?? record?.oid;
  if (!HEX_40.test(oid ?? "")) return;
  const expectedTree = record.tree_oid;
  const expectedParents = record.parent_oids;
  check(HEX_40.test(expectedTree ?? ""), `${label} has invalid tree OID`);
  check(Array.isArray(expectedParents) && expectedParents.every((x) => HEX_40.test(x)), `${label} has invalid parents`);
  try {
    const actualTree = git(repo, ["show", "-s", "--format=%T", oid]).trim();
    const actualParents = git(repo, ["show", "-s", "--format=%P", oid]).trim().split(/\s+/).filter(Boolean);
    check(actualTree === expectedTree, `${label} tree mismatch`);
    check(JSON.stringify(actualParents) === JSON.stringify(expectedParents), `${label} parent mismatch`);
  } catch (error) {
    errors.push(`${label} Git object is unavailable: ${error.message}`);
  }
}

let contract;
try {
  contract = JSON.parse(readFileSync(repositoryPath(contractPath), "utf8"));
} catch (error) {
  console.error(`evidence-provenance: cannot load contract: ${error.message}`);
  process.exit(1);
}

check(contract.schema_version === "1.0.0", "unsupported schema_version");
check(contract.contract_id === "rickgent-remediation-evidence-provenance-v1", "unexpected contract_id");

const historical = contract.historical_review;
check(historical?.role === "historical_evidence", "historical review must be classified as historical_evidence");
check(HEX_40.test(historical?.reviewed_commit_oid ?? ""), "historical reviewed commit is invalid");
check(
  ["current_implementation_head", "omnigent_compatibility", "future_ticket_handoffs"].every((role) =>
    historical?.not_authority_for?.includes(role),
  ),
  "historical review authority exclusions are incomplete",
);
currentFileHash(historical?.artifact, "historical review artifact");

const adoption = contract.authority_adoption;
validateCommit("authority adoption", adoption);
for (const artifact of adoption?.artifacts_at_commit ?? []) {
  committedFileHash(adoption.commit_oid, artifact, "authority adoption artifact");
}
check(adoption?.refinement_session_id === "2026-07-15-d095ff49", "unexpected refinement session ID");

const external = contract.external_authority;
check(external?.system === "omnigent", "external authority system must be omnigent");
check(external?.authority_kind === "behavioral_probe", "external authority must be a behavioral probe");
check(external?.contract_mode === "current-compatible", "external contract must be current-compatible");
check(external?.producing_ticket === "t00", "external authority must be produced by t00");
check(external?.exact_external_git_pin === false, "external authority must not claim an exact Git pin");
check(external?.external_git_oid === null, "external authority must not record an external Git OID");
check(
  external?.historical_review_commit_is_authority === false,
  "historical review commit must not be external compatibility authority",
);
for (const artifact of external?.artifacts ?? []) currentFileHash(artifact, "external authority artifact");

const externalContractArtifact = external?.artifacts?.find(
  (artifact) => artifact.path === "artifacts/reliability/omnigent-compatibility-contract.json",
);
if (externalContractArtifact) {
  try {
    const externalContract = JSON.parse(readFileSync(repositoryPath(externalContractArtifact.path), "utf8"));
    check(externalContract.contract_mode === "current-compatible", "Omnigent contract mode drifted");
    check(
      externalContract.compatibility_authority?.exact_commit_pin === false,
      "Omnigent contract unexpectedly claims an exact commit pin",
    );
    check(!("required_sha" in externalContract), "Omnigent contract must not contain required_sha");
    check(!("sha_source" in externalContract), "Omnigent contract must not contain sha_source");
  } catch (error) {
    errors.push(`cannot validate Omnigent compatibility contract: ${error.message}`);
  }
}

const handoff = contract.implementation_handoff;
check(handoff?.ticket_id === "t01", "implementation handoff ticket must be t01");
check(handoff?.execution_mode === "sequential", "implementation handoff must be sequential");
check(handoff?.branch === "remediation/trust-spine-phase-1", "unexpected implementation branch");
validateCommit("implementation input", handoff?.input_commit);
committedFileHash(handoff?.input_commit?.oid, handoff?.input_manifest, "implementation input manifest");

const snapshot = handoff?.baseline_snapshot;
const expectedStatusArgv = ["git", "status", "--porcelain=v2", "-z", "--untracked-files=all"];
check(JSON.stringify(snapshot?.argv) === JSON.stringify(expectedStatusArgv), "baseline snapshot argv mismatch");
check(snapshot?.encoding === "raw_nul_delimited_bytes", "baseline snapshot encoding mismatch");
check(snapshot?.clean === true, "t01 baseline must be clean");
check(snapshot?.byte_length === 0, "clean t01 baseline must contain zero bytes");
check(snapshot?.sha256 === sha256(Buffer.alloc(0)), "clean t01 baseline digest must hash zero raw bytes");
check(Array.isArray(snapshot?.preexisting_changes) && snapshot.preexisting_changes.length === 0, "clean t01 baseline cannot list pre-existing changes");

const expectedChanges = [
  "docs/architecture/reliability/evidence-provenance.json",
  "docs/architecture/reliability/evidence-provenance.md",
  "docs/remediation/trust-spine-manifest.json",
  "orchestrator/scripts/validate-evidence-provenance.mjs",
];
check(
  JSON.stringify(handoff?.reviewed_change_set) === JSON.stringify(expectedChanges),
  "t01 reviewed change set mismatch",
);

const sequential = contract.sequential_handoff_contract;
for (const key of [
  "require_single_parent",
  "require_predecessor_output_as_input",
  "require_clean_entry_and_exit",
  "preserve_preexisting_user_changes_byte_for_byte",
  "abort_on_unreviewed_or_changed_dirty_state",
  "stage_only_reviewed_changed_paths",
  "forbid_bulk_staging",
  "require_independently_rerunnable_verification",
]) {
  check(sequential?.[key] === true, `sequential handoff rule must be true: ${key}`);
}
check(
  sequential?.output_artifacts_semantics === "minimum_required_outputs_not_changed_path_allowlist",
  "output_artifacts semantics must be minimum outputs, not an allowlist",
);
check(
  JSON.stringify(sequential?.required_commit_trailers) === JSON.stringify(["Rickgent-Ticket", "Rickgent-Input-Oid"]),
  "required commit trailers mismatch",
);

for (const [key, value] of Object.entries(contract.conflation_guards ?? {})) {
  check(value === true, `conflation guard must be true: ${key}`);
}
check(historical?.reviewed_commit_oid !== adoption?.commit_oid, "historical and adoption commits must differ");
check(adoption?.commit_oid !== handoff?.input_commit?.oid, "adoption and implementation input commits must differ");
check(historical?.reviewed_commit_oid !== handoff?.input_commit?.oid, "historical and implementation input commits must differ");

for (const [ancestor, descendant, label] of [
  [historical?.reviewed_commit_oid, adoption?.commit_oid, "historical review -> adoption"],
  [adoption?.commit_oid, handoff?.input_commit?.oid, "adoption -> implementation input"],
]) {
  const result = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
  check(result.status === 0, `ancestry mismatch: ${label}`);
}

try {
  const branch = git(repo, ["branch", "--show-current"]).trim();
  check(branch === handoff.branch, `live branch mismatch: expected ${handoff.branch}, got ${branch || "detached"}`);

  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const input = handoff.input_commit.oid;
  const ancestry = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", input, head]);
  check(ancestry.status === 0, "implementation input is not an ancestor of live HEAD");

  if (head !== input && ancestry.status === 0) {
    const path = git(repo, ["rev-list", "--ancestry-path", "--reverse", `${input}..${head}`])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const ticketCommit = path[0];
    check(Boolean(ticketCommit), "cannot locate t01 output commit");
    if (ticketCommit) {
      const parents = git(repo, ["show", "-s", "--format=%P", ticketCommit]).trim().split(/\s+/).filter(Boolean);
      check(JSON.stringify(parents) === JSON.stringify([input]), "t01 output must be single-parent over its input");
      const subject = git(repo, ["show", "-s", "--format=%s", ticketCommit]).trim();
      const body = git(repo, ["show", "-s", "--format=%B", ticketCommit]);
      check(subject === handoff.expected_commit.subject, "t01 commit subject mismatch");
      for (const [name, value] of Object.entries(handoff.expected_commit.trailers)) {
        check(body.includes(`${name}: ${value}`), `t01 commit trailer mismatch: ${name}`);
      }
      const changed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", ticketCommit])
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .sort();
      check(JSON.stringify(changed) === JSON.stringify(expectedChanges), "t01 committed changed paths differ from reviewed change set");
    }
  }
} catch (error) {
  errors.push(`cannot validate live sequential handoff: ${error.message}`);
}

try {
  const manifest = JSON.parse(readFileSync(repositoryPath("docs/remediation/trust-spine-manifest.json"), "utf8"));
  const tickets = manifest.tickets?.filter((ticket) => ticket.id === "t01") ?? [];
  check(tickets.length === 1, "manifest must contain exactly one t01 entry");
  const ticket = tickets[0];
  for (const output of [
    "docs/project-completion-reliability-review-2026-07-15.md",
    ...expectedChanges.filter((path) => path !== "docs/remediation/trust-spine-manifest.json"),
  ]) {
    check(ticket?.output_artifacts?.includes(output), `manifest t01 output missing: ${output}`);
  }
  check(
    ticket?.artifact_scope === "minimum_required_outputs_not_changed_path_allowlist",
    "manifest t01 artifact_scope mismatch",
  );
  check(
    ticket?.reviewed_change_set?.join("\n") === expectedChanges.join("\n"),
    "manifest t01 reviewed_change_set mismatch",
  );
  check(
    ticket?.verification?.includes(
      "node orchestrator/scripts/validate-evidence-provenance.mjs --contract docs/architecture/reliability/evidence-provenance.json",
    ),
    "manifest t01 is missing the executable provenance check",
  );
} catch (error) {
  errors.push(`cannot validate remediation manifest: ${error.message}`);
}

if (requireClean) {
  try {
    const status = git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { encoding: "buffer" });
    check(status.length === snapshot.byte_length, "live status byte length differs from clean baseline");
    check(sha256(status) === snapshot.sha256, "live status digest differs from clean baseline");
  } catch (error) {
    errors.push(`cannot validate live clean state: ${error.message}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`evidence-provenance: FAIL: ${error}`);
  process.exit(1);
}

console.log(
  `evidence-provenance: PASS schema=${contract.schema_version} input=${handoff.input_commit.oid} ` +
    `external=${external.contract_mode} clean_check=${requireClean ? "live" : "recorded"}`,
);
