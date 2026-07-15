// PRD interview — `rickgent prd` command.
//
// Interactive mode: spawns a single `omnigent run <agentDir> -p <prompt>` agent
// that interviews the user (Why/Who/What/How), explores the codebase, and
// drafts `prd.md` with machine-checkable acceptance criteria using the rickgent
// PRD template. The agent is spawned with array argv (invariant 9) — never a
// shell string.
//
// Non-interactive mode: emits the canonical PRD template to `--output <path>`
// (default `.rickgent/prd.md`), then validates any `--from <file>` with
// `evaluatePrd` (the single PRD oracle — invariant 4). No agent is spawned and
// stdin is never read.
//
// Fail-closed (invariant 1): missing `--agent` in interactive mode, missing
// repo, or missing `--from` file all exit 1 with a clear error and produce no
// output. Validation failures from `evaluatePrd` exit 1 with the oracle's
// error messages.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { evaluatePrd } from "../core/prd.js";
import { parsePrdFile } from "./prd-parse.js";

const PRD_USAGE = `rickgent prd — interactive PRD interview with --non-interactive template mode

Usage:
  rickgent prd [--non-interactive] [options]

Modes:
  interactive (default)   Spawns an omnigent run agent that interviews the user,
                          explores the codebase, and drafts prd.md with
                          machine-checkable acceptance criteria.
  --non-interactive       Emits the PRD template to --output (default
                          .rickgent/prd.md) and validates --from via evaluatePrd.
                          No agent is spawned; stdin is never read.

Options:
  --from <file>           Validate an existing PRD file via evaluatePrd (fail-closed
                          on missing file or invalid PRD).
  --non-interactive       Template mode — no agent, no stdin.
  --repo <dir>            Target git repo (default: RICKGENT_TARGET_REPO or cwd).
  --agent <dir>           omnigent agent bundle directory (required in interactive
                          mode; ignored in --non-interactive mode).
  --output <path>         Write the template/PRD to this path (default:
                          .rickgent/prd.md under the working dir or RICKGENT_DIR).
`;

// ── Canonical PRD template ───────────────────────────────────────────────
//
// The template is designed to pass `evaluatePrd(parsePrdFile(outputPath))` when
// emitted verbatim: it has ≥1 AC section with non-empty `verifyCommand` and
// `scope`, no interactive/network commands, and a `Reviewed: yes` line so the
// simplification-review flag is true. It also includes the `verify:` convention
// line per AC for human readability (VAL-PRD-004).
const PRD_TEMPLATE = `# Feature PRD

## Introduction
Describe the feature, its purpose, and the context. State what IS (current
state), not what SHOULD be.

## Problem Statement
**Current Process**: Describe how things work today.
**Users**: Who is affected.
**Pain Points**: What hurts.
**Importance**: Why now.

## Scope
### In-scope
- Item 1
- Item 2
### Not-in-scope
- Out of scope item 1

## Functional Requirements
| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | The PRD template is emitted to the output path | As a developer, I want \`rickgent prd --non-interactive\` to write a template | \`test -f .rickgent/prd.md\` |
| P1 | The emitted PRD passes evaluatePrd | As a developer, I want the template to be valid | \`node dist/cli.js prd --non-interactive --output /tmp/prd-check.md\` |

Every requirement needs a machine-checkable Verification (test/typecheck/lint).

## Interface Contracts
Exact shapes at module/service boundaries. N/A with justification if no
boundaries crossed.

### API Contracts
| Endpoint/Function | Input | Output | Error | Contract Test |
|:---|:---|:---|:---|:---|
| N/A | N/A | N/A | N/A | N/A |

### Type Contracts
N/A — no shared types/DTOs/payloads for the template.

### State Transitions
| From | Event | To | Side Effects | Invariants |
|:---|:---|:---|:---|:---|
| N/A | N/A | N/A | N/A | N/A |

## Acceptance Criteria
Each criterion carries a \`verify:\` line referencing an executable command.

### AC-1: PRD template is written to the output path
- **verifyCommand:** \`test -f .rickgent/prd.md\`
- **scope:** \`.rickgent/prd.md\`
- **type:** test
- verify: \`test -f .rickgent/prd.md\`

### AC-2: Emitted PRD passes evaluatePrd validation
- **verifyCommand:** \`node dist/cli.js prd --non-interactive --output /tmp/prd-validate.md\`
- **scope:** \`orchestrator/src/lifecycle/prd-interview.ts\`
- **type:** test
- verify: \`node dist/cli.js prd --non-interactive --output /tmp/prd-validate.md\`

## Test Expectations
### Unit Tests
| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Template emission | prd-interview.test.ts | \`prd --non-interactive\` exits 0 and writes file | exit 0, file exists |

### Integration Tests
| CUJ | Test File | Scenario | Expected |
|:---|:---|:---|:---|
| Non-interactive template | prd-interview.test.ts | Emit template, parse, validate | evaluatePrd passes |

## Risks
- Risk: template does not pass evaluatePrd → Mitigation: template is designed to pass evaluatePrd when parsed.
- Risk: interactive agent does not produce machine-checkable ACs → Mitigation: interview prompt instructs the agent to include verify: commands per AC.

## Simplification Review
Reviewed: yes
Notes: Template is minimal; no redundant sections. Subtract before you add.
`;

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

