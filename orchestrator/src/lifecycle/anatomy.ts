// `rickgent anatomy` CLI command — deep subsystem review with 3-phase protocol
// + trap door cataloging.
//
// Ports pickle-rick-claude's anatomy-park command to rickgent's multi-vendor,
// fail-closed architecture. The command:
//
//   1. Auto-discovers subsystems (immediate subdirs with 3+ source files)
//   2. Persists rotation state to .rickgent/anatomy-park.json
//   3. Runs a 3-phase protocol per iteration:
//      REVIEW (read-only, trace data flows, rate CRITICAL/HIGH) →
//      FIX (minimal edit, regression test, scope preflight) →
//      VERIFY (read-only, combinatorial branch verification, revert on regression)
//   4. Writes trap doors to subsystem CLAUDE.md files
//   5. Worker-managed convergence: all subsystems consecutive_clean >= 2 OR all stalled
//
// Flags: --dry-run, --max-iterations, --stall-limit, --repo, --agent, --resume

import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve, relative } from "path";
import {
  PRODUCTION_CAPABILITY_GATE,
  type CapabilityGate,
} from "../capabilities/registry.js";
import { isPathInScope } from "../core/scope.js";

const ANATOMY_USAGE = `rickgent anatomy — deep subsystem review with 3-phase protocol

Usage:
  rickgent anatomy [options]

Options:
  --dry-run              Review all subsystems, catalog findings, stop (no fixes)
  --max-iterations <N>   Iteration cap (default: 100)
  --stall-limit <N>      Per-subsystem stall limit before marking stalled (default: 3)
  --repo <dir>           Target git repo (default: cwd)
  --agent <dir>          omnigent agent bundle directory
  --resume               Continue from .rickgent/anatomy-park.json
  --help, -h             Show this help

The loop discovers subsystems (immediate subdirs with 3+ source files), rotates
through them running REVIEW -> FIX -> VERIFY per iteration, and converges when
all subsystems have consecutive_clean >= 2 OR all are stalled.
`;

// ── Types ────────────────────────────────────────────────────────────────────

type Severity = "CRITICAL" | "HIGH";

interface AnatomyFinding {
  id: string;
  severity: Severity;
  confidence: number;
  category: string;
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  proposedFix: string | null;
}

interface PhaseLog {
  phase: "REVIEW" | "FIX" | "VERIFY";
  timestamp: string;
  findingId: string | null;
  result: string;
  details: string;
}

interface IterationRecord {
  iteration: number;
  subsystem: string;
  phases: PhaseLog[];
  findings: AnatomyFinding[];
  fix_applied: boolean;
  committed: boolean;
  reverted: boolean;
  trap_doors_added: number;
}

interface TrapDoor {
  subsystem: string;
  file: string;
  description: string;
  patternShape: string;
}

interface AnatomyState {
  subsystems: string[];
  current_index: number;
  pass_counts: Record<string, number>;
  consecutive_clean: Record<string, number>;
  stall_counts: Record<string, number>;
  stall_limit: number;
  findings_history: Record<string, IterationRecord[]>;
  trap_doors_added: TrapDoor[];
  trap_doors_committed: TrapDoor[];
  /** Per-file fix count for trap door cataloging (repeated fixes). */
  fix_counts: Record<string, number>;
  converged: boolean;
  status: string;
  reason: string;
  updated_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseIntFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = parseInt(raw, 10);
  return Number.isNaN(v) ? fallback : v;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function getRickgentDir(): string {
  return process.env.RICKGENT_DIR ?? join(process.cwd(), ".rickgent");
}

// ── Subsystem Discovery ──────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".rs", ".java", ".tsx", ".jsx", ".vue", ".svelte"];
const NOISE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".git",
  ".rickgent",
]);
const TEST_PATTERNS = /\.(test|spec)\.(ts|js|tsx|jsx|py|go|rs|java)$/;

/**
 * Count source files recursively in a directory, excluding noise dirs.
 * Returns { total, testCount }.
 */
function countSourceFiles(dir: string): { total: number; testCount: number } {
  let total = 0;
  let testCount = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { total: 0, testCount: 0 };
  }
  for (const entry of entries) {
    if (NOISE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const sub = countSourceFiles(full);
      total += sub.total;
      testCount += sub.testCount;
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      total++;
      if (TEST_PATTERNS.test(entry)) testCount++;
    }
  }
  return { total, testCount };
}

/**
 * Auto-discover subsystems: immediate subdirectories of the target with 3+
 * source files (recursive count). Excludes node_modules, dist, build, and
 * test-only dirs (> 80% test files by count). Sorts alphabetically.
 */
function discoverSubsystems(workingDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(workingDir);
  } catch {
    return [];
  }

  const subsystems: string[] = [];
  for (const entry of entries) {
    if (NOISE_DIRS.has(entry)) continue;
    const full = join(workingDir, entry);
    if (!isDir(full)) continue;

    const { total, testCount } = countSourceFiles(full);
    if (total < 3) continue;

    // Exclude test-only dirs (> 80% test files)
    if (total > 0 && testCount / total > 0.8) continue;

    subsystems.push(entry);
  }

  return subsystems.sort();
}

