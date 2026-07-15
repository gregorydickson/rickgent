// `rickgent citadel` CLI command — full 19-analyzer conformance audit.
// Pure deterministic JS analysis over git diff + PRD text. No agent subprocess.

import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { runCitadelAudit, renderTestStubs } from "./citadel/audit-runner.js";

const CITADEL_USAGE = `rickgent citadel — full 19-analyzer conformance audit

Usage:
  rickgent citadel --prd <path> [options]

Required:
  --prd <path>              PRD markdown file to audit against

Options:
  --diff <base..head>       Git diff range to walk (default: HEAD~1..HEAD)
  --strict                  Exit non-zero on High findings (default: only Critical)
  --report <path>           Write the JSON report to the given path
  --print-stubs             Print test skeletons for unguarded trap doors
  --repo <dir>              Target git repo (default: cwd)
  --help, -h                Show this help

Output: a versioned JSON report (schema "1.0") and a console summary grouped
by audit section. No agent subprocess is spawned — pure deterministic analysis.
`;

interface CitadelCliOptions {
  prdPath?: string;
  diffRange: string;
  strict: boolean;
  reportPath?: string;
  printStubs: boolean;
  repoRoot: string;
}

function parseArgs(rest: string[]): CitadelCliOptions | { error: string } {
  const opts: CitadelCliOptions = {
    diffRange: "HEAD~1..HEAD",
    strict: false,
    printStubs: false,
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--strict") {
      opts.strict = true;
    } else if (a === "--print-stubs") {
      opts.printStubs = true;
    } else if (a === "--prd") {
      const v = rest[++i];
      if (v !== undefined) opts.prdPath = v;
    } else if (a === "--diff") {
      const v = rest[++i];
      if (v !== undefined) opts.diffRange = v;
    } else if (a === "--report") {
      const v = rest[++i];
      if (v !== undefined) opts.reportPath = v;
    } else if (a === "--repo") {
      const v = rest[++i];
      if (v !== undefined) opts.repoRoot = v;
    } else if (!a.startsWith("--")) {
      if (!opts.prdPath) opts.prdPath = a;
    }
  }
  return opts;
}

function printSummary(report: ReturnType<typeof runCitadelAudit>["report"]): void {
  const lines: string[] = [
    "rickgent citadel — conformance audit",
    "=".repeat(50),
    `prd: ${report.prd_path}`,
    `diff: ${report.diff_range}`,
    `strict: ${report.strict}`,
    "",
  ];

  for (const [name, section] of Object.entries(report.analyzers)) {
    lines.push(`── ${name} ──`);
    if (section.skipped) {
      lines.push(`  skipped (${section.skipped}): ${section.reason ?? ""}`);
    } else if (section.findings.length === 0) {
      lines.push("  no findings");
    } else {
      for (const f of section.findings) {
        const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
        lines.push(`  [${f.severity}] ${f.rule}${loc} — ${f.message}`);
      }
    }
    lines.push("");
  }

  lines.push("=".repeat(50));
  const s = report.summary;
  lines.push(
    `summary: ${s.findings} findings (CRITICAL=${s.critical}, HIGH=${s.high}, MEDIUM=${s.medium}, LOW=${s.low}), ${s.unguarded_trap_doors} unguarded trap doors, ${report.skeptic_findings.length} skeptic (report-only)`,
  );
  if (report.unreadable_files.length > 0) {
    lines.push(`unreadable files:`);
    for (const u of report.unreadable_files) lines.push(`  - ${u.path}: ${u.error}`);
  }
  lines.push(`exit: ${report.exit_code}`);
  console.log(lines.join("\n"));
}

export async function runCitadelCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(CITADEL_USAGE);
    return;
  }

  const parsed = parseArgs(rest);
  if ("error" in parsed) {
    console.error(`rickgent citadel: ${parsed.error}`);
    process.exit(1);
  }

  if (!parsed.prdPath) {
    console.error("rickgent citadel: missing required --prd <path> flag");
    process.exit(1);
  }

  // Fail closed: invalid diff range / missing PRD surface as non-zero exit.
  let result: ReturnType<typeof runCitadelAudit>;
  try {
    result = runCitadelAudit({
      prdPath: parsed.prdPath,
      diffRange: parsed.diffRange,
      repoRoot: parsed.repoRoot,
      strict: parsed.strict,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`rickgent citadel: ${msg}`);
    process.exit(1);
  }

  if (parsed.reportPath) {
    const abs = resolve(parsed.reportPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(result.report, null, 2)}\n`, "utf-8");
  }

  if (parsed.printStubs) {
    const stubs = renderTestStubs(result.unguardedTrapDoors);
    if (stubs) console.log(stubs);
  }

  printSummary(result.report);

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
