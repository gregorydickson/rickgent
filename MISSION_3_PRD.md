---
mission: 3
title: "Rickgent Mission 3 — Complete the Trust-Spine Remediation Program (t22A through t39)"
predecessor: MISSION_2_PRD.md
implements: master-plan.md
implementer: GLM 5.2, fresh session — this document is the build contract
type: reliability-remediation-completion
target_state: "All 40 trust-spine manifest tickets committed in dependency order; every owning proof corpus and full regression green; protected installed-artifact vertical slice passing twice against real compatible Omnigent and a disposable real remote using the same persistent state directory across forced interruption/resume."
goals:
  - finish the attempt ownership critical section (t22A-t22D) and cut production over
  - prove concurrency isolation without enabling production parallelism (t23)
  - collapse to one lifecycle and completion truth (t24-t30)
  - prove model identity and cross-vendor routing (t31-t32)
  - implement verified delivery (t33-t34)
  - ship release engineering and installed proof (t35-t39)
  - restore only proven capabilities and claims
design_principle: "Git-tree-truth outranks exit codes, which outrank logs, which outrank model claims. Every gate that ran zero checks did not pass. Capability implementation and capability activation are separate decisions."
composes: [docs/architecture/reliability/state-and-lifecycle-contract.md]
---

# Rickgent — Mission 3: Complete the Trust-Spine Remediation Program

> *"Morty finishes the lab. Every door has a lock with a receipt."*

## 0. Mission statement

Mission 1 built the verdict core. Mission 2 hardened the alpha scaffold into a
working autonomous platform and exposed the reliability boundary. The
2026-07-15 reliability review then defined a 40-ticket trust-spine remediation
program: tickets `t00` through `t21` froze the contracts and implemented the
prerequisite ownership, state, policy, Git attribution, process supervision,
salvage, and cleanup foundations.

**Mission 3 has one job: finish the program.** The remaining eighteen tickets
(`t22A` through `t39`) execute in strict manifest dependency order, each with
its own negative proofs, verification contract, full-regression obligation, and
independent fail-closed review gate. The mission ends when the protected
installed-artifact vertical slice passes twice against real compatible
Omnigent and a disposable real remote, and when every capability claim matches
its passed proof corpus.

**Three constraints shape the mission:**

1. **macOS is the primary platform.** The t22B containment ticket is blocked on
   a platform decision. macOS has no kernel-level all-descendant container
   (`launchd` is process-group based and `setsid` can escape; Seatbelt is access
   policy, not enumerable membership/death authority). Mission 3 begins with a
   research+decision tranche that examines real macOS containment options and
   commits to one before t22B implementation.
2. **Full program completion.** The mission scope is `t22A` through `t39` plus
   the protected vertical slice passing twice. No intermediate stop is accepted
   as completion.
3. **No capability activation without proof.** Production activation remains
   closed until the owning proof corpus passes on the supported platform.
   Capability implementation and capability activation are separate decisions.

Memory Graph integration (Workstream 7 in the master plan) is explicitly
**out of scope** for this mission. It is a proposed optional extension and will
be considered as a follow-on mission after the trust-spine is complete.

## 1. Authority and document hierarchy

When documents disagree, use this order:

1. [`docs/remediation/trust-spine-manifest.json`](docs/remediation/trust-spine-manifest.json) — canonical ticket status, dependency order, declared paths, verification commands, proof corpora, output artifacts.
2. [`docs/remediation/trust-spine-prd.md`](docs/remediation/trust-spine-prd.md) — canonical product and engineering requirements, acceptance criteria, program completion rule.
3. Machine-readable architecture contracts under [`docs/architecture/reliability`](docs/architecture/reliability/) — exact schemas, invariants, producers, state transitions, capability states.
4. Phase design audits and execution reports under [`docs/remediation`](docs/remediation/) — current implementation boundary, discovered constraints, verification evidence, remaining work.
5. [`master-plan.md`](master-plan.md) — navigation, sequencing, status summary.
6. This mission PRD — mission-level sequencing, tranche decomposition, and exit gates.

## 2. Current-state assessment

### 2.1 What is done (do not rebuild — extend)