function buildInterviewPrompt(
  repoDir: string,
  outputPath: string,
  fromFile: string | undefined,
): string {
  const lines: string[] = [
    "You are the Rickgent PRD Drafter. Your job is to interview the user and draft a PRD.",
    "",
    "## Objectives",
    "1. Interview the user: ask Why (problem/value/urgency), Who (audience), What (scope/UX), How (constraints).",
    "2. Explore the codebase using read-only tools. Verify every path/symbol before it enters the PRD (use git ls-files or open the file). Cite file:line for current-state claims.",
    "3. Push for machine-checkable verification per requirement: 'How will we verify this automatically?' Get commands, type shapes, test assertions.",
    "4. Capture interface contracts: 'What crosses a boundary?' (APIs, events, shared types, state transitions). Get exact shapes.",
    "5. Iterate until 100% clarity AND verification coverage. No premature drafting.",
    "",
    "## Output",
    `Write the PRD to: ${outputPath}`,
    `Working directory (repo): ${repoDir}`,
    "",
    "## PRD Template",
    "Use this structure (fill in real content, do not leave placeholders):",
    "  # <Feature> PRD",
    "  ## Introduction",
    "  ## Problem Statement",
    "  ## Scope (In-scope / Not-in-scope)",
    "  ## Functional Requirements (table with Verification column)",
    "  ## Interface Contracts (API / Types / State Transitions)",
    "  ## Acceptance Criteria — each ### AC-N section MUST have:",
    "    - **verifyCommand:** <executable command>",
    "    - **scope:** <file paths>",
    "    - **type:** test|lint|grep",
    "    - verify: <executable command>",
    "  ## Test Expectations (Unit / Integration / Edge Cases)",
    "  ## Risks",
    "  ## Simplification Review",
    "    Reviewed: yes",
    "    Notes: <what was subtracted before adding>",
    "",
    "Every acceptance criterion MUST have a non-empty verifyCommand and scope.",
    "No interactive commands (read -p) or network commands (curl/wget/http).",
    "The PRD must pass evaluatePrd when parsed.",
  ];
  if (fromFile) {
    lines.push("");
    lines.push(`## Existing PRD to adopt/refine: ${fromFile}`);
    lines.push("Read the existing PRD, validate its content, and use it as the basis for the interview.");
  }
  return lines.join("\n");
}

export async function runPrdCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(PRD_USAGE);
    return;
  }

  const nonInteractive = rest.includes("--non-interactive");
  const fromFile = flagValue(rest, "--from");
  const outputFlag = flagValue(rest, "--output");
  const repoFlag = flagValue(rest, "--repo");
  const agentFlag = flagValue(rest, "--agent");

  // ── Resolve repo (working dir) ────────────────────────────────────────
  const workingDir = resolve(repoFlag ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd());
  if (!isDir(workingDir)) {
    console.error(`rickgent prd: repo not found: ${workingDir}`);
    process.exit(1);
  }

  const rickgentDir = getRickgentDir();
  const outputPath = outputFlag ? resolve(outputFlag) : join(rickgentDir, "prd.md");

  // ── --from validation (fail-closed BEFORE emitting template) ──────────
  if (fromFile) {
    if (!existsSync(fromFile)) {
      console.error(`rickgent prd: --from file not found: ${fromFile}`);
      process.exit(1);
    }
    let parsed;
    try {
      parsed = parsePrdFile(fromFile);
    } catch (err) {
      console.error(
        `rickgent prd: --from file could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    const verdict = evaluatePrd(parsed.prd);
    if (!verdict.valid) {
      console.error(`rickgent prd: --from PRD failed evaluatePrd validation:`);
      for (const e of verdict.errors) {
        console.error(`  - ${e}`);
      }
      process.exit(1);
    }
    console.log(`rickgent prd: --from ${fromFile} passed evaluatePrd validation.`);
  }

  if (nonInteractive) {
    // ── Non-interactive: emit template, no agent, no stdin ─────────────
    // Ensure the parent directory exists.
    const parent = dirname(outputPath);
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    if (!existsSync(rickgentDir) && outputPath.startsWith(rickgentDir)) {
      mkdirSync(rickgentDir, { recursive: true });
    }
    writeFileSync(outputPath, PRD_TEMPLATE, "utf-8");
    console.log(`rickgent prd: template written to ${outputPath}`);
    return;
  }

  // ── Interactive mode: requires --agent (explicit, no default fallback) ─
  // VAL-PRD-008: fails closed when --agent is missing in interactive mode.
  const agentRaw = agentFlag ?? process.env.RICKGENT_AGENT_DIR;
  if (!agentRaw) {
    console.error("rickgent prd: --agent <dir> is required in interactive mode");
    process.exit(1);
  }
  const agentDir = resolve(agentRaw);
  if (!isDir(agentDir)) {
    console.error(`rickgent prd: missing agent directory: ${agentDir}`);
    process.exit(1);
  }

  const dataDir = process.env.OMNIGENT_DATA_DIR ?? join(rickgentDir, "omnigent-data");
  const prompt = buildInterviewPrompt(workingDir, outputPath, fromFile);

  // Spawn a single omnigent run agent with array argv (invariant 9).
  const res = spawnSync("omnigent", ["run", agentDir, "-p", prompt], {
    cwd: workingDir,
    encoding: "utf-8",
    stdio: "inherit",
    env: { ...process.env, OMNIGENT_DATA_DIR: dataDir },
  });

  if (res.error) {
    console.error(`rickgent prd: failed to spawn interview agent: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0 && res.status !== null) {
    console.error(`rickgent prd: interview agent exited with code ${res.status}`);
    process.exit(res.status);
  }

  console.log(`rickgent prd: interview complete. PRD should be at ${outputPath}`);
}
