# Decision: Completion Oracle

## Component
§2 matrix row: "Completion oracle" — Omnigent has nothing (trusts model claims); Pickle Rick has a single predicate with seven call sites.

## Omnigent implementation
Nothing. Omnigent trusts model claims of completion — there is no verified-sha resolution, no frontmatter-sha reconciliation, no baseline rejection, and no gate verdict consultation. The PRD (§10.4) establishes that `sys_cancel_task` is inert and that worker-timeout enforcement lives in the rickgent orchestrator, but there is no completion-verification mechanism in Omnigent itself.

## Pickle Rick implementation
**`extension/src/services/ticket-completion-evidence.ts`** (874 LOC):

- `evaluateCompletionEvidence` (line 821) — the ONE completion predicate. Decision flow:
  1. **Read evidence** via `readEvidence(ctx)` (line 529) — resolves the verified commit SHA from the git tree (what actually landed), the frontmatter `completion_commit` stamp, and the ticket's declared files.
  2. **Re-read with backoff** — if the first read does not yield accepted evidence, re-read after `ctx.rereadBackoffMs` (the worker may have committed + stamped but the write is not yet durably visible — R-CCGR).
  3. **Recover from announcement** — if still not accepted, attempt `recoverFromAnnouncement(ctx)` (the worker may have announced Done without stamping the frontmatter).
  4. **Refuse absent** — if no accepted evidence after all reads, return `refuseAbsent(evidence)` — the ticket is NOT done.
  5. **Promote and reprobe** — `promoteOnceAndReprobe(ctx, evidence.sha)` verifies the SHA is still reachable and not garbage-collected.
  6. **Worker-gate refusal** — `workerGateRefusal(ctx)` consults the gate verdict; if the gate is failing, the completion is refused even with a valid SHA.
  7. **Return accepted** — `{ ok: true, sha, via, usedFallback }` only when all checks pass.
- `readEvidence` (line 529) — the evidence reader: resolves the verified SHA from git tree truth, reconciles against the frontmatter `completion_commit` stamp, rejects baseline SHAs (a SHA equal to the session start commit is not new work), and classifies the evidence kind (`committed` vs `absent`) and via (`explicit` | `inferred` | `scan`).
- `persistEvidence` (line 619) — stamps the `completion_commit` frontmatter with the verified SHA. Called only after `evaluateCompletionEvidence` accepts.
- `gateForPhantomDoneRevert` (line 859) — thin adapter over `evaluateCompletionEvidence` with `decision: 'phantom-watch'`. B-1SEAM WS-1: the phantom-Done watcher and the Done-flip gate share ONE policy — no accept-here-revert-there split.

**Call sites (7 total, importer set pinned by test R-AFCC-CALLER-ENUMERATION):**
- `extension/src/bin/auto-fill-completion-commit.ts:92` — 1 call site (the auto-fill completion commit path).
- `extension/src/bin/mux-runner.ts` — 6 call sites via `buildCompletionCtx` (line 4693):
  - Line 1449 — twin decision (done-flip verification).
  - Line 2848 — completion verification at phase exit.
  - Line 4554 — attribution decision (no R-CWGE verdict).
  - Line 4751 — worker-gate verdict consultation.
  - Line 5288 — attribution path with zero reread backoff.
  - Line 1664 — phantom-watch context build (feeds `gateForPhantomDoneRevert`).

## Contract
The completion oracle is the single authority that decides whether a ticket is truly Done. It:
1. **Resolves the verified SHA** from git tree truth (what actually landed in the repo), not from the model's claim.
2. **Reconciles against frontmatter** — the `completion_commit` stamp must match a real, reachable commit.
3. **Rejects baseline SHAs** — a SHA equal to the session start commit is not new work; it is rejected as a false-done.
4. **Consults the gate verdict** — even with a valid SHA, if the convergence gate is failing, the completion is refused.
5. **Returns a single decision** — `{ ok: true, sha, via }` or a typed refusal with a reason.

**Invariants:**
- ONE predicate (`evaluateCompletionEvidence`), enumerated caller allowlist (R-AFCC-CALLER-ENUMERATION). No plurality — no parallel completion checks.
- The phantom-Done watcher and the Done-flip gate share ONE policy via `gateForPhantomDoneRevert` (B-1SEAM WS-1: no accept-here-revert-there split).
- A baseline SHA is never accepted as completion evidence.
- A failing gate verdict always refuses completion, even with a valid SHA.
- The re-read backoff handles the race where the worker commits + stamps but the write is not yet durably visible (R-CCGR).

