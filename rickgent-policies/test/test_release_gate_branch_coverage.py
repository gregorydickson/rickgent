"""Release-gate coverage for fail-closed policy boundary branches."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import rickgent_policies.attachment as attachment
import rickgent_policies.completion as completion
import rickgent_policies.convergence as convergence
import rickgent_policies.delivery as delivery
import rickgent_policies.policy_event as policy_event
import rickgent_policies.review as review
import rickgent_policies.routing as routing
import rickgent_policies.scope as scope
import rickgent_policies.simplification as simplification
import rickgent_policies.verdict as verdict
from rickgent_policies.policy_event import (
    DenialKind,
    PolicyAbstention,
    TicketScopeEntry,
    make_policy_denial,
)
from rickgent_policies.scope import ScopeOperation, check_scope_resolved


def _abstention() -> PolicyAbstention:
    return PolicyAbstention("request", "dispatch", "a" * 64)


def _denial():
    return make_policy_denial(DenialKind.EVENT_MALFORMED, "bad event")


def test_attachment_config_contract_rejects_implicit_or_drifting_values():
    with pytest.raises(ValueError, match="exactly seven"):
        attachment._expected_config(None)
    config = {key: "value" for key in policy_event.REQUIRED_CONFIG_KEYS}
    config["dispatch_id"] = ""
    with pytest.raises(ValueError, match="non-empty"):
        attachment._expected_config(config)
    config["dispatch_id"] = "dispatch"
    config["rickgent_policy_abi"] = "wrong"
    with pytest.raises(ValueError, match="unsupported ABI"):
        attachment._expected_config(config)
    config["rickgent_policy_abi"] = policy_event.POLICY_ABI_VERSION
    assert attachment._expected_config(config) == config
    assert attachment._arguments_equal(None, None)
    assert attachment._arguments_equal({"a": 1}, {"a": 1})


def test_router_converts_malformed_roster_rows_to_a_typed_denial():
    result = routing.select_model([1], "implement")
    assert result["result"] == "DENY"
    assert result["code"] == "ROUTING_ERROR"


@pytest.mark.parametrize(
    ("module", "entrypoint"),
    [
        (convergence, convergence.convergence_gate),
        (simplification, simplification.subtract_before_add),
        (completion, completion.completion_evidence),
        (review, review.cross_vendor_review),
    ],
)
def test_policy_entrypoints_preserve_denial_and_abstention(
    monkeypatch: pytest.MonkeyPatch,
    module,
    entrypoint,
):
    monkeypatch.setattr(module, "adapt_authenticated", lambda *_: _denial())
    denied = entrypoint({}, {})
    assert denied["code"] == "RICKGENT_POLICY_EVENT_MALFORMED"

    monkeypatch.setattr(module, "adapt_authenticated", lambda *_: _abstention())
    assert entrypoint({}, {}) is None

    monkeypatch.setattr(module, "adapt_authenticated", lambda *_: 1 / 0)
    assert entrypoint({}, {})["result"] == "DENY"


def test_convergence_gate_covers_closed_gate_shapes(monkeypatch: pytest.MonkeyPatch):
    def run(outcome, gate_result=None):
        monkeypatch.setattr(convergence, "adapt_authenticated", lambda *_: outcome)
        if gate_result is not None:
            monkeypatch.setattr(convergence, "_verified_verdict", lambda *_: gate_result)
        return convergence.convergence_gate({}, {})

    assert run(SimpleNamespace(action="phase_advance")) is None
    assert run(SimpleNamespace(action="other")) is None
    assert run(SimpleNamespace(action="build_gate", native_phase="request")) is None
    malformed = SimpleNamespace(
        action="build_gate", native_phase="tool_call", arguments={"wrong": {}}
    )
    assert run(malformed)["result"] == "DENY"
    malformed.arguments = {"gate": "not-a-map"}
    assert run(malformed)["result"] == "DENY"

    gate = SimpleNamespace(
        action="build_gate",
        native_phase="tool_call",
        arguments={"gate": {"baseline": (), "current": ()}},
        declared_scope=(SimpleNamespace(path="src"),),
    )
    assert run(gate, {"error": True, "code": "BROKEN"})["result"] == "DENY"
    assert run(gate, {"passed": False, "failures": ["tests"]})["result"] == "DENY"
    assert run(gate, {"passed": True}) == {"result": "ALLOW"}


def test_simplification_covers_closed_prd_shapes(monkeypatch: pytest.MonkeyPatch):
    def run(outcome, result=None):
        monkeypatch.setattr(simplification, "adapt_authenticated", lambda *_: outcome)
        if result is not None:
            monkeypatch.setattr(simplification, "_verified_verdict", lambda *_: result)
        return simplification.subtract_before_add({}, {})

    assert run(SimpleNamespace(action="other")) is None
    assert run(SimpleNamespace(action="prd_validate", native_phase="request")) is None
    malformed = SimpleNamespace(
        action="prd_validate", native_phase="tool_call", arguments={"wrong": {}}
    )
    assert run(malformed)["result"] == "DENY"
    malformed.arguments = {"prd": "not-a-map"}
    assert run(malformed)["result"] == "DENY"

    prd = SimpleNamespace(
        action="prd_validate",
        native_phase="tool_call",
        arguments={"prd": {"acceptanceCriteria": ()}},
    )
    assert run(prd, {"error": True, "code": "BROKEN"})["result"] == "DENY"
    assert run(prd, {"valid": False, "errors": ["missing review"]})["result"] == "DENY"
    assert run(prd, {"valid": True}) == {"result": "ALLOW"}


def test_completion_rejects_every_unproved_terminal_shape(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    policy_root = tmp_path / "policy"
    policy_root.mkdir()
    base = SimpleNamespace(
        action="mark_done",
        native_phase="tool_call",
        arguments={},
        worktree_realpath=str(tmp_path),
        policy_root_realpath=str(policy_root),
    )
    monkeypatch.setattr(completion, "adapt_authenticated", lambda *_: base)

    assert completion.completion_evidence({}, {})["result"] == "DENY"
    base.arguments = {"claimed_sha": "bad", "evidence": ("report",)}
    assert completion.completion_evidence({}, {})["result"] == "DENY"
    base.arguments = {"claimed_sha": "a" * 40, "evidence": ()}
    assert completion.completion_evidence({}, {})["result"] == "DENY"

    good_git = subprocess.CompletedProcess([], 0, stdout="a" * 40 + "\n", stderr="")
    monkeypatch.setattr(completion, "_git", lambda *_: good_git)
    base.arguments = {"claimed_sha": "a" * 40, "evidence": ("report",)}
    assert completion.completion_evidence({}, {})["result"] == "DENY"

    receipt = policy_root / "receipt.jsonl"
    receipt.write_text("")
    assert completion.completion_evidence({}, {})["result"] == "DENY"
    receipt.write_text("{}\n")
    assert "not yet verifiable" in completion.completion_evidence({}, {})["reason"]

    monkeypatch.setattr(completion, "_git", lambda *_: None)
    assert completion.completion_evidence({}, {})["result"] == "DENY"


def test_review_phase_filters_and_distinction_shapes(monkeypatch: pytest.MonkeyPatch):
    outcome = SimpleNamespace(
        action="phase_advance",
        native_phase="request",
        lifecycle_phase="code_review",
    )
    monkeypatch.setattr(review, "adapt_authenticated", lambda *_: outcome)
    assert review.cross_vendor_review({}, {}) is None
    outcome.native_phase = "tool_call"
    outcome.lifecycle_phase = "implement"
    assert review.cross_vendor_review({}, {}) is None

    assert review._check_distinction_genuine(None) is False
    assert review._check_distinction_genuine({"context": {"cross_vendor_distinction": []}}) is False
    assert review._check_distinction_genuine(
        {
            "arguments": {
                "cross_vendor_distinction": {
                    "outcome": "permitted",
                    "genuine_distinction": True,
                }
            }
        }
    )


def test_legacy_scope_adapter_covers_create_modify_rename_and_denial(tmp_path: Path):
    root = str(tmp_path.resolve())
    owned = tmp_path / "owned"
    owned.mkdir()
    existing = owned / "existing.txt"
    existing.write_text("old")

    assert check_scope_resolved(root, ["owned"], "ignored", False) == {"result": "ALLOW"}
    assert check_scope_resolved(root, ["owned"], "ignored", "yes")["result"] == "DENY"
    assert check_scope_resolved(root, "owned", "owned/new.txt", True)["result"] == "DENY"
    assert check_scope_resolved(root, ["owned"], "owned/new.txt", True)["result"] == "ALLOW"
    assert check_scope_resolved(root, ["owned"], "owned/existing.txt", True)["result"] == "ALLOW"
    assert check_scope_resolved(root, ["owned"], "outside.txt", True)["result"] == "DENY"
    assert (
        check_scope_resolved(
            root,
            ["owned"],
            "owned/existing.txt",
            True,
            "owned/renamed.txt",
        )["result"]
        == "ALLOW"
    )


@pytest.mark.parametrize(
    "candidate",
    [
        None,
        {"current": [], "baseline": [], "scope": "src", "findings": []},
        {"current": "bad", "baseline": [], "scope": [], "findings": []},
        {
            "current": [{"name": "tests"}],
            "baseline": [],
            "scope": [],
            "findings": [],
        },
        {
            "current": [{"name": 1, "passed": True, "output": ""}],
            "baseline": [],
            "scope": [],
            "findings": [],
        },
        {"current": [], "baseline": [], "scope": [], "findings": "bad"},
        {
            "current": [],
            "baseline": [],
            "scope": [],
            "findings": [{"file": "a"}],
        },
        {
            "current": [],
            "baseline": [],
            "scope": [],
            "findings": [{"file": "a", "line": "1", "message": "m", "check": "c"}],
        },
    ],
)
def test_closed_gate_rejects_noncanonical_nested_shapes(candidate):
    assert policy_event._closed_gate(candidate) is False


@pytest.mark.parametrize(
    "candidate",
    [
        None,
        {
            "title": 1,
            "description": "d",
            "acceptanceCriteria": [],
            "simplificationReview": None,
        },
        {
            "title": "t",
            "description": "d",
            "acceptanceCriteria": "bad",
            "simplificationReview": None,
        },
        {
            "title": "t",
            "description": "d",
            "acceptanceCriteria": [{"description": "only"}],
            "simplificationReview": None,
        },
        {
            "title": "t",
            "description": "d",
            "acceptanceCriteria": [
                {
                    "description": "d",
                    "type": "behavioral",
                    "verifyCommand": "test",
                    "scope": [1],
                }
            ],
            "simplificationReview": None,
        },
        {
            "title": "t",
            "description": "d",
            "acceptanceCriteria": [],
            "simplificationReview": {"reviewed": "yes", "notes": ""},
        },
    ],
)
def test_closed_prd_rejects_noncanonical_nested_shapes(candidate):
    assert policy_event._closed_prd(candidate) is False


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("sys_os_read", {}),
        ("sys_os_read", {"path": "a", "offset": True}),
        ("sys_os_edit", {"path": ""}),
        ("sys_os_edit", {"path": "a", "edits": []}),
        ("sys_os_edit", {"path": "a", "edits": [{"oldText": 1, "newText": ""}]}),
        ("sys_os_shell", {"command": " "}),
        ("rickgent_phase_advance", {"next_phase": ""}),
        ("rickgent_build_gate", {"gate": {}}),
        ("rickgent_prd_validate", {"prd": {}}),
    ],
)
def test_tool_argument_contract_rejects_ambiguous_values(tool, arguments):
    assert policy_event._arguments_match_tool(tool, arguments) is False


def test_scope_engine_rejects_malformed_and_conflicting_operations(tmp_path: Path):
    root_path = tmp_path.resolve()
    root = str(root_path)
    (root_path / "file.txt").write_text("x")
    (root_path / "directory").mkdir()

    def decide(declared, operation, **overrides):
        return scope.evaluate_scope(
            worktree_root=overrides.get("worktree_root", root),
            authorized_root=overrides.get("authorized_root", root),
            reserved_roots=overrides.get("reserved_roots", ()),
            declared_scope=declared,
            operation=operation,
        )

    assert decide([], ScopeOperation("read", False, path="file.txt")).result == "DENY"
    assert decide((), "bad").result == "DENY"
    declared = (TicketScopeEntry("file.txt", "modify", False),)
    assert decide(
        declared,
        ScopeOperation("modify", False, path="file.txt", source_path="extra"),
    ).result == "DENY"
    assert decide(declared, ScopeOperation("create", False, path="file.txt")).result == "DENY"
    assert decide(declared, ScopeOperation("delete", False, path="missing")).result == "DENY"
    assert decide(declared, ScopeOperation("modify", True, path="file.txt")).result == "DENY"
    assert decide(declared, ScopeOperation("read", False, path="missing")).result == "DENY"
    assert decide(declared, ScopeOperation("unsupported", False)).result == "DENY"
    assert decide(
        declared,
        ScopeOperation("rename", False, path="file.txt"),
    ).result == "DENY"

    create = (TicketScopeEntry("new.txt", "create", False),)
    assert decide(
        create,
        ScopeOperation(
            "link",
            False,
            source_path="missing",
            destination_path="new.txt",
        ),
    ).result == "DENY"
    assert decide(
        create,
        ScopeOperation(
            "link",
            False,
            source_path="file.txt",
            destination_path="file.txt",
        ),
    ).result == "DENY"
    assert decide(
        (),
        ScopeOperation(
            "link",
            False,
            source_path="file.txt",
            destination_path="new.txt",
        ),
    ).result == "DENY"


def test_verdict_binding_and_subprocess_fail_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    artifact = tmp_path / "artifact"
    artifact.write_bytes(b"artifact")
    canonical = str(artifact.resolve())
    digest = verdict.hashlib.sha256(b"artifact").hexdigest()

    assert verdict._stable_artifact_sha256(canonical, "test") == digest
    assert verdict._stable_artifact_sha256(canonical, "test") == digest
    with pytest.raises(RuntimeError, match="missing or malformed"):
        verdict._stable_artifact_sha256("relative", "test")
    with pytest.raises(RuntimeError, match="regular file"):
        verdict._stable_artifact_sha256(str(tmp_path.resolve()), "test")

    monkeypatch.setattr(
        verdict,
        "_binding",
        lambda: (canonical, digest, canonical, digest, "build-1"),
    )
    assert verdict._assert_runtime_artifacts() == (canonical, canonical)
    assert verdict._assert_cli_artifact() == canonical
    assert verdict._build_commit() == "build-1"

    monkeypatch.setattr(verdict, "_binding", lambda: ("", "", "", "", " bad "))
    with pytest.raises(RuntimeError, match="build commit"):
        verdict._build_commit()

    monkeypatch.setattr(
        verdict,
        "_binding",
        lambda: (canonical, digest, canonical, digest, "build-1"),
    )
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 0, "build-1\n", ""),
    )
    verdict._assert_build_commit()
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 1, "", "bad"),
    )
    with pytest.raises(RuntimeError, match="exited"):
        verdict._assert_build_commit()

    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 0, json.dumps({"ok": True}), ""),
    )
    assert verdict._rickgent_verdict("gate", {}) == {"ok": True}
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 0, "[]", ""),
    )
    assert verdict._rickgent_verdict("gate", {})["error"] is True
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 0, "{", ""),
    )
    assert verdict._rickgent_verdict("gate", {})["error"] is True
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 2, "", ""),
    )
    assert verdict._rickgent_verdict("gate", {})["message"] == "rickgent verdict exited 2"
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: (_ for _ in ()).throw(RuntimeError("unexpected")),
    )
    assert verdict._rickgent_verdict("gate", {})["message"] == "unexpected"

    for binding, message in [
        (("", "bad", canonical, digest, "build-1"), "Node digest"),
        ((canonical, "0" * 64, canonical, digest, "build-1"), "Node digest mismatch"),
        ((canonical, digest, "", "bad", "build-1"), "CLI digest"),
        ((canonical, digest, canonical, "0" * 64, "build-1"), "CLI digest mismatch"),
    ]:
        monkeypatch.setattr(verdict, "_binding", lambda binding=binding: binding)
        with pytest.raises(RuntimeError, match=message):
            verdict._assert_runtime_artifacts()

    monkeypatch.setattr(
        verdict,
        "_binding",
        lambda: (canonical, digest, canonical, digest, "build-1"),
    )
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 0, "other-build\n", ""),
    )
    with pytest.raises(RuntimeError, match="mismatch"):
        verdict._assert_build_commit()
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: (_ for _ in ()).throw(subprocess.TimeoutExpired("node", 1)),
    )
    with pytest.raises(RuntimeError, match="check failed"):
        verdict._assert_build_commit()
    assert verdict._rickgent_verdict("gate", {})["message"] == "rickgent verdict timed out"
    monkeypatch.setattr(
        verdict.subprocess,
        "run",
        lambda *_, **__: (_ for _ in ()).throw(FileNotFoundError()),
    )
    assert verdict._rickgent_verdict("gate", {})["message"] == "pinned rickgent CLI unavailable"


def test_delivery_classifier_and_state_machine_fail_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    assert delivery.classify_delivery_command(None).kind == "invalid"
    assert delivery.classify_delivery_command("'").kind == "invalid"
    assert delivery.classify_delivery_command("git push origin a && echo no").kind == "invalid"
    assert delivery.classify_delivery_command("git -C /tmp push origin topic").safe_prefix is False
    assert delivery.classify_delivery_command("git push --force origin topic").destructive
    assert delivery.classify_delivery_command("git push origin release/1").protected
    assert delivery.classify_delivery_command("gh pr create --fill").kind == "invalid"
    assert delivery.classify_delivery_command("echo ok").kind == "other"
    assert delivery.is_delivery_command("gh pr create")
    assert delivery._is_protected(None) is False
    assert delivery._git_subcommand(("git", "--verbose")) is None
    assert delivery._git_subcommand(("git", "--config=x", "push")) == 2

    monkeypatch.setattr(
        delivery.subprocess,
        "run",
        lambda *_, **__: (_ for _ in ()).throw(OSError()),
    )
    assert delivery._owned_branch(str(tmp_path)) is None
    monkeypatch.setattr(
        delivery.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess([], 1, "", ""),
    )
    assert delivery._owned_branch(str(tmp_path)) is None
    monkeypatch.setattr(
        delivery.subprocess,
        "run",
        lambda *_, **__: subprocess.CompletedProcess(
            [], 0, "refs/heads/rickgent/runs/owned\n", ""
        ),
    )
    assert delivery._owned_branch(str(tmp_path)) == (
        "refs/heads/rickgent/runs/owned",
        "rickgent/runs/owned",
    )

    evaluate = delivery.autonomous_pr_flow()
    monkeypatch.setattr(delivery, "adapt_authenticated", lambda *_: _denial())
    assert evaluate({}, {})["code"] == "RICKGENT_POLICY_EVENT_MALFORMED"

    outcome = SimpleNamespace(kind="shell", arguments={"command": "gh pr create"})
    monkeypatch.setattr(delivery, "adapt_authenticated", lambda *_: outcome)
    monkeypatch.setattr(delivery, "_owned_branch", lambda *_: None)
    assert evaluate({}, {})["result"] == "DENY"

    branch = "rickgent/runs/run-1"
    monkeypatch.setattr(
        delivery,
        "_owned_branch",
        lambda *_: ("refs/heads/" + branch, branch),
    )
    outcome.worktree_realpath = str(tmp_path)
    outcome.arguments = {"command": f"git push origin {branch}"}
    outcome.native_phase = "tool_result"
    assert evaluate({}, {})["result"] == "DENY"
    outcome.native_phase = "tool_call"
    assert evaluate({}, {}) == {"result": "ALLOW"}
    outcome.native_phase = "tool_result"
    outcome.shell_result = SimpleNamespace(
        exit_code=0, timed_out=False, cwd=str(tmp_path)
    )
    assert evaluate({}, {}) == {"result": "ALLOW"}
    outcome.native_phase = "tool_call"
    assert evaluate({}, {}) == {"result": "ALLOW"}
    outcome.native_phase = "tool_result"
    outcome.shell_result = SimpleNamespace(
        exit_code=1, timed_out=False, cwd=str(tmp_path)
    )
    assert evaluate({}, {})["result"] == "DENY"
    outcome.native_phase = "tool_call"
    assert evaluate({}, {}) == {"result": "ALLOW"}
    outcome.native_phase = "tool_result"
    outcome.shell_result = SimpleNamespace(
        exit_code=0, timed_out=False, cwd=str(tmp_path)
    )
    assert evaluate({}, {}) == {"result": "ALLOW"}
    outcome.arguments = {"command": "gh pr create"}
    outcome.native_phase = "tool_call"
    assert evaluate({}, {}) == {"result": "ALLOW"}

    outcome.arguments = {"command": "echo ok"}
    assert evaluate({}, {}) is None
    outcome.arguments = {"command": "echo ok && git push"}
    assert evaluate({}, {})["result"] == "DENY"
    outcome.arguments = {"command": f"git push --force origin {branch}"}
    assert evaluate({}, {})["result"] == "DENY"
    outcome.arguments = {"command": "git push origin main"}
    assert evaluate({}, {})["result"] == "DENY"
    outcome.arguments = {"command": "git push origin another"}
    assert evaluate({}, {})["result"] == "DENY"
    outcome.arguments = {"command": "gh pr create"}
    outcome.native_phase = "tool_result"
    assert evaluate({}, {})["result"] == "DENY"

    monkeypatch.setattr(delivery, "adapt_authenticated", lambda *_: 1 / 0)
    assert evaluate({}, {})["result"] == "DENY"
