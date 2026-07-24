# Rickgent Reliability Remediation Master Plan

## Purpose

This file is the root-level execution index for the remaining Rickgent
reliability remediation program. It does not replace the refined PRD or its
machine-checkable manifest. It summarizes the current boundary, orders the
remaining work, and points implementers and reviewers to the authoritative
contracts, acceptance criteria, proof corpora, and execution reports.

The trust-spine range `t00` through `t39` is implemented. Final public claims
are bound to `artifacts/reliability/release-proof-index.json` and
`artifacts/reliability/claim-surface-inventory.json`; historical workstream
sections below remain sequencing records, not current capability authority.

## Authority and document hierarchy

When documents disagree, use this order:

1. [Trust-spine manifest](docs/remediation/trust-spine-manifest.json) — canonical
   ticket status, dependency order, declared paths, verification commands,
   proof corpora, and output artifacts.
2. [Trust-spine PRD](docs/remediation/trust-spine-prd.md) — canonical product and
   engineering requirements, acceptance criteria, and program completion rule.
3. Machine-readable architecture contracts under
   [`docs/architecture/reliability`](docs/architecture/reliability/) — exact
   schemas, invariants, producers, state transitions, and capability states.
4. Phase design audits and execution reports under
   [`docs/remediation`](docs/remediation/) — current implementation boundary,
   discovered constraints, verification evidence, and remaining work.
5. This master plan — navigation, sequencing, and status summary only.

The original evidence and severity assessment is in the
[project completion and reliability review](docs/project-completion-reliability-review-2026-07-15.md).
The remediation artifact map and execution rules are in the
[remediation README](docs/remediation/README.md).

## Current boundary

**Current retained boundary (2026-07-23):** Local dispatch is exactly
sequential; reconciliation is the local t29 persisted-receipt/oracle profile.
The installed profile restores `resume_retry`, `cross_vendor_review`, and
`automatic_delivery` only through valid `installed_t38_retained_proof_v1`
evidence. Parallel dispatch and raw shell remain unavailable. Help, version,
and doctor remain read-only during stable proof contraction.

The proved pair is Codex CLI/OpenAI/gpt-5.6-sol implementation plus Claude
Code/Anthropic/claude-opus-4-8[1m] review. The hosted and platform scope is one
allowlisted disposable GitHub repository and one reference-platform
observation—not general hosted, provider, Darwin, Linux, or cross-platform
readiness. `ready_for_delivery` is local oracle completion; delivered is remote
OID verification; `Done` is a delivered-only alias.

Tickets `t00` through `t21` established the frozen contracts and implemented the
prerequisite ownership, state, policy, Git attribution, process supervision,
salvage, and physical-cleanup foundations. Their detailed outcomes are recorded
in the phase reports listed below.

The implemented portion of `t22A` now provides:

- t18 ownership as the current lifecycle and oracle ownership truth;
- target start gates and exact per-target disposition proof sets;
- distinct target-never-released, cleanup-eligibility, failure-cleanup,
  promotion-cleanup, and quarantine proof types;
- exact cleanup-pending ownership and eleven-claim snapshots;
- recovery-generation proof lineage;
- Oracle v2 input vocabulary and rejection of legacy cleanup/process inputs;
- full canonical ProcessSupervisor group-death validation; and
- an additive durable schema for the proof substrate.

What it does not yet provide is equally important:

- no observer-owned writer currently mints or persists the five disposition
  receipt types through an authorized production path;
- generic cleanup/finalization paths have not been replaced;
- no validated production containment backend exists;
- the single AttemptRunner has not been composed;
- legacy execution, cleanup, and workspace owners remain; and
- no current-tranche full-repository regression or production capability
  activation is claimed.

Current boundary references:

- [Phase 4 AttemptRunner state-bridge report](docs/remediation/phase-4-attempt-runner-state-bridge-report-2026-07-18.md)
- [Phase 4 AttemptRunner design audit](docs/remediation/phase-4-attempt-runner-design-audit-2026-07-18.md)
- [State and lifecycle contract](docs/architecture/reliability/state-and-lifecycle-contract.md)
- [Machine-readable state and lifecycle contract](docs/architecture/reliability/state-and-lifecycle-contract.json)

## Non-negotiable program invariants

Every remaining ticket must preserve these rules:

1. One durable authority owns each lifecycle fact. Compatibility tables may be
   read for replay, but cannot become current truth or be silently dual-written.
2. Production side effects require authority-minted, content-pinned evidence.
   Structural lookalikes, caller assertions, and labels are not authority.
3. Attempt resources are isolated by exact owner, generation, context, and
   canonical identity. Recovery may consume only its linked predecessor lineage.
4. Target release requires a validated containment authority. Sampled process
   ancestry, process groups alone, `launchd`, Seatbelt, `pidfd`, and process-table
   enumeration cannot prove all-descendant death.
5. Cleanup eligibility is nonterminal. Successful promotion requires accepted
   oracle truth, independently observed delivery state, promotion-purpose
   cleanup, and atomic finalization. Failure cleanup cannot satisfy success.
6. Missing, null, stale, conflicting, unavailable, or infrastructure-error
   evidence fails closed.
7. The caller checkout, HEAD, index, and unrelated runtime data remain unchanged.
8. Capability implementation and capability activation are separate decisions.
   Nothing is advertised or enabled before its owning proof corpus passes.
9. Tickets execute in manifest dependency order. Shared state, process, Git,
   policy, and lifecycle contracts are not edited concurrently by independent
   implementation agents.

## Dependency chain

The manifest defines a strict sequential chain:

`t21 → t22 → t23 → t24 → t25 → t26 → t27 → t28 → t29 → t30 → t31 → t32 → t33 → t34 → t35 → t36 → t37 → t38 → t39`

Do not begin a downstream production implementation merely because some of its
types or fixtures can be written early. Each ticket must satisfy its own
negative proofs, verification commands, review gate, and full-regression
obligations before the next ticket is declared complete.

## Workstream 1 — Finish the attempt ownership critical section (`t22`)

