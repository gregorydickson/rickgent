#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "artifacts/reliability/closure-preservation-evidence.json");
const callerExclusions = [
  "artifacts/reliability/closure-preservation-evidence.json",
  "artifacts/reliability/quality-gates-summary.json",
];

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function git(repository, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: repository, encoding, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function fileEntry(base, path) {
  const stat = lstatSync(path);
  const name = relative(base, path).split(sep).join("/");
  if (stat.isSymbolicLink()) return { path: name, kind: "symlink", target: readlinkSync(path) };
  if (stat.isFile()) return { path: name, kind: "file", mode: stat.mode & 0o777, sha256: sha256(readFileSync(path)) };
  return { path: name, kind: "other", mode: stat.mode & 0o777 };
}
function untrackedSnapshot(repository, exclusions = []) {
  const names = git(repository, ["ls-files", "--others", "--exclude-standard", "-z"], "buffer")
    .toString("utf8").split("\0").filter(Boolean).filter((name) => !exclusions.includes(name)).sort();
  const entries = names.map((name) => fileEntry(repository, join(repository, name)));
  return { count: entries.length, sha256: sha256(canonical(entries)) };
}
function gitSnapshot(repository, exclusions = []) {
  const pathspec = exclusions.map((path) => `:(exclude)${path}`);
  const args = ["--", ".", ...pathspec];
  return {
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    index_delta_sha256: sha256(git(repository, ["diff", "--cached", "--binary", "--no-ext-diff", ...args], "buffer")),
    worktree_delta_sha256: sha256(git(repository, ["diff", "--binary", "--no-ext-diff", ...args], "buffer")),
    untracked: untrackedSnapshot(repository, exclusions),
  };
}
function treeSnapshot(base, excludedPrefix) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(base, path).split(sep).join("/");
      if (name === excludedPrefix || name.startsWith(`${excludedPrefix}/`)) continue;
      if (entry.isDirectory()) walk(path);
      else entries.push(fileEntry(base, path));
    }
  };
  walk(base);
  return { count: entries.length, sha256: sha256(canonical(entries)) };
}
function sessionIdentity() {
  const report = JSON.parse(readFileSync(join(root, "artifacts/reliability/citadel-release-report.json"), "utf8"));
  const session = report.source?.session;
  if (typeof session !== "string" || !/^[0-9A-Za-z._-]+$/u.test(session)) fail("unsafe Citadel session identity");
  return session;
}
function snapshot() {
  const sibling = process.env.OMNIGENT_ROOT;
  if (!sibling || !existsSync(sibling)) fail("OMNIGENT_ROOT must identify the sibling checkout");
  const runtime = resolve(process.env.PICKLE_DATA_ROOT ?? join(homedir(), ".codex/pickle-rick"));
  if (!existsSync(runtime)) fail("Pickle runtime data root is missing");
  return {
    caller: gitSnapshot(root, callerExclusions),
    sibling: gitSnapshot(resolve(sibling)),
    unrelated_runtime: treeSnapshot(runtime, `sessions/${sessionIdentity()}`),
    quality_summary_sha256: sha256(readFileSync(join(root, "artifacts/reliability/quality-gates-summary.json"))),
  };
}
function evidenceDigest(evidence) {
  const { digest: _digest, ...unsigned } = evidence;
  return sha256(canonical(unsigned));
}
function write(evidence) {
  writeFileSync(output, `${JSON.stringify({ ...evidence, digest: evidenceDigest(evidence) }, null, 2)}\n`, "utf8");
}
function check(evidence) {
  if (evidence.schema_version !== 1 || evidence.profile !== "closure-preservation-v1") fail("invalid preservation schema");
  if (evidence.preserved !== true || !evidence.before || !evidence.after) fail("preservation proof is incomplete");
  if (canonical(evidence.before) !== canonical(evidence.after)) fail("before/after preservation snapshots differ");
  if (evidence.digest !== evidenceDigest(evidence)) fail("preservation evidence digest mismatch");
}

const command = process.argv[2];
try {
  if (command === "begin") {
    write({ schema_version: 1, profile: "closure-preservation-v1", preserved: false, before: snapshot(), after: null });
    process.stdout.write(`closure preservation: captured before snapshot at ${output}\n`);
  } else if (command === "end") {
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    write({ ...evidence, preserved: true, after: snapshot() });
    check(JSON.parse(readFileSync(output, "utf8")));
    process.stdout.write("closure preservation: before/after snapshots match\n");
  } else if (command === "check") {
    check(JSON.parse(readFileSync(output, "utf8")));
    process.stdout.write("closure preservation: retained evidence passed\n");
  } else fail("usage: closure-preservation-evidence.mjs <begin|end|check>");
} catch (error) {
  process.stderr.write(`closure preservation rejected: ${error.message}\n`);
  process.exitCode = 1;
}
