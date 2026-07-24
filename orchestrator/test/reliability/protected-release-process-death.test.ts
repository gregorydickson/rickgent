import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  killProcessGroupAndObserve,
  requireProcessGroupDeathObservation,
} from "../../scripts/run-protected-release.mjs";

describe("protected release crash death evidence", () => {
  it("requires SIGKILL and independent process-group absence", () => {
    expect(() => requireProcessGroupDeathObservation({
      code: null,
      signal: "SIGKILL",
      group_absent: true,
    })).not.toThrow();

    for (const observation of [
      { code: 0, signal: null, group_absent: true },
      { code: null, signal: "SIGTERM", group_absent: true },
      { code: null, signal: "SIGKILL", group_absent: false },
    ]) {
      expect(() => requireProcessGroupDeathObservation(observation)).toThrow(
        "process-group death was not independently observed",
      );
    }
  });

  it("kills and independently observes a detached process group", async () => {
    if (process.platform === "win32") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("detached child did not receive a PID");

    const observation = await killProcessGroupAndObserve(child, child.pid, 4_000);
    expect(observation).toEqual({
      code: null,
      signal: "SIGKILL",
      group_absent: true,
    });
  });
});
