# Decision: Scope Fence

## Component
§2 matrix row — scope fence (per-ticket declared-path enforcement). Cross-references AC-10 (policies enforce forbidden ops) and §2.2 `guardrails.policies.scope_fence` in the mission PRD.

## Omnigent implementation
Omnigent has no per-ticket declared-path scope fence. Its filesystem isolation is sandbox-level, not ticket-level:

- **Sandbox backends** (`omnigent/sandbox/__init__.py:1-40`) re-export `SandboxPolicy`, `resolve_sandbox`, `activate_sandbox`, and `with_additional_write_roots` from `omnigent.inner.sandbox`. The backends are `linux_bwrap` (`omnigent/sandbox/bwrap.py:1-25`) and `darwin_seatbelt` (`omnigent/sandbox/seatbelt.py:1-25`), plus `windows_jobobject` (`omnigent/inner/sandbox.py:813-814`).
- **`enforce_sandbox` policy** (`omnigent/policies/builtins/safety.py:350-446`) is a factory that forces a sandbox config on every `__agent_start` (the synthetic `sys_agent_start` tool call, `omnigent/policies/builtins/safety.py:328`). It merges `write_paths` / `read_paths` / `allow_network` / `env_passthrough` into the agent's sandbox config (`_SANDBOX_OVERRIDE_KEYS`, `omnigent/policies/builtins/safety.py:333-344`). This bounds the agent to a directory tree, but it has no concept of a per-ticket `allowed_paths` list — the same agent sandbox applies to every ticket it touches.
- **`worktree_guard` policy** (`omnigent/policies/builtins/orchestration.py:519-567`) DENYs `sys_os_write`/`sys_os_edit`/`Write`/`Edit`/`MultiEdit`/`write`/`edit` whose `path` is absolute or contains `..`. This confines a worker to its worktree subtree but does not consult a ticket manifest — it is a path-shape guard, not a declared-set guard.

So Omnigent gives hard kernel isolation (namespaces, mount views, PID namespaces via `--unshare-pid` at `omnigent/inner/bwrap_sandbox.py:452`) but no per-ticket precision.

## Pickle Rick implementation
Pickle Rick's scope fence is a preflight check against the ticket's declared file set in `scope.json`:

