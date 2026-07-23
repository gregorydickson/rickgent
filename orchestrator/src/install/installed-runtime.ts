import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INSTALLED_RUNTIME_SCHEMA_VERSION = "rickgent-installed-runtime/v1" as const;

export type InstalledRuntimeErrorCode =
  | "INSTALL_INPUT_MISSING"
  | "INSTALL_PATH_NOT_ABSOLUTE"
  | "INSTALL_PATH_MISSING"
  | "INSTALL_PATH_ESCAPE"
  | "INSTALL_CHECKOUT_PATH"
  | "INSTALL_SOURCE_NODE_MODULES"
  | "INSTALL_EDITABLE_METADATA"
  | "INSTALL_RESOURCE_MAP_INVALID"
  | "INSTALL_RESOURCE_HASH_MISMATCH"
  | "INSTALL_PYTHON_AMBIENT";

export class InstalledRuntimeError extends Error {
  constructor(
    readonly code: InstalledRuntimeErrorCode,
    message: string,
    readonly path: string | null = null,
  ) {
    super(message);
    this.name = "InstalledRuntimeError";
  }
}

export interface InstalledResource {
  readonly id: string;
  readonly realpath: string;
  readonly sha256: string;
}

export interface InstalledRuntime {
  readonly schema_version: typeof INSTALLED_RUNTIME_SCHEMA_VERSION;
  readonly package_root: InstalledResource;
  readonly cli: InstalledResource;
  readonly manager: InstalledResource;
  readonly worker: InstalledResource;
  readonly resource_map: InstalledResource;
  readonly proof_metadata: InstalledResource;
  readonly validators_root: InstalledResource;
  readonly omnigent_root: InstalledResource;
  readonly omnigent_python: InstalledResource;
}

export interface ResolveInstalledRuntimeInput {
  readonly packageRoot: string;
  readonly omnigentRoot: string;
  readonly omnigentPython: string;
  /** Test/build authority: every listed ancestry is rejected after realpath. */
  readonly forbiddenCheckoutRoots?: readonly string[];
}

interface ResourceMap {
  readonly schema_version: "rickgent-resource-map/v1";
  readonly resources: Readonly<Record<string, { readonly path: string; readonly sha256?: string }>>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Tree(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new InstalledRuntimeError("INSTALL_PATH_ESCAPE", `symlink is not an immutable resource: ${path}`, path);
      }
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        hash.update(relative(root, path).split(sep).join("/"));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function digest(path: string): string {
  return lstatSync(path).isDirectory() ? sha256Tree(path) : sha256File(path);
}

function canonicalAbsolute(label: string, candidate: string | undefined): string {
  if (candidate === undefined || candidate.trim() === "") {
    throw new InstalledRuntimeError("INSTALL_INPUT_MISSING", `${label} is required`);
  }
  if (!isAbsolute(candidate)) {
    throw new InstalledRuntimeError("INSTALL_PATH_NOT_ABSOLUTE", `${label} must be absolute`, candidate);
  }
  if (!existsSync(candidate)) {
    throw new InstalledRuntimeError("INSTALL_PATH_MISSING", `${label} does not exist`, candidate);
  }
  return realpathSync(candidate);
}

function contained(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function rejectCheckout(path: string, roots: readonly string[]): void {
  for (const root of roots) {
    if (contained(root, path)) {
      throw new InstalledRuntimeError("INSTALL_CHECKOUT_PATH", `installed resource resolves inside checkout: ${path}`, path);
    }
  }
}

function rejectSourceNodeModules(packageRoot: string): void {
  if (basename(dirname(packageRoot)) === "node_modules" && existsSync(join(packageRoot, "src"))) {
    throw new InstalledRuntimeError(
      "INSTALL_SOURCE_NODE_MODULES",
      `package under node_modules contains source tree: ${packageRoot}`,
      packageRoot,
    );
  }
}

function rejectEditableMetadata(python: string): void {
  const executableDir = dirname(python);
  const venvRoot = basename(executableDir) === "bin" ? dirname(executableDir) : executableDir;
  const candidates = [
    join(venvRoot, "lib"),
    join(venvRoot, "Lib", "site-packages"),
  ];
  const stack = candidates.filter(existsSync);
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (name.endsWith(".dist-info")) {
          const direct = join(path, "direct_url.json");
          if (existsSync(direct)) {
            const value = readFileSync(direct, "utf8");
            if (/"editable"\s*:\s*true/.test(value) || /"dir_info"\s*:/.test(value)) {
              throw new InstalledRuntimeError("INSTALL_EDITABLE_METADATA", `editable direct_url metadata: ${direct}`, direct);
            }
          }
        } else {
          stack.push(path);
        }
      } else if (name.endsWith(".pth") || name.endsWith(".egg-link")) {
        throw new InstalledRuntimeError("INSTALL_EDITABLE_METADATA", `editable path metadata: ${path}`, path);
      }
    }
  }
}

