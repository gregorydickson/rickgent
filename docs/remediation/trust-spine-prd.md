# Rickgent Reliability Trust-Spine Remediation — Refined PRD

## Title: Rickgent Reliability Trust-Spine Remediation

## Source, authority, and execution baseline

This document refines `prd.md` using the requirements, codebase, and risk analyst reports plus the repository evidence report at `docs/project-completion-reliability-review-2026-07-15.md`.

The evidence review describes repository commit `6c9eee8689f9d6e8a5cb63f1a9335f0e98b18834`; that SHA is historical provenance, not a required implementation HEAD and not an external dependency pin. The evidence report is currently untracked and must be intentionally adopted by ticket `t01` before clean worktrees may rely on it.

Implementation uses the guaranteed Pickle Rick Codex v1 path: sequential, non-interactive `codex exec --full-auto` tickets in the shared development checkout. Product worktrees, process groups, and concurrency are Rickgent features implemented and tested in disposable repositories; implementation agents do not create an independent ticket branch or depend on native multi-agent fanout.

The executable decomposition is `refinement_manifest.json`. It is authoritative for ticket dependencies, exact verification commands, required environments, artifacts, proof corpora, and the evolving external-system contract.

## Analyst disagreement resolutions

1. **Milestone 1 versus Milestone 4 isolation:** Milestone 1 creates one clean, dedicated run worktree and delivery ref before any product worker mutation. Milestone 4 replaces that interim seam with a per-attempt worktree/ref/index/lease/process-group ownership model. Until Milestone 2 proves native policy enforcement, public autonomous mutation remains unavailable; only fixture/infrastructure execution is allowed.
2. **`Done` versus disabled delivery:** `ready_for_delivery` is local oracle completion after the ticket commit has been integrated into the run delivery ref and all cleanup is verified. `delivered` is a run-level state supported only by observed push and PR-head evidence. Public `Done` is an alias only for `delivered`; no Milestone 1–5 path may emit it. An explicitly named local-verification mode may return zero for `ready_for_delivery` without claiming delivery.
3. **Raw shell versus commit and verification:** an untrusted model receives no raw shell. The orchestrator owns a narrow staging/commit service. Acceptance checks use structured argv inside a proven POSIX sandbox through the common process supervisor; legacy `sh -c` strings are rejected, not grandfathered.
4. **Worker versus manager bundle:** production ticket phases spawn an attempt-specific materialization of the structured-tool worker template directly. The manager bundle is not a mutation authority. A model never creates the authoritative Git commit.
5. **SQLite choice:** use Node's `node:sqlite`, already compatible with the required Node runtime, with numbered migrations and one transactional authority. JSON/JSONL/lock state is diagnostic legacy data only and cannot create terminal state.
6. **Git promotion:** accepted tickets form a sequential fast-forward chain. An attempt begins at the current run delivery OID; its final owned commit is promoted with compare-and-swap only if the delivery ref still equals that baseline. A moved ref or conflict requires a new attempt.
7. **No-op behavior:** no-op is unsupported in this remediation. An unchanged tree cannot satisfy a ticket or count toward completion. A future no-op mode requires a separate product contract.
8. **Review independence before cross-vendor restoration:** Milestone 5 requires a fresh process/conversation, a reviewer role, immutable diff input, and a read-only tool set. It may use the same effective model and must not be described as cross-vendor. Cross-vendor claims return only after Milestone 6 identity proof.
9. **External Omnigent contract:** Omnigent is an evolving external system. Ticket `t00` must decide and record the current-compatible mounted/installed contract, required seams, version probe, policy config encoding, and independently observed identity source before consumers execute. The plan does not invent a sibling SHA. `freeze_contract.sha_source` is intentionally absent unless `t00` explicitly concludes that exact commit pinning is a product requirement.
10. **Platform support:** the remediation supports POSIX macOS and Linux. Startup fails with a stable unsupported-platform error on Windows until equivalent worktree, sandbox, signal, and process-ownership proofs exist.

## Goal

Deliver one trustworthy vertical slice:

```text
strict normalized TicketContract
  -> immutable run/ticket/attempt context
  -> requested harness/model reaches Omnigent
  -> native FunctionPolicy enforcement
  -> attempt-owned worktree/ref/index/lease/process group
  -> orchestrator-owned scope-clean descendant commit
  -> independent review and bounded remediation
  -> blocking sandboxed gates and convergence
  -> one versioned completion oracle
  -> verified cleanup and fast-forward delivery ref
  -> observed remote push OID and matching PR head OID
  -> durable restart-safe transactional state
```

## Non-goals

- New toolbelt breadth before the trust spine is complete.
- Preserving unsafe undocumented internal APIs or permanent old/new orchestration paths.
- Enabling raw shell by default.
- Treating mocked fixtures, direct policy-handler calls, report-text regexes, or ledger labels as release evidence.
- Rewriting sound pure verdict logic or safe array-argv Git helpers without contradictory evidence.
- Claiming Windows support without equivalent ownership tests.
- Requiring parallel dispatch or reconciliation for the release vertical slice; those capabilities may remain unavailable.

## Normative vocabulary and state model

