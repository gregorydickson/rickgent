# Phase 2 Native Policy Execution Report — 2026-07-16

## Outcome

Phase 2 native policy restoration (`t08` through `t11`) is implemented and the
integrated repository is green across the complete TypeScript, Python, native
FunctionPolicy, mutation, doctor, and live Omnigent compatibility suites.

This is Milestone 2 completion, not project completion. Public autonomous
execution remains blocked. The implemented authority is the narrow local,
sequential, direct structured-worker boundary defined by the trust-spine PRD;
it cannot claim terminal success, resume, parallel ownership, cross-vendor
identity, automatic delivery, or raw-shell safety.

The work ran on branch `remediation/trust-spine-phase-2` through the sequential
Pickle Rick session
`/Users/gregorydickson/.codex/pickle-rick/sessions/2026-07-16-a8c71526`.
The session completed after 25 recorded iterations. `t11` first stopped on a
real verification-contract failure because its required corpus file did not
yet exist; the explicit retry completed successfully. A three-reviewer agent
team then audited completion truth, data-flow integrity, and reliability
boundaries. Every P0/P1 finding was repaired and the integrated diff was
re-reviewed.

## Committed handoff chain

| Commit | Ticket / purpose |
|---|---|
| `c5779ea` | Phase 1 integrated containment and adversarial repairs |
| `827eec9` | `t08` — canonical native policy adapter |
| `a1cc3ce` | `t09` — authenticated per-attempt policy context |
| `dd6ee0d` | `t10` — canonical scope and structured-tool containment |

The integrated commit containing `t11`, the agent-team repairs, and this report
follows that chain. `orchestrator/src/build-commit.ts` was deliberately not
regenerated or rewritten during integration.

## Delivered native boundary

### Canonical event and verdict authority

- One strict adapter consumes the real native FunctionPolicy event shape and
  the exact trusted string configuration selected by `t00`.
- The adapter parses tool arguments once and produces immutable canonical
  events. Production policies no longer probe legacy agent-controlled
  top-level identity, phase, scope, vendor, path, or completion fields.
- Malformed phases/data/arguments/config, unknown tools, unauthenticated
  context, replay, stale/closed leases, identity conflicts, and unsupported ABI
  versions return stable named denials before dispatch.
- The effective native tool inventory is exact. Every configured unrelated
  tool is proven to abstain/allow appropriately, while unknown tools and every
  shell call/result are denied.

### Attempt context and runtime provenance

- TypeScript materializes one private attempt bundle, context, owner token,
  nonce claim, lease, and receipt path outside both caller and run worktrees.
- Python authenticates the context reference, digest, owner, dispatch identity,
  lease, nonce, roots, requested model identity, and bundle/config digests.
  Mutating agent-controlled event/context identity cannot change canonical
  authority.
- Runtime provenance separately binds the exact virtualenv Python entrypoint,
  its resolved interpreter and digest, the Omnigent and Rickgent policy origins,
  and the exact Node and Rickgent CLI paths/digests/build identity.
- Build-commit and verdict subprocesses execute as `[bound Node, bound CLI, ...]`.
  Python, Node, CLI, package, and context tampering fail closed.
- The Omnigent contract verifier now preserves virtualenv entrypoint semantics
  instead of resolving the symlink before spawn and silently losing the
  selected environment.

### Scope, tools, and attachment composition

- Scope authorization proves the canonical worktree root, every declaration,
  and every operation endpoint through realpath/nearest-existing-parent
  containment. Traversal, absolute paths, symlink escapes, reserved roots,
  wrong change kinds, and escaping rename/link endpoints are denied.
- The manager and worker register the real Omnigent filesystem capability set,
  while `scope_fence` unconditionally blocks its raw-shell member. Four
  lifecycle tool names now resolve to concrete receipt/no-op implementations;
  they do not grant terminal promotion authority.
- `scope_fence`, `completion_evidence`, `convergence_gate`,
  `subtract_before_add`, `cross_vendor_review`, and `autonomous_pr_flow` consume
  canonical events. Builtin blast-radius composition is exercised with the
  exact ordered inventory.
- Real FunctionPolicy tests prove allowed structured reads/writes reach the
  wrapped tool and every denial leaves the wrapped tool unexecuted. Attachment
  startup fails on missing, incompatible, or unconfigured policies rather than
  passing through static name resolution.
- The manager attachment check is explicitly structural only: the manager
  template has no attempt authority and is not a runnable mutation surface.
  The configured worker receives the real startup smoke for each materialized
  attempt.

## Agent-team reliability repairs

The post-ticket review found and closed several trust-boundary defects that the
initial ticket implementations did not expose:

1. Manifest tool inventories exceeded adapter knowledge. The canonical tool
   union and every unrelated-tool policy cell are now asserted exactly.
2. Corpus assertions inferred tool execution. Full bundle cells now use an
   observed dispatcher, and a real ToolManager integration proves allowed
   writes execute while malformed, denied, unapproved, and shell operations do
   not.
