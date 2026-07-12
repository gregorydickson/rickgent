# Decision: Session Resume

## Component
§2 matrix row — session resume (restore a paused/crashed pipeline to where it was and continue).

## Omnigent implementation
Omnigent ships `omnigent/resume_dispatch.py` — a conversation-level resume dispatcher. It converts the user's "take me back to where I was" intent into the right wrapper invocation:

- `run_resume(target, server)` (`resume_dispatch.py:run_resume`) — the entry point. Direct-id form (`target` provided) hits the server once for the wrapper label and routes to the right wrapper. Picker form (`target=None`) requires `--server` and opens a cross-agent picker.
- `_dispatch_by_runtime(target, server)` (`resume_dispatch.py:_dispatch_by_runtime`) — fetch the conversation's `omnigent.wrapper` label and dispatch to the matching runtime. Terminal-native sessions route into their wrapper entry point; everything else surfaces a copy-pasteable hint to `omnigent run --resume` (the agentless form is tracked separately, not in scope).
- `_read_wrapper_label_local(conv_id)` (`resume_dispatch.py:_read_wrapper_label_local`) — read the wrapper label from the local persistent store via `SqlAlchemyConversationStore.get_conversation(conv_id).labels["omnigent.wrapper"]`.
- `_read_wrapper_label_remote(server, conv_id)` (`resume_dispatch.py:_read_wrapper_label_remote`) — GET `/v1/sessions/{conv_id}` on the remote server and read the wrapper label from the response.
- `_dispatch_wrapper(wrapper, server, session_id)` (`resume_dispatch.py:_dispatch_wrapper`) — dispatch to `claude_native`, `codex_native`, `pi_native`, `cursor_native`, `kiro_native`, `goose_native`, `antigravity_native`, `qwen_native`, `kimi_native`, or `hermes_native` based on the wrapper label.

This is CONVERSATION-LEVEL resume: it fetches a conversation by id, reads its wrapper label, and re-launches the matching terminal-native wrapper pointed at that conversation id. It is a "restart the wrapper attached to the same conversation" operation — NOT a "reconcile pipeline progress against ground truth and re-dispatch the next ticket" operation. There is no notion of tickets, phases, baselines, or pipeline-level state recovery. The docstring is explicit: "Non-wrapper conversations surface a clear `ClickException` pointing at the existing `omnigent run --resume` invocation — the agentless `run --resume` shape is tracked separately" (`resume_dispatch.py:35-44`).

## Pickle Rick implementation
Pickle Rick ships a pipeline-level `--resume` that reads `state.json`, recomputes missing fields, and heals the pipeline. The resume surface spans several files:

- `extension/src/bin/setup.ts` — the `--resume` flag:
  - `resumeMode: boolean` / `resumePath: string | null` config fields (`setup.ts:41-42`).
  - `'--resume'` arg parser sets `config.resumeMode = true` and optionally `config.resumePath` (`setup.ts:664-667`).
  - `fullSessionPath` resolves from `config.resumePath` or discovers the session for the cwd (`setup.ts:1285-1286`).
  - C5 (B-RRH AC-C5): on `--resume`, self-heal an orphaned ticket commit via `detectAndRecoverHeadRegression` (`setup.ts:1193`, `setup.ts:1344`) — ff-reattach an orphaned commit left by a crashed worker.
  - On resume, re-derive the working-dir HEAD pin whenever it differs from HEAD; recompute missing fields rather than trusting stale state (`setup.ts:1431`).
  - Warning when `--resume` finds no persisted `worker_timeout_seconds` and `--worker-timeout` was not passed; falls back to documented default (`setup.ts:1129-1130`).

- `extension/src/bin/pickle-recover.ts` — the operator recovery command for a `recovery_exhausted` session. Four subcommands, each performing EXACTLY ONE transition via a shared primitive (never inline git, never writing state.json outside StateManager):
  - `--resume-from-todo` — select the lowest runnable Todo, ff-reattach any orphaned commit, re-queue it (`pickle-recover.ts:selectLowestRunnableTodo`, `executeTransition:resume-from-todo`).
  - `--salvage <ticket>` — call `salvageTicket()` (commit+Done / archive+Todo / ff-reattach / no-op, per the tree+gate) (`pickle-recover.ts:executeTransition:salvage`).
  - `--reattach-orphan` — ff-reattach an orphaned commit via `detectAndRecoverHeadRegression` (`pickle-recover.ts:executeTransition:reattach-orphan`).
  - `--reset-ticket <id>` — archive the diff + reset the ticket to Todo (`pickle-recover.ts:resetTicketViaSalvage`).
  - `--reactivate` — un-terminalize a completed session (`pickle-recover.ts:executeTransition:reactivate`).
  - `--plan` dry-run mode prints the would-be transition and performs NO write (`pickle-recover.ts:runRecover`).

