import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const cliPath = join(import.meta.dirname, "../../dist/cli.js");

function run(args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {}): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: options.env,
    cwd: options.cwd,
    input: options.input,
  });
}

describe("CLI commands", () => {
  it("--version prints version and build commit", () => {
    const out = run(["--version"]);
    expect(out).toContain("rickgent");
    expect(out).toContain("0.1.0-alpha");
  });

  it("--build-commit prints commit hash", () => {
    const out = run(["--build-commit"]).trim();
    expect(out.length).toBeGreaterThan(0);
  });

  it("--help shows usage", () => {
    const out = run(["--help"]);
    expect(out).toContain("verdict");
    expect(out).toContain("doctor");
    expect(out).toContain("status");
  });

  it("build --help exits 0 and prints build help referencing the gates", () => {
    const out = run(["build", "--help"]);
    expect(out).toContain("rickgent build");
    expect(out).toContain("--resume");
    expect(out).toContain("Rickgent reliability preview");
    expect(out).toContain("RICKGENT_CAPABILITY_UNAVAILABLE");
  });

  it("pipeline --help exits 0 and prints pipeline help", () => {
    const out = run(["pipeline", "--help"]);
    expect(out).toContain("rickgent pipeline");
    expect(out).toContain("Rickgent reliability preview");
    expect(out).toContain("public lifecycle mutation is unavailable");
  });

  it("verdict completion --json works", () => {
    const out = run(["verdict", "completion", "--json"], {
      input: '{"claimedSha":null,"baselineSha":"abc","shaExists":false,"treeChanged":false,"gateGreen":null}',
    });
    const result = JSON.parse(out);
    expect(result.verdict).toBe("UNVERIFIED");
  });

  it("doctor reports behavioral health and capabilities", () => {
    const result = spawnSync(process.execPath, [cliPath, "doctor"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Compiled capability registry");
  });

  it("status prints pipeline status", () => {
    const result = run(["status"]);
    expect(result).toContain("pipeline");
  });

  it("status --deep runs the read-only health audit", () => {
    const result = spawnSync(process.execPath, [cliPath, "status", "--deep"], { encoding: "utf-8" });
    expect(result.stdout).toContain("read-only health and configured-attachment audit");
    expect(result.status).toBe(0);
  });

  it("status exits 0 with an empty table on an empty-object registry", () => {
    const tmp = join(tmpdir(), `rickgent-status-empty-${Date.now()}`);
    const rickgentDir = join(tmp, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    try {
      writeFileSync(join(rickgentDir, "registry.json"), "{}");
      const result = run(["status"], { env: { ...process.env, RICKGENT_DIR: rickgentDir } });
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
      const result = run(["status"], { env: { ...process.env, RICKGENT_DIR: rickgentDir } });
      expect(result).toContain("pipeline");
      expect(result).toContain("tickets: 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reconcile fails with its stable unavailable capability", () => {
    const tmp = join(tmpdir(), `rickgent-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      execFileSync("git", ["init"], { cwd: tmp, timeout: 5000 });
      writeFileSync(join(tmp, "test.txt"), "test");
      execFileSync("git", ["add", "."], { cwd: tmp, timeout: 5000 });
      execFileSync("git", ["commit", "-m", "ticket: T1 test commit"], { cwd: tmp, timeout: 5000 });
      const result = spawnSync(process.execPath, [cliPath, "reconcile"], {
        encoding: "utf-8",
        cwd: tmp,
        timeout: 10000,
        env: { ...process.env, RICKGENT_DIR: join(tmp, ".rickgent") },
      });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("RICKGENT_RECONCILIATION_UNAVAILABLE");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
