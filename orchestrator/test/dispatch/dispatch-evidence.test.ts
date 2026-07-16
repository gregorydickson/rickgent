// M1 dispatch evidence is capture-only. The dispatcher has no compatibility
// path that can turn a worker-created commit into completion evidence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DispatchLedger,
  Dispatcher,
  TicketLock,
  type DispatchEntry,
  type DispatchId,
} from "../../dist-fixture/dispatch/dispatch.js";
import type { MaterializedWorkerBundle } from "../../dist-fixture/dispatch/worker-materialization.js";
import {
  finalizeRunWorkspace,
  provisionRunWorkspace,
  type ReadyRunWorkspace,
} from "../../src/git/run-workspace.js";
import { sealTicketContracts } from "../../src/contracts/ticket-contract.js";

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");
const TICKET = sealTicketContracts([{
  schema_version: "1.0.0",
  id: "t01",
  title: "Fixture mutation",
  description: "Create one fixture file.",
  depends_on: [],
  scope: [{ path: "src/feature.ts", change_kind: "create", directory: false }],
  interfaces: [],
  acceptance_criteria: [{
    id: "AC-FIXTURE",
    description: "The fixture file exists.",
    interface_ids: [],
    verification_ids: ["VER-FIXTURE"],
  }],
  verifications: [{
    id: "VER-FIXTURE",
    executable: "test",
    args: ["-f", "src/feature.ts"],
    cwd_class: "repository_root",
    env_allowlist: ["PATH"],
    timeout_ms: 30_000,
    network: "deny",
    writable_outputs: [],
    expected_exit_codes: [0],
  }],
  budgets: {
    max_attempts: 1,
    max_review_cycles: 1,
    wall_clock_ms: 60_000,
    remediation_limit: 1,
  },
}])[0]!;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Fixture"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "--", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
}

function states(path: string): string[] {
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as DispatchEntry).state);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs: number = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for fixture file: ${path}`);
    await delay(10);
  }
}

function waitForFileSync(path: string, timeoutMs: number = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for fixture file: ${path}`);
    Atomics.wait(signal, 0, 0, 10);
  }
}

