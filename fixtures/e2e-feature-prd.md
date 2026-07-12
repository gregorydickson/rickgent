# E2E Feature PRD — Rickgent v0.1.0-alpha Demo

## Title: Math and String Utility Library

## Description
Add math utilities (add, multiply, factorial) and string utilities (reverse, capitalize, truncate) to a fixture TypeScript app, with tests for each.

## Acceptance Criteria

### AC-1: Math utilities work correctly
- **verifyCommand:** `pnpm test -- math.test.ts`
- **scope:** `src/math.ts`, `test/math.test.ts`
- **type:** test

### AC-2: String utilities work correctly  
- **verifyCommand:** `pnpm test -- string.test.ts`
- **scope:** `src/string.ts`, `test/string.test.ts`
- **type:** test

### AC-3: All exports are typed
- **verifyCommand:** `npx tsc --noEmit`
- **scope:** `src/`
- **type:** lint

### AC-4: No lint errors
- **verifyCommand:** `npx eslint src/ --max-warnings=0`
- **scope:** `src/`
- **type:** lint

### AC-5: API endpoint exists
- **verifyCommand:** `grep -r "export.*apiHandler" src/`
- **scope:** `src/api.ts`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: Each utility is a single pure function. No over-abstraction. No unnecessary classes.

## Tickets

### Ticket 1: Implement math utilities
- **description:** Create src/math.ts with add(a,b), multiply(a,b), factorial(n) functions
- **estimatedMinutes:** 15
- **estimatedFiles:** 2
- **acceptanceCriteria:** AC-1
- **declaredPaths:** `src/math.ts`, `test/math.test.ts`

### Ticket 2: Implement string utilities
- **description:** Create src/string.ts with reverse(s), capitalize(s), truncate(s, n) functions
- **estimatedMinutes:** 15
- **estimatedFiles:** 2
- **acceptanceCriteria:** AC-2
- **declaredPaths:** `src/string.ts`, `test/string.test.ts`

### Ticket 3: Add API endpoint
- **description:** Create src/api.ts with an apiHandler that uses math and string utilities
- **estimatedMinutes:** 20
- **estimatedFiles:** 1
- **acceptanceCriteria:** AC-5
- **declaredPaths:** `src/api.ts`

### Ticket 4: Add type annotations
- **description:** Ensure all exports have explicit TypeScript types
- **estimatedMinutes:** 10
- **estimatedFiles:** 3
- **acceptanceCriteria:** AC-3
- **declaredPaths:** `src/math.ts`, `src/string.ts`, `src/api.ts`

### Ticket 5: Fix lint issues
- **description:** Run eslint and fix any issues in src/
- **estimatedMinutes:** 10
- **estimatedFiles:** 3
- **acceptanceCriteria:** AC-4
- **declaredPaths:** `src/math.ts`, `src/string.ts`, `src/api.ts`
