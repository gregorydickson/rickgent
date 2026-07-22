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
import { DispatchLedger } from "../../src/dispatch/dispatch.js";
import { DispatchQueue } from "../../src/dispatch/queue.js";
import { runBuild, type BuildOptions } from "../../src/lifecycle/build.js";
import { runConformanceGate } from "../../src/lifecycle/citadel.js";
import { MicroverseLoop } from "../../src/lifecycle/microverse.js";
import { runMicroverseCommand } from "../../src/lifecycle/microverse-cli.js";
import { ensureBranch } from "../../src/lifecycle/pr-flow.js";
import { reconcile } from "../../src/lifecycle/reconcile.js";
import { routeDispatch, type ModelEntry } from "../../src/lifecycle/routing.js";
import { main } from "../../src/index.js";

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
      "enabled",
      "unavailable",
      "enabled",
      "enabled",
      "enabled",
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

    // autonomous_dispatch is activated (t22D); `build <prd>` no longer fails
    // at the autonomous_dispatch gate.  resume_retry is activated (t29);
    // `build --resume` passes the gate and fails at the ticket-contract gate
    // (missing PRD).  Use `build --raw-shell` (raw_shell still unavailable)
    // to exercise the capability-gate failure path that prints the registry
    // on startup.
    const startup = cli(["build", "/nonexistent/prd.md", "--raw-shell"]);
    expect(startup.status).toBe(3);
    for (const entry of entries) {
      expect(startup.stdout).toContain(`${entry.name}: state=${entry.state}`);
      expect(startup.stdout).toContain(entry.error_code);
    }
  });

  it("returns stable nonzero capability errors before filesystem or subprocess work", async () => {
    const root = tempRoot("cap-boundary");
    const opts = buildOptions(root);
    // autonomous_dispatch is now activated (t22D); runBuild proceeds past the
    // capability gate and fails closed at the PRD/ticket-contract gate (the
    // missing PRD cannot be parsed) BEFORE any spawn, containment probe, or
    // legacy run-workspace provisioning.  The rickgentDir is not created.
    const result = await runBuild(opts);
    expect(result.outcome.status).not.toBe("ok");
    expect(result.gateHit).toBe("ticket-contract-gate");
    expect(existsSync(opts.rickgentDir)).toBe(false);

    // resume_retry is activated (t29); `build --resume` passes the gate and
    // fails at the ticket-contract gate (missing PRD, exit 2).
    const resume = cli(["build", "--resume"]);
    expect(resume.status).toBe(2);

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

    // reconciliation is activated (t29); `reconcile` passes the gate and
    // returns ok with 0 tickets (no state store to reconcile from).
    const rec = cli(["reconcile"]);
    expect(rec.status).toBe(0);
  });

  it("guards direct dispatch, queue, reconcile, review, delivery, and raw-shell boundaries", async () => {
    const root = tempRoot("cap-direct");
    const state = join(root, "state");
    const ledger = new DispatchLedger(join(state, "dispatch.jsonl"));
    // autonomous_dispatch is activated (t22D); the still-UNAVAILABLE
    // capabilities continue to block their boundaries.  The Dispatcher and
    // toolbelt commands (prd/szechuan/anatomy) now pass the autonomous_dispatch
    // gate and are exercised through the fixture bridge / dist-fixture tree,
    // not here (proceeding past the gate spawns omnigent, which is
    // non-deterministic in the source-tree test environment).
    // reconciliation is activated (t29); reconcile() returns ok with 0
    // tickets (no state store) instead of throwing.
    expect(() => new DispatchQueue(ledger, 2)).toThrow("maxConcurrent must be exactly 1");
    expect(reconcile(root, state).ok).toBe(true);

    const roster: ModelEntry[] = [{
      harness: "codex",
      model: "openai/gpt-5",
      vendor: "openai",
      tier: "capable",
      pricing: { cost_per_dispatch: 1 },
    }];
    // cross_vendor_review is activated (t32); routeDispatch with
    // code_review role passes the capability gate and the router selects
    // a different vendor model (openai vs anthropic implementer).
    const routeResult = routeDispatch(roster, "code_review", { implementerVendor: "anthropic" });
    expect(routeResult.ok).toBe(true);
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
  });

  it("keeps capability authority out of public build and CLI call signatures", async () => {
    const root = tempRoot("cap-public-api");
    const noOpGate = { require(): void {} };

    // autonomous_dispatch is activated (t22D); runBuild proceeds past the
    // REAL capability gate (the injected noOpGate is NOT used — runBuild does
    // not accept a capabilityGate argument) and fails closed at the PRD/
    // ticket-contract gate on the missing PRD.  The injected fakeDependencies
    // are ignored.
    const buildResult = await Reflect.apply(runBuild, undefined, [
      buildOptions(root),
      { capabilityGate: noOpGate, assertEnvironment(): void {} },
    ]) as { outcome: { status: string }; gateHit: string };
    expect(buildResult.outcome.status).not.toBe("ok");
    expect(buildResult.gateHit).toBe("ticket-contract-gate");

    // main also ignores the injected capabilityGate; with autonomous_dispatch
    // activated, `prd --from <missing>` proceeds past the gate and fails on
    // the missing file (not on a capability error).
    const mainError = await Reflect.apply(main, undefined, [
      ["prd", "--from", join(root, "missing.md")],
      { capabilityGate: noOpGate, assertEnvironment(): void {} },
    ]).catch((error: unknown) => error);
    expect(mainError).toBeInstanceOf(Error);
    expect(String((mainError as Error).message)).not.toContain("RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE");

    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8")) as {
      exports: Record<string, string>;
    };
    expect(packageJson.exports).toEqual({
      ".": "./dist/index.js",
      "./package.json": "./package.json",
    });

    const packageRoot = join(import.meta.dirname, "../..");
    const publicApi = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "const api = await import('rickgent'); console.log(Object.keys(api).sort().join(','));",
    ], { cwd: packageRoot, encoding: "utf-8" });
    expect(publicApi.status, publicApi.stderr).toBe(0);
    expect(publicApi.stdout.trim()).toBe("handleFatal,main");

    const fixtureSubpath = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "await import('rickgent/testing/fixture-runtime.js');",
    ], { cwd: packageRoot, encoding: "utf-8" });
    expect(fixtureSubpath.status).not.toBe(0);
    expect(fixtureSubpath.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
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
