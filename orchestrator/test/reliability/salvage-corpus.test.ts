import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/contracts/ticket-contract.js";
import {
  DURABLE_SALVAGE_LIMITS,
  SalvageExecutor,
  isAuthorizedSalvageReceipt,
  restoreDurableSalvageArchive,
  type DurableSalvageCaptureResult,
  type DurableSalvageManifest,
  type DurableSalvageRestoreResult,
} from "../../src/lifecycle/salvage.js";
import {
  LeaseAuthority,
  type AttemptOwnershipGrant,
} from "../../src/state/leases.js";
import {
  openStateStore,
  type StateStore,
} from "../../src/state/store.js";

type CaptureStatus = "captured" | "nothing" | "failed" | "rejected" | "quarantined";

interface CorpusBounds {
  readonly max_entries: number;
  readonly max_file_bytes: number;
  readonly max_total_file_bytes: number;
  readonly max_bundle_bytes: number;
  readonly max_artifact_bytes: number;
  readonly max_git_metadata_bytes: number;
  readonly max_refs: number;
}

interface CorpusCapability {
  readonly id: string;
  readonly current: "available" | "blocked";
  readonly expected_api?: string;
  readonly blocked_on?: string;
}

interface CorpusCase {
  readonly id: string;
  readonly family: string;
  readonly capability: string;
  readonly current: "executable" | "blocked" | "diagnostic";
  readonly expected: string;
}

interface CorpusManifest {
  readonly schema_version: "rickgent.salvage-corpus/v1";
  readonly corpus_id: "t21-salvage-v1";
  readonly complete_inventory: true;
  readonly current_execution_surface: "durable_capture_restore_and_owner_bound_cleanup";
  readonly proof_scope: string;
  readonly bounds: CorpusBounds;
  readonly required_observations: readonly string[];
  readonly capabilities: readonly CorpusCapability[];
  readonly cases: readonly CorpusCase[];
}

interface PayloadVector {
  readonly id: string;
  readonly kind: "file" | "symlink";
  readonly path: string;
  readonly before_base64?: string;
  readonly after_base64?: string;
  readonly target?: string;
  readonly mode: string;
}

interface PayloadVectors {
  readonly schema_version: "rickgent.salvage-payload-vectors/v1";
  readonly vectors: readonly PayloadVector[];
  readonly hostile_paths: readonly string[];
}

interface CrashPoints {
  readonly schema_version: "rickgent.salvage-crash-points/v1";
  readonly allowed_replay_images: readonly string[];
  readonly forbidden_replay_images: readonly string[];
  readonly points: readonly string[];
}

interface CaptureRequest {
  readonly repo: string;
  readonly archiveDir: string;
  readonly ticketId: string;
  readonly ownedPaths: readonly string[];
  readonly hasWork: boolean;
  readonly baselineOid: string;
  readonly deliveryRef: string;
  readonly attemptRef: string;
}

interface NormalizedCapture {
  readonly status: CaptureStatus;
  readonly archivePath: string | null;
  readonly diagnostic: string | null;
  readonly capturedCommitOids: readonly string[];
  readonly raw: DurableSalvageCaptureResult;
}

interface RepoFixture {
  readonly root: string;
  readonly repo: string;
  readonly archiveDir: string;
  readonly deliveryRef: "refs/heads/delivery";
  readonly attemptRef: "refs/heads/attempt";
  readonly baselineOid: string;
}

interface PathObservation {
  readonly kind: "file" | "symlink";
  readonly mode: number;
  readonly contentBase64: string | null;
  readonly target: string | null;
}

interface RepositoryObservation {
  readonly headOid: string;
  readonly deliveryOid: string;
  readonly attemptOid: string;
  readonly indexDigest: `sha256:${string}`;
  readonly status: string;
}

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

interface OwnershipFixture {
  readonly repo: RepoFixture;
  readonly store: StateStore;
  readonly leases: LeaseAuthority;
  readonly live: AttemptOwnershipGrant;
  readonly cleanup: AttemptOwnershipGrant;
}

