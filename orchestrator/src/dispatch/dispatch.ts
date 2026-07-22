// Worker transport protocol — §10.10.1 dispatch protocol.
// Append-only ledger, ticket locks, idempotency, backpressure, and one-shot
// `omnigent run` dispatch with timeout enforcement.

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "fs";
import { join } from "path";
import {
  captureConversationIds,
  isolatedDataDir,
  observeDbSession,
} from "./evidence.js";
import { InputContractError } from "../capabilities/registry.js";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";
import {
  runWorkspaceReadyForSpawn,
  type ReadyRunWorkspace,
} from "../git/run-workspace.js";
import {
  captureNonterminalMutation,
  type ImplementationCapturedReceipt,
} from "../git/mutation-capture.js";
import {
  finalizePolicyBundle,
  materializePolicyBundle,
  verifyPolicyBundleForSpawn,
  type MaterializedWorkerBundle,
} from "./worker-materialization.js";
import { canonicalDispatchId } from "../context/execution-context.js";
import { ticketOwnedPaths, type TicketContract } from "../contracts/ticket-contract.js";
import type { RouterSelection } from "../lifecycle/routing.js";
import type { AllocatedAttempt } from "../state/store.js";

export type DispatchState =
  | "planned" | "spawned" | "db_session_observed" | "implementation_captured" | "completed"
  | "timed_out" | "killed" | "salvage_started" | "salvaged"
  | "failed" | "retried" | "ignored_late" | "cleanup_pending";

export type DispatchTerminalReason =
  | "worker_failed"
  | "evidence_unverifiable"
  | "infrastructure_error"
  | "routing_denied"
  | "breaker_deferred"
  | "ownership_unproven";

export interface DispatchId {
  runId: string;
  ticketId: string;
  phase: string;
  attempt: number;
  role: string;
}

export interface DispatchEntry {
  dispatchId: string;
  state: DispatchState;
  pid: number | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  /**
   * False when dispatch had to force termination and therefore cannot prove
   * that new-session descendants released their mutation authority. The
   * attempt lease and owner-bound ticket lock remain active in that case.
   */
  ownershipReleased?: boolean;
  /** Machine-readable terminal classification; lifecycle aggregation never parses stderr. */
  terminalReason?: DispatchTerminalReason;
  /** Conversation id of the DB session created by this dispatch (B2 evidence). */
  conversationId?: string | null;
  /**
   * Commit sha the dispatch's in-scope git delta landed on (B6 reconcile
   * evidence). reconcile re-validates this sha through the completion oracle
   * before assigning Done — it is never trusted as a bare completion claim.
   */
  commitSha?: string | null;
  /** Baseline HEAD sha the delta was measured against (B6 reconcile evidence). */
  baselineSha?: string | null;
  /** Whether the tree at commitSha differed from the baseline (B6 evidence). */
  treeChanged?: boolean;
  /** Ticket's declared scope, persisted so reconcile recovers it losslessly. */
  declaredPaths?: string[];
  /**
   * Per-dispatch vendor label (B8 multi-vendor routing). The harness/model
   * identity the router selected for this dispatch, persisted so the ledger
   * carries a non-empty vendor/harness label matching the router selection.
   * Null when no router was consulted (no silent hardcoded default).
   */
  vendor?: string | null;
  /** M1 fixture-only observation. It is deliberately nonterminal and has no worker commit. */
  captureReceipt?: ImplementationCapturedReceipt;
}

const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set([
  "completed", "timed_out", "killed", "salvaged", "failed", "retried", "ignored_late",
]);

export function dispatchIdString(id: DispatchId): string {
  return canonicalDispatchId(id);
}

/**
 * The canonical dispatch ledger path for a `.rickgent` dir. Both the Dispatcher
 * (writer) and reconcile (reader) resolve the ledger through this single helper
 * so the two can never diverge on a hardcoded filename (B6).
 */
export function dispatchLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "dispatch-ledger.jsonl");
}

export class DispatchLedger {
  constructor(private ledgerPath: string) {
    mkdirSync(join(this.ledgerPath, ".."), { recursive: true });
  }

