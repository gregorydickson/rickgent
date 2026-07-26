# Phase 9 t38 installed vertical-slice execution report

## Result

Two protected installed crash-resume logical runs completed and passed the strict
vertical-slice validator. The canonical receipt, exact-byte checksum, and clear failure
diagnostics are retained together in the t38 evidence commit.

The receipt is bound to the accepted t38b preflight, exact t37 npm and wheel archives,
installed build, compatibility contract, immutable private GitHub repository, and full
protected proof corpus.

## Retained chronology

| Run | Crash PID | Resume PID | Persistent state | Delivery OID | Success PR | Failure-cleanup PR |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| `protected-1` | `39028` | `39357` | `state-protected-1` | `2388ab987201c3bcaf7707b2f39ff8ff6defd619` | `31` | `32` |
| `protected-2` | `44465` | `47905` | `state-protected-2` | `f663ec19f733ee621a0f2f5a506316a7017b07dd` | `33` | `34` |

Each crash worker invoked the exact installed CLI and authenticated Codex
`gpt-5.6-sol`, persisted its implementation bundle in SQLite, exposed a durable
checkpoint, and was killed as an isolated process group. Each fresh resume worker kept
the same run and persistent-state identities, invoked the same installed CLI, and
performed an authenticated read-only Claude `claude-opus-4-8[1m]` review.

## Derived evidence

Each run retains:

- nine mirrored proof-corpus digests;
- separate model-dispatch and independently observed provider-identity evidence for
  OpenAI and Anthropic, including the Codex app-server's effective model/provider,
  exact thread and turn IDs, provider PID, attempt PID, and identity digest;
- sixteen derived lifecycle phase records covering native-policy allow/deny,
  ownership, worktree, ref, index, compare-and-swap lease, process topology,
  scope-clean commit, review, clean remediation outcome, gate, oracle, cleanup, push,
  pull request, and delivery OID.

The controller derives the local Git ownership records from a real contained worktree,
isolated index, owned ref, and compare-and-swap promotion. It derives hosted records
from live immutable GitHub observations rather than receipt assertions.

## Hosted effects and cleanup

Each logical run created one success-path branch and pull request plus one deliberate
post-PR failure probe with its own branch and pull request. Within each run, all created
branch OIDs, observed branch OIDs, pull-request head OIDs, delivery OIDs, and cleanup
comparison OIDs were equal.

Run 1 cleanup completed before Run 2 began. All four pull requests were closed, all four
exact owned branches were compare-before-delete removed, and independent requery
confirmed the repository was preserved and the owned namespace was empty. Historical closed proof PRs
do not count as duplicate current effects; the controller requires exactly one open PR
during each run, and the cleanup verifier requires none afterward while pinning the
receipt-owned PR ID and OID.

## Verification

The retained evidence passed:

```text
node orchestrator/scripts/validate-vertical-slice-receipt.mjs artifacts/reliability/vertical-slice-receipt.json --packed-receipt artifacts/reliability/packed-install-summary.json --preflight artifacts/reliability/protected-release-preflight.json
node orchestrator/scripts/scan-release-evidence.mjs artifacts/reliability/vertical-slice-receipt.json artifacts/reliability/vertical-slice-failure-diagnostics.json
node orchestrator/scripts/verify-remote-cleanup.mjs --receipt artifacts/reliability/vertical-slice-receipt.json
git diff --check
```
