import { createHash } from "crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative } from "path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
} from "../../src/contracts/ticket-contract.js";
import type { ReadyRunWorkspace } from "../../src/git/run-workspace.js";
import {
  POLICY_CONFIG_KEYS,
  TRUSTED_SPAWN_ENVIRONMENT_KEYS,
  closePolicyBundleLease,
  finalizePolicyBundle,
  materializePolicyBundle,
  policyBundleSha256,
  verifyPolicyBundleForSpawn,
  type PolicyBundleHandle,
} from "../../src/policy/policy-bundle.js";

// Resolve OMNIGENT_PYTHON to the path that sys.executable reports. The
// provenance probe compares pythonExecutable.entrypoint with sys.executable;
// pyenv shims and other indirections cause sys.executable to differ from the
// shim path. Using the resolved path ensures the probe comparison passes.
const RESOLVED_OMNIGENT_PYTHON = process.env.OMNIGENT_PYTHON
  ? execFileSync(process.env.OMNIGENT_PYTHON, ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" }).trim()
  : process.env.OMNIGENT_PYTHON;

const AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");
const RICKGENT_CLI = realpathSync(join(import.meta.dirname, "../../dist/cli.js"));

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !Object.isFrozen(value)) return value === null || typeof value !== "object";
  return Object.values(value as Record<string, unknown>).every(deepFrozen);
}

function pathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ticket(): TicketContract {
  return sealTicketContracts([{
    schema_version: "1.0.0",
    id: "t09",
    title: "Authenticated policy context",
    description: "Materialize one immutable per-attempt authority.",
    depends_on: [],
    scope: [
      { path: "src/new.ts", change_kind: "rename", directory: false, from_path: "src/old.ts" },
      { path: "test", change_kind: "modify", directory: true },
    ],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-CONTEXT",
      description: "Context and policy config authenticate the attempt.",
      interface_ids: [],
      verification_ids: ["VER-CONTEXT"],
    }],
    verifications: [{
      id: "VER-CONTEXT",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: ["OMNIGENT_ROOT"],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 1,
      wall_clock_ms: 60_000,
      remediation_limit: 1,
    },
  }])[0]!;
}

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly worktree: string;
  readonly state: string;
  readonly workspace: ReadyRunWorkspace;
  readonly contract: TicketContract;
}

function fixture(root: string): Fixture {
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const state = join(root, "state");
  for (const path of [repo, worktree, state]) privateDirectory(path);
  const workspace: ReadyRunWorkspace = Object.freeze({
    kind: "ready_run_workspace",
    callerRepo: repo,
    commonGitDir: join(root, "git-common"),
    callerGitDir: join(root, "git-caller"),
    deliveryRef: "refs/heads/feature/context",
    baselineSha: "a".repeat(40),
    runRef: "refs/heads/rickgent/runs/run-001",
    worktreeDir: worktree,
    worktreeGitDir: join(root, "git-worktree"),
    allocationRoot: root,
    callerBefore: Object.freeze({
      headSha: "a".repeat(40),
      symbolicRef: "refs/heads/feature/context",
      indexSha256: "b".repeat(64),
      statusSha256: "c".repeat(64),
    }),
  });
  return { root, repo, worktree, state, workspace, contract: ticket() };
}

function materialize(input: Fixture, overrides: Partial<Parameters<typeof materializePolicyBundle>[0]> = {}): PolicyBundleHandle {
  return materializePolicyBundle({
    agentRoot: AGENT_ROOT,
    stateRoot: input.state,
    dispatch: { runId: "run-001", ticketId: "t09", phase: "implement", attempt: 1, role: "worker" },
    ticket: input.contract,
    workspace: input.workspace,
    selection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    leaseExpiresAtMs: Date.now() + 60_000,
    omnigentRoot: process.env.OMNIGENT_ROOT,
    omnigentPython: RESOLVED_OMNIGENT_PYTHON,
    rickgentCli: RICKGENT_CLI,
    ...overrides,
  });
}

function walk(path: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    result.push(child);
    if (entry.isDirectory()) result.push(...walk(child));
  }
  return result;
}

