// Citadel audit runner — orchestrates all 19 analyzers in fail-soft wrappers,
// tags each finding with its source analyzer, deduplicates, and assembles the
// schema-1.0 report. Skeptic-lens findings are kept separate and never
// contribute to the exit code.

import { resolve } from "path";
import type { CitadelPrd } from "./prd-audit-parser.js";
import { parseCitadelPrd } from "./prd-audit-parser.js";
import { walkDiff } from "./diff-walker.js";
import type { DiffSummary } from "./diff-walker.js";
import { detectProjectShapes } from "./project-shape.js";
import { checkEndpointConformance } from "./endpoint-conformance.js";
import { auditTrapDoorCoverage, renderTestStubs, type TrapDoor } from "./trap-door.js";
import { auditStateTransitions } from "./state-transition.js";
import { buildAcCoverageScorecard } from "./ac-coverage.js";
import { runSkepticLens } from "./skeptic.js";
import { auditBannedConstructs, auditBannedCasts } from "./banned.js";
import {
  auditFrontendPropDrift,
  auditAcShape,
  auditDiffHygiene,
  auditSiblingAuth,
  auditRuleSetInvariants,
  auditSchemaRegistryDrift,
  auditTestAuthenticity,
  auditStaleReferences,
  auditCrossfileBehaviorDrift,
  auditPatternConformance,
} from "./misc-analyzers.js";
import {
  dedupeFindings,
  computeExitCode,
  summarize,
  type CitadelReport,
  type SectionResult,
  type RawFinding,
  type Finding,
} from "./reporter.js";

export interface AuditOptions {
  prdPath: string;
  diffRange: string;
  repoRoot?: string;
  strict?: boolean;
}

export interface AuditResult {
  report: CitadelReport;
  exitCode: number;
  unguardedTrapDoors: ReturnType<typeof auditTrapDoorCoverage>["unguarded"];
}

type AnalyzerRun = () => SectionResult;

function noFindings(): SectionResult {
  return { findings: [], no_findings: true };
}

function safeRun(name: string, run: AnalyzerRun): SectionResult {
  try {
    // Test-only hook: force one analyzer to throw to verify fail-soft behavior.
    if (process.env.RICKGENT_CITADEL_FORCE_THROW === name) {
      throw new Error("forced throw for test");
    }
    const result = run();
    if (!result || !Array.isArray(result.findings)) {
      return { findings: [], no_findings: true, skipped: "invalid_result", reason: `${name} returned no findings array` };
    }
    if (result.findings.length === 0 && result.no_findings === undefined && result.skipped === undefined) {
      result.no_findings = true;
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      findings: [],
      skipped: "error",
      reason: `${name}: ${message}`,
    };
  }
}

