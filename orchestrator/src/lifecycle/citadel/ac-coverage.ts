// AC coverage scorecard — maps each PRD acceptance criterion to the changed
// files that implement or exercise it, marking each as covered / partial /
// uncovered. An AC whose scope and verify-command target no file in the diff is
// uncovered.

import type { AcceptanceCriterion } from "../../core/prd.js";
import type { DiffSummary } from "./diff-walker.js";
import { slugify, toPosixPath } from "./reporter.js";
import type { RawFinding } from "./reporter.js";

const PATH_IN_CMD_RE = /[`']?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)[`']?/g;

/** Normalize a referenced path: convert to POSIX and strip a leading `./` so
 *  that `./src/a.ts` matches the diff path `src/a.ts`. */
function normalizeRefPath(p: string): string {
  return toPosixPath(p).replace(/^\.\//, "");
}

function referencedFiles(ac: AcceptanceCriterion): string[] {
  const out = new Set<string>();
  for (const s of ac.scope) out.add(normalizeRefPath(s));
  const cmd = ac.verifyCommand.replace(/^`+|`+$/g, "");
  for (const m of cmd.matchAll(PATH_IN_CMD_RE)) {
    const p = (m[1] ?? "").trim();
    if (p.includes("/") || p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".tsx") || p.endsWith(".jsx") || p.endsWith(".sh")) {
      out.add(normalizeRefPath(p));
    }
  }
  return [...out];
}

export interface AcCoverageRow {
  id: string;
  description: string;
  status: "covered" | "partial" | "uncovered";
  matchedFiles: string[];
  referencedFiles: string[];
}

export function buildAcCoverageScorecard(
  acceptanceCriteria: AcceptanceCriterion[],
  diff: DiffSummary,
): { findings: RawFinding[]; rows: AcCoverageRow[] } {
  const changedSet = new Set(diff.changedFiles.map((f) => normalizeRefPath(f.path)));
  const rows: AcCoverageRow[] = [];
  const findings: RawFinding[] = [];

  acceptanceCriteria.forEach((ac, i) => {
    const id = `AC-${i + 1}`;
    const refs = referencedFiles(ac);
    const matched = refs.filter((r) => changedSet.has(r));
    const status: AcCoverageRow["status"] =
      matched.length === 0 ? "uncovered" : matched.length < refs.length ? "partial" : "covered";
    rows.push({ id, description: ac.description, status, matchedFiles: matched, referencedFiles: refs });
    if (status === "uncovered") {
      findings.push({
        id: `ac-coverage:uncovered:${slugify(id)}`,
        rule: "ac-coverage:uncovered",
        severity: "High",
        file: "PRD",
        message: `${id} ("${ac.description}") is uncovered: none of its referenced files [${refs.join(", ")}] appear in the diff.`,
      });
    } else if (status === "partial") {
      findings.push({
        id: `ac-coverage:partial:${slugify(id)}`,
        rule: "ac-coverage:partial",
        severity: "Medium",
        file: "PRD",
        message: `${id} ("${ac.description}") is partially covered: matched [${matched.join(", ")}] of [${refs.join(", ")}].`,
      });
    }
  });

  return { findings, rows };
}
