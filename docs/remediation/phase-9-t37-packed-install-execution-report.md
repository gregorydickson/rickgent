# Phase 9 t37 packed-install execution report

Source handoff: `ea8e5f7b4dde9311067c9dfafb66ea95e0817903`

The runner built and installed exactly the committed npm tarball and non-editable policy wheel. Retained production-entrypoint failures exposed baseline assumptions: pip records a non-editable local wheel in `direct_url.json`; macOS may spell the temporary root through `/var` while Python reports `/private/var`; a fresh venv cannot import the explicitly selected Omnigent dependency set unless it inherits that interpreter's site packages; a symlinked venv interpreter canonicalizes outside the venv and is correctly rejected as ambient; the mounted Omnigent source contains symlinks; and the compiled doctor expected legacy denial code `SCOPE_DENIED` while the packed policy returns `RICKGENT_SCOPE_DENIED`. The bounded proof-harness repair permits only archive-origin direct-url metadata, canonicalizes the proof root, creates the venv with `--copies --system-site-packages`, mounts a dereferenced minimal Omnigent package, and updates the installed doctor expectation to the policy's retained production code. The staged installed-runtime check still parses and rejects `dir_info`/editable direct-url metadata, and the independent negative controls prove rejection and Rickgent-owned realpath containment.

- npm: `rickgent-0.1.0-alpha.tgz` — `db895894456ef96571da1a8a19d3f1e3d373b534d3948884e5d9620d5e92f051`; inventory `188a724d85dea6de2200a4695c58e3e3b3405e6c805328f0cb964d5aaafd37fa` (450 members)
- wheel: `rickgent_policies-0.1.0a0-py3-none-any.whl` — `38ddf68df9a8993faec67ba8d000aa7d7181d3d856201c51db62d0ede59751f0`; inventory `abeac2ab3ca773840a59c9a5439dc8c3c7e52742a3081f2f0a3e7eb88c543b2a` (17 members)
- receipt canonical digest: `f818b3341372584470239171bf66ac90ff4f0bda2e6b7c0524d348281d82720e`
- installed CLI and policy origins: contained below the isolated proof-owned npm prefix and Python virtual environment recorded in the retained receipt
- Omnigent origin/version: contained below the proof-owned dereferenced mount / `0.6.0.dev0`

All required checks passed with zero skips and zero infrastructure errors. The behavioral doctor proved native allow/deny, compatible Omnigent observation, SQLite close/reopen durability, disposable Git containment, typed failure handling, and owned cleanup. It explicitly reported `authenticated_hosted_evidence=false`.

Independent controls rejected source sentinel access, checkout CWD, NODE_PATH/PYTHONPATH poisoning, source node_modules, resource overrides, editable direct_url/.pth/egg-link metadata, escaping symlinks, missing resources, and implicit/wrong Python. The checkout, Omnigent sibling, and unrelated sentinel were preserved.

Verification is runner-owned and follows the ticket's declared sequential command list. The receipt validator, trust-spine validator, and diff check are the final fail-closed gates.

Completion convention: the retained npm archive, policy wheel, npm inventory, canonical receipt, checksum, generated build identity, proof authoring mode, and strict validator are finalized first in a packed-output commit. The t37 manifest row is updated only in a descendant commit and binds that full output OID, avoiding self-reference. The packed receipt validator requires the current descendant source handoff to follow the original t37b handoff, the source handoff to be an ancestor of the output commit, the output commit to be an ancestor of HEAD, t37c ownership through that output boundary, and byte-for-byte equality between the retained outputs and the output commit. Later unrelated repository state cannot masquerade as, or invalidate, the packed evidence.
