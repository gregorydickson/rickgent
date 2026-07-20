# Rickgent trust-spine execution contract v1

Status: frozen architecture decision. This document and its machine-readable companion constrain later implementation; they do not enable a capability.

The authoritative machine contract is `trust-spine-contract.json`. Ticket identity is defined by `ticket-contract.schema.json`, and the checked examples under `orchestrator/test/fixtures/ticket-contract` are part of this decision.

## Activation boundary

Every capability defaults to unavailable. A decision artifact, fixture, mock, source label, or passing unit test cannot activate production behavior. Activation requires the named proof corpus in its supported runtime profile, a separately reviewed registry transition, and agreement among the CLI, direct-library boundary, `doctor`, and documentation.

At Milestone 1, autonomous dispatch is `fixture_only`. The fixture seam may capture a delta in a dedicated run worktree, but it cannot claim `verified`, `ready_for_delivery`, `delivered`, or `Done`. Public autonomous mutation remains unavailable until native policy enforcement lands in M2. Parallel dispatch, resume/retry, reconciliation, cross-vendor review, automatic delivery, and raw shell are unavailable.

## Strict TicketContract

TicketContract v1 is strict executable identity, not tolerant Markdown. It has explicit ticket and acceptance-criterion IDs, dependencies, owned interfaces, canonical scope/change kinds, structured verification argv, budgets, remediation limits, and a digest. Unknown fields fail validation.

The normalizer runs before run allocation and rejects:

- duplicate or unknown IDs and references, dependency cycles, empty scope, and unsafe active-ticket overlap;
- absolute, traversing, non-canonical, Git-administrative, state-root, escaping-symlink, and submodule paths;
- change-kind mismatches, duplicate paths, malformed rename/delete declarations, and observed no-op deltas;
- raw shell commands, malformed argv/cwd/environment/output declarations, network-enabled verification, and unbounded timeouts;
- a missing, malformed, or mismatched digest.

The canonical digest is SHA-256 over UTF-8 Rickgent Canonical JSON v1 bytes with the top-level `digest` field omitted. The admitted TicketContract domain uses strings, booleans, arrays, objects with ASCII schema keys, and safe integers. Object keys sort lexicographically, array order is preserved, and primitive encoding follows JSON. This is RFC-8785-equivalent for the admitted domain. Any executable-field change changes the digest.

Schema validation is structural. The production normalizer must additionally resolve each declaration against the target repository, using the nearest existing parent for creates, and reject symlink escape, submodule crossing, reserved roots, and unsafe overlap before allocation.

Verification entries are argv-only. `executable` and `args[]` are passed directly to the supervisor; there is no `sh -c`, command interpolation, or shell source text. Missing sandbox or toolchain support is an infrastructure error, not a skipped or green gate.

## Repository identity and state root

Repository identity combines the realpath of the target repository with its canonical Git common directory. The orchestrator derives the latter with array argv equivalent to:

```text
git -C <target-repository> rev-parse --path-format=absolute --git-common-dir
```

The default state database is `<canonical-git-common-dir>/rickgent/state.sqlite3`; its directory and file modes are 0700 and 0600. Caller CWD never selects state. A symlinked, escaping, or otherwise unsafe root fails with `RICKGENT_STATE_ROOT_UNSAFE`.

## State graphs and transition ownership

Attempt execution follows this graph:

```text
planned -> implementing -> implementation_captured -> reviewing
reviewing -> verification_queued -> verifying -> converging -> cleanup_pending
reviewing -> remediating -> remediation_captured -> reviewing
cleanup_pending -> oracle_evaluation -> verified
cleanup_pending -> failed_clean | quarantined
```

Timeout is not terminal. Attempts terminate only as `failed_clean`, `quarantined`, or `verified`, after cleanup evidence. Only the transactional transition service writes attempt transitions.

