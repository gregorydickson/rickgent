import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";

export const RICKGENT_PLATFORM_UNSUPPORTED = "RICKGENT_PLATFORM_UNSUPPORTED" as const;

export type SupportedPosixPlatform = "darwin" | "linux";

export class ProcessPlatformError extends Error {
  readonly code = RICKGENT_PLATFORM_UNSUPPORTED;
  readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    super(`${RICKGENT_PLATFORM_UNSUPPORTED}: unsupported process-supervisor platform ${platform}`);
    this.name = "ProcessPlatformError";
    this.platform = platform;
  }
}

export class ProcessObservationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProcessObservationError";
    this.code = code;
  }
}

export interface PosixProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Null only when a process-table backend cannot expose numeric SID. */
  readonly sid: number | null;
  readonly bootIdentity: string;
  readonly startIdentity: string;
}

export interface ProcessTableSnapshot {
  readonly platform: SupportedPosixPlatform;
  readonly bootIdentity: string;
  readonly observedAt: string;
  readonly processes: readonly PosixProcessIdentity[];
}

export interface ProcessLivenessObservation {
  /** `null` means observation was unprovable; it never means dead. */
  readonly alive: boolean | null;
  readonly reason: "observed" | "ESRCH" | "identity_replaced" | "boot_changed" | "unprovable";
  readonly errorCode: string | null;
  readonly observedAt: string;
  readonly identity: PosixProcessIdentity | null;
}

export interface ProcessSignalObservation {
  /** `false` is reserved for ESRCH; `null` means delivery was unprovable. */
  readonly delivered: boolean | null;
  readonly target: "group" | "pid";
  readonly targetId: number;
  readonly signal: NodeJS.Signals;
  readonly reason: "delivered" | "ESRCH" | "unprovable" | "identity_replaced";
  readonly errorCode: string | null;
  readonly observedAt: string;
}

export type ProcessDeathProofBasis =
  | "sampled_tracked_identities"
  | "authoritative_containment";

export interface ProcessDeathObservation {
  readonly groupDead: boolean;
  readonly proofBasis: ProcessDeathProofBasis;
  readonly trackedIdentitiesConfirmedDead: boolean;
  readonly descendantsConfirmedDead: boolean;
  readonly trackedDescendants: readonly PosixProcessIdentity[];
  readonly observedAt: string;
  readonly reason: string;
}

export interface DescendantTracker {
  readonly root: PosixProcessIdentity;
  /** Every exact PID/start identity observed as part of this tree. */
  readonly tracked: readonly PosixProcessIdentity[];
}

export interface DescendantTrackingResult {
  readonly status: "observed" | "unprovable";
  readonly tracker: DescendantTracker;
  readonly live: readonly PosixProcessIdentity[];
  readonly discovered: readonly PosixProcessIdentity[];
  readonly reason: string;
}

export interface TrackedSignalResult {
  readonly complete: boolean;
  readonly observations: readonly ProcessSignalObservation[];
  readonly reason: string;
}

