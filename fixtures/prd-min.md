# Minimal PRD — Build-Loop Fixture

## Title: Minimal Fixture Feature

## Description
A minimal PRD used to validate the `rickgent build` loop end-to-end against the
deterministic fixture omnigent. One acceptance criterion, one ticket, one
declared path — enough to decompose ≥1 ticket and drive a real Dispatcher path.

## Acceptance Criteria

### AC-1: Feature module exists
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-FEATURE-01","executable":"grep","args":["-r","feature","src/"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/feature.ts`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: A single pure function in one file. No abstraction, no extra classes.

## Tickets

### Ticket 01: Implement the feature module
- **description:** Create src/feature.ts exporting the feature function
- **dependsOn:** `[]`
- **scope:** `[{"path":"src/feature.ts","change_kind":"create","directory":false}]`
- **interfaces:** `[]`
- **acceptanceCriteria:** `["AC-1"]`
- **budgets:** `{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}`
