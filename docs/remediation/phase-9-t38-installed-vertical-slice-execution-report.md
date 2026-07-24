# Phase 9 t38 installed vertical-slice execution report

## Result

Two protected installed crash-resume logical runs were executed and retained, and their
owned hosted resources were cleaned. Milestone t38 remains **Todo** because the retained
compact proof does not derive the complete lifecycle or independently observe provider
identity. The strict validator rejects this unsupported Done claim.

Evidence commit `083567e6fe918c9191427fc292cde0e0dcaa453f` contains the canonical
receipt, exact-byte SHA-256 sidecar, and clear execution diagnostics. The implementation
commit containing this report and the fail-closed validators is the commit recorded by
the ticket lifecycle.

## Immutable bindings

- t37 source OID: `d83405ee20e2cb8c5a9418c8913d646e876269bc`
- installed build: `a6525b76631e880f852d358bdf8a03b61f135fe4`
- npm archive: `642512459c175bf0f566d37676512b77ae6e9b88f928d9ef239a56bf37d9edf7`
- wheel archive: `0eb851486e8966c5509d53172b3491e6daa1bc836b9255c267863fa3d82e72f0`
- Omnigent compatibility contract: `d1db539f7c602db8750a7187a3f74fee5ae46386d4f4a05df9c94fba13604b64`
- packed-install receipt: `2dd3587120acf8f909fbbfb23607648225212ce7eb7ada28e8c219736a3db058`
- accepted preflight: `4efa707ad8e505ce12e2cb393ffab6740ec38a81eb4d4850d08565ae53e73b10`
- immutable GitHub repository ID: `1310051293`

Both runs used the same exact installed production CLI under the digest-keyed handoff
and explicit per-run SQLite/state roots plus the installed Omnigent and Python roots.
Those absolute runtime roots remain only in protected durable execution state and are
not copied into the redacted public report.

## Retained chronology

| Run | Crash attempt / PID | Resume attempt / PID | Persistent state | Delivery / PR |
| --- | --- | --- | --- | --- |
| `protected-1` | `protected-1:crash` / `55701` | `protected-1:resume` / `55935` | `state-protected-1` | `8ee2d1b4576b839b70b638a65a995e74b1c12383` / `1` |
| `protected-2` | `protected-2:crash` / `56621` | `protected-2:resume` / `56918` | `state-protected-2` | `7cfccef0534077f78dc480fcc6e17a6bbd4478c1` / `2` |

Each crash process group was observed dead after its durable checkpoint. Each fresh
resume process retained the logical run and persistent-state identity. The SQLite
databases retain one crash row and one resume row for each run, bound to the respective
implementation and review bundle digests. Run 1 ended before Run 2 began.

The runner invoked Codex non-interactively with `gpt-5.6-sol` and Claude read-only with
`claude-opus-4-8[1m]`. The receipt binds distinct dispatch, conversation, process, and
bundle digests. However, `observed_model` was assigned from the requested model rather
than parsed from independent provider identity evidence, so model identity is not
claimed as derived.

## Hosted effects and cleanup

The receipt records one branch, one delivery OID, and one pull request per logical run.
For both runs the created branch OID, delivery OID, pull-request head OID, and
compare-before-delete OID are equal. The branches were absent after deletion, both
owned pull requests were closed, and the repository was preserved. The read-only
cleanup verifier pins repository ID `1310051293`, re-reads only the two receipt-owned
pull requests, requires exactly one PR for each owned head/base pair, and confirms both
exact owned branch refs are absent. It performs no mutation.

## Fail-closed gap

The receipt mirrors nine protected corpus file digests, but the execution controller
does not retain independently derived records for native-policy enforcement,
worktree/ref/index/lease/process ownership, scope-clean commit, substantive review and
remediation, blocking gates, oracle completion, or exactly-once hosted operations.
`lifecycle_complete`, provider observations, and duplicate-side-effect fields are
assertions, not conclusions derived from that missing phase corpus. The declared
failure-path cleanup is likewise not backed by an executed failure lifecycle.

Accordingly, the strict validator requires separate per-run identity evidence and a
per-run record for every protected phase. It rejects corpus digests as a substitute.
The clear diagnostics preserve the successful crash-resume evidence; validation
failure does not overwrite it. The trust-spine t38 row is intentionally unchanged and
must not transition to Done until a later execution commits the missing derivations,
passes independent cleanup observation and redaction scanning, and records its output
commit.
