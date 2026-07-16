// Worker transport protocol — §10.10.1 dispatch protocol.
// Append-only ledger, ticket locks, idempotency, backpressure, and one-shot
// `omnigent run` dispatch with timeout enforcement.

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from "fs";
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
  closePolicyBundleLease,
  materializePolicyBundle,
  verifyPolicyBundleForSpawn,
  type MaterializedWorkerBundle,
} from "./worker-materialization.js";
import { canonicalDispatchId } from "../context/execution-context.js";
import { ticketOwnedPaths, type TicketContract } from "../contracts/ticket-contract.js";
import type { RouterSelection } from "../lifecycle/routing.js";

export type DispatchState =
  | "planned" | "spawned" | "db_session_observed" | "implementation_captured" | "completed"
  | "timed_out" | "killed" | "salvage_started" | "salvaged"
  | "failed" | "retried" | "ignored_late";

export type DispatchTerminalReason =
  | "worker_failed"
  | "evidence_unverifiable"
  | "infrastructure_error"
  | "routing_denied"
  | "breaker_deferred";

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

// A held lock is only stale once it outlives the worker it protects. The
// default worker lifetime is ~1200s; the staleness deadline adds margin so a
// legitimately-held lock is never stolen mid-run while a truly dead worker's
// lock still gets reclaimed.
const WORKER_LIFETIME_MS = 1_200_000;
const LOCK_STALE_MARGIN_MS = 300_000;
export const DEFAULT_LOCK_STALE_MS = WORKER_LIFETIME_MS + LOCK_STALE_MARGIN_MS;

export class TicketLock {
  constructor(private lockDir: string) {
    mkdirSync(lockDir, { recursive: true });
  }

  acquire(ticketId: string, timeoutMs: number = DEFAULT_LOCK_STALE_MS): boolean {
    const lockPath = join(this.lockDir, `${ticketId}.lock`);
    if (existsSync(lockPath)) {
      let content: string;
      try {
        content = readFileSync(lockPath, "utf-8");
      } catch (err) {
        // Only ENOENT means a concurrent release removed the lock between
        // existsSync and read; the ticket is genuinely free, so take it. Any
        // other read error (EACCES, EIO, ...) fails closed — we cannot prove
        // the lock is free, so we do not grant ownership.
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          writeFileSync(lockPath, String(Date.now()));
          return true;
        }
        return false;
      }
      const lockTime = parseInt(content, 10);
      // An empty/corrupt lock parses to NaN; treat it as stale so a garbage
      // lock file is reclaimed instead of wedging the ticket forever.
      if (Number.isNaN(lockTime) || Date.now() - lockTime > timeoutMs) {
        writeFileSync(lockPath, String(Date.now()));
        return true;
      }
      return false;
    }
    writeFileSync(lockPath, String(Date.now()));
    return true;
  }

  release(ticketId: string): void {
    const lockPath = join(this.lockDir, `${ticketId}.lock`);
    if (existsSync(lockPath)) {
      try {
        // Delete the lock file so the ticket can be re-acquired.
        // Without this, acquire() would always see a stale/active lock.
        rmSync(lockPath, { force: true });
      } catch { /* ignore */ }
    }
  }
}

export interface DispatchOptions {
  /** Rickgent agent root. The M1 capture path resolves only agents/worker beneath it. */
  agentDir: string;
  prompt: string;
  timeout: number;
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
}

export class Dispatcher {
  private active = 0;

