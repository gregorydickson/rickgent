# Decision: macOS Containment Authority (t22B Backend Selection)

> Status: **proposed decision — awaiting user ratification.** This ADR records the M2 containment research and a recommended backend. It does not activate any capability. No source code under `orchestrator/src/` or `rickgent-policies/` was modified to produce it. t22B implementation executes only after the user ratifies this decision.

## Component

§2.3 of the mission architecture (`architecture.md`) and §"Containment feasibility" of `docs/remediation/phase-4-attempt-runner-design-audit-2026-07-18.md`: the validated all-descendant containment authority that the `AttemptRunner` (t22C) and the durable target start gate (t22A state bridge) require before any user code is released. The contract source of truth is `docs/architecture/reliability/trust-spine-contract.md` (frozen v1) and `docs/architecture/reliability/state-and-lifecycle-contract.md` (the `held -> released` / `held -> closed_never_released` target-start-gate edges owned by `TargetStartGateAuthority`).

## Context

The Phase 4 design audit established two independent stop-ship boundaries that decomposed t22 into t22A (state bridge), t22B (containment), t22C (AttemptRunner), and t22D (production cutover). The second boundary is that the repository has **no authoritative all-descendant containment backend**. `PosixProcessController` is correctly sampled-only: process groups and exact PID/start observations cannot close the fork/`setsid`/parent-exit sampling gap, and its structural `authoritative_containment` fields must not be trusted from an injected controller (invariant 4: sampled ancestry, process groups alone, `launchd`, Seatbelt, `pidfd`, and process-table enumeration cannot prove all-descendant death).

The audit's "Product decision required before t22B completion" framed the choice as either (a) provision and specify a validated external macOS containment authority while also implementing the Linux backend, or (b) narrow production execution support to Linux and keep macOS as a pre-release `RICKGENT_CONTAINMENT_UNAVAILABLE` platform. The user's default leaning (recorded in `library/environment.md` and the feature brief) is option A: Docker Desktop / Linux-VM cgroup-v2 backend. This ADR confirms or departs from that leaning based on the evidence.

### Host probe (read-only, 2026-07-20)

Probing was strictly read-only; nothing was installed and no long-lived containers were spawned.

| Probe | Result |
|---|---|
| `sw_vers` | ProductVersion 26.3, Build 25D125 (macOS Tahoe, Apple Silicon arm64) |
| `docker version --format '{{.Server.Version}}'` | 29.2.1 |
| `docker info --format '...'` | `ServerVersion=29.2.1 OSType=linux Architecture=aarch64 OperatingSystem=Docker Desktop CgroupDriver=cgroupfs CgroupVersion=2` |
| `docker run --rm --cgroupns=private alpine:latest cat /sys/fs/cgroup/cgroup.controllers` | `cpuset cpu io memory hugetlb pids rdma` (cgroup-v2, `pids`+`memory`+`cpu` present) |
| `docker run --rm --cgroupns=private alpine:latest ls -la /sys/fs/cgroup/cgroup.kill` | `--w------- root root ... /sys/fs/cgroup/cgroup.kill` (writable kill knob present) |
| `docker run --rm --cgroupns=private alpine:latest cat /sys/fs/cgroup/cgroup.events` | `populated 1 / frozen 0` (authoritative emptiness observable) |
| `docker run --rm alpine:latest uname -a` | `Linux ... 6.12.76-linuxkit #1 SMP Fri Mar 6 10:10:49 UTC 2026 aarch64` (modern cgroup-v2 kernel) |
| `which container` | `container CLI NOT installed` (Apple Containerization CLI absent) |

The Docker Desktop Linux VM exposes a real cgroup-v2 hierarchy with `cgroup.kill`, `cgroup.events` (`populated`), and the `pids`/`memory`/`cpu` controllers needed to bound and authoritatively kill an attempt subtree. The Apple `container` CLI is not installed; choosing option C would require installing it plus a new-dependency decision doc (CLAUDE.md rule 13).

## Contract obligations

A backend must satisfy every obligation in the trust-spine contract and the Phase 4 audit's "honest containment authority owns" list. The obligations evaluated below are:

