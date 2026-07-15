import { createHash } from "crypto";
import {
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "fs";
import { basename, isAbsolute, join, relative, sep } from "path";
import { parse } from "yaml";
import type { DispatchId } from "./dispatch.js";

export interface MaterializedWorkerBundle {
  readonly kind: "materialized_structured_worker";
  readonly templateDir: string;
  readonly bundleDir: string;
  readonly configPath: string;
  readonly configSha256: string;
}

function pathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateTreeHasNoSymlinks(current: string): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`worker template contains symlink: ${path}`);
    if (info.isDirectory()) validateTreeHasNoSymlinks(path);
    else if (!info.isFile()) throw new Error(`worker template contains unsupported entry: ${path}`);
  }
}

function requestsCommit(instructions: string): boolean {
  for (const match of instructions.matchAll(/\bcommit(?:s|ted|ting)?\b/gi)) {
    const index = match.index ?? 0;
    const sentenceStart = Math.max(
      instructions.lastIndexOf(".", index - 1),
      instructions.lastIndexOf("!", index - 1),
      instructions.lastIndexOf("?", index - 1),
      instructions.lastIndexOf("\n", index - 1),
    ) + 1;
    const prefix = instructions.slice(sentenceStart, index);
    if (!/\b(?:do not|never|must not|may not|cannot)\b/i.test(prefix)) return true;
  }
  return false;
}

function validateWorkerConfig(configPath: string): Buffer {
  const raw = readFileSync(configPath);
  let config: unknown;
  try {
    config = parse(raw.toString("utf-8"));
  } catch (error) {
    throw new Error(`worker config YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== "object") throw new Error("worker config must be a mapping");
  const value = config as Record<string, unknown>;
  if (value["name"] !== "worker") throw new Error("worker config name must be exactly 'worker'");
  const instructions = value["instructions"];
  if (typeof instructions !== "string" || instructions.trim() === "") {
    throw new Error("worker instructions must be non-empty");
  }
  if (requestsCommit(instructions) || /\bgit\s+(?:add|commit|push|merge|reset|checkout|switch)\b/i.test(instructions)) {
    throw new Error("worker instructions request Git mutation or a commit");
  }
  if (!/(?:do not|never)[^\n.]{0,120}\b(?:commit|terminal|completion)\b/i.test(instructions)) {
    throw new Error("worker instructions must explicitly forbid commit or terminal completion claims");
  }
  const tools = value["tools"];
  const builtins = tools && typeof tools === "object"
    ? (tools as Record<string, unknown>)["builtins"]
    : null;
  const actual = Array.isArray(builtins) ? builtins : [];
  const expected = ["sys_os_read", "sys_os_write", "sys_os_edit"];
  if (
    actual.length !== expected.length ||
    actual.some((tool) => typeof tool !== "string" || !expected.includes(tool)) ||
    expected.some((tool) => !actual.includes(tool))
  ) {
    throw new Error("worker config must expose only structured read/write/edit builtins");
  }
  return raw;
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else {
      copyFileSync(from, to);
      const sourceMode = statSync(from).mode & 0o777;
      // Materialized policy/context is private to this attempt.
      const mode = sourceMode & 0o100 ? 0o700 : 0o600;
      try {
        chmodSync(to, mode);
      } catch {
        throw new Error(`could not restrict materialized worker file mode: ${to}`);
      }
    }
  }
}

function safePart(value: string | number): string {
  const normalized = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

export function materializeWorkerBundle(
  agentRoot: string,
  materializationRoot: string,
  id: DispatchId,
): MaterializedWorkerBundle {
  const canonicalRoot = realpathSync(agentRoot);
  const requestedTemplate = join(canonicalRoot, "agents", "worker");
  const requestedTemplateInfo = lstatSync(requestedTemplate);
  if (requestedTemplateInfo.isSymbolicLink()) {
    throw new Error("worker template directory must not be a symlink");
  }
  if (!requestedTemplateInfo.isDirectory()) throw new Error("worker template is not a directory");
  const templateDir = realpathSync(requestedTemplate);
  if (!pathInside(canonicalRoot, templateDir) || basename(templateDir) !== "worker") {
    throw new Error("worker template escapes the configured Rickgent agent root");
  }
  validateTreeHasNoSymlinks(templateDir);
  validateWorkerConfig(join(templateDir, "config.yaml"));

  mkdirSync(materializationRoot, { recursive: true, mode: 0o700 });
  const attemptName = [id.runId, id.ticketId, id.phase, id.attempt, id.role].map(safePart).join("--");
  const attemptRoot = join(materializationRoot, attemptName);
  // The attempt directory is exclusive. Reuse/collision is a hard failure.
  mkdirSync(attemptRoot, { mode: 0o700 });
  const bundleDir = join(attemptRoot, "agents", "rickgent", "agents", "worker");
  mkdirSync(join(bundleDir, ".."), { recursive: true, mode: 0o700 });
  copyTree(templateDir, bundleDir);

  const configPath = join(bundleDir, "config.yaml");
  const configRaw = validateWorkerConfig(configPath);
  return Object.freeze({
    kind: "materialized_structured_worker" as const,
    templateDir,
    bundleDir,
    configPath,
    configSha256: createHash("sha256").update(configRaw).digest("hex"),
  });
}
