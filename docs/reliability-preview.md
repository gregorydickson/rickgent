# Rickgent reliability-preview contract

Release channel: `reliability_preview`  
Schema version: `1.0.0`

This document publishes the current external boundary. The compiled registry
in `orchestrator/src/capabilities/registry.ts` is the runtime authority. This
document and the README are checked publications of that authority. Historical
ADRs and phase reports, remediation designs, fixtures, tests, model/vendor
labels, and environment configuration do not activate a capability.

## Public command and capability matrix

An unavailable capability emits outer stable code
`RICKGENT_CAPABILITY_UNAVAILABLE` and its selected capability detail in that
order. Input-contract failures emit `RICKGENT_INPUT_CONTRACT_ERROR` without an
unselected capability detail. The process exits shown below are the observed
public CLI contract; an em dash means there is no public process invocation.

<!-- RICKGENT_CLAIMS_MATRIX_BEGIN -->
| Surface | Mode | Mutation authority | Capability/state | Result | Exit | Stable code | Capability detail | Boundary |
|---|---|---|---|---|---:|---|---|---|
| rickgent build <prd> | public_local_artifact | local_artifact_only | autonomous_dispatch/enabled | autonomous dispatch via the AttemptRunner critical section; delivery, parallelism, resume, and raw shell remain unavailable | — | — | RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE | Autonomous dispatch is activated (t22D): the single AttemptRunner owns execution and terminalization. Production requires a validated containment backend and a real model roster; unavailable containment fails closed with a target-never-released proof before any spawn. Delivery, parallel dispatch, resume, and raw shell remain unavailable. Cross-vendor review is activated (t32). |
| rickgent pipeline <prd> | public_local_artifact | local_artifact_only | autonomous_dispatch/enabled | autonomous dispatch via the AttemptRunner critical section followed by the cleanup chain; delivery remains unavailable | — | — | RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE | Autonomous dispatch is activated (t22D): the single AttemptRunner owns execution and terminalization. Production requires a validated containment backend; unavailable containment fails closed. Delivery, parallel dispatch, resume, and raw shell remain unavailable. Cross-vendor review is activated (t32). |
| explicit build test dependency injection | fixture_dependency_only | capture_only | autonomous_dispatch/enabled | implementation_captured_nonterminal | — | — | RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE | Exactly one worker in a dedicated run worktree; no trusted commit or gate advancement. |
| rickgent prd --non-interactive [--output <path>] | public_local_artifact | local_artifact_only | — | resolves the destination and writes or overwrites a deterministic PRD template | — | — | — | The caller-selected/default path is explicit write authority and may be inside the repository or state root; read-only Git inspection may run, but no agent spawn, Git mutation, or validated lifecycle transition occurs. |
| rickgent citadel [--report <path>] | public_local_artifact | local_artifact_only | — | reads a diff and may create or overwrite the requested audit report | — | — | — | The caller-selected report path is explicit write authority and may be inside the repository or state root; read-only Git inspection may run, but no remediation agent, Git mutation, or validated lifecycle transition occurs. |
| build\|pipeline --resume | public_local_artifact | local_artifact_only | resume_retry/enabled | resumes an explicit run from persisted receipts; response-lost planned retries are cleaned up via typed no-side-effect cleanup; later attempts allocated only after reconciliation | — | — | RICKGENT_RESUME_ACTIVE | Resume reads the durable SQLite state store, validates contract/context/oracle compatibility, and resumes cleanup or the next safe phase. Commit prose is never treated as truth; only durable receipts are authority. |
| rickgent retry | public_input_rejected | none | — | unknown command | 2 | RICKGENT_INPUT_CONTRACT_ERROR | — | Retry has no public CLI command; use `build --resume` for explicit run resume. |
| rickgent reconcile | public_read_only | none | reconciliation/enabled | rebuilds derived views from persisted run-attributed receipts; Git subjects and cross-run ticket IDs are ignored | — | — | RICKGENT_RECONCILIATION_ACTIVE | Reconciliation reads the durable SQLite state store and reports the persisted ticket count. No Git subjects, commit messages, or legacy JSONL claims are imported as truth. |
| build\|pipeline --feature\|--no-autonomous-pr | public_blocked | none | automatic_delivery/unavailable | delivery configuration rejected | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_DELIVERY_UNAVAILABLE | No branch push, PR creation, or delivery observation occurs. |
| build\|pipeline --raw-shell | public_blocked | none | raw_shell/unavailable | raw-shell configuration rejected | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_RAW_SHELL_UNAVAILABLE | Execution and verification accept structured argv only. |
| build\|pipeline [--max-concurrent 1] | public_local_artifact | local_artifact_only | autonomous_dispatch/enabled | sequential value accepted; dispatch via the AttemptRunner (concurrency >1 rejected) | — | — | RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE | Exactly 1 is the only accepted concurrency; production parallelism remains unavailable (t23 proves isolation but does not activate parallel dispatch). |
| build\|pipeline --max-concurrent <not-1> | public_input_rejected | none | — | input contract rejected | 2 | RICKGENT_INPUT_CONTRACT_ERROR | — | Greater, zero, fractional, malformed, and non-finite values fail before capability selection. |
| build\|pipeline --max-iterations <N> | public_input_rejected | none | — | parsed legacy flag rejected as unimplemented | 2 | RICKGENT_INPUT_CONTRACT_ERROR | — | A parsed flag is not an enabled capability. |
| cross-vendor review (routing selects distinct vendor for code_review) | public_read_only | none | cross_vendor_review/enabled | cross-vendor review permitted only when observed implementer and reviewer identities are genuinely distinct | — | — | RICKGENT_CROSS_VENDOR_ACTIVE | Cross-vendor review is activated (t32): the router selects a different vendor for code_review, and the distinction authority verifies that observed harness AND model both differ. Same-identity, missing, spoofed, or stale reviewer identity blocks the cross-vendor claim without invalidating same-vendor independent review. |
| rickgent status [--deep] | public_read_only | none | — | canonical SQLite lifecycle observation; --deep also runs the doctor health audit | — | — | — | Healthy observations exit 0; deep health failure exits 1; neither can terminalize a run. |
| rickgent doctor [--json] | public_read_only | none | — | health and attachment audit | — | — | — | Healthy audit exits 0; toolchain, platform, or attachment failure exits 1. |
| rickgent <command> --help | public_read_only | none | — | claim observation only | 0 | RICKGENT_OK | — | Help text does not activate a mutating capability. |
<!-- RICKGENT_CLAIMS_MATRIX_END -->

