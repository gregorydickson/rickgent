// Diff walker — walks `git diff <base>..<head>` into a per-file change set with
// status, kind (production/test), and changed line ranges.
//
// The top-level name-status call fails CLOSED (throws) on an invalid range so
// the audit can report a clear error and exit non-zero. Per-file line-range and
// blame calls fail SOFT (a single un-diffable path must not crash the walk).

import { execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import { TEST_FILE_PATTERN, toPosixPath } from "./reporter.js";

export type ChangedFileKind = "production" | "test";

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  kind: ChangedFileKind;
  changedLines: ChangedLineRange[];
}

export interface DiffSummary {
  range: string;
  repoRoot: string;
  changedFiles: ChangedFile[];
  claudeFiles: string[];
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

function git(args: string[], repoRoot: string, check: boolean): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (check) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args.join(" ")} failed: ${detail}`);
    }
    return "";
  }
}

export function walkDiff(range: string, repoRoot: string): DiffSummary {
  const trimmed = range.trim();
  if (!trimmed) throw new Error("diff range must not be empty");

  // Fail closed: an unresolvable range (bad ref) exits git non-zero and throws.
  const nameStatus = git(["diff", "--name-status", trimmed], repoRoot, true);
  const changedFiles = parseNameStatus(nameStatus).map((entry) => ({
    path: entry.path,
    status: entry.status,
    kind: classifyFile(entry.path),
    changedLines: entry.status === "D" ? [] : changedLineRanges(entry.path, trimmed, repoRoot),
  }));
  changedFiles.sort((a, b) => a.path.localeCompare(b.path));

  return {
    range: trimmed,
    repoRoot,
    changedFiles,
    claudeFiles: findClaudeFiles(repoRoot),
  };
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const entries: Array<{ status: string; path: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const status = rawStatus.charAt(0).toUpperCase();
    // Renames/copies carry old + new; the new path is the last field.
    const path = parts[parts.length - 1];
    if (!path) continue;
    entries.push({ status, path: toPosixPath(path) });
  }
  return entries;
}

function classifyFile(path: string): ChangedFileKind {
  return TEST_FILE_PATTERN.test(toPosixPath(path)) ? "test" : "production";
}

function changedLineRanges(path: string, range: string, repoRoot: string): ChangedLineRange[] {
  const out = git(["diff", "--unified=0", range, "--", path], repoRoot, false);
  const ranges: ChangedLineRange[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const cnt = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start) || cnt <= 0) continue;
    ranges.push({ start, end: start + cnt - 1 });
  }
  return ranges;
}

function findClaudeFiles(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === "CLAUDE.md") {
        found.push(toPosixPath(relative(repoRoot, full)));
      } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        walk(full, depth + 1);
      }
    }
  };
  if (existsSync(repoRoot)) walk(repoRoot, 0);
  return [...new Set(found)].sort();
}
