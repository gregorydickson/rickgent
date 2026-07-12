# Decision: Citadel (Conformance Audit)

## Component
§2 matrix row "Citadel (conformance audit)" (lifecycle components — Pickle Rick likely wins).

## Omnigent implementation
Nothing. A grep for `citadel` over `/Users/gregorydickson/loanlight/pickle-rick/omnigent` returns no matches. Omnigent's policy framework (`omnigent.policies.builtins`, FunctionPolicy factories, CEL, registry) is a generic enforcement substrate — it can fence a tool call with ALLOW/DENY/ASK verdicts, but it has no concept of a PRD, an acceptance criterion, a branch-diff conformance audit, a trap door catalog, or a mechanical-finding classifier. Citadel's intelligence has to be supplied entirely by Rickgent.

## Pickle Rick implementation
Citadel is a post-implementation conformance audit that reads the PRD, walks the branch diff, catalogues trap doors, classifies findings, and emits a versioned JSON report. It has both a prompt-skill surface and a substantial TypeScript runtime.

**Prompt skill:**
- `.claude/commands/citadel.md` — the `/citadel` command (`citadel.md:1-95`). Invoked after implementation and before deeper review phases. Arguments: `--prd <path>`, `--diff <base..head>` (defaults to `state.start_commit..HEAD`), `--strict` (exit non-zero on High findings as well as Critical), `--report <path>`, `--print-stubs` (print `node:test` skeletons for unguarded trap doors without modifying files). The skill surfaces findings only; it does not auto-edit source. It also carries the R-CLOSER-ADJACENCY-AUDIT 6-step checklist (`citadel.md:45-95`) — adjacent-path enumeration, adjacent-mode enumeration, trap-door delta, cross-module importer check, stamp-pair parity, pre-flight context grep — that catches the adjacent-mode bug class missed by R-WUWC / R-CCQF / R-PEDC / R-RIC-EXPLICIT closers.

**TS runtime (`extension/src/services/citadel/`):**
- `audit-runner.ts` — the orchestrator. `runCitadelAudit(options)` builds the report and writes `<session>/citadel_report.json` (`audit-runner.ts:64-70`). Imports 18 sub-audits (`audit-runner.ts:5-28`): `auditAcShape`, `auditSiblingAuthPreconditions`, `auditFrontendPropDrift`, `walkDiff`, `auditRuleSetInvariants`, `auditDiffHygiene`, `reconcileDivergences`, `parseWithComposes`, `detectProjectShapes`, `buildAcCoverageScorecard`, `detectAllowlistDeadEntries`, `auditStateTransitions`, `auditTrapDoorCoverage`, `checkEndpointContractConformance`, `auditSchemaRegistryDrift`, `auditTestAuthenticity`, `auditStaleReferences`, `auditCrossfileBehaviorDrift`, `auditBannedConstructs`, `auditBannedCasts`, `auditPatternConformance`, `runSkepticLens`. Also defines `CrossPhaseFinding` to ingest findings from `anatomy-park.json` / `szechuan-sauce.json` (`audit-runner.ts:32-46`).
- `prd-parser.ts` — parses the PRD into `ParsedPrd` (decisions, ACs, endpoints, allowlist entries, status code rows, transition audit rows, composed rcodes) with `composes:` cycle/depth/glob guards (`prd-parser.ts:3-57,59-87`). See `prd-ticket-decomposition.md` for the full citation set; citadel is the primary downstream consumer of this parser.
- `mechanical-finding-classifier.ts` — classifies whether a finding is deterministically fixable. `MECHANICAL_FINDING_MATCHERS` is an extensible array (`mechanical-finding-classifier.ts:22-31`); today exactly one matcher: `banned-construct:brace-free-if`. `isMechanicalCitadelFinding` returns false for any Critical finding regardless of id, so a brace-free-if escalated to Critical is never auto-remediated (`:33-42`).
- `trap-door-coverage-audit.ts` — `auditTrapDoorCoverage(diff)` walks the diff's CLAUDE.md and test files and matches `ENFORCE: \`file.test.js#anchor\`` references against changed files (`trap-door-coverage-audit.ts:35-40`, `:28` for `ENFORCE_REF_RE`).
- `reporter.ts` — the report schema. `CitadelSeverity = 'Critical' | 'High' | 'Medium' | 'Low'` (`reporter.ts:1`); `CitadelFinding` carries `id`, `severity`, `acId?`, `trapDoorId?`, `evidence?`, `file?`, `line?` (`:8-19`); `CitadelJsonReport` is versioned `schema: '1.0'` with `prd_path`, `diff_range`, `exit_code` (`:28-40`).
- Supporting audits: `ac-coverage-scorecard.ts`, `ac-shape-audit.ts`, `allowlist-dead-entry-detector.ts`, `banned-casts-audit.ts`, `banned-constructs-audit.ts`, `crossfile-behavior-drift-audit.ts`, `diff-hygiene.ts`, `diff-walker.ts`, `divergence-reconciliation.ts`, `endpoint-contract-conformance.ts`, `frontend-prop-drift-audit.ts`, `pattern-conformance-audit.ts`, `rule-set-invariant-audit.ts`, `schema-registry-drift-audit.ts`, `sibling-auth-audit.ts`, `skeptic-lens.ts`, `stale-reference-audit.ts`, `state-transition-audit.ts`, `test-authenticity-audit.ts`, `trap-doors-section.ts`, `citadel-findings-to-gate-result.ts`.

## Contract
Citadel audits the current branch against a PRD and reports branch-wide conformance findings. It runs after implementation and before deeper review phases.

