import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBehavioralDoctor } from "../../src/lifecycle/behavioral-doctor.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("installed behavioral doctor", () => {
  it("proves all deterministic behaviors and cleans its owned root", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-owned-"));
    roots.push(root);
    const result = runBehavioralDoctor(process.execPath, process.env, {
      makeRoot: () => root,
      runPython: () => JSON.stringify({ native_allow: true, native_deny: true, identity: true, sqlite_reopen: true }),
    });
    expect(result.ok).toBe(true);
    expect(result.authenticated_hosted_evidence).toBe(false);
    expect(result.checks.map((check) => check.check_id)).toEqual([
      "native_allow", "native_deny", "omnigent_identity", "sqlite_reopen",
      "git_containment", "typed_failure", "owned_cleanup",
    ]);
    expect(existsSync(root)).toBe(false);
  });

  it("reports a typed failure and still cleans", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-failure-"));
    roots.push(root);
    const result = runBehavioralDoctor(process.execPath, process.env, {
      makeRoot: () => root,
      runPython: () => { throw new Error("probe failed"); },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.check_id === "typed_failure" && check.outcome === "fail")).toBe(true);
    expect(result.cleaned).toBe(true);
  });

  it("fails closed when owned-root cleanup cannot be observed", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-cleanup-failure-"));
    roots.push(root);
    const result = runBehavioralDoctor(process.execPath, process.env, {
      makeRoot: () => root,
      runPython: () => JSON.stringify({ native_allow: true, native_deny: true, identity: true, sqlite_reopen: true }),
      removeRoot: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({ check_id: "owned_cleanup", outcome: "fail" });
  });
});
