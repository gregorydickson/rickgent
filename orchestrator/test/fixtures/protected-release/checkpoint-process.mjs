#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const checkpoint = process.argv[2];
const runId = process.argv[3];
const stateId = process.argv[4];
if (!checkpoint || !runId || !stateId) process.exit(64);

const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)",
], { stdio: "ignore" });

writeFileSync(checkpoint, JSON.stringify({
  boundary: "post-persistence/pre-hosted-side-effect",
  run_id: runId,
  persistent_state_id: stateId,
  attempt_id: `${runId}:crash`,
  process_id: process.pid,
  process_group_id: process.pid,
  descendant_process_id: descendant.pid
}));

process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