**Invariants:**
- Reads PRD, changed files, command/session state, and sibling phase artifacts (`anatomy-park.json`, `szechuan-sauce.json`) when present.
- Report is versioned JSON (`schema: "1.0"`) with `prd_path`, `diff_range`, `exit_code`, plus a console summary grouped by Citadel section.
- Findings carry stable IDs (`id`), severity (`Critical|High|Medium|Low`), and optional `acId` / `trapDoorId` joins back to the PRD and trap door catalog.
- Surfaces findings only; does not auto-edit source. The `--print-stubs` flag prints `node:test` skeletons for unguarded trap doors without modifying files.
- A finding is "mechanical" (deterministically fixable) IFF it matches a `MECHANICAL_FINDING_MATCHERS` entry AND severity ≠ Critical. Mechanical findings can route to a gate-remediator; judgement-required findings stay non-mechanical.
- `--strict` escalates the exit code: non-zero on High findings as well as Critical.

**Failure modes:**
- Missing PRD: `--prd` required unless invoked by a pipeline session with `state.prd_path`.
- Stale diff range: defaults to `state.start_commit..HEAD`; if `state.start_commit` is absent the caller must pass `--diff`.
- Cross-phase finding collision: `anatomy-park.json` / `szechuan-sauce.json` findings are deduped by ID, with duplicate IDs renamed and counted in the summary.
- Critical-severity mechanical finding: a brace-free-if escalated to Critical classifies false on `isMechanicalCitadelFinding` and is never auto-remediated.

## Evaluation
Pickle Rick is unambiguously the better source. Omnigent has no PRD conformance model at all. Citadel's value is the 18-audit surface plus the mechanical-finding classifier plus the cross-phase finding ingest — none of which has an Omnigent analogue. The prompt skill (`citadel.md`) is harness-agnostic (it reads files and runs shell commands) and ports cleanly as a Rickgent agent skill. The TS runtime is pure file/diff/regex work with no tmux and no claude-CLI coupling, so it ports into the Rickgent TS product directly. The AC verification commands can run via Omnigent's `sys_os_shell` (confirmed available in §2.1.1's policy framework validation), so the per-AC verify step survives the move to Omnigent dispatch. The trap door catalog works by scanning `CLAUDE.md` files for `ENFORCE:` references and joining them against the diff's changed test files — a pure file/regex operation that ports as-is.

## §2.2.1 Finding
No specific §2.2.1 finding for citadel — investigated fresh. The §2.2.1 validation pass confirmed the named runtime artifacts for other components (`microverse-runner.ts`, `convergence-gate.ts`, etc.) but did not enumerate the citadel audit surface. This decision file is the fresh investigation: citadel's `audit-runner.ts` imports 18 sub-audits (`audit-runner.ts:5-28`), the `mechanical-finding-classifier.ts` ships one matcher (`mechanical-finding-classifier.ts:22-31`), the reporter schema is `1.0` (`reporter.ts:28-40`), and the trap door coverage audit matches `ENFORCE:` references (`trap-door-coverage-audit.ts:28,35-40`). All citations verified against HEAD `95f5c416`.

## Decision: port
PORT (Pickle Rick) — port as a Rickgent agent skill (the `/citadel` prompt) plus a TS verification runner (the `services/citadel/` directory) refactored into the Rickgent orchestrator.

## Reasoning
Citadel is the conformance backbone of the lifecycle — it is what turns "the spec IS the review" from a slogan into a machine-checkable audit. Omnigent contributes nothing here, so the decision is port, not mash.

The port has two layers:

1. **Prompt skill** — `.claude/commands/citadel.md` becomes a Rickgent agent skill with the `node "$HOME/.claude/pickle-rick/extension/bin/..."` bootstrap calls re-pointed at the `rickgent` CLI. The R-CLOSER-ADJACENCY-AUDIT 6-step checklist (`citadel.md:45-95`) is preserved verbatim — it is a high-value, low-cost grep checklist that catches the adjacent-mode bug class. The `--strict`, `--report`, `--print-stubs` flags map directly onto `rickgent citadel` CLI flags.

2. **TS verification runner** — the `extension/src/services/citadel/` directory ports into `orchestrator/src/lifecycle/citadel/` (or equivalent). The 18 sub-audits are pure file/diff/regex operations with no tmux and no claude-CLI coupling, so they port as-is. `prd-parser.ts` is shared with the PRD/decomposition component (see `prd-ticket-decomposition.md`) and lands in a shared `core/prd/` location. `audit-runner.ts`'s `runCitadelAudit` becomes the `rickgent citadel` command's implementation. The `CitadelJsonReport` schema stays at `1.0` so existing report consumers continue to work.

The mechanical-finding classifier (`mechanical-finding-classifier.ts`) ports with its extensible-matcher design intact — adding a new mechanical class is a new array entry, not a branch edit. The cross-phase finding ingest (`CrossPhaseFinding` for `anatomy-park.json` / `szechuan-sauce.json`) ports as-is because anatomy-park and szechuan-sauce are also being ported (see their decision files).

The AC verification commands (the per-AC `Verification` column from the PRD) run via Omnigent's `sys_os_shell` — confirmed available in §2.1.1 — so the verify step survives the move from in-process `execFileSync` to Omnigent dispatch. The trap door catalog (`ENFORCE:` reference matching) is a pure file/regex operation and ports unchanged.

The only Rickgent-specific addition is a policy hook at the Omnigent seam that fences `rickgent citadel` as a `tool_call` policy (per §2.1.1's closed policy event vocabulary) so the audit cannot be skipped by a worker mid-pipeline.
