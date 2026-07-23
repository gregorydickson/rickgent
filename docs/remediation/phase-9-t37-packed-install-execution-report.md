# Phase 9 t37 packed-install execution report

Source handoff: `9976e7cf636bf9d7279aa70cb5b1ec8c8b78169f`

The runner built and installed exactly the committed npm tarball and non-editable policy wheel. Retained production-entrypoint failures exposed baseline assumptions: pip records a non-editable local wheel in `direct_url.json`; macOS may spell the temporary root through `/var` while Python reports `/private/var`; a fresh venv cannot import the explicitly selected Omnigent dependency set unless it inherits that interpreter's site packages; a symlinked venv interpreter canonicalizes outside the venv and is correctly rejected as ambient; the mounted Omnigent source contains symlinks; and the compiled doctor expected legacy denial code `SCOPE_DENIED` while the packed policy returns `RICKGENT_SCOPE_DENIED`. The bounded proof-harness repair permits only archive-origin direct-url metadata, canonicalizes the proof root, creates the venv with `--copies --system-site-packages`, mounts a dereferenced minimal Omnigent package, and updates the installed doctor expectation to the policy's retained production code. The staged installed-runtime check still parses and rejects `dir_info`/editable direct-url metadata, and the independent negative controls prove rejection and Rickgent-owned realpath containment.

- npm: `rickgent-0.1.0-alpha.tgz` — `728f945d0170d7ad74d90e1a05b0a523084b61926e4897f9134ba39c29c86211`; inventory `6a3f42ce39a5786bb13d49e06ea1e6d0168685658103cedfeb3322d4c613f1b1` (450 members)
- wheel: `rickgent_policies-0.1.0a0-py3-none-any.whl` — `6f32e44ec6bbef8431c630d8f6f72405698251b4d66293de989cbd006ec64960`; inventory `abeac2ab3ca773840a59c9a5439dc8c3c7e52742a3081f2f0a3e7eb88c543b2a` (17 members)
- receipt: `9b58727109a76fc77aeeb4ccf8bace29a1bc22e7703ab851c6000b2bc867502f`
- installed CLI root: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-wjxh25/prefix/npm/node_modules/rickgent`
- installed policy origin: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-wjxh25/prefix/python/lib/python3.12/site-packages/rickgent_policies/__init__.py`
- Omnigent origin/version: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-wjxh25/omnigent-root/omnigent/__init__.py` / `0.6.0.dev0`

All required checks passed with zero skips and zero infrastructure errors. The behavioral doctor proved native allow/deny, compatible Omnigent observation, SQLite close/reopen durability, disposable Git containment, typed failure handling, and owned cleanup. It explicitly reported `authenticated_hosted_evidence=false`.

Independent controls rejected source sentinel access, checkout CWD, NODE_PATH/PYTHONPATH poisoning, source node_modules, resource overrides, editable direct_url/.pth/egg-link metadata, escaping symlinks, missing resources, and implicit/wrong Python. The checkout, Omnigent sibling, and unrelated sentinel were preserved.

Verification is runner-owned and follows the ticket's declared sequential command list. The receipt validator, trust-spine validator, and diff check are the final fail-closed gates.

Completion convention: the manifest binds the stable t37b input handoff; the dependent ticket observes the non-self-referential t37c output commit.
