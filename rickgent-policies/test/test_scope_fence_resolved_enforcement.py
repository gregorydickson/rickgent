"""A-SEC-4 (enforcement wiring) — scope_fence runtime path resolves symlinks.

The runtime ENFORCEMENT entrypoint `scope_fence` must route write decisions
through the realpath-resolving `check_scope_resolved`, not the lexical
`_canonicalize_path`/`_is_path_in_scope` matcher. These tests drive the REAL
production policy entrypoint (`scope_fence(event, config)`) against REAL
on-disk symlinks and observe the REAL verdict:

  (a) a structured write whose realpath escapes the declared set is DENIED,
  (b) rename/link ops validate BOTH source and destination endpoints,
  (c) existing ../absolute denial and in-scope read/write behavior is preserved.
"""

import os
import shutil
import tempfile

import pytest

from rickgent_policies import scope_fence


@pytest.fixture()
def temp_root():
    root = tempfile.mkdtemp(prefix="rickgent-scopefence-")
    try:
        yield os.path.realpath(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _config(root):
    return {"ticket_id": "T1", "declared_paths": ["declared"], "worktree_root": root}


# ── symlink escape via the production scope_fence entrypoint ──────────────────

def test_scope_fence_denies_symlink_escape_write(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    os.symlink("/", os.path.join(temp_root, "declared", "root"))
    event = {"tool_name": "Write", "path": "declared/root/etc/passwd"}
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "DENY"


def test_scope_fence_denies_notyet_created_under_symlink_parent(temp_root):
    os.makedirs(os.path.join(temp_root, "declared"), exist_ok=True)
    os.symlink("/", os.path.join(temp_root, "declared", "link"))
    event = {"tool_name": "Edit", "file_path": "declared/link/newfile.py"}
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "DENY"


# ── rename/link ops check BOTH endpoints via scope_fence ──────────────────────

def test_scope_fence_denies_rename_dest_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    with open(os.path.join(temp_root, "declared", "sub", "a.py"), "w") as fh:
        fh.write("x")
    os.symlink("/", os.path.join(temp_root, "declared", "root"))
    event = {
        "tool_name": "Write",
        "path": "declared/sub/a.py",
        "destination": "declared/root/tmp/evil",
    }
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "DENY"


def test_scope_fence_denies_rename_src_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    os.symlink("/", os.path.join(temp_root, "declared", "root"))
    event = {
        "tool_name": "Write",
        "path": "declared/root/etc/passwd",
        "destination": "declared/sub/b.py",
    }
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "DENY"


# ── preserved behavior (regression) ───────────────────────────────────────────

def test_scope_fence_allows_in_scope_write(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    event = {"tool_name": "Write", "path": "declared/sub/login.py"}
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "ALLOW"


def test_scope_fence_allows_in_scope_rename(temp_root):
    os.makedirs(os.path.join(temp_root, "declared", "sub"), exist_ok=True)
    event = {
        "tool_name": "Write",
        "path": "declared/sub/a.py",
        "destination": "declared/sub/b.py",
    }
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "ALLOW"


def test_scope_fence_denies_dotdot_traversal(temp_root):
    os.makedirs(os.path.join(temp_root, "declared"), exist_ok=True)
    os.makedirs(os.path.join(temp_root, "outside"), exist_ok=True)
    event = {"tool_name": "Write", "path": "declared/../outside/x.py"}
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "DENY"


def test_scope_fence_denies_absolute_escape(temp_root):
    os.makedirs(os.path.join(temp_root, "declared"), exist_ok=True)
    event = {"tool_name": "Write", "path": "/etc/passwd"}
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "DENY"


def test_scope_fence_allows_read_outside_scope(temp_root):
    event = {"tool_name": "Read", "path": "anywhere/else.py"}
    result = scope_fence(event, _config(temp_root))
    assert result["result"] == "ALLOW"
