#!/usr/bin/env node

/**
 * Deterministic POSIX process-supervisor fixture.
 *
 * All behavior is selected through argv. The fixture writes only beneath the
 * required caller-owned --report-dir and to an optional --sentinel contained
 * by that directory. Internal modes are implementation details used to build
 * the requested process topology.
 *
 * Public modes:
 *   exit                 Record identity, then exit with --exit-code.
 *   ignore-term          Record SIGTERM and remain alive for --lifetime-ms.
 *   tree                 Create a child and grandchild in the same process group.
 *   double-fork-escape   Create a detached session, fork a survivor, then exit.
 *   leader-exit-child    Exit after a same-group child reports ready.
 *   close-stdio          Close fd 1/2, continue, and optionally mutate --sentinel.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PUBLIC_MODES = new Set([
  "exit",
  "ignore-term",
  "tree",
  "double-fork-escape",
  "leader-exit-child",
  "close-stdio",
]);
const INTERNAL_MODES = new Set([
  "__tree-child",
  "__tree-grandchild",
  "__leader-child",
  "__escape-intermediate",
  "__escape-survivor",
]);
const VALUE_OPTIONS = new Set([
  "--report-dir",
  "--exit-code",
  "--lifetime-ms",
  "--mutation-delay-ms",
  "--sentinel",
]);
const FLAG_OPTIONS = new Set(["--ignore-term"]);
const DEFAULT_LIFETIME_MS = 60_000;
const READY_TIMEOUT_MS = 10_000;

function usage() {
  return [
    "usage: node stubborn-tree.mjs <mode> --report-dir <absolute-dir> [options]",
    "",
    "modes:",
    "  exit                 [--exit-code 0..255]",
    "  ignore-term          [--lifetime-ms N]",
    "  tree                 [--ignore-term] [--lifetime-ms N]",
    "  double-fork-escape   [--lifetime-ms N] [--mutation-delay-ms N] [--sentinel PATH]",
    "  leader-exit-child    [--ignore-term] [--lifetime-ms N] [--sentinel PATH]",
    "  close-stdio          [--lifetime-ms N] [--mutation-delay-ms N] [--sentinel PATH] [--exit-code 0..255]",
    "",
    "--sentinel must resolve beneath --report-dir; no other filesystem path is mutated.",
  ].join("\n");
}

function fail(message) {
  process.stderr.write(`${message}\n${usage()}\n`);
  process.exit(64);
}

function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const mode = argv[0];
  if (!PUBLIC_MODES.has(mode) && !INTERNAL_MODES.has(mode)) fail(`unknown mode: ${String(mode)}`);
  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (FLAG_OPTIONS.has(argument)) {
      if (flags.has(argument)) fail(`duplicate option: ${argument}`);
      flags.add(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) fail(`unknown option: ${String(argument)}`);
    if (values.has(argument)) fail(`duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
    values.set(argument, value);
    index++;
  }
  return { mode, values, flags };
}

function boundedInteger(raw, label, minimum, maximum, fallback) {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) fail(`${label} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function canonicalReportRoot(raw) {
  if (raw === undefined || !isAbsolute(raw)) fail("--report-dir must be an absolute path");
  mkdirSync(raw, { recursive: true, mode: 0o700 });
  return realpathSync.native(raw);
}

function canonicalProspectivePath(raw) {
  let cursor = resolve(raw);
  const missingComponents = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve prospective path: ${raw}`);
    missingComponents.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync.native(cursor), ...missingComponents);
}

function containedPath(root, raw, label) {
  if (raw === undefined) return null;
  if (!isAbsolute(raw)) fail(`${label} must be an absolute path`);
  const candidate = canonicalProspectivePath(raw);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label} must be a strict descendant of --report-dir`);
  }
  return candidate;
}

function processIdentity() {
  let pid = process.pid;
  let ppid = process.ppid;
  let pgid = null;
  let sid = null;
  try {
    const fields = execFileSync("ps", ["-o", "pid=,ppid=,pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim().split(/\s+/).map(Number);
    if (fields.length === 3 && fields.every(Number.isSafeInteger)) {
      [pid, ppid, pgid] = fields;
    }
  } catch {
    // PID/PPID remain available from Node. Null PGID/SID is explicit evidence
    // that the fixture platform could not provide the requested observation.
  }
  return { pid, ppid, pgid, sid };
}

function writeJsonOnce(root, name, value) {
  const target = join(root, name);
  if (existsSync(target)) throw new Error(`fixture report already exists: ${target}`);
  const temporary = join(root, `.${basename(name)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
}

function reportRole(root, role, mode, extra = {}) {
  writeJsonOnce(root, `${role}.json`, {
    schema_version: "rickgent.process-supervisor-fixture-role.v1",
    fixture: "stubborn-tree",
    mode,
    role,
    ...processIdentity(),
    ...extra,
  });
}

function reportEvent(root, event, extra = {}) {
  appendFileSync(join(root, "events.jsonl"), `${JSON.stringify({
    schema_version: "rickgent.process-supervisor-fixture-event.v1",
    fixture: "stubborn-tree",
    sequence_owner_pid: process.pid,
    event,
    ...extra,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function installTermBehavior(root, role, ignoreTerm) {
  process.on("SIGTERM", () => {
    reportEvent(root, "signal", { role, signal: "SIGTERM", action: ignoreTerm ? "ignored" : "exit" });
    if (!ignoreTerm) process.exit(143);
  });
}

function childArguments(mode, root, options, extraFlags = []) {
  const args = [SCRIPT_PATH, mode, "--report-dir", root, "--lifetime-ms", String(options.lifetimeMs)];
  if (options.sentinel !== null) args.push("--sentinel", options.sentinel);
  args.push("--mutation-delay-ms", String(options.mutationDelayMs));
  if (options.ignoreTerm) args.push("--ignore-term");
  args.push(...extraFlags);
  return args;
}

function spawnFixture(mode, root, options, spawnOptions = {}) {
  return spawn(process.execPath, childArguments(mode, root, options), {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: "ignore",
    ...spawnOptions,
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForReport(root, name) {
  const target = join(root, name);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for fixture report ${name}`);
    await delay(10);
  }
}

function mutateSentinel(root, sentinel, role) {
  if (sentinel === null) return;
  mkdirSync(dirname(sentinel), { recursive: true, mode: 0o700 });
  appendFileSync(sentinel, `stubborn-tree:${role}:pid=${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  reportEvent(root, "sentinel_mutated", { role, sentinel_relative_path: relative(root, sentinel) });
}

async function hold(root, role, lifetimeMs, sentinel = null, mutationDelayMs = 0) {
  if (sentinel !== null) {
    await delay(Math.min(mutationDelayMs, lifetimeMs));
    mutateSentinel(root, sentinel, role);
    await delay(Math.max(0, lifetimeMs - mutationDelayMs));
  } else {
    await delay(lifetimeMs);
  }
  reportEvent(root, "lifetime_elapsed", { role, lifetime_ms: lifetimeMs });
}

async function runPublicMode(mode, root, options) {
  reportRole(root, "leader", mode, {
    lifetime_ms: options.lifetimeMs,
    ignore_term: options.ignoreTerm,
    sentinel_relative_path: options.sentinel === null ? null : relative(root, options.sentinel),
  });

  if (mode === "exit") {
    reportEvent(root, "exit", { role: "leader", exit_code: options.exitCode });
    process.exitCode = options.exitCode;
    return;
  }

  if (mode === "ignore-term") {
    installTermBehavior(root, "leader", true);
    await hold(root, "leader", options.lifetimeMs);
    return;
  }

  if (mode === "tree") {
    installTermBehavior(root, "leader", options.ignoreTerm);
    spawnFixture("__tree-child", root, options);
    await waitForReport(root, "tree-grandchild.json");
    reportEvent(root, "tree_ready", { role: "leader" });
    await hold(root, "leader", options.lifetimeMs);
    return;
  }

  if (mode === "double-fork-escape") {
    const intermediate = spawnFixture("__escape-intermediate", root, options, { detached: true });
    intermediate.unref();
    await waitForReport(root, "escape-survivor.json");
    reportEvent(root, "escaped_survivor_ready", { role: "leader" });
    return;
  }

  if (mode === "leader-exit-child") {
    spawnFixture("__leader-child", root, options).unref();
    await waitForReport(root, "leader-child.json");
    reportEvent(root, "leader_exit_with_child_live", { role: "leader" });
    return;
  }

  if (mode === "close-stdio") {
    installTermBehavior(root, "leader", options.ignoreTerm);
    closeSync(1);
    closeSync(2);
    writeJsonOnce(root, "stdio-closed.json", {
      schema_version: "rickgent.process-supervisor-fixture-event.v1",
      fixture: "stubborn-tree",
      event: "stdio_closed",
      role: "leader",
      pid: process.pid,
      closed_fds: [1, 2],
    });
    await hold(root, "leader", options.lifetimeMs, options.sentinel, options.mutationDelayMs);
    process.exitCode = options.exitCode;
  }
}

async function runInternalMode(mode, root, options) {
  if (mode === "__tree-child") {
    reportRole(root, "tree-child", mode);
    installTermBehavior(root, "tree-child", options.ignoreTerm);
    spawnFixture("__tree-grandchild", root, options);
    await waitForReport(root, "tree-grandchild.json");
    await hold(root, "tree-child", options.lifetimeMs);
    return;
  }

  if (mode === "__tree-grandchild") {
    reportRole(root, "tree-grandchild", mode);
    installTermBehavior(root, "tree-grandchild", options.ignoreTerm);
    await hold(root, "tree-grandchild", options.lifetimeMs);
    return;
  }

  if (mode === "__leader-child") {
    reportRole(root, "leader-child", mode);
    installTermBehavior(root, "leader-child", options.ignoreTerm);
    await hold(root, "leader-child", options.lifetimeMs, options.sentinel, options.mutationDelayMs);
    return;
  }

  if (mode === "__escape-intermediate") {
    reportRole(root, "escape-intermediate", mode);
    const survivor = spawnFixture("__escape-survivor", root, options);
    survivor.unref();
    await waitForReport(root, "escape-survivor.json");
    reportEvent(root, "intermediate_exit_with_survivor_live", { role: "escape-intermediate" });
    return;
  }

  if (mode === "__escape-survivor") {
    reportRole(root, "escape-survivor", mode);
    installTermBehavior(root, "escape-survivor", options.ignoreTerm);
    await hold(root, "escape-survivor", options.lifetimeMs, options.sentinel, options.mutationDelayMs);
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const root = canonicalReportRoot(parsed.values.get("--report-dir"));
  const options = {
    exitCode: boundedInteger(parsed.values.get("--exit-code"), "--exit-code", 0, 255, 0),
    lifetimeMs: boundedInteger(parsed.values.get("--lifetime-ms"), "--lifetime-ms", 1, 600_000, DEFAULT_LIFETIME_MS),
    mutationDelayMs: boundedInteger(parsed.values.get("--mutation-delay-ms"), "--mutation-delay-ms", 0, 600_000, 100),
    sentinel: containedPath(root, parsed.values.get("--sentinel"), "--sentinel"),
    ignoreTerm: parsed.mode === "ignore-term" || parsed.flags.has("--ignore-term"),
  };
  if (options.mutationDelayMs > options.lifetimeMs) {
    fail("--mutation-delay-ms cannot exceed --lifetime-ms");
  }
  if (PUBLIC_MODES.has(parsed.mode)) await runPublicMode(parsed.mode, root, options);
  else await runInternalMode(parsed.mode, root, options);
}

main().catch((error) => {
  process.stderr.write(`stubborn-tree fixture failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 70;
});
