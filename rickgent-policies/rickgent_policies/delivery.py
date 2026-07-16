"""Canonical, stateful autonomous push-then-PR policy."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import dataclass
from typing import Literal

from .native import adapt_authenticated, denial_result, fail_closed
from .policy_event import CanonicalPolicyEvent, PolicyAbstention, PolicyDenial


AUTONOMOUS_PR_DENIAL_CODE = "RICKGENT_AUTONOMOUS_PR_DENIED"
_PROTECTED_EXACT = frozenset({"main", "master", "trunk", "develop", "dev"})
_GIT_VALUE_OPTIONS = frozenset(
    {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path"}
)
_SUDO_VALUE_OPTIONS = frozenset(
    {
        "-u", "-g", "-h", "-p", "-r", "-t", "-T", "-U", "-C", "-R", "-D", "-c",
        "--user", "--group", "--host", "--prompt", "--role", "--type",
        "--command-timeout", "--other-user", "--chdir", "--close-from",
    }
)
_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SHELL_SEPARATOR = re.compile(r"\|\||&&|[;\n|&]")


@dataclass(frozen=True)
class DeliveryCommand:
    kind: Literal["push", "pr", "other", "invalid"]
    command: str
    tokens: tuple[str, ...]
    safe_prefix: bool
    destructive: bool = False
    protected: bool = False
    destination: str | None = None


def _tokens(command: str) -> tuple[str, ...] | None:
    try:
        return tuple(shlex.split(command, posix=True))
    except ValueError:
        return None


def _semantic_tokens(tokens: tuple[str, ...]) -> tuple[tuple[str, ...], bool]:
    index = 0
    safe = True
    while index < len(tokens) and _ENV_ASSIGNMENT.match(tokens[index]):
        safe = False
        index += 1
    if index < len(tokens) and tokens[index] == "sudo":
        safe = False
        index += 1
        while index < len(tokens) and tokens[index].startswith("-"):
            option = tokens[index]
            index += 1
            if option in _SUDO_VALUE_OPTIONS and index < len(tokens):
                index += 1
    return tokens[index:], safe


def _git_subcommand(tokens: tuple[str, ...]) -> int | None:
    if not tokens or tokens[0] != "git":
        return None
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if not token.startswith("-"):
            return index
        if "=" in token:
            index += 1
        elif token in _GIT_VALUE_OPTIONS:
            index += 2
        else:
            index += 1
    return None


def _push_short_flag_destructive(token: str) -> bool:
    return token.startswith("-") and not token.startswith("--") and "f" in token[1:]


def _destination_candidates(tokens: tuple[str, ...], push_index: int) -> tuple[str, ...]:
    values: list[str] = []
    for token in tokens[push_index + 1 :]:
        if token.startswith("-"):
            continue
        candidate = token.lstrip("+")
        if candidate == "origin":
            continue
        if ":" in candidate:
            candidate = candidate.rsplit(":", 1)[1]
        candidate = candidate.removeprefix("refs/heads/").removeprefix("origin/")
        if candidate:
            values.append(candidate)
    return tuple(values)


def _is_protected(destination: str | None) -> bool:
    if not destination:
        return False
    normalized = destination.removeprefix("refs/heads/").removeprefix("origin/")
    return normalized in _PROTECTED_EXACT or normalized.startswith("release/")


def classify_delivery_command(command: object) -> DeliveryCommand:
    """Classify a single native shell command without granting an alias."""

    if not isinstance(command, str) or not command.strip():
        return DeliveryCommand("invalid", "", (), False)
    if _SHELL_SEPARATOR.search(command):
        return DeliveryCommand("invalid", command, (), False)
    parsed = _tokens(command)
    if not parsed:
        return DeliveryCommand("invalid", command, (), False)
    semantic, safe_prefix = _semantic_tokens(parsed)
    subcommand = _git_subcommand(semantic)
    if subcommand is not None and semantic[subcommand] == "push":
        trailing = semantic[subcommand + 1 :]
        destructive = any(
            token.startswith("--force")
            or token in {"--delete", "--mirror", "--all", "--tags", "--prune"}
            or _push_short_flag_destructive(token)
            or token.startswith("+")
            or token.startswith(":")
            for token in trailing
        )
        destinations = _destination_candidates(semantic, subcommand)
        destination = destinations[-1] if destinations else None
        return DeliveryCommand(
            "push",
            command,
            parsed,
            safe_prefix and subcommand == 1,
            destructive,
            any(_is_protected(value) for value in destinations),
            destination,
        )
    if parsed[:3] == ("gh", "pr", "create"):
        if parsed == ("gh", "pr", "create"):
            return DeliveryCommand("pr", command, parsed, True)
        return DeliveryCommand("invalid", command, parsed, True)
    return DeliveryCommand("other", command, parsed, safe_prefix)


def is_delivery_command(command: object) -> bool:
    return classify_delivery_command(command).kind in {"push", "pr"}


def _owned_branch(worktree: str) -> tuple[str, str] | None:
    try:
        result = subprocess.run(
            ["git", "-C", worktree, "symbolic-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return None
    ref = result.stdout.strip() if result.returncode == 0 else ""
    prefix = "refs/heads/rickgent/runs/"
    if not ref.startswith(prefix) or ref == prefix:
        return None
    return ref, ref.removeprefix("refs/heads/")


def _exact_owned_push(command: DeliveryCommand, branch: str) -> bool:
    return command.safe_prefix and command.tokens in {
        ("git", "push", "origin", branch),
        ("git", "push", "origin", f"HEAD:{branch}"),
    }


def _deny(detail: str) -> dict[str, str]:
    return {
        "result": "DENY",
        "reason": f"{AUTONOMOUS_PR_DENIAL_CODE}: {detail}",
        "code": AUTONOMOUS_PR_DENIAL_CODE,
    }


def autonomous_pr_flow():
    """Build one per-engine push-observation policy evaluator."""

    pending_pushes: set[tuple[str, str]] = set()
    observed_branch: str | None = None

    def evaluate(event: object, config: object):
        nonlocal observed_branch
        try:
            outcome = adapt_authenticated(event, config)
            if isinstance(outcome, PolicyDenial):
                return denial_result(outcome)
            if isinstance(outcome, PolicyAbstention) or outcome.kind != "shell":
                return None

            command = classify_delivery_command(outcome.arguments.get("command"))
            if command.kind == "other":
                return None
            if command.kind == "invalid":
                return _deny("shell delivery command is malformed or compound")

            owned = _owned_branch(outcome.worktree_realpath)
            if owned is None:
                return _deny("authenticated worktree is not on a Rickgent run branch")
            _ref, branch = owned

            if command.kind == "push":
                if command.destructive:
                    return _deny("force, delete, mirror, all, tags, or prune push is forbidden")
                if command.protected:
                    return _deny("push destination is protected")
                if not _exact_owned_push(command, branch):
                    return _deny("push is not the exact authenticated run-branch shape")
                key = (command.command, branch)
                if outcome.native_phase == "tool_call":
                    pending_pushes.add(key)
                    return {"result": "ALLOW"}
                if key not in pending_pushes:
                    return _deny("push result has no correlated authorized call")
                pending_pushes.discard(key)
                result = outcome.shell_result
                if (
                    result is None
                    or result.exit_code != 0
                    or result.timed_out
                    or os.path.realpath(result.cwd) != outcome.worktree_realpath
                ):
                    return _deny("push result did not prove successful execution in the authenticated worktree")
                observed_branch = branch
                return {"result": "ALLOW"}

            if outcome.native_phase != "tool_call":
                return _deny("PR result is not an authorization event")
            if observed_branch != branch:
                return _deny("PR creation requires a prior successful correlated push")
            return {"result": "ALLOW"}
        except Exception:
            return fail_closed(AUTONOMOUS_PR_DENIAL_CODE, "autonomous PR policy")

    return evaluate


__all__ = [
    "AUTONOMOUS_PR_DENIAL_CODE",
    "DeliveryCommand",
    "_is_protected",
    "autonomous_pr_flow",
    "classify_delivery_command",
    "is_delivery_command",
]
