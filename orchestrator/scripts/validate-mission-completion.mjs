#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const defaultSummary = resolve(
  repositoryRoot,
  "artifacts/reliability/mission-3-completion-summary.json",
);

const requiredCorpora = [
  "orchestrator/test/lifecycle_coverage_manifest.json",
  "orchestrator/test/fixtures/mutation-corpus/manifest.json",
  "rickgent-policies/test/fixtures/native-policy-corpus/manifest.json",
  "orchestrator/test/fixtures/crash-matrix/manifest.json",
  "orchestrator/test/fixtures/concurrency-corpus/manifest.json",
  "orchestrator/test/fixtures/git-attribution/manifest.json",
  "orchestrator/test/fixtures/process-supervisor/stubborn-tree.mjs",
  "orchestrator/test/fixtures/gate-corpus/manifest.json",
  "orchestrator/test/fixtures/model-identity-corpus/manifest.json",
  "orchestrator/test/fixtures/delivery-corpus/manifest.json",
  "orchestrator/test/fixtures/packaging-corpus/manifest.json",
  "orchestrator/test/fixtures/protected-release/manifest.json",
  "orchestrator/test/fixtures/claim-mutation/manifest.json",
];

const archivePaths = {
  npm_tarball: "artifacts/reliability/npm-dist/rickgent-0.1.0-alpha.tgz",
  python_wheel:
    "artifacts/reliability/python-dist/rickgent_policies-0.1.0a0-py3-none-any.whl",
};

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = {
    manifest: "docs/remediation/trust-spine-manifest.json",
    from: "t00",
    through: "t39",
    citadel: "artifacts/reliability/citadel-release-report.json",
    summary: relative(repositoryRoot, defaultSummary),
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`invalid argument list near ${flag ?? "<end>"}`);
    }
    const key = flag.slice(2);
    if (!(key in values)) fail(`unknown option ${flag}`);
    values[key] = value;
  }
  return values;
}

function repositoryPath(path) {
  const absolute = resolve(repositoryRoot, path);
  const root = realpathSync(repositoryRoot);
  const parent = existsSync(absolute)
    ? realpathSync(absolute)
    : realpathSync(dirname(absolute));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
    fail(`path escapes repository: ${path}`);
  }
  return absolute;
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(repositoryPath(path), "utf8"));
  } catch (error) {
    fail(`${label} is missing or invalid JSON at ${path}: ${error.message}`);
  }
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    fail(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function resolveCommit(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{7,40}$/u.test(value)) {
    fail(`${label} is not a Git commit id`);
  }
  return git(["rev-parse", "--verify", `${value}^{commit}`]);
}

function requireSingleParent(commit, label) {
  const fields = git(["rev-list", "--parents", "-n", "1", commit]).split(/\s+/u);
  if (fields.length !== 2) fail(`${label} must be a single-parent commit`);
}

