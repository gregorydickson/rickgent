#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { BUILD_COMMIT } from "./build-commit.js";
import {
  CAPABILITY_UNAVAILABLE_ERROR_CODE,
  InputContractError,
  LEGACY_HELP_DISCLAIMER,
  PRODUCTION_CAPABILITY_GATE,
  RELEASE_CHANNEL,
  RELEASE_LABEL,
  RickgentBoundaryError,
  assertNoProductionBypasses,
  formatCapabilityReport,
  formatPublicSurfaceMatrixText,
  formatReliabilityPreviewBanner,
  formatTerminalSummary,
  type CapabilityGate,
} from "./capabilities/registry.js";
import { runVerdict } from "./core/verdict-cli.js";
import type { BuildDependencies, BuildOptions } from "./lifecycle/build.js";
import type { RunOutcome, RunOutcomeClass } from "./lifecycle/run-outcome.js";

const RUN_EXIT_CODES: Readonly<Record<RunOutcomeClass, 0 | 2 | 3 | 4 | 5 | 6 | 7>> = Object.freeze({
  success: 0,
  input_contract: 2,
  capability_unavailable: 3,
  infrastructure: 4,
  execution: 5,
  verification: 6,
  cleanup: 7,
});

/** Numeric exit selection belongs only to the CLI boundary. */
export function exitCodeForRunOutcome(outcome: RunOutcome): 0 | 2 | 3 | 4 | 5 | 6 | 7 {
  return RUN_EXIT_CODES[outcome.primary];
}

const USAGE = `${formatReliabilityPreviewBanner()}

Public observations: help, status, and doctor are read-only. Legacy toolbelt
command names shown below do not enable autonomous mutation, recovery,
reconciliation, parallel dispatch, cross-vendor proof, delivery, or raw shell.

Usage:
  rickgent prd                 Legacy PRD toolbelt surface
  rickgent refine <prd.md>     Legacy refinement toolbelt surface
  rickgent build <prd.md>      Public mutation unavailable (exit 3)
  rickgent pipeline <prd.md>   Public mutation unavailable (exit 3)
  rickgent citadel             Audit surface; help is read-only
  rickgent szechuan            Legacy toolbelt; mutation unavailable
  rickgent anatomy             Legacy toolbelt; mutation unavailable
  rickgent microverse          Legacy toolbelt; mutation/raw shell unavailable
  rickgent cronenberg          Legacy toolbelt; mutation unavailable
  rickgent status [--deep]     Read-only registry/health observation
  rickgent metrics [--json]    Read-only historical metrics
  rickgent reconcile           Unavailable (exit 3)
  rickgent doctor [--json]     Read-only health and capability contract
  rickgent verdict <check> --json
  rickgent --version
  rickgent --build-commit
  rickgent --help

${formatPublicSurfaceMatrixText()}
`;

const BUILD_USAGE = `${formatReliabilityPreviewBanner()}

rickgent build — public mutation is unavailable

Usage:
  rickgent build <prd> [options]
  rickgent build --resume [options]

Options:
  --repo <dir>              Target git repo
  --agent <dir>             Rickgent agent root containing agents/worker
  --feature <branch>        Delivery config: capability exit 3
  --max-concurrent <N>      Only 1 accepted; other values are input exit 2
  --roster <file>           JSON model roster
  --cost-budget <usd>       Hard cost budget per dispatch
  --soft-threshold <usd>    Soft cost threshold
  --resume                  Resume capability unavailable: exit 3
  --no-autonomous-pr        Delivery config unavailable: exit 3
  --raw-shell               Raw shell unavailable: exit 3
  --max-iterations <N>      Parsed legacy flag rejected: input exit 2
  --help, -h                Show this help

Public build reaches ${CAPABILITY_UNAVAILABLE_ERROR_CODE} with the compiled
autonomous-dispatch detail after strict input and selected flag gates. Parsing
configuration never enables a capability. The fixture dependency seam is not
a CLI mode or environment switch.

${formatPublicSurfaceMatrixText()}
`;

const PIPELINE_USAGE = `${formatReliabilityPreviewBanner()}

rickgent pipeline — public lifecycle mutation is unavailable

Usage:
  rickgent pipeline <prd> [build options]

The strict build option contract and gate order apply. No public pipeline run
can mutate, resume, reconcile, dispatch in parallel, prove cross-vendor review,
run raw shell, deliver, become ready_for_delivery, become delivered, or write
Done in ${RELEASE_CHANNEL}.

${formatPublicSurfaceMatrixText()}
`;

