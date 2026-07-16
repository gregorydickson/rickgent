"""Non-authoritative lifecycle receipts exposed by the manager bundle.

Policy and orchestrator state remain the authority.  These tools exist so an
LLM call has a real, closed-schema ToolManager endpoint after policy approval;
invocation itself never advances a phase or certifies evidence.
"""

from omnigent_client.tools import tool
from pydantic import BaseModel, ConfigDict


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GateCheck(_Closed):
    name: str
    passed: bool
    output: str


class GateFinding(_Closed):
    file: str
    line: int
    message: str
    check: str


class GatePayload(_Closed):
    current: list[GateCheck]
    baseline: list[GateCheck]
    scope: list[str]
    findings: list[GateFinding]


class AcceptanceCriterion(_Closed):
    description: str
    type: str
    verifyCommand: str
    scope: list[str]


class SimplificationReview(_Closed):
    reviewed: bool
    notes: str


class PrdPayload(_Closed):
    title: str
    description: str
    acceptanceCriteria: list[AcceptanceCriterion]
    simplificationReview: SimplificationReview | None


def _receipt(tool_name: str) -> dict[str, bool | str]:
    return {
        "received": True,
        "authoritative": False,
        "tool": tool_name,
        "message": "Receipt only; authoritative lifecycle state is unchanged.",
    }


@tool
def rickgent_mark_done(
    claimed_sha: str, evidence: list[str]
) -> dict[str, bool | str]:
    """Receive a completion claim after policy validation."""

    del claimed_sha, evidence
    return _receipt("rickgent_mark_done")


@tool
def rickgent_phase_advance(
    next_phase: str
) -> dict[str, bool | str]:
    """Receive a requested lifecycle transition after policy validation."""

    del next_phase
    return _receipt("rickgent_phase_advance")


@tool
def rickgent_build_gate(gate: GatePayload) -> dict[str, bool | str]:
    """Receive build-gate observations after policy validation."""

    del gate
    return _receipt("rickgent_build_gate")


@tool
def rickgent_prd_validate(prd: PrdPayload) -> dict[str, bool | str]:
    """Receive a PRD validation request after policy validation."""

    del prd
    return _receipt("rickgent_prd_validate")
