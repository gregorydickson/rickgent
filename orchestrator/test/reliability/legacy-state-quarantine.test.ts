import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_QUARANTINE_RECOVERY,
  LegacyDiagnosticService,
  LegacyInventoryCommand,
} from "../../src/state/legacy-quarantine.js";
import { StateStoreError, openStateStore, type StateStore } from "../../src/state/store.js";

const stores = new Set<StateStore>();
const roots = new Set<string>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rickgent-legacy-quarantine-"));
  roots.add(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "legacy@example.com"]);
  git(repo, ["config", "user.name", "Legacy Test"]);
  writeFileSync(join(repo, "README.md"), "baseline\n", { mode: 0o600 });
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial baseline"]);
  return repo;
}

function open(repo: string): StateStore {
  const store = openStateStore({ repoPath: repo });
  stores.add(store);
  return store;
}

function rows(store: StateStore, sql: string): Array<Record<string, unknown>> {
  const database = new DatabaseSync(store.location.databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

describe("legacy lifecycle state quarantine", () => {
  it("uses only the canonical repository root and returns clear when it is absent", () => {
    const repo = makeRepo();
    const foreign = mkdtempSync(join(tmpdir(), "rickgent-legacy-foreign-"));
    roots.add(foreign);
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "registry.json"), JSON.stringify({ tickets: { t01: { status: "Done" } } }));
    const previous = process.env.RICKGENT_DIR;
    process.env.RICKGENT_DIR = foreign;
    try {
      const store = open(repo);
      const result = new LegacyDiagnosticService(store).requireMutationClear();
      expect(result).toMatchObject({ blocked: false, findings: [], records: [] });
      expect(store.readLegacyInventory()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.RICKGENT_DIR;
      else process.env.RICKGENT_DIR = previous;
    }
  });

  it("quarantines valid terminal registry, terminal ledgers, locks, and Git subjects without importing truth", () => {
    const repo = makeRepo();
    const legacy = join(repo, ".rickgent");
    mkdirSync(join(legacy, "locks"), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, "registry.json"), JSON.stringify({
      runId: "legacy-run",
      tickets: { t01: { id: "t01", status: "Done", completionCommitSha: "f".repeat(40) } },
    }));
    writeFileSync(join(legacy, "runs.jsonl"), `${JSON.stringify({ runId: "legacy-run", state: "delivered" })}\n`);
    writeFileSync(join(legacy, "locks", "t01.lock"), "stale legacy owner\n");
    git(repo, ["commit", "--allow-empty", "-q", "-m", "ticket: t01 legacy completion"]);

    const store = open(repo);
    const service = new LegacyDiagnosticService(store);
    let captured: unknown;
    try {
      service.requireMutationClear();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(StateStoreError);
    expect(captured).toMatchObject({
      code: "RICKGENT_LEGACY_STATE_QUARANTINED",
      failureClass: "infrastructure",
      recovery: LEGACY_QUARANTINE_RECOVERY,
    });
    expect((captured as StateStoreError).recovery).toContain("Do not copy");

    const inventory = store.readLegacyInventory();
    expect(inventory.map((row) => row.disposition)).toEqual(expect.arrayContaining([
      "quarantined_registry_json",
      "quarantined_legacy_ledger",
      "quarantined_legacy_lock",
      "quarantined_git_subject_authority",
    ]));
    expect(inventory.every((row) => row.repository_id === store.location.repositoryId)).toBe(true);
    expect(rows(store, `
      SELECT
        (SELECT COUNT(*) FROM runs) AS runs,
        (SELECT COUNT(*) FROM run_tickets) AS tickets,
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM evidence) AS evidence,
        (SELECT COUNT(*) FROM oracle_decisions) AS oracle_decisions,
        (SELECT COUNT(*) FROM delivery_records) AS delivery_records
    `)).toEqual([{ runs: 0, tickets: 0, attempts: 0, evidence: 0, oracle_decisions: 0, delivery_records: 0 }]);
  });

  it("does not treat corrupt, duplicate, stale-terminal, or symlinked legacy inputs as empty state", () => {
    const repo = makeRepo();
    const legacy = join(repo, ".rickgent");
    mkdirSync(join(legacy, "locks"), { recursive: true });
    writeFileSync(join(legacy, "registry.json"), JSON.stringify({
      tickets: {
        first: { id: "duplicate", status: "Todo" },
        second: { id: "duplicate", status: "Done" },
      },
    }));
    writeFileSync(join(legacy, "dispatch-ledger.jsonl"), [
      JSON.stringify({ dispatchId: "run/t01/implement/1/worker", state: "completed" }),
      JSON.stringify({ dispatchId: "run/t01/implement/1/worker", state: "spawned" }),
    ].join("\n"));
    writeFileSync(join(legacy, "defects.jsonl"), "{not-json\n");
    const target = join(repo, "outside-lock-secret");
    writeFileSync(target, "must-not-be-hashed\n");
    symlinkSync(target, join(legacy, "locks", "t02.lock"));

    const store = open(repo);
    const result = new LegacyDiagnosticService(store).inventory();
    expect(result.blocked).toBe(true);
    expect(result.records.map((row) => row.disposition)).toEqual(expect.arrayContaining([
      "quarantined_registry_json",
      "quarantined_legacy_ledger",
      "quarantined_symlink_legacy_artifact",
    ]));
    expect(result.records.filter((row) => row.disposition === "quarantined_legacy_ledger")).toHaveLength(2);
    const serializedMetadata = JSON.stringify(result.records);
    expect(serializedMetadata).not.toContain("duplicate");
    expect(serializedMetadata).not.toContain("completed");
    expect(serializedMetadata).not.toContain("spawned");
    expect(serializedMetadata).not.toContain("not-json");
    const symlink = result.records.find((row) => row.bounded_path_identity === ".rickgent/locks/t02.lock");
    expect(symlink?.content_digest).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("must-not-be-hashed\n");
  });

  it("accepts only branded inventory, replays exact metadata, and conflicts if legacy content changes", () => {
    const repo = makeRepo();
    const legacy = join(repo, ".rickgent");
    mkdirSync(legacy, { recursive: true });
    const registry = join(legacy, "registry.json");
    writeFileSync(registry, JSON.stringify({ tickets: { t01: { id: "t01", status: "Todo" } } }));
    const store = open(repo);
    const service = new LegacyDiagnosticService(store);
    const first = service.inventory();
    expect(service.inventory().records).toEqual(first.records);
    expect(store.readLegacyInventory()).toEqual(first.records);

    expect(() => new LegacyInventoryCommand(Symbol("forged"), [], new Date().toISOString(), false)).toThrow(TypeError);
    const forged = Object.create(LegacyInventoryCommand.prototype) as LegacyInventoryCommand;
    expect(() => store.commitAuthorizedLegacyInventory(forged)).toThrow(TypeError);

    writeFileSync(registry, JSON.stringify({ tickets: { t01: { id: "t01", status: "Done" } } }));
    let conflict: unknown;
    try {
      service.inventory();
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(StateStoreError);
    expect(conflict).toMatchObject({ code: "RICKGENT_STATE_IDEMPOTENCY_CONFLICT" });
    expect(store.readLegacyInventory()).toEqual(first.records);
  });
});
