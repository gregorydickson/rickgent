// Cronenberg — pure deterministic routing matrix.
//
// Given a task, cwd/state, and cronenberg-only flags, this module computes a
// set of black-box signals, picks a metaphor (microverse | pipeline | build),
// picks a followup chain (citadel | anatomy | szechuan), and decides whether a
// refinement pre-pass should run. It is a PURE router: it reads files (fs) to
// derive signals and returns a plan. It NEVER launches an agent and never
// shells out — all delegation/running is the caller's responsibility (see
// cronenberg-run.ts). Same inputs always produce the same plan.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

export type Metaphor = "microverse" | "pipeline" | "build";

export interface CronenbergSignals {
  PRD_PRESENT: boolean;
  MEASURABLE_METRIC: boolean;
  OPTIMIZE_VERB: boolean;
  TICKET_COUNT: number;
  MULTI_STAGE: boolean;
  SUBSYSTEM_TOUCHES: number;
  INTERACTIVE_HINT: boolean;
  ALREADY_REFINED: boolean;
  AC_SHAPE_SMELL: boolean;
  MACHINE_UNCHECKABLE_AC: boolean;
  CITADEL_RISK: boolean;
  DIFF_LOC: number;
  CLEANUP_TASK: boolean;
}

export interface CronenbergFlags {
  dryRun: boolean;
  noFollowups: boolean;
  noRefine: boolean;
  refine: boolean;
}

export interface CronenbergInput {
  task: string;
  workingDir: string;
  rickgentDir: string;
  forward: string[];
  flags: CronenbergFlags;
  diffLoc: number;
}

export interface PlannedCommand {
  label: string;
  argv: string[];
}

export interface CronenbergPlan {
  ok: boolean;
  error?: string;
  task: string;
  prdPath: string | null;
  signals: CronenbergSignals;
  metaphor: Metaphor;
  followups: PlannedCommand[];
  refine: { value: boolean; reason: string };
  refinePrePass: PlannedCommand | null;
  metaphorCommand: PlannedCommand;
  // When the chosen metaphor needs a PRD file but none exists on disk, the
  // planner records the task PRD the RUNNER must materialize before delegating.
  // (The planner stays pure — it computes path + content but performs no write.)
  taskPrd: { path: string; content: string } | null;
}

const STAGE_KEYWORDS = ["refine", "build", "optimize", "cleanup", "deslop", "szechuan", "anatomy", "review"];

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function findPrdPath(workingDir: string, rickgentDir: string): string | null {
  const candidates = [
    join(workingDir, "prd.md"),
    join(workingDir, "PRD.md"),
    join(rickgentDir, "prd.md"),
  ];
  for (const c of candidates) {
    if (safeIsFile(c)) return c;
  }
  return null;
}

function detectAlreadyRefined(workingDir: string, rickgentDir: string): boolean {
  const candidates = [
    join(workingDir, "prd_refined.md"),
    join(workingDir, "refinement_manifest.json"),
    join(rickgentDir, "prd_refined.md"),
    join(rickgentDir, "refinement_manifest.json"),
  ];
  return candidates.some(safeIsFile);
}

function countTicketDirs(dir: string): number {
  if (!safeIsDir(dir)) return 0;
  try {
    return readdirSync(dir).filter((n) => /^rick_ticket_[^/]+$/.test(n) && n !== "rick_ticket_parent").length;
  } catch {
    return 0;
  }
}

function countRefinedTickets(workingDir: string, rickgentDir: string): number {
  const fromDirs = Math.max(countTicketDirs(workingDir), countTicketDirs(rickgentDir));
  if (fromDirs > 0) return fromDirs;
  for (const p of [join(workingDir, "prd_refined.md"), join(rickgentDir, "prd_refined.md")]) {
    const body = safeRead(p);
    if (!body) continue;
    const matches = body.match(/rick_ticket_[0-9a-f]+/gi);
    if (matches) {
      const distinct = new Set(matches.map((m) => m.toLowerCase()));
      distinct.delete("rick_ticket_parent");
      if (distinct.size > 0) return distinct.size;
    }
  }
  return 0;
}

