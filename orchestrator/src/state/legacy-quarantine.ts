import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type BigIntStats,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { LEGACY_ARTIFACT_KINDS } from "./schema.js";
import type { StateRecord, StateStore } from "./store.js";

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_GIT_SUBJECTS = 256;
const LEGACY_INVENTORY_AUTHORITY = Symbol("rickgent.legacy-inventory-authority");
const AUTHORIZED_LEGACY_INVENTORY_COMMANDS = new WeakSet<object>();
const KIND_SET = new Set<string>(LEGACY_ARTIFACT_KINDS);

export type LegacyArtifactKind = (typeof LEGACY_ARTIFACT_KINDS)[number];

export interface LegacyInventoryEntry {
  readonly kind: LegacyArtifactKind;
  readonly boundedPathIdentity: string;
  readonly statDigest: `sha256:${string}` | null;
  readonly contentDigest: `sha256:${string}` | null;
  readonly disposition: string;
}

export interface LegacyInventoryResult {
  readonly blocked: boolean;
  readonly findings: readonly LegacyInventoryEntry[];
  readonly records: readonly StateRecord[];
  readonly recovery: string;
}

export const LEGACY_QUARANTINE_RECOVERY =
  "Archive or remove every listed legacy artifact through an explicit operator action, then retry. Do not copy registry, ledger, lock, receipt, archive, or Git-subject terminal values into SQLite.";

export class LegacyInventoryCommand {
  readonly entries: readonly LegacyInventoryEntry[];
  readonly discoveredAt: string;
  readonly requireClear: boolean;

  constructor(authority: symbol, entries: readonly LegacyInventoryEntry[], discoveredAt: string, requireClear: boolean) {
    if (authority !== LEGACY_INVENTORY_AUTHORITY) throw new TypeError("legacy inventory commands can only be minted by LegacyDiagnosticService");
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.discoveredAt = discoveredAt;
    this.requireClear = requireClear;
    Object.freeze(this);
    AUTHORIZED_LEGACY_INVENTORY_COMMANDS.add(this);
  }
}

export function isAuthorizedLegacyInventoryCommand(value: unknown): value is LegacyInventoryCommand {
  return typeof value === "object" && value !== null && AUTHORIZED_LEGACY_INVENTORY_COMMANDS.has(value);
}

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function statProjection(stat: BigIntStats): string {
  return JSON.stringify({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtime_ns: stat.mtimeNs.toString(),
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
  });
}

function boundedIdentity(repoRoot: string, path: string): string {
  const value = relative(repoRoot, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../") || value.startsWith("/") || value.includes("\0")) {
    throw new TypeError("legacy diagnostic path escaped the canonical repository root");
  }
  return value;
}

interface ObservedFile {
  readonly identity: string;
  readonly statDigest: `sha256:${string}`;
  readonly content: Buffer | null;
  readonly contentDigest: `sha256:${string}` | null;
  readonly state: "regular" | "directory" | "symlink" | "other" | "oversize" | "unstable";
}

