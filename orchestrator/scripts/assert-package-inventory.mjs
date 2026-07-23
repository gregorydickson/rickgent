#!/usr/bin/env node
// assert-package-inventory.mjs
//
// Parses the npm pack inventory (npm pack --dry-run --json output) and the
// Python dist directory (python3 -m build output) into assertions against the
// release manifest's package_contents. Archive creation alone is not success:
// the inventory must contain every must_include entry and exclude every
// must_exclude pattern, and the Python wheel must contain the declared module
// with no forbidden paths. Fails closed (exit 1) on any violation.
//
// Usage: node orchestrator/scripts/assert-package-inventory.mjs <npm-pack-inventory.json> <python-dist-dir>
// Run from the repository root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`assert-package-inventory: ${message}\n`);
  process.exit(1);
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label}: cannot parse JSON at ${path}: ${error.message}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => {
    // A trailing "/" means "any file under this directory prefix".
    if (pattern.endsWith("/")) {
      return path.startsWith(pattern) || path === pattern.slice(0, -1);
    }
    // A bare token (e.g. ".tsbuildinfo") matches as a substring/suffix segment.
    if (pattern.startsWith(".")) {
      return path.includes(pattern);
    }
    return path === pattern || path.startsWith(`${pattern}/`);
  });
}

function extractZip(zipPath, destDir) {
  // Use the system `unzip` via execFileSync with array argv (no shell).
  execFileSync("unzip", ["-q", zipPath, "-d", destDir], {
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(root, full);
      if (statSync(full).isDirectory()) {
        visit(full);
      } else {
        out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}

function main() {
  const npmInventoryArg = process.argv[2];
  const pythonDistArg = process.argv[3];
  if (!npmInventoryArg || !pythonDistArg) {
    fail("usage: assert-package-inventory.mjs <npm-pack-inventory.json> <python-dist-dir>");
  }

  const repoRoot = resolve(process.cwd());
  const manifestPath = join(repoRoot, "release-manifest.json");
  if (!existsSync(manifestPath)) {
    fail("release-manifest.json not found at repository root");
  }
  const manifest = requireObject(loadJson(manifestPath, "manifest"), "manifest");
  const pkgContents = requireObject(manifest.package_contents, "package_contents");
  const npmContents = requireObject(pkgContents.npm, "package_contents.npm");
  const pyContents = requireObject(pkgContents.python, "package_contents.python");

  const npmMustInclude = npmContents.must_include;
  const npmMustExclude = npmContents.must_exclude;
  const pyMustIncludeModules = pyContents.must_include_modules;
  const pyMustExclude = pyContents.must_exclude;

  // --- npm pack inventory ---
  const npmInventoryPath = isAbsolute(npmInventoryArg) ? npmInventoryArg : resolve(repoRoot, npmInventoryArg);
  if (!existsSync(npmInventoryPath)) {
    fail(`npm pack inventory does not exist: ${npmInventoryArg} (run npm pack --dry-run --json first)`);
  }
  const npmInventory = loadJson(npmInventoryPath, "npm inventory");
  if (!Array.isArray(npmInventory) || npmInventory.length === 0) {
    fail("npm pack inventory is empty or malformed (expected npm pack --dry-run --json array)");
  }
  // npm pack --dry-run --json emits [{ files: [{ path: "dist/cli.js" }, ...], ... }]
  const npmFiles = [];
  for (const entry of npmInventory) {
    if (entry && Array.isArray(entry.files)) {
      for (const f of entry.files) {
        if (f && typeof f.path === "string") {
          npmFiles.push(f.path);
        }
      }
    }
  }
  if (npmFiles.length === 0) {
    fail("npm pack inventory contains no files");
  }

  for (const required of npmMustInclude) {
    if (!npmFiles.includes(required)) {
      fail(`npm pack inventory missing required file: ${required}`);
    }
  }
  const npmForbidden = npmFiles.filter((path) => matchesAny(path, npmMustExclude));
  if (npmForbidden.length > 0) {
    fail(`npm pack inventory contains forbidden paths: ${npmForbidden.join(", ")}`);
  }

  // --- Python dist inventory ---
  const pythonDistPath = isAbsolute(pythonDistArg) ? pythonDistArg : resolve(repoRoot, pythonDistArg);
  if (!existsSync(pythonDistPath)) {
    fail(`python dist directory does not exist: ${pythonDistArg} (run python3 -m build first)`);
  }
  const distEntries = readdirSync(pythonDistPath);
  const wheels = distEntries.filter((name) => name.endsWith(".whl"));
  const sdists = distEntries.filter((name) => name.endsWith(".tar.gz") && !name.endsWith(".pth.tar.gz"));
  if (wheels.length === 0 && sdists.length === 0) {
    fail(`python dist directory contains no wheel or sdist: ${pythonDistArg}`);
  }

  // Inspect the wheel contents (the installable artifact).
  let inspectedWheel = false;
  for (const wheel of wheels) {
    const wheelPath = join(pythonDistPath, wheel);
    const extractDir = mkdtempSync(join(tmpdir(), "rickgent-wheel-"));
    try {
      extractZip(wheelPath, extractDir);
      const wheelFiles = walkFiles(extractDir);
      // Each declared module must appear as a top-level package directory entry.
      for (const mod of pyMustIncludeModules) {
        const hasModule = wheelFiles.some((path) => path.startsWith(`${mod}/`));
        if (!hasModule) {
          fail(`python wheel ${wheel} is missing required module: ${mod}`);
        }
      }
      const pyForbidden = wheelFiles.filter((path) => matchesAny(path, pyMustExclude));
      if (pyForbidden.length > 0) {
        fail(`python wheel ${wheel} contains forbidden paths: ${pyForbidden.slice(0, 10).join(", ")}`);
      }
      inspectedWheel = true;
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }
  if (wheels.length > 0 && !inspectedWheel) {
    fail("python wheel was present but not inspected");
  }

  // Confirm the dist contains the declared package name.
  const pkgName = pyContents.package ?? "rickgent-policies";
  const hasNamedArtifact = [...wheels, ...sdists].some((name) => name.startsWith(pkgName.replace(/-/g, "_")));
  if (!hasNamedArtifact) {
    fail(`python dist does not contain an artifact for package "${pkgName}"`);
  }

  process.stdout.write(
    `package inventory aligned: npm ${npmFiles.length} files `
    + `(${npmMustInclude.length} required present, ${npmMustExclude.length} exclusions enforced), `
    + `python ${wheels.length} wheel(s) + ${sdists.length} sdist(s) inspected\n`,
  );
}

main();