**Failure modes:**
- No commit found → `refuseAbsent` — ticket is NOT done.
- SHA is the session start commit → rejected as baseline.
- SHA is unreachable (garbage collected) → `refuseAbsent` after reprobe.
- Gate is failing → `workerGateRefusal` — completion refused.
- Frontmatter stamp missing but announcement present → `recoverFromAnnouncement` may accept if git tree truth confirms a commit.

## Evaluation
Pickle Rick is strictly better. Omnigent trusts model claims — a worker can say "I AM DONE" and the system believes it, even with no commit, no gate pass, and no tree change. This is the single most dangerous failure mode in an autonomous system: false completion. Pickle Rick's completion oracle is the single source of truth that prevents this, and the one-predicate invariant (R-AFCC-CALLER-ENUMERATION) ensures there is no plurality of completion checks that could disagree.

## §2.2.1 Finding
ADOPT — "The completion oracle is a single predicate, not a single call-site: `evaluateCompletionEvidence` has 7 call sites, with the importer set pinned by test. The TS verdict core keeps that invariant: one predicate, an enumerated caller allowlist asserted by test." Verified: `evaluateCompletionEvidence` at ticket-completion-evidence.ts:821, 6 call sites in mux-runner.ts (lines 1449, 2848, 4554, 4751, 5288, and via `buildCompletionCtx` at 4693/1664), 1 call site in auto-fill-completion-commit.ts:92. Importer set pinned by R-AFCC-CALLER-ENUMERATION test.

## Decision: port
Port the Pickle Rick completion oracle as a SINGLE predicate in the TS verdict core. Python reaches it only via `rickgent verdict` (§10.9).

## Reasoning
The completion oracle is the single most critical reliability mechanism in Rickgent. Without it, a worker can claim Done without any verifiable evidence — no commit, no gate pass, no tree change. The PRD's §10.4 establishes the design principle: "Single completion oracle — no plurality." Pickle Rick's implementation is the proven, tested realization of that principle.

The port places the oracle entirely in the verdict core:
- **`orchestrator/src/core/completion-evidence.ts`** gets `evaluateCompletionEvidence`, `readEvidence`, `gateForPhantomDoneRevert`, the `EvidenceResult`/`EvidenceCtx`/`CompletionDecision` types, the baseline-rejection logic, the frontmatter-sha reconciliation, the re-read backoff, the announcement recovery, and the worker-gate refusal. These are pure functions over git state and ticket frontmatter — no spawns, no git mutations, no I/O beyond reads handed in via the context.
- The lifecycle layer calls the core via `rickgent verdict completion-evidence --json` (§10.9) or the in-process core API. Python policy code (`rickgent/policies/completion_evidence.py`) adapts Omnigent policy events to core verdicts via the same CLI — it never implements its own completion logic.

The one-predicate, enumerated-caller-allowlist invariant (R-AFCC-CALLER-ENUMERATION) is preserved verbatim: a test asserts the exact set of importers of `evaluateCompletionEvidence`. Any new caller must be added to the allowlist or the test fails. This prevents the completion-oracle-collapse failure mode where multiple parallel completion checks disagree and the system accepts the most permissive one.

The B-1SEAM WS-1 invariant (phantom-Done watcher and Done-flip gate share ONE policy) is preserved: `gateForPhantomDoneRevert` remains a thin adapter over `evaluateCompletionEvidence`, not a separate implementation. No accept-here-revert-there split.

The baseline-rejection invariant (a SHA equal to the session start commit is not new work) is preserved: `readEvidence` rejects baseline SHAs categorically. The gate-consultation invariant (a failing gate refuses completion even with a valid SHA) is preserved: `workerGateRefusal` runs after evidence acceptance and before the final return.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/spawn.py:118-130`; `pickle-rick-claude/extension/src/services/ticket-completion-evidence.ts:529,821,859`
- **Notes:** The Pickle Rick oracle citations check out and the decision is sensible, but the file supplies no Omnigent file:line citation for the "Omnigent has nothing" side, so the comparison is not AC-3 evidence-backed.
- **Date:** 2026-07-12
