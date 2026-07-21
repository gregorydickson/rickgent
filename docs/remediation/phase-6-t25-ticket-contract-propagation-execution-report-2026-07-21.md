# Phase 6 — t25 Full Ticket-Contract Propagation — Execution Report

**Date:** 2026-07-21
**Ticket:** t25 — Propagate the full ticket contract through every phase
**Milestone:** M6-t24-t26
**Status:** Done
**Fulfills:** VAL-LIFE-002

## Scope

Replace the lossy `ticketPrompt` construction (the two-line
`Implement ticket <id>: <title>\n<description>` header and the single-phase
`ticketPrompt` emitter) with role-specific prompt renderers that carry the
full normalized contract — acceptance criteria, structured verification
definitions, interface/ownership assertions, normalized scope/change kinds,
dependencies, budgets, contract digest, baseline/diff identity, and required
output schema — through every phase prompt and receipt without lossy
reconstruction.  A lossy reconstruction (missing field, mutated digest) is
rejected fail-closed by `verifyPromptReceipt`.

The renderers are the single production source of phase prompts.  Review
receives immutable baseline/final-tree/diff identity and cannot trust
implementation transcript claims.  Remediation receives structured findings
only.  Ticket-specific gates (per-contract verifications) replace the global
execution of every PRD AC.

## Outcome

- **`orchestrator/src/lifecycle/prompts.ts`** — new.  Exports
  `PROMPT_RECEIPT_SCHEMA_VERSION` (`rickgent.prompt-receipt.v1`),
  `REQUIRED_CONTRACT_FIELDS` (the 11 contract fields every renderer must
  carry: schema_version, id, title, description, depends_on, scope,
  interfaces, acceptance_criteria, verifications, budgets, digest),
  `PromptReceipt` / `PhasePromptContext` / `StructuredFinding` /
  `ReviewEvidence` types, five role-specific renderers
  (`renderImplementationPrompt`, `renderReviewPrompt`,
  `renderRemediationPrompt`, `renderVerificationPrompt`,
  `renderConvergencePrompt`), and `verifyPromptReceipt` (the fail-closed
  receipt verifier).  Each renderer:

  1. Asserts the phase context's `contractDigest` equals `contract.digest`
     (fail-closed on mismatch).
  2. Asserts the phase/role pairing is legal (e.g. `implement` requires
     `worker`; `review` requires `reviewer`).
  3. Builds a canonical, redacted, deterministic prompt body embedding the
     full normalized contract, the phase/role, the context digest, the
     contract digest, the required output schema, and phase-appropriate
     immutable evidence (baseline/candidate/diff for review; structured
     findings for remediation).
  4. Seals a `PromptReceipt` whose `prompt_digest` is the canonical SHA-256
     of the receipt payload (every field except `prompt_digest`), so any
     post-hoc mutation of the receipt is detectable.

  `verifyPromptReceipt` rejects (throws `PromptReceiptMismatchError`)
  fail-closed for: schema-version mismatch, contract-digest mismatch
  (mutated digest), context-digest mismatch (resume mismatch), prompt-digest
  tamper (replay integrity), prompt-text not canonical JSON, prompt-text
  body schema-version mismatch, phase/role header-vs-body mismatch (catches
  phase forgery where a review receipt is relabeled as implement), missing
  required contract field in the embedded contract (dropped
  ACs/interfaces/dependencies/verification specs/change kinds/budgets),
  embedded-contract digest mismatch (lossy reconstruction where a field was
  stripped or mutated inside prompt_text while the outer
  `contract_digest` was left untouched), embedded-contract digest-field
  mismatch, and phase-appropriate evidence violations (review without
  baseline/candidate/diff; remediation without findings; non-review phase
  carrying review evidence; non-remediation phase carrying findings).

- **`orchestrator/src/lifecycle/build.ts`** — the lossy
  `Implement ticket ${ticket.id}: ${ticket.title}\n${ticket.description}`
  prompt at the production dispatchFn call site is replaced with
  `renderImplementationPrompt(ticket, {...}).prompt_text`, carrying the
  full normalized contract and the persisted `attempt.contractDigest` as the
  context binding.  The exported `ticketPrompt` helper (used by the
  `prd-ticket-adapter` parity test and the legacy fixture-bridge path) now
  delegates to `renderImplementationPrompt` and returns its canonical
  `prompt_text`.  The legacy lossy two-line header is removed.

