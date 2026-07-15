// Citadel conformance-audit report model (schema 1.0) + finding dedup/ranking.
//
// Pure data shaping: analyzers emit RawFindings; the runner tags each with its
// source analyzer, dedups identical findings (merging source tags), and the
// reporter ranks by severity and computes the fail-closed exit code.

export type Severity = "Critical" | "High" | "Medium" | "Low";

export interface RawFinding {
  id: string;
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
}

export interface Finding extends RawFinding {
  sourceAnalyzer: string;
  sourceAnalyzers: string[];
}

export interface SectionResult {
  findings: RawFinding[];
  no_findings?: boolean;
  skipped?: string;
  reason?: string;
  [extra: string]: unknown;
}

export interface CitadelSummary {
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unguarded_trap_doors: number;
}

export interface CitadelReport {
  schema: "1.0";
  schema_version: "1.0";
  version: "1.0";
  generatedAt: string;
  prd_path: string;
  diff_range: string;
  strict: boolean;
  exit_code: number;
  analyzers: Record<string, SectionResult>;
  findings: Finding[];
  skeptic_findings: RawFinding[];
  decisions: unknown[];
  unreadable_files: Array<{ path: string; error: string }>;
  summary: CitadelSummary;
}

const SEVERITY_RANK: Record<Severity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

/** Merge findings with an identical (severity, file, line, rule) key, unioning
 *  the set of analyzers that produced each. */
export function dedupeFindings(
  tagged: Array<{ finding: RawFinding; analyzer: string }>,
): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const { finding, analyzer } of tagged) {
    const key = `${finding.severity}|${finding.file ?? ""}|${finding.line ?? ""}|${finding.rule}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.sourceAnalyzers.includes(analyzer)) {
        existing.sourceAnalyzers.push(analyzer);
      }
      continue;
    }
    byKey.set(key, {
      ...finding,
      sourceAnalyzer: analyzer,
      sourceAnalyzers: [analyzer],
    });
  }
  return [...byKey.values()].sort(compareFindings);
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

function count(findings: Finding[], severity: Severity): number {
  return findings.filter((f) => f.severity === severity).length;
}

export function computeExitCode(findings: Finding[], strict: boolean): number {
  const critical = count(findings, "Critical");
  const high = count(findings, "High");
  const blocking = critical + (strict ? high : 0);
  return blocking > 0 ? 1 : 0;
}

export function summarize(findings: Finding[]): CitadelSummary {
  return {
    findings: findings.length,
    critical: count(findings, "Critical"),
    high: count(findings, "High"),
    medium: count(findings, "Medium"),
    low: count(findings, "Low"),
    unguarded_trap_doors: findings.filter((f) => f.rule === "unguarded-trap-door").length,
  };
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

export const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.|-)test\.[cm]?[jt]sx?$|(?:\.|-)spec\.[cm]?[jt]sx?$/i;

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
