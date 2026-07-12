---
name: prd-refine
description: PRD interview and 3-analyst refinement with atomic ticket decomposition.
---

When asked to create or refine a PRD:

1. Interview the user for the feature goal, constraints, and acceptance criteria.
2. Every acceptance criterion must have a machine-checkable verify command and a scope.
3. Run a 3-analyst refinement: dispatch three sub-agents (explorer, critic, simplifier) to review the PRD.
4. Decompose into atomic tickets: each ticket < 30 min, < 5 files, < 4 ACs.
5. Require a simplification review (subtract before you add).
6. Output machine-checkable AC JSON accepted by `rickgent_prd_validate`.