## Public versus fixture behavior

Public `build` and `pipeline` cannot allocate a run worktree or spawn a worker.
There is no public flag, command, environment switch, or configuration file
that enables agent-backed source, Git, remediation, or lifecycle mutation in
this release.

The public toolbelt deliberately retains two narrower filesystem writers:
`prd --non-interactive [--output <path>]` creates a deterministic PRD template,
and `citadel [--report <path>]` may create a deterministic audit report. Those
resolved destinations are explicit caller write authority: the commands create
parent directories and may overwrite a selected/default path, including one
inside the target repository or state root. They may execute read-only Git
inspection, but do not spawn a remediation agent, mutate Git, or perform a
validated lifecycle transition.

Tests may explicitly inject build dependencies that waive the public dispatch
gate. That evidence seam is fixture-only and exactly sequential: exactly one
worker runs in a dedicated run worktree and mutation capture can emit only
`implementation_captured_nonterminal`. Capture creates no trusted commit
evidence, advances no verification or convergence gate, and grants no delivery
authority. It is nonterminal.

Package-excluded legacy compatibility fixtures may exercise unavailable
toolbelt implementations in disposable repositories. Their spawns, mutations,
and results are non-authoritative and cannot support capability, completion, or
lifecycle claims.

## Terminal semantics

- `ready_for_delivery=local_oracle_complete` means the shared local oracle has
  accepted the ticket after required promotion and cleanup/ownership release.
  It is not a delivered state.
- `delivered=remote_delivery_verified` means independently observed remote
  branch and PR-head OIDs both equal the delivery OID.
- `Done` is an alias only for delivered. A legacy registry string spelled
  `Done` is not evidence of those remote observations.

The reliability-preview fixture seam cannot reach `ready_for_delivery`,
delivered, or `Done`, and cannot write any of those terminal states.

## Read-only and unavailable surfaces

Help, `status`, and `doctor` are read-only observations. `status` does not
reinterpret or terminalize stored state. Doctor performs real health checks
and returns nonzero when one fails; its policy result proves configured
attachment only, not native production enforcement.

Public autonomous mutation, resume/retry, reconciliation, parallel dispatch,
independently observed cross-vendor review, automatic delivery, and raw shell
remain unavailable. In particular, `--max-concurrent 2` is rejected first as
an input-contract error; it does not emit the separately registered
`RICKGENT_PARALLEL_DISPATCH_UNAVAILABLE` detail. A capability transition
requires a compiled registry change and its proof corpus, not documentation or
a passing fixture.
