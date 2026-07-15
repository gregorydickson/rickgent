// Project shape detection — classifies the target repo's stack from
// package.json dependencies AND source-file imports. The detection is
// dual-sourced so a repo that declares a framework only in source (no
// package.json, or deps not yet installed) still classifies correctly.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { toPosixPath } from "./reporter.js";

export type ProjectShape = "node-cli" | "react-frontend" | "nestjs-api" | "python" | "rust" | "unknown";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const MAX_SCAN_FILES = 400;

interface Pkg {
  bin?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(repoRoot: string): Pkg | null {
  const p = join(repoRoot, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Pkg;
  } catch {
    return null;
  }
}

function deps(pkg: Pkg | null): string[] {
  if (!pkg) return [];
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

function collectSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_SCAN_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile() && SOURCE_EXTS.has(toPosixPath(e.name).slice(e.name.lastIndexOf(".")))) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(repoRoot);
  return out;
}

function readImports(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

export interface ShapeFinding {
  shape: ProjectShape;
  evidence: string;
}

export function detectProjectShapes(repoRoot: string): { shapes: ProjectShape[]; findings: ShapeFinding[] } {
  const pkg = readPkg(repoRoot);
  const depList = deps(pkg);
  const sourceFiles = collectSourceFiles(repoRoot);

  let sourceHasNestjs = false;
  let sourceHasMainBootstrap = false;
  let sourceHasReact = false;
  let sourceHasJsx = false;

  for (const file of sourceFiles) {
    const rel = toPosixPath(relative(repoRoot, file));
    const content = readImports(file);
    if (/@nestjs\//.test(content)) sourceHasNestjs = true;
    if (/NestFactory\.create/.test(content)) sourceHasMainBootstrap = true;
    if (rel === "src/main.ts" || rel === "main.ts") sourceHasMainBootstrap = true;
    if (/\bfrom\s+['"]react['"]/.test(content) || /\brequire\(['"]react['"]\)/.test(content)) {
      sourceHasReact = true;
    }
    if (/\.tsx?$/.test(rel) && /<[A-Za-z][\w.]*(?:\s[^>]*)?\/?>/.test(content)) {
      sourceHasJsx = true;
    }
  }

  const hasNestjsDep = depList.some((d) => d === "@nestjs/core" || d.startsWith("@nestjs/"));
  const hasReactDep = depList.some((d) => d === "react" || d === "next");
  const hasSrcTsx = sourceFiles.some((f) => f.endsWith(".tsx"));

  const shapes: ProjectShape[] = [];
  const findings: ShapeFinding[] = [];

  const isNestjs = hasNestjsDep || sourceHasNestjs;
  if (isNestjs) {
    shapes.push("nestjs-api");
    findings.push({
      shape: "nestjs-api",
      evidence: sourceHasNestjs
        ? `@nestjs/ import detected in source${sourceHasMainBootstrap ? " with main bootstrap" : ""}`
        : `@nestjs/ dependency in package.json`,
    });
  }

  const isReact = hasReactDep || sourceHasReact || hasSrcTsx || sourceHasJsx;
  if (isReact) {
    shapes.push("react-frontend");
    findings.push({
      shape: "react-frontend",
      evidence: sourceHasReact
        ? `react import detected in source${sourceHasJsx ? " with JSX/TSX" : ""}`
        : hasReactDep
          ? "react dependency in package.json"
          : "TSX source files present",
    });
  }

  if (pkg && pkg.bin !== undefined && !shapes.includes("nestjs-api")) {
    if (!depList.some((d) => d === "next")) shapes.push("node-cli");
  }
  if (existsSync(join(repoRoot, "requirements.txt")) || existsSync(join(repoRoot, "pyproject.toml"))) {
    shapes.push("python");
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    shapes.push("rust");
  }

  return { shapes: shapes.length > 0 ? shapes : ["unknown"], findings };
}