1. **Backend probe / capability validation** — the adapter probes the backend read-only and refuses to mint a boundary if a required capability (kill knob, `populated` event, controllers) is missing.
2. **Unique boundary creation bound to attempt/owner generation/phase** — one cgroup (or equivalent) per attempt, named from authoritative lineage (run/ticket/attempt/owner-generation/phase), not reused across attempts or owners.
3. **Target launch or trusted-bootstrap enrollment before user-code release** — the target start gate transitions `held -> released` only after membership is authoritative; the worker enters the boundary before any user code runs.
4. **Terminate-all** — a single authority-owned operation kills every descendant (no per-PID enumeration).
5. **Bounded wait for authoritative empty boundary** — the adapter waits (bounded) for `cgroup.events populated=0` (or equivalent), not for sampled process-table emptiness.
6. **Runtime-unforgeable death receipt bound to exact launch and backend** — the receipt is minted by the authority-owned Store path, content-pins the exact launch, terminal, ownership, and backend lineage, and is rejected if any lineage differs (the consumer verifies the evidence content digest, not payload identifiers).
7. **Worker has no ancestor/sibling migration authority** — the worker cannot move itself or a sibling out of the boundary (no `cgroup.procs` write to an ancestor, no `setns` to a foreign cgroup, no `setsid` to escape the cgroup).
8. **Real corpus coverage** — spawn failure, timeout, stubborn descendants, output flood, ownership loss, crash recovery, kill, confirmed emptiness, and rapid double-fork/`setsid` escape attempts are each proven against the real backend.

## Options evaluated

### Option A — Docker Desktop / Linux VM with cgroup-v2 (default leaning)

The macOS host adapter is a thin VM-lifecycle + guest-cgroup proxy. Per attempt, it requests a Docker container with `--cgroupns=private`, creates a delegated child cgroup inside that container's private cgroup namespace, launches the worker into that child cgroup, and on termination writes `cgroup.kill` and waits (bounded) for `cgroup.events populated=0`. The boundary identity is the container ID + cgroup path, both bound to the attempt/owner/generation/phase lineage. The host adapter never trusts a structurally-correct `authoritative_containment` field from an injected controller; only the authority-owned Store path mints the death receipt.

| Obligation | Verdict | Evidence |
|---|---|---|
| 1. Backend probe / capability validation | **Satisfied** | `docker info` confirms `CgroupDriver=cgroupfs CgroupVersion=2`; probe verifies `cgroup.kill` writable, `cgroup.events` readable, `pids`+`memory`+`cpu` controllers present. Missing any → `RICKGENT_CONTAINMENT_UNAVAILABLE`. |
| 2. Unique boundary creation bound to attempt/owner/generation/phase | **Satisfied** | `--cgroupns=private` gives a fresh per-container cgroup namespace; the delegated child cgroup is named from the authoritative attempt/owner/generation/phase lineage. Docker container IDs are unique per spawn. |
| 3. Target launch / trusted-bootstrap enrollment before user-code release | **Satisfied** | The worker is launched into the cgroup before user code runs; the target start gate's `held -> released` edge fires only after the authority observes membership. |
| 4. Terminate-all | **Satisfied** | A single `echo 1 > cgroup.kill` kills every descendant in the cgroup subtree (kernel SIGKILL to all members); no per-PID enumeration. |
| 5. Bounded wait for authoritative empty boundary | **Satisfied** | `cgroup.events populated=0` is the kernel-authoritative emptiness signal; the adapter polls it with a bounded deadline. |
| 6. Runtime-unforgeable death receipt bound to exact launch and backend | **Satisfied** | The authority-owned Store path (reserved `authoritative_containment` producer label) mints the receipt; content-pins launch, terminal, ownership, and backend lineage. A structural lookalike from an injected controller is rejected. |
| 7. Worker has no ancestor/sibling migration authority | **Satisfied** | The worker runs inside the container's private cgroup namespace as a non-root user; it cannot write to ancestor `cgroup.procs` (no CAP_SYS_ADMIN, no host cgroup mount) and cannot `setns` to a foreign cgroup. |
| 8. Real corpus coverage | **Satisfied (provisionally — t22B proves)** | The kernel exposes every mechanism the corpus needs (cgroup-v2 kill, pidns, private cgroupns, memory/cpu/pids limits). The corpus is runnable inside `docker run --cgroupns=private`. Final satisfaction is the t22B proof corpus; this ADR asserts the backend can host it. |