export interface PosixCommandLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** Injectable synchronous observations; the production implementation is bounded and shell-free. */
export interface PosixIo {
  readonly readFile: (path: string, maxBytes: number) => string;
  readonly readDirectory: (path: string) => readonly string[];
  readonly runFile: (
    executable: string,
    argv: readonly string[],
    limits: PosixCommandLimits,
  ) => string;
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface PosixProcessLimits {
  readonly observationTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly commandMaxOutputBytes: number;
  readonly procFileMaxBytes: number;
  readonly maxProcesses: number;
  readonly maxTrackedProcesses: number;
  readonly deathPollMs: number;
}

export interface PosixProcessControllerOptions {
  readonly platform?: NodeJS.Platform;
  readonly io?: Partial<PosixIo>;
  readonly limits?: Partial<PosixProcessLimits>;
}

const DEFAULT_LIMITS: PosixProcessLimits = Object.freeze({
  observationTimeoutMs: 5_000,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 8 * 1024 * 1024,
  procFileMaxBytes: 64 * 1024,
  maxProcesses: 131_072,
  maxTrackedProcesses: 16_384,
  deathPollMs: 50,
});

function errorCode(error: unknown): string | null {
  if (error instanceof ProcessObservationError) return error.code;
  if (error !== null && typeof error === "object") {
    if ("code" in error && typeof (error as NodeJS.ErrnoException).code === "string") {
      return (error as NodeJS.ErrnoException).code ?? null;
    }
    if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
      return `EXIT_${String((error as { status: number }).status)}`;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observationError(error: unknown, operation: string): ProcessObservationError {
  if (error instanceof ProcessObservationError) return error;
  const code = errorCode(error) ?? "OBSERVATION_FAILED";
  return new ProcessObservationError(code, `${operation} was unprovable (${code}): ${errorMessage(error)}`);
}

function isMissingProcessError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ESRCH" || code === "ENOENT";
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProcessObservationError("EINVAL", `${label} must be a positive safe integer`);
  }
}

function freezeIdentity(identity: PosixProcessIdentity): PosixProcessIdentity {
  return Object.freeze({ ...identity });
}

function boundedReadFile(path: string, maxBytes: number): string {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead > maxBytes) {
      throw new ProcessObservationError("EOVERFLOW", `${path} exceeded the ${maxBytes}-byte observation limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

const DEFAULT_IO: PosixIo = Object.freeze({
  readFile: boundedReadFile,
  readDirectory: (path: string) => readdirSync(path),
  runFile: (executable: string, argv: readonly string[], limits: PosixCommandLimits) => execFileSync(executable, [...argv], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxOutputBytes,
    windowsHide: true,
  }),
  kill: (pid: number, signal: NodeJS.Signals | 0) => {
    process.kill(pid, signal);
  },
  now: () => Date.now(),
  sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
});

export function assertSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): SupportedPosixPlatform {
  if (platform !== "darwin" && platform !== "linux") throw new ProcessPlatformError(platform);
  return platform;
}

export function parseLinuxBootIdentity(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ProcessObservationError("PARSE_ERROR", "Linux boot identity was malformed");
  }
  return `linux:${value}`;
}

export function parseDarwinBootIdentity(raw: string): string {
  const match = raw.match(/\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\b/);
  if (match === null) throw new ProcessObservationError("PARSE_ERROR", "Darwin boot identity was malformed");
  const seconds = Number(match[1]);
  const microseconds = Number(match[2]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(microseconds) || microseconds < 0 || microseconds > 999_999) {
    throw new ProcessObservationError("PARSE_ERROR", "Darwin boot identity was out of range");
  }
  return `darwin:${seconds}:${microseconds}`;
}

export function parseLinuxProcStat(raw: string, bootIdentity: string): PosixProcessIdentity {
  const close = raw.lastIndexOf(")");
  const open = raw.indexOf("(");
  if (open <= 0 || close <= open || close + 2 > raw.length) {
    throw new ProcessObservationError("PARSE_ERROR", "Linux /proc stat record was malformed");
  }
  const pidRaw = raw.slice(0, open).trim();
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  // fields[0] is kernel field 3 (state); fields[19] is field 22 (starttime).
  if (!/^\d+$/.test(pidRaw) || fields.length < 20 || !/^[A-Za-z]$/.test(fields[0] ?? "")) {
    throw new ProcessObservationError("PARSE_ERROR", "Linux /proc stat record lacked required fields");
  }
  const pid = Number(pidRaw);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const sid = Number(fields[3]);
  const startTicksRaw = fields[19] ?? "";
  if (
    !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(ppid) || ppid < 0 ||
    !Number.isSafeInteger(pgid) || pgid <= 0 ||
    !Number.isSafeInteger(sid) || sid <= 0 ||
    !/^\d+$/.test(startTicksRaw)
  ) {
    throw new ProcessObservationError("PARSE_ERROR", "Linux /proc stat identity fields were malformed");
  }
  const startTicks = Number(startTicksRaw);
  if (!Number.isSafeInteger(startTicks) || startTicks <= 0 || !bootIdentity.startsWith("linux:")) {
    throw new ProcessObservationError("PARSE_ERROR", "Linux process start identity was malformed");
  }
  return freezeIdentity({
    pid,
    ppid,
    pgid,
    sid,
    bootIdentity,
    startIdentity: `linux:${startTicks}`,
  });
}

const DARWIN_WEEKDAYS = new Set(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const DARWIN_MONTHS = new Set(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

function parseDarwinStartIdentity(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 5 || !DARWIN_WEEKDAYS.has(parts[0] ?? "") || !DARWIN_MONTHS.has(parts[1] ?? "")) {
    throw new ProcessObservationError("PARSE_ERROR", "Darwin process start identity was malformed");
  }
  const day = Number(parts[2]);
  const time = (parts[3] ?? "").match(/^(\d{2}):(\d{2}):(\d{2})$/);
  const year = Number(parts[4]);
  if (
    !Number.isInteger(day) || day < 1 || day > 31 || time === null ||
    Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 60 ||
    !Number.isInteger(year) || year < 1970 || year > 9999
  ) {
    throw new ProcessObservationError("PARSE_ERROR", "Darwin process start identity was out of range");
  }
  return `darwin:${parts.join(" ")}`;
}

/**
 * Parse Darwin ps output strictly. Modern macOS redacts the numeric `sess`
 * column to zero, so production passes authoritative `getsid(2)` results in
 * `sessionIds`. The optional path remains useful for parser fixtures from hosts
 * that expose a real positive `sess` value.
 */
export function parseDarwinProcessTable(
  raw: string,
  bootIdentity: string,
  sessionIds?: ReadonlyMap<number, number | null>,
): readonly PosixProcessIdentity[] {
  if (!bootIdentity.startsWith("darwin:")) {
    throw new ProcessObservationError("PARSE_ERROR", "Darwin process table had a non-Darwin boot identity");
  }
  const identities: PosixProcessIdentity[] = [];
  const pids = new Set<number>();
  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (match === null) throw new ProcessObservationError("PARSE_ERROR", "Darwin process table row was malformed");
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const reportedSid = Number(match[4]);
    if (
      !Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(ppid) || ppid < 0 ||
      !Number.isSafeInteger(pgid) || pgid <= 0 ||
      !Number.isSafeInteger(reportedSid) || reportedSid < 0 ||
      pids.has(pid)
    ) {
      throw new ProcessObservationError("PARSE_ERROR", "Darwin process table identity fields were malformed");
    }
    pids.add(pid);
    if (sessionIds !== undefined && !sessionIds.has(pid)) {
      throw new ProcessObservationError("PARSE_ERROR", `Darwin session observation omitted pid ${pid}`);
    }
    const sid = sessionIds === undefined
      ? reportedSid === 0 ? null : reportedSid
      : sessionIds.get(pid);
    // With an explicit getsid map, null is an ESRCH race and the ps row is
    // skipped. Without that map, null is the honest whole-table SID sentinel.
    if (sessionIds !== undefined && sid === null) continue;
    if (sid === undefined || (sid !== null && (!Number.isSafeInteger(sid) || sid <= 0))) {
      throw new ProcessObservationError("PARSE_ERROR", `Darwin session identity for pid ${pid} was malformed`);
    }
    identities.push(freezeIdentity({
      pid,
      ppid,
      pgid,
      sid,
      bootIdentity,
      startIdentity: parseDarwinStartIdentity(match[5] ?? ""),
    }));
  }
  return Object.freeze(identities.sort((left, right) => left.pid - right.pid));
}

const DARWIN_GETSID_SCRIPT = String.raw`import errno, os, sys
for raw in sys.argv[1:]:
    pid = int(raw)
    try:
        print(str(pid) + "\t" + str(os.getsid(pid)))
    except ProcessLookupError:
        print(str(pid) + "\tESRCH")
    except PermissionError:
        print(str(pid) + "\tEPERM")
    except OSError as error:
        print(str(pid) + "\tERRNO_" + str(error.errno if error.errno is not None else "UNKNOWN"))
`;

const DARWIN_GETSID_BATCH_SIZE = 512;

function darwinPidsFromPs(raw: string): readonly number[] {
  const pids: number[] = [];
  const seen = new Set<number>();
  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const match = rawLine.match(/^\s*(\d+)\s+/);
    const pid = match === null ? NaN : Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) {
      throw new ProcessObservationError("PARSE_ERROR", "Darwin process table PID column was malformed");
    }
    seen.add(pid);
    pids.push(pid);
  }
  return Object.freeze(pids);
}

export function parseDarwinSessionIds(
  raw: string,
  expectedPids: readonly number[],
): ReadonlyMap<number, number | null> {
  const expected = new Set(expectedPids);
  const observed = new Map<number, number | null>();
  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const match = rawLine.match(/^(\d+)\t(\d+|ESRCH|EPERM|ERRNO_[A-Z0-9]+)$/);
    if (match === null) throw new ProcessObservationError("PARSE_ERROR", "Darwin getsid output was malformed");
    const pid = Number(match[1]);
    const value = match[2]!;
    if (!expected.has(pid) || observed.has(pid)) {
      throw new ProcessObservationError("PARSE_ERROR", `Darwin getsid output contained unexpected pid ${pid}`);
    }
    if (value === "ESRCH") observed.set(pid, null);
    else if (value === "EPERM") throw new ProcessObservationError("EPERM", `Darwin getsid was denied for pid ${pid}`);
    else if (value.startsWith("ERRNO_")) {
      throw new ProcessObservationError(value, `Darwin getsid failed for pid ${pid}`);
    } else {
      const sid = Number(value);
      if (!Number.isSafeInteger(sid) || sid <= 0) {
        throw new ProcessObservationError("PARSE_ERROR", `Darwin getsid returned an invalid session for pid ${pid}`);
      }
      observed.set(pid, sid);
    }
  }
  if (observed.size !== expected.size) {
    throw new ProcessObservationError("PARSE_ERROR", "Darwin getsid output omitted one or more requested PIDs");
  }
  return observed;
}

export function processIdentityKey(identity: PosixProcessIdentity): string {
  return `${identity.bootIdentity}\0${identity.pid}\0${identity.startIdentity}`;
}

function sameIdentity(left: PosixProcessIdentity, right: PosixProcessIdentity): boolean {
  return processIdentityKey(left) === processIdentityKey(right);
}

export function createDescendantTracker(root: PosixProcessIdentity): DescendantTracker {
  assertPositiveInteger(root.pid, "root pid");
  return Object.freeze({ root: freezeIdentity(root), tracked: Object.freeze([freezeIdentity(root)]) });
}

/**
 * Extend an exact-identity tracker from a complete observed snapshot.
 * Parentage is followed only from identities that still match PID+start time,
 * so a reused parent PID cannot annex an unrelated process tree. PGID/SID are
 * deliberately irrelevant: descendants remain tracked after `setsid()`.
 */
export function updateDescendantTracker(
  tracker: DescendantTracker,
  snapshot: ProcessTableSnapshot,
  maxTrackedProcesses = DEFAULT_LIMITS.maxTrackedProcesses,
): DescendantTrackingResult {
  if (snapshot.bootIdentity !== tracker.root.bootIdentity) {
    return Object.freeze({
      status: "observed",
      tracker,
      live: Object.freeze([]),
      discovered: Object.freeze([]),
      reason: "boot identity changed; every identity from the prior boot is dead",
    });
  }
  const currentByPid = new Map(snapshot.processes.map((identity) => [identity.pid, identity]));
  const trackedByKey = new Map(tracker.tracked.map((identity) => [processIdentityKey(identity), identity]));
  const liveByPid = new Map<number, PosixProcessIdentity>();
  for (const identity of tracker.tracked) {
    const current = currentByPid.get(identity.pid);
    if (current !== undefined && sameIdentity(identity, current)) liveByPid.set(identity.pid, current);
  }

  const discovered: PosixProcessIdentity[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of snapshot.processes) {
      const key = processIdentityKey(candidate);
      if (trackedByKey.has(key) || !liveByPid.has(candidate.ppid)) continue;
      if (trackedByKey.size >= maxTrackedProcesses) {
        return Object.freeze({
          status: "unprovable",
          tracker,
          live: Object.freeze([...liveByPid.values()].sort((a, b) => a.pid - b.pid)),
          discovered: Object.freeze(discovered),
          reason: `descendant set exceeded the ${maxTrackedProcesses}-process tracking limit`,
        });
      }
      const exact = freezeIdentity(candidate);
      trackedByKey.set(key, exact);
      liveByPid.set(exact.pid, exact);
      discovered.push(exact);
      changed = true;
    }
  }

  const tracked = Object.freeze([...trackedByKey.values()]);
  const nextTracker = Object.freeze({ root: tracker.root, tracked });
  return Object.freeze({
    status: "observed",
    tracker: nextTracker,
    live: Object.freeze([...liveByPid.values()].sort((a, b) => a.pid - b.pid)),
    discovered: Object.freeze(discovered.sort((a, b) => a.pid - b.pid)),
    reason: "descendant snapshot observed",
  });
}

export class PosixProcessController {
  readonly platform: SupportedPosixPlatform;
  readonly #io: PosixIo;
  readonly #limits: PosixProcessLimits;
  #tracker: DescendantTracker | null = null;
  #trackingUnprovable = false;

  constructor(options: PosixProcessControllerOptions = {}) {
    // This assertion happens before any injected/default observation command.
    this.platform = assertSupportedPlatform(options.platform ?? process.platform);
    this.#io = Object.freeze({ ...DEFAULT_IO, ...(options.io ?? {}) });
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits ?? {}) });
    for (const [label, value] of Object.entries(this.#limits)) {
      assertPositiveInteger(value, label);
    }
  }

  assertSupportedPlatform(): SupportedPosixPlatform {
    return this.platform;
  }

  #observeExactDarwinProcessTable(
    raw: string,
    bootIdentity: string,
    startedAt: number,
  ): readonly PosixProcessIdentity[] {
    const pids = darwinPidsFromPs(raw);
    if (pids.length > this.#limits.maxProcesses) {
      throw new ProcessObservationError("EOVERFLOW", `process table exceeded the ${this.#limits.maxProcesses}-process limit`);
    }
    const sessionIds = new Map<number, number | null>();
    for (let offset = 0; offset < pids.length; offset += DARWIN_GETSID_BATCH_SIZE) {
      if (this.#io.now() - startedAt > this.#limits.observationTimeoutMs) {
        throw new ProcessObservationError("ETIMEDOUT", "Darwin session observation exceeded its deadline");
      }
      const batch = pids.slice(offset, offset + DARWIN_GETSID_BATCH_SIZE);
      const output = this.#io.runFile(
        "/usr/bin/python3",
        ["-c", DARWIN_GETSID_SCRIPT, ...batch.map(String)],
        { timeoutMs: this.#limits.commandTimeoutMs, maxOutputBytes: this.#limits.commandMaxOutputBytes },
      );
      for (const [pid, sid] of parseDarwinSessionIds(output, batch)) sessionIds.set(pid, sid);
    }
    return parseDarwinProcessTable(raw, bootIdentity, sessionIds);
  }

  observeBootIdentity(): string {
    try {
      if (this.platform === "linux") {
        return parseLinuxBootIdentity(this.#io.readFile(
          "/proc/sys/kernel/random/boot_id",
          this.#limits.procFileMaxBytes,
        ));
      }
      return parseDarwinBootIdentity(this.#io.runFile(
        "/usr/sbin/sysctl",
        ["-n", "kern.boottime"],
        { timeoutMs: this.#limits.commandTimeoutMs, maxOutputBytes: this.#limits.commandMaxOutputBytes },
      ));
    } catch (error) {
      throw observationError(error, "platform boot identity observation");
    }
  }

