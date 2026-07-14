# CLAUDE.md

Rickgent is an autonomous, multi-vendor engineering platform: give it a PRD, it decomposes the work into atomic tickets, dispatches AI agents through a strictly gated nine-gate pipeline, enforces fail-closed policy guardrails at every step, and converges on a merge-ready pull request with zero required human interventions between the PRD, plan, and merge gates. This repository contains the TypeScript orchestrator, the Python policy shims, the omnigent agent bundles, and a legacy differential conformance harness.

The platform is built around one discipline: **git-tree-truth outranks exit codes, which outrank logs, which outrank model claims.** A model that says "I'm done" is not evidence. The repository state is.

## Installation

Prerequisites (tested versions in parentheses):

| Dependency        | Minimum   |
| ----------------- | --------- |
| Node.js           | 24+ (v24.13.1) |
| pnpm              | 10+ (10.22.0) |
| Python            | 3.12+ (3.14.3) |
| omnigent          | 0.6.0.dev0 (editable, read-only) |
| rickgent_policies | editable  |

Always export PATH first for any node/pnpm command:

```bash
export PATH="/Users/gregorydickson/.nvm/versions/node/v24.13.1/bin:/Users/gregorydickson/.local/share/pnpm:$PATH"
```

```bash
# 1. Install omnigent first (hard runtime dependency — rickgent dispatches via `omnigent run`)
#    Clone from https://github.com/gregorydickson/omnigent if not already present
cd /path/to/omnigent && pip install -e .

# 2. Install orchestrator dependencies
cd orchestrator && pnpm install

# 3. Install Python policy shims (editable)
cd ../rickgent-policies && pip install -e .
```

**omnigent is a hard runtime dependency.** Without it installed, `rickgent build` cannot dispatch agents. The `rickgent doctor` command checks for omnigent importability and will exit 1 if it's missing.

### Build

```bash
cd orchestrator && pnpm build
```

### Verify

```bash
# TypeScript
cd orchestrator
pnpm typecheck
pnpm vitest run --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism

# Python policies
cd ../rickgent-policies
python3 -m pytest test/ -p no:cacheprovider
```

`pnpm lint` (eslint) is intentionally unconfigured and out of scope. Do not attempt to fix or run it.

## CLI Commands

Entry point: `orchestrator/src/cli.ts`. Run the built binary via `node orchestrator/dist/cli.js <command>`.

| Command | Flags | Description |
| --- | --- | --- |
| `rickgent` | (none) | Launch the default agent (interactive) |
| `rickgent prd` | `--from <file>` | PRD interview; adopt an existing PRD file |
| `rickgent refine <prd.md>` | `--run` | 3-analyst refinement + ticket decomposition; `--run` auto-launches |
| `rickgent build <prd>` | `--repo <dir>`, `--agent <dir>`, `--feature <branch>`, `--max-concurrent <n>`, `--roster <file>`, `--cost-budget <usd>`, `--soft-threshold <usd>`, `--resume`, `--no-autonomous-pr`, `--max-iterations N` | Implement all tickets through the 8-phase loop |
| `rickgent pipeline <prd>` | same flags as `build` | Full lifecycle: build + convergence + reconcile cleanup |
| `rickgent metrics` | `--json` | Report interventions/run and rolling matured-PR quality |
| `rickgent status` | `--deep` | Print session phase + ticket status; `--deep` runs doctor first |
| `rickgent reconcile` | (none) | Rebuild registry from git + dispatch ledger |
| `rickgent doctor` | (none) | Behavioral smoke test (build_commit, omnigent import, policies, attachments) |
| `rickgent verdict <check>` | `--json` | Run a single verdict-core check with JSON stdin/stdout |
| `rickgent --version` | | Print version + build commit |
| `rickgent --build-commit` | | Print build commit only |
| `rickgent --help` | | Show usage |

Not-yet-implemented commands (stubbed, exit 1): `citadel`, `szechuan`, `anatomy`, `microverse`, `cronenberg`. See `cli.ts` USAGE for their planned flags.