Tickets may become `ready_for_delivery` only through the versioned completion oracle plus finalization service. Runs may become `delivered` only through the delivery service after all tickets are ready and the observed remote branch and PR head equal the delivery OID. `Done` is an alias only for delivered. Workers, phase runners, reconcile, status, and CLI handlers have no terminal writer API.

Required gate values `missing`, `null`, `skipped`, `unavailable`, `infrastructure_error`, `stale`, and `conflicting` all block advancement.

## Capability registry and public M1 matrix

| Capability | M1 state | Stable code | Earliest proof boundary |
|---|---|---|---|
| autonomous dispatch | fixture_only | `RICKGENT_AUTONOMOUS_FIXTURE_ONLY` | native-policy lifecycle proof |
| parallel dispatch | unavailable | `RICKGENT_PARALLEL_DISPATCH_UNAVAILABLE` | explicit post-M4 activation |
| resume/retry | unavailable | `RICKGENT_RESUME_UNAVAILABLE` | M5 recovery/oracle parity |
| reconciliation | unavailable | `RICKGENT_RECONCILIATION_UNAVAILABLE` | M5 recovery/oracle parity |
| cross-vendor review | unavailable | `RICKGENT_CROSS_VENDOR_UNAVAILABLE` | M6 observed identity proof |
| automatic delivery | unavailable | `RICKGENT_DELIVERY_UNAVAILABLE` | M6 delivery proof |
| raw shell | unavailable | `RICKGENT_RAW_SHELL_UNAVAILABLE` | no activation profile |

Production environment variables cannot override this registry. Test-only state injection is an explicit test dependency unavailable to production entry points.

| Public M1 surface | Mutation authority | Result |
|---|---|---|
| `build`, `pipeline` | none | `RICKGENT_AUTONOMOUS_FIXTURE_ONLY` |
| fixture dispatch API | dedicated run worktree, capture only | nonterminal receipt |
| resume/retry | none | `RICKGENT_RESUME_UNAVAILABLE` |
| reconcile | none | `RICKGENT_RECONCILIATION_UNAVAILABLE` |
| parallel dispatch | none | `RICKGENT_PARALLEL_DISPATCH_UNAVAILABLE` |
| push/PR delivery | none | `RICKGENT_DELIVERY_UNAVAILABLE` |
| status, doctor, help | read-only | success |

The fixture dispatcher directly materializes `agents/rickgent/agents/worker` for the attempt. The manager bundle is never its spawn target. The worker cannot mutate Git or terminalize work.

## Supervisor and sandbox profiles

One POSIX supervisor owns workers, reviewers, remediation, verification, and integration. It uses array argv, a new process group, an allowlisted environment plus trusted final values, bounded stdout/stderr files with hashes and tails, TERM grace followed by KILL, and confirmed group death before resource release.

Verification adds a mandatory sandbox:

- supported macOS uses `/usr/bin/sandbox-exec` with a generated deny-by-default profile;
- supported Linux uses `bwrap` with a deny-by-default mount/network namespace;
- Windows fails fast with `RICKGENT_PLATFORM_UNSUPPORTED`; it is not a partially supported mode.

Both profiles deny network, omit credentials, expose target input read-only, deny the Git common directory/ref/index, and permit writes only to normalized TicketContract `writable_outputs` beneath attempt-owned output roots. Timeout, process count, memory, stdout, and stderr are bounded. A missing `sandbox-exec`, `bwrap`, namespace feature, supervisor, or required tool produces `RICKGENT_SANDBOX_INFRASTRUCTURE_ERROR` or `RICKGENT_TOOLCHAIN_INFRASTRUCTURE_ERROR`.

## Orchestrator-owned commit authority

Only the orchestrator creates an authoritative commit. The worker may edit its attempt worktree through structured tools but cannot run Git mutation.

