import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const rickgentBin = "rickgent";

describe("CLI commands", () => {
  it("--version prints version and build commit", () => {
    const out = execSync(`${rickgentBin} --version`, { encoding: "utf-8" });
    expect(out).toContain("rickgent");
    expect(out).toContain("0.1.0-alpha");
  });

  it("--build-commit prints commit hash", () => {
    const out = execSync(`${rickgentBin} --build-commit`, { encoding: "utf-8" }).trim();
    expect(out.length).toBeGreaterThan(0);
  });

  it("--help shows usage", () => {
    const out = execSync(`${rickgentBin} --help`, { encoding: "utf-8" });
    expect(out).toContain("verdict");
    expect(out).toContain("doctor");
    expect(out).toContain("status");
  });

  it("verdict completion --json works", () => {
    const out = execSync(
      `echo '{"claimedSha":null,"baselineSha":"abc","shaExists":false,"treeChanged":false,"gateGreen":null}' | ${rickgentBin} verdict completion --json`,
      { encoding: "utf-8" }
    );
    const result = JSON.parse(out);
    expect(result.verdict).toBe("UNVERIFIED");
  });

  it("doctor exits 0 on clean state", () => {
    const result = execSync(`${rickgentBin} doctor`, { encoding: "utf-8" });
    expect(result).toContain("All checks passed");
  });

  it("status prints pipeline status", () => {
    const result = execSync(`${rickgentBin} status`, { encoding: "utf-8" });
    expect(result).toContain("pipeline");
  });

  it("status --deep runs doctor + status", () => {
    const result = execSync(`${rickgentBin} status --deep`, { encoding: "utf-8" });
    expect(result).toContain("doctor") ;
  });

  it("status exits 0 with an empty table on an empty-object registry", () => {
    const tmp = join(tmpdir(), `rickgent-status-empty-${Date.now()}`);
    const rickgentDir = join(tmp, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    try {
      writeFileSync(join(rickgentDir, "registry.json"), "{}");
      const result = execSync(`${rickgentBin} status`, {
        encoding: "utf-8",
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      });
      expect(result).toContain("pipeline");
      expect(result).toContain("tickets: 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("status exits 0 with an empty table on a truncated/malformed registry", () => {
    const tmp = join(tmpdir(), `rickgent-status-malformed-${Date.now()}`);
    const rickgentDir = join(tmp, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    try {
      writeFileSync(join(rickgentDir, "registry.json"), '{"runId":"run-x","tickets":');
      const result = execSync(`${rickgentBin} status`, {
        encoding: "utf-8",
        env: { ...process.env, RICKGENT_DIR: rickgentDir },
      });
      expect(result).toContain("pipeline");
      expect(result).toContain("tickets: 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reconcile prints reconciliation result", () => {
    const tmp = join(tmpdir(), `rickgent-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      execSync("git init", { cwd: tmp, timeout: 5000 });
      writeFileSync(join(tmp, "test.txt"), "test");
      execSync("git add .", { cwd: tmp, timeout: 5000 });
      execSync('git commit -m "ticket: T1 test commit"', { cwd: tmp, timeout: 5000 });
      const result = execSync(`${rickgentBin} reconcile`, {
        encoding: "utf-8",
        cwd: tmp,
        timeout: 10000,
        env: { ...process.env, RICKGENT_DIR: join(tmp, ".rickgent") },
      });
      expect(result).toContain("reconcile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
