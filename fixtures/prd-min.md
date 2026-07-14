# Minimal PRD — Build-Loop Fixture

## Title: Minimal Fixture Feature

## Description
A minimal PRD used to validate the `rickgent build` loop end-to-end against the
deterministic fixture omnigent. One acceptance criterion, one ticket, one
declared path — enough to decompose ≥1 ticket and drive a real Dispatcher path.

## Acceptance Criteria

### AC-1: Feature module exists
- **verifyCommand:** `grep -r "feature" src/`
- **scope:** `src/feature.ts`
- **type:** grep

## Simplification Review
- Reviewed: yes
- Notes: A single pure function in one file. No abstraction, no extra classes.

## Tickets

### Ticket 1: Implement the feature module
- **description:** Create src/feature.ts exporting the feature function
- **acceptanceCriteria:** AC-1
- **declaredPaths:** `src/feature.ts`
