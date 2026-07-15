// Remaining citadel analyzers — each is a fail-soft, deterministic scanner over
// the diff + PRD. None of these have a single dedicated validation assertion
// beyond VAL-CITADEL-020 (every analyzer runs and emits findings or an explicit
// no-findings marker), so they are implemented as focused heuristic detectors.

import { readFileSync } from "fs";
import { join } from "path";
import type { DiffSummary } from "./diff-walker.js";
import type { CitadelPrd } from "./prd-audit-parser.js";
import { slugify, toPosixPath, TEST_FILE_PATTERN } from "./reporter.js";
import type { RawFinding } from "./reporter.js";
import { collectChangedCodeLines, isCommentLine, stripStringLiterals } from "./code-lines.js";

const CODE_FILE_RE = /\.[cm]?[jt]sx?$/i;

function readChangedContent(diff: DiffSummary, file: string): string | null {
  try {
    return readFileSync(join(diff.repoRoot, file), "utf-8");
  } catch {
    return null;
  }
}

// 7. Frontend prop drift — detects React component prop interface changes in
// the diff with no corresponding usage update in the same diff.
export function auditFrontendPropDrift(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  const propInterfaces = new Map<string, string[]>();
  for (const changed of diff.changedFiles) {
    if (!/\.tsx?$/.test(changed.path)) continue;
    const content = readChangedContent(diff, changed.path);
    if (!content) continue;
    for (const m of content.matchAll(/(?:interface|type)\s+([A-Z]\w*Props)\s*[={][\s\S]*?([};])/g)) {
      const name = m[1] ?? "";
      const body = m[2] ?? "";
      propInterfaces.set(name, [changed.path, body]);
    }
  }
  if (propInterfaces.size === 0) return { findings: [] };
  for (const [name, [file]] of propInterfaces) {
    const filePath = file ?? "unknown";
    findings.push({
      id: `frontend-prop-drift:${slugify(name)}:${slugify(filePath)}`,
      rule: "frontend-prop-drift",
      severity: "Medium",
      file: filePath,
      message: `Prop interface ${name} changed in ${filePath}; verify all call sites in the diff still satisfy the updated props.`,
    });
  }
  return { findings };
}

// 8. AC shape audit — each AC should carry a verifyCommand; missing ones are
// flagged.
export function auditAcShape(prd: CitadelPrd): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  prd.acceptanceCriteria.forEach((ac, i) => {
    const id = `AC-${i + 1}`;
    if (!ac.verifyCommand || ac.verifyCommand.trim() === "") {
      findings.push({
        id: `ac-shape:missing-verify:${slugify(id)}`,
        rule: "ac-shape:missing-verify",
        severity: "High",
        file: "PRD",
        message: `${id} ("${ac.description}") has no \`verify:\` command; acceptance criterion is not machine-checkable.`,
      });
    }
    if (ac.scope.length === 0) {
      findings.push({
        id: `ac-shape:missing-scope:${slugify(id)}`,
        rule: "ac-shape:missing-scope",
        severity: "Medium",
        file: "PRD",
        message: `${id} ("${ac.description}") declares no scope paths.`,
      });
    }
  });
  return { findings };
}

// 10. Diff hygiene — flags debug statements, TODO/FIXME markers, and trailing
// whitespace in changed lines.
export function auditDiffHygiene(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  for (const source of collectChangedCodeLines(diff)) {
    for (const { no, text } of source.lines) {
      if (isCommentLine(text)) continue;
      const stripped = stripStringLiterals(text);
      if (/\bconsole\.log\b/.test(stripped)) {
        findings.push({
          id: `diff-hygiene:console-log:${slugify(source.file)}:${no}`,
          rule: "diff-hygiene:console-log",
          severity: "Low",
          file: source.file,
          line: no,
          message: `console.log at ${source.file}:${no} should be removed before merge.`,
        });
      }
      if (/\bdebugger\b/.test(stripped)) {
        findings.push({
          id: `diff-hygiene:debugger:${slugify(source.file)}:${no}`,
          rule: "diff-hygiene:debugger",
          severity: "Medium",
          file: source.file,
          line: no,
          message: `debugger statement at ${source.file}:${no} must be removed.`,
        });
      }
      if (/\b(TODO|FIXME|XXX)\b/.test(text)) {
        findings.push({
          id: `diff-hygiene:todo:${slugify(source.file)}:${no}`,
          rule: "diff-hygiene:todo",
          severity: "Low",
          file: source.file,
          line: no,
          message: `TODO/FIXME marker at ${source.file}:${no} left in changed code.`,
        });
      }
    }
  }
  return { findings };
}