- **Repository identity:** the realpath of the target repository plus its canonical Git common directory. State is resolved from this identity, never caller CWD.
- **Run:** one immutable execution of one normalized PRD/manifest against one repository and delivery baseline. An ordinary build always allocates a new run ID.
- **TicketContract:** a versioned, strictly normalized ticket record whose canonical JSON digest is part of all attempt identity and evidence.
- **Attempt:** one immutable `(run_id, ticket_id, attempt_number)` allocation. Retry commits a new attempt number before any resource acquisition or spawn.
- **ExecutionContext:** immutable orchestrator-owned values for repository/state roots, run/ticket/attempt, phase/role, contract digest, scope, bundle digest, selected model identity, budgets, timeout, and capability snapshot.
- **Lease:** an owner-token-protected claim over an attempt. Acquisition, heartbeat, stale-owner recovery, and compare-owner release are transactional.
- **Receipt/evidence:** immutable, content-hashed data with producer, attempt, phase, context digest, creation time, schema version, and source-specific fields. Missing, stale, conflicting, unknown-version, or infrastructure-error evidence is not green.
- **Oracle-complete:** the versioned pure completion oracle accepted all required persisted inputs.
- **Ready for delivery:** the accepted ticket commit is on the run delivery ref, cleanup is verified, and ownership is released. It is not remote delivery.
- **Delivered:** every planned ticket is ready, push intent and observed remote OID match the delivery OID, PR head equals that OID, and delivery cleanup succeeded.
- **Cleanup pending:** nonterminal state retained after timeout, crash, failure, or success until all descendants are dead, salvage/promotion is settled, and resource absence is verified.
- **Unavailable capability:** a typed default-off state with a stable reason/code that cannot be overridden by CLI flags, stale config, environment variables, or direct library calls.

### Terminal-state rules

- Attempts may terminate as `failed_clean`, `quarantined`, or `verified`; timeout itself is never terminal.
- Tickets may become `ready_for_delivery` only through the shared oracle/finalization service.
- Runs may become `delivered` only through the delivery service after all planned tickets are ready.
- `failed`, `quarantined`, `delivery_failed`, and cleanup failure produce nonzero CLI status.
- Required gate values `missing`, `null`, `skipped`, `unavailable`, `infrastructure_error`, `stale`, or `conflicting` all block advancement.
- Workers, phase runners, reconcile, status, and CLI handlers have no API that directly writes `ready_for_delivery`, `delivered`, or `Done`.

## Temporary supported contract by milestone

| Boundary | Enabled behavior | Required unavailable behavior |
|---|---|---|
| After M1 | strict CLI/capabilities, fail-closed aggregation, strict ticket normalization, one dedicated run worktree for fixtures | public autonomous mutation, resume, reconcile, parallelism, raw shell, push/PR |
| After M2 | sequential local mutation through direct structured worker bundle with native policy enforcement | terminal success, resume, parallelism, cross-vendor, push/PR, raw shell |
| After M3 | transactional identity/state and internal structured recovery exercises | public resume until lifecycle/oracle parity is proven; reconcile remains unavailable |
| After M4 | per-attempt Git/process/lease ownership and safe cleanup; concurrency proof may run through fixture APIs | production parallelism remains default-off pending explicit activation |
| After M5 | real persisted lifecycle can produce `ready_for_delivery`; authoritative resume can be activated after parity proof | remote delivery, cross-vendor claims, raw shell |
| After M6 | only capabilities whose restoration corpus passed; real push/PR for the release profile | any unproven claim remains unavailable and documented as such |

## Capability registry

One production registry is consumed by CLI parsing, context resolution, library entry points, `doctor`, and docs checks. It contains at least:

- `autonomous_dispatch`
- `parallel_dispatch`
- `resume_retry`
- `reconciliation`
- `cross_vendor_review`
- `automatic_delivery`
- `raw_shell`

Each entry has `state: unavailable|fixture_only|enabled`, a stable error code, a reason, the proof-corpus version that permits enablement, and the minimum runtime profile. Test-only bypass injection exists only through explicit dependency injection in test builds; production ignores/rejects `RICKGENT_SKIP_*` variables.

## Architecture contracts

### 1. Strict TicketContract

The executable schema is canonical JSON, not tolerant Markdown inference. It includes:

- explicit unique `id`, title, description, schema version, dependencies, and dependency cycle validation;
- ticket-specific AC IDs, interface/ownership assertions, and structured verification specs;
- canonical repository-relative scope declarations with explicit directory semantics and allowed create/modify/delete/rename kinds;
- rejection of empty scope, absolute/traversing paths, `.git`/state roots, escaping declarations, submodules, duplicate IDs, unknown ACs, cycles, and unsafe overlapping active scopes;
- verification entries `{id, executable, args[], cwd_class, env_allowlist[], timeout_ms, network, writable_outputs[]}`; no shell source text;
- explicit budgets and remediation limit;
- deterministic RFC-8785-equivalent canonical serialization and `sha256` digest; a changed executable field makes stored attempts incompatible.

The normalizer rejects ambiguity before run allocation. Prompt rendering carries the complete contract and digest, not only description/paths.

### 2. Omnigent native policy boundary

Ticket `t00` records the current-compatible external ABI. The intended in-repository design is:

1. TypeScript writes an immutable mode-0600 attempt context under the canonical state root and records its digest/owner token.
2. `PolicyBundleMaterializer` copies the worker template outside the target worktree and injects string-compatible config fields referencing that context and digest.
3. The supervisor injects the same digest as a final, non-user-overridable spawn value.
4. Python policy code loads only the orchestrator-owned config/reference, verifies ABI/context versions, canonical roots, ownership/digest, and attempt binding, and ignores agent-controlled `event.context` for authoritative identity.
5. One adapter normalizes native `{type,target,data,context,session_state,...}` into a discriminated `CanonicalPolicyEvent`. Unknown tool, malformed data, duplicate/conflicting fields, absent/untrusted config, replay, and unsupported versions have named fail-closed denial codes.
6. A well-formed unrelated event may abstain; no policy returns authority merely because it did not recognize malformed input.

Every policy attached by manager and worker bundles—including builtin composition—is tested through real Omnigent `FunctionPolicy` behavior. A denial test must prove the target tool did not execute.

### 3. Transactional state

State defaults to `<canonical-git-common-dir>/rickgent/state.sqlite3`, with directories/files mode 0700/0600. Symlinked or unsafe roots fail closed. `--repo` determines identity; caller CWD is irrelevant.

Numbered SQLite migrations include tables for schema metadata, repositories, runs, ticket contracts, attempts, phase transitions, leases, resources, process receipts, immutable evidence, gate results, review/remediation, commit attribution, cleanup/salvage, oracle decisions, delivery intents, remote observations, and PR observations. Minimum constraints include:

