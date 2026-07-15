// Citadel PRD parser — extracts the audit-relevant declarations from a PRD:
// declared HTTP endpoints, state transitions, and the `composes:` frontmatter
// graph. Acceptance criteria are shaped by the single PRD parser
// (`parsePrdFile` in lifecycle/prd-parse.ts); this module never re-implements
// AC parsing.

import { readFileSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import { parsePrdMarkdown } from "../prd-parse.js";
import type { AcceptanceCriterion } from "../../core/prd.js";

export interface DeclaredEndpoint {
  method: string;
  path: string;
  raw: string;
}

export interface CitadelPrd {
  acceptanceCriteria: AcceptanceCriterion[];
  endpoints: DeclaredEndpoint[];
  transitions: string[];
  composed: string[];
}

const ENDPOINT_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[A-Za-z0-9_\-/:{}]*)/g;
const MAX_COMPOSES_DEPTH = 8;

function extractComposes(markdown: string): string[] {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const body = fm[1] ?? "";
  const paths: string[] = [];
  // Inline array form: `composes: [a.md, b.md]`
  const inline = body.match(/^\s*composes:\s*\[([^\]]*)\]/m);
  if (inline) {
    for (const item of (inline[1] ?? "").split(",")) {
      const p = item.trim().replace(/^["']|["']$/g, "");
      if (p) paths.push(p);
    }
  }
  // Multiline list form:
  //   composes:
  //     - a.md
  //     - b.md
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*composes:\s*$/.test(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = (lines[j] ?? "").match(/^\s*-\s*(.+?)\s*$/);
      if (!m) break;
      paths.push((m[1] ?? "").replace(/^["']|["']$/g, ""));
    }
  }
  return [...new Set(paths.filter((p) => p.length > 0))];
}

function extractEndpoints(markdown: string): DeclaredEndpoint[] {
  const out: DeclaredEndpoint[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    for (const m of line.matchAll(ENDPOINT_RE)) {
      const method = (m[1] ?? "").toUpperCase();
      const path = m[2] ?? "";
      const key = `${method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method, path, raw: line.trim() });
    }
  }
  return out;
}

function extractTransitions(markdown: string): string[] {
  const edges = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!/->|→/.test(line)) continue;
    // A chain "A -> B -> C" yields consecutive edges A->B and B->C. Reduce each
    // arrow-delimited segment to its bounding identifier token.
    const states = line
      .split(/->|→/)
      .map((seg) => {
        const trailing = seg.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        const leading = seg.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        return trailing?.[1] ?? leading?.[1];
      })
      .filter((s): s is string => Boolean(s));
    for (let i = 0; i + 1 < states.length; i++) {
      const from = states[i];
      const to = states[i + 1];
      if (from && to) edges.add(`${from}->${to}`);
    }
  }
  return [...edges];
}

function parseOne(markdown: string): { endpoints: DeclaredEndpoint[]; transitions: string[]; acs: AcceptanceCriterion[] } {
  return {
    endpoints: extractEndpoints(markdown),
    transitions: extractTransitions(markdown),
    acs: parsePrdMarkdown(markdown).prd.acceptanceCriteria,
  };
}

export function parseCitadelPrd(prdPath: string, repoRoot: string): CitadelPrd {
  // Fail closed: a missing/unreadable PRD throws (readFileSync) and the caller
  // surfaces it as a non-zero exit.
  const root = resolve(prdPath);
  const markdown = readFileSync(root, "utf-8");
  const base = parseOne(markdown);

  const endpoints = [...base.endpoints];
  const transitions = new Set(base.transitions);
  const acs = [...base.acs];
  const composed: string[] = [];

  const composePaths = extractComposes(markdown);
  const onPath = new Set<string>([safeReal(root)]);
  const walk = (fromDir: string, paths: string[], depth: number): void => {
    if (depth > MAX_COMPOSES_DEPTH) throw new Error(`composes: chain exceeded max depth ${MAX_COMPOSES_DEPTH}`);
    for (const rel of paths) {
      if (/[*?]/.test(rel)) throw new Error(`composes: glob patterns not allowed: ${rel}`);
      if (rel.startsWith("/")) throw new Error(`composes: path must be repo-relative: ${rel}`);
      const abs = join(repoRoot, rel);
      const real = safeReal(abs);
      composed.push(rel);
      if (onPath.has(real)) throw new Error(`composes: cycle detected at ${rel}`);
      let content: string;
      try {
        content = readFileSync(real, "utf-8");
      } catch (err) {
        throw new Error(`composes: cannot read composed PRD "${rel}": ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsed = parseOne(content);
      endpoints.push(...parsed.endpoints);
      for (const t of parsed.transitions) transitions.add(t);
      acs.push(...parsed.acs);
      onPath.add(real);
      walk(dirname(real), extractComposes(content), depth + 1);
      onPath.delete(real);
    }
  };
  walk(dirname(root), composePaths, 0);

  return {
    acceptanceCriteria: acs,
    endpoints: dedupeEndpoints(endpoints),
    transitions: [...transitions],
    composed: [...new Set(composed)],
  };
}

function dedupeEndpoints(endpoints: DeclaredEndpoint[]): DeclaredEndpoint[] {
  const seen = new Set<string>();
  const out: DeclaredEndpoint[] = [];
  for (const e of endpoints) {
    const key = `${e.method} ${e.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
