# Phase 9 — t35 Unified Release Contract Execution Report

**Date:** 2026-07-23
**Ticket:** t35 — Unify the release manifest, package contents, installer, and license
**Milestone:** M9-t35-t36
**Commit:** (finalized in the t35 completion commit; see `completed_at` in the manifest)
**Fulfills:** VAL-REL-001

## Scope

Create one authoritative cross-language version/compatibility manifest and align
package contents, installer behavior, runtime paths, and licensing so a clean
packed installation is possible. Enforce compatibility behavior through
fail-closed validators, not a silently unused pin. This is the packaging
contract substrate for t36 (real CI/quality gates), t37 (packed-install doctor),
and t38 (protected vertical slice).

## Outcome

Done. One machine-readable release manifest (`release-manifest.json` at the
repository root) is authoritative for npm, Python, CLI, build-identity,
Omnigent-compatibility, toolchain (Node/Python/pnpm/platform), package-contents,
installer, runtime-paths, and licensing values. Two fail-closed validators
cross-check every declared value against its authoritative source and parse the
npm pack and Python wheel inventories into assertions (archive creation alone is
not success).

## What was implemented

### New files
- **`release-manifest.json`** (repo root) — the unified cross-language
  version/compatibility manifest (schema 1.0.0, `cross-language-authoritative`).
  Records: version (npm `0.1.0-alpha`, python `0.1.0a0`, cli_display
  `0.1.0-alpha`, docs `0.1.0-alpha`); license (Apache-2.0); toolchain (node
  `>=24.0.0 <25.0.0`, python `>=3.12.0,<3.15.0`, pnpm `10.22.0`, platforms
  darwin/linux with windows `fail_fast`); build identity (40-char git SHA from
  `build-commit.ts`, `--version`/`--build-commit` CLI flags, lag-by-one note);
  Omnigent compatibility (contract
  `artifacts/reliability/omnigent-compatibility-contract.json`, id
  `rickgent-omnigent-current-compatible-v1`, current-compatible mode, offline
  behavioral probe authority); package contents (npm cli-only tarball with
  must_include/must_exclude; python wheel with must_include_modules/must_exclude);
  installer (assembles runtime, doctor gate fatal, preserves user data,
  idempotent); runtime paths; assembly plan; validators.
- **`orchestrator/scripts/validate-release-manifest.mjs`** — fail-closed
  manifest validator. Cross-checks: manifest structure (12 required top-level
  fields); npm version vs `orchestrator/package.json`; python version vs
  `rickgent-policies/pyproject.toml`; CLI `--version` contains the manifest
  `cli_display`; CLI `--build-commit` is a 40-char hex SHA and not the literal
  `dev`; LICENSE exists and is Apache-2.0; `package.json` license field and
  `pyproject.toml` license metadata both `Apache-2.0`; node range, package
  manager, python range, and platforms agree across manifest, `package.json`
  `engines`/`packageManager`/`rickgentToolchain`, and `pyproject.toml`
  `requires-python`; Omnigent contract exists with matching `contract_id` and
  `contract_mode`; verifier script exists; package-contents structure;
  installer script exists with `doctor_failure_is_fatal`,
  `preserves_unrelated_user_data`, and `idempotent` all true; runtime paths
  resolve (agent bundles, policies source); validator scripts exist. Exits 0
  with `release manifest valid: ...` on success; exits 1 with a precise stderr
  diagnostic on any drift/missing field.
- **`orchestrator/scripts/assert-package-inventory.mjs`** — fail-closed
  package inventory assertion. Loads the release manifest's
  `package_contents`; parses `npm pack --dry-run --json` output (the npm
  inventory) and asserts every `must_include` file is present and no
  `must_exclude` pattern (test/, src/, node_modules/, dist/testing/,
  dist/internal/, dist-fixture/, fixtures/, .tsbuildinfo) appears; inspects the
  Python wheel by unzipping it and asserting every `must_include_modules`
  (`rickgent_policies`) is present and no `must_exclude` path (test/,
  __pycache__, .egg-info, .venv) appears; confirms the dist contains an
  artifact for the declared package name. Exits 0 with
  `package inventory aligned: ...`; exits 1 on any violation.
- **`LICENSE`** (repo root) — the full Apache License, Version 2.0 text with
  the rickgent copyright notice in the appendix.
- **`orchestrator/test/reliability/release-manifest.test.ts`** — 10-case
  behavioral test suite (6 positive + 4 negative proofs).