- unique run IDs and unique `(run_id,ticket_id,attempt_number)`;
- foreign keys enabled and checked;
- compare-and-set transition sequence/version;
- one live lease/resource set per attempt and owner-token compare release;
- unique immutable evidence ID/content hash and idempotency keys;
- transaction boundaries for run creation, attempt allocation, transition+receipt, lease acquire/release, oracle decision, promotion finalization, and delivery finalization;
- explicit WAL/busy timeout/durability policy and hard errors for corruption/future schema.

Legacy registry JSON, dispatch JSONL, locks, salvage/intervention ledgers, and Git subjects are quarantined/read-only diagnostic inputs. They cannot import `Done` or terminal evidence. No long-lived dual writes are allowed.

### 4. Attempt resource and Git ownership

The acquisition/finalization order is fixed:

1. transactionally allocate attempt and owner token;
2. acquire owner-checked lease;
3. create and verify attempt ref/worktree/isolated index from the current delivery OID;
4. materialize policy/model context;
5. spawn each phase in a new process group with bounded output;
6. observe exit and kill every descendant on timeout;
7. collect review/gate/evidence and create the final orchestrator-owned commit;
8. remove the worktree while retaining the commit/ref, verify cleanup, and run the oracle;
9. compare-and-swap fast-forward the run delivery ref from the recorded baseline to the accepted commit;
10. delete/quarantine remaining attempt resources, verify absence, release lease, and finalize `ready_for_delivery` transactionally.

The worker cannot invoke Git mutation. The commit service stages only normalized owned paths and creates the final acceptance commit. It records baseline, parent, tree, commit OID, contract/context digests, exact changed paths/kinds/modes, and attribution. It rejects dirty caller input, unexpected worktree/index dirt, foreign/out-of-scope delta, unexpected delete/rename, submodule changes, non-descendant ancestry, multiple unowned commits, or a moved delivery ref.

### 5. Process supervisor and sandbox

One POSIX supervisor owns worker, reviewer, remediation, verification, and integration subprocesses. It uses array argv, a new process group/session, allowlisted environment, capped stdout/stderr files with size/hash/bounded tail receipts, TERM grace then KILL escalation, confirmed group death, and explicit spawn/timeout/infrastructure outcomes. Lease ownership persists through process death and cleanup.

Verification uses the same supervisor plus the sandbox backend selected by the contract decision: `sandbox-exec` on supported macOS or `bwrap` on supported Linux, with network denied, credentials absent, target inputs read-only where possible, explicit writable output/temp paths, Git common dir/ref/index denied, and resource/output limits. Missing sandbox support is `infrastructure_error`, never a skipped or passed gate.

### 6. Persisted lifecycle

The one normative transition table is:

```text
planned
  -> implementing
  -> implementation_captured
  -> reviewing
      -> verification_queued                       (accept)
      -> remediating -> remediation_captured -> reviewing  (reject, budget remains)
      -> cleanup_pending -> failed_clean|quarantined        (reject, budget exhausted)
  -> verifying
  -> converging
  -> cleanup_pending
  -> oracle_evaluation
  -> ready_for_delivery
```

Every process phase has start/finish receipts. Review runs in a fresh process/conversation over immutable baseline/diff/contract inputs with read-only tools and a structured verdict. Remediation is bounded by the TicketContract and returns to fresh review. A failure edge always enters cleanup; restart resumes from persisted receipts and reuses idempotent work only when schema, oracle, context, and contract digests match.

### 7. Completion oracle

The pure versioned oracle consumes only persisted, content-hashed inputs:

- normalized TicketContract and dependency completion set;
- immutable ExecutionContext/capability snapshot;
- attempt workspace/baseline/resource/lease receipts;
- phase and independent-review receipts;
- required acceptance, compile, typecheck, lint, unit, integration, scope, evidence, conformance, convergence, and cleanup gate results;
- final commit attribution/ancestry/tree/scope receipt;
- process-group death and worktree/resource cleanup proof;
- model identity receipt when the active profile requires it;
- delivery evidence only for the run-level delivery oracle.

The ticket oracle returns a typed decision and missing/failed input list; it does not mutate state. The transition service persists the oracle version/input digest/output and is the sole terminalization route. Live execution, resume, retry diagnostics, and any future structured reconciliation call the same oracle. Oracle version drift requires explicit re-evaluation, never implicit reuse.

### 8. Model identity and review distinction

Canonical identity contains harness, provider/vendor, model ID, bundle/config digest, role, session/conversation ID, and receipt provenance. Requested selection, actual array argv/materialized config, and independently observed native session receipt are separate producers. Alias normalization is explicit in the `t00` compatibility artifact. Missing or unequal identity blocks completion. Transcript prose and router/ledger labels are not observation.

Cross-vendor review requires separately observed implementer/reviewer identities and the distinction rule selected in `t00`; a distinct process alone satisfies independent review but not cross-vendor review.

### 9. Delivery and release

After every planned ticket is ready and cleanup is verified:

1. record immutable delivery OID, remote, branch, expected old remote OID, and intent;
2. execute array-argv `git push origin <delivery_oid>:refs/heads/<branch>` without force;
3. observe `git ls-remote` and require exact OID equality;
4. create or idempotently resolve the PR using structured `gh` JSON;
5. independently query PR repository/head OID and require equality with delivery OID;
6. persist delivery receipts and only then mark the run delivered.

Missing origin, wrong repository, auth failure, non-fast-forward rejection, stale ref, `gh` failure, existing wrong-head PR, head lag, crash, or cleanup failure leaves the run non-delivered and nonzero. Push/PR retry is idempotent from persisted intent/observations.

One release manifest generates/checks npm, Python, CLI, build identity, Omnigent compatibility, Node/Python/pnpm/platform support, package contents, and docs version. Packed-artifact tests may not fall back to source checkout.

## Verification environment and proof contracts

