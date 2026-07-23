"""Canonical terminal-completion evidence policy."""

from __future__ import annotations

import os
import re
import subprocess

from .native import adapt_authenticated, denial_result, fail_closed
from .policy_event import PolicyAbstention, PolicyDenial

COMPLETION_DENIAL_CODE = "RICKGENT_COMPLETION_DENIED"
_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$")


def _deny(detail: str) -> dict[str, str]:
    return {
        "result": "DENY",
        "reason": f"{COMPLETION_DENIAL_CODE}: {detail}",
        "code": COMPLETION_DENIAL_CODE,
    }


def _git(worktree: str, *arguments: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            ["git", "-C", worktree, *arguments],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return None


def completion_evidence(event: object, config: object):
    """Deny every unreceipted done claim after authenticating its attempt."""

    try:
        outcome = adapt_authenticated(event, config)
        if isinstance(outcome, PolicyDenial):
            return denial_result(outcome)
        if isinstance(outcome, PolicyAbstention) or outcome.action != "mark_done":
            return None
        if outcome.native_phase != "tool_call":
            return None
        if set(outcome.arguments) != {"claimed_sha", "evidence"}:
            return _deny("completion claim must contain only claimed_sha and evidence")
        claimed_sha = outcome.arguments.get("claimed_sha")
        evidence = outcome.arguments.get("evidence")
        if not isinstance(claimed_sha, str) or _COMMIT_RE.fullmatch(claimed_sha) is None:
            return _deny("completion claim is missing a canonical commit SHA")
        if (
            not isinstance(evidence, tuple)
            or not evidence
            or any(not isinstance(item, str) or not item.strip() for item in evidence)
        ):
            return _deny("completion claim is missing non-empty evidence references")

        head = _git(outcome.worktree_realpath, "rev-parse", "HEAD^{commit}")
        claimed = _git(outcome.worktree_realpath, "rev-parse", f"{claimed_sha}^{{commit}}")
        if (
            head is None
            or claimed is None
            or head.returncode != 0
            or claimed.returncode != 0
            or head.stdout.strip() != claimed.stdout.strip()
        ):
            return _deny("claimed commit is not the authenticated worktree HEAD")

        receipt_path = os.path.join(outcome.policy_root_realpath, "receipt.jsonl")
        try:
            receipt_size = os.stat(receipt_path, follow_symlinks=False).st_size
        except OSError:
            return _deny("protected completion receipt is unavailable")
        if receipt_size == 0:
            return _deny("protected completion receipt is empty")
        # M2 has no protected completion-receipt producer or effective
        # implementer/reviewer identity observation.  Event-supplied evidence
        # can therefore never establish terminal completion by itself.
        return _deny("protected completion receipt identity is not yet verifiable")
    except Exception:
        return fail_closed(COMPLETION_DENIAL_CODE, "completion policy")


__all__ = ["COMPLETION_DENIAL_CODE", "completion_evidence"]
