# Decision: Context Clearing

## Component
§2 matrix row: Context Clearing — how the system ensures each worker dispatch starts with a fresh conversation and isolated process state, with no leakage between sessions.

## Omnigent implementation
Omnigent provides per-dispatch conversation isolation by construction. Each `sys_session_send` call spawns or continues a sub-agent session that has its own conversation store entry, visible in the session tree (`omnigent/tools/builtins/spawn.py:131-150`: "Sub-agent sessions are separate Omnigent agent sessions (own conversation, visible in the session tree)"). The tool returns a handle `{conversation_id, agent_id, title, status}` (`spawn.py` handle references); results are delivered via the `async_work_complete` inbox topic (`spawn.py:111-112`).

Sessions run as sandboxed subprocesses with spawn-tree-scoped reads/writes — a child session's filesystem access is confined to its worktree, enforced by the sandbox backends (see `sandboxing.md`). There is no shared in-process state between sessions: each sub-agent is a separate Omnigent agent session with its own conversation, its own tool handler, and its own runner process. Continuation (sending to an existing `(agent, title)` pair) is explicit and intentional — the docstring states "a pre-existing `(agent, title)` is the expected case (continuation), not a conflict" (`spawn.py:~165`). To force a fresh child, the orchestrator calls `SysSessionCloseTool` first to tombstone the existing session.

The one-shot path (`omnigent run <agent> -p`, `chat.py:4017`) is context-clearing by definition: the process starts, runs a single prompt to completion, and exits. No state survives the process exit.

## Pickle Rick implementation
Pickle Rick clears context by killing and respawning tmux panes. The outer loop lives in `mux-runner.ts` (`pickle-rick-claude/extension/src/bin/mux-runner.ts`, 11,339 LOC). Tmux references appear throughout: `tmux_iteration_${iterationNum}.log` log files, `default_tmux_max_turns` setting, `mode: 'tmux'` activity events, and iteration log file paths keyed by `tmux_iteration_${ctx.iteration}.log`. The loop kills the current tmux pane (via `killProcessGroup` in `services/orphan-reaper.ts`, imported at `mux-runner.ts` top), writes a fresh `state.json` iteration counter, and respawns `spawn-morty.ts` as a new subprocess.

This is process-management-heavy: `mux-runner.ts` tracks `currentChildProc` (line ~57), handles orphan detection (`detectOrphanSessions`, lines ~65-95), manages circuit breakers (`services/circuit-breaker.js`), and implements recovery ladders (`services/recovery-controller.js`). Context clearing is a side effect of process death, not an architectural invariant — if the respawn fails or the orphan reaper misses a process, state leaks.

## Contract
The context-clearing component must: (1) guarantee each worker dispatch starts with an empty conversation history, (2) ensure no in-process state (memory, file handles, environment mutations) from one dispatch leaks into the next, (3) confine filesystem reads/writes to the dispatch's worktree, (4) make continuation explicit (not the default). Invariants: a fresh dispatch has zero conversation history; sibling dispatches cannot see each other's conversation or state. Failure modes: respawn failure leaving stale state, orphaned processes surviving context clear, shared filesystem writes corrupting sibling state.

## Evaluation
Omnigent is better for Rickgent's goals. Per-dispatch conversation isolation is an architectural property of the session model (`spawn.py:131-150`), not a side effect of killing a tmux pane. There is no tmux dependency, no process management loop, no orphan reaper, no circuit breaker tied to respawn. The 11,339-LOC `mux-runner.ts` exists almost entirely to manage the kill-respawn cycle and its failure modes — none of that code is needed when sessions are first-class objects with their own conversation stores. Omnigent's `SysSessionCloseTool` makes the fresh-vs-continue distinction explicit and intentional; Pickle Rick's respawn always starts fresh but pays for it with a massive process-management surface.

## §2.1.1 Finding
ADOPT — "CONFIRMED. Per-dispatch conversation + sandboxed subprocess; spawn-tree-scoped reads/writes. No shared in-process state between sessions." Evidence: `spawn.py:131-150` (separate sessions, own conversation), `spawn.py:111-112` (handle + inbox, no shared return channel), `spawn.py:~165` (continuation is explicit via `SysSessionCloseTool`). The session model enforces isolation by construction; no kill-respawn loop is needed.

## Decision: reuse
Reuse Omnigent's session model — no tmux, no process management, cleaner.

## Reasoning
Context clearing in Omnigent is free: each `sys_session_send` creates a session with its own conversation store, and the one-shot `omnigent run -p` path clears context via process exit. Pickle Rick's `mux-runner.ts` is 11,339 lines of process management (tmux kill, respawn, orphan reaping, circuit breaking, recovery ladders) whose entire purpose is to approximate what Omnigent gets from its session model. Porting or mashing `mux-runner.ts` would import its failure modes (orphaned processes, respawn failures, state leakage on crash) for zero benefit. Reusing Omnigent eliminates the tmux dependency entirely, removes the process-management surface, and makes context clearing an invariant rather than a best-effort side effect. The only caveat — that `mux-runner.ts`'s recovery logic (circuit breaker, no-progress detection) has value — is addressed in the policy-framework and sandboxing decisions, where the relevant concepts are mapped to Omnigent's policy events.
