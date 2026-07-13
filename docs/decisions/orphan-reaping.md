# Decision: Orphan Reaping

## Component
§2 matrix row — orphan reaping (detached worker process garbage collection). Cross-references §2.1.1 (Omnigent sandboxing contains process trees) and the process-containment contract.

## Omnigent implementation
Omnigent's sandbox backends provide kernel-level process containment that makes orphan reaping unnecessary in the normal case:

- **`SandboxBackend` interface** (`omnigent/inner/sandbox.py:265-360`) defines `post_spawn` which returns a `ContainmentHandle` (`sandbox.py:254-263`). The handle is "A releasable handle for post-spawn containment (e.g. a Job Object). Returned by `SandboxBackend.post_spawn` and held by the parent for the helper's lifetime. `close()` releases the resource; for a Windows Job Object configured with kill-on-close, that terminates the contained process tree."
- **`linux_bwrap`** (`omnigent/inner/bwrap_sandbox.py:452`) uses `--unshare-pid`: the helper sees only its own process tree. When the bwrap process exits, the PID namespace's processes are killed by the kernel.
- **`darwin_seatbelt`** (`omnigent/inner/seatbelt_sandbox.py`) uses SBPL via `sandbox-exec` and provides **NO process-tree containment**. Omnigent documents this itself (`seatbelt_sandbox.py:78-81`): "**No PID / UTS / IPC namespace isolation.** macOS has no `unshare(2)`; `sandbox-exec` only restricts capabilities at the syscall-policy level, not via process namespaces. The helper can `ps` and see other processes on the host." `SeatbeltSandboxBackend` (`seatbelt_sandbox.py:329`) implements `resolve` / `wrap_launcher_argv` / `activate` — it does **not** implement `post_spawn`, so it returns no `ContainmentHandle` and there is no kill-on-close. Seatbelt is an access-control policy, not a process supervisor.
- **`windows_jobobject`** (`omnigent/inner/sandbox.py:813-814`): "Job Object process-tree containment + resource limits; no filesystem/network isolation." Kill-on-close terminates the contained tree.
- **Platform default selection** (`omnigent/inner/sandbox.py:806-845`): Linux → `linux_bwrap`, macOS → `darwin_seatbelt`, Windows → `windows_jobobject`. The default is resolved at spec parse time, and the backend errors loudly at run time if its binary is missing. There is also an explicit opt-out, `os_env.sandbox.type='none'` (`sandbox.py:832-833, 845`), which runs with no sandbox at all.

**Containment is therefore backend-dependent, NOT universal.** Verified against source:

| Backend | Process-tree containment? | Mechanism |
|---|---|---|
| `linux_bwrap` | **YES** | `--unshare-pid` + `--die-with-parent` (`bwrap_sandbox.py:452,460,463`) — kernel kills the helper if the parent dies |
| `windows_jobobject` | **YES** | the only backend implementing `post_spawn` (`windows_jobobject_sandbox.py:203`) → `ContainmentHandle` with kill-on-close |
| `darwin_seatbelt` | **NO** | no PID namespace (macOS has no `unshare(2)`); no `post_spawn`; no handle |
| `none` (explicit opt-out) | **NO** | no sandbox at all |

So Omnigent's transport model contains the process tree **on Linux and Windows only**. On macOS, and on any host with `sandbox.type: none`, a worker's process group can still outlive its parent and re-parent to PID 1 — exactly the orphan window Pickle Rick's reaper exists to close.

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
Orphan reaping is unnecessary **only where the sandbox backend actually contains the process tree** — `linux_bwrap` and `windows_jobobject`. There, `omnigent run` spawns the worker through a launcher that the kernel tears down with its parent (`--die-with-parent`, or a Job Object closed on exit), so no orphan can escape to PID 1 and a reaper would be a guard around a guard.

That containment does **not** hold on `darwin_seatbelt` or `sandbox.type: none`. Seatbelt gives no PID namespace and no containment handle (`seatbelt_sandbox.py:78-81`, and no `post_spawn` impl) — it restricts what the helper may *do*, not how long it may *live*. A worker whose parent is SIGKILL'd on macOS re-parents to PID 1 exactly as it does under Pickle Rick's tmux transport. This is not a hypothetical: macOS is the primary development platform, and the failure that motivated the reaper (B-SIGFH soak — 8 orphans, 16h–2d old, one starved run dead, `orphan-reaper.ts:11-13`) is a codex-hangs-on-network-I/O failure that is transport-agnostic. The sandbox does not fix it on macOS; it merely fences it.

A blanket skip would therefore leave Rickgent with no orphan GC on the platform where orphans are most likely, which is a direct hit to "hands-off execution" and "reliable, not brittle": leaked codex processes accumulate, starve later runs, and require manual `kill` — the exact hands-on intervention Rickgent exists to eliminate.

Pickle Rick's reaper design is sound and worth keeping precisely because it is conservative: positive-ownership-mandatory, no `ppid==1`-only branch, min-age gate, SIGTERM→SIGKILL escalation, kill-switch. Those invariants make it safe to run even where it is not strictly needed — a false reap is the only real risk, and the design forecloses it.

## §2.3 Finding
No pre-build finding — investigated fresh. §2.1.1 states Omnigent sandboxing contains process trees. **This is ADOPTED with a correction:** containment holds for `linux_bwrap` and `windows_jobobject`, but NOT for `darwin_seatbelt` or `sandbox.type: none`. The correction is grounded in Omnigent's own documentation (`seatbelt_sandbox.py:78-81`: "No PID / UTS / IPC namespace isolation. macOS has no `unshare(2)`") and in the fact that `post_spawn` — the containment-handle hook — is implemented only by `windows_jobobject_sandbox.py:203`. The finding is true in general and false on macOS.

