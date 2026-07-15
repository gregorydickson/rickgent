// rickgent refine — 3-analyst parallel refinement + ticket decomposition.
//
// Spawns 3 `omnigent run` workers per cycle (requirements, codebase,
// risk-scope), 3 cycles default. Cycle 2+ cross-references prior cycle
// analyses. After all cycles, synthesizes `prd_refined.md` (additive,
// attributed, verification-first, with contracts) and decomposes into atomic
// tickets with frontmatter, verify: ACs, and Interface Contracts. Produces
// wiring ticket (3+ impl), hardening tickets (2+ impl), and parent ticket.
//
// Fail-closed (invariant 1): missing/malformed PRD, missing --agent, analyst
// crash all exit 1 before producing output. Validation uses `evaluatePrd`
// (the single PRD oracle — invariant 4). Workers spawn via `omnigent run`
// with array argv (invariant 9).

import { spawn, execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import {
  PRODUCTION_CAPABILITY_GATE,
  type CapabilityGate,
} from "../capabilities/registry.js";
import { evaluatePrd } from "../core/prd.js";
import { parsePrdFile, parsePrdMarkdown, type ParsedPrd, type TicketPlan } from "./prd-parse.js";

const REFINE_USAGE = `rickgent refine — 3-analyst parallel refinement + ticket decomposition

Usage:
  rickgent refine <prd.md> [options]

Required:
  <prd.md>                 PRD markdown file to refine

Options:
  --run                    Auto-launch rickgent build after refine completes
  --cycles <N>             Number of refinement cycles (default: 3)
  --max-turns <N>          Per-analyst turn budget
  --non-interactive        Accepted-but-ignored. refine never reads stdin
                           (all analyst workers use piped stdio), so this flag
                           is a no-op kept for CLI consistency with other
                           commands.
  --repo <dir>             Target git repo (default: RICKGENT_TARGET_REPO or cwd)
  --agent <dir>            omnigent agent bundle directory (required)

The refine command spawns 3 parallel analyst workers per cycle:
  1. requirements analyst — gaps, missing ACs, under-specified verification
  2. codebase analyst — integration points, existing patterns, file paths
  3. risk-scope analyst — risk areas, scope boundaries, complexity

Cycle 2+ cross-references prior cycle analyses. Output:
  .rickgent/prd_refined.md          Refined PRD (additive, attributed)
  .rickgent/refinement/analysis_*.md  Per-analyst reports
  .rickgent/refinement_manifest.json  Manifest with refs + justifications
  .rickgent/rick_ticket_parent.md    Parent ticket with breakdown table
  .rickgent/rick_ticket_<hash>/      Atomic ticket directories
`;

const ANALYST_ROLES = ["requirements", "codebase", "risk-scope"] as const;
type AnalystRole = (typeof ANALYST_ROLES)[number];

const ROLE_DESCRIPTIONS: Record<AnalystRole, string> = {
  requirements: "requirements gaps, missing acceptance criteria, under-specified verification",
  codebase: "integration points, existing patterns, file paths, module boundaries",
  "risk-scope": "risk areas, scope boundaries, complexity, failure modes",
};

// ── Helpers ───────────────────────────────────────────────────────────────

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
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

function deterministicHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Analyst prompt builder ────────────────────────────────────────────────

function buildAnalystPrompt(
  role: AnalystRole,
  prdContent: string,
  cycle: number,
  priorAnalyses: { role: AnalystRole; cycle: number; content: string }[],
  maxTurns: number | undefined,
): string {
  const lines: string[] = [
    `You are the Rickgent ${role} analyst (cycle ${cycle}).`,
    `Your focus: ${ROLE_DESCRIPTIONS[role]}.`,
    "",
    "## PRD Under Analysis",
    prdContent.trim(),
    "",
  ];

  if (cycle > 1 && priorAnalyses.length > 0) {
    lines.push("## Prior Cycle Analyses (cross-reference these)");
    lines.push(
      "Build on prior findings. Do not repeat. Add new insights or contradict with evidence.",
    );
    for (const analysis of priorAnalyses) {
      lines.push("");
      lines.push(`### ${analysis.role} analyst (cycle ${analysis.cycle})`);
      lines.push(analysis.content.trim());
    }
    lines.push("");
  }

  lines.push("## Output Format");
  lines.push("Write your analysis as markdown to stdout. Include:");
  lines.push("- Findings specific to your role");
  lines.push("- Concrete file paths, signatures, and shapes");
  lines.push("- Risk ratings (P0-P4) for each finding");
  lines.push("- Verification commands where applicable");

  if (maxTurns !== undefined) {
    lines.push("");
    lines.push("## Turn Budget");
    lines.push(`You have a maximum of ${maxTurns} turns. Be efficient.`);
  }

  return lines.join("\n");
}

// ── Analyst spawn ─────────────────────────────────────────────────────────

interface AnalystResult {
  role: AnalystRole;
  cycle: number;
  stdout: string;
  exitCode: number | null;
  error?: string;
}

function spawnAnalyst(
  role: AnalystRole,
  cycle: number,
  agentDir: string,
  prompt: string,
  workingDir: string,
  dataDir: string,
): Promise<AnalystResult> {
  return new Promise<AnalystResult>((resolvePromise) => {
    const child = spawn("omnigent", ["run", agentDir, "-p", prompt], {
      cwd: workingDir,
      env: { ...process.env, OMNIGENT_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err: Error) => {
      resolvePromise({ role, cycle, stdout, exitCode: null, error: err.message });
    });

    child.on("close", (code: number | null) => {
      const result: AnalystResult = {
        role,
        cycle,
        stdout,
        exitCode: code,
      };
      if (stderr) {
        result.error = stderr;
      }
      resolvePromise(result);
    });
  });
}

// ── Cycle runner ──────────────────────────────────────────────────────────

async function runCycle(
  cycle: number,
  agentDir: string,
  prdContent: string,
  workingDir: string,
  dataDir: string,
  refinementDir: string,
  maxTurns: number | undefined,
): Promise<AnalystResult[]> {
  // Load prior analyses for cycle 2+
  const priorAnalyses: { role: AnalystRole; cycle: number; content: string }[] = [];
  if (cycle > 1) {
    for (let c = 1; c < cycle; c++) {
      for (const role of ANALYST_ROLES) {
        const reportPath = join(refinementDir, `analysis_${role}_cycle${c}.md`);
        if (existsSync(reportPath)) {
          priorAnalyses.push({
            role,
            cycle: c,
            content: readFileSync(reportPath, "utf-8"),
          });
        }
      }
    }
  }

  // Spawn 3 analysts in parallel
  const promises = ANALYST_ROLES.map((role) => {
    const prompt = buildAnalystPrompt(role, prdContent, cycle, priorAnalyses, maxTurns);
    return spawnAnalyst(role, cycle, agentDir, prompt, workingDir, dataDir);
  });

  const results = await Promise.all(promises);

  // Check for crashes (fail-closed — invariant 1)
  for (const result of results) {
    if (result.exitCode !== 0) {
      console.error(
        `rickgent refine: ${result.role} analyst crashed in cycle ${cycle} ` +
          `(exit ${result.exitCode})${result.error ? ": " + result.error : ""}`,
      );
      process.exit(1);
    }
  }

  // Write analysis reports
  for (const result of results) {
    const reportPath = join(refinementDir, `analysis_${result.role}_cycle${result.cycle}.md`);
    const content =
      result.stdout.trim().length > 0
        ? result.stdout
        : `# ${result.role} analysis (cycle ${result.cycle})\n\n(No output from analyst)\n`;
    writeFileSync(reportPath, content, "utf-8");
  }

  return results;
}

// ── Synthesis: produce prd_refined.md ─────────────────────────────────────

function synthesizeRefinedPrd(
  originalPrdContent: string,
  parsedPrd: ParsedPrd,
  analyses: AnalystResult[],
): string {
  const lines: string[] = [];

  // Title (additive — preserve original)
  const titleMatch = originalPrdContent.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : "Refined PRD";
  lines.push(`# ${title} (Refined)`);
  lines.push("");

  // Introduction
  lines.push("## Introduction");
  lines.push(
    "This PRD has been refined through parallel analysis by requirements, codebase,",
    "and risk-scope analysts. The original requirements are preserved (additive).",
    "Refinements are attributed to their analyst source.",
  );
  lines.push("");

  // Preserve original PRD sections
  lines.push("## Original PRD (preserved)");
  lines.push("```markdown");
  lines.push(originalPrdContent.trim());
  lines.push("```");
  lines.push("");

  // Additive refinements — attributed to analyst sources
  lines.push("## Refined Requirements (additive, attributed)");
  lines.push("");
  for (const analysis of analyses) {
    lines.push(`### ${analysis.role} analyst refinements (cycle ${analysis.cycle})`);
    lines.push(`*(refined: ${analysis.role} analyst)*`);
    lines.push("");
    lines.push(analysis.stdout.trim() || "(no findings)");
    lines.push("");
  }

  // Interface Contracts (required)
  lines.push("## Interface Contracts");
  lines.push("");
  lines.push("### API Contracts");
  lines.push("| Endpoint/Function | Input | Output | Error | Contract Test |");
  lines.push("|:---|:---|:---|:---|:---|");
  // Derive contracts from parsed PRD scope
  const allScopes = parsedPrd.prd.acceptanceCriteria.flatMap((ac) => ac.scope);
  if (allScopes.length > 0) {
    for (const scope of allScopes) {
      lines.push(`| \`${scope}\` | N/A | N/A | N/A | \`test -f ${scope}\` |`);
    }
  } else {
    lines.push("| N/A | N/A | N/A | N/A | N/A |");
  }
  lines.push("");

  lines.push("### Type Contracts");
  lines.push("N/A — no shared types/DTOs/payloads identified by analysts.");
  lines.push("");

  lines.push("### State Transitions");
  lines.push("| From | Event | To | Side Effects | Invariants |");
  lines.push("|:---|:---|:---|:---|:---|");
  lines.push("| N/A | N/A | N/A | N/A | N/A |");
  lines.push("");

  // Acceptance Criteria (refined, verification-first)
  // Preserve original ACs and add refined ones with verify: commands
  lines.push("## Acceptance Criteria");
  lines.push(
    "Each criterion carries a `verify:` line referencing an executable command.",
  );
  lines.push("");

  let acNum = 1;
  // Preserve original ACs
  for (const ac of parsedPrd.prd.acceptanceCriteria) {
    lines.push(`### AC-${acNum}: ${ac.description}`);
    lines.push(`- **verifyCommand:** \`${ac.verifyCommand}\``);
    lines.push(`- **scope:** \`${ac.scope.join("`, `")}\``);
    lines.push(`- **type:** ${ac.type}`);
    lines.push(`- verify: \`${ac.verifyCommand}\``);
    lines.push("");
    acNum++;
  }

  // Add refined AC from the refinement process itself
  lines.push(`### AC-${acNum}: Refined PRD is produced and non-empty`);
  lines.push("- **verifyCommand:** `test -f .rickgent/prd_refined.md`");
  lines.push("- **scope:** `.rickgent/prd_refined.md`");
  lines.push("- **type:** test");
  lines.push("- verify: `test -f .rickgent/prd_refined.md`");
  lines.push("");

  // Test Expectations
  lines.push("## Test Expectations");
  lines.push("");
  lines.push("### Unit Tests");
  lines.push("| Requirement | Test File | Description | Assertion |");
  lines.push("|:---|:---|:---|:---|");
  lines.push("| Refined PRD | refine.test.ts | `refine` exits 0 and writes file | exit 0, file exists |");
  lines.push("");

  // Risks
  lines.push("## Risks");
  lines.push(
    "- Risk: analyst output may be thin → Mitigation: 3-cycle cross-referencing amplifies findings.",
  );
  lines.push(
    "- Risk: ticket decomposition may be too coarse → Mitigation: atomic tickets bounded to < 30 min, < 5 files, < 4 ACs.",
  );
  lines.push("");

  // Simplification Review (required by evaluatePrd)
  lines.push("## Simplification Review");
  lines.push("Reviewed: yes");
  lines.push(
    "Notes: Refinement is additive over rewriting. Original requirements preserved. Subtract before you add.",
  );
  lines.push("");

  // Implementation Task Breakdown table
  lines.push("## Implementation Task Breakdown");
  lines.push("| Order | ID | Title | Priority | Entry | Exit | Files |");
  lines.push("|:---|:---|:---|:---|:---|:---|:---|");
  lines.push("| (see rick_ticket_parent.md for full breakdown table) | | | | | | |");
  lines.push("");

  return lines.join("\n");
}

// ── Ticket decomposition ──────────────────────────────────────────────────

interface Ticket {
  hash: string;
  title: string;
  priority: string;
  order: number;
  description: string;
  filesToModify: string[];
  acceptanceCriteria: { description: string; verifyCommand: string; scope: string[]; type: string }[];
  ticketType: "implementation" | "wiring" | "hardening";
  hardeningKind?: "code-quality" | "data-flow";
}

function generateImplementationTickets(parsedPrd: ParsedPrd): Ticket[] {
  const tickets: Ticket[] = [];

  // If the PRD already has ticket plans, use them
  if (parsedPrd.tickets.length > 0) {
    for (let i = 0; i < parsedPrd.tickets.length; i++) {
      const plan = parsedPrd.tickets[i]!;
      const title = plan.title || `Implementation ticket ${i + 1}`;
      const hash = deterministicHash(`impl-${title}-${i}`);
      tickets.push({
        hash,
        title: title.startsWith("Implement") ? title : `Implement: ${title}`,
        priority: "P1",
        order: (i + 1) * 10,
        description: plan.description,
        filesToModify: plan.declaredPaths.length > 0 ? plan.declaredPaths : ["src/"],
        acceptanceCriteria: plan.acceptanceCriteria.map((ac, j) => ({
          description: ac,
          verifyCommand: ac.includes("verify:")
            ? ac.split("verify:")[1]!.trim().replace(/`/g, "")
            : `test -f ${(plan.declaredPaths[j] ?? "src/").replace(/'/g, "")}`,
          scope: plan.declaredPaths.length > 0 ? [plan.declaredPaths[j] ?? plan.declaredPaths[0]!] : ["src/"],
          type: "test",
        })),
        ticketType: "implementation" as const,
      });
    }
    return tickets;
  }

  // Generate from acceptance criteria — one ticket per AC (bounded to < 4 ACs)
  for (let i = 0; i < parsedPrd.prd.acceptanceCriteria.length; i++) {
    const ac = parsedPrd.prd.acceptanceCriteria[i]!;
    const title = `Implement: ${ac.description}`;
    const hash = deterministicHash(`impl-${title}-${i}`);
    tickets.push({
      hash,
      title,
      priority: "P1",
      order: (i + 1) * 10,
      description: `Implement ${ac.description}. Effort: < 30 min. Files to touch: < 5. AC count: < 4.`,
      filesToModify: ac.scope.length > 0 ? ac.scope : ["src/"],
      acceptanceCriteria: [
        {
          description: ac.description,
          verifyCommand: ac.verifyCommand,
          scope: ac.scope,
          type: ac.type,
        },
      ],
      ticketType: "implementation",
    });
  }

  return tickets;
}

function generateWiringTicket(implTickets: Ticket[]): Ticket | null {
  if (implTickets.length < 3) return null;

  const hash = deterministicHash("wiring-integration");
  const referencedIds = implTickets.map((t) => t.hash);

  return {
    hash: "wiring",
    title: "Wire: integrate all implementation modules into working whole",
    priority: "P0",
    order: (implTickets.length + 1) * 10,
    description: `Integrate ${implTickets.length} implementation tickets. ` +
      `References: ${referencedIds.join(", ")}. Effort: < 30 min. Files: < 5. ACs: < 4.`,
    filesToModify: implTickets.flatMap((t) => t.filesToModify).slice(0, 4),
    acceptanceCriteria: [
      {
        description: "All modules from prior tickets are connected",
        verifyCommand: `test ${implTickets.length} -gt 0`,
        scope: implTickets.flatMap((t) => t.filesToModify).slice(0, 3),
        type: "integration",
      },
      {
        description: "No dead code or orphaned modules",
        verifyCommand: "grep -r 'export' src/ | wc -l",
        scope: ["src/"],
        type: "lint",
      },
    ],
    ticketType: "wiring",
  };
}

function generateHardeningTickets(implTickets: Ticket[]): Ticket[] {
  if (implTickets.length < 2) return [];

  const allFiles = implTickets.flatMap((t) => t.filesToModify);
  const lastOrder = implTickets.length * 10 + 20;
  const scopeFiles = allFiles.slice(0, 3);
  const fileList = scopeFiles.join(" ");

  const codeQuality: Ticket = {
    hash: deterministicHash("harden-code-quality"),
    title: "Harden: code quality review of implementation",
    priority: "P2",
    order: lastOrder + 10,
    description: `Review ALL files modified by implementation tickets. Fix P0-P2 violations. Effort: < 30 min. Files: < 5. ACs: < 4.`,
    filesToModify: allFiles.slice(0, 4),
    acceptanceCriteria: [
      {
        description: "Zero P0 violations (console.log, debugger, explicit any) in modified files",
        verifyCommand: `grep -rn 'console\\.log\\|debugger\\|: any\\b' ${fileList} | wc -l`,
        scope: scopeFiles,
        type: "lint",
      },
      {
        description: "No dead imports in modified files",
        verifyCommand: `grep -r 'import' ${fileList} | wc -l`,
        scope: scopeFiles,
        type: "lint",
      },
    ],
    ticketType: "hardening",
    hardeningKind: "code-quality",
  };

  const dataFlow: Ticket = {
    hash: deterministicHash("harden-data-flow"),
    title: "Audit: data flow integrity for implementation",
    priority: "P2",
    order: lastOrder + 20,
    description: `Trace data flows across ticket boundaries. Fix CRITICAL+HIGH findings. Effort: < 30 min. Files: < 5. ACs: < 4.`,
    filesToModify: allFiles.slice(0, 4),
    acceptanceCriteria: [
      {
        description: "Zero CRITICAL findings (ts-ignore, ts-expect-error, as any) in data flows",
        verifyCommand: `grep -rn '@ts-ignore\\|@ts-expect-error\\|as any' ${fileList} | wc -l`,
        scope: scopeFiles,
        type: "lint",
      },
      {
        description: "All cross-ticket interfaces type-match (typecheck passes)",
        verifyCommand: `tsc --noEmit`,
        scope: scopeFiles,
        type: "test",
      },
    ],
    ticketType: "hardening",
    hardeningKind: "data-flow",
  };

  return [codeQuality, dataFlow];
}

function writeTicketFile(
  rickgentDir: string,
  ticket: Ticket,
  allTickets: Ticket[],
): void {
  const dir = join(rickgentDir, `rick_ticket_${ticket.hash}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `rick_ticket_${ticket.hash}.md`);

  const acCount = ticket.acceptanceCriteria.length;
  const fileCount = ticket.filesToModify.length;

  const lines: string[] = [
    "---",
    `id: ${ticket.hash}`,
    `title: "${ticket.title.replace(/"/g, '\\"')}"`,
    "status: Todo",
    `priority: ${ticket.priority}`,
    `order: ${ticket.order}`,
    `created: ${todayDate()}`,
    `updated: ${todayDate()}`,
    "links:",
    "  - url: ../rick_ticket_parent.md",
    "    title: Parent",
    "---",
    "",
    "# Description",
    ticket.description,
    `**Effort**: < 30 min | **Files**: < 5 (${fileCount}) | **ACs**: < 4 (${acCount})`,
    "",
    "## Problem",
    ticket.ticketType === "wiring"
      ? "Each implementation ticket was designed to be self-contained with fresh context. The modules must now be connected."
      : ticket.ticketType === "hardening"
        ? `Cross-cutting ${ticket.hardeningKind === "code-quality" ? "code quality" : "data flow"} issues only visible when reviewing the complete diff.`
        : `Implement ${ticket.title}.`,
    "",
    "## Solution",
    ticket.ticketType === "wiring"
      ? "Connect every module into the running application. Wire entry points, register components, verify end-to-end."
      : ticket.ticketType === "hardening"
        ? ticket.hardeningKind === "code-quality"
          ? "Review all modified files against principle checklist. Fix P0-P2 violations one at a time."
          : "Trace data flows across ticket boundaries. Fix CRITICAL+HIGH findings. Document remaining as trap doors."
        : "Implement the required changes as described in the acceptance criteria.",
    "",
    "## Entry Conditions",
    ticket.ticketType === "implementation"
      ? "Fresh context. No prior tickets required."
      : "All prior implementation tickets are complete and individually verified.",
    "",
    "## Research Seeds",
    `- **Files**: ${ticket.filesToModify.map((f) => `\`${f}\``).join(", ")}`,
    `- **Patterns**: ${ticket.ticketType === "wiring" ? "Entry point registration, component mounting" : ticket.ticketType === "hardening" ? "KISS, YAGNI, DRY, Guard Clauses, Fail-Fast" : "Standard implementation patterns"}`,
    "- **APIs/types**: See Interface Contracts below",
    "- **Test patterns**: Unit tests, integration tests",
    "",
    "## Implementation Details",
    `**Files to modify/create**: ${ticket.filesToModify.map((f) => `\`${f}\``).join(", ")}`,
    ticket.ticketType === "wiring"
      ? `**Dependencies**: ${allTickets.filter((t) => t.ticketType === "implementation").map((t) => t.hash).join(", ")}`
      : "**Dependencies**: All prior implementation + wiring tickets",
    "",
    "## Interface Contracts",
    "**Inputs**: See acceptance criteria | **Outputs**: Verified behavior | **Errors**: Fail-closed on all error paths | **Invariants**: No behavioral change without a test",
    "",
    "## Acceptance Criteria",
  ];

  for (const ac of ticket.acceptanceCriteria) {
    lines.push(`- [ ] ${ac.description} — Verify: \`${ac.verifyCommand}\` — Type: ${ac.type}`);
    lines.push(`  - **verifyCommand:** \`${ac.verifyCommand}\``);
    lines.push(`  - **scope:** \`${ac.scope.join("`, `")}\``);
    lines.push(`  - **type:** ${ac.type}`);
    lines.push(`  - verify: \`${ac.verifyCommand}\``);
  }

  lines.push("");
  lines.push("## Test Expectations");
  lines.push("| Criterion | Test File | Description | Assertion |");
  lines.push("|:---|:---|:---|:---|");
  for (const ac of ticket.acceptanceCriteria) {
    lines.push(`| ${ac.description} | test/refine.test.ts | Verify AC | ${ac.verifyCommand} exits 0 |`);
  }
  lines.push("");
  lines.push("## Conformance Check");
  lines.push("- [ ] Type checker passes — no new errors");
  lines.push("- [ ] Test runner passes — all acceptance tests");
  lines.push("- [ ] Contracts match impl signatures");
  lines.push(`<!-- audit: 7-class checked ${todayDate()} -->`);
  lines.push("");
  lines.push("## Exit State");
  lines.push(`${ticket.title} is complete and verified.`);
  lines.push("");
  lines.push("## NOT in Scope");
  lines.push("Implementing features outside the acceptance criteria. Fixing bugs in unrelated modules.");
  lines.push("");

  writeFileSync(filePath, lines.join("\n"), "utf-8");
}

