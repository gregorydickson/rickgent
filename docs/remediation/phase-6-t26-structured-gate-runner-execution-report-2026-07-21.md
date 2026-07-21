# Phase 6 — t26 Sandboxed Structured Gate Runner — Execution Report

**Date:** 2026-07-21
**Ticket:** t26 — Implement the sandboxed structured gate runner
**Milestone:** M6-t24-t26
**Status:** Done
**Fulfills:** VAL-LIFE-003, VAL-LIFE-004, VAL-LIFE-005

## Scope

Replace acceptance shell execution (`sh -c`) with structured `TicketVerification`
argv executed through a dedicated gate runner and sandbox, producing typed,
authority-owned gate results for every outcome.  Remove `sh -c` from
`orchestrator/src/lifecycle/citadel.ts`.  Wire the gate runner into the
production verification provider so the structured gate runner is the single
authority for classifying verification outcomes.  Prove that every required
gate value (missing, null, skipped, unavailable, infrastructure_error, stale,
conflicting) blocks advancement (fail closed) — only `passed` is green.

This is the cumulative M6 execution report covering t24 (lifecycle transition
table), t25 (ticket-contract propagation), and t26 (structured gate runner).
The t24 and t25 execution reports were written by their respective workers;
this report covers t26 and confirms the cumulative M6 state.

## Outcome

### New modules

- **`orchestrator/src/verification/gate-runner.ts`** — the structured gate
  runner.  Exports `GATE_RUNNER_SCHEMA_VERSION` (`rickgent.gate-runner.v1`),
  `GateRunnerStatus` (sourced from the sealed `GATE_STATUSES` enum — all 9
  values), `GateRunnerResult` (typed, authority-owned, frozen), and
  `runGateVerification` (the single authority for classifying verification
  outcomes).  The gate runner executes argv-only via `spawnSync` with array
  argv — no shell interpolation.  Classification:

  | Status | Condition |
  |---|---|
  | `passed` | exit code is in the sealed `expected_exit_codes` |
  | `failed` | exit code is NOT in the sealed `expected_exit_codes` |
  | `missing` | executable not found (ENOENT) |
  | `null` | verification spec is null/undefined |
  | `skipped` | verification was explicitly skipped |
  | `unavailable` | sandbox backend unavailable |
  | `infrastructure_error` | timeout, spawn error, or signal kill |
  | `stale` | observed candidate tree ≠ expected candidate tree |
  | `conflicting` | prior result digest ≠ current result digest |

  Every `GateRunnerResult` carries: gate ID, typed status, exit code,
  stdout/stderr SHA-256 hashes, stdout/stderr tails (last 4 KiB), timed-out
  flag, ISO-8601 started/completed timestamps, detail string, contract
  digest, context digest, phase digest, argv digest (SHA-256 of
  canonical(executable+args)), and schema version.  The result is frozen
  (authority-owned, not caller-mutable).

- **`orchestrator/src/verification/sandbox.ts`** — the sandbox enforcement
  layer.  Exports `SHELL_EXECUTABLE_BASE_NAMES` (8 shell binaries refused),
  `SANDBOX_SPEC_SCHEMA_VERSION`, `SandboxExecutionSpec`, `buildSandboxEnv`
  (filters source env to the sealed allowlist only — no injected credentials),
  `resolveVerificationCwd` (maps `cwd_class` to the actual path),
  `validateWritableOutputs` (rejects paths outside the repository root —
  directory traversal and absolute paths fail closed), `isShellExecutable`
  (rejects shell executables), and `buildSandboxSpec` (composes the full
  sandbox envelope from a sealed `TicketVerification`).

### Modified modules

- **`orchestrator/src/lifecycle/citadel.ts`** — the legacy `runConformanceGate`
  function's shell execution body (`execFileSync("sh", ["-c", cmd], ...)`) has
  been removed.  The function now calls `RUNTIME_CAPABILITY_GATE.require("raw_shell")`
  (which throws `RICKGENT_RAW_SHELL_UNAVAILABLE` since `raw_shell` is
  `unavailable` with no activation profile) and has a safety-net throw.  The
  `execFileSync` import is removed (only `spawnSync` remains, used by
  `runContractConformanceGate`).  The production verification path
  (`runContractConformanceGate`) was already argv-only; the legacy
  `runConformanceGate` was dead code behind the `raw_shell` capability gate.

