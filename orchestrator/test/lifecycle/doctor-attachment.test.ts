import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const rickgentBin = "rickgent";

// Repo root: orchestrator/test/lifecycle → ../../.. = rickgent/
const repoRoot = new URL("../../../", import.meta.url).pathname;
const realManager = join(repoRoot, "agents", "rickgent");
const realWorker = join(realManager, "agents", "worker");

function runDoctor(env: NodeJS.ProcessEnv): { code: number; out: string } {
  try {
    const out = execSync(`${rickgentBin} doctor`, {
      encoding: "utf-8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("doctor policy-attachment audit (VAL-ATTACH-016/017)", () => {
  it("VAL-ATTACH-017: exits 0 and reports attachment PASS with the full required set", () => {
    const { code, out } = runDoctor({ ...process.env });
    expect(code).toBe(0);
    expect(out).toContain("policy_attachment");
    expect(out).toMatch(/\[PASS\] policy_attachment/);
  });

  it("VAL-ATTACH-016: exits non-zero and names the missing policy when a required worker policy is dropped", () => {
    const tmp = join(tmpdir(), `rickgent-doctor-attach-${Date.now()}`);
    const mgrCopy = join(tmp, "agents", "rickgent");
    const wkrCopy = join(mgrCopy, "agents", "worker");
    mkdirSync(tmp, { recursive: true });
    try {
      cpSync(realManager, mgrCopy, { recursive: true });
      // Drop `scope_fence` from the worker bundle's guardrails block.
      const wkrConfig = join(wkrCopy, "config.yaml");
      const original = readFileSync(wkrConfig, "utf-8");
      const mutated = original.replace(
        /    scope_fence:\n      type: function\n      function:\n        path: rickgent_policies\.scope_fence\n/,
        "",
      );
      expect(mutated).not.toBe(original);
      writeFileSync(wkrConfig, mutated);

      const { code, out } = runDoctor({
        ...process.env,
        RICKGENT_MANAGER_DIR: mgrCopy,
        RICKGENT_WORKER_DIR: wkrCopy,
      });
      expect(code).not.toBe(0);
      expect(out).toMatch(/\[FAIL\] policy_attachment/);
      expect(out).toContain("scope_fence");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("VAL-ATTACH-016: exits non-zero when a required manager policy is dropped", () => {
    const tmp = join(tmpdir(), `rickgent-doctor-attach-mgr-${Date.now()}`);
    const mgrCopy = join(tmp, "agents", "rickgent");
    const wkrCopy = join(mgrCopy, "agents", "worker");
    mkdirSync(tmp, { recursive: true });
    try {
      cpSync(realManager, mgrCopy, { recursive: true });
      const mgrConfig = join(mgrCopy, "config.yaml");
      const original = readFileSync(mgrConfig, "utf-8");
      const mutated = original.replace(
        /    autonomous_pr_flow:\n      type: function\n      function:\n        path: rickgent_policies\.autonomous_pr_flow\n/,
        "",
      );
      expect(mutated).not.toBe(original);
      writeFileSync(mgrConfig, mutated);

      const { code, out } = runDoctor({
        ...process.env,
        RICKGENT_MANAGER_DIR: mgrCopy,
        RICKGENT_WORKER_DIR: wkrCopy,
      });
      expect(code).not.toBe(0);
      expect(out).toMatch(/\[FAIL\] policy_attachment/);
      expect(out).toContain("autonomous_pr_flow");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
