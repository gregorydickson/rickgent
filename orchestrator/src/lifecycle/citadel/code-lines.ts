// Shared helper: read each non-deleted changed code file and slice its
// changed-line ranges into addressable {no, text} pairs. Per-file try/catch
// (skip) keeps one unreadable working-tree file from losing the rest — the
// unreadable file is recorded by the runner's unreadable-file tracker.

import { readFileSync } from "fs";
import { join } from "path";
import type { DiffSummary } from "./diff-walker.js";

export interface ChangedSourceLine {
  no: number;
  text: string;
}

export interface ChangedSource {
  file: string;
  lines: ChangedSourceLine[];
}

const CODE_FILE_RE = /\.[cm]?[jt]sx?$/i;

export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  );
}

export function stripStringLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

export function collectChangedCodeLines(
  diff: DiffSummary,
  onUnreadable?: (path: string, error: string) => void,
): ChangedSource[] {
  const sources: ChangedSource[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.status === "D" || !CODE_FILE_RE.test(changed.path)) continue;
    let content: string;
    try {
      content = readFileSync(join(diff.repoRoot, changed.path), "utf-8");
    } catch (err) {
      onUnreadable?.(changed.path, err instanceof Error ? err.message : String(err));
      continue;
    }
    const fileLines = content.split(/\r?\n/);
    const lines: ChangedSourceLine[] = [];
    for (const range of changed.changedLines) {
      for (let lineNo = range.start; lineNo <= range.end; lineNo++) {
        const text = fileLines[lineNo - 1];
        if (text !== undefined) lines.push({ no: lineNo, text });
      }
    }
    if (lines.length > 0) sources.push({ file: changed.path, lines });
  }
  return sources;
}
