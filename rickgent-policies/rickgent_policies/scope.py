"""Canonical Rickgent scope authority and native FunctionPolicy handler.

Only :class:`CanonicalPolicyEvent` values produced from an authenticated attempt
context reach the scope engine. Raw event/config aliases and shell command text
never grant authority.
"""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from typing import Literal

from .context import FilesystemContextAuthenticator
from .policy_event import (
    CanonicalPolicyEvent,
    PolicyAbstention,
    PolicyDenial,
    TicketScopeEntry,
    adapt_native_policy_event,
)


SCOPE_DENIAL_CODE = "RICKGENT_SCOPE_DENIED"
CANONICAL_FILESYSTEM_TOOLS = frozenset(
    {"sys_os_read", "sys_os_write", "sys_os_edit"}
)
RAW_SHELL_TOOLS = frozenset({"sys_os_shell", "Bash", "bash", "Shell", "shell"})

ScopeChangeKind = Literal["create", "modify", "delete", "rename"]
ScopeOperationKind = Literal["read", "create", "modify", "delete", "rename", "link"]
ScopeDisposition = Literal["ALLOW", "DENY", "ABSTAIN"]


@dataclass(frozen=True)
class ScopeOperation:
    kind: ScopeOperationKind
    directory: bool
    path: str | None = None
    source_path: str | None = None
    destination_path: str | None = None


@dataclass(frozen=True)
class ScopeDecision:
    result: ScopeDisposition
    change_kind: ScopeChangeKind | None = None
    reason: str | None = None
    code: str | None = None


@dataclass(frozen=True)
class _ProvenDeclaration:
    declaration: TicketScopeEntry
    path: str
    from_path: str | None


class _ScopeError(Exception):
    pass


def _deny(reason: str, change_kind: ScopeChangeKind | None = None) -> ScopeDecision:
    return ScopeDecision("DENY", change_kind, reason, SCOPE_DENIAL_CODE)


def _path_inside(root: str, candidate: str) -> bool:
    try:
        return os.path.commonpath((root, candidate)) == root
    except (TypeError, ValueError):
        return False


def _canonical_existing_directory(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
    ):
        raise _ScopeError(f"{label} is not a canonical absolute path")
    try:
        canonical = os.path.realpath(value, strict=True)
        info = os.stat(canonical)
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
        raise _ScopeError(f"{label} is unavailable") from None
    if canonical != value:
        raise _ScopeError(f"{label} is not canonical")
    if not stat.S_ISDIR(info.st_mode):
        raise _ScopeError(f"{label} is not a directory")
    return canonical


def _validate_relative_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        raise _ScopeError(f"{label} is empty or malformed")
    if (
        os.path.isabs(value)
        or re.match(r"^[A-Za-z]:[\\/]", value)
        or value.startswith("\\\\")
        or "\\" in value
    ):
        raise _ScopeError(f"{label} must be a portable root-relative path")
    components = value.split("/")
    if any(component in {"", ".", ".."} for component in components):
        raise _ScopeError(f"{label} is not a canonical relative path")
    return value


def _realpath_nearest_existing(path: str) -> str:
    current = os.path.abspath(path)
    tail: list[str] = []
    while True:
        try:
            canonical = os.path.realpath(current, strict=True)
            return os.path.abspath(os.path.join(canonical, *tail))
        except FileNotFoundError:
            # lexists distinguishes an absent component from a dangling link.
            if os.path.lexists(current):
                raise _ScopeError("path contains an unresolved symbolic link") from None
            parent, name = os.path.split(current)
            if parent == current or not name:
                raise _ScopeError("path has no resolvable parent") from None
            tail.insert(0, name)
            current = parent
        except (NotADirectoryError, PermissionError, OSError):
            raise _ScopeError("path cannot be resolved safely") from None


def _lexical_git_path(path: str) -> bool:
    return path.split("/", 1)[0] == ".git"


def _overlaps_reserved(
    path: str, directory: bool, reserved_roots: tuple[str, ...]
) -> bool:
    return any(
        _path_inside(reserved, path)
        or (directory and _path_inside(path, reserved))
        for reserved in reserved_roots
    )


