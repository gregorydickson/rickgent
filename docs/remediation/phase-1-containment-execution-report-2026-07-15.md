# Phase 1 Containment Execution Report — 2026-07-15

## Outcome

Phase 1 containment (`t03` through `t07`) is implemented and passed the final
adversarial P0/P1 review. This is a reliability-preview boundary, not project
completion: public autonomous dispatch, resume/retry, reconciliation, parallel
dispatch, cross-vendor review, automatic delivery, and raw shell remain
unavailable.

The implementation ran on branch `remediation/trust-spine-phase-1` through the
sequential Pickle Rick session
`/Users/gregorydickson/.codex/pickle-rick/sessions/2026-07-15-0dccb366`.
The session completed successfully after 37 iterations. A three-reviewer agent
team then audited completion truth, data-flow/path integrity, and reliability
boundaries; every P0/P1 finding was repaired and re-reviewed.

## Committed handoff chain

| Commit | Ticket / purpose |
|---|---|
| `0661f4d` | Reliability-remediation baseline and review authority |
| `9c0d47f` | `t00` — evolving Omnigent compatibility contract |
| `8738fa0` | `t01` — evidence provenance and clean handoff contract |
| `7f55ac1` | `t02` — trust-spine execution contracts |
| `e1499f3` | `t03` — capability kill switches and strict CLI parsing |
| `092f4f3` | `t04` — fail-closed run aggregation and CLI-owned exits |
| `8b3f28c` | `t05` — strict TicketContract admission and hashing |
| `3690f8c` | `t06` — sequential isolated run workspace and capture-only seam |
| `4b1bb22` | `t07` — reliability-preview CLI and documentation contract |

The integrated adversarial-repair commit follows this chain and contains no
rewrite of `orchestrator/src/build-commit.ts`.

## Delivered containment

### Capability and completion boundary

- One frozen runtime registry owns capability state, stable detail codes, help,
  doctor output, and the public claims matrix.
- Production boundaries do not accept caller-supplied capability gates. The
  installed package excludes fixture authority and package-private mutation
  bridges.
- Public `build` and `pipeline` stop before allocation or spawn with exit 3.
- Fixture build injection is exactly sequential, uses a dedicated run worktree,
  and can emit only `implementation_captured_nonterminal`.
- Fixture resume and reconciliation are unavailable, so a baseline commit named
  like `ticket: t01` cannot be promoted to `Done`.
- A skipped or failed required policy-attachment check returns before run
  workspace allocation or worker spawn.
- Lifecycle functions return typed results; process termination is owned by the
  CLI boundary.

### Contract, path, and data-flow integrity

- Executable Markdown must adapt to strict versioned TicketContracts before run
  allocation. IDs, dependencies, scope/change kinds, interfaces, AC references,
  argv-only verification, budgets, canonical serialization, and SHA-256 digest
  are validated fail-closed.
- CommonMark fenced examples are inert under marker, opener-length, info-string,
  indentation, and closer rules; malformed/short closers cannot expose hidden
  executable tickets.
- `.git` and `.rickgent` segments are rejected case-insensitively. Actual Git
  dir/common-dir identities, submodules, configured state roots, symlinks,
  linked worktrees, and missing path suffixes use shared case-aware filesystem
  identity.
- The public non-interactive PRD template is itself an executable one-ticket
  contract. It is admitted before writing, and output/scope aliases—including
  nested file paths, case aliases, and dangling symlinks—fail before mkdir or
  overwrite.
- PRD and Citadel writers are documented honestly: caller-selected paths are
  write authority and may be overwritten; read-only Git inspection may run, but
  agent/remediation execution, Git mutation, and lifecycle promotion do not.

### Workspace and cleanup reliability

- The caller checkout must be a clean, attached repository root. A separate run
  ref and linked worktree are provisioned before the capture worker can spawn.
- Path, ref, and linked-worktree registration observations are tri-state. Only
  proven `ENOENT`/`ENOTDIR` is absence; observation uncertainty is an
  infrastructure/cleanup failure.
- Cleanup proves the run worktree path, Git administrative registration, and run
  ref are all absent. A vanished directory with a retained Git registration is
  actively removed rather than misreported as clean.
- Allocation-root deletion errors and finalization residue are retained as
  cleanup evidence and select cleanup-failure precedence.

### Package and claim coherence

- `dist` and `dist-fixture` are separately compiled; fixture/testing/internal
  authority and the ungated legacy salvage module are excluded from the packed
  artifact.
- Packed source maps are self-contained instead of pointing to absent source
  files.
- Packed doctor discovers configured external manager/worker bundles through
  `RICKGENT_MANAGER_DIR` and `RICKGENT_WORKER_DIR` and audits both configs.
- Target-design decision records are explicitly historical and defer current
  availability to the compiled registry and `docs/reliability-preview.md`.
- Package-excluded legacy compatibility fixtures are explicitly
  non-authoritative and cannot support capability, completion, or lifecycle
  claims.

## Final evidence

| Check | Result |
|---|---|
| TypeScript full suite: `npm exec --offline -- vitest run --maxWorkers=1` | **PASS** — 56 files, 734 tests |
| TypeScript: `npm exec --offline -- tsc --noEmit` | **PASS** |
| Ticket fixture validator | **PASS** — 28 lexical parity vectors, 40 negative cases across 8 categories |
| Trust-spine validator | **PASS** — Node 24.13.1, Python 3.14.3, `sandbox-exec`, Darwin |
| Omnigent live compatibility probe | **PASS** — runtime 0.6.0.dev0, 9 checks |
| Packed capability/doctor boundary | **PASS** — fixture/private authority absent; configured packed doctor healthy |
| Containment drill suite: `rickgent-policies/test/test_drills.py` | **PASS** — 12 tests |
| `git diff --check` | **PASS** |
| Build-identity source preservation | **PASS** — no diff in `orchestrator/src/build-commit.ts` |
| Final three-reviewer P0/P1 audit | **PASS** — no open P0/P1 findings |

## Known non-green work

The repository-wide Python suite is not green in this uninstalled development
checkout: **444 passed, 44 failed, 3 skipped**. The failures consistently expose
the release/install boundary: tests invoke an unavailable installed `rickgent`
executable, the editable Python package reports `BUILD_COMMIT=dev`, and the
subprocess parity checks consequently receive empty/non-JSON TypeScript output.
This is not counted as Phase 1 validation success and remains release-blocking
work for the packaging/install and release-proof tickets (notably `t35` and
`t37`).

Additional deferred release work includes making `install.sh` enforce the
repository's exact `pnpm@10.22.0` contract instead of its current broad `10+`
message/check. These deferrals do not broaden the reliability-preview runtime
authority.

## Next phase

Proceed with `t08` through `t11` as the next sequential phase:

1. `t08` — implement the canonical native policy adapter.
2. `t09` — materialize and authenticate per-attempt policy context.
3. `t10` — enforce canonical scope and structured-tool containment.
4. `t11` — migrate every attached policy and prove full bundle composition.

Do not enable public autonomous execution merely because Phase 1 containment is
complete. Capability promotion requires the later trust-spine, verification,
delivery, packaging, and clean-checkout proofs defined by the PRD.
