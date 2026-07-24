# Phase 9 t37 packed-install execution report

Source handoff: `d83405ee20e2cb8c5a9418c8913d646e876269bc`

The runner built and installed exactly the committed npm tarball and non-editable policy wheel. Retained production-entrypoint failures exposed baseline assumptions: pip records a non-editable local wheel in `direct_url.json`; macOS may spell the temporary root through `/var` while Python reports `/private/var`; a fresh venv cannot import the explicitly selected Omnigent dependency set unless it inherits that interpreter's site packages; a symlinked venv interpreter canonicalizes outside the venv and is correctly rejected as ambient; the mounted Omnigent source contains symlinks; and the compiled doctor expected legacy denial code `SCOPE_DENIED` while the packed policy returns `RICKGENT_SCOPE_DENIED`. The bounded proof-harness repair permits only archive-origin direct-url metadata, canonicalizes the proof root, creates the venv with `--copies --system-site-packages`, mounts a dereferenced minimal Omnigent package, and updates the installed doctor expectation to the policy's retained production code. The staged installed-runtime check still parses and rejects `dir_info`/editable direct-url metadata, and the independent negative controls prove rejection and Rickgent-owned realpath containment.

- npm: `rickgent-0.1.0-alpha.tgz` — `642512459c175bf0f566d37676512b77ae6e9b88f928d9ef239a56bf37d9edf7`; inventory `2d1833655724db6b665f8eb8c69c4c5d11acd5a1b61778096ab7489ae70036ea` (450 members)
- wheel: `rickgent_policies-0.1.0a0-py3-none-any.whl` — `b0e66101f50722ff80c591ac84a80ce5819d59f1a3aaa6df69e28510261da950`; inventory `abeac2ab3ca773840a59c9a5439dc8c3c7e52742a3081f2f0a3e7eb88c543b2a` (17 members)
- receipt: `a9aaeca2439c3a5ff645b12c83e94e63f86269c544b6ea16cff8f9fa274a8b2a`
- installed CLI root: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-SbOSig/prefix/npm/node_modules/rickgent`
- installed policy origin: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-SbOSig/prefix/python/lib/python3.12/site-packages/rickgent_policies/__init__.py`
- Omnigent origin/version: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-SbOSig/omnigent-root/omnigent/__init__.py` / `0.6.0.dev0`

All required checks passed with zero skips and zero infrastructure errors. The behavioral doctor proved native allow/deny, compatible Omnigent observation, SQLite close/reopen durability, disposable Git containment, typed failure handling, and owned cleanup. It explicitly reported `authenticated_hosted_evidence=false`.

Independent controls rejected source sentinel access, checkout CWD, NODE_PATH/PYTHONPATH poisoning, source node_modules, resource overrides, editable direct_url/.pth/egg-link metadata, escaping symlinks, missing resources, and implicit/wrong Python. The checkout, Omnigent sibling, and unrelated sentinel were preserved.

Verification is runner-owned and follows the ticket's declared sequential command list. The receipt validator, trust-spine validator, and diff check are the final fail-closed gates.

Completion convention: the retained npm archive, policy wheel, npm inventory, canonical receipt, and checksum were finalized first in packed-output commit `796af83be6340b8d766918020d59bf2fe3375154`. The t37 manifest row is updated only in a descendant commit and binds that full output OID, avoiding self-reference. The packed receipt validator requires the pinned t37b handoff to be an ancestor of the output commit, the output commit to be an ancestor of HEAD, t37c ownership through that output boundary, and byte-for-byte equality between the retained outputs and the output commit. Later unrelated repository state cannot masquerade as, or invalidate, the packed evidence.
