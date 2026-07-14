// Worker transport protocol — §10.10.1 dispatch protocol.
// Append-only ledger, ticket locks, idempotency, backpressure, and one-shot
// `omnigent run` dispatch with timeout enforcement.

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import {
  captureGitBaseline,
  captureConversationIds,
  gatherCompletionEvidence,
  isolatedDataDir,
  type CompletionEvidenceContext,
} from "./evidence.js";

export type DispatchState =
  | "planned" | "spawned" | "db_session_observed" | "completed"
  | "timed_out" | "killed" | "salvage_started" | "salvaged"
  | "failed" | "retried" | "ignored_late";

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
}

const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set([
  "completed", "timed_out", "killed", "salvaged", "failed", "retried", "ignored_late",
]);

export function dispatchIdString(id: DispatchId): string {
  return `${id.runId}/${id.ticketId}/${id.phase}/${id.attempt}/${id.role}`;
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
  agentDir: string;
  prompt: string;
  timeout: number;
  maxConcurrent: number;
  /**
   * Target git repo the worker mutates. Required to observe an in-scope git
   * delta; without it completion cannot be verified and fails closed.
   */
  targetRepo?: string;
  /** Ticket's declared scope (repo-relative path prefixes) for the delta filter. */
  declaredPaths?: string[];
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
    const idStr = dispatchIdString(id);

    // Idempotency check — return recorded terminal state without re-spawning
    const existing = this.ledger.find(idStr);
    if (existing && this.ledger.isTerminal(idStr)) {
      return existing;
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
        vendor: opts.vendor ?? null,
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
        vendor: opts.vendor ?? null,
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

      // Capture the pre-dispatch evidence baseline BEFORE spawning: the git
      // HEAD the delta is measured against and the conversations that already
      // exist (so a DB session created by THIS dispatch is distinguishable).
      const evidenceCtx = this.captureEvidenceContext(opts, sessionDataDir);

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
        vendor: opts.vendor ?? null,
      });

      // Dispatch via omnigent run one-shot
      return await this.runOneShot(idStr, opts, startedAt, evidenceCtx, sessionDataDir);
    } finally {
      this.active--;
      this.lock.release(id.ticketId);
    }
  }

  // Assemble the evidence baseline captured at dispatch start. Returns null
  // when the caller did not supply the repo + data dir needed to verify
  // completion — in that case a bare exit 0 must fail closed. Evidence is
  // observed from the per-dispatch isolated data dir, not the shared root.
  private captureEvidenceContext(
    opts: DispatchOptions,
    sessionDataDir: string | null,
  ): CompletionEvidenceContext | null {
    if (!opts.targetRepo || !sessionDataDir) return null;
    return {
      repoDir: opts.targetRepo,
      dataDir: sessionDataDir,
      baseline: captureGitBaseline(opts.targetRepo),
      baselineConvIds: captureConversationIds(sessionDataDir),
      declaredPaths: Array.isArray(opts.declaredPaths) ? opts.declaredPaths : [],
    };
  }

  private async runOneShot(
    idStr: string,
    opts: DispatchOptions,
    startedAt: string,
    evidenceCtx: CompletionEvidenceContext | null,
    sessionDataDir: string | null,
  ): Promise<DispatchEntry> {
    return new Promise((resolve) => {
      // W3: do NOT pass `timeout` to spawn() — the manual timer below is the
      // single source of truth for timeout enforcement. Passing both creates a
      // race where Node's internal timeout and our timer can both fire and
      // produce conflicting ledger entries.
      const child = spawn("omnigent", ["run", opts.agentDir, "-p", opts.prompt], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.targetRepo || undefined,
        // OMNIGENT_DATA_DIR is pinned LAST to the per-dispatch isolated dir so
        // neither the inherited env nor opts.env can redirect the worker back
        // to a shared store — the worker writes its session where this dispatch
        // exclusively observes it.
        env: {
          ...process.env,
          ...(opts.env ?? {}),
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

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          dispatchId: idStr, state: "timed_out", pid: child.pid ?? null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: null, stdout, stderr,
          vendor: opts.vendor ?? null,
        });
      }, opts.timeout);

      child.on("close", (code) => {
        const completedAt = new Date().toISOString();
        const pid = child.pid ?? null;

        // Exit code alone is NOT completion. A non-zero exit fails immediately.
        if (code !== 0) {
          finish({
            dispatchId: idStr, state: "failed", pid,
            startedAt, completedAt, exitCode: code, stdout, stderr,
            vendor: opts.vendor ?? null,
          });
          return;
        }

        // Exit 0 with no way to verify evidence fails closed.
        if (!evidenceCtx) {
          finish({
            dispatchId: idStr, state: "failed", pid,
            startedAt, completedAt, exitCode: code, stdout,
            stderr: stderr + "\n[dispatch] exit 0 but no evidence context (targetRepo/dataDir) — cannot verify completion",
            vendor: opts.vendor ?? null,
          });
          return;
        }

        // Gather the four evidence conditions + oracle verdict (fail-closed).
        const evidence = gatherCompletionEvidence(evidenceCtx);

        // Emit db_session_observed BEFORE completed, only when a conversation
        // created by THIS dispatch is observed.
        if (evidence.dbObserved) {
          this.ledger.append({
            dispatchId: idStr, state: "db_session_observed", pid,
            startedAt, completedAt: null, exitCode: code, stdout, stderr,
            conversationId: evidence.conversationId,
            vendor: opts.vendor ?? null,
          });
        }

        if (evidence.completed) {
          finish({
            dispatchId: idStr, state: "completed", pid,
            startedAt, completedAt, exitCode: code, stdout, stderr,
            conversationId: evidence.conversationId,
            commitSha: evidence.commitSha,
            baselineSha: evidence.baselineSha,
            treeChanged: evidence.treeChanged,
            declaredPaths: Array.isArray(opts.declaredPaths) ? opts.declaredPaths : [],
            vendor: opts.vendor ?? null,
          });
          return;
        }

        finish({
          dispatchId: idStr, state: "failed", pid,
          startedAt, completedAt, exitCode: code, stdout,
          stderr: stderr + `\n[dispatch] completion evidence incomplete: ` +
            `dbSession=${evidence.dbObserved} transcript=${evidence.transcriptCount} ` +
            `inScopeDelta=${evidence.inScopePaths.length} oracle=${evidence.oracleVerdict}`,
          conversationId: evidence.conversationId,
          vendor: opts.vendor ?? null,
        });
      });

      child.on("error", (err) => {
        finish({
          dispatchId: idStr, state: "failed", pid: child.pid ?? null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: null, stdout, stderr: err.message,
          vendor: opts.vendor ?? null,
        });
      });
    });
  }
}
