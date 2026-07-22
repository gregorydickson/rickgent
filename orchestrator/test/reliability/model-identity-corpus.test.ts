// t31: Observed harness/model identity corpus.
//
// Exercises the full identity receipt lifecycle through the deterministic
// fixture omnigent:
//   - Selection differing from bundle defaults changes the actual invocation
//   - Requested, invoked, and observed receipts are independently produced
//   - Missing/mismatched/stale/spoofed/bundle-default identity fails closed
//   - Observed identity comes only from the external chat.db seam (t00)
//
// This test drives the real production dispatch path (canonical Dispatcher
// with fixture policy bundle injection) and exercises the model-identity
// capture/verification module.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  Dispatcher,
  InMemoryDispatchJournal,
  type DispatchEntry,
  type DispatchId,
} from "../../dist-fixture/dispatch/dispatch.js";
import type { MaterializedWorkerBundle } from "../../dist-fixture/dispatch/worker-materialization.js";
import {
  captureRequestedIdentity,
  captureInvokedIdentity,
  captureObservedIdentity,
  verifyIdentityReceipts,
  persistIdentityReceiptsJsonl,
  identityReceiptSetDigest,
  IdentityVerificationError,
  type IdentityReceipt,
} from "../../dist-fixture/dispatch/model-identity.js";
import {
  captureConversationIds,
  isolatedDataDir,
} from "../../dist-fixture/dispatch/evidence.js";
import { realpathSync } from "fs";
import {
  finalizeRunWorkspace,
  provisionRunWorkspace,
  type ReadyRunWorkspace,
} from "../../src/git/run-workspace.js";
import { sealTicketContracts } from "../../src/contracts/ticket-contract.js";
import type { AllocatedAttempt } from "../../src/state/store.js";
import type { RouterSelection } from "../../src/lifecycle/routing.js";
import type { ExecutionContext } from "../../src/context/execution-context.js";
import { canonicalHarnessIdentity } from "../../src/context/execution-context.js";

const FIXTURE_BIN = join(import.meta.dirname, "../fixtures/omnigent-fixture");
const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");

