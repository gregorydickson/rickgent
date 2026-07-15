import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "fs";
import { basename, isAbsolute, relative, resolve, sep } from "path";

export const TICKET_CONTRACT_SCHEMA_VERSION = "1.0.0" as const;

export type TicketChangeKind = "create" | "modify" | "delete" | "rename";
export type TicketInterfaceDirection = "provides" | "consumes";
export type VerificationCwdClass =
  | "repository_root"
  | "orchestrator_package"
  | "attempt_output";

export interface TicketScopeEntry {
  readonly path: string;
  readonly change_kind: TicketChangeKind;
  readonly directory: boolean;
  readonly from_path?: string;
}

export interface TicketInterface {
  readonly id: string;
  readonly direction: TicketInterfaceDirection;
  readonly path: string;
  readonly owner: string;
  readonly description: string;
}

export interface TicketAcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly interface_ids: readonly string[];
  readonly verification_ids: readonly string[];
}

export interface TicketVerification {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd_class: VerificationCwdClass;
  readonly env_allowlist: readonly string[];
  readonly timeout_ms: number;
  readonly network: "deny";
  readonly writable_outputs: readonly string[];
  readonly expected_exit_codes: readonly number[];
}

export interface TicketBudgets {
  readonly max_attempts: number;
  readonly max_review_cycles: number;
  readonly wall_clock_ms: number;
  readonly remediation_limit: number;
}

export interface TicketContractDraft {
  readonly schema_version: typeof TICKET_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly depends_on: readonly string[];
  readonly scope: readonly TicketScopeEntry[];
  readonly interfaces: readonly TicketInterface[];
  readonly acceptance_criteria: readonly TicketAcceptanceCriterion[];
  readonly verifications: readonly TicketVerification[];
  readonly budgets: TicketBudgets;
}

export interface TicketContract extends TicketContractDraft {
  readonly digest: string;
}

export type TicketContractErrorKind = "input" | "infrastructure";

export class TicketContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: TicketContractErrorKind = "input",
  ) {
    super(`${code}: ${message}`);
    this.name = "TicketContractError";
  }
}

export interface TicketContractNormalizationContext {
  /** Target repository. Omit only for structural admission of frozen fixtures. */
  readonly repositoryRoot?: string;
  /** State roots that declarations must not equal or enter. */
  readonly stateRoots?: readonly string[];
  /** Legitimate dependency IDs not included in candidates (normally completed tickets). */
  readonly knownExternalDependencyIds?: readonly string[];
  /** Contracts which currently own scopes. Candidate overlap with these always fails. */
  readonly activeContracts?: readonly TicketContract[];
  /** Disable baseline feasibility only for schema/fixture checks. Defaults to true. */
  readonly validateFilesystem?: boolean;
}

type JsonObject = Record<string, unknown>;

const TOP_LEVEL_KEYS = [
  "schema_version",
  "id",
  "title",
  "description",
  "depends_on",
  "scope",
  "interfaces",
  "acceptance_criteria",
  "verifications",
  "budgets",
  "digest",
] as const;
const DRAFT_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== "digest");
const TICKET_ID = /^t[0-9]{2,}$/;
const LOCAL_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const EXECUTABLE = /^[A-Za-z0-9._+/-]+$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "cmd", "powershell", "pwsh"]);
const CHANGE_KINDS = new Set<TicketChangeKind>(["create", "modify", "delete", "rename"]);
const CWD_CLASSES = new Set<VerificationCwdClass>([
  "repository_root",
  "orchestrator_package",
  "attempt_output",
]);
const INTERFACE_DIRECTIONS = new Set<TicketInterfaceDirection>(["provides", "consumes"]);

function fail(code: string, message: string): never {
  throw new TicketContractError(code, message);
}

