// Phase — the 8-phase state machine.
// AC-2: deterministic phase transitions with review gates.

export const PHASES = [
  "research",
  "research_review",
  "plan",
  "plan_review",
  "implement",
  "spec_conformance",
  "code_review",
  "simplify",
] as const;

export type Phase = (typeof PHASES)[number];

export interface PhaseResult {
  phase: Phase;
  success: boolean;
  output: string;
  commitSha: string | null;
}

export interface AdvanceDecision {
  advance: boolean;
  nextPhase: Phase | null;
  reason: string;
}

export function shouldAdvance(phase: Phase, result: PhaseResult): AdvanceDecision {
  if (!result.success) {
    return { advance: false, nextPhase: null, reason: `phase ${phase} did not succeed` };
  }
  const idx = PHASES.indexOf(phase);
  if (idx < 0 || idx >= PHASES.length - 1) {
    return { advance: false, nextPhase: null, reason: "last phase reached" };
  }
  const next = PHASES[idx + 1];
  if (next === undefined) {
    return { advance: false, nextPhase: null, reason: "last phase reached" };
  }
  return { advance: true, nextPhase: next, reason: `phase ${phase} succeeded, advancing to ${next}` };
}

export function nextPhase(phase: Phase): Phase | null {
  const idx = PHASES.indexOf(phase);
  if (idx < 0 || idx >= PHASES.length - 1) return null;
  const next = PHASES[idx + 1];
  return next ?? null;
}

export function isTerminal(phase: Phase): boolean {
  return PHASES.indexOf(phase) === PHASES.length - 1;
}