  observeIdentity(pid: number): PosixProcessIdentity {
    assertPositiveInteger(pid, "pid");
    const bootBefore = this.observeBootIdentity();
    let identity: PosixProcessIdentity;
    try {
      if (this.platform === "linux") {
        const raw = this.#io.readFile(`/proc/${pid}/stat`, this.#limits.procFileMaxBytes);
        identity = parseLinuxProcStat(raw, bootBefore);
      } else {
        const raw = this.#io.runFile(
          "/bin/ps",
          ["-p", String(pid), "-o", "pid=,ppid=,pgid=,sess=,lstart="],
          { timeoutMs: this.#limits.commandTimeoutMs, maxOutputBytes: this.#limits.commandMaxOutputBytes },
        );
        const rows = this.#observeExactDarwinProcessTable(raw, bootBefore, this.#io.now());
        if (rows.length === 0) throw new ProcessObservationError("ESRCH", `process ${pid} was absent`);
        if (rows.length !== 1) throw new ProcessObservationError("PARSE_ERROR", `process ${pid} observation returned ${rows.length} rows`);
        identity = rows[0]!;
      }
    } catch (error) {
      if (this.platform === "darwin" && errorCode(error) === "EXIT_1") {
        try {
          this.#io.kill(pid, 0);
        } catch (probeError) {
          if (errorCode(probeError) === "ESRCH") {
            throw new ProcessObservationError("ESRCH", `process ${pid} was absent during identity observation`);
          }
          throw observationError(probeError, `process ${pid} identity existence probe`);
        }
        throw observationError(error, `process ${pid} identity observation`);
      }
      if (isMissingProcessError(error)) {
        throw new ProcessObservationError("ESRCH", `process ${pid} was absent during identity observation`);
      }
      throw observationError(error, `process ${pid} identity observation`);
    }
    if (identity.pid !== pid) {
      throw new ProcessObservationError("PARSE_ERROR", `process identity request for ${pid} returned pid ${identity.pid}`);
    }
    const bootAfter = this.observeBootIdentity();
    if (bootAfter !== bootBefore) {
      throw new ProcessObservationError("BOOT_CHANGED", "boot identity changed during process identity observation");
    }
    return identity;
  }

