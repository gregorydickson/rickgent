---
name: szechuan
description: Deslopping pass — principle-driven review for KISS, DRY, dead code, edge cases.
---

When running a deslopping pass:

1. Review the diff for KISS violations (overcomplicated solutions).
2. Check for DRY violations (duplicated logic).
3. Find dead code (unused exports, unreachable branches).
4. Check edge cases (null/undefined, empty arrays, boundary conditions).
5. Verify encapsulation (leaky abstractions, exposed internals).
6. Check for self-documenting code (unclear naming, missing types).
7. Produce findings or an explicit no-finding report tied to file:line evidence.
