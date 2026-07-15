import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_NAMES,
  CapabilityUnavailableError,
  InputContractError,
  PRODUCTION_CAPABILITY_GATE,
  REJECTED_PRODUCTION_BYPASSES,
  assertNoProductionBypasses,
  capabilityRegistry,
} from "../../src/capabilities/registry.js";
import { Dispatcher, DispatchLedger, TicketLock } from "../../src/dispatch/dispatch.js";
import { DispatchQueue } from "../../src/dispatch/queue.js";
import { runBuild, type BuildOptions } from "../../src/lifecycle/build.js";
import { runConformanceGate } from "../../src/lifecycle/citadel.js";
import { MicroverseLoop } from "../../src/lifecycle/microverse.js";
import { runMicroverseCommand } from "../../src/lifecycle/microverse-cli.js";
import { ensureBranch } from "../../src/lifecycle/pr-flow.js";
import { runPrdCommand } from "../../src/lifecycle/prd-interview.js";
import { reconcile } from "../../src/lifecycle/reconcile.js";
import { routeDispatch, type ModelEntry } from "../../src/lifecycle/routing.js";

const CLI = join(import.meta.dirname, "../../dist/cli.js");
const roots: string[] = [];

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of REJECTED_PRODUCTION_BYPASSES) delete env[name];
  return env;
}

function cli(args: string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8", env });
}