function infrastructure(code: string, message: string): never {
  throw new TicketContractError(code, message, "infrastructure");
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  code: string,
  label: string,
): JsonObject {
  if (!isObject(value)) fail(code, `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("TICKET_SCHEMA_UNKNOWN_FIELD", `${label}.${key} is unknown`);
  }
  for (const key of required) {
    if (!(key in value)) fail(code, `${label}.${key} is required`);
  }
  return value;
}

function nonEmptyString(value: unknown, code: string, label: string, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, code: string, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(code, `${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function unique(values: readonly string[], code: string, label: string): void {
  if (new Set(values).size !== values.length) fail(code, `${label} contains duplicates`);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(code, `${label} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

/** Rickgent Canonical JSON v1. Arrays retain order; object keys sort recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("TICKET_CANONICAL_VALUE_INVALID", "only safe integers are admitted");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("TICKET_CANONICAL_VALUE_INVALID", `unsupported canonical value ${typeof value}`);
}

export function ticketContractDigest(contract: TicketContractDraft | TicketContract | JsonObject): string {
  const payload: JsonObject = { ...contract };
  delete payload.digest;
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}

function canonicalRepoPath(value: unknown, label: string): string {
  const path = nonEmptyString(value, "TICKET_SCOPE_PATH_INVALID", label);
  if (isAbsolute(path) || WINDOWS_ABSOLUTE.test(path)) {
    fail("TICKET_SCOPE_PATH_ABSOLUTE", `${label} must be repository-relative`);
  }
  if (path.includes("\\") || path.includes("\0") || path.includes("//") || path.endsWith("/")) {
    fail("TICKET_SCOPE_PATH_INVALID", `${label} is not canonical POSIX form`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("TICKET_SCOPE_PATH_TRAVERSAL", `${label} contains traversal or an empty segment`);
  }
  if (segments.some((segment) => segment === ".git" || segment === ".rickgent")) {
    fail("TICKET_SCOPE_PATH_RESERVED", `${label} names a reserved Git or state root`);
  }
  return path;
}

interface RepositoryContext {
  readonly root: string;
  readonly stateRoots: readonly string[];
  readonly submodules: readonly string[];
  readonly validateFilesystem: boolean;
}

function isEqualOrBelow(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveNearestExistingPath(absolutePath: string, label: string): {
  resolved: string;
  exists: boolean;
} {
  let cursor = resolve(absolutePath);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, "..");
    if (parent === cursor) infrastructure("TICKET_REPOSITORY_INSPECTION_FAILED", `${label} has no existing parent`);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  let realParent: string;
  try {
    realParent = realpathSync(cursor);
  } catch (error) {
    infrastructure(
      "TICKET_REPOSITORY_INSPECTION_FAILED",
      `${label} cannot resolve its nearest existing parent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const resolved = missing.reduce((current, segment) => resolve(current, segment), realParent);
  return { resolved, exists: missing.length === 0 };
}

function resolveWithNearestExistingParent(root: string, repoPath: string, label: string): {
  resolved: string;
  exists: boolean;
} {
  const lexical = resolve(root, ...repoPath.split("/"));
  if (!isEqualOrBelow(root, lexical)) fail("TICKET_SCOPE_PATH_ESCAPE", `${label} escapes the repository`);

  const endpoint = resolveNearestExistingPath(lexical, label);
  const { resolved } = endpoint;
  if (!isEqualOrBelow(root, resolved)) {
    fail("TICKET_SCOPE_PATH_ESCAPE", `${label} resolves outside the repository`);
  }
  return endpoint;
}

function gitSubmodules(root: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["-C", root, "ls-files", "--stage", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths: string[] = [];
    for (const record of output.split("\0")) {
      if (!record) continue;
      const match = record.match(/^160000 [0-9a-f]+ \d\t(.+)$/);
      if (match?.[1]) paths.push(match[1]);
    }
    return paths.sort();
  } catch (error) {
    infrastructure(
      "TICKET_REPOSITORY_INSPECTION_FAILED",
      `cannot inspect repository gitlinks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function repositoryContext(context: TicketContractNormalizationContext): RepositoryContext | null {
  if (context.repositoryRoot === undefined) return null;
  let root: string;
  try {
    root = realpathSync(context.repositoryRoot);
    if (!statSync(root).isDirectory()) infrastructure("TICKET_REPOSITORY_INSPECTION_FAILED", `${root} is not a directory`);
  } catch (error) {
    if (error instanceof TicketContractError) throw error;
    infrastructure(
      "TICKET_REPOSITORY_INSPECTION_FAILED",
      `cannot resolve repository root: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stateRoots = (context.stateRoots ?? []).map((stateRoot, index) => {
    const absolute = isAbsolute(stateRoot) ? stateRoot : resolve(root, stateRoot);
    try {
      // State may deliberately live beside the target repository. Such a root
      // cannot be named by a repository-relative declaration, but it still
      // needs a canonical identity instead of being misclassified as a path
      // escape during admission.
      return resolveNearestExistingPath(absolute, `stateRoots[${index}]`).resolved;
    } catch (error) {
      if (error instanceof TicketContractError) throw error;
      infrastructure("TICKET_REPOSITORY_INSPECTION_FAILED", `cannot resolve state root ${stateRoot}`);
    }
  });

  return {
    root,
    stateRoots,
    submodules: gitSubmodules(root),
    validateFilesystem: context.validateFilesystem !== false,
  };
}

function inspectPath(path: string, label: string, repository: RepositoryContext | null): {
  exists: boolean;
  directory: boolean | null;
} {
  if (repository === null) return { exists: false, directory: null };
  if (repository.submodules.some((submodule) => path === submodule || path.startsWith(`${submodule}/`))) {
    fail("TICKET_SCOPE_PATH_SUBMODULE", `${label} crosses submodule ${path}`);
  }
  const endpoint = resolveWithNearestExistingParent(repository.root, path, label);
  if (repository.stateRoots.some((stateRoot) => isEqualOrBelow(stateRoot, endpoint.resolved))) {
    fail("TICKET_SCOPE_PATH_RESERVED", `${label} enters a configured state root`);
  }
  if (!endpoint.exists) return { exists: false, directory: null };
  try {
    const stat = lstatSync(resolve(repository.root, ...path.split("/")));
    const resolvedStat = stat.isSymbolicLink() ? statSync(endpoint.resolved) : stat;
    return { exists: true, directory: resolvedStat.isDirectory() };
  } catch (error) {
    infrastructure(
      "TICKET_REPOSITORY_INSPECTION_FAILED",
      `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface OwnedEndpoint {
  readonly path: string;
  readonly directory: boolean;
  readonly label: string;
}

function endpointOverlap(left: OwnedEndpoint, right: OwnedEndpoint): boolean {
  if (left.path === right.path) return true;
  if (left.directory && right.path.startsWith(`${left.path}/`)) return true;
  return right.directory && left.path.startsWith(`${right.path}/`);
}

function parseScope(value: unknown, repository: RepositoryContext | null): {
  scope: TicketScopeEntry[];
  endpoints: OwnedEndpoint[];
} {
  if (!Array.isArray(value) || value.length === 0) fail("TICKET_NO_OP", "scope must not be empty");
  const scope: TicketScopeEntry[] = [];
  const endpoints: OwnedEndpoint[] = [];
  const endpointNames = new Set<string>();

  for (let index = 0; index < value.length; index++) {
    const label = `scope[${index}]`;
    const input = exactObject(
      value[index],
      ["path", "change_kind", "directory", "from_path"],
      ["path", "change_kind", "directory"],
      "TICKET_SCOPE_INVALID",
      label,
    );
    const path = canonicalRepoPath(input.path, `${label}.path`);
    if (typeof input.change_kind !== "string" || !CHANGE_KINDS.has(input.change_kind as TicketChangeKind)) {
      fail("TICKET_SCOPE_INVALID", `${label}.change_kind is invalid`);
    }
    if (typeof input.directory !== "boolean") fail("TICKET_SCOPE_INVALID", `${label}.directory must be boolean`);
    const changeKind = input.change_kind as TicketChangeKind;
    let fromPath: string | undefined;
    if (changeKind === "rename") {
      if (!("from_path" in input)) fail("TICKET_SCOPE_RENAME_INVALID", `${label}.from_path is required`);
      fromPath = canonicalRepoPath(input.from_path, `${label}.from_path`);
      if (fromPath === path) fail("TICKET_SCOPE_RENAME_INVALID", `${label} rename is a no-op`);
    } else if ("from_path" in input) {
      fail("TICKET_SCOPE_RENAME_INVALID", `${label}.from_path is allowed only for rename`);
    }
    if (input.directory === true && (changeKind === "delete" || changeKind === "rename")) {
      fail("TICKET_SCOPE_CHANGE_UNSUPPORTED", `${changeKind} of a directory is unsupported`);
    }

    const candidates = fromPath === undefined ? [path] : [path, fromPath];
    for (const candidate of candidates) {
      if (endpointNames.has(candidate)) fail("TICKET_SCOPE_DUPLICATE", `${candidate} is declared more than once`);
      endpointNames.add(candidate);
    }

    const destination = inspectPath(path, `${label}.path`, repository);
    const source = fromPath === undefined ? null : inspectPath(fromPath, `${label}.from_path`, repository);
    if (repository?.validateFilesystem) {
      if (changeKind === "create" && destination.exists) {
        fail("TICKET_SCOPE_CHANGE_MISMATCH", `${path} already exists and cannot be created`);
      }
      if ((changeKind === "modify" || changeKind === "delete") && !destination.exists) {
        fail("TICKET_SCOPE_CHANGE_MISMATCH", `${path} does not exist for ${changeKind}`);
      }
      if (changeKind === "rename") {
        if (!source?.exists) fail("TICKET_SCOPE_RENAME_INVALID", `${fromPath} does not exist`);
        if (destination.exists) fail("TICKET_SCOPE_RENAME_INVALID", `${path} already exists`);
      }
      const observed = changeKind === "rename" ? source?.directory : destination.directory;
      if (observed !== null && observed !== undefined && observed !== input.directory) {
        fail("TICKET_SCOPE_CHANGE_MISMATCH", `${label}.directory disagrees with the repository`);
      }
    }

    const normalized: TicketScopeEntry = {
      path,
      change_kind: changeKind,
      directory: input.directory,
      ...(fromPath === undefined ? {} : { from_path: fromPath }),
    };
    scope.push(normalized);
    endpoints.push({ path, directory: input.directory, label });
    if (fromPath !== undefined) endpoints.push({ path: fromPath, directory: input.directory, label });
  }

  for (let left = 0; left < endpoints.length; left++) {
    for (let right = left + 1; right < endpoints.length; right++) {
      const a = endpoints[left]!;
      const b = endpoints[right]!;
      if (a.label !== b.label && endpointOverlap(a, b)) {
        fail("TICKET_SCOPE_OVERLAP", `${a.path} overlaps ${b.path} within one ticket`);
      }
    }
  }
  return { scope, endpoints };
}

function parseInterfaces(value: unknown, repository: RepositoryContext | null): {
  interfaces: TicketInterface[];
  ids: Set<string>;
} {
  if (!Array.isArray(value)) fail("TICKET_INTERFACE_INVALID", "interfaces must be an array");
  const interfaces: TicketInterface[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const label = `interfaces[${index}]`;
    const input = exactObject(
      value[index],
      ["id", "direction", "path", "owner", "description"],
      ["id", "direction", "path", "owner", "description"],
      "TICKET_INTERFACE_INVALID",
      label,
    );
    const id = nonEmptyString(input.id, "TICKET_ID_INVALID", `${label}.id`, LOCAL_ID);
    if (ids.has(id)) fail("TICKET_ID_DUPLICATE", `interfaces duplicates ${id}`);
    ids.add(id);
    if (typeof input.direction !== "string" || !INTERFACE_DIRECTIONS.has(input.direction as TicketInterfaceDirection)) {
      fail("TICKET_INTERFACE_INVALID", `${label}.direction is invalid`);
    }
    const path = canonicalRepoPath(input.path, `${label}.path`);
    inspectPath(path, `${label}.path`, repository);
    interfaces.push({
      id,
      direction: input.direction as TicketInterfaceDirection,
      path,
      owner: nonEmptyString(input.owner, "TICKET_INTERFACE_INVALID", `${label}.owner`),
      description: nonEmptyString(input.description, "TICKET_INTERFACE_INVALID", `${label}.description`),
    });
  }
  return { interfaces, ids };
}

function parseVerifications(value: unknown, repository: RepositoryContext | null): {
  verifications: TicketVerification[];
  ids: Set<string>;
} {
  if (!Array.isArray(value) || value.length === 0) {
    fail("TICKET_VERIFICATION_INVALID", "verifications must not be empty");
  }
  const verifications: TicketVerification[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const label = `verifications[${index}]`;
    const input = exactObject(
      value[index],
      [
        "id",
        "executable",
        "args",
        "cwd_class",
        "env_allowlist",
        "timeout_ms",
        "network",
        "writable_outputs",
        "expected_exit_codes",
      ],
      [
        "id",
        "executable",
        "args",
        "cwd_class",
        "env_allowlist",
        "timeout_ms",
        "network",
        "writable_outputs",
        "expected_exit_codes",
      ],
      "TICKET_VERIFICATION_INVALID",
      label,
    );
    const id = nonEmptyString(input.id, "TICKET_ID_INVALID", `${label}.id`, LOCAL_ID);
    if (ids.has(id)) fail("TICKET_ID_DUPLICATE", `verifications duplicates ${id}`);
    ids.add(id);
    const executable = nonEmptyString(
      input.executable,
      "TICKET_VERIFICATION_INVALID",
      `${label}.executable`,
      EXECUTABLE,
    );
    const executableBase = executable.split("/").at(-1)?.toLowerCase() ?? executable.toLowerCase();
    if (SHELL_EXECUTABLES.has(executableBase)) {
      fail("TICKET_VERIFICATION_SHELL_FORBIDDEN", `${label}.executable is a shell`);
    }
    const args = stringArray(input.args, "TICKET_VERIFICATION_INVALID", `${label}.args`);
    if (typeof input.cwd_class !== "string" || !CWD_CLASSES.has(input.cwd_class as VerificationCwdClass)) {
      fail("TICKET_VERIFICATION_CWD_INVALID", `${label}.cwd_class is invalid`);
    }
    const envAllowlist = stringArray(input.env_allowlist, "TICKET_VERIFICATION_ENV_INVALID", `${label}.env_allowlist`);
    unique(envAllowlist, "TICKET_VERIFICATION_ENV_INVALID", `${label}.env_allowlist`);
    if (envAllowlist.some((name) => !ENVIRONMENT_NAME.test(name))) {
      fail("TICKET_VERIFICATION_ENV_INVALID", `${label}.env_allowlist contains an invalid name`);
    }
    const timeout = boundedInteger(
      input.timeout_ms,
      1,
      3_600_000,
      "TICKET_VERIFICATION_TIMEOUT_INVALID",
      `${label}.timeout_ms`,
    );
    if (input.network !== "deny") {
      fail("TICKET_VERIFICATION_NETWORK_FORBIDDEN", `${label}.network must be deny`);
    }
    const outputs = stringArray(
      input.writable_outputs,
      "TICKET_VERIFICATION_OUTPUT_INVALID",
      `${label}.writable_outputs`,
    );
    unique(outputs, "TICKET_VERIFICATION_OUTPUT_INVALID", `${label}.writable_outputs`);
    const normalizedOutputs = outputs.map((output, outputIndex) => {
      const path = canonicalRepoPath(output, `${label}.writable_outputs[${outputIndex}]`);
      inspectPath(path, `${label}.writable_outputs[${outputIndex}]`, repository);
      return path;
    });
    if (!Array.isArray(input.expected_exit_codes) || input.expected_exit_codes.length === 0) {
      fail("TICKET_VERIFICATION_EXIT_INVALID", `${label}.expected_exit_codes must not be empty`);
    }
    const exitCodes = input.expected_exit_codes.map((code, codeIndex) => boundedInteger(
      code,
      0,
      255,
      "TICKET_VERIFICATION_EXIT_INVALID",
      `${label}.expected_exit_codes[${codeIndex}]`,
    ));
    if (new Set(exitCodes).size !== exitCodes.length) {
      fail("TICKET_VERIFICATION_EXIT_INVALID", `${label}.expected_exit_codes contains duplicates`);
    }
    verifications.push({
      id,
      executable,
      args,
      cwd_class: input.cwd_class as VerificationCwdClass,
      env_allowlist: envAllowlist,
      timeout_ms: timeout,
      network: "deny",
      writable_outputs: normalizedOutputs,
      expected_exit_codes: exitCodes,
    });
  }
  return { verifications, ids };
}

function parseAcceptanceCriteria(
  value: unknown,
  interfaceIds: ReadonlySet<string>,
  verificationIds: ReadonlySet<string>,
): TicketAcceptanceCriterion[] {
  if (!Array.isArray(value) || value.length === 0) fail("TICKET_AC_INVALID", "acceptance_criteria must not be empty");
  const criteria: TicketAcceptanceCriterion[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const label = `acceptance_criteria[${index}]`;
    const input = exactObject(
      value[index],
      ["id", "description", "interface_ids", "verification_ids"],
      ["id", "description", "interface_ids", "verification_ids"],
      "TICKET_AC_INVALID",
      label,
    );
    const id = nonEmptyString(input.id, "TICKET_ID_INVALID", `${label}.id`, LOCAL_ID);
    if (ids.has(id)) fail("TICKET_ID_DUPLICATE", `acceptance_criteria duplicates ${id}`);
    ids.add(id);
    const interfaceReferences = stringArray(input.interface_ids, "TICKET_AC_INVALID", `${label}.interface_ids`);
    unique(interfaceReferences, "TICKET_AC_INVALID", `${label}.interface_ids`);
    const verificationReferences = stringArray(input.verification_ids, "TICKET_AC_INVALID", `${label}.verification_ids`);
    if (verificationReferences.length === 0) fail("TICKET_AC_INVALID", `${label}.verification_ids must not be empty`);
    unique(verificationReferences, "TICKET_AC_INVALID", `${label}.verification_ids`);
    for (const reference of interfaceReferences) {
      if (!LOCAL_ID.test(reference)) fail("TICKET_AC_INVALID", `${label}.interface_ids contains an invalid ID`);
      if (!interfaceIds.has(reference)) {
        fail("TICKET_INTERFACE_REFERENCE_UNKNOWN", `${label} references ${reference}`);
      }
    }
    for (const reference of verificationReferences) {
      if (!LOCAL_ID.test(reference)) fail("TICKET_AC_INVALID", `${label}.verification_ids contains an invalid ID`);
      if (!verificationIds.has(reference)) {
        fail("TICKET_VERIFICATION_REFERENCE_UNKNOWN", `${label} references ${reference}`);
      }
    }
    criteria.push({
      id,
      description: nonEmptyString(input.description, "TICKET_AC_INVALID", `${label}.description`),
      interface_ids: interfaceReferences,
      verification_ids: verificationReferences,
    });
  }
  return criteria;
}

function parseBudgets(value: unknown): TicketBudgets {
  const input = exactObject(
    value,
    ["max_attempts", "max_review_cycles", "wall_clock_ms", "remediation_limit"],
    ["max_attempts", "max_review_cycles", "wall_clock_ms", "remediation_limit"],
    "TICKET_BUDGET_INVALID",
    "budgets",
  );
  return {
    max_attempts: boundedInteger(input.max_attempts, 1, 100, "TICKET_BUDGET_INVALID", "budgets.max_attempts"),
    max_review_cycles: boundedInteger(input.max_review_cycles, 0, 100, "TICKET_BUDGET_INVALID", "budgets.max_review_cycles"),
    wall_clock_ms: boundedInteger(input.wall_clock_ms, 1, 86_400_000, "TICKET_BUDGET_INVALID", "budgets.wall_clock_ms"),
    remediation_limit: boundedInteger(input.remediation_limit, 0, 100, "TICKET_BUDGET_INVALID", "budgets.remediation_limit"),
  };
}

interface ParsedContract {
  readonly contract: TicketContract;
  readonly endpoints: readonly OwnedEndpoint[];
}

function parseContract(value: unknown, repository: RepositoryContext | null): ParsedContract {
  const input = exactObject(
    value,
    TOP_LEVEL_KEYS,
    TOP_LEVEL_KEYS,
    "TICKET_SCHEMA_INVALID",
    "contract",
  );
  if (input.schema_version !== TICKET_CONTRACT_SCHEMA_VERSION) {
    fail("TICKET_SCHEMA_VERSION_UNSUPPORTED", `schema_version must be ${TICKET_CONTRACT_SCHEMA_VERSION}`);
  }
  const id = nonEmptyString(input.id, "TICKET_ID_INVALID", "contract.id", TICKET_ID);
  const title = nonEmptyString(input.title, "TICKET_SCHEMA_INVALID", "contract.title");
  const description = nonEmptyString(input.description, "TICKET_SCHEMA_INVALID", "contract.description");
  const dependencies = stringArray(input.depends_on, "TICKET_DEPENDENCY_INVALID", "depends_on");
  unique(dependencies, "TICKET_DEPENDENCY_INVALID", "depends_on");
  if (dependencies.some((dependency) => !TICKET_ID.test(dependency))) {
    fail("TICKET_DEPENDENCY_INVALID", "depends_on contains an invalid ticket ID");
  }
  if (dependencies.includes(id)) fail("TICKET_DEPENDENCY_CYCLE", `${id} depends on itself`);

  const { scope, endpoints } = parseScope(input.scope, repository);
  const { interfaces, ids: interfaceIds } = parseInterfaces(input.interfaces, repository);
  const { verifications, ids: verificationIds } = parseVerifications(input.verifications, repository);
  const acceptanceCriteria = parseAcceptanceCriteria(input.acceptance_criteria, interfaceIds, verificationIds);
  const budgets = parseBudgets(input.budgets);
  const digest = nonEmptyString(input.digest, "TICKET_DIGEST_INVALID", "contract.digest", /^sha256:[0-9a-f]{64}$/);

  const contract: TicketContract = {
    schema_version: TICKET_CONTRACT_SCHEMA_VERSION,
    id,
    title,
    description,
    depends_on: dependencies,
    scope,
    interfaces,
    acceptance_criteria: acceptanceCriteria,
    verifications,
    budgets,
    digest,
  };
  const expected = ticketContractDigest(contract);
  if (digest !== expected) fail("TICKET_DIGEST_MISMATCH", `expected ${expected}`);
  return { contract, endpoints };
}

function detectDependencyCycles(contracts: readonly TicketContract[]): void {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      fail("TICKET_DEPENDENCY_CYCLE", `dependency cycle: ${[...stack.slice(start), id].join(" -> ")}`);
    }
    const contract = byId.get(id);
    if (contract === undefined) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of [...contract.depends_on].sort()) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
}

function dependsTransitively(
  left: string,
  right: string,
  contracts: ReadonlyMap<string, TicketContract>,
): boolean {
  const seen = new Set<string>();
  const pending = [...(contracts.get(left)?.depends_on ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate === right) return true;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    pending.push(...(contracts.get(candidate)?.depends_on ?? []));
  }
  return false;
}

function contractEndpoints(contract: TicketContract): OwnedEndpoint[] {
  return contract.scope.flatMap((entry, index) => [
    { path: entry.path, directory: entry.directory, label: `${contract.id}.scope[${index}]` },
    ...(entry.from_path === undefined
      ? []
      : [{ path: entry.from_path, directory: entry.directory, label: `${contract.id}.scope[${index}].from_path` }]),
  ]);
}

function assertNoOverlap(
  leftId: string,
  left: readonly OwnedEndpoint[],
  rightId: string,
  right: readonly OwnedEndpoint[],
): void {
  for (const leftEndpoint of left) {
    for (const rightEndpoint of right) {
      if (endpointOverlap(leftEndpoint, rightEndpoint)) {
        fail(
          "TICKET_ACTIVE_SCOPE_OVERLAP",
          `${leftId}:${leftEndpoint.path} overlaps ${rightId}:${rightEndpoint.path}`,
        );
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Admit a complete set atomically. Supplied digests are mandatory and never repaired.
 * Candidate overlap is allowed only when a dependency path proves serial ownership.
 */
export function normalizeTicketContracts(
  candidates: readonly unknown[],
  context: TicketContractNormalizationContext = {},
): readonly TicketContract[] {
  if (!Array.isArray(candidates)) fail("TICKET_SCHEMA_INVALID", "contracts must be an array");
  const repository = repositoryContext(context);
  const parsed = candidates.map((candidate) => parseContract(candidate, repository));
  const ids = new Set<string>();
  for (const { contract } of parsed) {
    if (ids.has(contract.id)) fail("TICKET_ID_DUPLICATE", `tickets duplicates ${contract.id}`);
    ids.add(contract.id);
  }

  const known = new Set([...ids, ...(context.knownExternalDependencyIds ?? [])]);
  for (const { contract } of parsed) {
    for (const dependency of contract.depends_on) {
      if (!known.has(dependency)) fail("TICKET_DEPENDENCY_UNKNOWN", `${contract.id} dependency ${dependency} is unknown`);
    }
  }
  detectDependencyCycles(parsed.map(({ contract }) => contract));

  const byId = new Map(parsed.map(({ contract }) => [contract.id, contract]));
  for (let left = 0; left < parsed.length; left++) {
    for (let right = left + 1; right < parsed.length; right++) {
      const a = parsed[left]!;
      const b = parsed[right]!;
      if (
        !dependsTransitively(a.contract.id, b.contract.id, byId) &&
        !dependsTransitively(b.contract.id, a.contract.id, byId)
      ) {
        assertNoOverlap(a.contract.id, a.endpoints, b.contract.id, b.endpoints);
      }
    }
  }
  for (const active of context.activeContracts ?? []) {
    for (const candidate of parsed) {
      if (active.id === candidate.contract.id) {
        fail("TICKET_ID_DUPLICATE", `${active.id} is already active`);
      }
      assertNoOverlap(active.id, contractEndpoints(active), candidate.contract.id, candidate.endpoints);
    }
  }
  return deepFreeze(parsed.map(({ contract }) => contract));
}

/** Trusted construction helper: seal drafts, then admit them through the same strict set normalizer. */
export function sealTicketContracts(
  drafts: readonly unknown[],
  context: TicketContractNormalizationContext = {},
): readonly TicketContract[] {
  if (!Array.isArray(drafts)) fail("TICKET_SCHEMA_INVALID", "contract drafts must be an array");
  const sealed = drafts.map((value, index) => {
    const draft = exactObject(value, DRAFT_KEYS, DRAFT_KEYS, "TICKET_SCHEMA_INVALID", `drafts[${index}]`);
    return { ...draft, digest: ticketContractDigest(draft) };
  });
  return normalizeTicketContracts(sealed, context);
}

export function ticketOwnedPaths(contract: TicketContract): string[] {
  return contract.scope.flatMap((entry) =>
    entry.from_path === undefined ? [entry.path] : [entry.path, entry.from_path],
  );
}
