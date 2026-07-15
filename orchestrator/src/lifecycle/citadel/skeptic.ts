// Skeptic lens — a report-only analyzer that scans changed lines for suspicious
// patterns (identity comparison with literals, optional chains without
// fallback, resource construction without lifecycle, dead guards, no-op
// assignments, cross-file function repetition). Its findings are NEVER ingested
// into the blocking findings set; they live in `skeptic_findings` and never
// contribute to the exit code, even under --strict.

import { readFileSync } from "fs";
import { join } from "path";
import type { DiffSummary, ChangedFile } from "./diff-walker.js";
import { slugify, toPosixPath } from "./reporter.js";
import type { RawFinding } from "./reporter.js";

const SEMANTIC_IDENTITY_RE = /===\s*[[{]|[[{]\s*===/;
const OPTIONAL_CHAIN_RE = /\?\.\w/;
const NULL_COALESCE_RE = /\?\?/;
const RESOURCE_CTOR_RE = /\bnew\s+\w*(?:ReadStream|WriteStream|Client|Connection|Socket|Handle)\b/;
const DEAD_GUARD_RE = /\bif\s*\(\s*(?:false|true)\s*\)/;
const NOOP_ASSIGN_RE = /\b(\w+)\s*=\s*\1\s*[;,]/;
const FN_DECL_RE = /\bfunction\s+(\w{5,})\s*\(/;

const LINE_DETECTORS: ReadonlyArray<{ defect: string; match: (line: string) => boolean }> = [
  { defect: "semantic-identity", match: (l) => SEMANTIC_IDENTITY_RE.test(l) },
  { defect: "fallback-null-flow", match: (l) => OPTIONAL_CHAIN_RE.test(l) && !NULL_COALESCE_RE.test(l) },
  { defect: "resource-lifecycle", match: (l) => RESOURCE_CTOR_RE.test(l) },
  { defect: "dead-guard", match: (l) => DEAD_GUARD_RE.test(l) || NOOP_ASSIGN_RE.test(l) },
];

function readLines(repoRoot: string, file: ChangedFile): string[] | null {
  try {
    return readFileSync(join(repoRoot, file.path), "utf-8").split(/\r?\n/);
  } catch {
    return null;
  }
}

export function runSkepticLens(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  const fnsByName = new Map<string, string[]>();

  for (const file of diff.changedFiles) {
    const lines = readLines(diff.repoRoot, file);
    if (!lines) continue;
    for (const range of file.changedLines) {
      for (let ln = range.start; ln <= range.end; ln++) {
        const line = lines[ln - 1] ?? "";
        for (const d of LINE_DETECTORS) {
          if (d.match(line)) {
            findings.push({
              id: `skeptic:${d.defect}:${slugify(toPosixPath(file.path))}:${ln}`,
              rule: `skeptic:${d.defect}`,
              severity: "Low",
              file: toPosixPath(file.path),
              line: ln,
              message: `Skeptic lens: ${d.defect} at ${file.path}:${ln}.`,
            });
          }
        }
        const fnMatch = FN_DECL_RE.exec(line);
        if (fnMatch) {
          const name = fnMatch[1] ?? "";
          const files = fnsByName.get(name) ?? [];
          if (!files.includes(file.path)) {
            files.push(file.path);
            fnsByName.set(name, files);
          }
        }
      }
    }
  }

  for (const [name, files] of fnsByName) {
    if (files.length >= 2) {
      findings.push({
        id: `skeptic:cross-file-repetition:${slugify(name)}`,
        rule: "skeptic:cross-file-repetition",
        severity: "Low",
        file: files[0] ?? "",
        message: `Function '${name}' defined in ${files.length} changed files — potential duplication.`,
      });
    }
  }

  return { findings };
}