  constructor(
    private ledger: DispatchLedger,
    private lock: TicketLock,
    private rickgentDir: string,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  async dispatch(id: DispatchId, opts: DispatchOptions): Promise<DispatchEntry> {
    if (opts.maxConcurrent !== 1) {
      throw new InputContractError("maxConcurrent must be exactly 1 for the sequential fixture profile");
    }
    RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const idStr = dispatchIdString(id);

    // Idempotency check — return recorded terminal state without re-spawning
    const existing = this.ledger.find(idStr);
    if (existing && this.ledger.isTerminal(idStr)) {
      return existing;
    }
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
    if (!this.lock.acquire(id.ticketId)) {
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

      let materializedBundle: MaterializedWorkerBundle;
      try {
        if (!opts.ticket || !opts.selection) {
          throw new InputContractError("dispatch requires a normalized TicketContract and complete router selection");
        }
        materializedBundle = materializePolicyBundle({
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
          closePolicyBundleLease(materializedBundle);
          throw new Error(`run workspace changed during policy materialization: ${finalReadiness.detail}`);
        }
        verifyPolicyBundleForSpawn(materializedBundle);
      } catch (error) {
        const failed: DispatchEntry = {
          dispatchId: idStr, state: "failed", pid: null,
          startedAt: null, completedAt: new Date().toISOString(),
          exitCode: null, stdout: null,
          stderr: `worker materialization failed before spawn: ${error instanceof Error ? error.message : String(error)}`,
          terminalReason: "infrastructure_error",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        };
        this.ledger.append(failed);
        return failed;
      }

      const baselineConvIds = sessionDataDir
        ? captureConversationIds(sessionDataDir)
        : new Set<string>();

      // Capture the spawn timestamp once and reuse it for every ledger entry
      // produced by this dispatch. The "spawned" entry is the source of truth
      // for startedAt — completion entries must not overwrite it (W3).
      const startedAt = new Date().toISOString();
      this.ledger.append({
        dispatchId: idStr,
        state: "spawned",
        pid: null,
        startedAt,
        completedAt: null,
        exitCode: null,
        stdout: null,
        stderr: null,
        vendor: opts.selection?.vendor ?? opts.vendor ?? null,
      });

      // Dispatch via omnigent run one-shot
      return await this.runOneShot(id, idStr, opts, startedAt, baselineConvIds, sessionDataDir, materializedBundle);
    } finally {
      this.active--;
      this.lock.release(id.ticketId);
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
    return new Promise((resolve) => {
      // W3: do NOT pass `timeout` to spawn() — the manual timer below is the
      // single source of truth for timeout enforcement. Passing both creates a
      // race where Node's internal timeout and our timer can both fire and
      // produce conflicting ledger entries.
      verifyPolicyBundleForSpawn(materializedBundle);
      const child = spawn("omnigent", ["run", materializedBundle.bundleDir, "-p", opts.prompt], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.workspace!.worktreeDir,
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

      let stdout = "";
      let stderr = "";
      let resolved = false;

      const finish = (entry: DispatchEntry): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.ledger.append(entry);
        resolve(entry);
      };

      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      // Handle spawn errors (e.g. ENOENT when the binary is not on PATH).
      // Without this, Node.js throws an unhandled 'error' event which can
      // crash the worker thread under parallel test execution.
      child.on("error", (err: Error) => {
        try { closePolicyBundleLease(materializedBundle); } catch { /* retained for forensic cleanup */ }
        finish({
          dispatchId: idStr, state: "failed", pid: child.pid ?? null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: null, stdout,
          stderr: stderr + `\n[dispatch] spawn error: ${err.message}`,
          terminalReason: "infrastructure_error",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        });
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          dispatchId: idStr, state: "timed_out", pid: child.pid ?? null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: null, stdout, stderr,
          terminalReason: "worker_failed",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        });
      }, opts.timeout);

      child.on("close", (code) => {
        let leaseCloseError: string | null = null;
        try {
          closePolicyBundleLease(materializedBundle);
        } catch (error) {
          leaseCloseError = error instanceof Error ? error.message : String(error);
        }
        if (resolved) return;
        const completedAt = new Date().toISOString();
        const pid = child.pid ?? null;

        if (leaseCloseError !== null) {
          finish({
            dispatchId: idStr, state: "failed", pid,
            startedAt, completedAt, exitCode: code, stdout,
            stderr: `${stderr}\n[dispatch] attempt lease could not be closed: ${leaseCloseError}`,
            terminalReason: "infrastructure_error",
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
          });
          return;
        }

        // Exit code alone is NOT completion. A non-zero exit fails immediately.
        if (code !== 0) {
          finish({
            dispatchId: idStr, state: "failed", pid,
            startedAt, completedAt, exitCode: code, stdout, stderr,
            terminalReason: "worker_failed",
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
          });
          return;
        }

        const observation = sessionDataDir
          ? observeDbSession(sessionDataDir, baselineConvIds)
          : { conversationId: null, transcriptCount: 0 };
        if (observation.conversationId !== null) {
          this.ledger.append({
            dispatchId: idStr, state: "db_session_observed", pid,
            startedAt, completedAt: null, exitCode: code, stdout, stderr,
            conversationId: observation.conversationId,
            vendor: opts.selection?.vendor ?? opts.vendor ?? null,
          });
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
            startedAt, completedAt, exitCode: code, stdout, stderr,
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
          startedAt, completedAt, exitCode: code, stdout,
          stderr: `${stderr}\n[dispatch] ${captured.detail}`,
          conversationId: observation.conversationId,
          terminalReason: "evidence_unverifiable",
          vendor: opts.selection?.vendor ?? opts.vendor ?? null,
        });
      });
    });
  }
}
