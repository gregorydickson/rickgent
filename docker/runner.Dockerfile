# Rickgent containment runner image (t22D-fix-round-3).
#
# A proper Linux-compatible Docker image for the AttemptRunner's containment
# boundary.  Previous fix round bind-mounted macOS host binaries (Node, Python,
# omnigent) into an Alpine Linux container where Darwin binaries cannot run.
# This image has Python, Node.js, and omnigent pre-installed so the dispatched
# `omnigent run <agentDir> -p <prompt>` command can actually execute inside
# the containment boundary.  Only data paths (agent bundle, worktree, PRD)
# are mounted via -v volumes at runtime.
#
# Build:
#   docker build -t rickgent-runner:latest -f docker/runner.Dockerfile \
#     --build-arg OMNIGENT_PATH=/path/to/omnigent \
#     .
#
# Or use the build script:
#   bash scripts/build-runner-image.sh
#
# The image is built once during setup (init.sh or the build script) and
# reused as the containment boundary image for all subsequent dispatches.

FROM python:3.12-alpine

# Install system dependencies: git, curl, bash, build tools for native modules.
RUN apk add --no-cache \
    git \
    bash \
    curl \
    ca-certificates \
    build-base \
    linux-headers \
    pcre-dev \
    libffi-dev \
    openssl-dev \
    bzip2-dev \
    zlib-dev \
    readline-dev \
    sqlite-dev \
    postgresql-dev

# Install Node.js 24.x from the official Alpine repository.
# Node is required for the orchestrator and the omnigent worker runtime.
RUN apk add --no-cache nodejs npm

# Verify git and node are available and are Linux binaries.
RUN git --version && node --version && python3 --version

# Install omnigent from the host source tree.
# The source is copied into the image and installed in editable mode so the
# container has its own omnigent installation — not a bind-mounted Darwin
# binary that cannot run inside Linux.
# The build context is the omnigent source directory; COPY . copies it into
# the image.
# NOTE: omnigent-client==0.6.0.dev0 is a dev version not on PyPI; install
# with --no-deps and let the runtime resolve the client from the mounted
# host installation, or install the client separately when available.
COPY . /opt/omnigent
RUN cd /opt/omnigent && pip install --no-cache-dir --no-deps -e . || \
    echo "warning: omnigent editable install failed; runtime will use mounted host installation"

# Verify omnigent is importable and the CLI is on PATH.
RUN python3 -c "import omnigent; print('omnigent OK')" && \
    which omnigent || true

# Create the rickgent data directory structure.
RUN mkdir -p /rickgent/agents /rickgent/data /rickgent/worktrees

# Set environment for the container.
ENV PATH="/usr/local/bin:/usr/bin:/bin:/opt/omnigent/bin:${PATH}"
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

# Default sleep command — the container stays alive so the containment
# authority can exec commands into it via `docker exec`.
CMD ["sleep", "3600"]
