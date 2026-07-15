# Rickgent Project Completion, Reliability, and Conceptual Integrity Review

**Review date:** 2026-07-15  
**Reviewed commit:** `6c9eee8689f9d6e8a5cb63f1a9335f0e98b18834` (`main`)  
**Review mode:** Read-only Anatomy Park review phase; no fixes applied  
**Primary emphasis:** reliability, data-flow correctness, completion truth, and conceptual integrity

## Executive verdict

Rickgent is **not complete or release-ready as the autonomous, multi-vendor, fail-closed engineering platform described by its README and changelog**.

The project has a credible foundation: the TypeScript verdict core is small and well tested, the CLI toolbelt has real implementations, the dispatch ledger and evidence model show disciplined intent, and the test suites are broad. The problem is not a lack of code. The problem is that the live integration paths do not preserve the meanings claimed by the architecture.

The central release blockers are:

1. The attached Python policies are operationally inert through Omnigent's real runtime event/config ABI.
2. The production build is an implementation-only dispatcher, not the advertised eight-phase or nine-gate lifecycle.
3. Model routing changes ledger labels but not the harness or model that executes.
4. Failed tickets and failed gates can still produce exit code 0 and a pull request.
5. Concurrent workers share one Git worktree, branch, index, and `HEAD`, so completion is not attributable to a worker.
6. Resume/rerun identity reuses terminal attempts, while reconcile can manufacture `Done` from unrelated commit-message prose.
7. Locking, timeout, salvage, PR creation, and persistent state each contain failure modes that violate the stated durability and fail-closed contracts.

The appropriate product label today is **alpha orchestration prototype with a strong pure core and extensive fixture coverage**. The current `v0.3.0`, "complete, reviewed, merge-ready," "multi-vendor," and "fail closed everywhere" claims should be treated as unverified until the P0 remediation plan is complete.

## Review scope and method

The review team independently covered:

- end-to-end architecture and producer/consumer data flows;
- process, filesystem, Git, timeout, lock, recovery, and shell reliability;
- PRD/README/ADR claims versus production code;
- test integrity, packaging, install, versioning, and completion signals;
- complexity, duplication, dead scaffolds, and simplification opportunities.

The most important checks followed the actual runtime path rather than calling helpers in isolation. In particular, a native Omnigent `FunctionPolicy` event was constructed and passed to the Rickgent policy shims. That probe exposed the primary policy bypass described below.

## Actual production data flow

```text
PRD markdown
  -> parsePrdFile
  -> evaluatePrd
  -> recordRun(requestedRunId)
  -> seedRegistry (may preserve an older runId)
  -> DispatchQueue
       dispatchId = runId/ticketId/implement/1/worker
  -> routeDispatch
       returns {harness, model, vendor}
       build retains only vendor
  -> Dispatcher
       omnigent run <fixed-agentDir> -p <prompt>
       isolated chat.db per dispatch
       shared Git repo/branch/index/HEAD for all dispatches
  -> completion evidence
       new conversation + transcript
       current shared HEAD vs spawn baseline
       at least one changed path in declared scope
       evaluateCompletion(gateGreen = null)
  -> registry ticket = Done at phase implement
  -> acceptance-criterion shell commands
       failures are recorded but do not block
  -> six-regex deslop scan
       findings are recorded but do not block
  -> feature branch created after worker commits
  -> push command policy-checked but not executed
  -> gh pr create
  -> optional orphan reap + in-memory reconcile
```

The only genuinely per-dispatch isolated state is the Omnigent chat database. Git state, delivery branch, registry identity, and most durable ledgers are shared.

## Completion matrix

| Area | Assessment | Basis |
|---|---|---|
| Pure verdict core | Implemented | Completion, convergence, scope, PRD, salvage, and breaker functions are executable and well covered. |
| CLI toolbelt | Implemented, not production-hardened | Seven advertised commands have real entry points and tests. Several share state, parsing, packaging, and subprocess defects. |
| Dispatch queue/evidence | Substantially implemented, unsafe under production concurrency | DB/transcript evidence is isolated; Git evidence is shared and non-attributable. |
| Python policy shims | Implemented in isolation, disconnected at runtime | Static attachment succeeds, but native Omnigent events miss every Rickgent trigger. |
| Eight-phase lifecycle | Scaffold only | `phase.ts` is not imported by production; builds dispatch only `implement`. |
| Nine-gate pipeline | Not implemented as claimed | Review/convergence phases are absent; conformance/deslop do not gate delivery. |
| Multi-vendor routing | Label-only | Selected harness/model never controls the spawned agent. |
| Completion semantics | Incorrect | Total failure can be success; partial failure can ship. |
| Resume/retry | Incorrect | Run/attempt identity collides with terminal ledger entries. |
| Reconcile | Unsafe and non-durable | Historical commit text can create `Done`; CLI does not persist rebuilt state. |
| Git/process isolation | Missing | Concurrent workers use one worktree and branch. |
| Installer/release | Incomplete | No CLI link, unused dependency pin, version drift, broken lint, incomplete package. |
| Documentation | Materially overclaims | README/CHANGELOG/ADRs describe gates and routing that are not live. |

## Release-blocking findings

### C1. Custom policies are inert through the real Omnigent runtime ABI

**Severity:** Critical