## Running a Build

1. Prepare a PRD markdown file (see `rickgent prd` for the interview, or `rickgent refine` to decompose an existing PRD).
2. Run the build against a target repo:
   ```bash
   rickgent build path/to/prd.md --repo /path/to/repo
   ```
3. What happens: ticket decomposition → FIFO dispatch queue (backpressure) → per-ticket 8-phase lifecycle → 9-gate pipeline (policy attachment, evidence dispatch, salvage, cross-vendor review, conformance, deslop, merge, circuit breaker, convergence) → PR creation.
4. Resume after interruption:
   ```bash
   rickgent build --resume
   ```
   The dispatch ledger is durable and append-only; resume replays from ledger + git state, no lost or duplicate work.
5. Run the full pipeline (build + convergence + reconcile cleanup):
   ```bash
   rickgent pipeline path/to/prd.md --repo /path/to/repo
   ```
6. Tune concurrency (default 2) to meter spend:
   ```bash
   rickgent build path/to/prd.md --repo /path/to/repo --max-concurrent 2
   ```

Failures are absorbed by salvage, the circuit breaker, and reconciliation, not by prompting a human. The only human gates are PRD, plan, and merge.

## Monitoring

All run state lives in `.rickgent/` under the working directory (override via `RICKGENT_DIR`).

| File | Purpose |
| --- | --- |
| `registry.json` | Session state: runId, ticket phases, attempts, completion commits |
| `dispatch-ledger.jsonl` | Append-only dispatch ledger (one record per dispatch) |
| `runs.jsonl` | One record per build run start (metrics denominator) |
| `interventions.jsonl` | One record per human-gate hit (the autonomy metric, target 0) |
| `prs.jsonl` | Durable PR ledger for rolling quality measurement |
| `defects.jsonl` | Defect ledger; late defects reopen matured PRs |
| `omnigent-data/` | omnigent SQLite data dir (override via `OMNIGENT_DATA_DIR`) |

Commands to observe state:

```bash
rickgent status              # pipeline state + per-ticket phase/attempt/commit
rickgent status --deep       # doctor smoke test + status
rickgent metrics             # interventions/run + rolling matured-PR quality %
rickgent metrics --json      # machine-readable metrics
rickgent doctor              # behavioral smoke test (exits 1 on failure)
```

Circuit breaker state: when OPEN, deferred tickets are absorbed (not prompted) and the queue keeps draining. Tickets deferred because the breaker was OPEN at spawn time are reported in the build summary as `circuit breaker OPEN — deferred (absorbed, no prompt)`. Set `RICKGENT_ORPHAN_REAP=off` to disable the orphan reaper.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `RICKGENT_MAX_CONCURRENT` | Max concurrent dispatches | `2` |
| `RICKGENT_MODEL_ROSTER` | JSON model roster for routing | - |
| `RICKGENT_COST_BUDGET_USD` | Hard cost budget per dispatch | - |
| `RICKGENT_SOFT_THRESHOLD_USD` | Soft cost threshold (triggers `ASK`) | - |
| `RICKGENT_MATURITY_WINDOW_DAYS` | PR maturity window for metrics (test override only) | `14` |
| `RICKGENT_BIN` | Override rickgent binary path | - |
| `RICKGENT_BUILD_COMMIT` | Override build commit | - |
| `RICKGENT_DIR` | Override `.rickgent` directory location | `<cwd>/.rickgent` |
| `RICKGENT_TARGET_REPO` | Default target repo for `build`/`pipeline` | cwd |
| `RICKGENT_AGENT_DIR` | Default agent bundle dir | `../agents/rickgent` |
| `RICKGENT_FEATURE_BRANCH` | Feature branch override | - |
| `RICKGENT_AUTONOMOUS_PR_FLOW` | Set to `0` to disable autonomous PR flow | enabled |
| `RICKGENT_ORPHAN_REAP` | Set to `off` to disable orphan reaper | enabled |
| `OMNIGENT_DATA_DIR` | Override omnigent data directory | `<rickgentDir>/omnigent-data` |

