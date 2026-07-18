import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
  type TicketScopeEntry,
} from "../../src/contracts/ticket-contract.js";
import {
  IdentityContextResolver,
  type ResolvedPhaseContext,
} from "../../src/context/resolver.js";
import {
  provisionAttemptWorkspace,
  snapshotAttemptCaller,
  type ReadyAttemptWorkspace,
} from "../../src/git/attempt-workspace.js";
import {
  CommitService,
  type CommitServiceOptions,
  type CommitServiceRequest,
  type CommitServiceResult,
} from "../../src/git/commit-service.js";
import {
  ProcessSupervisor,
  type ProcessSupervisorResult,
} from "../../src/process/supervisor.js";
import {
  PosixProcessController,
  type ProcessDeathObservation,
} from "../../src/process/posix.js";
import {
  LeaseAuthority,
  type AttemptOwnershipGrant,
} from "../../src/state/leases.js";
import {
  canonicalGitDeltaFromRaw,
  openStateStore,
  type AllocatedAttempt,
  type AllocatedRun,
  type CanonicalGitDelta,
  type StateRecord,
  type StateStore,
} from "../../src/state/store.js";
import { LifecycleRecordAuthority } from "../../src/state/transitions.js";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

interface FileObservation {
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly content: string | null;
}

interface CallerObservation {
  readonly headOid: string;
  readonly symbolicRef: string;
  readonly indexBytesDigest: `sha256:${string}`;
  readonly files: Readonly<Record<string, FileObservation>>;
}

interface CorpusFixture {
  readonly id: string;
  readonly root: string;
  readonly repo: string;
  readonly store: StateStore;
  readonly contract: TicketContract;
  readonly run: AllocatedRun;
  readonly attempt: AllocatedAttempt;
  readonly implement: ResolvedPhaseContext;
  readonly review: ResolvedPhaseContext;
  readonly verification: ResolvedPhaseContext;
  readonly leases: LeaseAuthority;
  readonly ownership: AttemptOwnershipGrant;
  readonly workspace: ReadyAttemptWorkspace;
  readonly process: ProcessSupervisorResult;
  readonly callerBefore: CallerObservation;
}

interface FixtureOptions {
  readonly id: string;
  readonly scope: readonly TicketScopeEntry[];
  readonly baseline: Readonly<Record<string, string | Buffer>>;
  readonly callerDirty?: (repo: string) => void;
  readonly authoritativeProcess?: boolean;
}

interface SuccessCase extends FixtureOptions {
  readonly mutate: (workspace: string) => void;
  readonly poisonAmbientGit?: boolean;
}

interface PreflightRejectionCase extends FixtureOptions {
  readonly mutate: (fixture: CorpusFixture) => void;
  readonly detail: RegExp;
}

const roots = new Set<string>();
const manifestPath = join(import.meta.dirname, "../fixtures/git-attribution/manifest.json");
let fixtureOrdinal = 0;

const successCases: readonly SuccessCase[] = [
  {
    id: "modify-dirty-caller-hostile-git",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    callerDirty: (repo) => {
      writeFileSync(join(repo, "README.md"), "caller-only dirty bytes\n", "utf8");
      writeFileSync(join(repo, "caller-untracked.bin"), Buffer.from([0, 255, 1, 254]));
    },
    mutate: (workspace) => writeFileSync(join(workspace, "src/owned.txt"), "after\n", "utf8"),
    poisonAmbientGit: true,
  },
  {
    id: "binary-untracked-create",
    scope: [{ path: "assets/new.bin", change_kind: "create", directory: false }],
    baseline: { "README.md": "baseline\n" },
    mutate: (workspace) => {
      mkdirSync(join(workspace, "assets"), { recursive: true });
      writeFileSync(join(workspace, "assets/new.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 127, 128]));
    },
  },
  {
    id: "pure-rename-and-delete",
    scope: [
      { path: "src/new-name.txt", from_path: "src/old-name.txt", change_kind: "rename", directory: false },
      { path: "src/remove.txt", change_kind: "delete", directory: false },
    ],
    baseline: {
      "README.md": "baseline\n",
      "src/old-name.txt": "rename me without changing bytes\n",
      "src/remove.txt": "delete me\n",
    },
    mutate: (workspace) => {
      renameSync(join(workspace, "src/old-name.txt"), join(workspace, "src/new-name.txt"));
      unlinkSync(join(workspace, "src/remove.txt"));
    },
  },
];

const preflightRejectionCases: readonly PreflightRejectionCase[] = [
  {
    id: "no-change",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: () => undefined,
    detail: /no attributable change|no change/i,
  },
  {
    id: "foreign-untracked-mixed",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: (fixture) => {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      writeFileSync(join(fixture.workspace.worktreePath, "foreign.txt"), "foreign\n", "utf8");
    },
    detail: /foreign|out-of-contract|untracked/i,
  },
  {
    id: "foreign-ignored-mixed",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { ".gitignore": "*.ignored\n", "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: (fixture) => {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      writeFileSync(join(fixture.workspace.worktreePath, "foreign.ignored"), "foreign\n", "utf8");
    },
    detail: /foreign|ignored|out-of-contract/i,
  },
  {
    id: "wrong-change-kind",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: (fixture) => unlinkSync(join(fixture.workspace.worktreePath, "src/owned.txt")),
    detail: /kind|out-of-contract|scope/i,
  },
  {
    id: "wrong-rename-source",
    scope: [{
      path: "src/destination.txt",
      from_path: "src/source.txt",
      change_kind: "rename",
      directory: false,
    }],
    baseline: {
      "README.md": "baseline\n",
      "src/source.txt": "declared source\n",
      "src/other.txt": "wrong source\n",
    },
    mutate: (fixture) => renameSync(
      join(fixture.workspace.worktreePath, "src/other.txt"),
      join(fixture.workspace.worktreePath, "src/destination.txt"),
    ),
    detail: /rename|source|foreign|out-of-contract|scope/i,
  },
  {
    id: "mode-only",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: (fixture) => chmodSync(join(fixture.workspace.worktreePath, "src/owned.txt"), 0o755),
    detail: /mode|type|100644/i,
  },
  {
    id: "symlink-leaf-escape",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: (fixture) => {
      const outside = join(fixture.root, "outside.txt");
      writeFileSync(outside, "outside\n", "utf8");
      unlinkSync(join(fixture.workspace.worktreePath, "src/owned.txt"));
      symlinkSync(outside, join(fixture.workspace.worktreePath, "src/owned.txt"));
    },
    detail: /symlink|symbolic|type/i,
  },
  {
    id: "symlink-component-escape",
    scope: [{ path: "nested", change_kind: "create", directory: true }],
    baseline: { "README.md": "baseline\n" },
    mutate: (fixture) => {
      const outside = join(fixture.root, "outside-dir");
      mkdirSync(outside);
      symlinkSync(outside, join(fixture.workspace.worktreePath, "nested"));
      writeFileSync(join(outside, "owned.txt"), "escaped\n", "utf8");
    },
    detail: /symlink|component|escape/i,
  },
  {
    id: "default-index-poison",
    scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
    baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    mutate: (fixture) => {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      gitLiteral(fixture.workspace.worktreePath, ["add", "--", "src/owned.txt"]);
    },
    detail: /index|staged|worker/i,
  },
  {
    id: "hostile-filename",
    scope: [{ path: "src/:(glob)*.txt", change_kind: "create", directory: false }],
    baseline: { "README.md": "baseline\n" },
    mutate: (fixture) => {
      mkdirSync(join(fixture.workspace.worktreePath, "src"), { recursive: true });
      writeFileSync(join(fixture.workspace.worktreePath, "src/:(glob)*.txt"), "literal pathspec bytes\n", "utf8");
    },
    detail: /path|pathspec|canonical|unsupported/i,
  },
];

const individuallyExercisedCaseIds = Object.freeze([
  "mode-and-content",
  "submodule-gitlink",
  "isolated-index-poison",
  "one-worker-commit",
  "two-worker-commits",
  "orphan-worker-commit",
  "attempt-ref-moved",
  "exact-candidate-ref-without-cas-proof",
  "delivery-ref-moved-before",
  "delivery-ref-moved-at-finalize-barrier",
  "owner-expires-before-ref-transaction",
  "stale-owner",
  "non-authoritative-process-terminal",
  "hostile-filter",
  "prepare-replay-drift",
  "finalize-replay-drift",
  "caller-embedded-repository",
  "caller-fifo",
] as const);

const individuallyExpectedOutcomes = Object.freeze({
  "mode-and-content": "rejected",
  "submodule-gitlink": "rejected",
  "isolated-index-poison": "rejected",
  "one-worker-commit": "rejected",
  "two-worker-commits": "rejected",
  "orphan-worker-commit": "rejected",
  "attempt-ref-moved": "rejected",
  "exact-candidate-ref-without-cas-proof": "rejected",
  "delivery-ref-moved-before": "rejected",
  "delivery-ref-moved-at-finalize-barrier": "infrastructure_error",
  "owner-expires-before-ref-transaction": "infrastructure_error",
  "stale-owner": "infrastructure_error",
  "non-authoritative-process-terminal": "rejected",
  "hostile-filter": "accepted",
  "prepare-replay-drift": "rejected",
  "finalize-replay-drift": "rejected",
  "caller-embedded-repository": "rejected",
  "caller-fifo": "rejected",
} as const satisfies Readonly<Record<(typeof individuallyExercisedCaseIds)[number], string>>);

const executableCaseExpectations: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...successCases.map((entry) => [entry.id, "accepted"] as const),
  ...preflightRejectionCases.map((entry) => [entry.id, "rejected"] as const),
  ...Object.entries(individuallyExpectedOutcomes),
]));

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key.startsWith("GIT_CONFIG_")) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
}

