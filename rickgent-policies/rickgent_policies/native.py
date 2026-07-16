"""Shared fail-closed entrypoint helpers for canonical Rickgent policies."""

from __future__ import annotations

from .context import FilesystemContextAuthenticator
from .policy_event import PolicyDenial, PolicyEventResult, adapt_native_policy_event


def adapt_authenticated(event: object, config: object) -> PolicyEventResult:
    return adapt_native_policy_event(
        event,
        config,
        authenticator=FilesystemContextAuthenticator.from_environment(),
    )


def denial_result(denial: PolicyDenial) -> dict[str, str]:
    return {
        "result": "DENY",
        "reason": denial.reason,
        "code": denial.code.value,
    }


def fail_closed(code: str, label: str) -> dict[str, str]:
    return {"result": "DENY", "reason": f"{code}: {label} failed safely", "code": code}


__all__ = ["adapt_authenticated", "denial_result", "fail_closed"]