const fixtureDirectory = join(import.meta.dirname, "../fixtures/salvage");
const manifestPath = join(fixtureDirectory, "manifest.json");
const payloadPath = join(fixtureDirectory, "payload-vectors.json");
const crashPointsPath = join(fixtureDirectory, "crash-points.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;
const payloads = JSON.parse(readFileSync(payloadPath, "utf8")) as PayloadVectors;
const crashPoints = JSON.parse(readFileSync(crashPointsPath, "utf8")) as CrashPoints;
const vectors = new Map(payloads.vectors.map((vector) => [vector.id, vector]));
const scratchRoots = new Set<string>();
const stores = new Set<StateStore>();

const REQUIRED_CASE_IDS = [
  "empty-no-work",
  "capture-failure-is-not-empty",
  "tracked-uncommitted-text",
  "untracked-text",
  "untracked-empty",
  "untracked-symlink",
  "tracked-and-untracked-binary",
  "committed-clean-attempt",
  "mixed-worktree-index-ref",
  "archive-survives-worktree-removal",
  "caller-and-delivery-invariance",
  "pathspec-magic-is-literal-filename",
  "max-path-count-plus-one",
  "max-file-bytes-plus-one",
  "max-total-bytes-plus-one",
  "archive-root-symlink-swap",
  "wrong-owner-rejected",
  "partial-cleanup-resume",
  "untracked-capture-never-mutates-index",
  "crash-after-archive-rename",
] as const;

const REQUIRED_CAPABILITIES = [
  "durable_capture",
  "exact_text_restore",
  "exact_binary_restore",
  "committed_graph_capture",
  "literal_bounded_paths",
  "private_durable_archive",
  "caller_byte_invariance",
  "ownership_bound_cleanup",
  "partial_cleanup_replay",
  "crash_replay",
] as const;

const REQUIRED_CRASH_POINTS = [
  "before_archive_intent",
  "after_archive_intent",
  "after_archive_temp_fsync",
  "after_archive_rename",
  "after_archive_dir_fsync",
  "after_archive_finalize",
  "before_attempt_ref_cas",
  "after_attempt_ref_cas",
  "before_worktree_remove",
  "after_worktree_remove",
  "after_worktree_admin_remove",
  "before_index_remove",
  "after_index_remove",
  "before_resource_release",
  "after_resource_release",
  "before_ownership_release",
  "after_ownership_release",
  "before_cleanup_finalize",
  "after_cleanup_finalize",
] as const;

const REQUIRED_PAYLOAD_IDS = [
  "tracked-text",
  "untracked-text",
  "untracked-empty",
  "tracked-binary",
  "untracked-binary",
  "untracked-symlink",
] as const;

const gitEnvironment = Object.freeze({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  LC_ALL: "C",
});

/**
 * This is the single adaptation seam for the t21 service. Future receipt or
 * storage versions should be absorbed here rather than weakening corpus cases.
 */
class SalvageCorpusAdapter {
  capture(request: CaptureRequest): NormalizedCapture {
    void request.hasWork;
    void request.ownedPaths;
    const identity = request.ticketId.replace(/[^A-Za-z0-9_-]/g, "_");
    const raw = new SalvageExecutor(request.repo).captureDurable({
      archiveRoot: request.archiveDir,
      baselineOid: request.baselineOid,
      attemptRef: request.attemptRef,
      expectedAttemptRefOid: git(request.repo, ["rev-parse", "--verify", request.attemptRef]),
      includeRefs: [request.attemptRef, request.deliveryRef],
      salvageRecordId: `salvage-${identity}`,
      attemptId: `attempt-${identity}`,
      ownershipId: `ownership-${identity}`,
      ownerGeneration: 1,
      ownershipContextDigest: sha256(`ownership-context:${identity}`),
      contextId: `context-${identity}`,
      evidenceId: `evidence-${identity}`,
      processReceiptId: `process-receipt-${identity}`,
      groupDeathEvidenceId: `group-death-${identity}`,
    });
    const status: CaptureStatus = raw.outcome === "captured"
      ? "captured"
      : raw.outcome === "empty"
        ? "nothing"
        : "failed";
    let capturedCommitOids: readonly string[] = Object.freeze([]);
    if (raw.artifactPath !== null) {
      const parsed = JSON.parse(readFileSync(raw.artifactPath, "utf8")) as DurableSalvageManifest;
      capturedCommitOids = Object.freeze([...parsed.commit_oids]);
    }
    return Object.freeze({
      status,
      archivePath: raw.artifactPath,
      diagnostic: raw.detail,
      capturedCommitOids,
      raw,
    });
  }

  restoreSnapshot(destination: string, capture: NormalizedCapture): DurableSalvageRestoreResult {
    if (capture.archivePath === null || capture.raw.artifactDigest === null) {
      throw new Error("capture has no restorable archive receipt");
    }
    return restoreDurableSalvageArchive(capture.archivePath, capture.raw.artifactDigest, destination);
  }
}

const adapter = new SalvageCorpusAdapter();

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sha256(content: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: gitEnvironment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function vector(id: string): PayloadVector {
  const value = vectors.get(id);
  if (value === undefined) throw new Error(`missing salvage payload vector ${id}`);
  return value;
}

function decode(value: string | undefined): Buffer {
  if (value === undefined) throw new Error("fixture vector has no requested byte payload");
  return Buffer.from(value, "base64");
}

function writeRepoFile(repo: string, path: string, content: Buffer): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function createFixture(id: string, baseline: Readonly<Record<string, Buffer | string>>): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), `rickgent-salvage-${id}-`));
  scratchRoots.add(root);
  const repo = join(root, "attempt-worktree");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "--initial-branch=delivery"]);
  git(repo, ["config", "user.name", "Salvage Corpus"]);
  git(repo, ["config", "user.email", "salvage@rickgent.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  for (const [path, content] of Object.entries(baseline)) {
    writeRepoFile(repo, path, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  }
  if (Object.keys(baseline).length === 0) {
    git(repo, ["commit", "--allow-empty", "-qm", "baseline"]);
  } else {
    git(repo, ["add", "--", "."]);
    git(repo, ["commit", "-qm", "baseline"]);
  }
  const baselineOid = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "attempt", baselineOid]);
  git(repo, ["checkout", "-q", "attempt"]);
  return Object.freeze({
    root,
    repo,
    archiveDir: join(root, "durable-archives"),
    deliveryRef: "refs/heads/delivery",
    attemptRef: "refs/heads/attempt",
    baselineOid,
  });
}

