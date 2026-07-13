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
import shlex
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


def _resolve_endpoint(root: str, rel: str) -> str:
    """Resolve a root-relative path to its canonical real form.

    `os.path.realpath` follows symlinks in the existing portion and re-appends
    the non-existent tail (a not-yet-created write target) onto the realpath of
    the nearest existing parent — the parity of the TS `realpathNearestExisting`.
    """
    return os.path.realpath(os.path.join(root, rel))


def check_scope_resolved(root, declared_paths, target_path, is_write, destination_path=None):
    """Filesystem-aware scope check with parity to the TS `checkScopeResolved`.

    Resolves symlinks (both source and destination endpoints for rename/link
    ops) and not-yet-created write paths via the nearest existing parent, then
    DENYs any endpoint whose real target escapes the declared set. Fails closed
    on malformed input. Pins TS↔Python parity on the shared symlink fixtures.
    """
    if not isinstance(root, str) or not root:
        return {"result": "DENY", "reason": "unresolvable worktree root", "code": "SCOPE_DENIED"}

    if is_write is not True and is_write is not False:
        return {"result": "DENY", "reason": "invalid isWrite field", "code": "SCOPE_DENIED"}
    if is_write is not True:
        return {"result": "ALLOW"}

    declared = [d for d in (declared_paths or []) if isinstance(d, str) and d]

    endpoints = []
    if isinstance(target_path, str) and target_path:
        endpoints.append(("target", target_path))
    if isinstance(destination_path, str) and destination_path:
        endpoints.append(("destination", destination_path))
    if not endpoints:
        return {"result": "DENY", "reason": "unresolvable write target", "code": "SCOPE_DENIED"}

    resolved_declared = [_resolve_endpoint(root, d) for d in declared]

    for label, rel in endpoints:
        resolved_target = _resolve_endpoint(root, rel)
        if not any(_is_path_in_scope(resolved_target, d) for d in resolved_declared):
            return {
                "result": "DENY",
                "reason": f"{label} {rel} resolves outside declared paths",
                "code": "SCOPE_DENIED",
            }

    return {"result": "ALLOW"}


# Every shell/write tool-name variant across harnesses. The fence must cover
# all of them or it fails open for a non-`claude` harness (Cursor `Shell`,
# Pi `shell`, Claude `Bash`/`bash`, Omnigent `sys_os_shell`).
_SHELL_TOOL_NAMES = {"sys_os_shell", "Bash", "bash", "Shell", "shell"}
_STRUCTURED_WRITE_TOOLS = {
    "Write", "Edit", "MultiEdit", "sys_os_write", "sys_os_edit", "write", "edit",
}

# Interpreters that can write disk via an inline-code-eval flag.
_INTERPRETER_EVAL_FLAGS = {
    "python": {"-c"},
    "python3": {"-c"},
    "python2": {"-c"},
    "perl": {"-e", "-E"},
    "ruby": {"-e"},
    "php": {"-r"},
    "node": {"-e", "-p", "--eval", "--print"},
    "nodejs": {"-e", "-p", "--eval", "--print"},
}

# Utilities that create/replace/mutate files or filesystem attributes. `tar`
# and `dd` are ambiguous (read or write) so they are treated as writes to
# fail closed.
_WRITE_UTILITIES = {
    "tee", "cp", "mv", "rm", "mkdir", "rmdir", "install", "rsync", "touch",
    "truncate", "chmod", "chown", "chgrp", "ln", "dd", "tar", "unzip",
    "gunzip", "gzip", "patch", "sponge",
}

# git subcommands that mutate the working tree / index on disk.
_GIT_WRITE_SUBCOMMANDS = {
    "apply", "am", "checkout", "restore", "clean", "stash", "mv", "rm",
    "init", "reset",
}


def _strip_quoted(s: str) -> str:
    """Remove single/double-quoted regions so quoted redirect characters
    (e.g. `grep '>' file`) are not mistaken for shell redirects."""
    s = re.sub(r"'[^']*'", "", s)
    s = re.sub(r'"[^"]*"', "", s)
    return s


