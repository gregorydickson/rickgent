// Trap-door coverage audit — reads `## Trap Doors` sections from CLAUDE.md
// files, extracts each trap door (file + INVARIANT/BREAKS/ENFORCE), and checks
// whether changed files that touch a trap door carry the documented guard.
//
// An unguarded trap door = a trap-door file present in the diff whose ENFORCE
// guard (test file) is neither present in the diff nor present on disk. A
// violated trap door = a changed line in a trap-door file matching the BREAKS
// pattern. Both emit findings; --print-stubs emits test skeletons for the
// unguarded set.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { DiffSummary } from "./diff-walker.js";
import { slugify, toPosixPath } from "./reporter.js";
import type { RawFinding } from "./reporter.js";

export interface TrapDoor {
  file: string;
  invariant: string;
  breaks?: string;
  enforce?: string;
  claudeFile: string;
  line: number;
}

const TRAP_DOOR_SECTION_RE = /^##\s+Trap Doors\b/im;
const TRAP_DOOR_LINE_RE =
  /^[-*]\s*[`"]?([^`"|—–-]+?)[`"]?\s*[—–-]\s*INVARIANT:\s*(.+?)(?:\s*BREAKS:\s*(.+?))?(?:\s*ENFORCE:\s*(.+?))?$/i;

export function extractTrapDoors(claudeContent: string, claudeFile: string): TrapDoor[] {
  const lines = claudeContent.split(/\r?\n/);
  let inSection = false;
  const out: TrapDoor[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) {
      inSection = TRAP_DOOR_SECTION_RE.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(TRAP_DOOR_LINE_RE);
    if (!m) continue;
    const breaks = m[3]?.trim().replace(/^[`"]|[`"]$/g, "") || undefined;
    const enforce = m[4]?.trim().replace(/^[`"]|[`"]$/g, "") || undefined;
    const td: TrapDoor = {
      file: (m[1] ?? "").trim(),
      invariant: (m[2] ?? "").trim(),
      claudeFile,
      line: i + 1,
    };
    if (breaks) td.breaks = breaks;
    if (enforce) td.enforce = enforce;
    out.push(td);
  }
  return out;
}

function collectAllTrapDoors(diff: DiffSummary): TrapDoor[] {
  const claudePaths = [...diff.claudeFiles];
  if (!claudePaths.includes("CLAUDE.md") && existsSync(join(diff.repoRoot, "CLAUDE.md"))) {
    claudePaths.push("CLAUDE.md");
  }
  const all: TrapDoor[] = [];
  for (const rel of claudePaths) {
    const abs = join(diff.repoRoot, rel);
    if (!existsSync(abs)) continue;
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    all.push(...extractTrapDoors(content, rel));
  }
  return all;
}

function changedFilesSet(diff: DiffSummary): Set<string> {
  return new Set(diff.changedFiles.map((f) => toPosixPath(f.path)));
}

function enforcePresentInDiff(td: TrapDoor, diff: DiffSummary): boolean {
  if (!td.enforce) return false;
  const set = changedFilesSet(diff);
  return set.has(toPosixPath(td.enforce));
}

function enforcePresentOnDisk(td: TrapDoor, diff: DiffSummary): boolean {
  if (!td.enforce) return false;
  return existsSync(join(diff.repoRoot, toPosixPath(td.enforce)));
}

function changedLineTexts(diff: DiffSummary, file: string): string[] {
  const changed = diff.changedFiles.find((f) => toPosixPath(f.path) === file);
  if (!changed) return [];
  try {
    const content = readFileSync(join(diff.repoRoot, file), "utf-8");
    const lines = content.split(/\r?\n/);
    const out: string[] = [];
    for (const range of changed.changedLines) {
      for (let n = range.start; n <= range.end; n++) {
        const t = lines[n - 1];
        if (t !== undefined) out.push(t);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface TrapDoorResult {
  findings: RawFinding[];
  trapDoors: TrapDoor[];
  unguarded: TrapDoor[];
}

export function auditTrapDoorCoverage(diff: DiffSummary): TrapDoorResult {
  const trapDoors = collectAllTrapDoors(diff);
  const changed = changedFilesSet(diff);
  const findings: RawFinding[] = [];
  const unguarded: TrapDoor[] = [];

  for (const td of trapDoors) {
    const tdFile = toPosixPath(td.file);
    if (!changed.has(tdFile)) continue;

    // Violation: a changed line matches the BREAKS pattern.
    if (td.breaks) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(td.breaks);
      } catch {
        pattern = new RegExp(td.breaks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
      for (const text of changedLineTexts(diff, tdFile)) {
        if (pattern.test(text)) {
          findings.push({
            id: `trap-door:violation:${slugify(tdFile)}`,
            rule: "trap-door:violation",
            severity: "Critical",
            file: tdFile,
            message: `Trap-door invariant "${td.invariant}" violated in ${tdFile} (BREAKS pattern matched). Documented in ${td.claudeFile}:${td.line}.`,
          });
          break;
        }
      }
    }

    // Unguarded: the trap-door file is touched but its ENFORCE guard is absent
    // from both the diff and disk.
    const guarded = enforcePresentInDiff(td, diff) || enforcePresentOnDisk(td, diff);
    if (!guarded) {
      unguarded.push(td);
      findings.push({
        id: `unguarded-trap-door:${slugify(tdFile)}`,
        rule: "unguarded-trap-door",
        severity: "High",
        file: tdFile,
        message: `Trap-door file ${tdFile} is touched in the diff but its ENFORCE guard "${td.enforce ?? "(none)"}" is absent. INVARIANT: ${td.invariant}`,
      });
    }
  }

  return { findings, trapDoors, unguarded };
}

export function renderTestStubs(unguarded: TrapDoor[]): string {
  if (unguarded.length === 0) return "";
  const lines: string[] = ["# Citadel — test skeletons for unguarded trap doors", ""];
  for (const td of unguarded) {
    lines.push(`describe("${td.file} trap door", () => {`);
    lines.push(`  it("enforces invariant: ${td.invariant.replace(/"/g, '\\"')}", () => {`);
    lines.push(`    // INVARIANT: ${td.invariant}`);
    if (td.breaks) lines.push(`    // BREAKS: ${td.breaks}`);
    lines.push(`    // ENFORCE: ${td.enforce ?? "(add a guard/test)"}`);
    lines.push(`    // TODO: assert the invariant holds for ${td.file}`);
    lines.push(`    expect(true).toBe(true);`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push("");
  }
  return lines.join("\n");
}
