// `rickgent szechuan` CLI command — iterative deslopping with 30+ coding
// principles + convergence loop.
//
// Ports pickle-rick-claude's szechuan-sauce command to rickgent's multi-vendor,
// fail-closed architecture. The command:
//
//   1. Loads 30+ principles from szechuan-principles.ts (P0-P4 buckets)
//   2. Phase 0: Contract discovery (exports, importers, contract map → gap_analysis.md)
//   3. Uses MicroverseLoop with violation-count convergence (target 0, lower)
//   4. Per iteration: an omnigent-run worker fixes one violation; an omnigent-run
//      LLM judge scores the remaining violation count
//   5. Commits owned-paths-only on improvement; reverts on regression
//   6. State persisted to .rickgent/szechuan.json and .rickgent/gap_analysis.md
//
// Flags: --dry-run, --domain, --focus, --design-safe, --max-iterations,
//        --stall-limit, --repo, --agent, --resume

import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve, relative } from "path";
import {
  MicroverseLoop,
  parseLastNumericLine,
  type MicroverseLoopResult,
} from "./microverse.js";
import {
  loadCatalog,
  applyFocus,
  isKnownDomain,
  availableDomains,
  groupByPriority,
  renderPrinciplesMarkdown,
  validateCatalog,
  type Principle,
  type PriorityBucket,
} from "./szechuan-principles.js";

const SZECHUAN_USAGE = `rickgent szechuan — iterative deslopping with 30+ coding principles

Usage:
  rickgent szechuan [options]

Options:
  --dry-run              Catalog violations without fixing or committing
  --domain <name>        Load supplemental domain principles (api, ui, testing)
  --focus "<text>"       Elevate specific concerns to higher priority
  --design-safe          Mark visual/UI findings as report-only
  --max-iterations <N>   Iteration cap (default: 50)
  --stall-limit <N>      Consecutive non-improving iterations before stopping (default: 5)
  --repo <dir>           Target git repo (default: cwd)
  --agent <dir>          omnigent agent bundle directory
  --resume               Continue from .rickgent/szechuan.json
  --help, -h             Show this help

The loop measures violation count (lower is better, target 0) via an LLM judge
spawned through \`omnigent run\`. Each iteration's worker fixes one violation;
the judge re-scores. Convergence at count 0 OR stall_limit OR max_iterations.
`;

// ── State Types ──────────────────────────────────────────────────────────────

interface SzechuanIterationRecord {
  iteration: number;
  score: number | null;
  classification: string;
  /** Selected violation for this iteration (principle, severity, file, line). */
  violation: {
    principle: string | null;
    severity: PriorityBucket;
    file: string | null;
    line: number | null;
    description: string | null;
  } | null;
  /** Fix applied (description + commit hash, or null on revert). */
  fix: {
    description: string | null;
    commitHash: string | null;
  } | null;
  /** Test result for the iteration. */
  testResult: "pass" | "fail" | "skipped" | null;
  /** Post-fix violation count from the judge. */
  postFixCount: number | null;
}

interface SzechuanState {
  task: string;
  domain: string | null;
  focus: string | null;
  designSafe: boolean;
  catalogSize: number;
  baselineCount: number;
  finalCount: number | null;
  converged: boolean;
  status: string;
  convergence: {
    reason: string;
    history: SzechuanIterationRecord[];
  };
  failedApproaches: Array<{ iteration: number; description: string }>;
  updatedAt: string;
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

// ── Contract Discovery (Phase 0) ─────────────────────────────────────────────

interface ExportEntry {
  file: string;
  symbol: string;
  line: number;
}

interface ContractMapEntry {
  exportSite: ExportEntry;
  importers: string[];
}

/**
 * Phase 0: Contract discovery. Extracts exports from target source files,
 * greps for importers across the repo, and builds a contract map written to
 * gap_analysis.md.
 */
function runContractDiscovery(workingDir: string, ownedPaths: string[]): {
  exports: ExportEntry[];
  contractMap: ContractMapEntry[];
  markdown: string;
} {
  const sourceFiles = findSourceFiles(workingDir, ownedPaths);
  const allExports: ExportEntry[] = [];

  for (const file of sourceFiles) {
    const relPath = relative(workingDir, file);
    const exports = extractExports(file, relPath);
    allExports.push(...exports);
  }

  // Grep for importers of each export across the repo.
  const contractMap: ContractMapEntry[] = [];
  for (const exp of allExports) {
    const importers = grepImporters(workingDir, exp.symbol, exp.file);
    contractMap.push({ exportSite: exp, importers });
  }

  const markdown = renderContractMapMarkdown(contractMap);
  return { exports: allExports, contractMap, markdown };
}

function findSourceFiles(workingDir: string, ownedPaths: string[]): string[] {
  const extensions = [".ts", ".js", ".py", ".go", ".rs", ".java", ".tsx", ".jsx", ".vue", ".svelte"];
  const files: string[] = [];

  // Use git ls-files to get tracked source files within owned paths.
  try {
    const out = execFileSync(
      "git",
      ["-C", workingDir, "ls-files", "--", ...ownedPaths],
      { encoding: "utf-8", timeout: 10000 },
    );
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (extensions.some((ext) => trimmed.endsWith(ext))) {
        files.push(join(workingDir, trimmed));
      }
    }
  } catch {
    // Fallback: walk owned paths manually for source files.
    for (const owned of ownedPaths) {
      const abs = join(workingDir, owned);
      if (!existsSync(abs)) continue;
      walkDir(abs, files, extensions);
    }
  }

