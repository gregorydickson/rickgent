// Convergence gate — baseline subtraction, freshness assertion, scope filtering.
// PURE decision functions over gate outputs and baseline data.

import { isPathInScope } from "./scope.js";

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
}

export interface GateInput {
  /** Current gate check results. */
  current: CheckResult[];
  /** Baseline gate check results (used for staleness detection). */
  baseline: CheckResult[];
  /** Baseline findings to subtract from current findings.
   *  Stored as Finding objects so the comparison uses the same
   *  `${file}:${line}:${message}` key on both sides (C3). */
  baselineFindings?: Finding[];
  /** Ticket declared scope paths. */
  scope: string[];
  /** Candidate findings to filter. */
  findings: Finding[];
}

export interface Finding {
  file: string;
  line: number;
  message: string;
  check: string;
}

export interface GateVerdict {
  passed: boolean;
  failures: string[];
  staleBaseline: boolean;
  newFindings: Finding[];
}

export function evaluateConvergenceGate(input: GateInput): GateVerdict {
  // AC-16: Fail closed on malformed input
  if (input == null || typeof input !== "object") {
    return { passed: false, failures: ["invalid input"], staleBaseline: true, newFindings: [] };
  }

  // Coerce array fields with defaults — missing/wrong types fail closed
  const current: CheckResult[] = Array.isArray(input.current) ? input.current : [];
  const baseline: CheckResult[] = Array.isArray(input.baseline) ? input.baseline : [];
  const baselineFindings: Finding[] = Array.isArray(input.baselineFindings) ? input.baselineFindings : [];
  const scope: string[] = Array.isArray(input.scope) ? input.scope : [];
  const findings: Finding[] = Array.isArray(input.findings) ? input.findings : [];

  // 1. Assert baseline is fresh (R-SZGB: zero checks = stale baseline)
  const staleBaseline = baseline.length === 0 || isBaselineStale(baseline, current);

  // 2. Subtract baseline findings — both sides now use Finding objects keyed
  //    by `${file}:${line}:${message}`, so subtraction actually matches (C3).
  const newFindings = subtractBaseline(findings, baselineFindings);

  // 3. Filter by scope
  const scopedFindings = filterByScope(newFindings, scope);

  // 4. Check if all current checks pass
  const failures = current
    .filter((c) => !c.passed)
    .map((c) => `${c.name}: ${c.output}`);

  // Silence is not success: if zero checks ran, that's a failure
  if (current.length === 0) {
    failures.push("no checks executed — silence is not success");
  }

  return {
    passed: failures.length === 0 && !staleBaseline && scopedFindings.length === 0,
    failures,
    staleBaseline,
    newFindings: scopedFindings,
  };
}

function isBaselineStale(baseline: CheckResult[], current: CheckResult[]): boolean {
  if (baseline.length === 0) return true;
  const baselineNames = new Set(baseline.map((c) => c.name));
  const currentNames = new Set(current.map((c) => c.name));
  // If the set of checks changed, baseline is stale
  for (const name of currentNames) {
    if (!baselineNames.has(name)) return true;
  }
  for (const name of baselineNames) {
    if (!currentNames.has(name)) return true;
  }
  return false;
}

function subtractBaseline(findings: Finding[], baselineFindings: Finding[]): Finding[] {
  // Only NEW findings count — findings that exist in the baseline are subtracted.
  // C3: build the baseline set from Finding objects using the same
  // `${file}:${line}:${message}` key the current findings are matched against.
  // The previous implementation built keys from raw CheckResult.output lines,
  // which never matched the structured finding keys (effective no-op).
  const baselineKeys = new Set(
    baselineFindings.map((f) => `${f.file}:${f.line}:${f.message}`),
  );
  return findings.filter((f) => !baselineKeys.has(`${f.file}:${f.line}:${f.message}`));
}

function filterByScope(findings: Finding[], scope: string[]): Finding[] {
  if (scope.length === 0) return findings;
  return findings.filter((f) =>
    scope.some((s) => isPathInScope(f.file, s)),
  );
}
