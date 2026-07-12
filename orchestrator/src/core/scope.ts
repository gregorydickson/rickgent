// Scope fence math — PURE decision functions.
// Path canonicalization and scope checking.
// Parity with the Python shim pinned by shared AC-10 fixtures.

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
  // Non-write operations are always allowed
  if (!input.isWrite) {
    return { result: "ALLOW" };
  }

  // Unresolvable target → DENY
  if (!input.targetPath) {
    return { result: "DENY", reason: "unresolvable write target", code: "SCOPE_DENIED" };
  }

  // Canonicalize the target path (remove ., .., etc.)
  const canonicalTarget = canonicalizePath(input.targetPath);

  // Check if the target is within any declared path
  for (const declared of input.declaredPaths) {
    const canonicalDeclared = canonicalizePath(declared);
    if (isPathInScope(canonicalTarget, canonicalDeclared)) {
      return { result: "ALLOW" };
    }
  }

  return {
    result: "DENY",
    reason: `${canonicalTarget} not in declared paths [${input.declaredPaths.join(", ")}]`,
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

function isPathInScope(target: string, scope: string): boolean {
  // Exact match
  if (target === scope) return true;
  // Directory prefix match (scope ends with / or target starts with scope/)
  if (scope.endsWith("/")) {
    return target.startsWith(scope);
  }
  return target.startsWith(scope + "/");
}