  return files;
}

function walkDir(dir: string, files: string[], extensions: string[]): void {
  const { readdirSync } = require("fs");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full, files, extensions);
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      files.push(full);
    }
  }
}

function extractExports(absPath: string, relPath: string): ExportEntry[] {
  const exports: ExportEntry[] = [];
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return exports;
  }

  const lines = content.split("\n");
  const patterns: RegExp[] = [
    /^\s*export\s+(?:async\s+)?function\s+(\w+)/,
    /^\s*export\s+const\s+(\w+)/,
    /^\s*export\s+let\s+(\w+)/,
    /^\s*export\s+class\s+(\w+)/,
    /^\s*export\s+interface\s+(\w+)/,
    /^\s*export\s+type\s+(\w+)/,
    /^\s*export\s+enum\s+(\w+)/,
    /^\s*export\s+default\s+function\s+(\w+)/,
    /^\s*export\s+\{([^}]+)\}/,
  ];

  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = lines[i]!.match(pattern);
      if (!match) continue;
      if (match[1]) {
        // Named export (skip duplicates from overlapping patterns)
        const symbol = match[1];
        const key = `${relPath}:${symbol}:${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        exports.push({ file: relPath, symbol, line: i + 1 });
      } else if (match[2]) {
        // Brace export: { foo, bar, baz }
        const names = match[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter((s) => s.length > 0);
        for (const name of names) {
          exports.push({ file: relPath, symbol: name, line: i + 1 });
        }
      }
    }
  }

  // Python exports
  if (relPath.endsWith(".py")) {
    for (let i = 0; i < lines.length; i++) {
      const defMatch = lines[i]!.match(/^(?:async\s+)?def\s+(\w+)/);
      const classMatch = lines[i]!.match(/^class\s+(\w+)/);
      if (defMatch || classMatch) {
        const name = (defMatch ?? classMatch)![1]!;
        exports.push({ file: relPath, symbol: name, line: i + 1 });
      }
    }
  }

  return exports;
}

function grepImporters(workingDir: string, symbol: string, sourceFile: string): string[] {
  const importers: string[] = [];
  try {
    // Use git grep for tracked files only.
    const out = execFileSync(
      "git",
      ["-C", workingDir, "grep", "--all", "-l", "--", symbol],
      { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      // Exclude the source file itself (it defines the export).
      if (trimmed === sourceFile) continue;
      importers.push(trimmed);
    }
  } catch {
    // git grep returns non-zero when no matches; that's fine.
  }
  return importers;
}

function renderContractMapMarkdown(contractMap: ContractMapEntry[]): string {
  const lines: string[] = ["## Contract Map", ""];
  if (contractMap.length === 0) {
    lines.push("(no exports discovered in target scope)");
    lines.push("");
    return lines.join("\n");
  }

  // Group by source file
  const byFile = new Map<string, ContractMapEntry[]>();
  for (const entry of contractMap) {
    const file = entry.exportSite.file;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(entry);
  }

  for (const [file, entries] of byFile) {
    const importerList = entries
      .map((e) => e.importers.length > 0 ? e.importers.join(", ") : "(no importers)")
      .join(", ");
    lines.push(`### ${file} → [${entries.map((e) => e.importers).flat()}]`);
    for (const e of entries) {
      const importers = e.importers.length > 0 ? e.importers.join(", ") : "(no importers)";
      lines.push(`- \`${e.exportSite.symbol}\` (line ${e.exportSite.line}): used by ${importers}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Dry-Run Violation Catalog ────────────────────────────────────────────────

function buildJudgePrompt(
  catalog: Principle[],
  focus: string | null,
  designSafe: boolean,
): string {
  const principlesText = renderPrinciplesMarkdown(catalog);
  const lines: string[] = [
    "You are a read-only Szechuan Sauce violation judge. Do NOT modify any files; use only read-only tools.",
    "Read the target code and catalog all actionable coding principle violations.",
    "",
    principlesText,
  ];
  if (focus) {
    lines.push("");
    lines.push("## Focus Directive");
    lines.push(focus);
    lines.push("Violations matching this focus are elevated by one priority level. When tied, fix focus-matching violations first.");
  }
  if (designSafe) {
    lines.push("");
    lines.push("## Design-Safe Mode");
    lines.push("Visual/UI findings (layout, color, spacing, component shape) are tagged [report-only: intentional design choice] and excluded from the violation count.");
  }
  lines.push("");
  lines.push("## Output Format");
  lines.push("List each violation as: [P<N>, conf=<score>] file:line — description (principle: <Name>)");
  lines.push("Then output a summary line with the total violation count as the LAST numeric line of your response.");
  return lines.join("\n");
}

function buildWorkerPrompt(
  iteration: number,
  catalog: Principle[],
  focus: string | null,
  designSafe: boolean,
  failedApproaches: string[],
): string {
  const principlesText = renderPrinciplesMarkdown(catalog);
  const lines: string[] = [
    `Szechuan Sauce deslopping iteration ${iteration + 1}.`,
    "You are Rick Sanchez on a mission to get the Szechuan Sauce. The sauce is perfect code.",
    "",
    "## Task",
    "Read the target code, identify the SINGLE highest-priority violation (P0 > P1 > P2 > P3 > P4),",
    "fix it with one minimal atomic edit, run the project tests, and leave the change uncommitted.",
    "The loop will commit improvements and revert regressions.",
    "",
    "## Principles Reference",
    principlesText,
  ];
  if (focus) {
    lines.push("", "## Focus Directive", focus);
    lines.push("Violations matching this focus are elevated by one priority level. Fix focus-matching violations first.");
  }
  if (designSafe) {
    lines.push("", "## Design-Safe Mode");
    lines.push("Do NOT fix visual/UI findings (layout, color, spacing). Tag them [report-only] and skip.");
  }
  if (failedApproaches.length > 0) {
    lines.push("", "## Previously Failed Approaches (do not repeat)");
    for (const f of failedApproaches.slice(-5)) {
      lines.push(`- ${f}`);
    }
  }
  lines.push("", "## Rules");
  lines.push("- One fix per iteration (atomic, revertible)");
  lines.push("- P0 (security) before P1 (bugs) before P2 (maintainability) before P3 (polish) before P4 (style)");
  lines.push("- Never repeat a failed approach");
  lines.push("- Only edit files within the owned scope");
  return lines.join("\n");
}

// ── Violation Parsing ────────────────────────────────────────────────────────

/**
 * A single violation parsed from the LLM judge's stdout. The judge prompt
 * instructs the model to emit lines in the format:
 *   [P<N>, conf=<score>] file:line — description (principle: <Name>)
 */
interface ParsedViolation {
  severity: PriorityBucket;
  principle: string | null;
  file: string | null;
  line: number | null;
  description: string | null;
}

const SEVERITY_SET: ReadonlySet<string> = new Set(["P0", "P1", "P2", "P3", "P4"]);

/**
 * Parse violation lines from the judge's raw stdout. Each line matching the
 * format `[P<N>, conf=<score>] file:line — description (principle: <Name>)`
 * yields a {@link ParsedViolation}. Lines that do not match (including the
 * final numeric summary line) are silently skipped.
 */
function parseViolationsFromJudgeOutput(output: string): ParsedViolation[] {
  if (typeof output !== "string" || output.length === 0) return [];
  const violations: ParsedViolation[] = [];
  // Match: [P<N>, conf=<score>] <file>(:<line>)? — <description> (principle: <Name>)
  // The em-dash (—) in the prompt may be rendered as --, —, or a hyphen by the
  // model, so accept any of those separators.
  const pattern =
    /\[P([0-4]),\s*conf=[\d.]+\]\s+(\S+?)(?::(\d+))?\s*[—\-\u2013]+\s*(.+?)(?:\s*\(principle:\s*(.+?)\))?\s*$/i;
  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.match(pattern);
    if (!match) continue;
    const sev = `P${match[1]}`;
    if (!SEVERITY_SET.has(sev)) continue;
    const severity = sev as PriorityBucket;
    const file = match[2] ?? null;
    const lineNum = match[3] ? parseInt(match[3], 10) : null;
    const description = match[4]?.trim() ?? null;
    const principle = match[5]?.trim() ?? null;
    violations.push({ severity, principle, file, line: lineNum, description });
  }
  return violations;
}

/**
 * Select the highest-priority violation from a list (P0 > P1 > P2 > P3 > P4).
 * Returns null when the list is empty.
 */
function selectHighestPriorityViolation(violations: ParsedViolation[]): ParsedViolation | null {
  if (violations.length === 0) return null;
  const rank: Record<PriorityBucket, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  let best: ParsedViolation | null = null;
  for (const v of violations) {
    if (best === null || rank[v.severity] < rank[best.severity]) {
      best = v;
    }
  }
  return best;
}

function measureViolationCount(
  agentDir: string,
  workingDir: string,
  catalog: Principle[],
  focus: string | null,
  designSafe: boolean,
  dataDir: string,
): { count: number | null; rawOutput: string; violations: ParsedViolation[] } {
  const prompt = buildJudgePrompt(catalog, focus, designSafe);
  const res = spawnSync("omnigent", ["run", agentDir, "-p", prompt], {
    cwd: workingDir,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, OMNIGENT_DATA_DIR: dataDir },
  });
  if (res.error) return { count: null, rawOutput: "", violations: [] };
  if (res.status !== 0 && res.status !== null) {
    return { count: null, rawOutput: res.stdout ?? "", violations: parseViolationsFromJudgeOutput(res.stdout ?? "") };
  }
  const rawOutput = res.stdout ?? "";
  const count = parseLastNumericLine(rawOutput);
  const violations = parseViolationsFromJudgeOutput(rawOutput);
  return { count, rawOutput, violations };
}

// ── Gap Analysis Writer ──────────────────────────────────────────────────────

function appendGapAnalysis(
  rickgentDir: string,
  section: string,
  content: string,
): void {
  const gapPath = join(rickgentDir, "gap_analysis.md");
  let existing = "";
  if (existsSync(gapPath)) {
    existing = readFileSync(gapPath, "utf-8");
  }
  const header = existing === "" ? "# Szechuan Sauce Gap Analysis\n\n" : "";
  // Prepend Contract Map if it's the contract section; otherwise append.
  if (section === "contract-map") {
    const updated = header + content + "\n" + existing.replace(/^# Szechuan Sauce Gap Analysis\n*/i, "");
    writeFileSync(gapPath, updated, "utf-8");
  } else {
    const updated = existing === "" ? header + content + "\n" : existing + "\n" + content + "\n";
    writeFileSync(gapPath, updated, "utf-8");
  }
}

// ── State Read/Write ─────────────────────────────────────────────────────────

function readSzechuanState(statePath: string): SzechuanState | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SzechuanState>;
    if (parsed == null || typeof parsed !== "object") return null;
    return parsed as SzechuanState;
  } catch {
    return null;
  }
}

function writeSzechuanState(statePath: string, state: SzechuanState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function deriveReason(result: MicroverseLoopResult): string {
  switch (result.status) {
    case "converged":
      return /target/i.test(result.reason) ? "target" : "plateau";
    case "attrition":
      return "plateau";
    case "max-iterations":
      return "max_iterations";
    case "deadline-salvaged":
      return "deadline_exceeded";
    case "breaker-tripped":
      return "breaker";
    default:
      return result.status;
  }
}

function mapClassification(classification: string): string {
  return classification === "deadline" ? "deadline_exceeded" : classification;
}

// ── Main Command ─────────────────────────────────────────────────────────────

export async function runSzechuanCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(SZECHUAN_USAGE);
    return;
  }

  // ── Parse flags ────────────────────────────────────────────────────────────
  const dryRun = rest.includes("--dry-run");
  const domain = flagValue(rest, "--domain");
  const focus = flagValue(rest, "--focus");
  const designSafe = rest.includes("--design-safe");
  const resume = rest.includes("--resume");
  const maxIterations = parseIntFlag(flagValue(rest, "--max-iterations"), 50);
  const stallLimit = parseIntFlag(flagValue(rest, "--stall-limit"), 5);

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
    console.error(`rickgent szechuan: missing agent directory: ${agentDir}`);
    process.exit(1);
  }
  if (!isDir(workingDir)) {
    console.error(`rickgent szechuan: missing repo directory: ${workingDir}`);
    process.exit(1);
  }

  if (domain && !isKnownDomain(domain)) {
    console.error(`rickgent szechuan: unknown domain "${domain}". Available domains: ${availableDomains().join(", ")}`);
    process.exit(1);
  }

  // ── Load and validate principles catalog ───────────────────────────────────
  let catalog = loadCatalog(domain ?? undefined);
  if (focus) {
    catalog = applyFocus(catalog, focus);
  }

  const validation = validateCatalog(catalog);
  if (!validation.valid) {
    console.error(`rickgent szechuan: catalog validation failed: ${validation.issues.join("; ")}`);
    process.exit(1);
  }

  const rickgentDir = getRickgentDir();
  const dataDir = process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data");
  const statePath = join(rickgentDir, "szechuan.json");

  // Owned paths: default to "." (entire repo). Can be overridden via env.
  const ownedPathsRaw = process.env.SZECHUAN_OWNED_PATHS;
  const ownedPaths = ownedPathsRaw
    ? ownedPathsRaw.split(/[,\s]+/).filter((s) => s.length > 0)
    : ["."];

  // ── Resume: load prior state ────────────────────────────────────────────────
  let prior: SzechuanState | null = null;
  if (resume) {
    prior = readSzechuanState(statePath);
    if (!prior) {
      console.error(`rickgent szechuan: --resume but no readable state at ${statePath}`);
      process.exit(1);
    }
  }

  // ── Phase 0: Contract discovery (iteration 1 only, or when no state) ───────
  if (!prior && !dryRun) {
    if (!existsSync(rickgentDir)) mkdirSync(rickgentDir, { recursive: true });
    const discovery = runContractDiscovery(workingDir, ownedPaths);
    appendGapAnalysis(rickgentDir, "contract-map", discovery.markdown);
  }

  // ── Dry-run: catalog violations without fixing/committing ──────────────────
  if (dryRun) {
    if (!existsSync(rickgentDir)) mkdirSync(rickgentDir, { recursive: true });

    // Phase 0 for dry-run too (contract map in gap_analysis.md)
    const discovery = runContractDiscovery(workingDir, ownedPaths);
    appendGapAnalysis(rickgentDir, "contract-map", discovery.markdown);

    // Measure violation count via the judge
    const measured = measureViolationCount(agentDir, workingDir, catalog, focus ?? null, designSafe, dataDir);
    if (measured.count === null) {
      console.error("rickgent szechuan: --dry-run judge failed to produce a numeric violation count");
      process.exit(1);
    }

    // Write violation catalog to gap_analysis.md
    const catalogSection = renderViolationCatalog(catalog, measured.rawOutput, measured.count, focus ?? null, designSafe);
    appendGapAnalysis(rickgentDir, "violations", catalogSection);

    // Write minimal state
    const state: SzechuanState = {
      task: "dry-run catalog",
      domain: domain ?? null,
      focus: focus ?? null,
      designSafe,
      catalogSize: catalog.length,
      baselineCount: measured.count,
      finalCount: measured.count,
      converged: false,
      status: "dry-run",
      convergence: { reason: "dry-run", history: [] },
      failedApproaches: [],
      updatedAt: new Date().toISOString(),
    };
    writeSzechuanState(statePath, state);

    const groups = groupByPriority(catalog);
    const lines: string[] = [
      "rickgent szechuan — dry-run violation catalog",
      "=".repeat(50),
      `repo: ${workingDir}`,
      `domain: ${domain ?? "(none)"}`,
      `focus: ${focus ?? "(none)"}`,
      `design-safe: ${designSafe}`,
      `catalog: ${catalog.length} principles`,
      `  P0: ${groups.P0.length}  P1: ${groups.P1.length}  P2: ${groups.P2.length}  P3: ${groups.P3.length}  P4: ${groups.P4.length}`,
      `violation count: ${measured.count}`,
      `gap_analysis: ${join(rickgentDir, "gap_analysis.md")}`,
      "=".repeat(50),
    ];
    console.log(lines.join("\n"));
    return;
  }

  // ── Measure baseline violation count ────────────────────────────────────────
  let baselineCount: number;
  let initialAcceptedScores: number[] | undefined;
  // Violations seen by the judge BEFORE each iteration's worker runs. Index 0
  // is the baseline; index N+1 is the post-fix measurement of iteration N.
  // These are used to populate the per-iteration `violation` field with the
  // highest-priority violation the worker should have targeted.
  const preFixViolations: ParsedViolation[][] = [];

  if (prior) {
    if (typeof prior.baselineCount !== "number" || !Number.isFinite(prior.baselineCount)) {
      console.error("rickgent szechuan: --resume state has no numeric baselineCount");
      process.exit(1);
    }
    baselineCount = prior.baselineCount;
    // Reconstruct accepted-score series from convergence history (improved entries).
    const acceptedFromHistory = Array.isArray(prior.convergence?.history)
      ? prior.convergence.history
          .filter((h) => h.classification === "improved" && typeof h.postFixCount === "number")
          .map((h) => h.postFixCount as number)
      : [];
    initialAcceptedScores = [baselineCount, ...acceptedFromHistory];
    // On resume, we do not re-measure the baseline, so preFixViolations[0]
    // is empty (the baseline violations from the prior run are not available).
    // Iteration violation fields will be populated from post-fix measurements.
    preFixViolations.push([]);
  } else {
    const measured = measureViolationCount(agentDir, workingDir, catalog, focus ?? null, designSafe, dataDir);
    if (measured.count === null) {
      console.error("rickgent szechuan: LLM judge failed to produce a numeric violation count for the baseline");
      process.exit(1);
    }
    baselineCount = measured.count;
    preFixViolations.push(measured.violations);
  }

  const priorFailed = prior && Array.isArray(prior.failedApproaches) ? prior.failedApproaches : [];
  const priorHistory = prior && Array.isArray(prior.convergence?.history) ? prior.convergence.history : [];

  // ── Construct MicroverseLoop ────────────────────────────────────────────────
  const failedDescriptions = priorFailed.map((f) => f.description);

  const metricFn = (): number | null => {
    const measured = measureViolationCount(
      agentDir,
      workingDir,
      catalog,
      focus ?? null,
      designSafe,
      dataDir,
    );
    // Capture the post-fix violations for this iteration. These become the
    // pre-fix violations for the NEXT iteration.
    preFixViolations.push(measured.violations);
    return measured.count;
  };

  const loop = new MicroverseLoop({
    workingDir,
    ownedPaths,
    metricFn,
    initialBaselineScore: prior ? undefined : baselineCount,
    initialAcceptedScores,
    workerArgv: (iteration: number) => [
      "omnigent",
      "run",
      agentDir,
      "-p",
      buildWorkerPrompt(iteration, catalog, focus ?? null, designSafe, [...failedDescriptions]),
    ],
    maxIterations,
    iterationDeadlineMs: 300000,
    convergence: {
      epsilon: 0.5,
      window: 3,
      target: 0,
      direction: "lower",
      stallLimit,
    },
    rickgentDir,
  });

  const result = await loop.run();

  // ── Persist state ───────────────────────────────────────────────────────────
  // For each iteration, the "selected violation" is the highest-priority
  // violation from the judge output that was available BEFORE the worker ran
  // (preFixViolations[idx]). If the judge produced no parseable violation
  // lines, the violation field is null (fail-closed: no fabrication).
  const newHistory: SzechuanIterationRecord[] = result.iterations.map((it, idx) => {
    const preFix = preFixViolations[idx] ?? [];
    const selected = selectHighestPriorityViolation(preFix);
    return {
      iteration: priorHistory.length + idx,
      score: it.score,
      classification: mapClassification(it.classification),
      violation: selected
        ? {
            principle: selected.principle,
            severity: selected.severity,
            file: selected.file,
            line: selected.line,
            description: selected.description,
          }
        : null,
      fix: it.committedSha ? { description: null, commitHash: it.committedSha } : null,
      testResult: it.classification === "improved" ? "pass" : it.classification === "regressed" ? "fail" : "skipped",
      postFixCount: it.score,
    };
  });
  const history = [...priorHistory, ...newHistory];

  const newFailed = result.iterations
    .filter((it) => ["regressed", "stalled", "deadline", "no-change"].includes(it.classification))
    .map((it, idx) => ({
      iteration: priorHistory.length + idx,
      description: `iteration ${priorHistory.length + idx}: ${mapClassification(it.classification)} (score ${it.score ?? "n/a"})`,
    }));
  const failedApproaches = [...priorFailed, ...newFailed];

  const state: SzechuanState = {
    task: "deslop target code",
    domain: domain ?? null,
    focus: focus ?? null,
    designSafe,
    catalogSize: catalog.length,
    baselineCount,
    finalCount: result.finalScore,
    converged: result.converged,
    status: result.status,
    convergence: {
      reason: deriveReason(result),
      history,
    },
    failedApproaches,
    updatedAt: new Date().toISOString(),
  };

  if (!existsSync(rickgentDir)) mkdirSync(rickgentDir, { recursive: true });
  writeSzechuanState(statePath, state);

  // Update gap_analysis.md with final summary
  const summarySection = renderFinalSummary(catalog, result, baselineCount);
  appendGapAnalysis(rickgentDir, "summary", summarySection);

  // ── Print report ────────────────────────────────────────────────────────────
  const groups = groupByPriority(catalog);
  const lines: string[] = [
    "rickgent szechuan — iterative deslopping",
    "=".repeat(50),
    `repo: ${workingDir}`,
    `domain: ${domain ?? "(none)"}`,
    `focus: ${focus ?? "(none)"}`,
    `design-safe: ${designSafe}`,
    `catalog: ${catalog.length} principles`,
    `  P0: ${groups.P0.length}  P1: ${groups.P1.length}  P2: ${groups.P2.length}  P3: ${groups.P3.length}  P4: ${groups.P4.length}`,
    `baseline_violation_count: ${baselineCount}`,
    `final_violation_count: ${result.finalScore ?? "(none)"}`,
    `iterations: ${result.iterations.length}`,
    `converged: ${result.converged}`,
    `status: ${result.status}`,
    `reason: ${state.convergence.reason} (${result.reason})`,
    `state: ${statePath}`,
    `gap_analysis: ${join(rickgentDir, "gap_analysis.md")}`,
    "=".repeat(50),
  ];
  console.log(lines.join("\n"));

  // Non-convergence exits non-zero (fail-closed on incomplete deslopping).
  if (!result.converged) {
    process.exit(1);
  }
}

function renderViolationCatalog(
  catalog: Principle[],
  judgeOutput: string,
  count: number,
  focus: string | null,
  designSafe: boolean,
): string {
  const lines: string[] = ["## Violations (dry-run catalog)", ""];
  if (focus) {
    lines.push(`**Focus**: ${focus}`, "");
  }
  if (designSafe) {
    lines.push("**Design-Safe**: visual/UI findings tagged [report-only]", "");
  }
  lines.push("### Judge Output");
  lines.push("```");
  lines.push(judgeOutput.trim() || "(no output from judge)");
  lines.push("```");
  lines.push("");
  lines.push(`**Total violation count**: ${count}`);
  lines.push("");
  return lines.join("\n");
}

function renderFinalSummary(
  catalog: Principle[],
  result: MicroverseLoopResult,
  baselineCount: number,
): string {
  const lines: string[] = ["## Deslopping Summary", ""];
  lines.push(`- **Baseline violation count**: ${baselineCount}`);
  lines.push(`- **Final violation count**: ${result.finalScore ?? "(none)"}`);
  lines.push(`- **Iterations**: ${result.iterations.length}`);
  lines.push(`- **Converged**: ${result.converged}`);
  lines.push(`- **Status**: ${result.status}`);
  lines.push(`- **Reason**: ${result.reason}`);
  if (result.iterations.length > 0) {
    lines.push("", "### Iteration History");
    for (const it of result.iterations) {
      lines.push(`- iteration ${it.iteration}: score=${it.score ?? "n/a"} class=${mapClassification(it.classification)} commit=${it.committedSha ?? "none"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
