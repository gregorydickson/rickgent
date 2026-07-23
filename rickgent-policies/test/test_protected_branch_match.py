"""A-BUG-6 — protected-branch matching uses exact + slash-prefix rules, not substring.

A bare protected name (`main`, `master`, `dev`, ...) must match ONLY exactly.
A slash-suffixed entry (`release/`) matches by slash-prefix (`release/x`).
Substring/startswith matching wrongly denies `maintenance`, `developer`,
`master-plan`, etc.

The full native policy path is covered by the FunctionPolicy corpus; this file
pins the exact matcher independently.
"""

import pytest

from rickgent_policies import _is_protected


class TestProtectedBranchMatcher:
    """Unit-level: the exact boolean the matcher must return."""

    @pytest.mark.parametrize("dest", ["main", "master", "trunk", "develop", "dev", "release/x"])
    def test_protected_destinations_match(self, dest):
        assert _is_protected(dest) is True, dest

    @pytest.mark.parametrize("dest", ["maintenance", "developer", "master-plan", "development", "trunkline"])
    def test_lookalike_destinations_not_protected(self, dest):
        # substring/startswith false-block: these must NOT match a bare protected name
        assert _is_protected(dest) is False, dest
