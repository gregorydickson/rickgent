import { describe, it, expect } from "vitest";
import {
  shouldReap,
  detectBackend,
  killProcessGroup,
  parseWorkerProcsFromPs,
  reapOrphanedWorkerProcs,
  type SandboxBackend,
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
