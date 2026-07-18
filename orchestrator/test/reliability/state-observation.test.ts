import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sealTicketContracts, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { IdentityContextResolver } from "../../src/context/resolver.js";
import { RICKGENT_ORACLE_VERSION } from "../../src/state/oracle.js";
import {
  StateStoreError,
  observeState,
  openStateStore,
  resolveStateLocation,
} from "../../src/state/store.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-state-observation-")));
  roots.add(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "State Observation Test"]);
  git(root, ["config", "user.email", "state-observation@example.test"]);
  writeFileSync(join(root, "README.md"), "baseline\n", "utf8");
  git(root, ["add", "--", "README.md"]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

function ticketDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t16",
    title: "Observe durable state",
    description: "Prove read-only status projection from canonical SQLite state.",
    depends_on: [],
    scope: [{ path: "src/observe.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-OBSERVE",
      description: "Latest allocated state is observed without mutation.",
      interface_ids: [],
      verification_ids: ["VER-OBSERVE"],
    }],
    verifications: [{
      id: "VER-OBSERVE",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 2,
      wall_clock_ms: 120_000,
      remediation_limit: 1,
    },
  };
}

describe("read-only canonical state observation", () => {
  it("reports absent state without creating the canonical state directory", () => {
    const repo = makeRepo();
    const location = resolveStateLocation(repo);
    expect(existsSync(location.stateDirectory)).toBe(false);

    expect(observeState(repo)).toEqual({
      state: "absent",
      repositoryId: location.repositoryId,
      databasePath: location.databasePath,
    });
    expect(existsSync(location.stateDirectory)).toBe(false);
  });

  it("projects the latest run, ticket, attempt, and delivery aggregates from SQLite", () => {
    const repo = makeRepo();
    const contract = sealTicketContracts([ticketDraft()], { repositoryRoot: repo })[0]!;
    const store = openStateStore({ repoPath: repo });
    const resolver = new IdentityContextResolver(store);
    const run = resolver.allocateFreshRun({
      contracts: [contract],
      initialDeliveryOid: git(repo, ["rev-parse", "HEAD"]),
      oracleVersion: RICKGENT_ORACLE_VERSION,
    });
    const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
    store.close();

    const observation = observeState(repo);
    expect(observation).toMatchObject({
      state: "present",
      schemaVersion: 4,
      latestRun: {
        runId: run.runId,
        runSequence: run.runSequence,
        state: "planned",
        stateVersion: 0,
        currentDeliveryOid: run.currentDeliveryOid,
        promotionSequence: 0,
        tickets: [{
          ticketInstanceId: attempt.ticketInstanceId,
          ticketId: contract.id,
          planIndex: 0,
          state: "planned",
          stateVersion: 0,
          latestAttempt: {
            attemptId: attempt.attemptId,
            attemptNumber: 1,
            state: "planned",
            stateVersion: 0,
            commitOid: null,
            oracleResult: null,
          },
        }],
      },
      aggregates: { runs: 1, deliveryRecords: 0, delivered: 0, deliveryFailed: 0 },
    });
  });

  it("fails closed on an unsafe existing database instead of reporting absence", () => {
    const repo = makeRepo();
    const store = openStateStore({ repoPath: repo });
    const databasePath = store.location.databasePath;
    store.close();
    chmodSync(databasePath, 0o644);

    expect(() => observeState(repo)).toThrowError(StateStoreError);
    try {
      observeState(repo);
    } catch (error) {
      expect(error).toMatchObject({ code: "RICKGENT_STATE_ROOT_UNSAFE", failureClass: "infrastructure" });
    }
  });
});