Omnigent's current `FunctionPolicy` constructs events shaped as `{type, target, data, context, ...}` and passes only the policy's static YAML `config:` as the second argument:

- `/Users/gregorydickson/loanlight/pickle-rick/omnigent/omnigent/policies/function.py:112-145`
- `/Users/gregorydickson/loanlight/pickle-rick/omnigent/omnigent/policies/function.py:170-255`

Rickgent's shims instead read legacy top-level fields:

- scope: `rickgent-policies/rickgent_policies/__init__.py:437-499`
- completion: `rickgent-policies/rickgent_policies/__init__.py:510-541`
- convergence: `rickgent-policies/rickgent_policies/__init__.py:558-613`
- subtract-before-add: `rickgent-policies/rickgent_policies/__init__.py:618-638`
- cross-vendor review: `rickgent-policies/rickgent_policies/__init__.py:643-664`
- autonomous PR flow: `rickgent-policies/rickgent_policies/__init__.py:669-877`

The manager and worker bundles attach the functions but provide no dynamic `config:` containing `ticket_id`, `declared_paths`, `worktree_root`, phase, or vendor identity:

- `agents/rickgent/config.yaml:45-80`
- `agents/rickgent/agents/worker/config.yaml:46-80`

A direct native-shaped probe produced:

```text
event keys: context, data, llm_client, session_state, target, type
target: sys_os_write
scope_fence            => ALLOW
completion_evidence    => ALLOW
convergence_gate       => ALLOW
subtract_before_add    => ALLOW
cross_vendor_review    => ALLOW
autonomous_pr_flow     => abstain
```

The event attempted an out-of-scope `sys_os_write` to `../../outside.txt`. The bypass occurs before scope logic: `scope_fence` sees no top-level `tool_name` and treats the call as unrelated.

The policy attachment gate in `orchestrator/src/lifecycle/build.ts:735-797` proves only that policy names statically parse and resolve. It does not prove runtime event compatibility, required config, or enforcement.

**Impact:** The core safety story is not live. Scope, completion, convergence, simplification, cross-vendor review, and PR-flow policies do not enforce their intended conditions on native Omnigent events.

**Required direction:** Define one versioned adapter from the Omnigent event/config ABI to a canonical Rickgent policy event. Populate authenticated per-dispatch context dynamically. Test every policy through a real `FunctionPolicy`/policy engine, not by calling handlers directly.

### C2. Production never traverses the advertised lifecycle or review phases

**Severity:** Critical

`orchestrator/src/lifecycle/phase.ts:4-53` defines eight phases, but its production import graph is empty. Build creates only:

```ts
{ runId, ticketId, phase: "implement", attempt: 1, role: "worker" }
```

at `orchestrator/src/lifecycle/build.ts:365-373`, then marks the ticket `Done` immediately after that dispatch at `orchestrator/src/lifecycle/build.ts:488-499`.

There is no production research, research review, plan, plan review, spec conformance worker, code-review worker, simplify phase, context clearing, reviewer fix loop, or phase advancement. The branch that would pass an implementer's vendor to a `code_review` route at `build.ts:410-417` is unreachable because all real IDs have role `worker`.

`runPipeline` adds only orphan cleanup and reconcile (`build.ts:714-718`); it does not run convergence. Completion permanently calls the oracle with `gateGreen: null` (`orchestrator/src/dispatch/evidence.ts:234-254`).

**Impact:** `Done` means "one implementation worker produced a commit-like delta," not "the ticket completed the reviewed lifecycle." Cross-review and convergence claims are false at the primary product path.

**Required direction:** Either wire one explicit, persisted phase state machine end-to-end or reduce the product contract to the smaller executor that actually exists. Do not retain a dead phase model alongside a different production workflow.

### C3. Multi-vendor routing changes metadata, not execution

**Severity:** Critical

The router returns `harness`, `model`, and `vendor` (`orchestrator/src/lifecycle/routing.ts:18-38`). Build keeps only `selection.vendor` (`orchestrator/src/lifecycle/build.ts:469-485`). `DispatchOptions` has no harness/model fields, and Dispatcher always runs the same bundle:

```text
omnigent run <agentDir> -p <prompt>
```

at `orchestrator/src/dispatch/dispatch.ts:317-329`.

The bundles remain hardcoded to Claude/Anthropic:

- manager: `agents/rickgent/config.yaml:11-19`
- worker: `agents/rickgent/agents/worker/config.yaml:15-22`

A roster can therefore select OpenAI/Codex, while Anthropic/Claude executes and the ledger records `vendor: openai`.

**Impact:** Model cost, vendor independence, and cross-vendor review evidence are labels detached from runtime truth.

**Required direction:** Pass the selected harness/model into the actual spawn contract and persist the model identity observed from the session. Refuse completion if selected and observed identities differ.

### C4. Total or partial failure can be reported and shipped as success

**Severity:** Critical

After queue drain, build counts failures at `orchestrator/src/lifecycle/build.ts:537-544`, but:

- zero completed tickets returns `{ok: true, exitCode: 0}` at `build.ts:645-650`;
- one completed ticket is enough to reach PR creation even if other tickets failed (`build.ts:653-674`);
- failing acceptance criteria only append salvage records (`build.ts:559-588`);
- deslop findings only append records (`build.ts:593-615`).

