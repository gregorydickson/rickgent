#!/usr/bin/env bash
set -euo pipefail

# Rickgent installer — detects/installs omnigent, rickgent, and skills for Claude Code + Codex.
# Idempotent: safe to run multiple times.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
omnigent_pin="6e3c7785"
omnigent_github="https://github.com/gregorydickson/omnigent.git"

# --- Helpers ----------------------------------------------------------------

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

check_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- Prerequisites -----------------------------------------------------------

info "Checking prerequisites"
check_cmd node   || fail "node not found (install Node.js 24+)"
check_cmd pnpm   || fail "pnpm not found (install pnpm 10+)"
check_cmd python3 || fail "python3 not found (install Python 3.12+)"
check_cmd pip3   || fail "pip3 not found (install pip)"
check_cmd git    || fail "git not found"
ok "prerequisites satisfied"

# --- omnigent ----------------------------------------------------------------

info "Checking omnigent"

omnigent_installed() {
  python3 -c "import importlib.metadata; print(importlib.metadata.version('omnigent'))" 2>/dev/null
}

if omnigent_ver="$(omnigent_installed)"; then
  ok "omnigent ${omnigent_ver} already installed"
else
  warn "omnigent not found — installing"

  # Try sibling directory first
  omnigent_src=""
  if [[ -f "$repo_root/../omnigent/setup.py" ]] || [[ -f "$repo_root/../omnigent/pyproject.toml" ]]; then
    omnigent_src="$(cd "$repo_root/../omnigent" && pwd)"
    info "Found omnigent source at $omnigent_src"
  else
    # Clone from GitHub
    omnigent_src="$(cd "$repo_root/.." && pwd)/omnigent"
    info "Cloning omnigent from GitHub to $omnigent_src"
    git clone "$omnigent_github" "$omnigent_src" || fail "failed to clone omnigent"
  fi

  (cd "$omnigent_src" && pip3 install -e .) || fail "failed to install omnigent"
  omnigent_ver="$(omnigent_installed)" || fail "omnigent install verification failed"
  ok "omnigent ${omnigent_ver} installed"
fi

# --- rickgent orchestrator ---------------------------------------------------

info "Installing rickgent orchestrator"
( cd "$repo_root/orchestrator" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install ) \
  || fail "pnpm install failed"
( cd "$repo_root/orchestrator" && pnpm build ) || fail "pnpm build failed"
ok "orchestrator built"

# --- rickgent policies -------------------------------------------------------

info "Installing rickgent policies"
( cd "$repo_root/rickgent-policies" && pip3 install -e . ) || fail "pip install rickgent-policies failed"
ok "policies installed"

# --- Verify with doctor ------------------------------------------------------

info "Running rickgent doctor"
if ( cd "$repo_root" && node orchestrator/dist/cli.js doctor ); then
  ok "doctor passed"
else
  warn "doctor reported issues — check output above"
fi

# --- Claude Code skills ------------------------------------------------------

info "Installing Claude Code skills globally"

claude_commands_dir="$HOME/.claude/commands"
mkdir -p "$claude_commands_dir"

for skill_file in "$repo_root/.claude/commands/"*.md; do
  [[ -f "$skill_file" ]] || continue
  skill_name="$(basename "$skill_file")"
  cp "$skill_file" "$claude_commands_dir/"
  ok "installed /$(basename "$skill_name" .md) for Claude Code"
done

# --- Codex skills ------------------------------------------------------------

info "Installing Codex skills globally"

codex_skills_dir="$HOME/.codex/skills"
mkdir -p "$codex_skills_dir"

for skill_dir in "$repo_root/.codex/skills"/*; do
  [[ -d "$skill_dir" ]] || continue
  skill_name="$(basename "$skill_dir")"
  rm -rf "$codex_skills_dir/$skill_name"
  cp -R "$skill_dir" "$codex_skills_dir/"
  ok "installed $skill_name for Codex"
done

# --- Done --------------------------------------------------------------------

echo
info "Rickgent installation complete"
echo
echo "  CLI:      node $repo_root/orchestrator/dist/cli.js <command>"
echo "  Commands: rickgent prd | refine | build | pipeline | citadel | szechuan | anatomy | microverse | cronenberg"
echo "  Skills:   /rickgent-prd, /rickgent-models (Claude Code + Codex)"
echo "  Verify:   node $repo_root/orchestrator/dist/cli.js doctor"
