# Phase 8 — t34: Verified and Idempotent Pull-Request Creation — Execution Report

**Date:** 2026-07-22
**Ticket:** t34 — Implement verified and idempotent pull-request creation
**Status:** Done
**Milestone:** M8-t31-t34 (Identity, Routing, Verified Delivery)

## Scope

Implement the verified and idempotent PR creation protocol that creates or resolves a pull request only after a verified remote push observation. Require queried head OID and repository identity equality with the persisted delivery OID. Retries must resolve the same PR without duplicates or false success. Activate the `automatic_delivery` capability after proofs pass. Write the phase execution report (t31-t34 cumulative; t31, t32, t33 reports already written).

## What Was Implemented

### 1. `orchestrator/src/delivery/pull-request.ts` (new)

The `executeVerifiedPullRequest` function implements the full verified PR protocol:

1. **Requires verified push observation:** Checks for an existing ls-remote observation with an OID matching the delivery OID. PR creation is impossible before verified push.
2. **Idempotent resume:** Checks existing PR observations for the delivery intent. If a PR observation already exists, resolves the existing PR without re-creating.
3. **Find or create PR:** If no PR observation exists, calls the provider's `findExistingPr` to locate an existing PR, or `createPr` to create a new one.
4. **Independent head query:** Calls the provider's `queryPrHead` to independently query the current PR head OID and repository identity.
5. **Repository identity equality:** Requires the queried repository identity to equal the expected repository ID. Mismatch returns `mismatch` status.
6. **Head OID equality:** Requires the queried head OID to equal the delivery OID. Mismatch returns `mismatch` status.
7. **Persist PR observation:** Records the PR observation via `DeliveryAuthority.recordPrObservation` as an immutable durable record.

The `PrProvider` interface abstracts PR operations (`findExistingPr`, `createPr`, `queryPrHead`). In production, `GhCliPrProvider` wraps `execFileSync("gh", [...])` with array argv. In tests, a `FixturePrProvider` returns deterministic structured results.

Error classification: provider errors are classified into infrastructure_error (missing gh, auth failure, timeout, malformed JSON) or mismatch (wrong repository, wrong head, head lag).

### 2. `orchestrator/test/reliability/pr-protocol.test.ts` (new)

14 test cases exercising the full PR protocol matrix:

**Success (1):**
- Creates a PR after verified push, confirms head OID equals delivery OID, PR observation persisted with correct fields

**Negative proofs (12):**
- No-push rejection: PR creation impossible before verified push observation
- Wrong repository: PR from wrong repository identity rejected
- Wrong head: PR head OID differs from delivery OID rejected
- Existing wrong-head PR: existing PR with wrong head rejected, no duplicate creation
- Missing gh: provider unavailable fails closed
- Auth failure: provider auth error fails closed
- Malformed JSON: provider returns invalid JSON fails closed
- Timeout: provider exceeds deadline fails closed
- Head lag: independent query shows different OID rejected
- Response-loss: crash after create, resume resolves same PR without duplicate
- Idempotent retry: repeated call resolves same PR without duplicate creation
- Repository identity equality: PR from different repo rejected even with correct head

**Aggregate (1):**
- Every negative case asserts run remains ready_for_delivery not delivered

### 3. `orchestrator/test/reliability/delivery-negative.test.ts` (new)

15 test cases for combined push+PR delivery negative proofs:

- PR creation impossible before any push observation
- PR creation impossible when ls-remote OID does not match delivery OID
- Wrong-repository PR fails closed
- Wrong-head PR fails closed
- Existing wrong-head PR fails closed
- Missing gh fails closed
- Auth failure fails closed
- Malformed JSON fails closed
- Provider timeout fails closed
- Head lag from independent query fails closed
- Crash after create, resume resolves same PR without duplicate
- Idempotent retry resolves same PR without duplicate
- Repository identity equality required even with correct head
- No delivered/Done state on any failure path (7 sub-cases)
- Delivery corpus manifest inventory is complete

### 4. `orchestrator/src/state/store.ts` (modified)

Added `listPrObservations(deliveryIntentId)` read method to query PR observations in sequence order, enabling the PR service to check for existing observations for idempotent resume.