## Architecture Quick Reference

```
rickgent CLI (orchestrator/src/cli.ts)
   |
   +-- VERDICT CORE (pure TS, no I/O)  orchestrator/src/core/*
   |     completion, convergence, scope, prd, salvage, breaker, verdict-cli
   |
   +-- LIFECYCLE (TS)                  orchestrator/src/lifecycle/*
   |     build, microverse, salvage, reconcile, registry, orphan-reaper, doctor, metrics, routing
   |
   +-- DISPATCH (TS)                   orchestrator/src/dispatch/*
         DispatchLedger, TicketLock, Dispatcher -> `omnigent run <agentDir> -p <prompt>`
               |
               v
         omnigent runtime (READ-ONLY, 0.6.0.dev0)
         bundles attach policies via `guardrails:` block
               |
               v
         POLICY SHIMS (pure Python)    rickgent-policies/rickgent_policies/__init__.py
         scope_fence, completion_evidence, convergence_gate,
         subtract_before_add, cross_vendor_review, autonomous_pr_flow
         (+ omnigent builtin blast_radius) + select_model router
```

Key invariants (non-negotiable):

- **Git-tree-truth > exit code > logs > model claims.** The repository state is the source of truth.
- **Every gate that ran zero checks did not pass.** Silence is not success.
- **One oracle, one matcher.** A single completion predicate; a single `isPathInScope`. Never write a second matcher, even for report filtering or git-delta filtering.
- **Abstain (`None`) for inapplicable policies, never `ALLOW`.**
- **Fail closed, everywhere.** Missing/malformed/unresolvable/exception/timeout → DENY. No bypass flags in production.
- Policy composition: `DENY > ASK > ALLOW`. First DENY short-circuits. Any policy exception fails closed to DENY.

## Testing

```bash
# TypeScript (run from orchestrator/)
pnpm vitest run --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism

# Python (run from rickgent-policies/)
python3 -m pytest test/ -p no:cacheprovider
```

`--no-file-parallelism` is required: vitest module-isolation races under high concurrency contaminate cross-file state.

Specific test files for key areas:

| Area | Test file |
| --- | --- |
| 9-gate end-to-end pipeline | `orchestrator/test/lifecycle/e2e-gated-pipeline.test.ts` |
| Build loop | `orchestrator/test/lifecycle/build-loop.test.ts` |
| Backpressure queue | `orchestrator/test/lifecycle/backpressure-queue.test.ts` |
| Microverse convergence | `orchestrator/test/lifecycle/microverse.test.ts`, `microverse-loop.test.ts`, `microverse-loop-hardening.test.ts` |
| Salvage + reconcile | `orchestrator/test/lifecycle/salvage-reconcile-b6.test.ts`, `reconcile.test.ts` |
| Metrics | `orchestrator/test/lifecycle/metrics.test.ts` |
| Orphan reaper | `orchestrator/test/lifecycle/orphan-reaper.test.ts` |
| Doctor / attachment | `orchestrator/test/lifecycle/doctor-attachment.test.ts` |
| CLI commands | `orchestrator/test/lifecycle/cli-commands.test.ts` |
| Conformance (legacy differential) | `orchestrator/test/conformance/` |
| Core verdicts | `orchestrator/test/core/` |

Always prefix piped validator commands with `set -o pipefail` so the true exit code is preserved (e.g. `set -o pipefail; pnpm vitest run foo | tail -20`).

## Key Files and Directories

