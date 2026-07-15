// Endpoint contract conformance — compares PRD-declared HTTP endpoints against
// actual route declarations discovered in source files (NestJS HTTP decorators
// and Express-style route registrations). Emits a finding for each mismatch,
// naming both the declared and actual route.

import { readFileSync } from "fs";
import { join, relative } from "path";
import type { DeclaredEndpoint } from "./prd-audit-parser.js";
import type { DiffSummary } from "./diff-walker.js";
import { slugify, toPosixPath } from "./reporter.js";
import type { RawFinding } from "./reporter.js";

const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/i;
// Matches HTTP decorators with an optional quoted path argument. Supports
// @Post('user'), @Post("user"), @Post(`/user`), and no-arg @Post().
const HTTP_DECORATOR_RE = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:['"`]([^'"`]*)['"`])?/gi;
const CONTROLLER_PREFIX_RE = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/i;
const EXPRESS_RE = /\b(?:app|router)\s*\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]*)['"`]/gi;
const METHOD_NORMALIZE: Record<string, string> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD", options: "OPTIONS",
};

interface ActualRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}

function normalizePath(p: string): string {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  return s.replace(/\/+/g, "/");
}

function parseRoutes(diff: DiffSummary): ActualRoute[] {
  const routes: ActualRoute[] = [];
  // Scope route scanning to files in the diff only — the audit is about the
  // changeset, not the entire repo. Scanning all source files produces false
  // positives from pre-existing routes that aren't part of the diff.
  const changedSourceFiles = diff.changedFiles.filter(
    (f) => f.status !== "D" && SOURCE_FILE_RE.test(f.path),
  );
  for (const changed of changedSourceFiles) {
    const file = join(diff.repoRoot, changed.path);
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    let controllerPrefix = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const ctrl = line.match(CONTROLLER_PREFIX_RE);
      if (ctrl) controllerPrefix = normalizePath(ctrl[1] ?? "");
      for (const m of line.matchAll(HTTP_DECORATOR_RE)) {
        const method = METHOD_NORMALIZE[(m[1] ?? "").toLowerCase()] ?? (m[1] ?? "").toUpperCase();
        const path = normalizePath((controllerPrefix || "") + "/" + (m[2] ?? ""));
        routes.push({ method, path: normalizePath(path), file: toPosixPath(relative(diff.repoRoot, file)), line: i + 1 });
      }
      for (const m of line.matchAll(EXPRESS_RE)) {
        const method = METHOD_NORMALIZE[(m[1] ?? "").toLowerCase()] ?? (m[1] ?? "").toUpperCase();
        const path = normalizePath(m[2] ?? "");
        routes.push({ method, path, file: toPosixPath(relative(diff.repoRoot, file)), line: i + 1 });
      }
    }
  }
  return routes;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

function closestDeclared(route: ActualRoute, declared: DeclaredEndpoint[]): DeclaredEndpoint | undefined {
  let best: DeclaredEndpoint | undefined;
  let bestDist = Infinity;
  for (const d of declared) {
    if (d.method !== route.method) continue;
    const dist = levenshtein(d.path, route.path);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

export function checkEndpointConformance(
  declared: DeclaredEndpoint[],
  diff: DiffSummary,
): { findings: RawFinding[]; rows: unknown[] } {
  const routes = parseRoutes(diff);
  const declaredKeys = new Set(declared.map((e) => `${e.method} ${normalizePath(e.path)}`));
  const actualKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const findings: RawFinding[] = [];

  // Actual route not declared in the PRD → mismatch finding.
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (declaredKeys.has(key)) continue;
    const closest = closestDeclared(route, declared);
    const declaredRef = closest ? `declared ${closest.method} ${closest.path}` : "no matching declared endpoint";
    findings.push({
      id: `endpoint-conformance:undeclared-route:${slugify(route.method)}:${slugify(route.path)}`,
      rule: "endpoint-conformance:undeclared-route",
      severity: "High",
      file: route.file,
      line: route.line,
      message: `Actual route ${route.method} ${route.path} at ${route.file}:${route.line} is not declared in the PRD (${declaredRef}).`,
    });
  }

  // Declared endpoint with no implementation → mismatch finding.
  for (const d of declared) {
    const key = `${d.method} ${normalizePath(d.path)}`;
    if (actualKeys.has(key)) continue;
    findings.push({
      id: `endpoint-conformance:missing-implementation:${slugify(d.method)}:${slugify(d.path)}`,
      rule: "endpoint-conformance:missing-implementation",
      severity: "Medium",
      file: "PRD",
      message: `PRD-declared endpoint ${d.method} ${d.path} has no matching route implementation in the repo.`,
    });
  }

  return { findings, rows: [] };
}
