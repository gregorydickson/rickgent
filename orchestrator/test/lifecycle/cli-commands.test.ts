import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

const cliPath = join(import.meta.dirname, "../../dist/cli.js");
const stateStorePath = join(import.meta.dirname, "../../dist/state/store.js");
const projectRoot = join(import.meta.dirname, "../../..");

function run(args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {}): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: options.env,
    cwd: options.cwd,
    input: options.input,
  });
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
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

  it("rejects the non-public protected lifecycle entrypoint without installed authority", () => {
    const result = spawnSync(process.execPath, [cliPath, "__protected-release", "execute"], { encoding: "utf-8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("internal protected release authority is invalid");
    expect(run(["--help"])).not.toContain("__protected-release");
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
    const result = run(["status"], { cwd: projectRoot });
    expect(result).toContain("SQLite lifecycle");
  });

  it("status --deep runs the read-only health audit", () => {
    const result = spawnSync(process.execPath, [cliPath, "status", "--deep"], { encoding: "utf-8", cwd: projectRoot });
    expect(result.stdout).toContain("read-only health and configured-attachment audit");
    expect(result.status).toBe(0);
  });

  it("status reports absent SQLite state without creating it or consulting an empty registry", () => {
    const tmp = join(tmpdir(), `rickgent-status-empty-${Date.now()}`);
    const rickgentDir = join(tmp, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    try {
      initRepo(tmp);
      writeFileSync(join(rickgentDir, "registry.json"), "{}");
      const result = run(["status"], { cwd: tmp, env: { ...process.env, RICKGENT_DIR: rickgentDir } });
      expect(result).toContain("state: absent");
      expect(result).toContain("tickets: (unavailable)");
      expect(existsSync(join(tmp, ".git", "rickgent"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("status ignores a hostile legacy Done claim", () => {
    const tmp = join(tmpdir(), `rickgent-status-malformed-${Date.now()}`);
    const rickgentDir = join(tmp, ".rickgent");
    mkdirSync(rickgentDir, { recursive: true });
    try {
      initRepo(tmp);
      writeFileSync(join(rickgentDir, "registry.json"), JSON.stringify({
        runId: "hostile-run",
        tickets: { hostile: { status: "Done", completionCommitSha: "f".repeat(40) } },
      }));
      const result = run(["status"], { cwd: tmp, env: { ...process.env, RICKGENT_DIR: rickgentDir } });
      expect(result).toContain("state: absent");
      expect(result).toContain("tickets: (unavailable)");
      expect(result).not.toContain("hostile-run");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ["RICKGENT_LEGACY_STATE_QUARANTINED", 4],
    ["RICKGENT_STATE_RESUME_INCOMPATIBLE", 2],
  ])("maps %s through the stable state-store CLI boundary", (code, exitCode) => {
    const script = [
      `import { handleFatal } from ${JSON.stringify(pathToFileURL(cliPath).href)};`,
      `import { StateStoreError } from ${JSON.stringify(pathToFileURL(stateStorePath).href)};`,
      `handleFatal(new StateStoreError(${JSON.stringify(code)}, "state failure", { recovery: "recover safely" }));`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" });
    expect(result.status).toBe(exitCode);
    expect(result.stderr).toContain(`${code}: state failure`);
    expect(result.stderr).toContain("recovery: recover safely");
    expect(result.stderr).not.toContain("RICKGENT_INTERNAL_ERROR");
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
      // reconciliation is activated (t29); reconcile passes the gate and
      // returns ok with 0 tickets (no state store to reconcile from).
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("rebuilt=false");
      expect(result.stdout).toContain("ticketsFound=0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
