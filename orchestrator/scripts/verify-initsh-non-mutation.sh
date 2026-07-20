#!/usr/bin/env bash
# Regression proof: sourcing init.sh must NOT mutate tracked files under
# orchestrator/src/ (architecture.md invariant 7 — caller checkout/index
# non-mutation).
#
# Background: `pnpm build` (run by init.sh) regenerates the tracked
# orchestrator/src/build-commit.ts to the current git HEAD. If HEAD has moved
# since build-commit.ts was committed, the tracked working tree is left dirty
# after a fresh checkout — violating invariant 7. init.sh must restore
# build-commit.ts to its committed value after the rebuild.
#
# This proof is RED against the pre-fix init.sh (build-commit.ts modified) and
# GREEN after the fix (init.sh restores build-commit.ts via
# `git checkout -- orchestrator/src/build-commit.ts`).
#
# Usage:
#   bash orchestrator/scripts/verify-initsh-non-mutation.sh
#
# Exit codes:
#   0 — PASS: sourcing init.sh left orchestrator/src/ clean
#   1 — FAIL: sourcing init.sh mutated tracked files under orchestrator/src/
#   2 — SKIP: orchestrator/src/ had pre-existing modifications unrelated to init.sh

set -euo pipefail

# Resolve the repo root from this script's location so it works regardless of CWD.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"

# Precondition: establish a clean orchestrator/src/ baseline. Restore
# build-commit.ts to its committed value so the proof is deterministic and
# re-runnable (the proof must hold regardless of prior state).
git -C "$REPO_ROOT" checkout -- orchestrator/src/build-commit.ts 2>/dev/null || true

# Sanity: confirm the baseline is clean before sourcing. If there are other
# pre-existing tracked modifications under orchestrator/src/ unrelated to
# init.sh, skip rather than report a false failure.
if ! git -C "$REPO_ROOT" diff --exit-code -- orchestrator/src/ >/dev/null 2>&1; then
  echo "SKIP: orchestrator/src/ has pre-existing tracked modifications unrelated to init.sh." >&2
  git -C "$REPO_ROOT" status --porcelain -- orchestrator/src/ >&2
  exit 2
fi

# Production entrypoint under test: source init.sh. This rebuilds
# orchestrator/dist/cli.js (untracked, stays fresh) and regenerates
# orchestrator/src/build-commit.ts (tracked) to the current git HEAD.
# shellcheck disable=SC1091
source "$REPO_ROOT/init.sh"

# Assertion (architecture.md invariant 7): sourcing init.sh must leave NO
# tracked-file modifications under orchestrator/src/. dist/cli.js is untracked
# (gitignored) and is expected to be freshly built; build-commit.ts is tracked
# and must be restored to its committed value.
if git -C "$REPO_ROOT" diff --exit-code -- orchestrator/src/; then
  echo "PASS: sourcing init.sh left orchestrator/src/ clean (no tracked-file mutations)"
  exit 0
else
  echo "FAIL: sourcing init.sh mutated tracked files under orchestrator/src/" >&2
  git -C "$REPO_ROOT" status --porcelain -- orchestrator/src/ >&2
  # Cleanup so re-running doesn't accumulate: restore build-commit.ts to its
  # committed value before exiting.
  git -C "$REPO_ROOT" checkout -- orchestrator/src/build-commit.ts 2>/dev/null || true
  exit 1
fi
