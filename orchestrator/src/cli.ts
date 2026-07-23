#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveInstalledRuntimeFromEnvironment } from "./install/installed-runtime.js";
import { BUILD_COMMIT } from "./build-commit.js";
import {
  CAPABILITY_UNAVAILABLE_ERROR_CODE,
  InputContractError,
  LEGACY_HELP_DISCLAIMER,
  RELEASE_CHANNEL,
  RELEASE_LABEL,
  RickgentBoundaryError,
  assertNoProductionBypasses,
  formatCapabilityReport,
  formatPublicSurfaceMatrixText,
  formatReliabilityPreviewBanner,
  formatTerminalSummary,
} from "./capabilities/registry.js";
import { RUNTIME_CAPABILITY_GATE } from "./capabilities/runtime-gate.js";
import { runVerdict } from "./core/verdict-cli.js";
import type { BuildOptions, InternalBuildDependencies } from "./lifecycle/build.js";
import type { RunOutcome, RunOutcomeClass } from "./lifecycle/run-outcome.js";
import {
  LifecycleCommandError,
  type LifecycleCommandResult,
} from "./lifecycle/command-result.js";

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
  rickgent status [--deep]     Read-only SQLite lifecycle observation
  rickgent metrics [--json]    SQLite lifecycle + legacy diagnostics
  rickgent reconcile           Unavailable (exit 3)
  rickgent doctor [--json] [--behavioral]  Read-only audit or explicit installed proof
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
  --feature <branch>        Delivery config: verified push + idempotent PR (t34 activated)
  --max-concurrent <N>      Only 1 accepted; other values are input exit 2
  --roster <file>           JSON model roster
  --cost-budget <usd>       Hard cost budget per dispatch
  --soft-threshold <usd>    Soft cost threshold
  --resume                  Resume from persisted receipts (t29 activated)
  --no-autonomous-pr        Delivery config: disable autonomous PR flow (t34 activated)
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
can dispatch in parallel, prove cross-vendor review,
run raw shell, deliver, become ready_for_delivery, become delivered, or write
Done in ${RELEASE_CHANNEL}.

