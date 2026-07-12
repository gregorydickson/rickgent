# Decision: Worker Dispatch

## Component
§2 matrix row: Worker Dispatch — how the orchestrator spawns, routes work to, and collects results from coding-agent subprocesses.

## Omnigent implementation
Omnigent dispatches work through `sys_session_send`, an async-only tool that returns a handle and delivers results via the `async_work_complete` inbox topic (`omnigent/tools/builtins/spawn.py:111-112`, schema built by `_build_sys_session_send_schema`). The tool description (`spawn.py:131-150`) states: "Returns the child's output when its turn completes. To run multiple sessions in parallel, emit multiple sys_session_send tool_calls in the same response — they dispatch concurrently." Handles carry `{conversation_id, agent_id, title, status}` (`spawn.py` handle references throughout).

Eleven native harnesses are registered as `NativeCodingAgent` constants in `omnigent/harness_plugins.py:100-193`: `claude` (line ~100), `codex` (~110), `pi` (~120), `opencode` (~130), `cursor` (~140), `kiro` (~150), `goose` (~160), `antigravity` (~170), `qwen` (~180), `kimi` (~190), `hermes` (~193). Each declares `key`, `display_name`, `agent_name`, `harness`, `wrapper_label`, and `terminal_name`.

Dispatch `purpose` values (`implement|review|explore|search`) are enforced by `headless_subagent_purpose_guard` (`omnigent/policies/builtins/orchestration.py:466-468`), a `FunctionPolicy` factory that fails loud on an unmarked or out-of-set purpose.

The synchronous one-shot path is `omnigent run <agent> -p "<prompt>"`, implemented by `_run_one_shot` at `omnigent/chat.py:4017`. It is triggered when `initial_message` is set (`chat.py:969-970`): the REPL checks `if initial_message is not None:` and calls `_run_one_shot(...)` instead of entering the interactive REPL. `_ensure_backend` at `omnigent/cli.py:2404` auto-spawns or reuses a persistent local server and returns its loopback URL; it is called before every `attach`/`run`/`claude`/`codex` command (`cli.py` has six `_ensure_backend(server)` call sites).

## Pickle Rick implementation
Pickle Rick dispatches via `spawn-morty.ts` (`pickle-rick-claude/extension/src/bin/spawn-morty.ts`), a 2,706-LOC per-ticket subprocess launcher. It supports only `claude -p` or `codex exec` (the `BACKENDS` type and `resolveBackend`/`resolveWorkerBackendFromState` in `services/backend-spawn.ts`). The `--backend <name>` CLI flag is parsed at `spawn-morty.ts` (the `R-XBL-2` override, lines ~62-70) and accepts `claude|codex|hermes|grok|kimi|gemini`; the `PICKLE_BACKEND` env var is read in `services/backend-spawn.ts` as a fallback. A `TIER_MODEL_MAP` (`spawn-morty.ts:~50`) maps ticket complexity (`trivial→haiku`, `small→sonnet`, `medium→sonnet`, `large→opus`) but only within the Claude family.

There is no async handle/inbox model: `spawn-morty.ts` uses `spawn`/`execFileSync` from `child_process` and blocks on the subprocess. Parallelism is achieved by the outer `mux-runner.ts` loop respawning tmux panes, not by concurrent in-process dispatch.

## Contract
The dispatch component must: (1) spawn a coding-agent subprocess with a declared purpose, (2) isolate each dispatch's conversation and working state, (3) deliver the agent's final output to the orchestrator, (4) support parallel fan-out (multiple workers simultaneously), (5) enforce a closed set of work types. Invariants: every dispatch declares a purpose; a dispatch's conversation is not visible to siblings; the orchestrator receives either a result or an error. Failure modes: subprocess crash, timeout, rate-limit park, backend not on PATH, purpose guard denial.

## Evaluation
Omnigent is strictly better for Rickgent's goals. It is natively multi-model (11 harnesses vs. 2 backends), has a purpose guard baked into the policy framework, returns async handles with an inbox for result delivery (enabling clean parallel fan-out without tmux), and requires no `--backend` flag — the harness is selected per sub-agent spec. Pickle Rick's `spawn-morty.ts` is a single-backend-at-a-time subprocess launcher bolted onto a tmux respawn loop; its `TIER_MODEL_MAP` only varies Claude model tiers and cannot route across vendors. The one-shot `omnigent run ... -p` path gives Rickgent synchronous completion via process exit when needed, while `sys_session_send` gives async fan-out when the orchestrator runs inside an Omnigent session.

## §2.1.1 Finding
ADOPT — "CONFIRMED, with one correction. Dispatch is async-only." The correction: `sys_session_send` (`spawn.py:111-112`) is async-only (returns a handle, results via `async_work_complete` inbox). However, the outer loop uses `omnigent run <agent> -p "<prompt>"` one-shots (`chat.py:4017`, triggered at `chat.py:969-970`) for synchronous completion via process exit. Both modes are available; the pre-build finding's "async-only" qualifier applies to the in-session tool, not the CLI one-shot. Evidence: `spawn.py:131-150` (concurrent dispatch via multiple tool_calls), `chat.py:4017` (`_run_one_shot`), `chat.py:969-970` (trigger condition).

## Decision: reuse
Reuse Omnigent's dispatch — natively multi-model, no `--backend` flag.

## Reasoning
Rickgent's core value proposition is multi-model orchestration across vendor families. Omnigent already has 11 registered native harnesses (`harness_plugins.py:100-193`), a purpose guard (`orchestration.py:466-468`), and both async (`sys_session_send`) and synchronous (`omnigent run -p`) dispatch paths. Porting Pickle Rick's `spawn-morty.ts` would mean rebuilding a 2,706-LOC launcher that is hardcoded to `claude -p`/`codex exec`, gated by a `--backend` flag, and dependent on tmux for parallelism. Reusing Omnigent eliminates the `--backend` flag entirely (harness selection moves to the sub-agent spec), gives us the `async_work_complete` inbox for result collection, and inherits the purpose guard for free. The only Pickle Rick concept worth noting — tier-based model selection within Claude — is subsumed by Omnigent's `sys_advise_models` (see `model-routing.md`). No port or mash needed; reuse is the clean path.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/spawn.py:111-130`; `pickle-rick-claude/extension/src/bin/spawn-morty.ts:48-52,426-430`
- **Notes:** The decision is directionally right, but the cited Omnigent evidence is not literal-correct: `spawn.py:111-112` is the tool name, not the async handle/inbox behavior the file attributes to it, and the decision file also uses nonexistent shortened Omnigent paths.
- **Date:** 2026-07-12