Concrete scenarios:

- With no roster, every dispatch is denied, no work runs, and build exits successfully.
- With two tickets, one can complete and one fail; failed ACs and quality findings do not stop the PR.
- A ticket can be `Done` before any global gate executes, and no later result revokes it.

The E2E tests certify the presence of report words, not blocking behavior. Their gate markers include broad regexes such as `/router|routing|roster|vendor/` (`orchestrator/test/lifecycle/e2e-gated-pipeline.test.ts:140-179`), and the suite explicitly expects conformance/deslop-disabled builds to exit 0 and create PRs (`:251-305`).

**Impact:** The top-level completion signal is false. "Absorbed" failure currently means "allowed to ship."

**Required direction:** A build may return success or create a PR only if every planned ticket reaches the terminal reviewed phase and every required gate passes. A legitimate no-op must be explicit and independently proven.

### C5. Parallel completion is not attributable because workers share Git state

**Severity:** Critical

Default concurrency is two (`orchestrator/src/lifecycle/build.ts:344-350`). The queue pumps jobs concurrently (`orchestrator/src/dispatch/queue.ts:129-151`), and all children use the same target repository as `cwd` (`orchestrator/src/dispatch/dispatch.ts:317-320`).

Completion reads whichever shared `HEAD` exists when a worker exits and diffs it against that worker's spawn baseline (`orchestrator/src/dispatch/evidence.ts:56-91`). It requires at least one in-scope path but does not reject out-of-scope changes or prove that the current commit belongs to the dispatch (`evidence.ts:226-255`). It also does not prove that current `HEAD` descends from the baseline.

Runtime failures include:

- `.git/index.lock` and branch-update races;
- worker A receiving worker B's commit as A's completion SHA;
- overlapping scopes allowing one commit to satisfy multiple tickets;
- one worker's checkout/reset invalidating every other baseline;
- a commit containing one in-scope file plus arbitrary foreign changes passing completion.

The fixture serializes its own Git operations, but production creates no Git worktrees.

**Impact:** Git-tree truth is being sampled, not attributed. Under concurrency it cannot prove who changed what.

**Required direction:** Give each dispatch a dedicated worktree, branch/ref, index, and baseline. Bind completion to a dispatch-owned descendant commit. Reject overlapping scopes or serialize them until isolation exists.

### C6. Run and attempt identity makes reruns and resume replay old terminal entries

**Severity:** Critical

`seedRegistry` preserves an existing `registry.runId` even for a new non-resume build (`orchestrator/src/lifecycle/build.ts:194-218`). Every ticket uses `attempt: 1` (`build.ts:365-373`). Dispatcher returns a prior terminal entry without spawning (`orchestrator/src/dispatch/dispatch.ts:204-211`). `failed` and `timed_out` are terminal (`dispatch.ts:61-63`).

Consequences:

- a new PRD with the same ticket ID can reuse an old success or failure;
- a failed ticket cannot actually retry under `--resume`;
- a changed ticket description or scope is ignored when the old dispatch ID collides;
- `ticketsDispatched` increments even when Dispatcher returns a cached terminal entry (`build.ts:537-543`).

The resume test checks the counter and that a completed ticket was not respawned, but never proves the failed ticket spawned or became `Done` (`orchestrator/test/lifecycle/build-loop.test.ts:223-249`). The consecutive E2E test avoids the issue by using a fresh `.rickgent-2` for run two (`orchestrator/test/lifecycle/e2e-gated-pipeline.test.ts:217-229`).

Metrics also records `requestedRunId` before `seedRegistry` chooses the older effective run ID (`build.ts:249-253,329`), splitting one execution across identities.

**Required direction:** Generate a new immutable run identity for every ordinary build. Resume must target a specific run. Increment and persist attempt before dispatch. Include a stable ticket-contract hash in idempotency decisions.

### C7. Reconcile can manufacture `Done` from unrelated history

**Severity:** Critical

Reconcile runs `git log --oneline --all` and treats any commit subject matching `ticket: <id>` as `Done` (`orchestrator/src/lifecycle/reconcile.ts:116-143`). This path does not invoke the completion oracle and has no run identity, structured trace, DB/transcript evidence, declared scope, baseline, ancestry, phase, or gate evidence.

Git-derived entries override ledger evidence (`reconcile.ts:170-186`). Ledger entries from all runs are also collapsed by ticket ID (`reconcile.ts:145-170`). Resume then skips any IDs reconciled as `Done` (`orchestrator/src/lifecycle/build.ts:331-360`).

Finally, `rickgent reconcile` only prints the returned object and never writes `registry.json` (`orchestrator/src/cli.ts:248-268`). Cleanup calls this non-persisting function while reporting that the registry was rebuilt.

**Impact:** A historical documentation commit such as `ticket T1 notes` can satisfy a current ticket, while a real rebuild is not durable.

**Required direction:** Reconcile only structured, signed/validated trace records tied to a run and attempt. Every `Done`, including Git-derived state, must pass the same completion oracle and phase/gate requirements. Persist rebuilt state atomically.

### C8. Locking and timeout release ownership before safety is established

**Severity:** Critical

