# Phase 9 t38 authenticated no-mutation preflight report

## Outcome

The protected preflight completed successfully without provider dispatch or hosted mutation. The canonical receipt and checksum are:

- `artifacts/reliability/protected-release-preflight.json`
- `artifacts/reliability/protected-release-preflight.sha256`

The receipt passed the dedicated schema validator and the independent evidence scanner.

## Exact installation handoff

The preflight revalidated the t37 npm tarball and Python wheel against the packed-install receipt, then created a digest-keyed persistent installation under a proof-owned temporary root. The installed CLI reported build `a1fe32a3dcb1950a61db82e5985ac141f4024583`. The receipt binds hashes for the installed CLI, manager, worker, and policy package, plus the observed Omnigent Git identity.

Wheel installation is offline and dependency-free: Omnigent is supplied by the separately observed local compatibility root rather than resolved from a package index.

## Authentication and immutable observations

Bounded, non-interactive status checks confirmed:

- Codex authentication for the `gpt-5.6-sol` test role
- Claude authentication for the `claude-opus-4-8[1m]` review role
- the allowlisted GitHub owner and repository identity
- the immutable repository ID and configured base branch
- the absence of the deterministic proof branch and matching open pull request

Only digests and contract fields are retained. Raw authentication output, tokens, provider transcripts, prompts, and absolute user paths are excluded.

## No-mutation boundary

The preflight did not invoke either provider, create a branch or pull request, push a commit, delete a repository, or alter provider state. Provider state was independently snapshotted before and after the observations and remained unchanged.

Hosted branch and pull-request state was queried once by the preflight producer. That observation is retained as both the before and after hosted snapshot, so equality validates the receipt's no-mutation boundary but is not evidence of two independently timed hosted queries. The receipt also records an empty mutation list and `provider_dispatch_observed: false`; it does not claim a model invocation.

The deterministic protected namespace and compare-before-delete teardown plan are registered in the receipt for the subsequent protected exercise. The preflight path validates the plan fields but does not execute teardown. Owned-resource-only cleanup and requery are required, while force deletion and repository deletion are explicitly forbidden.

## Verification

The receipt was accepted by:

```text
node orchestrator/scripts/validate-protected-preflight.mjs artifacts/reliability/protected-release-preflight.json
node orchestrator/scripts/scan-release-evidence.mjs artifacts/reliability/protected-release-preflight.json
git diff --check
```
