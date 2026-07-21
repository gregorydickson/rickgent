/**
 * t26 — Sandboxed verification sandbox enforcement.
 *
 * The sandbox layer enforces the sealed `TicketVerification` contract:
 *   - environment is built from the verification's `env_allowlist` only
 *     (no injected credentials, no unsealed env keys);
 *   - the cwd is resolved from the sealed `cwd_class` (repository_root,
 *     orchestrator_package, attempt_output);
 *   - `writable_outputs` are validated against the repository root (no
 *     directory traversal, no absolute paths outside the repo);
 *   - network is always denied (the contract seals `network: "deny"`);
 *   - shell executables are rejected (the sandbox refuses to exec any
 *     binary whose base name is a known shell — `sh`, `bash`, `zsh`, etc.);
 *   - output/resource caps (timeout, output bounds) come from the sealed
 *     verification spec, not from the caller.
 *
 * This module is the single source of truth for the sandbox envelope.  The
 * gate runner ({@link runGateVerification}) consumes the sandbox spec and
 * executes the verification argv through it.
 *
 * @invariant Fail closed, everywhere.  Missing/malformed/unresolvable →
 *   throw (the gate runner maps the throw to `infrastructure_error` or
 *   `unavailable`).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { TicketVerification, VerificationCwdClass } from "../contracts/ticket-contract.js";

/**
 * Base names of executables that are shells.  The sandbox refuses to exec
 * any of these — verification must be argv-only, not shell-interpolated.
 * This is the same list the contract parser uses (TICKET_VERIFICATION_SHELL_FORBIDDEN).
 */
export const SHELL_EXECUTABLE_BASE_NAMES = Object.freeze([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
] as const);

const SHELL_SET = new Set<string>(SHELL_EXECUTABLE_BASE_NAMES);

/**
 * The schema version for the sandbox spec.  Increment when the envelope
 * shape changes.
 */
export const SANDBOX_SPEC_SCHEMA_VERSION = "rickgent.sandbox-spec.v1" as const;

/**
 * A sandboxed execution environment derived from a sealed `TicketVerification`.
 * Every field comes from the contract, not from the caller.
 */
export interface SandboxExecutionSpec {
  /** The resolved cwd from the sealed `cwd_class`. */
  readonly cwd: string;
  /** The filtered env from the sealed `env_allowlist` (frozen). */
  readonly env: Readonly<Record<string, string>>;
  /** The sealed timeout in milliseconds. */
  readonly timeoutMs: number;
  /** The validated writable outputs (paths normalized relative to repo root). */
  readonly writableOutputs: readonly string[];
  /** Network is always denied per the contract. */
  readonly networkDenied: boolean;
  /** The sealed expected exit codes. */
  readonly expectedExitCodes: readonly number[];
  /** The schema version. */
  readonly schemaVersion: string;
}

/**
 * Build an environment record from the source env, filtered to the sealed
 * allowlist.  Only keys present in both the allowlist AND the source env are
 * included.  No key is fabricated.
 *
 * @returns A frozen record (authority-owned, not caller-mutable).
 */
export function buildSandboxEnv(
  sourceEnv: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return Object.freeze(env);
}

/**
 * Resolve the verification cwd from the sealed `cwd_class`.
 *
 * - `repository_root` → the repository root.
 * - `orchestrator_package` → `<repo>/orchestrator`.
 * - `attempt_output` → the worktree path (or null if not supplied).
 *
 * @returns The resolved cwd, or `null` if the cwd class cannot be resolved
 *   (e.g. `attempt_output` without a worktree path).
 */
export function resolveVerificationCwd(
  cwdClass: VerificationCwdClass,
  repositoryRoot: string,
  worktreePath?: string,
): string | null {
  if (cwdClass === "repository_root") return repositoryRoot;
  if (cwdClass === "orchestrator_package") return resolve(repositoryRoot, "orchestrator");
  if (cwdClass === "attempt_output") {
    if (worktreePath === undefined || worktreePath.length === 0) return null;
    return worktreePath;
  }
  return null;
}

/**
 * Validate that all writable output paths are within the repository root.
 * Paths are resolved relative to the repo root.  Directory traversal (`..`)
 * and absolute paths outside the repo are rejected fail-closed.
 *
 * @returns The validated paths (normalized, relative to repo root).
 * @throws If any path escapes the repository root.
 */
export function validateWritableOutputs(
  outputs: readonly string[],
  repositoryRoot: string,
): readonly string[] {
  const normalizedRoot = resolve(repositoryRoot);
  const validated: string[] = [];
  for (const output of outputs) {
    if (output.length === 0) {
      throw new Error(`RICKGENT_SANDBOX_OUTPUT_INVALID: writable_outputs contains an empty path`);
    }
    const resolved = isAbsolute(output) ? resolve(output) : resolve(normalizedRoot, output);
    const rel = relative(normalizedRoot, resolved);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new Error(
        `RICKGENT_SANDBOX_OUTPUT_INVALID: writable_outputs path '${output}' escapes the repository root`,
      );
    }
    validated.push(output);
  }
  return Object.freeze(validated);
}

/**
 * Check whether an executable base name is a known shell.  The sandbox
 * refuses to exec shells — verification must be argv-only.
 */
export function isShellExecutable(executable: string): boolean {
  const base = executable.split("/").at(-1)?.toLowerCase() ?? executable.toLowerCase();
  return SHELL_SET.has(base);
}

/**
 * Compose the full sandbox envelope from a sealed `TicketVerification` and
 * the source environment.  This is the single entry point for building the
 * sandbox spec — the gate runner consumes it.
 *
 * @throws If the executable is a shell, the cwd cannot be resolved, or the
 *   writable outputs are invalid.  The gate runner maps these to
 *   `infrastructure_error` (or the caller catches and maps to the
 *   appropriate status).
 */
export function buildSandboxSpec(
  verification: TicketVerification,
  sourceEnv: NodeJS.ProcessEnv,
  repositoryRoot: string,
  worktreePath?: string,
): SandboxExecutionSpec {
  if (isShellExecutable(verification.executable)) {
    throw new Error(
      `RICKGENT_SANDBOX_SHELL_FORBIDDEN: verification executable '${verification.executable}' is a shell; argv-only required`,
    );
  }
  const cwd = resolveVerificationCwd(verification.cwd_class, repositoryRoot, worktreePath);
  if (cwd === null) {
    throw new Error(
      `RICKGENT_SANDBOX_CWD_UNRESOLVABLE: cwd_class '${verification.cwd_class}' cannot be resolved`,
    );
  }
  const env = buildSandboxEnv(sourceEnv, verification.env_allowlist);
  const writableOutputs = validateWritableOutputs(verification.writable_outputs, repositoryRoot);
  return Object.freeze({
    cwd,
    env,
    timeoutMs: verification.timeout_ms,
    writableOutputs,
    networkDenied: verification.network === "deny",
    expectedExitCodes: Object.freeze([...verification.expected_exit_codes]),
    schemaVersion: SANDBOX_SPEC_SCHEMA_VERSION,
  });
}
