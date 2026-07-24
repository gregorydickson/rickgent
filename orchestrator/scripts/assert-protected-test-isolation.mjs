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
if (!config.includes('include: ["test/**/*.test.ts"]')) failures.push("ordinary discovery is not pinned to the audited test tree");
if (String(packageJson.scripts?.test) !== "vitest run") failures.push("ordinary test command changed and isolation is no longer auditable");
if (!liveSource.includes("RICKGENT_PROTECTED_AUTHORITY")) failures.push("live test has no explicit authority guard");
if (!liveSource.includes("run-protected-release.mjs")) failures.push("live test is not pinned to the protected runner boundary");
if (config.includes("passWithNoTests")) failures.push("ordinary test may silently pass missing tests");
if (/(?:describe|it|test)(?:\s*\.\s*(?:concurrent|sequential))*\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b|(?:xdescribe|xit|xtest)\s*\(/.test(liveSource)) {
  failures.push("authority-bearing live proof may be skipped, todo, or selectively discovered");
}
if (/\b(?:it|test)\s*\(\s*(?:process\.env|[^,]*\?)/.test(liveSource)) {
  failures.push("authority-bearing live proof uses conditional test construction");
}
if (/if\s*\([^)]*RICKGENT_PROTECTED_AUTHORITY[^)]*\)\s*(?:return\b|process\.exit\s*\(\s*0\s*\))/.test(liveSource)) {
  failures.push("missing protected authority may be accepted as success");
}
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  if (name !== "test" && typeof command === "string" && /\bvitest\b/.test(command) && command.includes(livePath)) {
    failures.push(`package script ${name} creates alternate live-test discovery`);
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`PROTECTED_TEST_ISOLATION: ${failure}`);
  process.exit(1);
}
console.log("protected live test is explicitly excluded from ordinary pnpm test and authority-bound");
