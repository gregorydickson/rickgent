import {
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "fs";
import {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "path";

export type FilesystemCaseMode = "sensitive" | "insensitive" | "unknown";

export interface FilesystemPathIdentity {
  readonly resolved: string;
  /** Whether the eventual endpoint exists after following symlinks. */
  readonly exists: boolean;
  readonly caseMode: FilesystemCaseMode;
}

export class FilesystemIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemIdentityError";
  }
}

const CASE_MODE_CACHE = new Map<string, FilesystemCaseMode>();
const MAX_SYMLINK_DEPTH = 40;

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function alternateAsciiCase(name: string): string | null {
  for (let index = 0; index < name.length; index++) {
    const character = name[index]!;
    if (character >= "a" && character <= "z") {
      return `${name.slice(0, index)}${character.toUpperCase()}${name.slice(index + 1)}`;
    }
    if (character >= "A" && character <= "Z") {
      return `${name.slice(0, index)}${character.toLowerCase()}${name.slice(index + 1)}`;
    }
  }
  return null;
}

/** Read-only case-sensitivity probe. Uncertain observations remain fail-closed. */
function filesystemCaseMode(directory: string): FilesystemCaseMode {
  const cached = CASE_MODE_CACHE.get(directory);
  if (cached !== undefined) return cached;

  try {
    for (const entry of readdirSync(directory)) {
      const alternate = alternateAsciiCase(entry);
      if (alternate === null || alternate === entry) continue;
      const originalPath = resolve(directory, entry);
      const alternatePath = resolve(directory, alternate);

      try {
        lstatSync(alternatePath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          CASE_MODE_CACHE.set(directory, "sensitive");
          return "sensitive";
        }
        continue;
      }

      try {
        if (realpathSync(originalPath) === realpathSync(alternatePath)) {
          CASE_MODE_CACHE.set(directory, "insensitive");
          return "insensitive";
        }
      } catch {
        // Try another entry. If none proves an identity, remain fail-closed.
      }
    }
  } catch {
    // Permission and observation failures are unknown, never sensitive.
  }

  CASE_MODE_CACHE.set(directory, "unknown");
  return "unknown";
}

function pathSegments(absolutePath: string): { root: string; segments: string[] } {
  const normalized = resolve(absolutePath);
  const root = parse(normalized).root;
  const suffix = relative(root, normalized);
  return {
    root,
    segments: suffix === "" ? [] : suffix.split(sep),
  };
}

function resolveIdentity(
  absolutePath: string,
  visitedSymlinkStates: ReadonlySet<string>,
  depth: number,
): FilesystemPathIdentity {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new FilesystemIdentityError(`too many symbolic links while resolving ${absolutePath}`);
  }

  const { root, segments } = pathSegments(absolutePath);
  let current: string;
  try {
    current = realpathSync(root);
  } catch (error) {
    throw new FilesystemIdentityError(
      `cannot resolve filesystem root for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (segments.length === 0) {
    return { resolved: current, exists: true, caseMode: "sensitive" };
  }

  for (let index = 0; index < segments.length; index++) {
    const remaining = segments.slice(index);
    const candidate = resolve(current, remaining[0]!);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return {
          resolved: resolve(current, ...remaining),
          exists: false,
          caseMode: filesystemCaseMode(current),
        };
      }
      throw new FilesystemIdentityError(
        `cannot observe ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (stat.isSymbolicLink()) {
      const remainingAfterLink = segments.slice(index + 1);
      const symlinkState = `${candidate}\0${remainingAfterLink.join("\0")}`;
      if (visitedSymlinkStates.has(symlinkState)) {
        throw new FilesystemIdentityError(`symbolic-link cycle while resolving ${absolutePath}`);
      }
      let target: string;
      try {
        const link = readlinkSync(candidate);
        target = isAbsolute(link) ? link : resolve(dirname(candidate), link);
      } catch (error) {
        throw new FilesystemIdentityError(
          `cannot read symbolic link ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const nextVisited = new Set(visitedSymlinkStates);
      nextVisited.add(symlinkState);
      return resolveIdentity(
        resolve(target, ...remainingAfterLink),
        nextVisited,
        depth + 1,
      );
    }

    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new FilesystemIdentityError(`${candidate} is not a directory`);
    }

    try {
      current = realpathSync(candidate);
    } catch (error) {
      throw new FilesystemIdentityError(
        `cannot resolve ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { resolved: current, exists: true, caseMode: "sensitive" };
}

/**
 * Resolve the eventual endpoint of an existing or missing path without writes.
 * Dangling symlinks are followed to the target a subsequent write would reach.
 */
export function resolveFilesystemIdentity(path: string): FilesystemPathIdentity {
  return resolveIdentity(resolve(path), new Set<string>(), 0);
}

function pathIsEqualOrBelow(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function foldedPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function filesystemIdentityIsEqualOrBelow(
  parent: FilesystemPathIdentity,
  candidate: FilesystemPathIdentity,
): boolean {
  if (parent.caseMode === "sensitive" && candidate.caseMode === "sensitive") {
    return pathIsEqualOrBelow(parent.resolved, candidate.resolved);
  }
  return pathIsEqualOrBelow(foldedPath(parent.resolved), foldedPath(candidate.resolved));
}

/** True when either eventual endpoint owns the other endpoint. */
export function filesystemIdentitiesOverlap(
  left: FilesystemPathIdentity,
  right: FilesystemPathIdentity,
): boolean {
  return filesystemIdentityIsEqualOrBelow(left, right) ||
    filesystemIdentityIsEqualOrBelow(right, left);
}
