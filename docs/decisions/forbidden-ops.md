# Decision: Forbidden Ops

## Component
§2 matrix row — forbidden operations (R-WSRC: worker source recursion contamination). Cross-references AC-10 (policies enforce forbidden ops) and §2.2 `guardrails.policies.blast_radius` in the mission PRD.

## Omnigent implementation
Omnigent's forbidden-ops surface is the policy framework in `omnigent/policies/builtins/`:

- **`blast_radius`** (`omnigent/policies/builtins/orchestration.py:345-405`) is a factory that classifies shell commands (`sys_os_shell`, `Bash`, `bash`) by reversibility. Catastrophic commands (force-push, `rm -rf /`, hard-reset to a remote ref) are DENIED (`_DENY_PATTERNS`, `orchestration.py:62-64`; `_rm_severity`, `orchestration.py:236-283`; `_push_severity`, `orchestration.py:296-343`). Outward-but-recoverable commands (`git push`, `gh pr merge`, `rm -rf <scoped>`, infra deploy/destroy) return ASK (`_ASK_PATTERNS`, `orchestration.py:66-69`). It is flag-form robust: `_rm_severity` detects recursive `rm` in combined (`-rf`), short (`-r`), and long (`--recursive`) forms, and skips `sudo`/env-assignment prefixes (`_command_index_after_shell_prefixes`, `orchestration.py:200-234`).
- **`spawn_bounds`** (`omnigent/policies/builtins/orchestration.py:407-464`) caps worker dispatches per turn (`max_dispatches_per_turn`, default 5). The counter resets each turn via `reset_turn` (`orchestration.py:451-456`).
- **`headless_subagent_purpose_guard`** (`orchestration.py:466-517`) requires every `sys_session_send` to declare `args.purpose` ∈ {implement, review, explore, search}.
- **`worktree_guard`** (`orchestration.py:519-567`) DENYs writes outside the worktree subtree (absolute paths, `..` escapes).
- **`read_only_os`** (`orchestration.py:570-621`) DENYs every file-mutating tool call for report-only agents.
- **`enforce_sandbox`** (`omnigent/policies/builtins/safety.py:350-446`) forces sandbox config on `__agent_start`.
- **`ask_on_os_tools`** (`safety.py:117-230`) ASKs for approval before any file/shell tool across six tool-name families (Omnigent `sys_os_*`, Claude/Codex native `Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep`, Cursor `Shell`, Pi lowercase, Hermes, Goose, opencode).
- **`block_skills`** (`safety.py:232-326`) DENYs loading specific skills.

The policy registry is auto-discovered at startup (`omnigent/policies/builtins/__init__.py:1-46`, `BUILTIN_POLICY_MODULES`). The framework is general: any `PolicyEvent` → `PolicyResponse` callable can be attached to a session. But Omnigent has no concept of "worker must not write `state.json`" or "worker must not run `install.sh`" — those are Pickle Rick-specific trap doors from the self-modifying-runtime threat model.

## Pickle Rick implementation
Pickle Rick's forbidden ops are TypeScript hooks that fire on every `PreToolUse` event. The threat model is R-WSRC: workers run inside the runtime they modify, so they must not contaminate the runtime's own state.

- **`config-protection.ts`** (961 LOC, `extension/src/hooks/handlers/config-protection.ts`) is the primary hook. It enforces:
  - **R-WSRC-3 state-file write blocking** (`PROTECTED_WRITE_GLOBS`, `config-protection.ts:49-65`): `**/state.json`, `**/state.json.tmp.*`, `**/circuit_breaker.json*`, `**/pipeline-status.json*`, `~/.claude/pickle-rick/**`, `pickle_settings.json*`. `Write`/`Edit` tools and bash output-redirects (`>`, `>>`, `tee`, `cp`, `mv`, `rsync`) targeting these are blocked unless `state.flags.allow_state_writes_reason` (or `allow_settings_writes_reason` for settings) is set.
  - **Config-file protection** (`PROTECTED_PATTERNS`, `config-protection.ts:17-28`): `.eslintrc`, `eslint.config.*`, `.prettierrc`, `biome.json`, `tsconfig*.json`, `pyproject.toml`, `.ruff.toml`, `jest.config.*`, `vitest.config.*`. Bash commands with glob/brace/bracket patterns matching these basenames are blocked.
  - **R-WSRC-GR git-verb blocker** (`detectProhibitedGitVerb`): `git reset`, `switch`, `stash`, `rebase`, `pull`, `push`, `checkout-with-ref`, `commit --amend`, `fetch --prune` are blocked in worker Bash. `PROHIBITED_GIT_VERBS_SIMPLE` (`config-protection.ts:593`). The detector evaluates every `splitShellSegments` segment, not just the leading token (chained-command detection).
  - **`bash install.sh` blocker** (`isBashInvokingInstallSh`, `config-protection.ts:555-559`): hard-blocks `bash install.sh` (and variants) from worker context. Only matches when `install.sh` is the executable token, not an argument (`cat install.sh`) or suffix (`pre-install.sh`). Every chained segment is checked.
  - **`~/.claude/pickle-rick/**` protection**: writes to the deployed runtime tree are blocked (`config-protection.ts:57-58`).