Tickets `t00` through `t21` are evidenced complete via git history
(`pickle: t07` through `pickle: t19` commits) and the phase reports under
`docs/remediation/`. The manifest's `status` field only marks `t18`-`t21` as
`Done`; `t00`-`t17` were never updated. Mission 3 begins with a manifest
reconciliation tranche (§3.1) to fix this bookkeeping before continuing.

Implemented foundations:

| Area | Tickets | Evidence |
|---|---|---|
| Contract decisions | t00-t02 | `docs/architecture/reliability/` contracts, omnigent compatibility verifier |
| Capability kill switches, strict CLI, fail-closed aggregation | t03-t04 | CLI parsing, run aggregation |
| TicketContract normalization/hashing, sequential worktree | t05-t06 | `orchestrator/src/core/prd.ts`, fixture mutation corpus |
| Reliability-preview CLI + docs | t07 | `rickgent` CLI, doctor |
| Native policy adapter + per-attempt context + scope containment | t08-t10 | `rickgent-policies/`, scope fence |
| Policy migration + bundle composition | t11 | agent bundle `guardrails:` block |
| Durable state schema + transactional SQLite + immutable IDs | t12-t14 | state store migrations 001-003 |
| Transition authority + legacy cutover + crash recovery | t15-t17 | transition service, registry cutover, crash corpus |
| Owner-checked leases + per-attempt resource allocation | t18 | `attempt_ownership_leases`, `attempt_resource_claims` |
| POSIX process-group supervisor | t19 | `PosixProcessController`, group-death validation |
| Orchestrator-owned commit attribution | t20 | `CommitService`, attribution receipts |
| Salvage + quarantine + restore + cleanup proof | t21 | salvage/cleanup execution report |

### 2.2 What is partially implemented (the current boundary)

**t22A — state bridge (partially implemented):** lifecycle start authority and
the completion oracle now read the t18 ownership model directly. v1
`leases`/`attempt_resources` tables are no longer accepted as current ownership
truth. Migration `005_attempt_cleanup_proof_model` adds nine additive `STRICT`
state tables defining the five distinct receipt types
(target-never-released, cleanup-eligibility, failure-cleanup, promotion-cleanup,
quarantine). Branded authorities and WeakSet brands reject structural/prototype/
serialized/cross-type forgeries.

What t22A does **not** yet provide:
- no observer-owned writer currently mints or persists the five disposition
  receipt types through an authorized production path;
- generic cleanup/finalization paths have not been replaced with purpose-specific
  failure/promotion/quarantine transactions;
- promotion finalization does not yet require the exact accepted oracle
  decision, independently observed candidate/delivery state, and
  promotion-purpose cleanup receipt;
- attempt-owned execution contexts and policy materialization are not yet bound
  to the authority-derived worktree, index, and policy claims;
- crash-point, replay, stale-generation, forged-producer, partial-write, and
  cross-disposition negative tests are not yet present;
- a current-tranche full-repository regression is not claimed.

### 2.3 What is not started

- **t22B — real containment backend.** Blocked on the macOS platform decision
  (§3.2). No validated production containment backend exists.
- **t22C — AttemptRunner composition.** One runner owning the full critical
  section is not composed.
- **t22D — production cutover.** Legacy execution, cleanup, and workspace
  owners remain in production paths.
- **t23 — concurrency proof.** Multi-process stress corpus not built.
- **t24-t30 — one lifecycle and completion truth.** Boolean lifecycle scaffold
  remains; gate runner uses `sh -c`; review/worker authority not separated;
  Oracle v2 not integrated into lifecycle; resume/reconcile parity not
  implemented; lifecycle/terminal shortcuts not removed.
- **t31-t32 — model identity and routing.** Selected overrides not passed to
  invocation; observed native session/model identity not captured; cross-vendor
  distinction not exercised.
- **t33-t34 — verified delivery.** Verified push with observed remote OID not
  implemented; idempotent PR creation not implemented.
- **t35-t39 — release engineering and installed proof.** No unified release
  manifest; no real CI/mutation gates; no packed installation proof; no
  protected vertical slice; capability claims not restored to match proofs.