### 5. `orchestrator/src/capabilities/registry.ts` (modified)

Activated the `automatic_delivery` capability:
- State changed from `unavailable` to `enabled`
- Error code changed from `RICKGENT_DELIVERY_UNAVAILABLE` to `RICKGENT_DELIVERY_ACTIVE`
- Reason updated to describe the t34 verified push + idempotent PR protocol
- Minimum profile updated to `m8_verified_delivery`
- Proof version remains `delivery-corpus-v1`

Updated the public surface entry for `--feature`/`--no-autonomous-pr` from `public_blocked` (exit 3) to `public_local_artifact` (local_artifact_only, no exit).

Updated build/pipeline surface boundaries and result text to reflect delivery activation.

### 6. `orchestrator/src/lifecycle/pr-flow.ts` (modified)

Updated `ensureBranch` to pass the capability gate (now activated) and validate the branch name. The function no longer throws `never`; it returns `void` on success.

### 7. `orchestrator/src/cli.ts` (modified)

Updated help text for `--feature` and `--no-autonomous-pr` to reflect delivery activation.

### 8. Test updates for capability activation

- `capability-contraction.test.ts`: Updated expected state array (automatic_delivery: enabled), updated --feature/--no-autonomous-pr expectations (now pass gate, fail at PRD gate exit 2), updated ensureBranch test (now passes gate, validates branch name).
- `claims-contract.test.ts`: Updated localArtifactSurfaces list (added --feature/--no-autonomous-pr surface), updated unavailable-capability flag test (--feature now passes gate), updated help banner test (automatic_delivery no longer in unavailable list), updated capability exits test (--feature now exit 2).
- `attempt-runner-production-cutover.test.ts`: Updated expected automatic_delivery state from unavailable to enabled.

### 9. `README.md` and `docs/reliability-preview.md` (modified)

Claim matrix blocks regenerated from the updated registry to maintain byte-alignment.

### 10. `orchestrator/test/fixtures/delivery-corpus/manifest.json` (modified)

Added `pr_failures` (13 cases) and `pr_success` sections to the delivery corpus manifest.

### 11. `artifacts/reliability/delivery-corpus-summary.json` (new)

Summary artifact recording the complete proof corpus: 5 push cases, 14 PR cases, 13 negative proofs, capability activation metadata, and preserved invariants.

## Red-Then-Green Proof

**Red command:**
```
cd orchestrator && pnpm vitest run test/reliability/pr-protocol.test.ts --no-file-parallelism
```

**Red output (13 failures with stub returning infrastructure_error):**
- `creates a PR after verified push and confirms head OID equals delivery OID`: `expected 'infrastructure_error' to be 'verified'`
- `PR creation is impossible before verified push observation`: passed (stub correctly returns infrastructure_error)
- `PR from wrong repository is rejected`: `expected 'infrastructure_error' to be 'mismatch'`
- `PR head OID differs from delivery OID is rejected`: `expected 'infrastructure_error' to be 'mismatch'`
- `existing PR with wrong head is rejected`: `expected 'infrastructure_error' to be 'mismatch'`
- `missing gh command fails closed`: `expected 'infrastructure_error' to be 'infrastructure_error'` (reason mismatch)
- `provider auth failure fails closed`: `expected 'infrastructure_error' to be 'infrastructure_error'` (reason mismatch)
- `malformed provider JSON fails closed`: `expected 'infrastructure_error' to be 'infrastructure_error'` (reason mismatch)
- `provider timeout fails closed`: `expected 'infrastructure_error' to be 'infrastructure_error'` (reason mismatch)
- `independent query shows lagging head, rejected`: `expected 'infrastructure_error' to be 'mismatch'`
- `resume after crash resolves the same PR without duplicate`: `expected 'infrastructure_error' to be 'verified'`
- `repeated call resolves the same PR without duplicate creation`: `expected 'infrastructure_error' to be 'verified'`
- `PR from a different repository identity is rejected`: `expected 'infrastructure_error' to be 'mismatch'`
- `every negative case asserts run remains ready_for_delivery not delivered`: `expected 'infrastructure_error' not to be 'verified'` (passed)

**Green command:** same command after implementation.