`TicketLock.acquire` is a check-then-write sequence using `existsSync` plus ordinary `writeFileSync` (`orchestrator/src/dispatch/dispatch.ts:121-148`). Two processes can both see no file, both write, and both return true. Locks have no owner token or heartbeat. Release blindly deletes (`dispatch.ts:151-159`), so an old owner can delete a newer owner's reclaimed lock.

Timeout sends one process-level `SIGTERM` and immediately records `timed_out` (`dispatch.ts:359-367`). Dispatcher then releases the lock in `finally` (`dispatch.ts:281-284`) without waiting for the process or its descendants to exit. There is no grace period, SIGKILL escalation, process group, or confirmed close.

The cleanup reaper lacks production attribution: `orchestrator/src/lifecycle/orphan-reaper.ts:222-280`; `runCleanup` supplies no resolver at `build.ts:694-707`.

**Impact:** A timed-out worker can continue modifying files while a new owner starts. Lock ownership is advisory under cross-process contention.

**Required direction:** Use atomic exclusive creation or an atomic lock directory, owner UUID/PID metadata, heartbeat/proven-dead stale recovery, and compare-owner release. Timeout is terminal only after the process group is confirmed dead and salvage is complete.

### C9. Pull-request flow mutates the wrong branch and never performs the approved push

**Severity:** Critical

Workers execute before the feature branch exists (`orchestrator/src/lifecycle/build.ts:344-620`). They therefore commit onto whichever branch the caller had checked out, potentially local `main`.

`createPullRequest` constructs and policy-checks `git push origin <feature>` (`orchestrator/src/lifecycle/pr-flow.ts:89-105`) but never executes it. It creates or checks out the feature branch only after the work is committed, then immediately runs `gh pr create` (`pr-flow.ts:108-159`). An existing branch is simply checked out, with no verification that it points to the expected commit.

The E2E `gh` fixture always succeeds without a remote (`orchestrator/test/fixtures/omnigent-fixture/gh:1-9`).

**Impact:** Local protected branches are mutated before the PR branch is created. Real `gh pr create --head` may fail because no remote ref exists, or may use a stale existing branch.

**Required direction:** Establish the delivery branch/worktrees before any worker mutation. Execute an array-argv `git push origin HEAD:<branch>` only after policy approval, verify the remote ref equals the expected head, then create and verify the PR.

### C10. Failed-work salvage preserves a record but leaves contamination live

**Severity:** Critical

`archived-todo` writes a patch and changes registry status, but never restores the worktree or removes failed commits (`orchestrator/src/lifecycle/salvage.ts:70-80`). Its archive is based on `git diff HEAD` (`salvage.ts:118-160`).

If a worker commits and then exits nonzero, the archive can be empty because the failed work is already in `HEAD`; that failed commit remains on the shared branch. If the work is uncommitted, it remains in the shared worktree after archiving and can contaminate a later worker's commit.

**Impact:** "Archived" work can still ship.

**Required direction:** Snapshot pre-existing dirt, distinguish committed from uncommitted failure, archive the attributable delta, verify restoration, then restore only the dispatch-owned worktree/ref to its baseline before releasing it.

## High-severity findings

### H1. Scope remains fail-open even after the event adapter is fixed

The scope check resolves declared paths and targets, then only compares those resolved paths. It does not first require every resolved declaration to remain under the real worktree root:

- Python: `rickgent-policies/rickgent_policies/__init__.py:156-203`
- TypeScript: `orchestrator/src/core/scope.ts:135-190`

A declared path that is itself a symlink outside the repository can therefore authorize writes outside the repository.

The raw-shell classifier is also a finite command-name heuristic (`rickgent_policies/__init__.py:229-239,373-467`). Direct probes classified `git add`, `git commit`, `python3 writer.py`, `make install`, and `env touch /tmp/pwn` as read-only/allowed.

**Direction:** Every resolved declaration and endpoint must remain beneath the canonical worktree root. Raw shell should be DENY/ASK by default under ticket scope and run inside an OS-enforced dispatch sandbox.

### H2. PRD acceptance commands execute unrestricted shell

`orchestrator/src/lifecycle/citadel.ts:29-53` executes PRD-provided `verifyCommand` text through `sh -c` with the orchestrator's full environment. PRD validation only rejects a narrow set of interactive/network patterns (`orchestrator/src/core/prd.ts:41-71`). It does not prevent filesystem mutation, process spawning, alternative network clients, credential access, or destructive Git commands.

**Direction:** Use a structured verification command schema or a sandboxed runner with a read-only repository mount, constrained environment, process-group timeout, and explicit command policy.

### H3. Persistent state is not atomic, versioned, or crash-safe

Registry save is an unlocked direct overwrite (`orchestrator/src/lifecycle/registry.ts:96-112`). Parse failure silently becomes an empty registry (`registry.ts:85-93`). There is no temporary file, fsync, atomic rename, schema version, corruption quarantine, or transactional read-modify-write.

Runtime transitions are also incomplete: build does not persist `In Progress`, attempts stay at 0/1, and most declared statuses/phases are unused.

**Direction:** Use transactional storage or lock + temp + fsync + rename. Version every state schema and reject unsupported future versions. Treat corrupt state as a recoverable error, not empty state.

### H4. State defaults to caller CWD rather than the target repository

