// Scope fence math — PURE decision functions.
// Path canonicalization and scope checking.
// Parity with the Python shim pinned by shared AC-10 fixtures.

import { realpathSync } from "fs";
import { resolve, dirname, basename, join } from "path";

export interface ScopeInput {
  /** Declared paths for the ticket (directory prefixes or file paths). */
  declaredPaths: string[];
  /** Target path to check (already canonicalized to be worktree-root-relative). */
  targetPath: string;
  /** Whether this is a write operation. */
  isWrite: boolean;
}

export type ScopeVerdict =
  | { result: "ALLOW" }
  | { result: "DENY"; reason: string; code: string };

export function checkScope(input: ScopeInput): ScopeVerdict {
  // AC-16: Fail closed on malformed input
  if (input == null || typeof input !== "object") {
    return { result: "DENY", reason: "invalid input", code: "SCOPE_DENIED" };
  }

  const isWrite = input.isWrite === true;
  const isRead = input.isWrite === false;
  const targetPath = typeof input.targetPath === "string" ? input.targetPath : "";
  const declaredPaths = Array.isArray(input.declaredPaths) ? input.declaredPaths : [];

  // If isWrite is not a proper boolean, fail closed
  if (!isWrite && !isRead) {
    return { result: "DENY", reason: "invalid isWrite field", code: "SCOPE_DENIED" };
  }

  // Non-write operations are always allowed
  if (!isWrite) {
    return { result: "ALLOW" };
  }

  // Unresolvable target → DENY
  if (!targetPath) {
    return { result: "DENY", reason: "unresolvable write target", code: "SCOPE_DENIED" };
  }

  // Canonicalize the target path (remove ., .., etc.)
  const canonicalTarget = canonicalizePath(targetPath);

  // Check if the target is within any declared path
  for (const declared of declaredPaths) {
    const canonicalDeclared = canonicalizePath(declared);
    if (isPathInScope(canonicalTarget, canonicalDeclared)) {
      return { result: "ALLOW" };
    }
  }

  return {
    result: "DENY",
    reason: `${canonicalTarget} not in declared paths [${declaredPaths.join(", ")}]`,
    code: "SCOPE_DENIED",
  };
}

function canonicalizePath(p: string): string {
  // Resolve . and .. components
  const parts = p.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/");
}

export function isPathInScope(target: string, scope: string): boolean {
  // Exact match
  if (target === scope) return true;
  // Directory prefix match (scope ends with / or target starts with scope/)
  if (scope.endsWith("/")) {
    return target.startsWith(scope);
  }
  return target.startsWith(scope + "/");
}

// ── Filesystem-aware scope check (symlink / rename / not-yet-created writes) ──

export interface ResolvedScopeInput {
  /** Absolute filesystem root of the worktree. */
  root: string;
  /** Declared paths (dir prefixes or files), relative to root. */
  declaredPaths: string[];
  /** Primary write target, relative to root. May not exist yet. */
  targetPath: string;
  /** Whether this is a write operation. */
  isWrite: boolean;
  /**
   * Second endpoint for rename/link ops, relative to root. When present,
   * BOTH targetPath (source) and destinationPath must resolve in-scope.
   */
  destinationPath?: string;
}

/**
 * Resolve an absolute path to its canonical real form. Symlinks in the
 * existing portion are followed; components that do not yet exist (a
 * not-yet-created write target) are re-appended to the realpath of the
 * nearest existing parent. This closes the symlink/rename escape a purely
 * lexical check misses while still permitting a benign new file.
 */
function realpathNearestExisting(absPath: string): string {
  const normalized = resolve(absPath);
  let current = normalized;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Nothing along the path exists up to the filesystem root.
        return normalized;
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export function checkScopeResolved(input: ResolvedScopeInput): ScopeVerdict {
  // Fail closed on malformed input.
  if (input == null || typeof input !== "object") {
    return { result: "DENY", reason: "invalid input", code: "SCOPE_DENIED" };
  }

  const isWrite = input.isWrite === true;
  const isRead = input.isWrite === false;
  if (!isWrite && !isRead) {
    return { result: "DENY", reason: "invalid isWrite field", code: "SCOPE_DENIED" };
  }
  if (!isWrite) {
    return { result: "ALLOW" };
  }

  const root = typeof input.root === "string" ? input.root : "";
  if (!root) {
    return { result: "DENY", reason: "unresolvable worktree root", code: "SCOPE_DENIED" };
  }

  const declaredPaths = Array.isArray(input.declaredPaths)
    ? input.declaredPaths.filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];

  // Endpoints: the write target, plus the destination for rename/link ops.
  const endpoints: Array<{ label: string; rel: string }> = [];
  if (typeof input.targetPath === "string" && input.targetPath) {
    endpoints.push({ label: "target", rel: input.targetPath });
  }
  if (typeof input.destinationPath === "string" && input.destinationPath) {
    endpoints.push({ label: "destination", rel: input.destinationPath });
  }
  if (endpoints.length === 0) {
    return { result: "DENY", reason: "unresolvable write target", code: "SCOPE_DENIED" };
  }

  const resolvedDeclared = declaredPaths.map((d) => resolveEndpoint(root, d));

  for (const endpoint of endpoints) {
    const resolvedTarget = resolveEndpoint(root, endpoint.rel);
    const inScope = resolvedDeclared.some((d) => isPathInScope(resolvedTarget, d));
    if (!inScope) {
      return {
        result: "DENY",
        reason: `${endpoint.label} ${endpoint.rel} resolves outside declared paths`,
        code: "SCOPE_DENIED",
      };
    }
  }

  return { result: "ALLOW" };
}

function resolveEndpoint(root: string, rel: string): string {
  return realpathNearestExisting(resolve(root, rel));
}
