---
name: anatomy-park
description: Three-phase deep subsystem review with trap door cataloging.
---

When running a subsystem review:

Phase 1 — Discovery:
1. Discover subsystems touched by the diff.
2. Map cross-subsystem interfaces.

Phase 2 — Deep Review:
3. Review each subsystem for interface mismatches.
4. Catalog trap doors (invariants that must be preserved).
5. Check for cross-subsystem regressions.

Phase 3 — Report:
6. Produce findings or an explicit no-finding report tied to file:line evidence.