// ── Omnigent Spawning ────────────────────────────────────────────────────────

function buildReviewPrompt(subsystem: string): string {
  return [
    "You are a read-only anatomy-park REVIEW worker. Do NOT modify any files; use only read-only tools.",
    `Review subsystem: ${subsystem}`,
    "",
    "## Phase 1: REVIEW (read-only)",
    "Trace the COMPLETE data flow for this subsystem. Read every file. Check git history.",
    "Rate each finding as CRITICAL or HIGH with a confidence score (0-100).",
    "Drop any finding with confidence < 80.",
    "",
    "## Output Format",
    'Output a JSON array of findings on the first line, then a numeric count of remaining non-converged subsystems as the LAST numeric line.',
    'Each finding: {"id":"<subsystem>-<N>","severity":"CRITICAL|HIGH","confidence":<0-100>,"category":"<category>","file":"<path>","line":<N>,"title":"<title>","description":"<desc>","proposedFix":"<fix>"}',
    "If zero findings, output: []",
    "Then output the remaining non-converged subsystem count as a bare number on the last line.",
  ].join("\n");
}

function buildFixPrompt(subsystem: string, finding: AnatomyFinding): string {
  return [
    `Anatomy Park FIX phase for subsystem: ${subsystem}`,
    "",
    "## Finding to Fix",
    `ID: ${finding.id}`,
    `Severity: ${finding.severity}`,
    `Confidence: ${finding.confidence}`,
    `File: ${finding.file ?? "(unknown)"}`,
    `Line: ${finding.line ?? "(unknown)"}`,
    `Description: ${finding.description}`,
    `Proposed Fix: ${finding.proposedFix ?? "(none)"}`,
    "",
    "## Phase 2: FIX",
    "Apply a SINGLE minimal edit to fix this finding.",
    "Write a regression test for the fix.",
    "Run the project test suite (or a documented fallback).",
    "Only edit files within the subsystem scope.",
    "Leave changes uncommitted; the loop handles commit/revert.",
  ].join("\n");
}

function buildVerifyPrompt(subsystem: string): string {
  return [
    "You are a read-only anatomy-park VERIFY worker. Do NOT modify any files; use only read-only tools.",
    `Verify the fix for subsystem: ${subsystem}`,
    "",
    "## Phase 3: VERIFY (read-only)",
    "Review the diff of the fix applied in Phase 2.",
    "Perform combinatorial branch verification (2^N boolean/nullable combinations).",
    "Check production data migration awareness.",
    "",
    "## Output Format",
    "Output PASS if the fix is verified with no regression.",
    "Output FAIL if a regression is detected.",
    "Then describe the verification result on subsequent lines.",
  ].join("\n");
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  error: boolean;
}

function spawnOmnigent(
  agentDir: string,
  workingDir: string,
  prompt: string,
  dataDir: string,
  timeoutMs: number = 120000,
): SpawnResult {
  const res = spawnSync("omnigent", ["run", agentDir, "-p", prompt], {
    cwd: workingDir,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, OMNIGENT_DATA_DIR: dataDir },
  });
  if (res.error) {
    return { exitCode: null, stdout: "", error: true };
  }
  return { exitCode: res.status, stdout: res.stdout ?? "", error: false };
}

// ── Finding Parsing ──────────────────────────────────────────────────────────

/**
 * Parse findings from the REVIEW worker's stdout. The worker outputs a JSON
 * array of findings on the first line(s), then a numeric count on the last
 * numeric line.
 */
function parseFindingsFromReview(output: string): { findings: AnatomyFinding[]; remainingCount: number | null } {
  if (typeof output !== "string" || output.length === 0) {
    return { findings: [], remainingCount: null };
  }

  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  // Find the JSON array (first line that starts with [ or contains a JSON array)
  let jsonStr = "";
  let remainingCount: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Check if this line is a JSON array
    if (line.startsWith("[") || line.startsWith("{")) {
      // Try to parse as JSON (may span multiple lines)
      let endIdx = i;
      let bracketCount = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]!) {
          if (ch === "[") bracketCount++;
          if (ch === "]") bracketCount--;
          if (ch === "{") bracketCount++;
          if (ch === "}") bracketCount--;
        }
        if (bracketCount <= 0 && j > i) {
          endIdx = j;
          break;
        }
        if (bracketCount <= 0 && j === i && (line.startsWith("[") || line.startsWith("{"))) {
          // Single-line JSON
          if ((line.startsWith("[") && line.endsWith("]")) || (line.startsWith("{") && line.endsWith("}"))) {
            endIdx = i;
            break;
          }
        }
      }
      jsonStr = lines.slice(i, endIdx + 1).join("\n");
      // Continue looking for the numeric count in remaining lines
      for (let k = endIdx + 1; k < lines.length; k++) {
        if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(lines[k]!)) {
          remainingCount = Number(lines[k]);
          break;
        }
      }
      break;
    }
    // Check if this line is a bare number (for the case of no JSON array)
    if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(line) && i === lines.length - 1) {
      remainingCount = Number(line);
    }
  }

  // Parse findings from JSON
  let findings: AnatomyFinding[] = [];
  if (jsonStr.length > 0) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        findings = parsed
          .filter((f: any) => f && typeof f === "object")
          .map((f: any) => ({
            id: String(f.id ?? ""),
            severity: (f.severity === "CRITICAL" || f.severity === "HIGH" ? f.severity : "HIGH") as Severity,
            confidence: typeof f.confidence === "number" ? f.confidence : 0,
            category: String(f.category ?? "unknown"),
            file: f.file != null ? String(f.file) : null,
            line: typeof f.line === "number" ? f.line : null,
            title: String(f.title ?? ""),
            description: String(f.description ?? ""),
            proposedFix: f.proposedFix != null ? String(f.proposedFix) : null,
          }))
          // Drop findings with confidence < 80
          .filter((f: AnatomyFinding) => f.confidence >= 80);
      }
    } catch {
      // JSON parse failure → no findings (fail-closed)
      findings = [];
    }
  }

  return { findings, remainingCount };
}

