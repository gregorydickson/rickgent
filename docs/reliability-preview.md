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
| rickgent build <prd> | public_blocked | none | autonomous_dispatch/fixture_only | blocked before allocation or spawn | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_AUTONOMOUS_FIXTURE_ONLY | Public autonomous mutation is not available. |
| rickgent pipeline <prd> | public_blocked | none | autonomous_dispatch/fixture_only | blocked before allocation or spawn | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_AUTONOMOUS_FIXTURE_ONLY | Public lifecycle mutation is not available. |
| explicit build test dependency injection | fixture_dependency_only | capture_only | autonomous_dispatch/fixture_only | implementation_captured_nonterminal | — | — | RICKGENT_AUTONOMOUS_FIXTURE_ONLY | Exactly one worker in a dedicated run worktree; no trusted commit or gate advancement. |
| rickgent prd --non-interactive [--output <path>] | public_local_artifact | local_artifact_only | — | resolves the destination and writes or overwrites a deterministic PRD template | — | — | — | The caller-selected/default path is explicit write authority and may be inside the repository or state root; read-only Git inspection may run, but no agent spawn, Git mutation, or validated lifecycle transition occurs. |
| rickgent citadel [--report <path>] | public_local_artifact | local_artifact_only | — | reads a diff and may create or overwrite the requested audit report | — | — | — | The caller-selected report path is explicit write authority and may be inside the repository or state root; read-only Git inspection may run, but no remediation agent, Git mutation, or validated lifecycle transition occurs. |
| build\|pipeline --resume | public_blocked | none | resume_retry/unavailable | blocked before autonomous dispatch | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_RESUME_UNAVAILABLE | Resume is unavailable; no public retry command exists. |
| rickgent retry | public_input_rejected | none | — | unknown command | 2 | RICKGENT_INPUT_CONTRACT_ERROR | — | Retry has no public CLI command; the resume/retry capability remains unavailable. |
| rickgent reconcile | public_blocked | none | reconciliation/unavailable | blocked before reconciliation | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_RECONCILIATION_UNAVAILABLE | No registry or lifecycle state is rebuilt. |
| build\|pipeline --feature\|--no-autonomous-pr | public_blocked | none | automatic_delivery/unavailable | delivery configuration rejected | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_DELIVERY_UNAVAILABLE | No branch push, PR creation, or delivery observation occurs. |
| build\|pipeline --raw-shell | public_blocked | none | raw_shell/unavailable | raw-shell configuration rejected | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_RAW_SHELL_UNAVAILABLE | Execution and verification accept structured argv only. |
| build\|pipeline [--max-concurrent 1] | public_blocked | none | autonomous_dispatch/fixture_only | sequential value accepted, then dispatch blocked | 3 | RICKGENT_CAPABILITY_UNAVAILABLE | RICKGENT_AUTONOMOUS_FIXTURE_ONLY | Omitted concurrency and exactly 1 do not enable public mutation. |
| build\|pipeline --max-concurrent <not-1> | public_input_rejected | none | — | input contract rejected | 2 | RICKGENT_INPUT_CONTRACT_ERROR | — | Greater, zero, fractional, malformed, and non-finite values fail before capability selection. |
| build\|pipeline --max-iterations <N> | public_input_rejected | none | — | parsed legacy flag rejected as unimplemented | 2 | RICKGENT_INPUT_CONTRACT_ERROR | — | A parsed flag is not an enabled capability. |
| cross-vendor review (no public command) | public_blocked | none | cross_vendor_review/unavailable | independent vendor proof unavailable | — | — | RICKGENT_CROSS_VENDOR_UNAVAILABLE | Requested vendor labels are not independently observed identity. |
| rickgent status [--deep] | public_read_only | none | — | registry observation; --deep also runs the doctor health audit | — | — | — | Healthy observations exit 0; deep health failure exits 1; neither can terminalize a run. |
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