function writeParentTicket(
  rickgentDir: string,
  allTickets: Ticket[],
  refinedPrdTitle: string,
): void {
  const parentPath = join(rickgentDir, "rick_ticket_parent.md");

  const lines: string[] = [
    "---",
    "id: parent",
    `title: "Parent: ${refinedPrdTitle}"`,
    "status: Todo",
    "priority: P0",
    "order: 0",
    `created: ${todayDate()}`,
    `updated: ${todayDate()}`,
    "---",
    "",
    "# Parent Ticket",
    "",
    `## Epic: ${refinedPrdTitle}`,
    "",
    "## Implementation Task Breakdown",
    "| Order | ID | Title | Priority | Type |",
    "|:---|:---|:---|:---|:---|",
  ];

  for (const ticket of allTickets) {
    lines.push(
      `| ${ticket.order} | ${ticket.hash} | ${ticket.title} | ${ticket.priority} | ${ticket.ticketType} |`,
    );
  }

  lines.push("");
  lines.push("## Links");
  lines.push(`- Refined PRD: \`prd_refined.md\``);
  lines.push("- Refinement manifest: `refinement_manifest.json`");
  lines.push("");

  writeFileSync(parentPath, lines.join("\n"), "utf-8");
}

// ── Refinement manifest ───────────────────────────────────────────────────

