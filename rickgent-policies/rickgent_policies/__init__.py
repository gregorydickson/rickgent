"""Rickgent policy shims — pure Python enforcement surfaces.

These shims delegate to the TypeScript verdict core via `rickgent verdict` CLI
subprocess calls. The scope fence (hot path) runs in-process for performance;
all other verdict-shaped checks shell out to the single TS implementation.

Fail closed everywhere: unknown exceptions map to DENY/POLICY_SHIM_ERROR.
"""

import subprocess
import json
import logging
import os
import re
import shlex
from pathlib import Path

_LOG = logging.getLogger("rickgent_policies")

# Build commit — matched against the TS package at startup.
# For editable installs, auto-detect from `rickgent --build-commit` if available.
# For releases, this is set at build time via RICKGENT_BUILD_COMMIT env var.
_BUILD_COMMIT_OVERRIDE = os.environ.get("RICKGENT_BUILD_COMMIT")
BUILD_COMMIT = _BUILD_COMMIT_OVERRIDE or "dev"

# Path to the rickgent CLI (set via environment or auto-detected).
# Defined BEFORE _detect_build_commit so both auto-detect and the parity
# check (_assert_build_commit) resolve the SAME binary. Under a RICKGENT_BIN
# override, using the literal "rickgent" in one path and _RICKGENT_BIN in the
# other would query different binaries and cause a false build-commit-mismatch
# DENY across completion_evidence / convergence_gate / subtract_before_add.
_RICKGENT_BIN = os.environ.get("RICKGENT_BIN", "rickgent")

