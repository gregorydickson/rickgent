# Phase 0 — Baseline + Manifest Reconcile Execution Report

**Date:** 2026-07-20
**Milestone:** M0-baseline
**Feature:** `m0-baseline-manifest-reconcile`
**Ticket scope:** Reconcile `t00`-`t21` manifest status; restore a fully green baseline (env wiring + omnigent worker-bundle fixture update); validate the manifest; update the master-plan current-boundary section.

## Scope

M0 is a brownfield *reconciliation* milestone, not a behavior-change milestone.
No production TypeScript or Python policy behavior was rewritten. The work was:

1. Create `init.sh` (the env-wiring script referenced by `services.yaml`,
   `AGENTS.md`, and `library/environment.md` but not previously present in the
   repo) so every worker/validator session can reproducibly source the env vars
   the Python conformance suite requires.
2. Rebuild `orchestrator/dist/cli.js` (`pnpm build`) so `RICKGENT_CLI_REALPATH`
   resolves against the current checkout.
3. Update the pinned omnigent worker-bundle effective-tool inventory fixture to
   match the installed omnigent 0.6.0.dev0 tool inventory (the single genuine
   baseline failure). Treat installed omnigent as the source of truth.
4. Confirm the Python policy suite fully green (no `POLICY_SHIM_ERROR`, no
   failures).
5. Confirm TS `pnpm typecheck` and `pnpm build` green at HEAD.
6. Reconcile `docs/remediation/trust-spine-manifest.json` `status` for
   `t00`-`t21` to `Done` with `completed_at` evidence references.
7. Add and run a manifest validator (no missing deps, no cycles, no
   status/dependency contradictions).
8. Update `master-plan.md` "Current boundary" section to reflect the
   reconciled status (`t00`-`t21` Done, `t22A` active).

## Outcome

All eight scope items completed. Baseline is fully green; manifest is
reconciled and validates clean; master-plan current-boundary reflects the
reconciled status.

## Environment wiring (`init.sh`)

`init.sh` was created at the repo root. It is idempotent and safe to re-source.
It exports:

| Variable | Value | Why |
|---|---|---|
| `PATH` | prepend nvm node v24.13.1 + pnpm 10.22.0 | Deterministic node/pnpm resolution. |
| `OMNIGENT_ROOT` | `/Users/gregorydickson/loanlight/pickle-rick/omnigent` | t00 contract verifier; reliability suites. |
| `OMNIGENT_PYTHON` | `$(command -v python3)` | t00 contract verifier. |
| `RICKGENT_CLI_REALPATH` | `<repo>/orchestrator/dist/cli.js` | `test_conformance.py` resolves the rickgent binary via this; without it, tests hit a stale global shim and fail with `POLICY_SHIM_ERROR`. |
| `RICKGENT_NODE_REALPATH` | `$(command -v node)` | Python conformance tests spawn node via this realpath. |
| `RICKGENT_BUILD_COMMIT` | git HEAD (read back from the rebuilt `dist/build-commit.js`) | TS↔Python `build_commit` parity (VAL-CROSS-005). Without it, `test_compat.py` / `test_ac19.py` report build_commit mismatch failures. |

`init.sh` then rebuilds `orchestrator/dist/cli.js` via `pnpm build` (skippable
with `RICKGENT_INIT_SKIP_BUILD=1`) and re-pins `RICKGENT_BUILD_COMMIT` from the
rebuilt artifact so both sides agree even if git HEAD moved during the source.

## Fixture update (omnigent worker-bundle tool inventory)

**Source of truth:** the installed omnigent 0.6.0.dev0 editable install at
`/Users/gregorydickson/loanlight/pickle-rick/omnigent`, resolved via
`omnigent.spec.parser.parse` + `omnigent.tools.manager.ToolManager.get_tool_names`.