### Option B — Apple Virtualization.framework with a Linux guest

A native Apple Silicon VM spawned via `Virtualization.framework`. The host adapter builds and owns the VM lifecycle; inside the guest, a Linux cgroup-v2 subtree (or a trusted PID-namespace init) provides the boundary. Death authority is VM shutdown plus `cgroup.kill` inside the guest.

| Obligation | Verdict | Evidence |
|---|---|---|
| 1. Backend probe / capability validation | **Partially satisfied** | The framework is present on macOS 26.3, but the adapter must probe guest kernel capabilities at VM boot. No turnkey CLI exposes a capability surface. |
| 2. Unique boundary creation bound to attempt/owner/generation/phase | **Satisfied** | One VM per attempt (or one cgroup per attempt inside a shared guest VM); naming from authoritative lineage is the adapter's responsibility. |
| 3. Target launch / trusted-bootstrap enrollment before user-code release | **Satisfied** | The guest init/cgroup enrollment runs before user code; the target start gate fires post-membership. |
| 4. Terminate-all | **Satisfied** | `cgroup.kill` inside the guest, or VM destruction. |
| 5. Bounded wait for authoritative empty boundary | **Satisfied** | `cgroup.events populated=0` inside the guest, or VM exit observation. |
| 6. Runtime-unforgeable death receipt bound to exact launch and backend | **Satisfied** | Same authority-owned Store path; backend identity is the VM+guest cgroup lineage. |
| 7. Worker has no ancestor/sibling migration authority | **Partially satisfied** | Inside a single shared guest VM, the worker could attempt cgroup escape unless the adapter enforces a private cgroup namespace + non-root + no CAP_SYS_ADMIN per attempt. Per-attempt VMs avoid this but at high resource cost. |
| 8. Real corpus coverage | **Partially satisfied** | The corpus is runnable inside a Linux guest, but the host adapter is greenfield code with no existing test substrate on this host. |

Option B satisfies the contract at the kernel level, but it requires building a custom VM lifecycle adapter (Swift or `Virtualization.framework` bindings) and a guest image management story that does not exist in the repository. It is a strictly larger implementation surface than option A for the same kernel-level authority.

### Option C — Apple Containerization framework (macOS 26 Tahoe)

Apple's Containerization framework (`github.com/apple/containerization`) plus the `container` CLI (`github.com/apple/container`) runs OCI Linux containers inside lightweight per-container VMs using Kata Containers. Each container is its own VM with a Swift `vminitd` as the sole init (PID 1), giving VM-exit as an authoritative all-descendant death signal. The `container` CLI is **not installed** on this host; choosing this option requires installing it plus a new-dependency decision doc (CLAUDE.md rule 13).

| Obligation | Verdict | Evidence |
|---|---|---|
| 1. Backend probe / capability validation | **Partially satisfied** | `container system info` (or equivalent) would be the probe surface, but the CLI is not installed; the capability surface cannot be probed without installation. |
| 2. Unique boundary creation bound to attempt/owner/generation/phase | **Partially satisfied** | Per-container VM identity is unique, but the OCI runtime presents a container-lifecycle abstraction, not a raw cgroup handle; binding to attempt/owner/generation/phase requires the adapter to map container IDs to lineage. |
| 3. Target launch / trusted-bootstrap enrollment before user-code release | **Satisfied** | `container run` starts the VM+init before user code; target start gate fires post-membership. |
| 4. Terminate-all | **Satisfied** | `container stop` (or VM destroy) kills every descendant via VM exit. |
| 5. Bounded wait for authoritative empty boundary | **Partially satisfied** | VM exit is authoritative death, but the framework exposes a container-lifecycle event, not `cgroup.events populated=0`. The adapter depends on Apple's event surface, which is access-policy-shaped rather than enumerable-membership-shaped. |
| 6. Runtime-unforgeable death receipt bound to exact launch and backend | **Satisfied** | Same authority-owned Store path; backend identity is the Apple Containerization VM/container lineage. |
| 7. Worker has no ancestor/sibling migration authority | **Satisfied** | Per-container VM isolation; the worker cannot reach a sibling's VM. |
| 8. Real corpus coverage | **Not satisfied (at decision time)** | The corpus cannot be run without installing the CLI and provisioning the Kata kernel image. Whether the framework exposes the membership/death primitives the corpus needs (vs. only access policy) is unverified. |