- TypeScript baseline after the toolchain contract lands: `cd orchestrator && pnpm typecheck` and `cd orchestrator && pnpm test`.
- Python baseline: `cd rickgent-policies && python3 -m pytest -q`.
- Native Omnigent tickets require `OMNIGENT_ROOT` or the installed-package mode selected by `t00`; absence is a non-skipping preflight failure.
- Hosted release verification requires a dedicated disposable remote, `GH_TOKEN`, explicit harness/model, and provider authentication. It must never mutate an operator repository.
- Full proof corpora are inventory files whose entries are discovered and asserted. A benchmark slice cannot satisfy a full corpus.

Required corpora:

| Corpus | Mandatory coverage |
|---|---|
| Native policy | manager and worker attachment sets; every attached policy; valid operations; malformed/unknown/unauthenticated events; traversal, symlink, rename/link endpoints, raw shell, false completion, convergence/review/PR bypass; prove no tool execution after denial |
| State crash | faults before/after run, ticket, attempt, lease, phase, spawn, commit, every gate, oracle, cleanup, promotion, delivery intent, push observation, PR observation, and terminal transactions |
| Git/process | dirty caller, foreign/non-descendant commits, moved refs, all change kinds, two owners, stubborn/double-fork children, closed stdio, output flood, post-parent mutation, committed/uncommitted/binary/empty salvage |
| Lifecycle gates | independent pass/fail/missing/stale/infrastructure injection for every required gate and review/remediation edge; assert no forbidden later phase, integration, push, or PR |
| Model identity | selection differs from bundle defaults; requested/invoked/observed mismatch one field at a time; missing/spoofed receipt; reviewer equality/distinction |
| Delivery | local bare-remote success/failures plus protected hosted PR-provider run; crash before/after push and PR receipt; idempotent recovery |
| Packaging | clean packed install, CLI link, agent/policy lookup, versions/pins, behavioral doctor, native policy/model smoke, no source fallback |

Fault and mutation tooling operates only on temporary copies/worktrees. A spawn failure, missing dependency, timeout, or infrastructure error is not a killed mutant.

## Acceptance criteria

### AC-INV-01 Attempt ownership

- **Type:** test
- **Scope:** `orchestrator/src`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/attempt-ownership.test.ts test/reliability/concurrency-corpus.test.ts`

Every attempt owns one immutable identity, worktree, ref, index, lease, and process group; conflicting owners cannot observe, release, or satisfy each other.

### AC-INV-02 Completion meaning

- **Type:** test
- **Scope:** `orchestrator/src/core`, `orchestrator/src/lifecycle`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/completion-oracle-integration.test.ts test/reliability/terminal-writer-audit.test.ts`

Only the versioned oracle/finalization service can produce `ready_for_delivery`; only verified remote/PR evidence can produce delivered/`Done`.

### AC-INV-03 Failure blocks advancement and delivery

- **Type:** test
- **Scope:** `orchestrator/src`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/gate-failure-corpus.test.ts test/reliability/delivery-negative.test.ts`

Zero completion, partial failure, every required-gate failure, unverifiable evidence, and cleanup failure yield nonzero and no forbidden phase, push, or PR.

### AC-INV-04 Native policy enforcement

- **Type:** test
- **Scope:** `rickgent-policies`, `agents/rickgent`, `orchestrator/src/policy`
- **Verify Command:** `cd rickgent-policies && python3 -m pytest -q test/test_native_function_policy_corpus.py`

Native input is normalized once and malformed, unauthenticated, unknown, and out-of-scope requests are denied before tool execution while valid in-scope structured operations succeed.

### AC-INV-05 Git attribution

- **Type:** test
- **Scope:** `orchestrator/src/git`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/git-attribution-corpus.test.ts`

Accepted commits descend from their attempt baseline, are orchestrator-attributable, contain the exact allowed delta, and fast-forward from the recorded delivery OID.

### AC-INV-06 Effective model identity

- **Type:** test
- **Scope:** `orchestrator/src/dispatch`, `orchestrator/src/lifecycle`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/model-identity-corpus.test.ts`

Requested, invoked, and independently observed canonical identity match; missing or mismatched receipts block completion and reviewer distinction claims.

### AC-INV-07 Timeout and cleanup ownership

- **Type:** test
- **Scope:** `orchestrator/src/process`, `orchestrator/src/lifecycle`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/process-supervisor-corpus.test.ts test/reliability/salvage-corpus.test.ts`

Timeout remains cleanup-pending until every descendant is dead, artifacts are bounded/captured, failed work is absent from the delivery ref, and the owner releases its lease.

### AC-INV-08 Transactional restart safety (composite)

