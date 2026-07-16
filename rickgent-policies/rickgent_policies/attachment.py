"""Exact manager/worker FunctionPolicy attachment contract."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

from .policy_event import POLICY_ABI_VERSION, REQUIRED_CONFIG_KEYS


@dataclass(frozen=True)
class AttachmentRow:
    name: str
    path: str
    arguments: Mapping[str, object] | None
    rickgent: bool


ATTACHED_POLICY_ROWS = (
    AttachmentRow(
        "blast_radius",
        "omnigent.inner.nessie.policies.blast_radius",
        MappingProxyType({"gate_pushes": True}),
        False,
    ),
    AttachmentRow("scope_fence", "rickgent_policies.scope_fence", None, True),
    AttachmentRow("completion_evidence", "rickgent_policies.completion_evidence", None, True),
    AttachmentRow("convergence_gate", "rickgent_policies.convergence_gate", None, True),
    AttachmentRow("subtract_before_add", "rickgent_policies.subtract_before_add", None, True),
    AttachmentRow("cross_vendor_review", "rickgent_policies.cross_vendor_review", None, True),
    AttachmentRow("autonomous_pr_flow", "rickgent_policies.autonomous_pr_flow", MappingProxyType({}), True),
)
REQUIRED_POLICY_NAMES = tuple(row.name for row in ATTACHED_POLICY_ROWS)
REQUIRED_POLICIES = frozenset(REQUIRED_POLICY_NAMES)


def _expected_config(config: object) -> dict[str, str]:
    if not isinstance(config, Mapping) or set(config) != REQUIRED_CONFIG_KEYS:
        raise ValueError("materialized Rickgent policy config must contain exactly seven keys")
    normalized: dict[str, str] = {}
    for key in REQUIRED_CONFIG_KEYS:
        value = config[key]
        if not isinstance(value, str) or not value:
            raise ValueError(f"materialized Rickgent policy config {key!r} must be a non-empty string")
        normalized[key] = value
    if normalized["rickgent_policy_abi"] != POLICY_ABI_VERSION:
        raise ValueError("materialized Rickgent policy config uses an unsupported ABI")
    return normalized


def _arguments_equal(actual: object, expected: Mapping[str, object] | None) -> bool:
    if expected is None:
        return actual is None
    return isinstance(actual, Mapping) and dict(actual) == dict(expected)


def validate_attached_policy_bundle(
    bundle_dir: str | Path,
    *,
    expected_config: object | None = None,
    smoke: bool = False,
):
    """Parse, structurally validate, resolve, and optionally execute a bundle."""

    from omnigent.policies.function import resolve_function_policy
    from omnigent.policies.types import EvaluationContext
    from omnigent.spec.parser import parse
    from omnigent.spec.types import FunctionPolicySpec, Phase, PolicyAction

    config = None if expected_config is None else _expected_config(expected_config)
    spec = parse(Path(bundle_dir), expand_env=False)
    guardrails = getattr(spec, "guardrails", None)
    policies = list(getattr(guardrails, "policies", None) or [])
    observed_names = tuple(policy.name for policy in policies)
    if observed_names != REQUIRED_POLICY_NAMES:
        raise ValueError(
            "policy attachment names/order mismatch: "
            f"expected {REQUIRED_POLICY_NAMES!r}, observed {observed_names!r}"
        )

    resolved = []
    for index, (policy, expected) in enumerate(zip(policies, ATTACHED_POLICY_ROWS, strict=True)):
        if not isinstance(policy, FunctionPolicySpec):
            raise ValueError(f"attached policy {expected.name!r} is not a FunctionPolicySpec")
        if policy.function is None or policy.function.path != expected.path:
            raise ValueError(
                f"attached policy {expected.name!r} has incompatible function path"
            )
        if not _arguments_equal(policy.function.arguments, expected.arguments):
            raise ValueError(
                f"attached policy {expected.name!r} has incompatible direct/factory arguments"
            )
        if policy.condition is not None or policy.on is not None or policy.set_labels is not None:
            raise ValueError(f"attached policy {expected.name!r} has unsupported selector or write configuration")
        if expected.rickgent:
            if config is None:
                if policy.config is not None:
                    raise ValueError(f"template policy {expected.name!r} must not carry attempt config")
            elif dict(policy.config or {}) != config:
                raise ValueError(f"materialized policy {expected.name!r} lacks exact attempt config")
        elif policy.config is not None:
            raise ValueError("blast_radius must not receive Rickgent attempt config")
        try:
            resolved.append(resolve_function_policy(policy))
        except Exception as error:
            raise ValueError(
                f"attached policy {expected.name!r} is not FunctionPolicy-compatible: {error}"
            ) from error
        if resolved[-1].spec.name != expected.name or index >= len(ATTACHED_POLICY_ROWS):
            raise ValueError(f"attached policy {expected.name!r} resolved incompatibly")

    if smoke:
        if config is None:
            raise ValueError("behavioral attachment smoke requires materialized attempt config")

        async def evaluate_all() -> None:
            context = EvaluationContext(
                phase=Phase.REQUEST,
                content="rickgent attachment startup smoke",
                tool_name=None,
            )
            for policy in resolved:
                try:
                    result = await policy.evaluate(context, {})
                except Exception as error:
                    raise ValueError(
                        f"attached policy {policy.spec.name!r} failed FunctionPolicy execution: {error}"
                    ) from error
                if result.action is not PolicyAction.ALLOW:
                    raise ValueError(
                        f"attached policy {policy.spec.name!r} failed authenticated startup smoke: "
                        f"{result.action.name} {result.reason or ''}".strip()
                    )

        asyncio.run(evaluate_all())
    return tuple(resolved)


def effective_attached_policies(bundle_dir: str | Path) -> set[str]:
    """Compatibility projection of parser-observed attachment names."""

    from omnigent.spec.parser import parse

    spec = parse(Path(bundle_dir), expand_env=False)
    guardrails = getattr(spec, "guardrails", None)
    return {policy.name for policy in (getattr(guardrails, "policies", None) or [])}


__all__ = [
    "ATTACHED_POLICY_ROWS",
    "AttachmentRow",
    "REQUIRED_POLICIES",
    "REQUIRED_POLICY_NAMES",
    "effective_attached_policies",
    "validate_attached_policy_bundle",
]
