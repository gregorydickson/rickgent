// PRD interview — `rickgent prd` command.
//
// Interactive mode: spawns a single `omnigent run <agentDir> -p <prompt>` agent
// that interviews the user (Why/Who/What/How), explores the codebase, and
// drafts `prd.md` with machine-checkable acceptance criteria using the rickgent
// PRD template. The agent is spawned with array argv (invariant 9) — never a
// shell string.
//
// Non-interactive mode: emits the canonical PRD template to `--output <path>`
// (default `.rickgent/prd.md`), then validates any `--from <file>` through the
// executable TicketContract adapter and `evaluatePrd`. No agent is spawned and
// stdin is never read.
//
// Fail-closed (invariant 1): missing `--agent` in interactive mode, missing
// repo, or missing `--from` file all exit 1 with a clear error and produce no
// output. Executable-contract or PRD-oracle failures exit 1 with precise errors.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";
import {
  filesystemIdentitiesOverlap,
  resolveFilesystemIdentity,
} from "../contracts/filesystem-identity.js";
import { evaluatePrd } from "../core/prd.js";
import {
  parseExecutablePrdFile,
  parseExecutablePrdMarkdown,
} from "./prd-parse.js";
import {
  failLifecycleCommand,
  LifecycleCommandError,
  lifecycleCommandCompleted,
  lifecycleCommandSucceeded,
  type LifecycleCommandResult,
} from "./command-result.js";

const PRD_USAGE = `rickgent prd — interactive PRD interview with --non-interactive template mode

Usage:
  rickgent prd [--non-interactive] [options]

Modes:
  interactive (default)   Spawns an omnigent run agent that interviews the user,
                          explores the codebase, and drafts prd.md with
                          machine-checkable acceptance criteria.
  --non-interactive       Emits the PRD template to --output (default
                          .rickgent/prd.md) and validates --from as an executable
                          TicketContract PRD and via evaluatePrd.
                          No agent is spawned; stdin is never read.

Options:
  --from <file>           Validate an existing executable PRD file (fail-closed
                          on missing file, TicketContract, or PRD errors).
  --non-interactive       Template mode — no agent, no stdin.
  --repo <dir>            Target git repo (default: RICKGENT_TARGET_REPO or cwd).
  --agent <dir>           omnigent agent bundle directory (required in interactive
                          mode; ignored in --non-interactive mode).
  --output <path>         Write the template/PRD to this path (default:
                          .rickgent/prd.md under the working dir or RICKGENT_DIR).
`;

// ── Canonical PRD template ───────────────────────────────────────────────
//
// This is a complete strict executable PRD, not a legacy planning-only sketch.
// Emitted into a clean repository, it passes the same TicketContract adapter
// consumed by build and contains one nonterminal example ticket.
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
Each criterion carries structured argv-only verification and interface references.

### AC-TEMPLATE-01: example output exists
- **interfaceIds:** \`["INTERFACE-TEMPLATE"]\`
- **verifications:** \`[{"id":"VERIFY-TEMPLATE-01","executable":"test","args":["-f","rickgent-template-output.txt"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]\`
- **scope:** \`rickgent-template-output.txt\`
- **type:** test

## Tickets

### Ticket 01: create the example output
- **description:** Create the example output file; replace this ticket with the real atomic implementation task.
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"rickgent-template-output.txt","change_kind":"create","directory":false}]\`
- **interfaces:** \`[{"id":"INTERFACE-TEMPLATE","direction":"provides","path":"rickgent-template-output.txt","owner":"t01","description":"Example output contract"}]\`
- **acceptanceCriteria:** \`["AC-TEMPLATE-01"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`

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
- Risk: the example output path conflicts with repository content → Mitigation: replace the example ticket and path before implementation.
- Risk: template drifts from executable admission → Mitigation: emission runs the production TicketContract adapter before reporting success.
- Risk: interactive agent produces planning-only criteria → Mitigation: the interview prompt requires strict structured criteria and tickets.

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
    "  ## Acceptance Criteria — each ### AC-<LOCAL-ID> section MUST have:",
    "    - **interfaceIds:** <compact JSON string array>",
    "    - **verifications:** <compact JSON array of argv-only verification objects>",
    "    - **scope:** <repository-relative file paths>",
    "    - **type:** test|lint|grep",
    "  ## Tickets — each ### Ticket NN section MUST have:",
    "    - **description:** <atomic implementation outcome>",
    "    - **dependsOn:** <compact JSON ticket-ID array>",
    "    - **scope:** <compact JSON scope array with change_kind and directory>",
    "    - **interfaces:** <compact JSON interface array>",
    "    - **acceptanceCriteria:** <compact JSON AC-ID array>",
    "    - **budgets:** <compact JSON bounded budget object>",
    "  ## Test Expectations (Unit / Integration / Edge Cases)",
    "  ## Risks",
    "  ## Simplification Review",
    "    Reviewed: yes",
    "    Notes: <what was subtracted before adding>",
    "",
    "Every acceptance criterion MUST have non-empty structured verifications and scope.",
    "Verification executable and args are separate; never encode a shell command string.",
    "Network must be denied and writable outputs must be declared explicitly.",
    "The PRD must pass executable TicketContract admission and evaluatePrd.",
  ];
  if (fromFile) {
    lines.push("");
    lines.push(`## Existing PRD to adopt/refine: ${fromFile}`);
    lines.push("Read the existing PRD, validate its content, and use it as the basis for the interview.");
  }
  return lines.join("\n");
}