- **Type:** test
- **Scope:** `orchestrator/src/state`, `orchestrator/test/reliability`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/state-crash-corpus.test.ts test/reliability/recovery-parity.test.ts`

This criterion is satisfied only when both `AC-INV-08A` and `AC-INV-08B` pass; a ticket contributing evidence to one subcriterion does not independently complete the composite.

#### AC-INV-08A Common transactional durability

The canonical SQLite store has one bounded transaction wrapper; crash at its real pre-COMMIT and post-COMMIT/pre-return checkpoints yields only the old or new image with immutable prior evidence. Retry allocation commits one unique planned identity before any currently represented durable downstream row, and competing allocators produce one typed winner.

#### AC-INV-08B Full lifecycle recovery parity

After the lease, process, Git, cleanup, lifecycle, oracle, and delivery services exist, run, attempt, phase, lease, receipt, oracle, cleanup, and delivery crash images recover without replay, duplicate side effects, or manufactured terminal work.

### AC-PROGRAM-01 Installed vertical slice

- **Type:** test
- **Scope:** `orchestrator`, `rickgent-policies`, `agents`, `install.sh`, `.github`
- **Verify Command:** `cd orchestrator && pnpm exec vitest run test/reliability/installed-vertical-slice.test.ts`

A clean packed install uses real compatible Omnigent, native policies, the selected model, one persistent state directory across forced interruption/resume, an owned commit, independent review, blocking gates, verified push, and a PR whose head equals the delivery OID.

## Milestones, sequencing, and exit criteria

### Milestone 0 — Resolve authority and external contracts

Tickets `t00`–`t02` decide the evolving Omnigent contract, intentionally adopt the evidence report, record the actual implementation baseline, choose direct worker/context/sandbox/terminal semantics, and pin the repository's package-manager contract. No production behavior is enabled by a decision artifact alone.

Exit: downstream work can execute from clean checkouts without an untracked authority source, and no consumer assumes a fixed sibling SHA.

### Milestone 1 — Contain false success and delivery

Tickets `t03`–`t07` install unbypassable capability kill switches, fail-closed aggregation, strict normalized tickets, one pre-mutation run worktree/direct worker seam, and truthful CLI/docs.

Exit: unsafe flags fail stably; zero/partial/gate/evidence/cleanup failure is nonzero; push/PR is unreachable; caller checkout/HEAD is unchanged; public autonomous mutation stays unavailable until M2.

### Milestone 2 — Restore the native policy boundary

Tickets `t08`–`t11` create the canonical adapter, immutable attempt policy context, scope/tool enforcement, and full attachment migration/proof.

Exit: the complete native policy corpus passes against the `t00` external contract, including proof that denied tools never run; legacy key probing is gone.

### Milestone 3 — Establish execution identity and durable state

Tickets `t12`–`t17` decide/store the full state/resource/promotion model, allocate immutable run/ticket/attempt contexts, enforce transitions, remove split authority, and prove the shared SQLite crash boundary plus internal retry identity. Full operation-specific recovery parity remains in `t29`, after resource, process, Git, cleanup, lifecycle, and oracle services exist.

Exit: ordinary builds never reuse runs, retry allocation commits before any currently represented durable downstream row, state is canonical-repo keyed, legacy data cannot terminalize, and the common commit boundary exposes only the old or new durable image. Ordering against real workspace, process, Git, salvage, and cleanup side effects remains owned by `t18`–`t21` and integrated recovery parity by `t29`; public resume remains gated.

### Milestone 4 — Isolate Git and supervise process ownership

Tickets `t18`–`t23` implement owner-checked resources, the process supervisor, orchestrator commit attribution, salvage/quarantine, the integrated ownership critical section, and full conflicting concurrency proof.

Exit: each attempt is isolated and attributable; timeout descendants are dead before release; failed deltas cannot reach delivery; concurrency stress proves isolation without automatically enabling production parallelism.

### Milestone 5 — Implement one lifecycle and completion oracle

Tickets `t24`–`t30` implement the persisted transition table, full contract propagation, safe gate runner, independent review/remediation, one completion oracle, recovery/reconcile consumers, and dead-path removal.

Exit: production traverses exact persisted phases; every gate blocks; bounded review/remediation works; live/restart decisions are identical; no shortcut can terminalize; a sequential local run can truthfully reach `ready_for_delivery`.

### Milestone 6 — Restore identity, delivery, packaging, and claims

Tickets `t31`–`t39` make selected identity effective/observed, prove reviewer distinction, implement verified push and PR protocols, unify packaging, add real quality/CI controls, test clean installation/doctor, run the protected real vertical slice, and finally align capabilities/docs.

Exit: requested/invoked/observed identity matches; push and PR head OIDs match the delivery OID; packed artifacts contain the CLI/bundles/policies; all quality gates are real; the protected installed vertical slice survives interruption/resume and cleans its remote resources.

## Ticket execution notes

- The manifest is a linear dependency spine. A ticket may depend only on committed outputs of its dependencies.
- Each ticket includes the negative proof that establishes its authority; there is no final catch-all hardening ticket.
- Full regression commands are run after focused tests once the pinned package-manager/toolchain contract exists.
- `OMNIGENT_ROOT` is required only by tickets that exercise real external seams. Its contract is current-compatible and validated from required APIs/behavior; no SHA is inferred.
- Local bare Git remotes cover deterministic delivery semantics. Only the protected release ticket may use `GH_TOKEN` and a hosted disposable repository.
- Output transcripts/receipts must redact credentials and absolute user paths where practical, record hashes/sizes, and state whether a result is fixture, local-integration, or protected-release evidence.
- Any capability implementation remains unavailable until the separate proof/activation acceptance criteria are satisfied. Documentation always describes the current committed boundary.

## Ticket index

The exact acceptance criteria and commands are in `refinement_manifest.json`; these sections make the refined PRD consumable by the current `### Ticket` parser.

### Ticket 00: Decide evolving Omnigent compatibility and observation contract
- **Description:** Record current-compatible external ABI, context config, observed identity, and reviewer distinction without inventing a fixed sibling SHA.
- **Declared Paths:** `artifacts/reliability/omnigent-compatibility-contract.json`, `docs/architecture/reliability/omnigent-contract.md`, `orchestrator/scripts/verify-omnigent-contract.mjs`
- **Acceptance Criteria:** `AC-INV-04`, `AC-INV-06`

### Ticket 01: Adopt evidence provenance and clean baseline contract
- **Description:** Track the authoritative review intentionally and record reproducible base/dirty-tree rules.
- **Declared Paths:** `docs/project-completion-reliability-review-2026-07-15.md`, `docs/architecture/reliability/evidence-provenance.md`
- **Acceptance Criteria:** `AC-INV-08`

