"""Pinned Rickgent CLI provenance for the Python verdict bridge."""

from __future__ import annotations

import hashlib
import types
from pathlib import Path

import pytest

import rickgent_policies.verdict as verdict_module


def _bind(monkeypatch: pytest.MonkeyPatch, path: Path, commit: str = "commit-001") -> Path:
    node = path.parent / "node"
    node.write_text("test node artifact\n")
    node.chmod(0o700)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o700)
    monkeypatch.setattr(verdict_module, "_RICKGENT_NODE", str(node.resolve()))
    monkeypatch.setattr(
        verdict_module,
        "_RICKGENT_NODE_SHA256",
        hashlib.sha256(node.read_bytes()).hexdigest(),
    )
    monkeypatch.setattr(verdict_module, "_RICKGENT_BIN", str(path.resolve()))
    monkeypatch.setattr(
        verdict_module,
        "_RICKGENT_BIN_SHA256",
        hashlib.sha256(path.read_bytes()).hexdigest(),
    )
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", commit)
    return node.resolve()


def test_detect_build_commit_never_searches_path(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", "pinned-commit")
    monkeypatch.setattr(
        verdict_module.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("build identity must not be PATH-detected"),
    )
    assert verdict_module._detect_build_commit() == "pinned-commit"


def test_assert_build_commit_rehashes_exact_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    cli = tmp_path / "rickgent"
    node = _bind(monkeypatch, cli)
    calls: list[list[str]] = []

    def run(command, **_kwargs):
        calls.append(command)
        return types.SimpleNamespace(returncode=0, stdout="commit-001\n", stderr="")

    monkeypatch.setattr(verdict_module.subprocess, "run", run)
    verdict_module._assert_build_commit()
    assert calls == [[str(node), str(cli.resolve()), "--build-commit"]]

    cli.write_text("tampered\n")
    with pytest.raises(RuntimeError, match="digest mismatch"):
        verdict_module._assert_build_commit()


@pytest.mark.parametrize(
    ("path", "digest", "commit"),
    [("", "0" * 64, "commit"), ("/missing/rickgent", "bad", "commit"), ("/missing/rickgent", "0" * 64, "")],
)
def test_missing_provenance_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    digest: str,
    commit: str,
):
    valid_cli = tmp_path / "valid-rickgent"
    _bind(monkeypatch, valid_cli, commit)
    monkeypatch.setattr(verdict_module, "_RICKGENT_BIN", path)
    monkeypatch.setattr(verdict_module, "_RICKGENT_BIN_SHA256", digest)
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", commit)
    with pytest.raises(RuntimeError):
        verdict_module._assert_build_commit()


def test_verified_verdict_checks_commit_then_exact_cli(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    cli = tmp_path / "rickgent"
    node = _bind(monkeypatch, cli)
    calls: list[list[str]] = []

    def run(command, **_kwargs):
        calls.append(command)
        if command[2:] == ["--build-commit"]:
            return types.SimpleNamespace(returncode=0, stdout="commit-001\n", stderr="")
        return types.SimpleNamespace(returncode=0, stdout='{"passed":true}', stderr="")

    monkeypatch.setattr(verdict_module.subprocess, "run", run)
    assert verdict_module._verified_verdict("gate", {}) == {"passed": True}
    assert calls == [
        [str(node), str(cli.resolve()), "--build-commit"],
        [str(node), str(cli.resolve()), "verdict", "gate", "--json"],
    ]


def test_assert_build_commit_rejects_tampered_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    cli = tmp_path / "rickgent"
    node = _bind(monkeypatch, cli)
    Path(node).write_text("tampered node\n")
    with pytest.raises(RuntimeError, match="Node digest mismatch"):
        verdict_module._assert_build_commit()