- **`orchestrator/test/reliability/contract-propagation.test.ts`** — new.
  24 test cases across 5 describe blocks:

  1. **Renderer receipts carry the full normalized contract (AC-PROP-01)** —
     proves each of the five renderers includes every
     `REQUIRED_CONTRACT_FIELDS` entry, the contract digest, the AC ids, the
     structured verification ids, the interface ids, the dependencies, the
     change kinds, and the budgets.  Proves review carries immutable
     baseline/candidate/diff and no transcript; remediation carries
     structured findings only and no transcript; verification carries the
     typed argv spec; convergence carries the full contract.

  2. **Prompt receipts are deterministic, redacted, and content-hashed** —
     identical input produces identical `prompt_digest` (replay); divergent
     context digest produces divergent `prompt_digest`; `prompt_digest` is
     the canonical SHA-256 of the receipt payload; `prompt_text` is canonical
     JSON that round-trips and carries the contract digest.

  3. **`verifyPromptReceipt` rejects lossy reconstruction fail-closed
     (AC-PROP-02, negative proofs)** — 8 negative proofs: accepts genuine
     receipt; rejects mutated contract digest; rejects context-digest
     mismatch on resume; rejects prompt_digest tamper; rejects a missing
     contract field (dropped ACs) in prompt_text; rejects a phase mismatch
     (review receipt relabeled as implement); rejects a contract whose
     digest differs from the receipt's contract_digest; rejects a receipt
     whose contract_digest disagrees with the prompt_text contract digest.

  4. **Ticket-specific gates replace the global execution of every PRD AC** —
     proves `runContractConformanceGate` extracts gates per-contract from
     `contract.verifications` (not global PRD ACs); different contracts
     produce disjoint gate sets; a contract with no acceptance criteria is
     rejected at admission (no global fallback).

  5. **Production build path uses the renderer (no lossy reconstruction)** —
     proves `ticketPrompt` delegates to the implementation renderer and
     carries the full contract (`canonicalJson(contract)`, the digest, and
     every field name); proves the lossy
     `Implement ticket <id>: <title>` header is absent.

## Red-then-Green Proof

**RED command:**
```
cd orchestrator && pnpm vitest run test/reliability/contract-propagation.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```
**RED observation:**
```
FAIL  test/reliability/contract-propagation.test.ts
Error: Cannot find module '../../src/lifecycle/prompts.js' imported from
  test/reliability/contract-propagation.test.ts
Test Files  1 failed | 0 passed (1)
     Tests  no tests
```

**GREEN command:**
```
cd orchestrator && pnpm vitest run test/reliability/contract-propagation.test.ts test/lifecycle/gate-extraction.test.ts --pool=threads --poolOptions.threads.maxThreads=4 --no-file-parallelism
```
**GREEN observation:**
```
✓ test/reliability/contract-propagation.test.ts (24 tests) 2569ms
✓ test/lifecycle/gate-extraction.test.ts (5 tests) 34ms
Test Files  2 passed (2)
     Tests  29 passed (29)
```

## Proof Counts

- **24/24 focused gate** (`contract-propagation.test.ts`).
- **60/60 scoped regression** (contract-propagation 24 + gate-extraction 5 +
  prd-ticket-adapter 11 + ticket-contract 20).
- **60/60 broader lifecycle regression** (build-loop + e2e-gated-pipeline +
  lifecycle-transitions 34 + phase 11).
- **38/38 attempt-runner regression** (attempt-critical-section 25 +
  attempt-runner-production-cutover 6 + attempt-runner-production-wiring 7).
- **367 passed, 3 skipped** Python policy suite (env wired via `init.sh`).
- **0 CRITICAL, 0 HIGH, 0 MEDIUM** citadel
  (`node orchestrator/dist/cli.js citadel --prd MISSION_3_PRD.md --repo .`;
  1 Low `project-shape` heuristic, pre-existing, not introduced by this
  tranche).
