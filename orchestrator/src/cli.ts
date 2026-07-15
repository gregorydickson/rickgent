#!/usr/bin/env node
import { join } from "path";
import { readFileSync } from "fs";
import { BUILD_COMMIT } from "./build-commit.js";
import { runVerdict } from "./core/verdict-cli.js";

const USAGE = `rickgent — autonomous multi-model engineering platform

Usage:
  rickgent                     Launch the default agent (interactive)
  rickgent prd                 PRD interview
  rickgent prd --from <file>   Adopt existing PRD
  rickgent refine <prd.md>     3-analyst refinement + decomposition
  rickgent refine <prd.md> --run  Refine + auto-launch
  rickgent build               Implement all tickets (8-phase loop)
  rickgent build --resume      Resume from existing session
  rickgent build --max-iterations N  Stop after N iterations
  rickgent citadel             Conformance audit
  rickgent szechuan            Deslopping
  rickgent anatomy             Subsystem review
  rickgent microverse --metric CMD  Convergence loop
  rickgent pipeline "<goal>"   Full lifecycle
  rickgent cronenberg "<goal>" Meta-router
  rickgent status              Session phase, ticket status
  rickgent status --deep       Deep health check
  rickgent metrics             Cost, commits, LOC
  rickgent reconcile           Rebuild registry from git + DB
  rickgent doctor              Behavioral smoke test
  rickgent verdict <check> --json  Run a verdict check (JSON I/O)
  rickgent --version           Print version + build commit
  rickgent --build-commit      Print build commit only
  rickgent --help              Show this help

Commands:
  prd, refine, build, citadel, szechuan, anatomy, microverse,
  pipeline, cronenberg, status, metrics, reconcile, doctor, verdict
`;

const BUILD_USAGE = `rickgent build — implement all tickets through the gated build loop

Usage:
  rickgent build <prd> [options]
  rickgent build --resume [options]

Required (unless --resume):
  <prd>                     PRD markdown file to decompose into tickets

Options:
  --repo <dir>              Target git repo (default: RICKGENT_TARGET_REPO or cwd)
  --agent <dir>             omnigent agent bundle directory
  --feature <branch>        Feature branch to build on
  --max-concurrent <N>      Max concurrent dispatches (default: 2)
  --roster <file>           JSON model roster for routing
  --cost-budget <usd>       Hard cost budget per dispatch
  --soft-threshold <usd>    Soft cost threshold (triggers ASK)
  --resume                  Resume from an existing session (ledger + git state)
  --no-autonomous-pr        Disable autonomous PR flow
  --max-iterations <N>      Stop after N iterations

Each ticket runs the 9-gate pipeline, including the conformance gate (citadel)
and the deslop gate (szechuan), before merge.
`;