- `extension/src/bin/mux-runner.ts` — `reconcileTicketTruth` / `reconcileTicketStateDesync` / `reconcileInProgressSet` reconcile ticket frontmatter status against git truth at resume and at every EPIC-terminal finalize (`mux-runner.ts:reconcileTicketStateDesync`, `reconcileInProgressSet`). This is the "git is ground truth, state.json is a cache" reconcile.

This is PIPELINE-LEVEL resume: read the pipeline state, recompute missing/stale fields from git truth, ff-reattach orphaned commits, salvage or reset tickets whose tree state disagrees with their frontmatter status, and re-dispatch the next runnable ticket. It is NOT conversation-level — it does not re-launch a wrapper attached to a conversation id; it re-launches the orchestrator pointed at the same pipeline state.

## Contract
What this component does: restore a paused/crashed pipeline to where it was — reconcile pipeline-level state against git ground truth, heal orphaned commits, salvage or reset tickets whose tree state disagrees with their frontmatter, and re-dispatch the next runnable ticket.

Invariants:
- Resume reads the persisted pipeline state (`.rickgent/registry.json`), then RECONCILES it against git truth before trusting any field — git is ground truth, the registry is a cache.
- Orphaned commits (a worker committed but crashed before flipping frontmatter) are ff-reattached to the ticket they belong to, not discarded.
- A ticket whose tree state disagrees with its frontmatter status is salvaged (commit+Done if the work is real) or reset (archive+Todo if the work is unreattachable) — never silently left inconsistent.
- Resume re-derives the working-dir HEAD pin on every resume, even when the stored pin matches HEAD, so a repo that moved underneath the session is detected.
- Exactly ONE transition per recovery invocation; each transition emits ONE activity event.
- `--plan` is a dry-run: prints the would-be transition, performs NO write.

Failure modes:
- No runnable Todo remains (all-Done session) → `reactivate` refuses; resume has nothing to re-dispatch.
- State file unreadable / corrupt → recover from orphan tmp (`state-manager.ts:recoverOrphanTmpFiles`); if none, throw.
- Orphaned commit can't be ff-reattached (diverged) → salvage via archive+resetTodo, don't force.
- Session still active (`active:true`) → `reactivate` refuses to clobber in-flight state mid-iteration.

## Evaluation
For Rickgent's goals, Omnigent's `resume_dispatch.py` is the WRONG layer and Pickle Rick's pipeline-level resume is the RIGHT layer — but Rickgent cannot port Pickle Rick's verbatim because it is coupled to Pickle Rick's runtime.

- Omnigent resume is conversation/wrapper-level restart only. It fetches a conversation by id, reads its wrapper label, and re-launches the matching native wrapper (`resume_dispatch.py:_dispatch_by_runtime`, `_dispatch_wrapper`). There is no notion of tickets, phases, baselines, or reconcile-against-git. Rickgent's resume is a pipeline-level requirement (v0.1), not a conversation-level restart — so Omnigent resume does not satisfy it.
- Pickle Rick's `--resume` + `pickle-recover` is exactly the pipeline-level resume Rickgent needs: read state, recompute from git truth, ff-reattach orphans, salvage/reset inconsistent tickets, re-dispatch the next runnable ticket. The C5 self-heal (`setup.ts:1193, 1344`), the four `pickle-recover` transitions (`pickle-recover.ts:executeTransition`), and the `reconcileTicketTruth` reconcile (`mux-runner.ts`) are the right semantics.
- But Pickle Rick's resume is tightly coupled to its own runtime: `state.json` schema (`LATEST_SCHEMA_VERSION=5`, `V3_STATE_SHAPE_MARKERS`), the `recovery_exhausted` exit-reason gate, `salvageTicket` / `detectAndRecoverHeadRegression` / `reconcileTicketTruth` internals, the `StateManager.update`-only write path, and the `--resume-from-todo` / `--salvage` / `--reattach-orphan` / `--reset-ticket` / `--reactivate` subcommand surface. Rickgent should PORT THE SEMANTICS (registry.json + git-truth reconcile + re-dispatch), not the Pickle Rick CLI surface or state.json schema.

