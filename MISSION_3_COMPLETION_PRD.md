---
title: "Rickgent Mission 3 Completion — Installed Release Proof (t37-t39)"
status: ready
execution: sequential
source_of_truth:
  - docs/remediation/trust-spine-manifest.json
  - release-manifest.json
  - MISSION_3_PRD.md
---

# Rickgent Mission 3 Completion — t37 through t39

## Summary

Complete the final three tickets in the trust-spine remediation program. The
existing t00-t36 implementation is the baseline: repair it only when a t37-t39
production-entrypoint proof exposes a real defect. Execute t37, t38, and t39
strictly in dependency order and commit each ticket separately.

## Motivation

The repository has release contracts and quality gates, but it does not yet
prove that packed artifacts work without source fallback, that the installed
runtime completes the protected real lifecycle twice, or that public claims
match the resulting evidence. Until these proofs exist, the project is not
complete and unproven capabilities must remain unavailable.

## Critical user journeys

1. A user installs only the npm and Python archives into clean isolated
   locations and gets a working CLI, bundled agents, native policies, and
   behavioral doctor without a source checkout.
2. An authenticated operator runs the installed runtime with local compatible
   Omnigent, Codex `gpt-5.6-sol`, Claude
   `claude-opus-4-8[1m]`, and a dedicated disposable GitHub repository. The
   lifecycle survives a forced interruption, resumes from the same durable
   state, independently reviews, gates, delivers, and verifies the PR.
3. A release consumer sees capability flags, help, doctor, README, changelog,
   master plan, and manifest statuses that state exactly what the retained
   proof receipts support.

## Global constraints

- Execute sequentially. Shared state, Git, policy, process, and lifecycle
  contracts must not be edited by parallel implementation agents.
- Treat `/Users/gregorydickson/loanlight/pickle-rick/omnigent` as read-only.
- Use Omnigent `0.6.0.dev0` at commit `6e3c7785` through
  `/Users/gregorydickson/.pyenv/versions/3.12.12/bin/python`.
- Use the installed/authenticated Codex and Claude harnesses. Droid is out of
  scope and must not be selected.
- Do not treat requested router labels as observed provider identity. A
  cross-vendor decision requires independent runtime observation.
- Use a dedicated allowlisted disposable hosted repository. Never target a
  production repository. Teardown must be safe, bounded, and evidenced.
- No editable install, source-tree import/resource fallback, mock provider,
  skipped required check, or infrastructure error may satisfy an acceptance
  criterion.
- Preserve the caller checkout, unrelated untracked work, and unrelated
  runtime data.

## Ticket t37 — Clean packed installation and behavioral doctor

Implement the manifest's t37 packed-install corpus and production behavioral
doctor. Build the supported npm and Python archives, install them into
isolated prefix/virtualenv roots, remove the source checkout from all lookup
paths, and prove the installed CLI/resources/policies/Omnigent contract.

### Artifact ownership

t37 owns generation and committed validation of these release inputs. Any
refined ticket that verifies either path must declare one of them as its
`output_artifacts` owner before downstream tickets may consume it:

- `artifacts/reliability/python-dist/**`
- `artifacts/reliability/omnigent-compatibility-contract.json`
- `artifacts/reliability/npm-pack-inventory.json`
- `artifacts/reliability/packed-install-summary.json`

### Acceptance criteria

- `orchestrator/test/reliability/packed-install.test.ts` exists and passes with
  `OMNIGENT_ROOT=/Users/gregorydickson/loanlight/pickle-rick/omnigent`.
- The test resolves the executable, JS modules, agent bundles, and Python
  package exclusively from installed packed locations and contains a negative
  proof that source/editable fallback fails.
- Behavioral doctor executes native FunctionPolicy allow and deny calls,
  a real selected harness/model invocation with an observed receipt, a durable
  state write/read, and a disposable Git workspace check.
- `artifacts/reliability/packed-install-summary.json` is generated, redacted,
  content-addressed, reports `cli_resolved: true`,
  `behavioral_doctor_passed: true`, `source_fallback: false`, and has no skipped
  required checks or infrastructure errors.
- Package inventory and release/compatibility/build identities agree with
  `release-manifest.json`.
- The t37 manifest row is `Done` only after all evidence is committed.

### Machine checks

```bash
cd orchestrator
OMNIGENT_ROOT=/Users/gregorydickson/loanlight/pickle-rick/omnigent \
OMNIGENT_PYTHON=/Users/gregorydickson/.pyenv/versions/3.12.12/bin/python \
pnpm exec vitest run test/reliability/packed-install.test.ts --no-file-parallelism
cd ..
node -e 'const x=require("./artifacts/reliability/packed-install-summary.json");if(!x.cli_resolved||x.source_fallback||!x.behavioral_doctor_passed||x.skipped_required?.length||x.infrastructure_errors?.length)process.exit(1)'
```

## Ticket t38 — Protected real installed vertical slice