Canonical ticket: [PRD Ticket 22](docs/remediation/trust-spine-prd.md#ticket-22-integrate-the-attempt-ownership-critical-section)

### `t22A` — Complete the state bridge

Status: **partially implemented; next actionable tranche**.

Work remaining:

1. Connect real runtime observers to the five distinct receipt types:
   target-never-released, cleanup eligibility, failure cleanup, promotion
   cleanup, and quarantine.
2. Keep producer identities reserved and ensure only the owning runtime
   authority can mint each evidence schema.
3. Add narrowly branded Store commands that atomically persist each receipt,
   exact evidence, normalized members, state transition, and idempotency result.
4. Prove replay of identical inputs and conflict on any divergent postimage.
5. Replace generic cleanup finalization with purpose-specific failure,
   promotion, and quarantine transactions.
6. Require promotion finalization to consume the exact accepted oracle decision,
   independently observed candidate/delivery state, and promotion-purpose
   cleanup receipt.
7. Ensure failure and quarantine paths cannot satisfy promotion or release a
   foreign/stale owner.
8. Bind attempt-owned execution contexts and policy materialization to the
   authority-derived worktree, index, and policy claims rather than the caller
   repository or legacy run workspace.
9. Add crash-point, replay, stale-generation, forged-producer, partial-write,
   and cross-disposition negative tests.
10. Run the ticket verification contract and a current full repository
    regression; update the state-bridge report with the new evidence.

Exit gate:

- The success order is executable without circular prerequisites.
- Every failure path terminalizes or retains ownership only through its exact
  persisted disposition proof.
- No generic cleanup record or legacy v1 ownership/process row can authorize a
  current oracle or finalization decision.
- Production activation remains closed pending `t22B` through `t22D`.

### `t22B` — Implement real containment

Status: **not complete; blocked on a product/platform decision before completion**.

Work remaining:

1. Implement an authority-owned containment interface covering creation,
   membership, target release, kill, empty/death observation, and receipts.
2. Integrate containment with ProcessSupervisor and the durable target start
   gate so target code cannot begin before membership is authoritative.
3. Implement and validate a real Linux backend using a protected no-migration
   cgroup-v2 or PID-namespace boundary.
4. Add the real platform corpus for spawn failure, timeout, stubborn descendants,
   output flood, ownership loss, crash recovery, kill, and confirmed emptiness.
5. Ensure unavailable containment produces a pre-release infrastructure error
   and a target-never-released proof; never manufacture a terminal receipt.

Required product decision:

- either provision and specify a separately installed privileged/VM containment
  authority for macOS; or
- explicitly narrow production execution to Linux and make macOS fail closed
  before target release with `RICKGENT_CONTAINMENT_UNAVAILABLE`.

Decision source: [AttemptRunner design audit — product decision](docs/remediation/phase-4-attempt-runner-design-audit-2026-07-18.md#product-decision-required-before-t22b-completion)

### `t22C` — Compose the AttemptRunner

Status: **not started as a production composition**.

Work remaining:

1. Create one AttemptRunner that owns acquisition, context/policy preparation,
   containment, dispatch, supervision, attribution, review, verification,
   oracle evaluation, promotion/failure cleanup, and finalization ordering.
2. Implement exact success, ordinary failure, infrastructure failure,
   quarantine, timeout, cancellation, and recovery state machines.
3. Give every externally visible step stable idempotency keys and deterministic
   replay/conflict behavior.
4. Recover after state/process crashes solely from durable receipts and current
   authority, without treating commit prose or caller state as truth.
5. Build `attempt-critical-section.test.ts` over the full positive and negative
   failure matrix declared by the manifest.

### `t22D` — Cut production over and remove legacy owners

Status: **not started; must be last within `t22`**.

Work remaining:

1. Remove the shared/legacy run worktree from production execution.
2. Remove direct Dispatcher spawn and supervision paths.
3. Remove caller-checkout gates and caller-repository execution context.
4. Remove legacy TicketLock/finally-release and generic cleanup finalization.
5. Audit production imports and callers so the AttemptRunner is the only owner
   of execution and terminalization.
6. Run the complete ticket verification matrix and full regression.
7. Change the production capability gate only after all `t22A`–`t22D` proofs
   pass on supported platforms.

## Workstream 2 — Concurrency proof (`t23`)

Canonical ticket: [PRD Ticket 23](docs/remediation/trust-spine-prd.md#ticket-23-prove-conflicting-concurrency-isolation-without-enabling-production-parallelism)

Build the multi-process concurrency corpus for overlapping scopes, competing
owners, foreign commits, delivery-ref movement, stubborn descendants, and
output floods. Run at least 50 deterministic stress iterations with zero shared
state violations or infrastructure errors. Publish the corpus manifest and
summary artifact. Keep production parallel dispatch unavailable after the proof;
activation is a later explicit capability decision.

## Workstream 3 — One lifecycle and completion truth (`t24`–`t30`)

Canonical tickets: [PRD Tickets 24–30](docs/remediation/trust-spine-prd.md#ticket-24-implement-the-persisted-lifecycle-transition-table)

### `t24` — Persisted lifecycle transition table

Replace the boolean lifecycle scaffold with one normative phase/remediation
model and prove every legal/illegal edge.

### `t25` — Full ticket-contract propagation

Carry acceptance criteria, interfaces, scope, dependencies, contract digest,
and budgets through every prompt and receipt without lossy reconstruction.

### `t26` — Sandboxed structured gate runner

Remove `sh -c`; execute argv-only verification through the supervisor and
sandbox, producing typed, authority-owned gate results for every outcome.

### `t27` — Independent review and bounded remediation

Run fresh read-only review against immutable inputs, then enforce bounded,
structured remediation and re-review with no reviewer/worker authority collapse.

### `t28` — Shared versioned completion oracle integration

Integrate the Oracle v2 contract into the lifecycle. Require every lifecycle,
Git, process, gate, review, evidence, ownership, cleanup-eligibility, and scope
input; missing or null inputs must block completion.

### `t29` — Resume and reconciliation parity

Resume explicit runs from persisted receipts, resolve response-lost planned
retries through typed no-side-effect cleanup, and allocate later attempts only
after reconciliation. Commit messages remain non-authoritative.

### `t30` — Remove lifecycle and terminal shortcuts

Delete the implementation-only lifecycle and audit production imports/callers
until one terminal predicate and one lifecycle engine remain.

## Workstream 4 — Model identity and routing proof (`t31`–`t32`)

Canonical tickets: [PRD Tickets 31–32](docs/remediation/trust-spine-prd.md#ticket-31-make-selected-harnessmodel-control-invocation-and-persist-observed-identity)

### `t31` — Observed harness/model identity

Pass the actual selected overrides to invocation, capture independent native
session/model identity, persist it, and fail closed on missing or mismatched
receipts.

### `t32` — Routing and cross-vendor distinction

Exercise every identity mismatch and permit cross-vendor review only when the
canonical observed identities are genuinely distinct.

Relevant contract: [Omnigent compatibility and identity contract](docs/architecture/reliability/omnigent-contract.md)

## Workstream 5 — Verified delivery (`t33`–`t34`)

Canonical tickets: [PRD Tickets 33–34](docs/remediation/trust-spine-prd.md#ticket-33-implement-verified-push-with-observed-remote-oid)

### `t33` — Verified push

Push the exact delivery OID using argv-only execution and require an independent
matching `ls-remote` observation across success, rejection, timeout,
response-loss, and ref-race cases.

### `t34` — Verified idempotent pull request creation

Create or resolve a pull request only after verified push, and require queried
head OID and repository identity equality. Retries must resolve the same PR
without duplicates or false success.

## Workstream 6 — Release engineering and installed proof (`t35`–`t39`)

Canonical tickets: [PRD Tickets 35–39](docs/remediation/trust-spine-prd.md#ticket-35-unify-release-manifest-package-contents-installer-and-license)

### `t35` — Unified release contract

Create one cross-language version/compatibility manifest and align package
contents, installer behavior, runtime paths, and licensing so a clean packed
installation is possible.

### `t36` — Real quality and CI gates

Pin and enforce lint, typecheck, coverage, mutation, and CI thresholds. Mutation
runs must use disposable worktrees, and infrastructure failures must not be
reported as successful quality results.

### `t37` — Packed installation and behavioral doctor

Test only packed artifacts with no source-tree fallback. Prove CLI, bundles,
policies, native invocation behavior, capability reporting, and doctor output
from a clean install.

### `t38` — Protected real installed vertical slice

Against real compatible Omnigent, real selected models, and a disposable hosted
remote, run the complete installed path: native policy, owned commit,
independent review, gates, cleanup/oracle, verified push, and PR. Force an
interruption and resume using the same persistent state directory. The PRD
requires the protected vertical slice to complete twice.

### `t39` — Restore only proven capabilities and claims

Make runtime capability flags, CLI help, doctor, README, changelog, and
reliability documentation match the exact passed proof corpora. Every unproven
capability remains unavailable.

## Workstream 7 — Memory Graph integration (proposed)

Detailed plan: [Memory Graph integration plan](docs/integrations/memorygraph-integration-plan.md)  
Executable draft: [Memory Graph integration PRD](docs/integrations/memorygraph-integration-prd.md)

Memory Graph integration is a proposed optional extension, not yet a validated
trust-spine manifest ticket. The primary target is the local TypeScript/Bun
`memory-graph` project under `/Users/gregorydickson/memorygraph/memory-graph/`;
the hosted `memorygraph.dev` service is an optional later adapter.

The governing boundary is strict: Memory Graph is an advisory projection and
recall source, never lifecycle state, evidence authority, or a completion-oracle
input. Rickgent publishes only curated finalized outcomes through a durable
idempotent outbox after authoritative transactions commit. Recalled memories
must be project-scoped, bounded, schema-validated, redacted, treated as
prompt-injection-capable untrusted data, and content-pinned in the phase prompt
receipt. Memory Graph outage or invalid output degrades to an explicit empty
advisory snapshot without changing lifecycle correctness.

Provisional phases:

1. `MG0`: freeze the cross-repo contract, threat model, schemas, data
   classification, retention, and compatibility matrix.
2. `MG1`: add a stable JSONL machine bridge and deterministic idempotency to
   Memory Graph; close or disable upstream blockers used by Rickgent.
3. `MG2`: implement Rickgent's provider/read path, sanitized recall, and exact
   advisory prompt snapshots after `t30`/`t32` contracts are stable.
4. `MG3`: add the durable projection outbox, curated graph mapping, retries,
   dead-letter handling, and crash/response-loss proofs.
5. `MG4`: optionally add the cloud adapter only after API alignment,
   credential-safety, and cross-tenant isolation proofs.
6. `MG5`: run packed installed compatibility and degraded-mode vertical slices,
   then enable local/cloud modes independently.

Planning and the upstream bridge can proceed independently after PRD
refinement. Rickgent runtime integration must not bypass the existing `t22`–
`t39` dependency chain. Before implementation, decompose `MG0`–`MG5` into
atomic PRD tickets and extend the manifest through the validated refinement
workflow.

## Verification and release gates

For every ticket:

1. Run the exact `verification` commands and environment declared in the
   [manifest](docs/remediation/trust-spine-manifest.json).
2. Run ticket-specific positive, negative, crash, stale-authority, forgery,
   idempotency, and rollback proofs.
3. Run typecheck and diff/contract validators.
4. Run the full repository regression required by the ticket; never cite a
   previous-tranche regression as current evidence.
5. Obtain an independent fail-closed review before committing the ticket.
6. Update or add an execution report containing scope, outcome, proof counts,
   known limitations, and the next dependency boundary.
7. Commit one bounded ticket or explicitly documented tranche. Do not combine
   downstream capability activation with substrate implementation.

Program completion requires all `t00`–`t39` tickets committed in dependency
order, every owning proof corpus and full regression green, and the protected
installed-artifact vertical slice passing twice against real compatible
Omnigent and a disposable real remote using the same persistent state directory
across forced interruption/resume. Mock-only success does not satisfy completion.

## Documentation and evidence map

### Canonical planning

- [Remediation README](docs/remediation/README.md)
- [Trust-spine PRD](docs/remediation/trust-spine-prd.md)
- [Trust-spine manifest](docs/remediation/trust-spine-manifest.json)
- [Original completion/reliability review](docs/project-completion-reliability-review-2026-07-15.md)

### Architecture contracts

- [Trust-spine contract](docs/architecture/reliability/trust-spine-contract.md)
- [Machine-readable trust-spine contract](docs/architecture/reliability/trust-spine-contract.json)
- [State and lifecycle contract](docs/architecture/reliability/state-and-lifecycle-contract.md)
- [Machine-readable state and lifecycle contract](docs/architecture/reliability/state-and-lifecycle-contract.json)
- [Evidence provenance contract](docs/architecture/reliability/evidence-provenance.md)
- [Machine-readable evidence provenance contract](docs/architecture/reliability/evidence-provenance.json)
- [Ticket-contract schema](docs/architecture/reliability/ticket-contract.schema.json)
- [Omnigent compatibility and identity contract](docs/architecture/reliability/omnigent-contract.md)

### Completed-phase evidence and current boundary

- [Phase 0 baseline + manifest reconcile report](docs/remediation/phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md)
- [Phase 1 containment execution report](docs/remediation/phase-1-containment-execution-report-2026-07-15.md)
- [Phase 2 native-policy execution report](docs/remediation/phase-2-native-policy-execution-report-2026-07-16.md)
- [Phase 4 commit-attribution execution report](docs/remediation/phase-4-commit-attribution-execution-report-2026-07-17.md)
- [Phase 4 process-supervisor execution report](docs/remediation/phase-4-process-supervisor-execution-report-2026-07-17.md)
- [Phase 4 salvage/cleanup execution report](docs/remediation/phase-4-salvage-cleanup-execution-report-2026-07-18.md)
- [Phase 4 AttemptRunner design audit](docs/remediation/phase-4-attempt-runner-design-audit-2026-07-18.md)
- [Phase 4 AttemptRunner state-bridge report](docs/remediation/phase-4-attempt-runner-state-bridge-report-2026-07-18.md)

### Proposed integrations

- [Memory Graph integration plan](docs/integrations/memorygraph-integration-plan.md)
- [Memory Graph integration PRD](docs/integrations/memorygraph-integration-prd.md)

## Plan maintenance rules

- Update this file only when the dependency sequence, current boundary, product
  decision, or ticket completion state changes.
- Update the PRD when requirements or acceptance criteria change.
- Update the manifest when machine-executable status, dependencies,
  verification, paths, or artifacts change; validate it before committing.
- Update architecture contracts whenever a normative schema, authority,
  transition, producer, or capability state changes.
- Add an execution report for each completed ticket or substantial audited
  tranche rather than rewriting historical reports.
- Keep capability claims fail-closed and evidence-backed.

## Next action

Execute the remaining `t22A` observer-writer and purpose-specific finalization
tranche. Do not begin production containment integration or AttemptRunner
cutover until those Store transactions and negative proofs are complete.