  append(entry: DispatchEntry): void {
    appendFileSync(this.ledgerPath, JSON.stringify(entry) + "\n");
  }

  find(dispatchId: string): DispatchEntry | null {
    if (!existsSync(this.ledgerPath)) return null;
    const raw = readFileSync(this.ledgerPath, "utf-8").trim();
    if (raw === "") return null;
    const lines = raw.split("\n");
    for (const line of lines.reverse()) { // most recent first
      try {
        const entry: DispatchEntry = JSON.parse(line);
        if (entry.dispatchId === dispatchId) return entry;
      } catch { /* skip malformed */ }
    }
    return null;
  }

  isTerminal(dispatchId: string): boolean {
    const entry = this.find(dispatchId);
    if (!entry) return false;
    return TERMINAL_STATES.has(entry.state);
  }
}

/** Append-only diagnostic sink. It cannot answer replay or ownership queries. */
export interface DispatchJournal {
  append(entry: DispatchEntry): void;
}

/** Fixture transport journal; lifecycle truth remains exclusively in SQLite. */
export class InMemoryDispatchJournal implements DispatchJournal {
  readonly #entries: DispatchEntry[] = [];

  append(entry: DispatchEntry): void {
    this.#entries.push(Object.freeze({ ...entry }));
  }

  observations(): readonly DispatchEntry[] {
    return Object.freeze([...this.#entries]);
  }
}

export class TicketLock {
  private readonly owners = new Map<string, string>();

  constructor(private lockDir: string) {
    mkdirSync(lockDir, { recursive: true });
  }

  private createExclusive(lockPath: string, ticketId: string): boolean {
    const token = randomUUID();
    const bytes = Buffer.from(`${Date.now()}\n${token}\nactive\n`, "utf8");
    let descriptor: number | null = null;
    try {
      descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      this.owners.set(ticketId, token);
      return true;
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* best effort after failed create */ }
        try { rmSync(lockPath, { force: true }); } catch { /* retained partial lock fails closed */ }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      return false;
    }
  }

  private observeExistingLock(lockPath: string): "present" | "missing" | "unreadable" {
    try {
      readFileSync(lockPath, "utf8");
      return "present";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  }

  acquire(ticketId: string): boolean {
    const lockPath = join(this.lockDir, `${ticketId}.lock`);
    if (this.createExclusive(lockPath, ticketId)) return true;

    // Phase 2 has no owner-checked reconciler. Any extant record — active,
    // cleanup-pending, malformed, empty, partial, or legacy — is therefore
    // retained and blocks acquisition. Time-based reclamation can reopen a
    // ticket while a detached descendant still has mutation authority.
    const observed = this.observeExistingLock(lockPath);
    if (observed === "missing") return this.createExclusive(lockPath, ticketId);
    return false;
  }

  release(ticketId: string): void {
    const lockPath = join(this.lockDir, `${ticketId}.lock`);
    const token = this.owners.get(ticketId);
    if (token === undefined) return;
    try {
      const observedToken = readFileSync(lockPath, "utf8").split("\n")[1];
      if (observedToken === token) rmSync(lockPath);
    } catch { /* an unprovable owner never removes the lock */ }
    this.owners.delete(ticketId);
  }

  markCleanupPending(ticketId: string): boolean {
    const lockPath = join(this.lockDir, `${ticketId}.lock`);
    const token = this.owners.get(ticketId);
    if (token === undefined) return false;
    let descriptor: number | null = null;
    try {
      const observedToken = readFileSync(lockPath, "utf8").split("\n")[1];
      if (observedToken !== token) return false;
      const bytes = Buffer.from(`${Date.now()}\n${token}\ncleanup_pending\n`, "utf8");
      descriptor = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      );
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
      }
      fsyncSync(descriptor);
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* retained lock fails closed */ }
      }
    }
  }
}

