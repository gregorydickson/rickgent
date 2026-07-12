# Decision: Worker Timeout

## Component
§2 matrix row — worker timeout (per-spawn deadline + kill + salvage). Cross-references §2.1.1 (Omnigent `sys_cancel_task` is inert) and the async-inbox contract.

## Omnigent implementation
Omnigent's cancellation surface is `sys_cancel_task`, but it is inert:

- **`SysCancelTaskTool`** (`omnigent/tools/builtins/async_inbox.py:62-125`) defines the `sys_cancel_task` tool. Its `invoke` method (`async_inbox.py:101-125`) returns `{"error": "task_not_found", ...}` for ALL inputs. The docstring at `async_inbox.py:101-103` states: "The tasks table has been removed. This tool returns a `task_not_found` response for all inputs since no tasks are persisted server-side." The hint at `async_inbox.py:115-119` confirms: "The tasks table has been removed. sys_cancel_task is only effective for tasks created via sys_call_async or sys_session_send; no server-persisted tasks exist."
- **Session timeout**: Omnigent has session-level config (`ask_timeout: 86400` in the Rickgent config, §2.2) but this is an approval-window timeout, not a worker-deadline. There is no per-worker-spawn deadline mechanism in the Omnigent runner — the runner dispatches a sub-agent via `sys_session_send` and waits for the inbox result indefinitely.
- **`spawn_bounds`** (`omnigent/policies/builtins/orchestration.py:407-464`) caps dispatches per turn but does not time out individual dispatches.

So Omnigent provides no worker-timeout mechanism. `sys_cancel_task` is a no-op stub. A hung worker runs forever unless the parent process kills it.

## Pickle Rick implementation
Pickle Rick has a mature worker-timeout system with salvage:

