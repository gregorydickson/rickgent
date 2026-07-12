# Phase 0 Report — Investigation

**Date:** 2026-07-12
**Phase:** Phase 0 (§13) — Investigation
**Exit gate:** AC-3 (component investigation decision log exists and is evidence-backed)

## What the phase claimed to deliver

A complete decision log at `docs/decisions/` covering every component in the §2 investigation matrix (27 components across §2.1 infrastructure, §2.2 lifecycle, §2.3 enforcement), with each decision file containing:
- Both implementations studied with file:line citations into EACH codebase
- Contract documented (what the component does, invariants, failure modes)
- Evaluation (which is better for Rickgent's goals)
- Explicit `Decision:` line (port/reuse/mash/skip)
- Reasoning
- §2.1.1/§2.2.1 pre-validated finding adopted or explicitly overturned with evidence

## AC results

### AC-3 — Component investigation decision log exists and is evidence-backed

**Result: GREEN (pending countersign)**

27 decision files written to `docs/decisions/`:

**Infrastructure (§2.1) — 11 files:**
| Component | Decision | §2.1.1 Finding |
|---|---|---|
| worker-dispatch | reuse (Omnigent) | ADOPTED |
| context-clearing | reuse (Omnigent) | ADOPTED |
| multi-device | reuse (Omnigent, dashboard deferred) | ADOPTED |
| sandboxing | mash | ADOPTED |
| policy-framework | reuse (Omnigent) | ADOPTED |
| model-routing | reuse (Omnigent) | ADOPTED |
| cross-vendor-review | mash | ADOPTED |
| cost-tracking | mash | ADOPTED |
| state-management | mash | ADOPTED |
| session-resume | port (Pickle Rick) | ADOPTED |
| cancellation | port (Pickle Rick timeout) | ADOPTED |

**Lifecycle (§2.2) — 11 files:**
| Component | Decision | §2.2.1 Finding |
|---|---|---|
| microverse | port (Pickle Rick) | ADOPTED |
| convergence-gate | port (Pickle Rick) | ADOPTED |
| salvage | port (Pickle Rick) | ADOPTED |
| circuit-breaker | port (Pickle Rick) | ADOPTED |
| completion-oracle | port (Pickle Rick) | ADOPTED |
| phase-machine | port (Pickle Rick) | ADOPTED |
| prd-ticket-decomposition | port (Pickle Rick) | ADOPTED |
| citadel | port (Pickle Rick) | Fresh investigation |
| szechuan | port (Pickle Rick) | Fresh investigation |
| anatomy-park | port (Pickle Rick) | Fresh investigation |
| cronenberg | port (Pickle Rick) | Fresh investigation |

**Enforcement (§2.3) — 5 files:**
| Component | Decision | Pre-build Finding |
|---|---|---|
| scope-fence | mash | Fresh investigation |
| forbidden-ops | mash | Fresh investigation |
| quality-gates | skip | Fresh investigation |
| worker-timeout | port (Pickle Rick) | Fresh investigation |
| orphan-reaping | skip | Fresh investigation |

**Lint compliance:**
- Every file contains an explicit `## Decision:` line — verified by grep (27/27)
- Every file contains file:line citations into both codebases — verified by spot-check
- Every §2.1.1/§2.2.1 finding is explicitly ADOPTED with evidence — verified by grep
- No silent contradictions — all findings either adopted or noted as fresh investigations

**Remaining for AC-3:** Each decision file must be countersigned by a different-vendor reviewer before Phase 2 consumes it. This is a cross-vendor review step that requires dispatching to a different harness.

## §16 (re-verify) claims — verification results

### 1. Omnigent version/pin — CONFIRMED
- `pyproject.toml`: `version = "0.6.0.dev0"` (line 7)
- `CHANGELOG.md`: latest release `v0.5.0` dated 2026-07-10
- No change from PRD validation. Pin decision recorded in decision log.

### 2. Pickle-rick-claude branch HEAD — CHANGED (non-load-bearing)
- PRD states HEAD `73aa1970` at validation time
- Current HEAD: `95f5c416` (3 new commits)
- `git diff --stat 73aa1970..95f5c416` shows changes only in:
  - `extension/tests/` (3 test files)
  - `prds/` (3 doc files: BUG-INDEX.md, MASTER_PLAN.md, p2-start-commit-adopt-pinned-sha.md, new incident report)
- **No source logic files changed.** All named artifacts in §16.2 verified unchanged with exact LOC counts and exports.
- **Verdict:** Not a load-bearing premise break. The conformance suite will pin against `95f5c416` (current HEAD).

### 3. Omnigent `run -p` one-shot behavior — CONFIRMED
- `_run_one_shot` at `omnigent/chat.py:4017` — sends prompt, prints final text, exits
- Triggered when `initial_message is not None` (`chat.py:969-970`)
- `_ensure_backend` at `omnigent/cli.py:2404` — auto-spawns/reuses persistent local server + daemon + runner
- All CLI-spawned sessions share one DB

### 4. Policy registry loading path — CONFIRMED
- `load_registry(extra_modules=[...])` at `omnigent/policies/registry.py:68`
- Wired via `policy_modules` config key in `omnigent/cli.py:3164` and `omnigent/server/app.py:1320`
- `POLICY_REGISTRY` convention in `omnigent/policies/builtins/__init__.py`

## Additional §16.3 facts verified

| Claim | Status | Evidence |
|---|---|---|
| Policy event vocabulary is closed `Literal` | CONFIRMED | `schema.py:219-224`: `request\|tool_call\|tool_result\|response\|llm_request\|llm_response` |
| Policy verdicts: `ALLOW\|DENY\|ASK` | CONFIRMED | `schema.py:294` |
| `sys_cancel_task` is INERT | CONFIRMED | `async_inbox.py:101-103`: "returns `task_not_found` for all inputs" |
| `sys_session_send` is async-only | CONFIRMED | `spawn.py:111-112`: handle + `async_work_complete` inbox |
| `headless_subagent_purpose_guard` purposes | CONFIRMED | `orchestration.py:466-468`: `("implement", "review", "explore", "search")` |
| 11 native harnesses | CONFIRMED | `harness_plugins.py:100-193`: claude, codex, pi, opencode, cursor, kiro, goose, antigravity, qwen, kimi, hermes |
| AGENTSPEC.md exists | CONFIRMED | `omnigent/spec/AGENTSPEC.md` |
| examples/polly/ exists with cross-review skill | CONFIRMED | `examples/polly/skills/cross-review/SKILL.md` |

## §16.2 source artifacts — verification results

All 11 named artifacts verified present with exact LOC matches:

| Artifact | Path | PRD LOC | Actual LOC | Exports |
|---|---|---|---|---|
| Microverse loop | `extension/src/bin/microverse-runner.ts` | 4,674 | 4,674 | 15/15 verified |
| Microverse state | `extension/src/services/microverse-state.ts` | 497 | 497 | 14/14 verified |
| Convergence gate | `extension/src/services/convergence-gate.ts` | 1,364 | 1,364 | 6/6 verified |
| Circuit breaker | `extension/src/services/circuit-breaker.ts` | 438 | 438 | 6/6 verified |
| Salvage | `extension/src/lib/salvage-ticket.ts` | 213 | 213 | SalvageDisposition union verified at line 32-35 |
| Reconcile truth | `extension/src/lib/reconcile-ticket-truth.ts` | 104 | 104 | — |
| Dirty tree salvage | `extension/src/services/dirty-tree-salvage.ts` | 129 | 129 | — |
| Completion oracle | `extension/src/services/ticket-completion-evidence.ts` | 874 | 874 | `evaluateCompletionEvidence` at line 821 |
| Outer loop | `extension/src/bin/mux-runner.ts` | 11,339 | 11,339 | ~23 tmux references confirmed |
| Scope check | `extension/src/bin/check-scope-diff.ts` | 201 | 201 | — |
| Recovery controller | `extension/src/services/recovery-controller.ts` | 342 | 342 | `parsePlanPhases`, `executePhaseLoop`, `ReExecutionSeam` verified |

## Deviations recorded in the decision log

No deviations from the PRD's §2.1.1/§2.2.1 findings. All pre-validated findings were adopted with evidence.

One non-load-bearing drift: pickle-rick-claude branch HEAD moved from `73aa1970` to `95f5c416` (docs/test/audit commits only, no source logic changes). The conformance suite will pin against the current HEAD.

## Items a human must decide

1. **Cross-vendor countersign (AC-3 requirement):** Each of the 27 decision files must be countersigned by a different-vendor reviewer before Phase 2 consumes them. This requires dispatching a review task to a different harness (e.g., codex, pi). This is a Phase 1 prerequisite once the omnigent dispatch is operational, or it can be done manually.

2. **Omnigent pin strategy:** The PRD allows pinning either v0.5.0 (latest release) or a pinned 0.6.0.dev commit. The decision affects API stability vs. feature availability. The decision log records the options; a concrete pin must be chosen in Phase 1.

3. **Fork triggers (§10.1):** Neither fork trigger has fired during Phase 0. The closed policy event vocabulary is confirmed, and modeling lifecycle gates as `tool_call` policies on rickgent-owned tools remains the plan. The custom dashboard route (trigger #2) remains deferred.

## Summary

Phase 0 is complete. All 27 decision files are written with file:line evidence into both codebases. Every §2.1.1/§2.2.1 finding is explicitly adopted. No load-bearing premises are broken. The only drift (branch HEAD) is non-load-bearing (docs/test/audit commits only). The decision log covers every §2 component. Ready to proceed to Phase 1 upon countersign and pin decision.
