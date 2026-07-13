"""A-SEC-4 — symlink / rename scope escape resolution + TS<->Python parity.

Fulfills VAL-SEC-038, VAL-SEC-039, VAL-SEC-041, VAL-SEC-056 (Python side):
the scope resolver must DENY symlink/rename escapes (checking BOTH source and
destination endpoints), resolve not-yet-created write paths via the nearest
existing parent, preserve existing `..`/absolute handling, and stay in parity
with the TS core on a shared symlink/rename fixture set.

These tests drive the REAL filesystem (tmp dir + real symlinks) and observe the
REAL verdict — never a mock. The parity harness materializes each shared
fixture under one temp root and compares the Python verdict against the TS core
verdict obtained via `rickgent verdict scope-resolved --json`.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from rickgent_policies import check_scope_resolved

FIXTURES_DIR = Path(__file__).parent.parent.parent / "conformance" / "symlink-fixtures"


def _build_fs(root: str, setup: dict) -> None:
    """Materialize the fixture's declared filesystem under `root`."""
    for d in setup.get("dirs", []) or []:
        os.makedirs(os.path.join(root, d), exist_ok=True)
    for f in setup.get("files", []) or []:
        p = os.path.join(root, f)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            fh.write("x")
    for link in setup.get("symlinks", []) or []:
        link_path = os.path.join(root, link["link"])
        os.makedirs(os.path.dirname(link_path), exist_ok=True)
        os.symlink(link["target"], link_path)


def _py_verdict(root: str, fx: dict) -> dict:
    return check_scope_resolved(
        root,
        fx["declaredPaths"],
        fx["targetPath"],
        fx["isWrite"],
        fx.get("destinationPath"),
    )


def _ts_verdict(root: str, fx: dict):
    """Invoke the TS core through the CLI. Returns None if rickgent is absent."""
    payload = {
        "root": root,
        "declaredPaths": fx["declaredPaths"],
        "targetPath": fx["targetPath"],
        "isWrite": fx["isWrite"],
    }
    if fx.get("destinationPath"):
        payload["destinationPath"] = fx["destinationPath"]
    try:
        proc = subprocess.run(
            ["rickgent", "verdict", "scope-resolved", "--json"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return None
    try:
        return json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        return {"error": True, "stdout": proc.stdout, "stderr": proc.stderr}


def _load_fixtures():
    fixtures = []
    if not FIXTURES_DIR.exists():
        return fixtures
    for f in sorted(FIXTURES_DIR.iterdir()):
        if f.suffix == ".json":
            fixtures.append(json.loads(f.read_text()))
    return fixtures


_FIXTURES = _load_fixtures()


@pytest.fixture()
def temp_root():
    root = tempfile.mkdtemp(prefix="rickgent-scope-")
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


# VAL-SEC-038 — Python shim denies a symlink escaping the declared dir.
def test_python_denies_symlink_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    os.symlink("/", os.path.join(temp_root, "declared", "root"))
    verdict = check_scope_resolved(temp_root, ["declared"], "declared/root/etc/passwd", True)
    assert verdict["result"] == "DENY"


# Guard sensitivity: the lexical helper wrongly treats the escape as in-scope,
# so the DENY above comes from realpath resolution, not lexical prefixing.
def test_lexical_helper_would_allow_symlink_escape():
    from rickgent_policies import _canonicalize_path, _is_path_in_scope

    target = _canonicalize_path("declared/root/etc/passwd")
    assert _is_path_in_scope(target, _canonicalize_path("declared")) is True


# VAL-SEC-056(a) — not-yet-created target under an escaping symlink parent -> DENY.
def test_python_denies_notyet_created_under_symlink_parent(temp_root):
    os.makedirs(os.path.join(temp_root, "declared"), exist_ok=True)
    os.symlink("/", os.path.join(temp_root, "declared", "link"))
    verdict = check_scope_resolved(temp_root, ["declared"], "declared/link/newfile", True)
    assert verdict["result"] == "DENY"


# VAL-SEC-056(b) — not-yet-created target under a real in-scope parent -> ALLOW.
def test_python_allows_notyet_created_in_scope_parent(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    verdict = check_scope_resolved(temp_root, ["declared"], "declared/sub/newfile", True)
    assert verdict["result"] == "ALLOW"


# VAL-SEC-040 — rename/link checks BOTH source and destination endpoints.
def test_python_denies_rename_dest_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    with open(os.path.join(temp_root, "declared", "sub", "a.py"), "w") as fh:
        fh.write("x")
    os.symlink("/", os.path.join(temp_root, "declared", "root"))
    verdict = check_scope_resolved(
        temp_root, ["declared"], "declared/sub/a.py", True, "declared/root/tmp/evil"
    )
    assert verdict["result"] == "DENY"


def test_python_denies_rename_src_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    os.symlink("/", os.path.join(temp_root, "declared", "root"))
    verdict = check_scope_resolved(
        temp_root, ["declared"], "declared/root/etc/passwd", True, "declared/sub/b.py"
    )
    assert verdict["result"] == "DENY"


# VAL-SEC-041 — existing `..` / absolute handling preserved (regression).
def test_python_denies_dotdot_traversal(temp_root):
    os.makedirs(os.path.join(temp_root, "declared"), exist_ok=True)
    os.makedirs(os.path.join(temp_root, "outside"), exist_ok=True)
    verdict = check_scope_resolved(temp_root, ["declared"], "declared/../outside/x.py", True)
    assert verdict["result"] == "DENY"


def test_python_denies_absolute_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared"), exist_ok=True)
    verdict = check_scope_resolved(temp_root, ["declared"], "/etc/passwd", True)
    assert verdict["result"] == "DENY"


def test_python_fails_closed_on_missing_root():
    assert check_scope_resolved("", ["declared"], "declared/x", True)["result"] == "DENY"


def test_python_allows_non_write(temp_root):
    assert check_scope_resolved(temp_root, ["declared"], "anywhere", False)["result"] == "ALLOW"


# VAL-SEC-039 — TS<->Python parity on the shared symlink/rename fixture set.
@pytest.mark.parametrize("fx", _FIXTURES, ids=lambda f: f.get("id", "unknown"))
def test_ts_python_parity_on_shared_symlink_fixtures(fx, temp_root):
    _build_fs(temp_root, fx.get("setup", {}))

    py = _py_verdict(temp_root, fx)
    ts = _ts_verdict(temp_root, fx)

    if ts is None:
        pytest.skip("rickgent CLI not available for parity comparison")

    assert "error" not in ts, f"TS CLI error for {fx['id']}: {ts}"
    assert py["result"] == fx["expected"], f"Python {fx['id']}: {py}"
    assert ts["result"] == fx["expected"], f"TS {fx['id']}: {ts}"
    assert py["result"] == ts["result"], f"parity mismatch {fx['id']}: py={py} ts={ts}"
