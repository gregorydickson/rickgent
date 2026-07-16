import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { doctorJson } from "../../src/commands/doctor.js";

const cliPath = join(import.meta.dirname, "../../dist/cli.js");

// Repo root: orchestrator/test/lifecycle → ../../.. = rickgent/
const repoRoot = new URL("../../../", import.meta.url).pathname;
const realManager = join(repoRoot, "agents", "rickgent");
const realWorker = join(realManager, "agents", "worker");

function runDoctor(env: NodeJS.ProcessEnv, asJson = false): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [cliPath, "doctor", ...(asJson ? ["--json"] : [])], {
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
  it("fails aggregate health when the runtime toolchain is unsupported", () => {
    const unsupportedNode = doctorJson(
      { ok: true, report: "fixture health passed" },
      {
        nodeVersion: "23.9.0",
        pythonVersion: "3.14.3",
        packageManager: "pnpm@10.22.0",
        lockfileVersion: "9.0",
        platform: "darwin",
      },
    );
    expect(unsupportedNode.toolchain.node.status).toBe("fail");
    expect(unsupportedNode.health.ok).toBe(false);

    const unsupportedPlatform = doctorJson(
      { ok: true, report: "fixture health passed" },
      {
        nodeVersion: "24.13.1",
        pythonVersion: "3.14.3",
        packageManager: "pnpm@10.22.0",
        lockfileVersion: "9.0",
        platform: "win32",
      },
    );
    expect(unsupportedPlatform.toolchain.platform.status).toBe("fail");
    expect(unsupportedPlatform.health.ok).toBe(false);

    for (const [field, runtime] of [
      ["python", {
        nodeVersion: "24.13.1",
        pythonVersion: "3.15.0",
        packageManager: "pnpm@10.22.0",
        lockfileVersion: "9.0",
        platform: "darwin" as const,
      }],
      ["package_manager", {
        nodeVersion: "24.13.1",
        pythonVersion: "3.14.3",
        packageManager: "pnpm@10.21.0",
        lockfileVersion: "9.0",
        platform: "darwin" as const,
      }],
      ["lockfile", {
        nodeVersion: "24.13.1",
        pythonVersion: "3.14.3",
        packageManager: "pnpm@10.22.0",
        lockfileVersion: "8.0",
        platform: "darwin" as const,
      }],
    ] as const) {
      const payload = doctorJson({ ok: true, report: "fixture health passed" }, runtime);
      expect(payload.toolchain[field].status).toBe("fail");
      expect(payload.health.ok).toBe(false);
    }
  });

  it("VAL-ATTACH-017: exits 0 and reports attachment PASS with the full required set", () => {
    const { code, out } = runDoctor({ ...process.env });
    expect(code).toBe(0);
    expect(out).toContain("Rickgent reliability preview");
    expect(out).toContain("configured attachment audit only");
    expect(out).toContain("not proof of native production enforcement");
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

      const jsonResult = runDoctor({
        ...process.env,
        RICKGENT_MANAGER_DIR: mgrCopy,
        RICKGENT_WORKER_DIR: wkrCopy,
      }, true);
      expect(jsonResult.code).not.toBe(0);
      const json = JSON.parse(jsonResult.out) as {
        health: { ok: boolean };
        attachment_semantics: string;
      };
      expect(json.health.ok).toBe(false);
      expect(json.attachment_semantics).toBe("configured_attachment_audit_only");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
