// Scope fence math. The structured engine is filesystem-aware and fail-closed;
// the lexical surface remains only for pre-canonicalized legacy CLI callers.

import { lstatSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

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
  if (input == null || typeof input !== "object") {
    return { result: "DENY", reason: "invalid input", code: "SCOPE_DENIED" };
  }

  const isWrite = input.isWrite === true;
  const isRead = input.isWrite === false;
  const targetPath = typeof input.targetPath === "string" ? input.targetPath : "";
  const declaredPaths = Array.isArray(input.declaredPaths) ? input.declaredPaths : [];
  if (!isWrite && !isRead) {
    return { result: "DENY", reason: "invalid isWrite field", code: "SCOPE_DENIED" };
  }
  if (!isWrite) return { result: "ALLOW" };
  if (!targetPath) {
    return { result: "DENY", reason: "unresolvable write target", code: "SCOPE_DENIED" };
  }

  const canonicalTarget = canonicalizePath(targetPath);
  for (const declared of declaredPaths) {
    if (typeof declared === "string" && isPathInScope(canonicalTarget, canonicalizePath(declared))) {
      return { result: "ALLOW" };
    }
  }
  return {
    result: "DENY",
    reason: `${canonicalTarget} not in declared paths [${declaredPaths.join(", ")}]`,
    code: "SCOPE_DENIED",
  };
}

