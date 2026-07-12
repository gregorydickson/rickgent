# Decision: Circuit Breaker

## Component
§2 matrix row: "Circuit breaker" — Omnigent has nothing; Pickle Rick has the full breaker plus a split escalation ladder.

## Omnigent implementation
Nothing. Omnigent has no circuit breaker, no error-signature counting, no progress detection, no escalation ladder, and no recovery-attempts ledger. There is no mechanism to detect a looping agent, suppress redundant failed-flip attempts, or bound consecutive no-progress relaunches.

## Pickle Rick implementation
The circuit breaker is SPLIT across two files:

**`extension/src/services/circuit-breaker.ts`** (438 LOC) — the breaker thresholds and state machine:
- `canExecute` (line 209) — returns true when the breaker state is not `OPEN` (i.e. `CLOSED` or `HALF_OPEN`).
- `detectProgress` (line 213) — compares the current iteration against the last known state: uncommitted changes, staged changes, HEAD movement (with R-DEFCHURN empty-commit detection: compares tree SHAs, not just commit SHAs, so empty commits do not count as progress), step changes, and ticket changes. Returns `ProgressResult` with `hasProgress`, `currentHead`, `filesChanged`, `stepChanged`, `ticketChanged`.
- `extractErrorSignature` (line 276) — parses NDJSON output to find the last assistant text block when the result subtype is an error. Returns a normalized error signature or null.
- `normalizeErrorSignature` (line 304) — normalizes an error line into a comparable signature (strips timestamps, paths, and other noise).
- `isConstraintDiscoverySignature` (line 330) — classifies whether an error signature represents a constraint discovery (the agent hit a real limit, not a repeatable failure). Constraint discoveries do not trip the breaker because they represent learning, not looping.
- `recordIterationResult` (line 359) — records the iteration outcome into the breaker state, transitioning between `CLOSED`, `HALF_OPEN`, and `OPEN` based on error signature repetition and progress detection.
- Also exports: `CircuitState` type (`CLOSED | HALF_OPEN | OPEN`), `CircuitBreakerState`, `CircuitBreakerConfig`, `readCircuitBreakerState`, `loadSettings`, `initCircuitBreaker`, `resetCircuitBreaker`, `countFilesChanged`.

**`extension/src/bin/mux-runner.ts`** (11,339 LOC) — the escalation ladder rungs:
- `silentDeathGit` (line 8052) — a silent git helper used by the silent-death detection path. Checks HEAD rev-parse, diff name-only, fsck for lost-found objects. The silent-death cap (`silent_death_respawn_cap`, default 1) bounds how many times a silently-died worker can be respawned before the escalation advances.
- `evaluateFailedFlipSuppression` (line 8387) — evaluates whether a failed Done-flip should be suppressed (not retried). The `failed_flip_suppression_cap` (default 2) bounds how many failed Done-flips are tolerated before the suppression advances to the next ladder rung.
- `BOUNDED_ESCAPE_STRATEGY` (line 5925) — the constant `'bounded_terminal_escape'`. The bounded terminal escape cap (`bounded_terminal_escape_cap`, default 3, AC-A4) bounds consecutive no-progress relaunches on the same In Progress ticket before the bounded escape forces it terminal. The strategy is recorded in `state.recovery_attempts[]` and counts/de-dupes per ticket.
- `isWithinBreakerRecoveryGrace` (line 7643) — checks whether the current time is within the breaker recovery grace window (`breaker_recovery_grace_seconds`, default 30). During the grace window, a breaker-recovery spawn does not count as progress, preventing a recovery spawn from resetting the breaker immediately.

The `hardening` settings block (resolved by `resolveHardeningSettings` in `pickle-utils.ts`) configures all four caps: `silent_death_respawn_cap`, `failed_flip_suppression_cap`, `breaker_recovery_grace_seconds`, `bounded_terminal_escape_cap`. These draw down the persistent `state.recovery_attempts` ledger that survives relaunch and `--resume`.

## Contract
The circuit breaker prevents infinite loops by tracking error signatures and progress across iterations. The escalation ladder bounds recovery attempts at increasing granularity:
1. **Breaker thresholds** (circuit-breaker.ts): `CLOSED` → `HALF_OPEN` → `OPEN` transitions based on repeated error signatures. `OPEN` blocks execution (`canExecute` returns false).
2. **Silent-death cap**: a worker that dies silently (no output, no commit) can be respawned at most `silent_death_respawn_cap` times before the ladder advances.
3. **Failed-flip suppression**: a failed Done-flip can be retried at most `failed_flip_suppression_cap` times before the suppression advances.
4. **Bounded terminal escape**: after `bounded_terminal_escape_cap` consecutive no-progress relaunches on the same ticket, the bounded escape forces the ticket terminal (Failed, not infinite retry).
5. **Recovery grace**: during `breaker_recovery_grace_seconds` after a breaker-recovery spawn, progress detection is suppressed so the recovery spawn itself does not reset the breaker.