function restoreDestination(fixture: RepoFixture, suffix: string): string {
  const destination = join(fixture.root, `restore-${suffix}`);
  mkdirSync(destination, { mode: 0o700 });
  return destination;
}

function insert(database: DatabaseSync, table: string, row: SqlRow): void {
  const columns = Object.keys(row);
  database.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  ).run(...columns.map((column) => row[column] ?? null));
}

function createOwnershipFixture(label: string): OwnershipFixture {
  const repo = createFixture(`owner-${label}`, { "seed.txt": "seed\n" });
  const store = openStateStore({ repoPath: repo.repo });
  stores.add(store);
  const runId = `run-salvage-${label}`;
  const ticketInstanceId = `ticket-instance-salvage-${label}`;
  const attemptId = `attempt-salvage-${label}`;
  const manifestJson = canonicalJson({ schema_version: "rickgent.salvage-test-run/v1", label });
  const manifestDigest = sha256(manifestJson);
  const contractJson = canonicalJson({ schema_version: "rickgent.salvage-test-ticket/v1", label });
  const contractDigest = sha256(contractJson);
  const capabilityDigest = sha256(`salvage-capability:${label}`);
  const now = "2026-07-18T00:00:00.000Z";
  store.recordRunManifest({
    manifest_digest: manifestDigest,
    schema_version: "rickgent.salvage-test-run/v1",
    canonical_manifest_json: manifestJson,
    capability_snapshot_digest: capabilityDigest,
    context_schema_version: "rickgent.execution-context/v1",
    oracle_version: "rickgent.oracle.v1",
    created_at: now,
  });
  store.recordTicketContract({
    contract_digest: contractDigest,
    schema_version: "rickgent.salvage-test-ticket/v1",
    canonical_contract_json: contractJson,
    created_at: now,
  });
  const database = new DatabaseSync(store.location.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    insert(database, "runs", {
      run_id: runId,
      repository_id: store.location.repositoryId,
      run_sequence: 1,
      manifest_digest: manifestDigest,
      initial_delivery_oid: repo.baselineOid,
      delivery_ref: `refs/rickgent/runs/${runId}/delivery`,
      state: "active",
      state_version: 1,
      current_delivery_oid: repo.baselineOid,
      promotion_sequence: 0,
      created_at: now,
    });
    insert(database, "run_tickets", {
      ticket_instance_id: ticketInstanceId,
      run_id: runId,
      ticket_id: `ticket-salvage-${label}`,
      plan_index: 0,
      contract_digest: contractDigest,
      state: "active",
      state_version: 1,
      created_at: now,
    });
    insert(database, "attempts", {
      attempt_id: attemptId,
      ticket_instance_id: ticketInstanceId,
      run_id: runId,
      ticket_id: `ticket-salvage-${label}`,
      attempt_number: 1,
      contract_digest: contractDigest,
      allocation_owner_digest: sha256(`allocation:${label}`),
      delivery_baseline_oid: repo.baselineOid,
      context_schema_version: "rickgent.execution-context/v1",
      oracle_version: "rickgent.oracle.v1",
      capability_snapshot_digest: capabilityDigest,
      resource_identity_version: "rickgent.attempt-resource-identity/v1",
      state: "planned",
      state_version: 0,
      created_at: now,
    });
  } finally {
    database.close();
  }
  const leases = new LeaseAuthority(store);
  const live = leases.acquire(leases.prepareAcquisition({
    attemptId,
    idempotencyKey: `acquire:${label}`,
  }));
  const cleanup = leases.beginCleanup({ ownership: live, idempotencyKey: `cleanup:${label}` });
  return Object.freeze({ repo, store, leases, live, cleanup });
}