function requireAncestor(ancestor, descendant, label) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    fail(`${label}: ${ancestor} is not an ancestor of ${descendant}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(repositoryPath(path))).digest("hex");
}

function requireCurrentCommittedPath(path, label) {
  if (!existsSync(repositoryPath(path))) fail(`${label} is missing: ${path}`);
  git(["cat-file", "-e", `HEAD:${path}`]);
}

function validateDeclaredEvidence(ticket) {
  for (const field of ["output_artifacts", "proof_corpus"]) {
    const paths = ticket[field] ?? [];
    if (!Array.isArray(paths) || (field === "output_artifacts" && paths.length === 0)) {
      fail(`${ticket.id} has no declared ${field}`);
    }
    if (new Set(paths).size !== paths.length) {
      fail(`${ticket.id} has duplicate ${field} entries`);
    }
    for (const path of paths) {
      if (typeof path !== "string" || path.length === 0) {
        fail(`${ticket.id} has an invalid ${field} path`);
      }
      requireCurrentCommittedPath(path, `${ticket.id} ${field}`);
      if (path.endsWith(".json")) loadJson(path, `${ticket.id} ${field}`);
    }
  }
}

function validateTickets(manifest, from, through) {
  if (!Array.isArray(manifest.tickets)) fail("manifest tickets must be an array");
  const first = Number.parseInt(from.slice(1), 10);
  const last = Number.parseInt(through.slice(1), 10);
  const expected = Array.from(
    { length: last - first + 1 },
    (_, offset) => `t${String(first + offset).padStart(2, "0")}`,
  );
  const selected = manifest.tickets.filter(({ id }) => expected.includes(id));
  if (
    selected.length !== expected.length ||
    selected.some(({ id }, index) => id !== expected[index])
  ) {
    fail(`manifest must contain the exact contiguous range ${from}-${through}`);
  }

  const completions = new Map();
  for (const ticket of selected) {
    if (ticket.status !== "Done") fail(`${ticket.id} is not Done`);
    const completion = ticket.completed_at;
    if (!completion || typeof completion !== "object") {
      fail(`${ticket.id} has no completion evidence`);
    }
    const commit = resolveCommit(completion.commit, `${ticket.id} completion`);
    requireSingleParent(commit, `${ticket.id} completion`);
    if (typeof completion.phase_report !== "string") {
      fail(`${ticket.id} has no phase report`);
    }
    requireCurrentCommittedPath(completion.phase_report, `${ticket.id} phase report`);
    validateDeclaredEvidence(ticket);
    completions.set(ticket.id, commit);
  }

  for (const [earlier, later] of [
    ["t37", "t38"],
    ["t38", "t39"],
  ]) {
    requireAncestor(
      completions.get(earlier),
      completions.get(later),
      `${earlier}/${later} milestone order`,
    );
  }
  return { selected, completions };
}

function validateSessionMilestones(completions, citadelPath) {
  const report = loadJson(citadelPath, "Citadel report");
  const session = report.source?.session;
  if (typeof session !== "string" || !/^[0-9A-Za-z._-]+$/u.test(session)) {
    fail("Citadel report has no safe prepared session identity");
  }
  const dataRoot = process.env.PICKLE_DATA_ROOT
    ? resolve(process.env.PICKLE_DATA_ROOT)
    : resolve(homedir(), ".codex", "pickle-rick");
  const sessionRoot = resolve(dataRoot, "sessions", session);
  const expected = new Map([
    ["t37c", completions.get("t37")],
    ["t38c", completions.get("t38")],
    ["t39b", completions.get("t39")],
  ]);
  for (const [ticket, commit] of expected) {
    const path = resolve(sessionRoot, ticket, `linear_ticket_${ticket}.md`);
    if (!path.startsWith(`${sessionRoot}${sep}`) || !existsSync(path)) {
      fail(`prepared session ticket is missing: ${ticket}`);
    }
    const text = readFileSync(path, "utf8");
    if (!/^status: "Done"$/mu.test(text)) {
      fail(`prepared session ticket is not Done: ${ticket}`);
    }
    const recorded = text.match(/^completion_commit: "([0-9a-f]{7,40})"$/mu)?.[1];
    if (!recorded || resolveCommit(recorded, `${ticket} session completion`) !== commit) {
      fail(`${ticket} session completion disagrees with the trust-spine manifest`);
    }
  }
}

function validateQualitySummary() {
  const quality = loadJson(
    "artifacts/reliability/quality-gates-summary.json",
    "quality summary",
  );
  if (quality.thresholds_passed !== true) fail("quality thresholds did not pass");
  if (Object.hasOwn(quality, "generated_at")) {
    fail("quality summary contains volatile generated_at evidence");
  }
  if (!Array.isArray(quality.skipped_required) || quality.skipped_required.length) {
    fail("quality summary contains skipped required gates");
  }
  if (
    !Array.isArray(quality.infrastructure_errors) ||
    quality.infrastructure_errors.length
  ) {
    fail("quality summary contains infrastructure errors");
  }
  const gates = new Map((quality.gates ?? []).map((gate) => [gate.name, gate.status]));
  for (const name of [
    "ts_lint",
    "typecheck",
    "build",
    "ts_test_coverage",
    "ruff_lint",
    "mypy_typecheck",
    "py_test_coverage",
    "coverage_manifest_verify",
    "release_manifest",
    "package_inventory",
  ]) {
    if (gates.get(name) !== "pass") fail(`required quality gate did not pass: ${name}`);
  }
  return quality;
}

function validatePreservationEvidence() {
  const path = "artifacts/reliability/closure-preservation-evidence.json";
  requireCurrentCommittedPath(path, "closure preservation evidence");
  try {
    execFileSync(process.execPath, [
      resolve(repositoryRoot, "orchestrator/scripts/closure-preservation-evidence.mjs"),
      "check",
    ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fail(`closure preservation evidence failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function validateCorpora(vertical) {
  for (const path of requiredCorpora) requireCurrentCommittedPath(path, "required corpus");
  if (!Array.isArray(vertical.runs) || vertical.runs.length !== 2) {
    fail("vertical proof must contain exactly two full runs");
  }
  if (
    vertical.evidence?.fixture_substitution !== false ||
    vertical.evidence?.contains_raw_secrets !== false
  ) {
    fail("vertical proof used fixtures or has an invalid evidence classification");
  }
  for (const run of vertical.runs) {
    if (run.lifecycle_complete !== true || run.containment_passed !== true) {
      fail(`vertical run ${run.run_id ?? "<unknown>"} is incomplete`);
    }
    if (
      run.cleanup?.owned_branch_absent_on_requery !== true ||
      run.cleanup?.owned_pull_request_closed !== true ||
      run.cleanup?.repository_preserved !== true
    ) {
      fail(`vertical run ${run.run_id ?? "<unknown>"} did not complete cleanup`);
    }
  }
  for (const check of vertical.checks ?? []) {
    if (check.required !== true || check.outcome !== "pass") {
      fail(`required vertical check failed: ${check.check_id ?? "<unknown>"}`);
    }
  }
}

function validateArchiveContinuity(index, packed, vertical) {
  if (index.status !== "valid") fail("release proof index is not valid");
  for (const archive of index.bindings?.archives ?? []) {
    const path = archivePaths[archive.kind];
    if (!path) fail(`unsupported archive kind in proof index: ${archive.kind}`);
    const actual = sha256(path);
    if (archive.sha256 !== actual) fail(`${archive.kind} archive digest changed`);
    const packedArchive = packed.binding?.archives?.find(
      (candidate) => candidate.kind === archive.kind,
    );
    if (!packedArchive) {
      fail(`packed receipt has no ${archive.kind} archive binding`);
    }
    const packedDigest = packedArchive.sha256;
    const verticalDigest =
      archive.kind === "npm_tarball"
        ? vertical.binding?.npm_archive_sha256
        : vertical.binding?.wheel_archive_sha256;
    if (packedDigest !== actual || verticalDigest !== actual) {
      fail(`${archive.kind} digest continuity is broken`);
    }
  }
  for (const [name, receipt] of Object.entries(index.receipts ?? {})) {
    if (sha256(receipt.path) !== receipt.file_sha256) {
      fail(`${name} receipt bytes differ from the retained proof index`);
    }
  }
}

function validateCitadel(path) {
  const report = loadJson(path, "Citadel report");
  if (
    report.schema_version !== 1 ||
    report.decision !== "approved" ||
    report.read_only !== true ||
    report.promise !== "THE_CITADEL_APPROVES"
  ) {
    fail("Citadel did not issue the mandatory read-only approval");
  }
  if (!Array.isArray(report.blocking_findings) || report.blocking_findings.length) {
    fail("Citadel report contains blocking findings");
  }
  const prepared = resolveCommit(report.prepared_commit, "Citadel prepared commit");
  requireSingleParent(prepared, "Citadel prepared commit");
  requireAncestor(prepared, "HEAD", "Citadel prepared commit ancestry");
  if (
    !Array.isArray(report.acceptance_criteria) ||
    report.acceptance_criteria.length !== 7 ||
    report.acceptance_criteria.some(({ status }) => status !== "pass")
  ) {
    fail("Citadel report does not pass all seven acceptance criteria");
  }
  return { report, prepared };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.from !== "t00" || options.through !== "t39") {
    fail("Mission 3 closure requires the exact t00-t39 range");
  }
  const manifest = loadJson(options.manifest, "trust-spine manifest");
  const { selected, completions } = validateTickets(
    manifest,
    options.from,
    options.through,
  );
  validateSessionMilestones(completions, options.citadel);
  validateQualitySummary();
  validatePreservationEvidence();
  const index = loadJson("artifacts/reliability/release-proof-index.json", "proof index");
  const packed = loadJson(
    "artifacts/reliability/packed-install-summary.json",
    "packed receipt",
  );
  const vertical = loadJson(
    "artifacts/reliability/vertical-slice-receipt.json",
    "vertical receipt",
  );
  validateCorpora(vertical);
  validateArchiveContinuity(index, packed, vertical);
  const { report, prepared } = validateCitadel(options.citadel);

  const summary = {
    schema_version: 1,
    mission: "mission-3",
    status: "complete",
    ticket_range: { from: options.from, through: options.through, count: selected.length },
    milestone_commits: {
      t37: completions.get("t37"),
      t38: completions.get("t38"),
      t39: completions.get("t39"),
    },
    prepared_commit: prepared,
    citadel_report_sha256: sha256(options.citadel),
    release_proof_profile: index.proof_profile,
    archive_sha256: Object.fromEntries(
      index.bindings.archives.map(({ kind, sha256: digest }) => [kind, digest]),
    ),
    proof_corpus: requiredCorpora,
    quality_thresholds_passed: true,
    citadel_decision: report.decision,
  };
  writeFileSync(repositoryPath(options.summary), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `Mission 3 completion valid: ${selected.length} Done tickets, ordered t37/t38/t39 milestones, retained archives, full corpora, and commit-bound Citadel approval\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`mission completion rejected: ${error.message}\n`);
  process.exitCode = 1;
}
