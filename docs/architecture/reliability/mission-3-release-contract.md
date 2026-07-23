# Mission 3 installed-release authority

The normative authority is
[`mission-3-release-contract.json`](mission-3-release-contract.json). This
document is a non-overriding prose mirror.

Mission 3 selects Omnigent by explicit `OMNIGENT_ROOT` and
`OMNIGENT_PYTHON` and proves behavioral current compatibility. Observed
versions and Git OIDs are retained only as provenance; neither is a
compatibility pin. The selected sibling and interpreter are read-only, and
the imported module must resolve beneath the selected root.

The supported Rickgent install consists of exactly one npm tarball and one
non-editable `rickgent_policies` wheel. The tarball owns the compiled CLI,
agent bundles, runtime metadata, license, proof metadata, and validators.
Omnigent is the sole permitted mounted external dependency. Checkout lookup,
editable Rickgent installs, and source fallbacks invalidate installed proof.

The receipt schemas are closed, versioned contracts. They bind source,
release, build, archive, inventory, corpus, compatibility, containment,
redaction, lifecycle, evidence class, and cleanup facts. A required check is
typed as `pass`, `fail`, or `infrastructure_error`; no skip is success.

This decision enables no capability. Reconciliation remains limited to the
t29 local recovery profile. Installed resume/retry, cross-vendor review, and
automatic delivery remain unavailable until their prior corpora and valid t38
installed evidence both exist. Parallel dispatch and raw shell remain
unavailable.

The protected release-verification authority is non-public and fail-closed.
Ordinary CLI selection, generic environment variables, and generic dependency
injection cannot reach it. It proves a release before activation and cannot
activate a public capability.

Hosted proof may use only a pre-existing, allowlisted disposable repository
whose immutable repository ID, canonical host/owner/name, exact base branch,
and owned branch prefix were validated before mutation. A run owns only its
namespaced branch and pull request. Cleanup closes only that pull request and
deletes only the exact observed branch OID with compare-before-delete,
followed by an independent re-query. Repository deletion is forbidden.

`refinement_manifest.json` is executable sequencing and path-ownership
authority. This contract governs t37a decisions; earlier machine contracts
govern unaffected state. Prose cannot override machine authority. The ordered
milestone completion commits are t37c, t38c, and t39b.
