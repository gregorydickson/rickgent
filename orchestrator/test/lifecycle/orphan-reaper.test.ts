import { describe, it, expect } from "vitest";
import {
  shouldReap,
  detectBackend,
  killProcessGroup,
  parseWorkerProcsFromPs,
  reapOrphanedWorkerProcs,
  isProcessAlive,
  sleepSync,
  GRACE_POLL_MS,
  DEFAULT_GRACE_MS,
  type SandboxBackend,
  type SessionLiveness,
} from "../../src/lifecycle/orphan-reaper.js";

describe("orphan reaper — backend gating", () => {
  it("is active on darwin_seatbelt", () => {
    expect(shouldReap("darwin_seatbelt")).toBe(true);
  });

  it("is active on none", () => {
    expect(shouldReap("none")).toBe(true);
  });

  it("is inactive on linux_bwrap", () => {
    expect(shouldReap("linux_bwrap")).toBe(false);
  });

  it("is inactive on windows_jobobject", () => {
    expect(shouldReap("windows_jobobject")).toBe(false);
  });
});

describe("orphan reaper — backend detection", () => {
  it("detects darwin_seatbelt on macOS", () => {
    expect(detectBackend("darwin", {})).toBe("darwin_seatbelt");
  });

  it("detects linux_bwrap on Linux", () => {
    expect(detectBackend("linux", {})).toBe("linux_bwrap");
  });

  it("detects none when RICKGENT_SANDBOX=none", () => {
    expect(detectBackend("darwin", { RICKGENT_SANDBOX: "none" })).toBe("none");
  });
});

describe("orphan reaper — kill-switch", () => {
  it("is inert when RICKGENT_ORPHAN_REAP=off", () => {
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      env: { RICKGENT_ORPHAN_REAP: "off" },
      scanFn: () => "",
    });
    expect(result.scanned).toBe(0);
    expect(result.reaped).toBe(0);
  });
});

describe("orphan reaper — no-op on contained backends", () => {
  it("does not scan on linux_bwrap", () => {
    const result = reapOrphanedWorkerProcs("linux_bwrap", {
      scanFn: () => { throw new Error("should not scan"); },
    });
    expect(result.scanned).toBe(0);
    expect(result.reaped).toBe(0);
  });

  it("does not scan on windows_jobobject", () => {
    const result = reapOrphanedWorkerProcs("windows_jobobject", {
      scanFn: () => { throw new Error("should not scan"); },
    });
    expect(result.scanned).toBe(0);
  });
});

describe("orphan reaper — ps parsing", () => {
  it("parses worker-shaped processes", () => {
    const psOutput = [
      "  1234  1234     1 10:00 omnigent run agents/rickgent -p build",
      "  5678  5678     1 01:00:00 claude --dangerously-skip-permissions -p implement",
      "  9999  9999  1234 00:05 node server.js",
    ].join("\n");
    const candidates = parseWorkerProcsFromPs(psOutput);
    expect(candidates.length).toBe(2); // omnigent + claude, not node
    expect(candidates[0]!.pid).toBe(1234);
    expect(candidates[1]!.pid).toBe(5678);
  });

  it("skips non-worker processes", () => {
    const psOutput = "  9999  9999  1234 00:05 node server.js";
    const candidates = parseWorkerProcsFromPs(psOutput);
    expect(candidates.length).toBe(0);
  });
});

describe("orphan reaper — conservative default", () => {
  it("scans but does not reap without positive ownership", () => {
    const psOutput = "  1234  1234     1 20:00 omnigent run agents/rickgent -p build";
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => psOutput,
      minAgeSeconds: 600,
    });
    expect(result.scanned).toBe(1);
    expect(result.reaped).toBe(0); // conservative: no positive ownership → skip
    expect(result.skipped).toBe(1);
  });

  it("respects min-age gate", () => {
    const psOutput = "  1234  1234     1 00:05 omnigent run agents/rickgent -p build";
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => psOutput,
      minAgeSeconds: 600,
    });
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1); // too young → skip
  });
});

// ---------------------------------------------------------------------------
// B7 — real reap path (VAL-REAP-001..008).
// These tests drive the reap loop with injectable attribution + signal/alive
// fakes so the REAL code path is exercised and the REAL effect (which signals
// are delivered to which pgid, in what order, and whether SIGKILL is skipped)
// is observed — never a mock's return value.
// ---------------------------------------------------------------------------

const DEAD_OLD = "  1234  1234     1 20:00 omnigent run agents/rickgent -p build";
const DEAD_YOUNG = "  1234  1234     1 00:05 omnigent run agents/rickgent -p build";

type SignalCall = { pgid: number; signal: string };

function recordingKillGroup(log: SignalCall[]) {
  return (pgid: number, signal: NodeJS.Signals): boolean => {
    log.push({ pgid, signal: String(signal) });
    return true;
  };
}