def _prove_endpoint(
    raw_path: str,
    label: str,
    *,
    worktree_root: str,
    authorized_root: str,
    reserved_roots: tuple[str, ...],
    directory: bool,
) -> str:
    relative_path = _validate_relative_path(raw_path, label)
    if _lexical_git_path(relative_path):
        raise _ScopeError(f"{label} enters .git")
    canonical = _realpath_nearest_existing(
        os.path.join(authorized_root, relative_path)
    )
    if not _path_inside(worktree_root, canonical) or not _path_inside(
        authorized_root, canonical
    ):
        raise _ScopeError(f"{label} resolves outside authorized scope")
    if _overlaps_reserved(canonical, directory, reserved_roots):
        raise _ScopeError(f"{label} overlaps a reserved root")
    return canonical


def _endpoint_exists(path: str) -> bool:
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        raise _ScopeError("endpoint identity cannot be inspected") from None


def _declaration_contains(
    declaration: _ProvenDeclaration, endpoint: str, *, source: bool = False
) -> bool:
    declared = declaration.from_path if source else declaration.path
    if declared is None:
        return False
    if declaration.declaration.directory:
        return _path_inside(declared, endpoint)
    return declared == endpoint


def _validate_declaration(declaration: object) -> TicketScopeEntry:
    if not isinstance(declaration, TicketScopeEntry):
        raise _ScopeError("scope declaration is malformed")
    _validate_relative_path(declaration.path, "declared path")
    if declaration.change_kind not in {"create", "modify", "delete", "rename"}:
        raise _ScopeError("scope declaration change kind is malformed")
    if not isinstance(declaration.directory, bool):
        raise _ScopeError("scope declaration directory flag is malformed")
    if declaration.change_kind == "rename":
        _validate_relative_path(declaration.from_path, "declared rename source")
    elif declaration.from_path is not None:
        raise _ScopeError("non-rename declaration contains from_path")
    return declaration


def _operation_change_kind(operation: ScopeOperation) -> ScopeChangeKind | None:
    if operation.kind == "read":
        return None
    if operation.kind == "link":
        return "create"
    return operation.kind


