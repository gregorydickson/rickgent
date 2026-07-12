---
title: "Rickgent — Building Pickle Rick's Lifecycle on Omnigent as an Autonomous, Multi-Model Engineering Platform"
codename: rickgent
parents:
  - omnigent 0.6.0.dev0 (Databricks, Apache-2.0, alpha; latest release v0.5.0) — meta-harness, Python, multi-agent infrastructure
  - pickle-rick-claude v2.1 / experiment/fable-operating-manual (autonomous engineering lifecycle, TypeScript, FOM)
priority: P1
status: mission-definition (premises source-validated + 3 adversarial review rounds applied 2026-07-12; language plan revised same day — Rust kernel deferred to v0.2; Phase 0 component investigation still required)
implementer: GLM 5.2, fresh session — this document is the sole build contract; read §16 first
type: package-and-extend (fork only on a proven trigger — see §10.1)
target_version: v0.1.0-alpha
goals:
  - natively multi-model
  - hands-off execution between three human gates (PRD, plan, merge)
  - reliable, not brittle
  - measured PR quality, target 99% (defined in §5.4)
design_principle: "Investigate which system has the better tool for each component, then mash them together."
---

# Rickgent — Building Pickle Rick's Lifecycle on Omnigent as an Autonomous, Multi-Model Engineering Platform

> *"Morty grew up. Now he runs the lab."*

## 0. Mission statement

Build Pickle Rick's autonomous engineering lifecycle on top of Omnigent as a two-language layer (not a fork — see §10.1): a **TypeScript product** — orchestrator plus verdict core, refactored (not rewritten) from the battle-tested pickle-rick TS — and a **thin pure-Python policy shim** at omnigent's enforcement seam (§10.9), dispatching workers via `omnigent run` one-shots (§10.10). A Rust verdict kernel is a deliberate v0.2 extraction option, not a v0.1 component (§10.9). Omnigent (a Databricks Apache-2.0 meta-harness, alpha; v0.5.0 released, 0.6.0.dev0 in development) already exposes the extension points the lifecycle needs: dotted-path policy handlers, a `policy_modules` registry allowlist, user-supplied agent bundles with skills, and an importable CLI entry point. The result is **Rickgent** — a single product that combines Omnigent's multi-harness infrastructure with Pickle Rick's PRD-driven lifecycle, the Fable Operating Manual's epistemic discipline, and hard-won reliability engineering.

**Design principle:** For each component, investigate which system has the better tool, then mash them together. Do not assume Omnigent is always better (it wins on infrastructure) or Pickle Rick is always better (it wins on lifecycle logic). Evaluate both implementations, choose the best, and integrate.

**Four goals, in priority order:**

1. **Natively multi-model** — workers dispatch to any available harness; cross-vendor review is default; model routing is automatic
2. **Hands-off execution** — zero required human interventions between the three deliberate gates (PRD approval, plan gate, merge); salvage, recovery, and circuit breakers absorb the failures that would otherwise page a human. Interventions are counted and reported per run — the autonomy metric is interventions/run, target 0
3. **Reliable, not brittle** — the FOM's "subtract before you add" discipline baked into platform defaults; single completion oracle; no guards-on-guards
4. **PR quality, measured** — cross-vendor review on every PR, conformance audit against acceptance criteria, deslopping pass, subsystem review, convergence gates; quality is a defined metric (§5.4), target 99%, never an assertion

---

## 1. Architecture: package and extend

### 1.1 Layer separation

```
rickgent/                          # monorepo (omnigent is an external dependency, pinned)
├── orchestrator/                  # TypeScript product (refactored from pickle-rick TS)
│   ├── package.json               # bin: rickgent
│   ├── src/
│   │   ├── cli.ts                 # `rickgent prd|refine|build|citadel|szechuan|status|verdict|reconcile|doctor|…`
│   │   ├── fom.ts                 # FOM calibration text + programmatic access
│   │   ├── core/                  # verdict core (§10.9): completion oracle, salvage decisions,
│   │   │                          #   scope fence math, convergence gate, circuit breaker + ladders
│   │   │                          #   PURE decision functions — no process spawns, no git mutations
│   │   ├── lifecycle/             # phase machine, microverse loop, salvage executor, resume, registry, reconcile
│   │   └── dispatch/              # §10.10.1 protocol: `omnigent run` one-shots, ledger, locks
│   └── test/                      # vitest — core + orchestration tests
├── conformance/                   # language-neutral fixture suite — the portable spec (§10.9)
│   └── fixtures/                  # JSON: repo states, gate outputs, iteration histories → expected verdicts
├── rickgent-policies/             # pure-Python shims (~100–200 LOC total, NO native bindings)
│   ├── pyproject.toml             # deps: omnigent==<pin> only
│   └── rickgent_policies/         # POLICY_REGISTRY → omnigent `policy_modules`; fail-closed (§4, §10.9)
├── agents/                        # rickgent agent bundle(s)
│   └── rickgent/
│       ├── config.yaml            # default agent (FOM-infused prompt, policies block)
│       ├── agents/                # sub-agent configs (per-harness workers)
│       └── skills/                # lifecycle skills (SKILL.md per skill, shipped in the bundle)
├── fixtures/                      # e2e-feature-prd.md + fixture app repo (AC-14/17/18/19 drills)
└── docs/
    ├── FABLE_OPERATING_MANUAL.md
    └── decisions/
```

Upstream Omnigent is a dependency, not a vendored tree. (Validated: `omnigent/spec/`, `inner/`, `runner/`, `policies/`, `server/`, `entities/` all exist as claimed, alongside ~16 more subpackages — notably `tools/builtins/` where the `sys_*` primitives live, and `db/` + `stores/` for persistence.)

### 1.2 Why this layering

**Omnigent stays upstream.** We depend on a pinned release and upgrade deliberately; there is no vendored tree to keep merged. Validated extension points (file:line evidence goes in the decision log): custom Python policies via dotted-path `handler:`/`function:` references in trusted specs (`omnigent/policies/function.py`) and via the `policy_modules` registry allowlist that ingests an external package's `POLICY_REGISTRY` (`omnigent/policies/registry.py`); agent configs and skills are user-supplied bundles (`omnigent/spec/AGENTSPEC.md`); the CLI is importable (`omnigent.cli:main`).

**The rickgent layer is the new brain.** One ownership model — **TypeScript owns the product, including the verdict core; Python exists only where omnigent imports it, pure and tiny; Rust is a v0.2 extraction option** (§10.9). It adds:
- Lifecycle runtime + verdict core as full TypeScript implementations (not thin policy wrappers — see Sections 2–3)
- Pure-Python policy shims as enforcement surfaces (scope fence in-process; verdict-needing checks via the `rickgent verdict` CLI — §10.9)
- Skills shipped in the rickgent agent bundle
- A CLI that wraps Omnigent's with lifecycle commands
- The FOM as a platform document + programmatic calibration layer

### 1.3 Why a code lifecycle, not prose-only

