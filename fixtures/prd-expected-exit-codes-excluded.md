# Expected Exit Codes (Excluded) PRD — Build-Loop Fixture

## Title: Expected Exit Codes Excluded Fixture Feature

## Description
A minimal PRD with ONE declared verification per acceptance criterion whose
`expected_exit_codes` allowlist is `[1]` and whose verification command exits
with a code NOT in the allowlist (exit 2). Used to validate that the full
production `runBuildViaRunnerForTesting` path fails closed when the observed
exit is not in the sealed allowlist (`outcome.status !== "succeeded"`).

## Acceptance Criteria

### AC-1: Feature module exists and verification fails closed on excluded exit
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-EXIT-EXCLUDED-01","executable":"node","args":["-e","process.exit(2)"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[1]}]`
- **scope:** `src/feature.ts`
- **type:** test

## Simplification Review
- Reviewed: yes
- Notes: A single pure function in one file with one declared verification that exits 2 (NOT in `expected_exit_codes` `[1]`). No abstraction, no extra classes.

## Tickets

### Ticket 01: Implement the feature module
- **description:** Create src/feature.ts exporting the feature function
- **dependsOn:** `[]`
- **scope:** `[{"path":"src/feature.ts","change_kind":"create","directory":false}]`
- **interfaces:** `[]`
- **acceptanceCriteria:** `["AC-1"]`
- **budgets:** `{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}`