## 3. Workstream sequencing

The mission is organized into eight workstreams. Workstreams 0-1 are
preparatory. Workstreams 2-7 implement the remaining tickets in strict
dependency order. Each workstream lists its tickets, exit gate, and verification
obligations.

```
WS0 (manifest reconcile)
  → WS1 (t22A finish)
    → WS2 (macOS containment decision + t22B)
      → WS3 (t22C + t22D)
        → WS4 (t23)
          → WS5 (t24-t30)
            → WS6 (t31-t34)
              → WS7 (t35-t39)
                → program completion
```

No workstream begins until the previous workstream's exit gate is met. Within
a workstream, tickets execute in manifest dependency order. Parallel agents may
perform read-only analysis and independent review only; no two implementation
agents may edit shared state, process, Git, policy, or lifecycle contracts
concurrently.

## 3.1 Workstream 0 — Manifest reconciliation

**Scope:** One administrative tranche to reconcile the manifest's `status`
field with the evidenced completion of `t00`-`t17`.

**Work:**

1. Audit git history (`pickle: t07` through `pickle: t19` commits) and the
   phase reports under `docs/remediation/` to establish the exact completion
   evidence for each of `t00`-`t17`.
2. Update `docs/remediation/trust-spine-manifest.json` so each completed
   ticket's `status` field is `Done` with a `completed_at` reference to the
   commit SHA and phase report path.
3. Run the manifest validator to confirm no missing dependencies, no cycles,
   and no status/dependency contradictions.
4. Commit as one bounded administrative tranche. Do not combine with any
   implementation work.

**Exit gate:**

- Manifest `status` for `t00`-`t21` is `Done` with evidence references.
- Manifest validator passes.
- `master-plan.md` current-boundary section updated to reflect reconciled
  status.

## 3.2 Workstream 1 — Finish t22A (state bridge completion)

**Scope:** Connect real runtime observers to the five disposition receipt types
and replace generic cleanup finalization with purpose-specific transactions.

**Work:**

1. Connect real runtime observers to the five distinct receipt types:
   target-never-released, cleanup eligibility, failure cleanup, promotion
   cleanup, and quarantine. Each receipt is minted only by its owning runtime
   authority.
2. Reserve producer identities so only the owning runtime authority can mint
   each evidence schema. Structural, prototype, serialized, and cross-type
   forgeries are rejected (extend the existing WeakSet brand tests).
3. Add narrowly branded Store commands that atomically persist each receipt,
   exact evidence, normalized members, state transition, and idempotency
   result in one transaction.
4. Prove replay of identical inputs returns the same postimage; prove any
   divergent postimage on replay conflicts.
5. Replace generic cleanup finalization with purpose-specific failure,
   promotion, and quarantine transactions.
6. Require promotion finalization to consume the exact accepted oracle
   decision, independently observed candidate/delivery state, and
   promotion-purpose cleanup receipt. Failure and quarantine paths cannot
   satisfy promotion or release a foreign/stale owner.
7. Bind attempt-owned execution contexts and policy materialization to the
   authority-derived worktree, index, and policy claims rather than the caller
   repository or legacy run workspace.
8. Add negative tests: crash-point, replay, stale-generation, forged-producer,
   partial-write, and cross-disposition. Each must fail closed.
9. Run the ticket verification contract and a current full-repository
   regression. Update the state-bridge report with the new evidence.

**Exit gate:**

- The success order is executable without circular prerequisites.
- Every failure path terminalizes or retains ownership only through its exact
  persisted disposition proof.
- No generic cleanup record or legacy v1 ownership/process row can authorize a
  current oracle or finalization decision.
- All negative proofs fail closed.
- Current-tranche full regression green.
- Production activation remains closed pending `t22B` through `t22D`.

## 3.3 Workstream 2 — macOS containment decision and t22B implementation

**Scope:** Resolve the platform blocker and implement a real containment
backend. This workstream has two sub-tranches: a research+decision tranche,
then the implementation tranche.

### 3.3.1 Sub-tranche 2A — macOS containment research and decision

