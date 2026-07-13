"""Rickgent policy shims — pure Python enforcement surfaces.

These shims delegate to the TypeScript verdict core via `rickgent verdict` CLI
subprocess calls. The scope fence (hot path) runs in-process for performance;
all other verdict-shaped checks shell out to the single TS implementation.

Fail closed everywhere: unknown exceptions map to DENY/POLICY_SHIM_ERROR.
"""

import subprocess
import json
import os
from pathlib import Path

# Build commit — matched against the TS package at startup.
# For editable installs, auto-detect from `rickgent --build-commit` if available.
# For releases, this is set at build time via RICKGENT_BUILD_COMMIT env var.
_BUILD_COMMIT_OVERRIDE = os.environ.get("RICKGENT_BUILD_COMMIT")
BUILD_COMMIT = _BUILD_COMMIT_OVERRIDE or "dev"

def _detect_build_commit() -> str:
    """Try to detect build_commit from the rickgent CLI."""
    global BUILD_COMMIT
    if _BUILD_COMMIT_OVERRIDE:
        return _BUILD_COMMIT_OVERRIDE
    try:
        result = subprocess.run(
            ["rickgent", "--build-commit"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            BUILD_COMMIT = result.stdout.strip()
            return BUILD_COMMIT
    except Exception:
        pass
    return BUILD_COMMIT

# Auto-detect on import for editable installs
if not _BUILD_COMMIT_OVERRIDE:
    _detect_build_commit()

# Path to the rickgent CLI (set via environment or auto-detected)
_RICKGENT_BIN = os.environ.get("RICKGENT_BIN", "rickgent")


def _rickgent_verdict(check: str, input_data: dict) -> dict:
    """Call `rickgent verdict <check> --json` via subprocess.

    CLI failure, malformed output, timeout, or missing binary → DENY.
    The shim never guesses.
    """
    try:
        proc = subprocess.run(
            [_RICKGENT_BIN, "verdict", check, "--json"],
            input=json.dumps(input_data),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            return {"error": True, "code": "POLICY_SHIM_ERROR", "message": f"rickgent verdict exited {proc.returncode}"}
        return json.loads(proc.stdout)
    except subprocess.TimeoutExpired:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": "rickgent verdict timed out"}
    except (json.JSONDecodeError, ValueError) as e:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": f"malformed verdict output: {e}"}
    except FileNotFoundError:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": "rickgent binary not found"}
    except Exception as e:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": str(e)}


def _assert_build_commit() -> None:
    """Assert the Python wheel and TS package expose the same build_commit."""
    try:
        ts_commit = subprocess.run(
            [_RICKGENT_BIN, "--build-commit"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        if ts_commit != BUILD_COMMIT:
            raise RuntimeError(
                f"build_commit mismatch: TS={ts_commit[:12]} Python={BUILD_COMMIT[:12]}"
            )
    except Exception:
        # Fail closed — but don't crash on first import if rickgent isn't installed yet
        pass


# ── Scope fence (hot path — in-process) ──────────────────────────────────────

def _canonicalize_path(p: str) -> str:
    """Canonicalize a path by resolving . and .. components."""
    parts = p.split("/")
    resolved = []
    for part in parts:
        if part in (".", ""):
            continue
        if part == "..":
            if resolved:
                resolved.pop()
            continue
        resolved.append(part)
    return "/".join(resolved)


def _is_path_in_scope(target: str, scope: str) -> bool:
    """Check if target path is within the scope path."""
    if target == scope:
        return True
    if scope.endswith("/"):
        return target.startswith(scope)
    return target.startswith(scope + "/")


def scope_fence(event, config):
    """Enforcement surface for write-path scope checking.

    Fires on every write tool call. Mechanical path canonicalization —
    parity with the TS core's scope module pinned by shared AC-10 fixtures.
    """
    try:
        # Only check write operations
        tool_name = event.get("tool_name", "")
        write_tools = {"Write", "Edit", "MultiEdit", "sys_os_shell", "Bash", "bash"}
        if tool_name not in write_tools:
            return {"result": "ALLOW"}

        # Check if this is a write operation in sys_os_shell
        if tool_name in ("sys_os_shell", "Bash", "bash"):
            # Shell commands that write — check for redirect/tee/cp/mv
            args = event.get("arguments", {})
            if isinstance(args, str):
                import json as _json
                try:
                    args = _json.loads(args)
                except Exception:
                    args = {}
            command = args.get("command", "") if isinstance(args, dict) else str(args)
            if not any(op in command for op in [">", ">>", "tee", "cp", "mv", "rm", "mkdir"]):
                return {"result": "ALLOW"}

        # Get ticket info from config
        ticket_id = config.get("ticket_id")
        if not ticket_id:
            return {"result": "DENY", "reason": "scope fence: missing ticket_id", "code": "SCOPE_DENIED"}

        declared_paths = config.get("declared_paths", [])
        if not declared_paths:
            return {"result": "DENY", "reason": "scope fence: no declared paths", "code": "SCOPE_DENIED"}

        # Extract target path from event
        target = event.get("path") or event.get("file_path") or event.get("target")
        if not target:
            # Unresolvable write target → DENY
            return {"result": "DENY", "reason": "scope fence: unresolvable write target", "code": "SCOPE_DENIED"}

        # Canonicalize and check
        canonical_target = _canonicalize_path(target)
        for declared in declared_paths:
            canonical_declared = _canonicalize_path(declared)
            if _is_path_in_scope(canonical_target, canonical_declared):
                return {"result": "ALLOW"}

        return {
            "result": "DENY",
            "reason": f"scope fence: {canonical_target} not in declared paths",
            "code": "SCOPE_DENIED",
        }
    except Exception as e:
        return {
            "result": "DENY",
            "reason": f"scope fence: policy shim error: {e}",
            "code": "POLICY_SHIM_ERROR",
        }


# ── Completion evidence (cold path — via rickgent verdict) ───────────────────

def completion_evidence(event, config):
    """Enforcement surface for done-claims. Shells out to the TS oracle."""
    try:
        # Only check done-claim events
        if not _is_done_claim(event):
            return {"result": "ALLOW"}

        completion_input = {
            "claimedSha": config.get("claimed_sha"),
            "baselineSha": config.get("baseline_sha", ""),
            "shaExists": config.get("sha_exists", False),
            "treeChanged": config.get("tree_changed", False),
            "gateGreen": config.get("gate_green"),
        }

        verdict = _rickgent_verdict("completion", completion_input)
        if verdict.get("error"):
            return {"result": "DENY", "reason": f"completion evidence: {verdict.get('code', 'ERROR')}", "code": "POLICY_SHIM_ERROR"}

        verdict_type = verdict.get("verdict", "UNVERIFIED")
        if verdict_type != "COMMITTED":
            return {"result": "DENY", "reason": f"completion evidence: {verdict_type}", "code": "COMPLETION_UNVERIFIED"}

        return {"result": "ALLOW"}
    except Exception as e:
        return {"result": "DENY", "reason": f"completion evidence: {e}", "code": "POLICY_SHIM_ERROR"}


def _is_done_claim(event) -> bool:
    """Check if the event is a done-claim (phase advance or completion marker)."""
    tool_name = event.get("tool_name", "")
    return tool_name in ("rickgent_phase_advance", "rickgent_mark_done")


# ── Convergence gate (cold path — via rickgent verdict) ──────────────────────

def convergence_gate(event, config):
    """Enforcement surface for the convergence gate."""
    try:
        if event.get("tool_name") != "rickgent_phase_advance":
            return {"result": "ALLOW"}

        gate_input = config.get("gate_input", {})
        if not gate_input:
            return {"result": "ALLOW"}  # No gate to check

        verdict = _rickgent_verdict("gate", gate_input)
        if verdict.get("error"):
            return {"result": "DENY", "reason": f"convergence gate: {verdict.get('code', 'ERROR')}", "code": "POLICY_SHIM_ERROR"}

        if not verdict.get("passed", False):
            failures = verdict.get("failures", [])
            return {"result": "DENY", "reason": f"convergence gate: {failures}", "code": "GATE_FAILED"}

        return {"result": "ALLOW"}
    except Exception as e:
        return {"result": "DENY", "reason": f"convergence gate: {e}", "code": "POLICY_SHIM_ERROR"}


# ── Subtract before add (cold path — via rickgent verdict) ───────────────────

def subtract_before_add(event, config):
    """Require simplification review in every PRD."""
    try:
        if event.get("tool_name") != "rickgent_prd_validate":
            return {"result": "ALLOW"}

        prd_input = config.get("prd", {})
        if not prd_input:
            return {"result": "DENY", "reason": "PRD validation: no PRD provided", "code": "PRD_INVALID"}

        verdict = _rickgent_verdict("prd", prd_input)
        if verdict.get("error"):
            return {"result": "DENY", "reason": f"PRD validation: {verdict.get('code', 'ERROR')}", "code": "POLICY_SHIM_ERROR"}

        if not verdict.get("valid", False):
            errors = verdict.get("errors", [])
            return {"result": "DENY", "reason": f"PRD invalid: {errors}", "code": "PRD_INVALID"}

        return {"result": "ALLOW"}
    except Exception as e:
        return {"result": "DENY", "reason": f"PRD validation: {e}", "code": "POLICY_SHIM_ERROR"}


# ── Cross-vendor review enforcement (AC-13) ──────────────────────────────────

def cross_vendor_review(event, config):
    """DENY same-vendor review — reviewer must differ from implementer."""
    try:
        if event.get("tool_name") != "rickgent_phase_advance":
            return {"result": "ALLOW"}

        phase = config.get("phase", "")
        if phase != "code_review":
            return {"result": "ALLOW"}

        implementer = config.get("implementer_vendor", "")
        reviewer = config.get("reviewer_vendor", "")

        if not implementer or not reviewer:
            return {"result": "DENY", "reason": "cross-vendor review: missing vendor labels", "code": "CROSS_VENDOR_DENIED"}

        if implementer == reviewer:
            return {"result": "DENY", "reason": f"cross-vendor review: reviewer ({reviewer}) same as implementer ({implementer})", "code": "CROSS_VENDOR_DENIED"}

        return {"result": "ALLOW"}
    except Exception as e:
        return {"result": "DENY", "reason": f"cross-vendor review: {e}", "code": "POLICY_SHIM_ERROR"}


# ── Autonomous PR flow (narrow ALLOW exception to blast_radius gating) ────────

def _is_tool_call(event) -> bool:
    """Heuristic: is this event a tool call we should evaluate?

    Raises on non-dict input (e.g. None) so autonomous_pr_flow's try/except
    fails closed with POLICY_SHIM_ERROR.
    """
    tool_name = event.get("tool_name", "")
    if not tool_name:
        return False
    return tool_name in {"Bash", "bash", "sys_os_shell", "shell"}


def autonomous_pr_flow(event, config):
    """Narrow ALLOW for the autonomous PR flow — feature-branch push + gh pr create only.

    This is the narrow exception to blast_radius's ASK-class gating. It allows
    only the exact command shapes the PR flow needs, leaving blast_radius
    (gate_pushes=True) in force for everything else (gh pr merge, gh release,
    gh repo delete, infra destroy, rm -rf, etc.).
    """
    try:
        if not _is_tool_call(event):
            return {"result": "ALLOW"}

        args = event.get("arguments", {})
        if isinstance(args, str):
            import json as _json
            try:
                args = _json.loads(args)
            except Exception:
                args = {}

        command = ""
        if isinstance(args, dict):
            command = args.get("command", "")
        if not command:
            return {"result": "ALLOW"}  # Not a shell command — let other policies handle

        command_lower = command.lower().strip()

        # Only evaluate git push and gh pr create commands
        is_git_push = command_lower.startswith("git push")
        is_gh_pr_create = command_lower.startswith("gh pr create")

        if not is_git_push and not is_gh_pr_create:
            return {"result": "ALLOW"}  # Not a PR-flow command — defer to blast_radius

        # DENY force push
        if "--force" in command_lower or " -f " in command_lower or "--force-with-lease" in command_lower:
            return {"result": "DENY", "reason": "autonomous_pr_flow: force push not allowed", "code": "FORCE_PUSH_DENIED"}

        # For git push: only allow push to feature branches (not main/master/trunk/develop)
        if is_git_push:
            protected = ["main", "master", "trunk", "develop", "dev", "release/"]
            for branch in protected:
                if f"origin {branch}" in command_lower or f"origin/{branch}" in command_lower:
                    return {"result": "DENY", "reason": f"autonomous_pr_flow: push to protected branch {branch} not allowed", "code": "PROTECTED_BRANCH_DENIED"}
            return {"result": "ALLOW", "reason": "autonomous_pr_flow: feature-branch push allowed"}

        # gh pr create — allow
        return {"result": "ALLOW", "reason": "autonomous_pr_flow: gh pr create allowed"}

    except Exception as e:
        return {"result": "DENY", "reason": f"autonomous_pr_flow: {e}", "code": "POLICY_SHIM_ERROR"}


# ── POLICY_REGISTRY ──────────────────────────────────────────────────────────

# The registry that omnigent's `policy_modules` config ingests.
# Each entry maps a handler name to (factory_or_callable, default_params).
POLICY_REGISTRY = [
    {
        "handler": "rickgent_policies.scope_fence",
        "factory": scope_fence,
        "events": ["tool_call"],
        "description": "Scope fence — blocks out-of-scope writes (hot path, in-process)",
    },
    {
        "handler": "rickgent_policies.completion_evidence",
        "factory": completion_evidence,
        "events": ["tool_call"],
        "description": "Completion evidence — denies done-claims without verified commit (cold path, via rickgent verdict)",
    },
    {
        "handler": "rickgent_policies.convergence_gate",
        "factory": convergence_gate,
        "events": ["tool_call"],
        "description": "Convergence gate — denies phase advance on stale baseline or failing gate (cold path, via rickgent verdict)",
    },
    {
        "handler": "rickgent_policies.subtract_before_add",
        "factory": subtract_before_add,
        "events": ["tool_call"],
        "description": "Subtract before add — requires simplification review in every PRD (cold path, via rickgent verdict)",
    },
    {
        "handler": "rickgent_policies.cross_vendor_review",
        "factory": cross_vendor_review,
        "events": ["tool_call"],
        "description": "Cross-vendor review — denies same-vendor code review (AC-13)",
    },
    {
        "handler": "rickgent_policies.autonomous_pr_flow",
        "factory": autonomous_pr_flow,
        "events": ["tool_call"],
        "description": "Autonomous PR flow — narrow ALLOW for feature-branch push + gh pr create (forbidden-ops remediation)",
    },
]