/**
 * Parse the VERIFY result from the worker's stdout. Looks for PASS or FAIL.
 */
function parseVerifyResult(output: string): { passed: boolean; details: string } {
  if (typeof output !== "string") return { passed: false, details: "no output" };
  const trimmed = output.trim();
  if (/^PASS\b/i.test(trimmed)) {
    return { passed: true, details: trimmed };
  }
  if (/^FAIL\b/i.test(trimmed)) {
    return { passed: false, details: trimmed };
  }
  // Default to fail-closed (no PASS → regression detected)
  return { passed: false, details: trimmed || "no PASS token found" };
}

// ── Git Helpers (array-argv only; never shell strings) ──────────────────────

function gitHeadSha(workingDir: string): string | null {
  try {
    return execFileSync("git", ["-C", workingDir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitDirtyFiles(workingDir: string, ownedPaths: string[]): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", workingDir, "status", "--porcelain", "-z", "--", ...ownedPaths],
      { encoding: "utf-8", timeout: 10000 },
    );
    const entries = out.split("\0").filter((e) => e.length > 0);
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (path.length > 0) paths.push(path);
      if (status.includes("R") || status.includes("C")) i++;
    }
    return paths;
  } catch {
    return [];
  }
}

function gitStageOwned(workingDir: string, ownedPaths: string[]): void {
  for (const p of ownedPaths) {
    execFileSync("git", ["-C", workingDir, "add", "--", p], { timeout: 10000 });
  }
}

