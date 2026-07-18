# Phase 4 Salvage and Cleanup Execution Report — 2026-07-18

## Outcome

Ticket `t21` is complete as an internal failure-ownership primitive. Failed
attempt work can now be captured as a bounded, exact, owner-attributed artifact
before attempt-owned resources are removed. Cleanup release is no longer a
caller-authored summary: it requires authoritative process death, durable
salvage, exact ref observations, physical resource absence, and the same live
cleanup owner at terminal compare-and-swap.

Production activation remains blocked on `t22`. The production runner must
still provide validated authoritative containment and wire allocation,
supervision, verification, commit attribution, salvage, cleanup, promotion,
and release in the fixed critical-section order.

## Delivered boundary

The failure path now has this order:

1. `beginCleanup` atomically moves the exact owner and all eleven v2 resource
   claims to `cleanup_pending`.
2. After the exact authoritative terminal/group-death chain exists, durable
   salvage double-observes the failed worktree and isolated index relative to
   the exact baseline with sealed Git configuration and no index mutation.
3. Capture classifies proven empty work separately from capture failure and
   records changed/untracked text, binary bytes, empty files, symlinks,
   deletions, modes, staged/index-only blobs, the exact attempt ref, and
   committed object graphs within hard bounds.
4. A deterministic content-addressed 0600 artifact is written through an
   exclusive temporary, fsynced, published, directory-fsynced, and verified
   outside the removable allocation root. Response-loss replay returns the
   exact artifact.
5. Only a runtime-branded `SalvageDispositionReceipt` can persist reserved
   `SalvageService` evidence and a `captured|empty` salvage record. Artifact
   verification uses no-follow descriptor reads, bounded size, stable identity
   and metadata, and an exact digest. The same bytes are reopened and verified
   again immediately before cleanup and inside terminal finalization.
6. `assertCleanupReady` revalidates the current unexpired cleanup owner, all
   v2 claims, authoritative t19 terminal and descendant-death evidence, the
   exact salvage record, and an attempt-ref postimage equal to either baseline
   or the finalized t20-attributed candidate before any destructive effect.
7. `CleanupService` reasserts owner freshness around effects, removes only the
   authority-derived registered worktree, compare-and-deletes only the allowed
   private attempt ref, removes the isolated index/policy/output allocation,
   and never removes the external salvage artifact.
8. Post-cleanup observation proves delivery unchanged, caller HEAD/index/dirt
   unchanged, worktree path and Git registration absent, private attempt ref
   absent, and the allocation root absent.
9. Only the runtime-branded cleanup receipt may finalize. One immediate
   transaction revalidates death, salvage, delivery, ref absence, owner expiry,
   and exact claim versions; inserts `CleanupService` evidence and the cleanup
   record; terminalizes every v2 claim; terminalizes the same owner; and records
   the immutable ownership operation.
10. A restarted `CleanupService` reconstructs its private proof from the exact
    absent-resource postimage; same-input response-loss replay returns the
    committed terminal image.
    Wrong owner, stale version, foreign ref OID, expired owner, partial cleanup,
    capture failure, or changed delivery leaves the attempt nonterminal.

## Recovery and restore

The artifact extraction path validates the artifact digest, canonical manifest,
every entry digest, all bounds, path containment, and destination emptiness
before materializing failed-work files, modes, empty files, and symlink targets.
The artifact also retains the raw isolated index, staged blob bytes, deletion
inventory, and a bounded Git bundle/commit inventory. This API is deliberately
described as delta extraction, not as a crash-atomic, baseline-aware Git restore;
an authority-owned importer is still required before production recovery may
apply deletions, import the bundle, or recreate the index.

Cleanup generations recovered after expiry may consume authoritative process
and salvage proof from their exact ownership ancestry. This closes the crash
case where salvage committed successfully but the original cleanup owner died
before physical cleanup or final release. A later generation cannot adopt
proof from an unrelated attempt or owner.

## Team findings repaired

The completion, data-flow, and reliability review found and repaired these
high-severity defects:

1. Legacy cleanup validation read frozen v1 lease/resource tables, allowing a
   current v2 attempt to appear clean while its owner and claims remained live.
