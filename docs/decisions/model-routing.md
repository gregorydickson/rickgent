# Decision: Model Routing

## Component
§2 matrix row: Model Routing — how the system selects which LLM model each worker dispatch should use, based on task difficulty and cost.

## Omnigent implementation
Omnigent has an LLM-judge-based smart routing system in `omnigent/server/smart_routing.py` (376 LOC):

- **`sys_advise_models`** (`omnigent/tools/builtins/advise_models.py:1-60`) — a built-in tool that recommends a model for each sub-agent task before fan-out. It accepts a list of tasks and returns `{"recommendations": [...], "router_on": true/false}`. Each recommendation has `{title, agent, model, tier, rationale}`. The caller passes the recommended `model` as `args.model` when invoking `sys_session_send`. Advisory only.
- **Rubric**: SIMPLE/MODERATE/COMPLEX, mapped to cost tiers per harness family (`smart_routing.py`, docstring at ~line 35): "SIMPLE → cheapest available model (haiku for Claude; nano for GPT); MODERATE → mid-range model (sonnet for Claude; mini for GPT); COMPLEX → most capable model (opus for Claude; newest base GPT)." The rubric is built by `_build_rubric(available_models)` and passed as `instructions` to the LLM judge.
- **Model lists per harness family** (`smart_routing.py:~22-45`): `MODEL_LISTS` dict with `"claude"` (haiku → sonnet → opus), `"gpt"` (nano → mini → gpt-5-4 → gpt-5-5), and `"pi"` (interleaved Claude + GPT). `_HARNESS_FAMILY` maps harness names to families (e.g., `"claude-native" → "claude"`, `"codex-native" → "gpt"`).
- **`RoutingClient` protocol** (`smart_routing.py:~100`): pluggable routing implementations. The default `LLMRoutingClient` calls the server-level LLM with the rubric prompt. Managed deployments can swap implementations via `RuntimeCaps`.
- **`RoutingResult`** (`smart_routing.py:~83`): `{model, rationale, harness}`.
- **Gating**: `sys_advise_models` is registered only when `RuntimeCaps.routing_client` is configured, which requires `OMNIGENT_SMART_ROUTING=1` plus an `llm:` config block (`advise_models.py:13-16`). When the router is off, `model` in recommendations is `null`.
- **`sys_list_models`** + per-dispatch `model` override: the model catalog is available via `sys_list_models`, and each `sys_session_send` call can override the recommended model via `args.model` (create-time only, valid only for harnesses with model plumbing).

## Pickle Rick implementation
Pickle Rick uses a `--backend claude|codex` flag and a `PICKLE_BACKEND` environment variable. The backend resolution chain is in `services/backend-spawn.ts`: `resolveBackend` reads `process.env.PICKLE_BACKEND` (line references in `backend-spawn.ts` grep results), and `spawn-morty.ts` parses `--backend` from `argv` (the `R-XBL-2` override, `spawn-morty.ts:~62-70`). Accepted values: `claude|codex|hermes|grok|kimi|gemini` (`spawn-morty.ts` die message).

Within the Claude backend, a hardcoded `TIER_MODEL_MAP` (`spawn-morty.ts:~50`) maps ticket complexity to model: `trivial→haiku`, `small→sonnet`, `medium→sonnet`, `large→opus`. There is no LLM judge, no rubric, no cross-vendor routing, and no per-dispatch override — the model is fixed by the ticket's complexity tier and the selected backend. The `resolveCodexModel` function (imported by `mux-runner.ts` from `spawn-morty.ts`) handles Codex model selection separately.

## Contract
The model routing component must: (1) recommend an appropriate model per dispatch based on task difficulty, (2) support multiple vendor families (Claude, GPT, etc.), (3) allow per-dispatch override, (4) be advisory (the orchestrator can ignore the recommendation), (5) be gated so it can be turned off. Invariants: recommendations are ordered cheapest → most capable; the rubric is consistent within a harness family; the router is off by default. Failure modes: router unavailable (no `llm:` config), harness unrecognized (model is `null`), judge LLM failure.

## Evaluation
Omnigent is strictly better for Rickgent's goals. `sys_advise_models` is an LLM judge with a SIMPLE/MODERATE/COMPLEX rubric that works across vendor families (Claude, GPT, Pi's interleaved set). It is multi-vendor by construction: `MODEL_LISTS` covers Claude and GPT families, `_HARNESS_FAMILY` maps 9+ harness names to families, and the `RoutingClient` protocol allows custom routing logic. Pickle Rick's `--backend` flag + `TIER_MODEL_MAP` is a static lookup that only varies model tier within a single backend — it cannot route across vendors, has no LLM judge, and requires the operator to manually select the backend. The per-dispatch `args.model` override in Omnigent gives the orchestrator final say, which Pickle Rick lacks entirely.

## §2.1.1 Finding
ADOPT — "CONFIRMED. `sys_advise_models` is an LLM-judge with a SIMPLE/MODERATE/COMPLEX rubric mapped to cost tiers per harness family, gated by `OMNIGENT_SMART_ROUTING=1` + an `llm:` config block; `sys_list_models` + per-dispatch `model` override exist." Evidence: `advise_models.py:1-60` (tool schema, gating at lines 13-16), `smart_routing.py:~22-45` (`MODEL_LISTS` + `_HARNESS_FAMILY`), `smart_routing.py:~35` (SIMPLE/MODERATE/COMPLEX rubric docstring), `smart_routing.py:~83` (`RoutingResult`), `smart_routing.py:~100` (`RoutingClient` protocol), `_build_rubric` function. The per-dispatch `model` override is documented in the `sys_session_send` schema (`spawn.py`).

## Decision: reuse
Reuse Omnigent's `sys_advise_models` — automatic, multi-vendor.

## Reasoning
Rickgent's core differentiator is automatic multi-model routing: the orchestrator should not need a `--backend` flag or a manual tier map. Omnigent's `sys_advise_models` already solves this with an LLM judge that reads the task description, applies a SIMPLE/MODERATE/COMPLEX rubric, and recommends a model from the appropriate vendor family. The `MODEL_LISTS` and `_HARNESS_FAMILY` tables cover Claude, GPT, and Pi's interleaved set — all the vendors Rickgent cares about. The `RoutingClient` protocol allows managed deployments to swap in custom routing logic without forking. Pickle Rick's `TIER_MODEL_MAP` is a 4-entry static dict (`trivial→haiku`, `small→sonnet`, `medium→sonnet`, `large→opus`) that only works within Claude and requires the operator to manually pass `--backend`. Porting it would be a regression. Reusing Omnigent gives Rickgent automatic, multi-vendor routing with per-dispatch override, gated by `OMNIGENT_SMART_ROUTING=1` so it can be turned off for cost-sensitive deployments. No mash needed; reuse is the clean path.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/advise_models.py:1-54`; `pickle-rick-claude/extension/src/bin/spawn-morty.ts:48-52,426-430`
- **Notes:** The reuse decision is reasonable, but the file cites the Omnigent tool under the nonexistent shortened path `omnigent/tools/builtins/advise_models.py` instead of the local `omnigent/omnigent/tools/builtins/advise_models.py`.
- **Date:** 2026-07-12
