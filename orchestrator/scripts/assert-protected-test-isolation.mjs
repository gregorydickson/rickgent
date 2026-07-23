#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const livePath = "test/reliability/protected-release.live.test.ts";
const liveSource = readFileSync(resolve(root, livePath), "utf8");

const failures = [];
if (!config.includes(`exclude: ["${livePath}"]`)) failures.push("vitest config does not explicitly exclude the authority-bearing live test");
if (String(packageJson.scripts?.test) !== "vitest run") failures.push("ordinary test command changed and isolation is no longer auditable");
if (!liveSource.includes("RICKGENT_PROTECTED_AUTHORITY")) failures.push("live test has no explicit authority guard");
if (!liveSource.includes("run-protected-release.mjs")) failures.push("live test is not pinned to the protected runner boundary");
if (config.includes("passWithNoTests")) failures.push("ordinary test may silently pass missing tests");
if (failures.length > 0) {
  for (const failure of failures) console.error(`PROTECTED_TEST_ISOLATION: ${failure}`);
  process.exit(1);
}
console.log("protected live test is explicitly excluded from ordinary pnpm test and authority-bound");
