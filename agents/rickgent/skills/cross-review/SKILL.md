---
name: cross-review
description: Cross-vendor code review — a different-vendor reviewer reviews every PR.
---

When running a cross-vendor review:

1. Identify the implementer's vendor from session labels.
2. Dispatch a reviewer using a DIFFERENT vendor/harness.
3. The reviewer checks for logic errors, design flaws, and spec violations.
4. Produce a review artifact with findings or explicit approval.
5. The cross_vendor_review policy DENIES same-vendor review (AC-13).