function buildOptions(root: string): BuildOptions {
  return {
    prdPath: join(root, "missing.md"),
    workingDir: root,
    rickgentDir: join(root, ".rickgent"),
    agentDir: join(root, "agent"),
    dataDir: join(root, "data"),
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("M1 capability contraction", () => {
  it("publishes the frozen typed registry through doctor JSON and startup output", () => {
    const entries = capabilityRegistry();
    expect(entries.map((entry) => entry.name)).toEqual(CAPABILITY_NAMES);
    expect(entries.map((entry) => entry.state)).toEqual([
      "fixture_only",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    for (const entry of entries) {
      expect(entry.error_code).toMatch(/^RICKGENT_/);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.proof_version.length).toBeGreaterThan(0);
    }

    const doctor = cli(["doctor", "--json"]);
    const json = JSON.parse(doctor.stdout);
    expect(json.schema_version).toBe("1.0.0");
    expect(json.release_channel).toBe("reliability_preview");
    expect(json.capabilities).toEqual(entries);
    expect(json.terminal_semantics.delivered).toBe("remote_delivery_verified");
    expect(json.toolchain.node.status).toMatch(/pass|fail/);

    const startup = cli(["build", join(tempRoot("cap-startup"), "missing.md")]);
    expect(startup.status).toBe(3);
    for (const entry of entries) {
      expect(startup.stdout).toContain(`${entry.name}: state=${entry.state}`);
      expect(startup.stdout).toContain(entry.error_code);
    }
  });

  it("returns stable nonzero capability errors before filesystem or subprocess work", async () => {
    const root = tempRoot("cap-boundary");
    const opts = buildOptions(root);
    await expect(runBuild(opts)).rejects.toMatchObject({
      exitCode: 3,
      capability: { name: "autonomous_dispatch", error_code: "RICKGENT_AUTONOMOUS_FIXTURE_ONLY" },
    });
    expect(existsSync(opts.rickgentDir)).toBe(false);

    const resume = cli(["build", "--resume"]);
    expect(resume.status).toBe(3);
    expect(resume.stderr).toContain("RICKGENT_RESUME_UNAVAILABLE");

    const parallel = cli(["build", opts.prdPath, "--max-concurrent", "2"]);
    expect(parallel.status).toBe(2);
    expect(parallel.stderr).toContain("--max-concurrent must be exactly 1");

    for (const args of [["--feature", "topic"], ["--no-autonomous-pr"]]) {
      const delivery = cli(["build", opts.prdPath, ...args]);
      expect(delivery.status).toBe(3);
      expect(delivery.stderr).toContain("RICKGENT_DELIVERY_UNAVAILABLE");
    }

    const raw = cli(["build", opts.prdPath, "--raw-shell"]);
    expect(raw.status).toBe(3);
    expect(raw.stderr).toContain("RICKGENT_RAW_SHELL_UNAVAILABLE");

    const rec = cli(["reconcile"]);
    expect(rec.status).toBe(3);
    expect(rec.stderr).toContain("RICKGENT_RECONCILIATION_UNAVAILABLE");
  });

  it("guards direct dispatch, queue, reconcile, review, delivery, and raw-shell boundaries", async () => {
    const root = tempRoot("cap-direct");
    const state = join(root, "state");
    const ledger = new DispatchLedger(join(state, "dispatch.jsonl"));
    const lock = new TicketLock(join(state, "locks"));
    const dispatcher = new Dispatcher(ledger, lock, state);
    await expect(dispatcher.dispatch(
      { runId: "r", ticketId: "t", phase: "implement", attempt: 1, role: "worker" },
      { agentDir: root, prompt: "x", timeout: 1, maxConcurrent: 1 },
    )).rejects.toBeInstanceOf(CapabilityUnavailableError);

    expect(() => new DispatchQueue(ledger, 2)).toThrow("maxConcurrent must be exactly 1");
    expect(() => reconcile(root, state)).toThrow("RICKGENT_RECONCILIATION_UNAVAILABLE");

    const roster: ModelEntry[] = [{
      harness: "codex",
      model: "openai/gpt-5",
      vendor: "openai",
      tier: "capable",
      pricing: { cost_per_dispatch: 1 },
    }];
    expect(() => routeDispatch(roster, "code_review", { implementerVendor: "anthropic" }))
      .toThrow("RICKGENT_CROSS_VENDOR_UNAVAILABLE");
    expect(() => ensureBranch(root, "topic")).toThrow("RICKGENT_DELIVERY_UNAVAILABLE");
    expect(() => runConformanceGate([], root, cleanEnv())).toThrow("RICKGENT_RAW_SHELL_UNAVAILABLE");
    await expect(runMicroverseCommand(["--metric", "echo 1", "--task", "improve"]))
      .rejects.toThrow("RICKGENT_RAW_SHELL_UNAVAILABLE");
    await expect(new MicroverseLoop({
      workingDir: root,
      ownedPaths: ["."],
      metricCommand: "echo 1",
      workerArgv: () => ["sh", "-c", "true"],
      maxIterations: 1,
      iterationDeadlineMs: 100,
    }).run()).rejects.toThrow("RICKGENT_RAW_SHELL_UNAVAILABLE");
    await expect(runPrdCommand([])).rejects.toThrow("RICKGENT_AUTONOMOUS_FIXTURE_ONLY");
  });

  it("rejects unknown, malformed, duplicate, and advertised-but-unparsed CLI flags", () => {
    for (const args of [
      ["--version", "--unknown"],
      ["status", "--unknown"],
      ["doctor", "--json", "--json"],
      ["build", "x.md", "--max-concurrent"],
      ["build", "x.md", "--max-concurrent", "2junk"],
      ["build", "x.md", "--max-iterations", "1"],
      ["microverse", "--metric", "echo 1", "--task", "x", "--max-iterations", "2junk"],
      ["refine", "x.md", "--cycles", "1junk"],
      ["doctor", "--help", "--json"],
    ]) {
      const result = cli(args);
      expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("RICKGENT_INPUT_CONTRACT_ERROR");
    }
  });

  it("parses read-only command help instead of ignoring or capability-gating it", () => {
    for (const command of ["doctor", "status", "metrics", "reconcile", "verdict"]) {
      const result = cli([command, "--help"]);
      expect(result.status, `${command}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`rickgent ${command}`);
    }
  });

  it("rejects production environment bypasses without changing capability outcomes", async () => {
    const baseline = JSON.stringify(capabilityRegistry());
    const baselineErrors = CAPABILITY_NAMES.map((name) => {
      try {
        PRODUCTION_CAPABILITY_GATE.require(name);
        return "enabled";
      } catch (error) {
        return (error as CapabilityUnavailableError).capability.error_code;
      }
    });

    const env = cleanEnv(Object.fromEntries(REJECTED_PRODUCTION_BYPASSES.map((name) => [name, "1"])));
    expect(() => assertNoProductionBypasses(env)).not.toThrow();
    for (const name of REJECTED_PRODUCTION_BYPASSES) env[name] = "1";
    expect(() => assertNoProductionBypasses(env)).toThrow(InputContractError);
    expect(JSON.stringify(capabilityRegistry())).toBe(baseline);
    expect(CAPABILITY_NAMES.map((name) => {
      try {
        PRODUCTION_CAPABILITY_GATE.require(name);
        return "enabled";
      } catch (error) {
        return (error as CapabilityUnavailableError).capability.error_code;
      }
    })).toEqual(baselineErrors);

    const root = tempRoot("cap-env");
    const stateDir = join(root, ".rickgent");
    writeFileSync(join(root, "capabilities.json"), JSON.stringify({ autonomous_dispatch: "enabled" }));
    const result = cli(["build", join(root, "missing.md")], env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("retired production bypass");
    expect(existsSync(stateDir)).toBe(false);

    await expect(runBuild({ ...buildOptions(root), env })).rejects.toBeInstanceOf(InputContractError);

    const productionSources = execFileSync("rg", ["-l", "RICKGENT_SKIP_", "src"], {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);
    expect(productionSources).toEqual(["src/capabilities/registry.ts"]);
    expect(readFileSync(join(import.meta.dirname, "../../src/capabilities/registry.ts"), "utf-8"))
      .toContain("retired production controls");
  });
});
