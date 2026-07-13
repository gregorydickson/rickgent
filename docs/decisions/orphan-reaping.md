# Decision: Orphan Reaping

## Component
§2 matrix row — orphan reaping (detached worker process garbage collection). Cross-references §2.1.1 (Omnigent sandboxing contains process trees) and the process-containment contract.

## Omnigent implementation
Omnigent's sandbox backends provide kernel-level process containment that makes orphan reaping unnecessary in the normal case:

- **`SandboxBackend` interface** (`omnigent/inner/sandbox.py:265-360`) defines `post_spawn` which returns a `ContainmentHandle` (`sandbox.py:254-263`). The handle is "A releasable handle for post-spawn containment (e.g. a Job Object). Returned by `SandboxBackend.post_spawn` and held by the parent for the helper's lifetime. `close()` releases the resource; for a Windows Job Object configured with kill-on-close, that terminates the contained process tree."
- **`linux_bwrap`** (`omnigent/inner/bwrap_sandbox.py:452`) uses `--unshare-pid`: the helper sees only its own process tree. When the bwrap process exits, the PID namespace's processes are killed by the kernel.
- **`darwin_seatbelt`** (`omnigent/inner/seatbelt_sandbox.py`) uses SBPL via `sandbox-exec` — process-tree containment is enforced by the seatbelt policy.
- **`windows_jobobject`** (`omnigent/inner/sandbox.py:813-814`): "Job Object process-tree containment + resource limits; no filesystem/network isolation." Kill-on-close terminates the contained tree.
- **Platform default selection** (`omnigent/inner/sandbox.py:808-838`): Linux → `linux_bwrap`, macOS → `darwin_seatbelt`, Windows → `windows_jobobject`. The default is resolved at spec parse time, and the backend errors loudly at run time if its binary is missing.

So Omnigent's transport model is: spawn the worker through a sandbox launcher → the kernel contains the process tree → when the launcher process exits (or the handle is closed), the tree is killed. There is no window for orphans to escape to PID 1.

## Pickle Rick implementation
Pickle Rick's orphan reaper exists because its transport model (tmux subprocesses) does NOT have kernel-level process containment:

- **`extension/src/services/orphan-reaper.ts`** (the R-CXHANG reaper) runs at setup-time bootstrap. The module docstring (`orphan-reaper.ts:1-20`) explains: "detached codex/claude workers lead their own process group and are group-reaped on CLEAN teardown or worker timeout — but a session that crashes, is SIGKILL'd, or is operator-frozen runs no teardown, so its group re-parents to PID 1 and lingers (codex hangs on network I/O and never self-exits — B-SIGFH soak: 8 orphans, 16h–2d old, starved run 1 dead)."
- **Positive-ownership-mandatory reap** (`isReapableOrphan`, `orphan-reaper.ts:175-185`): a proc is reaped ONLY when positively attributed to an owning session (argv `--add-dir <path>` under the sessions root) AND that session is provably not live. An unattributable proc is NEVER killed; a live session's proc is NEVER killed regardless of ppid. "There is deliberately NO ppid==1-only reap branch — false-reaping an active worker is worse than a leaked orphan" (`orphan-reaper.ts:17-19`).
- **SIGTERM → SIGKILL escalation** (`reapCandidateGroup`, `orphan-reaper.ts:187-196`): group SIGTERM → grace poll (default 2000ms, `DEFAULT_GRACE_MS`) → group SIGKILL if still alive. Matches the `spawn-morty.ts` escalation shape.
- **Min-age** (`DEFAULT_MIN_AGE_SECONDS = 600`, `orphan-reaper.ts:38`): procs younger than 10 minutes are never reaped (avoid killing a worker that is just starting up).
- **`PICKLE_ORPHAN_REAP=off`** (`ORPHAN_REAP_ENV_VAR`, `orphan-reaper.ts:31`): kill-switch makes the reaper inert (no ps scan, no kills).
- **`killProcessGroup`** (`orphan-reaper.ts:62-78`): the ONE negative-PID group-kill primitive (AC-CXHANG-3). `spawn-morty.ts:killProcessTree` and `pipeline-runner.ts:reapChildSubtree` delegate their group branch here.
- **win32**: no process groups → safe no-op (`orphan-reaper.ts:215`).

