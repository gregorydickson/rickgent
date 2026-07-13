# Decision: Cancellation

## Component
§2 matrix row — cancellation / worker timeout enforcement (kill a runaway worker and salvage its work).

## Omnigent implementation
Omnigent's `sys_cancel_task` is INERT. The tool lives in `omnigent/tools/builtins/async_inbox.py`:

- `SysCancelTaskTool` (`async_inbox.py:SysCancelTaskTool`) — defines the schema and name for `sys_cancel_task`. The `description()` still claims non-blocking cancellation that "marks the task cancelled and returns immediately" and "the child workflow observes the cancel on its next runner-managed iteration" (`async_inbox.py:description`).
- `invoke(arguments, ctx)` (`async_inbox.py:97-126`) — the actual implementation. The docstring is explicit: "The tasks table has been removed. This tool returns a `task_not_found` response for all inputs since no tasks are persisted server-side." (`async_inbox.py:99-104`). The body parses `task_id` from arguments and returns `{"error": "task_not_found", "task_id": ..., "hint": "The tasks table has been removed. sys_cancel_task is only effective for tasks created via sys_call_async or sys_session_send; no server-persisted tasks exist."}` (`async_inbox.py:108-126`).
- `SysCancelAsyncTool` (`async_inbox.py:SysCancelAsyncTool`) extends `SysCancelTaskTool` with a `handle_id` alias schema (`sys_cancel_async`), but inherits the same inert `invoke` — it also returns `task_not_found` for all inputs.

The sub-agent busy check is a no-op: with no tasks table, there is nothing to check, nothing to cancel, and no platform primitive for "kill this runaway worker." The tool description's claim of non-blocking cancellation is vestigial — the implementation unconditionally returns `task_not_found`.

## Pickle Rick implementation
Pickle Rick has no platform cancel primitive either — but it enforces worker deadlines at the orchestrator level via timeout + salvage. The cancellation surface:

- `--worker-timeout` CLI flag — `extension/src/bin/setup.ts:653-655` parses `--worker-timeout` as a positive integer; `config.workerTimeout` defaults to `DEFAULT_WORKER_TIMEOUT_SECONDS` (`setup.ts:267`), which is `TICKET_TIER_BUDGETS.medium.worker_timeout_seconds`. The documented default is `WORKER_TIMEOUT_SECONDS: 1200` (20 minutes) in `extension/src/types/index.ts` (STATE_MANAGER_DEFAULTS). The timeout is persisted to `state.worker_timeout_seconds` and per-ticket `state.current_ticket_worker_timeout_seconds` (`mux-runner.ts:1795-1848`).
- `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` — `extension/src/services/pickle-utils.ts` exports `WORKER_TEST_GATE_TIMEOUT_ENV_VAR = 'PICKLE_WORKER_TEST_FAST_TIMEOUT_MS'` and reads the env var. Documented default 600000ms (10 min), floor 60000ms (per `CLAUDE.md` env table: "int ms ≥60000 (default 600000) — Per-gate-phase cap for `test:fast`/`test:integration` in the worker lint gate (R-WTFT)"). This caps the worker's own gate-phase test runs so a stuck test suite doesn't eat the whole worker budget.
- Timeout-rescue auto-commit — `extension/src/bin/mux-runner.ts`:
  - `executeTimeoutHalt(ctx)` (`mux-runner.ts:6418-6427`) — when a worker times out, record `timeout_count`, stamp `exit_reason`, and emit a remediation message: "Re-run via /pickle-pipeline --worker-timeout <N> for fresh session, or edit worker_timeout_seconds in ${statePath} and run /pickle-retry for this session." (`mux-runner.ts:6427`).
  - SIGTERM kill — `currentChildProc.kill('SIGTERM')` (`mux-runner.ts:206`) and `this.currentChild?.kill('SIGTERM')` (`mux-runner.ts:3591`) to actually terminate the runaway worker process.
  - `writeTimeoutStub` (`state-manager.ts:writeTimeoutStub`) — write a `TASK_NOTES.md` stub at the session dir when the file is absent or empty, recording the iteration that was SIGTERM'd, the wall-seconds vs budget, the timeout count, and the last log line — so the next iteration knows the previous approach didn't finish in time and must not repeat it. Non-empty content is never overwritten. Called from `mux-runner.ts` via `(ctx.writeTimeout || writeTimeoutStub)(ctx.sessionDir, {...})`.
  - Salvage — `salvageTicket` (`mux-runner.ts` imports `salvageTicket` from `lib/salvage-ticket.js`) and `salvageDirtyTree` / `stashUnattributableRemainder` (`services/dirty-tree-salvage.ts`) commit any real work the worker produced before the timeout, so a timed-out worker's partial output isn't lost. The recovery ladder auto-salvages until it exhausts, then surfaces the `pickle-recover` subcommand the operator should run (`mux-runner.ts`).
  - Repeat-timeout halt — after 2 consecutive timeouts on the same ticket, the runner halts (`mux-runner.ts:executeTimeoutHalt`, `reason: 'timeout_repeat'`) rather than spinning forever.

