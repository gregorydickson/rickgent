# Decision: Salvage

## Component
§2 matrix row: "Salvage" — Omnigent has `sys_cancel_task` (just kills the process, and is inert anyway); Pickle Rick has a full salvage machinery with dispositions.

## Omnigent implementation
`sys_cancel_task` — the server tasks table was removed; the tool returns `task_not_found` for all inputs, and the sub-agent busy check is a no-op (confirmed in §2.2.1 and the PRD §10.4). The tool title mapping exists at `web/src/lib/toolTitle.ts:99` but the underlying primitive is inert. There is no salvage logic, no disposition matrix, no dirty-tree rescue, no orphan-reset detection, and no ff-reattach. Worker-timeout enforcement must live in the rickgent orchestrator, not in a platform cancel primitive.

## Pickle Rick implementation
Three files form the salvage subsystem:

**`extension/src/lib/salvage-ticket.ts`** (213 LOC) — the disposition decider:
- `SalvageDisposition` union (line 32): `'ff-reattached' | 'committed-done' | 'archived-todo' | 'no-op' | 'error'`.
- `salvageTicket` (line 166) — the single salvage entry point. Decision flow:
  1. **ff-reattach**: HEAD regressed off a committed ticket → auto-ff-reattach the orphan commit. Returns `ff-reattached`.
  2. **clean tree**: no dirty paths → `salvageCleanTree` (back-fill or no-op).
  3. **already terminal**: ticket is Done/Skipped → `no-op` (don't re-salvage a terminal ticket).
  4. **dirty + gate passing**: commit scoped deliverable + flip Done → `committed-done`.
  5. **dirty + gate failing/errored/commit-failed**: archive the diff, reset frontmatter to Todo → `archived-todo`. The `archived` flag is true when the archive succeeded.
  6. **exception**: best-effort, no destructive action taken → `error`.
- `SalvageDeps` interface — injectable seams (`reconcile`, `gate`, `commitScoped`, `archive`, `resetTodo`, `ffReattach`, `backFillDone`) so the full disposition matrix is testable without a real git repo.

**`extension/src/lib/reconcile-ticket-truth.ts`** (104 LOC) — the ground-truth reader:
- `reconcileTicketTruth` (line 84) — the single ground-truth read every salvage/recovery seam shares (AC-W3-RECONCILE: grep count == 1). Returns `TicketTruth`: `headSha`, `dirty`, `dirtyPaths`, `ticketStatuses`, `tickets`. Pure read, best-effort: every probe is try/catch'd to a conservative default so a non-repo yields a clean-tree truth rather than throwing under a salvage caller.

**`extension/src/services/dirty-tree-salvage.ts`** (129 LOC) — the dirty-tree rescue mechanism:
- `stashUnattributableRemainder` (line 40) — snapshots the entire dirty working tree (tracked + untracked) into a dangling git commit using a TEMPORARY index file (`GIT_INDEX_FILE`), so neither the real index nor the worktree is mutated. Anchors the snapshot under `refs/pickle/salvage/<session>` for operator recovery. Never uses `git stash create` (cannot include untracked files).
- `salvageDirtyTree` (line 102) — the invariant enforcer: when the partitioned dirty tree carries ANY foreign paths, the whole dirty tree is snapshotted to the salvage ref and ONLY the owned set is returned as stageable. A foreign-free tree passes through untouched.
- `stageOwnedPaths` (line 121) — stages exactly `paths`, one per-path `git add -- <p>` (never a whole-tree `add -A`/`-u`). Handles new, modified, AND deleted tracked files.

## Contract
Salvage runs before any fail/cancel/relaunch/worktree-removal. It is ground-truth-driven, disposition-returning, and best-effort:
1. **Reconcile** the session's ground truth (tree state + ticket frontmatter statuses) via `reconcileTicketTruth`.
2. **Decide** a disposition via `salvageTicket`: ff-reattached, committed-done, archived-todo, no-op, or error.
3. **Execute** the disposition's git mutations (commit scoped paths, archive diff, reset Todo, ff-reattach) — the lifecycle layer owns these mutations, not the core.

**Invariants:**
- Never `git add -A`/`-u` over foreign dirt — only owned paths are staged, one by one (R-MACB).
- Un-attributable remainder is always anchored to a recoverable ref before any destructive action.
- A terminal ticket (Done/Skipped) is never re-salvaged.
- `reconcileTicketTruth` is the ONE definition of ground truth (AC-W3-RECONCILE: grep count == 1).
- Salvage is best-effort: a throw returns `error` disposition, never takes a destructive action.

**Failure modes:**
- Git repo unavailable → `reconcileTicketTruth` returns clean-tree truth (conservative default).
- Archive fails → `archived-todo` with `archived: false`; the reset still happens.
- ff-reattach fails (non-fast-forward) → falls through to the dirty-tree path.
- Commit blocked (e.g. config-protection hook) → falls through to archive-then-reset.

## Evaluation
Pickle Rick is strictly better. Omnigent's `sys_cancel_task` is inert (returns `task_not_found` for all inputs) and even if it worked, it would just kill the process — no disposition logic, no dirty-tree rescue, no ground-truth reconciliation. The PRD's §14.8 decide/execute/verify split maps perfectly onto Pickle Rick's architecture: the core decides the disposition (pure logic), the lifecycle layer executes the git mutations, and the completion oracle verifies the result.

## §2.2.1 Finding
ADOPT — "Salvage disposition names corrected: the actual `SalvageDisposition` union is `ff-reattached | committed-done | archived-todo | no-op | error`. 'Archive then reset' is a documented behavior of the archived-todo path, not a named disposition." Verified at `salvage-ticket.ts:32-37`. The `archived-todo` disposition's implementation (lines 200-208 of `salvageTicket`) confirms the archive-then-reset behavior: `deps.archive(input)` followed by `deps.resetTodo(input)`.

## Decision: port
Port the Pickle Rick salvage trio into Rickgent. The core decides and verifies dispositions; the lifecycle layer executes git mutations (§14.8 decide/execute/verify split).

## Reasoning
Salvage is the reliability mechanism that prevents data loss on worker timeout, crash, or cancel. Without it, a crashed worker's uncommitted work is stranded, an orphaned commit is lost on HEAD regression, and a dirty tree with foreign paths risks committing another ticket's work. Pickle Rick's implementation handles all three cases with a clear disposition matrix and injectable seams.

The port splits along the §14.8 decide/execute/verify boundary:
- **`orchestrator/src/core/salvage.ts`** gets the pure decision logic: `salvageTicket` (the disposition decider), the `SalvageDisposition` union, `SalvageTicketInput`, `SalvageDeps` interface. The core receives ground truth as input and returns a disposition — it never touches git. The `SalvageDeps` seams (`reconcile`, `gate`, `commitScoped`, `archive`, `resetTodo`, `ffReattach`) become the interface the core uses to call the lifecycle layer.
- **`orchestrator/src/lifecycle/salvage.ts`** gets the executors: `reconcileTicketTruth` (ground-truth read, calls git-utils), `salvageDirtyTree` + `stashUnattributableRemainder` + `stageOwnedPaths` (the dirty-tree rescue mechanism). These are the concrete git mutations that the core's seams call.

The `reconcileTicketTruth` single-definition invariant (AC-W3-RECONCILE) is preserved: there is exactly one ground-truth reader in the entire codebase. The R-MACB invariant (never `git add -A` over foreign dirt) is preserved: `stageOwnedPaths` stages one path at a time, and `salvageDirtyTree` anchors foreign dirt to a recoverable ref before any staging.

The `sys_cancel_task` inertness is not a problem — the PRD (§10.4) already specifies that worker-timeout enforcement lives in the rickgent orchestrator (deadline on inbox wait + salvage), not in a platform cancel primitive. Salvage runs on timeout/crash/cancel regardless of whether the platform has a working cancel primitive.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED
- **Spot-checks performed:** `extension/src/lib/salvage-ticket.ts:1-80,166-207` confirms five dispositions and the salvage matrix; `omnigent/tools/builtins/async_inbox.py:97-126` confirms cancellation provides no salvage.
- **Notes:** The corrected dispositions and work-preservation port are sound.
- **Date:** 2026-07-12
