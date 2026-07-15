# E2E Feature PRD — Rickgent v0.1.0-alpha Demo

## Title: Math and String Utility Library

## Description
Add math utilities (add, multiply, factorial) and string utilities (reverse, capitalize, truncate) to a fixture TypeScript app, with tests for each.

## Acceptance Criteria

### AC-1: Math utilities work correctly
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-MATH-01","executable":"pnpm","args":["test","--","math.test.ts"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":120000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/math.ts`, `test/math.test.ts`
- **type:** test

### AC-2: String utilities work correctly  
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-STRING-01","executable":"pnpm","args":["test","--","string.test.ts"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":120000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/string.ts`, `test/string.test.ts`
- **type:** test

### AC-3: All exports are typed
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-TYPES-01","executable":"npx","args":["tsc","--noEmit"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":120000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/`
- **type:** lint

### AC-4: No lint errors
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-LINT-01","executable":"npx","args":["eslint","src/","--max-warnings=0"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":120000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/`
- **type:** lint

### AC-5: API endpoint exists
- **interfaceIds:** `[]`
- **verifications:** `[{"id":"VERIFY-API-01","executable":"grep","args":["-r","export.*apiHandler","src/"],"cwd_class":"repository_root","env_allowlist":["PATH"],"timeout_ms":30000,"network":"deny","writable_outputs":[],"expected_exit_codes":[0]}]`
- **scope:** `src/api.ts`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: Each utility is a single pure function. No over-abstraction. No unnecessary classes.

## Tickets

### Ticket 01: Implement math utilities
- **description:** Create src/math.ts with add(a,b), multiply(a,b), factorial(n) functions
- **dependsOn:** `[]`
- **scope:** `[{"path":"src/math.ts","change_kind":"create","directory":false},{"path":"test/math.test.ts","change_kind":"create","directory":false}]`
- **interfaces:** `[]`
- **acceptanceCriteria:** `["AC-1","AC-3","AC-4"]`
- **budgets:** `{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}`

### Ticket 02: Implement string utilities
- **description:** Create src/string.ts with reverse(s), capitalize(s), truncate(s, n) functions
- **dependsOn:** `[]`
- **scope:** `[{"path":"src/string.ts","change_kind":"create","directory":false},{"path":"test/string.test.ts","change_kind":"create","directory":false}]`
- **interfaces:** `[]`
- **acceptanceCriteria:** `["AC-2"]`
- **budgets:** `{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}`

### Ticket 03: Add API endpoint
- **description:** Create src/api.ts with an apiHandler that uses math and string utilities
- **dependsOn:** `["t01","t02"]`
- **scope:** `[{"path":"src/api.ts","change_kind":"create","directory":false}]`
- **interfaces:** `[]`
- **acceptanceCriteria:** `["AC-5"]`
- **budgets:** `{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}`
