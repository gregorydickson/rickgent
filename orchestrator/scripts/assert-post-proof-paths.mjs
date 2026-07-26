#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const T37 = "288514f896eb0d1cb103352449d213253a8e7ef0";
const T38_MARKER = "a7a3b5bad21deca8955e20e23f86c14780859ff2";
const RETAINED = "a7a3b5bad21deca8955e20e23f86c14780859ff2";
const ARCHIVES = {
  "artifacts/reliability/npm-dist/rickgent-0.1.0-alpha.tgz": "641ef9a04f1eb659ba3049370415ce1bfdc5e06e941d7bbec3d9601e362e79d1",
  "artifacts/reliability/python-dist/rickgent_policies-0.1.0a0-py3-none-any.whl": "ecfb65dad232096eb1778e403f1dee6bab7e0d9d799824642da2698c7af109be",
};
const INVENTORIES = {
  "artifacts/reliability/npm-pack-inventory.json": "0f03043d090514ef6ad64cf1ccc098e9dcb6b3f551e46ebff9d827187ecc9015",
};
const T39_ALLOWED = new Set([
  "artifacts/reliability/release-proof-index.json",
  "artifacts/reliability/claim-surface-inventory.json",
  "README.md", "CHANGELOG.md", "docs/reliability-preview.md", "docs/reliability-contract.md",
  "docs/architecture/reliability/trust-spine-contract.json",
  "docs/remediation/trust-spine-manifest.json", "master-plan.md", "release-manifest.json",
  "orchestrator/test/reliability/claims-contract.test.ts",
  "orchestrator/test/reliability/claim-mutation.test.ts",
  "orchestrator/test/reliability/capability-restoration.test.ts",
  "orchestrator/test/reliability/containment-authority.test.ts",
  "orchestrator/test/reliability/protected-release-controller.test.ts",
  "orchestrator/test/reliability/protected-release-cleanup-evidence.test.ts",
  "orchestrator/test/reliability/release-manifest.test.ts",
  "orchestrator/test/reliability/receipt-validation.test.ts",
  "orchestrator/test/reliability/vertical-slice-receipt.test.ts",
  "orchestrator/test/reliability/mission-completion-evidence.test.ts",
  "orchestrator/test/fixtures/runtime-gate.mjs",
  "orchestrator/test/fixtures/protected-release/manifest.json",
  "orchestrator/scripts/generate-release-proof-index.mjs",
  "orchestrator/scripts/assert-post-proof-paths.mjs",
  "orchestrator/scripts/quality-gates-summary.mjs",
  "orchestrator/scripts/closure-preservation-evidence.mjs",
  "orchestrator/scripts/validate-mission-completion.mjs",
  "orchestrator/scripts/validate-protected-preflight.mjs",
  "orchestrator/scripts/verify-remote-cleanup.mjs",
  "orchestrator/scripts/run-protected-release.mjs",
  "orchestrator/scripts/quality-gate-contract.mjs",
  "orchestrator/test/reliability/protected-release-branch-lease.test.ts",
  "orchestrator/test/reliability/quality-gates.test.ts",
  "orchestrator/test/reliability/concurrency-corpus.test.ts",
  "orchestrator/test/fixtures/concurrency-corpus/worker-fixtures.mjs",
  "orchestrator/vitest.config.ts",
  "artifacts/reliability/vertical-slice-receipt.json",
  "artifacts/reliability/vertical-slice-receipt.sha256",
  "artifacts/reliability/concurrency-summary.json",
  "docs/remediation/phase-9-t38-installed-vertical-slice-execution-report.md",
  "artifacts/reliability/quality-gates-summary.json",
  "artifacts/reliability/closure-preservation-evidence.json",
  "artifacts/reliability/citadel-release-report.json",
  "artifacts/reliability/mission-3-completion-summary.json",
  "docs/remediation/phase-9-t39-release-closure-execution-report.md",
]);
const T39_PREFIXES = [
  "orchestrator/test/fixtures/claim-mutation/",
  "rickgent-policies/test/",
];
const FROZEN_PREFIXES = [
  "orchestrator/scripts/validate-packed-install-receipt.mjs",
  "orchestrator/scripts/validate-receipt-schema.mjs",
  "orchestrator/scripts/validate-vertical-slice-receipt.mjs",
  "orchestrator/scripts/validate-protected-preflight.mjs",
  "orchestrator/scripts/scan-release-evidence.mjs",
  "orchestrator/scripts/run-protected-release.mjs",
  "orchestrator/schemas/",
  "orchestrator/dist/", "orchestrator/src/", "orchestrator/package.json", "orchestrator/pnpm-lock.yaml",
  "orchestrator/resources/", "rickgent-policies/rickgent_policies/", "rickgent-policies/pyproject.toml",
  "agents/", "skills/", ".codex/", "package.json", "install.sh",
  "artifacts/reliability/npm-dist/", "artifacts/reliability/python-dist/",
];

function fail(message) {
  process.stderr.write(`assert-post-proof-paths: ${message}\n`);
  process.exit(1);
}
function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function assertCommit(oid, label) {
  try {
    git(["cat-file", "-e", `${oid}^{commit}`]);
    git(["merge-base", "--is-ancestor", oid, "HEAD"]);
  } catch {
    fail(`${label} ${oid} is not a retained ancestor`);
  }
}

const baselineAt = process.argv.indexOf("--baseline");
const baseline = resolve(baselineAt >= 0
  ? (process.argv[baselineAt + 1] ?? "")
  : "artifacts/reliability/packed-install-summary.json");
if (!existsSync(baseline)) fail("packed baseline is missing");
let packed;
try {
  packed = JSON.parse(readFileSync(baseline, "utf8"));
} catch {
  fail("packed baseline is malformed");
}
if (packed.digest !== "ac32d6f1845b7c2fae7f0be3f003af4a2257587b1fcb8f477948c6ad0281d58a") {
  fail("packed baseline digest is not the retained t37 authority");
}

assertCommit(T37, "t37 completion");
assertCommit(T38_MARKER, "t38 marker");
assertCommit(RETAINED, "final retained receipt");
for (const [path, expected] of Object.entries(ARCHIVES)) {
  const current = readFileSync(resolve(root, path));
  const retained = git(["show", `${T37}:${path}`], null);
  if (sha256(current) !== expected || sha256(retained) !== expected) {
    fail(`${path} changed after t37`);
  }
}
for (const [path, expected] of Object.entries(INVENTORIES)) {
  const current = readFileSync(resolve(root, path));
  const retained = git(["show", `${T37}:${path}`], null);
  if (sha256(current) !== expected || sha256(retained) !== expected) {
    fail(`${path} changed after t37`);
  }
}

const postMarker = git(["diff", "--name-only", `${T38_MARKER}..HEAD`]).trim().split("\n").filter(Boolean);
for (const path of postMarker) {
  if (FROZEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    fail(`frozen runtime/package path changed after t38: ${path}`);
  }
}

const postRetained = new Set([
  ...git(["diff", "--name-only", `${RETAINED}..HEAD`]).trim().split("\n").filter(Boolean),
  ...git(["diff", "--name-only"]).trim().split("\n").filter(Boolean),
  ...git(["diff", "--name-only", "--cached"]).trim().split("\n").filter(Boolean),
  ...git(["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean),
]);
for (const path of postRetained) {
  if (!T39_ALLOWED.has(path) && !T39_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    fail(`path outside the t39a immutable allowlist changed after retained proof: ${path}`);
  }
}
process.stdout.write("assert-post-proof-paths: frozen bytes and post-proof paths passed\n");