3. Headless Omnigent daemonization discarded attempt environment. Production
   dispatch now uses the exact direct `--no-session` argv.
4. Outer CLI process-group death did not prove new-session descendant death.
   Timeout, spawn error, ledger failure after spawn, lingering groups, and
   abnormal exit now return `cleanup_pending` / `ownership_unproven`, retain the
   active lease/materialization and owner-bound lock, stop the queue and later
   gates, and force workspace retention.
5. Ticket locks were non-atomic and unowned. Creation is exclusive and release
   is token-bound. Phase 2 performs no time-based reclamation: active,
   cleanup-pending, malformed, empty, and crash-partial records all remain
   fail-closed until the later explicit recovery owner exists.
6. Ledger writes could orphan children or hang dispatch promises. Supervision
   is installed before spawned evidence, append failures enter the same bounded
   termination path, and terminal append failure resolves a typed failure.
7. Virtualenv symlink resolution and unbound Node invocation broke runtime
   provenance. Entry and target identities are now distinct and both are
   authenticated.
8. Legacy fixture lifecycle tests attempted to authenticate scripted workers
   as real Omnigent. The package-private fixture bridge now replaces only
   policy materialization with an explicit test receipt while retaining the
   production dispatcher, queue, worktree, evidence, and ownership paths.

The detached-descendant fixture is intentionally adversarial: a new-session
child ignores termination, survives the outer CLI process group, and mutates
the worktree after the CLI dies. The test proves Rickgent fails and retains all
authority-bearing resources instead of assuming cleanup.

## Final evidence

| Check | Result |
|---|---|
| TypeScript full suite: `npm exec --offline -- vitest run --maxWorkers=1` | **PASS** — 59 files, 798 tests |
| TypeScript: `tsc --noEmit` | **PASS** |
| Python full suite with bound source CLI/runtime | **PASS** — 367 passed, 3 skipped |
| `t11` native FunctionPolicy + manager/worker attachment suite | **PASS** — 66 tests |
| Native corpus inventory | **PASS** — complete, 69 canonical event cases |
| Coverage mutation matrix | **PASS** — all 35 coverage tests; every configured mutant killed |
| Dispatch adversarial evidence | **PASS** — exact argv, abnormal exit, ledger failures, same-group escalation, detached descendant |
| Omnigent live compatibility probe | **PASS** — runtime 0.6.0.dev0, 9 checks |
| `rickgent doctor --json` | **PASS** — toolchain/platform/health green; claims remain reliability-preview |
| Legacy top-level policy probe search | **PASS** — no production matches |
| `git diff --check` | **PASS** |
| Build-identity source preservation | **PASS** — no diff in `orchestrator/src/build-commit.ts` |

The three Python skips are explicit conformance fixtures for the breaker, which
has no CLI verdict surface; they are not native-policy skips.

## Current conservative boundaries

- Public `build` and `pipeline` remain blocked before autonomous allocation or
  spawn. Only the package-private deterministic capture seam can exercise the
  M2 path.
- The source-mounted Omnigent helper cannot import inside the current macOS
  default sandbox. The worker therefore uses `sandbox: none`; canonical scope
  policy is the active M2 containment boundary. Owned process/workspace
  isolation remains Milestone 4 work.
- `cleanup_pending` deliberately has no automatic recovery yet. Affected
  leases, locks, materializations, and workspaces remain retained until the
  transactional state, process-supervisor, salvage, and cleanup tickets provide
  owner-checked recovery.
- Attempt directories are retained after clean child close until cleanup proof;
  they are not silently deleted by dispatch.
- Raw shell, delivery, terminal success, resume/retry, reconciliation,
  parallelism, and cross-vendor completion remain unavailable. Delivery
  sequences were removed from the runnable native corpus because their tools
  are not currently exposed.
- Lifecycle receipt tools are reachable but cannot manufacture authoritative
  promotion, commit, review, gate, push, PR, or Done evidence.
- Clean packed installation, installed CLI linkage, protected remote delivery,
  and the real end-to-end release slice remain Milestone 6 work.
- `npm run lint` is not a usable gate: `eslint` is neither installed nor
  configured even though the package declares the script. The command exits
  127. This pre-existing release-quality gap remains open for the quality and
  packaging tickets; it is not counted as a Phase 2 success.

## Next phase

Proceed with `t12` through `t17` only after this handoff is accepted:

1. decide the state schema, promotion, lifecycle, and terminal semantics;
2. implement the versioned transactional SQLite store;
3. allocate immutable runs, tickets, attempts, and contexts;
4. persist legal transitions and one terminalization authority;
5. cut registry/ledger callers over and quarantine legacy authority; and
6. prove restart/retry against the state crash corpus.

Do not activate public resume or autonomous execution merely because the native
policy boundary is restored. Milestones 3 through 6 still own durable identity,
process containment, commit attribution, completion-oracle parity, delivery,
packaging, and protected real-world proof.
