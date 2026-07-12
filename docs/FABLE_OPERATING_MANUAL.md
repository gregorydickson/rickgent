# The Fable Operating Manual — Rickgent Edition

*Craft-transfer from the operator who ran Pickle Rick to the operator who runs Rickgent.
Not a rulebook. The rulebook is the verdict core (`orchestrator/src/core/`), the conformance
fixtures (`conformance/fixtures/`), and the Python policy shims (`rickgent-policies/`); they
will stop you from doing the forbidden things whether or not you read this. This document is
the other half: the judgment the machine cannot enforce, distilled from every incident that
taught the machine what to enforce.*

*Read it once end-to-end. Then re-read §2 and §4 every time you are about to make a call that
advances a lifecycle. Those two sections are where the reliability was earned.*

---

## 1. What this system actually is

Rickgent looks like a TypeScript orchestrator that dispatches Python-managed workers. That is
the org chart, not the truth. The truth: it is a machine for **converting model claims into
verified facts**, built by people who got burned every single time they skipped the conversion.

Every load-bearing decision in the runtime, Done-flips, salvage, phase advancement, recovery,
routes through predicates that read **git tree-truth and process exit codes**, never a log token.
`evaluateCompletion` is one oracle, pinned by a caller-allowlist audit (AC-5), because when there
were three oracles they disagreed and a fully-green build reported `0/4 phases`. The machine
distrusts you on purpose. Do not take it personally, and more importantly: **adopt its
epistemology as your own.** The runtime distrusts lifecycle claims; you must distrust everything
else, the semantic layer it structurally cannot check.

Rickgent is a two-language product, and the division of labor follows the language boundary:

- **TypeScript owns the product, including the verdict core.** `orchestrator/src/core/` holds
  the pure decision functions: completion oracle, salvage dispositions, scope-fence math,
  convergence gate, circuit breaker. These are pure functions over evidence, never process
  spawns, never git mutations. The lifecycle layer (`orchestrator/src/lifecycle/`) wraps them
  with the orchestration that touches disks and processes.
- **Python exists only where Omnigent imports it.** `rickgent-policies/` is ~150 lines of
  fail-closed pure-Python shims that Omnigent's policy registry loads. Python reaches verdicts
  only by shelling out to `rickgent verdict`, never by re-implementing a verdict. The moment a
  second implementation of any verdict appears, the single-oracle invariant breaks (§3,
  completion-oracle-collapse).

Here is the division of evidence you are inheriting:

**The machine verifies:** a commit exists and is reachable (`git cat-file`, not regex), the tree
changed (trees compared, not SHAs, so empty deferral commits do not count as progress), tsc/lint/
tests exited zero, scoped files were the ones touched, the `omnigent run` one-shot actually
exited, tokens came from the role allowed to emit them.

**You verify:** everything that matters. Whether the green commit actually solves the ticket.
Whether the tier was right. Whether the decomposition was atomic. Whether a finding is real.
Whether "converged" means done or means exhausted. The gates only catch the *shadows* of
failure; the failure itself, the semantic one, casts no shadow the machine can see. That is your
job.

---

## 2. Epistemics: how to know what is true

This is the section. If you internalize one thing, make it this hierarchy of evidence, strongest
first:

1. **The git tree.** What `git diff`, `git log`, `git cat-file` say happened.
2. **The filesystem.** Artifacts on disk, their mtimes, their sizes.
3. **Process reality.** Is the `omnigent run` PID alive? What did it exit with? Use `ps`, not
   `registry.json` mtime; a long orchestrator turn freezes registry mtime and looks exactly like
   a stall.
4. **Exit codes and gate verdicts**, but only from gates you have confirmed actually *ran*. A
   29-second "expensive" suite did not run; it self-skipped. A `Missing script: typecheck` that
   subtracts to zero checks is an inert gate certifying nothing.
5. **Logs.** Useful for narrative, never for verdicts. Read the log's own `EXIT=` sentinel, not
   the background-task exit code (that is the trailing echo).
6. **Model claims**, a worker's `I AM DONE`, an analyst's "0 test refs", a reviewer's summary of
   its own work. These are *hypotheses*. Every time this system trusted a self-report, it paid.

Three corollaries that took real incidents to learn:

**Silence is not success.** The most condemned failures in this lineage are the honest-*looking*
ones: a convergence gate that CONVERGED over a tsc-red tree because its baseline resolved to zero
checks (R-SZGB); a pipeline that logged "completed successfully" while silently aborting its two
most expensive phases in under a second (R-MPGD). When something finishes suspiciously fast or
suspiciously clean, that is not luck; that is a gate that did not fire. Ask: *what would I expect
to see on disk if this had actually run?* Then go look.

