// State-transition audit — compares PRD-declared state transitions against
// transitions discovered in changed code. Emits a finding for each discovered
// transition (edge) not present in the declared set.

import { readFileSync } from "fs";
import { join } from "path";
import type { DiffSummary } from "./diff-walker.js";
import { slugify, toPosixPath } from "./reporter.js";
import type { RawFinding } from "./reporter.js";

const ARROW_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|→|=>)\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const FROM_TO_RE = /\.from\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\)\s*\.to\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\)/g;
const TRANSITION_CALL_RE = /\.transition\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*,\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\)/g;
const CODE_FILE_RE = /\.[cm]?[jt]sx?$/i;

interface DiscoveredEdge {
  from: string;
  to: string;
  file: string;
  line: number;
}

function discoverEdges(diff: DiffSummary): DiscoveredEdge[] {
  const out: DiscoveredEdge[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.status === "D" || !CODE_FILE_RE.test(changed.path)) continue;
    let content: string;
    try {
      content = readFileSync(join(diff.repoRoot, changed.path), "utf-8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const range of changed.changedLines) {
      for (let n = range.start; n <= range.end; n++) {
        const text = lines[n - 1] ?? "";
        for (const m of text.matchAll(ARROW_RE)) {
          out.push({ from: (m[1] ?? "").toUpperCase(), to: (m[2] ?? "").toUpperCase(), file: toPosixPath(changed.path), line: n });
        }
        for (const m of text.matchAll(FROM_TO_RE)) {
          out.push({ from: (m[1] ?? "").toUpperCase(), to: (m[2] ?? "").toUpperCase(), file: toPosixPath(changed.path), line: n });
        }
        for (const m of text.matchAll(TRANSITION_CALL_RE)) {
          out.push({ from: (m[1] ?? "").toUpperCase(), to: (m[2] ?? "").toUpperCase(), file: toPosixPath(changed.path), line: n });
        }
      }
    }
  }
  return out;
}

export function auditStateTransitions(
  declaredTransitions: string[],
  diff: DiffSummary,
): { findings: RawFinding[]; rows: unknown[] } {
  const declared = new Set(declaredTransitions.map((t) => t.toUpperCase().replace(/\s+/g, "")));
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  for (const edge of discoverEdges(diff)) {
    const key = `${edge.from}->${edge.to}`;
    if (declared.has(key)) continue;
    const findingKey = `${edge.file}:${edge.line}:${key}`;
    if (seen.has(findingKey)) continue;
    seen.add(findingKey);
    findings.push({
      id: `state-transition:undeclared:${slugify(edge.file)}:${slugify(key)}`,
      rule: "state-transition:undeclared",
      severity: "High",
      file: edge.file,
      line: edge.line,
      message: `Undeclared state transition ${edge.from}->${edge.to} at ${edge.file}:${edge.line} is not in the PRD-declared transition set [${[...declared].join(", ")}].`,
    });
  }
  return { findings, rows: [] };
}
