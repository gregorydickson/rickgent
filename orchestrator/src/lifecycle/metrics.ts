// B9 — SQLite lifecycle metrics plus explicitly legacy diagnostics.
//
// Canonical run and delivery counts come only from the read-only SQLite state
// observation. The historical JSONL files below lack canonical run/attempt/
// delivery lineage and are therefore reported in a separate diagnostic section
// that cannot be mistaken for lifecycle truth.
//
// Legacy diagnostics retain two historical computations:
//
//   (a) interventions/run — the historical autonomy metric (target 0).
//       Earlier toolbelt versions appended `.rickgent/interventions.jsonl` and
//       `.rickgent/runs.jsonl`; current lifecycle callers never write them.
//       Metrics may still read them, but labels the result diagnostic-only.
//
//   (b) rolling matured-PR quality (target 99%, Mission 1 §5.4). PR quality % =
//       1 − (defective / shipped), measured over MATURED PRs only. The quality
//       denominator (matured PRs), the defective count, and late-defect
//       reopening are computed from the durable PR ledger (.rickgent/prs.jsonl)
//       and defect ledger (.rickgent/defects.jsonl) — never hardcoded constants.
//       A PR shipped within the maturity window is IMMATURE and is excluded
//       from the denominator. A defect recorded against a matured PR reopens it
//       as defective — including LATE defects detected after the PR matured
//       (the rolling metric reopens the historical record).
//
// Maturity window: 14 days (Mission 1 §5.4: "the 14-day window is the maturity
// window before a PR enters the main quality denominator, not an expiry date:
// late defects reopen the historical record"). Recorded in
// docs/decisions/metrics.md. Overridable via RICKGENT_MATURITY_WINDOW_DAYS only
// for test determinism; the production default is the decision-doc constant.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { observeState, type StateObservation } from "../state/store.js";

/** Maturity window (days) before a shipped PR enters the quality denominator. */
export const DEFAULT_MATURITY_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

export function runLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "runs.jsonl");
}

export function interventionLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "interventions.jsonl");
}

export function prLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "prs.jsonl");
}

export function defectLedgerPath(rickgentDir: string): string {
  return join(rickgentDir, "defects.jsonl");
}

// ── Ledger record shapes ────────────────────────────────────────────────────

export interface RunRecord {
  runId: string;
  startedAt: string;
  prdTitle: string;
}

export interface PrRecord {
  prId: string;
  runId: string;
  branch: string;
  title: string;
  repo: string;
  /** ISO timestamp the PR was shipped (maturity is measured from here). */
  shippedAt: string;
  /** Declared scope paths for the PR (traceability to the defect ledger). */
  scopePaths: string[];
}

export interface DefectRecord {
  defectId: string;
  /** PR this defect is attributed to (links into the PR ledger). */
  prId: string;
  scopePath: string;
  /** ISO timestamp the defect was detected. A defect detected after the PR
   * matured is a LATE defect and reopens the PR as defective. */
  detectedAt: string;
  adjudicationNote: string;
}

// ── Record helpers (append-only JSONL) ──────────────────────────────────────

/** @deprecated Legacy diagnostic writer; never lifecycle authority. */
export function recordRun(rickgentDir: string, runId: string, prdTitle: string): void {
  mkdirSync(rickgentDir, { recursive: true });
  const rec: RunRecord = { runId, startedAt: new Date().toISOString(), prdTitle };
  appendFileSync(runLedgerPath(rickgentDir), JSON.stringify(rec) + "\n");
}

/** @deprecated Legacy diagnostic writer; never delivery authority. */
export function recordPr(rickgentDir: string, pr: PrRecord): void {
  mkdirSync(rickgentDir, { recursive: true });
  appendFileSync(prLedgerPath(rickgentDir), JSON.stringify(pr) + "\n");
}

/** @deprecated Legacy diagnostic writer; never adjudication authority. */
export function recordDefect(rickgentDir: string, defect: DefectRecord): void {
  mkdirSync(rickgentDir, { recursive: true });
  appendFileSync(defectLedgerPath(rickgentDir), JSON.stringify(defect) + "\n");
}

// ── Ledger readers ──────────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip a malformed line rather than crashing metrics (fail soft on read;
      // the ledger is append-only and a corrupt line must not wedge reporting).
    }
  }
  return out;
}

function parseIso(s: unknown): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ── Metrics computation ─────────────────────────────────────────────────────

