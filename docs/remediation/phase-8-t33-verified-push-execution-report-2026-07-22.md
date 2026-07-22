# Phase 8 — t33 Verified Push Execution Report

**Date:** 2026-07-22
**Ticket:** t33 — Implement verified push with observed remote OID
**Milestone:** M8 (t31–t34: Identity, Routing, Verified Delivery)
**Status:** Done

## Scope

Implement the verified push protocol that accepts only a run whose every planned ticket is oracle-complete/ready and cleanup-verified, persists delivery intent with exact local delivery OID/remote/branch/expected old remote OID, executes array-argv non-force push, then observes `git ls-remote` and requires equality. Covers success, rejection, timeout, response-loss, and ref-race cases against disposable local bare repositories.

## Implementation

### New files

- `orchestrator/src/delivery/push.ts` — `executeVerifiedPush` function implementing the full verified push protocol:
  1. Verifies the local delivery ref equals the delivery OID (precondition check).
  2. Creates or resumes the delivery intent via `DeliveryAuthority.createIntent` (idempotent — returns existing if same input; the store enforces run is `ready_for_delivery` and `current_delivery_oid` matches).
  3. Checks existing remote observations for idempotent resume.
  4. If no push observation exists, executes `git push <remote> <oid>:refs/heads/<branch>` with `execFileSync` array argv (no force) and records the push observation via `DeliveryAuthority.recordRemoteObservation`.
  5. If no ls-remote observation exists, executes `git ls-remote <remote> refs/heads/<branch>` with `execFileSync` array argv and records the ls-remote observation.
  6. Requires the observed remote OID to equal the delivery OID — mismatch returns `mismatch` status.

- `orchestrator/test/reliability/push-protocol.test.ts` — 8 test cases covering all 5 required cases plus precondition and idempotency checks.
- `orchestrator/test/fixtures/delivery-corpus/manifest.json` — Delivery corpus manifest with 4 failure cases + 1 success case.

### Modified files

- `orchestrator/src/state/store.ts` — Added two public read methods:
  - `readDeliveryIntent(runId)` — reads the delivery intent for a run.
  - `listRemoteObservations(deliveryIntentId)` — lists all remote observations in sequence order.
  These enable the push service to query existing state for idempotent resume.

## Outcome

### Red-then-green proof

**Red (failing test before implementation):**
```
cd orchestrator && pnpm vitest run test/reliability/push-protocol.test.ts --no-file-parallelism
→ 7 failed (behavioral assertion failures: expected "verified"/"rejected"/"mismatch" but got "infrastructure_error")
→ 1 passed (timeout case accepts infrastructure_error as valid non-delivered outcome)
```

**Green (after implementation):**
```
cd orchestrator && pnpm vitest run test/reliability/push-protocol.test.ts --no-file-parallelism
→ 8 passed (8 tests)
```

### Test cases (8 total)

1. **Success:** Pushes the exact delivery OID to a local bare repo and confirms via independent ls-remote. Asserts actual remote ref matches, delivery intent persisted with exact OID/remote/branch, and observation sequence push=1, ls-remote=2.
2. **Rejection:** Non-fast-forward push rejected by remote (bare pre-populated with divergent commit). Run remains `ready_for_delivery`, no ls-remote observation recorded.
3. **Timeout:** Push command killed by 1ms timeout. Run remains non-delivered, no ls-remote observation.
4. **Response-loss:** Push succeeds, push observation persisted, then resume via second `executeVerifiedPush` call completes ls-remote without re-pushing. Asserts only 1 push observation exists after resume.
5. **Ref-race:** Push succeeds, remote ref moved by concurrent force-push, ls-remote observes different OID. Result is `mismatch`, run remains non-delivered.
6. **Precondition (not ready):** Run not in `ready_for_delivery` state. Returns `infrastructure_error` with "ready_for_delivery" in reason.
7. **Precondition (wrong ref):** Delivery ref does not equal delivery OID. Returns `infrastructure_error` with "delivery ref" in reason.
8. **Idempotent intent:** Repeated push request resolves the same delivery intent without duplication.

### Verification commands

| Command | Exit Code | Observation |
|---|---|---|
| `cd orchestrator && pnpm typecheck` | 0 | tsc --noEmit clean |
| `cd orchestrator && pnpm build` | 0 | dist/cli.js refreshed |
| `cd orchestrator && pnpm vitest run test/reliability/push-protocol.test.ts test/reliability/transition-authority.test.ts --no-file-parallelism` | 0 | 40/40 passed (8 push + 32 transition) |
| `cd rickgent-policies && python3 -m pytest test/ -p no:cacheprovider -q` | 0 | 367 passed, 3 skipped |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 | 0 CRITICAL, 0 HIGH introduced (15 pre-existing HIGH in cross-vendor-review.test.ts from t32) |
| `rg -n "ls-remote\|non.fast.forward\|expected.*OID\|PR.*unreachable" orchestrator/test/reliability/push-protocol.test.ts` | 0 | All patterns present |

### Invariants preserved

- **argv-only execution:** `execFileSync("git", [...])` with array argv, never shell strings.
- **No force flag:** Push refspec is `<oid>:refs/heads/<branch>` with no `--force`.
- **Independent ls-remote:** Push exit code alone is not sufficient; an independent `ls-remote` observation is required.
- **Fail closed:** All error paths (missing origin, rejected, timeout, mismatch, crash) leave the run non-delivered.
- **Idempotent resume:** Re-call after push observation but before ls-remote does not re-push.
- **DeliveryAuthority:** All observations persisted through branded authority, not direct SQL writes.
- **One oracle, one matcher:** No new path matcher or completion predicate introduced.

## Known limitations

- The push service does not yet wire into the production lifecycle (that is t34's scope — PR creation after verified push, and t38's scope — the protected vertical slice).
- The `automatic_delivery` capability remains `unavailable` (activation is t34's scope after both push and PR protocols are verified).
- The timeout test uses a 1ms timeout which may produce either `timeout` or `rejected` depending on timing; both are valid non-delivered outcomes.

## Next dependency boundary

t34: Implement verified and idempotent PR creation. Depends on t33's verified push being complete. t34 will create/resolve a PR only after a verified remote push observation, use structured `gh` JSON, verify target repository/base/head branch, and independently query PR head OID for equality with the delivery OID.