function git(repo: string, args: readonly string[], options: Partial<ExecFileSyncOptionsWithStringEncoding> = {}): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(),
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  }).trim();
}

function gitLiteral(
  repo: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  input?: string | Buffer,
): string {
  return execFileSync("git", ["--literal-pathspecs", "-C", repo, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(environment),
    maxBuffer: 4 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function query(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all(...values) as SqlRow[];
  } finally {
    database.close();
  }
}

function one(databasePath: string, sql: string, ...values: SqlValue[]): SqlRow {
  const row = query(databasePath, sql, ...values)[0];
  if (row === undefined) throw new Error(`expected one row for query: ${sql}`);
  return row;
}

function updateAttemptState(fixture: CorpusFixture, from: string, to: string): void {
  const database = new DatabaseSync(fixture.store.location.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const result = database.prepare(`
      UPDATE attempts SET state = ?, state_version = state_version + 1
      WHERE attempt_id = ? AND state = ?
    `).run(to, fixture.attempt.attemptId, from);
    if (result.changes !== 1) throw new Error(`failed legal fixture state edge ${from} -> ${to}`);
  } finally {
    database.close();
  }
}

function observeFiles(repo: string): Readonly<Record<string, FileObservation>> {
  const observations: Record<string, FileObservation> = {};
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      if (path === repo && name === ".git") continue;
      const absolute = join(path, name);
      const repositoryPath = relative(repo, absolute).replaceAll("\\", "/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        observations[repositoryPath] = {
          kind: "symlink",
          mode: stat.mode & 0o7777,
          content: readlinkSync(absolute),
        };
      } else if (stat.isDirectory()) {
        observations[repositoryPath] = {
          kind: "directory",
          mode: stat.mode & 0o7777,
          content: null,
        };
        visit(absolute);
      } else {
        observations[repositoryPath] = {
          kind: "file",
          mode: stat.mode & 0o7777,
          content: sha256(readFileSync(absolute)),
        };
      }
    }
  };
  visit(repo);
  return Object.freeze(observations);
}

function observeCaller(repo: string): CallerObservation {
  const gitDirectory = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const symbolicRef = git(repo, ["symbolic-ref", "-q", "HEAD"]);
  return Object.freeze({
    headOid: git(repo, ["rev-parse", "HEAD"]),
    symbolicRef,
    indexBytesDigest: sha256(readFileSync(join(gitDirectory, "index"))),
    files: observeFiles(repo),
  });
}

function callerBoundaryRepository(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo], { env: cleanGitEnvironment() });
  git(repo, ["config", "user.name", "Commit Attribution Corpus"]);
  git(repo, ["config", "user.email", "commit-attribution@example.test"]);
  writeFileSync(join(repo, "README.md"), "baseline\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-qm", "baseline"]);
  return repo;
}

function ticketDraft(scope: readonly TicketScopeEntry[]): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t20",
    title: "Commit attribution corpus",
    description: "Exercise the filter-free owner-bound Git attribution authority.",
    depends_on: [],
    scope,
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-COMMIT-ATTRIBUTION",
      description: "Only the exact reviewed and verified scoped delta can become an attributed commit.",
      interface_ids: [],
      verification_ids: ["VER-COMMIT-ATTRIBUTION"],
    }],
    verifications: [{
      id: "VER-COMMIT-ATTRIBUTION",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 2,
      wall_clock_ms: 120_000,
      remediation_limit: 1,
    },
  };
}

function phaseContext(
  fixture: Pick<CorpusFixture, "store" | "attempt" | "contract">,
  workspacePath: string,
  phase: "review" | "verification",
  role: "reviewer" | "verifier",
  ordinal: number,
): ResolvedPhaseContext {
  const policyRoot = join(fixture.store.location.resourceDirectory, `policy-${phase}`);
  const bundleDir = join(policyRoot, "bundle");
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  return new IdentityContextResolver(fixture.store).resolvePhaseContext({
    attempt: fixture.attempt,
    contract: fixture.contract,
    phase,
    phaseOrdinal: ordinal,
    role,
    worktreeRealpath: workspacePath,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir,
      requestedBundleSha256: phase === "review" ? "b".repeat(64) : "c".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: 30_000,
  });
}

/**
 * The corpus does not pretend sampled PID polling proves descendant death. It
 * uses a real child and real wait, then models the authoritative containment
 * primitive t19 exposes to production supervisors on a supported platform.
 */
class AuthoritativeContainmentController extends PosixProcessController {
  override async waitForDeath(pgid: number, timeoutMs: number): Promise<ProcessDeathObservation> {
    const observed = await super.waitForDeath(pgid, timeoutMs);
    return Object.freeze({
      ...observed,
      groupDead: true,
      proofBasis: "authoritative_containment",
      trackedIdentitiesConfirmedDead: true,
      descendantsConfirmedDead: true,
      reason: "test containment authority observed the real exited process group and complete descendant set",
    });
  }
}