Using only the t37 packed installation, run the complete protected lifecycle
against real compatible Omnigent, real authenticated Codex and Claude
harnesses, and one dedicated disposable GitHub repository. Force interruption
after durable work, resume from the same SQLite/data root, and complete the
entire slice twice with distinct run IDs.

### Acceptance criteria

- Preflight verifies the exact remote owner/name allowlist, clean packed
  install, compatible Omnigent behavior, authenticated explicit harness/model
  pairs, and bounded teardown before any hosted mutation.
- The implementer is Codex `gpt-5.6-sol`/OpenAI and independent reviewer is
  Claude `claude-opus-4-8[1m]`/Anthropic, with requested, invoked, and observed
  identities tied to real dispatches. Provider distinction is derived only
  from independently observed runtime evidence.
- Native policy allow/deny, owned worktree/ref/index/lease/containment, owned
  commit, independent review, blocking gates, oracle, cleanup, verified push,
  idempotent PR resolution, and PR-head/delivery-OID equality are all evidenced
  at production entrypoints.
- A forced process interruption resumes from the same persisted SQLite and
  Omnigent data root without stale-terminal replay or duplicate hosted side
  effects.
- `artifacts/reliability/vertical-slice-receipt.json` reports exactly two
  successful distinct run IDs, `mocked: false`, no skipped required checks or
  infrastructure errors, `pr_head_matches_delivery_oid: true`, and
  `remote_cleanup_verified: true`.
- Failure paths still perform bounded cleanup and retain redacted diagnostic
  evidence.
- The t38 manifest row is `Done` only after both real runs and teardown pass.

### Machine checks

```bash
test -n "$GH_TOKEN"
test -n "$RICKGENT_RELEASE_REMOTE"
cd orchestrator
OMNIGENT_ROOT=/Users/gregorydickson/loanlight/pickle-rick/omnigent \
OMNIGENT_PYTHON=/Users/gregorydickson/.pyenv/versions/3.12.12/bin/python \
RICKGENT_TEST_HARNESS=codex \
RICKGENT_TEST_MODEL=gpt-5.6-sol \
RICKGENT_REVIEW_HARNESS=claude-sdk \
RICKGENT_REVIEW_MODEL='claude-opus-4-8[1m]' \
RICKGENT_RELEASE_REPEAT_COUNT=2 \
pnpm exec vitest run test/reliability/installed-vertical-slice.test.ts --no-file-parallelism
cd ..
node -e 'const x=require("./artifacts/reliability/vertical-slice-receipt.json");if(x.repeat_count!==2||new Set(x.run_ids||[]).size!==2||x.mocked||x.skipped_required?.length||x.infrastructure_errors?.length||!x.pr_head_matches_delivery_oid||!x.remote_cleanup_verified)process.exit(1)'
```

## Ticket t39 — Restore only proven capabilities and claims

Consume the committed t37/t38 receipts and make capability activation and all
public claims agree with the exact proof versions. Keep every capability
without complete retained evidence unavailable.

### Acceptance criteria

- Each enabled capability names and startup-validates its exact proof
  corpus/version; implementation existence alone never activates it.
- Automatic delivery and resume require the valid t38 receipt. Cross-vendor
  activation additionally requires genuine observed-identity proof.
- Parallel dispatch remains unavailable unless the complete deterministic
  stress corpus is run and retained; raw shell remains unavailable;
  reconciliation remains unavailable unless its full activation contract is
  separately proven.
- README, CHANGELOG, CLI help, doctor, package metadata,
  `docs/reliability-contract.md`, `master-plan.md`, and manifest status/evidence
  agree and distinguish local readiness from hosted delivery.
- Claim mutation tests fail when any public claim is stronger than its retained
  proof.
- Full TypeScript, Python, quality, package, compatibility, and claims gates
  pass from a clean tree.

### Machine checks

```bash
cd orchestrator
pnpm exec vitest run test/reliability/claims-contract.test.ts test/reliability/capability-restoration.test.ts
pnpm typecheck
cd ..
/Users/gregorydickson/.pyenv/versions/3.12.12/bin/python -m pytest rickgent-policies/test/ -q -p no:cacheprovider
node orchestrator/scripts/validate-release-manifest.mjs release-manifest.json
node orchestrator/scripts/quality-gates-summary.mjs run
node orchestrator/scripts/quality-gates-summary.mjs check artifacts/reliability/quality-gates-summary.json
```

## Out of scope

- Editing or upgrading the sibling Omnigent checkout.
- Droid execution.
- Marketplace publication.
- Enabling native multi-agent fanout.
- Broad refactoring or cleanup unrelated to a failing t37-t39 proof.
- Claiming parallel dispatch from skipped or reduced stress iterations.

## Completion rule

Mission 3 is complete only when t37, t38, and t39 are separately committed in
order; their current evidence receipts and full regressions are green; the
manifest marks t00-t39 `Done`; the disposable hosted resources are safely
cleaned; and mandatory Citadel reports no blocking finding.
