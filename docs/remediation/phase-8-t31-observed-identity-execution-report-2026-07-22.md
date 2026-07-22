# Phase 8 — t31: Observed Harness/Model Identity — Execution Report

**Date:** 2026-07-22
**Ticket:** t31 — Make selected harness and model control invocation and persist observed identity
**Status:** Done
**Milestone:** M8-t31-t34

## Scope

Thread the router's selected harness/provider/model/bundle digest into the actual Omnigent invocation using array argv, and persist requested, invoked, and observed identity receipts from separate producers. Extract independently observed native session identity through the `t00` seam (the isolated omnigent chat.db root conversation) and reject missing/alias-ambiguous/mismatched identity before completion.

## What Was Implemented

### 1. `orchestrator/src/dispatch/model-identity.ts` (new)

The identity capture and verification module produces three independent receipts from separate producers:

- **Requested** (`captureRequestedIdentity`): from the immutable `ExecutionContext` — what the router selected and what was written into the attempt context before spawn. Provenance: `immutable-attempt-context`.
- **Invoked** (`captureInvokedIdentity`): from the actual array argv and materialized bundle digest — what was actually passed to the omnigent process. Extracts `--harness` and `--model` from the argv and canonicalizes them. Provenance: `actual-array-argv-plus-materialized-bundle-digest`.
- **Observed** (`captureObservedIdentity`): from the isolated omnigent chat.db root conversation row — reads `harness_override`, `model_override`, and `session_usage.by_model` from the `conversations` table. Only a root conversation (parent_conversation_id IS NULL, root_conversation_id = id) that was NOT in the pre-dispatch baseline counts. Provenance: `isolated-omnigent-chat-db-root-conversation`.

`verifyIdentityReceipts` fails closed (throws `IdentityVerificationError`) on:
- Any missing receipt (null producer)
- Missing canonical harness/model in any receipt
- Harness mismatch between requested, invoked, and observed
- Model mismatch between requested, invoked, and observed
- Spoofed transcript (observed provenance is not the chat.db seam)
- Stale session (observed conversation_id is in the baseline set)
- Bundle-default fallback (no `--harness`/`--model` in the invoked argv)

### 2. `orchestrator/src/dispatch/dispatch.ts` (modified)

Added `--harness` and `--model` CLI arguments to the spawn argv, derived from `opts.selection`. A selection differing from bundle defaults now changes the actual Omnigent invocation, not just ledger metadata or config.yaml.

### 3. `orchestrator/test/fixtures/omnigent-fixture/chat-db.mjs` (modified)

Extended the fixture chat.db schema to include identity columns matching the real omnigent `db_models.py` `conversations` table: `parent_conversation_id`, `agent_id`, `model_override`, `harness_override`, `session_usage`. The `insertConversation` function now accepts optional `harnessOverride`, `modelOverride`, and `sessionUsage` parameters.

### 4. `orchestrator/test/fixtures/omnigent-fixture/fixture.mjs` (modified)

The fixture now reads `--harness` and `--model` from the omnigent run argv (via `flagArg`) and records them in the chat.db conversations row as `harness_override` and `model_override`. It also builds a `session_usage` JSON with `by_model` matching the real omnigent's `persisted_model_path` contract.

### 5. `orchestrator/test/dispatch/dispatch-evidence.test.ts` (modified)

Updated the expected spawn argv assertion to include the new `--harness` and `--model` arguments.

### 6. Fixture manifests (new)

- `orchestrator/test/fixtures/model-identity-corpus/manifest.json`: corpus inventory with 10 test cases covering selection-changes-invocation, independent receipts, missing/mismatched/stale/spoofed/bundle-default-fallback fail-closed, alias canonicalization, and digest stability.
- `orchestrator/test/fixtures/model-identity-corpus/session-fixtures.json`: session fixture definitions for codex/gpt-5, claude-sdk/sonnet, alias-claude, and droid/glm, plus mismatch scenarios.

### 7. `orchestrator/test/reliability/model-identity-corpus.test.ts` (new)

11 test cases exercising the full identity receipt lifecycle through the deterministic fixture omnigent:

1. Selection changes the actual `--harness`/`--model` invocation (spawn record proof)
2. Requested, invoked, and observed receipts independently produced and consistent
3. Missing observed identity receipt fails closed (IDENTITY_MISSING)
4. Harness mismatch fails closed (IDENTITY_MISMATCH, field=harness)
5. Model mismatch fails closed (IDENTITY_MISMATCH, field=model)
6. Spoofed transcript text is not treated as identity observation (old schema → null)
7. Stale session (pre-existing conversation) fails closed (not attributed to this dispatch)
8. Bundle-default fallback (no --harness/--model in argv) blocks verification (IDENTITY_BUNDLE_DEFAULT_FALLBACK)
9. Alias canonicalization is consistent across receipts (claude → claude-sdk)
10. Identity receipt set digest is stable across replays
11. persistIdentityReceipts produces three independent JSONL lines

## Red-Then-Green Proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/model-identity-corpus.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```

**Red output (4 failures before implementation):**
- `selection changes the actual Omnigent --harness/--model invocation`: `expected 'failed' to be 'implementation_captured'` (dispatch failed because workspace API was wrong, and --harness/--model not yet in argv)
- `requested, invoked, and observed receipts are independently produced and consistent`: `expected null to be 'codex'` (observed identity was null because chat.db had no identity columns and fixture didn't record overrides)
- `harness mismatch between requested and observed fails closed`: `expected null to be 'claude-sdk'` (same root cause)
- `model mismatch between requested and observed fails closed`: `expected null to be 'o3-mini'` (same root cause)

**Green command:** same command after implementation.

**Green output:** `Tests 11 passed (11)` — all tests pass.

## Verification Results

| Check | Command | Exit Code | Result |
|-------|---------|-----------|--------|
| Omnigent contract | `node orchestrator/scripts/verify-omnigent-contract.mjs --root "$OMNIGENT_ROOT" --contract artifacts/reliability/omnigent-compatibility-contract.json` | 0 | Compatible (9 checks) |
| Identity corpus test | `pnpm vitest run test/reliability/model-identity-corpus.test.ts` | 0 | 11/11 passed |
| Manifest verification | `node -e "...manifest.json..."` | 0 | complete=true, mismatch_fields=model,harness |
| TypeScript typecheck | `pnpm typecheck` | 0 | Clean |
| Build | `pnpm build` | 0 | dist/cli.js refreshed |
| Dispatch tests | `pnpm vitest run test/dispatch/...` | 0 | 47/47 + 12/12 passed |
| Python pytest | `python3 -m pytest test/ -p no:cacheprovider -q` | 0 | 367 passed, 3 skipped |
| Citadel | `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 | 0 CRITICAL, 0 HIGH |
| Doctor | `node orchestrator/dist/cli.js doctor` | 0 | Capability matrix unchanged (cross_vendor_review still unavailable — correct, t32 activates) |

## Proof Counts

- 11/11 identity corpus tests
- 12/12 dispatch-evidence tests (1 updated for new argv)
- 47/47 dispatch infrastructure tests
- 367/370 Python policy tests (3 intentional skips)
- 0 CRITICAL/HIGH citadel findings

## Known Limitations

- The `effective-session-v1` identity observation profile is offline-structurally-probed per the t00 contract. It does not permit strict identity completion or cross-vendor claims. The `runtime-reported-identity-v1` profile requires a separate live probe (out of scope for t31, deferred to t32/t38).
- Provider/vendor observation is unavailable generically per the t00 contract (`provider_vendor` source is null). The observed receipt records `canonical_vendor: null`. Cross-vendor distinction (t32) will require a live profile.
- The `captureObservedIdentity` function reads from the chat.db using `node:sqlite` (DatabaseSync). If the identity columns are missing (old schema), it returns an empty array and the observed receipt is null (fail closed).

## Next Dependency Boundary

t32 (routing and cross-vendor distinction) depends on t31's observed identity capture. t32 will exercise every identity mismatch and permit cross-vendor review only when the canonical observed identities are genuinely distinct. t32 activates the `cross_vendor_review` capability.
