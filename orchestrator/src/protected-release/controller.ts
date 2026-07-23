import type { ProtectedReleaseProfile } from "./profile.js";
import { validateProtectedProfile } from "./profile.js";
import type { InstalledRuntime } from "../install/installed-runtime.js";

export interface RemoteObservation {
  readonly repository_id: string;
  readonly visibility: "private" | "internal" | "public";
  readonly default_branch: string;
}

export interface BranchObservation {
  readonly name: string;
  readonly oid: string;
}

export interface PullRequestObservation {
  readonly id: string;
  readonly head: string;
  readonly head_oid: string;
  readonly open: boolean;
}

export interface ProtectedRemote {
  observeRepository(): Promise<RemoteObservation>;
  observeBranch(name: string): Promise<BranchObservation | null>;
  observeOwnedPullRequests(prefix: string): Promise<readonly PullRequestObservation[]>;
  closePullRequest(id: string): Promise<void>;
  deleteBranch(name: string, expectedOid: string): Promise<void>;
}

export interface RunObservation {
  readonly run_id: string;
  readonly persistent_state_id: string;
  readonly crash: {
    readonly process_id: number;
    readonly process_group_id: number;
    readonly death_observed: true;
  };
  readonly resume: {
    readonly process_id: number;
    readonly process_group_id: number;
    readonly death_observed: false;
  };
  readonly owned_branch: string;
  readonly delivery_oid: string;
  readonly response_loss_recovered: true;
}

export interface ProtectedExecutor {
  executeTwoPhaseRun(input: {
    readonly runId: string;
    readonly persistentStateId: string;
    readonly managerEntrypoint: string;
    readonly workerEntrypoint: string;
    readonly branch: string;
    readonly timeoutMs: number;
    readonly nonInteractive: true;
  }): Promise<RunObservation>;
  interruptRun(runId: string): Promise<void>;
}

export interface ProtectedReleaseResult {
  readonly ok: true;
  readonly repository_id: string;
  readonly runs: readonly [RunObservation, RunObservation];
  readonly cleanup_requeried: true;
  readonly repository_deleted: false;
}

export class ProtectedReleaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProtectedReleaseError";
  }
}

function oid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
  onTimeout?: () => Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          void onTimeout?.().finally(() => reject(new ProtectedReleaseError(code, "protected operation timed out")));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function assertRemoteIdentity(
  profile: ProtectedReleaseProfile,
  remote: ProtectedRemote,
): Promise<RemoteObservation> {
  const observed = await bounded(remote.observeRepository(), profile.command_timeout_ms, "REMOTE_TIMEOUT");
  if (
    observed.repository_id !== profile.repository.repository_id ||
    observed.visibility === "public" ||
    observed.default_branch !== profile.repository.base_branch
  ) throw new ProtectedReleaseError("REMOTE_IDENTITY_MISMATCH", "remote identity, visibility, or base branch mismatch");
  return observed;
}

async function cleanupOwned(
  profile: ProtectedReleaseProfile,
  remote: ProtectedRemote,
  branches: readonly string[],
): Promise<void> {
  const prefix = profile.repository.owned_branch_prefix;
  await assertRemoteIdentity(profile, remote);
  for (const pr of await bounded(remote.observeOwnedPullRequests(prefix), profile.command_timeout_ms, "REMOTE_TIMEOUT")) {
    if (!pr.head.startsWith(prefix)) throw new ProtectedReleaseError("CLEANUP_SCOPE_VIOLATION", `non-owned PR returned by remote: ${pr.id}`);
    if (pr.open) {
      await assertRemoteIdentity(profile, remote);
      await bounded(remote.closePullRequest(pr.id), profile.command_timeout_ms, "REMOTE_TIMEOUT");
      await assertRemoteIdentity(profile, remote);
    }
  }
  for (const name of branches) {
    if (!name.startsWith(prefix)) throw new ProtectedReleaseError("CLEANUP_SCOPE_VIOLATION", `refusing non-owned branch cleanup: ${name}`);
    await assertRemoteIdentity(profile, remote);
    const before = await bounded(remote.observeBranch(name), profile.command_timeout_ms, "REMOTE_TIMEOUT");
    if (before === null) continue;
    if (!oid(before.oid)) throw new ProtectedReleaseError("CLEANUP_OID_INVALID", `invalid observed branch OID: ${name}`);
    const compare = await bounded(remote.observeBranch(name), profile.command_timeout_ms, "REMOTE_TIMEOUT");
    if (compare === null || compare.oid !== before.oid) throw new ProtectedReleaseError("CLEANUP_COMPARE_CHANGED", `branch changed before delete: ${name}`);
    await bounded(remote.deleteBranch(name, before.oid), profile.command_timeout_ms, "REMOTE_TIMEOUT");
    await assertRemoteIdentity(profile, remote);
    if (await bounded(remote.observeBranch(name), profile.command_timeout_ms, "REMOTE_TIMEOUT") !== null) {
      throw new ProtectedReleaseError("CLEANUP_REQUERY_FAILED", `branch remains after delete: ${name}`);
    }
  }
  await assertRemoteIdentity(profile, remote);
}

export async function runProtectedRelease(
  rawProfile: ProtectedReleaseProfile,
  installed: InstalledRuntime,
  remote: ProtectedRemote,
  executor: ProtectedExecutor,
): Promise<ProtectedReleaseResult> {
  const profile = validateProtectedProfile(rawProfile, installed);
  const observed = await assertRemoteIdentity(profile, remote);
  const branchNames: string[] = [];
  const runs: RunObservation[] = [];
  try {
    for (let index = 1; index <= 2; index++) {
      const runId = `protected-${index}`;
      const branch = `${profile.repository.owned_branch_prefix}${runId}`;
      branchNames.push(branch);
      await assertRemoteIdentity(profile, remote);
      const run = await bounded(executor.executeTwoPhaseRun({
        runId,
        persistentStateId: `state-${runId}`,
        managerEntrypoint: profile.manager_entrypoint,
        workerEntrypoint: profile.worker_entrypoint,
        branch,
        timeoutMs: profile.command_timeout_ms,
        nonInteractive: true,
      }), profile.command_timeout_ms, "RUN_TIMEOUT", () => executor.interruptRun(runId));
      if (
        run.run_id !== runId ||
        run.owned_branch !== branch ||
        !run.crash.death_observed ||
        run.resume.death_observed ||
        run.crash.process_id === run.resume.process_id ||
        run.crash.process_group_id === run.resume.process_group_id ||
        run.persistent_state_id !== `state-${runId}` ||
        run.response_loss_recovered !== true ||
        !oid(run.delivery_oid)
      ) throw new ProtectedReleaseError("RUN_TOPOLOGY_INVALID", `protected run topology invalid: ${runId}`);
      runs.push(Object.freeze(run));
      await assertRemoteIdentity(profile, remote);
    }
  } finally {
    await cleanupOwned(profile, remote, branchNames);
  }
  if (runs.length !== 2) throw new ProtectedReleaseError("RUN_INCOMPLETE", "two independent protected runs are required");
  return Object.freeze({
    ok: true,
    repository_id: observed.repository_id,
    runs: Object.freeze(runs) as unknown as readonly [RunObservation, RunObservation],
    cleanup_requeried: true,
    repository_deleted: false,
  });
}