`getRickgentDir()` derives `.rickgent` from `process.cwd()` (`orchestrator/src/cli.ts:210-212`), while `--repo` independently sets `workingDir` (`cli.ts:311-317`). A command launched from repo A with `--repo repoB` writes repo B's ledger, locks, DB, metrics, and registry under repo A. Multiple target repositories launched from one directory can share state and dispatch IDs.

The same context-derivation pattern is duplicated across several toolbelt commands.

**Direction:** Resolve one canonical execution context first. Default state to the real target repository or a global data root keyed by canonical repo identity and run ID. Reject unsafe symlink state roots.

### H5. Worker contract and completion requirements are internally inconsistent

Worker instructions require a commit (`agents/rickgent/agents/worker/config.yaml:9-13`), while its declared structured tools are read/write/edit only (`worker/config.yaml:30-39`). Dispatcher requires a new committed `HEAD` (`orchestrator/src/dispatch/evidence.ts:56-91`). If the harness exposes a native shell to bridge that gap, the scope policy is currently bypassed and its shell classifier is incomplete.

**Direction:** Give the orchestrator a narrowly scoped, owned-path commit primitive after verifying the worker's changes. Do not require an unrestricted shell merely to create evidence.

### H6. Ticket acceptance contracts are parsed, then dropped before dispatch

The PRD parser stores ticket acceptance-criterion references (`orchestrator/src/lifecycle/prd-parse.ts:121-144`). `ticketPrompt` sends only ID, description, and declared paths (`orchestrator/src/lifecycle/build.ts:189-192`). The worker receives neither ticket ACs nor their verification commands.

Global conformance runs every PRD AC whenever any ticket completes (`build.ts:559-588`) rather than the completed ticket's contract. Duplicate ticket headings can also generate duplicate IDs and collapse separate tickets in registry/ledger maps.

**Direction:** Treat a normalized, validated ticket contract as the dispatch input and identity hash. Preserve its ACs, scope, interfaces, dependencies, and verification plan end to end.

### H7. Build-time Citadel and Szechuan are shallow namesakes

Build's "Citadel" is only a loop over AC shell commands (`orchestrator/src/lifecycle/citadel.ts:20-56`), not the standalone 19-analyzer audit. Build's "Szechuan" scans six regexes over exact declared paths (`orchestrator/src/lifecycle/szechuan.ts:20-63`), not the iterative principle-driven convergence tool.

Directory declarations are silently ineffective: the scanner increments `filesChecked`, attempts `readFileSync` on the directory, catches the error, and reports no findings.

**Direction:** Use honest names for shallow checks, or integrate the real tools with blocking outcomes and explicit budgets.

### H8. Dispatcher output and durable ledgers are unbounded

Child stdout/stderr accumulate without byte limits (`orchestrator/src/dispatch/dispatch.ts:331-344`) and are copied into multiple JSONL entries. A verbose child can exhaust memory and grow ledgers until reads become expensive or unreliable.

**Direction:** Stream output to capped per-dispatch files. Store hashes, paths, sizes, and bounded tails in the ledger.

## Release, packaging, and CLI findings

### R1. Version and build identity disagree

- README/CHANGELOG: `v0.3.0`
- npm package: `0.1.0-alpha` (`orchestrator/package.json:3`)
- CLI: `0.1.0-alpha` (`orchestrator/src/cli.ts:81-83`)
- Python package: `0.1.0a0` (`rickgent-policies/pyproject.toml:7`)
- reviewed HEAD: `6c9eee8...`
- tracked/built `BUILD_COMMIT`: `a55b81d...` (`orchestrator/src/build-commit.ts:3`)

`rickgent doctor` still passed because it compared the CLI to a Python value auto-detected from the same CLI, not to the repository or an independently built artifact.

### R2. The installer does not install the `rickgent` command

`install.sh:64-68` installs dependencies and builds, but never links or globally installs the npm package. The README then instructs users to invoke `rickgent`, and Python shims default to that command.

The declared `omnigent_pin` at `install.sh:8` is unused. Existing installations of any version are accepted (`install.sh:36-42`), and a cloned repository is installed without checking out the pin (`install.sh:51-57`). Python metadata permits `omnigent>=0.5.0`.

Doctor failure is only a warning (`install.sh:76-83`), so the installer can announce completion after verification fails.

### R3. CLI parsing is permissive and advertised controls are missing

- `build --resume` is documented as not requiring a PRD, but parsing rejects missing PRD (`orchestrator/src/cli.ts:306-310`).
- `--max-iterations` is advertised but not parsed or forwarded (`cli.ts:281-344`).
- unknown flags are silently ignored (`cli.ts:295-305`).

### R4. Lint, package, license, and CI surfaces are incomplete

- `npm run lint` exits 127 because ESLint is absent from dependencies/config.
- `npm pack --dry-run` creates a `0.1.0-alpha`, 304-entry package containing source, tests, fixtures, and scripts but no package README, LICENSE, root agent bundles, or Python policies.
- The default agent lookup cannot work from that standalone npm artifact.
- No repository LICENSE file, CI workflow, coverage threshold, or Python lint/typecheck configuration was found.
- The mutation script hardcodes a user-specific Node path and rewrites production source in place (`orchestrator/scripts/coverage-manifest.cjs:23,536-588`). A timeout or spawn failure can count as a caught mutation because success is only `status !== 0` (`:571`).

## Validation results

