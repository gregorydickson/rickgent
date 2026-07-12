// Convergence gate — baseline subtraction, freshness assertion, scope filtering.
// PURE decision functions over gate outputs and baseline data.

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
}

export interface GateInput {
  /** Current gate check results. */
  current: CheckResult[];
  /** Baseline gate check results. */
  baseline: CheckResult[];
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
  // 1. Assert baseline is fresh (R-SZGB: zero checks = stale baseline)
  const staleBaseline = input.baseline.length === 0 || isBaselineStale(input.baseline, input.current);

  // 2. Subtract baseline findings
  const newFindings = subtractBaseline(input.findings, input.baseline);

  // 3. Filter by scope
  const scopedFindings = filterByScope(newFindings, input.scope);

  // 4. Check if all current checks pass
  const failures = input.current
    .filter((c) => !c.passed)
    .map((c) => `${c.name}: ${c.output}`);

  // Silence is not success: if zero checks ran, that's a failure
  if (input.current.length === 0) {
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

function subtractBaseline(findings: Finding[], baseline: CheckResult[]): Finding[] {
  // Only NEW findings count — findings that exist in the baseline are subtracted
  const baselineMessages = new Set(
    baseline.flatMap((c) => c.output.split("\n").map((l) => l.trim()).filter(Boolean)),
  );
  return findings.filter((f) => !baselineMessages.has(`${f.file}:${f.line}:${f.message}`));
}

function filterByScope(findings: Finding[], scope: string[]): Finding[] {
  if (scope.length === 0) return findings;
  return findings.filter((f) =>
    scope.some((s) => f.file.startsWith(s)),
  );
}