function observePath(repoRoot: string, path: string): ObservedFile | null {
  let initial: BigIntStats;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const identity = boundedIdentity(repoRoot, path);
  const statDigest = digest(statProjection(initial));
  if (initial.isSymbolicLink()) return { identity, statDigest, content: null, contentDigest: null, state: "symlink" };
  if (initial.isDirectory()) return { identity, statDigest, content: null, contentDigest: null, state: "directory" };
  if (!initial.isFile()) return { identity, statDigest, content: null, contentDigest: null, state: "other" };
  if (initial.size > BigInt(MAX_DIAGNOSTIC_BYTES)) return { identity, statDigest, content: null, contentDigest: null, state: "oversize" };

  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size || opened.mtimeNs !== initial.mtimeNs) {
      return { identity, statDigest, content: null, contentDigest: null, state: "unstable" };
    }
    const content = readFileSync(descriptor);
    return { identity, statDigest, content, contentDigest: digest(content), state: "regular" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return { identity, statDigest, content: null, contentDigest: null, state: "unstable" };
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function structuralDisposition(observed: ObservedFile): string | null {
  return observed.state === "regular" ? null : `quarantined_${observed.state}_legacy_artifact`;
}

function entry(observed: ObservedFile, kind: LegacyArtifactKind, disposition: string): LegacyInventoryEntry {
  if (!KIND_SET.has(kind)) throw new TypeError(`unsupported legacy artifact kind: ${kind}`);
  return Object.freeze({
    kind,
    boundedPathIdentity: observed.identity,
    statDigest: observed.statDigest,
    contentDigest: observed.contentDigest,
    disposition,
  });
}

function fileFinding(repoRoot: string, path: string, kind: LegacyArtifactKind): LegacyInventoryEntry | null {
  const observed = observePath(repoRoot, path);
  if (observed === null) return null;
  const structural = structuralDisposition(observed);
  if (structural !== null || observed.content === null) return entry(observed, kind, structural ?? "quarantined_unreadable_legacy_artifact");
  return entry(observed, kind, kind === "registry.json" ? "quarantined_registry_json" : "quarantined_legacy_ledger");
}

function directoryFinding(repoRoot: string, path: string, kind: LegacyArtifactKind): LegacyInventoryEntry | null {
  const observed = observePath(repoRoot, path);
  if (observed === null) return null;
  return entry(observed, kind, observed.state === "directory" ? "quarantined_legacy_directory" : structuralDisposition(observed) ?? "quarantined_legacy_artifact");
}

function lockFindings(repoRoot: string, legacyRoot: string): LegacyInventoryEntry[] {
  const lockRoot = join(legacyRoot, "locks");
  const root = observePath(repoRoot, lockRoot);
  if (root === null) return [];
  if (root.state !== "directory") return [entry(root, "locks/*.lock", structuralDisposition(root) ?? "quarantined_legacy_lock_root")];
  const findings: LegacyInventoryEntry[] = [];
  for (const name of readdirSync(lockRoot).filter((value) => value.endsWith(".lock")).sort()) {
    const observed = observePath(repoRoot, join(lockRoot, name));
    if (observed !== null) findings.push(entry(observed, "locks/*.lock", observed.state === "regular" ? "quarantined_legacy_lock" : structuralDisposition(observed) ?? "quarantined_legacy_lock"));
  }
  return findings;
}

function gitSubjectFindings(repoRoot: string): LegacyInventoryEntry[] {
  let output: string;
  try {
    output = execFileSync("git", [
      "log", "--all", "--regexp-ignore-case", "--grep=^ticket[:[:space:]]", `--max-count=${MAX_GIT_SUBJECTS + 1}`,
      "--format=%s%x00",
    ], { cwd: repoRoot, encoding: "utf8", maxBuffer: MAX_DIAGNOSTIC_BYTES, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [Object.freeze({
      kind: "ticket: <id> Git subjects",
      boundedPathIdentity: "git/commit-subject-scan",
      statDigest: null,
      contentDigest: null,
      disposition: "quarantined_git_subject_scan_failed",
    })];
  }
  const tokens = output.split("\0").filter((value) => value !== "");
  if (tokens.length === 0) return [];
  const truncated = tokens.length > MAX_GIT_SUBJECTS;
  const subjects = tokens.slice(0, MAX_GIT_SUBJECTS);
  return [Object.freeze({
    kind: "ticket: <id> Git subjects",
    boundedPathIdentity: "git/ticket-subjects",
    statDigest: digest(JSON.stringify({ count: subjects.length, truncated })),
    contentDigest: digest(subjects.join("\0")),
    disposition: truncated ? "quarantined_git_subject_scan_truncated" : "quarantined_git_subject_authority",
  })];
}

export function discoverLegacyArtifacts(store: Pick<StateStore, "location">): readonly LegacyInventoryEntry[] {
  const repoRoot = store.location.repoRealpath;
  const legacyRoot = join(repoRoot, ".rickgent");
  const root = observePath(repoRoot, legacyRoot);
  const findings: LegacyInventoryEntry[] = [];
  if (root !== null && root.state !== "directory") {
    findings.push(entry(root, "legacy attempt receipts", structuralDisposition(root) ?? "quarantined_legacy_root"));
  } else if (root?.state === "directory") {
    for (const [name, kind] of [
      ["registry.json", "registry.json"],
      ["dispatch-ledger.jsonl", "dispatch-ledger.jsonl"],
      ["runs.jsonl", "runs.jsonl"],
      ["interventions.jsonl", "interventions.jsonl"],
      ["salvage-dispositions.jsonl", "salvage-dispositions.jsonl"],
      ["prs.jsonl", "prs.jsonl"],
      ["defects.jsonl", "defects.jsonl"],
    ] as const) {
      const finding = fileFinding(repoRoot, join(legacyRoot, name), kind);
      if (finding !== null) findings.push(finding);
    }
    findings.push(...lockFindings(repoRoot, legacyRoot));
    for (const name of ["attempts", "attempt-receipts"] as const) {
      const finding = directoryFinding(repoRoot, join(legacyRoot, name), "legacy attempt receipts");
      if (finding !== null) findings.push(finding);
    }
    const salvage = directoryFinding(repoRoot, join(legacyRoot, "salvage-archives"), "salvage archives");
    if (salvage !== null) findings.push(salvage);
  }
  findings.push(...gitSubjectFindings(repoRoot));
  findings.sort((left, right) => left.boundedPathIdentity < right.boundedPathIdentity ? -1 : left.boundedPathIdentity > right.boundedPathIdentity ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
  return Object.freeze(findings);
}

export class LegacyDiagnosticService {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  inventory(): LegacyInventoryResult {
    const findings = discoverLegacyArtifacts(this.#store);
    const records = this.#store.commitAuthorizedLegacyInventory(
      new LegacyInventoryCommand(LEGACY_INVENTORY_AUTHORITY, findings, new Date().toISOString(), false),
    );
    return Object.freeze({
      blocked: findings.length > 0,
      findings,
      records,
      recovery: LEGACY_QUARANTINE_RECOVERY,
    });
  }

  requireMutationClear(): LegacyInventoryResult {
    const findings = discoverLegacyArtifacts(this.#store);
    const records = this.#store.commitAuthorizedLegacyInventory(
      new LegacyInventoryCommand(LEGACY_INVENTORY_AUTHORITY, findings, new Date().toISOString(), true),
    );
    return Object.freeze({ blocked: false, findings, records, recovery: LEGACY_QUARANTINE_RECOVERY });
  }
}