**Scope:** Examine real macOS containment options and commit to one in a
decision document before implementation begins.

**Candidate options to evaluate:**

1. **Apple Virtualization.framework with a Linux guest.** Run target code
   inside a Linux VM via Apple's `Virtualization.framework`. Use cgroup-v2
   (`cgroup.kill` + `cgroup.events populated=0`) or a PID-namespace init inside
   the VM as the all-descendant death authority. The macOS host adapter is a
   thin VM lifecycle + guest cgroup proxy. Supports Apple Silicon natively and
   Rosetta Linux for x86_64 guests.
2. **Apple Containerization framework (macOS 26 Tahoe, 2025+).** Apple's
   lightweight OCI container support running Linux containers in a minimal VM.
   Evaluate whether it exposes the membership/death authority the containment
   contract requires, or whether it is access-policy-only like Seatbelt.
3. **Pre-packaged Linux VM abstractions (Docker Desktop, Podman, Lima, Colima).**
   Route target execution through an existing Linux VM runtime. cgroup-v2
   inside the container provides all-descendant death. Evaluate dependency
   weight, installation burden, and whether the runtime can be treated as an
   authority (vs. an opaque external dependency).
4. **Hybrid: Linux backend now, macOS VM-backed adapter as a follow-on.**
   Implement and validate the Linux cgroup-v2 backend first. macOS fails
   closed before target release with `RICKGENT_CONTAINMENT_UNAVAILABLE` until
   a separately installed VM-backed authority is provisioned and validated.

**For each option, evaluate against the containment contract:**

- Backend probe and capability validation.
- Unique boundary creation bound to attempt/owner generation/phase.
- Target launch or trusted-bootstrap enrollment before user-code release.
- Terminate-all.
- Bounded wait for an authoritative empty boundary.
- Runtime-unforgeable death receipt bound to the exact launch and backend.
- Worker has no ancestor/sibling migration authority.
- Real corpus coverage: spawn failure, timeout, stubborn descendants, output
  flood, ownership loss, crash recovery, kill, confirmed emptiness, rapid
  double-fork/`setsid` escape attempts.

**Decision document:** Produce
`docs/decisions/macos-containment-authority.md` recording the chosen option,
the rejection rationale for the others, the supported platform matrix, the
installation/provisioning requirements, and the fail-closed behavior on
unsupported hosts. Update `docs/architecture/reliability/trust-spine-contract.md`
and its JSON companion if the supported-platform matrix changes.

**Exit gate (sub-tranche 2A):**

- Decision document committed with a clear chosen option and rejection
  rationale.
- Architecture contracts updated to reflect the chosen platform matrix.
- The decision is reviewed and accepted before implementation begins.

### 3.3.2 Sub-tranche 2B — t22B containment implementation

**Scope:** Implement the real containment backend per the decision.

**Work:**

1. Implement an authority-owned containment interface covering creation,
   membership, target release, kill, empty/death observation, and receipts.
2. Integrate containment with `ProcessSupervisor` and the durable target start
   gate so target code cannot begin before membership is authoritative.
3. Implement and validate the chosen backend (Linux cgroup-v2/PID-namespace,
   and/or the macOS VM-backed adapter per the decision).
4. Add the real platform corpus for spawn failure, timeout, stubborn
   descendants, output flood, ownership loss, crash recovery, kill, and
   confirmed emptiness.
5. Ensure unavailable containment produces a pre-release infrastructure error
   and a target-never-released proof; never manufacture a terminal receipt.

**Exit gate:**

- Containment authority passes its full positive and negative corpus.
- Unavailable containment fails closed with a target-never-released proof.
- No structural `authoritative_containment` field is trusted from an injected
  controller.
- Current-tranche full regression green.

## 3.4 Workstream 3 — Compose AttemptRunner and cut production over (t22C, t22D)

**Scope:** Compose the single AttemptRunner and remove every legacy execution
and cleanup owner.

### 3.4.1 t22C — AttemptRunner composition

**Work:**

1. Create one `AttemptRunner` that owns acquisition, context/policy
   preparation, containment, dispatch, supervision, attribution, review,
   verification, oracle evaluation, promotion/failure cleanup, and
   finalization ordering.