function inferTaskTicketCount(task: string): number {
  const trimmed = task.trim();
  if (trimmed === "") return 0;
  const segments = trimmed
    .split(/\s*,\s*|\s*;\s*|\n+|\s+\band\b\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Math.max(1, segments.length);
}

function computeMeasurableMetric(task: string, forward: string[]): boolean {
  if (forward.includes("--metric") || forward.includes("--goal")) return true;
  return /\bcoverage\b|\blatency\b|\blint\b|error rate|bundle size|\d+\s*%|\bp\d{2}\b|\bms\b|throughput|\b(reduce|improve|increase|decrease|lower|raise)\b[^.]*\bto\b/i.test(
    task,
  );
}

function computeOptimizeVerb(task: string): boolean {
  return /\b(optimi[sz]e|improve|reduce|increase|decrease|speed up|lower|raise|minimi[sz]e|maximi[sz]e)\b/i.test(task);
}

function countStageKeywords(task: string): number {
  const lower = task.toLowerCase();
  const seen = new Set<string>();
  for (const kw of STAGE_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(lower)) seen.add(kw);
  }
  return seen.size;
}

function countSubsystemTouches(task: string, prdBody: string): number {
  const dirs = new Set<string>();
  const source = `${task}\n${prdBody}`;
  const re = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+)\/(?=[A-Za-z0-9_.*-]|\s|$|["'`)])/g;
  for (const m of source.matchAll(re)) {
    const seg = m[1];
    if (seg && seg !== "." && seg !== "..") dirs.add(seg.toLowerCase());
  }
  return dirs.size;
}

function detectAcShapeSmell(prdBody: string): boolean {
  if (!prdBody) return false;
  const lines = prdBody.split("\n");
  let inAc = false;
  let headline = "";
  let bulletsWithEndpoint = 0;
  const endpointRe = /(\/[A-Za-z0-9_{}:-]+)|(\b(GET|POST|PUT|PATCH|DELETE)\b)|(\b\w+\([^)]*\))/;
  const universalRe = /\b(all|every|for any|each)\b/i;

  const evaluate = (): boolean => {
    if (bulletsWithEndpoint >= 3 && !universalRe.test(headline)) return true;
    return false;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(raw) || /^\s*acceptance criteria\s*:?\s*$/i.test(raw)) {
      if (inAc && evaluate()) return true;
      inAc = /acceptance criteria/i.test(line);
      headline = line;
      bulletsWithEndpoint = 0;
      continue;
    }
    if (inAc) {
      if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        if (endpointRe.test(line)) bulletsWithEndpoint++;
      }
    }
  }
  return inAc && evaluate();
}

function detectMachineUncheckableAc(prdBody: string): boolean {
  if (!prdBody) return false;
  const lines = prdBody.split("\n");
  let inAc = false;
  const concreteRe = /(\/[A-Za-z0-9_{}:-]+)|\b\d{3}\b|\b[A-Z_]{3,}\b|\b\w+\([^)]*\)|\.[a-z]{2,4}\b|\d+\s*(%|ms|s|mb|kb)|verify:/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(raw)) {
      inAc = /acceptance criteria/i.test(line);
      continue;
    }
    if (inAc && (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line))) {
      if (!concreteRe.test(line)) return true;
    }
  }
  return false;
}

function computeSignals(input: CronenbergInput): CronenbergSignals {
  const { task, workingDir, rickgentDir, forward, diffLoc } = input;
  const prdPath = findPrdPath(workingDir, rickgentDir);
  const prdBody = prdPath ? safeRead(prdPath) : "";
  const PRD_PRESENT = prdPath !== null;
  const ALREADY_REFINED = detectAlreadyRefined(workingDir, rickgentDir);

  const refinedTickets = countRefinedTickets(workingDir, rickgentDir);
  const TICKET_COUNT = refinedTickets > 0 ? refinedTickets : inferTaskTicketCount(task);

  const MEASURABLE_METRIC = computeMeasurableMetric(task, forward);
  const OPTIMIZE_VERB = computeOptimizeVerb(task);
  const MULTI_STAGE = countStageKeywords(task) >= 2;
  const SUBSYSTEM_TOUCHES = countSubsystemTouches(task, prdBody);
  const INTERACTIVE_HINT = /\binteractive\b|watch me|step through/i.test(task) || forward.includes("--interactive");
  const AC_SHAPE_SMELL = detectAcShapeSmell(prdBody);
  const MACHINE_UNCHECKABLE_AC = detectMachineUncheckableAc(prdBody);
  const CLEANUP_TASK = /\b(cleanup|clean up|deslop|refactor sweep)\b/i.test(task);

  const CITADEL_RISK =
    (PRD_PRESENT && TICKET_COUNT >= 3) ||
    /\bconformance\b|acceptance criteria|spec compliance|audit against prd/i.test(task) ||
    (SUBSYSTEM_TOUCHES >= 2 && PRD_PRESENT);

  return {
    PRD_PRESENT,
    MEASURABLE_METRIC,
    OPTIMIZE_VERB,
    TICKET_COUNT,
    MULTI_STAGE,
    SUBSYSTEM_TOUCHES,
    INTERACTIVE_HINT,
    ALREADY_REFINED,
    AC_SHAPE_SMELL,
    MACHINE_UNCHECKABLE_AC,
    CITADEL_RISK,
    DIFF_LOC: diffLoc,
    CLEANUP_TASK,
  };
}

