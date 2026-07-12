// FOM (Fable Operating Manual) — programmatic access to calibration text.
// The full FOM lives at docs/FABLE_OPERATING_MANUAL.md.

export interface FomDiscipline {
  key: string;
  phrase: string;
  description: string;
}

export const FOM_DISCIPLINES: readonly FomDiscipline[] = [
  {
    key: "hierarchy-of-evidence",
    phrase: "hierarchy of evidence",
    description: "git tree-truth > exit codes > logs > model claims. A worker saying \"done\" is not evidence.",
  },
  {
    key: "silence-is-not-success",
    phrase: "silence is not success",
    description: "A gate that ran zero checks did not pass. A missing result is a failure, not an ALLOW.",
  },
  {
    key: "green-necessary-never-sufficient",
    phrase: "green is necessary, never sufficient",
    description: "Passing tests gate advancement; they do not prove the mission.",
  },
  {
    key: "fail-closed-everywhere",
    phrase: "fail closed, everywhere",
    description: "Missing ticket, unresolvable path, malformed input, subprocess failure, unknown exception → DENY. No bypass flags.",
  },
  {
    key: "subtract-before-add",
    phrase: "subtract before you add",
    description: "Require simplification review in every PRD. Remove complexity before adding features.",
  },
  {
    key: "convergence-vs-attrition",
    phrase: "convergence vs attrition",
    description: "3 iterations no improvement = attrition, not convergence. Detect stalls.",
  },
  {
    key: "fix-at-seam-not-site",
    phrase: "fix at the seam, not the site",
    description: "Single completion oracle, single salvage path, single convergence gate — no parallel implementations.",
  },
  {
    key: "two-escape-hatches-one-guard",
    phrase: "two escape hatches for one guard = the guard is wrong",
    description: "No bypass flags. Policies either allow or deny. If you need an escape hatch, redesign the guard.",
  },
  {
    key: "suspect-immune-system",
    phrase: "suspect the immune system before the infection",
    description: "Salvage/circuit-breaker is minimal and well-tested. The guard is more likely wrong than the worker.",
  },
  {
    key: "completion-oracle-plurality",
    phrase: "one oracle",
    description: "ONE predicate, an enumerated caller allowlist, pinned by test. Never write a second implementation.",
  },
  {
    key: "validation-overreach",
    phrase: "validation overreach",
    description: "Gates are advisory or enforced. No hybrid gates. No forward-ref grammar. The FOM's top recurring bug source.",
  },
] as const;

export function getDiscipline(key: string): FomDiscipline | undefined {
  return FOM_DISCIPLINES.find((d) => d.key === key);
}

export function getPromptCalibrationText(): string {
  return FOM_DISCIPLINES.map((d) => `- ${d.phrase}: ${d.description}`).join("\n");
}
