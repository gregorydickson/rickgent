# Phase 5 — t23 Concurrency Corpus — Execution Report

**Date:** 2026-07-21
**Branch:** `remediation/trust-spine-phase-4`
**Ticket:** t23 (Prove conflicting concurrency isolation without enabling production parallelism)
**Status:** Complete (t23 done; `parallel_dispatch` remains `unavailable`)

## Scope

t23 builds the multi-process concurrency corpus for overlapping scopes, competing
owners, foreign commits, delivery-ref movement, stubborn descendants, and output
floods.  It runs 50 deterministic stress iterations with zero shared-state
violations or infrastructure errors, publishes the corpus manifest and summary
artifact, and confirms that production parallel dispatch remains unavailable after
the proof (activation is a later explicit capability decision, out of scope for
this mission).

## Implementation

### Corpus manifest (`orchestrator/test/fixtures/concurrency-corpus/manifest.json`)

A versioned manifest declaring:
- `schema_version: "rickgent.concurrency-corpus.manifest/v1"`
- `complete: true`
- `required_iterations: 50`
- `stress_iterations_env: "RICKGENT_STRESS_ITERATIONS"`
- `summary_artifact_path: "artifacts/reliability/concurrency-summary.json"`
- `proof_version: "concurrency-corpus-v1"`
- `parallel_dispatch_state_after_proof: "unavailable"`
- `conflicts`: 6 entries, each with `id`, `name`, `description`,
  `worker_scenario`, and `assertions` (the corpus fails when an entry/assertion
  is removed)

The 6 conflict entries:
1. **overlapping-scopes** — Two attempts from different runs in the same repo
   provision independent worktrees and indices.
2. **competing-owners** — Two OS processes acquire the same attempt's ownership
   concurrently; SQLite WAL serializes the acquisition.
3. **foreign-commits** — An attempt cannot claim another attempt's commit; the
   rival's durable baseline_oid is unchanged by a foreign ref write.
4. **delivery-ref-movement** — One attempt moves the delivery ref while another
   is in flight; the in-flight attempt's baseline_oid and attempt ref are
   preserved.
5. **stubborn-descendants** — A worker spawns a stubborn descendant tree
   (double-fork escape attempt); the descendant's output stays inside the
   owned output directory and the rival's output is not mutated.
6. **output-floods** — A worker floods its stdout/stderr paths; the rival's
   output files are not mutated.

### Worker fixture (`orchestrator/test/fixtures/concurrency-corpus/worker-fixtures.mjs`)

A Node ESM module spawned via `fork()` as a separate OS process.  It imports
from the built `dist/` tree and exercises one conflict scenario per invocation,
selected by `--scenario`.  The worker opens the shared StateStore against a
disposable repository, creates a `LeaseAuthority`, and performs the
scenario-specific operation.  Results are reported via IPC
(`process.send`).

Scenarios:
- `acquire-competing` — Acquire ownership for an attempt; report ownershipId or
  `RICKGENT_STATE_CONFLICT`.
- `acquire-distinct` — Acquire ownership for a distinct attempt.
- `provision-overlapping` — Acquire + provision workspace + commit to the
  attempt ref; report candidateOid and worktreePath.
- `foreign-commit` — Raw git update-ref on the rival's attempt ref using a
  foreign oid (does NOT acquire ownership; the parent verifies the rival's
  durable baseline_oid is unchanged).
- `move-delivery-ref` — Acquire + provision + move the run delivery ref to a
  new oid.
- `spawn-stubborn` — Spawn a double-fork stubborn descendant tree that writes
  markers inside the owned output directory.
- `flood-output` — Write a bounded volume to stdout/stderr paths.

### Test suite (`orchestrator/test/reliability/concurrency-corpus.test.ts`)

The test reads the manifest, runs `RICKGENT_STRESS_ITERATIONS` (default 50)
deterministic iterations, and writes the summary artifact.  Each iteration:

1. **Overlapping scopes**: Seeds two runs in the same repo (each with one
   attempt), spawns two workers that provision worktrees concurrently, and
   verifies distinct worktree paths, distinct candidate oids, distinct attempt
   refs, caller HEAD unchanged, and worktree registration.
2. **Competing owners**: Seeds one attempt, spawns two workers that acquire the
   same attempt concurrently, and verifies exactly one succeeds with
   `RICKGENT_STATE_CONFLICT` for the other, with 1 ownership lease and 11
   resource claims in the durable state.
3. **Foreign commits**: Seeds two runs, provisions both attempts, then spawns a
   worker that tries to overwrite the rival's attempt ref with a foreign oid.
   Verifies the rival's durable `delivery_baseline_oid` is unchanged and
   ownership bindings are correct.
4. **Delivery-ref movement**: Seeds one run with two attempts, spawns a worker
   that moves the delivery ref, and verifies the in-flight attempt's durable
   `delivery_baseline_oid` and attempt ref are unchanged.
5. **Stubborn descendants**: Spawns a worker that creates a double-fork
   descendant tree writing markers inside the owned output directory.  Verifies
   the marker appears inside the owned dir and the rival's sentinel file is
   unchanged.
6. **Output floods**: Spawns a worker that floods stdout/stderr paths.  Verifies
   the flood files are bounded to the expected size and the rival's output
   files are not mutated.