export interface DispatchOptions {
  /** Rickgent agent root. The M1 capture path resolves only agents/worker beneath it. */
  agentDir: string;
  prompt: string;
  timeout: number;
  /** Grace between process-group SIGTERM and SIGKILL after timeout. */
  terminationGraceMs?: number;
  maxConcurrent: number;
  /** Verified M1 mutation owner. No free-form mutation cwd is admitted. */
  workspace?: ReadyRunWorkspace;
  /** @deprecated Production derives policy materialization beneath rickgentDir. */
  materializationRoot?: string;
  /** @deprecated Production derives mutation scope from ticket. */
  declaredPaths?: string[];
  /** Complete normalized authority for scope and ticket identity. */
  ticket?: TicketContract;
  /** Complete router-selected requested identity. */
  selection?: RouterSelection;
  /**
   * Root OMNIGENT_DATA_DIR. Each dispatch isolates its chat.db under a
   * per-dispatchId subdir of this root so a session it creates is never
   * confused with a concurrent foreign dispatch's row in a shared store.
   */
  dataDir?: string;
  /** Extra environment merged into the spawned worker process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Per-dispatch vendor label (B8). The harness/model identity the router
   * selected for this dispatch. Persisted into every ledger entry so the
   * shared ledger carries a non-empty vendor/harness label per dispatch.
   */
  /** @deprecated Production derives the vendor from selection. */
  vendor?: string;
  /** Canonical allocation identity. Required by the non-legacy fixture transport. */
  attempt?: AllocatedAttempt;
}

export const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const PROCESS_DEATH_POLL_MS = 10;

export interface DispatcherDependencies {
  readonly materializePolicyBundle?: typeof materializePolicyBundle;
  readonly verifyPolicyBundleForSpawn?: typeof verifyPolicyBundleForSpawn;
  readonly finalizePolicyBundle?: typeof finalizePolicyBundle;
}

export class Dispatcher {
  private active = 0;
  private readonly ledger: DispatchJournal;
  private readonly legacyLock: TicketLock | null;
  private readonly rickgentDir: string;
  private readonly dependencies: DispatcherDependencies;

  /** Fixture transport: journal observations in memory; no filesystem ownership authority. */
  constructor(journal: DispatchJournal, rickgentDir: string, dependencies?: DispatcherDependencies);
  /** @deprecated Test compatibility only. Filesystem locks are not production lifecycle authority. */
  constructor(
    journal: DispatchJournal,
    legacyLock: TicketLock,
    rickgentDir: string,
    dependencies?: DispatcherDependencies,
  );
  constructor(
    journal: DispatchJournal,
    lockOrRickgentDir: TicketLock | string,
    rickgentDirOrDependencies: string | DispatcherDependencies = {},
    dependencies: DispatcherDependencies = {},
  ) {
    this.ledger = journal;
    if (typeof lockOrRickgentDir === "string") {
      this.legacyLock = null;
      this.rickgentDir = lockOrRickgentDir;
      this.dependencies = rickgentDirOrDependencies as DispatcherDependencies;
    } else {
      this.legacyLock = lockOrRickgentDir;
      this.rickgentDir = rickgentDirOrDependencies as string;
      this.dependencies = dependencies;
    }
  }

  get activeCount(): number {
    return this.active;
  }