def _has_file_write_redirect(command: str) -> bool:
    """True iff the command contains a `>`/`>>` redirect to a FILE.

    fd-duplications such as `2>&1` / `>&2` (a `>` whose next non-space char is
    `&`) are NOT file writes and must not be flagged.
    """
    unquoted = _strip_quoted(command)
    return bool(re.search(r"\d*>>?\s*(?![&\s])\S", unquoted))


def _strip_shell_prefix_tokens(tokens: list) -> list:
    """Drop leading `VAR=val` env-assignments and a `sudo [flags]` prefix."""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            i += 1
            continue
        if tok == "sudo":
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 1
            continue
        break
    return tokens[i:]


def _git_subcommand_writes(rest: list) -> bool:
    """True iff a git invocation's subcommand mutates disk (skips globals)."""
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok.startswith("-"):
            if "=" in tok:
                i += 1
            elif tok in _GIT_VALUE_OPTS:
                i += 2
            else:
                i += 1
            continue
        return tok in _GIT_WRITE_SUBCOMMANDS
    return False


def _shell_command_writes(command: str) -> bool:
    """Best-effort detection of a disk-writing shell command.

    Covers file-write redirects, interpreter one-liners, patch/archive/link
    utilities, and attribute mutators. A read-only command (no redirect, no
    write utility) returns False.
    """
    if not command or not command.strip():
        return False
    if _has_file_write_redirect(command):
        return True
    for segment in re.split(r"\|\||&&|;|\||&|\n", command):
        seg = segment.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            tokens = seg.split()
        tokens = _strip_shell_prefix_tokens(tokens)
        if not tokens:
            continue
        cmd = os.path.basename(tokens[0])
        rest = tokens[1:]
        if cmd in _WRITE_UTILITIES:
            return True
        if cmd == "sed" and any(a == "-i" or a.startswith("-i") for a in rest):
            return True
        eval_flags = _INTERPRETER_EVAL_FLAGS.get(cmd)
        if eval_flags and any(a in eval_flags for a in rest):
            return True
        if cmd == "git" and _git_subcommand_writes(rest):
            return True
        if cmd in ("npm", "pnpm", "yarn", "pip", "pip3") and "install" in rest:
            return True
    return False


def _extract_shell_command(event):
    """Pull the command string from a shell tool_call event, or None."""
    args = event.get("arguments", {})
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    if isinstance(args, dict):
        cmd = args.get("command")
        if isinstance(cmd, str):
            return cmd
    top = event.get("command")
    if isinstance(top, str):
        return top
    return None


def scope_fence(event, config):
    """Enforcement surface for write-path scope checking.

    Fires on every write tool call. Mechanical path canonicalization —
    parity with the TS core's scope module pinned by shared AC-10 fixtures.
    """
    try:
        # Only check write operations
        tool_name = event.get("tool_name", "")
        if tool_name not in _SHELL_TOOL_NAMES and tool_name not in _STRUCTURED_WRITE_TOOLS:
            return {"result": "ALLOW"}

        # Shell tools: the concrete write target cannot be positively resolved
        # from an arbitrary command string, so any detected write fails closed
        # to DENY (architecture §6.2). Read-only commands (incl. `2>&1` fd-dups
        # and quoted `>`) are not writes and pass through.
        if tool_name in _SHELL_TOOL_NAMES:
            command = _extract_shell_command(event)
            if command is None:
                return {
                    "result": "DENY",
                    "reason": "scope fence: unresolvable shell write target (no command)",
                    "code": "SCOPE_DENIED",
                }
            if not _shell_command_writes(command):
                return {"result": "ALLOW"}
            return {
                "result": "DENY",
                "reason": "scope fence: unresolvable shell write target",
                "code": "SCOPE_DENIED",
            }

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


# git global options that consume a following value token (`git -C dir push …`).
_GIT_VALUE_OPTS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--super-prefix", "--exec-path",
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


def _tokenize(segment: str) -> list:
    """Tokenize a single segment, then strip leading env-assignments and sudo.

    Falls back to a whitespace split when shlex cannot parse the segment so
    detection stays conservative (a garbled push is still recognized as a push).
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):  # FOO=bar prefix
            i += 1
            continue
        if tok == "sudo":
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
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
    `git push origin HEAD:<own-branch>` with no extra flags or global options."""
    if not feature_branch:
        return False
    tokens = _tokenize(segment)
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
