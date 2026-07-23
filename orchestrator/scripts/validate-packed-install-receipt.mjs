#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactsRoot = join(repositoryRoot, "artifacts", "reliability");
const receiptPath = resolve(process.argv[2] ?? join(artifactsRoot, "packed-install-summary.json"));
const checksumPath = join(dirname(receiptPath), "packed-install-summary.sha256");
const schemaPath = join(repositoryRoot, "orchestrator", "schemas", "packed-install-receipt.schema.json");
const releasePath = join(repositoryRoot, "release-manifest.json");
const contractPath = join(artifactsRoot, "omnigent-compatibility-contract.json");
const corpusPaths = [
  "orchestrator/test/fixtures/packaging-corpus/manifest.json",
  "rickgent-policies/test/fixtures/native-policy-corpus/manifest.json",
  "orchestrator/test/fixtures/model-identity-corpus/manifest.json",
];
const requiredChecks = [
  "archive_identity", "installed_containment", "source_sentinel_access", "checkout_cwd",
  "node_path_poison", "pythonpath_poison", "source_node_modules", "resource_override",
  "editable_direct_url", "editable_pth", "editable_egg_link", "escaping_symlink",
  "missing_resource", "implicit_python", "wrong_python", "native_allow", "native_deny",
  "omnigent_identity", "sqlite_reopen", "git_containment", "typed_failure", "owned_cleanup",
  "failure_cleanup", "unrelated_state_preserved",
];
const completionPaths = [
  "artifacts/reliability/npm-dist/",
  "artifacts/reliability/python-dist/",
  "artifacts/reliability/npm-pack-inventory.json",
  "artifacts/reliability/packed-install-summary.json",
  "artifacts/reliability/packed-install-summary.sha256",
  "orchestrator/test/reliability/packed-install.test.ts",
  "orchestrator/scripts/validate-packed-install-receipt.mjs",
  "docs/remediation/phase-9-t37-packed-install-execution-report.md",
  "docs/remediation/trust-spine-manifest.json",
];

