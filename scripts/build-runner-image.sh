#!/usr/bin/env bash
# Build the rickgent containment runner Docker image (t22D-fix-round-3).
#
# This script builds the Linux-compatible Docker image that has Python, Node.js,
# and omnigent pre-installed.  The image replaces the previous approach of
# bind-mounting macOS host binaries into an Alpine container (Darwin binaries
# cannot run inside Linux).  Only data paths are mounted at runtime via -v.
#
# Usage:
#   bash scripts/build-runner-image.sh [--rebuild]
#
# The image is tagged as `rickgent-runner:latest`.  Set
# RICKGENT_CONTAINMENT_DOCKER_IMAGE=rickgent-runner:latest to use it as the
# containment boundary image.
#
# This is a one-time setup step.  The image is reused for all subsequent
# dispatches.  Idempotent: if the image already exists and --rebuild is not
# passed, the script exits 0 without rebuilding.

set -euo pipefail

IMAGE_NAME="${RICKGENT_RUNNER_IMAGE:-rickgent-runner:latest}"
OMNIGENT_ROOT="${OMNIGENT_ROOT:-/Users/gregorydickson/loanlight/pickle-rick/omnigent}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check Docker is available.
if ! command -v docker >/dev/null 2>&1; then
  echo "build-runner-image.sh: docker is not available" >&2
  exit 1
fi

# Check omnigent source exists.
if [[ ! -d "$OMNIGENT_ROOT" ]]; then
  echo "build-runner-image.sh: omnigent source not found at $OMNIGENT_ROOT" >&2
  exit 1
fi

# Skip if the image already exists and --rebuild is not passed.
if [[ "${1:-}" != "--rebuild" ]]; then
  if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    echo "build-runner-image.sh: image $IMAGE_NAME already exists (use --rebuild to rebuild)"
    exit 0
  fi
fi

echo "build-runner-image.sh: building $IMAGE_NAME from $REPO_ROOT/docker/runner.Dockerfile"

# Build the image.  The omnigent source is copied into the image context.
# We use a .dockerignore-like approach by copying only the omnigent directory.
# The build context is the repo root so the Dockerfile can COPY the omnigent source.
docker build \
  -t "$IMAGE_NAME" \
  -f "$REPO_ROOT/docker/runner.Dockerfile" \
  --build-arg "OMNIGENT_PATH=$OMNIGENT_ROOT" \
  "$OMNIGENT_ROOT" \
  --file "$REPO_ROOT/docker/runner.Dockerfile"

echo "build-runner-image.sh: image $IMAGE_NAME built successfully"