| Check | Result |
|---|---|
| TypeScript typecheck | Passed |
| TypeScript Vitest suite | **660 passed** across 47 files |
| Python pytest suite | **488 passed, 3 skipped** |
| `rickgent doctor` | Passed, despite stale build identity and policy-runtime bypass |
| Native Omnigent policy probe | Failed safety contract: out-of-scope write and all custom gates allowed/abstained |
| `npm run lint` | Failed: `eslint: command not found` |
| `npm pack --dry-run --json` | Succeeded; revealed incomplete `0.1.0-alpha` artifact |

The green unit suites are real but insufficient. Their primary blind spots are:

- policy tests call handlers directly with invented legacy events;
- attachment tests prove names resolve, not that runtime events enforce;
- the fake Omnigent fixture writes DB rows/files/commits itself and never exercises real policies or model routing;
- E2E gate assertions search report text rather than injecting failures and proving advancement stops;
- phase tests exercise the pure phase table, not a production traversal;
- reconcile tests certify the unsafe commit-message behavior;
- consecutive-build tests use fresh state and therefore avoid ID collisions.

## What is genuinely strong

- The pure verdict core is compact, explicit, and easy to reason about.
- Many Git subprocesses use array argv and `--`, avoiding common shell injection errors.
- The code repeatedly distinguishes model claims from observable evidence.
- There is broad conformance and regression coverage for the functions the tests actually exercise.
- Architectural records document intent and known trap doors unusually well.
- Per-dispatch chat DB isolation is a sound response to conversation attribution.

These strengths are worth preserving. The corrective work should focus on connecting meanings across boundaries, not rewriting the core algorithms wholesale.

## Slop and simplification opportunities

These are secondary to correctness, but addressing them alongside the relevant fixes will reduce future drift.

1. **Collapse to one lifecycle engine.** Wire `phase.ts` into production and delete the parallel implementation-only path, or delete the unused phase model and narrow the product claim.
2. **Create one execution context.** Centralize target repo, state root, run/attempt identity, agent bundle, model selection, budgets, timeout, and strict flag parsing.
3. **Create one Omnigent spawn supervisor.** PRD, refine, Szechuan, Anatomy, Microverse, and Dispatcher repeat spawn/timeout/output patterns. One process-group-aware runner should own them.
4. **Create one policy ABI adapter.** Policy authors should consume a typed canonical event rather than manually probing vendor-specific keys.
5. **Use one transactional state store.** A small SQLite schema would replace registry JSON, multiple JSONL identity joins, lock files, and non-atomic read-modify-write cycles.
6. **Use one release manifest.** Generate npm/Python/CLI version, build metadata, compatibility pins, and documentation checks from a single source.
7. **Split the monoliths after semantics stabilize.** `anatomy.ts` (~1,258 LOC), Python `__init__.py` (~1,132 LOC), `refine.ts` (~990 LOC), and `szechuan-cli.ts` (~923 LOC) mix parsing, state, process control, domain logic, and rendering.
8. **Return results; do not call `process.exit` in lifecycle modules.** Keep exit decisions at the CLI boundary to improve composition and testing.
9. **Move mutation testing to temp copies/worktrees.** Distinguish assertion failure from timeout, spawn failure, and infrastructure failure.
10. **Remove or wire dead representations.** `phase.ts` and `fom.ts` are effectively test-only; duplicate representations invite conceptual drift.

## Execution-ready remediation program

The safest remediation is a **controlled contraction followed by rebuilding the trust spine**. The critical findings should not be treated as an independent bug backlog: policy enforcement, execution identity, Git attribution, terminal state, recovery, and delivery all depend on the same end-to-end meanings. Patch-by-patch repair inside the current orchestration would leave those meanings split across incompatible representations.

Preserve the pure verdict core, parsers, array-argv Git utilities, useful fixtures, and focused conformance tests. Replace or consolidate the unreliable integration shell around them.

### Temporary supported contract

Until the program below is complete, the production contract should be deliberately narrow:

- one sequential dispatch at a time (`maxConcurrent=1`);
- one explicit vendor/model whose effective identity is known;
- one isolated worktree and branch/ref per ticket attempt;
- structured tools only, with raw shell denied by default;
- no automatic push or PR creation;
- no completion reconstructed from Git commit-message prose;
- resume only from authoritative structured state; and
- nonzero exit for zero completion, partial completion, failed gates, unverifiable evidence, or cleanup failure.

Documentation and CLI help should call this a reliability-preview contract rather than implying that parallel, multi-vendor, resumable delivery is already available.

### Non-negotiable invariants

Each invariant should exist as a typed assertion in production code and as an adversarial integration test.

| ID | Invariant |
|---|---|
| INV-01 | One ticket attempt owns exactly one run/attempt identity, worktree, branch/ref, index, lease, and process group. |
| INV-02 | `Done` means the owned commit is scope-clean and all required acceptance, review, conformance, convergence, and delivery gates are green. |
| INV-03 | Any required ticket or gate failure blocks success, push, and PR creation. |
| INV-04 | Policy input is normalized once from the native Omnigent ABI; malformed, unauthenticated, unknown, and out-of-scope requests fail closed. |
| INV-05 | Accepted commits descend from the attempt baseline, are attributable to that attempt, contain no foreign delta, and match the declared ticket contract. |
| INV-06 | The model selected by routing is the model actually invoked and independently observed in the execution receipt. |
| INV-07 | Timeout is not terminal and ownership is not released until the complete process group is dead and salvage/restore verification has finished. |
| INV-08 | Run, ticket, attempt, phase, lease, and evidence transitions are transactional, unique, durable, and restart-safe. |