2. Implement exact success, ordinary failure, infrastructure failure,
   quarantine, timeout, cancellation, and recovery state machines.
3. Give every externally visible step stable idempotency keys and deterministic
   replay/conflict behavior.
4. Recover after state/process crashes solely from durable receipts and current
   authority, without treating commit prose or caller state as truth.
5. Build `attempt-critical-section.test.ts` over the full positive and negative
   failure matrix declared by the manifest.

### 3.4.2 t22D — production cutover and legacy removal

**Work (must be last within `t22`):**

1. Remove the shared/legacy run worktree from production execution.
2. Remove direct `Dispatcher` spawn and supervision paths.
3. Remove caller-checkout gates and caller-repository execution context.
4. Remove legacy `TicketLock`/finally-release and generic cleanup finalization.
5. Audit production imports and callers so the `AttemptRunner` is the only
   owner of execution and terminalization. `DispatchQueue` may remain only as
   sequential scheduling/diagnostic plumbing; it cannot convert an unknown
   runner failure into released ownership.
6. Run the complete ticket verification matrix and full regression.
7. Change the production capability gate only after all `t22A`-`t22D` proofs
   pass on supported platforms.

**Exit gate (Workstream 3):**

- `AttemptRunner` is the sole production owner of execution and
  terminalization.
- Full positive and negative failure matrix passes.
- Legacy execution/cleanup/workspace owners removed from production paths.
- Production capability gate activated only after all proofs pass.
- Current-tranche full regression green.

## 3.5 Workstream 4 — Concurrency proof (t23)

**Scope:** Prove conflicting concurrency isolation without enabling production
parallelism.

**Work:**

1. Build the multi-process concurrency corpus for overlapping scopes, competing
   owners, foreign commits, delivery-ref movement, stubborn descendants, and
   output floods.
2. Run at least 50 deterministic stress iterations with zero shared-state
   violations or infrastructure errors.
3. Publish the corpus manifest and summary artifact.
4. Keep production parallel dispatch unavailable after the proof; activation is
   a later explicit capability decision.

**Exit gate:**

- 50+ deterministic stress iterations pass with zero violations.
- Corpus manifest and summary artifact committed.
- Production parallelism remains unavailable.

## 3.6 Workstream 5 — One lifecycle and completion truth (t24-t30)

**Scope:** Collapse the boolean lifecycle scaffold to one normative model and
integrate the shared completion oracle.

**Tickets in dependency order:**

### t24 — Persisted lifecycle transition table
Replace the boolean lifecycle scaffold with one normative phase/remediation
model and prove every legal/illegal edge.

### t25 — Full ticket-contract propagation
Carry acceptance criteria, interfaces, scope, dependencies, contract digest,
and budgets through every prompt and receipt without lossy reconstruction.

### t26 — Sandboxed structured gate runner
Remove `sh -c`; execute argv-only verification through the supervisor and
sandbox, producing typed, authority-owned gate results for every outcome.

### t27 — Independent review and bounded remediation
Run fresh read-only review against immutable inputs, then enforce bounded,
structured remediation and re-review with no reviewer/worker authority
collapse.

### t28 — Shared versioned completion oracle integration
Integrate the Oracle v2 contract into the lifecycle. Require every lifecycle,
Git, process, gate, review, evidence, ownership, cleanup-eligibility, and
scope input; missing or null inputs must block completion.

### t29 — Resume and reconciliation parity
Resume explicit runs from persisted receipts, resolve response-lost planned
retries through typed no-side-effect cleanup, and allocate later attempts only
after reconciliation. Commit messages remain non-authoritative.

### t30 — Remove lifecycle and terminal shortcuts
Delete the implementation-only lifecycle and audit production imports/callers
until one terminal predicate and one lifecycle engine remain.

**Exit gate (Workstream 5):**

- One lifecycle engine, one terminal predicate.
- Oracle v2 integrated; missing/null inputs block completion.
- Gate runner is argv-only (no `sh -c`).
- Review and worker authority separated.
- Resume/reconcile use persisted receipts, not commit prose.
- Current-tranche full regression green.