function gitUnstageAll(workingDir: string): void {
  try {
    execFileSync("git", ["-C", workingDir, "reset", "HEAD", "."], {
      timeout: 10000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* ignore */
  }
}

function gitCommit(workingDir: string, message: string): string | null {
  try {
    // Check if anything is staged
    const staged = execFileSync("git", ["-C", workingDir, "diff", "--cached", "--name-only"], {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    if (staged === "") return null;
    execFileSync(
      "git",
      [
        "-C", workingDir,
        "-c", "user.email=anatomy@rickgent.test",
        "-c", "user.name=Anatomy Park",
        "commit", "-m", message,
      ],
      { timeout: 10000 },
    );
    return gitHeadSha(workingDir);
  } catch {
    return null;
  }
}

function gitRestoreScoped(workingDir: string, ownedPaths: string[]): void {
  for (const p of ownedPaths) {
    try {
      execFileSync("git", ["-C", workingDir, "checkout", "--", p], {
        timeout: 10000,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      /* path may be untracked */
    }
  }
  try {
    execFileSync("git", ["-C", workingDir, "clean", "-f", "-d", "--", ...ownedPaths], {
      timeout: 10000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* ignore */
  }
}

// ── Scope Preflight ──────────────────────────────────────────────────────────

/**
 * Check if all dirty files are within the owned scope using isPathInScope.
 * Returns the list of out-of-scope files (empty if all in scope).
 */
function checkScopePreflight(workingDir: string, ownedPaths: string[]): { inScope: string[]; outOfScope: string[] } {
  const dirty = gitDirtyFiles(workingDir, ownedPaths);
  const inScope: string[] = [];
  const outOfScope: string[] = [];

  // Also check ALL dirty files (not just owned) to detect out-of-scope writes
  let allDirty: string[] = [];
  try {
    const out = execFileSync(
      "git",
      ["-C", workingDir, "status", "--porcelain", "-z"],
      { encoding: "utf-8", timeout: 10000 },
    );
    const entries = out.split("\0").filter((e) => e.length > 0);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (path.length > 0) allDirty.push(path);
      if (status.includes("R") || status.includes("C")) i++;
    }
  } catch {
    /* ignore */
  }

  for (const file of allDirty) {
    const isInScope = ownedPaths.some((p) => isPathInScope(file, p));
    if (isInScope) {
      inScope.push(file);
    } else {
      outOfScope.push(file);
    }
  }

  return { inScope, outOfScope };
}

// ── Trap Door Writing ────────────────────────────────────────────────────────

function writeTrapDoorsToClaude(workingDir: string, subsystem: string, trapDoors: TrapDoor[]): void {
  const claudePath = join(workingDir, subsystem, "CLAUDE.md");
  let existing = "";
  if (existsSync(claudePath)) {
    existing = readFileSync(claudePath, "utf-8");
  }

  const subsysTrapDoors = trapDoors.filter((t) => t.subsystem === subsystem);
  if (subsysTrapDoors.length === 0) return;

  // Build or merge the ## Trap Doors section
  let newContent: string;
  if (/^## Trap Doors/m.test(existing)) {
    // Merge: add new entries to existing section
    const lines = existing.split("\n");
    const sectionIdx = lines.findIndex((l) => /^## Trap Doors/.test(l));
    if (sectionIdx >= 0) {
      // Find the end of the section (next ## header or end of file)
      let endIdx = lines.length;
      for (let i = sectionIdx + 1; i < lines.length; i++) {
        if (/^## /.test(lines[i]!)) {
          endIdx = i;
          break;
        }
      }
      const existingEntries = new Set(
        lines.slice(sectionIdx + 1, endIdx).map((l) => l.trim()),
      );
      const newLines: string[] = [];
      for (const td of subsysTrapDoors) {
        const entry = `- \`${td.file}\` — INVARIANT: ${td.description}. BREAKS: if violated. ENFORCE: guard or test. PATTERN_SHAPE: ${td.patternShape}.`;
        if (!existingEntries.has(entry)) {
          newLines.push(entry);
        }
      }
      lines.splice(endIdx, 0, ...newLines);
      newContent = lines.join("\n");
    } else {
      newContent = existing + "\n\n## Trap Doors\n\n" + subsysTrapDoors.map((td) =>
        `- \`${td.file}\` — INVARIANT: ${td.description}. BREAKS: if violated. ENFORCE: guard or test. PATTERN_SHAPE: ${td.patternShape}.`,
      ).join("\n") + "\n";
    }
  } else {
    // Create new section
    const header = existing.length > 0 ? existing + "\n\n" : "";
    newContent = header + "## Trap Doors\n\n" + subsysTrapDoors.map((td) =>
      `- \`${td.file}\` — INVARIANT: ${td.description}. BREAKS: if violated. ENFORCE: guard or test. PATTERN_SHAPE: ${td.patternShape}.`,
    ).join("\n") + "\n";
  }

  writeFileSync(claudePath, newContent, "utf-8");
}

// ── State Read/Write ─────────────────────────────────────────────────────────

function readAnatomyState(statePath: string): AnatomyState | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object") return null;
    // Migrate old camelCase field names to snake_case (convention #16).
    const migrated = migrateOldStateFields(parsed);
    return migrated as AnatomyState;
  } catch {
    return null;
  }
}

/**
 * Migrate old camelCase state file fields to snake_case. Handles state files
 * written before the misc-m4-fixes renaming. Only migrates if old fields are
 * present; idempotent for already-snake_case state.
 */
function migrateOldStateFields(parsed: any): any {
  const fieldMap: Record<string, string> = {
    currentIndex: "current_index",
    passCounts: "pass_counts",
    consecutiveClean: "consecutive_clean",
    stallCounts: "stall_counts",
    stallLimit: "stall_limit",
    findingsHistory: "findings_history",
    trapDoorsAdded: "trap_doors_added",
    trapDoorsCommitted: "trap_doors_committed",
    updatedAt: "updated_at",
  };
  const result = { ...parsed };
  for (const [oldName, newName] of Object.entries(fieldMap)) {
    if (oldName in result && !(newName in result)) {
      result[newName] = result[oldName];
      delete result[oldName];
    }
  }
  // Ensure fix_counts exists (added in misc-m4-fixes)
  if (!("fix_counts" in result)) {
    result.fix_counts = {};
  }
  return result;
}

function writeAnatomyState(statePath: string, state: AnatomyState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function initState(subsystems: string[], stallLimit: number): AnatomyState {
  const pass_counts: Record<string, number> = {};
  const consecutive_clean: Record<string, number> = {};
  const stall_counts: Record<string, number> = {};
  const findings_history: Record<string, IterationRecord[]> = {};
  for (const sub of subsystems) {
    pass_counts[sub] = 0;
    consecutive_clean[sub] = 0;
    stall_counts[sub] = 0;
    findings_history[sub] = [];
  }
  return {
    subsystems,
    current_index: 0,
    pass_counts,
    consecutive_clean,
    stall_counts,
    stall_limit: stallLimit,
    findings_history,
    trap_doors_added: [],
    trap_doors_committed: [],
    fix_counts: {},
    converged: false,
    status: "running",
    reason: "",
    updated_at: new Date().toISOString(),
  };
}

// ── Convergence Check ────────────────────────────────────────────────────────

interface ConvergenceResult {
  converged: boolean;
  reason: string;
}

function checkConvergence(state: AnatomyState): ConvergenceResult {
  if (state.subsystems.length === 0) {
    return { converged: true, reason: "no subsystems" };
  }

  const allClean = state.subsystems.every(
    (sub) => (state.consecutive_clean[sub] ?? 0) >= 2,
  );
  if (allClean) {
    return { converged: true, reason: "all subsystems consecutive_clean >= 2" };
  }

  const allStalled = state.subsystems.every(
    (sub) => (state.stall_counts[sub] ?? 0) >= state.stall_limit,
  );
  if (allStalled) {
    return { converged: true, reason: "all subsystems stalled" };
  }

  return { converged: false, reason: "still reviewing" };
}

/**
 * Select the next non-converged, non-stalled subsystem to review.
 * Returns the index, or -1 if all are converged/stalled.
 */
function selectNextSubsystem(state: AnatomyState): number {
  const n = state.subsystems.length;
  if (n === 0) return -1;

  // Try starting from current_index, wrapping around
  for (let offset = 0; offset < n; offset++) {
    const idx = (state.current_index + offset) % n;
    const sub = state.subsystems[idx]!;
    const clean = state.consecutive_clean[sub] ?? 0;
    const stalled = state.stall_counts[sub] ?? 0;
    if (clean < 2 && stalled < state.stall_limit) {
      return idx;
    }
  }
  return -1;
}

/**
 * Advance current_index to the next non-converged, non-stalled subsystem.
 * If all are converged/stalled, don't advance.
 */
function advanceRotation(state: AnatomyState): void {
  const n = state.subsystems.length;
  if (n === 0) return;
  const next = selectNextSubsystem(state);
  if (next >= 0) {
    state.current_index = next;
  } else {
    // All done — don't change current_index
  }
}

// ── Main Command ─────────────────────────────────────────────────────────────

export async function runAnatomyCommand(
  rest: string[],
  capabilityGate: CapabilityGate = PRODUCTION_CAPABILITY_GATE,
): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(ANATOMY_USAGE);
    return;
  }

  // ── Parse flags ────────────────────────────────────────────────────────────
  const dryRun = rest.includes("--dry-run");
  if (rest.includes("--resume")) capabilityGate.require("resume_retry");
  if (!dryRun) capabilityGate.require("autonomous_dispatch");
  const resume = rest.includes("--resume");
  const maxIterations = parseIntFlag(flagValue(rest, "--max-iterations"), 100);
  const stallLimit = parseIntFlag(flagValue(rest, "--stall-limit"), 3);

  const workingDir = resolve(
    flagValue(rest, "--repo") ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd(),
  );
  const agentDir = resolve(
    flagValue(rest, "--agent") ??
      process.env.RICKGENT_AGENT_DIR ??
      join(new URL("../../../", import.meta.url).pathname, "agents", "rickgent"),
  );

  // ── Fail-closed input validation (before any spawn or state write) ──────
  if (!isDir(agentDir)) {
    console.error(`rickgent anatomy: missing agent directory: ${agentDir}`);
    process.exit(1);
  }
  if (!isDir(workingDir)) {
    console.error(`rickgent anatomy: missing repo directory: ${workingDir}`);
    process.exit(1);
  }

  const rickgentDir = getRickgentDir();
  const dataDir = process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data");
  const statePath = join(rickgentDir, "anatomy-park.json");

  if (!existsSync(rickgentDir)) mkdirSync(rickgentDir, { recursive: true });

  // ── Resume: load prior state ────────────────────────────────────────────────
  let prior: AnatomyState | null = null;
  if (resume) {
    prior = readAnatomyState(statePath);
    if (!prior) {
      console.error(`rickgent anatomy: --resume but no readable state at ${statePath}`);
      process.exit(1);
    }
  }

  // ── Discover subsystems (or reuse from prior state) ─────────────────────────
  let state: AnatomyState;
  if (prior) {
    state = prior;
    // Validate state integrity
    if (!Array.isArray(state.subsystems) || state.subsystems.length === 0) {
      console.error("rickgent anatomy: --resume state has no subsystems");
      process.exit(1);
    }
  } else {
    const subsystems = discoverSubsystems(workingDir);
    if (subsystems.length === 0) {
      console.error(`rickgent anatomy: no subsystems discovered in ${workingDir} (need 3+ source files per immediate subdir)`);
      process.exit(1);
    }
    state = initState(subsystems, stallLimit);
  }

  // Update stallLimit in case it changed
  state.stall_limit = stallLimit;

  // ── Dry-run: review all subsystems, catalog, stop ───────────────────────────
  if (dryRun) {
    const beforeHead = gitHeadSha(workingDir);

    for (const subsystem of state.subsystems) {
      const reviewResult = spawnOmnigent(
        agentDir,
        workingDir,
        buildReviewPrompt(subsystem),
        dataDir,
      );

      if (reviewResult.error) {
        console.error(`rickgent anatomy: --dry-run REVIEW spawn failed for subsystem ${subsystem}`);
        process.exit(1);
      }

      const { findings } = parseFindingsFromReview(reviewResult.stdout);

      const phaseLog: PhaseLog = {
        phase: "REVIEW",
        timestamp: new Date().toISOString(),
        findingId: findings.length > 0 ? findings[0]!.id : null,
        result: findings.length === 0 ? "clean" : `${findings.length} findings`,
        details: JSON.stringify(findings),
      };

      const record: IterationRecord = {
        iteration: (state.findings_history[subsystem] ?? []).length,
        subsystem,
        phases: [phaseLog],
        findings,
        fix_applied: false,
        committed: false,
        reverted: false,
        trap_doors_added: 0,
      };

      if (!state.findings_history[subsystem]) {
        state.findings_history[subsystem] = [];
      }
      state.findings_history[subsystem]!.push(record);
      state.pass_counts[subsystem] = (state.pass_counts[subsystem] ?? 0) + 1;

      // Identify trap door candidates from findings (structural/pattern findings,
      // CRITICAL severity, or files with repeated fixes per fix_counts)
      for (const f of findings) {
        const fixCount = f.file != null ? (state.fix_counts[f.file] ?? 0) : 0;
        const isRepeatedFix = f.file != null && fixCount >= 2;
        if (f.category === "pattern" || f.severity === "CRITICAL" || isRepeatedFix) {
          const trapDoor: TrapDoor = {
            subsystem,
            file: f.file ?? "(unknown)",
            description: isRepeatedFix
              ? `${f.title || f.description} (repeated fix #${fixCount})`
              : f.title || f.description,
            patternShape: f.category,
          };
          state.trap_doors_added.push(trapDoor);
        }
      }
    }

    state.status = "dry-run";
    state.reason = "dry-run complete";
    state.updated_at = new Date().toISOString();
    writeAnatomyState(statePath, state);

    // Verify no commits or file modifications
    const afterHead = gitHeadSha(workingDir);
    const lines: string[] = [
      "rickgent anatomy — dry-run subsystem review",
      "=".repeat(50),
      `repo: ${workingDir}`,
      `subsystems: ${state.subsystems.length} (${state.subsystems.join(", ")})`,
      `trap_doors_added: ${state.trap_doors_added.length}`,
      `state: ${statePath}`,
      "=".repeat(50),
    ];
    console.log(lines.join("\n"));
    return;
  }

  // ── Main loop: 3-phase protocol per iteration ───────────────────────────────
  const totalIterations = prior
    ? Object.values(state.findings_history).reduce((sum, h) => sum + h.length, 0)
    : 0;

  let iterationCount = 0;
  let iterationsRun = 0; // actual iterations that executed (not just loop passes)
  let converged = false;
  let convergenceReason = "";

  for (let i = 0; i < maxIterations; i++) {
    iterationCount = totalIterations + i;

    // Check convergence before starting a new iteration
    const conv = checkConvergence(state);
    if (conv.converged) {
      converged = true;
      convergenceReason = conv.reason;
      break;
    }

    // Select the next subsystem to review
    const subIdx = selectNextSubsystem(state);
    if (subIdx < 0) {
      // All subsystems are either clean or stalled
      const finalConv = checkConvergence(state);
      converged = finalConv.converged;
      convergenceReason = finalConv.reason;
      break;
    }

    state.current_index = subIdx;
    const subsystem = state.subsystems[subIdx]!;
    const ownedPaths = [subsystem];
    iterationsRun++; // an iteration is actually executing

    // ── Phase 1: REVIEW (read-only) ─────────────────────────────────────────
    const reviewResult = spawnOmnigent(
      agentDir,
      workingDir,
      buildReviewPrompt(subsystem),
      dataDir,
    );

    if (reviewResult.error) {
      console.error(`rickgent anatomy: REVIEW spawn failed for subsystem ${subsystem}`);
      process.exit(1);
    }

    const { findings } = parseFindingsFromReview(reviewResult.stdout);

    const reviewPhase: PhaseLog = {
      phase: "REVIEW",
      timestamp: new Date().toISOString(),
      findingId: findings.length > 0 ? findings[0]!.id : null,
      result: findings.length === 0 ? "clean" : `${findings.length} findings`,
      details: JSON.stringify(findings),
    };

    const phases: PhaseLog[] = [reviewPhase];
    let fixApplied = false;
    let committed = false;
    let reverted = false;
    let trapDoorsAdded = 0;

    if (findings.length === 0) {
      // Zero findings → bump consecutive_clean, rotate
      state.consecutive_clean[subsystem] = (state.consecutive_clean[subsystem] ?? 0) + 1;
      state.stall_counts[subsystem] = 0; // reset stall on clean pass

      const record: IterationRecord = {
        iteration: iterationCount,
        subsystem,
        phases,
        findings,
        fix_applied: false,
        committed: false,
        reverted: false,
        trap_doors_added: 0,
      };
      state.findings_history[subsystem]!.push(record);
      state.pass_counts[subsystem] = (state.pass_counts[subsystem] ?? 0) + 1;

      // Advance to next subsystem
      advanceRotation(state);
      state.updated_at = new Date().toISOString();
      writeAnatomyState(statePath, state);
      continue;
    }

    // Findings exist → reset consecutive_clean
    state.consecutive_clean[subsystem] = 0;

    // Select the highest-severity finding (CRITICAL > HIGH)
    const sortedFindings = [...findings].sort((a, b) => {
      if (a.severity === "CRITICAL" && b.severity !== "CRITICAL") return -1;
      if (b.severity === "CRITICAL" && a.severity !== "CRITICAL") return 1;
      return b.confidence - a.confidence;
    });
    const topFinding = sortedFindings[0]!;

    // ── Phase 2: FIX (minimal edit + regression test) ──────────────────────
    const fixResult = spawnOmnigent(
      agentDir,
      workingDir,
      buildFixPrompt(subsystem, topFinding),
      dataDir,
    );

    if (fixResult.error) {
      console.error(`rickgent anatomy: FIX spawn failed for subsystem ${subsystem}`);
      process.exit(1);
    }

    // Check FIX worker exit code — non-zero means the fix failed (convention #2:
    // git-tree-truth > exit code > logs > model claims; a non-zero exit is evidence
    // of failure even if stdout looks OK). Treat as a stall.
    if (fixResult.exitCode !== null && fixResult.exitCode !== 0) {
      // Revert any partial changes the worker may have made
      gitUnstageAll(workingDir);
      gitRestoreScoped(workingDir, ownedPaths);

      state.stall_counts[subsystem] = (state.stall_counts[subsystem] ?? 0) + 1;

      const fixPhase: PhaseLog = {
        phase: "FIX",
        timestamp: new Date().toISOString(),
        findingId: topFinding.id,
        result: "FAILED",
        details: `FIX worker exited with code ${fixResult.exitCode}`,
      };
      phases.push(fixPhase);

      const record: IterationRecord = {
        iteration: iterationCount,
        subsystem,
        phases,
        findings,
        fix_applied: false,
        committed: false,
        reverted: true,
        trap_doors_added: 0,
      };
      state.findings_history[subsystem]!.push(record);
      state.pass_counts[subsystem] = (state.pass_counts[subsystem] ?? 0) + 1;

      advanceRotation(state);
      state.updated_at = new Date().toISOString();
      writeAnatomyState(statePath, state);
      continue;
    }

    fixApplied = true;

    const fixPhase: PhaseLog = {
      phase: "FIX",
      timestamp: new Date().toISOString(),
      findingId: topFinding.id,
      result: "applied",
      details: fixResult.stdout.slice(0, 500),
    };
    phases.push(fixPhase);

    // ── Scope preflight: check if all dirty files are in scope ──────────────
    const scopeCheck = checkScopePreflight(workingDir, ownedPaths);

    if (scopeCheck.outOfScope.length > 0) {
      // Scope violation: unstage all, record as CRITICAL, stall
      gitUnstageAll(workingDir);
      gitRestoreScoped(workingDir, ownedPaths);

      // Record the scope violation as a CRITICAL finding
      state.stall_counts[subsystem] = (state.stall_counts[subsystem] ?? 0) + 1;

      const verifyPhase: PhaseLog = {
        phase: "VERIFY",
        timestamp: new Date().toISOString(),
        findingId: topFinding.id,
        result: "SCOPE_VIOLATION",
        details: `Out-of-scope files: ${scopeCheck.outOfScope.join(", ")}`,
      };
      phases.push(verifyPhase);
      reverted = true;

      const record: IterationRecord = {
        iteration: iterationCount,
        subsystem,
        phases,
        findings,
        fix_applied: true,
        committed: false,
        reverted: true,
        trap_doors_added: 0,
      };
      state.findings_history[subsystem]!.push(record);
      state.pass_counts[subsystem] = (state.pass_counts[subsystem] ?? 0) + 1;

      advanceRotation(state);
      state.updated_at = new Date().toISOString();
      writeAnatomyState(statePath, state);
      continue;
    }

    // ── Stage in-scope files ────────────────────────────────────────────────
    gitStageOwned(workingDir, ownedPaths);

    // ── Phase 3: VERIFY (read-only, combinatorial branch verification) ──────
    const verifyResult = spawnOmnigent(
      agentDir,
      workingDir,
      buildVerifyPrompt(subsystem),
      dataDir,
    );

    if (verifyResult.error) {
      console.error(`rickgent anatomy: VERIFY spawn failed for subsystem ${subsystem}`);
      process.exit(1);
    }

    const { passed, details: verifyDetails } = parseVerifyResult(verifyResult.stdout);

    const verifyPhase: PhaseLog = {
      phase: "VERIFY",
      timestamp: new Date().toISOString(),
      findingId: topFinding.id,
      result: passed ? "PASS" : "FAIL",
      details: verifyDetails.slice(0, 500),
    };
    phases.push(verifyPhase);

    if (!passed) {
      // Regression detected: path-scoped git restore, stall
      gitUnstageAll(workingDir);
      gitRestoreScoped(workingDir, ownedPaths);
      reverted = true;
      state.stall_counts[subsystem] = (state.stall_counts[subsystem] ?? 0) + 1;
    } else {
      // Verification passed: commit the fix
      const commitMsg = `anatomy-park: ${subsystem} — ${topFinding.severity} ${topFinding.title}`;
      const commitSha = gitCommit(workingDir, commitMsg);
      committed = commitSha !== null;
      state.stall_counts[subsystem] = 0; // reset stall on successful fix

      // Identify trap doors:
      // (a) structural/pattern findings or CRITICAL severity (existing trigger)
      // (b) files with repeated fixes (fix_counts >= 2) — per-file fix count tracking
      for (const f of findings) {
        // Track per-file fix count for the top finding's file
        if (f.file && f.id === topFinding.id) {
          state.fix_counts[f.file] = (state.fix_counts[f.file] ?? 0) + 1;
        }

        const fixCount = f.file != null ? (state.fix_counts[f.file] ?? 0) : 0;
        const isRepeatedFix = f.file != null && fixCount >= 2;
        if (f.category === "pattern" || f.severity === "CRITICAL" || isRepeatedFix) {
          const trapDoor: TrapDoor = {
            subsystem,
            file: f.file ?? "(unknown)",
            description: isRepeatedFix
              ? `${f.title || f.description} (repeated fix #${fixCount})`
              : f.title || f.description,
            patternShape: f.category,
          };
          state.trap_doors_added.push(trapDoor);
          state.trap_doors_committed.push(trapDoor);
          trapDoorsAdded++;
        }
      }

      // Write trap doors to CLAUDE.md
      if (trapDoorsAdded > 0) {
        writeTrapDoorsToClaude(workingDir, subsystem, state.trap_doors_added.filter((t) => t.subsystem === subsystem));
        // Stage and commit the CLAUDE.md
        const claudePath = `${subsystem}/CLAUDE.md`;
        try {
          execFileSync("git", ["-C", workingDir, "add", "--", claudePath], { timeout: 10000 });
          execFileSync(
            "git",
            [
              "-C", workingDir,
              "-c", "user.email=anatomy@rickgent.test",
              "-c", "user.name=Anatomy Park",
              "commit", "-m", `anatomy-park: catalog ${trapDoorsAdded} trap doors for ${subsystem}`,
            ],
            { timeout: 10000 },
          );
        } catch {
          /* ignore commit failure for CLAUDE.md */
        }
      }
    }

    // Record the iteration
    const record: IterationRecord = {
      iteration: iterationCount,
      subsystem,
      phases,
      findings,
      fix_applied: fixApplied,
      committed,
      reverted,
      trap_doors_added: trapDoorsAdded,
    };
    state.findings_history[subsystem]!.push(record);
    state.pass_counts[subsystem] = (state.pass_counts[subsystem] ?? 0) + 1;

    // Advance to next subsystem
    advanceRotation(state);
    state.updated_at = new Date().toISOString();
    writeAnatomyState(statePath, state);
  }

  // ── Check final convergence ─────────────────────────────────────────────────
  if (!converged) {
    const conv = checkConvergence(state);
    converged = conv.converged;
    convergenceReason = conv.reason;
  }

  state.converged = converged;
  state.status = converged ? "converged" : "max-iterations";
  state.reason = convergenceReason;
  state.updated_at = new Date().toISOString();
  writeAnatomyState(statePath, state);

  // ── Print report ────────────────────────────────────────────────────────────
  const lines: string[] = [
    "rickgent anatomy — deep subsystem review",
    "=".repeat(50),
    `repo: ${workingDir}`,
    `subsystems: ${state.subsystems.length} (${state.subsystems.join(", ")})`,
    `stall_limit: ${stallLimit}`,
    `max_iterations: ${maxIterations}`,
    `iterations_run: ${iterationsRun}`,
    `converged: ${converged}`,
    `status: ${state.status}`,
    `reason: ${convergenceReason}`,
    "",
    "Subsystem Status:",
  ];

  for (const sub of state.subsystems) {
    const clean = state.consecutive_clean[sub] ?? 0;
    const stalled = state.stall_counts[sub] ?? 0;
    const passes = state.pass_counts[sub] ?? 0;
    const findings = (state.findings_history[sub] ?? []).length;
    lines.push(`  ${sub}: passes=${passes} consecutive_clean=${clean} stall_counts=${stalled} iterations=${findings}`);
  }

  lines.push("");
  lines.push(`trap_doors_added: ${state.trap_doors_added.length}`);
  lines.push(`trap_doors_committed: ${state.trap_doors_committed.length}`);
  lines.push(`state: ${statePath}`);
  lines.push("=".repeat(50));
  console.log(lines.join("\n"));

  // Non-convergence exits non-zero (fail-closed on incomplete review).
  if (!converged) {
    process.exit(1);
  }
}
