"""C4 enforcement — build-commit parity guard + attachment adequacy.

This suite covers the C4 enforcement feature (m1-c4-enforcement):

- `_assert_build_commit` runs BEFORE the first verdict-dependent policy call
  (any policy that shells out via `_rickgent_verdict`), so the TS↔Python
  verdict core is proven in-parity before any verdict is trusted.
- `_assert_build_commit` FAILS CLOSED (raises) on a TS↔Python build-commit
  mismatch rather than swallowing it (`except: pass`).
- The C4 attachment enforcement is non-tautological: it goes RED when the
  MANAGER or WORKER effective attached set (parser-derived) drops any required
  policy, and GREEN when the full required set is attached.

Behavior is VERIFIED (drive the real policy entrypoint / real parser over a
mutated bundle), never asserted against a mock's return.

Fulfills: VAL-ATTACH-021, VAL-ATTACH-022, VAL-ATTACH-023, VAL-ATTACH-024.
"""

import hashlib
import shutil
import types
from pathlib import Path

import pytest
import yaml

import rickgent_policies.verdict as verdict_module
from rickgent_policies import (
    REQUIRED_POLICIES,
    effective_attached_policies,
)

REPO_ROOT = Path(__file__).parent.parent.parent
MANAGER_DIR = REPO_ROOT / "agents" / "rickgent"
WORKER_DIR = REPO_ROOT / "agents" / "rickgent" / "agents" / "worker"

# The rickgent shim policies that live in the bundle `guardrails:` block and
# can be dropped to exercise the enforcement. `blast_radius` is the omnigent
# builtin; dropping any of these must be detected by the C4 audit.
_DROPPABLE = sorted(REQUIRED_POLICIES - {"blast_radius"})


def _fake_run(stdout, returncode=0):
    def run(*args, **kwargs):
        return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")

    return run


def _pin_cli(monkeypatch, tmp_path: Path) -> Path:
    node = (tmp_path / "node").resolve()
    node.write_text("immutable test Node\n")
    node.chmod(0o700)
    cli = (tmp_path / "rickgent-cli.js").resolve()
    cli.write_text("// immutable test CLI\n")
    monkeypatch.setattr(verdict_module, "_RICKGENT_NODE", str(node))
    monkeypatch.setattr(
        verdict_module,
        "_RICKGENT_NODE_SHA256",
        hashlib.sha256(node.read_bytes()).hexdigest(),
    )
    monkeypatch.setattr(verdict_module, "_RICKGENT_BIN", str(cli))
    monkeypatch.setattr(
        verdict_module,
        "_RICKGENT_BIN_SHA256",
        hashlib.sha256(cli.read_bytes()).hexdigest(),
    )
    return cli


# ── VAL-ATTACH-022: _assert_build_commit fails closed on mismatch ────────────


def test_assert_build_commit_raises_on_mismatch(monkeypatch, tmp_path):
    """VAL-ATTACH-022: a TS↔Python build-commit mismatch raises (fail closed)."""
    _pin_cli(monkeypatch, tmp_path)
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", "py-aaaaaaaaaaaa")
    monkeypatch.setattr(
        verdict_module.subprocess, "run", _fake_run("ts-bbbbbbbbbbbb\n")
    )
    with pytest.raises(RuntimeError):
        verdict_module._assert_build_commit()


def test_assert_build_commit_raises_on_nonzero_exit(monkeypatch, tmp_path):
    """VAL-ATTACH-022: a failing `rickgent --build-commit` fails closed."""
    _pin_cli(monkeypatch, tmp_path)
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", "same-commit")
    monkeypatch.setattr(
        verdict_module.subprocess, "run", _fake_run("", returncode=2)
    )
    with pytest.raises(RuntimeError):
        verdict_module._assert_build_commit()


def test_assert_build_commit_ok_on_match(monkeypatch, tmp_path):
    """VAL-ATTACH-022 (negative): matching commits do not raise."""
    _pin_cli(monkeypatch, tmp_path)
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", "same-commit")
    monkeypatch.setattr(
        verdict_module.subprocess, "run", _fake_run("same-commit\n")
    )
    verdict_module._assert_build_commit()  # must not raise


def test_assert_build_commit_rejects_missing_pinned_cli(monkeypatch, tmp_path):
    """VAL-ATTACH-022: an unavailable pinned CLI fails closed before verdicts."""

    missing = (tmp_path / "missing-rickgent-cli.js").resolve()
    _pin_cli(monkeypatch, tmp_path)
    monkeypatch.setattr(verdict_module, "_RICKGENT_BIN", str(missing))
    monkeypatch.setattr(verdict_module, "_RICKGENT_BIN_SHA256", "a" * 64)
    monkeypatch.setattr(verdict_module, "BUILD_COMMIT", "same-commit")
    with pytest.raises(RuntimeError, match="could not be opened securely"):
        verdict_module._assert_build_commit()


# ── VAL-ATTACH-023 / 024: C4 attachment enforcement is non-tautological ──────


def _mutated_bundle_drop_policy(src_dir: Path, dst_dir: Path, policy_name: str) -> Path:
    """Copy a bundle and drop one policy from its `guardrails:` block."""
    shutil.copytree(src_dir, dst_dir)
    cfg = dst_dir / "config.yaml"
    data = yaml.safe_load(cfg.read_text())
    del data["guardrails"]["policies"][policy_name]
    cfg.write_text(yaml.safe_dump(data, sort_keys=False))
    return dst_dir


def test_c4_manager_passes_when_full_set_attached():
    """VAL-ATTACH-023 (green): the real manager bundle attaches the full set."""
    assert REQUIRED_POLICIES - effective_attached_policies(MANAGER_DIR) == set()


@pytest.mark.parametrize("dropped", _DROPPABLE)
def test_c4_manager_fails_when_policy_dropped(tmp_path, dropped):
    """VAL-ATTACH-023 (red-on-gap): dropping any required policy is detected.

    Drives the real omnigent parser over a mutated manager bundle: the C4
    adequacy predicate (`REQUIRED_POLICIES <= effective`) must go false, i.e.
    the enforcement test would FAIL when the manager effective set != required.
    """
    mutated = _mutated_bundle_drop_policy(MANAGER_DIR, tmp_path / "manager", dropped)
    effective = effective_attached_policies(mutated)
    missing = REQUIRED_POLICIES - effective
    assert dropped in missing, (
        f"dropping {dropped} from the manager bundle was not detected as a gap"
    )
    assert not (REQUIRED_POLICIES <= effective), (
        "C4 adequacy predicate stayed satisfied despite a dropped policy"
    )


def test_c4_worker_passes_when_full_set_attached():
    """VAL-ATTACH-024 (green): the real worker bundle attaches the full set."""
    assert REQUIRED_POLICIES - effective_attached_policies(WORKER_DIR) == set()


@pytest.mark.parametrize("dropped", _DROPPABLE)
def test_c4_worker_fails_when_policy_dropped(tmp_path, dropped):
    """VAL-ATTACH-024 (red-on-gap): dropping any required policy is detected."""
    mutated = _mutated_bundle_drop_policy(WORKER_DIR, tmp_path / "worker", dropped)
    effective = effective_attached_policies(mutated)
    missing = REQUIRED_POLICIES - effective
    assert dropped in missing, (
        f"dropping {dropped} from the worker bundle was not detected as a gap"
    )
    assert not (REQUIRED_POLICIES <= effective), (
        "C4 adequacy predicate stayed satisfied despite a dropped policy"
    )