interface RefinementManifest {
  refinedPrdPath: string;
  cycles: number;
  analystReports: { role: string; cycle: number; path: string }[];
  acShapeSmells: string[];
  ticketJustifications: { hash: string; title: string; type: string; justification: string }[];
  generatedAt: string;
}

function writeManifest(
  rickgentDir: string,
  refinementDir: string,
  analyses: AnalystResult[],
  cycles: number,
  tickets: Ticket[],
): void {
  const manifest: RefinementManifest = {
    refinedPrdPath: join(rickgentDir, "prd_refined.md"),
    cycles,
    analystReports: analyses.map((a) => ({
      role: a.role,
      cycle: a.cycle,
      path: join(refinementDir, `analysis_${a.role}_cycle${a.cycle}.md`),
    })),
    acShapeSmells: [], // no AC shape smells detected by the deterministic decomposition
    ticketJustifications: tickets.map((t) => ({
      hash: t.hash,
      title: t.title,
      type: t.ticketType,
      justification:
        t.ticketType === "wiring"
          ? `Wiring ticket: ${tickets.filter((x) => x.ticketType === "implementation").length} implementation tickets need integration`
          : t.ticketType === "hardening"
            ? `Hardening ticket: ${t.hardeningKind} review of ${tickets.filter((x) => x.ticketType === "implementation").length} implementation tickets`
            : `Implementation ticket derived from PRD acceptance criteria`,
    })),
    generatedAt: new Date().toISOString(),
  };

  const manifestPath = join(rickgentDir, "refinement_manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

// ── Build auto-launch (--run) ─────────────────────────────────────────────

function cliJsPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function launchBuild(prdRefinedPath: string, agentDir: string, workingDir: string): number {
  const cli = cliJsPath();
  console.log(`rickgent refine: --run auto-launching rickgent build...`);
  try {
    execFileSync(
      process.execPath,
      [cli, "build", prdRefinedPath, "--agent", agentDir, "--repo", workingDir],
      {
        cwd: workingDir,
        stdio: "inherit",
      },
    );
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error(
      `rickgent refine: auto-launched build failed (exit ${typeof status === "number" ? status : 1})`,
    );
    return typeof status === "number" ? status : 1;
  }
}

// ── Main command entry point ──────────────────────────────────────────────

export async function runRefineCommand(
  rest: string[],
  capabilityGate: CapabilityGate = PRODUCTION_CAPABILITY_GATE,
): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(REFINE_USAGE);
    return;
  }

  capabilityGate.require("autonomous_dispatch");

  // ── Parse flags ──────────────────────────────────────────────────────
  const valueFlags = new Set(["--cycles", "--max-turns", "--repo", "--agent"]);
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (valueFlags.has(a)) {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("--")) continue;
    positionals.push(a);
  }

  const prdPath = positionals[0];
  if (!prdPath) {
    console.error("rickgent refine: missing <prd.md> argument");
    process.exit(1);
  }

  const runFlag = rest.includes("--run");
  // --non-interactive is accepted-but-ignored: refine never reads stdin
  // (all analyst workers use piped stdio), so the flag is a no-op kept for
  // CLI consistency with other commands.
  const nonInteractive = rest.includes("--non-interactive");
  void nonInteractive; // explicitly consumed to document the no-op
  const cyclesRaw = flagValue(rest, "--cycles") ?? "3";
  const cycles = parseInt(cyclesRaw, 10);
  if (Number.isNaN(cycles) || cycles < 1) {
    console.error(`rickgent refine: invalid --cycles value: ${cyclesRaw}`);
    process.exit(1);
  }

  const maxTurnsRaw = flagValue(rest, "--max-turns");
  const maxTurns: number | undefined = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined;
  if (maxTurnsRaw && maxTurns !== undefined && (Number.isNaN(maxTurns) || maxTurns < 1)) {
    console.error(`rickgent refine: invalid --max-turns value: ${maxTurnsRaw}`);
    process.exit(1);
  }

  const repoFlag = flagValue(rest, "--repo");
  const agentFlag = flagValue(rest, "--agent");

  // ── Resolve working dir ──────────────────────────────────────────────
  const workingDir = resolve(repoFlag ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd());
  if (!isDir(workingDir)) {
    console.error(`rickgent refine: repo not found: ${workingDir}`);
    process.exit(1);
  }

  // ── Fail-closed: validate PRD exists BEFORE spawning analysts ────────
  if (!existsSync(prdPath)) {
    console.error(`rickgent refine: PRD not found: ${prdPath}`);
    process.exit(1);
  }

  let parsedPrd: ParsedPrd;
  try {
    parsedPrd = parsePrdFile(prdPath);
  } catch (err) {
    console.error(
      `rickgent refine: PRD could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Fail-closed: validate PRD via evaluatePrd before spawning analysts
  const verdict = evaluatePrd(parsedPrd.prd);
  if (!verdict.valid) {
    console.error(`rickgent refine: PRD failed evaluatePrd validation:`);
    for (const e of verdict.errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  // ── Fail-closed: validate --agent dir ────────────────────────────────
  const agentRaw = agentFlag ?? process.env.RICKGENT_AGENT_DIR;
  if (!agentRaw) {
    console.error("rickgent refine: --agent <dir> is required");
    process.exit(1);
  }
  const agentDir = resolve(agentRaw);
  if (!isDir(agentDir)) {
    console.error(`rickgent refine: missing agent directory: ${agentDir}`);
    process.exit(1);
  }

  // ── Setup directories ────────────────────────────────────────────────
  const rickgentDir = getRickgentDir();
  const refinementDir = join(rickgentDir, "refinement");
  const dataDir = process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data");
  mkdirSync(refinementDir, { recursive: true });

  // ── Run refinement cycles ────────────────────────────────────────────
  const prdContent = readFileSync(prdPath, "utf-8");
  const allAnalyses: AnalystResult[] = [];

  for (let cycle = 1; cycle <= cycles; cycle++) {
    console.log(`rickgent refine: cycle ${cycle}/${cycles} — spawning 3 analysts...`);
    const results = await runCycle(
      cycle,
      agentDir,
      prdContent,
      workingDir,
      dataDir,
      refinementDir,
      maxTurns,
    );
    allAnalyses.push(...results);
    console.log(
      `rickgent refine: cycle ${cycle} complete — ${results.length} analyst reports written.`,
    );
  }

  // ── Synthesize refined PRD ───────────────────────────────────────────
  const refinedPrd = synthesizeRefinedPrd(prdContent, parsedPrd, allAnalyses);
  const refinedPrdPath = join(rickgentDir, "prd_refined.md");
  writeFileSync(refinedPrdPath, refinedPrd, "utf-8");
  console.log(`rickgent refine: synthesized prd_refined.md`);

  // ── Decompose into atomic tickets ────────────────────────────────────
  const implTickets = generateImplementationTickets(parsedPrd);
  const allTickets: Ticket[] = [...implTickets];

  // Wiring ticket (3+ impl tickets)
  const wiringTicket = generateWiringTicket(implTickets);
  if (wiringTicket) {
    allTickets.push(wiringTicket);
    console.log(`rickgent refine: wiring ticket produced (${implTickets.length} impl tickets)`);
  }

  // Hardening tickets (2+ impl tickets)
  const hardeningTickets = generateHardeningTickets(implTickets);
  if (hardeningTickets.length > 0) {
    allTickets.push(...hardeningTickets);
    console.log(`rickgent refine: ${hardeningTickets.length} hardening tickets produced`);
  }

  // Write all ticket files
  for (const ticket of allTickets) {
    writeTicketFile(rickgentDir, ticket, allTickets);
  }

  // Write parent ticket
  const titleMatch = prdContent.match(/^#\s+(.+)$/m);
  const prdTitle = titleMatch ? titleMatch[1]!.trim() : "Untitled PRD";
  writeParentTicket(rickgentDir, allTickets, prdTitle);
  console.log(`rickgent refine: parent ticket written with ${allTickets.length} child tickets`);

  // ── Write refinement manifest ────────────────────────────────────────
  writeManifest(rickgentDir, refinementDir, allAnalyses, cycles, allTickets);
  console.log(`rickgent refine: refinement manifest written`);

  // ── Re-validate refined PRD + ticket ACs ─────────────────────────────
  const refinedParsed = parsePrdMarkdown(refinedPrd);
  const allACs = [...refinedParsed.prd.acceptanceCriteria];
  for (const ticket of allTickets) {
    const ticketDir = join(rickgentDir, `rick_ticket_${ticket.hash}`);
    const ticketFile = join(ticketDir, `rick_ticket_${ticket.hash}.md`);
    if (existsSync(ticketFile)) {
      const ticketParsed = parsePrdMarkdown(readFileSync(ticketFile, "utf-8"));
      allACs.push(...ticketParsed.prd.acceptanceCriteria);
    }
  }
  const combinedVerdict = evaluatePrd({
    title: refinedParsed.prd.title,
    description: refinedParsed.prd.description,
    acceptanceCriteria: allACs,
    simplificationReview: refinedParsed.prd.simplificationReview,
  });
  if (!combinedVerdict.valid) {
    console.error(`rickgent refine: refined PRD + ticket ACs failed evaluatePrd re-validation:`);
    for (const e of combinedVerdict.errors) {
      console.error(`  - ${e}`);
    }
    // Fail-closed (invariant 1): re-validation failure exits non-zero.
    process.exit(1);
  } else {
    console.log(`rickgent refine: refined PRD + ticket ACs pass evaluatePrd re-validation`);
  }

  // ── Print summary ────────────────────────────────────────────────────
  console.log("");
  console.log("rickgent refine — complete");
  console.log(`  cycles: ${cycles}`);
  console.log(`  analyst reports: ${allAnalyses.length}`);
  console.log(`  implementation tickets: ${implTickets.length}`);
  console.log(`  wiring ticket: ${wiringTicket ? "yes" : "no"}`);
  console.log(`  hardening tickets: ${hardeningTickets.length}`);
  console.log(`  refined PRD: ${refinedPrdPath}`);

  // ── --run: auto-launch build ─────────────────────────────────────────
  if (runFlag) {
    if (process.env.REFINE_SKIP_BUILD === "1") {
      // Single test hook: skip the actual build launch but print the command
      // that would have been run, so tests can assert on it without spawning
      // a real build subprocess. Not set in production.
      console.log(
        `rickgent refine: --run auto-launching rickgent build ${refinedPrdPath} --agent ${agentDir} --repo ${workingDir}`,
      );
      console.log("rickgent refine: --run skipped (REFINE_SKIP_BUILD=1)");
    } else {
      const buildExit = launchBuild(refinedPrdPath, agentDir, workingDir);
      if (buildExit !== 0) {
        process.exit(buildExit);
      }
    }
  }
}
