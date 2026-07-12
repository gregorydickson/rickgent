---
name: citadel
description: Conformance audit — run each AC's verify command against branch diff.
---

When running a conformance audit:

1. For each acceptance criterion, run its verify command.
2. Check the branch diff for spec violations.
3. Catalog trap doors (invariants that must be preserved).
4. Classify findings as mechanical or substantive.
5. Write a report artifact with pass/fail per AC.
