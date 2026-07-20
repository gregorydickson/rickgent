#!/usr/bin/env bash
# Rickgent Mission 3 environment wiring.
#
# Source this file at the start of every worker/validator session:
#   source ./init.sh
#
# It is idempotent and safe to re-source. It exports the env vars required by
# the Python conformance suite and the omnigent contract verifier, then ensures
# orchestrator/dist/cli.js is freshly built so RICKGENT_CLI_REALPATH resolves
# against the current checkout (not a stale global shim).
#
# This script ONLY exports env and rebuilds the orchestrator dist. It does not
# install dependencies (use install.sh for that). It never mutates the caller
# checkout, HEAD, index, or untracked files.
#
# Documented in library/environment.md (mission dir).

set -euo pipefail

# Resolve the repo root from this file's location so the script works regardless
# of the caller's CWD.
__rickgent_init_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# 1. PATH — prepend the local CLI launcher plus the verified nvm node + pnpm
#    locations so `rickgent`, node, and pnpm resolve deterministically
#    (CLAUDE.md pins Node v24.13.1, pnpm 10.22.0). The launcher delegates to
#    the freshly-built dist CLI, rather than a potentially stale global shim.
case ":${PATH:-}:" in
  ":$__rickgent_init_root:"*) ;;
  *) PATH="$__rickgent_init_root${PATH:+:$PATH}" ;;
esac
__rickgent_node_bin="/Users/gregorydickson/.nvm/versions/node/v24.13.1/bin"
__rickgent_pnpm_bin="/Users/gregorydickson/.local/share/pnpm"
case ":${PATH:-}:" in
  *":$__rickgent_node_bin:"*) ;;
  *) PATH="$__rickgent_node_bin:$PATH" ;;
esac
case ":${PATH:-}:" in
  *":$__rickgent_pnpm_bin:"*) ;;
  *) PATH="$__rickgent_pnpm_bin:$PATH" ;;
esac
export PATH

# 2. OMNIGENT_ROOT — pinned READ-ONLY sibling dependency (omnigent 0.6.0.dev0,
#    editable install). The t00 contract verifier and the reliability suites
#    resolve the real omnigent package from here.
export OMNIGENT_ROOT="/Users/gregorydickson/loanlight/pickle-rick/omnigent"

# 3. OMNIGENT_PYTHON — the interpreter that imports omnigent. Pinned to the
#    current python3 so the contract probe and policy suites use the same
#    interpreter that has the editable install.
export OMNIGENT_PYTHON="$(command -v python3)"

# 4. RICKGENT_CLI_REALPATH / RICKGENT_NODE_REALPATH — the Python conformance
#    suite (test_conformance.py) spawns the rickgent binary via these realpaths.
#    Without them, tests hit a stale global shim and fail with POLICY_SHIM_ERROR.
export RICKGENT_CLI_REALPATH="$__rickgent_init_root/orchestrator/dist/cli.js"
export RICKGENT_NODE_REALPATH="$(command -v node)"

# 5. RICKGENT_BUILD_COMMIT — TS↔Python build_commit parity (VAL-CROSS-005).
#    The Python policy shim reads this at import time
#    (rickgent_policies.verdict.BUILD_COMMIT); the TS CLI bakes the same value
#    into orchestrator/src/build-commit.ts via `pnpm build`. init.sh sets this
#    to the current git HEAD AFTER rebuilding dist so both sides agree. Without
#    it, test_compat.py / test_ac19.py report build_commit mismatch failures.
__rickgent_head="$(git -C "$__rickgent_init_root" rev-parse HEAD 2>/dev/null || true)"
if [[ -n "$__rickgent_head" ]]; then
  export RICKGENT_BUILD_COMMIT="$__rickgent_head"
fi

# 6. Rebuild orchestrator/dist/cli.js so RICKGENT_CLI_REALPATH points at a
#    freshly built artifact reflecting the current checkout. pnpm build also
#    refreshes the embedded build-commit. This is required after any TS change
#    before running Python conformance tests (CLAUDE.md).
#    Skipped when RICKGENT_INIT_SKIP_BUILD=1 (e.g. when the caller knows dist is
#    current and wants to avoid the rebuild cost).
if [[ "${RICKGENT_INIT_SKIP_BUILD:-0}" != "1" ]]; then
  # `pnpm build` rewrites this tracked source. Refuse to discard a caller's
  # existing edit, rather than attempting a lossy restore after the build.
  if ! git -C "$__rickgent_init_root" diff --quiet -- \
    orchestrator/src/build-commit.ts; then
    echo "init.sh: refusing to overwrite caller edit to orchestrator/src/build-commit.ts" >&2
    exit 1
  fi

  ( cd "$__rickgent_init_root/orchestrator" && pnpm build >/dev/null )

  # 6a. Non-mutation restore (architecture.md invariant 7). `pnpm build`
  #     regenerates the tracked orchestrator/src/build-commit.ts to the current
  #     git HEAD; if HEAD has moved since build-commit.ts was committed, the
  #     tracked working tree is left dirty after a fresh checkout, violating
  #     the caller checkout/index non-mutation invariant. dist/cli.js is
  #     untracked (gitignored) and stays freshly built; build-commit.ts is
  #     tracked and is restored to its committed value. The compiled
  #     dist/build-commit.js still reflects the current HEAD (built above), so
  #     TS/Python build_commit parity (step 7) is unaffected. `git checkout`
  #     is a no-op when the file is unmodified, so this is idempotent and safe
  #     to re-source.
  git -C "$__rickgent_init_root" checkout -- \
    orchestrator/src/build-commit.ts
fi

# 7. After the rebuild, re-pin RICKGENT_BUILD_COMMIT to the build-commit the
#    rebuild just baked into dist (it equals git HEAD, but reading it back from
#    the built artifact guarantees TS/Python agreement even if git HEAD moved
#    between step 5 and the rebuild).
__rickgent_built_commit="$(node -e "console.log(require('$__rickgent_init_root/orchestrator/dist/build-commit.js').BUILD_COMMIT)" 2>/dev/null || true)"
if [[ -n "$__rickgent_built_commit" ]]; then
  export RICKGENT_BUILD_COMMIT="$__rickgent_built_commit"
fi

unset __rickgent_init_root __rickgent_node_bin __rickgent_pnpm_bin __rickgent_head __rickgent_built_commit