### Six-PR implementation sequence

Do not run these workstreams in parallel. Each PR establishes assumptions required by the next one.

#### PR 1 — contain false success and delivery

**Scope**

1. Force sequential dispatch.
2. Disable automatic push/PR behavior behind an explicit unavailable capability.
3. Return nonzero on zero completed tickets, partial failure, gate failure, cleanup failure, or unverifiable state.
4. Create the delivery branch/worktree before any worker mutation.
5. Remove or qualify CLI/docs claims for behavior temporarily outside the supported contract.

**Exit criteria**

- An all-failed run exits nonzero and cannot reach PR flow.
- A partially successful run exits nonzero and cannot reach PR flow.
- Injecting failure into every existing gate independently stops advancement.
- A dispatch cannot start on the caller's delivery branch or shared working tree.

#### PR 2 — restore the native policy boundary

**Scope**

1. Implement a single versioned adapter from Omnigent `{type,target,data,context,...}` events to a strict Rickgent `PolicyEvent`.
2. Inject authenticated dispatch configuration: canonical repo/state roots, run ID, ticket ID, attempt, phase, declared scope, and selected identity.
3. Resolve authorized paths with `realpath` and reject traversal, symlink escape, malformed arguments, missing configuration, and unknown tools.
4. Deny raw shell by default; any future shell capability must use an explicit sandbox contract.
5. Delete the legacy top-level-key probing once the adapter is live.

**Exit criteria**

- Every attached policy is exercised through the real Omnigent `FunctionPolicy`, not called directly.
- Out-of-scope writes, symlink escapes, false completion, review bypass, malformed events, and missing config are denied.
- Positive tests prove valid in-scope operations still work.
- Agent startup fails closed if the policy ABI/config version is incompatible.

#### PR 3 — establish execution identity and durable state

**Scope**

1. Introduce one immutable `ExecutionContext` containing repo/state roots, run/ticket/attempt identity, normalized ticket hash, phase, agent bundle, selected model, budgets, timeout, and scope.
2. Replace registry JSON, cross-file identity joins, and ad hoc lock state with a transactional SQLite schema.
3. Enforce uniqueness for `(run_id, ticket_id, attempt)` and legal phase transitions.
4. Derive state location from the canonical target repository, never caller CWD.
5. Make retry allocate a new attempt and make a new ordinary build allocate a new run.
6. Disable Git-subject reconciliation; recovery may consume only structured, run-attributed receipts through the completion oracle.

**Exit criteria**

- Repeating a build cannot replay an old terminal dispatch.
- Retrying increments attempt and preserves prior evidence without overwriting it.
- Crash injection at every state transition leaves either the old or new transaction, never a corrupt hybrid.
- Two processes cannot acquire the same active ticket attempt.
- Restart from the same state directory produces the same authoritative phase and never manufactures `Done`.

#### PR 4 — isolate Git and supervise process ownership

**Scope**

1. Allocate a worktree, branch/ref, index, atomic owner-checked lease, and process group per attempt.
2. Capture an immutable baseline and bind completion to an attempt-owned descendant commit.
3. Reject uncommitted changes, foreign commits, out-of-scope paths, unexpected deletions, and ancestry mismatches.
4. Centralize spawning, bounded output capture, timeout escalation, group termination, and exit observation in one supervisor.
5. Restore or quarantine failed work and verify that it is absent from the delivery branch before releasing the slot.

**Exit criteria**

- Concurrent fixture workers cannot observe or modify each other's index, `HEAD`, worktree, lease, or evidence.
- A worker cannot claim another worker's commit.
- A stubborn child/grandchild process is terminated before the attempt becomes terminal.
- A failed attempt leaves no live delta on the delivery branch.
- Empty or committed failed work is still represented accurately in salvage evidence.

#### PR 5 — implement one real lifecycle and completion oracle

**Scope**

1. Replace the production implementation-only path with one persisted phase state machine.
2. Carry ticket acceptance criteria and interface contracts into implementation, review, remediation, and verification prompts.
3. Implement actual independent review and the bounded implementer-remediation loop.
4. Make conformance, compile, lint, test, convergence, scope, evidence, and review results blocking inputs to one completion oracle.
5. Remove or wire duplicate/dead lifecycle representations such as the test-only phase path.

**Exit criteria**

- Production evidence proves every required phase was entered in order.
- Every gate has a negative test that demonstrates advancement stops.
- `Done` cannot be written directly by a worker, reconcile path, or CLI shortcut.
- Review rejection returns to the permitted remediation phase and exhausts a bounded retry budget.
- Terminal success requires the same oracle during live execution, resume, and any future reconciliation.

#### PR 6 — restore routing, delivery, packaging, and release claims

**Scope**