## Contract
Orphan reaping collects worker processes that survived their owning session. Invariants (from Pickle Rick's design):

1. **Positive ownership required** — a proc is reaped ONLY when positively attributed to a dead session. Unattributable procs are NEVER killed.
2. **Live sessions are never reaped** — a proc whose owning session is live (state.json `active: true` + live pid) is never killed, regardless of ppid.
3. **No ppid==1-only branch** — false-reaping an active worker is worse than a leaked orphan.
4. **Min-age** — procs younger than the threshold are never reaped.
5. **SIGTERM → SIGKILL escalation** — graceful shutdown first, force-kill only if the grace window expires.
6. **Kill-switch** — `PICKLE_ORPHAN_REAP=off` makes the reaper inert.
7. **Best-effort** — a reaper failure must never block a launch.

Failure modes: (a) unattributable orphan lingers (by design — never killed); (b) ps scan fails → reaper returns `{scanned: 0, reaped: 0}` (best-effort); (c) race condition: session dies between scan and kill → `isOwningSessionLive` re-checks at reap time.

## Evaluation
For Rickgent's v0.1 transport model, orphan reaping is unnecessary. The transport model is: `omnigent run` spawns the worker through a sandbox launcher (bwrap/seatbelt/jobobject) → the kernel contains the process tree → when the `omnigent run` one-shot exits (normally or via timeout-kill), the tree is killed by the kernel. There is no window for orphans to escape to PID 1.

Pickle Rick's orphan reaper exists because tmux subprocesses do NOT have kernel-level containment — a crashed/SIGKILL'd session leaves its worker process group re-parented to PID 1, and codex hangs on network I/O and never self-exits (B-SIGHF soak). Rickgent does not have this problem: the sandbox launcher IS the containment. A process-group kill on the `omnigent run` one-shot (which the worker-timeout decision already specifies) is sufficient.

The orphan reaper's design (positive-ownership-mandatory, no ppid==1-only branch, min-age, SIGTERM→SIGKILL) is a well-engineered safety net for a transport model that Rickgent does not use. Porting it would add complexity (ps scanning, session-state attribution, grace polling) for a problem that the sandbox already solves.

## §2.3 Finding
No pre-build finding — investigated fresh. §2.1.1 confirms Omnigent sandboxing contains process trees.

## Decision: skip
For v0.1 — Omnigent's sandbox containment makes orphan reaping unnecessary in the v0.1 transport model (process-group kill on the `omnigent run` one-shot). Revisit if sandbox escapes are observed.

## Reasoning
Skipping orphan reaping for v0.1 is the subtract-before-add discipline applied to the process-GC layer. The evidence:

1. **Omnigent's sandbox provides kernel-level process containment.** The `linux_bwrap` backend uses `--unshare-pid` (`bwrap_sandbox.py:452`) so the helper sees only its own process tree; when the bwrap process exits, the kernel kills the namespace's processes. The `windows_jobobject` backend uses kill-on-close (`sandbox.py:254-263`). The `darwin_seatbelt` backend enforces process-tree containment via SBPL. In all three cases, the sandbox launcher IS the containment — there is no window for orphans to escape to PID 1.

2. **The v0.1 transport model is a one-shot `omnigent run`.** Rickgent dispatches workers via `sys_session_send` to sub-agents running inside sandboxed `omnigent run` processes. The worker-timeout decision (see `worker-timeout.md`) specifies a process-group kill on the `omnigent run` one-shot when the deadline fires. That group kill + the sandbox's kernel containment is sufficient — no orphans survive.

3. **Pickle Rick's orphan reaper solves a problem Rickgent does not have.** The reaper exists because tmux subprocesses lack kernel containment: a crashed/SIGKILL'd session leaves its worker group re-parented to PID 1, and codex hangs on network I/O (B-SIGFH soak: 8 orphans, 16h-2d old, `orphan-reaper.ts:11-13`). Rickgent's sandboxed transport does not have this failure mode — the sandbox launcher contains the tree, and the process-group kill on the one-shot handles the timeout case.

4. **Porting the reaper would add complexity for no benefit.** The reaper requires ps scanning, session-state attribution (`resolveOwningSessionDir`, `isOwningSessionLive`), grace polling, min-age gating, and a kill-switch. All of this is a safety net for a containment gap that the sandbox already closes. Adding it would violate "subtract before you add" — it is a guard around a guard.

5. **Revisit if sandbox escapes are observed.** If a worker process is observed surviving its `omnigent run` parent (e.g., a sandbox misconfiguration, a bwrap `--unshare-pid` failure, or a seatbelt policy gap), the orphan reaper can be ported as a setup-time safety net. The reaper's design (positive-ownership-mandatory, no ppid==1-only branch) is sound and can be directly translated to Python if needed. But it should be added in response to a observed failure, not preemptively.

The `killProcessGroup` primitive (`orphan-reaper.ts:62-78`) IS relevant to Rickgent — but it is already part of the worker-timeout decision (process-group kill on the `omnigent run` one-shot). The reaper as a standalone setup-time collector is what is skipped.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/inner/bwrap_sandbox.py:451-468` uses PID isolation and die-with-parent; `omnigent/inner/sandbox.py:806-845` documents backend defaults/explicit none; `extension/src/services/orphan-reaper.ts:8-30,52-65` documents crash orphans/group kill.
- **Notes:** Evidence does not justify a blanket skip for every macOS or explicit-none path. Constrain the skip by proven backend or retain the positive-ownership reaper.
- **Date:** 2026-07-12
