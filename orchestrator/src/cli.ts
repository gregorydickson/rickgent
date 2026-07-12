#!/usr/bin/env node
import { join } from "path";
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
    if (args.includes("--resume")) {
      console.log("rickgent build --resume: resume not yet wired");
      return;
    }
    console.error(`rickgent: build not yet implemented in v0.1.0-alpha scaffold`);
    console.error(USAGE);
    process.exit(1);
  }

  if (command === "pipeline") {
    const prd = args[1];
    if (!prd) {
      console.error("rickgent pipeline: missing <prd> argument");
      process.exit(1);
    }
    console.log(`rickgent pipeline: PRD path = ${prd}`);
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

main().catch((err) => {
  console.error(`rickgent: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
