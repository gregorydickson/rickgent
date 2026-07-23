"""Rickgent's authenticated Omnigent FunctionPolicy surface."""

from .attachment import (
    ATTACHED_POLICY_ROWS,
    REQUIRED_POLICIES,
    REQUIRED_POLICY_NAMES,
    effective_attached_policies,
    validate_attached_policy_bundle,
)
from .completion import COMPLETION_DENIAL_CODE, completion_evidence
from .convergence import CONVERGENCE_DENIAL_CODE, convergence_gate
from .delivery import (
    AUTONOMOUS_PR_DENIAL_CODE,
    _is_protected,
    autonomous_pr_flow,
    classify_delivery_command,
)
from .review import CROSS_VENDOR_DENIAL_CODE, cross_vendor_review
from .routing import select_model
from .scope import (
    CANONICAL_FILESYSTEM_TOOLS,
    RAW_SHELL_TOOLS,
    SCOPE_DENIAL_CODE,
    ScopeDecision,
    ScopeOperation,
    check_scope_resolved,
    evaluate_canonical_event,
    evaluate_scope,
    scope_fence,
)
from .simplification import SIMPLIFICATION_DENIAL_CODE, subtract_before_add
from .verdict import (
    _RICKGENT_BIN,
    _RICKGENT_NODE,
    BUILD_COMMIT,
    _assert_build_commit,
    _detect_build_commit,
    _rickgent_verdict,
    _verified_verdict,
)

_SHELL_TOOL_NAMES = RAW_SHELL_TOOLS
_STRUCTURED_WRITE_TOOLS = CANONICAL_FILESYSTEM_TOOLS - {"sys_os_read"}

POLICY_REGISTRY = [
    {
        "handler": "rickgent_policies.scope_fence",
        "kind": "callable",
        "name": "Scope Fence",
        "description": "Authenticated structured scope fence",
    },
    {
        "handler": "rickgent_policies.completion_evidence",
        "kind": "callable",
        "name": "Completion Evidence",
        "description": "Authenticated terminal completion evidence",
    },
    {
        "handler": "rickgent_policies.convergence_gate",
        "kind": "callable",
        "name": "Convergence Gate",
        "description": "Authenticated blocking build convergence gate",
    },
    {
        "handler": "rickgent_policies.subtract_before_add",
        "kind": "callable",
        "name": "Subtract Before Add",
        "description": "Authenticated PRD simplification validation",
    },
    {
        "handler": "rickgent_policies.cross_vendor_review",
        "kind": "callable",
        "name": "Cross Vendor Review",
        "description": "Authenticated cross-vendor review boundary",
    },
    {
        "handler": "rickgent_policies.autonomous_pr_flow",
        "kind": "factory",
        "name": "Autonomous Pr Flow",
        "description": "Stateful authenticated push-then-PR delivery flow",
    },
]


__all__ = [
    "ATTACHED_POLICY_ROWS",
    "AUTONOMOUS_PR_DENIAL_CODE",
    "BUILD_COMMIT",
    "CANONICAL_FILESYSTEM_TOOLS",
    "COMPLETION_DENIAL_CODE",
    "CONVERGENCE_DENIAL_CODE",
    "CROSS_VENDOR_DENIAL_CODE",
    "POLICY_REGISTRY",
    "RAW_SHELL_TOOLS",
    "REQUIRED_POLICIES",
    "REQUIRED_POLICY_NAMES",
    "SCOPE_DENIAL_CODE",
    "SIMPLIFICATION_DENIAL_CODE",
    "ScopeDecision",
    "ScopeOperation",
    "autonomous_pr_flow",
    "check_scope_resolved",
    "classify_delivery_command",
    "completion_evidence",
    "convergence_gate",
    "cross_vendor_review",
    "effective_attached_policies",
    "evaluate_canonical_event",
    "evaluate_scope",
    "scope_fence",
    "select_model",
    "subtract_before_add",
    "validate_attached_policy_bundle",
]