const SIMPLE_COMMAND_USAGE: Readonly<Record<string, string>> = {
  doctor: "Usage: rickgent doctor [--json]",
  status: "Usage: rickgent status [--deep]",
  metrics: "Usage: rickgent metrics [--json]",
  reconcile: "Usage: rickgent reconcile",
  verdict: "Usage: rickgent verdict <check> --json",
};

type OptionKind = "boolean" | "value";
type OptionSpec = Readonly<Record<string, OptionKind>>;

const HELP_OPTIONS: OptionSpec = { "--help": "boolean", "-h": "boolean" };
const BUILD_OPTIONS: OptionSpec = {
  ...HELP_OPTIONS,
  "--repo": "value",
  "--agent": "value",
  "--feature": "value",
  "--max-concurrent": "value",
  "--roster": "value",
  "--cost-budget": "value",
  "--soft-threshold": "value",
  "--resume": "boolean",
  "--no-autonomous-pr": "boolean",
  "--raw-shell": "boolean",
  "--max-iterations": "value",
};

const COMMAND_OPTIONS: Readonly<Record<string, { options: OptionSpec; maxPositionals: number }>> = {
  doctor: { options: { ...HELP_OPTIONS, "--json": "boolean" }, maxPositionals: 0 },
  status: { options: { ...HELP_OPTIONS, "--deep": "boolean" }, maxPositionals: 0 },
  metrics: { options: { ...HELP_OPTIONS, "--json": "boolean" }, maxPositionals: 0 },
  reconcile: { options: HELP_OPTIONS, maxPositionals: 0 },
  verdict: { options: { ...HELP_OPTIONS, "--json": "boolean" }, maxPositionals: 1 },
  citadel: {
    options: { ...HELP_OPTIONS, "--prd": "value", "--diff": "value", "--strict": "boolean", "--report": "value", "--print-stubs": "boolean", "--repo": "value" },
    maxPositionals: 1,
  },
  prd: {
    options: { ...HELP_OPTIONS, "--non-interactive": "boolean", "--from": "value", "--repo": "value", "--agent": "value", "--output": "value" },
    maxPositionals: 0,
  },
  refine: {
    options: { ...HELP_OPTIONS, "--run": "boolean", "--cycles": "value", "--max-turns": "value", "--non-interactive": "boolean", "--repo": "value", "--agent": "value" },
    maxPositionals: 1,
  },
  anatomy: {
    options: { ...HELP_OPTIONS, "--dry-run": "boolean", "--max-iterations": "value", "--stall-limit": "value", "--repo": "value", "--agent": "value", "--resume": "boolean" },
    maxPositionals: 0,
  },
  szechuan: {
    options: { ...HELP_OPTIONS, "--dry-run": "boolean", "--domain": "value", "--focus": "value", "--design-safe": "boolean", "--max-iterations": "value", "--stall-limit": "value", "--repo": "value", "--agent": "value", "--resume": "boolean" },
    maxPositionals: 0,
  },
  microverse: {
    options: { ...HELP_OPTIONS, "--metric": "value", "--goal": "value", "--task": "value", "--direction": "value", "--max-iterations": "value", "--stall-limit": "value", "--epsilon": "value", "--window": "value", "--target": "value", "--repo": "value", "--agent": "value", "--owned-paths": "value", "--iteration-deadline-ms": "value", "--non-interactive": "boolean", "--resume": "boolean" },
    maxPositionals: 0,
  },
  cronenberg: {
    options: { ...HELP_OPTIONS, "--dry-run": "boolean", "--no-followups": "boolean", "--no-refine": "boolean", "--refine": "boolean", "--non-interactive": "boolean", "--task": "value", "--repo": "value", "--metric": "value", "--goal": "value", "--agent": "value", "--target": "value", "--max-iterations": "value", "--stall-limit": "value", "--epsilon": "value", "--window": "value", "--direction": "value", "--owned-paths": "value", "--iteration-deadline-ms": "value", "--domain": "value", "--focus": "value", "--design-safe": "boolean", "--max-concurrent": "value" },
    maxPositionals: Number.POSITIVE_INFINITY,
  },
};

const NUMERIC_OPTION_RULES: Readonly<Record<string, { integer: boolean; minimum?: number }>> = {
  "--cycles": { integer: true, minimum: 1 },
  "--max-turns": { integer: true, minimum: 1 },
  "--max-concurrent": { integer: true, minimum: 1 },
  "--max-iterations": { integer: true, minimum: 1 },
  "--stall-limit": { integer: true, minimum: 1 },
  "--window": { integer: true, minimum: 1 },
  "--iteration-deadline-ms": { integer: true, minimum: 1 },
  "--cost-budget": { integer: false, minimum: 0 },
  "--soft-threshold": { integer: false, minimum: 0 },
  "--epsilon": { integer: false, minimum: 0 },
  "--target": { integer: false },
};

