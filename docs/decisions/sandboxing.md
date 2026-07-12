# Decision: Sandboxing

## Component
§2 matrix row: Sandboxing — how the system isolates worker subprocesses (filesystem, network, process tree) from the host and from each other.

## Omnigent implementation
Omnigent has a multi-backend sandbox registry. Platform detection lives in `omnigent/_platform.py`: `IS_LINUX = sys.platform.startswith("linux")` (line ~28, "the only platform with bwrap + seccomp"), `IS_DARWIN = sys.platform == "darwin"` (line ~30, "the seatbelt sandbox platform"), `IS_WINDOWS = os.name == "nt"` (line ~26).

Backends are registered in `omnigent/sandbox/`:
- `sandbox/bwrap.py` — re-export wrapper for the Linux bubblewrap backend (`BwrapSandboxBackend` from `omnigent.inner.bwrap_sandbox`). "The bwrap backend is the Linux platform default when the `bwrap` binary is on `PATH`" (`bwrap.py:22-24`). Falls back to `none` when bwrap is missing.
- `sandbox/seatbelt.py` — re-export wrapper for the macOS seatbelt backend (`SeatbeltSandboxBackend` in `omnigent/inner/seatbelt_sandbox.py`).
- Windows uses Job Object (process-tree containment only — no filesystem/network isolation, per the §2.1.1 caveat).

Cloud sandboxes are in `omnigent/onboarding/sandboxes/`: `modal.py`, `daytona.py`, `e2b.py`, `kubernetes.py`, `cwsandbox.py`, `islo.py`, `boxlite.py`, `openshell.py`. The base interface is `SandboxLauncher` in `onboarding/sandboxes/base.py` (577 LOC, ABC with `provision`/`run_command`/`ship_files`/`stream_pty`/`forward_port`/`hold_foreground`).

Codex's own bwrap sandbox is handled separately: `omnigent/codex_native_forwarder.py` notes "Codex runs each model-issued shell command inside its OWN bwrap command" and includes logic to turn codex's opaque "sandbox can't start" bwrap failure into actionable errors.

## Pickle Rick implementation
Pickle Rick has no sandboxing. Workers run in-process on the host via `spawn`/`execFileSync` (`spawn-morty.ts`). The only isolation is a `--add-dir` flag passed to `claude -p` to restrict the working directory, and the `check-scope-diff.ts` hook (`pickle-rick-claude/extension/src/bin/check-scope-diff.ts`, 201 LOC) that fences commits to `scope.json:allowed_paths`. There is no filesystem isolation (the worker can read any host file), no network isolation, and no process-tree containment beyond the parent-child relationship.

## Contract
The sandboxing component must: (1) confine worker filesystem reads/writes to the dispatch's worktree, (2) optionally restrict network access, (3) contain the process tree so orphaned children are reaped, (4) support cloud sandboxes for untrusted work. Invariants: a worker cannot write outside its worktree; a worker crash does not affect the host or siblings. Failure modes: sandbox backend unavailable (bwrap not installed, seatbelt policy rejected), cloud sandbox provisioning failure, Windows Job Object leak (filesystem not isolated).

Three caveats from §2.1.1: (1) Windows Job Object contains process trees but does NOT isolate filesystem/network; (2) git/worktree operations run host-side (not inside the sandbox); (3) `git worktree remove --force` discards uncommitted work — salvage must always run before worktree removal.

## Evaluation
A mash is better for Rickgent's goals. Omnigent's sandbox backends (seatbelt on macOS, bwrap on Linux, cloud sandboxes) provide real filesystem and network isolation where available. But on Windows, the Job Object only contains the process tree — it does not isolate the filesystem or network. Pickle Rick's `check-scope-diff.ts` hook, while not a true sandbox, provides a scope fence that catches out-of-scope commits even when filesystem isolation is absent. Combining both gives defense in depth: Omnigent's OS-level sandbox where available, plus Pickle Rick's scope fence as a backstop on platforms where filesystem isolation is incomplete (Windows) or unavailable (no bwrap/seatbelt).

## §2.1.1 Finding
ADOPT — "CONFIRMED, three caveats: (1) Windows Job Object contains process trees but does NOT isolate filesystem/network; (2) git/worktree operations run host-side; (3) `git worktree remove` uses `--force` and discards uncommitted work — salvage must always run before worktree removal." Evidence: `_platform.py:28-30` (platform flags for bwrap/seatbelt), `sandbox/bwrap.py:22-24` (Linux default, falls back to none), `sandbox/seatbelt.py` (macOS seatbelt), `onboarding/sandboxes/base.py` (cloud sandbox launcher protocol), `codex_native_forwarder.py` (codex's own bwrap handling). The three caveats are architectural facts of the Windows backend and the git worktree lifecycle.

## Decision: mash
Mash Omnigent's sandbox backends (where available) with Pickle Rick's scope fence (where filesystem/network isolation is absent).

## Reasoning
Rickgent needs sandboxing for two reasons: protecting the host from worker misbehavior, and protecting siblings from each other. Omnigent's seatbelt/bwrap/cloud backends handle this on macOS, Linux, and cloud — reuse is the right call there. But Windows is a first-class Rickgent target, and the Job Object backend's lack of filesystem/network isolation is a real gap. Pickle Rick's `check-scope-diff.ts` (201 LOC) is not a sandbox, but it is a useful scope fence: it checks `git diff --staged --name-only` against `scope.json:allowed_paths` and exits 1 on out-of-scope paths. This catches the most common failure mode (a worker editing files outside its ticket's scope) even when the OS cannot confine the filesystem. Mashing both gives: OS-level isolation where available (seatbelt/bwrap/cloud), scope-fence backstop everywhere (including Windows), and the salvage-before-worktree-removal discipline enforced as a policy. The `git worktree remove --force` caveat is handled by requiring a salvage policy to run before any worktree removal — this is a policy-level concern, not a sandbox backend concern.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/inner/sandbox.py:253-259,808-814`; `omnigent/omnigent/inner/bwrap_sandbox.py:452-456`
- **Notes:** The mash decision is reasonable, but the Omnigent citations in the file point at nonexistent shortened paths such as `omnigent/sandbox/...` and `omnigent/_platform.py` rather than the local package paths.
- **Date:** 2026-07-12