function resource(
  packageRoot: string,
  id: string,
  entry: { readonly path: string; readonly sha256?: string } | undefined,
): InstalledResource {
  if (entry === undefined || isAbsolute(entry.path)) {
    throw new InstalledRuntimeError("INSTALL_RESOURCE_MAP_INVALID", `invalid or missing resource-map entry: ${id}`);
  }
  const lexical = resolve(packageRoot, entry.path);
  const real = canonicalAbsolute(id, lexical);
  if (!contained(packageRoot, real)) {
    throw new InstalledRuntimeError("INSTALL_PATH_ESCAPE", `${id} escapes package root`, real);
  }
  const actual = digest(real);
  if (entry.sha256 !== undefined && entry.sha256 !== actual) {
    throw new InstalledRuntimeError("INSTALL_RESOURCE_HASH_MISMATCH", `${id} hash mismatch`, real);
  }
  return Object.freeze({ id, realpath: real, sha256: actual });
}

export function resolveInstalledRuntime(input: ResolveInstalledRuntimeInput): InstalledRuntime {
  const packageRoot = canonicalAbsolute("packageRoot", input.packageRoot);
  const omnigentRoot = canonicalAbsolute("OMNIGENT_ROOT", input.omnigentRoot);
  const omnigentPython = canonicalAbsolute("OMNIGENT_PYTHON", input.omnigentPython);
  const forbidden = (input.forbiddenCheckoutRoots ?? []).map((path) => canonicalAbsolute("forbiddenCheckoutRoot", path));
  rejectCheckout(packageRoot, forbidden);
  rejectCheckout(omnigentRoot, forbidden);
  rejectCheckout(omnigentPython, forbidden);
  rejectSourceNodeModules(packageRoot);
  if (basename(omnigentPython) === "python3" && !omnigentPython.includes(`${sep}bin${sep}`)) {
    throw new InstalledRuntimeError("INSTALL_PYTHON_AMBIENT", "ambient python3 is forbidden; select OMNIGENT_PYTHON", omnigentPython);
  }
  rejectEditableMetadata(omnigentPython);

  const mapPath = canonicalAbsolute("resource map", join(packageRoot, "runtime", "resource-map.json"));
  let map: ResourceMap;
  try {
    map = JSON.parse(readFileSync(mapPath, "utf8")) as ResourceMap;
  } catch {
    throw new InstalledRuntimeError("INSTALL_RESOURCE_MAP_INVALID", "resource map is not valid JSON", mapPath);
  }
  if (map.schema_version !== "rickgent-resource-map/v1" || map.resources === null || typeof map.resources !== "object") {
    throw new InstalledRuntimeError("INSTALL_RESOURCE_MAP_INVALID", "resource map schema is invalid", mapPath);
  }
  const mapResource = Object.freeze({ id: "resource_map", realpath: mapPath, sha256: sha256File(mapPath) });
  return Object.freeze({
    schema_version: INSTALLED_RUNTIME_SCHEMA_VERSION,
    package_root: Object.freeze({ id: "package_root", realpath: packageRoot, sha256: digest(packageRoot) }),
    cli: resource(packageRoot, "cli", map.resources["cli"]),
    manager: resource(packageRoot, "manager", map.resources["manager"]),
    worker: resource(packageRoot, "worker", map.resources["worker"]),
    resource_map: mapResource,
    proof_metadata: resource(packageRoot, "proof_metadata", map.resources["proof_metadata"]),
    validators_root: resource(packageRoot, "validators_root", map.resources["validators_root"]),
    omnigent_root: Object.freeze({ id: "omnigent_root", realpath: omnigentRoot, sha256: digest(omnigentRoot) }),
    omnigent_python: Object.freeze({ id: "omnigent_python", realpath: omnigentPython, sha256: sha256File(omnigentPython) }),
  });
}

export function resolveInstalledRuntimeFromEnvironment(
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  forbiddenCheckoutRoots: readonly string[] = [],
): InstalledRuntime {
  return resolveInstalledRuntime({
    packageRoot,
    omnigentRoot: env["OMNIGENT_ROOT"] ?? "",
    omnigentPython: env["OMNIGENT_PYTHON"] ?? "",
    forbiddenCheckoutRoots,
  });
}