const TICKET = sealTicketContracts([{
  schema_version: "1.0.0",
  id: "t31",
  title: "Identity corpus",
  description: "Create one fixture file for identity corpus.",
  depends_on: [],
  scope: [{ path: "src/feature.ts", change_kind: "create", directory: false }],
  interfaces: [],
  acceptance_criteria: [{
    id: "AC-IDENTITY",
    description: "The fixture file exists.",
    interface_ids: [],
    verification_ids: ["VER-IDENTITY"],
  }],
  verifications: [{
    id: "VER-IDENTITY",
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

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rickgent-identity-${prefix}-`));
}

function makeId(ticketId = "t31"): DispatchId {
  return {
    runId: "run-identity",
    ticketId,
    phase: "implement",
    attempt: 1,
    role: "worker",
  };
}

function allocatedAttempt(overrides: Partial<AllocatedAttempt> = {}): AllocatedAttempt {
  return {
    runnable: false,
    attemptId: "attempt-identity-1",
    ticketInstanceId: "ticket-instance-identity-1",
    runId: "run-identity",
    ticketId: "t31",
    attemptNumber: 1,
    contractDigest: TICKET.digest,
    allocationOwnerDigest: "sha256:owner",
    deliveryBaselineOid: "a".repeat(40),
    contextSchemaVersion: "1",
    oracleVersion: "1",
    capabilitySnapshotDigest: "sha256:capability",
    resourceIdentityVersion: "1",
    state: "planned",
    stateVersion: 0,
    ...overrides,
  };
}

function makeSelection(overrides: Partial<RouterSelection> = {}): RouterSelection {
  return {
    harness: "codex",
    model: "gpt-5",
    vendor: "openai",
    ...overrides,
  };
}

function fixturePolicyBundle(stateRoot: string): MaterializedWorkerBundle {
  const attemptRoot = join(stateRoot, "policy-attempts", "fixture-attempt");
  const bundleDir = join(attemptRoot, "bundle");
  const leasePath = join(attemptRoot, "lease.json");
  const contextPath = join(attemptRoot, "context.json");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(leasePath, JSON.stringify({ status: "active", closed_at_ms: null }));
  writeFileSync(contextPath, "{}");
  // Write a minimal config.yaml so the fixture's recordSpawn can read it
  writeFileSync(join(bundleDir, "config.yaml"), "name: worker\n");
  return {
    attemptRoot,
    bundleDir,
    leasePath,
    contextPath,
    contextSha256: "f".repeat(64),
    configSha256: "e".repeat(64),
    requestedConfigSha256: "c".repeat(64),
    requestedBundleSha256: "b".repeat(64),
    invokedConfigSha256: "e".repeat(64),
    invokedBundleSha256: "d".repeat(64),
    trustedSpawnCommand: {
      executable: process.execPath,
      argvPrefix: [join(FIXTURE_BIN, "fixture.mjs")],
    },
    spawnEnvironment: {},
    // Stub the context fields that captureRequestedIdentity reads
    context: {
      dispatch_id: "run-identity/t31/implement/1/worker",
      run_id: "run-identity",
      ticket_id: "t31",
      attempt: 1,
      lifecycle_phase: "implement",
      role: "worker",
      attempt_digest: "a".repeat(64),
      requested_identity: {
        canonical_harness: "codex",
        canonical_model_id: "gpt-5",
        canonical_vendor: "openai",
        bundle_digest: "b".repeat(64),
        config_digest: "c".repeat(64),
      },
    } as unknown as ExecutionContext,
  } as unknown as MaterializedWorkerBundle;
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

function makeExecutionContext(
  selection: RouterSelection,
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  const canonicalHarness = canonicalHarnessIdentity(selection.harness);
  return {
    schema_version: "rickgent-attempt-context/v1",
    policy_abi_version: "omnigent-function-policy/current-v1",
    ticket_contract_schema_version: "1.0.0",
    identity_normalization_version: "rickgent-identity-normalization/v1",
    dispatch_id: "run-identity/t31/implement/1/worker",
    run_id: "run-identity",
    ticket_id: "t31",
    attempt: 1,
    lifecycle_phase: "implement",
    role: "worker",
    target_repo_realpath: "/tmp/repo",
    worktree_realpath: "/tmp/worktree",
    state_root_realpath: "/tmp/state",
    policy_root_realpath: "/tmp/policy",
    bundle_root_realpath: "/tmp/bundle",
    ticket_contract_digest: TICKET.digest,
    declared_scope: [],
    requested_identity: {
      normalization_version: "rickgent-identity-normalization/v1",
      raw_harness: selection.harness,
      canonical_harness: canonicalHarness,
      raw_provider: selection.vendor,
      canonical_provider: selection.vendor,
      raw_vendor: selection.vendor,
      canonical_vendor: selection.vendor,
      raw_model_id: selection.model,
      canonical_model_id: selection.model,
      bundle_digest: "b".repeat(64),
      config_digest: "c".repeat(64),
      profile: "effective-session-v1",
      profile_available: true,
      conflict: false,
    },
    runtime_provenance: {
      schema_version: "rickgent-runtime-provenance/v2",
      omnigent_python_entrypoint: "/tmp/python",
      omnigent_python_realpath: "/tmp/python",
      omnigent_python_sha256: "0".repeat(64),
      omnigent_root_realpath: "/tmp/omnigent",
      omnigent_origin_realpath: "/tmp/omnigent/omnigent/__init__.py",
      rickgent_policies_origin_realpath: "/tmp/policies/__init__.py",
      rickgent_policies_sha256: "1".repeat(64),
      rickgent_node_realpath: "/tmp/node",
      rickgent_node_sha256: "2".repeat(64),
      rickgent_cli_realpath: "/tmp/cli.js",
      rickgent_cli_sha256: "3".repeat(64),
      rickgent_build_commit: "abcdef0",
    },
    requested_bundle_sha256: "b".repeat(64),
    requested_config_sha256: "c".repeat(64),
    attempt_digest: "a".repeat(64),
    owner_token_sha256: "4".repeat(64),
    nonce: "test-nonce",
    nonce_claim_path: "/tmp/nonce.json",
    lease_path: "/tmp/lease.json",
    receipt_path: "/tmp/receipt.jsonl",
    ...overrides,
  } as unknown as ExecutionContext;
}

describe("t31: observed harness/model identity corpus", () => {
  let root: string;
  let repo: string;
  let workspace: ReadyRunWorkspace;
  let stateRoot: string;
  let dataDir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-identity-root-")));
    repo = join(root, "repo");
    initRepo(repo);
    stateRoot = join(root, "state");
    dataDir = join(root, "omnigent-data");
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const provisioned = provisionRunWorkspace({ targetRepo: repo, runId: "run-identity" });
    if (!provisioned.ok) throw new Error(`workspace provision failed: ${provisioned.detail}`);
    workspace = provisioned.workspace;
  });

  afterEach(() => {
    try { finalizeRunWorkspace(workspace, false); } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  });

  it("selection changes the actual Omnigent --harness/--model invocation", async () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const bundle = fixturePolicyBundle(stateRoot);
    const journal = new InMemoryDispatchJournal();
    const dispatcher = new Dispatcher(journal, stateRoot, fixturePolicyDependencies(bundle));
    const id = makeId();
    const idStr = `${id.runId}/${id.ticketId}/${id.phase}/${id.attempt}/${id.role}`;
    const sessionDataDir = isolatedDataDir(dataDir, idStr);
    mkdirSync(sessionDataDir, { recursive: true });

    const entry = await dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "implement src/feature.ts",
      timeout: 10_000,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection,
      attempt: allocatedAttempt(),
      dataDir,
      env: {
        FIXTURE_MODE: "direct",
        FIXTURE_WRITE_DB: "1",
        FIXTURE_GIT_FILE: "src/feature.ts",
        FIXTURE_GIT_COMMIT: "capture",
        FIXTURE_SPAWN_RECORD: join(root, "spawn-record.json"),
        OMNIGENT_ROOT: process.env.OMNIGENT_ROOT,
        OMNIGENT_PYTHON: process.env.OMNIGENT_PYTHON,
      },
    });

    expect(entry.state).toBe("implementation_captured");
    // The spawn record proves the actual argv includes --harness and --model.
    const spawnRecord = JSON.parse(readFileSync(join(root, "spawn-record.json"), "utf-8"));
    const argv = spawnRecord.argv as string[];
    const harnessIdx = argv.indexOf("--harness");
    const modelIdx = argv.indexOf("--model");
    expect(harnessIdx).toBeGreaterThanOrEqual(0);
    expect(argv[harnessIdx + 1]).toBe("codex");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(argv[modelIdx + 1]).toBe("gpt-5");
  });

  it("requested, invoked, and observed receipts are independently produced and consistent", async () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const id = makeId();
    const idStr = `${id.runId}/${id.ticketId}/${id.phase}/${id.attempt}/${id.role}`;
    const sessionDataDir = isolatedDataDir(dataDir, idStr);
    mkdirSync(sessionDataDir, { recursive: true });

    // Simulate the fixture creating a root conversation with identity fields
    // by dispatching through the production path.
    const bundle = fixturePolicyBundle(stateRoot);
    const journal = new InMemoryDispatchJournal();
    const dispatcher = new Dispatcher(journal, stateRoot, fixturePolicyDependencies(bundle));

    await dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "implement src/feature.ts",
      timeout: 10_000,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection,
      attempt: allocatedAttempt(),
      dataDir,
      env: {
        FIXTURE_MODE: "direct",
        FIXTURE_WRITE_DB: "1",
        FIXTURE_GIT_FILE: "src/feature.ts",
        FIXTURE_GIT_COMMIT: "capture",
        OMNIGENT_ROOT: process.env.OMNIGENT_ROOT,
        OMNIGENT_PYTHON: process.env.OMNIGENT_PYTHON,
      },
    });

    // Capture the baseline before dispatch would have been empty; now capture observed.
    const baselineConvIds = new Set<string>();
    const requested = captureRequestedIdentity(context);
    const invoked = captureInvokedIdentity(
      context.dispatch_id,
      context.role,
      process.execPath,
      ["run", "/tmp/bundle", "--no-session", "--harness", "codex", "--model", "gpt-5", "-p", "prompt"],
      "d".repeat(64),
      "e".repeat(64),
      context.attempt_digest,
      "codex",
      "gpt-5",
      "openai",
    );
    const observed = captureObservedIdentity(sessionDataDir, baselineConvIds, context.dispatch_id, context.role);

    // All three receipts must be present with correct provenance.
    expect(requested.producer).toBe("requested");
    expect(requested.canonical_harness).toBe("codex");
    expect(requested.canonical_model).toBe("gpt-5");
    expect(requested.provenance).toBe("immutable-attempt-context");

    expect(invoked.producer).toBe("invoked");
    expect(invoked.canonical_harness).toBe("codex");
    expect(invoked.canonical_model).toBe("gpt-5");
    expect(invoked.provenance).toBe("actual-array-argv-plus-materialized-bundle-digest");
    expect(invoked.invoked_argv).toContain("--harness");
    expect(invoked.invoked_argv).toContain("--model");

    expect(observed.producer).toBe("observed");
    expect(observed.canonical_harness).toBe("codex");
    expect(observed.canonical_model).toBe("gpt-5");
    expect(observed.conversation_id).not.toBeNull();
    expect(observed.provenance).toBe("isolated-omnigent-chat-db-root-conversation");

    // Verification passes — all three are consistent.
    expect(() => verifyIdentityReceipts(requested, invoked, observed)).not.toThrow();
  });

  it("missing observed identity receipt fails closed", () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const emptyDir = tmpDir("empty-observed");
    try {
      const requested = captureRequestedIdentity(context);
      const invoked = captureInvokedIdentity(
        context.dispatch_id, context.role,
        process.execPath,
        ["run", "/tmp/bundle", "--no-session", "--harness", "codex", "--model", "gpt-5", "-p", "prompt"],
        "d".repeat(64), "e".repeat(64), context.attempt_digest,
        "codex", "gpt-5", "openai",
      );
      // No chat.db → observed identity is null.
      const observed = captureObservedIdentity(emptyDir, new Set<string>(), context.dispatch_id, context.role);

      expect(observed.canonical_harness).toBeNull();
      expect(observed.canonical_model).toBeNull();
      expect(() => verifyIdentityReceipts(requested, invoked, observed)).toThrow(IdentityVerificationError);
      try {
        verifyIdentityReceipts(requested, invoked, observed);
      } catch (e) {
        expect((e as IdentityVerificationError).code).toBe("IDENTITY_MISSING");
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("harness mismatch between requested and observed fails closed", async () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const id = makeId();
    const idStr = `${id.runId}/${id.ticketId}/${id.phase}/${id.attempt}/${id.role}`;
    const sessionDataDir = isolatedDataDir(dataDir, idStr);
    mkdirSync(sessionDataDir, { recursive: true });

    // Dispatch with a different selection to get a different observed harness.
    const differentSelection = makeSelection({ harness: "claude-sdk", model: "gpt-5", vendor: "anthropic" });
    const bundle = fixturePolicyBundle(stateRoot);
    const journal = new InMemoryDispatchJournal();
    const dispatcher = new Dispatcher(journal, stateRoot, fixturePolicyDependencies(bundle));

    await dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "implement src/feature.ts",
      timeout: 10_000,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection: differentSelection,
      attempt: allocatedAttempt(),
      dataDir,
      env: {
        FIXTURE_MODE: "direct",
        FIXTURE_WRITE_DB: "1",
        FIXTURE_GIT_FILE: "src/feature.ts",
        FIXTURE_GIT_COMMIT: "capture",
        OMNIGENT_ROOT: process.env.OMNIGENT_ROOT,
        OMNIGENT_PYTHON: process.env.OMNIGENT_PYTHON,
      },
    });

    // Now verify with the original (codex) requested identity against the
    // claude-sdk observed identity.
    const requested = captureRequestedIdentity(context);
    const invoked = captureInvokedIdentity(
      context.dispatch_id, context.role,
      process.execPath,
      ["run", "/tmp/bundle", "--no-session", "--harness", "codex", "--model", "gpt-5", "-p", "prompt"],
      "d".repeat(64), "e".repeat(64), context.attempt_digest,
      "codex", "gpt-5", "openai",
    );
    const observed = captureObservedIdentity(sessionDataDir, new Set<string>(), context.dispatch_id, context.role);

    expect(observed.canonical_harness).toBe("claude-sdk");
    expect(() => verifyIdentityReceipts(requested, invoked, observed)).toThrow(IdentityVerificationError);
    try {
      verifyIdentityReceipts(requested, invoked, observed);
    } catch (e) {
      expect((e as IdentityVerificationError).code).toBe("IDENTITY_MISMATCH");
      expect((e as IdentityVerificationError).field).toBe("harness");
    }
  });

  it("model mismatch between requested and observed fails closed", async () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const id = makeId();
    const idStr = `${id.runId}/${id.ticketId}/${id.phase}/${id.attempt}/${id.role}`;
    const sessionDataDir = isolatedDataDir(dataDir, idStr);
    mkdirSync(sessionDataDir, { recursive: true });

    // Dispatch with a different model.
    const differentSelection = makeSelection({ harness: "codex", model: "o3-mini", vendor: "openai" });
    const bundle = fixturePolicyBundle(stateRoot);
    const journal = new InMemoryDispatchJournal();
    const dispatcher = new Dispatcher(journal, stateRoot, fixturePolicyDependencies(bundle));

    await dispatcher.dispatch(id, {
      agentDir: AGENT_ROOT,
      prompt: "implement src/feature.ts",
      timeout: 10_000,
      maxConcurrent: 1,
      workspace,
      ticket: TICKET,
      selection: differentSelection,
      attempt: allocatedAttempt(),
      dataDir,
      env: {
        FIXTURE_MODE: "direct",
        FIXTURE_WRITE_DB: "1",
        FIXTURE_GIT_FILE: "src/feature.ts",
        FIXTURE_GIT_COMMIT: "capture",
        OMNIGENT_ROOT: process.env.OMNIGENT_ROOT,
        OMNIGENT_PYTHON: process.env.OMNIGENT_PYTHON,
      },
    });

    const requested = captureRequestedIdentity(context);
    const invoked = captureInvokedIdentity(
      context.dispatch_id, context.role,
      process.execPath,
      ["run", "/tmp/bundle", "--no-session", "--harness", "codex", "--model", "gpt-5", "-p", "prompt"],
      "d".repeat(64), "e".repeat(64), context.attempt_digest,
      "codex", "gpt-5", "openai",
    );
    const observed = captureObservedIdentity(sessionDataDir, new Set<string>(), context.dispatch_id, context.role);

    expect(observed.canonical_model).toBe("o3-mini");
    expect(() => verifyIdentityReceipts(requested, invoked, observed)).toThrow(IdentityVerificationError);
    try {
      verifyIdentityReceipts(requested, invoked, observed);
    } catch (e) {
      expect((e as IdentityVerificationError).code).toBe("IDENTITY_MISMATCH");
      expect((e as IdentityVerificationError).field).toBe("model");
    }
  });

  it("spoofed transcript text in stdout is not treated as identity observation", () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    // Create a chat.db with no identity columns (old schema) — observed identity
    // should be null, not derived from stdout text.
    const noIdentityDir = tmpDir("no-identity");
    try {
      const chatDbPath = join(noIdentityDir, "chat.db");
      // Create a conversations table WITHOUT identity columns
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(chatDbPath);
      db.exec(`
        CREATE TABLE conversations (
          workspace_id INTEGER NOT NULL DEFAULT 0,
          id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          root_conversation_id TEXT,
          PRIMARY KEY (workspace_id, id)
        );
      `);
      db.prepare("INSERT INTO conversations VALUES (0, 'spoofed-conv', 12345, 'spoofed-conv')").run();
      db.close();

      const observed = captureObservedIdentity(noIdentityDir, new Set<string>(), context.dispatch_id, context.role);
      // Without identity columns, observed identity is null (fail closed).
      expect(observed.canonical_harness).toBeNull();
      expect(observed.canonical_model).toBeNull();
    } finally {
      rmSync(noIdentityDir, { recursive: true, force: true });
    }
  });

  it("stale session (pre-existing conversation) is not treated as observed identity", () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const staleDir = tmpDir("stale");
    try {
      // Pre-seed a conversation BEFORE the dispatch baseline.
      const { insertConversation } = require(join(FIXTURE_BIN, "chat-db.mjs"));
      insertConversation(staleDir, "stale-conv", 1, Date.now() - 10000, {
        harnessOverride: "codex",
        modelOverride: "gpt-5",
        sessionUsage: JSON.stringify({ by_model: { "gpt-5": { input_tokens: 10 } } }),
      });

      // The baseline includes the stale conversation.
      const baselineConvIds = captureConversationIds(staleDir);
      expect(baselineConvIds.has("stale-conv")).toBe(true);

      // No NEW conversation was created → observed identity is null.
      const observed = captureObservedIdentity(staleDir, baselineConvIds, context.dispatch_id, context.role);
      expect(observed.canonical_harness).toBeNull();
      expect(observed.canonical_model).toBeNull();
      expect(observed.conversation_id).toBeNull();
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }
  });

  it("bundle-default fallback (no --harness/--model in argv) blocks verification", () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const identityDir = tmpDir("identity-argv");
    try {
      // Create a valid observed identity.
      const { insertConversation } = require(join(FIXTURE_BIN, "chat-db.mjs"));
      insertConversation(identityDir, "conv-1", 1, Date.now(), {
        harnessOverride: "codex",
        modelOverride: "gpt-5",
        sessionUsage: JSON.stringify({ by_model: { "gpt-5": { input_tokens: 10 } } }),
      });

      const requested = captureRequestedIdentity(context);
      // Invoked argv does NOT contain --harness or --model (bundle-default fallback).
      const invoked = captureInvokedIdentity(
        context.dispatch_id, context.role,
        process.execPath,
        ["run", "/tmp/bundle", "--no-session", "-p", "prompt"],
        "d".repeat(64), "e".repeat(64), context.attempt_digest,
        "codex", "gpt-5", "openai",
      );
      const observed = captureObservedIdentity(identityDir, new Set<string>(), context.dispatch_id, context.role);

      expect(() => verifyIdentityReceipts(requested, invoked, observed)).toThrow(IdentityVerificationError);
      try {
        verifyIdentityReceipts(requested, invoked, observed);
      } catch (e) {
        expect((e as IdentityVerificationError).code).toBe("IDENTITY_BUNDLE_DEFAULT_FALLBACK");
      }
    } finally {
      rmSync(identityDir, { recursive: true, force: true });
    }
  });

  it("alias canonicalization is consistent across receipts", () => {
    const selection = makeSelection({ harness: "claude", model: "claude-sonnet-4-5", vendor: "anthropic" });
    const context = makeExecutionContext(selection);
    const identityDir = tmpDir("alias");
    try {
      const { insertConversation } = require(join(FIXTURE_BIN, "chat-db.mjs"));
      // The fixture records the raw alias "claude" as harness_override.
      insertConversation(identityDir, "conv-alias", 1, Date.now(), {
        harnessOverride: "claude",
        modelOverride: "claude-sonnet-4-5",
        sessionUsage: JSON.stringify({ by_model: { "claude-sonnet-4-5": { input_tokens: 10 } } }),
      });

      const requested = captureRequestedIdentity(context);
      // The requested identity canonicalizes "claude" → "claude-sdk".
      expect(requested.canonical_harness).toBe("claude-sdk");

      const invoked = captureInvokedIdentity(
        context.dispatch_id, context.role,
        process.execPath,
        ["run", "/tmp/bundle", "--no-session", "--harness", "claude", "--model", "claude-sonnet-4-5", "-p", "prompt"],
        "d".repeat(64), "e".repeat(64), context.attempt_digest,
        "claude-sdk", "claude-sonnet-4-5", "anthropic",
      );
      // The invoked receipt canonicalizes the argv "claude" → "claude-sdk".
      expect(invoked.canonical_harness).toBe("claude-sdk");

      const observed = captureObservedIdentity(identityDir, new Set<string>(), context.dispatch_id, context.role);
      // The observed receipt canonicalizes the chat.db "claude" → "claude-sdk".
      expect(observed.canonical_harness).toBe("claude-sdk");
      expect(observed.canonical_model).toBe("claude-sonnet-4-5");

      // All three canonicalize consistently — verification passes.
      expect(() => verifyIdentityReceipts(requested, invoked, observed)).not.toThrow();
    } finally {
      rmSync(identityDir, { recursive: true, force: true });
    }
  });

  it("identity receipt set digest is stable across replays", () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const identityDir = tmpDir("digest");
    try {
      const { insertConversation } = require(join(FIXTURE_BIN, "chat-db.mjs"));
      insertConversation(identityDir, "conv-digest", 1, Date.now(), {
        harnessOverride: "codex",
        modelOverride: "gpt-5",
        sessionUsage: JSON.stringify({ by_model: { "gpt-5": { input_tokens: 10 } } }),
      });

      const requested = captureRequestedIdentity(context);
      const invoked = captureInvokedIdentity(
        context.dispatch_id, context.role,
        process.execPath,
        ["run", "/tmp/bundle", "--no-session", "--harness", "codex", "--model", "gpt-5", "-p", "prompt"],
        "d".repeat(64), "e".repeat(64), context.attempt_digest,
        "codex", "gpt-5", "openai",
      );
      const observed = captureObservedIdentity(identityDir, new Set<string>(), context.dispatch_id, context.role);

      // Build receipt set twice — the digest should be the same (ignoring captured_at).
      // We override captured_at to ensure determinism.
      const r1 = {
        requested: { ...requested, captured_at: "T1" },
        invoked: { ...invoked, captured_at: "T1" },
        observed: { ...observed, captured_at: "T1" },
      };
      const r2 = {
        requested: { ...requested, captured_at: "T1" },
        invoked: { ...invoked, captured_at: "T1" },
        observed: { ...observed, captured_at: "T1" },
      };
      const digest1 = identityReceiptSetDigest(r1);
      const digest2 = identityReceiptSetDigest(r2);
      expect(digest1).toBe(digest2);
      expect(digest1).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(identityDir, { recursive: true, force: true });
    }
  });

  it("persistIdentityReceipts produces three independent JSONL lines", () => {
    const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
    const context = makeExecutionContext(selection);
    const identityDir = tmpDir("persist");
    try {
      const { insertConversation } = require(join(FIXTURE_BIN, "chat-db.mjs"));
      insertConversation(identityDir, "conv-persist", 1, Date.now(), {
        harnessOverride: "codex",
        modelOverride: "gpt-5",
        sessionUsage: JSON.stringify({ by_model: { "gpt-5": { input_tokens: 10 } } }),
      });

      const requested = captureRequestedIdentity(context);
      const invoked = captureInvokedIdentity(
        context.dispatch_id, context.role,
        process.execPath,
        ["run", "/tmp/bundle", "--no-session", "--harness", "codex", "--model", "gpt-5", "-p", "prompt"],
        "d".repeat(64), "e".repeat(64), context.attempt_digest,
        "codex", "gpt-5", "openai",
      );
      const observed = captureObservedIdentity(identityDir, new Set<string>(), context.dispatch_id, context.role);

      const output = persistIdentityReceiptsJsonl("/tmp/receipt.jsonl", { requested, invoked, observed });
      const lines = output.trim().split("\n");
      expect(lines).toHaveLength(3);

      const r1 = JSON.parse(lines[0]!) as IdentityReceipt;
      const r2 = JSON.parse(lines[1]!) as IdentityReceipt;
      const r3 = JSON.parse(lines[2]!) as IdentityReceipt;
      expect(r1.producer).toBe("requested");
      expect(r2.producer).toBe("invoked");
      expect(r3.producer).toBe("observed");
      // Each receipt has independent provenance.
      expect(r1.provenance).not.toBe(r2.provenance);
      expect(r2.provenance).not.toBe(r3.provenance);
      expect(r1.provenance).not.toBe(r3.provenance);
    } finally {
      rmSync(identityDir, { recursive: true, force: true });
    }
  });
});