export interface MetricsResult {
  /** Total runs (distinct run records in the runs ledger). */
  runs: number;
  /** Total human-gate interventions recorded. */
  interventions: number;
  /** interventions / runs (when runs > 0); else the raw intervention count. */
  interventionsPerRun: number;
  /** The maturity window (days) used for the matured-PR denominator. */
  maturityWindowDays: number;
  /** Total shipped PRs in the PR ledger. */
  shippedPrs: number;
  /** Shipped PRs past the maturity window (the quality denominator). */
  maturedPrs: number;
  /** Shipped PRs still within the maturity window (excluded from denominator). */
  immaturePrs: number;
  /** Matured PRs with at least one attributed defect (incl. late defects). */
  defectiveMaturedPrs: number;
  /** Alias of maturedPrs — the rolling quality denominator. */
  qualityDenominator: number;
  /** 1 − defective/matured as a percentage, or null when denominator is 0. */
  qualityPct: number | null;
  /** Defects on matured PRs detected AFTER the PR matured (late reopening). */
  lateDefectsReopened: number;
}

/**
 * Compute legacy JSONL diagnostics. These values are useful historical signals
 * but do not represent canonical lifecycle state. `now` is injectable for
 * deterministic tests; the production path uses `new Date()`.
 */
export function computeMetrics(
  rickgentDir: string,
  now: Date = new Date(),
  maturityWindowDays: number = DEFAULT_MATURITY_WINDOW_DAYS,
): MetricsResult {
  const nowMs = now.getTime();
  const maturityMs = maturityWindowDays * DAY_MS;

  // ── interventions/run ────────────────────────────────────────────────────
  const runs = readJsonl<RunRecord>(runLedgerPath(rickgentDir));
  const distinctRunIds = new Set<string>();
  for (const r of runs) {
    if (typeof r.runId === "string" && r.runId.length > 0) distinctRunIds.add(r.runId);
  }
  const interventions = readJsonl<unknown>(interventionLedgerPath(rickgentDir)).length;
  const runCount = distinctRunIds.size;
  const interventionsPerRun = runCount > 0 ? interventions / runCount : interventions;

  // ── matured-PR quality ─────────────────────────────────────────────────────
  const prs = readJsonl<PrRecord>(prLedgerPath(rickgentDir));
  const defects = readJsonl<DefectRecord>(defectLedgerPath(rickgentDir));

  // Index defects by prId.
  const defectsByPr = new Map<string, DefectRecord[]>();
  for (const d of defects) {
    if (typeof d.prId !== "string") continue;
    const arr = defectsByPr.get(d.prId) ?? [];
    arr.push(d);
    defectsByPr.set(d.prId, arr);
  }

  let maturedPrs = 0;
  let immaturePrs = 0;
  let defectiveMaturedPrs = 0;
  let lateDefectsReopened = 0;

  for (const pr of prs) {
    const shippedMs = parseIso(pr.shippedAt);
    // An unparseable shippedAt cannot be proven mature → fail closed: count it
    // as immature (excluded from the quality denominator).
    const matured = shippedMs !== null && nowMs - shippedMs >= maturityMs;
    if (!matured) {
      immaturePrs++;
      continue;
    }
    maturedPrs++;
    const prDefects = defectsByPr.get(pr.prId) ?? [];
    if (prDefects.length > 0) {
      defectiveMaturedPrs++;
      // A defect detected after the PR matured is a LATE defect that reopens
      // the historical record.
      for (const d of prDefects) {
        const detectedMs = parseIso(d.detectedAt);
        if (detectedMs !== null && detectedMs > shippedMs! + maturityMs) {
          lateDefectsReopened++;
        }
      }
    }
  }

  const qualityDenominator = maturedPrs;
  const qualityPct =
    qualityDenominator > 0
      ? ((1 - defectiveMaturedPrs / qualityDenominator) * 100)
      : null;

  return {
    runs: runCount,
    interventions,
    interventionsPerRun,
    maturityWindowDays,
    shippedPrs: prs.length,
    maturedPrs,
    immaturePrs,
    defectiveMaturedPrs,
    qualityDenominator,
    qualityPct,
    lateDefectsReopened,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** Human-readable report (printed by `rickgent metrics`). */
export function formatMetricsReport(m: MetricsResult): string {
  const qualityStr = m.qualityPct === null ? "N/A (no matured PRs)" : `${m.qualityPct.toFixed(1)}%`;
  const lines: string[] = [
    "legacy JSONL diagnostics — autonomy + quality (non-authoritative)",
    "=".repeat(56),
    `runs:                    ${m.runs}`,
    `interventions:           ${m.interventions}`,
    `interventions/run:       ${m.interventionsPerRun}  (target 0)`,
    "-".repeat(56),
    `maturity window (days):  ${m.maturityWindowDays}`,
    `shipped PRs:             ${m.shippedPrs}`,
    `  matured:               ${m.maturedPrs}  (quality denominator)`,
    `  immature:              ${m.immaturePrs}  (excluded from denominator)`,
    `defective matured PRs:   ${m.defectiveMaturedPrs}`,
    `late defects reopened:   ${m.lateDefectsReopened}`,
    `rolling matured-PR quality: ${qualityStr}  (target 99%)`,
    "=".repeat(56),
  ];
  return lines.join("\n");
}

export interface MetricsOutput {
  report: string;
  json: string;
  authoritative: AuthoritativeMetrics;
  legacyDiagnostics: LegacyDiagnosticMetrics;
}

export interface AuthoritativeMetrics {
  readonly source: "sqlite";
  readonly availability: StateObservation["state"];
  readonly repositoryId: string;
  readonly databasePath: string;
  readonly schemaVersion: number | null;
  /** Null means the canonical database is absent; it must not be reported as zero. */
  readonly runs: number | null;
  readonly deliveryRecords: number | null;
  readonly delivered: number | null;
  readonly deliveryFailed: number | null;
}

export interface LegacyDiagnosticMetrics {
  readonly source: "legacy_jsonl";
  readonly trust: "diagnostic_only";
  readonly metrics: MetricsResult;
}

function authoritativeProjection(observation: StateObservation): AuthoritativeMetrics {
  if (observation.state === "absent") {
    return Object.freeze({
      source: "sqlite" as const,
      availability: "absent" as const,
      repositoryId: observation.repositoryId,
      databasePath: observation.databasePath,
      schemaVersion: null,
      runs: null,
      deliveryRecords: null,
      delivered: null,
      deliveryFailed: null,
    });
  }
  return Object.freeze({
    source: "sqlite" as const,
    availability: "present" as const,
    repositoryId: observation.repositoryId,
    databasePath: observation.databasePath,
    schemaVersion: observation.schemaVersion,
    runs: observation.aggregates.runs,
    deliveryRecords: observation.aggregates.deliveryRecords,
    delivered: observation.aggregates.delivered,
    deliveryFailed: observation.aggregates.deliveryFailed,
  });
}

function formatAuthoritativeMetrics(metrics: AuthoritativeMetrics): string {
  const value = (count: number | null): string => count === null ? "N/A (state absent)" : String(count);
  return [
    "rickgent metrics — canonical lifecycle projection",
    "=".repeat(56),
    `source:                   ${metrics.source}`,
    `availability:             ${metrics.availability}`,
    `runs:                    ${value(metrics.runs)}`,
    `delivery records:        ${value(metrics.deliveryRecords)}`,
    `delivered:               ${value(metrics.delivered)}`,
    `delivery failed:         ${value(metrics.deliveryFailed)}`,
    "=".repeat(56),
  ].join("\n");
}

/**
 * Observe canonical SQLite state under `repoPath`, then separately read legacy
 * diagnostics under `rickgentDir`. The two projections are never flattened or
 * merged, so a JSONL claim cannot manufacture an authoritative count.
 * The maturity window defaults to the decision-doc constant (14 days) and is
 * overridable via RICKGENT_MATURITY_WINDOW_DAYS for test determinism.
 */
export function runMetrics(
  repoPath: string,
  rickgentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): MetricsOutput {
  const overrideRaw = env.RICKGENT_MATURITY_WINDOW_DAYS;
  let maturityWindowDays = DEFAULT_MATURITY_WINDOW_DAYS;
  if (typeof overrideRaw === "string" && overrideRaw.length > 0) {
    const n = Number(overrideRaw);
    if (!Number.isNaN(n) && n >= 0) maturityWindowDays = n;
  }
  const authoritative = authoritativeProjection(observeState(repoPath));
  const legacyDiagnostics = Object.freeze({
    source: "legacy_jsonl" as const,
    trust: "diagnostic_only" as const,
    metrics: computeMetrics(rickgentDir, new Date(), maturityWindowDays),
  });
  const jsonProjection = Object.freeze({ authoritative, legacyDiagnostics });
  return {
    report: `${formatAuthoritativeMetrics(authoritative)}\n\n${formatMetricsReport(legacyDiagnostics.metrics)}`,
    json: JSON.stringify(jsonProjection),
    authoritative,
    legacyDiagnostics,
  };
}