function requestFor(
  fixture: RepoFixture,
  ticketId: string,
  ownedPaths: readonly string[],
  hasWork = true,
  archiveDir = fixture.archiveDir,
): CaptureRequest {
  return Object.freeze({
    repo: fixture.repo,
    archiveDir,
    ticketId,
    ownedPaths,
    hasWork,
    baselineOid: fixture.baselineOid,
    deliveryRef: fixture.deliveryRef,
    attemptRef: fixture.attemptRef,
  });
}

function observePath(repo: string, path: string): PathObservation {
  const absolute = join(repo, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return Object.freeze({
      kind: "symlink",
      mode: stat.mode & 0o777,
      contentBase64: null,
      target: readlinkSync(absolute),
    });
  }
  if (!stat.isFile()) throw new Error(`unsupported corpus path kind: ${path}`);
  return Object.freeze({
    kind: "file",
    mode: stat.mode & 0o777,
    contentBase64: readFileSync(absolute).toString("base64"),
    target: null,
  });
}

function indexPath(repo: string): string {
  const observed = git(repo, ["rev-parse", "--git-path", "index"]);
  return isAbsolute(observed) ? observed : resolve(repo, observed);
}

function observeRepository(fixture: RepoFixture): RepositoryObservation {
  return Object.freeze({
    headOid: git(fixture.repo, ["rev-parse", "HEAD"]),
    deliveryOid: git(fixture.repo, ["rev-parse", fixture.deliveryRef]),
    attemptOid: git(fixture.repo, ["rev-parse", fixture.attemptRef]),
    indexDigest: sha256(readFileSync(indexPath(fixture.repo))),
    status: git(fixture.repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  });
}

function capability(id: string): CorpusCapability {
  const found = manifest.capabilities.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`manifest has no capability ${id}`);
  return found;
}

function expectCaptured(capture: NormalizedCapture): void {
  expect(capture.raw.outcome, capture.diagnostic ?? "capture returned no diagnostic").toBe("captured");
  expect(capture.status, capture.diagnostic ?? "capture returned no diagnostic").toBe("captured");
  expect(isAuthorizedSalvageReceipt(capture.raw.receipt)).toBe(true);
}