def _detect_build_commit() -> str:
    """Try to detect build_commit from the rickgent CLI via _RICKGENT_BIN."""
    global BUILD_COMMIT
    if _BUILD_COMMIT_OVERRIDE:
        return _BUILD_COMMIT_OVERRIDE
    try:
        result = subprocess.run(
            [_RICKGENT_BIN, "--build-commit"],
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
    """Assert the Python wheel and TS package expose the same build_commit.

    Fails CLOSED: a TS↔Python build_commit mismatch (or a failing/timed-out
    `rickgent --build-commit`) raises ``RuntimeError`` so a divergent verdict
    core can never be trusted. A not-yet-installed rickgent CLI
    (``FileNotFoundError``) is tolerated — the module must import even before
    the TS package is present, and the downstream ``_rickgent_verdict`` call
    fails closed to DENY on a missing binary on its own. Only a *mismatch*
    (or an affirmative CLI failure) aborts here; absence does not.
    """
    try:
        proc = subprocess.run(
            [_RICKGENT_BIN, "--build-commit"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        return
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("build_commit check timed out") from e
    if proc.returncode != 0:
        raise RuntimeError(
            f"build_commit check failed: rickgent --build-commit exited {proc.returncode}"
        )
    ts_commit = (proc.stdout or "").strip()
    if ts_commit != BUILD_COMMIT:
        raise RuntimeError(
            f"build_commit mismatch: TS={ts_commit[:12]} Python={BUILD_COMMIT[:12]}"
        )


def _verified_verdict(check: str, input_data: dict) -> dict:
    """Assert TS↔Python build parity, then delegate to the verdict CLI.

    Every verdict-dependent policy routes through this single seam, so the
    build-commit parity guard runs BEFORE any policy trusts the TS verdict
    core. A build_commit mismatch raises here (fail closed) and each policy's
    own ``except`` converts it to DENY.
    """
    _assert_build_commit()
    return _rickgent_verdict(check, input_data)


# ── Scope fence (hot path — canonical in-process authority) ───────────────────

from .scope import (  # noqa: E402
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

# Compatibility exports used by attachment tests and bundle validation.
_SHELL_TOOL_NAMES = RAW_SHELL_TOOLS
_STRUCTURED_WRITE_TOOLS = CANONICAL_FILESYSTEM_TOOLS - {"sys_os_read"}


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

        verdict = _verified_verdict("completion", completion_input)
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

# The convergence check has two enforcement postures (quality-gates.md,
# architecture §7). Per-phase advance is ADVISORY: a failing convergence verdict
# is logged and the advance proceeds, because a machine-checkable failure is
# caught by the build itself and the review phases, and a heuristic per-phase
# block is the "validation overreach" archetype. Blocking is RESERVED for the
# build/full-PR gate, the single machine-checkable enforcement point that runs
# before the PR.
_PHASE_ADVANCE_TOOL = "rickgent_phase_advance"
_BUILD_GATE_TOOL = "rickgent_build_gate"
_CONVERGENCE_GATE_PHASES = {"implement", "spec_conformance"}


def convergence_gate(event, config):
    """Convergence enforcement — advisory per-phase, blocking at the build gate.

    On a per-phase advance (`rickgent_phase_advance`, gate phases `implement` /
    `spec_conformance`) the gate is ADVISORY: a failing/unverifiable verdict is
    logged and the advance proceeds (returns `None` — abstain, never DENY). On
    the build/full-PR gate (`rickgent_build_gate`) it is BLOCKING and fails
    closed to DENY on a failing/unverifiable verdict.
    """
    try:
        tool_name = event.get("tool_name")
        if tool_name not in (_PHASE_ADVANCE_TOOL, _BUILD_GATE_TOOL):
            return {"result": "ALLOW"}

        blocking = tool_name == _BUILD_GATE_TOOL
        phase = config.get("phase", "")

        # Per-phase advance only evaluates on gate phases; others pass through.
        if not blocking and phase not in _CONVERGENCE_GATE_PHASES:
            return {"result": "ALLOW"}

        def _advisory(reason: str):
            _LOG.warning(
                "convergence gate (advisory, phase=%s): %s; proceeding "
                "(blocking reserved for the build/full-PR gate)",
                phase or "?",
                reason,
            )
            return None

        gate_input = config.get("gate_input", {})
        if not gate_input:
            if blocking:
                # Fail closed: the build gate cannot verify without gate_input.
                return {
                    "result": "DENY",
                    "reason": "convergence gate: missing gate_input for build gate",
                    "code": "GATE_FAILED",
                }
            return _advisory("missing gate_input")

        verdict = _verified_verdict("gate", gate_input)
        if verdict.get("error"):
            if blocking:
                return {"result": "DENY", "reason": f"convergence gate: {verdict.get('code', 'ERROR')}", "code": "POLICY_SHIM_ERROR"}
            return _advisory(f"verdict error {verdict.get('code', 'ERROR')}")

        if not verdict.get("passed", False):
            failures = verdict.get("failures", [])
            if blocking:
                return {"result": "DENY", "reason": f"convergence gate: {failures}", "code": "GATE_FAILED"}
            return _advisory(f"failing verdict {failures}")

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

        verdict = _verified_verdict("prd", prd_input)
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


# git global options that consume a following value token (`git -C dir push …`).
_GIT_VALUE_OPTS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--super-prefix", "--exec-path",
}
# sudo options that consume a following value token (`sudo -u root <cmd>`).
_SUDO_VALUE_OPTS = {
    "-u", "-g", "-h", "-p", "-r", "-t", "-T", "-U", "-C", "-R", "-D", "-c",
    "--user", "--group", "--host", "--prompt", "--role", "--type",
    "--command-timeout", "--other-user", "--chdir", "--close-from",
}
_PROTECTED_BRANCHES = ["main", "master", "trunk", "develop", "dev", "release/"]


def _split_command_segments(command: str) -> list:
    """Split a shell command into logically-separate segments.

    A single destructive `git push` hidden behind ANY separator
    (`&&`, `||`, `;`, `|`, `&`, or a newline) must be evaluated on its own,
    so the narrow-allow whitelist can never be satisfied by a compound command.
    """
    segments = []
    for raw in re.split(r"\|\||&&|;|\n|\||&", command):
        seg = raw.strip()
        if seg:
            segments.append(seg)
    return segments


def _shlex_tokens(segment: str) -> list:
    """Shlex-split a segment, falling back to whitespace split on parse error
    so detection stays conservative (a garbled push is still tokenized)."""
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def _tokenize(segment: str) -> list:
    """Tokenize a single segment, then strip leading env-assignments and sudo.

    A `sudo` prefix is stripped along with its options; options that take a
    separate value token (`-u <user>`, `--user <user>`) consume that value too,
    so the command word after the prefix (e.g. `git`) is not mistaken.
    """
    tokens = _shlex_tokens(segment)

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):  # FOO=bar prefix
            i += 1
            continue
        if tok == "sudo":
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                opt = tokens[i]
                i += 1
                if opt in _SUDO_VALUE_OPTS and i < len(tokens) and not tokens[i].startswith("-"):
                    i += 1
            continue
        break
    return tokens[i:]


def _git_subcommand_index(tokens: list):
    """Index of the git subcommand token, skipping `git` global options."""
    if not tokens or tokens[0] != "git":
        return None
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("-"):
            if "=" in tok:
                i += 1
            elif tok in _GIT_VALUE_OPTS:
                i += 2
            else:
                i += 1
            continue
        return i
    return None


def _is_git_push(segment: str) -> bool:
    tokens = _tokenize(segment)
    idx = _git_subcommand_index(tokens)
    return idx is not None and tokens[idx] == "push"


def _is_gh_pr_create(segment: str) -> bool:
    tokens = _tokenize(segment)
    return tokens[:3] == ["gh", "pr", "create"]


def _has_force_flag(segment: str) -> bool:
    s = segment.lower()
    return bool(
        "--force" in s
        or "--force-with-lease" in s
        or re.search(r"(?:^|\s)-[a-z]*f[a-z]*\b", s)
    )


def _push_destination(segment: str):
    """Best-effort destination branch for a push segment (for DENY labeling)."""
    for pattern in (r"\bheads/(\S+)", r"\bhead:(\S+)", r"\borigin/(\S+)", r"\borigin\s+(\S+)"):
        m = re.search(pattern, segment.lower())
        if m:
            return m.group(1)
    return None


def _is_protected(dest) -> bool:
    if not dest:
        return False
    for branch in _PROTECTED_BRANCHES:
        if branch.endswith("/"):
            if dest == branch or dest.startswith(branch):
                return True
        elif dest == branch:
            return True
    return False


def _is_narrow_feature_push(segment: str, feature_branch) -> bool:
    """True iff the segment is EXACTLY `git push origin <own-branch>` /
    `git push origin HEAD:<own-branch>` with no extra flags or global options.

    The tokens are read RAW (no env-assignment/sudo prefix stripping): any
    `sudo`/`FOO=1` prefix leaves a non-`git` leading token, disqualifying the
    narrow allow so a prefixed own-branch push can never ALLOW."""
    if not feature_branch:
        return False
    tokens = _shlex_tokens(segment)
    if len(tokens) != 4 or tokens[0] != "git" or tokens[1] != "push" or tokens[2] != "origin":
        return False
    dest = tokens[3]
    return dest == feature_branch or dest == f"HEAD:{feature_branch}"


def autonomous_pr_flow(event, config):
    """Narrow ALLOW for the autonomous PR flow — own-feature-branch push + gh pr create only.

    This is the narrow exception to blast_radius's ASK-class gating. The SOLE
    push shape that may ALLOW is a single-segment push to the run's own feature
    branch (`git push origin <feature>` or `git push origin HEAD:<feature>`).
    Every force/delete/mirror/all/tags refspec, symbolic/bare/remote-only
    destination, wrong-branch destination, and separator/prefix bypass fails
    closed (DENY), leaving blast_radius (gate_pushes=True) in force for
    everything else.
    """
    try:
        if not _is_tool_call(event):
            return None  # Non-tool event — abstain so blast_radius stays authoritative

        args = event.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}

        command = ""
        if isinstance(args, dict):
            command = args.get("command", "")
        if not command:
            return None  # No parseable command — abstain, never affirmatively ALLOW

        feature_branch = (config or {}).get("feature_branch") or (config or {}).get("feature")

        segments = _split_command_segments(command)
        push_segments = [s for s in segments if _is_git_push(s)]
        gh_segments = [s for s in segments if _is_gh_pr_create(s)]

        if not push_segments and not gh_segments:
            return None  # Not a PR-flow command — abstain so blast_radius remains authoritative

        if push_segments:
            # The narrow allow is only ever the ENTIRE command being exactly one
            # own-feature-branch push segment. Anything else fails closed.
            if len(segments) == 1 and _is_narrow_feature_push(segments[0], feature_branch):
                return {"result": "ALLOW", "reason": "autonomous_pr_flow: narrow own-feature-branch push allowed"}

            if any(_has_force_flag(s) for s in push_segments):
                return {"result": "DENY", "reason": "autonomous_pr_flow: force push not allowed", "code": "FORCE_PUSH_DENIED"}

            if any(_is_protected(_push_destination(s)) for s in push_segments):
                return {"result": "DENY", "reason": "autonomous_pr_flow: push to protected branch not allowed", "code": "PROTECTED_BRANCH_DENIED"}

            return {"result": "DENY", "reason": "autonomous_pr_flow: push not the narrow own-feature-branch shape", "code": "PUSH_NOT_WHITELISTED"}

        # Only gh pr create segments remain (no push segment present).
        if len(segments) == 1:
            return {"result": "ALLOW", "reason": "autonomous_pr_flow: gh pr create allowed"}

        # A compound command carrying gh pr create is not the narrow shape;
        # abstain (None) so blast_radius remains authoritative rather than
        # granting an authoritative ALLOW that would un-gate the other segments.
        return None

    except Exception as e:
        return {"result": "DENY", "reason": f"autonomous_pr_flow: {e}", "code": "POLICY_SHIM_ERROR"}


# ── Multi-vendor routing (B8) ────────────────────────────────────────────────

# Per-role tier preference. The router selects from the live roster, ordered
# by the preferred tier for each role. This is NOT a hardcoded vendor — the
# router picks the best match from whatever the live roster offers.
_ROLE_TIER_PREFERENCE = {
    "research": "cheap",
    "research_review": "cheap",
    "plan": "mid",
    "plan_review": "mid",
    "implement": "capable",
    "spec_conformance": "mid",
    "code_review": "mid",
    "simplify": "cheap",
}

# Sort order for tier preference: preferred tier first, then other tiers in a
# fixed fallback order so selection is deterministic.
_TIER_FALLBACK = ["cheap", "mid", "capable"]


def _tier_sort_key(model, preferred_tier):
    """Sort key: preferred tier first (by absolute distance), then by tier
    proximity (cheaper tier preferred when equidistant), then by vendor and
    model for deterministic ordering.

    The tiebreak for equidistant tiers (same abs(pref_idx - tier_idx)) is
    tier_idx ascending — i.e. the cheaper adjacent tier wins. This is "tier
    proximity" in the sense that a cheaper model is the safer default when
    the preferred tier is unavailable, rather than an arbitrary alphabetical
    vendor tiebreak.
    """
    tier = model.get("tier", "mid")
    try:
        pref_idx = _TIER_FALLBACK.index(preferred_tier) if preferred_tier in _TIER_FALLBACK else 1
        tier_idx = _TIER_FALLBACK.index(tier) if tier in _TIER_FALLBACK else 1
    except ValueError:
        pref_idx, tier_idx = 1, 1
    return (abs(pref_idx - tier_idx), tier_idx, model.get("vendor", ""), model.get("model", ""))


def select_model(roster, role, implementer_vendor=None,
                 cost_budget_usd=None, soft_threshold_usd=None):
    """Route a dispatch to a harness/model from the live roster (B8).

    The router is NOT hardcoded to one vendor. It enumerates the live roster
    (preflight) and selects a harness/model per role. It fails closed
    on an empty/unavailable roster — no dispatch, no silent fallback to a
    hardcoded vendor.

    Constraints enforced BEFORE dispatch:
      - **Cross-vendor review:** the ``code_review`` role excludes the
        implementer's vendor (``implementer_vendor``). If only the
        implementer's vendor is available, the router DENYs (fail-closed)
        rather than dispatching a same-vendor reviewer.
      - **Cost gate:** an unpriced model (``pricing is None``) is skipped;
        if ALL candidates are unpriced → DENY (fail-closed). A model over the
        hard budget (``cost_budget_usd``) is skipped; if ALL are over-budget →
        DENY. A model over the soft threshold (``soft_threshold_usd``) but
        under the hard budget → ASK (if no within-budget alternative exists).

    Args:
        roster: list of model dicts, each with keys:
            ``harness`` (str), ``model`` (str), ``vendor`` (str),
            ``tier`` (str: "cheap"|"mid"|"capable"),
            ``pricing`` (None for unpriced, or ``{"cost_per_dispatch": float}``).
        role: lifecycle role ("implement", "code_review", "research", etc.).
        implementer_vendor: the implementer's vendor (for cross-vendor review).
        cost_budget_usd: hard per-dispatch cost limit in USD.
        soft_threshold_usd: soft threshold for ASK.

    Returns:
        ``{"result": "ALLOW", "selection": {"harness": str, "model": str, "vendor": str}}``
        ``{"result": "DENY", "reason": str, "code": str}``
        ``{"result": "ASK", "reason": str, "code": str, "selection": {...}}``
    """
    try:
        # Fail closed on an empty/unavailable roster.
        if not roster or not isinstance(roster, list) or len(roster) == 0:
            return {
                "result": "DENY",
                "reason": "routing: empty or unavailable roster",
                "code": "ROSTER_EMPTY",
            }

        candidates = list(roster)

        # Cross-vendor review: the review role excludes the implementer's vendor.
        if role == "code_review" and implementer_vendor:
            candidates = [m for m in candidates if m.get("vendor") != implementer_vendor]

        # If no candidates after role-constraint filtering, fail closed.
        if not candidates:
            return {
                "result": "DENY",
                "reason": f"routing: no candidates for role '{role}' after constraints",
                "code": "NO_CANDIDATES",
            }

        # Sort by tier preference for the role.
        preferred_tier = _ROLE_TIER_PREFERENCE.get(role, "mid")
        candidates.sort(key=lambda m: _tier_sort_key(m, preferred_tier))

        # Cost gate: iterate candidates and find the first that passes.
        # Unpriced models are skipped. Over-hard-budget models are skipped.
        # Over-soft-threshold models are recorded as ASK fallback.
        ask_candidate = None
        for model in candidates:
            pricing = model.get("pricing")
            if pricing is None:
                continue  # unpriced — skip

            if not isinstance(pricing, dict):
                continue  # malformed pricing — skip (fail-closed-ish)

            cost = pricing.get("cost_per_dispatch")
            if cost is None or not isinstance(cost, (int, float)):
                continue  # no cost figure — treat as unpriced

            # Hard budget check.
            if cost_budget_usd is not None and isinstance(cost_budget_usd, (int, float)):
                if cost > cost_budget_usd:
                    continue  # over hard budget — skip

            # Soft threshold check.
            if soft_threshold_usd is not None and isinstance(soft_threshold_usd, (int, float)):
                if cost > soft_threshold_usd:
                    if ask_candidate is None:
                        ask_candidate = model
                    continue  # over soft — ASK candidate, try for a better option

            # Within budget — ALLOW.
            return {
                "result": "ALLOW",
                "selection": {
                    "harness": model["harness"],
                    "model": model["model"],
                    "vendor": model["vendor"],
                },
            }

        # No within-budget candidate found.
        if ask_candidate is not None:
            return {
                "result": "ASK",
                "reason": "routing: only over-soft-threshold candidates available",
                "code": "OVER_SOFT_THRESHOLD",
                "selection": {
                    "harness": ask_candidate["harness"],
                    "model": ask_candidate["model"],
                    "vendor": ask_candidate["vendor"],
                },
            }

        # All candidates unpriced or over hard budget.
        return {
            "result": "DENY",
            "reason": "routing: no priced/within-budget model available",
            "code": "NO_PRICED_MODEL",
        }

    except Exception as e:
        return {
            "result": "DENY",
            "reason": f"routing: {e}",
            "code": "ROUTING_ERROR",
        }


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


# ── Effective attachment (B4/C4) ─────────────────────────────────────────────

# The minimum policy set every rickgent bundle must ATTACH via its top-level
# `guardrails:` block (architecture §7). `blast_radius` is the omnigent builtin;
# the rest are the rickgent shims above. This is the ATTACHMENT contract, read
# from the omnigent static parser — not POLICY_REGISTRY (registration).
REQUIRED_POLICIES = frozenset(
    {
        "blast_radius",
        "scope_fence",
        "completion_evidence",
        "convergence_gate",
        "subtract_before_add",
        "cross_vendor_review",
        "autonomous_pr_flow",
    }
)


def effective_attached_policies(bundle_dir) -> set:
    """Names of the policies ATTACHED to a bundle via its `guardrails:` block.

    The effective attached set is read from the omnigent static parser
    (``omnigent.spec.parser.parse(bundle_dir).guardrails.policies``) — the
    authoritative bundle-declared attachment surface. ``POLICY_REGISTRY``
    membership (registration) is deliberately NOT consulted: registration is
    not attachment (B4/C4). A bundle whose ``guardrails:`` block is absent or
    empty yields an empty set even while the registry is fully populated.
    """
    from omnigent.spec.parser import parse

    spec = parse(Path(bundle_dir))
    guardrails = getattr(spec, "guardrails", None)
    if guardrails is None:
        return set()
    return {policy.name for policy in (guardrails.policies or [])}
