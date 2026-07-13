"""A-SEC-3 (fix) — scope_fence nested `-c` extraction is flag-order agnostic.

`_nested_shell_c_argument` originally extracted the nested command only when
`c` was the TRAILING char of a short-flag bundle (`-ec`), so `bash -ce 'echo x
> out.txt'` (c non-trailing) fell through and the redirect escaped detection —
a fail-open. The fence now treats a nested shell's `-c` as consuming the
following token as the command string whenever `c` appears ANYWHERE in a
combined short-flag bundle (`-ce`, `-ec`, `-ic`, `-eic`, …), then recursively
evaluates that string for writes. A read-only nested command is not
false-DENIED regardless of flag order.

Tests drive the real `scope_fence` entrypoint across every shell tool-name
variant, authored red-first (they FAIL against the trailing-`c`-only handling).
"""

import pytest
from rickgent_policies import scope_fence


CONFIG = {"ticket_id": "T1", "declared_paths": ["declared/"]}

SHELL_TOOLS = ["sys_os_shell", "Bash", "bash", "Shell", "shell"]


def shell_event(cmd, tool="Bash"):
    return {"tool_name": tool, "arguments": {"command": cmd}}


# A write nested inside a combined short-flag bundle where `c` is NOT the
# trailing char (`-ce`, `-ceux`, …) must still be detected → DENY.
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    "bash -ce 'echo x > out.txt'",
    "sh -ec 'truncate -s0 f'",
    "bash -ce 'truncate -s0 f'",
    "sh -ce 'echo x >> out.txt'",
    "zsh -ce 'chmod 777 /etc/x'",
    "dash -ce 'echo x > out.txt'",
    "bash -ceux 'echo x > out.txt'",
    "sh -eic 'git apply e.patch'",
    "bash -ce 'ls && truncate -s0 f'",
    "sudo -u root bash -ce 'echo x > out.txt'",
])
def test_nested_shell_flag_order_write_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is not None and result["result"] == "DENY"


# A provably read-only nested command must NOT be false-DENIED, regardless of
# where `c` sits in the flag bundle.
@pytest.mark.parametrize("tool", SHELL_TOOLS)
@pytest.mark.parametrize("cmd", [
    "bash -ce 'ls'",
    "sh -ec 'cat f'",
    "zsh -ce 'grep foo file.txt'",
    "bash -ceux 'pytest 2>&1'",
    "sh -eic 'ls -la'",
])
def test_nested_shell_flag_order_read_only_not_denied(tool, cmd):
    result = scope_fence(shell_event(cmd, tool=tool), CONFIG)
    assert result is None or result["result"] != "DENY"