function fail(message) {
  process.stderr.write(`validate-packed-install-receipt: ${message}\n`);
  process.exit(1);
}
function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse ${path}: ${error.message}`);
  }
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function sha256File(path) {
  return sha256(readFileSync(path));
}
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
}
function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function archiveInventory(path, kind) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "rickgent-receipt-"));
  try {
    const executable = kind === "npm_tarball" ? "tar" : "unzip";
    const listed = execFileSync(executable, kind === "npm_tarball" ? ["-tzf", path] : ["-Z1", path], {
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    if (listed.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      fail(`unsafe archive member in ${basename(path)}`);
    }
    execFileSync(executable, kind === "npm_tarball"
      ? ["-xzf", path, "-C", root]
      : ["-q", path, "-d", root]);
    const entries = [];
    const visit = (directory) => {
      for (const name of readdirSync(directory).sort()) {
        const child = join(directory, name);
        const stat = lstatSync(child);
        if (stat.isSymbolicLink()) fail(`archive contains symlink: ${relative(root, child)}`);
        else if (stat.isDirectory()) visit(child);
        else if (stat.isFile()) {
          entries.push({
            path: relative(root, child).split(sep).join("/"),
            sha256: sha256File(child),
          });
        }
      }
    };
    visit(root);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return sha256(canonical(entries));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (!existsSync(receiptPath)) fail(`receipt does not exist: ${receiptPath}`);
if (!existsSync(checksumPath)) fail(`checksum sidecar does not exist: ${checksumPath}`);
const receipt = record(load(receiptPath), "receipt");
equal(readFileSync(receiptPath, "utf8"), `${canonical(receipt)}\n`, "canonical receipt bytes");
for (const [field, expected] of Object.entries({
  schema_version: "1.0.0",
  proof_version: "packed-install-proof-v1",
  redaction_version: "rickgent-redaction-v1",
  canonicalization: "rickgent-canonical-json-v1",
  digest_algorithm: "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
})) equal(receipt[field], expected, field);
execFileSync(process.execPath, [
  join(repositoryRoot, "orchestrator", "scripts", "validate-receipt-schema.mjs"),
  schemaPath,
], { stdio: ["ignore", "ignore", "inherit"] });
const { digest, ...unsigned } = receipt;
const computed = sha256(canonical(unsigned));
equal(digest, computed, "canonical digest");
equal(readFileSync(checksumPath, "utf8").trim().split(/\s+/), [
  computed, "packed-install-summary.json",
], "checksum sidecar");

const binding = record(receipt.binding, "binding");
const headOid = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot, encoding: "utf8",
}).trim();
if (typeof binding.source_git_oid !== "string" || !/^[0-9a-f]{40}$/.test(binding.source_git_oid)) {
  fail("source Git OID must be a full lowercase commit OID");
}
const sourceOid = binding.source_git_oid;
if (sourceOid !== headOid) {
  const parentOid = execFileSync("git", ["rev-parse", "HEAD^"], {
    cwd: repositoryRoot, encoding: "utf8",
  }).trim();
  equal(sourceOid, parentOid, "non-self-referential source Git OID");
  const changed = execFileSync("git", ["diff", "--name-only", sourceOid, headOid], {
    cwd: repositoryRoot, encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  if (changed.some((path) => !completionPaths.some((owned) =>
    owned.endsWith("/") ? path.startsWith(owned) : path === owned
  ))) {
    fail("completion commit contains a path outside the t37c ownership boundary");
  }
}
const release = load(releasePath);
equal(binding.release, {
  id: release.release_id,
  sha256: sha256File(releasePath),
}, "release binding");
equal(binding.omnigent_contract_sha256, sha256File(contractPath), "Omnigent contract binding");
if (!Array.isArray(binding.archives) || binding.archives.length !== 2) {
  fail("exactly two archive bindings are required");
}
for (const kind of ["npm_tarball", "python_wheel"]) {
  const archive = binding.archives.find((entry) => entry?.kind === kind);
  if (!archive) fail(`missing ${kind} binding`);
  const directory = kind === "npm_tarball"
    ? join(artifactsRoot, "npm-dist")
    : join(artifactsRoot, "python-dist");
  const expectedFiles = readdirSync(directory).filter((name) =>
    kind === "npm_tarball" ? name.endsWith(".tgz") : name.endsWith(".whl"));
  if (expectedFiles.length !== 1 || expectedFiles[0] !== archive.filename) {
    fail(`${kind} filename/count mismatch`);
  }
  const path = join(directory, archive.filename);
  equal(archive.sha256, sha256File(path), `${kind} archive digest`);
  equal(archive.inventory_sha256, archiveInventory(path, kind), `${kind} inventory digest`);
}
if (!Array.isArray(binding.corpora)) fail("corpora must be an array");
equal(binding.corpora, corpusPaths.map((path) => ({
  id: path,
  sha256: sha256File(join(repositoryRoot, path)),
})), "corpus bindings");
const build = record(binding.build, "build");
equal(build.id, sourceOid, "build identity");
const npmArchive = binding.archives.find((entry) => entry.kind === "npm_tarball");
const wheelArchive = binding.archives.find((entry) => entry.kind === "python_wheel");
const extractRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "rickgent-build-binding-"));
try {
  execFileSync("tar", [
    "-xzf", join(artifactsRoot, "npm-dist", npmArchive.filename), "-C", extractRoot,
  ]);
  equal(build.sha256, sha256File(join(
    extractRoot, "package", "dist", "build-commit.js",
  )), "build resource digest");
} finally {
  rmSync(extractRoot, { recursive: true, force: true });
}

const evidence = record(receipt.evidence, "evidence");
equal(evidence.contains_raw_secrets, false, "raw-secret marker");
if (!Array.isArray(evidence.items)) fail("evidence.items must be an array");
if (evidence.items.some((item) =>
  item.classification !== "live" ||
  !["public", "sensitive_redacted"].includes(item.redaction)
)) fail("all evidence must be live and retained in redacted/public form");
if (/(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|PRIVATE KEY|authorization.{0,8}(?:bearer|token))/i.test(JSON.stringify(receipt))) {
  fail("raw secret pattern detected");
}
const evidenceIds = new Set(evidence.items.map((item) => item.evidence_id));
if (!Array.isArray(receipt.checks)) fail("checks must be an array");
equal(receipt.checks.map((check) => check.check_id).sort(), [...requiredChecks].sort(), "required check coverage");
if (receipt.checks.some((check) => check.required !== true || check.outcome !== "pass")) {
  fail("zero skips, failures, and infrastructure errors are required");
}
if (receipt.checks.some((check) =>
  !Array.isArray(check.evidence_ids) ||
  check.evidence_ids.length === 0 ||
  check.evidence_ids.some((id) => !evidenceIds.has(id))
)) fail("every check must reference retained evidence");

const containment = record(receipt.containment, "containment");
equal(containment.unrelated_cwd, true, "unrelated CWD");
equal(containment.source_lookup_poisoned, true, "poisoned lookup");
if (!Array.isArray(containment.installed_realpaths) || containment.installed_realpaths.length === 0) {
  fail("installed realpath evidence is required");
}
for (const observation of containment.installed_realpaths) {
  if (observation.contained !== true) fail(`uncontained observation: ${observation.resource}`);
}
equal(receipt.omnigent.compatibility_authority, "offline_behavioral_probe", "compatibility authority");
equal(receipt.omnigent.read_only, true, "Omnigent read-only");
equal(receipt.cleanup?.unrelated_state_preserved, true, "unrelated-state preservation");
const sharedPath = join(repositoryRoot, "orchestrator", "dist", "release-proof", "receipt-validator.js");
if (!existsSync(sharedPath)) fail("compiled shared receipt validator is missing");
const shared = await import(pathToFileURL(sharedPath).href);
const sharedResult = shared.validatePackedInstallReceipt(receipt, load(schemaPath), {
  sourceGitOid: sourceOid,
  releaseId: release.release_id,
  releaseSha256: sha256File(releasePath),
  buildId: sourceOid,
  buildSha256: build.sha256,
  npmArchiveSha256: npmArchive.sha256,
  wheelArchiveSha256: wheelArchive.sha256,
  requiredCheckIds: requiredChecks,
  requiredCorpusIds: corpusPaths,
});
if (!sharedResult.ok) {
  fail(`shared semantic validator rejected receipt: ${sharedResult.diagnostics.map((item) => `${item.code}:${item.detail}`).join("; ")}`);
}
process.stdout.write(`packed-install receipt valid: ${computed}\n`);
