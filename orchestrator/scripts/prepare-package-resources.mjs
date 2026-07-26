#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const generated = ["agents", "runtime", "proof", "validators", "LICENSE"];
const marker = join(packageRoot, ".rickgent-package-staging");
const markerValue = `rickgent-package-staging/v2\nowner_pid=${process.ppid}\n`;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

function fail(message) {
  throw new Error(`RICKGENT_PACKAGE_ASSEMBLY: ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireMarker() {
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      writeFileSync(marker, markerValue, { flag: "wx" });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const match = readFileSync(marker, "utf8").match(/^rickgent-package-staging\/v2\nowner_pid=([1-9][0-9]*)\n$/u);
    if (!match) fail("invalid staging marker; clean the previous interrupted assembly");
    const ownerPid = Number(match[1]);
    if (!ownerIsAlive(ownerPid)) fail("stale staging marker owner; clean the previous interrupted assembly");
    if (Date.now() >= deadline) fail("timed out waiting for the active package assembly");
    Atomics.wait(lockWait, 0, 0, 100);
  }
}

acquireMarker();
for (const name of generated) {
  if (existsSync(join(packageRoot, name))) {
    rmSync(marker, { force: true });
    fail(`refusing to overwrite non-staged package resource: ${name}`);
  }
}
if (!existsSync(join(packageRoot, "dist", "cli.js"))) {
  rmSync(marker, { force: true });
  fail("compiled dist/cli.js is required; source builds are not part of packaging");
}
try {
  cpSync(join(repositoryRoot, "agents", "rickgent"), join(packageRoot, "agents", "rickgent"), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    filter: (source) => basename(source) !== "__pycache__" && !source.endsWith(".pyc"),
  });
  mkdirSync(join(packageRoot, "runtime"), { recursive: true });
  mkdirSync(join(packageRoot, "proof"), { recursive: true });
  mkdirSync(join(packageRoot, "validators"), { recursive: true });
  copyFileSync(join(repositoryRoot, "LICENSE"), join(packageRoot, "LICENSE"));
  copyFileSync(
    join(packageRoot, "schemas", "packed-install-receipt.schema.json"),
    join(packageRoot, "validators", "packed-install-receipt.schema.json"),
  );
  copyFileSync(
    join(packageRoot, "schemas", "vertical-slice-receipt.schema.json"),
    join(packageRoot, "validators", "vertical-slice-receipt.schema.json"),
  );
  const proofMetadata = {
    schema_version: "rickgent-proof-metadata/v1",
    canonicalization: "rickgent-canonical-json-v1",
    digest_algorithm: "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
    redaction_version: "rickgent-redaction-v1",
    packed_install_schema_id: "https://rickgent.dev/schemas/packed-install-receipt-v1.json",
    vertical_slice_schema_id: "https://rickgent.dev/schemas/vertical-slice-receipt-v1.json",
  };
  writeFileSync(join(packageRoot, "proof", "metadata.json"), `${JSON.stringify(proofMetadata, null, 2)}\n`);
  const map = {
    schema_version: "rickgent-resource-map/v1",
    resources: {
      cli: { path: "dist/cli.js", sha256: sha256(join(packageRoot, "dist", "cli.js")) },
      manager: { path: "agents/rickgent/config.yaml", sha256: sha256(join(packageRoot, "agents", "rickgent", "config.yaml")) },
      worker: { path: "agents/rickgent/agents/worker/config.yaml", sha256: sha256(join(packageRoot, "agents", "rickgent", "agents", "worker", "config.yaml")) },
      proof_metadata: { path: "proof/metadata.json", sha256: sha256(join(packageRoot, "proof", "metadata.json")) },
      validators_root: { path: "validators" },
      license: { path: "LICENSE", sha256: sha256(join(packageRoot, "LICENSE")) },
    },
  };
  writeFileSync(join(packageRoot, "runtime", "resource-map.json"), `${JSON.stringify(map, null, 2)}\n`);
} catch (error) {
  for (const name of generated) rmSync(join(packageRoot, name), { recursive: true, force: true });
  rmSync(marker, { force: true });
  throw error;
}