  async dispatch(id: DispatchId, opts: DispatchOptions): Promise<DispatchEntry> {
    if (opts.maxConcurrent !== 1) {
      throw new InputContractError("maxConcurrent must be exactly 1 for the sequential fixture profile");
    }
    if (
      opts.terminationGraceMs !== undefined
      && (!Number.isSafeInteger(opts.terminationGraceMs) || opts.terminationGraceMs < 1)
    ) {
      throw new InputContractError("terminationGraceMs must be a positive safe integer");
    }
    RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const idStr = dispatchIdString(id);

    if (this.legacyLock === null) {
      const attempt = opts.attempt;
      if (attempt === undefined) throw new InputContractError("fixture dispatch requires a canonical allocated attempt");
      if (
        id.runId !== attempt.runId || id.ticketId !== attempt.ticketId || id.attempt !== attempt.attemptNumber
      ) throw new InputContractError("diagnostic dispatch identity differs from its canonical allocated attempt");
      if (opts.ticket === undefined) {
        throw new InputContractError("fixture dispatch requires its canonically allocated ticket contract");
      }
      if (opts.ticket.id !== attempt.ticketId || opts.ticket.digest !== attempt.contractDigest) {
        throw new InputContractError("dispatch ticket contract differs from its canonical allocated attempt");
      }
    }

    // The JSONL ledger is diagnostic history only. A prior terminal-looking
    // row cannot authorize skipping a fresh observation of an already-
    // allocated attempt; only the SQLite lifecycle trust spine may do that.
    if (!opts.workspace) {
      throw new InputContractError(
        "dispatch requires a verified run workspace",
      );
    }

    // Backpressure — at capacity, record planned state and return without spawning
    if (this.active >= opts.maxConcurrent) {
      const planned: DispatchEntry = {
        dispatchId: idStr,
        state: "planned",
        pid: null,
        startedAt: null,
        completedAt: null,
        exitCode: null,
        stdout: null,
        stderr: null,
        vendor: opts.selection?.vendor ?? opts.vendor ?? null,
      };
      this.ledger.append(planned);
      return planned;
    }

    // Acquire lock — fail closed if another worker holds the ticket
    if (this.legacyLock !== null && !this.legacyLock.acquire(id.ticketId)) {
      const failed: DispatchEntry = {
        dispatchId: idStr,
        state: "failed",
        pid: null,
        startedAt: null,
        completedAt: new Date().toISOString(),
        exitCode: null,
        stdout: null,
        stderr: "could not acquire ticket lock",
        terminalReason: "infrastructure_error",
        vendor: opts.selection?.vendor ?? opts.vendor ?? null,
      };
      this.ledger.append(failed);
      return failed;
    }

    let releaseTicketLock = true;
    try {
      this.active++;
      // Isolate this dispatch's chat.db under a per-dispatchId subdir so a
      // session it creates cannot be confused with one a CONCURRENT foreign
      // dispatch writes to the shared store (VAL-DISPATCH-008). The worker is
      // pointed at this dir via OMNIGENT_DATA_DIR, and evidence is observed
      // from the same dir — attribution is thus provable, not inferred from a
      // pre-spawn baseline that a concurrent writer could defeat.
      const sessionDataDir = opts.dataDir ? isolatedDataDir(opts.dataDir, idStr) : null;
      if (sessionDataDir) mkdirSync(sessionDataDir, { recursive: true });

      const readiness = runWorkspaceReadyForSpawn(opts.workspace);
      if (!readiness.ready) {
        const failed: DispatchEntry = {
          dispatchId: idStr, state: "failed", pid: null,
          startedAt: null, completedAt: new Date().toISOString(),
          exitCode: null, stdout: null,
          stderr: `run workspace rejected before spawn: ${readiness.detail}`,
          // A retained prior-worker delta is an expected M1 isolation stop:
          // this ticket could not execute safely until per-attempt ownership
          // lands. Identity/caller failures remain infrastructure failures.
          terminalReason: readiness.code === "dirty" ? "worker_failed" : "infrastructure_error",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        };
        this.ledger.append(failed);
        return failed;
      }

      let materializedBundle: MaterializedWorkerBundle | null = null;
      try {
        if (!opts.ticket || !opts.selection) {
          throw new InputContractError("dispatch requires a normalized TicketContract and complete router selection");
        }
        materializedBundle = (this.dependencies.materializePolicyBundle ?? materializePolicyBundle)({
          agentRoot: opts.agentDir,
          stateRoot: this.rickgentDir,
          dispatch: id,
          ticket: opts.ticket,
          workspace: opts.workspace,
          selection: opts.selection,
          leaseExpiresAtMs: Date.now() + Math.max(opts.timeout, 1_000) + 60_000,
          ...((opts.env?.OMNIGENT_ROOT ?? process.env.OMNIGENT_ROOT)
            ? { omnigentRoot: opts.env?.OMNIGENT_ROOT ?? process.env.OMNIGENT_ROOT! }
            : {}),
          ...((opts.env?.OMNIGENT_PYTHON ?? process.env.OMNIGENT_PYTHON)
            ? { omnigentPython: opts.env?.OMNIGENT_PYTHON ?? process.env.OMNIGENT_PYTHON! }
            : {}),
        });
        const finalReadiness = runWorkspaceReadyForSpawn(opts.workspace);
        if (!finalReadiness.ready) {
          throw new Error(`run workspace changed during policy materialization: ${finalReadiness.detail}`);
        }
        (this.dependencies.verifyPolicyBundleForSpawn ?? verifyPolicyBundleForSpawn)(materializedBundle);
      } catch (error) {
        const finalizationError = materializedBundle === null
          ? null
          : this.retainPolicyBundleAfterChildClose(materializedBundle);
        const failed: DispatchEntry = {
          dispatchId: idStr, state: "failed", pid: null,
          startedAt: null, completedAt: new Date().toISOString(),
          exitCode: null, stdout: null,
          stderr: `worker materialization failed before spawn: ${error instanceof Error ? error.message : String(error)}`
            + (finalizationError === null ? "" : `\n[dispatch] policy bundle finalization failed: ${finalizationError}`),
          terminalReason: "infrastructure_error",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        };
        this.ledger.append(failed);
        return failed;
      }

      let baselineConvIds: Set<string>;
      try {
        baselineConvIds = sessionDataDir
          ? captureConversationIds(sessionDataDir)
          : new Set<string>();
      } catch (error) {
        const finalizationError = this.retainPolicyBundleAfterChildClose(materializedBundle);
        const failed: DispatchEntry = {
          dispatchId: idStr, state: "failed", pid: null,
          startedAt: null, completedAt: new Date().toISOString(),
          exitCode: null, stdout: null,
          stderr: `dispatch evidence initialization failed before spawn: ${error instanceof Error ? error.message : String(error)}`
            + (finalizationError === null ? "" : `\n[dispatch] policy bundle finalization failed: ${finalizationError}`),
          terminalReason: "infrastructure_error",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        };
        this.ledger.append(failed);
        return failed;
      }

      // Capture the prospective spawn timestamp once and reuse it for every
      // entry after the final verification succeeds.
      const startedAt = new Date().toISOString();
      const entry = await this.runOneShot(
        id,
        idStr,
        opts,
        startedAt,
        baselineConvIds,
        sessionDataDir,
        materializedBundle,
      );
      releaseTicketLock = entry.ownershipReleased !== false;
      return entry;
    } finally {
      this.active--;
      if (releaseTicketLock) this.legacyLock?.release(id.ticketId);
    }
  }

