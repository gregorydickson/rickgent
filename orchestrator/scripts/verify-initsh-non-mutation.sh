#!/usr/bin/env bash
# Regression proof: sourcing init.sh must preserve the caller checkout and
# resolve the freshly built local CLI (architecture.md invariant 7).
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
#   0 — PASS: initialization preserves the checkout and resolves the local CLI
#   1 — FAIL: initialization violates either invariant
#   2 — SKIP: the target file has a pre-existing caller edit

set -euo pipefail

# Resolve the repo root from this script's location so it works regardless of CWD.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"

# Never normalize a caller's checkout. The proof itself must not discard an
# existing edit, so it only runs when the generated target starts clean.
TARGET="$REPO_ROOT/orchestrator/src/build-commit.ts"
if ! git -C "$REPO_ROOT" diff --quiet -- orchestrator/src/build-commit.ts ||
  ! git -C "$REPO_ROOT" diff --cached --quiet -- orchestrator/src/build-commit.ts; then
  echo "SKIP: build-commit.ts has a pre-existing caller edit." >&2
  exit 2
fi

# Production entrypoint under test, clean-caller case.
# shellcheck disable=SC1091
source "$REPO_ROOT/init.sh"

# Assertion: a clean caller remains clean.
if ! git -C "$REPO_ROOT" diff --quiet -- orchestrator/src/; then
  echo "FAIL: sourcing init.sh mutated tracked files under orchestrator/src/" >&2
  git -C "$REPO_ROOT" status --porcelain -- orchestrator/src/ >&2
  exit 1
fi

# Assertion: a caller edit is rejected rather than discarded.
SENTINEL="// verify-initsh-non-mutation caller sentinel"
cleanup() {
  git -C "$REPO_ROOT" checkout -- orchestrator/src/build-commit.ts
  rm -rf "${STALE_DIR:-}"
}
trap cleanup EXIT
printf "\n%s\n" "$SENTINEL" >> "$TARGET"
if ( source "$REPO_ROOT/init.sh" ); then
  echo "FAIL: init.sh accepted a caller edit to build-commit.ts" >&2
  exit 1
fi
if ! grep -Fqx "$SENTINEL" "$TARGET"; then
  echo "FAIL: init.sh discarded a caller edit to build-commit.ts" >&2
  exit 1
fi
git -C "$REPO_ROOT" checkout -- orchestrator/src/build-commit.ts

# Assertion: the repository-local launcher wins even when the repository path
# already appears later than a stale executable in PATH.
STALE_DIR="$(mktemp -d)"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STALE_DIR/rickgent"
chmod +x "$STALE_DIR/rickgent"
PATH="$STALE_DIR:$REPO_ROOT:$PATH"
export PATH
hash -r
source "$REPO_ROOT/init.sh"
if [[ "$(command -v rickgent)" != "$REPO_ROOT/rickgent" ]]; then
  echo "FAIL: init.sh did not prioritize the repository-local rickgent launcher" >&2
  exit 1
fi

echo "PASS: init.sh preserves caller state and resolves the local CLI"