Before commit creation, the orchestrator proves the worker process group is dead, ownership/lease receipts are current, baseline HEAD and Git common directory match allocation, review and verification are green, and the non-empty observed delta exactly matches normalized paths, change kinds, and modes. Foreign commits, moved refs, unexpected dirt, symlinks, submodule changes, unexpected delete/rename, and out-of-scope paths fail closed.

The commit service uses an isolated index and exact owned paths; `git add -A` is forbidden. It creates one commit whose sole parent is the attempt baseline and records baseline, parent, trees, commit OID, TicketContract and context digests, verification receipt digests, and path/kind/mode transitions.

The full commit service is assigned to t20. Therefore t06 is explicitly mutation-capture/fixture-only and cannot use current worker-created commits as success evidence.

## Exit and error ownership

The CLI alone selects a process exit code from a typed lifecycle result:

| Class | Exit | Stable code |
|---|---:|---|
| success | 0 | `RICKGENT_OK` |
| input/contract | 2 | `RICKGENT_INPUT_CONTRACT_ERROR` |
| unavailable capability | 3 | `RICKGENT_CAPABILITY_UNAVAILABLE` |
| infrastructure | 4 | `RICKGENT_INFRASTRUCTURE_ERROR` |
| execution | 5 | `RICKGENT_EXECUTION_FAILED` |
| verification | 6 | `RICKGENT_VERIFICATION_FAILED` |
| cleanup | 7 | `RICKGENT_CLEANUP_FAILED` |
| delivery | 8 | `RICKGENT_DELIVERY_FAILED` |
| internal defect | 70 | `RICKGENT_INTERNAL_ERROR` |

Lifecycle modules do not call `process.exit`. Missing sandbox/toolchain and unsupported Windows are infrastructure failures. Zero completion, partial failure, no-op, failed evidence, and cleanup failure are nonzero.

## Toolchain and doctor contract

The frozen repository toolchain is Node `>=24.0.0 <25.0.0`, Python `>=3.12.0 <3.15.0`, and pnpm `10.22.0` with lockfile format 9. Supported remediation platforms are POSIX macOS and Linux. Package metadata is the machine-owned copy and the validator rejects drift.

## Supported platforms for production execution

Production attempt execution requires a validated all-descendant containment authority (the t22B backend; see `docs/decisions/macos-containment-authority.md`). The platform matrix is:

| Platform | Production execution | Containment mechanism | Fail-closed result |
|---|---|---|---|
| macOS (Docker Desktop running, cgroup-v2 probe passes) | Supported | Docker container `--cgroupns=private` + delegated child cgroup; `cgroup.kill` + `cgroup.events populated=0` | `RICKGENT_CONTAINMENT_UNAVAILABLE` + `target-never-released` |
| Linux (native cgroup-v2, `cgroup.kill` present) | Supported | Native cgroup-v2 subtree; same kill/events mechanics | `RICKGENT_CONTAINMENT_UNAVAILABLE` + `target-never-released` |
| macOS without Docker Desktop (or probe fails) | Pre-release only | None — fail closed | `RICKGENT_CONTAINMENT_UNAVAILABLE` + `target-never-released` |
| Windows | Unsupported (unchanged) | None | `RICKGENT_PLATFORM_UNSUPPORTED` |

The macOS production path depends on Docker Desktop (or an equivalent validated cgroup-v2-bearing Linux VM). The probe is read-only and is the sole authority for backend availability. A host that fails the probe fails closed with a `target-never-released` disposition receipt before any user code is released; no terminal receipt is manufactured.

Planning verification uses installed repository-local binaries through `npm exec --offline` and `npm run`; it does not assume a globally installed pnpm or Corepack activation. Release/package workflows remain bound to the pinned pnpm metadata and lockfile.

`doctor --json` must emit parseable JSON with schema version `1.0.0`, release channel `reliability_preview`, the complete capability registry, toolchain status, and terminal semantics identifying `ready_for_delivery` as `local_oracle_complete` and delivered as `remote_delivery_verified`. Merely exiting zero is not proof of this contract.
