/**
 * Orphan worker process reaper — ported from pickle-rick-claude's orphan-reaper.ts.
 * Backend-gated: activates only where sandbox containment is absent.
 *
 * Why it exists: a worker session that crashes, is SIGKILL'd, or is operator-frozen
 * runs no teardown, so its process group re-parents to the init process and lingers.
 * This reaper runs at setup-time and collects worker procs no live session owns.
 *
 * Invariants (ported verbatim from source):
 * - Positive-ownership-mandatory: a proc is reaped ONLY when positively attributed
 *   to an owning session AND that session is provably not live.
 * - NO parent-is-init-only reap branch — false-reaping an active worker is worse
 *   than a leaked orphan. Reaping is never triggered by parent-pid alone.
 * - Min-age gate: only procs older than minAgeSeconds are candidates.
 * - SIGTERM → grace → SIGKILL escalation on the process GROUP (negative pgid).
 * - SIGKILL is skipped when the process exits during the grace window.
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

/**
 * Session liveness attribution for a worker proc candidate.
 * - `"dead"`: the proc is positively attributed to an owning session that is
 *   provably not live at reap time → eligible for reaping.
 * - `"live"`: the proc is positively attributed to a session that is still
 *   live → never reaped.
 * - `"unattributable"`: ownership cannot be positively resolved → never reaped
 *   (fail-closed: a leaked orphan is preferable to reaping an active worker).
 */
export type SessionLiveness = "dead" | "live" | "unattributable";

/** Attribute a worker proc to its owning session's liveness. */
export type AttributeSessionFn = (candidate: WorkerProcCandidate) => SessionLiveness;

/** Kill a process group (addressed by negative pgid). Returns true if delivered. */
export type KillGroupFn = (
  pgid: number,
  signal: NodeJS.Signals,
  platform?: NodeJS.Platform,
) => boolean;

/** Return true if `pid` is currently alive (signal-0 probe). */
export type IsAliveFn = (pid: number) => boolean;

/** Block synchronously for approximately `ms` milliseconds. */
export type SleepFn = (ms: number) => void;

export const ORPHAN_REAP_ENV_VAR = "RICKGENT_ORPHAN_REAP";
export const DEFAULT_MIN_AGE_SECONDS = 600;
export const DEFAULT_GRACE_MS = 2000;
export const GRACE_POLL_MS = 100;

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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reap orphaned worker processes. Runs once at setup-time.
 *
 * Reaping is driven SOLELY by: positive session attribution → live-state
 * recheck → min-age gate. There is no branch that reaps based on parent-pid
 * alone. A process is killed only when positively attributed to an owning
 * session that is provably not live, and only after the min-age gate.
 *
 * The escalation is SIGTERM to the process GROUP → a grace window (polling
 * isProcessAlive every GRACE_POLL_MS) → SIGKILL to the group, UNLESS the
 * process exits during grace (then SIGKILL is skipped to avoid signaling a
 * possibly-reused pid). `reaped` increments for every positively-attributed
 * dead-session candidate that received SIGTERM, regardless of whether
 * SIGKILL was needed.
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
    /** Resolve a candidate's owning-session liveness. Default: unattributable (fail-closed). */
    attributeSession?: AttributeSessionFn;
    /** Process-group kill primitive. Default: killProcessGroup. */
    killGroupFn?: KillGroupFn;
    /** Liveness probe. Default: isProcessAlive. */
    isAliveFn?: IsAliveFn;
    /** Sync sleep primitive. Default: sleepSync. */
    sleepFn?: SleepFn;
  } = {},
): ReapResult {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const minAgeSeconds = opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  // The live reap path is wired to the real helpers by default; tests inject
  // recording fakes to observe signal/alive/sleep behavior. These defaults are
  // the previously-dead helpers, now invoked by every real reap.
  const attributeSession: AttributeSessionFn = opts.attributeSession ?? (() => "unattributable");
  const killGroup: KillGroupFn = opts.killGroupFn ?? ((pgid, signal, plat) => killProcessGroup(pgid, signal, plat));
  const isAlive: IsAliveFn = opts.isAliveFn ?? isProcessAlive;
  const sleep: SleepFn = opts.sleepFn ?? sleepSync;

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

      // Min-age gate: a process younger than minAgeSeconds is never a reap
      // candidate, even if attributed to a dead session.
      if (candidate.etimeSeconds < minAgeSeconds) {
        skipped++;
        continue;
      }

      // Positive-ownership-mandatory: the proc must be positively attributed
      // to an owning session. No attribution → fail-closed skip (never reap
      // a proc we cannot prove belongs to a dead session).
      const liveness = attributeSession(candidate);
      if (liveness !== "dead") {
        // "live" (session still active) or "unattributable" (cannot resolve
        // ownership) → never reap. A leaked orphan is preferable to reaping
        // an active worker.
        skipped++;
        continue;
      }

      // Reap: SIGTERM the process GROUP → grace → SIGKILL the group if still
      // alive. The group is addressed by its negative pgid inside
      // killProcessGroup so the whole group receives the signal.
      killGroup(candidate.pgid, "SIGTERM", platform);

      // Grace window: poll isProcessAlive every GRACE_POLL_MS. Break early if
      // the process exits before the deadline.
      let elapsed = 0;
      while (elapsed < graceMs) {
        sleep(GRACE_POLL_MS);
        elapsed += GRACE_POLL_MS;
        if (!isAlive(candidate.pid)) {
          break;
        }
      }

      // Post-grace recheck: only send SIGKILL if the process is STILL alive
      // after the grace window. This avoids signaling a possibly-reused pid
      // when the process exited during grace.
      if (isAlive(candidate.pid)) {
        killGroup(candidate.pgid, "SIGKILL", platform);
      }

      reaped++;
    }
  } catch (err) {
    errors.push(`reap scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { scanned, reaped, skipped, errors };
}