def evaluate_scope(
    *,
    worktree_root: str,
    authorized_root: str,
    reserved_roots: tuple[str, ...],
    declared_scope: tuple[TicketScopeEntry, ...],
    operation: ScopeOperation,
) -> ScopeDecision:
    """Evaluate one closed structured filesystem request."""

    observed_kind: ScopeChangeKind | None = None
    try:
        canonical_worktree = _canonical_existing_directory(
            worktree_root, "worktree root"
        )
        canonical_authorized = _canonical_existing_directory(
            authorized_root, "authorized root"
        )
        if not _path_inside(canonical_worktree, canonical_authorized):
            return _deny("authorized root is outside the canonical worktree")
        if not isinstance(reserved_roots, tuple) or not isinstance(
            declared_scope, tuple
        ):
            return _deny("reserved roots or declarations are malformed")

        proven_reserved = tuple(
            _canonical_existing_directory(root, f"reserved root {index}")
            for index, root in enumerate(reserved_roots)
        )
        git_path = os.path.join(canonical_worktree, ".git")
        if os.path.lexists(git_path):
            try:
                proven_reserved += (os.path.realpath(git_path, strict=True),)
            except OSError:
                return _deny(".git identity cannot be proven")

        declarations: list[_ProvenDeclaration] = []
        for raw_declaration in declared_scope:
            declaration = _validate_declaration(raw_declaration)
            path = _prove_endpoint(
                declaration.path,
                "declared path",
                worktree_root=canonical_worktree,
                authorized_root=canonical_authorized,
                reserved_roots=proven_reserved,
                directory=declaration.directory,
            )
            from_path = None
            if declaration.change_kind == "rename":
                assert declaration.from_path is not None
                from_path = _prove_endpoint(
                    declaration.from_path,
                    "declared rename source",
                    worktree_root=canonical_worktree,
                    authorized_root=canonical_authorized,
                    reserved_roots=proven_reserved,
                    directory=declaration.directory,
                )
            declarations.append(_ProvenDeclaration(declaration, path, from_path))

        if not isinstance(operation, ScopeOperation) or not isinstance(
            operation.directory, bool
        ):
            return _deny("scope operation is malformed")
        observed_kind = _operation_change_kind(operation)

        if operation.kind in {"read", "create", "modify", "delete"}:
            if operation.source_path is not None or operation.destination_path is not None:
                return _deny("single-endpoint operation contains extra endpoints", observed_kind)
            endpoint_path = _validate_relative_path(
                operation.path, "operation endpoint"
            )
            endpoint = _prove_endpoint(
                endpoint_path,
                "operation endpoint",
                worktree_root=canonical_worktree,
                authorized_root=canonical_authorized,
                reserved_roots=proven_reserved,
                directory=operation.directory,
            )
            exists = _endpoint_exists(
                os.path.join(canonical_authorized, endpoint_path)
            )
            if operation.kind == "create" and exists:
                return _deny("create endpoint already exists", observed_kind)
            if operation.kind in {"read", "modify", "delete"} and not exists:
                return _deny(
                    f"{operation.kind} endpoint does not exist", observed_kind
                )
            if exists and stat.S_ISDIR(os.stat(endpoint).st_mode) != operation.directory:
                return _deny(
                    "operation endpoint type does not match its directory flag",
                    observed_kind,
                )
            owners = [
                declaration
                for declaration in declarations
                if _declaration_contains(declaration, endpoint)
            ]
            if operation.kind == "read":
                if owners:
                    return ScopeDecision("ALLOW")
                return ScopeDecision("ABSTAIN")
            if not any(
                owner.declaration.change_kind == operation.kind for owner in owners
            ):
                return _deny(
                    "operation path or change kind is outside declared scope",
                    observed_kind,
                )
            return ScopeDecision("ALLOW", observed_kind)

        if operation.kind not in {"rename", "link"}:
            return _deny("scope operation kind is unsupported")
        if operation.path is not None:
            return _deny("two-endpoint operation contains path", observed_kind)
        source_path = _validate_relative_path(operation.source_path, "operation source")
        destination_path = _validate_relative_path(
            operation.destination_path, "operation destination"
        )
        source = _prove_endpoint(
            source_path,
            "operation source",
            worktree_root=canonical_worktree,
            authorized_root=canonical_authorized,
            reserved_roots=proven_reserved,
            directory=operation.directory,
        )
        destination = _prove_endpoint(
            destination_path,
            "operation destination",
            worktree_root=canonical_worktree,
            authorized_root=canonical_authorized,
            reserved_roots=proven_reserved,
            directory=operation.directory,
        )
        if not _endpoint_exists(os.path.join(canonical_authorized, source_path)):
            return _deny(f"{operation.kind} source does not exist", observed_kind)
        if _endpoint_exists(os.path.join(canonical_authorized, destination_path)):
            return _deny(
                f"{operation.kind} destination already exists", observed_kind
            )
        if stat.S_ISDIR(os.stat(source).st_mode) != operation.directory:
            return _deny(
                "operation source type does not match its directory flag",
                observed_kind,
            )

        if operation.kind == "rename":
            owned = any(
                declaration.declaration.change_kind == "rename"
                and _declaration_contains(declaration, source, source=True)
                and _declaration_contains(declaration, destination)
                for declaration in declarations
            )
            if owned:
                return ScopeDecision("ALLOW", "rename")
            return _deny(
                "rename endpoints do not match one declared rename", "rename"
            )

        destination_owned = any(
            declaration.declaration.change_kind == "create"
            and _declaration_contains(declaration, destination)
            for declaration in declarations
        )
        if destination_owned:
            return ScopeDecision("ALLOW", "create")
        return _deny("link destination is outside declared create scope", "create")
    except _ScopeError as error:
        return _deny(str(error), observed_kind)
    except Exception:
        return _deny("scope identity could not be proven", observed_kind)


def _native_operation(event: CanonicalPolicyEvent) -> ScopeOperation | ScopeDecision:
    path = event.source_endpoint
    if event.action == "read":
        return ScopeOperation("read", False, path=path)
    if event.action == "write":
        try:
            relative_path = _validate_relative_path(path, "operation endpoint")
            exists = _endpoint_exists(
                os.path.join(event.worktree_realpath, relative_path)
            )
        except _ScopeError as error:
            return _deny(str(error))
        return ScopeOperation("modify" if exists else "create", False, path=path)
    if event.action == "edit":
        return ScopeOperation("modify", False, path=path)
    return _deny("canonical native action is unsupported")


