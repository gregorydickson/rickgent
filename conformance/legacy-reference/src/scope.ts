/**
 * Legacy scope reference — extracted from pickle-rick-claude@95f5c416.
 *
 * Provenance: git show 95f5c416:extension/src/bin/check-scope-diff.ts
 *
 * This is a STANDALONE port of the legacy `isPathInScope` and `normalizePath`
 * functions. These are pure functions with ZERO stubs — they copy-extract
 * directly from the legacy source.
 *
 * The legacy scope check applies to STAGED (write) paths only. It does NOT
 * canonicalize `..` traversal (it only strips trailing slashes). The new core
 * canonicalizes `..` and adds read-allow semantics — these are new-core-only
 * behaviors with no legacy counterpart (see manifest annotations).
 */

/**
 * Normalize a path by stripping trailing slashes.
 * (Verbatim from check-scope-diff.ts@95f5c416)
 */
export function normalizePath(p: string): string {
  return p.replace(/\/$/, '');
}

/**
 * Check if a staged path is within any of the allowed paths.
 * (Verbatim from check-scope-diff.ts@95f5c416)
 *
 * Uses lexical prefix matching only — does NOT resolve `..` traversal.
 */
export function isPathInScope(stagedPath: string, allowedPaths: string[]): boolean {
  const normalized = normalizePath(stagedPath);
  return allowedPaths.some((allowed) => {
    const normalizedAllowed = normalizePath(allowed);
    return normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + '/');
  });
}

// ── Adapter: maps conformance fixture inputs to the legacy scope check ──

export interface FixtureScopeInput {
  declaredPaths: string[];
  targetPath: string;
  isWrite: boolean;
}

export interface FixtureScopeResult {
  result: 'ALLOW' | 'DENY';
  code?: string;
}

/**
 * Drive the legacy `isPathInScope` with a conformance fixture input.
 *
 * The legacy scope check ONLY applies to write operations (staged paths).
 * For read operations (isWrite: false), there is no legacy counterpart —
 * the legacy never checked reads. This adapter returns ALLOW for reads
 * to match the new-core read-allow behavior, but this is annotated as
 * new-core-only in the manifest (no legacy counterpart).
 *
 * For path traversal (`..`), the legacy does NOT canonicalize — it uses
 * lexical prefix matching only. This means `src/auth/../billing/invoice.py`
 * would lexically match scope `src/auth/` in the legacy, while the new core
 * canonicalizes and correctly denies it. This is annotated as a new-core-only
 * behavior in the manifest.
 */
export function runLegacyScope(input: FixtureScopeInput): FixtureScopeResult {
  // Reads: no legacy counterpart — the legacy only checked staged (write) paths.
  // We do NOT run the legacy for reads; this case is new-core-only-annotated.
  if (!input.isWrite) {
    return { result: 'ALLOW' };
  }

  // Writes: run the legacy isPathInScope (lexical prefix match, no canonicalization)
  const inScope = isPathInScope(input.targetPath, input.declaredPaths);
  return inScope
    ? { result: 'ALLOW' }
    : { result: 'DENY', code: 'SCOPE_DENIED' };
}