PORT (Pickle Rick): Rickgent needs its own resume layer — `.rickgent/registry.json` + git-truth reconcile + orphan-reattach + salvage/reset + re-dispatch — modeled on Pickle Rick's pipeline-level resume semantics, not on Omnigent's conversation-level restart.

## §2.1.1 Finding
ADOPT — "ANSWERED — Rickgent needs its own. Omnigent resume is conversation/wrapper-level restart only. The rickgent resume layer is a v0.1 requirement."

Confirmed by source:
- Omnigent resume is conversation/wrapper-level restart only — `resume_dispatch.py:run_resume` fetches a conversation by id, reads its `omnigent.wrapper` label (`_read_wrapper_label_local`/`_read_wrapper_label_remote`), and dispatches to the matching native wrapper (`_dispatch_wrapper`). No ticket/phase/baseline notion.
- Rickgent needs pipeline-level resume — Pickle Rick's `--resume` (`setup.ts:664`) + `pickle-recover` (`pickle-recover.ts:runRecover`) + `reconcileTicketTruth` (`mux-runner.ts`) model exactly this, but Rickgent cannot inherit them verbatim (runtime coupling).

The finding is adopted as written.

## Decision: port
PORT (Pickle Rick) — Rickgent needs its own resume layer (`.rickgent/registry.json` + git-truth reconcile + orphan-reattach + salvage/reset + re-dispatch), modeled on Pickle Rick's pipeline-level resume semantics, NOT on Omnigent's conversation-level wrapper restart.

## Reasoning
Rickgent's resume is a v0.1 requirement and it is pipeline-level, not conversation-level. Omnigent's `resume_dispatch.py` does not satisfy it: it restarts a wrapper attached to a conversation id (`_dispatch_by_runtime` → `_dispatch_wrapper`), with no reconcile against git truth, no orphan-reattach, no salvage/reset, and no notion of tickets or phases. Reusing Omnigent resume would leave Rickgent with no way to recover a crashed pipeline — only a way to re-open a chat.

Pickle Rick's pipeline-level resume is the right model. The `--resume` flag (`setup.ts:664-667`) reads `state.json`, recomputes missing fields from git truth, and heals the pipeline. The C5 self-heal (`setup.ts:1193, 1344`) ff-reattaches orphaned commits. `pickle-recover` (`pickle-recover.ts:runRecover`) performs exactly-one transitions: `--resume-from-todo` (re-queue lowest runnable Todo + ff-reattach), `--salvage` (commit+Done / archive+Todo / ff-reattach / no-op per tree+gate), `--reattach-orphan` (ff-only), `--reset-ticket` (archive+resetTodo), `--reactivate` (un-terminalize). `reconcileTicketTruth` (`mux-runner.ts:reconcileTicketStateDesync`) reconciles frontmatter against git truth at resume and at every terminal finalize — git is ground truth, state.json is a cache.

Rickgent ports the SEMANTICS: a `.rickgent/registry.json` resume layer that (a) reads the registry, (b) reconciles it against git truth (commits, frontmatter, branch state) — git wins, (c) ff-reattaches orphaned commits to their tickets, (d) salvages or resets tickets whose tree state disagrees with their status, (e) re-derives the working-dir HEAD pin, (f) re-dispatches the next runnable ticket. Rickgent does NOT port the Pickle Rick CLI surface (`--resume-from-todo` etc.), the `state.json` schema, the `recovery_exhausted` exit-reason gate, or the `salvageTicket`/`detectAndRecoverHeadRegression` internals — those are reimplemented against Rickgent's registry schema and git-truth model. The decision is PORT, not MASH, because Omnigent contributes nothing to pipeline-level resume — it is conversation-level only.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/resume_dispatch.py:39-86,147-230`; `pickle-rick-claude/extension/src/bin/setup.ts:664-667,1193-1198`
- **Notes:** The decision itself looks correct, but the Omnigent evidence in the file uses the nonexistent shortened path `omnigent/resume_dispatch.py` instead of the local `omnigent/omnigent/resume_dispatch.py`.
- **Date:** 2026-07-12