**Invariants:**
- Empty commits do not count as progress (R-DEFCHURN: tree SHA comparison, not commit SHA comparison).
- Constraint discoveries do not trip the breaker (they represent learning, not looping).
- The `recovery_attempts` ledger is persistent across relaunch and `--resume`.
- Each ladder rung draws down a separate cap; the caps are non-negative ints (0 disables the rung).

**Failure modes:**
- Breaker `OPEN` → `canExecute` returns false; the caller must not spawn a new iteration.
- Silent death cap exhausted → escalation advances to the next rung.
- Bounded escape cap exhausted → ticket forced terminal (honest `recovery_exhausted`, not infinite retry).
- Non-git working directory → `detectProgress` assumes progress (warns once) to avoid false-tripping the breaker.

## Evaluation
Pickle Rick is strictly better. Omnigent has no circuit breaker or escalation ladder at all — an agent could loop forever with no detection. Pickle Rick's implementation is split across two files (breaker thresholds in `circuit-breaker.ts`, escalation ladder in `mux-runner.ts`), which the TS refactor consolidates. The R-DEFCHURN lesson (empty-commit churn) is a live-incident-derived invariant that a naive implementation would miss.

## §2.2.1 Finding
ADOPT — "The escalation ladder is SPLIT across files: breaker thresholds live in circuit-breaker.ts; silent-death cap (`silentDeathGit`), failed-flip suppression (`evaluateFailedFlipSuppression`), bounded terminal escape (`BOUNDED_ESCAPE_STRATEGY`), and recovery grace (`isWithinBreakerRecoveryGrace`) all live in mux-runner.ts. The TS refactor pulls from BOTH." Verified: `silentDeathGit` at mux-runner.ts:8052, `evaluateFailedFlipSuppression` at mux-runner.ts:8387, `BOUNDED_ESCAPE_STRATEGY` at mux-runner.ts:5925, `isWithinBreakerRecoveryGrace` at mux-runner.ts:7643. Breaker thresholds in circuit-breaker.ts: `canExecute` (209), `detectProgress` (213), `extractErrorSignature` (276), `normalizeErrorSignature` (304), `isConstraintDiscoverySignature` (330), `recordIterationResult` (359).

## Decision: port
Port the Pickle Rick circuit breaker into Rickgent's TS verdict core (transitions, error signatures, progress detection) + TS runtime ledger (escalation ladder, recovery attempts). Pull from BOTH `circuit-breaker.ts` and `mux-runner.ts`.

## Reasoning
The circuit breaker is the anti-loop mechanism that prevents Rickgent from burning infinite budget on a stuck agent. Without it, a looping agent (same error every iteration, no progress, empty commits) would run forever. Omnigent has no equivalent — its sessions are fire-and-forget with no iteration-level monitoring.

The port consolidates the split implementation into a single coherent module:
- **`orchestrator/src/core/circuit-breaker.ts`** gets the pure state machine: `canExecute`, `detectProgress` (with R-DEFCHURN tree-SHA comparison), `extractErrorSignature`, `normalizeErrorSignature`, `isConstraintDiscoverySignature`, `recordIterationResult`, the `CircuitState` transitions, and the escalation ladder decisions (`evaluateFailedFlipSuppression`, `isWithinBreakerRecoveryGrace`, bounded-escape cap logic). These are pure functions over state and error signatures — no spawns, no git mutations.
- **`orchestrator/src/lifecycle/circuit-breaker.ts`** gets the runtime ledger: `readCircuitBreakerState`, `initCircuitBreaker`, `resetCircuitBreaker`, the `recovery_attempts` ledger persistence, `silentDeathGit` (the git probes for silent-death detection), and the `BOUNDED_ESCAPE_STRATEGY` enforcement (writing the terminal state). These are the I/O operations that the core's decisions drive.

The four `hardening` caps (`silent_death_respawn_cap`, `failed_flip_suppression_cap`, `breaker_recovery_grace_seconds`, `bounded_terminal_escape_cap`) are resolved from settings and passed to the core as configuration. The persistent `recovery_attempts` ledger survives relaunch and resume, ensuring the caps draw down across session boundaries.

The R-DEFCHURN invariant is the most critical: `detectProgress` must compare tree SHAs (`^{tree}`), not just commit SHAs, so a churn of empty commits does not reset the breaker. This was learned from a live incident (2026-06-19, session 2b1e2707, ticket 26cd29db: ~12 deferral commits, 9 empty) and must survive the port verbatim.

## Countersign

- **Reviewer:** GPT-5 Codex
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/omnigent/tools/builtins/spawn.py:118-130`; `pickle-rick-claude/extension/src/services/circuit-breaker.ts:209,213,276,304,330,359`
- **Notes:** The Pickle Rick breaker citations check out and the port decision is plausible, but the file provides no Omnigent file:line citation for the "Omnigent has nothing" side of the comparison, so the cross-vendor evidence is not countersignable.
- **Date:** 2026-07-12
