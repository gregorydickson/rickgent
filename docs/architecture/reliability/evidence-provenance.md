# Evidence provenance and clean-baseline contract

This contract separates historical evidence, its adoption into the repository, the current implementation handoff, and the evolving external Omnigent authority. Those identities are related, but none substitutes for another.

The executable record is [`evidence-provenance.json`](./evidence-provenance.json). The repository validator checks its Git identities, artifact hashes, manifest contract, ancestry, clean-snapshot representation, changed-path approval, and Omnigent non-pinning assertions.

## Authority chain

| Role | Identity | Meaning |
| --- | --- | --- |
| Historical reviewed commit | `6c9eee8689f9d6e8a5cb63f1a9335f0e98b18834` | The source state examined by the reliability review. It is historical evidence, not a permanent implementation base or an Omnigent pin. |
| Authority adoption | `0661f4dbedd3576717dc0b545bc641e8349b4230` | The single-parent commit that first tracked the review, refined PRD, and remediation manifest. T01 verifies this adoption; it does not re-add or rewrite the review. |
| External compatibility handoff | `9c0d47f3a5f9b2bb863bfd84e5edb887d71f7ea0` (`t00`) | The commit containing the repository-owned current-compatible Omnigent contract and the recorded passing behavioral probe. |
| T01 implementation base | `9c0d47f3a5f9b2bb863bfd84e5edb887d71f7ea0` | The exact clean input to this sequential ticket. Later tickets advance from their verified predecessor rather than resetting to the historical review. |

The review artifact has SHA-256 `1dc9c0646dfe59467969cdced606978946dcbe58a0f4d553d4e1a665f972fdb9`. The committed refined PRD has SHA-256 `3c8265a1d32ed8f64fdf161daf9bcc3ca82ef11bb8fd6ef7514c7d165a240656`. All other authority-artifact hashes are recorded in the JSON contract and verified either from the current worktree or from the Git commit that adopted them.

## External authority is deliberately separate

Omnigent is an evolving external system governed by `artifacts/reliability/omnigent-compatibility-contract.json`. Compatibility comes from that current-compatible behavioral contract and a passing live probe against the same mounted module origin used for execution.

The historical reviewed commit is not external compatibility authority. The t00 Rickgent commit is also not an Omnigent source pin. The contract records no external Git OID, and downstream work must rerun the t00 verifier rather than infer compatibility from Rickgent ancestry, a copied version label, or an old probe result.

## Clean-baseline evidence

T01 began on branch `remediation/trust-spine-phase-1` at input `9c0d47f3a5f9b2bb863bfd84e5edb887d71f7ea0`. Its pre-mutation snapshot was captured as the raw bytes from:

```text
git status --porcelain=v2 -z --untracked-files=all
```

The output was zero bytes, with SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The raw NUL-delimited form is normative; human-oriented short status output, `git diff --check`, and a clean tracked diff alone do not account for all untracked or unusual path names.

For a ticket that starts with approved pre-existing user changes, the executor must record each raw status entry and content identity, preserve it byte-for-byte, and exclude it from the ticket commit. A changed or newly appearing unreviewed entry aborts the handoff before staging. No executor may silently absorb, clean, reset, or overwrite unrelated user changes.

## Sequential handoff rules

Every remediation ticket must:

1. Start from the verified output commit of its declared predecessor and confirm the recorded branch and raw status snapshot before mutation.
2. Use a single-parent commit and record `Rickgent-Ticket` and `Rickgent-Input-Oid` trailers.
3. Obtain explicit reviewed approval for the complete changed-path set before staging and stage only that set. Bulk staging such as `git add -A` is forbidden.
4. Treat `output_artifacts` as minimum required outputs, not as a complete changed-path allowlist. Supporting production, test, schema, or documentation files may change only when the ticket's reviewed change set names them.
5. Preserve approved pre-existing changes byte-for-byte and abort if HEAD, the index, or the dirty-state snapshot changes unexpectedly.
6. Leave a clean committed handoff whose verification is independently rerunnable by the dependent ticket.

The output commit is derived after committing and must not be embedded self-referentially in a file inside that same commit. The dependent ticket captures the observed predecessor output OID as its input.

## T01 reviewed change set

The approved t01 paths are:

- `docs/architecture/reliability/evidence-provenance.json`
- `docs/architecture/reliability/evidence-provenance.md`
- `docs/remediation/trust-spine-manifest.json`
- `orchestrator/scripts/validate-evidence-provenance.mjs`

The already-tracked reliability review is an authority input and required artifact, but it is intentionally absent from this changed-path set.

Run the contract verifier with:

```text
node orchestrator/scripts/validate-evidence-provenance.mjs --contract docs/architecture/reliability/evidence-provenance.json
```

After committing a handoff, add `--require-clean` to verify the live worktree has returned to the recorded clean-state digest.
