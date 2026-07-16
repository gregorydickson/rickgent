import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sealTicketContracts, type TicketContract } from "../../src/contracts/ticket-contract.js";
import type { ReadyRunWorkspace } from "../../src/git/run-workspace.js";
import {
  POLICY_CONFIG_KEYS,
  REQUIRED_POLICY_ATTACHMENTS,
  materializePolicyBundle,
  validatePolicyAttachmentObject,
} from "../../src/policy/policy-bundle.js";

const REAL_AGENT_ROOT = join(import.meta.dirname, "../../../agents/rickgent");
const RICKGENT_CLI = realpathSync(join(import.meta.dirname, "../../dist/cli.js"));

function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function ticket(): TicketContract {
  return sealTicketContracts([{
    schema_version: "1.0.0",
    id: "t11",
    title: "Native attachment startup",
    description: "Prove the exact attached policy runtime inventory.",
    depends_on: [],
    scope: [{ path: "test", change_kind: "modify", directory: true }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-ATTACH",
      description: "Every policy resolves and executes with attempt config.",
      interface_ids: [],
      verification_ids: ["VER-ATTACH"],
    }],
    verifications: [{
      id: "VER-ATTACH",
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
      max_attempts: 1,
      max_review_cycles: 1,
      wall_clock_ms: 60_000,
      remediation_limit: 1,
    },
  }])[0]!;
}

function workspace(root: string): ReadyRunWorkspace {
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  privateDirectory(repo);
  privateDirectory(worktree);
  return Object.freeze({
    kind: "ready_run_workspace" as const,
    callerRepo: repo,
    commonGitDir: join(root, "git-common"),
    callerGitDir: join(root, "git-caller"),
    deliveryRef: "refs/heads/feature/native-attachment",
    baselineSha: "a".repeat(40),
    runRef: "refs/heads/rickgent/runs/run-attachment",
    worktreeDir: worktree,
    worktreeGitDir: join(root, "git-worktree"),
    allocationRoot: root,
    callerBefore: Object.freeze({
      headSha: "a".repeat(40),
      symbolicRef: "refs/heads/feature/native-attachment",
      indexSha256: "b".repeat(64),
      statusSha256: "c".repeat(64),
    }),
  });
}

function materialize(root: string, agentRoot = REAL_AGENT_ROOT) {
  const stateRoot = join(root, "state");
  privateDirectory(stateRoot);
  return materializePolicyBundle({
    agentRoot,
    stateRoot,
    dispatch: {
      runId: "run-attachment",
      ticketId: "t11",
      phase: "implement",
      attempt: 1,
      role: "worker",
    },
    ticket: ticket(),
    workspace: workspace(root),
    selection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    leaseExpiresAtMs: Date.now() + 60_000,
    omnigentRoot: process.env.OMNIGENT_ROOT,
    omnigentPython: process.env.OMNIGENT_PYTHON,
    rickgentCli: RICKGENT_CLI,
  });
}

describe("native FunctionPolicy attachment startup", () => {
  let root: string;

  beforeEach(() => {
    expect(process.env.OMNIGENT_ROOT).toBeTruthy();
    root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-native-attachment-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("materializes, resolves, and smoke-executes the exact ordered inventory", () => {
    const handle = materialize(root);
    const document = parse(readFileSync(handle.configPath, "utf8")) as Record<string, unknown>;
    validatePolicyAttachmentObject(document, handle.policyConfig);

    const guardrails = document.guardrails as { policies: Record<string, {
      function: { path: string; arguments?: Record<string, unknown> };
      config?: Record<string, unknown>;
    }> };
    expect(Object.keys(guardrails.policies)).toEqual(
      REQUIRED_POLICY_ATTACHMENTS.map((row) => row.name),
    );
    for (const expected of REQUIRED_POLICY_ATTACHMENTS) {
      const policy = guardrails.policies[expected.name]!;
      expect(policy.function.path).toBe(expected.path);
      expect(policy.function.arguments ?? null).toEqual(expected.arguments);
      if (expected.rickgent) {
        expect(Object.keys(policy.config ?? {})).toEqual(POLICY_CONFIG_KEYS);
        expect(policy.config).toEqual(handle.policyConfig);
      } else {
        expect(policy.config).toBeUndefined();
      }
    }
  });

  it.each([
    ["missing", (policies: Record<string, any>) => { delete policies.convergence_gate; }],
    ["incompatible", (policies: Record<string, any>) => {
      policies.completion_evidence.function.path = "rickgent_policies.select_model";
    }],
    ["template-config", (policies: Record<string, any>) => {
      policies.scope_fence.config = { phase: "implement" };
    }],
  ])("fails before agent startup for a %s policy", (_label, mutate) => {
    const agentRoot = join(root, "agent");
    cpSync(REAL_AGENT_ROOT, agentRoot, { recursive: true });
    const configPath = join(agentRoot, "agents", "worker", "config.yaml");
    const document = parse(readFileSync(configPath, "utf8")) as {
      guardrails: { policies: Record<string, any> };
    };
    mutate(document.guardrails.policies);
    writeFileSync(configPath, stringify(document, { lineWidth: 0, sortMapEntries: false }));

    expect(() => materialize(root, agentRoot)).toThrow();
  });

  it("rejects a full static name inventory when attempt config is absent", () => {
    const handle = materialize(root);
    const document = parse(readFileSync(handle.configPath, "utf8")) as {
      guardrails: { policies: Record<string, { config?: Record<string, unknown> }> };
    };
    expect(Object.keys(document.guardrails.policies)).toEqual(
      REQUIRED_POLICY_ATTACHMENTS.map((row) => row.name),
    );
    delete document.guardrails.policies.scope_fence!.config;
    expect(() => validatePolicyAttachmentObject(document, handle.policyConfig)).toThrow(
      /config/,
    );
  });
});
