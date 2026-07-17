#!/usr/bin/env node

/**
 * Fixed-memory deterministic stdout/stderr flood fixture.
 *
 * `--bytes` is the byte count for each selected stream. Text patterns contain
 * printable ASCII plus newlines; binary patterns cover all byte values. The
 * selected pattern is indexed by absolute stream offset, so output and digests
 * do not depend on --chunk-bytes or pipe scheduling.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { once } from "node:events";

const MODES = new Set([
  "stdout",
  "stderr",
  "simultaneous",
  "binary-stdout",
  "binary-stderr",
  "binary-simultaneous",
]);
const VALUE_OPTIONS = new Set(["--report-dir", "--bytes", "--chunk-bytes", "--exit-code"]);
const DEFAULT_CHUNK_BYTES = 16 * 1024;
const MAX_BYTES_PER_STREAM = 1024 * 1024 * 1024;
const STDOUT_TEXT_PATTERN = Buffer.from("STDOUT|0123456789abcdef|\n", "ascii");
const STDERR_TEXT_PATTERN = Buffer.from("STDERR|fedcba9876543210|\n", "ascii");

function usage() {
  return [
    "usage: node output-flood.mjs <mode> --report-dir <absolute-dir> --bytes <N> [options]",
    "",
    "modes:",
    "  stdout | stderr | simultaneous",
    "  binary-stdout | binary-stderr | binary-simultaneous",
    "",
    "options:",
    `  --chunk-bytes N  fixed working chunk (default ${DEFAULT_CHUNK_BYTES})`,
    "  --exit-code N     exit 0..255 after output (default 0)",
    "",
    "--bytes is emitted independently to each selected stream.",
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
  if (!MODES.has(mode)) fail(`unknown mode: ${String(mode)}`);
  const values = new Map();
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (!VALUE_OPTIONS.has(argument)) fail(`unknown option: ${String(argument)}`);
    if (values.has(argument)) fail(`duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
    values.set(argument, value);
    index++;
  }
  return { mode, values };
}

function boundedInteger(raw, label, minimum, maximum, fallback = undefined) {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    fail(`${label} is required`);
  }
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

function writeJsonOnce(root, name, value) {
  const target = join(root, name);
  if (existsSync(target)) throw new Error(`fixture report already exists: ${target}`);
  const temporary = join(root, `.${basename(name)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
}

function binaryByte(streamName, absoluteOffset) {
  const seed = streamName === "stdout" ? 0x35 : 0xa7;
  return (seed + (absoluteOffset * 73)) & 0xff;
}

function fillChunk(streamName, binary, absoluteOffset, length) {
  const chunk = Buffer.allocUnsafe(length);
  if (binary) {
    for (let index = 0; index < length; index++) {
      chunk[index] = binaryByte(streamName, absoluteOffset + index);
    }
    return chunk;
  }
  const pattern = streamName === "stdout" ? STDOUT_TEXT_PATTERN : STDERR_TEXT_PATTERN;
  for (let index = 0; index < length; index++) {
    chunk[index] = pattern[(absoluteOffset + index) % pattern.length];
  }
  return chunk;
}

async function writeWithBackpressure(stream, chunk) {
  if (stream.write(chunk)) return;
  await once(stream, "drain");
}

async function emitStream(streamName, binary, byteCount, chunkBytes) {
  const stream = streamName === "stdout" ? process.stdout : process.stderr;
  const hash = createHash("sha256");
  let written = 0;
  while (written < byteCount) {
    const length = Math.min(chunkBytes, byteCount - written);
    const chunk = fillChunk(streamName, binary, written, length);
    hash.update(chunk);
    await writeWithBackpressure(stream, chunk);
    written += length;
  }
  return {
    stream: streamName,
    bytes_written: written,
    sha256: `sha256:${hash.digest("hex")}`,
    pattern: binary
      ? `byte=(0x${streamName === "stdout" ? "35" : "a7"}+absolute_offset*73)&0xff`
      : `${streamName.toUpperCase()}_ASCII_PATTERN`,
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const root = canonicalReportRoot(parsed.values.get("--report-dir"));
  const byteCount = boundedInteger(parsed.values.get("--bytes"), "--bytes", 0, MAX_BYTES_PER_STREAM);
  const chunkBytes = boundedInteger(parsed.values.get("--chunk-bytes"), "--chunk-bytes", 1, 1024 * 1024, DEFAULT_CHUNK_BYTES);
  const exitCode = boundedInteger(parsed.values.get("--exit-code"), "--exit-code", 0, 255, 0);
  const binary = parsed.mode.startsWith("binary-");
  const selected = parsed.mode.endsWith("simultaneous")
    ? ["stdout", "stderr"]
    : [parsed.mode.endsWith("stderr") ? "stderr" : "stdout"];

  writeJsonOnce(root, "plan.json", {
    schema_version: "rickgent.process-supervisor-output-fixture.v1",
    fixture: "output-flood",
    mode: parsed.mode,
    pid: process.pid,
    binary,
    selected_streams: selected,
    bytes_per_stream: byteCount,
    chunk_bytes: chunkBytes,
    exit_code: exitCode,
    memory_contract: "one fixed-size chunk per selected stream; no output accumulation",
  });

  const receipts = await Promise.all(selected.map((streamName) =>
    emitStream(streamName, binary, byteCount, chunkBytes)));

  writeJsonOnce(root, "result.json", {
    schema_version: "rickgent.process-supervisor-output-fixture.v1",
    fixture: "output-flood",
    mode: parsed.mode,
    pid: process.pid,
    streams: receipts,
    exit_code: exitCode,
  });
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`output-flood fixture failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 70;
});
