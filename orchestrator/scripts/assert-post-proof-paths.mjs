#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const T37 = "d9cd83b58f0748bffb918efdd29efd811604a4ae";
const T38_MARKER = "7bba54e2d1510475ed828e97c0d67320f90c9727";
const RETAINED = "ca6dcdf29ce25ab7bd53080fdedf9fae97349268";
const ARCHIVES = {
  "artifacts/reliability/npm-dist/rickgent-0.1.0-alpha.tgz": "66c2be883fab72c203ca3666409b022d7e273b8bcccf30e5f8f8ad457b0d44ed",
  "artifacts/reliability/python-dist/rickgent_policies-0.1.0a0-py3-none-any.whl": "0eb851486e8966c5509d53172b3491e6daa1bc836b9255c267863fa3d82e72f0",
};
const INVENTORIES = {
  "artifacts/reliability/npm-pack-inventory.json": "9804e3cfa9200eb56c8ed0f693c3207e8467fd6333876b244d0f2344686391e6",
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
  "orchestrator/scripts/generate-release-proof-index.mjs",
  "orchestrator/scripts/assert-post-proof-paths.mjs",
]);
const T39_PREFIXES = ["orchestrator/test/fixtures/claim-mutation/"];
const FROZEN_PREFIXES = [
  "orchestrator/dist/", "orchestrator/src/", "orchestrator/package.json", "orchestrator/pnpm-lock.yaml",
  "orchestrator/resources/", "rickgent-policies/", "agents/", "skills/", ".codex/", "package.json", "install.sh",
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
if (packed.digest !== "54545fe6df196ab824bb6e23ae9c57c031ff6c1ceaf1b0bff1c1dabd0a7f1369") {
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