### Ticket 02: Decide execution, ticket, terminal, sandbox, and toolchain contracts
- **Description:** Freeze prerequisite architecture decisions with executable schemas/fixtures before production callers change.
- **Declared Paths:** `docs/architecture/reliability/trust-spine-contract.md`, `orchestrator/src/contracts`, `orchestrator/package.json`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-03`, `AC-INV-07`

### Ticket 03: Install capability kill switches and strict CLI parsing
- **Description:** Make delivery, resume, reconcile, parallelism, cross-vendor, and raw shell unavailable through one unbypassable registry.
- **Declared Paths:** `orchestrator/src/capabilities`, `orchestrator/src/cli.ts`, `orchestrator/test/reliability/capability-contraction.test.ts`
- **Acceptance Criteria:** `AC-INV-03`

### Ticket 04: Make run aggregation fail closed
- **Description:** Return nonzero for zero/partial/gate/evidence/cleanup failure and prove delivery code is unreachable.
- **Declared Paths:** `orchestrator/src/lifecycle/build.ts`, `orchestrator/test/reliability/fail-closed-aggregation.test.ts`
- **Acceptance Criteria:** `AC-INV-03`

### Ticket 05: Implement strict TicketContract normalization and hashing
- **Description:** Reject ambiguous plans before dispatch and produce stable ticket-specific contract digests.
- **Declared Paths:** `orchestrator/src/contracts/ticket-contract.ts`, `orchestrator/src/lifecycle/prd-parse.ts`, `orchestrator/test/reliability/ticket-contract.test.ts`
- **Acceptance Criteria:** `AC-INV-03`, `AC-INV-05`

### Ticket 06: Provision the sequential pre-mutation run worktree
- **Description:** Directly spawn the structured worker only inside a clean dedicated run worktree while caller HEAD/index remain untouched.
- **Declared Paths:** `orchestrator/src/git/run-workspace.ts`, `orchestrator/src/lifecycle/build.ts`, `orchestrator/test/reliability/run-workspace.test.ts`
- **Acceptance Criteria:** `AC-INV-01`, `AC-INV-05`

### Ticket 07: Publish the reliability-preview CLI and docs contract
- **Description:** Make help, doctor, README, and runtime capability output agree with the contained boundary.
- **Declared Paths:** `README.md`, `orchestrator/src/cli.ts`, `orchestrator/test/reliability/claims-contract.test.ts`
- **Acceptance Criteria:** `AC-INV-03`

### Ticket 08: Implement the canonical native policy adapter
- **Description:** Normalize real native events once, fail closed on malformed/unknown/unauthenticated input, and prove positive/negative FunctionPolicy behavior.
- **Declared Paths:** `rickgent-policies/rickgent_policies/policy_event.py`, `rickgent-policies/test/test_native_policy_adapter.py`
- **Acceptance Criteria:** `AC-INV-04`

### Ticket 09: Materialize and authenticate per-attempt policy context
- **Description:** Bind immutable orchestrator-owned roots/identity/scope/model data to the direct worker bundle and reject replay/tampering.
- **Declared Paths:** `orchestrator/src/policy/policy-bundle.ts`, `rickgent-policies/rickgent_policies/context.py`, `orchestrator/test/reliability/policy-context.test.ts`
- **Acceptance Criteria:** `AC-INV-04`, `AC-INV-06`

### Ticket 10: Enforce canonical scope and structured tools
- **Description:** Prove root/declaration/endpoint containment for all change kinds and deny raw shell/unknown tools through native events.
- **Declared Paths:** `rickgent-policies/rickgent_policies/scope.py`, `rickgent-policies/test/test_native_scope_corpus.py`
- **Acceptance Criteria:** `AC-INV-04`, `AC-INV-05`

### Ticket 11: Migrate every attached policy and prove full bundle composition
- **Description:** Remove legacy probing and exercise the complete manager/worker attachment corpus through real FunctionPolicy composition.
- **Declared Paths:** `rickgent-policies/rickgent_policies`, `agents/rickgent`, `rickgent-policies/test/test_native_function_policy_corpus.py`
- **Acceptance Criteria:** `AC-INV-04`

### Ticket 12: Decide state schema, promotion, lifecycle, and terminal semantics
- **Description:** Record the transactional resource model and fast-forward delivery protocol before SQLite callers land.
- **Declared Paths:** `docs/architecture/reliability/state-and-lifecycle-contract.md`, `orchestrator/src/state/schema.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-08A`

### Ticket 13: Implement the versioned transactional SQLite store
- **Description:** Add numbered migrations, safe repository-derived location, constraints, durability, and corruption/future-schema failure.
- **Declared Paths:** `orchestrator/src/state`, `orchestrator/test/reliability/state-store.test.ts`
- **Acceptance Criteria:** `AC-INV-08A`

### Ticket 14: Allocate immutable runs, tickets, attempts, and contexts
- **Description:** New builds allocate new runs; retries allocate unique attempts before spawn; immutable snapshots carry contract/capability identity.
- **Declared Paths:** `orchestrator/src/context`, `orchestrator/src/state`, `orchestrator/test/reliability/identity-allocation.test.ts`
- **Acceptance Criteria:** `AC-INV-01`, `AC-INV-08A`

### Ticket 15: Persist legal phase, receipt, evidence, and terminalization transitions
- **Description:** Enforce compare-and-set transitions and expose one oracle-backed terminalization API.
- **Declared Paths:** `orchestrator/src/state/transitions.ts`, `orchestrator/test/reliability/transition-authority.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-08A`

### Ticket 16: Cut over registry and ledger callers and quarantine legacy state
- **Description:** Remove JSON/JSONL terminal authority and commit-subject completion without dual-write ambiguity.
- **Declared Paths:** `orchestrator/src/lifecycle/registry.ts`, `orchestrator/src/lifecycle/reconcile.ts`, `orchestrator/src/dispatch/dispatch.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-08A`

### Ticket 17: Prove the common SQLite crash boundary and retry identity
- **Description:** Inventory every Store transaction with an exact-or-null contract mapping and stable semantic test ID, fault the one shared commit boundary before COMMIT and after COMMIT/before return, and directly prove retry allocation response-loss and race behavior. Defer full operation-specific recovery parity to `t29`.
- **Declared Paths:** `orchestrator/test/reliability/state-crash-corpus.test.ts`, `orchestrator/test/fixtures/crash-matrix`
- **Acceptance Criteria:** contributes `AC-INV-08A`; does not complete composite `AC-INV-08`

### Ticket 18: Implement owner-checked leases and attempt resource allocation
- **Description:** Implement the internal pre-side-effect ownership primitive: a raw-token credential, atomic lease-plus-eleven-fixed-resource reservation, current/unexpired owner assertions, StateStore-selected Git-boundary pinning, receipt-bound deterministic detached worktree/ref/index reconciliation, final-edge unforgeable spawn observation, sealed committed/current replay, and a fail-closed stale-cleanup consumer bound to the exact durable process-receipt/evidence lineage. `t19` produces real process-death evidence, `t21` produces terminal physical-disposition proof, and `t22` alone consumes the spawn observation and replaces the interim production run-worktree/oracle seam.
- **Declared Paths:** `orchestrator/src/git/attempt-workspace.ts`, `orchestrator/src/state/leases.ts`, `orchestrator/src/state/migrations.ts`, `orchestrator/src/state/schema.ts`, `orchestrator/src/state/store.ts`, `orchestrator/test/reliability/attempt-ownership.test.ts`, `orchestrator/test/fixtures/attempt-ownership/child.mjs`, `orchestrator/test/reliability/state-crash-corpus.test.ts`, `orchestrator/test/fixtures/crash-matrix`, `artifacts/reliability/state-crash-summary.json`, `docs/architecture/reliability/state-and-lifecycle-contract.json`, `docs/architecture/reliability/state-and-lifecycle-contract.md`
- **Acceptance Criteria:** contributes the lease/resource portion of `AC-INV-01`; `t19` and `t23` complete the process/concurrency portions, and `t20` owns `AC-INV-05`

### Ticket 19: Implement the POSIX process-group supervisor
- **Description:** Bound output, observe the process group and exact sampled PID/start identities, escalate timeout within a fixed deadline, and retain cleanup ownership unless an authoritative containment backend proves all descendants dead. Process-table sampling is never represented as proof that an unobserved escape did not occur.
- **Declared Paths:** `orchestrator/src/process/posix.ts`, `orchestrator/src/process/supervisor.ts`, `orchestrator/src/git/attempt-workspace.ts`, `orchestrator/src/state/migrations.ts`, `orchestrator/src/state/schema.ts`, `orchestrator/src/state/store.ts`, `orchestrator/src/state/transitions.ts`, `orchestrator/scripts/validate-state-contract.mjs`, `orchestrator/test/reliability/attempt-ownership.test.ts`, `orchestrator/test/reliability/process-posix.test.ts`, `orchestrator/test/reliability/process-supervisor-corpus.test.ts`, `orchestrator/test/reliability/state-contract.test.ts`, `orchestrator/test/reliability/state-crash-corpus.test.ts`, `orchestrator/test/reliability/state-observation.test.ts`, `orchestrator/test/reliability/state-store.test.ts`, `orchestrator/test/reliability/transition-authority.test.ts`, `orchestrator/test/fixtures/crash-matrix`, `orchestrator/test/fixtures/process-supervisor`, `artifacts/reliability/state-crash-summary.json`, `docs/architecture/reliability/state-and-lifecycle-contract.json`, `docs/architecture/reliability/state-and-lifecycle-contract.md`, `docs/remediation/phase-4-process-supervisor-execution-report-2026-07-17.md`
- **Acceptance Criteria:** `AC-INV-07`

### Ticket 20: Implement orchestrator-owned commit attribution
- **Description:** Stage exact owned paths, create/verify the final descendant commit, and reject foreign or out-of-contract delta.
- **Declared Paths:** `orchestrator/src/git/commit-service.ts`, `orchestrator/test/reliability/git-attribution-corpus.test.ts`
- **Acceptance Criteria:** `AC-INV-05`

### Ticket 21: Implement salvage, quarantine, restore, and cleanup proof
- **Description:** Capture every failed-work form, prove delivery absence, and release only after verified cleanup.
- **Declared Paths:** `orchestrator/src/lifecycle/salvage.ts`, `orchestrator/test/reliability/salvage-corpus.test.ts`
- **Acceptance Criteria:** `AC-INV-07`

### Ticket 22: Integrate the attempt ownership critical section
- **Description:** Wire allocation, validated authoritative macOS/Linux containment, policy context, supervisor, evidence, commit, cleanup, promotion, and release in the fixed order. Treat unavailable containment as a pre-release infrastructure error and never promote sampled ancestry into all-descendant death proof.
- **Declared Paths:** `orchestrator/src/process/containment.ts`, `orchestrator/src/lifecycle/attempt-runner.ts`, `orchestrator/src/lifecycle/build.ts`, `orchestrator/test/reliability/attempt-critical-section.test.ts`
- **Acceptance Criteria:** `AC-INV-01`, `AC-INV-05`, `AC-INV-07`

### Ticket 23: Prove conflicting concurrency isolation without enabling production parallelism
- **Description:** Stress independent attempts across processes/scopes/ref movement and publish complete ownership proof.
- **Declared Paths:** `orchestrator/test/reliability/concurrency-corpus.test.ts`, `orchestrator/test/fixtures/concurrency-corpus`
- **Acceptance Criteria:** `AC-INV-01`, `AC-INV-05`, `AC-INV-07`

### Ticket 24: Implement the persisted lifecycle transition table
- **Description:** Replace the boolean scaffold with the one normative phase/remediation model.
- **Declared Paths:** `orchestrator/src/lifecycle/phase.ts`, `orchestrator/src/lifecycle/engine.ts`, `orchestrator/test/reliability/lifecycle-transitions.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, contributes `AC-INV-08B`