## 3.7 Workstream 6 — Model identity, routing, and verified delivery (t31-t34)

**Scope:** Prove observed model identity, cross-vendor distinction, and
verified delivery.

### t31 — Observed harness/model identity
Pass the actual selected overrides to invocation, capture independent native
session/model identity, persist it, and fail closed on missing or mismatched
receipts.

### t32 — Routing and cross-vendor distinction
Exercise every identity mismatch and permit cross-vendor review only when the
canonical observed identities are genuinely distinct.

### t33 — Verified push
Push the exact delivery OID using argv-only execution and require an
independent matching `ls-remote` observation across success, rejection,
timeout, response-loss, and ref-race cases.

### t34 — Verified idempotent pull request creation
Create or resolve a pull request only after verified push, and require queried
head OID and repository identity equality. Retries must resolve the same PR
without duplicates or false success.

**Exit gate (Workstream 6):**

- Observed identity captured and persisted for every invocation.
- Cross-vendor review permitted only on genuine identity distinction.
- Verified push requires independent `ls-remote` match.
- PR creation/retry is idempotent with no duplicates or false success.
- Current-tranche full regression green.

## 3.8 Workstream 7 — Release engineering and installed proof (t35-t39)

**Scope:** Ship the unified release, prove clean installation, and pass the
protected vertical slice twice.

### t35 — Unified release contract
Create one cross-language version/compatibility manifest and align package
contents, installer behavior, runtime paths, and licensing so a clean packed
installation is possible.

### t36 — Real quality and CI gates
Pin and enforce lint, typecheck, coverage, mutation, and CI thresholds.
Mutation runs must use disposable worktrees, and infrastructure failures must
not be reported as successful quality results.

### t37 — Packed installation and behavioral doctor
Test only packed artifacts with no source-tree fallback. Prove CLI, bundles,
policies, native invocation behavior, capability reporting, and doctor output
from a clean install.

### t38 — Protected real installed vertical slice
Against real compatible Omnigent, real selected models, and a disposable
hosted remote, run the complete installed path: native policy, owned commit,
independent review, gates, cleanup/oracle, verified push, and PR. Force an
interruption and resume using the same persistent state directory. **The PRD
requires the protected vertical slice to complete twice.**

### t39 — Restore only proven capabilities and claims
Make runtime capability flags, CLI help, doctor, README, changelog, and
reliability documentation match the exact passed proof corpora. Every unproven
capability remains unavailable.

**Exit gate (Workstream 7 and program completion):**

- Unified release manifest committed; clean packed installation possible.
- Real CI/quality/mutation gates enforced; infrastructure failures not masked
  as success.
- Packed installation behavioral doctor passes from a clean install.
- Protected vertical slice passes **twice** against real compatible Omnigent
  and a disposable real remote, using the same persistent state directory
  across forced interruption/resume.
- Every capability claim matches its passed proof corpus; every unproven
  capability remains unavailable.

## 4. Non-negotiable program invariants

Every ticket in this mission must preserve these rules:

1. **One durable authority owns each lifecycle fact.** Compatibility tables may
   be read for replay, but cannot become current truth or be silently
   dual-written.
2. **Production side effects require authority-minted, content-pinned
   evidence.** Structural lookalikes, caller assertions, and labels are not
   authority.
3. **Attempt resources are isolated by exact owner, generation, context, and
   canonical identity.** Recovery may consume only its linked predecessor
   lineage.
4. **Target release requires a validated containment authority.** Sampled
   process ancestry, process groups alone, `launchd`, Seatbelt, `pidfd`, and
   process-table enumeration cannot prove all-descendant death.
5. **Cleanup eligibility is nonterminal.** Successful promotion requires
   accepted oracle truth, independently observed delivery state,
   promotion-purpose cleanup, and atomic finalization. Failure cleanup cannot
   satisfy success.
6. **Missing, null, stale, conflicting, unavailable, or infrastructure-error
   evidence fails closed.**
7. **The caller checkout, HEAD, index, and unrelated runtime data remain
   unchanged.**