describe("M2 authenticated policy context", () => {
  let root: string;
  let input: Fixture;

  beforeEach(() => {
    expect(process.env.OMNIGENT_ROOT).toBeTruthy();
    expect(RESOLVED_OMNIGENT_PYTHON).toBeTruthy();
    root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-policy-context-")));
    input = fixture(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("materializes the exact immutable authority and t00 seven-string config", () => {
    const handle = materialize(input);
    const raw = readFileSync(handle.contextPath);
    const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;

    expect(raw.toString("utf8")).toBe(canonicalJson(handle.context));
    expect(sha256(raw)).toBe(handle.contextSha256);
    expect(parsed).toEqual(handle.context);
    expect(handle.context).toMatchObject({
      schema_version: "rickgent-attempt-context/v1",
      policy_abi_version: "omnigent-function-policy/current-v1",
      ticket_contract_schema_version: "1.0.0",
      identity_normalization_version: "rickgent-identity-normalization/v1",
      dispatch_id: "run-001/t09/implement/1/worker",
      run_id: "run-001",
      ticket_id: "t09",
      attempt: 1,
      lifecycle_phase: "implement",
      role: "worker",
      ticket_contract_digest: input.contract.digest,
      requested_identity: {
        raw_harness: "codex",
        canonical_harness: "codex",
        raw_vendor: "openai",
        canonical_vendor: "openai",
        raw_model_id: "gpt-5",
        canonical_model_id: "gpt-5",
      },
    });
    expect(handle.context.declared_scope).toEqual(input.contract.scope);
    expect(handle.runtimeProvenance).toMatchObject({
      schema_version: "rickgent-runtime-provenance/v2",
      omnigent_python_entrypoint: RESOLVED_OMNIGENT_PYTHON,
      omnigent_python_realpath: realpathSync(RESOLVED_OMNIGENT_PYTHON!),
      rickgent_node_realpath: realpathSync(process.execPath),
    });
    expect(handle.runtimeProvenance.omnigent_python_sha256).toBe(
      sha256(readFileSync(handle.runtimeProvenance.omnigent_python_realpath)),
    );
    expect(handle.runtimeProvenance.rickgent_node_sha256).toBe(
      sha256(readFileSync(handle.runtimeProvenance.rickgent_node_realpath)),
    );
    expect(handle.trustedSpawnCommand.executable).toBe(RESOLVED_OMNIGENT_PYTHON);
    expect(handle.spawnEnvironment.RICKGENT_OMNIGENT_PYTHON_ENTRYPOINT).toBe(RESOLVED_OMNIGENT_PYTHON);
    expect(handle.spawnEnvironment.RICKGENT_NODE_REALPATH).toBe(realpathSync(process.execPath));
    expect(deepFrozen(handle)).toBe(true);
    expect(pathInside(input.worktree, handle.attemptRoot)).toBe(false);
    expect(pathInside(AGENT_ROOT, handle.attemptRoot)).toBe(false);

    const yaml = parse(readFileSync(handle.configPath, "utf8")) as {
      executor: { config: { harness: string } };
      llm: { model: string };
      guardrails: { policies: Record<string, { function: { path: string }; config?: Record<string, unknown> }> };
    };
    expect(yaml.executor.config.harness).toBe("codex");
    expect(yaml.llm.model).toBe("gpt-5");
    const rickgentPolicies = Object.values(yaml.guardrails.policies)
      .filter((policy) => policy.function.path.startsWith("rickgent_policies."));
    expect(rickgentPolicies.length).toBeGreaterThan(0);
    for (const policy of rickgentPolicies) {
      expect(Object.keys(policy.config ?? {}).sort()).toEqual([...POLICY_CONFIG_KEYS].sort());
      expect(Object.values(policy.config ?? {}).every((value) => typeof value === "string")).toBe(true);
      expect(Object.values(policy.config ?? {}).some((value) => Array.isArray(value) || typeof value === "object")).toBe(false);
    }
    expect(handle.requestedConfigSha256).not.toBe(handle.invokedConfigSha256);
    expect(handle.requestedBundleSha256).not.toBe(handle.invokedBundleSha256);
    expect(sha256(readFileSync(handle.configPath))).toBe(handle.invokedConfigSha256);
    expect(policyBundleSha256(handle.bundleDir)).toBe(handle.invokedBundleSha256);
    verifyPolicyBundleForSpawn(handle);
  });

  it("keeps every authority path private, owned, non-symlinked, and free of the raw owner token", () => {
    const handle = materialize(input);
    for (const path of [handle.stateRoot, handle.attemptsRoot, handle.attemptRoot, handle.bundleDir]) {
      const info = lstatSync(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(0o700);
      if (typeof process.getuid === "function") expect(info.uid).toBe(process.getuid());
    }
    for (const path of walk(handle.attemptRoot)) {
      const info = lstatSync(path);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
      if (typeof process.getuid === "function") expect(info.uid).toBe(process.getuid());
      if (info.isFile()) expect(readFileSync(path, "utf8")).not.toContain(handle.ownerToken);
    }
    expect(handle.spawnEnvironment.RICKGENT_CONTEXT_OWNER_TOKEN).toBe(handle.ownerToken);
    expect(handle.policyConfig.context_owner_token_sha256).toBe(handle.ownerTokenSha256);
  });

  it("pins every reserved spawn value after hostile caller environment values", () => {
    const handle = materialize(input);
    const hostile = Object.fromEntries(TRUSTED_SPAWN_ENVIRONMENT_KEYS.map((key) => [key, "agent-controlled"]));
    const finalEnvironment = { ...hostile, ...handle.spawnEnvironment };
    expect(finalEnvironment).toMatchObject(handle.spawnEnvironment);
    expect(Object.values(handle.spawnEnvironment).every((value) => value !== "agent-controlled")).toBe(true);
  });

  it("rejects context, config, and bundle tampering before spawn", () => {
    const contextHandle = materialize(input);
    writeFileSync(contextHandle.contextPath, Buffer.from("{}"));
    expect(() => verifyPolicyBundleForSpawn(contextHandle)).toThrow(/context (?:size|digest|bytes)/);

    const configHandle = materialize(input, {
      dispatch: { runId: "run-002", ticketId: "t09", phase: "implement", attempt: 1, role: "worker" },
    });
    writeFileSync(configHandle.configPath, `${readFileSync(configHandle.configPath, "utf8")}\n# tampered\n`);
    expect(() => verifyPolicyBundleForSpawn(configHandle)).toThrow(/config digest changed/);

    const bundleHandle = materialize(input, {
      dispatch: { runId: "run-003", ticketId: "t09", phase: "implement", attempt: 1, role: "worker" },
    });
    const injected = join(bundleHandle.bundleDir, "agent-controlled.txt");
    writeFileSync(injected, "tampered");
    chmodSync(injected, 0o600);
    expect(() => verifyPolicyBundleForSpawn(bundleHandle)).toThrow(/bundle digest changed/);
  });

  it("rejects unsafe roots, symlinked templates, and duplicate attempt allocation", () => {
    const first = materialize(input);
    expect(() => materialize(input)).toThrow();
    expect(existsSync(first.contextPath)).toBe(true);
    verifyPolicyBundleForSpawn(first);

    const unsafeRoot = join(root, "unsafe-state");
    mkdirSync(unsafeRoot, { mode: 0o755 });
    chmodSync(unsafeRoot, 0o755);
    expect(() => materialize(input, { stateRoot: unsafeRoot, dispatch: { runId: "unsafe", ticketId: "t09", phase: "implement", attempt: 1, role: "worker" } }))
      .toThrow(/mode must be exactly 0700/);

    const agent = join(root, "symlink-agent");
    cpSync(AGENT_ROOT, agent, { recursive: true });
    symlinkSync(first.contextPath, join(agent, "agents", "worker", "escape"));
    expect(() => materialize(input, {
      agentRoot: agent,
      dispatch: { runId: "symlink", ticketId: "t09", phase: "implement", attempt: 1, role: "worker" },
    })).toThrow(/symlink/);
  });

  it("closes an owned lease after expiry and quarantines only after cleanup proof", () => {
    const handle = materialize(input);
    vi.spyOn(Date, "now").mockReturnValue(handle.leaseExpiresAtMs + 1);
    expect(() => closePolicyBundleLease(handle)).not.toThrow();
    const closed = JSON.parse(readFileSync(handle.leasePath, "utf8")) as { status: string };
    expect(closed.status).toBe("closed");

    const secondRoot = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-policy-context-finalize-")));
    try {
      const second = fixture(secondRoot);
      const secondHandle = materialize(second);
      expect(() => finalizePolicyBundle(secondHandle, {
        childClosed: false,
        workspaceCleanupProven: true,
        disposition: "quarantine",
      })).toThrow(/before child close/);
      const result = finalizePolicyBundle(secondHandle, {
        childClosed: true,
        workspaceCleanupProven: true,
        disposition: "quarantine",
      });
      expect(result.disposition).toBe("quarantined");
      expect(existsSync(secondHandle.attemptRoot)).toBe(false);
      expect(existsSync(join(result.path, "context.json"))).toBe(true);
      expect(existsSync(secondHandle.nonceClaimPath)).toBe(true);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
