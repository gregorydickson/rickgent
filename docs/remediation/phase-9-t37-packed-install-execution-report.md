# Phase 9 t37 packed-install execution report

Source handoff: `d83405ee20e2cb8c5a9418c8913d646e876269bc`

The runner built and installed exactly the committed npm tarball and non-editable policy wheel. Retained production-entrypoint failures exposed baseline assumptions: pip records a non-editable local wheel in `direct_url.json`; macOS may spell the temporary root through `/var` while Python reports `/private/var`; a fresh venv cannot import the explicitly selected Omnigent dependency set unless it inherits that interpreter's site packages; a symlinked venv interpreter canonicalizes outside the venv and is correctly rejected as ambient; the mounted Omnigent source contains symlinks; and the compiled doctor expected legacy denial code `SCOPE_DENIED` while the packed policy returns `RICKGENT_SCOPE_DENIED`. The bounded proof-harness repair permits only archive-origin direct-url metadata, canonicalizes the proof root, creates the venv with `--copies --system-site-packages`, mounts a dereferenced minimal Omnigent package, and updates the installed doctor expectation to the policy's retained production code. The staged installed-runtime check still parses and rejects `dir_info`/editable direct-url metadata, and the independent negative controls prove rejection and Rickgent-owned realpath containment.

- npm: `rickgent-0.1.0-alpha.tgz` — `68dfdf1e88cde686d673c277c99173777439a32b0edc1cd38b08ac32b6447f05`; inventory `b6d8a5a1149d5f0242169e4de66799c5f7eea54360ac9fb14e1815f1b48c2946` (450 members)
- wheel: `rickgent_policies-0.1.0a0-py3-none-any.whl` — `a9e94f1cb7675f1906dcef688589469a5ba2f86cf88efbdfd6ecda49f2ef9b49`; inventory `abeac2ab3ca773840a59c9a5439dc8c3c7e52742a3081f2f0a3e7eb88c543b2a` (17 members)
- receipt: `055e00f93bda7f3f90d066fc81c927026146b288b7e32fc17c914534a12c3d35`
- installed CLI root: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-zdUIhJ/prefix/npm/node_modules/rickgent`
- installed policy origin: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-zdUIhJ/prefix/python/lib/python3.12/site-packages/rickgent_policies/__init__.py`
- Omnigent origin/version: `/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/rickgent-packed-proof-zdUIhJ/omnigent-root/omnigent/__init__.py` / `0.6.0.dev0`

All required checks passed with zero skips and zero infrastructure errors. The behavioral doctor proved native allow/deny, compatible Omnigent observation, SQLite close/reopen durability, disposable Git containment, typed failure handling, and owned cleanup. It explicitly reported `authenticated_hosted_evidence=false`.

Independent controls rejected source sentinel access, checkout CWD, NODE_PATH/PYTHONPATH poisoning, source node_modules, resource overrides, editable direct_url/.pth/egg-link metadata, escaping symlinks, missing resources, and implicit/wrong Python. The checkout, Omnigent sibling, and unrelated sentinel were preserved.

Verification is runner-owned and follows the ticket's declared sequential command list. The receipt validator, trust-spine validator, and diff check are the final fail-closed gates.

Completion convention: the manifest binds the stable t37b input handoff; the dependent ticket observes the non-self-referential t37c output commit.