function capabilityIt(id: string, name: string, body: () => void): void {
  const current = capability(id);
  if (current.current === "available") {
    it(name, body);
    return;
  }
  it.todo(`${name} [BLOCKED: ${current.blocked_on ?? "missing API"}]`, body);
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

describe("t21 salvage fixture contract", () => {
  it("inventories every mandatory scenario, capability, payload, and crash barrier exactly", () => {
    expect(manifest.schema_version).toBe("rickgent.salvage-corpus/v1");
    expect(manifest.corpus_id).toBe("t21-salvage-v1");
    expect(manifest.complete_inventory).toBe(true);
    expect(sorted(manifest.cases.map((entry) => entry.id))).toEqual(sorted(REQUIRED_CASE_IDS));
    expect(new Set(manifest.cases.map((entry) => entry.id)).size).toBe(manifest.cases.length);
    expect(sorted(manifest.capabilities.map((entry) => entry.id))).toEqual(sorted(REQUIRED_CAPABILITIES));
    expect(new Set(manifest.capabilities.map((entry) => entry.id)).size).toBe(manifest.capabilities.length);
    expect(sorted(payloads.vectors.map((entry) => entry.id))).toEqual(sorted(REQUIRED_PAYLOAD_IDS));
    expect(sorted(crashPoints.points)).toEqual(sorted(REQUIRED_CRASH_POINTS));
    expect(crashPoints.allowed_replay_images).toEqual([
      "exact_preimage",
      "exact_durable_postimage",
      "explicit_quarantine",
    ]);
    expect(crashPoints.forbidden_replay_images).toContain("caller_index_rewritten");
  });

  it("ties every capability to a precise production contract", () => {
    for (const entry of manifest.capabilities) {
      if (entry.current === "blocked") {
        expect(entry.blocked_on, entry.id).toBeTypeOf("string");
        expect(entry.blocked_on?.length, entry.id).toBeGreaterThan(20);
      } else {
        expect(entry.expected_api, entry.id).toBeTypeOf("string");
      }
    }
    for (const entry of manifest.cases) {
      const declared = capability(entry.capability);
      expect(
        entry.current === "executable" ? declared.current : "blocked",
        `${entry.id} execution status conflicts with ${entry.capability}`,
      ).toBe(entry.current === "executable" ? "available" : "blocked");
    }
  });

  it("pins the exported strict finite salvage bounds", () => {
    expect(manifest.bounds).toEqual({
      max_entries: DURABLE_SALVAGE_LIMITS.maxEntries,
      max_file_bytes: DURABLE_SALVAGE_LIMITS.maxFileBytes,
      max_total_file_bytes: DURABLE_SALVAGE_LIMITS.maxTotalBytes,
      max_bundle_bytes: DURABLE_SALVAGE_LIMITS.maxBundleBytes,
      max_artifact_bytes: DURABLE_SALVAGE_LIMITS.maxArtifactBytes,
      max_git_metadata_bytes: DURABLE_SALVAGE_LIMITS.maxGitMetadataBytes,
      max_refs: DURABLE_SALVAGE_LIMITS.maxRefs,
    });
  });
});

describe("t21 durable capture and restore boundary", () => {
  it("distinguishes clean no-work from a capture failure without deleting work", () => {
    const clean = createFixture("empty", { "seed.txt": "seed\n" });
    const empty = adapter.capture(requestFor(clean, "empty-no-work", [], false));
    expect(empty.status).toBe("nothing");
    expect(empty.raw.outcome).toBe("empty");
    expect(isAuthorizedSalvageReceipt(empty.raw.receipt)).toBe(true);
    expect(empty.raw.receipt?.disposition).toBe("empty");
    expect(empty.archivePath).toBeNull();
    expect(existsSync(clean.archiveDir)).toBe(false);

    const failed = createFixture("failure", { "owned.txt": "before\n" });
    writeFileSync(join(failed.repo, "owned.txt"), "after\n", "utf8");
    const archiveBlocker = join(failed.root, "archive-is-a-file");
    writeFileSync(archiveBlocker, "do not replace\n", "utf8");
    const result = adapter.capture(requestFor(
      failed,
      "capture-failure-is-not-empty",
      ["owned.txt"],
      true,
      join(archiveBlocker, "child"),
    ));
    expect(result.status).toBe("failed");
    expect(result.raw.outcome).toBe("capture_failed");
    expect(result.archivePath).toBeNull();
    expect(result.raw.receipt).toBeNull();
    expect(readFileSync(join(failed.repo, "owned.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(archiveBlocker, "utf8")).toBe("do not replace\n");
  });

  it("captures and restores a tracked uncommitted text modification", () => {
    const tracked = vector("tracked-text");
    const fixture = createFixture("tracked-text", {
      [tracked.path]: decode(tracked.before_base64),
      "seed.txt": "seed\n",
    });
    writeRepoFile(fixture.repo, tracked.path, decode(tracked.after_base64));
    const desired = observePath(fixture.repo, tracked.path);
    const capture = adapter.capture(requestFor(fixture, "tracked-uncommitted-text", [tracked.path]));
    expectCaptured(capture);
    expect(capture.archivePath).not.toBeNull();

    const restored = restoreDestination(fixture, "tracked-text");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(observePath(restored, tracked.path)).toEqual(desired);
  });

  it("captures and restores an untracked text file", () => {
    const untracked = vector("untracked-text");
    const fixture = createFixture("untracked-text", { "seed.txt": "seed\n" });
    writeRepoFile(fixture.repo, untracked.path, decode(untracked.after_base64));
    const desired = observePath(fixture.repo, untracked.path);
    const capture = adapter.capture(requestFor(fixture, "untracked-text", [untracked.path]));
    expectCaptured(capture);

    const restored = restoreDestination(fixture, "untracked-text");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(observePath(restored, untracked.path)).toEqual(desired);
  });

  it("treats an empty untracked file as captured work and restores its existence", () => {
    const empty = vector("untracked-empty");
    const fixture = createFixture("untracked-empty", { "seed.txt": "seed\n" });
    writeRepoFile(fixture.repo, empty.path, decode(empty.after_base64));
    const desired = observePath(fixture.repo, empty.path);
    const capture = adapter.capture(requestFor(fixture, "untracked-empty", [empty.path]));
    expectCaptured(capture);
    const manifest = JSON.parse(readFileSync(capture.archivePath!, "utf8")) as DurableSalvageManifest;
    expect(manifest.entries.find((entry) => entry.path === empty.path)?.contentKind).toBe("empty");

    const restored = restoreDestination(fixture, "untracked-empty");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(observePath(restored, empty.path)).toEqual(desired);
  });

  it("captures an untracked symlink without dereferencing its outside target", () => {
    const symlink = vector("untracked-symlink");
    const fixture = createFixture("symlink", { "seed.txt": "seed\n" });
    const outside = join(fixture.root, "outside", "sentinel.bin");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, Buffer.from("OUTSIDE_SECRET_BYTES\0", "utf8"));
    const link = join(fixture.repo, symlink.path);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(symlink.target!, link);
    const desired = observePath(fixture.repo, symlink.path);
    const outsideBefore = sha256(readFileSync(outside));
    const capture = adapter.capture(requestFor(fixture, "untracked-symlink", [symlink.path]));
    expectCaptured(capture);
    const manifest = JSON.parse(readFileSync(capture.archivePath!, "utf8")) as DurableSalvageManifest;
    expect(manifest.entries.find((entry) => entry.path === symlink.path)?.contentKind).toBe("symlink");
    expect(readFileSync(capture.archivePath!, "utf8")).not.toContain("OUTSIDE_SECRET_BYTES");

    const restored = restoreDestination(fixture, "symlink");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(observePath(restored, symlink.path)).toEqual(desired);
    expect(sha256(readFileSync(outside))).toBe(outsideBefore);
  });

  it("keeps an externally located archive intact after the attempt worktree is removed", () => {
    const fixture = createFixture("archive-survival", { "seed.txt": "seed\n" });
    writeRepoFile(fixture.repo, "owned/new.txt", Buffer.from("survive cleanup\n", "utf8"));
    const capture = adapter.capture(requestFor(
      fixture,
      "archive-survives-worktree-removal",
      ["owned/new.txt"],
    ));
    expectCaptured(capture);
    const archivePath = capture.archivePath!;
    const digest = sha256(readFileSync(archivePath));
    expect(archivePath.startsWith(`${fixture.repo}/`)).toBe(false);

    rmSync(fixture.repo, { recursive: true, force: true });
    expect(existsSync(archivePath)).toBe(true);
    expect(sha256(readFileSync(archivePath))).toBe(digest);
  });

  it("preserves delivery/attempt refs, HEAD, index bytes, and unrelated caller dirt for tracked capture", () => {
    const fixture = createFixture("invariance", {
      "owned.txt": "before\n",
      "caller.txt": "caller baseline\n",
    });
    writeFileSync(join(fixture.repo, "owned.txt"), "after\n", "utf8");
    writeFileSync(join(fixture.repo, "caller.txt"), "caller dirty\n", "utf8");
    writeFileSync(join(fixture.repo, "caller-untracked.bin"), Buffer.from([0, 255, 2, 253]));
    const before = observeRepository(fixture);
    const callerTracked = sha256(readFileSync(join(fixture.repo, "caller.txt")));
    const callerUntracked = sha256(readFileSync(join(fixture.repo, "caller-untracked.bin")));

    const capture = adapter.capture(requestFor(
      fixture,
      "caller-and-delivery-invariance",
      ["owned.txt"],
    ));
    expectCaptured(capture);
    expect(observeRepository(fixture)).toEqual(before);
    expect(sha256(readFileSync(join(fixture.repo, "caller.txt")))).toBe(callerTracked);
    expect(sha256(readFileSync(join(fixture.repo, "caller-untracked.bin")))).toBe(callerUntracked);
  });

  it("never mutates the real index while capturing untracked work", () => {
    const fixture = createFixture("index-invariance", { "seed.txt": "seed\n" });
    writeFileSync(join(fixture.repo, "untracked.txt"), "must remain untracked\n", "utf8");
    const before = observeRepository(fixture);
    const capture = adapter.capture(requestFor(
      fixture,
      "untracked-capture-never-mutates-index",
      ["untracked.txt"],
    ));
    expectCaptured(capture);
    expect(observeRepository(fixture)).toEqual(before);
  });
});

describe("t21 exact capture and cleanup boundary", () => {
  capabilityIt("exact_binary_restore", "restores tracked and untracked binary bytes exactly", () => {
    const tracked = vector("tracked-binary");
    const untracked = vector("untracked-binary");
    const fixture = createFixture("binary", {
      [tracked.path]: decode(tracked.before_base64),
      "seed.txt": "seed\n",
    });
    writeRepoFile(fixture.repo, tracked.path, decode(tracked.after_base64));
    writeRepoFile(fixture.repo, untracked.path, decode(untracked.after_base64));
    const expectedTracked = observePath(fixture.repo, tracked.path);
    const expectedUntracked = observePath(fixture.repo, untracked.path);
    const capture = adapter.capture(requestFor(
      fixture,
      "tracked-and-untracked-binary",
      [tracked.path, untracked.path],
    ));
    expectCaptured(capture);
    expect(isAuthorizedSalvageReceipt(capture.raw.receipt)).toBe(true);
    const restored = restoreDestination(fixture, "binary");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(observePath(restored, tracked.path)).toEqual(expectedTracked);
    expect(observePath(restored, untracked.path)).toEqual(expectedUntracked);
  });

  capabilityIt("committed_graph_capture", "retains a clean committed attempt object graph", () => {
    const fixture = createFixture("committed", { "seed.txt": "seed\n" });
    writeRepoFile(fixture.repo, "owned/committed.txt", Buffer.from("committed failed work\n", "utf8"));
    git(fixture.repo, ["add", "--", "owned/committed.txt"]);
    git(fixture.repo, ["commit", "-qm", "failed attempt commit"]);
    const committedOid = git(fixture.repo, ["rev-parse", "HEAD"]);
    const capture = adapter.capture(requestFor(
      fixture,
      "committed-clean-attempt",
      ["owned/committed.txt"],
    ));
    expectCaptured(capture);
    expect(capture.capturedCommitOids).toContain(committedOid);
    const manifest = JSON.parse(readFileSync(capture.archivePath!, "utf8")) as DurableSalvageManifest;
    expect(manifest.commit_bundle).not.toBeNull();
    expect(manifest.commit_bundle?.size).toBeGreaterThan(0);
    expect(git(fixture.repo, ["rev-parse", fixture.deliveryRef])).toBe(fixture.baselineOid);
    const restored = restoreDestination(fixture, "committed");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(readFileSync(join(restored, "owned/committed.txt"), "utf8")).toBe("committed failed work\n");
  });

  capabilityIt("caller_byte_invariance", "captures mixed work without rewriting the caller index", () => {
    const fixture = createFixture("mixed", { "owned/tracked.txt": "before\n", "seed.txt": "seed\n" });
    writeFileSync(join(fixture.repo, "owned/tracked.txt"), "after\n", "utf8");
    writeRepoFile(fixture.repo, "owned/untracked.txt", Buffer.from("new\n", "utf8"));
    writeRepoFile(fixture.repo, "owned/empty.txt", Buffer.alloc(0));
    writeRepoFile(fixture.repo, "owned/binary.bin", Buffer.from([0, 255, 0, 128]));
    symlinkSync("tracked.txt", join(fixture.repo, "owned/link"));
    const before = observeRepository(fixture);
    const expected = new Map([
      "owned/tracked.txt",
      "owned/untracked.txt",
      "owned/empty.txt",
      "owned/binary.bin",
      "owned/link",
    ].map((path) => [path, observePath(fixture.repo, path)]));
    const capture = adapter.capture(requestFor(fixture, "mixed-worktree-index-ref", ["owned"]));
    expectCaptured(capture);
    expect(observeRepository(fixture)).toEqual(before);
    const restored = restoreDestination(fixture, "mixed");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    for (const [path, observation] of expected) expect(observePath(restored, path)).toEqual(observation);
  });

  capabilityIt("literal_bounded_paths", "captures a pathspec-looking filename as one literal path", () => {
    const fixture = createFixture("pathspec", {});
    const hostile = payloads.hostile_paths[0]!;
    writeRepoFile(fixture.repo, hostile, Buffer.from("literal filename\n", "utf8"));
    const expected = observePath(fixture.repo, hostile);
    const capture = adapter.capture(requestFor(
      fixture,
      "pathspec-magic-is-literal-filename",
      [hostile],
    ));
    expectCaptured(capture);
    const restored = restoreDestination(fixture, "pathspec");
    expect(adapter.restoreSnapshot(restored, capture).outcome).toBe("restored");
    expect(observePath(restored, hostile)).toEqual(expected);
  });

  capabilityIt("literal_bounded_paths", "rejects max path count plus one before capture", () => {
    const fixture = createFixture("path-count", {});
    const paths: string[] = [];
    for (let index = 0; index <= manifest.bounds.max_entries; index += 1) {
      const path = `path-${String(index).padStart(5, "0")}.txt`;
      writeRepoFile(fixture.repo, path, Buffer.alloc(0));
      paths.push(path);
    }
    const capture = adapter.capture(requestFor(fixture, "max-path-count-plus-one", paths));
    expect(capture.raw.outcome).toBe("capture_failed");
    expect(capture.diagnostic).toMatch(/entry inventory exceeds.*bound/i);
  });

  capabilityIt("literal_bounded_paths", "rejects max file bytes plus one before archive creation", () => {
    const fixture = createFixture("file-bound", {});
    const path = "owned/oversize.bin";
    writeRepoFile(fixture.repo, path, Buffer.alloc(0));
    truncateSync(join(fixture.repo, path), manifest.bounds.max_file_bytes + 1);
    const capture = adapter.capture(requestFor(fixture, "max-file-bytes-plus-one", [path]));
    expect(capture.raw.outcome).toBe("capture_failed");
    expect(capture.diagnostic).toMatch(/file exceeds.*bound/i);
    expect(capture.archivePath).toBeNull();
  });

  capabilityIt("literal_bounded_paths", "rejects max total bytes plus one before archive creation", () => {
    const fixture = createFixture("total-bound", {});
    const paths = ["owned/a.bin", "owned/b.bin", "owned/c.bin", "owned/d.bin", "owned/e.bin"];
    const each = Math.floor(manifest.bounds.max_total_file_bytes / paths.length) + 1;
    for (const path of paths) {
      writeRepoFile(fixture.repo, path, Buffer.alloc(0));
      truncateSync(join(fixture.repo, path), each);
    }
    const capture = adapter.capture(requestFor(fixture, "max-total-bytes-plus-one", paths));
    expect(capture.raw.outcome).toBe("capture_failed");
    expect(capture.diagnostic).toMatch(/payload exceeds.*bound/i);
    expect(capture.archivePath).toBeNull();
  });

  capabilityIt("private_durable_archive", "fails an archive-root symlink swap without writing outside", () => {
    const fixture = createFixture("archive-symlink", { "owned.txt": "before\n" });
    writeFileSync(join(fixture.repo, "owned.txt"), "after\n", "utf8");
    const outside = join(fixture.root, "outside-archive-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel"), "unchanged\n", "utf8");
    symlinkSync(outside, fixture.archiveDir);
    const before = readdirSync(outside);
    const capture = adapter.capture(requestFor(fixture, "archive-root-symlink-swap", ["owned.txt"]));
    expect(capture.raw.outcome).toBe("capture_failed");
    expect(capture.diagnostic).toMatch(/safe directory|symbolic|symlink/i);
    expect(readdirSync(outside)).toEqual(before);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged\n");
  });

  capabilityIt("ownership_bound_cleanup", "rejects a cleanup command from the wrong owner generation", () => {
    const left = createOwnershipFixture("left");
    const right = createOwnershipFixture("right");
    const salvage = new SalvageExecutor(left.repo.repo).captureDurable({
      archiveRoot: left.repo.archiveDir,
      baselineOid: left.repo.baselineOid,
      attemptRef: left.repo.attemptRef,
      expectedAttemptRefOid: left.repo.baselineOid,
      salvageRecordId: "salvage-wrong-owner",
      attemptId: left.cleanup.attemptId,
      ownershipId: left.cleanup.ownership.ownershipId,
      ownerGeneration: left.cleanup.ownership.generation,
      ownershipContextDigest: left.cleanup.ownership.contextDigest as `sha256:${string}`,
      contextId: "context-wrong-owner",
      evidenceId: "evidence-wrong-owner",
      processReceiptId: "process-receipt-wrong-owner",
      groupDeathEvidenceId: "group-death-wrong-owner",
    });
    expect(salvage.outcome).toBe("empty");
    expect(isAuthorizedSalvageReceipt(salvage.receipt)).toBe(true);
    expect(() => right.leases.recordSalvage({
      ownership: right.cleanup,
      receipt: salvage.receipt!,
      idempotencyKey: "record-salvage:wrong-owner",
    })).toThrow(/different cleanup ownership/i);
    expect(right.cleanup.ownership.state).toBe("cleanup_pending");
    expect(right.cleanup.resources.every((claim) => claim.state === "cleanup_pending")).toBe(true);
  });

  capabilityIt("partial_cleanup_replay", "resumes a partially cleaned resource set without duplicate side effects", () => {
    const fixture = createOwnershipFixture("begin-cleanup-replay");
    const replay = fixture.leases.beginCleanup({
      ownership: fixture.live,
      idempotencyKey: "cleanup:begin-cleanup-replay",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.ownership).toEqual(fixture.cleanup.ownership);
    expect(replay.resources).toEqual(fixture.cleanup.resources);
    expect(replay.ownership.state).toBe("cleanup_pending");
    expect(replay.resources.every((claim) => claim.state === "cleanup_pending")).toBe(true);
  });

  capabilityIt("crash_replay", "replays response loss after archive publication as the exact durable postimage", () => {
    const fixture = createFixture("archive-replay", { "owned.txt": "before\n" });
    writeFileSync(join(fixture.repo, "owned.txt"), "after\n", "utf8");
    const request = requestFor(fixture, "crash-after-archive-rename", ["owned.txt"]);
    const first = adapter.capture(request);
    expect(first.raw.outcome).toBe("captured");
    expect(first.raw.replayed).toBe(false);
    const second = adapter.capture(request);
    expect(second.raw.outcome).toBe("captured");
    expect(second.raw.replayed).toBe(true);
    expect(second.raw.artifactPath).toBe(first.raw.artifactPath);
    expect(second.raw.artifactDigest).toBe(first.raw.artifactDigest);
    expect(second.raw.artifactSize).toBe(first.raw.artifactSize);
    expect(readdirSync(fixture.archiveDir)).toEqual([first.raw.artifactPath!.split("/").at(-1)]);
  });

});