Option C is an OCI container runtime, not a raw cgroup authority. Its boundary is the VM (good for isolation) but its observable surface is container lifecycle events, not the `cgroup.kill`/`cgroup.events` knobs the contract names. It cannot be evaluated without installing a new runtime dependency, which CLAUDE.md rule 13 forbids without a separate decision doc. It is also macOS-26-only and (per the Anil Madhavapeddy deep dive, 2025-06) VM-per-container, which is memory-inefficient for a per-attempt boundary model.

### Option D — Linux-only production with macOS fail-closed

Implement the Linux cgroup-v2/PID-namespace backend natively on Linux. On macOS, the adapter probes for a backend, finds none, and the target start gate fails closed: it mints a `target-never-released` disposition receipt and exits with `RICKGENT_CONTAINMENT_UNAVAILABLE` before any user code is released.

| Obligation | Verdict (Linux) | Verdict (macOS) | Evidence |
|---|---|---|---|
| 1. Backend probe / capability validation | **Satisfied** | **Satisfied (fail-closed)** | Linux probes `/sys/fs/cgroup/cgroup.controllers` + `cgroup.kill`; macOS probe finds no backend and fails closed. |
| 2. Unique boundary creation | **Satisfied** | **Not applicable** | Linux cgroup per attempt; macOS never creates a boundary. |
| 3. Target launch / trusted-bootstrap enrollment | **Satisfied** | **Satisfied (fail-closed)** | Linux enrolls before release; macOS mints `target-never-released` and never releases. |
| 4. Terminate-all | **Satisfied** | **Not applicable** | `cgroup.kill` on Linux. |
| 5. Bounded wait for authoritative empty boundary | **Satisfied** | **Not applicable** | `cgroup.events populated=0` on Linux. |
| 6. Runtime-unforgeable death receipt | **Satisfied** | **Satisfied (target-never-released receipt)** | Linux mints death receipt; macOS mints the never-released receipt via the LeaseAuthority-branded mint capability. |
| 7. Worker has no ancestor/sibling migration authority | **Satisfied** | **Not applicable** | Private cgroupns + non-root + no CAP_SYS_ADMIN on Linux. |
| 8. Real corpus coverage | **Satisfied (provisionally — t22B proves)** | **Not applicable** | Linux corpus runnable on a real Linux host; macOS has no corpus to run. |

Option D is the contract-purest fallback: it makes no macOS authority claim, fails closed honestly, and is the safest default if no macOS authority is provisioned. Its cost is that macOS becomes a pre-release-only platform — every macOS build attempt terminates with `RICKGENT_CONTAINMENT_UNAVAILABLE` before user code runs.

## Decision

**Recommend option A — Docker Desktop / Linux-VM cgroup-v2 backend — as the t22B containment backend on macOS, with option D as the fail-closed fallback on every host where the option A probe does not pass.**

This confirms the user's default leaning. The host probe verified that the Docker Desktop Linux VM exposes a real cgroup-v2 hierarchy with `cgroup.kill`, `cgroup.events populated`, and the `pids`+`memory`+`cpu` controllers the contract names. The macOS host adapter is a thin VM-lifecycle + guest-cgroup proxy; the kernel-level authority is the same cgroup-v2 mechanism the Linux backend uses, just observed through the Docker container's private cgroup namespace. No new runtime dependency is introduced (Docker Desktop is already installed and running; it is a developer-machine tool, not a rickgent package dependency). Where Docker Desktop is absent or its probe fails, the adapter falls back to option D behavior: the target start gate mints `target-never-released` and exits `RICKGENT_CONTAINMENT_UNAVAILABLE` before user code is released.