- **`--worker-timeout` / `worker_timeout_seconds`** — default 1200s (`Defaults.WORKER_TIMEOUT_SECONDS`, `extension/src/types/index.ts:491`). Parsed via `--timeout` CLI arg (`extension/src/bin/spawn-morty.ts:353-367`). Per-ticket tier budgets override the default (`spawn-morty.ts:2515`). Stored in `state.worker_timeout_seconds` (`types/index.ts:8`) and `state.current_ticket_worker_timeout_seconds` (`types/index.ts:16`).
- **Budget resolution** (`mux-runner.ts:1795-1802`): `worker_timeout_seconds` is resolved with fallback to `Defaults.WORKER_TIMEOUT_SECONDS` when non-finite or ≤ 0. R-WTZ repair (`mux-runner.ts:6543-6567`): a zeroed `worker_timeout_seconds` (microverse's sentinel value) is repaired to the default before validation, so a microverse run does not poison a subsequent pipeline run.
- **Stall classification** (`types/index.ts:1327`): `StallCategory = 'worker_timeout' | 'tests_red_no_progress' | 'circular_revert' | 'external_blocker'`. The `worker_timeout` category maps to `escalate_timeout` recovery action (`microverse-runner.ts:1439,1460`).
- **`PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`** — per-gate-phase cap for `test:fast`/`test:integration` in the worker lint gate (R-WTFT). `WORKER_TEST_GATE_TIMEOUT_ENV_VAR` (`extension/src/services/pickle-utils.ts:162`), `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS = 600_000` (10 min, `pickle-utils.ts:160`), `WORKER_TEST_GATE_TIMEOUT_FLOOR_MS = 60_000` (1 min floor, `pickle-utils.ts:161`). Resolver `resolveWorkerTestGateTimeoutMs` (`pickle-utils.ts:883-906`): env override wins, clamped to ≥ floor; falls back to settings/default on parse failure.
- **Timeout-rescue auto-commit** (`autoRescueDirtyTree`, `extension/src/bin/microverse-runner.ts:3637-3692`): when a worker times out before committing, the rescue path partitions the dirty tree into owned paths (scope-filtered, `AUTO_COMMIT_DIRT_EXCLUDES` honored) and un-attributable bystander dirt. Owned paths are staged one-by-one and committed (`microverse-runner.ts:3678`); the bystander remainder is anchored to `refs/pickle/salvage/<session>` via the shared salvage seam (`extension/src/services/dirty-tree-salvage.ts:43-78`). This preserves work before anything else (FOM intervention discipline).
- **`preflightAutoCommit`** (`microverse-runner.ts:2953`) runs the same salvage seam preflight before iteration.

## Contract
Worker timeout ensures a hung worker does not block the run indefinitely. Invariants:

1. **Deadline is rickgent-side** — the parent process enforces a wall-clock deadline on the `omnigent run` process join. Never rely on `sys_cancel_task` (inert per `async_inbox.py:101-103`).
2. **Kill + salvage on timeout** — when the deadline fires: kill the worker process group, then salvage any dirty-tree work (stage owned paths, anchor bystander remainder to a recoverable ref).
3. **Preserve work before anything else** — the FOM's first intervention discipline. A timed-out worker may have produced partial work; salvage it before discarding the session.
4. **Default 1200s (20 min)** — per-ticket tier budgets may override. Zeroed timeout is repaired (R-WTZ), never allowed to disable the deadline.
5. **Test-gate timeout is separate** — `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` (default 600000ms, floor 60000ms) caps per-gate-phase test runs, not the worker spawn itself.

Failure modes: (a) deadline too short → worker killed mid-work, salvage catches partial commits; (b) deadline too long → run stalls waiting for a hung worker; (c) salvage fails → work lost but run continues (best-effort); (d) `sys_cancel_task` relied upon → no-op, worker runs forever.

## Evaluation
Pickle Rick's timeout semantics are correct and battle-tested. The key insight: the deadline must be enforced by the PARENT process (rickgent-side), not by the worker's cooperation. `sys_cancel_task` is inert (`async_inbox.py:101-103`), so there is no Omnigent-native way to stop a hung worker. The only mechanism is: rickgent-side deadline on the `omnigent run` process join → kill the process group → salvage the dirty tree.

The salvage path (`autoRescueDirtyTree`, `microverse-runner.ts:3637-3692`) is the FOM's "preserve work before anything else" discipline made mechanical: partition the dirty tree, stage owned paths, anchor the remainder to a recoverable ref. This is directly portable — Rickgent's `ralph` skill implements the same salvage logic when a worker times out.

## §2.3 Finding
No pre-build finding — investigated fresh. §2.1.1 confirms `sys_cancel_task` is inert, so timeout = rickgent-side deadline + kill + salvage.

## Decision: port
Port Pickle Rick's timeout semantics — rickgent-side deadline on the `omnigent run` process join + kill + salvage. Never rely on `sys_cancel_task` (inert per `async_inbox.py:101-103`).

## Reasoning
The port is necessary because Omnigent provides no worker-timeout mechanism. `sys_cancel_task` is a no-op stub (`async_inbox.py:101-103` — "The tasks table has been removed. This tool returns a `task_not_found` response for all inputs since no tasks are persisted server-side"). The Omnigent runner dispatches a sub-agent via `sys_session_send` and waits for the inbox result indefinitely. Without a rickgent-side deadline, a hung worker (e.g., codex hanging on network I/O — the B-SIGFH soak documented in `orphan-reaper.ts:11-13`) blocks the run forever.

The port layers three things:

1. **Rickgent-side deadline** — the `ralph` skill (or the Rickgent orchestrator brain) sets a wall-clock deadline on each `sys_session_send` dispatch. The default is 1200s (matching `Defaults.WORKER_TIMEOUT_SECONDS`, `types/index.ts:491`), overridable per-ticket by tier budget. The deadline is enforced by the parent process joining the `omnigent run` subprocess with a timeout — NOT by calling `sys_cancel_task` (which is inert).

2. **Kill + salvage on timeout** — when the deadline fires, the parent kills the `omnigent run` process group (negative-PID group kill, matching `killProcessGroup` in `extension/src/services/orphan-reaper.ts:62-78`). Then the salvage path runs: partition the dirty tree into owned paths (scope-filtered) and bystander dirt; stage owned paths one-by-one; anchor the remainder to `refs/pickle/salvage/<session>` (matching `stashUnattributableRemainder`, `dirty-tree-salvage.ts:43-78`). This is the FOM's "preserve work before anything else" discipline.

3. **Test-gate timeout** — `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` (default 600000ms, floor 60000ms, `pickle-utils.ts:160-162`) caps per-gate-phase test runs. Rickgent's `citadel` skill (which runs AC verify commands) uses the same timeout cap so a hung test does not block the audit phase.

The R-WTZ repair (`mux-runner.ts:6543-6567`) is also ported: a zeroed timeout (which could be a microverse sentinel value) is repaired to the default before validation, so a convergence-loop run does not poison a subsequent pipeline run with a disabled deadline.

The `StallCategory` classification (`types/index.ts:1327`) is ported as Rickgent's stall taxonomy: `worker_timeout` → `escalate_timeout` (kill + salvage + retry or fail); `tests_red_no_progress` → escalate to review; `circular_revert` → escalate to human; `external_blocker` → escalate to human. This is the FOM's "convergence vs attrition" judgment made mechanical.