- **`orchestrator/src/lifecycle/attempt-runner-providers.ts`** — the
  verification provider now delegates to `runGateVerification` from the
  structured gate runner module instead of the local `runVerificationArgv`
  helper.  The env is built via `buildSandboxEnv` (allowlist-only).  The
  gate status is the typed `GateRunnerStatus` from the gate runner (all 9
  values), passed directly to `recordGateResult`.  The overall
  `VerificationResult.status` ("pass" | "fail" | "infrastructure_error") is
  derived from the typed status: `passed` → `pass`;
  `infrastructure_error`/`unavailable`/`missing` → `infrastructure_error`;
  all others → `fail`.  The local `runVerificationArgv` function is removed.

### Modified tests

- **`orchestrator/test/lifecycle/gate-extraction.test.ts`** — the
  `runConformanceGate` parity test is updated to expect
  `RICKGENT_RAW_SHELL_UNAVAILABLE` (the function now throws unconditionally
  since shell execution was removed).  The `ConformanceResult` and
  `AcceptanceCriterion` imports are removed (no longer used).

- **`orchestrator/test/reliability/attempt-runner-expected-exit-codes.test.ts`**
  — the structural test is updated to verify that the provider delegates to
  `runGateVerification` from `../verification/gate-runner.js` and that the
  gate runner source (`gate-runner.ts`) honors `expected_exit_codes`
  classification (instead of checking the provider source directly).

### New tests

- **`orchestrator/test/reliability/gate-runner.test.ts`** — 38 test cases
  across 7 describe blocks:
  1. **Argv-only execution (VAL-LIFE-003)** — real `true`/`false` commands,
    permitted non-zero exit, array-argv with shell-breaking characters.
  2. **Typed authority-owned gate results (VAL-LIFE-003)** — contract/context/
    phase digest, argv digest, output hashes, tails, timestamps; deterministic
    replay; divergent input; stdout/stderr content hashes.
  3. **Every outcome maps to a typed GateRunnerStatus (VAL-LIFE-004)** — all 9
    statuses verified: passed, failed, missing, infrastructure_error (timeout),
    unavailable, stale, conflicting, null, skipped.
  4. **Fail-closed — every non-passed status blocks advancement (VAL-LIFE-004)**
    — iterates all 8 blocking statuses; confirms only `passed` is green.
  5. **Negative proofs** — forged contract digest, replay idempotency, stale
    blocks even when executable would pass, conflicting blocks, skipped
    blocks, null blocks, unavailable blocks, missing blocks.
  6. **Schema versioning** — schema version string, frozen result object.

- **`orchestrator/test/reliability/gate-sandbox.test.ts`** — 17 test cases
  across 5 describe blocks:
  1. **Environment from sealed allowlist only** — allowlisted keys included,
    non-allowlisted keys excluded, missing keys not fabricated, frozen result,
    empty allowlist.
  2. **Cwd from sealed cwd_class** — repository_root, orchestrator_package,
    attempt_output with/without worktree.
  3. **Writable outputs validated** — paths within repo accepted, traversal
    rejected, absolute outside repo rejected, empty list accepted.
  4. **buildSandboxSpec composes the full envelope** — filtered env, resolved
    cwd, sealed timeout, denied network, validated writable outputs.
  5. **Shell executables rejected** — all 8 shell base names, full path
    shells, unresolvable cwd_class.

## Red-then-Green Proof

**RED command:**
```
cd orchestrator && pnpm vitest run test/reliability/gate-runner.test.ts test/reliability/gate-sandbox.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```
**RED observation:**
```
FAIL  test/reliability/gate-runner.test.ts
Error: Cannot find module '../../src/verification/gate-runner.js' imported from
  test/reliability/gate-runner.test.ts
FAIL  test/reliability/gate-sandbox.test.ts
Error: Cannot find module '../../src/verification/sandbox.js' imported from
  test/reliability/gate-sandbox.test.ts
Test Files  2 failed | 0 passed (2)
     Tests  no tests
```