export function runCitadelAudit(options: AuditOptions): AuditResult {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const strict = options.strict === true;

  // Fail closed: missing PRD throws here (parseCitadelPrd reads the file).
  const prd: CitadelPrd = parseCitadelPrd(options.prdPath, repoRoot);

  // Fail closed: invalid diff range throws here (walkDiff runs git diff).
  const diff: DiffSummary = walkDiff(options.diffRange, repoRoot);

  const unreadableFiles: Array<{ path: string; error: string }> = [];
  const onUnreadable = (path: string, error: string): void => {
    unreadableFiles.push({ path, error });
  };

  const sections: Record<string, SectionResult> = {};
  const tagged: Array<{ finding: RawFinding; analyzer: string }> = [];

  const register = (name: string, run: AnalyzerRun, tag = true): SectionResult => {
    const result = safeRun(name, run);
    sections[name] = result;
    if (tag) {
      for (const f of result.findings) tagged.push({ finding: f, analyzer: name });
    }
    return result;
  };

  // 1. PRD parser (composes graph)
  register("prd-parser", () => ({
    findings: [],
    no_findings: true,
    composed: prd.composed,
    endpointCount: prd.endpoints.length,
    transitionCount: prd.transitions.length,
    acCount: prd.acceptanceCriteria.length,
  }), false);

  // 2. Diff walker
  register("diff-walker", () => ({
    findings: [],
    no_findings: true,
    changedFiles: diff.changedFiles.map((f) => ({ path: f.path, status: f.status, kind: f.kind })),
    claudeFiles: diff.claudeFiles,
  }), false);

  // 3. Project shape detection
  const shape = detectProjectShapes(repoRoot);
  register("project-shape-detection", () => ({
    findings: shape.findings.map((f) => ({
      id: `project-shape:${f.shape}`,
      rule: "project-shape",
      severity: "Low" as const,
      file: "package.json",
      message: `Detected project shape: ${f.shape} (${f.evidence})`,
    })),
    shapes: shape.shapes,
  }));

  // 4. Endpoint contract conformance
  register("endpoint-contract-conformance", () => {
    const r = checkEndpointConformance(prd.endpoints, diff);
    return { findings: r.findings, rows: r.rows };
  });

  // 5. Trap-door coverage (fail-soft via register)
  const trapDoorSection = register("trap-door-coverage", () => {
    const r = auditTrapDoorCoverage(diff);
    return { findings: r.findings, trapDoors: r.trapDoors, unguarded: r.unguarded };
  });
  const unguardedTrapDoors: TrapDoor[] =
    (trapDoorSection.unguarded as TrapDoor[] | undefined) ?? [];

  // 6. State-transition audit
  register("state-transition-audit", () => {
    const r = auditStateTransitions(prd.transitions, diff);
    return { findings: r.findings, rows: r.rows };
  });

  // 7. Frontend prop drift
  register("frontend-prop-drift", () => auditFrontendPropDrift(diff));

  // 8. AC shape audit
  register("ac-shape-audit", () => auditAcShape(prd));

  // 9. AC coverage scorecard
  register("ac-coverage-scorecard", () => {
    const r = buildAcCoverageScorecard(prd.acceptanceCriteria, diff);
    return { findings: r.findings, rows: r.rows };
  });

  // 10. Diff hygiene
  register("diff-hygiene", () => auditDiffHygiene(diff));

  // 11. Sibling auth
  register("sibling-auth", () => auditSiblingAuth(diff));

  // 12. Rule-set invariants
  register("rule-set-invariants", () => auditRuleSetInvariants(diff));

  // 13. Schema registry drift
  register("schema-registry-drift", () => auditSchemaRegistryDrift(diff));

  // 14. Test authenticity
  register("test-authenticity", () => auditTestAuthenticity(diff));

  // 15. Stale references
  register("stale-references", () => auditStaleReferences(diff));

  // 16. Crossfile behavior drift
  register("crossfile-behavior-drift", () => auditCrossfileBehaviorDrift(diff));

  // 17. Banned constructs + casts (combined)
  register("banned-constructs-casts", () => {
    const constructs = auditBannedConstructs(diff, onUnreadable);
    const casts = auditBannedCasts(diff, onUnreadable);
    return { findings: [...constructs.findings, ...casts.findings] };
  });

  // 18. Pattern conformance
  register("pattern-conformance", () => auditPatternConformance(diff));

  // 19. Skeptic lens (report-only — never tagged into blocking findings, fail-soft via register)
  register("skeptic-lens", () => runSkepticLens(diff), false);
  const skepticFindings: RawFinding[] =
    (sections["skeptic-lens"]?.findings as RawFinding[] | undefined) ?? [];

  const findings: Finding[] = dedupeFindings(tagged);
  const exitCode = computeExitCode(findings, strict);

  const report: CitadelReport = {
    schema: "1.0",
    schema_version: "1.0",
    version: "1.0",
    generatedAt: new Date().toISOString(),
    prd_path: options.prdPath,
    diff_range: options.diffRange,
    strict,
    exit_code: exitCode,
    analyzers: sections,
    findings,
    skeptic_findings: skepticFindings,
    decisions: [],
    unreadable_files: unreadableFiles,
    summary: summarize(findings),
  };

  return { report, exitCode, unguardedTrapDoors };
}

export { renderTestStubs };
