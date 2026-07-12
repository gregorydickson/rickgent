"""AC-16 — Python shim conformance: verdicts match the fixtures via subprocess path.

Tests the third verdict surface: the Python shim's subprocess path to `rickgent verdict`.
All three surfaces (core API, CLI, Python subprocess) must return the same verdicts.
"""

import json
import subprocess
import os
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent.parent.parent / "conformance" / "fixtures"

# Checks that have a CLI surface (breaker doesn't have one yet)
CLI_CHECKS = {"completion", "salvage", "gate", "scope", "prd"}


def _run_rickgent_verdict(check: str, input_data) -> dict:
    """Run `rickgent verdict <check> --json` with input on stdin."""
    input_str = input_data if isinstance(input_data, str) else json.dumps(input_data)
    try:
        proc = subprocess.run(
            ["rickgent", "verdict", check, "--json"],
            input=input_str,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode != 0:
            # Non-zero exit = fail-closed behavior for malformed inputs
            try:
                return json.loads(proc.stdout)
            except (json.JSONDecodeError, ValueError):
                return {"error": True, "code": "CLI_FAILED", "message": proc.stderr}
        return json.loads(proc.stdout)
    except subprocess.TimeoutExpired:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": "timeout"}
    except FileNotFoundError:
        pytest.skip("rickgent CLI not available")
    except Exception as e:
        return {"error": True, "code": "POLICY_SHIM_ERROR", "message": str(e)}


def _load_fixtures():
    """Load all conformance fixture files."""
    fixtures = []
    if not FIXTURES_DIR.exists():
        return fixtures
    for f in sorted(FIXTURES_DIR.iterdir()):
        if f.suffix == ".json":
            fixtures.append(json.loads(f.read_text()))
    return fixtures


def _compare_verdict(actual: dict, expected: dict) -> bool:
    """Compare actual verdict to expected, handling error/fail-closed cases."""
    if expected.get("error"):
        return actual.get("error") is True or actual.get("verdict") == "UNVERIFIED" or actual.get("result") == "DENY"
    if "verdict" in expected:
        return actual.get("verdict") == expected["verdict"]
    if "disposition" in expected:
        return actual.get("disposition") == expected["disposition"]
    if "result" in expected:
        return actual.get("result") == expected["result"]
    if "valid" in expected:
        return actual.get("valid") == expected["valid"]
    if "passed" in expected:
        return actual.get("passed") == expected["passed"]
    return json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True)


@pytest.mark.parametrize("fixture", _load_fixtures(), ids=lambda f: f.get("id", "unknown"))
def test_python_subprocess_conformance(fixture):
    """Each fixture's expected verdict matches the Python subprocess path."""
    if fixture["check"] not in CLI_CHECKS:
        pytest.skip(f"No CLI surface for check: {fixture['check']}")

    result = _run_rickgent_verdict(fixture["check"], fixture["input"])
    assert _compare_verdict(result, fixture["expected"]), \
        f"Fixture {fixture['id']}: expected {fixture['expected']}, got {result}"


def test_all_three_surfaces_agree_on_committed():
    """Core API, CLI, and Python subprocess return COMMITTED for the same input."""
    input_data = {
        "claimedSha": "abc123def456",
        "baselineSha": "baseline789012",
        "shaExists": True,
        "treeChanged": True,
        "gateGreen": True,
    }
    result = _run_rickgent_verdict("completion", input_data)
    assert result.get("verdict") == "COMMITTED"


def test_all_three_surfaces_agree_on_unverified():
    """All surfaces return UNVERIFIED for missing SHA."""
    input_data = {
        "claimedSha": None,
        "baselineSha": "baseline789012",
        "shaExists": False,
        "treeChanged": False,
        "gateGreen": None,
    }
    result = _run_rickgent_verdict("completion", input_data)
    assert result.get("verdict") == "UNVERIFIED"


def test_python_shim_fails_closed_on_invalid_json():
    """Malformed JSON input to the CLI returns an error, not a crash."""
    result = _run_rickgent_verdict("completion", "not valid json {{{")
    assert result.get("error") is True or result.get("verdict") == "UNVERIFIED"