The reliability record proved that prose enforcement fails (R-WSRC — a repo trap-door code recorded in pickle-rick-claude's CLAUDE.md and source comments, not in the FOM document itself: "prose alone failed — hooks enforce these"). The machine-verifiable half — completion evidence, scope fencing, convergence gating, salvage — must be enforced by code. But the code also must be **full implementations** with the same depth and semantics as Pickle Rick's TypeScript, not toy policies. The `convergence_gate` in the first PRD draft was "DENY if metric < baseline" — that's a toy. Pickle Rick's actual convergence gate does baseline subtraction, scope filtering, freshness assertion, and zero-check detection. That depth is what we port.

---

## 2. Component investigation matrix — the heart of the mash

For each component, the build investigates both systems' implementation, evaluates which is better (or how to combine), and documents the decision. This section defines the evaluation framework; the build fills in the verdicts.

### 2.1 Infrastructure components — Omnigent likely wins

| Component | Omnigent has | Pickle Rick has | Likely verdict | Investigation questions |
|---|---|---|---|---|
| Worker dispatch | `sys_session_send` to 10+ harnesses (claude, codex, cursor, opencode, hermes, pi, kiro, qwen, goose, kimi) | `spawn-morty.js` — `claude -p` or `codex exec` only | **Omnigent** — natively multi-model, no `--backend` flag | How does Omnigent's `purpose` (implement/review/explore) map to Pickle Rick's worker roles? Does `sys_session_send` support the foreground/synchronous model the FOM requires? |
| Context clearing | Omnigent session isolation (fresh session per dispatch) | tmux kill + respawn (`mux-runner.js`) | **Omnigent** — no tmux, no process management, cleaner | Does Omnigent's session model guarantee context isolation equivalent to Pickle Rick's kill-and-respawn? Any shared state between sessions? |
| Multi-device | Web UI, phone, desktop app, terminal | tmux TUI (monitor.js, log-watcher.js, morty-watcher.js) | **Omnigent** — monitor from anywhere | Can the web UI show ticket/phase status the way the tmux dashboard does? Need a Rickgent dashboard route? |
| Sandboxing | seatbelt (macOS), bwrap (Linux), Job Object (Windows), cloud sandboxes (Modal, Daytona, E2B, K8s) | None — runs in-process on the host | **Omnigent where available** — v0.1 still relies on scope fence where filesystem/network isolation is absent | Can per-ticket workers run in cloud sandboxes? How does git work across sandbox boundaries? |
| Policy framework | `omnigent.policies.builtins` — FunctionPolicy factories, registry, schema, CEL | TypeScript hooks (config-protection.ts, tsc-gate.ts, check-scope-diff.ts, bash-scanner) | **Omnigent** — proper framework, no bash scanning | Can Rickgent's lifecycle policies plug into the existing registry? Does the policy event model support lifecycle events (phase advance, convergence check)? |
| Model routing | `sys_advise_models`, `sys_list_models`, cost advisor, per-agent defaults | `--backend claude\|codex` flag, `PICKLE_BACKEND` env var | **Omnigent** — automatic, multi-vendor | How does `sys_advise_models` decide? Can Rickgent override with task-type heuristics (multi-file → claude, narrow → codex, read-only → pi)? |
| Cross-vendor review | Polly pattern — native, different-vendor reviewer on every PR | `/council-of-ricks` — manual, explicit invocation | **Omnigent** — default, not opt-in | Can Rickgent make cross-vendor review automatic in the ralph loop (not a separate command)? |
| Cost tracking | `omnigent.policies.builtins.cost`, model catalog, per-session spend | `pickle-metrics` — token/commit/LOC reporter | **Mash** — Omnigent infra + Pickle Rick lifecycle-aware metrics | Can Rickgent add ticket/phase-level cost tracking on top of Omnigent's session-level tracking? |
| State management | SQLAlchemy + Alembic, entities, stores, proper DB | `state.json` — atomic file locks, schema versioning, multi-file transactions | **Investigate** — Omnigent has better infra, Pickle Rick has battle-tested crash recovery | Does Omnigent's DB-backed state survive crashes as well as Pickle Rick's atomic-write + lock model? What about session resume? |
| Session resume | `resume_dispatch.py` — fetch conversation, dispatch by wrapper label | `--resume` — read state.json, recompute missing fields, heal pipeline | **ANSWERED — Rickgent needs its own** (see §2.1.1) | ~~Can Omnigent's resume handle mid-pipeline resume?~~ No — conversation/wrapper-level restart only. The rickgent resume layer is a v0.1 requirement. |

#### 2.1.1 Validation findings (pre-build, 2026-07-12)

Explore agents validated the infrastructure claims against the omnigent source. Verdicts, to be carried into the decision log:

- **Worker dispatch — CONFIRMED, with one correction.** `sys_session_send` exists (`omnigent/tools/builtins/spawn.py`); 11 native harnesses (`harness_plugins.py` — the 10 named plus `antigravity`) plus SDK/subprocess executors (`claude_sdk`, `copilot`, `databricks`, `openai_agents_sdk`, …). `purpose` supports implement/review/explore/**search** and is policy-enforced (`headless_subagent_purpose_guard`). **Correction: dispatch is async-only.** The tool returns a handle immediately; results arrive via the `async_work_complete` inbox drain or `sys_read_inbox`. There is no blocking join. (Superseded for the outer loop by §10.10: the external orchestrator dispatches `omnigent run … -p` one-shots and gets synchronous completion via process exit — the FOM's foreground-worker model survives. The inbox model governs agent-internal fan-out only, e.g. refinement analysts.)
- **Context clearing — CONFIRMED.** Per-dispatch conversation + sandboxed subprocess; spawn-tree-scoped reads/writes. No shared in-process state between sessions.
- **Multi-device — CONFIRMED, dashboard deferred.** Real FastAPI server + React web UI + iOS/Android/Electron shells. BUT server routes are hardcoded (`server/app.py`); the plugin system extends harnesses only. An external package cannot add a dashboard route → custom ticket/phase dashboard is deferred (upstream PR or fork trigger, §10.1). v0.1 visibility = session tree + labels + `rickgent status` over registry.json.
- **Sandboxing — CONFIRMED, three caveats.** seatbelt/bwrap/Job Object + cloud backends (modal, daytona, e2b, kubernetes, plus lakebox, boxlite, cwsandbox, islo, openshell). Caveats: (1) Windows Job Object contains process trees but does NOT isolate filesystem/network; (2) git/worktree operations run host-side, scoped to the session's single host/sandbox; (3) `git worktree remove` uses `--force` and discards uncommitted work — **salvage must always run before worktree removal**.
- **Policy framework — CONFIRMED, closed event vocabulary.** FunctionPolicy factories, registry with JSON-schema param validation, CEL, `blast_radius`/`spawn_bounds`/cost builtins all real. The policy event vocabulary is a closed `Literal` (`request | tool_call | tool_result | response | llm_request | llm_response`; verdicts ALLOW/DENY/ASK). Lifecycle gates are therefore modeled as `tool_call` policies on rickgent-owned tools (the orchestrator calls e.g. a `lifecycle_phase_advance` tool; the policy fences it) — no new event types needed.
- **Model routing — CONFIRMED.** `sys_advise_models` is an LLM-judge with a SIMPLE/MODERATE/COMPLEX rubric mapped to cost tiers per harness family (`server/smart_routing.py`), gated by `OMNIGENT_SMART_ROUTING=1` + an `llm:` config block; `sys_list_models` + per-dispatch `model` override exist.
- **Cross-vendor review — convention, not core.** The "Polly pattern" lives in an example agent's skills + prompt (`examples/polly/skills/cross-review/SKILL.md`), backed by generic orchestration policies. Rickgent ships its own cross-review skill + enforcing policy; the reusable part is the substrate, not a feature.
- **Cost tracking — CONFIRMED, reshaped.** No cost-advisor *tool*; cost = MLflow-fetched pricing (`llms/context_window.py`), budget policies (`policies/builtins/cost.py`), `session_usage` + `user_daily_cost` persistence, and — usefully — a per-dispatch `cost_budget` arg on `sys_session_send`, so **per-ticket budgets come free**. Pricing can be absent (unpriced models degrade budget policies) — treat unpriced as unbounded-risk.
- **State — CONFIRMED.** SQLAlchemy + Alembic (59 migrations), per-conversation `session_state` JSON persisted across turns. Pipeline-level state (tickets, phases, baselines) still needs `.rickgent/registry.json`.
- **Cancellation — TRAP.** The server tasks table was removed; `sys_cancel_task` returns `task_not_found` for all inputs, and the sub-agent busy check is a no-op. Worker-timeout enforcement lives in the rickgent orchestrator (deadline on inbox wait + salvage), not in a platform cancel primitive.

### 2.2 Lifecycle components — Pickle Rick likely wins, refactor into the TypeScript product

| Component | Omnigent has | Pickle Rick has | Likely verdict | Investigation questions |
|---|---|---|---|---|
| Microverse (metric convergence) | Nothing | Full loop: `microverse-runner.ts` — measure, compare, rollback, stall detection, auto-rescue, LLM judge, gap analysis, failure distribution, per-iteration gate | **Pickle Rick** — refactor into TS lifecycle runtime; verdict decisions call the TS verdict core (`src/core/`) | How tightly coupled is microverse-runner to tmux? Can the loop logic (measure → classify → rollback → update baseline) be extracted without the tmux wrapper? What about the LLM judge integration? |
| Convergence gate | Nothing (generic policies only) | `convergence-gate.ts` — `runGate`, `filterByScope`, `assertBaselineFresh`, `subtractBaseline`, `detectProjectType`, `getWorkspacePackages` | **Pickle Rick** — TS verdict core (gate math) + TS gate runner | How does baseline subtraction work? What's the scope-filtering logic? How does freshness assertion detect a stale baseline? |
| Salvage | `sys_cancel_task` — just kills the process | `salvage-ticket.ts` + `reconcile-ticket-truth.ts` + `dirty-tree-salvage.ts` — scoped git stash, orphan-reset detection, ff-reattach, owned-paths-only staging, archive-then-reset | **Pickle Rick** — core decides/verifies; lifecycle layer executes git mutations (§14.8) | What are the salvage dispositions (commit+Done, archive+Todo, archive+resetTodo)? How does reconcileTicketTruth work? What's the dirty-tree rescue flow? |
| Circuit breaker | Nothing | `circuit-breaker.ts` — `extractErrorSignature`, `normalizeErrorSignature`, `detectProgress`, `canExecute`, `recordIterationResult`, `isConstraintDiscoverySignature` + escalation ladders (silent-death cap, failed-flip suppression, bounded terminal escape, breaker thresholds) + `recovery_attempts` ledger + grace windows | **Pickle Rick** — TS verdict core (transitions) + TS runtime ledger | How does error-signature matching work? What are the escalation ladder budgets? How does the recovery_attempts ledger draw down across relaunches? |
| Completion oracle | Nothing — trusts model claims | `ticket-completion-evidence.ts` + `evaluateCompletionEvidence` — verified-sha resolution, frontmatter-sha reconciliation, baseline rejection, gate verdict consultation, call-site count audit | **Pickle Rick** — SINGLE oracle in the TS core; Python reaches it only via `rickgent verdict` (§10.9) | How does the verified-sha resolution work? What's the frontmatter-sha reconciliation? How does baseline rejection prevent false-done? |
| 8-phase loop | Generic session (no phases) | `mux-runner.ts` — context-clearing outer loop, phase transitions, no-progress detection, breaker recovery, re-spawn-resume, dirty-tree salvage, per-phase gate hooks | **Pickle Rick** — refactor into TS, replace tmux with Omnigent one-shots | Which parts of mux-runner are tmux-specific vs lifecycle-specific? Can the phase state machine be extracted independently? How does re-spawn-resume map to Omnigent's session model? |
| PRD / ticket / decomposition | Nothing | Prompt skills `pickle-prd.md` + `pickle-refine-prd.md` (46K — 3-analyst refinement, atomic ticket decomposition: < 30 min, < 5 files, < 4 ACs) + thin TS orchestration (`spawn-refinement-team.ts`, `refinement-watcher.ts`, `citadel/prd-parser.ts`). NOTE: there is no `prism` runtime module — the decomposition intelligence is prompt-driven | **Pickle Rick** — adapt skills + new TS PRD/Ticket types (skill adaptation, not a Python code port) | Is the PRD model expressible as strict TS types? Can the 3-analyst refinement dispatch to Omnigent sub-agents? |
| Citadel (conformance audit) | Nothing | `/citadel` — run each AC's verify command, check branch diff, trap door cataloging, mechanical-finding classifier, graduated remediation | **Pickle Rick** — port as skill + TS verification runner | Can citadel's AC verification run via Omnigent's `sys_os_shell`? How does the trap door catalog work? |
| Szechuan (deslopping) | Nothing | `/szechuan-sauce` — principle-driven review (KISS, DRY, dead code, edge cases, encapsulation, self-documenting code, small functions, single source of truth) | **Pickle Rick** — port as skill | Is this purely prompt-driven, or is there runtime logic? |
| Anatomy-park (subsystem review) | Nothing | `/anatomy-park` — three-phase deep review, trap door cataloging, subsystem discovery | **Pickle Rick** — port as skill | Same question — prompt-driven or runtime? |
| Cronenberg (meta-router) | Nothing | `/cronenberg` — deterministic decision matrix, task shape signals, cleanup chain selection | **Pickle Rick** — port as skill + TS router | Is the decision matrix expressible as TS logic? |

#### 2.2.1 Validation findings (pre-build, 2026-07-12)

The porting inventory was verified against `pickle-rick-claude` on `experiment/fable-operating-manual` (HEAD `73aa1970`):

- **All named runtime artifacts exist with the claimed exports**: `microverse-runner.ts` (4,674 LOC, 15/15 exports), `microverse-state.ts` (497 LOC, 14/14), `convergence-gate.ts` (1,364 LOC, 6/6), `circuit-breaker.ts` (438 LOC, 6/6 functions), salvage trio, `ticket-completion-evidence.ts` (874 LOC), `check-scope-diff.ts`, `orphan-reaper.ts`, config-protection (960 LOC) and tsc-gate (557 LOC) hooks.
- **mux-runner.ts (11,339 LOC) is only lightly tmux-coupled** — ~23 tmux references in the whole file; the recovery state machine is already factored into `services/recovery-controller.ts` (`parsePlanPhases`, `executePhaseLoop`, `ReExecutionSeam`). The phase machine ports cleanly; tmux is a delivery layer.
- **The escalation ladder is SPLIT across files**: breaker thresholds live in `circuit-breaker.ts`; silent-death cap (`silentDeathGit`), failed-flip suppression (`evaluateFailedFlipSuppression`), bounded terminal escape (`BOUNDED_ESCAPE_STRATEGY`), and recovery grace (`isWithinBreakerRecoveryGrace`) all live in `mux-runner.ts`. The TS refactor pulls from BOTH; the verdict core (`src/core/`) owns the resulting transitions.
- **Salvage disposition names corrected**: the actual `SalvageDisposition` union is `ff-reattached | committed-done | archived-todo | no-op | error`. "Archive then reset" is a documented behavior of the archived-todo path, not a named disposition.
- **The completion oracle is a single *predicate*, not a single call-site**: `evaluateCompletionEvidence` has 7 call sites (6 in mux-runner via `buildCompletionCtx`, 1 in `auto-fill-completion-commit.ts`), with the importer set pinned by test (R-AFCC-CALLER-ENUMERATION). The TS verdict core keeps that invariant: one predicate, an enumerated caller allowlist asserted by test.
- **FOM citation corrections**: R-SZGB, R-MPGD, and the completion-oracle-collapse lesson ARE in `docs/FABLE_OPERATING_MANUAL.md`; R-WSRC and R-MACB are repo trap-door codes (CLAUDE.md + source comments), NOT in the manual; the manual's phrasing is "validation overreach," not "gate overreach."
- **LOC denominator**: full TS runtime ≈ 72.5K LOC; the named port surface ≈ 20K LOC (mux-runner + microverse-runner alone are ~16K). See §12 for the corrected subtraction claim.

### 2.3 Enforcement components — mash both

| Component | Omnigent has | Pickle Rick has | Likely verdict | Investigation questions |
|---|---|---|---|---|
| Scope fence | Sandbox filesystem isolation (seatbelt/bwrap) + policies | `check-scope-diff.ts` — preflight check against ticket's declared file set in `scope.json` | **Mash** — Omnigent sandbox for hard isolation + Pickle Rick scope.json for per-ticket precision | Can the policy read the ticket's declared paths and block writes outside them? Is sandbox isolation enough, or do we need both layers? |
| Forbidden ops (R-WSRC) | Policy framework (blast_radius, spawn_bounds) | TypeScript hooks (config-protection, tsc-gate, bash-scanner) + forbidden ops table | **Mash** — Omnigent policy framework + Pickle Rick's forbidden-ops semantics | Which forbidden ops are already covered by Omnigent policies? Which need new Rickgent policies? |
| Quality gates | Nothing | Readiness gate, ticket-audit gate, bundle-bootstrap exemption, AC-shape gate — all advisory (demoted in beta.33) | **Investigate** — Pickle Rick learned these should be advisory, not blocking. Do we port them at all? | The FOM says "gate overreach" was the top recurring bug source (15 sub-fixes). Do we port any gates, or just rely on the full gate before PR? |
| Worker timeout | Omnigent session timeout | `--worker-timeout` (default 1200s) + `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` + timeout-rescue auto-commit | **Investigate** — both have timeout, different rescue semantics | How does Omnigent handle worker timeout? Does it preserve the worker's uncommitted work? |
| Orphan reaping | Process containment (sandbox kills children) | `orphan-reaper.ts` — positive-ownership-mandatory reap, SIGTERM→SIGKILL escalation, min-age, `PICKLE_ORPHAN_REAP=off` | **Investigate** — Omnigent's sandbox may make this unnecessary | Does Omnigent's sandbox isolation guarantee no orphans? Or do we still need a reaper for sandbox escapes? |

### 2.4 The investigation protocol

For each component, the build phase follows this protocol:

1. **Read both implementations** — study the Omnigent Python and Pickle Rick TypeScript side by side
2. **Document the contract** — what does this component do, what are its invariants, what are its failure modes
3. **Evaluate** — which implementation is better for Rickgent's goals (multi-model, autonomous, reliable, quality)?
4. **Decide** — port, reuse, mash, or skip
5. **Record the decision** — in a decision log with the reasoning, so future contributors understand why

The decision log lives at `rickgent/docs/decisions/` with one file per component. Pre-build validation (2026-07-12) already answered several matrix questions — seed the decision log from §2.1.1 and §2.2.1 rather than re-investigating.

---

## 3. Lifecycle modules — full implementations, not thin policies

The first PRD draft sketched lifecycle modules as thin policy functions. That was wrong. These are full implementations with real state, real git operations, and real semantics — ported from Pickle Rick's TypeScript with the same depth.

**Language split (§10.9):** the deterministic verdict logic — completion evidence, salvage dispositions, convergence gate math, circuit breaker + escalation ladders, scope fence math — lives in `orchestrator/src/core/` as PURE TypeScript decision functions (no process spawns, no git mutations). The lifecycle layer (`src/lifecycle/`) owns loops, dispatch, and git execution, and calls the core for every judgment. The sketches below are the language-neutral CONTRACT for those modules, shown in pseudocode; every implementation path is TS. Do not create Python lifecycle modules; Python is confined to `rickgent-policies/` and only adapts Omnigent policy events to core verdicts (in-process for scope-fence path math, via the `rickgent verdict` CLI for everything else).

### 3.1 `orchestrator/src/lifecycle/microverse.ts` — the convergence loop runner

Not a policy. A full loop runner.

```python
class MicroverseRunner:
    """Metric convergence loop: measure → classify → rollback → update baseline → stall detection.
    
    Ported from Pickle Rick's microverse-runner.ts. Replaces tmux with Omnigent sessions.
    """
    
    def __init__(self, config: MicroverseConfig):
        self.state = MicroverseState()  # baseline, best_score, iteration_count, stall_count
        self.breaker = CircuitBreaker()  # from circuit-breaker.ts
        self.gate = ConvergenceGate()    # from convergence.ts
    
    async def run(self, ticket: Ticket, metric: Metric) -> ConvergenceResult:
        """The main loop. Each iteration:
        1. Dispatch worker to best available harness (`omnigent run <worker-agent> -p` one-shot per §10.10.1)
        2. Measure metric (shell command or LLM judge)
        3. Classify iteration (improved / regressed / stalled / no-commit)
        4. If regressed: rollback last change (scoped git restore)
        5. If improved: update baseline, reset stall count
        6. If stalled: check stall limit (attrition vs convergence)
        7. If no-commit: classify no-commit exit (worker timeout vs silent death vs rate limit)
        8. Run per-iteration convergence gate (baseline subtraction, scope filtering)
        9. Repeat until converged, stalled, or breaker trips
        """
        ...
    
    async def _measure_metric(self, metric: Metric) -> float | None:
        """Measure via shell command or LLM judge. Returns None on failure (silence is not success)."""
        ...
    
    def _classify_iteration(self, current: float | None, baseline: float | None) -> IterationClassification:
        """Classify: improved / regressed / stalled / no-commit / amnesiac_exit."""
        ...
    
    def _rollback(self, ticket: Ticket) -> None:
        """Scoped git restore — named files only, never directories."""
        ...
    
    def _handle_stall(self, stall_count: int, stall_limit: int) -> StallDecision:
        """Stall detection: 3 iterations no improvement = attrition, not convergence."""
        ...
```

**What gets ported from Pickle Rick:**
- `executeMainLoop`, `measureAndClassifyIteration`, `handleIterationOutcome`, `classifyStall`, `handleNoCommitStall`, `autoRescueDirtyTree`, `preflightAutoCommit`, `buildJudgePrompt`, `extractScore`, `getBestScore`, `handleRateLimit`, `injectRecoveryGuidance`, `executeGapAnalysis`, `buildFailureDistribution`, `writeFinalReport`
- `microverse-state.ts`: `LedgerSnapshot`, `classifyFailure`, `compareMetric`, `createMicroverseState`, `findLastAcceptedEntry`, `getLastAcceptedScore`, `isConverged`, `recordIteration`, `recordStall`, `resolveStallLimit`, `updateViolationLedger`, `recordFailedApproach`, `recordAmnesiacExit`, `clearAmnesiacExits`

**What gets replaced with Omnigent:**
- tmux context clearing → Omnigent session isolation (fresh session per one-shot)
- `claude -p` / `codex exec` worker spawn → `omnigent run <worker-agent> -p` one-shot to any harness (§10.10)
- tmux monitor panes → Omnigent web UI
- `pickle-metrics` → Omnigent cost tracking

### 3.2 `orchestrator/src/lifecycle/convergence.ts` — the convergence gate

Not a policy. A TS gate runner (`src/lifecycle/`) that delegates baseline subtraction, freshness checks, and scope filtering to the verdict core (`src/core/convergence.ts`).

```python
class ConvergenceGate:
    """Gate service: runGate, filterByScope, assertBaselineFresh, subtractBaseline.
    
    Ported from Pickle Rick's convergence-gate.ts.
    """
    
    async def run_gate(self, opts: RunGateOpts) -> GateResult:
        """Run a set of checks (lint, test, typecheck) and return pass/fail per check.
        Handles per-check timeouts, env noise stripping, project type detection."""
        ...
    
    def filter_by_scope(self, candidates: list[str], scope: ScopeOpts) -> list[str]:
        """Filter gate findings to the ticket's scope (declared paths only)."""
        ...
    
    def assert_baseline_fresh(self, baseline: Baseline, current: Baseline) -> None:
        """Assert the baseline is not stale. Raises BaselineStaleError if checks have changed.
        The R-SZGB lesson: a convergence gate that converges over a stale baseline (zero checks)
        is a false convergence."""
        ...
    
    def subtract_baseline(self, current: list[Finding], baseline: list[Finding]) -> list[Finding]:
        """Subtract baseline findings from current findings. Only NEW findings count.
        Assigns occurrence indices to avoid false positives from re-numbered findings."""
        ...
```

### 3.3 `orchestrator/src/lifecycle/salvage.ts` — preserve and recover

Not "preserve and recover." A full salvage machinery with dispositions.

```python
class SalvageManager:
    """Scoped work preservation and recovery. Never blind-reset.
    
    Ported from Pickle Rick's salvage-ticket.ts + reconcile-ticket-truth.ts + dirty-tree-salvage.ts.

    Decide / execute / verify split (§14.8): the verdict core DECIDES the disposition
    (pure function over git state), the lifecycle layer EXECUTES the git mutations,
    the core VERIFIES the post-state. No destructive git op lives in src/core/.
    """
    
    def salvage_ticket(self, input: SalvageInput) -> SalvageOutcome:
        """The single salvage entry point. Dispositions (source names preserved
        from salvage-ticket.ts's SalvageDisposition union):
        - ff_reattached: orphan-reset detected → fast-forward reattach completed work
        - committed_done: gate-green + tree changed → commit scoped paths, flip Done
        - archived_todo: gate-failing but tree changed → archive the diff, reset to Todo
        - no_op / error: nothing to salvage / salvage itself failed
        (Archive-then-reset for no-progress is a behavior of the archived_todo path,
        not a separate disposition.)
        """
        ...
    
    def reconcile_ticket_truth(self, input: ReconcileInput) -> ReconcileResult:
        """Read git tree-truth to determine what actually happened.
        Count commits, check tree diff, verify frontmatter SHA.
        Never trust log tokens or model claims."""
        ...
    
    def salvage_dirty_tree(self, input: DirtyTreeInput) -> DirtyTreePlan:
        """Handle uncommitted worker output. Owned-paths-only staging.
        Never git add -A (R-MACB: foreign session's WIP swept onto feature branch)."""
        ...
    
    def auto_rescue_dirty_tree(self, working_dir: str, timeout: bool) -> None:
        """Worker-timeout rescue: commit in-scope dirty work, never lose it.
        Uses isInsideWorkTree() not fs.existsSync('.git') (R-MPGD lesson)."""
        ...
```

### 3.4 `orchestrator/src/lifecycle/circuit-breaker.ts` — error-signature counting

```python
class CircuitBreaker:
    """Error-signature counting with escalation ladders.

    Ported from Pickle Rick's circuit-breaker.ts PLUS the ladder rungs that live in
    mux-runner.ts (silent-death cap, failed-flip suppression, bounded terminal escape,
    recovery grace) — the TS escalation ladder is split across both files.
    """
    
    def extract_error_signature(self, error: str) -> str:
        """Normalize an error message to a stable signature for counting.
        The breaker counts SAME errors by text shape (FOM §7: keep error prose stable)."""
        ...
    
    def can_execute(self) -> bool:
        """Is the breaker open? After N identical errors, it trips."""
        ...
    
    def record_iteration_result(self, result: IterationResult) -> CircuitTransition:
        """Record an iteration. Tracks progress (files changed), error signatures, 
        and transitions the circuit state (closed → open → half-open)."""
        ...
    
    def detect_progress(self, working_dir: str) -> ProgressResult:
        """Detect whether real progress was made. Uses git tree diff, not log tokens."""
        ...

# Escalation ladders (ported from pickle_settings.json hardening block):
ESCALATION_LADDERS = {
    "silent_death_respawn_cap": 1,      # 0 disables
    "failed_flip_suppression_cap": 2,    # 0 disables  
    "bounded_terminal_escape_cap": 3,    # consecutive no-progress relaunches before terminal
    "breaker_thresholds": 5,             # identical errors before trip
    "breaker_recovery_grace_seconds": 30, # grace window where recovery doesn't count as progress
}
```

### 3.5 `orchestrator/src/lifecycle/completion.ts` — the SINGLE oracle

```python
class CompletionOracle:
    """The single completion evidence oracle. No plurality.
    
    Ported from Pickle Rick's evaluateCompletionEvidence + ticket-completion-evidence.ts.
    The FOM's #1 reliability lesson: when there were three oracles, they disagreed
    and a fully-green build reported 0/4 phases.
    """
    
    def evaluate_completion(self, input: CompletionInput) -> CompletionVerdict:
        """The ONE predicate every site routes through.
        
        Verifies:
        1. A commit exists and is reachable (git cat-file, not regex)
        2. The tree changed (trees compared, not SHAs — empty commits don't count)
        3. The commit is not the baseline SHA (rejection of no-op)
        4. The frontmatter completion_commit SHA resolves to a real in-scope commit
        5. The worker gate verdict was green (if applicable)
        
        Returns: COMMITTED / UNVERIFIED / BASELINE_SHA / NO_TREE_CHANGE
        """
        ...
    
    def resolve_attributable_frontmatter_sha(self, ticket: Ticket) -> str | None:
        """Resolve the frontmatter completion_commit SHA to a real git object.
        Reconciles worker-reported SHA with git tree-truth."""
        ...

# Caller-enumeration audit — the pin that prevents plurality.
# Source reality (ticket-completion-evidence.ts): ONE predicate, SEVEN call sites,
# importer set pinned by test (R-AFCC-CALLER-ENUMERATION). The TS core keeps
# the same invariant: one predicate, an explicit caller allowlist asserted by test.
```

### 3.6 `orchestrator/src/lifecycle/phase.ts` — the 8-phase state machine

```python
class PhaseMachine:
    """8-phase per-ticket lifecycle. Context clearing between phases.

    Ported from Pickle Rick's mux-runner.ts (lifecycle logic only, not tmux).
    """

    PHASES = [
        "research",           # gather current-state facts with file:line refs
        "research_review",    # adversarial check of the research findings
        "plan",               # design the approach from reviewed research
        "plan_review",        # adversarial check of the plan
        "implement",          # write the code
        "spec_conformance",   # verify against acceptance criteria
        "code_review",        # cross-vendor review (different harness than implementer)
        "simplify",           # szechuan-sauce deslopping
    ]  # 8 phases — matches Pickle Rick's actual lifecycle (the review phases were missing here)
    
    async def run_phase(self, phase: str, ticket: Ticket) -> PhaseResult:
        """Run one phase. Dispatches the phase worker as an `omnigent run` one-shot
        under the §10.10.1 protocol (dispatch_id, ledger, per-ticket lock).
        Context is cleared between phases (fresh Omnigent session per one-shot)."""
        ...
    
    def should_advance(self, phase: str, result: PhaseResult) -> AdvanceDecision:
        """Should we advance to the next phase? Checks:
        - Completion oracle verified (if implement phase)
        - Gate verdict green (if applicable)
        - No-progress detection (circuit breaker)
        - Scope fence respected
        """
        ...
    
    async def respawn_resume(self, ticket: Ticket, phase: str) -> None:
        """Re-spawn a worker for the current phase after a timeout/crash.
        Preserves uncommitted work via salvage. Fresh context."""
        ...
```

### 3.7 `orchestrator/src/lifecycle/prd.ts` — PRD model

The types below are NEW TypeScript code — the source of the PRD/refinement capability in Pickle Rick is prompt skills (`pickle-prd.md`, `pickle-refine-prd.md`) plus thin orchestration, not a portable runtime module. The skills get adapted; only `citadel/prd-parser.ts` semantics inform the parsing.

```ts
type AcceptanceCriterion = {
  description: string;
  type: "test" | "lint" | "grep";
  verifyCommand: string;
  scope: string[];
};

type PRD = {
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  simplificationReview: SimplificationReview;
};

function isValidPrd(prd: PRD): boolean {
  return prd.acceptanceCriteria.length > 0 &&
    prd.acceptanceCriteria.every((ac) => ac.verifyCommand.length > 0) &&
    prd.simplificationReview !== undefined;
}

type Ticket = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  declaredPaths: string[];
  estimatedMinutes: number;
  estimatedFiles: number;
  phaseState: PhaseState;
};

function isAtomic(ticket: Ticket): boolean {
  return ticket.estimatedMinutes < 30 &&
    ticket.estimatedFiles < 5 &&
    ticket.acceptanceCriteria.length < 4;
}
```

### 3.8 `orchestrator/src/lifecycle/registry.ts` — session state

```python
class Registry:
    """Session state tracking. Replaces Pickle Rick's state.json.
    
    Uses .rickgent/registry.json (like Polly's .polly/registry.json).
    Session-level state uses Omnigent's native session state.
    """
    
    def get_ticket_state(self, ticket_id: str) -> TicketState: ...
    def update_ticket_state(self, ticket_id: str, state: TicketState) -> None: ...
    def get_phase_state(self, ticket_id: str) -> PhaseState: ...
    def get_pipeline_status(self) -> PipelineStatus: ...
```

---

## 4. Policies — enforcement surfaces over lifecycle logic

Policies are thin: they delegate to the verdict core. The verdict logic lives in `orchestrator/src/core/`; the enforcement shims live in `rickgent-policies/` — **pure Python, no native bindings**. Two shim shapes, chosen by call frequency:
- **Scope fence (hot path — fires on every write tool call):** implemented in Python directly — it is mechanical path canonicalization, not drifting verdict logic. Parity with the TS core's scope module is pinned by running the SAME AC-10 fixtures against both implementations.
- **Everything verdict-shaped (cold path — done-claims, gate checks, PRD validation; roughly once per ticket/phase):** the shim shells out to `rickgent verdict <check> --json` (a JSON-I/O subcommand of the orchestrator CLI) so the single-implementation invariant holds — Python never re-implements an oracle.

Sketches below are illustrative of the shim shape.

```python
# rickgent/policies/scope_fence.py
def scope_fence(event, config):
    """Enforcement surface for rickgent.lifecycle.scope_fence."""
    if not is_write_tool(event): return ALLOW
    ticket_id = config.get("ticket_id")
    if not ticket_id:
        return DENY("scope fence: missing ticket_id")
    ticket = registry.get_ticket(ticket_id)
    if not ticket:
        return DENY(f"scope fence: unknown ticket {ticket_id}")
    target = extract_path(event)
    if not target:
        return DENY("scope fence: unresolvable write target")
    if not ticket.is_within_declared_paths(target):
        return DENY(f"scope fence: {target} not in ticket {ticket.id} declared paths")
    return ALLOW

# rickgent/policies/completion_evidence.py
def completion_evidence(event, config):
    """Enforcement surface for rickgent.lifecycle.completion.CompletionOracle."""
    if not is_done_claim(event): return ALLOW
    completion_input = extract_completion_input(event, config)
    if not completion_input:
        return DENY("completion evidence: malformed completion claim")
    verdict = rickgent_verdict_cli("completion", completion_input)  # subprocess → the TS core's single oracle (§10.9); CLI failure = DENY
    if verdict != CompletionVerdict.COMMITTED:
        return DENY(f"completion evidence: {verdict} — git tree-truth required")
    return ALLOW

# NOTE: omnigent's policy event vocabulary is CLOSED (§2.1.1) — there is no
# "lifecycle_phase_advance" event type and inventing one would trip fork trigger #1.
# Lifecycle gates ride the tool_call event: the orchestrator's agent-side steps invoke
# rickgent-owned tools (rickgent_phase_advance, rickgent_prd_validate), and the
# policies fence THOSE calls.

# (scope_fence above is PURE Python — hot path, path canonicalization only;
#  parity with src/core/scope.ts pinned by the shared AC-10 fixtures.)

# rickgent_policies/convergence_gate.py
def convergence_gate(event, config):
    """Enforcement surface for the kernel's convergence gate."""
    if not is_tool_call(event, tool="rickgent_phase_advance"): return ALLOW
    result = rickgent_verdict_cli("gate", extract_gate_opts(event, config))  # subprocess → TS core; CLI failure = DENY
    if not result.passed:
        return DENY(f"convergence gate: {result.failures}")
    return ALLOW

# rickgent_policies/subtract_before_add.py
def subtract_before_add(event, config):
    """Require simplification review in every PRD."""
    if not is_tool_call(event, tool="rickgent_prd_validate"): return ALLOW
    verdict = rickgent_verdict_cli("prd", extract_prd(event))  # subprocess → TS core; CLI failure = DENY
    if not verdict.valid:
        return DENY("PRD invalid: missing machine-checkable ACs or simplification review")
    return ALLOW
```

---

## 5. The four goals, concretely

### 5.1 Natively multi-model

- Every ticket dispatches to the best available harness (claude_code for multi-file, codex for narrow, pi for review/explore)
- Transport split (§10.10): the outer loop dispatches `omnigent run … -p` one-shots (synchronous joins, kill-on-timeout + salvage); agent-internal fan-out (e.g. refinement analysts) uses `sys_session_send` + inbox; per-worker deadlines are enforced rickgent-side either way
- Roster preflight at session start — route only to available workers
- Cross-vendor review is automatic: every implementer's PR reviewed by a DIFFERENT vendor
- `sys_advise_models` routes model selection per task difficulty
- No `--backend` flag. The concept doesn't exist.

### 5.2 Hands-off execution

- Full lifecycle hands-off between gates: PRD → refine → decompose → implement → cross-vendor review → conformance audit → deslopping → PR, with zero required interventions between PRD approval and PR-ready; every intervention is counted and reported (autonomy metric: interventions/run, target 0)
- Circuit breakers (ported from Pickle Rick, full implementation)
- Salvage machinery (ported, full implementation)
- Single completion oracle (ported, full implementation, caller-allowlist pinned)
- Supervision: synchronous joins on `omnigent run` one-shots (outer loop) + Omnigent inbox (agent-internal fan-out); web UI for observation
- Human touchpoints: PRD interview, plan gate, merge

### 5.3 Reliable, not brittle

| FOM lesson | Rickgent encoding |
|---|---|
| "Subtract before you add" | `subtract_before_add` policy — required simplification review |
| "Fix at the seam, not the site" | Single completion oracle, single salvage path, single convergence gate — no parallel implementations |
| "Two escape hatches for one guard = the guard is wrong" | No bypass flags. Policies either allow or deny. |
| "Silence is not success" | Convergence gate verifies suite actually ran (pass count > 0) |
| "Green is necessary, never sufficient" | Per-phase gates are advisory; the full gate runs before PR |
| "Suspect the immune system before the infection" | Salvage/circuit-breaker is minimal and well-tested (ported from battle-tested Pickle Rick code) |
| "Completion oracle plurality" | ONE predicate. Enumerated call-site allowlist. Pinned by count audit. |
| "Validation overreach" (the FOM's phrasing; a.k.a. gate overreach) | Gates are advisory or enforced. No hybrid gates. No forward-ref grammar. |

### 5.4 99% PR quality

| Barrier | What it catches | Implementation |
|---|---|---|
| Cross-vendor review | Logic errors, design flaws | Different-vendor reviewer on every PR (rickgent skill + purpose-guard policy over Omnigent dispatch — the Polly pattern is an example-agent convention, not a core feature) |
| Citadel conformance audit | Spec violations | Run each AC's verify command against branch diff (Pickle Rick ported) |
| Szechuan deslopping | Dead code, duplication, KISS violations | Principle-driven review (Pickle Rick ported) |
| Anatomy-park | Cross-subsystem interface mismatches | Three-phase deep review (Pickle Rick ported) |
| Convergence gate | Metric regression | Full loop with rollback (Pickle Rick ported) |
| Full gate | Compile, lint, test failures | tsc + eslint + test suite before PR |
| Completion oracle | Claimed-done without verified commit | git cat-file + tree diff (Pickle Rick ported) |

**Quality is a defined metric, not an adjective.** A shipped PR counts as *defective* if it requires a correction commit traceable to the PR's scope, fails its PRD acceptance criteria on re-audit, or is later found to have introduced a regression inside its declared scope. The 14-day window is the maturity window before a PR enters the main quality denominator, not an expiry date: late defects reopen the historical record and update the rolling metric. PR quality % = 1 − (defective / shipped), measured over a rolling window of ≥ 30 matured PRs across ≥ 3 repos, with a defect ledger linking each defect to a PR, scope path, detection date, and adjudication note. v0.1 establishes the baseline; the 99% target is the GA gate (§8.3), demonstrated — not asserted.

---

## 6. The FOM as platform calibration

Adapted from Pickle Rick's `docs/FABLE_OPERATING_MANUAL.md`. Key terminology mappings:

| Pickle Rick term | Rickgent term |
|---|---|
| `state.json` | Session state + `.rickgent/registry.json` |
| tmux pane / monitor | Omnigent web UI / sub-agent panel |
| `claude -p` subprocess | `omnigent run <agent> -p` one-shot (outer loop); `sys_session_send` (agent-internal fan-out) |
| `mux-runner.js` | `orchestrator/src/lifecycle/` (TS) + `src/core/` verdicts |
| `spawn-morty.js` | `dispatch/` module spawning `omnigent run <worker-agent> -p` one-shots |
| `install.sh` | N/A — agent config IS the deployment |
| Hook-based enforcement | Policy functions in `rickgent.policies`, registered via omnigent's `policy_modules` config |
| `--backend codex` | Automatic — dispatch to any available harness |
| `I AM DONE` / `EPIC_COMPLETED` | `sys_read_inbox` + completion oracle verification |

Shipped as: `rickgent/docs/FABLE_OPERATING_MANUAL.md` (full document) + `orchestrator/src/fom.ts` (programmatic access) + system prompt calibration (five key disciplines in the default agent prompt).

---

## 7. CLI design

```
rickgent                          # launch the default agent (interactive)
rickgent prd                      # PRD interview
rickgent prd --from existing.md   # adopt existing PRD
rickgent refine prd.md            # 3-analyst refinement + decomposition
rickgent refine prd.md --run      # refine + auto-launch
rickgent build                    # implement all tickets (8-phase loop)
rickgent build --resume           # resume from existing session
rickgent build --max-iterations N # stop after N iterations
rickgent citadel                  # conformance audit
rickgent szechuan                 # deslopping
rickgent anatomy                  # subsystem review
rickgent microverse --metric CMD  # convergence loop
rickgent pipeline "goal"          # full lifecycle
rickgent cronenberg "goal"        # meta-router
rickgent status                   # session phase, ticket status
rickgent metrics                  # cost, commits, LOC
```

---

## 8. Scope

### 8.1 In scope (v0.1.0-alpha)

1. Rickgent monorepo with omnigent as a pinned external dependency (v0.5.0 release or a pinned 0.6.0.dev commit) — no fork
2. `orchestrator/src/core/` — TS verdict core: completion oracle, salvage dispositions, scope fence math, convergence gate, circuit breaker + escalation ladders; exposed to non-TS callers as `rickgent verdict <check> --json` (§10.9)
3. `orchestrator/` — TypeScript orchestration (phase machine, microverse loop, `omnigent run` dispatch protocol, salvage executor, resume/reconcile, registry), refactored from the pickle-rick TS; every judgment delegates to the core
4. `rickgent-policies/` — 4 enforcement-shim policies (pure Python, ~100–200 LOC, no native bindings), exposed as a `POLICY_REGISTRY` loaded via `policy_modules`
4a. `conformance/` — language-neutral fixture suite, differential-tested against the legacy TS reference (§10.9)
5. 7 skills, shipped inside the rickgent agent bundle
6. `agents/rickgent/config.yaml` — default agent bundle
7. `orchestrator/src/cli.ts` — the `rickgent` CLI
8. `docs/FABLE_OPERATING_MANUAL.md` — adapted FOM
9. `orchestrator/src/fom.ts` — programmatic FOM access
10. `docs/decisions/` — component investigation decision log
11. Test suite: core conformance (vitest over `conformance/fixtures/`, differential vs the legacy TS reference) + orchestration tests (vitest) + policy shim tests (pytest)
12. End-to-end demonstration

### 8.2 Out of scope (v0.1.0-alpha)

- Pickle Rick persona (Rick voice)
- Rust verdict-kernel extraction — v0.2, trigger-gated (§10.9); v0.1 ships zero native bindings
- Codegraph integration — v0.2
- Cloud sandbox execution per ticket — v0.2
- Pickle Rick's 9-audit-script suite — investigate, port as policies if warranted
- Activity logging — Omnigent cost tracking suffices
- `pickle-jar` batch queue — v0.2

### 8.3 Future versions

- **v0.2:** Rust verdict-kernel extraction from `src/core/` against the frozen conformance fixtures (trigger-gated, §10.9), sessions-API transport (spawn-tree linkage + SSE), Codegraph, cloud sandboxes, jar batch queue, remaining audit policies
- **v0.3:** Agent teams parallelism, custom convergence metrics library
- **v1.0:** GA — N clean hands-off runs, 99% PR quality demonstrated

---

## 9. Acceptance criteria

### AC-1 — All layers build, install, and the stack works end-to-end
**Type:** test
```bash
cd orchestrator && pnpm install && pnpm build && pnpm link
cd ../rickgent-policies && pip install -e .
rickgent --version && rickgent --help && omnigent --version
python -c "import omnigent, rickgent_policies"
rickgent doctor   # behavioral smoke, must exit 0:
```
`rickgent doctor` proves the stack, not just the imports: loads `rickgent_policies` via `load_registry`, validates the agent bundle against AGENTSPEC, self-tests the verdict surfaces (in-process core call, `rickgent verdict` CLI, and the Python shim's subprocess path return identical verdicts on one embedded fixture, and `build_commit` matches across TS package / CLI / Python wheel), dispatches `omnigent run agents/rickgent -p "ping"` and asserts a completed session with non-empty output in the shared DB.

Clean-environment install is part of the criterion: the same commands run in a fresh temp workspace with empty npm/pip caches except for the checked-in lockfiles. Release fails if installation depends on undeclared global tools beyond the documented toolchain (`node/pnpm`, Python, git, the Omnigent pin).

### AC-2 — Omnigent compatibility pin holds
**Type:** test
The omnigent dependency is version-pinned, and a compat suite proves the pinned primitives behave the way Rickgent depends on, not just that their schemas exist:
```python
def test_policies_register_via_policy_modules():
    registry = load_registry(extra_modules=["rickgent_policies"])
    assert {"scope_fence", "completion_evidence", "convergence_gate", "subtract_before_add"} <= set(registry)

def test_agent_bundle_validates():
    spec = parse_agent_config("rickgent/agents/rickgent")  # AGENTSPEC-valid
    assert spec is not None

def test_required_primitives_exist():
    # sys_session_send, sys_read_inbox, sys_os_shell schemas present in pinned omnigent
    ...

def test_session_send_delivers_ordered_completion_to_inbox():
    # Dispatch two labeled internal workers; both async_work_complete messages arrive
    # with the expected labels, and no result is observed before its handle exists.
    ...

def test_inbox_deadline_is_observable_without_cancel_task():
    # A worker that sleeps past the deadline produces a deadline breach in Rickgent
    # state; the test asserts Rickgent does NOT call inert sys_cancel_task.
    ...

def test_cost_policy_rejects_unpriced_or_over_budget_dispatch():
    # Unpriced model or over-budget model selection is DENY/ASK before dispatch.
    ...
```
(Replaces "upstream tests pass unmodified" — there is no vendored upstream tree to test.)

### AC-3 — Component investigation decision log exists and is evidence-backed
**Type:** test
For each component in the investigation matrix (Section 2), a decision file exists at `docs/decisions/<component>.md` with: both implementations studied, contract documented, evaluation, decision (port/reuse/mash/skip), and reasoning. Enforced by a lint script, not eyeballs: every decision file must contain ≥ 1 `file:line` citation into EACH codebase studied and an explicit `Decision:` line; every §2.1.1/§2.2.1 pre-validated finding must be either adopted or explicitly overturned with new evidence (silent contradiction fails the lint). Each decision file is countersigned by a different-vendor reviewer before Phase 2 consumes it.

### AC-4 — Lifecycle layer tests pass
**Type:** test
```bash
cd orchestrator && pnpm test          # core + lifecycle, incl. conformance/fixtures/
cd ../rickgent-policies && python -m pytest -x
```
Tests cover: PRD validation, ticket atomicity, microverse loop (measure/classify/rollback/stall), convergence gate (baseline subtraction/freshness/scope filtering), salvage (dispositions/dirty-tree rescue/orphan-reset), circuit breaker (signatures/escalation/progress detection), completion oracle (single predicate, pinned callers), phase machine (transitions/advance gates). Coverage is manifest-backed, not aspirational: `tests/lifecycle_coverage_manifest.json` enumerates every required incident class, fixture, and expected failure mode; CI fails if a manifest item has no executable test or if mutation tests can remove the tested guard without failing the suite.

### AC-5 — Completion oracle is a single predicate with pinned callers
**Type:** test
```python
def test_completion_oracle_single_predicate_pinned_callers():
    # ONE exported core predicate; every TS/Python caller is on an explicit allowlist.
    # AST import graph, not grep: aliases, re-exports, generated code, dynamic import(),
    # subprocess calls to `rickgent verdict`, and direct git completion checks outside
    # src/core/ are all findings.
    graph = build_static_import_graph(["orchestrator/src", "rickgent-policies"])
    assert graph.exported_symbols("orchestrator/src/core").count("evaluateCompletion") == 1
    assert graph.callers_of("core.evaluateCompletion") == ALLOWED_COMPLETION_CALLERS
    # Python side: the ONLY completion path is the `rickgent verdict completion` subprocess
    assert graph.python_completion_logic_outside_subprocess_call() == []
    assert graph.dynamic_imports_touching("completion") == []
    assert graph.direct_git_completion_checks_outside_kernel() == []
```

### AC-6 — Microverse convergence loop works end-to-end
**Type:** test
```python
def test_microverse_converges_on_improving_metric(tmp_path):
    runner = MicroverseRunner(config=MicroverseConfig(metric="coverage", stall_limit=3))
    # Simulate 3 iterations: 60 → 70 → 80 (converged)
    results = runner.run_simulated([60, 70, 80])
    assert results.converged == True
    assert results.iterations == 3

def test_microverse_rollback_on_regression(tmp_path):
    runner = MicroverseRunner(config=...)
    # Simulate: 80 → 70 (regression → rollback)
    results = runner.run_simulated([80, 70])
    assert results.rolled_back == True
    assert results.baseline == 80  # baseline preserved after rollback

def test_microverse_detects_stall(tmp_path):
    runner = MicroverseRunner(config=MicroverseConfig(stall_limit=3))
    # Simulate: 80 → 80 → 80 → 80 (stall)
    results = runner.run_simulated([80, 80, 80, 80])
    assert results.converged == False
    assert results.reason == "stalled"

def test_microverse_end_to_end_fixture_repo(tmp_path):
    """Simulated scores test the loop math; this tests the LOOP. Real git repo,
    real metric command (script counting TODO markers), scripted deterministic
    worker binary standing in for `omnigent run` (improves twice, regresses once,
    then hangs past the deadline). Asserts:
    - regression → files actually restored (git status clean vs pre-iteration tree)
    - baseline preserved across the rollback
    - deadline breach → worker killed, in-scope dirty work salvage-committed
    - final report matches the git log, not the worker's claims
    """
    ...

def test_microverse_via_omnigent_run_fixture_agent(tmp_path):
    """Real transport path: fixture agent is launched through `omnigent run`, writes
    a deterministic in-scope change, emits a false success token, and exits. The
    orchestrator accepts only the git/kernel verdict, not stdout prose."""
    ...
```

### AC-7 — Convergence gate detects stale baseline
**Type:** test
```python
def test_convergence_gate_rejects_stale_baseline():
    gate = ConvergenceGate()
    baseline = Baseline(checks=[Check("lint", passed=True)])
    current = Baseline(checks=[])  # zero checks — stale baseline
    with pytest.raises(BaselineStaleError):
        gate.assert_baseline_fresh(baseline, current)

def test_convergence_gate_rejects_changed_or_partial_baseline():
    # Non-empty can still be stale: command changed, check renamed, parser truncated
    # output, or a required package disappeared. Each case raises BaselineStaleError.
    ...
```

### AC-8 — Salvage preserves work and chooses correct disposition
**Type:** test
```python
def test_salvage_commit_and_done_on_green(tmp_path):
    repo = init_git_repo(tmp_path)
    write_file(repo, "src/feature.py", "work")
    commit(repo, "src/feature.py", "implement feature")
    salvage = SalvageManager(repo)
    result = salvage.salvage_ticket(SalvageInput(ticket=..., gate_passed=True))
    assert result.disposition == "committed_done"

def test_salvage_archive_on_failing_gate(tmp_path):
    repo = init_git_repo(tmp_path)
    write_file(repo, "src/feature.py", "incomplete work")
    salvage = SalvageManager(repo)
    result = salvage.salvage_ticket(SalvageInput(ticket=..., gate_passed=False))
    assert result.disposition == "archived_todo"
    assert result.archived_diff is not None

def test_salvage_owned_paths_only(tmp_path):
    """R-MACB: never git add -A. Only owned paths."""
    repo = init_git_repo(tmp_path)
    write_file(repo, "src/feature.py", "my work")
    write_file(repo, "docs/foreign.md", "someone else's WIP")
    salvage = SalvageManager(repo)
    plan = salvage.salvage_dirty_tree(DirtyTreeInput(owned_paths=["src/feature.py"]))
    assert "src/feature.py" in plan.staged_paths
    assert "docs/foreign.md" not in plan.staged_paths

def test_salvage_hard_cases(tmp_path):
    # Covers orphan reattach, symlink escape, forced worktree removal preflight,
    # branch reachability, concurrent dirty tree, and archive restoreability.
    ...
```

### AC-9 — Circuit breaker trips on repeated errors
**Type:** test
```python
def test_circuit_breaker_trips_on_repeated_errors():
    breaker = CircuitBreaker(threshold=3)
    for _ in range(3):
        breaker.record_iteration_result(IterationResult(error="ETIMEDOUT at line 42"))
    assert not breaker.can_execute()

def test_circuit_breaker_resets_on_progress():
    breaker = CircuitBreaker(threshold=3)
    breaker.record_iteration_result(IterationResult(error="ETIMEDOUT"))
    repo = fixture_repo_with_tree_change()
    breaker.record_iteration_result(IterationResult(git_tree_after=repo.head_tree()))  # git-truth progress
    assert breaker.can_execute()

def test_circuit_breaker_rejects_claimed_progress_without_tree_change():
    breaker = CircuitBreaker(threshold=3)
    breaker.record_iteration_result(IterationResult(error="ETIMEDOUT"))
    breaker.record_iteration_result(IterationResult(worker_claimed_files_changed=2, git_tree_after=BASELINE_TREE))
    assert breaker.same_signature_count("ETIMEDOUT") == 2
```

### AC-10 — Scope fence blocks out-of-scope writes, adversarially
**Type:** test
```python
def test_scope_fence_blocks_outside_paths():
    policy = scope_fence_factory(declared_paths=["src/auth/"])
    assert policy(write_event("src/billing/invoice.py"))["result"] == "DENY"
    assert policy(write_event("src/auth/login.py"))["result"] == "ALLOW"

def test_scope_fence_adversarial_paths():
    """The fence must survive hostile path shapes, not just happy strings."""
    policy = scope_fence_factory(declared_paths=["src/auth/"])
    assert DENY == policy(write_event("src/auth/../billing/invoice.py"))   # traversal
    assert DENY == policy(write_event("/etc/passwd"))                       # absolute escape
    assert DENY == policy(write_event("src/AUTH/login.py"))                 # case games (canonicalize per-FS)
    assert DENY == policy(symlink_event("src/auth/link", "->", "src/billing/"))  # symlink escape
    assert DENY == policy(rename_event("src/auth/a.py", "src/billing/a.py"))     # rename OUT of scope
    assert DENY == policy(delete_event("src/billing/invoice.py"))                # deletes are writes
    assert DENY == policy(shell_event("tee src/billing/x.py"))              # write via sys_os_shell arg
    # Non-path-shaped write tools resolve their target before the check or DENY on unresolvable
```
All paths canonicalized (realpath, worktree-root-relative) before comparison; unresolvable targets fail closed.

### AC-11 — Seven skills defined, valid, and exercised
**Type:** test
All 7 skills parse under the AGENTSPEC skill schema and reference Omnigent primitives (`sys_session_send`, `sys_read_inbox`). `sys_cancel_task` is deliberately NOT referenced — the platform tasks table was removed and the tool returns `task_not_found` for all inputs; timeout enforcement is rickgent-side. Existence proves packaging only: each skill must additionally be exercised during AC-14 or AC-17 with an expected behavioral artifact, not just a load event:
- PRD/refine skill emits machine-checkable AC JSON accepted by `rickgent_prd_validate`
- implementation skill produces an in-scope commit or an UNVERIFIED ticket
- citadel skill runs each AC command and writes a report artifact
- szechuan/anatomy skills produce findings or explicit no-finding reports tied to file:line evidence
- cronenberg/router skill emits a deterministic route decision from fixed task-shape inputs

### AC-12 — FOM disciplines in agent prompt, no legacy terminology
**Type:** grep (packaging lint only — greps verify the prompt SHIPS, AC-17 verifies the disciplines BITE)
```bash
grep -q "hierarchy of evidence" rickgent/agents/rickgent.yaml
grep -q "silence is not success" rickgent/agents/rickgent.yaml
grep -q "subtract before you add" rickgent/agents/rickgent.yaml
grep -q "convergence vs attrition" rickgent/agents/rickgent.yaml
! grep -q "tmux" rickgent/agents/rickgent.yaml
! grep -q "state.json" rickgent/agents/rickgent.yaml
! grep -q "install.sh" rickgent/agents/rickgent.yaml
```

### AC-13 — Cross-vendor review is POLICY-ENFORCED, not instructed
**Type:** test
Prose enforcement fails (§1.3) — so the skill instructing it is necessary but not the criterion. A `cross_vendor_review` policy in `rickgent_policies` DENIES a code_review-phase dispatch whose reviewer vendor equals the implementer's vendor (vendors read from harness/session labels).
```python
def test_cross_vendor_review_enforced():
    policy = cross_vendor_review_factory()
    assert DENY == policy(review_dispatch_event(implementer="claude", reviewer="claude"))
    assert ALLOW == policy(review_dispatch_event(implementer="claude", reviewer="codex"))
```
Plus a live negative test in the AC-14 run: a deliberately same-vendor review dispatch must be denied and rerouted (visible in the session log).

### AC-14 — End-to-end lifecycle demonstration, fully specified
**Type:** test
The fixture PRD is checked into the repo (`fixtures/e2e-feature-prd.md`: 5 tickets against a fixture app repo, each with machine-checkable ACs). One command (`rickgent pipeline fixtures/e2e-feature-prd.md`) runs PRD → refine → decompose → implement → cross-vendor review → citadel → szechuan → PR. Pass requires ALL of:
- zero human interventions between plan-gate approval and PR-ready (intervention counter = 0)
- ≥ 2 distinct harnesses used for implementation (from session labels in the shared DB)
- every implement-phase ticket receives a code_review-phase dispatch from a different vendor AND the AC-13 same-vendor negative test is denied mid-run
- a PR-equivalent review artifact exists in the local fixture remote (`refs/rickgent/pr/<n>` + generated PR description + diff bundle) with a green full gate; if `GH_TOKEN` and network are present, an optional `gh pr view <n>` smoke may also run but is not required for release qualification
- every fixture-PRD AC verified by the citadel run (its report is an artifact of the test)
- one induced worker timeout mid-run is salvaged without work loss (git log shows the salvage commit)
- dedicated release-runner performance profile: p95 E2E wall-clock ≤ 4 hours with per-step timeouts recorded in `e2e_timing.json`; ordinary CI treats timing as diagnostic unless a per-step timeout is exceeded

### AC-15 — PRD requires machine-checkable ACs and simplification review
**Type:** test
```python
def test_prd_invalid_without_acs():
    prd = PRD(title="test", acceptance_criteria=[], simplification_review=...)
    assert not prd.is_valid()

def test_prd_invalid_without_simplification_review():
    prd = PRD(title="test", acceptance_criteria=[...], simplification_review=None)
    assert not prd.is_valid()

def test_prd_rejects_unrunnable_or_unscoped_ac_commands(tmp_path):
    assert_invalid_ac(verify_command="", scope=["src/"])
    assert_invalid_ac(verify_command="read -p interactive", scope=["src/"])
    assert_invalid_ac(verify_command="curl https://example.com", scope=["src/"])
    assert_invalid_ac(verify_command="pnpm test", scope=[])

def test_prd_accepts_deterministic_scoped_ac_command(tmp_path):
    prd = PRD(title="test", acceptance_criteria=[
        AcceptanceCriterion(
            description="auth rejects empty password",
            type="test",
            verify_command="pnpm test -- auth.empty-password.test.ts",
            scope=["src/auth/", "test/auth.empty-password.test.ts"],
        )
    ], simplification_review=...)
    assert prd.is_valid()
```

### AC-16 — Verdict core conformance: verdicts match the legacy TS reference
**Type:** test
```bash
# differential run: same fixtures through the new TS core and the legacy TS reference
rickgent verdict batch conformance/fixtures/ > core-verdicts.json
node scripts/legacy-reference-runner.js conformance/fixtures/ > legacy-verdicts.json
diff core-verdicts.json legacy-verdicts.json
```
Fixtures cover: completion evidence (COMMITTED / UNVERIFIED / BASELINE_SHA / NO_TREE_CHANGE), all salvage dispositions (ff_reattached / committed_done / archived_todo / no_op / error), breaker transitions + every escalation ladder rung, convergence gate baseline subtraction / freshness / scope filtering. Every verdict matches pickle-rick-claude's TS implementation on `experiment/fable-operating-manual` (the legacy reference). All three verdict surfaces pass the same suite: the in-process core API, the `rickgent verdict` CLI, and the Python shim's subprocess path.

**Deviation clause — fidelity is to intent, not to bugs.** Conformance catches port drift; it must not fossilize incident-era defects. A divergence from the TS verdict is permitted when a decision-log entry documents the TS behavior as a defect and the fixture's expected verdict is updated to the intended behavior — the fixture suite is the spec, and the spec is allowed to be *corrected*, never silently.

Malformed-input matrix: the same suite also feeds malformed JSON, unknown enum variants, missing git objects, unreadable worktrees, huge gate output, timeout errors, and invalid UTF-8 through all three verdict surfaces (core API, `rickgent verdict` CLI, Python subprocess path). All three must return the same typed error class and fail closed. A micro-benchmark fixture records p95 latency per surface (the CLI subprocess path has its own budget since it forks Node); release fails if p95 regresses by >25% from the checked-in baseline without a decision-log exemption.

### AC-17 — Planted-failure enforcement drills (the disciplines bite)
**Type:** test
Live drills against a fixture repo, each with a scripted misbehaving worker; every drill must be blocked by the platform, not by prompt goodwill:
1. **False completion** — worker claims done, no commit → completion-evidence policy DENIES the Done flip; ticket lands UNVERIFIED; registry, git tree, and session log all show no accepted completion
2. **Baseline-SHA completion** — worker reports the baseline commit as its work → DENIED (BASELINE_SHA verdict); no phase advance
3. **Out-of-scope write** — worker writes outside declared paths → scope fence DENY visible in session log; tree untouched
4. **Same-vendor review** — covered in AC-13/AC-14
5. **Stale-baseline convergence** — gate run with zero checks executed → BaselineStaleError, no false convergence (R-SZGB drill)
6. **Foreign-WIP sweep** — dirty tree containing unowned files at salvage time → only owned paths staged (R-MACB drill)
7. **Python policy exception** — shim raises before the verdict call (or `rickgent verdict` fails/times out) → DENY with typed `POLICY_SHIM_ERROR`, not ALLOW
8. **Duplicate CLI dispatch** — the same dispatch id is submitted twice → one worker session exists; the second call returns the recorded terminal state
9. **Subprocess crash after commit before registry update** — reconcile finds the commit from git truth, rebuilds registry, and resumes at the correct phase
10. **Inbox worker timeout** — internal async worker misses deadline → ticket state records timeout; no call to inert `sys_cancel_task`; late inbox completion is ignored unless its git state passes reconcile
11. **Partial DB write / missing transcript** — registry points at an Omnigent session id whose transcript is missing → `rickgent reconcile` marks session evidence incomplete and refuses phase advance
12. **Unpriced model dispatch** — routing selects an unpriced model → budget policy DENY/ASK before dispatch; no worker session is created

### AC-18 — Worker transport contract drills
**Type:** test
The v0.1 `omnigent run` transport is treated as a protocol with a ledger, not just a subprocess spawn. Every dispatch has `dispatch_id = run_id/ticket_id/phase/attempt/role`, a per-ticket file lock, and a terminal ledger state (`completed | timed_out | killed | salvaged | failed | retried | ignored_late`). CI drills prove:
- **Idempotency:** repeated dispatch with the same `dispatch_id` returns the existing terminal state and never spawns a second worker.
- **Retry rule:** retry is allowed only after reconcile proves no accepted git delta; if a delta exists, salvage/reconcile runs before retry.
- **Ordering:** phases for one ticket are serialized by lock; analyst fan-out may run concurrently only when all children join before the parent phase advances.
- **Backpressure:** configured `max_concurrent_workers` is enforced; excess dispatches queue with trace ids and do not spawn processes.
- **Crash states:** crash before spawn, after spawn before DB session, after DB session before output, after commit before registry update, and after timeout before salvage each produce a distinct typed state and recovery path.
- **Output framing:** stdout/stderr are captured as artifacts; success is determined from exit code + Omnigent DB session + core/git verdicts, never from final text alone.
- **Env & prompt hygiene:** a dispatch from an orchestrator environment seeded with a planted secret spawns a worker whose environment contains only the documented allowlist, and whose prompt header carries only trace identity + ticket scope — the planted secret appears in no prompt, env, or artifact (§10.10.1 security).

### AC-19 — Operational recovery drills
**Type:** test
The §14 operational design is release-blocking, not documentation:
- `rickgent reconcile` rebuilds `.rickgent/registry.json` after registry deletion, corrupt JSON, stale phase, missing Omnigent session, and git/DB disagreement.
- rollback drill installs release `N`, runs through a state-format migration, installs `N-1`, then proves `rickgent reconcile --rollback-from N` can either resume safely or produce a typed non-resumable state without data loss.
- trace drill picks one `run_id/ticket_id/phase/attempt` and proves it appears in Omnigent labels, registry, core NDJSON, worker prompt header, and git notes.
- allowlist-tamper drill injects a second `policy_modules` entry and proves runtime startup fails closed before any worker dispatch.
- same-commit drill proves the TS package, the `rickgent` CLI, and the Python policy wheel all expose the same `build_commit`; mismatch aborts startup.
- `status --deep` drill: with seeded broken state (offline runner, non-terminal ledger entry, registry-vs-git drift, mismatched `build_commit`), `rickgent status --deep` reports every failure class in one run; with clean state it exits 0 (§14.7).
- auth-posture drill: `rickgent doctor` fails when the omnigent server is bound beyond loopback without `OMNIGENT_AUTH_ENABLED=1` (§14.6).

---

## 10. Key design decisions

### 10.1 Package, not fork (REVISED after validation)
The original justification — "an example agent can't add Python policies to the registry" — is **false** for the paths rickgent uses. That restriction applies only to untrusted uploaded bundles and the policy write APIs; trusted local/operator specs reference arbitrary dotted-path policy handlers (`omnigent/policies/function.py`), and the `policy_modules` config loads an external package's `POLICY_REGISTRY` into the registry with full schema validation (`omnigent/policies/registry.py`, wired in `server/app.py` and `cli.py`). Agent configs, skills, and the CLI are likewise extensible without a fork.

Rickgent is therefore an **external package + agent bundle + `policy_modules` entry + wrapper CLI**. Two documented fork triggers, to be *proven* (not assumed) during the build:

1. **First-class lifecycle event types** (`lifecycle_phase_advance`, `lifecycle_prd_validate`) — the policy event vocabulary is a closed `Literal`. Fork only if modeling lifecycle gates as `tool_call` policies on rickgent-owned tools proves insufficient in practice.
2. **A custom web-UI dashboard route** — server routes are hardcoded; the plugin system extends harnesses only. Prefer an upstream PR before forking.

If a trigger fires, fork with `omnigent/` untouched and all changes in additive commits, preserving upstream mergeability.

### 10.2 Full TS lifecycle over a TS verdict core, not thin policies
The FOM proved prose enforcement fails. But thin policies ("DENY if metric < baseline") are also insufficient — Pickle Rick's convergence gate took real incidents to earn its depth (baseline subtraction, freshness checks, scope filtering). The lifecycle modules are full TypeScript implementations refactored from Pickle Rick's TypeScript, with deterministic verdicts delegated to the pure verdict core (`src/core/`). Python policies are enforcement shims only; no lifecycle state machine, salvage executor, convergence loop, or oracle is implemented in Python.

### 10.3 Investigate, then mash
For each component, study both implementations before deciding. Omnigent wins on infrastructure (dispatch, multi-device, sandboxing, policies). Pickle Rick wins on lifecycle logic (microverse, convergence, salvage, circuit breaker, completion oracle). Some components need both (scope fence = Omnigent sandbox + Pickle Rick scope.json). The decision log records the reasoning.

### 10.4 Single completion oracle
ONE predicate, an enumerated caller allowlist, pinned by test — the TS source's actual invariant (one predicate, seven pinned call sites via R-AFCC-CALLER-ENUMERATION), not a literal one-call-site rule. The FOM's #1 reliability lesson.

### 10.5 No bypass flags
Policies either allow or deny. No `allow_state_writes_reason`, no `skip_quality_gates_reason`. The FOM: "two escape hatches for one guard means the guard is wrong."

### 10.6 The PR is the gate
Per-phase checks are advisory or enforced. The full gate runs before the PR. A green PR is the deliverable.

### 10.7 No tmux, no install.sh, no state.json schema
Three of Pickle Rick's largest complexity sources eliminated by building on Omnigent. Omnigent sessions replace tmux. The agent config IS the deployment. Omnigent session state + `.rickgent/registry.json` replace state.json.

### 10.8 Inbox-driven orchestration (agent-internal fan-out only — outer loop superseded by §10.10)
`sys_session_send` is async-only (handle + `async_work_complete` inbox delivery; no blocking join). Any *agent-internal* fan-out (e.g. the refinement analyst team) is inbox-driven: dispatch → await inbox with a rickgent-enforced deadline → record a typed timeout state on breach → ignore late completions unless reconcile proves their git state is attributable and safe. The OUTER loop (phase machine, microverse) instead uses `omnigent run` one-shots with synchronous process joins (§10.10). Either way: `sys_cancel_task` is inert in current omnigent (tasks table removed) — never rely on platform cancellation.

### 10.9 Language strategy — TypeScript product + pure-Python seam shims (Rust kernel DEFERRED to v0.2)
One constraint is physics, not preference: omnigent's policy seam executes Python (`importlib` dotted paths, `POLICY_REGISTRY`) — but it needs only a **shim**, not a layer. The governing test for every other seam: **it must pay rent NOW, not in v0.2.**

- **`orchestrator/` (TypeScript) — the whole product, verdict core included.** Two reasons: (1) **the reference semantics are already TypeScript** — 11.3K lines of mux-runner lineage refactor (strip tmux, swap spawn targets) instead of rewriting into a new language, which was the project's single biggest semantic-loss risk; (2) strict TS catches the plumbing bug class (state shape drift, nulls, non-exhaustive switches) that plagued state.json land, and the team is a TS shop.
  - `src/core/` — the verdict core: completion oracle, salvage disposition logic, scope fence math, convergence gate (baseline subtraction, freshness, scope filtering), circuit breaker + escalation ladders. PURE decision functions over git state and JSON: no process spawns, no git mutations, no I/O beyond reads handed in. Discriminated unions with exhaustive switches for every verdict/disposition type. Same invariants as ever: single completion predicate, pinned caller allowlist, fail closed.
  - `src/lifecycle/` + `src/dispatch/` — loops, phase machine, salvage executor (the git mutations), resume/reconcile, the §10.10.1 transport. Every judgment is a core call.
  - `rickgent verdict <check> --json` — a CLI subcommand exposing the core as JSON-I/O, so non-TS callers (the Python shims; any future consumer) reach the SAME single implementation instead of growing their own.
- **`rickgent-policies/` (pure Python, ~100–200 LOC, NO native bindings)** — enforcement shims only, exposed as a `POLICY_REGISTRY` for omnigent's `policy_modules`. Scope fence runs in-process (hot path; mechanical path canonicalization, parity pinned by shared AC-10 fixtures); every verdict-shaped check shells out to `rickgent verdict` (cold path — roughly once per ticket/phase). No lifecycle logic in Python, ever; no oracle re-implementation in Python, ever.
- **`conformance/` — the fixture suite is the spec.** Language-neutral JSON fixtures (repo states, gate outputs, iteration histories) with expected verdicts. The legacy TS implementation on `experiment/fable-operating-manual` runs against the same fixtures during the refactor — "porting loses semantics" becomes a measured diff, not a hope. Any future port passes the suite or it isn't a port.

**Why the Rust kernel was deferred (decided 2026-07-12, after three adversarial review rounds).** The v0.1 Rust kernel failed the pay-rent-now test: (1) it contradicted this project's core de-risking move — we chose TS to *refactor* battle-tested semantics, then planned to *rewrite* the most safety-critical subset into a new language anyway; (2) its binding surface (napi-rs + PyO3 + maturin + build-commit lockstep + a binding failure matrix) was the single largest operational surface in the plan, existing only to manage seams the kernel itself created; (3) its justifications eroded under review — fleet convergence is v0.2 upside, and once the orchestrator became an external process, no Python shim needed in-process verdict bindings. **v0.2 extraction trigger:** a second kernel consumer materializes (the TS fleet — pickle-rick-claude/-codex/-droid/-grok/-hermes — converging on one verdict implementation) or a verdict-correctness incident that TS's type system provably would not have caught. The extraction is mechanical by design: port `src/core/` against the frozen conformance fixtures. That is what the fixtures are FOR.

**Python seam contract (testable):**
- Inputs are Omnigent `tool_call` policy events plus immutable config (`run_id`, `ticket_id`, `phase`, declared paths, implementer vendor). Shims validate the event shape with a local schema before reading fields.
- Outputs are only `ALLOW`, `DENY`, or `ASK` with a typed reason code (`SCOPE_DENIED`, `COMPLETION_UNVERIFIED`, `POLICY_SHIM_ERROR`, etc.). Unknown exceptions map to `DENY/POLICY_SHIM_ERROR`; no shim may fail open.
- Verdict-shaped checks call `rickgent verdict <check> --json` via subprocess (input on stdin, typed verdict JSON on stdout). A non-zero exit, malformed output, timeout, or missing binary maps to `DENY/POLICY_SHIM_ERROR` — the shim never guesses.
- The Python wheel and the TS package expose the same `build_commit`; the shim asserts it against `rickgent verdict --build-commit` at first call and fails closed on mismatch.
- Versioning is lockstep (§14.1). Python wheels are not published independently in v0.x; a shim hotfix ships as a full monorepo release.
- AC-16 covers malformed inputs across all verdict surfaces; AC-17 covers shim exceptions; AC-19 covers allowlist tampering and build-commit mismatch.

On "typed languages are more reliable": true for the plumbing (types catch shape drift and non-exhaustiveness), and honestly weighed — but the FOM's worst failures were *semantic* (oracle plurality, trusting model claims, stale-baseline convergence), which no type system catches. Strict TS discriminated unions guard the verdict types; the conformance fixtures guard the semantics. Both, deliberately.

Rejected: a full-Rust orchestrator (slowest iteration loop exactly where semantics churn most), Python orchestration (rewrites the largest battle-tested TS surface into a new language for no seam-related reason once policies are shims), TS policies (the policy engine imports Python — physics), and a v0.1 Rust kernel (deferred — see above; it is an extraction option, not a rejection).

### 10.10 Worker transport — `omnigent run` one-shots for v0.1, sessions API for v0.2
Verified against source: `omnigent run <agent> -p "<prompt>"` is a true headless one-shot (`chat.py::_run_one_shot` — sends the prompt, prints the final text, exits), and `cli.py::_ensure_backend` auto-spawns/reuses a persistent local server + daemon + runner, so all CLI-spawned sessions share one DB and remain visible in the web UI. The CLI is itself a pure HTTP client of that server — v0.1 simply doesn't write its own.

- **v0.1:** the orchestrator dispatches each worker/phase as an `omnigent run <worker-agent> -p` subprocess — the exact `claude -p` pattern mux-runner already implements, giving synchronous joins, kill-on-timeout + salvage, and deterministic outer-loop control. Ticket/phase grouping via `.rickgent/registry.json` (+ session labels where available). Costs are measured by AC-18, not asserted: one-shot startup, DB rows per dispatch, process cleanup latency, and p95 dispatch duration are recorded in `transport_metrics.json`. This trades spawn-tree linkage and per-dispatch REST guardrails for determinism — a deliberate, recorded trade (§11), not disguised reuse.
- **v0.2 (as needed):** graduate to the sessions API — validated as fully supported for external orchestration (`POST /v1/sessions` with `parent_session_id`/`sub_agent_name` for true spawn-tree linkage, SSE `/stream` + `WS /sessions/updates` for mid-turn observability, labels, `openapi.json` at the repo root for TS codegen; auth off by default locally). The API's gaps vs `sys_session_send` (per-dispatch `purpose`/`cost_budget` are agent-internal guardrail concepts, not REST fields) are enforced orchestrator-side either way.

#### 10.10.1 v0.1 dispatch protocol

The CLI one-shot is wrapped in a Rickgent protocol; raw subprocess exit is never the product contract.

- **Identity:** every dispatch has `dispatch_id = run_id/ticket_id/phase/attempt/role`, stamped into the worker prompt, Omnigent label, registry ledger, stdout/stderr artifact names, and core NDJSON logs.
- **Ledger:** `.rickgent/dispatch-ledger.jsonl` is append-only. Legal states: `planned`, `spawned`, `db_session_observed`, `completed`, `timed_out`, `killed`, `salvage_started`, `salvaged`, `failed`, `retried`, `ignored_late`. State transitions are monotonic; invalid transitions fail closed.
- **Idempotency:** before spawning, the orchestrator checks the ledger under a per-ticket file lock. If `dispatch_id` is terminal, it returns the recorded terminal state. If it is non-terminal, it runs reconcile before deciding whether to wait, kill, salvage, or retry.
- **Ordering:** phases for a ticket are serialized by `.rickgent/locks/<ticket_id>.lock`. Internal analyst fan-out may run concurrently, but the parent phase cannot advance until every child has a terminal state and the kernel verifies the aggregate input.
- **Backpressure:** `max_concurrent_workers` defaults to 2 for v0.1. Extra work is queued in the ledger as `planned`; no subprocess is spawned until capacity is available. Queue length and wait time are exported by `rickgent metrics`.
- **Retry:** retries are allowed only after reconcile proves there is no accepted git delta for the prior attempt. If a delta exists, salvage decides disposition before retry. Retried attempts receive a new `attempt` number, never the same `dispatch_id`.
- **Crash states:** crash before spawn, after spawn before DB session, after DB session before output, after commit before registry update, and after timeout before salvage are distinct typed states. Each maps to exactly one recovery action in AC-18.
- **Output framing:** stdout/stderr are captured as artifacts and may explain a failure, but success requires exit code 0, an Omnigent DB session with non-empty transcript, and a passing core/git verdict for the phase. Final text alone is never success.
- **Late completions:** if an async internal worker reports after its deadline, its inbox message is recorded as `ignored_late` unless reconcile proves its git state is attributable and safe to salvage.
- **Security:** prompt headers carry only trace identity and ticket scope, never secrets. Environment allowlist is explicit; unknown env vars are stripped before spawn except a documented minimal set (`PATH`, toolchain vars, Omnigent endpoint).

**Scope note:** "subtract before you add" was pickle-rick-claude's medicine for accumulated brittleness. Rickgent is greenfield — it is NOT a design constraint on this build. It survives only as a product feature (the `subtract_before_add` policy that requires simplification reviews in *user* PRDs). The FOM correctness invariants (single oracle, no bypass flags, silence-is-not-success, green-necessary-never-sufficient) are a different category — paid-for incident knowledge — and stand; the kernel exists to make them load-bearing in every consumer at once.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Upstream Omnigent drift (alpha status, 0.6.0.dev0, Databricks-owned, moving fast) | Pin the omnigent version; compat smoke suite (AC-2); upgrade deliberately; fork remains the escape hatch (§10.1) |
| Refactoring the TS lifecycle loses semantics | Verdict logic consolidates into `src/core/` with a conformance fixture suite differential-tested against the legacy TS reference (AC-16) — semantic drift is a measured diff, not a hope; tests cover each FOM incident class as regression; decision log records what was refactored and why |
| Dual-language drift: scope-fence path math exists in both TS core and the Python shim | The SAME AC-10 fixture set runs against both implementations in CI; any divergence fails the build. All other verdicts are single-implementation via `rickgent verdict` (§10.9) |
| `rickgent verdict` subprocess adds latency/failure modes to cold-path policies | Cold path only (~once per ticket/phase); CLI failure maps to DENY (fail closed); p95 budget in AC-16's malformed-input matrix |
| CLI transport lacks spawn-tree linkage and per-dispatch purpose/cost guardrails | v0.1 dispatch protocol: ledger, idempotency, retry rules, ordering, backpressure, crash states, output framing (§10.10.1); purpose/budget enforced before spawn and drilled in AC-18; v0.2 sessions API remains the upgrade path |
| ~~Microverse loop is tightly coupled to tmux~~ ANSWERED | mux-runner has ~23 tmux references in 11.3K LOC; the recovery state machine already lives in `recovery-controller.ts`. Ports cleanly — tmux is a delivery layer |
| ~~Policy API doesn't support lifecycle events~~ ANSWERED | Event vocabulary is a closed `Literal`. Lifecycle gates are `tool_call` policies on rickgent-owned tools; extending event types is fork trigger #1 (§10.1) |
| ~~Mid-pipeline resume~~ ANSWERED | Omnigent resume is conversation/wrapper-level only. The rickgent resume layer (registry.json + git-truth reconcile + re-dispatch) is in scope for v0.1 |
| Async-only dispatch breaks foreground-worker assumptions | Internal fan-out has explicit deadline states, late-completion ignore rules, and no reliance on inert `sys_cancel_task` (§10.10.1, AC-17); outer loop uses CLI one-shots with process-group kill + salvage |
| `git worktree remove --force` discards uncommitted work | Salvage ALWAYS runs before worktree removal; never remove a worktree with an unsalvaged diff |
| Windows Job Object doesn't isolate filesystem/network | Don't count Windows as sandboxed; the scope-fence policy still applies everywhere |
| Unpriced models degrade cost-budget policies | Treat unpriced dispatch as unbounded-risk: require explicit opt-in or route to a priced model; AC-2 and AC-17 prove unpriced dispatch is blocked before worker creation |
| Rollback under lockstep can fail if state format changes | Append-only state envelope + previous-release rollback reader (§14.5); AC-19 drills rollback across a state-format migration |
| Registry / DB / git state disagreement causes false resume | `.rickgent/registry.json` is derived only; `rickgent reconcile` rebuilds it from git + Omnigent DB + dispatch ledger and refuses incomplete evidence (§14.4, AC-19) |
| 99% quality is aspirational | v0.1 measures empirically using matured PR windows and a defect ledger (§5.4); GA requires demonstrated 99% across N runs |

---

## 12. Simplification Review

*(Scope note: "subtract before you add" is not a design constraint on this greenfield build — see §10.9. This review stands as documentation of what is reused vs written, not as a brake on ambition.)*

1. **Is the addition necessary?** The lifecycle layer is the entire point. One ownership model: TS product (verdict core included) + ~150 LOC pure-Python shims + 7 skills. The rest is reuse.

2. **Can it REUSE?** Yes — Omnigent's dispatch, sessions, policies, web UI, sandboxes, cost tracking, model routing. The FOM is adapted, not rewritten.

3. **Does it guard brittle complexity?** No — it avoids importing it. Known brittle complexity (dual spawn, forward-ref grammar, gate overreach, hook enforcement) is NOT ported.

4. **What can it SUBTRACT?** Corrected denominators: the full Pickle Rick TS runtime is ~72.5K LOC; the named port surface is ~20K LOC (mux-runner 11.3K + microverse-runner 4.7K dominate, much of that tmux delivery, defensive guards, and inline trap-door prose). Target ~5–8K LOC of TypeScript (core + lifecycle + dispatch), ~150 LOC of pure-Python policy shims, and 7 skill prompts — no native bindings, no third language in v0.1. The subtraction claim holds against the named surface; the ~4x compression is aggressive — treat 5K TS as a target, not a promise, and let the decision log record what was deliberately NOT ported (tmux, install.sh, state.json schema, hook plumbing, monitor TUI, audit scripts).

---

## 13. Build plan

### Phase 0: Investigation (days 1-6) — THE MASH PHASE

For each component in the investigation matrix (Section 2):
1. Read both implementations (Omnigent Python + Pickle Rick TypeScript)
2. Document the contract, invariants, and failure modes
3. Evaluate which is better for Rickgent's goals
4. Decide: port / reuse / mash / skip
5. Write the decision file at `rickgent/docs/decisions/<component>.md`

**Deliverable:** A complete decision log covering all components. This is the input for all subsequent phases.

### Phase 1: Monorepo scaffold and artifact identity (days 7-10)
- Scaffold `orchestrator/` (pnpm + tsconfig strict) and `rickgent-policies/` (pyproject depending on pinned omnigent)
- Agent bundle skeleton (`agents/rickgent/`)
- Wire `rickgent_policies` into `policy_modules`; verify registry load
- Omnigent compatibility smoke suite green (AC-2); verify `omnigent run <bundle> -p "ping"` one-shot end-to-end
- CLI skeleton (`rickgent` bin in orchestrator)
- Embed `build_commit` in TS package, `rickgent` CLI, and policy wheel; startup same-commit assertion green (AC-19)

### Phase 2: Verdict core and conformance (days 11-20)
Based on the investigation decisions, core-first:
- Extract conformance fixtures from the legacy TS implementation (repo states, gate outputs, iteration histories → expected verdicts)
- Refactor the verdict logic into `orchestrator/src/core/` against those fixtures; differential-test every verdict vs the legacy reference (AC-16)
- `rickgent verdict <check> --json` CLI subcommand over the core
- Malformed-input matrix and fail-closed typed-error mapping across all three verdict surfaces (AC-16)
- Oracle single-predicate / pinned-caller audit wiring (AC-5)

### Phase 3: Lifecycle orchestration (days 21-28)
- TypeScript refactor of the phase machine, microverse loop, salvage executor, resume/reconcile — from mux-runner/recovery-controller/microverse-runner lineage, not rewritten
- Tests for each module (AC-4 through AC-9)
- Integration with Omnigent's runner and session model

### Phase 4: Policies, FOM, and fail-closed seam hardening (days 29-32)
- Pure-Python enforcement shims (scope fence in-process; verdict checks via `rickgent verdict`)
- FOM adaptation + `orchestrator/src/fom.ts` programmatic access
- Runtime `policy_modules` allowlist enforcement and shim-exception DENY drills (AC-17, AC-19)

### Phase 5: Worker transport protocol (days 33-38)
- Dispatch ledger, per-ticket locks, idempotency, retry rules, backpressure, crash-state mapping, stdout/stderr artifacts, late-completion handling (§10.10.1)
- Transport metrics artifact and AC-18 drills

### Phase 6: Skills and agent config (days 39-43)
- 7 skill `SKILL.md` files
- Default agent config with FOM-infused prompt
- Verify FOM disciplines (AC-12) and skill behavioral artifacts (AC-11)

### Phase 7: End-to-end integration and operational recovery (days 44-50)
- Wire CLI to lifecycle + skills
- End-to-end demo (AC-14)
- Cross-vendor review test (AC-13)
- Multi-device test
- `rickgent reconcile`, rollback drill, trace drill, allowlist tamper drill, same-commit drill, `status --deep` drill, auth-posture drill (AC-19)

### Phase 8: Hardening and release (days 51-56)
- Regression tests for each FOM incident class
- Oracle single-predicate / pinned-caller audit (AC-5)
- Planted-failure enforcement drills (AC-17)
- Documentation
- Tag v0.1.0-alpha

---

## 14. Operational design

### 14.1 Versioning: lockstep by construction, not contracts
Version-negotiation machinery is itself a failure source, so there is none for normal v0.x operation. The monorepo ships orchestrator (core included) + policy shims as ONE version: every release builds all artifacts from the same commit and runs the conformance suite through all three verdict surfaces (core API, `rickgent verdict` CLI, Python subprocess path); artifacts are never published or consumed independently in v0.x. Version skew across the TS/Python boundary is eliminated by construction — there is no compatibility matrix because there is exactly one supported combination. The only external version seam is the omnigent pin, guarded by AC-2.

Lockstep is enforced at runtime, not just in CI. The TS package, the `rickgent` CLI, and the Python policy wheel each expose `build_commit`; startup aborts if any value differs. Hotfixes ship as a full monorepo release built from one commit. Partial layer rollback is unsupported by design; the operator-facing command refuses to install mismatched artifacts. (With no native bindings in v0.1, lockstep is nearly free — a two-language monorepo released as one unit.)

### 14.2 Trace identity
Every dispatch carries `run_id / ticket_id / phase / attempt / role / dispatch_id`, stamped into: omnigent session labels, `.rickgent/registry.json` entries, dispatch ledger entries, core verdict logs (NDJSON), stdout/stderr artifact names, git notes on salvage commits, and the worker prompt header. AC-19 proves one grep on a trace id correlates a failure across TS, Python, Omnigent, and git.

### 14.3 Structured errors
The verdict core returns typed verdicts or typed errors (discriminated unions with exhaustive switches; the `rickgent verdict` CLI emits the same shapes as tagged JSON; the Python shim maps them to typed reason codes) — never prose for callers to parse. The orchestrator logs NDJSON with trace fields on every event. Error *prose* stays stable across releases: breaker signatures count errors by text shape (FOM §7), so rewording an error message is a behavior change.

### 14.4 State authority model
Three state planes, one hierarchy, no ambiguity:
1. **Git is truth** for work product — always.
2. **Omnigent's DB is truth** for sessions, transcripts, and cost.
3. **`.rickgent/registry.json` is a derived index**, never an authority — rebuildable at any time from git + the omnigent DB via `rickgent reconcile`. Corruption or disagreement resolves by rebuild; no code path may trust the index over its sources.

`rickgent reconcile` is a required command, not an implied behavior. It reads git, Omnigent DB, dispatch ledger, core NDJSON, and PR artifacts; emits a typed reconciliation report; rewrites `.rickgent/registry.json` atomically; and refuses phase advance if evidence is incomplete. AC-19 covers deletion, corrupt JSON, stale phase, missing Omnigent session, and git/DB disagreement.

### 14.5 Rollback
A broken rickgent release rolls back by reinstalling the previous monorepo version (lockstep makes this one operation), then `rickgent reconcile --rollback-from <version>` rebuilds the index; in-flight tickets resume from git-truth only after reconcile verifies all evidence needed by the older release. Workers are one-shot processes, but their sessions, transcripts, labels, costs, dispatch ledger entries, and git notes are stateful and must be readable during rollback.

State-format migration is append-only in v0.x. A release may add fields, never destructively rewrite evidence. Every release supports rollback from exactly the immediately previous release by carrying a `rollback_reader` for the prior state envelope. If the prior release cannot safely resume a ticket, reconcile emits a typed `NON_RESUMABLE_AFTER_ROLLBACK` state and preserves all artifacts; it never guesses.

### 14.6 Security and supply chain
- The local server binds loopback with auth off — acceptable for single-operator local use ONLY; exposing it beyond loopback requires `OMNIGENT_AUTH_ENABLED=1`, documented loudly.
- `policy_modules` dotted-path import is arbitrary code execution by design. Only `rickgent_policies` is listed; both startup and `rickgent doctor` assert the allowlist contains nothing else. A mismatch is fatal before any worker dispatch, and AC-19 proves tampering fails closed.
- Lockfiles committed (`pnpm-lock.yaml`, pinned Python requirements); `pnpm audit` + `pip-audit` in CI; no native/prebuilt binary dependencies in v0.1 (the Rust extraction, if it happens, adds `Cargo.lock` + `cargo audit` then).

### 14.7 Failure ownership and diagnosis
Single-operator project: every failure across server / daemon / runner / workers / DB / registry / bindings lands on the same human. The design therefore optimizes for single-command diagnosis: `rickgent status --deep` checks server health, runner liveness, the last N sessions, registry-vs-git drift, dispatch-ledger non-terminal states, trace continuity, policy allowlist, artifact build commits, and a verdict-surface self-test (core API + CLI + shim path agree on one fixture) — before anyone reads a log file.

### 14.8 Salvage: decide / execute / verify
The verdict core *decides* (pure disposition from inputs), the lifecycle layer *executes* the git mutations, the core *verifies* the post-state. No destructive git operation lives in `src/core/`; no disposition judgment lives in `src/lifecycle/`. This is the verdict/mutation line for every core component, stated once here and binding everywhere.

## 15. The north star

> *"The bar is not green tests. The bar is N hands-off runs in a row where every claim was true."*

Rickgent inherits this bar. The platform gives it:
- A bigger fleet (natively multi-model)
- Better infrastructure (Omnigent's sessions, sandboxes, policies)
- The FOM's judgment (calibration, epistemics, intervention discipline)
- The reliability lessons (single oracle, no bypass flags, subtract before add)
- The quality barriers (cross-vendor review, conformance audit, deslopping, convergence)
- The best tool for each job (investigate, then mash)

Get schwifty. Verify everything.

---

## 16. Implementation notes for the build agent

You are implementing this in a fresh session with no access to the conversations that produced this document. Everything below was verified against source on 2026-07-12 — do not re-derive it, but DO re-verify anything marked (re-verify) since both source repos move.

### 16.1 Ground rules

- This document is the sole build contract. Where it is silent, the decision log (`docs/decisions/`) is the second authority; write a decision file before improvising.
- The `rickgent/` directory is its own git repository (it currently contains only this PRD). Work on branches; commit early and often.
- One repo at a time. Do NOT modify `pickle-rick-claude/`, `omnigent/`, or any sibling directory — they are read-only reference material.
- Do NOT create Linear issues for internal tickets. Do NOT add languages, frameworks, or native bindings beyond §10.9 without a decision-log entry.
- Phase order is §13. Phase 0's decision log is seeded from §2.1.1/§2.2.1 — adopt or explicitly overturn each finding with evidence; silent contradiction fails AC-3.

### 16.2 Source material — pickle-rick-claude (the lifecycle reference)

Repo: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`, branch **`experiment/fable-operating-manual`** (HEAD `73aa1970` at validation time — re-verify). This is the legacy reference for the conformance suite and the refactor source. Key artifacts, all verified present with the listed exports:

| Artifact | Path | LOC | Notes |
|---|---|---|---|
| Microverse loop | `extension/src/bin/microverse-runner.ts` | 4,674 | 15 named exports incl. `executeMainLoop`, `measureAndClassifyIteration`, `autoRescueDirtyTree`, `buildJudgePrompt` |
| Microverse state | `extension/src/services/microverse-state.ts` | 497 | 14 exports incl. `isConverged`, `recordIteration`, `resolveStallLimit`, `recordAmnesiacExit` |
| Convergence gate | `extension/src/services/convergence-gate.ts` | 1,364 | `runGate`, `filterByScope`, `assertBaselineFresh`, `subtractBaseline`, `detectProjectType`, `getWorkspacePackages` |
| Circuit breaker | `extension/src/services/circuit-breaker.ts` | 438 | thresholds here; the OTHER ladder rungs live in mux-runner.ts: `silentDeathGit`, `evaluateFailedFlipSuppression`, `BOUNDED_ESCAPE_STRATEGY`, `isWithinBreakerRecoveryGrace` — pull from BOTH files |
| Salvage | `extension/src/lib/salvage-ticket.ts` (213), `extension/src/lib/reconcile-ticket-truth.ts` (104), `extension/src/services/dirty-tree-salvage.ts` (129) | — | `SalvageDisposition` union: `ff-reattached \| committed-done \| archived-todo \| no-op \| error` |
| Completion oracle | `extension/src/services/ticket-completion-evidence.ts` | 874 | ONE predicate (`evaluateCompletionEvidence`), SEVEN call sites, importer set pinned by test (R-AFCC-CALLER-ENUMERATION) — replicate the invariant, not a literal one-call-site rule |
| Outer loop | `extension/src/bin/mux-runner.ts` | 11,339 | only ~23 tmux references; the recovery state machine is already factored into `extension/src/services/recovery-controller.ts` (`parsePlanPhases`, `executePhaseLoop`, `ReExecutionSeam`) — start the phase-machine refactor THERE |
| Scope check | `extension/src/bin/check-scope-diff.ts` | 201 | `checkScopeDiff`, `ImpactRadiusService` |
| PRD/refinement | `.claude/commands/pickle-prd.md`, `.claude/commands/pickle-refine-prd.md` (46K) | — | prompt skills; there is NO `prism` runtime module — adapt the prompts, model the types fresh (§3.7) |
| FOM | `docs/FABLE_OPERATING_MANUAL.md` | 26K | contains R-SZGB, R-MPGD, oracle-collapse, "validation overreach". R-WSRC and R-MACB are repo trap-door codes (CLAUDE.md + source comments), NOT in the manual — cite accordingly |

Read first, in order: the FOM, `recovery-controller.ts`, `convergence-gate.ts`, `ticket-completion-evidence.ts`, then mux-runner.ts selectively (it is 11K lines — navigate by the exports named above).

### 16.3 Omnigent facts (verified against source — re-verify the pin)

Repo: `/Users/gregorydickson/loanlight/pickle-rick/omnigent`. Databricks, Apache-2.0, alpha. At validation: `0.6.0.dev0` in `pyproject.toml`; latest release v0.5.0 (`CHANGELOG.md`). Pin a release or commit; record it in the decision log.

- **Headless one-shot (the v0.1 transport):** `omnigent run <agent-dir> -p "<prompt>"` sends the prompt, prints final text, exits — `omnigent/chat.py::_run_one_shot` (triggered when `initial_message` is set). `omnigent/cli.py::_ensure_backend` auto-spawns/reuses a persistent local server + daemon + runner; all CLI sessions share one DB (web UI at `http://localhost:6767` shows them). `--resume <conv_id>` works in one-shot mode.
- **Policy loading:** `load_registry(extra_modules=[...])` in `omnigent/policies/registry.py` ingests an external package's `POLICY_REGISTRY` (see `omnigent/policies/builtins/__init__.py` for the registry convention); server wires it via the `policy_modules` config key (`omnigent/server/app.py`, `omnigent/cli.py`). Trusted local specs may also reference dotted-path handlers directly (`omnigent/policies/function.py`).
- **Policy events:** CLOSED `Literal` vocabulary — `request | tool_call | tool_result | response | llm_request | llm_response` (`omnigent/policies/schema.py`); verdicts `ALLOW | DENY | ASK`. There is NO custom event type — lifecycle gates fence `tool_call`s on rickgent-owned tools (§4). Do not add event types (fork trigger #1).
- **Agent bundles:** `config.yaml` per `omnigent/spec/AGENTSPEC.md` (spec_version 1); sub-agents in `agents/<name>/config.yaml`; skills in `skills/<name>/SKILL.md` (frontmatter: `name` matching dir + `description`). Study `examples/polly/` — it is the closest existing multi-agent orchestrator bundle, including a cross-review skill.
- **TRAPS (do not rediscover these):**
  - `sys_cancel_task` is INERT — the server tasks table was removed; it returns `task_not_found` for all inputs. Never rely on platform cancellation; timeout = rickgent-side deadline + kill + salvage.
  - `sys_session_send` is async-only (handle + `async_work_complete` inbox). No blocking join exists for agent-internal dispatch.
  - Omnigent resume is conversation-level only (`resume_dispatch.py`) — rickgent's own reconcile/resume is mandatory.
  - `git worktree remove` in omnigent's host layer uses `--force` and discards uncommitted work — salvage BEFORE any worktree removal, always.
  - Windows Job Object sandbox does not isolate filesystem/network.
  - Model pricing is fetched from MLflow at runtime and can be absent — unpriced models silently weaken cost policies; treat unpriced as unbounded-risk (AC-2/AC-17 drill this).
  - Sub-agent `purpose` values are `implement | review | explore | search`, enforced by the `headless_subagent_purpose_guard` builtin.
- **v0.2 only (do not build now):** sessions API (`POST /v1/sessions` with `parent_session_id`/`sub_agent_name`, SSE `/stream`, `WS /v1/sessions/updates`; `openapi.json` at the omnigent repo root for TS codegen; auth off by default locally via `OMNIGENT_AUTH_ENABLED`).

### 16.4 Conformance fixture format (the spec artifact)

Each fixture in `conformance/fixtures/` is one JSON file: `{ "id", "check" (completion|salvage|breaker|gate|scope), "input" (a serialized snapshot: git facts as plain data — SHAs, tree hashes, path lists, gate outputs, iteration history; never a live repo), "expected" (the typed verdict), "source" (legacy file:line or decision-log ref that justifies the expectation) }`. Fixtures are extracted in Phase 2 by running the legacy implementations on synthetic repos and recording their verdicts; every FOM incident class gets at least one fixture. The deviation clause (AC-16) governs corrections.

### 16.5 Definition of done

v0.1.0-alpha ships when AC-1 through AC-19 are all green in CI, the decision log covers every §2 component, and the AC-14 fixture pipeline has run clean end-to-end at least twice consecutively. The north star (§15) outranks any individual green check: a claim that is not backed by git tree-truth is a bug, whoever makes it — worker, policy, orchestrator, or you.