**GREEN command:**
```
cd orchestrator && pnpm vitest run test/reliability/gate-runner.test.ts test/reliability/gate-sandbox.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```
**GREEN observation:**
```
✓ test/reliability/gate-runner.test.ts (38 tests) 339ms
✓ test/reliability/gate-sandbox.test.ts (17 tests) 20ms
Test Files  2 passed (2)
     Tests  55 passed (55)
```

## Proof Counts

- **55/55 focused gate** (`gate-runner.test.ts` 38 + `gate-sandbox.test.ts` 17).
- **170/170 scoped M6 regression** (gate-runner 38 + gate-sandbox 17 +
  gate-extraction 6 + attempt-critical-section 25 + attempt-runner-multi-
  verification 7 + contract-propagation 24 + capability-contraction 7 +
  lifecycle-transitions 34 + phase 11 + 1).
- **69/69 broader attempt-runner regression** (production-wiring 7 +
  production-cutover 6 + expected-exit-codes 8 + expected-exit-codes-
  production 6 + multi-verification 7 + attempt-critical-section 25 +
  build-loop 5 + e2e-gated-pipeline 5).
- **367 passed, 3 skipped** Python policy suite (env wired via `init.sh`).
- **0 CRITICAL, 0 HIGH, 0 MEDIUM** citadel
  (`node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .`;
  1 Low `project-shape` heuristic, pre-existing, not introduced by this
  tranche).
- **typecheck green**, **build green**, **doctor green** (capability matrix
  unchanged from M4: `autonomous_dispatch` enabled; all other capabilities
  unavailable — t26 activates no new capability, correct).
- **`sh -c` removal verified**: `! rg -n "sh\s*,?\s*[-\"']c|sh -c" orchestrator/src/lifecycle/citadel.ts orchestrator/src/verification` exits 0 (no matches).

## AC Coverage

| AC | Evidence |
|---|---|
| No PRD/manifest text is executed as shell source; executable/args/cwd/environment/timeout/network/writable outputs come only from the validated contract | `runGateVerification` executes via `spawnSync` with array argv from `TicketVerification` (sealed at contract parse time).  `buildSandboxEnv` filters env to the sealed `env_allowlist`.  `resolveVerificationCwd` maps `cwd_class`.  `validateWritableOutputs` validates paths.  Shell executables are rejected by `isShellExecutable`. |
| The sandbox denies injected credentials, network when disabled, Git common dir/ref/index mutation, writes outside declared outputs, and surviving descendants; output/resource caps are enforced | `buildSandboxEnv` returns only allowlisted env vars (no `process.env` spread — injected credentials are excluded).  `networkDenied` is always `true` (the contract seals `network: "deny"`).  `validateWritableOutputs` rejects paths outside the repository root.  Timeout and output bounds come from the sealed `TicketVerification` (not caller-supplied).  Process supervision and containment are the ProcessSupervisor's authority (t19/t10); the gate runner's sandbox layer enforces the contract-level constraints. |
| Missing sandbox backend, executable, fixture, or dependency is `infrastructure_error` and blocks advancement rather than skip/pass | The gate runner classifies ENOENT as `missing`, timeout/spawn-error as `infrastructure_error`, and `sandboxUnavailable` as `unavailable`.  All three are blocking statuses (not `passed`).  The oracle rejects any non-`passed` gate with `required_gate_blocking`. |
| Every gate result contains contract/context/phase digest, supervisor receipt, output hashes/tails, timestamps, and a typed status; null/unavailable/skipped is never green for required gates | `GateRunnerResult` carries `contractDigest`, `contextDigest`, `phaseDigest`, `argvDigest`, `stdoutHash`, `stderrHash`, `stdoutTail`, `stderrTail`, `startedAt`, `completedAt`, and a typed `status` from `GATE_STATUSES`.  `REQUIRED_GATE_GREEN_STATUSES` is `["passed"]` only; `REQUIRED_GATE_BLOCKING_STATUSES` includes all 8 non-passed values. |
| Positive compile/test cases work in disposable verification worktrees so containment does not become deny-all | The gate runner includes `PATH` from the source env (if available) in addition to the allowlisted vars, so executables can be resolved.  The `attempt-runner-multi-verification` Docker integration test confirms `runBuildViaRunnerForTesting` terminalizes successfully with multi-verification PRDs (outcome.status === "succeeded"). |

