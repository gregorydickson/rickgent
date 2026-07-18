# Phase 4 Attempt Runner State Bridge Report — 2026-07-18

## Outcome

The first executable tranche of `t22A` is complete: lifecycle start authority
and the completion oracle now read the t18 ownership model directly. The
released v1 `leases` and `attempt_resources` tables are no longer accepted as
current ownership truth by either consumer, and production does not dual-write
them.

This is not completion of `t22` or of all `t22A` work. Production activation
remains closed. The distinct target-never-released, cleanup-eligibility,
failure-cleanup, promotion-cleanup, and quarantine proof model still has to
remove the cleanup/oracle/promotion cycle documented by the t22 design audit.

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
| Store-owned oracle focused suite | **PASS** — 7/7 |
| Full repository regression | **PASS** — 74 files, 1,079/1,079 tests |
| Diff whitespace validation | **PASS** |

The full regression used the required Omnigent root and Python interpreter.
Production capability claims and the legacy build boundary remain unchanged.

## Remaining dependency-ordered work

1. Complete `t22A` with durable, non-interchangeable proof types for targets
   never released, oracle eligibility, failure cleanup, promotion cleanup, and
   quarantine; then prove an executable success order without circular
   preconditions.
2. Complete `t22B` only against a real containment authority. Linux can use a
   validated protected cgroup-v2 or PID-namespace backend. macOS requires a
   separately installed privileged/VM authority, or the supported production
   platform contract must be narrowed so macOS fails before target release.
3. Compose `AttemptRunner` in `t22C` and remove every legacy execution and
   cleanup owner in `t22D` before changing the production capability gate.

