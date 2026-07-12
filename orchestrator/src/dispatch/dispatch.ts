// Worker transport protocol — §10.10.1 dispatch protocol.
// Append-only ledger, ticket locks, idempotency, backpressure, and one-shot
// `omnigent run` dispatch with timeout enforcement.

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
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

export class TicketLock {
  constructor(private lockDir: string) {
    mkdirSync(lockDir, { recursive: true });
  }

  acquire(ticketId: string, timeoutMs: number = 5000): boolean {
    const lockPath = join(this.lockDir, `${ticketId}.lock`);
    if (existsSync(lockPath)) {
      // Check if the lock is stale
      const content = readFileSync(lockPath, "utf-8");
      const lockTime = parseInt(content, 10);
      if (Date.now() - lockTime > timeoutMs) {
        // Stale lock — take it
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
        const content = readFileSync(lockPath, "utf-8");
        // Only release if we own it (same timestamp)
        // In a real implementation, we'd check ownership
        void content;
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
      this.ledger.append({
        dispatchId: idStr,
        state: "spawned",
        pid: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
        stdout: null,
        stderr: null,
      });

      // Dispatch via omnigent run one-shot
      return await this.runOneShot(idStr, opts);
    } finally {
      this.active--;
      this.lock.release(id.ticketId);
    }
  }

  private async runOneShot(idStr: string, opts: DispatchOptions): Promise<DispatchEntry> {
    return new Promise((resolve) => {
      const child = spawn("omnigent", ["run", opts.agentDir, "-p", opts.prompt], {
        timeout: opts.timeout,
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
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          exitCode: null, stdout, stderr,
        });
      }, opts.timeout);

      child.on("close", (code) => {
        const state: DispatchState = code === 0 ? "completed" : "failed";
        finish({
          dispatchId: idStr, state, pid: child.pid ?? null,
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          exitCode: code, stdout, stderr,
        });
      });

      child.on("error", (err) => {
        finish({
          dispatchId: idStr, state: "failed", pid: child.pid ?? null,
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          exitCode: null, stdout, stderr: err.message,
        });
      });
    });
  }
}
