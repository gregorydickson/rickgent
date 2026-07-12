# Conformance fixture suite — the portable spec.

This directory contains language-neutral JSON fixtures that define the expected
verdicts for the Rickgent verdict core. The same fixtures run against:
1. The in-process TS core API
2. The `rickgent verdict` CLI
3. The Python shim's subprocess path

## Fixture format (§16.4)

Each fixture is one JSON file in `fixtures/`:

```json
{
  "id": "completion-001",
  "check": "completion",
  "input": {
    "claimedSha": "abc123",
    "baselineSha": "def456",
    "shaExists": true,
    "treeChanged": true,
    "gateGreen": true
  },
  "expected": {
    "verdict": "COMMITTED",
    "commitSha": "abc123",
    "treeChanged": true
  },
  "source": "ticket-completion-evidence.ts:821 — evaluateCompletionEvidence"
}
```

Fixtures are extracted in Phase 2 by running the legacy implementations on
synthetic repos and recording their verdicts. Every FOM incident class gets
at least one fixture.
