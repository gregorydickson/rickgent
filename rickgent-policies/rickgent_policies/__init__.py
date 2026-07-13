"""Rickgent policy shims — pure Python enforcement surfaces.

These shims delegate to the TypeScript verdict core via `rickgent verdict` CLI
subprocess calls. The scope fence (hot path) runs in-process for performance;
all other verdict-shaped checks shell out to the single TS implementation.

Fail closed everywhere: unknown exceptions map to DENY/POLICY_SHIM_ERROR.
"""

import subprocess
import json
import os
import re
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
            # Shell commands that write — expanded list plus redirect patterns.
            # Catches both explicit write utilities and any redirect-to-file
            # operation (`>`, `>>`) that the substring list would otherwise miss.
            args = event.get("arguments", {})
            if isinstance(args, str):
                import json as _json
                try:
                    args = _json.loads(args)
                except Exception:
                    args = {}
            command = args.get("command", "") if isinstance(args, dict) else str(args)
            write_ops = [
                ">", ">>", "tee", "cp", "mv", "rm", "mkdir",
                "sed -i", "dd of=", "install", "rsync",
                "git checkout --", "git restore", "patch", "touch",
                "cat >", "printf >", "python -c", "node -e",
                "npm install", "pip install",
            ]
            is_write = any(op in command for op in write_ops) or bool(
                re.search(r">\s*\S", command) or re.search(r">>\s*\S", command)
            )
            if not is_write:
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

        # Only gate phases require a gate_input. Non-gate phases pass through.
        phase = config.get("phase", "")
        gate_phases = {"implement", "spec_conformance"}
        if phase not in gate_phases:
            return {"result": "ALLOW"}

        gate_input = config.get("gate_input", {})
        if not gate_input:
            # Fail closed: a gate phase without gate_input cannot be verified.
            return {
                "result": "DENY",
                "reason": "convergence gate: missing gate_input for gate phase",
                "code": "GATE_FAILED",
            }

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

        # DENY force push — detect -f in any position (start, middle, end of
        # command, or combined into a short-flag group like -uf / -fH) plus the
        # long forms. Substring matching of " -f " misses trailing and combined
        # flags, so use word-boundary / combined-flag regexes instead.
        if (
            re.search(r"\s-f\b", command_lower)
            or re.search(r"(?:^|\s)-\S*f\S*", command_lower)
            or "--force" in command_lower
            or "--force-with-lease" in command_lower
        ):
            return {"result": "DENY", "reason": "autonomous_pr_flow: force push not allowed", "code": "FORCE_PUSH_DENIED"}

        # For git push: only allow push to feature branches (not main/master/trunk/develop)
        if is_git_push:
            protected = ["main", "master", "trunk", "develop", "dev", "release/"]
            # Extract the destination branch from all common push syntaxes:
            # `origin <branch>`, `origin/<branch>`, `HEAD:<branch>`,
            # `refs/heads/<branch>`. This catches `git push origin HEAD:main`
            # and `git push origin refs/heads/main` which the bare
            # `origin <branch>` substring check would miss.
            dest_branch = None
            for pattern in (
                r"\bheads/(\S+)",
                r"\bhead:(\S+)",
                r"\borigin/(\S+)",
                r"\borigin\s+(\S+)",
            ):
                m = re.search(pattern, command_lower)
                if m:
                    dest_branch = m.group(1)
                    break
            if dest_branch:
                for branch in protected:
                    if dest_branch == branch or dest_branch.startswith(branch):
                        return {"result": "DENY", "reason": f"autonomous_pr_flow: push to protected branch {branch} not allowed", "code": "PROTECTED_BRANCH_DENIED"}
            return {"result": "ALLOW", "reason": "autonomous_pr_flow: feature-branch push allowed"}

        # gh pr create — allow
        return {"result": "ALLOW", "reason": "autonomous_pr_flow: gh pr create allowed"}

    except Exception as e:
        return {"result": "DENY", "reason": f"autonomous_pr_flow: {e}", "code": "POLICY_SHIM_ERROR"}


# ── POLICY_REGISTRY ──────────────────────────────────────────────────────────

# The registry that omnigent's `policy_modules` config ingests.
# Entry schema matches omnigent.policies.registry.PolicyRegistryEntry:
#   handler     — full dotted import path to the callable
#   kind        — "callable" (direct callable) or "factory"
#   name        — short display name (auto-derived if omitted)
#   description — human-readable description
POLICY_REGISTRY = [
    {
        "handler": "rickgent_policies.scope_fence",
        "kind": "callable",
        "name": "Scope Fence",
        "description": "Scope fence — blocks out-of-scope writes (hot path, in-process)",
    },
    {
        "handler": "rickgent_policies.completion_evidence",
        "kind": "callable",
        "name": "Completion Evidence",
        "description": "Completion evidence — denies done-claims without verified commit (cold path, via rickgent verdict)",
    },
    {
        "handler": "rickgent_policies.convergence_gate",
        "kind": "callable",
        "name": "Convergence Gate",
        "description": "Convergence gate — denies phase advance on stale baseline or failing gate (cold path, via rickgent verdict)",
    },
    {
        "handler": "rickgent_policies.subtract_before_add",
        "kind": "callable",
        "name": "Subtract Before Add",
        "description": "Subtract before add — requires simplification review in every PRD (cold path, via rickgent verdict)",
    },
    {
        "handler": "rickgent_policies.cross_vendor_review",
        "kind": "callable",
        "name": "Cross Vendor Review",
        "description": "Cross-vendor review — denies same-vendor code review (AC-13)",
    },
    {
        "handler": "rickgent_policies.autonomous_pr_flow",
        "kind": "callable",
        "name": "Autonomous Pr Flow",
        "description": "Autonomous PR flow — narrow ALLOW for feature-branch push + gh pr create (forbidden-ops remediation)",
    },
]