**Failure before fix:** `test_native_function_policy_corpus.py::test_bundle_inventory_matches_real_omnigent_parse_and_resolution[worker]`
failed because the pinned fixture listed `read_skill_file` as the second
worker effective tool, but omnigent does not register `read_skill_file` for the
worker bundle (the worker has no skill resources, so `read_skill_file` is
conditionally absent — confirmed by omnigent's own
`test_schemas_exclude_read_skill_file_without_resources`). The fixture also
already carried `sys_session_list` and `browser_screenshot`; the remaining
drift was the spurious `read_skill_file` entry.

**Fix:**
- `rickgent-policies/test/fixtures/native-policy-corpus/manifest.json`:
  removed `read_skill_file` from the worker bundle `effective_tools` list so
  it exactly matches the installed omnigent resolution.
- `rickgent-policies/rickgent_policies/policy_event.py`: removed
  `read_skill_file` from `UNRELATED_NATIVE_TOOLS` so the canonical adapter
  inventory (`KNOWN_NATIVE_TOOLS`) exactly covers every effective bundle tool
  (required by
  `test_canonical_adapter_inventory_exactly_covers_every_effective_bundle_tool`,
  which asserts `effective == KNOWN_NATIVE_TOOLS`).

The manager bundle fixture already matched the installed omnigent resolution
and was not changed.

## Manifest reconciliation

`docs/remediation/trust-spine-manifest.json` was reconciled for `t00`-`t21`:

- Every ticket `t00`..`t21` now has `"status": "Done"`.
- Every `Done` ticket carries a `completed_at` object:
  `{ "commit": "<40-char SHA>", "phase_report": "<repo-relative path>" }`.
- Tickets `t22`..`t39` are unchanged (`t22` remains `Todo`; `t23`-`t39`
  remain `Todo`).

### Evidence mapping (ticket → commit → phase report)

The mapping was derived from the git history audit (`pickle: t07` through
`pickle: t19` commits, plus the `t00`-`t02` contract-doc commits and the
`t20`/`t21` feat commits) and the phase reports under `docs/remediation/`.

| Ticket | Commit | Phase report |
|---|---|---|
| t00 | `9c0d47f3a5f9b2bb863bfd84e5edb887d71f7ea0` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t01 | `8738fa02f2b2403c5e63f20b6baf8aab2c31a8ba` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t02 | `7f55ac1d3ee5505b60846d021df0bc9356f12fba` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t03 | `e1499f3cf5a2cf322b9367a38e3008f67684de5a` | phase-1-containment-execution-report-2026-07-15.md |
| t04 | `092f4f3909f09dafa1cae976e6cc6d67f8fdb82f` | phase-1-containment-execution-report-2026-07-15.md |
| t05 | `8b3f28c4c9b67f894e3b88076d3e91a9b76aa2e9` | phase-1-containment-execution-report-2026-07-15.md |
| t06 | `3690f8c638aa0c733d0dd6d7cd61b6ad4b2d6bd9` | phase-1-containment-execution-report-2026-07-15.md |
| t07 | `4b1bb22c7eba09fe7e9af364a036cc56ede60d1e` | phase-1-containment-execution-report-2026-07-15.md |
| t08 | `827eec9eedc0999357d8c4d3e5f58f388e27d98b` | phase-2-native-policy-execution-report-2026-07-16.md |
| t09 | `a1cc3cecb15d89e9f4de78c96c33e81a8cb9df00` | phase-2-native-policy-execution-report-2026-07-16.md |
| t10 | `dd6ee0d65a10bf22be88c12464f8f5897131ca2c` | phase-2-native-policy-execution-report-2026-07-16.md |
| t11 | `1e97d9b3fc0249aa76bf7dca8f0b967e01c4d6ec` | phase-2-native-policy-execution-report-2026-07-16.md |
| t12 | `92b2c4fa9f5da73371ee74e97b5d0153224dc4d0` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t13 | `5649db56d165a902495dc3ed6876f26e3929e616` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t14 | `b7d11cf644b28b1f77bea41573478d04ba4bb476` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t15 | `cf9073c8f6a21e38bad7a7a70053162713f45f13` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t16 | `7a402bbd8f6b59a0ff00e1ea335b043ca0b42bbe` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t17 | `1cecbfe74c9ef25285a4783c8b5f7270971301b0` | phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md |
| t18 | `5590ca2579f1ecb82c13de8b269a8abde84d1009` | phase-4-attempt-runner-state-bridge-report-2026-07-18.md |
| t19 | `35ab3f78b5d114ac457452d91c7ff0ce9d5ffe6f` | phase-4-process-supervisor-execution-report-2026-07-17.md |
| t20 | `78420f03e352759338b0016578edfc4e4f5e522d` | phase-4-commit-attribution-execution-report-2026-07-17.md |
| t21 | `efcf32c5dc5fda6e8a45550d0050bb9e11a6d2c0` | phase-4-salvage-cleanup-execution-report-2026-07-18.md |