### Ticket 25: Propagate the full ticket contract through every phase
- **Description:** Preserve ACs, interfaces, scope, dependencies, digest, and budgets in prompts and receipts.
- **Declared Paths:** `orchestrator/src/lifecycle/prompts.ts`, `orchestrator/test/reliability/contract-propagation.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-05`

### Ticket 26: Implement the sandboxed structured gate runner
- **Description:** Replace `sh -c` with argv-only sandboxed verification through the supervisor and typed gate results.
- **Declared Paths:** `orchestrator/src/verification`, `orchestrator/src/lifecycle/citadel.ts`, `orchestrator/test/reliability/gate-runner.test.ts`
- **Acceptance Criteria:** `AC-INV-03`, `AC-INV-07`

### Ticket 27: Implement independent review and bounded remediation
- **Description:** Run fresh read-only review over immutable input and enforce bounded structured remediation/re-review.
- **Declared Paths:** `orchestrator/src/lifecycle/review.ts`, `orchestrator/src/lifecycle/remediation.ts`, `orchestrator/test/reliability/review-remediation.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-03`

### Ticket 28: Integrate the shared versioned completion oracle
- **Description:** Require every lifecycle, Git, process, gate, review, evidence, and cleanup input; missing or null fails.
- **Declared Paths:** `orchestrator/src/core/completion.ts`, `orchestrator/src/lifecycle/completion-service.ts`, `orchestrator/test/reliability/completion-oracle-integration.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-03`, `AC-INV-05`, `AC-INV-07`