function selectMetaphor(s: CronenbergSignals): Metaphor {
  if (s.MEASURABLE_METRIC && s.OPTIMIZE_VERB) return "microverse";
  if (s.MULTI_STAGE) return "pipeline";
  if (s.TICKET_COUNT >= 3) return "build";
  return "build";
}

function decideRefine(
  s: CronenbergSignals,
  flags: CronenbergFlags,
  metaphor: Metaphor,
): { value: boolean; reason: string } {
  if (flags.noRefine) return { value: false, reason: "user --no-refine" };
  if (flags.refine) return { value: true, reason: "user --refine" };
  if (metaphor === "pipeline") return { value: false, reason: "skip-refine: pipeline chains refine internally" };
  if (!s.PRD_PRESENT) return { value: false, reason: "skip-refine: no PRD to refine" };
  if (s.ALREADY_REFINED) return { value: false, reason: "skip-refine: ALREADY_REFINED" };
  if (s.AC_SHAPE_SMELL) return { value: true, reason: "refine: AC_SHAPE_SMELL" };
  if (s.MACHINE_UNCHECKABLE_AC) return { value: true, reason: "refine: MACHINE_UNCHECKABLE_AC" };
  if (s.TICKET_COUNT >= 3) return { value: true, reason: "refine: TICKET_COUNT>=3" };
  if (s.SUBSYSTEM_TOUCHES >= 2) return { value: true, reason: "refine: SUBSYSTEM_TOUCHES>=2" };
  if (s.MULTI_STAGE) return { value: true, reason: "refine: MULTI_STAGE" };
  if (s.TICKET_COUNT <= 1 && s.SUBSYSTEM_TOUCHES <= 1) {
    return { value: false, reason: "skip-refine: single-file scope" };
  }
  return { value: true, reason: "refine: default (when in doubt, refine)" };
}

function buildMetaphorCommand(metaphor: Metaphor, task: string, prdPath: string | null, forward: string[]): PlannedCommand {
  const forwardFlags = forwardedFlags(forward);
  switch (metaphor) {
    case "microverse":
      return { label: "rickgent microverse", argv: ["microverse", "--task", task, ...forward] };
    case "pipeline":
      // `rickgent pipeline` takes a PRD *file path* as its positional, not a
      // task string. prdPath here is the effective PRD (an existing prd.md or
      // the materialized task PRD path) resolved by buildCronenbergPlan.
      return {
        label: "rickgent pipeline",
        argv: prdPath ? ["pipeline", prdPath, ...forwardFlags] : ["pipeline", ...forwardFlags],
      };
    case "build":
    default:
      return {
        label: "rickgent build",
        argv: prdPath ? ["build", prdPath, ...forwardFlags] : ["build", ...forwardFlags],
      };
  }
}

/** Keep every forwarded `--flag` and, when present, its immediately-following
 *  value (a token that does not itself start with `--`). Bare positional
 *  free-text tokens are dropped. This preserves flag-VALUE pairs so a forwarded
 *  `--repo /x` is never truncated to a bare `--repo`. */
function forwardedFlags(forward: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < forward.length; i++) {
    const tok = forward[i]!;
    if (!tok.startsWith("--")) continue;
    out.push(tok);
    const next = forward[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.push(next);
      i++;
    }
  }
  return out;
}

function renderTaskPrd(task: string): string {
  return `# Cronenberg Task\n\n${task}\n`;
}

function selectFollowups(
  s: CronenbergSignals,
  flags: CronenbergFlags,
  metaphor: Metaphor,
  prdPath: string | null,
  forward: string[],
): PlannedCommand[] {
  if (flags.noFollowups) return [];
  if (metaphor === "pipeline" || metaphor === "microverse") return [];

  const forwardFlags = forwardedFlags(forward);
  const followups: PlannedCommand[] = [];
  if (s.CITADEL_RISK && prdPath) {
    followups.push({ label: `rickgent citadel --prd ${prdPath}`, argv: ["citadel", "--prd", prdPath, ...forwardFlags] });
  } else if (s.CITADEL_RISK) {
    followups.push({ label: "rickgent citadel", argv: ["citadel", ...forwardFlags] });
  }
  if (s.SUBSYSTEM_TOUCHES >= 2) {
    followups.push({ label: "rickgent anatomy", argv: ["anatomy", ...forwardFlags] });
  }
  if (s.DIFF_LOC >= 500 || s.CLEANUP_TASK) {
    followups.push({ label: "rickgent szechuan", argv: ["szechuan", ...forwardFlags] });
  }
  return followups;
}

