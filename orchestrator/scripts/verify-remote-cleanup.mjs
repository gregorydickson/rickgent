#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
if (!Array.isArray(receipt.runs) || receipt.runs.length !== 2) fail("exactly two owned runs are required");

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

const seenPulls = new Set();
const seenBranches = new Set();
for (const run of receipt.runs) {
  const delivery = run.delivery;
  const expectedBranch = `${receipt.repository.owned_branch_prefix}/${run.run_id}`;
  if (delivery?.branch !== expectedBranch || seenBranches.has(delivery.branch)) {
    fail(`${run.run_id} branch is not uniquely owned by the receipt namespace`);
  }
  if (!OID.test(delivery.delivery_oid ?? "") || delivery.delivery_oid !== delivery.pull_request_head_oid) {
    fail(`${run.run_id} delivery/head OID binding is invalid`);
  }
  if (!/^[1-9][0-9]*$/.test(delivery.pull_request_id ?? "") || seenPulls.has(delivery.pull_request_id)) {
    fail(`${run.run_id} pull request is not uniquely identified`);
  }
  seenBranches.add(delivery.branch);
  seenPulls.add(delivery.pull_request_id);

  const pull = gh(`${repoPath}/pulls/${delivery.pull_request_id}`);
  if (
    pull.state !== "closed"
    || pull.head?.ref !== delivery.branch
    || pull.head?.sha !== delivery.delivery_oid
    || pull.base?.ref !== receipt.repository.base_branch
    || pull.head?.repo?.id !== repository.id
  ) fail(`${run.run_id} owned pull request is not closed at the exact delivery OID`);

  const matches = gh(
    `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${receipt.repository.owner}:${delivery.branch}`)}`
    + `&base=${encodeURIComponent(receipt.repository.base_branch)}`,
  );
  if (!Array.isArray(matches) || matches.length !== 0) {
    fail(`${run.run_id} has a duplicate open pull-request effect after cleanup`);
  }

  if (gh(`${repoPath}/git/ref/heads/${delivery.branch}`, { absent: true }) !== null) {
    fail(`${run.run_id} owned branch still exists`);
  }
}

process.stdout.write(
  `verify-remote-cleanup: repository ${receipt.repository.repository_id} preserved; `
  + "two owned pull requests closed and two exact owned branches absent\n",
);
