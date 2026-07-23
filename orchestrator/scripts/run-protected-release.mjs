#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  console.error(`PROTECTED_RELEASE_REFUSED: ${message}`);
  process.exit(2);
}

if (process.env.RICKGENT_PROTECTED_AUTHORITY !== "I_ACCEPT_REMOTE_MUTATION") fail("explicit protected authority is absent");
const profileArg = process.argv[2];
if (profileArg === undefined || !profileArg.startsWith("/")) fail("absolute protected profile path is required");
const profilePath = realpathSync(profileArg);
if (!existsSync(profilePath)) fail("protected profile does not exist");
for (const name of ["RICKGENT_INSTALLED_CLI", "RICKGENT_PROTECTED_ADAPTER"]) {
  const value = process.env[name];
  if (value === undefined || !value.startsWith("/") || !existsSync(value)) fail(`${name} must select an installed absolute artifact`);
}
const cli = realpathSync(process.env.RICKGENT_INSTALLED_CLI);
if (cli.includes("/rickgent/orchestrator/") || cli.includes("/node_modules/.pnpm/")) fail("checkout/source entrypoint is forbidden");
const adapterPath = realpathSync(process.env.RICKGENT_PROTECTED_ADAPTER);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const adapter = await import(`file://${adapterPath}`);
if (typeof adapter.run !== "function") fail("protected adapter must export run(profile, installedCli)");
const result = await adapter.run(profile, cli);
if (result?.ok !== true || result?.repository_deleted !== false || result?.cleanup_requeried !== true) {
  fail("protected controller did not produce a complete fail-closed result");
}
console.log(JSON.stringify(result));