  snapshotProcessTable(): ProcessTableSnapshot {
    const bootBefore = this.observeBootIdentity();
    const startedAt = this.#io.now();
    let processes: readonly PosixProcessIdentity[];
    try {
      if (this.platform === "darwin") {
        const raw = this.#io.runFile(
          "/bin/ps",
          ["-a", "-x", "-o", "pid=,ppid=,pgid=,sess=,lstart="],
          { timeoutMs: this.#limits.commandTimeoutMs, maxOutputBytes: this.#limits.commandMaxOutputBytes },
        );
        // macOS currently redacts ps `sess` to zero. A whole-host getsid pass
        // is both permission-fragile and too slow for descendant polling, so
        // snapshots retain an explicit null SID. `observeIdentity` performs
        // the authoritative bounded getsid syscall for the supervised root.
        processes = parseDarwinProcessTable(raw, bootBefore);
      } else {
        const procEntries = this.#io.readDirectory("/proc");
        const pids = procEntries
          .filter((entry) => /^[1-9]\d*$/.test(entry))
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid))
          .sort((left, right) => left - right);
        if (pids.length > this.#limits.maxProcesses) {
          throw new ProcessObservationError("EOVERFLOW", `process table exceeded the ${this.#limits.maxProcesses}-process limit`);
        }
        const observed: PosixProcessIdentity[] = [];
        for (const pid of pids) {
          if (this.#io.now() - startedAt > this.#limits.observationTimeoutMs) {
            throw new ProcessObservationError("ETIMEDOUT", "Linux process-table observation exceeded its deadline");
          }
          try {
            const raw = this.#io.readFile(`/proc/${pid}/stat`, this.#limits.procFileMaxBytes);
            const identity = parseLinuxProcStat(raw, bootBefore);
            if (identity.pid !== pid) {
              throw new ProcessObservationError("PARSE_ERROR", `/proc/${pid}/stat reported pid ${identity.pid}`);
            }
            observed.push(identity);
          } catch (error) {
            // A process may exit between readdir and read. Every other failure
            // makes the whole snapshot unprovable; silently skipping it could
            // produce false group-death or descendant-death evidence.
            if (!isMissingProcessError(error)) throw error;
          }
        }
        processes = Object.freeze(observed);
      }
    } catch (error) {
      throw observationError(error, "process-table observation");
    }
    if (processes.length === 0) {
      throw new ProcessObservationError("PARSE_ERROR", "process-table observation was empty");
    }
    if (processes.length > this.#limits.maxProcesses) {
      throw new ProcessObservationError("EOVERFLOW", `process table exceeded the ${this.#limits.maxProcesses}-process limit`);
    }
    const bootAfter = this.observeBootIdentity();
    if (bootAfter !== bootBefore) {
      throw new ProcessObservationError("BOOT_CHANGED", "boot identity changed during process-table observation");
    }
    return Object.freeze({
      platform: this.platform,
      bootIdentity: bootBefore,
      observedAt: new Date(this.#io.now()).toISOString(),
      processes: Object.freeze([...processes].sort((left, right) => left.pid - right.pid)),
    });
  }

  observeIdentityLiveness(expected: PosixProcessIdentity): ProcessLivenessObservation {
    const observedAt = new Date(this.#io.now()).toISOString();
    try {
      const current = this.observeIdentity(expected.pid);
      if (current.bootIdentity !== expected.bootIdentity) {
        return Object.freeze({ alive: false, reason: "boot_changed", errorCode: null, observedAt, identity: current });
      }
      if (!sameIdentity(current, expected)) {
        return Object.freeze({ alive: false, reason: "identity_replaced", errorCode: null, observedAt, identity: current });
      }
      return Object.freeze({ alive: true, reason: "observed", errorCode: null, observedAt, identity: current });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        return Object.freeze({ alive: false, reason: "ESRCH", errorCode: "ESRCH", observedAt, identity: null });
      }
      return Object.freeze({ alive: null, reason: "unprovable", errorCode: code, observedAt, identity: null });
    }
  }

  observeGroup(pgid: number, expectedBootIdentity?: string): ProcessLivenessObservation {
    const observedAt = new Date(this.#io.now()).toISOString();
    try {
      assertPositiveInteger(pgid, "pgid");
      const currentBoot = this.observeBootIdentity();
      if (expectedBootIdentity !== undefined && currentBoot !== expectedBootIdentity) {
        return Object.freeze({ alive: false, reason: "boot_changed", errorCode: null, observedAt, identity: null });
      }
      this.#io.kill(-pgid, 0);
      return Object.freeze({ alive: true, reason: "observed", errorCode: null, observedAt, identity: null });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        return Object.freeze({ alive: false, reason: "ESRCH", errorCode: "ESRCH", observedAt, identity: null });
      }
      return Object.freeze({ alive: null, reason: "unprovable", errorCode: code, observedAt, identity: null });
    }
  }

  signalGroup(pgid: number, signal: NodeJS.Signals): ProcessSignalObservation {
    const observedAt = new Date(this.#io.now()).toISOString();
    try {
      assertPositiveInteger(pgid, "pgid");
      if (this.#tracker !== null && this.#tracker.root.pgid === pgid) {
        const capture = this.captureDescendants();
        if (capture.status === "unprovable") {
          return Object.freeze({
            delivered: null, target: "group", targetId: pgid, signal,
            reason: "unprovable", errorCode: "IDENTITY_UNPROVABLE", observedAt,
          });
        }
        if (!capture.live.some((identity) => identity.pgid === pgid)) {
          const group = this.observeGroup(pgid, this.#tracker.root.bootIdentity);
          if (group.alive === false) {
            return Object.freeze({
              delivered: false, target: "group", targetId: pgid, signal,
              reason: group.reason === "ESRCH" ? "ESRCH" : "identity_replaced",
              errorCode: group.errorCode, observedAt,
            });
          }
          return Object.freeze({
            delivered: null, target: "group", targetId: pgid, signal,
            reason: "identity_replaced", errorCode: "IDENTITY_MISMATCH", observedAt,
          });
        }
      }
      this.#io.kill(-pgid, signal);
      return Object.freeze({
        delivered: true, target: "group", targetId: pgid, signal,
        reason: "delivered", errorCode: null, observedAt,
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        return Object.freeze({
          delivered: false, target: "group", targetId: pgid, signal,
          reason: "ESRCH", errorCode: "ESRCH", observedAt,
        });
      }
      return Object.freeze({
        delivered: null, target: "group", targetId: pgid, signal,
        reason: "unprovable", errorCode: code, observedAt,
      });
    }
  }

  trackRoot(identity: PosixProcessIdentity): void {
    this.#tracker = createDescendantTracker(identity);
    this.#trackingUnprovable = false;
  }

  captureDescendants(): DescendantTrackingResult {
    if (this.#tracker === null) {
      throw new ProcessObservationError("NO_TRACKED_ROOT", "cannot capture descendants before tracking a root identity");
    }
    try {
      const result = updateDescendantTracker(
        this.#tracker,
        this.snapshotProcessTable(),
        this.#limits.maxTrackedProcesses,
      );
      if (result.status === "observed") this.#tracker = result.tracker;
      else this.#trackingUnprovable = true;
      return result;
    } catch (error) {
      this.#trackingUnprovable = true;
      return Object.freeze({
        status: "unprovable",
        tracker: this.#tracker,
        live: Object.freeze([]),
        discovered: Object.freeze([]),
        reason: errorMessage(observationError(error, "descendant capture")),
      });
    }
  }

  signalTrackedPids(signal: NodeJS.Signals, alreadySignaledPgid?: number): TrackedSignalResult {
    if (this.#tracker === null) {
      return Object.freeze({ complete: false, observations: Object.freeze([]), reason: "no root identity is tracked" });
    }
    if (alreadySignaledPgid !== undefined) assertPositiveInteger(alreadySignaledPgid, "already-signaled pgid");
    const capture = this.captureDescendants();
    if (capture.status === "unprovable") {
      return Object.freeze({ complete: false, observations: Object.freeze([]), reason: capture.reason });
    }
    const observations: ProcessSignalObservation[] = [];
    for (const identity of capture.live.filter((candidate) => candidate.pgid !== alreadySignaledPgid)) {
      const observedAt = new Date(this.#io.now()).toISOString();
      try {
        this.#io.kill(identity.pid, signal);
        observations.push(Object.freeze({
          delivered: true, target: "pid", targetId: identity.pid, signal,
          reason: "delivered", errorCode: null, observedAt,
        }));
      } catch (error) {
        const code = errorCode(error);
        observations.push(Object.freeze({
          delivered: code === "ESRCH" ? false : null,
          target: "pid",
          targetId: identity.pid,
          signal,
          reason: code === "ESRCH" ? "ESRCH" : "unprovable",
          errorCode: code,
          observedAt,
        }));
      }
    }
    const complete = observations.every((observation) => observation.delivered !== null);
    return Object.freeze({
      complete,
      observations: Object.freeze(observations),
      reason: complete ? "all currently matching tracked identities were signaled or absent" : "one or more tracked PID signals were unprovable",
    });
  }

  async waitForDeath(pgid: number, timeoutMs: number): Promise<ProcessDeathObservation> {
    assertPositiveInteger(pgid, "pgid");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new ProcessObservationError("EINVAL", "death observation timeout must be a non-negative safe integer");
    }
    const startedAt = this.#io.now();
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / this.#limits.deathPollMs) + 1);
    let lastGroup: ProcessLivenessObservation | null = null;
    let allTrackedDead = false;
    for (let poll = 0; poll < maxPolls; poll++) {
      const capture = this.#tracker === null ? null : this.captureDescendants();
      const expectedBoot = this.#tracker?.root.bootIdentity;
      lastGroup = this.observeGroup(pgid, expectedBoot);
      allTrackedDead = capture?.status === "observed" && capture.live.length === 0;
      if (lastGroup.alive === false && this.#tracker !== null && allTrackedDead && !this.#trackingUnprovable) {
        return Object.freeze({
          groupDead: true,
          proofBasis: "sampled_tracked_identities",
          trackedIdentitiesConfirmedDead: true,
          descendantsConfirmedDead: false,
          trackedDescendants: Object.freeze(this.#tracker.tracked.filter((identity) => !sameIdentity(identity, this.#tracker!.root))),
          observedAt: new Date(this.#io.now()).toISOString(),
          reason: "group returned ESRCH or prior-boot identity and every sampled tracked PID/start identity is dead; polling does not prove all descendants dead",
        });
      }
      const elapsed = this.#io.now() - startedAt;
      if (elapsed >= timeoutMs || poll === maxPolls - 1) break;
      await this.#io.sleep(Math.min(this.#limits.deathPollMs, timeoutMs - elapsed));
    }
    const groupDead = lastGroup?.alive === false;
    const trackedIdentitiesConfirmedDead = this.#tracker !== null && allTrackedDead && !this.#trackingUnprovable;
    return Object.freeze({
      groupDead,
      proofBasis: "sampled_tracked_identities",
      trackedIdentitiesConfirmedDead,
      descendantsConfirmedDead: false,
      trackedDescendants: Object.freeze(this.#tracker?.tracked.filter((identity) => !sameIdentity(identity, this.#tracker!.root)) ?? []),
      observedAt: new Date(this.#io.now()).toISOString(),
      reason: lastGroup?.alive === null
        ? `group death was unprovable (${lastGroup.errorCode ?? "unknown observation failure"})`
        : this.#trackingUnprovable
          ? "descendant tracking encountered an observation gap"
          : groupDead && !allTrackedDead
            ? "the process group is dead but at least one tracked exact identity remains live or unprovable"
            : "process-group death was not observed before the bounded deadline",
    });
  }
}