export interface CliDependencies {
  capabilityGate?: CapabilityGate;
  buildDependencies?: BuildDependencies;
  assertEnvironment?: (env: NodeJS.ProcessEnv) => void;
  /** Explicit fixture-only child entrypoint for delegated Cronenberg commands. */
  cronenbergChildCliPath?: string;
}

function strictTokens(args: string[], spec: OptionSpec, maxPositionals: number): void {
  const seen = new Set<string>();
  let positionals = 0;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const kind = spec[token];
    if (kind !== undefined) {
      if (seen.has(token)) throw new InputContractError(`duplicate flag: ${token}`);
      seen.add(token);
      if (kind === "value") {
        const value = args[index + 1];
        const permitsSignedValue = token === "--target" && value !== undefined && /^-\d/.test(value);
        if (value === undefined || (value.startsWith("-") && !permitsSignedValue)) {
          throw new InputContractError(`missing value for ${token}`);
        }
        validateNumericOption(token, value);
        index++;
      }
      continue;
    }
    if (token.startsWith("-")) throw new InputContractError(`unknown flag: ${token}`);
    positionals++;
    if (positionals > maxPositionals) {
      throw new InputContractError(`unexpected positional argument: ${token}`);
    }
  }
  if ((seen.has("--help") || seen.has("-h")) && args.length !== 1) {
    throw new InputContractError("--help cannot be combined with other arguments");
  }
}