function canonicalizePath(path: string): string {
  const resolved: string[] = [];
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

export function isPathInScope(target: string, scope: string): boolean {
  if (target === scope) return true;
  return scope.endsWith("/") ? target.startsWith(scope) : target.startsWith(`${scope}/`);
}

export type ScopeChangeKind = "create" | "modify" | "delete" | "rename";
export type ScopeOperationKind = "read" | ScopeChangeKind | "link";

export interface ScopeDeclaration {
  readonly path: string;
  readonly changeKind: ScopeChangeKind;
  readonly directory: boolean;
  readonly fromPath?: string;
}

export type ScopeOperation =
  | { readonly kind: "read" | "create" | "modify" | "delete"; readonly path: string; readonly directory: boolean }
  | { readonly kind: "rename" | "link"; readonly sourcePath: string; readonly destinationPath: string; readonly directory: boolean };

export interface StructuredScopeInput {
  /** Existing canonical worktree directory that bounds all authority. */
  readonly worktreeRoot: string;
  /** Existing canonical root from which every declaration and endpoint is resolved. */
  readonly authorizedRoot: string;
  /** Canonical state, attempt-policy/context, and bundle roots. */
  readonly reservedRoots: readonly string[];
  readonly declaredScope: readonly ScopeDeclaration[];
  readonly operation: ScopeOperation;
}

export type StructuredScopeVerdict =
  | { readonly result: "ALLOW"; readonly changeKind: ScopeChangeKind | null }
  | { readonly result: "ABSTAIN"; readonly changeKind: null }
  | { readonly result: "DENY"; readonly changeKind: ScopeChangeKind | null; readonly reason: string; readonly code: "RICKGENT_SCOPE_DENIED" };

interface ProvenDeclaration {
  readonly declaration: ScopeDeclaration;
  readonly path: string;
  readonly fromPath?: string;
}

class ScopeResolutionError extends Error {}

function deny(reason: string, changeKind: ScopeChangeKind | null = null): StructuredScopeVerdict {
  return { result: "DENY", changeKind, reason, code: "RICKGENT_SCOPE_DENIED" };
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalExistingDirectory(path: unknown, label: string): string {
  if (typeof path !== "string" || path === "" || !isAbsolute(path) || resolve(path) !== path) {
    throw new ScopeResolutionError(`${label} is not a canonical absolute path`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new ScopeResolutionError(`${label} is not a directory`);
  } catch (error) {
    if (error instanceof ScopeResolutionError) throw error;
    throw new ScopeResolutionError(`${label} is unavailable`);
  }
  if (canonical !== path) throw new ScopeResolutionError(`${label} is not canonical`);
  return canonical;
}

function validateRelativePath(path: unknown, label: string): string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) {
    throw new ScopeResolutionError(`${label} is empty or malformed`);
  }
  if (
    isAbsolute(path)
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.startsWith("\\\\")
    || path.includes("\\")
  ) {
    throw new ScopeResolutionError(`${label} must be a portable root-relative path`);
  }
  const components = path.split("/");
  if (components.some((part) => part === "" || part === "." || part === "..")) {
    throw new ScopeResolutionError(`${label} is not a canonical relative path`);
  }
  return path;
}

/** Resolve through the nearest existing parent without forgiving broken links or loops. */
function realpathNearestExisting(path: string): string {
  const normalized = resolve(path);
  let current = normalized;
  const tail: string[] = [];
  for (;;) {
    try {
      const canonical = realpathSync(current);
      return tail.length === 0 ? canonical : resolve(canonical, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new ScopeResolutionError("path cannot be resolved safely");
      try {
        lstatSync(current);
        // An existing object that realpath cannot resolve is a broken link.
        throw new ScopeResolutionError("path contains an unresolved symbolic link");
      } catch (probe) {
        if (probe instanceof ScopeResolutionError) throw probe;
        if ((probe as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ScopeResolutionError("path identity cannot be proven");
        }
      }
      const parent = dirname(current);
      if (parent === current) throw new ScopeResolutionError("path has no resolvable parent");
      tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

function lexicalGitPath(path: string): boolean {
  return path.split("/")[0] === ".git";
}

function overlapsReserved(path: string, directory: boolean, reservedRoots: readonly string[]): boolean {
  return reservedRoots.some((reserved) => pathInside(reserved, path) || (directory && pathInside(path, reserved)));
}

function endpointExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ScopeResolutionError("endpoint identity cannot be inspected");
  }
}

function declarationContains(declaration: ProvenDeclaration, endpoint: string, source = false): boolean {
  const declared = source ? declaration.fromPath : declaration.path;
  if (declared === undefined) return false;
  return declaration.declaration.directory ? pathInside(declared, endpoint) : declared === endpoint;
}

function validateDeclaration(value: ScopeDeclaration): void {
  if (value === null || typeof value !== "object") throw new ScopeResolutionError("scope declaration is malformed");
  if (!(["create", "modify", "delete", "rename"] as const).includes(value.changeKind) || typeof value.directory !== "boolean") {
    throw new ScopeResolutionError("scope declaration kind or directory flag is malformed");
  }
  validateRelativePath(value.path, "declared path");
  if (value.changeKind === "rename") validateRelativePath(value.fromPath, "declared rename source");
  else if (value.fromPath !== undefined) throw new ScopeResolutionError("non-rename declaration contains fromPath");
}

function proveEndpoint(
  rawPath: string,
  label: string,
  worktreeRoot: string,
  authorizedRoot: string,
  reservedRoots: readonly string[],
  directory: boolean,
): string {
  const relativePath = validateRelativePath(rawPath, label);
  if (lexicalGitPath(relativePath)) throw new ScopeResolutionError(`${label} enters .git`);
  const canonical = realpathNearestExisting(join(authorizedRoot, relativePath));
  if (!pathInside(worktreeRoot, canonical) || !pathInside(authorizedRoot, canonical)) {
    throw new ScopeResolutionError(`${label} resolves outside authorized scope`);
  }
  if (overlapsReserved(canonical, directory, reservedRoots)) {
    throw new ScopeResolutionError(`${label} overlaps a reserved root`);
  }
  return canonical;
}

function operationChangeKind(operation: ScopeOperation): ScopeChangeKind | null {
  if (operation.kind === "read") return null;
  return operation.kind === "link" ? "create" : operation.kind;
}

/**
 * Prove roots, every declaration, and every operation endpoint before applying
 * exact file/directory ownership and TicketContract change-kind semantics.
 */
export function checkStructuredScope(input: StructuredScopeInput): StructuredScopeVerdict {
  let observedKind: ScopeChangeKind | null = null;
  try {
    if (input == null || typeof input !== "object") return deny("scope request is malformed");
    const worktreeRoot = canonicalExistingDirectory(input.worktreeRoot, "worktree root");
    const authorizedRoot = canonicalExistingDirectory(input.authorizedRoot, "authorized root");
    if (!pathInside(worktreeRoot, authorizedRoot)) {
      return deny("authorized root is outside the canonical worktree");
    }
    if (!Array.isArray(input.reservedRoots) || !Array.isArray(input.declaredScope)) {
      return deny("reserved roots or declarations are malformed");
    }

    const reservedRoots = input.reservedRoots.map((root, index) => canonicalExistingDirectory(root, `reserved root ${index}`));
    const gitPath = join(worktreeRoot, ".git");
    try {
      reservedRoots.push(realpathSync(gitPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return deny(".git identity cannot be proven");
    }

    const declarations: ProvenDeclaration[] = input.declaredScope.map((declaration) => {
      validateDeclaration(declaration);
      const path = proveEndpoint(
        declaration.path,
        "declared path",
        worktreeRoot,
        authorizedRoot,
        reservedRoots,
        declaration.directory,
      );
      if (declaration.changeKind !== "rename") return { declaration, path };
      const fromPath = proveEndpoint(
        declaration.fromPath!,
        "declared rename source",
        worktreeRoot,
        authorizedRoot,
        reservedRoots,
        declaration.directory,
      );
      return { declaration, path, fromPath };
    });

    const operation = input.operation;
    if (operation === null || typeof operation !== "object" || typeof operation.directory !== "boolean") {
      return deny("scope operation is malformed");
    }
    observedKind = operationChangeKind(operation);

    if (operation.kind === "read" || operation.kind === "create" || operation.kind === "modify" || operation.kind === "delete") {
      if ("sourcePath" in operation || "destinationPath" in operation) {
        return deny("single-endpoint operation contains extra endpoints", observedKind);
      }
      const endpoint = proveEndpoint(
        operation.path,
        "operation endpoint",
        worktreeRoot,
        authorizedRoot,
        reservedRoots,
        operation.directory,
      );
      const exists = endpointExists(join(authorizedRoot, validateRelativePath(operation.path, "operation endpoint")));
      if (operation.kind === "create" && exists) return deny("create endpoint already exists", observedKind);
      if ((operation.kind === "read" || operation.kind === "modify" || operation.kind === "delete") && !exists) {
        return deny(`${operation.kind} endpoint does not exist`, observedKind);
      }
      if (exists && statSync(endpoint).isDirectory() !== operation.directory) {
        return deny("operation endpoint type does not match its directory flag", observedKind);
      }
      const owners = declarations.filter((declaration) => declarationContains(declaration, endpoint));
      if (operation.kind === "read") {
        return owners.length > 0 ? { result: "ALLOW", changeKind: null } : { result: "ABSTAIN", changeKind: null };
      }
      if (!owners.some((owner) => owner.declaration.changeKind === operation.kind)) {
        return deny("operation path or change kind is outside declared scope", observedKind);
      }
      return { result: "ALLOW", changeKind: observedKind };
    }

    if (operation.kind !== "rename" && operation.kind !== "link") return deny("scope operation kind is unsupported");
    if ("path" in operation) return deny("two-endpoint operation contains path", observedKind);
    const source = proveEndpoint(
      operation.sourcePath,
      "operation source",
      worktreeRoot,
      authorizedRoot,
      reservedRoots,
      operation.directory,
    );
    const destination = proveEndpoint(
      operation.destinationPath,
      "operation destination",
      worktreeRoot,
      authorizedRoot,
      reservedRoots,
      operation.directory,
    );
    const sourceLexical = join(authorizedRoot, validateRelativePath(operation.sourcePath, "operation source"));
    const destinationLexical = join(authorizedRoot, validateRelativePath(operation.destinationPath, "operation destination"));
    if (!endpointExists(sourceLexical)) return deny(`${operation.kind} source does not exist`, observedKind);
    if (endpointExists(destinationLexical)) return deny(`${operation.kind} destination already exists`, observedKind);
    if (statSync(source).isDirectory() !== operation.directory) {
      return deny("operation source type does not match its directory flag", observedKind);
    }

    if (operation.kind === "rename") {
      const owned = declarations.some((declaration) =>
        declaration.declaration.changeKind === "rename"
        && declarationContains(declaration, source, true)
        && declarationContains(declaration, destination),
      );
      return owned
        ? { result: "ALLOW", changeKind: "rename" }
        : deny("rename endpoints do not match one declared rename", "rename");
    }

    const destinationOwned = declarations.some((declaration) =>
      declaration.declaration.changeKind === "create" && declarationContains(declaration, destination),
    );
    return destinationOwned
      ? { result: "ALLOW", changeKind: "create" }
      : deny("link destination is outside declared create scope", "create");
  } catch (error) {
    const reason = error instanceof ScopeResolutionError ? error.message : "scope identity could not be proven";
    return deny(reason, observedKind);
  }
}

// Compatibility shape retained for the verdict CLI. It delegates to the same
// structured engine and grants no native tool authority.
export interface ResolvedScopeInput {
  root: string;
  declaredPaths: string[];
  targetPath: string;
  isWrite: boolean;
  destinationPath?: string;
}

export function checkScopeResolved(input: ResolvedScopeInput): ScopeVerdict {
  if (input == null || typeof input !== "object") return { result: "DENY", reason: "invalid input", code: "SCOPE_DENIED" };
  if (input.isWrite === false) return { result: "ALLOW" };
  if (input.isWrite !== true) return { result: "DENY", reason: "invalid isWrite field", code: "SCOPE_DENIED" };
  if (!Array.isArray(input.declaredPaths) || typeof input.targetPath !== "string" || input.targetPath === "") {
    return { result: "DENY", reason: "unresolvable write target", code: "SCOPE_DENIED" };
  }
  const paths = input.declaredPaths.map((path) => typeof path === "string" ? path.replace(/\/+$/, "") : path as unknown as string);
  let operation: ScopeOperation;
  let declarations: ScopeDeclaration[];
  if (typeof input.destinationPath === "string" && input.destinationPath !== "") {
    operation = { kind: "rename", sourcePath: input.targetPath, destinationPath: input.destinationPath, directory: false };
    declarations = paths.map((path) => ({ path, fromPath: path, changeKind: "rename", directory: true }));
  } else {
    let exists = false;
    try {
      exists = endpointExists(join(input.root, validateRelativePath(input.targetPath, "operation endpoint")));
    } catch {
      // The structured engine will return the canonical denial.
    }
    const kind: ScopeChangeKind = exists ? "modify" : "create";
    operation = { kind, path: input.targetPath, directory: false };
    declarations = paths.map((path) => ({ path, changeKind: kind, directory: true }));
  }
  const verdict = checkStructuredScope({
    worktreeRoot: input.root,
    authorizedRoot: input.root,
    reservedRoots: [],
    declaredScope: declarations,
    operation,
  });
  return verdict.result === "DENY"
    ? { result: "DENY", reason: verdict.reason, code: "SCOPE_DENIED" }
    : { result: "ALLOW" };
}