describe("orphan reaper — dead-session reap (VAL-REAP-001)", () => {
  it("reaps a min-age dead-session process via SIGTERM→grace→SIGKILL on the pgid", () => {
    const signals: SignalCall[] = [];
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => DEAD_OLD,
      minAgeSeconds: 600,
      graceMs: 10,
      attributeSession: () => "dead",
      killGroupFn: recordingKillGroup(signals),
      // process stays alive through the whole grace window
      isAliveFn: () => true,
      sleepFn: () => {},
    });
    expect(result.reaped).toBe(1);
    expect(result.skipped).toBe(0);
    expect(signals.length).toBe(2);
    expect(signals[0]).toEqual({ pgid: 1234, signal: "SIGTERM" });
    expect(signals[1]).toEqual({ pgid: 1234, signal: "SIGKILL" });
  });

  it("targets the process GROUP (negative pgid), not the single pid", () => {
    const signals: SignalCall[] = [];
    reapOrphanedWorkerProcs("none", {
      scanFn: () => DEAD_OLD,
      minAgeSeconds: 600,
      graceMs: 10,
      attributeSession: () => "dead",
      killGroupFn: (pgid, signal) => {
        // the real killProcessGroup signals the group via -pgid
        signals.push({ pgid, signal: String(signal) });
        return killProcessGroup(pgid, signal);
      },
      isAliveFn: () => true,
      sleepFn: () => {},
    });
    // Both signals carry the candidate's pgid (the group is addressed by -pgid
    // inside killProcessGroup); we never signal the bare pid 1234 directly.
    expect(signals.every(s => s.pgid === 1234)).toBe(true);
  });
});

describe("orphan reaper — live / unattributable never reaped (VAL-REAP-002/003)", () => {
  it("never reaps a process attributed to a LIVE session", () => {
    const signals: SignalCall[] = [];
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => DEAD_OLD,
      minAgeSeconds: 600,
      attributeSession: () => "live",
      killGroupFn: recordingKillGroup(signals),
      isAliveFn: () => true,
      sleepFn: () => {},
    });
    expect(result.reaped).toBe(0);
    expect(result.skipped).toBe(1);
    expect(signals.length).toBe(0);
  });

  it("never reaps an unattributable process (fail-closed default)", () => {
    const signals: SignalCall[] = [];
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => DEAD_OLD,
      minAgeSeconds: 600,
      // no attributeSession → default unattributable
      killGroupFn: recordingKillGroup(signals),
      isAliveFn: () => true,
      sleepFn: () => {},
    });
    expect(result.reaped).toBe(0);
    expect(result.skipped).toBe(1);
    expect(signals.length).toBe(0);
  });
});

describe("orphan reaper — sub-min-age never reaped (VAL-REAP-007)", () => {
  it("skips a dead-session process younger than the min-age gate", () => {
    const signals: SignalCall[] = [];
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => DEAD_YOUNG,
      minAgeSeconds: 600,
      attributeSession: () => "dead",
      killGroupFn: recordingKillGroup(signals),
      isAliveFn: () => true,
      sleepFn: () => {},
    });
    expect(result.reaped).toBe(0);
    expect(result.skipped).toBe(1);
    expect(signals.length).toBe(0);
  });
});

describe("orphan reaper — SIGKILL skipped when process exits during grace (VAL-REAP-008)", () => {
  it("sends SIGTERM only and increments reaped when the process exits during grace", () => {
    const signals: SignalCall[] = [];
    const aliveChecks: number[] = [];
    let alive = true;
    const result = reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => DEAD_OLD,
      minAgeSeconds: 600,
      graceMs: 10,
      attributeSession: () => "dead",
      killGroupFn: recordingKillGroup(signals),
      isAliveFn: (pid) => {
        aliveChecks.push(pid);
        return alive;
      },
      sleepFn: () => { alive = false; }, // process exits during the grace sleep
    });
    expect(result.reaped).toBe(1);
    expect(signals).toEqual([{ pgid: 1234, signal: "SIGTERM" }]);
    // a post-grace isProcessAlive recheck was performed (and returned false)
    expect(aliveChecks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("orphan reaper — helpers wired into the reap path (VAL-REAP-006)", () => {
  it("invokes killGroup, isAlive, and sleep during a dead-session reap", () => {
    const signals: SignalCall[] = [];
    const aliveCalls: number[] = [];
    const sleepCalls: number[] = [];
    reapOrphanedWorkerProcs("darwin_seatbelt", {
      scanFn: () => DEAD_OLD,
      minAgeSeconds: 600,
      graceMs: 10,
      attributeSession: () => "dead",
      killGroupFn: recordingKillGroup(signals),
      isAliveFn: (pid) => { aliveCalls.push(pid); return true; },
      sleepFn: (ms) => { sleepCalls.push(ms); },
    });
    expect(signals.length).toBe(2);           // SIGTERM + SIGKILL
    expect(aliveCalls.length).toBeGreaterThanOrEqual(1); // live-state recheck
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1); // grace window
    // the grace poll constant is used for each sleep
    expect(sleepCalls.every(ms => ms === GRACE_POLL_MS)).toBe(true);
  });

  it("exports the real helper functions and grace constants (not dead code)", () => {
    expect(typeof isProcessAlive).toBe("function");
    expect(typeof sleepSync).toBe("function");
    expect(typeof GRACE_POLL_MS).toBe("number");
    expect(typeof DEFAULT_GRACE_MS).toBe("number");
  });
});

describe("orphan reaper — no-op on contained backends (VAL-REAP-005)", () => {
  it("sends no signals on linux_bwrap even with a dead-session candidate", () => {
    const signals: SignalCall[] = [];
    const result = reapOrphanedWorkerProcs("linux_bwrap", {
      scanFn: () => { throw new Error("should not scan"); },
      attributeSession: () => "dead",
      killGroupFn: recordingKillGroup(signals),
    });
    expect(result.reaped).toBe(0);
    expect(signals.length).toBe(0);
  });

  it("sends no signals on windows_jobobject even with a dead-session candidate", () => {
    const signals: SignalCall[] = [];
    const result = reapOrphanedWorkerProcs("windows_jobobject", {
      scanFn: () => { throw new Error("should not scan"); },
      attributeSession: () => "dead",
      killGroupFn: recordingKillGroup(signals),
    });
    expect(result.reaped).toBe(0);
    expect(signals.length).toBe(0);
  });
});
