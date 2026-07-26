#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OID = /^[0-9a-f]{40}$/;

function fail(message) {
  process.stderr.write(`verify-remote-cleanup: ${message}\n`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail(`${name} is required`);
  return resolve(process.argv[index + 1]);
}

function gh(endpoint, { absent = false } = {}) {
  const result = spawnSync("gh", ["api", "--method", "GET", endpoint], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) fail(`GitHub observation failed: ${result.error.message}`);
  if (result.status !== 0) {
    if (absent && /\b404\b|not found/i.test(result.stderr)) return null;
    fail(`GitHub GET ${endpoint} failed without a conclusive observation`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`GitHub GET ${endpoint} returned invalid JSON`);
  }
}

export function ownedCleanupResources(receipt) {
  if (!Array.isArray(receipt?.runs) || receipt.runs.length !== 2) {
    throw new Error("exactly two owned runs are required");
  }
  const resources = [];
  const seenPulls = new Set();
  const seenBranches = new Set();
  for (const run of receipt.runs) {
    const expected = [
      ["success", run.delivery, `${receipt.repository.owned_branch_prefix}/${run.run_id}`],
      ["failure-cleanup", run.cleanup?.failure_path,
        `${receipt.repository.owned_branch_prefix}/${run.run_id}-failure-cleanup`],
    ];
    for (const [kind, resource, expectedBranch] of expected) {
      if (resource?.branch !== expectedBranch || seenBranches.has(resource?.branch)) {
        throw new Error(`${run.run_id} ${kind} branch is not uniquely owned by the receipt namespace`);
      }
      if (!OID.test(resource.delivery_oid ?? "") || resource.delivery_oid !== resource.pull_request_head_oid) {
        throw new Error(`${run.run_id} ${kind} delivery/head OID binding is invalid`);
      }
      if (!/^[1-9][0-9]*$/.test(resource.pull_request_id ?? "") || seenPulls.has(resource.pull_request_id)) {
        throw new Error(`${run.run_id} ${kind} pull request is not uniquely identified`);
      }
      if (kind === "failure-cleanup" && (
        resource.run_id !== run.run_id
        || resource.base_branch !== receipt.repository.base_branch
        || resource.repository_preserved !== true
        || resource.owned_pull_request_closed !== true
        || resource.owned_branch_absent_on_requery !== true
      )) {
        throw new Error(`${run.run_id} failure-cleanup receipt is incomplete`);
      }
      seenBranches.add(resource.branch);
      seenPulls.add(resource.pull_request_id);
      resources.push({ kind, runId: run.run_id, ...resource });
    }
  }
  return resources;
}

function main() {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(option("--receipt"), "utf8"));
  } catch (error) {
    fail(`receipt is invalid JSON: ${error.message}`);
  }

if (
  receipt?.repository?.host !== "github.com"
  || receipt.repository.pre_existing !== true
  || receipt.repository.allowlisted_disposable !== true
  || receipt.cleanup?.repository_deleted !== false
) fail("receipt does not bind a preserved allowlisted GitHub repository");
  let resources;
  try {
    resources = ownedCleanupResources(receipt);
  } catch (error) {
    fail(error.message);
  }

const slug = `${receipt.repository.owner}/${receipt.repository.name}`;
const repoPath = `repos/${slug}`;
const repository = gh(repoPath);
if (
  String(repository.id) !== receipt.repository.repository_id
  || repository.owner?.login !== receipt.repository.owner
  || repository.name !== receipt.repository.name
  || repository.default_branch !== receipt.repository.base_branch
  || repository.private !== true
) fail("live repository does not match the immutable receipt binding");

for (const resource of resources) {
  const pull = gh(`${repoPath}/pulls/${resource.pull_request_id}`);
  if (
    pull.state !== "closed"
    || pull.head?.ref !== resource.branch
    || pull.head?.sha !== resource.delivery_oid
    || pull.base?.ref !== receipt.repository.base_branch
    || pull.head?.repo?.id !== repository.id
  ) fail(`${resource.runId} ${resource.kind} pull request is not closed at the exact delivery OID`);

  const matches = gh(
    `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${receipt.repository.owner}:${resource.branch}`)}`
    + `&base=${encodeURIComponent(receipt.repository.base_branch)}`,
  );
  if (!Array.isArray(matches) || matches.length !== 0) {
    fail(`${resource.runId} ${resource.kind} has an open pull-request effect after cleanup`);
  }

  if (gh(`${repoPath}/git/ref/heads/${resource.branch}`, { absent: true }) !== null) {
    fail(`${resource.runId} ${resource.kind} owned branch still exists`);
  }
}

const prefixRefs = gh(`${repoPath}/git/matching-refs/heads/${receipt.repository.owned_branch_prefix}`);
if (!Array.isArray(prefixRefs) || prefixRefs.length !== 0) {
  fail("an owned-prefix branch remains after cleanup");
}
const openPulls = gh(
  `${repoPath}/pulls?state=open&base=${encodeURIComponent(receipt.repository.base_branch)}&per_page=100`,
);
if (!Array.isArray(openPulls) || openPulls.some((pull) =>
  pull.head?.ref === receipt.repository.owned_branch_prefix
  || pull.head?.ref?.startsWith(`${receipt.repository.owned_branch_prefix}/`)
)) fail("an owned-prefix pull request remains open after cleanup");

process.stdout.write(
  `verify-remote-cleanup: repository ${receipt.repository.repository_id} preserved; `
  + "four owned pull requests closed, four exact owned branches absent, and namespace empty\n",
);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