- **`tsc-gate.ts`** (558 LOC, `extension/src/hooks/handlers/tsc-gate.ts`) enforces R-WACT: no committing broken TypeScript. `isGitCommitCommand` fires only on git-commit-class Bash commands, evaluated across every `splitTopLevelSegments` segment. `allow_tsc_failed_reason` override is consumed on the next clean commit (`tsc_gate_override_consumed`).

- **R-WSRC forbidden ops table** (CLAUDE.md + `AGENTS.md`): the canonical forbidden-ops table is a repo trap-door catalog — it lives in `CLAUDE.md` "## ⛔ Worker Forbidden Ops (R-WSRC)" and `AGENTS.md` "## ⛔ STOP — Worker Forbidden Ops (R-WSRC)", NOT in the FOM document. The table maps each forbidden write to its override flag and runtime check.

## Contract
Forbidden ops prevent a worker from corrupting the runtime it runs inside. Invariants:

1. **State files are sacred** — `state.json`, `circuit_breaker.json`, `pipeline-status.json`, `pickle_settings.json` (and `.tmp.*` variants) are never written by workers.
2. **Deploy tree is sacred** — `~/.claude/pickle-rick/**` is never written by workers.
3. **Destructive git verbs are blocked** — `reset`, `switch`, `stash`, `rebase`, `pull`, `push`, `checkout-with-ref`, `commit --amend`, `fetch --prune` are blocked in worker Bash.
4. **`install.sh` is manager-only** — `bash install.sh` from a worker is always blocked.
5. **Config files are protected** — lint/format/build config files are not modified by workers.
6. **Bypass attempts fail loud** — `>`, `tee`, `node -e fs.writeFileSync`, `cp`, `mv`, `rsync` redirects to protected files are all caught.
7. **Chained commands are segmented** — `cd sub && git reset` cannot bypass the git-verb guard; `splitShellSegments` treats `&&`, `||`, `|`, `&`, `;`, and unquoted newline as boundaries.

Failure modes: (a) hook crash → fail-open (dispatch.js contract); (b) new tool name not in the match set → bypass; (c) shell quoting edge case → parity gap between `parseFirstShellWord` and `findGitVerb` (fixed, but the pattern is recurring).

## Evaluation
Omnigent's policy framework is the right enforcement mechanism — it is general, runner-side, and applies to all harnesses. Pickle Rick's forbidden-ops semantics are the right threat model — R-WSRC is specific to the self-modifying-runtime problem, and the specific forbidden set (state files, deploy tree, `install.sh`, destructive git verbs) is battle-tested across 15+ sub-fixes.

For Rickgent, the self-modifying-runtime threat is different: Rickgent is a declarative agent config, not a runtime that workers modify. There is no `state.json` to corrupt, no `install.sh` to run, no deployed JS mirror. But the blast-radius semantics (no force-push, no `rm -rf /`, no unbounded fan-out) are universal and map directly to Omnigent's `blast_radius` + `spawn_bounds` policies. The git-verb blocker (`reset`, `rebase`, `push`) is still relevant — a worker should not rewrite history. The config-protection semantics (don't modify lint/build config) translate to "don't modify `config.yaml`" — but that is enforced by the scope fence, not a separate forbidden-ops policy.

R-WSRC is a repo trap-door catalog (CLAUDE.md + source comments), NOT in the FOM document. The FOM provides the judgment layer; the trap-door catalog provides the machine-enforceable invariant list.

## §2.3 Finding
No pre-build finding — investigated fresh.

## Decision: mash
Omnigent policy framework + Pickle Rick's forbidden-ops semantics.

## Reasoning
The mash uses Omnigent's `blast_radius` policy (`orchestration.py:345-405`) as the foundation — it already classifies shell commands by reversibility with flag-form robust `_rm_severity` and `_push_severity` helpers, and it covers `sys_os_shell`/`Bash`/`bash` across all harnesses. This replaces Pickle Rick's `detectProhibitedGitVerb` for the destructive-git-verb case with a more general and more robust implementation.