async function makeFixture(options: FixtureOptions): Promise<CorpusFixture> {
  const ordinal = ++fixtureOrdinal;
  const id = `${options.id}-${ordinal}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-git-attribution-")));
  roots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { mode: 0o700 });
  execFileSync("git", ["init", "-q", repo], { env: cleanGitEnvironment() });
  git(repo, ["config", "user.name", "Commit Attribution Corpus"]);
  git(repo, ["config", "user.email", "commit-attribution@example.test"]);
  git(repo, ["config", "core.filemode", "true"]);
  for (const [path, contents] of Object.entries(options.baseline)) {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, contents);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "baseline"]);

  const store = openStateStore({ repoPath: repo });
  const contract = sealTicketContracts([ticketDraft(options.scope)], { repositoryRoot: repo })[0]!;
  const resolver = new IdentityContextResolver(store);
  const run = resolver.allocateFreshRun({
    contracts: [contract],
    initialDeliveryOid: git(repo, ["rev-parse", "HEAD"]),
    oracleVersion: "rickgent.oracle.v2",
  });
  const attempt = resolver.allocateInitialAttempt({ runId: run.runId, ticketId: contract.id });
  const policyRoot = join(store.location.resourceDirectory, "policy-implement");
  const bundleDir = join(policyRoot, "bundle");
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const implement = resolver.resolvePhaseContext({
    attempt,
    contract,
    phase: "implement",
    phaseOrdinal: 0,
    role: "worker",
    worktreeRealpath: repo,
    policyBundle: {
      kind: "materialized_authenticated_policy_bundle",
      policyRoot,
      bundleDir,
      requestedBundleSha256: "a".repeat(64),
    },
    modelSelection: { harness: "codex", model: "gpt-5", vendor: "openai" },
    timeoutMs: 30_000,
  });

  const database = new DatabaseSync(store.location.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const runUpdate = database.prepare(
      "UPDATE runs SET state = 'active', state_version = state_version + 1 WHERE run_id = ? AND state = 'planned'",
    ).run(run.runId);
    const ticketUpdate = database.prepare(
      "UPDATE run_tickets SET state = 'active', state_version = state_version + 1 WHERE ticket_instance_id = ? AND state = 'planned'",
    ).run(attempt.ticketInstanceId);
    if (runUpdate.changes !== 1 || ticketUpdate.changes !== 1) throw new Error("fixture lineage activation failed");
  } finally {
    database.close();
  }

  options.callerDirty?.(repo);
  const callerBefore = observeCaller(repo);
  const leases = new LeaseAuthority(store);
  const acquired = leases.acquire(leases.prepareAcquisition({
    attemptId: attempt.attemptId,
    idempotencyKey: `git-attribution-acquire:${id}`,
    ttlMs: 120_000,
  }));
  const provisioned = provisionAttemptWorkspace(leases, acquired);
  if (!provisioned.ok) throw new Error(`${provisioned.code}: ${provisioned.detail}`);
  const workspace = provisioned.workspace;
  // t20 consumes the real attempt workspace as Git authority, while the
  // released execution-context identity remains repository-rooted until t22.
  const review = phaseContext({ store, attempt, contract }, repo, "review", "reviewer", 1);
  const verification = phaseContext({ store, attempt, contract }, repo, "verification", "verifier", 2);
  const supervisor = new ProcessSupervisor(
    store,
    leases,
    options.authoritativeProcess === false ? new PosixProcessController() : new AuthoritativeContainmentController(),
  );
  const processResult = await supervisor.run({
    ownership: workspace.ownership,
    authorization: provisioned.authorization,
    phase: {
      phaseExecutionId: implement.persisted.phaseExecutionId,
      contextId: implement.persisted.contextId,
      contextDigest: implement.canonical.contextDigest,
    },
    argv: [process.execPath, "-e", "process.exit(0)"],
    environment: {},
    allowedEnvironmentKeys: [],
    timeoutMs: 5_000,
    terminationGraceMs: 100,
    deathObservationMs: 1_000,
    outputLimitBytes: 8_192,
    tailLimitBytes: 1_024,
  });

  const fixture: CorpusFixture = {
    id,
    root,
    repo: realpathSync(repo),
    store,
    contract,
    run,
    attempt,
    implement,
    review,
    verification,
    leases,
    ownership: processResult.ownership,
    workspace,
    process: processResult,
    callerBefore,
  };
  if (options.authoritativeProcess !== false) {
    expect(processResult).toMatchObject({
      outcome: "exit_zero",
      exitCode: 0,
      groupDead: true,
      descendantsConfirmedDead: true,
    });
    expect(one(store.location.databasePath, `
      SELECT t.outcome, t.group_dead, t.descendants_confirmed_dead, o.inline_payload_json
      FROM attempt_process_terminal_receipts t
      JOIN attempt_process_observations p ON p.launch_id = t.launch_id AND p.kind = 'group_death'
      JOIN evidence o ON o.evidence_id = p.evidence_id
      WHERE t.process_receipt_id = ?
    `, processResult.processReceiptId)).toMatchObject({
      outcome: "exit_zero",
      group_dead: 1,
      descendants_confirmed_dead: 1,
    });
  }
  return fixture;
}

function readTreeEntry(repo: string, baselineOid: string, path: string): { mode: string; oid: string } {
  const line = gitLiteral(repo, ["ls-tree", baselineOid, "--", path]);
  const match = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(line);
  if (match === null) throw new Error(`baseline blob is absent for ${path}`);
  return { mode: match[1]!, oid: match[2]! };
}

/** Independently reconstruct the expected tree without invoking Git filters or production staging code. */
function expectedCandidate(fixture: CorpusFixture): { readonly treeOid: string; readonly delta: CanonicalGitDelta } {
  const index = join(fixture.root, `expected-${fixture.id}.index`);
  const environment = { GIT_INDEX_FILE: index };
  gitLiteral(fixture.workspace.worktreePath, ["read-tree", fixture.attempt.deliveryBaselineOid], environment);
  for (const entry of fixture.contract.scope) {
    if (entry.change_kind === "delete") {
      gitLiteral(fixture.workspace.worktreePath, ["update-index", "--force-remove", "--", entry.path], environment);
      continue;
    }
    if (entry.change_kind === "rename") {
      if (entry.from_path === undefined) throw new Error("rename fixture has no source");
      const source = readTreeEntry(fixture.repo, fixture.attempt.deliveryBaselineOid, entry.from_path);
      const oid = gitLiteral(fixture.workspace.worktreePath, ["hash-object", "-w", "--no-filters", "--", entry.path]);
      gitLiteral(fixture.workspace.worktreePath, [
        "update-index", "--force-remove", "--", entry.from_path,
      ], environment);
      gitLiteral(fixture.workspace.worktreePath, [
        "update-index", "--add", "--cacheinfo", source.mode, oid, entry.path,
      ], environment);
      continue;
    }
    const mode = entry.change_kind === "create"
      ? "100644"
      : readTreeEntry(fixture.repo, fixture.attempt.deliveryBaselineOid, entry.path).mode;
    const oid = gitLiteral(fixture.workspace.worktreePath, ["hash-object", "-w", "--no-filters", "--", entry.path]);
    gitLiteral(fixture.workspace.worktreePath, [
      "update-index", "--add", "--cacheinfo", mode, oid, entry.path,
    ], environment);
  }
  const treeOid = gitLiteral(fixture.workspace.worktreePath, ["write-tree"], environment);
  const raw = execFileSync("git", [
    "--literal-pathspecs", "-C", fixture.repo, "diff", "--raw", "-z", "--no-abbrev", "-M",
    fixture.attempt.deliveryBaselineOid, treeOid,
  ], { encoding: "utf8", env: cleanGitEnvironment() });
  return { treeOid, delta: canonicalGitDeltaFromRaw(raw) };
}

function unattachedCommit(fixture: CorpusFixture, label: string): string {
  const tree = git(fixture.repo, ["rev-parse", `${fixture.attempt.deliveryBaselineOid}^{tree}`]);
  return gitLiteral(fixture.repo, [
    "commit-tree", tree, "-p", fixture.attempt.deliveryBaselineOid,
  ], {
    GIT_AUTHOR_NAME: "Corpus Foreign Authority",
    GIT_AUTHOR_EMAIL: "foreign@example.test",
    GIT_AUTHOR_DATE: "2026-07-17T12:00:00Z",
    GIT_COMMITTER_NAME: "Corpus Foreign Authority",
    GIT_COMMITTER_EMAIL: "foreign@example.test",
    GIT_COMMITTER_DATE: "2026-07-17T12:00:00Z",
  }, `${label}\n`);
}

function appendEvidence(
  fixture: CorpusFixture,
  phase: ResolvedPhaseContext,
  producerService: string,
  schemaVersion: string,
  scope: string,
  payload: Readonly<Record<string, unknown>>,
  suffix: string,
): StateRecord {
  const text = canonicalJson(payload);
  return fixture.store.appendEvidence({
    evidence_id: `evidence-${suffix}-${fixture.id}`,
    attempt_id: fixture.attempt.attemptId,
    phase_execution_id: phase.persisted.phaseExecutionId,
    context_id: phase.persisted.contextId,
    producer_service: producerService,
    scope,
    schema_version: schemaVersion,
    content_digest: sha256(text),
    inline_payload_json: text,
    external_path: null,
    external_digest: null,
    external_size: null,
    idempotency_key: `evidence:${suffix}:${fixture.id}`,
    created_at: new Date().toISOString(),
  });
}

function sealReviewAndVerification(
  fixture: CorpusFixture,
  candidate: { readonly treeOid: string; readonly delta: CanonicalGitDelta },
): readonly string[] {
  updateAttemptState(fixture, "planned", "implementing");
  updateAttemptState(fixture, "implementing", "implementation_captured");
  updateAttemptState(fixture, "implementation_captured", "reviewing");
  const records = new LifecycleRecordAuthority(fixture.store);
  const reviewRecordId = `review-${fixture.id}`;
  const reviewPayload = {
    attempt_id: fixture.attempt.attemptId,
    cycle: 1,
    verdict: "accepted",
    input_tree_oid: candidate.treeOid,
    input_diff_digest: candidate.delta.candidateDiffDigest,
  };
  const verdict = appendEvidence(
    fixture,
    fixture.review,
    "ReviewService",
    "rickgent.review-verdict.v1",
    reviewRecordId,
    reviewPayload,
    "review-verdict",
  );
  const findings = appendEvidence(
    fixture,
    fixture.review,
    "ReviewService",
    "rickgent.review-findings.v1",
    reviewRecordId,
    { attempt_id: fixture.attempt.attemptId, cycle: 1, verdict: "accepted", findings: [] },
    "review-findings",
  );
  records.recordReview({
    reviewRecordId,
    attemptId: fixture.attempt.attemptId,
    cycle: 1,
    reviewerContextId: fixture.review.persisted.contextId,
    ownerContextDigest: fixture.review.canonical.contextDigest,
    verdict: "accepted",
    verdictEvidenceId: String(verdict.evidence_id),
    findingsEvidenceId: String(findings.evidence_id),
    inputTreeOid: candidate.treeOid,
    inputDiffDigest: candidate.delta.candidateDiffDigest,
    createdAt: new Date().toISOString(),
  });

  updateAttemptState(fixture, "reviewing", "verification_queued");
  updateAttemptState(fixture, "verification_queued", "verifying");
  const gateResultId = `gate-${fixture.id}`;
  const gatePayload = {
    gate_id: "VER-COMMIT-ATTRIBUTION",
    evaluation_ordinal: 0,
    required: true,
    status: "passed",
    candidate_tree_oid: candidate.treeOid,
    candidate_diff_digest: candidate.delta.candidateDiffDigest,
  };
  const gate = appendEvidence(
    fixture,
    fixture.verification,
    "VerificationService",
    "rickgent.gate-result.v1",
    gateResultId,
    gatePayload,
    "gate-result",
  );
  const gateRecord = records.recordGateResult({
    gateResultId,
    attemptId: fixture.attempt.attemptId,
    gateId: "VER-COMMIT-ATTRIBUTION",
    evaluationOrdinal: 0,
    status: "passed",
    required: true,
    contextId: fixture.verification.persisted.contextId,
    ownerContextDigest: fixture.verification.canonical.contextDigest,
    contractDigest: fixture.contract.digest,
    evidenceId: String(gate.evidence_id),
    candidateTreeOid: candidate.treeOid,
    candidateDiffDigest: candidate.delta.candidateDiffDigest,
    createdAt: new Date().toISOString(),
  });
  updateAttemptState(fixture, "verifying", "converging");
  fixture.leases.assertFresh(fixture.ownership);
  return Object.freeze([String(verdict.content_digest), String(gateRecord.result_digest)]);
}

function assertCallerUnchanged(fixture: CorpusFixture): void {
  expect(observeCaller(fixture.repo)).toEqual(fixture.callerBefore);
  expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.attempt.deliveryBaselineOid);
}

function assertNoFinalAttribution(fixture: CorpusFixture): void {
  expect(query(
    fixture.store.location.databasePath,
    "SELECT commit_attribution_id FROM commit_attributions WHERE attempt_id = ?",
    fixture.attempt.attemptId,
  )).toEqual([]);
  expect(query(
    fixture.store.location.databasePath,
    "SELECT evidence_id FROM evidence WHERE attempt_id = ? AND producer_service = 'CommitService' AND schema_version = 'rickgent.commit-attribution.v2'",
    fixture.attempt.attemptId,
  )).toEqual([]);
  expect(query(
    fixture.store.location.databasePath,
    "SELECT commit_intent_id FROM attempt_commit_intents WHERE attempt_id = ? AND state = 'finalized'",
    fixture.attempt.attemptId,
  )).toEqual([]);
}

function commitRequest(fixture: CorpusFixture, suffix = "primary"): CommitServiceRequest {
  if (fixture.process.launchId === null || fixture.process.processReceiptId === null) {
    throw new Error("fixture has no durable process identity");
  }
  return {
    ownership: fixture.ownership,
    workspace: fixture.workspace,
    phase: {
      phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
      contextId: fixture.implement.persisted.contextId,
      contextDigest: fixture.implement.canonical.contextDigest,
    },
    launchId: fixture.process.launchId,
    processReceiptId: fixture.process.processReceiptId,
    contract: fixture.contract,
    idempotencyKey: `commit:${suffix}:${fixture.id}`,
  };
}

function runCommit(
  fixture: CorpusFixture,
  options: CommitServiceOptions = {},
  suffix = "primary",
): CommitServiceResult {
  return new CommitService(fixture.store, fixture.leases, options).run(commitRequest(fixture, suffix));
}

function expectExecutableCaseOutcome(
  fixture: CorpusFixture,
  result: CommitServiceResult,
  fallback: "accepted" | "rejected" | "infrastructure_error",
): void {
  const caseId = fixture.id.replace(/-\d+$/, "");
  const registered = executableCaseExpectations[caseId];
  if (registered !== undefined) expect(fallback, `registry mismatch for ${caseId}`).toBe(registered);
  expect(result.outcome, result.detail).toBe(registered ?? fallback);
}

function expectExecutableCaseRejection(caseId: string, operation: () => unknown, detail: RegExp): void {
  expect(executableCaseExpectations[caseId], `missing rejection registry for ${caseId}`).toBe("rejected");
  expect(operation).toThrow(detail);
}

function assertDigest(value: unknown): void {
  expect(value).toMatch(/^sha256:[0-9a-f]{64}$/);
}

function assertAccepted(
  fixture: CorpusFixture,
  candidate: { readonly treeOid: string; readonly delta: CanonicalGitDelta },
  result: CommitServiceResult,
): void {
  expectExecutableCaseOutcome(fixture, result, "accepted");
  expect(result).toMatchObject({
    outcome: "accepted",
    baselineOid: fixture.attempt.deliveryBaselineOid,
    treeOid: candidate.treeOid,
    normalizedDelta: candidate.delta.entries,
  });
  expect(result.commitIntentId).not.toBeNull();
  expect(result.commitAttributionId).not.toBeNull();
  expect(result.attributionEvidenceId).not.toBeNull();
  expect(result.commitOid).not.toBeNull();
  expect(result.commandReceipts.length).toBeGreaterThan(0);
  if (
    result.commitIntentId === null || result.commitAttributionId === null ||
    result.attributionEvidenceId === null || result.commitOid === null
  ) throw new Error("accepted result omitted its durable identities");

  const intent = one(
    fixture.store.location.databasePath,
    "SELECT * FROM attempt_commit_intents WHERE commit_intent_id = ?",
    result.commitIntentId,
  );
  expect(intent).toMatchObject({
    attempt_id: fixture.attempt.attemptId,
    ownership_id: fixture.ownership.ownership.ownershipId,
    owner_generation: fixture.ownership.ownership.generation,
    ownership_context_digest: fixture.ownership.ownership.contextDigest,
    phase_execution_id: fixture.implement.persisted.phaseExecutionId,
    context_id: fixture.implement.persisted.contextId,
    execution_context_digest: fixture.implement.canonical.contextDigest,
    launch_id: fixture.process.launchId,
    process_receipt_id: fixture.process.processReceiptId,
    baseline_oid: fixture.attempt.deliveryBaselineOid,
    tree_after_oid: candidate.treeOid,
    candidate_diff_digest: candidate.delta.candidateDiffDigest,
    path_set_digest: candidate.delta.pathSetDigest,
    change_kind_set_digest: candidate.delta.changeKindSetDigest,
    mode_set_digest: candidate.delta.modeSetDigest,
    state: "finalized",
    state_version: 1,
    commit_attribution_id: result.commitAttributionId,
    commit_oid: result.commitOid,
    delivery_ref_observed_oid: fixture.attempt.deliveryBaselineOid,
    attempt_ref_before_oid: fixture.attempt.deliveryBaselineOid,
    attempt_ref_after_oid: result.commitOid,
  });
  expect(JSON.parse(String(intent.normalized_delta_json))).toEqual(candidate.delta.entries);
  const verificationDigests = JSON.parse(String(intent.verification_receipt_digests_json)) as unknown[];
  expect(verificationDigests.length).toBeGreaterThanOrEqual(2);
  for (const digest of verificationDigests) assertDigest(digest);
  assertDigest(intent.input_digest);
  assertDigest(intent.result_digest);

  const attribution = one(
    fixture.store.location.databasePath,
    "SELECT * FROM commit_attributions WHERE commit_attribution_id = ?",
    result.commitAttributionId,
  );
  expect(attribution).toMatchObject({
    attempt_id: fixture.attempt.attemptId,
    baseline_oid: fixture.attempt.deliveryBaselineOid,
    parent_oid: fixture.attempt.deliveryBaselineOid,
    tree_after_oid: candidate.treeOid,
    commit_oid: result.commitOid,
    contract_digest: fixture.contract.digest,
    context_digest: fixture.implement.canonical.contextDigest,
    path_set_digest: candidate.delta.pathSetDigest,
    change_kind_set_digest: candidate.delta.changeKindSetDigest,
    mode_set_digest: candidate.delta.modeSetDigest,
    attribution_evidence_id: result.attributionEvidenceId,
  });
  const evidence = one(
    fixture.store.location.databasePath,
    "SELECT * FROM evidence WHERE evidence_id = ?",
    result.attributionEvidenceId,
  );
  expect(evidence).toMatchObject({
    attempt_id: fixture.attempt.attemptId,
    phase_execution_id: fixture.implement.persisted.phaseExecutionId,
    context_id: fixture.implement.persisted.contextId,
    producer_service: "CommitService",
    scope: result.commitAttributionId,
    schema_version: "rickgent.commit-attribution.v2",
    idempotency_key: result.commitIntentId,
  });
  expect(sha256(String(evidence.inline_payload_json))).toBe(evidence.content_digest);
  const payload = JSON.parse(String(evidence.inline_payload_json)) as Record<string, unknown>;
  expect(payload).toMatchObject({
    schema_version: "rickgent.commit-attribution.v2",
    commit_intent_id: result.commitIntentId,
    commit_attribution_id: result.commitAttributionId,
    attempt_id: fixture.attempt.attemptId,
    ownership_id: fixture.ownership.ownership.ownershipId,
    owner_generation: fixture.ownership.ownership.generation,
    ownership_context_digest: fixture.ownership.ownership.contextDigest,
    phase_execution_id: fixture.implement.persisted.phaseExecutionId,
    context_id: fixture.implement.persisted.contextId,
    execution_context_digest: fixture.implement.canonical.contextDigest,
    launch_id: fixture.process.launchId,
    process_receipt_id: fixture.process.processReceiptId,
    contract_digest: fixture.contract.digest,
    baseline_oid: fixture.attempt.deliveryBaselineOid,
    parent_oid: fixture.attempt.deliveryBaselineOid,
    tree_after_oid: candidate.treeOid,
    commit_oid: result.commitOid,
    candidate_diff_digest: candidate.delta.candidateDiffDigest,
    path_set_digest: candidate.delta.pathSetDigest,
    change_kind_set_digest: candidate.delta.changeKindSetDigest,
    mode_set_digest: candidate.delta.modeSetDigest,
    normalized_delta: candidate.delta.entries,
  });
  const ancestry = git(fixture.repo, ["rev-list", "--parents", "-n", "1", result.commitOid]).split(" ");
  expect(ancestry).toEqual([result.commitOid, fixture.attempt.deliveryBaselineOid]);
  expect(git(fixture.repo, ["rev-parse", `${result.commitOid}^{tree}`])).toBe(candidate.treeOid);
  expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(result.commitOid);
  expect(git(fixture.repo, ["rev-parse", fixture.run.deliveryRef])).toBe(fixture.attempt.deliveryBaselineOid);
  for (const receipt of result.commandReceipts) {
    expect(receipt.executable).toBe("/usr/bin/git");
    expect(receipt.status).toBe(0);
    expect(receipt.inputBytes).toBeGreaterThanOrEqual(0);
    expect(receipt.stdoutBytes).toBeGreaterThanOrEqual(0);
    expect(receipt.stderrBytes).toBeGreaterThanOrEqual(0);
    assertDigest(receipt.argvDigest);
    assertDigest(receipt.inputDigest);
    assertDigest(receipt.stdoutDigest);
    assertDigest(receipt.stderrDigest);
  }
  assertCallerUnchanged(fixture);
}

function assertContainedRejection(
  fixture: CorpusFixture,
  result: CommitServiceResult,
  detail: RegExp,
  expectedAttemptRef = fixture.attempt.deliveryBaselineOid,
  expectedDeliveryRef = fixture.attempt.deliveryBaselineOid,
  expectedAttemptHead = fixture.attempt.deliveryBaselineOid,
  expectedOutcome: "rejected" | "infrastructure_error" = "rejected",
): void {
  expectExecutableCaseOutcome(fixture, result, expectedOutcome);
  expect(result.detail).toMatch(detail);
  expect(result.commitAttributionId).toBeNull();
  expect(result.attributionEvidenceId).toBeNull();
  expect(result.commitOid).toBeNull();
  expect(result.ownership.ownership.state).toBe("cleanup_pending");
  expect(result.ownership.resources.every((resource) => resource.state === "cleanup_pending")).toBe(true);
  expect(query(
    fixture.store.location.databasePath,
    "SELECT state FROM attempt_ownership_leases WHERE attempt_id = ?",
    fixture.attempt.attemptId,
  )).toEqual([{ state: "cleanup_pending" }]);
  expect(query(
    fixture.store.location.databasePath,
    "SELECT DISTINCT state FROM attempt_resource_claims WHERE attempt_id = ?",
    fixture.attempt.attemptId,
  )).toEqual([{ state: "cleanup_pending" }]);
  assertNoFinalAttribution(fixture);
  expect(git(fixture.repo, ["rev-parse", fixture.run.deliveryRef])).toBe(expectedDeliveryRef);
  expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(expectedAttemptRef);
  expect(git(fixture.workspace.worktreePath, ["rev-parse", "HEAD"])).toBe(expectedAttemptHead);
  expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.attempt.deliveryBaselineOid);
  assertCallerUnchanged(fixture);
}

describe("orchestrator-owned Git attribution adversarial corpus", () => {
  it("keeps the proof manifest bounded, unique, and explicit about every required adversarial family", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schema_version: string;
      receipt_schema_version: string;
      required_success_observations: string[];
      required_rejection_observations: string[];
      cases: Array<{ id: string; family: string; expected: string }>;
    };
    expect(manifest.schema_version).toBe("rickgent.git-attribution-corpus/v1");
    expect(manifest.receipt_schema_version).toBe("rickgent.commit-attribution.v2");
    expect(new Set(manifest.cases.map((entry) => entry.id)).size).toBe(manifest.cases.length);
    expect(manifest.cases).toHaveLength(31);
    expect(manifest.cases.map((entry) => entry.id).sort()).toEqual([
      ...successCases.map((entry) => entry.id),
      ...preflightRejectionCases.map((entry) => entry.id),
      ...individuallyExercisedCaseIds,
    ].sort());
    expect(Object.fromEntries(manifest.cases.map((entry) => [entry.id, entry.expected]))).toEqual(executableCaseExpectations);
    expect(new Set(manifest.cases.map((entry) => entry.family))).toEqual(new Set([
      "success", "delta", "scope", "mode", "symlink", "gitlink", "index", "lineage", "ref",
      "ownership", "process", "path", "git-config", "replay", "caller",
    ]));
    expect(manifest.required_success_observations).toContain("exact_replay_is_side_effect_free");
    expect(manifest.required_rejection_observations).toContain("cleanup_ownership_retained");
  });

  it("rejects an embedded repository that cannot be snapshotted byte-for-byte", () => {
    const repo = callerBoundaryRepository("rickgent-caller-embedded-repo-");
    const embedded = join(repo, "nested");
    mkdirSync(embedded);
    execFileSync("git", ["init", "-q", embedded], { env: cleanGitEnvironment() });
    writeFileSync(join(embedded, "payload"), "untracked embedded bytes\n", "utf8");

    expectExecutableCaseRejection(
      "caller-embedded-repository",
      () => snapshotAttemptCaller(repo),
      /embedded Git repository|unsupported non-file entry/i,
    );
  });

  it("rejects a caller FIFO that Git path enumeration omits", () => {
    const repo = callerBoundaryRepository("rickgent-caller-fifo-");
    execFileSync("/usr/bin/mkfifo", [join(repo, "pipe")]);
    expectExecutableCaseRejection("caller-fifo", () => snapshotAttemptCaller(repo), /unsupported non-file entry/i);
  });

  it("uses real repository, ownership, workspace, and explicitly authoritative process truth", async () => {
    const fixture = await makeFixture({
      id: "authority-smoke",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "caller baseline\n", "src/owned.txt": "before\n" },
      callerDirty: (repo) => writeFileSync(join(repo, "caller-untracked.bin"), Buffer.from([0, 1, 2, 255])),
    });
    try {
      expect(realpathSync(fixture.workspace.worktreePath)).not.toBe(fixture.repo);
      expect(fixture.workspace.ownership.ownership.ownershipId).toBe(fixture.ownership.ownership.ownershipId);
      expect(query(fixture.store.location.databasePath, `
        SELECT outcome, group_dead, descendants_confirmed_dead
        FROM attempt_process_terminal_receipts WHERE process_receipt_id = ?
      `, fixture.process.processReceiptId)).toEqual([{
        outcome: "exit_zero",
        group_dead: 1,
        descendants_confirmed_dead: 1,
      }]);
      expect(JSON.parse(String(one(fixture.store.location.databasePath, `
        SELECT e.inline_payload_json FROM attempt_process_observations o
        JOIN evidence e ON e.evidence_id = o.evidence_id
        WHERE o.launch_id = ? AND o.kind = 'group_death'
      `, fixture.process.launchId).inline_payload_json))).toMatchObject({
        proof_basis: "authoritative_containment",
        tracked_identities_confirmed_dead: true,
        descendants_confirmed_dead: true,
      });
      assertCallerUnchanged(fixture);
    } finally {
      fixture.store.close();
    }
  });

  it.each(successCases)("accepts and exactly replays $id without touching the caller or delivery ref", async (scenario) => {
    const fixture = await makeFixture(scenario);
    try {
      scenario.mutate(fixture.workspace.worktreePath);
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const ambientKeys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_GLOBAL"] as const;
      const ambientBefore = Object.fromEntries(ambientKeys.map((key) => [key, process.env[key]]));
      if (scenario.poisonAmbientGit === true) {
        process.env.GIT_DIR = join(fixture.root, "foreign-git-dir");
        process.env.GIT_WORK_TREE = fixture.root;
        process.env.GIT_INDEX_FILE = join(fixture.root, "foreign-index");
        process.env.GIT_CONFIG_GLOBAL = join(fixture.root, "foreign-global-config");
      }
      let result: CommitServiceResult;
      try {
        result = runCommit(fixture);
      } finally {
        for (const key of ambientKeys) {
          const value = ambientBefore[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assertAccepted(fixture, candidate, result);
      const durableCounts = {
        intents: query(fixture.store.location.databasePath, "SELECT commit_intent_id FROM attempt_commit_intents").length,
        attributions: query(fixture.store.location.databasePath, "SELECT commit_attribution_id FROM commit_attributions").length,
        evidence: query(
          fixture.store.location.databasePath,
          "SELECT evidence_id FROM evidence WHERE producer_service = 'CommitService'",
        ).length,
      };
      const replay = runCommit(fixture);
      expect(replay).toEqual(result);
      expect({
        intents: query(fixture.store.location.databasePath, "SELECT commit_intent_id FROM attempt_commit_intents").length,
        attributions: query(fixture.store.location.databasePath, "SELECT commit_attribution_id FROM commit_attributions").length,
        evidence: query(
          fixture.store.location.databasePath,
          "SELECT evidence_id FROM evidence WHERE producer_service = 'CommitService'",
        ).length,
      }).toEqual(durableCounts);
      assertCallerUnchanged(fixture);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  it.each(preflightRejectionCases)("contains semantic preflight rejection $id without attribution", async (scenario) => {
    const fixture = await makeFixture(scenario);
    try {
      scenario.mutate(fixture);
      assertContainedRejection(fixture, runCommit(fixture), scenario.detail);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a content change combined with an undeclared executable-mode change after exact review", async () => {
    const fixture = await makeFixture({
      id: "mode-and-content",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      const path = join(fixture.workspace.worktreePath, "src/owned.txt");
      writeFileSync(path, "after\n", "utf8");
      chmodSync(path, 0o755);
      const reviewed = expectedCandidate(fixture);
      expect(reviewed.delta.entries[0]).toMatchObject({ before_mode: "100644", after_mode: "100644" });
      sealReviewAndVerification(fixture, reviewed);
      assertContainedRejection(fixture, runCommit(fixture), /mode|type|executable|100644/i);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a pre-populated service-owned isolated index instead of inheriting staged state", async () => {
    const fixture = await makeFixture({
      id: "isolated-index-poison",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const reviewed = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, reviewed);
      const environment = { GIT_INDEX_FILE: fixture.workspace.isolatedIndexPath };
      gitLiteral(fixture.workspace.worktreePath, ["read-tree", fixture.attempt.deliveryBaselineOid], environment);
      gitLiteral(fixture.workspace.worktreePath, ["add", "--", "src/owned.txt"], environment);
      assertContainedRejection(fixture, runCommit(fixture), /isolated index|index.*exist|preexisting|foreign/i);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a real submodule checkout and never attributes its gitlink", async () => {
    const fixture = await makeFixture({
      id: "submodule-gitlink",
      scope: [
        { path: ".gitmodules", change_kind: "create", directory: false },
        { path: "vendor/module", change_kind: "create", directory: true },
      ],
      baseline: { "README.md": "baseline\n" },
    });
    try {
      const source = join(fixture.root, "submodule-source");
      mkdirSync(source);
      execFileSync("git", ["init", "-q", source], { env: cleanGitEnvironment() });
      git(source, ["config", "user.name", "Submodule Corpus"]);
      git(source, ["config", "user.email", "submodule@example.test"]);
      writeFileSync(join(source, "module.txt"), "nested repository\n", "utf8");
      git(source, ["add", "module.txt"]);
      git(source, ["commit", "-qm", "nested baseline"]);
      execFileSync("git", [
        "-c", "protocol.file.allow=always", "-C", fixture.workspace.worktreePath,
        "submodule", "add", "-q", source, "vendor/module",
      ], { env: cleanGitEnvironment() });
      expect(gitLiteral(fixture.workspace.worktreePath, ["ls-files", "--stage", "--", "vendor/module"])).toMatch(/^160000 /);
      gitLiteral(fixture.workspace.worktreePath, ["reset", "-q", "--mixed", fixture.attempt.deliveryBaselineOid]);
      assertContainedRejection(fixture, runCommit(fixture), /submodule|gitlink|regular|foreign|scope|candidate/i);
    } finally {
      fixture.store.close();
    }
  });

  it.each([1, 2] as const)("rejects %i worker-created detached commit(s) and retains their HEAD for cleanup evidence", async (count) => {
    const fixture = await makeFixture({
      id: count === 1 ? "one-worker-commit" : "two-worker-commits",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), `worker commit ${ordinal}\n`, "utf8");
        gitLiteral(fixture.workspace.worktreePath, ["add", "--", "src/owned.txt"]);
        gitLiteral(fixture.workspace.worktreePath, ["commit", "-qm", `foreign worker commit ${ordinal}`]);
      }
      const workerOid = git(fixture.workspace.worktreePath, ["rev-parse", "HEAD"]);
      expect(workerOid).not.toBe(fixture.attempt.deliveryBaselineOid);
      expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(fixture.attempt.deliveryBaselineOid);
      assertContainedRejection(
        fixture,
        runCommit(fixture),
        /commit|HEAD|baseline|attempt ref|foreign/i,
        fixture.attempt.deliveryBaselineOid,
        fixture.attempt.deliveryBaselineOid,
        workerOid,
      );
      expect(git(fixture.workspace.worktreePath, ["rev-parse", "HEAD"])).toBe(workerOid);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects an orphan worker commit without moving or guessing its lineage", async () => {
    const fixture = await makeFixture({
      id: "orphan-worker-commit",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      gitLiteral(fixture.workspace.worktreePath, ["checkout", "--orphan", "orphan-worker"]);
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "orphan bytes\n", "utf8");
      gitLiteral(fixture.workspace.worktreePath, ["add", "-A"]);
      gitLiteral(fixture.workspace.worktreePath, ["commit", "-qm", "orphan worker commit"]);
      const orphanOid = git(fixture.workspace.worktreePath, ["rev-parse", "HEAD"]);
      const attemptRefOid = git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef]);
      expect(orphanOid).not.toBe(fixture.attempt.deliveryBaselineOid);
      assertContainedRejection(
        fixture,
        runCommit(fixture),
        /commit|HEAD|baseline|orphan|foreign/i,
        attemptRefOid,
        fixture.attempt.deliveryBaselineOid,
        orphanOid,
      );
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a privately moved attempt ref and preserves the third OID for cleanup", async () => {
    const fixture = await makeFixture({
      id: "attempt-ref-moved",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const foreign = unattachedCommit(fixture, "foreign attempt ref");
      git(fixture.repo, ["update-ref", fixture.workspace.attemptRef, foreign, fixture.attempt.deliveryBaselineOid]);
      assertContainedRejection(fixture, runCommit(fixture), /attempt ref|baseline|moved|foreign/i, foreign);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects the exact candidate ref without CommitService CAS reflog proof", async () => {
    const fixture = await makeFixture({
      id: "exact-candidate-ref-without-cas-proof",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const crash = new Error("fixture response lost after commit intent prepare");
      expect(() => runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier === "after_intent_persisted") throw crash;
        },
      })).toThrow(crash);
      const prepared = one(
        fixture.store.location.databasePath,
        "SELECT commit_intent_id FROM attempt_commit_intents WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      );
      const phase = one(
        fixture.store.location.databasePath,
        "SELECT created_at FROM phase_executions WHERE phase_execution_id = ?",
        fixture.implement.persisted.phaseExecutionId,
      );
      const externalCandidate = gitLiteral(fixture.repo, [
        "commit-tree", candidate.treeOid, "-p", fixture.attempt.deliveryBaselineOid,
      ], {
        GIT_AUTHOR_NAME: "Rickgent Orchestrator",
        GIT_AUTHOR_EMAIL: "orchestrator@rickgent.invalid",
        GIT_AUTHOR_DATE: String(phase.created_at),
        GIT_COMMITTER_NAME: "Rickgent Orchestrator",
        GIT_COMMITTER_EMAIL: "orchestrator@rickgent.invalid",
        GIT_COMMITTER_DATE: String(phase.created_at),
      }, `rickgent: accept ${fixture.contract.id}\n`);
      git(fixture.repo, [
        "update-ref", "-m", `rickgent-commit-intent:${String(prepared.commit_intent_id)}:${"0".repeat(64)}`,
        fixture.workspace.attemptRef, externalCandidate, fixture.attempt.deliveryBaselineOid,
      ]);
      assertContainedRejection(
        fixture,
        runCommit(fixture),
        /CAS|reflog|proof|CommitService/i,
        externalCandidate,
      );
    } finally {
      fixture.store.close();
    }
  });

  it("rejects a moved delivery ref before prepare and never rewinds external authority", async () => {
    const fixture = await makeFixture({
      id: "delivery-ref-moved-before",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const foreign = unattachedCommit(fixture, "foreign delivery ref");
      git(fixture.repo, ["update-ref", fixture.run.deliveryRef, foreign, fixture.attempt.deliveryBaselineOid]);
      assertContainedRejection(
        fixture,
        runCommit(fixture),
        /delivery ref|baseline|moved|foreign/i,
        fixture.attempt.deliveryBaselineOid,
        foreign,
      );
    } finally {
      fixture.store.close();
    }
  });

  it("rejects delivery movement at the final ref-transaction barrier without advancing the attempt ref", async () => {
    const fixture = await makeFixture({
      id: "delivery-ref-moved-at-finalize-barrier",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const foreign = unattachedCommit(fixture, "delivery ref finalize race");
      const result = runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier === "before_ref_transaction") {
            git(fixture.repo, ["update-ref", fixture.run.deliveryRef, foreign, fixture.attempt.deliveryBaselineOid]);
          }
        },
      });
      assertContainedRejection(
        fixture,
        result,
        /delivery|ref|transaction|CAS|exited|conflict/i,
        fixture.attempt.deliveryBaselineOid,
        foreign,
        fixture.attempt.deliveryBaselineOid,
        "infrastructure_error",
      );
    } finally {
      fixture.store.close();
    }
  });

  it("fails closed on a stale owner and retains every resource for recovery", async () => {
    const fixture = await makeFixture({
      id: "stale-owner",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const database = new DatabaseSync(fixture.store.location.databasePath);
      try {
        const heartbeat = new Date(Date.now() - 2_000).toISOString();
        const expires = new Date(Date.now() - 1_000).toISOString();
        const update = database.prepare(`
          UPDATE attempt_ownership_leases
          SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
          WHERE attempt_id = ? AND state = 'live'
        `).run(heartbeat, expires, fixture.attempt.attemptId);
        expect(update.changes).toBe(1);
      } finally {
        database.close();
      }
      const result = runCommit(fixture);
      expectExecutableCaseOutcome(fixture, result, "infrastructure_error");
      expect(result.detail).toMatch(/owner|ownership|expired|version|current|stale/i);
      assertNoFinalAttribution(fixture);
      expect(query(
        fixture.store.location.databasePath,
        "SELECT state, state_version FROM attempt_ownership_leases WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toEqual([{ state: "live", state_version: 1 }]);
      expect(query(
        fixture.store.location.databasePath,
        "SELECT COUNT(*) AS count FROM attempt_resource_claims WHERE attempt_id = ? AND state IN ('released','quarantined')",
        fixture.attempt.attemptId,
      )).toEqual([{ count: 0 }]);
      expect(git(fixture.repo, ["rev-parse", fixture.run.deliveryRef])).toBe(fixture.attempt.deliveryBaselineOid);
      expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(fixture.attempt.deliveryBaselineOid);
      assertCallerUnchanged(fixture);
    } finally {
      fixture.store.close();
    }
  });

  it("rechecks owner freshness immediately before the attempt-ref transaction", async () => {
    const fixture = await makeFixture({
      id: "owner-expires-before-ref-transaction",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const result = runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier !== "before_ref_transaction") return;
          const database = new DatabaseSync(fixture.store.location.databasePath);
          try {
            const update = database.prepare(`
              UPDATE attempt_ownership_leases
              SET heartbeat_at = ?, expires_at = ?, state_version = state_version + 1
              WHERE attempt_id = ? AND state = 'live'
            `).run(
              new Date(Date.now() - 2_000).toISOString(),
              new Date(Date.now() - 1_000).toISOString(),
              fixture.attempt.attemptId,
            );
            expect(update.changes).toBe(1);
          } finally {
            database.close();
          }
        },
      });
      expectExecutableCaseOutcome(fixture, result, "infrastructure_error");
      expect(result.detail).toMatch(/owner|ownership|expired|version|current|stale/i);
      assertNoFinalAttribution(fixture);
      expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(fixture.attempt.deliveryBaselineOid);
      expect(git(fixture.repo, ["rev-parse", fixture.run.deliveryRef])).toBe(fixture.attempt.deliveryBaselineOid);
      expect(query(
        fixture.store.location.databasePath,
        "SELECT state, state_version FROM attempt_ownership_leases WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toEqual([{ state: "live", state_version: 1 }]);
      assertCallerUnchanged(fixture);
    } finally {
      fixture.store.close();
    }
  });

  it("accepts the independently reviewed candidate without invoking hostile Git filters", async () => {
    const fixture = await makeFixture({
      id: "hostile-filter",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: {
        ".gitattributes": "src/owned.txt filter=hostile\n",
        "README.md": "baseline\n",
        "src/owned.txt": "before\n",
      },
    });
    try {
      git(fixture.repo, ["config", "filter.hostile.clean", "false"]);
      git(fixture.repo, ["config", "filter.hostile.required", "true"]);
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const candidate = expectedCandidate(fixture);
      expect(candidate.treeOid).not.toBe(git(fixture.repo, ["rev-parse", `${fixture.attempt.deliveryBaselineOid}^{tree}`]));
      expect(candidate.delta.entries).toEqual([{
        path: "src/owned.txt",
        from_path: null,
        change_kind: "modify",
        before_mode: "100644",
        after_mode: "100644",
      }]);
      expect(sealReviewAndVerification(fixture, candidate)).toHaveLength(2);
      assertAccepted(fixture, candidate, runCommit(fixture));
    } finally {
      fixture.store.close();
    }
  });

  it("rejects sampled process death as non-authoritative before attribution preparation", async () => {
    const fixture = await makeFixture({
      id: "non-authoritative-process-terminal",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
      authoritativeProcess: false,
    });
    try {
      expect(fixture.process.descendantsConfirmedDead).toBe(false);
      expectExecutableCaseRejection(
        "non-authoritative-process-terminal",
        () => fixture.store.resolveCommitPreparation({
          attemptId: fixture.attempt.attemptId,
          phaseExecutionId: fixture.implement.persisted.phaseExecutionId,
          contextId: fixture.implement.persisted.contextId,
        }),
        /authoritative successful implement-worker phase/,
      );
      assertNoFinalAttribution(fixture);
      assertCallerUnchanged(fixture);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects prepare replay drift against the immutable intent preimage", async () => {
    const fixture = await makeFixture({
      id: "prepare-replay-drift",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      const path = join(fixture.workspace.worktreePath, "src/owned.txt");
      writeFileSync(path, "accepted bytes\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const crash = new Error("fixture crash after prepare for drift case");
      expect(() => runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier === "after_intent_persisted") throw crash;
        },
      })).toThrow(crash);
      expect(one(
        fixture.store.location.databasePath,
        "SELECT state FROM attempt_commit_intents WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toEqual({ state: "intent_recorded" });
      writeFileSync(path, "drifted bytes\n", "utf8");
      assertContainedRejection(fixture, runCommit(fixture), /candidate|review|intent|immutable|drift|idempotency/i);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects finalize replay drift after the attempt-ref CAS", async () => {
    const fixture = await makeFixture({
      id: "finalize-replay-drift",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      const path = join(fixture.workspace.worktreePath, "src/owned.txt");
      writeFileSync(path, "accepted bytes\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const crash = new Error("fixture crash after ref CAS for finalize drift case");
      expect(() => runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier === "after_ref_transaction") throw crash;
        },
      })).toThrow(crash);
      const candidateCommit = git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef]);
      expect(candidateCommit).not.toBe(fixture.attempt.deliveryBaselineOid);
      expect(query(fixture.store.location.databasePath, "SELECT commit_attribution_id FROM commit_attributions")).toEqual([]);
      writeFileSync(path, "drifted after CAS\n", "utf8");
      assertContainedRejection(
        fixture,
        runCommit(fixture),
        /candidate|review|intent|immutable|drift|idempotency/i,
        candidateCommit,
      );
    } finally {
      fixture.store.close();
    }
  });

  // These names are consumed verbatim by the crash-inventory contract.
  it("records an immutable commit intent before Git mutation and exactly replays the prepare boundary", async () => {
    const fixture = await makeFixture({
      id: "prepare-response-loss",
      scope: [{ path: "src/owned.txt", change_kind: "modify", directory: false }],
      baseline: { "README.md": "baseline\n", "src/owned.txt": "before\n" },
    });
    try {
      writeFileSync(join(fixture.workspace.worktreePath, "src/owned.txt"), "after\n", "utf8");
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const crash = new Error("fixture crash after durable commit prepare");
      expect(() => runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier === "after_intent_persisted") throw crash;
        },
      })).toThrow(crash);
      const prepared = one(
        fixture.store.location.databasePath,
        "SELECT * FROM attempt_commit_intents WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      );
      expect(prepared).toMatchObject({
        state: "intent_recorded",
        state_version: 0,
        attempt_ref_before_oid: null,
        attempt_ref_after_oid: null,
        commit_attribution_id: null,
        commit_oid: null,
      });
      expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(fixture.attempt.deliveryBaselineOid);
      expect(query(fixture.store.location.databasePath, "SELECT commit_attribution_id FROM commit_attributions")).toEqual([]);
      expect(query(
        fixture.store.location.databasePath,
        "SELECT state FROM attempt_ownership_leases WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toEqual([{ state: "live" }]);

      const result = runCommit(fixture);
      assertAccepted(fixture, candidate, result);
      expect(one(
        fixture.store.location.databasePath,
        "SELECT commit_intent_id, input_digest, created_at FROM attempt_commit_intents WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      )).toMatchObject({
        commit_intent_id: prepared.commit_intent_id,
        input_digest: prepared.input_digest,
        created_at: prepared.created_at,
      });
    } finally {
      fixture.store.close();
    }
  });

  it("finalizes exact attribution after the ref CAS and exactly replays response loss", async () => {
    const fixture = await makeFixture({
      id: "finalize-response-loss",
      scope: [{ path: "assets/new.bin", change_kind: "create", directory: false }],
      baseline: { "README.md": "baseline\n" },
    });
    try {
      mkdirSync(join(fixture.workspace.worktreePath, "assets"), { recursive: true });
      writeFileSync(join(fixture.workspace.worktreePath, "assets/new.bin"), Buffer.from([0, 255, 0, 127]));
      const candidate = expectedCandidate(fixture);
      sealReviewAndVerification(fixture, candidate);
      const crash = new Error("fixture response lost after atomic attribution finalization");
      expect(() => runCommit(fixture, {
        barrier: (barrier) => {
          if (barrier === "after_attribution_finalized") throw crash;
        },
      })).toThrow(crash);
      const finalized = one(
        fixture.store.location.databasePath,
        "SELECT * FROM attempt_commit_intents WHERE attempt_id = ?",
        fixture.attempt.attemptId,
      );
      expect(finalized).toMatchObject({ state: "finalized", state_version: 1 });
      expect(finalized.commit_oid).not.toBeNull();
      expect(git(fixture.repo, ["rev-parse", fixture.workspace.attemptRef])).toBe(finalized.commit_oid);
      const counts = {
        intents: query(fixture.store.location.databasePath, "SELECT commit_intent_id FROM attempt_commit_intents").length,
        attributions: query(fixture.store.location.databasePath, "SELECT commit_attribution_id FROM commit_attributions").length,
        evidence: query(
          fixture.store.location.databasePath,
          "SELECT evidence_id FROM evidence WHERE producer_service = 'CommitService'",
        ).length,
      };

      const replay = runCommit(fixture);
      assertAccepted(fixture, candidate, replay);
      expect(replay).toMatchObject({
        commitIntentId: finalized.commit_intent_id,
        commitAttributionId: finalized.commit_attribution_id,
        commitOid: finalized.commit_oid,
      });
      expect({
        intents: query(fixture.store.location.databasePath, "SELECT commit_intent_id FROM attempt_commit_intents").length,
        attributions: query(fixture.store.location.databasePath, "SELECT commit_attribution_id FROM commit_attributions").length,
        evidence: query(
          fixture.store.location.databasePath,
          "SELECT evidence_id FROM evidence WHERE producer_service = 'CommitService'",
        ).length,
      }).toEqual(counts);
    } finally {
      fixture.store.close();
    }
  });
});
