import { describe, expect, it, vi } from "vitest";
import {
  ProcessObservationError,
  ProcessPlatformError,
  PosixProcessController,
  RICKGENT_PLATFORM_UNSUPPORTED,
  assertSupportedPlatform,
  createDescendantTracker,
  parseDarwinBootIdentity,
  parseDarwinProcessTable,
  parseDarwinSessionIds,
  parseLinuxBootIdentity,
  parseLinuxProcStat,
  processIdentityKey,
  updateDescendantTracker,
  type PosixIo,
  type PosixProcessIdentity,
  type ProcessTableSnapshot,
} from "../../src/process/posix.js";

const LINUX_BOOT_UUID = "11111111-2222-4333-8444-555555555555";
const LINUX_BOOT = `linux:${LINUX_BOOT_UUID}`;
const DARWIN_BOOT = "darwin:1700000000:123456";

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function linuxStat(
  pid: number,
  ppid: number,
  pgid: number,
  sid: number,
  startTicks: number,
  command = "rickgent worker",
): string {
  // Kernel fields 3..22. starttime is the twentieth token after `(comm)`.
  const fields = [
    "S", String(ppid), String(pgid), String(sid),
    "0", "0", "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "1", "0", String(startTicks),
  ];
  return `${pid} (${command}) ${fields.join(" ")}\n`;
}

function identity(
  pid: number,
  ppid: number,
  pgid: number,
  sid: number,
  startTicks: number,
): PosixProcessIdentity {
  return Object.freeze({
    pid,
    ppid,
    pgid,
    sid,
    bootIdentity: LINUX_BOOT,
    startIdentity: `linux:${startTicks}`,
  });
}

function snapshot(processes: readonly PosixProcessIdentity[]): ProcessTableSnapshot {
  return Object.freeze({
    platform: "linux",
    bootIdentity: LINUX_BOOT,
    observedAt: "2026-07-17T00:00:00.000Z",
    processes: Object.freeze([...processes]),
  });
}

