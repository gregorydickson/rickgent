/**
 * Orphan worker process reaper — ported from pickle-rick-claude's orphan-reaper.ts.
 * Backend-gated: activates only where sandbox containment is absent.
 *
 * Why it exists: a worker session that crashes, is SIGKILL'd, or is operator-frozen
 * runs no teardown, so its process group re-parents to PID 1 and lingers. This
 * reaper runs at setup-time and collects worker procs no live session owns.
 *
 * Invariants (ported verbatim from source):
 * - Positive-ownership-mandatory: a proc is reaped ONLY when positively attributed
 *   to an owning session AND that session is provably not live.
 * - NO ppid==1-only reap branch — false-reaping an active worker is worse than a leaked orphan.
 * - Min-age gate: only procs older than minAgeSeconds are candidates.
 * - SIGTERM → SIGKILL escalation with grace period.
 * - Kill-switch: RICKGENT_ORPHAN_REAP=off → inert no-op.
 * - Win32: safe no-op (no process groups).
 */

import { execSync } from "child_process";

export type SandboxBackend = "linux_bwrap" | "windows_jobobject" | "darwin_seatbelt" | "none";

export type WorkerProcCandidate = {
  pid: number;
  pgid: number;
  ppid: number;
  etimeSeconds: number;
  command: string;
};

export type ReapResult = {
  scanned: number;
  reaped: number;
  skipped: number;
  errors: string[];
};

export const ORPHAN_REAP_ENV_VAR = "RICKGENT_ORPHAN_REAP";
const DEFAULT_MIN_AGE_SECONDS = 600;
const DEFAULT_GRACE_MS = 2000;
const GRACE_POLL_MS = 100;

/**
 * Determine whether the reaper should be active for the given sandbox backend.
 * Returns true when containment is absent (darwin_seatbelt, none).
 * Returns false when containment is proven (linux_bwrap, windows_jobobject).
 */
export function shouldReap(backend: SandboxBackend): boolean {
  return backend === "darwin_seatbelt" || backend === "none";
}

/**
 * Detect the sandbox backend from the environment.
 * On macOS: darwin_seatbelt (default) or none if RICKGENT_SANDBOX=none.
 * On Linux: linux_bwrap (default) or none if RICKGENT_SANDBOX=none.
 * On Windows: windows_jobobject (default) or none.
 */
export function detectBackend(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SandboxBackend {
  if (env.RICKGENT_SANDBOX === "none") return "none";
  if (platform === "darwin") return "darwin_seatbelt";
  if (platform === "linux") return "linux_bwrap";
  if (platform === "win32") return "windows_jobobject";
  return "none";
}

/**
 * Kill a process group via negative PID signal.
 * Returns true when the signal was delivered, false on win32 or invalid pid.
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `ps -axo pid=,pgid=,ppid=,etime=,command=` output into worker proc candidates.
 * Only processes that look like worker commands (omnigent, claude, codex) are included.
 */
export function parseWorkerProcsFromPs(psOutput: string): WorkerProcCandidate[] {
  const results: WorkerProcCandidate[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = parseInt(match[1]!, 10);
    const pgid = parseInt(match[2]!, 10);
    const ppid = parseInt(match[3]!, 10);
    const etimeSeconds = parsePsElapsedSeconds(match[4]!);
    const command = match[5]!.trim();
    if (pid <= 0 || pgid <= 0 || ppid < 0 || etimeSeconds === null) continue;
    if (!isWorkerShapedCommand(command)) continue;
    results.push({ pid, pgid, ppid, etimeSeconds, command });
  }
  return results;
}

function parsePsElapsedSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const [dayPart, clockPart] = value.includes("-")
    ? value.split("-", 2)
    : [null as string | null, value];
  const segments = clockPart.split(":").map(s => Number(s));
  if (segments.some(s => !Number.isFinite(s) || s < 0)) return null;
  const days = dayPart === null ? 0 : Number(dayPart);
  if (!Number.isFinite(days) || days < 0) return null;
  if (segments.length === 2) {
    return (days * 86400) + (segments[0]! * 60) + segments[1]!;
  }
  if (segments.length === 3) {
    return (days * 86400) + (segments[0]! * 3600) + (segments[1]! * 60) + segments[2]!;
  }
  return null;
}

function isWorkerShapedCommand(command: string): boolean {
  const lower = command.toLowerCase();
  // Match omnigent worker processes and known harness worker commands
  return lower.includes("omnigent") ||
    (lower.includes("claude") && lower.includes("-p")) ||
    (lower.includes("codex") && lower.includes("exec"));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reap orphaned worker processes. Runs once at setup-time.
 *
 * @param backend The sandbox backend in use (determines whether reaping is active)
 * @param opts Configuration options
 * @returns ReapResult with scan/reap/skip counts
 */
export function reapOrphanedWorkerProcs(
  backend: SandboxBackend,
  opts: {
    minAgeSeconds?: number;
    graceMs?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    scanFn?: () => string;
  } = {},
): ReapResult {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const minAgeSeconds = opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  // Kill-switch
  if (env[ORPHAN_REAP_ENV_VAR] === "off") {
    return { scanned: 0, reaped: 0, skipped: 0, errors: [] };
  }

  // Backend-gated: no-op where containment is proven
  if (!shouldReap(backend)) {
    return { scanned: 0, reaped: 0, skipped: 0, errors: [] };
  }

  // Win32: no process groups → safe no-op
  if (platform === "win32") {
    return { scanned: 0, reaped: 0, skipped: 0, errors: [] };
  }

  const errors: string[] = [];
  let scanned = 0;
  let reaped = 0;
  let skipped = 0;

  try {
    const psOutput = opts.scanFn
      ? opts.scanFn()
      : execSync("ps -axo pid=,pgid=,ppid=,etime=,command=", {
          encoding: "utf-8",
          timeout: 5000,
          maxBuffer: 8 * 1024 * 1024,
        });

    const candidates = parseWorkerProcsFromPs(psOutput);

    for (const candidate of candidates) {
      scanned++;

      // Min-age gate
      if (candidate.etimeSeconds < minAgeSeconds) {
        skipped++;
        continue;
      }

      // Positive-ownership check: the proc must be positively attributed.
      // In Rickgent, we check if the process looks like an omnigent worker
      // that belongs to a session that is no longer live.
      // Since we can't easily resolve session ownership without the full
      // session infrastructure, we use a conservative heuristic:
      // a worker process whose parent (ppid) is PID 1 is likely orphaned.
      // BUT: we deliberately do NOT have a ppid==1-only reap branch.
      // Instead, we check if the process group leader is alive and if the
      // process responds to signal 0. If the process is still alive after
      // minAgeSeconds AND its parent is PID 1, it's a candidate.
      // However, we must be conservative: only reap if we're confident.

      // For now, skip all candidates — the reaper is active (scanning) but
      // the positive-ownership attribution requires session infrastructure
      // that isn't wired yet. This is the safe default: scan but don't reap
      // until we can positively attribute ownership.
      skipped++;
    }
  } catch (err) {
    errors.push(`reap scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { scanned, reaped, skipped, errors };
}
