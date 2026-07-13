# Decision: Quality Gates

## Component
§2 matrix row — quality gates (readiness gate, ticket-audit gate, AC-shape gate, bundle-bootstrap exemption). Cross-references §10.6 (full gate runs before PR) and the FOM's "validation overreach" finding.

## Omnigent implementation
Nothing. Omnigent has no readiness gate, ticket-audit gate, AC-shape gate, or bundle-bootstrap exemption. Omnigent's quality surface is the policy engine (blast_radius, spawn_bounds, enforce_sandbox) and the runner-side tool dispatch — none of these are pre-build validation gates. There is no equivalent to "check that the ticket's declared paths exist before spawning a worker" or "audit that the ticket bundle's ACs are well-shaped."

## Pickle Rick implementation
Pickle Rick has four quality gates, all demoted to advisory in beta.33 after the "validation overreach" cluster (the FOM's phrasing — the top recurring bug source, 15 sub-fixes):

- **Readiness gate** (`extension/src/bin/check-readiness.ts`, 57117 LOC) — heuristic pre-build validation: checks that declared paths/symbols exist, forward-ref annotations are well-formed, etc. Runs once on iteration-0 (`mux-runner.ts:9618-9641`). Per R-GATE-ADVISORY (`mux-runner.ts:9634-9641`): "the readiness gate is ADVISORY, not blocking. Its contract/path/symbol checks are heuristic pre-build validations that historically false-blocked legitimate bundles (R-RTRC reached a 5th recurrence; R-ATBG is the 'guard around a brittle guard' archetype) and forced a large band-aid surface (forward-ref annotation grammar, allowlists, carve-outs, the skip flag). A genuinely-bad path fails the BUILD itself, and the review phases catch the rest — so log + proceed, never halt an autonomous run on a heuristic pre-flight."

- **Ticket-audit gate** (`extension/src/bin/audit-ticket-bundle.ts`, 26521 LOC) — path-drift/cross-doc-naming heuristics. Runs once on iteration-0 after the readiness gate (`mux-runner.ts:9647-9675`). Per R-GATE-ADVISORY (`mux-runner.ts:9668-9675`): "ticket-audit is ADVISORY, not blocking. Its path-drift/cross-doc-naming heuristics false-blocked legitimate bundles at iteration 0 (e.g. a `file.ts:symbol` token mis-read as a missing path → fatal). The findings stay logged for the operator, but a defective bundle surfaces at the build/review phases — not by silently killing the run before any work."

- **AC-shape gate** (`extension/src/bin/spawn-refinement-team.ts`, `runAcShapeEnforcement` / `evaluateAcShapeEnforcement`) — normative on analyst ticket shape (ACs must be parametrized, have justification blocks), advisory on operator PRD prose. Bypass via `--skip-ac-shape-gate <reason>` (emits `ac_shape_gate_bypassed`). The gate checks `ticketShapeText(` (joined title + acceptance_test + justification) for parametrization and justification, NOT a single hard-coded field each (R-ACSG, fixing LOA-727 false-reject).

- **Bundle-bootstrap exemption** (`mux-runner.ts:9587-9613`, R-BUNDLE-1) — session-hash allowlist for `bundle_bootstrap_mode` auto-skip. When `state.flags.bundle_bootstrap_mode` is set, it derives `skip_quality_gates_reason` and auto-skips all quality gates (emits `bundle_bootstrap_exemption_applied`). The unified skip surface is `state.flags.skip_quality_gates_reason` (`mux-runner.ts:4291-4327`): the ONLY bypass flag, consumed by both the readiness gate and the ticket-audit gate via `resolveQualityGateSkipReason` (`mux-runner.ts:4306-4316`).

All four gates are advisory (R-GATE-ADVISORY): findings are logged, never halting. The full gate (tsc, eslint, tests, audit scripts) runs before PR (§10.6 / release-gate), not per-phase.

## Contract
Quality gates are heuristic pre-build validations. Invariants (as learned by Pickle Rick):

1. **Advisory, not blocking** — a gate finding logs a warning but never halts an autonomous run. A genuinely-bad path fails the BUILD itself; the review phases catch the rest.
2. **Unified skip surface** — `skip_quality_gates_reason` is the single bypass flag. No per-gate skip flags.
3. **No guard around a brittle guard** — R-ATBG archetype: a gate that exists to catch false-blocks of another gate is itself a source of false-blocks. Subtract, don't stack.
4. **The full gate runs before PR** — tsc, eslint, tests, audit scripts run at release time (§10.6), not per-phase.
5. **Per-phase checks are advisory or enforced by the build** — if a check is machine-checkable (test/lint/grep), the build enforces it; if it is heuristic (path-drift, symbol-existence), it is advisory.

Failure modes: (a) gate false-blocks a legitimate bundle → autonomous run dies before any work (the recurring bug); (b) gate is blocking and the heuristic is wrong → operator must manually bypass, burning a worker quota; (c) gate accumulates band-aids (forward-ref grammar, allowlists, carve-outs) → the gate becomes more complex than the thing it guards.

## Evaluation
For Rickgent's goals, quality gates are a net negative at v0.1. The FOM identifies "validation overreach" as the top recurring bug source (15 sub-fixes) — gates that false-block legitimate work, forcing band-aid surfaces that become their own bug source. Pickle Rick learned this the hard way and demoted all gates to advisory in beta.33. Rickgent should not re-import a problem that was just subtracted.

Omnigent has nothing here, which is actually the correct starting point. The full gate (tsc, eslint, tests) runs before PR (§10.6) — that is the machine-checkable enforcement surface. Per-phase heuristic gates add no value that the build + review phases do not already provide. The AC-shape gate's normative component (ACs must be parametrized, have justification) is better expressed as a `prism` skill prompt instruction than as a blocking gate — the skill instructs the agent to produce well-shaped ACs, and the `citadel` skill verifies them post-implementation.

## §2.3 Finding
No pre-build finding — investigated fresh. The FOM says "validation overreach" (the FOM's phrasing, not "gate overreach") was the top recurring bug source (15 sub-fixes).

## Decision: skip
Pickle Rick learned these should be advisory, not blocking. The full gate runs before PR (§10.6). Per-phase checks are advisory or enforced by the build. No hybrid gates.

## Reasoning
Skipping quality gates for v0.1 is the subtract-before-add discipline applied to the gate layer itself. The evidence:

1. **The FOM identifies "validation overreach" as the top recurring bug source** (15 sub-fixes). Gates false-blocked legitimate bundles, forcing band-aid surfaces (forward-ref annotation grammar, allowlists, carve-outs, the skip flag) that became their own bug source. Pickle Rick demoted all gates to advisory in beta.33 (R-GATE-ADVISORY, `mux-runner.ts:9634-9641`). Re-importing gates — even as advisory — re-imports the maintenance surface.

2. **The full gate runs before PR (§10.6).** The release gate (`npx tsc --noEmit && npx eslint && npx tsc && bash scripts/audit-*.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`) is the machine-checkable enforcement surface. It runs once, at PR time, not per-phase. This is sufficient.

3. **Per-phase heuristic gates add no value that the build + review phases do not already provide.** A genuinely-bad path fails the BUILD itself (R-GATE-ADVISORY's core argument). The `citadel` skill (post-implementation conformance audit) verifies ACs against the branch diff. The `szechuan` skill (deslopping review) catches quality issues. Stacking a heuristic pre-flight on top of these is the R-ATBG archetype: a guard around a guard.

4. **The AC-shape gate's normative component is better as a prompt instruction.** The `prism` skill instructs the agent to produce parametrized ACs with justification blocks. The `citadel` skill verifies them post-implementation. A blocking gate that checks AC shape before any work begins is the exact false-block pattern that caused LOA-727 (a `title`-only quantifier false-rejected ~30 min + ~9 worker quotas per incident).

5. **No hybrid gates.** A "mash" of Omnigent policy + Pickle Rick gate semantics would create a new gate surface with the same false-block risk. The correct move is to not have per-phase heuristic gates at all — the build is the gate, the review phases are the judgment.

If a specific gate proves necessary in practice (e.g., a pre-spawn check that the ticket's worktree exists), it should be added as a single, narrow, machine-checkable assertion — not a heuristic framework. Revisit in v0.2 if autonomous runs demonstrate a need.
