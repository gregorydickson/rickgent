"""A-SEC-3 (fix) — scope_fence recursive nested `sh -c`/`bash -c` write detection.

A write nested inside a quoted `-c` argument of a nested shell invocation
(`sudo -u root sh -c "echo x > out.txt"`, `bash -c 'truncate -s0 f'`) was
treated as an inert quoted literal and the redirect/write escaped detection —
a fail-open. The fence now recursively evaluates the `-c` argument with the
existing write-detection (redirects, interpreter one-liners, write utilities,
disk-mutating git subcommands) and DENYs when the nested command writes, while
NOT false-DENYing a provably read-only nested `-c` string (`sh -c "ls -la"`).

Fulfills VAL-SEC-060 (architecture §6.2 fail-closed decision). Tests drive the
real `scope_fence` entrypoint across every shell tool-name variant.
"""

import pytest
from rickgent_policies import scope_fence


CONFIG = {"ticket_id": "T1", "declared_paths": ["declared/"]}

SHELL_TOOLS = ["sys_os_shell", "Bash", "bash", "Shell", "shell"]


def shell_event(cmd, tool="Bash"):
    return {"tool_name": tool, "arguments": {"command": cmd}}


# A write nested inside a `-c` argument must be recursively detected → DENY.
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    'sudo -u root sh -c "echo x > out.txt"',
    "bash -c 'truncate -s0 f'",
    "zsh -c 'echo x >> out.txt'",
    'sh -ec "echo x > out.txt"',
    "bash -c 'chmod 777 /etc/x'",
    "sh -c 'git apply e.patch'",
    "sh -c \"python3 -c \\\"open('/etc/x','w')\\\"\"",
    "bash -c 'ls && truncate -s0 f'",
    "dash -c 'echo x > out.txt'",
])
def test_nested_shell_write_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is not None and result["result"] == "DENY"


# A provably read-only nested `-c` string must NOT be false-DENIED.
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    'sh -c "cat f"',
    "bash -c 'ls -la'",
    "zsh -c 'grep foo file.txt'",
    "sh -c 'pytest 2>&1'",
])
def test_nested_shell_read_only_not_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is None or result["result"] != "DENY"
