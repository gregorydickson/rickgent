"""A-SEC-3 (detection side) — scope_fence shell-mediated write detection.

Fulfills VAL-SEC-027..035 and VAL-SEC-057 (architecture §6.2 decision):
the fence must DENY shell-mediated writes whose resolved target is
out-of-scope or cannot be positively resolved (interpreter one-liners,
git apply/am, tar/unzip/ln, truncate/chmod/chown), fail closed on
unresolvable targets, stop false-DENYing read-only redirects (2>&1), and
cover every shell tool-name variant so the fence never fails open for a
non-claude harness.
"""

import pytest
from rickgent_policies import scope_fence


CONFIG = {"ticket_id": "T1", "declared_paths": ["declared/"]}


def shell_event(cmd, tool="Bash"):
    """A tool_call event for a shell tool carrying a command string."""
    return {"tool_name": tool, "arguments": {"command": cmd}}


# VAL-SEC-027 — python3 -c writer is DENIED (the `python3` variant, not just `python`)
def test_python3_dash_c_writer_denied():
    result = scope_fence(shell_event("python3 -c \"open('/etc/x','w')\""), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-028 — perl -e / ruby -e / php -r one-liner writers are DENIED
@pytest.mark.parametrize("cmd", [
    "perl -e 'open(F,\">\",\"/etc/x\");print F 1'",
    "ruby -e 'File.write(\"/etc/x\",\"1\")'",
    "php -r 'file_put_contents(\"/etc/x\",\"1\");'",
])
def test_interpreter_one_liner_writers_denied(cmd):
    result = scope_fence(shell_event(cmd), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-029 — git apply / git am patch-writers are DENIED
@pytest.mark.parametrize("cmd", ["git apply e.patch", "git am < e.patch"])
def test_git_patch_writers_denied(cmd):
    result = scope_fence(shell_event(cmd), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-030 — tar / unzip / ln extractors and linkers are DENIED
@pytest.mark.parametrize("cmd", [
    "tar xf a -C /",
    "unzip a.zip -d /",
    "ln -sf / declared/root",
])
def test_archive_and_link_writers_denied(cmd):
    result = scope_fence(shell_event(cmd), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-031 — truncate / chmod / chown attribute+size mutators are DENIED
@pytest.mark.parametrize("cmd", ["truncate -s0 f", "chmod 777 x", "chown root x"])
def test_attribute_mutators_denied(cmd):
    result = scope_fence(shell_event(cmd), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-032 — an unresolvable write target fails closed to DENY
def test_unresolvable_write_target_denied():
    result = scope_fence(shell_event("cat >>$UNKNOWN"), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-033 — read-only redirects are NOT false-DENIED
@pytest.mark.parametrize("cmd", ["pytest 2>&1", "grep '>' file.txt"])
def test_read_only_redirects_not_denied(cmd):
    result = scope_fence(shell_event(cmd), CONFIG)
    assert result is None or result["result"] != "DENY"


# VAL-SEC-034 — capitalized `Shell` (Cursor-style) tool-name does not fail open
def test_shell_capitalized_tool_name_denied():
    result = scope_fence(shell_event("truncate -s0 /etc/x", tool="Shell"), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-035 — lowercase `shell` (Pi-style) tool-name does not fail open
def test_shell_lowercase_tool_name_denied():
    result = scope_fence(shell_event("chmod 777 /etc/x", tool="shell"), CONFIG)
    assert result["result"] == "DENY"


# VAL-SEC-057 — Claude-style `Bash` / `bash` tool-name variants do not fail open
@pytest.mark.parametrize("tool", ["Bash", "bash"])
def test_bash_tool_name_variants_denied(tool):
    result = scope_fence(shell_event("chown root /etc/x", tool=tool), CONFIG)
    assert result["result"] == "DENY"


# Regression: a genuinely read-only shell command still ALLOWs.
def test_read_only_shell_command_allowed():
    result = scope_fence(shell_event("ls -la declared/"), CONFIG)
    assert result["result"] == "ALLOW"
