"""A-SEC-3 (fix) — scope_fence quoted-redirect + sudo value-option bypass.

Two regressions in the shell-write detector:

1. `_strip_quoted` removed a quoted redirect TARGET before redirect detection,
   so `echo hi > "out.txt"` looked like a targetless (non-)redirect and was
   ALLOWed. A `>`/`>>` that appears outside quotes IS a redirect regardless of
   whether its target is quoted; the target of a shell write can never be
   positively resolved, so it must fail closed to DENY. Genuine read-only
   redirects (`2>&1`) and a quoted literal `>` passed as an argument (no
   redirection) must still NOT be DENIED.

2. `_strip_shell_prefix_tokens` consumed `sudo` flags but not their value
   tokens, so `sudo -u root <write-cmd>` left `root` as the command word and
   the real write escaped detection. Reusing `_SUDO_VALUE_OPTS` consumes
   `-u root` so the write behind the prefix is detected and DENIED.

Fulfills VAL-SEC-032 / VAL-SEC-033 (architecture §6.2 fail-closed decision).
Tests drive the real `scope_fence` entrypoint via every shell tool-name variant.
"""

import pytest
from rickgent_policies import scope_fence


CONFIG = {"ticket_id": "T1", "declared_paths": ["declared/"]}

SHELL_TOOLS = ["sys_os_shell", "Bash", "bash", "Shell", "shell"]


def shell_event(cmd, tool="Bash"):
    return {"tool_name": tool, "arguments": {"command": cmd}}


# A write redirect to a quoted target must DENY (unresolvable target, fail closed).
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    'echo hi > "out.txt"',
    "echo hi >> 'out.txt'",
    'echo hi > "declared/out.txt"',
    "cat foo >> 'declared/log'",
])
def test_quoted_redirect_target_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is not None and result["result"] == "DENY"


# Read-only redirects and quoted literal `>` (no redirection) are NOT false-DENIED.
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    "pytest 2>&1",
    "grep '>' file.txt",
    'echo "a > b"',
    "grep --color '>>' notes.txt",
])
def test_read_only_and_quoted_literal_not_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is None or result["result"] != "DENY"


# `sudo -u root <write-cmd>` must not bypass shell-write detection.
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    "sudo -u root truncate -s0 f",
    "sudo -u root chmod 777 /etc/x",
    "sudo --user root chown root /etc/x",
    "sudo -u root git apply e.patch",
])
def test_sudo_value_option_write_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is not None and result["result"] == "DENY"


# A benign sudo command (no write) still ALLOWs after the value-option fix.
def test_sudo_value_option_read_only_allowed():
    result = scope_fence(shell_event("sudo -u root ls -la declared/"), CONFIG)
    assert result["result"] == "ALLOW"