This is orchestrator-side deadline + kill + salvage. There is no platform cancel — the orchestrator owns the deadline, SIGTERMs the worker, salvages its work, writes a timeout stub, and halts after repeated timeouts.

## Contract
What this component does: enforce a wall-clock deadline on each worker spawn; when the deadline is exceeded, kill the worker process, salvage any real work it produced, record a timeout stub so the next iteration doesn't repeat the approach, and halt after repeated consecutive timeouts.

Invariants:
- The deadline is set per-spawn (`worker_timeout_seconds`) and per-ticket tier (`current_ticket_worker_timeout_seconds`); a zeroed timeout is a sentinel, not "no limit" (R-WTZ).
- On timeout: SIGTERM the worker process, then salvage (commit real work / archive unreattachable work) — never discard partial output silently.
- A `TASK_NOTES.md` stub records the timeout so the next iteration knows the previous approach didn't finish in time; non-existing content is never overwritten.
- After 2 consecutive timeouts on the same ticket, halt — don't spin forever.
- The operator recovery command (`pickle-recover`) is surfaced when the auto-salvage ladder exhausts.
- NEVER rely on `sys_cancel_task` — it is inert (returns `task_not_found` for all inputs).

Failure modes:
- Worker ignores SIGTERM → escalation path (the runner's kill primitive is the only lever; a worker that survives SIGTERM wedges the slot until external intervention).
- Salvage can't ff-reattach (diverged) → archive + resetTodo, don't force.
- Repeated timeouts → halt with `timeout_repeat` and surface operator recovery.

## Evaluation
For Rickgent's goals, Omnigent's `sys_cancel_task` is a confirmed TRAP and Pickle Rick's orchestrator-side timeout semantics are the right model.

- Omnigent's `sys_cancel_task` is INERT — the tasks table was removed and `invoke` returns `task_not_found` for all inputs (`async_inbox.py:97-126`). The tool description still claims non-blocking cancellation, which is vestigial and misleading. Any Rickgent code that calls `sys_cancel_task` expecting cancellation would silently get `task_not_found` and the runaway worker would keep running. This is exactly the §2.1.1 TRAP finding.
- The sub-agent busy check is a no-op (no tasks table → nothing to check).
- Pickle Rick has no platform cancel primitive either, but it doesn't need one: it enforces deadlines at the orchestrator. `--worker-timeout` (default 1200s) sets the per-spawn budget; `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` (default 600000ms, floor 60000ms) caps gate-phase test runs; on timeout the orchestrator SIGTERMs the worker, salvages its work via `salvageTicket` / `salvageDirtyTree`, writes a `TASK_NOTES.md` stub via `writeTimeoutStub`, and halts after 2 consecutive timeouts via `executeTimeoutHalt` (`mux-runner.ts:6418-6427, 206, 3591`).
- Rickgent needs the same orchestrator-side posture: deadline on inbox wait + kill + salvage, NEVER reliance on `sys_cancel_task`. The deadline + kill + salvage loop is the only cancellation mechanism that actually works.

PORT (Pickle Rick timeout semantics): Rickgent-side deadline + SIGTERM kill + salvage + timeout stub + repeat-timeout halt. Never rely on `sys_cancel_task` (inert).

## §2.1.1 Finding
ADOPT — "TRAP. The server tasks table was removed; `sys_cancel_task` returns `task_not_found` for all inputs, and the sub-agent busy check is a no-op. Worker-timeout enforcement lives in the rickgent orchestrator (deadline on inbox wait + salvage), not in a platform cancel primitive."

Confirmed by source:
- `sys_cancel_task` returns `task_not_found` for all inputs — `async_inbox.py:97-126`, with the hint "The tasks table has been removed. sys_cancel_task is only effective for tasks created via sys_call_async or sys_session_send; no server-persisted tasks exist." The docstring states it explicitly: "This tool returns a `task_not_found` response for all inputs since no tasks are persisted server-side."
- Sub-agent busy check is a no-op — no tasks table means nothing to check.
- Worker-timeout enforcement lives in the orchestrator — Pickle Rick's `--worker-timeout` (default 1200s, `types/index.ts: WORKER_TIMEOUT_SECONDS: 1200`), `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` (`pickle-utils.ts: WORKER_TEST_GATE_TIMEOUT_ENV_VAR`), SIGTERM kill (`mux-runner.ts:206, 3591`), salvage (`salvageTicket`, `salvageDirtyTree`), timeout stub (`writeTimeoutStub`), repeat-timeout halt (`executeTimeoutHalt:6418`).

The finding is adopted as written.

## Decision: port
PORT (Pickle Rick timeout semantics) — Rickgent-side deadline + SIGTERM kill + salvage + timeout stub + repeat-timeout halt; NEVER rely on `sys_cancel_task` (it is inert, returns `task_not_found` for all inputs).

## Reasoning
Omnigent's `sys_cancel_task` is a confirmed TRAP. The tasks table was removed and `invoke` (`async_inbox.py:97-126`) unconditionally returns `{"error": "task_not_found", ...}` — the tool description's claim of non-blocking cancellation is vestigial. Any Rickgent code that dispatches a worker and later calls `sys_cancel_task` to stop it would silently get `task_not_found`, and the runaway worker would keep running until it hit some external limit. The sub-agent busy check is likewise a no-op. Rickgent must treat `sys_cancel_task` as non-existent and document this trap so no future contributor reaches for it.

Pickle Rick's orchestrator-side timeout semantics are the right model because they actually work. The orchestrator owns the deadline (`worker_timeout_seconds`, default 1200s; per-ticket `current_ticket_worker_timeout_seconds`), caps the worker's own gate-phase test runs (`PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`, default 600000ms, floor 60000ms), and on timeout: (a) SIGTERMs the worker process (`mux-runner.ts:206, 3591`), (b) salvages any real work via `salvageTicket` / `salvageDirtyTree` so partial output isn't lost, (c) writes a `TASK_NOTES.md` stub via `writeTimeoutStub` so the next iteration knows the previous approach didn't finish in time and must not repeat it, (d) records `timeout_count` and emits remediation via `executeTimeoutHalt` (`mux-runner.ts:6418-6427`), and (e) halts after 2 consecutive timeouts (`reason: 'timeout_repeat'`) rather than spinning forever.

Rickgent ports these semantics: a per-spawn deadline on inbox wait, SIGTERM kill when the deadline is exceeded, salvage of any real work the worker produced, a timeout stub recording what was tried and how long it ran, and a repeat-timeout halt. Rickgent does NOT port the Pickle Rick-specific surface (`--worker-timeout` CLI flag shape, `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` env var name, `TASK_NOTES.md` stub format, `pickle-retry` remediation message) verbatim — it ports the deadline + kill + salvage + stub + halt loop against Rickgent's own orchestrator and registry. The decision is PORT, not MASH, because Omnigent contributes nothing here — `sys_cancel_task` is inert and must be explicitly avoided, not mashed in.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `omnigent/tools/builtins/async_inbox.py:97-126` always returns `task_not_found`; `extension/src/bin/mux-runner.ts:6418-6428` records timeout-repeat count and remediation.
- **Notes:** The trap finding and orchestrator-owned kill/salvage posture are accurate.
- **Date:** 2026-07-12