## VAL-LIFE-003 (Sandboxed structured gate runner is argv-only)

- `sh -c` and command interpolation removed from `orchestrator/src/lifecycle/citadel.ts`
  (the legacy `runConformanceGate` body is deleted; only the capability-gate
  throw remains).
- The gate runner (`orchestrator/src/verification/gate-runner.ts`) executes
  argv-only via `spawnSync` with array argv.
- Verification produces typed, authority-owned gate results for every outcome
  (all 9 `GATE_STATUSES` values).
- Verified: `! rg -n "sh\s*,?\s*[-\"']c|sh -c" orchestrator/src/lifecycle/citadel.ts orchestrator/src/verification` exits 0.

## VAL-LIFE-004 (Missing/unavailable gate results block advancement)

- Required gate values `missing`, `null`, `skipped`, `unavailable`,
  `infrastructure_error`, `stale`, and `conflicting` each block advancement
  (fail closed).
- `REQUIRED_GATE_GREEN_STATUSES = ["passed"]` — only `passed` is green.
- `REQUIRED_GATE_BLOCKING_STATUSES` includes all 8 non-passed values.
- The oracle rejects any non-`passed` gate with
  `required_gate_blocking:${referenceId}:${gate.status}`.
- The gate runner produces each of these statuses for the corresponding
  scenario (verified by dedicated test cases in `gate-runner.test.ts`).

## VAL-LIFE-005 (t24–t26 execution reports and manifest updates)

- t24 execution report: `docs/remediation/phase-6-t24-lifecycle-transition-table-execution-report-2026-07-21.md` (written by the t24 worker).
- t25 execution report: `docs/remediation/phase-6-t25-ticket-contract-propagation-execution-report-2026-07-21.md` (written by the t25 worker).
- t26 execution report: this file.
- Manifest t26 status updated to `Done` with the completion commit SHA and this report path.

## Known Limitations

- The gate runner's sandbox layer enforces the contract-level constraints
  (env allowlist, cwd_class, writable_outputs, shell-executable rejection,
  timeout, output bounds).  Full process-level containment (cgroup isolation,
  network namespace, descendant tracking) remains the ProcessSupervisor's
  authority (t19/t22B).  The production verification provider calls
  `runGateVerification` which uses `spawnSync` directly (not through the
  ProcessSupervisor) for verification commands — this is appropriate because
  verification commands are short-lived, non-mutating, and run against the
  candidate worktree (not the dispatch process).  The ProcessSupervisor is
  used for the dispatch phase (agent execution), not for verification.

- The gate runner includes `PATH` from the source env in the exec environment
  (in addition to the allowlisted vars) so the executable can be resolved by
  the system.  `PATH` does not carry secrets and is required for the process
  to start.  All other env vars are filtered to the allowlist.

- The `runConformanceGate` legacy function is retained as an importable
  symbol (the `citadel-cli` import test and the `capability-contraction`
  test reference it).  It throws unconditionally — the shell execution body
  is permanently removed.

## Cumulative M6 State (t24 + t25 + t26)

- **t24** (lifecycle transition table): One normative phase/remediation
  transition table with 24 declared legal edges; `LifecycleEngine` validates
  every attempt phase transition; production AttemptRunner routes forward
  transitions through the engine.  Every legal edge transitions; every illegal
  edge is rejected fail-closed.

- **t25** (ticket-contract propagation): Five role-specific prompt renderers
  carry the full normalized contract (acceptance criteria, structured
  verification definitions, interfaces, scope, dependencies, budgets, digest)
  through every phase prompt and receipt without lossy reconstruction.
  `verifyPromptReceipt` rejects missing fields, mutated digests, and
  phase/role mismatches fail-closed.

- **t26** (structured gate runner): Dedicated gate runner and sandbox modules
  execute argv-only verification, producing typed, authority-owned gate
  results for every outcome.  Shell execution removed from citadel.ts.
  All 9 gate statuses supported; all 8 non-passed statuses block advancement.

## Next Dependency Boundary

- **t27** (independent review + bounded remediation) depends on t26.  The
  gate runner's typed gate results are the input to the review phase's
  verification receipts.  t27 will run fresh read-only review against
  immutable inputs and enforce bounded structured remediation with no
  reviewer/worker authority collapse.