The t22B implementation must prove every contract obligation against the real platform corpus (obligation 8) inside `docker run --rm --cgroupns=private`. This ADR asserts the backend can host the corpus; t22B's proof corpus is the final authority.

## Rejection rationale

- **Option B (Apple Virtualization.framework with Linux guest).** Rejected as the M2 default because it requires building a custom Swift/`Virtualization.framework` VM-lifecycle adapter and a guest-image management story that does not exist in the repository. The kernel-level authority it would provide is identical to option A's (cgroup-v2 inside a Linux guest), but at a strictly larger implementation surface and with no existing test substrate on this host. It remains a viable future option if Docker Desktop becomes unavailable or if per-attempt VM isolation becomes a hard requirement.
- **Option C (Apple Containerization framework).** Rejected at this decision boundary for three independent reasons. (1) The `container` CLI is not installed and cannot be evaluated without installing it, which CLAUDE.md rule 13 forbids without a separate new-dependency decision doc — that doc is out of scope for this research feature and must return to the user for a dependency decision. (2) Its observable surface is OCI container lifecycle events, not the `cgroup.kill`/`cgroup.events` membership/death primitives the contract names; whether it exposes enumerable membership + authoritative death, or only access policy, is unverified. (3) It is macOS-26-only and VM-per-container, which is memory-inefficient for a per-attempt boundary model on a busy host (load average ~19). It remains a candidate for a future new-dependency decision if the user wants a Docker-Desktop-free macOS path.
- **Option D (Linux-only production with macOS fail-closed).** Not rejected — adopted as the **fail-closed fallback** for any host where option A's probe does not pass. It is the contract-purest option and the safest default if no macOS authority is provisioned. It is not the M2 recommendation only because the user's leaning and the host probe make option A available now without a new install.

## Supported platform matrix

| Platform | Production execution | Mechanism | Fail-closed result |
|---|---|---|---|
| macOS (Docker Desktop 29.x running, cgroup-v2 probe passes) | **Supported via option A** | Docker container `--cgroupns=private` + delegated child cgroup; `cgroup.kill` + `cgroup.events populated=0` | If probe fails: `RICKGENT_CONTAINMENT_UNAVAILABLE` + `target-never-released` |
| Linux (native cgroup-v2, `cgroup.kill` present) | **Supported via option D native path** | Native cgroup-v2 subtree; same kill/events mechanics | If probe fails: `RICKGENT_CONTAINMENT_UNAVAILABLE` + `target-never-released` |
| macOS without Docker Desktop (or probe fails) | **Pre-release only** | None — fail closed | `RICKGENT_CONTAINMENT_UNAVAILABLE` + `target-never-released` before user code release |
| Windows | **Unsupported (existing contract)** | None | `RICKGENT_PLATFORM_UNSUPPORTED` (existing trust-spine contract) |

This matrix changes the supported-platform section of `trust-spine-contract.md`/`.json`: macOS production execution now requires Docker Desktop (or an equivalent validated cgroup-v2-bearing Linux VM). The trust-spine contract previously named POSIX macOS and Linux as supported remediation platforms without specifying the macOS containment provision. This ADR records that provision.

## Installation / provisioning requirements

- **Option A (macOS production).** Docker Desktop must be installed, running, and configured for cgroup-v2 (the default for Docker Desktop 29.x on Apple Silicon). The host adapter probes `docker info` for `CgroupVersion=2` and `docker run --rm --cgroupns=private alpine:latest` for `cgroup.kill` + `cgroup.events` + the `pids`/`memory`/`cpu` controllers. A pull of `alpine:latest` is permitted on first probe (transient, `--rm`). No rickgent package dependency is introduced.
- **Option D (Linux production).** A real Linux host with cgroup-v2 mounted at `/sys/fs/cgroup` and `cgroup.kill` present. The adapter probes `/sys/fs/cgroup/cgroup.controllers` for `pids`+`memory`+`cpu` and `/sys/fs/cgroup/cgroup.kill` for writability.
- **Fail-closed (any host where the probe fails).** No installation. The adapter mints `target-never-released` and exits `RICKGENT_CONTAINMENT_UNAVAILABLE` (exit class `capability_unavailable`, code 3).

