#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = join(packageRoot, ".rickgent-package-staging");
if (!existsSync(marker)) process.exit(0);
const match = readFileSync(marker, "utf8").match(/^rickgent-package-staging\/v2\nowner_pid=([1-9][0-9]*)\n$/u);
if (!match) {
  throw new Error("RICKGENT_PACKAGE_CLEANUP: invalid staging marker; refusing cleanup");
}
if (Number(match[1]) !== process.ppid) {
  throw new Error("RICKGENT_PACKAGE_CLEANUP: staging marker belongs to another package process; refusing cleanup");
}
for (const name of ["agents", "runtime", "proof", "validators", "LICENSE"]) {
  rmSync(join(packageRoot, name), { recursive: true, force: true });
}
rmSync(marker);
