import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_UNAVAILABLE_ERROR_CODE,
  CLAIM_MATRIX_BEGIN,
  CLAIM_MATRIX_END,
  CLAIMS_SCHEMA_VERSION,
  INPUT_CONTRACT_ERROR_CODE,
  LEGACY_HELP_DISCLAIMER,
  RELEASE_CHANNEL,
  RELEASE_LABEL,
  REJECTED_PRODUCTION_BYPASSES,
  TERMINAL_SEMANTICS,
  capabilityRegistry,
  formatPublicSurfaceMatrixBlock,
  formatReliabilityPreviewBanner,
  formatTerminalSummary,
  getCapability,
  publicSurfaceRegistry,
} from "../../src/capabilities/registry.js";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const cliPath = join(orchestratorRoot, "dist", "cli.js");
const stateRoot = mkdtempSync(join(tmpdir(), "rickgent-claims-"));

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra, RICKGENT_DIR: stateRoot };
  for (const name of REJECTED_PRODUCTION_BYPASSES) delete env[name];
  return env;
}

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: cleanEnv(extraEnv),
    timeout: 30_000,
  });
}

function output(result: ReturnType<typeof cli>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function expectCapabilityFailure(args: string[], detail: string): ReturnType<typeof cli> {
  const result = cli(args);
  expect(result.status, `${args.join(" ")}\n${output(result)}`).toBe(3);
  const error = result.stderr.trim();
  expect(error.startsWith(`${CAPABILITY_UNAVAILABLE_ERROR_CODE}: ${detail}:`)).toBe(true);
  return result;
}

function expectInputFailure(args: string[], absentDetail?: string): ReturnType<typeof cli> {
  const result = cli(args);
  expect(result.status, `${args.join(" ")}\n${output(result)}`).toBe(2);
  expect(result.stderr.trim().startsWith(`${INPUT_CONTRACT_ERROR_CODE}:`)).toBe(true);
  if (absentDetail !== undefined) expect(result.stderr).not.toContain(absentDetail);
  return result;
}

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("reliability-preview claim contract", () => {
  it("keeps README and the public contract byte-aligned with the registry matrix", () => {
    const expectedBlock = formatPublicSurfaceMatrixBlock();
    const retiredClaims = [
      "autonomous multi-model engineering platform",
      "production-hardened",
      "merge-ready pr",
      "zero required interventions",
      "configurable concurrent dispatch",
      "seven fail-closed",
      "multi-vendor review is enforced",
    ];
    for (const relative of ["README.md", "docs/reliability-preview.md"]) {
      const text = readFileSync(join(repoRoot, relative), "utf-8");
      const start = text.indexOf(CLAIM_MATRIX_BEGIN);
      const end = text.indexOf(CLAIM_MATRIX_END);
      expect(start, relative).toBeGreaterThanOrEqual(0);
      expect(end, relative).toBeGreaterThan(start);
      expect(text.indexOf(CLAIM_MATRIX_BEGIN, start + 1), relative).toBe(-1);
      expect(text.slice(start, end + CLAIM_MATRIX_END.length), relative).toBe(expectedBlock);
      expect(text).toContain(RELEASE_CHANNEL);
      expect(text).toContain("explicit build test dependency injection");
      expect(text).toContain("legacy compatibility fixtures");
      expect(text).toContain("non-authoritative");
      expect(text).toContain("fixture-only");
      expect(text).toContain("exactly sequential");
      expect(text).toContain("dedicated run worktree");
      expect(text).toContain("implementation_captured_nonterminal");
      expect(text).toMatch(/`Done` is (?:a delivered-only alias|an alias only for delivered)/);
      expect(text).toContain("ready_for_delivery=local_oracle_complete");
      expect(text).toContain("delivered=remote_delivery_verified");

      for (const retiredClaim of retiredClaims) {
        expect(text.toLowerCase(), `${relative}: ${retiredClaim}`).not.toContain(retiredClaim);
      }
    }

    const packageMetadata = readFileSync(join(orchestratorRoot, "package.json"), "utf-8").toLowerCase();
    expect(packageMetadata).toContain("reliability-preview");
    for (const retiredClaim of retiredClaims) {
      expect(packageMetadata, `package.json: ${retiredClaim}`).not.toContain(retiredClaim);
    }
  });

  it("labels target-design decision records as non-authoritative for current availability", () => {
    for (const relative of [
      "docs/decisions/build-loop.md",
      "docs/decisions/model-routing.md",
      "docs/decisions/session-resume.md",
    ]) {
      const text = readFileSync(join(repoRoot, relative), "utf-8");
      expect(text, relative).toContain("not a statement of current `reliability_preview` availability");
      expect(text, relative).toContain("`docs/reliability-preview.md` control");
      expect(text, relative).toContain("remain unavailable");
    }
  });

  it("inventories every intentional public filesystem writer without granting lifecycle authority", () => {
    const surfaces = publicSurfaceRegistry();
    // autonomous_dispatch is activated (t22D): build/pipeline are now
    // enabled production surfaces (local_artifact_only mutation authority via
    // the AttemptRunner).  The non-mutating local-artifact writers remain
    // prd --non-interactive and citadel.
    const localArtifactSurfaces = surfaces.filter((entry) => entry.mutation_authority === "local_artifact_only");
    expect(localArtifactSurfaces.map((entry) => entry.surface)).toEqual([
      "rickgent build <prd>",
      "rickgent pipeline <prd>",
      "rickgent prd --non-interactive [--output <path>]",
      "rickgent citadel [--report <path>]",
      "build|pipeline --resume",
      "build|pipeline [--max-concurrent 1]",
    ]);
    // The non-mutating local-artifact writers (prd template, citadel report)
    // retain their explicit-write-authority boundary.
    for (const entry of surfaces.filter((candidate) =>
      candidate.mutation_authority === "local_artifact_only" &&
      (candidate.surface === "rickgent prd --non-interactive [--output <path>]" ||
        candidate.surface === "rickgent citadel [--report <path>]"))) {
      expect(entry.boundary).toContain("explicit write authority");
      expect(entry.boundary).toContain("may be inside the repository or state root");
      expect(entry.boundary).toContain("read-only Git inspection may run");
      expect(entry.boundary).toMatch(/no (?:agent spawn|remediation agent), Git mutation, or validated lifecycle transition/i);
    }
  });

  it("publishes the same preview boundary through root, build, pipeline, and legacy help", () => {
    const banner = formatReliabilityPreviewBanner();
    for (const args of [["--help"], ["build", "--help"], ["pipeline", "--help"]]) {
      const result = cli(args);
      expect(result.status, `${args.join(" ")}: ${output(result)}`).toBe(0);
      expect(result.stdout.startsWith(RELEASE_LABEL)).toBe(true);
      expect(result.stdout).toContain(banner);
      expect(result.stdout).toContain(CAPABILITY_UNAVAILABLE_ERROR_CODE);
      expect(result.stdout).toContain(getCapability("autonomous_dispatch").error_code);
      expect(result.stdout).toContain(INPUT_CONTRACT_ERROR_CODE);
      expect(result.stdout).toContain("explicit build test dependency injection");
      expect(result.stdout).toContain(formatTerminalSummary());
    }

    for (const command of ["prd", "refine", "citadel", "szechuan", "anatomy", "microverse", "cronenberg"]) {
      const result = cli([command, "--help"]);
      expect(result.status, `${command}: ${output(result)}`).toBe(0);
      expect(result.stdout.startsWith(RELEASE_LABEL), command).toBe(true);
      expect(result.stdout).toContain(getCapability("raw_shell").error_code);
      // cross_vendor_review is activated (t32); it is no longer in the
      // unavailable list of the reliability preview banner. The still-
      // unavailable capabilities (parallel_dispatch, automatic_delivery,
      // raw_shell) continue to appear.
      expect(result.stdout).toContain(getCapability("automatic_delivery").error_code);
      expect(result.stdout).toContain(LEGACY_HELP_DISCLAIMER);
    }
  });

  it("fails unavailable-capability flag combinations before spawn or state writes", () => {
    // autonomous_dispatch is activated (t22D); the agent-backed commands
    // (prd/szechuan/anatomy) now proceed past the autonomous_dispatch gate.
    // resume_retry is activated (t29); --resume passes the gate.
    // The STILL-unavailable capability flags (--raw-shell, --feature)
    // fail closed before spawn and do not write state.
    const fixtureBin = join(orchestratorRoot, "test/fixtures/omnigent-fixture");
    const spawnRecord = join(stateRoot, "blocked-legacy-spawn.json");
    const env = {
      PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
      FIXTURE_SPAWN_RECORD: spawnRecord,
    };
    const prd = join(stateRoot, "missing-prd.md");
    const delivery = getCapability("automatic_delivery").error_code;
    const rawShell = getCapability("raw_shell").error_code;

    for (const args of [
      ["build", prd, "--feature", "topic"],
      ["build", prd, "--raw-shell"],
    ]) {
      const result = cli(args, env);
      expect(result.status, `${args.join(" ")}: ${output(result)}`).toBe(3);
      const error = result.stderr.trim();
      expect(
        error.startsWith(`${CAPABILITY_UNAVAILABLE_ERROR_CODE}: ${delivery}:`) ||
        error.startsWith(`${CAPABILITY_UNAVAILABLE_ERROR_CODE}: ${rawShell}:`),
        `${args.join(" ")}: ${error}`,
      ).toBe(true);
    }

    expect(existsSync(spawnRecord)).toBe(false);
  });

  it("derives doctor JSON and text from the compiled claims authority", () => {
    const jsonResult = cli(["doctor", "--json"]);
    expect(jsonResult.status, output(jsonResult)).toBe(0);
    const json = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      schema_version: CLAIMS_SCHEMA_VERSION,
      release_channel: RELEASE_CHANNEL,
      terminal_semantics: TERMINAL_SEMANTICS,
      capabilities: capabilityRegistry(),
      public_surfaces: publicSurfaceRegistry(),
      attachment_semantics: "configured_attachment_audit_only",
      health: { ok: true },
    });

    const textResult = cli(["doctor"]);
    expect(textResult.status, output(textResult)).toBe(0);
    expect(textResult.stdout.startsWith(RELEASE_LABEL)).toBe(true);
    expect(textResult.stdout).toContain("configured attachment audit only");
    expect(textResult.stdout).toContain("not proof of native production enforcement");
    expect(textResult.stdout).toContain(formatTerminalSummary());
    for (const entry of capabilityRegistry()) {
      expect(textResult.stdout).toContain(`${entry.name}: state=${entry.state} code=${entry.error_code}`);
    }
  });

  it("makes status --deep report and fail the aggregate doctor health result", () => {
    const bin = join(stateRoot, "unsupported-python-bin");
    const python = join(bin, "python3");
    mkdirSync(bin, { recursive: true });
    writeFileSync(python, "#!/bin/sh\nprintf 'Python 3.11.9\\n'\n", "utf-8");
    chmodSync(python, 0o755);

    const result = cli(["status", "--deep"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(result.status, output(result)).toBe(1);
    expect(result.stdout).toContain("[FAIL] python_runtime: 3.11.9");
    expect(result.stdout).toContain("health and attachment audit");
  });

  it("matches the public capability exits and ordered stable/detail codes", () => {
    const prd = join(stateRoot, "missing-prd.md");
    const delivery = getCapability("automatic_delivery").error_code;
    const rawShell = getCapability("raw_shell").error_code;

    // autonomous_dispatch is activated (t22D): `build <prd>` no longer fails
    // at the autonomous_dispatch gate.  It proceeds past the gate and fails
    // closed at the PRD/ticket-contract gate on the missing PRD (exit 2,
    // input contract; the report is printed to stdout).  resume_retry and
    // reconciliation are activated (t29); --resume and reconcile pass the
    // gate.  Use --raw-shell (still unavailable) to exercise the
    // capability-gate failure path that prints the registry.
    const buildMissing = cli(["build", prd]);
    expect(buildMissing.status, output(buildMissing)).toBe(2);
    expect(buildMissing.stdout).toContain("TICKET CONTRACT GATE");
    const buildConcurrent1 = cli(["build", prd, "--max-concurrent", "1"]);
    expect(buildConcurrent1.status, output(buildConcurrent1)).toBe(2);
    expect(buildConcurrent1.stdout).toContain("TICKET CONTRACT GATE");
    const build = expectCapabilityFailure(["build", prd, "--raw-shell"], rawShell);
    expectCapabilityFailure(["pipeline", prd, "--raw-shell"], rawShell);
    expectCapabilityFailure(["build", prd, "--feature", "topic"], delivery);
    expectCapabilityFailure(["build", prd, "--no-autonomous-pr"], delivery);

    for (const entry of capabilityRegistry()) {
      expect(build.stdout).toContain(`${entry.name}: state=${entry.state} code=${entry.error_code}`);
    }

    const parallel = getCapability("parallel_dispatch").error_code;
    expectInputFailure(["build", prd, "--max-concurrent", "2"], parallel);
    expectInputFailure(["pipeline", prd, "--max-concurrent", "0"], parallel);
    expectInputFailure(["build", prd, "--max-iterations", "1"]);
    expectInputFailure(["retry"]);
  });

  it("keeps status read-only and refuses to promote legacy Done labels", () => {
    const result = cli(["status"]);
    expect(result.status, output(result)).toBe(0);
    expect(result.stdout.startsWith(RELEASE_LABEL)).toBe(true);
    expect(result.stdout).toContain("read-only");
    expect(result.stdout).toContain("legacy Done label");
    expect(result.stdout).toContain("not ready_for_delivery or delivery evidence");
    expect(result.stdout).toContain(formatTerminalSummary());
  });
});
