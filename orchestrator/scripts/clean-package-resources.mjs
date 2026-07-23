#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = join(packageRoot, ".rickgent-package-staging");
if (!existsSync(marker)) process.exit(0);
if (readFileSync(marker, "utf8") !== "rickgent-package-staging/v1\n") {
  throw new Error("RICKGENT_PACKAGE_CLEANUP: invalid staging marker; refusing cleanup");
}
for (const name of ["agents", "runtime", "proof", "validators", "LICENSE"]) {
  rmSync(join(packageRoot, name), { recursive: true, force: true });
}
rmSync(marker);