function processGroupIsAlive(groupLeaderPid: number): boolean {
  try {
    process.kill(-groupLeaderPid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function onlyAttemptLease(stateRoot: string): string {
  const attemptsRoot = join(stateRoot, "policy-attempts");
  const attempts = readdirSync(attemptsRoot);
  expect(attempts).toHaveLength(1);
  return join(attemptsRoot, attempts[0]!, "lease.json");
}

function leaseStatus(path: string): string {
  return (JSON.parse(readFileSync(path, "utf-8")) as { status: string }).status;
}

function fixturePolicyBundle(stateRoot: string): MaterializedWorkerBundle {
  const attemptRoot = join(stateRoot, "policy-attempts", "fixture-attempt");
  const bundleDir = join(attemptRoot, "bundle");
  const leasePath = join(attemptRoot, "lease.json");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(leasePath, JSON.stringify({ status: "active", closed_at_ms: null }));
  return {
    attemptRoot,
    bundleDir,
    leasePath,
    trustedSpawnCommand: {
      executable: process.execPath,
      argvPrefix: [join(FIXTURE_BIN, "fixture.mjs")],
    },
    spawnEnvironment: {},
  } as unknown as MaterializedWorkerBundle;
}

class DeterministicFailingLedger extends DispatchLedger {
  private attempts = 0;

  constructor(
    path: string,
    private readonly failures: ReadonlySet<number>,
    private readonly beforeFailure: (attempt: number) => void = () => {},
  ) {
    super(path);
  }

  override append(entry: DispatchEntry): void {
    this.attempts++;
    if (this.failures.has(this.attempts)) {
      this.beforeFailure(this.attempts);
      throw new Error(`injected ledger append failure ${this.attempts}`);
    }
    super.append(entry);
  }

  get appendAttempts(): number {
    return this.attempts;
  }
}

function fixturePolicyDependencies(
  bundle: MaterializedWorkerBundle,
  verify: (bundle: MaterializedWorkerBundle) => void = () => {},
) {
  return {
    materializePolicyBundle: () => bundle,
    verifyPolicyBundleForSpawn: verify,
    finalizePolicyBundle(handle: MaterializedWorkerBundle, proof: {
      childClosed: boolean;
      workspaceCleanupProven: boolean;
      disposition: "retain" | "remove" | "quarantine";
    }) {
      if (!proof.childClosed || proof.workspaceCleanupProven || proof.disposition !== "retain") {
        throw new Error("fixture received an invalid finalization proof");
      }
      const lease = JSON.parse(readFileSync(handle.leasePath, "utf-8")) as Record<string, unknown>;
      writeFileSync(handle.leasePath, JSON.stringify({ ...lease, status: "closed", closed_at_ms: Date.now() }));
      return Object.freeze({ disposition: "retained" as const, path: handle.attemptRoot, leaseClosed: true });
    },
  };
}

describe("M1 capture-only dispatch evidence", () => {
  let root: string;
  let repo: string;
  let workspace: ReadyRunWorkspace;
  let ledgerPath: string;
  let dispatcher: Dispatcher;
  let stubbornRecord: string;
  let detachedRecord: string;
  const id: DispatchId = {
    runId: "run-evidence",
    ticketId: "t01",
    phase: "implement",
    attempt: 1,
    role: "worker",
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-dispatch-evidence-")));
    repo = join(root, "repo");
    initRepo(repo);
    const provisioned = provisionRunWorkspace({ targetRepo: repo, runId: id.runId });
    if (!provisioned.ok) throw new Error(provisioned.detail);
    workspace = provisioned.workspace;
    ledgerPath = join(root, "ledger.jsonl");
    stubbornRecord = join(root, "stubborn");
    detachedRecord = join(root, "detached");
    const bundle = fixturePolicyBundle(join(root, "state"));
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );
  });

  afterEach(() => {
    const detachedPidPath = `${detachedRecord}.detached.pid`;
    if (existsSync(detachedPidPath)) {
      const detachedPid = Number(readFileSync(detachedPidPath, "utf-8"));
      try { process.kill(-detachedPid, "SIGKILL"); } catch { /* already dead */ }
    }
    const parentPidPath = `${stubbornRecord}.parent.pid`;
    if (existsSync(parentPidPath)) {
      const parentPid = Number(readFileSync(parentPidPath, "utf-8"));
      try { process.kill(-parentPid, "SIGKILL"); } catch { /* already dead */ }
    }
    finalizeRunWorkspace(workspace, false);
    rmSync(root, { recursive: true, force: true });
  });

  async function dispatch(extra: Record<string, string> = {}): Promise<DispatchEntry> {
    return dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "implement src/feature.ts",
      timeout: 20_000,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection: { harness: "codex", model: "fixture", vendor: "openai" },
      materializationRoot: join(root, "materialized"),
      dataDir: join(root, "data"),
      declaredPaths: ["src/feature.ts"],
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_MODE: "direct",
        FIXTURE_WRITE_DB: "1",
        FIXTURE_TRANSCRIPT_ITEMS: "2",
        FIXTURE_GIT_FILE: "src/feature.ts",
        FIXTURE_GIT_COMMIT: "capture",
        FIXTURE_REQUIRE_NO_SESSION: "1",
        ...extra,
      },
    });
  }

  it("emits db observation then implementation_captured, never completed", async () => {
    const callerHead = git(repo, ["rev-parse", "HEAD"]);
    const entry = await dispatch();
    expect(entry.state, entry.stderr ?? undefined).toBe("implementation_captured");
    expect(entry.captureReceipt).toMatchObject({ kind: "implementation_captured_nonterminal" });
    expect(states(ledgerPath)).toEqual(["spawned", "db_session_observed", "implementation_captured"]);
    expect(states(ledgerPath)).not.toContain("completed");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(callerHead);
  });

  it("spawns the authenticated fixture through the exact direct no-session argv", async () => {
    const spawnRecord = join(root, "spawn-record.json");
    const bundle = fixturePolicyBundle(join(root, "state"));
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );

    const entry = await dispatch({ FIXTURE_SPAWN_RECORD: spawnRecord });
    expect(entry.state, entry.stderr ?? undefined).toBe("implementation_captured");
    const record = JSON.parse(readFileSync(spawnRecord, "utf-8")) as { argv: string[] };
    expect(record.argv).toEqual([
      "run",
      bundle.bundleDir,
      "--no-session",
      "-p",
      "implement src/feature.ts",
    ]);
  });

  it("retains ownership after an abnormal nonzero child close", async () => {
    const bundle = fixturePolicyBundle(join(root, "state"));
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );

    const entry = await dispatch({ FIXTURE_EXIT_CODE: "7" });
    expect(entry).toMatchObject({
      state: "cleanup_pending",
      exitCode: 7,
      terminalReason: "ownership_unproven",
      ownershipReleased: false,
    });
    expect(entry.stderr).toContain("worker closed abnormally with exit code 7");
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(true);
    expect(new TicketLock(join(root, "locks")).acquire("t01")).toBe(false);
    expect(leaseStatus(bundle.leasePath)).toBe("active");
    expect(states(ledgerPath)).toEqual(["spawned", "cleanup_pending"]);

    const retried = await new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    ).dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "must not respawn",
      timeout: 5_000,
      maxConcurrent: 1,
      workspace,
    });
    expect(retried).toMatchObject({
      state: "failed",
      terminalReason: "infrastructure_error",
      stderr: "could not acquire ticket lock",
    });
    expect(retried).not.toEqual(entry);
    expect(states(ledgerPath)).toEqual(["spawned", "cleanup_pending", "failed"]);
  });

  it.each([
    ["no-op", { FIXTURE_GIT_FILE: "" }],
    ["staged", { FIXTURE_GIT_COMMIT: "0" }],
    ["committed", { FIXTURE_GIT_COMMIT: "1" }],
  ])("rejects %s worker output without completion", async (_label, env) => {
    const entry = await dispatch(env);
    expect(entry.state).toBe("failed");
    expect(states(ledgerPath)).not.toContain("completed");
  });

  it("rejects an unverified mutation cwd before ledger or spawn work", async () => {
    const isolatedLedger = new DispatchLedger(join(root, "isolated-ledger.jsonl"));
    const isolated = new Dispatcher(
      isolatedLedger,
      new TicketLock(join(root, "isolated-locks")),
      join(root, "isolated-state"),
    );
    await expect(isolated.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "do work",
      timeout: 1000,
      maxConcurrent: 1,
    })).rejects.toThrow("verified run workspace");
    expect(isolatedLedger.find("run-evidence/t01/implement/1/worker")).toBeNull();
  });

  it("retains ticket and workspace authority after forced process-group death", async () => {
    const timeout = 2_000;
    const terminationGraceMs = 500;
    const bundle = fixturePolicyBundle(join(root, "state"));
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );
    let settled = false;
    const pending = dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "remain alive",
      timeout,
      terminationGraceMs,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection: { harness: "codex", model: "fixture", vendor: "openai" },
      dataDir: join(root, "data"),
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        FIXTURE_REQUIRE_NO_SESSION: "1",
        FIXTURE_STUBBORN_RECORD: stubbornRecord,
      },
    }).finally(() => { settled = true; });

    const parentPidPath = `${stubbornRecord}.parent.pid`;
    const descendantPidPath = `${stubbornRecord}.descendant.pid`;
    const signalsPath = `${stubbornRecord}.signals`;
    await Promise.all([
      waitForFile(parentPidPath),
      waitForFile(descendantPidPath),
      waitForFile(signalsPath),
    ]);
    const signalObservedAt = Date.now();
    const parentPid = Number(readFileSync(parentPidPath, "utf-8"));
    const descendantPid = Number(readFileSync(descendantPidPath, "utf-8"));
    const signalLog = readFileSync(signalsPath, "utf-8");

    expect(signalLog).toContain("parent:SIGTERM");
    expect(signalLog).toContain("descendant:SIGTERM");
    expect(parentPid).toBeGreaterThan(0);
    expect(descendantPid).toBeGreaterThan(0);
    expect(settled).toBe(false);
    expect(dispatcher.activeCount).toBe(1);
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(true);
    expect(processGroupIsAlive(parentPid)).toBe(true);
    const leasePath = onlyAttemptLease(join(root, "state"));
    expect(leaseStatus(leasePath)).toBe("active");

    const entry = await pending;
    expect(entry).toMatchObject({
      state: "cleanup_pending",
      terminalReason: "ownership_unproven",
      ownershipReleased: false,
    });
    expect(Date.now() - signalObservedAt).toBeGreaterThanOrEqual(terminationGraceMs - 75);
    expect(processGroupIsAlive(parentPid)).toBe(false);
    expect(dispatcher.activeCount).toBe(0);
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(true);
    expect(new TicketLock(join(root, "locks")).acquire("t01")).toBe(false);
    expect(leaseStatus(leasePath)).toBe("active");
    expect(states(ledgerPath)).toEqual(["spawned", "cleanup_pending"]);
  });

  it("returns cleanup_pending while a detached descendant remains live and mutates after CLI death", async () => {
    const bundle = fixturePolicyBundle(join(root, "state"));
    const marker = join(workspace.worktreeDir, "src", "detached-after-cli-death.txt");
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );
    const pending = dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "remain alive",
      timeout: 1_000,
      terminationGraceMs: 200,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection: { harness: "codex", model: "fixture", vendor: "openai" },
      dataDir: join(root, "data"),
      env: {
        ...process.env,
        FIXTURE_REQUIRE_NO_SESSION: "1",
        FIXTURE_STUBBORN_RECORD: stubbornRecord,
        FIXTURE_DETACHED_RECORD: detachedRecord,
        FIXTURE_DETACHED_MARKER: marker,
      },
    });

    const parentPidPath = `${stubbornRecord}.parent.pid`;
    const detachedPidPath = `${detachedRecord}.detached.pid`;
    await Promise.all([
      waitForFile(parentPidPath),
      waitForFile(detachedPidPath),
    ]);
    const parentPid = Number(readFileSync(parentPidPath, "utf-8"));
    const detachedPid = Number(readFileSync(detachedPidPath, "utf-8"));

    const entry = await pending;
    expect(entry).toMatchObject({
      state: "cleanup_pending",
      terminalReason: "ownership_unproven",
      ownershipReleased: false,
    });
    expect(processGroupIsAlive(parentPid)).toBe(false);
    expect(processGroupIsAlive(detachedPid)).toBe(true);
    await waitForFile(marker);
    expect(readFileSync(marker, "utf-8")).toContain("survived outer");
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(true);
    expect(leaseStatus(bundle.leasePath)).toBe("active");
    expect(states(ledgerPath)).toEqual(["spawned", "cleanup_pending"]);
  });

  it("supervises spawned-evidence failure through death even when terminal append also fails", async () => {
    const terminationGraceMs = 300;
    const bundle = fixturePolicyBundle(join(root, "state"));
    const descendantPidPath = `${stubbornRecord}.descendant.pid`;
    const failingLedger = new DeterministicFailingLedger(
      ledgerPath,
      new Set([1, 2]),
      (attempt) => {
        if (attempt === 1) waitForFileSync(descendantPidPath);
      },
    );
    dispatcher = new Dispatcher(
      failingLedger,
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );
    let settled = false;
    const pending = dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "remain alive",
      timeout: 10_000,
      terminationGraceMs,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection: { harness: "codex", model: "fixture", vendor: "openai" },
      dataDir: join(root, "data"),
      env: {
        ...process.env,
        FIXTURE_REQUIRE_NO_SESSION: "1",
        FIXTURE_STUBBORN_RECORD: stubbornRecord,
      },
    }).finally(() => { settled = true; });

    const parentPidPath = `${stubbornRecord}.parent.pid`;
    const signalsPath = `${stubbornRecord}.signals`;
    await Promise.all([waitForFile(parentPidPath), waitForFile(signalsPath)]);
    const parentPid = Number(readFileSync(parentPidPath, "utf-8"));
    expect(readFileSync(signalsPath, "utf-8")).toContain("parent:SIGTERM");
    expect(settled).toBe(false);
    expect(dispatcher.activeCount).toBe(1);
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(true);
    expect(leaseStatus(bundle.leasePath)).toBe("active");
    expect(processGroupIsAlive(parentPid)).toBe(true);

    const entry = await pending;
    expect(entry).toMatchObject({
      state: "cleanup_pending",
      terminalReason: "ownership_unproven",
      ownershipReleased: false,
    });
    expect(entry.stderr).toContain("spawned ledger append failed: injected ledger append failure 1");
    expect(entry.stderr).toContain("terminal ledger append failed: injected ledger append failure 2");
    expect(failingLedger.appendAttempts).toBe(2);
    expect(processGroupIsAlive(parentPid)).toBe(false);
    expect(dispatcher.activeCount).toBe(0);
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(true);
    expect(new TicketLock(join(root, "locks")).acquire("t01")).toBe(false);
    expect(leaseStatus(bundle.leasePath)).toBe("active");
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("returns infrastructure failure instead of hanging when terminal append fails", async () => {
    const bundle = fixturePolicyBundle(join(root, "state"));
    const failingLedger = new DeterministicFailingLedger(ledgerPath, new Set([2]));
    dispatcher = new Dispatcher(
      failingLedger,
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle),
    );

    const entry = await dispatch({ FIXTURE_WRITE_DB: "0" });
    expect(entry).toMatchObject({ state: "failed", terminalReason: "infrastructure_error" });
    expect(entry.ownershipReleased).not.toBe(false);
    expect(entry.stderr).toContain("terminal ledger append failed: injected ledger append failure 2");
    expect(failingLedger.appendAttempts).toBe(2);
    expect(states(ledgerPath)).toEqual(["spawned"]);
    expect(dispatcher.activeCount).toBe(0);
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(false);
    expect(leaseStatus(bundle.leasePath)).toBe("closed");
  });

  it("closes and retains the attempt lease when final pre-spawn verification fails", async () => {
    let verificationCalls = 0;
    const bundle = fixturePolicyBundle(join(root, "state"));
    dispatcher = new Dispatcher(
      new DispatchLedger(ledgerPath),
      new TicketLock(join(root, "locks")),
      join(root, "state"),
      fixturePolicyDependencies(bundle, () => {
          verificationCalls++;
          if (verificationCalls === 2) throw new Error("injected final verification failure");
      }),
    );

    const entry = await dispatch({ FIXTURE_SPAWN_RECORD: join(root, "spawn-record.json") });
    expect(entry.state).toBe("failed");
    expect(entry.stderr).toContain("injected final verification failure");
    expect(verificationCalls).toBe(2);
    expect(states(ledgerPath)).toEqual(["failed"]);
    expect(existsSync(join(root, "spawn-record.json"))).toBe(false);
    expect(dispatcher.activeCount).toBe(0);
    expect(existsSync(join(root, "locks", "t01.lock"))).toBe(false);
    expect(leaseStatus(onlyAttemptLease(join(root, "state")))).toBe("closed");
  });
});
