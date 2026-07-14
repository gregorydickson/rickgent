"""Build-commit binary source consistency (misc-hardening).

`_detect_build_commit()` and the TS↔Python parity check (`_assert_build_commit`)
must resolve the rickgent binary via the SAME source — `_RICKGENT_BIN` (honoring
the `RICKGENT_BIN` env override). The old code hard-coded the literal
`"rickgent"` in `_detect_build_commit()` while `_assert_build_commit()` used
`_RICKGENT_BIN`. Under a `RICKGENT_BIN` override these can disagree and cause a
false build-commit-mismatch DENY across completion_evidence / convergence_gate /
subtract_before_add.

These tests are written RED-FIRST: they fail against the old inconsistent code
and pass after both paths use `_RICKGENT_BIN`.
"""

import types

import pytest

import rickgent_policies


# ── _detect_build_commit must use _RICKGENT_BIN, not literal "rickgent" ──────


def test_detect_build_commit_uses_rickgent_bin(monkeypatch):
    """_detect_build_commit resolves the binary via _RICKGENT_BIN.

    Under a RICKGENT_BIN override, auto-detect must call the override binary,
    not the literal `rickgent`. The old code hard-coded `"rickgent"`.
    """
    fake_bin = "/usr/local/bin/rickgent-fake"
    monkeypatch.setattr(rickgent_policies, "_RICKGENT_BIN", fake_bin)
    monkeypatch.setattr(rickgent_policies, "_BUILD_COMMIT_OVERRIDE", None)
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "dev")

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        if cmd[0] == fake_bin:
            return types.SimpleNamespace(
                returncode=0, stdout="override-commit\n", stderr=""
            )
        # literal "rickgent" — the OLD (buggy) path
        return types.SimpleNamespace(
            returncode=0, stdout="literal-commit\n", stderr=""
        )

    monkeypatch.setattr(rickgent_policies.subprocess, "run", fake_run)

    detected = rickgent_policies._detect_build_commit()

    assert any(c[0] == fake_bin for c in calls), (
        f"_detect_build_commit did not call _RICKGENT_BIN: calls={calls}"
    )
    assert detected == "override-commit", (
        f"_detect_build_commit returned {detected!r}, expected 'override-commit' "
        f"(the _RICKGENT_BIN override output)"
    )


# ── No false mismatch DENY under RICKGENT_BIN override ───────────────────────


def test_no_false_mismatch_under_rickgent_bin_override(monkeypatch):
    """RICKGENT_BIN override no longer produces a false build-commit-mismatch.

    Both _detect_build_commit() and _assert_build_commit() resolve the binary
    via _RICKGENT_BIN, so they query the same binary and agree. The old code
    queried different binaries (literal `rickgent` vs `_RICKGENT_BIN`) and could
    disagree, raising a false RuntimeError (DENY).
    """
    fake_bin = "/usr/local/bin/rickgent-fake"
    monkeypatch.setattr(rickgent_policies, "_RICKGENT_BIN", fake_bin)
    monkeypatch.setattr(rickgent_policies, "_BUILD_COMMIT_OVERRIDE", None)
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "dev")

    def fake_run(cmd, **kwargs):
        if cmd[0] == fake_bin:
            return types.SimpleNamespace(
                returncode=0, stdout="same-commit\n", stderr=""
            )
        # literal "rickgent" would return a DIFFERENT commit
        return types.SimpleNamespace(
            returncode=0, stdout="different-commit\n", stderr=""
        )

    monkeypatch.setattr(rickgent_policies.subprocess, "run", fake_run)

    # Auto-detect sets BUILD_COMMIT from the (override) binary
    rickgent_policies._detect_build_commit()

    # Parity check must NOT raise — both used the same binary
    rickgent_policies._assert_build_commit()


def test_false_mismatch_deny_reproduces_against_old_code(monkeypatch):
    """Demonstrates the OLD bug: literal `rickgent` vs `_RICKGENT_BIN` disagree.

    This test forces the auto-detect to use the literal path (simulating the old
    hard-coded `"rickgent"`) and shows the parity check then raises. After the
    fix, _detect_build_commit uses _RICKGENT_BIN and this scenario cannot arise.
    We assert the FIXED behavior: no raise.
    """
    fake_bin = "/usr/local/bin/rickgent-fake"
    monkeypatch.setattr(rickgent_policies, "_RICKGENT_BIN", fake_bin)
    monkeypatch.setattr(rickgent_policies, "_BUILD_COMMIT_OVERRIDE", None)
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "dev")

    def fake_run(cmd, **kwargs):
        # Both calls should go to fake_bin after the fix
        if cmd[0] == fake_bin:
            return types.SimpleNamespace(
                returncode=0, stdout="commit-xyz\n", stderr=""
            )
        return types.SimpleNamespace(
            returncode=0, stdout="commit-abc\n", stderr=""
        )

    monkeypatch.setattr(rickgent_policies.subprocess, "run", fake_run)

    rickgent_policies._detect_build_commit()
    # After fix: BUILD_COMMIT == "commit-xyz", assert queries fake_bin → "commit-xyz"
    assert rickgent_policies.BUILD_COMMIT == "commit-xyz", (
        f"BUILD_COMMIT={rickgent_policies.BUILD_COMMIT!r}, expected 'commit-xyz'"
    )
    rickgent_policies._assert_build_commit()  # must not raise


# ── RICKGENT_BUILD_COMMIT override still takes precedence ────────────────────


def test_build_commit_override_skips_detection(monkeypatch):
    """RICKGENT_BUILD_COMMIT still takes precedence over auto-detect.

    When _BUILD_COMMIT_OVERRIDE is set, _detect_build_commit returns it without
    shelling out. _assert_build_commit still queries _RICKGENT_BIN for the TS
    side and compares against the override.
    """
    monkeypatch.setattr(
        rickgent_policies, "_BUILD_COMMIT_OVERRIDE", "pinned-commit"
    )
    monkeypatch.setattr(rickgent_policies, "BUILD_COMMIT", "pinned-commit")
    monkeypatch.setattr(
        rickgent_policies, "_RICKGENT_BIN", "/usr/local/bin/rickgent-fake"
    )

    called = []

    def fake_run(cmd, **kwargs):
        called.append(list(cmd))
        return types.SimpleNamespace(
            returncode=0, stdout="pinned-commit\n", stderr=""
        )

    monkeypatch.setattr(rickgent_policies.subprocess, "run", fake_run)

    detected = rickgent_policies._detect_build_commit()
    assert detected == "pinned-commit"
    assert called == [], "_detect_build_commit shelled out despite override"

    # Parity check still queries the TS binary
    rickgent_policies._assert_build_commit()
    assert len(called) == 1, f"expected one parity call, got {called}"
