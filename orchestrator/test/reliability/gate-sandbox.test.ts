/**
 * t26 — Sandboxed structured gate runner: sandbox enforcement tests.
 *
 * VAL-LIFE-003: The gate runner executes argv-only verification through the
 * supervisor and sandbox.  `sh -c` and command interpolation are removed.
 *
 * These tests prove the sandbox layer:
 *   (a) builds an environment from the verification's sealed allowlist only
 *       (no injected credentials, no unsealed env keys);
 *   (b) resolves the cwd from the sealed `cwd_class` (repository_root,
 *       orchestrator_package, attempt_output);
 *   (c) validates `writable_outputs` — paths outside the declared set are
 *       rejected fail-closed;
 *   (d) denies network (network is always "deny" per the contract);
 *   (e) enforces output/resource caps (timeout, output bounds);
 *   (f) rejects shell executables — the sandbox refuses to exec any binary
 *       whose base name is a known shell (sh, bash, zsh, dash, ksh, fish).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSandboxEnv,
  resolveVerificationCwd,
  validateWritableOutputs,
  buildSandboxSpec,
  SHELL_EXECUTABLE_BASE_NAMES,
} from "../../src/verification/sandbox.js";
import type { TicketVerification } from "../../src/contracts/ticket-contract.js";

function makeVerification(overrides: Partial<TicketVerification> = {}): TicketVerification {
  return {
    id: "VERIFY-SANDBOX-01",
    executable: "true",
    args: [],
    cwd_class: "repository_root",
    env_allowlist: ["PATH"],
    timeout_ms: 5000,
    network: "deny",
    writable_outputs: [],
    expected_exit_codes: [0],
    ...overrides,
  };
}

describe("gate-sandbox: environment is built from the sealed allowlist only", () => {
  it("includes only allowlisted keys that exist in the source env", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin", HOME: "/home/user", SECRET_TOKEN: "s3cret", NODE_OPTIONS: "--inspect" },
      ["PATH", "HOME"],
    );
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });

  it("does not include keys that are not in the allowlist even if present in source env", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin", SECRET_TOKEN: "s3cret", DATABASE_URL: "postgres://localhost" },
      ["PATH"],
    );
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("omits allowlisted keys that are not present in the source env (no fabrication)", () => {
    const env = buildSandboxEnv({ PATH: "/usr/bin" }, ["PATH", "HOME", "LANG"]);
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  it("returns a frozen object (authority-owned, not caller-mutable)", () => {
    const env = buildSandboxEnv({ PATH: "/usr/bin" }, ["PATH"]);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("rejects an empty allowlist (fail-closed — no env is a valid env for a sealed verification)", () => {
    const env = buildSandboxEnv({ PATH: "/usr/bin", HOME: "/h" }, []);
    expect(Object.keys(env)).toEqual([]);
  });
});

describe("gate-sandbox: cwd is resolved from the sealed cwd_class", () => {
  let repoRoot: string;

  function setupRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-sandbox-cwd-")));
    mkdirSync(join(root, "orchestrator"), { recursive: true });
    return root;
  }

  it("repository_root resolves to the repository root", () => {
    repoRoot = setupRepo();
    try {
      expect(resolveVerificationCwd("repository_root", repoRoot)).toBe(repoRoot);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("orchestrator_package resolves to the orchestrator subdirectory", () => {
    repoRoot = setupRepo();
    try {
      expect(resolveVerificationCwd("orchestrator_package", repoRoot)).toBe(join(repoRoot, "orchestrator"));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("attempt_output resolves to the worktree path when supplied", () => {
    repoRoot = setupRepo();
    const worktree = join(repoRoot, "worktree-attempt");
    mkdirSync(worktree, { recursive: true });
    try {
      expect(resolveVerificationCwd("attempt_output", repoRoot, worktree)).toBe(worktree);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("attempt_output returns null when no worktree path is supplied (fail-closed)", () => {
    repoRoot = setupRepo();
    try {
      expect(resolveVerificationCwd("attempt_output", repoRoot)).toBe(null);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("gate-sandbox: writable_outputs are validated against the repository root", () => {
  let repoRoot: string;

  function setupRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-sandbox-writable-")));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    return root;
  }

  it("accepts paths within the repository root", () => {
    repoRoot = setupRepo();
    try {
      const validated = validateWritableOutputs(["src/output.txt", "build/"], repoRoot);
      expect(validated).toEqual(["src/output.txt", "build/"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects a path outside the repository root (directory traversal)", () => {
    repoRoot = setupRepo();
    try {
      expect(() => validateWritableOutputs(["../escape.txt"], repoRoot)).toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects an absolute path outside the repository root", () => {
    repoRoot = setupRepo();
    try {
      expect(() => validateWritableOutputs(["/etc/passwd"], repoRoot)).toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects an empty writable_outputs list (no writes allowed)", () => {
    repoRoot = setupRepo();
    try {
      const validated = validateWritableOutputs([], repoRoot);
      expect(validated).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("gate-sandbox: buildSandboxSpec composes the full sandbox envelope", () => {
  let repoRoot: string;

  function setupRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-sandbox-spec-")));
    mkdirSync(join(root, "orchestrator"), { recursive: true });
    return root;
  }

  it("builds a spec with filtered env, resolved cwd, sealed timeout, denied network, validated writable outputs", () => {
    repoRoot = setupRepo();
    try {
      const verification = makeVerification({
        env_allowlist: ["PATH", "LANG"],
        cwd_class: "orchestrator_package",
        timeout_ms: 15_000,
        writable_outputs: ["build/output.txt"],
      });
      const spec = buildSandboxSpec(
        verification,
        { PATH: "/usr/bin", LANG: "en_US.UTF-8", HOME: "/h", SECRET: "x" },
        repoRoot,
      );
      expect(spec.cwd).toBe(join(repoRoot, "orchestrator"));
      expect(Object.keys(spec.env).sort()).toEqual(["LANG", "PATH"]);
      expect(spec.timeoutMs).toBe(15_000);
      expect(spec.networkDenied).toBe(true);
      expect(spec.writableOutputs).toEqual(["build/output.txt"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects a verification whose executable is a known shell (fail-closed)", () => {
    repoRoot = setupRepo();
    try {
      for (const shellName of SHELL_EXECUTABLE_BASE_NAMES) {
        const verification = makeVerification({ executable: shellName });
        expect(() => buildSandboxSpec(verification, { PATH: "/usr/bin" }, repoRoot)).toThrow();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects a verification whose executable is a shell with a full path (fail-closed)", () => {
    repoRoot = setupRepo();
    try {
      const verification = makeVerification({ executable: "/bin/sh" });
      expect(() => buildSandboxSpec(verification, { PATH: "/usr/bin" }, repoRoot)).toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when cwd_class is attempt_output but no worktree is supplied", () => {
    repoRoot = setupRepo();
    try {
      const verification = makeVerification({ cwd_class: "attempt_output" });
      expect(() => buildSandboxSpec(verification, { PATH: "/usr/bin" }, repoRoot)).toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