**Green output:** `Tests 14 passed (14)` — all tests pass.

## Verification Results

| Check | Command | Exit Code | Result |
|-------|---------|-----------|--------|
| TypeScript typecheck | `pnpm typecheck` | 0 | Clean |
| Build | `pnpm build` | 0 | dist/cli.js refreshed |
| PR protocol test | `pnpm vitest run test/reliability/pr-protocol.test.ts` | 0 | 14/14 passed |
| Delivery negative test | `pnpm vitest run test/reliability/delivery-negative.test.ts` | 0 | 15/15 passed |
| Push protocol test | `pnpm vitest run test/reliability/push-protocol.test.ts` | 0 | 8/8 passed |
| Capability contraction test | `pnpm vitest run test/reliability/capability-contraction.test.ts` | 0 | 7/7 passed |
| Claims contract test | `pnpm vitest run test/reliability/claims-contract.test.ts` | 0 | 9/9 passed |
| Attempt runner cutover test | `pnpm vitest run test/reliability/attempt-runner-production-cutover.test.ts` | 0 | 6/6 passed |
| Python pytest | `python3 -m pytest test/ -p no:cacheprovider -q` | 0 | 367 passed, 3 skipped |
| Citadel | `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 | 0 CRITICAL, 0 HIGH introduced by t34 (1 pre-existing HIGH in push-protocol.test.ts from t33) |
| Doctor | `node orchestrator/dist/cli.js doctor` | 0 | automatic_delivery: state=enabled, code=RICKGENT_DELIVERY_ACTIVE, proof=delivery-corpus-v1 |
| Corpus manifest | `node -e "..."` (manifest verification) | 0 | complete=true, push_failures>0, pr_failures>0, pr_success defined |

## Invariants Preserved

- **PR creation after verified push only:** The protocol requires an existing ls-remote observation with matching OID before proceeding to PR creation.
- **Queried head OID equality:** An independent `queryPrHead` call verifies the PR head OID equals the delivery OID.
- **Repository identity equality:** The queried repository identity must equal the expected repository ID.
- **Idempotent resume:** Re-call after a PR observation exists resolves the same PR without re-creating.
- **No duplicate PRs:** Crash after create, resume resolves the existing PR; repeated calls create only one PR.
- **Fail closed:** All error paths (missing gh, auth, timeout, malformed JSON, wrong repo, wrong head, head lag) leave the run non-delivered.
- **DeliveryAuthority persistence:** All PR observations persisted through branded authority, not direct SQL writes.
- **One oracle, one matcher:** No new path matcher or completion predicate introduced.
- **argv-only execution:** The provider abstraction uses `execFileSync("gh", [...])` with array argv in production.
- **No delivered/Done on failure:** Every negative case asserts the run remains `ready_for_delivery`.

## Known Limitations

- The PR protocol uses a `PrProvider` interface abstraction; production uses `GhCliPrProvider` with `execFileSync("gh", [...])`. The protected real-provider run against a disposable GitHub remote remains in t38's scope (the protected vertical slice).
- The push and PR services are implemented as standalone protocol functions; full integration into the production build lifecycle (wiring the delivery chain end-to-end from build completion through push and PR) is t38's scope.
- The `--feature` and `--no-autonomous-pr` flags now pass the capability gate and fail at the PRD/ticket-contract gate (exit 2) when no PRD is provided. Full delivery flow wiring is t38.

## Phase Reports (t31-t34 Cumulative)

- **t31** (observed identity): `docs/remediation/phase-8-t31-observed-identity-execution-report-2026-07-22.md` — Done
- **t32** (routing + cross-vendor): `docs/remediation/phase-8-t32-routing-cross-vendor-execution-report-2026-07-22.md` — Done
- **t33** (verified push): `docs/remediation/phase-8-t33-verified-push-execution-report-2026-07-22.md` — Done
- **t34** (idempotent PR + capability activation): This report — Done

## Next Dependency Boundary

M9 (t35-t36): Unified release manifest and real CI gates. Depends on M8 (t31-t34) being complete. t35 will create one cross-language version/compatibility manifest; t36 will pin and enforce lint, typecheck, coverage, mutation, and CI thresholds.