export async function runPrdCommand(
  rest: string[],
): Promise<LifecycleCommandResult> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(PRD_USAGE);
    return lifecycleCommandSucceeded();
  }

  const nonInteractive = rest.includes("--non-interactive");
  const fromFile = flagValue(rest, "--from");
  // `--from` changes the interview prompt; it does not make the interview
  // non-agentic. Only template emission is a capability-free path.
  if (!nonInteractive) {
    RUNTIME_CAPABILITY_GATE.require("autonomous_dispatch");
  }
  const outputFlag = flagValue(rest, "--output");
  const repoFlag = flagValue(rest, "--repo");
  const agentFlag = flagValue(rest, "--agent");

  // ── Resolve repo (working dir) ────────────────────────────────────────
  const workingDir = resolve(repoFlag ?? process.env.RICKGENT_TARGET_REPO ?? process.cwd());
  if (!isDir(workingDir)) {
    failLifecycleCommand(`rickgent prd: repo not found: ${workingDir}`);
  }

  const rickgentDir = getRickgentDir();
  const outputPath = outputFlag ? resolve(outputFlag) : join(rickgentDir, "prd.md");

  // ── --from validation (fail-closed BEFORE emitting template) ──────────
  if (fromFile) {
    if (!existsSync(fromFile)) {
      failLifecycleCommand(`rickgent prd: --from file not found: ${fromFile}`);
    }
    let parsed;
    try {
      parsed = parseExecutablePrdFile(fromFile, { repositoryRoot: workingDir });
    } catch (err) {
      failLifecycleCommand(
        `rickgent prd: --from file could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const verdict = evaluatePrd(parsed.prd);
    if (!verdict.valid) {
      failLifecycleCommand([
        "rickgent prd: --from PRD failed evaluatePrd validation:",
        ...verdict.errors.map((error) => `  - ${error}`),
      ].join("\n"));
    }
    console.log(
      `rickgent prd: --from ${fromFile} passed executable TicketContract and evaluatePrd validation.`,
    );
  }

  if (nonInteractive) {
    // ── Non-interactive: emit template, no agent, no stdin ─────────────
    let admittedTemplate;
    try {
      admittedTemplate = parseExecutablePrdMarkdown(PRD_TEMPLATE, {
        repositoryRoot: workingDir,
      });
    } catch (err) {
      failLifecycleCommand(
        `rickgent prd: template failed executable admission before write: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // A caller-selected PRD destination cannot also be implementation scope:
    // writing the PRD would immediately invalidate its own `create` contract.
    try {
      const outputIdentity = resolveFilesystemIdentity(outputPath);
      const collidingScope = admittedTemplate.contracts
        .flatMap((contract) => contract.scope)
        .find((entry) => {
          const scopeIdentity = resolveFilesystemIdentity(
            resolve(workingDir, ...entry.path.split("/")),
          );
          return filesystemIdentitiesOverlap(outputIdentity, scopeIdentity);
        });
      if (collidingScope !== undefined) {
        failLifecycleCommand(
          `rickgent prd: output path overlaps template implementation scope: ${collidingScope.path}`,
        );
      }
    } catch (error) {
      if (error instanceof LifecycleCommandError) throw error;
      failLifecycleCommand(
        `rickgent prd: output path identity failed before write: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

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
    return lifecycleCommandSucceeded();
  }

  // ── Interactive mode: requires --agent (explicit, no default fallback) ─
  // VAL-PRD-008: fails closed when --agent is missing in interactive mode.
  const agentRaw = agentFlag ?? process.env.RICKGENT_AGENT_DIR;
  if (!agentRaw) {
    failLifecycleCommand("rickgent prd: --agent <dir> is required in interactive mode");
  }
  const agentDir = resolve(agentRaw);
  if (!isDir(agentDir)) {
    failLifecycleCommand(`rickgent prd: missing agent directory: ${agentDir}`);
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
    failLifecycleCommand(`rickgent prd: failed to spawn interview agent: ${res.error.message}`);
  }
  if (res.status !== 0 && res.status !== null) {
    console.error(`rickgent prd: interview agent exited with code ${res.status}`);
    return lifecycleCommandCompleted(res.status);
  }

  console.log(`rickgent prd: interview complete. PRD should be at ${outputPath}`);
  return lifecycleCommandSucceeded();
}