**Green is a necessary condition, never a sufficient one.** Worker-green does not equal shippable
is the most-repeated operational fact here. Per-phase gates run scoped fast tiers; the closer's
full gate (tsc + eslint + the full audit suite + fast + integration + expensive) routinely
catches compiled-mirror drift, stale tests outside the worker's allowlist, rename-gap escapes.
Never let a scoped green stand in for the full gate, and never read a gate result and tag a
release in the same breath; read first, confirm green, *then* act.

**Distinguish the signal from the thing it signals.** A signal that pattern-matches a known
failure may have a different cause. "Empty worker output" has been: turn-end reaping of a
backgrounded child, a lost log flush with the work intact, a misrouted tier false-failing in
under a second, and a late render that was fine. Same signature, four causes, four different
correct responses, two of which involve doing *nothing*. Before acting on a signal, ask: what
else produces this exact shape?

---

## 3. The named incidents and what they cost

This lineage earned a taxonomy from named incidents. Rickgent inherits the lessons by code, not
by faith. When something breaks, your first move is a lookup, not a fresh hypothesis.

**R-SZGB — stale baseline convergence.** A convergence gate CONVERGED over a tsc-red tree because
its baseline resolved to zero checks. The gate subtracted the entire (empty) baseline from the
(real) failure set and concluded "no new failures." Lesson, encoded in
`core/convergence.ts:assertBaselineFresh`: a stale or zero-check baseline is a *failing* one, not
a silent pass. An uncertifiable baseline throws `BaselineStaleError`; the caller must refresh
before proceeding. If you ever find yourself tempted to treat an absent baseline as "nothing to
subtract," that temptation is the bug.

**R-MPGD — isInsideWorkTree, not fs.existsSync.** A pipeline that logged "completed successfully"
twice while silently aborting its two most expensive review phases in under a second. Root cause:
a reachability check used `fs.existsSync(.git)` to decide whether git operations were safe. Inside
a submodule or a worktree, `.git` is a *file*, not a directory; `existsSync` lies. Lesson, encoded
in the dispatch and salvage paths: use `git rev-parse --is-inside-work-tree` (an exit-code
predicate), never a filesystem shape probe, to decide whether git is available. Filesystem shape
is not git truth.

**Completion-oracle-collapse.** When there were three implementations of "is this ticket done,"
they disagreed, and a fully-green build reported `0/4 phases`. Two of the three oracles read
frontmatter; one read the tree; one consulted the gate; none agreed on what "accepted" meant. The
fix was not to reconcile them; the fix was to collapse them onto one predicate and pin the
caller-allowlist by test so a second implementation could never re-emerge. Lesson, encoded in
`core/completion.ts` + `test/core/caller-audit.test.ts` (AC-5): ONE predicate, an enumerated
caller allowlist, pinned by test. The plurality is the bug; the fix is to delete the duplicates,
not to arbitrate between them.

**Validation overreach.** The single largest bug *class* in the lineage: guards false-blocking
good runs. Fifteen sub-fixes and roughly 99 commits were spent hardening guards that were
ultimately *deleted* because the right answer was to remove them. The lesson, encoded in the FOM
disciplines (§4) and the policy shims' fail-closed posture: guards get recurrence budgets. A guard
that false-blocks past its budget is a removal candidate, not a hardening candidate. Suspect the
immune system before the infection; most operators, human and model, have this exactly backwards.

**Base rates.** Historically, the majority of incidents came from the recovery, salvage, and
completion machinery itself, and the single largest bug class was validation overreach. So when a
run fails, your priors, in order: (1) a guard is wrong, (2) the recovery machinery is eating real
work, (3) the worker actually failed.

**Two readings of one fact that disagree = the plurality is the bug.** When the watcher accepts a
ticket as Done and the flip-gate fatals the same ticket as absent, do not ask "which one is
right?" Ask "why are there two?" The durable diagnosis is almost never at either site; it is the
existence of sibling implementations of one judgment. Which leads directly to the fix discipline.

---

## 4. Disciplines: the calibration you actually need

These are the ten load-bearing disciplines. The verdict core enforces their shadows; you must
enforce their substance.

**Hierarchy of evidence.** git tree-truth > filesystem > process reality > exit codes > logs >
model claims. A worker saying "done" is not evidence. Your own "done" is not evidence either; the
same oracle judges you.

**Silence is not success.** A gate that ran zero checks did not pass. A missing result is a
failure, not an ALLOW. When a check is absent, the verdict is red, not green. When a subprocess
produced no output, that is a dead child, not a polite one.

**Green is necessary, never sufficient.** Passing tests gate advancement; they do not prove the
mission. A scoped green is a license to ask the next question, not a license to ship.

**Fail closed, everywhere.** Missing ticket, unresolvable path, malformed input, subprocess
failure, unknown exception: DENY. No bypass flags. The Python shims are fail-closed by
construction; the TS core is fail-closed by test (AC-16 malformed-input matrix). If you find
yourself adding an escape hatch to a guard, stop; the guard is wrong.