def evaluate_canonical_event(event: CanonicalPolicyEvent) -> ScopeDecision:
    """Project an authenticated canonical native event into scope semantics."""

    if event.native_phase != "tool_call":
        return ScopeDecision("ABSTAIN")
    operation = _native_operation(event)
    if isinstance(operation, ScopeDecision):
        return operation
    return evaluate_scope(
        worktree_root=event.worktree_realpath,
        authorized_root=event.worktree_realpath,
        reserved_roots=(
            event.state_root_realpath,
            event.policy_root_realpath,
            event.bundle_root_realpath,
        ),
        declared_scope=event.declared_scope,
        operation=operation,
    )


def _policy_mapping(decision: ScopeDecision) -> dict[str, str] | None:
    if decision.result == "ABSTAIN":
        return None
    if decision.result == "ALLOW":
        return {"result": "ALLOW"}
    reason = decision.reason or "scope request denied"
    return {
        "result": "DENY",
        "reason": f"{SCOPE_DENIAL_CODE}: {reason}",
        "code": SCOPE_DENIAL_CODE,
    }


def scope_fence(event: object, config: object) -> dict[str, str] | None:
    """Real FunctionPolicy entrypoint backed only by canonical authority."""

    try:
        outcome = adapt_native_policy_event(
            event,
            config,
            authenticator=FilesystemContextAuthenticator.from_environment(),
        )
        if isinstance(outcome, PolicyDenial):
            return {
                "result": "DENY",
                "reason": outcome.reason,
                "code": outcome.code.value,
            }
        if isinstance(outcome, PolicyAbstention):
            return None
        return _policy_mapping(evaluate_canonical_event(outcome))
    except Exception:
        return {
            "result": "DENY",
            "reason": f"{SCOPE_DENIAL_CODE}: scope policy failed safely",
            "code": SCOPE_DENIAL_CODE,
        }


def check_scope_resolved(
    root: object,
    declared_paths: object,
    target_path: object,
    is_write: object,
    destination_path: object = None,
) -> dict[str, str]:
    """Compatibility adapter for the legacy verdict CLI shape.

    It delegates to :func:`evaluate_scope`; it is not used by the production
    FunctionPolicy handler and cannot supply native authority.
    """

    if is_write is False:
        return {"result": "ALLOW"}
    if is_write is not True or not isinstance(root, str):
        return {
            "result": "DENY",
            "reason": "invalid legacy scope request",
            "code": "SCOPE_DENIED",
        }
    if not isinstance(declared_paths, (list, tuple)):
        declared_paths = ()
    normalized = tuple(
        path.rstrip("/") if isinstance(path, str) else path
        for path in declared_paths
    )
    try:
        target = _validate_relative_path(target_path, "operation endpoint")
        exists = _endpoint_exists(os.path.join(root, target))
    except _ScopeError:
        exists = False

    if isinstance(destination_path, str) and destination_path:
        operation = ScopeOperation(
            "rename",
            False,
            source_path=target_path if isinstance(target_path, str) else None,
            destination_path=destination_path,
        )
        declarations = tuple(
            TicketScopeEntry(path, "rename", True, path)
            for path in normalized
            if isinstance(path, str)
        )
    else:
        kind: ScopeChangeKind = "modify" if exists else "create"
        operation = ScopeOperation(
            kind,
            False,
            path=target_path if isinstance(target_path, str) else None,
        )
        declarations = tuple(
            TicketScopeEntry(path, kind, True)
            for path in normalized
            if isinstance(path, str)
        )
    decision = evaluate_scope(
        worktree_root=root,
        authorized_root=root,
        reserved_roots=(),
        declared_scope=declarations,
        operation=operation,
    )
    if decision.result == "DENY":
        return {
            "result": "DENY",
            "reason": decision.reason or "scope request denied",
            "code": "SCOPE_DENIED",
        }
    return {"result": "ALLOW"}


__all__ = [
    "CANONICAL_FILESYSTEM_TOOLS",
    "RAW_SHELL_TOOLS",
    "SCOPE_DENIAL_CODE",
    "ScopeDecision",
    "ScopeOperation",
    "check_scope_resolved",
    "evaluate_canonical_event",
    "evaluate_scope",
    "scope_fence",
]