### Ticket 29: Make resume and structured reconciliation use lifecycle/oracle parity
- **Description:** Recover explicit runs from persisted receipts, resolve a response-lost planned retry through typed no-side-effect cleanup before allocating a higher-numbered attempt, and keep commit prose non-authoritative.
- **Declared Paths:** `orchestrator/src/lifecycle/recovery.ts`, `orchestrator/src/lifecycle/reconcile.ts`, `orchestrator/test/reliability/recovery-parity.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, completes `AC-INV-08B` and composite `AC-INV-08`

### Ticket 30: Remove duplicate lifecycle and terminal shortcuts
- **Description:** Delete the implementation-only path and audit production imports/callers for one terminal predicate.
- **Declared Paths:** `orchestrator/src/lifecycle/build.ts`, `orchestrator/test/reliability/terminal-writer-audit.test.ts`
- **Acceptance Criteria:** `AC-INV-02`, `AC-INV-03`

### Ticket 31: Make selected harness/model control invocation and persist observed identity
- **Description:** Pass actual overrides, capture independent native session identity, and fail missing/mismatched receipts.
- **Declared Paths:** `orchestrator/src/lifecycle/routing.ts`, `orchestrator/src/dispatch/dispatch.ts`, `orchestrator/test/reliability/model-identity-corpus.test.ts`
- **Acceptance Criteria:** `AC-INV-06`

### Ticket 32: Prove routing and cross-vendor reviewer distinction
- **Description:** Exercise all identity mismatches and enable cross-vendor review only when canonical identities are observably distinct.
- **Declared Paths:** `orchestrator/src/capabilities`, `orchestrator/test/reliability/cross-vendor-review.test.ts`
- **Acceptance Criteria:** `AC-INV-06`

### Ticket 33: Implement verified push with observed remote OID
- **Description:** Push the exact delivery OID by argv and require matching `ls-remote` evidence under all local failure cases.
- **Declared Paths:** `orchestrator/src/delivery/push.ts`, `orchestrator/test/reliability/push-protocol.test.ts`
- **Acceptance Criteria:** `AC-INV-03`

### Ticket 34: Implement verified and idempotent PR creation
- **Description:** Create/resolve a PR only after verified push and require queried head/repository equality.
- **Declared Paths:** `orchestrator/src/delivery/pull-request.ts`, `orchestrator/test/reliability/delivery-negative.test.ts`
- **Acceptance Criteria:** `AC-INV-03`

### Ticket 35: Unify release manifest, package contents, installer, and license
- **Description:** Generate/check one cross-language version/compatibility contract and make clean packed installation possible.
- **Declared Paths:** `release-manifest.json`, `orchestrator/package.json`, `rickgent-policies/pyproject.toml`, `install.sh`, `LICENSE`
- **Acceptance Criteria:** `AC-PROGRAM-01`

### Ticket 36: Add real lint, typecheck, coverage, mutation, and CI gates
- **Description:** Pin tools, enforce numeric thresholds, move mutation to temp worktrees, and distinguish infrastructure errors.
- **Declared Paths:** `.github/workflows/ci.yml`, `orchestrator/eslint.config.js`, `orchestrator/scripts/coverage-manifest.cjs`, `rickgent-policies/pyproject.toml`
- **Acceptance Criteria:** `AC-INV-03`, `AC-PROGRAM-01`

### Ticket 37: Prove clean packed install and behavioral doctor
- **Description:** Install only packed artifacts, resolve CLI/bundles/policies without source fallback, and run native behavior smoke.
- **Declared Paths:** `orchestrator/test/reliability/packed-install.test.ts`, `orchestrator/src/lifecycle/doctor.ts`
- **Acceptance Criteria:** `AC-INV-04`, `AC-INV-06`, `AC-PROGRAM-01`

### Ticket 38: Pass the protected real installed vertical slice
- **Description:** Against real compatible Omnigent/model/hosted remote, interrupt/resume one state directory and verify native policy, owned commit, review, gates, push, and PR OID.
- **Declared Paths:** `orchestrator/test/reliability/installed-vertical-slice.test.ts`, `.github/workflows/release-trust-spine.yml`
- **Acceptance Criteria:** `AC-INV-01`, `AC-INV-02`, `AC-INV-03`, `AC-INV-04`, `AC-INV-05`, `AC-INV-06`, `AC-INV-07`, `AC-INV-08A`, `AC-INV-08B`, `AC-INV-08`, `AC-PROGRAM-01`

### Ticket 39: Restore only proven capabilities and release claims
- **Description:** Make runtime, help, doctor, README, and changelog reflect exact passed proof corpora; leave all unproven capabilities unavailable.
- **Declared Paths:** `orchestrator/src/capabilities`, `README.md`, `CHANGELOG.md`, `docs/reliability-contract.md`
- **Acceptance Criteria:** `AC-PROGRAM-01`

## Program completion

The program is complete only when tickets `t00`–`t39` are committed in dependency order, all owning proof corpora and full regressions are green, and the protected installed-artifact vertical slice completes twice against real compatible Omnigent and a disposable real remote using the same persistent state directory across forced interruption/resume. Mock-only green results do not satisfy completion.
