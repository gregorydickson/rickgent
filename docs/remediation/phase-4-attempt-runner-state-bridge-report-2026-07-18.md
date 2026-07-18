# Phase 4 Attempt Runner State Bridge Report — 2026-07-18

## Outcome

The first executable tranche of `t22A` is complete: lifecycle start authority
and the completion oracle now read the t18 ownership model directly. The
released v1 `leases` and `attempt_resources` tables are no longer accepted as
current ownership truth by either consumer, and production does not dual-write
them.

This is not completion of `t22` or of all `t22A` work. Production activation
remains closed. A second internal tranche now defines the distinct
target-never-released, cleanup-eligibility, failure-cleanup, promotion-cleanup,
and quarantine proof model, but its observer-owned writers and terminal
promotion/failure cutover are not yet connected.

## Delivered boundary

1. Attempt start requests carry a t18 `ownershipId`, not a v1 `leaseId`.
2. Start authority requires the exact attempt's current live, unexpired,
   non-recovery ownership with the matching canonical context digest.
3. Start authority requires all eleven fixed t18 resource kinds under that
   owner: delivery ref, attempt ref, worktree, isolated index, policy context,
   policy bundle, process group, stdout, stderr, verification output, and
   salvage archive.
4. Oracle resolution reads `attempt_ownership_leases` and
   `attempt_resource_claims` exclusively for ownership snapshots.
5. Terminal cleanup finalization mints exact immutable snapshots of every t18
   ownership and resource row in the same transaction as terminal ownership.
6. Snapshot evidence is reserved to `LeaseAuthority`, uses v2 schemas, pins the
   complete canonical row and digest, and replays only an identical immutable
   postimage.
7. Oracle reference validation requires both the exact v2 schema and
   `LeaseAuthority` producer. A caller-authored lookalike fails closed.

## Cleanup-proof model tranche

Migration `005_attempt_cleanup_proof_model` adds nine additive `STRICT` state
tables without rewriting a released migration:

1. `target_start_gates` records the durable CAS distinction between held,
   released, and closed-never-released target execution. A never-released
   member represents either a process that was never created or a bootstrap
   process whose exact containment was authoritatively observed dead.
2. `attempt_target_proof_sets` and `attempt_target_proof_members` seal one
   exact member for every gate or launch phase. A complete set rejects held,
   live, orphan, omitted, duplicate, and unproven targets.
3. `cleanup_eligibility_records` pins the nonterminal oracle preimage: exact
   ownership generation/version/context, finalized commit intent and
   attribution, baseline/candidate/ref observations, authoritative terminal
   process or target-never-released proof, and all twelve immutable t18
   snapshots (one owner plus eleven claims).
   A recovery owner may consume only proof from its recursively linked
   predecessor execution lineage; unrelated generations cannot reuse it.
4. `failure_cleanup_records`, `promotion_cleanup_records`, and
   `quarantine_records` separate terminal meanings that must never be
   interchangeable.
5. `quarantine_claim_sets` and `quarantine_claim_members` normalize all eleven
   terminal claims and derive absent, retained, unknown, and not-applicable
   inventory without contradictory absence claims.
6. Five runtime receipt classes use distinct private constructor authorities
   and WeakSet brands. Structural, prototype, serialized, and cross-type
   forgeries are rejected. They intentionally have no public minting seam yet.
7. Oracle v2 no longer requires a terminal generic cleanup record or legacy v1
   process receipts. It consumes one sealed-complete target-proof set and one
   sealed `CleanupEligibilityService` record, verifies their durable joins and
   digests, and independently checks every pinned owner/claim snapshot against
   the exact cleanup-pending preimage.

The executable success order is therefore no longer circular at the contract
and oracle-read layers: candidate attribution and terminal-process proof lead
to cleanup eligibility; oracle acceptance can then lead to promotion, followed
by promotion-purpose cleanup and finalization. The last two edges still need
their observer-owned writers and Store transactions before this is a runnable
production path.

## Compatibility behavior

Already-completed attempts that contain only v1 lease/resource evidence are not
silently upgraded. Oracle evaluation fails closed until those attempts are
migrated by an explicit authority-owned migration or rerun through the v2
ownership path. This is intentional: reconstructing authority from legacy rows
would reintroduce the split-brain model this tranche removes.

Legacy v1 tables remain present because existing read-only compatibility and
fixture paths still exercise them. They are not written by the new production
bridge and are not consulted for t18 lifecycle start or oracle ownership truth.

## Verification evidence

| Check | Result |
|---|---|
| TypeScript typecheck | **PASS** |
| Transition authority focused suite | **PASS** — 32/32 |
| Oracle authority suite | **PASS** — 14/14 |
| Store-owned oracle integration suite | **PASS** — 11/11 |
| Cleanup disposition authority suite | **PASS** — 13/13 |
| State contract validator suite | **PASS** — 65/65 |
| State-store migration suite | **PASS** — 21/21 |
| Previous-tranche full regression baseline | **PASS** — 74 files, 1,079/1,079 tests |
| Diff whitespace validation | **PASS** |

The current tranche's focused gate is 124/124. The listed full regression is
the immediately preceding committed-tranche baseline; a current-tranche full
regression is not claimed. Production capability claims and the legacy build
boundary remain unchanged.

## Remaining dependency-ordered work

1. Complete `t22A` by connecting real observers to the five receipt types,
   reserving their evidence producers, persisting each record only through a
   narrowly branded Store command, replacing generic cleanup finalization, and
   making promotion finalization require a promotion-purpose cleanup receipt.
2. Complete `t22B` only against a real containment authority. Linux can use a
   validated protected cgroup-v2 or PID-namespace backend. macOS requires a
   separately installed privileged/VM authority, or the supported production
   platform contract must be narrowed so macOS fails before target release.
3. Compose `AttemptRunner` in `t22C` and remove every legacy execution and
   cleanup owner in `t22D` before changing the production capability gate.