function validateNumericOption(flag: string, raw: string): void {
  const rule = NUMERIC_OPTION_RULES[flag];
  if (rule === undefined) return;
  const pattern = rule.integer ? /^(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
  if (!pattern.test(raw)) {
    throw new InputContractError(`invalid numeric value for ${flag}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || (rule.minimum !== undefined && value < rule.minimum)) {
    throw new InputContractError(`invalid numeric value for ${flag}: ${raw}`);
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function strictPositiveNumber(raw: string | undefined, flag: string, integer: boolean): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new InputContractError(`invalid numeric value for ${flag}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new InputContractError(`invalid numeric value for ${flag}: ${raw}`);
  }
  return value;
}

function readRoster(path: string): import("./lifecycle/routing.js").ModelEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new InputContractError(`cannot read roster file: ${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as import("./lifecycle/routing.js").ModelEntry[];
  } catch {
    throw new InputContractError(`invalid model roster JSON: ${path}`);
  }
}

function getRickgentDir(): string {
  return process.env.RICKGENT_DIR ?? join(process.cwd(), ".rickgent");
}

function resolveBuildOptions(rest: string[]): BuildOptions {
  strictTokens(rest, BUILD_OPTIONS, 1);
  if (rest.includes("--max-iterations")) {
    throw new InputContractError("--max-iterations is advertised but not implemented for build/pipeline");
  }

  const resume = rest.includes("--resume");
  const positionals = rest.filter((token, index) => {
    if (token.startsWith("-")) return false;
    const previous = rest[index - 1];
    return previous === undefined || BUILD_OPTIONS[previous] !== "value";
  });
  const prdPath = positionals[0];
  if (!prdPath && !resume) throw new InputContractError("missing <prd> argument");

  const maxConcurrent = strictPositiveNumber(flagValue(rest, "--max-concurrent"), "--max-concurrent", true);
  if (maxConcurrent !== undefined && maxConcurrent !== 1) {
    throw new InputContractError("--max-concurrent must be exactly 1 for the sequential fixture profile");
  }
  const costBudgetUsd = strictPositiveNumber(flagValue(rest, "--cost-budget"), "--cost-budget", false);
  const softThresholdUsd = strictPositiveNumber(flagValue(rest, "--soft-threshold"), "--soft-threshold", false);
  const rosterPath = flagValue(rest, "--roster");
  const workingDir = flagValue(rest, "--repo") ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd();
  const rickgentDir = getRickgentDir();

  const options: BuildOptions = {
    prdPath: prdPath ?? "",
    workingDir,
    rickgentDir,
    agentDir: flagValue(rest, "--agent") ?? process.env.RICKGENT_AGENT_DIR ?? join(new URL("../../", import.meta.url).pathname, "agents", "rickgent"),
    dataDir: process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data"),
    resume,
    rawShell: rest.includes("--raw-shell"),
    deliveryConfigured: rest.includes("--feature") || rest.includes("--no-autonomous-pr"),
  };
  if (rest.includes("--no-autonomous-pr")) options.autonomousPrFlow = false;
  const featureBranch = flagValue(rest, "--feature");
  if (featureBranch !== undefined) options.featureBranch = featureBranch;
  if (maxConcurrent !== undefined) options.maxConcurrent = maxConcurrent;
  if (rosterPath !== undefined) options.roster = readRoster(rosterPath);
  if (costBudgetUsd !== undefined) options.costBudgetUsd = costBudgetUsd;
  if (softThresholdUsd !== undefined) options.softThresholdUsd = softThresholdUsd;
  return options;
}

function requireBuildCapabilities(rest: string[], gate: CapabilityGate): void {
  if (rest.includes("--resume")) gate.require("resume_retry");
  if (rest.includes("--feature") || rest.includes("--no-autonomous-pr")) gate.require("automatic_delivery");
  if (rest.includes("--raw-shell")) gate.require("raw_shell");
  gate.require("autonomous_dispatch");
}

async function runDoctor(rest: string[]): Promise<void> {
  const { runDoctorCommand } = await import("./commands/doctor.js");
  const result = await runDoctorCommand(rest.includes("--json"));
  if (!result.ok) process.exit(1);
}

async function runStatus(rest: string[]): Promise<void> {
  if (rest.includes("--deep")) {
    const { runDoctorCheck } = await import("./lifecycle/doctor.js");
    const doctor = await runDoctorCheck();
    console.log(doctor.report);
    if (!doctor.ok) throw new Error("status --deep doctor check failed");
  }
  const { Registry } = await import("./lifecycle/registry.js");
  const status = new Registry(join(getRickgentDir(), "registry.json")).getPipelineStatus();
  const lines = [
    `${RELEASE_LABEL} (${RELEASE_CHANNEL})`,
    "rickgent status — read-only pipeline-state observation",
    formatTerminalSummary(),
    "Status cannot terminalize a run; a stored legacy Done label is not ready_for_delivery or delivery evidence.",
    "=".repeat(50),
    `runId: ${status.runId || "(none)"}`,
    `startedAt: ${status.startedAt || "(none)"}`,
    `updatedAt: ${status.updatedAt || "(none)"}`,
    `tickets: ${Object.keys(status.tickets).length}`,
  ];
  for (const [id, ticket] of Object.entries(status.tickets)) {
    lines.push(`  ${id}: [${ticket.status}] phase=${ticket.phase} attempt=${ticket.attempt} commit=${ticket.completionCommitSha ?? "(none)"}`);
  }
  console.log([...lines, "=".repeat(50)].join("\n"));
}

async function runReconcile(gate: CapabilityGate): Promise<void> {
  const { reconcile } = await import("./lifecycle/reconcile.js");
  const result = reconcile(process.cwd(), getRickgentDir(), undefined, gate);
  console.log(`rickgent reconcile — rebuilt=${result.rebuilt} ticketsFound=${result.ticketsFound}`);
  if (!result.ok) process.exit(1);
}

async function runBuildCommand(rest: string[], pipeline: boolean, dependencies: CliDependencies): Promise<void> {
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    console.log(pipeline ? PIPELINE_USAGE : BUILD_USAGE);
    return;
  }
  const opts = resolveBuildOptions(rest);
  const gate = dependencies.capabilityGate ?? PRODUCTION_CAPABILITY_GATE;
  console.log(formatCapabilityReport());
  requireBuildCapabilities(rest, gate);
  const buildDependencies: BuildDependencies = {
    ...dependencies.buildDependencies,
    capabilityGate: gate,
  };
  if (dependencies.assertEnvironment !== undefined) {
    buildDependencies.assertEnvironment = dependencies.assertEnvironment;
  }
  const lifecycle = await import("./lifecycle/build.js");
  const result = pipeline
    ? await lifecycle.runPipeline(opts, buildDependencies)
    : await lifecycle.runBuild(opts, buildDependencies);
  console.log(result.report.join("\n"));
  const summary =
    `${pipeline ? "pipeline" : "build"}: planned=${result.ticketsPlanned} ` +
    `dispatched=${result.ticketsDispatched} captured=${result.ticketsCaptured} done=${result.ticketsDone} ` +
    `failed=${result.ticketsFailed} recovered=${result.ticketsRecovered} ` +
    `interventions=${result.interventions} outcome=${result.outcome.status} ` +
    `primary=${result.outcome.primary}`;
  console.log(
    pipeline
      ? `${summary} cleanupReconciled=${(result as import("./lifecycle/build.js").PipelineResult).cleanup.ticketsReconciled}`
      : summary,
  );
  const exitCode = exitCodeForRunOutcome(result.outcome);
  if (exitCode !== 0) process.exit(exitCode);
}

async function runMetrics(rest: string[]): Promise<void> {
  const { runMetrics: collect } = await import("./lifecycle/metrics.js");
  const result = collect(getRickgentDir(), process.env);
  console.log(rest.includes("--json") ? result.json : result.report);
}

export async function main(
  args: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  (dependencies.assertEnvironment ?? assertNoProductionBypasses)(process.env);
  const command = args[0] ?? "";
  const rest = args.slice(1);
  const gate = dependencies.capabilityGate ?? PRODUCTION_CAPABILITY_GATE;

  if (["--version", "-v", "--build-commit", "--help", "-h", ""].includes(command)) {
    if (rest.length > 0) throw new InputContractError(`unexpected argument after ${command || "default help"}: ${rest[0]}`);
    if (command === "--version" || command === "-v") console.log(`rickgent 0.1.0-alpha (build ${BUILD_COMMIT.slice(0, 12)})`);
    else if (command === "--build-commit") console.log(BUILD_COMMIT);
    else console.log(USAGE);
    return;
  }

  if (command === "build" || command === "pipeline") {
    await runBuildCommand(rest, command === "pipeline", dependencies);
    return;
  }

  const contract = COMMAND_OPTIONS[command];
  if (!contract) throw new InputContractError(`unknown command: ${command}`);
  strictTokens(rest, contract.options, contract.maxPositionals);
  const helpOnly = rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h");

  if (helpOnly && SIMPLE_COMMAND_USAGE[command] !== undefined) {
    console.log(`${formatReliabilityPreviewBanner()}\n\n${SIMPLE_COMMAND_USAGE[command]}`);
    return;
  }

  if (helpOnly) {
    console.log(`${formatReliabilityPreviewBanner()}\n\n${LEGACY_HELP_DISCLAIMER}\n`);
  }

  if (!helpOnly && rest.includes("--resume")) gate.require("resume_retry");
  if (!helpOnly && command === "microverse" && rest.includes("--metric")) gate.require("raw_shell");

  if (command === "verdict") return runVerdict(rest);
  if (command === "doctor") return runDoctor(rest);
  if (command === "status") return runStatus(rest);
  if (command === "reconcile") return runReconcile(gate);
  if (command === "metrics") return runMetrics(rest);

  if (command === "microverse") {
    if (!helpOnly) gate.require("autonomous_dispatch");
    const { runMicroverseCommand } = await import("./lifecycle/microverse-cli.js");
    return runMicroverseCommand(rest, gate);
  }
  if (command === "cronenberg") {
    if (!helpOnly && !rest.includes("--dry-run")) gate.require("autonomous_dispatch");
    const { runCronenbergCommand } = await import("./lifecycle/cronenberg-run.js");
    return runCronenbergCommand(rest, dependencies.cronenbergChildCliPath, gate);
  }
  if (command === "citadel") {
    const { runCitadelCommand } = await import("./lifecycle/citadel-cli.js");
    return runCitadelCommand(rest);
  }
  if (command === "prd") {
    if (!helpOnly && !rest.includes("--non-interactive") && !rest.includes("--from")) gate.require("autonomous_dispatch");
    const { runPrdCommand } = await import("./lifecycle/prd-interview.js");
    return runPrdCommand(rest, gate);
  }
  if (command === "refine") {
    if (!helpOnly) gate.require("autonomous_dispatch");
    const { runRefineCommand } = await import("./lifecycle/refine.js");
    return runRefineCommand(rest, gate);
  }
  if (command === "szechuan") {
    if (!helpOnly && !rest.includes("--dry-run")) gate.require("autonomous_dispatch");
    const { runSzechuanCommand } = await import("./lifecycle/szechuan-cli.js");
    return runSzechuanCommand(rest, gate);
  }
  if (command === "anatomy") {
    if (!helpOnly && !rest.includes("--dry-run")) gate.require("autonomous_dispatch");
    const { runAnatomyCommand } = await import("./lifecycle/anatomy.js");
    return runAnatomyCommand(rest, gate);
  }
}

export function handleFatal(error: unknown): never {
  if (error instanceof RickgentBoundaryError) {
    console.error(`${error.stableCode}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`RICKGENT_INTERNAL_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(70);
}

const isEntrypoint = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) main().catch(handleFatal);
