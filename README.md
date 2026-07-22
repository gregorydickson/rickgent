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
`RICKGENT_AUTONOMOUS_FIXTURE_ONLY`. Parallel
dispatch, independently observed cross-vendor review, automatic delivery, and
raw shell are unavailable. Resume/retry and reconciliation are activated
(t29): resume of explicit runs uses persisted receipts, and reconciliation
rebuilds derived views from the durable SQLite state store.

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
| rickgent build <prd> | public_local_artifact | local_artifact_only | autonomous_dispatch/enabled | autonomous dispatch via the AttemptRunner critical section; delivery, parallelism, resume, and raw shell remain unavailable | — | — | RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE | Autonomous dispatch is activated (t22D): the single AttemptRunner owns execution and terminalization. Production requires a validated containment backend and a real model roster; unavailable containment fails closed with a target-never-released proof before any spawn. Delivery, parallel dispatch, resume, raw shell, and cross-vendor review remain unavailable. |
| rickgent pipeline <prd> | public_local_artifact | local_artifact_only | autonomous_dispatch/enabled | autonomous dispatch via the AttemptRunner critical section followed by the cleanup chain; delivery remains unavailable | — | — | RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE | Autonomous dispatch is activated (t22D): the single AttemptRunner owns execution and terminalization. Production requires a validated containment backend; unavailable containment fails closed. Delivery, parallel dispatch, resume, raw shell, and cross-vendor review remain unavailable. |
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
| cross-vendor review (no public command) | public_blocked | none | cross_vendor_review/unavailable | independent vendor proof unavailable | — | — | RICKGENT_CROSS_VENDOR_UNAVAILABLE | Requested vendor labels are not independently observed identity. |
| rickgent status [--deep] | public_read_only | none | — | canonical SQLite lifecycle observation; --deep also runs the doctor health audit | — | — | — | Healthy observations exit 0; deep health failure exits 1; neither can terminalize a run. |
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