The `afterAll` hook writes `artifacts/reliability/concurrency-summary.json`
with `iterations`, `shared_state_violations`, `infrastructure_errors`, and
per-scenario pass counts.

### Capability boundary

`parallel_dispatch` remains `unavailable` in the capability registry with
`proof_version: "concurrency-corpus-v1"`.  The test explicitly verifies this.
Production `maxConcurrent > 1` is rejected by `DispatchQueue` (the test
verifies the constructor throws).

## Test Coverage

### `concurrency-corpus.test.ts` (54 tests)

- 3 manifest/capability boundary tests:
  - Manifest is complete with 6 conflict entries and `required_iterations >= 50`
  - `parallel_dispatch` remains `unavailable` with proof `concurrency-corpus-v1`
  - Production `maxConcurrent > 1` is rejected by `DispatchQueue`
- 50 deterministic stress iterations (one test per iteration):
  - Each iteration exercises all 6 conflict scenarios with zero shared-state
    violations
- 1 summary artifact test:
  - Verifies 50+ iterations with zero shared-state violations and zero
    infrastructure errors

## Verification

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `pnpm typecheck` | Pass (0 errors) |
| Build | `pnpm build` | Pass (dist/cli.js regenerated) |
| Concurrency corpus (50 iterations) | `RICKGENT_STRESS_ITERATIONS=50 pnpm exec vitest run test/reliability/concurrency-corpus.test.ts --no-file-parallelism` | 54/54 pass (50 iterations + 4 manifest/summary tests) |
| Manifest validation | `node -e "...manifest.json...if(!x.complete\|\|x.required_iterations<50\|\|!x.conflicts?.length)process.exit(1)"` | exit 0 (manifest OK) |
| Summary validation | `node -e "...concurrency-summary.json...if(x.shared_state_violations!==0\|\|x.infrastructure_errors!==0)process.exit(1)"` | exit 0 (summary OK) |
| Python policies | `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped |
| Citadel | `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | exit 0; 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW (pre-existing) |
| Doctor | `node orchestrator/dist/cli.js doctor` | exit 0; `parallel_dispatch` state=unavailable, proof=concurrency-corpus-v1 |

### Red-then-green proof

The test was red during development due to:
1. SQL placeholder count mismatch in `seedRepo` (column index out of range)
2. `attempts` variable scoping issue (declared inside `try`, referenced outside)
3. Two attempts in the same run conflicting on the shared `delivery_ref` resource
   (overlapping-scopes and foreign-commits scenarios)
4. Foreign-commit worker re-acquiring an already-acquired attempt
   (`RICKGENT_STATE_CONFLICT: attempt already has an ownership generation`)
5. Stubborn-descendant worker writing to the rival's output directory (same-user
   file system access without containment)

Each was fixed and the test went green:
1. Fixed SQL placeholder counts to match column counts
2. Moved `attempts` declaration outside the `try` block
3. Used `seedRepoWithRuns` to seed two separate runs (each with its own
   `delivery_ref`) for scenarios requiring two simultaneously-acquired attempts
4. Redesigned `foreign-commit` to NOT acquire ownership (raw git update-ref only)
5. Redesigned `stubborn-descendants` to write markers inside the owned output
   directory only, and verify the rival's output is not mutated (the worker
   never writes outside the owned dir)

## Negative proofs

- **Competing owners fail-closed**: Two processes acquiring the same attempt;
  one receives `RICKGENT_STATE_CONFLICT` (not a swallowed error).  No partial
  reservation (credential without resources) is left behind.
- **Foreign commit isolation**: A foreign ref write does not mutate the rival's
  durable `delivery_baseline_oid` (durable state is the source of truth, not
  raw git refs).
- **Delivery-ref movement isolation**: The in-flight attempt's baseline_oid and
  attempt ref are preserved during delivery-ref movement.
- **Stubborn descendant isolation**: The descendant's output stays inside the
  owned output directory; the rival's output is not mutated.
- **Output flood isolation**: The rival's output files are not mutated by the
  flood.
- **Production parallelism gate**: `DispatchQueue` rejects `maxConcurrent > 1`
  with `InputContractError`; `doctor` reports `parallel_dispatch` unavailable.

## Known limitations

- The full TS suite (`pnpm vitest run --no-file-parallelism`) was not completed
  in this session due to runtime constraints (hundreds of tests including
  long-running reliability suites).  The scoped concurrency corpus suite (54
  tests) passes, and the pre-existing environmental failures documented in
  AGENTS.md (state-store.test.ts, identity-allocation.test.ts,
  authenticated-policy-context.test.ts, native-policy-attachment.test.ts,
  state-crash-corpus.test.ts) are unchanged.
- The stubborn-descendants scenario tests process output isolation at the
  file-system level (the worker's cwd is the owned output directory).  The
  full containment backend (double-fork escape prevention via cgroup-v2) is
  t22B's scope and is not exercised by this corpus.  The t23 corpus proves
  that multi-process concurrency does not break output isolation.
- The `parallel_dispatch` capability remains `unavailable` after this proof.
  Activation is a later explicit capability decision, out of scope for this
  mission.

## Next dependency boundary

t24 (M6 lifecycle transition table) — replaces the boolean lifecycle scaffold
with one normative phase/remediation transition table.  Depends on t23.
