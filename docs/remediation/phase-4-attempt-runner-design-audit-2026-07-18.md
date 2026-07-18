# Phase 4 AttemptRunner Design Audit — 2026-07-18

## Outcome

Ticket `t22` is not safe to implement as a thin production wrapper. The
pre-implementation team audit found two independent stop-ship boundaries:

1. the cleanup, oracle, and promotion guards have no executable successful
   ordering; and
2. the repository has no authoritative all-descendant containment backend.

Production activation remains closed. The ticket is decomposed into state
bridge, containment, runner, and cutover gates so those prerequisites cannot be
hidden inside one large orchestration diff.

## Impossible successful ordering

The oracle requires cleanup proof while the attempt is `cleanup_pending`.
Promotion intent requires that accepted oracle. Promotion finalization then
requires cleanup to have observed the candidate delivery OID. Current cleanup
accepts only the baseline delivery OID, while Store requires cleanup's
observation to equal both the live delivery ref and durable
`runs.current_delivery_oid`. The durable OID changes only inside promotion
finalization.

Consequently cleanup-before-CAS records baseline and is rejected by promotion;
cleanup-after-CAS sees candidate while durable state still says baseline and is
rejected by cleanup; promotion cannot finalize without cleanup.

The corrected model requires distinct proofs:

- `CleanupEligibilityReceipt`: nonterminal proof for oracle input; it does not
  remove resources or release ownership.
- `SuccessfulCleanupReceipt`: exact promotion-intent/candidate-bound physical
  cleanup and compare-owner release after candidate observation.
- `FailureCleanupReceipt`: baseline-preserving failure cleanup.
- `TargetNeverReleasedReceipt`: proof that user code never crossed the start
  gate, for containment/policy/executable/output/spawn failures.
- `QuarantineReceipt`: retained-resource terminal proof, not a synonym for a
  failed deletion.

The successful order is:

```text
allocate/acquire/provision
→ authoritative containment membership
→ attempt-owned policy/context
→ supervise/review/verify
→ CommitService candidate + attribution
→ attempt/ticket cleanup_pending
→ cleanup eligibility
→ oracle
→ promotion intent
→ delivery CAS + candidate observation
→ successful cleanup + compare-owner release
→ atomic promotion/lifecycle finalization
```

## Ownership-model bridge

The t18 implementation writes `attempt_ownership_leases` and
`attempt_resource_claims`, but lifecycle start and oracle snapshots still read
the released v1 `leases` and `attempt_resources` model. Attempt-owned execution
context persistence also rejects the authority-derived detached worktree in
favor of the caller repository.

Gate t22A must cut these consumers directly to t18 state and add an
authority-minted attempt execution-context path. It must not dual-write the two
ownership models.

## Containment feasibility

`PosixProcessController` is correctly sampled-only. Process groups and exact
PID/start observations cannot close the fork/`setsid`/parent-exit sampling gap.
Its structural `authoritative_containment` fields must not be trusted from an
injected controller.

An honest containment authority owns:

1. backend probe and capability validation;
2. unique boundary creation bound to attempt/owner generation/phase;
3. target launch or trusted-bootstrap enrollment before user-code release;
4. terminate-all;
5. a bounded wait for an authoritative empty boundary;
6. a runtime-unforgeable death receipt bound to the exact launch and backend.

Linux can satisfy this with a protected delegated cgroup-v2 subtree and
`cgroup.kill` plus `cgroup.events populated=0`, or a trusted PID-namespace init.
Workers must have no ancestor/sibling migration authority, and real Linux tests
must cover rapid double-fork/`setsid` escape attempts.

This Darwin host has `launchctl` and `sandbox-exec`, but neither is an
all-descendant lifecycle container. launchd's ordinary cleanup is process-group
based and `setsid` can escape; Seatbelt is access policy rather than enumerable
membership/death authority. macOS must therefore fail before target release
unless a separately installed privileged or VM-backed authority is selected
and validated.

## Production cutover map

The only live build dispatch call is `dispatcher.dispatch` in
`orchestrator/src/lifecycle/build.ts`. Replacing that call is insufficient.
The cutover must also remove:

- shared `ReadyRunWorkspace` provisioning/finalization;
- run-worktree sampling and caller-checkout gates;
- Dispatcher-owned materialization, spawn, timeout, Git sampling, and mutation
  capture;
- legacy `TicketLock` finally release;
- post-loop conformance/deslop checks against the caller checkout.

`DispatchQueue` may remain only as sequential scheduling/diagnostic plumbing.
It cannot convert an unknown runner failure into released ownership.

## Required implementation gates

1. **t22A — State bridge:** v2 ownership/oracle/context cutover and distinct
   eligibility/cleanup/never-released/quarantine proofs.
2. **t22B — Containment:** real backend, unforgeable receipts, ProcessSupervisor
   start-gate integration, and platform corpus.
3. **t22C — AttemptRunner:** exact success/failure state machines with stable
   idempotency and crash recovery.
4. **t22D — Production cutover:** remove every legacy execution/cleanup owner,
   run the full failure matrix, and only then activate the capability.

## Product decision required before t22B completion

Choose one:

- provision and specify a validated external macOS containment authority while
  also implementing the Linux backend; or
- explicitly narrow production execution support to Linux and keep macOS as a
  pre-release `RICKGENT_CONTAINMENT_UNAVAILABLE` platform.

No TypeScript adapter can manufacture the missing kernel/deployment guarantee.
