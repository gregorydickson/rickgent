// Banned constructs + banned casts scanner. Flags forbidden patterns in
// changed code lines: nested ternaries, brace-free ifs, `as any`, `as never`,
// `(x as Error).`, `eval(`, `Function(`, `new Function(`.

import type { RawFinding } from "./reporter.js";
import { slugify } from "./reporter.js";
import type { ChangedSource } from "./code-lines.js";
import {
  collectChangedCodeLines,
  isCommentLine,
  stripStringLiterals,
} from "./code-lines.js";
import type { DiffSummary } from "./diff-walker.js";

const AS_ERROR_RE = /\(\s*[\w$.[\]]+\s+as\s+Error\s*\)\s*\./;
const AS_ANY_RE = /\bas\s+any\b/;
const AS_NEVER_RE = /\bas\s+never\b/;
const EVAL_RE = /\beval\s*\(/;
const FUNCTION_CTOR_RE = /\bnew\s+Function\s*\(|\bFunction\s*\(/;

function isNestedTernary(line: string): boolean {
  const cleaned = stripStringLiterals(line)
    .replace(/\?\./g, "")
    .replace(/\?\?/g, "")
    .replace(/\?:/g, ":");
  const q = (cleaned.match(/\?/g) ?? []).length;
  const colons = (cleaned.match(/:/g) ?? []).length;
  return q >= 2 && colons >= 2;
}

function isBraceFreeIf(line: string): boolean {
  const stripped = stripStringLiterals(line);
  const match = /\bif\s*\(/.exec(stripped);
  if (!match) return false;
  let depth = 0;
  let i = match.index + match[0].length - 1;
  for (; i < stripped.length; i++) {
    if (stripped[i] === "(") depth++;
    else if (stripped[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return false;
  const rest = stripped.slice(i + 1).trim();
  if (rest.length === 0) return false;
  if (rest.startsWith("{")) return false;
  if (rest.startsWith("//") || rest.startsWith("/*")) return false;
  return true;
}

export function findBannedConstructs(sources: ChangedSource[]): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const source of sources) {
    for (const { no, text } of source.lines) {
      if (isCommentLine(text)) continue;
      if (isNestedTernary(text)) {
        findings.push({
          id: `banned-construct:nested-ternary:${slugify(source.file)}:${no}`,
          rule: "banned-construct:nested-ternary",
          severity: "Medium",
          file: source.file,
          line: no,
          message: `Nested/chained ternary at ${source.file}:${no} is banned by CLAUDE.md; extract to if/else or named intermediates.`,
        });
      }
      if (isBraceFreeIf(text)) {
        findings.push({
          id: `banned-construct:brace-free-if:${slugify(source.file)}:${no}`,
          rule: "banned-construct:brace-free-if",
          severity: "Medium",
          file: source.file,
          line: no,
          message: `Brace-free if at ${source.file}:${no} is banned by CLAUDE.md; wrap the body in a block.`,
        });
      }
    }
  }
  return findings;
}

export function findBannedCasts(sources: ChangedSource[]): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const source of sources) {
    for (const { no, text } of source.lines) {
      if (isCommentLine(text)) continue;
      if (AS_ANY_RE.test(stripStringLiterals(text))) {
        findings.push({
          id: `banned-cast:as-any:${slugify(source.file)}:${no}`,
          rule: "banned-cast:as-any",
          severity: "Medium",
          file: source.file,
          line: no,
          message: `\`as any\` cast at ${source.file}:${no} is banned by CLAUDE.md.`,
        });
      }
      if (AS_NEVER_RE.test(stripStringLiterals(text))) {
        findings.push({
          id: `banned-cast:as-never:${slugify(source.file)}:${no}`,
          rule: "banned-cast:as-never",
          severity: "Medium",
          file: source.file,
          line: no,
          message: `\`as never\` cast at ${source.file}:${no} is banned.`,
        });
      }
      if (AS_ERROR_RE.test(stripStringLiterals(text))) {
        findings.push({
          id: `banned-cast:as-error:${slugify(source.file)}:${no}`,
          rule: "banned-cast:as-error",
          severity: "Medium",
          file: source.file,
          line: no,
          message: `Unsafe \`(x as Error).\` cast at ${source.file}:${no} is banned.`,
        });
      }
      if (EVAL_RE.test(stripStringLiterals(text))) {
        findings.push({
          id: `banned-construct:eval:${slugify(source.file)}:${no}`,
          rule: "banned-construct:eval",
          severity: "High",
          file: source.file,
          line: no,
          message: `\`eval(\` at ${source.file}:${no} is banned by CLAUDE.md.`,
        });
      }
      if (FUNCTION_CTOR_RE.test(stripStringLiterals(text))) {
        findings.push({
          id: `banned-construct:function-ctor:${slugify(source.file)}:${no}`,
          rule: "banned-construct:function-ctor",
          severity: "High",
          file: source.file,
          line: no,
          message: `\`Function(\` constructor at ${source.file}:${no} is banned by CLAUDE.md.`,
        });
      }
    }
  }
  return findings;
}

export function auditBannedConstructs(
  diff: DiffSummary,
  onUnreadable?: (p: string, e: string) => void,
): { findings: RawFinding[] } {
  return { findings: findBannedConstructs(collectChangedCodeLines(diff, onUnreadable)) };
}

export function auditBannedCasts(
  diff: DiffSummary,
  onUnreadable?: (p: string, e: string) => void,
): { findings: RawFinding[] } {
  return { findings: findBannedCasts(collectChangedCodeLines(diff, onUnreadable)) };
}