const PIPELINE_USAGE = `rickgent pipeline — full lifecycle (build + convergence + reconcile cleanup)

Usage:
  rickgent pipeline <prd> [options]

Accepts the same flags as \`rickgent build\` (--repo, --agent, --feature,
--max-concurrent, --roster, --cost-budget, --soft-threshold, --resume,
--no-autonomous-pr, --max-iterations).

Runs the gated build loop (including the conformance/citadel and deslop/szechuan
gates), then convergence and reconcile cleanup.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "";

  if (command === "--version" || command === "-v") {
    console.log(`rickgent 0.1.0-alpha (build ${BUILD_COMMIT.slice(0, 12)})`);
    return;
  }

  if (command === "--build-commit") {
    console.log(BUILD_COMMIT);
    return;
  }

  if (command === "--help" || command === "-h" || command === "") {
    console.log(USAGE);
    return;
  }

  if (command === "verdict") {
    await runVerdict(args.slice(1));
    return;
  }

  if (command === "doctor") {
    await runDoctor();
    return;
  }

  if (command === "status") {
    await runStatus(args.slice(1));
    return;
  }

  if (command === "reconcile") {
    await runReconcile();
    return;
  }

  if (command === "build") {
    await runBuildCommand(args.slice(1));
    return;
  }

  if (command === "metrics") {
    await runMetricsCommand(args.slice(1));
    return;
  }

  if (command === "pipeline") {
    await runPipelineCommand(args.slice(1));
    return;
  }

  if (command === "microverse") {
    const { runMicroverseCommand } = await import("./lifecycle/microverse-cli.js");
    await runMicroverseCommand(args.slice(1));
    return;
  }

  if (command === "cronenberg") {
    const { runCronenbergCommand } = await import("./lifecycle/cronenberg-run.js");
    await runCronenbergCommand(args.slice(1));
    return;
  }

  if (command === "citadel") {
    const { runCitadelCommand } = await import("./lifecycle/citadel-cli.js");
    await runCitadelCommand(args.slice(1));
    return;
  }

  if (command === "prd") {
    const { runPrdCommand } = await import("./lifecycle/prd-interview.js");
    await runPrdCommand(args.slice(1));
    return;
  }

  if (command === "refine") {
    const { runRefineCommand } = await import("./lifecycle/refine.js");
    await runRefineCommand(args.slice(1));
    return;
  }

  if (command === "szechuan") {
    const { runSzechuanCommand } = await import("./lifecycle/szechuan-cli.js");
    await runSzechuanCommand(args.slice(1));
    return;
  }

  if (command === "anatomy") {
    const { runAnatomyCommand } = await import("./lifecycle/anatomy.js");
    await runAnatomyCommand(args.slice(1));
    return;
  }

  // Stub for not-yet-implemented commands
  const implemented = [
    "verdict",
    "doctor",
    "status",
    "reconcile",
    "build",
    "pipeline",
    "metrics",
    "microverse",
    "cronenberg",
    "citadel",
    "prd",
    "refine",
    "szechuan",
    "anatomy",
    "--version",
    "--build-commit",
    "--help",
  ];
  if (!implemented.includes(command)) {
    console.error(`rickgent: command "${command}" not yet implemented in v0.1.0-alpha scaffold`);
    console.error(USAGE);
    process.exit(1);
  }
}

async function runDoctor(): Promise<void> {
  const { runDoctorCheck } = await import("./lifecycle/doctor.js");
  const result = await runDoctorCheck();
  if (!result.ok) {
    console.error(result.report);
    process.exit(1);
  }
  console.log(result.report);
}

function getRickgentDir(): string {
  return process.env.RICKGENT_DIR ?? join(process.cwd(), ".rickgent");
}

async function runStatus(rest: string[]): Promise<void> {
  const deep = rest.includes("--deep");

  if (deep) {
    // status --deep runs the doctor check first, then prints pipeline status
    const { runDoctorCheck } = await import("./lifecycle/doctor.js");
    const doctorResult = await runDoctorCheck();
    console.log(doctorResult.report);
    if (!doctorResult.ok) {
      console.error("rickgent status --deep: doctor check failed");
      process.exit(1);
    }
  }

  const { Registry } = await import("./lifecycle/registry.js");
  const registryPath = join(getRickgentDir(), "registry.json");
  const registry = new Registry(registryPath);
  const status = registry.getPipelineStatus();

  const lines: string[] = [
    "rickgent status — pipeline state",
    "=".repeat(50),
    `runId: ${status.runId || "(none)"}`,
    `startedAt: ${status.startedAt || "(none)"}`,
    `updatedAt: ${status.updatedAt || "(none)"}`,
    `tickets: ${Object.keys(status.tickets).length}`,
  ];
  for (const [id, t] of Object.entries(status.tickets)) {
    lines.push(`  ${id}: [${t.status}] phase=${t.phase} attempt=${t.attempt} commit=${t.completionCommitSha ?? "(none)"}`);
  }
  lines.push("=".repeat(50));
  console.log(lines.join("\n"));
}

async function runReconcile(): Promise<void> {
  const { reconcile } = await import("./lifecycle/reconcile.js");
  const workingDir = process.cwd();
  const rickgentDir = getRickgentDir();
  const result = reconcile(workingDir, rickgentDir);

  const lines: string[] = [
    "rickgent reconcile — rebuild registry from git + dispatch ledger",
    "=".repeat(50),
    `ok: ${result.ok}`,
    `rebuilt: ${result.rebuilt}`,
    `ticketsFound: ${result.ticketsFound}`,
  ];
  if (result.errors.length > 0) {
    lines.push("errors:");
    for (const e of result.errors) {
      lines.push(`  - ${e}`);
    }
  }
  lines.push("=".repeat(50));
  console.log(lines.join("\n"));

  if (!result.ok) {
    process.exit(1);
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function resolveBuildOptions(rest: string[]): {
  prdPath: string;
  workingDir: string;
  rickgentDir: string;
  agentDir: string;
  dataDir: string;
  resume: boolean;
  autonomousPrFlow: boolean;
  featureBranch: string | undefined;
  maxConcurrent: number | undefined;
  roster: import("./lifecycle/routing.js").ModelEntry[] | undefined;
  costBudgetUsd: number | undefined;
  softThresholdUsd: number | undefined;
} | null {
  const valueFlags = new Set(["--repo", "--agent", "--feature", "--max-concurrent", "--roster", "--cost-budget", "--soft-threshold"]);
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (valueFlags.has(a)) {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("--")) continue;
    positionals.push(a);
  }
  const prdPath = positionals[0];
  if (!prdPath) {
    console.error("rickgent build: missing <prd> argument");
    return null;
  }
  const workingDir = flagValue(rest, "--repo") ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd();
  const rickgentDir = getRickgentDir();
  const agentDir =
    flagValue(rest, "--agent") ??
    process.env.RICKGENT_AGENT_DIR ??
    join(new URL("../../", import.meta.url).pathname, "agents", "rickgent");
  const dataDir = process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data");
  const resume = rest.includes("--resume");
  const autonomousPrFlow = !rest.includes("--no-autonomous-pr") && process.env.RICKGENT_AUTONOMOUS_PR_FLOW !== "0";
  const featureBranch = flagValue(rest, "--feature") ?? process.env.RICKGENT_FEATURE_BRANCH;
  const maxConcurrentRaw = flagValue(rest, "--max-concurrent") ?? process.env.RICKGENT_MAX_CONCURRENT;
  const maxConcurrentParsed = maxConcurrentRaw !== undefined ? parseInt(maxConcurrentRaw, 10) : NaN;
  const maxConcurrent = Number.isNaN(maxConcurrentParsed) ? undefined : maxConcurrentParsed;

  // Model roster (B8): resolve from --roster <file> (JSON) or RICKGENT_MODEL_ROSTER env var.
  let roster: import("./lifecycle/routing.js").ModelEntry[] | undefined;
  const rosterFile = flagValue(rest, "--roster");
  const rosterRaw = rosterFile ? readRosterFile(rosterFile) : process.env.RICKGENT_MODEL_ROSTER;
  if (rosterRaw) {
    try {
      const parsed = JSON.parse(rosterRaw);
      if (Array.isArray(parsed)) roster = parsed;
    } catch {
      console.error("rickgent build: invalid model roster JSON");
    }
  }

  const costBudgetRaw = flagValue(rest, "--cost-budget") ?? process.env.RICKGENT_COST_BUDGET_USD;
  const costBudgetUsd = costBudgetRaw !== undefined ? Number(costBudgetRaw) : undefined;
  const softThresholdRaw = flagValue(rest, "--soft-threshold") ?? process.env.RICKGENT_SOFT_THRESHOLD_USD;
  const softThresholdUsd = softThresholdRaw !== undefined ? Number(softThresholdRaw) : undefined;

  return { prdPath, workingDir, rickgentDir, agentDir, dataDir, resume, autonomousPrFlow, featureBranch, maxConcurrent, roster, costBudgetUsd: Number.isNaN(costBudgetUsd as number) ? undefined : costBudgetUsd, softThresholdUsd: Number.isNaN(softThresholdUsd as number) ? undefined : softThresholdUsd };
}

function readRosterFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    console.error(`rickgent build: cannot read roster file: ${path}`);
    return "";
  }
}

async function runBuildCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(BUILD_USAGE);
    return;
  }
  const opts = resolveBuildOptions(rest);
  if (!opts) {
    process.exit(1);
  }
  const { runBuild } = await import("./lifecycle/build.js");
  const result = await runBuild(opts);
  console.log(result.report.join("\n"));
  console.log(
    `build: planned=${result.ticketsPlanned} dispatched=${result.ticketsDispatched} ` +
      `done=${result.ticketsDone} failed=${result.ticketsFailed} recovered=${result.ticketsRecovered} ` +
      `interventions=${result.interventions} prCreated=${result.prCreated}`,
  );
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

async function runPipelineCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(PIPELINE_USAGE);
    return;
  }
  const opts = resolveBuildOptions(rest);
  if (!opts) {
    process.exit(1);
  }
  const { runPipeline } = await import("./lifecycle/build.js");
  const result = await runPipeline(opts);
  console.log(result.report.join("\n"));
  console.log(
    `pipeline: planned=${result.ticketsPlanned} dispatched=${result.ticketsDispatched} ` +
      `done=${result.ticketsDone} failed=${result.ticketsFailed} recovered=${result.ticketsRecovered} ` +
      `interventions=${result.interventions} prCreated=${result.prCreated} ` +
      `cleanupReconciled=${result.cleanup.ticketsReconciled}`,
  );
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

async function runMetricsCommand(rest: string[]): Promise<void> {
  const asJson = rest.includes("--json");
  const { runMetrics } = await import("./lifecycle/metrics.js");
  const out = runMetrics(getRickgentDir(), process.env);
  if (asJson) {
    console.log(out.json);
  } else {
    console.log(out.report);
  }
}

main().catch((err) => {
  console.error(`rickgent: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