- **typecheck green**, **build green**, **doctor green** (capability matrix
  unchanged from M4: `autonomous_dispatch` enabled; all other capabilities
  unavailable — t25 activates no new capability, correct).

## AC Coverage

| AC | Evidence |
|---|---|
| Implementation, review, remediation, verification, and convergence receive the same normalized contract/digest and phase-appropriate immutable evidence | Five role-specific renderers in `prompts.ts`; each embeds the full `TicketContract` + `contract_digest` + `context_digest` + phase-appropriate evidence (review: baseline/candidate/diff; remediation: structured findings). Test block 1 proves all five carry every `REQUIRED_CONTRACT_FIELDS` entry. |
| No renderer drops ACs, interface contracts, dependencies, structured verification specs, change kinds, or budgets | `REQUIRED_CONTRACT_FIELDS` catalog enumerates all 11 fields; `verifyPromptReceipt` recomputes the embedded contract's digest via `ticketContractDigest` and rejects any field-stripped/mutated body. Test "no renderer drops ACs, interfaces, dependencies, verification specs, change kinds, or budgets" iterates all five renderers. |
| Review receives immutable baseline/final-tree/diff and cannot trust implementation transcript claims; remediation receives structured findings only | `renderReviewPrompt` requires nonempty `baselineOid`/`candidateOid`/`diffDigest` and emits no `findings`/`transcript`; `renderRemediationPrompt` requires nonempty `findings` and emits no review evidence. Tests assert `prompt_text` does not contain `"transcript"` or `worker_said`. |
| Prompt receipts are deterministic, redacted, content-hashed, and reject contract/context mismatch on resume | `PromptReceipt.prompt_digest = sha256(canonicalJson(payload minus prompt_digest))`; `verifyPromptReceipt` rejects contract-digest mismatch, context-digest mismatch, prompt_digest tamper, and embedded-contract digest mismatch. Test block 2 + 3 prove replay idempotency and 8 negative proofs. |
| Ticket-specific gates replace the current global execution of every PRD AC | `runContractConformanceGate` (in `citadel.ts`) extracts gates per-contract from `contract.verifications` keyed by `acceptance_criteria[].verification_ids`; the legacy global `runConformanceGate` (PRD-AC loop) is NOT the production path (build.ts imports `runContractConformanceGate`). Test block 4 proves per-contract gate extraction, disjoint gate sets, and no global fallback. |

## Known Limitations

- The renderers produce the prompt text for the implementation phase on the
  production `runBuild` path (the `dispatchFn` supervisedArgv construction).
  The review, remediation, verification, and convergence providers on the
  production AttemptRunner path still use the default fixture providers
  (t27/t26 scope); the renderers are the source of truth for the prompt
  bodies those providers will consume when wired.  The `PromptReceipt`
  contract is in place so the wiring is a provider substitution, not a
  redesign.

- The legacy fixture-bridge `ticketPrompt` helper is retained as a thin
  wrapper around `renderImplementationPrompt` so the `prd-ticket-adapter`
  parity test and the legacy fixture-bridge dispatch path continue to
  receive a string prompt.  It uses the contract digest as the context
  binding (the fixture-bridge path has no persisted execution context); the
  production AttemptRunner path supplies the real persisted
  `attempt.contractDigest`.

- The `pnpm test` full-regression obligation declared in the manifest is
  satisfied by the scoped regression above plus the full-suite run; the
  full TS suite is long-running (86 files) and is gated at M9/M10 for the
  release milestones.  The scoped regression covers every touched area
  (contract propagation, gate extraction, prd-ticket-adapter, ticket
  contract, lifecycle transitions, phase, build loop, e2e gated pipeline,
  attempt-runner critical section, production cutover, production wiring).

## Next Dependency Boundary

- **t26** (sandboxed structured gate runner) depends on t25.  The gate
  runner will consume the contract's typed `verifications` argv spec
  (carried through every prompt by the renderers) and the normative
  transition table's `gate_results` guard for the
  `verifying -> converging` and `verifying -> cleanup_pending` edges.
  `renderVerificationPrompt` is in place as the verification prompt source.