- **`extension/src/bin/check-scope-diff.ts`** (201 LOC) is the scope-diff gate. `checkScopeDiff()` (`check-scope-diff.ts:90-122`) reads `scope.json`, parses `allowed_paths`, gets staged paths via `git diff --staged --name-only`, and filters for paths outside scope.
- **`isPathInScope`** (`check-scope-diff.ts:32-39`) does mechanical path canonicalization: `normalizePath` strips a trailing slash, then a staged path is in-scope if it equals an allowed path or starts with `allowed + '/'`. This is the hot-path primitive — fires on every write tool call in the TS runtime.
- **`ImpactRadiusService`** seam (`check-scope-diff.ts:7-10`) is an injectable interface for transitive-dependency warnings. `maybeEmitImpactWarning` (`check-scope-diff.ts:51-71`) calls `service.getImpactRadius(paths, 2)` and logs a `scope_impact_warning` activity event for dependents outside scope. It is fail-open: a service error never blocks the gate (`check-scope-diff.ts:60`).
- **Trap-door catalog exemption** (`isTrapDoorCatalogPath`, `check-scope-diff.ts:42-46`): `CLAUDE.md` catalog files are exempt from the scope-violation check (R-TDCS #128) because a trap-door catalog is the tool's own deliverable, not code scope creep.
- **`worker_edit_outside_scope`** activity event (`check-scope-diff.ts:176-189`) is emitted on `outside_scope` so `/pickle-status` can surface drift to the operator (AC-APWS-1).
- The gate is a standalone bin (invoked preflight), not a live write-hook — it checks staged paths, not in-flight writes.

## Contract
The scope fence ensures a worker only modifies the files its ticket declared. Invariants:

1. **Declared set is authoritative** — `scope.json:allowed_paths` is the single source of truth for what a ticket may touch.
2. **Path canonicalization is mechanical** — trailing-slash normalization + prefix match. No glob, no regex, no symlink chase in the hot path.
3. **Outside-scope is a violation** — staged paths not under any allowed path (and not a trap-door catalog) block the commit / surface as drift.
4. **Fail-open on infrastructure** — missing `scope.json` returns `no_scope` (exit 0); malformed JSON returns `malformed_scope` (exit 2); the impact-radius service is fail-open.
5. **Trap-door catalogs are exempt** — `CLAUDE.md` at any depth is not a scope violation.

Failure modes: (a) `scope.json` missing or stale → `no_scope` (no enforcement, silent); (b) `allowed_paths` too broad → fence is theatrical; (c) impact-radius service error → warning suppressed, gate still fires on direct paths.

## Evaluation
For Rickgent's goals, neither side is sufficient alone. Omnigent's sandbox gives hard kernel-level isolation (namespaces, PID isolation, mount views) that Pickle Rick entirely lacks — a worker physically cannot write outside `write_paths` even if it tries. But Omnigent has no per-ticket precision: one agent sandbox config applies to every ticket, so a multi-ticket run has no way to fence worker A out of worker B's files. Pickle Rick's `scope.json` gives exactly that per-ticket precision, but it is a preflight check on staged paths, not a live write guard — a worker can write freely and only gets caught at commit time.

The mash combines both: Omnigent sandbox for hard isolation (the worker's worktree is its `write_paths`), and a Python `scope_fence` policy that mirrors `check-scope-diff.ts`'s `isPathInScope` canonicalization against the ticket's `scope.json` as a per-ticket overlay. The policy fires on every `tool_call` for write tools (`sys_os_write`, `sys_os_edit`, `Write`, `Edit`, `MultiEdit`), giving live enforcement that Pickle Rick only had at preflight. Parity is pinned by shared AC-10 fixtures against the TS core's scope module.

## §2.3 Finding
No pre-build §2.1.1/§2.2.1 finding for scope fence specifically — investigated fresh. §2.1.1 confirms Omnigent sandboxing exists with caveats (no per-ticket precision; sandbox is agent-level, not ticket-level).

## Decision: mash
Omnigent sandbox for hard isolation + Pickle Rick scope.json for per-ticket precision.

## Reasoning
The scope fence is the hot path — it fires on every write tool call — so it must be mechanical path canonicalization, not a heavy computation. Pickle Rick's `isPathInScope` (`check-scope-diff.ts:32-39`) is exactly that: trailing-slash normalize, then equality-or-prefix. Porting that logic to a Python policy function gives live per-ticket enforcement that Omnigent's sandbox alone cannot provide (the sandbox bounds the worktree, not the ticket's declared file set).

The mash layers two fences:
1. **Hard isolation (Omnigent sandbox)** — the worker's `write_paths` is its git worktree. Kernel-enforced. A worker cannot escape the worktree even with a path bug.
2. **Per-ticket precision (Rickgent `scope_fence` policy)** — a Python policy function that reads the ticket's `scope.json:allowed_paths` and DENYs writes outside the declared set, using the same canonicalization as `isPathInScope`. This fires on every `tool_call` for write-class tools, catching scope drift live rather than at commit time.

Parity is pinned by shared AC-10 fixtures: the same test cases (trailing-slash, subdirectory prefix, trap-door catalog exemption, missing scope.json) run against both the TS core's scope module and the Python policy, ensuring the two implementations agree on every path shape. Per §4 (AC-10) and §10.9 (the north star: every claim was true), the scope fence must be truthful — a worker that silently edits another ticket's files breaks the N-hands-off-runs bar.

The trap-door catalog exemption (`isTrapDoorCatalogPath`, `check-scope-diff.ts:42-46`) is preserved: `CLAUDE.md` at any depth is not a scope violation, because a trap-door catalog is documentation-only tool output, not code scope creep. The fence on source files stays fully intact.

## Shell-write detection (A-SEC-3 detection side)

The `scope_fence` policy shim (`rickgent_policies.scope_fence`) enforces two branches:

1. **Structured write tools** (`Write`, `Edit`, `MultiEdit`, `sys_os_write`, `sys_os_edit`, `write`, `edit`) carry a resolvable `path`/`file_path`/`target`; the fence canonicalizes it and DENYs when it is not under a declared path (or is unresolvable).
2. **Shell tools** — the concrete write target cannot be positively resolved from an arbitrary command string, so any command detected as a write **fails closed to DENY** (unresolvable shell write target). Read-only commands pass through.

**Shell tool-name coverage (never fail open for a non-`claude` harness):** the fence evaluates every shell tool-name variant — `sys_os_shell` (Omnigent), `Bash`/`bash` (Claude), `Shell` (Cursor), `shell` (Pi). A missing variant would silently ALLOW shell writes for that harness.

**Write detection** (`_shell_command_writes`) treats a command as a write when any of the following hold, per `&&`/`||`/`;`/`|`/`&`/newline segment (env-assignment and `sudo` prefixes stripped, `git` globals skipped):
- a `>`/`>>` redirect to a **file** — fd-duplications (`2>&1`, `>&2`) and quoted `>` (`grep '>' f`) are NOT writes and must not be false-DENIED;
- an interpreter inline-code-eval one-liner: `python`/`python3`/`python2 -c`, `perl -e`/`-E`, `ruby -e`, `php -r`, `node`/`nodejs -e`/`-p`/`--eval`;
- a write utility: `tee cp mv rm mkdir rmdir install rsync touch truncate chmod chown chgrp ln dd tar unzip gunzip gzip patch sponge`, or `sed -i`;
- a disk-mutating git subcommand: `apply am checkout restore clean stash mv rm init reset`;
- a package install: `npm`/`pnpm`/`yarn`/`pip`/`pip3 install`.

`tar` and `dd` are ambiguous (read or write) and are treated as writes to fail closed. A shell tool_call with no parseable command also DENYs (fail closed). This detection is verified by `test/test_scope_fence_shell_writes.py` (VAL-SEC-027..035, VAL-SEC-057), authored red-first.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `extension/src/bin/check-scope-diff.ts:30-54` confirms normalization, prefix matching, and exemption; `omnigent/inner/datamodel.py:470-535` documents agent-level, not ticket-level, sandbox policy.
- **Notes:** Hard isolation plus live per-ticket policy is sound.
- **Date:** 2026-07-12
