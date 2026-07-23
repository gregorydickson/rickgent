#!/usr/bin/env bash
set -euo pipefail

# Archive-only Rickgent installer. It intentionally has no repository-root
# discovery: every executable byte comes from the two supplied archives.

die() { printf 'RICKGENT_INSTALL_ERROR: %s\n' "$*" >&2; exit 2; }
note() { printf '==> %s\n' "$*"; }

npm_tarball=""
policy_wheel=""
install_prefix=""
launcher_dir=""

while (($#)); do
  case "$1" in
    --npm-tarball) (($# >= 2)) || die "--npm-tarball requires a value"; npm_tarball="$2"; shift 2 ;;
    --wheel) (($# >= 2)) || die "--wheel requires a value"; policy_wheel="$2"; shift 2 ;;
    --prefix) (($# >= 2)) || die "--prefix requires a value"; install_prefix="$2"; shift 2 ;;
    --launcher-dir) (($# >= 2)) || die "--launcher-dir requires a value"; launcher_dir="$2"; shift 2 ;;
    --help)
      printf 'Usage: install.sh --npm-tarball FILE --wheel FILE --prefix DIR --launcher-dir DIR\n'
      printf 'Requires absolute OMNIGENT_ROOT and OMNIGENT_PYTHON environment values.\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$npm_tarball" && -n "$policy_wheel" && -n "$install_prefix" && -n "$launcher_dir" ]] \
  || die "explicit --npm-tarball, --wheel, --prefix, and --launcher-dir are required"
[[ -n "${OMNIGENT_ROOT:-}" && -n "${OMNIGENT_PYTHON:-}" ]] \
  || die "OMNIGENT_ROOT and OMNIGENT_PYTHON are required"

for absolute_input in "$npm_tarball" "$policy_wheel" "$install_prefix" "$launcher_dir" "$OMNIGENT_ROOT" "$OMNIGENT_PYTHON"; do
  [[ "$absolute_input" = /* ]] || die "all archive, root, interpreter, and destination paths must be absolute: $absolute_input"
done
[[ -f "$npm_tarball" ]] || die "npm tarball not found: $npm_tarball"
[[ "$npm_tarball" == *.tgz ]] || die "npm archive must be a .tgz"
[[ -f "$policy_wheel" ]] || die "policy wheel not found: $policy_wheel"
[[ "$policy_wheel" == *.whl ]] || die "policy archive must be a wheel"
[[ -d "$OMNIGENT_ROOT" ]] || die "OMNIGENT_ROOT is not a directory"
[[ -x "$OMNIGENT_PYTHON" ]] || die "OMNIGENT_PYTHON is not executable"

command -v node >/dev/null || die "node is required"
command -v npm >/dev/null || die "npm is required"

npm_root="$install_prefix/npm"
venv_root="$install_prefix/python"
tmp_root="$install_prefix/.installing"
mkdir -p "$install_prefix" "$launcher_dir"
[[ ! -e "$tmp_root" ]] || die "interrupted installation staging exists: $tmp_root"
mkdir "$tmp_root"
cleanup() { rm -rf -- "$tmp_root"; }
trap cleanup EXIT INT TERM HUP

note "Installing immutable npm archive"
mkdir "$tmp_root/npm"
npm install --prefix "$tmp_root/npm" --ignore-scripts --omit=dev --no-audit --no-fund "$npm_tarball"
package_root="$tmp_root/npm/node_modules/rickgent"
[[ -x "$package_root/dist/cli.js" ]] || die "archive has no executable dist/cli.js"
for resource in agents/rickgent/config.yaml agents/rickgent/agents/worker/config.yaml runtime/resource-map.json proof/metadata.json validators LICENSE; do
  [[ -e "$package_root/$resource" ]] || die "archive resource missing: $resource"
done
[[ ! -e "$package_root/src" && ! -e "$package_root/test" ]] || die "source/test content is forbidden in installed archive"

note "Installing non-editable policy wheel"
"$OMNIGENT_PYTHON" -m venv --system-site-packages "$tmp_root/python"
"$tmp_root/python/bin/python" -m pip install --no-deps --no-cache-dir "$policy_wheel"
site_json="$("$tmp_root/python/bin/python" -c 'import importlib.metadata,json; d=importlib.metadata.distribution("rickgent-policies"); print(json.dumps([str(p) for p in d.files or []]))')"
[[ "$site_json" != *direct_url.json* && "$site_json" != *".pth"* && "$site_json" != *".egg-link"* ]] \
  || die "editable policy metadata is forbidden"

rm -rf -- "$npm_root" "$venv_root"
mv "$tmp_root/npm" "$npm_root"
mv "$tmp_root/python" "$venv_root"

installed_cli="$npm_root/node_modules/rickgent/dist/cli.js"
launcher="$launcher_dir/rickgent"
launcher_tmp="$launcher.tmp.$$"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'export OMNIGENT_ROOT=%q\n' "$OMNIGENT_ROOT"
  printf 'export OMNIGENT_PYTHON=%q\n' "$venv_root/bin/python"
  printf 'export PYTHONPATH=%q\n' "$OMNIGENT_ROOT"
  printf 'exec node %q "$@"\n' "$installed_cli"
} >"$launcher_tmp"
chmod 0755 "$launcher_tmp"
mv "$launcher_tmp" "$launcher"

note "Running installed behavioral doctor"
OMNIGENT_ROOT="$OMNIGENT_ROOT" \
OMNIGENT_PYTHON="$venv_root/bin/python" \
PYTHONPATH="$OMNIGENT_ROOT" \
node "$installed_cli" doctor --behavioral

trap - EXIT INT TERM HUP
cleanup
printf 'Installed rickgent launcher: %s\n' "$launcher"
