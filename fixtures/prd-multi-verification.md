# Multi-Verification PRD — Build-Loop Fixture

## Title: Multi-Verification Fixture Feature

## Description
A minimal PRD with TWO declared verifications per acceptance criterion, used to
validate that the verification provider iterates ALL sealed contract
verification IDs (not just `verifications[0]`). One ticket, one declared path,
two verifications — enough to prove the oracle sees the complete sorted set of
gate results.

## Acceptance Criteria

### AC-1: Feature module exists and passes two verifications
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-FEATURE-01","executable":"grep","args":["-r","feature","src/"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]},{"id":"VERIFY-FEATURE-02","executable":"node","args":["--version"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/feature.ts`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: A single pure function in one file with two declared verifications. No abstraction, no extra classes.

## Tickets

### Ticket 01: Implement the feature module
- **description:** Create src/feature.ts exporting the feature function
- **dependsOn:** `[]`
- **scope:** `[{"path":"src/feature.ts","change_kind":"create","directory":false}]`
- **interfaces:** `[]`
- **acceptanceCriteria:** `["AC-1"]`
- **budgets:** `{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}`
