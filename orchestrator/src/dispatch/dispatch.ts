// Worker transport protocol — §10.10.1 dispatch protocol.
// Append-only ledger, ticket locks, idempotency, backpressure, and one-shot
// `omnigent run` dispatch with timeout enforcement.

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from "fs";
import { join } from "path";

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
}

const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set([
  "completed", "timed_out", "killed", "salvaged", "failed", "retried", "ignored_late",
]);

export function dispatchIdString(id: DispatchId): string {
  return `${id.runId}/${id.ticketId}/${id.phase}/${id.attempt}/${id.role}`;
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
      } catch {
        // A concurrent release removed the lock between existsSync and read.
        // The ticket is free — take it rather than propagating ENOENT.
        writeFileSync(lockPath, String(Date.now()));
        return true;
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
      };
      this.ledger.append(failed);
      return failed;
    }

    try {
      this.active++;
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
      });

      // Dispatch via omnigent run one-shot
      return await this.runOneShot(idStr, opts, startedAt);
    } finally {
      this.active--;
      this.lock.release(id.ticketId);
    }
  }

  private async runOneShot(idStr: string, opts: DispatchOptions, startedAt: string): Promise<DispatchEntry> {
    return new Promise((resolve) => {
      // W3: do NOT pass `timeout` to spawn() — the manual timer below is the
      // single source of truth for timeout enforcement. Passing both creates a
      // race where Node's internal timeout and our timer can both fire and
      // produce conflicting ledger entries.
      const child = spawn("omnigent", ["run", opts.agentDir, "-p", opts.prompt], {
        stdio: ["pipe", "pipe", "pipe"],
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
        });
      }, opts.timeout);

      child.on("close", (code) => {
        const state: DispatchState = code === 0 ? "completed" : "failed";
        finish({
          dispatchId: idStr, state, pid: child.pid ?? null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: code, stdout, stderr,
        });
      });

      child.on("error", (err) => {
        finish({
          dispatchId: idStr, state: "failed", pid: child.pid ?? null,
          startedAt, completedAt: new Date().toISOString(),
          exitCode: null, stdout, stderr: err.message,
        });
      });
    });
  }
}