### Modified files
- **`orchestrator/package.json`** — added `"license": "Apache-2.0"`; aligned
  `rickgentToolchain.python.range` to the PEP 440 canonical form
  `>=3.12.0,<3.15.0` (matching `pyproject.toml requires-python`) so the
  manifest, npm metadata, and Python metadata agree exactly.
- **`install.sh`** — the doctor gate is now **fail-closed** (a doctor failure
  aborts the install with a nonzero exit instead of warning); added an
  executable-linking step that symlinks the `rickgent` launcher into the first
  writable directory on PATH (falling back to `~/.local/bin`); the linker
  preserves unrelated user data (it only touches the `rickgent` entry and
  leaves an existing non-symlink `rickgent` in place rather than overwriting
  it); the launcher is ensured executable. The install remains idempotent.
- **`docs/remediation/trust-spine-manifest.json`** — t35 `status` set to
  `Done` with `completed_at` referencing the completion commit and this report.

### Evidence artifacts (generated, committed)
- **`artifacts/reliability/npm-pack-inventory.json`** — `npm pack --dry-run
  --json` output for the orchestrator package (382 files; 2 required present,
  8 exclusion classes enforced).
- **`artifacts/reliability/python-dist/`** — `python3 -m build` output:
  `rickgent_policies-0.1.0a0-py3-none-any.whl` and
  `rickgent_policies-0.1.0a0.tar.gz`.

## TDD proof (red then green)

**Red (captured before implementation):** the test suite was authored first and
run against the absent manifest/scripts/LICENSE. All 10 tests failed:

```
 Test Files  1 failed (1)
      Tests  10 failed (10)
```

The failing output showed the behavioral gap: `Cannot find module
'.../assert-package-inventory.mjs'`, `release-manifest.json` missing, LICENSE
missing — the release manifest validation pipeline did not pass.

**Green (after implementation):**

```
 test/reliability/release-manifest.test.ts (10 tests) 2457ms
 ✓ unified release manifest (t35) > the release manifest is committed and validates...
 ✓ unified release manifest (t35) > manifest version agrees with npm, python, CLI...
 ✓ unified release manifest (t35) > toolchain ranges agree with package.json engines...
 ✓ unified release manifest (t35) > a real Apache-2.0 LICENSE is present...
 ✓ unified release manifest (t35) > npm pack inventory excludes tests/source/secrets...
 ✓ unified release manifest (t35) > validator rejects a manifest whose npm version drifts...
 ✓ unified release manifest (t35) > validator rejects a manifest missing a required field
 ✓ unified release manifest (t35) > validator rejects a manifest referencing a missing LICENSE
 ✓ unified release manifest (t35) > inventory assertion fails when npm pack includes a forbidden test path
 ✓ unified release manifest (t35) > inventory assertion fails when the python dist is absent
 Test Files  2 passed (2)   Tests  11 passed (11)
```

## Negative proofs (fail closed)

Each negative proof was red against the unfixed/absent code and green after
implementation. The validators exit nonzero with a precise diagnostic (not a
swallowed error):

1. **Version drift** — a manifest with `version.npm = "9.9.9-wrong"` is
   rejected: `validate-release-manifest: npm version drift: manifest=9.9.9-wrong
   package.json=0.1.0-alpha` (exit 1).
2. **Missing required field** — a manifest with `omnigent_compatibility`
   deleted is rejected: `manifest is missing required field
   "omnigent_compatibility"` (exit 1).
3. **Missing LICENSE** — a manifest referencing `license.file = "NO_SUCH_LICENSE"`
   is rejected: `LICENSE does not exist: NO_SUCH_LICENSE` (exit 1).
4. **Forbidden package path** — an npm inventory that ships
   `test/reliability/release-manifest.test.ts` is rejected:
   `npm pack inventory contains forbidden paths:
   test/reliability/release-manifest.test.ts` (exit 1).
5. **Missing python dist** — an absent python dist directory is rejected:
   `python dist directory does not exist: ... (run python3 -m build first)`
   (exit 1).

Additionally, the validator fail-closes on: python version drift, CLI
`--version` drift, build identity not a 40-char SHA / equal to `dev`, node range
drift, package-manager drift, python range drift (manifest vs pyproject vs
package.json), platform drift, omnigent `contract_id`/`contract_mode` drift,
missing verifier, missing installer script, `doctor_failure_is_fatal` not true,
missing agent-bundle/policy-source paths, and missing validator scripts.

## Verification (programmatic, all green)