On top of `blast_radius`, Rickgent adds a Rickgent-specific `forbidden_ops` policy function that encodes the R-WSRC semantics that are still relevant in the Omnigent transport model:
- **No writes to `config.yaml`** — the agent config IS the deployment; a worker must not modify its own runtime definition. Enforced via the scope fence (config.yaml is never in a ticket's `allowed_paths`).
- **No `git push` / `git reset --hard` / `git rebase`** — the catastrophic cases (force-push, hard-reset to a remote ref, `rm -rf /`) are covered by `blast_radius`'s DENY set. Rickgent **must NOT set `gate_pushes: false`** to unblock the PR-creation flow. `gate_pushes` is a blunt master switch, not a push-scoped one: at `orchestration.py:400` the flag guards the *entire* ASK branch —

  ```python
  if gate_pushes and ("ASK" in severities or any(p.search(command) for p in _ASK_PATTERNS)):
  ```

  so `gate_pushes: false` short-circuits every ASK-class classification at once, not just `_push_severity`. That silently un-gates, in an unattended run: `gh pr merge`, `gh release`, **`gh repo delete`**, and `kubectl|helm|terraform|databricks apply|deploy|destroy|delete` (`_ASK_PATTERNS`, `orchestration.py:68-70`), plus scoped `rm -rf <path>` (`_rm_severity` ASK). The residual DENY set is nearly empty — `_DENY_PATTERNS` is a single hard-reset-to-remote regex (`orchestration.py:63-65`) plus the force-push / `rm -rf /` severities. An agent that may delete the repository unattended is not "hands-off"; it is unbounded.

  Instead Rickgent keeps `blast_radius(gate_pushes=True)` intact and adds ONE narrow policy, `autonomous_pr_flow`, that ALLOWs only the exact command shapes the PR flow needs — a non-force `git push` of the ticket's own feature branch to `origin`, and `gh pr create` — and defers to `blast_radius` for everything else. Scoping the exception to the command rather than to the whole ASK class keeps merge, release, repo-delete, infra-destroy, and `rm -rf` gated. This is one self-contained evaluator, so it does not depend on cross-policy precedence: it cannot be widened by an ALLOW from a sibling policy.
- **No `bash install.sh`** — N/A in Rickgent (there is no `install.sh`; the agent config is the deployment). This trap door does not carry over.

The R-WSRC trap-door catalog (CLAUDE.md + source comments) is the authoritative list of forbidden ops. It is NOT in the FOM document — the FOM is the judgment layer, the trap-door catalog is the machine-enforceable invariant list. For Rickgent, the trap-door catalog is re-derived for the Omnigent transport model: the state-file and deploy-tree trap doors evaporate (no `state.json`, no deployed JS mirror), while the destructive-git-verb and blast-radius trap doors are inherited via `blast_radius`.

The `spawn_bounds` policy (`orchestration.py:407-464`) bounds fan-out per turn (default 5, Rickgent config sets 6 per §2.2). This replaces Pickle Rick's implicit concurrency limits. The `headless_subagent_purpose_guard` (`orchestration.py:466-517`) requires every dispatch to declare its purpose — this is the Rickgent equivalent of Pickle Rick's worker-role discipline.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** REJECTED
- **Spot-checks performed:** `omnigent/policies/builtins/orchestration.py:345-404` shows ASK-class gating only when `gate_pushes` is true; `extension/src/services/state-manager.ts:71-93` confirms R-WSRC write protection.
- **Notes:** Saying “No git push” while setting `gate_pushes: false` allows plain push and all other ASK-class operations. Use a narrow autonomous policy.
- **Date:** 2026-07-12

## Remediation

- **Status:** FIXED — countersign finding accepted.
- **Change:** Reasoning bullet 2 rewritten. `gate_pushes: false` is now explicitly forbidden for Rickgent, with the reason spelled out: the flag guards the whole ASK branch at `orchestration.py:400`, so disabling it un-gates `gh pr merge` / `gh release` / `gh repo delete` / infra `destroy|delete` / scoped `rm -rf`, not just `git push`. Replaced with a narrow `autonomous_pr_flow` policy that ALLOWs only a non-force feature-branch push and `gh pr create`, leaving `blast_radius(gate_pushes=True)` in force for everything else.
- **Verified against source:** `orchestration.py:400` (ASK branch guarded by `gate_pushes`), `orchestration.py:63-65` (`_DENY_PATTERNS` is a single regex), `orchestration.py:68-70` (`_ASK_PATTERNS` covers `gh pr merge|release|repo delete` and `kubectl|helm|terraform|databricks apply|deploy|destroy|delete`).
- **Decision unchanged:** mash.
- **Date:** 2026-07-12