function linuxIo(
  records: Readonly<Record<number, string | Error>>,
  kill: PosixIo["kill"] = () => {},
): Partial<PosixIo> {
  let now = 1_700_000_000_000;
  return {
    readFile: (path) => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${LINUX_BOOT_UUID}\n`;
      const match = path.match(/^\/proc\/(\d+)\/stat$/);
      if (match === null) throw errno("ENOENT", `unexpected path ${path}`);
      const value = records[Number(match[1])];
      if (value === undefined) throw errno("ENOENT", `missing ${path}`);
      if (value instanceof Error) throw value;
      return value;
    },
    readDirectory: () => Object.keys(records),
    kill,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

describe("POSIX platform boundary", () => {
  it.each(["win32", "freebsd"] as const)(
    "rejects %s with the stable code before any observation command",
    (platform) => {
      const runFile = vi.fn<PosixIo["runFile"]>();
      expect(() => new PosixProcessController({ platform, io: { runFile } })).toThrowError(ProcessPlatformError);
      try {
        assertSupportedPlatform(platform);
        throw new Error("expected platform rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: RICKGENT_PLATFORM_UNSUPPORTED, platform });
      }
      expect(runFile).not.toHaveBeenCalled();
    },
  );

  it("accepts only the documented POSIX platforms", () => {
    expect(assertSupportedPlatform("darwin")).toBe("darwin");
    expect(assertSupportedPlatform("linux")).toBe("linux");
  });
});

describe("strict platform parsers", () => {
  it("parses Linux boot and exact PID identity, including a comm containing a close parenthesis", () => {
    expect(parseLinuxBootIdentity(`${LINUX_BOOT_UUID.toUpperCase()}\n`)).toBe(LINUX_BOOT);
    expect(parseLinuxProcStat(linuxStat(42, 7, 42, 42, 98765, "worker ) name"), LINUX_BOOT)).toEqual({
      pid: 42,
      ppid: 7,
      pgid: 42,
      sid: 42,
      bootIdentity: LINUX_BOOT,
      startIdentity: "linux:98765",
    });
  });

  it.each([
    "",
    "not-a-uuid",
    "11111111-2222-3333-4444-55555555555z",
  ])("rejects malformed Linux boot identity %j", (raw) => {
    expect(() => parseLinuxBootIdentity(raw)).toThrowError(ProcessObservationError);
  });

  it.each([
    "garbage",
    "42 (worker) S 1 42",
    linuxStat(42, 1, 42, 42, 0),
  ])("rejects malformed Linux proc observations", (raw) => {
    expect(() => parseLinuxProcStat(raw, LINUX_BOOT)).toThrowError(ProcessObservationError);
  });

  it("parses Darwin sysctl boot time and ps identities", () => {
    expect(parseDarwinBootIdentity("{ sec = 1700000000, usec = 123456 } Fri Nov 14 00:00:00 2023")).toBe(DARWIN_BOOT);
    const rows = parseDarwinProcessTable([
      "  1 0 1 1 Fri Jul 11 10:06:16 2025",
      "123 1 123 123 Thu Jul 17 09:08:07 2026",
    ].join("\n"), DARWIN_BOOT);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      pid: 123,
      ppid: 1,
      pgid: 123,
      sid: 123,
      bootIdentity: DARWIN_BOOT,
      startIdentity: "darwin:Thu Jul 17 09:08:07 2026",
    });
  });

  it.each([
    "{ sec = nope, usec = 0 }",
    "{ sec = 1700000000, usec = 1000000 }",
  ])("rejects malformed Darwin boot observations", (raw) => {
    expect(() => parseDarwinBootIdentity(raw)).toThrowError(ProcessObservationError);
  });

  it.each([
    "not ps output",
    "12 1 12 12 Thu Jul 17 99:08:07 2026",
    "12 1 12 12 Thu Jul 17 09:08:07 2026\n12 1 12 12 Thu Jul 17 09:08:07 2026",
  ])("rejects malformed or duplicate Darwin process rows", (raw) => {
    expect(() => parseDarwinProcessTable(raw, DARWIN_BOOT)).toThrowError(ProcessObservationError);
  });

  it("parses authoritative Darwin getsid results and preserves ESRCH", () => {
    expect([...parseDarwinSessionIds("1\t1\n77\tESRCH\n", [1, 77])]).toEqual([[1, 1], [77, null]]);
    expect(() => parseDarwinSessionIds("77\tEPERM\n", [77])).toThrowError(expect.objectContaining({ code: "EPERM" }));
    expect(() => parseDarwinSessionIds("77\tgarbage\n", [77])).toThrowError(expect.objectContaining({ code: "PARSE_ERROR" }));
  });
});

describe("bounded shell-free observations", () => {
  it("uses /proc for Linux identity and process-table snapshots", () => {
    const records = {
      10: linuxStat(10, 1, 10, 10, 100),
      11: linuxStat(11, 10, 10, 10, 101),
    };
    const controller = new PosixProcessController({ platform: "linux", io: linuxIo(records) });
    expect(controller.observeIdentity(10)).toEqual(identity(10, 1, 10, 10, 100));
    expect(controller.snapshotProcessTable().processes).toEqual([
      identity(10, 1, 10, 10, 100),
      identity(11, 10, 10, 10, 101),
    ]);
  });

  it("uses absolute Darwin ps/sysctl executables with array argv and explicit bounds", () => {
    const calls: Array<{ executable: string; argv: readonly string[]; timeoutMs: number; maxOutputBytes: number }> = [];
    const runFile: PosixIo["runFile"] = (executable, argv, limits) => {
      calls.push({ executable, argv: [...argv], ...limits });
      if (executable === "/usr/sbin/sysctl") return "{ sec = 1700000000, usec = 123456 }";
      if (executable === "/bin/ps") return "1 0 1 0 Fri Jul 11 10:06:16 2025\n";
      throw new Error(`unexpected executable ${executable}`);
    };
    const controller = new PosixProcessController({
      platform: "darwin",
      io: { runFile, now: () => 1_700_000_000_000 },
    });
    expect(controller.snapshotProcessTable().processes).toEqual([{
      pid: 1,
      ppid: 0,
      pgid: 1,
      sid: null,
      bootIdentity: DARWIN_BOOT,
      startIdentity: "darwin:Fri Jul 11 10:06:16 2025",
    }]);
    expect(calls.map(({ executable, argv }) => ({ executable, argv }))).toEqual([
      { executable: "/usr/sbin/sysctl", argv: ["-n", "kern.boottime"] },
      { executable: "/bin/ps", argv: ["-a", "-x", "-o", "pid=,ppid=,pgid=,sess=,lstart="] },
      { executable: "/usr/sbin/sysctl", argv: ["-n", "kern.boottime"] },
    ]);
    expect(calls.every((call) => call.timeoutMs > 0 && call.maxOutputBytes > 0)).toBe(true);
  });

  it("makes a malformed process observation unprovable, never dead", () => {
    const expected = identity(10, 1, 10, 10, 100);
    const controller = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 10: "malformed" }),
    });
    expect(controller.observeIdentityLiveness(expected)).toMatchObject({
      alive: null,
      reason: "unprovable",
      errorCode: "PARSE_ERROR",
    });
  });

  it("distinguishes ESRCH from EPERM for group liveness", () => {
    const missing = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 10: linuxStat(10, 1, 10, 10, 100) }, () => { throw errno("ESRCH"); }),
    });
    expect(missing.observeGroup(10, LINUX_BOOT)).toMatchObject({ alive: false, reason: "ESRCH", errorCode: "ESRCH" });

    const forbidden = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 10: linuxStat(10, 1, 10, 10, 100) }, () => { throw errno("EPERM"); }),
    });
    expect(forbidden.observeGroup(10, LINUX_BOOT)).toMatchObject({ alive: null, reason: "unprovable", errorCode: "EPERM" });
  });

  it("distinguishes an absent PID from malformed or denied identity observations", () => {
    const expected = identity(10, 1, 10, 10, 100);
    const absent = new PosixProcessController({ platform: "linux", io: linuxIo({ 1: linuxStat(1, 0, 1, 1, 1) }) });
    expect(absent.observeIdentityLiveness(expected)).toMatchObject({ alive: false, reason: "ESRCH" });

    const denied = new PosixProcessController({ platform: "linux", io: linuxIo({ 10: errno("EPERM") }) });
    expect(denied.observeIdentityLiveness(expected)).toMatchObject({ alive: null, reason: "unprovable", errorCode: "EPERM" });
  });

  it("does not interpret a Darwin ps failure as absence without an ESRCH probe", () => {
    const expected: PosixProcessIdentity = {
      pid: 77,
      ppid: 1,
      pgid: 77,
      sid: 77,
      bootIdentity: DARWIN_BOOT,
      startIdentity: "darwin:Thu Jul 17 09:08:07 2026",
    };
    const runFile: PosixIo["runFile"] = (executable) => {
      if (executable === "/usr/sbin/sysctl") return "{ sec = 1700000000, usec = 123456 }";
      throw Object.assign(new Error("ps failed"), { status: 1 });
    };
    const denied = new PosixProcessController({
      platform: "darwin",
      io: { runFile, kill: () => { throw errno("EPERM"); }, now: () => 1_700_000_000_000 },
    });
    expect(denied.observeIdentityLiveness(expected)).toMatchObject({ alive: null, reason: "unprovable", errorCode: "EPERM" });

    const absent = new PosixProcessController({
      platform: "darwin",
      io: { runFile, kill: () => { throw errno("ESRCH"); }, now: () => 1_700_000_000_000 },
    });
    expect(absent.observeIdentityLiveness(expected)).toMatchObject({ alive: false, reason: "ESRCH", errorCode: "ESRCH" });
  });
});

describe("exact descendant identity tracking", () => {
  it("tracks descendants across snapshots even when they create new sessions and groups", () => {
    const root = identity(100, 1, 100, 100, 1000);
    const setsidChild = identity(101, 100, 101, 101, 1001);
    const doubleForkChild = identity(102, 101, 102, 102, 1002);
    const first = updateDescendantTracker(createDescendantTracker(root), snapshot([root, setsidChild]));
    expect(first.status).toBe("observed");
    expect(first.discovered.map(processIdentityKey)).toEqual([processIdentityKey(setsidChild)]);

    // Root has exited, but the already tracked exact child remains a valid seed.
    const second = updateDescendantTracker(first.tracker, snapshot([setsidChild, doubleForkChild]));
    expect(second.status).toBe("observed");
    expect(second.discovered.map(processIdentityKey)).toEqual([processIdentityKey(doubleForkChild)]);
    expect(second.tracker.tracked.map(processIdentityKey)).toEqual([
      processIdentityKey(root),
      processIdentityKey(setsidChild),
      processIdentityKey(doubleForkChild),
    ]);
  });

  it("does not follow a reused root PID", () => {
    const root = identity(100, 1, 100, 100, 1000);
    const reusedRoot = identity(100, 1, 100, 100, 9999);
    const unrelatedChild = identity(101, 100, 100, 100, 1001);
    const result = updateDescendantTracker(createDescendantTracker(root), snapshot([reusedRoot, unrelatedChild]));
    expect(result.live).toEqual([]);
    expect(result.discovered).toEqual([]);
    expect(result.tracker.tracked.map(processIdentityKey)).toEqual([processIdentityKey(root)]);
  });

  it("signals only currently matching tracked PID/start identities", () => {
    const kills: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const root = identity(100, 1, 100, 100, 1000);
    const reused = linuxStat(100, 1, 100, 100, 9999);
    const controller = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 100: reused }, (pid, signal) => { kills.push({ pid, signal }); }),
    });
    controller.trackRoot(root);
    expect(controller.signalTrackedPids("SIGKILL")).toMatchObject({ complete: true, observations: [] });
    expect(kills).toEqual([]);
  });

  it("signals tracked setsid descendants by exact PID in addition to group APIs", () => {
    const kills: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const root = identity(100, 1, 100, 100, 1000);
    const records = {
      100: linuxStat(100, 1, 100, 100, 1000),
      101: linuxStat(101, 100, 101, 101, 1001),
    };
    const controller = new PosixProcessController({
      platform: "linux",
      io: linuxIo(records, (pid, signal) => { kills.push({ pid, signal }); }),
    });
    controller.trackRoot(root);
    const result = controller.signalTrackedPids("SIGTERM");
    expect(result.complete).toBe(true);
    expect(result.observations.map((item) => [item.targetId, item.delivered])).toEqual([[100, true], [101, true]]);
    expect(kills).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
    ]);
  });
});

describe("death proof remains fail closed", () => {
  it("reports sampled tracked-identity death without claiming authoritative descendant death", async () => {
    const root = identity(100, 1, 100, 100, 1000);
    const controller = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 1: linuxStat(1, 0, 1, 1, 1) }, () => { throw errno("ESRCH"); }),
    });
    controller.trackRoot(root);
    await expect(controller.waitForDeath(100, 0)).resolves.toMatchObject({
      groupDead: true,
      proofBasis: "sampled_tracked_identities",
      trackedIdentitiesConfirmedDead: true,
      descendantsConfirmedDead: false,
    });
  });

  it("does not confirm descendant death when process-table parsing fails, even if the group returns ESRCH", async () => {
    const root = identity(100, 1, 100, 100, 1000);
    const controller = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 100: "malformed" }, () => { throw errno("ESRCH"); }),
    });
    controller.trackRoot(root);
    await expect(controller.waitForDeath(100, 0)).resolves.toMatchObject({
      groupDead: true,
      proofBasis: "sampled_tracked_identities",
      trackedIdentitiesConfirmedDead: false,
      descendantsConfirmedDead: false,
      reason: "descendant tracking encountered an observation gap",
    });
  });

  it("never converts EPERM into group death", async () => {
    const root = identity(100, 1, 100, 100, 1000);
    const controller = new PosixProcessController({
      platform: "linux",
      io: linuxIo({ 100: linuxStat(100, 1, 100, 100, 1000) }, () => { throw errno("EPERM"); }),
    });
    controller.trackRoot(root);
    await expect(controller.waitForDeath(100, 0)).resolves.toMatchObject({
      groupDead: false,
      proofBasis: "sampled_tracked_identities",
      trackedIdentitiesConfirmedDead: false,
      descendantsConfirmedDead: false,
    });
  });
});