1. Make dispatcher harness/model overrides control the real Omnigent invocation and record the observed identity.
2. Restore cross-vendor review only when implementer and reviewer identities are provably distinct.
3. Execute the approved push, verify the remote ref/OID, and create a PR only after all required terminal evidence is green.
4. Unify npm, Python, CLI, build, compatibility, and documentation versions from one release manifest.
5. Enforce the Omnigent compatibility pin, install/link the CLI, make doctor run a behavioral smoke dispatch, and publish only required artifacts.
6. Add CI, ESLint, Python lint/typecheck, coverage thresholds, package/install smoke tests, and a real LICENSE.

**Exit criteria**

- Requested, invoked, and observed model identities match; mismatch fails the dispatch.
- A failed or unverifiable push cannot create a PR.
- PR head OID equals the verified delivery OID.
- Installation from the packed artifact supports the documented default agent/policy lookup.
- A clean checkout passes lint, typecheck, unit, adversarial integration, package, install, and behavioral doctor checks.

### Adversarial validation matrix

The existing suites should remain, but release decisions must depend on tests at the production seams.

| Boundary | Required failure injection | Required assertion |
|---|---|---|
| Native policy ABI | malformed event, missing config, out-of-scope path, symlink escape | operation denied before tool execution |
| Persistent state | kill during every transaction and retry transition | state remains readable, unique, and non-terminal unless proven |
| Git ownership | concurrent workers, foreign commit, dirty index, unrelated branch movement | only the attempt-owned scope-clean descendant is accepted |
| Process supervision | ignore `SIGTERM`, fork a grandchild, flood stdout/stderr | group is dead, output bounded, lease retained until cleanup completes |
| Lifecycle gates | fail each acceptance/review/conformance/convergence gate independently | no later phase, success, push, or PR occurs |
| Routing | request a model different from bundle defaults; falsify observed identity | effective mismatch is detected and blocks completion |
| Recovery | crash before/after commit, receipt, evidence, and terminal transition | resume is idempotent and never replays stale terminal work |
| Delivery | missing remote, rejected push, stale remote ref, failed `gh` invocation | PR absent and run terminal-failed/nonzero |
| Packaging | clean machine install from packed artifact | CLI, agents, policies, versions, and doctor smoke dispatch agree |

Mutation and fault-injection tests must run in temporary repositories/worktrees. A timeout, spawn error, or infrastructure error must never be counted as a successfully caught mutation.

### Feature-restoration gates

Capabilities should return individually, only after their dependency is demonstrated:

| Capability | May be enabled only when |
|---|---|
| Parallel dispatch | PR 4 isolation/ownership tests pass under concurrent conflicting workloads with no shared mutable Git or process state. |
| Resume/retry | PR 3 crash/restart tests prove unique attempts, idempotent transitions, and no terminal replay. |
| Reconciliation | Structured receipts are run-attributed, oracle-gated, transactional, persisted, and independent of commit-message text. |
| Multi-vendor routing | Requested, invoked, and observed identities are equal; reviewer and implementer separation is verified. |
| Automatic push/PR | All planned tickets are oracle-complete, cleanup is verified, push OID is observed remotely, and PR head matches it. |
| Raw shell | Preferably never by default; otherwise only after a separately specified and adversarially tested sandbox boundary exists. |

### Program definition of completion

The remediation milestone is complete only when all six PR exit criteria are enforced in CI and a clean installed artifact completes the narrow vertical slice against real Omnigent, a real Git remote, native policy events, and one persistent state directory across a forced interruption and resume. Passing mocked fixtures or unit suites alone is not sufficient.

## Trap doors

- **Policy ABI:** Omnigent's event/config shape is a security ABI. A shim test that bypasses `FunctionPolicy` is not an enforcement test.
- **Completion meaning:** `Done` must mean terminal post-review/post-simplify completion, never merely "implementation produced a changed commit."
- **Git attribution:** A transcript proves which worker spoke; shared `HEAD` does not prove which worker committed.
- **Dispatch identity:** A new run must never inherit an old run ID, and every retry must increment attempt before dispatch.
- **Runtime model identity:** A router label is not execution identity. Selection must reach the process and be observed back.
- **Gate semantics:** A gate must be able to stop delivery. A report-only check must not be called a delivery gate.
- **Timeout semantics:** Timeout is not terminal until the whole process group is dead and salvage/restore is verified.
- **Lock ownership:** File existence is not ownership; release must prove the releaser owns the current lease.
- **Reconcile authority:** Completion must never be inferred from commit-message prose.
- **Salvage semantics:** Archive success is not cleanup success. Failed changes must be absent from the live delivery branch/worktree afterward.
- **Branch ordering:** The delivery branch/worktree must exist before any autonomous mutation, not at PR time.
- **Derived state:** A registry is safely derivable only if reconciliation is run-attributed, oracle-gated, and persisted atomically.

## Final recommendation

Freeze the `v0.3.0` production-readiness claim and treat the next milestone as a **semantic integration release**, not a feature release. The project does not need more toolbelt breadth. It needs one trustworthy vertical slice:

```text
validated ticket contract
  -> real selected model
  -> native enforcing policies
  -> isolated worktree/process
  -> owned commit
  -> real independent review
  -> blocking gates
  -> verified push/PR
  -> durable resumable state
```

Once that slice works twice against real Omnigent, a real Git remote, real policy events, and the same persistent state directory, the existing pure core and toolbelt can become a strong platform. Until then, reliability and conceptual integrity—not additional features—are the completion criteria.