For `t00`-`t02` (M0 contract decisions) and `t12`-`t17` (M3 state-store and
crash-boundary work), no dedicated phase report exists; this Phase 0
reconciliation report is the reconciling evidence, with the owning commit as
the primary git-tree-truth evidence. For `t03`-`t11` and `t18`-`t21`, the
existing dedicated phase reports are referenced.

## Manifest validator

A new validator was added at
`orchestrator/scripts/validate-trust-spine-manifest.mjs`. It checks:

1. Schema well-formedness (tickets array, valid status, depends_on is an array).
2. No missing dependencies (every `depends_on` references an existing ticket).
3. No dependency cycles (DFS over the dependency graph).
4. No status/dependency contradictions (a `Done` ticket cannot depend on a
   non-`Done` ticket — VAL-CROSS-001).
5. `completed_at` evidence references for every `Done` ticket (valid git SHA +
   non-empty phase-report path).

Result against the reconciled manifest:

```
manifest-validator: OK — 40 tickets, 22 Done, no missing deps, no cycles, no status contradictions
```

## Verification

| Check | Command | Result |
|---|---|---|
| Env wiring | `source ./init.sh && env \| grep RICKGENT_` | `RICKGENT_CLI_REALPATH` + `RICKGENT_NODE_REALPATH` + `RICKGENT_BUILD_COMMIT` set |
| Named fixture test | `pytest test_native_function_policy_corpus.py::test_bundle_inventory_matches_real_omnigent_parse_and_resolution` | 3/3 passed (manager + worker + adapter inventory) |
| Python policy suite | `python3 -m pytest test/ -p no:cacheprovider -q` | 367 passed, 3 skipped, 0 failed; 0 `POLICY_SHIM_ERROR` |
| Skips | `pytest -rs` | 3 skips in `test_conformance.py` ("No CLI surface for check: breaker") — intentional, pre-existing |
| TS typecheck | `cd orchestrator && pnpm typecheck` | exit 0 |
| TS build | `cd orchestrator && pnpm build` | exit 0; `dist/cli.js` regenerated with fresh build-commit |
| Manifest validator | `node orchestrator/scripts/validate-trust-spine-manifest.mjs` | exit 0; 40 tickets, 22 Done, no missing deps / cycles / contradictions |
| Master-plan current-boundary | `grep` of the Current-boundary section | states `t00`-`t21` Done, `t22A` active |

## Known limitations and next dependency boundary

- M0 does not activate any capability. `doctor` capability matrix is unchanged
  from the pre-M0 state (`autonomous_dispatch` remains `fixture_only`;
  `parallel_dispatch`, `raw_shell`, `resume_retry`, `reconciliation`,
  `cross_vendor_review`, `automatic_delivery` remain `unavailable`). This is
  correct — capability activation is gated on proof corpora owned by later
  milestones.
- The 3 skipped `test_conformance.py` cases ("No CLI surface for check:
  breaker") are intentional and pre-existing; `breaker` has no CLI surface by
  design (it is a pure verdict-core concern exercised through the TS suite).
- The next dependency boundary is `t22A` (M1): connect real observer-owned
  writers to the five disposition receipt types and replace generic cleanup
  finalization with purpose-specific transactions. `t22A` must complete before
  `t22B` (containment, which depends on the M2 ADR ratification).