| Path | What lives there |
| --- | --- |
| `orchestrator/src/cli.ts` | CLI entrypoint (command/flag parsing) |
| `orchestrator/src/core/` | Pure verdict core: `completion/`, `convergence/`, `scope/`, `prd/`, `salvage/`, `breaker/`, `verdict-cli/` |
| `orchestrator/src/lifecycle/` | `build/`, `microverse/`, `salvage/`, `reconcile/`, `registry/`, `orphan-reaper/`, `doctor/`, `metrics/`, `routing/`, `pr-flow/` |
| `orchestrator/src/dispatch/` | `dispatch.ts` (ledger, lock, Dispatcher), `queue.ts` (backpressure), `evidence.ts` |
| `orchestrator/src/fom.ts` | FOM disciplines (salvage/breaker guard heuristic) |
| `rickgent-policies/rickgent_policies/__init__.py` | 6 policy shims + `select_model` router + `POLICY_REGISTRY` |
| `agents/rickgent/config.yaml` | Manager agent bundle |
| `agents/rickgent/agents/worker/config.yaml` | Worker agent bundle (no ad-hoc `sys_os_shell` writes) |
| `conformance/legacy-reference/` | Legacy differential harness (reconstructed from `pickle-rick-claude@95f5c416` via `git show`) |
| `docs/decisions/` | Architecture Decision Records |
| `orchestrator/test/fixtures/omnigent-fixture/` | Deterministic fixture omnigent for automated validation |

## Coding Conventions

When modifying rickgent code, follow these rules (from `AGENTS.md`, enforced across the codebase):

1. **Fail closed, everywhere.** Missing/malformed/unresolvable/exception/timeout → DENY. No bypass flags in production. No two escape hatches for one guard.
2. **Git-tree-truth > exit code > logs > model claims.** A worker/CLI saying "done" is not evidence.
3. **Silence is not success.** A gate that ran zero checks did not pass. A test that passes with the guard deleted is not a test.
4. **One oracle, one matcher.** Reuse `isPathInScope` for all path-scoping logic (security, report filtering, git-delta filtering, convergence owned-path matching). Never a second matcher or parallel verdict.
5. **Abstain (`None`) for inapplicable policies, never `ALLOW`.**
6. **TDD with a failing test first.** Every fix/feature ships a test that fails against the unfixed/unbuilt code, then passes. Capture proof the test was red first.
7. **Don't rewrite the six core algorithms** (`completion`, `convergence`, `scope`, `prd`, `salvage`, `breaker`) beyond enumerated defects.
8. **TS↔Python parity.** Scope canonicalization and `build_commit` must agree across languages; pin parity with shared fixtures.
9. **Owned-paths-only git staging.** Never `git add -A`. Use `execFileSync("git", ["add", "--", path])` with array argv, never shell string interpolation.
10. **Verify at the production entrypoint, not just helper level.** Drive the real code path and observe the real effect (git delta, DB row, signal, exit code), not a mock's return. A helper-level test passing while the runtime enforcement path stays vulnerable is a scrutiny failure.
11. **Use `execFileSync` with array argv.** Never shell strings for spawning processes.
12. **Use `set -o pipefail` in shell pipelines** so a failing validator is not masked by `tail`/`grep`/`head`.
13. **No new runtime dependencies** without a decision doc. `omnigent` is pinned at 0.6.0.dev0 and READ-ONLY.
14. **Edit scope:** write only inside `rickgent/`. `omnigent/` is read-only; `pickle-rick-claude/` is a live pipeline, access the legacy reference ONLY via `git -C <repo> show 95f5c416:<path>`, never checkout/build/run it.

## Decision Records

Architectural rationale is recorded in `docs/decisions/`. Load-bearing ADRs for the current mission include `microverse.md` (convergence semantics: plateau/diminishing-delta + target-threshold), `scope-fence.md` (worker drops ad-hoc shell writes; unresolvable targets DENY), `metrics.md` (14-day maturity window, rolling quality), `build-loop.md` (autonomous loop, consecutive-clean requirement), `breaker-normalization.md`, `model-routing.md`, `sandboxing.md`, `legacy-differential.md`, and `convergence-gate.md` (advisory on `rickgent_phase_advance`, blocking on `rickgent_build_gate`). Read the relevant ADR before changing behavior it defines.