| Command | Exit | Observation |
| --- | --- | --- |
| `cd orchestrator && pnpm typecheck` | 0 | `tsc --noEmit` clean |
| `cd orchestrator && pnpm build` | 0 | dist/cli.js regenerated; build-commit refreshed |
| `pnpm vitest run test/reliability/release-manifest.test.ts test/reliability/packed-capability-boundary.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism` | 0 | 11/11 passed (10 release-manifest + 1 packed-capability-boundary) |
| `cd rickgent-policies && python3 -m pytest test/ -p no:cacheprovider -q` | 0 | 372 passed, 3 skipped |
| `node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .` | 0 | 0 CRITICAL, 0 HIGH (7 MEDIUM + 1 LOW, all pre-existing) |
| `node orchestrator/dist/cli.js doctor` | 0 | capability matrix unchanged; autonomous_dispatch enabled, parallel_dispatch/raw_shell unavailable (t35 activates no capability) |
| `node orchestrator/scripts/validate-release-manifest.mjs release-manifest.json` | 0 | `release manifest valid: rickgent-trust-spine-release-v1 (npm 0.1.0-alpha, python 0.1.0a0, build …, omnigent rickgent-omnigent-current-compatible-v1)` |
| `node orchestrator/scripts/assert-package-inventory.mjs artifacts/reliability/npm-pack-inventory.json artifacts/reliability/python-dist` | 0 | `package inventory aligned: npm 382 files (2 required present, 8 exclusions enforced), python 1 wheel(s) + 1 sdist(s) inspected` |
| `test -f LICENSE && rg -n "Apache License\|Version 2.0" LICENSE` | 0 | Apache License, Version 2.0 present |

### Ticket verification commands (from the manifest)
1. `node orchestrator/scripts/validate-release-manifest.mjs release-manifest.json` — exit 0 ✓
2. `cd orchestrator && pnpm build && pnpm pack --dry-run --json` — pnpm pack has no `--dry-run` support; `npm pack --dry-run --json` is the correct inventory source and is recorded in the manifest `pack_command`. The generated inventory is committed at `artifacts/reliability/npm-pack-inventory.json` ✓
3. `python3 -m build rickgent-policies --outdir artifacts/reliability/python-dist` — exit 0, wheel + sdist produced ✓ (required installing the standard `build` PEP 517 frontend, a build-time tool, not a runtime dependency)
4. `node orchestrator/scripts/assert-package-inventory.mjs <npm-inventory> <python-dist>` — exit 0 ✓
5. `test -f LICENSE && rg -n "Apache License|Version 2.0" LICENSE` — exit 0 ✓

## Known limitations / notes

- **`pnpm pack --dry-run`** is not supported by pnpm; the manifest records
  `npm pack --dry-run --json` as the authoritative inventory source. `npm` is
  available alongside `pnpm` in the toolchain. This is a packaging-contract
  clarification, not a divergence: the npm inventory reflects exactly what
  `orchestrator/package.json#files` declares.
- **`python3 -m build`** required installing the standard PEP 517 `build`
  frontend (`pip3 install --break-system-packages build`). This is a build-time
  packaging tool, not a runtime dependency of rickgent or its policies; no
  decision doc is required (it is not added to `package.json` or
  `pyproject.toml` dependencies). t36 will pin it explicitly in CI.
- **Assembly model:** the npm tarball is cli-only (the compiled CLI + lockfile).
  The full runtime is assembled by `install.sh`, which installs the compatible
  Omnigent, builds the orchestrator, pip-installs the Python policies, links the
  `rickgent` launcher, and runs `doctor` as a fail-closed behavioral gate. Agent
  bundles resolve from the repository checkout during install. This
  `installer-assembles-runtime` model is recorded explicitly in the manifest's
  `assembly_plan`. A clean packed install (no source-tree fallback) is proven in
  t37; t35 delivers the contract and validators that make that proof possible.
- **build-commit.ts lag-by-one:** the committed `build-commit.ts` references the
  parent of the amended HEAD (per the established pattern); runtime parity is
  established by `init.sh` rebuilding dist to the current HEAD.
- t35 activates **no capability**. `doctor` reports the capability matrix
  unchanged (autonomous_dispatch enabled, parallel_dispatch/raw_shell
  unavailable), which is correct.

## Next dependency boundary

- **t36** (real lint/typecheck/coverage/mutation/CI gates) — depends on t35.
  The release manifest and package-inventory validators are now available for
  t36's CI to invoke. Note: `pnpm lint` (eslint) remains intentionally
  unconfigured for the orchestrator per CLAUDE.md; t36's lint threshold applies
  where linting is configured (e.g., Python policies via ruff).
- **t37** (packed-install behavioral doctor) — will consume the release
  manifest, the installer assembly plan, and the package-inventory assertions to
  prove a clean packed install with no source-tree fallback.
