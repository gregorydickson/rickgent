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

import shutil
import types
from pathlib import Path

import pytest
import yaml

import rickgent_policies
from rickgent_policies import (
    REQUIRED_POLICIES,
    completion_evidence,
    convergence_gate,
    effective_attached_policies,
    subtract_before_add,
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


# ── VAL-ATTACH-022: _assert_build_commit fails closed on mismatch ────────────


def test_assert_build_commit_raises_on_mismatch(monkeypatch):
    """VAL-ATTACH-022: a TS↔Python build-commit mismatch raises (fail closed)."""
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "py-aaaaaaaaaaaa")
    monkeypatch.setattr(
        rickgent_policies.subprocess, "run", _fake_run("ts-bbbbbbbbbbbb\n")
    )
    with pytest.raises(RuntimeError):
        rickgent_policies._assert_build_commit()


def test_assert_build_commit_raises_on_nonzero_exit(monkeypatch):
    """VAL-ATTACH-022: a failing `rickgent --build-commit` fails closed."""
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "same-commit")
    monkeypatch.setattr(
        rickgent_policies.subprocess, "run", _fake_run("", returncode=2)
    )
    with pytest.raises(RuntimeError):
        rickgent_policies._assert_build_commit()


def test_assert_build_commit_ok_on_match(monkeypatch):
    """VAL-ATTACH-022 (negative): matching commits do not raise."""
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "same-commit")
    monkeypatch.setattr(
        rickgent_policies.subprocess, "run", _fake_run("same-commit\n")
    )
    rickgent_policies._assert_build_commit()  # must not raise


def test_assert_build_commit_tolerates_missing_cli(monkeypatch):
    """VAL-ATTACH-022: a not-yet-installed rickgent CLI does not crash import.

    The build-commit guard cannot verify parity if the TS CLI is absent; that
    is tolerated (the downstream `_rickgent_verdict` fails closed to DENY on a
    missing binary). Only a *mismatch* fails closed here.
    """

    def boom(*args, **kwargs):
        raise FileNotFoundError("rickgent")

    monkeypatch.setattr(rickgent_policies.subprocess, "run", boom)
    rickgent_policies._assert_build_commit()  # must not raise


# ── VAL-ATTACH-021: guard runs before the first verdict-dependent call ───────

_VERDICT_POLICY_CASES = [
    (
        "completion_evidence",
        completion_evidence,
        {"tool_name": "rickgent_phase_advance"},
        {
            "claimed_sha": "abc",
            "baseline_sha": "def",
            "sha_exists": True,
            "tree_changed": True,
            "gate_green": True,
        },
        {"verdict": "COMMITTED"},
    ),
    (
        "convergence_gate",
        convergence_gate,
        {"tool_name": "rickgent_build_gate"},
        {"phase": "build", "gate_input": {"phase": "build"}},
        {"passed": True},
    ),
    (
        "subtract_before_add",
        subtract_before_add,
        {"tool_name": "rickgent_prd_validate"},
        {"prd": {"title": "x"}},
        {"valid": True},
    ),
]


@pytest.mark.parametrize(
    "name,policy,event,config,verdict",
    _VERDICT_POLICY_CASES,
    ids=[c[0] for c in _VERDICT_POLICY_CASES],
)
def test_build_commit_asserted_before_first_verdict(
    name, policy, event, config, verdict, monkeypatch
):
    """VAL-ATTACH-021: `_assert_build_commit` fires strictly before `_rickgent_verdict`.

    Instruments both functions with a shared call log and drives the real
    policy entrypoint; the build-commit parity guard must be logged before the
    verdict-CLI call for every verdict-dependent policy.
    """
    calls = []

    monkeypatch.setattr(
        rickgent_policies, "_assert_build_commit", lambda: calls.append("assert")
    )

    def logged_verdict(check, data):
        calls.append("verdict")
        return verdict

    monkeypatch.setattr(rickgent_policies, "_rickgent_verdict", logged_verdict)

    policy(event, config)

    assert "assert" in calls, f"{name}: build-commit guard never ran"
    assert "verdict" in calls, f"{name}: verdict CLI never ran"
    assert calls.index("assert") < calls.index("verdict"), (
        f"{name}: build-commit guard ran AFTER the verdict call: {calls}"
    )


@pytest.mark.parametrize(
    "name,policy,event,config,verdict",
    _VERDICT_POLICY_CASES,
    ids=[c[0] for c in _VERDICT_POLICY_CASES],
)
def test_verdict_policy_fails_closed_on_build_mismatch(
    name, policy, event, config, verdict, monkeypatch
):
    """VAL-ATTACH-021/022: a build-commit mismatch DENYs at the policy entrypoint.

    Verifies behavior: the verdict itself WOULD pass (mocked), so the DENY can
    only come from the wired build-parity guard failing closed. convergence_gate
    is exercised on its blocking build gate so a DENY is observable.
    """
    monkeypatch.setattr(rickgent_policies, "_rickgent_verdict", lambda c, d: verdict)
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "py-aaaaaaaaaaaa")
    monkeypatch.setattr(
        rickgent_policies.subprocess, "run", _fake_run("ts-bbbbbbbbbbbb\n")
    )

    result = policy(event, config)

    assert result is not None and result.get("result") == "DENY", (
        f"{name}: build-commit mismatch did not fail closed: {result!r}"
    )


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