8. **Capability implementation and capability activation are separate
   decisions.** Nothing is advertised or enabled before its owning proof
   corpus passes.
9. **Tickets execute in manifest dependency order.** Shared state, process,
   Git, policy, and lifecycle contracts are not edited concurrently by
   independent implementation agents.
10. **Git-tree-truth > exit code > logs > model claims.** A worker/CLI saying
    "done" is not evidence.
11. **Silence is not success.** A gate that ran zero checks did not pass.
12. **One oracle, one matcher.** Reuse `isPathInScope` for all path-scoping
    logic. Never a second matcher or parallel verdict.
13. **Abstain (`None`) for inapplicable policies, never `ALLOW`.**
14. **Fail closed, everywhere.** No bypass flags in production.
15. **No new runtime dependencies** without a decision doc. `omnigent` is
    pinned at 0.6.0.dev0 and READ-ONLY.
16. **Edit scope:** write only inside `rickgent/`. `omnigent/` is read-only;
    `pickle-rick-claude/` is a live pipeline, access the legacy reference ONLY
    via `git -C <repo> show 95f5c416:<path>`.
17. **Owned-paths-only git staging.** Never `git add -A`. Use
    `execFileSync("git", ["add", "--", path])` with array argv.
18. **Verify at the production entrypoint**, not just helper level.
19. **Use `execFileSync` with array argv.** Never shell strings for spawning
    processes.
20. **Use `set -o pipefail` in shell pipelines.**

## 5. Per-ticket verification and review gates

For every ticket in this mission:

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

## 6. Testing and verification commands

```bash
# TypeScript (run from orchestrator/)
export PATH="/Users/gregorydickson/.nvm/versions/node/v24.13.1/bin:/Users/gregorydickson/.local/share/pnpm:$PATH"
pnpm typecheck
pnpm vitest run --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism

# Python (run from rickgent-policies/)
python3 -m pytest test/ -p no:cacheprovider
```

`--no-file-parallelism` is required: vitest module-isolation races under high
concurrency contaminate cross-file state. Always prefix piped validator
commands with `set -o pipefail` so the true exit code is preserved.

`pnpm lint` (eslint) is intentionally unconfigured and out of scope. Do not
attempt to fix or run it.

## 7. Program completion rule

Program completion requires all `t00`-`t39` tickets committed in dependency
order, every owning proof corpus and full regression green, and the protected
installed-artifact vertical slice passing twice against real compatible
Omnigent and a disposable real remote using the same persistent state
directory across forced interruption/resume. Mock-only success does not
satisfy completion.

## 8. Mission exit criteria

The mission is complete when **all** of the following are true:

1. Manifest `status` for `t00`-`t39` is `Done` with evidence references.
2. The macOS containment decision is committed and the chosen backend is
   implemented and validated against its full corpus.
3. The `AttemptRunner` is the sole production owner of execution and
   terminalization; every legacy execution/cleanup/workspace owner is removed.
4. Concurrency proof passes 50+ deterministic stress iterations with zero
   violations; production parallelism remains unavailable.
5. One lifecycle engine, one terminal predicate, one completion oracle; gate
   runner is argv-only; review/worker authority separated; resume/reconcile
   use persisted receipts.
6. Observed model identity captured and persisted; cross-vendor review
   permitted only on genuine distinction.
7. Verified push and idempotent PR creation implemented and proven.
8. Unified release manifest committed; real CI/quality/mutation gates
   enforced; packed installation behavioral doctor passes from a clean install.
9. Protected vertical slice passes **twice** against real compatible Omnigent
   and a disposable real remote with forced interruption/resume using the same
   persistent state directory.
10. Every capability claim (CLI help, doctor, README, changelog, reliability
    docs) matches its passed proof corpus; every unproven capability remains
    unavailable.
11. `master-plan.md` current-boundary section updated to reflect program
    completion.

## 9. Next action

Begin Workstream 0 (manifest reconciliation). Do not begin Workstream 1
(t22A finish) until the manifest is reconciled and validated. Do not begin
Workstream 2 (macOS containment decision) until t22A's observer-writer and
purpose-specific finalization tranche is complete and its negative proofs pass.