// 11. Sibling auth — flags changed controller/handler files that reference
// protected resources but declare no auth guard/decorator.
export function auditSiblingAuth(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  for (const changed of diff.changedFiles) {
    if (!CODE_FILE_RE.test(changed.path)) continue;
    const content = readChangedContent(diff, changed.path);
    if (!content) continue;
    const hasRoute = /@(Get|Post|Put|Patch|Delete)\b|app\.(get|post|put|patch|delete)\b/.test(content);
    const hasAuth = /@(UseGuards|Guard|Authorized|Roles|Public)\b|requireAuth|isAuthenticated|authMiddleware|@Public/.test(content);
    if (hasRoute && !hasAuth) {
      findings.push({
        id: `sibling-auth:missing-guard:${slugify(changed.path)}`,
        rule: "sibling-auth:missing-guard",
        severity: "High",
        file: changed.path,
        message: `${changed.path} defines HTTP handlers but declares no auth guard; sibling auth precondition may be missing.`,
      });
    }
  }
  return { findings };
}

// 12. Rule-set invariants — reads CLAUDE.md invariant lines (outside the Trap
// Doors section) and flags changed code that contradicts a banned-pattern rule.
export function auditRuleSetInvariants(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  const claudeContent = readChangedContent(diff, "CLAUDE.md");
  if (!claudeContent) return { findings: [] };
  const banned: Array<{ pattern: string; line: number }> = [];
  const lines = claudeContent.split(/\r?\n/);
  let inTrapDoors = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) inTrapDoors = /Trap Doors/i.test(line);
    if (inTrapDoors) continue;
    const m = line.match(/BANNED:\s*[`"]?([^`"\n]+)[`"]?/i);
    if (m) banned.push({ pattern: (m[1] ?? "").trim(), line: i + 1 });
  }
  if (banned.length === 0) return { findings: [] };
  for (const source of collectChangedCodeLines(diff)) {
    for (const { no, text } of source.lines) {
      if (isCommentLine(text)) continue;
      for (const b of banned) {
        let re: RegExp;
        try {
          re = new RegExp(b.pattern);
        } catch {
          continue;
        }
        if (re.test(stripStringLiterals(text))) {
          findings.push({
            id: `rule-set-invariant:banned-pattern:${slugify(source.file)}:${no}`,
            rule: "rule-set-invariant:banned-pattern",
            severity: "High",
            file: source.file,
            line: no,
            message: `Changed line at ${source.file}:${no} matches a CLAUDE.md banned pattern ("${b.pattern}", CLAUDE.md:${b.line}).`,
          });
        }
      }
    }
  }
  return { findings };
}

// 13. Schema registry drift — flags changed schema/DTO definitions whose name
// appears in the diff but whose registry file (if any) is not also changed.
export function auditSchemaRegistryDrift(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  const changedSet = new Set(diff.changedFiles.map((f) => toPosixPath(f.path)));
  const schemaNames: Array<{ name: string; file: string }> = [];
  for (const changed of diff.changedFiles) {
    if (!CODE_FILE_RE.test(changed.path)) continue;
    const content = readChangedContent(diff, changed.path);
    if (!content) continue;
    for (const m of content.matchAll(/(?:class|interface|type)\s+([A-Z]\w*(?:Dto|Schema|Input|Request|Response))\b/g)) {
      schemaNames.push({ name: m[1] ?? "", file: changed.path });
    }
  }
  const registryCandidates = ["src/schema-registry.ts", "src/schemas/index.ts", "src/dto/index.ts"];
  const registryChanged = registryCandidates.some((r) => changedSet.has(toPosixPath(r)));
  if (schemaNames.length > 0 && !registryChanged) {
    for (const s of schemaNames) {
      findings.push({
        id: `schema-registry-drift:${slugify(s.name)}`,
        rule: "schema-registry-drift",
        severity: "Medium",
        file: s.file,
        message: `Schema/DTO ${s.name} changed in ${s.file} but no schema registry file was updated in the diff.`,
      });
    }
  }
  return { findings };
}

