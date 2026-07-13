---
name: cronenberg
description: Meta-router — deterministic decision matrix for task routing.
---

When invoked with a build/implement request:

1. Parse signals: PRD present, measurable metric, ticket count, multi-stage, stack review.
2. Apply the refine decision matrix (first-match-wins).
3. Pick the metaphor (pipeline, microverse, council-of-ricks).
4. Pick followups (citadel, anatomy-park, szechuan) based on risk signals.
5. Emit a deterministic route decision from fixed task-shape inputs.
6. Output: { refine: boolean, metaphor: string, followups: string[] }.

## Followup auto-chaining

Followups auto-chain sequentially once the one-shot returns. Omnigent one-shots
block until completion, so followups auto-chain sequentially on one-shot exit,
halting on a non-zero exit. Do not print followups for manual copy — execute
them in order, aborting the chain at the first failure.
