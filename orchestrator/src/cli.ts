#!/usr/bin/env node
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

  // Stub for not-yet-implemented commands
  const implemented = ["verdict", "doctor", "--version", "--build-commit", "--help"];
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

main().catch((err) => {
  console.error(`rickgent: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