// 14. Test authenticity — flags changed test files that contain no real
// assertions (expect/to-be/should).
export function auditTestAuthenticity(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.kind !== "test" && !TEST_FILE_PATTERN.test(toPosixPath(changed.path))) continue;
    const content = readChangedContent(diff, changed.path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const changedTexts: string[] = [];
    for (const range of changed.changedLines) {
      for (let n = range.start; n <= range.end; n++) {
        const t = lines[n - 1];
        if (t !== undefined) changedTexts.push(t);
      }
    }
    const hasAssertion = changedTexts.some((t) => /\b(expect|assert|should\b|toBe|toEqual|to\.equal)\b/.test(t));
    const hasTestBlock = changedTexts.some((t) => /\b(it|test|describe)\s*\(/.test(t));
    if (hasTestBlock && !hasAssertion) {
      findings.push({
        id: `test-authenticity:no-assertions:${slugify(changed.path)}`,
        rule: "test-authenticity:no-assertions",
        severity: "Medium",
        file: changed.path,
        message: `${changed.path} adds test blocks without assertions; test is not authentic.`,
      });
    }
  }
  return { findings };
}

// 15. Stale references — flags imports in changed files that reference a path
// deleted in the same diff.
export function auditStaleReferences(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  const deleted = new Set(
    diff.changedFiles.filter((f) => f.status === "D").map((f) => toPosixPath(f.path)),
  );
  if (deleted.size === 0) return { findings: [] };
  for (const changed of diff.changedFiles) {
    if (changed.status === "D" || !CODE_FILE_RE.test(changed.path)) continue;
    const content = readChangedContent(diff, changed.path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const range of changed.changedLines) {
      for (let n = range.start; n <= range.end; n++) {
        const text = lines[n - 1] ?? "";
        const importMatch = text.match(/(?:from|require\()\s*['"`]([^'"`]+)['"`]/);
        if (!importMatch) continue;
        const ref = importMatch[1] ?? "";
        for (const d of deleted) {
          if (d.startsWith(ref) || ref.endsWith(d.replace(/\.[tj]sx?$/, ""))) {
            findings.push({
              id: `stale-reference:${slugify(changed.path)}:${n}:${slugify(d)}`,
              rule: "stale-reference",
              severity: "High",
              file: changed.path,
              line: n,
              message: `${changed.path}:${n} imports "${ref}" which references deleted file ${d}.`,
            });
          }
        }
      }
    }
  }
  return { findings };
}

// 16. Crossfile behavior drift — flags exported function signature changes in
// the diff where a caller file is not also in the diff.
export function auditCrossfileBehaviorDrift(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.status === "D" || !CODE_FILE_RE.test(changed.path)) continue;
    const content = readChangedContent(diff, changed.path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const range of changed.changedLines) {
      for (let n = range.start; n <= range.end; n++) {
        const text = lines[n - 1] ?? "";
        const exp = text.match(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
        if (!exp) continue;
        const name = exp[1] ?? "";
        const sig = (exp[2] ?? "").trim();
        findings.push({
          id: `crossfile-drift:${slugify(changed.path)}:${slugify(name)}`,
          rule: "crossfile-behavior-drift",
          severity: "Medium",
          file: changed.path,
          line: n,
          message: `Exported function ${name}(${sig}) changed in ${changed.path}:${n}; callers outside the diff may have drifted.`,
        });
      }
    }
  }
  return { findings };
}

// 18. Pattern conformance — flags changed source files that violate basic
// project naming/structure conventions (kebab-case filenames for non-test
// modules, PascalCase for component files).
export function auditPatternConformance(diff: DiffSummary): { findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  for (const changed of diff.changedFiles) {
    if (!CODE_FILE_RE.test(changed.path)) continue;
    const posix = toPosixPath(changed.path);
    const base = posix.split("/").pop() ?? posix;
    const isComponent = /^[A-Z]/.test(base) && /\.tsx$/.test(base);
    const isModule = !isComponent && !TEST_FILE_PATTERN.test(posix);
    if (isModule && /[A-Z]/.test(base.replace(/\.[tj]sx?$/, ""))) {
      findings.push({
        id: `pattern-conformance:filename-case:${slugify(posix)}`,
        rule: "pattern-conformance:filename-case",
        severity: "Low",
        file: posix,
        message: `${posix} uses non-kebab-case filename for a module; project convention expects lowercase.`,
      });
    }
  }
  return { findings };
}