2. Generic evidence and cleanup writers could describe `CleanupService` truth
   without owning the physical observation.
3. There was no terminal v2 release transaction or restart-reachable exact
   response-loss replay.
4. Patch-only salvage lost clean committed work, binary fidelity, ignored or
   empty files, and mutated the ambient Git index with intent-to-add.
5. The default archive lived below the allocation root that cleanup removes.
6. Process-death and salvage checks initially occurred only after destructive
   effects; the pre-effect readiness fence now proves both first.
7. Caller-supplied expected ref OIDs could have authorized deletion of a third
   commit; Store now admits only baseline or the finalized t20 attribution.
8. A recovery generation initially could not consume a salvage record written
   by its crashed ancestor; ownership-lineage validation now permits that exact
   replay.
9. Artifact persistence initially followed path reads and had an unbounded
   swap window; it now uses no-follow, descriptor-bound, bounded verification.
10. macOS `/var` to `/private/var` canonicalization initially rejected safe
    temporary roots; prospective paths now canonicalize from the deepest
    existing non-symlink ancestor without accepting an archive-root symlink.
11. Cleanup finalization initially omitted a final expiry check. Expired owners
    now fail even with an otherwise valid receipt.
12. Keeping the old salvage-module package exclusion broke the packed runtime
    once `LeaseAuthority` consumed its module-private receipt guard. The
    implemented module is now included as an internal package file, while the
    package export map still exposes only the root API and no production caller
    wires salvage or cleanup before t22. Receipt minting secrets remain
    module-private rather than moving to a forgeable shared factory.
13. Salvage initially was not causally fenced after process death, trusted a
    once-verified artifact, omitted staged-only work, and could omit the private
    attempt ref. The receipt and Store evidence now bind the exact death chain,
    baseline/ref/index identities, and readiness/finalization revalidate the
    content-addressed artifact.
14. Cleanup initially accepted caller-selected repository identity and used
    recursive pathname deletion. It now derives the repository from authority,
    unlinks only known regular files, removes only empty directories, and leaves
    unexpected contents under `cleanup_pending`.

## Verification evidence

| Check | Result |
|---|---|
| TypeScript typecheck | **PASS** |
| Durable salvage focused suite | **PASS** — 9/9 |
| Salvage/reconciliation compatibility | **PASS** — 12/12 |
| Adversarial salvage corpus | **PASS** — 22/22 |
| v2 ownership and real CleanupService suite | **PASS** — 17/17 |
| Packed capability boundary | **PASS** — internal salvage present, fixture authority absent, receipt forgery rejected |
| Full repository regression | **PASS** — 74 files, 1,079/1,079 tests with the required Omnigent root and interpreter |
| Diff whitespace validation | **PASS** |

The fixture inventory contains named scenarios, capabilities, payload vectors,
and 19 crash barriers. The barrier list is an inventory, not 19 injected crash
tests. Executable
crash coverage includes response loss after durable artifact publication,
cleanup-begin replay, terminal transaction replay, stale-owner recovery, and
real provisioned-resource cleanup. The remaining barrier list is the input for
the broader t29 SIGKILL/reconciliation campaign rather than a claim that t21
injects a process crash at every listed instruction.

## Residual activation gates

- `CleanupService` currently represents failure cleanup and emits
  `failed_clean`. `t22` must define the successful post-promotion cleanup mode
  instead of reusing this outcome.
- `restoreDurableSalvageArchive` is a validated delta extractor, not yet a
  crash-atomic baseline/index/ref importer. Production recovery must remain
  disconnected until an authority-owned importer is implemented and tested.
- The default t19 sampled process tracker cannot authorize release. `t22` must
  supply and validate authoritative macOS/Linux containment.
- Production callers remain disconnected. No current build path may treat the
  standalone t18–t21 primitives as an enabled attempt critical section.
- t29 still owns exhaustive instruction-level crash injection and reconciliation
  after the operational runner exists.

## Next dependency-ordered work

Proceed to `t22`: integrate the complete attempt ownership critical section,
including authoritative containment and distinct failure versus successful
cleanup semantics. Do not enable production parallelism or delivery in this
step.