## Fail-closed behavior

On any host where the chosen backend's probe does not pass, the `TargetStartGateAuthority`-owned `held -> closed_never_released` edge fires: the authority mints a `target-never-released` disposition receipt via the `LeaseAuthority`-branded mint capability, binding the held target start gate (state_version 0) to the exact attempt ownership/generation/context lineage, and the CLI exits with `RICKGENT_CONTAINMENT_UNAVAILABLE` (exit class `capability_unavailable`, code 3). No terminal receipt is manufactured. No user code is released. This is the same behavior option D specifies for macOS-without-Linux; it is the universal fallback for every unsupported or probe-failing host.

A structurally-correct `authoritative_containment` field supplied by an injected controller is **not trusted**. Only the authority-owned backend can mint a death receipt (invariant 2; t22B negative proof `VAL-T22B-005`).

## Consequences

- **Positive.** macOS remains a production execution platform with no new rickgent package dependency; the kernel-level authority is the same cgroup-v2 mechanism the Linux backend uses, so one backend implementation covers both macOS-via-Docker and Linux-native, differing only in the host adapter (VM-lifecycle proxy vs. native cgroup proxy).
- **Positive.** The fail-closed fallback (option D) is universal and contract-pure: any host that fails the probe terminates honestly with `target-never-released`, so the system never claims a containment authority it cannot prove.
- **Positive.** Option C is explicitly left for a future new-dependency decision rather than silently引入ing a runtime dependency, preserving CLAUDE.md rule 13.
- **Negative.** macOS production execution now depends on Docker Desktop being installed and running. A developer machine without Docker Desktop is a pre-release-only platform. This is documented in the platform matrix and the fail-closed behavior.
- **Negative.** The Docker Desktop VM is a shared Linux kernel across containers, so the adapter must enforce per-attempt private cgroup namespaces + non-root + no CAP_SYS_ADMIN to satisfy obligation 7. The t22B corpus must prove this against rapid double-fork/`setsid` escape attempts.
- **Neutral.** Option B remains available as a future direction if Docker Desktop becomes unavailable or per-attempt VM isolation becomes a hard requirement.

## Implementation boundary for t22B

This ADR sets the following boundary for the t22B implementation feature:

1. **Backend.** Implement the cgroup-v2 backend (option A's host adapter + option D's native Linux path; they share the kernel-level authority, differing only in the host probe and cgroup mount path).
2. **Probe.** The backend probe is read-only, fails closed on any missing capability, and is the sole authority for whether the backend is available.
3. **Boundary.** One cgroup per attempt, named from authoritative attempt/owner/generation/phase lineage, inside a private cgroup namespace (Docker `--cgroupns=private` on macOS; native cgroup-v2 on Linux).
4. **Death.** `cgroup.kill` for terminate-all; bounded wait for `cgroup.events populated=0` for authoritative emptiness; authority-owned Store path mints the runtime-unforgeable death receipt content-pinned to the exact launch, terminal, ownership, and backend lineage.
5. **Integration.** Integrate with `ProcessSupervisor` and the durable target start gate (`TargetStartGateAuthority`) so target code cannot begin before membership is authoritative (the `held -> released` edge).
6. **Fail-closed.** Unavailable containment produces a pre-release infrastructure error and a `target-never-released` proof; no terminal receipt is manufactured (`held -> closed_never_released` edge).
7. **Corpus.** Prove obligation 8 against the real platform corpus: spawn failure, timeout, stubborn descendants, output flood, ownership loss, crash recovery, kill, confirmed emptiness, and rapid double-fork/`setsid` escape.
8. **No activation.** Capability activation (autonomous_dispatch) remains closed until t22A–t22D all pass; this ADR activates nothing.

## Countersign

- **Reviewer:** pending — this is a proposed decision awaiting user ratification. The M2 feature returns to the orchestrator for user ratification before t22B implementation begins.
- **Date:** 2026-07-20