  private async runOneShot(
    id: DispatchId,
    idStr: string,
    opts: DispatchOptions,
    startedAt: string,
    baselineConvIds: Set<string>,
    sessionDataDir: string | null,
    materializedBundle: MaterializedWorkerBundle,
  ): Promise<DispatchEntry> {
    // This verification is deliberately adjacent to spawn. Materialization
    // and readiness checks can take time, so no earlier verification is a
    // substitute for proving the exact bundle at the authority boundary.
    try {
      (this.dependencies.verifyPolicyBundleForSpawn ?? verifyPolicyBundleForSpawn)(materializedBundle);
    } catch (error) {
      const finalizationError = this.retainPolicyBundleAfterChildClose(materializedBundle);
      const failed: DispatchEntry = {
        dispatchId: idStr, state: "failed", pid: null,
        startedAt: null, completedAt: new Date().toISOString(),
        exitCode: null, stdout: null,
        stderr: `worker verification failed immediately before spawn: ${error instanceof Error ? error.message : String(error)}`
          + (finalizationError === null ? "" : `\n[dispatch] policy bundle finalization failed: ${finalizationError}`),
        terminalReason: "infrastructure_error",
        vendor: opts.selection?.vendor ?? opts.vendor ?? null,
      };
      this.ledger.append(failed);
      return failed;
    }

    return new Promise((resolve) => {
      // W3: do NOT pass `timeout` to spawn() — the manual timer below is the
      // single source of truth for timeout enforcement. Passing both creates a
      // race where Node's internal timeout and our timer can both fire and
      // produce conflicting ledger entries.
      let child: ReturnType<typeof spawn>;
      try {
        const runtime = materializedBundle.trustedSpawnCommand;
        // t31: pass the actual selected overrides as --harness/--model CLI
        // arguments so a selection differing from bundle defaults changes the
        // actual Omnigent invocation, not just ledger metadata. The overrides
        // are derived from the router selection (opts.selection), which is
        // the canonical requested identity. Missing selection fields fail
        // closed before spawn (the materialization already validates this).
        const spawnArgv: string[] = [
          ...runtime.argvPrefix,
          "run",
          materializedBundle.bundleDir,
          "--no-session",
        ];
        if (opts.selection) {
          spawnArgv.push("--harness", opts.selection.harness);
          spawnArgv.push("--model", opts.selection.model);
        }
        spawnArgv.push("-p", opts.prompt);
        child = spawn(runtime.executable, spawnArgv, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: opts.workspace!.worktreeDir,
          // A dedicated process group makes the dispatch own the worker's
          // complete subprocess tree. Releasing a ticket after killing only
          // the group leader would allow descendants to keep mutating the
          // supposedly-finalized workspace.
          detached: true,
          // OMNIGENT_DATA_DIR is pinned LAST to the per-dispatch isolated dir so
          // neither the inherited env nor opts.env can redirect the worker back
          // to a shared store — the worker writes its session where this dispatch
          // exclusively observes it.
          env: {
            ...process.env,
            ...(opts.env ?? {}),
            ...materializedBundle.spawnEnvironment,
            PWD: opts.workspace!.worktreeDir,
            RICKGENT_TARGET_REPO: opts.workspace!.worktreeDir,
            ...(sessionDataDir ? { OMNIGENT_DATA_DIR: sessionDataDir } : {}),
          },
        });
      } catch (error) {
        const finalizationError = this.retainPolicyBundleAfterChildClose(materializedBundle);
        const failed: DispatchEntry = {
          dispatchId: idStr, state: "failed", pid: null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: null, stdout: null,
          stderr: `[dispatch] spawn threw: ${error instanceof Error ? error.message : String(error)}`
            + (finalizationError === null ? "" : `\n[dispatch] policy bundle finalization failed: ${finalizationError}`),
          terminalReason: "infrastructure_error",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        };
        this.ledger.append(failed);
        resolve(failed);
        return;
      }

      let stdout = "";
      let stderr = "";
      let resolved = false;
      let childClosed = false;
      let closeCode: number | null = null;
      let timedOut = false;
      let spawnError: Error | null = null;
      let spawnedEvidenceFailure: string | null = null;
      let lingeringProcessGroup = false;
      let terminationStarted = false;
      const terminationErrors: string[] = [];
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      let processDeathPoll: ReturnType<typeof setTimeout> | null = null;
      const pid = child.pid ?? null;

      const appendDispatchError = (existing: string | null, detail: string): string =>
        `${existing ?? ""}${existing ? "\n" : ""}[dispatch] ${detail}`;

      const finish = (entry: DispatchEntry): void => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        if (processDeathPoll !== null) clearTimeout(processDeathPoll);
        let completedEntry = entry;
        if (
          entry.ownershipReleased === false && this.legacyLock !== null &&
          !this.legacyLock.markCleanupPending(id.ticketId)
        ) {
          completedEntry = {
            ...entry,
            state: "cleanup_pending",
            stderr: appendDispatchError(
              entry.stderr,
              "ticket lock cleanup-pending mark could not be proven; ownership remains retained",
            ),
            terminalReason: "ownership_unproven",
          };
        }
        try {
          this.ledger.append(completedEntry);
          resolve(completedEntry);
        } catch (error) {
          // The child is already closed before finish is reachable. Ledger
          // durability failure must change the returned result to
          // infrastructure failure, but it must never strand this Promise.
          resolve({
            dispatchId: completedEntry.dispatchId,
            state: completedEntry.ownershipReleased === false ? "cleanup_pending" : "failed",
            pid: completedEntry.pid,
            startedAt: completedEntry.startedAt,
            completedAt: completedEntry.completedAt ?? new Date().toISOString(),
            exitCode: completedEntry.exitCode,
            stdout: completedEntry.stdout,
            stderr: appendDispatchError(
              completedEntry.stderr,
              `terminal ledger append failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
            terminalReason: completedEntry.ownershipReleased === false
              ? "ownership_unproven"
              : "infrastructure_error",
            ...(completedEntry.conversationId === undefined
              ? {}
              : { conversationId: completedEntry.conversationId }),
            ...(completedEntry.vendor === undefined ? {} : { vendor: completedEntry.vendor }),
            ...(completedEntry.ownershipReleased === false ? { ownershipReleased: false } : {}),
          });
        }
      };

      const processGroupIsAlive = (): boolean => {
        if (pid === null) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          // EPERM and observation failures cannot prove death. Keep ownership
          // until a later observation can do so.
          return true;
        }
      };

      const signalProcessGroup = (signal: NodeJS.Signals): void => {
        if (pid === null) return;
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
          terminationErrors.push(
            `${signal} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const completeAfterConfirmedDeath = (): void => {
        if (resolved || !childClosed || processGroupIsAlive()) return;
        const completedAt = new Date().toISOString();

        // Forced termination proves only that the CLI process group is gone.
        // Harnesses may create a new session, so retain the attempt lease and
        // ticket lock until a later recovery owner can prove descendant death.
        if (terminationStarted) {
          if (spawnedEvidenceFailure !== null) {
            finish({
              dispatchId: idStr, state: "cleanup_pending", pid,
              startedAt, completedAt, exitCode: closeCode, stdout,
              stderr: appendDispatchError(
                stderr,
                [spawnedEvidenceFailure, ...terminationErrors].join("; "),
              ),
              terminalReason: "ownership_unproven",
              ownershipReleased: false,
              vendor: opts.selection?.vendor ?? opts.vendor ?? null,
            });
            return;
          }
          if (timedOut) {
            finish({
              dispatchId: idStr, state: "cleanup_pending", pid,
              startedAt, completedAt, exitCode: closeCode, stdout,
              stderr: terminationErrors.length === 0
                ? stderr
                : appendDispatchError(stderr, terminationErrors.join("; ")),
              terminalReason: "ownership_unproven",
              ownershipReleased: false,
              vendor: opts.selection?.vendor ?? opts.vendor ?? null,
            });
            return;
          }
          const details = [
            ...(spawnError === null ? [] : [`spawn error: ${spawnError.message}`]),
            ...(lingeringProcessGroup ? ["worker process group outlived its leader and was terminated"] : []),
            ...terminationErrors,
          ];
          finish({
            dispatchId: idStr, state: "cleanup_pending", pid,
            startedAt, completedAt, exitCode: closeCode, stdout,
            stderr: appendDispatchError(stderr, details.join("; ")),
            terminalReason: "ownership_unproven",
            ownershipReleased: false,
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
          });
          return;
        }

        if (spawnError !== null || closeCode !== 0) {
          const details = [
            ...(spawnError === null ? [] : [`spawn error: ${spawnError.message}`]),
            ...(closeCode === 0 ? [] : [`worker closed abnormally with exit code ${String(closeCode)}`]),
          ];
          finish({
            dispatchId: idStr, state: "cleanup_pending", pid,
            startedAt, completedAt, exitCode: closeCode, stdout,
            stderr: appendDispatchError(stderr, details.join("; ")),
            terminalReason: "ownership_unproven",
            ownershipReleased: false,
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
          });
          return;
        }

        const finalizationError = this.retainPolicyBundleAfterChildClose(materializedBundle);
        if (finalizationError !== null) {
          finish({
            dispatchId: idStr, state: "failed", pid,
            startedAt, completedAt, exitCode: closeCode, stdout,
            stderr: `${stderr}\n[dispatch] policy bundle finalization failed: ${finalizationError}`,
            terminalReason: "infrastructure_error",
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
          });
          return;
        }

        const observation = sessionDataDir
          ? observeDbSession(sessionDataDir, baselineConvIds)
          : { conversationId: null, transcriptCount: 0 };
        if (observation.conversationId !== null) {
          try {
            this.ledger.append({
              dispatchId: idStr, state: "db_session_observed", pid,
              startedAt, completedAt: null, exitCode: closeCode, stdout, stderr,
              conversationId: observation.conversationId,
              vendor: opts.selection?.vendor ?? opts.vendor ?? null,
            });
          } catch (error) {
            finish({
              dispatchId: idStr, state: "failed", pid,
              startedAt, completedAt, exitCode: closeCode, stdout,
              stderr: appendDispatchError(
                stderr,
                `DB-session ledger append failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
              conversationId: observation.conversationId,
              terminalReason: "infrastructure_error",
              vendor: opts.selection?.vendor ?? opts.vendor ?? null,
            });
            return;
          }
        }
        const captured = captureNonterminalMutation(
          id,
          opts.workspace!,
          materializedBundle,
          opts.ticket ? ticketOwnedPaths(opts.ticket) : [],
          observation,
        );
        if (captured.ok) {
          finish({
            dispatchId: idStr, state: "implementation_captured", pid,
            startedAt, completedAt, exitCode: closeCode, stdout, stderr,
            conversationId: observation.conversationId,
            baselineSha: opts.workspace!.baselineSha,
            treeChanged: true,
            declaredPaths: opts.ticket ? ticketOwnedPaths(opts.ticket) : [],
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
            captureReceipt: captured.receipt,
          });
          return;
        }
        finish({
          dispatchId: idStr, state: "failed", pid,
          startedAt, completedAt, exitCode: closeCode, stdout,
          stderr: `${stderr}\n[dispatch] ${captured.detail}`,
          conversationId: observation.conversationId,
          terminalReason: "evidence_unverifiable",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        });
      };

      const pollForProcessGroupDeath = (): void => {
        if (resolved || !childClosed) return;
        if (!processGroupIsAlive()) {
          completeAfterConfirmedDeath();
          return;
        }
        processDeathPoll = setTimeout(pollForProcessGroupDeath, PROCESS_DEATH_POLL_MS);
      };

      const beginTermination = (): void => {
        if (terminationStarted) return;
        terminationStarted = true;
        signalProcessGroup("SIGTERM");
        graceTimer = setTimeout(() => {
          if (processGroupIsAlive()) signalProcessGroup("SIGKILL");
          pollForProcessGroupDeath();
        }, opts.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
      };

      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      // Handle spawn errors (for example, a bound interpreter disappearing
      // between the final provenance check and exec).
      // Without this, Node.js throws an unhandled 'error' event which can
      // crash the worker thread under parallel test execution.
      child.on("error", (err: Error) => {
        spawnError = err;
      });

      child.on("close", (code) => {
        if (resolved) return;
        childClosed = true;
        closeCode = code;
        if (processGroupIsAlive()) {
          if (!timedOut && spawnError === null) lingeringProcessGroup = true;
          beginTermination();
          pollForProcessGroupDeath();
          return;
        }
        completeAfterConfirmedDeath();
      });

      // Install every supervision path before persisting spawned evidence. If
      // that append fails, the child is still owned, terminated, and observed
      // through confirmed CLI process-group death.
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        beginTermination();
      }, opts.timeout);

      try {
        this.ledger.append({
          dispatchId: idStr, state: "spawned", pid,
          startedAt, completedAt: null, exitCode: null,
          stdout: null, stderr: null,
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        });
      } catch (error) {
        spawnedEvidenceFailure = `spawned ledger append failed: ${error instanceof Error ? error.message : String(error)}`;
        beginTermination();
      }
    });
  }

  /**
   * Child death is the only cleanup fact dispatch can prove. Retaining the
   * materialization closes its active lease without pretending the run
   * workspace has already been cleaned, moved, or deleted by its owner.
   */
  private retainPolicyBundleAfterChildClose(materializedBundle: MaterializedWorkerBundle): string | null {
    try {
      const result = (this.dependencies.finalizePolicyBundle ?? finalizePolicyBundle)(materializedBundle, {
        childClosed: true,
        workspaceCleanupProven: false,
        disposition: "retain",
      });
      if (!result.leaseClosed || result.disposition !== "retained") {
        return `unexpected finalization proof: disposition=${result.disposition} leaseClosed=${result.leaseClosed}`;
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
