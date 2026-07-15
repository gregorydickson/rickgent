import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
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
    for (const relative of ["README.md", "docs/reliability-preview.md"]) {
      const text = readFileSync(join(repoRoot, relative), "utf-8");
      const start = text.indexOf(CLAIM_MATRIX_BEGIN);
      const end = text.indexOf(CLAIM_MATRIX_END);
      expect(start, relative).toBeGreaterThanOrEqual(0);
      expect(end, relative).toBeGreaterThan(start);
      expect(text.indexOf(CLAIM_MATRIX_BEGIN, start + 1), relative).toBe(-1);
      expect(text.slice(start, end + CLAIM_MATRIX_END.length), relative).toBe(expectedBlock);
      expect(text).toContain(RELEASE_CHANNEL);
      expect(text).toContain("explicit test dependency injection");
      expect(text).toContain("fixture-only");
      expect(text).toContain("exactly sequential");
      expect(text).toContain("dedicated run worktree");
      expect(text).toContain("implementation_captured_nonterminal");
      expect(text).toMatch(/`Done` is (?:a delivered-only alias|an alias only for delivered)/);
      expect(text).toContain("ready_for_delivery=local_oracle_complete");
      expect(text).toContain("delivered=remote_delivery_verified");

      for (const retiredClaim of [
        "autonomous multi-model engineering platform",
        "production-hardened",
        "merge-ready pr",
        "zero required interventions",
        "configurable concurrent dispatch",
        "seven fail-closed",
        "public resume and reconciliation",
        "multi-vendor review is enforced",
      ]) {
        expect(text.toLowerCase(), `${relative}: ${retiredClaim}`).not.toContain(retiredClaim);
      }
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
      expect(result.stdout).toContain("explicit test dependency injection");
      expect(result.stdout).toContain(formatTerminalSummary());
    }

    for (const command of ["prd", "refine", "citadel", "szechuan", "anatomy", "microverse", "cronenberg"]) {
      const result = cli([command, "--help"]);
      expect(result.status, `${command}: ${output(result)}`).toBe(0);
      expect(result.stdout.startsWith(RELEASE_LABEL), command).toBe(true);
      expect(result.stdout).toContain(getCapability("raw_shell").error_code);
      expect(result.stdout).toContain(getCapability("cross_vendor_review").error_code);
      expect(result.stdout).toContain(LEGACY_HELP_DISCLAIMER);
    }
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

  it("matches the public capability exits and ordered stable/detail codes", () => {
    const prd = join(stateRoot, "missing-prd.md");
    const autonomous = getCapability("autonomous_dispatch").error_code;
    const resume = getCapability("resume_retry").error_code;
    const reconcile = getCapability("reconciliation").error_code;
    const delivery = getCapability("automatic_delivery").error_code;
    const rawShell = getCapability("raw_shell").error_code;

    const build = expectCapabilityFailure(["build", prd], autonomous);
    expectCapabilityFailure(["pipeline", prd], autonomous);
    expectCapabilityFailure(["build", "--resume"], resume);
    expectCapabilityFailure(["pipeline", "--resume"], resume);
    expectCapabilityFailure(["reconcile"], reconcile);
    expectCapabilityFailure(["build", prd, "--feature", "topic"], delivery);
    expectCapabilityFailure(["pipeline", prd, "--no-autonomous-pr"], delivery);
    expectCapabilityFailure(["build", prd, "--raw-shell"], rawShell);
    expectCapabilityFailure(["build", prd, "--max-concurrent", "1"], autonomous);

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