${formatPublicSurfaceMatrixText()}
`;

const SIMPLE_COMMAND_USAGE: Readonly<Record<string, string>> = {
  doctor: "Usage: rickgent doctor [--json] [--behavioral]",
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
  doctor: { options: { ...HELP_OPTIONS, "--json": "boolean", "--behavioral": "boolean" }, maxPositionals: 0 },
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

/** @internal — fixture-only CLI seams, never accepted by public `main`. */
export interface InternalCliDependencies {
  buildDependencies?: InternalBuildDependencies;
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
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const installedAgentDir = existsSync(join(packageRoot, "src"))
    ? join(packageRoot, "..", "agents", "rickgent")
    : join(resolveInstalledRuntimeFromEnvironment(packageRoot).manager.realpath, "..");

  const options: BuildOptions = {
    prdPath: prdPath ?? "",
    workingDir,
    rickgentDir,
    agentDir: flagValue(rest, "--agent") ?? process.env.RICKGENT_AGENT_DIR ?? installedAgentDir,
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

function requireBuildCapabilities(rest: string[]): void {
  if (rest.includes("--resume")) RUNTIME_CAPABILITY_GATE.require("resume_retry");
  if (rest.includes("--feature") || rest.includes("--no-autonomous-pr")) RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  if (rest.includes("--raw-shell")) RUNTIME_CAPABILITY_GATE.require("raw_shell");
  RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
}

async function runDoctor(rest: string[]): Promise<void> {
  const { runDoctorCommand } = await import("./commands/doctor.js");
  const result = await runDoctorCommand(rest.includes("--json"), rest.includes("--behavioral"));
  if (!result.ok) process.exit(1);
}

async function runStatus(rest: string[]): Promise<void> {
  if (rest.includes("--deep")) {
    const { runDoctorCommand } = await import("./commands/doctor.js");
    const doctor = await runDoctorCommand(false);
    if (!doctor.ok) process.exit(1);
  }
  const { observeState } = await import("./state/store.js");
  const observation = observeState(process.cwd());
  const lines = [
    `${RELEASE_LABEL} (${RELEASE_CHANNEL})`,
    "rickgent status — read-only SQLite lifecycle observation",
    formatTerminalSummary(),
    "A legacy Done label is ignored; it is not ready_for_delivery or delivery evidence.",
    "=".repeat(50),
  ];
  if (observation.state === "absent") {
    lines.push(
      "state: absent (no canonical SQLite database)",
      `repositoryId: ${observation.repositoryId}`,
      "runs: (unavailable)",
      "tickets: (unavailable)",
    );
  } else {
    const run = observation.latestRun;
    lines.push(
      "state: present",
      `schemaVersion: ${observation.schemaVersion}`,
      `repositoryId: ${observation.repositoryId}`,
      `runs: ${observation.aggregates.runs}`,
      `deliveryRecords: ${observation.aggregates.deliveryRecords}`,
      `delivered: ${observation.aggregates.delivered}`,
      `deliveryFailed: ${observation.aggregates.deliveryFailed}`,
      `runId: ${run?.runId ?? "(none)"}`,
      `runState: ${run?.state ?? "(none)"}`,
      `runVersion: ${run?.stateVersion ?? "(none)"}`,
      `createdAt: ${run?.createdAt ?? "(none)"}`,
      `currentDeliveryOid: ${run?.currentDeliveryOid ?? "(none)"}`,
      `promotionSequence: ${run?.promotionSequence ?? "(none)"}`,
      `tickets: ${run?.tickets.length ?? 0}`,
    );
    for (const ticket of run?.tickets ?? []) {
      const attempt = ticket.latestAttempt;
      lines.push(
        `  ${ticket.ticketId}: [${ticket.state}] plan=${ticket.planIndex} version=${ticket.stateVersion} ` +
          `attempt=${attempt?.attemptNumber ?? "(none)"} attemptState=${attempt?.state ?? "(none)"} ` +
          `oracle=${attempt?.oracleResult ?? "(none)"} commit=${attempt?.commitOid ?? "(none)"}`,
      );
    }
  }
  console.log([...lines, "=".repeat(50)].join("\n"));
}

async function runReconcile(): Promise<void> {
  const { reconcile } = await import("./lifecycle/reconcile.js");
  const result = reconcile(process.cwd(), getRickgentDir());
  console.log(`rickgent reconcile — rebuilt=${result.rebuilt} ticketsFound=${result.ticketsFound}`);
  if (!result.ok) process.exit(1);
}

async function runBuildCommand(
  rest: string[],
  pipeline: boolean,
  dependencies: InternalCliDependencies,
): Promise<void> {
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    console.log(pipeline ? PIPELINE_USAGE : BUILD_USAGE);
    return;
  }
  const opts = resolveBuildOptions(rest);
  console.log(formatCapabilityReport());
  requireBuildCapabilities(rest);
  const lifecycle = await import("./lifecycle/build.js");
  const fixtureBuildDependencies = dependencies.buildDependencies === undefined
    ? undefined
    : {
        ...dependencies.buildDependencies,
        ...(dependencies.assertEnvironment === undefined
          ? {}
          : { assertEnvironment: dependencies.assertEnvironment }),
      };
  const result = fixtureBuildDependencies === undefined
    ? pipeline
      ? await lifecycle.runPipeline(opts)
      : await lifecycle.runBuild(opts)
    : pipeline
      ? await import("./testing/fixture-runtime.js").then(({ runFixturePipeline }) =>
          runFixturePipeline(opts, fixtureBuildDependencies))
      : await import("./testing/fixture-runtime.js").then(({ runFixtureBuild }) =>
          runFixtureBuild(opts, fixtureBuildDependencies));
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
  const result = collect(process.cwd(), getRickgentDir(), process.env);
  console.log(rest.includes("--json") ? result.json : result.report);
}

async function runLifecycleCommand(
  execute: () => Promise<LifecycleCommandResult>,
): Promise<void> {
  try {
    const result = await execute();
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    if (error instanceof LifecycleCommandError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    throw error;
  }
}

async function executeMain(
  args: string[],
  dependencies: InternalCliDependencies,
): Promise<void> {
  (dependencies.assertEnvironment ?? assertNoProductionBypasses)(process.env);
  const command = args[0] ?? "";
  const rest = args.slice(1);

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

  if (!helpOnly && rest.includes("--resume")) RUNTIME_CAPABILITY_GATE.require("resume_retry");
  if (!helpOnly && command === "microverse" && rest.includes("--metric")) RUNTIME_CAPABILITY_GATE.require("raw_shell");

  if (command === "verdict") return runVerdict(rest);
  if (command === "doctor") return runDoctor(rest);
  if (command === "status") return runStatus(rest);
  if (command === "reconcile") return runReconcile();
  if (command === "metrics") return runMetrics(rest);

  if (command === "microverse") {
    if (!helpOnly) RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const { runMicroverseCommand } = await import("./lifecycle/microverse-cli.js");
    return runLifecycleCommand(() => runMicroverseCommand(rest));
  }
  if (command === "cronenberg") {
    if (!helpOnly && !rest.includes("--dry-run")) RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const { runCronenbergCommand } = await import("./lifecycle/cronenberg-run.js");
    return runLifecycleCommand(() =>
      runCronenbergCommand(rest, dependencies.cronenbergChildCliPath));
  }
  if (command === "citadel") {
    const { runCitadelCommand } = await import("./lifecycle/citadel-cli.js");
    return runLifecycleCommand(() => runCitadelCommand(rest));
  }
  if (command === "prd") {
    if (!helpOnly && !rest.includes("--non-interactive")) RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const { runPrdCommand } = await import("./lifecycle/prd-interview.js");
    return runLifecycleCommand(() => runPrdCommand(rest));
  }
  if (command === "refine") {
    if (!helpOnly) RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const { runRefineCommand } = await import("./lifecycle/refine.js");
    return runLifecycleCommand(() => runRefineCommand(rest));
  }
  if (command === "szechuan") {
    if (!helpOnly) RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const { runSzechuanCommand } = await import("./lifecycle/szechuan-cli.js");
    return runLifecycleCommand(() => runSzechuanCommand(rest));
  }
  if (command === "anatomy") {
    if (!helpOnly) RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
    const { runAnatomyCommand } = await import("./lifecycle/anatomy.js");
    return runLifecycleCommand(() => runAnatomyCommand(rest));
  }
}

/** Public production CLI entrypoint. Capability authority is not injectable. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  return executeMain(args, {});
}

/**
 * Package-private fixture bridge. The public package export map omits this
 * module and the public `main` signature cannot receive these dependencies.
 *
 * @internal
 */
export async function runCliWithDependenciesForTesting(
  authority: object,
  args: string[],
  dependencies: InternalCliDependencies,
): Promise<void> {
  // The authority module and bridge are excluded from the npm artifact. An
  // absolute-path caller therefore fails here before injected code executes.
  const { assertFixtureRuntimeAuthority } = await import("./testing/fixture-authority.js");
  assertFixtureRuntimeAuthority(authority);
  return executeMain(args, dependencies);
}

interface StateBoundaryError extends Error {
  readonly name: "StateStoreError";
  readonly code: string;
  readonly failureClass: "input_contract" | "infrastructure";
  readonly recovery: string;
}

function isStateBoundaryError(error: unknown): error is StateBoundaryError {
  if (!(error instanceof Error) || error.name !== "StateStoreError") return false;
  const candidate = error as Partial<StateBoundaryError>;
  return typeof candidate.code === "string" &&
    (candidate.code.startsWith("RICKGENT_STATE_") || candidate.code === "RICKGENT_LEGACY_STATE_QUARANTINED") &&
    (candidate.failureClass === "input_contract" || candidate.failureClass === "infrastructure") &&
    typeof candidate.recovery === "string" && candidate.recovery.length > 0;
}

export function handleFatal(error: unknown): never {
  if (error instanceof RickgentBoundaryError) {
    console.error(`${error.stableCode}: ${error.message}`);
    process.exit(error.exitCode);
  }
  if (isStateBoundaryError(error)) {
    console.error(`${error.code}: ${error.message}`);
    console.error(`recovery: ${error.recovery}`);
    process.exit(error.failureClass === "input_contract" ? 2 : 4);
  }
  console.error(`RICKGENT_INTERNAL_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(70);
}

export function isCliEntrypoint(argvPath: string | undefined, moduleUrl = import.meta.url): boolean {
  if (argvPath === undefined) return false;
  try {
    // npm/pnpm expose package bins as symlinks. Compare the canonical target,
    // otherwise an installed `rickgent` silently imports the CLI and exits 0
    // without executing main.
    const argvUrl = pathToFileURL(realpathSync(resolve(argvPath))).href;
    const moduleTargetUrl = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
    return argvUrl === moduleTargetUrl;
  } catch {
    return false;
  }
}
const isEntrypoint = isCliEntrypoint(process.argv[1]);
if (isEntrypoint) main().catch(handleFatal);