## Decision: port (backend-gated)
Port Pickle Rick's positive-ownership orphan reaper, but **gate its activation on the resolved sandbox backend**:

- `linux_bwrap`, `windows_jobobject` → reaper is a **no-op** (kernel containment already closes the orphan window).
- `darwin_seatbelt`, `none` → reaper is **active** (no kernel containment; orphans are reachable).

This is a constrained skip, not a blanket one: Rickgent subtracts the reaper exactly where it is provably redundant and retains it exactly where it is provably needed.

## Reasoning
The original v0.1 decision was a blanket skip resting on the claim that all three sandbox backends contain the process tree. That claim is false for macOS, and macOS is the primary development platform. The corrected evidence:

1. **Kernel containment exists on Linux and Windows only.** `linux_bwrap` passes `--unshare-pid` and `--die-with-parent` (`bwrap_sandbox.py:452,460,463`) — the kernel kills the helper when the parent dies. `windows_jobobject` is the sole backend implementing `post_spawn` (`windows_jobobject_sandbox.py:203`), returning a `ContainmentHandle` whose kill-on-close terminates the tree (`sandbox.py:254-263`). On these two, a reaper is genuinely a guard around a guard, and subtract-before-add applies.

2. **macOS has no process containment, by Omnigent's own admission.** `seatbelt_sandbox.py:78-81` documents the delta explicitly: no PID/UTS/IPC namespace isolation, because macOS has no `unshare(2)`; `sandbox-exec` "only restricts capabilities at the syscall-policy level, not via process namespaces." `SeatbeltSandboxBackend` (`seatbelt_sandbox.py:329`) implements no `post_spawn`, so there is no handle to close. Nothing kills the tree when the parent dies.

3. **`sandbox.type: none` is a supported, documented opt-out** (`sandbox.py:832-833, 845`) with zero containment. Any decision that assumes containment is universal is wrong for every host that sets it.

4. **The motivating failure is transport-agnostic.** The reaper was built for B-SIGFH: codex hangs on network I/O and never self-exits, so a SIGKILL'd session leaves an orphan group re-parented to PID 1 (8 orphans, 16h–2d old, one starved run dead — `orphan-reaper.ts:11-13`). That is a property of the *worker*, not of tmux. Under `darwin_seatbelt` the same hung codex process orphans the same way. The sandbox fences what it can touch; it does not make it exit.

5. **A blanket skip breaks two of Rickgent's four goals.** Leaked workers accumulate, starve later runs, and demand a manual `kill` — the antithesis of hands-off execution, and brittleness of exactly the kind the reliability goal names. The cost of being wrong here is asymmetric: an unnecessary reaper on Linux costs one `ps` scan at bootstrap; a missing reaper on macOS costs a dead pipeline and human intervention.

6. **The reaper is safe to run even where redundant**, which is why gating is a cheap optimization rather than a correctness requirement. Its invariants foreclose the only real risk (a false reap): positive-ownership-mandatory attribution, an explicit refusal to add a `ppid==1`-only branch ("false-reaping an active worker is worse than a leaked orphan", `orphan-reaper.ts:17-19`), a min-age gate, SIGTERM→SIGKILL escalation, and a `PICKLE_ORPHAN_REAP=off` kill-switch. Port these invariants verbatim.

The `killProcessGroup` primitive (`orphan-reaper.ts:62-78`) remains part of the worker-timeout decision (process-group kill on the `omnigent run` one-shot). The reaper ported here is the setup-time collector that handles the crash/SIGKILL path, which no timeout can cover — because a killed manager runs no teardown.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/inner/bwrap_sandbox.py:451-468` uses PID isolation and die-with-parent; `omnigent/inner/sandbox.py:806-845` documents backend defaults/explicit none; `extension/src/services/orphan-reaper.ts:8-30,52-65` documents crash orphans/group kill.
- **Notes:** Evidence does not justify a blanket skip for every macOS or explicit-none path. Constrain the skip by proven backend or retain the positive-ownership reaper.
- **Date:** 2026-07-12

## Remediation

- **Status:** FIXED — countersign finding accepted. This was a real defect, not a citation nit.
- **Root cause:** The file asserted that `darwin_seatbelt` "enforces process-tree containment via SBPL." It does not. Omnigent documents the opposite in its own source (`seatbelt_sandbox.py:78-81`), and `post_spawn` — the containment-handle hook — is implemented only by `windows_jobobject_sandbox.py:203`. The blanket skip rested entirely on that false premise.
- **Change:** Decision changed **skip → port (backend-gated)**. The reaper is ported with its positive-ownership invariants intact, and activates only where containment is absent (`darwin_seatbelt`, `sandbox.type: none`); it no-ops where containment is proven (`linux_bwrap`, `windows_jobobject`). Added the verified containment matrix to the Omnigent section, corrected the §2.1.1 adoption to ADOPT-with-correction, and rewrote Evaluation + Reasoning.
- **Verified against source:** `seatbelt_sandbox.py:78-81` (no PID/UTS/IPC namespace isolation on macOS), `seatbelt_sandbox.py:329` (no `post_spawn`), `windows_jobobject_sandbox.py:203` (sole `post_spawn` impl), `bwrap_sandbox.py:452,460,463` (`--unshare-pid`, `--die-with-parent`), `sandbox.py:832-833,845` (`type: 'none'` opt-out).
- **Impact:** macOS is the primary development platform. A blanket skip would have shipped Rickgent with no orphan GC on the platform where the motivating failure (B-SIGFH: hung codex, orphan re-parented to PID 1) actually occurs.
- **Date:** 2026-07-12
