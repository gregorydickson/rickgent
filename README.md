# Rickgent reliability preview

Rickgent currently publishes the `reliability_preview` lifecycle boundary.
Public build and delivery remain unavailable; the preview exposes read-only
claim and health inspection plus the explicitly listed legacy toolbelt
surfaces, not an autonomous mutation or delivery service.

The compiled authority is
[`orchestrator/src/capabilities/registry.ts`](orchestrator/src/capabilities/registry.ts).
The precise public contract is
[`docs/reliability-preview.md`](docs/reliability-preview.md). If prose differs
from the compiled registry, the registry and observed CLI exits control.

## Current boundary

Public `build` and `pipeline` stop before allocation or spawn with exit `3`,
outer code `RICKGENT_CAPABILITY_UNAVAILABLE`, and detail
`RICKGENT_AUTONOMOUS_FIXTURE_ONLY`. Resume/retry, reconciliation, parallel
dispatch, independently observed cross-vendor review, automatic delivery, and
raw shell are unavailable.

The only test seam admitted to produce reliability evidence from agent-backed
source mutation is explicit build dependency injection. It is fixture-only,
exactly sequential, uses a dedicated run worktree, and is capture-only. Its
strongest receipt is
`implementation_captured_nonterminal`; it creates no trusted commit evidence,
advances no verification gate, and cannot terminalize a ticket.

Package-excluded legacy compatibility fixtures may exercise unavailable
toolbelt implementations in disposable repositories. Their spawns, mutations,
and results are non-authoritative and cannot support capability, completion, or
lifecycle claims.

Two deterministic local-artifact writers are public and explicitly bounded:
`prd --non-interactive [--output <path>]` writes a PRD template, and
`citadel [--report <path>]` may write its audit report. They may execute
read-only Git inspection, but neither grants agent, Git-mutation,
remediation-agent, or validated lifecycle-transition authority.
Their resolved destination is explicit caller write authority: both commands
create parent directories and may overwrite a selected/default path, including
a path inside the target repository or state root.

`ready_for_delivery=local_oracle_complete` means local oracle acceptance plus
cleanup and ownership release. It is not delivered. Delivered requires verified
remote branch and PR-head observations equal to the delivery OID:
`delivered=remote_delivery_verified`. `Done` is a delivered-only alias. The
fixture seam reaches none of these states.

`status`, `doctor`, and help are read-only. `status` may display a stored legacy
label spelled `Done`; that label is not remote delivery evidence and the command
cannot make it so. Doctor's policy check audits configured attachment only; it
does not prove native production enforcement.

## Command and capability matrix

This checked block is generated from the compiled registry. Hand edits or
runtime drift fail the claims-contract test.

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

## Inspect and verify

After installing the repository's locked local dependencies, use the sequential
inspection and verification path:

```sh
cd orchestrator
npm exec --offline -- tsc
node dist/cli.js --help
node dist/cli.js doctor
npm test
```

The root `install.sh` remains the local installation entrypoint for the
repository package. Historical ADRs, phase reports, remediation plans,
fixtures, passing tests, and vendor labels describe evidence or intended
architecture; none of them activates a compiled capability.