**Subtract before you add.** The north star. The system ran autonomously and reliably before
features made it brittle; autonomy is goal #1, output quality goal #2. Nearly every headline
reliability win was a deletion: the entire detached worker lifecycle, the forward-ref grammar,
the second completion oracle. Run the four questions before writing anything: Is this addition
necessary? Can it reuse an existing seam? Is it a guard around brittle complexity that should be
dissolved instead? What can be subtracted? Simplification review is a required PRD field (AC-14),
not a courtesy.

**Convergence vs attrition.** A loop that stops improving has *stalled*; a loop whose checks pass
has *converged*. The system had to grow an explicit latch ("never force-converge by attrition")
because the drift toward calling exhaustion "done" is that strong. When a convergence loop ends,
ask which one happened. They terminate identically and mean opposite things.

**Fix at the seam, not the site.** When the root cause is parallel implementations of one
judgment, the fix is to collapse them onto one shared predicate and pin the collapse. Patching
each instance is how you get the twin bug six weeks later. In Rickgent, the seams are named:
`evaluateCompletion`, `salvageTicket`, `runGate`, `checkScope`. If you fix a judgment in one
place, grep for every other place that judgment is made; if you can, pin the count with an audit
so divergence red-gates forever.

**Two escape hatches for one guard = the guard is wrong.** Loosen it or delete it. Never add a
second hatch. Rickgent has no bypass flags by design (the KICKOFF_PROMPT is explicit: "No bypass
flags"). Guards get recurrence budgets; a guard that false-blocks past its budget is a removal
candidate, not a hardening candidate.

**One oracle.** ONE completion predicate in `src/core/`, enumerated caller allowlist, pinned by
test (AC-5). Python reaches verdicts only through `rickgent verdict`. Never write a second
implementation of any verdict. The conformance fixtures are the portable spec; every verdict
surface (core API, CLI, Python subprocess) runs the same fixtures and must agree.

**Validation overreach.** Gates are advisory or enforced; no hybrid gates, no forward-ref
grammar, no guards-on-guards. The top recurring bug source in the lineage was guards
false-blocking good runs. When a guard fires suspiciously often, the guard is the suspect, not
the runs.

---

## 5. Intervention: how to act

**Preserve work before anything else.** The closest thing to a sacred rule. Before any reset,
respawn, or cleanup: `git status`, look at what is there, commit-if-green with scoped paths, or
archive it. The salvage machinery embodies this: dirty + gate-failing means *archive the diff,
then* reset, never reset over uncommitted work. Match it in your manual interventions. Recovery
of dropped commits is path-scoped `git restore --source <sha>` or `git merge --ff-only <sha>`,
named files, never directories.

**Minimum intervention, maximum verification.** Fix the one thing the evidence supports, then
verify the fix from ground truth, then stop. The temptation under time pressure is the omnibus
intervention, kill everything, reset state, relaunch fresh. That trades a diagnosable situation
for an undiagnosable one and usually orphans real work. Every recovery recipe has the same shape:
freeze, inspect, salvage, *targeted* fix, resume. And scope your kills: session IDs and PIDs,
never bare binary names.

**Know each decision's correct failure posture.** Lifecycle advancement fails closed; forensic
side-checks fail open. A Done-flip with unverifiable evidence refuses. A convergence gate whose
baseline will not resolve reds, not empties (an uncertifiable baseline is a *failing* one). But
an evidence-check that errors while deciding whether to *suppress* a Failed-flip proceeds; a
progress check in a non-git dir assumes progress. The question: *if this check is wrong, which
direction lies?* A false "done" is dishonest and compounds; a false "still working" costs an
iteration. Choose the posture that makes lies expensive and delays cheap.

**The two-language seam is a discipline, not a convenience.** TypeScript owns verdicts; Python
owns enforcement. The seam between them is `rickgent verdict <check> --json`. Every verdict the
Python shims need crosses that seam; none is re-implemented in Python. If a Python shim needs a
verdict the CLI does not expose, the fix is to add the CLI check, not to write a parallel
predicate. The conformance suite tests all three surfaces against the same fixtures; a divergence
is a red gate, not a tuning exercise.

**Never hand-complete a ticket and then resume the same pipeline.** It churns the completion
oracle, phantom reverts, false-epic loops, duplicate commits. Either let the pipeline own
completion, or take the session over fully. Half-ownership is the worst state.

---

## 6. Terminology map: Pickle Rick to Rickgent

The lifecycle semantics are ported, not reinvented. The names changed because the substrate
changed.

| Pickle Rick | Rickgent | Why |
|---|---|---|
| `state.json` | `.rickgent/registry.json` | Pipeline state is a derived index, rebuildable from git truth via `reconcile`. Decoupled from the runtime coupling of `state-manager.ts`. |
| tmux panes (kill + respawn) | Omnigent sessions | Context clearing is an architectural property of the session model, not a side effect of killing a process. No `mux-runner.ts`. |
| `spawn-morty.js` (`claude -p`) | `omnigent run` one-shots | Multi-model by default; any harness, no `--backend` flag. |
| `mux-runner.ts` outer loop | `lifecycle/phase.ts` + `lifecycle/microverse.ts` | The 11k-LOC process-management loop is gone; Omnigent's session model replaces it. |
| `evaluateCompletionEvidence` (7 call sites) | `evaluateCompletion` (enumerated caller allowlist, AC-5) | One predicate, pinned by test. Same invariant, Rickgent-shaped. |
| `convergence-gate.ts` | `core/convergence.ts` (math) + `lifecycle/convergence.ts` (runner) | Pure math in the core, check execution in the lifecycle layer. R-SZGB and R-ORSR-6 preserved verbatim. |
| `state-manager.ts` atomic locks | `lifecycle/registry.ts` | Atomic file writes, schema versioning, orphan recovery semantics inherited without the Pickle Rick runtime coupling. |
| `config-protection.ts` hooks | `rickgent-policies/` Python shims | Forbidden ops enforced at Omnigent's policy seam, fail-closed, no bypass flags. |
| `circuit-breaker.js` | `core/breaker.ts` | Same thresholds, same error-signature stability requirement. Error prose is API. |
| `salvage-ticket.ts` | `core/salvage.ts` + `lifecycle/salvage.ts` | Same dispositions (ff-reattach, archive, no-op, error). Pure decision in core, execution in lifecycle. |
| `scope-fence` (`check/scope-diff.ts`) | `core/scope.ts` | In-process in the TS core, in-process in the Python shim via `rickgent verdict scope`. One definition. |
| `~/.claude/pickle-rick/**` deploy tree | (none, Rickgent has no self-modifying deploy) | Rickgent is not a self-modifying runtime; the R-WSRC threat model is narrower. Forbidden ops still enforced but the deploy-tree protection is moot. |

---

## 7. The judgment ledger

The places the machine explicitly trusts the model, and how to hold each one:

1. **`I AM DONE`** — the gates verify a green scoped commit exists, not that it satisfies the
   ticket. Before accepting, re-read the acceptance criteria against the diff, not against memory.
2. **Tier assignment** — a bet on budgets. Bias orchestrator-touching work to medium+; suspect
   the bet on any timeout.
3. **AC semantic satisfaction** — checkboxes are structural; the strongest AC gates are advisory.
   The spec is the review only if the reviewer actually runs the verify commands.
4. **Remediation quality** — the recovery ladder verifies a gate-green commit landed, not that
   the fix-forward fixed the right thing. Read the remediation diff like a hostile reviewer.
5. **Handoff substance** — the heuristic is textual; verbose-but-empty passes. Write handoffs
   that a context-free successor can act on.
6. **Course-correction triggers** — you authored both the error and the proposed correction; get
   one independent read before a mid-flight plan change.
7. **Error-signature stability** — the breaker counts *same* errors by text shape; keep error
   prose stable or the breaker goes blind to a repeating failure. Error prose is API.
8. **Decomposition atomicity** — "self-contained" means a worker executes without reading the
   PRD; if you cannot state a ticket's verify commands, it is not atomic yet.
9. **Failed-flip suppression** — the evidence predicate infers work happened, not that it is the
   *right* work. Suppression buys you a look, not a verdict; take the look.
10. **Convergence scoring** — convergence rides on the score. Score against the rubric, carry the
    prior-violation ledger so you do not re-discover.

---

## 8. Shipping: the closer's craft

The pipeline stops before the closer on purpose. The full gate is the release truth; CI-green is
hygiene, never a gate. Run it from `orchestrator/`, fix forward on inherited red. Read the gate
result. Confirm green. *Then* bump, commit, tag, as separate acts. The one time you batch the tag
with the gate-read is the time the gate was red.

The AC-14 fixture pipeline must run clean end-to-end twice consecutively before a tag. Once is a
demo; twice is evidence. The definition of done (MISSION_PRD §16.5) is not "green tests"; it is
*N hands-off runs in a row where every claim was true.*

---

## 9. The last word

The whole apparatus, oracles, salvage, ladders, gates, the two-language seam, this manual, exists
to make one sentence true: **when Rickgent says it did something, it did it.** Every hard-won fix
in the lineage points the same direction: away from machinery that *looks* reliable and toward
fewer, verified, honest moves. You do not need maximum reasoning depth to uphold that. You need
the discipline to check the tree before you believe the log, to delete before you guard, to say
"failed" when it failed, and to write down what you learned before your context dies.

The bar is not green tests. The bar is N hands-off runs in a row where every claim was true.

Verify everything.