export function buildCronenbergPlan(input: CronenbergInput): CronenbergPlan {
  const task = input.task.trim();
  const prdPath = findPrdPath(input.workingDir, input.rickgentDir);

  const signals = computeSignals(input);

  if (task === "" && !signals.PRD_PRESENT) {
    return {
      ok: false,
      error: "Cronenberg needs a task or a PRD. Provide --task \"<goal>\" or add a prd.md (or run rickgent prd first).",
      task,
      prdPath,
      signals,
      metaphor: "build",
      followups: [],
      refine: { value: false, reason: "no input" },
      refinePrePass: null,
      metaphorCommand: { label: "rickgent build", argv: ["build"] },
      taskPrd: null,
    };
  }

  const metaphor = selectMetaphor(signals);
  const refine = decideRefine(signals, input.flags, metaphor);
  const followups = selectFollowups(signals, input.flags, metaphor, prdPath, input.forward);

  // The pipeline metaphor needs a PRD file that exists. When one is on disk we
  // hand its path through; otherwise the planner schedules a task PRD for the
  // runner to materialize and delegates with THAT path (never raw task text).
  const needsTaskPrd = metaphor === "pipeline" && prdPath === null && task !== "";
  const taskPrdPath = needsTaskPrd ? join(input.rickgentDir, "cronenberg-task.md") : null;
  const effectivePrdPath = prdPath ?? taskPrdPath;

  const metaphorCommand = buildMetaphorCommand(metaphor, task, effectivePrdPath, input.forward);
  const refinePrePass: PlannedCommand | null = refine.value
    ? {
        label: prdPath ? `rickgent refine ${prdPath}` : "rickgent refine",
        argv: prdPath
          ? ["refine", prdPath, ...forwardedFlags(input.forward)]
          : ["refine", ...forwardedFlags(input.forward)],
      }
    : null;

  const taskPrd = taskPrdPath ? { path: taskPrdPath, content: renderTaskPrd(task) } : null;

  return {
    ok: true,
    task,
    prdPath,
    signals,
    metaphor,
    followups,
    refine,
    refinePrePass,
    metaphorCommand,
    taskPrd,
  };
}

function yn(b: boolean): string {
  return b ? "y" : "n";
}

export function formatCronenbergPlan(plan: CronenbergPlan): string {
  const s = plan.signals;
  const lines: string[] = [];
  lines.push("Cronenberg — request mutated.");
  lines.push("");
  lines.push(`Task: ${plan.task === "" ? "(driven by PRD)" : plan.task}`);
  lines.push(
    `Signals: PRD=${yn(s.PRD_PRESENT)} refined=${yn(s.ALREADY_REFINED)} tickets=${s.TICKET_COUNT} ` +
      `multi-stage=${yn(s.MULTI_STAGE)} metric=${yn(s.MEASURABLE_METRIC)} subsystems=${s.SUBSYSTEM_TOUCHES} ` +
      `interactive=${yn(s.INTERACTIVE_HINT)} ac-smell=${yn(s.AC_SHAPE_SMELL)} uncheckable-ac=${yn(s.MACHINE_UNCHECKABLE_AC)} ` +
      `conformance=${yn(s.CITADEL_RISK)} diff-loc=${s.DIFF_LOC}`,
  );
  lines.push(`Refine decision: ${yn(plan.refine.value)} (${plan.refine.reason})`);
  lines.push(`metaphor: ${plan.metaphor}`);
  const followupLabels = plan.followups.map((f) => f.label);
  lines.push(`followups: [${followupLabels.join(", ")}]`);
  lines.push(`refine: ${plan.refine.value}`);
  lines.push("");
  lines.push("Plan:");
  let step = 1;
  if (plan.refinePrePass) {
    lines.push(`  ${step}. ${plan.refinePrePass.label}`);
    step++;
  }
  lines.push(`  ${step}. ${plan.metaphorCommand.label}${plan.task && plan.metaphor !== "microverse" ? "" : ""}`);
  step++;
  for (const f of plan.followups) {
    lines.push(`  ${step}. ${f.label}`);
    step++;
  }
  lines.push("");
  lines.push(
    "Cronenberg-only flags: --dry-run, --no-followups, --no-refine, --refine. All other flags forward to the chosen command.",
  );
  return lines.join("\n");
}
